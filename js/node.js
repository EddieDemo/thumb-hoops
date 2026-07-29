// File: node.js
'use strict';

class Node {
    /**
     * @param {number} gridX
     * @param {number} gridY
     * @param {Game} game
     * @param {number} [entryDelay=0] - Seconds before this peg's pop-in
     *        begins (used to stagger the two rim pegs).
     */
    constructor(gridX, gridY, game, entryDelay) {
        this.game = game;
        this.gridX = gridX;
        this.gridY = gridY;
        this.radius = this.game.nRadius; // COLLISION radius - never animated.
        // NOTE: mass/velocity/isStatic removed - pegs are immovable by
        // definition in the physics model (see physics.js energy model).
        // WHERE THE PEG BELONGS, and where it currently IS. The rest
        // position is fixed by the lattice; pixelX/pixelY is home plus
        // whatever the spring is doing, and is therefore the ONE position -
        // collision, rendering and the hoop line's anchors all read it, so
        // the peg genuinely is where it is drawn. Nothing has to be kept in
        // sync because there is only one truth.
        this.homeX = this.gridX * this.game.cellRes;
        this.homeY = this.gridY * this.game.cellRes;
        this.offX = 0; this.offY = 0;   // displacement from home
        this.velX = 0; this.velY = 0;   // ...and how fast it is returning
        this.pixelX = this.homeX;
        this.pixelY = this.homeY;

        // Presentation birth time (game.worldTime is the presentation clock).
        this.spawnTime = game.worldTime + (entryDelay || 0);
    }

    /**
     * STRUCK. The ball has hit this peg, so the peg moves - Newton's third
     * law, arriving as juice. The direction is the CONTACT NORMAL the
     * collision already computed for the bounce, pointing from the ball
     * into the peg, so the two objects are pushed apart by one impulse
     * rather than by two separate decisions.
     *
     * The magnitude is set in terms of the PEAK DISPLACEMENT it should
     * reach (spring.js inverts the oscillator to find the impulse), so
     * MAX_CELLS is an honest statement of how far the peg will actually
     * move and not a force constant that has to be discovered by trial.
     *
     * @param {number} nx - Unit normal x, ball -> peg.
     * @param {number} ny - Unit normal y, ball -> peg.
     * @param {number} speedCells - Approach speed along that normal.
     */
    strike(nx, ny, speedCells) {
        const G = CONFIG.MOTION.PEG_GIVE;
        if (!G || !G.ENABLED) return;
        if (!(speedCells > G.MIN_IMPACT)) return;   // a graze is not a blow

        const t = Math.min(1, (speedCells - G.MIN_IMPACT) /
                              Math.max(1e-6, G.REF_IMPACT - G.MIN_IMPACT));
        const peak = G.MAX_CELLS * t * this.game.cellRes;
        const v = Spring.impulseForPeak(peak, G.FREQ_HZ, G.DAMPING);
        // ADDS to whatever the peg is already doing - a rattle strikes the
        // same peg twice, and the second blow should land on a moving peg,
        // not replace its motion.
        this.velX += nx * v;
        this.velY += ny * v;
    }

    /**
     * One fixed step of the return home. Exact (see spring.js), so this is
     * frame-rate independent in the same sense the ball's physics is.
     */
    stepSpring(dt) {
        const G = CONFIG.MOTION.PEG_GIVE;
        if (!G || !G.ENABLED) {
            if (this.offX || this.offY || this.velX || this.velY) {
                this.offX = this.offY = this.velX = this.velY = 0;
                this.pixelX = this.homeX; this.pixelY = this.homeY;
            }
            return;
        }
        // Asleep: exactly home and exactly still. Skipping is not just an
        // optimisation - it keeps a resting peg bit-identical to a peg that
        // has never been touched.
        if (this.offX === 0 && this.offY === 0 && this.velX === 0 && this.velY === 0) return;

        const sx = { x: this.offX, v: this.velX };
        const sy = { x: this.offY, v: this.velY };
        Spring.step(sx, G.FREQ_HZ, G.DAMPING, dt);
        Spring.step(sy, G.FREQ_HZ, G.DAMPING, dt);
        this.offX = sx.x; this.velX = sx.v;
        this.offY = sy.x; this.velY = sy.v;

        // Hard ceiling. A pathological impulse must not fling a post across
        // the court; the game's geometry is not negotiable.
        const lim = G.MAX_OFFSET_CELLS * this.game.cellRes;
        const d2 = this.offX * this.offX + this.offY * this.offY;
        if (d2 > lim * lim) {
            const k = lim / Math.sqrt(d2);
            this.offX *= k; this.offY *= k;
        }

        // Settled? Snap, so it returns to EXACTLY home rather than
        // asymptotically near it, and can then sleep.
        const eps = G.SLEEP_CELLS * this.game.cellRes;
        if (Math.abs(this.offX) < eps && Math.abs(this.offY) < eps &&
            Math.abs(this.velX) < eps * 60 && Math.abs(this.velY) < eps * 60) {
            this.offX = this.offY = this.velX = this.velY = 0;
        }
        this.pixelX = this.homeX + this.offX;
        this.pixelY = this.homeY + this.offY;
    }

    /**
     * Visual presence 0..1+ (easeOutBack overshoots slightly during the
     * pop-in). Composition: entry pop x (1 - element exit).
     * The EXIT term reads the game's fate-transit element signal, which by
     * construction only rises once the ball is provably past last-possible
     * peg contact - so the visual shrink never lies about collision, which
     * always uses the full radius.
     * @param {Game} game
     * @returns {number}
     */
    getPresenceScale(game) {
        const M = CONFIG.MOTION;
        const age = game.worldTime - this.spawnTime;
        if (age <= 0) return 0; // Not born yet (stagger delay)

        const e = Motion.progress(age, 0, M.PEG_POP_MS / 1000);
        const entry = e >= 1 ? 1 : Motion.easeOutBack(e);

        const exit = game.getElementExitT();
        let exitScale = 1 - exit; // Miss: plain deflation with the fall

        // Scored exit: the peg takes a bow - a brief swell as the ball
        // passes beneath it, then the shrink (delayed quadratically so the
        // swell can actually rise above 1 before the departure wins).
        if (exit > 0 && game.getElementExitMode() === 'score') {
            const swell = 1 + M.SCORE_BOW_SCALE *
                Math.sin(Math.PI * Motion.clamp01(exit / M.SCORE_BOW_WINDOW));
            exitScale = swell * (1 - exit * exit);
        }

        return Math.max(0, entry * exitScale);
    }

    draw(game) {
        const c = game.c;

        // NOTE: the score-ring echoes are no longer drawn here - they are
        // spawned as detached effects (see effects.js / startFateTransit)
        // so they can outlive both this peg and the round's fate signal.

        const scale = this.getPresenceScale(game);
        if (scale <= 0.001) return;

        c.beginPath();
        c.arc(this.pixelX, this.pixelY, this.radius * scale, 0, Math.PI * 2, false);
        c.fillStyle = game.themeColors.NODE;
        c.fill();
    }

    resizeUpdate(game) {
        this.radius = game.nRadius; // Use calculated radius
        this.homeX = this.gridX * game.cellRes;
        this.homeY = this.gridY * game.cellRes;
        // A resize rescales the world; a displacement measured in the OLD
        // cell size means nothing in the new one, and a spring caught
        // mid-swing has no journey worth preserving. Home, still, silent.
        this.offX = this.offY = this.velX = this.velY = 0;
        this.pixelX = this.homeX;
        this.pixelY = this.homeY;
        // Resize snaps: no animation replay, positions/sizes just update.
    }
}