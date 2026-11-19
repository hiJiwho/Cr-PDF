/**
 * Tier 1 — Feature Coverage Suite (48 isolated opaque-box tests across 8 feature areas).
 *
 * Areas (6 tests each):
 *   A1: resources.pak Patcher Round-Trip & Idempotency (F05, standalone CLI)
 *   A2: Local HTTP API & GoodNotes Notebook Templates (F04, F06)
 *   A3: Native PDFium + Ink2 Load & Ultra-Minimal 1-Row/Right-Dock Toolbar + Preset Slots + Add Page (F02, F07)
 *   A4: Palm Rejection (pointerType pen vs touch) (F08)
 *   A5: Pseudo-Pressure (0/20/40/60/80% fixed thresholds + maxLevel 1..5 cap) (F09)
 *   A6: Auto-Save Folder & Periodic Auto-Save (F10)
 *   A7: Screen-Sharing Sub-Window ("[화면공유용] 판서 화면") & Mirroring (F11)
 *   A8: Dual-Window Input Separation & Bidirectional Red Laser Pointer (F12)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MM_TO_PT,
  REPO_ROOT,
  createMinimalPdf,
  inspectPdfBuffer,
  launchApp,
  parsePakV5,
  resolveBasePakPath,
} from './harness.mjs';
import { PDF_EXT_ORIGIN, PRESENTER_TITLE } from './cdp_client.mjs';
import {
  TOOLBAR_SELECTORS,
  assertJsSyntaxValid,
  assertNoTmpFiles,
  assertPakV5Structure,
  attachBroadcastRecorder,
  buildSyntheticResourcesPak,
  clickControl,
  countMarkers,
  expectedPseudoPressureLevel,
  getActiveBrushState,
  getLaserState,
  getMirrorCanvasStats,
  getPdfPageRect,
  getUndoState,
  getViewportState,
  goToPdfPage,
  normToPoint,
  openPdfInMainWindow,
  openPresenterSubWindow,
  queryFirstDeep,
  readBroadcastRecorder,
  runPatchPakCli,
  setPdfZoom,
  setPressureMaxLevel,
  sha256,
  sleep,
  waitFor,
  waitForFileUpdate,
  waitForFirstDeep,
} from './pdf_helpers.mjs';

function makeTempDir(prefix = 'crpdf-t1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const tests = [
  // =========================================================================
  // Area 1: resources.pak Patcher Round-Trip & Idempotency (6 Tests)
  // =========================================================================
  {
    id: 'T1-A1-01',
    tier: 1,
    feature: 'A1: resources.pak Patcher',
    title: 'DataPack v5 uncompressed round-trip preserves structure, aliases, and dummy entries',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t1-a1-01-');
      try {
        const inPath = path.join(tmp, 'in.pak');
        const outPath = path.join(tmp, 'out.pak');
        const pak = buildSyntheticResourcesPak({
          mainId: 2001,
          wrapperId: 2002,
          dummyId: 2003,
          compression: 'none',
          aliases: [{ id: 9001, targetId: 2003 }],
        });
        fs.writeFileSync(inPath, pak);

        const res = runPatchPakCli({ input: inPath, output: outPath });
        assert.equal(res.status, 0, `patch_pak.py failed: ${res.stderr}`);
        const parsed = assertPakV5Structure(fs.readFileSync(outPath));
        assert.equal(parsed.encoding, 1);
        assert.deepEqual(parsed.aliases, [{ id: 9001, entryIndex: 2 }]);

        const mainEntry = parsed.entries.find((e) => e.id === 2001);
        const wrapperEntry = parsed.entries.find((e) => e.id === 2002);
        const dummyEntry = parsed.entries.find((e) => e.id === 2003);
        assert.ok(mainEntry.data.toString('utf8').includes('CRPDF_PATCH_START'), 'main.js must be patched');
        assert.ok(wrapperEntry.data.toString('utf8').includes('CRPDF_PATCH_START'), 'wrapper.js must be patched');
        assert.equal(
          dummyEntry.data.toString('utf8'),
          '/* unrelated dummy resource */ export const DUMMY = 42;\n',
          'unrelated dummy entry must remain byte-for-byte identical',
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T1-A1-02',
    tier: 1,
    feature: 'A1: resources.pak Patcher',
    title: 'Gzip-compressed entries (0x1f 0x8b) decompress, patch, and pass JS syntax check',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t1-a1-02-');
      try {
        const inPath = path.join(tmp, 'in_gzip.pak');
        const outPath = path.join(tmp, 'out_gzip.pak');
        fs.writeFileSync(inPath, buildSyntheticResourcesPak({ compression: 'gzip' }));

        const res = runPatchPakCli({ input: inPath, output: outPath });
        assert.equal(res.status, 0, `patch_pak.py gzip failed: ${res.stderr}`);

        const parsed = assertPakV5Structure(fs.readFileSync(outPath));
        for (const id of [2001, 2002]) {
          const entry = parsed.entries.find((e) => e.id === id);
          const js = entry.data.toString('utf8');
          assert.ok(js.includes('CRPDF_PATCH_START'), `Entry ${id} missing CRPDF_PATCH_START`);
          assert.ok(js.includes('CRPDF_PATCH_END'), `Entry ${id} missing CRPDF_PATCH_END`);
          assertJsSyntaxValid(js, `entry_${id}.mjs`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T1-A1-03',
    tier: 1,
    feature: 'A1: resources.pak Patcher',
    title: 'Chromium-Brotli entries (0x1e 0x9b + 6-byte LE size) patch and pass JS syntax check',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t1-a1-03-');
      try {
        const inPath = path.join(tmp, 'in_br.pak');
        const outPath = path.join(tmp, 'out_br.pak');
        fs.writeFileSync(inPath, buildSyntheticResourcesPak({ compression: 'brotli' }));

        const res = runPatchPakCli({ input: inPath, output: outPath });
        assert.equal(res.status, 0, `patch_pak.py brotli failed: ${res.stderr}`);

        const parsed = assertPakV5Structure(fs.readFileSync(outPath));
        for (const id of [2001, 2002]) {
          const entry = parsed.entries.find((e) => e.id === id);
          if (entry.compression === 'brotli') {
            assert.equal(entry.declaredSize, entry.data.length, 'Chromium-Brotli 6-byte LE size mismatch');
          }
          const js = entry.data.toString('utf8');
          assert.ok(js.includes('CRPDF_PATCH_START'), `Entry ${id} missing CRPDF_PATCH_START`);
          assertJsSyntaxValid(js, `brotli_${id}.mjs`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T1-A1-04',
    tier: 1,
    feature: 'A1: resources.pak Patcher',
    title: 'Content-fingerprint lookup patches reassigned numeric resource IDs agnostically',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t1-a1-04-');
      try {
        const cases = [
          { mainId: 1001, wrapperId: 1002, dummyId: 1003 },
          { mainId: 45123, wrapperId: 45124, dummyId: 45125 },
        ];
        for (const c of cases) {
          const inPath = path.join(tmp, `in_${c.mainId}.pak`);
          const outPath = path.join(tmp, `out_${c.mainId}.pak`);
          fs.writeFileSync(inPath, buildSyntheticResourcesPak(c));
          const res = runPatchPakCli({ input: inPath, output: outPath });
          assert.equal(res.status, 0, `patch_pak.py failed for IDs ${c.mainId}/${c.wrapperId}: ${res.stderr}`);

          const parsed = assertPakV5Structure(fs.readFileSync(outPath));
          assert.ok(parsed.entries.find((e) => e.id === c.mainId).data.toString('utf8').includes('CRPDF_PATCH_START'));
          assert.ok(
            parsed.entries.find((e) => e.id === c.wrapperId).data.toString('utf8').includes('CRPDF_PATCH_START'),
          );
          assert.ok(
            !parsed.entries.find((e) => e.id === c.dummyId).data.toString('utf8').includes('CRPDF_PATCH_START'),
          );
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T1-A1-05',
    tier: 1,
    feature: 'A1: resources.pak Patcher',
    title: 'Double-patching is idempotent with exactly 1 marker pair per entry',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t1-a1-05-');
      try {
        const inPath = path.join(tmp, 'orig.pak');
        const p1Path = path.join(tmp, 'p1.pak');
        const p2Path = path.join(tmp, 'p2.pak');
        fs.writeFileSync(inPath, buildSyntheticResourcesPak({ compression: 'brotli' }));

        const r1 = runPatchPakCli({ input: inPath, output: p1Path, verify: true });
        assert.equal(r1.status, 0, `Pass 1 failed: ${r1.stderr}`);
        const r2 = runPatchPakCli({ input: p1Path, output: p2Path, verify: true });
        assert.equal(r2.status, 0, `Pass 2 failed: ${r2.stderr}`);

        const parsed1 = assertPakV5Structure(fs.readFileSync(p1Path));
        const parsed2 = assertPakV5Structure(fs.readFileSync(p2Path));
        for (const id of [2001, 2002]) {
          const js1 = parsed1.entries.find((e) => e.id === id).data.toString('utf8');
          const js2 = parsed2.entries.find((e) => e.id === id).data.toString('utf8');
          assert.equal(countMarkers(js2, 'CRPDF_PATCH_START'), 1, `Duplicate CRPDF_PATCH_START in entry ${id}`);
          assert.equal(countMarkers(js2, 'CRPDF_PATCH_END'), 1, `Duplicate CRPDF_PATCH_END in entry ${id}`);
          assert.equal(js2, js1, `Decompressed JS changed on second patch pass for entry ${id}`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T1-A1-06',
    tier: 1,
    feature: 'A1: resources.pak Patcher',
    title: '--verify validates real CEF 150 resources.pak round-trip and patched JS syntax',
    requiresBinary: true,
    async run() {
      const basePak = resolveBasePakPath();
      assert.ok(fs.existsSync(basePak), `Real CEF resources.pak not found at ${basePak}`);
      const tmp = makeTempDir('crpdf-t1-a1-06-');
      try {
        const outPath = path.join(tmp, 'patched_real.pak');
        const res = runPatchPakCli({ input: basePak, output: outPath, verify: true });
        assert.equal(res.status, 0, `patch_pak.py --verify failed on real pak:\n${res.stderr}\n${res.stdout}`);

        const parsed = assertPakV5Structure(fs.readFileSync(outPath));
        const patchedEntries = parsed.entries.filter((e) => e.data.toString('utf8').includes('CRPDF_PATCH_START'));
        assert.ok(patchedEntries.length >= 2, `Expected >=2 patched entries in real pak, got ${patchedEntries.length}`);
        for (const entry of patchedEntries) {
          assertJsSyntaxValid(entry.data.toString('utf8'), `real_${entry.id}.mjs`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },

  // =========================================================================
  // Area 2: Local HTTP API & GoodNotes Notebook Templates (6 Tests)
  // =========================================================================
  {
    id: 'T1-A2-01',
    tier: 1,
    feature: 'A2: HTTP API & Templates',
    title: 'Library root (/), static assets, and /api/health return valid contracts',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const root = await app.api.getRootHtml();
        assert.equal(root.status, 200);
        assert.match(root.headers.get('content-type') || '', /text\/html/i);

        for (const asset of ['app.js', 'host_bridge.js', 'styles.css']) {
          const r = await app.api.getStatic(asset);
          assert.equal(r.status, 200, `Expected 200 for /static/${asset}, got ${r.status}`);
          assert.ok(r.buffer.length > 0);
        }

        const health = await app.api.health();
        assert.equal(health.status, 200);
        assert.equal(health.json?.status, 'ok');
        assert.equal(health.json?.port, app.appPort);
        assert.equal(path.resolve(health.json?.saveDir || ''), path.resolve(app.saveDir));
        assert.ok(typeof health.json?.version === 'string' && health.json.version.length > 0);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A2-02',
    tier: 1,
    feature: 'A2: HTTP API & Templates',
    title: 'GET/POST /api/config persists settings accurately',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const initial = await app.api.getConfig();
        assert.equal(initial.status, 200);
        assert.equal(typeof initial.json?.autosaveIntervalSec, 'number');

        const updated = await app.api.updateConfig({
          autosaveIntervalSec: 45,
          palmRejection: true,
          pseudoPressure: true,
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.json?.autosaveIntervalSec, 45);

        const reread = await app.api.getConfig();
        assert.equal(reread.status, 200);
        assert.equal(reread.json?.autosaveIntervalSec, 45);
        assert.equal(reread.json?.palmRejection, true);
        assert.equal(reread.json?.pseudoPressure, true);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A2-03',
    tier: 1,
    feature: 'A2: HTTP API & Templates',
    title: 'Create all 4 templates (blank/lined/grid/dot) across A4, Letter, and 16:9',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const specs = [
          { title: 'T_Blank_A4', template: 'blank', pageSize: 'a4', wPt: 595.28, hPt: 841.89 },
          { title: 'T_Lined_Letter', template: 'lined', pageSize: 'letter', wPt: 612, hPt: 792 },
          { title: 'T_Grid_16x9', template: 'grid', pageSize: '16x9', wPt: null, hPt: null },
          { title: 'T_Dot_A4', template: 'dot', pageSize: 'a4', wPt: 595.28, hPt: 841.89 },
        ];
        const sizes = {};
        for (const s of specs) {
          const res = await app.api.createNotebook({
            title: s.title,
            template: s.template,
            pageSize: s.pageSize,
            pages: 2,
          });
          assert.equal(res.status, 201, `Create failed for ${s.title}: ${res.text}`);
          const filePath = path.join(app.saveDir, res.json.name);
          assert.ok(fs.existsSync(filePath), `Missing generated file ${filePath}`);
          const pdf = inspectPdfBuffer(fs.readFileSync(filePath));
          assert.equal(pdf.validHeader, true);
          assert.equal(pdf.validEof, true);
          assert.equal(pdf.pagesCount, 2, `Expected 2 pages for ${s.title}, got ${pdf.pagesCount}`);
          assert.ok(pdf.mediaBoxes.length >= 1, `Missing MediaBox in ${s.title}`);
          const mb = pdf.mediaBoxes[0];
          if (s.wPt && s.hPt) {
            assert.ok(Math.abs(mb.widthPt - s.wPt) <= 2.0, `${s.title} widthPt ${mb.widthPt} != ${s.wPt}`);
            assert.ok(Math.abs(mb.heightPt - s.hPt) <= 2.0, `${s.title} heightPt ${mb.heightPt} != ${s.hPt}`);
          } else {
            // 16:9 landscape aspect ratio check
            assert.ok(Math.abs(mb.widthPt / mb.heightPt - 16 / 9) < 0.05, `16:9 ratio mismatch: ${mb.widthPt}x${mb.heightPt}`);
          }
          sizes[s.template] = pdf.byteLength;
        }
        assert.ok(sizes.dot > sizes.blank || sizes.grid > sizes.blank, 'Pattern templates should contain vector drawing ops');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A2-04',
    tier: 1,
    feature: 'A2: HTTP API & Templates',
    title: 'Create notebook with custom mm paper dimensions (180x250 mm)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const res = await app.api.createNotebook({
          title: 'CustomMM',
          template: 'grid',
          pageSize: 'custom',
          widthMm: 180,
          heightMm: 250,
          pages: 1,
        });
        assert.equal(res.status, 201, `Custom mm create failed: ${res.text}`);
        assert.equal(res.json.widthMm, 180);
        assert.equal(res.json.heightMm, 250);
        assert.equal(res.json.pages, 1);

        const pdf = inspectPdfBuffer(fs.readFileSync(path.join(app.saveDir, res.json.name)));
        assert.equal(pdf.validHeader, true);
        assert.equal(pdf.validEof, true);
        assert.equal(pdf.pagesCount, 1);
        const mb = pdf.mediaBoxes[0];
        assert.ok(Math.abs(mb.widthPt - 180 * MM_TO_PT) <= 1.5, `widthPt=${mb.widthPt}`);
        assert.ok(Math.abs(mb.heightPt - 250 * MM_TO_PT) <= 1.5, `heightPt=${mb.heightPt}`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A2-05',
    tier: 1,
    feature: 'A2: HTTP API & Templates',
    title: 'Import, list, serve PDF headers (no-store), and delete notebook lifecycle',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const pdfBytes = createMinimalPdf({ pages: 1, label: 'Lifecycle' });
        const imp = await app.api.importNotebook('sample.pdf', pdfBytes);
        assert.equal(imp.status, 201, `Import failed: ${imp.text}`);

        const list1 = await app.api.listNotebooks();
        assert.equal(list1.status, 200);
        const found = list1.json.notebooks.find((n) => n.name === 'sample.pdf');
        assert.ok(found, 'sample.pdf missing from /api/notebooks');
        assert.equal(found.size, pdfBytes.length);

        const served = await app.api.getPdf('sample.pdf');
        assert.equal(served.status, 200);
        assert.match(served.headers.get('content-type') || '', /application\/pdf/i);
        assert.match(served.headers.get('cache-control') || '', /no-store/i);
        assert.equal(sha256(served.buffer), sha256(pdfBytes));

        const del = await app.api.deleteNotebook('sample.pdf');
        assert.equal(del.status, 200);
        assert.equal(del.json?.deleted, true);

        const afterDel = await app.api.getPdf('sample.pdf');
        assert.equal(afterDel.status, 404);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A2-06',
    tier: 1,
    feature: 'A2: HTTP API & Templates',
    title: 'POST /api/notebooks/<name>/add-page appends matching page atomically',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const created = await app.api.createNotebook({
          title: 'AddPageApi',
          template: 'lined',
          pageSize: 'a4',
          pages: 1,
        });
        assert.equal(created.status, 201);

        const added = await app.api.addPage(created.json.name, {});
        assert.equal(added.status, 200, `add-page failed: ${added.text}`);
        assert.equal(added.json?.pages, 2);
        assertNoTmpFiles(app.saveDir);

        const served = await app.api.getPdf(created.json.name);
        assert.equal(served.status, 200);
        const pdf = inspectPdfBuffer(served.buffer);
        assert.equal(pdf.validHeader, true);
        assert.equal(pdf.validEof, true);
        assert.equal(pdf.pagesCount, 2);
        assert.ok(pdf.mediaBoxes.length >= 2, 'Expected MediaBox on appended page 2');
        const lastMb = pdf.mediaBoxes[pdf.mediaBoxes.length - 1];
        assert.ok(Math.abs(lastMb.widthPt - 595.28) <= 2.0);
        assert.ok(Math.abs(lastMb.heightPt - 841.89) <= 2.0);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 3: Native PDFium + Ink2 & Ultra-Minimal 1-Row/Right-Dock Toolbar (6 Tests)
  // =========================================================================
  {
    id: 'T1-A3-01',
    tier: 1,
    feature: 'A3: PDFium, Ink2 & Minimal Toolbar',
    title: 'Native Chrome PDF viewer extension loads and auto-activates Ink2 draw mode',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Ink2Load', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        assert.ok(pdfTarget.url.startsWith(PDF_EXT_ORIGIN), `Expected PDF extension URL, got ${pdfTarget.url}`);

        // Pen stroke works immediately without manually toggling annotation mode
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.3), normToPoint(rect, 0.55, 0.3)], { force: 0.5 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, {
          timeoutMs: 5000,
          label: 'Undo enabled after immediate pen stroke',
        });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A3-02',
    tier: 1,
    feature: 'A3: PDFium, Ink2 & Minimal Toolbar',
    title: 'Default 1-row top ultra-slim bar (~40-44px), preset slots, color popover, and Dock Toggle to right vertical bar (~44-48px)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ToolbarLayout', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        const bar = await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS.toolbarBar);
        assert.ok(
          bar.rect.height >= 32 && bar.rect.height <= 56 && bar.rect.width > bar.rect.height * 4,
          `Expected slim top horizontal 1-row bar (~40-44px height), got ${bar.rect.width}x${bar.rect.height}`,
        );

        // Required core controls visible
        for (const key of ['pen', 'highlighter', 'eraser', 'undo', 'save', 'addPage', 'screenShare', 'library', 'dockToggle']) {
          const ctrl = await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS[key], { visible: true, timeoutMs: 5000 });
          assert.equal(ctrl.visible, true, `Expected ${key} control to be visible`);
        }

        // Bulky Ink2 #side-panel and #bottom must be hidden
        for (const bulky of ['#side-panel', 'viewer-side-panel', '#bottom', 'viewer-bottom-toolbar']) {
          const snap = await pdfSession.queryDeep(bulky);
          assert.ok(!snap.found || !snap.visible, `Bulky stock Ink2 element ${bulky} must be hidden`);
        }

        // Default multi-pen/highlighter preset slots present & clickable
        const slots = await pdfSession.queryAllDeep('[data-crpdf-slot], .crpdf-preset-slot, [data-crpdf-preset]');
        assert.ok(slots.filter((s) => s.visible).length >= 2, 'Expected default pen/highlighter preset slots on slim bar');

        // Toggle Dock -> Right 1-column vertical slim bar (~44-48px width) + localStorage persistence
        await clickControl(pdfSession, 'dockToggle', { pageSession: mainPage });
        await waitFor(
          async () => {
            const rightBar = await queryFirstDeep(pdfSession, TOOLBAR_SELECTORS.toolbarBar);
            return rightBar.found && rightBar.rect.width >= 36 && rightBar.rect.width <= 60 && rightBar.rect.height > rightBar.rect.width * 3;
          },
          { timeoutMs: 4000, label: 'right-docked vertical slim bar' },
        );

        const persistedDock = await pdfSession.evaluate(`(() => {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k) || '';
            if (/dock/i.test(k) || /right/i.test(v)) return { key: k, value: v };
          }
          return null;
        })()`);
        assert.ok(persistedDock, 'Expected right-dock state to be persisted in localStorage');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A3-03',
    tier: 1,
    feature: 'A3: PDFium, Ink2 & Minimal Toolbar',
    title: 'Extraneous stock Chrome PDF viewer controls are completely hidden',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'HideChrome', template: 'blank', pageSize: 'a4', pages: 1 });
        const { pdfSession } = await openPdfInMainWindow(app, created.json.url);

        const forbidden = ['#print', '#rotate', '#sidenavToggle', '#more', '#text-annotate', '#signature', '#save-to-drive'];
        for (const sel of forbidden) {
          const snap = await pdfSession.queryDeep(sel);
          assert.ok(!snap.found || !snap.visible, `Extraneous stock control ${sel} must be hidden`);
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A3-04',
    tier: 1,
    feature: 'A3: PDFium, Ink2 & Minimal Toolbar',
    title: 'Tool switching (Pen, Highlighter, Eraser) and custom preset slot/ad-hoc color work',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ToolSwitch', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        await clickControl(pdfSession, 'highlighter', { pageSession: mainPage });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).tool === 'highlighter', {
          timeoutMs: 4000,
          label: 'highlighter active',
        });

        await clickControl(pdfSession, 'eraser', { pageSession: mainPage });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).tool === 'eraser', {
          timeoutMs: 4000,
          label: 'eraser active',
        });

        await clickControl(pdfSession, 'pen', { pageSession: mainPage });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).tool === 'pen', {
          timeoutMs: 4000,
          label: 'pen active',
        });

        // Ad-hoc color preset button click updates color cleanly without errors
        const colorBtn = await queryFirstDeep(pdfSession, TOOLBAR_SELECTORS.colorPreset);
        if (colorBtn.found && colorBtn.visible) {
          await pdfSession.clickDeep(colorBtn.selector, { pageSession: mainPage });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A3-05',
    tier: 1,
    feature: 'A3: PDFium, Ink2 & Minimal Toolbar',
    title: 'Undo reverts a drawn Ink2 stroke cleanly',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'UndoTest', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        assert.equal((await getUndoState(pdfSession)).disabled, true, 'Undo should start disabled');
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });

        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, {
          timeoutMs: 5000,
          label: 'Undo enabled after stroke',
        });

        await clickControl(pdfSession, 'undo', { pageSession: mainPage });
        await waitFor(async () => (await getUndoState(pdfSession)).disabled, {
          timeoutMs: 5000,
          label: 'Undo disabled again after reverting stroke',
        });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A3-06',
    tier: 1,
    feature: 'A3: PDFium, Ink2 & Minimal Toolbar',
    title: 'Toolbar Add Page (+) saves Ink2 annotations, appends page 2, and navigates to page 2',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'AddPageToolbar', template: 'lined', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.4), normToPoint(rect, 0.7, 0.4)], { force: 0.6 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 5000, label: 'stroke recorded' });

        await clickControl(pdfSession, 'addPage', { pageSession: mainPage });

        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000, requireSizeIncrease: true });
        assert.equal(updated.pdf.pagesCount, 2, 'Expected 2 pages after Add Page (+)');
        assertNoTmpFiles(app.saveDir);

        const { session: reloadedPdf } = await app.cdp.waitForPdfViewer({ role: 'main', timeoutMs: 10000 });
        await waitFor(async () => (await getViewportState(reloadedPdf)).page === 2, {
          timeoutMs: 6000,
          label: 'viewer navigated to page 2',
        });
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 4: Palm Rejection (pointerType) (6 Tests)
  // =========================================================================
  {
    id: 'T1-A4-01',
    tier: 1,
    feature: 'A4: Palm Rejection',
    title: 'Stylus (pointerType="pen") draws a real Ink2 stroke persisted on save',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PenDraw', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.25), normToPoint(rect, 0.65, 0.45)], { force: 0.5 });

        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 5000, label: 'pen stroke undo' });
        await mainPage.pressCtrlS();
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A4-02',
    tier: 1,
    feature: 'A4: Palm Rejection',
    title: 'Single-finger touch (pointerType="touch") completely blocks Ink2 drawing',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'TouchBlock', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.3, 0.3), normToPoint(rect, 0.7, 0.6)]);
        await sleep(300);
        assert.equal((await getUndoState(pdfSession)).disabled, true, 'Touch drag must NOT create an Ink2 stroke');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A4-03',
    tier: 1,
    feature: 'A4: Palm Rejection',
    title: 'Single-finger touch scrolls a multi-page PDF without drawing ink',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'TouchScroll', template: 'lined', pageSize: 'a4', pages: 3 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        const vp0 = await getViewportState(pdfSession);

        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.75), normToPoint(rect, 0.5, 0.25)], { steps: 10 });
        await waitFor(async () => (await getViewportState(pdfSession)).scrollTop > vp0.scrollTop, {
          timeoutMs: 4000,
          label: 'scrollTop increased via touch drag',
        });
        assert.equal((await getUndoState(pdfSession)).disabled, true, 'Touch scroll must create 0 Ink2 strokes');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A4-04',
    tier: 1,
    feature: 'A4: Palm Rejection',
    title: 'Two-finger touch pinch-zoom passes through without creating Ink2 ink',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PinchZoom', template: 'grid', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchPinchZoom(normToPoint(rect, 0.5, 0.5), 80, 240, { steps: 10 });
        await sleep(350);
        assert.equal((await getUndoState(pdfSession)).disabled, true, '2-finger pinch must create 0 Ink2 strokes');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A4-05',
    tier: 1,
    feature: 'A4: Palm Rejection',
    title: 'Touch scroll followed immediately by pen stroke draws seamlessly',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'TouchThenPen', template: 'blank', pageSize: 'a4', pages: 2 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.7), normToPoint(rect, 0.5, 0.3)]);
        await sleep(150);
        assert.equal((await getUndoState(pdfSession)).disabled, true);

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.35), normToPoint(rect, 0.6, 0.35)], { force: 0.5 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 5000, label: 'pen stroke after touch' });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A4-06',
    tier: 1,
    feature: 'A4: Palm Rejection',
    title: 'Pen stroke followed by palm touch rejects touch (single Undo clears everything)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PenThenTouch', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.5, 0.3)], { force: 0.5 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 5000, label: 'pen stroke' });

        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.3, 0.5), normToPoint(rect, 0.7, 0.7)]);
        await sleep(200);

        await clickControl(pdfSession, 'undo', { pageSession: mainPage });
        await waitFor(async () => (await getUndoState(pdfSession)).disabled, {
          timeoutMs: 5000,
          label: 'single undo clears only pen stroke',
        });
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 5: Pseudo-Pressure (0/20/40/60/80% Fixed Thresholds + maxLevel Cap) (6 Tests)
  // =========================================================================
  {
    id: 'T1-A5-01',
    tier: 1,
    feature: 'A5: Pseudo-Pressure',
    title: 'maxLevel=4 maps 0.10->1, 0.30->2, 0.50->3, 0.70->4, and caps 0.90->4',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureMax4', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 4, { pageSession: mainPage });
        const forces = [0.1, 0.3, 0.5, 0.7, 0.9];
        for (let i = 0; i < forces.length; i++) {
          const f = forces[i];
          const y = 0.2 + i * 0.12;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.55, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 4);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=4 force=${f} -> size ${expected}`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A5-02',
    tier: 1,
    feature: 'A5: Pseudo-Pressure',
    title: 'maxLevel=5 maps all 5 fixed 20% buckets (0.10->1, 0.30->2, 0.50->3, 0.70->4, 0.90->5)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureMax5', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 5, { pageSession: mainPage });
        for (const [idx, f] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
          const y = 0.2 + idx * 0.12;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.55, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 5);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=5 force=${f} -> size ${expected}`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A5-03',
    tier: 1,
    feature: 'A5: Pseudo-Pressure',
    title: 'maxLevel=3 maps 0.10->1, 0.30->2, 0.50->3, and caps 0.70/0.90->3',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureMax3', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 3, { pageSession: mainPage });
        for (const [idx, f] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
          const y = 0.2 + idx * 0.12;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.55, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 3);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=3 force=${f} -> size ${expected}`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A5-04',
    tier: 1,
    feature: 'A5: Pseudo-Pressure',
    title: 'maxLevel=2 caps steps at 2 (0.10->1, 0.30->2, 0.90->2)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureMax2', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 2, { pageSession: mainPage });
        for (const [idx, f] of [0.1, 0.3, 0.9].entries()) {
          const y = 0.25 + idx * 0.15;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.55, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 2);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=2 force=${f} -> size ${expected}`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A5-05',
    tier: 1,
    feature: 'A5: Pseudo-Pressure',
    title: 'maxLevel=1 locks effective brush size to 1 across all forces (0.10, 0.50, 0.90)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureMax1', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 1, { pageSession: mainPage });
        for (const [idx, f] of [0.1, 0.5, 0.9].entries()) {
          const y = 0.25 + idx * 0.15;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.55, y)], { force: f });
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === 1, {
            timeoutMs: 3000,
            label: `maxLevel=1 force=${f} -> size 1`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A5-06',
    tier: 1,
    feature: 'A5: Pseudo-Pressure',
    title: 'Dynamic maxLevel switching mid-session persists multi-width Ink2 strokes on save',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureSave', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 5, { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.9 });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).size === 5, { timeoutMs: 3000, label: 'size 5' });

        await setPressureMaxLevel(pdfSession, 3, { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.5), normToPoint(rect, 0.6, 0.5)], { force: 0.9 });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).size === 3, { timeoutMs: 3000, label: 'capped size 3' });

        await mainPage.pressCtrlS();
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 6: Auto-Save Folder & Periodic Auto-Save (6 Tests)
  // =========================================================================
  {
    id: 'T1-A6-01',
    tier: 1,
    feature: 'A6: Auto-Save Folder & Periodic Save',
    title: 'Ctrl+S silently overwrites <saveDir>/<name>.pdf with zero dialog and zero .tmp',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'CtrlSNote', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        let dialogOpened = false;
        mainPage.on('Page.javascriptDialogOpening', () => {
          dialogOpened = true;
        });

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 5000, label: 'stroke' });

        await mainPage.pressCtrlS();
        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 5000, requireSizeIncrease: true });
        assert.equal(dialogOpened, false, 'Zero dialogs should open on Ctrl+S');
        assert.ok(updated.stat.size > stat0.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A6-02',
    tier: 1,
    feature: 'A6: Auto-Save Folder & Periodic Save',
    title: 'Toolbar Save button silently overwrites PDF on disk',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'BtnSaveNote', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.4), normToPoint(rect, 0.6, 0.4)], { force: 0.7 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 5000, label: 'stroke' });

        await clickControl(pdfSession, 'save', { pageSession: mainPage });
        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 5000, requireSizeIncrease: true });
        assert.ok(updated.stat.size > stat0.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A6-03',
    tier: 1,
    feature: 'A6: Auto-Save Folder & Periodic Save',
    title: 'Direct POST /api/save performs atomic overwrite with valid JSON response',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const bytes = createMinimalPdf({ pages: 2, label: 'AtomicDirect' });
        const res = await app.api.savePdf('atomic.pdf', bytes);
        assert.equal(res.status, 200, `POST /api/save failed: ${res.text}`);
        assert.equal(res.json?.saved, true);
        assert.equal(res.json?.name, 'atomic.pdf');
        assert.equal(res.json?.size, bytes.length);

        const onDisk = fs.readFileSync(path.join(app.saveDir, 'atomic.pdf'));
        assert.equal(sha256(onDisk), sha256(bytes));
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A6-04',
    tier: 1,
    feature: 'A6: Auto-Save Folder & Periodic Save',
    title: 'Periodic auto-save (--autosave-interval=2) overwrites disk automatically after stroke',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 2 });
      try {
        const created = await app.api.createNotebook({ title: 'PeriodicNote', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.35), normToPoint(rect, 0.7, 0.35)], { force: 0.5 });

        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6500, requireSizeIncrease: true });
        assert.ok(updated.stat.size > stat0.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A6-05',
    tier: 1,
    feature: 'A6: Auto-Save Folder & Periodic Save',
    title: 'Saved Ink2 annotations persist across page reload / reopen',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PersistReopen', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.7, 0.5)], { force: 0.6 });
        await mainPage.pressCtrlS();
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });

        await mainPage.navigate(`${app.baseUrl}/`);
        await sleep(300);
        await openPdfInMainWindow(app, created.json.url);
        const served = await app.api.getPdf(created.json.name);
        assert.equal(served.buffer.length, saved.stat.size, 'Reopened PDF must serve persisted annotated bytes');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A6-06',
    tier: 1,
    feature: 'A6: Auto-Save Folder & Periodic Save',
    title: 'Periodic auto-save skips redundant disk writes when document is clean',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 2 });
      try {
        const created = await app.api.createNotebook({ title: 'CleanIdle', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        await openPdfInMainWindow(app, created.json.url);
        const mtime0 = fs.statSync(filePath).mtimeMs;
        await sleep(3500);
        const mtime1 = fs.statSync(filePath).mtimeMs;
        assert.equal(mtime1, mtime0, 'Clean document should not trigger redundant disk writes');
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 7: Screen-Sharing Sub-Window ("[화면공유용] 판서 화면") (6 Tests)
  // =========================================================================
  {
    id: 'T1-A7-01',
    tier: 1,
    feature: 'A7: Screen-Sharing Sub-Window',
    title: 'Popup opens with exact Korean title "[화면공유용] 판서 화면"',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PresenterTitle', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPageTarget } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        assert.equal(presenterPageTarget.title, PRESENTER_TITLE);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A7-02',
    tier: 1,
    feature: 'A7: Screen-Sharing Sub-Window',
    title: 'Sub-window CSS hides ALL toolbars (pure PDF view)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PresenterPure', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        for (const sel of ['viewer-toolbar', '#crpdf-toolbar', '[data-crpdf-toolbar]', '#side-panel', '#bottom']) {
          const snap = await presenterPdf.queryDeep(sel);
          assert.ok(!snap.found || !snap.visible, `Sub-window must hide toolbar element ${sel}`);
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A7-03',
    tier: 1,
    feature: 'A7: Screen-Sharing Sub-Window',
    title: 'BroadcastChannel syncs page turns from main window to sub-window',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PageSync', template: 'lined', pageSize: 'a4', pages: 3 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        await attachBroadcastRecorder(presenterPdf, created.json.name);

        await goToPdfPage(pdfSession, 3);
        await waitFor(async () => (await getViewportState(presenterPdf)).page === 3, {
          timeoutMs: 4000,
          label: 'presenter synced to page 3',
        });

        const msgs = await readBroadcastRecorder(presenterPdf);
        assert.ok(msgs.some((m) => m?.type === 'viewport' && m.page === 3), 'Expected viewport BroadcastChannel message for page 3');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A7-04',
    tier: 1,
    feature: 'A7: Screen-Sharing Sub-Window',
    title: 'BroadcastChannel syncs zoom & scroll from main window to sub-window',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ZoomScrollSync', template: 'grid', pageSize: 'a4', pages: 2 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        await setPdfZoom(pdfSession, 1.5);
        await waitFor(async () => Math.abs((await getViewportState(presenterPdf)).zoom - 1.5) <= 0.1, {
          timeoutMs: 4000,
          label: 'presenter zoom synced to 1.5',
        });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A7-05',
    tier: 1,
    feature: 'A7: Screen-Sharing Sub-Window',
    title: 'Live ink mirroring canvas (#crpdf-ink-mirror) renders non-empty pixels on main pen stroke',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'InkMirror', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const before = await getMirrorCanvasStats(presenterPdf);
        assert.equal(before.found, true, 'Expected #crpdf-ink-mirror canvas in presenter');
        assert.equal(before.nonZeroPixels, 0, 'Mirror canvas should start empty');

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.7, 0.3)], { force: 0.6 });

        const after = await waitFor(
          async () => {
            const st = await getMirrorCanvasStats(presenterPdf);
            return st.nonZeroPixels > 20 ? st : null;
          },
          { timeoutMs: 4000, label: 'mirror canvas pixels > 20' },
        );
        assert.ok(after.nonZeroPixels > 20);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A7-06',
    tier: 1,
    feature: 'A7: Screen-Sharing Sub-Window',
    title: 'Undo in main window syncs ink_action to sub-window live mirror canvas',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'UndoMirror', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.7, 0.3)], { force: 0.6 });
        await waitFor(async () => (await getMirrorCanvasStats(presenterPdf)).nonZeroPixels > 20, {
          timeoutMs: 4000,
          label: 'mirror stroke rendered',
        });

        await clickControl(pdfSession, 'undo', { pageSession: mainPage });
        await waitFor(async () => (await getMirrorCanvasStats(presenterPdf)).nonZeroPixels === 0, {
          timeoutMs: 4000,
          label: 'mirror canvas cleared after undo',
        });
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 8: Dual-Window Input Separation & Bidirectional Red Laser Pointer (6 Tests)
  // =========================================================================
  {
    id: 'T1-A8-01',
    tier: 1,
    feature: 'A8: Dual-Window Input & Laser Pointer',
    title: 'Sub-window mouse drag creates ZERO Ink2 ink on presenter or main window',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'SubNoInk', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const pRect = await getPdfPageRect(presenterPdf);
        await presenterPage.dispatchMouseDrag([normToPoint(pRect, 0.25, 0.35), normToPoint(pRect, 0.7, 0.65)]);
        await sleep(300);

        assert.equal((await getUndoState(pdfSession)).disabled, true, 'Sub-window drag must NOT draw ink on main');
        assert.equal((await getMirrorCanvasStats(presenterPdf)).nonZeroPixels, 0, 'Sub-window drag must NOT draw ink on mirror');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A8-02',
    tier: 1,
    feature: 'A8: Dual-Window Input & Laser Pointer',
    title: 'Sub-window mouse move displays glowing red laser dot at (50%, 50%)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserSub', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const pRect = await getPdfPageRect(presenterPdf);
        const pt = normToPoint(pRect, 0.5, 0.5);
        await presenterPage.dispatchMouseMove(pt.x, pt.y);

        const laser = await waitFor(
          async () => {
            const st = await getLaserState(presenterPdf);
            return st.visible ? st : null;
          },
          { timeoutMs: 3000, label: 'presenter red laser dot visible' },
        );
        assert.ok(laser.rgb && laser.rgb.r > 180 && laser.rgb.g < 80 && laser.rgb.b < 80, `Expected red laser, got ${laser.backgroundColor}`);
        assert.ok(Math.abs(laser.xPct - 50) <= 4 && Math.abs(laser.yPct - 50) <= 4, `Laser pos mismatch: (${laser.xPct}, ${laser.yPct})`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A8-03',
    tier: 1,
    feature: 'A8: Dual-Window Input & Laser Pointer',
    title: 'Sub-window -> Main window laser coordinates sync via BroadcastChannel',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserSubToMain', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        await attachBroadcastRecorder(pdfSession, created.json.name);

        const pRect = await getPdfPageRect(presenterPdf);
        const pt = normToPoint(pRect, 0.25, 0.75);
        await presenterPage.dispatchMouseMove(pt.x, pt.y);

        const mainLaser = await waitFor(
          async () => {
            const st = await getLaserState(pdfSession);
            return st.visible ? st : null;
          },
          { timeoutMs: 3000, label: 'main laser visible from presenter' },
        );
        assert.ok(Math.abs(mainLaser.xPct - 25) <= 4 && Math.abs(mainLaser.yPct - 75) <= 4);
        const msgs = await readBroadcastRecorder(pdfSession);
        assert.ok(msgs.some((m) => m?.type === 'laser' && m.visible === true));
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A8-04',
    tier: 1,
    feature: 'A8: Dual-Window Input & Laser Pointer',
    title: 'Main window -> Sub-window bidirectional laser sync updates presenter overlay',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserMainToSub', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        // Broadcast laser event from main origin via BroadcastChannel protocol
        await pdfSession.evaluate(`(() => {
          const ch = new BroadcastChannel(${JSON.stringify(`crpdf-sync:${created.json.name}`)});
          ch.postMessage({ type: 'laser', role: 'main', visible: true, xPct: 70, yPct: 30, page: 1, senderId: 'main-e2e', ts: Date.now() });
          ch.close();
        })()`);

        const subLaser = await waitFor(
          async () => {
            const st = await getLaserState(presenterPdf);
            return st.visible && Math.abs(st.xPct - 70) <= 4 && Math.abs(st.yPct - 30) <= 4 ? st : null;
          },
          { timeoutMs: 3000, label: 'presenter laser synced to (70%, 30%)' },
        );
        assert.equal(subLaser.visible, true);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A8-05',
    tier: 1,
    feature: 'A8: Dual-Window Input & Laser Pointer',
    title: 'Laser pointer hides on mouseleave in both presenter and main windows',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserLeave', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const pRect = await getPdfPageRect(presenterPdf);
        const center = normToPoint(pRect, 0.5, 0.5);
        await presenterPage.dispatchMouseMove(center.x, center.y);
        await waitFor(async () => (await getLaserState(pdfSession)).visible, { timeoutMs: 3000, label: 'laser visible' });

        await presenterPdf.evaluate(`(() => {
          const target = document.querySelector('#crpdf-laser-overlay') || document.body || document.documentElement;
          target.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
          document.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        })()`);

        await waitFor(
          async () => !(await getLaserState(presenterPdf)).visible && !(await getLaserState(pdfSession)).visible,
          { timeoutMs: 3000, label: 'laser hidden in both windows' },
        );
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T1-A8-06',
    tier: 1,
    feature: 'A8: Dual-Window Input & Laser Pointer',
    title: 'Main stylus draws real Ink2 while sub-window simultaneously tracks laser pointer',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'DualInput', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const mRect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(mRect, 0.2, 0.3), normToPoint(mRect, 0.6, 0.3)], { force: 0.5 });

        const pRect = await getPdfPageRect(presenterPdf);
        const lpt = normToPoint(pRect, 0.6, 0.65);
        await presenterPage.dispatchMouseMove(lpt.x, lpt.y);

        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: 'main ink recorded' });
        await waitFor(async () => (await getMirrorCanvasStats(presenterPdf)).nonZeroPixels > 20, { timeoutMs: 4000, label: 'presenter mirrored ink' });
        await waitFor(async () => (await getLaserState(presenterPdf)).visible && (await getLaserState(pdfSession)).visible, {
          timeoutMs: 4000,
          label: 'red laser visible on both windows',
        });
      } finally {
        await app.stop();
      }
    },
  },
];
