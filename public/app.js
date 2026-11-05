// VideoGen editor UI (vanilla JS). The server owns the project; every edit is a tool call.
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
let sel = null;    // { kind: 'clip'|'overlay'|'text'|'music', id }
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
  else if (switched) fetch('/api/state').then((r) => r.json()).then((j) => { projects = j.projects || projects; renderProjects(); });
  if (sel && !findSel()) sel = null;
  renderAll();
}
const findSel = () => sel && (sel.kind === 'clip' ? L.clips.find((c) => c.id === sel.id)
  : sel.kind === 'text' ? P.texts.find((t) => t.id === sel.id) : sel.kind === 'overlay' ? P.overlays.find((o) => o.id === sel.id)
    : P.music.find((m) => m.id === sel.id));
const ovDur = (o) => (o.out - o.in) / (o.speed || 1);
function toast(msg) { addMsg('error', String(msg)); }

// ---------- Preview helpers (browser approximations of what ffmpeg renders) ----------
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
  renderProjects(); renderPresets(); renderAssets(); renderTimeline(); renderInspector(); renderJobs(); fitStage(); renderFrame(true);
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
  )) : [h('div', { class: 'empty' }, 'Drop videos, images or music here')]));
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
const layers = [...document.querySelectorAll('.layer')].map((el) => {
  const bg = h('video', { class: 'bgblur', muted: true, playsinline: true, preload: 'auto' });
  bg.muted = true;
  el.prepend(bg);
  return { el, video: $('video:not(.bgblur)', el), img: $('img', el), bg, clipId: null };
});
const musicEls = new Map();

