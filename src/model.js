// Project model + edit operations. Single source of truth used by the UI,
// the in-app Claude chat, and the MCP server.
import crypto from 'node:crypto';

export const TRANSITIONS = [
  'none', 'fade', 'dissolve', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'circleopen',
  'circleclose', 'radial', 'zoomin', 'pixelize', 'distance', 'hblur',
];

export const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };
export const FITS = ['contain', 'cover', 'blur'];
export const MOTIONS = ['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down'];
export const TEXT_ANIM_IN = ['none', 'fade', 'pop', 'slideup', 'slidedown', 'slideleft', 'slideright', 'zoom', 'typewriter'];
export const TEXT_ANIM_OUT = ['none', 'fade', 'pop', 'slideup', 'slidedown', 'zoom'];
export const AUDIO_ROLES = ['music', 'sfx', 'voice'];
export const OVERLAY_FITS = ['free', 'contain', 'cover'];
export const OVERLAY_ANIMS = ['none', 'fade'];
export const CAPTION_MODES = ['line', 'karaoke', 'word', 'single'];
export const REGION_MODES = ['fill', 'patch'];
export const CLIP_ANIMS = ['none', 'fade', 'zoom_in', 'zoom_out', 'slide_left', 'slide_right', 'slide_up', 'slide_down'];
// Color filter presets (looks). render.js maps them to ffmpeg filters, public/app.js to CSS filters.
export const FILTERS = ['none', 'bw', 'sepia', 'vintage', 'warm', 'cool', 'vivid', 'cinematic', 'matte', 'noir', 'dramatic'];
export const EFFECTS = ['shake', 'zoom_pulse', 'glitch', 'rgb_split', 'flash', 'blur', 'vhs', 'light_leak', 'invert'];
// Animatable properties and their value ranges.
export const KEYFRAME_PROPS = {
  clip: { scale: [0.1, 5], x: [-1, 2], y: [-1, 2], volume: [0, 2] },
  overlay: { x: [-1, 2], y: [-1, 2], scale: [0.02, 4], opacity: [0, 1], rotate: [-720, 720], volume: [0, 2] },
};
const COLOR_KEYS = [['brightness', -1, 1, 0], ['contrast', 0, 3, 1], ['saturation', 0, 3, 1], ['temperature', -1, 1, 0], ['vignette', 0, 1, 0]];

// Value of a keyframe track {easing, points:[{t,v}]} at local time t (points sorted by t).
export function kfAt(track, t) {
  const ps = track.points;
  if (t <= ps[0].t) return ps[0].v;
  for (let i = 1; i < ps.length; i++) {
    if (t <= ps[i].t) {
      const a = ps[i - 1], b = ps[i];
      let k = (t - a.t) / (b.t - a.t);
      if (track.easing !== 'linear') k = k * k * (3 - 2 * k);
      return a.v + (b.v - a.v) * k;
    }
  }
  return ps[ps.length - 1].v;
}

// Text style presets: values applied first, explicit input wins.
export const TEXT_STYLES = {
  plain: { outline: 0, shadow: 0, box: false },
  outline: { outline: 6, outlineColor: '#000000', shadow: 0, box: false },
  bold_title: { bold: true, outline: 8, outlineColor: '#000000', shadow: 4, shadowColor: '#000000', box: false },
  boxed: { box: true, boxColor: '#000000', outline: 0, shadow: 0 },
  highlight: { color: '#ffde00', bold: true, outline: 7, outlineColor: '#000000', box: false, animation: 'pop' },
  neon: { color: '#ffffff', outline: 5, outlineColor: '#ff2bd6', blur: 3, box: false, shadow: 0 },
  subtitle: { size: 54, y: 0.82, outline: 3, outlineColor: '#000000', box: false, shadow: 0 },
  sticker: { color: '#111111', box: true, boxColor: '#ffffff', bold: true, outline: 0, shadow: 0 },
};

// Caption style presets (see set_captions).
export const CAPTION_STYLES = {
  classic: { mode: 'line', size: 64, color: '#ffffff', outline: 4, uppercase: false, maxWords: 6, y: 0.75 },
  boxed: { mode: 'line', size: 60, color: '#ffffff', box: true, boxColor: '#000000', outline: 0, maxWords: 6, y: 0.75 },
  karaoke: { mode: 'karaoke', size: 72, color: '#ffffff', highlightColor: '#ffde00', outline: 5, maxWords: 5, y: 0.72 },
  highlight: { mode: 'word', size: 80, color: '#ffffff', highlightColor: '#00e5ff', outline: 6, uppercase: true, maxWords: 3, y: 0.7 },
  single: { mode: 'single', size: 120, color: '#ffffff', highlightColor: '#ffffff', outline: 8, uppercase: true, maxWords: 1, y: 0.62 },
};

export const uid = (p) => `${p}_${crypto.randomBytes(3).toString('hex')}`;
const r3 = (n) => Math.round(n * 1000) / 1000;

// Hooks the server installs (fonts live outside the pure model).
export const env = { resolveFont: null };

export function emptyProject() {
  return {
    version: 2,
    id: uid('proj'),
    name: 'Untitled',
    settings: { aspect: '9:16', width: 1080, height: 1920, fps: 30, background: '#000000' },
    assets: {},
    clips: [],
    overlays: [],
    texts: [],
    music: [],
    captions: null,
    markers: [],
  };
}

// Bring a project from any older version up to the current shape.
export function migrate(p) {
  p.id ??= uid('proj');
  p.name ??= 'Untitled';
  p.assets ??= {};
  for (const k of ['clips', 'overlays', 'texts', 'music', 'markers']) p[k] ??= [];
  p.captions ??= null;
  for (const m of p.music) { m.role ??= 'music'; m.track ??= 1; }
  p.version = 2;
  return p;
}

export const clipDuration = (c) => (c.out - c.in) / (c.speed || 1);
export const overlayDuration = (o) => (o.out - o.in) / (o.speed || 1);

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

// Map per-asset transcripts (source seconds) onto the timeline.
// transcripts: { [assetId]: [{ w, start, end }] }. Returns words sorted by timeline start.
export function timelineWords(p, transcripts, sources = ['clips', 'overlays', 'voice']) {
  const L = layout(p);
  const out = [];
  const place = (words, srcIn, srcOut, tlStart, speed, tlEnd) => {
    for (const w of words || []) {
      const mid = (w.start + w.end) / 2;
      if (mid < srcIn || mid > srcOut) continue;
      const s = tlStart + (Math.max(w.start, srcIn) - srcIn) / speed;
      const e = Math.min(tlEnd, tlStart + (Math.min(w.end, srcOut) - srcIn) / speed);
      if (s < L.duration && e > s) out.push({ w: w.w, start: r3(s), end: r3(Math.min(e, L.duration)) });
    }
  };
  if (sources.includes('clips')) {
    for (const c of L.clips) if ((c.volume ?? 1) > 0) place(transcripts[c.assetId], c.in, c.out, c.start, c.speed || 1, c.end);
  }
  if (sources.includes('overlays')) {
    for (const o of p.overlays) if ((o.volume ?? 1) > 0) place(transcripts[o.assetId], o.in, o.out, o.start, o.speed || 1, o.start + overlayDuration(o));
  }
  for (const m of p.music) {
    if (!sources.includes(m.role) && !(sources.includes('all'))) continue;
    place(transcripts[m.assetId], m.in, m.out, m.start, 1, m.start + (m.out - m.in));
  }
  return out.sort((a, b) => a.start - b.start);
}

// Group timed words into caption lines.
export function groupWords(words, { maxWords = 5, maxChars = 32, maxGap = 0.6 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.w).trim();
    if (!text) continue;
    const gapBreak = cur && w.start - cur.words[cur.words.length - 1].end > maxGap;
    const chars = cur ? cur.words.reduce((n, x) => n + x.w.length + 1, 0) + text.length : 0;
    if (!cur || gapBreak || cur.words.length >= maxWords || chars > maxChars || cur.sentenceEnd) {
      cur = { words: [], sentenceEnd: false };
      lines.push(cur);
    }
    cur.words.push({ w: text, start: r3(w.start), end: r3(Math.max(w.end, w.start + 0.05)) });
    cur.sentenceEnd = /[.!?…。！？]$/.test(text);
  }
  return lines.map((l, i) => {
    const next = lines[i + 1];
    const last = l.words[l.words.length - 1].end;
    // Hold the line a little after the last word, but never past the next line.
    const end = Math.min(last + 0.4, next ? next.words[0].start : last + 0.4);
    return { id: uid('cap'), start: l.words[0].start, end: r3(Math.max(end, last)), words: l.words };
  });
}

