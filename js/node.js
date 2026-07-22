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
        this.pixelX = this.gridX * this.game.cellRes;
        this.pixelY = this.gridY * this.game.cellRes;

        // Presentation birth time (game.worldTime is the presentation clock).
        this.spawnTime = game.worldTime + (entryDelay || 0);
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
        this.pixelX = this.gridX * game.cellRes;
        this.pixelY = this.gridY * game.cellRes;
        // Resize snaps: no animation replay, positions/sizes just update.
    }
}