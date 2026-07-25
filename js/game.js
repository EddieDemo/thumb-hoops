// File: js/game.js
'use strict';

// Define distinct game states
const GameStates = {
    READY_TO_AIM: 'READY_TO_AIM', // Waiting for user input to start aiming
    AIMING: 'AIMING',           // User is dragging to aim
    SHOT_TAKEN: 'SHOT_TAKEN',     // Ball is in flight, physics active
    RESETTING: 'RESETTING'       // Short delay after ball hits floor before resetting
};

function Game() {
    // --- Properties ---
    this.canvas = document.querySelector('canvas');
    // desynchronized: lets Chrome-family browsers bypass the compositor
    // queue for this canvas - a measurable input-to-photon latency cut on
    // Android, harmlessly ignored elsewhere. (alpha stays default: the
    // board paints its own opaque background each frame, but keeping the
    // transparent-capable context avoids any first-frame flash risk.)
    this.c = this.canvas.getContext('2d', { desynchronized: true });
    this.rect = null; // Updated on resize

    // Grid dimensions from CONFIG
    this.COLUMNS = CONFIG.GRID.COLUMNS;
    this.ROWS = CONFIG.GRID.ROWS;
    this.cellRes = 0; // Calculated

    // Device pixel ratio for crisp rendering (set in redefineVariables).
    // This is the ONLY rendering-resolution concept in the codebase; all game
    // logic works in logical pixels and never touches it.
    this.dpr = 1;

    // Game Object Lists
    this.elements = [];
    this.cells = [];
    this.nodes = [];
    this.lines = []; // Hoops
    this.balls = [];
    this.currentBall = null; // The ball currently being aimed or just shot

    // Physics properties calculated from CONFIG scales
    this.gravity = 0;
    this.speed = 0; // Aim sensitivity (calculated) - Now refers to AIMING_SENSITIVITY_SCALE
    this.nRadius = 0; // Node radius (calculated)
    this.radius = 0; // Ball radius (calculated)

    // Game State Variables
    this.score = 0;         // Current streak (restored from persistence in start())
    this.bestStreak = Persistence.load('bestStreak', 0); // All-time best
    this.teachShotsTaken = Persistence.load('teachShots', 0); // Shots counted for the teaching wean
    this.shotStepsElapsed = 0; // Fixed steps flown in the current shot
    // Fate transit: once the shot's outcome is knowable (downward hoop-line
    // crossing, or apex for balls that never reach the line), the colour
    // transition starts and is driven by the ball's fall until its centre
    // crosses the world's bottom edge. { startY, mode, t, done }
    this.fateTransit = null;
    // Active input scheme ('drag' | 'flick'). The persisted choice only
    // applies while the toggle is visible; with the toggle hidden the
    // configured scheme wins, so a stored 'drag' can't strand a player
    // (or a tester) in a scheme they have no way to leave.
    // Flick custody: has the player released this ball during this round?
    // Only then can leaving the zone count as a shot (see
    // checkShotPromotion).
    this.ballReleasedThisRound = false;

    this.inputScheme = CONFIG.INPUT.SHOW_SCHEME_TOGGLE
        ? Persistence.load('inputScheme', CONFIG.INPUT.SCHEME)
        : CONFIG.INPUT.SCHEME;

    // --- THE COURT ---
    // A court IS a seed: the hoop ladder and the run's hue derive from it
    // deterministically (see js/rng.js, js/solver.js). Priority: a shared
    // court from the URL (?seed=..., including date strings - time
    // travel), else the DAILY court - the player's local date. Custom
    // courts are EXHIBITION: they never write BEST records.
    let urlSeed = null;
    if (typeof window !== 'undefined' && window.location && window.location.search) {
        try { urlSeed = new URLSearchParams(window.location.search).get('seed'); } catch (e) {}
    }
    this.courtSeed = (urlSeed && urlSeed.trim()) ? urlSeed.trim() : RNG.todaySeed();
    // Exhibition rule: custom means NOT TODAY. A shared link to today's
    // court counts fully (it IS the daily); yesterday's or tomorrow's date
    // - or any arbitrary seed - is exhibition. Emergent nicety: playing
    // tomorrow's court early is automatically record-safe practice, and
    // the identical ladder starts counting at midnight.
    // INSTRUMENT: a capture session is EXHIBITION too - twenty deliberate
    // throws at a locked hoop must never charge strokes against today's
    // real record.
    this.isCustomCourt = this.courtSeed !== RNG.todaySeed() || Capture.enabled();
    Palette.setFixedHue(RNG.hueFor(this.courtSeed)); // The court's colour

    // --- THE DAILY LEDGER ---
    // Today's record: highest rung reached (best) and the misses spent at
    // the moment that summit was FIRST set (missesAtBest) - golf strokes,
    // snapshotted, lexicographic (higher beats cheaper; cheaper breaks
    // ties). 'misses' is the running count, kept silently. Keyed by the
    // court seed itself: a new day is a new key (auto-reset at midnight),
    // reloads resume today intact. Custom courts are exhibition - no
    // ledger, ever.
    const storedDaily = Persistence.load('dailyRecord', null);
    this.daily = (storedDaily && storedDaily.seed === this.courtSeed)
        ? storedDaily
        : { seed: this.courtSeed, best: 0, missesAtBest: 0, misses: 0 };
    dbg('Game: court "' + this.courtSeed + '"' + (this.isCustomCourt ? ' (custom - exhibition)' : ' (daily)'));
    // Detached one-shot effects (see effects.js) - may outlive the round
    // that spawned them. Updated/pruned in animate, drawn by the renderer.
    this.effects = [];
    // Round identity: incremented per hoop cycle so an effect can tell when
    // the round that spawned it (and its fate signal) is over.
    this.roundId = 0;
    this.hasScored = false; // Tracks if a score occurred *this round*
    // Set when the ball enters the hoop "cylinder" from below (an upward
    // crossing BETWEEN the posts) - basketball's own rule. Sticky for the
    // shot: an invalidated shot can never score, and by rule its fake-out
    // has no redemption arc.
    this.roundInvalidated = false;
    this.difficulty = 0; // Calculated based on config
    this.difficultyLevels = CONFIG.GAME.DIFFICULTY_LEVELS; // From CONFIG
    this.aimStartX = 0; // Screen coords where aim started
    this.aimStartY = 0;

    // --- State Machine ---
    this.currentState = GameStates.READY_TO_AIM; // Initial state

    // Core Engines / Handlers
    this.physicsEngine = new PhysicsEngine(this);
    this.renderer = new Renderer(this);
    // InputHandler created externally in core.js

    // Timing
    this.lastTime = 0;
    this.deltaTime = 0;
    // Fixed-timestep accumulator: unspent real time carried between frames.
    // See animate() - simulation advances in fixed 1/STEP_HZ increments.
    this.accumulator = 0;
    // Presentation clock (seconds): advances with real frame time, drives
    // entry animations (peg pops, line draw-in). The SIMULATION never reads
    // it - simulation time is the fixed-step accumulator above.
    this.worldTime = 0;
    // Render interpolation factor (0..1): progress toward the next fixed
    // step, set every frame in animate(), read by Ball.draw().
    this.renderAlpha = 1;

    // Theme colors: populated by applyTheme(this) in start() (which runs
    // before the first frame) and refreshed every frame by
    // updateDynamicTheme. No static default exists anymore - the Palette
    // is the sole colour authority.
    this.themeColors = null;

    // Property to store data for the persistent path after shooting
    this.lastShotPathData = null; // {startX, startY, velocityX, velocityY, radius}

    // Timer ID for reset delay
    this.resetTimerId = null; // Store timer ID to allow cancelling

    // --- Initialization ---
    this.start(); // Initialize game setup
}

