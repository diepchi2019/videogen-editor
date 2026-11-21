// VideoGen editor UI (vanilla JS). The server owns the project; every edit is a tool call.
import { srcAt, speedAt, avgRate, RAMP_PRESETS, reframeTrack, coverPosition } from '/lib/timing.js';
import { kenBurns, zoomAbout, cropBox, vignetteCss, effectsAt, leakCss, GRAIN_URL, drawEffect, textLook, textAnim } from '/preview.js';
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const TRANSITIONS = ['none', 'fade', 'dissolve', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'circleopen', 'circleclose', 'radial', 'zoomin', 'pixelize', 'distance', 'hblur'];

let P = null;      // project
let L = null;      // layout
let jobs = [];
let projects = [];
let styles = [], templates = [];
let sel = null;    // { kind: 'clip'|'overlay'|'text'|'music', id }: the item shown in the inspector
const picked = new Map(); // every selected item: id -> kind (Ctrl/Shift+click adds)
let clipboard = null;     // ids copied with Ctrl+C
let range = null;         // { in, out } timeline seconds marked with I / O, removed with Shift+Delete
let luts = [];
let whisperModel;          // file name of the whisper model the server uses, null when none is installed
let voices = [];           // installed text-to-speech voices [{id, language}] (from /api/state)
let defaultFont = 'Arial'; // the font texts use in the export when they set none (from /api/state)
let captioning = false;
let rec = null;           // voiceover recording in progress
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
let snapOn = store.get('snap') !== 'off';
let time = 0, playing = false, playStart = 0, playFrom = 0;
let pps = 80;      // timeline pixels per second

// ---------- API ----------
async function api(url, body) {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.project) setState(j);
  return j;
}
async function tool(name, input = {}) {
  const r = await api(`/api/tool/${name}`, input);
  if (r.isError || r.error) toast(r.content || r.error);
  return r;
}
function setState(s) {
  const switched = P && s.project.id !== P.id;
  P = s.project; L = s.layout;
  if (s.jobs) jobs = s.jobs;
  if (s.styles) styles = s.styles;
  if (s.templates) templates = s.templates;
  if (s.projects) projects = s.projects;
  if (s.luts) luts = s.luts;
  if ('whisperModel' in s) whisperModel = s.whisperModel;
  if (s.voices) voices = s.voices;
  if (s.defaultFont) defaultFont = s.defaultFont;
  else if (switched) fetch('/api/state').then((r) => r.json()).then((j) => { projects = j.projects || projects; renderProjects(); });
  if (sel && !findSel()) sel = null;
  const alive = new Set([...P.clips, ...P.texts, ...P.overlays, ...P.music].map((x) => x.id));
  for (const id of [...picked.keys()]) if (!alive.has(id)) picked.delete(id);
  if (switched) { picked.clear(); range = null; }
  renderAll();
}
const isSel = (id) => picked.has(id);
const findSel = () => sel && (sel.kind === 'clip' ? L.clips.find((c) => c.id === sel.id)
  : sel.kind === 'text' ? P.texts.find((t) => t.id === sel.id) : sel.kind === 'overlay' ? P.overlays.find((o) => o.id === sel.id)
    : P.music.find((m) => m.id === sel.id));
const ovDur = (o) => (o.out - o.in) / (o.speed || 1);
function toast(msg) { addMsg('error', String(msg)); }

// ---------- Preview helpers (browser approximations of what ffmpeg renders) ----------
// Reframe preview: object-position puts the subject in the middle of a cover fit; with zoom > 1 the
// element is also scaled and shifted so the subject stays centered, clamped so the frame stays filled.
function reframeCss(c, a, lt, fit) {
  if (fit !== 'cover' || !c.reframe?.points?.length) return { pos: '50% 50%', zoom: '' };
  const W = P.settings.width, H = P.settings.height, sw = a.width || W, sh = a.height || H;
  const k = Math.max(W / sw, H / sh), z = c.reframe.zoom || 1;
  const axis = (focus, src, box) => {
    const p = coverPosition(focus, src, box, k), shown = src * k, off = (box - shown) * p;
    if (z === 1) return { p, t: 0 };
    const pf = off + focus * shown;                         // focus point inside the unscaled element
    const lo = box - (box / 2 + z * (off + shown - box / 2)), hi = -(box / 2 + z * (off - box / 2));
    return { p, t: Math.min(hi, Math.max(lo, -z * (pf - box / 2))) / box * 100 };
  };
  const ax = axis(kfAt(reframeTrack(c, 'x'), lt), sw, W), ay = axis(kfAt(reframeTrack(c, 'y'), lt), sh, H);
  return { pos: `${ax.p * 100}% ${ay.p * 100}%`, zoom: z === 1 ? '' : `translate(${ax.t}%, ${ay.t}%) scale(${z}) ` };
}
// Overlay blend modes and their CSS preview (add has no CSS equivalent; plus-lighter is close).
const BLEND_MODES = ['normal', 'screen', 'multiply', 'overlay', 'softlight', 'lighten', 'darken', 'add', 'difference'];
const BLEND_CSS = { screen: 'screen', multiply: 'multiply', overlay: 'overlay', softlight: 'soft-light', lighten: 'lighten', darken: 'darken', add: 'plus-lighter', difference: 'difference' };
const FILTERS = ['none', 'bw', 'sepia', 'vintage', 'warm', 'cool', 'vivid', 'cinematic', 'matte', 'noir', 'dramatic'];
const CLIP_ANIMS = ['none', 'fade', 'zoom_in', 'zoom_out', 'slide_left', 'slide_right', 'slide_up', 'slide_down'];
const proxied = new Set(); // media files whose proxy finished during this session
// Videos play through /preview/, which serves the 720p proxy when there is one.
const mediaSrc = (a) => (a.type === 'video' ? `/preview/${a.file}${proxied.has(a.file) ? '?proxy' : ''}` : `/media/${a.file}`);
const ease = (p) => p * p * (3 - 2 * p);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
// Same as kfAt in src/model.js.
function kfAt(tr, t) {
  const ps = tr.points;
  if (t <= ps[0].t) return ps[0].v;
  for (let i = 1; i < ps.length; i++) {
    if (t <= ps[i].t) { const a = ps[i - 1], b = ps[i]; let k = (t - a.t) / (b.t - a.t); if (tr.easing !== 'linear') k = ease(k); return a.v + (b.v - a.v) * k; }
  }
  return ps[ps.length - 1].v;
}
const kfVal = (item, prop, lt, fallback) => (item.keyframes?.[prop] ? kfAt(item.keyframes[prop], lt) : fallback);
// CSS versions of the looks in src/render.js LOOKS: [function, value, identity], scaled by filterIntensity.
const LOOK_CSS = {
  bw: [['grayscale', 1, 0]], sepia: [['sepia', 1, 0]],
  vintage: [['sepia', 0.35, 0], ['contrast', 0.9, 1], ['brightness', 1.05, 1], ['saturate', 0.85, 1]],
  warm: [['sepia', 0.2, 0], ['saturate', 1.15, 1], ['hue-rotate', -8, 0]],
  cool: [['hue-rotate', 12, 0], ['saturate', 1.05, 1], ['brightness', 1.02, 1]],
  vivid: [['saturate', 1.45, 1], ['contrast', 1.08, 1]],
  cinematic: [['contrast', 1.12, 1], ['saturate', 0.9, 1], ['hue-rotate', -5, 0]],
  matte: [['contrast', 0.8, 1], ['brightness', 1.05, 1], ['saturate', 0.85, 1]],
  noir: [['grayscale', 1, 0], ['contrast', 1.4, 1]],
  dramatic: [['contrast', 1.3, 1], ['saturate', 0.75, 1], ['brightness', 0.92, 1]],
};
function colorCss(c) {
  if (!c) return '';
  const f = [];
  if (c.brightness) f.push(`brightness(${1 + c.brightness * 0.8})`);
  if ((c.contrast ?? 1) !== 1) f.push(`contrast(${c.contrast})`);
  if ((c.saturation ?? 1) !== 1) f.push(`saturate(${c.saturation})`);
  if (c.temperature) f.push(c.temperature > 0 ? `sepia(${c.temperature * 0.35})` : `hue-rotate(${-c.temperature * 15}deg)`);
  const I = c.filterIntensity ?? 1;
  for (const [fn, v, id] of LOOK_CSS[c.filter] || []) { const x = id + (v - id) * I; f.push(fn === 'hue-rotate' ? `${fn}(${x}deg)` : `${fn}(${x})`); }
  return f.join(' ');
}
// Clip in/out animation at clip-local time lt: opacity, offset (fractions of the canvas) and scale.
function clipAnim(c, lt) {
  let op = 1, tx = 0, ty = 0, s = 1;
  const dur = c.duration;
  if (c.animIn) {
    const e = ease(clamp01(lt / Math.min(c.animIn.duration, dur / 2)));
    ({ fade: () => { op *= e; }, zoom_in: () => { s *= 0.6 + 0.4 * e; }, zoom_out: () => { s *= 1.4 - 0.4 * e; }, slide_left: () => { tx += 1 - e; },
      slide_right: () => { tx -= 1 - e; }, slide_up: () => { ty += 1 - e; }, slide_down: () => { ty -= 1 - e; } })[c.animIn.type]?.();
  }
  if (c.animOut) {
    const D = Math.min(c.animOut.duration, dur / 2), e = ease(clamp01((lt - (dur - D)) / D));
    ({ fade: () => { op *= 1 - e; }, zoom_in: () => { s *= 1 + 0.4 * e; }, zoom_out: () => { s *= 1 - 0.4 * e; }, slide_left: () => { tx -= e; },
      slide_right: () => { tx += e; }, slide_up: () => { ty -= e; }, slide_down: () => { ty += e; } })[c.animOut.type]?.();
  }
  return { op, tx, ty, s };
}
// CSS for the incoming and outgoing layer at transition progress k (0..1), mirroring ffmpeg xfade.
function transitionCss(type, k) {
  const pc = (v) => `${(v * 100).toFixed(2)}%`;
  const r = { in: {}, out: {}, swap: false };
  switch (type) {
    case 'wipeleft': case 'smoothleft': r.in.clipPath = `inset(0 0 0 ${pc(1 - k)})`; break;
    case 'wiperight': case 'smoothright': r.in.clipPath = `inset(0 ${pc(1 - k)} 0 0)`; break;
    case 'wipeup': r.in.clipPath = `inset(${pc(1 - k)} 0 0 0)`; break;
    case 'wipedown': r.in.clipPath = `inset(0 0 ${pc(1 - k)} 0)`; break;
    case 'slideleft': r.in.transform = `translateX(${pc(1 - k)})`; r.out.transform = `translateX(${pc(-k)})`; break;
    case 'slideright': r.in.transform = `translateX(${pc(k - 1)})`; r.out.transform = `translateX(${pc(k)})`; break;
    case 'slideup': r.in.transform = `translateY(${pc(1 - k)})`; r.out.transform = `translateY(${pc(-k)})`; break;
    case 'slidedown': r.in.transform = `translateY(${pc(k - 1)})`; r.out.transform = `translateY(${pc(k)})`; break;
    case 'circleopen': r.in.clipPath = `circle(${pc(k)} at 50% 50%)`; break;
    case 'circleclose': r.out.clipPath = `circle(${pc(1 - k)} at 50% 50%)`; r.swap = true; break;
    case 'radial': r.in.maskImage = r.in.webkitMaskImage = `conic-gradient(#000 ${k * 360}deg, transparent 0)`; break;
    case 'zoomin': r.out.transform = `scale(${1 + k})`; r.out.opacity = String(1 - k); r.in.opacity = String(k); break;
    case 'fadeblack': r.out.filter = `brightness(${Math.max(0, 1 - 2 * k)})`; r.in.opacity = k < 0.5 ? '0' : '1'; r.in.filter = `brightness(${Math.max(0, 2 * k - 1)})`; break;
    case 'fadewhite': r.out.filter = `brightness(${1 + 6 * Math.min(1, 2 * k)})`; r.in.opacity = k < 0.5 ? '0' : '1'; r.in.filter = `brightness(${1 + 6 * Math.max(0, 2 - 2 * k)})`; break;
    case 'hblur': r.in.opacity = String(k); r.in.filter = `blur(${(1 - k) * 12}px)`; r.out.filter = `blur(${k * 12}px)`; break;
    default: r.in.opacity = String(k); // fade, dissolve, pixelize, distance
  }
  return r;
}
const LAYER_RESET = { transform: '', clipPath: '', maskImage: '', webkitMaskImage: '', filter: '', opacity: '1' };

