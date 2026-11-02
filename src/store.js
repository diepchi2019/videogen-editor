// Holds the single project in memory, persists it to disk, keeps undo/redo history.
import fs from 'node:fs';
import path from 'node:path';
import { emptyProject, ops, OpError, layout } from './model.js';

export const DATA_DIR = process.env.VIDEOGEN_DATA || path.resolve('data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const FILE = path.join(DATA_DIR, 'project.json');
for (const d of [DATA_DIR, MEDIA_DIR, EXPORT_DIR, path.join(DATA_DIR, 'thumbs')]) fs.mkdirSync(d, { recursive: true });

let project = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : emptyProject();
const undoStack = [];
const redoStack = [];
const listeners = new Set();

const save = () => fs.writeFileSync(FILE, JSON.stringify(project, null, 2));
const emit = (source) => { for (const l of listeners) l(project, source); };

export const getProject = () => project;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function apply(name, input = {}, source = 'ui') {
  const op = ops[name];
  if (!op) throw new OpError(`Unknown operation ${name}`);
  const draft = structuredClone(project);
  const msg = op(draft, input);
  undoStack.push(project);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  project = draft;
  save(); emit(source);
  return msg;
}

export function addAsset(a) {
  undoStack.push(project);
  project = structuredClone(project);
  project.assets[a.id] = a;
  save(); emit('upload');
}

export function replace(next, source = 'ui') {
  undoStack.push(project);
  project = next;
  save(); emit(source);
}

export function undo(source = 'ui') {
  if (!undoStack.length) return 'Nothing to undo';
  redoStack.push(project);
  project = undoStack.pop();
  save(); emit(source);
  return 'Undid last change';
}
export function redo(source = 'ui') {
  if (!redoStack.length) return 'Nothing to redo';
  undoStack.push(project);
  project = redoStack.pop();
  save(); emit(source);
  return 'Redid change';
}

export const withLayout = () => ({ project, layout: layout(project) });
