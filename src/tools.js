// Tool definitions shared by the in-app Claude chat and the MCP server.
import {
  TRANSITIONS, ASPECTS, FITS, MOTIONS, TEXT_ANIM_IN, TEXT_ANIM_OUT, TEXT_STYLES, AUDIO_ROLES, OVERLAY_FITS, OVERLAY_ANIMS,
  CAPTION_MODES, CAPTION_STYLES, REGION_MODES, CLIP_ANIMS, FILTERS, EFFECTS, KEYFRAME_PROPS, STYLE_PARTS, RAMP_PRESETS, REVERSE_MAX, summarize, timelineWords, layout, env, ops,
  styleFromProject, describeStyle, normalizeStyle, makeTemplate, describeTemplate, fillTemplate,
} from './model.js';
import { listStyles, loadStyle, saveStyle, deleteStyle, listTemplates, loadTemplate, saveTemplate, deleteTemplate } from './presets.js';
import * as store from './store.js';
import { extractFrames, probe, needsProxy, hasProxy, startProxy } from './media.js';
import { startExport, getJob, renderFrames, RESOLUTIONS } from './render.js';
import { analyzeAudio, analysisText } from './audio.js';
import path from 'node:path';
import { waitJob } from './jobs.js';
import { transcribe, readTranscript, hasTranscript, transcriptText } from './transcribe.js';
import { listFonts, resolveFont, defaultFont } from './fonts.js';
import { listLuts, resolveLut } from './luts.js';
import fs from 'node:fs';

