# WxW Time Tracker

A desktop app (macOS / Windows) that talks to a **TimeFlip2** time-tracking die over
**Bluetooth Low Energy** and writes time entries into the **WxW Delivery** Airtable base.
It speaks the device's BLE GATT protocol directly — it does **not** use the TimeFlip cloud API.

> **BLE transport:** uses **Electron's built-in Web Bluetooth** (Chromium), so there are no
> native modules to compile. The GATT work runs in a hidden, always-on background window; the
> main process auto-selects the configured device (no chooser popup) and runs all sync logic.
> (The original plan used `@abandonware/noble`, but its Windows WinRT native binding fails to
> compile against current Windows SDKs — an upstream bug — so the transport was moved to Web
> Bluetooth, which is zero-native and identical across macOS/Windows.)

When you flip the die to a face, the app closes the previous time entry and opens a new
one, mapping the face to a project (Adventure) and billable role using the **TimeFlip Faces**
table. It also periodically reads the die's onboard history to backfill anything tracked
while the app was closed or out of range.

```
TimeFlip2  ──BLE──▶  Electron app  ──REST──▶  Airtable (Hours / Hours Testing)
 facet 1–12             │  face → TimeFlip Faces → Adventure + Billable Role + Hour Type
 (notify 6F52)          │  flip → close open Hours (End) + open new Hours (Start)
 history (6F58)         │  reconcile → backfill offline sessions
```

## How the data maps

| Device | Airtable |
| --- | --- |
| Physical die | `TimeFlip` record (chosen from a dropdown in the setup screen) → gives **Assignee** |
| Face 1–12 | `TimeFlip Faces` record (`Face Number`) → **Adventure**, **Billable Role**, **Hour Type** |
| A session on a face | `Hours` (or `Hours Testing`) record: `Name`, `Start`, `End`, `Adventure`, `Billable Role`, `Type` |

`Hour Type` choices on a face match the `Type` choices on Hours one-to-one
(`Time & Materials - Actual`, `Fixed Fee - Actual`, `Record Only - Actual`).

## Download the app

Grab the latest installer from the repository's **[Releases](../../releases)** page:

- **Windows:** `WxW Time Tracker Setup <version>.exe`
- **macOS:** `WxW Time Tracker-<version>.dmg` (universal — works on Apple Silicon and Intel)

> This is a **private** repo, so downloading requires a GitHub account with access to it. If
> you'd rather not give everyone repo access, download the two installer files once and share
> them via Slack/Drive — they're self-contained.

## For end users (no terminal required)

1. **Install** — run the installer for your platform.
   - **Windows:** run **`WxW Time Tracker Setup.exe`** — installs to your account and opens
     automatically (no admin needed). It's unsigned, so SmartScreen may warn — choose
     *More info → Run anyway*.
   - **macOS:** open the **`.dmg`**, drag **WxW Time Tracker** to Applications. First launch:
     right-click the app → **Open** → **Open** (clears the unsigned-app warning). Click
     **Allow** when it asks for Bluetooth.
2. **Set up** — on first launch the app opens a setup screen:
   - **Paste your Airtable access token.** Click *Where do I get one?* to open the Airtable
     token page; create a token with read **and** write access to the WxW Delivery base.
   - Click **Test connection** — the app fills a dropdown with the TimeFlip devices in the base.
   - **Pick the device assigned to you.**
   - Choose **Hours Testing** (recommended at first) or **Hours** (real payroll hours).
   - Click **Save & start tracking.**
3. **Track** — flip your TimeFlip to a face and the app logs time to Airtable. Closing the
   window keeps it running in the system tray (click the tray icon to reopen; ⚙ Settings to
   reconfigure). Time tracked while the app is closed is backfilled from the die next time it
   runs.

The only thing a user ever enters is the token and which device is theirs — every table and
field id is baked into the app.

**Prerequisites for the machine running it:** Windows 10 1703+ (or macOS) with Bluetooth LE
(built-in is fine), and an Airtable token with read+write on base `appOa0ZMtkRoHMSW3`. On
macOS, grant Bluetooth permission when prompted.

### Connecting to your die

You don't enter any device ID. The app finds and connects on its own:

- On first run it connects to a nearby die (matched loosely by name) and then **remembers that
  exact device** — every launch after that reconnects to it automatically, no matter what it's
  named.
