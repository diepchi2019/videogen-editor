// Remove silences and filler words: find timeline ranges to cut from the Whisper words, checked
// against a fine loudness curve so gaps that still have sound (music, words Whisper did not write)
// are left alone. The cuts are applied with delete_range (see remove_silences in tools.js).
import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS_DIR, MEDIA_DIR } from './store.js';
import { decodeMono } from './audio.js';
import { energyCurve } from './moments.js';

// Words that are only hesitation sounds. Kept short on purpose: "like", "you know", Vietnamese "à"/"ừ"
// carry meaning often enough that Claude should decide (get_transcript + delete_range).
export const FILLERS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'hmm', 'hm', 'mm', 'mhm', 'ah', 'eh',
  'ờ', 'ơ', 'ừm', 'ờm', 'ưm', 'hừm'];
export const norm = (w) => String(w).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '');
const r3 = (n) => Math.round(n * 1000) / 1000;

const FINE_STEP = 0.05, VERSION = 1;
// RMS loudness in dBFS every 50 ms (the find_moments curve is 0.5 s, too coarse for short pauses).
export async function fineLoudness(a) {
  const f = path.join(ANALYSIS_DIR, `${a.file}.energy50.json`);
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.version === VERSION) return j; } catch { /* not cached */ }
  const rate = 8000;
  const j = { version: VERSION, step: FINE_STEP, db: energyCurve(await decodeMono(path.join(MEDIA_DIR, a.file), rate), rate, FINE_STEP) };
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j));
  return j;
}
// Loudest value of a curve between source seconds a and b (-90 when the range is empty).
export function peakDb(curve, a, b) {
  const i0 = Math.max(0, Math.floor(Math.min(a, b) / curve.step)), i1 = Math.min(curve.db.length, Math.ceil(Math.max(a, b) / curve.step));
  let m = -90;
  for (let i = i0; i < i1; i++) m = Math.max(m, curve.db[i]);
  return m;
}
// Runs of the curve below thr dB inside source seconds a..b, as [{s, e}] clamped to a..b.
export function quietRuns(curve, a, b, thr) {
  const out = [];
  const i0 = Math.max(0, Math.floor(a / curve.step)), i1 = Math.min(curve.db.length, Math.ceil(b / curve.step));
  for (let i = i0; i < i1; i++) {
    if (curve.db[i] >= thr) continue;
    const s = Math.max(a, i * curve.step), e = Math.min(b, (i + 1) * curve.step);
    if (out.length && Math.abs(out[out.length - 1].e - s) < 1e-9) out[out.length - 1].e = e; else out.push({ s, e });
  }
  return out;
}

// spans: one per main-track clip, in timeline seconds:
//   { lo, hi, words: [{w, start, end}], level?(a, b) -> peak dB, quiet?(a, b, thr) -> [{s, e}] runs below thr }.
// Cuts are made only inside lo..hi (outside transition overlaps). Whisper's word times are rough (a word often
// "ends" before the voice fades), so with level/quiet a pause is the quiet stretch the loudness curve finds
// between two words: a stretch longer than minPause is cut down to keep seconds on each side, and a gap with
// no such stretch is left (counted in keptSound: music, or words Whisper did not write). "Quiet" is soundGap dB
// below the median word peak. Without level/quiet the word times are used as they are. A filler word is cut
// with the pause around it, whatever its length.
// Returns { cuts: [{start, end, kind, fillers?}], keptSound, fillers: {word: count} } sorted by start.
export function findPauseCuts(spans, { minPause = 0.6, keep = 0.15, fillers = true, extraFillers = [], ignoreSound = false, soundGap = 12 } = {}) {
  const isFiller = new Set([...FILLERS, ...extraFillers.map(norm)].filter(Boolean));
  const cuts = [], filled = {};
  let keptSound = 0;
  const push = (a, b, kind, inGap) => {
    if (b - a < 0.08) return;
    for (const w of inGap || []) filled[norm(w.w)] = (filled[norm(w.w)] || 0) + 1;
    cuts.push({ start: r3(a), end: r3(b), kind, ...(inGap?.length ? { fillers: inGap.map((w) => w.w) } : {}) });
  };
  for (const sp of spans) {
    const ws = sp.words.filter((w) => (w.start + w.end) / 2 >= sp.lo && (w.start + w.end) / 2 <= sp.hi).sort((p, q) => p.start - q.start);
    if (!ws.length) continue; // no speech: not ours to cut
    const kept = [], dropped = [];
    for (const w of ws) (fillers && isFiller.has(norm(w.w)) ? dropped : kept).push(w);
    const useSound = sp.level && sp.quiet && !ignoreSound;
    const levels = useSound ? kept.map((w) => sp.level(w.start, w.end)).sort((p, q) => p - q) : [];
    const thr = levels.length ? levels[Math.floor(levels.length / 2)] - soundGap : null;
    // Gaps between the words that stay (clip edges count as words), with the fillers that fall in them.
    const marks = [{ end: sp.lo, edge: true }, ...kept, { start: sp.hi, edge: true }];
    for (let i = 1; i < marks.length; i++) {
      const prev = marks[i - 1], next = marks[i];
      if (prev.edge && next.edge) continue; // only fillers in the clip: leave it
      const ga = prev.edge ? sp.lo : prev.end, gb = next.edge ? sp.hi : next.start;
      const inGap = dropped.filter((w) => w.start >= ga - 0.05 && w.end <= gb + 0.05);
      const kind = inGap.length ? 'filler' : prev.edge || next.edge ? 'edge' : 'pause';
      const pad = (x, edge, dir) => (edge ? x : x + dir * keep);
      if (inGap.length) { push(pad(ga, prev.edge, 1), pad(gb, next.edge, -1), kind, inGap); continue; }
      if (thr === null) { if (gb - ga >= minPause) push(pad(ga, prev.edge, 1), pad(gb, next.edge, -1), kind); continue; }
      const runs = sp.quiet(ga, gb, thr).filter((r) => r.e - r.s >= minPause);
      if (!runs.length) { if (gb - ga >= minPause) keptSound++; continue; }
      for (const r of runs) push(pad(r.s, prev.edge && r.s <= ga + 1e-6, 1), pad(r.e, next.edge && r.e >= gb - 1e-6, -1), kind);
    }
  }
  return { cuts: cuts.sort((p, q) => p.start - q.start), keptSound, fillers: filled };
}
