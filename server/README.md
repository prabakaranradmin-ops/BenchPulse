# Server

Node.js + TypeScript + Fastify backend for the AR quest-trail game. PostgreSQL + PostGIS for
spatial/trail data. See `../docs/requirements-v1.0.md` for the requirement IDs referenced in
comments throughout this code.

## Setup

```bash
npm install
cp .env.example .env   # then edit DATABASE_URL / JWT_SECRET
```

Requires PostgreSQL with the PostGIS extension available. Apply the schema:

```bash
npm run migrate
```

## Commands

```bash
npm test         # unit + route tests — no database needed
npm run dev      # local dev server with hot reload
npm run build && npm start   # production build

npm run migrate          # apply pending migrations (ST-1.3); safe to re-run
npm run migrate:down     # roll the last migration back
npm run migrate:create -- add-something   # scaffold the next migration file

npm run job:purge-location-history   # SR-PRIV-01 retention purge (see below)
npm run grant-admin -- <userId>      # promote a player to Admin (EPIC 7); add `player` to demote
npm run seed:field-test -- --lat <lat> --lng <lng>   # author a walkable trail (see below)
```

## Running in a container

`docker-compose.yml` at the repo root brings up Postgres+PostGIS, applies migrations, and starts
the API:

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

Then point a tunnel (Cloudflare Tunnel, ngrok, …) at `localhost:3000`. **TLS lives in the tunnel
or the host, not in this process** — iOS ATS and Android both refuse cleartext, so the phone has
to reach an `https` URL (§6.8 wants TLS 1.3 in front).

`JWT_SECRET` has no default on purpose: this gets exposed to the public internet through a
tunnel, and a shipped placeholder would let anyone forge any player's session. Compose fails
with an explanatory error if it's unset.

Seeding works inside the container too, since `dist/` ships with the image:

```bash
docker compose exec api node dist/jobs/seedFieldTestTrail.js --lat 13.0827 --lng 80.2707 --code SWAN42
```

The image is deliberately host-neutral — the same artifact runs on a VPS or a PaaS. It runs as
the unprivileged `node` user, carries a `HEALTHCHECK` against `/health`, and handles `SIGTERM`
so the pg pool is released on shutdown (verified: stops in ~1s with exit 0, not a 10s SIGKILL).
`migrations/` ships in the image so a host's release step can run `npm run migrate` against the
exact code being deployed — which is why `node-pg-migrate` is a runtime dependency rather than
a dev one.

### Seeding a trail for the field test (ST-4.3)

A walkable trail at your actual test location, in one command:

```bash
npm run seed:field-test -- --lat 13.0827 --lng 80.2707
npm run seed:field-test -- --lat 51.5 --lng -0.12 --pins 3 --spacing 80 --code SWAN42
```

It creates an Admin, a test player, and a published trail whose pins march east from the given
point (`--spacing` metres apart, `--radius`/`--dwell` to taste), then prints the device keys and
pin coordinates the client needs. `--code` makes the final pin a `code_entry` challenge so a
field test exercises ST-6.2 as well as the dwell.

Writes go through the same store and the same SR-ADMIN-01/02 validation as the Admin API, so a
seeded trail is indistinguishable from an authored one — structural errors refuse to seed, and
advisory warnings (pins too close, and so on) print but don't stop it. Pass `--admin-key` and
`--player-key` to reuse identities across runs.

### Admin access

Authoring routes require `users.role = 'admin'`. There is deliberately no endpoint that grants
it — promotion is the `grant-admin` CLI above, so a stolen player token can never escalate into
authoring rights. The role is re-read from the database on every admin request rather than baked
into the token, so revoking it takes effect immediately instead of waiting out a 30-day session.

### Schema changes (ST-1.3)

`migrations/` is the single source of truth for the schema — there is no `schema.sql` to load by
hand any more. Migrations are append-only: once a file has run anywhere, change the schema by
adding a new migration rather than editing the old one.

## API (v1)

Every `/api/v1` route except the token exchange requires `Authorization: Bearer <JWT>` signed
with `JWT_SECRET`, whose `sub` claim is the player's `users.id`. SR-DATA-01/02: the user id
comes only from the verified token — no route accepts a user id from a body, query, or path.

