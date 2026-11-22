// Browser-preview approximations of what src/render.js and src/ass.js draw: Ken Burns, crop, vignette,
// video effects and text styles/animations. Pure functions (no DOM) except drawEffect, which paints a canvas,
// so the unit tests can import this file.
const ease = (p) => p * p * (3 - 2 * p);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const pc = (v) => `${(v * 100).toFixed(3)}%`;

// ---------- Ken Burns (motionFilter in render.js) ----------
// Zoom z with the view window anchored at fraction (ox, oy) of the frame: zoompan's x = (iw - iw/zoom) * f
// is the same as scaling about the point f of the frame.
export function kenBurns(m, lt, dur) {
  if (!m || !m.preset || m.preset === 'none') return null;
  const I = m.intensity ?? 0.15, e = ease(clamp01(lt / Math.max(0.001, dur)));
  switch (m.preset) {
    case 'zoom_in': return { z: 1 + I * e, ox: 0.5, oy: 0.5 };
    case 'zoom_out': return { z: 1 + I - I * e, ox: 0.5, oy: 0.5 };
    case 'pan_left': return { z: 1 + I, ox: 1 - e, oy: 0.5 };
    case 'pan_right': return { z: 1 + I, ox: e, oy: 0.5 };
    case 'pan_up': return { z: 1 + I, ox: 0.5, oy: 1 - e };
    case 'pan_down': return { z: 1 + I, ox: 0.5, oy: e };
    default: return null;
  }
}
// CSS transform scaling an element that fills the frame by z about the frame point (ox, oy).
export function zoomAbout(z, ox = 0.5, oy = 0.5) {
  if (Math.abs(z - 1) < 1e-6) return '';
  const tx = (ox - 0.5) * 100, ty = (oy - 0.5) * 100;
  return `translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%) scale(${z.toFixed(5)}) translate(${(-tx).toFixed(3)}%, ${(-ty).toFixed(3)}%)`;
}

// ---------- Crop (geometry in render.js) ----------
// CSS object-view-box for a crop {x, y, w, h} in source fractions: the element then fits the cropped area.
export const cropBox = (cr) => (cr ? `inset(${pc(cr.y)} ${pc(Math.max(0, 1 - cr.x - cr.w))} ${pc(Math.max(0, 1 - cr.y - cr.h))} ${pc(cr.x)})` : '');

// ---------- Vignette (ffmpeg vignette, angle = 0.25 + 0.6 * amount) ----------
// The frame is darkened by 1 - cos(angle * d / dmax)^4 at distance d from the center (dmax = the corner).
export function vignetteCss(v) {
  if (!v) return '';
  const a = 0.25 + 0.6 * v;
  const stops = [0, 0.25, 0.5, 0.65, 0.8, 0.9, 1].map((r) => `rgba(0,0,0,${(1 - Math.cos(a * r) ** 4).toFixed(3)}) ${pc(r)}`);
  return `radial-gradient(circle farthest-corner at 50% 50%, ${stops.join(', ')})`;
}