// --- Core Methods ---

/**
 * Recalculates variables based on window size and configuration.
 * Called on start and resize.
 */
Game.prototype.redefineVariables = function() {
    // CAMERA SEPARATED FROM WORLD. The world is always 6x11 - physics, the
    // hoop table, the ladder and seeded courts all depend on that and must
    // never change with screen size. What changes is how much of it you
    // SEE. The board fills the viewport's width (so the side walls are the
    // screen edges, with no margins eating play space) and the viewport
    // simply crops the top, where only empty sky lives: hoops occupy rows
    // 2-5, the shoot zone rows 7-10.
    //
    // The floor is pinned to the bottom of the screen, which is also where
    // the thumb is. On a viewport too short to show the rows that matter
    // (rows 2-10), cell size falls back to whatever fits those - still
    // larger than fitting all eleven.
    const viewW = window.innerWidth, viewH = window.innerHeight;
    this.cellRes = Math.min(viewW / this.COLUMNS, viewH / CONFIG.RENDER.MIN_VISIBLE_ROWS);

    const worldHeight = this.ROWS * this.cellRes;
    // Where world y=0 lands on screen. Negative = the sky is cropped.
    this.worldOffsetY = viewH - worldHeight;
    // World y at the top of the VISIBLE area - what screen-anchored UI
    // (record label, theme glyph) must hang from instead of the world top.
    this.viewTopY = Math.max(0, -this.worldOffsetY);

    this.viewW = viewW; this.viewH = viewH;   // The camera's aperture
    const logicalWidth  = viewW;
    const logicalHeight = viewH;

    // Render at the display's native pixel density (clamped - beyond 3x the
    // cost quadruples for imperceptible gain). Re-read every call so moving
    // the window between monitors of different density stays crisp.
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);

    // Backbuffer in device pixels; CSS size in logical pixels.
    this.canvas.width  = Math.round(logicalWidth * this.dpr);
    this.canvas.height = Math.round(logicalHeight * this.dpr);
    this.canvas.style.width  = logicalWidth + "px";
    this.canvas.style.height = logicalHeight + "px";

    // Absolute transform (not scale()): repeated resizes can never compound.
    // The camera offset rides IN the transform, so every drawing call keeps
    // speaking pure world coordinates and none of them had to change.
    this.c.setTransform(this.dpr, 0, 0, this.dpr, 0, this.worldOffsetY * this.dpr);

    this.rect = this.canvas.getBoundingClientRect(); // Update cached canvas bounds

    // Calculate physics values based on cell size and config scales
    this.gravity = this.cellRes * CONFIG.PHYSICS.GRAVITY_SCALE;
    this.speed = this.cellRes * CONFIG.PHYSICS.AIMING_SENSITIVITY_SCALE;
    this.radius = this.cellRes * CONFIG.PHYSICS.RADIUS_SCALE;
    this.nRadius = this.cellRes * CONFIG.PHYSICS.NRADIUS_SCALE;

    // NOTE: difficulty selection deliberately does NOT live here.
    // redefineVariables is a pure layout/scale recalculation - it runs on
    // every window resize and must have no game-state side effects.
};

/**
 * Initializes or fully restarts the game.
 */
Game.prototype.start = function() {
    if (this.inputScheme === 'flick') {
        // The intro: an empty world, a ball falling into it. The court
        // rises when the ball first lands (onFloorContact). The lattice
        // itself (cells - placement geometry AND the visible grid) is
        // built now; only the hoop waits for the landing.
        this.redefineVariables();
        this.elements = []; this.cells = []; this.nodes = [];
        this.lines = []; this.balls = [];
        for (let i = 0; i < this.COLUMNS; i++) {
            for (let j = 0; j < this.ROWS; j++) {
                const cell = new Cell(i, j, this);
                this.cells.push(cell); this.elements.push(cell);
            }
        }
        this.spawnDropBall();
        this.transitionTo(GameStates.SHOT_TAKEN); // Physics runs; can't aim yet
        this.lastTime = performance.now(); // Without this, frame 1's delta
        // is the whole time since navigation - a fast-forwarded intro.
        // NOTE: no requestAnimationFrame here - core.js starts THE loop
        // (single owner). A second chain here ran the game at exactly 2x:
        // duplicate same-frame calls have delta 0, and the fallback clamp
        // below minted each one a full 1/60s of phantom time.
        return;
    }
    dbg("Starting game...");

    // Ensure any pending reset timer is cleared immediately
    if (this.resetTimerId) {
        clearTimeout(this.resetTimerId);
        this.resetTimerId = null;
        dbg("Cleared pending reset timer on game start.");
    }

    // Reset core game state variables
    this.lastShotPathData = null;
    // Interruptibility ("queue test"): start() runs once per page load, so
    // restoring here means closing the tab mid-streak and reopening resumes
    // it - the game un-pauses rather than punishing the interruption.
    this.score = Persistence.load('streak', 0);
    Palette.restore(this.score); // Run colour resumes with the run
    this.hasScored = false;
    this.currentBall = null;
    this.lastTime = performance.now();
    this.deltaTime = 0;

    // Initialize state machine
    this.currentState = GameStates.READY_TO_AIM;

    // Apply theme and calculate sizes
    applyTheme(this);
    this.redefineVariables();

    // Clear and recreate grid elements
    this.elements = []; this.cells = []; this.nodes = [];
    this.lines = []; this.balls = [];
    for (let i = 0; i < this.COLUMNS; i++) {
         for (let j = 0; j < this.ROWS; j++) {
            const cell = new Cell(i, j, this);
            this.cells.push(cell); this.elements.push(cell);
         }
    }

    // Setup the first hoop
    this.startHoopCycle();
    dbg("Game started.");
};

/**
 * Creates a new hoop at a random valid position based on difficulty.
 */