| Route                                                   | Requirements                                 | Notes                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/players/token`                            | ST-2.6                                       | The only unauthenticated route. Body `{ deviceKey }` → `{ userId, token, expiresInSeconds }`. Find-or-create, so a repeat exchange returns the same player.                                                                                                  |
| `GET /api/v1/trails/:trailId`                           | SR-NET-01, ST-2.1                            | Current published version's pins, ordered by `sequence_index`. This is the payload the client caches for offline browsing. 404 if the trail is unpublished (`current_version_id IS NULL`) or missing.                                                        |
| `POST /api/v1/attempts`                                 | GDR-06, GDR-07, ST-2.2                       | Body `{ trailId }`. Always creates a new attempt (replay never overwrites history) and snapshots the trail version, so a later Admin edit can't move a player's pins mid-trail. Seeds `pin_progress`: lowest `sequence_index` `unlocked`, the rest `locked`. |
| `GET /api/v1/attempts/:attemptId`                       | CR-02, GDR-08                                | Resume path after a restart — returns `currentPinId` plus every pin's status. Marks the attempt `expired` on read if it is past its trail's validity window.                                                                                                 |
| `POST /api/v1/attempts/:attemptId/pins/:pinId/complete` | GDR-01, GDR-04, SR-GEO-04, SR-SEC-02, ST-2.3 | See below.                                                                                                                                                                                                                                                   |
| `POST /api/v1/pins/:pinId/report`                       | GDR-09, ST-2.4                               | Body `{ note? }`. Queues a "can't find this pin" report for the Admin dashboard. No dedup in v1.                                                                                                                                                             |
| `DELETE /api/v1/players/me`                             | SR-PRIV-02, ST-8.2                           | Deletes the caller's location history, progress, attempts, and player row. Pin reports survive with a null reporter — they're an Admin work item about a place, not personal data.                                                                           |

### Authoring API — Admin only (EPIC 7)

| Route                                         | Requirements                   | Notes                                                                                                                                                              |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/admin/trails`                   | ST-7.2                         | Body `{ name, expiryDays? }` → an unpublished trail shell.                                                                                                         |
| `POST /api/v1/admin/trails/:trailId/versions` | ST-7.2, GDR-07, SR-ADMIN-01/02 | Body `{ pins: [...] }`. Writes a new version, its pins, and moves `current_version_id` — in one transaction. Anyone mid-attempt keeps the version they started on. |
| `GET /api/v1/admin/pin-reports`               | ST-7.3, GDR-09                 | `?status=open                                                                                                                                                      | reviewed | resolved`, `?limit=` (default 50). Newest first, and never includes who filed a report. |
| `PATCH /api/v1/admin/pin-reports/:reportId`   | ST-7.3                         | Body `{ status }` — move a report through triage.                                                                                                                  |
| `GET /api/v1/admin/analytics/trails`          | ST-8.3, SR-PRIV-03             | Aggregates per trail, busiest first. `?from=`/`?to=` ISO bounds, `?limit=` (default 50).                                                                           |
| `GET /api/v1/admin/analytics/trails/:trailId` | ST-8.3, SR-PRIV-03             | One trail's aggregates plus a per-pin drop-off funnel.                                                                                                             |

### Analytics (ST-8.3)

Reports attempts started/completed/expired/active, completion rate, median and p90
time-to-complete, and where players stop — exactly the "completion rates, time-to-complete"
SR-PRIV-03 calls for. Requirements §8 puts dashboarding out of scope for v1, so this serves the
raw aggregates and nothing more.

Three properties worth knowing:

- **It never reads `location_history`.** Every number comes from `trail_attempts` and
  `pin_progress`, which hold no coordinates, so analytics is unaffected by the SR-PRIV-01 purge —
  there's a DB-backed test that purges every location row and asserts the response is byte-identical.
- **Small cohorts are suppressed.** Below `MIN_COHORT_SIZE` attempts `[ASSUMED: 5 — confirm or
override]`, rates and timings come back `null` with `suppressed: true`; a completion rate over
  one attempt is a single player's outcome with a percent sign on it. Attempt _counts_ are still
  reported — they describe the trail, not a player.
- **`from` is inclusive, `to` is exclusive**, so week-by-week queries tile without
  double-counting an attempt that started exactly on a boundary. A window with no attempts
  returns zeros rather than a 404, so a caller doesn't have to special-case quiet weeks.

Drop-off is measured against the players who _reached_ each pin, not everyone who started —
otherwise every later pin looks like a cliff. The funnel groups by `sequence_index` across a
trail's versions, since drop-off is a property of the trail and pins change identity when the
Admin republishes (GDR-07).

