// Color emoji for captions. libass draws emoji only as black-and-white outlines, so the export puts them
// on as images: Noto Color Emoji PNGs (Apache 2.0), downloaded once per emoji into data/emoji/.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const EMOJI_DIR = path.join(DATA_DIR, 'emoji');
// The repo moved its PNGs under 2D/ in 2025; the old path is tried too in case it moves again.
const BASES = () => (process.env.VIDEOGEN_EMOJI_URL ? [process.env.VIDEOGEN_EMOJI_URL]
  : ['https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/512', 'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512']);

// Noto's file name: code points in hex joined by "_", without the FE0F variation selector.
export function emojiName(e) {
  return `emoji_u${[...String(e)].map((ch) => ch.codePointAt(0)).filter((cp) => cp !== 0xfe0f).map((cp) => cp.toString(16)).join('_')}.png`;
}
export function emojiFile(e) {
  const f = path.join(EMOJI_DIR, emojiName(e));
  return fs.existsSync(f) ? f : null;
}
// Downloads the emoji if it is not there yet. Returns the file path; throws when it cannot be fetched.
export async function fetchEmoji(e) {
  const have = emojiFile(e);
  if (have) return have;
  const name = emojiName(e);
  let r;
  for (const base of BASES()) {
    r = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) break;
  }
  if (!r.ok) throw new Error(r.status === 404 ? `no image for ${e} in Noto Emoji` : `download failed (HTTP ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('download was not a PNG');
  fs.mkdirSync(EMOJI_DIR, { recursive: true });
  const f = path.join(EMOJI_DIR, name);
  fs.writeFileSync(f, buf);
  return f;
}
