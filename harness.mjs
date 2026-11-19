/**
 * Zero-dependency Node.js v24 E2E test harness for Cr-PDF.
 *
 * Provides:
 *   - Ephemeral TCP port allocation (127.0.0.1:0)
 *   - Process launcher under xvfb-run (Linux headless) with deterministic teardown & log capture
 *   - Full loopback HTTP API client covering PROJECT.md § Interface Contracts
 *   - Minimal valid PDF 1.4 generator & incremental-update-aware inspectPdfBuffer
 *   - Synthetic Chromium DataPack v5 (.pak) builder & parser (raw, gzip, Chromium-Brotli)
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp_client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const MM_TO_PT = 72 / 25.4;
export function mmToPt(mm) {
  return mm * MM_TO_PT;
}

const activeApps = new Set();
let signalHandlersRegistered = false;

function registerCleanupHandlers() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  const cleanupSync = () => {
    for (const app of [...activeApps]) {
      try {
        app._killSync();
      } catch {
        // best-effort cleanup
      }
    }
  };

  process.on('exit', cleanupSync);
  process.on('SIGINT', () => {
    cleanupSync();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanupSync();
    process.exit(143);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Allocates `count` distinct ephemeral TCP ports on 127.0.0.1 by binding all
 * servers concurrently before closing them.
 */
