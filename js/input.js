// File: js/input.js
'use strict';
// Unified pointer input (mouse, touch, stylus) via the Pointer Events API.

/**
 * Handles user input (keyboard, pointer) and translates it into game actions.
 * InputHandler owns: which pointer is active, screen->game coordinate
 * conversion, and WHICH game action to request. The Game owns everything
 * about what those actions mean.
 * @param {Game} game - The main game instance to interact with.
 */
function InputHandler(game) {
    this.game = game; // Store reference to the game instance

    // The pointerId currently controlling the aim, or null when idle.
    // Single-pointer discipline: once a drag begins, all other pointers
    // (e.g. a second thumb) are ignored until it ends.
    this.activePointerId = null;

    // FLICK: ring buffer of recent pointer samples {x, y, t} - release
    // velocity is measured over the gesture's last SAMPLE_WINDOW_MS.
    this.flickSamples = [];
}

/**
 * The honest time of a pointer event: the browser's HARDWARE timestamp
 * (when the touch actually happened) rather than performance.now() (when
 * our code got around to running - main-thread jitter that becomes
 * velocity noise in the fit).
 *
 * Guarded: event.timeStamp is only used if it shares performance.now()'s
 * timeline. Mixing two clock epochs inside one sample window would
 * produce garbage velocities, so the epoch is validated once and the
 * whole gesture then speaks one clock. Coalesced samples inherit their
 * parent event's clock, so validating the parent covers them.
 */
InputHandler.prototype.eventTime = function(event) {
    if (this._eventClockOk === undefined && event && typeof event.timeStamp === 'number') {
        this._eventClockOk = event.timeStamp > 0 &&
            Math.abs(performance.now() - event.timeStamp) < 5000;
    }
    return (this._eventClockOk && event && typeof event.timeStamp === 'number')
        ? event.timeStamp
        : performance.now();
};

/**
 * Records a pointer sample for flick velocity estimation and prunes
 * anything older than the sampling window.
 */
InputHandler.prototype.recordFlickSample = function(x, y, t) {
    const now = (t !== undefined) ? t : performance.now();
    this.flickSamples.push({ x: x, y: y, t: now });
    const cutoff = now - CONFIG.INPUT.FLICK.SAMPLE_WINDOW_MS;
    while (this.flickSamples.length > 0 && this.flickSamples[0].t < cutoff) {
        this.flickSamples.shift();
    }

    // INSTRUMENT: a second, longer-retention buffer holding the gesture's
    // raw history - far more than any window we might test - so captured
    // throws can be replayed offline through other estimators and window
    // lengths. Costs nothing when capture is off.
    if (Capture.enabled()) {
        if (!this.captureSamples) this.captureSamples = [];
        this.captureSamples.push({ x: x, y: y, t: now });
        const keep = now - CONFIG.CAPTURE.RETAIN_MS;
        while (this.captureSamples.length > 0 && this.captureSamples[0].t < keep) {
            this.captureSamples.shift();
        }
    }
};

/**
 * Release velocity in px/STEP from the sampled gesture window, or null if
 * the gesture is too sparse to measure (treated as a set-down).
 */
