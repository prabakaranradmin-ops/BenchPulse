# Admin web tool

The Admin's authoring tool (EPIC 7, decision 2026-10-07 #3): React + CesiumJS, built to static
files and served by the API server at `/admin/` — same origin as the API and the `/join/` page, so
there is no CORS to configure and one tunnel covers everything.

What it does:

- **Trails** — every trail with its join code, live version, pin count and open reports; create
  a new one.
- **Trail editor** — the 3D map plus a side panel. Find the spot (place name or `lat, lng`), then
  _Add pins_ and click the map in walking order. Per pin: challenge (stay nearby for N seconds, or
  enter a code found on site — checked on the server only), radius (drawn on the map) and an
  optional hint. Reorder, move, delete. Placement checks (SR-ADMIN-01/02: spacing, water,
  buildings, length, missing codes) run as you edit and mark problem pins on the map; errors
  block publishing, warnings are listed in the publish confirmation. Edits are a draft until
  published, and survive a reload or a visit to another screen in the same tab.
  Also here: rename, the GDR-08 time limit, the join code (copy, link, QR code as a PNG, issue a
  new code), and the version history.
- **Reports** — players' "can't find this pin" reports, with _Show on map_ and triage.
- **Analytics** — completion counts, rate and times per trail and a per-pin drop-off funnel,
  over 7/30/90 days or all time. Rates and times are withheld below 5 attempts (SR-PRIV-03).

## Running it

Sign-in uses an Admin key. Create one with `npm run admin:new-key` in `server/` (or
`docker compose exec api node dist/jobs/grantAdmin.js --new-key`); it is printed once. The tool
exchanges it for a session token and keeps only the token — in this tab, or in the browser if
"keep me signed in" is ticked.

**With Docker** nothing else is needed: the image builds this tool, and `docker compose up`
serves it at <http://localhost:3000/admin/>.

**From source**, with the server running on port 3000:

```bash
npm install
npm run dev      # http://localhost:5173/admin/ — proxies /api and /join to :3000
npm run build    # dist/, which the server serves at /admin/ (restart it after the first build)
```

```bash
npm test             # lib/ unit tests (API client, draft model, formatting, routing, place search)
npm run lint
npm run format:check
```

## The map

- **No token (default):** OpenStreetMap tiles on a smooth globe. Nothing is sent to Cesium ion.
- **`CESIUM_ION_TOKEN` set on the server** (a free Cesium ion account's token): Cesium World
  Terrain and OSM Buildings, so you can see whether a pin sits on a roof, a slope or a street.
  The server hands the token only to signed-in Admins (`GET /api/v1/admin/config`). Restrict the
  token to your admin URL in the ion dashboard. This mode has not yet been exercised with a real
  token.

Place search uses OpenStreetMap's Nominatim — one request per search, no search-as-you-type, as
its usage policy asks.

## Notes for changing it

- The page's CSP (set by `server/src/routes/adminWeb.ts`) allows same-origin script only, with
  no `unsafe-eval`. That is why the map uses `CesiumWidget` rather than `Viewer`: Viewer's
  widgets are built with Knockout, which compiles bindings with `new Function`. New external
  hosts (another imagery provider, say) must be added to that CSP.
- CesiumJS is most of the bundle, so the editor is lazy-loaded; the other screens don't pay for
  it. `scripts/copy-cesium.mjs` copies Cesium's workers and assets into `public/cesium/`
  (gitignored) before every dev run and build.
- Map entities are replaced only when their pin changes, each time under a fresh id — see the
  comment on `syncEntities` in `src/components/MapView.tsx` for why re-adding an id in place
  breaks Cesium's change tracking.
- `src/lib/` holds everything testable without a browser (API client, the draft model, formatting,
  routing, place search); components stay thin over it.
