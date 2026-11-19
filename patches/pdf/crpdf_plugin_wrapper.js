/* Cr-PDF inner OOPIF plugin wrapper patch (v8):
 * Intentionally minimal no-op so Chromium PDFium + Ink2 handles pen/touch natively
 * without triggering cross-origin postMessage bad IPC reason 319 in the OOPIF plugin frame.
 */
(function () {
  'use strict';
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;
})();
