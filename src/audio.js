// Audio analysis for the timeline: waveform peaks, loudness, silences, tempo and beats.
// Decodes with ffmpeg to mono float PCM and analyses in JS. Results are cached per media file in data/analysis/.
import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS_DIR, MEDIA_DIR } from './store.js';
import { run } from './media.js';

const VERSION = 1;
export const PEAKS_PER_SEC = 50;
const r3 = (n) => Math.round(n * 1000) / 1000;
const cacheFile = (a, kind) => path.join(ANALYSIS_DIR, `${a.file}.${kind}.json`);
function cached(a, kind) {
  try { const j = JSON.parse(fs.readFileSync(cacheFile(a, kind), 'utf8')); if (j.version === VERSION) return j; } catch { /* not cached */ }
  return null;
}
function save(a, kind, data) {
  const j = { version: VERSION, ...data };
  fs.writeFileSync(cacheFile(a, kind), JSON.stringify(j));
  return j;
}
function audioFile(a) {
  if (a.type === 'image' || (a.type === 'video' && !a.hasAudio)) throw new Error(`"${a.name}" has no audio`);
  return path.join(MEDIA_DIR, a.file);
}

export async function decodeMono(file, rate) {
  const buf = await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
  const n = Math.floor(buf.length / 4);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4));
}

// Max |sample| per 1/PEAKS_PER_SEC s as integers 0-100 (for drawing waveforms).
export async function waveform(a) {
  const c = cached(a, 'peaks');
  if (c) return c;
  const rate = 8000, step = rate / PEAKS_PER_SEC;
  const x = await decodeMono(audioFile(a), rate);
  const peaks = new Array(Math.ceil(x.length / step));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    for (let j = i * step, e = Math.min(x.length, j + step); j < e; j++) { const v = Math.abs(x[j]); if (v > m) m = v; }
    peaks[i] = Math.min(100, Math.round(m * 100));
  }
  return save(a, 'peaks', { pps: PEAKS_PER_SEC, duration: r3(x.length / rate), peaks });
}

function makeFFT(N) {
  const rev = new Uint32Array(N), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / N); sin[k] = Math.sin((2 * Math.PI * k) / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let size = 2; size <= N; size *= 2) {
      const half = size / 2, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tre = re[b] * cos[k] + im[b] * sin[k], tim = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tre; im[b] = im[a] - tim; re[a] += tre; im[a] += tim;
        }
      }
    }
  };
}

