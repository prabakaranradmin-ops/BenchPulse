# Client (Unity)

The player app — a Unity project, pinned to **Unity 6.0 LTS (6000.0.84f1)**: open this folder
in Unity Hub (Add → Add project from disk). See `../docs/requirements-v1.0.md` §6 for the
requirement IDs referenced throughout.

## How the code is organised

| Folder | Assembly | What it is | How it's verified |
| --- | --- | --- | --- |
| `Assets/Scripts/Core/` | `ArQuestTrail.Core` | All client logic: API client and tokens, the SR-GEO-04 rule, dwell timing, VPS/GPS selection, offline outbox, caching, progress, join codes, the My trails list, and which screen leads where. **No `UnityEngine`.** | 166 unit tests + 6 contract tests against the real server (`dotnet/`), run in CI |
| `Assets/Scripts/*.cs`, `Platform/` | `ArQuestTrail` | Thin MonoBehaviours: feed Unity's inputs into Core, draw the results — the app's screens (`AppScreens`) and the play screen (`QuestHud`) | Compiled by Unity 6.0 LTS with no warnings, and played end to end in the Editor by `SampleTrailRun` (below). Android/iOS builds not yet made. |
| `Assets/Editor/`, `Assets/Tests/PlayMode/` | Editor / `ArQuestTrail.PlayModeTests` | The sample scene builder, and the automated play-through | Run in Unity 6.0 LTS |
| `Assets/Scripts/ARCore/` | `ArQuestTrail.ARCore` | VPS via ARCore Geospatial + geospatial anchors | API calls checked line by line against ARCore Extensions 1.56.0 source — not compiled |
| `Assets/Scripts/ARFoundation/` | `ArQuestTrail.ARFoundation` | Environment-depth occlusion | API calls checked against AR Foundation 6.6.2 source — not compiled |

The two AR assemblies compile **only once their package is installed** (asmdef `versionDefines` →
`defineConstraints`). So a fresh project with nothing but Newtonsoft compiles and runs in the
Editor with a simulated walker, and VPS/occlusion light up as you add the AR packages. If an AR
API differs in your installed version, the compile error will be in exactly one small file.

Why Core is separate: the trust-critical logic — "is the player close enough", "what happens to a
completion made offline" — must match the server exactly, and that's only checkable where it can
be tested. `dotnet/` compiles the very same `Core/` files for netstandard2.1 + C# 9 (Unity's
profile) and tests them, including against the live server:

```bash
cd client-unity/dotnet/ArQuestTrail.Core.Tests
dotnet test                                     # 166 unit tests
QUEST_API_URL=http://127.0.0.1:3000 QUEST_ADMIN_DEVICE_KEY=<promoted key> dotnet test   # + 6 contract tests
```

## The screens

Decision 2026-10-07 #5: the non-AR screens now, the AR view's polish after the field test. All
immediate-mode GUI (`UiKit` holds the shared look), so a bare scene runs the whole app.

