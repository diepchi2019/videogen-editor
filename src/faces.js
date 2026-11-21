// Face detection for auto reframe: YuNet (OpenCV zoo, ~230 KB ONNX) run with onnxruntime-node on frames that
// ffmpeg decodes. Everything is local. Detections are cached per media file in data/analysis/<file>.faces.json,
// and subjectPath() turns them into reframe points (the crop follows the main face, holds still within a shot
// and jumps at shot changes).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ANALYSIS_DIR, DATA_DIR, MEDIA_DIR } from './store.js';

export const FACE_MODEL_FILE = 'face_detection_yunet_2023mar.onnx';
export const FACE_HELP = `Auto reframe needs the YuNet face model: download ${FACE_MODEL_FILE} from ` +
  'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet into models/face/.';
const SIZE = 640; // YuNet's fixed input size
const VERSION = 1;

export function faceModelPath() {
  for (const d of [path.resolve('models', 'face'), path.join(DATA_DIR, 'models', 'face')]) {
    const f = path.join(d, FACE_MODEL_FILE);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

let session;
async function getSession() {
  if (session) return session;
  const model = faceModelPath();
  if (!model) throw new Error(FACE_HELP);
  let ort;
  try { ort = await import('onnxruntime-node'); } catch { throw new Error('Auto reframe needs onnxruntime-node: run npm install.'); }
  session = { ort, s: await ort.InferenceSession.create(model) };
  return session;
}

// ---------- Detection ----------
// YuNet output decoding (same as OpenCV's FaceDetectorYN): per stride, one prior per grid cell; score =
// sqrt(cls * obj); box center = (cell + offset) * stride, size = exp(v) * stride.
export function decodeYunet(out, size = SIZE, threshold = 0.6) {
  const faces = [];
  for (const st of [8, 16, 32]) {
    const cls = out[`cls_${st}`], obj = out[`obj_${st}`], box = out[`bbox_${st}`];
    const cols = size / st, rows = size / st;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const sc = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (sc < threshold) continue;
        const cx = (c + box[i * 4]) * st, cy = (r + box[i * 4 + 1]) * st;
        const w = Math.exp(box[i * 4 + 2]) * st, h = Math.exp(box[i * 4 + 3]) * st;
        faces.push({ cx, cy, w, h, score: sc });
      }
    }
  }
  return nms(faces, 0.3);
}
const iou = (a, b) => {
  const x1 = Math.max(a.cx - a.w / 2, b.cx - b.w / 2), x2 = Math.min(a.cx + a.w / 2, b.cx + b.w / 2);
  const y1 = Math.max(a.cy - a.h / 2, b.cy - b.h / 2), y2 = Math.min(a.cy + a.h / 2, b.cy + b.h / 2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};
export function nms(faces, thr) {
  const out = [];
  for (const f of [...faces].sort((p, q) => q.score - p.score)) if (out.every((o) => iou(o, f) < thr)) out.push(f);
  return out;
}

// Faces in one RGB24 frame of w x h (already scaled so the long side is at most 640), as fractions of the frame.
export async function detectFrame(rgb, w, h) {
  const { ort, s } = await getSession();
  const data = new Float32Array(3 * SIZE * SIZE); // letterboxed into the top-left corner, black padding
  const plane = SIZE * SIZE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3, q = y * SIZE + x;
      data[q] = rgb[p + 2]; data[plane + q] = rgb[p + 1]; data[2 * plane + q] = rgb[p]; // BGR, 0-255
    }
  }
  const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
  const out = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.data]));
  return decodeYunet(out).map((f) => ({ cx: f.cx / w, cy: f.cy / h, w: f.w / w, h: f.h / h, score: Math.round(f.score * 1000) / 1000 }))
    .filter((f) => f.cx >= 0 && f.cx <= 1 && f.cy >= 0 && f.cy <= 1);
}

// ---------- Sampling a source range ----------
const cacheFile = (a) => path.join(ANALYSIS_DIR, `${a.file}.faces.json`);
function readCache(a) {
  try { const j = JSON.parse(fs.readFileSync(cacheFile(a), 'utf8')); if (j.version === VERSION) return j; } catch { /* none */ }
  return { version: VERSION, samples: [] };
}
const r3 = (n) => Math.round(n * 1000) / 1000;

// Faces every 1/fps seconds over source from..to: [{t, faces:[{cx, cy, w, h, score}]}]. Reuses cached samples
// when they already cover the range at this density.
export async function faceSamples(a, from, to, { fps = 4 } = {}) {
  if (a.type === 'audio') throw new Error('Audio has no faces');
  const cache = readCache(a);
  const step = 1 / fps;
  const inRange = cache.samples.filter((x) => x.t >= from - step && x.t <= to + step).sort((p, q) => p.t - q.t);
  const covered = inRange.length && inRange[0].t <= from + step && inRange.at(-1).t >= to - step &&
    inRange.every((x, i) => i === 0 || x.t - inRange[i - 1].t <= step * 1.6);
  if (covered) return inRange.filter((x) => x.t >= from - 1e-6 && x.t <= to + 1e-6);
  const sw = a.width || 1280, sh = a.height || 720;
  const k = Math.min(1, SIZE / Math.max(sw, sh));
  const w = Math.max(2, Math.floor((sw * k) / 2) * 2), h = Math.max(2, Math.floor((sh * k) / 2) * 2);
  const file = path.join(MEDIA_DIR, a.file);
  const args = a.type === 'image'
    ? ['-v', 'error', '-i', file, '-frames:v', '1']
    : ['-v', 'error', '-ss', String(from), '-t', String(Math.max(step, to - from + 1e-3)), '-i', file, '-vf', `fps=${fps}`];
  const frames = await rawFrames([...args, ...(a.type === 'image' ? ['-vf', `scale=${w}:${h}`] : []), '-s', `${w}x${h}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], w * h * 3);
  const fresh = [];
  for (let i = 0; i < frames.length; i++) fresh.push({ t: r3(a.type === 'image' ? 0 : from + i * step), faces: await detectFrame(frames[i], w, h) });
  // Merge into the cache (replacing samples in the range we just did).
  const keep = cache.samples.filter((x) => x.t < from - step / 2 || x.t > to + step / 2);
  cache.samples = [...keep, ...fresh].sort((p, q) => p.t - q.t);
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(a), JSON.stringify(cache));
  return fresh;
}
function rawFrames(args, frameBytes) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-nostdin', ...args]);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read frames: ${err.trim().split('\n').pop()}`));
      const buf = Buffer.concat(chunks), out = [];
      for (let o = 0; o + frameBytes <= buf.length; o += frameBytes) out.push(buf.subarray(o, o + frameBytes));
      resolve(out);
    });
  });
}

