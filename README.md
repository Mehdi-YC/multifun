# MultiFun

A pixel-art multiplayer game platform: simple profiles, lobbies by join code, and three games
racing to be fun.

| Game              | Genre                          | Status      |
| ----------------- | ------------------------------ | ----------- |
| **GeoDash Party** | Multiplayer Geometry Dash-like | In progress |
| **Turbo Kart**    | Top-down kart racer            | Planned     |
| **Pixel Brawl**   | Platform fighter               | Planned     |

See [`plan.md`](./plan.md) for the full architecture, netcode design and milestone plan.

## Stack

SvelteKit (Svelte 5, runes) · TypeScript · Tailwind 4 · Canvas 2D game engine (in-repo) ·
WebSockets (in-process realtime server) · Drizzle + SQLite · better-auth · Vitest + Playwright +
Storybook · bun

## Develop

```sh
bun install
bun run db:generate && bun run db:migrate   # first time / after schema changes
bun run dev
```

- App: http://localhost:5173
- Realtime: ws://localhost:5173/realtime (mounted on the same dev server)
- Storybook: `bun run storybook`

## Test

```sh
bun run test:unit     # vitest (node sims + browser components + storybook)
bun run check         # svelte-check
bun run lint          # prettier + eslint
bun run test:e2e      # playwright
```

## Production

```sh
bun run build         # vite build + realtime bundle
bun run start         # node server.js — web + websocket on one port
```
