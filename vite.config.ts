import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Pinned to this file's directory so the config works when Vite is invoked from elsewhere.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // Mapy zrodel NIE ida na produkcje. Publiczny /assets/*.js.map wystawial caly TypeScript
    // klienta i silnika (880 kB, z kompletem sourcesContent) — w tym protokol wire i logike botow.
    // 'hidden' NIE wystarcza: usuwa tylko odsylacz z bundla, a sam plik dalej trafia do wydania
    // i da sie go pobrac, zgadujac nazwe. Do debugowania sluzy tryb deweloperski.
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      /*
       * Dokad ida /api i WebSocket. Domyslnie do `wrangler dev`.
       *
       * VITE_API_TARGET pozwala wskazac WDROZONEGO Workera zamiast lokalnego. To nie jest
       * wygoda, tylko obejscie: na maszynach, gdzie App Control blokuje `workerd.exe`,
       * `wrangler dev` w ogole nie wstaje, a bez tego nie da sie tknac interfejsu lokalnie.
       * Patrz `npm run dev:remote`.
       */
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: true,
        ws: true,
      },
    },
  },
});
