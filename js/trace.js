// File: js/trace.js
'use strict';

/**
 * THE FLIGHT RECORDER.
 *
 * A ring buffer of the last N physics steps, dumped to the console a few
 * steps AFTER a shot resolves - so the log contains the approach, the
 * moment itself, and what happened immediately afterwards. Without the
 * tail you see a verdict with no aftermath; without the head you see an
 * aftermath with no approach.
 *
 * SAMPLED ON THE FIXED STEP, not per rendered frame. Scoring is decided in
 * the simulation, so the log has to be the simulation's own record - the
 * numbers here are exactly the numbers the rule read.
 *
 * EVERYTHING IS IN CELLS. Pixels depend on the screen; cells do not. A
 * trace from a phone and a trace from a desktop can be compared line for
 * line, and the geometry can be reasoned about without knowing either one.
 *
 * Both post positions are given LIVE and at HOME, because the whole point
 * of most questions here is whether a post had moved and by how much.
 */
var Trace = (function() {

    let ring = [];
    let deadline = null;    // worldTime at which the dump prints
    let label = '';
    let armed = false;

    function cfg() { return CONFIG.TRACE || {}; }
    function on() { return !!cfg().ENABLED; }

    /** One row of the recorder, taken every fixed step. */
    function sample(game) {
        if (!on() || !game || !game.currentBall) return;
        const c = game.cellRes || 1;
        const b = game.currentBall;
        const h = game.lines && game.lines[0];
        const n1 = h && h.node1, n2 = h && h.node2;
        // Left/right by LIVE position, which is how the scoring test picks
        // them - so a post that has crossed its neighbour reads correctly.
        let L = n1, R = n2;
        if (n1 && n2 && n1.pixelX > n2.pixelX) { L = n2; R = n1; }

        ring.push({
            t: game.worldTime,
            state: game.currentState,
            bx: b.pixelX / c, by: b.pixelY / c,
            pby: b.prePixelY / c,
            vx: b.velocity ? b.velocity.x / c : 0,
            vy: b.velocity ? b.velocity.y / c : 0,
            lx: L ? L.pixelX / c : null, lhx: L ? L.homeX / c : null,
            rx: R ? R.pixelX / c : null, rhx: R ? R.homeX / c : null,
            ly: h ? h.scoringY / c : null,
            scored: !!game.hasScored,
            inval: !!game.roundInvalidated
        });
        const cap = (cfg().BEFORE_STEPS || 24) + (cfg().AFTER_STEPS || 12) + 4;
        while (ring.length > cap) ring.shift();

        if (deadline !== null && game.worldTime >= deadline) flush(game);
    }

    /**
     * Called once per rendered frame. The countdown CANNOT depend on
     * further simulation steps: a miss ends the round, the ball falls
     * asleep, the fixed-step loop stops - and a dump waiting on steps that
     * never come is a dump that never prints. So the deadline is in TIME,
     * and this is the guarantee that it is honoured.
     */
    function tick(game) {
        if (!on() || deadline === null || !game) return;
        if (game.worldTime >= deadline) flush(game);
    }

    /**
     * Something decided. Keep recording for AFTER_STEPS, then print.
     * Re-arming during a countdown is ignored: the first event owns the
     * dump, so a score followed by a bounce does not truncate its own tail.
     */
    function mark(game, what) {
        if (!on() || armed) return;
        armed = true;
        label = what;
        const hz = (CONFIG.PHYSICS && CONFIG.PHYSICS.STEP_HZ) || 60;
        deadline = game.worldTime + Math.max(1, cfg().AFTER_STEPS || 12) / hz;
    }

    function flush(game) {
        armed = false;
        deadline = null;
        const c = game.cellRes || 1;
        const h = game.lines && game.lines[0];
        const rows = ring.slice(-((cfg().BEFORE_STEPS || 24) + (cfg().AFTER_STEPS || 12)));
        const t0 = rows.length ? rows[rows.length - (cfg().AFTER_STEPS || 12)] : null;
        const base = t0 ? t0.t : (rows.length ? rows[0].t : 0);

        const head = [
            '',
            '=== THUMB-HOOPS TRACE: ' + label + ' ===',
            'version ' + CONFIG.VERSION + '   seed ' + game.courtSeed +
                '   level ' + (game.score + 1) + '   cellRes ' + (game.cellRes || 0).toFixed(1),
            // Derived from the POSTS, not from fields on the hoop - the
            // posts are what the rule reads, so they are what should be
            // reported. (An earlier version trusted hoop.gridX and printed
            // "undefined": a log that lies about the setup is worse than
            // one that omits it.)
            h ? ('posts home x ' + (h.node1.homeX / c).toFixed(3) + ' / ' + (h.node2.homeX / c).toFixed(3) +
                 '   gap ' + Math.abs((h.node2.homeX - h.node1.homeX) / c).toFixed(3) + ' cells' +
                 '   home y ' + (h.node1.homeY / c).toFixed(3)) : 'no hoop',
            'ball radius ' + ((game.radius || 0) / c).toFixed(3) + ' cells' +
                (game.godMode ? '   [GOD MODE]' : ''),
            '',
            ' step |  ball x  ball y  prevY |     vx      vy |  postL   (home)   postR   (home) |  lineY | flags',
            '------+------------------------+----------------+----------------------------------+--------+------'
        ].join('\n');

        const body = rows.map((r) => {
            const step = Math.round((r.t - base) / (1 / (CONFIG.PHYSICS.STEP_HZ || 60)));
            const f = [];
            if (r.scored) f.push('SCORED');
            if (r.inval) f.push('INVALIDATED');
            // The crossing itself, and which side of each post the ball was.
            if (r.ly !== null && r.pby < r.ly && r.by >= r.ly) {
                f.push('CROSSES-LINE');
                if (r.lx !== null && r.bx <= r.lx) f.push('outside-LEFT-post');
                else if (r.rx !== null && r.bx >= r.rx) f.push('outside-RIGHT-post');
                else f.push('between-posts');
            }
            if (r.lx !== null && Math.abs(r.lx - r.lhx) > 0.001) f.push('L-moved:' + (r.lx - r.lhx).toFixed(3));
            if (r.rx !== null && Math.abs(r.rx - r.rhx) > 0.001) f.push('R-moved:' + (r.rx - r.rhx).toFixed(3));
            const n = (v, w) => (v === null ? '   -  ' : v.toFixed(3)).padStart(w);
            return ' ' + String(step).padStart(4) + ' |' +
                n(r.bx, 8) + n(r.by, 8) + n(r.pby, 7) + ' |' +
                n(r.vx, 7) + n(r.vy, 8) + ' |' +
                n(r.lx, 7) + n(r.lhx, 9) + n(r.rx, 8) + n(r.rhx, 9) + ' |' +
                n(r.ly, 7) + ' | ' + f.join(' ');
        }).join('\n');

        // console.log directly, NOT dbg(): a trace is asked for explicitly
        // and would be useless if it were also gated behind debug logging.
        console.log(head + '\n' + body + '\n=== end of trace ===\n');
        ring = [];
    }

    return { sample: sample, mark: mark, tick: tick };
})();