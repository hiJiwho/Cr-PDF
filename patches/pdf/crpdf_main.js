/* Cr-PDF outer PDF viewer patch (v5):
 * - Uses C++-injected window.__CRPDF_HOST_URL__ (zero chrome.mimeHandlerPrivate errors!)
 * - Uses C++ /api/go-home and /api/open-pdf for 100% reliable Home & Add Page navigation
 * - Safely guards viewport queries (fixes Assertion failed: Could not find page for Y position: 0)
 * - Auto-opens Chrome's native Ink2 palette floated cleanly at top
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
    dirty: false,
    saving: false,
    version: 0,
    lastViewportKey: '',
    autosaveTimer: null,
    channelReady: false,
  };

  let bc = null;
  let pillEl = null;
  let toastEl = null;
  let laserOverlay = null;
  let laserDot = null;

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

  function getController() {
    const v = getPdfViewer();
    return v ? (v.currentController_ || v.pluginController_ || null) : null;
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
    try {
      await fetch(`${state.apiOrigin}/api/go-home`, { method: 'POST' });
    } catch {
      window.open(`${state.apiOrigin}/`, '_top');
    }
  }

  function autoOpenNativeInk2Palette() {
    if (state.isPresenter) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const annotateBtn = findDeep(document, '#annotate, cr-icon-button#annotate');
      if (annotateBtn && !annotateBtn.disabled && isPdfLoaded()) {
        clearInterval(timer);
        const pressed = annotateBtn.hasAttribute('active') || annotateBtn.getAttribute('aria-pressed') === 'true';
        if (!pressed) {
          try {
            annotateBtn.click();
          } catch {
            // ignore
          }
        }
        return;
      }
      if (attempts >= 50) clearInterval(timer);
    }, 250);
  }

  function togglePalettePopup() {
    state.paletteCollapsed = !state.paletteCollapsed;
    const v = getPdfViewer();
    if (v) v.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
    document.body.classList.toggle('crpdf-palette-collapsed', state.paletteCollapsed);
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

  async function performSilentSave({ reason = 'manual' } = {}) {
    if (state.saving || state.isPresenter || !state.apiOrigin) return false;
    state.saving = true;
    try {
      const ctrl = getController();
      let pdfBytes = null;
      if (ctrl && typeof ctrl.save === 'function') {
        try {
          const result = await ctrl.save(1);
          if (result && result.dataToSave) {
            pdfBytes = result.dataToSave;
          }
        } catch {
          // fallback cleanly
        }
      }
      if (!pdfBytes) {
        const resp = await fetch(`${state.apiOrigin}/pdf/${encodeURIComponent(state.docName)}`, { cache: 'no-store' });
        if (resp.ok) pdfBytes = await resp.arrayBuffer();
      }
      if (!pdfBytes) return false;

      const saveRes = await fetch(`${state.apiOrigin}/api/save?name=${encodeURIComponent(state.docName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: pdfBytes,
      });
      if (!saveRes.ok) throw new Error(`HTTP ${saveRes.status}`);

      state.dirty = false;
      state.version += 1;
      sendBroadcast({ type: 'ink_action', op: 'saved_checkpoint', version: state.version });
      if (reason === 'manual') showToast('저장 완료');
      return true;
    } catch (err) {
      if (reason === 'manual') showToast(`저장 실패: ${err.message}`);
      return false;
    } finally {
      state.saving = false;
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
        performSilentSave({ reason: 'autosave' });
      }
    }, sec * 1000);
  }

  async function handleAddPage() {
    if (state.isPresenter || !state.apiOrigin) {
      showToast('서버 연결 대기 중...');
      return;
    }
    showToast('페이지 추가 중...');
    await performSilentSave({ reason: 'pre-add-page' });
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
    sendBroadcast({ type: 'ink_action', op: 'saved_checkpoint', version: state.version + 1 });
    await fetch(`${state.apiOrigin}/api/open-pdf?name=${encodeURIComponent(state.docName)}&page=${nextPage}`, {
      method: 'POST',
    });
  }

  async function openScreenSharePresenter() {
    if (!state.apiOrigin) {
      showToast('서버 주소를 확인할 수 없습니다');
      return;
    }
    const presenterUrl = `${state.apiOrigin}/pdf/${encodeURIComponent(state.docName)}?crpdf_role=presenter&doc=${encodeURIComponent(state.docName)}`;
    let features = 'width=1024,height=768,menubar=no,toolbar=no,location=no,status=no';
    let extScreen = null;

    try {
      if (typeof window.getScreenDetails === 'function') {
        const details = await window.getScreenDetails();
        if (details && Array.isArray(details.screens) && details.screens.length > 1) {
          extScreen = details.screens.find((s) => s !== details.currentScreen) || details.screens[1];
          if (extScreen) {
            features = `left=${extScreen.availLeft},top=${extScreen.availTop},width=${extScreen.availWidth},height=${extScreen.availHeight},menubar=no,toolbar=no`;
          }
        }
      }
    } catch {
      // Single monitor fallback
    }

    const win = window.open(presenterUrl, 'crpdf_presenter', features);
    if (win && extScreen && win.document?.documentElement?.requestFullscreen) {
      try {
        await win.document.documentElement.requestFullscreen({ screen: extScreen });
      } catch {
        // ignore
      }
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
    bc = new BroadcastChannel(`crpdf-sync:${state.docName}`);
    bc.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.senderId === senderId) return;

      if (msg.type === 'presenter_ready' && !state.isPresenter) {
        const vp = getCurrentViewportPayload();
        if (vp) sendBroadcast(vp);
      } else if (msg.type === 'viewport' && state.isPresenter) {
        applyIncomingViewport(msg);
      } else if (msg.type === 'laser') {
        renderLaserDot(msg);
      }
    });

    if (state.isPresenter) {
      sendBroadcast({ type: 'presenter_ready' });
    }
  }

  function applyIncomingViewport(msg) {
    if (!isPdfLoaded()) return;
    const vp = getViewport();
    if (vp) {
      try {
        if (typeof msg.zoom === 'number' && typeof vp.setZoom === 'function') vp.setZoom(msg.zoom);
        if (typeof msg.page === 'number' && typeof vp.goToPage === 'function') vp.goToPage(Math.max(0, msg.page - 1));
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

  function buildFloatingPill() {
    if (state.isPresenter || pillEl) return;
    pillEl = document.createElement('div');
    pillEl.id = 'crpdf-dock-pill';

    const items = [
      { label: '홈', title: '라이브러리로 돌아가기', onClick: goHome },
      { label: '팔레트', title: '상단 팔레트 팝업 열기/닫기', onClick: togglePalettePopup },
      { label: '+ 페이지', title: '맨 뒤에 새 페이지 추가', onClick: handleAddPage },
      { label: '저장', title: 'AppData에 바로 저장 (Ctrl+S)', onClick: () => performSilentSave({ reason: 'manual' }) },
      { label: '화면공유', title: '발표용 판서 창 열기', onClick: openScreenSharePresenter },
    ];

    items.forEach((item, idx) => {
      if (idx > 0) {
        const sep = document.createElement('span');
        sep.className = 'crpdf-pill-sep';
        pillEl.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crpdf-pill-btn';
      btn.textContent = item.label;
      btn.title = item.title;
      btn.addEventListener('click', item.onClick);
      pillEl.appendChild(btn);
    });

    document.body.appendChild(pillEl);

    toastEl = document.createElement('div');
    toastEl.id = 'crpdf-toast';
    document.body.appendChild(toastEl);
  }

  function onHostUrlReady(rawUrl) {
    if (!parseRealUrl(rawUrl)) return;
    if (state.isPresenter) {
      document.title = PRESENTER_TITLE;
      document.body.classList.add('crpdf-presenter');
      if (pillEl) pillEl.remove();
    } else {
      buildFloatingPill();
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

    window.addEventListener('keydown', (e) => {
      if (state.isPresenter) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        performSilentSave({ reason: 'manual' });
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
      // Fallback: check referrer or location if already http://127.0.0.1
      parseRealUrl(document.referrer) || parseRealUrl(window.location.href);
      if (state.apiOrigin) onHostUrlReady(state.originalUrl);
    }

    const waitForViewer = setInterval(() => {
      const v = getPdfViewer();
      if (!v || !v.shadowRoot) return;
      injectCssIntoRoot(v.shadowRoot);
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
