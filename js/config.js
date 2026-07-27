// File: js/config.js
'use strict';

// Global Configuration Object
// Use 'var' for broader compatibility without modules
var CONFIG = {
    // Displayed bottom-left on the court and in the page title - bump on
    // every deploy so a cached stale build is instantly recognisable.
    VERSION: 'v57',

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

            // DEVICE NEUTRALITY. The simulation is scale-similar (gravity,
            // radii and speeds all scale with cellRes), but the gesture
            // arrives in screen pixels - so without this the same physical
            // flick travels FEWER CELLS on a bigger board, and the game is
            // harder on large phones than small ones. Ruinous for a shared
            // daily court. Every px/step figure below is therefore quoted
            // at this reference cell size and scaled by cellRes/REFERENCE
            // at use, which makes a given thumb movement produce the same
            // trajectory everywhere. 58.3 is the geometry the feel was
            // tuned and captured at.
            REFERENCE_CELL: 58.3,
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

    // --- THE COURT'S GAMELAN (see js/audio.js) ---
    // Bronze borrowed from the Slendro project. Slendro's five even
    // 240-cent steps have no acoustically-home tone, so the arbitrary
    // note sequences a physics game produces are always consonant -
    // which is the property that makes this possible at all.
    AUDIO: {
        ENABLED: true,
        MASTER: 0.45,

        // Sound is enrichment, never information: most phones are muted,
        // and everything the bronze says the screen already said.

        STEP_CENTS: 240,     // sléndro: five even steps to the octave
        PEG_HZ: 264,         // the lowest peg (lattice intersection 0)
        PEG_DECAY_S: 1.6,    // shorter than a real bonang: the court must clear
        PEG_GAIN: 0.9,
        // THE BASKET is a pluck at the hoop - a string, so the game's most
        // important event is the one thing that doesn't sound like struck
        // metal. It climbs: each basket takes the next rung, wrapping an
        // octave every five, so a run is audibly a rising line.
        STRING_HZ: 330,
        STRING_DECAY_S: 1.4,
        STRING_GAIN: 0.8,
        STRING_MAX_OCT: 2,   // beyond this the ladder cycles in the top octave
                             // rather than climbing into a shriek

        // THE GONG closes the gongan - and a run's cycle ends when it is
        // LOST, not when it is extended. It sounds on the miss, as the ball
        // settles, just behind the floor's own thud.
        GONG_HZ: 66,
        GONG_DECAY_S: 2.6,
        GONG_GAIN: 0.85,
        GONG_LAG_MS: 16,        // two players are never in perfect unison...
        GONG_LAG_JITTER_MS: 12, // ...and a FIXED offset reads as an echo,
                                // where a varying one reads as two people
        GONG_MIN_STREAK: 1,     // a cycle that never started needs no closing:
                                // grinding rung 0 gets the thud, not the gong

        // The world's edges: an octave below the pegs, softly struck, and
        // much quieter. The walls carry the ladder VERTICALLY (low at the
        // floor, rising as the ball climbs), so between them and the pegs
        // the whole lattice is playable. The floor does not: it is the
        // ground, one pitch, and since it fires more than anything else
        // in the game it is the quietest thing here.
        LOW_HZ: 132,
        LOW_DECAY_S: 1.2,    // shorter than the pegs: thuds must not pile up
        WALL_GAIN: 0.42,
        FLOOR_GAIN: 0.30,
        WALL_RUNGS: 5,       // the board's height spread across this many tones,
                             // all within one octave so the walls stay under
                             // the pegs' lowest note (132-230Hz vs 264Hz)

        // Contact speed in CELLS per step, so feel is screen-independent.
        MIN_IMPACT: 0.035,   // below this a graze stays silent
        FULL_IMPACT: 0.55,   // and at this it strikes at full velocity

        // The edges need higher floors than the pegs: a ball rolling on
        // the ground technically re-contacts every step, and a settling
        // bounce trails off into dozens of tiny taps. Only real arrivals
        // should speak.
        MIN_IMPACT_LOW: 0.06,
        MIN_IMPACT_FLOOR: 0.10,
        MIN_INTERVAL_LOW_MS: 55,

        // A rattle is several contacts inside a few frames. Bronze
        // partials overlapping is what a gamelan IS; stacked ATTACKS are
        // what turns it into a dropped tray. Hence a floor on spacing and
        // a ceiling on how much can ring at once.
        MIN_INTERVAL_MS: 18,
        MAX_VOICES: 10,      // beyond this the oldest voice is stolen, not refused

        RENDER_RATE_HZ: 22050  // offline render rate for the cast buffers
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
        // --- GHOST BALL: the wordless "it comes down through here" ---
        // A ball-sized ghost hovering above the rim, dwelling high and
        // dipping toward it (parabolic, so it hangs at the top like a real
        // ball at apex), with a short fall of dots closing the gap. Enters
        // last in the hoop's choreography and leaves with the pegs.
        // Scaffolding dissolves: shown only while the streak is below
        // SHOW_WHILE_STREAK_BELOW (1 = level one only, 0 = never).
        GHOST_BALL: {
            ENABLED: true,
            SHOW_WHILE_STREAK_BELOW: 1,
            // 'chevron' (bare v) | 'stem' (v with a shaft) |
            // 'triangle' (filled) | 'double' (two chevrons, trailing fainter)
            STYLE: 'chevron',
            // Deliberately below full ink: in this world full ink means
            // MATTER (ball, pegs, hoop line - things with collision). The
            // chevron is a hint, not a thing, so it sits in the lighter
            // register the trail and prediction path use. 1.0 = exactly
            // the ball's colour, if that reading is ever preferred.
            ALPHA: 0.45,          // at the top of the bob; firms as it dips
            WIDTH: 0.15,          // half-width, cells
            HEIGHT: 0.17,         // tip to shoulders, cells
            // Stroke weight is DERIVED from the hoop line rather than
            // duplicated, so the arrow keeps speaking the board's language
            // if that weight is ever retuned. (The boundary is stroked on
            // the canvas edge, so only half its 2px shows - the same 1px.)
            // Measured tip-to-rim. The dip closes to one node DIAMETER
            // (2 x NRADIUS_SCALE = 0.20 cells) - near enough to read as
            // "into here" without touching the line. Same amplitude as
            // before (0.43 cells), translated down.
            GAP_TOP: 0.63,        // cells above the rim, top of the bob
            GAP_LOW: 0.20,        // cells above the rim, bottom of the dip
            PERIOD_MS: 1400,
            ENTRY_DELAY_MS: 120   // after the hoop line finishes drawing
        },

        // How much SKY must remain above the highest hoop (row 2), in cells.
        // This is the real constraint - expressed directly rather than as a
        // row count, because it is what decides whether the board can fill
        // the viewport's width. Filling the width is what removes the side
        // margins; the board only shrinks (reintroducing them) when a
        // viewport is too short to grant this clearance.
        //   required rows = ROWS - 2 + HOOP_SKY_CELLS
        //   0.0 slices the top hoop's pegs in half - never go there
        //   0.5 clears them by ~2.5 node diameters and lets every common
        //       phone aspect (>= 1.58) fill the width
        //   1.0 is roomier but pushes the threshold to 1.67, which iPhone
        //       Safari (1.63) just misses - that was the 4px margin
        HOOP_SKY_CELLS: 0.5,

        // The court's edge used to be drawn as a stroke around the whole
        // board. It isn't needed any more: vertically the checkerboard
        // surround continues seamlessly past the floor and sky (there is
        // no edge to announce), and horizontally the walls now declare
        // themselves by what lies beyond them - a flat inverse field.
        DRAW_BOUNDARY: false,

        // Beyond the side walls: the tonal opposite of the mode, so the
        // court reads as lit space and everything outside it as solid
        // nothing. Only ever visible when the viewport is wider than the
        // board (desktop, tablets); phones fill the width and see none of
        // it. Above and below the court the checkerboard continues as
        // before - the world extends vertically, but ends at the walls.
        SIDE_FILL_LIGHT: '#000000',   // shown while the game is in LIGHT mode
        SIDE_FILL_DARK:  '#ffffff',   // shown while the game is in DARK mode

        // --- The level numeral's turn-over ---
        // The numeral belongs to the ROUND, not to the live score: it holds
        // the level you're attempting until the world actually changes,
        // then squashes out horizontally (riding the pegs' own exit signal,
        // so it leaves at exactly their rate) and the new value opens back
        // out the same way. Split-flap, in the hoop line's own vocabulary -
        // that line already grows out of its pegs and retracts into them.
        // No overshoot: entry mirrors exit.
        SCORE_NUMERAL: {
            ANIMATE: true,
            ENTRY_MS: 200,   // Matches MOTION.PEG_POP_MS by default

            SIZE_CELLS: 4,   // Cap height in cells (was 2)

            // Transparency is a REQUEST, not a colour. The numeral's
            // on-screen appearance is still solved to the theme's SCORE
            // contrast target (as every other element is), and the base
            // colour is back-solved so that drawing it at this alpha
            // composites to exactly that. So ALPHA controls only how much
            // checkerboard shows through - never whether the number can be
            // seen. Where the gamut can't reach the target at this alpha
            // (saturated backgrounds in dark mode), the renderer raises
            // alpha to the least value that can: legibility wins.
            ALPHA: 0.12
        },

        GRID_LINE_WIDTH: 0.5,     // Fixed grid line width
        BOUNDARY_LINE_WIDTH: 2,
        SHOOT_LINE_WIDTH: 1,
        // Shoot line width while an aim's release would ABORT (finger still
        // below the line): firmer, meaning "let go here and nothing fires".
        SHOOT_LINE_HELD_WIDTH: 2.5,

        // The shoot boundary is drawn as DOTS at the grid intersections on
        // its row, not as a rule across the board: the lattice already
        // knows where that line is, so marking its crossings states the
        // boundary in the world's own vocabulary instead of laying a
        // foreign stroke over it. Radii in cells; the held size is the
        // line's old "you're still in your own territory" firming, now
        // expressed as weight rather than thickness. Pegs are 0.10 cells,
        // so these stay clearly lighter than matter.
        SHOOT_DOT_RADIUS: 0.035,
        SHOOT_DOT_RADIUS_HELD: 0.055,
        // Spacing and inset in cells: dots run from INSET to COLUMNS-INSET
        // in STEP increments. At 0.5/1 that marks every half-cell across
        // the middle four columns and leaves the wall-adjacent cells bare,
        // so the boundary reads as a measure laid across the court rather
        // than a rule welded to the walls. (6 columns -> 9 dots.)
        SHOOT_DOT_STEP: 0.5,
        SHOOT_DOT_INSET: 1,
        // HOOP_LINE_WIDTH_SCALE: 1 / 15, // << COMMENTED OUT: Old relative scale
        HOOP_LINE_WIDTH: 1,     // << ADDED: Fixed hoop line width in pixels
        // TRIAL (mobile-first pass): the visible grid is INFORMATION, not
        // decoration - the lattice every size, speed, and drag distance is
        // measured in, made legible so players can calibrate aim and power
        // against it. Whisper-subtle by design (CELL2 contrast ~1.06:1
        // light / 1.34:1 dark, solved live against the current colour).
        // The checkerboard. OFF gives a plain field in the theme's own
        // background colour - the court and the surround beyond it both
        // fall back together, so the world stays seamless either way.
        // (With it off the level numeral's transparency has nothing to
        // show through, so it simply reads as its solved colour.)
        DRAW_GRID: false,

        // --- FONT TRIAL (temporary) ---
        // Candidates for the display face, cyclable on device: tap the
        // top-left corner to step through them (persisted, so a reload
        // keeps your place). The name is drawn where the scheme toggle
        // used to live. Set SHOW_FONT_CYCLER false to retire the trial;
        // the winner then gets self-hosted in the craft pass and this list
        // collapses to one entry.
        SHOW_FONT_CYCLER: true,
        FONTS: [
            { label: 'PLEX',    family: "'IBM Plex Mono'" },
            { label: 'MARTIAN', family: "'Martian Mono'" },
            { label: 'GEIST',   family: "'Geist Mono'" },
            { label: 'DM',      family: "'DM Mono'" },
            { label: 'JETBR',   family: "'JetBrains Mono'" },
            { label: 'SPACE',   family: "'Space Mono'" },
            { label: 'IOSEVKA', family: "'Iosevka'" },
            { label: 'SYSTEM',  family: 'ui-monospace, monospace' }
        ],
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