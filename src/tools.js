// Tool definitions shared by the in-app Claude chat and the MCP server.
import {
  TRANSITIONS, ASPECTS, FITS, MOTIONS, TEXT_ANIM_IN, TEXT_ANIM_OUT, TEXT_STYLES, AUDIO_ROLES, OVERLAY_FITS, OVERLAY_ANIMS,
  CAPTION_MODES, CAPTION_STYLES, REGION_MODES, summarize, timelineWords, layout, env, ops,
} from './model.js';
import * as store from './store.js';
import { extractFrames } from './media.js';
import { startExport, getJob, renderFrames } from './render.js';
import { waitJob } from './jobs.js';
import { transcribe, readTranscript, hasTranscript, transcriptText } from './transcribe.js';
import { listFonts, resolveFont, defaultFont } from './fonts.js';

env.resolveFont = resolveFont;

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const n = (d) => ({ type: 'number', description: d });
const s = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
const b = (d) => ({ type: 'boolean', description: d });
const cropSchema = { type: 'object', description: 'Crop rectangle as fractions of the source frame: {x, y, w, h}, e.g. {x:0.25,y:0,w:0.5,h:1} keeps the middle half. null removes the crop.', properties: { x: n('left 0-1'), y: n('top 0-1'), w: n('width 0-1'), h: n('height 0-1') } };

const textProps = {
  text: s('Text, can contain \\n for line breaks'), start: n('Timeline start seconds'), end: n('Timeline end seconds'),
  x: n('Center x, 0-1'), y: n('Center y, 0-1'), size: n('Font size px on the canvas (1080 wide: 48 small, 72 medium, 120 big title)'),
  style: s(`Style preset applied first (explicit fields win): ${Object.keys(TEXT_STYLES).join(', ')}`, { enum: Object.keys(TEXT_STYLES) }),
  font: s('Font family name (see list_fonts). Default is a bold sans.'), bold: b('Bold (default true)'), italic: b('Italic'),
  color: s('Hex text color like #ffffff'), outline: n('Outline width px (0 = none)'), outlineColor: s('Hex outline color'),
  shadow: n('Drop shadow distance px'), shadowColor: s('Hex shadow color'), blur: n('Edge blur / glow px (0-20)'),
  box: b('Draw a background box behind the text'), boxColor: s('Hex color of the box'),
  animation: s('Entrance animation', { enum: TEXT_ANIM_IN }), animationOut: s('Exit animation', { enum: TEXT_ANIM_OUT }),
};
const captionStyleProps = {
  preset: s(`Caption look: ${Object.entries(CAPTION_STYLES).map(([k, v]) => `${k} (${v.mode})`).join(', ')}`, { enum: Object.keys(CAPTION_STYLES) }),
  mode: s('line = whole line; karaoke = words fill with highlightColor as spoken; word = line shown, current word highlighted; single = one big word at a time', { enum: CAPTION_MODES }),
  size: n('Font size px'), y: n('Vertical center 0-1 (0.75 = lower third)'), font: s('Font family (list_fonts)'),
  color: s('Hex text color'), highlightColor: s('Hex color of the spoken word'), outline: n('Outline px'), outlineColor: s('Hex'),
  box: b('Background box'), boxColor: s('Hex'), uppercase: b('ALL CAPS'), bold: b('Bold'), maxWords: n('Max words per line (1-12)'),
};
const overlayProps = {
  start: n('Timeline start seconds'), end: n('Timeline end seconds (alternative to duration)'), duration: n('Seconds on the timeline'),
  in: n('Source start seconds (video)'), out: n('Source end seconds (video)'), speed: n('0.25-4'),
  fit: s('free = position with x/y/scale; cover = fill the whole frame (B-roll cutaway); contain = whole frame, letterboxed', { enum: OVERLAY_FITS }),
  x: n('Center x 0-1 (free fit)'), y: n('Center y 0-1 (free fit)'), scale: n('Width as a fraction of the canvas width (free fit), e.g. 0.35 for picture-in-picture, 0.15 for a logo'),
  rotate: n('Degrees'), opacity: n('0-1'), volume: n('0-2, audio of a video overlay (0 = mute)'), track: n('Layer 1-20, higher is on top'),
  crop: cropSchema, flipH: b('Mirror horizontally'), flipV: b('Flip vertically'), animation: s('fade = fade in and out', { enum: OVERLAY_ANIMS }),
};

