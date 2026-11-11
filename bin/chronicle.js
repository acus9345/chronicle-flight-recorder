#!/usr/bin/env node
/**
 * Chronicle CLI (`bin/chronicle.js`)
 * Commands:
 *   chronicle record --target <url> --port <port> --out <file.chronicle.json>
 *   chronicle replay --trace <file.chronicle.json> --port <port> [--simulate-latency]
 *   chronicle diff <base.chronicle.json> <candidate.chronicle.json>
 *   chronicle inspect [<trace.chronicle.json>] --port <port>
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { FlightCassette } from '../src/core/cassette.js';
import { compareCassettes } from '../src/core/diff-engine.js';
import { RecorderProxyServer } from '../src/proxy/recorder-proxy.js';
import { ReplayMockServer } from '../src/proxy/replay-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] || 'help', args: positional.slice(1), flags };
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  if (command === 'help' || flags.help) {
    printHelp();
    return;
  }

  if (command === 'record') {
    const targetUrl = flags.target || 'http://127.0.0.1:8080';
    const listenPort = Number(flags.port || 4900);
    const outPath = flags.out || './flight-capture.chronicle.json';

    const proxy = new RecorderProxyServer({
      targetUrl,
      listenPort,
      title: flags.title || `Capture -> ${targetUrl}`
    });
    const info = await proxy.start();
    console.log(`[CHRONICLE REC] Listening on http://127.0.0.1:${info.port} -> forwarding to ${info.target}`);
    console.log(`[CHRONICLE REC] Live SSE stream: http://127.0.0.1:${info.port}/__chronicle/stream`);
    console.log(`[CHRONICLE REC] Press Ctrl+C to flush cassette to ${outPath}`);

    const flushAndExit = async () => {
      fs.writeFileSync(outPath, JSON.stringify(proxy.cassette.toJSON(), null, 2));
      console.log(`\n[CHRONICLE REC] Saved ${proxy.cassette.frames.length} frames to ${outPath}`);
      await proxy.stop();
      process.exit(0);
    };
    process.on('SIGINT', flushAndExit);
    process.on('SIGTERM', flushAndExit);
    return;
  }

  if (command === 'replay') {
    const traceFile = flags.trace || args[0];
    if (!traceFile || !fs.existsSync(traceFile)) {
      console.error('[CHRONICLE ERR] Provide a valid cassette file via --trace <file.chronicle.json>');
      process.exit(1);
    }
    const cassette = FlightCassette.fromJSON(fs.readFileSync(traceFile, 'utf8'));
    const port = Number(flags.port || 4901);
    const replay = new ReplayMockServer(cassette, {
      listenPort: port,
      simulateLatency: Boolean(flags['simulate-latency'])
    });
    const info = await replay.start();
    console.log(`[CHRONICLE REPLAY] Loaded "${cassette.title}" (${cassette.frames.length} frames)`);
    console.log(`[CHRONICLE REPLAY] Deterministic replay server ready at http://127.0.0.1:${info.port}`);
    return;
  }

  if (command === 'diff') {
    const [baseFile, candFile] = args;
    if (!baseFile || !candFile) {
      console.error('Usage: chronicle diff <baseline.chronicle.json> <candidate.chronicle.json>');
      process.exit(1);
    }
    const baseCassette = FlightCassette.fromJSON(fs.readFileSync(baseFile, 'utf8'));
    const candCassette = FlightCassette.fromJSON(fs.readFileSync(candFile, 'utf8'));
    const diff = compareCassettes(baseCassette, candCassette);

    console.log(`=== CHRONICLE DRIFT REPORT ===`);
    console.log(`Baseline : ${diff.baseTitle} (${baseCassette.frames.length} frames)`);
    console.log(`Candidate: ${diff.candidateTitle} (${candCassette.frames.length} frames)`);
    console.log(`Paired   : ${diff.pairedCount} | Breaking: ${diff.breakingCount} | Drift: ${diff.driftCount}`);
    for (const r of diff.reports) {
      const badge = r.severity.toUpperCase().padEnd(8);
      const latSign = r.latency.deltaMs >= 0 ? `+${r.latency.deltaMs}ms` : `${r.latency.deltaMs}ms`;
      console.log(`  [${badge}] ${r.method.padEnd(6)} ${r.path.padEnd(34)} status: ${r.status.before}->${r.status.after} | latency: ${latSign} | body diffs: ${r.responseDiff.changes.length}`);
    }
    if (diff.breakingCount > 0 && flags.strict) {
      process.exit(2);
    }
    return;
  }

  if (command === 'inspect') {
    const port = Number(flags.port || 4800);
    const uiDir = path.resolve(__dirname, '../src/ui');
    const server = http.createServer((req, res) => {
      const cleanPath = req.url.split('?')[0];
      const rel = cleanPath === '/' ? 'index.html' : cleanPath.slice(1);
      const filePath = path.join(uiDir, rel);
      if (!filePath.startsWith(uiDir) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'content-type': `${mime}; charset=utf-8` });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[CHRONICLE UI] Dense Utilitarian Inspector running at http://127.0.0.1:${port}`);
    });
  }
}

function printHelp() {
  console.log(`Chronicle v1.0.0 — Local-First API Flight Recorder & Drift Inspector

Usage:
  chronicle record  --target <url> --port <port> --out <cassette.json>
  chronicle replay  --trace <cassette.json> --port <port> [--simulate-latency]
  chronicle diff    <base.chronicle.json> <candidate.chronicle.json> [--strict]
  chronicle inspect --port <port>
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
