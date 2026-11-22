// Builds an ffmpeg filter graph from the project and renders an MP4 (or preview frames).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { layout, overlayDuration, uid, spillOf, reframeTrack } from './model.js';
import { DATA_DIR, EXPORT_DIR, MEDIA_DIR } from './store.js';
import { buildAss, captionEmoji, emojiBox } from './ass.js';
import { emojiFile } from './emoji.js';
import { stabFile } from './stabilize.js';
import { chapterTime } from './model.js';
import { projectCredits } from './library.js';
import { toneCurves } from '../public/preview.js';
import { defaultFont, stageFonts } from './fonts.js';
import { createJob, finishJob, getJob, listJobs } from './jobs.js';
import { run } from './media.js';
import { rampPieces, pieceTime } from './timing.js';
import { lutPath } from './luts.js';

export { getJob, listJobs };

const f3 = (n) => Number(n).toFixed(3);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const hex = (c, a = 1) => `${(c || '#ffffff').replace(/^#/, '0x')}@${a}`;
// Escape a value for use inside a filtergraph option (single-quoted).
const q = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

// ffmpeg 7+ reads an option value from a file with "-/option file"; -filter_complex_script was removed in 8.
let graphFlag;
function filterGraphArgs(file) {
  if (!graphFlag) {
    let major = 7;
    try { major = Number(/ffmpeg version n?(\d+)/.exec(execFileSync('ffmpeg', ['-hide_banner', '-version']).toString())?.[1]) || 7; } catch { /* assume modern */ }
    graphFlag = major >= 7 ? '-/filter_complex' : '-filter_complex_script';
  }
  return [graphFlag, file];
}

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((x) => `atempo=${x.toFixed(4)}`).join(',');
}

// crop / flip / rotate on the source frame. fill = color for the corners of an odd-angle rotation.
function geometry(t, fill) {
  const f = [];
  if (t.crop) f.push(`crop=w=iw*${t.crop.w}:h=ih*${t.crop.h}:x=iw*${t.crop.x}:y=ih*${t.crop.y}`);
  if (t.flipH) f.push('hflip');
  if (t.flipV) f.push('vflip');
  const r = ((t.rotate || 0) % 360 + 360) % 360;
  if (r === 90) f.push('transpose=1');
  else if (r === 180) f.push('hflip,vflip');
  else if (r === 270) f.push('transpose=2');
  else if (r) { const a = `${r}*PI/180`; f.push(`rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=${fill}`); }
  return f;
}

// ---------- Keyframes ----------
// ffmpeg expression for a keyframe track {easing, points:[{t,v}]} at local time tv (piecewise, held at the ends).
export function kfExpr(tr, tv = 't') {
  const ps = tr.points;
  if (ps.length === 1) return String(ps[0].v);
  let e = String(ps[ps.length - 1].v);
  for (let i = ps.length - 1; i >= 1; i--) {
    const a = ps[i - 1], b = ps[i];
    const k = `clip((${tv}-${a.t})/${Math.max(0.001, b.t - a.t)},0,1)`;
    const kk = tr.easing === 'linear' ? k : `(${k}*${k}*(3-2*${k}))`;
    e = `if(lt(${tv},${b.t}),${a.v}+(${r6(b.v - a.v)})*${kk},${e})`;
  }
  return `if(lt(${tv},${ps[0].t}),${ps[0].v},${e})`;
}
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const ease = (p) => `(${p}*${p}*(3-2*${p}))`;

// ---------- Clip timing: speed ramps (src/timing.js) ----------
// setpts expression: output seconds for played-source seconds T (exact integral of 1/speed).
export function rampExpr(c) {
  const ps = rampPieces(c);
  const U = `min(T,${r6(c.out - c.in)})`;
  const f = (pc) => {
    const d = pc.u1 - pc.u0, k = pc.v1 - pc.v0;
    return Math.abs(k) < 1e-9 ? `${r6(pc.t0)}+(${U}-${r6(pc.u0)})/${r6(pc.v0)}` : `${r6(pc.t0)}+(${r6(d / k)})*log(1+(${r6(k / (d * pc.v0))})*(${U}-${r6(pc.u0)}))`;
  };
  let e = f(ps[ps.length - 1]);
  for (let i = ps.length - 2; i >= 0; i--) e = `if(lt(${U},${r6(ps[i].u1)}),${f(ps[i])},${e})`;
  return e;
}
// Audio of a ramp: short pieces at constant tempo, each exactly as long as the video it covers.
export function rampAudioSegments(c) {
  const step = Math.max(0.1, (c.out - c.in) / 24);
  const segs = [];
  for (const pc of rampPieces(c)) {
    const m = Math.abs(pc.v1 - pc.v0) < 1e-9 ? 1 : Math.min(24, Math.max(1, Math.ceil((pc.u1 - pc.u0) / step)));
    for (let j = 0; j < m; j++) {
      const a = pc.u0 + ((pc.u1 - pc.u0) * j) / m, b = pc.u0 + ((pc.u1 - pc.u0) * (j + 1)) / m;
      segs.push({ a, b, tempo: (b - a) / (pieceTime(pc, b) - pieceTime(pc, a)) });
    }
  }
  return segs;
}

// ---------- Color ----------
// Filter looks (FILTERS in model.js). Keep in sync with the CSS approximations in public/app.js.
export const LOOKS = {
  bw: 'hue=s=0',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  vintage: 'curves=preset=vintage',
  warm: 'colorbalance=rs=.12:bs=-.12:rm=.08:bm=-.08,eq=saturation=1.1',
  cool: 'colorbalance=rs=-.1:bs=.12:rm=-.06:bm=.1',
  vivid: 'eq=saturation=1.45:contrast=1.08',
  cinematic: 'colorbalance=rs=-.08:gs=-.02:bs=.1:rh=.1:gh=.03:bh=-.08,eq=contrast=1.12:saturation=0.9',
  matte: "curves=all='0/0.1 0.5/0.5 1/0.9',eq=saturation=0.85",
  noir: 'hue=s=0,curves=preset=strong_contrast',
  dramatic: 'eq=contrast=1.3:saturation=0.75,curves=preset=darker',
};
// Adds color adjust + look filters after inL; returns the output label (inL when there is nothing to do).
function applyColor(filters, inL, c, tag, fmt) {
  if (!c) return inL;
  const f = [];
  const b = c.brightness ?? 0, ct = c.contrast ?? 1, s = c.saturation ?? 1, tp = c.temperature ?? 0;
  // Clean (video noise reduction) and sharpen first, then tone, then color.
  if (c.clean) f.push(`hqdn3d=${f3(2 + 4 * c.clean)}:${f3(2 + 4 * c.clean)}:${f3(4 + 8 * c.clean)}:${f3(4 + 8 * c.clean)}`);
  if (c.sharpen) f.push(`cas=strength=${f3(0.25 + 0.75 * c.sharpen)}`);
  if (b || ct !== 1 || s !== 1) f.push(`eq=brightness=${f3(b * 0.4)}:contrast=${f3(ct)}:saturation=${f3(s)}`);
  const tc = toneCurves(c);
  if (tc) f.push(`curves=r='${tc.r.map((q) => q.join('/')).join(' ')}':g='${tc.g.map((q) => q.join('/')).join(' ')}':b='${tc.b.map((q) => q.join('/')).join(' ')}'`);
  if (c.hue) f.push(`hue=h=${f3(c.hue)}`);
  const HSL_FF = { red: 'r', yellow: 'y', green: 'g', cyan: 'c', blue: 'b', magenta: 'm' };
  for (const [k, v] of Object.entries(c.hsl || {})) f.push(`huesaturation=colors=${HSL_FF[k]}:hue=${f3(v.hue || 0)}:saturation=${f3(v.saturation || 0)}:intensity=${f3((v.lightness || 0) * 0.5)}`);
  if (tp) f.push(`colorbalance=rs=${f3(0.15 * tp)}:bs=${f3(-0.15 * tp)}:rm=${f3(0.1 * tp)}:bm=${f3(-0.1 * tp)}:rh=${f3(0.05 * tp)}:bh=${f3(-0.05 * tp)}`);
  if (c.vignette) f.push(`vignette=angle=${f3(0.25 + 0.6 * c.vignette)}`);
  let cur = inL;
  if (f.length) { filters.push(`[${cur}]${f.join(',')},format=${fmt}[${tag}a]`); cur = `${tag}a`; }
  // Imported .cube LUT, blended with the original below intensity 1.
  const mix = (filter, I, k) => {
    if (I >= 0.999) filters.push(`[${cur}]${filter},format=${fmt}[${tag}${k}]`);
    else {
      filters.push(`[${cur}]format=${fmt},split[${tag}${k}o][${tag}${k}i]`);
      filters.push(`[${tag}${k}i]${filter},format=${fmt}[${tag}${k}l]`);
      filters.push(`[${tag}${k}l][${tag}${k}o]blend=all_mode=normal:all_opacity=${f3(I)}[${tag}${k}]`);
    }
    cur = `${tag}${k}`;
  };
  if (c.lut) mix(`lut3d=file=${q(lutPath(c.lut))}:interp=tetrahedral`, c.lutIntensity ?? 1, 'u');
  const look = c.filter && LOOKS[c.filter];
  if (look) mix(look, c.filterIntensity ?? 1, 'b');
  return cur;
}

