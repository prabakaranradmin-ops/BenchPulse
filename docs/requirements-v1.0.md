# AR Quest-Trail Game — Complete Requirements Specification (v1.0)
*Consolidates the original technology stack/CRS/SRS, the v0.2 gap-resolution addendum, and the v0.3 items below into one document. Supersedes both prior files.*

## How to read this document
Every open product call that didn't have an explicit decision from you is filled with a **default**, marked `[ASSUMED — confirm or override]`. Nothing here is silently guessed without a flag — where I picked a value (a threshold, a retention period, a retry policy), it's called out so you can change it in one place before this goes into your requirements tool.

---

## 1. Technology Stack
*(unchanged from original, scoped by decisions below)*

| Layer | Technology | Rationale |
| --- | --- | --- |
| Engine Core | Unity (LTS 2023.3+ / 6000 LTS) | Stable C# runtime, cross-platform build support (iOS, Android, Windows Desktop) |
| Visual Positioning (VPS) | Google ARCore Geospatial API / Niantic Lightship VPS | Sub-meter anchoring where street-level VPS coverage exists |
| AR Abstraction | Unity AR Foundation (ARKit + ARCore) | Unified surface detection, VIO, raycasting; also the source of the non-LiDAR depth fallback (§6.2) |
| Geospatial & 3D Terrain | Cesium for Unity / Mapbox SDK | 64-bit coordinate tiling, prevents 32-bit vertex jitter |
| Backend API | Go or Node.js (Fastify) | Low-latency spatial query processing |
| Spatial Database | PostgreSQL + PostGIS | Indexed geospatial queries (`ST_DWithin`, `ST_Distance`) |
| Data Transport | Protobuf over gRPC / WebSockets | Compact payloads, bi-directional streaming |

---

## 2. Personas

* **Player (mobile):** Follows an authored quest trail — travels to each AR-anchored waypoint in sequence, completes the challenge there, unlocks the next. Sees only their own progress; no other players' pins or activity are visible (§4).
* **Quest Author / Admin (desktop, GIS workstation):** Authors trails from a 3D map interface — places pins in sequence, sets challenge type, radius, and (new) validity/expiry rules. Sole producer of pin content in v1.

---

## 3. Customer Requirements Specification (CRS)

**Business Objective:** Deliver an AR game where players follow authored, sequential quest trails anchored to precise real-world locations, without perceptible drift or unfair device-dependent advantage.

### Functional Requirements
* **CR-01 (Sub-Meter Pin Accuracy):** Pinned markers remain anchored to the designated location without drift as the player moves, subject to the accuracy-degradation handling in SR-GEO-04.
* **CR-02 (Persistent Anchoring, revised):** A pin's *definition* (lat/lng/alt, radius, challenge) persists across restarts. A player's *progress* against that pin persists per-player (§4, SR-DATA-01) — it is private, not shared.
* **CR-03 (Occlusion):** Where a depth sensor is available, pins behind real-world structures are occluded (SR-VIS-01). Where it isn't, a fallback visual cue applies (SR-VIS-02) so gameplay stays fair rather than broken.
* **CR-04 (Degraded/Offline Handling, revised — see §6):** The app must clearly signal reduced tracking or connectivity quality rather than silently failing or teleporting a pin.
* **CR-05 (Contextual Inspection):** Interacting with a pin shows its challenge (type, status, hints) — see §5 Game Design Requirements.

### Non-Functional Expectations
* Sustain ≥60 fps in AR to avoid motion sickness.
* No thermal/battery cliff during 20+ minute sessions.

---

## 4. Multiplayer / Ownership Model

* **SR-DATA-01 (Ownership):** Trail *definitions* are shared (authored once by Admin); trail *progress* resolves per `(trail_id, user_id)`. Players never write to a shared progress row — this removes the multi-user write-conflict problem entirely for v1.
* **SR-DATA-02 (No Public Discovery):** `GET /api/v1/pins`-style queries are always scoped server-side to the requesting player's own assignments. No public radius search, no browsing other players' pins.
* **Backlog (not built now):** shared/team trails, public leaderboards, cross-player geofencing enforcement. Revisit only if a public-world mode is added.

---

## 5. Game Design Requirements (GDR)

* **GDR-01 (Trail Structure):** A trail is an ordered list of pins (`sequence_index: 1..N`). Pin *n+1* is locked (non-interactable, and per SR-VIS-02 rendered only as a distance cue, not a real target) until pin *n* is completed by that player.
* **GDR-02 (Challenge Types):** `proximity_dwell` (stay within radius for a minimum duration — build this first), `photo_confirmation`, `code_entry`.
* **GDR-03 (Per-Player Progress State, revised):** Stored per `(user_id, trail_id, attempt_id)` — see GDR-06 for why `attempt_id` was added.
* **GDR-04 (Completion Feedback):** Completing the final pin shows a summary/badge screen. Points/currency/narrative rewards remain out of scope for v1 — a product decision, not a technical gap.
* **GDR-05 (Authoring Flow):** Admin creates a trail, adds pins in order, sets challenge type + radius, previews on the 3D map, publishes. Extended by GDR-07/08 below.

