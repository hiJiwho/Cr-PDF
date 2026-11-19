/* Cr-PDF inner OOPIF plugin wrapper patch (v12):
 * - NEVER calls window.parent.postMessage! In Chromium 150 PDF OOPIF (chrome-untrusted://),
 *   any custom postMessage to window.parent violates PdfService / renderer IPC validation
 *   and kills the renderer with `Terminating renderer for bad IPC message, reason 319`.
 * - Pure local Palm Rejection: blocks single-finger touch (`pointerType === 'touch'`) from
 *   reaching PDFium Ink2 so hands/palms never draw on the canvas, while pen and mouse pass through untouched.
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const activeTouches = new Set();

  window.addEventListener('touchstart', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouches.add(e.changedTouches[i].identifier);
    }
    if (e.touches.length === 1) {
      e.stopImmediatePropagation();
    }
  }, { capture: true, passive: true });

  const onTouchEnd = (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouches.delete(e.changedTouches[i].identifier);
    }
  };
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

  // Block single-finger touch pointer events from reaching Ink2 so hands never draw
  function blockTouchDrawing(e) {
    if (e.pointerType === 'touch' && activeTouches.size < 2) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  for (const evt of ['pointerdown', 'pointermove', 'pointerup']) {
    window.addEventListener(evt, blockTouchDrawing, { capture: true, passive: false });
  }
})();
