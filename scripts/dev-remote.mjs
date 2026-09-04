/**
 * Serwer deweloperski interfejsu, ktory rozmawia z WDROZONYM Workerem zamiast z lokalnym.
 *
 * Po co: `wrangler dev` potrzebuje binarki `workerd`, ktorej Windows App Control potrafi nie
 * wpuscic (`spawn UNKNOWN`). Wtedy lokalnie nie da sie ruszyc interfejsu w ogole. Ten skrypt
 * podnosi zwykle Vite z hot-reloadem, ale `/api` i WebSocket kieruje na dzialajace wdrozenie —
 * wiec zmiany w CSS i komponentach widac natychmiast, na prawdziwej grze.
 *
 * Uzycie:
 *   npm run dev:remote
 *   BRIDGE_REMOTE=https://moj-worker.workers.dev npm run dev:remote
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const target =
  process.env.BRIDGE_REMOTE ??
  process.env.VITE_API_TARGET ??
  'https://brydz.uk';

process.env.VITE_API_TARGET = target;

// fileURLToPath, nie URL.pathname: na Windows to drugie daje "/C:/..." i esbuild sklada
// z tego sciezke "C:\C:\Users\..." — konfiguracja sie nie wczytuje.
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

const server = await createServer({ configFile });
await server.listen();

console.log(`\n  Interfejs lokalnie, gra na: ${target}\n`);
server.printUrls();