const fmtT = (n) => Number(n).toFixed(2);
function describeTransform(t) {
  if (!t) return '';
  const parts = [];
  if (t.crop) parts.push(`crop ${['x', 'y', 'w', 'h'].map((k) => `${k}${t.crop[k]}`).join(' ')}`);
  if (t.rotate) parts.push(`rotate ${t.rotate}°`);
  if (t.flipH) parts.push('flipH');
  if (t.flipV) parts.push('flipV');
  if ((t.scale ?? 1) !== 1) parts.push(`scale ${t.scale}`);
  if ((t.x ?? 0.5) !== 0.5 || (t.y ?? 0.5) !== 0.5) parts.push(`center (${t.x ?? 0.5},${t.y ?? 0.5})`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}
function describeColor(c) {
  if (!c) return '';
  const parts = COLOR_KEYS.filter(([k, , , d]) => c[k] !== undefined && c[k] !== d).map(([k]) => `${k} ${c[k]}`);
  if (c.filter) parts.push(`filter ${c.filter}${(c.filterIntensity ?? 1) !== 1 ? ` ${c.filterIntensity}` : ''}`);
  return parts.length ? `, color: ${parts.join(' ')}` : '';
}
// Keyframe times are stored relative to the item; show them in timeline seconds.
function describeKeyframes(item, start) {
  if (!item.keyframes) return '';
  return ', keyframes: ' + Object.entries(item.keyframes).map(([prop, tr]) =>
    `${prop} ${tr.points.map((q) => `${fmtT(start + q.t)}s=${q.v}`).join(' ')}${tr.easing === 'linear' ? ' (linear)' : ''}`).join('; ');
}
function describeAnims(c) {
  const a = [];
  if (c.animIn) a.push(`anim in ${c.animIn.type} ${c.animIn.duration}s`);
  if (c.animOut) a.push(`anim out ${c.animOut.type} ${c.animOut.duration}s`);
  return a.length ? `, ${a.join(', ')}` : '';
}
const describeEffects = (c, start) => (c.effects?.length
  ? `, effects: ${c.effects.map((e) => `${e.id} ${e.type} ${fmtT(start + e.from)}-${fmtT(start + e.to)}s intensity ${e.intensity}${e.type === 'zoom_pulse' || e.type === 'shake' ? ` rate ${e.rate}/s` : ''}`).join('; ')}` : '');

// extras: { transcribed: Set<assetId> } (optional, filled in by the server)
export function summarize(p, extras = {}) {
  const L = layout(p);
  const tx = extras.transcribed || new Set();
  const assets = Object.values(p.assets).map((a) =>
    `- ${a.id}: "${a.name}" ${a.type}${a.duration ? `, ${a.duration.toFixed(2)}s` : ''}${a.width ? `, ${a.width}x${a.height}` : ''}${a.type === 'video' ? (a.hasAudio ? ', has audio' : ', no audio') : ''}${tx.has(a.id) ? ', transcript ready' : ''}`);
  const clips = L.clips.map((c) =>
    `- #${c.index + 1} ${c.id}${c.styleRole ? ` (style ${c.styleRole})` : ''}: asset ${c.assetId} ("${p.assets[c.assetId]?.name}"), source ${c.in.toFixed(2)}-${c.out.toFixed(2)}s, speed ${c.speed}x, volume ${c.volume}, fit ${c.fit || 'contain'}, timeline ${c.start.toFixed(2)}-${c.end.toFixed(2)}s` +
    describeTransform(c.transform) +
    (c.motion && c.motion.preset !== 'none' ? `, motion ${c.motion.preset} ${c.motion.intensity}` : '') +
    describeColor(c.color) + describeAnims(c) + describeEffects(c, c.start) + describeKeyframes(c, c.start) +
    (c.transition?.type && c.transition.type !== 'none' ? `, transition in: ${c.transition.type} ${c.transition.duration}s` : '') +
    (c.regions?.length ? `, removed regions: ${c.regions.map(describeRegion).join('; ')}` : ''));
  const overlays = [...p.overlays].sort((a, b) => a.track - b.track || a.start - b.start).map((o) =>
    `- ${o.id} (track ${o.track}${o.styleRole ? `, style ${o.styleRole}` : ''}): asset ${o.assetId} ("${p.assets[o.assetId]?.name}"), timeline ${fmtT(o.start)}-${fmtT(o.start + overlayDuration(o))}s, source ${fmtT(o.in)}-${fmtT(o.out)}s` +
    (o.fit === 'free' ? `, center (${o.x},${o.y}) width ${o.scale} of frame` : `, fit ${o.fit}`) +
    `${o.opacity !== 1 ? `, opacity ${o.opacity}` : ''}${o.rotate ? `, rotate ${o.rotate}°` : ''}${o.crop ? `, crop x${o.crop.x} y${o.crop.y} w${o.crop.w} h${o.crop.h}` : ''}` +
    `${o.flipH ? ', flipH' : ''}${o.flipV ? ', flipV' : ''}${p.assets[o.assetId]?.type === 'video' ? `, volume ${o.volume}, speed ${o.speed}x` : ''}${o.animation !== 'none' ? `, ${o.animation} in/out` : ''}` +
    describeColor(o.color) + describeKeyframes(o, o.start));
  const texts = p.texts.map((x) =>
    `- ${x.id}: "${x.text}" ${x.start.toFixed(2)}-${x.end.toFixed(2)}s at (${x.x},${x.y}) size ${x.size} color ${x.color}` +
    `${x.font ? ` font "${x.font}"` : ''}${x.style ? ` style ${x.style}` : ''}${x.box ? ' with box' : ''}` +
    `${x.outline ? ` outline ${x.outline}${x.outlineColor ? ' ' + x.outlineColor : ''}` : ''}${x.shadow ? ` shadow ${x.shadow}` : ''}` +
    `${x.animation && x.animation !== 'none' ? `, in ${x.animation}` : ''}${x.animationOut && x.animationOut !== 'none' ? `, out ${x.animationOut}` : ''}`);
  const music = p.music.map((m) =>
    `- ${m.id} [${m.role}, track ${m.track}]: asset ${m.assetId} ("${p.assets[m.assetId]?.name}") at ${m.start}s, source ${m.in}-${m.out}s, volume ${m.volume}, fade in ${m.fadeIn}s / out ${m.fadeOut}s${m.duck ? `, ducks under speech (amount ${m.duck})` : ''}`);
  const markers = p.markers || [];
  const byKind = {};
  for (const mk of markers) (byKind[mk.kind] ||= []).push(mk);
  const markerText = Object.entries(byKind).map(([kind, list]) => {
    const shown = list.slice(0, extras.full ? Infinity : 24).map((mk) => `${fmtT(mk.t)}${mk.label ? ` "${mk.label}"` : ''}`).join(', ');
    return `- ${list.length} ${kind} markers: ${shown}${list.length > 24 && !extras.full ? ', …' : ''}`;
  }).join('\n');
  let captions = '(none)';
  if (p.captions?.lines?.length) {
    const st = p.captions.style;
    const shown = p.captions.lines.slice(0, extras.full ? Infinity : 40);
    captions = `${p.captions.lines.length} lines, style ${st.preset} (mode ${st.mode}, size ${st.size}, y ${st.y}${st.font ? `, font "${st.font}"` : ''})\n` +
      shown.map((l) => `- ${l.id} ${fmtT(l.start)}-${fmtT(l.end)}s: ${l.words.map((w) => w.w).join(' ')}`).join('\n') +
      (shown.length < p.captions.lines.length ? `\n- … ${p.captions.lines.length - shown.length} more (get_timeline detail=full)` : '');
  }
  return [
    `Project: "${p.name}" (${p.id})`,
    `Canvas: ${p.settings.aspect} (${p.settings.width}x${p.settings.height}) @${p.settings.fps}fps, background ${p.settings.background}`,
    `Total duration: ${L.duration.toFixed(2)}s`,
    ...(p.style ? [`Style: "${p.style.name}"${p.style.id ? ` (${p.style.id})` : ''}, new items follow its defaults`] : []),
    `Media library:\n${assets.join('\n') || '(empty)'}`,
    `Video track (plays in order):\n${clips.join('\n') || '(empty)'}`,
    `Overlays (picture-in-picture, logos, B-roll on top of the video track; higher track = on top):\n${overlays.join('\n') || '(none)'}`,
    `Text overlays:\n${texts.join('\n') || '(none)'}`,
    `Captions:\n${captions}`,
    `Audio tracks (music, sound effects, voice):\n${music.join('\n') || '(none)'}`,
    ...(markers.length ? [`Markers (timeline seconds):\n${markerText}`] : []),
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
const bool = (v) => (v === undefined || v === null ? undefined : v === true || v === 'true' || v === 1);
const oneOf = (v, list, name) => {
  if (v === undefined || v === null) return undefined;
  if (!list.includes(v)) fail(`${name} must be one of: ${list.join(', ')}`);
  return v;
};
// Colors go into ffmpeg filter graphs and ASS files, so only plain hex is allowed.
export function color(v, name = 'color') {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) fail(`${name} must be a hex color like #ffde00 (got "${s}")`);
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}
function font(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (!env.resolveFont) return String(v);
  const f = env.resolveFont(String(v));
  if (!f) fail(`Unknown font "${v}". Call list_fonts to see installed fonts, or import a .ttf/.otf file with import_media.`);
  return f;
}
function crop(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false) return null;
  const c = {};
  for (const k of ['x', 'y', 'w', 'h']) c[k] = num(v[k], `crop.${k}`, 0, 1) ?? (k === 'w' || k === 'h' ? 1 : 0);
  if (c.w < 0.05 || c.h < 0.05) fail('crop.w and crop.h must be at least 0.05');
  if (c.x + c.w > 1.0001 || c.y + c.h > 1.0001) fail('crop must stay inside the frame: x + w <= 1 and y + h <= 1');
  return c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1 ? null : c;
}

function findClip(p, id) {
  const i = p.clips.findIndex((c) => c.id === id || `#${p.clips.indexOf(c) + 1}` === id);
  if (i < 0) fail(`No clip ${id}. Clips: ${p.clips.map((c) => c.id).join(', ') || 'none'}`);
  return i;
}
const findIn = (arr, id, kind) => {
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) fail(`No ${kind} ${id}. ${kind}s: ${arr.map((x) => x.id).join(', ') || 'none'}`);
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

// Shared by add_text / update_text. Applies style preset first, explicit values win.
function applyText(t, input, isNew) {
  if (input.style !== undefined && input.style !== null && input.style !== '') {
    const preset = TEXT_STYLES[input.style];
    if (!preset) fail(`style must be one of: ${Object.keys(TEXT_STYLES).join(', ')}`);
    t.style = input.style;
    for (const [k, v] of Object.entries(preset)) if (input[k] === undefined) t[k] = v;
  }
  for (const [k, min, max] of [['x', 0, 1], ['y', 0, 1], ['size', 8, 400], ['outline', 0, 40], ['shadow', 0, 40], ['blur', 0, 20]]) {
    const v = num(input[k], k, min, max); if (v !== undefined) t[k] = r3(v);
  }
  for (const k of ['color', 'boxColor', 'outlineColor', 'shadowColor']) { const v = color(input[k], k); if (v) t[k] = v; }
  for (const k of ['box', 'bold', 'italic']) { const v = bool(input[k]); if (v !== undefined) t[k] = v; }
  const f = font(input.font); if (f) t.font = f;
  const ai = oneOf(input.animation, TEXT_ANIM_IN, 'animation'); if (ai) t.animation = ai;
  const ao = oneOf(input.animationOut, TEXT_ANIM_OUT, 'animationOut'); if (ao) t.animationOut = ao;
  if (input.text !== undefined) { if (!String(input.text)) fail('text cannot be empty'); t.text = String(input.text); }
  if (isNew) {
    t.x ??= 0.5; t.y ??= 0.5; t.size ??= 72; t.color ??= '#ffffff'; t.box ??= false; t.boxColor ??= '#000000';
    t.animation ??= 'none'; t.animationOut ??= 'none'; t.bold ??= true;
  }
}

function applyTransform(c, input) {
  const has = ['crop', 'rotate', 'flipH', 'flipV', 'scale', 'x', 'y'].some((k) => input[k] !== undefined);
  if (bool(input.resetTransform)) delete c.transform;
  if (!has) return;
  const t = { ...(c.transform || {}) };
  const cr = crop(input.crop); if (cr !== undefined) { if (cr) t.crop = cr; else delete t.crop; }
  const rot = num(input.rotate, 'rotate', -360, 360); if (rot !== undefined) t.rotate = r3(((rot % 360) + 360) % 360);
  const fh = bool(input.flipH); if (fh !== undefined) t.flipH = fh;
  const fv = bool(input.flipV); if (fv !== undefined) t.flipV = fv;
  const s = num(input.scale, 'scale', 0.1, 5); if (s !== undefined) t.scale = r3(s);
  const x = num(input.x, 'x', -1, 2); if (x !== undefined) t.x = r3(x);
  const y = num(input.y, 'y', -1, 2); if (y !== undefined) t.y = r3(y);
  for (const k of Object.keys(t)) if (t[k] === false || (k === 'rotate' && t[k] === 0)) delete t[k];
  if (t.scale === 1) delete t.scale;
  if (t.x === 0.5) delete t.x;
  if (t.y === 0.5) delete t.y;
  if (Object.keys(t).length) c.transform = t; else delete c.transform;
}

// Divide clip-relative data (effects, keyframes, in/out animations) between the halves of a split at local time cut.
function splitTimed(first, second, cut) {
  if (first.effects) {
    second.effects = first.effects.filter((e) => e.to > cut).map((e) => ({ ...e, from: r3(Math.max(0, e.from - cut)), to: r3(e.to - cut) }));
    first.effects = first.effects.filter((e) => e.from < cut).map((e) => ({ ...e, to: r3(Math.min(e.to, cut)) }));
    for (const c of [first, second]) if (!c.effects.length) delete c.effects;
  }
  if (first.keyframes) {
    const k1 = {}, k2 = {};
    for (const [prop, tr] of Object.entries(first.keyframes)) {
      const mid = r3(kfAt(tr, cut));
      k1[prop] = { ...tr, points: [...tr.points.filter((q) => q.t < cut), { t: r3(cut), v: mid }] };
      k2[prop] = { ...tr, points: [{ t: 0, v: mid }, ...tr.points.filter((q) => q.t > cut).map((q) => ({ t: r3(q.t - cut), v: q.v }))] };
    }
    first.keyframes = k1; second.keyframes = k2;
  }
  delete first.animOut; delete second.animIn;
}

// clipId or overlayId -> the item plus its timeline start and duration.
function timedTarget(p, { clipId, overlayId }) {
  if (clipId) {
    const i = findClip(p, clipId), lc = layout(p).clips[i];
    return { kind: 'clip', item: p.clips[i], start: lc.start, dur: lc.duration };
  }
  if (overlayId) {
    const o = p.overlays[findIn(p.overlays, overlayId, 'overlay')];
    return { kind: 'overlay', item: o, start: o.start, dur: overlayDuration(o) };
  }
  return fail('Give clipId or overlayId');
}

const describeRegion = (r) =>
  `${r.id} ${r.mode} x${r.x} y${r.y} w${r.w} h${r.h} source ${fmtT(r.from)}-${fmtT(r.to)}s${r.mode === 'patch' ? ` from frame ${fmtT(r.patchAt)}s` : ''}`;

// Find a region by id in any clip (split clips share region ids). Returns [{clip, index}].
function findRegions(p, regionId, clipId) {
  const clips = clipId ? [p.clips[findClip(p, clipId)]] : p.clips;
  const hits = [];
  for (const c of clips) {
    const i = (c.regions || []).findIndex((r) => r.id === regionId);
    if (i >= 0) hits.push({ clip: c, index: i });
  }
  if (!hits.length) {
    const all = clips.flatMap((c) => (c.regions || []).map((r) => r.id));
    fail(`No region ${regionId}. Regions: ${[...new Set(all)].join(', ') || 'none'}`);
  }
  return hits;
}

// Color settings (adjustments + look) merged over base; undefined when nothing is left.
function colorFrom(base, input, prefix = '') {
  const c = { ...(base || {}) };
  for (const [k, min, max, def] of COLOR_KEYS) {
    const v = num(input[k], prefix + k, min, max);
    if (v !== undefined) c[k] = r3(v);
    if (c[k] === def) delete c[k];
  }
  const f = oneOf(input.filter, FILTERS, prefix + 'filter');
  if (f === 'none') { delete c.filter; delete c.filterIntensity; } else if (f) c.filter = f;
  const fi = num(input.filterIntensity, prefix + 'filterIntensity', 0, 1);
  if (fi !== undefined) { if (!c.filter) fail(`Set ${prefix}filter (e.g. vintage) before ${prefix}filterIntensity`); c.filterIntensity = r3(fi); }
  if (c.filterIntensity === 1) delete c.filterIntensity;
  return Object.keys(c).length ? c : undefined;
}

function applyOverlay(o, input, a) {
  const sp = num(input.speed, 'speed', 0.25, 4); if (sp !== undefined) o.speed = sp;
  const max = a.type === 'image' ? 3600 : a.duration;
  const i0 = num(input.in, 'in', 0, max); if (i0 !== undefined) o.in = r3(i0);
  const o0 = num(input.out, 'out', 0, max); if (o0 !== undefined) o.out = r3(o0);
  const st = num(input.start, 'start', 0); if (st !== undefined) o.start = r3(st);
  const d = num(input.duration, 'duration', 0.1, 3600);
  const e = num(input.end, 'end', 0);
  if (e !== undefined) o.out = r3(o.in + (e - o.start) * o.speed);
  else if (d !== undefined) o.out = r3(o.in + d * o.speed);
  if (a.type === 'video' && o.out > a.duration) fail(`This overlay would need ${r3(o.out)}s of source but "${a.name}" is ${a.duration.toFixed(2)}s long. Shorten end/duration or lower in.`);
  if (o.out - o.in < 0.05) fail('Overlay must be at least 0.05s long (check start/end/in/out)');
  for (const [k, min, max2] of [['x', -1, 2], ['y', -1, 2], ['scale', 0.02, 4], ['opacity', 0, 1], ['volume', 0, 2], ['rotate', -360, 360]]) {
    const v = num(input[k], k, min, max2); if (v !== undefined) o[k] = r3(v);
  }
  const tr = num(input.track, 'track', 1, 20); if (tr !== undefined) o.track = Math.round(tr);
  const f = oneOf(input.fit, OVERLAY_FITS, 'fit'); if (f) o.fit = f;
  const an = oneOf(input.animation, OVERLAY_ANIMS, 'animation'); if (an) o.animation = an;
  const cr = crop(input.crop); if (cr !== undefined) { if (cr) o.crop = cr; else delete o.crop; }
  for (const k of ['flipH', 'flipV']) { const v = bool(input[k]); if (v !== undefined) o[k] = v; }
}

function captionStyle(base, input) {
  const st = { ...base };
  if (input.preset !== undefined) {
    const pr = CAPTION_STYLES[input.preset];
    if (!pr) fail(`preset must be one of: ${Object.keys(CAPTION_STYLES).join(', ')}`);
    Object.assign(st, pr, { preset: input.preset });
  }
  const m = oneOf(input.mode, CAPTION_MODES, 'mode'); if (m) st.mode = m;
  for (const [k, min, max] of [['size', 8, 400], ['y', 0, 1], ['outline', 0, 40], ['maxWords', 1, 12]]) {
    const v = num(input[k], k, min, max); if (v !== undefined) st[k] = k === 'maxWords' ? Math.round(v) : r3(v);
  }
  for (const k of ['color', 'highlightColor', 'outlineColor', 'boxColor']) { const v = color(input[k], k); if (v) st[k] = v; }
  for (const k of ['uppercase', 'box', 'bold']) { const v = bool(input[k]); if (v !== undefined) st[k] = v; }
  const f = font(input.font); if (f) st.font = f;
  return st;
}
const DEFAULT_CAPTION = { preset: 'classic', ...CAPTION_STYLES.classic, highlightColor: '#ffde00', outlineColor: '#000000', boxColor: '#000000', bold: true, box: false };

// ---------- Reel styles ----------
// A style is a saved look: canvas, clip defaults, title text style, caption style, music mix,
// and optional intro / outro clips and a logo overlay (each with the asset record it uses).
// apply_style restyles the project and stores the defaults in p.style, so later add_clip /
// add_text / add_captions / add_music follow the style too.
export const STYLE_PARTS = ['canvas', 'clips', 'texts', 'captions', 'music', 'intro', 'outro', 'logo'];
const STYLE_KEY = { texts: 'title' };
const TITLE_KEYS = ['style', 'font', 'size', 'color', 'bold', 'italic', 'outline', 'outlineColor', 'shadow', 'shadowColor', 'blur', 'box', 'boxColor', 'animation', 'animationOut', 'x', 'y'];
const CAPTION_KEYS = ['preset', 'mode', 'size', 'y', 'outline', 'maxWords', 'color', 'highlightColor', 'outlineColor', 'boxColor', 'uppercase', 'box', 'bold', 'font'];
const COLOR_INPUT_KEYS = [...COLOR_KEYS.map(([k]) => k), 'filter', 'filterIntensity'];
const MUSIC_KEYS = [['volume', 0, 2], ['fadeIn', 0, 30], ['fadeOut', 0, 30], ['duck', 0, 1]];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));
const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));

