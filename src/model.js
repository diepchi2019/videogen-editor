// Project model + edit operations. Single source of truth used by the UI,
// the in-app Claude chat, and the MCP server.
import crypto from 'node:crypto';

export const TRANSITIONS = [
  'none', 'fade', 'dissolve', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'circleopen',
  'circleclose', 'radial', 'zoomin', 'pixelize', 'distance', 'hblur',
];

export const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };

export const uid = (p) => `${p}_${crypto.randomBytes(3).toString('hex')}`;
const r3 = (n) => Math.round(n * 1000) / 1000;

export function emptyProject() {
  return {
    name: 'Untitled',
    settings: { aspect: '9:16', width: 1080, height: 1920, fps: 30, background: '#000000' },
    assets: {},
    clips: [],
    texts: [],
    music: [],
  };
}

export const clipDuration = (c) => (c.out - c.in) / (c.speed || 1);

// Compute timeline positions. A transition on clip i overlaps it with clip i-1.
export function layout(p) {
  let t = 0;
  const clips = p.clips.map((c, i) => {
    const dur = clipDuration(c);
    const tr = i > 0 && c.transition && c.transition.type !== 'none' ? c.transition.duration : 0;
    const start = Math.max(0, t - tr);
    t = start + dur;
    return { ...c, index: i, start: r3(start), end: r3(t), duration: r3(dur), overlap: tr };
  });
  const textEnd = Math.max(0, ...p.texts.map((x) => x.end));
  return { clips, duration: r3(Math.max(t, 0)), videoDuration: r3(t), textEnd };
}

export function summarize(p) {
  const L = layout(p);
  const assets = Object.values(p.assets).map((a) =>
    `- ${a.id}: "${a.name}" ${a.type}${a.duration ? `, ${a.duration.toFixed(2)}s` : ''}${a.width ? `, ${a.width}x${a.height}` : ''}${a.type === 'video' ? (a.hasAudio ? ', has audio' : ', no audio') : ''}`);
  const clips = L.clips.map((c) =>
    `- #${c.index + 1} ${c.id}: asset ${c.assetId} ("${p.assets[c.assetId]?.name}"), source ${c.in.toFixed(2)}-${c.out.toFixed(2)}s, speed ${c.speed}x, volume ${c.volume}, fit ${c.fit || 'contain'}, timeline ${c.start.toFixed(2)}-${c.end.toFixed(2)}s` +
    (c.transition?.type && c.transition.type !== 'none' ? `, transition in: ${c.transition.type} ${c.transition.duration}s` : ''));
  const texts = p.texts.map((x) =>
    `- ${x.id}: "${x.text}" ${x.start.toFixed(2)}-${x.end.toFixed(2)}s at (${x.x},${x.y}) size ${x.size} color ${x.color}${x.box ? ' with box' : ''}${x.animation && x.animation !== 'none' ? `, anim ${x.animation}` : ''}`);
  const music = p.music.map((m) =>
    `- ${m.id}: asset ${m.assetId} ("${p.assets[m.assetId]?.name}") at ${m.start}s, source ${m.in}-${m.out}s, volume ${m.volume}, fade in ${m.fadeIn}s / out ${m.fadeOut}s`);
  return [
    `Canvas: ${p.settings.aspect} (${p.settings.width}x${p.settings.height}) @${p.settings.fps}fps, background ${p.settings.background}`,
    `Total duration: ${L.duration.toFixed(2)}s`,
    `Media library:\n${assets.join('\n') || '(empty)'}`,
    `Video track (plays in order):\n${clips.join('\n') || '(empty)'}`,
    `Text overlays:\n${texts.join('\n') || '(none)'}`,
    `Music/audio track:\n${music.join('\n') || '(none)'}`,
  ].join('\n\n');
}

class OpError extends Error {}
const fail = (m) => { throw new OpError(m); };
const num = (v, name, min = -Infinity, max = Infinity) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} must be a number between ${min} and ${max}`);
  return n;
};

function findClip(p, id) {
  const i = p.clips.findIndex((c) => c.id === id || `#${p.clips.indexOf(c) + 1}` === id);
  if (i < 0) fail(`No clip ${id}. Clips: ${p.clips.map((c) => c.id).join(', ') || 'none'}`);
  return i;
}
const findIn = (arr, id, kind) => {
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) fail(`No ${kind} ${id}`);
  return i;
};
function asset(p, id, types) {
  const a = p.assets[id];
  if (!a) fail(`No asset ${id}. Assets: ${Object.keys(p.assets).join(', ') || 'none'}`);
  if (types && !types.includes(a.type)) fail(`Asset ${id} is ${a.type}, expected ${types.join('/')}`);
  return a;
}
function clampTransition(p, i) {
  const c = p.clips[i];
  if (!c?.transition || c.transition.type === 'none' || i === 0) return;
  const prev = p.clips[i - 1];
  const max = Math.max(0.1, Math.min(clipDuration(prev), clipDuration(c)) - 0.05);
  c.transition.duration = r3(Math.min(c.transition.duration, max));
}
const clampAll = (p) => p.clips.forEach((_, i) => clampTransition(p, i));