// ---------- Clip placement: keyframed scale/x/y and zoom/slide in/out animations ----------
// Returns {S, X, Y} expressions in clip-local t, or null when the clip is static.
export function clipPlacement(c, dur) {
  const T = c.transform || {}, K = c.keyframes || {};
  const ai = c.animIn && c.animIn.type !== 'fade' ? c.animIn : null;
  const ao = c.animOut && c.animOut.type !== 'fade' ? c.animOut : null;
  if (!ai && !ao && !K.scale && !K.x && !K.y) return null;
  let S = K.scale ? `(${kfExpr(K.scale)})` : String(T.scale ?? 1);
  let X = K.x ? `(${kfExpr(K.x)})` : String(T.x ?? 0.5);
  let Y = K.y ? `(${kfExpr(K.y)})` : String(T.y ?? 0.5);
  if (ai) {
    const D = f3(Math.max(0.05, Math.min(ai.duration, dur / 2)));
    const e = ease(`clip(t/${D},0,1)`);
    if (ai.type === 'zoom_in') S = `${S}*(0.6+0.4*${e})`;
    else if (ai.type === 'zoom_out') S = `${S}*(1.4-0.4*${e})`;
    else if (ai.type === 'slide_left') X = `${X}+(1-${e})`;
    else if (ai.type === 'slide_right') X = `${X}-(1-${e})`;
    else if (ai.type === 'slide_up') Y = `${Y}+(1-${e})`;
    else if (ai.type === 'slide_down') Y = `${Y}-(1-${e})`;
  }
  if (ao) {
    const Dn = Math.max(0.05, Math.min(ao.duration, dur / 2));
    const e = ease(`clip((t-${f3(dur - Dn)})/${f3(Dn)},0,1)`);
    if (ao.type === 'zoom_in') S = `${S}*(1+0.4*${e})`;
    else if (ao.type === 'zoom_out') S = `${S}*(1-0.4*${e})`;
    else if (ao.type === 'slide_left') X = `${X}-${e}`;
    else if (ao.type === 'slide_right') X = `${X}+${e}`;
    else if (ao.type === 'slide_up') Y = `${Y}-${e}`;
    else if (ao.type === 'slide_down') Y = `${Y}+${e}`;
  }
  return { S, X, Y };
}

