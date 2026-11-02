// Font discovery: reads family names from TTF/OTF/TTC name tables (no dependencies).
// Exports copy the files of the families they use into the render's fontsdir,
// so libass finds them the same way on every OS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FONTS_DIR } from './store.js';

const EXT = /\.(ttf|otf|ttc)$/i;
const home = os.homedir();
const SYSTEM_DIRS = process.platform === 'win32'
  ? [path.join(process.env.WINDIR || 'C:/Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts')]
  : process.platform === 'darwin'
    ? ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(home, 'Library/Fonts')]
    : ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local/share/fonts')];

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  if (n < len) throw new Error('short read');
  return b;
}

// Family name (nameID 1) of the first font in the file.
export function readFamily(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let base = 0;
    const tag = readAt(fd, 0, 12);
    if (tag.toString('latin1', 0, 4) === 'ttcf') base = readAt(fd, 12, 4).readUInt32BE(0);
    const off = readAt(fd, base, 12);
    const numTables = off.readUInt16BE(4);
    const dir = readAt(fd, base + 12, numTables * 16);
    let nameOff = -1;
    for (let i = 0; i < numTables; i++) if (dir.toString('latin1', i * 16, i * 16 + 4) === 'name') nameOff = dir.readUInt32BE(i * 16 + 8);
    if (nameOff < 0) return null;
    const hdr = readAt(fd, nameOff, 6);
    const count = hdr.readUInt16BE(2), strOff = hdr.readUInt16BE(4);
    const recs = readAt(fd, nameOff + 6, count * 12);
    let best = null, bestScore = -1;
    for (let i = 0; i < count; i++) {
      const r = i * 12;
      const plat = recs.readUInt16BE(r), enc = recs.readUInt16BE(r + 2), lang = recs.readUInt16BE(r + 4), id = recs.readUInt16BE(r + 6);
      if (id !== 1) continue;
      const score = plat === 3 && lang === 0x409 ? 3 : plat === 3 ? 2 : plat === 1 && enc === 0 ? 1 : 0;
      if (score > bestScore) { bestScore = score; best = { plat, len: recs.readUInt16BE(r + 8), off: recs.readUInt16BE(r + 10) }; }
    }
    if (!best) return null;
    const raw = readAt(fd, nameOff + strOff + best.off, best.len);
    const name = best.plat === 3 || best.plat === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    return name.replace(/\0/g, '').trim() || null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, out, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walk(f, out, depth + 1);
    else if (EXT.test(e.name)) out.push(f);
  }
}

let cache = null; // Map<lowercase family, { family, files: [], user }>
export function fontIndex() {
  if (cache) return cache;
  cache = new Map();
  const add = (dir, user) => {
    const files = [];
    walk(dir, files);
    for (const f of files) {
      const fam = readFamily(f);
      if (!fam) continue;
      const k = fam.toLowerCase();
      if (!cache.has(k)) cache.set(k, { family: fam, files: [], user });
      cache.get(k).files.push(f);
    }
  };
  add(FONTS_DIR, true);
  for (const d of SYSTEM_DIRS) add(d, false);
  return cache;
}
export const invalidateFonts = () => { cache = null; };

export function resolveFont(name) {
  return fontIndex().get(String(name).trim().toLowerCase())?.family || null;
}

export function listFonts(search) {
  const all = [...fontIndex().values()];
  const q = search ? String(search).toLowerCase() : null;
  return all.filter((f) => !q || f.family.toLowerCase().includes(q))
    .sort((a, b) => (b.user - a.user) || a.family.localeCompare(b.family));
}

// Default family: VIDEOGEN_FONT (a file path) or the first common sans font found.
let def;
export function defaultFont() {
  if (def !== undefined) return def;
  const envFile = process.env.VIDEOGEN_FONT;
  const fromEnv = envFile && fs.existsSync(envFile) ? readFamily(envFile) : null;
  def = fromEnv || ['Arial', 'DejaVu Sans', 'Helvetica', 'Liberation Sans', 'Noto Sans', 'Roboto'].find((f) => resolveFont(f)) ||
    listFonts()[0]?.family || 'Sans';
  return resolveFont(def) || def;
}

// Copy every file of the given families into dir (for the ass filter's fontsdir).
export function stageFonts(families, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const idx = fontIndex();
  const envFile = process.env.VIDEOGEN_FONT;
  if (envFile && fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(dir, path.basename(envFile)));
  for (const fam of new Set(families)) {
    const e = idx.get(String(fam).toLowerCase());
    if (!e) continue;
    for (const f of e.files) {
      const dest = path.join(dir, path.basename(f));
      if (!fs.existsSync(dest)) fs.copyFileSync(f, dest);
    }
  }
}
