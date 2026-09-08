# AR Quest-Trail Game

Unity AR mobile game where players follow authored, sequential quest trails anchored to real-world
locations. Full spec: `docs/requirements-v1.0.md` — requirement IDs (GDR-xx, SR-xx, CR-xx) are
referenced directly in code comments and commit messages; keep that mapping intact.

## Architecture

- `client-unity/` — Unity project (AR Foundation + AR Core Geospatial API / Lightship VPS). Player-facing app only.
- `server/` — Node.js + TypeScript + Fastify backend. PostgreSQL + PostGIS for spatial data.
  Owns: trail definitions, per-player progress, the SR-SEC-02 location sanity check.
- No shared/public pin world in v1 — every progress query is scoped to the requesting player
  (SR-DATA-01/02). Don't add cross-player queries without checking that requirement first.

## Key decisions already made (don't re-litigate without checking docs/requirements-v1.0.md)

- Core loop: sequential quest trail, not open-world collection (GDR-01).
- Pin `n+1` is locked/non-interactable until pin `n` is completed by that player.
- Occlusion: real depth-based occlusion (SR-VIS-01) only on capable devices; everything else uses
  the SR-VIS-02 distance-fade fallback. Don't make occlusion quality gate gameplay.
- Anything marked `[ASSUMED — confirm or override]` in the spec is a placeholder value (thresholds,
  retention days, retry limits) — check with the project owner before treating it as final, but it's
  safe to build against as a default.

## Build & test workflow

Match the spec's Test Strategy (§7 of the requirements doc): backend logic (schema, SR-SEC-02) is
built and unit-tested before any Unity/AR work touches it. Don't skip straight to the AR client.

### Server
```
cd server
npm install
npm test        # unit tests — must pass before wiring up routes to Unity
npm run dev      # local dev server
```
Requires a local PostgreSQL with the PostGIS extension enabled — see `server/README.md`.

### Client
Unity project isn't scaffolded from this repo (Unity projects are created via Unity Hub, not CLI).
See `client-unity/README.md` for the exact setup steps and package list. Script stubs under
`client-unity/Assets/Scripts/` map 1:1 to spec sections — fill them in against the server API once
the backend tests pass.

## Conventions

- Reference requirement IDs in comments for anything non-obvious: `// SR-SEC-02: sliding window`.
- New backend logic gets a test alongside it in the same PR — no exceptions for anything touching
  location data or progress state (that's the trust/data-integrity surface of the whole app).
