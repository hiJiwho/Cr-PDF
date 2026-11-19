/* Cr-PDF inner OOPIF plugin wrapper patch (100% passive, zero touch crash):
 * - Does NOT cancel/block native touch/pointer events (avoids Windows Surface touch CHECK crash)
 * - Passively relays pen stroke coordinates to outer frame for Presenter live mirror
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const state = {
    isPresenter: false,
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
      if (typeof msg.isPresenter === 'boolean') state.isPresenter = msg.isPresenter;
    }
  });

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
    window.addEventListener(evtName, onPointerEvent, { capture: true, passive: true });
  }
})();
