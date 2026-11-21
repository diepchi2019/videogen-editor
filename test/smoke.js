// End-to-end smoke test: start server on a temp data dir, upload, edit through tools, export, verify with ffprobe.
// Also drives the MCP server (mcp.js) with a real MCP client.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockElevenLabs } from './mock-elevenlabs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = path.join(root, 'test', 'fixtures');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'videogen-test-'));
const PORT = 3999, BASE = `http://localhost:${PORT}`;
// A fake ElevenLabs API stands in for the real one (no key, no cost).
const mockEl = await startMockElevenLabs(3201);
const srvEnv = { ...process.env, PORT: String(PORT), VIDEOGEN_DATA: data, ELEVENLABS_BASE_URL: `http://localhost:${mockEl.port}` };
delete srvEnv.ELEVENLABS_API_KEY;
const srv = spawn('node', ['server.js'], { cwd: root, env: srvEnv, stdio: 'inherit' });
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

  // --- reel styles and templates ---
  const sl = await tool('list_styles');
  ok(/builtin_bold_reel "Bold reel" \[built-in\]/.test(sl.content), 'list_styles shows built-ins');
  const logoId = back.project.overlays[0].id;
  const ss = await tool('save_style', { name: 'Smoke style', logoOverlayId: logoId, title: { size: 84 } });
  ok(/Saved style style_\w+ "Smoke style".*titles:.*size 84.*logo "c\.png"/.test(ss.content), 'save_style captures the look + logo');
  ok(ss.styles.some((x) => x.name === 'Smoke style'), 'state lists the saved style');
  const as = await tool('apply_style', { styleId: 'Bold reel' });
  ok(/Applied style "Bold reel"/.test(as.content) && as.project.clips.every((c) => c.fit === 'cover') && as.project.style.name === 'Bold reel', 'apply_style restyles clips');
  await tool('undo');
  const st2 = await tool('save_template', { name: 'Smoke template' });
  ok(/Saved template tpl_\w+ "Smoke template": 4 slots/.test(st2.content), 'save_template');
  const cf = await tool('create_from_template', { templateId: 'Smoke template', assetIds: [img.id, vid.id, vidNoA.id, vid.id], texts: ['From a template'] });
  ok(/Filled template "Smoke template": 4 slots/.test(cf.content) && cf.project.id !== firstId && cf.project.texts[0].text === 'From a template', 'create_from_template opens a filled project');
  await tool('apply_style', { styleId: 'Smoke style' });
  const tl = await tool('look_at_timeline', { times: [1] });
  const styled = tl.content.find((b) => b.type === 'image');
  ok(styled, 'styled template project renders');
  fs.writeFileSync(path.join(framesDir, 'styled-template.jpg'), Buffer.from(styled.source.data, 'base64'));

  // --- freeze frame, reverse, speed ramp, LUT, voiceover upload, group + copy, ripple delete, cover ---
  await tool('create_project', { name: 'Quick wins' });
  await tool('batch_edit', { ops: [
    { name: 'add_clip', input: { assetId: vid.id, in: 0, out: 4 } },
    { name: 'add_clip', input: { assetId: vid.id, in: 1, out: 3 } },
    { name: 'add_clip', input: { assetId: vidNoA.id } },
    { name: 'set_speed_ramp', input: { clipId: '$1', preset: 'hero' } },
    { name: 'set_clip', input: { clipId: '$2', reverse: true } },
  ] });
  const fz = await tool('freeze_frame', { at: 1, duration: 1 });
  ok(/Added freeze frame clip_\w+ at position 2/.test(fz.content), fz.content);
  const cube = ['LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.push(`${Math.min(1, r + 0.15)} ${g * 0.95} ${b * 0.7}`);
  const lutForm = new FormData();
  lutForm.append('files', new Blob([cube.join('\n')]), 'warm look.cube');
  const lu = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: lutForm })).json();
  ok(lu.luts?.[0] === 'warm_look.cube' && lu.luts.length === 1, 'import a .cube LUT');
  s = await tool('get_timeline');
  const QW = s.layout.clips;
  await tool('set_color', { clipId: QW[QW.length - 1].id, lut: 'warm look', lutIntensity: 0.8 });
  // A browser recording arrives as WebM/Opus and is stored as AAC.
  const webm = path.join(data, 'take.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libopus', webm]);
  const vf = new FormData();
  vf.append('files', new Blob([fs.readFileSync(webm)]), 'voiceover-take.webm');
  const vo = (await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: vf })).json()).added[0];
  ok(vo.type === 'audio' && vo.file.endsWith('.m4a') && Math.abs(vo.duration - 1.5) < 0.1, `voiceover upload stored as ${vo.file} (${vo.duration.toFixed(2)}s)`);
  const voice = /Added voice (voice_\w+)/.exec((await tool('add_music', { assetId: vo.id, role: 'voice', start: 0.5 })).content)[1];
  const title = /text_\w+/.exec((await tool('add_text', { text: 'QUICK WINS', start: 0.2, end: 1.8, y: 0.2, size: 90 })).content)[0];
  const grp = /grp_\w+/.exec((await tool('group_items', { ids: [title, voice] })).content)[0];
  await tool('duplicate_items', { ids: [grp], at: 4 });
  s = await tool('get_timeline');
  ok(s.project.texts.length === 2 && s.project.music.length === 2 && new Set(s.project.texts.map((x) => x.group)).size === 2, 'group + duplicate makes a second group');
  const beforeCut = s.layout.duration;
  const rd = await tool('delete_range', { start: 5, end: 5.5 });
  ok(Math.abs(rd.layout.duration - (beforeCut - 0.5)) < 0.01, rd.content);
  s = await tool('get_timeline');
  const missing = ['freeze frame of source', 'reversed', 'speed ramp 0:1.6x', 'LUT warm_look.cube 0.8', 'group grp_'].filter((x) => !s.content.includes(x));
  ok(!missing.length, `summary shows freeze, reverse, ramp (split by the freeze), LUT, groups${missing.length ? `; missing ${missing}` : ''}`);
  const qwFrames = await tool('look_at_timeline', { times: [0.5, 1.5, 3.5, s.layout.duration - 0.5] });
  qwFrames.content.filter((b) => b.type === 'image').forEach((b, i) => fs.writeFileSync(path.join(framesDir, `quickwins-${i}.jpg`), Buffer.from(b.source.data, 'base64')));
  const qx = await tool('export_video', { quality: 'draft', wait: true });
  const qPath = /done 100% file: (.+?\.mp4)/.exec(qx.content)?.[1];
  const qDur = Number(probe(qPath, 'format=duration'));
  ok(qPath && Math.abs(qDur - s.layout.duration) < 0.25, `freeze/reverse/ramp/LUT export: ${qDur.toFixed(2)}s ~ timeline ${s.layout.duration}s`);
  const cov = await tool('export_cover', { t: 0.5 });
  const covPath = /: (.+?\.jpg) \(URL/.exec(cov.content[0].text)?.[1];
  ok(covPath && probe(covPath, 'stream=width,height') === '1080,1920' && cov.content.some((b) => b.type === 'image'), `export_cover: ${path.basename(covPath)} 1080x1920`);
  // Phase 2.5 extras: a green-screen overlay (keyed), a blended overlay and noise reduction.
  const gs = path.join(data, 'greenscreen.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00d040:s=640x360:d=3,drawbox=x=220:y=90:w=200:h=180:color=red:t=fill',
    '-f', 'lavfi', '-i', 'anoisesrc=d=3:c=pink:a=0.05', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', gs]);
  const gf = new FormData();
  gf.append('files', new Blob([fs.readFileSync(gs)]), 'greenscreen.mp4');
  gf.append('files', new Blob([fs.readFileSync(path.join(fx, 'c.png'))]), 'texture.png');
  const [gsA, texA] = (await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: gf })).json()).added;
  await tool('add_overlay', { assetId: gsA.id, start: 0.2, duration: 2.5, scale: 0.8, y: 0.7, chromaKey: 'green', keySimilarity: 0.2, denoise: 0.6, volume: 1, track: 2 });
  await tool('add_overlay', { assetId: texA.id, start: 0, duration: 3, fit: 'cover', blend: 'multiply', opacity: 0.6, track: 1 });
  await tool('update_music', { musicId: voice, denoise: 0.5 });
  s = await tool('get_timeline');
  ok(/chroma key #00ff00/.test(s.content) && /blend multiply/.test(s.content) && /denoise 0\.5/.test(s.content), 'summary shows chroma key, blend mode, denoise');
  const exFrames = await tool('look_at_timeline', { times: [1.2] });
  exFrames.content.filter((b) => b.type === 'image').forEach((b) => fs.writeFileSync(path.join(framesDir, 'key-blend.jpg'), Buffer.from(b.source.data, 'base64')));
  const kx = await tool('export_video', { quality: 'draft', wait: true });
  const kPath = /done 100% file: (.+?\.mp4)/.exec(kx.content)?.[1];
  ok(kPath && Math.abs(Number(probe(kPath, 'format=duration')) - s.layout.duration) < 0.25, `chroma key + blend + denoise export (${kPath ? path.basename(kPath) : kx.content})`);
  // Phase 2.5 extras, part 2: a looping transparent GIF sticker that pops in, a split-screen mask,
  // voice effects, smooth slow motion and the newer effects.
  const gifFile = path.join(data, 'sticker.gif');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=black@0:s=120x120:d=1:r=10,format=rgba,geq=r=255:g=200:b=0:a='if(lt(hypot(X-60-30*sin(2*PI*T),Y-60),25),255,0)',split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128", '-loop', '0', gifFile]);
  const sf = new FormData();
  sf.append('files', new Blob([fs.readFileSync(gifFile)]), 'sticker.gif');
  const [gifA] = (await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: sf })).json()).added;
  ok(gifA.type === 'video' && gifA.codec === 'gif', 'animated GIF imported as a video sticker');
  await tool('add_overlay', { assetId: gifA.id, start: 0.5, duration: 4, x: 0.3, y: 0.3, scale: 0.25, animation: 'pop', track: 5 });
  s = await tool('get_timeline');
  const stk = s.project.overlays.find((o) => o.assetId === gifA.id);
  ok(stk.loop && stk.out === 4, 'GIF sticker loops past its 1s length');
  await tool('set_mask', { overlayId: s.project.overlays.find((o) => o.assetId === texA.id).id, shape: 'linear', angle: 90, feather: 0.05 });
  await tool('set_clip', { clipId: s.project.clips[0].id, voiceEffect: 'echo', pitch: -2 });
  await tool('update_music', { musicId: voice, voiceEffect: 'radio' });
  const slow = s.project.clips.find((c) => !c.freeze && !c.ramp && s.project.assets[c.assetId].type === 'video');
  if (slow) await tool('set_clip', { clipId: slow.id, speed: 0.5, smoothSlowMo: 'blend' });
  await tool('add_effect', { clipId: s.project.clips[0].id, type: 'kaleidoscope', intensity: 0.5 });
  s = await tool('get_timeline');
  ok(/pop in, loops/.test(s.content) && /mask linear/.test(s.content) && /voice echo, pitch -2/.test(s.content) && /kaleidoscope/.test(s.content) && (!slow || /smooth slow motion blend/.test(s.content)),
    'summary shows sticker, mask, voice effect, smooth slow motion, new effect');
  const xFrames = await tool('look_at_timeline', { times: [1.2] });
  xFrames.content.filter((b) => b.type === 'image').forEach((b) => fs.writeFileSync(path.join(framesDir, 'sticker-mask.jpg'), Buffer.from(b.source.data, 'base64')));
  const xx = await tool('export_video', { quality: 'draft', wait: true });
  const xPath = /done 100% file: (.+?\.mp4)/.exec(xx.content)?.[1];
  ok(xPath && Math.abs(Number(probe(xPath, 'format=duration')) - s.layout.duration) < 0.25, `sticker + mask + voice + smooth slow-mo export (${xPath ? path.basename(xPath) : xx.content})`);
  // Auto reframe: a red box moves across a 16:9 shot; reframed into 9:16 it must stay in the middle.
  const mv = path.join(data, 'moving.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=4:r=30', '-f', 'lavfi', '-i', 'color=c=red:s=80x80:d=4:r=30',
    '-filter_complex', "[0][1]overlay=x='100+250*t':y=320", '-pix_fmt', 'yuv420p', mv]);
  const mf = new FormData();
  mf.append('files', new Blob([fs.readFileSync(mv)]), 'moving.mp4');
  const mvA = (await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: mf })).json()).added[0];
  await tool('create_project', { name: 'Reframe', aspect: '9:16' });
  await tool('add_clip', { assetId: mvA.id });
  s = await tool('get_timeline');
  const grid = await tool('look_at_asset', { assetId: mvA.id, count: 2, grid: true });
  ok(grid.content.filter((b) => b.type === 'image').length === 2, 'look_at_asset with grid');
  const rf = await tool('reframe_clip', { clipId: s.layout.clips[0].id, points: [0, 1, 2, 3, 4].map((t) => ({ source: t, x: +((140 + 250 * t) / 1280).toFixed(3), y: 0.5 })) });
  ok(/left\/right \(x\)/.test(rf.content), rf.content);
  const rFrames = await tool('look_at_timeline', { times: [0.5, 3.5] });
  rFrames.content.filter((b) => b.type === 'image').forEach((b, i) => fs.writeFileSync(path.join(framesDir, `reframe-${i}.jpg`), Buffer.from(b.source.data, 'base64')));
  const rx = await tool('export_video', { quality: 'draft', wait: true });
  const rPath = /done 100% file: (.+?\.mp4)/.exec(rx.content)?.[1];
  const centre = (t) => [...execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', rPath, '-frames:v', '1', '-vf', 'crop=20:20:(iw-20)/2:(ih-20)/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
  const hits = [0.3, 1.5, 2.5, 3.7].map(centre);
  ok(rPath && hits.every(([r, , b]) => r > 150 && b < 100), `reframe keeps the moving subject centered (centre pixels ${hits.map((x) => x.join('/')).join(' ')})`);
  // Text to speech (Piper): the voiceover goes on a voice track and Whisper hears the same words.
  const voices = await tool('list_voices');
  if (/Text-to-speech voices/.test(voices.content)) {
    const vo = await tool('add_voiceover', { text: 'Welcome to the island. The quick brown fox jumps.', start: 0.2 });
    ok(/Added voice voice_\w+ .*s of speech, voice /.test(vo.content), vo.content.split(':')[0]);
    if (hasWhisper) {
      const voAsset = Object.values((await tool('get_timeline')).project.assets).find((x) => x.tts);
      const heard = (await tool('get_transcript', { assetId: voAsset.id })).content;
      ok(/island/i.test(heard) && /fox/i.test(heard), `Whisper hears the voiceover: ${heard.split('\n')[1]}`);
    }
  } else console.log('skip - text to speech (no Piper or no voices)');
  // ElevenLabs engine against the fake API: a bad key is refused, the key is never sent back, delivery settings
  // reach the API, and asking again for the same voiceover makes no new (billed) request.
  const ttsPost = async (body) => (await fetch(`${BASE}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const bad = await ttsPost({ elevenlabsKey: 'wrong-key-0123456789abcdef' });
  ok(/Invalid API key/.test(bad.error || ''), `bad ElevenLabs key refused: ${bad.error}`);
  const KEY = 'test-key-0123456789abcd';
  const saved = await ttsPost({ elevenlabsKey: KEY, engine: 'elevenlabs', elevenlabsVoice: 'vRachel01' });
  const ttsView = await (await fetch(`${BASE}/api/tts?voices`)).text();
  ok(saved.elevenlabs?.hasKey && saved.elevenlabs.keyHint === '…abcd' && !ttsView.includes(KEY) && !JSON.stringify(await (await fetch(`${BASE}/api/state`)).json()).includes(KEY) &&
    /"name":"Rachel"/.test(ttsView) && /"id":"eleven_v3","name":"Eleven v3","vi":true/.test(ttsView) && !/eleven_english_sts_v2/.test(ttsView), 'ElevenLabs key saved, never sent back; voices and TTS models listed');
  const elText = '[excited] We made it to the island!';
  const ev = await tool('add_voiceover', { text: elText, start: 1, expressiveness: 0.9 });
  const calls1 = await (await fetch(`http://localhost:${mockEl.port}/mock/requests`)).json();
  ok(/ElevenLabs eleven_v3, 35 characters/.test(ev.content) && calls1.length === 1 && calls1[0].voice === 'vRachel01' && calls1[0].body.model_id === 'eleven_v3' &&
    calls1[0].body.voice_settings?.stability === 0 && calls1[0].body.text === elText && /output_format=mp3_44100_128/.test(calls1[0].query), `ElevenLabs voiceover: ${ev.content.split(': ').pop()}`);
  await tool('add_voiceover', { text: elText, start: 4, expressiveness: 0.9 });
  const ev2 = await tool('add_voiceover', { text: 'Xin chào', engine: 'elevenlabs', voice: 'Minh', model: 'eleven_multilingual_v2', expressiveness: 0.2, speed: 1.2 });
  const calls2 = await (await fetch(`http://localhost:${mockEl.port}/mock/requests`)).json();
  ok(calls2.length === 2 && calls2[1].voice === 'vMinh0002' && calls2[1].body.voice_settings.stability === 0.68 && calls2[1].body.voice_settings.style === 0.14 && /voice Minh/.test(ev2.content),
    'same ElevenLabs voiceover reused (no second request); voice by name, model and expressiveness passed');
  const lv = await tool('list_voices');
  ok(/Default engine: elevenlabs/.test(lv.content) && /eleven_v3 \(2 languages, Vietnamese\)/.test(lv.content) && /Rachel \(female, american, young\)/.test(lv.content), 'list_voices shows the ElevenLabs account');
  await ttsPost({ engine: 'piper', elevenlabsKey: '' });
  const off = await tool('add_voiceover', { text: 'no key now', engine: 'elevenlabs' }).catch((e) => e.message);
  ok(/No ElevenLabs API key/.test(off), 'removing the key stops ElevenLabs with a clear message');
  // ⚙ Settings: one place for every setting; keys are checked, saved and never sent back.
  const setPost = async (body) => (await fetch(`${BASE}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const badSet = await setPost({ 'tts.elevenlabs.apiKey': 'wrong-key-0123456789abcdef' });
  const goodSet = await setPost({ 'tts.elevenlabs.apiKey': KEY, 'claude.model': 'claude-opus-5-5', 'text.defaultFont': 'Arial' });
  const setView = await (await fetch(`${BASE}/api/settings`)).text();
  ok(/Invalid API key/.test(badSet.error || '') && goodSet.settings['tts.elevenlabs.apiKey'].set && goodSet.settings['tts.elevenlabs.apiKey'].hint === '…abcd' &&
    goodSet.settings['claude.model'].value === 'claude-opus-5-5' && !setView.includes(KEY) && JSON.parse(setView).choices.claudeModels.includes('claude-sonnet-5-5'),
    '/api/settings checks and saves keys without sending them back');
  const ttsAfter = await (await fetch(`${BASE}/api/tts`)).json();
  ok(ttsAfter.elevenlabs.hasKey && ttsAfter.elevenlabs.keySource === 'saved', 'the Voice panel sees the key saved in Settings');
  await setPost({ 'tts.elevenlabs.apiKey': '', 'claude.model': '', 'text.defaultFont': '' });
  // Auto reframe with the face detector: a face slides across a 16:9 shot; the crop path must follow it.
  if (fs.existsSync(path.join(root, 'models', 'face', 'face_detection_yunet_2023mar.onnx'))) {
    const fv = path.join(data, 'facemove.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x4a6070:s=1280x720:d=4:r=25', '-loop', '1', '-i', path.join(fx, 'face.jpg'),
      '-filter_complex', "[1]scale=-2:400[f];[0][f]overlay=x='100+200*t':y=160:shortest=1,format=yuv420p", '-t', '4', fv]);
    const ff = new FormData();
    ff.append('files', new Blob([fs.readFileSync(fv)]), 'facemove.mp4');
    const fA = (await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: ff })).json()).added[0];
    await tool('create_project', { name: 'Auto reframe', aspect: '9:16' });
    await tool('add_clip', { assetId: fA.id });
    const ar = await tool('auto_reframe', {});
    const rp = (await tool('get_timeline')).project.clips[0].reframe?.points || [];
    // Face centre in the source: (100 + 200t + 144) / 1280 -> 0.19 at 0s, 0.66 at 3s.
    ok(/follows the face \(in 100% of frames/.test(ar.content) && rp.length >= 2 && Math.abs(rp[0].x - 0.19) < 0.04 && Math.abs(rp.at(-1).x - (244 + 200 * rp.at(-1).at) / 1280) < 0.04,
      `auto_reframe follows the face: ${rp.map((q) => `${q.at}s x${q.x}`).join(', ')}`);
    await tool('open_project', { projectId: firstId });
  } else console.log('skip - auto reframe (no face model in models/face/)');
  // Long video to shorts: speech four times with pauses over three shots, then find_moments + make_short.
  const longV = path.join(data, 'talk.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=10:r=25', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=10:r=25', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=10:r=25',
    '-i', path.join(fx, 'speech.mp3'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-filter_complex',
    '[0][1][2]concat=n=3:v=1:a=0[v];[3:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=4[s0][s1][s2][s3];[4:a]asplit=3[n0][n1][n2];[n0]atrim=duration=1.5[p0];[n1]atrim=duration=2[p1];[n2]atrim=duration=1[p2];[s0][p0][s1][p1][s2][p2][s3]concat=n=7:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', longV]);
  const lf = new FormData();
  lf.append('files', new Blob([fs.readFileSync(longV)]), 'talk.mp4');
  const talk = (await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: lf })).json()).added[0];
  const fm = await tool('find_moments', { assetId: talk.id, minDuration: 5, maxDuration: 14, count: 3 });
  ok(fm.moments?.length >= 1 && fm.moments.every((m) => m.duration >= 5 && m.duration <= 14.6) && /Candidate moments in "talk\.mp4"/.test(fm.content),
    `find_moments: ${fm.moments?.map((m) => `${m.in}-${m.out}`).join(', ')}${hasWhisper ? '' : ' (no whisper: shots + loudness)'}`);
  const openId = (await tool('get_timeline')).project.id;
  const ms = await tool('make_short', { assetId: talk.id, in: fm.moments[0].in, out: fm.moments[0].out, title: 'Best bit', open: false });
  const shortP = (await tool('list_projects')).content;
  ok((await tool('get_timeline')).project.id === openId && shortP.includes(ms.projectId) && /9:16 short, fit cover/.test(ms.content), `make_short (not opened): ${ms.content.split('.')[0]}`);
  await tool('open_project', { projectId: ms.projectId });
  s = await tool('get_timeline');
  ok(s.project.clips.length === 1 && s.project.texts[0]?.text === 'Best bit' && (!hasWhisper || s.project.captions?.lines?.length > 0), 'short has the clip, the title and captions');
  await tool('open_project', { projectId: firstId });

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
  const { prompts } = await mcp.listPrompts();
  const pr = await mcp.getPrompt({ name: 'reel_from_template', arguments: { template: 'Smoke template' } });
  const sp = await mcp.getPrompt({ name: 'shorts_from_video', arguments: { count: '2', length: '20-40' } });
  ok(prompts.map((x) => x.name).join() === 'make_reel,reel_from_template,save_my_style,reframe_to_vertical,shorts_from_video' && /create_from_template/.test(pr.messages[0].content.text) &&
    /minDuration 20, maxDuration 40, count 8/.test(sp.messages[0].content.text), 'MCP prompts');

  console.log(`\nAll good. Output: ${outPath}\nTimeline frames: ${framesDir}`);
} finally {
  await mcp?.close().catch(() => {});
  srv.kill();
  mockEl.server.close();
}
