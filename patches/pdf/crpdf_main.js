/* Cr-PDF outer PDF viewer patch (v14):
 * - Zero window.parent.postMessage in OOPIF (prevents bad IPC reason 319).
 * - Uses BroadcastChannel('crpdf-live-ink') between inner plugin frame, outer Main window, and Presenter sub-window:
 *   1. Real-time 60fps live ink stroke rendering on `#crpdf-mirror-canvas` in Presenter sub-window
 *      as the user draws, plus automatic background PDF save & refresh after stroke end!
 *   2. Equal N-partition pressure stepping (`Math.floor(p * N) + 1`, e.g., N=3 -> 0~33%=1, 33~66%=2, 66~100%=3)
 *      applied to BOTH Pen AND Highlighter (`형광펜`) tools in Chromium's Ink2 brush selector!
 * - Top Chrome toolbar removed from taking vertical space; floating pill toolbar shifted slightly lower (`top: 22px`).
 * - Page insertion ("지정 페이지 뒤에 추가"): C++ `/add-page` synchronously waits for Ink2 save download completion
 *   before appending the new page so existing pages and ink are never replaced or lost.
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_MAIN_INSTALLED__) return;
  globalThis.__CRPDF_MAIN_INSTALLED__ = true;

  const PRESENTER_TITLE = '[화면공유용] 판서 화면';
  const senderId = `win_${Math.random().toString(36).slice(2, 10)}`;

  const state = {
    apiOrigin: '',
    docName: 'notebook.pdf',
    originalUrl: '',
    isPresenter: false,
    paletteCollapsed: false,
    config: {
      autosaveIntervalSec: 15,
      autosaveEnabled: true,
      pseudoPressure: true,
      maxLevel: 3,
    },
    saving: false,
    pendingSaveAfterCurrent: false,
    lastViewportKey: '',
    lastSentPage: -1,
    pendingViewportMsg: null,
    autosaveTimer: null,
    postStrokeTimer: null,
    channelReady: false,
    inkActivated: false,
    lastUndoDisabled: true,
    lastHasEdits: false,
    activeBrushTool: 'pen', // 'pen' | 'highlighter' | 'eraser'
    activeBrushColor: '#14b8a6',
    activeBrushSizeIdx: 2, // 0..4
  };

  let bc = null;
  let liveInkBc = null;
  let topBarEl = null;
  let paletteBtnEl = null;
  let addPageModalEl = null;
  let toastEl = null;
  let laserOverlay = null;
  let laserDot = null;
  let mirrorCanvas = null;
  let mirrorCtx = null;
  const liveStrokes = new Map();

  // Block right-click context menu everywhere in PDF viewer
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Prevent mouse back/forward buttons (button 3 & 4)
  function installBackNavigationBlocker() {
    const blockMouseBackForward = (e) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('mousedown', blockMouseBackForward, true);
    window.addEventListener('mouseup', blockMouseBackForward, true);
    window.addEventListener('pointerdown', blockMouseBackForward, true);
    window.addEventListener('pointerup', blockMouseBackForward, true);
    window.addEventListener('auxclick', blockMouseBackForward, true);
  }

  function parseRealUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      state.originalUrl = rawUrl;
      state.apiOrigin = u.origin;
      state.isPresenter = u.searchParams.get('crpdf_role') === 'presenter';
      const qDoc = u.searchParams.get('doc');
      if (qDoc) {
        state.docName = qDoc;
      } else {
        const m = u.pathname.match(/\/pdf\/([^/?#]+)/);
        if (m && m[1]) {
          state.docName = decodeURIComponent(m[1]);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function findDeep(root, selector) {
    if (!root || !root.querySelector) return null;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        const hit = findDeep(all[i].shadowRoot, selector);
        if (hit) return hit;
      }
    }
    return null;
  }

  function findAllDeep(root, selector, out = []) {
    if (!root || !root.querySelectorAll) return out;
    const hits = root.querySelectorAll(selector);
    for (let i = 0; i < hits.length; i++) out.push(hits[i]);
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        findAllDeep(all[i].shadowRoot, selector, out);
      }
    }
    return out;
  }

  function getPdfViewer() {
    return document.querySelector('pdf-viewer');
  }

  function getViewport() {
    const v = getPdfViewer();
    return v ? (v.viewport || v.viewport_ || null) : null;
  }

  function getScroller() {
    const v = getPdfViewer();
    return (
      v?.shadowRoot?.querySelector('#scroller') ||
      v?.shadowRoot?.querySelector('#main') ||
      document.scrollingElement ||
      document.documentElement
    );
  }

  function getCurrentPageNumber() {
    const vp = getViewport();
    if (vp && typeof vp.getMostVisiblePage === 'function') {
      return Math.max(1, vp.getMostVisiblePage() + 1);
    }
    return 1;
  }

  function getPageCount() {
    const vp = getViewport();
    const dims = vp && vp.documentDimensions_ && vp.documentDimensions_.pageDimensions;
    if (Array.isArray(dims) && dims.length > 0) return dims.length;
    const v = getPdfViewer();
    if (v && typeof v.docLength_ === 'number' && v.docLength_ > 0) return v.docLength_;
    return 1;
  }

  function isPdfLoaded() {
    const vp = getViewport();
    if (vp && vp.documentDimensions_ && vp.documentDimensions_.pageDimensions && vp.documentDimensions_.pageDimensions.length > 0) {
      return true;
    }
    const v = getPdfViewer();
    return Boolean(v && (v.loadState_ === 'success' || v.pluginController_ || v.currentController_));
  }

  function injectCssIntoRoot(root) {
    const css = globalThis.__CRPDF_STYLE_CSS__;
    if (!css || !root) return;
    if (root.querySelector && root.querySelector('#crpdf-injected-style')) return;
    const style = document.createElement('style');
    style.id = 'crpdf-injected-style';
    style.textContent = css;
    root.appendChild(style);
  }

  function injectToolbarCleanupCss() {
    const v = getPdfViewer();
    if (!v || !v.shadowRoot) return;
    injectCssIntoRoot(v.shadowRoot);
    const toolbar = v.shadowRoot.querySelector('viewer-toolbar');
    if (toolbar && toolbar.shadowRoot) {
      injectCssIntoRoot(toolbar.shadowRoot);
    }
  }

  function showToast(msg, ms = 1800) {
    if (!toastEl || state.isPresenter) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('visible');
    }, ms);
  }

  // Read currently active Ink2 brush tool ('pen' | 'highlighter' | 'eraser') and color from viewer-ink-side-panel
  function inspectCurrentInk2Brush() {
    if (state.isPresenter) return;
    const sidePanel = findDeep(document, 'viewer-ink-side-panel, viewer-side-panel, #side-panel');
    if (!sidePanel) return;

    const brushSelector = findDeep(sidePanel, 'ink-brush-selector');
    if (brushSelector) {
      const currentType = brushSelector.currentType || brushSelector.currentType_;
      if (typeof currentType === 'string' && currentType) {
        state.activeBrushTool = currentType.toLowerCase();
      } else {
        const activeToolBtn = findDeep(
          brushSelector,
          '[checked], [active], [aria-pressed="true"], [aria-selected="true"]'
        );
        if (activeToolBtn) {
          const idOrVal = String(activeToolBtn.id || activeToolBtn.dataset?.brush || activeToolBtn.value || '').toLowerCase();
          if (idOrVal.includes('highlighter')) state.activeBrushTool = 'highlighter';
          else if (idOrVal.includes('eraser')) state.activeBrushTool = 'eraser';
          else if (idOrVal.includes('pen')) state.activeBrushTool = 'pen';
        }
      }
    }

    const colorSelector = findDeep(sidePanel, 'ink-color-selector');
    if (colorSelector) {
      if (typeof colorSelector.currentColor === 'string' && colorSelector.currentColor) {
        state.activeBrushColor = colorSelector.currentColor;
      } else {
        const checkedColor = findDeep(
          colorSelector,
          'input[checked], [checked], [active], [aria-checked="true"], [aria-pressed="true"]'
        );
        if (checkedColor) {
          const c =
            checkedColor.value ||
            checkedColor.dataset?.color ||
            checkedColor.style?.backgroundColor ||
            checkedColor.style?.color;
          if (c) state.activeBrushColor = c;
        }
      }
    }
  }

  // Apply equal-partition pressure level (1..maxLevel) to Ink2 size selector for BOTH Pen AND Highlighter!
  function applyInk2PressureLevel(level, maxLevel) {
    if (state.isPresenter || !state.config.pseudoPressure) return;
    inspectCurrentInk2Brush();
    // Apply pressure stepping to BOTH Pen AND Highlighter (skip only Eraser)
    if (state.activeBrushTool === 'eraser') return;

    const N = Math.max(1, Math.min(5, Math.round(Number(maxLevel) || state.config.maxLevel || 3)));
    const lv = Math.max(1, Math.min(N, Math.round(Number(level) || 1)));

    // Map stage lv (1..N) across the 5 available Ink2 size buttons (indices 0..4)
    let sizeIdx = 0;
    if (N === 1) {
      sizeIdx = 1;
    } else {
      sizeIdx = Math.max(0, Math.min(4, Math.round(((lv - 1) / (N - 1)) * 4)));
    }
    state.activeBrushSizeIdx = sizeIdx;

    const sidePanel = findDeep(document, 'viewer-ink-side-panel, viewer-side-panel, #side-panel');
    if (!sidePanel) return;

    const sizeSelector = findDeep(sidePanel, 'ink-size-selector');
    const root = sizeSelector || sidePanel;
    const sizeButtons = findAllDeep(
      root,
      'cr-icon-button[data-size], cr-icon-button[data-index], button[data-size], input[type="radio"], cr-icon-button'
    ).filter((el) => {
      const id = String(el.id || '').toLowerCase();
      const cls = String(el.className || '').toLowerCase();
      return (
        el.hasAttribute('data-size') ||
        el.hasAttribute('data-index') ||
        id.includes('size') ||
        cls.includes('size') ||
        (sizeSelector && sizeSelector.shadowRoot && sizeSelector.shadowRoot.contains(el))
      );
    });

    if (sizeButtons.length >= 2) {
      const targetIdx = Math.min(sizeButtons.length - 1, Math.max(0, Math.round((sizeIdx / 4) * (sizeButtons.length - 1))));
      const btn = sizeButtons[targetIdx];
      if (btn && !btn.checked && !btn.hasAttribute('checked') && btn.getAttribute('aria-checked') !== 'true') {
        try {
          btn.click();
        } catch {}
      }
    }
  }

  async function goHome() {
    if (!state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    showToast('자동 저장 후 홈으로 이동...');
    await performRealInk2Save({ reason: 'home', force: true });
    await new Promise((r) => setTimeout(r, 450));
    try {
      await fetch(`${state.apiOrigin}/api/go-home`, { method: 'POST' });
    } catch {
      window.open(`${state.apiOrigin}/`, '_top');
    }
  }

  function findAnnotateButton() {
    const v = getPdfViewer();
    const toolbar = v?.shadowRoot?.querySelector('viewer-toolbar');
    if (toolbar && toolbar.shadowRoot) {
      const btn = toolbar.shadowRoot.querySelector('#annotate, cr-icon-button#annotate, [id="annotate"]');
      if (btn) return btn;
    }
    return findDeep(document, '#annotate, cr-icon-button#annotate, [id="annotate"]');
  }

  function isInk2ModeCurrentlyOn() {
    const v = getPdfViewer();
    if (v && (v.annotationMode_ === 'draw' || v.inInk2Mode_ === true || v.annotationMode === 'draw')) {
      return true;
    }
    const toolbar = v?.shadowRoot?.querySelector('viewer-toolbar');
    if (toolbar && (toolbar.annotationMode === 'draw' || toolbar.annotationMode === 1 || toolbar.annotationMode_ === 'draw')) {
      return true;
    }
    const sidePanel = findDeep(document, 'viewer-ink-side-panel, viewer-side-panel, #side-panel');
    if (sidePanel && !sidePanel.hidden) return true;
    const btn = findAnnotateButton();
    if (btn && (btn.hasAttribute('active') || btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('active'))) {
      return true;
    }
    return false;
  }

  function ensureInk2DrawActive() {
    if (state.isPresenter) return false;
    if (isInk2ModeCurrentlyOn()) {
      state.inkActivated = true;
      return true;
    }

    const v = getPdfViewer();
    const toolbar = v?.shadowRoot?.querySelector('viewer-toolbar');
    const btn = findAnnotateButton();

    if (btn && !btn.disabled) {
      try {
        btn.click();
      } catch {}
      if (isInk2ModeCurrentlyOn()) {
        state.inkActivated = true;
        return true;
      }
    }

    if (toolbar && typeof toolbar.toggleAnnotation === 'function') {
      try {
        toolbar.toggleAnnotation();
      } catch {}
      if (isInk2ModeCurrentlyOn()) {
        state.inkActivated = true;
        return true;
      }
    }

    if (toolbar) {
      try {
        toolbar.dispatchEvent(new CustomEvent('annotation-mode-toggled', {
          detail: { value: true },
          bubbles: true,
          composed: true,
        }));
      } catch {}
      if (isInk2ModeCurrentlyOn()) {
        state.inkActivated = true;
        return true;
      }
    }

    const ctrl = v && (v.currentController_ || v.pluginController_);
    if (ctrl && typeof ctrl.setAnnotationMode === 'function') {
      try {
        ctrl.setAnnotationMode('draw');
        state.inkActivated = true;
        return true;
      } catch {}
    }

    return false;
  }

  function autoOpenNativeInk2Palette() {
    if (state.isPresenter) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      injectToolbarCleanupCss();
      if (isPdfLoaded() && ensureInk2DrawActive()) {
        clearInterval(timer);
        if (paletteBtnEl) paletteBtnEl.classList.toggle('active', !state.paletteCollapsed);
        return;
      }
      if (attempts >= 80) clearInterval(timer);
    }, 200);
  }

  function togglePalettePopup() {
    ensureInk2DrawActive();
    state.paletteCollapsed = !state.paletteCollapsed;
    const v = getPdfViewer();
    if (v) v.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    document.body.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    if (paletteBtnEl) paletteBtnEl.classList.toggle('active', !state.paletteCollapsed);
    setTimeout(() => {
      if (!isInk2ModeCurrentlyOn()) {
        ensureInk2DrawActive();
      }
    }, 60);
    showToast(state.paletteCollapsed ? '팔레트 숨김 (펜 필기 유지)' : '팔레트 표시', 1300);
  }

  function schedulePostStrokeSave() {
    if (state.isPresenter) return;
    if (state.postStrokeTimer) {
      clearTimeout(state.postStrokeTimer);
    }
    state.postStrokeTimer = setTimeout(() => {
      state.postStrokeTimer = null;
      if (!isPdfLoaded()) return;
      if (state.saving) {
        state.pendingSaveAfterCurrent = true;
      } else {
        performRealInk2Save({ reason: 'stroke' });
      }
    }, 120);
  }

  function broadcastPressureConfigToPlugin() {
    if (!liveInkBc || state.isPresenter) return;
    try {
      liveInkBc.postMessage({
        type: 'config',
        maxLevel: state.config.maxLevel,
        pseudoPressure: state.config.pseudoPressure,
      });
    } catch {}
  }

  async function fetchHostConfig() {
    if (!state.apiOrigin) return;
    try {
      const res = await fetch(`${state.apiOrigin}/api/config`, { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        if (typeof cfg.autosaveIntervalSec === 'number') {
          state.config.autosaveIntervalSec = cfg.autosaveIntervalSec;
        }
        if (typeof cfg.autosaveEnabled === 'boolean') {
          state.config.autosaveEnabled = cfg.autosaveEnabled;
        }
        if (typeof cfg.pseudoPressure === 'boolean') {
          state.config.pseudoPressure = cfg.pseudoPressure;
        }
        if (typeof cfg.maxPressureLevel === 'number') {
          state.config.maxLevel = Math.max(1, Math.min(5, cfg.maxPressureLevel));
        } else if (typeof cfg.maxLevel === 'number') {
          state.config.maxLevel = Math.max(1, Math.min(5, cfg.maxLevel));
        }
        broadcastPressureConfigToPlugin();
        scheduleAutosaveTimer();
      }
    } catch {}
  }

  async function performRealInk2Save({ reason = 'manual', force = false } = {}) {
    if (state.isPresenter) return false;
    if (state.saving && !force) {
      state.pendingSaveAfterCurrent = true;
      return false;
    }
    state.saving = true;
    state.pendingSaveAfterCurrent = false;
    try {
      const page = getCurrentPageNumber();
      syncPageToHost(page);
      const vpPayload = getCurrentViewportPayload();
      if (vpPayload) sendBroadcast(vpPayload);

      const v = getPdfViewer();
      if (!v) return false;

      const ctrl = v.currentController_ || v.pluginController_;
      // SaveRequestType.ANNOTATION === 1 in Chromium 150 PDF viewer (0 = ORIGINAL, 1 = ANNOTATION, 2 = EDITED)
      // 1. Direct PDF byte extraction from PDFium plugin controller -> POST /api/save (100% reliable, never opens action menu!)
      if (ctrl && typeof ctrl.save === 'function' && state.apiOrigin) {
        try {
          let result = await ctrl.save(1);
          if (!result || !result.dataToSave) {
            result = await ctrl.save(2);
          }
          if (!result || !result.dataToSave) {
            result = await ctrl.save('ANNOTATION');
          }
          if (result && result.dataToSave) {
            const bytes = new Uint8Array(result.dataToSave);
            if (bytes.byteLength >= 5) {
              const res = await fetch(
                `${state.apiOrigin}/api/save?name=${encodeURIComponent(state.docName)}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/pdf' },
                  body: bytes,
                }
              );
              if (res.ok) {
                if (typeof v.setShowBeforeUnloadDialog_ === 'function') {
                  try { v.setShowBeforeUnloadDialog_(false); } catch {}
                }
                if (reason === 'manual') showToast('판서 저장 완료');
                const vpAfter = getCurrentViewportPayload();
                sendBroadcast({ type: 'doc_updated', reason, viewport: vpAfter || vpPayload });
                return true;
              }
            }
          }
        } catch {
          // Fall through to viewer save methods below
        }
      }

      // 2. Direct call on pdf-viewer's internal save_(SaveRequestType.ANNOTATION = 1)
      let triggered = false;
      if (typeof v.save_ === 'function') {
        try {
          v.save_(1);
          triggered = true;
        } catch {}
      }

      if (!triggered && typeof v.onToolbarSave_ === 'function') {
        try {
          v.onToolbarSave_(new CustomEvent('save', { detail: 1 }));
          triggered = true;
        } catch {}
      }

      // 3. Dispatch numeric SaveRequestType.ANNOTATION (1) from viewer-download-controls / viewer-toolbar
      const toolbar = v.shadowRoot?.querySelector('viewer-toolbar');
      const dlControls = toolbar?.shadowRoot?.querySelector('viewer-download-controls') ||
                         findDeep(document, 'viewer-download-controls');
      if (!triggered && dlControls) {
        try {
          dlControls.dispatchEvent(new CustomEvent('save', {
            detail: 1,
            bubbles: true,
            composed: true,
          }));
          triggered = true;
        } catch {}
      }

      if (!triggered && toolbar) {
        try {
          toolbar.dispatchEvent(new CustomEvent('save', {
            detail: 1,
            bubbles: true,
            composed: true,
          }));
          triggered = true;
        } catch {}
      }

      if (!triggered) {
        // Click #download-edited specifically if action menu exists, otherwise #download
        const editedBtn = findDeep(document, '#download-edited');
        const dlBtn = editedBtn || findDeep(document, 'viewer-download-controls #download, #downloads #download, #download');
        if (dlBtn) {
          dlBtn.click();
          const afterMenuEdited = findDeep(document, '#download-edited');
          if (afterMenuEdited && afterMenuEdited !== dlBtn) {
            try { afterMenuEdited.click(); } catch {}
          }
          triggered = true;
        }
      }

      if (triggered) {
        if (reason === 'manual') showToast('판서 저장 완료');
        return true;
      }
      if (reason === 'manual') showToast('저장 컨트롤을 찾지 못했습니다');
      return false;
    } finally {
      setTimeout(() => {
        state.saving = false;
        if (state.pendingSaveAfterCurrent) {
          state.pendingSaveAfterCurrent = false;
          performRealInk2Save({ reason: 'stroke' });
        }
      }, 200);
    }
  }

  function scheduleAutosaveTimer() {
    if (state.autosaveTimer) {
      clearInterval(state.autosaveTimer);
      state.autosaveTimer = null;
    }
    const sec = Number(state.config.autosaveIntervalSec) || 0;
    if (!state.config.autosaveEnabled || sec <= 0 || state.isPresenter) return;
    state.autosaveTimer = setInterval(() => {
      if (!state.saving && isPdfLoaded()) {
        performRealInk2Save({ reason: 'autosave' });
      }
    }, sec * 1000);
  }

  function toggleAddPageModal() {
    if (state.isPresenter) return;
    if (!addPageModalEl) {
      addPageModalEl = document.createElement('div');
      addPageModalEl.id = 'crpdf-add-page-modal';
      addPageModalEl.hidden = true;
      addPageModalEl.innerHTML = `
        <h4>새 페이지 추가 위치</h4>
        <div class="crpdf-add-row">
          <label>
            <input type="radio" name="crpdf-add-pos" value="end" checked>
            <span>맨 뒤에 추가 (기본)</span>
          </label>
          <label>
            <input type="radio" name="crpdf-add-pos" value="after">
            <span>다음 페이지 뒤에 추가:</span>
            <input type="number" id="crpdf-add-page-num" min="1" max="200" value="1">
          </label>
        </div>
        <div class="crpdf-add-actions">
          <button type="button" class="btn-cancel" id="crpdf-add-cancel">취소</button>
          <button type="button" class="btn-confirm" id="crpdf-add-confirm">추가</button>
        </div>
      `;
      document.body.appendChild(addPageModalEl);

      const numInput = addPageModalEl.querySelector('#crpdf-add-page-num');
      const afterRadio = addPageModalEl.querySelector('input[value="after"]');
      numInput.addEventListener('focus', () => {
        afterRadio.checked = true;
      });

      addPageModalEl.querySelector('#crpdf-add-cancel').addEventListener('click', () => {
        addPageModalEl.hidden = true;
      });

      addPageModalEl.querySelector('#crpdf-add-confirm').addEventListener('click', async () => {
        const mode = addPageModalEl.querySelector('input[name="crpdf-add-pos"]:checked')?.value || 'end';
        const afterPage = parseInt(numInput.value, 10);
        const total = getPageCount();
        addPageModalEl.hidden = true;
        // Insert AFTER `afterPage`: new page becomes 1-based page `afterPage + 1` and all pages after it shift by +1
        if (mode === 'after' && Number.isFinite(afterPage) && afterPage >= 1 && afterPage < total) {
          await executeAddPage(afterPage + 1);
        } else {
          await executeAddPage(-1);
        }
      });
    }

    const total = getPageCount();
    const curPage = getCurrentPageNumber();
    const numInput = addPageModalEl.querySelector('#crpdf-add-page-num');
    if (numInput) {
      numInput.max = String(total);
      numInput.value = String(curPage);
    }
    const endRadio = addPageModalEl.querySelector('input[value="end"]');
    if (endRadio) endRadio.checked = true;
    addPageModalEl.hidden = !addPageModalEl.hidden;
  }

  async function executeAddPage(insertPage) {
    if (state.isPresenter || !state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    showToast('판서 저장 후 새 페이지 삽입 중...');
    // Server's /add-page endpoint now calls RequestPreAddPageSave() on C++ side and waits
    // until OnDownloadUpdated confirms the Ink2 save finished writing to disk!
    const payload = insertPage >= 1 ? { insertPage } : {};
    const res = await fetch(`${state.apiOrigin}/api/notebooks/${encodeURIComponent(state.docName)}/add-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      showToast('페이지 추가 실패');
      return;
    }
    const data = await res.json();
    const targetPage = insertPage >= 1 ? Math.min(insertPage, data.pages || 1) : (data.pages || 1);
    syncPageToHost(targetPage);
    await fetch(`${state.apiOrigin}/api/open-pdf?name=${encodeURIComponent(state.docName)}&page=${targetPage}`, {
      method: 'POST',
    });
  }

  async function openScreenSharePresenter() {
    if (!state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    const page = getCurrentPageNumber();
    syncPageToHost(page);
    await performRealInk2Save({ reason: 'pre-presenter', force: true });
    await new Promise((r) => setTimeout(r, 380));
    try {
      const res = await fetch(
        `${state.apiOrigin}/api/open-presenter?name=${encodeURIComponent(state.docName)}&page=${page}`,
        { method: 'POST' }
      );
      if (res.ok) {
        showToast('화면공유 창을 열었습니다');
      } else {
        showToast('화면공유 창 열기 실패');
      }
    } catch {
      showToast('화면공유 요청 오류');
    }
  }

  function syncPageToHost(page) {
    if (state.isPresenter || !state.apiOrigin || !(page >= 1)) return;
    fetch(`${state.apiOrigin}/api/presenter-page?page=${page}`, {
      method: 'POST',
    }).catch(() => {});
  }

  function sendBroadcast(msg) {
    if (!bc) return;
    try {
      bc.postMessage({ ...msg, senderId, ts: Date.now() });
    } catch {}
  }

  function getCurrentViewportPayload() {
    if (!isPdfLoaded()) return null;
    try {
      const vp = getViewport();
      const scroller = getScroller();
      const page = getCurrentPageNumber();
      const zoom = vp && typeof vp.getZoom === 'function' ? vp.getZoom() : 1;
      const pos = vp && vp.position ? vp.position : null;
      const scrollX = pos && typeof pos.x === 'number' ? pos.x : (scroller ? scroller.scrollLeft : 0);
      const scrollY = pos && typeof pos.y === 'number' ? pos.y : (scroller ? scroller.scrollTop : 0);
      const docW = scroller && scroller.scrollWidth > 0 ? scroller.scrollWidth : 1;
      const docH = scroller && scroller.scrollHeight > 0 ? scroller.scrollHeight : 1;
      const normX = scrollX / docW;
      const normY = scrollY / docH;
      return {
        type: 'viewport',
        page,
        zoom,
        scrollX,
        scrollY,
        normX,
        normY,
      };
    } catch {
      return null;
    }
  }

  // Real-time 60fps overlay canvas in Presenter sub-window for live strokes before PDF reload
  function ensurePresenterMirrorCanvas() {
    if (!state.isPresenter) return;
    if (!mirrorCanvas) {
      mirrorCanvas = document.createElement('canvas');
      mirrorCanvas.id = 'crpdf-mirror-canvas';
      document.body.appendChild(mirrorCanvas);
      mirrorCtx = mirrorCanvas.getContext('2d');
      const resize = () => {
        mirrorCanvas.width = window.innerWidth;
        mirrorCanvas.height = window.innerHeight;
        redrawLiveMirrorStrokes();
      };
      window.addEventListener('resize', resize);
      resize();
    }
  }

  function redrawLiveMirrorStrokes() {
    if (!state.isPresenter || !mirrorCtx || !mirrorCanvas) return;
    const w = mirrorCanvas.width;
    const h = mirrorCanvas.height;
    mirrorCtx.clearRect(0, 0, w, h);
    for (const s of liveStrokes.values()) {
      if (!s.points || s.points.length === 0) continue;
      mirrorCtx.save();
      mirrorCtx.lineCap = 'round';
      mirrorCtx.lineJoin = 'round';
      if (s.tool === 'highlighter') {
        mirrorCtx.globalAlpha = 0.38;
        mirrorCtx.lineWidth = (s.level || 2) * 6;
      } else {
        mirrorCtx.globalAlpha = 0.95;
        mirrorCtx.lineWidth = (s.level || 2) * 2.2;
      }
      mirrorCtx.strokeStyle = s.color || '#14b8a6';
      mirrorCtx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const pt = s.points[i];
        const x = pt.nx * w;
        const y = pt.ny * h;
        if (i === 0) mirrorCtx.moveTo(x, y);
        else mirrorCtx.lineTo(x, y);
      }
      if (s.points.length === 1) {
        const pt = s.points[0];
        mirrorCtx.lineTo(pt.nx * w + 0.1, pt.ny * h + 0.1);
      }
      mirrorCtx.stroke();
      mirrorCtx.restore();
    }
  }

  function setupLiveInkChannel() {
    if (liveInkBc) return;
    try {
      liveInkBc = new BroadcastChannel('crpdf-live-ink');
    } catch {
      return;
    }

    liveInkBc.addEventListener('message', (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object') return;

      if (!state.isPresenter) {
        // Main window receives pressure_level and ink_op from its inner plugin wrapper
        if (msg.type === 'pressure_level') {
          applyInk2PressureLevel(msg.level, msg.maxLevel);
        } else if (msg.type === 'ink_op') {
          inspectCurrentInk2Brush();
          // Relay enriched stroke (with current brush tool & color) to Presenter sub-window
          sendBroadcast({
            type: 'live_stroke',
            op: msg.op,
            id: msg.id,
            nx: msg.nx,
            ny: msg.ny,
            level: msg.level || 2,
            tool: msg.isEraser ? 'eraser' : state.activeBrushTool,
            color: state.activeBrushColor,
          });
          if (msg.op === 'end') {
            schedulePostStrokeSave();
          }
        }
      }
    });

    broadcastPressureConfigToPlugin();
  }

  function setupBroadcastChannel() {
    if (state.channelReady) return;
    state.channelReady = true;
    setupLiveInkChannel();

    bc = new BroadcastChannel(`crpdf-sync:${state.docName}`);
    bc.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.senderId === senderId) return;

      if (msg.type === 'presenter_ready' && !state.isPresenter) {
        const vp = getCurrentViewportPayload();
        if (vp) sendBroadcast(vp);
      } else if (msg.type === 'viewport' && state.isPresenter) {
        state.pendingViewportMsg = msg;
        applyIncomingViewport(msg);
      } else if (msg.type === 'live_stroke' && state.isPresenter) {
        ensurePresenterMirrorCanvas();
        if (msg.tool === 'eraser') return;
        if (msg.op === 'start') {
          liveStrokes.set(msg.id, {
            id: msg.id,
            tool: msg.tool || 'pen',
            color: msg.color || '#14b8a6',
            level: msg.level || 2,
            points: [{ nx: msg.nx, ny: msg.ny }],
          });
          redrawLiveMirrorStrokes();
        } else if (msg.op === 'move') {
          const s = liveStrokes.get(msg.id);
          if (s) {
            s.points.push({ nx: msg.nx, ny: msg.ny });
            redrawLiveMirrorStrokes();
          }
        } else if (msg.op === 'end') {
          const s = liveStrokes.get(msg.id);
          if (s) {
            s.points.push({ nx: msg.nx, ny: msg.ny });
            redrawLiveMirrorStrokes();
          }
        }
      }
    });

    if (state.isPresenter) {
      ensurePresenterMirrorCanvas();
      try {
        const cached = sessionStorage.getItem(`crpdf_vp_${state.docName}`);
        if (cached) {
          state.pendingViewportMsg = JSON.parse(cached);
        }
      } catch {}

      sendBroadcast({ type: 'presenter_ready' });
      const retryTimer = setInterval(() => {
        if (isPdfLoaded()) {
          if (state.pendingViewportMsg) applyIncomingViewport(state.pendingViewportMsg);
          clearInterval(retryTimer);
          return;
        }
        sendBroadcast({ type: 'presenter_ready' });
      }, 250);
      setTimeout(() => clearInterval(retryTimer), 5000);
    }
  }

  function applyIncomingViewport(msg) {
    if (!msg) return;
    try {
      sessionStorage.setItem(`crpdf_vp_${state.docName}`, JSON.stringify(msg));
    } catch {}
    if (!isPdfLoaded()) {
      state.pendingViewportMsg = msg;
      return;
    }

    const vp = getViewport();
    const scroller = getScroller();
    if (vp) {
      try {
        if (typeof msg.zoom === 'number' && msg.zoom > 0 && typeof vp.setZoom === 'function') {
          const curZoom = typeof vp.getZoom === 'function' ? vp.getZoom() : null;
          if (curZoom === null || Math.abs(curZoom - msg.zoom) > 0.001) {
            vp.setZoom(msg.zoom);
          }
        }
        if (typeof msg.page === 'number' && msg.page >= 1 && typeof vp.goToPage === 'function') {
          const curPage = getCurrentPageNumber();
          if (curPage !== msg.page) {
            vp.goToPage(Math.max(0, msg.page - 1));
          }
        }
        if (typeof msg.scrollX === 'number' && typeof msg.scrollY === 'number' && typeof vp.setPosition === 'function') {
          vp.setPosition({ x: msg.scrollX, y: msg.scrollY });
        }
      } catch {}
    }

    if (scroller) {
      if (typeof msg.scrollY === 'number' && msg.scrollY >= 0) {
        scroller.scrollTo(msg.scrollX || 0, msg.scrollY);
      } else if (typeof msg.normY === 'number' && scroller.scrollHeight > 0) {
        scroller.scrollTo((msg.normX || 0) * scroller.scrollWidth, msg.normY * scroller.scrollHeight);
      }
    }
  }

  function ensureLaserOverlay() {
    if (!state.isPresenter) return;
    if (!laserOverlay) {
      laserOverlay = document.createElement('div');
      laserOverlay.id = 'crpdf-laser-overlay';
      laserDot = document.createElement('div');
      laserDot.id = 'crpdf-laser-dot';
      laserOverlay.appendChild(laserDot);
      document.body.appendChild(laserOverlay);

      const updateLocalLaser = (ev) => {
        const rect = laserOverlay.getBoundingClientRect();
        const xPct = rect.width > 0 ? ((ev.clientX - rect.left) / rect.width) * 100 : 0;
        const yPct = rect.height > 0 ? ((ev.clientY - rect.top) / rect.height) * 100 : 0;
        renderLaserDot({ visible: true, xPct, yPct });
      };

      laserOverlay.addEventListener('pointermove', updateLocalLaser);
      laserOverlay.addEventListener('pointerdown', updateLocalLaser);
      laserOverlay.addEventListener('pointerleave', () => {
        renderLaserDot({ visible: false, xPct: 0, yPct: 0 });
      });
    }
  }

  function renderLaserDot(msg) {
    if (!state.isPresenter || !laserDot) return;
    if (!msg.visible) {
      laserDot.classList.remove('visible');
      return;
    }
    laserDot.classList.add('visible');
    laserDot.style.left = `${Math.max(0, Math.min(100, msg.xPct))}%`;
    laserDot.style.top = `${Math.max(0, Math.min(100, msg.yPct))}%`;
  }

  function buildTopRightActions() {
    if (state.isPresenter || topBarEl) return;
    topBarEl = document.createElement('div');
    topBarEl.id = 'crpdf-top-actions';

    const ICONS = {
      palette: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>',
      add: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
      save: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
      share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
      home: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    };

    const items = [
      { key: 'palette', title: '팔레트 표시/숨기기 (펜 필기는 계속 유지됩니다)', onClick: togglePalettePopup },
      { key: 'add', title: '새 페이지 추가 (맨 뒤 또는 지정 페이지 뒤에 추가)', onClick: toggleAddPageModal },
      { key: 'save', title: '판서 포함 즉시 저장 (Ctrl+S)', onClick: () => performRealInk2Save({ reason: 'manual', force: true }) },
      { key: 'share', title: '발표용 화면공유 창 열기 (페이지·배율·필기 실시간 동기화)', onClick: openScreenSharePresenter },
      { key: 'home', title: '라이브러리로 돌아가기', onClick: goHome },
    ];

    items.forEach((item, idx) => {
      if (idx === 4) {
        const sep = document.createElement('span');
        sep.className = 'crpdf-top-sep';
        topBarEl.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crpdf-top-btn';
      btn.innerHTML = ICONS[item.key] || '';
      btn.title = item.title;
      btn.setAttribute('aria-label', item.title);
      btn.addEventListener('click', item.onClick);
      if (item.key === 'palette') {
        paletteBtnEl = btn;
        btn.classList.add('active');
      }
      topBarEl.appendChild(btn);
    });

    document.body.appendChild(topBarEl);

    toastEl = document.createElement('div');
    toastEl.id = 'crpdf-toast';
    document.body.appendChild(toastEl);
  }

  function onHostUrlReady(rawUrl) {
    if (!parseRealUrl(rawUrl)) return;
    if (state.isPresenter) {
      document.title = PRESENTER_TITLE;
      document.body.classList.add('crpdf-presenter');
      if (topBarEl) topBarEl.remove();
      ensurePresenterMirrorCanvas();
      ensureLaserOverlay();
    } else {
      buildTopRightActions();
      fetchHostConfig();
      scheduleAutosaveTimer();
    }
    setupBroadcastChannel();
  }

  function setupListeners() {
    installBackNavigationBlocker();

    window.addEventListener('crpdf:host-url', (ev) => {
      if (ev && ev.detail) onHostUrlReady(ev.detail);
    });

    window.addEventListener('crpdf:save-now', () => {
      if (!state.isPresenter) {
        performRealInk2Save({ reason: 'close', force: true });
      }
    });

    window.addEventListener('crpdf:save-completed', () => {
      if (!state.isPresenter) {
        const vp = getCurrentViewportPayload();
        if (vp) sendBroadcast(vp);
      }
    });

    const saveOnExit = () => {
      if (!state.isPresenter && isPdfLoaded()) {
        performRealInk2Save({ reason: 'close', force: true });
      }
    };
    window.addEventListener('beforeunload', saveOnExit);
    window.addEventListener('pagehide', saveOnExit);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveOnExit();
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if (
        e.key === 'BrowserBack' ||
        e.key === 'BrowserForward' ||
        (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) ||
        (!isInput && e.key === 'Backspace')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      if (state.isPresenter) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        performRealInk2Save({ reason: 'manual', force: true });
      }
    }, true);

    setInterval(() => {
      if (!state.channelReady) return;
      if (state.isPresenter) {
        if (state.pendingViewportMsg && isPdfLoaded()) {
          const pending = state.pendingViewportMsg;
          state.pendingViewportMsg = null;
          applyIncomingViewport(pending);
        }
        return;
      }

      // Keep Ink2 draw mode active if it ever accidentally turns off while palette is collapsed
      if (isPdfLoaded() && state.inkActivated && !isInk2ModeCurrentlyOn()) {
        ensureInk2DrawActive();
      }

      const payload = getCurrentViewportPayload();
      if (!payload) return;
      if (payload.page !== state.lastSentPage) {
        state.lastSentPage = payload.page;
        syncPageToHost(payload.page);
      }
      const key = `${payload.page}|${payload.zoom.toFixed(3)}|${Math.round(payload.scrollX)}|${Math.round(payload.scrollY)}`;
      if (key !== state.lastViewportKey) {
        state.lastViewportKey = key;
        sendBroadcast(payload);
      }
    }, 100);
  }

  function bootstrap() {
    injectCssIntoRoot(document.head || document.documentElement);
    setupListeners();

    if (window.__CRPDF_HOST_URL__) {
      onHostUrlReady(window.__CRPDF_HOST_URL__);
    } else {
      parseRealUrl(document.referrer) || parseRealUrl(window.location.href);
      if (state.apiOrigin) onHostUrlReady(state.originalUrl);
    }

    const waitForViewer = setInterval(() => {
      const v = getPdfViewer();
      if (!v || !v.shadowRoot) return;
      injectToolbarCleanupCss();
      if (state.isPresenter) {
        v.classList.add('crpdf-presenter');
      } else {
        autoOpenNativeInk2Palette();
      }
      clearInterval(waitForViewer);
    }, 150);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
