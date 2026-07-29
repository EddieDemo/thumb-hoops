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
     * THE CABLE PULLS. Until now the string stretched to wherever the pegs
     * happened to be and exerted nothing back - drawn as a physical object,
     * behaving as though it were not one. Now it is taut at rest and pulls
     * when stretched, so the hoop is ONE THING WITH FLEX rather than two
     * posts and an infinitely elastic line.
     *
     * A CABLE PULLS BUT NEVER PUSHES. Move one post toward the other and
     * the string goes slack and transmits nothing; move it away and the
     * string tightens and drags its partner along. That asymmetry is real,
     * not a simplification, and it decides where this effect shows up:
     *
     *   - a ball landing ON a post displaces it VERTICALLY, transverse to
     *     the string. The chord barely changes (d^2/2L: about 0.0004 cells
     *     for a 0.05-cell knock on a 3-cell hoop), so the post dips alone.
     *   - a ball clipping the INSIDE of a post on its way through pushes it
     *     OUTWARD. The string tightens, the far post is pulled in, and the
     *     hoop flinches as a unit and briefly narrows.
     *
     * So it is silent on ordinary contacts and speaks on the shots that
     * shaved the rim - the near-miss, arrived at by modelling the object
     * honestly rather than by detecting anything.
     *
     * TENSION IS AN INTERNAL FORCE and therefore cannot move the pair's
     * centre of mass; only the ball may do that. The impulses below are
     * exactly equal and opposite, which is asserted rather than hoped for.
     *
     * OPERATOR SPLITTING: the tension impulse is applied here, then the
     * pegs' own springs are advanced exactly (spring.js). Splitting a
     * forced oscillator this way is first-order in dt while keeping the
     * unforced part exact - the honest trade, since the coupling is
     * one-sided and nonlinear and has no closed form worth chasing.
     *
     * @param {number} dt - Fixed step, seconds.
     */
    stepTension(dt) {
        const T = CONFIG.MOTION.STRING_TENSION;
        if (!T || !T.ENABLED) return;
        const a = this.node1, b = this.node2;
        if (!a || !b || a.homeX === undefined) return;

        // Taut at rest: the rest length IS the distance between homes.
        const restX = b.homeX - a.homeX, restY = b.homeY - a.homeY;
        const rest = Math.sqrt(restX * restX + restY * restY);
        if (!(rest > 0)) return;

        const dx = b.pixelX - a.pixelX, dy = b.pixelY - a.pixelY;
        const chord = Math.sqrt(dx * dx + dy * dy);
        const ext = chord - rest;
        if (ext <= 0 || chord <= 0) return;   // slack: a cable never pushes

        // Stiffness as an angular frequency, in the pegs' own units - so
        // STIFFNESS_HZ against PEG_GIVE.FREQ_HZ reads directly as how far
        // the far post follows: ratio = wt^2 / (wt^2 + wp^2).
        const wt = 2 * Math.PI * T.STIFFNESS_HZ;
        const dv = wt * wt * ext * dt;
        const ux = dx / chord, uy = dy / chord;

        a.velX += ux * dv;  a.velY += uy * dv;   // A pulled toward B
        b.velX -= ux * dv;  b.velY -= uy * dv;   // ...B toward A, exactly
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
        // The cached scoring height is the MEAN of the two posts - the same
        // definition draw() uses, so a tilted hoop is scored at its middle
        // whether or not a frame has been drawn since the resize.
        this.pixelY = (this.node1.pixelY + this.node2.pixelY) / 2;
    }
}