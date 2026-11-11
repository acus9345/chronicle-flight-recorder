/**
 * Chronicle Deterministic Flight Replay & Chaos Mock Server (`src/proxy/replay-server.js`)
 * Serves recorded HTTP responses from a `.chronicle.json` FlightCassette by matching
 * incoming request fingerprints or method+path fallback, with optional latency simulation
 * and chaos fault injection rules.
 */

import http from 'node:http';
import { computeRequestFingerprint } from '../core/cassette.js';

export class ReplayMockServer {
  constructor(cassette, {
    listenPort = 0,
    simulateLatency = false,
    speedMultiplier = 1.0,
    faultRules = []
  } = {}) {
    this.cassette = cassette;
    this.listenPort = listenPort;
    this.simulateLatency = simulateLatency;
    this.speedMultiplier = Math.max(0.1, Number(speedMultiplier) || 1.0);
    this.faultRules = Array.isArray(faultRules) ? faultRules : [];
    this.server = null;
    this.replayLog = [];
    this.cursorByFingerprint = new Map();
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handleReplay(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPort, '127.0.0.1', () => {
        const addr = this.server.address();
        this.listenPort = addr.port;
        resolve({ port: this.listenPort });
      });
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  #handleReplay(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const fp = computeRequestFingerprint({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });

      // Check fault injection overrides first
      const fault = this.faultRules.find(
        (r) => (!r.method || r.method === req.method) && req.url.startsWith(r.pathPrefix || '/')
      );
      if (fault) {
        if (fault.delayMs > 0) {
          await new Promise((r) => setTimeout(r, fault.delayMs));
        }
        const status = fault.status || 503;
        const payload = typeof fault.body === 'string'
          ? fault.body
          : JSON.stringify(fault.body || { error: 'CHAOS_FAULT_INJECTED', rule: fault.name || 'unnamed' });
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-chronicle-replay': 'fault-injected'
        });
        res.end(payload);
        this.replayLog.push({ method: req.method, url: req.url, matched: 'fault', status });
        return;
      }

      // Match by exact fingerprint first, then fallback to method + path
      const exactCandidates = this.cassette.frames.filter((f) => f.fingerprint === fp);
      let matchedFrame = null;
      let matchMode = 'exact-fingerprint';

      if (exactCandidates.length > 0) {
        const usedCount = this.cursorByFingerprint.get(fp) || 0;
        matchedFrame = exactCandidates[Math.min(usedCount, exactCandidates.length - 1)];
        this.cursorByFingerprint.set(fp, usedCount + 1);
      } else {
        matchedFrame = this.cassette.frames.find(
          (f) => f.method === req.method.toUpperCase() && f.path === req.url
        );
        matchMode = matchedFrame ? 'method-path-fallback' : 'miss';
      }

      if (!matchedFrame) {
        const missBody = JSON.stringify({
          error: 'CHRONICLE_CASSETTE_MISS',
          method: req.method,
          path: req.url,
          fingerprint: fp,
          hint: 'No matching frame recorded in active flight cassette'
        });
        res.writeHead(404, {
          'content-type': 'application/json',
          'x-chronicle-replay': 'miss',
          'x-chronicle-fingerprint': fp
        });
        res.end(missBody);
        this.replayLog.push({ method: req.method, url: req.url, matched: null, status: 404 });
        return;
      }

      if (this.simulateLatency && matchedFrame.durationMs > 0) {
        const delay = Math.round(matchedFrame.durationMs / this.speedMultiplier);
        await new Promise((r) => setTimeout(r, Math.min(delay, 2000)));
      }

      const headers = {
        ...matchedFrame.response?.headers,
        'x-chronicle-replay': matchMode,
        'x-chronicle-frame-id': matchedFrame.id,
        'x-chronicle-fingerprint': matchedFrame.fingerprint
      };
      delete headers['content-length'];
      delete headers['transfer-encoding'];

      res.writeHead(matchedFrame.status, headers);
      res.end(matchedFrame.response?.body || '');

      this.replayLog.push({
        method: req.method,
        url: req.url,
        matched: matchedFrame.id,
        matchMode,
        status: matchedFrame.status
      });
    });
  }
}
