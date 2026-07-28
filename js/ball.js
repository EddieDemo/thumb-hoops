// File: ball.js
'use strict';

class Ball {
    constructor(gridX, gridY, game) {
        this.game = game;
        this.isStatic = true; // Ball starts static until aimed/shot
        this.gridX = gridX;
        this.gridY = gridY;
        this.radius = this.game.radius; // Calculated in game
        this.pixelX = this.gridX * this.game.cellRes;
        this.pixelY = this.gridY * this.game.cellRes;

        this.velocity = { x: 0, y: 0 }; // Actual velocity used by physics

        // Fading position trail (drawn when CONFIG.RENDER.DRAW_TRAIL)
        this.trail = [];
        this.sleeping = false; // Flick: resting on the solid floor
        this.trailLength = CONFIG.GAME.TRAIL_LENGTH;

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
        this.updateTrail();     // Update aesthetic trail
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
        const hoopY = hoop.pixelY;
        const crossedLine = this.prePixelY < hoopY && this.pixelY >= hoopY;

        if (crossedLine) {
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
     * Records the current position into the trail and trims it.
     */
    updateTrail() {
        if (this.isStatic) return;
        this.trail.unshift({ x: this.pixelX, y: this.pixelY });
        if (this.trail.length > this.trailLength) {
            this.trail.length = this.trailLength;
        }
    }

    /**
     * Draws the ball (and its trail if enabled). Called by Renderer.
     * @param {Game} game - The main game instance.
     */
    draw(game) {
        const c = game.c;

        if (!this.isStatic && CONFIG.RENDER.DRAW_TRAIL) {
            this.drawTrail(c, game);
        }

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

        // MOTION BLUR - the swept region, not more ghosts.
        //
        // A circle travelling in a straight line sweeps a CAPSULE, and a
        // capsule is exactly what a stack of full-opacity copies converges
        // to. So draw the swept shape itself: a round-capped thick line
        // from where the ball was drawn last frame to where it is now. One
        // path, geometrically exact, and it scales with speed for free -
        // at rest the capsule is the circle, at speed it is a smear.
        //
        // SHUTTER is borrowed from cameras and is what keeps it subtle: a
        // real shutter is open for only part of each frame, so the blur
        // covers a fraction of the travel rather than all of it. It trails
        // BEHIND the ball, because the ball is at its position and the
        // smear is where it has just been.
        //
        // Measured against the LAST DRAWN position, not the last physics
        // step, so it describes one displayed frame - correct at 60Hz and
        // still correct at 120.
        const B = CONFIG.RENDER.BLUR;
        if (B && B.ENABLED && !this.isStatic && this.blurPrevX !== undefined) {
            const dx = drawX - this.blurPrevX, dy = drawY - this.blurPrevY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const min = B.MIN_TRAVEL_CELLS * game.cellRes;
            const max = B.MAX_TRAVEL_CELLS * game.cellRes;
            // Below MIN there is nothing to smear; above MAX something
            // teleported (a resize, a respawn) and a streak across the
            // board would be a lie about a journey that never happened.
            if (dist > min && dist < max) {
                const k = 1 - Math.max(0, Math.min(1, B.SHUTTER));
                const prevAlpha = c.globalAlpha;
                const prevCap = c.lineCap;
                c.globalAlpha = prevAlpha * B.ALPHA;
                c.strokeStyle = game.themeColors.BALL;
                c.lineWidth = this.radius * 2;
                c.lineCap = 'round';
                c.beginPath();
                c.moveTo(this.blurPrevX + dx * k, this.blurPrevY + dy * k);
                c.lineTo(drawX, drawY);
                c.stroke();
                c.globalAlpha = prevAlpha;
                c.lineCap = prevCap;
            }
        }
        this.blurPrevX = drawX;
        this.blurPrevY = drawY;

        c.beginPath();
        c.arc(drawX, drawY, this.radius, 0, Math.PI * 2, false);
        c.fillStyle = game.themeColors.BALL;
        c.fill();
    }

    /**
     * Draws the fading, shrinking position trail.
     * @param {CanvasRenderingContext2D} c - The canvas rendering context.
     * @param {Game} game - The main game instance.
     */
    drawTrail(c, game) {
        const trailLen = this.trail.length;
        if (trailLen === 0) return;

        // PERF: one fillStyle for the whole trail; per-arc opacity via
        // globalAlpha. The old version built ~30 rgba(...) strings per
        // frame (allocate + parse each) - identical pixels, none of the
        // churn.
        const opacityFactor = 0.1;
        c.save();
        c.fillStyle = game.themeColors.BALL;

        for (let i = trailLen - 1; i >= 0; i--) {
            const t = (trailLen - i) / trailLen; // 1 = newest, ->0 = oldest
            const trailRadius = Math.max(0, this.radius * t);

            c.globalAlpha = t * opacityFactor;
            c.beginPath();
            c.arc(this.trail[i].x, this.trail[i].y, trailRadius, 0, Math.PI * 2, false);
            c.fill();
        }
        c.restore();
    }

    /**
     * Handles updates needed when the game window resizes.
     * @param {Game} game - The main game instance.
     */
    resizeUpdate(game) {
        this.radius = game.radius;
        this.trailLength = CONFIG.GAME.TRAIL_LENGTH;
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