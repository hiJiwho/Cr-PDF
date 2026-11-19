/**
 * Shared opaque-box E2E interaction & assertion helpers for Cr-PDF Tiers 1–4.
 *
 * Uses only public DOM / Shadow DOM semantics, CDP events, HTTP APIs,
 * filesystem inspection, and CLI execution (scripts/patch_pak.py).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT,
  createSyntheticPakV5,
  inspectPdfBuffer,
  parsePakV5,
} from './harness.mjs';
import { PRESENTER_TITLE } from './cdp_client.mjs';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, { timeoutMs = 10000, pollMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  let lastVal = null;
  while (Date.now() < deadline) {
    try {
      const val = await predicate();
      if (val) return val;
      lastVal = val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollMs);
  }
  const detail = lastErr ? `lastError=${lastErr.message}` : `lastValue=${JSON.stringify(lastVal)}`;
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} (${detail})`);
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function assertNoTmpFiles(dir) {
  const files = fs.readdirSync(dir);
  const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0, `Expected 0 lingering .tmp files in ${dir}, found: ${tmpFiles.join(', ')}`);
}

export async function waitForFileUpdate(filePath, prevStat, { timeoutMs = 6000, requireSizeIncrease = false } = {}) {
  return waitFor(
    () => {
      if (!fs.existsSync(filePath)) return null;
      const st = fs.statSync(filePath);
      const mtimeChanged = !prevStat || st.mtimeMs > prevStat.mtimeMs;
      const sizeOk = !requireSizeIncrease || !prevStat || st.size > prevStat.size;
      if (mtimeChanged && sizeOk && st.size > 0) {
        const buf = fs.readFileSync(filePath);
        const info = inspectPdfBuffer(buf);
        if (info.validHeader && info.validEof) {
          return { stat: st, buffer: buf, pdf: info };
        }
      }
      return null;
    },
    { timeoutMs, pollMs: 120, label: `file update on ${path.basename(filePath)}` },
  );
}

/**
 * Navigates the main window to a PDF URL and attaches to both the main page
 * and the Chromium PDF viewer extension target.
 */
export async function openPdfInMainWindow(app, pdfUrlPath, { timeoutMs = 15000 } = {}) {
  const { session: mainPage } = await app.cdp.waitForMainPage(app.appPort, { timeoutMs });
  const targetUrl = pdfUrlPath.startsWith('http') ? pdfUrlPath : `${app.baseUrl}${pdfUrlPath}`;
  await mainPage.navigate(targetUrl, { timeoutMs });

  const { target: pdfTarget, session: pdfSession } = await app.cdp.waitForPdfViewer({
    role: 'main',
    timeoutMs,
  });

  // Wait for PDF viewer + Cr-PDF toolbar to initialize
  await waitFor(
    async () => {
      const ready = await pdfSession.evaluate(`(() => {
        const viewer = document.querySelector('pdf-viewer');
        return Boolean(viewer && viewer.shadowRoot);
      })()`).catch(() => false);
      return ready;
    },
    { timeoutMs, pollMs: 120, label: 'pdf-viewer shadowRoot' },
  );

  return { mainPage, pdfTarget, pdfSession };
}

/**
 * Queries the visible PDF page / plugin bounding rect inside a PDF viewer target.
 */
export async function getPdfPageRect(pdfSession) {
  return waitFor(
    async () => {
      const rect = await pdfSession.evaluate(`(() => {
        function findDeep(root, sel) {
          if (!root || !root.querySelector) return null;
          const d = root.querySelector(sel);
          if (d) return d;
          for (const n of root.querySelectorAll('*')) {
            if (n.shadowRoot) {
              const r = findDeep(n.shadowRoot, sel);
              if (r) return r;
            }
          }
          return null;
        }
        const candidates = [
          findDeep(document, '#crpdf-laser-overlay'),
          findDeep(document, '#crpdf-ink-mirror'),
          findDeep(document, '#plugin'),
          findDeep(document, 'embed[type="application/x-google-chrome-pdf"]'),
          findDeep(document, '#content'),
          document.querySelector('pdf-viewer'),
        ].filter(Boolean);
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width >= 100 && r.height >= 100) {
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        return null;
      })()`);
      return rect;
    },
    { timeoutMs: 10000, pollMs: 100, label: 'visible PDF page rect' },
  );
}

