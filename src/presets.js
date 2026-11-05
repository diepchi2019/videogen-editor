// Saved reel styles and templates: data/styles/<id>.json and data/templates/<id>.json.
// They are shared by all projects. Media they use stays in data/media (shared too).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, TRASH_DIR } from './store.js';
import { BUILTIN_STYLES, normalizeStyle, OpError, uid } from './model.js';

export const STYLES_DIR = path.join(DATA_DIR, 'styles');
export const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
for (const d of [STYLES_DIR, TEMPLATES_DIR]) fs.mkdirSync(d, { recursive: true });

const fail = (m) => { throw new OpError(m); };
const lower = (s) => String(s ?? '').trim().toLowerCase();

function readAll(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]; } catch { return []; }
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function writeJson(dir, obj) {
  const f = path.join(dir, `${obj.id}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(obj, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}
// Find by id or by name (case-insensitive).
function find(list, idOrName, kind, listTool) {
  const key = lower(idOrName);
  const hit = list.find((x) => x.id === idOrName) || list.find((x) => lower(x.name) === key);
  if (!hit) fail(`No ${kind} "${idOrName}". ${list.length ? `${kind[0].toUpperCase() + kind.slice(1)}s: ${list.map((x) => `${x.id} "${x.name}"`).join(', ')}` : `There are no saved ${kind}s yet.`} (${listTool})`);
  return hit;
}

// ---------- Styles ----------
export const listStyles = () => [...BUILTIN_STYLES, ...readAll(STYLES_DIR)];
export const loadStyle = (idOrName) => find(listStyles(), idOrName, 'style', 'list_styles');

// Saves a style (validated). Same name as an existing user style = update it in place.
export function saveStyle(input) {
  const st = normalizeStyle(input);
  if (BUILTIN_STYLES.some((b) => lower(b.name) === lower(st.name))) fail(`"${st.name}" is a built-in style. Pick another name.`);
  const old = readAll(STYLES_DIR).find((x) => lower(x.name) === lower(st.name));
  const now = new Date().toISOString();
  const saved = { id: old?.id || uid('style'), ...st, createdAt: old?.createdAt || now, updatedAt: now };
  writeJson(STYLES_DIR, saved);
  return { style: saved, updated: !!old };
}

export function deleteStyle(idOrName) {
  const st = loadStyle(idOrName);
  if (st.builtin) fail(`"${st.name}" is built in and cannot be deleted`);
  fs.renameSync(path.join(STYLES_DIR, `${st.id}.json`), path.join(TRASH_DIR, `${st.id}-${Date.now()}.json`));
  return st;
}

// ---------- Templates ----------
export const listTemplates = () => readAll(TEMPLATES_DIR);
export const loadTemplate = (idOrName) => find(listTemplates(), idOrName, 'template', 'list_templates');

// tpl comes from makeTemplate(). Same name = update it in place.
export function saveTemplate(tpl) {
  const old = listTemplates().find((x) => lower(x.name) === lower(tpl.name));
  const now = new Date().toISOString();
  const saved = { id: old?.id || uid('tpl'), ...tpl, createdAt: old?.createdAt || now, updatedAt: now };
  writeJson(TEMPLATES_DIR, saved);
  return { template: saved, updated: !!old };
}

export function deleteTemplate(idOrName) {
  const t = loadTemplate(idOrName);
  fs.renameSync(path.join(TEMPLATES_DIR, `${t.id}.json`), path.join(TRASH_DIR, `${t.id}-${Date.now()}.json`));
  return t;
}

// Short lists for the UI.
export const presetLists = () => ({
  styles: listStyles().map((s) => ({ id: s.id, name: s.name, builtin: !!s.builtin, description: s.description || '' })),
  templates: listTemplates().map((t) => ({ id: t.id, name: t.name, slots: t.slots.length, duration: t.duration, aspect: t.settings.aspect })),
});
