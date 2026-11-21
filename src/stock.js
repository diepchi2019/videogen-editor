// Stock videos and photos. Pexels (free API key in Settings; videos and photos, free to use commercially,
// no credit needed) and Openverse (no key; Creative Commons photos, mostly Flickr and Wikimedia, credit as the
// license asks). Downloads go into data/media like uploads and keep their credit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEDIA_DIR } from './store.js';
import { get as setting } from './settings.js';
import { licenseName } from './library.js';
import { run } from './media.js';

const PEXELS = () => process.env.PEXELS_BASE_URL || 'https://api.pexels.com';
const OPENVERSE = () => process.env.OPENVERSE_URL || 'https://api.openverse.org';
const UA = { 'User-Agent': 'VideoGen/1.0 (local video editor)' };
export const PEXELS_HELP = 'Stock videos come from Pexels, which needs a free API key: sign up at pexels.com/api, then paste the key in ⚙ Settings → Stock media (it stays on this PC). Photos work without a key (Openverse).';
export const pexelsKey = () => setting('stock.pexels.apiKey') || null;

// 9:16 / 4:5 -> portrait, 16:9 -> landscape, 1:1 -> square.
export function orientationFor(aspect) {
  const [w, h] = String(aspect).split(':').map(Number);
  return !w || !h ? null : w === h ? 'square' : w > h ? 'landscape' : 'portrait';
}
// The MP4 rendition to download: the smallest whose short side reaches `want` (the canvas short side), else the
// biggest there is.
export function pickVideoFile(files, want = 1080) {
  const mp4 = (files || []).filter((f) => f.link && (!f.file_type || /mp4/.test(f.file_type)) && f.width && f.height);
  const big = mp4.filter((f) => Math.min(f.width, f.height) >= want).sort((a, b) => a.width * a.height - b.width * b.height);
  return big[0] || mp4.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
}