// ---------- Effects (size- and length-preserving, applied on the finished WxH clip; t = clip-local) ----------
function applyEffect(filters, inL, fx, tag, W, H, fps) {
  const on = (tv = 't') => `between(${tv},${f3(fx.from)},${f3(fx.to)})`;
  const I = fx.intensity ?? 0.5, r = fx.rate ?? 2;
  const shift = Math.max(2, Math.round(W * 0.02 * I));
  const out = tag;
  // For filters without timeline support: process a copy and show it only inside the range.
  const branch = (proc) => {
    filters.push(`[${inL}]split[${tag}a][${tag}b]`, `[${tag}b]${proc}[${tag}c]`, `[${tag}a][${tag}c]overlay=enable='${on()}'[${out}]`);
  };
  switch (fx.type) {
    case 'shake': {
      const amp = Math.max(2, Math.round(Math.min(W, H) * 0.035 * I));
      filters.push(`[${inL}]split[${tag}a][${tag}b]`);
      filters.push(`[${tag}a][${tag}b]overlay=x='${amp}*${on()}*sin(t*${f3(r * 6.283)})*cos(t*${f3(r * 2.1)})':y='${amp}*${on()}*sin(t*${f3(r * 5.3)}+1.3)'[${out}]`);
      break;
    }
    case 'zoom_pulse':
      filters.push(`[${inL}]zoompan=z='1+${f3(0.18 * I)}*${on('it')}*pow(abs(sin(PI*${f3(r)}*(it-${f3(fx.from)}))),3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},setsar=1[${out}]`);
      break;
    case 'glitch': {
      const burst = `${on()}*gt(sin(t*23)*sin(t*7.3),${f3(0.35 - 0.3 * I)})`;
      filters.push(`[${inL}]rgbashift=rh=${-shift * 2}:bh=${shift * 2}:gv=${shift}:enable='${burst}',noise=alls=${Math.round(20 + 40 * I)}:allf=t:enable='${burst}'[${out}]`);
      break;
    }
    case 'rgb_split':
      filters.push(`[${inL}]rgbashift=rh=${-shift}:bh=${shift}:enable='${on()}'[${out}]`);
      break;
    case 'flash': {
      const d = f3(Math.min(0.5, fx.to - fx.from));
      filters.push(`[${inL}]eq=brightness='${f3(0.9 * I)}*${on()}*max(0,1-(t-${f3(fx.from)})/${d})':eval=frame[${out}]`);
      break;
    }
    case 'blur':
      filters.push(`[${inL}]gblur=sigma=${f3(2 + 18 * I)}:enable='${on()}'[${out}]`);
      break;
    case 'vhs':
      filters.push(`[${inL}]curves=preset=vintage:enable='${on()}',rgbashift=rh=${-shift}:bh=${shift}:enable='${on()}',noise=alls=${Math.round(10 + 20 * I)}:allf=t:enable='${on()}'[${out}]`);
      break;
    case 'light_leak':
      filters.push(`[${inL}]format=gbrp[${tag}m]`);
      filters.push(`gradients=s=${W}x${H}:r=${fps}:n=3:c0=0xff8a00:c1=0xff2d6a:c2=0x000000:speed=0.015:seed=${Math.round(fx.from * 1000) % 9973},format=gbrp[${tag}g]`);
      filters.push(`[${tag}m][${tag}g]blend=all_mode=screen:all_opacity=${f3(0.7 * I)}:shortest=1:enable='${on()}',format=yuv420p[${out}]`);
      break;
    case 'invert':
      filters.push(`[${inL}]negate=enable='${on()}'[${out}]`);
      break;
    case 'pixelate': {
      const N = Math.round(4 + 36 * I);
      branch(`scale=${even(W / N)}:${even(H / N)}:flags=area,scale=${W}:${H}:flags=neighbor,setsar=1`);
      break;
    }
    case 'mirror': // left half mirrored onto the right
      filters.push(`[${inL}]split[${tag}a][${tag}b]`);
      filters.push(`[${tag}b]crop=${even(W / 2)}:${H}:0:0,split[${tag}l][${tag}r]`, `[${tag}r]hflip[${tag}rf]`);
      filters.push(`[${tag}l][${tag}rf]hstack,scale=${W}:${H},setsar=1[${tag}c]`);
      filters.push(`[${tag}a][${tag}c]overlay=enable='${on()}'[${out}]`);
      break;
    case 'kaleidoscope': // top-left quarter mirrored into all four corners
      filters.push(`[${inL}]split[${tag}a][${tag}b]`);
      filters.push(`[${tag}b]crop=${even(W / 2)}:${even(H / 2)}:0:0,split[${tag}q][${tag}r]`, `[${tag}r]hflip[${tag}rf]`);
      filters.push(`[${tag}q][${tag}rf]hstack,split[${tag}t][${tag}u]`, `[${tag}u]vflip[${tag}uf]`);
      filters.push(`[${tag}t][${tag}uf]vstack,scale=${W}:${H},setsar=1[${tag}c]`);
      filters.push(`[${tag}a][${tag}c]overlay=enable='${on()}'[${out}]`);
      break;
    case 'film_grain':
      filters.push(`[${inL}]noise=alls=${Math.round(10 + 40 * I)}:allf=t+u:enable='${on()}'[${out}]`);
      break;
    case 'strobe':
      filters.push(`[${inL}]eq=brightness='${f3(0.8 * I)}*${on()}*gt(sin(2*PI*${f3(r)}*(t-${f3(fx.from)})),0)':eval=frame[${out}]`);
      break;
    case 'comic':
      branch(`edgedetect=mode=colormix:high=${f3(0.3 - 0.2 * I)}:low=0.05,eq=saturation=1.5`);
      break;
    case 'letterbox': { // cinematic bars
      const bh = Math.round(H * 0.13 * I);
      filters.push(`[${inL}]drawbox=x=0:y=0:w=iw:h=${bh}:color=black:t=fill:enable='${on()}',drawbox=x=0:y=ih-${bh}:w=iw:h=${bh}:color=black:t=fill:enable='${on()}'[${out}]`);
      break;
    }
    case 'black_white':
      filters.push(`[${inL}]hue=s=${f3(1 - I)}:enable='${on()}'[${out}]`);
      break;
    case 'tv_static':
      filters.push(`[${inL}]hue=s=0.3:enable='${on()}',noise=alls=${Math.round(40 + 60 * I)}:allf=t+u:enable='${on()}',eq=contrast=1.2:enable='${on()}'[${out}]`);
      break;
    case 'flicker':
      filters.push(`[${inL}]eq=brightness='${f3(0.15 * I)}*${on()}*sin(t*53)*sin(t*31)':eval=frame[${out}]`);
      break;
    case 'posterize': { // flat poster colors: fewer levels per channel
      const step = Math.round(32 + 64 * I);
      filters.push(`[${inL}]lutrgb=r='floor(val/${step})*${step}':g='floor(val/${step})*${step}':b='floor(val/${step})*${step}':enable='${on()}'[${out}]`);
      break;
    }
    case 'duotone': // blue-teal monochrome
      filters.push(`[${inL}]hue=s=0:enable='${on()}',colorchannelmixer=rr=${f3(1 - 0.5 * I)}:gg=${f3(1 - 0.1 * I)}:bb=${f3(1 + 0.25 * I)}:enable='${on()}'[${out}]`);
      break;
    case 'glow': // soft bloom: a blurred copy screened over the frame
      filters.push(`[${inL}]split[${tag}a][${tag}b]`, `[${tag}b]gblur=sigma=${f3(8 + 20 * I)}[${tag}c]`);
      filters.push(`[${tag}a][${tag}c]blend=all_mode=screen:all_opacity=${f3(0.25 + 0.4 * I)}:enable='${on()}'[${out}]`);
      break;
    case 'rainbow': // hue cycles round, rate = turns per second
      filters.push(`[${inL}]hue=h='360*${f3(r)}*(t-${f3(fx.from)})':s=${f3(1 + 0.5 * I)}:enable='${on()}'[${out}]`);
      break;
    case 'echo': // motion trails
      branch(`tmix=frames=${Math.round(3 + 6 * I)}`);
      break;
    case 'swing': { // the frame rocks left and right (zoomed in a little so no edges show)
      const deg = 2 + 8 * I, z = 1 + Math.sin((deg * Math.PI) / 180) * 1.2;
      branch(`scale=${even(W * z)}:${even(H * z)},rotate='${f3((deg * Math.PI) / 180)}*sin(2*PI*${f3(r)}*t)':ow=${W}:oh=${H}:c=black`);
      break;
    }
    case 'multi_screen': // the frame repeated 2x2
      filters.push(`[${inL}]split[${tag}a][${tag}b]`);
      filters.push(`[${tag}b]scale=${even(W / 2)}:${even(H / 2)},split=4[${tag}1][${tag}2][${tag}3][${tag}4]`);
      filters.push(`[${tag}1][${tag}2]hstack[${tag}t]`, `[${tag}3][${tag}4]hstack[${tag}u]`, `[${tag}t][${tag}u]vstack,scale=${W}:${H},setsar=1[${tag}c]`);
      filters.push(`[${tag}a][${tag}c]overlay=enable='${on()}'[${out}]`);
      break;
    case 'old_film':
      filters.push(`[${inL}]curves=preset=vintage:enable='${on()}',hue=s=${f3(0.6 - 0.4 * I)}:enable='${on()}',noise=alls=${Math.round(15 + 30 * I)}:allf=t+u:enable='${on()}',` +
        `eq=brightness='${f3(0.08 * I)}*${on()}*sin(t*37)':eval=frame,vignette=angle=PI/4:enable='${on()}'[${out}]`);
      break;
    case 'night_vision':
      filters.push(`[${inL}]hue=s=0:enable='${on()}',colorchannelmixer=rr=0.2:gg=${f3(1.1 + 0.3 * I)}:bb=0.2:enable='${on()}',noise=alls=${Math.round(15 + 25 * I)}:allf=t:enable='${on()}',vignette=angle=PI/3:enable='${on()}'[${out}]`);
      break;
    case 'thermal':
      filters.push(`[${inL}]pseudocolor=preset=heat:opacity=${f3(0.5 + 0.5 * I)}:enable='${on()}'[${out}]`);
      break;
    default:
      return inL;
  }
  return out;
}

