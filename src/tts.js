// Text to speech. Engines: Piper (local, free; https://github.com/OHF-Voice/piper1-gpl) and ElevenLabs (API key,
// paid per character). Piper voices are .onnx files with a .onnx.json config in models/piper/ or data/models/piper/,
// and Piper runs as a command: VIDEOGEN_PIPER, else `piper` on PATH, else `python -m piper` (pip install piper-tts).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DATA_DIR, MEDIA_DIR } from './store.js';
import { get, source, setSettings, onSettingsChange } from './settings.js';

export const VOICE_DIRS = () => [path.resolve('models', 'piper'), path.join(DATA_DIR, 'models', 'piper')];
export const PIPER_HELP = 'Text to speech needs Piper: run "pip install piper-tts", then download a voice, e.g. ' +
  '"python -m piper.download_voices en_US-lessac-medium --download-dir models/piper" (voices: https://huggingface.co/rhasspy/piper-voices). ' +
  'Or set VIDEOGEN_PIPER to a piper executable.';

// Installed voices: [{id, file, language, languageName, quality, speakers}] (id = file name without .onnx).
export function listVoices() {
  const out = [];
  for (const d of VOICE_DIRS()) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.onnx')).sort()) {
      const file = path.join(d, n);
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')); } catch { continue; } // a voice needs its config
      const id = n.replace(/\.onnx$/, '');
      if (out.some((v) => v.id === id)) continue;
      out.push({
        id, file, language: cfg.language?.code || id.split('-')[0], languageName: cfg.language?.name_english || '',
        quality: cfg.audio?.quality || '', speakers: Object.keys(cfg.speaker_id_map || {}),
      });
    }
  }
  return out;
}

// Pick a voice: an exact id, a language code ("vi", "en_US"), or guess from the text (Vietnamese letters).
const VI_LETTERS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
export function pickVoice(voices, { voice, text = '' } = {}) {
  if (!voices.length) return null;
  if (voice) {
    const v = String(voice).toLowerCase();
    return voices.find((x) => x.id.toLowerCase() === v) ||
      voices.find((x) => x.language.toLowerCase() === v.replace('-', '_')) ||
      voices.find((x) => x.language.toLowerCase().startsWith(`${v}_`) || x.id.toLowerCase().startsWith(v)) || null;
  }
  const lang = VI_LETTERS.test(text) ? 'vi' : 'en';
  return voices.find((x) => x.language.startsWith(`${lang}_`)) || voices[0];
}

// How to run piper: [command, ...args before ours], or null when it is not installed.
let piperCmd;
export function piperCommand() {
  if (piperCmd !== undefined) return piperCmd;
  const custom = get('tts.piperCommand');
  const tries = [
    custom ? [custom] : null,
    ['piper'],
    ['python', '-m', 'piper'], ['python3', '-m', 'piper'], ['py', '-m', 'piper'],
  ].filter(Boolean);
  piperCmd = null;
  for (const c of tries) {
    try { execFileSync(c[0], [...c.slice(1), '--help'], { stdio: 'ignore', timeout: 30000 }); piperCmd = c; break; } catch { /* next */ }
  }
  return piperCmd;
}

