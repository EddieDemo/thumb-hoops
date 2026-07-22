// File: js/storage.js
// Persistence layer: the only file that touches localStorage.
//
// DESIGN: the game must work perfectly when storage is unavailable
// (private browsing, storage disabled, quota exhausted) - persistence is an
// enhancement, never a dependency. Every operation is wrapped; failures
// degrade silently to in-memory-only behaviour.
//
// Named "Persistence" (not "Storage") deliberately: Storage is a built-in
// browser global and shadowing it invites confusing bugs.
'use strict';

var Persistence = (function() {

    // Versioned namespace: if the save format ever changes incompatibly,
    // bump v1 -> v2 and old keys are simply ignored rather than misread.
    const PREFIX = 'thumbhoops.v1.';

    // Probe availability ONCE. Some browsers throw on access, others on
    // write (Safari private mode historically allowed reads, failed writes).
    const available = (function() {
        try {
            const probe = PREFIX + '__probe__';
            window.localStorage.setItem(probe, '1');
            window.localStorage.removeItem(probe);
            return true;
        } catch (e) {
            return false;
        }
    })();

    /**
     * Saves a JSON-serialisable value. No-ops silently if unavailable.
     * @param {string} key - Unprefixed key, e.g. 'bestStreak'.
     * @param {*} value - Any JSON-serialisable value.
     */
    function save(key, value) {
        if (!available) return;
        try {
            window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch (e) {
            // Quota exceeded or storage revoked mid-session - degrade silently.
        }
    }

    /**
     * Loads a previously saved value.
     * @param {string} key - Unprefixed key.
     * @param {*} fallback - Returned when missing, unavailable, or corrupt.
     * @returns {*}
     */
    function load(key, fallback) {
        if (!available) return fallback;
        try {
            const raw = window.localStorage.getItem(PREFIX + key);
            if (raw === null) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            return fallback; // Corrupt entry - fallback rather than crash.
        }
    }

    return {
        save: save,
        load: load,
        isAvailable: available
    };
})();