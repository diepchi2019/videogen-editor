// Per-color HSL in the preview: a WebGL canvas takes the place of a video or image element (same CSS, same
// intrinsic size, so fit, crop, position and CSS filters still apply) and draws each frame through a shader
// that shifts hue, saturation and lightness of one color range at a time, like ffmpeg's huesaturation in the
// export (approximately). No model, no download: a few lines of GPU maths.
const COLORS = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']; // hue centers 0, 60, 120, 180, 240, 300

const VS = `attribute vec2 p; varying vec2 uv; void main() { uv = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision mediump float;
varying vec2 uv; uniform sampler2D tex; uniform vec3 adj[6];
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
void main() {
  vec4 src = texture2D(tex, uv);
  vec3 hsv = rgb2hsv(src.rgb);
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 6; i++) {
    float center = float(i) / 6.0;
    float d = abs(hsv.x - center); d = min(d, 1.0 - d);
    float w = clamp(1.0 - d * 6.0, 0.0, 1.0) * smoothstep(0.05, 0.25, hsv.y);
    dh += w * adj[i].x; ds += w * adj[i].y; dl += w * adj[i].z;
  }
  // Like ffmpeg's huesaturation: brightness (luma) stays where it was when the hue turns or the color fades.
  const vec3 LUMA = vec3(1.0 / 3.0); // huesaturation's default rw = gw = bw = 0.333
  float y0 = dot(src.rgb, LUMA);
  vec3 c = hsv2rgb(vec3(fract(hsv.x + dh / 360.0), hsv.y, hsv.z));
  float y1 = dot(c, LUMA);
  if (y1 > 1e-4) c = clamp(c * (y0 / y1), 0.0, 1.0);
  c = clamp(mix(vec3(y0), c, 1.0 + ds), 0.0, 1.0);
  c = clamp(c * (1.0 + dl * 0.5), 0.0, 1.0);
  gl_FragColor = vec4(c, src.a);
}`;

export const hslActive = (color) => !!(color?.hsl && Object.keys(color.hsl).length);
// The 6 [hue deg, saturation, lightness] triples in shader order.
export function hslUniform(hsl) {
  return COLORS.flatMap((k) => [hsl?.[k]?.hue || 0, hsl?.[k]?.saturation || 0, hsl?.[k]?.lightness || 0]);
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
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return { gl, adj: gl.getUniformLocation(prog, 'adj') };
}

// Show `media` through the HSL shader (or show it plainly when the color has no HSL). Call after the media's
// style is set for this frame.
export function glMirror(media, color) {
  let st = state.get(media);
  const on = hslActive(color) && media.style.display !== 'none';
  if (!on) {
    if (st) { st.canvas.style.display = 'none'; media.style.visibility = ''; }
    return;
  }
  const w = media.videoWidth || media.naturalWidth, h = media.videoHeight || media.naturalHeight;
  if (!w || !h || (media.tagName === 'VIDEO' && media.readyState < 2)) return;
  if (!st) {
    const canvas = document.createElement('canvas');
    const ctx = setup(canvas);
    if (!ctx) return; // no WebGL: keep the plain media
    st = { canvas, ...ctx };
    state.set(media, st);
  }
  const { canvas, gl } = st;
  if (canvas.parentNode !== media.parentNode || canvas.previousSibling !== media) media.after(canvas);
  canvas.className = `${media.className} gl-mirror`.trim();
  canvas.style.cssText = media.style.cssText;
  canvas.style.visibility = '';
  canvas.style.display = 'block';
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, media);
  gl.uniform3fv(st.adj, new Float32Array(hslUniform(color.hsl)));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  media.style.visibility = 'hidden';
}
