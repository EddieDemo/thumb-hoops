// File: colors.js
// Theme mode management. The Palette is the sole colour authority for BOTH
// modes; this file only tracks which mode is active (persisted), tells the
// Palette, and writes the page background when it actually changes.
'use strict';

let darkMode = false;
let darkModeLoaded = false;       // Lazily read from Persistence on first apply
let lastAppliedBackground = null; // Body style is only touched on real change

/**
 * Applies the current mode: points the Palette at the right ramp pole and
 * refreshes the game's theme immediately. Called at startup and on toggle.
 * @param {Game} [game] - The main game instance, when available.
 */
function applyTheme(game) {
    if (!darkModeLoaded) {
        darkMode = Persistence.load('darkMode', false) === true;
        darkModeLoaded = true;
    }
    Palette.setMode(darkMode ? 'dark' : 'light');
    lastAppliedBackground = null; // Force a body background write next frame
    if (game) {
        game.themeColors = Palette.update(0); // Immediate rebuild, no tween
    }
}

/**
 * Per-frame theme update: ticks Palette tweens and applies the result.
 * Called from Game.animate before drawing.
 * @param {Game} game - The main game instance.
 * @param {number} dt - Real seconds since last frame.
 */
function updateDynamicTheme(game, dt) {
    const theme = Palette.update(dt);
    game.themeColors = theme;
    if (theme.BACKGROUND !== lastAppliedBackground) {
        document.body.style.background = theme.BACKGROUND;
        lastAppliedBackground = theme.BACKGROUND;
    }
}

/**
 * Toggles dark mode (persisted) and reapplies.
 * Assumes 'game' is the global Game instance (created in core.js).
 */
function toggleDarkMode() {
    darkMode = !darkMode;
    Persistence.save('darkMode', darkMode);
    dbg("Toggling dark mode to:", darkMode);
    applyTheme(typeof game !== 'undefined' ? game : undefined);
}