// Free music and sound effects from Openverse (openverse.org: Creative Commons audio from Jamendo, Freesound,
// ccMixter and others; no key needed). Results are limited to licenses that allow commercial use by default.
// Downloads go into data/media like uploads and keep their credit, which exports list for the description.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEDIA_DIR } from './store.js';

const BASE = () => process.env.OPENVERSE_URL || 'https://api.openverse.org';
const HEADERS = { 'User-Agent': 'VideoGen/1.0 (local video editor)' };
const LICENSE_NAMES = { cc0: 'CC0 (public domain)', pdm: 'Public domain', by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nd': 'CC BY-ND', 'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND', sampling: 'Sampling+', 'nc-sampling': 'NC Sampling+' };
export const licenseName = (l, v) => `${LICENSE_NAMES[l] || String(l).toUpperCase()}${v && !['cc0', 'pdm'].includes(l) ? ` ${v}` : ''}`;
// Whether the license asks for credit (everything but CC0 / public domain).
export const needsCredit = (l) => !['cc0', 'pdm'].includes(l);

// Openverse result -> our track record.
export function toTrack(r) {
  return {
    id: r.id, title: r.title || 'Untitled', creator: r.creator || 'unknown', duration: r.duration ? Math.round(r.duration / 100) / 10 : null,
    license: r.license, licenseVersion: r.license_version, licenseName: licenseName(r.license, r.license_version), licenseUrl: r.license_url,
    attribution: r.attribution || `"${r.title}" by ${r.creator} (${licenseName(r.license, r.license_version)})`,
    url: r.url, filetype: r.filetype, page: r.foreign_landing_url, source: r.source || r.provider, tags: (r.tags || []).map((t) => t.name).slice(0, 8),
  };
}

async function get(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (r.status === 429) throw new Error('The music library (Openverse) is busy: too many searches. Wait a minute and try again.');
  if (!r.ok) throw new Error(`Music library request failed (HTTP ${r.status})`);
  return r;
}

// kind music: Openverse's music category; sfx: Freesound (sound effects). Durations in seconds.
// commercial: licenses that allow commercial use AND changes (CC0, public domain, BY, BY-SA): putting music
// under a video counts as an adaptation, so NoDerivatives (ND) tracks are left out too.
// Openverse matches every word, so a multi-word search that finds little also tries each word on its own.
export async function searchAudio({ query, kind = 'music', commercial = true, minDuration, maxDuration, page = 1 } = {}) {
  const one = async (q) => {
    const u = new URL('/v1/audio/', BASE());
    if (q) u.searchParams.set('q', String(q).slice(0, 200));
    if (kind === 'sfx') u.searchParams.set('source', 'freesound'); else u.searchParams.set('category', 'music');
    if (commercial) u.searchParams.set('license_type', 'commercial,modification');
    u.searchParams.set('page_size', '20');
    u.searchParams.set('page', String(Math.max(1, Math.min(10, Math.round(page)))));
    return (await get(u)).json();
  };
  const j = await one(query);
  let total = j.result_count || 0, raw = j.results || [];
  const words = String(query || '').split(/\s+/).filter((w) => w.length >= 3);
  for (const w of words.length > 1 ? words.slice(0, 3) : []) {
    if (raw.length >= 12) break;
    const more = await one(w);
    total += more.result_count || 0;
    raw = [...raw, ...(more.results || []).filter((r) => !raw.some((x) => x.id === r.id))];
  }
  let tracks = raw.filter((r) => r.url).map(toTrack);
  if (minDuration) tracks = tracks.filter((t) => !t.duration || t.duration >= minDuration);
  if (maxDuration) tracks = tracks.filter((t) => !t.duration || t.duration <= maxDuration);
  return { total, tracks: tracks.slice(0, 20) };
}
export async function getTrack(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error(`"${id}" is not a library track id (search_music lists them)`);
  return toTrack(await (await get(new URL(`/v1/audio/${id}/`, BASE()))).json());
}
// Download into data/media (once per track). Returns { file, path }.
export async function downloadTrack(t) {
  const ext = /^(mp3|mp32|mpeg)$/i.test(t.filetype || 'mp3') ? 'mp3' : String(t.filetype).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp3';
  const file = `f_lib_${crypto.createHash('sha1').update(t.id).digest('hex').slice(0, 12)}.${ext}`;
  const dest = path.join(MEDIA_DIR, file);
  if (fs.existsSync(dest)) return { file, path: dest };
  const r = await get(t.url);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error('The download was empty');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(`${dest}.part`, buf);
  fs.renameSync(`${dest}.part`, dest);
  return { file, path: dest };
}

// Credits for the description: every library asset the project uses, once.
export function projectCredits(p) {
  const used = new Set([...p.clips.map((c) => c.assetId), ...p.overlays.map((o) => o.assetId), ...p.music.map((m) => m.assetId)]);
  return [...used].map((id) => p.assets[id]?.credit).filter((c) => c && needsCredit(c.license)).map((c) => `${c.attribution}${c.page ? ` ${c.page}` : ''}`);
}
export function trackLine(t, i) {
  const d = t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.round(t.duration % 60)).padStart(2, '0')}` : '?';
  return `${i + 1}. ${t.id} "${t.title}" by ${t.creator}, ${d}, ${t.licenseName}${t.tags.length ? ` [${t.tags.join(', ')}]` : ''}`;
}