/**
 * Converts normalized page coordinates (xFrac, yFrac in 0..1) into viewport pixel coordinates.
 */
export function normToPoint(rect, xFrac, yFrac) {
  return {
    x: rect.x + rect.width * xFrac,
    y: rect.y + rect.height * yFrac,
  };
}

/**
 * Selector dictionary for opaque-box toolbar control lookup across Shadow DOM.
 */
export const TOOLBAR_SELECTORS = {
  toolbarBar: ['#crpdf-toolbar', '[data-crpdf-toolbar]', '.crpdf-toolbar'],
  pen: ['[data-crpdf-tool="pen"]', '#crpdf-tool-pen', '[aria-label*="Pen" i]', '[aria-label*="펜"]'],
  highlighter: [
    '[data-crpdf-tool="highlighter"]',
    '#crpdf-tool-highlighter',
    '[aria-label*="Highlighter" i]',
    '[aria-label*="형광펜"]',
  ],
  eraser: ['[data-crpdf-tool="eraser"]', '#crpdf-tool-eraser', '[aria-label*="Eraser" i]', '[aria-label*="지우개"]'],
  undo: ['[data-crpdf-action="undo"]', '#crpdf-undo', '#undo', '[aria-label*="Undo" i]', '[aria-label*="실행 취소"]'],
  save: ['[data-crpdf-action="save"]', '#crpdf-save', '#save', '[aria-label*="Save" i]', '[aria-label*="저장"]'],
  addPage: [
    '[data-crpdf-action="add-page"]',
    '#crpdf-add-page',
    '[aria-label*="Add Page" i]',
    '[aria-label*="페이지 추가"]',
  ],
  screenShare: [
    '[data-crpdf-action="screen-share"]',
    '#crpdf-screen-share',
    '[aria-label*="Screen Share" i]',
    '[aria-label*="화면공유"]',
    '[aria-label*="발표"]',
  ],
  library: [
    '[data-crpdf-action="library"]',
    '#crpdf-library',
    '[aria-label*="Library" i]',
    '[aria-label*="Home" i]',
    '[aria-label*="라이브러리"]',
    '[aria-label*="홈"]',
  ],
  dockToggle: [
    '[data-crpdf-action="dock-toggle"]',
    '#crpdf-dock-toggle',
    '[aria-label*="Dock" i]',
    '[aria-label*="도킹"]',
  ],
  colorPreset: [
    '[data-crpdf-color]',
    '.crpdf-color-btn',
    '[data-crpdf-role="color"]',
  ],
};

/**
 * Queries the first matching element from a list of candidate selectors across Shadow DOM.
 */
export async function queryFirstDeep(session, selectors) {
  for (const sel of selectors) {
    const res = await session.queryDeep(sel);
    if (res.found) return { selector: sel, ...res };
  }
  return { found: false, selector: selectors[0] };
}

export async function waitForFirstDeep(session, selectors, { visible = true, timeoutMs = 10000 } = {}) {
  return waitFor(
    async () => {
      const res = await queryFirstDeep(session, selectors);
      if (res.found && (!visible || res.visible)) return res;
      return null;
    },
    { timeoutMs, pollMs: 100, label: `selector in ${JSON.stringify(selectors)}` },
  );
}

