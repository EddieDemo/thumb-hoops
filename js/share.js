// File: js/share.js
'use strict';

/**
 * THE SOCIAL LAYER — one block of text, and no server.
 *
 * Wordle's entire social mechanic was a string you pasted into a chat. No
 * accounts, no leaderboard, no backend. That is exactly this game's
 * constraint, so it is exactly this game's model.
 *
 * Four properties are what made that format work, and all four are copied
 * here deliberately:
 *
 *   PURE TEXT   - renders identically in WhatsApp, Slack, SMS, anywhere.
 *                 No image hosting, no OG card, no infrastructure.
 *   SPOILER-FREE- the circles show the SHAPE of a day, never the court's
 *                 layout. Nothing here helps or spoils the receiver.
 *   GLANCEABLE  - recognisable before it is read.
 *   IT TELLS A  - you can see someone wobble and recover. Two numbers say
 *   STORY         what happened; the picture says how it felt.
 *
 * THE DAY IS TRUNCATED AT THE SUMMIT, and that is not an aesthetic choice.
 * The ledger's founding rule is that PLAYING MORE CAN NEVER WORSEN YOUR
 * RECORD. If the string showed the whole day, every attempt after your best
 * run would add another hollow circle and make the share look worse - the
 * rule would hold for the number and break for the picture. So the string
 * ends at the moment the record was set, exactly like missesAtBest does.
 *
 * THE LINK CARRIES THE SEED, so one tap puts the receiver on the identical
 * court. That is the part most serverless games forget: the receiver has to
 * land somewhere that makes sense with no explanation.
 */
var Share = (function() {

    /** '2026-07-28' -> '28 Jul'. Anything else is passed through as-is. */
    function prettyDate(seed) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(seed || '');
        if (!m) return seed;
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return String(parseInt(m[3], 10)) + ' ' + MONTHS[parseInt(m[2], 10) - 1];
    }

    /** The court's own URL, so a tap lands on this exact seed. */
    function courtURL(game) {
        try {
            const l = window.location;
            return l.origin + l.pathname + '?seed=' + encodeURIComponent(game.courtSeed);
        } catch (e) {
            return '?seed=' + game.courtSeed;
        }
    }

    /**
     * The day's shape: one glyph per attempt, up to and including the
     * summit. Long days are trimmed from the FRONT (keeping the ending,
     * which is the part that matters) with a leading ellipsis.
     */
    function shapeOf(seq) {
        const S = CONFIG.SHARE;
        if (!seq || !seq.length) return '';
        let cut = seq;
        let prefix = '';
        if (seq.length > S.MAX_GLYPHS) {
            cut = seq.slice(seq.length - S.MAX_GLYPHS);
            prefix = S.TRIM_MARK;
        }
        return prefix + cut.map(v => (v ? S.MADE : S.MISSED)).join('');
    }

    /**
     * @returns {string|null} the shareable block, or null if there is
     *          nothing worth sharing (no basket yet, or a custom court -
     *          exhibition play keeps no ledger, so it has no result).
     */
    function buildDaily(game) {
        if (!game || game.isCustomCourt) return null;
        const d = game.daily;
        if (!d || !d.best) return null;

        const lines = [
            CONFIG.SHARE.TITLE + ' \u00b7 ' + prettyDate(d.seed),
            d.best + ' in ' + d.missesAtBest
        ];
        // noShape: a day that was already underway when shape-recording
        // arrived. It keeps its numbers and forgoes the picture (see the
        // migration note in game.js) rather than draw one that disagrees.
        const shape = d.noShape ? '' : shapeOf(d.seqAtBest);
        if (shape) lines.push('', shape);
        lines.push('', courtURL(game));
        return lines.join('\n');
    }

    /**
     * Hand the text to the device. Native share sheet where there is one
     * (iOS needs a user gesture, which a tap is), clipboard otherwise.
     * Never throws: this is called from an input handler.
     */
    function shareDaily(game) {
        const text = buildDaily(game);
        if (!text) return false;

        // ACKNOWLEDGEMENT. A copy to the clipboard is invisible, so without
        // this the button does nothing you can perceive. The gong marks the
        // day being set down.
        //
        // (Note it now marks three things: a run ending, the theme
        // changing, and this. Each is defensible alone, but a sound that
        // answers everything eventually says nothing - if it starts to feel
        // spent, CONFIG.SHARE.SOUND accepts 'kenong', which is punctuation
        // rather than closure and leaves the gong to mean one thing.)
        if (typeof Audio !== 'undefined' && CONFIG.SHARE.SOUND) {
            if (CONFIG.SHARE.SOUND === 'kenong') Audio.kenong();
            else Audio.gong(0);
        }

        try {
            if (navigator.share) {
                navigator.share({ text: text }).catch(() => copy(text));
            } else {
                copy(text);
            }
        } catch (e) {
            copy(text);
        }
        return true;
    }

    function copy(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text);
                dbg('Share: copied to clipboard.');
                return;
            }
        } catch (e) { /* fall through */ }
        dbg('Share: no clipboard available.\n' + text);
    }

    /** Is there a result to share? Drives the glyph's visibility. */
    function hasResult(game) {
        return !!(game && !game.isCustomCourt && game.daily && game.daily.best > 0);
    }

    return {
        buildDaily: buildDaily,
        shareDaily: shareDaily,
        hasResult: hasResult,
        prettyDate: prettyDate,
        shapeOf: shapeOf
    };
})();