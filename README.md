# CHRONICLE // Local-First API Flight Recorder & Drift Inspector

**Chronicle** is a zero-dependency, local-first HTTP API flight recorder, deterministic replay mock server, and structural schema drift analyzer with a dense utilitarian dark UI inspired by hardware logic analyzers.

Instead of scattering ephemeral network logs across browser DevTools tabs or cloud SaaS dashboards, Chronicle captures live API traffic into portable, Git-friendly `.chronicle.json` **Flight Cassettes** with automatic secret/PII scrubbing, deterministic SHA-256 request fingerprinting, and frame-by-frame timeline scrubbing.

## Repository Architecture

```text
chronicle/
├── bin/
│   └── chronicle.js                # CLI entrypoint (record, replay, diff, inspect)
├── src/
│   ├── core/
│   │   ├── cassette.js             # FlightCassette engine, SHA-256 fingerprinting & PII scrubber
│   │   ├── diff-engine.js          # Recursive JSON AST schema/value drift & latency analyzer
│   │   └── codegen.js              # cURL, Node Fetch & Playwright test synthesizer
│   ├── proxy/
│   │   ├── recorder-proxy.js       # Live HTTP interceptor with perf_hooks phase timing & SSE stream
│   │   └── replay-server.js        # Deterministic fingerprint mock server + Chaos fault injection
│   └── ui/
│       ├── index.html              # Multi-file Inspector application shell
│       ├── styles/
│       │   └── utilitarian-dark.css # High-density 1px hairline dark UI stylesheet
│       └── js/
│           ├── sample-traces.js    # Built-in production incident & healthy baseline cassettes
│           └── app.js              # Timeline canvas, playback loop, hex dump, diff & replay UI
├── scripts/
│   └── bundle-canvas.js            # Bundles src/ui/* into a standalone single-file HTML inspector
├── traces/
│   ├── incident-checkout-timeout.chronicle.json
│   └── baseline-checkout-healthy.chronicle.json
├── tests/
│   └── chronicle.test.js           # Zero-dependency integration & unit test suite
└── package.json
```

> **Note:** the recorder proxy captures plain HTTP/1.1 request/response traffic. WebSocket (`101 Upgrade`) and HTTP/2 frames are supported in the cassette format and the Inspector UI (see the bundled sample traces), but live capture of them is not implemented yet.

## Quick Start

Requires **Node.js >= 18** (zero external `npm` dependencies required).

```bash
# Install the CLI from npm
npm install -g chronicle-flight-recorder
chronicle help
```

```bash
# 1. Run the automated test suite (fingerprinting, PII scrubber, proxy capture, replay, diff)
npm test

# 2. Compare a healthy baseline cassette against an incident capture in the terminal
node ./bin/chronicle.js diff ./traces/baseline-checkout-healthy.chronicle.json ./traces/incident-checkout-timeout.chronicle.json

# 3. Launch the local Dense Utilitarian Dark UI Inspector at http://127.0.0.1:4800
npm start

# 4. Record live traffic from any local or remote backend into a Flight Cassette
node ./bin/chronicle.js record --target http://127.0.0.1:8080 --port 4900 --out ./my-trace.chronicle.json

# 5. Replay a recorded cassette deterministically (offline mock server)
node ./bin/chronicle.js replay --trace ./traces/incident-checkout-timeout.chronicle.json --port 4901 --simulate-latency
```

## Key Capabilities

* **Deterministic Request Fingerprinting**: Canonicalizes query parameters (ignoring volatile `_t`, `timestamp`, `nonce`, and `request_id` fields) and recursively sorts JSON request keys before computing a 64-bit SHA-256 digest prefix, ensuring replayed requests match reliably even when key ordering changes.
* **Automatic Credential & PII Redaction**: Scrubs `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, and sensitive JSON body fields (`password`, `access_token`, `refresh_token`, `client_secret`, `cvv`) prior to disk serialization while retaining token prefix and byte-length diagnostics (`Bearer [REDACTED:eyJh…len=152]`).
* **Recursive JSON Schema & Latency Drift Detection**: Walks nested JSON payloads to classify `added`, `removed`, `modified`, and `type_changed` fields alongside status regressions and TTFB spikes.
* **Hardware-Inspired Utilitarian Dark UI**: Built with 1px structural borders, tabular monospace readouts, a multi-track `<canvas>` timeline scrubber, keyboard navigation (`J`/`K` or `[`/`]` to step frames, `Space` to play/pause, `/` to filter), raw Hex/ASCII wire inspection, and in-browser replay fork mutation.

## License

[MIT](LICENSE)