Game.prototype.createHoop = function() {
    // Define boundaries for hoop placement
    const MINMAPX = 0;
    const MINMAPY = 2;
    const MAXMAPX = this.COLUMNS - 1;
    // Ceiling derives from the shoot zone (buffer above the line).
    // KEEP IN SYNC with js/solver.js allPlacements/warm.
    const MAXMAPY = this.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS - 1;

    // Find all possible grid cells for the left node
    const getViableNode1s = () => {
        let viables = [];
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            // Ensure node1 is within bounds and leaves space for node2 based on difficulty
            if ((cell.gridX >= MINMAPX && cell.gridX <= MAXMAPX - this.difficulty) &&
                (cell.gridY >= MINMAPY && cell.gridY < MAXMAPY)) {
                viables.push(cell);
            }
        }
        return viables;
     };

     // Find the cell for the right node based on the left node's position
    const getViableNode2s = (cell1) => {
         const node2X = cell1.gridX + this.difficulty;
         const node2Y = cell1.gridY;
         for (let i = 0; i < this.cells.length; i++) {
             const cell = this.cells[i];
             if (cell.gridX === node2X && cell.gridY === node2Y) {
                  if (cell.gridX <= MAXMAPX) { return [cell]; } // Found valid cell
             }
         }
         return []; // No valid cell found
     };

    // THE STREAK-DIFFICULTY ARC: with the solver warm, placement (position
    // AND width) is chosen by measured density against the current
    // streak's target band - streak 0 draws forgiving hoops, deep streaks
    // draw sparse ones, along the same curve family as the colour system.
    // Falls back to legacy random placement while the cache warms.
    let cell1 = null;
    if (CONFIG.GAME.SOLVER.ENABLED) {
        // INSTRUMENT: the session's hoop never moves - "twenty identical
        // throws" only means something against a fixed target. The first
        // placement dealt becomes the lock.
        let placed = Capture.enabled() ? Capture.lockedPlacement() : null;
        if (!placed) {
            placed = Solver.choosePlacementForStreak(this, this.score);
            if (Capture.enabled()) Capture.lockPlacement(placed);
        }
        if (placed) {
            this.difficulty = placed.width; // Width emerges from the band
            cell1 = { gridX: placed.gx, gridY: placed.gy };
        }
    }
    if (!cell1) {
        const viableNode1s = getViableNode1s();
        if (viableNode1s.length === 0) { console.error("No viable positions for Node 1! Difficulty:", this.difficulty); return; }
        cell1 = viableNode1s[Math.floor(Math.random() * viableNode1s.length)];
    }

    // Remembered for the hold-the-world rule: a level-1 miss whose rung-0
    // redraw is identical keeps the court standing (see startFateTransit).
    this.currentPlacement = { gx: cell1.gridX, gy: cell1.gridY, width: this.difficulty };
    const node1 = new Node(cell1.gridX, cell1.gridY, this);
    this.nodes.push(node1); this.elements.push(node1);

    const viableNode2s = getViableNode2s(cell1);
     if (viableNode2s.length === 0) { console.error(`No viable positions for Node 2. Node1 at (${cell1.gridX},${cell1.gridY}), Difficulty ${this.difficulty}. Removing node1.`); this.elements.pop(); this.nodes.pop(); return; } // Clean up node1 if node2 fails
    const cell2 = viableNode2s[0];
    const node2 = new Node(cell2.gridX, cell2.gridY, this, CONFIG.MOTION.PEG_STAGGER_MS / 1000);
    this.nodes.push(node2); this.elements.push(node2);

    const hoop = new Hoop(node1, node2, this);
    this.lines.push(hoop); this.elements.push(hoop);
    dbg(`Hoop created. Difficulty ${this.difficulty}. Pos: (${node1.gridX},${node1.gridY}) to (${node2.gridX},${node2.gridY})`);
};

/**
 * Main game loop, called by requestAnimationFrame.
 *
 * FIXED TIMESTEP: real elapsed time is accumulated, and the simulation is
 * advanced in fixed increments of 1/STEP_HZ seconds. Rendering happens once
 * per display frame regardless. On a 60Hz display this runs ~1 step/frame
 * (identical to the old behaviour); on a 120Hz display ~1 step every other
 * frame - the game no longer runs faster on high-refresh screens.
 *
 * @param {DOMHighResTimeStamp} timestamp - Time provided by requestAnimationFrame.
 */
Game.prototype.animate = function(timestamp) {
    requestAnimationFrame((ts) => this.animate(ts)); // Schedule next frame

    // --- Calculate DeltaTime (real seconds since last frame) ---
    this.deltaTime = (timestamp - this.lastTime) / 1000;
    // DEFENSE: a second animate call in the SAME frame (a duplicate RAF
    // chain) arrives with delta exactly 0. Feeding it the fallback would
    // mint phantom time - the game runs at 2x. Drop the call instead:
    // duplicates become harmless no-ops rather than speed multipliers.
    if (this.deltaTime === 0) return;
    // Use fallback delta if calculation is invalid or too large (e.g. first
    // frame, or returning from a backgrounded tab).
    if (isNaN(this.deltaTime) || this.deltaTime < 0 || this.deltaTime > 0.1) {
        this.deltaTime = 1 / 60;
    }
    this.lastTime = timestamp;
    this.worldTime += this.deltaTime; // Advance the presentation clock

    // Tick detached effects and prune the finished (presentation-time work,
    // independent of the simulation's fixed steps).
    if (this.effects.length > 0) {
        this.effects.forEach(fx => fx.update(this, this.deltaTime));
        this.effects = this.effects.filter(fx => !fx.done);
    }

    // FLICK: a landing last frame completed the transit on screen; this
    // frame the round turns over - bookkeeping, new hoop popping while the
    // ball bounces on.
    if (this.flickResetPending) {
        this.flickResetPending = false;
        this.initiateLevelResetLogic();
        this.transitionTo(GameStates.READY_TO_AIM);
    }

    // --- State-Dependent Simulation Stepping ---
    // Flick's persistent ball can be mid-settle in ANY state (intro drop,
    // post-round bounce, set-down): step whenever a dynamic ball exists.
    const anyDynamicBall = this.balls.some(b => !b.isStatic && !b.sleeping);
    const inPhysicsState =
        this.currentState === GameStates.SHOT_TAKEN ||
        this.currentState === GameStates.RESETTING ||
        (this.inputScheme === 'flick' && anyDynamicBall);

    if (inPhysicsState) {
        this.accumulator += this.deltaTime;

        const stepDuration = 1 / CONFIG.PHYSICS.STEP_HZ;
        const maxSteps = CONFIG.PHYSICS.MAX_STEPS_PER_FRAME;
        let stepsTaken = 0;

        while (this.accumulator >= stepDuration && stepsTaken < maxSteps) {
            this.stepSimulation();
            this.accumulator -= stepDuration;
            stepsTaken++;
        }

        // Spiral-of-death guard: if we hit the cap, the device can't keep up -
        // drop the backlog rather than trying (and failing) to catch up forever.
        if (stepsTaken === maxSteps && this.accumulator >= stepDuration) {
            console.warn(`Game: Simulation running behind - dropping ${this.accumulator.toFixed(3)}s of backlog.`);
            this.accumulator = 0;
        }

        // How far we are toward the NEXT step (0..1) - the renderer blends
        // ball positions by this to stay smooth between fixed steps.
        this.renderAlpha = Math.min(1, this.accumulator / stepDuration);
    } else {
        // AIMING / READY_TO_AIM: no simulation. Keep the accumulator empty so
        // no stale time is "owed" the instant a shot begins.
        this.accumulator = 0;
    // Render interpolation factor (0..1): progress toward the next fixed
    // step, set every frame in animate(), read by Ball.draw().
    this.renderAlpha = 1;
        this.renderAlpha = 1; // Nothing moving - render exact positions
    }

    // --- Theme ---
    // Tick colour tweens and apply the (possibly dynamic) theme for this
    // frame before anything draws with it.
    updateDynamicTheme(this, this.deltaTime);

    // --- Drawing ---
    // Renderer draws the current state of the game world once per display
    // frame. It internally checks game state for prediction paths etc.
    this.renderer.drawFrame();
};

/**
 * Advances the simulation by exactly ONE fixed step.
 * This is the single unit of simulation time: the physics engine's dt=1
 * means "one step", and all CONFIG.PHYSICS values are tuned per step.
 * Called only from the accumulator loop in animate().
 */
Game.prototype.stepSimulation = function() {
    this.shotStepsElapsed++; // One fixed step of real flight consumed
    // Store position before physics: prePixelY drives the hoop-crossing win
    // check, and BOTH axes drive render interpolation between steps.
    this.balls.forEach(ball => {
        if (!ball.isStatic) {
            ball.prePixelX = ball.pixelX;
            ball.prePixelY = ball.pixelY;
            ball.preVelY = ball.velocity.y; // For apex detection below
        }
    });
    this.physicsEngine.update(1, this.balls);
    // Ball checks win condition, updates trails. NOTE: a scoring crossing
    // calls registerScore -> startFateTransit('score') inside this update,
    // which is why the miss-crossing check below runs AFTER it.
    this.balls.forEach(ball => { if (!ball.isStatic && !ball.sleeping) { ball.update(this); } });

    this.checkShotPromotion();
    this.updateFateTransit();
};

/**
 * Fate-transit detection and driving, once per fixed step.
 * All measurements use the BALL'S CENTRE: the trigger crossing, the apex,
 * and completion at the world's bottom edge.
 */
