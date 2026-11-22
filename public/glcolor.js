// GPU preview for what CSS cannot do: per-color HSL, .cube LUTs, chroma key and removed regions. A WebGL canvas
// takes the place of a video or image element (same CSS and intrinsic size, so fit, crop, position, masks and CSS
// filters still apply) and draws each frame through one shader. Plain GPU maths, no model: the same formulas as
// the export's ffmpeg filters (huesaturation, lut3d, chromakey + despill, delogo), approximately.
const COLORS = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']; // hue centers 0, 60, 120, 180, 240, 300
const MAX_BOXES = 4;

const VS = `attribute vec2 p; varying vec2 uv; void main() { uv = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision mediump float;
varying vec2 uv;
uniform sampler2D tex, lut;
uniform vec3 adj[6]; uniform float useHsl;
uniform float lutSize, lutMix;
uniform vec3 keyRgb; uniform float keyOn, keySim, keyBlend, despill; // despill: 0 none, 1 green, 2 blue
uniform vec4 boxes[${MAX_BOXES}]; uniform float nBoxes;
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec2 chroma(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b) * 255.0; }
vec3 lutAt(vec3 c) { // 2D atlas: x = r + size * b, y = g; linear inside a slice, mixed between the two b slices
  float n = lutSize, b = c.b * (n - 1.0), b0 = floor(b), b1 = min(b0 + 1.0, n - 1.0);
  vec2 rg = (c.rg * (n - 1.0) + 0.5) / vec2(n * n, n);
  vec3 s0 = texture2D(lut, rg + vec2(b0 / n, 0.0)).rgb, s1 = texture2D(lut, rg + vec2(b1 / n, 0.0)).rgb;
  return mix(s0, s1, b - b0);
}
void main() {
  vec4 src = texture2D(tex, uv);
  // Removed regions (delogo): fill the box from its four edges, weighted by distance.
  for (int i = 0; i < ${MAX_BOXES}; i++) {
    if (float(i) >= nBoxes) break;
    vec4 bx = boxes[i];
    if (uv.x > bx.x && uv.x < bx.x + bx.z && uv.y > bx.y && uv.y < bx.y + bx.w) {
      float l = uv.x - bx.x, r = bx.x + bx.z - uv.x, t = uv.y - bx.y, b = bx.y + bx.w - uv.y;
      vec4 cl = texture2D(tex, vec2(bx.x - 0.002, uv.y)), cr = texture2D(tex, vec2(bx.x + bx.z + 0.002, uv.y));
      vec4 ct = texture2D(tex, vec2(uv.x, bx.y - 0.002)), cb = texture2D(tex, vec2(uv.x, bx.y + bx.w + 0.002));
      vec4 wv = vec4(1.0 / (l + 1e-3), 1.0 / (r + 1e-3), 1.0 / (t + 1e-3), 1.0 / (b + 1e-3));
      src = (cl * wv.x + cr * wv.y + ct * wv.z + cb * wv.w) / (wv.x + wv.y + wv.z + wv.w);
    }
  }
  vec3 c = src.rgb;
  float alpha = src.a;
  // Chroma key (ffmpeg chromakey: distance in the color plane), then despill.
  if (keyOn > 0.5) {
    vec2 d = chroma(c) - chroma(keyRgb);
    float diff = sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
    alpha *= keyBlend > 0.0001 ? clamp((diff - keySim) / keyBlend, 0.0, 1.0) : step(keySim, diff);
    if (despill > 1.5) c.b = min(c.b, max(c.r, c.g)); else if (despill > 0.5) c.g = min(c.g, max(c.r, c.b));
  }
  // Per-color HSL (like huesaturation: brightness kept with equal weights when the hue turns or the color fades).
  if (useHsl > 0.5) {
    vec3 hsv = rgb2hsv(c);
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for (int i = 0; i < 6; i++) {
      float d = abs(hsv.x - float(i) / 6.0); d = min(d, 1.0 - d);
      float w = clamp(1.0 - d * 6.0, 0.0, 1.0) * smoothstep(0.05, 0.25, hsv.y);
      dh += w * adj[i].x; ds += w * adj[i].y; dl += w * adj[i].z;
    }
    const vec3 LUMA = vec3(1.0 / 3.0);
    float y0 = dot(c, LUMA);
    vec3 h = hsv2rgb(vec3(fract(hsv.x + dh / 360.0), hsv.y, hsv.z));
    float y1 = dot(h, LUMA);
    if (y1 > 1e-4) h = clamp(h * (y0 / y1), 0.0, 1.0);
    h = clamp(mix(vec3(y0), h, 1.0 + ds), 0.0, 1.0);
    c = clamp(h * (1.0 + dl * 0.5), 0.0, 1.0);
  }
  if (lutMix > 0.0) c = mix(c, lutAt(c), lutMix);
  gl_FragColor = vec4(c, alpha);
}`;

