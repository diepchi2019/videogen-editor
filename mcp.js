#!/usr/bin/env node
// MCP server (stdio) so Claude Code / Claude Desktop can drive a running VideoGen editor.
// It forwards every tool call to the editor's HTTP API, so the UI updates live.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.VIDEOGEN_URL || 'http://localhost:3000';
const DOWN = (e) => `Cannot reach VideoGen at ${BASE}. Is the editor running (npm start)? ${e.message}`;

const server = new Server({ name: 'videogen-editor', version: '1.1.0' }, { capabilities: { tools: {}, resources: {} } });

const extra = [{
  name: 'import_media',
  description: 'Import files from this computer into the editor: video, image or audio go to the media library; .ttf/.otf fonts become usable in text and captions. Give absolute paths.',
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

await server.connect(new StdioServerTransport());
