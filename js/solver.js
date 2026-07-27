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
        peekFirstRung: peekFirstRung,
        rateFor: rateFor,
        newAttempt: newAttempt
    };
})();