export const TOOLS = [
  { name: 'get_timeline', description: 'Get the current project: media library, video clips with timeline positions, overlays, text, captions, audio. Call this before editing if unsure of ids.', input_schema: S({ detail: s('brief (default) or full (all caption lines)', { enum: ['brief', 'full'] }) }) },
  { name: 'look_at_asset', description: 'See frames from a source video/image asset so you can understand its content (e.g. find where something happens). Returns images labelled with source timestamps.', input_schema: S({ assetId: s('Asset id'), from: n('Start time in source seconds (default 0)'), to: n('End time in source seconds (default end)'), count: n('Number of frames, 1-12 (default 6)') }, ['assetId']) },
  { name: 'look_at_timeline', description: 'See the FINISHED video at given timeline times: rendered frames with overlays, text, captions, transitions and effects applied. Use it after editing to check text placement, framing and overlays.', input_schema: S({ times: { type: 'array', items: { type: 'number' }, description: 'Timeline seconds (max 12)' }, count: n('If no times: this many evenly spaced frames (default 6)') }) },
  { name: 'batch_edit', description: 'Apply many editing operations in one call, atomically and as ONE undo step. Each op is {name, input} where name is an editing tool (add_clip, trim_clip, set_clip, add_text, add_overlay, ...). In a later step, the string "$N" stands for the id created by step N (1-based), e.g. [{name:"add_clip",input:{assetId:"vid_1"}},{name:"set_transition",input:{clipId:"$1",type:"fade"}}]. If any step fails nothing is applied.', input_schema: S({ ops: { type: 'array', items: { type: 'object', properties: { name: s('Editing tool name'), input: { type: 'object', description: 'That tool\'s input' } }, required: ['name'] } } }, ['ops']) },

  { name: 'list_projects', description: 'List saved projects (the open one is marked).', input_schema: S({}) },
  { name: 'create_project', description: 'Create a new empty project and open it. By default it starts with the current media library (files are shared, not copied).', input_schema: S({ name: s('Project name'), aspect: s('Aspect ratio', { enum: Object.keys(ASPECTS) }), copyMedia: b('Start with the current media library (default true)') }) },
  { name: 'open_project', description: 'Open (switch to) another project by id or exact name. Edits then apply to it.', input_schema: S({ projectId: s('Project id or name') }, ['projectId']) },
  { name: 'duplicate_project', description: 'Copy a project (default: the open one) and open the copy. Good for making versions.', input_schema: S({ projectId: s('Project id or name (default: open project)'), name: s('Name of the copy') }) },
  { name: 'rename_project', description: 'Rename the open project.', input_schema: S({ name: s('New name') }, ['name']) },
  { name: 'delete_project', description: 'Delete a project that is not open (moved to data/trash, recoverable). Only when the user asks.', input_schema: S({ projectId: s('Project id or name') }, ['projectId']) },

  { name: 'add_clip', description: 'Add a video or image asset to the main video track. Images default to 3s.', input_schema: S({ assetId: s('Asset id'), in: n('Source start seconds'), out: n('Source end seconds'), duration: n('For images: seconds to show'), position: n('1-based position in the track (default: end)') }, ['assetId']) },
  { name: 'trim_clip', description: 'Change which part of the source a clip uses.', input_schema: S({ clipId: s('Clip id'), in: n('New source start seconds'), out: n('New source end seconds') }, ['clipId']) },
  { name: 'split_clip', description: 'Split a clip in two at a timeline time (seconds from start of the whole video).', input_schema: S({ at: n('Timeline seconds'), clipId: s('Optional clip id') }, ['at']) },
  { name: 'delete_clip', description: 'Remove a clip from the track (later clips shift left).', input_schema: S({ clipId: s('Clip id') }, ['clipId']) },
  { name: 'move_clip', description: 'Reorder a clip.', input_schema: S({ clipId: s('Clip id'), position: n('New 1-based position') }, ['clipId', 'position']) },
  {
    name: 'set_clip',
    description: 'Change a main-track clip: speed, volume, fit (contain = letterbox, cover = crop to fill, blur = blurred copy behind, popular for horizontal clips in vertical reels), ' +
      'crop/rotate/flip of the source, scale and position inside the canvas, and motion (Ken Burns zoom/pan, great on photos).',
    input_schema: S({
      clipId: s('Clip id'), speed: n('0.25-4 (2 = fast, 0.5 = slow motion)'), volume: n('0-2, 0 = mute'), fit: s('Fill mode', { enum: FITS }),
      crop: cropSchema, rotate: n('Degrees, 90/180/270 or any angle'), flipH: b('Mirror horizontally'), flipV: b('Flip vertically'),
      scale: n('Zoom inside the canvas, 1 = fitted size (0.1-5)'), x: n('Center x 0-1 inside the canvas (0.5 = centered)'), y: n('Center y 0-1'),
      resetTransform: b('Remove crop/rotate/flip/scale/position first'),
      motion: s('Ken Burns movement over the clip', { enum: MOTIONS }), motionIntensity: n('How far to zoom/pan, 0.02-0.6 (default 0.15)'),
    }, ['clipId']),
  },
  { name: 'set_transition', description: `Set the transition INTO a clip from the previous clip (not allowed on the first clip). Use type "none" to remove. Clips overlap by the duration.`, input_schema: S({ clipId: s('Clip id (clip #2 or later)'), type: s('Transition type', { enum: TRANSITIONS }), duration: n('Seconds, 0.1-5 (default 0.5)') }, ['clipId', 'type']) },

  {
    name: 'replace_clip_asset',
    description: 'Swap the media file under a main-track clip (e.g. a re-encoded or cleaned version, or a different take) while keeping its in/out, speed, volume, fit, transform, motion, transition and removed regions. ' +
      'If the new file is shorter than the clip\'s out point, pass in/out that fit.',
    input_schema: S({ clipId: s('Clip id'), assetId: s('Asset id of the new video or image'), in: n('New source start seconds (default: keep)'), out: n('New source end seconds (default: keep)'), clearRegions: b('Drop the clip\'s removed regions (use when the new file no longer has the text)') }, ['clipId', 'assetId']),
  },
  {
    name: 'remove_region',
    description: 'Hide something burned into a clip\'s source video (hardcoded subtitle, watermark, logo, timestamp) inside a box, for a source-time range. Non-destructive: applied at export and in look_at_timeline (not in the browser preview). ' +
      'Find the box and times with look_at_asset first, and make the box a little larger than the text. ' +
      'mode fill (default) rebuilds the box from the pixels around it: always works, but looks soft/smudged on detailed backgrounds. ' +
      'mode patch copies the box from a clean frame of the same shot (patchAt) with soft edges: sharp, real detail, best when the camera and that area are mostly still (it is a still image, so motion there will look frozen). ' +
      'Keep from-to inside ONE shot: a patch that runs past a scene cut pastes the old shot\'s pixels onto the new one (end a little before the cut). ' +
      'Check the result with look_at_timeline. Splitting or trimming the clip keeps the region in place.',
    input_schema: S({
      clipId: s('Clip id'), x: n('Box left, fraction of the source frame width 0-1'), y: n('Box top, fraction of the source frame height 0-1'),
      w: n('Box width, fraction 0-1'), h: n('Box height, fraction 0-1'),
      from: n('Source seconds where the text appears (default: clip in)'), to: n('Source seconds where it disappears (default: clip out)'),
      mode: s('fill = interpolate from surroundings; patch = copy from a clean frame', { enum: REGION_MODES }),
      patchAt: n('patch mode: source seconds of a frame where this box is clean (same shot, outside from-to)'),
      feather: n('patch mode: soft edge as a fraction of the box\'s smaller side, 0-0.5 (default 0.15)'),
    }, ['clipId', 'x', 'y', 'w', 'h']),
  },
  { name: 'delete_region', description: 'Remove a region added with remove_region (the original pixels come back). Region ids are listed with each clip in get_timeline.', input_schema: S({ regionId: s('Region id'), clipId: s('Optional: only this clip (a split clip shares region ids)') }, ['regionId']) },

  { name: 'add_overlay', description: 'Put a video or image ON TOP of the main video track at a timeline time: picture-in-picture, logo/watermark, B-roll cutaway (fit cover), reaction cam. Overlays do not shift other clips.', input_schema: S({ assetId: s('Asset id'), ...overlayProps }, ['assetId']) },
  { name: 'set_overlay', description: 'Change an overlay (timing, position, size, opacity, crop, volume...).', input_schema: S({ overlayId: s('Overlay id'), ...overlayProps }, ['overlayId']) },
  { name: 'delete_overlay', description: 'Remove an overlay.', input_schema: S({ overlayId: s('Overlay id') }, ['overlayId']) },

  { name: 'add_text', description: 'Add a text overlay/title. x,y are the center as fractions of the frame (0.5,0.5 = center; y 0.15 = top; y 0.8 = lower third). Use style presets for quick looks.', input_schema: S(textProps, ['text', 'start', 'end']) },
  { name: 'update_text', description: 'Change any property of an existing text overlay.', input_schema: S({ textId: s('Text id'), ...textProps }, ['textId']) },
  { name: 'delete_text', description: 'Remove a text overlay.', input_schema: S({ textId: s('Text id') }, ['textId']) },
  { name: 'list_fonts', description: 'List installed font families usable in text and captions (user-imported fonts first).', input_schema: S({ search: s('Filter by name') }) },

  { name: 'transcribe_asset', description: 'Speech-to-text with word timestamps (Whisper, runs locally). Cached per file. Usually not needed directly: add_captions transcribes automatically.', input_schema: S({ assetId: s('Asset id (video with audio, or audio)'), language: s('Language code like en, vi, or auto (default)'), force: b('Re-run even if cached') }, ['assetId']) },
  { name: 'get_transcript', description: 'Read the transcript of an asset with SOURCE timestamps, to find moments by what is said, cut silences or filler words, or pick highlights.', input_schema: S({ assetId: s('Asset id'), from: n('Source seconds'), to: n('Source seconds'), words: b('One line per word with timings') }, ['assetId']) },
  { name: 'add_captions', description: 'Auto-caption the video from speech: transcribes clips (and voice audio) as needed, maps words onto the timeline and replaces existing captions. Pick a preset for the look.', input_schema: S({ ...captionStyleProps, language: s('Speech language code or auto'), sources: { type: 'array', items: { type: 'string', enum: ['clips', 'overlays', ...AUDIO_ROLES] }, description: 'What to caption (default clips, overlays, voice)' } }) },
  { name: 'update_captions', description: 'Restyle captions, or fix one line (lineId + text and/or start/end). Changing maxWords regroups all lines.', input_schema: S({ lineId: s('Caption line id (from get_timeline)'), text: s('Corrected words for that line'), start: n('Line start s'), end: n('Line end s'), ...captionStyleProps }) },
  { name: 'delete_captions', description: 'Delete one caption line (lineId) or all captions.', input_schema: S({ lineId: s('Optional line id') }) },

  { name: 'add_music', description: 'Add an audio item: music (default), sfx (sound effect) or voice (voiceover). Mixed under the clip audio. Each role gets its own track by default (music 1, voice 2, sfx 3).', input_schema: S({ assetId: s('Asset id (audio, or a video with audio)'), role: s('music, sfx or voice', { enum: AUDIO_ROLES }), track: n('Audio track 1-20'), start: n('Timeline start seconds (default 0)'), in: n('Source start s'), out: n('Source end s'), volume: n('0-2 (music default 0.6, others 1)'), fadeIn: n('Seconds'), fadeOut: n('Seconds (music default 1)') }, ['assetId']) },
  { name: 'update_music', description: 'Change an audio item (music, sfx or voice).', input_schema: S({ musicId: s('Audio item id'), role: s('Role', { enum: AUDIO_ROLES }), track: n('Track'), start: n('s'), in: n('s'), out: n('s'), volume: n('0-2'), fadeIn: n('s'), fadeOut: n('s') }, ['musicId']) },
  { name: 'delete_music', description: 'Remove an audio item.', input_schema: S({ musicId: s('Audio item id') }, ['musicId']) },
  { name: 'set_canvas', description: 'Change output format.', input_schema: S({ aspect: s('Aspect ratio', { enum: Object.keys(ASPECTS) }), background: s('Hex background color for letterboxing'), fps: n('Frames per second') }) },
  { name: 'clear_timeline', description: 'Remove all clips, overlays, texts, captions and audio (keeps the media library). Only when the user clearly asks to start over.', input_schema: S({}) },
  { name: 'undo', description: 'Undo the last edit.', input_schema: S({}) },
  { name: 'redo', description: 'Redo the last undone edit.', input_schema: S({}) },
  { name: 'export_video', description: 'Render the timeline to an MP4 file with ffmpeg. With wait=true it returns when the file is ready (with its path); otherwise it returns a job id for export_status.', input_schema: S({ quality: s('draft (fast, half resolution) or final', { enum: ['draft', 'final'] }), wait: b('Wait until done (up to 10 min)') }) },
  { name: 'export_status', description: 'Check an export or other job.', input_schema: S({ jobId: s('Job id') }, ['jobId']) },
];

