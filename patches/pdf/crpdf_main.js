/* Cr-PDF outer PDF viewer patch (v6):
 * - Native Ink2 draw mode enabled by default + working Palette toggle
 * - Blocks right-click context menu
 * - Real Ink2 annotation save via Chrome's native SaveRequestType.ANNOTATION ('ANNOTATION') -> C++ silent AppData overwrite
 * - Hides Drive / Download / Print in Chrome's viewer-toolbar and places Home / Palette / +Page / Save / Screen Share seamlessly in top-right
 * - Native C++ Presenter window (/api/open-presenter) + BroadcastChannel sync & laser pointer
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
    channelReady: false,
    inkActivated: false,
  };

  let bc = null;
  let topBarEl = null;
  let paletteBtnEl = null;
  let toastEl = null;
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

  function isPdfLoaded() {
    const vp = getViewport();
    return Boolean(vp && vp.documentDimensions_ && vp.documentDimensions_.pageDimensions && vp.documentDimensions_.pageDimensions.length > 0);
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
    return findDeep(document, '#annotate, cr-icon-button#annotate, [id="annotate"]');
  }

  function ensureInk2DrawActive() {
    if (state.isPresenter) return false;
    const btn = findAnnotateButton();
    if (!btn || btn.disabled) return false;
    const active = btn.hasAttribute('active') || btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('active');
    if (!active) {
      try {
        btn.click();
        state.inkActivated = true;
      } catch {
        return false;
      }
    } else {
      state.inkActivated = true;
    }
    return true;
  }

  function autoOpenNativeInk2Palette() {
    if (state.isPresenter) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      injectToolbarCleanupCss();
      if (ensureInk2DrawActive()) {
        clearInterval(timer);
        if (paletteBtnEl) paletteBtnEl.classList.toggle('active', !state.paletteCollapsed);
        return;
      }
      if (attempts >= 60) clearInterval(timer);
    }, 250);
  }

  function togglePalettePopup() {
    // Make sure Ink2 draw mode is active first
    ensureInk2DrawActive();
    state.paletteCollapsed = !state.paletteCollapsed;
    const v = getPdfViewer();
    if (v) v.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    document.body.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    if (paletteBtnEl) paletteBtnEl.classList.toggle('active', !state.paletteCollapsed);
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

      // Path 1: Dispatch native 'save' event with SaveRequestType.ANNOTATION ('ANNOTATION')
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

      // Path 2: Fallback to clicking hidden native download control
      if (!triggered) {
        const dlBtn = findDeep(document, 'viewer-download-controls #download, #downloads #download, #download');
        if (dlBtn) {
          dlBtn.click();
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
      setTimeout(() => { state.saving = false; }, 600);
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

  async function handleAddPage() {
    if (state.isPresenter || !state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    showToast('판서 저장 후 페이지 추가 중...');
    await performRealInk2Save({ reason: 'pre-add-page' });
    // Brief wait so C++ silent file write completes before appending page
    await new Promise((r) => setTimeout(r, 450));
    const res = await fetch(`${state.apiOrigin}/api/notebooks/${encodeURIComponent(state.docName)}/add-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      showToast('페이지 추가 실패');
      return;
    }
    const data = await res.json();
    const nextPage = data.pages || 1;
    await fetch(`${state.apiOrigin}/api/open-pdf?name=${encodeURIComponent(state.docName)}&page=${nextPage}`, {
      method: 'POST',
    });
  }

  async function openScreenSharePresenter() {
    if (!state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
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
      const page = typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
      const zoom = typeof vp.getZoom === 'function' ? vp.getZoom() : 1;
      const scrollX = scroller ? scroller.scrollLeft : 0;
      const scrollY = scroller ? scroller.scrollTop : 0;
      return { type: 'viewport', page, zoom, scrollX, scrollY };
    } catch {
      return null;
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
      } else if (msg.type === 'doc_updated' && state.isPresenter) {
        window.location.reload();
      } else if (msg.type === 'laser') {
        renderLaserDot(msg);
      }
    });

    if (state.isPresenter) {
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

    const items = [
      { key: 'palette', label: '팔레트', title: '필기 팔레트 열기/접기', onClick: togglePalettePopup },
      { key: 'add', label: '+ 페이지', title: '맨 뒤에 새 페이지 추가', onClick: handleAddPage },
      { key: 'save', label: '저장', title: '판서 포함 즉시 저장 (Ctrl+S)', onClick: () => performRealInk2Save({ reason: 'manual' }) },
      { key: 'share', label: '화면공유', title: '발표용 세컨 화면 열기', onClick: openScreenSharePresenter },
      { key: 'home', label: '홈', title: '라이브러리로 돌아가기', onClick: goHome },
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
      btn.textContent = item.label;
      btn.title = item.title;
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
    }, 150);
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
