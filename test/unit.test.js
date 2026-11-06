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

test('remove_region: validation, defaults, split keeps it, delete, summary', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', in: 2, out: 8 });
  const id = p.clips[0].id;
  run(p, 'remove_region', { clipId: id, x: 0.1, y: 0.85, w: 0.5, h: 0.06 });
  const r = p.clips[0].regions[0];
  assert.deepEqual([r.mode, r.from, r.to], ['fill', 2, 8]); // defaults to the clip's source range
  assert.throws(() => run(p, 'remove_region', { clipId: id, x: 0.6, y: 0.1, w: 0.5, h: 0.1 }), /inside the frame/);
  assert.throws(() => run(p, 'remove_region', { clipId: id, y: 0.1, w: 0.5, h: 0.1 }), /x is required/);
  assert.throws(() => run(p, 'remove_region', { clipId: id, x: 0, y: 0, w: 0.1, h: 0.1, from: 5, to: 4 }), /to must be after from/);
  assert.throws(() => run(p, 'remove_region', { clipId: id, x: 0, y: 0, w: 0.1, h: 0.1, mode: 'patch', from: 4, to: 5 }), /needs patchAt/);
  assert.throws(() => run(p, 'remove_region', { clipId: id, x: 0, y: 0, w: 0.1, h: 0.1, mode: 'patch', from: 4, to: 5, patchAt: 4.5 }), /copy the text itself/);
  run(p, 'remove_region', { clipId: id, x: 0.2, y: 0.8, w: 0.4, h: 0.07, mode: 'patch', from: 4, to: 5, patchAt: 5.1 });
  assert.equal(p.clips[0].regions[1].feather, 0.15);
  assert.match(M.summarize(p), /removed regions: reg_\w+ fill x0\.1 y0\.85 w0\.5 h0\.06 source 2\.00-8\.00s; reg_\w+ patch .* from frame 5\.10s/);
  // Split: both halves keep the (source-relative) regions; delete removes them everywhere.
  run(p, 'split_clip', { at: 3 });
  assert.equal(p.clips[1].regions.length, 2);
  const msg = run(p, 'delete_region', { regionId: r.id });
  assert.match(msg, /from 2 clips/);
  assert.equal(p.clips[0].regions.length, 1);
  assert.throws(() => run(p, 'delete_region', { regionId: 'reg_nope' }), /No region reg_nope/);
  assert.throws(() => run(p, 'remove_region', { clipId: id, x: 0, y: 0, w: 0.1, h: 0.1, mode: 'blur' }), /mode must be one of/);
});

test('replace_clip_asset keeps clip settings and checks length', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_b', out: 4 });
  run(p, 'add_clip', { assetId: 'vid_a', in: 1, out: 5 });
  const c = p.clips[1];
  run(p, 'set_clip', { clipId: c.id, speed: 2, volume: 0.5, fit: 'blur', flipH: true, motion: 'zoom_in' });
  run(p, 'set_transition', { clipId: c.id, type: 'fade', duration: 0.4 });
  run(p, 'remove_region', { clipId: c.id, x: 0.1, y: 0.8, w: 0.3, h: 0.05, mode: 'patch', from: 2, to: 3, patchAt: 3.5 });
  const before = structuredClone(c);
  run(p, 'replace_clip_asset', { clipId: c.id, assetId: 'vid_b' });
  assert.equal(c.assetId, 'vid_b');
  for (const k of ['id', 'in', 'out', 'speed', 'volume', 'fit', 'transform', 'motion', 'transition', 'regions']) assert.deepEqual(c[k], before[k], k);
  assert.equal(p.clips.indexOf(c), 1);
  // vid_b is 6s: out 8 does not fit
  run(p, 'trim_clip', { clipId: c.id, out: 5.5 });
  run(p, 'replace_clip_asset', { clipId: p.clips[0].id, assetId: 'vid_a', in: 6, out: 9 });
  assert.throws(() => run(p, 'replace_clip_asset', { clipId: p.clips[0].id, assetId: 'vid_b' }), /only 6\.00s long/);
  assert.throws(() => run(p, 'replace_clip_asset', { clipId: c.id, assetId: 'aud_m' }), /expected video\/image/);
  // Image: patch regions are dropped (no frames to copy from); clearRegions drops all.
  run(p, 'replace_clip_asset', { clipId: c.id, assetId: 'img_c' });
  assert.equal(c.regions, undefined);
  run(p, 'replace_clip_asset', { clipId: c.id, assetId: 'vid_a', clearRegions: true });
  assert.equal(c.regions, undefined);
});

test('set_color: adjustments, looks, validation, summary', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a' });
  const id = p.clips[0].id;
  run(p, 'set_color', { clipId: id, brightness: 0.1, saturation: 1.3, filter: 'vintage', filterIntensity: 0.5 });
  assert.deepEqual(p.clips[0].color, { brightness: 0.1, saturation: 1.3, filter: 'vintage', filterIntensity: 0.5 });
  run(p, 'set_color', { clipId: id, saturation: 1, filterIntensity: 1 }); // defaults are dropped
  assert.deepEqual(p.clips[0].color, { brightness: 0.1, filter: 'vintage' });
  assert.match(M.summarize(p), /color: brightness 0\.1 filter vintage/);
  assert.throws(() => run(p, 'set_color', { clipId: id, filter: 'lomo' }), /filter must be one of/);
  assert.throws(() => run(p, 'set_color', { clipId: id, contrast: 5 }), /contrast must be a number between 0 and 3/);
  run(p, 'set_color', { clipId: id, reset: true, filter: 'none' });
  assert.equal(p.clips[0].color, undefined);
  assert.throws(() => run(p, 'set_color', { clipId: id, filterIntensity: 0.5 }), /Set filter/);
  run(p, 'add_overlay', { assetId: 'img_c', start: 1, duration: 2 });
  run(p, 'set_color', { overlayId: p.overlays[0].id, filter: 'bw' });
  assert.equal(p.overlays[0].color.filter, 'bw');
  assert.throws(() => run(p, 'set_color', { brightness: 0.1 }), /Give clipId or overlayId/);
});