Game.prototype.updateFateTransit = function() {
    // Fate only exists while a SHOT is live. Flick's persistent ball also
    // moves during READY (intro drop, settle bounces, set-down falls) -
    // without this gate, every settle-bounce's apex armed a spurious
    // 'miss' transit, draining the world in sympathy with the bouncing.
    if (this.currentState === GameStates.READY_TO_AIM ||
        this.currentState === GameStates.AIMING) return;

    const ball = this.currentBall;
    if (!ball || ball.isStatic || this.lines.length === 0) return;

    const hoopY = this.lines[0].pixelY;

    // --- Violation: entering the cylinder from below ---
    // An UPWARD crossing of the line BETWEEN the posts invalidates the shot
    // (the straight-up exploit). Outside the posts is the lob - legal.
    // Fate doctrine: the shot can no longer score, so fate seals HERE, at
    // the violation - and the ratchet then holds the drain at zero through
    // the climb, so visibly the world starts dying exactly as the ball
    // falls back through the line. Doctrine and optics agree for free.
    if (!this.roundInvalidated && ball.prePixelY > hoopY && ball.pixelY <= hoopY) {
        const hoop = this.lines[0];
        const nLeft = hoop.node1.pixelX < hoop.node2.pixelX ? hoop.node1 : hoop.node2;
        const nRight = hoop.node1.pixelX < hoop.node2.pixelX ? hoop.node2 : hoop.node1;
        if (ball.pixelX > nLeft.pixelX && ball.pixelX < nRight.pixelX) {
            this.roundInvalidated = true;
            dbg('Game: Shot invalidated - entered the cylinder from below.');
            if (!this.fateTransit) {
                this.startFateTransit('miss');
            }
        }
    }

    // --- Trigger detection (only while fate is still unsealed) ---
    if (!this.fateTransit) {
        if (ball.prePixelY < hoopY && ball.pixelY >= hoopY) {
            // Downward crossing of the hoop's horizontal line. If it scored,
            // registerScore already started the 'score' transit this step -
            // reaching here means it crossed OUTSIDE the posts.
            this.startFateTransit('miss');
        } else if (!this.floorSolid && ball.pixelY > hoopY && ball.preVelY <= 0 && ball.velocity.y > 0) {
            // DRAG (open floor): apex below the line - the ball never
            // reached hoop height and can never rise again; fate sealed
            // the moment it started falling.
            this.startFateTransit('miss');
        } else if (this.floorSolid && ball.pixelY > hoopY) {
            // FLICK (solid floor): the apex rule is FALSE here - the ball
            // can bounce and rise again. Fate seals on ENERGY instead: the
            // ball's "potential head" P (max height above the floor it
            // could ever reach, treating all its speed as vertical and
            // collisions as lossless from here) is provably non-increasing
            // - gravity conserves it, every restitution and friction only
            // spends it. The moment P falls below what reaching the hoop
            // line requires, a score is IMPOSSIBLE - sealed mid-bounce,
            // wherever that happens. (While the ball is above the line,
            // P >= needed automatically, so this can never mis-seal.)
            const floorC = this.ROWS * this.cellRes - ball.radius;
            const v2 = ball.velocity.x * ball.velocity.x + ball.velocity.y * ball.velocity.y;
            const head = (floorC - ball.pixelY) + v2 / (2 * this.gravity);
            const needed = floorC - hoopY;
            if (head < needed) {
                this.startFateTransit('miss');
            }
        }
    }

    // --- Drive: colour progress is a pure function of the ball's height ---
    if (this.fateTransit && !this.fateTransit.done) {
        const ft = this.fateTransit;
        // The span's endpoint is where the ball's CENTRE can actually
        // finish: the bottom edge in drag (the ball leaves the world), but
        // one radius short of it in flick - the solid floor stops the
        // centre there, and the transit must complete AT the landing, not
        // ceiling out just before it.
        const endY = this.ROWS * this.cellRes - (this.floorSolid ? ball.radius : 0);
        const span = endY - ft.startY;
        // Ratchet: rattles can move the ball back UP; the colour only ever
        // advances. Degenerate spans (fate sealed at the floor) complete
        // instantly - feeble shot, curt consequence.
        const raw = span > 1 ? (ball.pixelY - ft.startY) / span : 1;
        ft.t = Math.max(ft.t, Math.min(1, raw));
        Palette.setTransit(ft.t);

        if (ft.t >= 1) {
            ft.done = true;
            Palette.completeTransit();
        }

        // --- Element exit signal (pegs + hoop line) ---
        // Starts NOT at the colour trigger but at the last-possible-contact
        // line: one contact distance (ball radius + peg radius) below the
        // pegs. Below that, falling, no force in the game can return the
        // ball to peg height - so the visual shrink is provably honest, and
        // pegs stay full-size exactly while the fake-out can still use them.
        if (ft.holdWorld) { /* The court stands - no exit plays */ }
        else {
        if (ft.exitT === undefined) ft.exitT = 0;
        const honestyY = hoopY + this.radius + this.nRadius;

        // WHERE THE EXIT BEGINS. It used to be the honesty line, always -
        // correct for a shot that dies AT the hoop (the ball is right
        // there, so the exit starts at zero), but wrong for one that never
        // got there: the ball is already far below that line when its fate
        // seals, so the very first frame computed a large fraction and the
        // elements snapped to half-exited. Worse in flick, where potential
        // energy is conserved in free flight, so a hopeless throw seals at
        // launch - near the floor.
        //
        // Start instead from the ball's own high-water mark (its apex,
        // tracked because the seal can precede it), clamped to never begin
        // above the honesty line so the shrink still can't start while a
        // peg contact remains possible. Normal shots are unaffected: they
        // seal at the hoop, above the line, so the line still wins.
        ft.exitStartY = (ft.exitStartY === undefined)
            ? Math.max(honestyY, ball.pixelY)
            : Math.max(honestyY, Math.min(ft.exitStartY, ball.pixelY));

        if (ball.pixelY >= ft.exitStartY) {
            const exitSpan = endY - ft.exitStartY; // Same reachable endpoint
            const exitRaw = exitSpan > 1 ? (ball.pixelY - ft.exitStartY) / exitSpan : 1;
            ft.exitT = Math.max(ft.exitT, Math.min(1, exitRaw));
        }
        if (ft.done) ft.exitT = 1;
        }
    }
};

/**
 * Re-runs the entry pop for the current elements (used when a mid-flight
 * restart abandons a partially-exited world).
 */
Game.prototype.replayElementEntry = function() {
    const stagger = CONFIG.MOTION.PEG_STAGGER_MS / 1000;
    this.nodes.forEach((node, i) => { node.spawnTime = this.worldTime + i * stagger; });
    this.lines.forEach((line) => { line.spawnTime = this.worldTime; });
};

/**
 * The world's element-exit signal, 0..1: how far the round's elements
 * (pegs, hoop line) have physically left the stage. The second subscriber
 * to the fate transit (the Palette's colour was the first).
 * @returns {number}
 */
Game.prototype.getElementExitT = function() {
    return this.fateTransit ? (this.fateTransit.exitT || 0) : 0;
};

/**
 * How the round is ending: 'score', 'miss', or null while fate is unsealed.
 * Elements use this to choose their manner of leaving (bow vs deflation).
 * @returns {'score'|'miss'|null}
 */
Game.prototype.getElementExitMode = function() {
    return this.fateTransit ? this.fateTransit.mode : null;
};

/**
 * Starts the reset delay timer. Called when entering RESETTING state.
 */
