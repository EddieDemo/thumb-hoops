// File: js/audio.js
'use strict';

/**
 * THE COURT'S GAMELAN
 *
 * Bronze, ported from the Slendro project (github.com/eddiedemo — the
 * gamelan sandbox this borrows its metal from). Two reasons it belongs
 * here rather than being a pleasant coincidence:
 *
 *  1. SLENDRO HAS NO WRONG NOTES. Five even 240-cent steps means no tone
 *     is acoustically home - home is manufactured by behaviour alone. A
 *     physics game emits arbitrary note sequences: nobody composes a
 *     rattle. In any tuning with gravity those sequences read as
 *     mistakes, and the design would spend itself hiding that. Here the
 *     ball can play whatever it likes and it is always consonant.
 *
 *  2. THESE ARE STRUCK IDIOPHONES. A ball hitting a peg IS a mallet
 *     hitting bronze - no metaphor, no translation layer. The physics
 *     already reports impact speed as pure data (the same seam haptics
 *     reads), and prediction can never reach it.
 *
 * THE LATTICE IS THE INSTRUMENT. A peg's grid position is its note:
 * intersection i sounds degree i%5, octave floor(i/5) - a saron's layout,
 * laid across the court. The left peg always speaks low, the right always
 * high, so a rattle plays a fixed interval you can learn, and a hoop's
 * width is audible as the interval between its posts.
 *
 * THE GONG IS THE CYCLE CLOSING. In gamelan the gong marks the completion
 * of a gongan; a basket is exactly that. Which makes the miss free: it is
 * the ABSENCE of the gong - the resolution the ear was waiting for simply
 * never arrives. Nothing to implement.
 *
 * ENGINEERING. Voices are modal (a bank of partials + mallet noise), but
 * rendered ONCE offline into buffers at boot and repitched per strike, so
 * a rattle costs a handful of buffer sources rather than sixty live
 * oscillators. Repitching shortens the ring, which is exactly what a
 * smaller bar does - the register scaling comes free. Nothing is loaded
 * from disk: the sound is code, which is what keeps it inside the byte
 * budget the craft pass cares about.
 *
 * Audio is ENRICHMENT, never information. Most phones are muted; anything
 * the sound says, the screen already said.
 */
