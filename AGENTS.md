<!-- BEGIN:global-rules -->

# Scrapyard

## Gameye fork (takes precedence over upstream architecture notes below)

This fork is guest-only. `game/server/main.ts` requires Rooms `MM_URL`,
`MM_MATCH_ID`, and `MM_SERVER_TOKEN`. One session hosts one FFA Scrapyard match;
no Nakama server/key or process-local matchmaking is used in the deployed entrypoint.
The original Nakama/website/deployment files are retained as upstream reference,
not part of our runtime. Preserve MIT attribution. Do not use upstream deploy scripts.
Build with Node 24: root `npm ci`, `npm --prefix game ci`, `npm run build`;
`npm test` tests the gateway and real managed server, `npm --prefix game run server:check`
tests the original simulation/networking. `edge/worker.js` serves the client and
proxies validated Rooms guest API calls and match sockets. Never log tickets or
MM_* secrets; never put Gameye credentials into client build variables.

## Project

**Scrapyard** — browser-based multiplayer 3D vehicular-combat game. Long-term vision: arcade vehicles, guns/missiles/rockets/mines, destructible vehicles, ramps/buildings/hazards, pickups, AI opponents, 4-8+ online players.

**Current scope is a vertical slice only.** MVP target: 1 procedural arena, 2 procedural vehicles, arcade movement + physics/collision, 1 machine gun, 1 rocket weapon, hit detection, HP/damage/destruction/respawn, basic HUD, online matches on the game server (players signed in through Nakama). Two browser windows join the same match, drive, shoot, damage/destroy each other, respawn.

Do NOT build payments, stores, inventory, progression, subscriptions, admin systems, or other business/backend features in this phase. Accounts stop at Nakama sign-in: register, log in, log out, guests (device auth), username and display name, password change, account delete (`www/`).

## Repo layout

```
game/     React + Vite + TypeScript client (menus, garage + loadout, mode + arena select, matches — team deathmatch, free for all — on Rapier physics: practice vs bots, or Classic online: matchmaking finds the people, the server the room)
          game/server: the authoritative game server (Node, the client's own simulation and modes; bundled by vite.server.config.ts into game/dist-server/, gitignored)
nakama/   Nakama compose setup (postgres + heroiclabs/nakama image), run with Podman
www/      Astro 7 static site (dev on :8000): landing, the guide (MDX), log in / register / account on Nakama (React islands); serves the game build at /play. Plan and log: .claude/work/www/
deploy/   the server: compose.yml (Caddy + game server + Nakama + Postgres), Caddyfile (the static site from site/current, /match -> the game server, /api/stats -> Nakama), .env.example
scripts/  build.sh (game for /play -> www/public/play -> www/dist, precompressed by precompress.mjs; the game server -> game/dist-server), run.sh (local), deploy.sh (server: switch the site's release, and the game server's when its bundle isn't the one running or with --server — rollbacks too; refuses Nakama's default session key, or a refresh key equal to it) + backup.sh, nakama-smoke.mjs, match-smoke.mjs; arena-parity.mjs + browser-match.mjs (headless Chromium through the globally installed Playwright — not a dependency, not in CI: the arenas' digests in a browser; two pages in one online match)
```

No monorepo tooling, no root package.json. `game/`, `www/` and `nakama/` are independent.

## Instruction files and guides

Rules live in the `AGENTS.md` files; each `CLAUDE.md` only imports the `AGENTS.md` beside it. Put a rule in the narrowest `AGENTS.md` that covers every place it applies, never in a `CLAUDE.md`.

Read a folder's `AGENTS.md` before working on its files. Before writing in a language, read its guide's `README.md` in `.claude/codes/`, then the guide files that README lists for the task.

| Working in | Read | Guides in `.claude/codes/` |
|---|---|---|
| `game/` (client `src/`, server `server/`) | `game/AGENTS.md` | `ts/` for `.ts`, `.tsx`; `tw/` for class names and `game/src/index.css` |
| `www/` | `www/AGENTS.md` | `ts/` for `.ts`, `.tsx`, `.mts`, `.astro`; `tw/` for class names and `www/src/styles/*.css` |
| `nakama/` | `nakama/AGENTS.md` | `sql/` for SQL in `nakama/data/modules/*.lua` |
| `deploy/`, `scripts/`, `.github/` | this file | none |

`ts/` and `tw/` are generic. Where a project's `AGENTS.md` departs from a guide, the project wins. They are pulled from `aasumitro/workspace` and gitignored: if one is missing, say so, follow the project rules, and don't recreate it. `sql/` is written for this repo and tracked in git.

## Dev servers

**Never run `npm run dev` / start a Vite dev server.** The game already runs live at `:3000` — assume it's always up. Use `npx tsc -b` (in `game/`) to typecheck and existing browser tabs against `:3000` to verify changes.

The site's dev server on `:8000` is usually up too (`/api/stats` proxied to Nakama); `scripts/build.sh` puts the game build into `www/public/play` (gitignored) so `/play` works there.

## Contracts between projects

- One contract joins site and game: the Nakama session in localStorage `scrapyard.session` = `{ token, refresh_token, guest? }` (same origin once the game is at /play), written by `www/src/lib/nakama/` (`storage.ts` the key, `stored.ts` the format) and `game/src/net/session.ts` — change both together.
- Nakama is who the player is: accounts, guests, sessions (the game server checks its session tokens itself, with Nakama's key), the online count and the site's stats.
- Every fact in the site's home copy and guide comes from the game's code (configs, registries, patch notes): change the game first, then the copy.
- Nakama address at build time: `PUBLIC_NAKAMA_*` (www) and `VITE_NAKAMA_*` (game), see the `.env.example` files.

## Engineering principles

1. Avoid unnecessary dependencies, premature abstraction, and premature optimization.
2. Small cohesive modules, strict TypeScript.

The game's own principles: `game/AGENTS.md`.

## Development order (do not implement all at once)

React app -> Three.js scene -> procedural arena -> procedural vehicle -> Rapier physics -> vehicle movement -> third-person camera -> weapons -> combat -> HP/destruction/respawn -> Nakama connection -> two-player match -> authoritative multiplayer -> prediction/reconciliation -> interpolation -> polish. (Done up to interpolation and lag compensation: `.claude/work/net/NET_LOG.md`.)

<!-- END:global-rules -->