// ---------- Effects (applyEffect in render.js) ----------
// Effect state at clip-local time lt on a W x H canvas shown k stage px per canvas px:
// transform / filter for the whole clip, svg filters (rgb split, comic) with their shift in stage px,
// light leak and grain overlays, and a canvas effect (pixelate, mirror, kaleidoscope) to paint.
export function effectsAt(c, lt, W, H, k) {
  const r = { transform: '', filter: [], rgb: 0, comic: false, leak: null, grain: 0, canvas: null, clip: '' };
  for (const fx of c.effects || []) {
    if (lt < fx.from || lt > fx.to) continue;
    const I = fx.intensity ?? 0.5, rate = fx.rate ?? 2, t = lt;
    const shift = Math.max(2, Math.round(W * 0.02 * I)) * k;
    switch (fx.type) {
      case 'shake': {
        const amp = Math.max(2, Math.round(Math.min(W, H) * 0.035 * I));
        const dx = amp * Math.sin(t * rate * 6.283) * Math.cos(t * rate * 2.1), dy = amp * Math.sin(t * rate * 5.3 + 1.3);
        r.transform += ` translate(${pc(dx / W)}, ${pc(dy / H)})`;
        break;
      }
      case 'zoom_pulse': r.transform += ` scale(${(1 + 0.18 * I * Math.abs(Math.sin(Math.PI * rate * (t - fx.from))) ** 3).toFixed(4)})`; break;
      case 'glitch':
        if (Math.sin(t * 23) * Math.sin(t * 7.3) > 0.35 - 0.3 * I) { r.rgb = Math.max(r.rgb, shift * 2); r.grain = Math.max(r.grain, 0.3 + 0.4 * I); r.transform += ` translateX(${pc((Math.sin(t * 91) * shift) / (W * k))})`; }
        break;
      case 'rgb_split': r.rgb = Math.max(r.rgb, shift); break;
      case 'flash': {
        const d = Math.min(0.5, fx.to - fx.from), b = 0.9 * I * Math.max(0, 1 - (t - fx.from) / d);
        if (b > 0) r.filter.push(`brightness(${(1 + 3 * b).toFixed(3)})`);
        break;
      }
      case 'strobe': if (Math.sin(2 * Math.PI * rate * (t - fx.from)) > 0) r.filter.push(`brightness(${(1 + 2.5 * 0.8 * I).toFixed(3)})`); break;
      case 'blur': r.filter.push(`blur(${((2 + 18 * I) * k).toFixed(2)}px)`); break;
      case 'vhs': r.filter.push('sepia(0.25)', 'contrast(1.1)', 'saturate(1.2)'); r.rgb = Math.max(r.rgb, shift); r.grain = Math.max(r.grain, 0.2 + 0.3 * I); break;
      case 'light_leak': r.leak = { opacity: 0.7 * I, phase: t * 0.6 + fx.from }; break;
      case 'invert': r.filter.push('invert(1)'); break;
      case 'film_grain': r.grain = Math.max(r.grain, 0.25 + 0.6 * I); break;
      case 'comic': r.comic = true; r.filter.push('saturate(1.5)'); break;
      case 'pixelate': r.canvas = { type: 'pixelate', block: Math.round(4 + 36 * I) * k }; break;
      case 'mirror': case 'kaleidoscope': case 'multi_screen': r.canvas = { type: fx.type }; break;
      case 'letterbox': r.clip = `inset(${pc(0.13 * I)} 0)`; break;
      case 'black_white': r.filter.push(`grayscale(${I.toFixed(3)})`); break;
      case 'tv_static': r.filter.push('grayscale(0.7)', 'contrast(1.2)'); r.grain = Math.max(r.grain, 0.6 + 0.4 * I); break;
      case 'flicker': r.filter.push(`brightness(${(1 + 0.15 * I * Math.sin(t * 53) * Math.sin(t * 31)).toFixed(3)})`); break;
      case 'posterize': r.filter.push(`contrast(${(1.2 + 0.3 * I).toFixed(2)})`, 'saturate(1.4)'); break;
      case 'duotone': r.filter.push('grayscale(1)', `sepia(${(0.6 * I).toFixed(2)})`, 'hue-rotate(170deg)', `saturate(${(1 + 1.5 * I).toFixed(2)})`); break;
      case 'glow': r.filter.push(`brightness(${(1.05 + 0.1 * I).toFixed(3)})`, `contrast(${(1 - 0.1 * I).toFixed(3)})`, 'saturate(1.1)'); break;
      case 'rainbow': r.filter.push(`hue-rotate(${Math.round((360 * rate * (t - fx.from)) % 360)}deg)`, `saturate(${(1 + 0.5 * I).toFixed(2)})`); break;
      case 'swing': { const deg = 2 + 8 * I; r.transform += ` rotate(${(deg * Math.sin(2 * Math.PI * rate * t)).toFixed(3)}deg) scale(${(1 + Math.sin((deg * Math.PI) / 180) * 1.2).toFixed(4)})`; break; }
      case 'old_film': r.filter.push('sepia(0.6)', 'contrast(1.1)', `brightness(${(1 + 0.08 * I * Math.sin(t * 37)).toFixed(3)})`); r.grain = Math.max(r.grain, 0.25 + 0.4 * I); break;
      case 'night_vision': r.filter.push('grayscale(1)', 'sepia(1)', 'hue-rotate(60deg)', 'saturate(4)', 'brightness(1.1)'); r.grain = Math.max(r.grain, 0.25 + 0.35 * I); break;
      case 'thermal': r.filter.push('invert(1)', 'hue-rotate(180deg)', 'saturate(3)'); break;
      case 'echo': r.canvas = { type: 'echo', frames: Math.round(3 + 6 * I) }; break; // trails on a canvas (app.js keeps the history)
      default: break;
    }
  }
  r.filter = r.filter.join(' ');
  r.transform = r.transform.trim();
  return r;
}
// Light leak: two warm blobs drifting over the frame (screen blended).
export function leakCss(phase) {
  const x1 = 30 + 25 * Math.sin(phase), y1 = 25 + 20 * Math.cos(phase * 0.7), x2 = 70 + 20 * Math.cos(phase * 0.9), y2 = 70 + 15 * Math.sin(phase * 1.3);
  return `radial-gradient(circle at ${x1.toFixed(1)}% ${y1.toFixed(1)}%, rgba(255,138,0,.95), transparent 55%), radial-gradient(circle at ${x2.toFixed(1)}% ${y2.toFixed(1)}%, rgba(255,45,106,.85), transparent 50%)`;
}
// Grain texture (SVG turbulence), moved every frame so it flickers like ffmpeg's temporal noise.
export const GRAIN_URL = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>").replace(/%2523/g, '%23')}")`;

// ---------- Tone curves (color adjust; applyColor in src/render.js uses the same points) ----------
// exposure / shadows / highlights / fade / tint and the three color wheels as one curve per channel:
// [[x, y], ...] at 9 points, or null when none of them is set. Wheels: {shadows|midtones|highlights: {color, amount}}.
const bump = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
const WHEEL_AT = { shadows: 0.15, midtones: 0.5, highlights: 0.85 };
export function toneCurves(c) {
  if (!c) return null;
  const ex = c.exposure || 0, sh = c.shadows || 0, hi = c.highlights || 0, fade = c.fade || 0, tint = c.tint || 0;
  const wheels = Object.entries(c.wheels || {}).filter(([k, w]) => WHEEL_AT[k] && w?.amount);
  if (!ex && !sh && !hi && !fade && !tint && !wheels.length) return null;
  const rgb = (hex) => { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const out = {};
  ['r', 'g', 'b'].forEach((ch, ci) => {
    out[ch] = Array.from({ length: 9 }, (_, i) => {
      const x = i / 8;
      let y = x * 2 ** ex + sh * 0.15 * bump(x, 0.2, 0.2) + hi * 0.15 * bump(x, 0.8, 0.2);
      for (const [k, w] of wheels) { const col = rgb(w.color), m = (col[0] + col[1] + col[2]) / 3; y += (col[ci] - m) * w.amount * 0.35 * bump(x, WHEEL_AT[k], 0.25); }
      y += tint * (ci === 1 ? -0.06 : 0.03) * bump(x, 0.5, 0.35); // + magenta, - green
      y = fade * 0.12 + y * (1 - fade * 0.12);
      return [Math.round(x * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000];
    });
  });
  return out;
}

// Sharpen kernel for an SVG feConvolveMatrix (unsharp-style: center boosted, 4 neighbours subtracted).
export function sharpenKernel(amount) {
  const k = Math.round((0.15 + 0.35 * amount) * 1000) / 1000;
  return [0, -k, 0, -k, Math.round((1 + 4 * k) * 1000) / 1000, -k, 0, -k, 0];
}

// Paint a canvas effect. src: a canvas holding the finished clip frame (same size as ctx's canvas).
export function drawEffect(ctx, src, fx, scratch) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (fx.type === 'pixelate') {
    const sw = Math.max(1, Math.round(w / Math.max(1, fx.block))), sh = Math.max(1, Math.round(h / Math.max(1, fx.block)));
    scratch.width = sw; scratch.height = sh;
    const s = scratch.getContext('2d');
    s.imageSmoothingEnabled = true;
    s.drawImage(src, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, sw, sh, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    return;
  }
  ctx.drawImage(src, 0, 0);
  const hw = Math.round(w / 2), hh = Math.round(h / 2);
  // Left half mirrored onto the right (mirror); top-left quarter mirrored 4 ways (kaleidoscope).
  const quad = (sx, sy, fx2, fy2, qw, qh) => {
    ctx.save();
    ctx.translate(fx2 ? w : 0, fy2 ? h : 0);
    ctx.scale(fx2 ? -1 : 1, fy2 ? -1 : 1);
    ctx.drawImage(src, sx, sy, qw, qh, 0, 0, qw, qh);
    ctx.restore();
  };
  if (fx.type === 'multi_screen') {
    for (const [x, y] of [[0, 0], [hw, 0], [0, hh], [hw, hh]]) ctx.drawImage(src, 0, 0, w, h, x, y, hw, hh);
    return;
  }
  if (fx.type === 'mirror') quad(0, 0, true, false, hw, h);
  else {
    quad(0, 0, true, false, hw, hh);
    quad(0, 0, false, true, hw, hh);
    quad(0, 0, true, true, hw, hh);
  }
}

// ---------- Text (textTags / textEvents in src/ass.js) ----------
const hexA = (hex, a) => { const n = parseInt(String(hex || '#000000').slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
// Static look of a text or caption style: font, weight, outline (text stroke painted under the fill),
// shadow, glow (blur) and box. k = stage px per canvas px; em = CSS font-size per ASS font size.
export function textLook(t, k, em = 0.88, fallback = 'sans-serif') {
  const size = (t.size ?? 72) * k;
  const css = {
    fontFamily: `"${t.font}", ${fallback}`, fontSize: `${(size * em).toFixed(2)}px`, lineHeight: `${size.toFixed(2)}px`,
    fontWeight: t.bold === false ? '400' : '700', fontStyle: t.italic ? 'italic' : 'normal', color: t.color || '#ffffff',
    background: 'transparent', padding: '0', webkitTextStroke: '0', paintOrder: 'stroke fill', textShadow: 'none', borderRadius: '0',
  };
  if (t.box) {
    css.background = hexA(t.boxColor || '#000000', 0.6);
    css.padding = `${(size * 0.35).toFixed(2)}px`;
    if (t.blur) css.filter = `blur(${(t.blur * k * 0.5).toFixed(2)}px)`;
    return css;
  }
  const auto = t.outline === undefined;
  const bord = (auto ? Math.max(2, Math.round((t.size ?? 72) / 18)) : t.outline) * k;
  const oc = hexA(t.outlineColor || '#000000', auto ? 0.7 : 1);
  if (bord > 0) css.webkitTextStroke = `${(bord * 2).toFixed(2)}px ${oc}`;
  const sh = [];
  if (t.shadow) sh.push(`${(t.shadow * k).toFixed(2)}px ${(t.shadow * k).toFixed(2)}px 0 ${hexA(t.shadowColor || '#000000', 0.6)}`);
  if (t.blur) sh.push(`0 0 ${(t.blur * k * 2).toFixed(2)}px ${bord > 0 ? oc : hexA(t.color || '#ffffff', 0.8)}`);
  if (sh.length) css.textShadow = sh.join(', ');
  return css;
}
// Animation state of a text at time t: opacity, offset in canvas px, scale, and typewriter character
// count (null = all). Same timings as textEvents: in 0.35s (pop 0.15s), out 0.3s, at most half the length.
const SLIDE = { slideup: [0, 80], slidedown: [0, -80], slideleft: [120, 0], slideright: [-120, 0] };
const SLIDE_OUT = { slideup: [0, -80], slidedown: [0, 80] };
export function textAnim(x, t) {
  const s = x.start, e = x.end, dur = e - s, lt = t - s;
  const ain = x.animation || 'none', aout = x.animationOut || 'none';
  const din = Math.min(ain === 'pop' ? 0.15 : 0.35, dur / 2), dout = Math.min(0.3, dur / 2);
  let op = 1, dx = 0, dy = 0, sc = 1, chars = null;
  const pin = clamp01(lt / din), pout = clamp01((lt - (dur - dout)) / dout);
  if (['fade', 'pop', 'zoom', ...Object.keys(SLIDE)].includes(ain)) op *= pin;
  if (ain === 'pop') sc *= 0.7 + 0.3 * pin;
  if (ain === 'zoom') sc *= 1.35 - 0.35 * pin;
  if (SLIDE[ain]) { dx += SLIDE[ain][0] * (1 - pin); dy += SLIDE[ain][1] * (1 - pin); }
  if (ain === 'typewriter') {
    const n = [...String(x.text).replace(/\\n/g, '\n')].length;
    const per = Math.max(1, Math.min(6, Math.floor((dur * 60) / Math.max(1, n)))) / 100;
    chars = Math.min(n, Math.floor(lt / per) + 1);
  }
  if (aout !== 'none') op *= 1 - pout;
  if (aout === 'pop') sc *= 1 - 0.3 * pout;
  if (aout === 'zoom') sc *= 1 + 0.35 * pout;
  if (SLIDE_OUT[aout]) { dx += SLIDE_OUT[aout][0] * pout; dy += SLIDE_OUT[aout][1] * pout; }
  return { op, dx, dy, sc, chars };
}