env.resolveFont = resolveFont;
env.resolveLut = resolveLut;
env.loadStyle = loadStyle;

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
const idsSchema = (d) => ({ type: 'array', items: { type: 'string' }, description: d });
const pickProps = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const styleSections = {
  canvas: { type: 'object', description: 'Output format', properties: { aspect: s('Aspect ratio', { enum: Object.keys(ASPECTS) }), fps: n('Frames per second'), background: s('Hex letterbox color') } },
  clips: {
    type: 'object', description: 'Defaults for main-track clips',
    properties: {
      fit: s('Fill mode', { enum: FITS }), transition: s('Transition between clips (none = hard cuts)', { enum: TRANSITIONS }), transitionDuration: n('Seconds'),
      animIn: s('Clip entrance animation', { enum: CLIP_ANIMS }), animInDuration: n('Seconds'), animOut: s('Clip exit animation', { enum: CLIP_ANIMS }), animOutDuration: n('Seconds'),
      filter: s('Look', { enum: FILTERS }), filterIntensity: n('0-1'), brightness: n('-1..1'), contrast: n('0..3'), saturation: n('0..3'), temperature: n('-1..1'), vignette: n('0..1'),
      imageMotion: s('Ken Burns on photos', { enum: MOTIONS }), imageMotionIntensity: n('0.02-0.6'),
    },
  },
  title: { type: 'object', description: 'Look of titles / text overlays (x, y = default position of new texts)', properties: pickProps(textProps, ['style', 'font', 'size', 'color', 'bold', 'italic', 'outline', 'outlineColor', 'shadow', 'shadowColor', 'blur', 'box', 'boxColor', 'animation', 'animationOut', 'x', 'y']) },
  captions: { type: 'object', description: 'Caption look', properties: captionStyleProps },
  music: { type: 'object', description: 'Music mix', properties: { volume: n('0-2'), fadeIn: n('Seconds'), fadeOut: n('Seconds'), duck: n('0-1 lower under speech, 0 = off') } },
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

  { name: 'list_styles', description: 'List reel styles (built-in and saved): what each sets for canvas, clips, titles, captions, music, intro/outro and logo.', input_schema: S({}) },
  {
    name: 'save_style',
    description: 'Save a reusable reel style ("my style"), shared by all projects. By default it captures the open project\'s look: canvas, the first clip\'s fit/color/animations, the transition in use, photo motion, the first text\'s look (or titleTextId), the caption style and the music mix. ' +
      'Name introClipId / outroClipId / logoOverlayId to include an intro, outro or logo. Sections you pass (canvas, clips, title, captions, music) override what was captured. Saving under an existing name updates that style.',
    input_schema: S({
      name: s('Style name'), description: s('What the style is for'), fromProject: b('Capture the open project\'s look (default true); false = only what you pass'),
      titleTextId: s('Text whose look becomes the title style (default: first text)'), introClipId: s('Clip to save as the intro'), outroClipId: s('Clip to save as the outro'), logoOverlayId: s('Overlay to save as the logo/watermark'),
      ...styleSections,
    }, ['name']),
  },
  {
    name: 'apply_style',
    description: 'Apply a reel style to the open project in one step (one undo): canvas, clip fit/color/transitions/animations, photo motion, the look of every text (positions kept), caption style, music mix, and intro/outro clips and a logo overlay if the style has them (re-applying replaces them). ' +
      'It also becomes the project\'s default, so clips, texts, captions and music added later follow it. parts limits what is applied.',
    input_schema: S({ styleId: s('Style id or name (list_styles)'), parts: { type: 'array', items: { type: 'string', enum: STYLE_PARTS }, description: 'Only these parts (default: everything the style has)' } }, ['styleId']),
  },
  { name: 'delete_style', description: 'Delete a saved style (moved to data/trash). Only when the user asks.', input_schema: S({ styleId: s('Style id or name') }, ['styleId']) },
  { name: 'list_templates', description: 'List saved templates: their slots (length of each clip to fill), texts, music and style.', input_schema: S({}) },
  {
    name: 'save_template',
    description: 'Save the open project as a template: every main-track clip (or slotClipIds) becomes a numbered slot that keeps its length, speed, framing, color, effects, keyframes and transition; texts, overlays, music, beat markers and the style stay as they are. ' +
      'Later create_from_template makes a new reel by putting other clips into the slots. Saving under an existing name updates it.',
    input_schema: S({ name: s('Template name'), description: s('What it is for'), slotClipIds: { type: 'array', items: { type: 'string' }, description: 'Clips that become slots (default: all except style intro/outro)' }, keepMusic: b('Keep the music and beat markers (default true)'), keepTexts: b('Keep the texts (default true)') }, ['name']),
  },
  {
    name: 'create_from_template',
    description: 'Create a new project from a template and open it: media goes into the slots in order (each slot keeps its length; a video starts at its "in", or 0, and is shifted earlier if too short). ' +
      'Without assetIds/slots it fills the slots with the media library\'s videos and photos in order. texts replaces the template\'s texts in order. Check the result with look_at_timeline.',
    input_schema: S({
      templateId: s('Template id or name (list_templates)'), name: s('Project name'),
      assetIds: { type: 'array', items: { type: 'string' }, description: 'One video/photo asset per slot, in slot order (repeat to reuse)' },
      slots: { type: 'array', items: { type: 'object', properties: { assetId: s('Asset id'), in: n('Source start seconds') }, required: ['assetId'] }, description: 'Like assetIds, with a source start per slot' },
      texts: { type: 'array', items: { type: 'string' }, description: 'New text for the template\'s texts in order ("" keeps one)' },
    }, ['templateId']),
  },
  { name: 'delete_template', description: 'Delete a saved template (moved to data/trash). Only when the user asks.', input_schema: S({ templateId: s('Template id or name') }, ['templateId']) },

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
      animIn: s('Entrance animation of the clip (none removes). zoom_in grows from 60%, zoom_out shrinks from 140%, slide_X moves in that direction', { enum: CLIP_ANIMS }),
      animInDuration: n('Seconds (default 0.5)'),
      animOut: s('Exit animation of the clip (none removes). zoom_in grows, zoom_out shrinks, slide_X leaves in that direction', { enum: CLIP_ANIMS }),
      animOutDuration: n('Seconds (default 0.5)'),
      reverse: b(`Play the clip backwards (video clips, up to ${REVERSE_MAX}s of source; audio is reversed too)`),
    }, ['clipId']),
  },
  {
    name: 'set_speed_ramp',
    description: 'Make a clip\'s speed change smoothly over its length (speed ramp / curve), audio pitch kept. ' +
      `Presets: montage (fast-slow-fast), hero (slow motion in the middle), bullet (long slow-mo hold), jump_cut (quick burst), flash_in (fast start), flash_out (fast end). ` +
      'Or points: [{at, speed}] where at is the position in the clip (0 = first frame, 1 = last; for source second x: (x - in) / (out - in)) and speed 0.1-10, changing linearly between points. ' +
      'The clip gets longer or shorter accordingly. preset none removes it; set_clip speed also replaces it.',
    input_schema: S({
      clipId: s('Clip id'), preset: s('Ramp preset', { enum: [...Object.keys(RAMP_PRESETS), 'none'] }),
      points: { type: 'array', items: { type: 'object', properties: { at: n('0-1 position in the clip'), speed: n('0.1-10') }, required: ['at', 'speed'] }, description: 'Custom curve (instead of preset)' },
    }, ['clipId']),
  },
  {
    name: 'freeze_frame',
    description: 'Freeze frame: hold the frame at a timeline time for some seconds (the clip is split there and a still is inserted; later clips move right). Change its length later with trim_clip (out = in + seconds).',
    input_schema: S({ at: n('Timeline seconds of the frame to hold'), duration: n('Seconds to hold (default 2)'), clipId: s('Optional clip id (default: the clip at that time)') }, ['at']),
  },
  {
    name: 'set_color',
    description: 'Color-correct a clip or overlay and/or apply a filter look. Adjustments: brightness -1..1 (0 = original), contrast and saturation 0..3 (1 = original), temperature -1 (cool/blue)..1 (warm/orange), vignette 0..1. ' +
      `Looks: ${FILTERS.filter((f) => f !== 'none').join(', ')}; filterIntensity 0-1 blends the look with the original. Only the fields you pass change; reset clears everything first.`,
    input_schema: S({
      clipId: s('Clip id (or give overlayId)'), overlayId: s('Overlay id'),
      brightness: n('-1..1, 0 = original (0.1 = a little brighter)'), contrast: n('0..3, 1 = original'), saturation: n('0..3, 1 = original, 0 = grayscale'),
      temperature: n('-1 cool .. 1 warm, 0 = original'), vignette: n('0..1 dark corners'),
      filter: s('Look preset (none removes)', { enum: FILTERS }), filterIntensity: n('0..1 (default 1)'), reset: b('Clear all color settings first'),
      lut: s('Imported .cube LUT by file name (list_luts), applied before the look; none removes'), lutIntensity: n('0..1 (default 1)'),
    }),
  },
  {
    name: 'add_effect',
    description: `Add a video effect to a main-track clip for a time range: ${EFFECTS.join(', ')}. ` +
      'shake = camera shake; zoom_pulse = rhythmic punch-in (rate = pulses per second, e.g. BPM/60 to hit the beat); glitch = random RGB-shift/noise bursts; rgb_split = steady chromatic offset; flash = white flash that fades out from start; blur; vhs = retro tape look; light_leak = warm moving light; invert = negative. ' +
      'start/end are TIMELINE seconds inside the clip (default: whole clip); the effect stays with the clip if it moves. Export and look_at_timeline only (not shown in the browser preview).',
    input_schema: S({ clipId: s('Clip id'), type: s('Effect', { enum: EFFECTS }), start: n('Timeline seconds (default clip start)'), end: n('Timeline seconds (default clip end)'), intensity: n('0..1 (default 0.5)'), rate: n('shake / zoom_pulse: cycles per second (shake default 8, zoom_pulse default 2)') }, ['clipId', 'type']),
  },
  { name: 'delete_effect', description: 'Remove an effect (ids are listed with each clip in get_timeline).', input_schema: S({ effectId: s('Effect id') }, ['effectId']) },
  {
    name: 'set_keyframes',
    description: `Animate a property of a clip or overlay over time with keyframes (replaces that property's keyframes; [] removes them). ` +
      `Clip properties: ${Object.keys(KEYFRAME_PROPS.clip).join(', ')} (scale/x/y = zoom and position inside the canvas, e.g. a slow push-in or a reframe that follows the subject). ` +
      `Overlay properties: ${Object.keys(KEYFRAME_PROPS.overlay).join(', ')} (x/y/scale need fit free). ` +
      'Each keyframe is {t, value} with t in TIMELINE seconds within the item; between keyframes values ease (or move linearly), before the first and after the last they hold. While keyframed, the static value of that property is ignored.',
    input_schema: S({
      clipId: s('Clip id (or give overlayId)'), overlayId: s('Overlay id'),
      property: s('Property to animate', { enum: [...new Set([...Object.keys(KEYFRAME_PROPS.clip), ...Object.keys(KEYFRAME_PROPS.overlay)])] }),
      keyframes: { type: 'array', description: 'e.g. [{t:2,value:1},{t:4,value:1.3}]', items: { type: 'object', properties: { t: n('Timeline seconds'), value: n('Value at that time') }, required: ['t', 'value'] } },
      easing: s('ease (default, smooth) or linear', { enum: ['ease', 'linear'] }),
    }, ['property', 'keyframes']),
  },
  {
    name: 'delete_range',
    description: 'Ripple delete: cut timeline seconds start..end out of the whole video and close the gap. Clips are split at both ends; texts, overlays, sfx/voice, captions and markers after the range move left, those inside are deleted, those across it get shorter. Background music (role music) keeps playing and only moves if it starts after the range.',
    input_schema: S({ start: n('Timeline seconds'), end: n('Timeline seconds') }, ['start', 'end']),
  },
  { name: 'duplicate_items', description: 'Copy clips, texts, overlays, audio items or markers (copy/paste). Copied clips go in right after the originals (or at the clip boundary nearest `at`); other items keep their spacing and start at `at` (default: right after the originals). Groups are copied as new groups.', input_schema: S({ ids: idsSchema('Item ids (or group ids grp_...)'), at: n('Timeline seconds to paste at') }, ['ids']) },
  { name: 'delete_items', description: 'Delete several items at once (clips, texts, overlays, audio items, markers).', input_schema: S({ ids: idsSchema('Item ids') }, ['ids']) },
  { name: 'move_items', description: 'Move texts, overlays, audio items and markers in time together (their groups move too). Main-track clips are reordered with move_clip instead.', input_schema: S({ ids: idsSchema('Item ids or group ids'), by: n('Seconds, negative = earlier') }, ['ids', 'by']) },
  { name: 'group_items', description: 'Group texts, overlays, audio items and markers so they are selected, moved, copied and deleted together (e.g. a title with its sound effect and sticker).', input_schema: S({ ids: idsSchema('At least 2 item ids') }, ['ids']) },
  { name: 'ungroup_items', description: 'Remove items (or a whole group, by group id) from their group.', input_schema: S({ ids: idsSchema('Item ids or group ids') }, ['ids']) },
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

  { name: 'add_music', description: 'Add an audio item: music (default), sfx (sound effect) or voice (voiceover). Mixed under the clip audio. Each role gets its own track by default (music 1, voice 2, sfx 3).', input_schema: S({ assetId: s('Asset id (audio, or a video with audio)'), role: s('music, sfx or voice', { enum: AUDIO_ROLES }), track: n('Audio track 1-20'), start: n('Timeline start seconds (default 0)'), in: n('Source start s'), out: n('Source end s'), volume: n('0-2 (music default 0.6, others 1)'), fadeIn: n('Seconds'), fadeOut: n('Seconds (music default 1)'), duck: n('0-1: automatically lower this audio while someone speaks (clip audio and voice items). 0 = off, 0.6 = typical') }, ['assetId']) },
  { name: 'update_music', description: 'Change an audio item (music, sfx or voice). duck 0-1 lowers it under speech (0 = off; export only, not in the browser preview).', input_schema: S({ musicId: s('Audio item id'), role: s('Role', { enum: AUDIO_ROLES }), track: n('Track'), start: n('s'), in: n('s'), out: n('s'), volume: n('0-2'), fadeIn: n('s'), fadeOut: n('s'), duck: n('0-1 ducking under speech, 0 = off') }, ['musicId']) },
  { name: 'analyze_audio', description: 'Analyse an audio or video asset: tempo (BPM) and beat times, loudness, and silences, all in SOURCE seconds. Use it to plan cuts on the beat, find quiet gaps, or pick a music section. Cached per file.', input_schema: S({ assetId: s('Asset id (or give musicId to analyse what an audio item uses)'), musicId: s('Audio item id: limits the result to the part it plays'), from: n('Source seconds'), to: n('Source seconds'), force: b('Re-run even if cached') }) },
  { name: 'mark_beats', description: 'Detect the beats of an audio item (music) and put them on the timeline as beat markers (replaces old beat markers). Then fit_clips_to_beats cuts on them, or use the times for effects/text.', input_schema: S({ musicId: s('Audio item id') }, ['musicId']) },
  { name: 'fit_clips_to_beats', description: 'Cut to the beat: trims each main-track clip\'s out point so every cut (and the end) lands on a beat marker. every = beats per clip (1 = cut on every beat, 2 = every other, 4 = once per bar). Clips whose source is too short are kept and reported. Needs beat markers (mark_beats).', input_schema: S({ every: n('Beats per clip (default 1)'), skipBeats: n('Ignore this many beat markers at the start (default 0)') }) },
  { name: 'add_markers', description: 'Add timeline markers (notes or beats) at timeline seconds.', input_schema: S({ times: { type: 'array', items: { type: 'number' }, description: 'Timeline seconds' }, kind: s('note (default) or beat', { enum: ['note', 'beat'] }), label: s('Optional label'), replace: b('Remove existing markers of this kind first') }, ['times']) },
  { name: 'delete_markers', description: 'Delete markers: by ids, by kind, or all.', input_schema: S({ kind: s('Only this kind', { enum: ['note', 'beat'] }), markerIds: { type: 'array', items: { type: 'string' }, description: 'Marker ids' } }) },
  { name: 'delete_music', description: 'Remove an audio item.', input_schema: S({ musicId: s('Audio item id') }, ['musicId']) },
  { name: 'set_canvas', description: 'Change output format.', input_schema: S({ aspect: s('Aspect ratio', { enum: Object.keys(ASPECTS) }), background: s('Hex background color for letterboxing'), fps: n('Frames per second') }) },
  { name: 'clear_timeline', description: 'Remove all clips, overlays, texts, captions and audio (keeps the media library). Only when the user clearly asks to start over.', input_schema: S({}) },
  { name: 'undo', description: 'Undo the last edit.', input_schema: S({}) },
  { name: 'redo', description: 'Redo the last undone edit.', input_schema: S({}) },
  {
    name: 'export_video',
    description: 'Render the timeline to an MP4 file with ffmpeg. With wait=true it returns when the file is ready (with its path); otherwise it returns a job id for export_status. ' +
      'Defaults: canvas size and fps, CPU x264. resolution sets the short side (e.g. 720p for a quick share, 2160p for 4K); encoder gpu uses NVIDIA/Intel/AMD hardware encoding (much faster), auto uses it when available.',
    input_schema: S({
      quality: s('draft (fast, half resolution) or final', { enum: ['draft', 'final'] }), wait: b('Wait until done (up to 10 min)'),
      resolution: s('Short side of the output (overrides draft scaling)', { enum: Object.keys(RESOLUTIONS) }), fps: n('Output frames per second (default: canvas fps)'),
      bitrate: n('Video bitrate in Mbps (default: constant quality)'), encoder: s('cpu (default), gpu or auto', { enum: ['cpu', 'gpu', 'auto'] }),
    }),
  },
  { name: 'export_cover', description: 'Save a cover image (thumbnail) of the finished video: a full-size JPEG of the timeline frame at time t, with text and overlays, next to the exports. Returns the path and shows you the image.', input_schema: S({ t: n('Timeline seconds (default 0)'), name: s('File name without extension (default: project name + "-cover")') }) },
  { name: 'list_luts', description: 'List imported color LUTs (.cube files) usable with set_color lut. Import more with import_media.', input_schema: S({}) },
  { name: 'export_status', description: 'Check an export or other job.', input_schema: S({ jobId: s('Job id') }, ['jobId']) },
  { name: 'create_proxies', description: 'Make small preview copies (720p H.264) of video files the browser cannot play smoothly (4K, HEVC, ProRes...). Imports do this automatically; use it for older imports. Export always uses the original files.', input_schema: S({ assetIds: { type: 'array', items: { type: 'string' }, description: 'Default: every video that needs one' }, force: b('Also make proxies for videos that do not need one') }) },
];

