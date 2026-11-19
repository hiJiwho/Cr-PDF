# Cr-PDF Architecture

Cr-PDF is a GoodNotes-style PDF annotation and dual-screen presentation desktop application built on **CEF 150 (`150.0.24+g62e98ba+chromium-150.0.7871.289`)** in **Chrome Runtime (Views)** mode. It uses Chromium's genuine built-in **PDFium** viewer and **Ink2** annotation module via an automated DataPack v5 (`resources.pak`) patching pipeline—without rebuilding Chromium from source and without replacing Ink2 with PDF.js or a custom canvas ink engine.

---

## 1. System Overview & Design Principles

### Core Invariants
1. **100% Native PDFium + Ink2 on Desktop**: All PDF rendering and presenter pen/highlighter/eraser strokes in the main window execute in Chromium's native PDFium + Ink2 C++ engine (`--enable-features=PdfInk2`).
2. **Zero Full-Chromium Build**: Uses official prebuilt CEF 150 `minimal` binaries (`windows64` primary release via GitHub Actions; `linux64` local build & headless E2E verification) combined with a deterministic, version-resilient `scripts/patch_pak.py` patcher.
3. **Same-Origin Loopback Architecture (`http://127.0.0.1:<port>/`)**: Serving the GoodNotes Library UI and all PDFs from a local loopback HTTP server provides a `[SecureContext]` with a concrete non-opaque origin, enabling both `window.getScreenDetails()` and cross-window `BroadcastChannel` synchronization.
4. **Transparent Constraint Engineering**: Every Chromium 150 / Ink2 boundary is documented with exact source citations and non-destructive workarounds (Section 4).