- If it can't find your die automatically, click **Choose device** on the main screen and pick
  it from the list of nearby Bluetooth devices (likely TimeFlips are flagged). That choice is
  remembered too.
- The app confirms a device really is a TimeFlip (by its Bluetooth service) before using it, so
  it never latches onto the wrong gadget.

If it's stuck on "Searching…": **flip the die to wake it**, and make sure it isn't already
connected to the **TimeFlip phone app** or a Bluetooth scanner — a die only allows one
connection at a time. To switch to a different die, use **Choose device → Forget paired device**.

## For developers

```bash
npm install      # no native compilation — just Electron + electron-builder
npm start        # run from source
TIMEFLIP_DEBUG=1 npm start   # verbose BLE + Airtable logging
```

User choices are stored in `settings.json` under the app's `userData` dir (not in the repo);
logs and local sync state (`state.json`) live there too. There is no `config.json` — the
baked-in schema lives in `src/main/defaults.js`.

### Publishing a new version (the easy, one-location way)

Both installers are built **in the cloud by GitHub Actions** — you don't need a Mac or a
Windows build machine, and everything lives in this one repo.

1. Bump `version` in `package.json` (e.g. `0.1.0` → `0.1.1`) and push to `main`.
2. On GitHub: **Releases → Draft a new release → Choose a tag** and type `v0.1.1` (create it),
   give it a title, click **Publish release**.
3. The **Build & Release** workflow (`.github/workflows/release.yml`) fires automatically,
   builds the macOS `.dmg` and Windows `.exe` on cloud runners, and attaches them to that
   release. In a few minutes they appear as downloads on the release.

There's also a **Run workflow** button on the **Actions** tab that builds both installers
on demand (uploaded as downloadable "artifacts") without publishing a release — handy for a
test build. CI needs no secrets: it uses the automatic `GITHUB_TOKEN`, and the app isn't
code-signed. (The `winCodeSign` symlink problem below does **not** occur on the CI Windows
runner, which has the required privilege.)

### Code signing (optional — pre-wired, off until secrets exist)

Out of the box the installers are **unsigned**: Windows shows a SmartScreen prompt
and macOS needs a one-time right-click → Open. The build is already wired to sign
and notarize the moment you add the secrets below — no code changes needed. With
no secrets set, nothing changes.

