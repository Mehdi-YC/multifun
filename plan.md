# MultiFun — Pixel Art Multiplayer Game Platform

> Status: living planning document. Update it as milestones land.
> Stack baseline: SvelteKit (Svelte 5, runes) + TypeScript + Tailwind 4 + Drizzle/SQLite + better-auth + Vitest + Playwright + Storybook, package manager: bun.

---

## 1. Vision

A single web platform where players create a simple profile (username + pixel avatar), hang out in
lobbies, and play three multiplayer games together:

| Working title     | Genre                          | Inspiration             | Priority |
| ----------------- | ------------------------------ | ----------------------- | -------- |
| **Pixel Tanks**   | Top-down tank arena battle     | Battle City / Combat    | 1st game |
| **GeoDash Party** | Multiplayer Geometry Dash-like | Geometry Dash           | 2nd      |
| **Turbo Kart**    | Top-down kart racer            | Super Mario Kart (SNES) | 3rd      |
| **Pixel Brawl**   | Platform fighter               | Brawlhalla / Smash      | 4th      |

(Echo Arena — the platform's netcode test chamber — stays playable alongside them.)

Guiding principles:

- **Pixel-perfect presentation.** Fixed internal resolution, integer-scaled canvas,
  `image-rendering: pixelated`, hand-generated sprites, chunky UI font, consistent palette per game
  - platform chrome.
- **Lobby-first multiplayer.** Every game starts from a lobby (create / join by code / public list).
  The lobby is the social hub: ready states, chat, host controls, rematch.
- **Playable over perfect.** Every phase ends with something fun and multiplayer-playable. Polish is
  scheduled, not accidental.
- **Deterministic-first netcode.** Games simulate the same way on client and server so results are
  verifiable and cheats are detectable.

### Explicitly out of scope (for now)

Mobile-first touch UX (keyboard + gamepad first, touch later), monetization, real-time voice,
matchmaking/ranked ladder (phase 4), UGC level sharing portal (level editor exists in-game later),
native apps.

---

## 2. Architecture Overview

One Node process serves the web app **and** the realtime WebSocket layer. Shared TypeScript types
flow between DB → server → client for protocol and game logic.

```
Browser (SvelteKit client)
 ├── Svelte UI (pixel design system, lobby UI, profile)
 ├── Canvas 2D game runtimes (shared engine: loop/scene/input/audio/pixel)
 └── RealtimeClient (WebSocket, reconnect, ack/req, state patches)
            │  wss://host/realtime
            ▼
Node server (adapter-node + custom server entry)
 ├── SvelteKit handler (SSR, routes, better-auth)
 └── RealtimeServer (ws)
      ├── ConnectionManager (auth handshake, heartbeat, per-conn send queue)
      ├── RoomManager
      │    ├── LobbyRoom  (presence, chat, ready state, host, game launch)
      │    └── GameRoom   (game session: inputs, snapshots, events, results)
      └── GameHost (server-side deterministic sim for validation/authority)
            │
            ▼
      Drizzle + SQLite (better-sqlite3)  — profiles, lobbies, matches, scores
```

### Why WS inside SvelteKit (decision)

- Single deployable, shared domain types, no cross-service auth dance.
- SvelteKit has no native WS support, so:
  - **Dev:** a tiny Vite plugin (`src/lib/server/realtime/vite-plugin.ts`) hooks
    `server.httpServer.on('upgrade')` for the `/realtime` path and hands it to the same
    `RealtimeServer` used in prod.
  - **Prod:** switch `adapter-auto` → `adapter-node`, entry `server.js` mounts
    `@sveltejs/kit/node` handler + `ws` upgrade on the same HTTP server.
- **Fallback (documented risk):** if the upgrade wiring fights the toolchain, run `RealtimeServer`
  as a second tiny process on its own port and proxy `/realtime` to it. The protocol and room code
  are identical either way; only bootstrapping changes.

### Realtime protocol (v1)

Transport: JSON envelopes over WS (binary later if profiling demands it).

```ts
// client → server
{ t: 'hello',      id?: number, d: { token: string } }            // session auth on connect
{ t: 'req',        id:  number, d: { t: string, d?: unknown } }   // request/ack pattern
{ t: 'input',      d: { matchId: string, tick: number, seq: number, keys: number } }
{ t: 'chat',       d: { lobbyId: string, text: string } }
{ t: 'ping',       d: { ts: number } }

// server → client
{ t: 'welcome',    d: { userId: string, sessionId: string, serverTick: number } }
{ t: 'ack',        id:  number, ok: boolean, d?: unknown, err?: { code: string, msg: string } }
{ t: 'lobby.state', d: LobbySnapshot }          // full snapshot on join/change
{ t: 'presence',   d: { lobbyId: string, users: Presence[] } }
{ t: 'chat.msg',   d: { lobbyId: string, from: string, text: string, ts: number } }
{ t: 'game.start', d: { matchId: string, gameId: GameId, seed: number, players: PlayerSlot[], startAt: number } }
{ t: 'game.snap',  d: { matchId: string, tick: number, state: GameStatePatch } }   // kart/brawl
{ t: 'game.event', d: { matchId: string, tick: number, ev: GameEvent } }           // deaths, finish, hits
{ t: 'game.end',   d: { matchId: string, results: MatchResult[] } }
{ t: 'err',        d: { code: string, msg: string } }
```

Rules:

- Every `req` gets exactly one `ack` (timeout 5s client-side, exponential reconnect backoff).
- All server broadcasts are scoped to a room; a connection only receives rooms it joined.
- Heartbeat: client `ping` every 10s, server drops connections silent for 30s.
- Messages validated with **zod** on the server (never trust the client).
- Version field in `hello`; mismatched clients get a "refresh required" error.

### Game module contract

Each game is a self-contained module the platform can host:

```ts
interface GameModule {
	id: GameId; // 'geodash' | 'kart' | 'brawl'
	createClient(ctx: GameContext): GameClient; // rendering + input + prediction
	createSim(seed: number, config: GameConfig): GameSim; // deterministic, used client & server
	defaults: GameConfig;
	minPlayers: number;
	maxPlayers: number;
}

interface GameSim {
	tick(inputs: Map<PlayerId, InputFrame>): void; // fixed timestep
	events: GameEvent[]; // drained each tick
	snapshot(): GameStatePatch;
	restore(state: unknown): void;
	finished: boolean;
}
```

Shared engine (`src/lib/game/engine`) provides: fixed-timestep loop w/ interpolation, scene stack,
input (keyboard + gamepad + replayable input frames), camera, sprite/atlas blitting, particles,
tweening, WebAudio SFX (synthesized chip sounds) + music (looped sample), text rendering with pixel
font, screen shake, transition wipes.

---

## 3. Project Structure

```
src/
  app.d.ts, app.html, hooks.server.ts
  routes/
    +layout.svelte                 # app chrome, nav, toasts
    +page.svelte                   # landing / game picker
    login/  signup/                # better-auth pages (replaces demo routes)
    profile/[username]/+page.svelte
    profile/edit/+page.svelte      # avatar builder, display name, bio
    play/[gameId]/+page.svelte     # game shell: lobby list → lobby → match
    lobby/[code]/+page.svelte      # lobby room UI
    leaderboard/[gameId]/+page.svelte
    demo/**                        # scaffold demos (deleted in Phase 0 cleanup)
  lib/
    server/
      auth.ts
      db/
        index.ts  schema.ts        # platform tables
        auth.schema.ts             # generated better-auth tables
      realtime/
        vite-plugin.ts             # dev WS upgrade hook
        server.ts                  # RealtimeServer bootstrap (dev + prod)
        connection.ts  rooms.ts  lobby-room.ts  game-room.ts
        protocol.ts                # zod schemas + types (shared with client)
      lobby.ts  matches.ts  scores.ts   # domain services
    game/
      engine/                      # loop, scene, input, camera, gfx, particles, audio, tween
      netcode/                     # realtime client, prediction/replay helpers, interpolation
      geodash/                     # sim/ + render/ + levels/ + editor/
      kart/                        # sim/ + render/ + tracks/ + ai/
      brawl/                       # sim/ + render/ + stages/
      assets/                      # generated sprites, palettes, level JSON
    ui/                            # pixel design system components
    stores/                        # session, lobby, settings
    utils/
  stories/                         # Storybook for every UI component
static/
  fonts/  sprites/  audio/
tests (co-located *.spec.ts + *.svelte.spec.ts + *.e2e.ts)
server.js                          # prod entry: node handler + ws upgrade
plan.md
```

---

## 4. Data Model (Drizzle / SQLite)

```ts
// platform
profile        { userId (pk, → user.id), username (unique), displayName, avatarJson,
                 bio, createdAt, lastSeenAt }
lobby          { id, code (unique, 6 chars), name, gameId, hostUserId, status,
                 maxPlayers, settingsJson, createdAt, closedAt }
lobbyMember    { lobbyId, userId, slot, role, isReady, joinedAt, leftAt }
lobbyMessage   { id, lobbyId, userId, text, sentAt }        // last 200 kept per lobby
match          { id, lobbyId, gameId, seed, settingsJson, status, startedAt, endedAt }
matchPlayer    { matchId, userId, placement, score, statsJson, disconnected }
run            { id, matchId, userId, gameId, levelId, timeMs, progress, endedAt }  // GD attempts
bestScore      { gameId, userId, mode, key (level/track/stage), value, updatedAt }   // leaderboard source
```

Notes:

- `avatarJson` stores the avatar builder result: `{ seed, palette, base, hair, eyes, outfit, ... }`
  so avatars re-render procedurally at any size and in-game.
- `bestScore` is the single leaderboard source: sorted views per game/mode/level.
- Sessions/users come from better-auth (existing `auth.schema.ts`); we extend with `profile` 1:1.
- SQLite is fine for v1 (single node). Tables are written so a later Postgres move is mechanical.

---

## 5. Phase 0 — Core Platform

Goal: a player can sign up, build a pixel avatar, create a lobby, invite a friend by code, chat,
and launch a (stub) game session that runs through the full lifecycle. This phase builds every
system the games will plug into.

### 0.1 Project hygiene

- Delete scaffold demo routes/stories we don't want (keep Storybook config + one reference story).
- `git init`, initial commit, `.env` filled (BETTER_AUTH_SECRET, ORIGIN), adapter → `adapter-node`.
- Add deps: `ws`, `zod`, `@fontsource/press-start-2p` (or local Silkscreen font), `nanoid` (codes/ids).
- Scripts: `dev` (vite), `check`, `lint`, `test`.
- Conventions: Svelte 5 runes everywhere (already forced in `vite.config.ts`), `svelte-check`
  clean, prettier/eslint enforced.

### 0.2 Pixel design system (`src/lib/ui`, Tailwind 4 theme)

- Global pixel look: 8px spacing scale, no anti-aliased borders, `image-rendering: pixelated`,
  Press Start 2P for headings / readable pixel sans (Silkscreen) for body text.
- Theme tokens in `layout.css`: platform palette (ink `#1a1c2c`, paper, accent per game), plus a
  per-game accent switch (GeoDash = neon cyan/violet, Kart = red/yellow, Brawl = orange/steel).
- Components (all with Storybook stories + a11y checks):
  `PixelButton`, `PixelPanel`, `PixelModal`, `PixelInput`, `PixelSelect`, `PixelToggle`, `Avatar`
  (renders `avatarJson` to canvas at 3 sizes), `PlayerChip`, `Toast`, `Tabs`, `Tooltip`,
  `GameCard`, `ScanlineOverlay` (subtle CRT, optional setting).
- Motion rules: short (120–200ms), stepped easing, screen wipes between routes; respect
  `prefers-reduced-motion`.

### 0.3 Auth & profiles

- Keep better-auth (email+password). Replace demo pages with themed login/signup.
- On signup: generate `profile` with a random avatar + suggested username.
- Profile page: avatar (large), display name, bio, per-game stats cards (best scores, matches
  played, wins), recent matches, "copy profile link".
- Avatar builder: pick base/head/hair/eyes/outfit + 5-color palette from a curated pixel palette;
  live preview at 1x/2x/4x; "randomize"; used as lobby chip and in-game portrait.

### 0.4 Realtime layer + lobby system

- `RealtimeServer` with auth handshake (better-auth session token verified server-side),
  heartbeat, per-connection room subscriptions, zod-validated messages, metrics counters.
- `LobbyRoom`:
  - Create: name, game, max players (2–8), visibility (public/private), game settings.
  - Join: 6-char code (readable alphabet), public lobby list (filters: game, open slots), invite
    link `yoursite/lobby/CODE`.
  - Presence: join/leave/reconnect, host migration if host disconnects, ready checks, slot order.
  - Host controls: change game/settings, start (requires min players + all ready), kick, lock.
  - Chat: room-scoped, persisted (trimmed), rate-limited, `/` commands later.
  - Reconnect grace: 30s hold of the player's slot with `isReady=false`, then free.
- Lobby UI (`/lobby/[code]`): pixel "room" panel — avatar chips around a table, game card + settings,
  chat sidebar, big START button for host, invite code with copy button, connection status banner.

### 0.5 Game shell + match lifecycle

- `play/[gameId]` = lobby browser + "create lobby" for that game.
- Launch flow: host START → `match` row created → `game.start` broadcast (seed, slots, startAt with
  3s countdown) → game canvas mounts → `game.end` with results → results screen (placements, stats,
  "rematch" / "back to lobby") → lobby returns to open state.
- Stub game `minigame-echo` (Phase 0 only): each player moves a square with shared input pipeline,
  proving loop → input → sim → snapshot → results end-to-end. Deleted once GeoDash lands.

### 0.6 Persistence & leaderboards

- Domain services (`lobby.ts`, `matches.ts`, `scores.ts`) with transactions for create/join/finish.
- Leaderboard page per game/mode with top 50 + "your rank", powered by `bestScore`.

### Phase 0 acceptance criteria

- [x] Two browsers can sign up, create/join a lobby by code, chat, ready up, start the stub game,
      see each other move, finish, and see a results screen; all data survives refresh
      (`src/tests/core-flow.e2e.ts`).
- [x] Host disconnect migrates host; player reconnect reclaims their slot (30s grace in
      `LobbyRoom`, auto re-join on reconnect in `stores/realtime.ts`).
- [x] All UI components have Storybook stories; `check`, `lint`, unit + e2e tests pass.
- [x] WS traffic validated (zod on every inbound message), rooms cleaned up (empty-room close,
      connection sweep, chat history trim).

---

## 6. Phase 1 — Pixel Tanks (arena tank battle)

Goal: 2–8 tanks, one arena, **2 lives each**, obstacles everywhere, level ups — last tank
standing wins. Classic Battle City/Combat feel with modern online juice. **Status: playable**
(sim, 3 arenas, renderer and platform integration shipped).

### 6.1 Core gameplay

- **Drive & shoot** — `LEFT/RIGHT` rotate the hull, `UP/DOWN` drive/reverse, `SPACE` (KEY.JUMP)
  fires. Gamepad standard mapping works through the shared `InputManager`.
- **2 lives each** — one shell hit = one life lost. First hit → 2s respawn (seeded-rng spawn point
  farthest from living enemies) with 0.9s invulnerability (flashing tank, shells pass through).
  Second hit → eliminated, ranked by lives → kills → damage → xp.
- **Level ups** — XP from damage (10/hit) and eliminations (25). Levels 1–5 at 0/40/100/180/280
  XP: each level +8% speed, −10% reload, +12% shell speed; level 5 shells bounce twice. Level
  resets each match (it's a per-match power curve, not meta progression — see roadmap).

### 6.2 Arenas & obstacles

- Tile maps (30×17 tiles × 16px ≈ the 480×270 canvas), authored as char rows:
  `#` steel wall, `C` crate, `~` water, `B` bush, `.` floor. Shipped arenas: **Crossfire**
  (symmetric walls + crate clusters), **Islands** (water-heavy lanes), **Fortress** (central fort,
  tight corridors). Hosts pick one via lobby settings (`arenaId`).
- **Steel walls** — blocks tanks; shells **bounce once** (classic Tanks) and die on the second hit.
- **Crates** — destructible (2 hits), block movement and shells.
- **Water** — tanks can't cross, shells fly over.
- **Bushes** — pure cover: tanks drive over, drawn on top of tanks.
- Spawn points (8 per arena) validated on floor tiles and mutually reachable (flood-fill test).

### 6.3 Match rules & results

- **Last tank standing** wins; or `durationTicks` (120s) expires → ranked lives → kills → damage →
  xp. `score = kills*100 + damage*10 + level*50 + lives*25`.
- Shared 3/2/1/GO countdown freezes everyone before the first shot (tick-synchronized).
- Events on the wire (all existing protocol kinds): `spawn`, `hit`, `death`, `collect` (item
  `levelup` / `crate`), `finish` (elimination), `countdown`, `match-end`.

### 6.4 Netcode

- Deterministic 60Hz sim hosting all players server-side (same `GameSim` contract as the other
  games): continuous float hull angles, seeded rng only — same inputs ⇒ identical `hash()`
  (verified by golden-replay tests) and full `snapshot()/restore()` incl. rng state.
- Clients: local prediction via a private sim, remote tanks interpolated ~100ms behind 20Hz
  snapshots; explosions/hit/level events broadcast so everyone sees/hears the same fight.

### 6.5 Feel & polish

Explosions with debris + camera trauma, kill feed ("A ▸ B"), per-player HUD cards (lives as tank
icons, level stars, kills), respawn countdown over the wreck, bush cover drawn above tanks,
muzzle flashes and tread animation, `reducedMotion` respected.

### 6.6 Roadmap for Pixel Tanks

- **AI bots** to fill lobbies / solo play (spline-free: steering + LOS targeting, reuse the kart AI
  plan), difficulty levels.
- Team deathmatch (2 teams), capture-the-flag variant, sudden-death shrinking arena.
- ~~Power-up crates~~ **done**: random map upgrades (shield / triple shot / rapid fire / speed) with
  deterministic spawns + crate drops. More upgrade types welcome.
- Meta progression: unlockable tank skins (avatar system already stores `avatarJson`).

---

## 7. Phase 2 — GeoDash Party (multiplayer Geometry Dash-like)

Goal: 2–8 players race the same auto-runner level simultaneously, dying and respawning, first to
the finish wins. Fast, fair, readable, replayable.

### 7.1 Core gameplay

- Player cube auto-runs right at constant speed; input = **jump / hold-jump (multi-jump gated by
  pads) / special (mode action)**. Death on spike/crash; instant retry feel is sacred (≤ 400ms
  death → respawn/restart animation).
- Forms/modes via portals: **cube** (jump arcs), **ship** (hold to thrust up, gravity down),
  **wave** (45° zig-zag), **ball** (tap flips gravity). Phase 1 ships cube + ship; wave/ball in 1.1.
- Obstacle vocabulary (all procedural pixel sprites): spikes, blocks, saw blades, gaps, jump pads
  (yellow/pink), orbs (tap in air to jump), gravity portals, speed portals (0.5x–2x), moving
  platforms synced to music beats.
- Camera: player held at ~35% from left, vertical smoothing, subtle zoom on speed changes.

### 7.2 Level format & content

- Level JSON: `{ id, name, song, bpm, lengthPx, difficulty, objects: [{type, x, y, rot?, props?}] }`.
- Ship **6 handcrafted levels** (Easy → Harder) + **Daily Level** generated deterministically from
  `seed = hash(date)` (same for everyone, changes daily).
- Later: in-game **level editor** (palette of objects, place/delete, playtest, export JSON code).
  Kept in scope for Phase 1.5 because it multiplies content cheaply.

### 7.3 Multiplayer modes

- **Race (default):** simultaneous start, live opponents drawn as translucent colored "ghosts"
  (their position from `game.snap` interpolation; no collision between players), first to reach the
  finish wins; remaining players ranked by furthest progress at the moment the winner finishes (or
  by time-limited progress).
- **Sudden Death (variant):** one shared death = last player standing wins; everyone starts at the
  same tricky section.
- **Practice:** solo, checkpoints, best-time leaderboards per level.
- Anti-finish-griefing: match ends when winner finishes or 90s timer expires.

### 7.4 Netcode for GeoDash

- Simulation is **deterministic** (fixed 60Hz tick, integer/fixed-point-friendly math, seeded
  level). Inputs are tiny (`jump held`, `special held`) → broadcast `input` at 30Hz (or on change).
- Client: sim self immediately; render ghosts from interpolated snapshots of other players.
- Server: authoritative timeline — runs the same sim for each player from their inputs, validates
  finish times and progress (position envelope check: |client − server| progress < tolerance),
  broadcasts `game.event` (death, respawn, orb hit, finish) so SFX/VFX are shared.
- Reconnect: rejoin as spectator (ghost-only) unless still in the first 10s of a match.

### 7.5 Feel & polish (this is what makes it "good UX")

- **Music sync:** level BPM drives background pulses, ground bounce, and obstacle timing; countdown
  3-2-1-GO snaps to the bar. Music = original chiptune loop composed in-repo, per-level track.
- **Input feel:** jump buffer (60ms) + coyote time (50ms) so deaths feel fair; hold-jump to
  auto-jump off landing.
- **Death feedback:** white flash 2 frames, screen shake, cube pop, death counter + "Attempt N"
  splash, instant retry key (R / hold jump).
- **Progress bar** at top with player markers (you + ghosts), % completion, best % per level.
- **Particles & juice:** trail behind cube, speed lines at 2x, landing dust, portal ripple.
- **Accessibility:** colorblind-safe player colors (shape + color distinction), reduced-motion mode
  (no shake/flash), separate Music/SFX volume sliders.

### 7.6 Phase 2 acceptance criteria

- [ ] 4 players race the same level smoothly at 60fps; ghosts interpolate without jitter.
- [ ] Determinism test: same recorded input stream ⇒ identical sim hash on client & server.
- [ ] Race results are server-validated; tampered progress is rejected and logged.
- [ ] Death → retry loop under 400ms; feels good on keyboard and gamepad.
- [ ] 6 levels + daily level playable; leaderboards per level (best time, best %).

---

## 8. Phase 3 — Turbo Kart

Goal: a top-down pixel kart racer that feels great: drift-boost mechanics, tight controls, readable
tracks, and online races for 2–8 players.

### 8.1 Presentation

- Top-down 2D pixel (SNES Mario Kart-style), 16-direction sprite rotation (pre-rotated atlas),
  internal 480×270 canvas scaled up, layered track rendering (ground → road → decals → karts →
  HUD → weather overlay).
- HUD: position, lap (x/3), speedometer, item slot, minimap, lap-time splits (best lap flashes),
  drift-charge indicator.

### 8.2 Mechanics (the "fun" list)

- **Drift system:** hold drift (R/shoulder) + steer → kart slides; charge tiers spark blue → orange
  → purple; release for mini-turbo boost scaled by tier. Hop-drift to initiate tight turns.
- **Boost & speed:** boost pads, start-line rocket start (timing window on countdown), slipstream
  behind rivals, drift boost, respawn boost.
- **Items:** mushroom (burst boost), oil slick, missile (homing to player ahead), shield bubble,
  lightning (shrink all ahead). Item boxes with weighted distribution favoring trailing players.
- **Track interactions:** jump ramps with trick spins (extra boost), boost strips, off-road grass
  (slowdown, sparks), breakable shortcut blocks, moving hazards (barrels, puddles).
- **Forgiving physics:** soft walls (speed loss + steering assist back on track), auto-respawn if
  stuck 1.5s (reoriented on the racing line), no flipping/soft-lock states.
- **AI karts** (fill lobbies): spline-following with rubber-banding lite, drift usage, item usage,
  difficulty setting (Easy/Medium/Hard).

### 8.3 Tracks

- Track format: tilemap + centerline spline (checkpoints, respawn points, AI line, item box spots,
  minimap). 3 tracks at launch:
  1. **Sunny Circuit** — wide, gentle, teaches drift-boost.
  2. **Neon Dojo** — tight S-curves, shortcut behind a breakable wall, night neon palette.
  3. **Frostbite Falls** — slippery ice tiles, jump gaps, moving hazard.
- Mode: 3-lap race, plus Time Trial (solo, ghost of your best lap saved as input replay).

### 8.4 Netcode (kart)

- Client-side **prediction + server reconciliation**: client simulates own kart immediately from
  input; server runs all karts at 60Hz from broadcast inputs, sends 20Hz snapshots; client
  reconciles to server state with smooth correction (error > threshold ⇒ snap).
- Remote karts: **interpolation with 100ms buffer** + short extrapolation; visual-only drift/particle
  state derived from velocity.
- Collisions between karts resolved on the server (bounce + tiny slowdown), reported via snapshot.
- Finish detection server-side; results carry per-lap splits.

### 8.5 UX targets

- Gamepad-first feel: analog steering mapped to digital 16-dir sprites, rumble on drift/boost/hit.
- Instant restart, pause menu (settings, leave), countdown with camera pull-back, results screen
  with per-lap table and "rematch".
- 60fps on integrated GPUs; particles pooled; atlas batching; no per-frame allocation in the loop.

### 8.6 Phase 3 acceptance criteria

- [ ] Online 4-player race completes with correct placements and lap splits; rubber-banding is
      invisible (no teleporting under normal latency ≤ 100ms simulated).
- [ ] Drift-boost chain is learnable in one race by a new player (in-game hint prompts).
- [ ] Time trial saves ghost replays and best lap per track on the leaderboard.
- [ ] Gamepad + keyboard both fully supported; rumble and reduced-motion settings respected.

---

## 9. Phase 4 — Pixel Brawl (platform fighter)

Goal: a Brawlhalla-like 2D platform fighter for 1v1 and free-for-all (2–4 players), fast and
readable in pixel art.

### 9.1 Mechanics

- Stocks + damage %: knockback scales with damage; KO into blast zones; respawn platform with
  invulnerability.
- Moves: light attack (ground/air), heavy/charged smash, signature per character (3 characters at
  launch), dodge with i-frames + directional dodge, jump + double jump, fast-fall, wall cling +
  recovery jump, ledge grab.
- Weapons spawning on stage (sword, hammer, blaster) that change moveset.
- Stages: 3 stages with soft platforms, moving platform variants, and a "small blast zone" ranked
  variant. Hazards toggle for casual play.

### 9.2 Netcode (fighter)

- Deterministic sim at 60Hz with **input delay (2–3 frames) + rollback-lite** for remote players:
  on input mismatch, rewind to confirmed state and replay. Because the sim is deterministic and
  state is small (4 players × physics state), rollback is feasible.
- Server validates match results and detects divergent sim hashes (log + resync).

### 9.3 UX

- Character select with animated pixel portraits, damage HUD per player with color + shape,
  kill-screen flash + zoom punch, pause/forfeit, best-of-3 stock rules for 1v1.

### 9.4 Phase 4 acceptance criteria

- [ ] 1v1 online match feels responsive (perceived input latency < 3 frames at 60ms RTT).
- [ ] Rollback never visibly teleports players in normal conditions; sim divergence is detected.
- [ ] 3 characters × 3 stages, all moves/animations/effects in place; FFA with 4 players works.

---

## 10. Phase 5 — Platform polish & social

- Friends list + invites ("invite to lobby" from profile), recent players, block.
- Matchmaking queues per game (casual), ranked with visible rating per game, season resets later.
- Spectator mode in lobbies (join as viewer, ghost cam).
- Achievements + simple progression (playtime badges, no XP grind).
- Soundtrack library + audio settings page; ambient hub music.
- Touch controls (virtual stick + buttons) for GeoDash first (simplest input), then others.
- Performance & anti-cheat hardening: replay validation, rate limits, server sim checksums.
- Deployment: adapter-node behind a reverse proxy, SQLite → Postgres migration if needed, backups.

---

## 11. Cross-Cutting Concerns

### Engine & performance budgets

- Fixed timestep sim (60Hz) with render interpolation; `requestAnimationFrame` render loop.
- No allocations per frame in hot paths; pooled particles/sprites; single canvas per game view.
- Target: 60fps at 1080p on integrated graphics, < 200KB of sprite data per game (indexed PNGs).

### Asset pipeline (no external sprites)

- Sprites authored **in code**: `src/lib/game/assets/generate/*.ts` draws pixel art into PNG atlases
  - JSON metadata at build time (`bun run gen:assets`), committed to `static/sprites/`.
    Per-game palette (e.g. 32-color ramps) keeps everything cohesive; real art can replace atlases
    later without touching game code.
- Audio: WebAudio-synthesized SFX (jump, boost, hit, UI blips) + chiptune loops generated as WAV
  samples in-repo; no external audio dependencies.

### Testing strategy

- **Unit (Vitest, node):** sim determinism (golden replays + state hashes), level/track parsers,
  lobby state machine, drift/knockback math, protocol zod schemas.
- **Component (Vitest browser):** pixel UI components + avatar renderer.
- **E2E (Playwright):** signup → profile → create lobby → join by code (two contexts) → start stub
  match → results. GeoDash single-player flow. Regression for reconnect flow.
- **Storybook:** every UI component; visual states (loading, error, disabled).
- Manual playtest checklist per phase (feel can't be unit-tested): latency soak with artificial lag,
  8-player stress test.

### Conventions

- Svelte 5 runes everywhere; `.svelte` files are written/reviewed via the `svelte-file-editor`
  agent + Svelte MCP checks (per AGENTS.md).
- All game/shared code in `src/lib/game/**` is UI-framework-free TypeScript (testable headless).
- Zod at every trust boundary (WS messages, route params, level JSON).
- Time and randomness always injected/seeded for determinism.

---

## 12. Milestones & Rough Order

| #   | Milestone                     | Deliverable                                                   | Depends on   | Status  |
| --- | ----------------------------- | ------------------------------------------------------------- | ------------ | ------- |
| M0  | Hygiene + pixel design system | themed shell, UI kit + stories, adapter-node, WS bootstrap    | —            | ✅      |
| M1  | Profiles & avatar builder     | signup → profile → avatar builder, profile pages              | M0           | ✅      |
| M2  | Realtime + lobbies            | lobby create/join/code/list, presence, chat, host controls    | M0           | ✅      |
| M3  | Game shell + stub game        | match lifecycle, results screen, leaderboards                 | M1, M2       | ✅      |
| M4  | Pixel Tanks core + online     | arenas, obstacles, 2 lives, level ups, ranked results         | M3           | ✅      |
| M5  | GeoDash core + race           | cube mode, 3 levels, ghost races, server-validated results    | M3           | ✅      |
| M6  | Pixel Tanks: bots + modes     | AI bots (solo + lobby fill), team deathmatch, power-up crates | M4           | ⬜ next |
| M7  | GeoDash polish + editor       | daily level, wave/ball modes, level editor, sudden death      | M5           | ⬜      |
| M8  | Turbo Kart core + online      | drift-boost physics, 3 tracks, AI, items, online races        | M3           | ✅      |
| M9  | Turbo Kart polish             | time-trial ghosts, replay saves, more items/tracks            | M8           | ⬜      |
| M10 | Pixel Brawl core              | movement/combat, 1 character, 1 stage, local versus           | M3           | ⬜      |
| M11 | Pixel Brawl online            | rollback-lite, 3 characters, 3 stages, stocks/FFA             | M10          | ⬜      |
| M12 | Social & platform polish      | friends, matchmaking, spectators, achievements, touch         | M6/M7/M9/M11 | ⬜      |

Each milestone ends with: `check`/`lint`/tests green, updated README screenshots, this file updated
(decisions + acceptance criteria checked off).

---

## 13. Risks & Decisions Log

| Risk                                          | Mitigation                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SvelteKit WS upgrade wiring is fiddly         | Keep `RealtimeServer` transport-agnostic; documented fallback = separate WS process on own port    |
| Determinism drift between client & server sim | Fixed-point-friendly math, shared code, golden replay tests + sim hash checks per match            |
| Latency makes kart/fighter feel bad           | Prediction + reconciliation (kart), input delay + rollback-lite (brawl), artificial-lag soak tests |
| Scope creep in "good UX" polish               | Feel targets listed per phase; polish is scheduled in milestones, not open-ended                   |
| Pixel art quality without an artist           | Code-generated atlases + strict palettes; cohesive style beats quantity; art can be swapped later  |
| SQLite write contention once matches pile up  | WAL mode, short transactions, single writer discipline; schema portable to Postgres                |
| Cheating (score/finish tampering)             | Server-side sim validation + envelope checks; treat client state as untrusted everywhere           |

### Locked decisions

- **Multiplayer backbone:** WebSocket server inside the SvelteKit process (own `/realtime` path).
- **Rendering:** Canvas 2D + small custom engine in `src/lib/game/engine` (no game framework).
- **Art:** code-generated pixel sprites/atlases and palettes; replaceable by real assets later.
- **Auth:** keep better-auth (email+password) with a 1:1 `profile` extension.
- **DB:** Drizzle + SQLite (better-sqlite3) for v1.

### Open questions (decide when relevant)

- GeoDash ghost rendering: full sprite vs silhouette outline for readability in packed races.
- Whether level editor ships before or after wave/ball modes (currently 1.5).
- Kart camera: fixed north-up vs rotating camera behind kart (rotating reads better with drift;
  costs sprite-rotation work). Prototype both in M7 and pick by feel.
- Voice/presence extras ("playing now" sidebar) — Phase 4 backlog.

---

## 14. Implementation log

Notes from building Phase 0 (keep updated per milestone):

- **better-auth + dev ports:** `svelteKitHandler` only routes `/api/auth/*` when the request origin
  matches `baseURL`; hardcoding `ORIGIN` broke every non-default port. `auth.ts` now treats an empty
  `ORIGIN` as "derive from request".
- **Prod entry env:** adapter-node rejects an empty `ORIGIN` at import time, so `server.js` defaults
  `ORIGIN` (and uses top-level await imports) before loading `build/handler.js`. `bun run start`
  loads `.env` via `node --env-file`.
- **Realtime client reliability:** `request()` awaits socket open (kills the connect/join race), the
  client sends 10s heartbeats (server drops 30s-silent conns), and the store auto-rejoins its lobby
  after a reconnect.
- **Lobby membership broadcast:** `LobbyRoom.join` must broadcast `lobby.state` to the whole room —
  broadcasting only presence left existing members rendering a stale roster (caught by e2e).
- **Prod realtime bundle:** `ws` + `better-sqlite3` stay external in the esbuild step; bundling CJS
  `ws` into ESM output breaks on `require('events')`.
- **Sim registry is node-safe:** the server imports only `modules/*/sim.ts` (never render code), so
  authoritative sims run in the server process without DOM shims.
- **`vite preview` needs the WS too:** `server.js` mounts `/realtime`, `vite preview` does not — the
  Vite plugin now has `configurePreviewServer` that loads `build/realtime.js` (with `.env` defaults)
  so preview behaves like production. `bun run preview` runs `server.js` directly and accepts
  `--port N`.
- **Connect on app start:** the realtime store auto-connects on module load in the browser; before
  that only lobby/game pages connected, leaving the landing page "offline". WS upgrades are
  auth-gated, so logged-out visitors legitimately have no connection — the nav dot is hidden for
  them instead of showing a scary "offline".
- **Pivot (user): tanks first.** "Pixel Tanks" (top-down arena: obstacles, 2 lives each, level ups)
  jumped ahead of GeoDash on the roadmap. Both games now build as `GameModule`s and the platform
  wires them via `sim-registry` + `GAME_META`; host lobby `settings` are merged into the match
  `config.options` (e.g. `levelId`, `arenaId`).
- **GameEvent/`GameId` growth:** new games extend the `GameId` union — every `Record<GameId, …>`
  (registry, meta, limits, configs, UI maps) must gain a key or `svelte-check` flags it.
- **"Sometimes no bg" was 4 bugs:** unpainted PixelCanvas letterbox bars (transparent → page shows
  through; only visible off-16:9), stale backing store before the first `resize()`, NaN sizes
  corrupting the transform, and GeoDash sky bands leaving rows uncovered as the camera panned.
  `PixelCanvas` now paints a letterbox matte, re-fits defensively, and takes an optional dpr.
- **GeoDash transformations shipped** (plan §7.1 forms): portals switch cube/ship/ball — ship =
  hold-JUMP thrust, ball = tap-JUMP flips gravity; `transform` events on the wire; 6 levels with a
  mode-aware beatability bot (0-deaths first attempts). Level/arena pickers in the lobby settings
  modal make all content reachable from the UI.
- **Tank desync (2-browser report) was 3 bugs:** ① the client render clock used the LOCAL sim tick
  while the snapshot buffer is keyed by SERVER ticks — dropped ticks (heavier windows) skewed the
  offset, so screens drifted apart (remote rendering now uses a snapshot-derived clock +
  reconciliation); ② interpolation slid across respawn teleports (now snaps on discontinuities;
  discrete lives/respawn/invuln state comes straight from samples); ③ naive angle lerp spun the long
  way across the ±π seam (now shortest-path everywhere). Wire-level check: two live clients get
  byte-identical snapshots per tick. **Caution for other games:** any client-side timing keyed off
  local loop ticks has hazard ① — geodash/echo should adopt the snapshot-clock pattern too.
- **Tank map upgrades shipped:** random deterministic spawns (shield / triple shot / rapid fire /
  speed) + crate drops, 1s fairness grace, effects live in sim state (snapshots/hash), HUD timers.
- **GeoDash "finish does nothing" + "floor disappears":** ① the sim ended only when ALL finished or
  the timer — a race now ends on the FIRST finisher (plan §7.3), so `game.end`/results fire
  instantly; ② floor slabs are single wide blocks and the draw cull tested only their left edge —
  once past the slab start the floor vanished; culling now tests the object's full span against a
  zoom-aware window. New level rules: every pit ≤300px or pad/orb-bridged or overhead-covered.
- **Tank "latency in the host" was 3 bugs:** the server applies inputs on arrival (ignoring the
  client's input tick labels), reconcile dropped the last L ticks of input at every key edge, and
  the decaying correction offset was drawn onto the LOCAL tank. Fix: local tank renders from
  prediction at zero display lag (corrections snap only on real discontinuities), predicted recoil,
  and a zero-allocation render/interp path. **Follow-up (protocol-level):** input-ack in snapshots
  (last applied input tick) would let clients reconcile precisely and remove the workaround;
  `PixelCanvas.text()` should cache uppercase strings.
- **Turbo Kart shipped** (plan §8): drift tiers (blue/orange/purple mini-turbos), hop-drift,
  pads/ramps/tricks/slipstream, soft walls + auto-respawn, items (mushroom/oil/missile/shield/
  lightning) weighted to trailers, 3 spline tracks (Sunny Circuit / Neon Dojo / Frostbite Falls —
  road derived from the centerline so the racing line is always drivable), CPU karts with
  rubber-banding (AI finishes 3 laps on every track = playability guarantee), lap splits +
  placement results. Netcode built on the tank lessons from day one (snapshot clock, discontinuity
  snapping, shortest-path angles, zero-lag local kart).