InputHandler.prototype.computeFlickVelocity = function() {
    const s = this.flickSamples;
    if (s.length < 2) return null;

    // LEAST-SQUARES velocity fit: the slope of the best-fit line through
    // ALL samples in the window, per axis. The old endpoint-difference
    // gave the final sample - systematically the least reliable reading,
    // taken as the thumb rolls off the glass - half the vote; here one
    // junk reading is outvoted by the rest. Same average mapping,
    // tighter scatter: identical-feeling gestures produce more identical
    // throws. (With 2 samples this degrades exactly to the endpoint
    // method; with evenly-spaced constant-velocity samples the two are
    // bit-identical - it's pure noise reduction, not a feel change.)
    let n = s.length, tSum = 0, xSum = 0, ySum = 0;
    for (const p of s) { tSum += p.t; xSum += p.x; ySum += p.y; }
    const tMean = tSum / n, xMean = xSum / n, yMean = ySum / n;
    let stt = 0, stx = 0, sty = 0;
    for (const p of s) {
        const dt = p.t - tMean;
        stt += dt * dt;
        stx += dt * (p.x - xMean);
        sty += dt * (p.y - yMean);
    }
    if (stt <= 0) return null; // All samples at one instant - unmeasurable
    const pxPerMs = { x: stx / stt, y: sty / stt };
    const msPerStep = 1000 / CONFIG.PHYSICS.STEP_HZ;
    // Device neutrality: scale the gesture into the board's own units, so
    // the same physical flick yields the same CELLS travelled on every
    // screen size (see REFERENCE_CELL). At the reference geometry this
    // factor is exactly 1 and nothing changes.
    const scale = this.game.cellRes / CONFIG.INPUT.FLICK.REFERENCE_CELL;
    const k = msPerStep * CONFIG.INPUT.FLICK.VELOCITY_SCALE * scale;
    const raw = { x: pxPerMs.x * k, y: pxPerMs.y * k };

    // Gesture gain curve: gain ~1 at low speeds (delicate lobs keep 1:1
    // response), rising to GAIN_BOOST at GAIN_REF_SPEED - full power
    // becomes reachable within the zone's stroke without amplifying
    // sensor noise at the precision end. BOOST 1.0 = exactly linear.
    const F = CONFIG.INPUT.FLICK;
    const speed = Math.sqrt(raw.x * raw.x + raw.y * raw.y);
    // Both pivots are quoted at the reference cell, so they must ride the
    // same scale - otherwise a bigger board sits further up the curve and
    // gets a different amount of help.
    const gainRef = F.GAIN_REF_SPEED * scale;
    const gain = 1 + (F.GAIN_BOOST - 1) * Math.min(1, speed / gainRef);
    let vx = raw.x * gain, vy = raw.y * gain;

    // Power compression: pivots at POWER_REF (identity there), pulling
    // stronger and weaker throws toward it. Direction is untouched - this
    // scales magnitude only, so the four-direction symmetry holds exactly.
    const p = F.POWER_EXPONENT;
    if (p !== 1) {
        const sp = Math.sqrt(vx * vx + vy * vy);
        const powerRef = F.POWER_REF * scale;
        if (sp > 0.0001) {
            const out = powerRef * Math.pow(sp / powerRef, p);
            const k = out / sp;
            vx *= k; vy *= k;
        }
    }
    return { x: vx, y: vy };
};

/**
 * Converts a pointer event's screen position into LOGICAL canvas
 * coordinates (the same coordinate space the game simulates in).
 *
 * This is the ONLY place in the codebase where screen coordinates become
 * game coordinates. Everything downstream (Game, PhysicsEngine, Renderer)
 * works purely in logical pixels.
 *
 * Uses clientX/Y against the cached canvas rect rather than offsetX/Y,
 * because with pointer capture active, events legitimately fire while the
 * pointer is outside the canvas element - where offsetX/Y is unreliable.
 *
 * @param {PointerEvent} event
 * @returns {{x: number, y: number}} Position in logical canvas pixels.
 */
InputHandler.prototype.getCanvasPos = function(event) {
    const rect = this.game.rect; // Cached bounds, refreshed on resize
    // Undo the camera: the canvas spans the viewport, but the world may be
    // scrolled up inside it. Everything downstream works in world space.
    return {
        x: (event.clientX - rect.left) - this.game.worldOffsetX,
        y: (event.clientY - rect.top) - this.game.worldOffsetY
    };
};

/**
 * Attaches all necessary event listeners.
 * This should be called once after the InputHandler is created.
 */
InputHandler.prototype.attachEventListeners = function() {
    // Keyboard Events
    window.addEventListener('keydown', this.handleKeyDown.bind(this), false);

    // Pointer Events (one code path for mouse, touch, and stylus).
    // pointercancel is NOT optional: the OS fires it when it steals the
    // gesture (notification shade, palm rejection, browser nav gesture).
    const canvas = this.game.canvas;
    canvas.addEventListener('pointerdown', this.handlePointerDown.bind(this), false);
    canvas.addEventListener('pointermove', this.handlePointerMove.bind(this), false);
    if (window.onpointerrawupdate !== undefined || 'onpointerrawupdate' in window) {
        canvas.addEventListener('pointerrawupdate', this.handlePointerRawUpdate.bind(this), false);
        dbg('InputHandler: pointerrawupdate available - sampling at hardware rate.');
    }
    canvas.addEventListener('pointerup', this.handlePointerUp.bind(this), false);
    canvas.addEventListener('pointercancel', this.handlePointerCancel.bind(this), false);

    dbg("InputHandler listeners attached (pointer events).");
};