**macOS** — needs an [Apple Developer Program](https://developer.apple.com/programs/)
membership ($99/yr) and a *Developer ID Application* certificate. Add these repo
secrets (Settings → Secrets and variables → Actions):

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | The Developer ID `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | 10-character Team ID |

With `CSC_LINK` + `APPLE_ID` present the workflow signs **and** notarizes; with only
`CSC_LINK` it signs without notarizing; with neither it ad-hoc signs as today.

**Windows** — the workflow uses [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
(~$10/month, no hardware token, works in CI). Add:

`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_ENDPOINT`,
`AZURE_CODE_SIGNING_NAME`, `AZURE_CERT_PROFILE_NAME`.

> ⚠️ Azure Trusted Signing's public-trust identity validation has required the
> organization to have **3+ years of verifiable history** — confirm eligibility
> before subscribing. An EV certificate (with a cloud HSM such as DigiCert
> KeyLocker or SSL.com eSigner, so it works in CI) is the fallback. A plain OV
> certificate will *not* clear SmartScreen immediately.

> **Note:** `tools/afterPack.js` ad-hoc signs the macOS app so it launches on Apple
> Silicon when unsigned. It deliberately stands down when `CSC_LINK`/`CSC_NAME` is
> set — otherwise it would overwrite the real Developer ID signature and break
> notarization.

### Building an installer locally (optional)

```bash
npm run dist:win     # → dist/WxW Time Tracker Setup <version>.exe  (also runs npm run icon)
npm run dist:mac     # macOS dmg (build on a Mac)
```

**Windows gotcha (one-time):** electron-builder downloads `winCodeSign`, whose archive contains
macOS symlinks. Extracting symlinks on Windows needs a privilege normal accounts lack, so the
NSIS build fails with *"A required privilege is not held by the client."* Two fixes:

- **Recommended:** turn on **Settings → Privacy & security → For developers → Developer Mode**
  (grants the symlink privilege), or run the build from an **elevated** terminal. Then
  `npm run dist:win` just works.
- **No-admin workaround (what this repo was built with):** pre-extract the archive into the
  stable cache name so electron-builder skips its own extraction:
  ```bash
  CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
  node_modules/7zip-bin/win/x64/7za.exe x -aoa -y "$CACHE"/*.7z "-o$CACHE/winCodeSign-2.6.0"
  # the 2 darwin symlink errors are expected and harmless on Windows
  ```
  (Run `npm run dist:win` once first to trigger the download, then the command above, then
  `npm run dist:win` again.)

## How tracking avoids double-counting

- **Live** owns the period from connect onward. A flip finalizes the open record (`End`) and,
  after `tracking.minSessionSeconds`, opens the next (`Start`). Sub-threshold nudges create
  nothing. Each close advances a persisted history high-water mark.
- **Reconcile** (on connect + every `reconcileIntervalMinutes`) pages onboard history and
  backfills only sessions that completed **before** live tracking began — i.e. while the app
  was closed or out of range. It never re-imports a session the live path already handled.
- Local state (`state.json` in `userData`) persists the high-water mark and the open session,
  so a restart finalizes a session that was open when the app closed.

## TimeFlip2 BLE protocol reference

Verified against the DI-GROUP "BLE protocol ver4" doc and the `pytimefliplib` v4 client.

- **Service:** `f1196f50-71a4-11e6-bdf4-0800200c9a66`
- **Password (`6F57`, write):** 6 ASCII bytes, factory default `000000`. Required after every
  connect — until written, the facet characteristic reports `0`.
- **Facet (`6F52`, read/notify):** 1 byte, current face `1–12` (`0` = undefined/unauthed).
- **Command (`6F54` in / `6F53` out):** status `0x10`, read/set time `0x07`/`0x08`, etc.
- **History (`6F58`):** write `0x02` + uint32-BE event number, read back a 20-byte record:
  event# (u32 BE), facet (1 byte; `>127` = paused), start (u64 BE Unix seconds), duration
  (5 bytes). Stop when the first 17 bytes are all zero.

> **Calibration note:** the duration field's endianness is the one point where the two
> primary sources disagree. The default (`tracking.historyDurationLittleEndian: true`) matches
> the working reference client. If backfilled durations look wrong, flip it to `false` and
> compare against a couple of known sessions.

## Project layout

```
src/
  main/
    defaults.js          baked-in base/table/field ids (the WxW Delivery schema)
    settings.js          load/save user choices → userData/settings.json
    config.js            assembles runtime config from defaults + settings
    ble/protocol.js      UUIDs, opcodes, binary decoders (transport-agnostic)
    ble/bridge.js        BLE transport: drives the hidden Web Bluetooth window over IPC,
                         exposes a device-like API (ready/facet events, history paging)
    airtable/client.js   REST client (fetch, returnFieldsByFieldId, rate-limit retry)
    airtable/mapper.js   loads TimeFlip + Faces from Airtable; builds Hours payloads
    sync/engine.js       facet/history → Hours state machine (live + reconcile)
    store.js             durable local state (high-water mark, open session)
    util/logger.js       leveled logging to stdout + file
    main.js              Electron main: windows, tray, setup IPC, device auto-select
  assets/icon.png        app/tray icon (generated)
  preload.js             contextBridge API (status + setup)
  renderer/
    index.html/.js/.css  setup screen + status UI (visible window)
    ble.html / ble.js    Web Bluetooth GATT proxy (hidden background window)
tools/make-icon.js       generates the app icon (run via `npm run icon`)
```

## Known limitations (v1)

- Single device per install (by design).
- BLE runs in a hidden Electron window via Web Bluetooth. The app must stay running (it lives
  in the tray) to track live; anything tracked while it's closed is backfilled from the die's
  onboard history on next launch.
- Device pause state is honored via the pause-faces setting and history's paused flag, but the
  app does not yet poll the die's live double-tap pause state.
- Reconcile assumes the die's clock is roughly correct (`Set time` opcode `0x08` is available
  in the protocol layer if you want to sync it on connect).
- The installer is unsigned (SmartScreen warning on first run). Add a code-signing certificate
  to `electron-builder` config to remove it.
