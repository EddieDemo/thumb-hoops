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
     * The day as a list of RUN LENGTHS. A miss ends a run, so a day is a
     * sequence of runs - 3, then 2, then 7 - and that sequence is the shape
     * of the struggle: where the wall was, whether you warmed up or faded,
     * whether the summit came early or after a fight.
     *
     * A run of 0 is a miss with nothing before it, and it stays in the
     * list: "I missed three straight before I scored" is part of the day.
     *
     * Because the sequence is truncated at the summit, the LAST run is the
     * best one and every earlier run cost exactly one miss - so
     * `runs.length - 1` IS the cost printed above. The two lines cannot
     * disagree; they are the same fact counted twice.
     */
    function runsOf(seq) {
        if (!seq || !seq.length) return [];
        const runs = [];
        let n = 0;
        for (let i = 0; i < seq.length; i++) {
            if (seq[i]) n++;
            else { runs.push(n); n = 0; }
        }
        runs.push(n);            // the run in progress at the summit
        return runs;
    }

    /** Long days are trimmed from the FRONT: the ending is what matters. */
    function trimRuns(runs) {
        const S = CONFIG.SHARE;
        return (runs.length > S.MAX_RUNS)
            ? { runs: runs.slice(runs.length - S.MAX_RUNS), trimmed: true }
            : { runs: runs, trimmed: false };
    }

    /**
     * One block per run, scaled to the day's own best. Seen rather than
     * read - the summit is simply the tallest bar - and eight characters
     * where the old per-attempt dots needed forty.
     */
    function sparkOf(runs) {
        const S = CONFIG.SHARE;
        if (!runs.length) return '';
        const blocks = S.SPARK;
        const top = Math.max.apply(null, runs);
        return runs.map(v => {
            const t = (top > 0) ? v / top : 0;
            return blocks[Math.min(blocks.length - 1, Math.round(t * (blocks.length - 1)))];
        }).join('');
    }

    /** The same runs as numbers, for anyone who wants the detail. */
    function digitsOf(runs) {
        return runs.join(CONFIG.SHARE.RUN_SEP);
    }

    /**
     * @returns {string|null} the shareable block, or null if there is
     *          nothing worth sharing (no basket yet, or a custom court -
     *          exhibition play keeps no ledger, so it has no result).
     */
    function buildDaily(game) {
        if (!game || (game.isExhibition && game.isExhibition())) return null;
        const d = game.daily;
        if (!d) return null;

        // A date reads as a date; anything else is named as a seed, so a
        // shared custom court says plainly which board to load. Without the
        // word, a bare number in the header looks like part of the score.
        const isDate = /^\d{4}-\d{2}-\d{2}$/.test(d.seed || '');
        const label = isDate ? prettyDate(d.seed) : ('seed ' + d.seed);
        const lines = [
            CONFIG.SHARE.TITLE + ' \u00b7 ' + label,
            d.best + ' in ' + d.missesAtBest
        ];
        // noShape: a day that was already underway when shape-recording
        // arrived. It keeps its numbers and forgoes the picture (see the
        // migration note in game.js) rather than draw one that disagrees.
        // noShape: a day already underway when shape-recording arrived. It
        // keeps its numbers and forgoes the picture (see the migration note
        // in game.js) rather than draw one that disagrees.
        if (!d.noShape) {
            const t = trimRuns(runsOf(d.seqAtBest));
            if (t.runs.length) {
                const mark = t.trimmed ? CONFIG.SHARE.TRIM_MARK : '';
                // The bars for the eye, the numbers for the curious. Two
                // short lines, and neither needs a legend because the
                // second explains the first.
                lines.push('', mark + sparkOf(t.runs), mark + digitsOf(t.runs));
            }
        }
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
        // Present for any real run, from the first frame - see the note on
        // the record label. A share of 0 in 0 is a true statement about a
        // day that has not started, and a control that is always there is
        // better than one that appears mid-run.
        return !!(game && !(game.isExhibition && game.isExhibition()) && game.daily);
    }

    return {
        buildDaily: buildDaily,
        shareDaily: shareDaily,
        hasResult: hasResult,
        prettyDate: prettyDate,
        runsOf: runsOf,
        sparkOf: sparkOf,
        digitsOf: digitsOf
    };
})();