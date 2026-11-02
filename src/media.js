// ffprobe metadata, thumbnails, frame extraction.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err.push(d); onStderr?.(d.toString()); });
    p.on('error', reject);
    p.on('close', (code) => code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-1500)}`)));
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(out.toString());
  const v = j.streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const fmt = j.format?.format_name || '';
  const isImage = v && (/image2|png_pipe|jpeg_pipe|webp_pipe|gif|bmp/.test(fmt)) && !(Number(j.format.duration) > 0.5 && fmt === 'gif');
  const type = !v ? (a ? 'audio' : null) : isImage ? 'image' : 'video';
  if (!type) throw new Error('Unsupported file: no audio or video stream');
  let width = v?.width, height = v?.height;
  const rot = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || v?.tags?.rotate || 0);
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  return {
    type,
    duration: type === 'image' ? null : Number(j.format.duration || v?.duration || a?.duration || 0),
    width, height,
    hasAudio: !!a,
  };
}

export async function makeThumb(asset) {
  if (asset.type === 'audio') return null;
  const out = path.join(DATA_DIR, 'thumbs', `${asset.id}.jpg`);
  const t = asset.type === 'video' ? Math.min(1, (asset.duration || 0) / 3) : 0;
  await run('ffmpeg', ['-y', '-ss', String(t), '-i', path.join(DATA_DIR, 'media', asset.file), '-frames:v', '1', '-vf', 'scale=240:-2', out]);
  return `/thumbs/${asset.id}.jpg`;
}

export async function extractFrames(asset, from, to, count) {
  if (asset.type === 'audio') throw new Error('Audio assets have no frames');
  const file = path.join(DATA_DIR, 'media', asset.file);
  if (asset.type === 'image') {
    const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', '-']);
    return [{ t: 0, data: buf.toString('base64') }];
  }
  const d = asset.duration;
  const a = Math.max(0, Math.min(d, Number(from) || 0));
  const b = Math.max(a, Math.min(d, to === undefined ? d : Number(to)));
  const k = Math.max(1, Math.min(12, Math.round(Number(count) || 6)));
  const frames = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? a : a + ((b - a) * i) / (k - 1);
    const tt = Math.min(t, Math.max(0, d - 0.05));
    const buf = await run('ffmpeg', ['-v', 'error', '-ss', tt.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=384:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', '-']);
    if (buf.length) frames.push({ t: tt, data: buf.toString('base64') });
  }
  return frames;
}

export const fileExists = (f) => fs.existsSync(f);
