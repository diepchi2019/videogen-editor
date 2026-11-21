// Stabilization: vidstabdetect (pass 1) writes the camera motion of a clip's exact source range to a .trf file;
// render runs vidstabtransform (pass 2) with it. Without the file (e.g. after a trim) render falls back to
// the one-pass deshake filter, so a stabilized clip never fails to export.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ANALYSIS_DIR, MEDIA_DIR } from './store.js';

const ms = (s) => Math.round(s * 1000);
export const stabName = (a, from, to) => `${a.file}.stab-${ms(from)}-${ms(to)}.trf`;
export function stabFile(a, c) {
  const f = path.join(ANALYSIS_DIR, stabName(a, c.in, c.out));
  return fs.existsSync(f) ? f : null;
}
// Pass 1 over source seconds from..to. Runs in ANALYSIS_DIR so the result option is a plain file name
// (Windows paths with a drive colon are awkward inside filter options).
export function detectShake(a, from, to) {
  const name = stabName(a, from, to);
  if (fs.existsSync(path.join(ANALYSIS_DIR, name))) return Promise.resolve(path.join(ANALYSIS_DIR, name));
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const tmp = `${name}.part`;
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-ss', String(from), '-t', String(to - from), '-i', path.join(MEDIA_DIR, a.file),
      '-an', '-vf', `vidstabdetect=shakiness=6:accuracy=12:result=${tmp}`, '-f', 'null', '-'], { cwd: ANALYSIS_DIR, maxBuffer: 1 << 24 }, (err, _o, stderr) => {
      if (err) return reject(new Error(`Stabilize analysis failed: ${String(stderr).split('\n').filter(Boolean).slice(-3).join(' ')}`));
      fs.renameSync(path.join(ANALYSIS_DIR, tmp), path.join(ANALYSIS_DIR, name));
      resolve(path.join(ANALYSIS_DIR, name));
    });
  });
}
