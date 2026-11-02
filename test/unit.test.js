// Unit tests for the pure parts (no ffmpeg needed). Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.VIDEOGEN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'videogen-unit-'));
const M = await import('../src/model.js');
const { buildAss, assColor, assText, assTime } = await import('../src/ass.js');
const { mergeTokens, transcriptText } = await import('../src/transcribe.js');
const store = await import('../src/store.js');
const { buildCommand, motionFilter } = await import('../src/render.js');

function project() {
  const p = M.emptyProject();
  p.assets = {
    vid_a: { id: 'vid_a', name: 'a.mp4', type: 'video', file: 'a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true },
    vid_b: { id: 'vid_b', name: 'b.mp4', type: 'video', file: 'b.mp4', duration: 6, width: 1080, height: 1920, hasAudio: true },
    img_c: { id: 'img_c', name: 'c.png', type: 'image', file: 'c.png', width: 500, height: 500 },
    aud_m: { id: 'aud_m', name: 'm.mp3', type: 'audio', file: 'm.mp3', duration: 30, hasAudio: true },
  };
  return p;
}
const run = (p, name, input) => M.ops[name](p, input);

test('migrate fills new fields on a v1 project', () => {
  const old = { name: 'x', settings: { aspect: '9:16', width: 1080, height: 1920, fps: 30, background: '#000000' }, assets: {}, clips: [], texts: [], music: [{ id: 'music_1', assetId: 'a', start: 0, in: 0, out: 1, volume: 1, fadeIn: 0, fadeOut: 0 }] };
  const p = M.migrate(old);
  assert.equal(p.version, 2);
  assert.ok(p.id.startsWith('proj_'));
  assert.deepEqual(p.overlays, []);
  assert.equal(p.captions, null);
  assert.equal(p.music[0].role, 'music');
  assert.equal(p.music[0].track, 1);
});

test('colors are validated and normalised (no filtergraph injection)', () => {
  assert.equal(M.color('#FFF'), '#ffffff');
  assert.equal(M.color('ffde00'), '#ffde00');
  assert.throws(() => M.color("#fff:drawtext=text='x'"), /hex color/);
  const p = project();
  assert.throws(() => run(p, 'set_canvas', { background: 'red;[0:v]' }), /hex color/);
  assert.throws(() => run(p, 'add_text', { text: 'hi', start: 0, end: 1, color: 'white' }), /hex color/);
});

test('set_clip transform, motion and validation', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a' });
  const id = p.clips[0].id;
  run(p, 'set_clip', { clipId: id, crop: { x: 0.25, w: 0.5 }, rotate: -90, flipH: true, scale: 1.2, y: 0.4, motion: 'zoom_in' });
  const c = p.clips[0];
  assert.deepEqual(c.transform, { crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, rotate: 270, flipH: true, scale: 1.2, y: 0.4 });
  assert.deepEqual(c.motion, { preset: 'zoom_in', intensity: 0.15 });
  assert.throws(() => run(p, 'set_clip', { clipId: id, crop: { x: 0.8, w: 0.5 } }), /inside the frame/);
  assert.throws(() => run(p, 'set_clip', { clipId: id, motion: 'spin' }), /motion must be one of/);
  run(p, 'set_clip', { clipId: id, resetTransform: true, motion: 'none' });
  assert.equal(c.transform, undefined);
  assert.equal(c.motion, undefined);
  // Summary mentions transforms so Claude sees them.
  run(p, 'set_clip', { clipId: id, flipV: true, motion: 'pan_left', motionIntensity: 0.3 });
  assert.match(M.summarize(p), /flipV, motion pan_left 0.3/);
});

test('overlays: timing, defaults, source length check', () => {
  const p = project();
  run(p, 'add_overlay', { assetId: 'img_c', start: 2, duration: 4, x: 0.8, y: 0.15, scale: 0.2 });
  const o = p.overlays[0];
  assert.equal(o.start, 2); assert.equal(o.out - o.in, 4); assert.equal(o.fit, 'free'); assert.equal(o.volume, 0);
  run(p, 'add_overlay', { assetId: 'vid_b', start: 1, end: 3, in: 1, fit: 'cover', track: 2 });
  const v = p.overlays[1];
  assert.equal(v.in, 1); assert.equal(v.out, 3); assert.equal(v.volume, 1);
  assert.throws(() => run(p, 'add_overlay', { assetId: 'vid_b', in: 5, duration: 4 }), /needs? .*source|would need/);
  run(p, 'set_overlay', { overlayId: o.id, opacity: 0.5, end: 10 });
  assert.equal(M.overlayDuration(o), 8);
  assert.throws(() => run(p, 'add_overlay', { assetId: 'aud_m' }), /expected video\/image/);
  run(p, 'delete_overlay', { overlayId: o.id });
  assert.equal(p.overlays.length, 1);
});

