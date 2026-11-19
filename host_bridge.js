(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.HostBridge = api.HostBridge;
    root.HostBridgeError = api.HostBridgeError;
    root.createHostBridge = api.createHostBridge;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAGE_SIZE_PRESETS = Object.freeze({
    a4: Object.freeze({ widthMm: 210, heightMm: 297 }),
    letter: Object.freeze({ widthMm: 215.9, heightMm: 279.4 }),
    '16x9': Object.freeze({ widthMm: 297, heightMm: 167 }),
  });

  const VALID_TEMPLATES = new Set(['blank', 'lined', 'grid', 'dot']);
  const MIN_DIM_MM = 50;
  const MAX_DIM_MM = 1000;
  const MIN_PAGES = 1;
  const MAX_PAGES = 50;

  class HostBridgeError extends Error {
    constructor(message, { status = 0, code = 'HOST_ERROR', details = null } = {}) {
      super(message);
      this.name = 'HostBridgeError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  function validateSafeName(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new HostBridgeError('Notebook name is required.', {
        code: 'INVALID_NAME',
      });
    }
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new HostBridgeError('Notebook name contains invalid path characters.', {
        code: 'INVALID_NAME',
      });
    }
    return name;
  }

  function clampDimensionMm(value, fieldName) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new HostBridgeError(`${fieldName} must be a valid number in mm.`, {
        code: 'INVALID_DIMENSIONS',
      });
    }
    if (num < MIN_DIM_MM || num > MAX_DIM_MM) {
      throw new HostBridgeError(
        `${fieldName} must be between ${MIN_DIM_MM} and ${MAX_DIM_MM} mm.`,
        { code: 'INVALID_DIMENSIONS' }
      );
    }
    return Math.round(num * 10) / 10;
  }

  function clampPages(pages) {
    const num = Math.floor(Number(pages));
    if (!Number.isFinite(num)) {
      return MIN_PAGES;
    }
    return Math.max(MIN_PAGES, Math.min(MAX_PAGES, num));
  }

  function hasPdfHeader(bytes) {
    return (
      bytes.byteLength >= 5 &&
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46 && // F
      bytes[4] === 0x2d // -
    );
  }

  async function normalizePdfBytes(fileOrBytes) {
    if (!fileOrBytes) {
      throw new HostBridgeError('No PDF file data provided.', {
        code: 'INVALID_PDF',
      });
    }
    let buffer;
    if (typeof Blob !== 'undefined' && fileOrBytes instanceof Blob) {
      buffer = await fileOrBytes.arrayBuffer();
    } else if (fileOrBytes instanceof ArrayBuffer) {
      buffer = fileOrBytes;
    } else if (ArrayBuffer.isView(fileOrBytes)) {
      buffer = fileOrBytes.buffer.slice(
        fileOrBytes.byteOffset,
        fileOrBytes.byteOffset + fileOrBytes.byteLength
      );
    } else {
      throw new HostBridgeError('Unsupported PDF payload type.', {
        code: 'INVALID_PDF',
      });
    }

    const view = new Uint8Array(buffer);
    if (view.byteLength === 0 || !hasPdfHeader(view)) {
      throw new HostBridgeError(
        '유효한 PDF 파일이 아닙니다. (%PDF- 헤더 누락) / File is not a valid PDF.',
        { code: 'INVALID_PDF' }
      );
    }
    return view;
  }

  class HostBridge {
    constructor({ baseUrl = '', fetchImpl = null, defaultTimeoutMs = 15000 } = {}) {
      this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
      this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
      this.defaultTimeoutMs = defaultTimeoutMs;
    }

    async _request(
      path,
      { method = 'GET', headers = {}, body = undefined, timeoutMs = this.defaultTimeoutMs, cache = undefined } = {}
    ) {
      const url = `${this.baseUrl}${path}`;
      const options = { method, headers: { ...headers } };
      if (body !== undefined) {
        options.body = body;
      }
      if (cache !== undefined) {
        options.cache = cache;
      }

      let controller = null;
      let timerId = null;
      if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
        controller = new AbortController();
        options.signal = controller.signal;
        timerId = setTimeout(() => controller.abort(), timeoutMs);
      }

      let response;
      try {
        response = await this._fetch(url, options);
      } catch (err) {
        const isAbort = err && err.name === 'AbortError';
        throw new HostBridgeError(
          isAbort ? 'Request timed out.' : (err && err.message) || 'Network error',
          { status: 0, code: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR' }
        );
      } finally {
        if (timerId !== null) {
          clearTimeout(timerId);
        }
      }

      const contentType =
        (response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : '') || '';

      let parsedBody = null;
      try {
        if (contentType.includes('application/json')) {
          parsedBody = await response.json();
        } else {
          const text = await response.text();
          if (text) {
            try {
              parsedBody = JSON.parse(text);
            } catch (_) {
              parsedBody = text;
            }
          }
        }
      } catch (_) {
        parsedBody = null;
      }

      if (!response.ok) {
        const msg =
          (parsedBody && typeof parsedBody === 'object' && (parsedBody.error || parsedBody.message)) ||
          (typeof parsedBody === 'string' && parsedBody.trim()) ||
          response.statusText ||
          `HTTP ${response.status}`;
        throw new HostBridgeError(String(msg), {
          status: response.status,
          code: (parsedBody && typeof parsedBody === 'object' && parsedBody.code) || 'HTTP_ERROR',
          details: parsedBody,
        });
      }

      return parsedBody;
    }

    async getConfig() {
      const data = await this._request('/api/config', {
        method: 'GET',
        cache: 'no-store',
      });
      return {
        saveDir: data && typeof data.saveDir === 'string' ? data.saveDir : '',
        autosaveIntervalSec:
          data && typeof data.autosaveIntervalSec === 'number' ? data.autosaveIntervalSec : 30,
        autosaveEnabled:
          data && typeof data.autosaveEnabled === 'boolean' ? data.autosaveEnabled : true,
        palmRejection:
          data && typeof data.palmRejection === 'boolean' ? data.palmRejection : true,
        pseudoPressure:
          data && typeof data.pseudoPressure === 'boolean' ? data.pseudoPressure : true,
      };
    }

    async updateConfig(patch) {
      if (!patch || typeof patch !== 'object') {
        throw new HostBridgeError('Config patch must be an object.', {
          code: 'INVALID_CONFIG',
        });
      }
      return this._request('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    }

    async pickFolder() {
      // No timeout: user may keep the native OS folder dialog open for minutes.
      return this._request('/api/pick-folder', {
        method: 'POST',
        timeoutMs: 0,
      });
    }

    async listNotebooks() {
      const data = await this._request('/api/notebooks', {
        method: 'GET',
        cache: 'no-store',
      });
      const list = Array.isArray(data)
        ? data
        : data && Array.isArray(data.notebooks)
          ? data.notebooks
          : [];
      return list
        .filter((item) => item && typeof item.name === 'string')
        .map((item) => {
          let url = item.url;
          if (!url) {
            try {
              url = this.getPdfUrl(item.name);
            } catch (_) {
              url = `${this.baseUrl}/pdf/${encodeURIComponent(item.name)}`;
            }
          }
          return {
            name: item.name,
            size: typeof item.size === 'number' ? item.size : 0,
            mtime: typeof item.mtime === 'number' ? item.mtime : 0,
            url,
          };
        });
    }

    async createNotebook(opts = {}) {
      const rawTitle = typeof opts.title === 'string' ? opts.title.trim() : '';
      if (!rawTitle) {
        throw new HostBridgeError('노트 제목을 입력해 주세요. / Notebook title is required.', {
          code: 'INVALID_TITLE',
        });
      }
      if (
        rawTitle === '.' ||
        rawTitle.includes('..') ||
        rawTitle.includes('/') ||
        rawTitle.includes('\\')
      ) {
        throw new HostBridgeError(
          '제목에 경로 문자(/, \\, ..)는 사용할 수 없습니다. / Title contains invalid path characters.',
          { code: 'INVALID_NAME' }
        );
      }
      if (/[:*?"<>|]/.test(rawTitle)) {
        throw new HostBridgeError(
          '제목에 사용할 수 없는 문자가 포함되어 있습니다. / Title contains invalid characters.',
          { code: 'INVALID_TITLE' }
        );
      }

      const template = VALID_TEMPLATES.has(opts.template) ? opts.template : 'blank';
      const rawSize = typeof opts.pageSize === 'string' ? opts.pageSize.toLowerCase() : 'a4';
      const isCustom = rawSize === 'custom' || !Object.prototype.hasOwnProperty.call(PAGE_SIZE_PRESETS, rawSize);
      const pageSize = isCustom ? 'custom' : rawSize;

      let widthMm;
      let heightMm;
      if (isCustom) {
        widthMm = clampDimensionMm(opts.widthMm, 'widthMm');
        heightMm = clampDimensionMm(opts.heightMm, 'heightMm');
      } else {
        const preset = PAGE_SIZE_PRESETS[pageSize];
        widthMm = opts.widthMm !== undefined ? clampDimensionMm(opts.widthMm, 'widthMm') : preset.widthMm;
        heightMm = opts.heightMm !== undefined ? clampDimensionMm(opts.heightMm, 'heightMm') : preset.heightMm;
      }

      const pages = clampPages(opts.pages !== undefined ? opts.pages : 1);

      const payload = {
        title: rawTitle,
        template,
        pageSize,
        widthMm,
        heightMm,
        pages,
      };

      const result = await this._request('/api/notebooks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const name = result && result.name ? result.name : `${rawTitle}.pdf`;
      return {
        ...result,
        name,
        url: (result && result.url) || this.getPdfUrl(name),
      };
    }

    async addPage(name, opts = {}) {
      const safeName = validateSafeName(name);
      const payload = {};
      if (opts && typeof opts === 'object') {
        if (typeof opts.template === 'string' && VALID_TEMPLATES.has(opts.template)) {
          payload.template = opts.template;
        }
        if (opts.widthMm !== undefined && opts.widthMm !== null) {
          payload.widthMm = clampDimensionMm(opts.widthMm, 'widthMm');
        }
        if (opts.heightMm !== undefined && opts.heightMm !== null) {
          payload.heightMm = clampDimensionMm(opts.heightMm, 'heightMm');
        }
      }

      return this._request(`/api/notebooks/${encodeURIComponent(safeName)}/add-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    async importNotebook(fileOrBytes, name) {
      const inferredName =
        typeof name === 'string' && name.trim()
          ? name.trim()
          : fileOrBytes && typeof fileOrBytes.name === 'string'
            ? fileOrBytes.name.trim()
            : '';

      if (!inferredName) {
        throw new HostBridgeError('PDF filename is required.', {
          code: 'INVALID_NAME',
        });
      }

      let safeName = inferredName.split(/[/\\]/).pop() || '';
      if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('..')) {
        throw new HostBridgeError('Invalid PDF filename.', {
          code: 'INVALID_NAME',
        });
      }
      if (!/\.pdf$/i.test(safeName)) {
        safeName = `${safeName}.pdf`;
      }

      const bytes = await normalizePdfBytes(fileOrBytes);
      const result = await this._request(
        `/api/notebooks/import?name=${encodeURIComponent(safeName)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: bytes,
        }
      );

      const outName = (result && result.name) || safeName;
      return {
        ...result,
        name: outName,
        url: (result && result.url) || this.getPdfUrl(outName),
      };
    }

    async deleteNotebook(name) {
      const safeName = validateSafeName(name);
      return this._request(`/api/notebooks/${encodeURIComponent(safeName)}`, {
        method: 'DELETE',
      });
    }

    getPdfUrl(name) {
      const safeName = validateSafeName(name);
      return `${this.baseUrl}/pdf/${encodeURIComponent(safeName)}`;
    }
  }

  function createHostBridge(options) {
    return new HostBridge(options);
  }

  return {
    HostBridge,
    HostBridgeError,
    createHostBridge,
    PAGE_SIZE_PRESETS,
  };
});
