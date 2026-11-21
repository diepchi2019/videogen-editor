// Long video -> short clips: find candidate moments from the transcript, loudness and scene changes.
// Everything runs locally (whisper.cpp for words, ffmpeg for audio and scene detection); picking the
// best candidates by meaning is left to Claude, which reads the excerpts this returns.
import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS_DIR, MEDIA_DIR } from './store.js';
import { run } from './media.js';
import { decodeMono } from './audio.js';

const VERSION = 1;
const r2 = (n) => Math.round(n * 100) / 100;
const cacheFile = (a, kind) => path.join(ANALYSIS_DIR, `${a.file}.${kind}.json`);
function cached(a, kind) {
  try { const j = JSON.parse(fs.readFileSync(cacheFile(a, kind), 'utf8')); if (j.version === VERSION) return j; } catch { /* not cached */ }
  return null;
}
function save(a, kind, data) {
  const j = { version: VERSION, ...data };
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(a, kind), JSON.stringify(j));
  return j;
}

// ---------- Signals ----------
export const ENERGY_STEP = 0.5; // seconds per loudness value
// RMS loudness in dBFS per step (floor -90) from mono samples.
export function energyCurve(x, rate, step = ENERGY_STEP) {
  const n = Math.max(1, Math.round(rate * step)), out = [];
  for (let i = 0; i < x.length; i += n) {
    let s = 0;
    const e = Math.min(x.length, i + n);
    for (let j = i; j < e; j++) s += x[j] * x[j];
    out.push(Math.round(Math.max(-90, 10 * Math.log10(s / Math.max(1, e - i) + 1e-12)) * 10) / 10);
  }
  return out;
}
export async function loudness(a) {
  const c = cached(a, 'energy');
  if (c) return c;
  const rate = 4000;
  const x = await decodeMono(path.join(MEDIA_DIR, a.file), rate);
  return save(a, 'energy', { step: ENERGY_STEP, db: energyCurve(x, rate) });
}
// Shot changes (source seconds) with ffmpeg's scene score, on small frames at 5 fps to keep it quick.
export function parseScenes(stderr) {
  return [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => r2(+m[1]));
}
export async function sceneChanges(a, threshold = 0.35) {
  const c = cached(a, 'scenes');
  if (c) return c;
  let log = '';
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', path.join(MEDIA_DIR, a.file), '-an', '-vf', `fps=5,scale=160:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
    { onStderr: (s) => { log += s; } });
  return save(a, 'scenes', { threshold, times: parseScenes(log) });
}

// ---------- Candidates ----------
// Drop runs of 3+ zero-length words at the same time: whisper sometimes repeats a sentence and the
// repeat collapses onto one instant when its time is mapped back from a cut silence.
export function cleanWords(words) {
  const zero = (w) => w.end - w.start < 0.005;
  return words.filter((w, i) => {
    if (!zero(w)) return true;
    let n = 1;
    for (let j = i - 1; j >= 0 && zero(words[j]) && words[j].start === w.start; j--) n++;
    for (let j = i + 1; j < words.length && zero(words[j]) && words[j].start === w.start; j++) n++;
    return n < 3;
  });
}