// {type, duration} or a bare type string. Type 'none' is kept: it means "remove" when applied.
function timedSpec(v, dur, list, name) {
  if (v === undefined || v === null || v === '') return undefined;
  const type = oneOf(typeof v === 'string' ? v : v.type, list, name) ?? fail(`${name} needs a type: ${list.join(', ')}`);
  const d = num(dur ?? (typeof v === 'object' ? v.duration : undefined), `${name} duration`, 0.1, 5) ?? 0.5;
  return { type, duration: r3(d) };
}

function clipStyle(src) {
  const o = {};
  const f = oneOf(src.fit, FITS, 'clips.fit'); if (f) o.fit = f;
  const tr = timedSpec(src.transition, src.transitionDuration, TRANSITIONS, 'clips.transition'); if (tr) o.transition = tr;
  for (const k of ['animIn', 'animOut']) { const a = timedSpec(src[k], src[`${k}Duration`], CLIP_ANIMS, `clips.${k}`); if (a) o[k] = a; }
  const col = colorFrom({}, { ...(src.color || {}), ...pick(src, COLOR_INPUT_KEYS) }, 'clips.'); if (col) o.color = col;
  if (src.imageMotion) {
    const m = src.imageMotion;
    const preset = oneOf(typeof m === 'string' ? m : m.preset, MOTIONS, 'clips.imageMotion');
    const mi = num(src.imageMotionIntensity ?? m.intensity, 'clips.imageMotionIntensity', 0.02, 0.6);
    if (preset) o.imageMotion = { preset, intensity: r3(mi ?? 0.15) };
  }
  return o;
}