// Waveform peaks per asset, fetched once: { pps, peaks } | 'loading' | 'none'.
const waves = new Map();
function wave(a) {
  if (!waves.has(a.id)) {
    waves.set(a.id, 'loading');
    fetch(`/api/waveform/${a.id}`).then((r) => r.json())
      .then((w) => { waves.set(a.id, w.peaks ? w : 'none'); if (w.peaks) renderTimeline(); })
      .catch(() => waves.set(a.id, 'none'));
  }
  const w = waves.get(a.id);
  return typeof w === 'object' ? w : null;
}
// Canvas drawing source seconds srcIn..srcOut of the asset's audio across widthPx.
function waveCanvas(a, srcIn, srcOut, widthPx, heightPx, cls) {
  const w = wave(a);
  if (!w || srcOut <= srcIn) return null;
  const cw = Math.max(1, Math.min(4000, Math.round(widthPx)));
  const cv = h('canvas', { class: `wave ${cls}`, width: cw, height: heightPx });
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  for (let x = 0; x < cw; x++) {
    const i0 = Math.floor((srcIn + ((srcOut - srcIn) * x) / cw) * w.pps), i1 = Math.floor((srcIn + ((srcOut - srcIn) * (x + 1)) / cw) * w.pps);
    let m = 0;
    for (let i = i0; i <= i1 && i < w.peaks.length; i++) if (w.peaks[i] > m) m = w.peaks[i];
    const hh = Math.max(1, (m / 100) * heightPx);
    ctx.fillRect(x, (heightPx - hh) / 2, 1, hh);
  }
  return cv;
}

// ---------- Render ----------
function renderAll() {
  $('#aspect').value = P.settings.aspect;
  renderProjects(); renderPresets(); renderAssets(); renderTimeline(); renderInspector(); renderJobs(); fitStage(); renderFrame(true); renderCaptionButton();
}

function renderProjects() {
  const box = $('#project');
  const list = projects.length ? projects : [{ id: P.id, name: P.name }];
  box.replaceChildren(...list.map((x) => h('option', { value: x.id, selected: x.id === P.id }, x.name)),
    h('option', { value: '__new' }, '+ New project…'));
}
$('#project').onchange = async (e) => {
  const v = e.target.value;
  if (v === '__new') {
    const name = prompt('Project name', 'New project');
    if (name) await tool('create_project', { name }); else renderProjects();
  } else if (v !== P.id) await tool('open_project', { projectId: v });
};

// Reel styles and templates: one menu, each option runs a tool.
function renderPresets() {
  const cur = P.style?.name;
  const group = (label, items) => (items.length ? h('optgroup', { label }, ...items) : null);
  $('#presets').replaceChildren(
    h('option', { value: '' }, cur ? `Style: ${cur}` : 'Styles & templates'),
    group('Apply style', styles.map((s) => h('option', { value: `style:${s.id}`, title: s.description }, `${s.name}${s.builtin ? ' (built-in)' : ''}`))),
    group('New project from template', templates.map((t) => h('option', { value: `tpl:${t.id}` }, `${t.name} · ${t.slots} slots · ${t.duration.toFixed(0)}s`))),
    h('optgroup', { label: 'Save' },
      h('option', { value: 'save:style' }, 'Save this look as a style…'),
      h('option', { value: 'save:tpl' }, 'Save this edit as a template…')),
  );
  $('#presets').value = '';
}
$('#presets').onchange = async (e) => {
  const [kind, id] = e.target.value.split(/:(.*)/);
  renderPresets();
  if (kind === 'style') await tool('apply_style', { styleId: id });
  else if (kind === 'tpl') {
    const t = templates.find((x) => x.id === id);
    if (confirm(`Make a new project from "${t.name}"? Its ${t.slots} slots are filled with your media library's videos and photos in order.`)) await tool('create_from_template', { templateId: id });
  } else if (kind === 'save') {
    const what = id === 'style' ? 'Style' : 'Template';
    const name = prompt(`${what} name`, P.style?.name && id === 'style' ? P.style.name : P.name);
    if (!name) return;
    const r = await tool(id === 'style' ? 'save_style' : 'save_template', { name });
    if (!r.isError && !r.error) addMsg('assistant', r.content.split('\n')[0]);
  }
};

function renderAssets() {
  const box = $('#assets');
  const list = Object.values(P.assets);
  box.replaceChildren(...(list.length ? list.map((a) => h('div', {
    class: 'asset', draggable: 'true', title: `${a.name} (${a.id})`,
    ondragstart: (e) => e.dataTransfer.setData('text/asset', a.id),
  },
  h('div', { class: 'thumb', style: a.thumb ? { backgroundImage: `url(${a.thumb})` } : {} }, a.type === 'audio' ? '♪' : ''),
  h('div', { class: 'meta' }, h('div', { class: 'name' }, a.name), h('div', { class: 'sub' }, `${a.type}${a.duration ? ' · ' + a.duration.toFixed(1) + 's' : ''}`)),
  h('button', { class: 'add', title: 'Add to timeline', onclick: () => addAsset(a) }, '+'),
  a.type === 'video' && a.duration >= 20 ? h('button', { class: 'shorts', title: 'Find the best moments for shorts (transcribes first; long files take a while)', onclick: () => findShorts(a) }, '✂') : null,
  )) : [h('div', { class: 'empty' }, 'Drop videos, images or music here')]));
}
// Long video -> shorts: list candidate moments in the chat panel, each with a button that makes it a new project.
async function findShorts(a) {
  const note = addMsg('assistant', `Finding moments for shorts in "${a.name}"…`);
  const r = await tool('find_moments', { assetId: a.id, minDuration: 15, maxDuration: 60, count: 6 });
  if (r.isError || r.error) { note.remove(); return; }
  note.textContent = `Moments for shorts in "${a.name}", best first:`;
  for (const m of r.moments || []) {
    const fmtT = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
    const el = addMsg('assistant', '');
    el.classList.add('moment');
    el.append(
      h('div', { class: 'moment-head' }, h('b', {}, `${m.rank}. ${fmtT(m.in)}–${fmtT(m.out)}`), ` · ${m.duration.toFixed(0)}s`,
        h('button', { class: 'small', title: 'New 9:16 project with this moment, cover fit and captions', onclick: async (e) => {
          e.target.disabled = true;
          const res = await tool('make_short', { assetId: a.id, in: m.in, out: m.out });
          e.target.disabled = false;
          if (!res.isError && !res.error) e.target.textContent = '✓ Made';
        } }, '✂ Make short')),
      h('div', { class: 'moment-text' }, m.text ? `“${m.text.length > 220 ? `${m.text.slice(0, 220)}…` : m.text}”` : '(no speech)'),
    );
  }
  if (!r.moments?.length) addMsg('assistant', String(r.content));
}
function addAsset(a, position) {
  if (a.type === 'audio') return tool('add_music', { assetId: a.id, start: 0 });
  return tool('add_clip', { assetId: a.id, position });
}

function fitStage() {
  const wrap = $('#stageWrap'), st = $('#stage');
  const W = P.settings.width, H = P.settings.height;
  const aw = wrap.clientWidth - 24, ah = wrap.clientHeight - 24;
  const k = Math.min(aw / W, ah / H);
  st.style.width = `${Math.floor(W * k)}px`; st.style.height = `${Math.floor(H * k)}px`;
  st.style.background = P.settings.background;
  $('#stageEmpty').style.display = L.clips.length ? 'none' : 'flex';
}
window.addEventListener('resize', () => P && (fitStage(), renderFrame(true)));

// ---------- Preview playback ----------
// Each layer: .inner (Ken Burns + effects for the whole clip) holding the blurred background, the media,
// a vignette, a canvas for pixel effects (pixelate, mirror, kaleidoscope), a light leak and grain.
// The layer itself carries the transition styles.
const svgNS = 'http://www.w3.org/2000/svg';
const fxDefs = document.createElementNS(svgNS, 'svg');
fxDefs.setAttribute('width', '0'); fxDefs.setAttribute('height', '0');
fxDefs.style.position = 'absolute';
document.body.append(fxDefs);
const layers = [...document.querySelectorAll('.layer')].map((el, i) => {
  const bg = h('video', { class: 'bgblur', muted: true, playsinline: true, preload: 'auto' });
  bg.muted = true;
  const video = $('video', el), img = $('img', el);
  const inner = h('div', { class: 'inner' });
  const vig = h('div', { class: 'fx-vig' }), canvas = h('canvas', { class: 'fx-canvas' }), leak = h('div', { class: 'fx-leak' }), grain = h('div', { class: 'fx-grain' });
  grain.style.backgroundImage = GRAIN_URL;
  inner.append(bg, video, img, vig, canvas, leak, grain);
  el.append(inner);
  // RGB split: red moved left, blue right (dx set per frame); comic: colored edges.
  fxDefs.insertAdjacentHTML('beforeend', `<filter id="vg-rgb-${i}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">
    <feColorMatrix in="SourceGraphic" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset in="r" dx="0" result="ro"/>
    <feColorMatrix in="SourceGraphic" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/>
    <feColorMatrix in="SourceGraphic" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/><feOffset in="b" dx="0" result="bo"/>
    <feBlend mode="screen" in="ro" in2="g" result="rg"/><feBlend mode="screen" in="rg" in2="bo"/></filter>
    <filter id="vg-comic-${i}" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" preserveAlpha="true" result="e"/>
    <feComponentTransfer in="SourceGraphic" result="d"><feFuncR type="linear" slope="0.5"/><feFuncG type="linear" slope="0.5"/><feFuncB type="linear" slope="0.5"/></feComponentTransfer>
    <feBlend mode="screen" in="e" in2="d"/></filter>`);
  const offs = fxDefs.querySelectorAll(`#vg-rgb-${i} feOffset`);
  // While paused, canvas effects need the decoded frame: draw again once a seek or load lands.
  for (const ev of ['seeked', 'loadeddata']) video.addEventListener(ev, () => { if (!playing && P) renderFrame(); });
  img.addEventListener('load', () => { if (!playing && P) renderFrame(); });
  return { el, inner, video, img, bg, vig, canvas, leak, grain, rgbOffsets: offs, src: document.createElement('canvas'), scratch: document.createElement('canvas'), clipId: null };
});
const musicEls = new Map();

// Vignette, Ken Burns and effects of a clip on its layer. g: how the media is placed (for canvas effects).
function renderClipFx(ly, c, a, lt, g) {
  const W = P.settings.width, H = P.settings.height, k = $('#stage').clientWidth / W, li = layers.indexOf(ly);
  const kb = kenBurns(c.motion, lt, c.duration), fx = effectsAt(c, lt, W, H, k);
  // Render order: placement, Ken Burns, then effects, so the effect transform is the outer one.
  ly.inner.style.transform = [fx.transform, kb ? zoomAbout(kb.z, kb.ox, kb.oy) : ''].filter(Boolean).join(' ');
  ly.rgbOffsets[0].setAttribute('dx', String(-fx.rgb)); ly.rgbOffsets[1].setAttribute('dx', String(fx.rgb));
  ly.inner.style.filter = [fx.rgb ? `url(#vg-rgb-${li})` : '', fx.comic ? `url(#vg-comic-${li})` : '', fx.filter].filter(Boolean).join(' ');
  const vig = vignetteCss(c.color?.vignette);
  ly.vig.style.display = vig ? 'block' : 'none'; ly.vig.style.background = vig;
  ly.leak.style.display = fx.leak ? 'block' : 'none';
  if (fx.leak) { ly.leak.style.background = leakCss(fx.leak.phase); ly.leak.style.opacity = String(fx.leak.opacity); }
  ly.grain.style.display = fx.grain ? 'block' : 'none';
  if (fx.grain) { ly.grain.style.opacity = String(Math.min(1, fx.grain)); ly.grain.style.backgroundPosition = `${Math.floor(Math.random() * 160)}px ${Math.floor(Math.random() * 160)}px`; }
  ly.canvas.style.display = fx.canvas && paintClipFrame(ly, a, g) ? 'block' : 'none';
  if (ly.canvas.style.display === 'block') {
    ly.canvas.width = ly.src.width; ly.canvas.height = ly.src.height;
    drawEffect(ly.canvas.getContext('2d'), ly.src, fx.canvas, ly.scratch);
  }
}
// The finished clip frame (fit, crop, position, rotation, color) on ly.src, for canvas effects. Same
// placement as the CSS on the media element; reframe zoom is left out. False until the media has a frame.
function paintClipFrame(ly, a, g) {
  const st = $('#stage'), w = st.clientWidth, hgt = st.clientHeight;
  const m = a.type === 'image' ? ly.img : ly.video;
  const nw = m.videoWidth || m.naturalWidth, nh = m.videoHeight || m.naturalHeight;
  if (!nw || !nh || (m.tagName === 'VIDEO' && m.readyState < 2)) return false;
  const cv = ly.src;
  cv.width = w; cv.height = hgt;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = P.settings.background; ctx.fillRect(0, 0, w, hgt);
  const cr = g.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = cr.x * nw, sy = cr.y * nh, sw = cr.w * nw, sh = cr.h * nh;
  const place = (cover) => {
    const sc = cover ? Math.max(w / sw, hgt / sh) : Math.min(w / sw, hgt / sh), dw = sw * sc, dh = sh * sc;
    const [px, py] = g.pos.split(' ').map((v) => parseFloat(v) / 100);
    return [(w - dw) * px, (hgt - dh) * py, dw, dh];
  };
  if (g.fit === 'blur') { ctx.filter = 'blur(14px) brightness(.85)'; ctx.drawImage(m, sx, sy, sw, sh, ...place(true)); }
  ctx.save();
  ctx.globalAlpha = g.op;
  ctx.translate(w / 2 + (g.x - 0.5) * w, hgt / 2 + (g.y - 0.5) * hgt);
  ctx.rotate((g.rotate * Math.PI) / 180);
  ctx.scale(g.s * (g.flipH ? -1 : 1), g.s * (g.flipV ? -1 : 1));
  ctx.translate(-w / 2, -hgt / 2);
  ctx.filter = g.filter || 'none';
  ctx.drawImage(m, sx, sy, sw, sh, ...place(g.fit === 'cover'));
  ctx.restore();
  return true;
}

