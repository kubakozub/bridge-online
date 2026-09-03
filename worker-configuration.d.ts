/**
 * Bindings declared in wrangler.jsonc.
 *
 * Normally `wrangler types` generates this file, but that command shells out to a helper that
 * fails on this machine (`spawn UNKNOWN`), so it is maintained by hand. Keep it in sync with
 * wrangler.jsonc whenever a binding is added.
 */

interface Env {
  /** One Durable Object per room code - the authoritative table. */
  TABLES: DurableObjectNamespace;
  /** The built client in dist/client, served by the Workers static-assets binding. */
  ASSETS: Fetcher;
  PUBLIC_APP_NAME: string;
}

declare namespace Cloudflare {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Env extends globalThis.Env {}
}
