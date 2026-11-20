// Speech to text with word timestamps, using ffmpeg's built-in whisper filter (whisper.cpp).
// Results are cached per media file in data/analysis/<file>.words.json.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './media.js';
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

const inflight = new Map();
export function transcribe(asset, { language = 'auto', force = false } = {}) {
  if (asset.type === 'image') return Promise.reject(new Error(`${asset.id} is an image and has no audio`));
  if (asset.type === 'video' && !asset.hasAudio) return Promise.reject(new Error(`${asset.id} has no audio track`));
  if (!force) { const c = readTranscript(asset); if (c) return Promise.resolve(c); }
  if (inflight.has(asset.id)) return inflight.get(asset.id);
  const model = modelPath();
  if (!model) {
    return Promise.reject(new Error(MODEL_HELP));
  }
  const out = path.join(ANALYSIS_DIR, `${asset.file}.${process.pid}.${Date.now()}.jsonl`);
  const lang = /^[a-z]{2,3}$|^auto$/i.test(language) ? language.toLowerCase() : 'auto';
  const af = `aresample=16000,whisper=model=${q(model)}:language=${lang}:queue=20:destination=${q(out)}:format=json:max_len=1`;
  const p = run('ffmpeg', ['-v', 'error', '-nostdin', '-i', path.join(MEDIA_DIR, asset.file), '-vn', '-af', af, '-f', 'null', '-'])
    .then(() => {
      const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.trim()) : [];
      const tokens = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map((t) => ({ text: t.text, start: t.start / 1000, end: t.end / 1000 }));
      const words = mergeTokens(tokens).map((w) => ({ w: w.w, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }));
      const result = { assetId: asset.id, language: lang, model: path.basename(model), words };
      fs.writeFileSync(cacheFile(asset), JSON.stringify(result));
      return result;
    })
    .finally(() => { fs.rmSync(out, { force: true }); inflight.delete(asset.id); });
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
