# AR Quest-Trail Game

Start here: `CLAUDE.md` (project context for Claude Code) and `docs/requirements-v1.0.md` (the
full spec). Open this folder in VS Code with the Claude Code extension installed and it will
pick up `CLAUDE.md` automatically. `docs/backlog.md.txt` has per-story status.

- `server/` — backend (Node/TS/Fastify + PostGIS). Player token exchange, join codes,
  trail/attempt/pin API routes, the Admin authoring API with OpenStreetMap placement checks, JWT
  auth, the SR-SEC-02 location sanity check, and the privacy lifecycle (delete-my-data, retention
  purge, anonymized analytics) — 256 tests, 27 of them against real Postgres+PostGIS when
  `TEST_DATABASE_URL` is set. Schema in `server/migrations/`. See `server/README.md` for the API
  reference.
- `admin-web/` — the Admin authoring tool (React + CesiumJS), served by the server at `/admin/`:
  place pins on a 3D map, set challenges, see placement warnings as you go, publish versions,
  share join codes and QR codes, triage pin reports, read analytics. See its README.
- `client-unity/` — the player app: welcome, location, My trails, join by code or link, trail
  details, settings, and the play screen. All client logic lives in `Assets/Scripts/Core` as plain
  C# with 172 tests (`client-unity/dotnet/`), six of which drive the client against the real
  server. Thin Unity scripts sit on top. It's a Unity 6.0 LTS project: open the folder in Unity
  Hub; `Assets/Scenes/SampleTrail.unity` plays a real trail in the Editor with a simulated walker,
  and an automated play-through runs the whole app there. Not yet built for a phone.
- `docker-compose.yml` — the whole backend (API, admin tool, database, daily retention purge) in
  one command, for a tunnel to put TLS in front of.
- `.github/workflows/ci.yml` — on every push: server lint/format/build/migrate/tests, the admin
  tool's lint/tests/build, the Docker image build, and the client Core built for Unity's profile
  and tested against a freshly started real server.
- `docs/decisions.md` — product decisions taken so far, and what each changed.

## Recommended order (matches "test every phase")

1. **Backend:** `JWT_SECRET=$(openssl rand -hex 32) docker compose up --build` brings up
   Postgres+PostGIS, migrates, and serves the API on `localhost:3000`. (Or run `server/` directly
   — `npm install && npm test`, then see `server/README.md`.)
2. **A trail at your location:** either author one in the admin tool — `docker compose exec api
   node dist/jobs/grantAdmin.js --new-key` prints a sign-in key, then open
   `http://localhost:3000/admin/` — or seed one in a single command: `docker compose exec api node
   dist/jobs/seedFieldTestTrail.js --lat <lat> --lng <lng> --code SWAN42` prints the trail id and
   device keys.
3. **Unity, in the Editor first:** open `client-unity` in Unity Hub (Unity 6.0 LTS), open
   `Assets/Scenes/SampleTrail.unity`, press Play, join the trail with its code, and play the
   whole loop with the Editor walker — no device needed (`client-unity/README.md`).
4. **The field test (ST-4.3):** put an https tunnel in front of port 3000, build the AR scene to a
   phone, and walk the trail. Note per device what requirements §7's field matrix asks for.
5. **Only after that:** visual QA of occlusion per device tier, the AR view's polish, and the
   device key in Keychain/Keystore (decisions 5 and 6). ST-6.1 photo challenges are deferred.