// ---------- From detections to a reframe path ----------
// Pick the subject in each sample: stay with the face nearest the last one (so two people talking does not
// make the crop jump on every frame) unless another face is clearly bigger for about a second; otherwise the
// biggest face. Samples without a face hold the last position. Within a shot the path is smoothed (a moving
// median, then an average) and simplified to few points; at a shot change it jumps (two points 0.02s apart).
// Returns { points: [{source, x, y}], found: share of samples with a face }.
export function subjectPath(samples, { cuts = [], smooth = 1, minFace = 0.03 } = {}) {
  const pick = [];
  let cur = null, rival = 0;
  for (const s of samples) {
    const faces = s.faces.filter((f) => f.w >= minFace).sort((p, q) => q.w * q.h - p.w * p.h);
    if (!faces.length) { pick.push(null); continue; }
    if (!cur || cuts.some((c) => c > (pick.length ? samples[pick.length - 1].t : -1) && c <= s.t)) { cur = faces[0]; rival = 0; pick.push(cur); continue; }
    const near = faces.reduce((b, f) => (Math.hypot(f.cx - cur.cx, f.cy - cur.cy) < Math.hypot(b.cx - cur.cx, b.cy - cur.cy) ? f : b));
    const big = faces[0];
    if (big !== near && big.w * big.h > 1.5 * near.w * near.h) rival++; else rival = 0;
    cur = rival >= 4 ? big : near; // ~1s at 4 fps
    if (rival >= 4) rival = 0;
    pick.push(cur);
  }
  const found = pick.filter(Boolean).length / Math.max(1, samples.length);
  // Hold through gaps (and back-fill the start).
  let last = pick.find(Boolean) || null;
  const pos = pick.map((p) => { if (p) last = p; return last ? { x: last.cx, y: last.cy } : null; });
  if (!last) return { points: [], found: 0 };
  // Split into shots, smooth and simplify each.
  const shots = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || cuts.some((c) => c > samples[i - 1].t && c <= samples[i].t)) { shots.push([start, i]); start = i; }
  }
  const points = [];
  const win = Math.max(1, Math.round(2 * smooth));
  for (const [a, b] of shots) {
    const ts = samples.slice(a, b).map((s) => s.t);
    const xs = smoothSeries(pos.slice(a, b).map((p) => p.x), win), ys = smoothSeries(pos.slice(a, b).map((p) => p.y), win);
    const keep = simplify(ts.map((t, i) => [t, xs[i], ys[i]]), 0.02);
    if (points.length && a > 0) {
      // Jump at the cut: hold the previous shot's position until just before it.
      const cut = cuts.find((c) => c > samples[a - 1].t && c <= samples[a].t);
      const prev = points.at(-1);
      points.push({ source: r3(Math.max(prev.source + 0.01, cut - 0.02)), x: prev.x, y: prev.y });
      keep[0] = [cut, keep[0][1], keep[0][2]];
    }
    for (const [t, x, y] of keep) points.push({ source: r3(t), x: r3(x), y: r3(y) });
  }
  return { points, found: Math.round(found * 100) / 100 };
}
// Moving median (kills single-frame jumps) then a moving average (smooths the motion). The window shrinks
// evenly near the ends of a shot, so a steady pan is not pulled toward the middle there.
export function smoothSeries(v, win) {
  const around = (arr, i) => { const k = Math.min(win, i, arr.length - 1 - i); return arr.slice(i - k, i + k + 1); };
  const med = v.map((_, i) => { const w = around(v, i).sort((p, q) => p - q); return w[Math.floor(w.length / 2)]; });
  return med.map((_, i) => { const w = around(med, i); return w.reduce((p, q) => p + q, 0) / w.length; });
}
// Ramer-Douglas-Peucker on [t, x, y]: drop points whose position is within tol of the line between neighbours.
export function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const [t0, x0, y0] = pts[0], [t1, x1, y1] = pts.at(-1);
  let worst = -1, wi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const k = (pts[i][0] - t0) / (t1 - t0 || 1);
    const d = Math.hypot(pts[i][1] - (x0 + (x1 - x0) * k), pts[i][2] - (y0 + (y1 - y0) * k));
    if (d > worst) { worst = d; wi = i; }
  }
  if (worst <= tol) return [pts[0], pts.at(-1)];
  return [...simplify(pts.slice(0, wi + 1), tol).slice(0, -1), ...simplify(pts.slice(wi), tol)];
}
