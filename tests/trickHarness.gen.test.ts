/**
 * Generator strony kontrolnej do pomiaru WIDOCZNOSCI zakonczonej lewy.
 *
 * Rozgrywanie pelnej partii przegladarka okazalo sie zbyt zawodne, zeby opierac na nim
 * dowod, a sedno bledu lezy w jednym miejscu: czy karty zakonczonej lewy sa widoczne,
 * ZANIM zapali sie sygnal zamiatania. Renderujemy wiec PRAWDZIWY komponent do statycznej
 * strony z PRAWDZIWYM arkuszem stylow i mierzymy `opacity` w przegladarce.
 *
 * Zapisuje `dist/client/trick-harness.html`; pomiar robi `scratchpad/harness_measure.js`.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Trick } from '../src/engine/types';
import { TrickArea } from '../src/client/components/TrickArea';

const LEWA: Trick = {
  leader: 'N',
  winner: 'E',
  cards: [
    { seat: 'N', card: 'SA' },
    { seat: 'E', card: 'H2' },
    { seat: 'S', card: 'D7' },
    { seat: 'W', card: 'CK' },
  ],
};

function widok(winner: 'E' | null): string {
  return renderToStaticMarkup(
    createElement(TrickArea, {
      trick: LEWA,
      viewer: 'S',
      trump: 'N',
      winner,
      vulnerability: 'None',
      boardNumber: 1,
      dealer: 'N',
    }),
  );
}

describe('strona kontrolna widocznosci lewy', () => {
  it('zapisuje strone z obiema fazami: pauza (bez zamiatania) i zamiatanie', () => {
    const assets = join(process.cwd(), 'dist/client/assets');
    const css = readdirSync(assets).find((f) => f.endsWith('.css'));
    expect(css, 'najpierw `npm run build` - potrzebny zbudowany arkusz stylow').toBeTruthy();

    const html = [
      '<!doctype html>',
      '<html lang="pl">',
      '<head><meta charset="utf-8">',
      `<link rel="stylesheet" href="/assets/${css}">`,
      '<style>body{margin:0;background:#12382c;display:flex;gap:40px;padding:40px}',
      '.kadr{width:420px;height:420px;position:relative}</style>',
      '</head><body>',
      `<div class="kadr" id="pauza">${widok(null)}</div>`,
      `<div class="kadr" id="zamiatanie">${widok('E')}</div>`,
      '</body></html>',
    ].join('\n');

    writeFileSync(join(process.cwd(), 'dist/client/trick-harness.html'), html, 'utf8');
    expect(html).toContain('bo-trick__slot');
  });
});