Publishing distinguishes two kinds of problem. **Errors block** (422) and cover only what would
make a trail unplayable or violate the schema: a sequence with gaps or duplicates, impossible
coordinates, a non-positive radius, an unknown challenge type. **Warnings never block** — the
version publishes and the warnings come back in the response for the Admin tool to show, because
SR-ADMIN-01 makes Admin judgment the control. Implemented warnings are pin spacing below 2× the
smaller radius (a pin that completes itself on unlock), more than 25 pins, a route longer than
20km, and a `code_entry` pin with no code set.

SR-ADMIN-01's "in water" and "inside a building footprint" warnings are **not implemented** —
both need a landcover/footprint data source this service doesn't have. `trailValidation.ts` marks
where they slot in.

### Player identity `[ASSUMED — confirm or override]`

v1 identity is anonymous and device-bound: no signup screen stands between a player and a trail,
and the `users` table carries no credential columns to suggest otherwise. The client generates
32+ bytes from a CSPRNG **once**, hex/base64url encodes it, keeps it in platform secure storage
(iOS Keychain / Android Keystore), and re-exchanges it for a fresh token when the 30-day session
expires. Only the SHA-256 hash of the key is stored, so a database leak doesn't hand over
playable identities.

The consequence to weigh before this ships: the device key _is_ the account. Losing it loses
progress, and there is no recovery path or cross-device sync until real sign-in exists. Adding
that later is a migration on the same `users` row, not a rewrite of progress ownership.

Session tokens are stateless, so a token outlives the SR-PRIV-02 deletion of its player. The
client is told to discard the device key along with the token; a stale token that comes back
anyway gets a clean `401 player_not_found` from attempt creation rather than a database error.

### Completion endpoint

Body: `{ lat, lng, accuracyM, recordedAt?, sessionStartedAt?, recentLocationHistory?,
challengeAnswer? }`. `recordedAt` is the device's _capture_ time, not submission time — an
offline completion queued per SR-NET-02 submits with its original timestamp, and that is what
gets persisted. `challengeAnswer` carries the player's code for a `code_entry` pin and is
ignored by other challenge types.

Rejections are distinguishable so the client can show the right hint:

| Status | `error`                                  | Meaning                                                                                                     |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 404    | `attempt_not_found`                      | Missing, or belongs to another player — deliberately not 403, so attempt ids aren't probeable (SR-DATA-02). |
| 404    | `pin_not_in_attempt`                     | Pin isn't part of this attempt's trail version.                                                             |
| 409    | `pin_locked`                             | Skipping ahead; finish the current pin first (GDR-01).                                                      |
| 409    | `pin_already_completed`                  | Also returned when a concurrent double-submit loses the write-time race.                                    |
| 409    | `attempt_expired` / `attempt_not_active` | GDR-08.                                                                                                     |
| 422    | `accuracy_exceeds_ceiling`               | Accuracy above the 50m ceiling — client shows "GPS signal weak — move to open sky" (SR-GEO-04).             |
| 422    | `outside_effective_radius`               | Response carries `distanceM` and `effectiveRadiusM` for a "move closer" hint.                               |
| 422    | `challenge_answer_required`              | A `code_entry` pin with no `challengeAnswer` sent (ST-6.2).                                                 |
| 422    | `incorrect_code`                         | Wrong code. Unlimited retries, no lockout (GDR-10).                                                         |
| 409    | `challenge_not_configured`               | A `code_entry` pin the Admin published without a code — an authoring fault, not the player's.               |
| 409    | `challenge_type_not_implemented`         | `photo_confirmation`, until ST-6.1 lands.                                                                   |

On success the response includes `nextPinId` (null on the final pin), `attemptStatus`
(`completed` when the last pin lands, GDR-04), and `locationFlag` — non-null when SR-SEC-02
flagged the movement. Per the spec's "flag, don't block" scope the completion still stands; the
flag is logged with the `SR-SEC-02` requirement tag for review.

### Challenge verification (ST-6.2)

Answers are checked server-side only. `pinDto` withholds `challenge_config.code` from the trail
payload, so the code exists in the database and on the real-world plaque — never on the device.

Code comparison is forgiving in every way that doesn't lose information
`[ASSUMED — confirm or override]`: Unicode NFKC folding, case-insensitive, and whitespace,
underscores and the whole dash family stripped — so `SWAN42`, `swan 42` and `swan-42` are one
code, while `SWAN4` and `SWAN042` are not. Verification runs **after** the position check (a
distant player is told to move closer first) and **before** any write, so a wrong answer leaves
no trace at all — not even a location sample — and can be retried immediately, which is what
GDR-10's unlimited retries and GDR-12's stateless attempts require together.

