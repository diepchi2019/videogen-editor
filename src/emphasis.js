// Emphasis for talking-head edits: which caption words to highlight, and where to zoom in.
// Pure functions (unit-tested); emphasize_captions and auto_zoom in tools.js gather the inputs and apply them.
import { norm } from './pauses.js';

const STOP = new Set(`about above after again against because before being below between could doing during
further having itself myself other ourselves should their theirs themselves there these they this those through under
until which while would yourself yourselves really actually something anything everything nothing people things thing
going gonna wanna maybe pretty little right still where whatever though thought always never every think
những được không người chúng nhưng trong cũng này khi thì là của và các một có cho với đã sẽ rất như vì nên
đến từ ra vào lại đó để mình bạn tôi`.split(/\s+/).map(norm));
const letters = (w) => norm(w).replace(/\p{N}/gu, '');
const isNumberish = (w) => /\p{N}/u.test(w) || /[$€£¥₫%]/.test(w);

// Automatic picks when Claude has not chosen: every word with a number or money/percent sign (up to 2 a line),
// and in a line without one the longest content word (6+ letters, not a common word), skipping a line after a
// pick so the highlights stay special. Returns [{lineId, index}].
export function pickKeywords(lines) {
  const marks = [];
  let lastPick = -2;
  lines.forEach((l, li) => {
    const nums = l.words.map((w, i) => (isNumberish(w.w) ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    if (nums.length) { nums.forEach((index) => marks.push({ lineId: l.id, index })); lastPick = li; return; }
    if (li - lastPick < 2) return;
    let best = -1, len = 5;
    l.words.forEach((w, i) => { const s = letters(w.w); if (s.length > len && !STOP.has(s)) { best = i; len = s.length; } });
    if (best >= 0) { marks.push({ lineId: l.id, index: best }); lastPick = li; }
  });
  return marks;
}

// Where a word or phrase is said in the captions: [{lineId, from, to (word indexes), start}].
// Matching ignores case and punctuation; a phrase must sit inside one line.
export function findPhrase(lines, text) {
  const want = String(text).split(/\s+/).map(norm).filter(Boolean);
  const hits = [];
  if (!want.length) return hits;
  for (const l of lines) {
    const ws = l.words.map((w) => norm(w.w));
    for (let i = 0; i + want.length <= ws.length; i++) {
      if (want.every((x, k) => ws[i + k] === x)) hits.push({ lineId: l.id, from: i, to: i + want.length - 1, start: l.words[i].start });
    }
  }
  return hits;
}

// Plan an auto zoom. clips: layout clips ({id, assetId, in, out, start, end, transition}).
// - cuts: in a run of jump cuts (the same file continuing forward with no transition) every other clip is framed
//   tighter (scale = amount), the classic way to hide the jump.
// - punches: short zoom-ins at the given times (Claude's picks or emphasized caption words), or else at the
//   loudest words (loudWords: [{start, end, db}]), at least `gap` seconds apart, about one per 4 s at most.
// Returns { clips: [{clipId, scale, punches: [{t, hold}]}], jumpCuts, punches }.
export function planAutoZoom(clips, { amount = 1.15, cuts = true, times = null, loudWords = [], gap = 2.5, hold = 1.2 } = {}) {
  const plan = new Map(clips.map((c) => [c.id, { clipId: c.id, scale: 1, punches: [] }]));
  let jumpCuts = 0;
  if (cuts) {
    let k = 0;
    clips.forEach((c, i) => {
      const prev = clips[i - 1];
      const jump = prev && prev.assetId === c.assetId && (!c.transition?.type || c.transition.type === 'none') && c.in >= prev.out - 0.05;
      k = jump ? k + 1 : 0;
      if (jump) jumpCuts++;
      if (k % 2 === 1) plan.get(c.id).scale = amount;
    });
  }
  let want = times ? times.map(Number).filter(Number.isFinite) : null;
  if (!want && loudWords.length) {
    const dbs = loudWords.map((w) => w.db).sort((a, b) => a - b), med = dbs[Math.floor(dbs.length / 2)];
    const total = clips.length ? clips[clips.length - 1].end - clips[0].start : 0;
    want = loudWords.filter((w) => w.db >= med + 3 && w.end - w.start >= 0.12).sort((a, b) => b.db - a.db).map((w) => w.start).slice(0, Math.max(1, Math.floor(total / 4)) * 3);
  }
  const taken = [];
  let punches = 0;
  for (const t of want || []) {
    // Emphasis often sits right at a cut after remove_silences, so only the very edges are left out.
    const c = clips.find((x) => t >= x.start + 0.1 && t <= x.end - 0.25);
    if (!c || taken.some((x) => Math.abs(x - t) < gap)) continue;
    const total = clips[clips.length - 1].end - clips[0].start;
    if (!times && taken.length >= Math.max(1, Math.floor(total / 4))) break;
    taken.push(t);
    plan.get(c.id).punches.push({ t: Math.round(t * 1000) / 1000, hold: Math.round(Math.max(0.2, Math.min(hold, c.end - t - 0.05)) * 1000) / 1000 });
    punches++;
  }
  return { clips: [...plan.values()].filter((e) => e.scale !== 1 || e.punches.length), jumpCuts, punches };
}