Game.prototype.startResetTimer = function() {
    if (this.currentState !== GameStates.RESETTING) {
        console.warn("startResetTimer called but not in RESETTING state.");
        return;
    }
    const delayMilliseconds = CONFIG.GAME.RESET_DELAY_SECONDS * 1000;
    if (this.resetTimerId) { clearTimeout(this.resetTimerId); } // Clear previous just in case
    dbg(`Game: Starting reset timer for ${delayMilliseconds}ms...`);

    this.resetTimerId = setTimeout(() => {
        dbg("Game: Reset timer finished.");
        if (this.currentState === GameStates.RESETTING) { // Check if still resetting
             this.initiateLevelResetLogic();
             this.transitionTo(GameStates.READY_TO_AIM); // Transition AFTER reset
        } else {
            dbg("Game: Reset timer finished, but state changed. Aborting reset logic.");
        }
        this.resetTimerId = null;
    }, delayMilliseconds);
};

/**
 * Contains the core logic for resetting the level/round after the timer.
 */
Game.prototype.initiateLevelResetLogic = function() {
    dbg("Game: Running level reset logic...");
    // A new round: whatever the ball is still doing is leftover physics,
    // not an attempt, until the player picks it up again.
    this.ballReleasedThisRound = false;

    // Completion guard: if the reset timer beat the ball's centre to the
    // bottom edge, land the last sliver of the transition now.
    if (this.fateTransit && !this.fateTransit.done) {
        Palette.setTransit(1);
        Palette.completeTransit();
        this.fateTransit.done = true;
        if (!this.fateTransit.holdWorld) this.fateTransit.exitT = 1;
    }
    // The flag must outlive fateTransit (nulled below) for startHoopCycle.
    this.holdWorldThisReset = !!(this.fateTransit && this.fateTransit.holdWorld);

    if (!this.hasScored) {
        // A real missed shot costs a stroke on the daily ledger (voluntary
        // restarts and scheme switches are free - putting your ball down
        // is not a stroke). Counted silently; it only surfaces when baked
        // into a new summit's price.
        Capture.finish(false);
        if (!this.isCustomCourt) {
            this.daily.misses++;
            Persistence.save('dailyRecord', this.daily);
        }
        this.resetStreak(); // Miss: the streak ends (and is persisted as ended)
    } else {
        dbg("Score recorded this round, keeping streak:", this.score);
    }
    this.fateTransit = null; // Round over; next shot's fate is unwritten
    // Ball cleanup happens in READY_TO_AIM entry action via transitionTo
    this.startHoopCycle(); // Create the new hoop etc.
    dbg("Level reset logic complete.");
};

/**
 * Clears old game elements (hoop, nodes, ball) and creates a new hoop.
 * Called by start() and initiateLevelResetLogic().
 */
Game.prototype.startHoopCycle = function() {
    if (this.resetTimerId) { clearTimeout(this.resetTimerId); this.resetTimerId = null; } // Safety clear
    this.lastShotPathData = null;
    this.hasScored = false; // Ensure score flag is reset for the new hoop

    // HOLD THE WORLD: the level-1 redraw is this exact hoop - keep the
    // standing court (same objects, no exit played, no entry pop), but
    // still CONSUME the rung-0 draw so the ladder's anti-repeat memory
    // stays aligned for rung 1.
    if (this.holdWorldThisReset) {
        this.holdWorldThisReset = false;
        const placed = Capture.enabled()
            ? Capture.lockedPlacement()
            : Solver.choosePlacementForStreak(this, this.score);
        const cp = this.currentPlacement;
        if (placed && cp && placed.gx === cp.gx && placed.gy === cp.gy && placed.width === cp.width) {
            this.difficulty = placed.width;
            dbg('Game: world holds - same hoop, new attempt.');
            return;
        }
        // Defensive: the peek promised identity but the draw disagreed.
        // Rebuild normally (loud, should never happen).
        console.warn('Game: holdWorld mismatch - rebuilding hoop.', placed, cp);
    }

    // Remove old dynamic elements. FLICK: the ball is PERSISTENT - the
    // hoop cycle replaces the court around it, never the ball itself.
    if (this.inputScheme === 'flick') {
        this.elements = this.elements.filter(el => !(el instanceof Node || el instanceof Hoop));
        this.nodes = []; this.lines = [];
    } else {
        this.elements = this.elements.filter(el => !(el instanceof Node || el instanceof Hoop || el instanceof Ball));
        this.nodes = []; this.lines = []; this.balls = []; this.currentBall = null;
    }

    this.redefineVariables(); // Recalculate layout/sizes (no game-state side effects)

    // Roll difficulty ONCE per new hoop - here, not in redefineVariables,
    // so window resizes can never re-roll it mid-round.
    this.difficulty = this.difficultyLevels[Math.floor(Math.random() * this.difficultyLevels.length)];

    this.roundId++; // New round: old rounds' effects switch to their tails
    this.createHoop(); // Add the new hoop
};

/**
 * Handles window resize events.
 */
Game.prototype.handleResize = function() {
    dbg("Resizing window...");
    this.redefineVariables(); // Recalculate sizes
    // Notify elements that might need to update internal state on resize
    this.elements.forEach(element => {
        if (typeof element.resizeUpdate === 'function') { element.resizeUpdate(this); }
         else { // Basic fallback for elements without a dedicated method
              if (element.gridX !== undefined && element.gridY !== undefined) {
                   element.pixelX = element.gridX * this.cellRes;
                   element.pixelY = element.gridY * this.cellRes;
              }
               if (element.radius !== undefined) { // Adjust radius if applicable
                   if (element instanceof Ball) { element.radius = this.radius; }
                   else if (element instanceof Node) { element.radius = this.nRadius; }
               }
          }
    });
     dbg("Resize complete.");
};

// --- Input Action Methods (Called by InputHandler) ---

/**
 * Sets up the start position for aiming and creates the ball if needed.
 * Called when entering the AIMING state.
 * @param {number} startX - Mouse X coordinate relative to canvas.
 * @param {number} startY - Mouse Y coordinate relative to canvas.
 */
Game.prototype.startAiming = function(startX, startY) {
    dbg("Game: Starting Aim setup.");
    // Input arrives in logical canvas coordinates (converted once in
    // InputHandler.getCanvasPos). All aim math stays in that space -
    // no rendering-scale factors belong anywhere in game logic.
    this.aimStartX = startX;
    this.aimStartY = startY;
    // Live pointer position during the aim - the abort/commit rule and the
    // shoot line's feedback both read it. Starts at the press point.
    this.aimCurrentX = startX;
    this.aimCurrentY = startY;
    if (this.inputScheme === 'flick' && this.currentBall) {
        // Pick up the persistent resting ball: wake it, hold it (static
        // while carried - the gesture, not physics, moves it).
        this.currentBall.sleeping = false;
        this.currentBall.isStatic = true;
        this.currentBall.velocity = { x: 0, y: 0 };
        this.currentBall.trail = [];
        this.moveCarriedBall(startX, startY);
    } else if (!this.currentBall) { // Only create ball on the very first aim action
        const startGridY = Math.min(this.ROWS - 0.5, (startY / this.cellRes));
        const startGridX = Math.max(0.5, Math.min(this.COLUMNS - 0.5, (startX / this.cellRes)));
        this.currentBall = new Ball(startGridX, startGridY, this);
        this.balls.push(this.currentBall);
        this.elements.push(this.currentBall);
        dbg("Game: Created new ball for aiming.");
    }
    this.updateAim(startX, startY); // Calculate initial velocity based on start pos
};

/**
 * Updates the hypothetical velocity of the ball based on mouse drag distance/angle.
 * Called by InputHandler during AIMING state mousemove.
 * AIMING DIRECTION REVERSED. MAX DRAG DISTANCE USES CANVAS HEIGHT MULTIPLIER FROM CONFIG.
 * @param {number} currentX - Current mouse X relative to canvas.
 * @param {number} currentY - Current mouse Y relative to canvas.
 */
