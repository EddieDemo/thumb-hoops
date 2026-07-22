// File: js/effects.js
// Detached one-shot visual effects: self-owned objects that can OUTLIVE the
// entities and signals that spawned them.
//
// OWNERSHIP (consistent with the rest of the codebase): the Game owns the
// list (game.effects) and time; the Renderer draws them; each effect owns
// its own state and lifecycle. Nothing registers, nothing schedules -
// effects are spawned, tick themselves, and report when they're done.
//
// DUAL DRIVE: while the fall that birthed an effect is still live (same
// round, fate transit active), progress is POSITION-driven - the effect
// moves with the ball like everything else. Once that signal dies (the
// round resets), the effect finishes on a short timed tail instead of
// being clipped. This is what lets a late ring complete its expansion
// gracefully across the reset.
'use strict';

class RingEffect {
    /**
     * A single expanding stroke circle - a peg's echo on a scored exit.
     * @param {number} x - Centre x (logical px, captured at spawn).
     * @param {number} y - Centre y (logical px, captured at spawn).
     * @param {number} delay - Start offset in exitT units (the ripple).
     * @param {number} span - exitT window the expansion plays over.
     * @param {number} roundId - The round that spawned it; its fate signal
     *        only drives this effect while game.roundId still matches.
     */
    constructor(x, y, delay, span, roundId) {
        this.x = x;
        this.y = y;
        this.delay = delay;
        this.span = span;
        this.roundId = roundId;
        this.p = 0;          // Ring life 0..1 (ratcheted - never rewinds)
        this.done = false;
    }

    /**
     * Advances the ring. Position-driven while its round's fall is live;
     * timed tail after.
     * @param {Game} game
     * @param {number} dt - Real seconds since last frame.
     */
    update(game, dt) {
        if (this.done) return;

        // "Live" means the fall is still IN PROGRESS - not merely that the
        // transit object still exists. exitT saturates at 1 the moment the
        // ball's centre crosses the bottom edge, but the transit lingers
        // until the reset timer fires ~0.5s later; without the < 1 check a
        // late ring would freeze against the stopped signal for that whole
        // window. The instant the fall is spent, the tail takes over.
        const exitT = game.getElementExitT();
        const roundLive = game.roundId === this.roundId &&
                          game.getElementExitMode() !== null &&
                          exitT < 1;

        if (roundLive) {
            // Position drive: same math as before, ratcheted.
            const raw = Motion.clamp01((exitT - this.delay) / this.span);
            this.p = Math.max(this.p, raw);
        } else {
            // The fall is gone (reset, or restart abandoned it): finish on
            // a short timed tail rather than being clipped mid-expansion.
            this.p += dt / (CONFIG.MOTION.SCORE_RING_TAIL_MS / 1000);
        }

        if (this.p >= 1) {
            this.p = 1;
            this.done = true;
        }
    }

    draw(game) {
        if (this.done || this.p <= 0) return;
        const r = this.p * game.cellRes * CONFIG.MOTION.SCORE_RING_SCALE;
        if (r < 0.5) return;

        const c = game.c;
        c.save();
        c.globalAlpha = (1 - this.p) * 0.7;
        c.beginPath();
        c.strokeStyle = game.themeColors.NODE; // Live theme - correct on any colour
        c.lineWidth = CONFIG.RENDER.HOOP_LINE_WIDTH;
        c.arc(this.x, this.y, r, 0, Math.PI * 2, false);
        c.stroke();
        c.restore();
    }
}