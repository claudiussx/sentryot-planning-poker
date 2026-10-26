// Procedural pixel-art characters. Every shape is a handful of fillRects on a
// low-resolution canvas that CSS scales up with `image-rendering: pixelated`.

// Two palettes for the room: a night-time arcade and a sunny day. PAL is
// mutated in place by setSceneTheme, so every draw call picks up the switch.
const DARK = {
  ink: '#0d0b1a',
  wall: '#231e42',
  wallDark: '#17142c',
  panel: '#262049',
  sub: '#2b2552',
  border: '#3d3566',
  borderLight: '#5a4f8c',
  floorLine: '#221d3d',
  muted: '#7a72a8',
  secondary: '#a49cd0',
  value: '#d9d3f2',
  white: '#ffffff',
  paper: '#f7f3ff',
  paperShade: '#a8a0c8',
  paperBack: '#cfc6e8',
  teal: '#4de0c0',
  tealDark: '#2bb597',
  cyan: '#7fe9ff',
  red: '#ff5d73',
  green: '#5ee27a',
  gold: '#ffc93c',
  goldDark: '#c9921a',
  pencil: '#ffb347',
  pink: '#ff8fb1',
  sky: '#0f0c24',
  skyline: '#1d1838',
  moon: '#fff2c4',
  screen: '#0b0918',
  plantPot: '#9a5b3a',
  leaf: '#5ee27a',
  leafDark: '#2b9a52',
};

const LIGHT = {
  ...DARK,
  ink: '#241e3d',
  wall: '#f1e4cc',
  wallDark: '#dcc6a1',
  panel: '#fffaf0',
  sub: '#8f6544',
  border: '#a77b52',
  borderLight: '#c99a6b',
  floorLine: '#c9ae84',
  muted: '#9a91b8',
  secondary: '#6a6190',
  value: '#3d3560',
  paper: '#ffffff',
  paperShade: '#c9bedf',
  paperBack: '#e3dcef',
  teal: '#12a88a',
  tealDark: '#0d8a71',
  cyan: '#2bb5d9',
  red: '#e8445e',
  green: '#2fae55',
  gold: '#f2b417',
  goldDark: '#b8860b',
  sky: '#9fd8ff',
  skyline: '#7fb2d6',
  moon: '#ffd34d',
  screen: '#1d1830',
  plantPot: '#b06a43',
  leaf: '#3fbf5f',
  leafDark: '#2b8a45',
};

export const PAL = { ...DARK };
export const SCENE = { light: false };

export function setSceneTheme(light) {
  Object.assign(PAL, light ? LIGHT : DARK);
  SCENE.light = light;
}

export const SKINS = ['#f6d3b3', '#eabf98', '#d39b6d', '#b0784c', '#8a5532', '#5e3a22'];
export const HAIR_COLORS = ['#2b1d14', '#4a2f1d', '#7b4a26', '#c8913a', '#e8d07a', '#a33b2a', '#d8d8d8', '#3b3f58', '#4de0c0', '#ff7ab8'];
export const SHIRTS = ['#4de0c0', '#7fe9ff', '#ff5d73', '#8b6cff', '#5ee27a', '#ffc93c', '#ff7ab8', '#4b8bff', '#d9d3f2', '#3d3566'];
export const HAIR_STYLES = ['short', 'long', 'bun', 'spiky', 'bald', 'cap', 'curly', 'mohawk', 'ponytail'];
export const ACCESSORIES = ['none', 'none', 'glasses', 'sunglasses', 'headphones', 'beard', 'mustache'];

// ---------- helpers ----------

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function rng(seed) {
  let a = typeof seed === 'number' ? seed : hashStr(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(s) {
  return hashStr(String(s));
}

export function randomLook(seed = Math.random() * 1e9) {
  const r = rng(Math.floor(seed));
  const pick = (n) => Math.floor(r() * n);
  // mint and pink hair are rare treats
  let hairColor = pick(HAIR_COLORS.length);
  if (hairColor >= 8 && r() < 0.6) hairColor = pick(8);
  return {
    skin: pick(SKINS.length),
    hair: pick(HAIR_STYLES.length),
    hairColor,
    shirt: pick(SHIRTS.length),
    acc: pick(ACCESSORIES.length),
  };
}

export function sanitizeLook(l) {
  const clamp = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : 0);
  l = l || {};
  return {
    skin: clamp(l.skin, SKINS.length),
    hair: clamp(l.hair, HAIR_STYLES.length),
    hairColor: clamp(l.hairColor, HAIR_COLORS.length),
    shirt: clamp(l.shirt, SHIRTS.length),
    acc: clamp(l.acc, ACCESSORIES.length),
  };
}

export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + amt * 255)));
  const r = f(n >> 16),
    g = f((n >> 8) & 255),
    b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function R(ctx, x, y, w, h, c) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// ---------- 3x5 pixel font ----------

