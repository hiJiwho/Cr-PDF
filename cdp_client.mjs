/**
 * Zero-dependency Node.js v24 Chrome DevTools Protocol (CDP) client for Cr-PDF E2E tests.
 *
 * Uses native globalThis.WebSocket and globalThis.fetch.
 * Supports multi-target discovery (/json/list + Target.setDiscoverTargets / Target.getTargets)
 * across:
 *   - Main window (http://127.0.0.1:<port>/...)
 *   - Chromium PDF viewer extension (chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html)
 *   - Presenter sub-window ("[화면공유용] 판서 화면" / crpdf_role=presenter)
 */

export const PDF_EXT_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
export const PRESENTER_TITLE = '[화면공유용] 판서 화면';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps either a dedicated WebSocket connection or a flattened CDP sessionId
 * multiplexed over a browser-level WebSocket.
 */
export class CdpSession {
  constructor({ ws, sessionId = null, browser = null, targetId = null }) {
    this._ws = ws;
    this.sessionId = sessionId;
    this._browser = browser;
    this.targetId = targetId;
    this._nextId = 1;
    this._pending = new Map();
    this._listeners = new Map();
    this._closed = false;

    if (!this._browser) {
      this._onMessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        } catch {
          return;
        }
        this._handleIncoming(msg);
      };
      this._onClose = () => {
        this._closed = true;
        this._rejectAllPending(new Error('CDP WebSocket closed'));
      };
      this._onError = (err) => {
        const message = err?.message || 'CDP WebSocket error';
        this._rejectAllPending(new Error(message));
      };
      this._ws.addEventListener('message', this._onMessage);
      this._ws.addEventListener('close', this._onClose);
      this._ws.addEventListener('error', this._onError);
    }
  }

  _handleIncoming(msg) {
    if (typeof msg.id === 'number') {
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`CDP ${entry.method} failed (${msg.error.code}): ${msg.error.message}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.method) {
      const set = this._listeners.get(msg.method);
      if (set) {
        for (const fn of [...set]) {
          try {
            fn(msg.params ?? {});
          } catch {
            // Isolate listener errors from protocol dispatch loop
          }
        }
      }
    }
  }

  _rejectAllPending(err) {
    for (const [id, entry] of this._pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this._pending.delete(id);
    }
  }

  on(eventName, fn) {
    let set = this._listeners.get(eventName);
    if (!set) {
      set = new Set();
      this._listeners.set(eventName, set);
    }
    set.add(fn);
    return () => this.off(eventName, fn);
  }

  off(eventName, fn) {
    const set = this._listeners.get(eventName);
    if (set) set.delete(fn);
  }

  waitForEvent(eventName, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event "${eventName}" after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on(eventName, (params) => {
        try {
          if (predicate(params)) {
            clearTimeout(timer);
            off();
            resolve(params);
          }
        } catch (err) {
          clearTimeout(timer);
          off();
          reject(err);
        }
      });
    });
  }

  send(method, params = {}, { timeoutMs = 15000 } = {}) {
    if (this._closed) {
      return Promise.reject(new Error(`CDP session closed before sending ${method}`));
    }
    if (this._browser && this.sessionId) {
      return this._browser._sendOnSession(this.sessionId, method, params, timeoutMs);
    }

    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pending.set(id, { method, resolve, reject, timer });
      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._rejectAllPending(new Error('CDP session closed'));
    if (this._browser && this.sessionId) {
      this._browser._unregisterSession(this.sessionId);
      try {
        await this._browser.send('Target.detachFromTarget', { sessionId: this.sessionId }, { timeoutMs: 2000 });
      } catch {
        // Ignore if target already closed
      }
      return;
    }

    if (this._ws && this._ws.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        this._ws.addEventListener('close', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        try {
          this._ws.close();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true, userGesture = false, timeoutMs = 15000 } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue,
        userGesture,
      },
      { timeoutMs },
    );
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description
        || res.exceptionDetails.text
        || 'Unknown Runtime.evaluate exception';
      throw new Error(`CDP Runtime.evaluate exception: ${desc}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async navigate(url, { timeoutMs = 15000 } = {}) {
    return this.send('Page.navigate', { url }, { timeoutMs });
  }

  /**
   * Queries deep across all open Shadow DOM roots.
   * selectorOrPath:
   *   - string CSS selector: DFS over document + every element.shadowRoot
   *   - string[] path: step sequentially through shadow hosts
   */
  async queryDeep(selectorOrPath) {
    const arg = JSON.stringify(selectorOrPath);
    return this.evaluate(`(() => {
      const target = ${arg};
      function isElVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        let cur = el;
        while (cur) {
          if (cur.hidden === true) return false;
          const style = window.getComputedStyle(cur);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false;
          }
          if (cur.parentElement) {
            cur = cur.parentElement;
          } else {
            const root = cur.getRootNode && cur.getRootNode();
            cur = root && root.host ? root.host : null;
          }
        }
        return true;
      }

      function snapshot(el) {
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          found: true,
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className : '',
          text: (el.textContent || '').trim(),
          ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
          title: el.getAttribute ? (el.getAttribute('title') || '') : '',
          visible: isElVisible(el),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          disabled: Boolean(el.disabled || el.getAttribute?.('aria-disabled') === 'true'),
          ariaPressed: el.getAttribute ? el.getAttribute('aria-pressed') : null,
          value: 'value' in el ? el.value : null,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            cx: rect.x + rect.width / 2,
            cy: rect.y + rect.height / 2,
          },
        };
      }

      if (Array.isArray(target)) {
        let root = document;
        let found = null;
        for (let i = 0; i < target.length; i++) {
          found = root.querySelector(target[i]);
          if (!found) return { found: false };
          if (i < target.length - 1) {
            root = found.shadowRoot || found;
          }
        }
        return snapshot(found);
      }

      function dfs(root) {
        if (!root || !root.querySelector) return null;
        const direct = root.querySelector(target);
        if (direct) return direct;
        const nodes = root.querySelectorAll('*');
        for (const node of nodes) {
          if (node.shadowRoot) {
            const inner = dfs(node.shadowRoot);
            if (inner) return inner;
          }
        }
        return null;
      }

      return snapshot(dfs(document));
    })()`);
  }

  /**
   * Returns snapshots of all elements matching selector across document + all Shadow DOM roots.
   */
  async queryAllDeep(selector) {
    const arg = JSON.stringify(selector);
    return this.evaluate(`(() => {
      const sel = ${arg};
      const results = [];
      function isElVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        let cur = el;
        while (cur) {
          if (cur.hidden === true) return false;
          const style = window.getComputedStyle(cur);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false;
          }
          if (cur.parentElement) {
            cur = cur.parentElement;
          } else {
            const root = cur.getRootNode && cur.getRootNode();
            cur = root && root.host ? root.host : null;
          }
        }
        return true;
      }
      function visit(root) {
        if (!root || !root.querySelectorAll) return;
        for (const el of root.querySelectorAll(sel)) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          results.push({
            found: true,
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            id: el.id || '',
            className: typeof el.className === 'string' ? el.className : '',
            text: (el.textContent || '').trim(),
            ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
            title: el.getAttribute ? (el.getAttribute('title') || '') : '',
            visible: isElVisible(el),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            disabled: Boolean(el.disabled || el.getAttribute?.('aria-disabled') === 'true'),
            ariaPressed: el.getAttribute ? el.getAttribute('aria-pressed') : null,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              cx: rect.x + rect.width / 2,
              cy: rect.y + rect.height / 2,
            },
          });
        }
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) visit(node.shadowRoot);
        }
      }
      visit(document);
      return results;
    })()`);
  }

  async waitForDeep(selectorOrPath, { visible = true, timeoutMs = 10000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = { found: false };
    while (Date.now() < deadline) {
      last = await this.queryDeep(selectorOrPath);
      if (last.found && (!visible || last.visible)) {
        return last;
      }
      await sleep(pollMs);
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for deep selector ${JSON.stringify(selectorOrPath)} (visible=${visible}); last=${JSON.stringify(last)}`,
    );
  }

  async clickDeep(selectorOrPath, { pageSession = null, timeoutMs = 10000 } = {}) {
    const snap = await this.waitForDeep(selectorOrPath, { visible: true, timeoutMs });
    if (pageSession) {
      await pageSession.dispatchMouseClick(snap.rect.cx, snap.rect.cy);
      return snap;
    }
    const arg = JSON.stringify(selectorOrPath);
    await this.evaluate(
      `(() => {
        const target = ${arg};
        function findEl() {
          if (Array.isArray(target)) {
            let root = document;
            let found = null;
            for (let i = 0; i < target.length; i++) {
              found = root.querySelector(target[i]);
              if (!found) return null;
              if (i < target.length - 1) root = found.shadowRoot || found;
            }
            return found;
          }
          function dfs(root) {
            if (!root || !root.querySelector) return null;
            const d = root.querySelector(target);
            if (d) return d;
            for (const n of root.querySelectorAll('*')) {
              if (n.shadowRoot) {
                const r = dfs(n.shadowRoot);
                if (r) return r;
              }
            }
            return null;
          }
          return dfs(document);
        }
        const el = findEl();
        if (!el) throw new Error('Element disappeared before click: ' + JSON.stringify(target));
        el.click();
        return true;
      })()`,
      { userGesture: true },
    );
    return snap;
  }

  // ---- Synthetic Input Dispatchers (send to top-level page target) ----

  async dispatchMouseMove(x, y, { pointerType = 'mouse', buttons = 0, force = 0 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: buttons ? 'left' : 'none',
      buttons,
      pointerType,
      force,
    });
  }

  async dispatchMouseClick(x, y, { button = 'left', pointerType = 'mouse' } = {}) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rx,
      y: ry,
      button: 'none',
      buttons: 0,
      pointerType,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rx,
      y: ry,
      button,
      buttons: 1,
      clickCount: 1,
      pointerType,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rx,
      y: ry,
      button,
      buttons: 0,
      clickCount: 1,
      pointerType,
    });
  }

  async dispatchMouseDrag(points, { steps = 5, stepDelayMs = 8 } = {}) {
    if (!Array.isArray(points) || points.length < 2) {
      throw new Error('dispatchMouseDrag requires at least 2 points');
    }
    const p0 = points[0];
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(p0.x),
      y: Math.round(p0.y),
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(p0.x),
      y: Math.round(p0.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(a.x + (b.x - a.x) * t),
          y: Math.round(a.y + (b.y - a.y) * t),
          button: 'left',
          buttons: 1,
          pointerType: 'mouse',
        });
        if (stepDelayMs > 0) await sleep(stepDelayMs);
      }
    }

    const last = points[points.length - 1];
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(last.x),
      y: Math.round(last.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    });
  }

  /**
   * Dispatches a realistic stylus pen stroke via Input.dispatchMouseEvent with pointerType: 'pen'.
   * Supports per-point `force` override (p.force ?? force), hoverLeadIn, and optional holdMs before release.
   */
  async dispatchPenStroke(
    points,
    { force = 0.5, tiltX = 0, tiltY = 0, steps = 4, hoverLeadIn = true, stepDelayMs = 8, holdMs = 0 } = {},
  ) {
    if (!Array.isArray(points) || points.length < 2) {
      throw new Error('dispatchPenStroke requires at least 2 points');
    }
    const p0 = points[0];
    const p0Force = p0.force ?? force;

    if (hoverLeadIn) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(p0.x),
        y: Math.round(p0.y),
        button: 'none',
        buttons: 0,
        pointerType: 'pen',
        force: 0,
        tiltX,
        tiltY,
      });
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(p0.x),
      y: Math.round(p0.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'pen',
      force: p0Force,
      tiltX,
      tiltY,
    });

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const fa = a.force ?? force;
      const fb = b.force ?? force;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(a.x + (b.x - a.x) * t),
          y: Math.round(a.y + (b.y - a.y) * t),
          button: 'left',
          buttons: 1,
          pointerType: 'pen',
          force: fa + (fb - fa) * t,
          tiltX,
          tiltY,
        });
        if (stepDelayMs > 0) await sleep(stepDelayMs);
      }
    }

    if (holdMs > 0) {
      await sleep(holdMs);
    }

    const last = points[points.length - 1];
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(last.x),
      y: Math.round(last.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'pen',
      force: 0,
      tiltX,
      tiltY,
    });
  }

  /**
   * Dispatches a single-finger touch drag (or stationary tap when points has 1 point / same coords).
   */
  async dispatchTouchDrag(points, { steps = 6, stepDelayMs = 10, id = 1, holdMs = 0 } = {}) {
    if (!Array.isArray(points) || points.length < 1) {
      throw new Error('dispatchTouchDrag requires at least 1 point');
    }
    const p0 = points[0];
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: Math.round(p0.x), y: Math.round(p0.y), radiusX: 12, radiusY: 12, force: 0.5, id }],
    });

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        await this.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: Math.round(a.x + (b.x - a.x) * t),
              y: Math.round(a.y + (b.y - a.y) * t),
              radiusX: 12,
              radiusY: 12,
              force: 0.5,
              id,
            },
          ],
        });
        if (stepDelayMs > 0) await sleep(stepDelayMs);
      }
    }

    if (holdMs > 0) {
      await sleep(holdMs);
    }

    await this.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  }

  /**
   * Dispatches a 2-finger symmetric pinch-zoom gesture around center = { x, y }.
   */
  async dispatchPinchZoom(center, startDist, endDist, { steps = 8, stepDelayMs = 12 } = {}) {
    const makePair = (dist) => [
      { x: Math.round(center.x - dist / 2), y: Math.round(center.y), radiusX: 10, radiusY: 10, force: 0.5, id: 1 },
      { x: Math.round(center.x + dist / 2), y: Math.round(center.y), radiusX: 10, radiusY: 10, force: 0.5, id: 2 },
    ];

    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: makePair(startDist),
    });

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const dist = startDist + (endDist - startDist) * t;
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: makePair(dist),
      });
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }

    await this.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  }

  /**
   * Dispatches a multi-touch (e.g., 3-finger palm rest) gesture.
   */
  async dispatchMultiTouch(startPoints, endPoints, { steps = 4, stepDelayMs = 10 } = {}) {
    const toTouchPoints = (pts) =>
      pts.map((p, idx) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
        radiusX: 16,
        radiusY: 16,
        force: 0.6,
        id: idx + 1,
      }));

    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: toTouchPoints(startPoints),
    });

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const interp = startPoints.map((a, idx) => {
        const b = endPoints[idx] ?? a;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      });
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: toTouchPoints(interp),
      });
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }

    await this.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  }

  async pressShortcut({ key, code, vkCode, modifiers = 2 }) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers,
      key,
      code,
      windowsVirtualKeyCode: vkCode,
      nativeVirtualKeyCode: vkCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      key,
      code,
      windowsVirtualKeyCode: vkCode,
      nativeVirtualKeyCode: vkCode,
    });
  }

  async pressCtrlS() {
    await this.pressShortcut({ key: 's', code: 'KeyS', vkCode: 83, modifiers: 2 });
  }

  async pressCtrlZ() {
    await this.pressShortcut({ key: 'z', code: 'KeyZ', vkCode: 90, modifiers: 2 });
  }
}

/**
 * Browser-level CDP controller with /json/list + Target.setDiscoverTargets discovery
 * and multiplexed flattened sessions.
 */
export class CdpBrowser {
  constructor(cdpPort, browserWs) {
    this.cdpPort = cdpPort;
    this._ws = browserWs;
    this._nextId = 1;
    this._pending = new Map();
    this._sessions = new Map();
    this._targets = new Map();
    this._listeners = new Map();
    this._closed = false;

    this._ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      this._handleIncoming(msg);
    });

    this._ws.addEventListener('close', () => {
      this._closed = true;
      const err = new Error('Browser CDP WebSocket closed');
      for (const [, entry] of this._pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this._pending.clear();
      for (const session of this._sessions.values()) {
        session._closed = true;
        session._rejectAllPending(err);
      }
      this._sessions.clear();
    });
  }

  _handleIncoming(msg) {
    if (typeof msg.id === 'number') {
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`CDP ${entry.method} failed (${msg.error.code}): ${msg.error.message}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.sessionId) {
      const session = this._sessions.get(msg.sessionId);
      if (session) {
        session._handleIncoming(msg);
      }
      return;
    }

    if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo) {
      const info = msg.params.targetInfo;
      this._targets.set(info.targetId, info);
    } else if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo) {
      const info = msg.params.targetInfo;
      this._targets.set(info.targetId, info);
    } else if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
      this._targets.delete(msg.params.targetId);
    }

    if (msg.method) {
      const set = this._listeners.get(msg.method);
      if (set) {
        for (const fn of [...set]) {
          try {
            fn(msg.params ?? {});
          } catch {
            // Isolate listener errors
          }
        }
      }
    }
  }

  on(eventName, fn) {
    let set = this._listeners.get(eventName);
    if (!set) {
      set = new Set();
      this._listeners.set(eventName, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  send(method, params = {}, { timeoutMs = 15000 } = {}) {
    return this._sendRaw(null, method, params, timeoutMs);
  }

  _sendOnSession(sessionId, method, params, timeoutMs) {
    return this._sendRaw(sessionId, method, params, timeoutMs);
  }

  _sendRaw(sessionId, method, params, timeoutMs) {
    if (this._closed) {
      return Promise.reject(new Error(`Browser CDP connection closed before sending ${method}`));
    }
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pending.set(id, { method, resolve, reject, timer });
      const payload = sessionId ? { id, sessionId, method, params } : { id, method, params };
      try {
        this._ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _unregisterSession(sessionId) {
    this._sessions.delete(sessionId);
  }

  async init() {
    await this.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos = [] } = await this.send('Target.getTargets');
    for (const info of targetInfos) {
      this._targets.set(info.targetId, info);
    }
  }

  /**
   * Merges live targets from both /json/list and Target.getTargets.
   */
  async listTargets() {
    const merged = new Map();

    try {
      const { targetInfos = [] } = await this.send('Target.getTargets', {}, { timeoutMs: 5000 });
      for (const info of targetInfos) {
        merged.set(info.targetId, {
          targetId: info.targetId,
          type: info.type,
          title: info.title || '',
          url: info.url || '',
          attached: Boolean(info.attached),
          browserContextId: info.browserContextId,
        });
      }
    } catch {
      // Fallback to /json/list below
    }

    try {
      const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const list = await res.json();
        for (const item of list) {
          const id = item.id;
          const prev = merged.get(id) || {};
          merged.set(id, {
            ...prev,
            targetId: id,
            type: item.type || prev.type || '',
            title: item.title ?? prev.title ?? '',
            url: item.url ?? prev.url ?? '',
            webSocketDebuggerUrl: item.webSocketDebuggerUrl,
          });
        }
      }
    } catch {
      // /json/list may momentarily fail during navigation
    }

    return [...merged.values()];
  }

  async attachToTarget(targetInfo, { preferDirectWs = false } = {}) {
    let session;
    if (preferDirectWs && targetInfo.webSocketDebuggerUrl) {
      const ws = await openWebSocket(targetInfo.webSocketDebuggerUrl, 10000);
      session = new CdpSession({ ws, targetId: targetInfo.targetId });
    } else {
      const { sessionId } = await this.send('Target.attachToTarget', {
        targetId: targetInfo.targetId,
        flatten: true,
      });
      session = new CdpSession({
        ws: this._ws,
        sessionId,
        browser: this,
        targetId: targetInfo.targetId,
      });
      this._sessions.set(sessionId, session);
    }

    await session.send('Runtime.enable').catch(() => {});
    await session.send('Page.enable').catch(() => {});
    return session;
  }

  async closeTarget(targetId) {
    try {
      await this.send('Target.closeTarget', { targetId }, { timeoutMs: 5000 });
    } catch {
      // Target may already be closed
    }
  }

  async waitForTarget(predicate, { timeoutMs = 15000, pollMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastTargets = [];
    while (Date.now() < deadline) {
      lastTargets = await this.listTargets();
      const match = lastTargets.find((t) => {
        try {
          return predicate(t);
        } catch {
          return false;
        }
      });
      if (match) {
        const session = await this.attachToTarget(match);
        return { target: match, session };
      }
      await sleep(pollMs);
    }
    const summary = lastTargets.map((t) => `${t.type}:${t.title}:${t.url}`).join(' | ');
    throw new Error(`Timed out after ${timeoutMs}ms waiting for CDP target. Seen: [${summary}]`);
  }

  async waitForMainPage(appPort, opts = {}) {
    const origin = `http://127.0.0.1:${appPort}`;
    return this.waitForTarget(
      (t) =>
        t.type === 'page' &&
        t.url.startsWith(origin) &&
        !t.url.includes('crpdf_role=presenter') &&
        t.title !== PRESENTER_TITLE,
      opts,
    );
  }

  async waitForPresenterPage(appPort, opts = {}) {
    return this.waitForTarget(
      (t) =>
        t.type === 'page' &&
        (t.title === PRESENTER_TITLE ||
          t.url.includes('crpdf_role=presenter') ||
          (appPort && t.url.startsWith(`http://127.0.0.1:${appPort}`) && t.title === PRESENTER_TITLE)),
      opts,
    );
  }

  /**
   * Finds and attaches to the Chromium PDF viewer extension target.
   * Disambiguates main vs presenter PDF viewer when both windows are open.
   */
  async waitForPdfViewer({ role = 'main', excludeTargetIds = new Set(), timeoutMs = 15000, pollMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const allowedTypes = new Set(['page', 'iframe', 'other', 'webview']);
    let lastCandidates = [];

    while (Date.now() < deadline) {
      const targets = await this.listTargets();
      const candidates = targets.filter(
        (t) =>
          allowedTypes.has(t.type) &&
          t.url.startsWith(PDF_EXT_ORIGIN) &&
          !excludeTargetIds.has(t.targetId),
      );
      lastCandidates = candidates;

      for (const candidate of candidates) {
        let session;
        try {
          session = await this.attachToTarget(candidate);
          const probe = await session.evaluate(`(() => ({
            ready: document.readyState,
            isPresenter: Boolean(
              document.body?.classList?.contains('crpdf-presenter') ||
              document.documentElement?.classList?.contains('crpdf-presenter') ||
              document.title === ${JSON.stringify(PRESENTER_TITLE)} ||
              window.location.href.includes('crpdf_role=presenter')
            ),
            hasViewer: Boolean(document.querySelector('pdf-viewer')),
          }))()`, { timeoutMs: 3000 });

          if (!probe || !probe.hasViewer) {
            await session.close();
            continue;
          }
          const wantsPresenter = role === 'presenter';
          if (probe.isPresenter === wantsPresenter) {
            return { target: candidate, session };
          }
          await session.close();
        } catch {
          if (session) await session.close().catch(() => {});
        }
      }
      await sleep(pollMs);
    }

    const summary = lastCandidates.map((t) => `${t.type}:${t.targetId}:${t.url}`).join(' | ');
    throw new Error(`Timed out after ${timeoutMs}ms waiting for PDF viewer (role=${role}). Candidates: [${summary}]`);
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const session of [...this._sessions.values()]) {
      await session.close().catch(() => {});
    }
    this._sessions.clear();
    if (this._ws && this._ws.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        this._ws.addEventListener('close', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        try {
          this._ws.close();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }
}

function openWebSocket(wsUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`Timed out opening CDP WebSocket ${wsUrl} after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to open CDP WebSocket ${wsUrl}: ${err?.message || 'connection error'}`));
      },
      { once: true },
    );
  });
}

/**
 * Connects to a running CEF/Chromium instance's remote debugging port.
 */
export async function connectCdp(cdpPort, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const info = await res.json();
        if (info.webSocketDebuggerUrl) {
          const ws = await openWebSocket(info.webSocketDebuggerUrl, 8000);
          const browser = new CdpBrowser(cdpPort, ws);
          await browser.init();
          return browser;
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(
    `Unable to connect CDP on port ${cdpPort} within ${timeoutMs}ms: ${lastErr?.message || 'no response'}`,
  );
}
