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
InputHandler.prototype.recordFlickSample = function(x, y) {
    const now = performance.now();
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
    const first = s[0], last = s[s.length - 1];
    const dtMs = last.t - first.t;
    if (dtMs <= 0) return null;
    const pxPerMs = { x: (last.x - first.x) / dtMs, y: (last.y - first.y) / dtMs };
    const msPerStep = 1000 / CONFIG.PHYSICS.STEP_HZ;
    const k = msPerStep * CONFIG.INPUT.FLICK.VELOCITY_SCALE;
    return { x: pxPerMs.x * k, y: pxPerMs.y * k };
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
        this.recordFlickSample(pos.x, pos.y);
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
            // The throw: release velocity from the gesture's last window.
            // Slow, downward, or unmeasurable = the ball is set down.
            this.recordFlickSample(pos.x, pos.y);
            const v = this.computeFlickVelocity();
            const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y) : 0;
            if (!v || speed < CONFIG.INPUT.FLICK.MIN_LAUNCH_SPEED || v.y >= 0) {
                dbg('InputHandler: Flick release too gentle/downward - ball set down.');
                this.game.cancelAim();
            } else {
                dbg(`InputHandler: Flick throw v=(${v.x.toFixed(1)}, ${v.y.toFixed(1)}) px/step.`);
                this.game.shootWithVelocity(v.x, v.y);
                this.game.transitionTo(GameStates.SHOT_TAKEN);
            }
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