function runPiper(args) {
  const cmd = piperCommand();
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0], [...cmd.slice(1), ...args], { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper failed: ${err.split('\n').filter(Boolean).slice(-3).join(' ')}`))));
  });
}

// ---------- Settings (src/settings.js): engine, ElevenLabs key / model / voice, Piper command ----------
// The API key never leaves the server: ttsSettings() only says whether one is set and its last 4 characters.
export const ENGINES = ['piper', 'elevenlabs'];
export const EL_DEFAULT_MODEL = 'eleven_v3';
export const elevenKey = () => get('tts.elevenlabs.apiKey');
const elBase = () => (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
onSettingsChange((keys) => {
  if (keys.includes('tts.piperCommand')) piperCmd = undefined;
  if (keys.includes('tts.elevenlabs.apiKey')) elCache.key = null;
});

export function ttsSettings() {
  const key = elevenKey(), src = source('tts.elevenlabs.apiKey');
  return {
    engine: ENGINES.includes(get('tts.engine')) ? get('tts.engine') : 'piper',
    piper: { installed: !!piperCommand(), voices: listVoices().map((v) => ({ id: v.id, language: v.language })) },
    elevenlabs: {
      hasKey: !!key, keySource: src === 'env' ? 'env' : key ? 'saved' : null, keyHint: key ? `…${key.slice(-4)}` : null,
      model: get('tts.elevenlabs.model') || EL_DEFAULT_MODEL, voice: get('tts.elevenlabs.voice'),
    },
  };
}

// ElevenLabs REST call. Errors carry the service's own message (bad key, quota, unknown voice...).
async function el(pathname, { method = 'GET', body, key = elevenKey(), raw = false } = {}) {
  if (!key) throw new Error(EL_HELP);
  let r;
  try {
    r = await fetch(`${elBase()}${pathname}`, {
      method, headers: { 'xi-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: raw ? 'audio/mpeg' : 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000),
    });
  } catch (e) { throw new Error(`Could not reach ElevenLabs: ${e.message}`); }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = j.detail?.message || j.detail?.status || (typeof j.detail === 'string' ? j.detail : null) || msg; } catch { /* not JSON */ }
    throw new Error(`ElevenLabs: ${msg}${r.status === 401 ? ' (check the API key)' : ''}`);
  }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
export const EL_HELP = 'No ElevenLabs API key: open 🗣 Voice in the editor, pick ElevenLabs and paste your key (elevenlabs.io → Developers → API keys), or set ELEVENLABS_API_KEY.';

const elCache = { voices: null, models: null, at: 0, key: null };
// Voices on the account: [{id, name, category, labels}] (cached 10 minutes per key).
export async function elevenVoices({ force = false } = {}) {
  const key = elevenKey();
  if (!force && elCache.voices && elCache.key === key && Date.now() - elCache.at < 600000) return elCache.voices;
  const j = await el('/v1/voices', { key });
  elCache.voices = (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category || '', labels: v.labels || {} }));
  elCache.key = key; elCache.at = Date.now();
  return elCache.voices;
}
// Text-to-speech models with their languages: [{id, name, languages: [{id, name}]}].
export async function elevenModels() {
  const key = elevenKey();
  if (elCache.models && elCache.key === key) return elCache.models;
  const j = await el('/v1/models', { key });
  elCache.models = (Array.isArray(j) ? j : j.models || []).filter((m) => m.can_do_text_to_speech !== false)
    .map((m) => ({ id: m.model_id, name: m.name || m.model_id, languages: (m.languages || []).map((l) => ({ id: l.language_id, name: l.name })) }));
  return elCache.models;
}
export function pickElevenVoice(voices, wanted) {
  if (!voices.length) return null;
  if (wanted) {
    const w = String(wanted).toLowerCase();
    return voices.find((v) => v.id.toLowerCase() === w) || voices.find((v) => v.name.toLowerCase() === w) ||
      voices.find((v) => v.name.toLowerCase().startsWith(w)) || null;
  }
  return voices.find((v) => v.category === 'premade') || voices[0];
}

// Check an ElevenLabs key against the API before it is saved (throws with ElevenLabs' message on a bad key).
export async function verifyElevenKey(k) {
  const key = String(k || '').trim();
  if (!/^[\w-]{16,200}$/.test(key)) throw new Error('That does not look like an ElevenLabs API key');
  await el('/v1/voices', { key });
}

// Save TTS settings from the Voice panel. elevenlabsKey: a new key (checked first), '' removes the saved key.
export async function saveTtsSettings(input = {}) {
  const patch = {};
  if (input.engine !== undefined) {
    if (!ENGINES.includes(input.engine)) throw new Error(`engine must be one of: ${ENGINES.join(', ')}`);
    patch['tts.engine'] = input.engine;
  }
  if (input.elevenlabsKey !== undefined) {
    const k = String(input.elevenlabsKey).trim();
    if (k) await verifyElevenKey(k);
    patch['tts.elevenlabs.apiKey'] = k;
  }
  if (input.elevenlabsModel !== undefined) patch['tts.elevenlabs.model'] = input.elevenlabsModel;
  if (input.elevenlabsVoice !== undefined) patch['tts.elevenlabs.voice'] = input.elevenlabsVoice;
  setSettings(patch);
  return ttsSettings();
}

// ElevenLabs voice settings for an expressiveness 0 (calm, steady) .. 1 (lively). v3 only takes stability
// 0 (creative), 0.5 (natural) or 1 (robust); older models also take a style exaggeration.
export function elevenVoiceSettings(model, expressiveness) {
  if (expressiveness === undefined || expressiveness === null) return undefined;
  const e = Math.max(0, Math.min(1, Number(expressiveness)));
  if (/^eleven_v3/.test(model)) return { stability: e >= 0.67 ? 0 : e >= 0.34 ? 0.5 : 1 };
  return { stability: Math.round((0.8 - 0.6 * e) * 100) / 100, similarity_boost: 0.75, style: Math.round(0.7 * e * 100) / 100, use_speaker_boost: true };
}
// Piper's variation knobs for an expressiveness 0..1 (Piper's defaults 0.667 / 0.8 sit near 0.45).
export function piperNoise(expressiveness) {
  if (expressiveness === undefined || expressiveness === null) return [];
  const e = Math.max(0, Math.min(1, Number(expressiveness)));
  return ['--noise-scale', String(Math.round((0.35 + 0.7 * e) * 1000) / 1000), '--noise-w-scale', String(Math.round((0.45 + 0.8 * e) * 1000) / 1000)];
}

// Speak text into an audio file in data/media. The same text + engine + voice + settings reuse the earlier
// file (so asking again costs nothing). speed: 0.5-2; speaker: Piper multi-speaker voices; pause: seconds
// between sentences (Piper); expressiveness: 0 calm .. 1 lively; model: ElevenLabs model id.
// Returns { file, path, engine, voice: {id, name}, chars }.
export async function synthesize({ engine, text, voice, speed = 1, speaker, pause = 0.25, expressiveness, model }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('text is required');
  const eng = engine || ttsSettings().engine;
  if (!ENGINES.includes(eng)) throw new Error(`engine must be one of: ${ENGINES.join(', ')}`);
  return eng === 'elevenlabs' ? speakEleven({ t, voice, speed, expressiveness, model }) : speakPiper({ t, voice, speed, speaker, pause, expressiveness });
}

async function speakPiper({ t, voice, speed, speaker, pause, expressiveness }) {
  const voices = listVoices();
  if (!piperCommand()) throw new Error(PIPER_HELP);
  if (!voices.length) throw new Error(`No Piper voices installed in ${VOICE_DIRS()[0]}. ${PIPER_HELP}`);
  const v = pickVoice(voices, { voice, text: t });
  if (!v) throw new Error(`No Piper voice "${voice}". Installed: ${voices.map((x) => x.id).join(', ')}`);
  let sid;
  if (speaker !== undefined && speaker !== null && speaker !== '') {
    sid = v.speakers.includes(String(speaker)) ? v.speakers.indexOf(String(speaker)) : Number(speaker);
    if (!Number.isInteger(sid) || sid < 0 || (v.speakers.length && sid >= v.speakers.length)) throw new Error(`Voice ${v.id} has speakers: ${v.speakers.join(', ') || 'only one'}`);
  }
  const noise = piperNoise(expressiveness);
  const key = crypto.createHash('sha1').update(JSON.stringify([t, v.id, speed, sid ?? null, pause, ...(noise.length ? [noise] : [])])).digest('hex').slice(0, 12);
  const file = `f_tts_${key}.wav`, out = path.join(MEDIA_DIR, file);
  if (!fs.existsSync(out)) {
    const txt = path.join(MEDIA_DIR, `${file}.txt`), tmp = `${out}.part.wav`;
    fs.writeFileSync(txt, t, 'utf8');
    try {
      await runPiper(['-m', v.file, '-i', txt, '-f', tmp, '--length-scale', String(Math.round((1 / speed) * 1000) / 1000),
        '--sentence-silence', String(pause), ...(sid !== undefined ? ['-s', String(sid)] : []), ...noise]);
      fs.renameSync(tmp, out);
    } finally { fs.rmSync(txt, { force: true }); fs.rmSync(tmp, { force: true }); }
  }
  return { file, path: out, engine: 'piper', voice: { id: v.id, name: v.id }, chars: 0 };
}

async function speakEleven({ t, voice, speed, expressiveness, model }) {
  if (!elevenKey()) throw new Error(EL_HELP);
  const st = ttsSettings().elevenlabs;
  const voices = await elevenVoices();
  const v = pickElevenVoice(voices, voice || st.voice);
  if (!v) throw new Error(`No ElevenLabs voice "${voice || st.voice}". Voices: ${voices.slice(0, 30).map((x) => x.name).join(', ')}`);
  const modelId = model || st.model || EL_DEFAULT_MODEL;
  if (/^eleven_v3/.test(modelId) && t.length > 5000) throw new Error(`${modelId} takes at most 5000 characters per voiceover; split the script (this one has ${t.length}).`);
  const vs = elevenVoiceSettings(modelId, expressiveness);
  const key = crypto.createHash('sha1').update(JSON.stringify(['elevenlabs', t, v.id, modelId, vs ?? null, speed])).digest('hex').slice(0, 12);
  const file = `f_tts_${key}.mp3`, out = path.join(MEDIA_DIR, file);
  if (!fs.existsSync(out)) {
    const audio = await el(`/v1/text-to-speech/${encodeURIComponent(v.id)}?output_format=mp3_44100_128`, {
      method: 'POST', raw: true, body: { text: t, model_id: modelId, ...(vs ? { voice_settings: vs } : {}) },
    });
    if (audio.length < 200) throw new Error('ElevenLabs returned no audio');
    const tmp = `${out}.part.mp3`;
    fs.writeFileSync(tmp, audio);
    try {
      // Speed is applied here (pitch kept), the same way for every model.
      if (Math.abs(speed - 1) > 0.001) {
        const sp = `${out}.speed.mp3`;
        await runFfmpeg(['-y', '-v', 'error', '-i', tmp, '-af', `atempo=${speed}`, '-c:a', 'libmp3lame', '-b:a', '160k', sp]);
        fs.renameSync(sp, tmp);
      }
      fs.renameSync(tmp, out);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  return { file, path: out, engine: 'elevenlabs', voice: { id: v.id, name: v.name }, model: modelId, chars: t.length };
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}