test('effects, keyframes and clip animations: timeline in, clip-local stored, split divides them', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_b', out: 4 });           // timeline 0-4
  run(p, 'add_clip', { assetId: 'vid_a', in: 0, out: 6 });    // timeline 4-10
  const id = p.clips[1].id;
  run(p, 'add_effect', { clipId: id, type: 'shake', start: 5, end: 7, intensity: 0.8 });
  run(p, 'add_effect', { clipId: id, type: 'zoom_pulse' });
  assert.deepEqual(p.clips[1].effects.map((e) => [e.type, e.from, e.to, e.rate]), [['shake', 1, 3, 8], ['zoom_pulse', 0, 6, 2]]);
  assert.throws(() => run(p, 'add_effect', { clipId: id, type: 'shake', start: 0, end: 3 }), /must overlap the clip/);
  assert.throws(() => run(p, 'add_effect', { clipId: id, type: 'wobble' }), /type must be one of/);
  run(p, 'set_keyframes', { clipId: id, property: 'scale', keyframes: [{ t: 8, value: 1.4 }, { t: 4, value: 1 }] });
  assert.deepEqual(p.clips[1].keyframes.scale, { easing: 'ease', points: [{ t: 0, v: 1 }, { t: 4, v: 1.4 }] });
  assert.equal(M.kfAt(p.clips[1].keyframes.scale, 2), 1.2);
  assert.throws(() => run(p, 'set_keyframes', { clipId: id, property: 'opacity', keyframes: [{ t: 5, value: 1 }] }), /property must be one of: scale, x, y, volume/);
  assert.throws(() => run(p, 'set_keyframes', { clipId: id, property: 'scale', keyframes: [{ t: 11, value: 1 }] }), /keyframes\[0\]\.t must be/);
  assert.throws(() => run(p, 'set_keyframes', { clipId: id, property: 'volume', keyframes: [{ t: 5, value: 3 }] }), /value must be a number between 0 and 2/);
  run(p, 'set_clip', { clipId: id, animIn: 'slide_left', animOut: 'zoom_out', animOutDuration: 0.8 });
  assert.deepEqual([p.clips[1].animIn, p.clips[1].animOut], [{ type: 'slide_left', duration: 0.5 }, { type: 'zoom_out', duration: 0.8 }]);
  assert.match(M.summarize(p), /anim in slide_left 0\.5s, anim out zoom_out 0\.8s, effects: fx_\w+ shake 5\.00-7\.00s intensity 0\.8 rate 8\/s; fx_\w+ zoom_pulse 4\.00-10\.00s.*keyframes: scale 4\.00s=1 8\.00s=1\.4/);
  // Split at timeline 6 (clip-local 2): effects, keyframes and animations are divided.
  run(p, 'split_clip', { at: 6 });
  const [a, b] = [p.clips[1], p.clips[2]];
  assert.deepEqual(a.effects.map((e) => [e.type, e.from, e.to]), [['shake', 1, 2], ['zoom_pulse', 0, 2]]);
  assert.deepEqual(b.effects.map((e) => [e.type, e.from, e.to]), [['shake', 0, 1], ['zoom_pulse', 0, 4]]);
  assert.deepEqual(a.keyframes.scale.points, [{ t: 0, v: 1 }, { t: 2, v: 1.2 }]);
  assert.deepEqual(b.keyframes.scale.points, [{ t: 0, v: 1.2 }, { t: 2, v: 1.4 }]);
  assert.ok(a.animIn && !a.animOut && !b.animIn && b.animOut);
  // delete_effect removes it from both halves; [] removes keyframes.
  run(p, 'delete_effect', { effectId: a.effects[0].id });
  assert.deepEqual([a.effects.length, b.effects.length], [1, 1]);
  run(p, 'set_keyframes', { clipId: a.id, property: 'scale', keyframes: [] });
  assert.equal(a.keyframes, undefined);
  // Overlay keyframes and the fit note.
  run(p, 'add_overlay', { assetId: 'img_c', start: 1, duration: 4, fit: 'cover' });
  assert.match(run(p, 'set_keyframes', { overlayId: p.overlays[0].id, property: 'x', keyframes: [{ t: 1, value: 0.2 }, { t: 5, value: 0.8 }] }), /only applies with fit free/);
});