function syncVideo(v, src, t, rate, vol, play) {
  if (v.getAttribute('src') !== src) { v.src = src; v.currentTime = t; }
  v.playbackRate = rate;
  if (vol !== null) v.volume = Math.min(1, vol);
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
    const mediaStyle = {
      transform: `translate(${(x - 0.5) * 100}%, ${(y - 0.5) * 100}%) rotate(${T.rotate || 0}deg) scale(${s * (T.flipH ? -1 : 1)}, ${s * (T.flipV ? -1 : 1)})`,
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
      const st = Math.min(c.in + (t - c.start) * c.speed, c.out - 0.01);
      syncVideo(ly.video, src, st, c.speed, kfVal(c, 'volume', lt, c.volume), playing);
      if (fit === 'blur') { ly.bg.style.display = 'block'; syncVideo(ly.bg, src, st, c.speed, null, playing); }
      else { ly.bg.style.display = 'none'; ly.bg.pause(); }
    }
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

const ovEls = new Map();
function renderOverlays(t) {
  const box = $('#overlays');
  const keep = new Set();
  const sorted = [...P.overlays].sort((a, b) => a.track - b.track || a.start - b.start);
  sorted.forEach((o, z) => {
    const a = P.assets[o.assetId];
    if (!a) return;
    let el = ovEls.get(o.id);
    const tag = a.type === 'image' ? 'IMG' : 'VIDEO';
    if (!el || el.tagName !== tag) {
      el?.remove();
      el = h(tag.toLowerCase(), { class: 'ov-media', playsinline: true, preload: 'auto' });
      ovEls.set(o.id, el); box.append(el);
    }
    keep.add(o.id);
    const on = t >= o.start && t < o.start + ovDur(o);
    el.style.display = on ? 'block' : 'none';
    const src = mediaSrc(a);
    const lt = t - o.start;
    const vol = kfVal(o, 'volume', lt, o.volume);
    if (a.type === 'image') { if (el.getAttribute('src') !== src) el.src = src; }
    else if (on) syncVideo(el, src, o.in + lt * o.speed, o.speed, vol, playing);
    else el.pause();
    if (!on) return;
    const full = o.fit === 'cover' || o.fit === 'contain';
    const fade = o.animation === 'fade' ? clamp01(Math.min(lt, ovDur(o) - lt) / 0.3) : 1;
    Object.assign(el.style, {
      zIndex: String(z + 1), opacity: String(kfVal(o, 'opacity', lt, o.opacity) * fade), objectFit: o.fit === 'cover' ? 'cover' : 'contain',
      left: full ? '50%' : `${kfVal(o, 'x', lt, o.x) * 100}%`, top: full ? '50%' : `${kfVal(o, 'y', lt, o.y) * 100}%`,
      width: full ? '100%' : `${kfVal(o, 'scale', lt, o.scale) * 100}%`, height: full ? '100%' : 'auto',
      transform: `translate(-50%, -50%) rotate(${kfVal(o, 'rotate', lt, o.rotate || 0)}deg) scale(${o.flipH ? -1 : 1}, ${o.flipV ? -1 : 1})`,
      filter: colorCss(o.color),
    });
  });
  for (const [id, el] of ovEls) if (!keep.has(id)) { el.pause?.(); el.remove(); ovEls.delete(id); }
}

function renderCaption(t, k) {
  const c = P.captions;
  if (!c) return null;
  const l = c.lines.find((x) => t >= x.start && t < x.end);
  if (!l) return null;
  const st = c.style;
  const up = (w) => (st.uppercase ? w.toUpperCase() : w);
  const cur = l.words.findIndex((w, i) => t >= w.start && (i + 1 >= l.words.length || t < l.words[i + 1].start));
  const words = st.mode === 'single' ? (cur >= 0 ? [l.words[cur]] : []) : l.words;
  const size = st.size * k;
  return h('div', {
    class: 'ov-caption',
    style: {
      top: `${st.y * 100}%`, fontSize: `${size}px`, color: st.color,
      background: st.box ? hexA(st.boxColor || '#000000', 0.6) : 'transparent', padding: st.box ? `${size * 0.3}px` : '0',
      textShadow: st.box ? 'none' : `0 0 ${Math.max(2, (st.outline || 4) * k * 2)}px ${st.outlineColor || '#000'}, 0 0 2px #000`,
    },
  }, ...words.map((w, i) => {
    const lit = st.mode === 'karaoke' ? t >= w.start : st.mode === 'word' ? l.words.indexOf(w) === cur : st.mode === 'single';
    return h('span', { style: { color: lit ? st.highlightColor : st.color } }, up(w.w) + (i < words.length - 1 ? ' ' : ''));
  }));
}

function renderTexts(t) {
  const st = $('#stage');
  const k = st.clientWidth / P.settings.width;
  const box = $('#texts');
  box.replaceChildren(...P.texts.filter((x) => t >= x.start && t < x.end).map((x) => {
    const dt = x.animation === 'pop' ? 0.15 : 0.35;
    const prog = Math.min(1, Math.max(0, (t - x.start) / dt));
    const anim = x.animation || 'none';
    const dy = anim === 'slideup' ? (1 - prog) * 80 : anim === 'pop' ? (1 - prog) * 20 : 0;
    const size = x.size * k;
    const el = h('div', {
      class: `ov-text${sel?.id === x.id ? ' selected' : ''}`,
      style: {
        left: `${x.x * 100}%`, top: `calc(${x.y * 100}% + ${dy * k}px)`, fontSize: `${size}px`, color: x.color,
        opacity: anim === 'none' ? 1 : prog,
        background: x.box ? hexA(x.boxColor || '#000000', 0.6) : 'transparent',
        padding: x.box ? `${size * 0.35}px` : '0',
        textShadow: x.box ? 'none' : `0 0 ${Math.max(2, size / 14)}px #000, 0 0 2px #000`,
      },
    }, x.text.replace(/\\n/g, '\n'));
    el.addEventListener('pointerdown', (e) => dragTextOnStage(e, x));
    return el;
  }));
  const cap = renderCaption(t, k);
  if (cap) box.append(cap);
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
    const b = h('div', {
      class: `block clip${sel?.id === c.id ? ' selected' : ''}`,
      style: { left: `${c.start * pps}px`, width: `${Math.max(4, c.duration * pps)}px`, backgroundImage: a.thumb ? `url(${a.thumb})` : 'none' },
      title: `${a.name} ${c.in.toFixed(2)}-${c.out.toFixed(2)}s`,
    }, h('span', {}, `${c.speed !== 1 ? c.speed + 'x · ' : ''}${c.color?.filter ? `◐ ` : ''}${c.effects?.length ? '✦ ' : ''}${a.name}`),
    a.type === 'video' && a.hasAudio ? waveCanvas(a, c.in, c.out, c.duration * pps, 14, 'clipwave') : null,
    h('div', { class: 'handle l', onpointerdown: (e) => trimDrag(e, c, 'in') }),
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
      class: `block overlay${sel?.id === o.id ? ' selected' : ''}`,
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
    const b = h('div', { class: `block text${sel?.id === x.id ? ' selected' : ''}`, style: { left: `${x.start * pps}px`, width: `${Math.max(4, (x.end - x.start) * pps)}px`, top: `${6 + laneOf.get(x.id) * lh}px`, height: `${lh - (lanes.length > 1 ? 2 : 0)}px`, padding: lanes.length > 2 ? '0 6px' : undefined, fontSize: lanes.length > 2 ? '9px' : undefined }, title: x.text },
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
    const b = h('div', { class: `block music${sel?.id === m.id ? ' selected' : ''}`, style: { left: `${m.start * pps}px`, width: `${Math.max(4, (m.out - m.in) * pps)}px`, top: `${6 + aTracks.indexOf(m.track || 1) * alh}px`, height: `${bh}px` } },
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
}

function clipDrag(e, c) {
  e.preventDefault();
  select('clip', c.id);
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
  const max = a.type === 'image' ? 3600 : a.duration;
  const x0 = e.clientX, block = e.target.parentElement;
  let v = c[edge];
  const move = (ev) => {
    const d = ((ev.clientX - x0) / pps) * c.speed;
    v = edge === 'in' ? Math.min(c.out - 0.1, Math.max(0, c.in + d)) : Math.max(c.in + 0.1, Math.min(max, c.out + d));
    const dur = (edge === 'in' ? c.out - v : v - c.in) / c.speed;
    block.style.width = `${dur * pps}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (Math.abs(v - c[edge]) > 0.01) tool('trim_clip', { clipId: c.id, [edge]: +v.toFixed(3) });
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function rangeDrag(e, kind, item, mode) {
  e.preventDefault(); e.stopPropagation();
  select(kind, item.id);
  const x0 = e.clientX, block = mode === 'end' ? e.target.parentElement : e.currentTarget;
  let d = 0;
  const move = (ev) => {
    d = (ev.clientX - x0) / pps;
    if (mode === 'move') { d = Math.max(-item.start, d); block.style.left = `${(item.start + d) * pps}px`; }
    else { d = Math.max(0.1 - (item.end - item.start), d); block.style.width = `${(item.end - item.start + d) * pps}px`; }
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (Math.abs(d) < 0.02) return;
    if (kind === 'text') tool('update_text', mode === 'move'
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
    if (e.target === e.currentTarget) { seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / pps); select(null); }
  });
}
$('#zoom').addEventListener('input', (e) => { pps = +e.target.value; renderTimeline(); renderFrame(true); });

// ---------- Inspector ----------
function select(kind, id, focusTransition) {
  sel = kind ? { kind, id } : null;
  renderTimeline(); renderInspector(); renderTexts(time);
  if (focusTransition) $('#insp-trans')?.focus();
}
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
  if (!it) return box.replaceChildren();
  let content;
  if (sel.kind === 'clip') {
    const c = it, a = P.assets[c.assetId];
    content = [
      h('span', { class: 'title' }, `Clip #${c.index + 1} · ${a.name}`),
      field('In', c.in, (v) => tool('trim_clip', { clipId: c.id, in: v }), { step: '0.05' }),
      field('Out', c.out, (v) => tool('trim_clip', { clipId: c.id, out: v }), { step: '0.05' }),
      field('Speed', c.speed, (v) => tool('set_clip', { clipId: c.id, speed: v }), { min: 0.25, max: 4, step: '0.25' }),
      field('Volume', c.volume, (v) => tool('set_clip', { clipId: c.id, volume: v }), { min: 0, max: 2, step: '0.1' }),
      h('label', {}, 'Fit', h('select', { onchange: (e) => tool('set_clip', { clipId: c.id, fit: e.target.value }) },
        ...['contain', 'cover', 'blur'].map((f) => h('option', { value: f, selected: (c.fit || 'contain') === f }, f)))),
      c.index > 0 ? h('label', {}, 'Transition in', h('select', { id: 'insp-trans', onchange: (e) => tool('set_transition', { clipId: c.id, type: e.target.value, duration: c.transition?.duration || 0.5 }) },
        ...TRANSITIONS.map((t) => h('option', { value: t, selected: (c.transition?.type || 'none') === t }, t)))) : null,
      c.index > 0 && c.transition?.type !== 'none' ? field('Dur', c.transition.duration, (v) => tool('set_transition', { clipId: c.id, type: c.transition.type, duration: v }), { min: 0.1, max: 5 }) : null,
      animSelect(c, 'animIn', 'Anim in'), animSelect(c, 'animOut', 'Anim out'),
      ...colorFields({ clipId: c.id }, c.color),
      c.effects?.length ? h('span', { class: 'note', title: 'Effects show in export and look_at_timeline' }, `✦ ${c.effects.map((e) => e.type).join(', ')}`) : null,
      h('button', { class: 'small', onclick: () => tool('split_clip', { at: time, clipId: c.id }) }, '✂ Split at playhead'),
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
$('#exportFinal').onclick = () => exportVideo('final');

// ---------- Upload ----------
async function upload(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  addMsg('action', `Importing ${files.length} file(s)…`);
  const r = await fetch('/api/upload', { method: 'POST', body: form }).then((x) => x.json());
  if (r.error) toast(r.error); else setState(r);
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
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === 's' || e.key === 'S') tool('split_clip', { at: +time.toFixed(3) });
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
    const it = { clip: ['delete_clip', 'clipId'], overlay: ['delete_overlay', 'overlayId'], text: ['delete_text', 'textId'], music: ['delete_music', 'musicId'] }[sel.kind];
    tool(it[0], { [it[1]]: sel.id });
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); tool(e.shiftKey ? 'redo' : 'undo'); }
  else if (e.key === 'ArrowRight') seek(time + (e.shiftKey ? 1 : 1 / P.settings.fps));
  else if (e.key === 'ArrowLeft') seek(time - (e.shiftKey ? 1 : 1 / P.settings.fps));
  else if (e.key === 'Home') seek(0);
});

api('/api/state').then(() => {
  const m = /t=([\d.]+)/.exec(location.hash); // deep link: /#t=12.5 opens at that time
  if (m) seek(+m[1]);
  requestAnimationFrame(tick);
});
