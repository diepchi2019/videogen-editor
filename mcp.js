#!/usr/bin/env node
// MCP server (stdio) so Claude Code / Claude Desktop can drive a running VideoGen editor.
// It forwards every tool call to the editor's HTTP API, so the UI updates live.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.VIDEOGEN_URL || 'http://localhost:3000';
const DOWN = (e) => `Cannot reach VideoGen at ${BASE}. Is the editor running (npm start)? ${e.message}`;

const server = new Server({ name: 'videogen-editor', version: '1.1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });

const extra = [{
  name: 'import_media',
  description: 'Import files from this computer into the editor: video, image or audio go to the media library; .ttf/.otf fonts become usable in text and captions; .cube color LUTs become usable with set_color lut. Give absolute paths.',
  inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await (await fetch(`${BASE}/api/tools`)).json();
  return { tools: [...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: t.annotations })), ...extra] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'import_media') {
      const missing = (args.paths || []).filter((p) => !fs.existsSync(p));
      if (missing.length) return { content: [{ type: 'text', text: `Error: file not found: ${missing.join(', ')}` }], isError: true };
      const form = new FormData();
      for (const p of args.paths) form.append('files', new Blob([fs.readFileSync(p)]), path.basename(p));
      const r = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: form })).json();
      if (r.error) return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
      const lines = r.added.map((a) => `${a.id} "${a.name}" ${a.type} ${a.duration ? a.duration.toFixed(2) + 's' : ''}`);
      if (r.fonts?.length) lines.push(...r.fonts.map((f) => `font "${f}"`));
      if (r.luts?.length) lines.push(...r.luts.map((f) => `LUT ${f}`));
      return { content: [{ type: 'text', text: `Imported:\n${lines.join('\n')}` }] };
    }
    const res = await fetch(`${BASE}/api/tool/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-source': 'mcp' }, body: JSON.stringify(args),
    });
    const r = await res.json();
    if (r.error) return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
    const content = typeof r.content === 'string'
      ? [{ type: 'text', text: r.content }]
      : r.content.map((b) => b.type === 'image' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : b);
    return { content, isError: !!r.isError };
  } catch (e) {
    return { content: [{ type: 'text', text: DOWN(e) }], isError: true };
  }
});

// Resources: read the open project without a tool call.
const RESOURCES = [
  { uri: 'videogen://project/timeline', name: 'Timeline summary', description: 'Text summary of the open project (same as get_timeline)', mimeType: 'text/plain' },
  { uri: 'videogen://project/json', name: 'Project JSON', description: 'Full project data of the open project, with computed clip positions', mimeType: 'application/json' },
];
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  if (uri === 'videogen://project/timeline') {
    const r = await (await fetch(`${BASE}/api/tool/get_timeline`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-source': 'mcp' }, body: JSON.stringify({ detail: 'full' }) })).json();
    return { contents: [{ uri, mimeType: 'text/plain', text: r.content }] };
  }
  if (uri === 'videogen://project/json') {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ project: s.project, layout: s.layout }, null, 2) }] };
  }
  throw new Error(`Unknown resource ${uri}`);
});

// Prompts: ready-made editing requests (shown as slash commands in Claude Code).
const PROMPTS = [
  {
    name: 'make_reel', description: 'Make a short reel from the clips in the media library, in a saved or built-in style',
    arguments: [{ name: 'style', description: 'Style name (default: ask list_styles and pick the best fit)' }, { name: 'length', description: 'Target length in seconds (default 30)' }, { name: 'brief', description: 'What the reel is about' }],
    text: (a) => `Make a ${a.length || 30}s vertical reel in VideoGen from the media library${a.brief ? ` about: ${a.brief}` : ''}.
1. get_timeline, then look_at_asset on the videos to find the best moments.
2. ${a.style ? `apply_style "${a.style}" first` : 'list_styles and apply_style the one that fits best'} so new clips, titles, captions and music follow it.
3. Build the edit with batch_edit: strongest moment first, punchy cuts, a title in the first 2 seconds. If there is music, mark_beats and fit_clips_to_beats.
4. If anyone speaks: remove_retakes, remove_silences (tightens the pauses and drops um/uh), enhance_voice, add_captions, emphasize_captions on the few words that carry the message (an emoji on one or two), then auto_zoom.
5. check_reel and fix what it finds, look_at_timeline to check framing and text, then export_video with quality draft and wait true. Report the file path.`,
  },
  {
    name: 'reel_from_template', description: 'Make a new reel by filling a saved template with clips from the media library',
    arguments: [{ name: 'template', description: 'Template name', required: true }, { name: 'brief', description: 'What the new reel is about (for picking clips and texts)' }],
    text: (a) => `Make a new reel from the VideoGen template "${a.template}"${a.brief ? ` about: ${a.brief}` : ''}.
1. list_templates to see its slots (length of each) and texts, and get_timeline for the media library.
2. look_at_asset on candidate clips; pick one clip per slot that suits the slot's length and position, with a good start time (slots[].in).
3. create_from_template with those slots and new texts that fit the brief.
4. look_at_timeline to check, adjust with the editing tools, then export_video with quality draft and wait true.`,
  },
  {
    name: 'save_my_style', description: 'Save the look of the open project as a reusable style',
    arguments: [{ name: 'name', description: 'Style name', required: true }],
    text: (a) => `Save the look of the open VideoGen project as the style "${a.name}". get_timeline first; if a clip is clearly an intro or outro, or an overlay is a logo, pass introClipId / outroClipId / logoOverlayId. Then call save_style and tell me what it captured.`,
  },
  {
    name: 'reframe_to_vertical', description: 'Reframe horizontal clips for a vertical reel so the subject stays in frame',
    arguments: [{ name: 'aspect', description: 'Target canvas, default 9:16' }, { name: 'subject', description: 'Who or what to follow (default: the main subject of each shot)' }],
    text: (a) => `Reframe the open VideoGen project for ${a.aspect || '9:16'}${a.subject ? `, following ${a.subject}` : ''}.
1. get_timeline. If the canvas is not ${a.aspect || '9:16'}, set_canvas aspect ${a.aspect || '9:16'}.
2. auto_reframe (no clipId) follows faces automatically${a.subject ? `; if ${a.subject} is not a person's face, skip it for the clips where it would follow the wrong thing` : ''}. For clips it reports without a face (or where the subject is not a face): look_at_asset with grid true over the clip's source in-out range (about one frame per second, up to 12), and read the subject's center as x (and y) fractions of the frame from the grid lines (every 10%, yellow at the middle).
3. reframe_clip with those points in source seconds (points[].source). Use more points while the subject moves fast, fewer when it is still; if the subject stays put, one point is enough.
4. look_at_timeline at a few times per clip to check the subject is in frame, adjust points that miss, then tell me what you changed.`,
  },
  {
    name: 'edit_talking_video', description: 'Full talking-head edit: bad takes, pauses, studio voice, captions with key words, zooms, B-roll, chapters, check',
    arguments: [{ name: 'style', description: 'Caption preset (classic, karaoke, highlight, single, boxed)' }, { name: 'chapters', description: 'yes to add YouTube chapters' }],
    text: (a) => `Edit the talking video in the open VideoGen project like a pro editor.
1. get_timeline_transcript. remove_retakes with dryRun true; check each one is really the same sentence said again, then remove_retakes (or cut_transcript the real ones).
2. Read the transcript again and cut_transcript anything off-topic, false starts the tool missed, or "as I said" repeats. Then remove_silences.
3. enhance_voice. If the camera shakes, stabilize_clip. If clips look different, match_color to the best-looking clip.
4. add_captions${a.style ? ` with preset ${a.style}` : ''}, emphasize_captions on the few words that carry the message (an emoji on one or two), then auto_zoom.
5. B-roll where it illustrates what is said: media from the library with add_broll (look_at_asset first), or search_stock + add_stock as broll for what is missing.
6. A hook title in the first 2 seconds: add_text with style hook.${a.chapters === 'yes' ? ' set_chapters where the topic changes.' : ''}
7. check_reel and fix what it finds, look_at_timeline at a few times, then export_video with quality draft and wait true. Tell me what you changed.`,
  },
  {
    name: 'hook_and_chapters', description: 'Write a hook title for the first seconds and YouTube chapters from what is said',
    arguments: [],
    text: () => `For the open VideoGen project: get_timeline_transcript, then
1. Write a short hook (max 7 words) that makes people stay: the promise or the surprising bit of the video. add_text with style hook from 0 to 2.5s.
2. Find where the topic changes and set_chapters with short titles (first at 0:00, 3 or more, each 10s or longer if the video allows).
3. Tell me the hook and the chapter list (it is also written next to the export for the YouTube description).`,
  },
  {
    name: 'translate_reel', description: 'Translate the captions (and titles) of the open project into another language, keeping the timing',
    arguments: [{ name: 'language', description: 'Target language, e.g. English or Vietnamese', required: true }, { name: 'mode', description: 'below (two languages, default), replace, or copy (a new project)' }],
    text: (a) => `Translate the captions and titles of the open VideoGen project into ${a.language}.
1. get_timeline with detail full to read every caption line (ids cap_...) and the texts.
2. Translate each line by meaning, short enough to read in the line's time; keep names, numbers and emoji. Titles too.
3. translate_captions with mode ${a.mode || 'below'}, language "${a.language}", all lines and texts in one call.
4. check_reel (two caption lines take more room: fix any safe-zone warning), then look_at_timeline at a few caption times and tell me what you did.`,
  },
  {
    name: 'shorts_from_video', description: 'Cut a long video or podcast into several vertical shorts, one project each',
    arguments: [{ name: 'count', description: 'How many shorts (default 3)' }, { name: 'length', description: 'Length range in seconds, e.g. 20-45 (default 15-60)' },
      { name: 'topic', description: 'What the shorts should be about (optional)' }, { name: 'style', description: 'Reel style to apply (optional)' }],
    text: (a) => {
      const [mn, mx] = String(a.length || '15-60').split(/[-–]/).map(Number);
      return `Make ${a.count || 3} vertical shorts from the long video in the open VideoGen project${a.topic ? `, about: ${a.topic}` : ''}.
1. get_timeline to find the long video asset (ask me if there are several).
2. find_moments on it with minDuration ${mn || 15}, maxDuration ${mx || 60}, count ${Math.max(8, 2 * (Number(a.count) || 3))}${a.topic ? `, query "${a.topic}"` : ''}.
3. Read the excerpts and pick the ${a.count || 3} best that stand alone: a hook in the first seconds, one complete thought, a payoff at the end. Use get_transcript to move in/out to a better sentence if needed.
4. For each pick: make_short with a short punchy title${a.style ? ` and styleId "${a.style}"` : ''}, open false except for the last one.
5. make_short follows the speaker's face automatically. In each short, remove_silences tightens the pauses (open_project first for the ones not open; captions move with the cuts). For the open short: look_at_timeline; if the framing is wrong (no face found, or the wrong person), auto_reframe with a different smoothness or reframe_clip with points read from look_at_asset grid frames. Do the same for the others with open_project.
6. Tell me the project names, their source ranges and why you picked each.`;
    },
  },
];
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(({ text, ...p }) => p) }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = PROMPTS.find((x) => x.name === req.params.name);
  if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(req.params.arguments || {}) } }] };
});

await server.connect(new StdioServerTransport());