// MCP tool annotations (not sent to the Anthropic API, which does not accept them).
const READ_ONLY = new Set(['get_timeline', 'look_at_asset', 'look_at_timeline', 'list_projects', 'list_fonts', 'get_transcript', 'export_status']);
const DESTRUCTIVE = new Set(['delete_clip', 'delete_region', 'delete_overlay', 'delete_text', 'delete_captions', 'delete_music', 'clear_timeline', 'delete_project', 'add_captions']);
export const toolAnnotations = (name) => ({
  readOnlyHint: READ_ONLY.has(name),
  destructiveHint: DESTRUCTIVE.has(name),
  idempotentHint: READ_ONLY.has(name),
  openWorldHint: false,
});

export const transcribedSet = (p) => new Set(Object.values(p.assets).filter((a) => a.type !== 'image' && hasTranscript(a)).map((a) => a.id));
const summary = (p, full) => summarize(p, { transcribed: transcribedSet(p), full });
const imageBlocks = (title, frames, label) => [{ type: 'text', text: title }, ...frames.flatMap((f) => [
  { type: 'text', text: label(f) },
  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } },
])];
const fmtJob = (j) => `${j.kind} ${j.status} ${Math.round(j.progress * 100)}%${j.error ? ` error: ${j.error}` : ''}${j.status === 'done' && j.file ? ` file: ${j.path} (URL /exports/${j.file})` : ''}`;

