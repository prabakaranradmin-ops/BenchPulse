# Client (Unity)

Unity projects are created through Unity Hub/Editor, not from the command line, so this folder
isn't a runnable Unity project yet — it's the target shape to create and drop these files into.
See `../docs/requirements-v1.0.md` §6.1–6.2 and §6.7 for the requirements these scripts implement.

## 1. Create the project

1. Unity Hub → New Project → **3D (URP)**, Unity **2023 LTS** or **6000 LTS**.
2. Name it to match this folder (`client-unity`) and create it one level up from this repo, or
   create it here and let Unity populate `Assets/`, `ProjectSettings/`, `Packages/manifest.json`
   around the files already in this folder — either works, Unity will merge with what exists.

## 2. Install required packages (Package Manager → Add package by name)

- `com.unity.xr.arfoundation` — AR Foundation (SR-VIS-01/02, SR-GEO-03)
- `com.unity.xr.arcore` — ARCore XR Plugin (Android)
- `com.unity.xr.arkit` — ARKit XR Plugin (iOS)
- **ARCore Extensions** (Google's separate package, installed via its own tarball/git URL per
  Google's current instructions — not in the main registry) for the Geospatial API used in
  SR-GEO-03. See `Packages/manifest-additions.json` in this folder for the exact entries to
  merge into your generated `Packages/manifest.json`.
- If using Niantic Lightship VPS instead of/alongside ARCore Geospatial: install the Lightship
  ARDK package per Niantic's current SDK instructions.

## 3. Project settings

- Player Settings → enable ARCore (Android) / ARKit (iOS) support under XR Plug-in Management.
- Android: minimum API level per SR-GEO-03/CR-01 hardware requirements (ARCore-supported,
  Android 8+ per the broad-compatibility decision in requirements §6.7).
- iOS: minimum iOS 13+ (broad tier) — LiDAR is NOT required (SR-VIS-02 covers non-LiDAR devices).

## 4. Script stubs in `Assets/Scripts/`

Each file below is a skeleton — class shape, dependencies, and requirement-ID comments, not a
finished implementation. Fill them in against the server API (`../server/`) once its unit tests
pass, per the build order in `../CLAUDE.md`.

| File | Requirement(s) | Purpose |
| --- | --- | --- |
| `TrailManager.cs` | GDR-01, GDR-06/07 | Fetches/caches a trail (SR-NET-01), tracks current attempt and sequence position |
| `PinController.cs` | GDR-01, SR-GEO-01/02 | Places a single pin's AR anchor at the correct local-origin offset; enabled/disabled by lock state |
| `ProximityDwellChallenge.cs` | GDR-02 | The first challenge type to implement — dwell-time-in-radius check, using SR-GEO-04's effective radius |
| `VpsLocalizationService.cs` | SR-GEO-03, SR-NET-03 | Wraps ARCore Geospatial/Lightship VPS queries; falls back to GPS-only per SR-NET-03 when VPS is unavailable |
| `OcclusionFallbackController.cs` | SR-VIS-01, SR-VIS-02 | Picks hardware occlusion vs. the distance-fade fallback depending on device depth capability |

## 5. First playable slice

Per the sequencing plan: get `ProximityDwellChallenge` + `VpsLocalizationService` (or GPS-only
fallback) working end-to-end against the server's trail-fetch and pin-complete endpoints before
touching occlusion (`OcclusionFallbackController`) or the other challenge types at all.