export async function allocatePorts(count = 2) {
  const servers = [];
  const ports = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      servers.push(server);
      ports.push(server.address().port);
    }
  } finally {
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise((resolve) => {
            try {
              srv.close(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
  }
  return ports;
}

/**
 * Resolves the Cr-PDF binary path (explicit override -> CRPDF_BIN -> default build path).
 */
export function resolveBinaryPath(overridePath = null) {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.CRPDF_BIN) return path.resolve(process.env.CRPDF_BIN);
  if (process.platform === 'win32') {
    const rel = path.join(REPO_ROOT, 'build', 'Release', 'CrPDF.exe');
    if (fs.existsSync(rel)) return rel;
    return path.join(REPO_ROOT, 'build', 'CrPDF.exe');
  }
  return path.join(REPO_ROOT, 'build', 'cr-pdf');
}

/**
 * Resolves the base resources.pak path for real CEF pak verification tests.
 */
export function resolveBasePakPath(overridePath = null) {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.CRPDF_BASE_PAK) return path.resolve(process.env.CRPDF_BASE_PAK);
  if (process.env.CRPDF_PAK) return path.resolve(process.env.CRPDF_PAK);

  const candidates = [
    path.join(REPO_ROOT, 'build', 'resources.pak'),
    path.join(REPO_ROOT, 'build', 'Release', 'resources.pak'),
    path.join(REPO_ROOT, 'third_party', 'cef', 'Resources', 'resources.pak'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * Builds the CLI argument vector for launching cr-pdf.
 */
export function buildLaunchArgs({
  appPort,
  cdpPort,
  saveDir,
  autosaveInterval = 0,
  openPdf = null,
  extraArgs = [],
}) {
  const args = [
    '--no-sandbox',
    '--disable-gpu',
    `--port=${appPort}`,
    `--remote-debugging-port=${cdpPort}`,
    `--save-dir=${saveDir}`,
    `--autosave-interval=${autosaveInterval}`,
  ];
  if (openPdf) {
    args.push(`--open=${openPdf}`);
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args;
}

/**
 * Launches Cr-PDF under xvfb-run (on headless Linux) with isolated saveDir and ephemeral ports.
 */
export async function launchApp(options = {}) {
  registerCleanupHandlers();

  const binPath = resolveBinaryPath(options.binPath);
  if (!fs.existsSync(binPath)) {
    throw new Error(`Cr-PDF binary not found at "${binPath}". Build the project or set CRPDF_BIN.`);
  }

  const [appPort, cdpPort] = await allocatePorts(2);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crpdf-e2e-'));
  const saveDir = options.saveDir ? path.resolve(options.saveDir) : path.join(tmpDir, 'notes');
  fs.mkdirSync(saveDir, { recursive: true });

  const args = buildLaunchArgs({
    appPort,
    cdpPort,
    saveDir,
    autosaveInterval: options.autosaveInterval ?? 0,
    openPdf: options.openPdf ?? null,
    extraArgs: options.extraArgs ?? [],
  });

  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY && !options.noXvfb;
  const spawnCmd = useXvfb ? 'xvfb-run' : binPath;
  const spawnArgs = useXvfb
    ? ['-a', '--server-args=-screen 0 1280x800x24', binPath, ...args]
    : args;

  const logBuffer = [];
  const MAX_LOG_LINES = 500;
  const pushLog = (prefix, chunk) => {
    const lines = chunk.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      logBuffer.push(`${prefix} ${line}`);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    }
  };

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: options.cwd || path.dirname(binPath),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
  });

  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  child.stdout?.on('data', (d) => pushLog('[stdout]', d));
  child.stderr?.on('data', (d) => pushLog('[stderr]', d));
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  const api = createApiClient(baseUrl);
  let stopped = false;

  const app = {
    binPath,
    appPort,
    cdpPort,
    baseUrl,
    tmpDir,
    saveDir,
    api,
    cdp: null,
    child,
    getLogs(tail = 60) {
      return logBuffer.slice(-tail).join('\n');
    },
    _killSync() {
      if (!exited && child.pid) {
        try {
          if (process.platform !== 'win32') {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
          }
        } catch {
          // already dead
        }
      }
      if (process.env.KEEP_E2E_TMP !== '1') {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      activeApps.delete(app);

      if (app.cdp) {
        await app.cdp.close().catch(() => {});
        app.cdp = null;
      }

      if (!exited && child.pid) {
        try {
          if (process.platform !== 'win32') {
            process.kill(-child.pid, 'SIGTERM');
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          // ignore
        }

        const deadline = Date.now() + 3000;
        while (!exited && Date.now() < deadline) {
          await sleep(100);
        }

        if (!exited) {
          try {
            if (process.platform !== 'win32') {
              process.kill(-child.pid, 'SIGKILL');
            } else {
              spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
            }
          } catch {
            // ignore
          }
          await sleep(150);
        }
      }

      if (process.env.KEEP_E2E_TMP !== '1') {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };

  activeApps.add(app);

  // Readiness gate: HTTP /api/health + CDP /json/version
  const readyTimeoutMs = options.readyTimeoutMs ?? 20000;
  const deadline = Date.now() + readyTimeoutMs;
  let healthOk = false;
  let cdpOk = false;

  while (Date.now() < deadline) {
    if (exited) {
      const logs = app.getLogs();
      await app.stop();
      throw new Error(
        `Cr-PDF exited prematurely before ready (code=${exitCode}, signal=${exitSignal}).\nLogs:\n${logs}`,
      );
    }
    if (!healthOk) {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const data = await res.json();
          if (data?.status === 'ok') healthOk = true;
        }
      } catch {
        // retry
      }
    }
    if (!cdpOk) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.webSocketDebuggerUrl) cdpOk = true;
        }
      } catch {
        // retry
      }
    }
    if (healthOk && cdpOk) break;
    await sleep(150);
  }

  if (!healthOk || !cdpOk) {
    const logs = app.getLogs();
    await app.stop();
    throw new Error(
      `Cr-PDF failed to become ready within ${readyTimeoutMs}ms (healthOk=${healthOk}, cdpOk=${cdpOk}).\nLogs:\n${logs}`,
    );
  }

  if (options.connectCdp !== false) {
    app.cdp = await connectCdp(cdpPort, { timeoutMs: 10000 });
  }

  return app;
}

/**
 * Creates a full loopback HTTP API client for PROJECT.md § Interface Contracts.
 * Never throws on 4xx/5xx so boundary tests can assert exact status codes.
 */