test('text style presets apply, explicit values win, fonts are resolved', () => {
  const p = project();
  M.env.resolveFont = (f) => (f.toLowerCase() === 'impact' ? 'Impact' : null);
  try {
    run(p, 'add_text', { text: 'Hi', start: 0, end: 2, style: 'highlight', color: '#ff0000', font: 'impact', animationOut: 'fade' });
    const t = p.texts[0];
    assert.equal(t.color, '#ff0000');       // explicit wins
    assert.equal(t.outline, 7);             // from preset
    assert.equal(t.animation, 'pop');       // from preset
    assert.equal(t.font, 'Impact');         // canonical family name
    assert.equal(t.animationOut, 'fade');
    assert.throws(() => run(p, 'update_text', { textId: t.id, font: 'Comic Nope' }), /Unknown font/);
    assert.throws(() => run(p, 'update_text', { textId: t.id, style: 'nope' }), /style must be one of/);
  } finally { M.env.resolveFont = null; }
});

test('audio roles and default tracks', () => {
  const p = project();
  run(p, 'add_music', { assetId: 'aud_m' });
  run(p, 'add_music', { assetId: 'aud_m', role: 'sfx', start: 2, out: 0.5 });
  run(p, 'add_music', { assetId: 'vid_a', role: 'voice' });
  assert.deepEqual(p.music.map((m) => [m.role, m.track, m.volume, m.fadeOut]), [['music', 1, 0.6, 1], ['sfx', 3, 1, 0], ['voice', 2, 1, 0]]);
  assert.match(p.music[1].id, /^sfx_/);
});

test('timelineWords maps source words through in/out, speed and transitions', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', in: 2, out: 6 });          // timeline 0-4
  run(p, 'add_clip', { assetId: 'vid_b', in: 0, out: 4 });          // speed 2 -> 2s
  run(p, 'set_clip', { clipId: p.clips[1].id, speed: 2 });
  run(p, 'set_transition', { clipId: p.clips[1].id, type: 'fade', duration: 0.5 }); // starts at 3.5
  const tr = {
    vid_a: [{ w: 'before', start: 1, end: 1.5 }, { w: 'hello', start: 2.5, end: 3 }, { w: 'there', start: 5.5, end: 5.9 }],
    vid_b: [{ w: 'fast', start: 1, end: 2 }],
  };
  const ws = M.timelineWords(p, tr);
  assert.deepEqual(ws.map((w) => w.w), ['hello', 'there', 'fast']);
  assert.deepEqual(ws[0], { w: 'hello', start: 0.5, end: 1 });
  assert.deepEqual(ws[2], { w: 'fast', start: 4, end: 4.5 }); // 3.5 + 1/2
  // Muted clips are not captioned.
  run(p, 'set_clip', { clipId: p.clips[0].id, volume: 0 });
  assert.deepEqual(M.timelineWords(p, tr).map((w) => w.w), ['fast']);
});

test('groupWords breaks on sentence end, max words and pauses', () => {
  const w = (s, t) => ({ w: s, start: t, end: t + 0.3 });
  const lines = M.groupWords([w('one', 0), w('two.', 0.4), w('three', 0.8), w('four', 1.2), w('five', 1.6), w('six', 3)], { maxWords: 2 });
  assert.deepEqual(lines.map((l) => l.words.map((x) => x.w).join(' ')), ['one two.', 'three four', 'five', 'six']);
  assert.ok(lines[0].end <= lines[1].start);
});

