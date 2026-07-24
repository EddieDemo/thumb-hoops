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
    const k = msPerStep * CONFIG.INPUT.FLICK.VELOCITY_SCALE;
    const raw = { x: pxPerMs.x * k, y: pxPerMs.y * k };

    // Gesture gain curve: gain ~1 at low speeds (delicate lobs keep 1:1
    // response), rising to GAIN_BOOST at GAIN_REF_SPEED - full power
    // becomes reachable within the zone's stroke without amplifying
    // sensor noise at the precision end. BOOST 1.0 = exactly linear.
    const F = CONFIG.INPUT.FLICK;
    const speed = Math.sqrt(raw.x * raw.x + raw.y * raw.y);
    const gain = 1 + (F.GAIN_BOOST - 1) * Math.min(1, speed / F.GAIN_REF_SPEED);
    return { x: raw.x * gain, y: raw.y * gain };
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
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
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

    // Theme toggle (product feature): a tap in the top-right glyph region
    // flips light/dark - same action as the T key, persisted.
    if (pos.x > this.game.COLUMNS * this.game.cellRes - this.game.cellRes * 1.6 &&
        pos.y < this.game.cellRes * 1.4) {
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
            this.recordFlickSample(pos.x, pos.y);
            this.game.moveCarriedBall(pos.x, pos.y);
        }
    } else {
        dbg(`InputHandler: Aim start ignored. State: ${this.game.currentState}, Y: ${pos.y.toFixed(1)}`);
    }
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
        if (event.getCoalescedEvents) {
            for (const ce of event.getCoalescedEvents()) {
                const cp = this.getCanvasPos(ce);
                this.recordFlickSample(cp.x, cp.y, ce.timeStamp || undefined);
            }
        } else {
            this.recordFlickSample(pos.x, pos.y);
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
            this.recordFlickSample(pos.x, pos.y);
            const v = this.computeFlickVelocity() || { x: 0, y: 0 };
            dbg(`InputHandler: Ball released v=(${v.x.toFixed(1)}, ${v.y.toFixed(1)}) px/step.`);
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