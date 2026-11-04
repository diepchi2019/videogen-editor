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
    assert.match(graph, /\[cc0l\]\[cc0o\]blend=all_mode=normal:all_opacity=0\.400\[cc0b\]/);
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
