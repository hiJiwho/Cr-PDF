/* Cr-PDF inner OOPIF plugin wrapper patch (crash-safe):
 * - Palm rejection (1-finger touch scrolls; >=2-finger pinch-zoom passes through; pen draws natively)
 * - Live pen stroke coordinate relay to outer frame for Presenter sub-window mirror
 * - Zero risky internal Ink2 C++ brush mutations
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const state = {
    palmRejection: true,
    isPresenter: false,
    activeTouchPoints: new Map(),
    lastScrollTouch: null,
    activePenId: null,
    strokeSeq: 0,
    currentStrokeId: null,
  };

  function getPluginRect() {
    const plugin =
      document.querySelector('embed[type="application/x-google-chrome-pdf"]') ||
      document.getElementById('plugin') ||
      document.documentElement;
    return plugin.getBoundingClientRect();
  }

  function normalizeCoords(clientX, clientY) {
    const r = getPluginRect();
    const w = r.width > 0 ? r.width : window.innerWidth || 1;
    const h = r.height > 0 ? r.height : window.innerHeight || 1;
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / w)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / h)),
    };
  }

  function postToParent(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch {
      // ignore
    }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'crpdf:config') {
      if (typeof msg.palmRejection === 'boolean') state.palmRejection = msg.palmRejection;
      if (typeof msg.isPresenter === 'boolean') state.isPresenter = msg.isPresenter;
    }
  });

  function onTouchStart(e) {
    for (const t of e.changedTouches) {
      state.activeTouchPoints.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (state.activeTouchPoints.size === 1) {
      const t = e.changedTouches[0];
      state.lastScrollTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
    } else {
      state.lastScrollTouch = null;
    }
  }

  function onTouchMove(e) {
    for (const t of e.changedTouches) {
      state.activeTouchPoints.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (!state.palmRejection) return;
    if (e.touches.length >= 2) {
      state.lastScrollTouch = null;
      return;
    }
    if (e.touches.length === 1 && state.lastScrollTouch) {
      const t = e.touches[0];
      const dx = state.lastScrollTouch.x - t.clientX;
      const dy = state.lastScrollTouch.y - t.clientY;
      state.lastScrollTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        postToParent({ type: 'crpdf:scroll_delta', dx, dy });
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function onTouchEndOrCancel(e) {
    for (const t of e.changedTouches) {
      state.activeTouchPoints.delete(t.identifier);
    }
    if (state.activeTouchPoints.size === 0) {
      state.lastScrollTouch = null;
    }
  }

  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  window.addEventListener('touchend', onTouchEndOrCancel, { capture: true, passive: true });
  window.addEventListener('touchcancel', onTouchEndOrCancel, { capture: true, passive: true });

  function onPointerEvent(e) {
    if (state.isPresenter) {
      if (e.type === 'pointermove' || e.type === 'pointerleave') {
        const norm = normalizeCoords(e.clientX, e.clientY);
        postToParent({
          type: 'crpdf:presenter_mouse',
          visible: e.type !== 'pointerleave',
          xPct: norm.x * 100,
          yPct: norm.y * 100,
        });
      }
      if (e.pointerType === 'pen' || e.pointerType === 'touch') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }

    if (state.palmRejection && e.pointerType === 'touch') {
      if (state.activeTouchPoints.size < 2) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }

    if (e.pointerType !== 'pen') return;

    if (e.type === 'pointerdown') {
      state.activePenId = e.pointerId;
      state.strokeSeq += 1;
      state.currentStrokeId = `s_${Date.now()}_${state.strokeSeq}`;
      const norm = normalizeCoords(e.clientX, e.clientY);
      postToParent({
        type: 'crpdf:ink_stroke',
        op: 'start',
        strokeId: state.currentStrokeId,
        x: norm.x,
        y: norm.y,
      });
    } else if (e.type === 'pointermove' && state.activePenId === e.pointerId && (e.buttons & 1) !== 0) {
      const norm = normalizeCoords(e.clientX, e.clientY);
      postToParent({
        type: 'crpdf:ink_stroke',
        op: 'move',
        strokeId: state.currentStrokeId,
        x: norm.x,
        y: norm.y,
      });
    } else if ((e.type === 'pointerup' || e.type === 'pointercancel') && state.activePenId === e.pointerId) {
      const norm = normalizeCoords(e.clientX, e.clientY);
      postToParent({
        type: 'crpdf:ink_stroke',
        op: 'end',
        strokeId: state.currentStrokeId,
        x: norm.x,
        y: norm.y,
      });
      state.activePenId = null;
      state.currentStrokeId = null;
    }
  }

  for (const evtName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave']) {
    window.addEventListener(evtName, onPointerEvent, { capture: true, passive: false });
  }
})();
