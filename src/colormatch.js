// Color match: make a clip look like a reference clip by matching simple frame statistics, expressed as the
// set_color fields the editor already has (so the preview shows it too). Pure apart from frameStats' input.
import path from 'node:path';
import { run } from './media.js';
import { MEDIA_DIR } from './store.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (n) => Math.round(n * 100) / 100;

// Stats of RGB24 pixels (0-1): luma mean and spread, saturation (max-min) mean, warmth (R-B) mean.
export function pixelStats(buf) {
  let n = 0, sy = 0, syy = 0, ss = 0, sw = 0;
  for (let k = 0; k + 2 < buf.length; k += 3) {
    const r = buf[k] / 255, g = buf[k + 1] / 255, b = buf[k + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    n++; sy += y; syy += y * y; ss += Math.max(r, g, b) - Math.min(r, g, b); sw += r - b;
  }
  const mean = sy / n;
  return { mean, std: Math.sqrt(Math.max(1e-6, syy / n - mean * mean)), sat: ss / n, warm: sw / n };
}
// set_color values that move tgt toward ref (eq contrast pivots around mid grey, brightness 1 = +0.4).
export function colorMatch(ref, tgt) {
  const contrast = clamp(ref.std / tgt.std, 0.6, 1.6);
  const after = 0.5 + (tgt.mean - 0.5) * contrast;
  return {
    brightness: r2(clamp((ref.mean - after) / 0.4, -0.5, 0.5)),
    contrast: r2(contrast),
    saturation: r2(clamp(ref.sat / Math.max(0.01, tgt.sat), 0.5, 1.8)),
    temperature: r2(clamp((ref.warm - tgt.warm) / 0.25, -1, 1)),
  };
}
// Average stats over a few frames of a clip's source range (small frames, quick).
export async function clipStats(a, from, to, count = 5) {
  const all = [];
  for (let k = 0; k < count; k++) {
    const t = a.type === 'image' ? 0 : from + ((to - from) * (k + 0.5)) / count;
    const buf = await run('ffmpeg', ['-v', 'error', ...(a.type === 'image' ? [] : ['-ss', String(t)]), '-i', path.join(MEDIA_DIR, a.file), '-frames:v', '1', '-vf', 'scale=96:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    if (buf.length) all.push(pixelStats(buf));
    if (a.type === 'image') break;
  }
  const avg = (k) => all.reduce((x, s) => x + s[k], 0) / all.length;
  return { mean: avg('mean'), std: avg('std'), sat: avg('sat'), warm: avg('warm') };
}