const GLYPHS = {
  0: '111101101101111',
  1: '010110010010111',
  2: '111001111100111',
  3: '111001111001111',
  4: '101101111001001',
  5: '111100111001111',
  6: '111100111101111',
  7: '111001010010010',
  8: '111101111101111',
  9: '111101111001111',
  '.': '000000000000010',
  '?': '111001011000010',
  '-': '000000111000000',
  '/': '001001010100100',
  ':': '000010000010000',
  '!': '010010010000010',
  ' ': '000000000000000',
};

export function textWidth(text, s = 1) {
  let w = 0;
  for (const ch of text) w += (ch === '.' || ch === ':' || ch === '!' ? 2 : 4) * s;
  return Math.max(0, w - s);
}

export function drawText(ctx, text, x, y, color, s = 1) {
  ctx.fillStyle = color;
  let cx = Math.round(x);
  for (const ch of text) {
    const g = GLYPHS[ch];
    const narrow = ch === '.' || ch === ':' || ch === '!';
    if (g) {
      for (let i = 0; i < 15; i++) {
        if (g[i] !== '1') continue;
        const gx = i % 3;
        const gy = Math.floor(i / 3);
        ctx.fillRect(cx + (narrow ? gx - 1 : gx) * s, Math.round(y) + gy * s, s, s);
      }
    }
    cx += (narrow ? 2 : 4) * s;
  }
}

// ---------- 7x7 icons ----------

