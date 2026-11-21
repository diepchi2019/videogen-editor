// Builds one ASS subtitle file for every text overlay and caption line.
// PlayRes = project canvas size, so positions and sizes are in canvas pixels and
// libass scales them to the render size (draft or final).

// ASS colors are &HAABBGGRR& with AA = transparency (00 opaque, FF invisible).
export function assColor(hex = '#ffffff') {
  const h = String(hex).replace('#', '').padStart(6, '0');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
export const assAlpha = (opacity) => `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0').toUpperCase()}&`;

export function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// User text -> ASS dialogue text. "\n" (typed by Claude) and real newlines become line breaks;
// braces and stray backslashes would be parsed as override tags, so they are replaced.
export function assText(s) {
  return String(s).replace(/\r/g, '').replace(/\\n/g, '\n')
    .replace(/\\/g, '∖').replace(/\{/g, '｛').replace(/\}/g, '｝')
    .replace(/\n/g, '\\N');
}

const n0 = (x) => Math.round(x);
const ms = (t) => Math.round(t * 1000);

function textTags(t, X, Y, font) {
  const size = t.size ?? 72;
  const tags = [`\\an5`, `\\fn${font}`, `\\fs${n0(size)}`, `\\b${t.bold === false ? 0 : 1}`, `\\i${t.italic ? 1 : 0}`, `\\1c${assColor(t.color)}`];
  if (t.box) {
    tags.push(`\\3c${assColor(t.boxColor || '#000000')}`, `\\3a${assAlpha(0.6)}`, `\\bord${n0(size * 0.35)}`, '\\shad0');
  } else {
    // Old projects have no outline field: keep the original automatic outline.
    const auto = t.outline === undefined;
    const bord = auto ? Math.max(2, n0(size / 18)) : t.outline;
    tags.push(`\\bord${bord}`, `\\3c${assColor(t.outlineColor || '#000000')}`, `\\3a${assAlpha(auto ? 0.7 : 1)}`);
    tags.push(`\\shad${t.shadow || 0}`);
    if (t.shadow) tags.push(`\\4c${assColor(t.shadowColor || '#000000')}`, `\\4a${assAlpha(0.6)}`);
  }
  if (t.blur) tags.push(`\\blur${t.blur}`);
  return tags.join('');
}

const SLIDE = { slideup: [0, 80], slidedown: [0, -80], slideleft: [120, 0], slideright: [-120, 0] };
const SLIDE_OUT = { slideup: [0, -80], slidedown: [0, 80] };

// Events for one text overlay: [{start, end, text, style}]
export function textEvents(t, W, H, font, total = Infinity) {
  const s = t.start, e = Math.min(t.end, total);
  if (e <= s) return [];
  const X = n0(W * t.x), Y = n0(H * t.y);
  const ain = t.animation || 'none', aout = t.animationOut || 'none';
  const dur = e - s;
  const din = Math.min(ain === 'pop' ? 0.15 : 0.35, dur / 2);
  const dout = Math.min(0.3, dur / 2);
  const base = textTags(t, X, Y, font);
  const style = t.box ? 'Box' : 'Default';
  let body = assText(t.text);
  if (ain === 'typewriter') {
    // Reveal one character at a time: \ko hides glyph and outline until its turn.
    const chars = [...String(t.text).replace(/\\n/g, '\n')];
    const per = Math.max(1, Math.min(6, Math.floor((dur * 60) / Math.max(1, chars.length))));
    body = `{\\2a&HFF&}` + chars.map((c) => (c === '\n' ? '\\N' : `{\\ko${per}}${assText(c)}`)).join('');
  }
  const fadeIn = ['fade', 'pop', 'zoom', ...Object.keys(SLIDE)].includes(ain) ? ms(din) : 0;
  const fadeOut = aout !== 'none' ? ms(dout) : 0;
  const scaleIn = ain === 'pop' ? `\\fscx70\\fscy70\\t(0,${ms(din)},\\fscx100\\fscy100)` : ain === 'zoom' ? `\\fscx135\\fscy135\\t(0,${ms(din)},\\fscx100\\fscy100)` : '';
  const scaleOut = (d) => (aout === 'pop' ? `\\t(${ms(d - dout)},${ms(d)},\\fscx70\\fscy70)` : aout === 'zoom' ? `\\t(${ms(d - dout)},${ms(d)},\\fscx135\\fscy135)` : '');
  const inMove = SLIDE[ain], outMove = SLIDE_OUT[aout];
  const ev = (a, b, tags) => ({ start: a, end: b, style, text: `{${base}${tags}}${body}` });

  if (inMove && outMove && dur > din + dout) {
    // Two moves need two events: entry+hold, then exit.
    const mid = e - dout;
    return [
      ev(s, mid, `\\move(${X + inMove[0]},${Y + inMove[1]},${X},${Y},0,${ms(din)})\\fad(${fadeIn},0)${scaleIn}`),
      ev(mid, e, `\\move(${X},${Y},${X + outMove[0]},${Y + outMove[1]},0,${ms(dout)})\\fad(0,${fadeOut})`),
    ];
  }
  let pos = `\\pos(${X},${Y})`;
  if (inMove) pos = `\\move(${X + inMove[0]},${Y + inMove[1]},${X},${Y},0,${ms(din)})`;
  else if (outMove) pos = `\\move(${X},${Y},${X + outMove[0]},${Y + outMove[1]},${ms(dur - dout)},${ms(dur)})`;
  const fad = fadeIn || fadeOut ? `\\fad(${fadeIn},${fadeOut})` : '';
  return [ev(s, e, `${pos}${fad}${scaleIn}${scaleOut(dur)}`)];
}

function captionTags(st, W, H, font) {
  const t = { ...st, x: 0.5, outline: st.box ? undefined : (st.outline ?? 4), shadow: 0 };
  return textTags(t, n0(W / 2), n0(H * st.y), font) + `\\pos(${n0(W / 2)},${n0(H * st.y)})`;
}

// Emphasized caption words (word.em): their own color and a bigger size. The default color is yellow, or
// green when the mode already lights the spoken word in yellow. Keep in sync with renderCaption in app.js.
export function emphasisColor(st) {
  if (st.emphasisColor) return st.emphasisColor;
  const lit = ['karaoke', 'word', 'single'].includes(st.mode) && String(st.highlightColor || '').toLowerCase() === '#ffde00';
  return lit ? '#4dff88' : '#ffde00';
}
// Emoji on caption words show above the line, from the word until the line ends (or the next emoji).
// Returns [{emoji, start, end}] in timeline seconds; emojiBox gives the size and centre in canvas px.
export function captionEmoji(captions, total = Infinity) {
  const out = [];
  for (const l of captions?.lines || []) {
    const ws = l.words.filter((w) => w.emoji && w.start < Math.min(l.end, total));
    ws.forEach((w, i) => out.push({ emoji: w.emoji, start: w.start, end: Math.min(i + 1 < ws.length ? ws[i + 1].start : l.end, total) }));
  }
  return out.filter((e) => e.end > e.start);
}
// The translation line (line.alt) sits under the caption, smaller; above it when there is no room below.
export const ALT_SCALE = 0.72;
export function altY(st, H) {
  const size = st.size || 72, gap = (size * 0.6 + size * ALT_SCALE * 0.6 + 8) / H;
  return st.y + gap <= 0.96 ? st.y + gap : st.y - gap;
}
export function emojiBox(st, W, H) {
  const size = Math.max(16, Math.round((st.size || 72) * 1.4));
  return { size, x: W / 2, y: H * st.y - (st.size || 72) * 0.6 - size * 0.55 };
}

// Events for the caption lines in the chosen mode.
export function captionEvents(captions, W, H, font, total = Infinity) {
  if (!captions?.lines?.length) return [];
  const st = captions.style;
  const style = st.box ? 'Box' : 'Default';
  const base = captionTags(st, W, H, font);
  const word = (w) => assText(st.uppercase ? w.w.toUpperCase() : w.w);
  const cs = (d) => Math.max(0, Math.round(d * 100));
  const hl = assColor(st.highlightColor || '#ffde00'), col = assColor(st.color || '#ffffff');
  const emDefault = emphasisColor(st), sc = Math.round((st.emphasisScale ?? 1.15) * 100);
  const emc = (w) => assColor(typeof w.em === 'string' ? w.em : emDefault);
  const big = `\\fscx${sc}\\fscy${sc}`, normal = '\\fscx100\\fscy100';
  const out = [];
  for (const l of captions.lines) {
    if (l.start >= total) continue;
    const le = Math.min(l.end, total);
    if (st.mode === 'karaoke') {
      let prev = l.start;
      const body = l.words.map((w) => {
        const gap = cs(w.start - prev); prev = w.end;
        if (w.em) return `${gap ? `{\\k${gap}}` : ''}{\\kf${cs(w.end - w.start)}\\1c${emc(w)}\\2c${emc(w)}${big}}${word(w)}{\\1c${hl}\\2c${col}${normal}}`;
        return `${gap ? `{\\k${gap}}` : ''}{\\kf${cs(w.end - w.start)}}${word(w)}`;
      }).join(' ');
      out.push({ start: l.start, end: le, style, text: `{${base}\\1c${hl}\\2c${col}\\fad(80,80)}${body}` });
    } else if (st.mode === 'word') {
      l.words.forEach((w, i) => {
        const a = i === 0 ? l.start : w.start;
        const b = Math.min(le, i + 1 < l.words.length ? l.words[i + 1].start : le);
        if (b <= a) return;
        const body = l.words.map((x, j) => (j === i ? `{\\1c${hl}${x.em ? big : ''}}${word(x)}{\\1c${col}${x.em ? normal : ''}}`
          : x.em ? `{\\1c${emc(x)}${big}}${word(x)}{\\1c${col}${normal}}` : word(x))).join(' ');
        out.push({ start: a, end: b, style, text: `{${base}}${body}` });
      });
    } else if (st.mode === 'single') {
      l.words.forEach((w, i) => {
        const next = l.words[i + 1]?.start ?? le;
        const b = Math.min(le, Math.max(w.end, Math.min(next, w.end + 0.5), w.start + 0.15));
        const to = w.em ? sc : 100;
        out.push({ start: w.start, end: b, style, text: `{${base}\\1c${w.em ? emc(w) : hl}\\fscx${Math.round(to * 0.8)}\\fscy${Math.round(to * 0.8)}\\t(0,90,\\fscx${to}\\fscy${to})}${word(w)}` });
      });
    } else {
      out.push({ start: l.start, end: le, style, text: `{${base}\\fad(80,80)}${l.words.map((x) => (x.em ? `{\\1c${emc(x)}${big}}${word(x)}{\\1c${col}${normal}}` : word(x))).join(' ')}` });
    }
  }
  // Translations under the lines.
  const altSt = { ...st, size: Math.round((st.size || 72) * ALT_SCALE), outline: st.box ? undefined : Math.max(1, Math.round((st.outline ?? 4) * 0.75)), y: altY(st, H) };
  const altBase = captionTags(altSt, W, H, font);
  for (const l of captions.lines) {
    if (!l.alt || l.start >= total) continue;
    out.push({ start: l.start, end: Math.min(l.end, total), style, text: `{${altBase}\\fad(80,80)}${assText(st.uppercase ? l.alt.toUpperCase() : l.alt)}` });
  }
  return out;
}

// Returns { ass, families } or null when there is nothing to draw.
export function buildAss(project, { defaultFont = 'Arial', total = Infinity } = {}) {
  const W = project.settings.width, H = project.settings.height;
  const families = new Set([defaultFont]);
  const events = [];
  if (project.captions) {
    const f = project.captions.style.font || defaultFont;
    families.add(f);
    for (const e of captionEvents(project.captions, W, H, f, total)) events.push({ layer: 0, ...e });
  }
  for (const t of project.texts) {
    if (t.start >= total) continue;
    const f = t.font || defaultFont;
    families.add(f);
    for (const e of textEvents(t, W, H, f, total)) events.push({ layer: 1, ...e });
  }
  if (!events.length) return null;
  const fmt = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
  const margin = n0(W * 0.05);
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: None', '',
    '[V4+ Styles]', fmt,
    `Style: Default,${defaultFont},72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,${margin},${margin},0,1`,
    `Style: Box,${defaultFont},72,&H00FFFFFF,&H000000FF,&H66000000,&H66000000,-1,0,0,0,100,100,0,0,3,0,0,5,${margin},${margin},0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events.map((e) => `Dialogue: ${e.layer},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`),
    '',
  ].join('\n');
  return { ass, families: [...families] };
}
