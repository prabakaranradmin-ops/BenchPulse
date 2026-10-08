# Decision log

Product and technical decisions made by the project owner, with the reasoning that was on the
table at the time. Newest first. Anything still marked `[ASSUMED]` in the spec is *not* decided —
it's a placeholder default (see `CLAUDE.md`).

## 2026-10-08 — Behaviour questions raised while building the admin tool and app screens

| # | Question | Decision | What it means for the build |
| --- | --- | --- | --- |
| 1 | When an Admin changes a trail's time limit (GDR-08), who does it apply to? | **Everyone, including players mid-trail** | No change: expiry is judged against the trail's current setting. Shortening a limit can expire an attempt in progress; lengthening it doesn't revive attempts already marked expired. The admin tool's settings help text says so. |
| 2 | How are the Unity scripts checked automatically? | **By hand for now; GameCI later** | Unity-layer type-checks stay manual (against Unity 2021.3 reference assemblies). Once the Unity project itself is created and committed, CI builds it with the owner's Unity licence via GameCI, AR assemblies included. No third-party Unity DLL package in CI. |
| 3 | Turn GPS off while the player is in the menus? | **Keep it on for now** | GPS starts after the location screen and stays on; only gameplay and SR-SEC-02 history are limited to the play screen. Revisit after the field test with battery numbers. |
| 4 | Should QR codes and links open the app directly (Universal Links / App Links)? | **Not yet** | QR codes keep opening the server's `/join/` page, which shows the code and an `arquest://` "Open in the app" button. Needs the app IDs and signing fingerprint when revisited. |

## 2026-10-07 — UI, admin tooling, and remaining open questions

| # | Question | Decision | What it means for the build |
| --- | --- | --- | --- |
| 1 | How do players find a trail? | **Link / QR / join code** | Each trail gets a short code (`XXXX-XXXX`). A link or QR opens it; the app has a "Join" screen for typing it. No browsing or nearby search (SR-DATA-02). |
| 2 | Who designs the player UI? | **Claude builds a clean default** | A simple, consistent theme (`UiKit`), built to be restyled later. Built in Unity's immediate-mode GUI so it runs on a bare scene with no prefabs; moving the screens to UI Toolkit is a later polish step (the screen logic lives in Core's `AppFlow` and wouldn't change). |
| 3 | Admin tool technology (ST-7.1)? | **CesiumJS web app first; Unity desktop app later** | A browser-based admin served by the API server. The Unity desktop tool is deferred until the web tool proves insufficient. |
| 4 | Photo challenges (ST-6.1)? | **Defer; keep photo pins blocked** | The server keeps refusing `photo_confirmation` pins; the app says so. |
| 5 | When to build the production player UI? | **Non-AR screens now; AR view after the field test** | Onboarding, join, my trails, completion summary, settings now. The in-trail HUD stays the field-test HUD until ST-4.3 shows how VPS/GPS behave. |
| 6 | When to move the device key to Keychain/Keystore? | **After the field test** | App-sandbox storage stays for ST-4.3; native secure storage before any real players. |
| 7 | Where does the SR-PRIV-01 purge run? | **A scheduler service in docker-compose** | A small container runs the purge daily next to the API. |
| 8 | 3D map data for the admin tool? | **Cesium ion: terrain + OSM buildings** | Needs a free Cesium ion token (`CESIUM_ION_TOKEN`); falls back to a flat OpenStreetMap view without one. |
| 9 | SR-ADMIN-01 water/building warnings? | **OpenStreetMap lookup at publish (Overpass API)** | Advisory warnings when a pin falls in water or inside a building; if Overpass is unreachable, publishing still succeeds with a note. |

## Earlier decisions (2026-09)

- **Device key is the account** for the ST-4.3 field test; account linking/recovery is a
  post-slice upgrade.
- **ST-3.2 simplified**: local ENU offsets for the field test; SR-GEO-01 floating-origin
  re-centring / Cesium for Unity deferred until after ST-4.3.
- **Assumed values locked for now**: 50m accuracy ceiling, 90-day retention, 30-day tokens,
  25-pin / 20km authoring guidelines, 5-attempt analytics cohort minimum.
- **Admin security model approved**: role re-read from the database on every admin request;
  promotion only through the CLI, never an endpoint.
- **Hosting**: the owner provides TLS via a tunnel (Cloudflare Tunnel / ngrok) in front of the
  docker-compose stack.