const ICONS = {
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  bang: ['..###..', '..###..', '..###..', '...#...', '.......', '..###..', '..###..'],
  question: ['..###..', '.##.##.', '....##.', '...##..', '...#...', '.......', '...#...'],
  smile: ['.#####.', '#.....#', '#.#.#.#', '#.....#', '#.###.#', '#.....#', '.#####.'],
  coffee: ['.s..s..', '..s..s.', 'lllll..', '######.', '#####.#', '######.', '.###...'],
  zzz: ['###....', '..#....', '.#.....', '###....', '....###', '.....#.', '....###'],
  thumb: ['....#..', '...##..', '...##..', '#.#####', '#.#####', '#.#####', '#.####.'],
  fire: ['...#...', '..##...', '.###.#.', '.#####.', '###.###', '##...##', '.#####.'],
  // a teal mug sized for the vote sign
  mug: ['...s..s.....', '..s..s......', '...s..s.....', '............', '.tttttttt...', '.tbbbbbbtt..', '.tttttttt.t.', '.tttttttt.t.', '.ttttttttt..', '..tttttt....'],
  laugh: ['#.#.##.', '#.#.#.#', '.#..#.#', '#.#.#.#', '#.#.##.'],
  party: ['r.....p', '..c..r.', '.y..c..', '.yy....', '.yyy.p.', 'yyyy...', 'yyyy.c.'],
  star: ['...#...', '..###..', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'],
  idea: ['..###..', '.#####.', '.#####.', '.#####.', '..###..', '..sss..', '...s...'],
  rocket: ['...#...', '..###..', '..#c#..', '..###..', '.#####.', '.#.o.#.', '...o...'],
  clock: ['.#####.', '#..r..#', '#..r..#', '#..rr.#', '#.....#', '#.....#', '.#####.'],
  angry: ['.#####.', '#k###k#', '##k#k##', '#######', '##kkk##', '#k###k#', '.#####.'],
  skull: ['.#####.', '#######', '#..#..#', '#..#..#', '###.###', '.#####.', '.#.#.#.'],
  ghost: ['..###..', '.#####.', '#k##k##', '#######', '#######', '#######', '#.#.#.#'],
  // settings menu
  gear: ['..#.#..', '.#####.', '###.###', '.#...#.', '###.###', '.#####.', '..#.#..'],
  speaker: ['...#...', '..##.#.', '####..#', '####..#', '####..#', '..##.#.', '...#...'],
  muted: ['...#...', '..##...', '####r.r', '####.r.', '####r.r', '..##...', '...#...'],
  sun: ['#..#..#', '.#####.', '.#####.', '#######', '.#####.', '.#####.', '#..#..#'],
  moon: ['..###..', '.##....', '##.....', '##.....', '##.....', '.##....', '..###..'],
  wave: ['.......', '.##..##', '#..##..', '.......', '.##..##', '#..##..', '.......'],
  pause: ['.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.'],
  font: ['.#.....', '#.#....', '#.#.##.', '###...#', '#.#.###', '#.##..#', '#.#.###'],
  card: ['.#####.', '#.....#', '#..#..#', '#.###.#', '#..#..#', '#.....#', '.#####.'],
  check: ['......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  eye: ['.......', '..###..', '.#...#.', '#..#..#', '.#...#.', '..###..', '.......'],
};

// A PAL key follows the theme; a hex value stays put.
const ICON_COLORS = {
  heart: 'red',
  bang: 'red',
  question: 'teal',
  smile: '#e6a817',
  coffee: '#8a5532',
  zzz: 'secondary',
  thumb: 'teal',
  fire: 'red',
  check: 'white',
  eye: 'teal',
  laugh: '#e09b1a',
  star: 'gold',
  idea: 'gold',
  rocket: 'red',
  clock: 'cyan',
  angry: 'red',
  skull: 'secondary',
  ghost: '#b9a8ff',
  gear: 'value',
  speaker: 'value',
  muted: 'value',
  sun: 'gold',
  moon: '#ffe9a8',
  wave: 'teal',
  pause: 'secondary',
  font: 'value',
  card: 'teal',
};

const iconColor = (name) => {
  const c = ICON_COLORS[name] || 'value';
  return c.startsWith('#') ? c : PAL[c];
};

export const EMOTES = ['thumb', 'heart', 'smile', 'laugh', 'fire', 'party', 'star', 'idea', 'rocket', 'clock', 'bang', 'question', 'angry', 'skull', 'ghost', 'coffee', 'zzz'];

export const EMOTE_NAMES = {
  thumb: 'Thumbs up',
  heart: 'Love it',
  smile: 'Happy',
  laugh: 'LOL',
  fire: 'On fire',
  party: 'Party',
  star: 'Star',
  idea: 'Idea',
  rocket: 'Ship it',
  clock: 'Hurry up',
  bang: 'Wow',
  question: 'Huh?',
  angry: 'Grr',
  skull: 'Dead',
  ghost: 'Boo',
  coffee: 'Coffee',
  zzz: 'Sleepy',
};

export function drawIcon(ctx, name, x, y, s = 1, color) {
  const rows = ICONS[name];
  if (!rows) return;
  // '#' is the icon colour; the other letters are fixed accents
  const inks = { '#': color || iconColor(name), s: PAL.secondary, l: '#c08a5a', t: PAL.tealDark, b: '#6b3f22', y: PAL.gold, o: '#ff8a3d', k: PAL.ink, r: PAL.red, p: PAL.pink, c: PAL.cyan };
  rows.forEach((row, yy) => {
    for (let xx = 0; xx < row.length; xx++) {
      const ink = inks[row[xx]];
      if (!ink) continue;
      ctx.fillStyle = ink;
      ctx.fillRect(Math.round(x) + xx * s, Math.round(y) + yy * s, s, s);
    }
  });
}

// The Pixel Poker mark: a playing card with a diamond (9x12).
const MARK = [
  ' KKKKKKK ',
  'KWWWWWWWK',
  'KWRWWWWWK',
  'KWWWYWWWK',
  'KWWYYYWWK',
  'KWYYYYYWK',
  'KWWYYYWWK',
  'KWWWYWWWK',
  'KWWWWWWWK',
  'KWWWWWRWK',
  'KWWWWWWWK',
  ' KKKKKKK ',
];

export function drawMark(ctx, x, y, s = 1) {
  const inks = { K: PAL.ink, W: PAL.paper, R: PAL.red, Y: PAL.gold };
  MARK.forEach((row, yy) => {
    for (let xx = 0; xx < row.length; xx++) {
      if (row[xx] === ' ') continue;
      ctx.fillStyle = inks[row[xx]];
      ctx.fillRect(x + xx * s, y + yy * s, s, s);
    }
  });
}

// The box around an icon's drawn pixels: some icons sit off-centre inside their own grid.
export function iconSize(name) {
  const rows = ICONS[name] || [];
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '.') continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  });
  return x1 < 0 ? { x0: 0, y0: 0, w: 0, h: 0 } : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Draws an icon centred in a w x h box by its drawn pixels, not its grid.
