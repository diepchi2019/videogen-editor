// Clip timing: how a main-track clip's local (output) time maps to its source, with constant speed,
// speed ramps, reverse and freeze frames. Pure; shared by the server (model.js, render.js) and the
// browser preview, which loads this file from /lib/timing.js.
//
// "Played offset" u runs from 0 to (out - in) in the order the source plays: in + u normally,
// out - u when the clip is reversed. A ramp is a list of points {at: 0..1 fraction of the played
// range, speed}; the speed changes linearly between points, so time is the exact integral of 1/speed.

export const RAMP_PRESETS = {
  montage: [[0, 1], [0.3, 1.8], [0.5, 0.5], [0.7, 1.8], [1, 1]],
  hero: [[0, 1.6], [0.4, 1.6], [0.5, 0.3], [0.6, 1.6], [1, 1.6]],
  bullet: [[0, 2], [0.35, 2], [0.45, 0.2], [0.65, 0.2], [0.75, 2], [1, 2]],
  jump_cut: [[0, 1], [0.42, 1], [0.5, 5], [0.58, 1], [1, 1]],
  flash_in: [[0, 4], [0.3, 1], [1, 1]],
  flash_out: [[0, 1], [0.7, 1], [1, 4]],
};

const EPS = 1e-9;

// Pieces of constant or linearly changing speed: {u0, u1, v0, v1, t0, t1}.
export function rampPieces(c) {
  const R = Math.max(0, c.out - c.in);
  const sp = c.freeze ? 1 : c.speed || 1;
  const pts = !c.freeze && c.ramp?.points?.length > 1 ? c.ramp.points : [{ at: 0, speed: sp }, { at: 1, speed: sp }];
  const out = [];
  let t = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const u0 = a.at * R, u1 = b.at * R, d = u1 - u0;
    if (d <= EPS) continue;
    const v0 = a.speed, v1 = b.speed;
    const dt = Math.abs(v1 - v0) < EPS ? d / v0 : (d * Math.log(v1 / v0)) / (v1 - v0);
    out.push({ u0, u1, v0, v1, t0: t, t1: t + dt });
    t += dt;
  }
  return out;
}

// Output time of played offset u inside piece pc (relative to the clip start).
export function pieceTime(pc, u) {
  const d = pc.u1 - pc.u0, k = pc.v1 - pc.v0, x = u - pc.u0;
  return pc.t0 + (Math.abs(k) < EPS ? x / pc.v0 : (d / k) * Math.log(1 + (k * x) / (d * pc.v0)));
}
// Played offset at output time lt inside piece pc.
function pieceOffset(pc, lt) {
  const d = pc.u1 - pc.u0, k = pc.v1 - pc.v0, dt = lt - pc.t0;
  return pc.u0 + (Math.abs(k) < EPS ? dt * pc.v0 : ((d * pc.v0) / k) * (Math.exp((k * dt) / d) - 1));
}

// Length of the clip on the timeline.
export function clipLength(c) {
  const ps = rampPieces(c);
  return ps.length ? ps[ps.length - 1].t1 : 0;
}

const pieceAtTime = (ps, lt) => ps.find((pc) => lt <= pc.t1) || ps[ps.length - 1];

// Played offset u at clip-local time lt.
export function playedAt(c, lt) {
  const ps = rampPieces(c);
  if (!ps.length) return 0;
  const t = Math.min(Math.max(0, lt), ps[ps.length - 1].t1);
  return Math.min(c.out - c.in, Math.max(0, pieceOffset(pieceAtTime(ps, t), t)));
}

// Source seconds shown at clip-local time lt.
export function srcAt(c, lt) {
  if (c.freeze) return c.in;
  const u = playedAt(c, lt);
  return c.reverse ? c.out - u : c.in + u;
}

// Clip-local time at which source second src plays (clamped to the clip).
export function localAt(c, src) {
  if (c.freeze) return 0;
  const ps = rampPieces(c);
  if (!ps.length) return 0;
  const R = c.out - c.in;
  const u = Math.min(R, Math.max(0, c.reverse ? c.out - src : src - c.in));
  return pieceTime(ps.find((pc) => u <= pc.u1) || ps[ps.length - 1], u);
}

// Playback speed at clip-local time lt (0 for a freeze frame).
export function speedAt(c, lt) {
  if (c.freeze) return 0;
  const ps = rampPieces(c);
  if (!ps.length) return c.speed || 1;
  const pc = pieceAtTime(ps, Math.max(0, lt));
  const u = playedAt(c, lt);
  return pc.v0 + ((pc.v1 - pc.v0) * (u - pc.u0)) / Math.max(EPS, pc.u1 - pc.u0);
}

// Average source seconds per output second: constant for a clip whatever its trim, because ramp
// points are fractions of the played range. Used to turn a wanted length into an out point.
export function avgRate(c) {
  const len = clipLength(c);
  return c.freeze || len <= 0 ? 1 : (c.out - c.in) / len;
}

// Ramp points (fractions) of the part of a clip between played offsets ua..ub, rescaled to 0..1.
export function subRamp(c, ua, ub) {
  if (!c.ramp?.points?.length) return undefined;
  const R = c.out - c.in;
  const pts = c.ramp.points;
  const at = (u) => {
    const f = u / R;
    for (let i = 1; i < pts.length; i++) {
      if (f <= pts[i].at + EPS) {
        const a = pts[i - 1], b = pts[i];
        return a.speed + ((b.speed - a.speed) * (f - a.at)) / Math.max(EPS, b.at - a.at);
      }
    }
    return pts[pts.length - 1].speed;
  };
  const span = ub - ua;
  const inner = pts.filter((q) => q.at * R > ua + EPS && q.at * R < ub - EPS).map((q) => ({ at: (q.at * R - ua) / span, speed: q.speed }));
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  return [{ at: 0, speed: at(ua) }, ...inner, { at: 1, speed: at(ub) }].map((q) => ({ at: r4(q.at), speed: r4(q.speed) }));
}
