// Tiny fake Openverse API for testing the music library without the network.
// GET /v1/audio/?q=... -> results (a CC BY song and a CC0 sound effect); GET /v1/audio/<id>/ -> one result;
// GET /files/<name>.mp3 -> a real short MP3 tone. GET /mock/requests lists the calls it got.
// Run alone with MOCK_OV_PORT (default 3202), or import startMockOpenverse() from a test.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SONG = '11111111-2222-3333-4444-555555555555', SFX = '66666666-7777-8888-9999-000000000000';

export function startMockOpenverse(port = Number(process.env.MOCK_OV_PORT || 3202)) {
  const calls = [];
  const mp3 = (secs, freq) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', '-']);
  const files = { 'song.mp3': mp3(8, 330), 'whoosh.mp3': mp3(0.6, 880) };
  const base = `http://localhost:${port}`;
  const results = [
    { id: SONG, title: 'Sunny Test Song', creator: 'Mock Artist', url: `${base}/files/song.mp3`, filetype: 'mp3', duration: 8000, license: 'by', license_version: '3.0', license_url: 'https://creativecommons.org/licenses/by/3.0/', category: 'music', source: 'jamendo', provider: 'jamendo',
      attribution: '"Sunny Test Song" by Mock Artist is licensed under CC BY 3.0.', foreign_landing_url: 'https://example.org/track/1', tags: [{ name: 'upbeat' }, { name: 'happy' }] },
    { id: SFX, title: 'Test Whoosh', creator: 'Mock Foley', url: `${base}/files/whoosh.mp3`, filetype: 'mp3', duration: 600, license: 'cc0', license_version: '1.0', source: 'freesound', provider: 'freesound',
      attribution: '"Test Whoosh" by Mock Foley is marked with CC0 1.0.', foreign_landing_url: 'https://example.org/sound/2', tags: [{ name: 'whoosh' }] },
  ];
  const send = (res, code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === '/mock/requests') return send(res, 200, calls);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), ua: req.headers['user-agent'] });
    const f = /^\/files\/(.+)$/.exec(u.pathname);
    if (f && files[f[1]]) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(files[f[1]]); }
    const one = /^\/v1\/audio\/([0-9a-f-]{36})\/$/.exec(u.pathname);
    if (one) { const r = results.find((x) => x.id === one[1]); return r ? send(res, 200, r) : send(res, 404, { detail: 'Not found.' }); }
    if (u.pathname === '/v1/audio/') {
      const sfx = u.searchParams.get('source') === 'freesound';
      const list = results.filter((r) => (sfx ? r.source === 'freesound' : r.category === 'music'));
      return send(res, 200, { result_count: list.length, page_count: 1, page_size: 20, page: 1, results: list });
    }
    send(res, 404, { detail: 'Not found.' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ port, close: () => server.close(), calls })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await startMockOpenverse();
  console.log(`Mock Openverse on http://localhost:${m.port}`);
}