// An odd spare row goes above the icon: the bubble's tail already adds white below.
export function drawIconCentered(ctx, name, x, y, w, h) {
  const b = iconSize(name);
  drawIcon(ctx, name, x + Math.floor((w - b.w) / 2) - b.x0, y + Math.ceil((h - b.h) / 2) - b.y0);
}

// Speech bubble with an icon: 11 x 11 plus the tail, a 9 x 9 inside so 7-pixel icons get even margins.
export function drawEmoteBubble(ctx, name, x, y) {
  drawBubble(ctx, x, y, 11, 11);
  drawIconCentered(ctx, name, x + 1, y + 1, 9, 9);
}

export function drawBubble(ctx, x, y, w, h) {
  R(ctx, x + 1, y, w - 2, h, PAL.ink);
  R(ctx, x, y + 1, w, h - 2, PAL.ink);
  R(ctx, x + 1, y + 1, w - 2, h - 2, PAL.white);
  // tail pointing down-left
  R(ctx, x + 1, y + h - 1, 3, 1, PAL.white);
  R(ctx, x, y + h - 1, 1, 2, PAL.ink);
  R(ctx, x + 1, y + h, 2, 1, PAL.white);
  R(ctx, x + 1, y + h + 1, 1, 1, PAL.ink);
  R(ctx, x + 2, y + h + 1, 2, 1, PAL.ink);
  R(ctx, x + 3, y + h, 2, 1, PAL.ink);
}

// ---------- the character ----------

function drawHair(ctx, cx, hy, style, color, skin) {
  const dark = shade(color, -0.12);
  switch (style) {
    case 'short':
      R(ctx, cx - 4, hy - 1, 8, 1, color);
      R(ctx, cx - 5, hy, 10, 3, color);
      R(ctx, cx - 5, hy + 3, 1, 2, color);
      R(ctx, cx + 4, hy + 3, 1, 2, color);
      R(ctx, cx - 2, hy + 2, 3, 1, dark);
      break;
    case 'long':
      R(ctx, cx - 4, hy - 1, 8, 1, color);
      R(ctx, cx - 5, hy, 10, 3, color);
      R(ctx, cx - 6, hy + 1, 2, 11, color);
      R(ctx, cx + 4, hy + 1, 2, 11, color);
      R(ctx, cx - 6, hy + 11, 1, 1, dark);
      R(ctx, cx + 5, hy + 11, 1, 1, dark);
      break;
    case 'bun':
      R(ctx, cx - 2, hy - 4, 4, 3, color);
      R(ctx, cx - 1, hy - 5, 2, 1, color);
      R(ctx, cx - 4, hy - 1, 8, 1, color);
      R(ctx, cx - 5, hy, 10, 3, color);
      R(ctx, cx - 5, hy + 3, 1, 3, color);
      R(ctx, cx + 4, hy + 3, 1, 3, color);
      break;
    case 'spiky':
      R(ctx, cx - 5, hy, 10, 3, color);
      R(ctx, cx - 5, hy - 1, 2, 1, color);
      R(ctx, cx - 2, hy - 2, 2, 2, color);
      R(ctx, cx + 1, hy - 3, 2, 3, color);
      R(ctx, cx + 4, hy - 1, 1, 1, color);
      R(ctx, cx - 5, hy + 3, 1, 1, color);
      R(ctx, cx + 4, hy + 3, 1, 1, color);
      break;
    case 'bald':
      R(ctx, cx + 1, hy + 1, 2, 1, shade(skin, 0.12));
      R(ctx, cx - 5, hy + 3, 1, 3, color);
      R(ctx, cx + 4, hy + 3, 1, 3, color);
      break;
    case 'cap': {
      const cap = PAL.teal;
      R(ctx, cx - 4, hy - 2, 8, 1, cap);
      R(ctx, cx - 5, hy - 1, 10, 4, cap);
      R(ctx, cx - 6, hy + 3, 12, 1, PAL.tealDark);
      R(ctx, cx - 1, hy, 2, 2, PAL.white);
      R(ctx, cx - 5, hy + 4, 1, 1, color);
      R(ctx, cx + 4, hy + 4, 1, 1, color);
      break;
    }
    case 'curly':
      R(ctx, cx - 6, hy - 1, 12, 4, color);
      R(ctx, cx - 5, hy - 2, 2, 1, color);
      R(ctx, cx - 1, hy - 2, 2, 1, color);
      R(ctx, cx + 3, hy - 2, 2, 1, color);
      R(ctx, cx - 6, hy + 3, 1, 4, color);
      R(ctx, cx + 5, hy + 3, 1, 4, color);
      R(ctx, cx - 4, hy, 1, 1, dark);
      R(ctx, cx, hy + 1, 1, 1, dark);
      R(ctx, cx + 3, hy, 1, 1, dark);
      break;
    case 'mohawk':
      R(ctx, cx - 1, hy - 4, 2, 6, color);
      R(ctx, cx - 2, hy - 2, 1, 3, color);
      R(ctx, cx + 1, hy - 3, 1, 4, color);
      R(ctx, cx - 5, hy + 1, 1, 4, shade(skin, -0.1));
      R(ctx, cx + 4, hy + 1, 1, 4, shade(skin, -0.1));
      break;
    case 'ponytail':
      R(ctx, cx - 4, hy - 1, 8, 1, color);
      R(ctx, cx - 5, hy, 10, 3, color);
      R(ctx, cx - 5, hy + 3, 1, 2, color);
      R(ctx, cx + 4, hy + 2, 3, 2, color);
      R(ctx, cx + 6, hy + 4, 2, 6, color);
      R(ctx, cx + 4, hy + 2, 1, 1, PAL.red);
      break;
  }
}

