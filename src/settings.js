// Central settings: data/settings.json. Every setting is read here, in this order:
// environment variable (wins, handy for tests and scripts) > the file (edited in the ⚙ Settings panel) > default.
// Secrets (API keys) are write-only from the outside: publicSettings() only says whether one is set and its last
// 4 characters, so they never reach the browser or Claude. Settings needed before this file can be read (PORT,
// VIDEOGEN_DATA) and test hooks (ANTHROPIC_BASE_URL, ELEVENLABS_BASE_URL) stay environment-only.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

// key: { env, secret, default, label, choices?, check?(value) -> error text }
export const SETTINGS = {
  'claude.apiKey': { env: 'ANTHROPIC_API_KEY', secret: true, label: 'Anthropic API key (in-app chat)', check: (v) => (v.length < 8 || /\s/.test(v) ? 'That does not look like an Anthropic API key' : null) },
  'claude.model': { env: 'CLAUDE_MODEL', default: 'claude-sonnet-5-5', label: 'Claude model for the in-app chat', check: (v) => (/^[\w.:-]{3,100}$/.test(v) ? null : 'Model ids look like claude-sonnet-5-5') },
  'tts.engine': { default: 'piper', choices: ['piper', 'elevenlabs'], label: 'Text-to-speech engine' },
  'tts.elevenlabs.apiKey': { env: 'ELEVENLABS_API_KEY', secret: true, label: 'ElevenLabs API key', check: (v) => (/^[\w-]{16,200}$/.test(v) ? null : 'That does not look like an ElevenLabs API key') },
  'tts.elevenlabs.model': { default: 'eleven_v3', label: 'ElevenLabs model' },
  'tts.elevenlabs.voice': { default: null, label: 'ElevenLabs voice' },
  'tts.piperCommand': { env: 'VIDEOGEN_PIPER', default: null, label: 'Piper executable (empty = python -m piper)' },
  'captions.whisperModel': { env: 'VIDEOGEN_WHISPER_MODEL', default: null, label: 'Whisper model (empty = most accurate found)' },
  'export.loudness': { default: '-14', choices: ['-14', '-16', '-23', 'off'], label: 'Loudness of exported videos (LUFS)' },
  'text.defaultFont': { env: 'VIDEOGEN_FONT', default: null, label: 'Default text font (empty = Arial or the first common sans)' },
};

const file = () => path.join(DATA_DIR, 'settings.json');
const listeners = new Set();
let cache = null, cacheMtime = 0;
const mtime = () => { try { return fs.statSync(file()).mtimeMs; } catch { return 0; } };
function load() {
  // Re-read when the file changed on disk (edited by hand while the editor runs).
  if (cache && mtime() === cacheMtime) return cache;
  const had = cache !== null;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = {}; }
  cacheMtime = mtime();
  if (had) for (const fn of listeners) fn(Object.keys(SETTINGS));
  // data/tts.json (the first, TTS-only settings file) moves in here once.
  const old = path.join(DATA_DIR, 'tts.json');
  if (fs.existsSync(old)) {
    try {
      const t = JSON.parse(fs.readFileSync(old, 'utf8'));
      const flat = { 'tts.engine': t.engine, 'tts.elevenlabs.apiKey': t.elevenlabs?.apiKey, 'tts.elevenlabs.model': t.elevenlabs?.model, 'tts.elevenlabs.voice': t.elevenlabs?.voice };
      for (const [k, v] of Object.entries(flat)) if (v && getIn(cache, k) === undefined) setIn(cache, k, v);
      save();
      fs.rmSync(old, { force: true });
    } catch { /* unreadable: leave it */ }
  }
  return cache;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  cacheMtime = mtime();
}
const getIn = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
function setIn(o, k, v) {
  const ps = k.split('.');
  let x = o;
  for (const p of ps.slice(0, -1)) x = x[p] && typeof x[p] === 'object' ? x[p] : (x[p] = {});
  if (v === undefined) delete x[ps.at(-1)]; else x[ps.at(-1)] = v;
}

const def = (key) => { if (!SETTINGS[key]) throw new Error(`Unknown setting ${key}`); return SETTINGS[key]; };
const fromEnv = (key) => { const e = def(key).env; const v = e ? process.env[e] : undefined; return v !== undefined && v !== '' ? v : undefined; };
export function get(key) {
  const e = fromEnv(key);
  if (e !== undefined) return e;
  const v = getIn(load(), key);
  return v !== undefined && v !== '' ? v : def(key).default ?? null;
}
export function source(key) {
  if (fromEnv(key) !== undefined) return 'env';
  const v = getIn(load(), key);
  return v !== undefined && v !== '' ? 'file' : 'default';
}

export const onSettingsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Apply a patch {key: value}. '' or null clears a setting (back to the default). Unknown keys and bad values throw
// before anything is written, so a patch is all or nothing.
export function setSettings(patch = {}) {
  const changes = [];
  for (const [key, raw] of Object.entries(patch)) {
    const d = def(key);
    const v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (v !== '') {
      if (d.choices && !d.choices.includes(v)) throw new Error(`${key} must be one of: ${d.choices.join(', ')}`);
      const err = d.check?.(v);
      if (err) throw new Error(err);
    }
    changes.push([key, v === '' ? undefined : v]);
  }
  load();
  for (const [k, v] of changes) setIn(cache, k, v);
  save();
  const keys = changes.map(([k]) => k);
  for (const fn of listeners) fn(keys);
  return publicSettings();
}

// What the browser may see: values of normal settings, only {set, hint} for secrets, and where each comes from.
export function publicSettings() {
  const out = {};
  for (const [key, d] of Object.entries(SETTINGS)) {
    const v = get(key), src = source(key);
    out[key] = {
      label: d.label, source: src, env: d.env || null, ...(d.choices ? { choices: d.choices } : {}),
      ...(d.secret ? { secret: true, set: !!v, hint: v ? `…${String(v).slice(-4)}` : null } : { value: v }),
    };
  }
  return out;
}

// For tests: forget the cached file so a changed VIDEOGEN_DATA or a hand edit is read again.
export const reloadSettings = () => { cache = null; cacheMtime = 0; };
