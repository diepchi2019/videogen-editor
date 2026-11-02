#!/usr/bin/env node
// MCP server (stdio) so Claude Code / Claude Desktop can drive a running VideoGen editor.
// It forwards every tool call to the editor's HTTP API, so the UI updates live.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.VIDEOGEN_URL || 'http://localhost:3000';

const server = new Server({ name: 'videogen-editor', version: '1.0.0' }, { capabilities: { tools: {} } });

const extra = [{
  name: 'import_media',
  description: 'Import media files from this computer into the editor library (video, image or audio). Give absolute paths.',
  inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
}];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await (await fetch(`${BASE}/api/tools`)).json();
  return { tools: [...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })), ...extra] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'import_media') {
      const form = new FormData();
      for (const p of args.paths) form.append('files', new Blob([fs.readFileSync(p)]), path.basename(p));
      const r = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: form })).json();
      if (r.error) return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Imported:\n${r.added.map((a) => `${a.id} "${a.name}" ${a.type} ${a.duration ? a.duration.toFixed(2) + 's' : ''}`).join('\n')}` }] };
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
    return { content: [{ type: 'text', text: `Cannot reach VideoGen at ${BASE}. Is the editor running (npm start)? ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