function drawFace(ctx, cx, hy, look, face) {
  const skin = SKINS[look.skin];
  const acc = ACCESSORIES[look.acc];
  const eyeY = hy + 5 + (face.look === 'up' ? -1 : face.look === 'down' ? 1 : 0);
  const eyeX = face.look === 'side' ? 1 : 0;
  const lip = shade(skin, -0.38);

  if (acc !== 'sunglasses') {
    if (face.closed) {
      R(ctx, cx - 4 + eyeX, eyeY + 1, 2, 1, PAL.ink);
      R(ctx, cx + 2 + eyeX, eyeY + 1, 2, 1, PAL.ink);
    } else {
      const eh = acc === 'glasses' ? 1 : 2;
      R(ctx, cx - 3 + eyeX, eyeY, 1, eh, PAL.ink);
      R(ctx, cx + 2 + eyeX, eyeY, 1, eh, PAL.ink);
    }
  }
  if (face.blush) {
    R(ctx, cx - 4, hy + 7, 1, 1, PAL.pink);
    R(ctx, cx + 3, hy + 7, 1, 1, PAL.pink);
  }

  if (acc === 'beard') {
    const c = HAIR_COLORS[look.hairColor];
    R(ctx, cx - 5, hy + 6, 10, 3, c);
    R(ctx, cx - 4, hy + 9, 8, 1, c);
  }
  if (acc === 'mustache') R(ctx, cx - 2, hy + 7, 4, 1, HAIR_COLORS[look.hairColor]);

  // Every mouth sits in the same 2x2 spot under the nose, clear of the eyes,
  // modelled on the open cheer mouth: dark top row, a touch of colour below.
  switch (face.mouth) {
    case 'smile':
    case 'open':
      R(ctx, cx - 1, hy + 7, 2, 1, PAL.ink);
      R(ctx, cx - 1, hy + 8, 2, 1, PAL.red);
      break;
    case 'o':
      R(ctx, cx - 1, hy + 7, 2, 2, PAL.ink);
      break;
    case 'flat':
      R(ctx, cx - 1, hy + 8, 2, 1, PAL.ink);
      break;
    default:
      R(ctx, cx - 1, hy + 8, 2, 1, lip);
  }

  if (acc === 'glasses') {
    for (const lx of [cx - 4, cx + 1]) {
      R(ctx, lx, hy + 4, 3, 1, PAL.ink);
      R(ctx, lx, hy + 6, 3, 1, PAL.ink);
      R(ctx, lx, hy + 5, 1, 1, PAL.ink);
      R(ctx, lx + 2, hy + 5, 1, 1, PAL.ink);
    }
    R(ctx, cx - 1, hy + 5, 2, 1, PAL.ink);
  }
  if (acc === 'sunglasses') {
    R(ctx, cx - 4, hy + 4, 3, 2, PAL.ink);
    R(ctx, cx + 1, hy + 4, 3, 2, PAL.ink);
    R(ctx, cx - 1, hy + 4, 2, 1, PAL.ink);
    R(ctx, cx - 4, hy + 4, 1, 1, PAL.borderLight);
    R(ctx, cx + 1, hy + 4, 1, 1, PAL.borderLight);
  }
  if (acc === 'headphones') {
    R(ctx, cx - 4, hy - 2, 8, 1, PAL.ink);
    R(ctx, cx - 6, hy - 1, 1, 4, PAL.ink);
    R(ctx, cx + 5, hy - 1, 1, 4, PAL.ink);
    R(ctx, cx - 7, hy + 3, 2, 4, PAL.teal);
    R(ctx, cx + 5, hy + 3, 2, 4, PAL.teal);
  }
}

