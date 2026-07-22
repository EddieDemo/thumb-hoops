// File: js/renderer.js
'use strict';

function Renderer(game) {
    this.game = game;
    this.c = game.c;
    dbg("Renderer created.");
}

Renderer.prototype.drawFrame = function() {
    const game = this.game;
    // Clear in LOGICAL pixels - the context transform (set in
    // redefineVariables) maps these to the full device-pixel backbuffer.
    this.c.clearRect(0, 0, game.COLUMNS * game.cellRes, game.ROWS * game.cellRes);
    // NOTE: theme application no longer happens here - applyTheme() runs once
    // at startup and once per toggle. The frame loop never touches the DOM.

    // ------------------------------------------------------------------
    // LAYER ORDER (back to front) - deliberate, do not reorder casually:
    //   1. Background        (the clear; body/canvas colour)
    //   2. Cell grid         (optional checkerboard)
    //   3. Score + BEST      (the ENVIRONMENT layer: the numeral is the
    //                         world's backdrop and must never occlude actors)
    //   4. Boundary + shoot line
    //   5. Pegs + hoop line
    //   6. Detached effects  (score-ring echoes)
    //   7. Prediction path
    //   8. Ball              (always on top)
    // ------------------------------------------------------------------

    // Layer 2: cell grid
    if (CONFIG.RENDER.DRAW_GRID) {
        this.drawGrid(game);
    }

    // Layer 3: the environment layer - score and BEST sit BEHIND the world
    this.drawScore(game);
    this.drawBestStreak(game);

    // Layer 4: frame and shoot line
    this.drawCanvasBoundary(game);
    this.drawShootBoundaryLine(game);

    // Layer 5 + 6: the world and its echoes
    this.drawGameObjects(game.nodes);
    this.drawGameObjects(game.lines); // Hoops
    this.drawGameObjects(game.effects); // Detached one-shot effects (echoes)

    // --- Trajectory Path Drawing ---
    // Path VISIBILITY and LENGTH are the Game's decision (teaching wean /
    // debug override) - the renderer only asks and draws. Both paths still
    // come from the same simulation (stepBallState), so whatever is shown
    // is exact.
    {
        let launchState = null;
        let pathSteps = 0;

        if (game.currentState === GameStates.AIMING && game.currentBall) {
            pathSteps = game.getPredictionSteps();
            if (pathSteps > 0) {
                launchState = {
                    pixelX: game.currentBall.pixelX,
                    pixelY: game.currentBall.pixelY,
                    velocity: game.currentBall.hypotheticalVelocity,
                    radius: game.currentBall.radius
                };
            }
        } else if ((game.currentState === GameStates.SHOT_TAKEN || game.currentState === GameStates.RESETTING) && game.lastShotPathData) {
            // Persisted path replays at the length the player aimed with -
            // never longer (that would reveal bounces teaching had hidden).
            pathSteps = CONFIG.RENDER.PREDICTION_PATH_ALWAYS
                ? CONFIG.GAME.PREDICTION_FRAMES
                : game.lastShotPathData.predictionSteps;
            if (pathSteps > 0) {
                const d = game.lastShotPathData;
                launchState = {
                    pixelX: d.startX,
                    pixelY: d.startY,
                    velocity: { x: d.velocityX, y: d.velocityY },
                    radius: d.radius
                };
            }
        }

        if (launchState && pathSteps > 0) {
            const points = game.physicsEngine.simulateTrajectory(launchState, pathSteps);
            // While the shot is in flight, dots the ball has already reached
            // are consumed (skipped); while aiming, nothing is consumed yet.
            const consumed = (game.currentState === GameStates.AIMING) ? 0 : game.shotStepsElapsed;
            this.drawTrajectory(launchState, points, pathSteps, consumed);
        }
    }
    // --- End Trajectory Path Drawing ---

    // Draw ball last so it's on top
    this.drawGameObjects(game.balls);

};


/**
 * Draws a pre-simulated trajectory with two refinements:
 *  - FADE: opacity falls linearly to 0 across the REQUESTED step count, so
 *    teaching-truncated paths dissolve rather than stopping dead, while
 *    floor-terminated paths keep opacity at the landing (they end before
 *    the fade does).
 *  - CONSUMPTION: the first `skipCount` points are not drawn - during
 *    flight the ball consumes its predicted future dot by dot, since
 *    point[i] IS the ball's position after step i+1.
 * Pure presentation: all simulation happens in PhysicsEngine.
 * @param {{pixelX:number, pixelY:number, radius:number}} launchState - Where the path begins.
 * @param {Array<{x:number, y:number}>} points - One point per simulated step.
 * @param {number} requestedSteps - Steps ASKED for (fade denominator), >= points.length.
 * @param {number} skipCount - Leading points already consumed by the ball's flight.
 */