function syncVideo(v, src, t, rate, vol, play) {
  if (v.getAttribute('src') !== src) { v.src = src; v.currentTime = t; }
  v.playbackRate = rate;
  if (vol !== null) v.volume = rec ? 0 : Math.min(1, vol); // silent while recording a voiceover
  if (!play) { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - t) > 0.03) v.currentTime = t; return; }
  if (Math.abs(v.currentTime - t) > 0.3) v.currentTime = t;
  if (v.paused) v.play().catch(() => {});
}

function renderFrame(force) {
  if (!P) return;
  const t = time;
  const active = L.clips.filter((c) => t >= c.start && t < c.end);
  if (!active.length && L.clips.length && t >= L.duration - 0.001) active.push(L.clips[L.clips.length - 1]);
  const used = new Set();
  // During a transition the later clip is "in" and the earlier one "out".
  const incoming = active.find((c) => c.overlap && t < c.start + c.overlap);
  const tr = incoming && transitionCss(incoming.transition?.type, clamp01((t - incoming.start) / incoming.overlap));
  active.forEach((c, n) => {
    const ly = layers[c.index % 2];
    used.add(ly);
    const a = P.assets[c.assetId];
    const src = mediaSrc(a);
    const fit = c.fit || 'contain';
    ly.el.style.display = 'block';
    ly.el.style.background = P.settings.background;
    const role = !tr ? null : c === incoming ? 'in' : 'out';
    Object.assign(ly.el.style, LAYER_RESET, role ? tr[role] : {});
    ly.el.style.zIndex = String(tr?.swap ? active.length - n : n + 1);
    // Clip transform, keyframes and in/out animation on the media element; color as a CSS filter.
    const T = c.transform || {}, lt = t - c.start, an = clipAnim(c, lt);
    const s = kfVal(c, 'scale', lt, T.scale ?? 1) * an.s, x = kfVal(c, 'x', lt, T.x ?? 0.5) + an.tx, y = kfVal(c, 'y', lt, T.y ?? 0.5) + an.ty;
    const rf = reframeCss(c, a, lt, fit);
    const mediaStyle = {
      objectPosition: rf.pos, objectViewBox: cropBox(T.crop),
      transform: `translate(${(x - 0.5) * 100}%, ${(y - 0.5) * 100}%) ${rf.zoom}rotate(${T.rotate || 0}deg) scale(${s * (T.flipH ? -1 : 1)}, ${s * (T.flipV ? -1 : 1)})`,
      opacity: String(an.op), filter: colorCss(c.color),
    };
    Object.assign(ly.video.style, mediaStyle); Object.assign(ly.img.style, mediaStyle);
    const fitCss = fit === 'cover' ? 'cover' : 'contain';
    if (a.type === 'image') {
      ly.video.style.display = 'none'; ly.video.pause();
      ly.img.style.display = 'block'; ly.img.style.objectFit = fitCss;
      if (ly.img.getAttribute('src') !== src) ly.img.src = src;
      ly.bg.style.display = 'none';
      if (fit === 'blur') { ly.el.style.background = `center/cover url(${src})`; }
    } else {
      ly.img.style.display = 'none';
      ly.video.style.display = 'block'; ly.video.style.objectFit = fitCss;
      // Freeze frames and reversed clips are shown by seeking (a video element cannot play backwards).
      const st = Math.min(srcAt(c, lt), c.out - 0.01);
      const still = c.freeze || c.reverse;
      const rate = still ? 1 : Math.max(0.0625, Math.min(16, speedAt(c, lt)));
      syncVideo(ly.video, src, st, rate, still ? 0 : kfVal(c, 'volume', lt, c.volume), playing && !still);
      if (fit === 'blur') { ly.bg.style.display = 'block'; syncVideo(ly.bg, src, st, rate, null, playing && !still); }
      else { ly.bg.style.display = 'none'; ly.bg.pause(); }
    }
    renderClipFx(ly, c, a, lt, { fit, pos: rf.pos, x, y, s, rotate: T.rotate || 0, flipH: T.flipH, flipV: T.flipV, op: an.op, crop: T.crop, filter: mediaStyle.filter });
  });
  for (const ly of layers) if (!used.has(ly)) { ly.el.style.display = 'none'; ly.video.pause(); ly.bg.pause(); }

  renderOverlays(t);

  // Music
  for (const m of P.music) {
    let el = musicEls.get(m.id);
    if (!el) { el = new Audio(); musicEls.set(m.id, el); }
    const src = `/media/${P.assets[m.assetId].file}`;
    const len = m.out - m.in;
    const on = t >= m.start && t < m.start + len;
    if (!on) { el.pause(); continue; }
    const lt = t - m.start;
    let vol = m.volume;
    if (m.fadeIn && lt < m.fadeIn) vol *= lt / m.fadeIn;
    const end = Math.min(len, L.duration - m.start);
    if (m.fadeOut && lt > end - m.fadeOut) vol *= Math.max(0, (end - lt) / m.fadeOut);
    syncVideo(el, src, m.in + lt, 1, vol, playing);
  }
  for (const [id, el] of musicEls) if (!P.music.find((m) => m.id === id)) { el.pause(); musicEls.delete(id); }

  renderTexts(t);
  $('#time').textContent = `${fmt(t)} / ${fmt(L.duration)}`;
  $('#play').textContent = playing ? '⏸' : '▶';
  $('#playhead').style.left = `${t * pps}px`;
  if (playing) {
    const sc = $('#tlScroll'), x = t * pps;
    if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 40;
  }
}

// Overlay mask preview with CSS masks (maskExpr in src/render.js draws the real one). ar = box width / height;
// the feather follows render.js: the edge fades over feather * 0.25 * the short side.
function maskCss(m, ar) {
  if (!m) return { maskImage: '', webkitMaskImage: '', maskComposite: '', webkitMaskComposite: '' };
  const W = ar, H = 1, F = Math.max(0.002, (m.feather || 0) * 0.25 * Math.min(W, H));
  const pc = (v) => `${(v * 100).toFixed(2)}%`;
  const [on, off] = m.invert ? ['transparent', '#000'] : ['#000', 'transparent'];
  let layers, comp = [];
  if (m.shape === 'circle') {
    const k = F / Math.min(m.w * W, m.h * H);
    layers = [`radial-gradient(ellipse ${pc(m.w / 2)} ${pc(m.h / 2)} at ${pc(m.x)} ${pc(m.y)}, ${on} ${pc(1 - k)}, ${off} ${pc(1 + k)})`];
  } else if (m.shape === 'rect') {
    const band = (dir, c, size, f) => `linear-gradient(${dir}, transparent ${pc(c - size / 2 - f / 2)}, #000 ${pc(c - size / 2 + f / 2)}, #000 ${pc(c + size / 2 - f / 2)}, transparent ${pc(c + size / 2 + f / 2)})`;
    layers = [band('to right', m.x, m.w, F / W), band('to bottom', m.y, m.h, F / H)];
    comp = ['intersect'];
    if (m.invert) { layers.unshift('linear-gradient(#000, #000)'); comp = ['exclude', 'intersect']; }
  } else {
    // Gradient along the normal that points at the kept side (CSS angle = mask angle + 180).
    const th = ((m.angle || 0) + 180) * Math.PI / 180, dx = Math.sin(th), dy = -Math.cos(th);
    const Lg = Math.abs(W * dx) + Math.abs(H * dy);
    const at = 0.5 + ((m.x - 0.5) * W * dx + (m.y - 0.5) * H * dy) / Lg, k = F / 2 / Lg;
    const deg = `${((m.angle || 0) + 180).toFixed(1)}deg`;
    if (m.shape === 'linear') layers = [`linear-gradient(${deg}, ${off} ${pc(at - k)}, ${on} ${pc(at + k)})`];
    else {
      const hh = (m.h * H) / 2 / Lg;
      layers = [`linear-gradient(${deg}, ${off} ${pc(at - hh - k)}, ${on} ${pc(at - hh + k)}, ${on} ${pc(at + hh - k)}, ${off} ${pc(at + hh + k)})`];
    }
  }
  const img = layers.join(', ');
  const c = comp.length ? [...comp, 'add'].join(', ') : '';
  const wc = comp.length ? [...comp.map((x) => ({ intersect: 'source-in', exclude: 'xor' })[x]), 'source-over'].join(', ') : '';
  return { maskImage: img, webkitMaskImage: img, maskComposite: c, webkitMaskComposite: wc };
}
// Pop animation of overlays: same curve as render.js (back-out over 0.35s).
function popScale(o, lt) {
  if (o.animation !== 'pop' || o.fit === 'cover' || o.fit === 'contain') return 1;
  const D = Math.min(0.35, ovDur(o) / 2);
  if (lt >= D) return 1;
  const u = Math.max(0, lt) / D - 1;
  return Math.max(0, 1 + 2.70158 * u ** 3 + 1.70158 * u ** 2);
}

const ovEls = new Map();
function renderOverlays(t) {
  const box = $('#overlays');
  const keep = new Set();
  const sorted = [...P.overlays].sort((a, b) => a.track - b.track || a.start - b.start);
  sorted.forEach((o, z) => {
    const a = P.assets[o.assetId];
    if (!a) return;
    let el = ovEls.get(o.id);
    // Animated GIFs (stickers) play as images: the browser animates them and keeps their transparency.
    const gif = a.codec === 'gif';
    const tag = a.type === 'image' || gif ? 'IMG' : 'VIDEO';
    if (!el || el.tagName !== tag) {
      el?.remove();
      el = h(tag.toLowerCase(), { class: 'ov-media', playsinline: true, preload: 'auto' });
      ovEls.set(o.id, el); box.append(el);
    }
    keep.add(o.id);
    const on = t >= o.start && t < o.start + ovDur(o);
    el.style.display = on ? 'block' : 'none';
    const src = gif ? `/media/${a.file}` : mediaSrc(a);
    const lt = t - o.start;
    const vol = kfVal(o, 'volume', lt, o.volume);
    let srcT = o.in + lt * o.speed;
    if (o.loop && a.duration && srcT >= a.duration) srcT %= a.duration; // looping restarts from 0, like -stream_loop
    if (tag === 'IMG') { if (el.getAttribute('src') !== src) el.src = src; }
    else if (on) syncVideo(el, src, srcT, o.speed, vol, playing);
    else el.pause();
    if (!on) return;
    const full = o.fit === 'cover' || o.fit === 'contain';
    const fade = o.animation === 'fade' ? clamp01(Math.min(lt, ovDur(o) - lt) / 0.3) : 1;
    Object.assign(el.style, {
      zIndex: String(z + 10), mixBlendMode: BLEND_CSS[o.blend] || 'normal', opacity: String(kfVal(o, 'opacity', lt, o.opacity) * fade), objectFit: o.fit === 'cover' ? 'cover' : 'contain',
      left: full ? '50%' : `${kfVal(o, 'x', lt, o.x) * 100}%`, top: full ? '50%' : `${kfVal(o, 'y', lt, o.y) * 100}%`,
      width: full ? '100%' : `${kfVal(o, 'scale', lt, o.scale) * 100}%`, height: full ? '100%' : 'auto',
      transform: `translate(-50%, -50%) rotate(${kfVal(o, 'rotate', lt, o.rotate || 0)}deg) scale(${(o.flipH ? -1 : 1) * popScale(o, lt)}, ${(o.flipV ? -1 : 1) * popScale(o, lt)})`,
      filter: colorCss(o.color), objectViewBox: cropBox(o.crop),
      ...maskCss(o.mask, full ? P.settings.width / P.settings.height : ((a.width || 1) * (o.crop?.w ?? 1)) / ((a.height || 1) * (o.crop?.h ?? 1))),
    });
  });
  for (const [id, el] of ovEls) if (!keep.has(id)) { el.pause?.(); el.remove(); ovEls.delete(id); }
}

// Fonts for the preview: the same files the export uses (GET /api/font/:family), plus the family's
// em ratio so sizes match libass (which sizes ascent + descent, not the em).
const fontState = new Map();
function fontInfo(fam) {
  let f = fontState.get(fam);
  if (f) return f;
  f = { em: 0.88 };
  fontState.set(fam, f);
  const u = `/api/font/${encodeURIComponent(fam)}`;
  // Unknown families 404: the CSS fallback fonts are used. Missing faces (e.g. no bold file) are synthesized.
  fetch(`${u}?metrics`).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (!j) return;
    f.em = j.emRatio;
    const FACES = { regular: ['400', 'normal'], bold: ['700', 'normal'], italic: ['400', 'italic'], bolditalic: ['700', 'italic'] };
    for (const face of j.faces) {
      const ff = new FontFace(fam, `url(${u}?face=${face})`, { weight: FACES[face][0], style: FACES[face][1] });
      ff.load().then(() => { document.fonts.add(ff); renderTexts(time); }).catch(() => {});
    }
    renderTexts(time);
  }).catch(() => {});
  return f;
}
const FALLBACK_FONTS = '"DejaVu Sans", Verdana, system-ui, sans-serif';

