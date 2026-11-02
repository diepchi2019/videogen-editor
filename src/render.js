// Builds an ffmpeg filter graph from the project and renders an MP4.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { layout } from './model.js';
import { DATA_DIR, EXPORT_DIR, MEDIA_DIR } from './store.js';
import { uid } from './model.js';

const FONT = process.env.VIDEOGEN_FONT ||
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'].find((f) => fs.existsSync(f));

const jobs = new Map();
export const getJob = (id) => jobs.get(id);
export const listJobs = () => [...jobs.values()];

const f3 = (n) => Number(n).toFixed(3);
const hex = (c, a = 1) => `${(c || '#ffffff').replace(/^#/, '0x')}@${a}`;
// Escape a value for use inside a filtergraph option (single-quoted).
const q = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((x) => `atempo=${x.toFixed(4)}`).join(',');
}

export function buildCommand(project, outFile, { quality = 'final' } = {}) {
  const L = layout(project);
  if (!L.clips.length) throw new Error('Timeline is empty. Add at least one clip before exporting.');
  const k = quality === 'draft' ? 0.5 : 1;
  const W = Math.round(project.settings.width * k / 2) * 2, H = Math.round(project.settings.height * k / 2) * 2;
  const fps = project.settings.fps || 30;
  const bg = hex(project.settings.background || '#000000');
  const total = L.videoDuration;

  const args = ['-y', '-hide_banner'];
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
    const tail = `setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(dur)},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`;
    const head = `[${n}:v]setpts=(PTS-STARTPTS)/${sp}`;
    const fit = c.fit || 'contain';
    if (fit === 'cover') {
      filters.push(`${head},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${tail}`);
    } else if (fit === 'blur') {
      filters.push(`${head},split[bgs${i}][fgs${i}]`);
      filters.push(`[bgs${i}]scale=${Math.round(W / 4 / 2) * 2}:${Math.round(H / 4 / 2) * 2}:force_original_aspect_ratio=increase,crop=${Math.round(W / 4 / 2) * 2}:${Math.round(H / 4 / 2) * 2},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.08[bgb${i}]`);
      filters.push(`[fgs${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgb${i}]`);
      filters.push(`[bgb${i}][fgb${i}]overlay=(W-w)/2:(H-h)/2,${tail}`);
    } else {
      filters.push(`${head},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},${tail}`);
    }
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

  // 3. Text overlays with drawtext (text read from files to avoid escaping issues).
  project.texts.forEach((t, i) => {
    if (t.start >= total) return;
    const tf = path.join(tmpDir, `t${i}.txt`);
    fs.writeFileSync(tf, t.text.replace(/\\n/g, '\n'));
    const size = Math.round(t.size * k);
    const s = f3(t.start), e = f3(Math.min(t.end, total));
    const anim = t.animation || 'none';
    const dt = anim === 'pop' ? 0.15 : 0.35;
    const prog = `min(1,max(0,(t-${s})/${dt}))`;
    let y = `${H}*${t.y}-text_h/2`;
    if (anim === 'slideup') y = `${y}+(1-${prog})*${Math.round(80 * k)}`;
    if (anim === 'pop') y = `${y}+(1-${prog})*${Math.round(20 * k)}`;
    const alpha = anim === 'none' ? '1' : prog;
    const parts = [
      FONT ? `fontfile=${q(FONT)}` : 'font=Sans',
      `textfile=${q(tf)}`, `fontsize=${size}`, `fontcolor=${hex(t.color)}`,
      `x=${W}*${t.x}-text_w/2`, `y=${q(y)}`, `line_spacing=${Math.round(size * 0.2)}`,
      `alpha=${q(alpha)}`, `enable=${q(`between(t,${s},${e})`)}`,
      'text_align=C',
    ];
    if (t.box) parts.push('box=1', `boxcolor=${hex(t.boxColor || '#000000', 0.6)}`, `boxborderw=${Math.round(size * 0.35)}`);
    else parts.push(`borderw=${Math.max(2, Math.round(size / 18))}`, 'bordercolor=black@0.7');
    const vOut = `vt${i}`;
    filters.push(`[${vPrev}]drawtext=${parts.join(':')}[${vOut}]`);
    vPrev = vOut;
  });

  // 4. Music mixed under the clip audio.
  const mixIn = [`[${aPrev}]`];
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
  fs.writeFileSync(graphFile, filters.join(';\n'));
  args.push('-filter_complex_script', graphFile, '-map', `[${vPrev}]`, '-map', `[${aFinal}]`,
    '-t', f3(total),
    '-c:v', 'libx264', '-preset', quality === 'draft' ? 'ultrafast' : 'medium', '-crf', quality === 'draft' ? '28' : '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile);
  return { args, total, tmpDir, graph: filters.join(';\n') };
}

export function startExport(project, quality = 'final') {
  const id = uid('job');
  const file = `${(project.name || 'video').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${quality === 'draft' ? '-draft' : ''}.mp4`;
  const job = { id, file, quality, status: 'running', progress: 0, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  let cmd;
  try {
    cmd = buildCommand(project, path.join(EXPORT_DIR, file), { quality });
  } catch (e) {
    Object.assign(job, { status: 'error', error: e.message });
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
  p.on('close', (code) => {
    fs.rmSync(cmd.tmpDir, { recursive: true, force: true });
    if (code === 0) Object.assign(job, { status: 'done', progress: 1 });
    else Object.assign(job, { status: 'error', error: tail.split('\n').filter(Boolean).slice(-6).join('\n') });
    job.finishedAt = Date.now();
  });
  return job;
}