// Returns { content: string | Array<content block>, isError?: boolean }
export async function executeTool(name, input = {}, source = 'claude') {
  try {
    switch (name) {
      case 'get_timeline':
        return { content: summary(store.getProject(), input.detail === 'full') };
      case 'look_at_asset': {
        const p = store.getProject();
        const a = p.assets[input.assetId];
        if (!a) return { content: `No asset ${input.assetId}`, isError: true };
        const frames = await extractFrames(a, input.from, input.to, input.count);
        return { content: imageBlocks(`Frames from "${a.name}" (${a.id}):`, frames, (f) => `t=${f.t.toFixed(2)}s`) };
      }
      case 'look_at_timeline': {
        const p = store.getProject();
        const L = layout(p);
        if (!L.clips.length) return { content: 'Timeline is empty.', isError: true };
        let times = Array.isArray(input.times) ? input.times.map(Number).filter(Number.isFinite) : [];
        if (!times.length) {
          const k = Math.max(1, Math.min(12, Math.round(Number(input.count) || 6)));
          times = Array.from({ length: k }, (_, i) => ((i + 0.5) * L.duration) / k);
        }
        const frames = await renderFrames(p, times.slice(0, 12));
        return { content: imageBlocks(`Rendered timeline frames (total ${L.duration.toFixed(2)}s, draft quality):`, frames, (f) => `timeline t=${f.t.toFixed(2)}s`) };
      }
      case 'batch_edit':
        return { content: store.applyBatch(input.ops, source) };

      case 'list_projects': {
        const list = store.listProjects();
        return { content: list.map((x) => `${x.current ? '* ' : '- '}${x.id} "${x.name}" ${x.aspect}, ${x.clips} clips, ${x.duration.toFixed(1)}s, updated ${x.updatedAt}`).join('\n') + '\n(* = open)' };
      }
      case 'create_project': {
        const p = store.createProject(input, source);
        return { content: `Created and opened project ${p.id} "${p.name}" (${p.settings.aspect}) with ${Object.keys(p.assets).length} media items.` };
      }
      case 'open_project': {
        const p = store.openProject(input.projectId, source);
        return { content: `Opened project ${p.id} "${p.name}".\n\n${summary(p)}` };
      }
      case 'duplicate_project': {
        const p = store.duplicateProject(input.projectId, input.name, source);
        return { content: `Duplicated into ${p.id} "${p.name}" and opened it.` };
      }
      case 'delete_project': {
        const p = store.deleteProject(input.projectId);
        return { content: `Deleted project ${p.id} "${p.name}" (moved to data/trash).` };
      }

      case 'list_fonts': {
        const fonts = listFonts(input.search);
        if (!fonts.length) return { content: `No fonts match "${input.search}".` };
        return { content: `Default: ${defaultFont()}. ${fonts.length} families${fonts.some((f) => f.user) ? ' (imported first)' : ''}:\n${fonts.slice(0, 400).map((f) => f.family + (f.user ? ' [imported]' : '')).join(', ')}` };
      }
      case 'transcribe_asset': {
        const a = store.getProject().assets[input.assetId];
        if (!a) return { content: `No asset ${input.assetId}`, isError: true };
        const r = await transcribe(a, { language: input.language, force: !!input.force });
        return { content: `Transcribed "${a.name}": ${r.words.length} words (language ${r.language}).\n${transcriptText(r.words).slice(0, 4000)}` };
      }
      case 'get_transcript': {
        const a = store.getProject().assets[input.assetId];
        if (!a) return { content: `No asset ${input.assetId}`, isError: true };
        const r = readTranscript(a) || await transcribe(a, {});
        const text = transcriptText(r.words, { from: Number(input.from) || 0, to: input.to === undefined ? Infinity : Number(input.to), withWords: !!input.words });
        return { content: `Transcript of "${a.name}" (source seconds):\n${text || '(no speech found)'}` };
      }
      case 'add_captions': {
        const p = store.getProject();
        const sources = Array.isArray(input.sources) && input.sources.length ? input.sources : ['clips', 'overlays', 'voice'];
        const used = new Set();
        if (sources.includes('clips')) p.clips.forEach((c) => used.add(c.assetId));
        if (sources.includes('overlays')) p.overlays.forEach((o) => used.add(o.assetId));
        p.music.filter((m) => sources.includes(m.role)).forEach((m) => used.add(m.assetId));
        const transcripts = {};
        const skipped = [];
        for (const id of used) {
          const a = p.assets[id];
          if (!a || a.type === 'image' || (a.type === 'video' && !a.hasAudio)) continue;
          try { transcripts[id] = (await transcribe(a, { language: input.language || 'auto' })).words; } catch (e) { skipped.push(`${a.name}: ${e.message}`); }
        }
        if (!Object.keys(transcripts).length && skipped.length) return { content: `Could not transcribe: ${skipped.join('; ')}`, isError: true };
        const words = timelineWords(store.getProject(), transcripts, sources);
        const { language, sources: _s, ...style } = input;
        const msg = store.apply('set_captions', { ...style, words }, source);
        return { content: msg + (skipped.length ? `\nSkipped: ${skipped.join('; ')}` : '') };
      }

      case 'undo': return { content: store.undo(source) };
      case 'redo': return { content: store.redo(source) };
      case 'export_video': {
        let job = startExport(store.getProject(), input.quality || 'final');
        if (job.status === 'error') return { content: `Export failed: ${job.error}`, isError: true };
        if (!input.wait) return { content: `Export started, job ${job.id}. Output: ${job.path} (URL /exports/${job.file})` };
        job = await waitJob(job.id, 600000);
        return { content: `Job ${job.id}: ${fmtJob(job)}`, isError: job.status === 'error' };
      }
      case 'export_status': {
        const j = getJob(input.jobId);
        return j ? { content: fmtJob(j) } : { content: 'No such job', isError: true };
      }
      default: {
        if (!ops[name]) return { content: `Unknown tool ${name}`, isError: true };
        return { content: store.apply(name, input, source) };
      }
    }
  } catch (e) {
    return { content: `Error: ${e.message}`, isError: true };
  }
}
