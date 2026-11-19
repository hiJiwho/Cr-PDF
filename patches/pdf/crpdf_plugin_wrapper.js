/* Cr-PDF inner OOPIF plugin wrapper patch (v11):
 * - Palm rejection: blocks finger touch (`pointerType === 'touch'`) from drawing in Ink2!
 *   - 1-finger touch drag sends scroll delta (`crpdf:scroll_delta`) to outer pdf-viewer so finger pans/scrolls the page
 *   - >=2-finger touch allows pinch-zoom
 *   - Only stylus pen (`pointerType === 'pen'`) and mouse (`pointerType === 'mouse'`) can draw strokes
 * - Notifies outer chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai frame when a pen/mouse stroke ends
 *   using exact targetOrigin ('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai') so bad IPC reason 319 never occurs.
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const PDF_EXT_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
  let isDrawing = false;
  const activeTouches = new Map();
  let lastSingleTouch = null;

  function postToExtension(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, PDF_EXT_ORIGIN);
      }
    } catch {
      // ignore
    }
  }

  function notifyStrokeEnd() {
    if (!isDrawing) return;
    isDrawing = false;
    postToExtension({ type: 'crpdf:stroke_finished' });
  }

  // Block finger touch from drawing in Ink2; convert 1-finger touch drag into page scroll
  window.addEventListener('touchstart', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      lastSingleTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      e.stopImmediatePropagation();
    } else {
      lastSingleTouch = null;
    }
  }, { capture: true, passive: false });

  window.addEventListener('touchmove', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (lastSingleTouch && lastSingleTouch.id === t.identifier) {
        const dx = lastSingleTouch.x - t.clientX;
        const dy = lastSingleTouch.y - t.clientY;
        lastSingleTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          postToExtension({ type: 'crpdf:scroll_delta', dx, dy });
        }
      } else {
        lastSingleTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    } else {
      lastSingleTouch = null;
    }
  }, { capture: true, passive: false });

  const onTouchEnd = (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouches.delete(e.changedTouches[i].identifier);
    }
    if (e.touches.length === 0) {
      lastSingleTouch = null;
    }
  };
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

  // Block pointer events from finger touch so Ink2 never draws with hand/palm
  function onPointerEvent(e) {
    if (e.pointerType === 'touch') {
      if (activeTouches.size < 2) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }

    if (e.type === 'pointerdown') {
      if (e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0)) {
        isDrawing = true;
      }
    } else if (e.type === 'pointerup' || e.type === 'pointercancel') {
      if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
        notifyStrokeEnd();
      }
    }
  }

  for (const evt of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    window.addEventListener(evt, onPointerEvent, { capture: true, passive: false });
  }

  window.addEventListener('mouseup', () => {
    notifyStrokeEnd();
  }, { capture: true, passive: true });
})();
