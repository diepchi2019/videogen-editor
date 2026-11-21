// Split-screen and picture-in-picture layouts, built from the existing pieces: the main clip is cropped to its
// half and placed with fit contain + position; the second video is a free-fit overlay cropped the same way.
// Pure (unit-tested); set_layout in tools.js applies the plan as one batch.
export const LAYOUTS = {
  top_bottom: 'Main video on top, the second one below (vertical reels: reactions, gameplay + face, two angles)',
  side_by_side: 'Main video left, the second one right (horizontal videos, comparisons, interviews)',
  pip_circle: 'Second video in a small circle in the top right corner (face cam over a screen recording or gameplay)',
  pip_box: 'Second video in a small rounded box in the top right corner',
};
const r3 = (n) => Math.round(n * 1000) / 1000;

// Centered crop (fractions) that turns a source of aspect `src` (w/h) into aspect `want`.
export function cropTo(src, want) {
  if (Math.abs(src - want) < 0.01) return null;
  if (src > want) { const w = r3(want / src); return { x: r3((1 - w) / 2), y: 0, w, h: 1 }; }
  const h = r3(src / want);
  return { x: 0, y: r3((1 - h) / 2), w: 1, h };
}

// W, H: canvas; main, second: aspect (w/h) of the two sources.
// Returns { clip: {fit, crop, x?, y?} | null, overlay: {fit, crop, x, y, scale}, mask?: {...} }.
export function layoutPlan(preset, W, H, main, second) {
  if (preset === 'top_bottom') {
    const half = W / (H / 2);
    return { clip: { fit: 'contain', crop: cropTo(main, half), y: 0.25 }, overlay: { fit: 'free', crop: cropTo(second, half), x: 0.5, y: 0.75, scale: 1 } };
  }
  if (preset === 'side_by_side') {
    const half = W / 2 / H;
    return { clip: { fit: 'contain', crop: cropTo(main, half), x: 0.25 }, overlay: { fit: 'free', crop: cropTo(second, half), x: 0.75, y: 0.5, scale: 0.5 } };
  }
  const vertical = H > W;
  const scale = vertical ? 0.36 : 0.22;
  if (preset === 'pip_circle') {
    const s = scale * W, y = 0.04 + s / H / 2 + (vertical ? 0.08 : 0); // below the top bar of the apps
    return { clip: null, overlay: { fit: 'free', crop: cropTo(second, 1), x: r3(1 - 0.04 - scale / 2 - (vertical ? 0.1 : 0)), y: r3(y), scale }, mask: { shape: 'circle', w: 1, h: 1, feather: 0.02 } };
  }
  if (preset === 'pip_box') {
    const s = scale * W, h = s / second, y = 0.04 + h / H / 2 + (vertical ? 0.08 : 0);
    return { clip: null, overlay: { fit: 'free', crop: null, x: r3(1 - 0.04 - scale / 2 - (vertical ? 0.1 : 0)), y: r3(y), scale }, mask: { shape: 'rect', w: 1, h: 1, round: 0.12, feather: 0.01 } };
  }
  throw new Error(`preset must be one of: ${Object.keys(LAYOUTS).join(', ')}`);
}
