// End-to-end smoke test: start server on a temp data dir, upload, edit through tools, export, verify with ffprobe.
// Also drives the MCP server (mcp.js) with a real MCP client.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = path.join(root, 'test', 'fixtures');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'videogen-test-'));
const PORT = 3999, BASE = `http://localhost:${PORT}`;
const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), VIDEOGEN_DATA: data }, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); console.log(`ok - ${m}`); };
const hasWhisper = fs.existsSync(process.env.VIDEOGEN_WHISPER_MODEL || path.join(root, 'models', 'ggml-base.bin'));

async function tool(name, body = {}) {
  const r = await (await fetch(`${BASE}/api/tool/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.isError || r.error) throw new Error(`${name}: ${r.content || r.error}`);
  return r;
}
async function toolErr(name, body = {}) {
  const r = await (await fetch(`${BASE}/api/tool/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return r.isError ? String(r.content) : null;
}
const probe = (f, entries) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', f]).toString().trim();
const framesDir = path.join(root, 'test', 'last-timeline');

let mcp;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/state`); break; } catch { await sleep(100); } }
  const form = new FormData();
  for (const f of ['a.mp4', 'b_noaudio.mp4', 'c.png', 'music.mp3', 'speech.mp3']) form.append('files', new Blob([fs.readFileSync(path.join(fx, f))]), f);
  const up = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: form })).json();
  ok(up.added?.length === 5, 'uploaded 5 assets');
  const [vid, vidNoA, img, mus, speech] = up.added;
  ok(vid.type === 'video' && vid.hasAudio && vidNoA.type === 'video' && !vidNoA.hasAudio && img.type === 'image' && mus.type === 'audio' && speech.type === 'audio', 'asset types detected');

  // --- original editing flow ---
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
  await tool('add_text', { text: 'Subscribe: 100% {fun}', start: 4, end: 7, y: 0.8, size: 60, color: '#ffde00', animation: 'slideup', animationOut: 'fade' });
  await tool('add_music', { assetId: mus.id, volume: 0.3, fadeIn: 0.5 });
  await tool('undo'); await tool('redo');
  const frames = await tool('look_at_asset', { assetId: vid.id, count: 3 });
  ok(frames.content.filter((b) => b.type === 'image').length === 3, 'look_at_asset returns 3 frames');

  // --- new: transforms, Ken Burns, overlays, text styles, audio roles ---
  s = await tool('get_timeline');
  const L = s.layout.clips;
  await tool('set_clip', { clipId: L[L.length - 1].id, motion: 'zoom_in', motionIntensity: 0.25 });
  await tool('set_clip', { clipId: L[1].id, flipH: true, scale: 0.85, y: 0.45 });
  ok(/hex color/.test(await toolErr('add_text', { text: 'x', start: 0, end: 1, color: "red'" })), 'bad color rejected');
  const fonts = await tool('list_fonts');
  const defFont = /Default: ([^.]+)\./.exec(fonts.content)[1];
  ok(defFont && defFont !== 'Sans', `list_fonts default font: ${defFont}`);
  const batch = await tool('batch_edit', { ops: [
    { name: 'add_overlay', input: { assetId: img.id, start: 0, duration: 5, x: 0.85, y: 0.08, scale: 0.18, opacity: 0.9 } },
    { name: 'add_overlay', input: { assetId: vid.id, start: 1.5, duration: 2, in: 2, x: 0.72, y: 0.62, scale: 0.4, volume: 0, animation: 'fade', track: 2 } },
    { name: 'set_overlay', input: { overlayId: '$2', rotate: 6 } },
    { name: 'add_text', input: { text: 'STYLED', start: 2, end: 5, y: 0.35, style: 'highlight', font: defFont, size: 110, animationOut: 'zoom' } },
    { name: 'add_music', input: { assetId: speech.id, role: 'voice', start: 1 } },
  ] });
  ok(/^1\. Added overlay/.test(batch.content) && batch.project.overlays.length === 2, 'batch_edit applied 5 ops');
  await tool('undo');
  ok((await tool('get_timeline')).project.overlays.length === 0, 'batch_edit undone in one step');
  await tool('redo');
  s = await tool('get_timeline');
  ok(s.project.overlays[1].rotate === 6 && s.project.music.some((m) => m.role === 'voice' && m.track === 2), 'batch $N reference + voice track');

  // --- captions from real speech ---
  if (hasWhisper) {
    const tr = await tool('get_transcript', { assetId: speech.id });
    ok(/welcome/i.test(tr.content) && /island/i.test(tr.content), `transcript: ${tr.content.split('\n')[1]}`);
    const cap = await tool('add_captions', { preset: 'karaoke', sources: ['voice'] });
    ok(/Captions: \d+ lines/.test(cap.content), cap.content);
    const lines = cap.project.captions.lines;
    const first = lines[0].words[0];
    ok(/welcome/i.test(first.w) && Math.abs(first.start - 1.12) < 0.3, `first caption word "${first.w}" at ${first.start}s (voice starts at 1s)`);
    await tool('update_captions', { lineId: lines[0].id, text: lines[0].words.map((w) => w.w).join(' ').replace(/island/i, 'ISLAND') });
    s = await tool('get_timeline');
    ok(/transcript ready/.test(s.content) && /Captions:\n\d+ lines, style karaoke/.test(s.content), 'summary shows transcript + captions');
  } else {
    console.log('skip - captions (no whisper model in models/ggml-base.bin)');
  }

  // --- Phase 2: color, effects, animations, keyframes, beats, ducking, waveforms, proxies ---
  s = await tool('get_timeline');
  const P2 = s.layout.clips;
  await tool('set_color', { clipId: P2[0].id, filter: 'cinematic', filterIntensity: 0.7, saturation: 1.2 });
  await tool('add_effect', { clipId: P2[1].id, type: 'zoom_pulse', rate: 2 });
  await tool('add_effect', { clipId: P2[3].id, type: 'light_leak' });
  await tool('set_clip', { clipId: P2[2].id, animIn: 'slide_up' });
  await tool('set_keyframes', { overlayId: s.project.overlays[0].id, property: 'x', keyframes: [{ t: 0, value: 0.85 }, { t: 4, value: 0.15 }] });
  const musicItem = s.project.music.find((m) => m.role === 'music');
  await tool('update_music', { musicId: musicItem.id, duck: 0.6 });
  const an = await tool('analyze_audio', { musicId: musicItem.id });
  ok(/tempo [\d.]+ BPM/.test(an.content), `analyze_audio: ${an.content.split('\n')[2].slice(0, 50)}…`);
  const mb = await tool('mark_beats', { musicId: musicItem.id });
  ok(/^Marked \d+ beats/.test(mb.content) && mb.project.markers.length > 4, mb.content.split('. ')[0]);
  const fitBeats = await tool('fit_clips_to_beats', { every: 2 });
  ok(/Cut \d of 4 clips on the beat/.test(fitBeats.content), fitBeats.content.split(';')[0]);
  s = await tool('get_timeline');
  ok(['filter cinematic', 'effects: fx_', 'anim in slide_up', 'keyframes: x', 'ducks under speech', 'beat markers'].every((x) => s.content.includes(x)), 'summary shows Phase 2 fields');
  const wf = await (await fetch(`${BASE}/api/waveform/${mus.id}`)).json();
  ok(wf.pps === 50 && wf.peaks.length > 100, `waveform: ${wf.peaks.length} peaks`);
  const sizeOf = async (u) => (await fetch(u)).headers.get('content-length');
  const before = await sizeOf(`${BASE}/preview/${vid.file}`);
  const px = await tool('create_proxies', { assetIds: [vid.id], force: true });
  const pjob = /job (job_\w+)/.exec(px.content)?.[1];
  for (let i = 0; i < 150; i++) { const j = await (await fetch(`${BASE}/api/jobs/${pjob}`)).json(); if (j.status !== 'running') break; await sleep(200); }
  const after = await sizeOf(`${BASE}/preview/${vid.file}`);
  ok(pjob && after && after !== before && before === await sizeOf(`${BASE}/media/${vid.file}`), `proxy served from /preview (${before} -> ${after} bytes)`);
  ok(/resolution must be one of/.test(await toolErr('export_video', { resolution: '8k' })), 'export_video validates resolution');

  // --- look at the finished timeline ---
  const look = await tool('look_at_timeline', { times: [0.5, 2.5, 4] });
  const imgs = look.content.filter((b) => b.type === 'image');
  ok(imgs.length === 3, 'look_at_timeline returns 3 composite frames');
  fs.rmSync(framesDir, { recursive: true, force: true }); fs.mkdirSync(framesDir, { recursive: true });
  imgs.forEach((b, i) => fs.writeFileSync(path.join(framesDir, `t${i}.jpg`), Buffer.from(b.source.data, 'base64')));

  // --- export with wait ---
  s = await tool('get_timeline');
  console.log(s.content);
  const expected = s.layout.duration;
  const ex = await tool('export_video', { quality: 'draft', wait: true });
  const outPath = /done 100% file: (.+?\.mp4)/.exec(ex.content)?.[1];
  ok(outPath && fs.existsSync(outPath), `export finished: ${outPath}`);
  const dur = Number(probe(outPath, 'format=duration'));
  ok(Math.abs(dur - expected) < 0.25, `output duration ${dur.toFixed(2)}s ~ timeline ${expected}s`);
  const streams = probe(outPath, 'stream=codec_type,width,height');
  ok(/video,540,960/.test(streams) && /audio/.test(streams), `streams: ${streams.replace(/\n/g, ' | ')}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2.5', '-i', outPath, '-frames:v', '1', path.join(root, 'test', 'last-frame.png')]);

  // --- projects ---
  const firstId = s.project.id;
  await tool('rename_project', { name: 'Reel one' });
  const np = await tool('create_project', { name: 'Reel two', aspect: '1:1' });
  ok(np.project.name === 'Reel two' && np.project.settings.width === 1080 && np.project.clips.length === 0 && Object.keys(np.project.assets).length === 5, 'create_project: empty timeline, shared media');
  await tool('add_clip', { assetId: img.id, duration: 1 });
  const lp = await tool('list_projects');
  ok(/\* proj_\w+ "Reel two"/.test(lp.content) && /- proj_\w+ "Reel one"/.test(lp.content), 'list_projects marks the open project');
  const back = await tool('open_project', { projectId: 'Reel one' });
  ok(back.project.id === firstId && back.project.clips.length === 4, 'open_project restores the first project');
  ok(/Cannot delete the open project/.test(await toolErr('delete_project', { projectId: firstId })), 'cannot delete open project');
  await tool('delete_project', { projectId: 'Reel two' });
  ok(!(await tool('list_projects')).content.includes('Reel two'), 'delete_project');

  // --- MCP server over stdio ---
  mcp = new Client({ name: 'smoke', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ command: 'node', args: [path.join(root, 'mcp.js')], env: { ...process.env, VIDEOGEN_URL: BASE } }));
  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name);
  ok(['look_at_timeline', 'batch_edit', 'add_overlay', 'add_captions', 'create_project', 'import_media'].every((n) => names.includes(n)), `MCP lists ${tools.length} tools`);
  ok(tools.find((t) => t.name === 'get_timeline').annotations?.readOnlyHint === true && tools.find((t) => t.name === 'delete_project').annotations?.destructiveHint === true, 'MCP tool annotations');
  const { resources } = await mcp.listResources();
  const res = await mcp.readResource({ uri: 'videogen://project/json' });
  ok(resources.length === 2 && JSON.parse(res.contents[0].text).project.id === firstId, 'MCP resource returns project JSON');
  const mt = await mcp.callTool({ name: 'look_at_timeline', arguments: { count: 1 } });
  ok(mt.content.some((b) => b.type === 'image' && b.mimeType === 'image/jpeg'), 'MCP look_at_timeline returns an image block');
  const imp = await mcp.callTool({ name: 'import_media', arguments: { paths: [path.join(fx, 'c.png')] } });
  ok(/img_\w+ "c\.png" image/.test(imp.content[0].text), 'MCP import_media');

  console.log(`\nAll good. Output: ${outPath}\nTimeline frames: ${framesDir}`);
} finally {
  await mcp?.close().catch(() => {});
  srv.kill();
}