export function drawChair(ctx, cx, dy) {
  R(ctx, cx - 8, dy - 21, 16, 1, PAL.borderLight);
  R(ctx, cx - 9, dy - 20, 18, 20, PAL.border);
  R(ctx, cx - 8, dy - 20, 16, 1, PAL.borderLight);
  R(ctx, cx - 9, dy - 2, 18, 2, shade(PAL.border, -0.05));
}

function drawPaper(ctx, cx, dy, state) {
  const { face, scribble = 0, seed = 1 } = state;
  R(ctx, cx - 4, dy + 6, 9, 1, PAL.paperShade);
  R(ctx, cx - 4, dy + 1, 9, 5, face === 'down' ? PAL.paperBack : PAL.paper);
  if (face === 'down') {
    R(ctx, cx - 1, dy + 2, 3, 3, PAL.teal);
    R(ctx, cx, dy + 3, 1, 1, PAL.white);
    return;
  }
  // scribbles appear as the pencil moves
  const r = rng(seed);
  const n = Math.floor(scribble * 14);
  ctx.fillStyle = '#3a4656';
  for (let i = 0; i < n; i++) ctx.fillRect(cx - 3 + Math.floor(r() * 7), dy + 2 + Math.floor(r() * 3), 1, 1);
}

function drawPencil(ctx, hx, hy, angle) {
  // angle: 0 upright, 1 leaning
  R(ctx, hx + 1 + angle, hy - 3, 1, 3, PAL.pencil);
  R(ctx, hx + 1 + angle, hy - 4, 1, 1, PAL.pink);
  R(ctx, hx + 1, hy, 1, 1, PAL.ink);
}

function drawSign(ctx, cx, sy, value) {
  const w = 28;
  const h = 16;
  const x = cx - w / 2;
  R(ctx, x + 1, sy, w - 2, h, PAL.ink);
  R(ctx, x, sy + 1, w, h - 2, PAL.ink);
  R(ctx, x + 1, sy + 1, w - 2, h - 2, PAL.paper);
  R(ctx, x + 1, sy + h - 2, w - 2, 1, PAL.paperShade);
  if (value === 'coffee') {
    drawIcon(ctx, 'mug', cx - 6, sy + 3);
    return;
  }
  const text = value == null ? '-' : value;
  const s = textWidth(text, 2) <= w - 6 ? 2 : 1;
  const tw = textWidth(text, s);
  drawText(ctx, text, cx - Math.floor(tw / 2), sy + Math.floor((h - 5 * s) / 2) - (s === 2 ? 1 : 0), value === '?' ? PAL.tealDark : PAL.ink, s);
}

// Base body: torso and head. Arms and props are layered by the pose.
function drawBody(ctx, cx, dy, hy, look) {
  const skin = SKINS[look.skin];
  const shirt = SHIRTS[look.shirt];
  const ty = hy + 11;
  R(ctx, cx - 2, hy + 10, 4, 1, shade(skin, -0.12));
  R(ctx, cx - 6, ty, 12, 1, shirt);
  // torso stops one pixel above the desk edge; the desk is drawn first
  R(ctx, cx - 7, ty + 1, 14, dy - ty - 1, shirt);
  R(ctx, cx - 1, ty, 2, 2, shade(skin, -0.05));
  R(ctx, cx - 7, ty + 3, 1, dy - ty - 3, shade(shirt, -0.15));
  R(ctx, cx + 6, ty + 3, 1, dy - ty - 3, shade(shirt, -0.15));
  // a little badge on the mint and sky tops
  if (look.shirt <= 1) R(ctx, cx + 2, ty + 3, 2, 2, PAL.white);
  // head
  R(ctx, cx - 4, hy, 8, 10, skin);
  R(ctx, cx - 5, hy + 1, 10, 8, skin);
  R(ctx, cx - 6, hy + 4, 1, 2, shade(skin, -0.08));
  R(ctx, cx + 5, hy + 4, 1, 2, shade(skin, -0.08));
}

// Hands are a shade darker than the face so a hand on the chin or a cup at the mouth still reads.
const handColor = (skin) => shade(skin, -0.2);

