/* Cr-PDF inner OOPIF plugin wrapper patch (v10):
 * - Notifies outer chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai frame when a stroke ends
 *   using the exact required targetOrigin ('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')
 *   so Chromium's OOPIF validation never triggers bad IPC reason 319.
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const PDF_EXT_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
  let isDrawing = false;

  function notifyStrokeEnd() {
    if (!isDrawing) return;
    isDrawing = false;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'crpdf:stroke_finished' }, PDF_EXT_ORIGIN);
      }
    } catch {
      // ignore
    }
  }

  window.addEventListener('pointerdown', (e) => {
    if (e.button === 0 || e.pointerType === 'pen' || e.pointerType === 'touch') {
      isDrawing = true;
    }
  }, { capture: true, passive: true });

  window.addEventListener('pointerup', () => {
    notifyStrokeEnd();
  }, { capture: true, passive: true });

  window.addEventListener('pointercancel', () => {
    notifyStrokeEnd();
  }, { capture: true, passive: true });

  window.addEventListener('mouseup', () => {
    notifyStrokeEnd();
  }, { capture: true, passive: true });

  window.addEventListener('touchend', () => {
    notifyStrokeEnd();
  }, { capture: true, passive: true });
})();
