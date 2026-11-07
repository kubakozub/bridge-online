# Bridge Online

> **Live: [brydz.uk](https://brydz.uk)**
> Open it on two computers: one person creates a table, the other joins with a six
> character code.

Duplicate bridge in the browser **for two people in two different places**. One person
creates a table, the other joins with a six character code. Robots take the empty seats,
so two people are enough to play, not four.

It runs entirely on Cloudflare: a Worker serves the client, and each table is a single
Durable Object that is the only owner of the deal.

## What it does

**The full rules of bridge, not a simplification**

- Bidding with the complete legality rules: sufficiency of a bid, a double only against
  an opponent, a redouble only by the doubled side, and the auction closing after three
  passes.
- Declarer determined by law: the declarer is whichever member of the partnership
  **first** named the suit of the final contract, not whoever bid it last.
- Play: following suit is compulsory, ruffs are handled, the trick goes to the highest
  trump or else the highest card of the suit led, and declarer plays dummy's cards.
- Duplicate scoring: part scores, game and slam bonuses, the insult bonus when doubled,
  the full doubled undertrick ladder, and conversion to IMPs using the WBF table.
- Dealer and vulnerability rotate on the standard 16 board duplicate cycle.
- Claims with opponent acceptance, undo by agreement, and board records in PBN.

**Two people over the network**

- The server is authoritative: a full deal **never** leaves the Durable Object. Each
  player receives their own censored view of the state, so another player's cards cannot
  be read out of the Network tab.
- Reconnect is supported: closing a laptop does not end the board. On rejoining you are
  returned to your seat with the same cards.
- If somebody is gone for more than 45 seconds, a robot covers their seat temporarily so
  the other person is not left waiting.
- Optional per move clock, table chat, and spectators.

**Robots**

Three levels (novice, intermediate, advanced). They bid SAYC (five card majors, 1NT 15
to 17, Stayman, transfers, takeout doubles) and in the play they use standard leads and
defence plus an endgame search.

## Running it locally

```bash
npm install
```

The client and the Worker start together:

```bash
npm run dev
```

Vite serves on `http://localhost:5173` and forwards `/api/*`, the WebSocket included, to
`wrangler dev` on port 8787.

To play against yourself, open the same link in a normal window and in a private window.
Those are two separate identities, so you will be seated in two different chairs.

Tests and type checking:

```bash
npm test
npm run typecheck
```

### If `wrangler dev` will not start

On one development machine `wrangler dev` fails with `spawn UNKNOWN`, because **Windows
App Control blocks `workerd.exe`**, the Cloudflare runtime that wrangler unpacks into
`node_modules`. To confirm that is the cause:

```powershell
& ".\node_modules\@cloudflare\workerd-windows-64\bin\workerd.exe" --version
```

If the answer is that application control policy blocked the file, that is the machine's
security policy rather than a fault in the project. Bundling still works
(`npx wrangler deploy --dry-run` passes), so deploying to Cloudflare succeeds regardless.
For local work there are two routes:

- `npm run dev:client`: the interface alone on Vite. There is no game server, but the
  whole visual layer works, including the deck preview at `/dev/cards.html`.
- `npm run dev:remote`: the interface locally with hot reload, while `/api` and the
  WebSocket are directed at a **deployed** Worker. That is work against the real game
  with no local `workerd`. Point it elsewhere with an environment variable:

  ```bash
  BRIDGE_REMOTE=https://brydz.uk npm run dev:remote
  ```

  > Note: this mode has not been tested end to end. On the machine where it was tried the
  > Vite process got no outbound connection (DNS returned from the discard pool `100::`).
  > The proxy mechanism itself is ordinary Vite configuration, but treat it as unverified
  > until it runs for you.

- `npm test`: the table logic is fully covered by tests that run the Durable Object
  against stubs of the Cloudflare environment (`tests/table.integration.test.ts`), so
  they do not need `workerd` at all.

The durable fix is to have `workerd.exe` allowed in App Control, or to run the project on
a machine without that policy.

## Deploying to Cloudflare

Needed once, to log wrangler in:

```bash
npx wrangler login
```

Or, in CI, through the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment
variables, with a token holding *Workers Scripts: Edit* and *Workers Durable Objects:
Edit*.

Then:

```bash
npm run deploy
```

That builds the client into `dist/client` and pushes the Worker together with its static
assets. Wrangler prints an address of the form
`https://bridge-online.<your-subdomain>.workers.dev`.

Durable Objects with SQLite storage work on the free plan: migration `v1` in
`wrangler.jsonc` creates the `TableDurableObject` class on the first deploy.

### A custom domain

Add this to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "bridge.yourdomain.com", "custom_domain": true }]
```

## Architecture

```
browser A ─┐
           ├─ WebSocket ─→ Worker ─→ Durable Object "ABC123"
browser B ─┘                         (the only copy of the deal anywhere)
```

```
src/
  engine/     the pure rules engine: no I/O, no randomness beyond an explicit seed
    types.ts    the domain contract; the wire format is the engine format ("SA", "3N", "P")
    cards.ts    deck, seeded shuffle, hand evaluation, PBN
    deal.ts     dealer and vulnerability by board number
    auction.ts  the bidding state machine, determining declarer
    play.ts     legality of a card, resolving tricks, hand visibility
    scoring.ts  duplicate scoring, IMPs, matchpoints
    game.ts     the ONLY entry point that changes state: applyAction(state, action)
  bots/       robots: SAYC bidding plus heuristic card play
  server/
    protocol.ts client and server messages
    table.ts    Durable Object: table state, card censoring, clocks, robots
    index.ts    the Worker router plus static assets
  client/     React 18, no additional dependencies
```

The rule that holds it together: **state changes only through `applyAction`**, a pure
function that returns either a new state or an error and never throws. The Durable Object
is a thin layer around it. That is what makes the rules of bridge testable without a
network, and it lets a fuzz test play 150 complete boards while checking after every move
that no card has vanished.

## Graphics

The deck in the repository is generated procedurally:

```bash
npm run cards
```

A preview of every card is at `/dev/cards.html` while the development server runs.

The drawn artwork is produced from the prompt in
[`docs/CLAUDE-DESIGN-PROMPT.md`](docs/CLAUDE-DESIGN-PROMPT.md). Once the files arrive:

```bash
# replace public/cards/sprite.svg, then:
node scripts/embed-sprite.mjs
```

The script checks the integration contract (52 symbols with the right IDs, a `viewBox` of
`0 0 240 336`, no scripts and no external references) and refuses to embed artwork that
breaks it.

## Limitations worth knowing

- The robots play correctly and sensibly, but they are not a GIB class engine: they do
  not compute double dummy play outside the endgame.
- Rubber scoring is simplified to the split above and below the line. Duplicate mode and
  IMPs are complete.
- Matchpoints are computed against this one table, so they only start to mean something
  once several tables are recorded.

## For Polish players

Gra jest po polsku i działa na [brydz.uk](https://brydz.uk).
