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
        // Applies while CARRIED as well as in flight. A ball following the
        // thumb is moving, and the eye does not care whose hand is on it -
        // the only difference is that a held ball has no interpolation, so
        // drawX/drawY are simply its position.
        if (B && B.ENABLED && this.blurPrevX !== undefined) {
            const dx = drawX - this.blurPrevX, dy = drawY - this.blurPrevY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const min = B.MIN_TRAVEL_CELLS * game.cellRes;
            const max = B.MAX_TRAVEL_CELLS * game.cellRes;
            // Below MIN there is nothing to smear; above MAX something
            // teleported (a resize, a respawn) and a streak across the
            // board would be a lie about a journey that never happened.
            if (dist > min && dist < max) {
                const k = 1 - Math.max(0, Math.min(1, B.SHUTTER));
                const backX = this.blurPrevX + dx * k;
                const backY = this.blurPrevY + dy * k;
                const prevAlpha = c.globalAlpha;
                const prevCap = c.lineCap;

                // ONE RAMP ACROSS BOTH SHAPES. The capsule and the wedge
                // share a single gradient running from the ball to the
                // tail tip, so the alpha is continuous BY CONSTRUCTION.
                // They used to be lit separately - a solid capsule ending
                // at 1.0 against a wedge starting at 0.30 - which put a
                // visible step exactly where the softness was wanted. The
                // trailing edge of the ball is now a fade, not an edge.
                const T0 = B.TAIL;
                const tailLen = (T0 && T0.LENGTH > 0) ? dist * T0.LENGTH : 0;
                const total = (dist * (1 - k)) + tailLen;
                let ramp = null;
                if (total > 0.001 && typeof c.createLinearGradient === 'function') {
                    const ux0 = dx / dist, uy0 = dy / dist;
                    ramp = c.createLinearGradient(
                        drawX, drawY,
                        drawX - ux0 * total, drawY - uy0 * total);
                    if (ramp && typeof ramp.addColorStop === 'function') {
                        const capEnd = (dist * (1 - k)) / total;
                        ramp.addColorStop(0, Ball._rgba(game.themeColors.BALL, B.ALPHA));
                        // SOFTNESS is the alpha where the swept region ends.
                        // 1 restores the old hard capsule; lower blurs the
                        // trailing edge into the wisp behind it.
                        ramp.addColorStop(Math.min(0.999, capEnd),
                            Ball._rgba(game.themeColors.BALL, B.ALPHA * B.SOFTNESS));
                        ramp.addColorStop(1, Ball._rgba(game.themeColors.BALL, 0));
                    } else { ramp = null; }
                }

                // THE TAIL, drawn FIRST so the solid capsule lands on top.
                //
                // A wedge running back from the capsule, narrowing and
                // fading out. ONE path with ONE gradient fill, deliberately
                // - a stack of semi-transparent segments would double its
                // own alpha wherever the segments overlapped, and the
                // banding that produces is exactly the "gradient-y" look
                // this is supposed to avoid.
                //
                // Its length is a MULTIPLE OF THE FRAME'S TRAVEL, so it is
                // speed that decides it: nothing at rest, a whisper at a
                // gentle roll, a real streak on a hard throw. LENGTH is the
                // dial - 0 is none.
                const T = B.TAIL;
                if (T && T.LENGTH > 0) {
                    const ux = dx / dist, uy = dy / dist;   // travel direction
                    const px = -uy, py = ux;                // and its normal
                    const len = dist * T.LENGTH;
                    const tx = backX - ux * len, ty = backY - uy * len;
                    const r0 = this.radius, r1 = this.radius * T.TAPER;
                    // Guarded: a gradient is a cosmetic nicety, and no
                    // cosmetic nicety is allowed to throw inside the render
                    // path. Without one, the wedge is skipped and the
                    // capsule still draws.
                    if (ramp) {
                    c.fillStyle = ramp;
                    c.beginPath();
                    c.moveTo(backX + px * r0, backY + py * r0);
                    c.lineTo(backX - px * r0, backY - py * r0);
                    c.lineTo(tx - px * r1, ty - py * r1);
                    c.lineTo(tx + px * r1, ty + py * r1);
                    c.closePath();
                    c.fill();
                    }
                }

                // The swept region, lit by the SAME ramp - so it meets the
                // wedge at exactly the wedge's own opacity.
                c.strokeStyle = ramp || game.themeColors.BALL;
                if (!ramp) c.globalAlpha = prevAlpha * B.ALPHA;
                c.lineWidth = this.radius * 2;
                c.lineCap = 'round';
                c.beginPath();
                c.moveTo(backX, backY);
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