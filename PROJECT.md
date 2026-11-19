# Project: Cr-PDF

Custom GoodNotes-style PDF annotation & dual-screen presentation desktop app built on **CEF 150 (Chrome Runtime / Views)** using Chromium's native **PDFium** viewer and **Ink2** annotation module via an automated `resources.pak` patching pipeline, with primary **Windows x64** release via GitHub Actions and local **Linux x64** build/E2E verification.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Cr-PDF C++ Host (CEF 150 Views)                      │
│  • CefWindow + CefBrowserView (CEF_RUNTIME_STYLE_CHROME, chromeless)    │
│  • --enable-features=PdfInk2 (native PDFium + Ink2 enabled)             │
│  • CefPermissionHandler: auto-grant WINDOW_MANAGEMENT & FS_ACCESS       │
│  • CefBrowserViewDelegate: chromeless CefWindow for presenter popup     │
│  • CefDialogHandler / CefDownloadHandler: fallback dialog-free save     │
│  • Embedded Loopback HTTP Server (http://127.0.0.1:<port>/)             │
│    - Serves GoodNotes Library UI (/), PDFs (/pdf/<name>.pdf),           │
│      atomic auto-save (/api/save), notebook templates (/api/notebooks)  │
└──────────────┬───────────────────────────────────────┬──────────────────┘
               │ (same SecureContext origin)           │
               ▼                                       ▼
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│   Main Window (Presenter/Note)  │     │ Sub-Window "[화면공유용] 판서 화면"│
│  GoodNotes Library -> Native    │     │  window.open() + getScreenDetails│
│  Chrome PDF Viewer (Ink2 ON)    │     │  Native Chrome PDF Viewer       │
│  Patched resources.pak:         │     │  • CSS hides ALL toolbars       │
│  • main.js (crpdf_main.js):     │◄───►│  • Ink2 disabled (no ink)       │
│    - Minimal toolbar (5 tools)  │ BC  │  • Canvas live ink mirror layer │
│    - Auto-save (Ctrl+S/timer)   │     │  • Transparent mouse overlay    │
│    - BroadcastChannel sync      │     │    -> red laser pointer (x%,y%) │
│  • pdf_internal_plugin_wrapper: │     │  • Auto-fullscreen on external  │
│    - Palm rejection (pen/touch) │     │    monitor if detected          │
│    - Pseudo-pressure (1/3/5)    │     └─────────────────────────────────┘
│    - Live stroke coords relay   │
└─────────────────────────────────┘
```

### Verified Chromium 150 / Ink2 Constraints & Workarounds (Transparent Reporting)
1. **No Ink2 Stroke-Import/Export API in C++ (`pdf/pdf_ink_module.cc`)**: `PdfInkModule::OnMessage` exposes only 8–9 message types and has no stroke-geometry readout or import API; only `save(SaveRequestType.ANNOTATION)` exports baked PDF bytes.
   - **Workaround**: Dual-Layer Hybrid Mirror — capture pen coordinates/brush/undo from `pdf_internal_plugin_wrapper.js` and stream over `BroadcastChannel` to a synchronized `<canvas id="crpdf-ink-mirror">` in the sub-window for <16ms live mirroring, plus authoritative `save(ANNOTATION)` PDF sync to `http://127.0.0.1:<port>/api/save` on stroke-finish/save. Main window uses 100% genuine Ink2.
2. **Ink2 Mid-Stroke Brush Size Lock (`pdf/pdf_ink_module.cc:1599-1605`)**: `setAnnotationBrush` during an active stroke queues into `pending_drawing_brush_state_` and takes effect on the next stroke (sizes must be in `[1, 16]` or renderer crashes via `CHECK`; `1, 3, 5` are valid).
   - **Workaround**: Frontend event-level pseudo-pressure switches Ink2 presets (`1` / `3` / `5`) with hysteresis (`±0.05`) at stroke start/boundaries without touching C++ mesh rendering (native Ink2 pen tip also modulates `[0.8, 1.0]` pressure by `1.0x–1.5x`). Never call `setBrushSize` while Eraser is selected.
3. **Pre-Stylus Single-Finger Touch & OOPIF `<embed>` (`pdf_internal_plugin_wrapper.js`)**: `PdfInkModule` ignores 1-finger touch only *after* seeing its first stylus event (`using_stylus_instead_of_touch_`), and pointer events over the PDF page fire inside the inner OOPIF frame.
   - **Workaround**: Patch `pdf_internal_plugin_wrapper.js` (inner frame) to intercept pre-stylus 1-finger `touch` events (with JS scroll fallback) while letting 2-finger pinch-zoom pass through untouched and letting `'pen'` draw natively in Ink2.
4. **Ink2 Save Uses `showSaveFilePicker` (`pdf_viewer.ts`)**: `window.showSaveFilePicker()` requires user gesture and triggers `CefDialogHandler::OnFileDialog` rather than `CefDownloadHandler`.
   - **Workaround**: Intercept `save_()` in patched `main.js` after `currentController.save(SaveRequestType.ANNOTATION)` returns `dataToSave`, and `POST` bytes directly to `http://127.0.0.1:<port>/api/save` for atomic overwrite (works for both Ctrl+S/Save button and gesture-free periodic auto-save), backed by C++ `CefDialogHandler`/`CefDownloadHandler` fallbacks.

---

## Feature Inventory

Every Survey feature and user requirement is assigned to a milestone (0 unassigned):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F01 | CEF 150 Binary Fetch & Cross-Platform CMake | Automated download/extract script for CEF `150.0.24+g62e98ba+chromium-150.0.7871.289` (`minimal`, `linux64` & `windows64`) + CMake build (`CrPDF.exe` / `cr-pdf`) | M1 | ORIGINAL_REQUEST, Survey 1 |
| F02 | CEF Chrome Runtime (Views) & Ink2 Flags | Chromeless `CefWindow` + `CefBrowserView` (`CEF_RUNTIME_STYLE_CHROME`), `--enable-features=PdfInk2`, CLI options (`--save-dir`, `--port`, `--autosave-interval`, `--open`, `--remote-debugging-port`) | M1 | ORIGINAL_REQUEST, Survey 1 |
| F03 | CEF Permissions, Popups & Fallback Save Handlers | `CefPermissionHandler` auto-granting `WINDOW_MANAGEMENT`/`FILE_SYSTEM_ACCESS`, `OnPopupBrowserViewCreated` chromeless popup + external monitor helper, `CefDialogHandler`/`CefDownloadHandler` fallbacks + disable download bubble prefs | M1 | Survey 1, Survey 3 |
| F04 | Embedded Loopback HTTP Server & PDF Template Generator | `http://127.0.0.1:<port>/` serving Library UI, `/pdf/<name>.pdf`, `/api/config`, `/api/pick-folder`, `/api/notebooks`, `/api/notebooks/create` (Blank/Lined/Grid/Dot real PDF 1.4 with A4/Letter/16:9 presets OR custom `widthMm`×`heightMm`), `/api/notebooks/import`, `POST /api/notebooks/<name>/add-page` (appends matching page to existing PDF preserving Ink2 annotations), atomic `/api/save` | M1 | Survey 1, Survey 3, Follow-up 1 & 2 |
| F05 | Automated `resources.pak` DataPack v5 Patcher | Pure Python `scripts/patch_pak.py` supporting DataPack v5 (raw/gzip/Chromium-Brotli), content-fingerprint lookup for `main.js` & `pdf_internal_plugin_wrapper.js`, idempotent repack + round-trip verification | M2 | ORIGINAL_REQUEST, Survey 2 |
| F06 | GoodNotes-Style Notebook Library Web UI | Folder/notebook shelf, search/sort, New Notebook modal (Blank/Lined/Grid/Dot, A4/Letter/16:9 presets + custom `widthMm`×`heightMm` mm inputs, page count -> immediately opens Ink2 editor), Import PDF, Save Folder switcher, Auto-Save & input settings, clean `HostBridge` adapter (`addPage` included) + `docs/ARCHITECTURE.md` | M2 | Follow-up 1 & 2, Survey 1, Survey 3 |
| F07 | Feature 1: Ultra-Minimal 1-Row Ink2 Toolbar + Multi-Pen Preset Slots + Add Page (+) + Right-Dock Toggle | Auto-enter Ink2 draw mode; hide bulky `#side-panel`/`#bottom` & extraneous chrome; default = 1-row top ultra-slim bar (~40–44px height) with **Multi-Pen/Highlighter Preset Slots** (defaults: Black/Blue/Red Pen + Yellow Highlighter; `+` add / edit / delete; each slot stores `type: pen|highlighter`, `maxLevel: 1..5`, `color` from Ink2 palette OR custom `<input type="color">`/HEX -> `{r,g,b}`; persisted in `localStorage`) + **Ad-Hoc Color Popover**, Eraser, Undo, Add Page (+), Save, Screen Share, Library, and **Dock Toggle** (Top 1-row ↔ Right 1-column slim vertical bar ~44–48px width, persisted in `localStorage`) | M3 | ORIGINAL_REQUEST, Follow-up 2, 5 & 7, Survey 2, Survey 3 |
| F08 | Feature 2: Palm Rejection (`pointerType`) | `'pen'` allows Ink2 drawing; `'touch'` completely blocks Ink2 (even before first pen input) and allows 1-finger scroll + 2-finger pinch-zoom only | M3 | ORIGINAL_REQUEST, Survey 2, Survey 3 |
| F09 | Feature 3: Pseudo-Pressure (`min(maxLevel, rawStep)`) | User selects `maxLevel` (`1..5`) on toolbar; fixed 20% `rawStep` from `e.pressure` (`<0.20 -> 1`, `0.20..0.40 -> 2`, `0.40..0.60 -> 3`, `0.60..0.80 -> 4`, `>=0.80 -> 5`) capped by `effectiveLevel = Math.min(maxLevel, rawStep)` (e.g. `maxLevel=4`: `>=0.60 -> 4`), with boundary hysteresis, clamped `[1,16]`, Eraser guarded | M3 | ORIGINAL_REQUEST, Follow-up 6, Survey 2, Survey 3 |
| F10 | Feature 6: Auto-Save Folder & Periodic Auto-Save | Ctrl+S / Save button silently overwrites `<save_dir>/<name>.pdf` via `POST /api/save` with zero dialog; configurable periodic auto-save gated on `FINISH_INK_STROKE` + idle | M3 | ORIGINAL_REQUEST (A2), Survey 1, Survey 3 |
| F11 | Feature 4: Screen-Sharing Sub-Window & Mirroring | `window.open()` with title `"[화면공유용] 판서 화면"`, CSS hides all toolbars (pure PDF), `BroadcastChannel` real-time sync of page/zoom/scroll + Hybrid Live Ink Mirror, `window.getScreenDetails()` auto-fullscreen on external monitor | M4 | ORIGINAL_REQUEST, Follow-up 2, Survey 3 |
| F12 | Feature 5: Dual-Window Input Separation & Laser Pointer | Main window: stylus draws real Ink2 + displays incoming laser dot; Sub-window: no ink, transparent mouse overlay renders glowing red laser pointer, bidirectional page-normalized `(x%, y%)` sync via `BroadcastChannel` | M4 | ORIGINAL_REQUEST, Survey 3 |
| F13 | E2E Test Suite (Tiers 1–4) & Tier 5 Adversarial Hardening | Opaque-box Node.js v24 native-WebSocket CDP E2E suite under `xvfb-run` covering all features (including custom mm creation & Add Page (+)), boundaries, pairwise interactions, and real-world workflows + Tier 5 white-box hardening | E2E Track + M5 | Project Pattern, Survey 3, Follow-up 2 |
| F14 | GitHub Actions Windows Build, Packaging & Release | `.github/workflows/build-windows.yml` on `windows-latest`: download/cache CEF `windows64_minimal`, MSVC build `CrPDF.exe`, run `patch_pak.py`, package `Cr-PDF-windows-x64.zip`, upload artifact & GitHub Release on `hiJiwho/Cr-PDF` | M6 | Follow-up 1, Survey 1, Survey 3 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Requirement-driven opaque-box E2E test infra (`TEST_INFRA.md`) + Tiers 1–4 test suite (`tests/e2e/`) + `TEST_READY.md` | none (runs in parallel) | IN_PROGRESS (`7662b7f9bfa6efc2d5e8068f1553552a`) |
| M1 | CEF 150 Host, HTTP Server & PDF Templates | F01, F02, F03, F04: CEF fetch script, CMake, C++ Views app, handlers, embedded HTTP server, PDF template generator (presets + custom mm) & `add-page` PDF append, local Linux build & Ink2 smoke check | none | IN_PROGRESS (`1c89d8c7f48131818be47cac5d4f9fed`) |
| M2 | `resources.pak` Patcher & GoodNotes Web UI | F05, F06: Python DataPack v5 unpack/patch/repack CLI + unit tests, GoodNotes Library Web UI (`web/`, incl. custom mm inputs), `docs/ARCHITECTURE.md` | none (parallel with M1) | IN_PROGRESS (`eb278543deea4b205f723bf7de206d95`) |
| M3 | Ink2 Core Patches (Toolbar + Add Page, Palm, Pressure, Auto-Save) | F07, F08, F09, F10: `patches/pdf/crpdf_main.js`, `patches/pdf/crpdf_plugin_wrapper.js`, `patches/pdf/crpdf_style.css` integrated with `patch_pak.py` and verified live on CEF 150 | M1, M2 | PLANNED |
| M4 | Dual-Screen Presenter Sub-Window & Laser Pointer | F11, F12: Presenter sub-window, CSS pure-PDF mode, `BroadcastChannel` viewport + Hybrid Ink Mirror, `getScreenDetails()` auto-fullscreen, bidirectional red laser pointer | M3 | PLANNED |
| M5 | Final Milestone: E2E Pass (Tiers 1–4) & Tier 5 Hardening | F13: Phase 1 pass 100% of E2E Tiers 1–4; Phase 2 white-box Tier 5 adversarial hardening | M4, E2E (`TEST_READY.md`) | PLANNED |
| M6 | GitHub Actions Windows Build & Release | F14: `.github/workflows/build-windows.yml`, git commit/push to `hiJiwho/Cr-PDF`, trigger & verify green Windows build, artifact, and GitHub Release | M5 | PLANNED |

---

## Interface Contracts

### 1. CLI Flags (`CrPDF.exe` / `cr-pdf`)
- `--save-dir=<path>` — Override auto-save notebook folder (default: persisted `config.json`, or `<user_docs>/Cr-PDF-Notes`).
- `--port=<int>` — Loopback HTTP server port (`0` = ephemeral; explicit port e.g. `18080` supported for tests).
- `--autosave-interval=<sec>` — Periodic auto-save interval in seconds (`0` = disabled; default `30`).
- `--open=<file.pdf>` — Open a specific PDF immediately on startup (copies/registers into save folder if outside).
- `--remote-debugging-port=<port>` — Forwarded to CEF for CDP E2E inspection.
- `--no-sandbox`, `--disable-gpu` — Forwarded to CEF for headless Linux `xvfb-run` testing.
- Always enables `--enable-features=PdfInk2` in `OnBeforeCommandLineProcessing`.

### 2. Embedded Loopback HTTP API (`http://127.0.0.1:<port>`)
- `GET /` → GoodNotes Library Web UI (`web/index.html`)
- `GET /static/<file>` → Static assets (`web/app.js`, `web/styles.css`, `web/host_bridge.js`)
- `GET /api/health` → `200 {"status":"ok","port":<port>,"saveDir":"<path>","version":"1.0.0"}`
- `GET /api/config` → `200 {"saveDir":"<path>","autosaveIntervalSec":30,"autosaveEnabled":true,"palmRejection":true,"pseudoPressure":true}`
- `POST /api/config` (JSON body) → Updates persisted `config.json`, returns updated config JSON.
- `POST /api/pick-folder` → Opens native folder dialog (Windows `IFileOpenDialog` / Linux GTK or CEF dialog), updates `saveDir`, returns `{"saveDir":"<path>","cancelled":false}`.
- `GET /api/notebooks` → `200 {"notebooks":[{"name":"note.pdf","size":1234,"mtime":1700000000,"url":"/pdf/note.pdf"}]}`
- `POST /api/notebooks/create` (JSON `{"title":"My Note","template":"blank|lined|grid|dot","pageSize":"a4|letter|16x9|custom","widthMm":210,"heightMm":297,"pages":1}`) → Generates valid PDF 1.4 in `saveDir` (clamping custom `widthMm`/`heightMm` to `[50, 1000]` mm; `1 mm = 72 / 25.4 pt`; persists template/size metadata in sidecar or PDF Info dict), returns `201 {"name":"My Note.pdf","url":"/pdf/My%20Note.pdf","widthMm":210,"heightMm":297,"pages":1}`.
- `POST /api/notebooks/<name>/add-page` (optional JSON `{"template":"blank|lined|grid|dot","widthMm":...,"heightMm":...}` — defaults to matching the notebook's last page MediaBox/template) → Appends a new real PDF page to `<saveDir>/<name>` via clean incremental PDF update (preserving all existing pages AND Ink2 annotations intact!), atomically writes `.tmp` -> rename, returns `200 {"name":"<name>","pages":<newPageCount>,"size":<bytes>,"mtime":<epoch>}`.
- `POST /api/notebooks/import` (raw PDF bytes with `?name=<filename>` or multipart/native picker) → Writes PDF into `saveDir`, returns `201 {"name":"<filename>","url":"/pdf/<encoded>"}`.
- `DELETE /api/notebooks/<name>` → Removes notebook from `saveDir`, returns `200 {"deleted":true}`.
- `GET /pdf/<name>` → Serves `<saveDir>/<name>` with `Content-Type: application/pdf`, `Cache-Control: no-store`. Rejects path traversal (`..`, `/`, `\`).
- `POST /api/save?name=<name>` (raw `application/pdf` body) → Validates `%PDF-` header & safe filename, writes `<saveDir>/<name>.tmp`, flushes, atomically renames to `<saveDir>/<name>`, returns `200 {"saved":true,"name":"<name>","size":<bytes>,"mtime":<epoch>}`.

### 3. `resources.pak` Patcher CLI (`scripts/patch_pak.py`)
```bash
python3 scripts/patch_pak.py \
  --input <path/to/resources.pak> \
  --output <path/to/patched_resources.pak> \
  --patches <path/to/patches/pdf> \
  [--verify]
```
- Reads DataPack v5 (handling raw, gzip `0x1f 0x8b`, and Chromium-Brotli `0x1e 0x9b` + 6-byte LE size).
- Locates `main.js` and `pdf_internal_plugin_wrapper.js` by content fingerprint (never hardcoded numeric IDs).
- Idempotent: strips any prior `/* CRPDF_PATCH_START */ ... /* CRPDF_PATCH_END */` block before re-injecting.
- Preserves sorted resource table, sentinel entry, and alias table. Exit code `0` on success, non-zero on error.

### 4. `BroadcastChannel` Protocol (`crpdf-sync:<docName>`)
All messages are JSON objects `{ type, senderId, ts, ... }`:
- `viewport`: `{ type: 'viewport', page: number, zoom: number, scrollX: number, scrollY: number, scrollRatioX: number, scrollRatioY: number }`
- `ink_stroke`: `{ type: 'ink_stroke', op: 'start'|'move'|'end', strokeId: string, page: number, x: number, y: number, brush: { type: 'pen'|'highlighter'|'eraser', color: string, size: number } }` (page-normalized `0.0–1.0` coords)
- `ink_action`: `{ type: 'ink_action', op: 'undo'|'redo'|'clear_overlay'|'saved_checkpoint', version: number }`
- `laser`: `{ type: 'laser', role: 'presenter'|'main', visible: boolean, xPct: number, yPct: number, page: number }` (relative `0–100`% normalized to visible PDF page rect)
- `presenter_ready`: `{ type: 'presenter_ready' }` (triggers main window to send current viewport + mirror stroke history)

### 5. `HostBridge` Adapter (`web/host_bridge.js`)
Decouples GoodNotes Web UI from C++ host HTTP endpoints (`getConfig`, `updateConfig`, `pickFolder`, `listNotebooks`, `createNotebook`, `importNotebook`, `deleteNotebook`, `getPdfUrl`).

---

## Code Layout

```
/home/antigravity/hiJiwho/Cr-PDF/
├── CMakeLists.txt                       # [M1] Cross-platform CEF 150 CMake (Win64 + Linux64)
├── .gitignore                           # [M1] Exclude build/, third_party/cef/, .agents/
├── scripts/
│   ├── fetch_cef.py                     # [M1] Download/verify/extract CEF 150 minimal (linux64/windows64)
│   └── patch_pak.py                     # [M2] DataPack v5 unpack/patch/repack CLI
├── src/                                 # [M1] C++ CEF Chrome Runtime host
│   ├── main_win.cc / main_linux.cc
│   ├── crpdf_app.h / crpdf_app.cc       # CefApp + Views window + command-line flags
│   ├── crpdf_client.h / crpdf_client.cc # CefClient, Permission/Dialog/Download/LifeSpan handlers
│   ├── http_server.h / http_server.cc   # Embedded 127.0.0.1 HTTP API & static file server
│   ├── pdf_generator.h / pdf_generator.cc # Real PDF 1.4 Blank/Lined/Grid/Dot generator
│   └── config_store.h / config_store.cc # Persisted config.json + atomic file save
├── web/                                 # [M2] GoodNotes-style Note Library Web UI
│   ├── index.html
│   ├── styles.css
│   ├── host_bridge.js
│   └── app.js
├── patches/pdf/                         # [M3 & M4] Injected into resources.pak
│   ├── crpdf_style.css                  # [M3/M4] Minimal toolbar + presenter pure-PDF + laser CSS
│   ├── crpdf_main.js                    # [M3/M4] Toolbar, auto-save, BroadcastChannel, presenter/laser
│   └── crpdf_plugin_wrapper.js          # [M3/M4] Palm rejection, pseudo-pressure, stroke capture
├── docs/
│   └── ARCHITECTURE.md                  # [M2] Architecture, Ink2 constraints/workarounds, WASM/mobile note
├── tests/
│   ├── unit/                            # [M1/M2] Unit tests (C++ PDF gen/HTTP, Python pak patcher)
│   └── e2e/                             # [E2E Track] Opaque-box Node 24 CDP E2E suite (Tiers 1-4)
├── .github/workflows/
│   └── build-windows.yml                # [M6] Windows x64 CI build, pak patch, artifact & Release
├── PROJECT.md                           # [Orchestrator] Living single source of truth
├── TEST_INFRA.md                        # [E2E Track] Test architecture & coverage targets
└── TEST_READY.md                        # [E2E Track] Completion signal + runner command
```
