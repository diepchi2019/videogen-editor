// Builds an ffmpeg filter graph from the project and renders an MP4 (or preview frames).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { layout, overlayDuration, uid } from './model.js';
import { DATA_DIR, EXPORT_DIR, MEDIA_DIR } from './store.js';
import { buildAss } from './ass.js';
import { defaultFont, stageFonts } from './fonts.js';
import { createJob, finishJob, getJob, listJobs } from './jobs.js';
import { run } from './media.js';

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
  if (b || ct !== 1 || s !== 1) f.push(`eq=brightness=${f3(b * 0.4)}:contrast=${f3(ct)}:saturation=${f3(s)}`);
  if (tp) f.push(`colorbalance=rs=${f3(0.15 * tp)}:bs=${f3(-0.15 * tp)}:rm=${f3(0.1 * tp)}:bm=${f3(-0.1 * tp)}:rh=${f3(0.05 * tp)}:bh=${f3(-0.05 * tp)}`);
  if (c.vignette) f.push(`vignette=angle=${f3(0.25 + 0.6 * c.vignette)}`);
  let cur = inL;
  if (f.length) { filters.push(`[${cur}]${f.join(',')},format=${fmt}[${tag}a]`); cur = `${tag}a`; }
  const look = c.filter && LOOKS[c.filter];
  if (look) {
    const I = c.filterIntensity ?? 1;
    if (I >= 0.999) filters.push(`[${cur}]${look},format=${fmt}[${tag}b]`);
    else {
      filters.push(`[${cur}]format=${fmt},split[${tag}o][${tag}i]`);
      filters.push(`[${tag}i]${look},format=${fmt}[${tag}l]`);
      filters.push(`[${tag}l][${tag}o]blend=all_mode=normal:all_opacity=${f3(I)}[${tag}b]`);
    }
    cur = `${tag}b`;
  }
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
    default:
      return inL;
  }
  return out;
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
export function buildCommand(project, outFile, { quality = 'final', frames = null, resolution, fps: fpsOpt, bitrate, encoder = 'cpu' } = {}) {
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
    else args.push('-ss', f3(c.in), '-t', f3(srcLen), '-i', file);
    const n = input++;
    const sp = c.speed || 1;
    const T = c.transform || {};
    const tail = `setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(dur)},setpts=PTS-STARTPTS,settb=AVTB`;
    const cleaned = regionFilters(c, a, i, n, file, args, filters, () => input++);
    const geo = geometry(T, bg);
    filters.push(`${cleaned ? `[${cleaned}]setpts=PTS/${sp}` : `[${n}:v]setpts=(PTS-STARTPTS)/${sp}`}${geo.length ? `,${geo.join(',')}` : ''}[h${i}]`);
    const src = applyColor(filters, `h${i}`, c.color, `cc${i}`, 'yuv420p');
    const fit = c.fit || 'contain';
    const fitOut = `fit${i}`;
    if (fit === 'cover') {
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
    if (!post.length && !fxs.length) filters.push(`[${last}]${tail}[v${i}]`);
    else {
      filters.push(`[${last}]${tail}${post.length ? `,${post.join(',')}` : ''}[vt${i}]`);
      let cur = `vt${i}`;
      fxs.forEach((e, j) => { cur = applyEffect(filters, cur, e, `fx${i}_${j}`, W, H, fps); });
      filters.push(`[${cur}]settb=AVTB[v${i}]`); // effects like zoompan change the timebase; xfade needs them equal
    }

    if (a.type === 'video' && a.hasAudio) {
      const vol = c.keyframes?.volume ? `volume='${kfExpr(c.keyframes.volume)}':eval=frame` : `volume=${c.volume ?? 1}`;
      filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,${atempoChain(sp)},` +
        `${vol},apad=whole_dur=${f3(dur)},atrim=duration=${f3(dur)},asetpts=PTS-STARTPTS[a${i}]`);
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
    else args.push('-ss', f3(o.in), '-t', f3(vis * sp), '-i', file);
    const n = input++;
    const K = o.keyframes || {};
    const free = o.fit !== 'cover' && o.fit !== 'contain';
    filters.push(`[${n}:v]setpts=(PTS-STARTPTS)/${sp},fps=${fps},${[...geometry({ crop: o.crop, flipH: o.flipH, flipV: o.flipV }, 'black'), 'format=yuva420p'].join(',')}[oh${i}]`);
    const osrc = applyColor(filters, `oh${i}`, o.color, `oc${i}`, 'yuva420p');
    const ch = [];
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
    const rotFirst = free && rotA && (K.rotate || K.scale);
    if (rotFirst) ch.push(`rotate=a='${rotA}':ow=${hyp}:oh=${hyp}:c=none`);
    const widen = rotFirst ? hyp / iw0 : 1;
    if (o.fit === 'cover') ch.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
    else if (o.fit === 'contain') ch.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
    else if (K.scale) ch.push(`scale=w='max(2,trunc(${W}*(${kfExpr(K.scale)})*${f3(widen)}/2)*2)':h=-2:eval=frame`);
    else ch.push(`scale=${even(W * o.scale * widen)}:-2`);
    if (rotA && !rotFirst) ch.push(K.rotate ? `rotate=a='${rotA}':ow='hypot(iw,ih)':oh=ow:c=none` : `rotate=${rotA}:ow=rotw(${rotA}):oh=roth(${rotA}):c=none`);
    ch.push(`setpts=PTS+${f3(o.start)}/TB`);
    filters.push(`[${osrc}]${ch.join(',')}[ov${i}]`);
    // Overlay position: keyframes use the main timeline t, shifted to overlay-local time.
    const lt = `(t-${f3(o.start)})`;
    const cx = !free ? f3(W / 2) : K.x ? `${W}*(${kfExpr(K.x, lt)})` : f3(W * o.x);
    const cy = !free ? f3(H / 2) : K.y ? `${H}*(${kfExpr(K.y, lt)})` : f3(H * o.y);
    const pos = K.x || K.y ? `x='${cx}-overlay_w/2':y='${cy}-overlay_h/2'` : `x=${cx}-overlay_w/2:y=${cy}-overlay_h/2`;
    const vOut = `vo${i}`;
    filters.push(`[${vPrev}][ov${i}]overlay=${pos}:eof_action=pass:enable='between(t,${f3(o.start)},${f3(o.start + vis)})'[${vOut}]`);
    vPrev = vOut;
    if (a.type === 'video' && a.hasAudio && ((o.volume ?? 0) > 0 || K.volume)) {
      const ms = Math.round(o.start * 1000);
      const vol = K.volume ? `volume='${kfExpr(K.volume)}':eval=frame` : `volume=${o.volume}`;
      filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,${atempoChain(sp)},atrim=duration=${f3(vis)},${vol}${ms > 0 ? `,adelay=${ms}|${ms}` : ''}[oa${i}]`);
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

  // 5. Audio items (music, sfx, voice) mixed under the clip audio.
  project.music.forEach((m, i) => {
    if (m.start >= total) return;
    const a = project.assets[m.assetId];
    args.push('-ss', f3(m.in), '-t', f3(m.out - m.in), '-i', path.join(MEDIA_DIR, a.file));
    const n = input++;
    const len = Math.min(m.out - m.in, total - m.start);
    const ch = [`aformat=sample_rates=48000:channel_layouts=stereo`, `asetpts=PTS-STARTPTS`, `atrim=duration=${f3(len)}`, `volume=${m.volume}`];
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
    filters.push(`[${vPrev}]select='${sel}',scale=-2:${Math.min(H, 960)}[vsel]`);
    filters.push(`[${aFinal}]anullsink`);
    fs.writeFileSync(graphFile, filters.join(';\n'));
    args.push(...filterGraphArgs(graphFile), '-map', '[vsel]', '-fps_mode', 'vfr', '-t', f3(Math.max(...frames) + 2 / fps),
      '-c:v', 'mjpeg', '-q:v', '4', '-frames:v', String(frames.length), outFile);
  } else {
    fs.writeFileSync(graphFile, filters.join(';\n'));
    let enc = 'libx264';
    if (encoder === 'gpu' || encoder === 'auto') {
      enc = detectGpuEncoder() || (encoder === 'auto' ? 'libx264' : null);
      if (!enc) { fs.rmSync(tmpDir, { recursive: true, force: true }); throw new Error('No working GPU encoder on this machine (tried NVENC, Quick Sync, AMF). Use encoder cpu or auto.'); }
    } else if (encoder && encoder !== 'cpu') enc = encoder;
    args.push(...filterGraphArgs(graphFile), '-map', `[${vPrev}]`, '-map', `[${aFinal}]`,
      '-t', f3(total), ...encoderArgs(enc, { draft: quality === 'draft', bitrate }),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile);
    return { args, total, tmpDir, graph: filters.join(';\n'), encoder: enc, width: W, height: H, fps };
  }
  return { args, total, tmpDir, graph: filters.join(';\n') };
}

// opts: { quality, resolution, fps, bitrate, encoder } (see buildCommand).
export function startExport(project, opts = {}) {
  if (typeof opts === 'string') opts = { quality: opts };
  const quality = opts.quality || 'final';
  const tag = opts.resolution ? `-${opts.resolution}` : quality === 'draft' ? '-draft' : '';
  const file = `${(project.name || 'video').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${tag}.mp4`;
  const job = createJob('export', { file, quality, path: path.join(EXPORT_DIR, file) });
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
    if (m) job.progress = Math.min(0.99, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / cmd.total);
  });
  p.on('error', (e) => finishJob(job, `Could not start ffmpeg: ${e.message}`));
  p.on('close', (code) => {
    fs.rmSync(cmd.tmpDir, { recursive: true, force: true });
    if (code === 0) finishJob(job, null);
    else finishJob(job, tail.split('\n').filter(Boolean).slice(-6).join('\n'));
  });
  return job;
}

// Composite stills of the finished timeline (with overlays, text, captions, transitions).
export async function renderFrames(project, times) {
  const L = layout(project);
  const fps = project.settings.fps || 30;
  const maxT = Math.max(0, L.videoDuration - 1 / fps);
  // One frame per distinct frame slot.
  const ts = [...new Set(times.map((t) => Math.round(Math.min(maxT, Math.max(0, t)) * fps)))].sort((a, b) => a - b).map((f) => f / fps);
  const cmd = buildCommand(project, '', { quality: 'draft', frames: ts });
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