Game.prototype.updateAim = function(currentX, currentY) {
    if (this.currentState !== GameStates.AIMING || !this.currentBall) return; // Only run if aiming

    // Everything below is in LOGICAL canvas pixels - the same space the
    // physics simulates in. Drag distance and max-drag are therefore
    // directly comparable (previously they were in mismatched units).
    this.aimCurrentX = currentX;
    this.aimCurrentY = currentY;

    const dx = currentX - this.aimStartX;
    const dy = currentY - this.aimStartY;
    const angle = Math.atan2(dy, dx); // Angle from start point TO current point
    const dragDistance = Math.sqrt(dx * dx + dy * dy);

    // Max drag is a fraction of the board's logical height. Derive it from
    // the grid (ROWS * cellRes) rather than the canvas backbuffer, so it is
    // independent of any rendering resolution scaling.
    const boardHeight = this.ROWS * this.cellRes;
    const maxDragDistance = boardHeight * CONFIG.PHYSICS.MAX_DRAG_HEIGHT_MULTIPLIER;

    const clampedDistance = Math.min(dragDistance, maxDragDistance); // Clamp drag power
    // this.speed = cellRes * AIMING_SENSITIVITY_SCALE, so this simplifies to
    // clampedDistance * AIMING_SENSITIVITY_SCALE - i.e. launch speed is a
    // resolution-independent function of how far the player dragged.
    const baseVelocityMagnitude = (clampedDistance / this.cellRes) * this.speed;

    // Set the velocity the ball WILL have if shot right now
    // Apply velocity IN THE DIRECTION of the drag
    this.currentBall.hypotheticalVelocity = {
        x: Math.cos(angle) * baseVelocityMagnitude,
        y: Math.sin(angle) * baseVelocityMagnitude
    };
};

/**
 * Applies the calculated hypothetical velocity to the ball and releases it.
 * Called when transitioning from AIMING to SHOT_TAKEN state.
 */
Game.prototype.shoot = function() {
    if (this.currentState !== GameStates.AIMING || !this.currentBall) { // Should technically not happen if state logic is correct
        console.warn("Game: Shoot called but not in AIMING state or no currentBall.");
        return;
    }
    dbg("Game: Applying velocity for shot.");

    // Store data needed to draw the persistent path later
    this.lastShotPathData = {
        startX: this.currentBall.pixelX, startY: this.currentBall.pixelY,
        velocityX: this.currentBall.hypotheticalVelocity.x,
        velocityY: this.currentBall.hypotheticalVelocity.y,
        radius: this.currentBall.radius,
        // Capture NOW, before the counter increments: the persisted path
        // must match the prediction the player just aimed with.
        predictionSteps: this.getPredictionSteps()
    };

    // This shot counts toward the teaching wean (persisted - reloading can
    // never rewind the tutorial for a free assisted shot).
    this.teachShotsTaken++;
    Persistence.save('teachShots', this.teachShotsTaken);

    // Steps the ball has actually flown this shot - drives the persisted
    // path's dot consumption (each simulated point vanishes as the real
    // ball reaches it; they correspond exactly, step for step).
    this.shotStepsElapsed = 0;

    this.fateTransit = null; // New shot, fate unknown
    this.roundInvalidated = false; // New shot, rules unbroken

    // Apply the final calculated velocity
    this.currentBall.prePixelY = this.currentBall.pixelY; // Store Y pos before physics
    this.currentBall.velocity = { ...this.currentBall.hypotheticalVelocity }; // Copy velocity
    this.currentBall.release(); // Make ball dynamic (isStatic = false)

    // Degenerate apex: a shot launched level-or-downward is already falling -
    // its launch IS its apex, so its fate transit starts immediately.
    if (this.currentBall.velocity.y >= 0) {
        this.startFateTransit('miss');
    }
};

/**
 * DEBUG affordance: rewinds the teaching wean to shot 1, as if this were a
 * brand-new player. Bound to the R key. Persisted immediately so it also
 * survives a reload.
 */
Game.prototype.resetTeaching = function() {
    this.teachShotsTaken = 0;
    Persistence.save('teachShots', 0);
    dbg('Game: Teaching wean reset - next shot shows the full path.');
};

/**
 * Returns how many steps of prediction path the CURRENT shot should show.
 * The single authority on path visibility: renderer asks, never decides.
 * 0 means no path. Driven by the teaching wean (TEACHING_PATH_STEPS indexed
 * by shots taken), overridden wholesale by the debug flag.
 * @returns {number}
 */
Game.prototype.getPredictionSteps = function() {
    // Flick has no velocity until the instant of release - there is
    // structurally nothing to predict during the gesture, so the teaching
    // path is drag-only. (Ghost trails are flick's teaching candidate.)
    if (this.inputScheme === 'flick') return 0;
    if (CONFIG.RENDER.PREDICTION_PATH_ALWAYS) {
        return CONFIG.GAME.PREDICTION_FRAMES; // Debug: full path, always
    }
    const steps = CONFIG.GAME.TEACHING_PATH_STEPS;
    return this.teachShotsTaken < steps.length ? steps[this.teachShotsTaken] : 0;
};

/**
 * Receives impact data from the live physics step and routes it to
 * feedback systems. The Game is the mediator: physics reports pure data,
 * and this is the single seam where all bounce feedback (haptics, and
 * later audio / visual effects) hangs.
 * @param {{wallImpact: number, pegImpact: number}} impacts - Contact speeds in px/step.
 */
Game.prototype.onBallImpact = function(impacts) {
    // Normalise to cell units so feedback strength is screen-size
    // independent - the same shot feels the same on any phone.
    const strength = Math.max(impacts.wallImpact, impacts.pegImpact) / this.cellRes;
    Haptics.impact(strength);
};

/**
 * Begins the position-driven colour transition at the moment the shot's
 * fate is sealed. 'score' targets the (already-incremented) streak colour;
 * 'miss' targets the start pole with a hue re-roll on completion. A 'score'
 * can override an active 'miss' (the rattle-in fake-out): the bloom then
 * erupts from wherever the drain had reached.
 * @param {'score'|'miss'} mode
 */
Game.prototype.startFateTransit = function(mode) {
    const ball = this.currentBall;
    if (!ball) return;
    Palette.beginTransitToStreak(mode === 'score' ? this.score : 0, mode === 'miss');
    this.fateTransit = { startY: ball.pixelY, mode: mode, t: 0, done: false };

    // HOLD THE WORLD: a miss on LEVEL 1 whose fresh-attempt redraw is the
    // identical hoop plays no exit and no re-entry - the court stands,
    // patient and unimpressed; only the colour drains (the run truly
    // died). On a seeded court this is the common case at level 1 by
    // construction; the equality check is the safety net (legacy paths,
    // future mechanics). Deeper-level misses always play the full death -
    // falling from 7 back to 1 is real news even if the furniture matches.
    if (mode === 'miss' && this.score === 0 && CONFIG.GAME.SOLVER.ENABLED &&
        this.currentPlacement && typeof Solver !== 'undefined' && Solver.peekFirstRung) {
        const next = Capture.enabled() ? Capture.lockedPlacement() : Solver.peekFirstRung(this);
        const cp = this.currentPlacement;
        if (next && next.gx === cp.gx && next.gy === cp.gy && next.width === cp.width) {
            this.fateTransit.holdWorld = true;
            dbg('Game: level-1 miss redraws the same hoop - the world holds.');
        }
    }

    // Scored: spawn each peg's echo as a DETACHED effect. Delays radiate
    // from the crossing point (the ripple); positions are captured now, so
    // the echoes survive the pegs - and the round - that spawned them.
    if (mode === 'score' && CONFIG.MOTION.SCORE_RING) {
        const M = CONFIG.MOTION;
        this.nodes.forEach(node => {
            const distCells = Math.hypot(node.pixelX - ball.pixelX, node.pixelY - ball.pixelY) / this.cellRes;
            const delay = Math.min(0.6, distCells * M.SCORE_RING_WAVE);
            this.effects.push(new RingEffect(node.pixelX, node.pixelY, delay, M.SCORE_RING_SPAN, this.roundId));
        });
    }

    dbg('Game: Fate transit started (' + mode + ') at y=' + ball.pixelY.toFixed(1));
};

