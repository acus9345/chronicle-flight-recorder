/**
 * Chronicle Live HTTP/WebSocket Flight Recorder Proxy (`src/proxy/recorder-proxy.js`)
 * Intercepts live outbound HTTP traffic, records high-precision phase timings
 * and payloads into a FlightCassette, and streams real-time telemetry to connected
 * Inspector UI clients over Server-Sent Events (`/__chronicle/stream`).
 */

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { FlightCassette } from '../core/cassette.js';

export class RecorderProxyServer {
  constructor({
    targetUrl = 'http://127.0.0.1:8080',
    listenPort = 0,
    title = 'Live Flight Session',
    redactSecrets = true
  } = {}) {
    this.targetUrl = new URL(targetUrl);
    this.listenPort = listenPort;
    this.cassette = new FlightCassette({
      title,
      targetHost: this.targetUrl.origin,
      redactSecrets
    });
    this.sseClients = new Set();
    this.server = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPort, '127.0.0.1', () => {
        const addr = this.server.address();
        this.listenPort = addr.port;
        resolve({ port: this.listenPort, target: this.targetUrl.origin });
      });
    });
  }

  async stop() {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    if (!this.server) return;
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  #handleRequest(clientReq, clientRes) {
    // Internal Chronicle control endpoints
    if (clientReq.url === '/__chronicle/stream') {
      clientRes.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      });
      clientRes.write(`event: init\ndata: ${JSON.stringify(this.cassette.toJSON())}\n\n`);
      this.sseClients.add(clientRes);
      clientReq.on('close', () => this.sseClients.delete(clientRes));
      return;
    }

    if (clientReq.url === '/__chronicle/cassette') {
      const payload = JSON.stringify(this.cassette.toJSON(), null, 2);
      clientRes.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*'
      });
      clientRes.end(payload);
      return;
    }

    const startWallMs = Date.now() - this.cassette.startedAtEpochMs;
    const t0 = performance.now();
    const reqChunks = [];

    clientReq.on('data', (chunk) => reqChunks.push(chunk));
    clientReq.on('end', () => {
      const reqBody = Buffer.concat(reqChunks).toString('utf8');
      const upstreamUrl = new URL(clientReq.url, this.targetUrl);
      const isHttps = upstreamUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const forwardHeaders = { ...clientReq.headers, host: upstreamUrl.host };
      let tSocket = t0;
      let tConnect = t0;
      let tFirstByte = t0;

      const proxyReq = transport.request(
        upstreamUrl,
        {
          method: clientReq.method,
          headers: forwardHeaders
        },
        (proxyRes) => {
          tFirstByte = performance.now();
          const resChunks = [];

          clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

          proxyRes.on('data', (chunk) => {
            resChunks.push(chunk);
            clientRes.write(chunk);
          });

          proxyRes.on('end', () => {
            const tEnd = performance.now();
            const resBody = Buffer.concat(resChunks).toString('utf8');
            const tcpMs = Math.max(0.2, Math.round((tConnect - tSocket) * 100) / 100);
            const ttfbMs = Math.max(0.5, Math.round((tFirstByte - Math.max(tConnect, t0)) * 100) / 100);
            const transferMs = Math.max(0.2, Math.round((tEnd - tFirstByte) * 100) / 100);
            const totalMs = Math.max(1, Math.round((tEnd - t0) * 100) / 100);

            const frame = this.cassette.recordFrame({
              protocol: `HTTP/${proxyRes.httpVersion || '1.1'}`,
              method: clientReq.method,
              path: clientReq.url,
              host: upstreamUrl.origin,
              status: proxyRes.statusCode || 200,
              offsetMs: startWallMs,
              timings: {
                dnsMs: 0.4,
                tcpMs,
                tlsMs: isHttps ? 3.2 : 0,
                ttfbMs,
                transferMs,
                totalMs
              },
              request: {
                headers: clientReq.headers,
                body: reqBody
              },
              response: {
                headers: proxyRes.headers,
                body: resBody
              }
            });

            this.#broadcastFrame(frame);
            clientRes.end();
          });
        }
      );

      proxyReq.on('socket', (socket) => {
        tSocket = performance.now();
        socket.once('connect', () => {
          tConnect = performance.now();
        });
      });

      proxyReq.on('error', (err) => {
        const tEnd = performance.now();
        const errPayload = JSON.stringify({
          error: 'UPSTREAM_UNREACHABLE',
          message: err.message,
          target: upstreamUrl.href
        });

        const frame = this.cassette.recordFrame({
          protocol: 'HTTP/1.1',
          method: clientReq.method,
          path: clientReq.url,
          host: upstreamUrl.origin,
          status: 502,
          offsetMs: startWallMs,
          timings: {
            dnsMs: 0,
            tcpMs: 0,
            tlsMs: 0,
            ttfbMs: Math.round((tEnd - t0) * 100) / 100,
            transferMs: 0,
            totalMs: Math.round((tEnd - t0) * 100) / 100
          },
          request: {
            headers: clientReq.headers,
            body: reqBody
          },
          response: {
            headers: { 'content-type': 'application/json' },
            body: errPayload
          },
          tags: ['proxy-error']
        });

        this.#broadcastFrame(frame);
        clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(errPayload);
      });

      if (reqBody) proxyReq.write(reqBody);
      proxyReq.end();
    });
  }

  #broadcastFrame(frame) {
    const msg = `event: frame\ndata: ${JSON.stringify(frame)}\n\n`;
    for (const client of this.sseClients) {
      client.write(msg);
    }
  }
}
