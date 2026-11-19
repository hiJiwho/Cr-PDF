/* Cr-PDF outer PDF viewer patch (v7):
 * - Guaranteed Ink2 draw mode enabled by default on PDF load
 * - Native Ink2 right-side palette shown by default; palette toggle button hides/shows ONLY the palette while keeping pen active
 * - Page addition dialog asking where to insert (default: at the end, or specific page number)
 * - Auto-save on window close (crpdf:save-now / beforeunload), periodic autosave, and debounced save after pen strokes
 * - Presenter second screen mirrors rendered main screen strokes in real time via live canvas overlay + seamless PDF refresh
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
      autosaveIntervalSec: 30,
      autosaveEnabled: true,
    },
    saving: false,
    lastViewportKey: '',
    autosaveTimer: null,
    strokeSaveTimer: null,
    channelReady: false,
    inkActivated: false,
    mirrorStrokes: [],
    activeStrokeMap: new Map(),
  };

  let bc = null;
  let topBarEl = null;
  let paletteBtnEl = null;
  let addPageModalEl = null;
  let toastEl = null;
  let mirrorCanvas = null;
  let laserOverlay = null;
  let laserDot = null;

  // Block right-click context menu everywhere in PDF viewer
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

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

  function getPdfViewer() {
    return document.querySelector('pdf-viewer');
  }

  function getViewport() {
    const v = getPdfViewer();
    return v ? (v.viewport || v.viewport_ || null) : null;
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

  async function goHome() {
    if (!state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    showToast('자동 저장 후 홈으로 이동...');
    await performRealInk2Save({ reason: 'home' });
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

    // 1. Click native #annotate button in viewer-toolbar if available and enabled
    if (btn && !btn.disabled) {
      try {
        btn.click();
      } catch {
        // ignore
      }
      if (isInk2ModeCurrentlyOn()) {
        state.inkActivated = true;
        return true;
      }
    }

    // 2. Call viewer-toolbar.toggleAnnotation() directly if available
    if (toolbar && typeof toolbar.toggleAnnotation === 'function') {
      try {
        toolbar.toggleAnnotation();
      } catch {
        // ignore
      }
      if (isInk2ModeCurrentlyOn()) {
        state.inkActivated = true;
        return true;
      }
    }

    // 3. Dispatch annotation-mode-toggled / toggle-annotation event from toolbar
    if (toolbar) {
      try {
        toolbar.dispatchEvent(new CustomEvent('annotation-mode-toggled', {
          detail: { value: true },
          bubbles: true,
          composed: true,
        }));
      } catch {
        // ignore
      }
      if (isInk2ModeCurrentlyOn()) {
        state.inkActivated = true;
        return true;
      }
    }

    // 4. Direct controller fallback
    const ctrl = v && (v.currentController_ || v.pluginController_);
    if (ctrl && typeof ctrl.setAnnotationMode === 'function') {
      try {
        ctrl.setAnnotationMode('draw');
        state.inkActivated = true;
        return true;
      } catch {
        // ignore
      }
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
    // Always keep Ink2 pen draw mode active; only hide/show the side palette UI
    if (!isInk2ModeCurrentlyOn()) {
      ensureInk2DrawActive();
    }
    state.paletteCollapsed = !state.paletteCollapsed;
    const v = getPdfViewer();
    if (v) v.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    document.body.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    if (paletteBtnEl) paletteBtnEl.classList.toggle('active', !state.paletteCollapsed);
    showToast(state.paletteCollapsed ? '팔레트 숨김 (펜 필기 유지)' : '팔레트 표시', 1300);
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
        scheduleAutosaveTimer();
      }
    } catch {
      // ignore
    }
  }

  /**
   * Triggers Chromium 150's REAL native Ink2 save (SaveRequestType.ANNOTATION = 'ANNOTATION').
   * CrPdfClient::OnFileDialog / OnBeforeDownload silently overwrites <AppData>/Cr-PDF/notes/<docName> with zero dialog!
   */
  async function performRealInk2Save({ reason = 'manual' } = {}) {
    if (state.saving || state.isPresenter) return false;
    state.saving = true;
    try {
      const v = getPdfViewer();
      const toolbar = v?.shadowRoot?.querySelector('viewer-toolbar');

      let triggered = false;
      if (toolbar) {
        try {
          toolbar.dispatchEvent(new CustomEvent('save', {
            detail: 'ANNOTATION',
            bubbles: true,
            composed: true,
          }));
          triggered = true;
        } catch {
          // ignore
        }
      }

      if (!triggered && v && typeof v.onToolbarSave_ === 'function') {
        try {
          v.onToolbarSave_(new CustomEvent('save', { detail: 'ANNOTATION' }));
          triggered = true;
        } catch {
          // ignore
        }
      }

      if (!triggered) {
        const dlBtn = findDeep(document, 'viewer-download-controls #download, #downloads #download, #download');
        if (dlBtn) {
          dlBtn.click();
          triggered = true;
        }
      }

      if (triggered) {
        if (reason === 'manual') showToast('판서 저장 완료');
        setTimeout(() => {
          sendBroadcast({ type: 'doc_updated', reason });
        }, 420);
        return true;
      }
      if (reason === 'manual') showToast('저장 컨트롤을 찾지 못했습니다');
      return false;
    } finally {
      setTimeout(() => { state.saving = false; }, 500);
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

  function schedulePostStrokeSave() {
    if (state.isPresenter) return;
    if (state.strokeSaveTimer) clearTimeout(state.strokeSaveTimer);
    state.strokeSaveTimer = setTimeout(() => {
      if (!state.saving && isPdfLoaded()) {
        performRealInk2Save({ reason: 'stroke' });
      }
    }, 900);
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
            <input type="radio" name="crpdf-add-pos" value="custom">
            <span>지정 페이지에 넣기:</span>
            <input type="number" id="crpdf-add-page-num" min="1" max="201" value="1">
          </label>
        </div>
        <div class="crpdf-add-actions">
          <button type="button" class="btn-cancel" id="crpdf-add-cancel">취소</button>
          <button type="button" class="btn-confirm" id="crpdf-add-confirm">추가</button>
        </div>
      `;
      document.body.appendChild(addPageModalEl);

      const numInput = addPageModalEl.querySelector('#crpdf-add-page-num');
      const customRadio = addPageModalEl.querySelector('input[value="custom"]');
      numInput.addEventListener('focus', () => {
        customRadio.checked = true;
      });

      addPageModalEl.querySelector('#crpdf-add-cancel').addEventListener('click', () => {
        addPageModalEl.hidden = true;
      });

      addPageModalEl.querySelector('#crpdf-add-confirm').addEventListener('click', async () => {
        const mode = addPageModalEl.querySelector('input[name="crpdf-add-pos"]:checked')?.value || 'end';
        const pageNum = parseInt(numInput.value, 10);
        addPageModalEl.hidden = true;
        await executeAddPage(mode === 'custom' && Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : -1);
      });
    }

    const total = getPageCount();
    const numInput = addPageModalEl.querySelector('#crpdf-add-page-num');
    if (numInput) {
      numInput.max = String(total + 1);
      numInput.value = String(total + 1);
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
    showToast('판서 저장 후 페이지 추가 중...');
    await performRealInk2Save({ reason: 'pre-add-page' });
    await new Promise((r) => setTimeout(r, 450));
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
    sendBroadcast({ type: 'doc_updated', reason: 'add-page' });
    await fetch(`${state.apiOrigin}/api/open-pdf?name=${encodeURIComponent(state.docName)}&page=${targetPage}`, {
      method: 'POST',
    });
  }

  async function openScreenSharePresenter() {
    if (!state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    // Save current annotations first so the Presenter window opens with the latest ink immediately
    await performRealInk2Save({ reason: 'pre-presenter' });
    await new Promise((r) => setTimeout(r, 380));
    try {
      const res = await fetch(`${state.apiOrigin}/api/open-presenter?name=${encodeURIComponent(state.docName)}`, {
        method: 'POST',
      });
      if (res.ok) {
        showToast('화면공유 창을 열었습니다');
      } else {
        showToast('화면공유 창 열기 실패');
      }
    } catch {
      showToast('화면공유 요청 오류');
    }
  }

  function sendBroadcast(msg) {
    if (!bc) return;
    try {
      bc.postMessage({ ...msg, senderId, ts: Date.now() });
    } catch {
      // ignore
    }
  }

  function getCurrentViewportPayload() {
    if (!isPdfLoaded()) return null;
    try {
      const v = getPdfViewer();
      const vp = getViewport();
      const scroller = v?.shadowRoot?.querySelector('#scroller') || document.scrollingElement || document.documentElement;
      const page = vp && typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
      const zoom = vp && typeof vp.getZoom === 'function' ? vp.getZoom() : 1;
      const scrollX = scroller ? scroller.scrollLeft : 0;
      const scrollY = scroller ? scroller.scrollTop : 0;
      return { type: 'viewport', page, zoom, scrollX, scrollY };
    } catch {
      return null;
    }
  }

  function ensureMirrorCanvas() {
    if (!state.isPresenter) return null;
    if (!mirrorCanvas) {
      mirrorCanvas = document.createElement('canvas');
      mirrorCanvas.id = 'crpdf-mirror-canvas';
      document.body.appendChild(mirrorCanvas);
      const resize = () => {
        mirrorCanvas.width = window.innerWidth || 1280;
        mirrorCanvas.height = window.innerHeight || 800;
        redrawMirrorCanvas();
      };
      window.addEventListener('resize', resize);
      resize();
    }
    return mirrorCanvas;
  }

  function redrawMirrorCanvas() {
    if (!state.isPresenter) return;
    const cvs = ensureMirrorCanvas();
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    for (const s of state.mirrorStrokes) {
      if (!s.points || s.points.length === 0) continue;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = s.color || '#111827';
      ctx.lineWidth = s.width || 3.5;
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const pt = s.points[i];
        const px = pt.x * cvs.width;
        const py = pt.y * cvs.height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function handleIncomingLiveStroke(msg) {
    if (!state.isPresenter) return;
    if (msg.op === 'start') {
      const stroke = {
        id: msg.strokeId,
        color: '#0F172A',
        width: 3.5,
        points: [{ x: msg.x, y: msg.y }],
      };
      state.mirrorStrokes.push(stroke);
      state.activeStrokeMap.set(msg.strokeId, stroke);
      redrawMirrorCanvas();
    } else if (msg.op === 'move' || msg.op === 'end') {
      const stroke = state.activeStrokeMap.get(msg.strokeId);
      if (stroke) {
        stroke.points.push({ x: msg.x, y: msg.y });
        if (msg.op === 'end') {
          state.activeStrokeMap.delete(msg.strokeId);
        }
        redrawMirrorCanvas();
      }
    }
  }

  function setupBroadcastChannel() {
    if (state.channelReady) return;
    state.channelReady = true;
    let receivedInitialViewport = false;
    bc = new BroadcastChannel(`crpdf-sync:${state.docName}`);
    bc.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.senderId === senderId) return;

      if (msg.type === 'presenter_ready' && !state.isPresenter) {
        const vp = getCurrentViewportPayload();
        if (vp) sendBroadcast(vp);
      } else if (msg.type === 'viewport' && state.isPresenter) {
        receivedInitialViewport = true;
        applyIncomingViewport(msg);
      } else if (msg.type === 'live_stroke' && state.isPresenter) {
        handleIncomingLiveStroke(msg);
      } else if (msg.type === 'doc_updated' && state.isPresenter) {
        // Reload presenter window quietly while preserving current viewport so saved ink renders crisply
        state.mirrorStrokes = [];
        state.activeStrokeMap.clear();
        window.location.reload();
      } else if (msg.type === 'laser') {
        renderLaserDot(msg);
      }
    });

    if (state.isPresenter) {
      ensureMirrorCanvas();
      sendBroadcast({ type: 'presenter_ready' });
      setTimeout(() => {
        if (!receivedInitialViewport) {
          sendBroadcast({ type: 'presenter_ready' });
        }
      }, 500);
    }
  }

  function applyIncomingViewport(msg) {
    if (!isPdfLoaded()) return;
    const vp = getViewport();
    if (vp) {
      try {
        if (typeof msg.zoom === 'number' && typeof vp.setZoom === 'function') {
          const curZoom = typeof vp.getZoom === 'function' ? vp.getZoom() : null;
          if (curZoom === null || Math.abs(curZoom - msg.zoom) > 0.001) {
            vp.setZoom(msg.zoom);
          }
        }
        if (typeof msg.scrollY !== 'number' && typeof msg.page === 'number' && typeof vp.goToPage === 'function') {
          vp.goToPage(Math.max(0, msg.page - 1));
        }
      } catch {
        // ignore
      }
    }
    const v = getPdfViewer();
    const scroller = v?.shadowRoot?.querySelector('#scroller') || document.scrollingElement;
    if (scroller && typeof msg.scrollY === 'number') {
      scroller.scrollTo(msg.scrollX || 0, msg.scrollY || 0);
    }
  }

  function ensureLaserOverlay() {
    if (!laserOverlay) {
      laserOverlay = document.createElement('div');
      laserOverlay.id = 'crpdf-laser-overlay';
      laserDot = document.createElement('div');
      laserDot.id = 'crpdf-laser-dot';
      laserOverlay.appendChild(laserDot);
      document.body.appendChild(laserOverlay);

      if (state.isPresenter) {
        laserOverlay.addEventListener('mousemove', (ev) => {
          const rect = laserOverlay.getBoundingClientRect();
          const xPct = rect.width > 0 ? ((ev.clientX - rect.left) / rect.width) * 100 : 0;
          const yPct = rect.height > 0 ? ((ev.clientY - rect.top) / rect.height) * 100 : 0;
          const payload = { type: 'laser', role: 'presenter', visible: true, xPct, yPct };
          renderLaserDot(payload);
          sendBroadcast(payload);
        });
        laserOverlay.addEventListener('mouseleave', () => {
          const payload = { type: 'laser', role: 'presenter', visible: false, xPct: 0, yPct: 0 };
          renderLaserDot(payload);
          sendBroadcast(payload);
        });
      }
    }
  }

  function renderLaserDot(msg) {
    ensureLaserOverlay();
    if (!laserDot) return;
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
      { key: 'add', title: '새 페이지 추가 (맨 뒤 또는 원하는 페이지 지정)', onClick: toggleAddPageModal },
      { key: 'save', title: '판서 포함 즉시 저장 (Ctrl+S)', onClick: () => performRealInk2Save({ reason: 'manual' }) },
      { key: 'share', title: '발표용 화면공유 창 열기 (실시간 판서 미러링)', onClick: openScreenSharePresenter },
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
    } else {
      buildTopRightActions();
      fetchHostConfig();
      scheduleAutosaveTimer();
    }
    setupBroadcastChannel();
    ensureLaserOverlay();
  }

  function setupListeners() {
    window.addEventListener('crpdf:host-url', (ev) => {
      if (ev && ev.detail) onHostUrlReady(ev.detail);
    });

    window.addEventListener('crpdf:save-now', () => {
      if (!state.isPresenter) {
        performRealInk2Save({ reason: 'close' });
      }
    });

    // Listen to live pen strokes from inner plugin wrapper
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'crpdf:ink_stroke' && !state.isPresenter) {
        if (!isInk2ModeCurrentlyOn()) return;
        sendBroadcast({
          type: 'live_stroke',
          op: msg.op,
          strokeId: msg.strokeId,
          x: msg.x,
          y: msg.y,
        });
        if (msg.op === 'end') {
          schedulePostStrokeSave();
        }
      }
    });

    const saveOnExit = () => {
      if (!state.isPresenter && isPdfLoaded()) {
        performRealInk2Save({ reason: 'close' });
      }
    };
    window.addEventListener('beforeunload', saveOnExit);
    window.addEventListener('pagehide', saveOnExit);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveOnExit();
    });

    window.addEventListener('keydown', (e) => {
      if (state.isPresenter) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        performRealInk2Save({ reason: 'manual' });
      }
    }, true);

    setInterval(() => {
      if (state.isPresenter || !state.channelReady) return;
      const payload = getCurrentViewportPayload();
      if (!payload) return;
      const key = `${payload.page}|${payload.zoom.toFixed(3)}|${Math.round(payload.scrollX)}|${Math.round(payload.scrollY)}`;
      if (key !== state.lastViewportKey) {
        state.lastViewportKey = key;
        sendBroadcast(payload);
      }
    }, 120);
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
