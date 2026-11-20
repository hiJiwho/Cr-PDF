/* Cr-PDF inner OOPIF plugin wrapper patch (v14):
 * - NEVER calls window.parent.postMessage (eliminates bad IPC reason 319 renderer crash!)
 * - Uses BroadcastChannel('crpdf-live-ink') which is pure renderer-to-renderer and 100% safe in OOPIF.
 * - Equal-partition pressure stepping for N levels (1..5):
 *   Divides [0, 1] into N equal intervals (`Math.min(N, Math.floor(p * N) + 1)`):
 *   e.g. N=3 -> 0~33% = 1, 33~66% = 2, 66~100% = 3 (applies uniformly to all N=1..5).
 * - Broadcasts live pen stroke start/move/end coordinates + pressure level over BroadcastChannel
 *   so the Presenter sub-window draws the exact stroke in real time at 60fps AND Main window saves immediately on stroke end.
 * - Palm rejection: blocks single-finger touch (`pointerType === 'touch'`) from drawing in Ink2.
 */
(function () {
  'use strict';

  if (globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__) return;
  globalThis.__CRPDF_PLUGIN_WRAPPER_INSTALLED__ = true;

  const activeTouches = new Set();

  let inkBc = null;
  try {
    inkBc = new BroadcastChannel('crpdf-live-ink');
  } catch {}

  const penConfig = {
    maxLevel: 3, // N stages (1..5)
    pseudoPressure: true,
    lastLevel: 1,
  };

  if (inkBc) {
    inkBc.addEventListener('message', (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'config') {
        if (typeof msg.maxLevel === 'number' && msg.maxLevel >= 1 && msg.maxLevel <= 5) {
          penConfig.maxLevel = Math.round(msg.maxLevel);
        }
        if (typeof msg.pseudoPressure === 'boolean') {
          penConfig.pseudoPressure = msg.pseudoPressure;
        }
      }
    });
  }

  // Equal N-partition pressure calculation:
  // For N stages: [0, 1/N) -> 1, [1/N, 2/N) -> 2, ..., [(N-1)/N, 1] -> N
  // e.g. N=3 -> 0..33.3% = 1, 33.3..66.6% = 2, 66.6..100% = 3
  function computeEqualStageLevel(pressure, maxLevel) {
    const N = Math.max(1, Math.min(5, Math.round(Number(maxLevel) || 3)));
    if (N === 1) return 1;
    const p = Math.max(0, Math.min(0.999999, Number(pressure) || 0));
    return Math.max(1, Math.min(N, Math.floor(p * N) + 1));
  }

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

  let drawingPenId = null;
  let strokeSeq = 0;
  let currentStrokeId = '';

  function normPoint(e) {
    const w = window.innerWidth || document.documentElement.clientWidth || 1;
    const h = window.innerHeight || document.documentElement.clientHeight || 1;
    const p = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5;
    const level = penConfig.pseudoPressure
      ? computeEqualStageLevel(p, penConfig.maxLevel)
      : penConfig.maxLevel;
    return {
      nx: Math.max(0, Math.min(1, e.clientX / w)),
      ny: Math.max(0, Math.min(1, e.clientY / h)),
      pressure: p,
      level,
    };
  }

  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0)) {
      drawingPenId = e.pointerId;
      strokeSeq += 1;
      currentStrokeId = `s_${Date.now()}_${strokeSeq}`;
      if (inkBc) {
        const pt = normPoint(e);
        const isEraser = (e.buttons & 32) !== 0;
        if (!isEraser && pt.level !== penConfig.lastLevel) {
          penConfig.lastLevel = pt.level;
          try {
            inkBc.postMessage({
              type: 'pressure_level',
              level: pt.level,
              maxLevel: penConfig.maxLevel,
            });
          } catch {}
        }
        try {
          inkBc.postMessage({
            type: 'ink_op',
            op: 'start',
            id: currentStrokeId,
            nx: pt.nx,
            ny: pt.ny,
            pressure: pt.pressure,
            level: pt.level,
            isEraser,
          });
        } catch {}
      }
    }
  }, { capture: true, passive: true });

  window.addEventListener('pointermove', (e) => {
    if (drawingPenId === null || e.pointerId !== drawingPenId) return;
    if ((e.buttons & 1) === 0 && (e.buttons & 32) === 0) return;
    if (inkBc) {
      const pt = normPoint(e);
      const isEraser = (e.buttons & 32) !== 0;
      if (!isEraser && pt.level !== penConfig.lastLevel) {
        penConfig.lastLevel = pt.level;
        try {
          inkBc.postMessage({
            type: 'pressure_level',
            level: pt.level,
            maxLevel: penConfig.maxLevel,
          });
        } catch {}
      }
      try {
        inkBc.postMessage({
          type: 'ink_op',
          op: 'move',
          id: currentStrokeId,
          nx: pt.nx,
          ny: pt.ny,
          pressure: pt.pressure,
          level: pt.level,
        });
      } catch {}
    }
  }, { capture: true, passive: true });

  const endPenStroke = (e) => {
    if (drawingPenId === null || e.pointerId !== drawingPenId) return;
    drawingPenId = null;
    if (inkBc) {
      const pt = normPoint(e);
      try {
        inkBc.postMessage({
          type: 'ink_op',
          op: 'end',
          id: currentStrokeId,
          nx: pt.nx,
          ny: pt.ny,
          level: pt.level,
        });
      } catch {}
    }
  };

  window.addEventListener('pointerup', endPenStroke, { capture: true, passive: true });
  window.addEventListener('pointercancel', endPenStroke, { capture: true, passive: true });
})();