export async function clickControl(pdfSession, controlKey, { pageSession = null, timeoutMs = 10000 } = {}) {
  const selectors = TOOLBAR_SELECTORS[controlKey];
  if (!selectors) throw new Error(`Unknown controlKey: ${controlKey}`);
  const match = await waitForFirstDeep(pdfSession, selectors, { visible: true, timeoutMs });
  await pdfSession.clickDeep(match.selector, { pageSession, timeoutMs });
  return match;
}

/**
 * Selects pseudo-pressure maxLevel (1..5) on the minimal toolbar.
 */
export async function setPressureMaxLevel(pdfSession, level, { pageSession = null } = {}) {
  assert.ok(level >= 1 && level <= 5, `maxLevel must be 1..5, got ${level}`);
  const selectors = [
    `[data-crpdf-max-level="${level}"]`,
    `#crpdf-pressure-${level}`,
    `[data-max-level="${level}"]`,
  ];
  const direct = await queryFirstDeep(pdfSession, selectors);
  if (direct.found && direct.visible) {
    await pdfSession.clickDeep(direct.selector, { pageSession });
    return;
  }

  // Fallback: <select> or range input with data-crpdf-max-level-select
  const updated = await pdfSession.evaluate(`(() => {
    function findDeep(root, sel) {
      if (!root || !root.querySelector) return null;
      const d = root.querySelector(sel);
      if (d) return d;
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) {
          const r = findDeep(n.shadowRoot, sel);
          if (r) return r;
        }
      }
      return null;
    }
    const selEl = findDeep(document, '[data-crpdf-max-level-select], #crpdf-max-level, select[aria-label*="필압"], select[aria-label*="Pressure" i]');
    if (!selEl) return false;
    selEl.value = String(${level});
    selEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    selEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  })()`, { userGesture: true });

  assert.equal(updated, true, `Could not find maxLevel=${level} control in minimal toolbar`);
}

/**
 * Inspects active Ink2 brush state (type & size) via public DOM attributes or Chromium PDF viewer API.
 */
export async function getActiveBrushState(pdfSession) {
  return pdfSession.evaluate(`(async () => {
    function findDeep(root, sel) {
      if (!root || !root.querySelector) return null;
      const d = root.querySelector(sel);
      if (d) return d;
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) {
          const r = findDeep(n.shadowRoot, sel);
          if (r) return r;
        }
      }
      return null;
    }
    const root = document.documentElement;
    const bar = findDeep(document, '#crpdf-toolbar, [data-crpdf-toolbar], .crpdf-toolbar');
    const attrSize = bar?.getAttribute('data-crpdf-active-size') ?? root?.getAttribute('data-crpdf-active-size');
    const attrTool = bar?.getAttribute('data-crpdf-active-tool') ?? root?.getAttribute('data-crpdf-active-tool');
    const attrMax = bar?.getAttribute('data-crpdf-max-level') ?? root?.getAttribute('data-crpdf-max-level');

    let pluginBrush = null;
    try {
      const viewer = document.querySelector('pdf-viewer');
      const ctrl = viewer?.currentController_ || viewer?.pluginController_;
      if (ctrl && typeof ctrl.getAnnotationBrush === 'function') {
        const res = await ctrl.getAnnotationBrush();
        if (res?.data) pluginBrush = res.data;
      }
    } catch {
      // Ignore if controller method differs; fall back to public attributes
    }

    return {
      tool: pluginBrush?.type ?? attrTool ?? null,
      size: pluginBrush?.size != null ? Number(pluginBrush.size) : (attrSize != null ? Number(attrSize) : null),
      maxLevel: attrMax != null ? Number(attrMax) : null,
    };
  })()`);
}

/**
 * Reads the Ink2 Undo button disabled state.
 */
export async function getUndoState(pdfSession) {
  const snap = await queryFirstDeep(pdfSession, TOOLBAR_SELECTORS.undo);
  return {
    found: snap.found,
    visible: Boolean(snap.visible),
    disabled: Boolean(snap.disabled),
  };
}

/**
 * Reads current PDF viewport state (page, pageCount, zoom, scrollTop, scrollLeft).
 */
