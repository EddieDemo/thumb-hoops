// File: js/config.js
'use strict';

// Global Configuration Object
// Use 'var' for broader compatibility without modules
var CONFIG = {
    // Displayed bottom-left on the court and in the page title - bump on
    // every deploy so a cached stale build is instantly recognisable.
    VERSION: 'v46',

    // Master debug switch: gates all dbg() logging across the codebase.
    // console.warn/error always fire regardless - real problems must surface.
    DEBUG: false,

    GRID: {
        // MOBILE-FIRST grid. 6x11 keeps the board full-bleed on modern phone
        // viewports while making cells ~45% larger than the original 9x16
        // on a typical 390px-wide phone - and because EVERYTHING derives
        // from cellRes (ball, pegs, hoop, fonts, physics speeds, haptic
        // scaling), the entire game resizes coherently from these two
        // numbers. Consequences owned: fewer columns = wall bounces matter
        // more, slightly less hoop-placement variety, and DIFFICULTY_LEVELS
        // are proportionally more generous (2/7 vs the old 2/9).
        COLUMNS: 6,
        ROWS: 11
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
        // RADIUS_SCALE is DERIVED below the CONFIG literal - see the
        // dimensional identity note there. Do not add a literal here.

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

    INPUT: {
        // 'drag'  = aim by dragging: direction/power from start->current
        //           vector, held and adjustable, release above the line
        //           commits (the shipping scheme).
        // 'flick' = pick the ball up and THROW it: the ball follows the
        //           thumb; release velocity (sampled from the gesture's
        //           last moments) becomes launch velocity; a slow release
        //           sets the ball down (abort). EXPERIMENT - judge at
        //           streak 6+, not first-minute delight.
        // The shipped scheme. Drag remains fully implemented behind this
        // switch (nothing was removed) - flip back to 'drag' to play it.
        SCHEME: 'flick',

        // Testing affordance: a small label top-left showing the active
        // scheme; tapping it restarts the run and switches scheme
        // (persisted). OFF for public builds and tester links - and while
        // it is off, SCHEME is authoritative: any previously persisted
        // choice is ignored, so nobody can be stranded in a scheme with no
        // visible way back.
        SHOW_SCHEME_TOGGLE: false,

        FLICK: {
            SAMPLE_WINDOW_MS: 80,   // Gesture window sampled for velocity
            VELOCITY_SCALE: 1.0,    // Gesture px/ms -> launch scaling knob
            // Carry is clamped to the shoot zone: you can't walk the ball
            // up the court and drop it in - every throw starts below the
            // line, so every committed shot is upward, like drag.
            CLAMP_TO_ZONE: true,
            // --- Gesture gain curve ---
            // out = in * (1 + (BOOST-1) * min(1, speed/REF)): gain ~1 at
            // low speeds (lob precision untouched), rising to BOOST at
            // REF. BOOST = 1.0 is EXACTLY linear - the knob's floor is
            // the off switch.
            GAIN_BOOST: 1, //1.35 (previous)

            // --- Power compression (precision aid) ---
            // out = REF * (in/REF)^POWER_EXPONENT. The mapping is IDENTITY
            // at REF, so normal-strength throws feel unchanged; deviations
            // are pulled toward it, so a given % of gesture error becomes
            // POWER_EXPONENT x that % of throw error. Measured on 20 real
            // throws: exponent 0.7 lifts hit rate ~54% -> 60%, 0.5 -> 69%.
            // The game only demands a 1.68x power range, so there is ample
            // headroom. POWER_EXPONENT: 1.0 is EXACTLY linear (off switch).
            // COVENANT: changing this changes measured difficulty - the
            // solver's hit-rate table must be regenerated (see solver.js).
            POWER_EXPONENT: 0.7,
            POWER_REF: 30,   // px/step pivot - the throw that feels 'normal'
            GAIN_REF_SPEED: 40,   // px/step where full boost applies

            // Below this speed (px/step) on the floor, the ball sleeps -
            // resting, waiting to be picked up.
            REST_SPEED: 0.8,
            // Horizontal damping per step WHILE IN FLOOR CONTACT: light on
            // bounces (one contact step each), strong on rolling
            // (continuous contact) - real rolling resistance's shape.
            ROLLING_FRICTION: 0.96
        }
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

    // --- THE REPEATABILITY INSTRUMENT (debug; see js/capture.js) ---
    // ENABLED locks the hoop, turns the top-centre label into a REC
    // counter, and retains every gesture's raw samples for offline
    // estimator/window analysis. Tap the counter to export; C clears.
    CAPTURE: {
        // Off by default. Also enabled per-visit by the URL '?capture=1',
        // so testers get a special link while the live site stays normal
        // for everyone else - opt-in by construction, no background
        // collection, "no trackers" stays literally true.
        ENABLED: false,
        TARGET_THROWS: 25,   // A few spare for procedural fumbles
        RETAIN_MS: 400,      // Gesture history kept per throw (>> any window tested)

        // EVERY tester shoots this same hoop, or the sessions aren't
        // comparable. It is the placement from the 2026-07-25 session, so
        // that capture is part of the same dataset. Set to null to fall
        // back to "whatever the solver deals first".
        PLACEMENT: { gx: 1, gy: 5, width: 2 }
    },

    GAME: {
        // Hoop widths in cells. Width 4 was removed with the 6-column board:
        // its only two placements cram at least one side against a wall
        // (sometimes both), collapsing approach space - a nominally "easy"
        // hoop that's awkward to reach is a difficulty inversion. Width 2 =
        // exactly two ball-widths of clear aperture; width 3 = ~3.1.
        DIFFICULTY_LEVELS: [2, 3],
        // 4 rows: measured against thumb anatomy - the power stroke must
        // fit inside the zone (release-on-crossing samples speed AT the
        // line), and 3 rows (~3.5cm) amputated a natural 5-7cm flick.
        // Placement ceiling derives from this (one-row buffer above the
        // line) - changing it re-triggers the anchor covenant.
        SHOOT_AREA_ROWS: 4,       // Number of rows from bottom for shooting area
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
        // --- Solution-density solver (see js/solver.js) ---
        // Placement difficulty is MEASURED: candidate hoops are graded by
        // the fraction of the sampled shot space that scores, through the
        // real physics and rules. Sampling grid sizes trade precision for
        // per-round cost; densities are cached per placement per session.
        SOLVER: {
            ENABLED: true,
            START_POSITIONS: 5,  // Launch x positions across the zone
            ANGLES: 16,          // Launch directions (15..165 degrees)
            POWERS: 8,           // Launch speeds up to max drag power
            MAX_STEPS: 140,      // Per-trajectory simulation cap

            // --- The streak-difficulty arc ---
            // Each round targets a DENSITY BAND from the measured table:
            // streak 0 aims at the EASY anchor, deep streaks approach the
            // HARD anchor, along the same asymptotic curve family as the
            // colour system - the world hardens as it saturates. Width is
            // no longer rolled separately: it EMERGES from the band (wide
            // placements dominate the easy end, narrow the hard end).
            STREAK_CURVE_RATE: 0.85, // q = 1 - RATE^streak (~50% at 4, ~80% at 10)

            // Band anchors are HUMAN HIT RATES, not geometric density.
            // The old measure (fraction of shot space that scores) graded
            // the board; this one grades the PLAYER's odds, using an error
            // model calibrated from 20 captured throws (speed CV 16% x
            // POWER_EXPONENT, release angle sigma 3.8deg, release-x sigma
            // 0.305 cells) propagated through the real physics. The metric
            // is "typical play": the best route available from wherever
            // the ball happens to be, averaged over the zone - flick's
            // actual condition - NOT the perfect-positioning ceiling.
            // Fixed constants, because seeded courts must deal the same
            // ladder on every device. COVENANT: regenerate the table in
            // solver.js (and these anchors) if the grid, physics, rules,
            // POWER_EXPONENT or the error model change.
            // Measured 2026-07-25: table spans 62-96%.
            EASY_HITRATE: 0.88,   // rung 0 - a shot you should make
            HARD_HITRATE: 0.60,   // deep rungs - a shot you can make

            SAMPLE: 7                // Placements considered per round
                                     // (seeded shuffle; nearest to target wins)
        },

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
        // Shoot line width while an aim's release would ABORT (finger still
        // below the line): firmer, meaning "let go here and nothing fires".
        SHOOT_LINE_HELD_WIDTH: 2.5,
        // HOOP_LINE_WIDTH_SCALE: 1 / 15, // << COMMENTED OUT: Old relative scale
        HOOP_LINE_WIDTH: 1,     // << ADDED: Fixed hoop line width in pixels
        // TRIAL (mobile-first pass): the visible grid is INFORMATION, not
        // decoration - the lattice every size, speed, and drag distance is
        // measured in, made legible so players can calibrate aim and power
        // against it. Whisper-subtle by design (CELL2 contrast ~1.06:1
        // light / 1.34:1 dark, solved live against the current colour).
        DRAW_GRID: true, // <<< ADD THIS FLAG HERE (set true or false)
        // Blend the ball's rendered position between physics steps so motion
        // is smooth on displays faster than STEP_HZ (90/120/144Hz phones).
        // Rendering runs a fraction of one step behind the simulation -
        // imperceptible, and the simulation itself is never affected.
        INTERPOLATE: true,

        // DEBUG OVERRIDE: force the full prediction path on every shot,
        // ignoring the teaching wean. For development/tuning only.
        PREDICTION_PATH_ALWAYS: false,
        DRAW_TRAIL: true,           // Toggle for the ball's fading trail

        // --- Daily record separator: summit SEP2 cost, e.g. "14-9" ---
        // Pure typography - try '/' '\u00b7' etc on glass.
        RECORD_SEP2: '-',

        // --- Aim indicator (post-wean drag feedback) ---
        // A short readback of direction and power from the ball's edge
        // while aiming: NON-predictive (no physics - the teaching path is
        // the only oracle), just "the ball feels your grip". Hidden while
        // the release would abort (third subscriber to wouldReleaseAbort)
        // and during teaching shots (the full path already speaks).
        // The indicator speaks the game's existing motion language: the
        // flight trail (shrinking, fading circles) projected FORWARD. The
        // ball wears its past as a fading trail in flight; while aiming it
        // wears its future the same way - solid at the ball, dissolving
        // toward where it's going. Direction needs no arrow: things
        // dissolve AWAY from their source. Power stretches the dissolve.
        AIM: {
            MAX_LENGTH_CELLS: 2.2,    // Dissolve span at full power (cells)
            DOTS: 8,                  // Circles along the dissolve
            BASE_RADIUS_CELLS: 0.10,  // First circle's radius (at the ball)
            TAPER: 0.75,              // Radius lost across the span (0..1)
            EDGE_GAP_CELLS: 0.10,     // Gap between ball edge and first circle
            ALPHA: 0.6                // Starting opacity; fades to 0 at the tip
        },

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
            // Surface targets form an ORDERED LADDER per mode:
            //   cell2 < score < best < boundary, each rung perceptibly
            // separated, all in the whisper register. Ratios are NOT
            // perceptually uniform across registers (near black the WCAG
            // flare term makes equal ratios read far louder), hence the
            // dark ladder uses wider numeric spacing for similar optics.
            CONTRAST: {
                LIGHT: { INK: 6.9,  SCORE: 1.14, BEST: 1.24, BOUNDARY: 1.30, CELL2: 1.028 },
                DARK:  { INK: 13.0, SCORE: 1.45, BEST: 1.70, BOUNDARY: 2.00, CELL2: 1.05 },

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

// --- Derived dimensional identity ---
// Ball diameter = one cell MINUS one peg radius. Consequences, by design:
//   - The hardest hoop's clear aperture (2 cells - 2 peg radii) is EXACTLY
//     two ball-widths.
//   - A peg one cell from a wall leaves the ball a perfect-tangency passage
//     (a precision myth, not a route: threadable only in the limit), ending
//     the wall-vs-peg constraint fight that caused clipping jitter.
//   - The peg radius is the system's single unit of tolerance (it already
//     defines the fate transit's honesty line as ballR + pegR).
// Derived, not hardcoded, so the identity survives any future peg tuning.
CONFIG.PHYSICS.RADIUS_SCALE = (1 - CONFIG.PHYSICS.NRADIUS_SCALE) / 2;

/**
 * Debug logger - no-ops unless CONFIG.DEBUG is true.
 * Defined here rather than core.js because config.js loads before every
 * gameplay script, guaranteeing dbg() exists wherever it's called.
 */
function dbg() {
    if (CONFIG.DEBUG) console.log.apply(console, arguments);
}