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

    // The page body carries the world's texture BEYOND the court: a CSS
    // checkerboard (repeating-conic 2x2 tile) aligned to the canvas's
    // position and cell size, so the pattern continues seamlessly past the
    // walls into any viewport margins (Safari chrome letterboxing, desktop
    // windows). The court's own cells are painted opaquely by the renderer;
    // this is pure surround. Falls back to the plain colour when the grid
    // is off or layout isn't known yet.
    // Tile parity: conic quarters give TL=bg TR=cell2 / BL=cell2 BR=bg,
    // matching the board's (x+y)%2 rule with FILL_1 at (0,0).
    let bgValue;
    if (CONFIG.RENDER.DRAW_GRID && game && game.rect && game.cellRes) {
        const tile = game.cellRes * 2;
        bgValue = 'repeating-conic-gradient(' + theme.CELL_FILL_2 + ' 0% 25%, '
                + theme.BACKGROUND + ' 0% 50%) '
                + (game.rect.left + (game.worldOffsetX || 0)) + 'px '
                + (game.rect.top + (game.worldOffsetY || 0)) + 'px / '
                + tile + 'px ' + tile + 'px';
    } else {
        bgValue = theme.BACKGROUND;
    }

    // The full style string is its own change key: theme, canvas position,
    // and cell size all invalidate it (resize refreshes game.rect, so the
    // surround re-aligns automatically).
    if (bgValue !== lastAppliedBackground) {
        document.body.style.background = bgValue;
        lastAppliedBackground = bgValue;
    }
}

/**
 * Toggles dark mode (persisted) and reapplies.
 * Assumes 'game' is the global Game instance (created in core.js).
 */
/** Current mode, for UI that reflects it (the theme toggle's glyph). */
function isDarkMode() {
    return darkMode;
}

function toggleDarkMode() {
    darkMode = !darkMode;
    Persistence.save('darkMode', darkMode);
    dbg("Toggling dark mode to:", darkMode);
    applyTheme(typeof game !== 'undefined' ? game : undefined);
}