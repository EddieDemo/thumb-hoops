// File: js/config.js
'use strict';

// Global Configuration Object
// Use 'var' for broader compatibility without modules
var CONFIG = {

    // Master debug switch: gates all dbg() logging across the codebase.
    // console.warn/error always fire regardless - real problems must surface.
    DEBUG: false,

    GRID: {
        COLUMNS: 9,
        ROWS: 16
    },

    PHYSICS: { // <-- Make sure PHYSICS is correctly defined as an object key
        // --- Scales relative to cellRes (calculated in Game.redefineVariables) ---

        // Gravity's effect on the ball's downward acceleration.
        // Calculation: ball_acceleration = game.cellRes * GRAVITY_SCALE
        GRAVITY_SCALE: 0.02,

        // Controls how sensitive the aiming is to input movements (e.g., mouse/touch drag).
        // Launch speed = (dragDistance / cellRes) * (cellRes * AIMING_SENSITIVITY_SCALE)
        //             = dragDistance * AIMING_SENSITIVITY_SCALE  (in logical px per physics step)
        // NOTE: Retuned from 0.035 -> 0.14 (x4) when input moved to logical coordinates,
        // preserving the exact previous game feel. Tune freely from here.
        AIMING_SENSITIVITY_SCALE: 0.14,

        // Maximum drag distance that registers, as a fraction of the board's logical height.
        // Calculation: max_drag_distance = (ROWS * cellRes) * MAX_DRAG_HEIGHT_MULTIPLIER
        // NOTE: Retuned from 2 -> 0.5 when input moved to logical coordinates. The old value
        // of 2 was measured in scaled coordinates, making the *effective* max drag half the
        // board height - 0.5 now states that honestly. Tune freely from here.
        MAX_DRAG_HEIGHT_MULTIPLIER: 0.5,

        // Defines the ball's radius relative to the cell size.
        // Calculation: ball_radius = game.cellRes * RADIUS_SCALE
        RADIUS_SCALE: 0.5,

        // Defines the radius of the nodes (pegs) relative to the cell size.
        // Calculation: node_radius = game.cellRes * NRADIUS_SCALE
        NRADIUS_SCALE: 0.1,

        // --- Fixed timestep ---

        // The simulation advances in fixed steps of 1/STEP_HZ seconds,
        // regardless of display refresh rate. All physics values (gravity,
        // velocities) are expressed PER STEP, which is why the engine passes
        // dt=1 - one step is the unit of simulation time. This keeps the game
        // identical on 60Hz, 120Hz and 144Hz displays, and keeps the
        // prediction path (which iterates the same steps) exact by construction.
        STEP_HZ: 60,

        // Max physics steps to run in a single rendered frame. Guards against
        // the "spiral of death": if a device is too slow to keep up, we drop
        // simulation backlog instead of freezing trying to catch up.
        MAX_STEPS_PER_FRAME: 5,

        // --- Restitution (bounciness) - ALL energy loss is explicit ---

        // Velocity retained when bouncing off the side walls.
        // 0 = dead stop, 1 = perfectly elastic. (Formerly named FRICTION.)
        WALL_RESTITUTION: 0.5,

        // Velocity (normal component) retained when bouncing off a peg/node.
        // Pegs are immovable; the tangential component is never affected.
        // 0.55 = slightly soft rim: inside-edge grazes tend to drop IN rather
        // than get rejected (positive-surprise bias), and rattles settle in a
        // few decisive hops. (2/3 reproduces the pre-refactor implicit value.)
        PEG_RESTITUTION: 0.55
    },

    MOTION: {
        // Element entry: the two rim pegs POP (easeOutBack overshoot), the
        // second a beat after the first, then the hoop line draws itself
        // between them - anchors first, then string.
        PEG_POP_MS: 200,
        PEG_STAGGER_MS: 30,
        LINE_DELAY_MS: 210, // ~ pop + stagger: the string waits for anchors
        LINE_DRAW_MS: 120,

        // Element EXIT timing is position-driven by the ball's fall past
        // the last-possible-contact line (see Game.updateFateTransit), like
        // the colour transition. The constants below shape HOW elements
        // leave, not when.

        // Scored exits: the pegs take a small bow - swelling ~11% before
        // shrinking away - instead of the miss's plain deflation.
        // SCORE_BOW_SCALE is the swell amplitude; SCORE_BOW_WINDOW is the
        // slice of the exit (0..1) the swell plays over.
        SCORE_BOW_SCALE: 0.15,
        SCORE_BOW_WINDOW: 0.35,

        // Optional score rings: on a scored exit, EACH peg emits one
        // expanding stroke circle - its echo - radius driven by the ball's
        // fall, dissolving as it exits. Toggle to taste-test the score
        // moment with/without.
        SCORE_RING: true,
        SCORE_RING_SCALE: 0.45, // Final radius in cell units

        // Ripple: exitT delay per cell of distance between a peg and the
        // ball's crossing point. 0.08 means a peg 2 cells from the crossing
        // starts its ring ~16% of the fall later. 0 = simultaneous rings.
        SCORE_RING_WAVE: 0.08,

        // Every ring expands over this fixed slice of the fall (identical
        // pace regardless of delay).
        SCORE_RING_SPAN: 0.9,

        // When a ring's round ends before it finishes (reset or restart),
        // it completes on a timed tail at this full-ring-equivalent pace
        // instead of being clipped mid-expansion.
        SCORE_RING_TAIL_MS: 300
    },

    HAPTICS: {
        ENABLED: true,

        // Impact strengths are in CELL UNITS per step (impact speed /
        // cellRes), making them screen-size independent. For reference: a
        // max-power launch is ~1.1 cell/step; typical peg hits 0.2-0.8.

        MIN_IMPACT: 0.06,  // Below this, no tick (grazes/settling stay silent)
        REF_IMPACT: 0.8,   // At or above this, full-strength tick
        MIN_MS: 8,         // Tick duration at MIN_IMPACT
        MAX_MS: 24,        // Tick duration at REF_IMPACT
        MIN_GAP_MS: 45     // Rate limit: rattle ticks stay crisp, not mushy
    },

    GAME: {
        DIFFICULTY_LEVELS: [2, 3, 4], // Hoop width = difficulty * cellRes
        SHOOT_AREA_ROWS: 3,       // Number of rows from bottom for shooting area
        PREDICTION_FRAMES: 100,   // Full path length (steps) - used while teaching and in debug

        // --- First-run teaching (scaffold and fade) ---
        // Prediction path length by shot number: shot 1 shows the complete
        // answer, shot 2 the launch arc, shot 3 just direction+power intent,
        // shot 4 onward nothing. Teaching through the systems, zero text.
        TEACHING_PATH_STEPS: [100, 36, 14],

        // 'lifetime': the wean runs over the first shots EVER taken on this
        //             device, then the path is gone for good (pure tutorial).
        // 'run':      the wean restarts at the top of every run - a warm-up
        //             ritual after each streak reset.
        // The shot counter persists either way, so reloading mid-streak can
        // never conjure a free assisted shot.
        TEACHING_SCOPE: 'run',
        TRAIL_LENGTH: 30,
        RESET_DELAY_SECONDS: 0.5 // Delay after ball hits floor before reset
    },

    RENDER: {
        // NOTE: DOWNSAMPLE_SCALE removed. Rendering resolution now derives
        // from window.devicePixelRatio (see Game.redefineVariables) - crisp
        // on every display at a fraction of the old 4x supersampling cost.
        GRID_LINE_WIDTH: 0.5,     // Fixed grid line width
        BOUNDARY_LINE_WIDTH: 2,
        SHOOT_LINE_WIDTH: 1,
        // HOOP_LINE_WIDTH_SCALE: 1 / 15, // << COMMENTED OUT: Old relative scale
        HOOP_LINE_WIDTH: 1,     // << ADDED: Fixed hoop line width in pixels
        DRAW_GRID: false, // <<< ADD THIS FLAG HERE (set true or false)
        // Blend the ball's rendered position between physics steps so motion
        // is smooth on displays faster than STEP_HZ (90/120/144Hz phones).
        // Rendering runs a fraction of one step behind the simulation -
        // imperceptible, and the simulation itself is never affected.
        INTERPOLATE: true,

        // DEBUG OVERRIDE: force the full prediction path on every shot,
        // ignoring the teaching wean. For development/tuning only.
        PREDICTION_PATH_ALWAYS: false,
        DRAW_TRAIL: true,           // Toggle for the ball's fading trail

        // --- Prediction Path Style Options ---
        PREDICTION_PATH_STYLE: 'dots', // Options: 'dots' or 'line'
        PREDICTION_ALPHA: 0.3,         // Base opacity of the path (fade multiplies this)
        PREDICTION_PATH_LINE_WIDTH: 1, // Line width used for both styles
        // Scale relative to the ball's radius, used only for 'dots' style
        PREDICTION_PATH_DOT_RADIUS_SCALE: 1,
        // --- End Prediction Path Options ---

    },

    COLORS: {
        // Defined hex values
        // Greys - //https://coolors.co/palette/f8f9fa-e9ecef-dee2e6-ced4da-adb5bd-6c757d-495057-343a40-212529
        G1: '#F8F9FA',
        G2: '#E9ECEF',
        G3: '#DEE2E6',
        G4: '#CED4DA',
        G5: '#ADB5BD',
        G6: '#6C757D',
        G7: '#495057',
        G8: '#343A40',
        G9: '#212529',

        // --- Accent-colour identity ramp (both modes) ---
        // HSB model: interpolate linearly between per-mode anchors with the
        // hue bending +HUE_BEND degrees across the journey. See palette.js.
        RAMP: {
            // Degrees of hue travel from start to full progress.
            HUE_BEND: 36,

            // Both modes are the SAME journey from different poles of the
            // HSB cone, exact mirrors: light starts at pure white, dark
            // starts at pure black. Dark's brightness must RISE with
            // saturation - full saturation at black is mathematically
            // colourful but visually mud; 0.70 lands at jewel-tone
            // vividness without becoming a flashlight in a dark room.
            LIGHT_ANCHOR: { START_S: 0, START_B: 1.00, END_S: 1, END_B: 1.00 },
            DARK_ANCHOR:  { START_S: 0, START_B: 0.00, END_S: 1, END_B: 0.70 },

            // Streak -> progress curve: p = 1 - CURVE_RATE^streak.
            // 0.74: ~70% at streak 4, ~91% at 8, 99.2% at 16, and
            // asymptotically approaches - never reaches - 100%.
            CURVE_RATE: 0.74,

            // Role -> WCAG contrast ratio against the current background.
            // Every element's colour is SOLVED to its ratio at the current
            // hue, so the visual hierarchy holds on every colour the ramp
            // can produce. Per-mode targets, each calibrated from the
            // corresponding original hand-tuned grey theme - dark UIs need
            // larger luminance gaps to feel perceptually equivalent (the
            // old dark ink measured 13:1 where the light ink measured 6.9:1).
            CONTRAST: {
                LIGHT: { INK: 6.9,  SCORE: 1.10, BEST: 1.22, BOUNDARY: 1.26, CELL2: 1.06 },
                DARK:  { INK: 13.0, SCORE: 1.34, BEST: 1.50, BOUNDARY: 1.89, CELL2: 1.34 },

                // Background luminance below which the solve direction
                // flips: elements become lighter tints instead of darker
                // shades (keeps deep hues legible; also what makes the whole
                // dark mode work without special cases).
                PIVOT_Y: 0.30
            },

            // In-flight colour transitions are POSITION-driven (they track
            // the ball's fall - see fate transit in game.js/palette.js).
            // DRAIN_MS covers the only timed case left: manual restart.
            DRAIN_MS: 1100
        },

        // NOTE: The static LIGHT/DARK theme objects are retired - every
        // colour in both modes now derives from the Palette (ramp position +
        // per-mode contrast solving). The original hand-tuned values live on
        // as the calibration sources documented in RAMP.CONTRAST above.

        // NOTE: PREDICTION_LINE is no longer a fixed colour - it derives
        // from the theme's ink (see palette.js), drawn at PREDICTION_ALPHA.
    }
};

/**
 * Debug logger - no-ops unless CONFIG.DEBUG is true.
 * Defined here rather than core.js because config.js loads before every
 * gameplay script, guaranteeing dbg() exists wherever it's called.
 */
function dbg() {
    if (CONFIG.DEBUG) console.log.apply(console, arguments);
}