// Reel checker: what usually goes wrong after posting to TikTok / Reels / Shorts, found from the project data
// (no rendering). Pure and unit-tested; check_reel in tools.js adds the speech words from cached transcripts.
import { layout, overlayDuration } from './model.js';

// Parts of a 9:16 frame the apps cover (fractions; union of TikTok, Instagram Reels and YouTube Shorts).
export const SAFE_ZONES = [
  { id: 'top', name: 'the top bar (Following / For You, search)', x: 0, y: 0, w: 1, h: 0.08 },
  { id: 'buttons', name: 'the like / comment / share buttons on the right', x: 0.86, y: 0.38, w: 0.14, h: 0.45 },
  { id: 'bottom', name: 'the username and description area at the bottom', x: 0, y: 0.8, w: 1, h: 0.2 },
];
const r2 = (n) => Math.round(n * 100) / 100;

// Rough box of a text block (fractions of the frame), centred at x, y.
export function textBox(text, { x = 0.5, y = 0.5, size = 72, uppercase = false }, W, H) {
  const lines = String(text).replace(/\\n/g, '\n').split('\n');
  const chars = Math.max(...lines.map((l) => l.length));
  const w = Math.min(0.92, (chars * size * (uppercase ? 0.62 : 0.55)) / W);
  const rows = lines.length + (chars * size * 0.55 > 0.92 * W ? Math.ceil((chars * size * 0.55) / (0.92 * W)) - 1 : 0);
  const h = (rows * size * 1.2) / H;
  return { x: x - w / 2, y: y - h / 2, w, h };
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
// The zones a box covers by more than 15% of its area.
export function zonesHit(box) {
  return SAFE_ZONES.filter((z) => overlap(box, z) > 0.15 * box.w * box.h);
}
// A centre y that keeps the box between the top bar and the bottom area.
const safeY = (box) => r2(Math.min(0.8 - box.h / 2 - 0.01, Math.max(0.08 + box.h / 2 + 0.01, box.y + box.h / 2)));

// words: speech on the timeline [{w, start, end}] (may be empty when nothing was transcribed).
// Returns { issues: [{area, text, fix}], good: [text], speech: bool }.
export function checkReel(p, { words = [], loudness = '-14' } = {}) {
  const L = layout(p), W = p.settings.width, H = p.settings.height;
  const issues = [], good = [];
  const add = (area, text, fix) => issues.push({ area, text, ...(fix ? { fix } : {}) });
  if (!L.clips.length) return { issues: [{ area: 'timeline', text: 'The timeline is empty.' }], good, speech: false };
  const dur = L.duration;
  const vertical = p.settings.aspect === '9:16';

  // Format and length.
  if (!vertical) add('format', `The canvas is ${p.settings.aspect}; TikTok, Reels and Shorts are 9:16 (the video would play with bars or small).`, 'set_canvas aspect 9:16, then auto_reframe');
  if (dur < 5) add('length', `${dur.toFixed(1)}s is very short; most reels that get watched are 10-60s.`);
  else if (dur > 180) add('length', `${(dur / 60).toFixed(1)} min: Reels and Shorts take up to 3 minutes, only TikTok takes longer.`, 'find_moments + make_short to cut it into shorts');
  else good.push(`${p.settings.aspect}, ${dur.toFixed(1)}s${dur > 90 ? ' (fine, but 15-60s keeps people to the end more often)' : ''}`);

  // Text and captions in the areas the apps cover (only meaningful for a vertical video).
  if (vertical) {
    for (const t of p.texts) {
      const box = textBox(t.text, t, W, H);
      const hit = zonesHit(box);
      if (hit.length) add('safe zone', `Text "${t.text.slice(0, 30)}" (${t.id}) sits under ${hit.map((z) => z.name).join(' and ')}.`, `update_text ${t.id} y ${safeY(box)}${hit.some((z) => z.id === 'buttons') ? ' and x 0.45 or a smaller size' : ''}`);
    }
    if (p.captions?.lines?.length) {
      const st = p.captions.style;
      const longest = p.captions.lines.reduce((a, l) => { const s = l.words.map((w) => w.w).join(' '); return s.length > a.length ? s : a; }, '');
      const box = textBox(longest, { ...st, x: 0.5 }, W, H);
      const alt = p.captions.lines.some((l) => l.alt);
      if (alt) box.h *= 1.8;
      const hit = zonesHit(box);
      if (hit.length) add('safe zone', `Captions at y ${st.y} sit under ${hit.map((z) => z.name).join(' and ')}.`, `update_captions y ${safeY(box)}`);
      else good.push('Captions are clear of the app buttons and text');
    }
    for (const o of p.overlays.filter((x) => x.fit === 'free' && p.assets[x.assetId]?.type === 'image' && x.scale <= 0.35)) {
      const a = p.assets[o.assetId], ar = a?.width && a?.height ? a.height / a.width : 1;
      const box = { x: o.x - o.scale / 2, y: o.y - (o.scale * ar * W) / H / 2, w: o.scale, h: (o.scale * ar * W) / H };
      const hit = zonesHit(box);
      if (hit.length) add('safe zone', `The ${o.styleRole === 'logo' ? 'logo' : 'sticker/logo'} ${o.id} sits under ${hit.map((z) => z.name).join(' and ')}.`, `set_overlay ${o.id} with x/y inside 0.1-0.85 / 0.1-0.75`);
    }
  }

  // Hook: something in the first 2 seconds.
  const early = (a, b) => a < 2 && b > 0.3;
  const hook = p.texts.some((t) => early(t.start, t.end)) || p.captions?.lines?.some((l) => early(l.start, l.end)) || words.some((w) => w.start < 2);
  const first = L.clips[0], firstAsset = p.assets[first.assetId];
  if (!hook) add('hook', 'Nothing is said or written in the first 2 seconds, which is when people decide to scroll on.', 'add_text with a short hook title from 0 to 2.5s (or start on the strongest moment)');
  else good.push('Something happens in the first 2 seconds');
  if (firstAsset?.type === 'image' && !(first.motion && first.motion.preset !== 'none') && !first.keyframes) add('hook', 'The video opens on a still photo with no motion.', `set_clip ${first.id} motion zoom_in (Ken Burns)`);

  // Speech and captions.
  const speech = words.length >= 6;
  if (speech && !p.captions?.lines?.length) add('captions', 'People talk but there are no captions; most people watch with the sound off.', 'add_captions');
  if (p.captions?.lines?.length) {
    const fast = p.captions.lines.filter((l) => l.words.map((w) => w.w).join(' ').length / Math.max(0.2, l.end - l.start) > 22);
    if (fast.length) add('captions', `${fast.length} caption line${fast.length > 1 ? 's go' : ' goes'} by too fast to read (over 22 characters a second).`, 'update_captions maxWords 3');
  }
  for (const t of p.texts) {
    const need = Math.max(0.8, t.text.length / 15);
    if (t.end - t.start < need) add('text', `Text "${t.text.slice(0, 30)}" (${t.id}) is on screen ${r2(t.end - t.start)}s; it needs about ${r2(need)}s to be read.`, `update_text ${t.id} end ${r2(t.start + need)}`);
  }
  const lateText = p.texts.filter((t) => t.start >= L.videoDuration - 0.05);
  if (lateText.length) add('text', `${lateText.length} text item(s) start after the video ends, so they never show.`);

  // Clips.
  const blips = L.clips.filter((c) => c.duration < 0.4 && !c.freeze);
  if (blips.length) add('clips', `${blips.length === 1 ? `Clip #${blips[0].index + 1}` : `${blips.length} clips`} last${blips.length === 1 ? 's' : ''} under 0.4s and will look like a glitch (${blips.map((c) => `#${c.index + 1} ${c.duration}s`).join(', ')}).`, 'delete_clip or trim_clip them longer');
  const stills = L.clips.filter((c) => p.assets[c.assetId]?.type === 'image' && c.duration > 5 && !(c.motion && c.motion.preset !== 'none') && !c.keyframes);
  if (stills.length) add('clips', `${stills.length} photo${stills.length > 1 ? 's stay' : ' stays'} on screen over 5s without motion (${stills.map((c) => `#${c.index + 1}`).join(', ')}).`, 'set_clip motion (Ken Burns) or shorten them');

  // Audio.
  const music = p.music.filter((m) => m.role === 'music' && m.start < dur);
  const voiced = speech || p.music.some((m) => m.role === 'voice');
  for (const m of music) {
    if (voiced && !(m.duck > 0) && m.volume > 0.35) add('audio', `Music ${m.id} plays at volume ${m.volume} under speech with no ducking; the voice may be hard to hear.`, `update_music ${m.id} duck 0.7 (or volume 0.25)`);
  }
  const silentClips = L.clips.every((c) => { const a = p.assets[c.assetId]; return !(a?.type === 'video' && a.hasAudio && (c.volume ?? 1) > 0); });
  if (silentClips && !p.music.length) add('audio', 'The video has no sound at all; muted-looking posts get skipped and cannot use a trending sound.', 'add_music');
  if (loudness === 'off') add('audio', 'Loudness normalization is off, so the export may play quieter or louder than other videos.', 'export_video loudness -14');
  else good.push(`Exports are brought to ${loudness} LUFS`);

  // Licensed library audio: the credit goes in the description.
  const credited = [...new Set(p.music.map((m) => m.assetId))].map((id) => p.assets[id]?.credit).filter((c) => c && !['cc0', 'pdm', 'pexels'].includes(c.license));
  if (credited.length) good.push(`${credited.length} library track(s) need credit in the post description (${credited.map((c) => c.licenseName).join(', ')}): exports write it to the .description.txt next to the video`);

  // Overlays that end past the video, or start after it.
  const lostOv = p.overlays.filter((o) => o.start >= L.videoDuration - 0.05);
  if (lostOv.length) add('overlays', `${lostOv.length} overlay(s) start after the video ends, so they never show.`);
  const longOv = p.overlays.filter((o) => o.start < L.videoDuration && o.start + overlayDuration(o) > L.videoDuration + 0.5);
  if (longOv.length) good.push(`${longOv.length} overlay(s) run past the end and are cut off there`);
  return { issues, good, speech };
}

export function checkText({ issues, good }) {
  const lines = [`Reel check (TikTok / Reels / Shorts): ${issues.length ? `${issues.length} thing${issues.length > 1 ? 's' : ''} to fix` : 'looks good'}`];
  for (const i of issues) lines.push(`⚠ ${i.text}${i.fix ? ` Fix: ${i.fix}` : ''}`);
  for (const g of good) lines.push(`✓ ${g}`);
  return lines.join('\n');
}
