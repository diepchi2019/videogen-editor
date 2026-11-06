// Imported color LUTs (.cube files) in data/luts. set_color {lut} refers to them by file name.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const LUTS_DIR = path.join(DATA_DIR, 'luts');
fs.mkdirSync(LUTS_DIR, { recursive: true });

export const listLuts = () => fs.readdirSync(LUTS_DIR).filter((f) => /\.cube$/i.test(f)).sort((a, b) => a.localeCompare(b));
export const lutPath = (file) => path.join(LUTS_DIR, path.basename(file));

const safeName = (s) => s.replace(/[^\w.-]+/g, '_');
// By file name or the name it was imported under, with or without .cube, case-insensitive. Returns the file name or null.
export function resolveLut(name) {
  const key = safeName(String(name).trim()).toLowerCase().replace(/\.cube$/, '');
  return listLuts().find((f) => f.toLowerCase().replace(/\.cube$/, '') === key) || null;
}

// Check a .cube file and store it under a safe name. Returns the stored file name.
export function importLut(tmpFile, originalName) {
  const head = fs.readFileSync(tmpFile, 'utf8').slice(0, 64 * 1024);
  if (!/^\s*LUT_3D_SIZE\s+\d+/m.test(head)) throw new Error(`${originalName}: not a 3D .cube LUT (no LUT_3D_SIZE line)`);
  const name = safeName(path.basename(originalName)).replace(/\.cube$/i, '') + '.cube';
  fs.renameSync(tmpFile, path.join(LUTS_DIR, name));
  return name;
}