// Pure analysis of mono samples. Exported for tests.
export function analyzeSamples(x, rate = 22050) {
  const N = 1024, hop = 512, fr = rate / hop;
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const toSec = (f) => (f * hop + N / 2) / rate;
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const rmsDb = 10 * Math.log10(sum / Math.max(1, x.length) + 1e-12), peakDb = 20 * Math.log10(peak + 1e-12);

  // Frame RMS and spectral flux (onset strength).
  const fft = makeFFT(N), win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(N / 2 + 1), cur = new Float64Array(N / 2 + 1);
  const rmsF = new Float64Array(frames), flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[f * hop + i]; e += v * v; re[i] = v * win[i]; im[i] = 0; }
    rmsF[f] = Math.sqrt(e / N);
    fft(re, im);
    let fl = 0;
    for (let k = 0; k <= N / 2; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (f > 0) { const d = cur[k] - prev[k]; if (d > 0) fl += d; }
    }
    flux[f] = fl;
    [prev, cur] = [cur, prev];
  }

  // Silences: frames well below the overall level, at least 0.35 s long.
  const thr = Math.max(-60, Math.min(-30, rmsDb - 24));
  const quiet = (f) => 20 * Math.log10(rmsF[f] + 1e-12) < thr;
  const silences = [];
  for (let f = 0; f < frames;) {
    if (!quiet(f)) { f++; continue; }
    let g = f; while (g < frames && quiet(g)) g++;
    const s = (f * hop) / rate, e = g >= frames ? x.length / rate : ((g - 1) * hop + N) / rate;
    if (e - s >= 0.35) silences.push([r3(s), r3(e)]);
    f = g;
  }

  // Onset envelope: flux minus a local mean, half-wave rectified, normalised.
  const o = new Float64Array(frames), W = 8;
  for (let f = 0; f < frames; f++) {
    let m = 0, c = 0;
    for (let j = Math.max(0, f - W); j <= Math.min(frames - 1, f + W); j++) { m += flux[j]; c++; }
    o[f] = Math.max(0, flux[f] - m / c);
  }
  let mean = 0; for (const v of o) mean += v; mean /= Math.max(1, frames);
  let sd = 0; for (const v of o) sd += (v - mean) ** 2; sd = Math.sqrt(sd / Math.max(1, frames)) || 1;
  for (let f = 0; f < frames; f++) o[f] /= sd;

  // Tempo: autocorrelation of a smoothed onset envelope (so non-integer periods still correlate),
  // scored with the double period too (beats repeat) and weighted toward 120 BPM.
  const os = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let j = -2; j <= 2; j++) { const g = f + j; if (g >= 0 && g < frames) { const w = Math.exp(-(j * j) / 2); s += o[g] * w; c += w; } }
    os[f] = s / c;
  }
  const minLag = Math.max(2, Math.floor((fr * 60) / 200)), maxLag = Math.ceil((fr * 60) / 55);
  const ac = new Float64Array(2 * maxLag + 3);
  for (let L = minLag - 1; L <= 2 * maxLag + 2; L++) {
    let s = 0; for (let t = L; t < frames; t++) s += os[t] * os[t - L];
    ac[L] = s / Math.max(1, frames - L);
  }
  let best = -1, bestL = 0, acMean = 0;
  for (let L = minLag; L <= maxLag; L++) {
    acMean += ac[L];
    const w = Math.exp(-0.5 * Math.log2((60 * fr) / L / 120) ** 2);
    const sc = (ac[L] + 0.5 * ac[2 * L]) * w;
    if (sc > best) { best = sc; bestL = L; }
  }
  acMean /= maxLag - minLag + 1;
  if (frames < maxLag * 4 || !(ac[bestL] > 0)) return { duration: r3(x.length / rate), bpm: null, confidence: 'none', beats: [], rmsDb: r3(rmsDb), peakDb: r3(peakDb), silences };
  const y0 = ac[bestL - 1], y1 = ac[bestL], y2 = ac[bestL + 1];
  const den = y0 - 2 * y1 + y2;
  const period = bestL + (den ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);
  const strength = ac[bestL] / (acMean || 1e-9);
  const confidence = strength > 1.6 ? 'high' : strength > 1.25 ? 'medium' : 'low';

  // Beats: dynamic programming (Ellis 2007) over the onset envelope with the estimated period.
  const score = new Float64Array(frames), back = new Int32Array(frames).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2), tight = 100;
  for (let t = 0; t < frames; t++) {
    let bv = -Infinity, bi = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const v = score[tau] - tight * Math.log((t - tau) / period) ** 2;
      if (v > bv) { bv = v; bi = tau; }
    }
    if (bi >= 0 && bv > 0) { score[t] = o[t] + bv; back[t] = bi; } else score[t] = o[t];
  }
  let end = -1, ev = -Infinity;
  for (let t = Math.max(0, frames - Math.round(period)); t < frames; t++) if (score[t] > ev) { ev = score[t]; end = t; }
  const bf = [];
  for (let t = end; t >= 0; t = back[t]) bf.push(t);
  bf.reverse();
  const beats = bf.filter((f) => !quiet(f)).map((f) => r3(toSec(f)));
  return { duration: r3(x.length / rate), bpm: r3((60 * fr) / period), confidence, beats, rmsDb: r3(rmsDb), peakDb: r3(peakDb), silences };
}

export async function analyzeAudio(a, { force = false } = {}) {
  const c = !force && cached(a, 'audio');
  if (c) return c;
  const x = await decodeMono(audioFile(a), 22050);
  return save(a, 'audio', analyzeSamples(x, 22050));
}

// Human-readable summary of an analysis, optionally limited to source seconds from-to.
export function analysisText(a, r, { from = 0, to = Infinity } = {}) {
  const inR = (t) => t >= from - 1e-6 && t <= to + 1e-6;
  const beats = r.beats.filter(inR);
  const sil = r.silences.filter(([s, e]) => e > from && s < to);
  const range = from > 0 || to < Infinity ? ` (source ${from}-${Math.min(to, r.duration)}s)` : '';
  return [
    `Audio analysis of "${a.name}"${range}, times in source seconds:`,
    `- duration ${r.duration}s, loudness RMS ${r.rmsDb} dBFS, peak ${r.peakDb} dBFS`,
    r.bpm ? `- tempo ${r.bpm} BPM (confidence ${r.confidence}), ${beats.length} beats: ${beats.slice(0, 300).join(', ')}${beats.length > 300 ? ', …' : ''}` : '- no steady beat found',
    `- silences (quiet ≥ 0.35s): ${sil.length ? sil.map(([s, e]) => `${s}-${e}`).join(', ') : 'none'}`,
  ].join('\n');
}