Renderer.prototype.drawTrajectory = function(launchState, points, requestedSteps, skipCount) {
    if (!points || points.length === 0) return;
    if (skipCount >= points.length) return; // Entire path consumed
    const c = this.c;

    const pathStyle = CONFIG.RENDER.PREDICTION_PATH_STYLE;
    const lineWidth = CONFIG.RENDER.PREDICTION_PATH_LINE_WIDTH;
    const dotRadius = Math.max(1, launchState.radius * CONFIG.RENDER.PREDICTION_PATH_DOT_RADIUS_SCALE);
    // Path colour is the theme's ink, at a base opacity the fade multiplies.
    const pathColor = this.game.themeColors.PREDICTION_LINE;
    const baseAlpha = CONFIG.RENDER.PREDICTION_ALPHA;

    // Linear fade across the requested length. globalAlpha multiplies the
    // colour's own alpha, so PREDICTION_LINE's base opacity is preserved as
    // the starting point of the fade.
    const fadeAt = (i) => Math.max(0, 1 - (i + 1) / requestedSteps);

    c.save();
    c.strokeStyle = pathColor;
    c.lineWidth = lineWidth;

    if (pathStyle === 'dots') {
        for (let i = skipCount; i < points.length; i++) {
            const fade = fadeAt(i);
            if (fade <= 0) break;
            c.globalAlpha = fade * baseAlpha;
            c.beginPath();
            c.arc(points[i].x, points[i].y, dotRadius, 0, Math.PI * 2, false);
            c.stroke();
        }
    } else { // 'line' - per-segment strokes so opacity can vary along the path
        for (let i = skipCount; i < points.length; i++) {
            const fade = fadeAt(i);
            if (fade <= 0) break;
            const from = (i === 0)
                ? { x: launchState.pixelX, y: launchState.pixelY }
                : points[i - 1];
            c.globalAlpha = fade * baseAlpha;
            c.beginPath();
            c.moveTo(from.x, from.y);
            c.lineTo(points[i].x, points[i].y);
            c.stroke();
        }
    }

    c.restore();
};


// --- Other Renderer Methods ---

// drawGrid is only called if CONFIG.RENDER.DRAW_GRID is true.
// Draws ONLY the darker checkerboard alternates: the lighter half is
// CELL_FILL_1 = the background itself, already visible beneath, so painting
// it would be 45 redundant fills per frame. One fillStyle, plain fillRects -
// the whole grid costs almost nothing. (Cell.draw is retired from the frame
// loop; the Cell objects remain as createHoop's placement lattice.)
Renderer.prototype.drawGrid = function(game) {
    const c = this.c;
    const res = game.cellRes;
    c.fillStyle = game.themeColors.CELL_FILL_2;
    for (let y = 0; y < game.ROWS; y++) {
        // Odd (x+y) cells are the CELL_FILL_2 alternates
        for (let x = (y % 2 === 0) ? 1 : 0; x < game.COLUMNS; x += 2) {
            c.fillRect(x * res, y * res, res, res);
        }
    }
};

Renderer.prototype.drawGameObjects = function(objects) {
     const game = this.game;
     objects.forEach(obj => {
        if (typeof obj.draw === 'function') {
            obj.draw(game);
        }
    });
};

// NOTE: drawUI removed - the score/BEST/boundary calls now live inline in
// drawFrame's documented layer order (the score is layer 3, the ENVIRONMENT,
// and must render beneath the world - a wrapper drawn last defeated that).

Renderer.prototype.drawScore = function(game) {
    const c = this.c; c.save();
    c.font = "700 " + (game.cellRes * 2) + "px 'IBM Plex Mono'";
    c.fillStyle = game.themeColors.SCORE; // Use theme color
    c.textAlign = "center"; c.textBaseline = "middle";
    const centerX = (game.COLUMNS * game.cellRes) / 2;
    const centerY = (game.ROWS * game.cellRes) / 2;
    c.fillText(game.score, centerX, centerY); c.restore();
};

/**
 * Draws the all-time best streak, small and top-centre, in the same
 * recessive SCORE colour as the big background number. Hidden until a best
 * exists - a first-time player sees nothing to explain.
 */
Renderer.prototype.drawBestStreak = function(game) {
    if (game.bestStreak <= 0) return;
    const c = this.c; c.save();
    c.font = "600 " + (game.cellRes * 0.5) + "px 'IBM Plex Mono'";
    // BEST derives from the live theme like every other element - it
    // blooms and drains with the world.
    c.fillStyle = game.themeColors.BEST;
    c.textAlign = "center"; c.textBaseline = "middle";
    const centerX = (game.COLUMNS * game.cellRes) / 2;
    c.fillText("BEST " + game.bestStreak, centerX, game.cellRes * 0.9);
    c.restore();
};

Renderer.prototype.drawCanvasBoundary = function(game) {
    const c = this.c; c.beginPath(); c.setLineDash([]);
    c.lineWidth = CONFIG.RENDER.BOUNDARY_LINE_WIDTH; // Use config
    c.rect(0, 0, game.COLUMNS * game.cellRes, game.ROWS * game.cellRes);
    c.strokeStyle = game.themeColors.BOUNDARY; // Use theme color
    c.stroke();
};

Renderer.prototype.drawShootBoundaryLine = function(game) {
    const c = this.c; c.beginPath(); c.setLineDash([]);
    c.strokeStyle = game.themeColors.BOUNDARY; // Use theme color
    c.lineWidth = CONFIG.RENDER.SHOOT_LINE_WIDTH; // Use config
    const boundaryY = (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes; // Use config
    c.moveTo(0, boundaryY); c.lineTo(game.COLUMNS * game.cellRes, boundaryY); c.stroke();
};