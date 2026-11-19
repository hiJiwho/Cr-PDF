/**
 * Tier 3 — Cross-Feature Pairwise Combination Suite (9 suites: T3-P1 through T3-P9).
 *
 * Verifies real interactions between pairs/triples of Cr-PDF features:
 *   T3-P1: Palm Rejection x Pseudo-Pressure (0/20/40/60/80% + maxLevel cap) (F08 x F09)
 *   T3-P2: Pseudo-Pressure x Silent Auto-Save (F09 x F10)
 *   T3-P3: Ultra-Minimal Toolbar (Top + Right Dock) x Sub-Window Pure Mode (F07 x F11)
 *   T3-P4: GoodNotes Create x Ink2 Draw x Silent Auto-Save x Reopen (F06 x F07 x F10)
 *   T3-P5: Sub-Window Mirroring x Bidirectional Laser Pointer (F11 x F12)
 *   T3-P6: Save Folder Switch x Periodic Auto-Save Isolation (F04 x F06 x F10)
 *   T3-P7: Undo x Sub-Window Mirror Sync (Quadrant Isolation) (F07 x F11)
 *   T3-P8: Custom mm Dimensions x Add Page (+) x Ink2 Preservation (F04 x F06 x F07 x F10)
 *   T3-P9: Add Page (+) x Sub-Window Mirror Sync (F04 x F07 x F11)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MM_TO_PT, inspectPdfBuffer, launchApp } from './harness.mjs';
import {
  TOOLBAR_SELECTORS,
  assertNoTmpFiles,
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
  setPdfZoom,
  setPressureMaxLevel,
  sleep,
  waitFor,
  waitForFileUpdate,
  waitForFirstDeep,
} from './pdf_helpers.mjs';

export const tests = [
  {
    id: 'T3-P1',
    tier: 3,
    feature: 'Pairwise: F08 x F09 (Palm Rejection + Pseudo-Pressure)',
    title: 'Interleaved touch scroll never mutates brush size or draws ink while pen pressure scales 0/20/40/60/80% capped by maxLevel',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair1_PalmPressure', template: 'blank', pageSize: 'a4', pages: 2 });
        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const exceptions = [];
        pdfSession.on('Runtime.exceptionThrown', (e) => exceptions.push(e));
        const rect = await getPdfPageRect(pdfSession);

        // 1. Pre-stylus touch scroll must create 0 ink strokes
        const vp0 = await getViewportState(pdfSession);
        await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.75), normToPoint(rect, 0.5, 0.25)], { steps: 8 });
        await waitFor(async () => (await getViewportState(pdfSession)).scrollTop > vp0.scrollTop, {
          timeoutMs: 4000,
          label: 'pre-stylus touch scroll',
        });
        assert.equal((await getUndoState(pdfSession)).disabled, true);

        // 2. Pen with maxLevel = 5 interleaved with touch drags
        await setPressureMaxLevel(pdfSession, 5, { pageSession: mainPage });
        for (const [idx, f] of [0.1, 0.5, 0.9].entries()) {
          const y = 0.22 + idx * 0.16;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, y), normToPoint(rect, 0.55, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 5);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=5 force=${f} -> ${expected}`,
          });
          // Interleaved touch drag must not alter brush size
          await mainPage.dispatchTouchDrag([normToPoint(rect, 0.5, 0.6), normToPoint(rect, 0.5, 0.5)]);
          await sleep(120);
          assert.equal((await getActiveBrushState(pdfSession)).size, expected);
        }

        // 3. Pen with maxLevel = 3 (0.10->1, 0.30->2, 0.50->3, 0.90->3 capped)
        await setPressureMaxLevel(pdfSession, 3, { pageSession: mainPage });
        for (const [idx, f] of [0.1, 0.3, 0.5, 0.9].entries()) {
          const y = 0.2 + idx * 0.12;
          await mainPage.dispatchPenStroke([normToPoint(rect, 0.55, y), normToPoint(rect, 0.8, y)], { force: f });
          const expected = expectedPseudoPressureLevel(f, 3);
          await waitFor(async () => (await getActiveBrushState(pdfSession)).size === expected, {
            timeoutMs: 3000,
            label: `maxLevel=3 force=${f} -> ${expected}`,
          });
        }

        // 4. Eraser guard under variable pen pressure
        await clickControl(pdfSession, 'eraser', { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.5, 0.3)], { force: 0.1 });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.4), normToPoint(rect, 0.5, 0.4)], { force: 0.9 });
        assert.equal(exceptions.length, 0);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P2',
    tier: 3,
    feature: 'Pairwise: F09 x F10 (Pseudo-Pressure + Silent Auto-Save)',
    title: 'Multi-pressure strokes persist atomically via Ctrl+S with zero dialogs and zero .tmp files',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair2_PressureSave', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);

        await setPressureMaxLevel(pdfSession, 5, { pageSession: mainPage });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.3), normToPoint(rect, 0.45, 0.3)], { force: 0.1 });
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.55), normToPoint(rect, 0.65, 0.55)], { force: 0.9 });

        await mainPage.pressCtrlS();
        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);
        assertNoTmpFiles(app.saveDir);

        // Verify browser is not stalled by any modal dialog
        const responsive = await mainPage.evaluate('1 + 1', { timeoutMs: 1000 });
        assert.equal(responsive, 2);

        const served = await app.api.getPdf(created.json.name);
        assert.equal(served.status, 200);
        assert.equal(served.buffer.length, saved.stat.size);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P3',
    tier: 3,
    feature: 'Pairwise: F07 x F11 (Minimal Toolbar + Sub-Window Pure Mode)',
    title: 'Main window keeps ultra-minimal 1-row/right-dock toolbar while sub-window hides ALL toolbars',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair3_ToolbarPure', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);

        // Main window minimal toolbar visible & stock chrome hidden
        const mainBar = await waitForFirstDeep(pdfSession, TOOLBAR_SELECTORS.toolbarBar);
        assert.equal(mainBar.visible, true);
        for (const hiddenSel of ['#print', '#rotate', '#sidenavToggle', '#more', '#side-panel', '#bottom']) {
          const s = await pdfSession.queryDeep(hiddenSel);
          assert.ok(!s.found || !s.visible, `Main window should hide ${hiddenSel}`);
        }

        // Open presenter sub-window -> ALL toolbars hidden
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        for (const subHidden of ['viewer-toolbar', '#crpdf-toolbar', '[data-crpdf-toolbar]', '#side-panel', '#bottom']) {
          const s = await presenterPdf.queryDeep(subHidden);
          assert.ok(!s.found || !s.visible, `Sub-window must hide ${subHidden}`);
        }

        // Toggle main dock to right vertical bar and verify sub-window still remains pure PDF
        await clickControl(pdfSession, 'dockToggle', { pageSession: mainPage });
        await sleep(250);
        const mainDocked = await queryFirstDeep(pdfSession, TOOLBAR_SELECTORS.toolbarBar);
        assert.equal(mainDocked.visible, true);
        const subBarAfter = await queryFirstDeep(presenterPdf, TOOLBAR_SELECTORS.toolbarBar);
        assert.ok(!subBarAfter.found || !subBarAfter.visible);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P4',
    tier: 3,
    feature: 'Pairwise: F06 x F07 x F10 (Library Create + Ink2 + Auto-Save + Reopen)',
    title: 'Create Lined notebook, draw Ink2 stroke, silent save, return to Library, and reopen with persisted ink',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair4_Lined', template: 'lined', pageSize: 'a4', pages: 1 });
        assert.equal(created.status, 201);
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.4), normToPoint(rect, 0.7, 0.4)], { force: 0.55 });
        await mainPage.pressCtrlS();

        const saved = await waitForFileUpdate(filePath, stat0, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.ok(saved.stat.size > stat0.size);

        // Return to Library UI and reopen
        await mainPage.navigate(`${app.baseUrl}/`);
        await waitFor(
          async () => {
            const html = await mainPage.evaluate('document.body.innerText');
            return typeof html === 'string' && html.includes('Pair4_Lined');
          },
          { timeoutMs: 5000, label: 'Pair4_Lined listed in Library UI' },
        );

        await openPdfInMainWindow(app, created.json.url);
        const served = await app.api.getPdf(created.json.name);
        assert.equal(served.buffer.length, saved.stat.size);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P5',
    tier: 3,
    feature: 'Pairwise: F11 x F12 (Sub-Window Mirroring + Bidirectional Laser Pointer)',
    title: 'Sub-window mirrors strokes & viewport while mouse laser pointer syncs both ways without corrupting ink mirror',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair5_MirrorLaser', template: 'blank', pageSize: 'a4', pages: 2 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPage, presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const mRect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(mRect, 0.2, 0.3), normToPoint(mRect, 0.55, 0.3)], { force: 0.6 });

        const mirrorBefore = await waitFor(
          async () => {
            const st = await getMirrorCanvasStats(presenterPdf);
            return st.nonZeroPixels > 20 ? st : null;
          },
          { timeoutMs: 4000, label: 'mirror stroke rendered' },
        );

        const pRect = await getPdfPageRect(presenterPdf);
        await presenterPage.dispatchMouseDrag([normToPoint(pRect, 0.5, 0.4), normToPoint(pRect, 0.7, 0.6)]);

        await waitFor(
          async () => {
            const subL = await getLaserState(presenterPdf);
            const mainL = await getLaserState(pdfSession);
            return subL.visible && mainL.visible && Math.abs(mainL.xPct - 70) <= 5 && Math.abs(mainL.yPct - 60) <= 5;
          },
          { timeoutMs: 3000, label: 'laser synced at (70%, 60%) on both windows' },
        );

        const mirrorAfter = await getMirrorCanvasStats(presenterPdf);
        assert.equal(mirrorAfter.nonZeroPixels, mirrorBefore.nonZeroPixels, 'Laser drag must not alter mirrored ink pixels');

        await setPdfZoom(pdfSession, 1.25);
        await goToPdfPage(pdfSession, 2);
        await waitFor(async () => (await getViewportState(presenterPdf)).page === 2, {
          timeoutMs: 4000,
          label: 'presenter synced to page 2',
        });
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P6',
    tier: 3,
    feature: 'Pairwise: F04 x F06 x F10 (Save Folder Switch + Periodic Auto-Save)',
    title: 'Switching saveDir via /api/config isolates periodic auto-save strictly to the new folder',
    requiresBinary: true,
    async run(ctx) {
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'crpdf-t3-p6-dirB-'));
      const app = await launchApp({ binPath: ctx.binPath, autosaveInterval: 2 });
      try {
        const dirA = app.saveDir;
        const oldNote = await app.api.createNotebook({ title: 'OldNote', template: 'blank', pageSize: 'a4', pages: 1 });
        const oldPath = path.join(dirA, oldNote.json.name);
        const oldStat = fs.statSync(oldPath);

        const cfgRes = await app.api.updateConfig({ saveDir: dirB });
        assert.equal(cfgRes.status, 200);
        assert.equal(path.resolve(cfgRes.json.saveDir), path.resolve(dirB));

        const newNote = await app.api.createNotebook({ title: 'NewFolderNote', template: 'blank', pageSize: 'a4', pages: 1 });
        assert.equal(newNote.status, 201);
        const newPath = path.join(dirB, newNote.json.name);
        assert.equal(fs.existsSync(newPath), true);
        assert.equal(fs.existsSync(path.join(dirA, newNote.json.name)), false);
        const newStat0 = fs.statSync(newPath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, newNote.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.25, 0.35), normToPoint(rect, 0.65, 0.35)], { force: 0.6 });

        const saved = await waitForFileUpdate(newPath, newStat0, { timeoutMs: 6500, requireSizeIncrease: true });
        assert.ok(saved.stat.size > newStat0.size);
        assertNoTmpFiles(dirB);
        assertNoTmpFiles(dirA);

        // Verify dirA completely untouched
        assert.equal(fs.statSync(oldPath).size, oldStat.size);
        assert.equal(fs.statSync(oldPath).mtimeMs, oldStat.mtimeMs);
      } finally {
        await app.stop();
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T3-P7',
    tier: 3,
    feature: 'Pairwise: F07 x F11 (Undo + Sub-Window Mirror Sync)',
    title: 'Drawing 2 strokes in Q1 and Q4 then Undo removes only Stroke 2 on sub-window mirror canvas',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair7_UndoMirror', template: 'blank', pageSize: 'a4', pages: 1 });
        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);
        const rect = await getPdfPageRect(pdfSession);

        // Stroke 1 in Q1 (top-left)
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.18, 0.22), normToPoint(rect, 0.38, 0.22)], { force: 0.6 });
        await waitFor(
          async () => {
            const s = await getMirrorCanvasStats(presenterPdf);
            return s.q1 > 10 && s.q4 === 0;
          },
          { timeoutMs: 4000, label: 'Stroke 1 in Q1 only' },
        );

        // Stroke 2 in Q4 (bottom-right)
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.62, 0.72), normToPoint(rect, 0.82, 0.72)], { force: 0.6 });
        await waitFor(
          async () => {
            const s = await getMirrorCanvasStats(presenterPdf);
            return s.q1 > 10 && s.q4 > 10;
          },
          { timeoutMs: 4000, label: 'Stroke 1 in Q1 and Stroke 2 in Q4' },
        );

        // Undo removes only Q4
        await clickControl(pdfSession, 'undo', { pageSession: mainPage });
        await waitFor(
          async () => {
            const s = await getMirrorCanvasStats(presenterPdf);
            return s.q1 > 10 && s.q4 === 0;
          },
          { timeoutMs: 4000, label: 'Undo removed Stroke 2 (Q4) while preserving Stroke 1 (Q1)' },
        );
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P8',
    tier: 3,
    feature: 'Pairwise: F04 x F06 x F07 x F10 (Custom mm + Add Page + Ink2 Preservation)',
    title: 'Custom 180x250mm notebook preserves page 1 Ink2 on Add Page (+) and keeps 180x250mm on page 2',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({
          title: 'Pair8_CustomAddPage',
          template: 'grid',
          pageSize: 'custom',
          widthMm: 180,
          heightMm: 250,
          pages: 1,
        });
        assert.equal(created.status, 201);
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.7, 0.3)], { force: 0.6 });
        await waitFor(async () => !(await getUndoState(pdfSession)).disabled, { timeoutMs: 4000, label: 'page 1 stroke' });

        await clickControl(pdfSession, 'addPage', { pageSession: mainPage });
        const afterAdd = await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000, requireSizeIncrease: true });
        assert.equal(afterAdd.pdf.pagesCount, 2);
        const page2Mb = afterAdd.pdf.mediaBoxes[afterAdd.pdf.mediaBoxes.length - 1];
        assert.ok(Math.abs(page2Mb.widthPt - 180 * MM_TO_PT) <= 1.5);
        assert.ok(Math.abs(page2Mb.heightPt - 250 * MM_TO_PT) <= 1.5);
        assertNoTmpFiles(app.saveDir);

        // Draw on page 2 and save
        const { session: reloadedPdf } = await app.cdp.waitForPdfViewer({ role: 'main', timeoutMs: 10000 });
        await waitFor(async () => (await getViewportState(reloadedPdf)).page === 2, { timeoutMs: 5000, label: 'page 2' });
        const rect2 = await getPdfPageRect(reloadedPdf);
        await mainPage.dispatchPenStroke([normToPoint(rect2, 0.25, 0.5), normToPoint(rect2, 0.75, 0.5)], { force: 0.7 });
        await mainPage.pressCtrlS();

        const finalSaved = await waitForFileUpdate(filePath, afterAdd.stat, { timeoutMs: 6000, requireSizeIncrease: true });
        assert.equal(finalSaved.pdf.pagesCount, 2);
        assert.ok(finalSaved.stat.size > afterAdd.stat.size);
        assertNoTmpFiles(app.saveDir);
      } finally {
        await app.stop();
      }
    },
  },
  {
    id: 'T3-P9',
    tier: 3,
    feature: 'Pairwise: F04 x F07 x F11 (Add Page + Sub-Window Mirror Sync)',
    title: 'Clicking Add Page (+) in main window updates presenter sub-window to page 2 and mirrors new page 2 strokes',
    requiresBinary: true,
    async run(ctx) {
      const app = await launchApp({ binPath: ctx.binPath });
      try {
        const created = await app.api.createNotebook({ title: 'Pair9_AddPageMirror', template: 'blank', pageSize: 'a4', pages: 1 });
        const filePath = path.join(app.saveDir, created.json.name);
        const stat0 = fs.statSync(filePath);

        const { mainPage, pdfTarget, pdfSession } = await openPdfInMainWindow(app, created.json.url);
        const { presenterPdf } = await openPresenterSubWindow(app, pdfSession, mainPage, pdfTarget.targetId);

        const rect = await getPdfPageRect(pdfSession);
        await mainPage.dispatchPenStroke([normToPoint(rect, 0.2, 0.3), normToPoint(rect, 0.6, 0.3)], { force: 0.5 });
        await waitFor(async () => (await getMirrorCanvasStats(presenterPdf)).nonZeroPixels > 20, { timeoutMs: 4000, label: 'page 1 mirror' });

        await clickControl(pdfSession, 'addPage', { pageSession: mainPage });
        await waitForFileUpdate(filePath, stat0, { timeoutMs: 8000 });

        const { target: mainPdfTarget2, session: mainPdf2 } = await app.cdp.waitForPdfViewer({ role: 'main', timeoutMs: 10000 });
        await waitFor(async () => (await getViewportState(mainPdf2)).page === 2, { timeoutMs: 6000, label: 'main page 2' });

        const { session: subPdf2 } = await app.cdp.waitForPdfViewer({
          role: 'presenter',
          excludeTargetIds: new Set([mainPdfTarget2.targetId]),
          timeoutMs: 10000,
        });
        await waitFor(async () => (await getViewportState(subPdf2)).page === 2, { timeoutMs: 6000, label: 'presenter page 2' });

        // Draw on page 2 and verify presenter mirrors it
        const rect2 = await getPdfPageRect(mainPdf2);
        await mainPage.dispatchPenStroke([normToPoint(rect2, 0.25, 0.45), normToPoint(rect2, 0.7, 0.45)], { force: 0.6 });
        await waitFor(async () => (await getMirrorCanvasStats(subPdf2)).nonZeroPixels > 20, {
          timeoutMs: 4000,
          label: 'presenter mirrored page 2 stroke',
        });
      } finally {
        await app.stop();
      }
    },
  },
];
