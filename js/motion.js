// File: js/motion.js
// Shared motion vocabulary: easing curves and progress helpers.
//
// This is a LIBRARY, not a manager - nothing registers with it, it owns no
// state, it schedules nothing. Time lives on the Game (worldTime for
// presentation, the fixed-step accumulator for simulation); animation state
// lives on the thing being animated. This file only provides the shapes.
'use strict';

var Motion = (function() {

    /** Clamp to [0, 1]. */
    const clamp01 = (t) => Math.min(1, Math.max(0, t));

    /** Fast arrival: decelerates into the end. */
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    /** Symmetric: slow-fast-slow. */
    const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    /** Playful arrival: overshoots (~110%) then settles - the "pop". */
    const easeOutBack = (t) => {
        const c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };

    /**
     * Raw progress of an age through a delayed window: 0 before the delay,
     * 1 after delay+duration, linear between. Compose with an easing.
     * @param {number} age - Seconds since the thing began existing.
     * @param {number} delay - Seconds to wait before starting.
     * @param {number} duration - Seconds the motion lasts.
     */
    const progress = (age, delay, duration) =>
        duration <= 0 ? (age >= delay ? 1 : 0) : clamp01((age - delay) / duration);

    return {
        clamp01: clamp01,
        easeOutCubic: easeOutCubic,
        easeInOutCubic: easeInOutCubic,
        easeOutBack: easeOutBack,
        progress: progress
    };
})();