test('captions: set, edit a line, regroup, delete', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a' });
  const words = 'we are making a short video with captions today'.split(' ').map((x, i) => ({ w: x, start: i * 0.4, end: i * 0.4 + 0.35 }));
  run(p, 'set_captions', { words, preset: 'karaoke' });
  assert.equal(p.captions.style.mode, 'karaoke');
  assert.equal(p.captions.lines.length, 2); // maxWords 5
  const l = p.captions.lines[0];
  run(p, 'update_captions', { lineId: l.id, text: 'We are making a SHORT' });
  assert.equal(l.words[4].w, 'SHORT');
  assert.equal(l.words.length, 5);
  run(p, 'update_captions', { maxWords: 3, mode: 'word', highlightColor: '#00ff00' });
  assert.equal(p.captions.lines.length, 3);
  assert.equal(p.captions.style.highlightColor, '#00ff00');
  assert.throws(() => run(p, 'update_captions', { mode: 'wave' }), /mode must be one of/);
  run(p, 'delete_captions', {});
  assert.equal(p.captions, null);
  assert.throws(() => run(p, 'set_captions', { words: [] }), /No words/);
});

test('ASS output: colors, escaping, animations, caption modes', () => {
  assert.equal(assColor('#ff8000'), '&H0080FF&');
  assert.equal(assTime(3725.456), '1:02:05.46');
  assert.equal(assText('a{b}\\c\\nd'), 'a｛b｝∖c\\Nd');
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a' });
  run(p, 'add_text', { text: 'Slide', start: 0, end: 3, animation: 'slideup', animationOut: 'slidedown' });
  run(p, 'add_text', { text: 'Box', start: 1, end: 2, style: 'boxed' });
  run(p, 'add_text', { text: 'Type', start: 0, end: 2, animation: 'typewriter' });
  const words = ['hello', 'world'].map((x, i) => ({ w: x, start: i * 0.5, end: i * 0.5 + 0.4 }));
  run(p, 'set_captions', { words, preset: 'karaoke' });
  let { ass, families } = buildAss(p, { defaultFont: 'Arial' });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /\\move\(540,1040,540,960,0,350\)/);       // slide up into place
  assert.match(ass, /\\move\(540,960,540,1040,0,300\)/);       // slide down out (second event)
  assert.match(ass, /Dialogue: 1,[^\n]*,Box,[^\n]*Box$/m);     // box style
  assert.match(ass, /\{\\ko\d+\}T\{\\ko\d+\}y/);                 // typewriter
  assert.match(ass, /\\kf40\}hello \{\\k10\}\{\\kf40\}world/);   // karaoke timing
  assert.deepEqual(families, ['Arial']);
  run(p, 'update_captions', { mode: 'single', uppercase: true });
  ({ ass } = buildAss(p, { defaultFont: 'Arial' }));
  assert.match(ass, /\}HELLO$/m);
  assert.match(ass, /\}WORLD$/m);
  // Nothing to draw -> null
  assert.equal(buildAss(project(), {}), null);
});

test('whisper token merging and transcript text', () => {
  const ws = mergeTokens([
    { text: 'Welcome', start: 0.1, end: 0.7 }, { text: '[BLANK_AUDIO]', start: 0.7, end: 1 },
    { text: 'it', start: 1, end: 1.2 }, { text: "'s", start: 1.2, end: 1.3 }, { text: 'here.', start: 1.3, end: 1.8 },
  ]);
  assert.deepEqual(ws.map((w) => w.w), ['Welcome', "it's", 'here.']);
  assert.equal(transcriptText(ws), '[0.10-1.80] Welcome it\'s here.');
});

test('store: batch_edit is atomic, one undo step, resolves $N ids', () => {
  const p0 = store.getProject();
  Object.assign(p0.assets, project().assets);
  const before = store.getProject().clips.length;
  const msg = store.applyBatch([
    { name: 'add_clip', input: { assetId: 'vid_a', out: 3 } },
    { name: 'add_clip', input: { assetId: 'vid_b', out: 3 } },
    { name: 'set_transition', input: { clipId: '$2', type: 'fade' } },
    { name: 'add_overlay', input: { assetId: 'img_c', start: 1, duration: 1 } },
    { name: 'set_overlay', input: { overlayId: '$4', opacity: 0.5 } },
  ]);
  assert.match(msg, /^1\. Added clip_/);
  const p = store.getProject();
  assert.equal(p.clips.length, before + 2);
  assert.equal(p.clips[1].transition.type, 'fade');
  assert.equal(p.overlays[0].opacity, 0.5);
  store.undo();
  assert.equal(store.getProject().clips.length, before);
  // Failing step -> nothing applied
  assert.throws(() => store.applyBatch([{ name: 'add_clip', input: { assetId: 'vid_a' } }, { name: 'trim_clip', input: { clipId: 'nope' } }]), /Step 2 \(trim_clip\) failed.*No changes/);
  assert.equal(store.getProject().clips.length, before);
  assert.throws(() => store.applyBatch([{ name: 'export_video' }]), /not an editing operation/);
  assert.throws(() => store.applyBatch([{ name: 'set_clip', input: { clipId: '$1' } }]), /does not refer/);
});

