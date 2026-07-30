// File: ball.js
'use strict';

class Ball {
    /**
     * '#5a5a5a' -> 'rgba(90,90,90,a)'. Cached on the hex, because the ink
     * only changes when the palette does but this is asked every frame.
     */
    static _rgba(hex, a) {
        if (Ball._rgbaHex !== hex) {
            Ball._rgbaHex = hex;
            Ball._rgbaParts = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        }
        const p = Ball._rgbaParts;
        return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')';
    }

    constructor(gridX, gridY, game) {
        this.game = game;
        this.isStatic = true; // Ball starts static until aimed/shot
        this.gridX = gridX;
        this.gridY = gridY;
        this.radius = this.game.radius; // Calculated in game
        this.pixelX = this.gridX * this.game.cellRes;
        this.pixelY = this.gridY * this.game.cellRes;

        this.velocity = { x: 0, y: 0 }; // Actual velocity used by physics

        this.sleeping = false; // Flick: resting on the solid floor

        this.prePixelX = this.pixelX; // Previous-step position: render interpolation
        this.prePixelY = this.pixelY; // ...and the hoop-crossing win check
    }

    release() {
        this.isStatic = false; // Ball becomes dynamic
    }

    /**
     * Update called AFTER physics each fixed step. Non-physics logic only.
     * @param {Game} game - The main game instance.
     */
    update(game) {
        if (this.isStatic) {
            return;
        }
        // Note: prePixelY is set in Game.stepSimulation *before* physics.
        this.checkForWin(game); // Check win condition based on movement
    }

    /**
     * Checks if the ball has passed downward through the hoop this step.
     * Relies on prePixelY (before physics) vs pixelY (after physics).
     * @param {Game} game - The main game instance.
     */
    checkForWin(game) {
        // Only check while the shot is live, hasn't already scored, and
        // hasn't been invalidated (entered the cylinder from below - such a
        // shot can never score, including via the rattle-in fake-out).
        if (game.currentState !== GameStates.SHOT_TAKEN || this.isStatic || this.velocity.y <= 0 || game.hasScored || game.roundInvalidated) {
             return;
        }

        if (game.lines.length === 0) return; // No hoop exists

        const hoop = game.lines[0];
        const hoopY = hoop.scoringY;   // the line's live middle
        const crossedLine = this.prePixelY < hoopY && this.pixelY >= hoopY;

        if (crossedLine) {
            // LIVE positions. The line between these posts IS the scoring
            // boundary; if a strike moves a post, the boundary moved. The
            // ball must pass between them where they actually are.
            const nLeft = hoop.node1.pixelX < hoop.node2.pixelX ? hoop.node1 : hoop.node2;
            const nRight = hoop.node1.pixelX < hoop.node2.pixelX ? hoop.node2 : hoop.node1;
            const withinPosts = this.pixelX > nLeft.pixelX && this.pixelX < nRight.pixelX;

            if (withinPosts) {
                dbg('Ball checkForWin: Score detected!');
                // The speed it passed through at - the pluck answers it,
                // exactly as every collision answers its own impact.
                const speed = Math.sqrt(this.velocity.x * this.velocity.x +
                                        this.velocity.y * this.velocity.y);
                // WHERE it crossed, normalised between the posts - the point
                // the string is plucked at (hoop.js).
                const u = (this.pixelX - nLeft.pixelX) /
                          Math.max(1, nRight.pixelX - nLeft.pixelX);
                game.registerScore(speed, u); // Game owns all scoring bookkeeping
                // Reset transition will be triggered by floor hit
            }
        }
    }


