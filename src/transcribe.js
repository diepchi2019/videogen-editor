// Speech to text with word timestamps, using ffmpeg's built-in whisper filter (whisper.cpp).
// Results are cached per media file in data/analysis/<file>.words.json.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './media.js';
import { decodeMono } from './audio.js';
import { ANALYSIS_DIR, MEDIA_DIR, DATA_DIR } from './store.js';

const q = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

// Most accurate first: large-v3-turbo (q5_0 is ~550 MB, close to large-v3), then small, base, tiny.
export const MODEL_FILES = ['ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo.bin', 'ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin'];
export const MODEL_HELP = 'No whisper model found. Download one into models/, e.g. ' +
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin (most accurate) or ggml-base.bin (fastest), ' +
  'or set VIDEOGEN_WHISPER_MODEL to a model file.';
export function modelPath() {
  if (process.env.VIDEOGEN_WHISPER_MODEL) return fs.existsSync(process.env.VIDEOGEN_WHISPER_MODEL) ? process.env.VIDEOGEN_WHISPER_MODEL : null;
  const dirs = [path.resolve('models'), path.join(DATA_DIR, 'models')];
  for (const f of MODEL_FILES) for (const d of dirs) if (fs.existsSync(path.join(d, f))) return path.join(d, f);
  return null;
}

const cacheFile = (asset) => path.join(ANALYSIS_DIR, `${asset.file}.words.json`);
export const hasTranscript = (asset) => fs.existsSync(cacheFile(asset));
export function readTranscript(asset) {
  try { return JSON.parse(fs.readFileSync(cacheFile(asset), 'utf8')); } catch { return null; }
}

// The filter emits one trimmed token per segment (max_len=1). Contractions ('s, n't)
// and bare punctuation are glued onto the previous word; markers like [BLANK_AUDIO] are dropped.
export function mergeTokens(tokens) {
  const words = [];
  for (const t of tokens) {
    const piece = String(t.text ?? '').replace(/\s+/g, ' ').trim();
    if (!piece || /^[[(].*[\])]$/.test(piece)) continue;
    const prev = words[words.length - 1];
    const glue = prev && /^(['’]\p{L}*|n['’]t|[.,!?%:;…]+)$/iu.test(piece) && t.start - prev.end < 0.05;
    if (glue) { prev.w += piece; prev.end = t.end; } else words.push({ w: piece, start: t.start, end: t.end });
  }
  return words;
}

