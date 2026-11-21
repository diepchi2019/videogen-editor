// Tool definitions shared by the in-app Claude chat and the MCP server.
import {
  TRANSITIONS, ASPECTS, FITS, MOTIONS, TEXT_ANIM_IN, TEXT_ANIM_OUT, TEXT_STYLES, AUDIO_ROLES, OVERLAY_FITS, OVERLAY_ANIMS, BLEND_MODES,
  CAPTION_MODES, CAPTION_STYLES, REGION_MODES, MASK_SHAPES, VOICE_EFFECTS, SMOOTH_MODES, CLIP_ANIMS, FILTERS, EFFECTS, KEYFRAME_PROPS, STYLE_PARTS, RAMP_PRESETS, REVERSE_MAX, summarize, timelineWords, layout, env, ops,
  styleFromProject, describeStyle, normalizeStyle, uid, makeTemplate, describeTemplate, fillTemplate,
} from './model.js';
import { listStyles, loadStyle, saveStyle, deleteStyle, listTemplates, loadTemplate, saveTemplate, deleteTemplate } from './presets.js';
import * as store from './store.js';
import { extractFrames, probe, needsProxy, hasProxy, startProxy } from './media.js';
import { startExport, getJob, renderFrames, RESOLUTIONS } from './render.js';
import { analyzeAudio, analysisText } from './audio.js';
import path from 'node:path';
import { waitJob } from './jobs.js';
import { transcribe, readTranscript, hasTranscript, transcriptText, MODEL_HELP } from './transcribe.js';
import { listFonts, resolveFont, defaultFont } from './fonts.js';
import { listLuts, resolveLut } from './luts.js';
import { loudness, sceneChanges, findMoments, momentsText } from './moments.js';
import { faceSamples, subjectPath, faceModelPath, FACE_HELP } from './faces.js';
import { findPauseCuts, fineLoudness, peakDb, quietRuns } from './pauses.js';
import { srcAt, localAt } from './timing.js';
import { pickKeywords, findPhrase, planAutoZoom } from './emphasis.js';
import { fetchEmoji } from './emoji.js';
import { checkReel, checkText } from './check.js';
import { transcriptText as timelineTranscriptText, cutRange, findWords, wordsIn, mergeRanges, findRetakes, matchBroll } from './transcript.js';
import { detectShake } from './stabilize.js';
import { clipStats, colorMatch } from './colormatch.js';
import { LAYOUTS, layoutPlan } from './layouts.js';
import { searchAudio, getTrack, downloadTrack, trackLine } from './library.js';
import { get as setting } from './settings.js';
import { synthesize, listVoices, piperCommand, PIPER_HELP, ttsSettings, elevenVoices, elevenModels, ENGINES } from './tts.js';
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
  size: n('Font size px'), y: n('Vertical center 0-1 (presets 0.72-0.78; above about 0.78 the TikTok/Reels username and description cover it)'), font: s('Font family (list_fonts)'),
  color: s('Hex text color'), highlightColor: s('Hex color of the spoken word'), outline: n('Outline px'), outlineColor: s('Hex'),
  box: b('Background box'), boxColor: s('Hex'), uppercase: b('ALL CAPS'), bold: b('Bold'), maxWords: n('Max words per line (1-12)'),
};
// Voice effect + pitch, on clips, overlays and audio items.
const soundProps = {
  voiceEffect: s('Voice effect (export only): chipmunk (high), deep (low), robot, echo, hall (big room reverb), telephone, radio, megaphone; none removes', { enum: VOICE_EFFECTS }),
  pitch: n('Pitch shift in semitones -12..12 without changing speed (0 = original; adds to chipmunk/deep)'),
  enhanceVoice: b('Studio voice (export only): cleaner, clearer, steadier speech for phone or room recordings; false removes it'),
};
const overlayProps = {
  start: n('Timeline start seconds'), end: n('Timeline end seconds (alternative to duration)'), duration: n('Seconds on the timeline'),
  in: n('Source start seconds (video)'), out: n('Source end seconds (video)'), speed: n('0.25-4'),
  fit: s('free = position with x/y/scale; cover = fill the whole frame (B-roll cutaway); contain = whole frame, letterboxed', { enum: OVERLAY_FITS }),
  x: n('Center x 0-1 (free fit)'), y: n('Center y 0-1 (free fit)'), scale: n('Width as a fraction of the canvas width (free fit), e.g. 0.35 for picture-in-picture, 0.15 for a logo'),
  rotate: n('Degrees'), opacity: n('0-1'), volume: n('0-2, audio of a video overlay (0 = mute)'), track: n('Layer 1-20, higher is on top'),
  crop: cropSchema, flipH: b('Mirror horizontally'), flipV: b('Flip vertically'), animation: s('fade = fade in and out; pop = grows in with a bounce (free fit, good for stickers)', { enum: OVERLAY_ANIMS }),
  loop: b('Repeat a video / animated GIF for as long as the overlay lasts (default on for GIFs); then duration may be longer than the file'),
  blend: s('How it mixes with the video under it: screen (light leaks, fire, sparkles on black), multiply (paper/texture, darkens), overlay/softlight (texture with contrast), add, lighten, darken, difference; normal removes. Export only, the preview shows an approximation', { enum: BLEND_MODES }),
  chromaKey: s('Remove a green or blue screen: green, blue, a hex color of the backdrop (pick it with look_at_asset), or none'),
  keySimilarity: n('How far from the key color still counts as backdrop, 0.01-1 (default 0.25; raise it if green remains, lower it if the subject gets holes)'),
  keyBlend: n('Edge softness 0-1 (default 0.08)'), keyDespill: b('Remove the green/blue tint on the subject edges (default on for green/blue)'),
  denoise: n('Noise reduction on the audio 0-1 (0 = off, 0.5 = typical for hiss/fan/wind)'),
  ...soundProps,
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
  { name: 'look_at_asset', description: 'See frames from a source video/image asset so you can understand its content (e.g. find where something happens). Returns images labelled with source timestamps.', input_schema: S({ assetId: s('Asset id'), from: n('Start time in source seconds (default 0)'), to: n('End time in source seconds (default end)'), count: n('Number of frames, 1-12 (default 6)'), grid: b('Draw a grid every 10% (brighter lines at the middle) to read positions as fractions, e.g. for reframe_clip or remove_region') }, ['assetId']) },
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
  {
    name: 'find_moments',
    description: 'Long video to short clips, step 1: list the best candidate moments of a long video or podcast for shorts/reels, best first. ' +
      'Each candidate is whole sentences (from the local transcript) between minDuration and maxDuration, scored on continuous lively speech, loudness peaks (laughs, punchlines), a hook or question at the start, clean start/end, shot changes, and words from query. ' +
      'Returns SOURCE in/out seconds and the text of each. Read them and pick the ones that stand alone, then make_short for each. Transcribes the asset first if needed (cached; long files take a while). Videos without speech are cut on shot changes and loudness.',
    input_schema: S({
      assetId: s('Video or audio asset id'), minDuration: n('Shortest moment in seconds (default 15)'), maxDuration: n('Longest moment in seconds (default 60)'),
      targetDuration: n('Preferred length in seconds (default halfway between min and max)'), count: n('How many candidates, 1-30 (default 8)'),
      query: s('Optional topic words to favour, e.g. "pricing mistakes"'), language: s('Speech language code or auto (default)'),
    }, ['assetId']),
  },
  {
    name: 'make_short',
    description: 'Long video to short clips, step 2: make a NEW project holding one moment of a long video as a ready short: the source in-out range as the only clip, ' +
      'the vertical canvas, fit cover (centered crop; use reframe_clip after if the subject is off-center), captions from the transcript, an optional title and an optional reel style. ' +
      'open false saves it without switching (to make several in a row; open them later with open_project). The source project and its media are unchanged.',
    input_schema: S({
      assetId: s('Video asset id (from the open project)'), in: n('Source start seconds'), out: n('Source end seconds'),
      name: s('Project name (default: asset name + time range)'), aspect: s('Canvas (default 9:16)', { enum: Object.keys(ASPECTS) }),
      fit: s('How the source fills the canvas (default cover, or the fit of the style)', { enum: FITS }),
      captions: s('Caption preset, or none (default: the captions of the style, else classic)', { enum: [...Object.keys(CAPTION_STYLES), 'none'] }),
      title: s('Optional title text shown for the first 3 seconds'), styleId: s('Optional reel style to apply (list_styles)'),
      reframe: s('auto (default): the crop follows the speaker\'s face (local face detector); center: plain centered crop', { enum: ['auto', 'center'] }),
      open: b('Switch to the new project (default true)'), language: s('Speech language code or auto'),
    }, ['assetId', 'in', 'out']),
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
      clipId: s('Clip id'), speed: n('0.25-4 (2 = fast, 0.5 = slow motion)'), volume: n('0-2, 0 = mute'), denoise: n('Noise reduction on the clip audio 0-1 (0 = off, 0.5 = typical for hiss/fan/wind)'), fit: s('Fill mode', { enum: FITS }),
      crop: cropSchema, rotate: n('Degrees, 90/180/270 or any angle'), flipH: b('Mirror horizontally'), flipV: b('Flip vertically'),
      scale: n('Zoom inside the canvas, 1 = fitted size (0.1-5)'), x: n('Center x 0-1 inside the canvas (0.5 = centered)'), y: n('Center y 0-1'),
      resetTransform: b('Remove crop/rotate/flip/scale/position first'),
      motion: s('Ken Burns movement over the clip', { enum: MOTIONS }), motionIntensity: n('How far to zoom/pan, 0.02-0.6 (default 0.15)'),
      animIn: s('Entrance animation of the clip (none removes). zoom_in grows from 60%, zoom_out shrinks from 140%, slide_X moves in that direction', { enum: CLIP_ANIMS }),
      animInDuration: n('Seconds (default 0.5)'),
      animOut: s('Exit animation of the clip (none removes). zoom_in grows, zoom_out shrinks, slide_X leaves in that direction', { enum: CLIP_ANIMS }),
      animOutDuration: n('Seconds (default 0.5)'),
      reverse: b(`Play the clip backwards (video clips, up to ${REVERSE_MAX}s of source; audio is reversed too)`),
      smoothSlowMo: s('Smooth slow motion for clips slowed below 1x (speed or ramp): blend = cross-fades frames (fast), motion = motion-interpolated new frames (best, slow to export, can warp fast motion); off removes. Export only', { enum: SMOOTH_MODES }),
      ...soundProps,
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
      'shake = camera shake; zoom_pulse = rhythmic punch-in (rate = pulses per second, e.g. BPM/60 to hit the beat); glitch = random RGB-shift/noise bursts; rgb_split = steady chromatic offset; flash = white flash that fades out from start; blur; vhs = retro tape look; light_leak = warm moving light; invert = negative; ' +
      'pixelate = big pixels (intensity = block size); mirror = left half mirrored to the right; kaleidoscope = top-left quarter mirrored 4 ways; film_grain = moving grain; strobe = white flicker (rate = flashes per second); comic = colored edge drawing. ' +
      'start/end are TIMELINE seconds inside the clip (default: whole clip); the effect stays with the clip if it moves. The browser preview approximates it; check the real look with look_at_timeline.',
    input_schema: S({ clipId: s('Clip id'), type: s('Effect', { enum: EFFECTS }), start: n('Timeline seconds (default clip start)'), end: n('Timeline seconds (default clip end)'), intensity: n('0..1 (default 0.5)'), rate: n('shake / zoom_pulse / strobe: cycles per second (shake default 8, zoom_pulse 2, strobe 8)') }, ['clipId', 'type']),
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
  {
    name: 'remove_silences',
    description: 'Tighten talking: cut the pauses and filler words (um, uh, ờ, ừm...) out of main-track clips with speech, as jump cuts, in one undo step. ' +
      'Uses the local Whisper transcript (transcribes when needed) and checks each pause is really quiet, so gaps with music or words Whisper missed stay. ' +
      'A pause longer than minPause is shortened to keepPause on each side; silence before the first and after the last word of a clip is cut too. Captions, texts and sound effects move with the cuts; background music keeps playing. ' +
      'Use dryRun to see the cuts first. For other words to drop ("like", repeated words, a false start) read get_transcript and use delete_range.',
    input_schema: S({
      clipId: s('Only this clip (default: every main-track clip with speech)'),
      minPause: n('Cut pauses longer than this, seconds (default 0.6; 0.3 = very tight, 1.2 = only long pauses)'),
      keepPause: n('Seconds of pause kept on each side of a cut (default 0.15)'),
      fillers: b('Also cut filler words (default true)'),
      fillerWords: { type: 'array', items: { type: 'string' }, description: 'Extra words to treat as fillers, e.g. ["like"]' },
      ignoreSound: b('Cut pauses even when there is sound in them (default false)'),
      language: s('Speech language for transcribing (default auto)'),
      dryRun: b('Only list the cuts, change nothing'),
    }),
  },
  {
    name: 'emphasize_captions',
    description: 'Highlight key words in the captions (Hormozi style): the word gets the emphasis color and is drawn bigger, and can carry an emoji that pops up above the caption line (a color image in the export). ' +
      'Pick words by meaning: numbers and money, names, strong verbs, the payoff of a sentence; about one per line or fewer, so they stay special. ' +
      'words: [{text: "ten thousand dollars", emoji: "💰"}] marks every place that word or phrase is said (give at, timeline seconds, for just the nearest one). auto: true picks numbers and long uncommon words without you. ' +
      'Emphasized words are shown as *word* in get_timeline. auto_zoom then punches in on them.',
    input_schema: S({
      words: { type: 'array', description: 'Words or phrases to emphasize', items: { type: 'object', properties: {
        text: s('Word or phrase as spoken (case and punctuation ignored)'), at: n('Only the occurrence nearest this timeline second'),
        color: s('Hex color for this word (default: the emphasis color)'), emoji: s('One emoji shown above the line from this word on, e.g. 🔥'),
        remove: b('Remove the emphasis and emoji from this word instead'),
      }, required: ['text'] } },
      auto: b('Pick words automatically (numbers, money, long uncommon words)'),
      clear: b('Remove all emphasis first'),
      emphasisColor: s('Hex color for emphasized words (default yellow, or green when the caption style already lights words in yellow)'),
      emphasisScale: n('Size of emphasized words, 1-2 (default 1.15)'),
    }),
  },
  {
    name: 'auto_zoom',
    description: 'Zoom like a talking-head editor, in one undo step: (1) on jump cuts (the same video continuing after a cut, e.g. after remove_silences) every other clip is framed tighter, which hides the jump; ' +
      '(2) quick punch-ins on emphasis: at the times you give, else on the emphasized caption words (emphasize_captions), else on the loudest words. Running it again replaces the previous auto zoom; clear removes it. ' +
      'Scale keyframes you set yourself are kept (no punch-ins on those clips). Check with look_at_timeline.',
    input_schema: S({
      amount: n('Zoom factor 1.05-1.5 (default 1.15; 1.1 subtle, 1.3 strong)'),
      cuts: b('Frame every other jump-cut clip tighter (default true)'),
      emphasis: b('Punch in on emphasis (default true)'),
      times: { type: 'array', items: { type: 'number' }, description: 'Timeline seconds to punch in at (you pick the moments)' },
      clear: b('Remove the auto zoom'),
    }),
  },
  {
    name: 'check_reel',
    description: 'Check the reel before posting to TikTok / Reels / Shorts and list what to fix: text, captions or logos under the app buttons and bottom text (safe zones), no hook in the first 2 seconds, ' +
      'speech without captions, captions or titles too fast to read, clips that flash by, still photos without motion, music over speech without ducking, format and length. ' +
      'Each problem comes with the tool call that fixes it. Run it before export_video and fix what it finds.',
    input_schema: S({}),
  },
  {
    name: 'translate_captions',
    description: 'Put your translation of the captions (and titles) on the timeline, keeping the timing. Read the caption lines with get_timeline (detail full for long videos), translate each line by meaning, and pass them all. ' +
      'mode below (default): the translation shows smaller under the original (two languages); replace: the captions become the translation; copy: a new project (opened) with the captions and titles replaced, the original kept.',
    input_schema: S({
      lines: { type: 'array', description: 'One per caption line', items: { type: 'object', properties: { lineId: s('Caption line id (cap_...)'), text: s('Translated text of that line') }, required: ['lineId', 'text'] } },
      texts: { type: 'array', description: 'Titles to translate too', items: { type: 'object', properties: { textId: s('Text id'), text: s('Translated text') }, required: ['textId', 'text'] } },
      mode: s('below (default), replace or copy', { enum: ['below', 'replace', 'copy'] }),
      language: s('Language of the translation, e.g. English'),
    }),
  },
  {
    name: 'get_timeline_transcript',
    description: 'What is said on the timeline, in TIMELINE seconds (after cuts, speed and order), line by line: "[start-end] words". Use it to edit by text: cut_transcript removes words or sentences, remove_retakes drops repeated takes. Transcribes the clips and voice items first when needed (local Whisper).',
    input_schema: S({ from: n('Timeline seconds (default 0)'), to: n('Timeline seconds (default: end)'), transcribe: b('Transcribe what is not yet (default true)') }),
  },
  {
    name: 'cut_transcript',
    description: 'Edit by text: cut words, phrases or sentences out of the video (ripple delete, one undo step), with the pauses around them so the cut sounds natural. ' +
      'phrases: [{text: "as I said before", at: 12.5}] cuts that phrase (every place it is said, or only the one nearest at). ranges: [{start, end}] in timeline seconds cuts the words inside (snapped to whole words).',
    input_schema: S({
      phrases: { type: 'array', items: { type: 'object', properties: { text: s('Words exactly as said (case and punctuation ignored)'), at: n('Only the occurrence nearest this timeline second') }, required: ['text'] } },
      ranges: { type: 'array', items: { type: 'object', properties: { start: n('Timeline seconds'), end: n('Timeline seconds') }, required: ['start', 'end'] } },
      dryRun: b('Only list what would be cut'),
    }),
  },
  {
    name: 'remove_retakes',
    description: 'Remove bad takes: when a sentence is started, stopped and said again, keep only the last take (one undo step). Found from the transcript (the restart repeats the first words of the attempt after a pause). ' +
      'Use dryRun first and read the list: if a "retake" is really two different sentences, cut the others with cut_transcript instead.',
    input_schema: S({ dryRun: b('Only list the retakes'), minWords: n('Words that must repeat to count as a restart (default 2; 3 is safer)') }),
  },
  {
    name: 'enhance_voice',
    description: 'Studio voice on every clip with sound and every voice item (or the given ids): cleaner and clearer speech for phone or room recordings (rumble cut, light noise reduction, less boxy, more presence, softer "s", steadier level). Export only. off true removes it.',
    input_schema: S({ ids: idsSchema('Clip, overlay or audio item ids (default: all clips with sound and voice items)'), off: b('Remove the studio voice') }),
  },
  {
    name: 'stabilize_clip',
    description: 'Smooth out camera shake in a video clip (handheld, walking, vlogs). Analyses the clip (two-pass vidstab; a few seconds per minute) and zooms in slightly to hide the moving edges. After trimming the clip, run it again for the best result (it falls back to a quicker one-pass stabilizer). Export only.',
    input_schema: S({ clipId: s('Clip id'), amount: n('0.1 (light) .. 1 (very steady), default 0.5'), off: b('Remove the stabilization') }, ['clipId']),
  },
  {
    name: 'add_broll',
    description: 'Cover parts of the talking with B-roll (other videos or photos from the media library) as full-frame overlays with a fade, muted, while the voice keeps playing. ' +
      'items: [{assetId, text: "the beach"}] puts the asset where that phrase is said (or at: timeline seconds), for duration seconds (default: the phrase + 1.5s, 2-6s). auto true matches unused media by file name to the words. Look at the media with look_at_asset to pick what fits.',
    input_schema: S({
      items: { type: 'array', items: { type: 'object', properties: { assetId: s('Video or image asset'), text: s('Phrase it illustrates'), at: n('Timeline seconds (instead of text)'), duration: n('Seconds'), in: n('Source start seconds of a video') }, required: ['assetId'] } },
      auto: b('Match media to the words by file name'),
    }),
  },
  {
    name: 'match_color',
    description: 'Make clips look like a reference clip (same brightness, contrast, saturation and warmth), e.g. footage from two phones or different light. Sets set_color on each clip (shows in the preview); looks and LUTs stay.',
    input_schema: S({ referenceClipId: s('The clip that looks right'), clipIds: idsSchema('Clips to match (default: every other clip)') }, ['referenceClipId']),
  },
  {
    name: 'set_layout',
    description: 'Split screen or picture-in-picture with a second video: ' + Object.entries(LAYOUTS).map(([k, v]) => `${k} (${v})`).join('; ') + '. ' +
      'The main clip (or all clips) is cropped into its part and the second video is added as an overlay over the same time. Crops are centered: adjust with set_clip crop / set_overlay crop.',
    input_schema: S({
      preset: s('Layout', { enum: Object.keys(LAYOUTS) }), assetId: s('The second video (or photo)'), clipId: s('Only over this clip (default: the whole video)'),
      in: n('Source start seconds of the second video (default 0)'), overlayVolume: n('Volume of the second video 0-2 (default 0: muted; 1 for a two-person podcast)'),
    }, ['preset', 'assetId']),
  },
  {
    name: 'set_chapters',
    description: 'YouTube chapters: [{t (timeline seconds), title}]. Stored as chapter markers, written into the exported MP4 and as a "0:00 Title" list next to the export for the video description. A missing 0:00 gets "Intro". YouTube needs 3+ chapters of 10s+. [] removes them. Read get_timeline_transcript to find where topics change.',
    input_schema: S({ chapters: { type: 'array', items: { type: 'object', properties: { t: n('Timeline seconds'), title: s('Short chapter title') }, required: ['t', 'title'] } } }, ['chapters']),
  },
  {
    name: 'set_progress_bar',
    description: 'A thin bar along the top or bottom that fills up as the video plays (keeps people watching to the end). enabled false removes it.',
    input_schema: S({ enabled: b('false removes it'), color: s('Hex color (default white)'), height: n('Pixels 2-60 (default 10)'), position: s('top or bottom (default)', { enum: ['top', 'bottom'] }) }),
  },
  {
    name: 'search_music',
    description: 'Search free music (kind music) or sound effects (kind sfx) from Openverse (Creative Commons audio from Jamendo, Freesound and others). By default only licenses that allow commercial use and use in a video (CC0, public domain, CC BY, CC BY-SA). ' +
      'Search with mood/genre/tempo words ("upbeat corporate", "lofi chill", "epic cinematic", "whoosh", "camera shutter"). Then add_library_audio with the id. CC BY tracks need credit in the post description: exports write it next to the video.',
    input_schema: S({
      query: s('Search words'), kind: s('music (default) or sfx', { enum: ['music', 'sfx'] }),
      minDuration: n('Seconds'), maxDuration: n('Seconds'), page: n('Result page 1-10'),
      anyLicense: b('Also NonCommercial / NoDerivatives licenses (NC, ND): only for personal use, check the license'),
    }),
  },
  {
    name: 'add_library_audio',
    description: 'Download a track from search_music (by id) into the media library and put it on the timeline as music (default) or a sound effect. Same options as add_music (start, volume, fades, duck...). The credit is kept with the file.',
    input_schema: S({
      id: s('Track id from search_music'), role: s('music (default), sfx or voice', { enum: AUDIO_ROLES }), start: n('Timeline seconds (default 0)'),
      in: n('Source start seconds'), out: n('Source end seconds'), volume: n('0-2'), fadeIn: n('Seconds'), fadeOut: n('Seconds'), duck: n('0-1 lower it under speech (music default: 0.6)'), timelineOnly: b('Only add it to the media library'),
    }, ['id']),
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

  {
    name: 'reframe_clip',
    description: 'Auto reframe: keep the subject in frame when a wider source is cropped to the canvas (16:9 footage in a 9:16 reel) or a taller one into 16:9. ' +
      'First look_at_asset (grid: true) over the clip source range, note where the subject center is in each frame as x/y fractions (0 = left/top, 1 = right/bottom), then pass them as points. ' +
      'The crop window moves smoothly between points and stops at the frame edges; fit becomes cover. More points (every 0.5-1s while the subject moves) follow it closer; one point gives a fixed off-center crop. ' +
      'Points are stored in source time, so trims, splits and speed changes keep them on the footage. points: [] removes it.',
    input_schema: S({
      clipId: s('Clip id'),
      points: { type: 'array', items: { type: 'object', properties: { t: n('Timeline seconds'), source: n('Or source seconds (the times look_at_asset shows)'), x: n('Subject center x 0-1 in the source frame'), y: n('Subject center y 0-1') } }, description: 'Subject positions over time' },
      easing: s('linear (default, steady camera follow) or ease (move, then settle)', { enum: ['linear', 'ease'] }),
      zoom: n('Crop tighter than a plain cover fit, 1-4 (default 1). Lets the frame follow the subject on both axes, or punch in on a same-shape source'),
    }, ['clipId', 'points']),
  },
  {
    name: 'auto_reframe',
    description: 'Automatic reframe with a local face detector: finds the main face over each clip\'s source range and makes the crop follow it (smoothly within a shot, jumping at shot changes), then applies reframe_clip. ' +
      'Use it when horizontal footage goes into a vertical reel (or the other way). Without clipId it does every main-track clip whose shape differs from the canvas, as one undo step. ' +
      'Clips where no face is found are left as they are and reported: for those (products, animals, scenery) use reframe_clip with points you read from look_at_asset grid frames.',
    input_schema: S({
      clipId: s('Clip id (default: every clip whose shape differs from the canvas)'),
      zoom: n('Crop tighter than a plain cover fit, 1-4 (default 1); with zoom the frame also follows the face up/down'),
      smoothness: n('0.5 (follows quickly) .. 3 (very steady camera), default 1'),
    }),
  },
  { name: 'add_overlay', description: 'Put a video or image ON TOP of the main video track at a timeline time: picture-in-picture, logo/watermark, B-roll cutaway (fit cover), reaction cam. Overlays do not shift other clips.', input_schema: S({ assetId: s('Asset id'), ...overlayProps }, ['assetId']) },
  { name: 'set_overlay', description: 'Change an overlay (timing, position, size, opacity, crop, volume, blend mode, chroma key for green screen, audio noise reduction...).', input_schema: S({ overlayId: s('Overlay id'), ...overlayProps }, ['overlayId']) },
  {
    name: 'set_mask',
    description: 'Mask an overlay so only part of it shows: circle (round picture-in-picture or face cut-out), rect (with round corners), linear (split screen: keeps one side of a line, see angle), mirror (a band along a line). ' +
      'Positions and sizes are fractions of the overlay frame itself (after crop), so the mask moves and scales with it. For a split screen put the second clip as an overlay with fit cover and a linear mask. Only the fields you pass change. Preview shows an approximation.',
    input_schema: S({
      overlayId: s('Overlay id'), shape: s('Mask shape; none removes the mask', { enum: MASK_SHAPES }),
      x: n('Center x (circle/rect) or a point on the line (linear/mirror), 0-1 of the overlay (default 0.5)'), y: n('Center y / point on the line, 0-1 (default 0.5)'),
      w: n('Width 0-1 of the overlay (circle/rect, default 0.6)'), h: n('Height 0-1 (circle/rect, default 0.6); mirror: band thickness (default 0.4)'),
      angle: n('linear/mirror: tilt in degrees. 0 = horizontal line, keeps the part BELOW it; 180 keeps the part above; 90 = vertical line, keeps the LEFT part; -90 keeps the right part'),
      feather: n('Soft edge 0-1 (0 = sharp)'), round: n('rect: corner roundness 0-1'), invert: b('Show the outside instead of the inside'),
    }, ['overlayId']),
  },
  { name: 'delete_overlay', description: 'Remove an overlay.', input_schema: S({ overlayId: s('Overlay id') }, ['overlayId']) },

  { name: 'add_text', description: 'Add a text overlay/title. x,y are the center as fractions of the frame (0.5,0.5 = center; y 0.15 = top; y 0.75 = lower third; below about 0.78 the app text covers it in a vertical reel). Use style presets for quick looks.', input_schema: S(textProps, ['text', 'start', 'end']) },
  { name: 'update_text', description: 'Change any property of an existing text overlay.', input_schema: S({ textId: s('Text id'), ...textProps }, ['textId']) },
  { name: 'delete_text', description: 'Remove a text overlay.', input_schema: S({ textId: s('Text id') }, ['textId']) },
  { name: 'list_fonts', description: 'List installed font families usable in text and captions (user-imported fonts first).', input_schema: S({ search: s('Filter by name') }) },

  { name: 'transcribe_asset', description: 'Speech-to-text with word timestamps (Whisper, runs locally). Cached per file. Usually not needed directly: add_captions transcribes automatically.', input_schema: S({ assetId: s('Asset id (video with audio, or audio)'), language: s('Language code like en, vi, or auto (default)'), force: b('Re-run even if cached') }, ['assetId']) },
  { name: 'get_transcript', description: 'Read the transcript of an asset with SOURCE timestamps, to find moments by what is said, cut silences or filler words, or pick highlights.', input_schema: S({ assetId: s('Asset id'), from: n('Source seconds'), to: n('Source seconds'), words: b('One line per word with timings') }, ['assetId']) },
  { name: 'add_captions', description: 'Auto-caption the video from speech: transcribes clips (and voice audio) as needed, maps words onto the timeline and replaces existing captions. Pick a preset for the look.', input_schema: S({ ...captionStyleProps, language: s('Speech language code or auto'), sources: { type: 'array', items: { type: 'string', enum: ['clips', 'overlays', ...AUDIO_ROLES] }, description: 'What to caption (default clips, overlays, voice)' } }) },
  { name: 'update_captions', description: 'Restyle captions, or fix one line (lineId + text and/or start/end). Changing maxWords regroups all lines.', input_schema: S({ lineId: s('Caption line id (from get_timeline)'), text: s('Corrected words for that line'), start: n('Line start s'), end: n('Line end s'), ...captionStyleProps }) },
  { name: 'delete_captions', description: 'Delete one caption line (lineId) or all captions.', input_schema: S({ lineId: s('Optional line id') }) },

  { name: 'add_music', description: 'Add an audio item: music (default), sfx (sound effect) or voice (voiceover). Mixed under the clip audio. Each role gets its own track by default (music 1, voice 2, sfx 3).', input_schema: S({ assetId: s('Asset id (audio, or a video with audio)'), role: s('music, sfx or voice', { enum: AUDIO_ROLES }), track: n('Audio track 1-20'), start: n('Timeline start seconds (default 0)'), in: n('Source start s'), out: n('Source end s'), volume: n('0-2 (music default 0.6, others 1)'), fadeIn: n('Seconds'), fadeOut: n('Seconds (music default 1)'), duck: n('0-1: automatically lower this audio while someone speaks (clip audio and voice items). 0 = off, 0.6 = typical'), denoise: n('Noise reduction 0-1, for voiceovers recorded with hiss or room noise (0 = off)'), ...soundProps }, ['assetId']) },
  { name: 'update_music', description: 'Change an audio item (music, sfx or voice). duck 0-1 lowers it under speech (0 = off; export only, not in the browser preview).', input_schema: S({ musicId: s('Audio item id'), role: s('Role', { enum: AUDIO_ROLES }), track: n('Track'), start: n('s'), in: n('s'), out: n('s'), volume: n('0-2'), fadeIn: n('s'), fadeOut: n('s'), duck: n('0-1 ducking under speech, 0 = off'), denoise: n('Noise reduction 0-1, 0 = off'), ...soundProps }, ['musicId']) },
  {
    name: 'add_voiceover',
    description: 'Text to speech: speak a script and put it on the timeline as a voice item (role voice), so music with duck lowers under it and add_captions captions it. ' +
      'Engines: piper (local, free, plainer voices) and elevenlabs (much more expressive, paid per character, needs the API key the user saved in the editor). Default: the engine chosen in the editor (list_voices shows it). ' +
      'Piper picks the voice from the language of the text. With ElevenLabs eleven_v3 you can steer delivery with audio tags in the text, e.g. "[excited] We made it! [laughs]" or "[whispers] look over there". ' +
      'Write numbers and abbreviations the way they should be said. The same text, engine, voice and settings reuse the earlier audio (no new cost).',
    input_schema: S({
      text: s('What to say. Sentences get a short pause between them'), start: n('Timeline seconds (default 0)'),
      engine: s('piper or elevenlabs (default: the editor setting)', { enum: ENGINES }),
      voice: s('Piper: voice id or language code like en or vi (default: from the text). ElevenLabs: voice name or id from list_voices (default: the saved voice)'),
      expressiveness: n('0 calm and steady .. 1 lively and emotional (default: the engine\'s normal delivery)'),
      model: s('ElevenLabs model id (default: the saved model, eleven_v3)'), speed: n('0.5-2, 1 = normal (1.1 is a bit faster)'),
      speaker: s('Speaker name or number, for voices with several speakers'), pause: n('Seconds of silence between sentences (default 0.25)'),
      volume: n('0-2 (default 1)'), track: n('Audio track (default 2)'), ...soundProps,
    }, ['text']),
  },
  { name: 'list_voices', description: 'List the installed text-to-speech voices (Piper) for add_voiceover, and how to add more.', input_schema: S({}) },
  { name: 'analyze_audio', description: 'Analyse an audio or video asset: tempo (BPM) and beat times, loudness, and silences, all in SOURCE seconds. Use it to plan cuts on the beat, find quiet gaps, or pick a music section. Cached per file.', input_schema: S({ assetId: s('Asset id (or give musicId to analyse what an audio item uses)'), musicId: s('Audio item id: limits the result to the part it plays'), from: n('Source seconds'), to: n('Source seconds'), force: b('Re-run even if cached') }) },
  { name: 'mark_beats', description: 'Detect the beats of an audio item (music) and put them on the timeline as beat markers (replaces old beat markers). Then fit_clips_to_beats cuts on them, or use the times for effects/text.', input_schema: S({ musicId: s('Audio item id') }, ['musicId']) },
  { name: 'fit_clips_to_beats', description: 'Cut to the beat: trims each main-track clip\'s out point so every cut (and the end) lands on a beat marker. every = beats per clip (1 = cut on every beat, 2 = every other, 4 = once per bar). Clips whose source is too short are kept and reported. Needs beat markers (mark_beats).', input_schema: S({ every: n('Beats per clip (default 1)'), skipBeats: n('Ignore this many beat markers at the start (default 0)') }) },
  { name: 'add_markers', description: 'Add timeline markers (notes or beats) at timeline seconds.', input_schema: S({ times: { type: 'array', items: { type: 'number' }, description: 'Timeline seconds' }, kind: s('note (default), beat or chapter (set_chapters is easier for chapters)', { enum: ['note', 'beat', 'chapter'] }), label: s('Optional label'), replace: b('Remove existing markers of this kind first') }, ['times']) },
  { name: 'delete_markers', description: 'Delete markers: by ids, by kind, or all.', input_schema: S({ kind: s('Only this kind', { enum: ['note', 'beat', 'chapter'] }), markerIds: { type: 'array', items: { type: 'string' }, description: 'Marker ids' } }) },
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
      loudness: s('Loudness of the finished file in LUFS: -14 (TikTok, Reels, Shorts, YouTube), -16 (podcasts), -23 (broadcast) or off. Default from Settings (-14)', { enum: ['-14', '-16', '-23', 'off'] }),
    }),
  },
  { name: 'export_cover', description: 'Save a cover image (thumbnail) of the finished video: a full-size JPEG of the timeline frame at time t, with text and overlays, next to the exports. Returns the path and shows you the image.', input_schema: S({ t: n('Timeline seconds (default 0)'), name: s('File name without extension (default: project name + "-cover")') }) },
  { name: 'list_luts', description: 'List imported color LUTs (.cube files) usable with set_color lut. Import more with import_media.', input_schema: S({}) },
  { name: 'export_status', description: 'Check an export or other job.', input_schema: S({ jobId: s('Job id') }, ['jobId']) },
  { name: 'create_proxies', description: 'Make small preview copies (720p H.264) of video files the browser cannot play smoothly (4K, HEVC, ProRes...). Imports do this automatically; use it for older imports. Export always uses the original files.', input_schema: S({ assetIds: { type: 'array', items: { type: 'string' }, description: 'Default: every video that needs one' }, force: b('Also make proxies for videos that do not need one') }) },
];

