// End-to-end smoke test: start server on a temp data dir, upload, edit through tools, export, verify with ffprobe.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fx = path.join(root, 'test', 'fixtures');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'videogen-test-'));
const PORT = 3999, BASE = `http://localhost:${PORT}`;
const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), VIDEOGEN_DATA: data }, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); console.log(`ok - ${m}`); };

async function tool(name, body = {}) {
  const r = await (await fetch(`${BASE}/api/tool/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.isError || r.error) throw new Error(`${name}: ${r.content || r.error}`);
  return r;
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/state`); break; } catch { await sleep(100); } }
  const form = new FormData();
  for (const f of ['a.mp4', 'b_noaudio.mp4', 'c.png', 'music.mp3']) form.append('files', new Blob([fs.readFileSync(path.join(fx, f))]), f);
  const up = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: form })).json();
  ok(up.added?.length === 4, 'uploaded 4 assets');
  const [vid, vidNoA, img, mus] = up.added;
  ok(vid.type === 'video' && vid.hasAudio && vidNoA.type === 'video' && !vidNoA.hasAudio && img.type === 'image' && mus.type === 'audio', 'asset types detected');

  await tool('add_clip', { assetId: vid.id, in: 0.5, out: 4.5 });
  await tool('add_clip', { assetId: vidNoA.id });
  await tool('add_clip', { assetId: img.id, duration: 2 });
  let s = await tool('get_timeline');
  const clips = s.layout.clips;
  ok(clips.length === 3, '3 clips on track');
  await tool('set_transition', { clipId: clips[1].id, type: 'slideleft', duration: 0.6 });
  await tool('set_transition', { clipId: clips[2].id, type: 'circleopen', duration: 0.5 });
  await tool('set_clip', { clipId: clips[0].id, speed: 2, fit: 'blur' });
  await tool('set_clip', { clipId: clips[2].id, fit: 'cover' });
  await tool('split_clip', { at: 3 });
  await tool('add_text', { text: "Juju's Big Day!\nNgày đẹp trời", start: 0, end: 3, y: 0.15, size: 90, box: true, animation: 'pop' });
  await tool('add_text', { text: 'Subscribe: 100% fun', start: 4, end: 7, y: 0.8, size: 60, color: '#ffde00', animation: 'slideup' });
  await tool('add_music', { assetId: mus.id, volume: 0.3, fadeIn: 0.5 });
  await tool('undo'); await tool('redo');
  const frames = await tool('look_at_asset', { assetId: vid.id, count: 3 });
  ok(frames.content.filter((b) => b.type === 'image').length === 3, 'look_at_asset returns 3 frames');
  s = await tool('get_timeline');
  console.log(s.content);
  const expected = s.layout.duration;

  const ex = await tool('export_video', { quality: 'draft' });
  const jobId = /job_\w+/.exec(ex.content)[0];
  let job;
  for (let i = 0; i < 300; i++) { job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await sleep(300); }
  ok(job.status === 'done', `export finished (${job.error || job.file})`);
  const out = path.join(data, 'exports', job.file);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  ok(Math.abs(dur - expected) < 0.25, `output duration ${dur.toFixed(2)}s ~ timeline ${expected}s`);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', out]).toString();
  ok(/video,540,960/.test(streams) && /audio/.test(streams), `streams: ${streams.trim().replace(/\n/g, ' | ')}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', out, '-frames:v', '1', path.join(root, 'test', 'last-frame.png')]);
  console.log(`\nAll good. Output: ${out}`);
} finally {
  srv.kill();
}