/**
 * Registers a successful basket. The ONLY place the streak increments -
 * Ball detects the crossing, but scoring bookkeeping (streak, best, and
 * persistence) is the Game's concern.
 */
Game.prototype.registerScore = function() {
    Capture.finish(true);
    this.score++;
    this.hasScored = true; // Mark score for this round
    Persistence.save('streak', this.score);

    this.startFateTransit('score'); // The world blooms with the fall

    // Best streak updates LIVE, the moment it's exceeded - watching BEST
    // tick up with you is part of the reward. EXHIBITION GUARD: a custom
    // court (loaded via ?seed=) never writes records - a friend's easy
    // Tuesday must not pollute your ladder.
    if (!this.isCustomCourt && this.score > this.bestStreak) {
        this.bestStreak = this.score;
        Persistence.save('bestStreak', this.bestStreak);
    }
    // Daily summit: climbing past today's best re-sets the record LIVE,
    // snapshotting the day's miss count as its price. Only ever improves.
    if (!this.isCustomCourt && this.score > this.daily.best) {
        this.daily.best = this.score;
        this.daily.missesAtBest = this.daily.misses;
        Persistence.save('dailyRecord', this.daily);
    }
    dbg('Game: Score registered. Streak:', this.score, 'Best:', this.bestStreak);
};

/**
 * Ends the current streak (miss or manual restart). The ONLY place the
 * streak resets to zero.
 */
Game.prototype.resetStreak = function() {
    if (this.score !== 0) {
        dbg('Game: Streak ended at', this.score);
    }
    this.score = 0;
    Persistence.save('streak', 0);

    // If a miss fate-transit already drained the world (the normal in-flight
    // path), the Palette is settled and rerolled - don't drain again. The
    // timed drain remains for streak ends with no ball in flight (manual
    // restart, or restart mid-flight before fate was sealed).
    // New attempt on the court: the solver's within-attempt memory clears
    // so every attempt climbs the identical ladder from rung 0.
    Solver.newAttempt();

    const ft = this.fateTransit;
    if (ft && ft.mode === 'miss') {
        if (!ft.done) { Palette.setTransit(1); Palette.completeTransit(); ft.done = true; if (!ft.holdWorld) ft.exitT = 1; }
    } else {
        Palette.resetRun(); // Timed drain to the start pole, then reroll
    }

    if (CONFIG.GAME.TEACHING_SCOPE === 'run') {
        // Warm-up ritual: each new run begins with the wean again.
        this.teachShotsTaken = 0;
        Persistence.save('teachShots', 0);
    }
};

/**
 * Cancels an in-progress aim without firing a shot.
 * Called by InputHandler on pointercancel (OS stole the gesture), and
 * available for any future "tap outside to cancel" affordance.
 * Ball/aim cleanup is deliberately NOT duplicated here - the READY_TO_AIM
 * entry action already removes all Ball objects and clears currentBall,
 * so cancelling is purely a state transition.
 */
/**
 * FLICK: whether the floor is solid (scheme-derived; see physics.js).
 */
Object.defineProperty(Game.prototype, 'floorSolid', {
    get: function() { return this.inputScheme === 'flick'; }
});

/**
 * FLICK: spawns the persistent ball falling in from above the screen -
 * the wordless invitation. At session start it falls through an EMPTY
 * world; its first landing raises the court (see onFloorContact).
 */
Game.prototype.spawnDropBall = function() {
    const startGridX = this.COLUMNS / 2;
    const ball = new Ball(startGridX, -1.5, this);
    ball.release(); // Dynamic immediately - it's falling
    ball.velocity = { x: 0, y: 0 };
    this.currentBall = ball;
    this.balls = [ball];
    this.elements.push(ball);
    dbg('Game: flick ball dropping in.');
};

/**
 * FLICK: first floor contact is the round boundary.
 *  - Intro (no hoop yet): the landing raises the court - pegs pop.
 *  - Shot resolved (fate sealed): complete the round NOW - bookkeeping,
 *    world reset, new hoop popping while the ball bounces to rest as the
 *    next round's resting ball.
 *  - Otherwise (set-down abort settling, later bounces): nothing - the
 *    ball is just coming to rest.
 */
Game.prototype.onFloorContact = function(ball) {
    if (this.lines.length === 0) {
        dbg('Game: flick intro landing - raising the court.');
        this.startHoopCycle();
        this.transitionTo(GameStates.READY_TO_AIM);
        return;
    }
    if (this.fateTransit && this.currentState === GameStates.SHOT_TAKEN) {
        // ONE-FRAME COMPLETION BEAT: complete the transit at the moment of
        // contact - palette fully landed, elements fully exited - and let
        // that state RENDER for one frame before the world swaps. Without
        // it, the swap fires inside the contact step and the exit's final
        // sliver never reaches the screen (pegs skip from tiny to gone).
        dbg('Game: flick landing - transit completes this frame, next round rises next frame.');
        Palette.setTransit(1);
        Palette.completeTransit();
        this.fateTransit.done = true;
        if (!this.fateTransit.holdWorld) this.fateTransit.exitT = 1;
        this.flickResetPending = true;
    }
};

/**
 * FLICK: moves the carried ball with the thumb, clamped inside the walls
 * and (by config) the shoot zone - every throw starts below the line.
 */
