/**
 * Worker entry point.
 *
 * Two jobs: serve the built client from the static-assets binding, and route the handful of
 * /api/* requests to the right TableDurableObject. All game logic lives in the DO - this file
 * deliberately holds no state.
 */

import { TableDurableObject } from './table';
import type { CreateTableRequest, CreateTableResponse, TableSettings } from './protocol';

export { TableDurableObject };

/**
 * Room-code alphabet with the ambiguous glyphs removed (no O/0, no I/1/L).
 * Codes get read aloud over the phone by two people in different cities, so this matters.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/** Accepts a bare code or a pasted URL, and normalises case. */
function normaliseRoomCode(input: string): string | null {
  const match = input.toUpperCase().match(/[A-Z0-9]{4,8}/g);
  if (!match) return null;
  const candidate = match[match.length - 1];
  if (candidate.length !== CODE_LENGTH) return null;
  if (![...candidate].every((ch) => CODE_ALPHABET.includes(ch))) return null;
  return candidate;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: { 'cache-control': 'no-store', ...(init?.headers ?? {}) },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Jeden kanoniczny adres. Obie domeny sa rownorzednymi wejsciami do Workera, wiec bez tego
    // ta sama gra zyla pod dwoma adresami naraz, a aplikacja i tak generowala linki na apex —
    // gracz, ktory wszedl przez www, wysylal partnerowi link na inna domene niz sam ogladal.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // --- API ---------------------------------------------------------------

    if (pathname === '/api/health') {
      return json({ ok: true, service: 'bridge-online', now: Date.now() });
    }

    // Create a table. Returns the code the second player types in.
    if (pathname === '/api/tables' && request.method === 'POST') {
      let body: CreateTableRequest = {};
      try {
        body = (await request.json()) as CreateTableRequest;
      } catch {
        // An empty body is fine - defaults apply.
      }

      const roomCode = generateRoomCode();
      const id = env.TABLES.idFromName(roomCode);
      const stub = env.TABLES.get(id);

      if (body.settings) {
        await stub.fetch(
          new Request(`https://table/settings?room=${roomCode}`, {
            method: 'POST',
            body: JSON.stringify(body.settings satisfies Partial<TableSettings>),
            headers: { 'content-type': 'application/json' },
          })
        );
      }

      const response: CreateTableResponse = {
        roomCode,
        joinUrl: `${url.origin}/#/t/${roomCode}`,
      };
      return json(response, { status: 201 });
    }

    // Table info, used by the lobby to tell you whether a code is real before you join.
    const infoMatch = pathname.match(/^\/api\/tables\/([A-Za-z0-9]+)$/);
    if (infoMatch && request.method === 'GET') {
      const roomCode = normaliseRoomCode(infoMatch[1]);
      if (!roomCode) return json({ error: 'Nieprawidłowy kod stołu.' }, { status: 400 });

      const stub = env.TABLES.get(env.TABLES.idFromName(roomCode));
      return stub.fetch(new Request(`https://table/info?room=${roomCode}`));
    }

    // The game socket.
    const wsMatch = pathname.match(/^\/api\/table\/([A-Za-z0-9]+)\/ws$/);
    if (wsMatch) {
      const roomCode = normaliseRoomCode(wsMatch[1]);
      if (!roomCode) return new Response('Nieprawidłowy kod stołu.', { status: 400 });

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }

      const stub = env.TABLES.get(env.TABLES.idFromName(roomCode));
      return stub.fetch(new Request(`https://table/ws?room=${roomCode}`, request));
    }

    if (pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, { status: 404 });
    }

    // --- Static client ------------------------------------------------------
    // Routing jest hashowy (/#/t/ABC123), wiec kazde wejscie trafia na "/" i zadna gleboka sciezka
    // nie wymaga przepisywania. `not_found_handling: "none"` sprawia, ze brakujacy zasob wraca jako
    // 404 — dzieki temu literowka w sciezce albo zgubiony plik nie udaja poprawnej strony.
    const odpowiedz = await env.ASSETS.fetch(request);
    if (odpowiedz.status !== 404) return odpowiedz;

    return new Response(
      '<!doctype html><html lang="pl"><meta charset="utf-8">' +
        '<title>Nie ma takiej strony — Bridge Online</title>' +
        '<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0d2b22;' +
        'color:#f2f6f3;font:16px/1.6 system-ui,sans-serif;text-align:center}a{color:#f0c05a}</style>' +
        '<div><h1 style="margin:0 0 .5rem;font-size:1.4rem">Nie ma takiej strony</h1>' +
        '<p style="margin:0 0 1rem;color:#b9c9c1">Stoly maja adres w postaci <code>/#/t/KOD</code>.</p>' +
        '<p><a href="/">Wroc do lobby</a></p></div></html>',
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  },
} satisfies ExportedHandler<Env>;
