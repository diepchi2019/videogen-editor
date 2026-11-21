// Edit by text: the timeline transcript (speech words in timeline seconds) and what to cut for words,
// retakes and B-roll. Pure and unit-tested; the tools in tools.js gather the words and apply delete_range.
import { norm } from './pauses.js';

const r3 = (n) => Math.round(n * 1000) / 1000;
const endsSentence = (w) => /[.!?…]["')\]]*$/.test(w);

// Readable lines: a new line at a sentence end, a pause of 0.6s or 14 words. Each word keeps its index.
export function transcriptLines(words) {
  const lines = [];
  let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (!cur || endsSentence(prev.w) || w.start - prev.end > 0.6 || cur.words.length >= 14) lines.push(cur = { start: w.start, words: [] });
    cur.words.push({ ...w, i });
    cur.end = w.end;
  });
  return lines;
}
export function transcriptText(words, { from = 0, to = Infinity } = {}) {
  return transcriptLines(words).filter((l) => l.end > from && l.start < to)
    .map((l) => `[${l.start.toFixed(2)}-${l.end.toFixed(2)}] ${l.words.map((w) => w.w).join(' ')}`).join('\n');
}

// Timeline range that removes words i..j with the pauses around them, leaving a short breath (0.1s each side).
export function cutRange(words, i, j) {
  const a = words[i], b = words[j], prev = words[i - 1], next = words[j + 1];
  return { start: r3(prev ? Math.min(a.start, prev.end + 0.1) : a.start), end: r3(next ? Math.max(b.end, next.start - 0.1) : b.end + 0.15) };
}
// Where a phrase is said: [{i, j}] word indexes (case and punctuation ignored).
export function findWords(words, text) {
  const want = String(text).split(/\s+/).map(norm).filter(Boolean), tok = words.map((w) => norm(w.w)), out = [];
  if (!want.length) return out;
  for (let i = 0; i + want.length <= tok.length; i++) if (want.every((x, k) => tok[i + k] === x)) out.push({ i, j: i + want.length - 1 });
  return out;
}
// Words whose middle lies in start..end (a selection in the transcript panel), as {i, j} or null.
export function wordsIn(words, start, end) {
  const ids = words.map((w, i) => ((w.start + w.end) / 2 >= start && (w.start + w.end) / 2 <= end ? i : -1)).filter((i) => i >= 0);
  return ids.length ? { i: ids[0], j: ids[ids.length - 1] } : null;
}
// Merge overlapping ranges, sorted.
export function mergeRanges(rs) {
  const out = [];
  for (const r of [...rs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end); else out.push({ ...r });
  }
  return out;
}

// Retakes: an attempt that is started again. Word i starts an attempt (start of speech, after a sentence end or
// a pause of 0.25s+); a later restart j (after a pause of 0.2s+, a sentence end or a dash) repeats its first
// words, at least minWords and 60% of the attempt, within `window` seconds. The attempt i..j-1 goes and the
// last take stays (chains of attempts collapse onto the last). Returns [{i, j, start, end, text, kept}].
export function findRetakes(words, { minWords = 2, window = 12, maxWords = 30 } = {}) {
  const tok = words.map((w) => norm(w.w));
  const gapBefore = (k) => (k === 0 ? Infinity : words[k].start - words[k - 1].end);
  const startsAttempt = (k) => k === 0 || endsSentence(words[k - 1].w) || gapBefore(k) >= 0.25;
  const restart = (k) => gapBefore(k) >= 0.2 || endsSentence(words[k - 1].w) || /[-–—…]$/.test(words[k - 1].w);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (!startsAttempt(i) || !tok[i]) continue;
    for (let j = i + 1; j < words.length && j - i <= maxWords && words[j].start - words[i].start <= window; j++) {
      if (!restart(j) || tok[j] !== tok[i]) continue;
      let m = 0;
      while (i + m < j && j + m < tok.length && tok[i + m] === tok[j + m]) m++;
      if (m < minWords || m < Math.ceil(0.6 * (j - i))) continue;
      const r = cutRange(words, i, j - 1);
      out.push({ i, j, start: r.start, end: r.end, text: words.slice(i, j).map((w) => w.w).join(' '), kept: words.slice(j, j + Math.max(m + 2, 4)).map((w) => w.w).join(' ') });
      i = j - 1; // the take at j may itself be retaken
      break;
    }
  }
  return out;
}

// B-roll by file name: an unused video/photo whose name has a word (4+ letters) that is said. Each asset once,
// at its first mention, no two overlapping. assets: [{id, name}]. Returns [{assetId, word, start, end}].
export function matchBroll(assets, words, { length = 3 } = {}) {
  const tok = words.map((w) => norm(w.w).replace(/s$/, ''));
  const picks = [];
  for (const a of assets) {
    const keys = String(a.name).replace(/\.[^.]+$/, '').split(/[^\p{L}\p{N}]+/u).map((x) => norm(x).replace(/s$/, '')).filter((x) => x.length >= 4);
    const k = tok.findIndex((t, i) => keys.includes(t) && !picks.some((p) => words[i].start < p.end && words[i].start + length > p.start));
    if (k >= 0) picks.push({ assetId: a.id, word: words[k].w, start: r3(words[k].start), end: r3(words[k].start + length) });
  }
  return picks.sort((a, b) => a.start - b.start);
}