The comparison is not constant-time, deliberately: the code is printed in public on the object
the player is standing beside, the player must already be inside the pin's radius to submit one,
and SR-SEC-03 rate limiting caps guess throughput.

A `photo_confirmation` pin is **refused** with `challenge_type_not_implemented` rather than
completing on position alone. Granting progress for a challenge nothing can verify would be
worse than a clear error while ST-6.1 is outstanding.

## What's implemented vs. stubbed

- `src/services/locationSanityCheck.ts` — **implemented and tested** (SR-SEC-02): sliding-window
  speed check, cold-start grace period, instantaneous-spike allowance.
- `src/services/completion.ts` — **implemented and tested**: the SR-GEO-04 accuracy-vs-radius
  rule, the GDR-01 sequence rule, and the GDR-08 expiry rule, all as pure functions.
- `migrations/` — the schema for trails/versions/pins/attempts/progress/location history/pin
  reports, matching SR-DATA-01/02, GDR-06/07/08, SR-PRIV-01, GDR-09, applied by `npm run
migrate`.
- `src/jobs/purgeLocationHistory.ts` — **implemented and tested** (SR-PRIV-01): the retention
  purge, below.
- `src/routes/*` — **implemented and tested** (ST-2.1–2.5). Route handlers depend on the
  `TrailStore` interface in `src/db/types.ts`, not on `pg` directly, so the sequencing and
  scoping rules are covered by tests without a live database.
- `src/db/postgresStore.ts` — the production `TrailStore`, **verified against a real
  Postgres+PostGIS instance** by the integration test below (token exchange → trail fetch →
  attempt → both pins → replay → cross-player rejection → pin report).
- `src/routes/players.ts` — token exchange (ST-2.6), so a player has a real `users` row for
  `trail_attempts.user_id` to point at.
- `src/routes/admin.ts` + `src/services/trailValidation.ts` — **implemented and tested**: the
  authoring/publish API and report queue behind EPIC 7's desktop tool (ST-7.2, ST-7.3). The 3D
  map UI itself (ST-7.1) is a separate client and isn't built.

## Integration test (ST-2.7)

`npm test` runs everything on the in-memory store and skips the database test. To run the real
SQL, point `TEST_DATABASE_URL` at any Postgres with PostGIS available:

```bash
docker run -d --name arquest-pg-test -e POSTGRES_PASSWORD=arquest -e POSTGRES_USER=arquest \
  -e POSTGRES_DB=ar_quest_trail -p 55432:5432 postgis/postgis:16-3.4-alpine
TEST_DATABASE_URL=postgres://arquest:arquest@localhost:55432/ar_quest_trail npm test
```

It runs the real migrations into a throwaway schema and drops it afterwards, so it never touches
`public` — pointing it at a dev database is safe. Alongside the API walkthrough it covers
migration idempotency (ST-1.3), the SR-PRIV-02 deletion cascades, and the SR-PRIV-01 purge.

## Retention job (SR-PRIV-01, ST-8.1)

`npm run job:purge-location-history` deletes `location_history` rows captured before the
retention window — 90 days by default `[ASSUMED — confirm]`, overridable with
`LOCATION_HISTORY_RETENTION_DAYS`. It prints one JSON line and exits non-zero on failure, so
cron or a Kubernetes CronJob can alert on it; in a built image the entry point is
`node dist/jobs/purgeLocationHistory.js`. **Nothing schedules it yet** — wiring it into the
deployment's scheduler is a deploy-time task, not a code one.

The spec also allows reducing old rows to trail-level facts instead of deleting them. Deleting
is enough: `trail_attempts` and `pin_progress` hold completion facts with no coordinates, so
SR-PRIV-03's aggregate analytics survive a purge with nothing to aggregate first. A misconfigured
window fails loudly rather than purging everything (`retentionCutoff` rejects anything below one
day), and the completion endpoint already skips storing samples it holds at the same capture
timestamp, so the table grows no faster than it must.

## Dependency note

Fastify was moved from the 4.x line to 5.x (with `@fastify/jwt` 10 and `@fastify/rate-limit` 10)
while wiring up auth: Fastify 4 is end-of-life, and `@fastify/jwt` 8 pulls a `fast-jwt` with a
critical JWT auth-bypass advisory — not a base to build SR-DATA-01/02's scoping on. `npm audit`
is clean on both dependency trees.