function renderCaption(t, k) {
  const c = P.captions;
  if (!c) return null;
  const l = c.lines.find((x) => t >= x.start && t < x.end);
  if (!l) return null;
  const st = c.style;
  const up = (w) => (st.uppercase ? w.toUpperCase() : w);
  const cur = l.words.findIndex((w, i) => t >= w.start && (i + 1 >= l.words.length || t < l.words[i + 1].start));
  const words = st.mode === 'single' ? (cur >= 0 ? [l.words[cur]] : []) : l.words;
  // Same style as captionTags in src/ass.js: outline 4 by default, no shadow.
  const fam = st.font || defaultFont;
  const look = textLook({ ...st, font: fam, outline: st.box ? undefined : (st.outline ?? 4), shadow: 0 }, k, fontInfo(fam).em, FALLBACK_FONTS);
  // Emphasized words: same rules as captionEvents/emphasisColor in src/ass.js.
  const emDefault = st.emphasisColor || (['karaoke', 'word', 'single'].includes(st.mode) && String(st.highlightColor).toLowerCase() === '#ffde00' ? '#4dff88' : '#ffde00');
  const emSize = `${Math.round((st.emphasisScale ?? 1.15) * 100)}%`;
  const capEl = h('div', { class: 'ov-caption', style: { ...look, top: `${st.y * 100}%` } }, ...words.map((w, i) => {
    const idx = l.words.indexOf(w);
    const lit = st.mode === 'karaoke' ? t >= w.start : st.mode === 'word' ? idx === cur : st.mode === 'single';
    const em = w.em ? (typeof w.em === 'string' ? w.em : emDefault) : null;
    const colr = st.mode === 'word' ? (lit ? st.highlightColor : em || st.color) : em || (lit ? st.highlightColor : st.color);
    return h('span', { style: { color: colr, ...(em ? { fontSize: emSize } : {}) } }, up(w.w) + (i < words.length - 1 ? ' ' : ''));
  }));
  // Translation under the line (altY / ALT_SCALE in src/ass.js).
  let altEl = null;
  if (l.alt) {
    const H = P.settings.height, size = st.size || 72, gap = (size * 0.6 + size * 0.72 * 0.6 + 8) / H;
    const y = st.y + gap <= 0.96 ? st.y + gap : st.y - gap;
    const aLook = textLook({ ...st, font: fam, size: Math.round(size * 0.72), outline: st.box ? undefined : Math.max(1, Math.round((st.outline ?? 4) * 0.75)), shadow: 0 }, k, fontInfo(fam).em, FALLBACK_FONTS);
    altEl = h('div', { class: 'ov-caption', style: { ...aLook, top: `${y * 100}%`, color: st.color } }, up(l.alt));
  }
  // Emoji above the line (emojiBox in src/ass.js): from its word until the next emoji or the line end.
  const emo = l.words.filter((w) => w.emoji && w.start <= t).pop();
  if (!emo) return altEl ? [capEl, altEl] : capEl;
  const size = Math.max(16, Math.round((st.size || 72) * 1.4));
  const pop = Math.min(1, Math.max(0, (t - emo.start) / 0.15)); // fades in like the export
  const cy = P.settings.height * st.y - (st.size || 72) * 0.6 - size * 0.55;
  return [capEl, ...(altEl ? [altEl] : []), h('div', { class: 'ov-emoji', style: { top: `${(cy / P.settings.height) * 100}%`, fontSize: `${(size * k * 0.85).toFixed(1)}px`, opacity: String(pop), transform: `translate(-50%, -50%) scale(${(0.6 + 0.4 * pop).toFixed(3)})` } }, emo.emoji)];
}

function renderTexts(t) {
  const st = $('#stage');
  const k = st.clientWidth / P.settings.width;
  const box = $('#texts');
  box.replaceChildren(...P.texts.filter((x) => t >= x.start && t < x.end).map((x) => {
    const fam = x.font || defaultFont;
    const an = textAnim(x, t);
    const text = x.text.replace(/\\n/g, '\n');
    // Typewriter: the hidden characters keep their space so the line does not move.
    const kids = an.chars === null ? [text] : [[...text].slice(0, an.chars).join(''),
      h('span', { style: { color: 'transparent', webkitTextStroke: '0', textShadow: 'none' } }, [...text].slice(an.chars).join(''))];
    const el = h('div', {
      class: `ov-text${isSel(x.id) ? ' selected' : ''}`,
      style: {
        ...textLook({ ...x, font: fam }, k, fontInfo(fam).em, FALLBACK_FONTS),
        left: `${x.x * 100}%`, top: `${x.y * 100}%`, opacity: String(an.op),
        transform: `translate(-50%, -50%) translate(${(an.dx * k).toFixed(2)}px, ${(an.dy * k).toFixed(2)}px) scale(${an.sc.toFixed(4)})`,
      },
    }, ...kids);
    el.addEventListener('pointerdown', (e) => dragTextOnStage(e, x));
    return el;
  }));
  const cap = renderCaption(t, k);
  if (cap) box.append(...[cap].flat());
}
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

function dragTextOnStage(e, x) {
  e.preventDefault();
  select('text', x.id);
  const st = $('#stage').getBoundingClientRect();
  const el = e.currentTarget;
  let nx = x.x, ny = x.y;
  const move = (ev) => {
    nx = Math.min(1, Math.max(0, (ev.clientX - st.left) / st.width));
    ny = Math.min(1, Math.max(0, (ev.clientY - st.top) / st.height));
    el.style.left = `${nx * 100}%`; el.style.top = `${ny * 100}%`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (nx !== x.x || ny !== x.y) tool('update_text', { textId: x.id, x: +nx.toFixed(3), y: +ny.toFixed(3) });
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function tick() {
  if (rec) renderRecord();
  if (playing) {
    time = playFrom + (performance.now() - playStart) / 1000;
    if (time >= L.duration) { time = L.duration; playing = false; }
    renderFrame();
  }
  requestAnimationFrame(tick);
}
function play() {
  if (!L.clips.length) return;
  if (time >= L.duration - 0.05) time = 0;
  playing = true; playFrom = time; playStart = performance.now(); renderFrame();
}
function pause() { playing = false; renderFrame(true); }
function seek(t) { time = Math.max(0, Math.min(L.duration, t)); if (playing) { playFrom = time; playStart = performance.now(); } renderFrame(true); }

// ---------- Timeline ----------
function renderTimeline() {
  const dur = Math.max(L.duration, ...P.texts.map((t) => t.end), ...P.music.map((m) => m.start + m.out - m.in), ...P.overlays.map((o) => o.start + ovDur(o)), 10);
  const inner = $('#tlInner');
  inner.style.width = `${dur * pps + 200}px`;
  // ruler
  const step = pps > 120 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 5 : 10;
  const ticks = [];
  for (let t = 0; t <= dur + 2; t += step) ticks.push(h('div', { class: 'tick', style: { left: `${t * pps}px` } }, t % 1 === 0 ? fmt(t).replace(/\.0$/, '') : ''));
  const marks = (P.markers || []).map((m) => h('div', {
    class: `mk ${m.kind}`, style: { left: `${m.t * pps}px` }, title: `${m.kind}${m.label ? ` "${m.label}"` : ''} at ${m.t.toFixed(2)}s`,
    onpointerdown: (e) => { e.stopPropagation(); seek(m.t); },
  }, m.kind === 'note' && m.label ? m.label : ''));
  $('#ruler').replaceChildren(...ticks, ...marks);

  // video track
  const tv = $('#trackVideo');
  tv.replaceChildren(...L.clips.flatMap((c) => {
    const a = P.assets[c.assetId];
    const tag = c.freeze ? '❄ ' : `${c.ramp ? '⤳ ' : c.speed !== 1 ? c.speed + 'x · ' : ''}${c.reverse ? '⟲ ' : ''}`;
    const b = h('div', {
      class: `block clip${isSel(c.id) ? ' selected' : ''}`,
      style: { left: `${c.start * pps}px`, width: `${Math.max(4, c.duration * pps)}px`, backgroundImage: a.thumb ? `url(${a.thumb})` : 'none' },
      title: c.freeze ? `${a.name}: freeze frame at ${c.in.toFixed(2)}s` : `${a.name} ${c.in.toFixed(2)}-${c.out.toFixed(2)}s${c.reverse ? ' reversed' : ''}${c.ramp ? ` · speed ramp ${c.ramp.preset || 'custom'}` : ''}`,
    }, h('span', {}, `${tag}${c.color?.filter || c.color?.lut ? `◐ ` : ''}${c.effects?.length ? '✦ ' : ''}${a.name}`),
    a.type === 'video' && a.hasAudio && !c.freeze && !c.reverse && !c.ramp ? waveCanvas(a, c.in, c.out, c.duration * pps, 14, 'clipwave') : null,
    c.freeze ? null : h('div', { class: 'handle l', onpointerdown: (e) => trimDrag(e, c, 'in') }),
    h('div', { class: 'handle r', onpointerdown: (e) => trimDrag(e, c, 'out') }));
    b.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('handle')) clipDrag(e, c); });
    const out = [b];
    if (c.index > 0) {
      const has = c.transition?.type && c.transition.type !== 'none';
      out.push(h('div', {
        class: 'trans', title: has ? `${c.transition.type} ${c.transition.duration}s` : 'Add transition',
        style: { left: `${(c.start + (has ? 0 : 0)) * pps - 10}px`, width: `${Math.max(20, (has ? c.overlap : 0) * pps + 20)}px`, opacity: has ? 1 : 0.35 },
        onclick: () => select('clip', c.id, true),
      }, has ? '⧓' : '+'));
    }
    return out;
  }));
  tv.ondragover = (e) => e.preventDefault();
  tv.ondrop = (e) => {
    const id = e.dataTransfer.getData('text/asset');
    const a = P.assets[id];
    if (!a) return;
    const x = (e.clientX - tv.getBoundingClientRect().left) / pps;
    const pos = L.clips.filter((c) => c.start + c.duration / 2 < x).length + 1;
    addAsset(a, pos);
  };

  // overlay track (one lane per overlay track number, top lane = highest track)
  const ovTracks = [...new Set(P.overlays.map((o) => o.track))].sort((a, b) => a - b);
  const olh = 40 / Math.max(1, ovTracks.length);
  $('#trackOverlay').replaceChildren(...P.overlays.map((o) => {
    const a = P.assets[o.assetId];
    const b = h('div', {
      class: `block overlay${isSel(o.id) ? ' selected' : ''}${o.group ? ' grouped' : ''}`, 'data-id': o.id, 'data-start': o.start,
      style: { left: `${o.start * pps}px`, width: `${Math.max(4, ovDur(o) * pps)}px`, top: `${6 + (ovTracks.length - 1 - ovTracks.indexOf(o.track)) * olh}px`, height: `${olh - (ovTracks.length > 1 ? 2 : 0)}px`, backgroundImage: a?.thumb ? `url(${a.thumb})` : 'none' },
      title: `${a?.name} (track ${o.track})`,
    }, `⧉ ${a?.name}`);
    b.addEventListener('pointerdown', (e) => rangeDrag(e, 'overlay', o, 'move'));
    return b;
  }));

  // text track
  // Overlapping texts go into separate lanes.
  const lanes = [];
  const laneOf = new Map();
  for (const x of [...P.texts].sort((a, b) => a.start - b.start)) {
    let i = lanes.findIndex((end) => end <= x.start + 1e-6);
    if (i < 0) i = lanes.push(0) - 1;
    lanes[i] = x.end; laneOf.set(x.id, i);
  }
  const lh = 40 / Math.max(1, lanes.length);
  $('#trackText').replaceChildren(...P.texts.map((x) => {
    const b = h('div', { class: `block text${isSel(x.id) ? ' selected' : ''}${x.group ? ' grouped' : ''}`, 'data-id': x.id, 'data-start': x.start, style: { left: `${x.start * pps}px`, width: `${Math.max(4, (x.end - x.start) * pps)}px`, top: `${6 + laneOf.get(x.id) * lh}px`, height: `${lh - (lanes.length > 1 ? 2 : 0)}px`, padding: lanes.length > 2 ? '0 6px' : undefined, fontSize: lanes.length > 2 ? '9px' : undefined }, title: x.text },
      x.text.replace(/\\n|\n/g, ' '), h('div', { class: 'handle r', onpointerdown: (e) => rangeDrag(e, 'text', x, 'end') }));
    b.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('handle')) rangeDrag(e, 'text', x, 'move'); });
    return b;
  }));
  // music track
  const tm = $('#trackMusic');
  const aTracks = [...new Set(P.music.map((m) => m.track || 1))].sort((a, b) => a - b);
  const alh = 40 / Math.max(1, aTracks.length);
  tm.replaceChildren(...P.music.map((m) => {
    const icon = m.role === 'sfx' ? '✦' : m.role === 'voice' ? '🎙' : '♪';
    const ma = P.assets[m.assetId];
    const bh = alh - (aTracks.length > 1 ? 2 : 0);
    const b = h('div', { class: `block music${isSel(m.id) ? ' selected' : ''}${m.group ? ' grouped' : ''}`, 'data-id': m.id, 'data-start': m.start, style: { left: `${m.start * pps}px`, width: `${Math.max(4, (m.out - m.in) * pps)}px`, top: `${6 + aTracks.indexOf(m.track || 1) * alh}px`, height: `${bh}px` } },
      ma ? waveCanvas(ma, m.in, m.out, (m.out - m.in) * pps, Math.max(8, Math.round(bh - 4)), 'musicwave') : null,
      h('span', {}, `${icon} ${m.duck ? '⇣ ' : ''}${ma?.name}`));
    b.addEventListener('pointerdown', (e) => rangeDrag(e, 'music', m, 'move'));
    return b;
  }));
  tm.ondragover = (e) => e.preventDefault();
  tm.ondrop = (e) => {
    const a = P.assets[e.dataTransfer.getData('text/asset')];
    if (a && (a.type === 'audio' || a.hasAudio)) tool('add_music', { assetId: a.id, start: +((e.clientX - tm.getBoundingClientRect().left) / pps).toFixed(2) });
  };
  $('#playhead').style.left = `${time * pps}px`;
  const band = $('#rangeBand');
  band.style.display = range ? 'block' : 'none';
  if (range) Object.assign(band.style, { left: `${range.in * pps}px`, width: `${Math.max(2, (range.out - range.in) * pps)}px` });
  $('#cutRange').disabled = !range;
  $('#snap').classList.toggle('on', snapOn);
}

