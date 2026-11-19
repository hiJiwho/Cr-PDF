/* Cr-PDF inner OOPIF plugin wrapper patch:
 * Intentionally minimal no-op so Chromium PDFium + Ink2 handles pen/touch natively with zero interference.
 */
(function () {
  'use strict';
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;
})();
