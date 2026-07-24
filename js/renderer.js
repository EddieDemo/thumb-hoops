// File: js/renderer.js
'use strict';

function Renderer(game) {
    this.game = game;
    this.c = game.c;
    // PERF: offscreen caches for the score numeral and BEST label.
    // Rasterising a 2-cell glyph with fillText every frame was the
    // renderer's single heaviest call; now text is drawn once per
    // (text, colour, size) change and idle frames pay one drawImage.
    // During colour transits the colour changes per frame, so the cache
    // rebuilds per frame - no worse than the old direct fillText - while
    // the majority idle frames become nearly free.
    this.textCaches = { score: { key: '' }, best: { key: '' }, scheme: { key: '' }, mode: { key: '' }, version: { key: '' } };

    // FONT FLASH FIX (v3). History, for honesty: v1 listened to
    // fonts.ready, which raced (faces load lazily; ready resolved before
    // our first fillText ever triggered the load). v2 triggered the load
    // but gated rebuilds on fonts.check(), which proved unreliable for
    // externally-loaded faces in the field. v3 stops asking questions and
    // hooks the one promise DEFINED to resolve at the right moment:
    // fonts.load() both triggers the load and resolves when those faces
    // are usable - invalidate the caches then. fonts.ready is chained as
    // a second, now-raceless belt (our load() calls precede it, so the
    // loading set is non-empty when it samples).
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
        const invalidate = () => {
            this.textCaches.score.key = '';
            this.textCaches.best.key = '';
            dbg('Renderer: webfont available - text caches invalidated.');
        };
        Promise.all([
            document.fonts.load("700 16px 'IBM Plex Mono'"),
            document.fonts.load("600 16px 'IBM Plex Mono'")
        ]).then(invalidate).catch(() => { /* offline: fallback face stands */ });
        if (document.fonts.ready) document.fonts.ready.then(invalidate);
    }
    dbg("Renderer created.");
}

/**
 * Returns a cached offscreen canvas containing the given text, rebuilt
 * only when text/colour/size change. Rendered at devicePixelRatio for
 * crispness; drawn back at logical size.
 * @returns {{canvas: HTMLCanvasElement, w: number, h: number}}
 */