### New in v1.0 — Trail Lifecycle (resolves feedback items #1, #10)
* **GDR-06 (Reset/Replay) `[ASSUMED — confirm or override]`:** A player may restart a completed trail. Replaying creates a new `attempt_id` rather than overwriting the original — so completion history isn't destroyed and analytics/streaks stay meaningful. Default: unlimited replays.
* **GDR-07 (Trail Versioning) `[ASSUMED — confirm or override]`:** If an Admin edits a published trail (adds/removes/reorders pins), a player already mid-trail continues on the version snapshotted at the moment they started their attempt. New attempts (by that player or others) start on the latest published version. This avoids breaking someone mid-trail when content changes underneath them.
* **GDR-08 (Optional Expiry) `[ASSUMED — confirm or override]`:** Trails have no expiry by default. Admin may optionally set a validity window (e.g., "complete within 7 days of starting") per trail; an expired in-progress attempt is marked `expired`, not deleted, and does not block a fresh attempt.
* **GDR-09 (Post-Publish Issue Reporting, resolves feedback #10):** Player app includes a lightweight "can't find this pin" report action. Reports queue in the Admin dashboard against that pin — a manual review/relocate workflow rather than automated environment-change detection, which is out of scope for v1.

### New in v1.0 — Challenge State Machine (resolves feedback #7)
* **GDR-10 (Retry Policy) `[ASSUMED — confirm or override]`:** Unlimited retries on any challenge type in v1 — no lockout. Revisit if `photo_confirmation` abuse becomes an issue.
* **GDR-11 (No Forced Timeout) `[ASSUMED — confirm or override]`:** Once a pin is unlocked, its challenge does not expire on its own. Only the trail-level expiry in GDR-08 (if the Admin set one) can time it out.
* **GDR-12 (Partial Progress):** `code_entry` and `photo_confirmation` attempts are stateless per attempt — a player can leave and return without losing trail position, since trail position (not in-progress challenge input) is what's persisted.

---

## 6. System Requirements Specification (SRS)

### 6.1 Coordinate Management & Precision Engine
* **SR-GEO-01 (Floating Origin):** unchanged — dynamic local origin re-centering beyond 500m from scene origin.
* **SR-GEO-02 (Double-Precision Offset):** unchanged — 64-bit storage, single-precision offsets for rendering.
* **SR-GEO-03 (VPS Localization Flow):** unchanged — render pins only when horizontal accuracy ≤0.5m and heading accuracy ≤5°, when VPS is available.
* **SR-GEO-04 (Accuracy-vs-Radius Handling, new — resolves feedback #3):** Effective completion radius = `max(pin.radius, device.reported_accuracy)`, capped at a configurable ceiling `[ASSUMED: 50m]`. If reported accuracy exceeds the ceiling, show "GPS signal weak — move to open sky" instead of silently blocking or falsely completing the pin. Altitude/3D (multi-level buildings) is **out of scope for v1** — documented limitation, not a blocking gap, unless indoor trails are added later.

### 6.2 Depth & Occlusion
* **SR-VIS-01 (Hardware Occlusion):** unchanged — on LiDAR/ToF/depth-capable devices, feed the depth buffer into an AR occlusion shader.
* **SR-VIS-02 (Fallback Occlusion, resolves feedback #8):** On devices without a usable depth signal: attempt AR Foundation's environment depth API first (works on many non-LiDAR Android devices via stereo estimation); if unavailable, fall back to a distance-based visual cue `[ASSUMED: opacity fade + slight scale-down beyond ~15m]` rather than hard occlusion. Since `proximity_dwell` doesn't require line-of-sight to function, this is a polish/fairness requirement, not gameplay-blocking. Exact cue styling (fade vs. outline vs. scale) is a UI/visual-design decision to finalize with whoever builds the AR view, not a requirements-level item.

### 6.3 Connectivity & Offline Behavior (new — resolves feedback #2)
* **SR-NET-01 (Trail Data Caching):** Trail definitions (sequence, challenge types, radii, hints) are downloadable and cacheable client-side, so a player can browse/navigate a trail without a live connection.
* **SR-NET-02 (Completion Requires Connectivity) `[ASSUMED — confirm or override]`:** Marking a pin complete requires a live connection at the moment of completion, since server-side validation (SR-SEC-02) and, where used, VPS localization both need it. Completions attempted offline are queued client-side and submitted on reconnect, timestamped at the moment of the *offline* completion (not reconnect) for the sliding-window check in SR-SEC-02 to evaluate correctly.
* **SR-NET-03 (VPS Unavailable Fallback):** If VPS localization fails or times out but device GPS is available, fall back to GPS-only positioning against SR-GEO-04's accuracy-vs-radius logic, with a UI indicator that precision is reduced.

### 6.4 Trust & Safety — Minimal Viable Checks
* **SR-SEC-02 (Location Sanity Check, tuned — resolves feedback #4):** Flag (not hard-block) a player's session when **average speed exceeds 30 m/s over a trailing 30-second window** `[ASSUMED]`, allowing brief instantaneous spikes up to 45 m/s `[ASSUMED]` (covers a passenger glancing at the app on a highway). The check is **suspended for the first 15 seconds after app foreground/cold start** `[ASSUMED]` to absorb GPS-fix settling drift, which otherwise produces false positives on nearly every session start.
* **SR-SEC-03 (Rate Limiting):** unchanged — basic per-user rate limit on the pin/progress API.
* **Explicitly deferred:** device-integrity attestation (Play Integrity/DeviceCheck), full mock-location detection, content moderation (not needed while all content is Admin-authored — revisit the moment `photo_confirmation` content becomes visible to anyone but its owner).

### 6.5 Authoring & Content Validation (new — resolves feedback #5)
* **SR-ADMIN-01 (Placement Warnings, advisory only) `[ASSUMED — confirm or override]`:** The Admin tool warns (does not block) when a pin appears to be in water, inside a building footprint with no visible public access, or within a minimum spacing distance of the previous pin in the same trail `[ASSUMED: 2× the smaller pin's radius]`, to avoid a pin that completes itself instantly on unlock. Full geocoding/accessibility validation (verifying a location is legally/physically reachable) is out of scope for v1 — Admin judgment is the control.
* **SR-ADMIN-02 (Trail Length Limit) `[ASSUMED — confirm or override]`:** Soft warning (not hard cap) if a trail exceeds 25 pins or 20km total span, to flag potential support/QA burden before publishing.

### 6.6 Privacy & Data Retention (resolves feedback #6)
* **SR-PRIV-01 (Retention Period) `[ASSUMED — confirm or override]`:** Raw per-player location history is retained 90 days, then deleted or reduced to trail-level completion facts (no raw coordinates) for analytics.
* **SR-PRIV-02 (Deletion/Export):** A "delete my data" account action is in scope for v1 — deletes raw location history and progress records for that user. A full formal export/portability flow is deferred, but deletion is not.
* **SR-PRIV-03 (Analytics Anonymization):** Internal analytics use aggregated/anonymized completion data (trail completion rates, time-to-complete), never raw per-player coordinate trails, once the retention window above has passed.

### 6.7 External Interface & Hardware Requirements
* **Desktop Admin:** x86_64, ≥16GB RAM, dedicated GPU (DX12/Vulkan, ≥4GB VRAM) — unchanged.
* **Mobile Player (broad tier, revised):** ARCore-capable Android 8+ / ARKit-capable iOS 13+. LiDAR/ToF is *not* required — SR-VIS-02 covers the gap. Network: HTTPS (443) + WebSocket; minimum 5 Mbps recommended, but SR-NET-01–03 define graceful behavior below that.

### 6.8 Non-Functional Requirements
* Frame budget: ≥60 fps mobile (≤16.6ms/frame); VPS round-trip ≤1.5s when VPS is in use.
* Reliability: tracking recovers within 2s after app backgrounding/interruption.
* Security: TLS 1.3 + JWT session auth (unchanged), plus SR-SEC-03 rate limiting.
* **Still backlog, not built for v1:** full DR/backup SLA, i18n, formal accessibility audit, analytics dashboarding beyond the raw aggregates in SR-PRIV-03.

---

## 7. Test Strategy / Traceability

| Requirement group | Test approach |
| --- | --- |
| GDR-01–03, 06–08 (trail sequencing, replay, versioning) | Unit tests on lock/unlock and version-snapshot logic; integration test simulating full trail walkthrough + a mid-trail Admin edit |
| SR-GEO-03/04 (VPS accuracy, degraded handling) | Field matrix: 3+ device tiers × dense-urban vs. weak-VPS-coverage environments; assert "move closer" hint fires when accuracy > radius |
| SR-VIS-02 (fallback occlusion) | Manual visual QA per device tier (no automated "looks fair" check — budget reviewer time explicitly) |
| SR-NET-01–03 (offline/VPS-unavailable) | Airplane-mode test: start trail offline, complete a pin offline, verify queued-timestamp submission on reconnect against SR-SEC-02 |
| SR-SEC-02 (tuned anomaly check) | Scripted client tests: cold-start grace period doesn't false-positive; sustained 35 m/s over 30s does flag; a single 40 m/s highway-passenger spike does not |
| SR-DATA-01/02 (privacy scoping) | Automated test asserting player A's API calls never return player B's rows |
| SR-PRIV-01/02 (retention/deletion) | Scheduled-job test confirming 90-day purge runs; manual test of the delete-my-data action |

---

## 8. Backlog — Explicitly Out of Scope for v1
Shared/public world mode, social/team features, monetization/economy, full anti-cheat (device attestation, mock-location detection), content moderation pipeline, multi-level/indoor (altitude-aware) pins, automated pin-relocation on environment change (GDR-09's manual report queue is the v1 answer), formal accessibility/i18n, DR/backup SLA.