| Screen | What it does |
| --- | --- |
| Welcome | First run only: what the game is. |
| Your location | Why location is needed, *before* the system prompt — GPS isn't started until this has been answered. "Not now" never traps the player; the play screen says when location is off. |
| My trails | The trails this phone has joined, with progress (`TrailLibrary`, stored on the device — there is no server-side listing, per SR-DATA-02). |
| Join a trail | Type a code, or arrive with one: an `arquest://join/CODE` link (the server's `/join/` page and QR codes lead here) is joined straight away. A pasted `https://…/join/CODE` URL works too. |
| Trail details | Pins, time limit, code, progress; Start / Continue / See your result / Start again; remove from the list. |
| Play | `QuestHud`, as before, with a back button. |
| Settings | What's stored and sent, and delete-my-data (SR-PRIV-02), which returns the app to a first run. |

The rules — first run, when to explain location, where a link goes, what Back does — are
`Core/App/AppFlow.cs`, unit-tested; `AppScreens` only draws them.

## 1. Open the project

Unity Hub → Add → *Add project from disk* → this folder, with Unity **6000.0.84f1** (or a newer
6000.0 LTS patch). `Packages/manifest.json` already has what the Editor run needs (Newtonsoft,
the test framework); `Library/` and the rest of what Unity generates is in `.gitignore`.

For a phone build, add the AR packages from `Packages/manifest-additions.json` (AR Foundation,
ARCore/ARKit, ARCore Extensions) and the Android or iOS Build Support module in Unity Hub.

## 2. Project settings (for a phone build)

- **Active Input Handling** is *Input Manager (Old)*, which the location service
  (`Input.location`) needs. If adding an AR template package switches it to the new Input
  System only, set it to *Both*.
- XR Plug-in Management: enable ARCore (Android) / ARKit (iOS).
- Android: min API per ARCore's current requirement; iOS: 13+. LiDAR is **not** required (SR-VIS-02).
- iOS: set *Location Usage Description* (Player → Other Settings) — required for `Input.location`.
  Something like "Shows how far the next pin is and confirms you've reached it."
- **Join links (`arquest://join/CODE`):** iOS — Player → Other Settings → *Supported URL schemes*,
  add `arquest`. Android — add an intent filter to a custom `AndroidManifest.xml`
  (Player → Publishing Settings → *Custom Main Manifest*), inside the Unity activity:
  ```xml
  <intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="arquest" android:host="join" />
  </intent-filter>
  ```
  Without this a QR code still works — the server's `/join/` page shows the code to type in.
  (Opening the app straight from an `https` link needs Universal Links / App Links and a hosted
  association file — not set up for the field test.)
- ARCore Extensions config (Project Settings → XR → ARCore Extensions): enable **Geospatial** and
  set up authorization (API key or keyless) per Google's Geospatial docs. Without it, `EarthState`
  reports an error and the app falls back to GPS, which is handled — just not sub-meter.

## The sample scene

`Assets/Scenes/SampleTrail.unity` is the default camera and light plus `QuestBootstrap` pointed
at `http://127.0.0.1:3000` (**AR Quest Trail → Create Sample Scene** rebuilds it). With a server
running and a trail seeded near the Editor walker's start, open it, press Play and use the app —
or let a script do it:

```bash
# from the repo root, with the server on :3000
(cd server && npm run seed:field-test -- --lat 13.0827 --lng 80.2707 --pins 3 --spacing 30 --dwell 5 --code SWAN42)
# then, with the printed join code:
QUEST_API_URL=http://127.0.0.1:3000 QUEST_JOIN_CODE=ABCD-EFGH \
  "<Unity Editor>/Unity.exe" -projectPath client-unity -runTests -testPlatform PlayMode -testResults sample-run.xml
```

`Assets/Tests/PlayMode/SampleTrailRun.cs` plays it end to end in the Unity runtime: first-run
screens, join by code, the walker walking to each pin, the code typed sloppily, the finish, back
to My trails. Without `-batchmode` it saves a screenshot of every screen to `Logs/sample-run/`.
It uses its own player data folder, so your Editor player is untouched.

## 3. Play it in the Editor first

1. Bring the server up and seed a trail (from the repo root):
   ```bash
   JWT_SECRET=$(openssl rand -hex 32) docker compose up --build -d
   docker compose exec api node dist/jobs/seedFieldTestTrail.js --lat 13.0827 --lng 80.2707 --code SWAN42
   ```
2. Open **`Assets/Scenes/SampleTrail.unity`**. Its `QuestBootstrap` points at
   `http://127.0.0.1:3000` (the Editor may use plain http; phones may not), and the simulated
   walker starts 32 m west of 13.0827, 80.2707 — so seed there, or move the start.
   For a phone-shaped view, pick a portrait resolution in the Game view (e.g. 540×1080).
3. Press Play and go through the app as a player: *Get started* (the Editor always has location,
   so the location screen is skipped) → *Join a trail* → the **join code** from the seed output →
   *Start trail*. (Or set *Trail Id* on `QuestBootstrap` to skip straight to the play screen.)
4. On the play screen the HUD shows position source, connectivity, the active pin with distance
   and direction, and an **Editor walker**: tick *Walk to the active pin* and watch the dwell count
   up, the server confirm, and the next pin unlock. Try the code pin with a wrong code, then the
   right one typed sloppily (`swan 42`). Tick *Simulate airplane mode* mid-trail to exercise
   SR-NET-02. *Back* returns to the trail's details; My trails shows the progress.

That run covers the whole loop against the real server — everything except AR and real GPS.

## 4. The AR scene for a device (ST-4.3)

1. Add **AR Session** and **XR Origin (AR)** (GameObject → XR).
2. On the XR Origin: **AR Anchor Manager**, **AR Earth Manager** (ARCore Extensions), and
   **`ArCoreGeospatialProvider`** (wire both managers, or leave them empty to auto-find).
3. On the AR Camera: **AR Occlusion Manager** and **`ArFoundationDepthProvider`**.
4. Keep the `QuestBootstrap` object; set *Api Base Url* to your **https** tunnel URL.
5. Build to the phone and walk the seeded trail. Per requirements §7, note per device: time to VPS
   (status line), whether the GPS fallback kicked in, and whether "move closer" / "GPS signal weak"
   fired when expected.

## Requirements → where they live

| Requirement | Core (tested) | Unity layer |
| --- | --- | --- |
| GDR-01 sequencing | `TrailProgress` | `PinController` (only the active pin is a target) |
| GDR-02 proximity_dwell | `DwellTracker` | `ProximityDwellChallenge` |
| GDR-04/06 summary, replay | `QuestSession.ReplayAsync` | `QuestHud` |
| GDR-07 version resume | `QuestSession` + versions endpoint | — |
| GDR-09 report | `QuestApiClient.ReportPinAsync` | `QuestHud` |
| SR-GEO-02/ST-3.2 ENU offset | `GeoMath.ToEnu` | `PinController` (Editor placement) |
| SR-GEO-03 VPS thresholds, SR-NET-03 fallback | `PositionSourceSelector` | `VpsLocalizationService`, `ArCoreGeospatialProvider` |
| SR-GEO-04 radius rule + weak-GPS hint | `CompletionRules` | `QuestHud` |
| SR-NET-01 trail cache | `TrailCache` | — |
| SR-NET-02 offline queue (ST-9.1) | `CompletionOutbox` | `TrailManager` (retry on reconnect) |
| CR-04 / ST-9.2 indicators | `PositionEstimate.IsReducedPrecision`, `IsOffline` | `QuestHud` status lines |
| SR-SEC-02 inputs | `LocationHistoryBuffer` | `QuestBootstrap` (every fix; foreground = session start) |
| SR-VIS-01/02 occlusion | `DistanceFade` | `OcclusionFallbackController`, `ArFoundationDepthProvider` |
| SR-PRIV-02 delete my data | `QuestSession.DeleteMyDataAsync` (clears the My trails list too) | `AppScreens` (Settings) |
| ST-6.2 code entry | server-verified; `ChallengeTypes.CanVerifyOnDevice` | `QuestHud`, `QuestBootstrap.SubmitCodeAsync` |
| ST-2.10 join codes and links | `JoinCode`, `QuestSession.JoinAsync`, `TrailLibrary` | `AppScreens`, `QuestBootstrap` (deep links) |
| Screen flow, location explained before asked | `AppFlow` | `AppScreens`, `LocationPermission` |

## Known limits — before launch, not before the field test

- **The device key sits in the app sandbox** (`persistentDataPath`), not iOS Keychain / Android
  Keystore. Fine for a field test; for launch it needs a native secure-storage plugin. Since the key
  *is* the account (ST-2.6), losing or leaking it loses or leaks the player.
- **The UI is IMGUI** — clean and self-contained, needing no scene wiring, but immediate-mode:
  no animation, and the system font. Moving to UI Toolkit is a later polish step; the screen logic
  is in Core and wouldn't change.
- **Location keeps running in the menus** once started (only gameplay and SR-SEC-02 history are
  limited to the play screen). Pausing it off the play screen would save battery.
- **Pins are hidden, not approximated, without VPS.** SR-GEO-03 renders anchored pins only at
  ≤0.5m/≤5°; on GPS the HUD gives distance and direction instead, and gameplay continues.
- **SR-GEO-01 floating-origin re-centring is deferred** (approved): ENU offsets are accurate across a
  few kilometres, ample for the field test.
- **The VPS timeout is 5s** `[ASSUMED]`. ARCore Geospatial often needs longer to reach 0.5m; the
  selector switches back to VPS the moment it qualifies, so a short timeout only means starting on GPS.
- **ST-6.1 photo pins** are refused by the server; the HUD says so rather than offering a dead button.
