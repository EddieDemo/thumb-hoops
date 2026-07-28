// File: js/renderer.js
'use strict';

function Renderer(game) {
    this.game = game;
    this.c = game.c;
    // PERF: offscreen caches for the score numeral and BEST label.
    // Rasterising a 2-cell glyph with fillText every frame was the
    // renderer's single heaviest call; now text is drawn once per
    // (text, colour, size) change and idle frames pay one drawImage.
    // During colour transits the colour changes per frame, so the cache
    // rebuilds per frame - no worse than the old direct fillText - while
    // the majority idle frames become nearly free.
    this.textCaches = { score: { key: '' }, best: { key: '' }, mode: { key: '' }, version: { key: '' }, captureHint: { key: '' }, seed: { key: '' } };

    // FONT FLASH FIX (v3). History, for honesty: v1 listened to
    // fonts.ready, which raced (faces load lazily; ready resolved before
    // our first fillText ever triggered the load). v2 triggered the load
    // but gated rebuilds on fonts.check(), which proved unreliable for
    // externally-loaded faces in the field. v3 stops asking questions and
    // hooks the one promise DEFINED to resolve at the right moment:
    // fonts.load() both triggers the load and resolves when those faces
    // are usable - invalidate the caches then. fonts.ready is chained as
    // a second, now-raceless belt (our load() calls precede it, so the
    // loading set is non-empty when it samples).
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
        const invalidate = () => {
            this.textCaches.score.key = '';
            this.textCaches.best.key = '';
            dbg('Renderer: webfont available - text caches invalidated.');
        };
        Promise.all([
            document.fonts.load(CONFIG.RENDER.SCORE_NUMERAL.WEIGHT + " 16px " + CONFIG.RENDER.FONT_FAMILY),
            document.fonts.load(CONFIG.RENDER.WEIGHT_LABEL + " 16px " + CONFIG.RENDER.FONT_FAMILY),
            document.fonts.load(CONFIG.RENDER.WEIGHT_WATERMARK + " 16px " + CONFIG.RENDER.FONT_FAMILY)
        ]).then(invalidate).catch(() => { /* offline: fallback face stands */ });
        if (document.fonts.ready) document.fonts.ready.then(invalidate);
    }
    dbg("Renderer created.");
}

/**
 * Returns a cached offscreen canvas containing the given text, rebuilt
 * only when text/colour/size change. Rendered at devicePixelRatio for
 * crispness; drawn back at logical size.
 * @returns {{canvas: HTMLCanvasElement, w: number, h: number}}
 */