export function createApiClient(baseUrl) {
  async function rawFetch(urlPath, init = {}) {
    const url = urlPath.startsWith('http://') || urlPath.startsWith('https://')
      ? urlPath
      : `${baseUrl}${urlPath}`;
    const res = await fetch(url, {
      signal: init.signal || AbortSignal.timeout(init.timeoutMs ?? 10000),
      ...init,
    });
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const contentType = res.headers.get('content-type') || '';
    const text = contentType.includes('application/pdf') ? '' : buffer.toString('utf8');
    let json = null;
    if (text && (contentType.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('['))) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      buffer,
      text,
      json,
    };
  }

  return {
    baseUrl,
    rawFetch,
    health() {
      return rawFetch('/api/health');
    },
    getConfig() {
      return rawFetch('/api/config');
    },
    updateConfig(patch) {
      return rawFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof patch === 'string' ? patch : JSON.stringify(patch),
      });
    },
    listNotebooks() {
      return rawFetch('/api/notebooks');
    },
    createNotebook(payload) {
      return rawFetch('/api/notebooks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    },
    importNotebook(name, buf, contentType = 'application/pdf') {
      return rawFetch(`/api/notebooks/import?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: buf,
      });
    },
    deleteNotebook(name) {
      return rawFetch(`/api/notebooks/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },
    addPage(name, opts = {}) {
      return rawFetch(`/api/notebooks/${encodeURIComponent(name)}/add-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
    },
    getPdf(name) {
      return rawFetch(`/pdf/${encodeURIComponent(name)}`);
    },
    savePdf(name, buf, contentType = 'application/pdf') {
      return rawFetch(`/api/save?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: buf,
      });
    },
    getRootHtml() {
      return rawFetch('/');
    },
    getStatic(file) {
      return rawFetch(`/static/${file}`);
    },
  };
}

/**
 * Generates a byte-accurate minimal valid PDF 1.4 Buffer with exact xref table.
 */