var Audio = (function() {

    let ctx = null;
    let master = null;
    let ready = false;          // buffers rendered
    let failed = false;         // this device can't, and that's fine
    let voices = null;          // { pegSoft, pegHard, gong }
    let lastStrikeAt = -Infinity;   // pegs
    let lastLowAt = -Infinity;      // walls and floor, limited separately
    let live = [];              // sources still ringing, for the polyphony cap

    function cfg() { return CONFIG.AUDIO; }
    function enabled() { return !!(cfg() && cfg().ENABLED) && !failed; }

    /* ---------------------------------------------------------------
     * The bronze: a bank of inharmonic partials, a mallet, and - where
     * physics earns it - a beating twin. Ported from Slendro's
     * bronzeStrikeInto, rendered into an offline context.
     *
     * Note the ombak (the slow beat of paired bronze) is present on the
     * GONG only. A lone bar does not beat: gamelan shimmer comes from
     * two instruments forged apart. A great gong is the exception - it
     * beats alone, from the asymmetries of a single casting.
     * --------------------------------------------------------------- */
    const VOICES = {
        peg: {   // bonang: a row of struck kettles, like a row of pegs
            partials: [
                { r: 1.000, g: 1.00, d: 1.00 },
                { r: 1.507, g: 0.55, d: 0.60 },
                { r: 2.330, g: 0.25, d: 0.35 },
                { r: 2.760, g: 0.20, d: 0.30 },
                { r: 4.100, g: 0.10, d: 0.18 },
                { r: 5.900, g: 0.05, d: 0.10 }
            ],
            strike: { fMul: 5, q: 1.2, level: 0.30, decay: 0.012 },
            ombak: { beatHz: 0, depth: 0 },
            attack: 0.003
        },
        low: {   // slenthem: the lowest, longest, quietest bar in the family -
                 // and the one struck with a padded mallet, so barely a knock.
                 // The world's edges should be felt more than heard.
            partials: [
                { r: 1.000, g: 1.00, d: 1.00 },
                { r: 2.756, g: 0.42, d: 0.42 },
                { r: 5.404, g: 0.18, d: 0.22 },
                { r: 8.933, g: 0.07, d: 0.12 }
            ],
            strike: { fMul: 6, q: 1.0, level: 0.12, decay: 0.015 },
            ombak: { beatHz: 0, depth: 0 },
            attack: 0.002
        },
        gong: {
            partials: [
                { r: 1.000, g: 1.00, d: 1.00 },
                { r: 1.480, g: 0.35, d: 0.80 },
                { r: 2.310, g: 0.12, d: 0.50 }
            ],
            strike: { fMul: 2.5, q: 0.8, level: 0.12, decay: 0.03 },
            ombak: { beatHz: 3.5, depth: 0.6 },
            attack: 0.012
        }
    };

    // Living metal: partials this loud carry a faintly detuned twin.
    const TWIN = { minGain: 0.15, offsetHz: 2.2, gainMul: 0.45 };

    function renderVoice(voice, freq, decay, vel) {
        const rate = cfg().RENDER_RATE_HZ;
        const seconds = decay + 0.25;
        const off = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
        const t0 = 0;

        const out = off.createGain();
        out.gain.value = Math.pow(vel, 0.7);
        out.connect(off.destination);

        const spawn = (f, gain, dec, att) => {
            if (f > rate * 0.45 || gain <= 0.0002) return;
            const osc = off.createOscillator();
            osc.frequency.value = f;
            const gn = off.createGain();
            gn.gain.setValueAtTime(0.0001, t0);
            gn.gain.exponentialRampToValueAtTime(gain, t0 + att);
            gn.gain.exponentialRampToValueAtTime(0.0001, t0 + att + dec);
            osc.connect(gn).connect(out);
            osc.start(t0); osc.stop(t0 + att + dec + 0.05);
        };

        // Velocity excites the HIGH partials disproportionately, which is
        // why a hard strike sounds harder rather than merely louder.
        voice.partials.forEach((p, idx) => {
            const g = idx === 0 ? p.g : p.g * Math.pow(vel, 1 + (p.r - 1) * 0.25);
            const dec = Math.max(0.05, decay * p.d);
            spawn(freq * p.r, g, dec, voice.attack);
            if (idx > 0 && p.g >= TWIN.minGain) {
                spawn(freq * p.r + TWIN.offsetHz, g * TWIN.gainMul, dec, voice.attack);
            }
        });

        if (voice.ombak.depth > 0) {
            spawn(freq + voice.ombak.beatHz, voice.ombak.depth, decay, voice.attack);
        }

        // The mallet: a band of noise at the moment of contact.
        const noise = off.createBuffer(1, Math.ceil(rate * 0.1), rate);
        const nd = noise.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const src = off.createBufferSource();
        src.buffer = noise;
        const bp = off.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = Math.min(freq * voice.strike.fMul, rate * 0.4);
        bp.Q.value = voice.strike.q;
        const gn = off.createGain();
        gn.gain.setValueAtTime(voice.strike.level * Math.pow(vel, 1.5), t0);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + voice.strike.decay);
        src.connect(bp).connect(gn).connect(out);
        src.start(t0); src.stop(t0 + voice.strike.decay + 0.05);

        return off.startRendering();
    }

    /* --------------------------- lifecycle --------------------------- */

    /**
     * Must be called from inside a user gesture: browsers refuse to start
     * an AudioContext otherwise. Safe to call repeatedly.
     */
    function init() {
        if (!enabled() || ctx) { resume(); return; }
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { failed = true; return; }
            ctx = new AC({ latencyHint: 'interactive' });

            // A gentle compressor: bronze partials overlapping is what a
            // gamelan IS, but stacked ATTACKS clip. This catches those
            // without flattening the dynamics velocity is providing.
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -14;
            comp.knee.value = 20;
            comp.ratio.value = 3;
            comp.connect(ctx.destination);

            master = ctx.createGain();
            master.gain.value = cfg().MASTER;
            master.connect(comp);

            renderAll();
        } catch (e) {
            failed = true;
            dbg('Audio: unavailable on this device - playing silent.');
        }
    }

    function renderAll() {
        const c = cfg();
        Promise.all([
            renderVoice(VOICES.peg, c.PEG_HZ, c.PEG_DECAY_S, 0.35),
            renderVoice(VOICES.peg, c.PEG_HZ, c.PEG_DECAY_S, 1.0),
            renderVoice(VOICES.gong, c.GONG_HZ, c.GONG_DECAY_S, 0.9),
            renderVoice(VOICES.low, c.LOW_HZ, c.LOW_DECAY_S, 0.35),
            renderVoice(VOICES.low, c.LOW_HZ, c.LOW_DECAY_S, 1.0)
        ]).then(bufs => {
            voices = { pegSoft: bufs[0], pegHard: bufs[1], gong: bufs[2],
                       lowSoft: bufs[3], lowHard: bufs[4] };
            ready = true;
            dbg('Audio: bronze cast.');
        }).catch(() => {
            failed = true;
            dbg('Audio: render failed - playing silent.');
        });
    }

    function resume() {
        if (ctx && ctx.state !== 'running') { try { ctx.resume(); } catch (e) {} }
    }

    /* ---------------------------- playing ---------------------------- */

    function reap(now) {
        for (let i = live.length - 1; i >= 0; i--) {
            if (live[i].until <= now) live.splice(i, 1);
        }
    }

    /**
     * Voice STEALING, not refusal. Bronze rings for over a second, so a
     * cap that turned new strikes away would mute the court for the rest
     * of the decay after a handful of hits - the ball would visibly
     * bounce in silence. The oldest voice yields instead, faded out over
     * a few milliseconds so the theft doesn't click.
     */
    function steal(now) {
        const oldest = live.shift();
        if (!oldest) return;
        try {
            oldest.gain.gain.setValueAtTime(oldest.gain.gain.value, now);
            oldest.gain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
            oldest.src.stop(now + 0.035);
        } catch (e) { /* already finished */ }
    }

    /**
     * @param {boolean} stealable - the gong is not: it marks the cycle
     *        closing and must never be cut short by the rattle that follows.
     */
    function play(buffer, rate, gain, now, stealable) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(master);
        src.start(now);
        if (stealable) live.push({ until: now + buffer.duration / rate, src: src, gain: g });
    }

    /**
     * A peg spoke. `x` is where on the board it stands - its position in
     * the lattice IS its pitch. `strength` is the contact speed in CELLS
     * per step, so the same shot sounds the same on every screen size.
     */
    function peg(x, strength, cellRes) {
        if (!enabled() || !ready || !ctx) return;
        const c = cfg();
        if (strength < c.MIN_IMPACT) return;              // grazes stay silent

        const now = ctx.currentTime;
        reap(now);
        if (now - lastStrikeAt < c.MIN_INTERVAL_MS / 1000) return;
        while (live.length >= c.MAX_VOICES) steal(now);
        lastStrikeAt = now;

        // The lattice: intersection index -> sléndro degree and octave.
        const i = Math.max(0, Math.round(x / cellRes));
        const degree = i % 5;
        const octave = Math.floor(i / 5);
        const cents = octave * 1200 + degree * c.STEP_CENTS;
        const rate = Math.pow(2, cents / 1200);           // always >= 1: the
        // reference buffer is the lowest note, so every other is a repitch
        // UP, which shortens the ring exactly as a smaller bar would.

        const vel = Math.min(1, strength / c.FULL_IMPACT);
        const buf = vel < 0.5 ? voices.pegSoft : voices.pegHard;
        play(buf, rate, c.PEG_GAIN * (0.35 + 0.65 * vel), now, true);
    }

    /**
     * A WALL spoke. The walls run the height of the board, so they carry
     * the ladder vertically: low at the floor, rising as you climb. The
     * pegs' ladder is horizontal, so between them the whole lattice is
     * playable - but an octave down and much quieter, because an edge of
     * the world should be felt more than heard.
     */
    function wall(y, strength, cellRes, rows) {
        if (!enabled() || !ready || !ctx) return;
        const c = cfg();
        if (strength < c.MIN_IMPACT_LOW) return;

        const now = ctx.currentTime;
        reap(now);
        if (now - lastLowAt < c.MIN_INTERVAL_LOW_MS / 1000) return;
        while (live.length >= c.MAX_VOICES) steal(now);
        lastLowAt = now;

        // Screen y grows downward; pitch rises as the ball climbs. The
        // board's whole height is spread across ONE octave of rungs rather
        // than climbing freely - an unbounded ladder reached above the
        // pegs' lowest note, and an edge of the world that out-sings the
        // thing you are aiming at has stopped being an edge.
        // Spread over the height the ball actually USES: the top row is
        // sky the ball leaves the screen through, so measuring against it
        // wasted the ladder's top rung on a place nothing ever hits.
        const h = Math.max(0, Math.min(1, (rows - y / cellRes) / (rows - 1)));
        const degree = Math.round(h * (c.WALL_RUNGS - 1));
        const cents = degree * c.STEP_CENTS;
        const vel = Math.min(1, strength / c.FULL_IMPACT);
        const buf = vel < 0.5 ? voices.lowSoft : voices.lowHard;
        play(buf, Math.pow(2, cents / 1200), c.WALL_GAIN * (0.3 + 0.7 * vel), now, true);
    }

    /**
     * The FLOOR spoke. One pitch, always: the floor is the ground, not a
     * ladder. It also fires more than anything else in the game now that
     * the ball dribbles and settles, which makes it the fatigue risk -
     * so it is the quietest thing here and it never changes note.
     */
    function floor(strength, cellRes) {
        if (!enabled() || !ready || !ctx) return;
        const c = cfg();
        if (strength < c.MIN_IMPACT_FLOOR) return;

        const now = ctx.currentTime;
        reap(now);
        if (now - lastLowAt < c.MIN_INTERVAL_LOW_MS / 1000) return;
        while (live.length >= c.MAX_VOICES) steal(now);
        lastLowAt = now;

        const vel = Math.min(1, strength / c.FULL_IMPACT);
        const buf = vel < 0.5 ? voices.lowSoft : voices.lowHard;
        play(buf, 1, c.FLOOR_GAIN * (0.3 + 0.7 * vel), now, true);
    }

    /** The cycle closed: a basket. */
    function gong() {
        if (!enabled() || !ready || !ctx) return;
        const now = ctx.currentTime;
        reap(now);
        play(voices.gong, 1, cfg().GONG_GAIN, now, false);
    }

    return {
        init: init,
        resume: resume,
        peg: peg,
        wall: wall,
        floor: floor,
        gong: gong,
        isReady: function() { return ready; },
        // For a future mute control; the config flag is the master switch.
        setEnabled: function(on) { CONFIG.AUDIO.ENABLED = !!on; if (on) init(); }
    };
})();