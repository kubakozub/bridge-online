/**
 * Importuje paczke grafiki z Claude Design do repozytorium.
 *
 *   node scripts/import-art.mjs <katalog-z-rozpakowana-paczka>
 *
 * Katalog musi zawierac `public/art/*.svg` + `manifest.json`; opcjonalnie `public/art/og-image.png`
 * i `public/cards/sprite.svg` (talia — Pakiet 1).
 *
 * Co robi i DLACZEGO:
 *
 * 1. Wycina metadane C2PA. Kazdy plik z Claude Design niesie w `<metadata>` podpis pochodzenia
 *    (~7,7 KB base64) — w `avatar-01.svg` na 8193 bajty rysunek to 457. Grafika jest wstrzykiwana
 *    inline do bundla (patrz embed-art.mjs), wiec bez tego kroku 30 plikow dolozyloby ~230 KB
 *    czystego szumu do JavaScriptu. Podpis nic nie daje w DOM-ie; zostaje w archiwum zrodlowym.
 *
 * 2. Waliduje kontrakt z docs/CLAUDE-DESIGN-PROMPT.md, sekcja 5: brak <script>, <style>, rastrow,
 *    <foreignObject>, odwolan zewnetrznych, tekstu nie na krzywych; `viewBox` na root albo na
 *    kazdym <symbol>. Odmawia importu pliku, ktory to lamie — polowa paczki w repo jest gorsza
 *    niz zadna, bo <use href="#id"> po cichu renderuje pustke.
 *
 * 3. Kopiuje na wlasciwe miejsca: art do public/art, favicony i og-image do korzenia public
 *    (tak odwoluje sie do nich index.html), talie do public/cards.
 *
 * Talie DODATKOWO sprawdza embed-sprite.mjs (52 ID + viewBox 240x336). Tu tylko kopiujemy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ? resolve(process.argv[2]) : null;

if (!SRC || !existsSync(join(SRC, 'public', 'art'))) {
  console.error('uzycie: node scripts/import-art.mjs <katalog z rozpakowana paczka (zawiera public/art)>');
  process.exit(2);
}

const SRC_ART = join(SRC, 'public', 'art');
const DST_ART = join(ROOT, 'public', 'art');
mkdirSync(DST_ART, { recursive: true });

// --- czyszczenie ------------------------------------------------------------------------------

/** Usuwa metadane C2PA i nic wiecej: rysunek zostaje bajt w bajt. */
export function stripProvenance(svg) {
  return svg
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
    .replace(/\s+xmlns:c2pa="[^"]*"/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

// --- walidacja ------------------------------------------------------------------------------

/** Zwraca liste naruszen kontraktu; pusta = plik czysty. */
export function contractProblems(svg, name) {
  const p = [];
  if (/<script/i.test(svg)) p.push('zawiera <script>');
  if (/<style/i.test(svg)) p.push('zawiera <style>');
  if (/<image/i.test(svg)) p.push('zawiera raster <image>');
  if (/<foreignObject/i.test(svg)) p.push('zawiera <foreignObject>');
  if (/href\s*=\s*["']https?:/i.test(svg)) p.push('odwoluje sie do adresu zewnetrznego');
  if (/@font-face/i.test(svg)) p.push('osadza @font-face');
  if (/<text[\s>]/i.test(svg)) p.push('ma <text> — napisy mialy byc na krzywych');
  if (/<metadata/i.test(svg)) p.push('metadane nie zostaly wyciete');

  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  if (!root) p.push('brak elementu <svg>');
  const symbols = [...svg.matchAll(/<symbol\b([^>]*)>/g)];
  if (symbols.length === 0) {
    if (!/viewBox="/.test(root)) p.push('root <svg> bez viewBox');
  } else {
    for (const m of symbols) {
      const id = m[1].match(/\bid="([^"]+)"/)?.[1];
      if (!id) p.push('<symbol> bez id');
      else if (!/viewBox="/.test(m[1])) p.push(`symbol ${id} bez viewBox`);
    }
  }
  return p;
}

// --- import ---------------------------------------------------------------------------------

const manifestPath = join(SRC_ART, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('brak public/art/manifest.json w paczce');
  process.exit(2);
}

const rows = [];
let failed = 0;

for (const file of readdirSync(SRC_ART).filter((f) => f.endsWith('.svg')).sort()) {
  const raw = readFileSync(join(SRC_ART, file), 'utf8');
  const clean = stripProvenance(raw);
  const problems = contractProblems(clean, file);
  if (problems.length) {
    failed += 1;
    rows.push({ file, before: raw.length, after: clean.length, status: 'ODRZUCONY: ' + problems.join('; ') });
    continue;
  }
  writeFileSync(join(DST_ART, file), clean + '\n', 'utf8');
  rows.push({ file, before: raw.length, after: clean.length, status: 'ok' });
}

copyFileSync(manifestPath, join(DST_ART, 'manifest.json'));

// Favicony i OG w korzeniu public — tak sa podpiete w index.html.
for (const f of ['favicon.svg', 'favicon-mono.svg']) {
  const src = join(DST_ART, f);
  if (existsSync(src)) copyFileSync(src, join(ROOT, 'public', f));
}
const og = join(SRC_ART, 'og-image.png');
if (existsSync(og)) {
  copyFileSync(og, join(ROOT, 'public', 'og-image.png'));
  rows.push({ file: 'og-image.png', before: statSync(og).size, after: statSync(og).size, status: 'ok (raster, bez zmian)' });
}

// Talia (Pakiet 1), jesli jest w paczce. Pelny kontrakt talii sprawdza embed-sprite.mjs.
const deck = join(SRC, 'public', 'cards', 'sprite.svg');
if (existsSync(deck)) {
  const raw = readFileSync(deck, 'utf8');
  const clean = stripProvenance(raw);
  const problems = contractProblems(clean, 'sprite.svg');
  if (problems.length) {
    failed += 1;
    rows.push({ file: 'cards/sprite.svg', before: raw.length, after: clean.length, status: 'ODRZUCONY: ' + problems.join('; ') });
  } else {
    mkdirSync(join(ROOT, 'public', 'cards'), { recursive: true });
    writeFileSync(join(ROOT, 'public', 'cards', 'sprite.svg'), clean + '\n', 'utf8');
    rows.push({ file: 'cards/sprite.svg', before: raw.length, after: clean.length, status: 'ok → teraz: node scripts/embed-sprite.mjs' });
  }
}

// --- raport ---------------------------------------------------------------------------------

const kb = (n) => (n / 1024).toFixed(1).padStart(6) + ' KB';
console.log('plik'.padEnd(24), 'przed'.padStart(9), 'po'.padStart(9), ' status');
let before = 0;
let after = 0;
for (const r of rows) {
  before += r.before;
  after += r.after;
  console.log(r.file.padEnd(24), kb(r.before), kb(r.after), ' ' + r.status);
}
console.log('razem'.padEnd(24), kb(before), kb(after), ` (${Math.round((1 - after / before) * 100)}% mniej)`);

if (failed) {
  console.error(`\n${failed} plik(ow) odrzuconych — patrz docs/CLAUDE-DESIGN-PROMPT.md, sekcja 5.`);
  process.exit(1);
}
