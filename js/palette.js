// File: js/palette.js
// The accent-colour identity system: the world is white; colour is earned.
//
// MODEL (HSB): each run rolls a random base hue. The streak maps through an
// asymptotic curve to progress p in [0,1); the displayed colour interpolates
// linearly in HSB from {S:0, B:100%} to {S:100%, B:100%} with the hue
// bending +HUE_BEND degrees across the journey. Progress passes 99% at
// streak 16 (CURVE_RATE 0.75) and approaches - but never reaches - the end.
//
// Dependent surface colours (cell fills, score tint, boundary) derive from
// the base by fixed brightness factors, preserving the original theme's
// relative hierarchy.
//
// MOTION: scoring BLOOMS the colour quickly; missing DRAINS it slowly back
// to white, and the next run's hue is re-rolled only once the drain
// completes - you watch the OLD colour leave.
'use strict';

var Palette = (function() {

    // ---------------- HSB -> sRGB ----------------

    /**
     * @param {number} H - Hue in degrees (any value; wrapped).
     * @param {number} S - Saturation 0..1.
     * @param {number} B - Brightness 0..1.
     * @returns {string} '#rrggbb'
     */
    function hsbToHex(H, S, B) {
        H = ((H % 360) + 360) % 360;
        const c = B * S;
        const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
        const m = B - c;
        let r, g, b;
        if      (H < 60)  { r = c; g = x; b = 0; }
        else if (H < 120) { r = x; g = c; b = 0; }
        else if (H < 180) { r = 0; g = c; b = x; }
        else if (H < 240) { r = 0; g = x; b = c; }
        else if (H < 300) { r = x; g = 0; b = c; }
        else              { r = c; g = 0; b = x; }
        const hex = (v) => {
            const n = Math.round(Math.min(1, Math.max(0, v + m)) * 255);
            return (n < 16 ? '0' : '') + n.toString(16);
        };
        return '#' + hex(r) + hex(g) + hex(b);
    }

    // ---------------- Luminance & contrast ----------------

    /** WCAG relative luminance of an HSB colour (0..1). Monotonic in B at
     *  fixed H/S, and monotonic (decreasing) in S at B=1 - which is what
     *  makes the binary searches below valid. */
    function luminanceHSB(H, S, B) {
        H = ((H % 360) + 360) % 360;
        const c = B * S;
        const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
        const m = B - c;
        let r, g, b;
        if      (H < 60)  { r = c; g = x; b = 0; }
        else if (H < 120) { r = x; g = c; b = 0; }
        else if (H < 180) { r = 0; g = c; b = x; }
        else if (H < 240) { r = 0; g = x; b = c; }
        else if (H < 300) { r = x; g = 0; b = c; }
        else              { r = c; g = 0; b = x; }
        const lin = (v) => { v += m; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    }

    /**
     * Solves for a colour at the given hue that hits a target WCAG contrast
     * ratio against the background.
     *  - 'darker'  : fixes saturation, binary-searches brightness downward.
     *  - 'lighter' : fixes brightness at 1, binary-searches saturation
     *                downward (toward white).
     * If the target is unreachable the search saturates at its extreme -
     * contrast degrades gracefully, never explodes.
     */
    function solveContrast(H, S, bgY, targetRatio, direction) {
        // Target luminance from the ratio definition (L1+0.05)/(L2+0.05).
        const wantY = direction === 'darker'
            ? (bgY + 0.05) / targetRatio - 0.05
            : targetRatio * (bgY + 0.05) - 0.05;

        if (direction === 'darker') {
            let lo = 0, hi = 1; // brightness
            for (let i = 0; i < 20; i++) {
                const mid = (lo + hi) / 2;
                if (luminanceHSB(H, S, mid) > wantY) hi = mid; else lo = mid;
            }
            return { H: H, S: S, B: (lo + hi) / 2 };
        } else if (luminanceHSB(H, S, 1) >= wantY) {
            // Lighter, phase 1: raising brightness at this saturation is
            // enough (the usual case on dark backgrounds).
            let lo = 0, hi = 1; // brightness
            for (let i = 0; i < 20; i++) {
                const mid = (lo + hi) / 2;
                if (luminanceHSB(H, S, mid) > wantY) hi = mid; else lo = mid;
            }
            return { H: H, S: S, B: (lo + hi) / 2 };
        } else {
            // Lighter, phase 2: even full brightness isn't light enough at
            // this saturation - continue by desaturating toward white.
            //
            // FLOORED. Unchecked, this walks all the way to S=0, and a WHITE
            // mark on a saturated hue carries enormous CHROMATIC contrast
            // that the luminance ratio cannot see: measured at 1.24:1 and
            // unmissable on the screen. The floor keeps a mark recognisably
            // the world's own colour; if the target genuinely cannot be
            // reached above it, the honest outcome is a slightly quieter
            // mark rather than a shout.
            const floorS = S * (cfg().DESATURATE_FLOOR !== undefined
                ? cfg().DESATURATE_FLOOR : 0);
            let lo = floorS, hi = S;
            for (let i = 0; i < 20; i++) {
                const mid = (lo + hi) / 2;
                if (luminanceHSB(H, mid, 1) < wantY) hi = mid; else lo = mid;
            }
            return { H: H, S: (lo + hi) / 2, B: 1 };
        }
    }

    // ---------------- Run state ----------------

    let mode = 'light';      // 'light' | 'dark' - which pole the ramp starts from
    let baseHue = null;      // This run's rolled hue (persisted for un-pause)
    let displayP = 0;        // Progress currently SHOWN (tweens toward targetP)
    let targetP = 0;
    let tween = null;        // { from, to, elapsed, dur, ease }
    let rerollOnArrival = false; // Roll a fresh hue once the drain lands

    // Position-driven "fate transit": when active, colour progress is a pure
    // function of the ball's height (the Game drives it) instead of a timed
    // tween. { from, to, isReset }
    let transit = null;

    let cachedTheme = null;  // Rebuilt only when displayP/hue actually change
    let cacheKey = '';

    function cfg() { return CONFIG.COLORS.RAMP; }

    /**
     * Asymptotic streak -> progress: p = 1 - CURVE_RATE^streak.
     * At CURVE_RATE 0.75: streak 4 -> 68%, 8 -> 90%, 16 -> 99%, never 100%.
     */
    function curve(streak) {
        return streak <= 0 ? 0 : 1 - Math.pow(cfg().CURVE_RATE, streak);
    }

    // When set, the hue is a pure function of the court's seed: rerolls
    // return the same value, so every attempt on a court wears the same
    // colour - the daily court is the day's colour, shared by everyone.
    let fixedHue = null;

    /** Pins the palette to the court's hue (seeded-run mode). */
    function setFixedHue(h) {
        fixedHue = h;
        baseHue = h;
        Persistence.save('runHue', baseHue);
        cachedTheme = null; // Force theme rebuild with the court's colour
    }

    function rollHue() {
        if (fixedHue !== null) {
            baseHue = fixedHue; // The court's colour holds; "reroll" is a no-op
            return;
        }
        baseHue = Math.random() * 360;
        Persistence.save('runHue', baseHue);
        dbg('Palette: rolled hue', baseHue.toFixed(1));
    }

    // Easing shapes come from the shared Motion vocabulary (motion.js).

    function startTween(to, dur, ease) {
        tween = { from: displayP, to: to, elapsed: 0, dur: dur, ease: ease };
        targetP = to;
    }

    /**
     * Base HSB at a given progress: linear interpolation between this
     * mode's start and end anchors, hue bending across the journey. The
     * hue, curve, and tweens are shared between modes - only the anchors
     * differ (light: white pole -> saturated rim; dark: black pole ->
     * jewel-tone rim).
     */
    function baseAt(p) {
        const a = mode === 'dark' ? cfg().DARK_ANCHOR : cfg().LIGHT_ANCHOR;
        const base = {
            H: baseHue + cfg().HUE_BEND * p,
            S: a.START_S + (a.END_S - a.START_S) * p,
            B: a.START_B + (a.END_B - a.START_B) * p
        };

        // --- WEIGHT NORMALISATION -----------------------------------------
        // The anchors move SATURATION and leave BRIGHTNESS at its pole, so
        // the background's luminance is decided entirely by which hue the
        // day rolled. Green weighs 0.7152 in the luminance formula and blue
        // weighs 0.0722, so the same ramp position gives:
        //
        //     amber  0.841      green 0.742      red 0.429
        //     pink   0.231      blue  0.094
        //
        // A NINEFOLD range for what is supposed to be one design in
        // different colours. It also decides which side of PIVOT_Y the
        // background lands on, which decides whether every mark is solved
        // darker (saturation preserved, properly recessive) or lighter
        // (desaturating toward white, and shouting). Two screens, opposite
        // treatment, from a coin flip nobody chose.
        //
        // So: solve BRIGHTNESS for a target luminance, exactly the way every
        // other element is solved. The background stops being the one thing
        // exempt from the system.
        //
        // THE TARGET RAMPS FROM THE POLE. At p=0 it is the anchor's own
        // luminance - white in light mode, black in dark - so an untouched
        // court still opens on a clean sheet. Only as colour is EARNED does
        // the weight settle toward the target, which is the moment the hue
        // starts to matter.
        const R = cfg();
        if (R.BG_NORMALISE) {
            const poleY = luminanceHSB(base.H, a.START_S, a.START_B);
            const target = (mode === 'dark') ? R.BG_TARGET_Y_DARK : R.BG_TARGET_Y_LIGHT;
            const wantY = poleY + (target - poleY) * p;
            const solved = solveBaseForY(base.H, base.S, wantY);
            base.S = solved.S;
            base.B = solved.B;
        }
        return base;
    }

    /**
     * The (S, B) that puts a hue at a requested luminance - two phases, the
     * same shape as solveContrast.
     *
     *   1. LOWER BRIGHTNESS. Works whenever the hue at full brightness is
     *      already lighter than the target (amber, green, red).
     *   2. LOWER SATURATION. A deep blue at full saturation and full
     *      brightness has a luminance of 0.075: there is no brightness that
     *      makes it lighter, because brightness is already spent. The only
     *      road up is toward white.
     *
     * Phase 2 is what makes this a real normalisation rather than a partial
     * one. Without it the dark hues simply stay dark and the spread barely
     * closes - and the whole point is that a day should differ in HUE and
     * not in heft.
     *
     * The cost is honest and worth stating: a fully-earned BLUE court can no
     * longer be a deep saturated blue, because deep saturated blue is dark.
     * It becomes a lighter, less saturated blue of the same weight as every
     * other day. That is the trade the target buys.
     */
    function solveBaseForY(H, S, wantY) {
        if (luminanceHSB(H, S, 1) >= wantY) {
            let lo = 0, hi = 1;                       // brightness
            for (let i = 0; i < 22; i++) {
                const mid = (lo + hi) / 2;
                if (luminanceHSB(H, S, mid) > wantY) hi = mid; else lo = mid;
            }
            return { S: S, B: (lo + hi) / 2 };
        }
        let lo = 0, hi = S;                            // saturation, B pinned
        for (let i = 0; i < 22; i++) {
            const mid = (lo + hi) / 2;
            if (luminanceHSB(H, mid, 1) < wantY) hi = mid; else lo = mid;
        }
        return { S: (lo + hi) / 2, B: 1 };
    }

    /**
     * Builds the full theme from the current background: EVERY element's
     * colour is solved to a role-specific contrast ratio against the base,
     * at the base's hue. When the background is perceptually dark (deep
     * saturated blues/violets at full HSB brightness), the solve direction
     * flips and all elements become lighter tints instead of darker shades -
     * legibility holds on every hue, by construction.
     */
    function buildTheme(p) {
        // The active preset decides every target. Which preset is active is
        // owned by colors.js (system request -> stored choice -> default);
        // the palette only asks.
        const C = cfg().CONTRAST;
        const presetName = (typeof activeContrast === 'function')
            ? activeContrast() : C.DEFAULT;
        const preset = C.PRESETS[presetName] || C.PRESETS[C.DEFAULT];
        const t = preset[mode === 'dark' ? 'DARK' : 'LIGHT'];
        const pivot = C.PIVOT_Y;
        const b = baseAt(p);
        const bgY = luminanceHSB(b.H, b.S, b.B);
        const dir = bgY >= pivot ? 'darker' : 'lighter';

        // Ink carries the hue at reduced saturation (neutral grey when the
        // world is white, tinted as colour is earned).
        const inkS = Math.min(0.85, b.S * 0.85);

        // Ink doesn't trust the pivot: near-pivot backgrounds can be poorly
        // served by either direction, so solve BOTH and keep whichever
        // achieves more real contrast. (Surfaces keep the pivot direction
        // so the theme shades coherently one way.)
        const inkDark  = solveContrast(b.H, inkS, bgY, t.INK, 'darker');
        const inkLight = solveContrast(b.H, inkS, bgY, t.INK, 'lighter');
        const ratioOf = (c2) => {
            const y = luminanceHSB(c2.H, c2.S, c2.B);
            return (Math.max(bgY, y) + 0.05) / (Math.min(bgY, y) + 0.05);
        };
        const ink = ratioOf(inkDark) >= ratioOf(inkLight) ? inkDark : inkLight;

        const score    = solveContrast(b.H, b.S,  bgY, t.SCORE,    dir);
        const control  = solveContrast(b.H, b.S,  bgY, t.CONTROL,  dir);
        const info     = solveContrast(b.H, b.S,  bgY, t.INFO,     dir);
        const ambient  = solveContrast(b.H, b.S,  bgY, t.AMBIENT,  dir);
        const boundary = solveContrast(b.H, b.S,  bgY, t.BOUNDARY, dir);
        const cell2    = solveContrast(b.H, b.S,  bgY, t.CELL2,    dir);
        // THE DOOR IS ALWAYS VISIBLE. The control that reaches the
        // accessible preset must be findable BY THE PERSON WHO NEEDS IT -
        // a high-contrast button drawn at 1.24:1 is a circular failure, and
        // the commonest way this pattern is got wrong. So this one glyph is
        // solved against the ACCESSIBLE preset's CONTROL target no matter
        // which preset is running.
        const acc = C.PRESETS[C.ACCESSIBLE] || preset;
        const doorTarget = Math.max(t.CONTROL, acc[mode === 'dark' ? 'DARK' : 'LIGHT'].CONTROL);
        const door     = solveContrast(b.H, b.S,  bgY, doorTarget, dir);

        const inkHex = hsbToHex(ink.H, ink.S, ink.B);
        return {
            BACKGROUND:  hsbToHex(b.H, b.S, b.B),
            CELL_FILL_1: hsbToHex(b.H, b.S, b.B),
            CELL_FILL_2: hsbToHex(cell2.H, cell2.S, cell2.B),
            SCORE:       hsbToHex(score.H, score.S, score.B),
            CONTROL:     hsbToHex(control.H, control.S, control.B),
            INFO:        hsbToHex(info.H, info.S, info.B),
            AMBIENT:     hsbToHex(ambient.H, ambient.S, ambient.B),
            CONTRAST_DOOR: hsbToHex(door.H, door.S, door.B),
            BOUNDARY:    hsbToHex(boundary.H, boundary.S, boundary.B),
            // The ink itself, by name. BALL/NODE/HOOP are the same value
            // under their role names; INK is for anything that needs the
            // ink as a MATERIAL (transparent overlays, derived tints).
            // Asking for a key that doesn't exist is silent in canvas -
            // fillStyle keeps its previous value - so a missing name here
            // becomes an invisible-in-one-theme bug, not an error.
            INK: inkHex,
            BALL: inkHex, NODE: inkHex, HOOP: inkHex,
            GRID_STROKE: hsbToHex(cell2.H, cell2.S, cell2.B)
        };
    }

    // ---------------- Public API ----------------

    /** Restores run colour state on page load (part of un-pausing). */
    function restore(streak) {
        const savedHue = Persistence.load('runHue', null);
        if (savedHue === null) {
            rollHue();
        } else {
            baseHue = savedHue;
        }
        displayP = targetP = curve(streak); // Snap - no tween on load
        tween = null;
    }

    /**
     * Begins a position-driven transition toward a streak's colour: the
     * moment the shot's fate is sealed (hoop crossing or apex), the Game
     * calls this, then drives progress with setTransit as the ball falls.
     * Captures the CURRENT display colour as the start point, so a bloom
     * beginning mid-drain (the rattle-in fake-out) erupts from wherever the
     * drain had reached.
     * @param {number} streak - Destination streak (0 for a run-ending miss).
     * @param {boolean} isReset - True when this transit ends the run (rolls
     *        a fresh hue on completion).
     */
    function beginTransitToStreak(streak, isReset) {
        tween = null;            // Position owns the motion now
        rerollOnArrival = false;
        transit = { from: displayP, to: curve(streak), isReset: !!isReset };
        targetP = transit.to;
    }

    /**
     * Drives an active transit: t is the ball's fall fraction (0 at the
     * trigger height, 1 at the world's bottom edge), already ratcheted by
     * the caller so rattles can't rewind the colour.
     */
    function setTransit(t) {
        if (!transit) return;
        displayP = transit.from + (transit.to - transit.from) * t;
    }

    /** Lands an active transit exactly on target (and rerolls the hue if it
     *  ended the run). Also the completion guard's snap for edge cases. */
    function completeTransit() {
        if (!transit) return;
        displayP = transit.to;
        if (transit.isReset) rollHue();
        transit = null;
    }

    /** Run over WITHOUT a ball in flight (manual restart): timed drain to
     *  the start pole, then roll a fresh hue for the next run. */
    function resetRun() {
        if (displayP <= 0.0001 && targetP <= 0.0001) { rollHue(); return; }
        rerollOnArrival = true;
        startTween(0, cfg().DRAIN_MS / 1000, Motion.easeInOutCubic);
    }

    /**
     * Advances tweens and returns the current light theme object.
     * Cheap when idle: the theme is cached until progress or hue changes.
     * @param {number} dt - Real seconds since last frame.
     */
    function update(dt) {
        if (tween) {
            tween.elapsed += dt;
            const t = Math.min(1, tween.elapsed / tween.dur);
            displayP = tween.from + (tween.to - tween.from) * tween.ease(t);
            if (t >= 1) {
                displayP = tween.to;
                tween = null;
                if (rerollOnArrival) { rerollOnArrival = false; rollHue(); }
            }
        }
        // THE KEY MUST NAME EVERY INPUT buildTheme() reads. Mode and hue
        // were here because someone remembered to add them; the contrast
        // preset was not, so switching preset changed the targets and the
        // cache handed back the old colours anyway - a control that did
        // nothing at all. Anything new that buildTheme consults belongs
        // here in the same breath.
        const contrast = (typeof activeContrast === 'function') ? activeContrast() : '';
        const key = mode + '|' + displayP.toFixed(4) + '|' +
                    (baseHue === null ? 'x' : baseHue.toFixed(1)) + '|' + contrast;
        if (key !== cacheKey || !cachedTheme) {
            cachedTheme = buildTheme(displayP);
            cacheKey = key;
        }
        return cachedTheme;
    }

    /** Current {h, p} - captured when a new best streak is set. */
    function snapshot() {
        return { h: baseHue, p: targetP };
    }

    /** Switches which pole the ramp starts from. Run state (hue, progress,
     *  in-flight tweens) is untouched - your earned colour is yours in
     *  either mode; it just re-anchors. */
    function setMode(m) {
        if (m !== mode) {
            mode = m;
            cacheKey = ''; // Invalidate - same progress, different world
        }
    }

    return {
        restore: restore,
        setFixedHue: setFixedHue,
        beginTransitToStreak: beginTransitToStreak,
        setTransit: setTransit,
        completeTransit: completeTransit,
        resetRun: resetRun,
        update: update,
        snapshot: snapshot,
        setMode: setMode
    };
})();