// ---------- Selection, snapping ----------
// Click selects (a grouped item selects its whole group); Ctrl/Cmd/Shift+click adds or removes.
// Returns true when the click only changed the selection (no drag should start).
function pickFromEvent(e, kind, id) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    if (picked.has(id)) picked.delete(id); else picked.set(id, kind);
    const last = [...picked].pop();
    sel = last ? { kind: last[1], id: last[0] } : null;
    renderTimeline(); renderInspector(); renderTexts(time);
    return true;
  }
  if (!picked.has(id)) select(kind, id);
  return false;
}
const kindOf = (x) => (P.texts.includes(x) ? 'text' : P.overlays.includes(x) ? 'overlay' : 'music');
// Timeline edges to snap to: 0, the playhead, clip edges, markers, range, other items' edges.
function snapTargets(skip) {
  if (!snapOn) return [];
  const t = [0, time, ...L.clips.flatMap((c) => [c.start, c.end]), ...(P.markers || []).map((m) => m.t), ...(range ? [range.in, range.out] : [])];
  for (const x of P.texts) if (!skip.has(x.id)) t.push(x.start, x.end);
  for (const o of P.overlays) if (!skip.has(o.id)) t.push(o.start, o.start + ovDur(o));
  for (const m of P.music) if (!skip.has(m.id)) t.push(m.start, m.start + m.out - m.in);
  return t;
}
// Adjust a drag delta d so that one of the edges lands on a target within 8px; shows the snap line.
function snapDelta(d, edges, targets) {
  let best = null;
  for (const e of edges) for (const t of targets) {
    const dist = Math.abs(e + d - t);
    if (dist * pps <= 8 && (!best || dist < best.dist)) best = { dist, d: t - e, t };
  }
  const line = $('#snapLine');
  line.style.display = best ? 'block' : 'none';
  if (best) line.style.left = `${best.t * pps}px`;
  return best ? best.d : d;
}
const hideSnap = () => { $('#snapLine').style.display = 'none'; };