// MCP tool annotations (not sent to the Anthropic API, which does not accept them).
const READ_ONLY = new Set(['search_music', 'check_reel', 'get_timeline_transcript', 'get_timeline', 'find_moments', 'list_voices', 'look_at_asset', 'look_at_timeline', 'list_projects', 'list_fonts', 'get_transcript', 'export_status', 'analyze_audio', 'list_styles', 'list_templates', 'list_luts']);
const DESTRUCTIVE = new Set(['delete_clip', 'delete_region', 'delete_effect', 'delete_markers', 'delete_overlay', 'delete_text', 'delete_captions', 'delete_music', 'clear_timeline', 'delete_project', 'add_captions', 'delete_style', 'delete_template', 'delete_range', 'delete_items', 'cut_transcript', 'remove_retakes']);
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
const fmtJob = (j) => `${j.kind} ${j.status} ${Math.round(j.progress * 100)}%${j.error ? ` error: ${j.error}` : ''}${j.status === 'done' && j.path ? ` file: ${j.path} (URL /exports/${j.file})` : ''}${j.width ? ` [${j.width}x${j.height} @${j.fps}fps, ${j.encoder}]` : ''}${j.loudness ? ` loudness: ${j.loudness.note}` : ''}${j.chapters ? ` chapters: ${j.chapters.length} (in the MP4)` : ''}${j.credits ? ` credits: ${j.credits.length} (put them in the post description)` : ''}${j.chapters || j.credits ? ` description text: ${path.basename(j.path).replace(/\.mp4$/i, '.description.txt')}` : ''}`;

