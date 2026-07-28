// File: js/haptics.js
// Haptic feedback: thin, defensive wrapper over navigator.vibrate.
//
// SUPPORT REALITY: Android (Chrome, Samsung Internet, Edge) vibrates; iOS
// Safari has never implemented the API and silently won't; Firefox removed
// it at 129; desktops have no hardware. This module therefore treats
// vibration as pure enhancement - every call is safe everywhere, and the
// game must feel complete without it.
//
// THERE IS NO INTENSITY. navigator.vibrate takes DURATIONS - one number, or
// an array alternating buzz and pause - and nothing else. So impact
// strength is expressed as pulse LENGTH, which is the only axis the
// platform offers. A harder collision is not a stronger buzz; it is a
// longer one, and at these durations the difference reads as weight.
//
// THE iOS HACK, DELIBERATELY NOT USED: toggling an <input type="checkbox"
// switch> (Safari 17.4+) fires the Taptic Engine as a side effect, and
// libraries exist that abuse this for arbitrary web haptics. It is not here
// for two reasons. Apple patched the behaviour in iOS 26.5, so on current
// phones it does nothing; and a feature built on an unintended side effect
// is one OS release from silently dying. If haptics ever matter enough to
// chase, the honest answer is to wait for a real API.
//
// DESIGN: impact strength arrives in CELL UNITS per step (impact speed /
// cellRes), so haptic intensity is independent of screen size - the same
// shot feels the same on any phone.
'use strict';

var Haptics = (function() {

    const supported =
        typeof navigator !== 'undefined' &&
        typeof navigator.vibrate === 'function';

    // Rate limiter: during rim rattles many impacts arrive in quick
    // succession; back-to-back vibrate() calls cancel each other and read as
    // mush. Enforcing a minimum gap keeps each tick crisp and distinct.
    let lastPulseTime = -Infinity; // -Infinity: the first impact must never be rate-limited

    /**
     * Fires a single impact tick with duration proportional to impact
     * strength. Sub-threshold grazes are ignored (a ball settling against a
     * wall shouldn't buzz continuously).
     * @param {number} strength - Impact speed in cell units per step.
     */
    function impact(strength) {
        if (!supported || !CONFIG.HAPTICS.ENABLED) return;

        const cfg = CONFIG.HAPTICS;
        if (strength < cfg.MIN_IMPACT) return;

        const now = performance.now();
        if (now - lastPulseTime < cfg.MIN_GAP_MS) return;
        lastPulseTime = now;

        // Map [MIN_IMPACT .. REF_IMPACT] -> [MIN_MS .. MAX_MS], clamped.
        const t = Math.min(1, (strength - cfg.MIN_IMPACT) / (cfg.REF_IMPACT - cfg.MIN_IMPACT));
        const ms = Math.round(cfg.MIN_MS + t * (cfg.MAX_MS - cfg.MIN_MS));

        try { navigator.vibrate(ms); } catch (e) { /* never let feedback throw */ }
    }

    /**
     * Fires an explicit vibration pattern (for distinct events like scoring,
     * where a shaped pattern reads differently from an impact tick).
     * Bypasses the impact rate limiter but updates it, so a pattern isn't
     * immediately stepped on by a trailing impact tick.
     * @param {number|Array<number>} pattern - ms, or [on, off, on, ...] ms.
     */
    function pulse(pattern) {
        if (!supported || !CONFIG.HAPTICS.ENABLED) return;
        lastPulseTime = performance.now();
        try { navigator.vibrate(pattern); } catch (e) { /* never throw */ }
    }

    return {
        impact: impact,
        pulse: pulse,
        supported: supported
    };
})();