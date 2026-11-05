// Holds the open project in memory, persists projects to disk, keeps undo/redo history per project.
import fs from 'node:fs';
import path from 'node:path';
import { emptyProject, ops, OpError, layout, migrate, allIds, ASPECTS } from './model.js';

export const DATA_DIR = process.env.VIDEOGEN_DATA || path.resolve('data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const TRASH_DIR = path.join(DATA_DIR, 'trash');
export const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');
export const FONTS_DIR = path.join(DATA_DIR, 'fonts');
export const PROXY_DIR = path.join(DATA_DIR, 'proxies');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
for (const d of [DATA_DIR, MEDIA_DIR, EXPORT_DIR, PROJECTS_DIR, TRASH_DIR, ANALYSIS_DIR, FONTS_DIR, PROXY_DIR, path.join(DATA_DIR, 'thumbs')]) fs.mkdirSync(d, { recursive: true });

const projectFile = (id) => path.join(PROJECTS_DIR, id, 'project.json');
const projectIds = () => fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(projectFile(e.name))).map((e) => e.name);
const readProject = (id) => migrate(JSON.parse(fs.readFileSync(projectFile(id), 'utf8')));
const writeProject = (p) => {
  fs.mkdirSync(path.dirname(projectFile(p.id)), { recursive: true });
  const f = projectFile(p.id);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(p, null, 2));
  fs.renameSync(`${f}.tmp`, f);
};

// One-time migration from the single-project layout (data/project.json).
const LEGACY = path.join(DATA_DIR, 'project.json');
if (fs.existsSync(LEGACY) && !projectIds().length) {
  const p = migrate(JSON.parse(fs.readFileSync(LEGACY, 'utf8')));
  writeProject(p);
  fs.renameSync(LEGACY, `${LEGACY}.migrated`);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ current: p.id }));
}

let state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { current: null };
let project;
{
  const ids = projectIds();
  const id = ids.includes(state.current) ? state.current : ids[0];
  if (id) project = readProject(id);
  else { project = emptyProject(); writeProject(project); }
  state.current = project.id;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

const histories = new Map(); // project id -> { undo: [], redo: [] }
const hist = () => {
  if (!histories.has(project.id)) histories.set(project.id, { undo: [], redo: [] });
  return histories.get(project.id);
};
const listeners = new Set();

const save = () => writeProject(project);
const emit = (source) => { for (const l of listeners) l(project, source); };
const fail = (m) => { throw new OpError(m); };

export const getProject = () => project;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function commit(draft, source) {
  const h = hist();
  h.undo.push(project);
  if (h.undo.length > 100) h.undo.shift();
  h.redo.length = 0;
  project = draft;
  save(); emit(source);
}

export function apply(name, input = {}, source = 'ui') {
  const op = ops[name];
  if (!op) throw new OpError(`Unknown operation ${name}`);
  const draft = structuredClone(project);
  const msg = op(draft, input);
  commit(draft, source);
  return msg;
}

// Run several ops atomically as one undo step. A string input value "$N" is replaced
// by the id of the item created by step N (1-based), so later steps can refer to it.
export function applyBatch(steps, source = 'ui') {
  if (!Array.isArray(steps) || !steps.length) fail('ops must be a non-empty array of {name, input}');
  if (steps.length > 200) fail('At most 200 ops per batch');
  const draft = structuredClone(project);
  const created = [];
  const msgs = [];
  const resolve = (v) => {
    if (typeof v === 'string' && /^\$\d+$/.test(v)) {
      const id = created[Number(v.slice(1)) - 1];
      if (!id) fail(`${v} does not refer to an earlier step that created an item`);
      return id;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  steps.forEach((s, i) => {
    const name = s?.name;
    if (!ops[name]) fail(`Step ${i + 1}: "${name}" is not an editing operation. Allowed: ${Object.keys(ops).join(', ')}`);
    const before = allIds(draft);
    try {
      msgs.push(`${i + 1}. ${ops[name](draft, resolve(s.input || {}))}`);
    } catch (e) {
      throw new OpError(`Step ${i + 1} (${name}) failed: ${e.message}. No changes were applied.`);
    }
    created.push([...allIds(draft)].find((id) => !before.has(id)) || null);
  });
  commit(draft, source);
  return msgs.join('\n');
}

export function addAsset(a) {
  const h = hist();
  h.undo.push(project);
  project = structuredClone(project);
  project.assets[a.id] = a;
  save(); emit('upload');
}

export function undo(source = 'ui') {
  const h = hist();
  if (!h.undo.length) return 'Nothing to undo';
  h.redo.push(project);
  project = h.undo.pop();
  save(); emit(source);
  return 'Undid last change';
}
export function redo(source = 'ui') {
  const h = hist();
  if (!h.redo.length) return 'Nothing to redo';
  h.undo.push(project);
  project = h.redo.pop();
  save(); emit(source);
  return 'Redid change';
}

export const withLayout = () => ({ project, layout: layout(project) });

// ---------- Projects ----------
export function listProjects() {
  return projectIds().map((id) => {
    const p = id === project.id ? project : readProject(id);
    return {
      id, name: p.name, aspect: p.settings.aspect, clips: p.clips.length, duration: layout(p).duration,
      updatedAt: fs.statSync(projectFile(id)).mtime.toISOString(), current: id === project.id,
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function findProjectId(idOrName) {
  const ids = projectIds();
  if (ids.includes(idOrName)) return idOrName;
  const byName = listProjects().filter((p) => p.name.toLowerCase() === String(idOrName || '').toLowerCase());
  if (byName.length === 1) return byName[0].id;
  fail(`No project "${idOrName}". Projects: ${listProjects().map((p) => `${p.id} "${p.name}"`).join(', ')}`);
}

export function openProject(idOrName, source = 'ui') {
  const id = findProjectId(idOrName);
  project = readProject(id);
  state.current = id;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  emit(source);
  return project;
}

// copyMedia: start with the open project's media library (files are shared, not copied).
// build(p): optional, fills the new project before it is saved; if it throws, nothing is created.
export function createProject({ name, aspect, copyMedia = true, build } = {}, source = 'ui') {
  const p = emptyProject();
  if (name) p.name = String(name).trim().slice(0, 120);
  if (aspect) {
    if (!ASPECTS[aspect]) fail(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`);
    p.settings.aspect = aspect;
    [p.settings.width, p.settings.height] = ASPECTS[aspect];
  }
  if (copyMedia) p.assets = structuredClone(project.assets);
  if (build) build(p);
  writeProject(p);
  return openProject(p.id, source);
}

export function duplicateProject(idOrName, name, source = 'ui') {
  const src = idOrName ? readProject(findProjectId(idOrName)) : project;
  const p = structuredClone(src);
  p.id = emptyProject().id;
  p.name = name ? String(name).trim().slice(0, 120) : `${src.name} (copy)`;
  writeProject(p);
  return openProject(p.id, source);
}

// Moves the project folder to data/trash (recoverable by moving it back).
export function deleteProject(idOrName) {
  const id = findProjectId(idOrName);
  if (id === project.id) fail('Cannot delete the open project. Open another project first.');
  const p = readProject(id);
  fs.renameSync(path.join(PROJECTS_DIR, id), path.join(TRASH_DIR, `${id}-${Date.now()}`));
  histories.delete(id);
  return p;
}