// ---------- Overlay masks ----------
// geq expression (0-1) of a mask on a W x H frame: a signed distance to the shape's edge, softened
// over the feather width (at least 1px, so hard edges are still antialiased).
export function maskExpr(m) {
  const cx = `${r6(m.x)}*W`, cy = `${r6(m.y)}*H`;
  const F = `max(1,${r6((m.feather || 0) * 0.25)}*min(W,H))`;
  let sd;
  if (m.shape === 'circle') {
    sd = `(hypot((X-${cx})/(${r6(m.w / 2)}*W),(Y-${cy})/(${r6(m.h / 2)}*H))-1)*min(${r6(m.w)}*W,${r6(m.h)}*H)/2`;
  } else if (m.shape === 'rect') {
    const r = `${r6(m.round || 0)}*min(${r6(m.w / 2)}*W,${r6(m.h / 2)}*H)`;
    const qx = `(abs(X-${cx})-${r6(m.w / 2)}*W+${r})`, qy = `(abs(Y-${cy})-${r6(m.h / 2)}*H+${r})`;
    sd = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${r})`;
  } else {
    const a = r6(((m.angle || 0) * Math.PI) / 180);
    const d = `((Y-${cy})*${r6(Math.cos(a))}-(X-${cx})*${r6(Math.sin(a))})`;
    sd = m.shape === 'mirror' ? `(abs(${d})-${r6(m.h / 2)}*H)` : `(-${d})`;
  }
  const v = `clip(0.5-(${sd})/${F},0,1)`;
  return m.invert ? `(1-${v})` : v;
}

// ---------- Encoders ----------
let gpuEncoder; // undefined = not probed yet, null = none
export function detectGpuEncoder() {
  if (gpuEncoder !== undefined) return gpuEncoder;
  gpuEncoder = null;
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', ...(enc === 'h264_qsv' ? ['-pix_fmt', 'nv12'] : []), '-c:v', enc, '-f', 'null', '-'], { timeout: 20000, stdio: 'ignore' });
      gpuEncoder = enc; break;
    } catch { /* not usable on this machine */ }
  }
  return gpuEncoder;
}
// Video codec args. q: quality 0 (best) .. 51; bitrate: Mbps or undefined.
function encoderArgs(enc, { draft, bitrate }) {
  const q = draft ? 28 : 20;
  const br = bitrate ? [`${bitrate}M`, `${bitrate * 1.5}M`, `${bitrate * 2}M`] : null;
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', draft ? 'p2' : 'p5', '-rc', 'vbr', ...(br ? ['-b:v', br[0], '-maxrate', br[1], '-bufsize', br[2]] : ['-cq', String(q + 1), '-b:v', '0']), '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', draft ? 'veryfast' : 'medium', ...(br ? ['-b:v', br[0], '-maxrate', br[1]] : ['-global_quality', String(q + 1)]), '-pix_fmt', 'nv12'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', draft ? 'speed' : 'quality', ...(br ? ['-rc', 'vbr_peak', '-b:v', br[0], '-maxrate', br[1]] : ['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2)]), '-pix_fmt', 'yuv420p'];
    default:
      return ['-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'medium', ...(br ? ['-b:v', br[0], '-maxrate', br[1], '-bufsize', br[2]] : ['-crf', draft ? '28' : '20']), '-pix_fmt', 'yuv420p'];
  }
}
export const RESOLUTIONS = { '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 };

// Pixel box of a region on a sw x sh source frame. delogo needs a 1px margin inside the frame.
function regionBox(r, sw, sh) {
  const x = Math.max(1, Math.round(r.x * sw)), y = Math.max(1, Math.round(r.y * sh));
  const w = Math.max(2, Math.min(sw - 1 - x, Math.round(r.w * sw)));
  const h = Math.max(2, Math.min(sh - 1 - y, Math.round(r.h * sh)));
  return { x, y, w, h };
}

// Remove regions from clip i's source frames. Times are source seconds; the stream starts at clip.in.
// Returns the label of the cleaned stream (still at source speed). Patch regions add one input each.
function regionFilters(c, a, i, n, file, args, filters, nextInput) {
  const regs = (c.regions || []).filter((r) => r.to > c.in && r.from < c.out);
  if (!regs.length || !a.width) return null;
  let cur = `rg${i}_0`;
  filters.push(`[${n}:v]setpts=PTS-STARTPTS[${cur}]`);
  regs.forEach((r, j) => {
    const b = regionBox(r, a.width, a.height);
    const en = `enable='between(t,${f3(Math.max(0, r.from - c.in))},${f3(r.to - c.in)})'`;
    const next = `rg${i}_${j + 1}`;
    if (r.mode === 'patch' && a.type === 'video') {
      args.push('-ss', f3(r.patchAt), '-t', '0.5', '-i', file);
      const m = nextInput();
      const F = Math.round(Math.min(b.w, b.h) * (r.feather ?? 0.15) / 2);
      const alpha = F >= 1 ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/${F})'` : '';
      filters.push(`[${m}:v]trim=end_frame=1,setpts=PTS-STARTPTS,crop=${b.w}:${b.h}:${b.x}:${b.y},format=rgba${alpha}[pt${i}_${j}]`);
      filters.push(`[${cur}][pt${i}_${j}]overlay=${b.x}:${b.y}:eof_action=repeat:${en}[${next}]`);
    } else {
      filters.push(`[${cur}]delogo=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:${en}[${next}]`);
    }
    cur = next;
  });
  return cur;
}

// Ken Burns on a WxH frame. Zoompan works on a 2x frame to reduce jitter.
export function motionFilter(m, W, H, fps, dur) {
  const I = m.intensity ?? 0.15, N = Math.max(1, Math.round(dur * fps));
  const p = `min(on/${N},1)`;
  const e = `(${p}*${p}*(3-2*${p}))`; // ease in-out
  let z = `${1 + I}`, x = 'iw/2-(iw/zoom/2)', y = 'ih/2-(ih/zoom/2)';
  switch (m.preset) {
    case 'zoom_in': z = `1+${I}*${e}`; break;
    case 'zoom_out': z = `${1 + I}-${I}*${e}`; break;
    case 'pan_left': x = `(iw-iw/zoom)*(1-${e})`; break;
    case 'pan_right': x = `(iw-iw/zoom)*${e}`; break;
    case 'pan_up': y = `(ih-ih/zoom)*(1-${e})`; break;
    case 'pan_down': y = `(ih-ih/zoom)*${e}`; break;
    default: return null;
  }
  return `fps=${fps},scale=${W * 2}:${H * 2},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`;
}

