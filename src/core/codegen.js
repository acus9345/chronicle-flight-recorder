/**
 * Chronicle Code & Test Synthesizer (`src/core/codegen.js`)
 * Exports any recorded HTTP/WebSocket frame into reproducible CLI commands or
 * regression test assertions (cURL, Node Fetch, Playwright API test, Hurl).
 */

export function generateCurlCommand(frame) {
  const url = `${frame.host.replace(/\/$/, '')}${frame.path}`;
  const lines = [`curl -i -X ${frame.method} '${url}'`];
  const headers = frame.request?.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'host') continue;
    lines.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (frame.request?.body) {
    lines.push(`  --data-raw '${String(frame.request.body).replace(/'/g, "'\\''")}'`);
  }
  return lines.join(' \\\n');
}

export function generateFetchSnippet(frame) {
  const url = `${frame.host.replace(/\/$/, '')}${frame.path}`;
  const headers = { ...(frame.request?.headers || {}) };
  delete headers['content-length'];
  delete headers['host'];

  const opts = {
    method: frame.method,
    headers
  };
  let bodyLine = '';
  if (frame.request?.body) {
    bodyLine = `,\n  body: ${JSON.stringify(frame.request.body)}`;
  }

  return `const res = await fetch(${JSON.stringify(url)}, {
  method: ${JSON.stringify(opts.method)},
  headers: ${JSON.stringify(opts.headers, null, 4).replace(/\n/g, '\n  ')}${bodyLine}
});
console.log('Status:', res.status);
const payload = await res.text();`;
}

export function generatePlaywrightTest(frame) {
  const methodLower = frame.method.toLowerCase();
  const headers = { ...(frame.request?.headers || {}) };
  delete headers['content-length'];
  delete headers['host'];

  let topKeys = [];
  try {
    const parsed = JSON.parse(frame.response?.body || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      topKeys = Object.keys(parsed).slice(0, 4);
    }
  } catch {
    // ignore non-json
  }

  const keyAssertions = topKeys
    .map((k) => `  expect(body).toHaveProperty(${JSON.stringify(k)});`)
    .join('\n');

  return `import { test, expect } from '@playwright/test';

test('Chronicle replay assertion: ${frame.method} ${frame.path} [${frame.id}]', async ({ request }) => {
  const res = await request.${methodLower}(${JSON.stringify(frame.path)}, {
    headers: ${JSON.stringify(headers)}${frame.request?.body ? `,\n    data: ${frame.request.body}` : ''}
  });
  expect(res.status()).toBe(${frame.status});
${topKeys.length ? `  const body = await res.json();\n${keyAssertions}` : ''}
});`;
}
