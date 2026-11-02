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
export function buildCommand(project, outFile, { quality = 'final', frames = null } = {}) {
  const L = layout(project);
  if (!L.clips.length) throw new Error('Timeline is empty. Add at least one clip before exporting.');
  const k = quality === 'draft' ? 0.5 : 1;
  const W = even(project.settings.width * k), H = even(project.settings.height * k);
  const fps = project.settings.fps || 30;
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
    const tail = `setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(dur)},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`;
    const head = [`[${n}:v]setpts=(PTS-STARTPTS)/${sp}`, ...geometry(T, bg)].join(',');
    const fit = c.fit || 'contain';
    const fitOut = `fit${i}`;
    if (fit === 'cover') {
      filters.push(`${head},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${fitOut}]`);
    } else if (fit === 'blur') {
      const bw = even(W / 4), bh = even(H / 4);
      filters.push(`${head},split[bgs${i}][fgs${i}]`);
      filters.push(`[bgs${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.08,setsar=1[bgb${i}]`);
      filters.push(`[fgs${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fgb${i}]`);
      filters.push(`[bgb${i}][fgb${i}]overlay=(W-w)/2:(H-h)/2[${fitOut}]`);
    } else {
      filters.push(`${head},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1[${fitOut}]`);
    }
    let last = fitOut;
    // Scale / position inside the canvas.
    const s = T.scale ?? 1, x = T.x ?? 0.5, y = T.y ?? 0.5;
    if (s !== 1 || x !== 0.5 || y !== 0.5) {
      const sw = even(W * s), sh = even(H * s);
      filters.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${f3(dur + 1)}[cb${i}]`);
      filters.push(`[${last}]scale=${sw}:${sh}[fs${i}]`);
      filters.push(`[cb${i}][fs${i}]overlay=x=${f3(W * x - sw / 2)}:y=${f3(H * y - sh / 2)}:shortest=1[tr${i}]`);
      last = `tr${i}`;
    }
    const mo = c.motion && motionFilter(c.motion, W, H, fps, dur);
    if (mo) { filters.push(`[${last}]${mo}[mo${i}]`); last = `mo${i}`; }
    filters.push(`[${last}]${tail}`);

    if (a.type === 'video' && a.hasAudio) {
      filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,${atempoChain(sp)},` +
        `volume=${c.volume ?? 1},apad=whole_dur=${f3(dur)},atrim=duration=${f3(dur)},asetpts=PTS-STARTPTS[a${i}]`);
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
    const ch = [`setpts=(PTS-STARTPTS)/${sp}`, `fps=${fps}`, ...geometry({ crop: o.crop, flipH: o.flipH, flipV: o.flipV }, 'black'), 'format=yuva420p'];
    if (o.fit === 'cover') ch.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
    else if (o.fit === 'contain') ch.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
    else ch.push(`scale=${even(W * o.scale)}:-2`);
    if (o.rotate) { const r = `${o.rotate}*PI/180`; ch.push(`rotate=${r}:ow=rotw(${r}):oh=roth(${r}):c=none`); }
    if (o.opacity < 1) ch.push(`colorchannelmixer=aa=${o.opacity}`);
    if (o.animation === 'fade') {
      const d = Math.min(0.3, vis / 2);
      ch.push(`fade=t=in:st=0:d=${f3(d)}:alpha=1`, `fade=t=out:st=${f3(vis - d)}:d=${f3(d)}:alpha=1`);
    }
    ch.push(`setpts=PTS+${f3(o.start)}/TB`);
    filters.push(`[${n}:v]${ch.join(',')}[ov${i}]`);
    const cx = o.fit === 'free' ? W * o.x : W / 2, cy = o.fit === 'free' ? H * o.y : H / 2;
    const vOut = `vo${i}`;
    filters.push(`[${vPrev}][ov${i}]overlay=x=${f3(cx)}-overlay_w/2:y=${f3(cy)}-overlay_h/2:eof_action=pass:enable='between(t,${f3(o.start)},${f3(o.start + vis)})'[${vOut}]`);
    vPrev = vOut;
    if (a.type === 'video' && a.hasAudio && (o.volume ?? 0) > 0) {
      const ms = Math.round(o.start * 1000);
      filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,${atempoChain(sp)},atrim=duration=${f3(vis)},volume=${o.volume}${ms > 0 ? `,adelay=${ms}|${ms}` : ''}[oa${i}]`);
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
    args.push(...filterGraphArgs(graphFile), '-map', `[${vPrev}]`, '-map', `[${aFinal}]`,
      '-t', f3(total),
      '-c:v', 'libx264', '-preset', quality === 'draft' ? 'ultrafast' : 'medium', '-crf', quality === 'draft' ? '28' : '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile);
  }
  return { args, total, tmpDir, graph: filters.join(';\n') };
}

export function startExport(project, quality = 'final') {
  const file = `${(project.name || 'video').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${quality === 'draft' ? '-draft' : ''}.mp4`;
  const job = createJob('export', { file, quality, path: path.join(EXPORT_DIR, file) });
  let cmd;
  try {
    cmd = buildCommand(project, path.join(EXPORT_DIR, file), { quality });
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
