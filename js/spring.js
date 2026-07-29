// File: js/spring.js
'use strict';

/**
 * A DAMPED HARMONIC OSCILLATOR, solved rather than approximated.
 *
 *      x'' + 2*zeta*w*x' + w^2*x = 0        w = 2*pi*freqHz
 *
 * Between impulses nothing drives this system, so its exact solution is
 * known and the state after dt is a LINEAR MAP of the state before it:
 *
 *      [x']   [A B] [x]
 *      [v'] = [C D] [v]
 *
 * Four multiplies per axis per step, no integration error, and stable at
 * any dt or stiffness. A numerical integrator would need a small step to
 * stay accurate and could still drift; here the step size is free. The
 * coefficients depend only on (freq, zeta, dt), so they are computed once
 * and cached until one of those changes.
 *
 * ALL THREE DAMPING REGIMES are implemented - underdamped (zeta < 1,
 * overshoots), critical (zeta = 1, the fastest return without overshoot)
 * and overdamped (zeta > 1, sluggish). Not completeness for its own sake:
 * it means no value of the damping dial can produce a NaN, so the config
 * can be tuned freely without the tuner having to know where the maths
 * changes shape.
 *
 * PEAK-AWARE IMPULSES. An oscillator struck from rest with velocity v0
 * reaches a peak displacement of
 *
 *      x_peak = (v0 / w) * G(zeta)
 *
 * so impulseForPeak() inverts that. This is what lets a config say
 * "displace by 0.05 cells" and MEAN it, at any frequency or damping,
 * rather than expressing the wish as an opaque force constant.
 */
var Spring = (function() {

    let _cache = null;
    let _key = '';

    /** The 2x2 state-transition matrix for one step of dt seconds. */
    function coefficients(freqHz, zeta, dt) {
        const key = freqHz + '|' + zeta + '|' + dt;
        if (_key === key && _cache) return _cache;

        const w = 2 * Math.PI * freqHz;
        const s = Math.exp(-zeta * w * dt);
        let A, B, C, D;

        if (zeta < 0.999) {
            // Underdamped: rings, and overshoots on the way home.
            const wd = w * Math.sqrt(1 - zeta * zeta);
            const c = Math.cos(wd * dt), sn = Math.sin(wd * dt);
            A = s * (c + zeta * w * sn / wd);
            B = s * (sn / wd);
            C = -s * (w * w / wd) * sn;
            D = s * (c - zeta * w * sn / wd);
        } else if (zeta < 1.001) {
            // Critically damped: the limit of both branches. Taking it as a
            // case of either one divides by a vanishing wd.
            const t = dt;
            A = s * (1 + w * t);
            B = s * t;
            C = -s * w * w * t;
            D = s * (1 - w * t);
        } else {
            // Overdamped: no oscillation, just a slow return.
            const wh = w * Math.sqrt(zeta * zeta - 1);
            const ch = Math.cosh(wh * dt), sh = Math.sinh(wh * dt);
            A = s * (ch + zeta * w * sh / wh);
            B = s * (sh / wh);
            C = -s * (w * w / wh) * sh;
            D = s * (ch - zeta * w * sh / wh);
        }

        _cache = { A: A, B: B, C: C, D: D };
        _key = key;
        return _cache;
    }

    /**
     * G(zeta): the fraction of (v0 / w) that a from-rest impulse actually
     * reaches. Derived, not fitted - at the peak, tan(wd*t) = wd/(zeta*w),
     * which gives sin = sqrt(1-zeta^2) and collapses the expression to a
     * single exponential.
     */
    function peakGain(zeta) {
        if (zeta > 1.001) {
            // Overdamped. Same expression with atanh for atan - the peak
            // condition becomes tanh(u) = sqrt(zeta^2-1)/zeta, and the
            // algebra collapses identically.
            const q = Math.sqrt(zeta * zeta - 1);
            return Math.exp(-zeta * Math.atanh(q / zeta) / q);
        }
        if (zeta >= 0.999) return Math.exp(-1); // critical: the limit, 1/e
        const q = Math.sqrt(1 - zeta * zeta);
        return Math.exp(-zeta * Math.atan2(q, zeta) / q);
    }

    /** The impulse (velocity) whose peak displacement will be `peak`. */
    function impulseForPeak(peak, freqHz, zeta) {
        const w = 2 * Math.PI * freqHz;
        const g = peakGain(zeta);
        return (g > 1e-6) ? (peak * w / g) : 0;
    }

    /**
     * Advance one axis. `st` is {x, v}, mutated in place - this runs per
     * peg per fixed step, and an allocation there is a per-frame allocation.
     */
    function step(st, freqHz, zeta, dt) {
        const k = coefficients(freqHz, zeta, dt);
        const x = st.x, v = st.v;
        st.x = k.A * x + k.B * v;
        st.v = k.C * x + k.D * v;
    }

    return {
        step: step,
        coefficients: coefficients,
        peakGain: peakGain,
        impulseForPeak: impulseForPeak
    };
})();