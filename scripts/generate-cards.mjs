/**
 * Generates the playing-card artwork used by the client.
 *
 * Output:
 *   public/cards/sprite.svg         - a standalone sprite (handy for the design handoff)
 *   src/client/assets/cardSprite.ts - the same markup as a TS string, inlined by the app so
 *                                     that page-level CSS custom properties can recolour it
 *                                     (external <use> references are not styleable).
 *
 * Every visual constant lives up top, so the deck Claude Design produces can be dropped in by
 * swapping paths/colours here rather than by rewriting the layout maths.
 *
 * Run: npm run cards
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Geometry + theme
// ---------------------------------------------------------------------------

const W = 240;
const H = 336; // 2.5 x 3.5 poker ratio
const RADIUS = 16;

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/**
 * Colours are emitted as CSS custom properties with a literal fallback, so the same sprite
 * renders as a classic two-colour deck or a four-colour deck depending on the page's CSS.
 */
const SUIT_FILL = {
  S: 'var(--suit-spade, #16161d)',
  H: 'var(--suit-heart, #c8102e)',
  D: 'var(--suit-diamond, #c8102e)',
  C: 'var(--suit-club, #16161d)',
};

// Suit glyphs normalised to a 100x100 box.
const GLYPH = {
  S: '<path d="M50 5 C 61 27, 97 41, 97 61 C 97 76, 85 86, 72 86 C 63 86, 56 81, 52 74 C 52 82, 55 90, 62 96 L 38 96 C 45 90, 48 82, 48 74 C 44 81, 37 86, 28 86 C 15 86, 3 76, 3 61 C 3 41, 39 27, 50 5 Z"/>',
  H: '<path d="M50 94 C 18 70, 3 51, 3 33 C 3 16, 15 5, 30 5 C 40 5, 47 10, 50 18 C 53 10, 60 5, 70 5 C 85 5, 97 16, 97 33 C 97 51, 82 70, 50 94 Z"/>',
  D: '<path d="M50 3 L 94 50 L 50 97 L 6 50 Z"/>',
  C: '<g><circle cx="50" cy="27" r="21"/><circle cx="25" cy="59" r="21"/><circle cx="75" cy="59" r="21"/><path d="M44 55 C 44 74, 41 87, 34 96 L 66 96 C 59 87, 56 74, 56 55 Z"/></g>',
};

/** Court-card silhouettes, normalised to a 100x100 box. Deliberately simple and heraldic. */
const COURT = {
  K: '<path d="M12 74 L 6 24 L 28 42 L 50 10 L 72 42 L 94 24 L 88 74 Z M14 80 H86 V92 H14 Z"/>',
  Q: '<path d="M50 8 a9 9 0 1 1 -0.1 0 Z M26 28 a7 7 0 1 1 -0.1 0 Z M74 28 a7 7 0 1 1 -0.1 0 Z M16 86 C 16 62, 31 44, 50 44 C 69 44, 84 62, 84 86 Z M10 90 H90 V97 H10 Z"/>',
  J: '<path d="M50 4 C 62 20, 70 32, 70 46 C 70 58, 62 66, 54 70 L 54 92 H 46 L 46 70 C 38 66, 30 58, 30 46 C 30 32, 38 20, 50 4 Z M22 46 C 10 52, 6 66, 12 80 C 22 76, 28 64, 26 52 Z M78 46 C 90 52, 94 66, 88 80 C 78 76, 72 64, 74 52 Z"/>',
};

/**
 * Classic pip layouts. Each entry is [column, row, flipped] with column/row expressed as a
 * fraction of the card face and `flipped` meaning the pip is rotated 180 degrees, exactly as on
 * a real deck.
 */
const L = 0.28;
const C = 0.5;
const R = 0.72;