Renderer.prototype.getCachedText = function(cacheName, text, weight, px, color) {
    const cache = this.textCaches[cacheName];
    const key = text + '|' + color + '|' + px + '|' + weight;
    if (cache.key === key && cache.canvas) return cache;

    const dpr = window.devicePixelRatio || 1;
    if (!cache.canvas) cache.canvas = document.createElement('canvas');
    const canvas = cache.canvas;
    const ctx = canvas.getContext('2d');

    const font = weight + " " + px + "px 'IBM Plex Mono'";
    ctx.font = font; // Set before measuring
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + 8; // Small pad against clipping
    const h = Math.ceil(px * 1.3);

    canvas.width = Math.max(1, Math.ceil(w * dpr));
    canvas.height = Math.max(1, Math.ceil(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font; // Canvas resize resets state
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    cache.key = key;
    cache.w = w;
    cache.h = h;
    return cache;
};

Renderer.prototype.drawFrame = function() {
    const game = this.game;
    // Paint the court's background OPAQUELY (in logical pixels - the
    // context transform maps to the device-pixel backbuffer). The board no
    // longer relies on the page body showing through: the body now carries
    // the continuing checkerboard surround, and an opaque court makes any
    // sub-pixel misalignment between the two worlds invisible by
    // construction.
    this.c.fillStyle = game.themeColors.BACKGROUND;
    this.c.fillRect(0, 0, game.COLUMNS * game.cellRes, game.ROWS * game.cellRes);
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
    this.drawSchemeToggle(game); // Testing affordance (config-gated)
    this.drawThemeToggle(game);  // Light/dark glyph, top-right (product feature)
    this.drawVersionTag(game);   // Deploy verification, bottom-left cell

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

    // --- Aim indicator (post-wean) ---
    // Once the teaching path has weaned away, the drag was mute: nothing
    // on screen answered the thumb. This is the answer - a short trail of
    // dots from the ball's edge along the launch direction, span scaling
    // with power. NON-predictive by design: direction and power are facts
    // the player authored; showing them back is acknowledgment, not
    // assistance. Hidden while release would abort (the indicator is the
    // third subscriber to wouldReleaseAbort, after input and the shoot
    // line). Shown during teaching shots too: the path predicts the
    // flight, the indicator answers the grip - different jobs, both on.
    if (game.inputScheme === 'drag' &&
        game.currentState === GameStates.AIMING && game.currentBall &&
        !game.wouldReleaseAbort()) {
        this.drawAimIndicator(game);
    }

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
        // PERF: up to 100 dots used to mean 100 beginPath/stroke calls.
        // Dots are bucketed by QUANTISED fade (24 levels - a step of
        // ~0.0125 alpha, below perception) and each bucket strokes as ONE
        // path with sub-path arcs: worst case 24 draw calls, typical far
        // fewer. Identical look, order-of-magnitude fewer calls.
        const LEVELS = 24;
        const buckets = new Array(LEVELS);
        for (let i = skipCount; i < points.length; i++) {
            const fade = fadeAt(i);
            if (fade <= 0) break;
            const level = Math.min(LEVELS - 1, Math.round(fade * (LEVELS - 1)));
            (buckets[level] = buckets[level] || []).push(points[i]);
        }
        for (let level = 0; level < LEVELS; level++) {
            const pts = buckets[level];
            if (!pts) continue;
            c.globalAlpha = (level / (LEVELS - 1)) * baseAlpha;
            c.beginPath();
            for (const p of pts) {
                c.moveTo(p.x + dotRadius, p.y);
                c.arc(p.x, p.y, dotRadius, 0, Math.PI * 2, false);
            }
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


/**
 * Testing affordance: the active input scheme's name, top-left, in the
 * BEST register (same face, size, colour role - the environment layer's
 * typography). Tapping it toggles scheme + restarts (see InputHandler).
 * Config-gated; off for any public build.
 */
Renderer.prototype.drawSchemeToggle = function(game) {
    if (!CONFIG.INPUT.SHOW_SCHEME_TOGGLE) return;
    // Glyph shows the CURRENT scheme, mirroring the theme toggle's
    // semantics: a targeting reticle for drag (spatial aiming), a wave
    // arrow for flick (the throwing gesture). System-fallback glyphs,
    // same as the moon/star.
    const glyph = game.inputScheme === 'flick' ? '\u219D' : '\u2316';
    const cached = this.getCachedText('scheme', glyph, '600',
        game.cellRes * 0.5, game.themeColors.BEST);
    // Centred in the TOP-LEFT-MOST grid cell - the lattice-citizen mirror
    // of the theme glyph top-right.
    const centerX = 0.5 * game.cellRes;
    const centerY = 0.5 * game.cellRes;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * The build version, centred in the BOTTOM-LEFT cell: score's face and
 * colour role at the corner glyphs' size - so a stale cached build is
 * recognisable at a glance when testing on device.
 */
Renderer.prototype.drawVersionTag = function(game) {
    const cached = this.getCachedText('version', CONFIG.VERSION, '700',
        game.cellRes * 0.25, game.themeColors.SCORE);
    const centerX = 0.5 * game.cellRes;
    const centerY = (game.ROWS - 0.5) * game.cellRes;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * The light/dark mode toggle: a single glyph in the BEST register,
 * top-right - the environment layer's typography as UI, mirroring the
 * scheme label top-left. Emulates the portfolio site's toggle: the glyph
 * shows the CURRENT mode (moon while dark, star while light), tap flips
 * it (see InputHandler), choice persists. Colour is theme-SOLVED like
 * every element, so the little moon blooms and drains with the world.
 * Glyph note: these characters likely aren't in IBM Plex Mono; canvas
 * falls back to a system face for them - identical behaviour to the site.
 */
Renderer.prototype.drawThemeToggle = function(game) {
    const glyph = (typeof isDarkMode === 'function' && isDarkMode()) ? '\u23FE' : '\u2739';
    const cached = this.getCachedText('mode', glyph, '600',
        game.cellRes * 0.5, game.themeColors.BEST);
    // Centred in the TOP-RIGHT-MOST grid cell - the glyph belongs to the
    // lattice, not to a floating margin.
    const centerX = (game.COLUMNS - 0.5) * game.cellRes;
    const centerY = 0.5 * game.cellRes;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * The post-wean aim readback: CONFIG.RENDER.AIM.DOTS dots from the ball's
 * edge along the launch direction, span = power fraction of a cell.
 */
Renderer.prototype.drawAimIndicator = function(game) {
    const ball = game.currentBall;
    const v = ball.hypotheticalVelocity;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y);
    if (speed < 0.001) return; // No drag yet - nothing to say

    // Power as a fraction of the maximum launch speed (derived from the
    // same constants the aim itself uses - always in agreement).
    const maxDrag = (game.ROWS * game.cellRes) * CONFIG.PHYSICS.MAX_DRAG_HEIGHT_MULTIPLIER;
    const maxSpeed = maxDrag * CONFIG.PHYSICS.AIMING_SENSITIVITY_SCALE;
    const power = Math.min(1, speed / maxSpeed);

    const A = CONFIG.RENDER.AIM;
    const ux = v.x / speed, uy = v.y / speed;
    const startDist = ball.radius + A.EDGE_GAP_CELLS * game.cellRes;
    const span = power * A.MAX_LENGTH_CELLS * game.cellRes;

    // The dissolve: same visual system as the flight trail, projected
    // forward. Radius tapers and opacity fades toward the tip - direction
    // and power in one gesture, no annotation.
    const c = this.c;
    c.save();
    c.fillStyle = game.themeColors.PREDICTION_LINE; // The theme's ink
    for (let i = 1; i <= A.DOTS; i++) {
        const t = i / A.DOTS; // 0 at the ball -> 1 at the tip
        const d = startDist + span * t;
        const r = Math.max(0.5, A.BASE_RADIUS_CELLS * game.cellRes * (1 - A.TAPER * t));
        c.globalAlpha = A.ALPHA * (1 - t);
        c.beginPath();
        c.arc(ball.pixelX + ux * d, ball.pixelY + uy * d, r, 0, Math.PI * 2, false);
        c.fill();
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
    // The numeral is the LEVEL being attempted, starting at 1 - you stand
    // on level 1, and sinking it moves you to 2. (Internally everything
    // stays streak-based - baskets completed - this is display-layer
    // framing only.)
    const cached = this.getCachedText('score', String(game.score + 1), '700',
        game.cellRes * 2, game.themeColors.SCORE);
    const centerX = (game.COLUMNS * game.cellRes) / 2;
    const centerY = (game.ROWS * game.cellRes) / 2;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * Draws the all-time best streak, small and top-centre, in the same
 * recessive SCORE colour as the big background number. Hidden until a best
 * exists - a first-time player sees nothing to explain.
 */
Renderer.prototype.drawBestStreak = function(game) {
    if (game.bestStreak <= 0) return;
    // THE DAILY RECORD replaces the all-time BEST on the glass (all-time
    // persists in storage for the future clubhouse overlay). Reads as
    // current : summit - cost, e.g. "1:14-9". Hidden until today's first
    // basket (records are earned before shown), and hidden entirely on
    // custom courts (exhibition has no ledger). Same register, same
    // bloom-and-drain, same cache.
    if (game.isCustomCourt || !game.daily || game.daily.best === 0) return;
    // Summit - cost, e.g. "14-9": the highest level COMPLETED today and
    // the misses spent when that summit was first set. Completed-basis
    // keeps the record honest against the attempting-basis numeral: after
    // one basket the centre reads 2, the record reads 1-0.
    const label = game.daily.best + CONFIG.RENDER.RECORD_SEP2 + game.daily.missesAtBest;
    const cached = this.getCachedText('best', label, '600',
        game.cellRes * 0.5, game.themeColors.BEST);
    const centerX = (game.COLUMNS * game.cellRes) / 2;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, game.cellRes * 0.9 - cached.h / 2, cached.w, cached.h);
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
    // While the finger is still below the line mid-aim, releasing would
    // ABORT - the line firms up to say "you're still in your own
    // territory", settling the moment the drag crosses into commitment.
    // Zero text; the line's second job.
    const armed = game.wouldReleaseAbort();
    c.strokeStyle = game.themeColors.BOUNDARY;
    c.lineWidth = armed ? CONFIG.RENDER.SHOOT_LINE_HELD_WIDTH
                        : CONFIG.RENDER.SHOOT_LINE_WIDTH;
    const boundaryY = (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes;
    c.moveTo(0, boundaryY); c.lineTo(game.COLUMNS * game.cellRes, boundaryY); c.stroke();
};