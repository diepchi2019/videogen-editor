// Motion tracking without AI: follow a box from frame to frame by template matching (normalized cross-correlation
// on small grayscale frames), then turn the path into keyframes so an overlay (sticker, emoji, logo, label) moves
// with it. Also the mapping between a clip's source frame and the canvas (fit, crop, flip, reframe, scale/x/y).
import path from 'node:path';
import { run } from './media.js';
import { MEDIA_DIR } from './store.js';
import { kfAt } from './model.js';
import { reframeTrack } from './timing.js';

export const TRACK_FPS = 10, TRACK_W = 320;

// Decode source seconds from..to as grayscale frames TRACK_W wide. Returns { w, h, frames: [Uint8Array], times }.
export async function grayFrames(a, from, to, { fps = TRACK_FPS, width = TRACK_W } = {}) {
  const w = width, h = Math.max(2, Math.round((width * a.height) / a.width / 2) * 2);
  const buf = await run('ffmpeg', ['-v', 'error', '-ss', String(from), '-t', String(Math.max(0.1, to - from)), '-i', path.join(MEDIA_DIR, a.file),
    '-vf', `fps=${fps},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-']);
  const n = Math.floor(buf.length / (w * h)), frames = [], times = [];
  for (let i = 0; i < n; i++) { frames.push(buf.subarray(i * w * h, (i + 1) * w * h)); times.push(from + i / fps); }
  return { w, h, frames, times };
}

// Normalized cross-correlation of template T (tw x th, mean-removed, with its norm) at (x, y) in frame F (fw wide).
function ncc(F, fw, T, tw, th, tnorm, tsum, x, y, step) {
  let s = 0, sf = 0, sff = 0, n = 0;
  for (let j = 0; j < th; j += step) {
    const row = (y + j) * fw + x, trow = j * tw;
    for (let i = 0; i < tw; i += step) { const f = F[row + i]; s += f * T[trow + i]; sf += f; sff += f * f; n++; }
  }
  const varF = sff - (sf * sf) / n;
  // Σ(f - mean f)·T = Σ f·T - mean f · Σ T (T is zero-mean over all its pixels, not exactly over the sampled ones).
  return varF <= n || tnorm <= 1e-6 ? 0 : (s - (sf / n) * tsum) / Math.sqrt(varF * tnorm);
}
// The template minus its mean, and its norm over the same pixels ncc samples (every `step`-th), so a perfect match
// scores 1 whatever the step.
function template(F, fw, x, y, tw, th, step) {
  const T = new Float32Array(tw * th);
  let m = 0;
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) { const v = F[(y + j) * fw + x + i]; T[j * tw + i] = v; m += v; }
  m /= tw * th;
  for (let k = 0; k < T.length; k++) T[k] -= m;
  return { T, ...sampledNorm(T, tw, th, step) };
}
// Norm and sum of T over the pixels ncc samples (every `step`-th), so a perfect match scores 1 whatever the step.
function sampledNorm(T, tw, th, step) {
  let norm = 0, sum = 0, n = 0;
  for (let j = 0; j < th; j += step) for (let i = 0; i < tw; i += step) { const v = T[j * tw + i]; sum += v; norm += v * v; n++; }
  return { norm: norm - (sum * sum) / n, sum };
}

// Follow box {x, y, w, h} (pixels in frame 0) through the frames. Returns [{cx, cy, score}] per frame (box
// centers in pixels). The template adapts slowly when the match is good; when the match is weak the box holds
// still and the search widens, so a short occlusion does not throw it off.
export function trackBox(frames, fw, fh, box) {
  const tw = Math.max(6, Math.min(fw - 2, Math.round(box.w))), th = Math.max(6, Math.min(fh - 2, Math.round(box.h)));
  let x = Math.max(0, Math.min(fw - tw, Math.round(box.x))), y = Math.max(0, Math.min(fh - th, Math.round(box.y)));
  const step = tw * th > 1600 ? 2 : 1;
  let { T, norm, sum: tsum } = template(frames[0], fw, x, y, tw, th, step);
  const base = Math.max(10, Math.round(0.6 * Math.max(tw, th)));
  let radius = base;
  const out = [{ cx: x + tw / 2, cy: y + th / 2, score: 1 }];
  for (let f = 1; f < frames.length; f++) {
    const F = frames[f];
    let best = -2, bx = x, by = y;
    const scan = (x0, x1, y0, y1, st) => {
      for (let yy = Math.max(0, y0); yy <= Math.min(fh - th, y1); yy += st) {
        for (let xx = Math.max(0, x0); xx <= Math.min(fw - tw, x1); xx += st) {
          const s = ncc(F, fw, T, tw, th, norm, tsum, xx, yy, step);
          if (s > best) { best = s; bx = xx; by = yy; }
        }
      }
    };
    // Every position when the search area is small; every other one (then refined) when it is wide.
    scan(x - radius, x + radius, y - radius, y + radius, radius > 24 ? 2 : 1);
    const cx = bx, cy = by;
    scan(cx - 2, cx + 2, cy - 2, cy + 2, 1);
    if (best >= 0.45) {
      x = bx; y = by; radius = base;
      if (best >= 0.7) { // adapt slowly to changes in look (turning, light)
        const fresh = template(F, fw, x, y, tw, th, step);
        for (let k = 0; k < T.length; k++) T[k] = 0.85 * T[k] + 0.15 * fresh.T[k];
        ({ norm, sum: tsum } = sampledNorm(T, tw, th, step));
      }
    } else radius = Math.min(base * 3, Math.round(radius * 1.5));
    out.push({ cx: x + tw / 2, cy: y + th / 2, score: Math.round(best * 1000) / 1000 });
  }
  return out;
}

// Where a point of the clip's source frame (fractions) lands on the canvas (fractions) at clip-local time lt.
// Follows fit (contain/blur/cover), crop, flips, reframe and the static scale/x/y; rotation and keyframed
// position are not followed.
function frameGeometry(c, a, W, H, lt) {
  const T = c.transform || {}, cr = T.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sw = a.width * cr.w, sh = a.height * cr.h;
  let s, ox, oy;
  if ((c.fit || 'contain') === 'cover') {
    s = Math.max(W / sw, H / sh) * (c.reframe?.points?.length ? c.reframe.zoom || 1 : 1);
    const fx = c.reframe?.points?.length ? kfAt(reframeTrack(c, 'x'), lt) : 0.5, fy = c.reframe?.points?.length ? kfAt(reframeTrack(c, 'y'), lt) : 0.5;
    ox = -Math.min(Math.max(0, fx * sw * s - W / 2), Math.max(0, sw * s - W));
    oy = -Math.min(Math.max(0, fy * sh * s - H / 2), Math.max(0, sh * s - H));
    if (!c.reframe?.points?.length) { ox = (W - sw * s) / 2; oy = (H - sh * s) / 2; }
  } else { s = Math.min(W / sw, H / sh); ox = (W - sw * s) / 2; oy = (H - sh * s) / 2; }
  return { T, cr, sw, sh, s, ox, oy, sc: T.scale ?? 1, tx: T.x ?? 0.5, ty: T.y ?? 0.5 };
}
export function sourceToCanvas(c, a, W, H, p, lt) {
  const g = frameGeometry(c, a, W, H, lt);
  let x = g.T.flipH ? 1 - p.x : p.x, y = g.T.flipV ? 1 - p.y : p.y;
  x = (x - g.cr.x) / g.cr.w; y = (y - g.cr.y) / g.cr.h;
  const X = g.ox + x * g.sw * g.s, Y = g.oy + y * g.sh * g.s;
  return { x: (g.tx * W + (X - W / 2) * g.sc) / W, y: (g.ty * H + (Y - H / 2) * g.sc) / H };
}
export function canvasToSource(c, a, W, H, p, lt) {
  const g = frameGeometry(c, a, W, H, lt);
  const X = (p.x * W - g.tx * W) / g.sc + W / 2, Y = (p.y * H - g.ty * H) / g.sc + H / 2;
  let x = (X - g.ox) / (g.sw * g.s), y = (Y - g.oy) / (g.sh * g.s);
  x = g.cr.x + x * g.cr.w; y = g.cr.y + y * g.cr.h;
  return { x: g.T.flipH ? 1 - x : x, y: g.T.flipV ? 1 - y : y };
}
// A canvas size (fraction of the canvas width) as a fraction of the source frame width.
export function canvasScaleToSource(c, a, W, H) {
  const g = frameGeometry(c, a, W, H, 0);
  return (W / g.sc) / (g.sw * g.s) * g.cr.w;
}

// Keep the points needed to follow a series within tol (Ramer-Douglas-Peucker on [t, v]).
export function simplifySeries(pts, tol = 0.004) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = -1, d = tol;
    for (let k = i + 1; k < j; k++) {
      const f = (pts[k].t - pts[i].t) / Math.max(1e-9, pts[j].t - pts[i].t);
      const e = Math.abs(pts[k].v - (pts[i].v + f * (pts[j].v - pts[i].v)));
      if (e > d) { d = e; worst = k; }
    }
    if (worst >= 0) { keep[worst] = true; stack.push([i, worst], [worst, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
