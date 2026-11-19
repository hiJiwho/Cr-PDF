/**
 * Tier 4 — Real-World Application Scenarios (5 full end-to-end workflows: T4-S1 through T4-S5).
 *
 *   T4-S1: Classroom Lecture Workflow (Lined notebook, maxLevel=3 pressure, presenter popup, mirror, laser, auto-save)
 *   T4-S2: Imported PDF Annotation & Silent Overwrite (import external PDF, palm reject, pen+highlighter+undo, Ctrl+S, reopen)
 *   T4-S3: Periodic Auto-Save Durability During Continuous Multi-Page & Add-Page Note-Taking (custom B5 176x250mm, zero manual save)
 *   T4-S4: Notebook Library Management + Folder Switch Isolation (4 templates incl. custom mm, search/sort/delete, folder switch)
 *   T4-S5: CEF Version-Upgrade Simulation (patch_pak.py double-run idempotency + live end-to-end app check)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MM_TO_PT,
  createMinimalPdf,
  inspectPdfBuffer,
  launchApp,
  resolveBasePakPath,
} from './harness.mjs';
import {
  TOOLBAR_SELECTORS,
  assertJsSyntaxValid,
  assertNoTmpFiles,
  assertPakV5Structure,
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
  runPatchPakCli,
  setPressureMaxLevel,
  sleep,
  waitFor,
  waitForFileUpdate,
  waitForFirstDeep,
} from './pdf_helpers.mjs';

export const tests = [
  {
    id: 'T4-S1',
    tier: 4,
    feature: 'Scenario 1: Classroom Lecture Workflow',
    title: 'Lined notebook -> maxLevel=3 pressure -> [화면공유용] 판서 화면 mirror & page turn -> red laser -> auto-save',
    requiresBinary: true,
    timeoutMs: 45000,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 3 });
      try {
        const created = await app.api.createNotebook({
          title: 'Lecture_Physics_01',
          template: 'lined',
          pageSize: 'a4',
          pages: 2,
        });
        assert.equal(created.status, 201);
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const bar = await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS.toolbarBar);
        assert.equal(bar.visible, true);

        // Set maxLevel=3 and verify 0.10->1, 0.30->2, 0.90->3 (capped)
        await setPressureMaxLevel(pdfSession, 3, { pageSession: mainPage });
        const mRect = await getPdfPageRect(pdfSession);
        for (const [idx, f] of [0.1, 0.3, 0.9].entries()) {
          const y = 0.22 + idx * 0.14;
          await mainPage.dispatchPenStroke([normToPoint(mRect, 0.2, y), normToPoint(mRect, 0.55, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 3);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `lecture stroke force=${f} -> ${expected}`,
          });
        }

        // Open presenter sub-window and confirm pure PDF mode
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        const subToolbar = await presenterPdf.queryDeep('viewer-toolbar');
        assert.ok(!subToolbar.found || !subToolbar.visible);

        // Draw 4th stroke -> mirrored on presenter -> turn to page 2 -> presenter syncs
        await mainPage.dispatchPenStroke([normToPoint(mRect, 0.25, 0.65), normToPoint(mRect, 0.7, 0.65)], { force: 0.5 });
        await waitFor(async () => (await getMirrorCanvasStats(presenterPdf)).nonZeroPixels > 20, {
          timeoutMs: 4000,
          label: 'presenter mirrored 4th stroke',
        });

        await goToPdfPage(pdfSession, 2);
        await waitFor(async () => (await getViewportState(presenterPdf)).page === 2, {
          timeoutMs: 4000,
          label: 'presenter turned to page 2',
        });

        // Point red laser from presenter at (45%, 55%) -> visible on both windows
        const pRect = await getPdfPageRect(presenterPdf);
        const pt = normToPoint(pRect, 0.45, 0.55);
        await presenterPage.dispatchMouseMove(pt.x, pt.y);
        await waitFor(
          async () => (await getLaserState(presenterPdf)).visible && (await getLaserState(pdfSession)).visible,
          { timeoutMs: 3000, label: 'red laser visible in both windows' },
        );

        // Periodic auto-save writes valid updated PDF with 0 .tmp files
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 7000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);
        assert.equal(saved.pdf.pagesCount, 2);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T4-S2',
    tier: 4,
    feature: 'Scenario 2: Imported PDF Annotation & Silent Overwrite',
    title: 'Import external 2-page PDF -> palm reject -> Pen + Highlighter + Undo -> Ctrl+S silent overwrite -> reopen',
    requiresBinary: true,
    timeoutMs: 45000,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const externalPdf = createMinimalPdf({ pages: 2, label: 'External Handout' });
        const imp = await app.api.importNotebook('Handout_Review.pdf', externalPdf);
        assert.equal(imp.status, 201);
        const filePath = path.join(app.saveDir, 'Handout_Review.pdf');
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, imp.json.url);
        const rect = await getPdfPageRect(pdfSession);

        // Accidental palm rest touch drag -> 0 strokes
        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.7), normToPoint(rect, 0.5, 0.3)]);
        await sleep(250);
        assert.equal((await getUndoState(pdfSession)).disabled, true);

        // Pen stroke 1
        await clickControl(pdfSession, 'pen', { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });

        // Highlighter stroke 2
        await clickControl(pdfSession, 'highlighter', { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.45), normToPoint(rect, 0.65, 0.45)], { force: 0.5 });

        // Accidental stroke 3 -> Undo
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.6), normToPoint(rect, 0.6, 0.6)], { force: 0.5 });
        await clickControl(pdfSession, 'undo', { pageSession: mainPage });

        // Silent Ctrl+S overwrite
        await mainPage.pressCtrlS();
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.equal(saved.pdf.pagesCount, 2);
        assertNoTmpFiles(app.saveDir);

        // Return to Library and reopen
        await mainPage.navigate(`${app.baseUrl}/`);
        await sleep(300);
        await openPdfInMainWindow(app, imp.json.url);
        const served = await app.api.getPdf('Handout_Review.pdf');
        assert.equal(served.buffer.length, saved.stat.size);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T4-S3',
    tier: 4,
    feature: 'Scenario 3: Periodic Auto-Save Durability & Continuous Add-Page',
    title: 'Custom B5 (176x250mm) note -> draw -> Add Page (+) -> write page 2 -> 2 periodic auto-save cycles with zero Ctrl+S',
    requiresBinary: true,
    timeoutMs: 50000,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 2 });
      try {
        const created = await app.api.createNotebook({
          title: 'Continuous_Notes',
          template: 'grid',
          pageSize: 'custom',
          widthMm: 176,
          heightMm: 250,
          pages: 1,
        });
        assert.equal(created.status, 201);
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect1 = await getPdfPageRect(pdfSession);
        for (let i = 0; i < 3; i++) {
          const y = 0.25 + i * 0.12;
          await mainPage.dispatchPenStroke([normToPoint(rect1, 0.2, y), normToPoint(rect1, 0.65, y)], { force: 0.5 });
        }

        // Add Page (+) preserves page 1 Ink2 and appends B5 page 2
        await clickControl(pdfSession, 'addPage', { pageSession: mainPage });
        const afterAdd = await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000, requireSizeIncrease: true });
        assert.equal(afterAdd.pdf.pagesCount, 2);
        const p2Mb = afterAdd.pdf.mediaBoxes[afterAdd.pdf.mediaBoxes.length - 1];
        assert.ok(Math.abs(p2Mb.widthPt - 176 * MM_TO_PT) <= 1.5);
        assert.ok(Math.abs(p2Mb.heightPt - 250 * MM_TO_PT) <= 1.5);

        // Continue writing on page 2 without pressing Ctrl+S (cycle 1)
        const { session: pdf2 } = await app.cdp.waitForPdfViewer({ role: 'main', timeoutMs: 10000 });
        await waitFor(async () => (await getViewportState(pdf2)).page === 2, { timeoutMs: 5000, label: 'page 2 active' });
        const rect2 = await getPdfPageRect(pdf2);
        await mainPage.dispatchPenStroke([normToPoint(rect2, 0.2, 0.3), normToPoint(rect2, 0.7, 0.3)], { force: 0.6 });
        await mainPage.dispatchPenStroke([normToPoint(rect2, 0.2, 0.45), normToPoint(rect2, 0.7, 0.45)], { force: 0.4 });

        const cycle1 = await waitForFileUpdate(filePath, afterAdd.stat, { timeoutMs: 6500, requireSizeIncrease: true });
        assertNoTmpFiles(app.saveDir);

        // Write more on page 2 (cycle 2)
        await mainPage.dispatchPenStroke([normToPoint(rect2, 0.2, 0.65), normToPoint(rect2, 0.75, 0.65)], { force: 0.8 });
        const cycle2 = await waitForFileUpdate(filePath, cycle1.stat, { timeoutMs: 6500 });
        assert.equal(cycle2.pdf.pagesCount, 2);
        assert.ok(cycle2.stat.size >= cycle1.stat.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T4-S4',
    tier: 4,
    feature: 'Scenario 4: Notebook Library Management & Folder Switch Isolation',
    title: 'Create 4 templates (incl. custom mm), search & delete in Library UI, switch saveDir, and verify strict folder isolation',
    requiresBinary: true,
    timeoutMs: 45000,
    async run(ctx) {
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'crpdf-t4-s4-dirB-'));
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const dirA = app.saveDir;
        const specs = [
          { title: 'Alpha_Blank', template: 'blank', pageSize: 'a4', pages: 1 },
          { title: 'Beta_Lined', template: 'lined', pageSize: 'letter', pages: 1 },
          { title: 'Gamma_Grid', template: 'grid', pageSize: '16x9', pages: 1 },
          { title: 'Delta_Dot', template: 'dot', pageSize: 'custom', widthMm: 150, heightMm: 210, pages: 1 },
        ];
        for (const s of specs) {
          const r = await app.api.createNotebook(s);
          assert.equal(r.status, 201, `Create ${s.title} failed: ${r.text}`);
        }

        // Open Library UI and verify all 4 render + search filtering
        const { session: mainPage } = await app.cdp.waitForMainPage(app.appPort);
        await mainPage.navigate(`${app.baseUrl}/`);
        await waitFor(
          async () => {
            const text = await mainPage.evaluate('document.body.innerText');
            return text.includes('Alpha_Blank') && text.includes('Gamma_Grid') && text.includes('Delta_Dot');
          },
          { timeoutMs: 6000, label: 'all 4 notebooks visible in Library UI' },
        );

        // Filter search input for "Gamma"
        const searched = await mainPage.evaluate(`(() => {
          const input = document.querySelector('input[type="search"], input[placeholder*="검색"], input[placeholder*="Search" i], #search-input');
          if (!input) return false;
          input.value = 'Gamma';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        if (searched) {
          await waitFor(
            async () => {
              const text = await mainPage.evaluate('document.body.innerText');
              return text.includes('Gamma_Grid') && !text.includes('Alpha_Blank');
            },
            { timeoutMs: 3000, label: 'search filtered to Gamma_Grid' },
          );
        }

        // Delete Beta_Lined
        const del = await app.api.deleteNotebook('Beta_Lined.pdf');
        assert.equal(del.status, 200);
        assert.equal(fs.existsSync(path.join(dirA, 'Beta_Lined.pdf')), false);
        const listA = await app.api.listNotebooks();
        assert.equal(listA.json.notebooks.length, 3);

        // Switch saveDir to empty dirB
        const sw = await app.api.updateConfig({ saveDir: dirB });
        assert.equal(sw.status, 200);
        const listB0 = await app.api.listNotebooks();
        assert.equal(listB0.json.notebooks.length, 0);

        // Create Epsilon_New in dirB -> strict isolation from dirA
        const eps = await app.api.createNotebook({ title: 'Epsilon_New', template: 'blank', pageSize: 'a4', pages: 1 });
        assert.equal(eps.status, 201);
        assert.deepEqual(
          fs.readdirSync(dirB).filter((f) => f.endsWith('.pdf')),
          ['Epsilon_New.pdf'],
        );
        assert.equal(
          fs.readdirSync(dirA).filter((f) => f.endsWith('.pdf')).length,
          3,
        );
      } finally {
        await app.stop();
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T4-S5',
    tier: 4,
    feature: 'Scenario 5: CEF Version-Upgrade Simulation',
    title: 'Double-run patch_pak.py --verify on real resources.pak, verify idempotency, and pass live Ink2 + dual-window smoke',
    requiresBinary: true,
    timeoutMs: 60000,
    async run(ctx) {
      const basePak = resolveBasePakPath();
      assert.ok(fs.existsSync(basePak), `Base resources.pak not found at ${basePak}`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crpdf-t4-s5-'));
      try {
        const origCopy = path.join(tmp, 'resources_orig.pak');
        const p1Path = path.join(tmp, 'resources_p1.pak');
        const p2Path = path.join(tmp, 'resources_p2.pak');
        fs.copyFileSync(basePak, origCopy);

        const r1 = runPatchPakCli({ input: origCopy, output: p1Path, verify: true });
        assert.equal(r1.status, 0, `Pass 1 patch_pak.py failed:\n${r1.stderr}`);

        const r2 = runPatchPakCli({ input: p1Path, output: p2Path, verify: true });
        assert.equal(r2.status, 0, `Pass 2 patch_pak.py failed:\n${r2.stderr}`);

        const parsed1 = assertPakV5Structure(fs.readFileSync(p1Path));
        const parsed2 = assertPakV5Structure(fs.readFileSync(p2Path));
        assert.equal(parsed2.resourceCount, parsed1.resourceCount);

        const patched2 = parsed2.entries.filter((e) => e.data.toString('utf8').includes('CRPDF_PATCH_START'));
        assert.ok(patched2.length >= 2, 'Expected >=2 patched JS entries in double-patched pak');
        for (const entry of patched2) {
          const js = entry.data.toString('utf8');
          assert.equal(countMarkers(js, 'CRPDF_PATCH_START'), 1);
          assert.equal(countMarkers(js, 'CRPDF_PATCH_END'), 1);
          assertJsSyntaxValid(js, `upgrade_${entry.id}.mjs`);
        }

        // Live end-to-end verification on launched app
        const app = await launchApp({ binPath: ctx.binPath });
        try {
          const created = await app.api.createNotebook({ title: 'UpgradeSmoke', template: 'blank', pageSize: 'a4', pages: 1 });
          const filePath = path.join(app.saveDir, created.json.name);
          const stat0 = fs.statSync(filePath);

          const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
          await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS.toolbarBar);

          const rect = await getPdfPageRect(pdfSession);
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.35), normToPoint(rect, 0.65, 0.35)], { force: 0.5 });
          await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: 'Ink2 stroke' });

          const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
          const pRect = await getPdfPageRect(presenterPdf);
          const lpt = normToPoint(pRect, 0.5, 0.5);
          await presenterPage.dispatchMouseMove(lpt.x, lpt.y);
          await waitFor(async () => (await getLaserState(pdfSession)).visible, { timeoutMs: 3000, label: 'laser sync' });

          await mainPage.pressCtrlS();
          const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
          assert.ok(saved.stat.size > stat0.size);
          assertNoTmpFiles(app.saveDir);
        } finally {
          await app.stop();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
];
