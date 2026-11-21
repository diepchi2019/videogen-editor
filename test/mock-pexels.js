// Tiny fake Pexels API for testing stock media without a key or the network. Keys starting "test-" work.
// GET /videos/search, /v1/search, /videos/videos/<id>, /v1/photos/<id>; files under /files/. GET /mock/requests lists calls.
// Run alone with MOCK_PX_PORT (default 3203), or import startMockPexels() from a test.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function startMockPexels(port = Number(process.env.MOCK_PX_PORT || 3203)) {
  const calls = [];
  const base = `http://localhost:${port}`;
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 1 << 28 });
  const files = {
    'wave-hd.mp4': ff(['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=25:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', '-']),
    'wave-sd.mp4': ff(['-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=25:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', '-']),
    'photo.jpg': ff(['-f', 'lavfi', '-i', 'color=c=0x2266cc:s=1080x1920', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-']),
    'thumb.jpg': ff(['-f', 'lavfi', '-i', 'color=c=0x2266cc:s=160x284', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-']),
  };
  const video = {
    id: 4242, width: 1080, height: 1920, duration: 3, url: 'https://www.pexels.com/video/ocean-waves-4242/', image: `${base}/files/thumb.jpg`, user: { name: 'Mock Filmer', url: 'https://www.pexels.com/@mock' },
    video_files: [
      { id: 1, quality: 'sd', file_type: 'video/mp4', width: 540, height: 960, link: `${base}/files/wave-sd.mp4` },
      { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, link: `${base}/files/wave-hd.mp4` },
    ],
  };
  const photo = { id: 777, width: 1080, height: 1920, url: 'https://www.pexels.com/photo/blue-777/', photographer: 'Mock Shooter', alt: 'Blue sky', src: { original: `${base}/files/photo.jpg`, tiny: `${base}/files/thumb.jpg` } };
  const send = (res, code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === '/mock/requests') return send(res, 200, calls);
    const f = /^\/files\/(.+)$/.exec(u.pathname);
    if (f && files[f[1]]) { calls.push({ path: u.pathname }); res.writeHead(200, { 'content-type': f[1].endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' }); return res.end(files[f[1]]); }
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers.authorization });
    if (!String(req.headers.authorization || '').startsWith('test-')) return send(res, 401, { error: 'Unauthorized' });
    if (u.pathname === '/videos/search') return send(res, 200, { total_results: 1, page: 1, per_page: 15, videos: [video] });
    if (u.pathname === '/v1/search') return send(res, 200, { total_results: 1, page: 1, per_page: 15, photos: [photo] });
    if (u.pathname === '/videos/videos/4242') return send(res, 200, video);
    if (u.pathname === '/v1/photos/777') return send(res, 200, photo);
    send(res, 404, { error: 'Not found' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ port, close: () => server.close(), calls })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await startMockPexels();
  console.log(`Mock Pexels on http://localhost:${m.port}`);
}
