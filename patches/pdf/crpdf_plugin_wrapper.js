/* Cr-PDF inner OOPIF plugin wrapper patch:
 * - Palm rejection (pointerType === 'pen' draws; 1-finger 'touch' scrolls; >=2-finger pinch-zoom passes through)
 * - Fixed 20% pseudo-pressure capped by maxLevel (1..5), clamped [1, 16], Eraser guarded
 * - Live pen stroke coordinate relay to outer main.js for BroadcastChannel mirror
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const state = {
    palmRejection: true,
    pseudoPressure: true,
    maxLevel: 3,
    activeTool: 'pen',
    isPresenter: false,
    lastStep: null,
    activeTouchPoints: new Map(),
    lastScrollTouch: null,
    activePenId: null,
    strokeSeq: 0,
    currentStrokeId: null,
  };

  function computeRawStepWithHysteresis(pressure, prevStep) {
    const p = Math.max(0, Math.min(1, Number(pressure) || 0));
    const boundaries = [0.2, 0.4, 0.6, 0.8];
    const hyst = 0.04;

    let raw;
    if (p < 0.2) raw = 1;
    else if (p < 0.4) raw = 2;
    else if (p < 0.6) raw = 3;
    else if (p < 0.8) raw = 4;
    else raw = 5;

    if (prevStep != null && prevStep >= 1 && prevStep <= 5 && raw !== prevStep) {
      if (raw > prevStep) {
        const b = boundaries[prevStep - 1];
        if (b != null && p < b + hyst) raw = prevStep;
      } else {
        const b = boundaries[prevStep - 2];
        if (b != null && p > b - hyst) raw = prevStep;
      }
    }
    return raw;
  }

  function computeEffectiveLevel(pressure, maxLevel, prevStep) {
    const rawStep = computeRawStepWithHysteresis(pressure, prevStep);
    const capped = Math.min(Math.max(1, Number(maxLevel) || 3), rawStep);
    return {
      rawStep,
      effectiveLevel: Math.max(1, Math.min(16, capped)),
    };
  }

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

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'crpdf:config') {
      if (typeof msg.palmRejection === 'boolean') state.palmRejection = msg.palmRejection;
      if (typeof msg.pseudoPressure === 'boolean') state.pseudoPressure = msg.pseudoPressure;
      if (typeof msg.maxLevel === 'number') state.maxLevel = Math.max(1, Math.min(5, msg.maxLevel));
      if (typeof msg.activeTool === 'string') state.activeTool = msg.activeTool;
      if (typeof msg.isPresenter === 'boolean') state.isPresenter = msg.isPresenter;
    }
  });

  // Capture-phase touch tracking for multi-touch pinch-zoom passthrough
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
      // Allow native 2-finger pinch-zoom to pass through untouched
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

  // Capture-phase pointer interception for Palm Rejection, Pseudo-Pressure & Stroke Relay
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

    // Palm rejection: block 1-finger touch from reaching Ink2 even pre-stylus
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

      // Apply pseudo-pressure at stroke start (never when Eraser is active)
      if (state.pseudoPressure && state.activeTool !== 'eraser') {
        const { rawStep, effectiveLevel } = computeEffectiveLevel(
          e.pressure,
          state.maxLevel,
          state.lastStep
        );
        state.lastStep = rawStep;
        postToParent({
          type: 'crpdf:pressure_size',
          size: effectiveLevel,
          tool: state.activeTool,
        });
      }

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