/**
 * Handles keydown events.
 * @param {KeyboardEvent} event - The keyboard event object.
 */
InputHandler.prototype.handleKeyDown = function(event) {
    switch (event.key) {
        case ' ': // Space - restart
            event.preventDefault(); // Prevent spacebar from scrolling page
            dbg('InputHandler: Requesting restart...');
            this.game.requestRestart();
            break;
        case 't': // T - toggle theme (moved off the arrow keys, which are
        case 'T': // reserved for any future aiming refinement)
            dbg('InputHandler: Requesting theme toggle...');
            toggleDarkMode();
            break;
        case 'c': // C - DEBUG: clear the capture session
        case 'C':
            if (Capture.enabled()) { Capture.reset(); }
            break;
        case 'r': // R - DEBUG: rewind the teaching wean to shot 1
        case 'R':
            dbg('InputHandler: Requesting teaching reset...');
            this.game.resetTeaching();
            break;
    }
};

/**
 * Handles pointerdown on the canvas. Begins an aim if the game is ready,
 * the press is in the shoot area, and no other pointer is already aiming.
 * @param {PointerEvent} event
 */
InputHandler.prototype.handlePointerDown = function(event) {
    // Suppress residual browser gestures (double-tap zoom on iOS, etc.)
    event.preventDefault();

    // Browsers only allow an AudioContext to start inside a user gesture,
    // so the gamelan is cast on the first touch and merely resumed after.
    Audio.init();

    // Single-pointer discipline: ignore any new pointer while one is aiming.
    if (this.activePointerId !== null) return;

    // For mouse, only the primary button starts an aim.
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const pos = this.getCanvasPos(event); // Logical canvas coordinates

    // Scheme toggle (testing affordance): a tap in the top-left label
    // region restarts and switches input scheme. Checked before any aim
    // logic; the regions can't overlap (toggle top, shoot zone bottom).
    if (CONFIG.INPUT.SHOW_SCHEME_TOGGLE &&
        pos.x < this.game.cellRes * 1.6 && pos.y < this.game.cellRes * 1.4) {
        dbg('InputHandler: Scheme toggle tapped.');
        this.game.toggleInputScheme();
        return;
    }

    // INSTRUMENT: tap the REC counter to export the session. iOS requires
    // a user gesture for the share sheet, which is exactly what this is.
    // The region sits between the two corner glyphs and can't overlap them.
    if (Capture.enabled() &&
        pos.y > this.game.viewTopY &&
        pos.y < this.game.viewTopY + this.game.cellRes * 1.4 &&
        pos.x > this.game.cellRes * 2 &&
        pos.x < (this.game.COLUMNS - 2) * this.game.cellRes) {
        const route = Capture.exportSession(this.game);
        dbg('InputHandler: Capture export via ' + route + '.');
        return;
    }

    // FONT TRIAL (temporary): a tap in the top-LEFT corner steps through
    // the candidate faces. Same visible-top anchoring as every other
    // screen-fixed region.
    if (CONFIG.RENDER.SHOW_FONT_CYCLER &&
        pos.x < this.game.cellRes * 1.8 &&
        pos.y > this.game.viewTopY &&
        pos.y < this.game.viewTopY + this.game.cellRes * 1.4) {
        Renderer.cycleFont();
        dbg('InputHandler: Font cycled to ' + Renderer.activeFont().label + '.');
        return;
    }

    // Theme toggle (product feature): a tap in the top-right glyph region
    // flips light/dark - same action as the T key, persisted.
    // The region hangs from the VISIBLE top, exactly like the glyph does.
    // Before the camera existed these were the same thing; once the sky
    // could be cropped they diverged, and the glyph became untappable in
    // any context that crops (browser yes, home-screen app no).
    if (pos.x > this.game.COLUMNS * this.game.cellRes - this.game.cellRes * 1.6 &&
        pos.y > this.game.viewTopY &&
        pos.y < this.game.viewTopY + this.game.cellRes * 1.4) {
        dbg('InputHandler: Theme toggle tapped.');
        toggleDarkMode();
        return;
    }

    const shootAreaY = (this.game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * this.game.cellRes;

    if (this.game.currentState === GameStates.READY_TO_AIM && pos.y >= shootAreaY) {
        dbg(`InputHandler: Valid aim start at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}), transitioning to AIMING.`);

        this.activePointerId = event.pointerId;

        // Pointer capture: this canvas keeps receiving move/up/cancel for
        // this pointer even when it leaves the canvas - which thumb drags
        // constantly do. Without it, dragging off-screen loses the shot.
        try {
            this.game.canvas.setPointerCapture(event.pointerId);
        } catch (e) {
            // Capture can fail if the pointer vanished between event and call;
            // aiming still works, just without off-canvas tracking.
            console.warn("InputHandler: setPointerCapture failed.", e);
        }

        this.game.startAiming(pos.x, pos.y);
        this.game.transitionTo(GameStates.AIMING);

        if (this.game.inputScheme === 'flick') {
            // Pick the ball up: it follows the thumb from here; the
            // gesture's final moments will become the throw.
            this.flickSamples = [];
            this.captureSamples = [];
            this.recordFlickSample(pos.x, pos.y, this.eventTime(event));
            this.game.moveCarriedBall(pos.x, pos.y);
        }
    } else {
        dbg(`InputHandler: Aim start ignored. State: ${this.game.currentState}, Y: ${pos.y.toFixed(1)}`);
    }
};

/**
 * Feeds the estimator every reading an event carries: the coalesced
 * history (all the points the browser batched away between frames) when
 * available, otherwise the single point. Each keeps its own hardware
 * timestamp, so the fit sees when the touches HAPPENED.
 */
InputHandler.prototype.sampleFromEvent = function(event, pos) {
    if (event.getCoalescedEvents) {
        const coalesced = event.getCoalescedEvents();
        if (coalesced && coalesced.length) {
            for (const ce of coalesced) {
                const cp = this.getCanvasPos(ce);
                this.recordFlickSample(cp.x, cp.y, this.eventTime(ce));
            }
            return;
        }
    }
    const p = pos || this.getCanvasPos(event);
    this.recordFlickSample(p.x, p.y, this.eventTime(event));
};

/**
 * pointerrawupdate: the same motion as pointermove but delivered as soon
 * as the hardware reports it, rather than being held for the next frame.
 * More samples, fresher - and it helps low-sample-rate devices most.
 * Sampling ONLY: the ball's position, the crossing-release check and all
 * game state stay on pointermove, so the visible game is unchanged and
 * this can never fire game logic twice.
 */
InputHandler.prototype.handlePointerRawUpdate = function(event) {
    if (event.pointerId !== this.activePointerId) return;
    if (this.game.inputScheme !== 'flick') return;
    if (this.game.currentState !== GameStates.AIMING) return;
    this._rawUpdateActive = true; // Proven live: pointermove stops sampling
    this.sampleFromEvent(event, null);
};

/**
 * Handles pointermove. Updates the aim while the active pointer drags.
 * @param {PointerEvent} event
 */
InputHandler.prototype.handlePointerMove = function(event) {
    if (event.pointerId !== this.activePointerId) return; // Not the aiming pointer
    if (this.game.currentState !== GameStates.AIMING) return;

    const pos = this.getCanvasPos(event); // Logical canvas coordinates
    if (this.game.inputScheme === 'flick') {
        // Feed the estimator EVERY sample the hardware produced: browsers
        // batch fast touch input and deliver one event per frame with the
        // rest coalesced inside it - recovering them can double or triple
        // the votes per window, and helps low-sample-rate devices most.
        // pointerrawupdate (when supported) already recorded this motion at
        // full hardware rate, unbuffered by the frame loop - sampling here
        // too would duplicate points and bias the fit toward frame times.
        if (!this._rawUpdateActive) {
            this.sampleFromEvent(event, pos);
        }

        // RELEASE-ON-CROSSING: carrying the ball INTO the play area at
        // throwing speed releases it mid-gesture - the ball leaves the
        // hand at the moment hand and ball part ways, like a real throw.
        // The same threshold that separates throw from set-down at
        // finger-up qualifies the crossing: FAST and UPWARD releases at
        // the line; a slow drift just rides the clamp, still carried,
        // still cancellable. Every flick launch thus happens AT the line -
        // one consistent physics baseline.
        if (this.game.currentState === GameStates.AIMING) {
            const shootAreaY = (this.game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * this.game.cellRes;
            if (pos.y < shootAreaY) {
                // CUSTODY ENDS AT THE LINE - no speed qualifier, no
                // pinning. The ball leaves the hand with whatever motion
                // the gesture had: a real flick flies; a slow carry-across
                // becomes a weak toss that flops back into the zone (a
                // dribble) or barely crosses (a feeble promoted shot -
                // your mistake, honestly earned). Physics and the line do
                // ALL the judging.
                const v = this.computeFlickVelocity() || { x: 0, y: 0 };
                this.game.moveCarriedBall(pos.x, pos.y); // Settle at the line, pointer's x
                dbg(`InputHandler: Ball reached the line - custody ends. v=(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`);
                Capture.recordRelease(this.game, this.captureSamples, v, this.game.currentBall);
                this.game.releaseCarriedBall(v.x, v.y);
                return;
            }
        }

        this.game.moveCarriedBall(pos.x, pos.y);
    } else {
        this.game.updateAim(pos.x, pos.y);
    }
};

/**
 * Handles pointerup. Releases the shot if the active pointer lifts mid-aim.
 * @param {PointerEvent} event
 */
InputHandler.prototype.handlePointerUp = function(event) {
    if (event.pointerId !== this.activePointerId) return; // Not the aiming pointer

    this.releaseActivePointer(event.pointerId);

    if (this.game.currentState === GameStates.AIMING) {
        const pos = this.getCanvasPos(event);

        if (this.game.inputScheme === 'flick') {
            // Release: the ball leaves the hand with the gesture's
            // sampled velocity - whatever it is, in any direction,
            // including nothing. There is NO throw/drop distinction: a
            // "drop" is just a release with near-zero velocity, and
            // physics does with it what physics does. The ball is free
            // until (and unless) its centre exits the zone, at which
            // point it's promoted to the official shot.
            this.recordFlickSample(pos.x, pos.y, this.eventTime(event));
            const v = this.computeFlickVelocity() || { x: 0, y: 0 };
            dbg(`InputHandler: Ball released v=(${v.x.toFixed(1)}, ${v.y.toFixed(1)}) px/step.`);
            Capture.recordRelease(this.game, this.captureSamples, v, this.game.currentBall);
            this.game.releaseCarriedBall(v.x, v.y);
            return;
        }

        // DRAG: feed the final position, then let the Game's single
        // authority decide: release above the shoot line commits; release
        // still inside the shoot zone is an ABORT - the second-guess
        // escape hatch. The ball quietly returns to waiting.
        this.game.updateAim(pos.x, pos.y);
        if (this.game.wouldReleaseAbort()) {
            dbg(`InputHandler: Pointer up inside shoot zone - aborting toss.`);
            this.game.cancelAim();
        } else {
            dbg(`InputHandler: Pointer up at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) - Requesting shot, transitioning to SHOT_TAKEN.`);
            this.game.shoot();
            this.game.transitionTo(GameStates.SHOT_TAKEN);
        }
    }
};

/**
 * Handles pointercancel - the OS/browser has stolen the gesture.
 * Firing the shot from a half-finished, interrupted drag would be wrong;
 * the honest response is to cancel the aim entirely.
 * @param {PointerEvent} event
 */
InputHandler.prototype.handlePointerCancel = function(event) {
    if (event.pointerId !== this.activePointerId) return; // Not the aiming pointer

    this.releaseActivePointer(event.pointerId);

    if (this.game.currentState === GameStates.AIMING) {
        dbg("InputHandler: Pointer cancelled mid-aim - requesting aim cancel.");
        this.game.cancelAim();
    }
};

/**
 * Clears the active pointer and releases capture. Safe to call even if
 * capture was never established or was already implicitly released.
 * @param {number} pointerId
 */
InputHandler.prototype.releaseActivePointer = function(pointerId) {
    this.activePointerId = null;
    try {
        this.game.canvas.releasePointerCapture(pointerId);
    } catch (e) {
        // Already released (browsers auto-release on up/cancel) - fine.
    }
};