// opts.quality: 'draft' | 'final'. opts.frames: [timeline seconds] -> render JPEG stills instead of an MP4.
// opts.resolution: '720p'... (short side; overrides draft scaling), opts.fps, opts.bitrate (Mbps), opts.encoder: 'cpu' | 'gpu' | an ffmpeg encoder name.
// opts.still: frames at full output size and high JPEG quality (cover images).
// Noise reduction 0-1 -> FFT denoiser strength (6-30 dB) with adaptive noise tracking.
const denoiseFilter = (d) => (d > 0 ? `afftdn=nr=${f3(6 + 24 * d)}:nf=-40:tn=1` : null);
// Voice effects (VOICE_EFFECTS in model.js). Each keeps the length (echo tails are cut by the item length).
export const VOICE_FX = {
  chipmunk: { pitch: 7 },
  deep: { pitch: -5 },
  robot: { af: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75" },
  echo: { af: 'aecho=0.8:0.85:180|360:0.4|0.25' },
  hall: { af: 'aecho=0.8:0.9:40|70|110|160:0.35|0.3|0.25|0.2' },
  telephone: { af: 'highpass=f=300,lowpass=f=3400,acompressor=threshold=0.1:ratio=4,volume=1.4' },
  radio: { af: 'highpass=f=200,lowpass=f=5000,acompressor=threshold=0.08:ratio=6:makeup=2,acrusher=bits=10:mode=log:mix=0.2' },
  megaphone: { af: 'highpass=f=600,lowpass=f=3500,acrusher=bits=6:mode=log:mix=0.4,volume=1.5' },
};
// Pitch shift in semitones without changing the length: resample, then stretch back with atempo.
export function pitchFilter(st) {
  if (!st) return null;
  const k = 2 ** (st / 12);
  return `asetrate=${Math.round(48000 * k)},aresample=48000,${atempoChain(1 / k)}`;
}
// Studio voice: cut rumble, gentle noise reduction (left out when denoise is set), less boxiness, more
// presence, softer "s" sounds, steadier level.
export function enhanceFilter(withNoise = true) {
  return ['highpass=f=80', withNoise ? 'afftdn=nr=10:nf=-45:tn=1' : null, 'equalizer=f=220:t=q:w=1:g=-2', 'equalizer=f=3200:t=q:w=1.4:g=3',
    'deesser=i=0.45:m=0.5:f=0.5', 'acompressor=threshold=0.1:ratio=3:attack=8:release=160:makeup=1.6', 'alimiter=limit=0.95'].filter(Boolean).join(',');
}
// Studio voice, denoise, voice effect and pitch for an item, in that order (input is 48 kHz stereo).
export function soundFilters(x) {
  const v = VOICE_FX[x.voice] || {};
  return [x.enhance ? enhanceFilter(!x.denoise) : null, denoiseFilter(x.denoise), pitchFilter((x.pitch || 0) + (v.pitch || 0)), v.af].filter(Boolean);
}
// Stabilize: vidstab with the pass-1 file for this exact source range, else the one-pass deshake.
export function stabilizeFilter(c, a) {
  const trf = stabFile(a, c);
  const amt = c.stabilize;
  if (trf) return `vidstabtransform=input=${q(trf)}:smoothing=${Math.round(6 + amt * 34)}:optzoom=1:zoomspeed=0.2:interpol=bicubic,unsharp=5:5:0.5:3:3:0.3`;
  return `deshake=rx=${Math.round(16 + amt * 32)}:ry=${Math.round(16 + amt * 32)}:edge=mirror`;
}
// Blend mode -> ffmpeg blend filter mode.
const BLEND_FF = { screen: 'screen', multiply: 'multiply', overlay: 'overlay', softlight: 'softlight', lighten: 'lighten', darken: 'darken', add: 'addition', difference: 'difference' };

export function buildCommand(project, outFile, { quality = 'final', frames = null, still = false, resolution, fps: fpsOpt, bitrate, encoder = 'cpu' } = {}) {
  const L = layout(project);
  if (!L.clips.length) throw new Error('Timeline is empty. Add at least one clip before exporting.');
  const short = Math.min(project.settings.width, project.settings.height);
  const k = RESOLUTIONS[resolution] ? RESOLUTIONS[resolution] / short : quality === 'draft' ? 0.5 : 1;
  const W = even(project.settings.width * k), H = even(project.settings.height * k);
  const fps = Math.round(Number(fpsOpt)) || project.settings.fps || 30;
  const bg = hex(project.settings.background || '#000000');
  const total = L.videoDuration;

  const args = ['-y', '-hide_banner', '-nostdin'];
  const filters = [];
  let input = 0;
  const tmpDir = fs.mkdtempSync(path.join(DATA_DIR, 'tmp-'));

  // 1. One input per clip, normalised to WxH@fps with stereo 48k audio of exact duration.
  L.clips.forEach((c, i) => {
    const a = project.assets[c.assetId];
    const file = path.join(MEDIA_DIR, a.file);
    const srcLen = c.out - c.in;
    const dur = c.duration;
    if (a.type === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', f3(dur + 0.5), '-i', file);
    else args.push('-ss', f3(c.in), '-t', f3(c.freeze ? 0.5 : srcLen), '-i', file);
    const n = input++;
    const sp = c.speed || 1;
    const T = c.transform || {};
    const tail = `setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(dur)},setpts=PTS-STARTPTS,settb=AVTB`;
    const cleaned = regionFilters(c, a, i, n, file, args, filters, () => input++);
    const geo = geometry(T, bg);
    // Timing: freeze = hold the first frame; reverse (at most REVERSE_MAX s, frames kept in memory, so
    // limited to the canvas size first); then constant speed or a speed ramp.
    const timing = [];
    if (c.stabilize && !c.freeze && a.type === 'video') timing.push(stabilizeFilter(c, a));
    if (c.freeze) timing.push('trim=end_frame=1', 'setpts=PTS-STARTPTS', `tpad=stop_mode=clone:stop_duration=${f3(dur + 1)}`);
    else {
      // Smooth slow motion interpolates the in-between frames (only where the clip is slowed).
      const smooth = c.smooth && (c.ramp ? c.ramp.points.some((q) => q.speed < 1) : sp < 1) ? c.smooth : null;
      const M = Math.max(W, H), cap = `scale=w='min(iw,${M})':h='min(ih,${M})':force_original_aspect_ratio=decrease`;
      if (c.reverse) timing.push(`fps=${fps}`, cap, 'reverse');
      else if (smooth === 'motion') timing.push(cap);
      timing.push(c.ramp ? `setpts='(${rampExpr(c)})/TB'` : `setpts=PTS/${sp}`);
      if (smooth) timing.push(smooth === 'motion' ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `minterpolate=fps=${fps}:mi_mode=blend`);
    }
    filters.push(`${cleaned ? `[${cleaned}]` : `[${n}:v]setpts=PTS-STARTPTS,`}${timing.join(',')}${geo.length ? `,${geo.join(',')}` : ''}[h${i}]`);
    const src = applyColor(filters, `h${i}`, c.color, `cc${i}`, 'yuv420p');
    const fit = c.fit || 'contain';
    const fitOut = `fit${i}`;
    if (fit === 'cover' && c.reframe?.points?.length) {
      // Reframe: the crop window follows the subject (per-frame x/y), clamped so the frame stays filled.
      const z = c.reframe.zoom || 1, fx = reframeTrack(c, 'x'), fy = reframeTrack(c, 'y');
      filters.push(`[${src}]scale=${even(W * z)}:${even(H * z)}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:x='clip((${kfExpr(fx)})*iw-ow/2,0,iw-ow)':y='clip((${kfExpr(fy)})*ih-oh/2,0,ih-oh)',setsar=1[${fitOut}]`);
    } else if (fit === 'cover') {
      filters.push(`[${src}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${fitOut}]`);
    } else if (fit === 'blur') {
      const bw = even(W / 4), bh = even(H / 4);
      filters.push(`[${src}]split[bgs${i}][fgs${i}]`);
      filters.push(`[bgs${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.08,setsar=1[bgb${i}]`);
      filters.push(`[fgs${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fgb${i}]`);
      filters.push(`[bgb${i}][fgb${i}]overlay=(W-w)/2:(H-h)/2[${fitOut}]`);
    } else {
      filters.push(`[${src}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1[${fitOut}]`);
    }
    let last = fitOut;
    // Scale / position inside the canvas: keyframed or animated (per-frame expressions), or static.
    const pl = clipPlacement(c, dur);
    const s = T.scale ?? 1, x = T.x ?? 0.5, y = T.y ?? 0.5;
    if (pl) {
      filters.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${f3(dur + 1)}[cb${i}]`);
      filters.push(`[${last}]scale=w='max(2,trunc(${W}*(${pl.S})/2)*2)':h='max(2,trunc(${H}*(${pl.S})/2)*2)':eval=frame[fs${i}]`);
      filters.push(`[cb${i}][fs${i}]overlay=x='${W}*(${pl.X})-w/2':y='${H}*(${pl.Y})-h/2':shortest=1[tr${i}]`);
      last = `tr${i}`;
    } else if (s !== 1 || x !== 0.5 || y !== 0.5) {
      const sw = even(W * s), sh = even(H * s);
      filters.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${f3(dur + 1)}[cb${i}]`);
      filters.push(`[${last}]scale=${sw}:${sh}[fs${i}]`);
      filters.push(`[cb${i}][fs${i}]overlay=x=${f3(W * x - sw / 2)}:y=${f3(H * y - sh / 2)}:shortest=1[tr${i}]`);
      last = `tr${i}`;
    }
    const mo = c.motion && motionFilter(c.motion, W, H, fps, dur);
    if (mo) { filters.push(`[${last}]${mo}[mo${i}]`); last = `mo${i}`; }
    // After the tail the clip is exactly dur long at fps, so fades and effects can use clip-local t.
    const post = [];
    if (c.animIn?.type === 'fade') post.push(`fade=t=in:st=0:d=${f3(Math.min(c.animIn.duration, dur / 2))}:color=${bg}`);
    if (c.animOut?.type === 'fade') { const d = Math.min(c.animOut.duration, dur / 2); post.push(`fade=t=out:st=${f3(dur - d)}:d=${f3(d)}:color=${bg}`); }
    const fxs = (c.effects || []).filter((e) => e.from < dur && e.to > e.from);
    if (!post.length && !fxs.length && !c.mask) filters.push(`[${last}]${tail}[v${i}]`);
    else {
      filters.push(`[${last}]${tail}${post.length ? `,${post.join(',')}` : ''}[vt${i}]`);
      let cur = `vt${i}`;
      fxs.forEach((e, j) => { cur = applyEffect(filters, cur, e, `fx${i}_${j}`, W, H, fps); });
      if (c.mask) {
        // Mask on a main clip (fractions of the canvas): drawn once, used as alpha, the background shows outside.
        const t = `cm${i}`;
        filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=0.2,format=gray,trim=end_frame=1,geq=lum='255*${maskExpr(c.mask)}',loop=loop=-1:size=1,setpts=N/${fps}/TB,trim=duration=${f3(dur)}[${t}m]`);
        filters.push(`[${cur}]format=yuva420p[${t}c]`, `[${t}c][${t}m]alphamerge[${t}a]`);
        filters.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${f3(dur)}[${t}b]`, `[${t}b][${t}a]overlay=shortest=1,format=yuv420p[${t}]`);
        cur = t;
      }
      filters.push(`[${cur}]settb=AVTB[v${i}]`); // effects like zoompan change the timebase; xfade needs them equal
    }

    if (a.type === 'video' && a.hasAudio && !c.freeze) {
      const vol = c.keyframes?.volume ? `volume='${kfExpr(c.keyframes.volume)}':eval=frame` : `volume=${c.volume ?? 1}`;
      const head = `[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS${c.reverse ? ',areverse' : ''}${soundFilters(c).map((f) => `,${f}`).join('')}`;
      const tail = `${vol},apad=whole_dur=${f3(dur)},atrim=duration=${f3(dur)},asetpts=PTS-STARTPTS[a${i}]`;
      const segs = c.ramp ? rampAudioSegments(c) : null;
      if (!segs || segs.length === 1) filters.push(`${head},${atempoChain(segs ? segs[0].tempo : sp)},${tail}`);
      else {
        // Each ramp segment at its own tempo (pitch kept), joined back together.
        filters.push(`${head},asplit=${segs.length}${segs.map((_, j) => `[ra${i}_${j}]`).join('')}`);
        segs.forEach((g, j) => filters.push(`[ra${i}_${j}]atrim=start=${f3(g.a)}:end=${f3(g.b)},asetpts=PTS-STARTPTS,${atempoChain(g.tempo)}[rb${i}_${j}]`));
        filters.push(`${segs.map((_, j) => `[rb${i}_${j}]`).join('')}concat=n=${segs.length}:v=0:a=1,${tail}`);
      }
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(dur)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  // 2. Join clips: xfade/acrossfade when a transition is set, else concat.
  let vPrev = 'v0', aPrev = 'a0';
  L.clips.slice(1).forEach((c, j) => {
    const i = j + 1;
    const vOut = `vj${i}`, aOut = `aj${i}`;
    const tr = c.transition;
    if (tr && tr.type !== 'none' && c.overlap > 0) {
      filters.push(`[${vPrev}][v${i}]xfade=transition=${tr.type}:duration=${f3(c.overlap)}:offset=${f3(c.start)}[${vOut}]`);
      filters.push(`[${aPrev}][a${i}]acrossfade=d=${f3(c.overlap)}[${aOut}]`);
    } else {
      filters.push(`[${vPrev}][v${i}]concat=n=2:v=1:a=0[${vOut}]`);
      filters.push(`[${aPrev}][a${i}]concat=n=2:v=0:a=1[${aOut}]`);
    }
    vPrev = vOut; aPrev = aOut;
  });

  // 3. Overlays (picture-in-picture, logos, B-roll), lowest track first.
  const mixIn = [`[${aPrev}]`];
  const overlays = [...(project.overlays || [])].sort((a, b) => a.track - b.track || a.start - b.start);
  overlays.forEach((o, i) => {
    if (o.start >= total) return;
    const a = project.assets[o.assetId];
    const sp = o.speed || 1;
    const dur = overlayDuration(o);
    const vis = Math.min(dur, total - o.start);
    const file = path.join(MEDIA_DIR, a.file);
    if (a.type === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', f3(vis), '-i', file);
    else args.push(...(o.loop ? ['-stream_loop', '-1'] : []), '-ss', f3(o.in), '-t', f3(vis * sp), '-i', file);
    const n = input++;
    const K = o.keyframes || {};
    const free = o.fit !== 'cover' && o.fit !== 'contain';
    filters.push(`[${n}:v]setpts=(PTS-STARTPTS)/${sp},fps=${fps},${[...geometry({ crop: o.crop, flipH: o.flipH, flipV: o.flipV }, 'black'), 'format=yuva420p'].join(',')}[oh${i}]`);
    const osrc = applyColor(filters, `oh${i}`, o.color, `oc${i}`, 'yuva420p');
    let ch = [];
    // Chroma key first, on the source pixels (before scaling softens the edges).
    if (o.key) {
      ch.push(`chromakey=color=0x${o.key.color.slice(1)}:similarity=${f3(o.key.similarity)}:blend=${f3(o.key.blend)}`);
      const spill = o.key.despill && spillOf(o.key.color);
      if (spill) ch.push(`despill=type=${spill}`, 'format=yuva420p');
    }
    // Mask: drawn once on the first frame's alpha (so it has the overlay's exact size), repeated for
    // every frame and multiplied into the alpha (keeps PNG transparency and the chroma key).
    let ovIn = osrc;
    if (o.mask) {
      const t = `mk${i}`;
      filters.push(`[${osrc}]${ch.length ? `${ch.join(',')},` : ''}split[${t}c][${t}s]`);
      filters.push(`[${t}s]alphaextract,split[${t}a][${t}f]`);
      filters.push(`[${t}f]trim=end_frame=1,geq=lum='255*${maskExpr(o.mask)}',loop=loop=-1:size=1,setpts=N/${fps}/TB[${t}m]`);
      filters.push(`[${t}a][${t}m]blend=all_mode=multiply:shortest=1[${t}b]`);
      filters.push(`[${t}c][${t}b]alphamerge[${t}o]`);
      ovIn = `${t}o`; ch = [];
    }
    // Alpha first, on fixed-size frames: geq crashes when a keyframed scale changes the frame size mid-stream.
    if (K.opacity) ch.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${kfExpr(K.opacity, 'T')})'`);
    else if (o.opacity < 1) ch.push(`colorchannelmixer=aa=${o.opacity}`);
    if (o.animation === 'fade') {
      const d = Math.min(0.3, vis / 2);
      ch.push(`fade=t=in:st=0:d=${f3(d)}:alpha=1`, `fade=t=out:st=${f3(vis - d)}:d=${f3(d)}:alpha=1`);
    }
    // Keyframed rotation needs a fixed output box, so it runs before a (possibly keyframed) free-fit scale.
    const iw0 = (a.width || W) * (o.crop?.w ?? 1), ih0 = (a.height || H) * (o.crop?.h ?? 1);
    const hyp = even(Math.hypot(iw0, ih0));
    // Rotation runs in a fixed box before the scale when either is keyframed (filters after a per-frame scale must cope with changing sizes).
    const rotA = K.rotate ? `(${kfExpr(K.rotate)})*PI/180` : o.rotate ? `${o.rotate}*PI/180` : null;
    // Pop: grows from nothing with a small overshoot (free fit; overlay-local t, before the start shift).
    const PD = f3(Math.min(0.35, vis / 2));
    const pop = free && o.animation === 'pop' ? `(if(lt(t,${PD}),1+2.70158*pow(t/${PD}-1,3)+1.70158*pow(t/${PD}-1,2),1))` : null;
    const rotFirst = free && rotA && (K.rotate || K.scale || pop);
    if (rotFirst) ch.push(`rotate=a='${rotA}':ow=${hyp}:oh=${hyp}:c=none`);
    const widen = rotFirst ? hyp / iw0 : 1;
    if (o.fit === 'cover') ch.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
    else if (o.fit === 'contain') ch.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
    else if (K.scale || pop) ch.push(`scale=w='max(2,trunc(${W}*(${K.scale ? kfExpr(K.scale) : o.scale})${pop ? `*${pop}` : ''}*${f3(widen)}/2)*2)':h=-2:eval=frame`);
    else ch.push(`scale=${even(W * o.scale * widen)}:-2`);
    if (rotA && !rotFirst) ch.push(K.rotate ? `rotate=a='${rotA}':ow='hypot(iw,ih)':oh=ow:c=none` : `rotate=${rotA}:ow=rotw(${rotA}):oh=roth(${rotA}):c=none`);
    ch.push(`setpts=PTS+${f3(o.start)}/TB`);
    filters.push(`[${ovIn}]${ch.join(',')}[ov${i}]`);
    // Overlay position: keyframes use the main timeline t, shifted to overlay-local time.
    const lt = `(t-${f3(o.start)})`;
    const cx = !free ? f3(W / 2) : K.x ? `${W}*(${kfExpr(K.x, lt)})` : f3(W * o.x);
    const cy = !free ? f3(H / 2) : K.y ? `${H}*(${kfExpr(K.y, lt)})` : f3(H * o.y);
    const pos = K.x || K.y ? `x='${cx}-overlay_w/2':y='${cy}-overlay_h/2'` : `x=${cx}-overlay_w/2:y=${cy}-overlay_h/2`;
    const vOut = `vo${i}`;
    const when = `enable='between(t,${f3(o.start)},${f3(o.start + vis)})'`;
    if (!o.blend || !BLEND_FF[o.blend]) filters.push(`[${vPrev}][ov${i}]overlay=${pos}:eof_action=pass:${when}[${vOut}]`);
    else {
      // Blend modes: place the overlay on a transparent full-size layer, blend its colors with the
      // frame below in RGB (blend needs equal sizes and ignores alpha), then let the layer's alpha
      // decide where the blended colors show.
      const mode = BLEND_FF[o.blend], t = `b${i}`;
      filters.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${f3(total)},format=yuva420p[${t}cv]`);
      filters.push(`[${t}cv][ov${i}]overlay=${pos}:eof_action=pass:${when}:format=auto,format=yuva420p,split[${t}l1][${t}l2]`);
      filters.push(`[${vPrev}]split[${t}m1][${t}m2]`);
      filters.push(`[${t}l1]format=gbrap[${t}lc]`, `[${t}m1]format=gbrap[${t}mc]`);
      filters.push(`[${t}mc][${t}lc]blend=c0_mode=${mode}:c1_mode=${mode}:c2_mode=${mode}:c3_mode=normal:c3_opacity=0,format=yuv420p[${t}bl]`);
      filters.push(`[${t}l2]alphaextract[${t}mk]`, `[${t}bl][${t}mk]alphamerge[${t}ba]`);
      filters.push(`[${t}m2][${t}ba]overlay=format=auto,format=yuv420p[${vOut}]`);
    }
    vPrev = vOut;
    if (a.type === 'video' && a.hasAudio && ((o.volume ?? 0) > 0 || K.volume)) {
      const ms = Math.round(o.start * 1000);
      const vol = K.volume ? `volume='${kfExpr(K.volume)}':eval=frame` : `volume=${o.volume}`;
      filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,${soundFilters(o).map((f) => `${f},`).join('')}${atempoChain(sp)},atrim=duration=${f3(vis)},${vol}${ms > 0 ? `,adelay=${ms}|${ms}` : ''}[oa${i}]`);
      mixIn.push(`[oa${i}]`);
    }
  });

  // 4. Text overlays and captions: one ASS file rendered by libass, fonts staged next to it.
  const font = defaultFont();
  const sub = buildAss(project, { defaultFont: font, total });
  if (sub) {
    const assFile = path.join(tmpDir, 'text.ass');
    fs.writeFileSync(assFile, sub.ass);
    const fontsDir = path.join(tmpDir, 'fonts');
    stageFonts(sub.families, fontsDir);
    filters.push(`[${vPrev}]ass=filename=${q(assFile)}:fontsdir=${q(fontsDir)}:shaping=complex[vtxt]`);
    vPrev = 'vtxt';
  }
  // Caption emoji: color PNGs over the text (libass would draw them black and white). Missing files are skipped.
  if (project.captions) {
    const kk = W / project.settings.width, b0 = emojiBox(project.captions.style, project.settings.width, project.settings.height);
    const box = { size: even(b0.size * kk), x: b0.x * kk, y: b0.y * kk };
    captionEmoji(project.captions, total).slice(0, 60).forEach((e, i) => {
      const file = emojiFile(e.emoji);
      if (!file) return;
      const d = e.end - e.start;
      args.push('-loop', '1', '-framerate', String(fps), '-t', f3(d), '-i', file);
      const n = input++;
      const pop = Math.min(0.15, d / 3);
      filters.push(`[${n}:v]format=rgba,scale=${box.size}:${box.size},fade=t=in:st=0:d=${f3(pop)}:alpha=1,setpts=PTS+${f3(e.start)}/TB[em${i}]`);
      filters.push(`[${vPrev}][em${i}]overlay=x=${f3(box.x - box.size / 2)}:y=${f3(box.y - box.size / 2)}:eof_action=pass:enable='between(t,${f3(e.start)},${f3(e.end)})'[vem${i}]`);
      vPrev = `vem${i}`;
    });
  }
  // Progress bar: a full-width strip that slides in from the left as the video plays.
  if (project.progressBar) {
    const pb = project.progressBar, bh = even(pb.height * (W / project.settings.width));
    filters.push(`color=c=${hex(pb.color)}:s=${W}x${bh}:r=${fps}:d=${f3(total)}[pbar]`);
    filters.push(`[${vPrev}][pbar]overlay=x='-w+w*t/${f3(total)}':y=${pb.position === 'top' ? 0 : H - bh}:eof_action=pass[vpb]`);
    vPrev = 'vpb';
  }

  // 5. Audio items (music, sfx, voice) mixed under the clip audio.
  project.music.forEach((m, i) => {
    if (m.start >= total) return;
    const a = project.assets[m.assetId];
    args.push('-ss', f3(m.in), '-t', f3(m.out - m.in), '-i', path.join(MEDIA_DIR, a.file));
    const n = input++;
    const len = Math.min(m.out - m.in, total - m.start);
    const ch = [`aformat=sample_rates=48000:channel_layouts=stereo`, `asetpts=PTS-STARTPTS`, ...soundFilters(m), `atrim=duration=${f3(len)}`, `volume=${m.volume}`].filter(Boolean);
    if (m.fadeIn > 0) ch.push(`afade=t=in:st=0:d=${f3(m.fadeIn)}`);
    if (m.fadeOut > 0) ch.push(`afade=t=out:st=${f3(Math.max(0, len - m.fadeOut))}:d=${f3(m.fadeOut)}`);
    const ms = Math.round(m.start * 1000);
    if (ms > 0) ch.push(`adelay=${ms}|${ms}`);
    filters.push(`[${n}:a]${ch.join(',')}[m${i}]`);
    mixIn.push(`[m${i}]`);
  });
  // Ducking: music items with duck > 0 are compressed whenever speech (clip audio + voice items) is present.
  const ducked = project.music.map((m, i) => ({ m, i })).filter(({ m }) => m.duck > 0 && m.role !== 'voice' && m.start < total);
  if (ducked.length) {
    const keys = [];
    const tap = (label) => { filters.push(`[${label}]asplit=2[${label}s][${label}k]`); keys.push(`[${label}k]`); return `[${label}s]`; };
    mixIn[0] = tap(aPrev);
    project.music.forEach((m, i) => { const at = mixIn.indexOf(`[m${i}]`); if (m.role === 'voice' && at > 0) mixIn[at] = tap(`m${i}`); });
    const keyChain = `${keys.join('')}${keys.length > 1 ? `amix=inputs=${keys.length}:duration=longest:normalize=0,` : ''}apad=whole_dur=${f3(total)}`;
    filters.push(ducked.length > 1 ? `${keyChain},asplit=${ducked.length}${ducked.map((_, j) => `[dk${j}]`).join('')}` : `${keyChain}[dk0]`);
    ducked.forEach(({ m, i }, j) => {
      filters.push(`[m${i}][dk${j}]sidechaincompress=threshold=0.015:ratio=${f3(1 + 19 * m.duck)}:attack=15:release=400:makeup=1[md${i}]`);
      mixIn[mixIn.indexOf(`[m${i}]`)] = `[md${i}]`;
    });
  }
  let aFinal = aPrev;
  if (mixIn.length > 1) {
    filters.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:duration=first:normalize=0,alimiter=limit=0.95[amix]`);
    aFinal = 'amix';
  }

  const graphFile = path.join(tmpDir, 'graph.txt');
  if (frames) {
    // Pick the frame nearest each requested time, write JPEGs.
    const sel = frames.map((t) => `between(t,${f3(t - 0.5 / fps)},${f3(t + 0.5 / fps - 0.0001)})`).join('+');
    filters.push(`[${vPrev}]select='${sel}'${still ? ',format=yuvj420p' : `,scale=-2:${Math.min(H, 960)},format=yuvj420p`}[vsel]`);
    filters.push(`[${aFinal}]anullsink`);
    fs.writeFileSync(graphFile, filters.join(';\n'));
    args.push(...filterGraphArgs(graphFile), '-map', '[vsel]', '-fps_mode', 'vfr', '-t', f3(Math.max(...frames) + 2 / fps),
      '-c:v', 'mjpeg', '-q:v', still ? '2' : '4', '-frames:v', String(frames.length), outFile);
  } else {
    // Lanczos scaling everywhere in the graph: sharper when footage is scaled up (e.g. 720p into a 1080p export).
    fs.writeFileSync(graphFile, `sws_flags=lanczos+accurate_rnd+full_chroma_int;\n${filters.join(';\n')}`);
    let enc = 'libx264';
    if (encoder === 'gpu' || encoder === 'auto') {
      enc = detectGpuEncoder() || (encoder === 'auto' ? 'libx264' : null);
      if (!enc) { fs.rmSync(tmpDir, { recursive: true, force: true }); throw new Error('No working GPU encoder on this machine (tried NVENC, Quick Sync, AMF). Use encoder cpu or auto.'); }
    } else if (encoder && encoder !== 'cpu') enc = encoder;
    // Chapters (chapter markers) as MP4 chapters.
    const chapters = (project.markers || []).filter((m) => m.kind === 'chapter' && m.t < total);
    const chapArgs = [];
    if (chapters.length) {
      const meta = path.join(tmpDir, 'chapters.txt');
      const esc = (x) => String(x).replace(/([=;#\\\n])/g, '\\$1');
      fs.writeFileSync(meta, ';FFMETADATA1\n' + chapters.map((m, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(m.t * 1000)}\nEND=${Math.round((chapters[i + 1]?.t ?? total) * 1000)}\ntitle=${esc(m.label || `Chapter ${i + 1}`)}\n`).join(''));
      args.push('-f', 'ffmetadata', '-i', meta);
      chapArgs.push('-map_chapters', String(input++));
    }
    args.push(...filterGraphArgs(graphFile), '-map', `[${vPrev}]`, '-map', `[${aFinal}]`, ...chapArgs,
      '-t', f3(total), ...encoderArgs(enc, { draft: quality === 'draft', bitrate }),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile);
    return { args, total, tmpDir, graph: filters.join(';\n'), encoder: enc, width: W, height: H, fps, chapters: chapters.map((m) => `${chapterTime(m.t)} ${m.label || ''}`.trim()), credits: projectCredits(project) };
  }
  return { args, total, tmpDir, graph: filters.join(';\n') };
}

