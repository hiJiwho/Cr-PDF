/* Cr-PDF inner OOPIF plugin wrapper patch (v15):
 * - STRICT NO-OP on IPC / BroadcastChannel / postMessage!
 *   In Chromium 150, the inner PDF plugin frame runs in a sandboxed `chrome-untrusted://`
 *   process where `BroadcastChannel` or `window.parent.postMessage` is forbidden by Mojo
 *   Origin Security and terminates the renderer (`bad IPC message, reason 319`, `x_x`).
 * - Pure local event filtering only: blocks single-finger touch (`pointerType === 'touch'`)
 *   so hands/palms do not draw on Ink2 while pen and mouse work natively without any crash.
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