// MCP tool annotations (not sent to the Anthropic API, which does not accept them).
const READ_ONLY = new Set(['get_timeline', 'look_at_asset', 'look_at_timeline', 'list_projects', 'list_fonts', 'get_transcript', 'export_status', 'analyze_audio', 'list_styles', 'list_templates', 'list_luts']);
const DESTRUCTIVE = new Set(['delete_clip', 'delete_region', 'delete_effect', 'delete_markers', 'delete_overlay', 'delete_text', 'delete_captions', 'delete_music', 'clear_timeline', 'delete_project', 'add_captions', 'delete_style', 'delete_template', 'delete_range', 'delete_items']);
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
const fmtJob = (j) => `${j.kind} ${j.status} ${Math.round(j.progress * 100)}%${j.error ? ` error: ${j.error}` : ''}${j.status === 'done' && j.path ? ` file: ${j.path} (URL /exports/${j.file})` : ''}${j.width ? ` [${j.width}x${j.height} @${j.fps}fps, ${j.encoder}]` : ''}`;

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

      case 'list_styles': {
        const cur = store.getProject().style;
        return { content: listStyles().map((st) => `- ${st.id} "${st.name}"${st.builtin ? ' [built-in]' : ''}${st.description ? `: ${st.description}` : ''}\n  ${describeStyle(st)}`).join('\n') + (cur ? `\nThe open project uses "${cur.name}".` : '') };
      }
      case 'save_style': {
        const p = store.getProject();
        const all = styleFromProject(p, input);
        const captured = input.fromProject === false
          ? Object.fromEntries([['intro', 'introClipId'], ['outro', 'outroClipId'], ['logo', 'logoOverlayId']].filter(([, k]) => input[k]).map(([part]) => [part, all[part]]))
          : all;
        const raw = { ...captured, name: input.name, description: input.description };
        for (const k of ['canvas', 'clips', 'title', 'captions', 'music']) if (input[k] && typeof input[k] === 'object') raw[k] = { ...(captured[k] || {}), ...input[k] };
        if (!describeStyle(normalizeStyle(raw))) return { content: 'Nothing to save: the project has no clips, texts, captions or music to take a look from, and no sections were given.', isError: true };
        const { style, updated } = saveStyle(raw);
        return { content: `${updated ? 'Updated' : 'Saved'} style ${style.id} "${style.name}": ${describeStyle(style)}. Use apply_style to put it on a project.` };
      }
      case 'delete_style': {
        const st = deleteStyle(input.styleId);
        return { content: `Deleted style ${st.id} "${st.name}" (moved to data/trash).` };
      }
      case 'list_templates': {
        const list = listTemplates();
        if (!list.length) return { content: 'No templates yet. Build an edit, then save_template.' };
        return { content: list.map((t) => `- ${t.id} "${t.name}"${t.description ? `: ${t.description}` : ''}\n  ${describeTemplate(t).replace(/\n/g, '\n  ')}`).join('\n') };
      }
      case 'save_template': {
        const { template: t, updated } = saveTemplate(makeTemplate(store.getProject(), input));
        return { content: `${updated ? 'Updated' : 'Saved'} template ${t.id} "${t.name}": ${describeTemplate(t)}\nUse create_from_template to fill it with new clips.` };
      }
      case 'create_from_template': {
        const tpl = loadTemplate(input.templateId);
        let msg;
        const p = store.createProject({ name: input.name || tpl.name, build: (np) => { msg = fillTemplate(np, tpl, input); } }, source);
        return { content: `${msg} Created and opened project ${p.id} "${p.name}".\n\n${summary(p)}` };
      }
      case 'delete_template': {
        const t = deleteTemplate(input.templateId);
        return { content: `Deleted template ${t.id} "${t.name}" (moved to data/trash).` };
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
      case 'analyze_audio': {
        const p = store.getProject();
        const m = input.musicId ? p.music.find((x) => x.id === input.musicId) : null;
        if (input.musicId && !m) return { content: `No audio item ${input.musicId}`, isError: true };
        const a = p.assets[m ? m.assetId : input.assetId];
        if (!a) return { content: `No asset ${input.assetId}. Give assetId or musicId.`, isError: true };
        const r = await analyzeAudio(a, { force: !!input.force });
        const from = input.from !== undefined ? Number(input.from) : m ? m.in : 0;
        const to = input.to !== undefined ? Number(input.to) : m ? m.out : Infinity;
        return { content: analysisText(a, r, { from, to }) + (m ? `\n(${m.id} plays source ${m.in}-${m.out}s from timeline ${m.start}s: timeline = ${m.start} + (source - ${m.in}))` : '') };
      }
      case 'mark_beats': {
        const p = store.getProject();
        const m = p.music.find((x) => x.id === input.musicId);
        if (!m) return { content: `No audio item ${input.musicId}. Audio items: ${p.music.map((x) => x.id).join(', ') || 'none'}`, isError: true };
        const r = await analyzeAudio(p.assets[m.assetId]);
        if (!r.bpm) return { content: `No steady beat found in "${p.assets[m.assetId].name}".`, isError: true };
        const times = r.beats.filter((b) => b >= m.in && b <= m.out).map((b) => Math.round((m.start + b - m.in) * 1000) / 1000);
        if (!times.length) return { content: `No beats inside the part ${m.id} plays (${m.in}-${m.out}s).`, isError: true };
        store.apply('add_markers', { times, kind: 'beat', replace: true }, source);
        return { content: `Marked ${times.length} beats (${r.bpm} BPM, confidence ${r.confidence}) at timeline ${times[0]}s … ${times[times.length - 1]}s. Next: fit_clips_to_beats, or use the marker times for effects and text.` };
      }
      case 'create_proxies': {
        const p = store.getProject();
        const ids = Array.isArray(input.assetIds) && input.assetIds.length ? input.assetIds : Object.keys(p.assets);
        const started = [], skipped = [];
        for (const id of ids) {
          const a = p.assets[id];
          if (!a || a.type !== 'video') { if (input.assetIds) skipped.push(`${id}: not a video`); continue; }
          const meta = a.codec ? a : { ...a, ...(await probe(path.join(store.MEDIA_DIR, a.file))) };
          if (!input.force && !needsProxy(meta)) { if (input.assetIds) skipped.push(`${a.name}: plays fine without one`); continue; }
          if (hasProxy(a) && !input.force) { skipped.push(`${a.name}: already has one`); continue; }
          const j = startProxy(meta);
          started.push(`${a.name} (job ${j.id})`);
        }
        return { content: `${started.length ? `Making proxies: ${started.join(', ')}. The preview switches to them when done.` : 'No proxies needed.'}${skipped.length ? `\nSkipped: ${skipped.join('; ')}` : ''}` };
      }
      case 'export_video': {
        if (input.resolution !== undefined && !RESOLUTIONS[input.resolution]) return { content: `resolution must be one of: ${Object.keys(RESOLUTIONS).join(', ')}`, isError: true };
        const fps = input.fps === undefined ? undefined : Number(input.fps);
        if (fps !== undefined && !(fps >= 10 && fps <= 120)) return { content: 'fps must be between 10 and 120', isError: true };
        const bitrate = input.bitrate === undefined ? undefined : Number(input.bitrate);
        if (bitrate !== undefined && !(bitrate >= 0.5 && bitrate <= 200)) return { content: 'bitrate must be between 0.5 and 200 Mbps', isError: true };
        if (input.encoder !== undefined && !['cpu', 'gpu', 'auto'].includes(input.encoder)) return { content: 'encoder must be cpu, gpu or auto', isError: true };
        let job = startExport(store.getProject(), { quality: input.quality || 'final', resolution: input.resolution, fps, bitrate, encoder: input.encoder || 'cpu' });
        if (job.status === 'error') return { content: `Export failed: ${job.error}`, isError: true };
        if (!input.wait) return { content: `Export started, job ${job.id}. Output: ${job.path} (URL /exports/${job.file})` };
        job = await waitJob(job.id, 600000);
        return { content: `Job ${job.id}: ${fmtJob(job)}`, isError: job.status === 'error' };
      }
      case 'export_cover': {
        const p = store.getProject();
        const L = layout(p);
        if (!L.clips.length) return { content: 'Timeline is empty.', isError: true };
        const t = input.t === undefined ? 0 : Number(input.t);
        if (!Number.isFinite(t) || t < 0) return { content: 't must be timeline seconds >= 0', isError: true };
        const [frame] = await renderFrames(p, [Math.min(t, L.duration)], { still: true });
        if (!frame) return { content: 'Could not render that frame', isError: true };
        const base = String(input.name || `${p.name || 'video'}-cover`).replace(/[^\w-]+/g, '_').slice(0, 80) || 'cover';
        const file = `${base}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
        const out = path.join(store.EXPORT_DIR, file);
        fs.writeFileSync(out, Buffer.from(frame.data, 'base64'));
        return { content: [{ type: 'text', text: `Saved cover image (timeline ${frame.t.toFixed(2)}s, ${p.settings.width}x${p.settings.height}): ${out} (URL /exports/${file})` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.data } }] };
      }
      case 'list_luts': {
        const luts = listLuts();
        return { content: luts.length ? `Imported LUTs (set_color lut):\n${luts.map((x) => `- ${x}`).join('\n')}` : 'No LUTs imported. Import a .cube file with import_media (or the Import button).' };
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
