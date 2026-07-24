// File: js/rng.js
// Seeded randomness for the court system. A "court" IS a seed: every
// run-affecting random choice derives from it, so the same seed always
// deals the same ladder of hoops and wears the same hue - on any device,
// any day, any attempt. Presentational randomness (future dust, etc.) may
// keep using Math.random; anything that affects PLAY must come through
// here.
//
// Derivation style: PER-PURPOSE STREAMS. Rather than one long stream that
// every consumer advances (fragile: any change to draw counts silently
// shifts everything after it), each purpose derives its own generator from
// the seed plus a label - RNG.create(seed + ':round:' + k) - so round k is
// a pure function of (seed, k): no fast-forwarding, no draw-count
// coupling, and a mid-run reload resumes perfectly by construction.
'use strict';

var RNG = (function() {

    /** xmur3 string hash -> uint32 seed. */
    function hashSeed(str) {
        let h = 1779033703 ^ str.length;
        for (let i = 0; i < str.length; i++) {
            h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
            h = (h << 13) | (h >>> 19);
        }
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return (h ^= h >>> 16) >>> 0;
    }

    /** mulberry32: tiny, fast, statistically fine for game use. */
    function mulberry32(a) {
        return function() {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** A deterministic generator for a seed string (plus purpose label). */
    function create(seedString) {
        return mulberry32(hashSeed(String(seedString)));
    }

    /** The DAILY court's seed: the player's LOCAL date, human-readable and
     *  human-typeable - "2026-07-24". Loading a date IS time travel. */
    function todaySeed() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /** A short shareable token for non-daily courts (future free play /
     *  rematch codes). */
    function randomSeed() {
        return Math.random().toString(36).slice(2, 8);
    }

    /** The court's hue, 0..360: a pure function of the seed - every
     *  attempt on a court wears the same colour; the daily court is the
     *  day's colour, shared by everyone. */
    function hueFor(seedString) {
        return Math.floor(create(seedString + ':hue')() * 360);
    }

    return {
        create: create,
        todaySeed: todaySeed,
        randomSeed: randomSeed,
        hueFor: hueFor
    };
})();