function hand(ctx, x, y, skin) {
  R(ctx, x, y, 2, 2, handColor(skin));
}

/**
 * c: { cx, dy, look, pose, t, seed, scribble, raise, bob, value, face, ... }
 * pose: idle | think | scribble | voted | reveal | shrug | spectator | away | cheer
 */
export function drawCharacter(ctx, c) {
  const look = c.look;
  const skin = SKINS[look.skin];
  const shirt = SHIRTS[look.shirt];
  const sleeve = shade(shirt, -0.1);
  // an arm raised in front of the shirt needs more contrast than one resting on the desk
  const raisedSleeve = shade(shirt, -0.24);
  const t = c.t;
  const { cx, dy } = c;
  const hy = dy - 24 + (c.bob || 0);
  const ty = hy + 11;
  const style = HAIR_STYLES[look.hair];
  const hairColor = HAIR_COLORS[look.hairColor];
  const blink = (t + c.seed * 37) % 4200 < 140;
  const face = { look: 'front', closed: blink, mouth: 'neutral', blush: false, ...(c.face || {}) };

  const behindHair = () => {
    if (style === 'long') R(ctx, cx - 6, hy + 1, 12, 12, shade(hairColor, -0.15));
  };

  behindHair();
  drawBody(ctx, cx, dy, hy, look);

  const pose = c.pose;
  if (pose === 'reveal' || pose === 'cheer') {
    // sign travels from the desk to above the head
    const p = Math.max(0, Math.min(1, c.raise ?? 1));
    const ease = 1 - Math.pow(1 - p, 3);
    const low = dy - 8;
    const high = hy - 19;
    const sy = Math.round(low + (high - low) * ease);
    face.mouth = pose === 'cheer' ? 'open' : p >= 1 ? 'smile' : 'o';
    face.blush = pose === 'cheer';
    drawFace(ctx, cx, hy, look, face);
    drawHair(ctx, cx, hy, style, hairColor, skin);
    if (c.crown) drawCrown(ctx, cx, hy);
    const armTop = sy + 14;
    const armLen = Math.max(2, ty + 3 - armTop);
    R(ctx, cx - 10, armTop, 3, armLen, sleeve);
    R(ctx, cx + 7, armTop, 3, armLen, sleeve);
    drawSign(ctx, cx, sy, c.value);
    hand(ctx, cx - 10, sy + 12, skin);
    hand(ctx, cx + 8, sy + 12, skin);
    return;
  }

  face.mouth = face.mouth === 'neutral' ? (pose === 'voted' ? 'smile' : pose === 'shrug' ? 'flat' : 'neutral') : face.mouth;
  if (pose === 'scribble') face.look = 'down';
  if (pose === 'away') face.closed = true;
  if (pose === 'think') face.look = c.thinkPhase < 0.5 ? 'up' : 'side';
  drawFace(ctx, cx, hy, look, face);
  drawHair(ctx, cx, hy, style, hairColor, skin);
  if (c.crown) drawCrown(ctx, cx, hy);

  if (c.paper) drawPaper(ctx, cx, dy, c.paper);

  switch (pose) {
    case 'scribble': {
      R(ctx, cx - 9, dy + 1, 6, 3, sleeve);
      hand(ctx, cx - 4, dy + 2, skin);
      const wig = Math.floor(t / 70) % 6;
      const hx = cx - 1 + [0, 2, 1, 3, 0, 2][wig];
      const hyy = dy + 2 + [0, 1, 0, 1, 1, 0][wig];
      R(ctx, cx + 4, dy + 1, 5, 3, sleeve);
      R(ctx, hx + 2, hyy, 3, 2, sleeve);
      drawPencil(ctx, hx, hyy, 1);
      hand(ctx, hx, hyy, skin);
      break;
    }
    case 'think': {
      R(ctx, cx - 9, dy + 1, 6, 3, sleeve);
      hand(ctx, cx - 4, dy + 2, skin);
      if (c.thinkPhase < 0.5) {
        // hand on chin
        R(ctx, cx + 5, hy + 10, 2, dy - hy - 9, raisedSleeve);
        R(ctx, cx + 2, hy + 9, 3, 2, handColor(skin));
      } else {
        // tapping the pencil
        const tap = Math.floor(t / 180) % 2;
        R(ctx, cx + 3, dy + 1, 6, 3, sleeve);
        drawPencil(ctx, cx + 2, dy + 1 - tap, 0);
        hand(ctx, cx + 2, dy + 1 - tap, skin);
      }
      break;
    }
    case 'voted':
    case 'idle':
    case 'away':
      R(ctx, cx - 9, dy + 1, 7, 3, sleeve);
      R(ctx, cx + 2, dy + 1, 7, 3, sleeve);
      hand(ctx, cx - 3, dy + 2, skin);
      hand(ctx, cx + 1, dy + 2, skin);
      break;
    case 'shrug':
      R(ctx, cx - 11, ty + 3, 4, 2, sleeve);
      R(ctx, cx + 7, ty + 3, 4, 2, sleeve);
      hand(ctx, cx - 12, ty + 1, skin);
      hand(ctx, cx + 10, ty + 1, skin);
      break;
    case 'spectator': {
      R(ctx, cx - 9, dy + 1, 6, 3, sleeve);
      hand(ctx, cx - 4, dy + 2, skin);
      const sip = (t + c.seed * 91) % 5000 < 1100;
      const mx = sip ? cx + 1 : cx + 3;
      const my = sip ? hy + 7 : dy - 2;
      if (sip) R(ctx, cx + 5, my + 2, 2, dy - my, raisedSleeve);
      else R(ctx, cx + 4, dy + 1, 5, 3, sleeve);
      R(ctx, mx, my, 4, 4, PAL.white);
      R(ctx, mx + 4, my + 1, 1, 2, PAL.white);
      R(ctx, mx, my + 1, 4, 1, PAL.teal);
      if (!sip && Math.floor(t / 400) % 2) R(ctx, mx + 1, my - 2, 1, 1, PAL.secondary);
      else if (!sip) R(ctx, mx + 2, my - 3, 1, 1, PAL.secondary);
      hand(ctx, mx + 3, my + 2, skin);
      break;
    }
  }
}