export async function getViewportState(pdfSession) {
  return pdfSession.evaluate(`(() => {
    const viewer = document.querySelector('pdf-viewer');
    const vp = viewer?.viewport || viewer?.viewport_;
    const scroller = viewer?.shadowRoot?.querySelector('#scroller')
      || document.scrollingElement
      || document.documentElement;
    const pageIndicator = viewer?.shadowRoot?.querySelector('viewer-toolbar')?.shadowRoot?.querySelector('#pages');
    const page = typeof vp?.getMostVisiblePage === 'function'
      ? vp.getMostVisiblePage() + 1
      : Number(document.documentElement.getAttribute('data-crpdf-page') || pageIndicator?.pageNo || 1);
    const pageCount = Number(
      vp?.documentDimensions_?.pageDimensions?.length
      || document.documentElement.getAttribute('data-crpdf-page-count')
      || pageIndicator?.docLength
      || 1
    );
    const zoom = typeof vp?.getZoom === 'function'
      ? vp.getZoom()
      : Number(document.documentElement.getAttribute('data-crpdf-zoom') || 1);
    return {
      page,
      pageCount,
      zoom,
      scrollTop: scroller ? scroller.scrollTop : 0,
      scrollLeft: scroller ? scroller.scrollLeft : 0,
      scrollHeight: scroller ? scroller.scrollHeight : 0,
      clientHeight: scroller ? scroller.clientHeight : 0,
    };
  })()`);
}

/**
 * Navigates main PDF viewer to a specific 1-based page number.
 */
export async function goToPdfPage(pdfSession, pageNum) {
  await pdfSession.evaluate(`(() => {
    const viewer = document.querySelector('pdf-viewer');
    const vp = viewer?.viewport || viewer?.viewport_;
    if (vp && typeof vp.goToPage === 'function') {
      vp.goToPage(${pageNum - 1});
      return true;
    }
    window.location.hash = '#page=${pageNum}';
    return true;
  })()`);
}

/**
 * Sets zoom level on main PDF viewer (e.g. 1.5 for 150%).
 */
export async function setPdfZoom(pdfSession, zoomLevel) {
  await pdfSession.evaluate(`(() => {
    const viewer = document.querySelector('pdf-viewer');
    const vp = viewer?.viewport || viewer?.viewport_;
    if (vp && typeof vp.setZoom === 'function') {
      vp.setZoom(${zoomLevel});
      return true;
    }
    return false;
  })()`);
}

/**
 * Inspects the presenter's #crpdf-ink-mirror canvas pixel alpha statistics,
 * including quadrant breakdown (Q1 top-left, Q2 top-right, Q3 bottom-left, Q4 bottom-right).
 */
export async function getMirrorCanvasStats(presenterPdfSession) {
  return presenterPdfSession.evaluate(`(() => {
    function findDeep(root, sel) {
      if (!root || !root.querySelector) return null;
      const d = root.querySelector(sel);
      if (d) return d;
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) {
          const r = findDeep(n.shadowRoot, sel);
          if (r) return r;
        }
      }
      return null;
    }
    const canvas = findDeep(document, '#crpdf-ink-mirror, canvas[data-crpdf-mirror]');
    if (!canvas) return { found: false, nonZeroPixels: 0, q1: 0, q2: 0, q3: 0, q4: 0 };
    const w = canvas.width;
    const h = canvas.height;
    if (w <= 0 || h <= 0) return { found: true, width: w, height: h, nonZeroPixels: 0, q1: 0, q2: 0, q3: 0, q4: 0 };
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;
    const halfW = w >> 1;
    const halfH = h >> 1;
    let nonZeroPixels = 0;
    let q1 = 0, q2 = 0, q3 = 0, q4 = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > 0) {
          nonZeroPixels++;
          if (y < halfH && x < halfW) q1++;
          else if (y < halfH && x >= halfW) q2++;
          else if (y >= halfH && x < halfW) q3++;
          else q4++;
        }
      }
    }
    return { found: true, width: w, height: h, nonZeroPixels, q1, q2, q3, q4 };
  })()`);
}

