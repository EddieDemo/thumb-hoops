// File: core.js
// Global utilities + bootstrap.
// NOTE: rotate() and resolveCollision() were removed - the elastic-collision
// model was replaced by explicit restitution in physics.js and nothing
// references them. (git remembers, should ball-vs-ball ever return.)
'use strict';

var game; // Global game instance
var inputHandler; // Global input handler instance

/**
 * Calculates distance between two points.
 */
function distance(x1, y1, x2, y2) {
    const xDist = x2 - x1;
    const yDist = y2 - y1;
    return Math.sqrt(xDist * xDist + yDist * yDist);
}

/**
 * Converts a HEX color string to an RGB object.
 */
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16)
    } : { r: 255, g: 255, b: 255 };
}

// --- Global Initialization ---
window.onload = function() {
    game = new Game(); // Game creates its own PhysicsEngine and Renderer
    inputHandler = new InputHandler(game);
    inputHandler.attachEventListeners();
    window.addEventListener('resize', game.handleResize.bind(game), false);
    requestAnimationFrame((timestamp) => game.animate(timestamp)); // Start loop
    dbg("Game and InputHandler initialized, animation started.");
};