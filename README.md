# AR Quest-Trail Game

Start here: `CLAUDE.md` (project context for Claude Code) and `docs/requirements-v1.0.md` (the
full spec). Open this folder in VS Code with the Claude Code extension installed and it will
pick up `CLAUDE.md` automatically.

- `server/` — backend (Node/TS/Fastify + PostGIS). Player token exchange, trail/attempt/pin API
  routes, the Admin authoring API, JWT auth, the SR-SEC-02 location sanity check, and the
  privacy lifecycle (delete-my-data, retention purge, anonymized analytics) are implemented and
  tested — 124 tests that need no database, plus 20 more that run the real SQL against
  Postgres+PostGIS when `TEST_DATABASE_URL` is set. Schema lives in `server/migrations/`,
  applied with `npm run migrate`. See `server/README.md` for the API reference.
- `client-unity/` — Unity project skeleton (not a full Unity project yet — see its README for
  the exact Unity Hub setup steps). Script stubs map 1:1 to requirement IDs.
- `docs/` — the requirements spec.

## Recommended order (matches "test every phase")

1. `server/`: run `npm install && npm test` — the SR-SEC-02 sanity check, the SR-GEO-04/GDR-01
   completion rules, and every API route, all without a database. Then `npm run migrate` against
   a local Postgres+PostGIS and re-run the tests with `TEST_DATABASE_URL` set (one command in
   `server/README.md`) before pointing the client at it.
2. Author a trail: promote a player with `npm run grant-admin -- <userId>`, then
   `POST /api/v1/admin/trails` and publish a version. That's how the field-test trail gets made
   until EPIC 7's desktop UI exists.
3. `client-unity/`: create the Unity project per its README, wire up `ProximityDwellChallenge`
   + `VpsLocalizationService` against the now-working server, and get one pin working
   end-to-end on a real device before adding anything else.
4. Only after that: `OcclusionFallbackController`, the `photo_confirmation`/`code_entry`
   challenge types, and the desktop Admin map UI on top of the authoring API (ST-7.1).
