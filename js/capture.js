// File: js/capture.js
'use strict';

/**
 * THE REPEATABILITY INSTRUMENT (debug-gated, off by default).
 *
 * Flip CONFIG.CAPTURE.ENABLED to record a session of deliberately-
 * identical throws at a LOCKED hoop, retaining each gesture's RAW sample
 * stream - not just the release vector - so that estimator variants
 * (endpoint / least-squares / recency-weighted / robust) AND window
 * lengths can all be replayed offline against the same real thumb-reps.
 *
 * The analysis it feeds: the scatter of release vectors, pushed through
 * simulateTrajectory, expressed as landing spread at hoop height in
 * ball-widths against the aperture. Either flick is viable as-is, or the
 * same numbers ARE the fair-geometry spec.
 *
 * Nothing here runs when disabled: every hook is a guarded no-op, and the
 * shipping input path is untouched.
 */
var Capture = (function() {

    const KEY = 'captureLog';

    let log = [];        // Completed throws (persisted after each one)
    let pending = null;  // The throw between release and outcome
    let locked = null;   // The session's fixed placement
    let loaded = false;

    function enabled() {
        return !!(typeof CONFIG !== 'undefined' && CONFIG.CAPTURE && CONFIG.CAPTURE.ENABLED);
    }

    function ensureLoaded() {
        if (loaded) return;
        loaded = true;
        const stored = Persistence.load(KEY, null);
        if (stored && Array.isArray(stored.throws)) {
            log = stored.throws;
            locked = stored.locked || null;
        }
    }

    function persist() {
        Persistence.save(KEY, { throws: log, locked: locked });
    }

    /** How many complete attempts are banked, and the session's goal. */
    function count() { ensureLoaded(); return log.length; }
    function target() { return CONFIG.CAPTURE.TARGET_THROWS; }

    /**
     * The session's hoop never moves: "twenty identical throws" only means
     * something against a fixed target. The first placement the solver
     * deals becomes the lock for the whole session (persisted, so a reload
     * mid-session resumes the same target).
     */
    function lockedPlacement() { ensureLoaded(); return locked; }
    function lockPlacement(placed) {
        ensureLoaded();
        if (!locked && placed) {
            locked = { gx: placed.gx, gy: placed.gy, width: placed.width };
            persist();
        }
        return locked;
    }

    /**
     * A release happened: open a record holding the gesture's full retained
     * sample stream and the velocity the estimator produced from it.
     * Times are stored relative to the gesture's first sample (compact,
     * and absolute clock values carry no information offline).
     */
    function recordRelease(game, samples, v, ball) {
        if (!enabled()) return;
        ensureLoaded();
        if (!samples || samples.length === 0) { pending = null; return; }
        const t0 = samples[0].t;
        pending = {
            i: log.length + 1,
            samples: samples.map(s => [
                Math.round(s.x * 100) / 100,
                Math.round(s.y * 100) / 100,
                Math.round((s.t - t0) * 100) / 100
            ]),
            release: {
                t: Math.round((samples[samples.length - 1].t - t0) * 100) / 100,
                x: Math.round(ball.pixelX * 100) / 100,
                y: Math.round(ball.pixelY * 100) / 100,
                vx: Math.round(v.x * 10000) / 10000,
                vy: Math.round(v.y * 10000) / 10000
            },
            promoted: false,
            scored: null
        };
    }

    /** The ball's centre left the zone: this release was a real attempt. */
    function markPromoted() {
        if (!enabled() || !pending) return;
        pending.promoted = true;
    }

    /**
     * The attempt resolved. Only PROMOTED releases are banked - dribbles,
     * drops and set-downs are not throws and would pollute the scatter.
     */
    function finish(scored) {
        if (!enabled() || !pending) return;
        if (!pending.promoted) { pending = null; return; }
        pending.scored = !!scored;
        log.push(pending);
        pending = null;
        persist();
        dbg('Capture: banked throw ' + log.length + '/' + target());
    }

    /** Everything the offline analysis needs to reconstruct this session. */
    function buildPayload(game) {
        ensureLoaded();
        const hoop = game.lines[0];
        return {
            schema: 1,
            version: CONFIG.VERSION,
            recorded: new Date().toISOString(),
            device: {
                ua: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
                dpr: window.devicePixelRatio || 1,
                rawUpdate: ('onpointerrawupdate' in window),
                coalesced: (typeof PointerEvent !== 'undefined' &&
                            PointerEvent.prototype.getCoalescedEvents !== undefined),
                clock: (typeof inputHandler !== 'undefined' && inputHandler._eventClockOk) ? 'hardware' : 'performance'
            },
            geometry: {
                columns: game.COLUMNS, rows: game.ROWS,
                cellRes: game.cellRes,
                shootAreaRows: CONFIG.GAME.SHOOT_AREA_ROWS,
                shootLineY: (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes,
                ballRadius: game.radius, pegRadius: game.nRadius,
                gravity: game.gravity, stepHz: CONFIG.PHYSICS.STEP_HZ,
                wallRestitution: CONFIG.PHYSICS.WALL_RESTITUTION,
                pegRestitution: CONFIG.PHYSICS.PEG_RESTITUTION
            },
            hoop: locked ? {
                gx: locked.gx, gy: locked.gy, width: locked.width,
                x1: hoop ? hoop.node1.pixelX : null,
                x2: hoop ? hoop.node2.pixelX : null,
                y: hoop ? hoop.node1.pixelY : null,
                apertureBallWidths: hoop
                    ? (Math.abs(hoop.node2.pixelX - hoop.node1.pixelX) - 2 * game.nRadius) / (2 * game.radius)
                    : null
            } : null,
            estimator: {
                sampleWindowMs: CONFIG.INPUT.FLICK.SAMPLE_WINDOW_MS,
                retainMs: CONFIG.CAPTURE.RETAIN_MS,
                velocityScale: CONFIG.INPUT.FLICK.VELOCITY_SCALE,
                gainBoost: CONFIG.INPUT.FLICK.GAIN_BOOST,
                gainRefSpeed: CONFIG.INPUT.FLICK.GAIN_REF_SPEED,
                method: 'least-squares'
            },
            throws: log
        };
    }

    /**
     * Get the session off the phone. iOS needs a user gesture for the
     * share sheet, which is why this is tap-driven: share sheet first
     * (AirDrop straight to a desktop), then a file download, then the
     * clipboard as a last resort.
     */
    function exportSession(game) {
        ensureLoaded();
        const json = JSON.stringify(buildPayload(game));
        const name = 'thumb-hoops-capture-' + CONFIG.VERSION + '-' +
            new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json';
        try {
            const file = new File([json], name, { type: 'application/json' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                navigator.share({ files: [file], title: 'Thumb-Hoops capture' })
                    .catch(() => downloadFallback(json, name));
                return 'share';
            }
        } catch (e) { /* File/share unsupported - fall through */ }
        return downloadFallback(json, name);
    }

    function downloadFallback(json, name) {
        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            return 'download';
        } catch (e) {
            try {
                navigator.clipboard.writeText(json);
                return 'clipboard';
            } catch (e2) {
                console.warn('Capture: no export route available.', e2);
                return 'failed';
            }
        }
    }

    /** Wipe the session (C key) - a fresh twenty starts here. */
    function reset() {
        ensureLoaded();
        log = []; pending = null; locked = null;
        persist();
        dbg('Capture: session cleared.');
    }

    return {
        enabled: enabled,
        count: count,
        target: target,
        lockedPlacement: lockedPlacement,
        lockPlacement: lockPlacement,
        recordRelease: recordRelease,
        markPromoted: markPromoted,
        finish: finish,
        exportSession: exportSession,
        reset: reset
    };
})();