/**
 * Inspects the red laser dot overlay element's visibility, color, and page-normalized position.
 */
export async function getLaserState(pdfSession) {
  return pdfSession.evaluate(`(() => {
    function findDeep(root, sel) {
      if (!root || !root.querySelector) return null;
      const d = root.querySelector(sel);
      if (d) return d;
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) {
          const r = findDeep(n.shadowRoot, sel);
          if (r) return r;
        }
      }
      return null;
    }
    const dot = findDeep(document, '#crpdf-laser-dot, [data-crpdf-laser-dot], .crpdf-laser-dot');
    const pageEl = findDeep(document, '#crpdf-laser-overlay, #crpdf-ink-mirror, #plugin, embed[type="application/x-google-chrome-pdf"], #content');
    if (!dot) return { found: false, visible: false };
    const style = window.getComputedStyle(dot);
    const rect = dot.getBoundingClientRect();
    const pageRect = pageEl ? pageEl.getBoundingClientRect() : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    const visible = style.display !== 'none'
      && style.visibility !== 'hidden'
      && parseFloat(style.opacity) > 0
      && rect.width > 0
      && rect.height > 0;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const xPct = pageRect.width > 0 ? ((cx - pageRect.x) / pageRect.width) * 100 : null;
    const yPct = pageRect.height > 0 ? ((cy - pageRect.y) / pageRect.height) * 100 : null;
    const rgbMatch = (style.backgroundColor || '').match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
    const rgb = rgbMatch ? { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) } : null;
    return { found: true, visible, xPct, yPct, rgb, backgroundColor: style.backgroundColor, rect };
  })()`);
}

/**
 * Attaches an independent passive BroadcastChannel observer inside a target origin.
 */
export async function attachBroadcastRecorder(session, docName, key = '__crpdf_bc_log') {
  const channelName = `crpdf-sync:${docName}`;
  await session.evaluate(`(() => {
    window[${JSON.stringify(key)}] = [];
    if (window[${JSON.stringify(key + '_ch')}]) {
      try { window[${JSON.stringify(key + '_ch')}].close(); } catch {}
    }
    const ch = new BroadcastChannel(${JSON.stringify(channelName)});
    ch.addEventListener('message', (ev) => {
      window[${JSON.stringify(key)}].push(ev.data);
    });
    window[${JSON.stringify(key + '_ch')}] = ch;
    return true;
  })()`);
}

export async function readBroadcastRecorder(session, key = '__crpdf_bc_log') {
  return session.evaluate(`(() => (window[${JSON.stringify(key)}] || []).slice())()`);
}

/**
 * Opens the presenter popup via the Screen Share toolbar button and attaches to both
 * its page target and its PDF viewer target.
 */
export async function openPresenterSubWindow(app, mainPdfSession, mainPageSession, mainPdfTargetId) {
  await clickControl(mainPdfSession, 'screenShare', { pageSession: mainPageSession });
  const { target: presenterPageTarget, session: presenterPage } = await app.cdp.waitForPresenterPage(app.appPort, {
    timeoutMs: 12000,
  });
  assert.ok(
    presenterPageTarget.title === PRESENTER_TITLE || presenterPageTarget.url.includes('crpdf_role=presenter'),
    `Expected presenter title "${PRESENTER_TITLE}", got "${presenterPageTarget.title}" (${presenterPageTarget.url})`,
  );

  const exclude = new Set(mainPdfTargetId ? [mainPdfTargetId] : []);
  const { target: presenterPdfTarget, session: presenterPdf } = await app.cdp.waitForPdfViewer({
    role: 'presenter',
    excludeTargetIds: exclude,
    timeoutMs: 12000,
  });

  return { presenterPageTarget, presenterPage, presenterPdfTarget, presenterPdf };
}

