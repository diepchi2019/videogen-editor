// Ready-made title designs: each template is a few text items (styles, boxes, animations, timing) placed as one
// group by add_text_template. Pure: build() returns add_text inputs with start/end in timeline seconds.
const r3 = (n) => Math.round(n * 1000) / 1000;

// f: fields ({title, subtitle, ...}); v: the canvas is vertical; c: accent color; t0/t1: start and end.
export const TEXT_TEMPLATES = {
  title_card: {
    description: 'Big centered title with a smaller line under it (intro, section start)', fields: ['title', 'subtitle'],
    build: (f, v, c, t0, t1) => [
      { text: f.title, y: 0.45, size: v ? 96 : 84, bold: true, outline: 0, shadow: 6, shadowColor: '#000000', animation: 'zoom', animationOut: 'fade' },
      f.subtitle && { text: f.subtitle, y: 0.53, size: v ? 46 : 40, bold: false, color: c, outline: 0, shadow: 4, shadowColor: '#000000', animation: 'fade', animationOut: 'fade', start: t0 + 0.3 },
    ],
  },
  lower_third: {
    description: 'Name in a colored bar with a role or place under it, lower third (interviews, speakers)', fields: ['title', 'subtitle'],
    build: (f, v, c) => [
      { text: f.title, y: v ? 0.66 : 0.78, size: v ? 60 : 52, bold: true, box: true, boxColor: c, outline: 0, animation: 'slideright', animationOut: 'fade' },
      f.subtitle && { text: f.subtitle, y: v ? 0.715 : 0.855, size: v ? 40 : 34, bold: false, box: true, boxColor: '#111111', outline: 0, animation: 'slideright', animationOut: 'fade', delay: 0.15 },
    ],
  },
  quote: {
    description: 'A quote in large italic text with the author under it', fields: ['title', 'subtitle'],
    build: (f, v) => [
      { text: `“${String(f.title).replace(/^["“]|["”]$/g, '')}”`, y: 0.44, size: v ? 64 : 56, italic: true, bold: true, outline: 0, shadow: 5, shadowColor: '#000000', animation: 'fade', animationOut: 'fade' },
      f.subtitle && { text: `— ${String(f.subtitle).replace(/^[-—]\s*/, '')}`, y: v ? 0.56 : 0.6, size: v ? 40 : 34, bold: false, color: '#dddddd', outline: 0, shadow: 3, shadowColor: '#000000', animation: 'fade', animationOut: 'fade', delay: 0.5 },
    ],
  },
  part_label: {
    description: 'A sticker-style label at the top, e.g. "PART 2" or "DAY 3"', fields: ['title'],
    build: (f, v, c) => [{ text: String(f.title).toUpperCase(), y: v ? 0.14 : 0.12, size: v ? 64 : 56, bold: true, color: '#111111', box: true, boxColor: c === '#ffffff' ? '#ffde00' : c, outline: 0, animation: 'pop', animationOut: 'fade' }],
  },
  countdown: {
    description: 'Numbers counting down in the center, one per second (from = first number, default 3)', fields: ['from'],
    duration: (f) => Math.max(1, Math.min(10, Math.round(Number(f.from) || 3))),
    build: (f, v, c, t0) => {
      const n = Math.max(1, Math.min(10, Math.round(Number(f.from) || 3)));
      return Array.from({ length: n }, (_, i) => ({ text: String(n - i), y: 0.45, size: v ? 220 : 180, bold: true, color: i === n - 1 ? c : '#ffffff', outline: 10, outlineColor: '#000000', animation: 'pop', animationOut: 'zoom', start: t0 + i, end: t0 + i + 1 }));
    },
  },
  big_number: {
    description: 'A huge number or stat with a label under it, e.g. "$10,000" / "in 30 days"', fields: ['title', 'subtitle'],
    build: (f, v, c) => [
      { text: f.title, y: 0.43, size: v ? 170 : 140, bold: true, color: c === '#ffffff' ? '#ffde00' : c, outline: 10, outlineColor: '#000000', animation: 'pop', animationOut: 'fade' },
      f.subtitle && { text: f.subtitle, y: v ? 0.53 : 0.58, size: v ? 52 : 44, bold: true, outline: 5, outlineColor: '#000000', animation: 'slideup', animationOut: 'fade', delay: 0.25 },
    ],
  },
  question_hook: {
    description: 'A question at the top in a bright box (hook in the first seconds)', fields: ['title'],
    build: (f, v) => [{ text: f.title, y: v ? 0.2 : 0.16, size: v ? 70 : 60, bold: true, color: '#111111', box: true, boxColor: '#ffde00', outline: 0, animation: 'pop', animationOut: 'fade' }],
  },
  call_to_action: {
    description: 'A follow / subscribe button with a small line under it (end of the video)', fields: ['title', 'subtitle'],
    build: (f, v, c) => [
      { text: f.title || 'FOLLOW FOR MORE', y: v ? 0.62 : 0.7, size: v ? 62 : 52, bold: true, box: true, boxColor: c === '#ffffff' ? '#ff0033' : c, outline: 0, animation: 'pop', animationOut: 'fade' },
      f.subtitle && { text: f.subtitle, y: v ? 0.675 : 0.79, size: v ? 40 : 34, bold: false, outline: 4, outlineColor: '#000000', animation: 'fade', animationOut: 'fade', delay: 0.3 },
    ],
  },
  list: {
    description: 'A title and items that appear one after another (tips, steps, top 3)', fields: ['title', 'items'],
    duration: (f) => 2 + 0.8 * (f.items?.length || 0),
    build: (f, v, c, t0, t1) => {
      const items = (f.items || []).slice(0, 8);
      const top = v ? 0.3 : 0.22, step = v ? 0.065 : 0.1;
      return [
        f.title && { text: f.title, y: top - step, size: v ? 70 : 60, bold: true, color: c === '#ffffff' ? '#ffde00' : c, outline: 6, outlineColor: '#000000', animation: 'fade', animationOut: 'fade' },
        ...items.map((it, i) => ({ text: `${i + 1}. ${it}`, y: r3(top + 0.02 + i * step), size: v ? 52 : 44, bold: true, outline: 5, outlineColor: '#000000', animation: 'slideleft', animationOut: 'fade', start: r3(t0 + 0.5 + 0.8 * i), end: t1 })),
      ];
    },
  },
  breaking_news: {
    description: 'A red "BREAKING" tag over a white headline bar near the bottom', fields: ['title', 'subtitle'],
    build: (f, v) => [
      { text: (f.subtitle || 'BREAKING').toUpperCase(), y: v ? 0.62 : 0.74, size: v ? 44 : 38, bold: true, box: true, boxColor: '#e00000', outline: 0, animation: 'slideright', animationOut: 'fade' },
      { text: f.title, y: v ? 0.67 : 0.82, size: v ? 52 : 44, bold: true, color: '#111111', box: true, boxColor: '#ffffff', outline: 0, animation: 'slideright', animationOut: 'fade', delay: 0.2 },
    ],
  },
};

// The add_text inputs for a template. start/duration in timeline seconds; color: the accent (hex).
export function buildTextTemplate(name, fields, { start = 0, duration, color = '#e8344e', vertical = true } = {}) {
  const tpl = TEXT_TEMPLATES[name];
  if (!tpl) throw new Error(`template must be one of: ${Object.keys(TEXT_TEMPLATES).join(', ')}`);
  for (const k of tpl.fields) if (k !== 'subtitle' && k !== 'from' && (fields[k] === undefined || fields[k] === '' || (Array.isArray(fields[k]) && !fields[k].length))) throw new Error(`${name} needs ${k}`);
  const dur = duration ?? (tpl.duration ? tpl.duration(fields) : 3);
  const t1 = start + dur;
  return tpl.build(fields, vertical, color, start, t1).filter(Boolean).map((it) => {
    const { delay = 0, ...rest } = it;
    return { x: 0.5, color: '#ffffff', ...rest, start: r3(it.start ?? start + delay), end: r3(Math.min(t1, it.end ?? t1)) };
  });
}