const SAFE_FILE = /^[\w.-]+$/;
// Intro / outro clip or logo overlay saved with the asset it shows.
function styleItem(v, kind, name) {
  const a = v?.asset;
  if (!a || typeof a.file !== 'string' || !SAFE_FILE.test(a.file) || !['video', 'image'].includes(a.type)) fail(`${name} needs a video or image from the media library`);
  const item = structuredClone(v[kind]);
  if (!item || typeof item !== 'object') fail(`${name} is missing its ${kind} settings`);
  const rec = structuredClone(a);
  if (typeof rec.id !== 'string' || !/^[\w-]+$/.test(rec.id)) rec.id = uid(a.type === 'image' ? 'img' : 'vid');
  delete item.id; delete item.styleRole;
  item.assetId = rec.id;
  return { asset: rec, [kind]: item };
}

// Validate a style (from save_style input, a stored file, or a built-in) into its canonical shape.
export function normalizeStyle(input = {}) {
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) fail('name is required');
  const st = { name };
  if (input.description) st.description = String(input.description).slice(0, 300);
  if (input.canvas) {
    const cv = input.canvas, c = {};
    if (cv.aspect !== undefined) { if (!ASPECTS[cv.aspect]) fail(`canvas.aspect must be one of ${Object.keys(ASPECTS).join(', ')}`); c.aspect = cv.aspect; }
    const fps = num(cv.fps, 'canvas.fps', 10, 60); if (fps) c.fps = Math.round(fps);
    const bg = color(cv.background, 'canvas.background'); if (bg) c.background = bg;
    if (Object.keys(c).length) st.canvas = c;
  }
  if (input.clips) { const c = clipStyle(input.clips); if (Object.keys(c).length) st.clips = c; }
  if (input.title) {
    const t = {};
    applyText(t, pick(input.title, TITLE_KEYS), false);
    if (Object.keys(t).length) st.title = t;
  }
  if (input.captions) { const c = captionStyle({}, pick(input.captions, CAPTION_KEYS)); if (Object.keys(c).length) st.captions = c; }
  if (input.music) {
    const m = {};
    for (const [k, min, max] of MUSIC_KEYS) { const v = num(input.music[k], `music.${k}`, min, max); if (v !== undefined) m[k] = r3(v); }
    if (Object.keys(m).length) st.music = m;
  }
  for (const k of ['intro', 'outro']) if (input[k]) st[k] = styleItem(input[k], 'clip', k);
  if (input.logo) st.logo = styleItem(input.logo, 'overlay', 'logo');
  return st;
}

// Raw style input captured from a project (feed it to normalizeStyle). Intro/outro/logo come from
// the given ids, or from items an earlier apply_style added.
export function styleFromProject(p, { titleTextId, introClipId, outroClipId, logoOverlayId } = {}) {
  const s = { canvas: pick(p.settings, ['aspect', 'fps', 'background']) };
  const body = p.clips.filter((c) => !c.styleRole);
  if (body[0]) {
    const c0 = body[0];
    const c = { fit: c0.fit || 'contain', ...pick(c0, ['color', 'animIn', 'animOut']) };
    const withTr = p.clips.find((x, i) => i > 0 && !x.styleRole && x.transition?.type && x.transition.type !== 'none');
    if (withTr) c.transition = withTr.transition;
    else if (body.length > 1) c.transition = 'none';
    const img = body.find((x) => p.assets[x.assetId]?.type === 'image' && x.motion);
    if (img) c.imageMotion = img.motion;
    s.clips = c;
  }
  const t = titleTextId ? p.texts[findIn(p.texts, titleTextId, 'text')] : p.texts[0];
  if (t) s.title = pick(t, TITLE_KEYS);
  if (p.captions) s.captions = pick(p.captions.style, CAPTION_KEYS);
  const m = p.music.find((x) => x.role === 'music');
  if (m) s.music = { ...pick(m, ['volume', 'fadeIn', 'fadeOut']), duck: m.duck ?? 0 };
  for (const [role, id] of [['intro', introClipId], ['outro', outroClipId]]) {
    const c = id ? p.clips[findClip(p, id)] : p.clips.find((x) => x.styleRole === role);
    if (c) s[role] = { asset: p.assets[c.assetId], clip: c };
  }
  const o = logoOverlayId ? p.overlays[findIn(p.overlays, logoOverlayId, 'overlay')] : p.overlays.find((x) => x.styleRole === 'logo');
  if (o) s.logo = { asset: p.assets[o.assetId], overlay: o };
  return s;
}

// Ready-made styles, always available (not editable or deletable).
export const BUILTIN_STYLES = [
  {
    id: 'builtin_bold_reel', name: 'Bold reel', description: 'Punchy: full-frame clips, hard cuts with a zoom pop, big yellow-on-black titles, one-word-at-a-time highlight captions, music ducked under speech.',
    canvas: { aspect: '9:16', fps: 30 },
    clips: { fit: 'cover', transition: 'none', animIn: { type: 'zoom_out', duration: 0.3 }, color: { contrast: 1.1, saturation: 1.15 }, imageMotion: { preset: 'zoom_in', intensity: 0.15 } },
    title: { style: 'bold_title', size: 100, y: 0.15, color: '#ffde00', animation: 'pop', animationOut: 'fade' },
    captions: { preset: 'highlight' },
    music: { volume: 0.5, fadeIn: 0, fadeOut: 1, duck: 0.6 },
  },
  {
    id: 'builtin_clean_minimal', name: 'Clean minimal', description: 'Calm and tidy: blurred-background framing, soft dissolves, small white titles that fade, boxed captions, quiet music.',
    canvas: { aspect: '9:16', fps: 30 },
    clips: { fit: 'blur', transition: { type: 'dissolve', duration: 0.4 }, imageMotion: { preset: 'zoom_in', intensity: 0.08 } },
    title: { style: 'plain', size: 64, y: 0.12, color: '#ffffff', shadow: 2, shadowColor: '#000000', bold: false, animation: 'fade', animationOut: 'fade' },
    captions: { preset: 'boxed', size: 52 },
    music: { volume: 0.4, fadeIn: 0.5, fadeOut: 1.5, duck: 0.5 },
  },
  {
    id: 'builtin_warm_vlog', name: 'Warm vlog', description: 'Friendly travel/vlog look: warm film color with a light vignette, fades, sticker titles that slide up, karaoke captions, slow zoom on photos.',
    canvas: { aspect: '9:16', fps: 30 },
    clips: { fit: 'cover', transition: { type: 'fade', duration: 0.5 }, color: { filter: 'warm', filterIntensity: 0.6, vignette: 0.25 }, imageMotion: { preset: 'zoom_in', intensity: 0.12 } },
    title: { style: 'sticker', size: 72, y: 0.18, animation: 'slideup', animationOut: 'fade' },
    captions: { preset: 'karaoke' },
    music: { volume: 0.5, fadeIn: 1, fadeOut: 2, duck: 0.5 },
  },
].map((s) => ({ ...normalizeStyle(s), id: s.id, builtin: true }));

