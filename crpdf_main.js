/* Cr-PDF outer PDF viewer patch:
 * - Minimal 1-row top / right-docked Ink2 toolbar + preset slots + Add Page (+)
 * - Silent atomic save (POST /api/save) & periodic auto-save
 * - Dual-screen presenter sub-window, BroadcastChannel sync, live ink mirror & red laser pointer
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_MAIN_INSTALLED__) return;
  globalThis.__CRPDF_MAIN_INSTALLED__ = true;

  const PRESENTER_TITLE = '[화면공유용] 판서 화면';
  const STORAGE_SLOTS_KEY = 'crpdf_pen_slots_v1';
  const STORAGE_DOCK_KEY = 'crpdf_toolbar_dock_v1';
  const STORAGE_MAX_LEVEL_KEY = 'crpdf_max_level_v1';

  const DEFAULT_SLOTS = [
    { id: 'pen-black', type: 'pen', color: '#111827', maxLevel: 3, label: '검정 펜' },
    { id: 'pen-blue', type: 'pen', color: '#2563eb', maxLevel: 3, label: '파랑 펜' },
    { id: 'pen-red', type: 'pen', color: '#dc2626', maxLevel: 3, label: '빨강 펜' },
    { id: 'hl-yellow', type: 'highlighter', color: '#facc15', maxLevel: 4, label: '노랑 형광펜' },
  ];

  const CHROME_SWATCHES = [
    '#111827', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c',
    '#0284c7', '#db2777', '#65a30d', '#facc15', '#fb923c', '#38bdf8',
  ];

  const urlParams = new URLSearchParams(window.location.search);
  const isPresenter = urlParams.get('crpdf_role') === 'presenter';
  const docName = resolveDocName();
  const senderId = `win_${Math.random().toString(36).slice(2, 10)}`;

  const state = {
    docName,
    isPresenter,
    activeTool: 'pen',
    activeColor: '#111827',
    activeSize: Number(localStorage.getItem(STORAGE_MAX_LEVEL_KEY) || 3),
    maxLevel: Number(localStorage.getItem(STORAGE_MAX_LEVEL_KEY) || 3),
    dock: localStorage.getItem(STORAGE_DOCK_KEY) === 'right' ? 'right' : 'top',
    slots: loadSlots(),
    activeSlotId: 'pen-black',
    config: {
      autosaveIntervalSec: 30,
      autosaveEnabled: true,
      palmRejection: true,
      pseudoPressure: true,
    },
    dirty: false,
    saving: false,
    canUndo: false,
    mirrorStrokes: [],
    activeStrokeMap: new Map(),
    version: 0,
    lastViewportKey: '',
    autosaveTimer: null,
  };

  let bc = null;
  let presenterWin = null;
  let toolbarEl = null;
  let popoverEl = null;
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

  function loadSlots() {
    try {
      const raw = localStorage.getItem(STORAGE_SLOTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore storage errors
    }
    return DEFAULT_SLOTS.map((s) => ({ ...s }));
  }

  function saveSlots() {
    try {
      localStorage.setItem(STORAGE_SLOTS_KEY, JSON.stringify(state.slots));
    } catch {
      // ignore
    }
  }

  function hexToRgb(hex) {
    const clean = String(hex || '#111827').replace('#', '');
    const full = clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean.padEnd(6, '0').slice(0, 6);
    const n = parseInt(full, 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
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

  function syncAttributes() {
    const root = document.documentElement;
    root.setAttribute('data-crpdf-active-tool', state.activeTool);
    root.setAttribute('data-crpdf-active-size', String(state.activeSize));
    root.setAttribute('data-crpdf-max-level', String(state.maxLevel));

    const vp = getViewport();
    const page = vp && typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
    const pageCount = vp?.documentDimensions_?.pageDimensions?.length || 1;
    const zoom = vp && typeof vp.getZoom === 'function' ? vp.getZoom() : 1;
    root.setAttribute('data-crpdf-page', String(page));
    root.setAttribute('data-crpdf-page-count', String(pageCount));
    root.setAttribute('data-crpdf-zoom', String(zoom));

    if (toolbarEl) {
      toolbarEl.setAttribute('data-crpdf-active-tool', state.activeTool);
      toolbarEl.setAttribute('data-crpdf-active-size', String(state.activeSize));
      toolbarEl.setAttribute('data-crpdf-max-level', String(state.maxLevel));
      toolbarEl.setAttribute('data-crpdf-dock', state.dock);
    }
  }

  function broadcastToPluginFrame() {
    const payload = {
      type: 'crpdf:config',
      palmRejection: state.config.palmRejection,
      pseudoPressure: state.config.pseudoPressure,
      maxLevel: state.maxLevel,
      activeTool: state.activeTool,
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

  async function applyInk2Brush({ type, color, size }) {
    state.activeTool = type;
    if (color) state.activeColor = color;
    if (type !== 'eraser' && size != null) {
      state.activeSize = Math.max(1, Math.min(16, Number(size)));
    }
    syncAttributes();
    broadcastToPluginFrame();

    const ctrl = getController();
    if (!ctrl) return;
    try {
      if (typeof ctrl.setAnnotationMode === 'function' && !state.isPresenter) {
        ctrl.setAnnotationMode('draw');
      }
      if (typeof ctrl.setAnnotationBrush === 'function') {
        const brush = { type };
        if (type !== 'eraser') {
          brush.color = hexToRgb(state.activeColor);
          brush.size = state.activeSize;
        }
        await ctrl.setAnnotationBrush(brush);
      }
    } catch {
      // Fallback gracefully if stock controller differs
    }
  }

  async function enterInk2DrawMode() {
    const v = getPdfViewer();
    if (!v) return;
    const ctrl = getController();
    if (isPresenter) {
      try {
        if (ctrl && typeof ctrl.setAnnotationMode === 'function') {
          ctrl.setAnnotationMode('off');
        }
      } catch {
        // ignore
      }
      return;
    }

    try {
      if (ctrl && typeof ctrl.setAnnotationMode === 'function') {
        ctrl.setAnnotationMode('draw');
      } else {
        const annotateBtn = v.shadowRoot
          ?.querySelector('viewer-toolbar')
          ?.shadowRoot?.querySelector('#annotate');
        if (annotateBtn && !annotateBtn.hasAttribute('active')) {
          annotateBtn.click();
        }
      }
    } catch {
      // ignore
    }
    await applyInk2Brush({
      type: state.activeTool,
      color: state.activeColor,
      size: state.activeSize,
    });
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
        if (typeof cfg.pseudoPressure === 'boolean') {
          state.config.pseudoPressure = cfg.pseudoPressure;
        }
        broadcastToPluginFrame();
        scheduleAutosaveTimer();
      }
    } catch {
      // Standalone/test fallback
    }
  }

  async function performSilentSave({ reason = 'manual' } = {}) {
    if (state.saving || isPresenter) return false;
    const ctrl = getController();
    state.saving = true;
    try {
      let pdfBytes = null;
      if (ctrl && typeof ctrl.save === 'function') {
        const result = await ctrl.save(1 /* SaveRequestType.ANNOTATION */);
        if (result && result.dataToSave) {
          pdfBytes = result.dataToSave;
        }
      }
      if (!pdfBytes) {
        // Fallback: fetch current PDF bytes if controller did not return modified buffer
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

  async function handleUndo() {
    const ctrl = getController();
    try {
      if (ctrl && typeof ctrl.undo === 'function') {
        ctrl.undo();
      } else {
        const btn = getPdfViewer()?.shadowRoot
          ?.querySelector('viewer-toolbar')
          ?.shadowRoot?.querySelector('#undo');
        if (btn) btn.click();
      }
    } catch {
      // ignore
    }
    if (state.mirrorStrokes.length > 0) {
      state.mirrorStrokes.pop();
    }
    state.canUndo = state.mirrorStrokes.length > 0;
    updateToolbarActiveStates();
    sendBroadcast({ type: 'ink_action', op: 'undo', version: ++state.version });
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
      // Single monitor or permission fallback -> open standard popup
    }

    presenterWin = window.open(presenterUrl, 'crpdf_presenter', features);
    if (presenterWin && extScreen && presenterWin.document?.documentElement?.requestFullscreen) {
      try {
        await presenterWin.document.documentElement.requestFullscreen({ screen: extScreen });
      } catch {
        // Ignore if cross-tick gesture restriction applies
      }
    }
  }

  function sendBroadcast(msg) {
    if (!bc) return;
    try {
      bc.postMessage({
        ...msg,
        senderId,
        ts: Date.now(),
      });
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
    const maxW = scroller ? Math.max(1, scroller.scrollWidth - scroller.clientWidth) : 1;
    const maxH = scroller ? Math.max(1, scroller.scrollHeight - scroller.clientHeight) : 1;
    return {
      type: 'viewport',
      page,
      zoom,
      scrollX,
      scrollY,
      scrollRatioX: scrollX / maxW,
      scrollRatioY: scrollY / maxH,
    };
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
              brush: stroke.brush,
            });
          }
        }
      } else if (msg.type === 'viewport' && isPresenter) {
        applyIncomingViewport(msg);
      } else if (msg.type === 'ink_stroke' && isPresenter) {
        applyIncomingInkStroke(msg);
      } else if (msg.type === 'ink_action' && isPresenter) {
        if (msg.op === 'undo') {
          state.mirrorStrokes.pop();
          redrawMirrorCanvas();
        } else if (msg.op === 'clear_overlay') {
          state.mirrorStrokes = [];
          redrawMirrorCanvas();
        } else if (msg.op === 'saved_checkpoint') {
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
        if (typeof msg.zoom === 'number' && typeof vp.setZoom === 'function') {
          vp.setZoom(msg.zoom);
        }
        if (typeof msg.page === 'number' && typeof vp.goToPage === 'function') {
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
    syncAttributes();
  }

  function ensureMirrorAndLaserOverlays() {
    if (!mirrorCanvas && isPresenter) {
      mirrorCanvas = document.createElement('canvas');
      mirrorCanvas.id = 'crpdf-ink-mirror';
      mirrorCanvas.setAttribute('data-crpdf-mirror', 'true');
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
      laserDot.setAttribute('data-crpdf-laser-dot', 'true');
      laserOverlay.appendChild(laserDot);
      document.body.appendChild(laserOverlay);

      if (isPresenter) {
        laserOverlay.addEventListener('mousemove', (ev) => {
          const rect = laserOverlay.getBoundingClientRect();
          const xPct = rect.width > 0 ? ((ev.clientX - rect.left) / rect.width) * 100 : 0;
          const yPct = rect.height > 0 ? ((ev.clientY - rect.top) / rect.height) * 100 : 0;
          const vp = getViewport();
          const page = vp && typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
          const payload = { type: 'laser', role: 'presenter', visible: true, xPct, yPct, page };
          renderLaserDot(payload);
          sendBroadcast(payload);
        });
        laserOverlay.addEventListener('mouseleave', () => {
          const payload = { type: 'laser', role: 'presenter', visible: false, xPct: 0, yPct: 0, page: 1 };
          renderLaserDot(payload);
          sendBroadcast(payload);
        });
      }
    }
  }

  function renderLaserDot(msg) {
    ensureMirrorAndLaserOverlays();
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
    ensureMirrorAndLaserOverlays();
    if (msg.op === 'start') {
      const stroke = {
        id: msg.strokeId,
        page: msg.page || 1,
        brush: msg.brush || { type: 'pen', color: '#111827', size: 3 },
        points: [{ x: msg.x, y: msg.y }],
      };
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

    for (const stroke of state.mirrorStrokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const brush = stroke.brush || { type: 'pen', color: '#111827', size: 3 };
      if (brush.type === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = Math.max(8, (brush.size || 3) * 4);
      } else if (brush.type === 'highlighter') {
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = brush.color || '#facc15';
        ctx.lineWidth = Math.max(6, (brush.size || 4) * 3);
      } else {
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = brush.color || '#111827';
        ctx.lineWidth = Math.max(1.5, (brush.size || 3) * 1.4);
      }

      ctx.beginPath();
      const p0 = stroke.points[0];
      ctx.moveTo(p0.x * w, p0.y * h);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
      }
      if (stroke.points.length === 1) {
        ctx.lineTo(p0.x * w + 0.5, p0.y * h + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function updateToolbarActiveStates() {
    if (!toolbarEl) return;
    toolbarEl.querySelectorAll('[data-crpdf-tool]').forEach((btn) => {
      const match = btn.getAttribute('data-crpdf-tool') === state.activeTool;
      btn.classList.toggle('active', match);
      btn.setAttribute('aria-pressed', match ? 'true' : 'false');
    });
    toolbarEl.querySelectorAll('[data-crpdf-max-level]').forEach((btn) => {
      const match = Number(btn.getAttribute('data-crpdf-max-level')) === state.maxLevel;
      btn.classList.toggle('active', match);
      btn.setAttribute('aria-pressed', match ? 'true' : 'false');
    });
    toolbarEl.querySelectorAll('.crpdf-slot-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-slot-id') === state.activeSlotId);
    });
    const undoBtn = toolbarEl.querySelector('#crpdf-undo');
    if (undoBtn) {
      undoBtn.disabled = !state.canUndo;
    }
    syncAttributes();
  }

  function renderPresetSlots(container) {
    container.innerHTML = '';
    for (const slot of state.slots) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crpdf-slot-btn';
      btn.setAttribute('data-slot-id', slot.id);
      btn.setAttribute('data-slot-type', slot.type);
      btn.setAttribute('data-crpdf-color', slot.color);
      btn.title = `${slot.label || slot.type} (굵기 ${slot.maxLevel})`;

      const dot = document.createElement('span');
      dot.className = 'crpdf-slot-dot';
      dot.style.backgroundColor = slot.color;
      btn.appendChild(dot);

      const badge = document.createElement('span');
      badge.className = 'crpdf-slot-badge';
      badge.textContent = String(slot.maxLevel);
      btn.appendChild(badge);

      btn.addEventListener('click', () => {
        state.activeSlotId = slot.id;
        state.maxLevel = slot.maxLevel;
        localStorage.setItem(STORAGE_MAX_LEVEL_KEY, String(slot.maxLevel));
        applyInk2Brush({ type: slot.type, color: slot.color, size: slot.maxLevel });
        updateToolbarActiveStates();
      });
      container.appendChild(btn);
    }
  }

  function buildToolbar() {
    if (isPresenter || toolbarEl) return;
    toolbarEl = document.createElement('div');
    toolbarEl.id = 'crpdf-toolbar';
    toolbarEl.setAttribute('data-crpdf-toolbar', 'true');
    toolbarEl.setAttribute('data-crpdf-dock', state.dock);

    // Group 1: Tools (Pen / Highlighter / Eraser)
    const toolGroup = document.createElement('div');
    toolGroup.className = 'crpdf-group';
    const tools = [
      { id: 'crpdf-tool-pen', tool: 'pen', icon: '✏️', label: '펜', aria: '펜 Pen' },
      { id: 'crpdf-tool-highlighter', tool: 'highlighter', icon: '🖍️', label: '형광펜', aria: '형광펜 Highlighter' },
      { id: 'crpdf-tool-eraser', tool: 'eraser', icon: '🧽', label: '지우개', aria: '지우개 Eraser' },
    ];
    for (const t of tools) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = t.id;
      b.className = 'crpdf-btn';
      b.setAttribute('data-crpdf-tool', t.tool);
      b.setAttribute('aria-label', t.aria);
      b.innerHTML = `<span>${t.icon}</span><span class="crpdf-btn-label">${t.label}</span>`;
      b.addEventListener('click', () => {
        if (t.tool === 'eraser') {
          applyInk2Brush({ type: 'eraser' });
        } else {
          applyInk2Brush({ type: t.tool, color: state.activeColor, size: state.maxLevel });
        }
        updateToolbarActiveStates();
      });
      toolGroup.appendChild(b);
    }

    // Group 2: Preset Slots + Add/Color Popover
    const slotGroup = document.createElement('div');
    slotGroup.className = 'crpdf-group';
    const slotsWrap = document.createElement('div');
    slotsWrap.className = 'crpdf-group';
    slotsWrap.id = 'crpdf-slots-wrap';
    renderPresetSlots(slotsWrap);
    slotGroup.appendChild(slotsWrap);

    const colorBtn = document.createElement('button');
    colorBtn.type = 'button';
    colorBtn.id = 'crpdf-color-btn';
    colorBtn.className = 'crpdf-btn';
    colorBtn.setAttribute('aria-label', '색상 및 프리셋 추가');
    colorBtn.textContent = '🎨+';
    colorBtn.addEventListener('click', () => {
      if (popoverEl) popoverEl.classList.toggle('open');
    });
    slotGroup.appendChild(colorBtn);

    // Group 3: Max Level (1..5)
    const levelGroup = document.createElement('div');
    levelGroup.className = 'crpdf-group';
    for (let lv = 1; lv <= 5; lv++) {
      const lb = document.createElement('button');
      lb.type = 'button';
      lb.id = `crpdf-pressure-${lv}`;
      lb.className = 'crpdf-level-btn';
      lb.setAttribute('data-crpdf-max-level', String(lv));
      lb.setAttribute('aria-label', `최대 굵기 ${lv}`);
      lb.textContent = String(lv);
      lb.addEventListener('click', () => {
        state.maxLevel = lv;
        localStorage.setItem(STORAGE_MAX_LEVEL_KEY, String(lv));
        const activeSlot = state.slots.find((s) => s.id === state.activeSlotId);
        if (activeSlot) {
          activeSlot.maxLevel = lv;
          saveSlots();
          renderPresetSlots(slotsWrap);
        }
        if (state.activeTool !== 'eraser') {
          applyInk2Brush({ type: state.activeTool, color: state.activeColor, size: lv });
        } else {
          syncAttributes();
          broadcastToPluginFrame();
        }
        updateToolbarActiveStates();
      });
      levelGroup.appendChild(lb);
    }

    // Group 4: Actions (Undo, Add Page, Save, Screen Share, Library, Dock Toggle)
    const actionGroup = document.createElement('div');
    actionGroup.className = 'crpdf-group';
    const actions = [
      { id: 'crpdf-undo', action: 'undo', icon: '↶', label: '실행 취소', aria: '실행 취소 Undo', onClick: handleUndo },
      { id: 'crpdf-add-page', action: 'add-page', icon: '＋', label: '페이지', aria: '페이지 추가 Add Page', onClick: handleAddPage },
      { id: 'crpdf-save', action: 'save', icon: '💾', label: '저장', aria: '저장 Save', onClick: () => performSilentSave({ reason: 'manual' }) },
      { id: 'crpdf-screen-share', action: 'screen-share', icon: '🖥️', label: '화면공유', aria: '화면공유 Screen Share', onClick: openScreenSharePresenter },
      {
        id: 'crpdf-library',
        action: 'library',
        icon: '📚',
        label: '홈',
        aria: '라이브러리 Library Home',
        onClick: () => { window.location.href = '/'; },
      },
      {
        id: 'crpdf-dock-toggle',
        action: 'dock-toggle',
        icon: '⇄',
        label: '위치',
        aria: '툴바 도킹 전환 Dock Toggle',
        onClick: () => {
          state.dock = state.dock === 'top' ? 'right' : 'top';
          localStorage.setItem(STORAGE_DOCK_KEY, state.dock);
          updateToolbarActiveStates();
        },
      },
    ];
    for (const act of actions) {
      const ab = document.createElement('button');
      ab.type = 'button';
      ab.id = act.id;
      ab.className = 'crpdf-btn';
      ab.setAttribute('data-crpdf-action', act.action);
      ab.setAttribute('aria-label', act.aria);
      ab.innerHTML = `<span>${act.icon}</span><span class="crpdf-btn-label">${act.label}</span>`;
      ab.addEventListener('click', act.onClick);
      actionGroup.appendChild(ab);
    }

    const sep1 = document.createElement('span');
    sep1.className = 'crpdf-sep';
    const sep2 = document.createElement('span');
    sep2.className = 'crpdf-sep';
    const sep3 = document.createElement('span');
    sep3.className = 'crpdf-sep';
    const spacer = document.createElement('span');
    spacer.className = 'crpdf-spacer';

    toolbarEl.append(toolGroup, sep1, slotGroup, sep2, levelGroup, sep3, spacer, actionGroup);
    document.body.appendChild(toolbarEl);

    // Popover for ad-hoc color & new preset slot
    popoverEl = document.createElement('div');
    popoverEl.id = 'crpdf-popover';
    const swatchGrid = document.createElement('div');
    swatchGrid.className = 'crpdf-swatch-grid';
    for (const hex of CHROME_SWATCHES) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'crpdf-swatch';
      sw.style.backgroundColor = hex;
      sw.addEventListener('click', () => {
        const t = state.activeTool === 'eraser' ? 'pen' : state.activeTool;
        applyInk2Brush({ type: t, color: hex, size: state.maxLevel });
        popoverEl.classList.remove('open');
        updateToolbarActiveStates();
      });
      swatchGrid.appendChild(sw);
    }
    const customRow = document.createElement('div');
    customRow.style.display = 'flex';
    customRow.style.gap = '6px';
    customRow.style.alignItems = 'center';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = state.activeColor;
    colorInput.addEventListener('input', () => {
      const t = state.activeTool === 'eraser' ? 'pen' : state.activeTool;
      applyInk2Brush({ type: t, color: colorInput.value, size: state.maxLevel });
    });
    const addSlotBtn = document.createElement('button');
    addSlotBtn.type = 'button';
    addSlotBtn.className = 'crpdf-btn';
    addSlotBtn.textContent = '+ 슬롯 저장';
    addSlotBtn.addEventListener('click', () => {
      const t = state.activeTool === 'eraser' ? 'pen' : state.activeTool;
      const newSlot = {
        id: `slot_${Date.now()}`,
        type: t,
        color: colorInput.value,
        maxLevel: state.maxLevel,
        label: t === 'highlighter' ? '커스텀 형광펜' : '커스텀 펜',
      };
      state.slots.push(newSlot);
      state.activeSlotId = newSlot.id;
      saveSlots();
      renderPresetSlots(slotsWrap);
      updateToolbarActiveStates();
      popoverEl.classList.remove('open');
    });
    customRow.append(colorInput, addSlotBtn);
    popoverEl.append(swatchGrid, customRow);
    document.body.appendChild(popoverEl);

    toastEl = document.createElement('div');
    toastEl.id = 'crpdf-toast';
    document.body.appendChild(toastEl);

    updateToolbarActiveStates();
  }

  function setupMessageListeners() {
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'crpdf:pressure_size') {
        if (state.activeTool !== 'eraser') {
          applyInk2Brush({
            type: state.activeTool,
            color: state.activeColor,
            size: msg.size,
          });
        }
      } else if (msg.type === 'crpdf:ink_stroke' && !isPresenter) {
        const vp = getViewport();
        const page = vp && typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
        const brush = {
          type: state.activeTool,
          color: state.activeColor,
          size: state.activeSize,
        };
        if (msg.op === 'start') {
          state.dirty = true;
          state.canUndo = true;
          const stroke = { id: msg.strokeId, page, brush, points: [{ x: msg.x, y: msg.y }] };
          state.activeStrokeMap.set(msg.strokeId, stroke);
          state.mirrorStrokes.push(stroke);
          updateToolbarActiveStates();
        } else if (msg.op === 'move' || msg.op === 'end') {
          const stroke = state.activeStrokeMap.get(msg.strokeId);
          if (stroke) {
            stroke.points.push({ x: msg.x, y: msg.y });
            if (msg.op === 'end') state.activeStrokeMap.delete(msg.strokeId);
          }
        }
        sendBroadcast({
          type: 'ink_stroke',
          op: msg.op,
          strokeId: msg.strokeId,
          page,
          x: msg.x,
          y: msg.y,
          brush,
        });
      } else if (msg.type === 'crpdf:scroll_delta') {
        const v = getPdfViewer();
        const scroller = v?.shadowRoot?.querySelector('#scroller') || document.scrollingElement;
        if (scroller) {
          scroller.scrollBy(msg.dx || 0, msg.dy || 0);
        }
      } else if (msg.type === 'crpdf:presenter_mouse' && isPresenter) {
        const vp = getViewport();
        const page = vp && typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() + 1 : 1;
        const payload = {
          type: 'laser',
          role: 'presenter',
          visible: Boolean(msg.visible),
          xPct: msg.xPct,
          yPct: msg.yPct,
          page,
        };
        renderLaserDot(payload);
        sendBroadcast(payload);
      }
    });
  }

  function setupKeyboardAndViewportSync() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (isPresenter) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          performSilentSave({ reason: 'manual' });
        } else if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          handleUndo();
        }
      },
      true
    );

    if (!isPresenter) {
      setInterval(() => {
        const payload = getCurrentViewportPayload();
        const key = `${payload.page}|${payload.zoom.toFixed(3)}|${Math.round(payload.scrollX)}|${Math.round(payload.scrollY)}`;
        if (key !== state.lastViewportKey) {
          state.lastViewportKey = key;
          syncAttributes();
          sendBroadcast(payload);
        }
      }, 80);
    }
  }

  function bootstrap() {
    injectCssIntoRoot(document.head || document.documentElement);
    if (isPresenter) {
      document.title = PRESENTER_TITLE;
      document.body.classList.add('crpdf-presenter');
    }

    setupBroadcastChannel();
    setupMessageListeners();
    setupKeyboardAndViewportSync();
    ensureMirrorAndLaserOverlays();

    if (!isPresenter) {
      buildToolbar();
      fetchHostConfig();
      scheduleAutosaveTimer();
    }

    const waitForViewer = setInterval(() => {
      const v = getPdfViewer();
      if (!v) return;
      if (v.shadowRoot) {
        injectCssIntoRoot(v.shadowRoot);
      }
      clearInterval(waitForViewer);
      enterInk2DrawMode();
      broadcastToPluginFrame();
      syncAttributes();
    }, 100);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