// Speech on the timeline (clips and voice items) as timeline words. transcribe false uses cached transcripts only.
async function timelineSpeech(p, { transcribe: doIt = true, language } = {}) {
  const ids = new Set([...p.clips.filter((c) => !c.reverse && !c.freeze && (c.volume ?? 1) > 0).map((c) => c.assetId), ...p.music.filter((m) => m.role === 'voice').map((m) => m.assetId)]);
  const transcripts = {};
  let note = '';
  for (const id of ids) {
    const a = p.assets[id];
    if (!a || a.type === 'image' || (a.type === 'video' && !a.hasAudio)) continue;
    const cached = readTranscript(a);
    if (cached?.words && !doIt) { transcripts[id] = cached.words; continue; }
    if (!doIt) continue;
    try { transcripts[id] = (await transcribe(a, { language: language || 'auto' })).words; } catch (e) {
      note = `\n(${e.message === MODEL_HELP ? 'No Whisper model: speech cannot be read' : `Could not transcribe "${a.name}": ${e.message}`})`;
    }
  }
  return { words: timelineWords(p, transcripts, ['clips', 'voice']), note };
}

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
        const frames = await extractFrames(a, input.from, input.to, input.count, { grid: input.grid === true || input.grid === 'true' });
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
      case 'add_voiceover': {
        const speed = input.speed === undefined ? 1 : Number(input.speed);
        if (!(speed >= 0.5 && speed <= 2)) return { content: 'speed must be 0.5-2', isError: true };
        const pause = input.pause === undefined ? 0.25 : Number(input.pause);
        if (!(pause >= 0 && pause <= 3)) return { content: 'pause must be 0-3 seconds', isError: true };
        const ex = input.expressiveness === undefined ? undefined : Number(input.expressiveness);
        if (ex !== undefined && !(ex >= 0 && ex <= 1)) return { content: 'expressiveness must be 0-1', isError: true };
        const r = await synthesize({ engine: input.engine, text: input.text, voice: input.voice, speed, speaker: input.speaker, pause, expressiveness: ex, model: input.model });
        let a = Object.values(store.getProject().assets).find((x) => x.file === r.file);
        if (!a) {
          const meta = await probe(r.path);
          const words = String(input.text).trim().replace(/\s+/g, ' ');
          a = { id: uid('aud'), name: `voice - ${words.length > 40 ? `${words.slice(0, 40)}…` : words}`, file: r.file, ...meta, tts: { engine: r.engine, voice: r.voice.name, ...(r.model ? { model: r.model } : {}), text: String(input.text) } };
          store.addAsset(a);
        }
        const { text: _t, voice: _v, speed: _s, speaker: _k, pause: _p, engine: _e, expressiveness: _x, model: _m, ...rest } = input;
        const msg = store.apply('add_music', { ...rest, assetId: a.id, role: 'voice', start: input.start ?? 0 }, source);
        return { content: `${msg}: ${a.duration.toFixed(2)}s of speech, voice ${r.voice.name}${r.engine === 'elevenlabs' ? ` (ElevenLabs ${r.model}, ${r.chars} characters)` : ' (Piper)'}${speed !== 1 ? ` at ${speed}x` : ''}. add_captions will caption it.` };
      }
      case 'list_voices': {
        const st = ttsSettings(), vs = listVoices(), runner = piperCommand();
        const out = [`Default engine: ${st.engine} (the user changes it in the editor's 🗣 Voice panel).`, '', 'Piper (local, free):'];
        if (!runner) out.push(`- not installed. ${PIPER_HELP}`);
        else if (!vs.length) out.push(`- installed but no voices. ${PIPER_HELP}`);
        else {
          out.push(...vs.map((v) => `- ${v.id}: ${v.languageName || v.language} (${v.language}), quality ${v.quality}${v.speakers.length > 1 ? `, speakers: ${v.speakers.slice(0, 20).join(', ')}${v.speakers.length > 20 ? ', …' : ''}` : ''}`));
          out.push('  More: https://huggingface.co/rhasspy/piper-voices, "python -m piper.download_voices <id> --download-dir models/piper".');
        }
        out.push('', 'ElevenLabs (expressive, paid per character):');
        if (!st.elevenlabs.hasKey) out.push('- no API key yet: the user saves it in the 🗣 Voice panel (pick ElevenLabs) or sets ELEVENLABS_API_KEY. Never ask for the key in chat.');
        else {
          try {
            const [voices, models] = await Promise.all([elevenVoices(), elevenModels().catch(() => [])]);
            out.push(`- model ${st.elevenlabs.model} (saved default), voice ${st.elevenlabs.voice || '(first premade voice)'}`);
            if (models.length) out.push(`- models: ${models.map((m) => `${m.id} (${m.languages.length} languages${m.languages.some((l) => l.id === 'vi') ? ', Vietnamese' : ''})`).join('; ')}`);
            out.push(`- voices: ${voices.slice(0, 60).map((v) => `${v.name}${v.labels.gender ? ` (${[v.labels.gender, v.labels.accent, v.labels.age].filter(Boolean).join(', ')})` : ''}`).join('; ')}${voices.length > 60 ? '; …' : ''}`);
          } catch (e) { out.push(`- key saved but the account could not be read: ${e.message}`); }
        }
        return { content: out.join('\n') };
      }
      case 'auto_reframe': {
        const p = store.getProject(), L = layout(p);
        if (!faceModelPath()) return { content: FACE_HELP, isError: true };
        const smooth = input.smoothness === undefined ? 1 : Number(input.smoothness);
        if (!(smooth >= 0.5 && smooth <= 3)) return { content: 'smoothness must be 0.5-3', isError: true };
        const W = p.settings.width, H = p.settings.height;
        const differs = (c) => { const a = p.assets[c.assetId]; return a.width && Math.abs(a.width / a.height - W / H) > 0.02; };
        let targets = L.clips.filter((c) => p.assets[c.assetId]?.type !== 'audio');
        if (input.clipId) {
          targets = targets.filter((c) => c.id === input.clipId);
          if (!targets.length) return { content: `No clip ${input.clipId}. Clips: ${L.clips.map((c) => c.id).join(', ')}`, isError: true };
        } else targets = targets.filter((c) => differs(c) || Number(input.zoom) > 1);
        if (!targets.length) return { content: 'Every clip already has the shape of the canvas: nothing to reframe. Pass clipId with zoom (e.g. 1.5) to punch in and follow a face.', isError: true };
        const steps = [], report = [];
        for (const c of targets) {
          const a = p.assets[c.assetId];
          const from = c.in, to = a.type === 'image' || c.freeze ? c.in : Math.min(c.out, a.duration);
          const samples = await faceSamples(a, from, to);
          const cuts = a.type === 'video' ? (await sceneChanges(a)).times.filter((t) => t > from && t < to) : [];
          const track = subjectPath(samples, { cuts, smooth });
          if (!track.points.length) { report.push(`#${c.index + 1} ${c.id}: no face found, left as it was`); continue; }
          steps.push({ name: 'reframe_clip', input: { clipId: c.id, points: track.points, ...(input.zoom !== undefined ? { zoom: input.zoom } : {}) } });
          report.push(`#${c.index + 1} ${c.id}: follows the face (in ${Math.round(track.found * 100)}% of frames, ${track.points.length} points${cuts.length ? `, ${cuts.length} shot change${cuts.length > 1 ? 's' : ''}` : ''})`);
        }
        if (steps.length) store.applyBatch(steps, source);
        return { content: `Auto reframe${steps.length ? '' : ': nothing changed'}:\n${report.join('\n')}${steps.length ? '\nCheck with look_at_timeline.' : ''}` };
      }
      case 'remove_silences': {
        const p = store.getProject(), L = layout(p);
        const num = (v, d, lo, hi, name) => { const x = v === undefined ? d : Number(v); if (!(x >= lo && x <= hi)) throw new Error(`${name} must be ${lo}-${hi}`); return x; };
        const minPause = num(input.minPause, 0.6, 0.2, 5, 'minPause'), keep = num(input.keepPause, 0.15, 0, 0.5, 'keepPause');
        const talk = (c) => { const a = p.assets[c.assetId]; return a?.type === 'video' && a.hasAudio && (c.volume ?? 1) > 0 && !c.reverse && !c.freeze; };
        let clips = L.clips;
        if (input.clipId) {
          clips = clips.filter((c) => c.id === input.clipId);
          if (!clips.length) return { content: `No clip ${input.clipId}. Clips: ${L.clips.map((c) => c.id).join(', ')}`, isError: true };
          if (!talk(clips[0])) return { content: `${input.clipId} has no sound to tighten (image, muted, reversed or a freeze frame).`, isError: true };
        }
        clips = clips.filter(talk);
        if (!clips.length) return { content: 'No main-track clip with sound: nothing to tighten.', isError: true };
        const transcripts = {}, curves = {};
        for (const c of clips) {
          const a = p.assets[c.assetId];
          if (transcripts[a.id]) continue;
          try { transcripts[a.id] = (await transcribe(a, { language: input.language || 'auto' })).words; } catch (e) {
            return { content: e.message === MODEL_HELP ? MODEL_HELP : `Could not transcribe "${a.name}": ${e.message}`, isError: true };
          }
          if (!input.ignoreSound) curves[a.id] = await fineLoudness(a);
        }
        const words = timelineWords(p, transcripts, ['clips']);
        const spans = clips.map((c) => {
          const next = L.clips[c.index + 1];
          const curve = curves[c.assetId];
          return {
            lo: c.start + (c.index > 0 ? c.overlap || 0 : 0), hi: c.end - (next?.overlap || 0),
            words: words.filter((w) => (w.start + w.end) / 2 >= c.start && (w.start + w.end) / 2 <= c.end),
            level: curve ? (x, y) => peakDb(curve, srcAt(c, x - c.start), srcAt(c, y - c.start)) : null,
            quiet: curve ? (x, y, thr) => quietRuns(curve, srcAt(c, x - c.start), srcAt(c, y - c.start), thr)
              .map((q) => ({ s: c.start + localAt(c, q.s), e: c.start + localAt(c, q.e) })) : null,
          };
        });
        const r = findPauseCuts(spans, { minPause, keep, fillers: input.fillers !== false, extraFillers: Array.isArray(input.fillerWords) ? input.fillerWords : [], ignoreSound: !!input.ignoreSound });
        const total = r.cuts.reduce((x, c) => x + c.end - c.start, 0);
        const count = (k) => r.cuts.filter((c) => c.kind === k).length;
        const fill = Object.entries(r.fillers).map(([w, k]) => `${w} x${k}`).join(', ');
        const what = `${count('pause')} pause${count('pause') === 1 ? '' : 's'}, ${count('edge')} silent start/end${count('edge') === 1 ? '' : 's'} and ${count('filler')} filler${count('filler') === 1 ? '' : 's'}${fill ? ` (${fill})` : ''}`;
        const keptNote = r.keptSound ? `\nLeft ${r.keptSound} pause${r.keptSound > 1 ? 's' : ''} that have sound in them (music, or words Whisper did not write); ignoreSound true cuts them too.` : '';
        if (!r.cuts.length) return { content: `Nothing to cut: no pause longer than ${minPause}s${input.fillers !== false ? ' and no filler words' : ''}.${keptNote}` };
        const list = r.cuts.map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)}s ${c.kind}${c.fillers ? ` "${c.fillers.join(' ')}"` : ''}`);
        if (input.dryRun) return { content: `Would cut ${what}: ${total.toFixed(1)}s in all (timeline seconds now):\n${list.join('\n')}${keptNote}` };
        // Last cut first, so the earlier times stay valid.
        store.applyBatch([...r.cuts].reverse().map((c) => ({ name: 'delete_range', input: { start: c.start, end: c.end } })), source);
        const after = layout(store.getProject()).duration;
        return { content: `Removed ${what}: ${total.toFixed(1)}s shorter, ${L.duration.toFixed(1)}s -> ${after.toFixed(1)}s (one undo step). Check the jumps with look_at_timeline or play it.${keptNote}` };
      }
      case 'emphasize_captions': {
        const p = store.getProject();
        if (!p.captions?.lines?.length) return { content: 'No captions yet. Use add_captions first.', isError: true };
        const marks = [], missing = [], notes = [];
        for (const spec of Array.isArray(input.words) ? input.words : []) {
          let hits = findPhrase(p.captions.lines, spec.text);
          if (!hits.length) { missing.push(spec.text); continue; }
          if (spec.at !== undefined) hits = [hits.reduce((x, y) => (Math.abs(y.start - spec.at) < Math.abs(x.start - spec.at) ? y : x))];
          for (const hit of hits) {
            for (let i = hit.from; i <= hit.to; i++) {
              marks.push({ lineId: hit.lineId, index: i, em: spec.remove ? false : spec.color || true, ...(i === hit.to && (spec.emoji || spec.remove) ? { emoji: spec.remove ? null : spec.emoji } : {}) });
            }
          }
        }
        if (input.auto) marks.push(...pickKeywords(p.captions.lines).map((m) => ({ ...m, em: true })));
        if (!marks.length && !input.clear && input.emphasisColor === undefined && input.emphasisScale === undefined) {
          return { content: missing.length ? `Not found in the captions: ${missing.map((x) => `"${x}"`).join(', ')}. get_timeline shows the caption text.` : 'Nothing to emphasize: give words, or auto true.', isError: true };
        }
        // Color emoji are images in the export: download the ones not there yet (the preview shows them anyway).
        for (const e of new Set(marks.map((m) => m.emoji).filter(Boolean))) {
          try { await fetchEmoji(e); } catch (err) { notes.push(`Emoji ${e} could not be downloaded (${err.message}): it shows in the preview but not in the export until it can be.`); }
        }
        const msg = store.apply('emphasize_words', { marks, clear: input.clear, emphasisColor: input.emphasisColor, emphasisScale: input.emphasisScale }, source);
        return { content: `${msg}${missing.length ? ` Not found: ${missing.map((x) => `"${x}"`).join(', ')}.` : ''}${notes.length ? `\n${notes.join('\n')}` : ''}` };
      }
      case 'auto_zoom': {
        if (input.clear) return { content: store.apply('set_auto_zoom', { clear: true }, source) };
        const p = store.getProject(), L = layout(p);
        const amount = input.amount === undefined ? 1.15 : Number(input.amount);
        if (!(amount >= 1.05 && amount <= 1.5)) return { content: 'amount must be 1.05-1.5', isError: true };
        const clips = L.clips.filter((c) => p.assets[c.assetId]?.type !== 'audio');
        let times = Array.isArray(input.times) && input.times.length ? input.times.map(Number) : null, how = times ? 'the times you gave' : '';
        let loudWords = [], note = '';
        if (!times && input.emphasis !== false) {
          const em = (p.captions?.lines || []).flatMap((l) => l.words.filter((w) => w.em).map((w) => w.start));
          if (em.length) { times = em; how = 'the emphasized caption words'; } else {
            const talk = clips.filter((c) => { const a = p.assets[c.assetId]; return a.type === 'video' && a.hasAudio && (c.volume ?? 1) > 0 && !c.reverse && !c.freeze; });
            const transcripts = {}, curves = {};
            try {
              for (const c of talk) {
                const a = p.assets[c.assetId];
                if (transcripts[a.id]) continue;
                transcripts[a.id] = (await transcribe(a, {})).words;
                curves[a.id] = await fineLoudness(a);
              }
            } catch (e) { note = ` No punch-ins: ${e.message === MODEL_HELP ? 'no Whisper model to find the words' : e.message}.`; }
            if (!note) {
              for (const w of timelineWords(p, transcripts, ['clips'])) {
                const c = talk.find((x) => (w.start + w.end) / 2 >= x.start && (w.start + w.end) / 2 <= x.end);
                if (c) loudWords.push({ ...w, db: peakDb(curves[c.assetId], srcAt(c, w.start - c.start), srcAt(c, w.end - c.start)) });
              }
              how = 'the loudest words';
            }
          }
        }
        const plan = planAutoZoom(clips, { amount, cuts: input.cuts !== false, times, loudWords });
        if (!plan.clips.length) return { content: `Nothing to zoom: ${plan.jumpCuts ? '' : 'no jump cuts (the same video continuing after a cut)'}${input.emphasis === false ? '' : `${plan.jumpCuts ? '' : ' and '}no emphasis found`}.${note}` };
        const msg = store.apply('set_auto_zoom', { clips: plan.clips, amount }, source);
        return { content: `${msg}${plan.punches ? ` Punch-ins on ${how}.` : ''}${note} Check with look_at_timeline.` };
      }
      case 'check_reel': {
        const p = store.getProject(), transcripts = {};
        for (const id of new Set([...p.clips.map((c) => c.assetId), ...p.music.filter((m) => m.role === 'voice').map((m) => m.assetId)])) {
          const a = p.assets[id], t = a && readTranscript(a);
          if (t?.words) transcripts[id] = t.words;
        }
        const r = checkReel(p, { words: timelineWords(p, transcripts, ['clips', 'voice']), loudness: String(setting('export.loudness') ?? '-14') });
        const unknown = !Object.keys(transcripts).length && p.clips.some((c) => p.assets[c.assetId]?.hasAudio);
        return { content: checkText(r) + (unknown ? '\n(Speech was not checked: nothing is transcribed yet. add_captions or transcribe_asset first.)' : ''), issues: r.issues };
      }
      case 'translate_captions': {
        if (input.mode !== 'copy') return { content: store.apply('translate_captions', input, source) };
        const p = store.getProject();
        if (!(input.lines?.length || input.texts?.length)) return { content: 'Give lines [{lineId, text}] (and texts for titles) with your translation.', isError: true };
        ops.translate_captions(structuredClone(p), { ...input, mode: 'replace' }); // a bad line id fails before the copy is made
        const np = store.duplicateProject(null, `${p.name} (${input.language || 'translated'})`, source);
        const msg = store.apply('translate_captions', { ...input, mode: 'replace' }, source);
        return { content: `Made a copy ${np.id} "${np.name}" and opened it. ${msg} The original project ${p.id} is unchanged.` };
      }
      case 'get_timeline_transcript': {
        const p = store.getProject();
        const { words, note } = await timelineSpeech(p, { transcribe: input.transcribe !== false, language: input.language });
        if (!words.length) return { content: `No speech on the timeline.${note}` };
        const from = Number(input.from) || 0, to = input.to === undefined ? Infinity : Number(input.to);
        return { content: `Transcript (timeline seconds), ${words.length} words:\n${timelineTranscriptText(words, { from, to })}${note}`, words };
      }
      case 'cut_transcript': {
        const p = store.getProject();
        const { words, note } = await timelineSpeech(p, { transcribe: true });
        if (!words.length) return { content: `No speech on the timeline to cut.${note}`, isError: true };
        const cuts = [], missing = [];
        for (const ph of Array.isArray(input.phrases) ? input.phrases : []) {
          let hits = findWords(words, ph.text);
          if (!hits.length) { missing.push(ph.text); continue; }
          if (ph.at !== undefined) hits = [hits.reduce((x, y) => (Math.abs(words[y.i].start - ph.at) < Math.abs(words[x.i].start - ph.at) ? y : x))];
          for (const h of hits) cuts.push({ ...cutRange(words, h.i, h.j), text: words.slice(h.i, h.j + 1).map((w) => w.w).join(' ') });
        }
        for (const r of Array.isArray(input.ranges) ? input.ranges : []) {
          const h = wordsIn(words, Number(r.start), Number(r.end));
          if (h) cuts.push({ ...cutRange(words, h.i, h.j), text: words.slice(h.i, h.j + 1).map((w) => w.w).join(' ') });
          else missing.push(`${r.start}-${r.end}s (no words there)`);
        }
        const merged = mergeRanges(cuts);
        if (!merged.length) return { content: `Nothing to cut.${missing.length ? ` Not found: ${missing.map((x) => `"${x}"`).join(', ')}. get_timeline_transcript shows what is said.` : ''}`, isError: true };
        const list = cuts.map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)}s "${c.text}"`).join('\n');
        const total = merged.reduce((x, c) => x + c.end - c.start, 0);
        if (input.dryRun) return { content: `Would cut ${total.toFixed(1)}s:\n${list}${missing.length ? `\nNot found: ${missing.join(', ')}` : ''}` };
        store.applyBatch([...merged].reverse().map((c) => ({ name: 'delete_range', input: { start: c.start, end: c.end } })), source);
        return { content: `Cut ${cuts.length} part(s), ${total.toFixed(1)}s (one undo step):\n${list}${missing.length ? `\nNot found: ${missing.join(', ')}` : ''}` };
      }
      case 'remove_retakes': {
        const p = store.getProject();
        const { words, note } = await timelineSpeech(p, { transcribe: true });
        if (!words.length) return { content: `No speech on the timeline.${note}`, isError: true };
        const minWords = input.minWords === undefined ? 2 : Math.max(2, Math.min(6, Math.round(Number(input.minWords))));
        const takes = findRetakes(words, { minWords });
        if (!takes.length) return { content: 'No retakes found (no sentence is started and then said again).' };
        const list = takes.map((t) => `${t.start.toFixed(2)}-${t.end.toFixed(2)}s cut "${t.text}" -> keeps "${t.kept} …"`).join('\n');
        if (input.dryRun) return { content: `Found ${takes.length} retake(s):\n${list}` };
        store.applyBatch([...mergeRanges(takes)].reverse().map((c) => ({ name: 'delete_range', input: { start: c.start, end: c.end } })), source);
        return { content: `Removed ${takes.length} retake(s), kept the last take each time (one undo step):\n${list}` };
      }
      case 'enhance_voice': {
        const p = store.getProject();
        const sound = (a) => a && (a.type === 'audio' || (a.type === 'video' && a.hasAudio));
        let ids = Array.isArray(input.ids) && input.ids.length ? input.ids
          : [...p.clips.filter((c) => sound(p.assets[c.assetId])).map((c) => c.id), ...p.music.filter((m) => m.role === 'voice').map((m) => m.id)];
        const steps = [];
        for (const id of ids) {
          const on = !input.off;
          if (p.clips.some((c) => c.id === id)) steps.push({ name: 'set_clip', input: { clipId: id, enhanceVoice: on } });
          else if (p.music.some((m) => m.id === id)) steps.push({ name: 'update_music', input: { musicId: id, enhanceVoice: on } });
          else if (p.overlays.some((o) => o.id === id)) steps.push({ name: 'set_overlay', input: { overlayId: id, enhanceVoice: on } });
          else return { content: `No clip, overlay or audio item ${id}`, isError: true };
        }
        if (!steps.length) return { content: 'Nothing with sound on the timeline.', isError: true };
        store.applyBatch(steps, source);
        return { content: `${input.off ? 'Removed the studio voice from' : 'Studio voice on'} ${steps.length} item(s) (heard in the export, not in the preview).` };
      }
      case 'stabilize_clip': {
        const p = store.getProject();
        const c = p.clips.find((x) => x.id === input.clipId);
        if (!c) return { content: `No clip ${input.clipId}`, isError: true };
        if (input.off) return { content: store.apply('set_clip', { clipId: c.id, stabilize: 0 }, source) };
        const a = p.assets[c.assetId];
        if (a?.type !== 'video' || c.freeze) return { content: 'Only video clips can be stabilized', isError: true };
        const amount = input.amount === undefined ? 0.5 : Number(input.amount);
        if (!(amount >= 0.1 && amount <= 1)) return { content: 'amount must be 0.1-1', isError: true };
        const t0 = Date.now();
        await detectShake(a, c.in, c.out);
        store.apply('set_clip', { clipId: c.id, stabilize: amount }, source);
        return { content: `Stabilized ${c.id} (amount ${amount}; analysed ${(c.out - c.in).toFixed(1)}s of video in ${((Date.now() - t0) / 1000).toFixed(1)}s). It zooms in a little to hide the moving edges. Export or look_at_timeline to see it.` };
      }
      case 'add_broll': {
        const p = store.getProject(), L = layout(p);
        const { words, note } = await timelineSpeech(p, { transcribe: !!(input.auto || (input.items || []).some((x) => x.text)) });
        const items = [], missing = [];
        for (const it of Array.isArray(input.items) ? input.items : []) {
          const a = p.assets[it.assetId];
          if (!a || !['video', 'image'].includes(a.type)) { missing.push(`${it.assetId} (not a video or photo)`); continue; }
          let start = it.at !== undefined ? Number(it.at) : null, end = null;
          if (start === null && it.text) {
            const h = findWords(words, it.text)[0];
            if (!h) { missing.push(`"${it.text}" (not said)`); continue; }
            start = words[h.i].start; end = words[h.j].end + 1.5;
          }
          if (start === null) { missing.push(`${it.assetId} (give text or at)`); continue; }
          items.push({ a, start, end, duration: it.duration, in: it.in });
        }
        if (input.auto) {
          const used = new Set([...p.clips.map((c) => c.assetId), ...p.overlays.map((o) => o.assetId)]);
          const free = Object.values(p.assets).filter((a) => ['video', 'image'].includes(a.type) && !used.has(a.id) && !items.some((x) => x.a.id === a.id));
          for (const m of matchBroll(free, words)) items.push({ a: p.assets[m.assetId], start: m.start, end: null, why: m.word });
        }
        if (!items.length) return { content: `No B-roll placed.${missing.length ? ` ${missing.join('; ')}.` : ''}${input.auto ? ' auto: no unused media whose file name is said.' : ''}${note}`, isError: true };
        const steps = items.map((x) => {
          const want = x.duration !== undefined ? Number(x.duration) : x.end ? x.end - x.start : 3;
          const srcLeft = x.a.type === 'video' ? x.a.duration - (Number(x.in) || 0) : Infinity;
          const duration = Math.max(0.5, Math.min(6, Math.max(2, want), srcLeft, L.videoDuration - x.start));
          return { name: 'add_overlay', input: { assetId: x.a.id, start: Math.round(x.start * 1000) / 1000, duration: Math.round(duration * 1000) / 1000, ...(x.in !== undefined ? { in: Number(x.in) } : {}), fit: 'cover', volume: 0, animation: 'fade' } };
        }).filter((st) => st.input.start < L.videoDuration - 0.5);
        store.applyBatch(steps, source);
        return { content: `Added ${steps.length} B-roll overlay(s):\n${steps.map((st, k) => `${st.input.start.toFixed(2)}s for ${st.input.duration.toFixed(1)}s: "${p.assets[st.input.assetId].name}"${items[k]?.why ? ` (said "${items[k].why}")` : ''}`).join('\n')}${missing.length ? `\nSkipped: ${missing.join('; ')}` : ''}` };
      }
      case 'match_color': {
        const p = store.getProject();
        const ref = p.clips.find((c) => c.id === input.referenceClipId);
        if (!ref) return { content: `No clip ${input.referenceClipId}`, isError: true };
        const ids = Array.isArray(input.clipIds) && input.clipIds.length ? input.clipIds : p.clips.filter((c) => c.id !== ref.id).map((c) => c.id);
        const r = await clipStats(p.assets[ref.assetId], ref.in, ref.out);
        const steps = [], lines = [];
        for (const id of ids) {
          const c = p.clips.find((x) => x.id === id);
          if (!c) return { content: `No clip ${id}`, isError: true };
          const m = colorMatch(r, await clipStats(p.assets[c.assetId], c.in, c.out));
          steps.push({ name: 'set_color', input: { clipId: c.id, ...m } });
          lines.push(`${c.id}: brightness ${m.brightness}, contrast ${m.contrast}, saturation ${m.saturation}, temperature ${m.temperature}`);
        }
        if (!steps.length) return { content: 'No other clips to match.', isError: true };
        store.applyBatch(steps, source);
        return { content: `Matched ${steps.length} clip(s) to ${ref.id}:\n${lines.join('\n')}\nCheck with look_at_timeline; fine-tune with set_color.` };
      }
      case 'set_layout': {
        const p = store.getProject(), L = layout(p);
        const second = p.assets[input.assetId];
        if (!second || !['video', 'image'].includes(second.type)) return { content: `assetId must be a video or photo in the media library`, isError: true };
        const clips = input.clipId ? L.clips.filter((c) => c.id === input.clipId) : L.clips;
        if (!clips.length) return { content: input.clipId ? `No clip ${input.clipId}` : 'The timeline is empty.', isError: true };
        const W = p.settings.width, H = p.settings.height;
        const mainA = p.assets[clips[0].assetId];
        const plan = layoutPlan(input.preset, W, H, mainA.width / mainA.height, second.width / second.height);
        const start = clips[0].start, end = clips[clips.length - 1].end;
        const steps = [];
        if (plan.clip) for (const c of clips) {
          const a = p.assets[c.assetId], cp = layoutPlan(input.preset, W, H, a.width / a.height, second.width / second.height).clip;
          steps.push({ name: 'set_clip', input: { clipId: c.id, fit: cp.fit, crop: cp.crop || { x: 0, y: 0, w: 1, h: 1 }, x: cp.x ?? 0.5, y: cp.y ?? 0.5 } });
        }
        const srcIn = Number(input.in) || 0;
        const dur = second.type === 'video' ? Math.min(end - start, second.duration - srcIn) : end - start;
        steps.push({ name: 'add_overlay', input: { assetId: second.id, start, duration: Math.round(dur * 1000) / 1000, in: srcIn, ...plan.overlay, crop: plan.overlay.crop || undefined, volume: Number(input.overlayVolume) || 0, track: 1 } });
        if (plan.mask) steps.push({ name: 'set_mask', input: { overlayId: `$${steps.length}`, ...plan.mask } });
        store.applyBatch(steps, source);
        return { content: `Layout ${input.preset}: ${plan.clip ? `${clips.length} clip(s) placed in their part, ` : ''}"${second.name}" added from ${start.toFixed(2)}s for ${dur.toFixed(1)}s${dur < end - start - 0.1 ? ' (it is shorter than the clips)' : ''}. Check with look_at_timeline; move crops with set_clip / set_overlay crop.` };
      }
      case 'search_music': {
        const r = await searchAudio({ query: input.query, kind: input.kind === 'sfx' ? 'sfx' : 'music', commercial: !input.anyLicense, minDuration: Number(input.minDuration) || undefined, maxDuration: Number(input.maxDuration) || undefined, page: Number(input.page) || 1 });
        if (!r.tracks.length) return { content: `No ${input.kind === 'sfx' ? 'sound effects' : 'music'} found for "${input.query || ''}". Try other words (mood, genre, instrument).` };
        return { content: `${input.kind === 'sfx' ? 'Sound effects' : 'Music'} for "${input.query || ''}" (${r.total} found, ${input.anyLicense ? 'any license: check NC/ND terms' : 'commercial use and video use allowed'}):\n${r.tracks.map(trackLine).join('\n')}\nAdd one with add_library_audio {id}.`, tracks: r.tracks };
      }
      case 'add_library_audio': {
        const t = await getTrack(input.id);
        const dl = await downloadTrack(t);
        let a = Object.values(store.getProject().assets).find((x) => x.file === dl.file);
        if (!a) {
          const meta = await probe(dl.path);
          if (!meta.duration) return { content: `The downloaded file of "${t.title}" could not be read.`, isError: true };
          a = { id: uid('aud'), name: `${t.title} - ${t.creator}`.slice(0, 120), file: dl.file, ...meta, credit: { title: t.title, creator: t.creator, license: t.license, licenseName: t.licenseName, attribution: t.attribution, page: t.page, source: t.source } };
          store.addAsset(a);
        }
        const credit = a.credit.license && !['cc0', 'pdm'].includes(a.credit.license) ? ` License ${a.credit.licenseName}: put this credit in the post description: ${a.credit.attribution} (exports write it next to the video).` : ` ${a.credit.licenseName}: no credit needed.`;
        if (input.timelineOnly) return { content: `Added "${a.name}" (${a.id}, ${a.duration.toFixed(1)}s) to the media library.${credit}` };
        const role = input.role || 'music';
        const { id: _i, timelineOnly: _t, ...rest } = input;
        const msg = store.apply('add_music', { ...rest, assetId: a.id, role, ...(role === 'music' && input.duck === undefined ? { duck: 0.6 } : {}) }, source);
        return { content: `${msg}: "${t.title}" by ${t.creator} (${a.duration.toFixed(1)}s).${credit}`, assetId: a.id };
      }
      case 'find_moments': {
        const a = store.getProject().assets[input.assetId];
        if (!a) return { content: `No asset ${input.assetId}`, isError: true };
        if (a.type === 'image') return { content: `${a.id} is an image; find_moments needs a video or audio file`, isError: true };
        const minLen = Number(input.minDuration ?? 15), maxLen = Number(input.maxDuration ?? 60);
        if (!(minLen >= 1) || !(maxLen >= minLen)) return { content: 'minDuration must be >= 1 and maxDuration >= minDuration', isError: true };
        const count = Math.max(1, Math.min(30, Math.round(Number(input.count ?? 8)) || 8));
        let words = [], energy = null, note = '';
        if (a.type === 'audio' || a.hasAudio) {
          try { words = (await transcribe(a, { language: input.language || 'auto' })).words; } catch (e) {
            if (e.message !== MODEL_HELP) throw e;
            note = `\n\nNote: no whisper model, so there is no transcript and moments were cut on shot changes and loudness only. ${MODEL_HELP}`;
          }
          energy = await loudness(a);
        }
        const scenes = a.type === 'video' ? (await sceneChanges(a)).times : [];
        const list = findMoments({ words, energy, scenes, duration: a.duration },
          { minLen, maxLen, target: input.targetDuration !== undefined ? Number(input.targetDuration) : undefined, count, query: input.query });
        return { content: momentsText(a, list, { hasWords: words.length > 0 }) + note, moments: list.map(({ rank, in: i, out, duration, score, text }) => ({ rank, in: i, out, duration, score, text })) };
      }
      case 'make_short': {
        const cur = store.getProject(), a = cur.assets[input.assetId];
        if (!a) return { content: `No asset ${input.assetId}`, isError: true };
        if (a.type !== 'video') return { content: 'make_short needs a video asset', isError: true };
        const tin = Number(input.in), tout = Number(input.out);
        if (!(tin >= 0) || !(tout <= a.duration + 0.01) || !(tout - tin >= 1)) return { content: `in/out must be source seconds inside 0-${a.duration.toFixed(2)} and at least 1s apart`, isError: true };
        const capPreset = input.captions;
        let words = null, note = '';
        if (capPreset !== 'none' && a.hasAudio) {
          try { words = (await transcribe(a, { language: input.language || 'auto' })).words; } catch (e) {
            if (e.message !== MODEL_HELP) throw e;
            note = ' No captions: no whisper model installed.';
          }
        }
        // Auto reframe on the face before the project is built (detection is async; build must not be).
        let facePath = null;
        if (input.reframe !== 'center' && faceModelPath()) {
          try {
            const samples = await faceSamples(a, tin, Math.min(tout, a.duration));
            const cuts = (await sceneChanges(a)).times.filter((t) => t > tin && t < tout);
            facePath = subjectPath(samples, { cuts });
            if (!facePath.points.length) note += ' No face found, so the crop is centered.';
          } catch (e) { note += ` Auto reframe skipped: ${e.message}`; }
        }
        const fmtS = (x) => `${Math.floor(x / 60)}m${String(Math.round(x % 60)).padStart(2, '0')}`;
        const msgs = [];
        const open = input.open !== false && input.open !== 'false';
        const p = store.createProject({
          name: input.name || `${a.name.replace(/\.[^.]+$/, '')} ${fmtS(tin)}-${fmtS(tout)}`, aspect: input.aspect || '9:16', open,
          build: (np) => {
            ops.add_clip(np, { assetId: a.id, in: tin, out: Math.min(tout, a.duration) });
            const clipId = np.clips[np.clips.length - 1].id;
            if (input.styleId) msgs.push(ops.apply_style(np, { styleId: input.styleId }));
            const fit = input.fit || (input.styleId && np.style?.clips?.fit) || 'cover';
            ops.set_clip(np, { clipId, fit });
            if (fit === 'cover' && facePath?.points.length) { ops.reframe_clip(np, { clipId, points: facePath.points }); msgs.push(`The crop follows the face (found in ${Math.round(facePath.found * 100)}% of frames).`); }
            if (input.title) ops.add_text(np, { text: String(input.title), start: 0, end: Math.min(3, tout - tin) });
            if (words) {
              const tw = timelineWords(np, { [a.id]: words }, ['clips']);
              if (tw.length) msgs.push(ops.set_captions(np, { words: tw, ...(capPreset ? { preset: capPreset } : {}) }));
              else note += ' No speech in this range, so no captions.';
            }
          },
        }, source);
        const L = layout(p);
        return {
          content: `${open ? 'Created and opened' : 'Created (not opened)'} project ${p.id} "${p.name}": source ${tin}-${tout}s of "${a.name}" as a ${L.duration.toFixed(1)}s ${p.settings.aspect} short, fit ${p.clips.find((c) => c.assetId === a.id)?.fit}.` +
            `${msgs.length ? ` ${msgs.join(' ')}` : ''}${note}${open ? ' Check it with look_at_timeline.' : ''}`,
          projectId: p.id,
        };
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
          try { transcripts[id] = (await transcribe(a, { language: input.language || 'auto' })).words; } catch (e) {
            if (e.message === MODEL_HELP) return { content: MODEL_HELP, isError: true };
            skipped.push(`${a.name}: ${e.message}`);
          }
        }
        if (!Object.keys(transcripts).length && !skipped.length) return { content: 'Nothing to caption: no clip, overlay or voice item with speech audio is on the timeline.', isError: true };
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
        const loud = String(input.loudness ?? setting('export.loudness') ?? '-14');
        if (loud !== 'off' && !(Number(loud) >= -30 && Number(loud) <= -6)) return { content: 'loudness must be -14, -16, -23 (LUFS) or off', isError: true };
        let job = startExport(store.getProject(), { quality: input.quality || 'final', resolution: input.resolution, fps, bitrate, encoder: input.encoder || 'cpu', loudness: loud === 'off' ? null : Number(loud) });
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