Renderer.prototype.getCachedText = function(cacheName, text, weight, px, color) {
    const cache = this.textCaches[cacheName];
    const key = text + '|' + color + '|' + px + '|' + weight;
    if (cache.key === key && cache.canvas) return cache;

    const dpr = window.devicePixelRatio || 1;
    if (!cache.canvas) cache.canvas = document.createElement('canvas');
    const canvas = cache.canvas;
    const ctx = canvas.getContext('2d');

    const font = weight + " " + px + "px " + CONFIG.RENDER.FONT_FAMILY;
    ctx.font = font; // Set before measuring
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + 8; // Small pad against clipping
    const h = Math.ceil(px * 1.3);

    canvas.width = Math.max(1, Math.ceil(w * dpr));
    canvas.height = Math.max(1, Math.ceil(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font; // Canvas resize resets state
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    cache.key = key;
    cache.w = w;
    cache.h = h;
    return cache;
};

Renderer.prototype.drawFrame = function() {
    const game = this.game;
    // Paint the court's background OPAQUELY (in logical pixels - the
    // context transform maps to the device-pixel backbuffer). The board no
    // longer relies on the page body showing through: the body now carries
    // the continuing checkerboard surround, and an opaque court makes any
    // sub-pixel misalignment between the two worlds invisible by
    // construction.
    this.c.fillStyle = game.themeColors.BACKGROUND;
    // Clear the WHOLE aperture first (world coords, so the camera offset is
    // already applied): anything the court doesn't cover must go back to
    // transparent, letting the body's checkerboard surround show through
    // exactly as before - otherwise the band above the board would smear.
    this.c.clearRect(-game.worldOffsetX, -game.worldOffsetY, game.viewW, game.viewH);
    this.c.fillRect(0, 0, game.COLUMNS * game.cellRes, game.ROWS * game.cellRes);
    this.drawSideFill(game);
    // NOTE: theme application no longer happens here - applyTheme() runs once
    // at startup and once per toggle. The frame loop never touches the DOM.

    // ------------------------------------------------------------------
    // LAYER ORDER (back to front) - deliberate, do not reorder casually:
    //   1. Background        (the clear; body/canvas colour)
    //   2. Cell grid         (optional checkerboard)
    //   3. Score + BEST      (the ENVIRONMENT layer: the numeral is the
    //                         world's backdrop and must never occlude actors)
    //   4. Boundary + shoot line
    //   5. Pegs + hoop line
    //   6. Detached effects  (score-ring echoes)
    //   7. Prediction path
    //   8. Ball              (always on top)
    // ------------------------------------------------------------------

    // Layer 2: cell grid
    if (CONFIG.RENDER.DRAW_GRID) {
        this.drawGrid(game);
    }

    // Layer 3: the environment layer - score and BEST sit BEHIND the world
    this.drawScore(game);
    this.drawBestStreak(game);
    this.drawThemeToggle(game);  // Light/dark glyph, top-right (product feature)
    this.drawVersionTag(game);
    this.drawSeedTag(game);   // Deploy verification, bottom-left cell

    // Layer 4: frame and shoot line
    if (CONFIG.RENDER.DRAW_BOUNDARY) this.drawCanvasBoundary(game);
    this.drawShootBoundaryLine(game);

    // Layer 5 + 6: the world and its echoes
    this.drawGameObjects(game.nodes);
    this.drawGameObjects(game.lines); // Hoops
    this.drawGhostBall(game);         // Teaching ghost (level one only)
    this.drawGameObjects(game.effects); // Detached one-shot effects (echoes)

    // Draw ball last so it's on top
    this.drawGameObjects(game.balls);

};



/**
 * Back-solves a base colour that, drawn at `wantAlpha` over `bgHex`,
 * composites to exactly `targetHex` - so a transparent element can hit a
 * calibrated contrast target instead of hoping a fixed alpha lands well in
 * every theme.
 *
 * Compositing is linear in RGB: out = a*F + (1-a)*bg, so F = bg + (T-bg)/a.
 * Small alphas demand colours beyond black or white; rather than clip (and
 * silently lose contrast), the alpha is raised to the least value the gamut
 * can serve. Transparency is therefore a REQUEST, honoured wherever
 * physically possible; legibility is not negotiable.
 */
Renderer.prototype.solveTransparent = function(bgHex, targetHex, wantAlpha) {
    const parse = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    let bg, T;
    try { bg = parse(bgHex); T = parse(targetHex); }
    catch (e) { return { color: targetHex, alpha: 1 }; }
    if (bg.some(isNaN) || T.some(isNaN)) return { color: targetHex, alpha: 1 };

    let a = Math.max(0.001, Math.min(1, wantAlpha));
    for (let c = 0; c < 3; c++) {
        const d = T[c] - bg[c];
        if (d === 0) continue;
        const headroom = d > 0 ? (255 - bg[c]) : bg[c];
        if (headroom <= 0) { a = 1; break; }
        a = Math.max(a, Math.abs(d) / headroom);
    }
    const F = T.map((t, c) => {
        const v = Math.round(bg[c] + (t - bg[c]) / a);
        return Math.max(0, Math.min(255, v));
    });
    return { color: '#' + F.map(v => v.toString(16).padStart(2, '0')).join(''), alpha: a };
};

/**
 * THE GHOST BALL: a faint ball hovering above the rim, dwelling high and
 * dipping toward it, with a short fall of dots closing the gap - the
 * wordless answer to "which way does the ball go through?". First-run
 * scaffolding: level one only, then it dissolves.
 *
 * It borrows the hoop's own choreography rather than inventing its own -
 * entering last (after the line finishes drawing) and leaving on the same
 * element-exit signal the pegs read, so it can never outlive the world it
 * belongs to.
 */
Renderer.prototype.drawGhostBall = function(game) {
    const G = CONFIG.RENDER.GHOST_BALL;
    if (!G || !G.ENABLED) return;
    if (game.score >= G.SHOW_WHILE_STREAK_BELOW) return;
    const hoop = game.lines[0];
    if (!hoop || !hoop.node1 || !hoop.node2) return;

    const M = CONFIG.MOTION;
    // Entry: the last element to arrive in the hoop's sequence.
    const spawn = hoop.spawnTime + (M.LINE_DELAY_MS + M.LINE_DRAW_MS + G.ENTRY_DELAY_MS) / 1000;
    const age = game.worldTime - spawn;
    if (age <= 0) return;
    const e = Motion.progress(age, 0, M.PEG_POP_MS / 1000);
    const entry = e >= 1 ? 1 : Motion.easeOutBack(e);

    // Exit: the same signal the pegs use - plain deflation, no bow.
    const exit = game.getElementExitT();
    const presence = Math.max(0, entry * (1 - exit));
    if (presence <= 0.001) return;

    // The bob: parabolic in time, so it DWELLS at the top (as a real ball
    // does at apex) and passes quickly through the point nearest the rim.
    const p = ((game.worldTime * 1000) % G.PERIOD_MS) / G.PERIOD_MS;
    const d = (2 * p - 1) * (2 * p - 1);      // 1 at the dip, 0 at the top
    const gap = (G.GAP_LOW + (G.GAP_TOP - G.GAP_LOW) * (1 - d)) * game.cellRes;

    const cx = (hoop.node1.pixelX + hoop.node2.pixelX) / 2;
    const rimY = hoop.node1.pixelY;
    const y = rimY - gap;
    const R = game.radius * presence;
    const alpha = G.ALPHA * (0.7 + 0.3 * d) * presence;

    // The glyph: an arrow whose TIP sits at the bob position, pointing
    // down at the rim. Stroke weight matches the hoop line so it speaks
    // the board's own language rather than importing an icon.
    const c = this.c;
    const prevAlpha = c.globalAlpha, prevCap = c.lineCap;
    c.fillStyle = game.themeColors.INK;
    c.strokeStyle = game.themeColors.INK;
    c.lineCap = 'round';
    c.globalAlpha = alpha;

    const halfW = game.cellRes * G.WIDTH * presence;
    const h = game.cellRes * G.HEIGHT * presence;
    const lw = CONFIG.RENDER.HOOP_LINE_WIDTH; // Same weight as the hoop line and walls

    if (G.STYLE === 'triangle') {
        c.beginPath();
        c.moveTo(cx - halfW, y - h); c.lineTo(cx + halfW, y - h); c.lineTo(cx, y);
        c.closePath(); c.fill();
    } else if (G.STYLE === 'double') {
        // Two chevrons, the trailing one fainter - a hint of travel.
        c.lineWidth = lw;
        for (let k = 0; k < 2; k++) {
            const yy = y - k * (h + game.cellRes * 0.10);
            c.globalAlpha = alpha * (1 - 0.45 * k);
            c.beginPath();
            c.moveTo(cx - halfW, yy - h * 0.78); c.lineTo(cx, yy); c.lineTo(cx + halfW, yy - h * 0.78);
            c.stroke();
        }
    } else {
        // 'chevron' (default) and 'stem'
        c.lineWidth = lw;
        c.beginPath();
        c.moveTo(cx - halfW, y - h); c.lineTo(cx, y); c.lineTo(cx + halfW, y - h);
        c.stroke();
        if (G.STYLE === 'stem') {
            c.beginPath();
            c.moveTo(cx, y - h - game.cellRes * 0.34 * presence);
            c.lineTo(cx, y - h * 0.15);
            c.stroke();
        }
    }
    c.globalAlpha = prevAlpha;
    c.lineCap = prevCap;
};

/**
 * The build version, centred in the BOTTOM-LEFT cell: score's face and
 * colour role at the corner glyphs' size - so a stale cached build is
 * recognisable at a glance when testing on device.
 */
Renderer.prototype.drawVersionTag = function(game) {
    const cached = this.getCachedText('version', CONFIG.VERSION, CONFIG.RENDER.WEIGHT_WATERMARK,
        game.cellRes * 0.25, game.themeColors.SCORE);
    const leftX = CONFIG.RENDER.TAG_MARGIN_CELLS * game.cellRes;
    const centerY = (game.ROWS - 0.5) * game.cellRes;
    this.c.drawImage(cached.canvas,
        leftX, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * THE COURT'S NAME, bottom-right - the version tag's mirror, in the same
 * whisper: same row, same size, same weight, same faint register, one cell
 * in from its own wall. Two marks that say what you are looking at and what
 * is drawing it.
 *
 * RIGHT-ALIGNED, not centred on the cell: the seed is a date and grows
 * longer than 'v63', so anchoring its right edge keeps the margin constant
 * while the text changes. A custom court (?seed=) shows its own name, which
 * is exactly when knowing it matters most - and is the only way to read
 * back a seed someone shared with you.
 */
Renderer.prototype.drawSeedTag = function(game) {
    if (!CONFIG.RENDER.SHOW_SEED_TAG) return;
    const cached = this.getCachedText('seed', game.courtSeed, CONFIG.RENDER.WEIGHT_WATERMARK,
        game.cellRes * 0.25, game.themeColors.SCORE);
    const rightX = (game.COLUMNS - CONFIG.RENDER.TAG_MARGIN_CELLS) * game.cellRes;
    const centerY = (game.ROWS - 0.5) * game.cellRes;
    this.c.drawImage(cached.canvas,
        rightX - cached.w, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * The light/dark mode toggle: a single glyph in the BEST register,
 * top-right - the environment layer's typography as UI, mirroring the
 * scheme label top-left. Emulates the portfolio site's toggle: the glyph
 * shows what tapping will GIVE you, not what you already have: a moon
 * while the court is light, a sun while it is dark. The current state is
 * already the entire screen - spending one of six top-row cells to repeat
 * it says nothing, whereas naming the destination says something. Tap
 * flips it (see InputHandler); the choice persists. Colour is theme-SOLVED
 * like every element, so the glyph blooms and drains with the world.
 * Glyph note: these characters likely aren't in IBM Plex Mono; canvas
 * falls back to a system face for them - identical behaviour to the site.
 */
Renderer.prototype.drawThemeToggle = function(game) {
    // Destination, not state: dark court -> sun (tap for light),
    // light court -> moon (tap for dark).
    const glyph = (typeof isDarkMode === 'function' && isDarkMode()) ? '\u2739' : '\u23FE';
    const cached = this.getCachedText('mode', glyph, CONFIG.RENDER.WEIGHT_LABEL,
        game.cellRes * 0.5, game.themeColors.BEST);
    // Centred in the TOP-RIGHT-MOST grid cell - the glyph belongs to the
    // lattice, not to a floating margin.
    const centerX = (game.COLUMNS - 0.5) * game.cellRes;
    const centerY = game.viewTopY + 0.5 * game.cellRes;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
};

// --- Other Renderer Methods ---

// drawGrid is only called if CONFIG.RENDER.DRAW_GRID is true.
// Draws ONLY the darker checkerboard alternates: the lighter half is
// CELL_FILL_1 = the background itself, already visible beneath, so painting
// it would be 45 redundant fills per frame. One fillStyle, plain fillRects -
// the whole grid costs almost nothing. (Cell.draw is retired from the frame
// loop; the Cell objects remain as createHoop's placement lattice.)
Renderer.prototype.drawGrid = function(game) {
    const c = this.c;
    const res = game.cellRes;
    c.fillStyle = game.themeColors.CELL_FILL_2;
    for (let y = 0; y < game.ROWS; y++) {
        // Odd (x+y) cells are the CELL_FILL_2 alternates
        for (let x = (y % 2 === 0) ? 1 : 0; x < game.COLUMNS; x += 2) {
            c.fillRect(x * res, y * res, res, res);
        }
    }
};

Renderer.prototype.drawGameObjects = function(objects) {
     const game = this.game;
     objects.forEach(obj => {
        if (typeof obj.draw === 'function') {
            obj.draw(game);
        }
    });
};

// NOTE: drawUI removed - the score/BEST/boundary calls now live inline in
// drawFrame's documented layer order (the score is layer 3, the ENVIRONMENT,
// and must render beneath the world - a wrapper drawn last defeated that).

Renderer.prototype.drawScore = function(game) {
    // The numeral is the LEVEL being attempted, starting at 1 - you stand
    // on level 1, and sinking it moves you to 2. (Internally everything
    // stays streak-based - baskets completed - this is display-layer
    // framing only.)
    const N0 = CONFIG.RENDER.SCORE_NUMERAL;
    const level = (game.displayLevel !== undefined) ? game.displayLevel : game.score + 1;

    // The numeral is TRANSPARENT (so the lattice reads through it) but its
    // visibility must still be SOLVED, not assumed: every other element
    // gets a role-specific contrast ratio against the live background, in
    // both themes, at every hue and streak. So take the theme's calibrated
    // SCORE colour as the appearance we want ON SCREEN, and back-solve the
    // base colour that composites to it at the requested alpha. Contrast
    // is then guaranteed by construction; alpha only decides how much
    // checkerboard shows through.
    const solved = this.solveTransparent(game.themeColors.BACKGROUND,
        game.themeColors.SCORE, (N0 && N0.ALPHA !== undefined) ? N0.ALPHA : 1);
    const cached = this.getCachedText('score', String(level),
        (N0 && N0.WEIGHT) || '400',
        game.cellRes * ((N0 && N0.SIZE_CELLS) || 2), solved.color);
    // Centred in the PLAY AREA as seen: from the visible top down to the
    // shoot boundary. (Not the world's midpoint - that sat below centre
    // once the camera began cropping the sky.)
    const boundaryY = (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes;
    const centerX = (game.COLUMNS * game.cellRes) / 2;
    const centerY = (game.viewTopY + boundaryY) / 2;

    // The turn-over: the old numeral fades out on the world's element-exit
    // signal and the new one fades in with the arriving hoop. (It squashed
    // horizontally at first - too theatrical, and the sliver at the
    // midpoint read as a slide transition rather than as part of this
    // world.) A hold-the-world reset plays neither, so the number simply
    // doesn't move.
    let presence = 1;
    const N = CONFIG.RENDER.SCORE_NUMERAL;
    if (N && N.ANIMATE) {
        const exit = game.getElementExitT();
        let entry = 1;
        const hoop = game.lines[0];
        if (hoop && hoop.spawnTime !== undefined) {
            entry = Motion.progress(game.worldTime - hoop.spawnTime, 0, N.ENTRY_MS / 1000);
        }
        presence = Math.max(0, entry * (1 - exit));
    }
    if (presence <= 0.001) return;

    const prevAlpha = this.c.globalAlpha;
    this.c.globalAlpha = solved.alpha * presence;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
    this.c.globalAlpha = prevAlpha;
};

/**
 * Draws the all-time best streak, small and top-centre, in the same
 * recessive SCORE colour as the big background number. Hidden until a best
 * exists - a first-time player sees nothing to explain.
 */
Renderer.prototype.drawBestStreak = function(game) {
    // INSTRUMENT: while capturing, the label is the session counter - tap
    // it to export. Drawn BEFORE the earned-before-shown guard below: the
    // counter must be visible from throw zero.
    if (Capture.enabled()) {
        const cx = (game.COLUMNS * game.cellRes) / 2;
        const rec = this.getCachedText('best', 'REC ' + Capture.count() + '/' + Capture.target(),
            '600', game.cellRes * 0.5, game.themeColors.BEST);
        this.c.drawImage(rec.canvas, cx - rec.w / 2, game.viewTopY + game.cellRes * 0.9 - rec.h / 2, rec.w, rec.h);
        // Testers usually receive this link without anyone beside them:
        // the protocol has to be legible on the glass itself.
        const done = Capture.count() >= Capture.target();
        const hint = this.getCachedText('captureHint',
            done ? 'TAP HERE TO SEND' : 'SAME THROW EVERY TIME',
            '400', game.cellRes * 0.26, game.themeColors.BEST);
        this.c.drawImage(hint.canvas, cx - hint.w / 2, game.viewTopY + game.cellRes * 1.45 - hint.h / 2, hint.w, hint.h);
        return;
    }

    if (game.bestStreak <= 0) return;
    // THE DAILY RECORD replaces the all-time BEST on the glass (all-time
    // persists in storage for the future clubhouse overlay). Reads as
    // current : summit - cost, e.g. "1:14-9". Hidden until today's first
    // basket (records are earned before shown), and hidden entirely on
    // custom courts (exhibition has no ledger). Same register, same
    // bloom-and-drain, same cache.
    if (game.isCustomCourt || !game.daily || game.daily.best === 0) return;
    // Summit - cost, e.g. "14-9": the highest level COMPLETED today and
    // the misses spent when that summit was first set. Completed-basis
    // keeps the record honest against the attempting-basis numeral: after
    // one basket the centre reads 2, the record reads 1-0.
    const label = game.daily.best + CONFIG.RENDER.RECORD_SEP2 + game.daily.missesAtBest;
    const cached = this.getCachedText('best', label, CONFIG.RENDER.WEIGHT_LABEL,
        game.cellRes * 0.5, game.themeColors.BEST);
    // Centred in the SHOOT AREA - the day's record belongs to the player's
    // own territory, not to the sky. Environment layer, so the resting
    // ball passes in front of it.
    const boundaryY = (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes;
    const centerX = (game.COLUMNS * game.cellRes) / 2;
    const centerY = (boundaryY + game.ROWS * game.cellRes) / 2;
    this.c.drawImage(cached.canvas,
        centerX - cached.w / 2, centerY - cached.h / 2, cached.w, cached.h);
};

/**
 * Beyond the side walls: a flat inverse field, so the wall needs no line
 * to announce itself - the world simply stops. Full viewport height, so
 * the corners belong to the outside rather than to the sky. Drawn only
 * when the viewport is wider than the board; on a phone it never runs.
 */
Renderer.prototype.drawSideFill = function(game) {
    const pad = game.worldOffsetX;
    if (pad <= 0.5) return;
    const dark = (typeof isDarkMode === 'function' && isDarkMode());
    const c = this.c;
    c.fillStyle = dark ? CONFIG.RENDER.SIDE_FILL_DARK : CONFIG.RENDER.SIDE_FILL_LIGHT;
    const top = -game.worldOffsetY;
    c.fillRect(-pad, top, pad, game.viewH);
    c.fillRect(game.COLUMNS * game.cellRes, top, pad, game.viewH);
};

Renderer.prototype.drawCanvasBoundary = function(game) {
    const c = this.c; c.beginPath(); c.setLineDash([]);
    c.lineWidth = CONFIG.RENDER.BOUNDARY_LINE_WIDTH; // Use config
    c.rect(0, 0, game.COLUMNS * game.cellRes, game.ROWS * game.cellRes);
    c.strokeStyle = game.themeColors.BOUNDARY; // Use theme color
    c.stroke();
};

Renderer.prototype.drawShootBoundaryLine = function(game) {
    const c = this.c;
    // While the finger is still below the line mid-aim, releasing would
    // ABORT - the boundary firms up to say "you're still in your own
    // territory", settling the moment the drag crosses into commitment.
    // Zero text; the boundary's second job. It used to firm by thickening
    // a rule; now it firms by weight of dot.
    const rad = game.cellRes * CONFIG.RENDER.SHOOT_DOT_RADIUS;
    const boundaryY = (game.ROWS - CONFIG.GAME.SHOOT_AREA_ROWS) * game.cellRes;
    c.fillStyle = game.themeColors.BOUNDARY;
    // Half-cell spacing across the middle of the board, clear of both
    // walls - the boundary is a measure laid across the court, not a rule
    // fixed to its edges, and nothing is left half-clipped at the screen.
    const step = CONFIG.RENDER.SHOOT_DOT_STEP;
    const from = CONFIG.RENDER.SHOOT_DOT_INSET;
    const to = game.COLUMNS - from;
    for (let x = from; x <= to + 1e-9; x += step) {
        c.beginPath();
        c.arc(x * game.cellRes, boundaryY, rad, 0, Math.PI * 2);
        c.fill();
    }
};