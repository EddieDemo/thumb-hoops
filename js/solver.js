// File: js/solver.js
// The level oracle: measures a hoop placement's SOLUTION DENSITY - the
// fraction of the sampled shot space that scores - by sweeping launch
// positions x angles x powers through the REAL physics
// (PhysicsEngine.simulateTrajectory) and applying the REAL rules (downward
// crossing between the posts scores; an upward crossing between them is a
// sticky cylinder violation) to every trajectory.
//
// Because prediction is bit-exact with reality by construction, this isn't
// an estimate of difficulty - it IS difficulty, measured. Density is also
// scale-invariant (all physics derives uniformly from cellRes), so results
// are cached per grid placement for the whole session.
//
// TODAY: placement selection targets the median density among sampled
// candidates - blind randomness is replaced by "never degenerate".
// ITEM #7 HOOK: replace the median pick with a streak->density-band target
// and the difficulty arc arrives through this single seam.
'use strict';

var Solver = (function() {

    /**
     * HUMAN HIT-RATE TABLE (baked; regenerate under the covenant in
     * config.js). Key 'gx,gy,width' -> probability that a player with the
     * measured error model scores, playing the best route available from
     * wherever the ball happens to be. This replaced solution density as
     * the difficulty metric: density graded the geometry, this grades the
     * shot. Generated 2026-07-25 from a 20-throw capture, POWER_EXPONENT
     * 0.7, propagated through the real PhysicsEngine.
     */
    const HIT_RATE = {
        '0,2,2':0.770, '0,2,3':0.903, '0,3,2':0.777, '0,3,3':0.916,
        '0,4,2':0.815, '0,4,3':0.932, '0,5,2':0.855, '0,5,3':0.963,
        '1,2,2':0.617, '1,2,3':0.820, '1,3,2':0.667, '1,3,3':0.852,
        '1,4,2':0.734, '1,4,3':0.861, '1,5,2':0.776, '1,5,3':0.916,
        '2,2,2':0.617, '2,2,3':0.831, '2,3,2':0.659, '2,3,3':0.870,
        '2,4,2':0.709, '2,4,3':0.893, '2,5,2':0.761, '2,5,3':0.934,
        '3,2,2':0.690, '3,3,2':0.719, '3,4,2':0.743, '3,5,2':0.819,
    };

    /** Graded difficulty of a placement: the player's odds, 0..1. */
    function rateFor(gx, gy, width) {
        const r = HIT_RATE[gx + ',' + gy + ',' + width];
        return (r === undefined) ? 0.5 : r; // Unknown geometry: mid-scale
    }


    const cache = {}; // placementKey -> density (session-lived)

    /**
     * Applies the game's scoring rules to one simulated trajectory.
     * Mirrors Ball.checkForWin + Game.updateFateTransit's violation rule
     * exactly: post-step positions, sticky invalidation.
     * @returns {boolean} True if this trajectory scores.
     */
    function trajectoryScores(points, startX, startY, hoopY, leftX, rightX) {
        let prevY = startY;
        let invalidated = false;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (prevY > hoopY && p.y <= hoopY) {
                // Upward crossing: between the posts = cylinder violation
                if (p.x > leftX && p.x < rightX) invalidated = true;
            } else if (prevY < hoopY && p.y >= hoopY) {
                // Downward crossing: between the posts = the basket
                if (!invalidated && p.x > leftX && p.x < rightX) return true;
            }
            prevY = p.y;
        }
        return false;
    }

    /**
     * Sweeps the shot space against a candidate hoop (already installed as
     * stub pegs in game.nodes by the caller) and returns solution density.
     */
    function measure(game, hoopY, leftX, rightX) {
        const cfg = CONFIG.GAME.SOLVER;
        const boardW = game.COLUMNS * game.cellRes;
        const boardH = game.ROWS * game.cellRes;
        const zoneTopY = (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes;
        const startY = (zoneTopY + boardH) / 2; // Mid shoot zone

        const maxDrag = boardH * CONFIG.PHYSICS.MAX_DRAG_HEIGHT_MULTIPLIER;
        const maxSpeed = maxDrag * CONFIG.PHYSICS.AIMING_SENSITIVITY_SCALE;

        let scored = 0, total = 0;
        for (let xi = 0; xi < cfg.START_POSITIONS; xi++) {
            const startX = ((xi + 0.5) / cfg.START_POSITIONS) * boardW;
            for (let ai = 0; ai < cfg.ANGLES; ai++) {
                // Upward half-plane, 15..165 degrees (committed shots are
                // upward by construction in both input schemes)
                const deg = 15 + 150 * (ai / (cfg.ANGLES - 1));
                const rad = deg * Math.PI / 180;
                const ux = Math.cos(rad), uy = -Math.sin(rad);
                for (let pi = 1; pi <= cfg.POWERS; pi++) {
                    const speed = maxSpeed * (pi / cfg.POWERS);
                    const launch = {
                        pixelX: startX, pixelY: startY,
                        velocity: { x: ux * speed, y: uy * speed },
                        radius: game.radius
                    };
                    const pts = game.physicsEngine.simulateTrajectory(launch, cfg.MAX_STEPS);
                    total++;
                    if (trajectoryScores(pts, startX, startY, hoopY, leftX, rightX)) scored++;
                }
            }
        }
        return scored / total;
    }

    /**
     * Density for a placement (gridX of left peg, gridY, width in cells),
     * cached for the session. Temporarily installs stub pegs so the real
     * simulation collides with the candidate hoop; the caller guarantees
     * game.nodes is safe to borrow (startHoopCycle has already cleared it).
     */
    function densityFor(game, gx, gy, width) {
        const key = game.COLUMNS + 'x' + game.ROWS + ':' + width + ':' + gx + ':' + gy;
        if (cache[key] !== undefined) return cache[key];

        const hoopY = gy * game.cellRes;
        const leftX = gx * game.cellRes;
        const rightX = (gx + width) * game.cellRes;
        const savedNodes = game.nodes;
        game.nodes = [
            { pixelX: leftX,  pixelY: hoopY, radius: game.nRadius },
            { pixelX: rightX, pixelY: hoopY, radius: game.nRadius }
        ];
        let d;
        try {
            d = measure(game, hoopY, leftX, rightX);
        } finally {
            game.nodes = savedNodes;
        }
        cache[key] = d;
        return d;
    }

    // ---------------- Background warm ----------------
    // There are only a few dozen legal placements on a board; grading one
    // takes ~10-100ms depending on device - far too much to spend at
    // round start, trivial to spend in idle time. warm() enqueues EVERY
    // legal placement and grades them through requestIdleCallback (or a
    // spaced setTimeout fallback), one per callback. Within seconds the
    // whole table is measured and every future round reads the cache for
    // free. Until then, choosePlacement gracefully uses whatever subset
    // is already graded.
    let warmed = false;

    function warm(game) {
        if (warmed) return;
        warmed = true;

        // Placement bounds: KEEP IN SYNC with Game.createHoop.
        const MINMAPY = 2;
        // Ceiling derives from the shoot zone: one-row buffer between the
        // lowest hoop and the line. KEEP IN SYNC with Game.createHoop.
        const MAXMAPY = game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS - 1;

        const jobs = [];
        for (const width of CONFIG.GAME.DIFFICULTY_LEVELS) {
            for (let gy = MINMAPY; gy < MAXMAPY; gy++) {
                for (let gx = 0; gx <= game.COLUMNS - 1 - width; gx++) {
                    jobs.push({ gx: gx, gy: gy, width: width });
                }
            }
        }
        dbg('Solver: warming ' + jobs.length + ' placements in idle time...');

        const schedule = (typeof window !== 'undefined' && window.requestIdleCallback)
            ? window.requestIdleCallback.bind(window)
            : (fn) => setTimeout(fn, 50);

        const step = () => {
            const job = jobs.shift();
            if (!job) { dbg('Solver: warm complete.'); return; }
            // Only grade while nodes are borrowable without racing a live
            // round's physics: densityFor swaps game.nodes in and out
            // synchronously, which is safe at ANY moment on the main
            // thread (JS is single-threaded; no frame runs mid-function).
            densityFor(game, job.gx, job.gy, job.width);
            schedule(step);
        };
        schedule(step);
    }

    /** Placement bounds - KEEP IN SYNC with Game.createHoop. */
    function allPlacements(game) {
        const MINMAPY = 2;
        // Ceiling derives from the shoot zone: one-row buffer between the
        // lowest hoop and the line. KEEP IN SYNC with Game.createHoop.
        const MAXMAPY = game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS - 1;
        const out = [];
        for (const width of CONFIG.GAME.DIFFICULTY_LEVELS) {
            for (let gy = MINMAPY; gy < MAXMAPY; gy++) {
                for (let gx = 0; gx <= game.COLUMNS - 1 - width; gx++) {
                    out.push({ gx: gx, gy: gy, width: width });
                }
            }
        }
        return out;
    }

    function keyOf(game, p) {
        return game.COLUMNS + 'x' + game.ROWS + ':' + p.width + ':' + p.gx + ':' + p.gy;
    }

    let lastPickedKey = null; // Anti-repeat WITHIN an attempt (see newAttempt)

    /**
     * Called at every streak reset: clears the within-attempt anti-repeat
     * memory so rung 0 of every attempt on a seed is chosen identically -
     * the identical-ladder guarantee must not be biased by how the
     * PREVIOUS attempt happened to end.
     */
    function newAttempt() {
        lastPickedKey = null;
    }

    /**
     * THE STREAK-DIFFICULTY ARC, seeded and fully deterministic. Round k
     * of court S is a pure function of (S, k):
     *   - The candidate sample comes from a per-round generator,
     *     RNG.create(seed + ':round:' + streak), shuffling the FIXED
     *     placement list - no dependence on cache temperature.
     *   - Densities are memoised pure values: any sampled placement not
     *     yet in the cache is computed synchronously (bounded by SAMPLE;
     *     the background warm makes this rare after the first seconds).
     *   - Band anchors are fixed constants (see config) - identical
     *     targets on every device.
     *   q = 1 - STREAK_CURVE_RATE^streak; target = easy + (hard-easy)*q.
     * The previous rung's hoop is excluded (no back-to-back repeats
     * WITHIN an attempt; newAttempt() clears the memory so every
     * attempt's rung 0 is identical).
     * @returns {{gx:number, gy:number, width:number}}
     */
    /** The pure selection core: no state reads beyond the given lastKey,
     *  no state writes. Round k of court S remains a pure fn of (S, k). */
    function selectForStreak(game, streak, lastKey) {
        // No warming: the hit-rate table is baked, so grading is instant
        // and identical on every device at every cache temperature.
        const cfg = CONFIG.GAME.SOLVER;

        // Seeded per-round shuffle of the FIXED pool
        const pool = allPlacements(game);
        const rng = RNG.create(game.courtSeed + ':round:' + streak);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }

        // Take the sample (skipping the previous rung's hoop), ensuring
        // each sampled placement's density exists - computing on the spot
        // if the warm hasn't reached it yet.
        const sampled = [];
        for (const p of pool) {
            if (sampled.length >= cfg.SAMPLE) break;
            if (keyOf(game, p) === lastKey) continue;
            sampled.push({ p: p, density: rateFor(p.gx, p.gy, p.width) });
        }

        // The rung's target is a HIT RATE: rung 0 is a shot you should
        // make, deep rungs are shots you can make. (The field is still
        // named 'density' downstream; it now carries the player's odds.)
        const q = streak <= 0 ? 0 : 1 - Math.pow(cfg.STREAK_CURVE_RATE, streak);
        const target = cfg.EASY_HITRATE + (cfg.HARD_HITRATE - cfg.EASY_HITRATE) * q;

        let pick = sampled[0];
        for (const g of sampled) {
            if (Math.abs(g.density - target) < Math.abs(pick.density - target)) pick = g;
        }
        return pick;
    }

    /** What would rung 0 of a FRESH attempt deal? Pure - no state writes.
     *  (Used by the hold-the-world rule: a level-1 miss whose redraw is
     *  identical keeps the court standing.) */
    function peekFirstRung(game) {
        const pick = selectForStreak(game, 0, null);
        return pick ? pick.p : null;
    }

    function choosePlacementForStreak(game, streak) {
        const pick = selectForStreak(game, streak, lastPickedKey);
        lastPickedKey = keyOf(game, pick.p);
        dbg('Solver: [' + game.courtSeed + '] rung ' + streak +
            ' -> (' + pick.p.gx + ',' + pick.p.gy + ') w' + pick.p.width +
            ' d=' + pick.density.toFixed(3));
        return pick.p;
    }

    return {
        choosePlacementForStreak: choosePlacementForStreak,
        rateFor: rateFor,
        peekFirstRung: peekFirstRung,
        newAttempt: newAttempt,
        densityFor: densityFor, // Exposed for tooling and the writeup's data
        warm: warm
    };
})();