// ---------- Loudness: two-pass loudnorm on the finished file (EBU R128 integrated loudness) ----------
export const TRUE_PEAK = -1.5;
// The JSON block loudnorm prints with print_format=json (first pass).
export function parseLoudnorm(stderr) {
  const m = String(stderr).match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]), v = (k) => Number(j[k]);
  return { i: v('input_i'), tp: v('input_tp'), lra: v('input_lra'), thresh: v('input_thresh'), offset: v('target_offset') };
}
// Second pass with the measured values: linear gain when the peaks allow it (loudnorm falls back to its
// dynamic mode otherwise). LRA is raised to the measured range so linear mode is not refused for that.
export function loudnormFilter(target, m) {
  const lra = Math.min(50, Math.max(11, Math.ceil(m.lra || 0)));
  return `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=${lra}:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary`;
}
export async function normalizeLoudness(file, target) {
  let log = '';
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=11:print_format=json`, '-f', 'null', '-'], { onStderr: (s) => { log += s; } });
  const m = parseLoudnorm(log);
  if (!m || !Number.isFinite(m.i) || m.i < -70) return { target, measured: null, applied: false, note: 'silent, left as it was' };
  const was = `${m.i.toFixed(1)} LUFS`;
  if (Math.abs(m.i - target) < 0.5 && m.tp <= TRUE_PEAK + 0.5) return { target, measured: m.i, applied: false, note: `already ${was}` };
  const tmp = file.replace(/\.mp4$/i, '') + '.loud.mp4';
  try {
    await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', file, '-map', '0:v?', '-map', '0:a', '-c:v', 'copy', '-af', loudnormFilter(target, m),
      '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  return { target, measured: m.i, applied: true, note: `${target} LUFS (was ${was})` };
}

// opts: { quality, resolution, fps, bitrate, encoder, loudness (LUFS target or null) } (see buildCommand).
export function startExport(project, opts = {}) {
  if (typeof opts === 'string') opts = { quality: opts };
  const quality = opts.quality || 'final';
  const tag = opts.resolution ? `-${opts.resolution}` : quality === 'draft' ? '-draft' : '';
  const file = `${(project.name || 'video').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${tag}.mp4`;
  const job = createJob('export', { file, quality, path: path.join(EXPORT_DIR, file) });
  const loud = Number.isFinite(opts.loudness) ? opts.loudness : null;
  const share = loud === null ? 0.99 : 0.95; // the loudness passes take the last few percent
  let cmd;
  try {
    cmd = buildCommand(project, path.join(EXPORT_DIR, file), { ...opts, quality });
    Object.assign(job, { encoder: cmd.encoder, width: cmd.width, height: cmd.height, fps: cmd.fps });
  } catch (e) {
    finishJob(job, e.message);
    return job;
  }
  const p = spawn('ffmpeg', cmd.args);
  let tail = '';
  p.stderr.on('data', (d) => {
    const s = d.toString();
    tail = (tail + s).slice(-4000);
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
    if (m) job.progress = Math.min(share, share * (+m[1] * 3600 + +m[2] * 60 + +m[3]) / cmd.total);
  });
  p.on('error', (e) => finishJob(job, `Could not start ffmpeg: ${e.message}`));
  p.on('close', (code) => {
    fs.rmSync(cmd.tmpDir, { recursive: true, force: true });
    if (code !== 0) return finishJob(job, tail.split('\n').filter(Boolean).slice(-6).join('\n'));
    // Text for the video description next to the export: chapters and the credits the licenses ask for.
    if (cmd.chapters?.length || cmd.credits?.length) {
      if (cmd.chapters?.length) job.chapters = cmd.chapters;
      if (cmd.credits?.length) job.credits = cmd.credits;
      const parts = [cmd.chapters?.length ? cmd.chapters.join('\n') : '', cmd.credits?.length ? `Music and sounds:\n${cmd.credits.join('\n')}` : ''].filter(Boolean);
      try { fs.writeFileSync(job.path.replace(/\.mp4$/i, '.description.txt'), parts.join('\n\n') + '\n'); } catch { /* the video is still fine */ }
    }
    if (loud === null) return finishJob(job, null);
    job.stage = 'loudness';
    normalizeLoudness(job.path, loud)
      .then((r) => { job.loudness = r; finishJob(job, null); })
      .catch((e) => { job.loudness = { target: loud, applied: false, note: `not normalized (${e.message.slice(-200)})` }; finishJob(job, null); });
  });
  return job;
}

// Composite stills of the finished timeline (with overlays, text, captions, transitions).
// opts.still: full size, high quality (cover image) instead of draft previews.
export async function renderFrames(project, times, { still = false } = {}) {
  const L = layout(project);
  const fps = project.settings.fps || 30;
  const maxT = Math.max(0, L.videoDuration - 1 / fps);
  // One frame per distinct frame slot.
  const ts = [...new Set(times.map((t) => Math.round(Math.min(maxT, Math.max(0, t)) * fps)))].sort((a, b) => a - b).map((f) => f / fps);
  const cmd = buildCommand(project, '', { quality: still ? 'final' : 'draft', frames: ts, still });
  const pattern = path.join(cmd.tmpDir, `frame-${uid('f')}-%03d.jpg`);
  cmd.args[cmd.args.length - 1] = pattern;
  try {
    await run('ffmpeg', cmd.args);
    return ts.map((t, i) => {
      const f = pattern.replace('%03d', String(i + 1).padStart(3, '0'));
      return fs.existsSync(f) ? { t, data: fs.readFileSync(f).toString('base64') } : null;
    }).filter(Boolean);
  } finally {
    fs.rmSync(cmd.tmpDir, { recursive: true, force: true });
  }
}
