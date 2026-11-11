/**
 * Chronicle Core — Flight Cassette Engine (`src/core/cassette.js`)
 * Handles deterministic request fingerprinting, sensitive header/body scrubbing,
 * waterfall timing normalization, and `.chronicle.json` cassette serialization.
 */

import crypto from 'node:crypto';

export const CASSETTE_SCHEMA_VERSION = 'chronicle.v1';

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^proxy-authorization$/i,
  /^x-csrf-token$/i
];

const SENSITIVE_BODY_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'client_secret',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'card_number',
  'cvv',
  'private_key'
]);

/**
 * Computes a deterministic SHA-256 fingerprint for an HTTP or WebSocket request
 * so replayed requests can be matched accurately regardless of header ordering
 * or ephemeral timestamps.
 */
export function computeRequestFingerprint({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const parsed = new URL(url, 'http://localhost');
  const sortedParams = [...parsed.searchParams.entries()]
    .filter(([k]) => !['_t', 'timestamp', 'nonce', 'request_id'].includes(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  let canonicalBody = '';
  if (body && typeof body === 'string') {
    try {
      const parsedJson = JSON.parse(body);
      canonicalBody = canonicalizeJson(parsedJson);
    } catch {
      canonicalBody = body.trim();
    }
  } else if (body && typeof body === 'object') {
    canonicalBody = canonicalizeJson(body);
  }

  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').split(';')[0].trim().toLowerCase();
  const rawMaterial = `${method.toUpperCase()}|${parsed.pathname}|${sortedParams}|${contentType}|${canonicalBody}`;
  return crypto.createHash('sha256').update(rawMaterial).digest('hex').slice(0, 16);
}

/**
 * Recursively sorts object keys for stable hashing and structural comparison,
 * while ignoring volatile keys like request_id or trace_id if desired.
 */
export function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Scrubs sensitive credentials and tokens from headers while preserving
 * token type/prefix and length diagnostics for debugging.
 */
export function scrubHeaders(headers = {}, { redact = true } = {}) {
  if (!redact) return { ...headers };
  const out = {};
  for (const [key, val] of Object.entries(headers)) {
    const strVal = Array.isArray(val) ? val.join('; ') : String(val ?? '');
    const isSensitive = SENSITIVE_HEADER_PATTERNS.some((re) => re.test(key));
    if (isSensitive && strVal.length > 0) {
      if (/^Bearer\s+/i.test(strVal)) {
        const token = strVal.replace(/^Bearer\s+/i, '');
        out[key] = `Bearer [REDACTED:${token.slice(0, 4)}…len=${token.length}]`;
      } else {
        out[key] = `[REDACTED:len=${strVal.length}]`;
      }
    } else {
      out[key] = strVal;
    }
  }
  return out;
}

/**
 * Scrubs sensitive fields inside JSON string payloads.
 */
export function scrubBodyPayload(rawBody, { redact = true } = {}) {
  if (!redact || !rawBody || typeof rawBody !== 'string') return rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    const cleaned = scrubJsonNode(parsed);
    return JSON.stringify(cleaned);
  } catch {
    return rawBody;
  }
}

function scrubJsonNode(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(scrubJsonNode);
  const copy = {};
  for (const [k, v] of Object.entries(node)) {
    if (SENSITIVE_BODY_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
      copy[k] = `[REDACTED:len=${v.length}]`;
    } else {
      copy[k] = scrubJsonNode(v);
    }
  }
  return copy;
}

/**
 * FlightCassette manages an ordered sequence of captured HTTP/WebSocket frames,
 * metadata, bookmarks, and summary statistics.
 */
export class FlightCassette {
  constructor(meta = {}) {
    this.schema = CASSETTE_SCHEMA_VERSION;
    this.id = meta.id || `cassette_${crypto.randomBytes(4).toString('hex')}`;
    this.title = meta.title || 'Untitled Flight Capture';
    this.targetHost = meta.targetHost || 'http://localhost:8080';
    this.createdAt = meta.createdAt || new Date().toISOString();
    this.environment = meta.environment || 'local-dev';
    this.redactSecrets = meta.redactSecrets !== false;
    this.frames = Array.isArray(meta.frames) ? meta.frames : [];
    this.bookmarks = Array.isArray(meta.bookmarks) ? meta.bookmarks : [];
    this.startedAtEpochMs = meta.startedAtEpochMs || Date.now();
  }

  /**
   * Appends a captured HTTP or WebSocket frame to the cassette.
   */
  recordFrame(frameInput) {
    const seq = this.frames.length + 1;
    const offsetMs = typeof frameInput.offsetMs === 'number'
      ? Math.max(0, Math.round(frameInput.offsetMs * 100) / 100)
      : Math.max(0, Date.now() - this.startedAtEpochMs);

    const reqHeaders = scrubHeaders(frameInput.request?.headers || {}, { redact: this.redactSecrets });
    const reqBody = scrubBodyPayload(frameInput.request?.body || '', { redact: this.redactSecrets });
    const resHeaders = scrubHeaders(frameInput.response?.headers || {}, { redact: this.redactSecrets });
    const resBody = scrubBodyPayload(frameInput.response?.body || '', { redact: this.redactSecrets });

    const timings = normalizeTimings(frameInput.timings);
    const method = (frameInput.method || frameInput.request?.method || 'GET').toUpperCase();
    const path = frameInput.path || frameInput.request?.path || '/';

    const fingerprint = frameInput.fingerprint || computeRequestFingerprint({
      method,
      url: path,
      headers: frameInput.request?.headers || {},
      body: frameInput.request?.body || ''
    });

    const reqBytes = Buffer.byteLength(reqBody || '', 'utf8');
    const resBytes = Buffer.byteLength(resBody || '', 'utf8');

    const frame = {
      id: frameInput.id || `frm_${String(seq).padStart(4, '0')}`,
      seq,
      protocol: frameInput.protocol || 'HTTP/1.1',
      method,
      path,
      host: frameInput.host || this.targetHost,
      status: Number(frameInput.status ?? frameInput.response?.status ?? 200),
      offsetMs,
      durationMs: timings.totalMs,
      fingerprint,
      timings,
      request: {
        headers: reqHeaders,
        body: reqBody,
        sizeBytes: reqBytes
      },
      response: {
        headers: resHeaders,
        body: resBody,
        sizeBytes: resBytes
      },
      wsFrames: Array.isArray(frameInput.wsFrames) ? frameInput.wsFrames : [],
      tags: Array.isArray(frameInput.tags) ? frameInput.tags : []
    };

    this.frames.push(frame);
    return frame;
  }

  /**
   * Computes aggregate telemetry across all recorded frames.
   */
  getSummary() {
    const total = this.frames.length;
    if (total === 0) {
      return {
        totalFrames: 0,
        errorCount: 0,
        errorRatePct: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        totalBytes: 0,
        spanMs: 0
      };
    }

    const durations = this.frames.map((f) => f.durationMs).sort((a, b) => a - b);
    const errors = this.frames.filter((f) => f.status >= 400 || f.status === 0).length;
    const totalBytes = this.frames.reduce(
      (acc, f) => acc + (f.request?.sizeBytes || 0) + (f.response?.sizeBytes || 0),
      0
    );
    const endTimes = this.frames.map((f) => f.offsetMs + f.durationMs);
    const spanMs = Math.max(...endTimes, 0);

    const percentile = (arr, q) => {
      const idx = Math.min(arr.length - 1, Math.floor(q * arr.length));
      return Math.round(arr[idx] * 100) / 100;
    };

    return {
      totalFrames: total,
      errorCount: errors,
      errorRatePct: Math.round((errors / total) * 1000) / 10,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations[durations.length - 1],
      totalBytes,
      spanMs: Math.round(spanMs * 100) / 100
    };
  }

  toJSON() {
    return {
      schema: this.schema,
      id: this.id,
      title: this.title,
      targetHost: this.targetHost,
      createdAt: this.createdAt,
      environment: this.environment,
      summary: this.getSummary(),
      bookmarks: this.bookmarks,
      frames: this.frames
    };
  }

  static fromJSON(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid Chronicle cassette payload');
    }
    return new FlightCassette(data);
  }
}

function normalizeTimings(t = {}) {
  const dnsMs = Math.max(0, Number(t.dnsMs || 0));
  const tcpMs = Math.max(0, Number(t.tcpMs || 0));
  const tlsMs = Math.max(0, Number(t.tlsMs || 0));
  const ttfbMs = Math.max(0, Number(t.ttfbMs ?? t.waitMs ?? 12));
  const transferMs = Math.max(0, Number(t.transferMs ?? 4));
  const explicitTotal = Number(t.totalMs);
  const sum = Math.round((dnsMs + tcpMs + tlsMs + ttfbMs + transferMs) * 100) / 100;
  const totalMs = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : sum;
  return { dnsMs, tcpMs, tlsMs, ttfbMs, transferMs, totalMs };
}
