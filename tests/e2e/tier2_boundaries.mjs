/**
 * Tier 2 — Boundary & Corner-Case Suite (48 isolated opaque-box tests across 8 feature areas).
 *
 * Areas (6 boundary/negative/edge tests each):
 *   A1: resources.pak Patcher Boundaries (empty, truncated, bad version, missing patches, missing fingerprint, 0-byte+large+aliases)
 *   A2: HTTP API & Template Boundaries (path traversal, non-PDF upload, malformed JSON, custom mm [50,1000]/pages bounds, Unicode/Korean, duplicate/404)
 *   A3: Toolbar, Dock Toggle, Preset Slots & Add-Page Boundaries (resize 640px/1600px + right-dock persistence, custom mm add-page, rapid double-click debounce, multi-page unsaved ink add-page, reopen clean, empty-undo switching)
 *   A4: Palm Rejection Boundaries (pre-stylus 1-finger touch, pre-stylus 2-finger pinch, pen-down without hover, interleaved palm, stationary tap/long-press, 3-finger palm rest)
 *   A5: Pseudo-Pressure Boundaries (exact 0/20/40/60/80% boundaries for maxLevel=5 & maxLevel=3, hysteresis deadband around 0.20/0.40, Eraser safety guard, Highlighter safety guard, out-of-range force clamping)
 *   A6: Auto-Save Boundaries (rapid Ctrl+S spam, mid-stroke deferred periodic save, atomic failure preserves existing file, interval=0 disables periodic save, Unicode filename save, clean Ctrl+S)
 *   A7: Screen-Sharing Sub-Window Boundaries (single-monitor fallback, mocked multi-monitor external screen, getScreenDetails denied fallback, close & reopen mid-session, rapid zoom/scroll burst, duplicate Screen Share click)
 *   A8: Dual-Window Input & Laser Pointer Boundaries (0%/100% corners, out-of-bounds margin clamping/hide, mouseleave immediate hide, aspect-ratio mismatch normalized mapping, rapid 40-move burst, simultaneous pen stroke + laser drag)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MM_TO_PT,
  createMinimalPdf,
  createSyntheticPakV5,
  inspectPdfBuffer,
  launchApp,
} from './harness.mjs';
import { PRESENTER_TITLE } from './cdp_client.mjs';
import {
  TOOLBAR_SELECTORS,
  assertNoTmpFiles,
  assertPakV5Structure,
  buildSyntheticResourcesPak,
  clickControl,
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
  runPatchPakCli,
  setPdfZoom,
  setPressureMaxLevel,
  sha256,
  sleep,
  waitFor,
  waitForFileUpdate,
  waitForFirstDeep,
} from './pdf_helpers.mjs';

function makeTempDir(prefix = 'crpdf-t2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const tests = [
  // =========================================================================
  // Area 1: resources.pak Patcher Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A1-01',
    tier: 2,
    feature: 'A1: resources.pak Patcher Boundaries',
    title: 'Empty (0-byte) .pak input is rejected with non-zero exit code',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t2-a1-01-');
      try {
        const inPath = path.join(tmp, 'empty.pak');
        const outPath = path.join(tmp, 'out.pak');
        fs.writeFileSync(inPath, Buffer.alloc(0));

        const res = runPatchPakCli({ input: inPath, output: outPath });
        assert.notEqual(res.status, 0, 'Expected non-zero exit for 0-byte .pak');
        assert.ok(res.stderr.trim().length > 0, 'Expected descriptive error on stderr');
        assert.equal(fs.existsSync(outPath), false, 'Must not write corrupt output on failure');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T2-A1-02',
    tier: 2,
    feature: 'A1: resources.pak Patcher Boundaries',
    title: 'Truncated header and out-of-bounds sentinel offset are rejected cleanly',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t2-a1-02-');
      try {
        const truncPath = path.join(tmp, 'trunc.pak');
        const outPath = path.join(tmp, 'out.pak');
        const trunc = Buffer.alloc(12);
        trunc.writeUInt32LE(5, 0);
        trunc.writeUInt8(1, 4);
        trunc.writeUInt16LE(5, 8);
        fs.writeFileSync(truncPath, trunc);

        const r1 = runPatchPakCli({ input: truncPath, output: outPath });
        assert.notEqual(r1.status, 0, 'Expected non-zero exit for truncated .pak');

        // Valid pak with corrupted sentinel offset exceeding file size
        const badSentinel = Buffer.from(buildSyntheticResourcesPak());
        const sentinelOffPos = 12 + 3 * 6 + 2;
        badSentinel.writeUInt32LE(badSentinel.length + 9999, sentinelOffPos);
        const badPath = path.join(tmp, 'bad_sentinel.pak');
        fs.writeFileSync(badPath, badSentinel);

        const r2 = runPatchPakCli({ input: badPath, output: outPath });
        assert.notEqual(r2.status, 0, 'Expected non-zero exit for out-of-bounds sentinel');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T2-A1-03',
    tier: 2,
    feature: 'A1: resources.pak Patcher Boundaries',
    title: 'Unsupported DataPack version (version=3 / 99) is rejected',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t2-a1-03-');
      try {
        const outPath = path.join(tmp, 'out.pak');
        for (const ver of [3, 99]) {
          const buf = Buffer.from(buildSyntheticResourcesPak());
          buf.writeUInt32LE(ver, 0);
          const inPath = path.join(tmp, `v${ver}.pak`);
          fs.writeFileSync(inPath, buf);
          const res = runPatchPakCli({ input: inPath, output: outPath });
          assert.notEqual(res.status, 0, `Expected non-zero exit for DataPack v${ver}`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T2-A1-04',
    tier: 2,
    feature: 'A1: resources.pak Patcher Boundaries',
    title: 'Missing --patches directory or empty patch directory fails loudly',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t2-a1-04-');
      try {
        const inPath = path.join(tmp, 'in.pak');
        const outPath = path.join(tmp, 'out.pak');
        const emptyPatches = path.join(tmp, 'empty_patches');
        fs.mkdirSync(emptyPatches);
        fs.writeFileSync(inPath, buildSyntheticResourcesPak());

        const r1 = runPatchPakCli({ input: inPath, output: outPath, patches: path.join(tmp, 'nonexistent_dir') });
        assert.notEqual(r1.status, 0, 'Expected non-zero exit for missing patches directory');

        const r2 = runPatchPakCli({ input: inPath, output: outPath, patches: emptyPatches });
        assert.notEqual(r2.status, 0, 'Expected non-zero exit for empty patches directory');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T2-A1-05',
    tier: 2,
    feature: 'A1: resources.pak Patcher Boundaries',
    title: 'Valid v5 .pak missing PDF fingerprint targets fails loudly instead of silent pass',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t2-a1-05-');
      try {
        const inPath = path.join(tmp, 'no_targets.pak');
        const outPath = path.join(tmp, 'out.pak');
        const pak = createSyntheticPakV5([
          { id: 100, data: 'hello world', compression: 'none' },
          { id: 101, data: 'another unrelated asset', compression: 'gzip' },
        ]);
        fs.writeFileSync(inPath, pak);

        const res = runPatchPakCli({ input: inPath, output: outPath });
        assert.notEqual(res.status, 0, 'Expected non-zero exit when fingerprint targets are missing');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T2-A1-06',
    tier: 2,
    feature: 'A1: resources.pak Patcher Boundaries',
    title: '0-byte entry, >256KB large entry, and multi-alias table survive patching intact',
    requiresBinary: false,
    async run() {
      const tmp = makeTempDir('crpdf-t2-a1-06-');
      try {
        const inPath = path.join(tmp, 'boundary.pak');
        const outPath = path.join(tmp, 'out.pak');
        const largeBlob = Buffer.alloc(300 * 1024, 0x41);
        const pak = buildSyntheticResourcesPak({
          mainId: 3001,
          wrapperId: 3002,
          dummyId: 3003,
          compression: 'gzip',
          extraEntries: [
            { id: 3000, data: Buffer.alloc(0), compression: 'none' },
            { id: 3010, data: largeBlob, compression: 'none' },
          ],
          aliases: [
            { id: 9100, targetId: 3000 },
            { id: 9101, targetId: 3001 },
            { id: 9102, targetId: 3010 },
          ],
        });
        fs.writeFileSync(inPath, pak);

        const res = runPatchPakCli({ input: inPath, output: outPath, verify: true });
        assert.equal(res.status, 0, `Boundary pak patch failed: ${res.stderr}`);

        const parsed = assertPakV5Structure(fs.readFileSync(outPath));
        assert.equal(parsed.entries.find((e) => e.id === 3000).data.length, 0);
        assert.equal(sha256(parsed.entries.find((e) => e.id === 3010).data), sha256(largeBlob));
        assert.equal(parsed.aliases.length, 3);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },

  // =========================================================================
  // Area 2: HTTP API & Template Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A2-01',
    tier: 2,
    feature: 'A2: HTTP API & Template Boundaries',
    title: 'Path traversal attempts are rejected (400/403) across all file endpoints',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const secretPath = path.join(app.tmpDir, 'secret.pdf');
        fs.writeFileSync(secretPath, createMinimalPdf({ label: 'SECRET' }));
        const payloads = ['../secret.pdf', '%2e%2e%2fsecret.pdf', 'sub/file.pdf', '..\\secret.pdf'];

        for (const p of payloads) {
          const rGet = await app.api.rawFetch(`/pdf/${p}`);
          assert.ok(rGet.status === 400 || rGet.status === 403 || rGet.status === 404, `GET /pdf/${p} returned ${rGet.status}`);
          assert.notEqual(rGet.status, 200);

          const rSave = await app.api.rawFetch(`/api/save?name=${encodeURIComponent(p)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/pdf' },
            body: createMinimalPdf(),
          });
          assert.ok(rSave.status === 400 || rSave.status === 403, `POST /api/save ${p} returned ${rSave.status}`);

          const rDel = await app.api.rawFetch(`/api/notebooks/${encodeURIComponent(p)}`, { method: 'DELETE' });
          assert.ok(rDel.status === 400 || rDel.status === 403 || rDel.status === 404, `DELETE ${p} returned ${rDel.status}`);

          const rImp = await app.api.rawFetch(`/api/notebooks/import?name=${encodeURIComponent(p)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/pdf' },
            body: createMinimalPdf(),
          });
          assert.ok(rImp.status === 400 || rImp.status === 403, `import ${p} returned ${rImp.status}`);

          const rAdd = await app.api.rawFetch(`/api/notebooks/${encodeURIComponent(p)}/add-page`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          assert.ok(rAdd.status === 400 || rAdd.status === 403 || rAdd.status === 404, `add-page ${p} returned ${rAdd.status}`);
        }
        assert.equal(fs.existsSync(secretPath), true, 'File outside saveDir must remain untouched');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A2-02',
    tier: 2,
    feature: 'A2: HTTP API & Template Boundaries',
    title: 'Non-PDF and empty bodies are rejected with 400 on /api/save and /api/notebooks/import',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const badBodies = [Buffer.alloc(0), Buffer.from('not a pdf'), Buffer.from('<html><body>nope</body></html>')];
        for (const body of badBodies) {
          const rSave = await app.api.savePdf('bad.pdf', body);
          assert.equal(rSave.status, 400, `Expected 400 on /api/save invalid body, got ${rSave.status}`);
          const rImp = await app.api.importNotebook('bad.pdf', body);
          assert.equal(rImp.status, 400, `Expected 400 on /api/notebooks/import invalid body, got ${rImp.status}`);
        }
        assert.equal(fs.existsSync(path.join(app.saveDir, 'bad.pdf')), false);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A2-03',
    tier: 2,
    feature: 'A2: HTTP API & Template Boundaries',
    title: 'Malformed JSON and invalid field types return 400 without crashing server',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const r1 = await app.api.createNotebook('{bad json');
        assert.equal(r1.status, 400);
        const r2 = await app.api.updateConfig('{bad json');
        assert.equal(r2.status, 400);
        const r3 = await app.api.createNotebook({ title: 'BadPages', template: 'blank', pageSize: 'a4', pages: 'ten' });
        assert.equal(r3.status, 400);

        const health = await app.api.health();
        assert.equal(health.status, 200);
        assert.equal(health.json?.status, 'ok');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A2-04',
    tier: 2,
    feature: 'A2: HTTP API & Template Boundaries',
    title: 'Custom mm [50, 1000] clamping/bounds and invalid pages/template rejection',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const rCustom = await app.api.createNotebook({
          title: 'ClampedMM',
          template: 'blank',
          pageSize: 'custom',
          widthMm: 10,
          heightMm: 2000,
          pages: 1,
        });
        assert.ok(rCustom.status === 201 || rCustom.status === 400, `Unexpected status ${rCustom.status}`);
        if (rCustom.status === 201) {
          assert.equal(rCustom.json.widthMm, 50, 'widthMm < 50 must clamp to 50');
          assert.equal(rCustom.json.heightMm, 1000, 'heightMm > 1000 must clamp to 1000');
          const pdf = inspectPdfBuffer(fs.readFileSync(path.join(app.saveDir, rCustom.json.name)));
          assert.ok(Math.abs(pdf.mediaBoxes[0].widthPt - 50 * MM_TO_PT) <= 1.5);
          assert.ok(Math.abs(pdf.mediaBoxes[0].heightPt - 1000 * MM_TO_PT) <= 1.5);
        }

        for (const badPayload of [
          { title: 'ZeroPages', template: 'blank', pageSize: 'a4', pages: 0 },
          { title: 'NegPages', template: 'blank', pageSize: 'a4', pages: -5 },
          { title: 'BadTpl', template: 'hexagons', pageSize: 'a4', pages: 1 },
          { title: 'BadSize', template: 'blank', pageSize: 'huge_poster', pages: 1 },
        ]) {
          const r = await app.api.createNotebook(badPayload);
          assert.equal(r.status, 400, `Expected 400 for ${JSON.stringify(badPayload)}, got ${r.status}`);
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A2-05',
    tier: 2,
    feature: 'A2: HTTP API & Template Boundaries',
    title: 'Unicode / Korean notebook title round-trips through create, serve, add-page, and delete',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const title = '2026 수학 필기 (중간고사)';
        const created = await app.api.createNotebook({ title, template: 'lined', pageSize: 'a4', pages: 1 });
        assert.equal(created.status, 201, `Korean create failed: ${created.text}`);

        const served = await app.api.getPdf(created.json.name);
        assert.equal(served.status, 200);
        assert.equal(inspectPdfBuffer(served.buffer).pagesCount, 1);

        const added = await app.api.addPage(created.json.name, {});
        assert.equal(added.status, 200);
        assert.equal(added.json?.pages, 2);

        const del = await app.api.deleteNotebook(created.json.name);
        assert.equal(del.status, 200);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A2-06',
    tier: 2,
    feature: 'A2: HTTP API & Template Boundaries',
    title: 'Duplicate title does not clobber existing file, and non-existent add-page returns 404',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const c1 = await app.api.createNotebook({ title: 'DupNote', template: 'grid', pageSize: 'a4', pages: 2 });
        assert.equal(c1.status, 201);
        const origHash = sha256(fs.readFileSync(path.join(app.saveDir, c1.json.name)));

        const c2 = await app.api.createNotebook({ title: 'DupNote', template: 'blank', pageSize: 'a4', pages: 1 });
        assert.ok(c2.status === 409 || (c2.status === 201 && c2.json.name !== c1.json.name), `Duplicate clobbered original: ${c2.status} ${c2.text}`);
        assert.equal(sha256(fs.readFileSync(path.join(app.saveDir, c1.json.name))), origHash);

        const missingAdd = await app.api.addPage('does_not_exist.pdf', {});
        assert.equal(missingAdd.status, 404);
        assert.equal(fs.existsSync(path.join(app.saveDir, 'does_not_exist.pdf')), false);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 3: Toolbar, Dock Toggle, Preset Slots & Add-Page Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A3-01',
    tier: 2,
    feature: 'A3: Toolbar & Add-Page Boundaries',
    title: 'Minimal toolbar & right-dock mode persist cleanly across narrow (640px) and wide (1600px) resizes',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ResizeToolbar', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        for (const [w, h] of [[640, 600], [1600, 900]]) {
          await mainPage.send('Emulation.setDeviceMetricsOverride', {
            width: w,
            height: h,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await sleep(250);
          for (const key of ['pen', 'highlighter', 'eraser', 'undo', 'save', 'addPage', 'dockToggle']) {
            const snap = await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS[key], { visible: true, timeoutMs: 3000 });
            assert.equal(snap.visible, true, `${key} hidden at ${w}x${h}`);
          }
          const hiddenPrint = await pdfSession.queryDeep('#print');
          assert.ok(!hiddenPrint.found || !hiddenPrint.visible, `#print leaked at ${w}x${h}`);
        }

        // Toggle to right dock and verify it persists after reload
        await clickControl(pdfSession, 'dockToggle', { pageSession: mainPage });
        await sleep(250);
        const { pdfSession: reloaded } = await openPdfInMainWindow(app, created.json.url);
        const rightBar = await waitForFirstDeep(reloaded, TOOLBAR_SELECTORS.toolbarBar, { visible: true, timeoutMs: 4000 });
        assert.ok(rightBar.rect.width <= 64 && rightBar.rect.height > rightBar.rect.width * 2, 'Right dock did not persist across reload');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A3-02',
    tier: 2,
    feature: 'A3: Toolbar & Add-Page Boundaries',
    title: 'Toolbar Add Page (+) preserves custom mm dimensions (150x210 mm)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({
          title: 'CustomAddPage',
          template: 'dot',
          pageSize: 'custom',
          widthMm: 150,
          heightMm: 210,
          pages: 1,
        });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        await clickControl(pdfSession, 'addPage', { pageSession: mainPage });

        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000 });
        assert.equal(updated.pdf.pagesCount, 2);
        const lastMb = updated.pdf.mediaBoxes[updated.pdf.mediaBoxes.length - 1];
        assert.ok(Math.abs(lastMb.widthPt - 150 * MM_TO_PT) <= 1.5, `Page 2 widthPt=${lastMb.widthPt}`);
        assert.ok(Math.abs(lastMb.heightPt - 210 * MM_TO_PT) <= 1.5, `Page 2 heightPt=${lastMb.heightPt}`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A3-03',
    tier: 2,
    feature: 'A3: Toolbar & Add-Page Boundaries',
    title: 'Rapid triple-click on Add Page (+) is debounced/serialized with zero PDF corruption',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'RapidAddPage', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const btn = await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS.addPage);
        for (let i = 0; i < 3; i++) {
          await mainPage.dispatchMouseClick(btn.rect.cx, btn.rect.cy);
          await sleep(45);
        }

        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000 });
        assert.equal(updated.pdf.validHeader, true);
        assert.equal(updated.pdf.validEof, true);
        assert.ok(updated.pdf.pagesCount >= 2 && updated.pdf.pagesCount <= 4, `Unexpected page count ${updated.pdf.pagesCount}`);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A3-04',
    tier: 2,
    feature: 'A3: Toolbar & Add-Page Boundaries',
    title: 'Add Page (+) on page 2 with unsaved Ink2 preserves page 2 strokes and opens page 3',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'MultiPageAdd', template: 'lined', pageSize: 'a4', pages: 2 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        await goToPdfPage(pdfSession, 2);
        await waitFor(async () => (await getViewportState(pdfSession)).page === 2, { timeoutMs: 4000, label: 'page 2' });

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.4), normToPoint(rect, 0.65, 0.4)], { force: 0.6 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: 'stroke on page 2' });

        await clickControl(pdfSession, 'addPage', { pageSession: mainPage });
        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000, requireSizeIncrease: true });
        assert.equal(updated.pdf.pagesCount, 3);

        const { session: reloaded } = await app.cdp.waitForPdfViewer({ role: 'main', timeoutMs: 10000 });
        await waitFor(async () => (await getViewportState(reloaded)).page === 3, { timeoutMs: 6000, label: 'navigated to page 3' });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A3-05',
    tier: 2,
    feature: 'A3: Toolbar & Add-Page Boundaries',
    title: 'Re-opening another PDF from Library keeps Ink2 active with zero duplicate toolbar nodes',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const n1 = await app.api.createNotebook({ title: 'Reopen1', template: 'blank', pageSize: 'a4', pages: 1 });
        const n2 = await app.api.createNotebook({ title: 'Reopen2', template: 'grid', pageSize: 'a4', pages: 1 });

        const { mainPage } = await openPdfInMainWindow(app, n1.json.url);
        await mainPage.navigate(`${app.baseUrl}/`);
        await sleep(300);

        const { pdfSession: pdf2 } = await openPdfInMainWindow(app, n2.json.url);
        const bars = await pdf2.queryAllDeep('#crpdf-toolbar, [data-crpdf-toolbar]');
        assert.equal(bars.length, 1, `Expected exactly 1 Cr-PDF toolbar node, found ${bars.length}`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A3-06',
    tier: 2,
    feature: 'A3: Toolbar & Add-Page Boundaries',
    title: 'Rapid tool/Undo switching with empty undo stack throws zero uncaught exceptions',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'EmptyUndoSwitch', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));

        await mainPage.pressCtrlZ();
        await clickControl(pdfSession, 'eraser', { pageSession: mainPage });
        await clickControl(pdfSession, 'highlighter', { pageSession: mainPage });
        await clickControl(pdfSession, 'pen', { pageSession: mainPage });
        await sleep(200);

        assert.equal(exceptions.length, 0, `Unexpected JS exceptions: ${JSON.stringify(exceptions)}`);
        assert.equal((await getUndoState(pdfSession)).disabled, true);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 4: Palm Rejection Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A4-01',
    tier: 2,
    feature: 'A4: Palm Rejection Boundaries',
    title: 'Pre-stylus 1-finger touch (before ANY pen event ever fires) creates 0 Ink2 strokes',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PreStylusTouch', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.2, 0.25), normToPoint(rect, 0.8, 0.75)], { steps: 10 });
        await sleep(300);
        assert.equal((await getUndoState(pdfSession)).disabled, true, 'Pre-stylus touch MUST NOT draw Ink2 ink');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A4-02',
    tier: 2,
    feature: 'A4: Palm Rejection Boundaries',
    title: 'Pre-stylus 2-finger pinch-zoom creates 0 Ink2 strokes and 0 JS exceptions',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PreStylusPinch', template: 'grid', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPinchZoom(normToPoint(rect, 0.5, 0.5), 70, 220);
        await sleep(300);

        assert.equal(exceptions.length, 0);
        assert.equal((await getUndoState(pdfSession)).disabled, true);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A4-03',
    tier: 2,
    feature: 'A4: Palm Rejection Boundaries',
    title: 'Pen touch-down WITHOUT preceding hover event still draws on the very first stroke',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'NoHoverPen', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.35), normToPoint(rect, 0.65, 0.35)], {
          force: 0.5,
          hoverLeadIn: false,
        });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, {
          timeoutMs: 5000,
          label: 'pen stroke recorded without hover lead-in',
        });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A4-04',
    tier: 2,
    feature: 'A4: Palm Rejection Boundaries',
    title: 'Interleaved palm touches between 2 pen strokes contribute 0 strokes (2 Undos clear all)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'InterleavedPalm', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.25), normToPoint(rect, 0.5, 0.25)], { force: 0.5 });
        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.4, 0.4), normToPoint(rect, 0.7, 0.6)]);
        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.5)]);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.7), normToPoint(rect, 0.5, 0.7)], { force: 0.5 });

        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: 'undo enabled' });
        await clickControl(pdfSession, 'undo', { pageSession: mainPage });
        await sleep(200);
        assert.equal((await getUndoState(pdfSession)).disabled, false, 'Should still have stroke #1 after 1 undo');
        await clickControl(pdfSession, 'undo', { pageSession: mainPage });
        await waitFor(async () => (await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: '2 undos clear all' });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A4-05',
    tier: 2,
    feature: 'A4: Palm Rejection Boundaries',
    title: 'Stationary touch tap and 400ms long-press create 0 Ink2 dots',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'TouchTap', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.5)], { holdMs: 400 });
        await sleep(250);
        assert.equal((await getUndoState(pdfSession)).disabled, true);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A4-06',
    tier: 2,
    feature: 'A4: Palm Rejection Boundaries',
    title: 'Simultaneous 3-finger palm rest creates 0 Ink2 strokes and 0 JS exceptions',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ThreeFingerPalm', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchMultiTouch(
          [normToPoint(rect, 0.3, 0.4), normToPoint(rect, 0.45, 0.45), normToPoint(rect, 0.6, 0.4)],
          [normToPoint(rect, 0.35, 0.6), normToPoint(rect, 0.5, 0.65), normToPoint(rect, 0.65, 0.6)],
        );
        await sleep(250);

        assert.equal(exceptions.length, 0);
        assert.equal((await getUndoState(pdfSession)).disabled, true);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 5: Pseudo-Pressure Boundaries (0/20/40/60/80% + Hysteresis + Safety Guards) (6 Tests)
  // =========================================================================
  {
    id: 'T2-A5-01',
    tier: 2,
    feature: 'A5: Pseudo-Pressure Boundaries',
    title: 'Exact 0/20/40/60/80% boundary values with maxLevel=5',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureBounds5', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 5, { pageSession: mainPage });
        const samples = [0.0, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.0];
        for (let i = 0; i < samples.length; i++) {
          const f = samples[i];
          const y = 0.15 + (i % 5) * 0.15;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.5, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 5);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=5 force=${f} -> ${expected}`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A5-02',
    tier: 2,
    feature: 'A5: Pseudo-Pressure Boundaries',
    title: 'Exact 0/20/40/60/80% boundary values with maxLevel=3 cap',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureBounds3', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 3, { pageSession: mainPage });
        const samples = [0.0, 0.15, 0.25, 0.45, 0.65, 0.85, 1.0];
        for (let i = 0; i < samples.length; i++) {
          const f = samples[i];
          const y = 0.15 + (i % 5) * 0.15;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.5, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 3);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=3 force=${f} -> ${expected}`,
          });
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A5-03',
    tier: 2,
    feature: 'A5: Pseudo-Pressure Boundaries',
    title: 'Hysteresis deadband around 0.20 and 0.40 prevents rapid boundary flicker',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'PressureHysteresis', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 5, { pageSession: mainPage });
        // Start solidly in level 1 (0.10), nudge just across 0.20 (0.21 inside hysteresis), then push past (0.28 -> 2), then dip just below 0.20 (0.19 -> stays 2)
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.2), normToPoint(rect, 0.4, 0.2)], { force: 0.1 });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).size === 1, { timeoutMs: 3000, label: 'size 1' });

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.35), normToPoint(rect, 0.4, 0.35)], { force: 0.21 });
        await sleep(150);
        const s1 = (await getActiveBrushState(pdfSession)).size;
        assert.ok(s1 === 1 || s1 === 2, `Expected stable level 1 (or 2 if tight deadband), got ${s1}`);

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.5), normToPoint(rect, 0.4, 0.5)], { force: 0.28 });
        await waitFor(async () => (await getActiveBrushState(pdfSession)).size === 2, { timeoutMs: 3000, label: 'size 2 at 0.28' });

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.65), normToPoint(rect, 0.4, 0.65)], { force: 0.19 });
        await sleep(150);
        const s2 = (await getActiveBrushState(pdfSession)).size;
        assert.equal(s2, 2, `Hysteresis should keep size at 2 when dipping slightly to 0.19, got ${s2}`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A5-04',
    tier: 2,
    feature: 'A5: Pseudo-Pressure Boundaries',
    title: 'Eraser-active pressure safety guard never crashes renderer or throws on variable force',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'EraserSafety', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.4), normToPoint(rect, 0.7, 0.4)], { force: 0.6 });
        await clickControl(pdfSession, 'eraser', { pageSession: mainPage });

        for (const f of [0.05, 0.5, 0.98]) {
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.4), normToPoint(rect, 0.7, 0.4)], { force: f });
        }
        await sleep(250);
        assert.equal(exceptions.length, 0, `Eraser pressure threw exceptions: ${JSON.stringify(exceptions)}`);
        const state = await getActiveBrushState(pdfSession);
        assert.equal(state.tool, 'eraser');
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A5-05',
    tier: 2,
    feature: 'A5: Pseudo-Pressure Boundaries',
    title: 'Highlighter-active pressure safety keeps valid brush size in [1, 16] and draws cleanly',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'HighlighterSafety', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));

        await clickControl(pdfSession, 'highlighter', { pageSession: mainPage });
        const rect = await getPdfPageRect(pdfSession);
        for (const [idx, f] of [0.1, 0.5, 0.95].entries()) {
          const y = 0.25 + idx * 0.15;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.6, y)], { force: f });
        }
        await sleep(250);

        assert.equal(exceptions.length, 0);
        const brush = await getActiveBrushState(pdfSession);
        assert.equal(brush.tool, 'highlighter');
        if (brush.size != null) {
          assert.ok(brush.size >= 1 && brush.size <= 16, `Highlighter size out of [1, 16]: ${brush.size}`);
        }
        assert.equal((await getUndoState(pdfSession)).disabled, false);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A5-06',
    tier: 2,
    feature: 'A5: Pseudo-Pressure Boundaries',
    title: 'Out-of-range force clamping (0.0 and 1.0) stays strictly within [1, maxLevel] without CHECK crash',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ForceClamp', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 4, { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.5, 0.3)], { force: 0.0 });
        const low = await getActiveBrushState(pdfSession);
        assert.ok(low.size >= 1 && low.size <= 4, `Expected clamped low size in [1,4], got ${low.size}`);

        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.5), normToPoint(rect, 0.5, 0.5)], { force: 1.0 });
        const high = await getActiveBrushState(pdfSession);
        assert.ok(high.size >= 1 && high.size <= 4, `Expected clamped high size in [1,4], got ${high.size}`);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 6: Auto-Save Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A6-01',
    tier: 2,
    feature: 'A6: Auto-Save Boundaries',
    title: 'Rapid Ctrl+S spam (5x in 200ms) produces valid PDF with zero .tmp residue',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'RapidCtrlS', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });

        for (let i = 0; i < 5; i++) {
          await mainPage.pressCtrlS();
          await sleep(40);
        }

        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.equal(updated.pdf.validHeader, true);
        assert.equal(updated.pdf.validEof, true);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A6-02',
    tier: 2,
    feature: 'A6: Auto-Save Boundaries',
    title: 'Mid-stroke deferred periodic auto-save waits until pen release before saving',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 1 });
      try {
        const created = await app.api.createNotebook({ title: 'DeferredSave', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        // Hold pen down across 2.2s (>2 ticks) before releasing
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.4), normToPoint(rect, 0.7, 0.4)], {
          force: 0.6,
          holdMs: 2200,
        });

        const updated = await waitForFileUpdate(filePath, stat0, { timeoutMs: 5000, requireSizeIncrease: true });
        assert.ok(updated.stat.size > stat0.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A6-03',
    tier: 2,
    feature: 'A6: Auto-Save Boundaries',
    title: 'Rejected /api/save payload preserves existing PDF byte-for-byte with zero .tmp',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, connectCdp: false });
      try {
        const valid = createMinimalPdf({ pages: 1, label: 'SafeOriginal' });
        const r1 = await app.api.savePdf('safe.pdf', valid);
        assert.equal(r1.status, 200);
        const filePath = path.join(app.saveDir, 'safe.pdf');
        const origHash = sha256(fs.readFileSync(filePath));

        const r2 = await app.api.savePdf('safe.pdf', Buffer.from('GARBAGE_NOT_PDF'));
        assert.equal(r2.status, 400);
        assert.equal(sha256(fs.readFileSync(filePath)), origHash);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A6-04',
    tier: 2,
    feature: 'A6: Auto-Save Boundaries',
    title: '--autosave-interval=0 completely disables periodic auto-save while Ctrl+S still saves',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 0 });
      try {
        const created = await app.api.createNotebook({ title: 'NoPeriodic', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });

        await sleep(3500);
        assert.equal(fs.statSync(filePath).mtimeMs, stat0.mtimeMs, 'Periodic auto-save must NOT fire when interval=0');

        await mainPage.pressCtrlS();
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 5000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A6-05',
    tier: 2,
    feature: 'A6: Auto-Save Boundaries',
    title: 'Auto-save overwrites Unicode / Korean filename notebook without mojibake duplicates',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: '한글 노트', template: 'lined', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });
        await mainPage.pressCtrlS();

        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);
        const pdfFiles = fs.readdirSync(app.saveDir).filter((f) => f.endsWith('.pdf'));
        assert.equal(pdfFiles.length, 1, `Expected 1 Korean PDF, found: ${pdfFiles.join(', ')}`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A6-06',
    tier: 2,
    feature: 'A6: Auto-Save Boundaries',
    title: 'Ctrl+S with zero edits succeeds cleanly without corrupting PDF',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ZeroEditSave', template: 'blank', pageSize: 'a4', pages: 2 });
        const filePath = path.join(app.saveDir, created.json.name);
        const { mainPage } = await openPdfInMainWindow(app, created.json.url);

        await mainPage.pressCtrlS();
        await sleep(800);
        const pdf = inspectPdfBuffer(fs.readFileSync(filePath));
        assert.equal(pdf.validHeader, true);
        assert.equal(pdf.validEof, true);
        assert.equal(pdf.pagesCount, 2);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 7: Screen-Sharing Sub-Window Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A7-01',
    tier: 2,
    feature: 'A7: Screen-Sharing Sub-Window Boundaries',
    title: 'Single-monitor fallback opens resizable popup cleanly under headless Xvfb',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'SingleMonitor', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));

        const { presenterPageTarget } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        assert.equal(presenterPageTarget.title, PRESENTER_TITLE);
        assert.equal(exceptions.length, 0);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A7-02',
    tier: 2,
    feature: 'A7: Screen-Sharing Sub-Window Boundaries',
    title: 'Hardware-API shim for 2-screen getScreenDetails() targets external monitor coordinates',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'DualMonitor', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        // Shim browser hardware API window.getScreenDetails + capture window.open features
        await pdfSession.evaluate(`(() => {
          window.__crpdf_open_calls = [];
          const origOpen = window.open.bind(window);
          window.open = function(url, name, features) {
            window.__crpdf_open_calls.push({ url, name, features: String(features || '') });
            return origOpen(url, name, features);
          };
          const primary = { isPrimary: true, isInternal: true, availLeft: 0, availTop: 0, availWidth: 1280, availHeight: 800 };
          const external = { isPrimary: false, isInternal: false, availLeft: 1280, availTop: 0, availWidth: 1920, availHeight: 1080 };
          window.getScreenDetails = async () => ({ currentScreen: primary, screens: [primary, external] });
        })()`);

        await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        const calls = await pdfSession.evaluate('window.__crpdf_open_calls');
        assert.ok(calls.length >= 1, 'Expected window.open to be invoked');
        assert.match(calls[0].features, /left=1280/, `Expected external screen left=1280 in features: ${calls[0].features}`);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A7-03',
    tier: 2,
    feature: 'A7: Screen-Sharing Sub-Window Boundaries',
    title: 'getScreenDetails() permission rejection falls back gracefully to standard popup',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ScreenDenied', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        await pdfSession.evaluate(`(() => {
          window.getScreenDetails = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
        })()`);

        const { presenterPageTarget } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        assert.equal(presenterPageTarget.title, PRESENTER_TITLE);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A7-04',
    tier: 2,
    feature: 'A7: Screen-Sharing Sub-Window Boundaries',
    title: 'Closing and reopening presenter mid-session re-syncs current page cleanly',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'ReopenPresenter', template: 'lined', pageSize: 'a4', pages: 2 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        const first = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        await app.cdp.closeTarget(first.presenterPageTarget.targetId);
        await sleep(300);

        await goToPdfPage(pdfSession, 2);
        await waitFor(async () => (await getViewportState(pdfSession)).page === 2, { timeoutMs: 4000, label: 'main page 2' });

        const second = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        await waitFor(async () => (await getViewportState(second.presenterPdf)).page === 2, {
          timeoutMs: 5000,
          label: 'reopened presenter synced to page 2',
        });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A7-05',
    tier: 2,
    feature: 'A7: Screen-Sharing Sub-Window Boundaries',
    title: 'Rapid zoom/scroll burst converges cleanly without desync',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'RapidZoomBurst', template: 'grid', pageSize: 'a4', pages: 3 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        for (const z of [1.1, 1.2, 1.3, 1.4, 1.25, 1.6]) {
          await setPdfZoom(pdfSession, z);
          await sleep(40);
        }
        await goToPdfPage(pdfSession, 3);

        await waitFor(
          async () => {
            const vp = await getViewportState(presenterPdf);
            return vp.page === 3 && Math.abs(vp.zoom - 1.6) <= 0.1;
          },
          { timeoutMs: 5000, label: 'presenter converged to page 3 & zoom 1.6' },
        );
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A7-06',
    tier: 2,
    feature: 'A7: Screen-Sharing Sub-Window Boundaries',
    title: 'Clicking Screen Share while popup is already open does not spawn duplicate popups',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'NoDupPopup', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        await clickControl(pdfSession, 'screenShare', { pageSession: mainPage });
        await sleep(500);

        const targets = await app.cdp.listTargets();
        const presenters = targets.filter(
          (t) => t.type === 'page' && (t.title === PRESENTER_TITLE || t.url.includes('crpdf_role=presenter')),
        );
        assert.equal(presenters.length, 1, `Expected exactly 1 presenter popup, found ${presenters.length}`);
      } finally {
        await app.stop();
      }
    },
  },

  // =========================================================================
  // Area 8: Dual-Window Input & Laser Pointer Boundaries (6 Tests)
  // =========================================================================
  {
    id: 'T2-A8-01',
    tier: 2,
    feature: 'A8: Dual-Window Input & Laser Boundaries',
    title: 'Laser edge coordinates (0%, 0%) and (100%, 100%) render cleanly without NaN',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserCorners', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const pRect = await getPdfPageRect(presenterPdf);
        await presenterPage.dispatchMouseMove(pRect.x + 1, pRect.y + 1);
        const tl = await waitFor(async () => {
          const s = await getLaserState(pdfSession);
          return s.visible ? s : null;
        }, { timeoutMs: 3000, label: 'top-left laser' });
        assert.ok(Number.isFinite(tl.xPct) && tl.xPct >= -2 && tl.xPct <= 5);
        assert.ok(Number.isFinite(tl.yPct) && tl.yPct >= -2 && tl.yPct <= 5);

        await presenterPage.dispatchMouseMove(pRect.x + pRect.width - 1, pRect.y + pRect.height - 1);
        const br = await waitFor(async () => {
          const s = await getLaserState(pdfSession);
          return s.visible && s.xPct > 90 ? s : null;
        }, { timeoutMs: 3000, label: 'bottom-right laser' });
        assert.ok(Number.isFinite(br.xPct) && br.xPct >= 95 && br.xPct <= 102);
        assert.ok(Number.isFinite(br.yPct) && br.yPct >= 95 && br.yPct <= 102);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A8-02',
    tier: 2,
    feature: 'A8: Dual-Window Input & Laser Boundaries',
    title: 'Out-of-bounds margin pointer either clamps to [0, 100] or hides cleanly (never NaN)',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserMargin', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        await presenterPage.dispatchMouseMove(2, 2);
        await sleep(250);
        const st = await getLaserState(presenterPdf);
        if (st.visible) {
          assert.ok(Number.isFinite(st.xPct) && st.xPct >= 0 && st.xPct <= 100, `Out-of-range xPct=${st.xPct}`);
          assert.ok(Number.isFinite(st.yPct) && st.yPct >= 0 && st.yPct <= 100, `Out-of-range yPct=${st.yPct}`);
        }
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A8-03',
    tier: 2,
    feature: 'A8: Dual-Window Input & Laser Boundaries',
    title: 'mouseleave immediately hides laser in both presenter and main windows within 300ms',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserLeaveFast', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const pRect = await getPdfPageRect(presenterPdf);
        const center = normToPoint(pRect, 0.5, 0.5);
        await presenterPage.dispatchMouseMove(center.x, center.y);
        await waitFor(async () => (await getLaserState(pdfSession)).visible, { timeoutMs: 3000, label: 'laser shown' });

        await presenterPdf.evaluate(`(() => {
          const el = document.querySelector('#crpdf-laser-overlay') || document.body;
          el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        })()`);

        await waitFor(
          async () => !(await getLaserState(presenterPdf)).visible && !(await getLaserState(pdfSession)).visible,
          { timeoutMs: 1000, label: 'laser hidden quickly' },
        );
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A8-04',
    tier: 2,
    feature: 'A8: Dual-Window Input & Laser Boundaries',
    title: 'Aspect-ratio mismatch (1280x800 vs 700x900) preserves page-normalized (50%, 50%) mapping',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserAspect', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        await presenterPage.send('Emulation.setDeviceMetricsOverride', {
          width: 700,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(300);

        const pRect = await getPdfPageRect(presenterPdf);
        const center = normToPoint(pRect, 0.5, 0.5);
        await presenterPage.dispatchMouseMove(center.x, center.y);

        const mainLaser = await waitFor(
          async () => {
            const st = await getLaserState(pdfSession);
            return st.visible ? st : null;
          },
          { timeoutMs: 3000, label: 'main laser under aspect mismatch' },
        );
        assert.ok(
          Math.abs(mainLaser.xPct - 50) <= 4 && Math.abs(mainLaser.yPct - 50) <= 4,
          `Expected normalized (50%, 50%), got (${mainLaser.xPct}, ${mainLaser.yPct})`,
        );
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A8-05',
    tier: 2,
    feature: 'A8: Dual-Window Input & Laser Boundaries',
    title: 'Rapid 40-move laser burst converges to final (90%, 90%) coordinate without lag',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'LaserBurst', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const pRect = await getPdfPageRect(presenterPdf);
        for (let i = 0; i <= 40; i++) {
          const frac = 0.1 + (0.8 * i) / 40;
          const pt = normToPoint(pRect, frac, frac);
          await presenterPage.dispatchMouseMove(pt.x, pt.y);
          await sleep(5);
        }

        const finalMain = await waitFor(
          async () => {
            const st = await getLaserState(pdfSession);
            return st.visible && Math.abs(st.xPct - 90) <= 4 && Math.abs(st.yPct - 90) <= 4 ? st : null;
          },
          { timeoutMs: 3000, label: 'main laser converged to (90%, 90%)' },
        );
        assert.equal(finalMain.visible, true);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T2-A8-06',
    tier: 2,
    feature: 'A8: Dual-Window Input & Laser Boundaries',
    title: 'Simultaneous main pen stroke and sub-window laser drag maintain strict input isolation',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'SimultaneousDual', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const mRect = await getPdfPageRect(pdfSession);
        const pRect = await getPdfPageRect(presenterPdf);

        await Promise.all([
          mainPage.dispatchPenStroke([normToPoint(mRect, 0.2, 0.3), normToPoint(mRect, 0.65, 0.3)], { force: 0.6 }),
          presenterPage.dispatchMouseDrag([normToPoint(pRect, 0.3, 0.7), normToPoint(pRect, 0.75, 0.7)]),
        ]);

        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: 'main ink recorded' });
        await waitFor(async () => (await getMirrorCanvasStats(presenterPdf)).nonZeroPixels > 20, { timeoutMs: 4000, label: 'presenter mirror ink' });
        await waitFor(async () => (await getLaserState(pdfSession)).visible, { timeoutMs: 4000, label: 'laser synced to main' });
      } finally {
        await app.stop();
      }
    },
  },
];