export function describeStyle(st) {
  const parts = [];
  if (st.canvas) parts.push(`canvas ${[st.canvas.aspect, st.canvas.fps && `${st.canvas.fps}fps`, st.canvas.background].filter(Boolean).join(' ')}`);
  if (st.clips) {
    const c = st.clips, x = [];
    if (c.fit) x.push(`fit ${c.fit}`);
    if (c.transition) x.push(c.transition.type === 'none' ? 'hard cuts' : `${c.transition.type} ${c.transition.duration}s`);
    if (c.animIn) x.push(`in ${c.animIn.type}`);
    if (c.animOut) x.push(`out ${c.animOut.type}`);
    if (c.color) x.push(describeColor(c.color).replace(/^, color: /, ''));
    if (c.imageMotion) x.push(`photos ${c.imageMotion.preset}`);
    parts.push(`clips: ${x.join(', ')}`);
  }
  if (st.title) parts.push(`titles: ${Object.entries(st.title).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (st.captions) parts.push(`captions: ${st.captions.preset || st.captions.mode || 'custom'}${st.captions.font ? ` "${st.captions.font}"` : ''}`);
  if (st.music) parts.push(`music: ${Object.entries(st.music).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const k of ['intro', 'outro']) if (st[k]) parts.push(`${k} "${st[k].asset.name}" ${fmtT(clipDuration(st[k].clip))}s`);
  if (st.logo) parts.push(`logo "${st.logo.asset.name}"`);
  return parts.join('; ');
}

// Add an asset record to the project unless the same media file is already there. Returns its id.
function ensureAsset(p, rec) {
  const have = Object.values(p.assets).find((a) => a.file === rec.file);
  if (have) return have.id;
  const id = p.assets[rec.id] ? uid(rec.type === 'image' ? 'img' : rec.type === 'audio' ? 'aud' : 'vid') : rec.id;
  p.assets[id] = { ...structuredClone(rec), id };
  return id;
}

// Clip defaults of a style applied to clip c at track index i.
function styleClip(p, c, i, cs) {
  if (!cs) return;
  if (cs.fit) c.fit = cs.fit;
  if (cs.color) c.color = structuredClone(cs.color);
  for (const k of ['animIn', 'animOut']) if (cs[k]) { if (cs[k].type === 'none') delete c[k]; else c[k] = { ...cs[k] }; }
  if (cs.transition && i > 0) c.transition = { ...cs.transition };
  if (cs.imageMotion && cs.imageMotion.preset !== 'none' && !c.motion && p.assets[c.assetId]?.type === 'image') c.motion = { ...cs.imageMotion };
}

// ---------- Templates ----------
// A template is a project skeleton whose main-track clips are numbered slots (length, speed,
// transform, color, effects, keyframes, transition kept; media removed). Titles, overlays, music
// and markers stay as they are. fillTemplate puts new media into the slots.
export function makeTemplate(p, { name, description, slotClipIds, keepMusic = true, keepTexts = true } = {}) {
  const nm = String(name ?? '').trim().slice(0, 80);
  if (!nm) fail('name is required');
  const slotIds = Array.isArray(slotClipIds) && slotClipIds.length
    ? new Set(slotClipIds.map((id) => p.clips[findClip(p, id)].id))
    : new Set(p.clips.filter((c) => !c.styleRole).map((c) => c.id));
  if (!slotIds.size) fail('The video track has no clips to turn into template slots. Build the edit first.');
  const L = layout(p);
  const slots = [];
  const clips = p.clips.map((c, i) => {
    const x = structuredClone(c);
    if (!slotIds.has(c.id)) return x;
    const a = p.assets[c.assetId];
    x.slot = slots.length + 1;
    x.slotDuration = L.clips[i].duration;
    x.assetId = null; x.in = 0; x.out = r3(x.slotDuration * (x.speed || 1));
    delete x.regions; // they belong to the old footage
    slots.push({ slot: x.slot, start: L.clips[i].start, duration: x.slotDuration, type: a?.type, was: a?.name });
    return x;
  });
  const music = bool(keepMusic) === false ? [] : structuredClone(p.music);
  const markers = (p.markers || []).filter((m) => music.length || m.kind !== 'beat');
  const texts = bool(keepTexts) === false ? [] : structuredClone(p.texts);
  const overlays = structuredClone(p.overlays);
  const used = new Set([...clips.map((c) => c.assetId), ...overlays.map((o) => o.assetId), ...music.map((m) => m.assetId)]);
  const assets = Object.fromEntries([...used].filter((id) => id && p.assets[id]).map((id) => [id, structuredClone(p.assets[id])]));
  let style = p.style ? structuredClone(p.style) : null;
  if (p.captions && !style?.captions) style = { ...(style || { name: nm }), captions: structuredClone(p.captions.style) };
  const tpl = { name: nm, settings: structuredClone(p.settings), clips, overlays, texts, music, markers, assets, slots, duration: L.duration };
  if (description) tpl.description = String(description).slice(0, 300);
  if (style) tpl.style = style;
  return tpl;
}

export function describeTemplate(tpl) {
  const slots = tpl.slots.map((s) => `  slot ${s.slot}: ${fmtT(s.duration)}s at ${fmtT(s.start)}s${s.was ? ` (was ${s.type} "${s.was}")` : ''}`).join('\n');
  const texts = tpl.texts.map((t, i) => `  text ${i + 1}: "${t.text}" ${fmtT(t.start)}-${fmtT(t.end)}s`).join('\n');
  const extra = [
    tpl.music.length && `${tpl.music.length} audio item(s): ${tpl.music.map((m) => `"${tpl.assets[m.assetId]?.name}"`).join(', ')}`,
    tpl.overlays.length && `${tpl.overlays.length} overlay(s)`,
    tpl.markers?.some((m) => m.kind === 'beat') && 'beat markers',
    tpl.style && `style "${tpl.style.name}"`,
  ].filter(Boolean).join(', ');
  return `${tpl.slots.length} slots, ${fmtT(tpl.duration)}s, ${tpl.settings.aspect}${extra ? `; ${extra}` : ''}\n${slots}${texts ? `\n${texts}` : ''}`;
}

// Fill a template into project p (normally a fresh project that has the media library).
// input: { assetIds: [...] | slots: [{assetId, in}], texts: [string|null], name }.
// Without media it uses the project's videos/photos in library order, reusing them if there are fewer than slots.
export function fillTemplate(p, tpl, input = {}) {
  const fixedFiles = new Set(Object.values(tpl.assets).map((a) => a.file));
  let fills;
  if (Array.isArray(input.slots) && input.slots.length) fills = input.slots.map((s) => (typeof s === 'string' ? { assetId: s } : s || {}));
  else if (Array.isArray(input.assetIds) && input.assetIds.length) fills = input.assetIds.map((assetId) => ({ assetId }));
  else {
    const lib = Object.values(p.assets).filter((a) => (a.type === 'video' || a.type === 'image') && !fixedFiles.has(a.file));
    if (!lib.length) fail('No videos or photos to fill the template with. Import media first, or pass assetIds.');
    fills = tpl.slots.map((_, i) => ({ assetId: lib[i % lib.length].id }));
  }
  const n = tpl.slots.length;
  if (fills.length < n) fail(`Template "${tpl.name}" has ${n} slots but got ${fills.length} clip(s). Pass one assetId per slot, in order (repeat an id to reuse a clip).`);
  fills.slice(0, n).forEach((f, i) => {
    const a = p.assets[f.assetId];
    if (!a || !['video', 'image'].includes(a.type)) fail(`Slot ${i + 1}: ${f.assetId} is not a video or image in the media library. Assets: ${Object.values(p.assets).filter((x) => x.type !== 'audio').map((x) => x.id).join(', ') || 'none'}`);
  });
  const remap = Object.fromEntries(Object.entries(tpl.assets).map(([id, rec]) => [id, ensureAsset(p, rec)]));
  const re = (x) => ({ ...structuredClone(x), assetId: remap[x.assetId] ?? x.assetId });
  p.settings = structuredClone(tpl.settings);
  p.overlays = tpl.overlays.map(re);
  p.music = tpl.music.map(re);
  p.texts = structuredClone(tpl.texts);
  p.markers = structuredClone(tpl.markers || []);
  p.captions = null;
  if (tpl.style) p.style = structuredClone(tpl.style); else delete p.style;
  const notes = [];
  p.clips = tpl.clips.map((c0) => {
    if (!c0.slot) return re(c0);
    const c = structuredClone(c0);
    const f = fills[c.slot - 1], a = p.assets[f.assetId];
    const sp = c.speed || 1, need = c.slotDuration * sp;
    c.assetId = a.id;
    if (a.type === 'image') { c.in = 0; c.out = r3(need); } else {
      let i0 = num(f.in, `slot ${c.slot} in`, 0, a.duration) ?? 0;
      if (i0 + need > a.duration) i0 = Math.max(0, a.duration - need);
      c.in = r3(i0); c.out = r3(Math.min(a.duration, i0 + need));
      if (c.out - c.in < need - 0.01) notes.push(`slot ${c.slot} is ${fmtT((c.out - c.in) / sp)}s instead of ${fmtT(c.slotDuration)}s ("${a.name}" is too short)`);
    }
    const dur = (c.out - c.in) / sp;
    if (c.effects) {
      c.effects = c.effects.filter((e) => e.from < dur - 0.05).map((e) => ({ ...e, to: r3(Math.min(e.to, dur)) }));
      if (!c.effects.length) delete c.effects;
    }
    delete c.slot; delete c.slotDuration;
    return c;
  });
  if (Array.isArray(input.texts)) {
    input.texts.forEach((s, i) => {
      if (s === null || s === undefined || s === '') return;
      if (!p.texts[i]) fail(`texts[${i}]: the template has only ${p.texts.length} text(s)`);
      p.texts[i].text = String(s);
    });
  }
  clampAll(p);
  p.name = String(input.name || tpl.name).trim().slice(0, 120);
  if (fills.length > n) notes.push(`${fills.length - n} extra clip(s) not used`);
  return `Filled template "${tpl.name}": ${n} slots, ${fmtT(layout(p).duration)}s.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`;
}

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
    const outro = p.clips.findIndex((c) => c.styleRole === 'outro');
    const pos = position === undefined ? (outro >= 0 ? outro : p.clips.length) : Math.max(0, Math.min(p.clips.length, Math.round(num(position, 'position')) - 1));
    styleClip(p, clip, pos, p.style?.clips);
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
    // A zoom/pan restarts on each half; that is how CapCut behaves too.
    splitTimed(c, second, t - lc.start);
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

  set_clip(p, input) {
    const { clipId, speed, volume, fit, motion, motionIntensity } = input;
    const c = p.clips[findClip(p, clipId)];
    const f = oneOf(fit, FITS, 'fit'); if (f) c.fit = f;
    const s = num(speed, 'speed', 0.25, 4); if (s !== undefined) c.speed = s;
    const v = num(volume, 'volume', 0, 2); if (v !== undefined) c.volume = v;
    applyTransform(c, input);
    const mo = oneOf(motion, MOTIONS, 'motion');
    const mi = num(motionIntensity, 'motionIntensity', 0.02, 0.6);
    if (mo === 'none') delete c.motion;
    else if (mo) c.motion = { preset: mo, intensity: mi ?? c.motion?.intensity ?? 0.15 };
    else if (mi !== undefined) { if (!c.motion) fail('Set motion (e.g. zoom_in) before motionIntensity'); c.motion.intensity = mi; }
    for (const [k, dk] of [['animIn', 'animInDuration'], ['animOut', 'animOutDuration']]) {
      const ty = oneOf(input[k], CLIP_ANIMS, k);
      const d = num(input[dk], dk, 0.1, 5);
      if (ty === 'none') delete c[k];
      else if (ty) c[k] = { type: ty, duration: r3(d ?? c[k]?.duration ?? 0.5) };
      else if (d !== undefined) { if (!c[k]) fail(`Set ${k} (e.g. fade) before ${dk}`); c[k].duration = r3(d); }
    }
    clampAll(p);
    return `Updated ${c.id}: speed ${c.speed}x, volume ${c.volume}, fit ${c.fit || 'contain'}${describeTransform(c.transform)}${c.motion ? `, motion ${c.motion.preset} ${c.motion.intensity}` : ''}${describeAnims(c)}`;
  },

  set_transition(p, { clipId, type, duration }) {
    const i = findClip(p, clipId);
    if (!TRANSITIONS.includes(type)) fail(`Unknown transition ${type}. Options: ${TRANSITIONS.join(', ')}`);
    if (i === 0 && type !== 'none') fail('The first clip has no previous clip to transition from. Use a fade-in text or pick clip #2+.');
    p.clips[i].transition = { type, duration: num(duration, 'duration', 0.1, 5) ?? 0.5 };
    clampTransition(p, i);
    return `Transition into ${p.clips[i].id}: ${type} ${p.clips[i].transition.duration}s`;
  },

  // Swap the media under a clip, keeping its timing, transform, motion, transition and regions.
  replace_clip_asset(p, { clipId, assetId, in: tin, out, clearRegions }) {
    const c = p.clips[findClip(p, clipId)];
    const a = asset(p, assetId, ['video', 'image']);
    const max = a.type === 'image' ? 3600 : a.duration;
    const ni = num(tin, 'in', 0, max) ?? c.in;
    const no = num(out, 'out', 0, max) ?? c.out;
    if (no > max + 0.001) fail(`Clip uses source ${c.in}-${c.out}s but "${a.name}" is only ${a.duration.toFixed(2)}s long. Pass in/out that fit inside it.`);
    if (no - ni < 0.05) fail('out must be at least 0.05s after in');
    const old = p.assets[c.assetId];
    c.assetId = a.id; c.in = r3(ni); c.out = r3(no);
    if (bool(clearRegions)) delete c.regions;
    else if (c.regions && a.type === 'image') c.regions = c.regions.filter((r) => r.mode !== 'patch');
    if (c.regions && !c.regions.length) delete c.regions;
    clampAll(p);
    const kept = c.regions?.length ? `; kept ${c.regions.length} removed region(s)` : '';
    const dims = old?.width && a.width && (old.width / old.height).toFixed(3) !== (a.width / a.height).toFixed(3)
      ? ` Note: aspect changed (${old.width}x${old.height} -> ${a.width}x${a.height}), check crop/regions with look_at_timeline.` : '';
    return `${c.id} now uses "${a.name}" (source ${c.in}-${c.out}s)${kept}.${dims}`;
  },

  // Hide something burned into the source video (subtitle, watermark, logo) on one clip.
  // Box and times are in SOURCE terms, so the region follows trims, splits and speed changes.
  remove_region(p, input) {
    const c = p.clips[findClip(p, input.clipId)];
    const a = p.assets[c.assetId];
    const r = { id: uid('reg') };
    for (const k of ['x', 'y']) r[k] = r3(num(input[k], k, 0, 1) ?? fail(`${k} is required (fraction of the source frame, 0-1)`));
    for (const k of ['w', 'h']) r[k] = r3(num(input[k], k, 0.005, 1) ?? fail(`${k} is required (fraction of the source frame)`));
    if (r.x + r.w > 1.0001 || r.y + r.h > 1.0001) fail('The box must stay inside the frame: x + w <= 1 and y + h <= 1');
    const max = a.type === 'image' ? 3600 : a.duration;
    r.from = r3(num(input.from, 'from', 0, max) ?? c.in);
    r.to = r3(num(input.to, 'to', 0, max) ?? c.out);
    if (r.to <= r.from) fail('to must be after from (source seconds)');
    r.mode = oneOf(input.mode, REGION_MODES, 'mode') ?? 'fill';
    if (r.mode === 'patch') {
      if (a.type !== 'video') fail('mode patch needs a video clip; use mode fill on images');
      const at = num(input.patchAt, 'patchAt', 0, Math.max(0, a.duration - 0.05));
      if (at === undefined) fail('mode patch needs patchAt: a source time where this box shows a clean background (e.g. just before or after the text, in the same shot)');
      if (at >= r.from && at <= r.to) fail(`patchAt ${at}s is inside ${r.from}-${r.to}s, so it would copy the text itself. Pick a clean frame outside that range.`);
      r.patchAt = r3(at);
      r.feather = r3(num(input.feather, 'feather', 0, 0.5) ?? 0.15);
    }
    (c.regions ||= []).push(r);
    const outside = r.to <= c.in || r.from >= c.out ? ` Note: the clip only uses source ${c.in}-${c.out}s, so this is not visible yet.` : '';
    return `Added region ${r.id} on ${c.id}: ${describeRegion(r)}.${outside} Check it with look_at_timeline.`;
  },

  delete_region(p, { regionId, clipId }) {
    const hits = findRegions(p, regionId, clipId);
    for (const { clip, index } of hits.reverse()) {
      clip.regions.splice(index, 1);
      if (!clip.regions.length) delete clip.regions;
    }
    return `Deleted region ${regionId}${hits.length > 1 ? ` from ${hits.length} clips` : ''}`;
  },

  // Color adjust + filter look on a clip or overlay.
  set_color(p, input) {
    const { item } = timedTarget(p, input);
    const c = colorFrom(bool(input.reset) ? {} : item.color, input);
    if (c) item.color = c; else delete item.color;
    return `Color of ${item.id}: ${describeColor(item.color).replace(/^, color: /, '') || 'original'}`;
  },

  add_effect(p, input) {
    if (!input.clipId) fail('clipId is required (effects go on main-track clips)');
    const { item: c, start, dur } = timedTarget(p, { clipId: input.clipId });
    const type = oneOf(input.type, EFFECTS, 'type') ?? fail(`type is required: ${EFFECTS.join(', ')}`);
    const s = num(input.start, 'start', 0) ?? start;
    const e = num(input.end, 'end', 0) ?? start + dur;
    const from = Math.max(0, s - start), to = Math.min(dur, e - start);
    if (to - from < 0.05) fail(`start/end must overlap the clip (timeline ${fmtT(start)}-${fmtT(start + dur)}s) by at least 0.05s`);
    const fx = { id: uid('fx'), type, from: r3(from), to: r3(to), intensity: r3(num(input.intensity, 'intensity', 0, 1) ?? 0.5) };
    if (type === 'shake' || type === 'zoom_pulse') fx.rate = r3(num(input.rate, 'rate', 0.1, 20) ?? (type === 'shake' ? 8 : 2));
    (c.effects ||= []).push(fx);
    return `Added effect ${fx.id} ${type} on ${c.id} at ${fmtT(start + fx.from)}-${fmtT(start + fx.to)}s (intensity ${fx.intensity})`;
  },

  delete_effect(p, { effectId }) {
    let n = 0;
    for (const c of p.clips) {
      const before = c.effects?.length || 0;
      if (!before) continue;
      c.effects = c.effects.filter((e) => e.id !== effectId);
      n += before - c.effects.length;
      if (!c.effects.length) delete c.effects;
    }
    if (!n) fail(`No effect ${effectId}. Effects: ${p.clips.flatMap((c) => (c.effects || []).map((e) => e.id)).join(', ') || 'none'}`);
    return `Deleted effect ${effectId}`;
  },

  // Animate a property over time. keyframes: [{t (timeline seconds), value}]; [] removes the animation.
  set_keyframes(p, input) {
    const { kind, item, start, dur } = timedTarget(p, input);
    const ranges = KEYFRAME_PROPS[kind];
    const prop = input.property;
    if (!ranges[prop]) fail(`property must be one of: ${Object.keys(ranges).join(', ')} (for ${kind}s)`);
    const kfs = input.keyframes;
    if (!Array.isArray(kfs)) fail('keyframes must be an array of {t, value} with t in timeline seconds; [] removes the animation');
    if (!kfs.length) {
      if (item.keyframes) { delete item.keyframes[prop]; if (!Object.keys(item.keyframes).length) delete item.keyframes; }
      return `Removed ${prop} keyframes from ${item.id}`;
    }
    const byT = new Map();
    kfs.forEach((k, i) => {
      const t = num(k?.t ?? k?.time, `keyframes[${i}].t`, start - 0.01, start + dur + 0.01);
      if (t === undefined) fail(`keyframes[${i}].t is required: timeline seconds within ${fmtT(start)}-${fmtT(start + dur)}s`);
      const v = num(k.value ?? k.v, `keyframes[${i}].value`, ...ranges[prop]);
      if (v === undefined) fail(`keyframes[${i}].value is required`);
      byT.set(r3(Math.min(dur, Math.max(0, t - start))), r3(v));
    });
    const points = [...byT].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
    const easing = oneOf(input.easing, ['ease', 'linear'], 'easing') ?? 'ease';
    (item.keyframes ||= {})[prop] = { easing, points };
    const note = kind === 'overlay' && ['x', 'y', 'scale'].includes(prop) && item.fit !== 'free' ? ` Note: ${prop} only applies with fit free.` : '';
    return `Keyframed ${prop} of ${item.id}: ${points.map((q) => `${fmtT(start + q.t)}s=${q.v}`).join(', ')} (${easing}).${note}`;
  },

  add_markers(p, { times, kind, label, replace }) {
    if (!Array.isArray(times) || !times.length) fail('times must be a non-empty array of timeline seconds');
    const k = oneOf(kind, ['beat', 'note'], 'kind') ?? 'note';
    p.markers ||= [];
    if (bool(replace)) p.markers = p.markers.filter((m) => m.kind !== k);
    for (const [i, t] of times.entries()) {
      const mk = { id: uid('mk'), t: r3(num(t, `times[${i}]`, 0)), kind: k };
      if (label) mk.label = String(label).slice(0, 60);
      p.markers.push(mk);
    }
    p.markers.sort((a, b) => a.t - b.t);
    return `Added ${times.length} ${k} marker(s)${bool(replace) ? ` (replaced old ${k} markers)` : ''}`;
  },

  delete_markers(p, { kind, markerIds }) {
    const before = (p.markers || []).length;
    const ids = Array.isArray(markerIds) ? new Set(markerIds) : null;
    p.markers = (p.markers || []).filter((m) => !(ids ? ids.has(m.id) : !kind || m.kind === kind));
    return `Deleted ${before - p.markers.length} marker(s)`;
  },

  // Trim clip out-points so every cut lands on a beat marker (every N beats).
  fit_clips_to_beats(p, input) {
    const every = Math.round(num(input.every, 'every', 1, 64) ?? 1);
    const skip = Math.round(num(input.skipBeats, 'skipBeats', 0, 1000) ?? 0);
    const beats = (p.markers || []).filter((m) => m.kind === 'beat').map((m) => m.t).sort((a, b) => a - b);
    if (beats.length < 2) fail('Need beat markers. Run mark_beats on the music first (or add_markers with kind beat).');
    if (!p.clips.length) fail('The video track is empty');
    const grid = beats.filter((_, k) => k >= skip && (k - skip) % every === 0);
    let notes = [], cut = 0;
    const pass = () => {
      notes = []; cut = 0;
      let s = 0;
      p.clips.forEach((c, i) => {
        const next = p.clips[i + 1];
        const ov = next?.transition && next.transition.type !== 'none' ? next.transition.duration : 0;
        const a = p.assets[c.assetId];
        const maxLen = a.type === 'image' ? 3600 : (a.duration - c.in) / (c.speed || 1);
        const g = grid.find((x) => x > s + 0.2);
        if (g === undefined) { notes.push(`#${i + 1} kept (no beat left after ${fmtT(s)}s)`); s += clipDuration(c) - ov; return; }
        if (g - s + ov > maxLen + 1e-6) { notes.push(`#${i + 1} kept: its source is too short to reach the beat at ${fmtT(g)}s`); s += clipDuration(c) - ov; return; }
        c.out = r3(c.in + (g - s + ov) * (c.speed || 1));
        s = g; cut++;
      });
    };
    pass(); clampAll(p); pass(); clampAll(p); // second pass: transitions may have been clamped
    const L = layout(p);
    return `Cut ${cut} of ${p.clips.length} clips on the beat (every ${every} beat${every > 1 ? 's' : ''}); video is now ${fmtT(L.duration)}s.${notes.length ? ` ${notes.join('; ')}.` : ''}`;
  },

  add_overlay(p, input) {
    const a = asset(p, input.assetId, ['video', 'image']);
    const o = {
      id: uid('ov'), assetId: a.id, track: 1, start: 0, in: 0, out: 0, speed: 1,
      fit: 'free', x: 0.5, y: 0.5, scale: 0.4, rotate: 0, opacity: 1, volume: a.type === 'video' && a.hasAudio ? 1 : 0, animation: 'none',
    };
    if (input.duration === undefined && input.end === undefined && input.out === undefined) {
      o.out = a.type === 'image' ? 3 : a.duration;
    }
    applyOverlay(o, input, a);
    if (o.out <= o.in) fail('Overlay out must be greater than in');
    p.overlays.push(o);
    return `Added overlay ${o.id} "${a.name}" ${o.start}-${r3(o.start + overlayDuration(o))}s on track ${o.track}`;
  },

  set_overlay(p, input) {
    const o = p.overlays[findIn(p.overlays, input.overlayId, 'overlay')];
    applyOverlay(o, input, p.assets[o.assetId]);
    return `Updated overlay ${o.id}: ${o.start}-${r3(o.start + overlayDuration(o))}s, ${o.fit === 'free' ? `center (${o.x},${o.y}) width ${o.scale}` : `fit ${o.fit}`}, opacity ${o.opacity}`;
  },

  delete_overlay(p, { overlayId }) {
    const [o] = p.overlays.splice(findIn(p.overlays, overlayId, 'overlay'), 1);
    return `Deleted overlay ${o.id}`;
  },

  add_text(p, input) {
    if (!input.text) fail('text is required');
    const L = layout(p);
    const s = num(input.start, 'start', 0) ?? 0;
    const e = num(input.end, 'end', 0) ?? Math.max(s + 3, Math.min(L.duration, s + 3));
    if (e <= s) fail('end must be after start');
    const t = { id: uid('text'), start: r3(s), end: r3(e) };
    // The project style's title look is the default; an explicit style preset or field wins.
    const base = !input.style && p.style?.title;
    applyText(t, base ? { ...base, ...defined(input) } : input, true);
    p.texts.push(t);
    return `Added text ${t.id} "${t.text}" ${t.start}-${t.end}s`;
  },

  update_text(p, { textId, ...rest }) {
    const t = p.texts[findIn(p.texts, textId, 'text')];
    for (const k of ['start', 'end']) { const v = num(rest[k], k, 0); if (v !== undefined) t[k] = r3(v); }
    applyText(t, rest, false);
    if (t.end <= t.start) fail('end must be after start');
    return `Updated text ${t.id}`;
  },

  delete_text(p, { textId }) {
    const [t] = p.texts.splice(findIn(p.texts, textId, 'text'), 1);
    return `Deleted text ${t.id}`;
  },

  // Replace all captions with lines built from timed words (timeline seconds).
  set_captions(p, input) {
    const words = input.words;
    if (!Array.isArray(words) || !words.length) fail('No words to caption. Is there speech in the clips? Run transcribe_asset / get_transcript to check.');
    for (const w of words) {
      if (typeof w.w !== 'string' || !Number.isFinite(+w.start) || !Number.isFinite(+w.end)) fail('words must be [{w, start, end}] with timeline seconds');
    }
    // First captions start from the classic preset; re-captioning keeps the current style unless overridden.
    const base = p.captions?.style || { ...DEFAULT_CAPTION, ...(p.style?.captions || {}) };
    const st = captionStyle(base, { ...input, preset: input.preset ?? (p.captions || p.style?.captions ? undefined : 'classic') });
    const lines = groupWords(words.map((w) => ({ w: w.w, start: +w.start, end: +w.end })), { maxWords: st.maxWords });
    p.captions = { style: st, lines };
    return `Captions: ${lines.length} lines (${words.length} words), style ${st.preset}, mode ${st.mode}`;
  },

  update_captions(p, input) {
    if (!p.captions) fail('No captions yet. Use add_captions first.');
    const { lineId, text, start, end } = input;
    if (lineId) {
      const l = p.captions.lines[findIn(p.captions.lines, lineId, 'caption line')];
      const s = num(start, 'start', 0) ?? l.start, e = num(end, 'end', 0) ?? l.end;
      if (e <= s) fail('end must be after start');
      if (text !== undefined) {
        const ws = String(text).trim().split(/\s+/).filter(Boolean);
        if (!ws.length) fail('text cannot be empty; use delete_captions with lineId to remove a line');
        if (ws.length === l.words.length && s === l.start && e === l.end) ws.forEach((w, i) => { l.words[i].w = w; });
        else { // Spread the new words evenly over the line.
          const step = (e - s) / ws.length;
          l.words = ws.map((w, i) => ({ w, start: r3(s + i * step), end: r3(s + (i + 1) * step) }));
        }
      } else if (s !== l.start || e !== l.end) {
        const k = (e - s) / (l.end - l.start);
        l.words = l.words.map((w) => ({ w: w.w, start: r3(s + (w.start - l.start) * k), end: r3(s + (w.end - l.start) * k) }));
      }
      l.start = r3(s); l.end = r3(e);
    }
    if (CAPTION_KEYS.some((k) => input[k] !== undefined)) {
      const before = p.captions.style.maxWords;
      p.captions.style = captionStyle(p.captions.style, input);
      if (p.captions.style.maxWords !== before) {
        p.captions.lines = groupWords(p.captions.lines.flatMap((l) => l.words), { maxWords: p.captions.style.maxWords });
      }
    }
    return `Captions updated: ${p.captions.lines.length} lines, style ${p.captions.style.preset}, mode ${p.captions.style.mode}`;
  },

  delete_captions(p, { lineId }) {
    if (!p.captions) fail('There are no captions');
    if (lineId) {
      p.captions.lines.splice(findIn(p.captions.lines, lineId, 'caption line'), 1);
      if (!p.captions.lines.length) p.captions = null;
      return `Deleted caption line ${lineId}`;
    }
    p.captions = null;
    return 'Deleted all captions';
  },

  add_music(p, { assetId, start, in: tin, out, volume, fadeIn, fadeOut, role, track, duck }) {
    const a = asset(p, assetId, ['audio', 'video']);
    if (a.type === 'video' && !a.hasAudio) fail('That video has no audio track');
    const rl = oneOf(role, AUDIO_ROLES, 'role') ?? 'music';
    const sm = rl === 'music' ? p.style?.music || {} : {};
    const i0 = num(tin, 'in', 0, a.duration) ?? 0;
    const o = num(out, 'out', 0, a.duration) ?? a.duration;
    if (o <= i0) fail('out must be greater than in');
    const m = {
      id: uid(rl === 'music' ? 'music' : rl), assetId, role: rl,
      track: Math.round(num(track, 'track', 1, 20) ?? (rl === 'music' ? 1 : rl === 'voice' ? 2 : 3)),
      start: num(start, 'start', 0) ?? 0, in: r3(i0), out: r3(o),
      volume: num(volume, 'volume', 0, 2) ?? sm.volume ?? (rl === 'music' ? 0.6 : 1),
      fadeIn: num(fadeIn, 'fadeIn', 0, 30) ?? sm.fadeIn ?? 0, fadeOut: num(fadeOut, 'fadeOut', 0, 30) ?? sm.fadeOut ?? (rl === 'music' ? 1 : 0),
    };
    const dk = num(duck, 'duck', 0, 1) ?? sm.duck; if (dk) m.duck = r3(dk);
    p.music.push(m);
    return `Added ${rl} ${m.id} from "${a.name}" at ${m.start}s on audio track ${m.track}`;
  },

  update_music(p, { musicId, ...rest }) {
    const m = p.music[findIn(p.music, musicId, 'audio item')];
    const lim = { start: [0, 1e6], in: [0, 1e6], out: [0, 1e6], volume: [0, 2], fadeIn: [0, 30], fadeOut: [0, 30], duck: [0, 1] };
    for (const k of Object.keys(lim)) { const v = num(rest[k], k, ...lim[k]); if (v !== undefined) m[k] = r3(v); }
    if (m.duck === 0) delete m.duck;
    const rl = oneOf(rest.role, AUDIO_ROLES, 'role'); if (rl) m.role = rl;
    const tr = num(rest.track, 'track', 1, 20); if (tr !== undefined) m.track = Math.round(tr);
    if (m.out <= m.in) fail('out must be greater than in');
    return `Updated ${m.role} ${m.id}`;
  },

  delete_music(p, { musicId }) {
    const [m] = p.music.splice(findIn(p.music, musicId, 'audio item'), 1);
    return `Deleted ${m.role || 'music'} ${m.id}`;
  },

  set_canvas(p, { aspect, background, fps }) {
    if (aspect) {
      if (!ASPECTS[aspect]) fail(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`);
      p.settings.aspect = aspect;
      [p.settings.width, p.settings.height] = ASPECTS[aspect];
    }
    const bg = color(background, 'background'); if (bg) p.settings.background = bg;
    const f = num(fps, 'fps', 10, 60); if (f) p.settings.fps = Math.round(f);
    return `Canvas: ${p.settings.aspect} ${p.settings.width}x${p.settings.height}, bg ${p.settings.background}, ${p.settings.fps}fps`;
  },

  // Apply a saved or built-in reel style (env.loadStyle resolves styleId) to the project.
  apply_style(p, input) {
    if (!env.loadStyle) fail('Styles are not available here');
    const st = env.loadStyle(input.styleId ?? fail('styleId is required (see list_styles)'));
    let parts = STYLE_PARTS.filter((k) => st[STYLE_KEY[k] || k]);
    const notes = [];
    if (input.parts !== undefined) {
      if (!Array.isArray(input.parts) || !input.parts.length) fail(`parts must be a non-empty array of: ${STYLE_PARTS.join(', ')}`);
      input.parts.forEach((k) => oneOf(k, STYLE_PARTS, 'parts[]'));
      const missing = input.parts.filter((k) => !parts.includes(k));
      if (missing.length) notes.push(`the style has no ${missing.join('/')} settings`);
      parts = parts.filter((k) => input.parts.includes(k));
    }
    if (!parts.length) fail(`Style "${st.name}" has nothing to apply${notes.length ? ` (${notes[0]})` : ''}`);
    const has = (k) => parts.includes(k);
    const done = [];
    if (has('canvas')) { ops.set_canvas(p, st.canvas); done.push('canvas'); }
    for (const role of ['intro', 'outro']) {
      if (!has(role)) continue;
      p.clips = p.clips.filter((c) => c.styleRole !== role);
      const c = { ...structuredClone(st[role].clip), id: uid('clip'), assetId: ensureAsset(p, st[role].asset), styleRole: role };
      if (role === 'intro') p.clips.unshift(c); else p.clips.push(c);
      done.push(role);
    }
    if (p.clips[0]) p.clips[0].transition = { type: 'none', duration: 0.5 };
    if (has('clips')) {
      const body = p.clips.filter((c) => !c.styleRole);
      p.clips.forEach((c, i) => { if (!c.styleRole) styleClip(p, c, i, st.clips); });
      done.push(`${body.length} clip(s)`);
    }
    clampAll(p);
    if (has('texts')) {
      const { x, y, ...look } = st.title; // keep each text where it is
      for (const t of p.texts) { if (!look.style) delete t.style; applyText(t, look, false); }
      done.push(`${p.texts.length} text(s)`);
    }
    if (has('captions') && p.captions) {
      const before = p.captions.style.maxWords;
      p.captions.style = captionStyle(p.captions.style, st.captions);
      if (p.captions.style.maxWords !== before) p.captions.lines = groupWords(p.captions.lines.flatMap((l) => l.words), { maxWords: p.captions.style.maxWords });
      done.push('captions');
    }
    if (has('music')) {
      const items = p.music.filter((m) => m.role === 'music');
      for (const m of items) {
        Object.assign(m, pick(st.music, ['volume', 'fadeIn', 'fadeOut', 'duck']));
        if (!m.duck) delete m.duck;
      }
      done.push(`${items.length} music item(s)`);
    }
    if (has('logo')) {
      p.overlays = p.overlays.filter((o) => o.styleRole !== 'logo');
      const o = { ...structuredClone(st.logo.overlay), id: uid('ov'), assetId: ensureAsset(p, st.logo.asset), styleRole: 'logo', start: 0 };
      // A still logo spans the whole video (re-apply the style after big timeline changes).
      if (p.assets[o.assetId].type === 'image') o.out = r3(o.in + Math.max(0.5, layout(p).duration) * (o.speed || 1));
      p.overlays.push(o);
      done.push('logo');
    }
    const defaults = Object.fromEntries([['clips', 'clips'], ['texts', 'title'], ['captions', 'captions'], ['music', 'music']]
      .filter(([part, key]) => has(part) && st[key]).map(([, key]) => [key, structuredClone(st[key])]));
    p.style = { id: st.id, name: st.name, ...defaults };
    return `Applied style "${st.name}" to ${done.join(', ')}. New clips, texts, captions and music will follow it.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}${has('logo') || has('intro') || has('outro') ? ' Check framing with look_at_timeline.' : ''}`;
  },

  rename_project(p, { name }) {
    if (!name || !String(name).trim()) fail('name is required');
    p.name = String(name).trim().slice(0, 120);
    return `Renamed project to "${p.name}"`;
  },

  clear_timeline(p) {
    p.clips = []; p.texts = []; p.music = []; p.overlays = []; p.captions = null; p.markers = [];
    return 'Cleared timeline (media library kept)';
  },
};

// Ids of every editable item, used by batch_edit to resolve "$N" references.
export function allIds(p) {
  return new Set([...p.clips, ...p.clips.flatMap((c) => [...(c.regions || []), ...(c.effects || [])]), ...(p.markers || []), ...p.overlays, ...p.texts, ...p.music, ...(p.captions?.lines || [])].map((x) => x.id));
}

export { OpError };