Game.prototype.moveCarriedBall = function(x, y) {
    if (this.currentState !== GameStates.AIMING || !this.currentBall) return;
    this.aimCurrentX = x;
    this.aimCurrentY = y;
    const r = this.currentBall.radius;
    const minX = r, maxX = this.COLUMNS * this.cellRes - r;
    let minY = r;
    if (CONFIG.INPUT.FLICK.CLAMP_TO_ZONE) {
        // Zone membership is judged by the ball's CENTRE (collision stays
        // edge-based): carried, the centre rides AT the line, the ball
        // visually straddling it.
        minY = (this.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * this.cellRes;
    }
    const maxY = this.ROWS * this.cellRes - r;
    this.currentBall.pixelX = Math.max(minX, Math.min(maxX, x));
    this.currentBall.pixelY = Math.max(minY, Math.min(maxY, y));
    this.currentBall.prePixelX = this.currentBall.pixelX;
    this.currentBall.prePixelY = this.currentBall.pixelY;
};

/**
 * FLICK: releases the carried ball with the gesture's velocity - ANY
 * direction. The ball is just a ball: it bounces, rolls, dribbles. It only
 * becomes a SHOT if its centre exits the shooting area (see
 * checkShotPromotion) - the line is the one commitment boundary,
 * everywhere, for everything.
 */
Game.prototype.releaseCarriedBall = function(vx, vy) {
    if (this.currentState !== GameStates.AIMING || !this.currentBall) return;
    // The player has now put this ball into motion: from here until the
    // round ends, leaving the zone makes it the official attempt.
    this.ballReleasedThisRound = true;
    const ball = this.currentBall;
    ball.sleeping = false;
    ball.isStatic = false;
    ball.velocity = { x: vx, y: vy };
    ball.prePixelX = ball.pixelX;
    ball.prePixelY = ball.pixelY;
    dbg('Game: ball released with v=(' + vx.toFixed(1) + ', ' + vy.toFixed(1) + ') - free until it leaves the zone.');
    this.transitionTo(GameStates.READY_TO_AIM);
};

/**
 * FLICK: a free-flying ball whose CENTRE crosses out of the shooting area
 * becomes the round's official shot - full lifecycle, full stakes, both
 * directions. Whatever leaves your area is an attempt.
 */
Game.prototype.checkShotPromotion = function() {
    if (this.inputScheme !== 'flick') return;
    if (this.currentState !== GameStates.READY_TO_AIM) return;
    // CUSTODY: the rule is "a RELEASE is a shot if the ball's centre
    // exits the zone" - and a ball still carrying momentum from a
    // previous round was released by nobody. Without this, a made shot
    // powerful enough to bounce back out of the zone would be promoted
    // into a phantom attempt and end the run the player just extended.
    // The ball must have been in the player's hands since this round
    // began. (An escaping dribble still qualifies - they did release it.)
    if (!this.ballReleasedThisRound) return;
    const ball = this.currentBall;
    if (!ball || ball.isStatic || ball.sleeping) return;
    const lineY = (this.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * this.cellRes;
    if (ball.prePixelY >= lineY && ball.pixelY < lineY) {
        dbg('Game: ball exited the zone - promoted to SHOT.');
        Capture.markPromoted();
        this.hasScored = false;
        this.roundInvalidated = false;
        this.fateTransit = null; // Fresh fate for the official attempt
        this.transitionTo(GameStates.SHOT_TAKEN);
    }
};

/**
 * FLICK: commits a throw with the gesture's release velocity (px/step).
 * Reuses the drag pipeline end-to-end: velocity in, everything else
 * (teaching count, fate machinery, states) identical between schemes.
 */
Game.prototype.shootWithVelocity = function(vx, vy) {
    if (this.currentState !== GameStates.AIMING || !this.currentBall) return;
    this.currentBall.hypotheticalVelocity = { x: vx, y: vy };
    this.shoot();
};

/**
 * Switches input scheme (persisted) and restarts the run - the testing
 * toggle's action. Safe in any state: requestRestart handles cleanup.
 */
Game.prototype.toggleInputScheme = function() {
    this.inputScheme = this.inputScheme === 'drag' ? 'flick' : 'drag';
    Persistence.save('inputScheme', this.inputScheme);
    dbg('Game: input scheme ->', this.inputScheme);
    this.requestRestart();

    if (this.inputScheme === 'flick') {
        // Entering flick replays the intro: the world empties, the ball
        // drops in, its landing raises the court.
        this.elements = this.elements.filter(el => !(el instanceof Node || el instanceof Hoop || el instanceof Ball));
        this.nodes = []; this.lines = []; this.balls = []; this.currentBall = null;
        this.fateTransit = null;
        this.spawnDropBall();
        this.transitionTo(GameStates.SHOT_TAKEN);
    }
    // Entering drag: requestRestart's READY state + existing hoop (or the
    // next cycle) restore the drag flow; the persistent ball was cleared
    // by the READY entry action (drag clears balls).
};

/**
 * Whether releasing the drag RIGHT NOW would abort rather than shoot.
 * The rule: the shoot line is the commitment threshold - a release still
 * inside the shoot zone (where drags begin) means "no, wait", and the ball
 * quietly returns to waiting. Since every drag starts in the zone, every
 * committed shot's vector points upward BY CONSTRUCTION - flat/downward
 * launches (physically worthless here) are fenced out at the input layer.
 * Single authority: input routes by it, the renderer draws feedback by it.
 * @returns {boolean}
 */
Game.prototype.wouldReleaseAbort = function() {
    // Flick decides abort by RELEASE VELOCITY (a slow release sets the
    // ball down), which is unknowable mid-gesture - so the position rule
    // and the shoot line's firming feedback are drag-only.
    if (this.inputScheme === 'flick') return false;
    if (this.currentState !== GameStates.AIMING) return false;
    const shootAreaY = (this.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * this.cellRes;
    return this.aimCurrentY >= shootAreaY;
};

Game.prototype.cancelAim = function() {
    if (this.currentState !== GameStates.AIMING) {
        console.warn("Game: cancelAim called but not in AIMING state.");
        return;
    }
    dbg("Game: Cancelling aim, returning to READY_TO_AIM.");
    if (this.inputScheme === 'flick' && this.currentBall) {
        // Set-down: the ball physically DROPS from the hand and settles
        // on the floor - a cancel you can see, not a vanishing.
        this.currentBall.sleeping = false;
        this.currentBall.velocity = { x: 0, y: 0 };
        this.currentBall.release();
    }
    this.transitionTo(GameStates.READY_TO_AIM);
};

/**
 * Handles a manual restart request from input.
 */
Game.prototype.requestRestart = function() {
    dbg("Game: Restart requested via input.");
    // Clear any pending reset timer immediately
    if (this.resetTimerId) {
        clearTimeout(this.resetTimerId);
        this.resetTimerId = null;
        dbg("Cleared pending level reset timer due to manual restart.");
    }
    // Explicitly end the streak for manual restart
    this.resetStreak();

    // A restart mid-flight abandons any fate transit. If it had partially
    // exited the world's elements, let them pop back in - the world
    // reassembles rather than snapping.
    if (this.fateTransit) {
        const wasExiting = (this.fateTransit.exitT || 0) > 0;
        this.fateTransit = null;
        if (wasExiting) this.replayElementEntry();
    }

    // Transition to READY state; its entry actions will handle cleanup/setup.
    this.transitionTo(GameStates.READY_TO_AIM);
};

// --- State Machine Method ---

/**
 * Central method for changing the game's state.
 * Handles logging, updating currentState, and triggering entry actions.
 * @param {string} newState - The target state (must be one of GameStates).
 */
Game.prototype.transitionTo = function(newState) {
    // Prevent redundant transitions
    if (this.currentState === newState) {
        // dbg(`Already in state: ${newState}`); // Can uncomment for debugging
        return;
    }

    dbg(`Transitioning from ${this.currentState} to ${newState}`);

    // Update the state
    this.currentState = newState;

    // --- Entry Logic (Code to run when ENTERING the new state) ---
    switch(this.currentState) {
        case GameStates.READY_TO_AIM:
            // Cleanup after reset or on initial start
            dbg("Entered READY_TO_AIM state: Cleaning up for new round.");
            this.hasScored = false; // Reset score flag for the new potential shot
            this.lastShotPathData = null; // Clear any old persisted path data
            if (this.inputScheme === 'flick') {
                // FLICK: the ball is PERSISTENT - it stays in the world
                // (bouncing to rest, or mid-settle) and remains the
                // currentBall, waiting to be picked up.
            } else {
                this.currentBall = null; // No ball should be active
                // Ensure all ball objects are removed from simulation/rendering lists
                this.elements = this.elements.filter(el => !(el instanceof Ball));
                this.balls = [];
            }
             // Hoop cycle is handled by start() or initiateLevelResetLogic() before this transition occurs.
            break;

        case GameStates.AIMING:
            // Setup for aiming (ball creation happens in startAiming method)
            dbg("Entered AIMING state.");
            break;

        case GameStates.SHOT_TAKEN:
            // Ball is now in flight (velocity applied in shoot method)
            dbg("Entered SHOT_TAKEN state.");
            break;

        case GameStates.RESETTING:
            // Start the delay timer after ball hits floor
            dbg("Entered RESETTING state.");
            this.startResetTimer();
            break;
    }
};