export const hslActive = (color) => !!(color?.hsl && Object.keys(color.hsl).length);
// The 6 [hue deg, saturation, lightness] triples in shader order.
export function hslUniform(hsl) {
  return COLORS.flatMap((k) => [hsl?.[k]?.hue || 0, hsl?.[k]?.saturation || 0, hsl?.[k]?.lightness || 0]);
}
// .cube text -> { size, data: Uint8Array RGB atlas (size*size wide, size high) } with r fastest, then g, then b.
export function parseCube(text) {
  const size = Number(/^\s*LUT_3D_SIZE\s+(\d+)/m.exec(text)?.[1]);
  if (!(size >= 2 && size <= 128)) throw new Error('not a 3D .cube LUT');
  const vals = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*[-\d.]/.test(line)) continue;
    const v = line.trim().split(/\s+/).map(Number);
    if (v.length === 3 && v.every(Number.isFinite)) vals.push(v);
  }
  if (vals.length !== size ** 3) throw new Error(`.cube has ${vals.length} entries, expected ${size ** 3}`);
  const data = new Uint8Array(size * size * size * 3);
  vals.forEach(([r, g, b], i) => {
    const ri = i % size, gi = Math.floor(i / size) % size, bi = Math.floor(i / (size * size));
    const o = (gi * size * size + bi * size + ri) * 3;
    data[o] = Math.round(Math.min(1, Math.max(0, r)) * 255); data[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255); data[o + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
  });
  return { size, data };
}
// Regions active at source second srcT, as [x, y, w, h] in texture coordinates (at most 4).
export function activeBoxes(regions, srcT) {
  return (regions || []).filter((r) => srcT >= r.from && srcT <= r.to).slice(0, MAX_BOXES).map((r) => [r.x, r.y, r.w, r.h]);
}
// Which channel despill pulls down for a key color (spillOf in src/model.js): 1 green, 2 blue, 0 none.
export function spillCode(hex) {
  const n = parseInt(String(hex).slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  return g > r && g > b ? 1 : b > r && b > g ? 2 : 0;
}

const luts = new Map(); // name -> {size, data} | 'loading' | 'error'
function lutData(name, onReady) {
  const v = luts.get(name);
  if (v && v !== 'loading') return v === 'error' ? null : v;
  if (!v) {
    luts.set(name, 'loading');
    fetch(`/api/lut/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { luts.set(name, parseCube(t)); onReady?.(); }).catch(() => luts.set(name, 'error'));
  }
  return null;
}

const state = new WeakMap();
function setup(canvas) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const mkTex = (unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const tex = mkTex(0), lutTex = mkTex(1);
  const u = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(u('tex'), 0); gl.uniform1i(u('lut'), 1);
  return { gl, tex, lutTex, lutName: null, u: Object.fromEntries(['adj', 'useHsl', 'lutSize', 'lutMix', 'keyRgb', 'keyOn', 'keySim', 'keyBlend', 'despill', 'boxes', 'nBoxes'].map((n) => [n, u(n)])) };
}

// Draw `media` through the shader when one of the GPU-only features is on, else show the media plainly.
// opts: { color (hsl, lut, lutIntensity), key ({color, similarity, blend, despill}), regions, srcT, onLut }.
export function glMirror(media, opts = {}) {
  const { color, key, regions, srcT = 0, onLut } = opts;
  const boxes = activeBoxes(regions, srcT);
  const lut = color?.lut ? lutData(color.lut, onLut) : null;
  const on = media.style.display !== 'none' && (hslActive(color) || !!lut || !!key || boxes.length > 0);
  let st = state.get(media);
  if (!on) {
    if (st) { st.canvas.style.display = 'none'; media.style.visibility = ''; }
    return false;
  }
  const w = media.videoWidth || media.naturalWidth, h = media.videoHeight || media.naturalHeight;
  if (!w || !h || (media.tagName === 'VIDEO' && media.readyState < 2)) return false;
  if (!st) {
    const canvas = document.createElement('canvas');
    const ctx = setup(canvas);
    if (!ctx) return false; // no WebGL: keep the plain media
    st = { canvas, ...ctx };
    state.set(media, st);
  }
  const { canvas, gl, u } = st;
  if (canvas.parentNode !== media.parentNode || canvas.previousSibling !== media) media.after(canvas);
  canvas.className = `${media.className} gl-mirror`.trim();
  canvas.style.cssText = media.style.cssText;
  canvas.style.visibility = '';
  canvas.style.display = 'block';
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, media);
  gl.uniform1f(u.useHsl, hslActive(color) ? 1 : 0);
  gl.uniform3fv(u.adj, new Float32Array(hslUniform(color?.hsl)));
  if (lut) {
    if (st.lutName !== color.lut) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st.lutTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, lut.size * lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, lut.data);
      st.lutName = color.lut;
    }
    gl.uniform1f(u.lutSize, lut.size); gl.uniform1f(u.lutMix, color.lutIntensity ?? 1);
  } else gl.uniform1f(u.lutMix, 0);
  if (key) {
    const n = parseInt(String(key.color).slice(1), 16);
    gl.uniform3f(u.keyRgb, (n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
    gl.uniform1f(u.keyOn, 1); gl.uniform1f(u.keySim, key.similarity ?? 0.25); gl.uniform1f(u.keyBlend, key.blend ?? 0.08);
    gl.uniform1f(u.despill, key.despill ? spillCode(key.color) : 0);
  } else gl.uniform1f(u.keyOn, 0);
  const flat = new Float32Array(MAX_BOXES * 4);
  boxes.forEach((b, i) => flat.set(b, i * 4));
  gl.uniform4fv(u.boxes, flat); gl.uniform1f(u.nBoxes, boxes.length);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  media.style.visibility = 'hidden';
  return true;
}
