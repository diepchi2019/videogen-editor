// VideoGen editor server: REST API + static UI + live updates (SSE).
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import * as store from './src/store.js';
import { layout, uid } from './src/model.js';
import { probe, makeThumb } from './src/media.js';
import { TOOLS, executeTool } from './src/tools.js';
import { chat, resetChat } from './src/chat.js';
import { getJob, listJobs } from './src/render.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.resolve('public')));
app.use('/media', express.static(store.MEDIA_DIR));
app.use('/thumbs', express.static(path.join(store.DATA_DIR, 'thumbs')));
app.use('/exports', express.static(store.EXPORT_DIR));

const state = () => ({ ...store.withLayout(), jobs: listJobs() });
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(400).json({ error: e.message }); }
};

// Live updates so edits made by Claude (chat or MCP) show up in the UI instantly.
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
const broadcast = (type, data) => { for (const c of clients) c.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
store.onChange((p, source) => broadcast('project', { project: p, layout: layout(p), source }));
setInterval(() => { if (listJobs().some((j) => j.status === 'running' || Date.now() - (j.finishedAt || 0) < 3000)) broadcast('jobs', listJobs()); }, 700);

app.get('/api/state', wrap(state));

const upload = multer({
  storage: multer.diskStorage({
    destination: store.MEDIA_DIR,
    filename: (req, f, cb) => cb(null, `${uid('f')}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 4 * 1024 ** 3 },
});
app.post('/api/upload', upload.array('files'), wrap(async (req) => {
  const added = [];
  for (const f of req.files || []) {
    try {
      const meta = await probe(f.path);
      const a = { id: uid(meta.type === 'audio' ? 'aud' : meta.type === 'image' ? 'img' : 'vid'), name: Buffer.from(f.originalname, 'latin1').toString('utf8'), file: f.filename, ...meta };
      a.thumb = await makeThumb(a).catch(() => null);
      store.addAsset(a);
      added.push(a);
    } catch (e) {
      fs.rmSync(f.path, { force: true });
      throw new Error(`${f.originalname}: ${e.message}`);
    }
  }
  return { added, ...state() };
}));

// Run one editor tool (used by the UI and by the MCP server).
app.get('/api/tools', (req, res) => res.json(TOOLS));
app.post('/api/tool/:name', wrap(async (req) => {
  const r = await executeTool(req.params.name, req.body || {}, req.get('x-source') || 'ui');
  return { ...r, ...state() };
}));

app.post('/api/chat', wrap(async (req) => {
  const r = await chat(String(req.body.message || ''), { onEvent: (e) => broadcast('chat-action', e) });
  return { ...r, ...state() };
}));
app.post('/api/chat/reset', wrap(() => { resetChat(); return { ok: true }; }));
app.get('/api/jobs/:id', wrap((req) => getJob(req.params.id) || { error: 'not found' }));

app.listen(PORT, () => console.log(`VideoGen editor running at http://localhost:${PORT}`));