// Whisper stretches the first words of a chunk back over any silence before them, and makes up
// words ("Thank you.") in long quiet parts. So long quiet runs are cut out before transcribing,
// keeping PAD s of room around speech, and word times are mapped back through the cut list.
// Pure, for tests: x = mono samples at `rate`. Returns kept source ranges [{from, to, at}],
// `at` = where the range starts in the shortened audio.
export const VAD = { frame: 0.02, minGap: 0.8, pad: 0.2 };
export function speechRanges(x, rate, { frame = VAD.frame, minGap = VAD.minGap, pad = VAD.pad } = {}) {
  const dur = x.length / rate, n = Math.floor(x.length / (frame * rate));
  if (!n) return [{ from: 0, to: dur, at: 0 }];
  const db = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  for (let f = 0, k = Math.round(frame * rate); f < n; f++) {
    let e = 0;
    for (let i = f * k; i < (f + 1) * k; i++) e += x[i] * x[i];
    db[f] = 10 * Math.log10(e / k + 1e-12);
  }
  const thr = Math.max(-60, Math.min(-30, 10 * Math.log10(sum / x.length + 1e-12) - 24));
  const cuts = [];
  for (let f = 0; f < n;) {
    if (db[f] >= thr) { f++; continue; }
    let g = f; while (g < n && db[g] < thr) g++;
    const s = f * frame, e = g >= n ? dur : g * frame;
    if (e - s >= minGap) cuts.push([s === 0 ? 0 : s + pad, e >= dur ? dur : e - pad]);
    f = g;
  }
  const ranges = [];
  let t = 0, at = 0;
  for (const [s, e] of cuts) {
    if (s > t) { ranges.push({ from: t, to: s, at }); at += s - t; }
    t = e;
  }
  if (t < dur) ranges.push({ from: t, to: dur, at });
  return ranges;
}
// Shortened-audio time -> source time. A time in no range (past the end) uses the last one.
export function toSource(t, ranges) {
  let r = ranges[0];
  for (const x of ranges) { if (x.at <= t) r = x; else break; }
  return r ? Math.min(r.to, r.from + (t - r.at)) : t;
}
// Map words back to source time. Whisper reports words back to back (each starts where the last
// ended), so a word can straddle a cut. No word spans a long silence, so it goes to one side:
// after the pause when the previous word ends a sentence, otherwise the side holding most of it.
const rangeAt = (t, ranges) => { let i = 0; while (i + 1 < ranges.length && ranges[i + 1].at <= t) i++; return i; };
const ENDS_SENTENCE = /[.!?…。！？]["'”’)]*$/;
export function mapWords(words, ranges, pad = VAD.pad) {
  if (ranges.length === 1 && ranges[0].from === 0) return words;
  return words.map((w, i) => {
    const a = rangeAt(w.start, ranges), b = rangeAt(Math.max(w.start, w.end - 1e-6), ranges);
    let start = toSource(w.start, ranges), end = toSource(w.end, ranges);
    if (a !== b) {
      const ra = ranges[a], rb = ranges[b];
      const later = (i > 0 && ENDS_SENTENCE.test(words[i - 1].w)) || w.end - rb.at >= ra.at + (ra.to - ra.from) - w.start;
      if (later) start = Math.min(end, rb.from + pad);
      else end = Math.max(start, ra.to - pad);
    }
    return { ...w, start, end: Math.max(start, end) };
  });
}

const TRANSCRIPT_VERSION = 2; // 2: silences cut before whisper (older caches had early word times after pauses)
const inflight = new Map();
export function transcribe(asset, { language = 'auto', force = false } = {}) {
  if (asset.type === 'image') return Promise.reject(new Error(`${asset.id} is an image and has no audio`));
  if (asset.type === 'video' && !asset.hasAudio) return Promise.reject(new Error(`${asset.id} has no audio track`));
  if (!force) { const c = readTranscript(asset); if (c && c.version === TRANSCRIPT_VERSION) return Promise.resolve(c); }
  if (inflight.has(asset.id)) return inflight.get(asset.id);
  const model = modelPath();
  if (!model) return Promise.reject(new Error(MODEL_HELP));
  const tmp = path.join(ANALYSIS_DIR, `${asset.file}.${process.pid}.${Date.now()}`);
  const out = `${tmp}.jsonl`, raw = `${tmp}.f32`;
  const lang = /^[a-z]{2,3}$|^auto$/i.test(language) ? language.toLowerCase() : 'auto';
  const rate = 16000;
  const p = (async () => {
    const x = await decodeMono(path.join(MEDIA_DIR, asset.file), rate);
    const ranges = speechRanges(x, rate);
    const kept = ranges.reduce((n, r) => n + Math.round((r.to - r.from) * rate), 0);
    const y = new Float32Array(kept);
    let o = 0;
    for (const r of ranges) { const a = x.subarray(Math.round(r.from * rate), Math.round(r.from * rate) + Math.round((r.to - r.from) * rate)); y.set(a, o); o += a.length; }
    fs.writeFileSync(raw, Buffer.from(y.buffer, 0, o * 4));
    const af = `whisper=model=${q(model)}:language=${lang}:queue=20:destination=${q(out)}:format=json:max_len=1`;
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', raw, '-af', af, '-f', 'null', '-']);
    const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.trim()) : [];
    const tokens = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .map((t) => ({ text: t.text, start: t.start / 1000, end: t.end / 1000 }));
    const words = mapWords(mergeTokens(tokens), ranges).map((w) => ({ w: w.w, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }));
    const result = { version: TRANSCRIPT_VERSION, assetId: asset.id, language: lang, model: path.basename(model), words };
    fs.writeFileSync(cacheFile(asset), JSON.stringify(result));
    return result;
  })().finally(() => { fs.rmSync(out, { force: true }); fs.rmSync(raw, { force: true }); inflight.delete(asset.id); });
  inflight.set(asset.id, p);
  return p;
}

// Readable transcript: sentences with source timestamps.
export function transcriptText(words, { from = 0, to = Infinity, withWords = false } = {}) {
  const ws = words.filter((w) => w.start >= from && w.start <= to);
  if (withWords) return ws.map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.w}`).join('\n');
  const lines = [];
  let cur = null;
  for (const w of ws) {
    if (!cur || w.start - cur.end > 0.8 || cur.n >= 18) { cur = { start: w.start, end: w.end, text: [], n: 0 }; lines.push(cur); }
    cur.text.push(w.w); cur.end = w.end; cur.n++;
    if (/[.!?…]$/.test(w.w)) cur = null;
  }
  return lines.map((l) => `[${l.start.toFixed(2)}-${l.end.toFixed(2)}] ${l.text.join(' ')}`).join('\n');
}
