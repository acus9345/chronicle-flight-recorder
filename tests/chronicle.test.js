/**
 * Chronicle Automated Integration & Unit Test Suite (`tests/chronicle.test.js`)
 * Verifies:
 * 1. Deterministic SHA-256 request fingerprinting across reordered JSON keys & volatile query params
 * 2. Header and nested JSON body secret/PII scrubbing
 * 3. Recursive JSON AST structural diffing & cassette drift classification
 * 4. End-to-end Live HTTP Recorder Proxy -> Cassette capture -> Deterministic Replay Server
 * 5. Chaos Fault Injection override in ReplayMockServer
 * 6. Codegen output for cURL, Fetch, and Playwright assertions
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FlightCassette,
  computeRequestFingerprint,
  scrubHeaders,
  scrubBodyPayload
} from '../src/core/cassette.js';
import { diffJsonPayloads, compareCassettes } from '../src/core/diff-engine.js';
import {
  generateCurlCommand,
  generateFetchSnippet,
  generatePlaywrightTest
} from '../src/core/codegen.js';
import { RecorderProxyServer } from '../src/proxy/recorder-proxy.js';
import { ReplayMockServer } from '../src/proxy/replay-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTests() {
  let passed = 0;

  // Test 1: Deterministic Request Fingerprinting
  {
    const fp1 = computeRequestFingerprint({
      method: 'post',
      url: '/v2/orders?currency=SGD&include_tax=true&_t=1700001',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ b: 2, a: 1, nested: { y: true, x: false } })
    });
    const fp2 = computeRequestFingerprint({
      method: 'POST',
      url: '/v2/orders?include_tax=true&currency=SGD&timestamp=9999999',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nested: { x: false, y: true }, a: 1, b: 2 })
    });
    assert.equal(fp1, fp2, 'Fingerprints must match across key reordering and volatile query params');
    passed++;
    console.log('✓ [1/6] Deterministic request fingerprinting verified');
  }

  // Test 2: Secret & PII Scrubbing
  {
    const cleanedHeaders = scrubHeaders({
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret', // ship:allow-secret (fake test value)
      'X-Api-Key': 'sk_live_9988776655', // ship:allow-secret (fake test value)
      'Content-Type': 'application/json'
    });
    assert.match(cleanedHeaders.Authorization, /^Bearer \[REDACTED:eyJh…len=43\]$/);
    assert.equal(cleanedHeaders['X-Api-Key'], '[REDACTED:len=18]');
    assert.equal(cleanedHeaders['Content-Type'], 'application/json');

    const cleanedBody = JSON.parse(
      scrubBodyPayload(JSON.stringify({ user: 'alice', password: 'super-secret-password', nested: { client_secret: 'xyz123' } }))
    );
    assert.equal(cleanedBody.user, 'alice');
    assert.equal(cleanedBody.password, '[REDACTED:len=21]');
    assert.equal(cleanedBody.nested.client_secret, '[REDACTED:len=6]');
    passed++;
    console.log('✓ [2/6] Header & nested JSON PII/token redaction verified');
  }

  // Test 3: Structural JSON Diff & Cassette Drift Comparison
  {
    const diff = diffJsonPayloads(
      JSON.stringify({ status: 'OK', expires: 100, fee_breakdown: { net: 90 } }),
      JSON.stringify({ status: 'OK', expires: '100', fee_BreakDown: null, warning: 'POOL_HIGH' })
    );
    assert.equal(diff.isJson, true);
    const kinds = Object.fromEntries(diff.changes.map((c) => [c.path, c.kind]));
    assert.equal(kinds['$.expires'], 'type_changed');
    assert.equal(kinds['$.fee_breakdown'], 'removed');
    assert.equal(kinds['$.fee_BreakDown'], 'added');
    assert.equal(kinds['$.warning'], 'added');

    const baseRaw = fs.readFileSync(path.resolve(__dirname, '../traces/baseline-checkout-healthy.chronicle.json'), 'utf8');
    const incRaw = fs.readFileSync(path.resolve(__dirname, '../traces/incident-checkout-timeout.chronicle.json'), 'utf8');
    const report = compareCassettes(FlightCassette.fromJSON(baseRaw), FlightCassette.fromJSON(incRaw));
    assert.equal(report.pairedCount, 5);
    assert.ok(report.breakingCount >= 2, 'Should flag 504 timeout and schema type drift as breaking');
    passed++;
    console.log('✓ [3/6] Recursive JSON AST diff & cassette drift analyzer verified');
  }

  // Test 4: Live HTTP Recorder Proxy -> Cassette -> Deterministic Replay Server
  {
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'real' });
        res.end(JSON.stringify({ echoedPath: req.url, received: body ? JSON.parse(body) : null }));
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const proxy = new RecorderProxyServer({
      targetUrl: `http://127.0.0.1:${upstreamPort}`,
      listenPort: 0,
      title: 'Integration Test Capture'
    });
    const { port: proxyPort } = await proxy.start();

    // Send request through Recorder Proxy
    const proxyRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/items?sort=asc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret_token_12345'
      },
      body: JSON.stringify({ sku: 'CHRON-01', qty: 3 })
    });
    assert.equal(proxyRes.status, 201);
    const proxyData = await proxyRes.json();
    assert.equal(proxyData.echoedPath, '/v1/items?sort=asc');

    // Shut down upstream so only ReplayMockServer can answer
    await new Promise((r) => upstream.close(r));
    await proxy.stop();

    assert.equal(proxy.cassette.frames.length, 1);
    assert.match(proxy.cassette.frames[0].request.headers.authorization, /REDACTED/);

    // Start Replay Server from captured cassette
    const replay = new ReplayMockServer(proxy.cassette, { listenPort: 0 });
    const { port: replayPort } = await replay.start();

    // Send request with reordered JSON keys to verify deterministic fingerprint matching
    const replayRes = await fetch(`http://127.0.0.1:${replayPort}/v1/items?sort=asc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 3, sku: 'CHRON-01' })
    });
    assert.equal(replayRes.status, 201);
    assert.equal(replayRes.headers.get('x-chronicle-replay'), 'exact-fingerprint');
    const replayBody = await replayRes.json();
    assert.deepEqual(replayBody, proxyData);

    await replay.stop();
    passed++;
    console.log('✓ [4/6] End-to-end Live Recorder Proxy & Deterministic Replay Server verified');
  }

  // Test 5: Chaos Fault Injection in Replay Server
  {
    const cassette = new FlightCassette({ title: 'Chaos Test' });
    const replay = new ReplayMockServer(cassette, {
      listenPort: 0,
      faultRules: [
        { name: 'gateway-timeout-sim', method: 'POST', pathPrefix: '/v2/payments', status: 504, delayMs: 5 }
      ]
    });
    const { port } = await replay.start();
    const res = await fetch(`http://127.0.0.1:${port}/v2/payments/charge`, { method: 'POST' });
    assert.equal(res.status, 504);
    assert.equal(res.headers.get('x-chronicle-replay'), 'fault-injected');
    await replay.stop();
    passed++;
    console.log('✓ [5/6] Chaos fault injection rule engine verified');
  }

  // Test 6: Codegen Synthesizer
  {
    const sampleFrame = {
      id: 'frm_0001',
      method: 'POST',
      path: '/v2/checkout',
      host: 'https://api.example.com',
      status: 200,
      request: {
        headers: { 'content-type': 'application/json' },
        body: '{"amount":100}'
      },
      response: {
        headers: {},
        body: '{"order_id":"ord_1","ok":true}'
      }
    };
    const curl = generateCurlCommand(sampleFrame);
    const fetchCode = generateFetchSnippet(sampleFrame);
    const pwCode = generatePlaywrightTest(sampleFrame);
    assert.ok(curl.includes("curl -i -X POST 'https://api.example.com/v2/checkout'"));
    assert.ok(fetchCode.includes('await fetch("https://api.example.com/v2/checkout"'));
    assert.ok(pwCode.includes("expect(body).toHaveProperty(\"order_id\")"));
    passed++;
    console.log('✓ [6/6] Codegen synthesizer (cURL, Fetch, Playwright) verified');
  }

  console.log(`\nALL ${passed}/6 CHRONICLE TEST SUITES PASSED.`);
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