async function req(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(25000) });
  if (r.status === 401 || r.status === 403) throw new Error('Pexels refused the API key. Check it in ⚙ Settings → Stock media.');
  if (r.status === 429) throw new Error('Too many stock searches right now (rate limit). Wait a minute and try again.');
  if (!r.ok) throw new Error(`Stock media request failed (HTTP ${r.status})`);
  return r;
}
const pexels = (p) => req(new URL(p, PEXELS()), { Authorization: pexelsKey() });
export async function verifyPexelsKey(key) {
  const r = await fetch(new URL('/v1/search?query=nature&per_page=1', PEXELS()), { headers: { ...UA, Authorization: key }, signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error('Pexels refused that API key. Copy it again from pexels.com/api.');
  if (!r.ok) throw new Error(`Could not check the Pexels key (HTTP ${r.status})`);
}

const pexelsCredit = (kind, name, page) => ({ license: 'pexels', licenseName: 'Pexels License (free, no credit needed)', attribution: `${kind === 'video' ? 'Video' : 'Photo'} by ${name} on Pexels`, page });
function fromPexelsVideo(v, want) {
  const f = pickVideoFile(v.video_files, want);
  return {
    id: `pexels-video-${v.id}`, source: 'pexels', kind: 'video', title: (v.url || '').split('/').filter(Boolean).pop()?.replace(/-\d+$/, '').replace(/-/g, ' ') || `Pexels video ${v.id}`,
    creator: v.user?.name || 'Pexels', width: v.width, height: v.height, duration: v.duration, thumb: v.image, page: v.url,
    download: f ? { url: f.link, width: f.width, height: f.height, ext: 'mp4' } : null, credit: pexelsCredit('video', v.user?.name || 'Pexels', v.url),
  };
}
function fromPexelsPhoto(p) {
  const u = new URL(p.src.original);
  for (const [k, v] of Object.entries({ auto: 'compress', cs: 'tinysrgb', fit: 'max', w: '2160', h: '2160' })) u.searchParams.set(k, v);
  return {
    id: `pexels-photo-${p.id}`, source: 'pexels', kind: 'photo', title: p.alt || `Pexels photo ${p.id}`, creator: p.photographer || 'Pexels', width: p.width, height: p.height,
    thumb: p.src.tiny || p.src.small, page: p.url, download: { url: String(u), ext: 'jpg' }, credit: pexelsCredit('photo', p.photographer || 'Pexels', p.url),
  };
}
function fromOpenverseImage(r) {
  const ext = /\.png($|\?)/i.test(r.url) ? 'png' : 'jpg';
  return {
    id: `openverse-${r.id}`, source: 'openverse', kind: 'photo', title: r.title || 'Untitled', creator: r.creator || 'unknown', width: r.width, height: r.height,
    thumb: r.thumbnail, page: r.foreign_landing_url, download: { url: r.url, ext },
    credit: { license: r.license, licenseName: licenseName(r.license, r.license_version), attribution: r.attribution || `"${r.title}" by ${r.creator}`, page: r.foreign_landing_url, source: r.source },
  };
}

// kind video|photo. orientation portrait|landscape|square (or null). want: short side to aim for (videos).
export async function searchStock({ query, kind = 'video', orientation = null, page = 1, want = 1080 } = {}) {
  const pg = Math.max(1, Math.min(20, Math.round(page)));
  if (kind === 'video' || pexelsKey()) {
    if (!pexelsKey()) throw new Error(PEXELS_HELP);
    const u = new URLSearchParams({ query: String(query || '').slice(0, 200), per_page: '15', page: String(pg) });
    if (orientation) u.set('orientation', orientation);
    if (kind === 'video') {
      const j = await (await pexels(`/videos/search?${u}`)).json();
      return { total: j.total_results || 0, source: 'pexels', items: (j.videos || []).map((v) => fromPexelsVideo(v, want)).filter((x) => x.download) };
    }
    const j = await (await pexels(`/v1/search?${u}`)).json();
    return { total: j.total_results || 0, source: 'pexels', items: (j.photos || []).map(fromPexelsPhoto) };
  }
  const u = new URL('/v1/images/', OPENVERSE());
  u.searchParams.set('q', String(query || '').slice(0, 200));
  u.searchParams.set('license_type', 'commercial,modification');
  u.searchParams.set('page_size', '20');
  u.searchParams.set('page', String(pg));
  if (orientation) u.searchParams.set('aspect_ratio', { portrait: 'tall', landscape: 'wide', square: 'square' }[orientation]);
  // Large photos first (many Flickr images are only ~1024px); fall back to any size when there are none.
  u.searchParams.set('size', 'large');
  let j = await (await req(u)).json();
  if (!(j.results || []).length) { u.searchParams.delete('size'); j = await (await req(u)).json(); }
  return { total: j.result_count || 0, source: 'openverse', items: (j.results || []).filter((r) => r.url).map(fromOpenverseImage) };
}
export async function getStockItem(id, { want = 1080 } = {}) {
  let m = /^pexels-(video|photo)-(\d+)$/.exec(String(id));
  if (m) {
    if (!pexelsKey()) throw new Error(PEXELS_HELP);
    if (m[1] === 'video') return fromPexelsVideo(await (await pexels(`/videos/videos/${m[2]}`)).json(), want);
    return fromPexelsPhoto(await (await pexels(`/v1/photos/${m[2]}`)).json());
  }
  m = /^openverse-([0-9a-f-]{36})$/i.exec(String(id));
  if (m) return fromOpenverseImage(await (await req(new URL(`/v1/images/${m[1]}/`, OPENVERSE()))).json());
  throw new Error(`"${id}" is not a stock id (search_stock lists them, e.g. pexels-video-123)`);
}
// Download once into data/media (streamed: stock videos can be large). Returns { file, path }.
export async function downloadStock(item) {
  if (!item.download) throw new Error('This item has no downloadable file');
  const file = `f_stock_${crypto.createHash('sha1').update(item.id).digest('hex').slice(0, 12)}.${item.download.ext}`;
  const dest = path.join(MEDIA_DIR, file);
  if (fs.existsSync(dest)) return { file, path: dest };
  const r = await fetch(item.download.url, { headers: UA, signal: AbortSignal.timeout(300000) });
  if (!r.ok || !r.body) throw new Error(`Download failed (HTTP ${r.status})`);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(`${dest}.part`));
  if (fs.statSync(`${dest}.part`).size < 1000) { fs.rmSync(`${dest}.part`, { force: true }); throw new Error('The download was empty'); }
  if (item.kind === 'photo' && Math.max(item.width || 0, item.height || 0) > 2160) {
    // Huge originals (some are 5000px+) are scaled to 2160px: plenty for 4K, much quicker to render.
    const tmp = `${dest}.small.${item.download.ext}`;
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', `${dest}.part`, '-vf', "scale='min(2160,iw)':'min(2160,ih)':force_original_aspect_ratio=decrease", '-q:v', '2', tmp]);
      fs.renameSync(tmp, `${dest}.part`);
    } catch { fs.rmSync(tmp, { force: true }); }
  }
  fs.renameSync(`${dest}.part`, dest);
  return { file, path: dest };
}
export function stockLine(x, i) {
  return `${i + 1}. ${x.id} ${x.kind}${x.duration ? ` ${x.duration}s` : ''} ${x.width}x${x.height} "${x.title.slice(0, 60)}" by ${x.creator} (${x.credit.licenseName})`;
}