test('markers, mark-free beat cutting and ducking', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', out: 3 });
  run(p, 'add_clip', { assetId: 'img_c', duration: 3 });
  run(p, 'add_clip', { assetId: 'vid_b', in: 5.8, out: 6 });   // only 0.2s of source left: too short to reach a beat
  run(p, 'add_clip', { assetId: 'vid_a', in: 5, out: 9 });
  run(p, 'set_transition', { clipId: p.clips[1].id, type: 'fade', duration: 0.2 });
  assert.throws(() => run(p, 'fit_clips_to_beats', {}), /Need beat markers/);
  const beats = Array.from({ length: 20 }, (_, k) => 0.5 + k * 0.5); // 120 BPM from 0.5s
  run(p, 'add_markers', { times: beats, kind: 'beat' });
  run(p, 'add_markers', { times: [3], label: 'drop' });
  assert.equal(p.markers.length, 21);
  assert.match(M.summarize(p), /20 beat markers: 0\.50, 1\.00.*\n- 1 note markers: 3\.00 "drop"/);
  const msg = run(p, 'fit_clips_to_beats', { every: 2 });
  assert.match(msg, /Cut 3 of 4 clips on the beat \(every 2 beats\).*#3 kept: its source is too short/);
  const L = M.layout(p);
  // Every other beat: 0.5, 1.5, 2.5... Clip 2 starts on 0.5 even with its 0.2s fade (clip 1 runs on under the
  // transition), clip 3 is kept (0.2s), clip 4 snaps its end to the next grid beat.
  assert.deepEqual(L.clips.map((c) => [c.start, c.end]), [[0, 0.7], [0.5, 1.5], [1.5, 1.7], [1.7, 2.5]]);
  run(p, 'delete_markers', { kind: 'beat' });
  assert.equal(p.markers.length, 1);
  run(p, 'add_music', { assetId: 'aud_m', duck: 0.6 });
  assert.equal(p.music[0].duck, 0.6);
  assert.match(M.summarize(p), /ducks under speech \(amount 0\.6\)/);
  run(p, 'update_music', { musicId: p.music[0].id, duck: 0 });
  assert.equal(p.music[0].duck, undefined);
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

test('render graph: color, clip placement/animations, effects, overlay keyframes, ducking, export options', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', out: 4 });
  run(p, 'add_clip', { assetId: 'vid_b', out: 4 });
  const [c1, c2] = p.clips.map((c) => c.id);
  run(p, 'set_transition', { clipId: c2, type: 'fade', duration: 0.5 });
  run(p, 'set_color', { clipId: c1, contrast: 1.2, temperature: 0.5, filter: 'vintage', filterIntensity: 0.4 });
  run(p, 'set_clip', { clipId: c1, animIn: 'slide_up', animOut: 'fade' });
  run(p, 'add_effect', { clipId: c1, type: 'zoom_pulse', start: 1, end: 2, rate: 2 });
  run(p, 'add_effect', { clipId: c1, type: 'invert', start: 3, end: 3.5 });
  run(p, 'set_keyframes', { clipId: c2, property: 'volume', keyframes: [{ t: 3.5, value: 0 }, { t: 5, value: 1 }], easing: 'linear' });
  run(p, 'add_overlay', { assetId: 'img_c', start: 1, duration: 3, scale: 0.3, rotate: 10 });
  const ov = p.overlays[0].id;
  run(p, 'set_keyframes', { overlayId: ov, property: 'scale', keyframes: [{ t: 1, value: 0.2 }, { t: 4, value: 0.4 }] });
  run(p, 'set_keyframes', { overlayId: ov, property: 'opacity', keyframes: [{ t: 1, value: 0 }, { t: 2, value: 1 }] });
  run(p, 'set_keyframes', { overlayId: ov, property: 'x', keyframes: [{ t: 1, value: 0.2 }, { t: 4, value: 0.8 }], easing: 'linear' });
  run(p, 'add_music', { assetId: 'aud_m', duck: 0.5 });
  run(p, 'add_music', { assetId: 'aud_m', role: 'voice', start: 1, out: 2 });
  const { graph, args, tmpDir, encoder, width, height, fps } = buildCommand(p, 'out.mp4', { resolution: '720p', fps: 25, bitrate: 6 });
  try {
    assert.deepEqual([width, height, fps, encoder], [720, 1280, 25, 'libx264']);
    assert.ok(args.join(' ').includes('-c:v libx264 -preset medium -b:v 6M -maxrate 9M -bufsize 12M'));
    // Color: adjust, then the look blended 40% over the original.
    assert.match(graph, /\[h0\]eq=brightness=0\.000:contrast=1\.200:saturation=1\.000,colorbalance=rs=0\.075/);
    assert.match(graph, /\[cc0bl\]\[cc0bo\]blend=all_mode=normal:all_opacity=0\.400\[cc0b\]/);
    assert.match(graph, /\[cc0b\]scale=720:1280/);
    // slide_up: Y expression is wrapped so the offset is multiplied by the canvas height.
    assert.match(graph, /overlay=x='720\*\(0\.5\)-w\/2':y='1280\*\(0\.5\+\(1-/);
    // Fade + effects after the tail, back to AVTB for xfade.
    assert.match(graph, /settb=AVTB,fade=t=out:st=3\.500:d=0\.500:color=0x000000@1\[vt0\]/);
    assert.match(graph, /zoompan=z='1\+0\.090\*between\(it,1\.000,2\.000\)/);
    assert.match(graph, /negate=enable='between\(t,3\.000,3\.500\)'/);
    assert.match(graph, /\[fx0_1\]settb=AVTB\[v0\]/);
    assert.match(graph, /volume='if\(lt\(t,0\),0,if\(lt\(t,1\.5\),0\+\(1\)\*clip\(\(t-0\)\/1\.5,0,1\),1\)\)':eval=frame/);
    // Overlay: opacity (geq) before rotate before the per-frame scale; x keyframes in overlay-local time.
    assert.match(graph, /geq=lum=.*a='alpha\(X,Y\)\*\(if\(lt\(T,0\),0,.*rotate=a='10\*PI\/180':ow=\d+:oh=\d+:c=none,scale=w='max\(2,trunc\(720\*\(if/);
    assert.match(graph, /overlay=x='720\*\(if\(lt\(\(t-1\.000\),0\),0\.2,/);
    // Ducking: clip audio + voice tapped into a sidechain key.
    assert.match(graph, /\[aj1\]asplit=2\[aj1s\]\[aj1k\]/);
    assert.match(graph, /\[aj1k\]\[m1k\]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=7\.500\[dk0\]/);
    assert.match(graph, /\[m0\]\[dk0\]sidechaincompress=threshold=0\.015:ratio=10\.500/);
    assert.match(graph, /\[aj1s\]\[md0\]\[m1s\]amix=inputs=3/);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('audio analysis finds tempo and beats of a click track', async () => {
  const { analyzeSamples } = await import('../src/audio.js');
  const rate = 22050, x = new Float32Array(rate * 12), per = 60 / 128;
  for (let b = 0.2; b < 12; b += per) { const s = Math.round(b * rate); for (let i = 0; i < 300 && s + i < x.length; i++) x[s + i] += Math.exp(-i / 50) * Math.sin(i) * 0.8; }
  for (let i = 0; i < x.length; i++) x[i] += Math.sin(i * 0.37) * Math.sin(i * 0.011) * 0.02; // quiet bed, like real audio
  const r = analyzeSamples(x, rate);
  assert.ok(Math.abs(r.bpm - 128) < 1.5, `bpm ${r.bpm}`);
  assert.ok(r.beats.length >= 22, `beats ${r.beats.length}`);
  for (const t of r.beats) assert.ok(Math.abs(((t - 0.2 + per / 2) % per) - per / 2) < 0.03, `beat ${t} off the grid`);
  assert.equal(r.silences.length, 0);
});

test('render graph: removed regions (fill = delogo, patch = clean-frame overlay)', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', in: 2, out: 8 });   // 1920x1080 source
  const id = p.clips[0].id;
  run(p, 'set_clip', { clipId: id, speed: 2 });
  run(p, 'remove_region', { clipId: id, x: 0.25, y: 0.9, w: 0.5, h: 0.05, from: 3, to: 4 });
  run(p, 'remove_region', { clipId: id, x: 0.1, y: 0.8, w: 0.2, h: 0.1, mode: 'patch', from: 5, to: 6, patchAt: 6.5 });
  run(p, 'remove_region', { clipId: id, x: 0, y: 0, w: 0.1, h: 0.1, from: 9, to: 10 }); // outside the clip: skipped
  const { graph, args, tmpDir } = buildCommand(p, 'out.mp4', { quality: 'draft' });
  try {
    // Times are relative to the clip's source in-point, applied before the speed change.
    assert.match(graph, /\[0:v\]setpts=PTS-STARTPTS\[rg0_0\]/);
    assert.match(graph, /\[rg0_0\]delogo=x=480:y=972:w=960:h=54:enable='between\(t,1\.000,2\.000\)'\[rg0_1\]/);
    assert.match(graph, /\[1:v\]trim=end_frame=1,setpts=PTS-STARTPTS,crop=384:108:192:864,format=rgba,geq=.*\/8\)'\[pt0_1\]/);
    assert.match(graph, /\[rg0_1\]\[pt0_1\]overlay=192:864:eof_action=repeat:enable='between\(t,3\.000,4\.000\)'\[rg0_2\]/);
    assert.match(graph, /\[rg0_2\]setpts=PTS\/2\[h0\]/);
    assert.ok(!/rg0_3/.test(graph));
    assert.deepEqual(args.slice(args.indexOf('6.500') - 1, args.indexOf('6.500') + 5), ['-ss', '6.500', '-t', '0.5', '-i', path.join(store.MEDIA_DIR, 'a.mp4')]);
    assert.match(graph, /\[0:a\]aformat/); // clip audio still from input 0
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  // Boxes touching the frame edge keep the 1px margin delogo needs.
  run(p, 'delete_region', { regionId: p.clips[0].regions[0].id });
  run(p, 'remove_region', { clipId: id, x: 0, y: 0.9, w: 1, h: 0.1 });
  const e = buildCommand(p, 'out.mp4', { quality: 'draft' });
  try { assert.match(e.graph, /delogo=x=1:y=972:w=1918:h=107:/); } finally { fs.rmSync(e.tmpDir, { recursive: true, force: true }); }
});

test('styles: normalize, capture from a project, apply, later edits follow, re-apply replaces intro/logo', () => {
  assert.throws(() => M.normalizeStyle({}), /name is required/);
  assert.throws(() => M.normalizeStyle({ name: 'x', clips: { transition: 'spin' } }), /clips.transition must be one of/);
  assert.throws(() => M.normalizeStyle({ name: 'x', title: { color: 'red' } }), /hex color/);
  assert.throws(() => M.normalizeStyle({ name: 'x', intro: { asset: { file: '../etc/passwd', type: 'video' }, clip: {} } }), /media library/);
  assert.equal(M.BUILTIN_STYLES.length, 3);

  // Build a source project with a look, then capture it.
  const src = project();
  run(src, 'add_clip', { assetId: 'img_c', duration: 2 }); // intro card
  run(src, 'add_clip', { assetId: 'vid_a', out: 4 });
  run(src, 'add_clip', { assetId: 'vid_b', out: 3 });
  const [intro, c1, c2] = src.clips.map((c) => c.id);
  run(src, 'set_clip', { clipId: c1, fit: 'blur', animIn: 'fade' });
  run(src, 'set_color', { clipId: c1, filter: 'vintage', filterIntensity: 0.5 });
  run(src, 'set_transition', { clipId: c2, type: 'wipeleft', duration: 0.4 });
  run(src, 'add_text', { text: 'Title', start: 0, end: 2, style: 'neon', size: 90, y: 0.2 });
  run(src, 'add_overlay', { assetId: 'img_c', x: 0.9, y: 0.06, scale: 0.12, opacity: 0.8 });
  run(src, 'add_music', { assetId: 'aud_m', volume: 0.3, duck: 0.7 });
  const raw = M.styleFromProject(src, { introClipId: intro, logoOverlayId: src.overlays[0].id });
  const st = { ...M.normalizeStyle({ ...raw, name: 'Mine', clips: { ...raw.clips, transitionDuration: 0.3 } }), id: 'style_t' };
  assert.equal(st.clips.fit, 'contain'); // first untagged clip is the intro card (not tagged yet)
  assert.deepEqual(st.clips.transition, { type: 'wipeleft', duration: 0.3 }); // explicit duration wins
  assert.equal(st.title.style, 'neon');
  assert.equal(st.title.size, 90);
  assert.deepEqual(st.music, { volume: 0.3, fadeIn: 0, fadeOut: 1, duck: 0.7 });
  assert.equal(st.intro.asset.file, 'c.png');
  assert.equal(st.logo.overlay.scale, 0.12);
  assert.match(M.describeStyle(st), /intro "c.png" 2.00s; logo "c.png"/);

  M.env.loadStyle = (id) => { if (id !== 'Mine' && id !== 'style_t') throw new Error('nope'); return st; };
  try {
    const p = project();
    delete p.assets.img_c; // the intro/logo asset is brought in by the style
    run(p, 'set_canvas', { aspect: '16:9' });
    run(p, 'add_clip', { assetId: 'vid_a', out: 3 });
    run(p, 'add_clip', { assetId: 'vid_b', out: 3 });
    run(p, 'add_text', { text: 'Old', start: 0, end: 1, x: 0.3, y: 0.7, box: true });
    run(p, 'add_music', { assetId: 'aud_m' });
    const msg = run(p, 'apply_style', { styleId: 'Mine' });
    assert.match(msg, /Applied style "Mine" to canvas, intro, 2 clip\(s\), 1 text\(s\), 1 music item\(s\), logo/);
    assert.equal(p.settings.aspect, '9:16');
    assert.equal(p.clips[0].styleRole, 'intro');
    assert.equal(p.assets[p.clips[0].assetId].file, 'c.png');
    assert.equal(p.clips[0].transition.type, 'none');
    assert.deepEqual(p.clips[2].transition, { type: 'wipeleft', duration: 0.3 });
    const t = p.texts[0];
    assert.equal(t.style, 'neon'); assert.equal(t.size, 90); assert.equal(t.box, false);
    assert.equal(t.x, 0.3); assert.equal(t.y, 0.7); // position kept
    assert.equal(p.music[0].volume, 0.3); assert.equal(p.music[0].duck, 0.7);
    const logo = p.overlays.find((o) => o.styleRole === 'logo');
    assert.equal(logo.out, M.layout(p).duration);
    // Later edits follow the style.
    run(p, 'add_text', { text: 'New', start: 1, end: 2 });
    assert.equal(p.texts[1].y, 0.2); assert.equal(p.texts[1].style, 'neon');
    run(p, 'add_text', { text: 'Own', start: 1, end: 2, style: 'boxed' });
    assert.equal(p.texts[2].size, 72); // explicit preset: the style's title is not used
    run(p, 'add_clip', { assetId: 'vid_a', in: 5, out: 7 });
    assert.deepEqual(p.clips.at(-1).transition, { type: 'wipeleft', duration: 0.3 });
    run(p, 'add_music', { assetId: 'aud_m', start: 2 });
    assert.equal(p.music[1].volume, 0.3);
    assert.match(M.summarize(p), /Style: "Mine" \(style_t\)/);
    assert.match(M.summarize(p), /\(style intro\)/);
    // Re-applying replaces intro and logo instead of adding more.
    run(p, 'apply_style', { styleId: 'Mine' });
    assert.equal(p.clips.filter((c) => c.styleRole === 'intro').length, 1);
    assert.equal(p.overlays.filter((o) => o.styleRole === 'logo').length, 1);
    // parts limits what is applied.
    run(p, 'set_canvas', { aspect: '1:1' });
    const m2 = run(p, 'apply_style', { styleId: 'Mine', parts: ['texts', 'outro'] });
    assert.equal(p.settings.aspect, '1:1');
    assert.match(m2, /style has no outro/);
    assert.throws(() => run(p, 'apply_style', { styleId: 'Mine', parts: ['bogus'] }), /parts\[\] must be one of/);
    // A style's caption look is used by the first captions.
    const q = project();
    const capStyle = { ...M.normalizeStyle({ name: 'Cap', captions: { preset: 'karaoke', size: 50 } }), id: 's2' };
    M.env.loadStyle = () => capStyle;
    run(q, 'apply_style', { styleId: 's2' });
    run(q, 'set_captions', { words: [{ w: 'yo', start: 0, end: 0.3 }] });
    assert.equal(q.captions.style.preset, 'karaoke'); assert.equal(q.captions.style.size, 50);
  } finally { M.env.loadStyle = null; }
});

test('templates: slots keep their edit, fill puts new media in, short media and validation', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', in: 1, out: 4 });
  run(p, 'add_clip', { assetId: 'img_c', duration: 2 });
  run(p, 'add_clip', { assetId: 'vid_b', out: 5 });
  const [a, b, c] = p.clips.map((x) => x.id);
  run(p, 'set_clip', { clipId: a, speed: 2 });
  run(p, 'set_transition', { clipId: b, type: 'fade', duration: 0.5 });
  run(p, 'add_effect', { clipId: c, type: 'flash' });
  run(p, 'remove_region', { clipId: c, x: 0, y: 0, w: 0.2, h: 0.2 });
  run(p, 'add_text', { text: 'Day one', start: 0, end: 2 });
  run(p, 'add_music', { assetId: 'aud_m' });
  run(p, 'add_markers', { times: [1, 2], kind: 'beat' });
  run(p, 'set_captions', { words: [{ w: 'hi', start: 0, end: 0.5 }] });
  assert.throws(() => M.makeTemplate(p, {}), /name is required/);
  assert.throws(() => M.makeTemplate(M.emptyProject(), { name: 'x' }), /no clips/);
  const tpl = M.makeTemplate(p, { name: 'Three shots' });
  assert.equal(tpl.slots.length, 3);
  assert.deepEqual(tpl.slots.map((s) => s.duration), [1.5, 2, 5]);
  assert.equal(tpl.clips[2].regions, undefined);
  assert.ok(tpl.clips.every((x) => x.assetId === null));
  assert.deepEqual(Object.keys(tpl.assets), ['aud_m']);
  assert.equal(tpl.style.captions.preset, 'classic'); // caption look carried over
  assert.match(M.describeTemplate(tpl), /3 slots, 8\.00s.*beat markers[\s\S]*slot 2: 2\.00s at 1\.00s \(was image "c.png"\)[\s\S]*text 1: "Day one"/);
  const noMusic = M.makeTemplate(p, { name: 'x', keepMusic: false, slotClipIds: [b] });
  assert.equal(noMusic.slots.length, 1); assert.equal(noMusic.music.length, 0); assert.ok(!noMusic.markers.some((m) => m.kind === 'beat'));

  // Fill into a fresh project with the same library.
  const q = M.emptyProject();
  q.assets = structuredClone(project().assets);
  delete q.assets.aud_m; // the template brings its own music asset
  const msg = M.fillTemplate(q, tpl, { slots: [{ assetId: 'vid_b', in: 1 }, { assetId: 'vid_a' }, { assetId: 'vid_b' }], texts: ['Day two'], name: 'Reel 2' });
  assert.match(msg, /Filled template "Three shots": 3 slots/);
  assert.equal(q.name, 'Reel 2');
  assert.deepEqual([q.clips[0].assetId, q.clips[0].in, q.clips[0].out, q.clips[0].speed], ['vid_b', 1, 4, 2]); // 1.5s at 2x
  assert.deepEqual([q.clips[1].assetId, q.clips[1].in, q.clips[1].out], ['vid_a', 0, 2]);
  assert.deepEqual([q.clips[2].in, q.clips[2].out], [0, 5]);
  const shifted = M.emptyProject(); shifted.assets = structuredClone(project().assets);
  M.fillTemplate(shifted, tpl, { slots: [{ assetId: 'vid_a' }, { assetId: 'vid_a' }, { assetId: 'vid_b', in: 4 }] });
  assert.deepEqual([shifted.clips[2].in, shifted.clips[2].out], [1, 6]); // in 4 + 5s would pass the 6s end: shifted earlier
  assert.equal(q.clips[1].transition.type, 'fade');
  assert.equal(q.clips[2].effects[0].type, 'flash');
  assert.ok(q.clips.every((x) => x.slot === undefined && x.slotDuration === undefined));
  assert.equal(q.texts[0].text, 'Day two');
  assert.equal(q.assets[q.music[0].assetId].file, 'm.mp3');
  assert.equal(q.captions, null);
  assert.equal(q.style.captions.preset, 'classic');
  // A source shorter than the slot gives a shorter clip and a note.
  const short = M.makeTemplate(p, { name: 'long', slotClipIds: [a] });
  short.clips[0].slotDuration = 9; short.clips[0].speed = 1;
  const s2 = M.emptyProject(); s2.assets = structuredClone(project().assets);
  assert.match(M.fillTemplate(s2, short, { assetIds: ['vid_b'] }), /slot 1 is 6\.00s instead of 9\.00s \("b.mp4" is too short\)/);
  // Auto-fill from the library, reusing media; validation.
  const r = M.emptyProject(); r.assets = { vid_b: project().assets.vid_b };
  M.fillTemplate(r, tpl);
  assert.ok(r.clips.every((x) => x.assetId === 'vid_b'));
  assert.throws(() => M.fillTemplate(M.emptyProject(), tpl), /No videos or photos/);
  assert.throws(() => M.fillTemplate(structuredClone(q), tpl, { assetIds: ['vid_a'] }), /has 3 slots but got 1/);
  assert.throws(() => M.fillTemplate(structuredClone(q), tpl, { assetIds: ['vid_a', 'nope', 'vid_a'] }), /Slot 2: nope is not a video or image/);
  assert.throws(() => M.fillTemplate(structuredClone(q), tpl, { assetIds: ['vid_a', 'vid_a', 'vid_a'], texts: ['a', 'b'] }), /only 1 text/);
});

test('presets storage: styles and templates on disk, built-ins protected, create_from_template is atomic', async () => {
  const P = await import('../src/presets.js');
  const { executeTool } = await import('../src/tools.js');
  assert.throws(() => P.saveStyle({ name: 'bold reel' }), /built-in/);
  const { style } = P.saveStyle({ name: 'Test look', clips: { fit: 'cover' } });
  assert.ok(fs.existsSync(path.join(P.STYLES_DIR, `${style.id}.json`)));
  const again = P.saveStyle({ name: 'TEST LOOK', clips: { fit: 'blur' } });
  assert.equal(again.updated, true); assert.equal(again.style.id, style.id);
  assert.equal(P.loadStyle('test look').clips.fit, 'blur');
  assert.equal(P.loadStyle('builtin_warm_vlog').name, 'Warm vlog');
  assert.throws(() => P.deleteStyle('Bold reel'), /built in/);
  assert.throws(() => P.loadStyle('nope'), /No style "nope"/);

  // Through the tools: apply a style, save a template, create from it.
  store.createProject({ name: 'Tpl source' });
  Object.assign(store.getProject().assets, project().assets);
  store.applyBatch([{ name: 'add_clip', input: { assetId: 'vid_a', out: 2 } }, { name: 'add_clip', input: { assetId: 'vid_b', out: 2 } }]);
  const ap = await executeTool('apply_style', { styleId: 'Warm vlog' });
  assert.match(ap.content, /Applied style "Warm vlog"/);
  assert.equal(store.getProject().clips[1].transition.type, 'fade');
  const sv = await executeTool('save_template', { name: 'Two cuts' });
  assert.match(sv.content, /Saved template tpl_\w+ "Two cuts": 2 slots/);
  const before = store.listProjects().length;
  const bad = await executeTool('create_from_template', { templateId: 'Two cuts', assetIds: ['vid_a'] });
  assert.ok(bad.isError); assert.equal(store.listProjects().length, before); // nothing created
  const ok = await executeTool('create_from_template', { templateId: 'two cuts', assetIds: ['vid_b', 'vid_a'], name: 'From tpl' });
  assert.match(ok.content, /Filled template "Two cuts".*Created and opened project proj_\w+ "From tpl"/);
  assert.equal(store.getProject().name, 'From tpl');
  assert.deepEqual(store.getProject().clips.map((c) => c.assetId), ['vid_b', 'vid_a']);
  assert.equal(store.getProject().style.name, 'Warm vlog');
  const ls = await executeTool('list_templates');
  assert.match(ls.content, /"Two cuts"[\s\S]*slot 1: 2\.00s/);
  const st = await executeTool('save_style', { name: 'Nothing', fromProject: false });
  assert.ok(st.isError && /Nothing to save/.test(st.content));
  P.deleteTemplate('Two cuts'); P.deleteStyle('Test look');
  assert.equal(P.listTemplates().length, 0);
});

test('timing: speed ramps are exact, split keeps the length, reverse and freeze map source time', async () => {
  const T = await import('../src/timing.js');
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', in: 0, out: 4 });
  const id = p.clips[0].id;
  assert.match(run(p, 'set_speed_ramp', { clipId: id, preset: 'hero' }), /hero .*lasts 3\.03s/);
  const c = p.clips[0];
  // Numeric integral of 1/speed over the source matches the closed form.
  let numeric = 0;
  for (let k = 0, N = 20000; k < N; k++) {
    const f = (k + 0.5) / N, pts = c.ramp.points;
    const i = pts.findIndex((q) => q.at >= f);
    const a = pts[i - 1], b = pts[i];
    numeric += 4 / N / (a.speed + ((b.speed - a.speed) * (f - a.at)) / (b.at - a.at));
  }
  assert.ok(Math.abs(M.clipDuration(c) - numeric) < 1e-3);
  for (const lt of [0, 0.7, 1.5, 2.9]) assert.ok(Math.abs(T.localAt(c, T.srcAt(c, lt)) - lt) < 1e-6);
  assert.equal(+T.speedAt(c, 0.2).toFixed(3), 1.6);
  const len = M.layout(p).duration;
  run(p, 'split_clip', { clipId: id, at: 1.2 });
  assert.ok(Math.abs(M.layout(p).duration - len) < 0.01);
  assert.equal(p.clips[0].out, p.clips[1].in);
  assert.equal(p.clips[0].ramp.points[0].at, 0);
  assert.equal(p.clips[1].ramp.points.at(-1).at, 1);
  // Custom points: ends are filled in, values validated; set_clip speed replaces the ramp.
  run(p, 'set_speed_ramp', { clipId: p.clips[1].id, points: [{ at: 0.5, speed: 0.5 }, { at: 0.2, speed: 2 }] });
  assert.deepEqual(p.clips[1].ramp.points, [{ at: 0, speed: 2 }, { at: 0.2, speed: 2 }, { at: 0.5, speed: 0.5 }, { at: 1, speed: 0.5 }]);
  assert.throws(() => run(p, 'set_speed_ramp', { clipId: p.clips[1].id, points: [{ at: 0, speed: 20 }, { at: 1, speed: 1 }] }), /speed must be a number between 0.1 and 10/);
  assert.throws(() => run(p, 'set_speed_ramp', { clipId: p.clips[1].id, preset: 'wobble' }), /preset must be one of/);
  run(p, 'set_clip', { clipId: p.clips[1].id, speed: 2 });
  assert.equal(p.clips[1].ramp, undefined);
  assert.match(M.summarize(p), /speed ramp 0:1\.6x 0\.8718:1\.6x 1:0\.8353x/);

  // Reverse: plays out..in, split halves keep that order; limited length; not on photos.
  const q = project();
  run(q, 'add_clip', { assetId: 'vid_a', in: 2, out: 6 });
  run(q, 'set_clip', { clipId: q.clips[0].id, reverse: true });
  assert.equal(T.srcAt(q.clips[0], 1), 5);
  run(q, 'split_clip', { clipId: q.clips[0].id, at: 1 });
  assert.deepEqual(q.clips.map((x) => [x.in, x.out, x.reverse]), [[5, 6, true], [2, 5, true]]);
  assert.throws(() => run(q, 'trim_clip', { clipId: q.clips[1].id, in: 0, out: 10.5 }), /out must be a number|at most 10s/);
  run(q, 'add_clip', { assetId: 'img_c' });
  assert.throws(() => run(q, 'set_clip', { clipId: q.clips[2].id, reverse: true }), /Only video clips/);
  const long = project();
  long.assets.vid_a.duration = 20;
  run(long, 'add_clip', { assetId: 'vid_a' });
  assert.throws(() => run(long, 'set_clip', { clipId: long.clips[0].id, reverse: true }), /up to 10s of source/);
  assert.match(M.summarize(q), /source 5\.00-6\.00s reversed/);

  // Freeze frame: split + still in the middle, the frame comes from the reversed source.
  assert.match(run(q, 'freeze_frame', { at: 0.5, duration: 1.5 }), /holds source 5\.5s .* for 1\.50s/);
  const fz = q.clips[1];
  assert.equal(fz.freeze, true); assert.equal(fz.volume, 0); assert.equal(M.clipDuration(fz), 1.5);
  assert.equal(T.srcAt(fz, 1), 5.5);
  assert.throws(() => run(q, 'set_clip', { clipId: fz.id, speed: 2 }), /freeze frame has no speed/);
  run(q, 'trim_clip', { clipId: fz.id, out: 8.5 }); // hold 3s, past the end of the 10s file is fine
  assert.equal(M.clipDuration(fz), 3);
  assert.throws(() => run(q, 'freeze_frame', { at: 0.6 + 0.5 }), /already a still/);
  assert.match(M.summarize(q), /freeze frame of source 5\.50s held 3\.00s/);
  // Captions skip reversed clips and freeze frames.
  const words = M.timelineWords(q, { vid_a: [{ w: 'hi', start: 5.2, end: 5.4 }] });
  assert.equal(words.length, 0);
  // avgRate turns a wanted length into an out point, whatever the trim.
  const r = project();
  run(r, 'add_clip', { assetId: 'vid_a', in: 0, out: 4 });
  run(r, 'set_speed_ramp', { clipId: r.clips[0].id, preset: 'flash_in' });
  const rate = T.avgRate(r.clips[0]);
  run(r, 'trim_clip', { clipId: r.clips[0].id, out: 2 });
  assert.ok(Math.abs(T.avgRate(r.clips[0]) - rate) < 1e-9);
});

test('delete_range ripples every layer; duplicate, delete, move and group items', () => {
  const p = project();
  run(p, 'add_clip', { assetId: 'vid_a', out: 4 });
  run(p, 'add_clip', { assetId: 'vid_b', out: 4 });
  run(p, 'add_text', { text: 'before', start: 0, end: 1 });
  run(p, 'add_text', { text: 'across', start: 2, end: 6 });
  run(p, 'add_text', { text: 'inside', start: 3.2, end: 4.5 });
  run(p, 'add_text', { text: 'after', start: 6, end: 7 });
  run(p, 'add_overlay', { assetId: 'vid_b', start: 4, duration: 2 }); // starts inside
  run(p, 'add_music', { assetId: 'aud_m', start: 0 });
  run(p, 'add_music', { assetId: 'aud_m', start: 5.5, out: 1, role: 'sfx' });
  run(p, 'add_markers', { times: [1, 3.5, 6] });
  run(p, 'set_captions', { words: [{ w: 'a', start: 2.5, end: 2.8 }, { w: 'b', start: 3.4, end: 3.6 }, { w: 'c', start: 5.1, end: 5.3 }] });
  const msg = run(p, 'delete_range', { start: 3, end: 5 });
  assert.match(msg, /Removed 3\.00-5\.00s .*\(2\.00s\).*Video is now 6\.00s/);
  assert.deepEqual(p.clips.map((c) => [c.assetId, c.in, c.out]), [['vid_a', 0, 3], ['vid_b', 1, 4]]);
  assert.deepEqual(p.texts.map((x) => [x.text, x.start, x.end]), [['before', 0, 1], ['across', 2, 4], ['after', 4, 5]]);
  assert.deepEqual([p.overlays[0].start, p.overlays[0].in, p.overlays[0].out], [3, 1, 2]);
  assert.equal(p.music.find((m) => m.role === 'music').start, 0); // background music keeps playing
  assert.equal(p.music.find((m) => m.role === 'sfx').start, 3.5);
  assert.deepEqual(p.markers.map((m) => m.t), [1, 4]);
  assert.deepEqual(p.captions.lines.flatMap((l) => l.words.map((w) => [w.w, w.start])), [['a', 2.5], ['c', 3.1]]);
  assert.throws(() => run(p, 'delete_range', { start: 2, end: 2.01 }), /at least 0.05s/);

  // Group, move together, duplicate as a new group, delete several.
  const [t1, t2] = [p.texts[0].id, p.texts[2].id];
  const sfx = p.music.find((m) => m.role === 'sfx').id;
  assert.match(run(p, 'group_items', { ids: [t1, sfx] }), /Grouped 2 items as grp_\w+/);
  const g = p.texts[0].group;
  assert.throws(() => run(p, 'group_items', { ids: [p.clips[0].id, t2] }), /cannot be grouped/);
  run(p, 'move_items', { ids: [t1], by: 0.5 }); // moves the sfx too
  assert.deepEqual([p.texts[0].start, p.music.find((m) => m.id === sfx).start], [0.5, 4]);
  run(p, 'move_items', { ids: [g], by: -10 }); // stops at 0
  assert.equal(p.texts[0].start, 0);
  assert.throws(() => run(p, 'move_items', { ids: [p.clips[0].id], by: 1 }), /use move_clip/);
  const dup = run(p, 'duplicate_items', { ids: [t1], at: 8 });
  assert.match(dup, /Duplicated 2 item\(s\)/);
  const copies = [...p.texts, ...p.music].filter((x) => x.group && x.group !== g);
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map((x) => x.start).sort((a, b) => a - b), [8, 11.5]);
  const nClips = p.clips.length;
  run(p, 'duplicate_items', { ids: [p.clips[0].id] });
  assert.equal(p.clips.length, nClips + 1);
  assert.equal(p.clips[1].assetId, p.clips[0].assetId);
  run(p, 'ungroup_items', { ids: [copies[0].group] });
  assert.ok(copies.every((x) => !x.group));
  run(p, 'delete_items', { ids: [p.clips[1].id, t2, copies[0].id] });
  assert.equal(p.clips.length, nClips);
  assert.ok(!p.texts.some((x) => x.id === t2));
  assert.throws(() => run(p, 'delete_items', { ids: ['nope'] }), /No clip, text, overlay/);
  assert.match(M.summarize(p), /group grp_/);
});

test('LUTs: import, resolve, set_color, render graph; freeze/reverse/ramp in the ffmpeg graph', async () => {
  const LU = await import('../src/luts.js');
  const tmp = path.join(os.tmpdir(), `lut-${Date.now()}.cube`);
  fs.writeFileSync(tmp, 'TITLE "x"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  assert.equal(LU.importLut(tmp, 'My Film Look.cube'), 'My_Film_Look.cube');
  const bad = path.join(os.tmpdir(), `bad-${Date.now()}.cube`);
  fs.writeFileSync(bad, 'hello');
  assert.throws(() => LU.importLut(bad, 'bad.cube'), /not a 3D .cube LUT/);
  fs.rmSync(bad, { force: true });
  assert.equal(LU.resolveLut('my_film_look'), 'My_Film_Look.cube');
  assert.equal(LU.resolveLut('nope'), null);
  M.env.resolveLut = LU.resolveLut;
  try {
    const p = project();
    run(p, 'add_clip', { assetId: 'vid_a', in: 0, out: 3 });
    run(p, 'add_clip', { assetId: 'vid_b', in: 0, out: 3 });
    run(p, 'add_clip', { assetId: 'vid_a', in: 5, out: 8 });
    assert.match(run(p, 'set_color', { clipId: p.clips[0].id, lut: 'My_Film_Look', lutIntensity: 0.5 }), /LUT My_Film_Look\.cube 0\.5/);
    assert.throws(() => run(p, 'set_color', { clipId: p.clips[1].id, lut: 'missing' }), /Unknown LUT "missing"/);
    assert.throws(() => run(p, 'set_color', { clipId: p.clips[1].id, lutIntensity: 0.5 }), /Set lut before/);
    run(p, 'set_clip', { clipId: p.clips[1].id, reverse: true });
    run(p, 'set_speed_ramp', { clipId: p.clips[2].id, preset: 'montage' });
    run(p, 'freeze_frame', { at: 1, duration: 1 });
    const { graph, args, tmpDir } = buildCommand(p, 'out.mp4', { quality: 'draft' });
    try {
      assert.match(graph, /lut3d=file='[^']*My_Film_Look\.cube':interp=tetrahedral/);
      assert.match(graph, /blend=all_mode=normal:all_opacity=0\.500\[cc0u\]/);
      // Freeze: one input frame held, silent; the input reads only 0.5s.
      assert.match(graph, /\[1:v\]setpts=PTS-STARTPTS,trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2\.000/);
      assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=duration=1\.000,asetpts=PTS-STARTPTS\[a1\]/);
      assert.equal(args[args.indexOf('-ss', args.indexOf('-ss') + 1) + 3], '0.500');
      // Reverse: frames limited to the canvas, then reversed; audio reversed.
      assert.match(graph, /\[3:v\]setpts=PTS-STARTPTS,fps=\d+,scale=w='min\(iw,960\)':h='min\(ih,960\)':force_original_aspect_ratio=decrease,reverse,setpts=PTS\/1/);
      assert.match(graph, /\[3:a\]aformat=[^;]*areverse/);
      // Ramp: exact time curve for the video, constant-tempo pieces for the audio.
      assert.match(graph, /\[4:v\]setpts=PTS-STARTPTS,setpts='\(if\(lt\(min\(T,3\),0\.9\)/);
      assert.match(graph, /\[4:a\][^;]*asplit=\d+\[ra4_0\]/);
      assert.match(graph, /concat=n=\d+:v=0:a=1,volume=1,apad/);
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    // Cover stills: full size, high quality.
    const st = buildCommand(p, 'c.jpg', { frames: [0.5], still: true });
    try {
      assert.match(st.graph, /select='[^']*',format=yuvj420p\[vsel\]/);
      assert.ok(!/scale=-2:960/.test(st.graph));
      assert.equal(st.args[st.args.indexOf('-q:v') + 1], '2');
    } finally { fs.rmSync(st.tmpDir, { recursive: true, force: true }); }
  } finally {
    M.env.resolveLut = null;
    fs.rmSync(path.join(LU.LUTS_DIR, 'My_Film_Look.cube'), { force: true });
  }
});
