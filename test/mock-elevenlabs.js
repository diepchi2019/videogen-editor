// Tiny fake ElevenLabs API for testing the ElevenLabs text-to-speech engine without a key or cost.
// Accepts any key starting with "test-"; returns a tone whose length follows the text (0.06s per character).
// Run alone with MOCK_EL_PORT (default 3201), or import startMockElevenLabs() from a test.
// GET /mock/requests lists the text-to-speech calls it got (to check bodies and caching).
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function startMockElevenLabs(port = Number(process.env.MOCK_EL_PORT || 3201)) {
  const calls = [];
  const send = (res, code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/mock/requests') return send(res, 200, calls);
      if (!String(req.headers['xi-api-key'] || '').startsWith('test-')) return send(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      if (req.method === 'GET' && req.url === '/v1/voices') {
        return send(res, 200, { voices: [
          { voice_id: 'vRachel01', name: 'Rachel', category: 'premade', labels: { gender: 'female', accent: 'american', age: 'young' } },
          { voice_id: 'vMinh0002', name: 'Minh', category: 'cloned', labels: { gender: 'male', accent: 'vietnamese' } },
        ] });
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(res, 200, [
          { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, languages: [{ language_id: 'en', name: 'English' }, { language_id: 'vi', name: 'Vietnamese' }] },
          { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, languages: [{ language_id: 'en', name: 'English' }] },
          { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false, languages: [] },
        ]);
      }
      const m = /^\/v1\/text-to-speech\/([^/?]+)/.exec(req.url);
      if (req.method === 'POST' && m) {
        const j = JSON.parse(body || '{}');
        if (!['vRachel01', 'vMinh0002'].includes(m[1])) return send(res, 404, { detail: { message: 'voice_not_found' } });
        calls.push({ voice: m[1], query: req.url.split('?')[1] || '', body: j });
        const dur = Math.max(0.5, String(j.text).length * 0.06).toFixed(2);
        const mp3 = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${dur}`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', '-']);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(mp3);
      }
      send(res, 404, { detail: { message: `mock: no route ${req.method} ${req.url}` } });
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port, calls })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startMockElevenLabs().then(({ port }) => console.log(`mock elevenlabs on ${port}`));
