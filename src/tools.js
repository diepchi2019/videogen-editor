// Tool definitions shared by the in-app Claude chat and the MCP server.
import { TRANSITIONS, ASPECTS, summarize } from './model.js';
import * as store from './store.js';
import { extractFrames } from './media.js';
import { startExport, getJob } from './render.js';

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const n = (d) => ({ type: 'number', description: d });
const s = (d, extra = {}) => ({ type: 'string', description: d, ...extra });

export const TOOLS = [
  { name: 'get_timeline', description: 'Get the current project: media library, video clips with timeline positions, text overlays, music. Call this before editing if unsure of ids.', input_schema: S({}) },
  { name: 'look_at_asset', description: 'See frames from a video/image asset so you can understand its content (e.g. find where something happens). Returns images labelled with source timestamps.', input_schema: S({ assetId: s('Asset id'), from: n('Start time in source seconds (default 0)'), to: n('End time in source seconds (default end)'), count: n('Number of frames, 1-12 (default 6)') }, ['assetId']) },
  { name: 'add_clip', description: 'Add a video or image asset to the main video track. Images default to 3s.', input_schema: S({ assetId: s('Asset id'), in: n('Source start seconds'), out: n('Source end seconds'), duration: n('For images: seconds to show'), position: n('1-based position in the track (default: end)') }, ['assetId']) },
  { name: 'trim_clip', description: 'Change which part of the source a clip uses.', input_schema: S({ clipId: s('Clip id'), in: n('New source start seconds'), out: n('New source end seconds') }, ['clipId']) },
  { name: 'split_clip', description: 'Split a clip in two at a timeline time (seconds from start of the whole video).', input_schema: S({ at: n('Timeline seconds'), clipId: s('Optional clip id') }, ['at']) },
  { name: 'delete_clip', description: 'Remove a clip from the track (later clips shift left).', input_schema: S({ clipId: s('Clip id') }, ['clipId']) },
  { name: 'move_clip', description: 'Reorder a clip.', input_schema: S({ clipId: s('Clip id'), position: n('New 1-based position') }, ['clipId', 'position']) },
  { name: 'set_clip', description: 'Set clip speed (0.25-4, e.g. 2 = fast forward, 0.5 = slow motion), volume (0-2, 0 = mute), and/or fit: how a clip with a different aspect ratio fills the canvas (contain = letterbox bars, cover = crop to fill, blur = blurred copy fills the background, popular for horizontal clips in vertical reels).', input_schema: S({ clipId: s('Clip id'), speed: n('Playback speed'), volume: n('Volume multiplier'), fit: s('Fill mode', { enum: ['contain', 'cover', 'blur'] }) }, ['clipId']) },
  { name: 'set_transition', description: `Set the transition INTO a clip from the previous clip (not allowed on the first clip). Use type "none" to remove. Clips overlap by the duration.`, input_schema: S({ clipId: s('Clip id (clip #2 or later)'), type: s('Transition type', { enum: TRANSITIONS }), duration: n('Seconds, 0.1-5 (default 0.5)') }, ['clipId', 'type']) },
  { name: 'add_text', description: 'Add a text overlay/title/caption. x,y are the center position as fractions of the frame (0.5,0.5 = center; y 0.15 = top; y 0.8 = lower third). Size is in pixels for the output canvas (a 1080-wide frame: 48 small, 72 medium, 120 big title).', input_schema: S({ text: s('Text, can contain \\n for line breaks'), start: n('Timeline start seconds'), end: n('Timeline end seconds'), x: n('0-1'), y: n('0-1'), size: n('Font size px'), color: s('CSS hex color like #ffffff'), box: { type: 'boolean', description: 'Draw a background box behind the text' }, boxColor: s('Hex color of the box'), animation: s('Entrance animation', { enum: ['none', 'fade', 'pop', 'slideup'] }) }, ['text', 'start', 'end']) },
  { name: 'update_text', description: 'Change any property of an existing text overlay.', input_schema: S({ textId: s('Text id'), text: s('Text'), start: n('Start s'), end: n('End s'), x: n('0-1'), y: n('0-1'), size: n('px'), color: s('Hex'), box: { type: 'boolean' }, boxColor: s('Hex'), animation: s('none|fade|pop|slideup') }, ['textId']) },
  { name: 'delete_text', description: 'Remove a text overlay.', input_schema: S({ textId: s('Text id') }, ['textId']) },
  { name: 'add_music', description: 'Add an audio asset (or the audio of a video asset) to the music track, mixed under the clips.', input_schema: S({ assetId: s('Asset id'), start: n('Timeline start seconds (default 0)'), in: n('Source start s'), out: n('Source end s'), volume: n('0-2, default 0.6'), fadeIn: n('Seconds'), fadeOut: n('Seconds, default 1') }, ['assetId']) },
  { name: 'update_music', description: 'Change a music item.', input_schema: S({ musicId: s('Music id'), start: n('s'), in: n('s'), out: n('s'), volume: n('0-2'), fadeIn: n('s'), fadeOut: n('s') }, ['musicId']) },
  { name: 'delete_music', description: 'Remove a music item.', input_schema: S({ musicId: s('Music id') }, ['musicId']) },
  { name: 'set_canvas', description: 'Change output format.', input_schema: S({ aspect: s('Aspect ratio', { enum: Object.keys(ASPECTS) }), background: s('Hex background color for letterboxing'), fps: n('Frames per second') }) },
  { name: 'clear_timeline', description: 'Remove all clips, texts and music (keeps the media library). Only when the user clearly asks to start over.', input_schema: S({}) },
  { name: 'undo', description: 'Undo the last edit.', input_schema: S({}) },
  { name: 'redo', description: 'Redo the last undone edit.', input_schema: S({}) },
  { name: 'export_video', description: 'Render the timeline to an MP4 file with ffmpeg. Returns a job id; the file appears in the app when done.', input_schema: S({ quality: s('draft (fast, 540p) or final', { enum: ['draft', 'final'] }) }) },
  { name: 'export_status', description: 'Check an export job.', input_schema: S({ jobId: s('Job id') }, ['jobId']) },
];

// Returns { content: string | Array<content block>, isError?: boolean }
export async function executeTool(name, input = {}, source = 'claude') {
  try {
    switch (name) {
      case 'get_timeline':
        return { content: summarize(store.getProject()) };
      case 'look_at_asset': {
        const p = store.getProject();
        const a = p.assets[input.assetId];
        if (!a) return { content: `No asset ${input.assetId}`, isError: true };
        const frames = await extractFrames(a, input.from, input.to, input.count);
        const blocks = [{ type: 'text', text: `Frames from "${a.name}" (${a.id}):` }];
        for (const f of frames) {
          blocks.push({ type: 'text', text: `t=${f.t.toFixed(2)}s` });
          blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
        }
        return { content: blocks };
      }
      case 'undo': return { content: store.undo(source) };
      case 'redo': return { content: store.redo(source) };
      case 'export_video': {
        const job = startExport(store.getProject(), input.quality || 'final');
        return { content: `Export started, job ${job.id}. Output: /exports/${job.file}` };
      }
      case 'export_status': {
        const j = getJob(input.jobId);
        return j ? { content: `${j.status} ${Math.round(j.progress * 100)}%${j.error ? ` error: ${j.error}` : ''}${j.status === 'done' ? ` file: /exports/${j.file}` : ''}` } : { content: 'No such job', isError: true };
      }
      default: {
        const msg = store.apply(name, input, source);
        return { content: msg };
      }
    }
  } catch (e) {
    return { content: `Error: ${e.message}`, isError: true };
  }
}
