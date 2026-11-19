# Cr-PDF E2E Test Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Testing Philosophy

- **Opaque-Box, Requirement-Driven Design**: Every E2E test in `tests/e2e/` is derived strictly from `ORIGINAL_REQUEST.md` (including all follow-up directives) and `PROJECT.md § Interface Contracts`. Tests never inspect private/minified implementation variables or mock the system under test; they assert only externally observable behavior through HTTP responses, on-disk PDF bytes, Shadow DOM accessibility/geometry, CDP `Input` events, `BroadcastChannel` messages, canvas RGBA pixels, and CLI exit codes.
- **Zero External Dependencies**: The entire E2E stack runs on **Node.js v24** built-ins (`globalThis.WebSocket`, `globalThis.fetch`, `node:net`, `node:zlib`, `node:child_process`, `node:util`, `node:assert/strict`) plus `python3` (for `scripts/patch_pak.py`) and `xvfb-run` (for headless Linux display). Zero `npm install` is required.
- **Strict Non-Cheating Contract**: In live mode, a missing `./build/cr-pdf` binary immediately exits with code `2` (never marked as PASS). Every test uses isolated ephemeral ports (`127.0.0.1:0`) and an isolated temporary `--save-dir` cleaned up in `finally` hooks.

---

## 2. Feature Inventory & Requirement Traceability

| Feature ID | Requirement Summary | Tier 1 (Feature) | Tier 2 (Boundary) | Tier 3 (Pairwise) | Tier 4 (Scenarios) |
|---|---|---|---|---|---|
| **F01–F03** | CEF 150 Chrome Runtime (Views), `--enable-features=PdfInk2`, CLI flags, Permissions/Popup/Save handlers | `T1-A2-01`, `T1-A3-01`, `T1-A7-01` | `T2-A7-01`..`T2-A7-03` | `T3-P3`, `T3-P6` | `T4-S1`, `T4-S5` |
| **F04** | Loopback HTTP API, PDF 1.4 templates (Blank/Lined/Grid/Dot × A4/Letter/16:9 + Custom mm `[50, 1000]`), `POST /api/notebooks/<name>/add-page`, atomic `/api/save` | `T1-A2-01`..`T1-A2-06`, `T1-A6-03` | `T2-A2-01`..`T2-A2-06`, `T2-A6-03` | `T3-P6`, `T3-P8`, `T3-P9` | `T4-S2`, `T4-S3`, `T4-S4` |
| **F05** | Automated `resources.pak` DataPack v5 Patcher (`scripts/patch_pak.py`: raw, gzip, Chromium-Brotli, fingerprint lookup, idempotency, `--verify`) | `T1-A1-01`..`T1-A1-06` | `T2-A1-01`..`T2-A1-06` | — | `T4-S5` |
| **F06** | GoodNotes-Style Notebook Library Web UI (create presets + custom mm, search/sort/delete, folder switch) | `T1-A2-01`, `T1-A2-04`, `T1-A2-05` | `T2-A2-04`..`T2-A2-06` | `T3-P4`, `T3-P6`, `T3-P8` | `T4-S2`, `T4-S4` |
| **F07** | **Feature 1**: Ultra-Minimal 1-Row Top Slim Toolbar (~40–44px height) + hidden `#side-panel`/`#bottom` + multi-pen/highlighter preset slots & ad-hoc custom color + **Add Page (`+`)** + **Dock Toggle** (Top 1-row ↔ Right 1-column ~44–48px width, persisted in `localStorage`) | `T1-A3-01`..`T1-A3-06` | `T2-A3-01`..`T2-A3-06` | `T3-P3`, `T3-P4`, `T3-P7`, `T3-P8`, `T3-P9` | `T4-S1`, `T4-S2`, `T4-S3`, `T4-S5` |
| **F08** | **Feature 2**: Palm Rejection (`pointerType === 'pen'` draws Ink2; `'touch'` blocks Ink2 even pre-stylus, allows 1-finger scroll & 2-finger pinch-zoom) | `T1-A4-01`..`T1-A4-06` | `T2-A4-01`..`T2-A4-06` | `T3-P1` | `T4-S2` |
| **F09** | **Feature 3**: Pseudo-Pressure with **finalized 0/20/40/60/80% fixed thresholds + `maxLevel` (1..5) cap**: `<0.20→1`, `0.20..0.40→2`, `0.40..0.60→3`, `0.60..0.80→4`, `>=0.80→5`, `effectiveLevel = Math.min(maxLevel, rawStep)` + boundary hysteresis + Eraser safety guard | `T1-A5-01`..`T1-A5-06` | `T2-A5-01`..`T2-A5-06` | `T3-P1`, `T3-P2` | `T4-S1` |
| **F10** | **Feature 6**: Auto-Save Folder (`Ctrl+S`/Save button dialog-free atomic overwrite + configurable periodic auto-save gated on stroke finish) | `T1-A6-01`..`T1-A6-06` | `T2-A6-01`..`T2-A6-06` | `T3-P2`, `T3-P4`, `T3-P6`, `T3-P8` | `T4-S1`, `T4-S2`, `T4-S3`, `T4-S5` |
| **F11** | **Feature 4**: Screen-Sharing Sub-Window (`"[화면공유용] 판서 화면"`), pure-PDF CSS, `BroadcastChannel` viewport + live ink mirror, `getScreenDetails()` auto-fullscreen | `T1-A7-01`..`T1-A7-06` | `T2-A7-01`..`T2-A7-06` | `T3-P3`, `T3-P5`, `T3-P7`, `T3-P9` | `T4-S1`, `T4-S5` |
| **F12** | **Feature 5**: Dual-Window Input Separation (main stylus Ink2, sub-window zero ink + glowing red laser pointer with bidirectional normalized `(x%, y%)` sync) | `T1-A8-01`..`T1-A8-06` | `T2-A8-01`..`T2-A8-06` | `T3-P5` | `T4-S1`, `T4-S5` |