const PIP_LAYOUT = {
  '2': [[C, 0.2, 0], [C, 0.8, 1]],
  '3': [[C, 0.2, 0], [C, 0.5, 0], [C, 0.8, 1]],
  '4': [[L, 0.2, 0], [R, 0.2, 0], [L, 0.8, 1], [R, 0.8, 1]],
  '5': [[L, 0.2, 0], [R, 0.2, 0], [C, 0.5, 0], [L, 0.8, 1], [R, 0.8, 1]],
  '6': [[L, 0.2, 0], [R, 0.2, 0], [L, 0.5, 0], [R, 0.5, 0], [L, 0.8, 1], [R, 0.8, 1]],
  '7': [[L, 0.2, 0], [R, 0.2, 0], [C, 0.35, 0], [L, 0.5, 0], [R, 0.5, 0], [L, 0.8, 1], [R, 0.8, 1]],
  '8': [[L, 0.2, 0], [R, 0.2, 0], [C, 0.35, 0], [L, 0.5, 0], [R, 0.5, 0], [C, 0.65, 1], [L, 0.8, 1], [R, 0.8, 1]],
  '9': [[L, 0.2, 0], [R, 0.2, 0], [L, 0.4, 0], [R, 0.4, 0], [C, 0.5, 0], [L, 0.6, 1], [R, 0.6, 1], [L, 0.8, 1], [R, 0.8, 1]],
  T: [[L, 0.2, 0], [R, 0.2, 0], [C, 0.3, 0], [L, 0.4, 0], [R, 0.4, 0], [L, 0.6, 1], [R, 0.6, 1], [C, 0.7, 1], [L, 0.8, 1], [R, 0.8, 1]],
};

const PIP = 54; // pip box size on the face
const INDEX_PIP = 32; // pip box size in the corner index

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const rankLabel = (r) => (r === 'T' ? '10' : r);

function round(n, p = 2) {
  return Number(n.toFixed(p));
}

/** Places a suit glyph with its 100x100 box scaled to `size` and centred on (cx, cy). */
function pip(suit, cx, cy, size, flipped = false, fill = null) {
  const s = size / 100;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const rot = flipped ? `rotate(180 ${round(cx)} ${round(cy)}) ` : '';
  const colour = fill === null ? SUIT_FILL[suit] : fill;
  return `<g transform="${rot}translate(${round(x)} ${round(y)}) scale(${round(s, 4)})" fill="${colour}">${GLYPH[suit]}</g>`;
}

/** The rank + pip index printed in two opposite corners of every card. */
function cornerIndex(rank, suit) {
  const label = rankLabel(rank);
  const fontSize = label === '10' ? 48 : 56;
  const one =
    `<text x="0" y="0" font-size="${fontSize}" font-weight="700" text-anchor="middle" ` +
    `font-family="Georgia, 'Times New Roman', serif" fill="${SUIT_FILL[suit]}">${label}</text>` +
    pip(suit, 0, 40, INDEX_PIP);
  return (
    `<g transform="translate(32 58)">${one}</g>` +
    `<g transform="translate(${W - 32} ${H - 58}) rotate(180)">${one}</g>`
  );
}

function faceBackground() {
  return (
    `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${RADIUS}" ry="${RADIUS}" ` +
    `fill="var(--card-face, #fdfdfb)" stroke="var(--card-edge, rgba(20,20,30,.22))" stroke-width="3"/>`
  );
}

function numberCard(rank, suit) {
  const pips = PIP_LAYOUT[rank]
    .map(([cx, cy, flip]) => pip(suit, cx * W, cy * H, PIP, !!flip))
    .join('');
  return faceBackground() + cornerIndex(rank, suit) + pips;
}

function aceCard(suit) {
  return faceBackground() + cornerIndex('A', suit) + pip(suit, W / 2, H / 2, 118);
}

function courtCard(rank, suit) {
  const s = 0.74;
  const size = 100 * s;
  // Two mirrored halves, the way a real court card reads from either end.
  const half = (flip) => {
    const cy = flip ? H * 0.72 : H * 0.28;
    const rot = flip ? `rotate(180 ${W / 2} ${round(cy)}) ` : '';
    return (
      `<g transform="${rot}translate(${round(W / 2 - size / 2)} ${round(cy - size / 2)}) scale(${round(s, 4)})" ` +
      `fill="${SUIT_FILL[suit]}" opacity="0.92">${COURT[rank]}</g>`
    );
  };
  const frame =
    `<rect x="42" y="46" width="${W - 84}" height="${H - 92}" rx="10" fill="none" ` +
    `stroke="${SUIT_FILL[suit]}" stroke-width="2.5" opacity="0.5"/>` +
    `<line x1="42" y1="${H / 2}" x2="${W - 42}" y2="${H / 2}" stroke="${SUIT_FILL[suit]}" ` +
    `stroke-width="2.5" opacity="0.3"/>`;
  return (
    faceBackground() +
    frame +
    half(false) +
    half(true) +
    pip(suit, W / 2, H / 2 - 26, 30) +
    pip(suit, W / 2, H / 2 + 26, 30, true) +
    cornerIndex(rank, suit)
  );
}

