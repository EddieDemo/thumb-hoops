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
    }

    /**
     * The line is STRUNG between the pegs, so it animates by length:
     *  - Entry: after the pegs' pop, it draws itself left peg -> right peg.
     *  - Exit: driven by the same element-exit signal as the pegs, it
     *    retracts symmetrically into them - two halves pulling home, the
     *    whole hoop dying as one object.
     */
    draw(game) {
        const c = game.c;
        const M = CONFIG.MOTION;
        const x1 = this.node1.pixelX, x2 = this.node2.pixelX;
        const y = this.node1.pixelY;
        const exit = game.getElementExitT();

        const segments = [];
        if (exit > 0) {
            const half = (x2 - x1) / 2;
            const keep = half * (1 - exit);
            if (keep > 0.5) {
                segments.push([x1, x1 + keep]);       // Left half, retracting home
                segments.push([x2 - keep, x2]);       // Right half, retracting home
            }
        } else {
            const age = game.worldTime - this.spawnTime;
            const e = Motion.easeOutCubic(
                Motion.progress(age, M.LINE_DELAY_MS / 1000, M.LINE_DRAW_MS / 1000));
            if (e > 0.001) {
                // Mirror of the exit: two halves grow OUT of their pegs and
                // meet in the middle - the string emerges from its anchors.
                const half = (x2 - x1) / 2;
                const grow = half * e;
                segments.push([x1, x1 + grow]);       // Left half, growing out
                segments.push([x2 - grow, x2]);       // Right half, growing out
            }
        }

        if (segments.length > 0) {
            c.beginPath();
            c.strokeStyle = game.themeColors.HOOP;
            c.lineWidth = CONFIG.RENDER.HOOP_LINE_WIDTH;
            for (const seg of segments) {
                c.moveTo(seg[0], y);
                c.lineTo(seg[1], y);
            }
            c.stroke();
        }

        this.pixelY = this.node1.pixelY; // Update cached Y
    }

    resizeUpdate(game) {
        this.pixelY = this.node1.pixelY; // Update cached Y after node resize
    }
}