test('store: projects create/open/duplicate/delete with separate undo history', () => {
  const first = store.getProject().id;
  store.apply('rename_project', { name: 'First' });
  const second = store.createProject({ name: 'Second', aspect: '16:9' });
  assert.equal(store.getProject().id, second.id);
  assert.equal(second.settings.width, 1920);
  assert.ok(Object.keys(second.assets).length > 0, 'media library copied');
  assert.equal(store.undo(), 'Nothing to undo'); // history is per project
  store.openProject('First');
  assert.equal(store.getProject().id, first);
  assert.equal(store.undo(), 'Undid last change'); // undo the rename
  const dup = store.duplicateProject(second.id, 'Second v2');
  assert.equal(store.getProject().name, 'Second v2');
  assert.throws(() => store.deleteProject(dup.id), /Cannot delete the open project/);
  store.openProject(first);
  store.deleteProject(dup.id);
  assert.ok(!store.listProjects().some((x) => x.id === dup.id));
  assert.equal(store.listProjects().filter((x) => x.current).length, 1);
  assert.throws(() => store.openProject('missing'), /No project "missing"/);
});

test('render graph: overlays, transforms, motion, ASS, frames mode', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', out: 4 });
  run(p, 'add_clip', { assetId: 'img_c', duration: 3 });
  run(p, 'set_clip', { clipId: p.clips[0].id, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, rotate: 90, scale: 0.8, x: 0.4 });
  run(p, 'set_clip', { clipId: p.clips[1].id, motion: 'zoom_in' });
  run(p, 'add_overlay', { assetId: 'vid_b', start: 1, duration: 2, scale: 0.3, x: 0.75, y: 0.25, opacity: 0.8, animation: 'fade', rotate: 10 });
  run(p, 'add_text', { text: 'Title', start: 0, end: 2 });
  const { graph, args, tmpDir } = buildCommand(p, 'out.mp4', { quality: 'draft' });
  try {
    assert.match(graph, /crop=w=iw\*0\.8:h=ih\*0\.8:x=iw\*0\.1:y=ih\*0\.1,transpose=1/);
    assert.match(graph, /\[cb0\]\[fs0\]overlay=x=/);
    assert.match(graph, /zoompan=z='1\+0\.15\*/);
    assert.match(graph, /colorchannelmixer=aa=0\.8/);
    assert.match(graph, /setpts=PTS\+1\.000\/TB\[ov0\]/);
    assert.match(graph, /overlay=x=405\.000-overlay_w\/2:y=240\.000-overlay_h\/2:eof_action=pass:enable='between\(t,1\.000,3\.000\)'/);
    assert.match(graph, /\[oa0\]/);                       // overlay audio mixed in
    assert.match(graph, /ass=filename=.*text\.ass.*fontsdir=/);
    assert.ok(fs.existsSync(path.join(tmpDir, 'text.ass')));
    assert.ok(args.includes('libx264'));
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  const fr = buildCommand(p, 'f%03d.jpg', { quality: 'draft', frames: [0.5, 2] });
  try {
    assert.match(fr.graph, /select='between\(t,0\.483,0\.517\)\+between\(t,1\.983,2\.017\)'/);
    assert.match(fr.graph, /anullsink/);
    assert.ok(fr.args.includes('mjpeg'));
  } finally { fs.rmSync(fr.tmpDir, { recursive: true, force: true }); }
  assert.equal(motionFilter({ preset: 'none' }, 540, 960, 30, 2), null);
});