// Each op: (project, input) => message. Ops mutate the project.
export const ops = {
  add_clip(p, { assetId, in: tin, out, position, duration }) {
    const a = asset(p, assetId, ['video', 'image']);
    const srcDur = a.type === 'image' ? 3600 : a.duration;
    const i0 = num(tin, 'in', 0, srcDur) ?? 0;
    let o = num(out, 'out', 0, srcDur);
    if (o === undefined) o = a.type === 'image' ? i0 + (num(duration, 'duration', 0.1, 600) ?? 3) : srcDur;
    if (o <= i0) fail('out must be greater than in');
    const clip = { id: uid('clip'), assetId, in: r3(i0), out: r3(o), speed: 1, volume: 1, fit: 'contain', transition: { type: 'none', duration: 0.5 } };
    const pos = position === undefined ? p.clips.length : Math.max(0, Math.min(p.clips.length, Math.round(num(position, 'position')) - 1));
    p.clips.splice(pos, 0, clip);
    clampAll(p);
    return `Added ${clip.id} at position ${pos + 1} (${clip.in}-${clip.out}s of "${a.name}")`;
  },

  trim_clip(p, { clipId, in: tin, out }) {
    const i = findClip(p, clipId), c = p.clips[i], a = p.assets[c.assetId];
    const max = a.type === 'image' ? 3600 : a.duration;
    const ni = num(tin, 'in', 0, max) ?? c.in, no = num(out, 'out', 0, max) ?? c.out;
    if (no - ni < 0.05) fail('Clip would be shorter than 0.05s');
    c.in = r3(ni); c.out = r3(no);
    clampAll(p);
    return `Trimmed ${c.id} to source ${c.in}-${c.out}s`;
  },

  split_clip(p, { clipId, at }) {
    const L = layout(p);
    let i;
    const t = num(at, 'at', 0);
    if (clipId) i = findClip(p, clipId);
    else i = L.clips.findIndex((c) => t > c.start && t < c.end);
    if (i < 0) fail(`No clip at ${t}s`);
    const c = p.clips[i], lc = L.clips[i];
    if (t <= lc.start + 0.05 || t >= lc.end - 0.05) fail(`Split time ${t}s must be inside clip (${lc.start}-${lc.end}s)`);
    const srcT = r3(c.in + (t - lc.start) * c.speed);
    const second = { ...structuredClone(c), id: uid('clip'), in: srcT, transition: { type: 'none', duration: 0.5 } };
    c.out = srcT;
    p.clips.splice(i + 1, 0, second);
    clampAll(p);
    return `Split ${c.id} at ${t}s; new clip ${second.id}`;
  },

  delete_clip(p, { clipId }) {
    const i = findClip(p, clipId);
    const [c] = p.clips.splice(i, 1);
    if (p.clips[0]) p.clips[0].transition = { type: 'none', duration: 0.5 };
    clampAll(p);
    return `Deleted ${c.id}`;
  },

  move_clip(p, { clipId, position }) {
    const i = findClip(p, clipId);
    const [c] = p.clips.splice(i, 1);
    const pos = Math.max(0, Math.min(p.clips.length, Math.round(num(position, 'position', 1)) - 1));
    p.clips.splice(pos, 0, c);
    if (p.clips[0]) p.clips[0].transition = { type: 'none', duration: 0.5 };
    clampAll(p);
    return `Moved ${c.id} to position ${pos + 1}`;
  },

  set_clip(p, { clipId, speed, volume, fit }) {
    const c = p.clips[findClip(p, clipId)];
    if (fit !== undefined) {
      if (!['contain', 'cover', 'blur'].includes(fit)) fail('fit must be contain, cover or blur');
      c.fit = fit;
    }
    const s = num(speed, 'speed', 0.25, 4); if (s !== undefined) c.speed = s;
    const v = num(volume, 'volume', 0, 2); if (v !== undefined) c.volume = v;
    clampAll(p);
    return `Updated ${c.id}: speed ${c.speed}x, volume ${c.volume}, fit ${c.fit || 'contain'}`;
  },

  set_transition(p, { clipId, type, duration }) {
    const i = findClip(p, clipId);
    if (!TRANSITIONS.includes(type)) fail(`Unknown transition ${type}. Options: ${TRANSITIONS.join(', ')}`);
    if (i === 0 && type !== 'none') fail('The first clip has no previous clip to transition from. Use a fade-in text or pick clip #2+.');
    p.clips[i].transition = { type, duration: num(duration, 'duration', 0.1, 5) ?? 0.5 };
    clampTransition(p, i);
    return `Transition into ${p.clips[i].id}: ${type} ${p.clips[i].transition.duration}s`;
  },

  add_text(p, { text, start, end, x, y, size, color, box, boxColor, animation }) {
    if (!text) fail('text is required');
    const L = layout(p);
    const s = num(start, 'start', 0) ?? 0;
    const e = num(end, 'end', 0) ?? Math.max(s + 3, Math.min(L.duration, s + 3));
    if (e <= s) fail('end must be after start');
    const t = {
      id: uid('text'), text: String(text), start: r3(s), end: r3(e),
      x: num(x, 'x', 0, 1) ?? 0.5, y: num(y, 'y', 0, 1) ?? 0.5,
      size: num(size, 'size', 8, 400) ?? 72, color: color || '#ffffff',
      box: !!box, boxColor: boxColor || '#000000', animation: animation || 'none',
    };
    p.texts.push(t);
    return `Added text ${t.id} "${t.text}" ${t.start}-${t.end}s`;
  },

  update_text(p, { textId, ...rest }) {
    const t = p.texts[findIn(p.texts, textId, 'text')];
    for (const k of ['start', 'end', 'x', 'y', 'size']) {
      const v = num(rest[k], k, 0, k === 'x' || k === 'y' ? 1 : Infinity); if (v !== undefined) t[k] = r3(v);
    }
    for (const k of ['text', 'color', 'boxColor', 'animation']) if (rest[k] !== undefined) t[k] = String(rest[k]);
    if (rest.box !== undefined) t.box = !!rest.box;
    if (t.end <= t.start) fail('end must be after start');
    return `Updated text ${t.id}`;
  },

  delete_text(p, { textId }) {
    const [t] = p.texts.splice(findIn(p.texts, textId, 'text'), 1);
    return `Deleted text ${t.id}`;
  },

  add_music(p, { assetId, start, in: tin, out, volume, fadeIn, fadeOut }) {
    const a = asset(p, assetId, ['audio', 'video']);
    if (a.type === 'video' && !a.hasAudio) fail('That video has no audio track');
    const i0 = num(tin, 'in', 0, a.duration) ?? 0;
    const o = num(out, 'out', 0, a.duration) ?? a.duration;
    if (o <= i0) fail('out must be greater than in');
    const m = {
      id: uid('music'), assetId, start: num(start, 'start', 0) ?? 0, in: r3(i0), out: r3(o),
      volume: num(volume, 'volume', 0, 2) ?? 0.6, fadeIn: num(fadeIn, 'fadeIn', 0, 30) ?? 0, fadeOut: num(fadeOut, 'fadeOut', 0, 30) ?? 1,
    };
    p.music.push(m);
    return `Added music ${m.id} from "${a.name}" at ${m.start}s`;
  },

  update_music(p, { musicId, ...rest }) {
    const m = p.music[findIn(p.music, musicId, 'music')];
    const lim = { start: [0, 1e6], in: [0, 1e6], out: [0, 1e6], volume: [0, 2], fadeIn: [0, 30], fadeOut: [0, 30] };
    for (const k of Object.keys(lim)) { const v = num(rest[k], k, ...lim[k]); if (v !== undefined) m[k] = r3(v); }
    if (m.out <= m.in) fail('out must be greater than in');
    return `Updated music ${m.id}`;
  },

  delete_music(p, { musicId }) {
    const [m] = p.music.splice(findIn(p.music, musicId, 'music'), 1);
    return `Deleted music ${m.id}`;
  },

  set_canvas(p, { aspect, background, fps }) {
    if (aspect) {
      if (!ASPECTS[aspect]) fail(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`);
      p.settings.aspect = aspect;
      [p.settings.width, p.settings.height] = ASPECTS[aspect];
    }
    if (background) p.settings.background = background;
    const f = num(fps, 'fps', 10, 60); if (f) p.settings.fps = Math.round(f);
    return `Canvas: ${p.settings.aspect} ${p.settings.width}x${p.settings.height}, bg ${p.settings.background}, ${p.settings.fps}fps`;
  },

  clear_timeline(p) {
    p.clips = []; p.texts = []; p.music = [];
    return 'Cleared timeline (media library kept)';
  },
};

export { OpError };
