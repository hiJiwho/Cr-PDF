/* Cr-PDF inner OOPIF plugin wrapper patch (v7):
 * - Relays live pointer strokes (pen & mouse when draw mode is active) to outer main.js
 *   so the Presenter second window renders live ink strokes immediately in real time
 *   and triggers debounced auto-save after each completed stroke.
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  let activePointerId = null;
  let strokeSeq = 0;
  let currentStrokeId = null;

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
      // Ignore cross-origin frame messaging errors
    }
  }

  function onPointerEvent(e) {
    if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;

    if (e.type === 'pointerdown' && e.button === 0) {
      activePointerId = e.pointerId;
      strokeSeq += 1;
      currentStrokeId = `s_${Date.now()}_${strokeSeq}`;
      const norm = normalizeCoords(e.clientX, e.clientY);
      postToParent({
        type: 'crpdf:ink_stroke',
        op: 'start',
        pointerType: e.pointerType,
        strokeId: currentStrokeId,
        x: norm.x,
        y: norm.y,
      });
    } else if (e.type === 'pointermove' && activePointerId === e.pointerId && (e.buttons & 1) !== 0) {
      const norm = normalizeCoords(e.clientX, e.clientY);
      postToParent({
        type: 'crpdf:ink_stroke',
        op: 'move',
        pointerType: e.pointerType,
        strokeId: currentStrokeId,
        x: norm.x,
        y: norm.y,
      });
    } else if ((e.type === 'pointerup' || e.type === 'pointercancel') && activePointerId === e.pointerId) {
      const norm = normalizeCoords(e.clientX, e.clientY);
      postToParent({
        type: 'crpdf:ink_stroke',
        op: 'end',
        pointerType: e.pointerType,
        strokeId: currentStrokeId,
        x: norm.x,
        y: norm.y,
      });
      activePointerId = null;
      currentStrokeId = null;
    }
  }

  for (const evtName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    window.addEventListener(evtName, onPointerEvent, { capture: true, passive: true });
  }
})();
