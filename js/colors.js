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
        // A STORED CHOICE ALWAYS WINS. Absent one, ask the system instead
        // of assuming light - assuming was a system claiming to know
        // something it did not, and it cost every dark-mode visitor a flash
        // of white before they found the toggle. Once they choose, the
        // choice is theirs forever; this only speaks when nothing has been
        // said.
        const stored = Persistence.load('darkMode', null);
        if (stored === true || stored === false) {
            darkMode = stored;
        } else {
            darkMode = !!(typeof window !== 'undefined' && window.matchMedia &&
                          window.matchMedia('(prefers-color-scheme: dark)').matches);
        }
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

// --- THE CONTRAST PRESET ------------------------------------------------
// Resolved the same way the theme is, and for the same reason: a system
// that does not know a preference should ASK rather than assume.
//
//   1. an explicit ?contrast= in the URL   (a tester link - the whole point)
//   2. a stored choice                     (they have decided; it is theirs)
//   3. the OS asking for more contrast     (they told their DEVICE already,
//                                           and should not have to find a
//                                           button to be understood)
//   4. the house default
//
// Note what (3) buys: someone who needs more contrast never has to locate
// the control that provides it.
let contrastPreset = null;

function activeContrast() {
    const C = CONFIG.COLORS.RAMP.CONTRAST;
    if (contrastPreset && C.PRESETS[contrastPreset]) return contrastPreset;

    let chosen = null;
    try {
        const q = new URLSearchParams(window.location.search).get('contrast');
        if (q && C.PRESETS[q]) chosen = q;
    } catch (e) { /* no URL, no matter */ }

    if (!chosen) {
        const stored = Persistence.load('contrast', null);
        if (stored && C.PRESETS[stored]) chosen = stored;
    }
    if (!chosen) {
        try {
            if (window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches) {
                chosen = C.ACCESSIBLE;
            }
        } catch (e) { /* no matchMedia, no matter */ }
    }
    contrastPreset = chosen || C.DEFAULT;
    return contrastPreset;
}

/**
 * Steps through CONTRAST.CYCLE - the presets the BUTTON can reach, in the
 * order they are listed. A ladder rather than a switch, so the middle rung
 * can be compared on glass instead of only on a URL.
 *
 * The cycle is deliberately a SEPARATE list from PRESETS: any preset can
 * exist for testing, but only the ones named here are reachable by tapping.
 * ACCESSIBLE must appear in it, or the accessibility control would no
 * longer reach an accessible state - which is asserted below rather than
 * left to whoever edits the config next.
 */
function toggleContrast() {
    const C = CONFIG.COLORS.RAMP.CONTRAST;
    const cycle = (C.CYCLE && C.CYCLE.length) ? C.CYCLE : [C.DEFAULT, C.ACCESSIBLE];
    const here = cycle.indexOf(activeContrast());
    // Not in the cycle (arrived by URL): the next tap starts it from the top.
    const next = cycle[(here + 1) % cycle.length];
    contrastPreset = next;
    Persistence.save('contrast', next);
    applyTheme(typeof game !== 'undefined' ? game : undefined);
}

function isHighContrast() {
    return activeContrast() === CONFIG.COLORS.RAMP.CONTRAST.ACCESSIBLE;
}

/** Where on the ladder we are, 0..1 - the glyph draws its fill from this. */
function contrastStep() {
    const C = CONFIG.COLORS.RAMP.CONTRAST;
    const cycle = (C.CYCLE && C.CYCLE.length) ? C.CYCLE : [C.DEFAULT, C.ACCESSIBLE];
    const i = cycle.indexOf(activeContrast());
    return (i < 0 || cycle.length < 2) ? 0 : i / (cycle.length - 1);
}

function toggleDarkMode() {
    darkMode = !darkMode;
    Persistence.save('darkMode', darkMode);
    dbg("Toggling dark mode to:", darkMode);
    applyTheme(typeof game !== 'undefined' ? game : undefined);

    // THE GONG, unoffset. Everywhere else it marks a cycle closing; here it
    // marks the whole world changing state, which is the larger event of
    // the two. No lag: nothing else sounds at this moment, so there is
    // nothing for it to sit behind. Placed in the toggle itself rather than
    // in the tap handler, so the T key rings it too - one authority.
    if (typeof Audio !== 'undefined' && CONFIG.AUDIO.GONG_ON_THEME) {
        Audio.gong(0);
    }
}