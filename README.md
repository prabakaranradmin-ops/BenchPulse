# AR Quest-Trail Game

Start here: `CLAUDE.md` (project context for Claude Code) and `docs/requirements-v1.0.md` (the
full spec). Open this folder in VS Code with the Claude Code extension installed and it will
pick up `CLAUDE.md` automatically. `docs/backlog.md.txt` has per-story status.

- `server/` — backend (Node/TS/Fastify + PostGIS). Player token exchange, trail/attempt/pin API
  routes, the Admin authoring API, JWT auth, the SR-SEC-02 location sanity check, and the
  privacy lifecycle (delete-my-data, retention purge, anonymized analytics) — 192 tests, 24 of
  them against real Postgres+PostGIS when `TEST_DATABASE_URL` is set. Schema in
  `server/migrations/`. See `server/README.md` for the API reference.
- `client-unity/` — the player app. All client logic lives in `Assets/Scripts/Core` as plain C#
  with 109 tests (`client-unity/dotnet/`), five of which drive the client against the real
  server. Thin Unity scripts sit on top; they're written and type-checked but not yet run in a
  Unity Editor. The Unity project itself is created through Unity Hub — see its README.
- `docker-compose.yml` — the whole backend in one command, for a tunnel to put TLS in front of.
- `.github/workflows/ci.yml` — on every push: server lint/format/build/migrate/tests, and the
  client Core built for Unity's profile and tested against a freshly started real server.

## Recommended order (matches "test every phase")

1. **Backend:** `JWT_SECRET=$(openssl rand -hex 32) docker compose up --build` brings up
   Postgres+PostGIS, migrates, and serves the API on `localhost:3000`. (Or run `server/` directly
   — `npm install && npm test`, then see `server/README.md`.)
2. **A trail at your location:** `docker compose exec api node dist/jobs/seedFieldTestTrail.js
   --lat <lat> --lng <lng> --code SWAN42` prints the trail id and device keys.
3. **Unity, in the Editor first:** create the project per `client-unity/README.md`, add
   `QuestBootstrap` to an empty scene, point it at `http://127.0.0.1:3000` and the seeded trail,
   and play the whole loop with the Editor walker — no device needed.
4. **The field test (ST-4.3):** put an https tunnel in front of port 3000, build the AR scene to a
   phone, and walk the trail. Note per device what requirements §7's field matrix asks for.
5. **Only after that:** visual QA of occlusion per device tier, ST-6.1 photo challenges, and the
   Admin map UI (ST-7.1) on top of the authoring API.