// ---- Standalone scripts/patch_pak.py Helpers ----

export const SAMPLE_MAIN_JS = `
// Synthetic Chromium PDF viewer main.js matching content fingerprint
import {PdfViewerElement} from './pdf_viewer.js';
function initViewer() {
  const viewer = document.querySelector('pdf-viewer');
  return viewer ? viewer.shadowRoot : null;
}
window.addEventListener('DOMContentLoaded', initViewer);
`;

export const SAMPLE_PLUGIN_WRAPPER_JS = `
// Synthetic Chromium pdf_internal_plugin_wrapper.js matching content fingerprint
(function() {
  const plugin = document.querySelector('embed[type="application/x-google-chrome-pdf"]');
  window.addEventListener('pointerdown', (e) => {
    if (plugin) plugin.dataset.lastPointer = e.pointerType;
  });
})();
`;

export function buildSyntheticResourcesPak({
  mainId = 2001,
  wrapperId = 2002,
  dummyId = 2003,
  compression = 'none',
  aliases = [],
  extraEntries = [],
} = {}) {
  const entries = [
    { id: mainId, data: SAMPLE_MAIN_JS, compression },
    { id: wrapperId, data: SAMPLE_PLUGIN_WRAPPER_JS, compression },
    { id: dummyId, data: '/* unrelated dummy resource */ export const DUMMY = 42;\n', compression: 'none' },
    ...extraEntries,
  ];
  return createSyntheticPakV5(entries, { aliases, encoding: 1 });
}

/**
 * Invokes python3 scripts/patch_pak.py and returns { status, stdout, stderr }.
 */
export function runPatchPakCli({ input, output, patches = path.join(REPO_ROOT, 'patches', 'pdf'), verify = false }) {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'patch_pak.py');
  const args = [scriptPath, '--input', input, '--output', output, '--patches', patches];
  if (verify) args.push('--verify');
  const res = spawnSync('python3', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error || null,
  };
}

/**
 * Verifies a JavaScript source string parses cleanly with `node --check`.
 */
export function assertJsSyntaxValid(jsCode, label = 'script.mjs') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crpdf-jscheck-'));
  const filePath = path.join(tmpDir, label);
  try {
    fs.writeFileSync(filePath, jsCode, 'utf8');
    const res = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
    assert.equal(res.status, 0, `JS syntax check failed for ${label}:\n${res.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function countMarkers(text, marker) {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(marker, pos)) !== -1) {
    count++;
    pos += marker.length;
  }
  return count;
}

/**
 * Computes expected effectiveLevel under the finalized 0/20/40/60/80% pseudo-pressure spec.
 */
export function expectedPseudoPressureLevel(pressure, maxLevel) {
  let rawStep;
  if (pressure < 0.2) rawStep = 1;
  else if (pressure < 0.4) rawStep = 2;
  else if (pressure < 0.6) rawStep = 3;
  else if (pressure < 0.8) rawStep = 4;
  else rawStep = 5;
  return Math.min(Math.max(1, maxLevel), rawStep);
}

/**
 * Verifies DataPack v5 structural invariants after patching.
 */
export function assertPakV5Structure(pakBuf) {
  const parsed = parsePakV5(pakBuf);
  assert.equal(parsed.version, 5, 'DataPack version must be 5');
  assert.equal(parsed.sentinelId, 0, 'Sentinel ID must be 0');
  assert.equal(parsed.sentinelOffset, parsed.fileSize, 'Sentinel offset must equal file size');
  for (let i = 1; i < parsed.entries.length; i++) {
    assert.ok(
      parsed.entries[i].id > parsed.entries[i - 1].id,
      `Resource IDs must be strictly sorted ascending: ${parsed.entries[i - 1].id} vs ${parsed.entries[i].id}`,
    );
  }
  return parsed;
}