function clipDrag(e, c) {
  e.preventDefault();
  if (pickFromEvent(e, 'clip', c.id)) return;
  const tv = $('#trackVideo'), x0 = e.clientX;
  let marker = null, pos = null;
  const move = (ev) => {
    if (Math.abs(ev.clientX - x0) < 5 && !marker) return;
    const x = (ev.clientX - tv.getBoundingClientRect().left) / pps;
    const others = L.clips.filter((o) => o.id !== c.id);
    const before = others.filter((o) => o.start + o.duration / 2 < x);
    pos = before.length + 1;
    const mx = before.length ? before[before.length - 1].end : 0;
    marker ||= tv.appendChild(h('div', { class: 'drop-marker' }));
    marker.style.left = `${mx * pps - 1}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    marker?.remove();
    if (pos && pos !== c.index + 1) tool('move_clip', { clipId: c.id, position: pos });
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function trimDrag(e, c, edge) {
  e.preventDefault(); e.stopPropagation();
  select('clip', c.id);
  const a = P.assets[c.assetId];
  const max = a.type === 'image' || c.freeze ? 3600 : a.duration;
  const x0 = e.clientX, block = e.target.parentElement;
  // A reversed clip plays out..in, so its right edge is the source "in".
  const field = c.reverse ? (edge === 'in' ? 'out' : 'in') : edge, sign = c.reverse ? -1 : 1, rate = avgRate(c);
  const targets = snapTargets(new Set([c.id]));
  let v = c[field];
  const move = (ev) => {
    let dt = (ev.clientX - x0) / pps;
    if (edge === 'out') dt = snapDelta(dt, [c.end], targets);
    const d = dt * rate * sign;
    v = field === 'in' ? Math.min(c.out - 0.1, Math.max(0, c.in + d)) : Math.max(c.in + 0.1, Math.min(max, c.out + d));
    const dur = (field === 'in' ? c.out - v : v - c.in) / rate;
    block.style.width = `${dur * pps}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    hideSnap();
    if (Math.abs(v - c[field]) > 0.01) tool('trim_clip', { clipId: c.id, [field]: +v.toFixed(3) });
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function rangeDrag(e, kind, item, mode) {
  e.preventDefault(); e.stopPropagation();
  if (pickFromEvent(e, kind, item.id)) return;
  const x0 = e.clientX, block = mode === 'end' ? e.target.parentElement : e.currentTarget;
  const end = kind === 'text' ? item.end : kind === 'overlay' ? item.start + ovDur(item) : item.start + item.out - item.in;
  // Dragging one of several selected items (or a grouped one) moves them all.
  const group = mode === 'move' ? [...picked].filter(([, k]) => k !== 'clip').map(([id]) => id) : [];
  const together = group.length > 1 && group.includes(item.id);
  const others = together ? group.filter((id) => id !== item.id).map((id) => $(`[data-id="${id}"]`)).filter(Boolean) : [];
  const first = together ? Math.min(...others.map((el) => +el.dataset.start), item.start) : item.start;
  const targets = snapTargets(new Set(together ? group : [item.id]));
  let d = 0;
  const move = (ev) => {
    d = (ev.clientX - x0) / pps;
    if (mode === 'move') {
      d = snapDelta(Math.max(-first, d), [item.start, end], targets);
      d = Math.max(-first, d);
      block.style.left = `${(item.start + d) * pps}px`;
      for (const el of others) el.style.left = `${(+el.dataset.start + d) * pps}px`;
    } else { d = snapDelta(Math.max(0.1 - (item.end - item.start), d), [item.end], targets); block.style.width = `${(item.end - item.start + d) * pps}px`; }
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    hideSnap();
    if (Math.abs(d) < 0.02) return;
    if (together) tool('move_items', { ids: group, by: +d.toFixed(3) });
    else if (kind === 'text') tool('update_text', mode === 'move'
      ? { textId: item.id, start: +(item.start + d).toFixed(3), end: +(item.end + d).toFixed(3) }
      : { textId: item.id, end: +(item.end + d).toFixed(3) });
    else if (kind === 'overlay') tool('set_overlay', { overlayId: item.id, start: +(item.start + d).toFixed(3) });
    else tool('update_music', { musicId: item.id, start: +(item.start + d).toFixed(3) });
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

$('#ruler').addEventListener('pointerdown', (e) => {
  const r = $('#ruler').getBoundingClientRect();
  const go = (ev) => seek((ev.clientX - r.left) / pps);
  go(e);
  window.addEventListener('pointermove', go);
  window.addEventListener('pointerup', () => window.removeEventListener('pointermove', go), { once: true });
});
for (const id of ['#trackVideo', '#trackOverlay', '#trackText', '#trackMusic']) {
  $(id).addEventListener('pointerdown', (e) => {
    if (e.target === e.currentTarget) { seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / pps); if (!(e.ctrlKey || e.metaKey || e.shiftKey)) select(null); }
  });
}
$('#zoom').addEventListener('input', (e) => { pps = +e.target.value; renderTimeline(); renderFrame(true); });

// ---------- Inspector ----------
function select(kind, id, focusTransition) {
  sel = kind ? { kind, id } : null;
  picked.clear();
  if (kind) {
    picked.set(id, kind);
    const it = kind === 'clip' ? null : [...P.texts, ...P.overlays, ...P.music].find((x) => x.id === id);
    if (it?.group) for (const x of [...P.texts, ...P.overlays, ...P.music]) if (x.group === it.group) picked.set(x.id, kindOf(x));
  }
  renderTimeline(); renderInspector(); renderTexts(time);
  if (focusTransition) $('#insp-trans')?.focus();
}
// Voice effect + pitch (VOICE_EFFECTS in src/model.js; export only).
const VOICE_EFFECTS = ['none', 'chipmunk', 'deep', 'robot', 'echo', 'hall', 'telephone', 'radio', 'megaphone'];
const voiceFields = (x, set) => [
  h('label', { title: 'Voice effect (export only, not in this preview)' }, 'Voice', h('select', { onchange: (e) => set({ voiceEffect: e.target.value }) },
    ...VOICE_EFFECTS.map((v) => h('option', { value: v, selected: (x.voice || 'none') === v }, v)))),
  field('Pitch', x.pitch || 0, (v) => set({ pitch: v }), { min: -12, max: 12, step: '1', title: 'Semitones, speed unchanged (export only)' }),
];
const MASK_SHAPES = ['none', 'circle', 'rect', 'linear', 'mirror'];
function maskFields(o) {
  const m = o.mask, set = (x) => tool('set_mask', { overlayId: o.id, ...x });
  const line = m && (m.shape === 'linear' || m.shape === 'mirror');
  return [
    h('label', { title: 'Show only part of the overlay: circle / rect cut-out, linear = split screen, mirror = band' }, 'Mask', h('select', { onchange: (e) => set({ shape: e.target.value }) },
      ...MASK_SHAPES.map((v) => h('option', { value: v, selected: (m?.shape || 'none') === v }, v)))),
    ...(!m ? [] : [
      field('MX', m.x, (v) => set({ x: v }), { step: '0.05', title: 'Mask center x (fraction of the overlay)' }),
      field('MY', m.y, (v) => set({ y: v }), { step: '0.05', title: 'Mask center y' }),
      line ? field('Angle', m.angle, (v) => set({ angle: v }), { step: '15', title: '0 keeps below the line, 90 keeps the left, -90 the right, 180 above' }) : field('MW', m.w, (v) => set({ w: v }), { step: '0.05', title: 'Mask width' }),
      m.shape !== 'linear' ? field('MH', m.h, (v) => set({ h: v }), { step: '0.05', title: m.shape === 'mirror' ? 'Band thickness' : 'Mask height' }) : null,
      field('Feather', m.feather || 0, (v) => set({ feather: v }), { min: 0, max: 1, step: '0.05' }),
      h('label', {}, 'Invert', h('input', { type: 'checkbox', checked: !!m.invert, onchange: (e) => set({ invert: e.target.checked }) })),
    ]),
  ];
}
const denoiseField = (v, set) => field('Denoise', v || 0, set, { min: 0, max: 1, step: '0.1', title: 'Noise reduction for hiss, fan or wind noise: 0 = off, 0.5 = typical (export only, not in this preview)' });
function field(label, value, onchange, attrs = {}) {
  return h('label', {}, label, h('input', { type: 'number', step: '0.1', value, ...attrs, onchange: (e) => onchange(+e.target.value) }));
}
const lookSelect = (target, color) => h('label', {}, 'Look', h('select', { onchange: (e) => tool('set_color', { ...target, filter: e.target.value }) },
  ...FILTERS.map((f) => h('option', { value: f, selected: (color?.filter || 'none') === f }, f))));
function colorFields(target, color) {
  const c = color || {};
  return [
    lookSelect(target, color),
    c.filter ? field('Mix', c.filterIntensity ?? 1, (v) => tool('set_color', { ...target, filterIntensity: v }), { min: 0, max: 1, step: '0.1' }) : null,
    luts.length || c.lut ? h('label', { title: 'Imported .cube LUT (shows in export and look_at_timeline, not in this preview)' }, 'LUT', h('select', { onchange: (e) => tool('set_color', { ...target, lut: e.target.value }) },
      ...['none', ...luts].map((x) => h('option', { value: x, selected: (c.lut || 'none') === x }, x.replace(/\.cube$/i, ''))))) : null,
    c.lut ? field('LUT mix', c.lutIntensity ?? 1, (v) => tool('set_color', { ...target, lutIntensity: v }), { min: 0, max: 1, step: '0.1' }) : null,
    field('Bright', c.brightness ?? 0, (v) => tool('set_color', { ...target, brightness: v }), { min: -1, max: 1, step: '0.05' }),
    field('Contrast', c.contrast ?? 1, (v) => tool('set_color', { ...target, contrast: v }), { min: 0, max: 3, step: '0.05' }),
    field('Sat', c.saturation ?? 1, (v) => tool('set_color', { ...target, saturation: v }), { min: 0, max: 3, step: '0.05' }),
    field('Temp', c.temperature ?? 0, (v) => tool('set_color', { ...target, temperature: v }), { min: -1, max: 1, step: '0.1' }),
  ];
}
const animSelect = (c, key, label) => h('label', {}, label, h('select', { onchange: (e) => tool('set_clip', { clipId: c.id, [key]: e.target.value }) },
  ...CLIP_ANIMS.map((a) => h('option', { value: a, selected: (c[key]?.type || 'none') === a }, a))));
function renderInspector() {
  const box = $('#inspector');
  const it = findSel();
  if (picked.size > 1) {
    const ids = [...picked.keys()];
    const timed = [...picked.values()].filter((k) => k !== 'clip').length;
    const grouped = [...P.texts, ...P.overlays, ...P.music].some((x) => picked.has(x.id) && x.group);
    return box.replaceChildren(h('div', { class: 'insp' },
      h('span', { class: 'title' }, `${picked.size} items selected`),
      h('button', { class: 'small', title: 'Ctrl+D', onclick: () => tool('duplicate_items', { ids }) }, '⧉ Duplicate'),
      timed >= 2 && !grouped ? h('button', { class: 'small', title: 'Ctrl+G', onclick: () => tool('group_items', { ids: ids.filter((id) => picked.get(id) !== 'clip') }) }, '⊞ Group') : null,
      grouped ? h('button', { class: 'small', title: 'Ctrl+Shift+G', onclick: () => tool('ungroup_items', { ids }) }, '⊟ Ungroup') : null,
      h('button', { class: 'small danger', onclick: () => tool('delete_items', { ids }) }, 'Delete all'),
      h('span', { class: 'note' }, 'Drag one to move them together · Ctrl+C / Ctrl+V to paste at the playhead')));
  }
  if (!it) return box.replaceChildren();
  let content;
  if (sel.kind === 'clip') {
    const c = it, a = P.assets[c.assetId];
    const rampSel = h('label', { title: 'Speed that changes over the clip; audio keeps its pitch' }, 'Ramp', h('select', { onchange: (e) => tool('set_speed_ramp', { clipId: c.id, preset: e.target.value }) },
      ...['none', ...Object.keys(RAMP_PRESETS)].map((r) => h('option', { value: r, selected: (c.ramp?.preset || 'none') === r && !(c.ramp && !c.ramp.preset) }, r.replace('_', ' '))),
      c.ramp && !c.ramp.preset ? h('option', { value: '', selected: true, disabled: true }, 'custom') : null));
    content = [
      h('span', { class: 'title' }, `Clip #${c.index + 1} · ${a.name}${c.freeze ? ' · freeze frame' : ''}`),
      ...(c.freeze ? [
        field('Frame at', c.in, (v) => tool('trim_clip', { clipId: c.id, in: v, out: +(v + c.out - c.in).toFixed(3) }), { step: '0.04' }),
        field('Hold', +(c.out - c.in).toFixed(2), (v) => tool('trim_clip', { clipId: c.id, out: +(c.in + v).toFixed(3) }), { min: 0.1, step: '0.1' }),
      ] : [
        field('In', c.in, (v) => tool('trim_clip', { clipId: c.id, in: v }), { step: '0.05' }),
        field('Out', c.out, (v) => tool('trim_clip', { clipId: c.id, out: v }), { step: '0.05' }),
        field('Speed', c.speed, (v) => tool('set_clip', { clipId: c.id, speed: v }), { min: 0.25, max: 4, step: '0.25', title: c.ramp ? 'Setting a speed replaces the ramp' : undefined }),
      ]),
      a.type === 'video' && !c.freeze ? rampSel : null,
      a.type === 'video' && !c.freeze ? h('label', { title: 'Play backwards (up to 10s of source). The preview shows it by seeking, without sound.' }, 'Reverse', h('input', { type: 'checkbox', checked: !!c.reverse, onchange: (e) => tool('set_clip', { clipId: c.id, reverse: e.target.checked }) })) : null,
      field('Volume', c.volume, (v) => tool('set_clip', { clipId: c.id, volume: v }), { min: 0, max: 2, step: '0.1' }),
      a.type === 'video' && a.hasAudio && !c.freeze ? denoiseField(c.denoise, (v) => tool('set_clip', { clipId: c.id, denoise: v })) : null,
      ...(a.type === 'video' && a.hasAudio && !c.freeze ? voiceFields(c, (x) => tool('set_clip', { clipId: c.id, ...x })) : []),
      a.type === 'video' && !c.freeze ? h('label', { title: 'Fill in frames of slowed clips: blend = fast, motion = smoothest (slow to export). Export only' }, 'Smooth', h('select', { onchange: (e) => tool('set_clip', { clipId: c.id, smoothSlowMo: e.target.value }) },
        ...['off', 'blend', 'motion'].map((v) => h('option', { value: v, selected: (c.smooth || 'off') === v }, v)))) : null,
      h('label', {}, 'Fit', h('select', { onchange: (e) => tool('set_clip', { clipId: c.id, fit: e.target.value }) },
        ...['contain', 'cover', 'blur'].map((f) => h('option', { value: f, selected: (c.fit || 'contain') === f }, f)))),
      c.index > 0 ? h('label', {}, 'Transition in', h('select', { id: 'insp-trans', onchange: (e) => tool('set_transition', { clipId: c.id, type: e.target.value, duration: c.transition?.duration || 0.5 }) },
        ...TRANSITIONS.map((t) => h('option', { value: t, selected: (c.transition?.type || 'none') === t }, t)))) : null,
      c.index > 0 && c.transition?.type !== 'none' ? field('Dur', c.transition.duration, (v) => tool('set_transition', { clipId: c.id, type: c.transition.type, duration: v }), { min: 0.1, max: 5 }) : null,
      animSelect(c, 'animIn', 'Anim in'), animSelect(c, 'animOut', 'Anim out'),
      ...colorFields({ clipId: c.id }, c.color),
      c.effects?.length ? h('span', { class: 'note', title: 'The preview approximates effects; export and look_at_timeline show the real look' }, `✦ ${c.effects.map((e) => e.type).join(', ')}`) : null,
      a.type !== 'audio' ? h('button', { class: 'small', title: 'Find the face in this clip and make the crop follow it (local face detector)', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = '⌖ Finding faces…';
        const r = await tool('auto_reframe', { clipId: c.id });
        if (!r.isError && !r.error) addMsg('assistant', String(r.content).split('\n').slice(1, 2).join(' ').replace(/^#\d+ \S+: /, 'Auto reframe: '));
        e.target.disabled = false; e.target.textContent = '⌖ Auto reframe';
      } }, '⌖ Auto reframe') : null,
      c.reframe ? h('span', { class: 'note', title: 'The crop follows the subject (set by reframe_clip: ask Claude to reframe this clip)' },
        `⌖ reframe: ${c.reframe.points.length} point${c.reframe.points.length > 1 ? 's' : ''}${c.reframe.zoom ? `, ${c.reframe.zoom}x` : ''}`,
        h('button', { class: 'small ghost', title: 'Remove the reframe', onclick: () => tool('reframe_clip', { clipId: c.id, points: [] }) }, '✕')) : null,
      h('button', { class: 'small', onclick: () => tool('split_clip', { at: time, clipId: c.id }) }, '✂ Split at playhead'),
      a.type === 'video' && !c.freeze ? h('button', { class: 'small', title: 'Hold the frame at the playhead for 2s (F)', onclick: () => tool('freeze_frame', { clipId: c.id, at: +Math.min(Math.max(time, c.start), c.end - 0.01).toFixed(3) }) }, '❄ Freeze frame') : null,
      h('button', { class: 'small danger', onclick: () => tool('delete_clip', { clipId: c.id }) }, 'Delete'),
    ];
  } else if (sel.kind === 'text') {
    const x = it;
    content = [
      h('span', { class: 'title' }, 'Text'),
      h('label', {}, h('input', { type: 'text', value: x.text, onchange: (e) => tool('update_text', { textId: x.id, text: e.target.value }) })),
      field('Start', x.start, (v) => tool('update_text', { textId: x.id, start: v })),
      field('End', x.end, (v) => tool('update_text', { textId: x.id, end: v })),
      field('Size', x.size, (v) => tool('update_text', { textId: x.id, size: v }), { step: '2' }),
      h('label', {}, 'Color', h('input', { type: 'color', value: x.color, onchange: (e) => tool('update_text', { textId: x.id, color: e.target.value }) })),
      h('label', {}, 'Box', h('input', { type: 'checkbox', checked: x.box, onchange: (e) => tool('update_text', { textId: x.id, box: e.target.checked }) })),
      h('label', {}, 'Anim', h('select', { onchange: (e) => tool('update_text', { textId: x.id, animation: e.target.value }) },
        ...['none', 'fade', 'pop', 'slideup'].map((a) => h('option', { value: a, selected: (x.animation || 'none') === a }, a)))),
      h('button', { class: 'small danger', onclick: () => tool('delete_text', { textId: x.id }) }, 'Delete'),
    ];
  } else if (sel.kind === 'overlay') {
    const o = it;
    content = [
      h('span', { class: 'title' }, `Overlay · ${P.assets[o.assetId]?.name}`),
      field('Start', o.start, (v) => tool('set_overlay', { overlayId: o.id, start: v })),
      field('Dur', +ovDur(o).toFixed(2), (v) => tool('set_overlay', { overlayId: o.id, duration: v })),
      h('label', {}, 'Fit', h('select', { onchange: (e) => tool('set_overlay', { overlayId: o.id, fit: e.target.value }) },
        ...['free', 'cover', 'contain'].map((f) => h('option', { value: f, selected: o.fit === f }, f)))),
      field('X', o.x, (v) => tool('set_overlay', { overlayId: o.id, x: v }), { step: '0.05' }),
      field('Y', o.y, (v) => tool('set_overlay', { overlayId: o.id, y: v }), { step: '0.05' }),
      field('Width', o.scale, (v) => tool('set_overlay', { overlayId: o.id, scale: v }), { step: '0.05' }),
      field('Opacity', o.opacity, (v) => tool('set_overlay', { overlayId: o.id, opacity: v }), { min: 0, max: 1, step: '0.1' }),
      P.assets[o.assetId]?.type === 'video' ? field('Volume', o.volume, (v) => tool('set_overlay', { overlayId: o.id, volume: v }), { min: 0, max: 2, step: '0.1' }) : null,
      h('label', { title: 'How the overlay mixes with the video under it. screen: light leaks, fire, sparkles on black. multiply: paper and textures' }, 'Blend',
        h('select', { onchange: (e) => tool('set_overlay', { overlayId: o.id, blend: e.target.value }) },
          ...BLEND_MODES.map((m) => h('option', { value: m, selected: (o.blend || 'normal') === m }, m)))),
      h('label', { title: 'Remove a green or blue screen behind the subject (export and look_at_timeline; not in this preview)' }, 'Key',
        h('select', { onchange: (e) => tool('set_overlay', { overlayId: o.id, chromaKey: e.target.value }) },
          ...[['none', 'off'], ['green', 'green screen'], ['blue', 'blue screen']].map(([v, l]) => h('option', { value: v, selected: v === 'none' ? !o.key : o.key?.color === ({ green: '#00ff00', blue: '#0000ff' })[v] }, l)),
          o.key && !['#00ff00', '#0000ff'].includes(o.key.color) ? h('option', { value: o.key.color, selected: true }, o.key.color) : null)),
      o.key ? h('input', { type: 'color', value: o.key.color, title: 'Exact backdrop color', onchange: (e) => tool('set_overlay', { overlayId: o.id, chromaKey: e.target.value }) }) : null,
      o.key ? field('Similarity', o.key.similarity, (v) => tool('set_overlay', { overlayId: o.id, keySimilarity: v }), { min: 0.01, max: 1, step: '0.05', title: 'Raise if backdrop remains, lower if the subject gets holes' }) : null,
      o.key ? field('Edge', o.key.blend, (v) => tool('set_overlay', { overlayId: o.id, keyBlend: v }), { min: 0, max: 1, step: '0.02', title: 'Edge softness' }) : null,
      o.key ? h('label', { class: 'key-note' }, 'key shows in export') : null,
      P.assets[o.assetId]?.type === 'video' && P.assets[o.assetId]?.hasAudio ? denoiseField(o.denoise, (v) => tool('set_overlay', { overlayId: o.id, denoise: v })) : null,
      ...(P.assets[o.assetId]?.type === 'video' && P.assets[o.assetId]?.hasAudio ? voiceFields(o, (x) => tool('set_overlay', { overlayId: o.id, ...x })) : []),
      P.assets[o.assetId]?.type === 'video' ? h('label', { title: 'Repeat the video / GIF for the whole overlay length' }, 'Loop', h('input', { type: 'checkbox', checked: !!o.loop, onchange: (e) => tool('set_overlay', { overlayId: o.id, loop: e.target.checked }) })) : null,
      h('label', {}, 'Anim', h('select', { onchange: (e) => tool('set_overlay', { overlayId: o.id, animation: e.target.value }) },
        ...['none', 'fade', 'pop'].map((v) => h('option', { value: v, selected: (o.animation || 'none') === v }, v)))),
      ...maskFields(o),
      lookSelect({ overlayId: o.id }, o.color),
      o.keyframes ? h('span', { class: 'note' }, `◆ keyframes: ${Object.keys(o.keyframes).join(', ')}`) : null,
      h('button', { class: 'small danger', onclick: () => tool('delete_overlay', { overlayId: o.id }) }, 'Delete'),
    ];
  } else {
    const m = it;
    content = [
      h('span', { class: 'title' }, `${m.role || 'music'} · ${P.assets[m.assetId]?.name}`),
      field('Start', m.start, (v) => tool('update_music', { musicId: m.id, start: v })),
      field('In', m.in, (v) => tool('update_music', { musicId: m.id, in: v })),
      field('Out', m.out, (v) => tool('update_music', { musicId: m.id, out: v })),
      field('Volume', m.volume, (v) => tool('update_music', { musicId: m.id, volume: v }), { min: 0, max: 2, step: '0.05' }),
      field('Fade in', m.fadeIn, (v) => tool('update_music', { musicId: m.id, fadeIn: v })),
      field('Fade out', m.fadeOut, (v) => tool('update_music', { musicId: m.id, fadeOut: v })),
      denoiseField(m.denoise, (v) => tool('update_music', { musicId: m.id, denoise: v })),
      ...voiceFields(m, (x) => tool('update_music', { musicId: m.id, ...x })),
      m.role !== 'voice' ? field('Duck', m.duck || 0, (v) => tool('update_music', { musicId: m.id, duck: v }), { min: 0, max: 1, step: '0.1', title: 'Lower under speech (export only)' }) : null,
      h('button', { class: 'small', title: 'Detect beats and add beat markers', onclick: () => tool('mark_beats', { musicId: m.id }) }, '♩ Mark beats'),
      h('button', { class: 'small danger', onclick: () => tool('delete_music', { musicId: m.id }) }, 'Delete'),
    ];
  }
  box.replaceChildren(h('div', { class: 'insp' }, ...content));
}

// ---------- Export ----------
function renderJobs() {
  // Finished proxies: reload those videos from the proxy.
  let fresh = false;
  for (const j of jobs) if (j.kind === 'proxy' && j.status === 'done' && !proxied.has(j.file)) { proxied.add(j.file); fresh = true; }
  if (fresh && P) renderFrame(true);
  const proxies = jobs.filter((j) => j.kind === 'proxy' && j.status === 'running');
  const recent = jobs.filter((j) => !j.kind || j.kind === 'export').slice(-3).reverse();
  $('#jobs').replaceChildren(...proxies.map((j) => h('span', { title: `Making a smooth preview copy of ${j.name}` }, `Preparing preview ${Math.round(j.progress * 100)}%`)), ...recent.map((j) => j.status === 'running'
    ? h('span', {}, `Rendering ${j.quality}… ${Math.round(j.progress * 100)}%`)
    : j.status === 'done' ? h('a', { href: `/exports/${j.file}`, target: '_blank', title: j.file }, `▶ ${j.quality} ready`)
      : h('span', { style: { color: 'var(--danger)' }, title: j.error }, 'Render failed')));
}
async function exportVideo(quality) {
  const r = await tool('export_video', { quality });
  if (r.content?.startsWith?.('Error')) return;
}
$('#exportDraft').onclick = () => exportVideo('draft');
$('#exportCover').onclick = async () => {
  const r = await tool('export_cover', { t: +time.toFixed(3) });
  const text = Array.isArray(r.content) ? r.content.find((b) => b.type === 'text')?.text : r.content;
  const url = /URL (\/exports\/[^\s)]+)/.exec(text || '')?.[1];
  if (url) { addMsg('assistant', `Cover image saved: ${url}`); window.open(url, '_blank'); }
};
$('#exportFinal').onclick = () => exportVideo('final');

// ---------- Upload ----------
async function upload(files) {
  if (!files.length) return null;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  addMsg('action', `Importing ${files.length} file(s)…`);
  const r = await fetch('/api/upload', { method: 'POST', body: form }).then((x) => x.json());
  if (r.error) toast(r.error); else {
    setState(r);
    if (r.luts?.length) addMsg('assistant', `Imported LUT ${r.luts.join(', ')}: pick it under LUT in a clip's color settings.`);
    if (r.fonts?.length) addMsg('assistant', `Imported font ${r.fonts.join(', ')}.`);
  }
  return r;
}

// ---------- Voiceover recording ----------
// Records the microphone while the timeline plays from the playhead (preview sound muted to avoid echo),
// then imports the take and puts it on a voice track at the time recording started.
async function toggleRecord() {
  if (rec) { rec.mr.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return toast('This browser cannot record audio.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { return toast(`Microphone not available: ${e.message}`); }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t));
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = [];
  const start = time;
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    rec = null; pause(); renderRecord();
    const blob = new Blob(chunks, { type: mr.mimeType || type || 'audio/webm' });
    if (blob.size < 2000) return toast('The recording was empty.');
    const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    const r = await upload([new File([blob], `voiceover-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type: blob.type })]);
    const a = r?.added?.[0];
    if (a) await tool('add_music', { assetId: a.id, role: 'voice', start: +start.toFixed(2) });
  };
  rec = { mr, t0: performance.now() };
  mr.start(250);
  if (L.clips.length) play();
  renderRecord();
}
function renderRecord() {
  const b = $('#record');
  b.classList.toggle('recording', !!rec);
  b.textContent = rec ? `■ Stop ${fmt((performance.now() - rec.t0) / 1000)}` : '🎙 Record';
}
$('#fileInput').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (e.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]);
});

// ---------- Chat ----------
function addMsg(kind, text) {
  const box = $('#messages');
  const el = h('div', { class: kind === 'action' ? 'action' : kind === 'action-err' ? 'action err' : `msg ${kind}` }, text);
  box.append(el); box.scrollTop = box.scrollHeight;
  return el;
}
let chatBusy = false;
$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text || chatBusy) return;
  chatBusy = true; $('#chatSend').disabled = true;
  $('#chatInput').value = '';
  addMsg('user', text);
  const typing = addMsg('assistant typing', 'Claude is editing…');
  try {
    const r = await api('/api/chat', { message: text });
    typing.remove();
    if (r.error) addMsg('error', r.error); else addMsg('assistant', r.reply || 'Done.');
  } catch (err) { typing.remove(); addMsg('error', err.message); }
  chatBusy = false; $('#chatSend').disabled = false; $('#chatInput').focus();
};
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
$('#chatReset').onclick = async () => { await api('/api/chat/reset', {}); $('#messages').replaceChildren(); addMsg('assistant', 'New conversation. What should we make?'); };

// ---------- Live updates (edits from chat / Claude Code MCP) ----------
const es = new EventSource('/api/events');
es.addEventListener('project', (e) => { const d = JSON.parse(e.data); setState({ project: d.project, layout: d.layout }); });
es.addEventListener('jobs', (e) => { jobs = JSON.parse(e.data); renderJobs(); });
es.addEventListener('chat-action', (e) => {
  const d = JSON.parse(e.data);
  if (chatBusy) {
    const typing = $('#messages .typing');
    const label = d.tool === 'get_timeline' ? 'Read the timeline' : d.tool === 'look_at_asset' ? `Looked at ${d.result.split(': ')[1] || 'frames'}` : d.result;
    const el = addMsg(d.error ? 'action-err' : 'action', label.length > 110 ? label.slice(0, 110) + '…' : label);
    if (typing) $('#messages').insertBefore(el, typing);
  }
});

// ---------- Header / keys ----------
$('#undo').onclick = () => tool('undo');
$('#redo').onclick = () => tool('redo');
$('#aspect').onchange = (e) => tool('set_canvas', { aspect: e.target.value });
$('#play').onclick = () => (playing ? pause() : play());
$('#toStart').onclick = () => seek(0);
$('#split').onclick = () => tool('split_clip', { at: +time.toFixed(3) });
$('#addText').onclick = async () => {
  const r = await tool('add_text', { text: 'Your text', start: +time.toFixed(2), end: +(time + 2).toFixed(2), y: 0.5, size: 80 });
  const m = /text_\w+/.exec(r.content || '');
  if (m) select('text', m[0]);
};
$('#freeze').onclick = () => tool('freeze_frame', { at: +time.toFixed(3) });
$('#record').onclick = toggleRecord;
// Text to speech: a small panel under the Voice button; the voiceover goes on at the playhead.
// Engine, ElevenLabs key, model and voice are saved on the server (GET/POST /api/tts); the key is write-only.
let tts = null;
const exprTouched = { v: false };
async function loadTts() {
  tts = await (await fetch('/api/tts?voices')).json();
  renderTts();
}
function renderTts() {
  if (!tts) return;
  const eng = $('#ttsEngine').value = tts.engine;
  const el = tts.elevenlabs;
  $('#ttsEleven').hidden = eng !== 'elevenlabs';
  $('#ttsKeyState').textContent = el.hasKey ? `API key ${el.keyHint}${el.keySource === 'env' ? ' (from ELEVENLABS_API_KEY)' : ''}` : 'No API key yet';
  $('#ttsKeyEdit').textContent = el.hasKey ? '⚙ Change key' : '⚙ Add key';
  const models = tts.elevenlabsModels || [];
  $('#ttsModel').replaceChildren(...(models.length ? models : [{ id: el.model, name: el.model }]).map((m) => h('option', { value: m.id, selected: m.id === el.model }, `${m.name}${m.vi ? ' · Vietnamese' : ''}`)));
  const sel = $('#ttsVoice');
  if (eng === 'elevenlabs') {
    const vs = tts.elevenlabsVoices || [];
    sel.replaceChildren(...vs.map((v) => h('option', { value: v.id, selected: v.id === el.voice || (!el.voice && v === vs[0]) },
      `${v.name}${v.labels?.gender ? ` · ${[v.labels.gender, v.labels.accent].filter(Boolean).join(', ')}` : ''}`)));
  } else {
    sel.replaceChildren(h('option', { value: '' }, 'Auto voice'), ...tts.piper.voices.map((v) => h('option', { value: v.id }, v.id)));
  }
  $('#ttsNote').textContent = eng === 'elevenlabs'
    ? (!el.hasKey ? 'Add your ElevenLabs API key in ⚙ Settings (elevenlabs.io → Developers → API keys). It stays on this PC.' : tts.elevenlabsError || 'Billed per character by ElevenLabs. With eleven_v3 you can add tags like [excited] or [whispers] in the text.')
    : !tts.piper.installed ? 'Piper is not installed: see README (Text to speech).' : !tts.piper.voices.length ? 'No Piper voices installed: see README.' : '';
}
async function saveTts(body) {
  const r = await (await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.error) { $('#ttsNote').textContent = r.error; return false; }
  await loadTts();
  return true;
}
$('#ttsOpen').onclick = () => {
  const box = $('#ttsBox');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  loadTts();
  $('#ttsText').focus();
};
$('#ttsEngine').onchange = (e) => saveTts({ engine: e.target.value });
$('#ttsModel').onchange = (e) => saveTts({ elevenlabsModel: e.target.value });
$('#ttsVoice').onchange = (e) => { if ($('#ttsEngine').value === 'elevenlabs') saveTts({ elevenlabsVoice: e.target.value }); };
$('#ttsExpr').oninput = () => { exprTouched.v = true; };
$('#ttsKeyEdit').onclick = () => openSettings('tts.elevenlabs.apiKey');

// ---------- ⚙ Settings (src/settings.js via /api/settings) ----------
// Each field saves on change; API keys are write-only (only "set …abcd" comes back). A setting that an
// environment variable provides is shown read-only, since the variable wins.
const SETTING_GROUPS = [
  ['In-app chat (Claude)', ['claude.apiKey', 'claude.model']],
  ['Text to speech', ['tts.engine', 'tts.elevenlabs.apiKey', 'tts.piperCommand']],
  ['Captions', ['captions.whisperModel']],
  ['Text', ['text.defaultFont']],
  ['Export', ['export.loudness']],
];
const CHOICE_LABELS = { 'export.loudness': { '-14': '-14 LUFS (TikTok, Reels, Shorts, YouTube)', '-16': '-16 LUFS (podcasts, Apple)', '-23': '-23 LUFS (TV broadcast)', off: 'Off (keep the mix as it is)' } };
const SETTING_HELP = {
  'claude.apiKey': 'console.anthropic.com → API keys. Not needed when you edit from Claude Code (MCP).',
  'tts.elevenlabs.apiKey': 'elevenlabs.io → Developers → API keys. Pick the model and voice in the 🗣 Voice panel.',
  'tts.piperCommand': 'Path to a piper executable. Leave empty to use "python -m piper" (pip install piper-tts).',
  'captions.whisperModel': 'Models in models/. Auto picks the most accurate one found.',
  'text.defaultFont': 'Used by texts and captions that do not set a font.',
  'export.loudness': 'Every export is measured and brought to this loudness, so reels are never too quiet or too loud next to others. Claude can override it per export.',
};
async function openSettings(focusKey) {
  $('#settingsDlg').hidden = false;
  $('#settingsNote').textContent = '';
  await renderSettings((await (await fetch('/api/settings')).json()));
  if (focusKey) $(`#settingsBody [data-key="${focusKey}"] input`)?.focus();
}
const closeSettings = () => { $('#settingsDlg').hidden = true; if (!$('#ttsBox').hidden) loadTts(); };
async function saveSetting(key, value) {
  $('#settingsNote').textContent = /apiKey/.test(key) && value ? 'Checking the key…' : 'Saving…';
  const r = await (await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) })).json();
  if (r.error) { $('#settingsNote').textContent = r.error; return false; }
  $('#settingsNote').textContent = r.notes?.length ? r.notes.join(' ') : '✓ Saved';
  renderSettings(r);
  if (key === 'claude.apiKey') fetch('/api/state').then((x) => x.json()).then(setState);
  return true;
}
function renderSettings({ settings: S, choices: C }) {
  const field = (key) => {
    const s = S[key];
    const envNote = s.source === 'env' ? h('span', { class: 'note env' }, `from ${s.env} (environment variable wins)`) : null;
    let input;
    if (s.secret) {
      const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: s.set ? 'Paste a new key to replace it' : 'Paste API key', disabled: s.source === 'env' });
      input = h('span', { class: 'secret' },
        h('span', { class: `keystate ${s.set ? 'on' : ''}` }, s.set ? `✓ set ${s.hint}` : 'not set'),
        s.source === 'env' ? null : pw,
        s.source === 'env' ? null : h('button', { class: 'small', onclick: async () => { if (pw.value.trim() && await saveSetting(key, pw.value.trim())) pw.value = ''; } }, 'Save'),
        s.set && s.source === 'file' ? h('button', { class: 'small danger', title: 'Remove the saved key', onclick: () => saveSetting(key, '') }, 'Remove') : null);
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.nextElementSibling?.click(); });
    } else {
      const opts = s.choices || (key === 'captions.whisperModel' ? ['', ...C.whisperModels] : key === 'claude.model' ? C.claudeModels : null);
      if (opts && key !== 'claude.model') {
        input = h('select', { disabled: s.source === 'env', onchange: (e) => saveSetting(key, e.target.value) },
          ...opts.map((o) => h('option', { value: o, selected: (s.value || '') === o }, CHOICE_LABELS[key]?.[o] || o || 'Auto')),
          s.value && !opts.includes(s.value) ? h('option', { value: s.value, selected: true }, s.value) : null);
      } else {
        const list = key === 'claude.model' ? 'dl-claude' : key === 'text.defaultFont' ? 'dl-fonts' : null;
        input = h('input', { type: 'text', value: s.value || '', placeholder: key === 'text.defaultFont' ? 'Auto (Arial…)' : 'Auto', list, disabled: s.source === 'env', onchange: (e) => saveSetting(key, e.target.value) });
      }
    }
    return h('div', { class: 'srow', 'data-key': key }, h('label', {}, s.label), h('div', { class: 'sval' }, input, envNote, SETTING_HELP[key] ? h('span', { class: 'note' }, SETTING_HELP[key]) : null));
  };
  $('#settingsBody').replaceChildren(
    h('datalist', { id: 'dl-claude' }, ...C.claudeModels.map((m) => h('option', { value: m }))),
    h('datalist', { id: 'dl-fonts' }, ...C.fonts.map((f) => h('option', { value: f }))),
    ...SETTING_GROUPS.map(([title, keys]) => h('section', {}, h('h4', {}, title), ...keys.map(field))));
}
$('#settingsOpen').onclick = () => openSettings();
$('#settingsClose').onclick = closeSettings;
$('#settingsDlg').addEventListener('pointerdown', (e) => { if (e.target.id === 'settingsDlg') closeSettings(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settingsDlg').hidden) closeSettings(); });
$('#ttsAdd').onclick = async () => {
  const text = $('#ttsText').value.trim();
  if (!text) return $('#ttsText').focus();
  const b = $('#ttsAdd'), eng = $('#ttsEngine').value;
  b.disabled = true; $('#ttsNote').textContent = 'Speaking…';
  const r = await tool('add_voiceover', {
    text, start: +time.toFixed(3), engine: eng, ...($('#ttsVoice').value ? { voice: $('#ttsVoice').value } : {}),
    speed: +$('#ttsSpeed').value || 1, ...(exprTouched.v ? { expressiveness: +$('#ttsExpr').value } : {}),
  });
  b.disabled = false;
  const m = /: ([\d.]+)s of speech, voice (.+?) \((ElevenLabs [^,]+, \d+ characters|Piper)\)/.exec(String(r.content));
  $('#ttsNote').textContent = r.isError || r.error ? '' : m ? `✓ Added ${m[1]}s with ${m[2]} (${m[3]})` : '✓ Added';
  if (!r.isError && !r.error) $('#ttsText').value = '';
};
// Auto-captions: preset + language are remembered; the button runs add_captions (which transcribes as needed).
const CAPTION_PRESETS = ['classic', 'boxed', 'karaoke', 'highlight', 'single'];
$('#capPreset').replaceChildren(...CAPTION_PRESETS.map((p) => h('option', { value: p }, p[0].toUpperCase() + p.slice(1))));
$('#capPreset').value = store.get('capPreset') || 'karaoke';
$('#capLang').value = store.get('capLang') || 'auto';
$('#capPreset').onchange = (e) => {
  store.set('capPreset', e.target.value);
  if (P.captions?.lines?.length) tool('update_captions', { preset: e.target.value });
};
$('#capLang').onchange = (e) => store.set('capLang', e.target.value);
function renderCaptionButton() {
  const b = $('#captions');
  b.disabled = captioning;
  b.textContent = captioning ? 'Transcribing…' : P?.captions?.lines?.length ? 'CC Redo captions' : 'CC Captions';
  b.classList.toggle('nomodel', whisperModel === null);
  b.title = whisperModel === null ? 'No Whisper model installed: put ggml-large-v3-turbo-q5_0.bin or ggml-base.bin in models/ (see README)'
    : `Transcribe speech and add captions${whisperModel ? ` (model ${whisperModel})` : ''}`;
}
$('#captions').onclick = async () => {
  if (whisperModel === null) return toast('No Whisper model installed, so captions cannot be made yet. Download ggml-large-v3-turbo-q5_0.bin (most accurate) or ggml-base.bin (fastest) from https://huggingface.co/ggerganov/whisper.cpp into the models/ folder and restart the editor. See the README.');
  if (P.captions?.lines?.length && !confirm('Replace the existing captions (and any fixes you made to them)?')) return;
  captioning = true; renderCaptionButton();
  const note = addMsg('action', 'Transcribing speech for captions… (the first run of a file can take a while)');
  try {
    const r = await tool('add_captions', { preset: $('#capPreset').value, language: $('#capLang').value });
    note.textContent = r.isError || r.error ? 'Captions failed' : `✓ ${String(r.content).split('\n')[0]}`;
  } finally { captioning = false; renderCaptionButton(); }
};
// Busy button + one line in the chat panel for the one-click talking-head tools.
async function quickTool(btn, busy, name, input, failText) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = busy;
  try {
    const r = await tool(name, input);
    addMsg('action', r.error ? `${failText}: ${r.error}` : `${r.isError ? '' : '✓ '}${String(r.content).replace(/ ?Check with look_at_timeline\.?/, '')}`);
  } finally { btn.disabled = false; btn.textContent = label; }
}
$('#keywords').onclick = (e) => {
  if (!P.captions?.lines?.length) return toast('Add captions first (CC Captions), then highlight their key words.');
  quickTool(e.currentTarget, '★ …', 'emphasize_captions', { auto: true, clear: true }, 'Keywords failed');
};
$('#translate').onclick = () => {
  if (!P.captions?.lines?.length) return toast('Add captions first (CC Captions), then translate them.');
  const vi = /[ăâđêôơưàáạảãèéẹẻẽìíịỉĩòóọỏõùúụủũỳýỵỷỹ]/i.test(P.captions.lines.slice(0, 5).flatMap((l) => l.words.map((w) => w.w)).join(' '));
  $('#chatInput').value = `Translate the captions${P.texts.length ? ' and titles' : ''} into ${vi ? 'English' : 'Vietnamese'} and show them under the original (translate_captions mode below). Use mode copy instead if I say "make a copy".`;
  $('#chatInput').focus();
  toast('Edit the request if you like (language, below / replace / copy) and press Enter. Claude does the translating.');
};
// Reel checker and the safe-zone guide (SAFE_ZONES in src/check.js; keep in sync).
const SAFE_ZONES = [
  { name: 'top bar', x: 0, y: 0, w: 1, h: 0.08 },
  { name: 'buttons', x: 0.86, y: 0.38, w: 0.14, h: 0.45 },
  { name: 'username / description', x: 0, y: 0.8, w: 1, h: 0.2 },
];
$('#safeZones').replaceChildren(...SAFE_ZONES.map((z) => h('div', { style: { left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` } }, z.name)));
let safeOn = store.get('safe') === 'on';
const renderSafe = () => { $('#safeZones').hidden = !safeOn; $('#safeToggle').classList.toggle('on', safeOn); };
renderSafe();
$('#safeToggle').onclick = () => { safeOn = !safeOn; store.set('safe', safeOn ? 'on' : 'off'); renderSafe(); };
$('#checkReel').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const r = await tool('check_reel', {});
    addMsg(r.error ? 'error' : 'assistant', r.error || String(r.content));
    if (r.issues?.some((i) => i.area === 'safe zone') && !safeOn) { safeOn = true; renderSafe(); }
  } finally { b.disabled = false; }
};
$('#autoZoom').onclick = (e) => quickTool(e.currentTarget, '🔍 Zooming…', 'auto_zoom', {}, 'Auto zoom failed');
$('#tighten').onclick = async (e) => {
  if (whisperModel === null) return toast('Removing pauses needs a Whisper model (it reads where the words are). See the README.');
  const b = e.currentTarget;
  b.disabled = true; b.textContent = '✂ Finding pauses…';
  const note = addMsg('action', 'Finding pauses and filler words… (the first run of a file transcribes it)');
  try {
    const r = await tool('remove_silences', {});
    note.textContent = r.error ? `Remove pauses failed: ${r.error}` : `${r.isError ? '' : '✓ '}${String(r.content).split('\n').filter((l) => !/look_at_timeline/.test(l)).join(' ').replace(/ Check the jumps.*?\./, '')}`;
  } finally { b.disabled = false; b.textContent = '✂ Remove pauses'; }
};
$('#cutRange').onclick = () => range && tool('delete_range', { start: +range.in.toFixed(3), end: +range.out.toFixed(3) }).then((r) => { if (!r.isError && !r.error) { range = null; renderTimeline(); } });
$('#snap').onclick = () => { snapOn = !snapOn; store.set('snap', snapOn ? 'on' : 'off'); renderTimeline(); };
// Mark a range with I (in) and O (out); Shift+Delete removes it and closes the gap.
function markRange(edge) {
  const t = +time.toFixed(3);
  if (edge === 'in') range = { in: t, out: range && range.out > t ? range.out : Math.min(L.duration, t + 1) };
  else range = { in: range && range.in < t ? range.in : Math.max(0, t - 1), out: t };
  if (range.out - range.in < 0.05) range = null;
  renderTimeline();
}
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  else if (mod && key === 'c' && picked.size) clipboard = [...picked.keys()];
  else if (mod && key === 'v' && clipboard) { e.preventDefault(); tool('duplicate_items', { ids: clipboard, at: +time.toFixed(3) }); }
  else if (mod && key === 'd' && picked.size) { e.preventDefault(); tool('duplicate_items', { ids: [...picked.keys()] }); }
  else if (mod && key === 'g' && picked.size) {
    e.preventDefault();
    const ids = [...picked].filter(([, k]) => k !== 'clip').map(([id]) => id);
    if (ids.length) tool(e.shiftKey ? 'ungroup_items' : 'group_items', { ids });
  } else if (!mod && key === 's') tool('split_clip', { at: +time.toFixed(3) });
  else if (!mod && key === 'f') tool('freeze_frame', { at: +time.toFixed(3) });
  else if (!mod && key === 'i') markRange('in');
  else if (!mod && key === 'o') markRange('out');
  else if (e.key === 'Escape') { range = null; select(null); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey && range) $('#cutRange').click();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && picked.size > 1) tool('delete_items', { ids: [...picked.keys()] });
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
    const it = { clip: ['delete_clip', 'clipId'], overlay: ['delete_overlay', 'overlayId'], text: ['delete_text', 'textId'], music: ['delete_music', 'musicId'] }[sel.kind];
    tool(it[0], { [it[1]]: sel.id });
  } else if (mod && key === 'z') { e.preventDefault(); tool(e.shiftKey ? 'redo' : 'undo'); }
  else if (e.key === 'ArrowRight') seek(time + (e.shiftKey ? 1 : 1 / P.settings.fps));
  else if (e.key === 'ArrowLeft') seek(time - (e.shiftKey ? 1 : 1 / P.settings.fps));
  else if (e.key === 'Home') seek(0);
});

api('/api/state').then(() => {
  const m = /t=([\d.]+)/.exec(location.hash); // deep link: /#t=12.5 opens at that time
  if (m) seek(+m[1]);
  requestAnimationFrame(tick);
});