---

## 3. Test Architecture & Harness

### File Layout (`tests/e2e/`)
- `tests/e2e/cdp_client.mjs`: Multi-target CDP controller (`CdpBrowser`, `CdpSession`, `connectCdp`) merging `/json/list` and `Target.setDiscoverTargets` / `Target.attachToTarget` to coordinate:
  1. Main top-level window (`http://127.0.0.1:<port>/...`) — receives real CDP `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent` / `Input.dispatchKeyEvent`.
  2. Chromium PDF viewer extension (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`) — deep Shadow DOM queries (`queryDeep`, `queryAllDeep`, `waitForDeep`, `clickDeep`) and `Runtime.evaluate`.
  3. Presenter sub-window (`"[화면공유용] 판서 화면"` / `crpdf_role=presenter`) and its inner PDF viewer extension target.
  - Synthetic input dispatchers: `dispatchPenStroke` (per-point `force`, optional hover lead-in, optional `holdMs`), `dispatchTouchDrag`, `dispatchPinchZoom`, `dispatchMultiTouch`, `dispatchMouseMove`, `dispatchMouseDrag`, `pressCtrlS`, `pressCtrlZ`.
- `tests/e2e/harness.mjs`:
  - `allocatePorts(count)`: concurrent `127.0.0.1:0` ephemeral port allocator.
  - `launchApp(options)`: spawns `./build/cr-pdf` (or `CRPDF_BIN`) under `xvfb-run -a --server-args="-screen 0 1280x800x24"` on headless Linux with `--no-sandbox --disable-gpu --port=<p> --remote-debugging-port=<cdp> --save-dir=<tmp> --autosave-interval=<sec>`, readiness gate (`/api/health` + `/json/version`), bounded stdout/stderr ring buffer, and process-group SIGTERM→SIGKILL + temp-dir teardown.
  - `createApiClient(baseUrl)`: full loopback HTTP API client for all `PROJECT.md § Interface Contracts` endpoints (including custom mm `createNotebook` and `addPage`).
  - `createMinimalPdf` & incremental-update-aware `inspectPdfBuffer` (checks `%PDF-` header, `%%EOF`, revision count, latest `/Pages /Count`, `/MediaBox` pt & mm dimensions, and annotation markers).
  - `createSyntheticPakV5` & `parsePakV5` (raw, gzip `0x1f 0x8b`, Chromium-Brotli `0x1e 0x9b` + 6-byte LE size, aliases, sentinel).
- `tests/e2e/pdf_helpers.mjs`: Shared opaque-box helpers (`openPdfInMainWindow`, `getPdfPageRect`, `setPressureMaxLevel`, `expectedPseudoPressureLevel`, `getActiveBrushState`, `getUndoState`, `getViewportState`, `getMirrorCanvasStats`, `getLaserState`, `attachBroadcastRecorder`, `openPresenterSubWindow`, `waitForFileUpdate`, `assertNoTmpFiles`, `runPatchPakCli`, `assertJsSyntaxValid`).
- `tests/e2e/tier1_features.mjs`: 48 isolated feature tests (`T1-A1-01` .. `T1-A8-06`).
- `tests/e2e/tier2_boundaries.mjs`: 48 isolated boundary/corner-case tests (`T2-A1-01` .. `T2-A8-06`).
- `tests/e2e/tier3_pairwise.mjs`: 9 cross-feature pairwise combination suites (`T3-P1` .. `T3-P9`).
- `tests/e2e/tier4_scenarios.mjs`: 5 real-world end-to-end application workflows (`T4-S1` .. `T4-S5`).
- `tests/e2e/run_e2e.mjs`: Zero-dependency CLI runner supporting `--tier`, `--list`, `--filter`, `--timeout`, `--json`, `--bin`, `--fail-fast`.

---

## 4. Tier 1–4 Coverage Matrix

| Tier | File | Test IDs | Features Covered | Assertion Layers | Count |
|---|---|---|---|---|---|
| **Tier 1** | `tests/e2e/tier1_features.mjs` | `T1-A1-01`..`T1-A8-06` | `F02`, `F04`–`F12` (8 areas × 6 tests) | CLI, HTTP, Disk PDF, Shadow DOM, CDP Input, Canvas, BroadcastChannel | **48** |
| **Tier 2** | `tests/e2e/tier2_boundaries.mjs` | `T2-A1-01`..`T2-A8-06` | Negative, boundary & corner cases across all 8 areas (× 6 tests) | CLI, HTTP 4xx, Disk PDF, Shadow DOM, CDP Input, Emulation, Canvas | **48** |
| **Tier 3** | `tests/e2e/tier3_pairwise.mjs` | `T3-P1`..`T3-P9` | Cross-feature pairwise interactions (`F04`–`F12`) | Multi-target CDP, HTTP, Disk PDF, Canvas Quadrants, BroadcastChannel | **9** |
| **Tier 4** | `tests/e2e/tier4_scenarios.mjs` | `T4-S1`..`T4-S5` | 5 end-to-end real-world production workflows | Full stack: CLI + HTTP + Library UI + Ink2 + Dual-Window + Disk | **5** |
| **Total** | — | — | 100% of `F01`–`F12` + Follow-up Specs | All layers | **110** |

---

## 5. Tier 4 Real-World Application Scenarios

1. **`T4-S1` — Classroom Lecture Workflow**: Create 2-page Lined A4 notebook → verify slim minimal toolbar & Ink2 active → set `maxLevel=3` and draw strokes across `0.10/0.30/0.90` force (`1→2→3` capped) → launch `[화면공유용] 판서 화면` (pure-PDF CSS) → mirror 4th stroke & turn to page 2 → point red laser from sub-window and verify bidirectional sync → wait for periodic auto-save and verify valid disk PDF with 0 `.tmp` files.
2. **`T4-S2` — Imported PDF Annotation & Silent Overwrite**: Import external 2-page PDF → verify pre-stylus palm touch creates 0 ink → annotate with Pen + Highlighter + Undo → `Ctrl+S` dialog-free atomic overwrite → return to Library and reopen with persisted annotated bytes.
3. **`T4-S3` — Periodic Auto-Save Durability & Continuous Add-Page**: Launch with `--autosave-interval=2` → create custom B5 (`176×250 mm`) Grid notebook → draw on page 1 → click toolbar **Add Page (`+`)** (preserves page 1 Ink2 & appends `176×250 mm` page 2) → write continuously on page 2 without ever pressing `Ctrl+S` → verify 2 consecutive periodic auto-save cycles with valid PDF and 0 `.tmp` files.
4. **`T4-S4` — Notebook Library Management & Folder Switch Isolation**: Create 4 notebooks (Blank A4, Lined Letter, Grid 16:9, Dot custom `150×210 mm`) → verify Library UI rendering & search filtering → delete one notebook → switch `saveDir` to empty folder B via `POST /api/config` → create a new notebook in folder B and confirm strict cross-folder isolation.
5. **`T4-S5` — CEF Version-Upgrade Simulation (`patch_pak.py`)**: Run `python3 scripts/patch_pak.py --verify` twice consecutively on base `resources.pak` → assert DataPack v5 structural identity, single marker pairs, and valid JS syntax → launch live app and execute full Ink2 + presenter + laser + `Ctrl+S` smoke workflow.

---

## 6. Coverage Thresholds & Pass Criteria

- **Tier 1–4 Pass Rate**: **100%** (`110/110` passing, `0` failed, `0` skipped in M5 Phase 1).
- **Feature Coverage**: **100%** of `F01`–`F12` plus all follow-up specs (`F14` verified in M6 GitHub Actions).
- **Structural Invariants**:
  - `0` lingering `*.tmp` files after any save or `add-page`.
  - `0` uncaught `Runtime.exceptionThrown` errors or renderer crashes across tool/pressure/touch transitions.
  - Every generated/saved PDF starts with `%PDF-`, ends with `%%EOF`, and has exact integer page count and expected `/MediaBox` dimensions (`±1.5 pt`).
  - Every `patch_pak.py` output satisfies DataPack v5 sorted IDs, exact sentinel offset, alias preservation, single marker pairs, and `node --check` JS syntax validity.

---

## 7. Execution Commands

```bash
# Dry-run: list all 110 tests grouped by tier & feature area (no binary required)
node tests/e2e/run_e2e.mjs --list

# List a specific tier
node tests/e2e/run_e2e.mjs --tier 1 --list
node tests/e2e/run_e2e.mjs --tier 2 --list
node tests/e2e/run_e2e.mjs --tier 3 --list
node tests/e2e/run_e2e.mjs --tier 4 --list

# Run full E2E suite (auto-wraps with xvfb-run on headless Linux)
CRPDF_BIN=./build/cr-pdf node tests/e2e/run_e2e.mjs

# Run a single tier with JSON report
CRPDF_BIN=./build/cr-pdf node tests/e2e/run_e2e.mjs --tier 1 --json /tmp/e2e-tier1.json

# Run standalone patch_pak.py tests only (before CEF binary is built)
node tests/e2e/run_e2e.mjs --filter "T[12]-A1-0[1-5]|T2-A1-06"

# Syntax-check all E2E test modules
for f in tests/e2e/*.mjs; do node --check "$f"; done
```