### High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Cr-PDF C++ Host (CEF 150 Views)                          │
│  • CefWindow + CefBrowserView (CEF_RUNTIME_STYLE_CHROME, chromeless)         │
│  • --enable-features=PdfInk2 (native PDFium + Ink2 enabled)                  │
│  • CefPermissionHandler: auto-grant WINDOW_MANAGEMENT & FILE_SYSTEM_ACCESS   │
│  • CefBrowserViewDelegate: chromeless CefWindow for presenter popup          │
│  • CefDialogHandler / CefDownloadHandler: dialog-free save fallbacks         │
│  • ConfigStore: persisted config.json + atomic write (.tmp -> flush -> mv)   │
│  • Embedded Loopback HTTP Server (http://127.0.0.1:<port>/)                  │
│    - Library UI (/), static assets (/static/*), PDFs (/pdf/<name>.pdf)       │
│    - Config (/api/config), native folder picker (/api/pick-folder)           │
│    - Notebooks CRUD, PDF 1.4 template gen (presets + custom mm),             │
│      incremental page append (/api/notebooks/<name>/add-page), /api/save     │
└───────────────────┬──────────────────────────────────────┬───────────────────┘
                    │ Same SecureContext Origin            │ Same SecureContext Origin
                    │ http://127.0.0.1:<port>              │ http://127.0.0.1:<port>
                    ▼                                      ▼
┌────────────────────────────────────┐   ┌────────────────────────────────────┐
│  Main Window (Presenter / Note)    │   │ Sub-Window "[화면공유용] 판서 화면"  │
│  1. GoodNotes Library UI (/)       │   │  window.open() + getScreenDetails()│
│     via HostBridge -> HTTP API     │   │  Native Chrome PDF Viewer          │
│  2. Native Chrome PDF Viewer       │   │  • ?crpdf_role=presenter           │
│     (Ink2 AnnotationMode.DRAW ON)  │   │  • CSS hides ALL toolbars/panels   │
│  Patched resources.pak:            │◄─►│  • Ink2 OFF (zero ink on sub-win)  │
│  • main.js (crpdf_main.js):        │BC │  • <canvas id="crpdf-ink-mirror">  │
│    - 1-row top bar / right-dock    │   │    60fps live ink mirror layer     │
│    - Multi-pen presets + AddPage(+)│   │  • Transparent mouse overlay ->    │
│    - Silent save + periodic timer  │   │    red laser pointer (x%, y%)      │
│    - BroadcastChannel sync & laser │   │  • Auto-fullscreen on external     │
│  • pdf_internal_plugin_wrapper.js: │   │    monitor when detected           │
│    - Palm rejection (pen vs touch) │   └────────────────────────────────────┘
│    - Fixed 20% pressure cap (1..5) │
│    - Live pen stroke relay         │
└────────────────────────────────────┘
```

---

## 2. Component Responsibilities

| Component | Location | Key Responsibilities | Technical Notes |
|---|---|---|---|
| **CEF 150 Chrome Runtime Views Host** | `src/crpdf_app.*`, `src/crpdf_client.*`, `src/config_store.*`, `src/main_*.cc` | Bootstraps CEF 150 Chrome Runtime via Views (`CefWindow` + `CefBrowserView` with `CEF_RUNTIME_STYLE_CHROME`, chromeless). Injects `--enable-features=PdfInk2`. Auto-grants `CEF_PERMISSION_TYPE_WINDOW_MANAGEMENT` (`1 << 23`) and `CEF_PERMISSION_TYPE_FILE_SYSTEM_ACCESS` (`1 << 24`). Hosts presenter popups in chromeless `CefWindow`. Provides `CefDialogHandler` / `CefDownloadHandler` save fallbacks and disables Chrome download bubbles. Persists `config.json`. | In CEF 150 (`62e98ba`), Chrome bootstrap is mandatory (`CefSettings.chrome_runtime` was removed). Never pass `--disable-extensions` or `--use-alloy-style` because the built-in PDF viewer is an internal component extension. |
| **Embedded Loopback HTTP Server & PDF Generator** | `src/http_server.*`, `src/pdf_generator.*` | Binds strictly to `127.0.0.1:<port>`. Serves Library UI (`/`), `/static/*`, PDFs from `saveDir` (`/pdf/<name>` with `Cache-Control: no-store` and path-traversal protection rejecting `..`, `/`, `\`), config/folder-picker APIs, notebook CRUD, PDF 1.4 generation (`blank`/`lined`/`grid`/`dot`, presets `a4`/`letter`/`16x9` or custom `widthMm`×`heightMm` clamped to `[50, 1000]` mm at `72 / 25.4 pt/mm`), incremental page append (`POST /api/notebooks/<name>/add-page`), and atomic overwrite (`/api/save`). | Atomic save writes `<name>.tmp`, flushes (`FlushFileBuffers` / `fsync`), and replaces (`MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` / `rename()`). |
| **GoodNotes Library Web UI** | `web/index.html`, `web/styles.css`, `web/app.js`, `web/host_bridge.js` | Offline-only stationery shelf with search/sort, Save Folder switcher, Import PDF (picker + drag-and-drop), Settings drawer (auto-save interval, palm rejection, pseudo-pressure), and New Notebook modal (template previews + preset/custom mm inputs -> immediately opens into native Ink2 editor). | Communicates with host exclusively through `HostBridge`. Strict XSS-safe DOM construction (no untrusted `innerHTML`). |
| **Native PDFium + Ink2 Viewer (Patched)** | `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/` + `patches/pdf/*` | Outer frame (`main.js` / `crpdf_main.js` + `crpdf_style.css`): hides bulky Chromium `#side-panel` and `#bottom`; default **1-row top ultra-slim bar** (`~40–44px` height) with optional **Right-Dock Toggle** (1-column slim vertical bar `~44–48px` width, persisted in `localStorage`), **Multi-Pen / Highlighter Preset Slots** (defaults: Black/Blue/Red Pen + Yellow Highlighter; `+` add / edit / delete; each slot stores `type: pen\|highlighter`, `maxLevel: 1..5`, and `color` from Chromium Ink2 palette or custom `<input type="color">`/HEX → `{r, g, b}`, persisted in `localStorage`), **Ad-Hoc Color Popover**, Eraser, Undo, Add Page (`+`), Save, Screen Share, and Library; silent `POST /api/save` + periodic auto-save, `BroadcastChannel` sync & laser. Inner OOPIF `<embed>` frame (`pdf_internal_plugin_wrapper.js` / `crpdf_plugin_wrapper.js`): palm rejection, fixed-20% step pseudo-pressure capped at `maxLevel` (`effectiveLevel = Math.min(maxLevel, rawStep)`), and live pen coordinate capture over `MessageChannel`. | Chromium 150 PDF viewer is 100% `CrLitElement` Shadow DOM (Polymer removed). MV2 CSP blocks inline `<script>` in `index.html`, requiring `.js` patching in `resources.pak`. |
| **Dual-Screen Presenter Sub-Window** | Same native PDF viewer with `?crpdf_role=presenter&doc=<name>` | Opened via `window.open()` with `document.title = "[화면공유용] 판서 화면"`. CSS (`body.crpdf-presenter`) hides all toolbars/sidebars. Ink2 is forced OFF (`AnnotationMode.OFF`). Renders live mirrored strokes on `<canvas id="crpdf-ink-mirror">`, captures mouse movement for red laser pointer (`#ff2222`), and auto-fullscreens on external monitor via `window.getScreenDetails()`. | Shares `(http://127.0.0.1:<port>, chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai)` storage partition key with the main window. |

### CLI Flags (`CrPDF.exe` / `cr-pdf`)
- `--save-dir=<path>` — Override auto-save notebook folder (default: persisted `config.json`, or `<user_docs>/Cr-PDF-Notes`).
- `--port=<int>` — Loopback HTTP server port (`0` = ephemeral; explicit port e.g. `18080` supported for tests).
- `--autosave-interval=<sec>` — Periodic auto-save interval in seconds (`0` = disabled; default `30`).
- `--open=<file.pdf>` — Open a specific PDF immediately on startup.
- `--remote-debugging-port=<port>` — Forwarded to CEF for CDP E2E inspection.
- `--no-sandbox`, `--disable-gpu` — Forwarded to CEF for headless Linux `xvfb-run` testing.

### Embedded Loopback HTTP API (`http://127.0.0.1:<port>`)
- `GET /`, `GET /static/<file>` — Library HTML, CSS, `host_bridge.js`, `app.js`.
- `GET /api/health` — `{"status":"ok","port":<port>,"saveDir":"<path>","version":"1.0.0"}`.
- `GET /api/config`, `POST /api/config` — Read/update persisted `config.json`.
- `POST /api/pick-folder` — Native OS folder picker dialog, updates `saveDir`.
- `GET /api/notebooks` — Lists PDFs in `saveDir` (`name`, `size`, `mtime`, `url`).
- `POST /api/notebooks/create` — Creates a real PDF 1.4 notebook (`title`, `template`, `pageSize`, `widthMm`, `heightMm`, `pages`).
- `POST /api/notebooks/<name>/add-page` — Appends a matching page to `<saveDir>/<name>` via incremental PDF update preserving Ink2 annotations.
- `POST /api/notebooks/import?name=<filename>` — Imports raw PDF bytes into `saveDir`.
- `DELETE /api/notebooks/<name>` — Deletes a notebook from `saveDir`.
- `GET /pdf/<name>` — Serves `<saveDir>/<name>` (`Content-Type: application/pdf`, `Cache-Control: no-store`).
- `POST /api/save?name=<name>` — Validates `%PDF-` header & safe filename, atomically overwrites `<saveDir>/<name>`.

---

## 3. DataPack v5 (`resources.pak`) Patching Pipeline

`scripts/patch_pak.py` is a pure-Python 3 stdlib (+ optional `brotli` / `brotlicffi` / `brotli` CLI fallback) tool that unpacks, patches, repacks, and validates Chromium's `resources.pak`.

### Binary Format (`tools/grit/grit/format/data_pack.py`, `ui/base/resource/data_pack.cc`)
All fields are **little-endian (`<`)** and platform-agnostic (identical layout on Windows x64 and Linux x64):

1. **Header (12 bytes, `<IBxxxHH`)**:
   - `uint32 version = 5` (`kFileFormatV5`)
   - `uint8 encoding` (`0 = BINARY`, `1 = UTF8`, `2 = UTF16`)
   - `3 bytes` zero padding (`\x00\x00\x00`)
   - `uint16 resource_count` (`N` canonical entries)
   - `uint16 alias_count` (`M` alias entries)
2. **Resource Table (`(N + 1) * 6` bytes, `<HI`)**:
   - `N` entries of `(uint16 resource_id, uint32 data_offset)`, strictly ascending by `resource_id` (`bsearch` invariant) with non-decreasing offsets.
   - Entry `N` is the sentinel `(resource_id = 0, data_offset = file_size)`.
3. **Alias Table (`M * 4` bytes, `<HH`)**:
   - `M` entries of `(uint16 alias_id, uint16 entry_index)`, strictly ascending by `alias_id`, `0 <= entry_index < N`, with no collision against primary `resource_id`s.
4. **Data Payload**: Concatenated raw resource bytes starting at `12 + (N + 1) * 6 + M * 4`.

### Per-Entry Compression (`ui/base/resource/resource_bundle.cc:120-187`)
Chromium's `ResourceBundle::DecompressIfNeeded` dispatches dynamically on magic bytes:
- **Raw**: Default (uncompressed).
- **Gzip**: Magic `0x1f 0x8b` (recompressed deterministically with `mtime=0`).
- **Chromium-Brotli**: 8-byte header = magic `0x1e 0x9b` + 6-byte LE uncompressed size + raw Brotli stream.

Unmodified entries are copied verbatim byte-for-byte. Modified entries preserve their original compression by default (falling back safely to deterministic gzip if Brotli encoding is unavailable).

### Content-Fingerprint Discovery & Idempotency
- **No hardcoded numeric IDs**: Resource IDs shift across OS builds and CEF upgrades. `patch_pak.py` locates targets strictly by content fingerprint and fails fast on `0` matches (exit `2`, or exit `3` if unreadable Brotli entries exist) or `>1` ambiguous matches:
  - `main.js`: requires `pdf_viewer_wrapper.js`, `browser_api.js`, `chrome.contentSettings.javascript`; excludes `pdf_print_wrapper.js`, `createBrowserApiForPrintPreview`.
  - `pdf_internal_plugin_wrapper.js`: requires `syncScrollToRemote`, `ackScrollToRemote`, `syncScrollFromRemote`, `chrome-untrusted://print`, `parent.postMessage`; excludes `pdf-viewer-print`.
- **Why these two files**: MV2 CSP (`script-src 'self' ...`) blocks inline `<script>` in `index.html`, while `pdf_viewer_wrapper.js` is Rollup-minified with unstable mangled symbols.
- **Idempotent Markers & Safe CSS Embedding**: Any existing `/* CRPDF_PATCH_START */ ... /* CRPDF_PATCH_END */` block is validated for balance and stripped before re-injection. `crpdf_style.css` is serialized via `json.dumps(css_text, ensure_ascii=True)` into `globalThis.__CRPDF_STYLE_CSS__` before `crpdf_main.js`. Double-patching produces byte-identical `.pak` output.

### CLI Contract
```bash
python3 scripts/patch_pak.py \
  --input <path/to/resources.pak> \
  --output <path/to/patched_resources.pak> \
  --patches <path/to/patches/pdf> \
  [--verify] [--allow-partial] [--compression preserve|raw|gzip|brotli]
```
Inspection & extraction modes: `--inspect`, `--unpack <dir>`, and standalone `--verify`.

---

## 4. Verified Chromium 150 / Ink2 Constraints & Workarounds (원인과 우회안 보고)

All four constraints below were verified directly against Chromium `150.0.7871.289` source code. Rather than abandoning native Ink2, each constraint is resolved cleanly at the boundary:

| # | Constraint & Root Cause (Chromium 150 Source) | Impact | Workaround (Preserves 100% Native Ink2) |
|---|---|---|---|
| **1** | **No Ink2 Stroke-Import/Export API in C++**<br>`pdf/pdf_ink_module.cc:430-458`: `PdfInkModule::OnMessage()` handles only 8 message types (`annotationRedo`, `annotationUndo`, `editTextAnnotation`, `finishTextAnnotation`, `getAllTextAnnotations`, `getAnnotationBrush`, `setAnnotationBrush`, `setAnnotationMode`). Stroke end emits only `{type: 'finishInkStroke', modified: boolean}`. Only `PluginController.save(SaveRequestType.ANNOTATION)` (`controller.ts:667-726`, `pdf_view_web_plugin.cc:2031-2065`) exports baked PDF bytes. | Cannot inject raw Ink2 stroke objects into the sub-window's PDFium memory; reloading the PDF on every stroke would flicker and lose live stroke feedback. | **Dual-Layer Hybrid Mirror**:<br>• **Layer 1 (<16ms live mirror)**: `pdf_internal_plugin_wrapper.js` captures pen coordinates (normalized to PDF page space `0.0–1.0`), brush metadata, and undo/redo actions and streams them via `BroadcastChannel` to `<canvas id="crpdf-ink-mirror">` in the sub-window.<br>• **Layer 2 (authoritative checkpoint)**: On debounced `FINISH_INK_STROKE` / Save, the main window saves baked Ink2 bytes to `/api/save` so reloads or late-joining sub-windows render genuine PDFium Ink2 annotations natively. |
| **2** | **Ink2 Mid-Stroke Brush Size Lock, `[1, 16]` Fatal `CHECK`, & Eraser Guard**<br>• `pdf/pdf_ink_module.cc:1599-1605`: Calling `setAnnotationBrush` during an active stroke queues into `pending_drawing_brush_state_` for the **next** stroke.<br>• `pdf/pdf_ink_brush.cc:161`: `PdfInkBrush::IsToolSizeInRange(float size)` enforces `1 <= size <= 16` via a fatal renderer `CHECK`.<br>• `ink2_manager.ts`: `setBrushSize()` asserts the active brush is not Eraser.<br>• `pdf/pdf_ink_brush.cc:60-78`: Native `kPen` tip behavior modulates `[0.8, 1.0]` pressure by `1.0x–1.5x`. | Brush size cannot mutate mid-stroke in C++ without recompiling Chromium; out-of-range sizes crash the renderer; calling `setBrushSize` on Eraser throws. | **Fixed-20% Step Capped Event-Level Pseudo-Pressure (`Math.min(maxLevel, rawStep)`)**:<br>• User selects maximum brush level **`maxLevel` (`1..5`)** on the toolbar (per pen/highlighter preset slot).<br>• Stylus `e.pressure` (`0.0–1.0`) maps to fixed 20% `rawStep` intervals: `< 0.20 → 1`, `0.20 <= p < 0.40 → 2`, `0.40 <= p < 0.60 → 3`, `0.60 <= p < 0.80 → 4`, `>= 0.80 → 5`, with small boundary hysteresis to prevent jitter.<br>• Final applied thickness level is upper-capped by `effectiveLevel = Math.min(maxLevel, rawStep)` (e.g., `maxLevel = 4` maps `60%–100%` to level `4`; `maxLevel = 3` at `50%` maps to `rawStep = 3` → level `3`).<br>• Always clamp output size to `[1, 16]` and guard `if (brush.type === 'eraser') return;` so Eraser never triggers `setBrushSize`. |
| **3** | **Pre-Stylus Single-Finger Touch & Inner OOPIF `<embed>`**<br>• `pdf/pdf_ink_module.cc:680-691, 1419-1429`: `PdfInkModule` ignores 2+ finger touch natively, and ignores 1-finger touch *only after* the first stylus event sets `using_stylus_instead_of_touch_ = true`.<br>• `pdf_internal_plugin_wrapper.ts:1-265`, `html_plugin_element.cc:555-579`: Pointer/touch events over the PDF page fire inside the inner OOPIF frame before `HTMLPlugInElement::DefaultEventHandler`. | Touching the screen before first stylus contact draws unintended ink; outer-frame listeners miss OOPIF `<embed>` events. | **Inner-Frame Interception in `pdf_internal_plugin_wrapper.js`**:<br>• Capture-phase listeners inside the inner OOPIF frame block 1-finger `pointerType === 'touch'` (`preventDefault()`) with JS scroll fallback.<br>• Multi-touch (`touches.length >= 2`) passes through untouched for native pinch-zoom.<br>• `pointerType === 'pen'` passes straight through to native Ink2. |
| **4** | **Ink2 Save Uses `window.showSaveFilePicker()`**<br>`chrome/browser/resources/pdf/pdf_viewer.ts:1314, 1587, 1647-1715`: `save_(SaveRequestType.ANNOTATION)` collects `dataToSave` (or chunks via `saveInBlocks_()`), then invokes `window.showSaveFilePicker()`, which requires a transient user gesture and routes to `CefDialogHandler::OnFileDialog` (not `CefDownloadHandler`). | Gesture-free periodic auto-save throws `SecurityError`; Save button opens a blocking OS Save-As dialog. | **Patched `save_()` → `POST /api/save` + C++ Fallbacks**:<br>• Patched `main.js` intercepts `save_()` after `currentController.save(SaveRequestType.ANNOTATION)` returns `dataToSave` and `POST`s raw `application/pdf` bytes to `/api/save?name=<name>` for zero-dialog atomic overwrite (works for Ctrl+S, Save button, and periodic auto-save gated on `FINISH_INK_STROKE` + idle).<br>• C++ `CefDialogHandler` and `CefDownloadHandler` remain wired as defense-in-depth fallbacks. |

### Add Page (`+`) Incremental PDF Update Flow
To let users expand notebooks seamlessly while writing without losing Ink2 ink:
1. User clicks the **`+` (Add Page)** button in the ultra-minimal Ink2 toolbar.
2. Patched `main.js` first flushes any pending Ink2 strokes by invoking `currentController.save(SaveRequestType.ANNOTATION)` and `POST`ing the baked PDF bytes to `POST /api/save?name=<docName>`.
3. Once `/api/save` confirms atomic persistence, `main.js` calls `POST /api/notebooks/<docName>/add-page` (using the notebook's existing page dimensions & template by default).
4. The C++ backend appends a new real PDF page object to `<saveDir>/<docName>` via a clean **incremental PDF update** (preserving all prior pages, cross-reference entries, and Ink2 annotations verbatim), atomically writes `.tmp` → rename, and returns `{ name, pages, size, mtime }`.
5. The viewer reloads `/pdf/<docName>#page=<pages>` (and notifies the presenter sub-window via `BroadcastChannel`), landing directly on the newly appended blank/templated page in Ink2 draw mode.

---

## 5. Dual-Screen & `BroadcastChannel` Synchronization Protocol

- **Origin Partitioning**: Serving both windows from `http://127.0.0.1:<port>/pdf/<docName>` guarantees identical Chromium storage partition keys (`http://127.0.0.1:<port>`, `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai`) and `[SecureContext]`, whereas `file://` URLs have opaque origins that isolate `BroadcastChannel` and block `window.getScreenDetails()`.
- **Channel Name**: `crpdf-sync:<docName>` (scoped per open document).
- **Envelope**: Every message is a JSON object `{ type, senderId, ts, ... }`; receivers ignore messages where `msg.senderId === selfId`.

| `type` | Direction | Payload Fields | Purpose & Normalization |
|---|---|---|---|
| `viewport` | Main → Sub | `{ page, zoom, scrollX, scrollY, scrollRatioX, scrollRatioY }` | Real-time page, zoom, and scroll mirroring. |
| `ink_stroke` | Main → Sub | `{ op: 'start'\|'move'\|'end', strokeId, page, x, y, brush: { type, color, size } }` | Live pen stroke relay to `<canvas id="crpdf-ink-mirror">`. `(x, y)` are **page-normalized `0.0–1.0`**. |
| `ink_action` | Main → Sub | `{ op: 'undo'\|'redo'\|'clear_overlay'\|'saved_checkpoint', version }` | Mirrors undo/redo and synchronizes authoritative `/api/save` checkpoints. |
| `laser` | Bidirectional (Sub ↔ Main) | `{ role: 'presenter'\|'main', visible, xPct, yPct, page }` | Red laser pointer (`#ff2222`). `(xPct, yPct)` are **`0–100%` relative to the visible PDF page rect** so differing monitor aspect ratios align accurately. |
| `presenter_ready` | Sub → Main | `{}` | Handshake requesting initial `viewport` state and un-checkpointed mirror strokes. |

### External Monitor Auto-Fullscreen Flow
1. User clicks **Screen Share** in the main window (transient user activation).
2. `window.getScreenDetails()` resolves automatically (pre-granted by `CefPermissionHandler` for `CEF_PERMISSION_TYPE_WINDOW_MANAGEMENT`).
3. If `details.screens.length > 1`, an external screen (`s !== details.currentScreen`) is selected, the presenter popup is opened at that screen's bounds, and fullscreen is requested (`requestFullscreen({ screen: ext })`, backed by C++ window-placement fallback).
4. On single-monitor setups or headless `xvfb-run`, the presenter opens gracefully as a standard resizable popup (`1024×768`).

---

## 6. Desktop-First Portability & `HostBridge` Abstraction (Future Mobile / WASM Note)

While the desktop application strictly preserves **CEF 150 + native PDFium + native Ink2** with zero compromise, the GoodNotes Library UI (`web/app.js`) is decoupled from the C++ host through a thin async adapter in `web/host_bridge.js`:

- `getConfig()` → `GET /api/config`
- `updateConfig(patch)` → `POST /api/config`
- `pickFolder()` → `POST /api/pick-folder`
- `listNotebooks()` → `GET /api/notebooks`
- `createNotebook({ title, template, pageSize, widthMm, heightMm, pages })` → `POST /api/notebooks/create`
- `addPage(name, opts)` → `POST /api/notebooks/<name>/add-page`
- `importNotebook(fileOrBytes, name)` → `POST /api/notebooks/import?name=<name>`
- `deleteNotebook(name)` → `DELETE /api/notebooks/<name>`
- `getPdfUrl(name)` → `/pdf/<encodedName>`

**Portability Boundary**:
- **Reusable Portable Layer**: GoodNotes Library Web UI (`web/*`), `HostBridge` contract, PDF paper template specifications (`blank`/`lined`/`grid`/`dot`, presets + custom mm), and the `crpdf-sync:<docName>` sync schema.
- **Swappable Platform Layer**:
  - *Desktop (current)*: C++ CEF 150 Views host + Embedded Loopback HTTP Server + native PDFium/Ink2 (`resources.pak` patches).
  - *Future Mobile / WASM*: Replace `HostBridge` with an IndexedDB / OPFS / Capacitor-native storage adapter and pair it with a WASM PDFium + ink viewer module without rewriting the workspace UI, settings model, or dual-screen sync protocol.

---

## 7. Build, Verification & Release Pipeline Overview

- **Unit Verification**:
  - `python3 -m unittest discover -s tests/unit -p "test_patch_pak.py" -v` (DataPack v5 format, compression, fingerprinting, idempotency, CLI modes).
  - `node --check web/host_bridge.js && node --check web/app.js` (syntax & adapter verification).
  - C++ unit tests for PDF 1.4 template generation, incremental `add-page`, and loopback HTTP server.
- **Local Linux x64 E2E Verification**: Built with CMake/Ninja against CEF 150 `linux64_minimal`, patched via `scripts/patch_pak.py --verify`, and exercised end-to-end under `xvfb-run` using a Node.js v24 native-WebSocket CDP test suite (`tests/e2e/`).
- **Windows x64 Release CI (`.github/workflows/build-windows.yml`)**: Runs on `windows-latest`, fetches/caches CEF 150 `windows64_minimal`, compiles `CrPDF.exe` with MSVC, patches `resources.pak` via `scripts/patch_pak.py --verify`, packages `Cr-PDF-windows-x64.zip`, and publishes the build artifact and GitHub Release.