function drawCrown(ctx, cx, hy) {
  const y = hy - 4;
  R(ctx, cx - 3, y, 1, 1, PAL.gold);
  R(ctx, cx, y, 1, 1, PAL.gold);
  R(ctx, cx + 2, y, 1, 1, PAL.gold);
  R(ctx, cx - 3, y + 1, 6, 2, PAL.gold);
  R(ctx, cx - 3, y + 2, 6, 1, PAL.goldDark);
  R(ctx, cx - 1, y + 1, 1, 1, PAL.red);
}

export function drawBadgeCheck(ctx, x, y) {
  R(ctx, x + 1, y, 7, 9, PAL.ink);
  R(ctx, x, y + 1, 9, 7, PAL.ink);
  R(ctx, x + 1, y + 1, 7, 7, PAL.green);
  R(ctx, x + 2, y + 1, 5, 1, shade(PAL.green, 0.15));
  ctx.fillStyle = PAL.white;
  [
    [6, 3],
    [5, 4],
    [4, 5],
    [3, 4],
    [2, 3],
  ].forEach(([px, py]) => ctx.fillRect(x + px, y + py, 1, 1));
}

export function drawDesk(ctx, x, dy, w) {
  R(ctx, x, dy, w, 7, PAL.border);
  R(ctx, x, dy, w, 1, PAL.borderLight);
  R(ctx, x, dy + 7, w, 1, PAL.wallDark);
  R(ctx, x, dy + 8, w, 11, PAL.sub);
  R(ctx, x, dy + 18, w, 1, PAL.wallDark);
  R(ctx, x + 1, dy + 19, 3, 4, PAL.wallDark);
  R(ctx, x + w - 4, dy + 19, 3, 4, PAL.wallDark);
}

// Standalone preview for the lobby avatar picker. k: ms into the current pose.
export function drawPreview(canvas, look, t, pose = 'idle', k = 0) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cx = Math.floor(canvas.width / 2);
  const dy = canvas.height - 12;
  drawChair(ctx, cx, dy);
  drawDesk(ctx, -1, dy, canvas.width + 2);
  const bob = pose === 'reveal' && k > 300 && k < 450 ? -2 : Math.floor(t / 600) % 2 ? 0 : -1;
  drawCharacter(ctx, {
    cx,
    dy,
    look,
    pose,
    t,
    seed: 3,
    bob,
    raise: k / 380,
    value: '5',
    thinkPhase: (t / 2200) % 1,
    paper: pose === 'spectator' || pose === 'reveal' ? null : { face: pose === 'voted' ? 'down' : 'up', scribble: pose === 'scribble' ? Math.min(1, k / 1300) : 0, seed: 9 },
  });
  if (pose === 'voted') drawBadgeCheck(ctx, cx - 4, dy - 39 + bob);
}