function cardFace(rank, suit) {
  if (rank === 'A') return aceCard(suit);
  if (rank === 'J' || rank === 'Q' || rank === 'K') return courtCard(rank, suit);
  return numberCard(rank, suit);
}

function cardBack() {
  const waves = Array.from({ length: 14 }, (_, i) => {
    const y = 26 + i * 21;
    return `<path d="M20 ${y} q 25 -13 50 0 t 50 0 t 50 0 t 50 0"/>`;
  }).join('');

  const centrePips = SUITS.map((s, i) => {
    const angle = (i * Math.PI) / 2 - Math.PI / 2;
    const cx = W / 2 + Math.cos(angle) * 22;
    const cy = H / 2 + Math.sin(angle) * 22;
    return pip(s, cx, cy, 24, false, 'var(--card-back-ink, rgba(255,255,255,.85))');
  }).join('');

  return (
    `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${RADIUS}" ry="${RADIUS}" ` +
    `fill="var(--card-back, #123c5a)" stroke="var(--card-edge, rgba(20,20,30,.22))" stroke-width="3"/>` +
    `<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="${RADIUS - 6}" fill="none" ` +
    `stroke="var(--card-back-ink, rgba(255,255,255,.5))" stroke-width="2"/>` +
    `<g fill="none" stroke="var(--card-back-ink, rgba(255,255,255,.26))" stroke-width="2" ` +
    `clip-path="inset(14px round 10px)">${waves}</g>` +
    `<circle cx="${W / 2}" cy="${H / 2}" r="46" fill="var(--card-back, #123c5a)" ` +
    `stroke="var(--card-back-ink, rgba(255,255,255,.5))" stroke-width="2"/>` +
    centrePips
  );
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function buildSprite() {
  const symbols = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      symbols.push(
        `<symbol id="card-${suit}${rank}" viewBox="0 0 ${W} ${H}">${cardFace(rank, suit)}</symbol>`
      );
    }
  }

  symbols.push(`<symbol id="card-back" viewBox="0 0 ${W} ${H}">${cardBack()}</symbol>`);

  // Bare suit glyphs, reused by the bidding box, the auction grid and the scoreboard.
  for (const suit of SUITS) {
    symbols.push(
      `<symbol id="suit-${suit}" viewBox="0 0 100 100"><g fill="${SUIT_FILL[suit]}">${GLYPH[suit]}</g></symbol>`,
      `<symbol id="suit-${suit}-mono" viewBox="0 0 100 100"><g fill="currentColor">${GLYPH[suit]}</g></symbol>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true" ` +
    `data-generated="npm run cards">\n${symbols.join('\n')}\n</svg>\n`
  );
}

const sprite = buildSprite();

const svgPath = resolve(ROOT, 'public/cards/sprite.svg');
mkdirSync(dirname(svgPath), { recursive: true });
writeFileSync(svgPath, sprite, 'utf8');

const tsPath = resolve(ROOT, 'src/client/assets/cardSprite.ts');
mkdirSync(dirname(tsPath), { recursive: true });
writeFileSync(
  tsPath,
  '// AUTO-GENERATED by scripts/generate-cards.mjs - do not edit by hand. Run: npm run cards\n' +
    `export const CARD_SPRITE = ${JSON.stringify(sprite)};\n\n` +
    `export const CARD_WIDTH = ${W};\n` +
    `export const CARD_HEIGHT = ${H};\n` +
    `export const CARD_ASPECT = ${W} / ${H};\n` +
    `export const CARD_VIEWBOX = '0 0 ${W} ${H}';\n`,
  'utf8'
);

console.log(
  `cards: wrote ${(sprite.length / 1024).toFixed(1)} KB sprite (52 faces + back + 8 suit glyphs)`
);
console.log(`  -> ${svgPath}`);
console.log(`  -> ${tsPath}`);
