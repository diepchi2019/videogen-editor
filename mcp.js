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
4. add_captions if anyone speaks.
5. look_at_timeline to check framing and text, fix problems, then export_video with quality draft and wait true. Report the file path.`,
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
];
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(({ text, ...p }) => p) }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = PROMPTS.find((x) => x.name === req.params.name);
  if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(req.params.arguments || {}) } }] };
});

await server.connect(new StdioServerTransport());
