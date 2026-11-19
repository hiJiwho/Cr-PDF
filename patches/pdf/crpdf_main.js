/* Cr-PDF outer PDF viewer patch (100% Native Chrome PDF/Ink2 UI):
 * - Preserves Chrome's native PDF & Ink2 toolbar untouched (no risky internal C++ brush/mode calls)
 * - Adds a subtle floating pill in bottom-right: Home, +Page, Silent Save, Screen Share
 * - Silent Ctrl+S overwrite to /api/save + periodic auto-save
 * - Dual-screen presenter sub-window ([화면공유용] 판서 화면) with live ink mirror & red laser pointer
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_MAIN_INSTALLED__) return;
  globalThis.__CRPDF_MAIN_INSTALLED__ = true;

  const PRESENTER_TITLE = '[화면공유용] 판서 화면';
  const urlParams = new URLSearchParams(window.location.search);
  const isPresenter = urlParams.get('crpdf_role') === 'presenter';
  const docName = resolveDocName();
  const senderId = `win_${Math.random().toString(36).slice(2, 10)}`;

  const state = {
    docName,
    isPresenter,
    config: {
      autosaveIntervalSec: 30,
      autosaveEnabled: true,
      palmRejection: true,
    },
    dirty: false,
    saving: false,
    mirrorStrokes: [],
    activeStrokeMap: new Map(),
    version: 0,
    lastViewportKey: '',
    autosaveTimer: null,
  };

  let bc = null;
  let pillEl = null;
  let toastEl = null;
  let mirrorCanvas = null;
  let laserOverlay = null;
  let laserDot = null;

  function resolveDocName() {
    const qDoc = urlParams.get('doc');
    if (qDoc) return qDoc;
    const m = window.location.pathname.match(/\/pdf\/([^/?#]+)/);
    if (m && m[1]) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
    return 'notebook.pdf';
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
    if (!toastEl || isPresenter) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('visible');
    }, ms);
  }

  function broadcastToPluginFrame() {
    const payload = {
      type: 'crpdf:config',
      palmRejection: state.config.palmRejection,
      isPresenter: state.isPresenter,
    };
    const v = getPdfViewer();
    const embed = v?.shadowRoot?.querySelector('embed, iframe');
    try {
      if (embed && embed.contentWindow) {
        embed.contentWindow.postMessage(payload, '*');
      }
    } catch {
      // ignore
    }
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage(payload, '*');
      } catch {
        // ignore
      }
    }
  }

  async function fetchHostConfig() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        if (typeof cfg.autosaveIntervalSec === 'number') {
          state.config.autosaveIntervalSec = cfg.autosaveIntervalSec;
        }
        if (typeof cfg.autosaveEnabled === 'boolean') {
          state.config.autosaveEnabled = cfg.autosaveEnabled;
        }
        if (typeof cfg.palmRejection === 'boolean') {
          state.config.palmRejection = cfg.palmRejection;
        }
        broadcastToPluginFrame();
        scheduleAutosaveTimer();
      }
    } catch {
      // ignore
    }
  }

  async function performSilentSave({ reason = 'manual' } = {}) {
    if (state.saving || isPresenter) return false;
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
          // If Ink2 has no pending edits or save type differs, fallback cleanly
        }
      }
      if (!pdfBytes) {
        const resp = await fetch(`/pdf/${encodeURIComponent(state.docName)}`, { cache: 'no-store' });
        if (resp.ok) {
          pdfBytes = await resp.arrayBuffer();
        }
      }
      if (!pdfBytes) return false;

      const saveRes = await fetch(`/api/save?name=${encodeURIComponent(state.docName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: pdfBytes,
      });
      if (!saveRes.ok) {
        throw new Error(`HTTP ${saveRes.status}`);
      }
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
    if (!state.config.autosaveEnabled || sec <= 0 || isPresenter) return;
    state.autosaveTimer = setInterval(() => {
      if (state.dirty && !state.saving) {
        performSilentSave({ reason: 'autosave' });
      }
    }, sec * 1000);
  }

  async function handleAddPage() {
    if (isPresenter) return;
    showToast('페이지 추가 중...');
    if (state.dirty) {
      await performSilentSave({ reason: 'pre-add-page' });
    }
    const res = await fetch(`/api/notebooks/${encodeURIComponent(state.docName)}/add-page`, {
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
    window.location.href = `/pdf/${encodeURIComponent(state.docName)}#page=${nextPage}`;
    window.location.reload();
  }

  async function openScreenSharePresenter() {
    const presenterUrl = `${window.location.origin}/pdf/${encodeURIComponent(state.docName)}?crpdf_role=presenter&doc=${encodeURIComponent(state.docName)}`;
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
    const v = getPdfViewer();
    const vp = getViewport();
    const scroller = v?.shadowRoot?.querySelector('#scroller') || document.scrollingElement || document.documentElement;
    const page = vp && typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
    const zoom = vp && typeof vp.getZoom === 'function' ? vp.getZoom() : 1;
    const scrollX = scroller ? scroller.scrollLeft : 0;
    const scrollY = scroller ? scroller.scrollTop : 0;
    return { type: 'viewport', page, zoom, scrollX, scrollY };
  }

  function setupBroadcastChannel() {
    bc = new BroadcastChannel(`crpdf-sync:${state.docName}`);
    bc.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.senderId === senderId) return;

      if (msg.type === 'presenter_ready' && !isPresenter) {
        sendBroadcast(getCurrentViewportPayload());
        for (const stroke of state.mirrorStrokes) {
          for (let i = 0; i < stroke.points.length; i++) {
            const pt = stroke.points[i];
            sendBroadcast({
              type: 'ink_stroke',
              op: i === 0 ? 'start' : i === stroke.points.length - 1 ? 'end' : 'move',
              strokeId: stroke.id,
              page: stroke.page,
              x: pt.x,
              y: pt.y,
            });
          }
        }
      } else if (msg.type === 'viewport' && isPresenter) {
        applyIncomingViewport(msg);
      } else if (msg.type === 'ink_stroke' && isPresenter) {
        applyIncomingInkStroke(msg);
      } else if (msg.type === 'ink_action' && isPresenter) {
        if (msg.op === 'saved_checkpoint' || msg.op === 'clear_overlay') {
          state.mirrorStrokes = [];
          redrawMirrorCanvas();
        }
      } else if (msg.type === 'laser') {
        renderLaserDot(msg);
      }
    });

    if (isPresenter) {
      sendBroadcast({ type: 'presenter_ready' });
    }
  }

  function applyIncomingViewport(msg) {
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

  function ensureOverlays() {
    if (!mirrorCanvas && isPresenter) {
      mirrorCanvas = document.createElement('canvas');
      mirrorCanvas.id = 'crpdf-ink-mirror';
      mirrorCanvas.width = window.innerWidth || 1024;
      mirrorCanvas.height = window.innerHeight || 768;
      document.body.appendChild(mirrorCanvas);
      window.addEventListener('resize', () => {
        if (!mirrorCanvas) return;
        mirrorCanvas.width = window.innerWidth || 1024;
        mirrorCanvas.height = window.innerHeight || 768;
        redrawMirrorCanvas();
      });
    }

    if (!laserOverlay) {
      laserOverlay = document.createElement('div');
      laserOverlay.id = 'crpdf-laser-overlay';
      laserDot = document.createElement('div');
      laserDot.id = 'crpdf-laser-dot';
      laserOverlay.appendChild(laserDot);
      document.body.appendChild(laserOverlay);

      if (isPresenter) {
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
    ensureOverlays();
    if (!laserDot) return;
    if (!msg.visible) {
      laserDot.classList.remove('visible');
      return;
    }
    laserDot.classList.add('visible');
    laserDot.style.left = `${Math.max(0, Math.min(100, msg.xPct))}%`;
    laserDot.style.top = `${Math.max(0, Math.min(100, msg.yPct))}%`;
  }

  function applyIncomingInkStroke(msg) {
    ensureOverlays();
    if (msg.op === 'start') {
      const stroke = { id: msg.strokeId, points: [{ x: msg.x, y: msg.y }] };
      state.activeStrokeMap.set(msg.strokeId, stroke);
      state.mirrorStrokes.push(stroke);
    } else if (msg.op === 'move' || msg.op === 'end') {
      const stroke = state.activeStrokeMap.get(msg.strokeId);
      if (stroke) {
        stroke.points.push({ x: msg.x, y: msg.y });
        if (msg.op === 'end') state.activeStrokeMap.delete(msg.strokeId);
      }
    }
    redrawMirrorCanvas();
  }

  function redrawMirrorCanvas() {
    if (!mirrorCanvas) return;
    const ctx = mirrorCanvas.getContext('2d');
    if (!ctx) return;
    const w = mirrorCanvas.width;
    const h = mirrorCanvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 3;

    for (const stroke of state.mirrorStrokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      ctx.beginPath();
      const p0 = stroke.points[0];
      ctx.moveTo(p0.x * w, p0.y * h);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
      }
      ctx.stroke();
    }
  }

  function buildFloatingPill() {
    if (isPresenter || pillEl) return;
    pillEl = document.createElement('div');
    pillEl.id = 'crpdf-dock-pill';

    const items = [
      { label: '홈', title: '라이브러리로 돌아가기', onClick: () => { window.location.href = '/'; } },
      { label: '+ 페이지', title: '맨 뒤에 새 페이지 추가', onClick: handleAddPage },
      { label: '저장', title: '현재 폴더에 바로 저장 (Ctrl+S)', onClick: () => performSilentSave({ reason: 'manual' }) },
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

  function setupListeners() {
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'crpdf:ink_stroke' && !isPresenter) {
        if (msg.op === 'start') {
          state.dirty = true;
          const stroke = { id: msg.strokeId, points: [{ x: msg.x, y: msg.y }] };
          state.activeStrokeMap.set(msg.strokeId, stroke);
          state.mirrorStrokes.push(stroke);
        } else if (msg.op === 'move' || msg.op === 'end') {
          const stroke = state.activeStrokeMap.get(msg.strokeId);
          if (stroke) {
            stroke.points.push({ x: msg.x, y: msg.y });
            if (msg.op === 'end') state.activeStrokeMap.delete(msg.strokeId);
          }
        }
        sendBroadcast({ type: 'ink_stroke', op: msg.op, strokeId: msg.strokeId, x: msg.x, y: msg.y });
      } else if (msg.type === 'crpdf:scroll_delta') {
        const v = getPdfViewer();
        const scroller = v?.shadowRoot?.querySelector('#scroller') || document.scrollingElement;
        if (scroller) scroller.scrollBy(msg.dx || 0, msg.dy || 0);
      } else if (msg.type === 'crpdf:presenter_mouse' && isPresenter) {
        const payload = { type: 'laser', role: 'presenter', visible: Boolean(msg.visible), xPct: msg.xPct, yPct: msg.yPct };
        renderLaserDot(payload);
        sendBroadcast(payload);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (isPresenter) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        performSilentSave({ reason: 'manual' });
      }
    }, true);

    if (!isPresenter) {
      setInterval(() => {
        const payload = getCurrentViewportPayload();
        const key = `${payload.page}|${payload.zoom.toFixed(3)}|${Math.round(payload.scrollX)}|${Math.round(payload.scrollY)}`;
        if (key !== state.lastViewportKey) {
          state.lastViewportKey = key;
          sendBroadcast(payload);
        }
      }, 100);
    }
  }

  function bootstrap() {
    injectCssIntoRoot(document.head || document.documentElement);
    if (isPresenter) {
      document.title = PRESENTER_TITLE;
      document.body.classList.add('crpdf-presenter');
    }

    setupBroadcastChannel();
    setupListeners();
    ensureOverlays();

    if (!isPresenter) {
      buildFloatingPill();
      fetchHostConfig();
      scheduleAutosaveTimer();
    }

    // Only inject presenter CSS into pdf-viewer shadowRoot if in presenter mode
    if (isPresenter) {
      const waitForViewer = setInterval(() => {
        const v = getPdfViewer();
        if (!v || !v.shadowRoot) return;
        injectCssIntoRoot(v.shadowRoot);
        clearInterval(waitForViewer);
      }, 150);
    }
    setTimeout(broadcastToPluginFrame, 400);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