export function createMinimalPdf({ pages = 1, widthPt = 595, heightPt = 842, label = 'Cr-PDF E2E' } = {}) {
  const numPages = Math.max(1, Math.floor(pages));
  const safeLabel = String(label).replace(/[()\\]/g, '');

  // Object layout:
  // 1: Catalog
  // 2: Pages
  // 3: Font (/Helvetica)
  // For page i (0-indexed):
  //   pageObj = 4 + i * 2
  //   contentObj = 5 + i * 2
  const objects = [];
  const pageIds = [];
  for (let i = 0; i < numPages; i++) {
    pageIds.push(4 + i * 2);
  }

  objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${numPages} >>`,
  });
  objects.push({
    id: 3,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  });

  const wStr = Number(widthPt).toFixed(2).replace(/\.00$/, '');
  const hStr = Number(heightPt).toFixed(2).replace(/\.00$/, '');

  for (let i = 0; i < numPages; i++) {
    const pageObjId = 4 + i * 2;
    const contentObjId = 5 + i * 2;
    const streamData = `BT /F1 18 Tf 72 ${Math.max(40, Math.round(heightPt - 80))} Td (${safeLabel} Page ${i + 1}) Tj ET\n`;
    const streamLen = Buffer.byteLength(streamData, 'latin1');

    objects.push({
      id: pageObjId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wStr} ${hStr}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    });
    objects.push({
      id: contentObjId,
      body: `<< /Length ${streamLen} >>\nstream\n${streamData}endstream`,
    });
  }

  const chunks = [];
  let offset = 0;
  const pushStr = (s) => {
    const b = Buffer.from(s, 'latin1');
    chunks.push(b);
    offset += b.length;
  };

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const offsets = new Map();
  for (const obj of objects) {
    offsets.set(obj.id, offset);
    pushStr(`${obj.id} 0 obj\n${obj.body}\nendobj\n`);
  }

  const xrefOffset = offset;
  const totalObjs = objects.length + 1;
  pushStr(`xref\n0 ${totalObjs}\n`);
  pushStr('0000000000 65535 f \n');
  for (let id = 1; id <= objects.length; id++) {
    const offStr = String(offsets.get(id)).padStart(10, '0');
    pushStr(`${offStr} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * Inspects a PDF buffer (including incremental-update PDFs with multiple %%EOF revisions).
 */
export function inspectPdfBuffer(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const raw = buffer.toString('latin1');
  const trimmed = raw.trimEnd();

  const validHeader = raw.startsWith('%PDF-');
  const validEof = trimmed.endsWith('%%EOF');
  const eofMatches = raw.match(/%%EOF/g);
  const eofCount = eofMatches ? eofMatches.length : 0;

  // Incremental-update-aware page count: prefer the LAST /Type /Pages ... /Count N
  let pagesCount = 0;
  const pagesDictRegex = /\/Type\s*\/Pages\b[\s\S]{0,1200}?\/Count\s+(\d+)/g;
  let m;
  while ((m = pagesDictRegex.exec(raw)) !== null) {
    pagesCount = Number.parseInt(m[1], 10);
  }

  if (pagesCount === 0) {
    // Fallback: count unique object numbers containing /Type /Page (not /Pages)
    const uniquePageObjs = new Set();
    const objRegex = /(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g;
    let om;
    while ((om = objRegex.exec(raw)) !== null) {
      if (/\/Type\s*\/Page\b(?!s)/.test(om[2])) {
        uniquePageObjs.add(om[1]);
      }
    }
    pagesCount = uniquePageObjs.size;
  }

  const mediaBoxes = [];
  const mbRegex = /\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/g;
  let mb;
  while ((mb = mbRegex.exec(raw)) !== null) {
    const x0 = Number.parseFloat(mb[1]);
    const y0 = Number.parseFloat(mb[2]);
    const x1 = Number.parseFloat(mb[3]);
    const y1 = Number.parseFloat(mb[4]);
    const widthPt = Math.abs(x1 - x0);
    const heightPt = Math.abs(y1 - y0);
    mediaBoxes.push({
      x0,
      y0,
      x1,
      y1,
      widthPt,
      heightPt,
      widthMm: widthPt / MM_TO_PT,
      heightMm: heightPt / MM_TO_PT,
    });
  }

  const hasAnnotations =
    /\/Annots\b/.test(raw) || /\/Subtype\s*\/Ink\b/.test(raw) || /\/AP\s*<</.test(raw);

  return {
    byteLength: buffer.length,
    validHeader,
    validEof,
    eofCount,
    pagesCount,
    mediaBoxes,
    hasAnnotations,
  };
}

// ---- Synthetic Chromium DataPack v5 (.pak) Builder & Parser ----

function encodeUInt48LE(value) {
  const buf = Buffer.alloc(6);
  let v = BigInt(value);
  for (let i = 0; i < 6; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function decodeUInt48LE(buf, offset) {
  let v = 0n;
  for (let i = 5; i >= 0; i--) {
    v = (v << 8n) | BigInt(buf[offset + i]);
  }
  return Number(v);
}

/**
 * Builds a valid Chromium DataPack v5 binary buffer.
 * entries: [{ id: number, data: Buffer|string, compression?: 'none'|'gzip'|'brotli' }]
 * aliases: [{ id: number, targetId?: number, entryIndex?: number }]
 */
export function createSyntheticPakV5(entries, { aliases = [], encoding = 1 } = {}) {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const encodedBlobs = sorted.map((entry) => {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const comp = entry.compression || 'none';
    if (comp === 'none') return raw;
    if (comp === 'gzip') return zlib.gzipSync(raw);
    if (comp === 'brotli') {
      const compressed = zlib.brotliCompressSync(raw);
      return Buffer.concat([Buffer.from([0x1e, 0x9b]), encodeUInt48LE(raw.length), compressed]);
    }
    throw new Error(`Unsupported synthetic pak compression: ${comp}`);
  });

  const resolvedAliases = aliases.map((a) => {
    let entryIndex = a.entryIndex;
    if (entryIndex === undefined && a.targetId !== undefined) {
      entryIndex = sorted.findIndex((e) => e.id === a.targetId);
      if (entryIndex < 0) throw new Error(`Alias targetId ${a.targetId} not found in entries`);
    }
    return { id: a.id, entryIndex };
  });

  const resourceCount = sorted.length;
  const aliasCount = resolvedAliases.length;
  // DataPack v5 header: uint32 version (5), uint8 encoding, 3x pad, uint16 resourceCount, uint16 aliasCount = 12 bytes
  const headerSize = 12;
  const resourceTableSize = (resourceCount + 1) * 6; // +1 sentinel
  const aliasTableSize = aliasCount * 4;
  let dataOffset = headerSize + resourceTableSize + aliasTableSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(5, 0);
  header.writeUInt8(encoding, 4);
  header.writeUInt16LE(resourceCount, 8);
  header.writeUInt16LE(aliasCount, 10);

  const resourceTable = Buffer.alloc(resourceTableSize);
  for (let i = 0; i < resourceCount; i++) {
    resourceTable.writeUInt16LE(sorted[i].id, i * 6);
    resourceTable.writeUInt32LE(dataOffset, i * 6 + 2);
    dataOffset += encodedBlobs[i].length;
  }
  // Sentinel entry (id = 0, offset = total file size)
  resourceTable.writeUInt16LE(0, resourceCount * 6);
  resourceTable.writeUInt32LE(dataOffset, resourceCount * 6 + 2);

  const aliasTable = Buffer.alloc(aliasTableSize);
  for (let i = 0; i < aliasCount; i++) {
    aliasTable.writeUInt16LE(resolvedAliases[i].id, i * 4);
    aliasTable.writeUInt16LE(resolvedAliases[i].entryIndex, i * 4 + 2);
  }

  return Buffer.concat([header, resourceTable, aliasTable, ...encodedBlobs]);
}

/**
 * Parses a Chromium DataPack v5 buffer and decompresses raw, gzip, and Chromium-Brotli entries.
 */
export function parsePakV5(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (buffer.length < 12) {
    throw new Error(`DataPack too short (${buffer.length} bytes)`);
  }
  const version = buffer.readUInt32LE(0);
  if (version !== 5) {
    throw new Error(`Unsupported DataPack version: ${version}`);
  }
  const encoding = buffer.readUInt8(4);
  const resourceCount = buffer.readUInt16LE(8);
  const aliasCount = buffer.readUInt16LE(10);

  const resourceTableOffset = 12;
  const sentinelIndex = resourceCount;
  const aliasTableOffset = resourceTableOffset + (resourceCount + 1) * 6;
  if (aliasTableOffset + aliasCount * 4 > buffer.length) {
    throw new Error('DataPack table exceeds file length');
  }

  const rawEntries = [];
  for (let i = 0; i < resourceCount; i++) {
    const pos = resourceTableOffset + i * 6;
    const id = buffer.readUInt16LE(pos);
    const offset = buffer.readUInt32LE(pos + 2);
    const nextOffset = buffer.readUInt32LE(pos + 6 + 2);
    rawEntries.push({ id, offset, nextOffset });
  }

  const sentinelId = buffer.readUInt16LE(resourceTableOffset + sentinelIndex * 6);
  const sentinelOffset = buffer.readUInt32LE(resourceTableOffset + sentinelIndex * 6 + 2);

  const aliases = [];
  for (let i = 0; i < aliasCount; i++) {
    const pos = aliasTableOffset + i * 4;
    aliases.push({
      id: buffer.readUInt16LE(pos),
      entryIndex: buffer.readUInt16LE(pos + 2),
    });
  }

  const entries = rawEntries.map(({ id, offset, nextOffset }) => {
    const rawPayload = buffer.subarray(offset, nextOffset);
    let compression = 'none';
    let data = rawPayload;
    let declaredSize = rawPayload.length;

    if (rawPayload.length >= 2 && rawPayload[0] === 0x1f && rawPayload[1] === 0x8b) {
      compression = 'gzip';
      data = zlib.gunzipSync(rawPayload);
      declaredSize = data.length;
    } else if (rawPayload.length >= 8 && rawPayload[0] === 0x1e && rawPayload[1] === 0x9b) {
      compression = 'brotli';
      declaredSize = decodeUInt48LE(rawPayload, 2);
      data = zlib.brotliDecompressSync(rawPayload.subarray(8));
    }

    return {
      id,
      offset,
      length: rawPayload.length,
      compression,
      declaredSize,
      rawPayload,
      data,
    };
  });

  return {
    version,
    encoding,
    resourceCount,
    aliasCount,
    sentinelId,
    sentinelOffset,
    fileSize: buffer.length,
    aliases,
    entries,
  };
}
