// File: hoop.js
'use strict';

class Hoop {
    constructor(node1, node2, game) {
        this.game = game;
        this.node1 = node1; // Left peg (createHoop guarantees node1.x < node2.x)
        this.node2 = node2;
        this.pixelY = this.node1.pixelY; // Cache Y pos

        // Presentation birth time. The line's draw-in is internally delayed
        // (LINE_DELAY_MS) so the pegs pop first - anchors, then string.
        this.spawnTime = game.worldTime;

        // The pluck: { t0, u, amp } while ringing, else null. See pluck().
        this.plucked = null;
    }

    /**
     * THE PLUCK. The ball has passed through, and the line behaves like the
     * string it sounds like.
     *
     * A string fixed at both ends and pulled aside at position u starts as a
     * TRIANGLE peaking at u. Released, that shape decomposes into standing
     * modes whose amplitudes go as sin(n*pi*u) / n^2 - so the fundamental
     * (a single arc, antinode at the CENTRE) is much the largest term, and
     * every higher mode is both smaller and damped harder. The visible
     * consequence is the thing that makes this worth doing: the bulge
     * begins where the ball crossed and MIGRATES to the middle as the
     * overtones die. Pluck dead centre and the even modes vanish exactly
     * (sin(n*pi/2) = 0), which is the same reason a guitar sounds rounder
     * plucked over the 12th fret.
     *
     * The one deliberate lie is TIME. A real string runs at audio rates and
     * reads as a blur; this runs at a few hertz so the eye can follow the
     * modes resolving. Physically structured, visually timed.
     *
     * @param {number} u        where along the line, 0..1
     * @param {number} strength 0..1, from the speed it was crossed at
     */
    pluck(u, strength) {
        const P = CONFIG.MOTION.PLUCK;
        if (!P || !P.ENABLED) return;
        // The series divides by u(1-u): a pluck exactly on a peg is not a
        // pluck, so hold it just inside the anchors.
        const uu = Math.max(P.EDGE_CLAMP, Math.min(1 - P.EDGE_CLAMP, u));
        this.plucked = {
            t0: this.game.worldTime,
            u: uu,
            amp: P.AMPLITUDE_CELLS * this.game.cellRes *
                 (P.MIN_STRENGTH + (1 - P.MIN_STRENGTH) * Math.max(0, Math.min(1, strength)))
        };
    }

    /** Displacement of the string at normalised x, seconds after the pluck. */
    _plucked_y(x, t) {
        const P = CONFIG.MOTION.PLUCK;
        const u = this.plucked.u;
        const w1 = 2 * Math.PI * P.FUNDAMENTAL_HZ;
        let y = 0;
        for (let n = 1; n <= P.MODES; n++) {
            // Fourier coefficient of a triangular pluck at u.
            const B = 2 * Math.sin(n * Math.PI * u) /
                      (n * n * Math.PI * Math.PI * u * (1 - u));
            y += B * Math.sin(n * Math.PI * x) *
                 Math.cos(n * w1 * t) *
                 Math.exp(-t * Math.pow(n, P.DAMP_EXP) / P.DECAY_S);
        }
        return y * this.plucked.amp;
    }

    /**
     * The line FADES. It is drawn at its true, full length from the moment
     * it exists, and only its opacity moves:
     *  - Entry: after the pegs' pop, it fades up between them.
     *  - Exit: driven by the same element-exit signal as the pegs, it fades
     *    away with them - the whole hoop dying as one object.
     *
     * It used to animate by LENGTH, growing out of its pegs and retracting
     * home. That looked good and said something false: this line IS the
     * scoring boundary, and the boundary is full-width the instant the
     * round begins. A line still growing toward its peg draws a shorter
     * hoop than the one the ball is actually being judged against. Opacity
     * can say "arriving" without misstating where the edges are.
     */
    draw(game) {
        const c = game.c;
        const M = CONFIG.MOTION;
        // The line is STRUNG BETWEEN THE PEGS, so it hangs from wherever
        // they are. Strike one post and the string tilts with it - not a
        // second effect, just the consequence of the anchors being real.
        const x1 = this.node1.pixelX, x2 = this.node2.pixelX;
        const y1 = this.node1.pixelY, y2 = this.node2.pixelY;
        const y = (y1 + y2) / 2;   // the cached scoring height: the mean

        const exit = game.getElementExitT();
        let presence;
        if (exit > 0) {
            presence = 1 - exit;                       // fading out with the pegs
        } else {
            const age = game.worldTime - this.spawnTime;
            presence = Motion.easeOutCubic(
                Motion.progress(age, M.LINE_DELAY_MS / 1000, M.LINE_DRAW_MS / 1000));
        }
        if (presence <= 0.001) { this.pixelY = y; return; }

        const prevAlpha = c.globalAlpha;
        c.globalAlpha = prevAlpha * presence;
        c.beginPath();
        c.strokeStyle = game.themeColors.HOOP;
        c.lineWidth = CONFIG.RENDER.HOOP_LINE_WIDTH;

        const P = CONFIG.MOTION.PLUCK;
        let ringing = false;
        if (this.plucked) {
            const t = game.worldTime - this.plucked.t0;
            if (t >= 0 && t < P.DECAY_S * P.LIFETIME_MULT) ringing = true;
            else this.plucked = null;   // rung out; back to a plain line
        }

        if (ringing) {
            // Sampled as a polyline. The ends are pinned: a string fixed at
            // both anchors, which is exactly what the pegs are.
            const t = game.worldTime - this.plucked.t0;
            const span = x2 - x1;
            const N = P.SAMPLES;
            const rise = y2 - y1;
            c.moveTo(x1, y1);
            for (let i = 1; i <= N; i++) {
                const s = i / N;
                c.lineTo(x1 + span * s, y1 + rise * s + this._plucked_y(s, t));
            }
        } else {
            c.moveTo(x1, y1);
            c.lineTo(x2, y2);
        }

        c.stroke();
        c.globalAlpha = prevAlpha;

        this.pixelY = y; // Update cached Y
    }

    resizeUpdate(game) {
        this.pixelY = y; // Update cached Y after node resize
    }
}