// Sentences from timed words: a sentence ends at . ! ? … or before a pause of 0.8s or more.
export function sentences(words) {
  const out = [];
  let cur = null;
  words.forEach((w, i) => {
    if (!cur) { cur = { start: w.start, end: w.end, words: [], i0: i }; out.push(cur); }
    cur.words.push(w); cur.end = w.end; cur.i1 = i;
    const next = words[i + 1];
    if (/[.!?…。！？]["')\]]*$/.test(w.w) || !next || next.start - w.end >= 0.8) cur = null;
  });
  return out.map((s) => ({ ...s, text: s.words.map((w) => w.w).join(' ') }));
}

const HOOK = /^(how|why|what|when|who|here'?s|this is|the (secret|truth|reason|problem|best|worst|one)|never|stop|don'?t|you (need|should|won'?t|can'?t)|imagine|i (never|can'?t believe)|nobody|everyone|most people|did you know)\b/i;
const median = (xs) => { if (!xs.length) return -90; const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

// Score windows of whole sentences between minLen and maxLen seconds. Signals:
// - speech: talking most of the time (few long pauses), at a lively pace
// - energy: louder than the video's median, and loud peaks (laughs, shouts, punchlines)
// - hook: the first sentence is a question or a hook phrase, or has numbers
// - clean edges: starts after a pause and ends on a full stop
// - shots: a few scene changes inside (visual variety)
// - query: words from `query` appear in the text (strongest signal when given)
// - length: close to the target length
export function findMoments({ words: rawWords = [], energy = null, scenes = [], duration }, { minLen = 15, maxLen = 60, target, count = 8, query } = {}) {
  const words = cleanWords(rawWords);
  if (!(maxLen >= minLen)) throw new Error('maxDuration must be at least minDuration');
  const tgt = target ?? (minLen + maxLen) / 2;
  const db = energy?.db || [], step = energy?.step || ENERGY_STEP;
  const med = median(db.filter((v) => v > -80));
  const dbAt = (a, b) => db.slice(Math.floor(a / step), Math.max(Math.floor(a / step) + 1, Math.ceil(b / step)));
  const terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((t) => t.length > 2);
  const sents = sentences(words);
  const cands = [];
  if (sents.length) {
    sents.forEach((s0, i) => {
      const prevGap = i === 0 ? s0.start : s0.start - sents[i - 1].end;
      for (let j = i; j < sents.length; j++) {
        const s1 = sents[j], len = s1.end - s0.start;
        if (len > maxLen) break;
        if (len < minLen) continue;
        const ws = words.slice(s0.i0, s1.i1 + 1);
        let pause = 0;
        for (let k = 1; k < ws.length; k++) pause += Math.max(0, ws[k].start - ws[k - 1].end - 0.5);
        const wps = ws.length / len;
        const e = dbAt(s0.start, s1.end), loud = e.length ? e.reduce((p, q) => p + q, 0) / e.length - med : 0;
        const peaks = e.filter((v) => v > med + 8).length;
        const nextGap = j + 1 < sents.length ? sents[j + 1].start - s1.end : 1;
        const text = sents.slice(i, j + 1).map((s) => s.text).join(' ');
        const first = s0.text;
        const shots = scenes.filter((t) => t > s0.start + 0.3 && t < s1.end - 0.3).length;
        const sc = {
          speech: Math.min(1, 1 - pause / len) * 2 + Math.min(1, wps / 2.8),
          energy: Math.max(-1, Math.min(1.5, loud / 6)) + Math.min(1, peaks / 4),
          hook: (/\?["')]*$/.test(first) ? 0.8 : 0) + (HOOK.test(first) ? 1 : 0) + (/\d/.test(first) ? 0.3 : 0),
          edges: (prevGap >= 0.5 ? 0.6 : 0) + (/[.!?…]["')\]]*$/.test(s1.words.at(-1).w) ? 0.6 : 0) + (nextGap >= 0.5 ? 0.3 : 0),
          shots: Math.min(1, shots / 4) * 0.6,
          // A topic match outranks everything else; more matching words rank higher.
          query: terms.length ? ((k) => (k ? 4 + (2 * k) / terms.length : 0))(terms.filter((t) => text.toLowerCase().includes(t)).length) : 0,
          length: 1 - Math.min(1, Math.abs(len - tgt) / Math.max(5, tgt)),
        };
        // Snap the cut a little outside the words, without running into the neighbours.
        const prevEnd = i > 0 ? sents[i - 1].end : 0, nextStart = j + 1 < sents.length ? sents[j + 1].start : duration ?? s1.end + 1;
        const inT = Math.max(0, prevEnd + 0.05 < s0.start - 0.15 ? s0.start - 0.15 : (prevEnd + s0.start) / 2);
        const outT = Math.min(duration ?? Infinity, nextStart - 0.05 > s1.end + 0.3 ? s1.end + 0.3 : (s1.end + nextStart) / 2);
        cands.push({ in: r2(inT), out: r2(outT), score: Object.values(sc).reduce((p, q) => p + q, 0), parts: sc, text, first, shots, peaks });
      }
    });
  } else if (duration) {
    // No speech: windows between scene changes, scored by loudness and peaks.
    const cuts = [0, ...scenes.filter((t) => t > 0 && t < duration), duration];
    for (let i = 0; i < cuts.length - 1; i++) {
      for (let j = i + 1; j < cuts.length; j++) {
        const a = cuts[i], b = cuts[j], len = b - a;
        if (len > maxLen) break;
        if (len < minLen) continue;
        const e = dbAt(a, b), loud = e.length ? e.reduce((p, q) => p + q, 0) / e.length - med : 0;
        const peaks = e.filter((v) => v > med + 8).length;
        const sc = { energy: Math.max(-1, Math.min(1.5, loud / 6)) + Math.min(1, peaks / 4), shots: Math.min(1, (j - i - 1) / 4), length: 1 - Math.min(1, Math.abs(len - tgt) / Math.max(5, tgt)) };
        cands.push({ in: r2(a), out: r2(b), score: Object.values(sc).reduce((p, q) => p + q, 0), parts: sc, text: '', first: '', shots: j - i - 1, peaks });
      }
    }
  }
  // Best first, no overlaps.
  cands.sort((p, q) => q.score - p.score);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.some((p) => c.in < p.out && c.out > p.in)) continue;
    picked.push(c);
  }
  return picked.map((c, k) => ({ rank: k + 1, ...c, score: r2(c.score), parts: Object.fromEntries(Object.entries(c.parts).map(([key, v]) => [key, r2(v)])), duration: r2(c.out - c.in) }));
}

// Why a candidate scored well, in a few words.
export function reasons(m) {
  const p = m.parts, out = [];
  if (p.query >= 1) out.push('matches the query');
  if (p.hook >= 0.8) out.push(/\?/.test(m.first) ? 'opens with a question' : 'hook opening');
  if (p.energy >= 1) out.push(m.peaks ? `lively (${m.peaks} loud peaks)` : 'louder than average');
  if (p.speech >= 2.5) out.push('continuous talking');
  if (p.edges >= 1.2) out.push('clean start and end');
  if (m.shots >= 2) out.push(`${m.shots} shot changes`);
  return out.join(', ') || 'balanced';
}

export function momentsText(a, list, { hasWords }) {
  if (!list.length) return `No moments of that length found in "${a.name}". Try a shorter minDuration or a longer maxDuration.`;
  const lines = list.map((m) => {
    const t = m.text.length > 420 ? `${m.text.slice(0, 420)}…` : m.text;
    return `${m.rank}. source ${m.in}-${m.out}s (${m.duration}s), score ${m.score}: ${reasons(m)}${t ? `\n   "${t}"` : ''}`;
  });
  return [`Candidate moments in "${a.name}" (${a.duration.toFixed(1)}s), best first, SOURCE seconds${hasWords ? '' : ' (no speech transcript: chosen by loudness and shot changes)'}:`,
    ...lines,
    '', 'Read the excerpts and pick the ones that work on their own (a complete thought, a payoff at the end). Adjust in/out with get_transcript if needed, then make_short for each.'].join('\n');
}