    /**
     * Draws the ball (and its trail if enabled). Called by Renderer.
     * @param {Game} game - The main game instance.
     */
    draw(game) {
        const c = game.c;

        // Render position: while flying, blend between the previous and
        // current step positions by the frame's progress toward the next
        // step - smooth motion on displays faster than the simulation rate.
        // The SIMULATED position is untouched; this is presentation only.
        let drawX = this.pixelX;
        let drawY = this.pixelY;
        if (!this.isStatic && CONFIG.RENDER.INTERPOLATE) {
            const a = game.renderAlpha;
            drawX = this.prePixelX + (this.pixelX - this.prePixelX) * a;
            drawY = this.prePixelY + (this.pixelY - this.prePixelY) * a;
        }

        // MOTION BLUR - the swept region, along the path the ball ACTUALLY
        // TOOK.
        //
        // A circle travelling in a straight line sweeps a capsule, and a
        // capsule is exactly what a stack of full-opacity copies converges
        // to. So the smear is stroked rather than stamped: a thick,
        // round-jointed POLYLINE back through the recent drawn positions.
        //
        // It used to be a single straight segment between last frame and
        // this one - a CHORD. Over one frame a chord and the true arc are
        // the same line, so it looked right. Over eight frames it cuts
        // visibly across the curve, and if the ball bounced inside that
        // span the line ran straight through the wall: a path nothing ever
        // travelled. Walking the recorded positions fixes both at once, and
        // a bounce now bends the smear by itself - no collision logic, the
        // buffer simply remembers the corner.
        //
        // Sampling at frame rate is enough. Within one 1/60s step gravity
        // bends the path by a fraction of a pixel; all the visible
        // curvature comes from spanning SEVERAL frames.
        //
        // SHUTTER is a camera's: the fraction of a frame's travel that
        // smears. Past 1 it is an exposure longer than one frame, which is
        // how to ask for an obvious ribbon.
        const B = CONFIG.RENDER.BLUR;
        if (B && B.ENABLED) {
            if (!this.blurTrail) this.blurTrail = [];
            this.blurTrail.push({ x: drawX, y: drawY });
            const cap = ((B.SHUTTER_MAX | 0) || 8) + 2;
            while (this.blurTrail.length > cap) this.blurTrail.shift();

            const tr = this.blurTrail;
            const maxSeg = B.MAX_TRAVEL_CELLS * game.cellRes;
            let remaining = Math.max(0, Math.min(B.SHUTTER_MAX || 8, B.SHUTTER));
            const pts = [tr[tr.length - 1]];
            let total = 0;
            for (let i = tr.length - 1; remaining > 0 && i > 0; i--) {
                const a = tr[i], p = tr[i - 1];
                const seg = Math.hypot(a.x - p.x, a.y - p.y);
                // A segment longer than this is not a journey, it is a
                // teleport - a pickup, a resize, a respawn. The smear stops
                // at the last thing that really happened.
                if (seg > maxSeg) break;
                if (remaining >= 1) { pts.push(p); total += seg; remaining -= 1; }
                else {
                    pts.push({ x: a.x + (p.x - a.x) * remaining,
                               y: a.y + (p.y - a.y) * remaining });
                    total += seg * remaining; remaining = 0;
                }
            }

            if (pts.length > 1 && total > B.MIN_TRAVEL_CELLS * game.cellRes) {
                const prevCap = c.lineCap, prevJoin = c.lineJoin;
                // THE RAMP: full at the ball, SOFTNESS at the far end, so
                // the trailing edge is a fade rather than a hard round cap.
                // Laid along the chord from head to tail - for an arc that
                // is right to within a pixel, and at a bounce it is a
                // shade approximate, which is a fair price for one fill.
                let ramp = null;
                const tail = pts[pts.length - 1];
                if (typeof c.createLinearGradient === 'function') {
                    ramp = c.createLinearGradient(pts[0].x, pts[0].y, tail.x, tail.y);
                    if (ramp && typeof ramp.addColorStop === 'function') {
                        ramp.addColorStop(0, Ball._rgba(game.themeColors.BALL, B.ALPHA));
                        ramp.addColorStop(1, Ball._rgba(game.themeColors.BALL, B.ALPHA * B.SOFTNESS));
                    } else { ramp = null; }
                }
                c.strokeStyle = ramp || game.themeColors.BALL;
                c.lineWidth = this.radius * 2;
                c.lineCap = 'round';
                c.lineJoin = 'round';   // a bounce corners like the ball does
                c.beginPath();
                c.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
                c.stroke();
                c.lineCap = prevCap;
                c.lineJoin = prevJoin;
            }
        }


        c.beginPath();
        c.arc(drawX, drawY, this.radius, 0, Math.PI * 2, false);
        c.fillStyle = game.themeColors.BALL;
        c.fill();
    }


    /**
     * Handles updates needed when the game window resizes.
     * @param {Game} game - The main game instance.
     */
    resizeUpdate(game) {
        this.radius = game.radius;
        // POSITION IS NOT RECOMPUTED HERE. gridX/gridY are where the ball
        // was BORN and are never updated as it moves, so rebuilding pixels
        // from them teleported a static ball back to its spawn on every
        // resize - which, for the intro ball, is above the ceiling. The
        // ball lives in absolute pixels; Game.handleResize rescales those
        // (and the previous position, the velocity and the trail) by the
        // cell-size ratio, which is correct in every state: held, flying,
        // rolling or asleep.
    }
} // End of Ball class