/**
 * Chronicle Built-in Cassettes (`src/ui/js/sample-traces.js`)
 * Pre-loaded flight captures for immediate inspection, replay scrubbing, and
 * structural baseline diffing in the browser UI.
 */

window.CHRONICLE_BUILT_IN_CASSETTES = [
  {
    schema: 'chronicle.v1',
    id: 'cassette_inc_20261111_0942',
    title: 'INC-409: Checkout Gateway 504 Cascade & WS Drift',
    targetHost: 'https://api.meridian-commerce.internal',
    createdAt: '2026-11-11T08:42:10.000Z',
    environment: 'prod-ap-southeast-1',
    bookmarks: [
      { offsetMs: 412, label: 'DB Pool Exhaustion Starts', color: '#f59f00' },
      { offsetMs: 790, label: 'Payment Capture 504 Timeout', color: '#e03131' }
    ],
    frames: [
      {
        id: 'frm_0001',
        seq: 1,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/auth/token/refresh',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 0,
        durationMs: 38.4,
        fingerprint: 'a81f49c0192b7e11',
        timings: { dnsMs: 1.2, tcpMs: 4.8, tlsMs: 8.4, ttfbMs: 21.0, transferMs: 3.0, totalMs: 38.4 },
        request: {
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer [REDACTED:eyJh…len=148]',
            'x-client-build': 'web-checkout-4.19.2',
            'x-trace-id': 'tr_9910a8c2'
          },
          body: '{"grant_type":"refresh_token","refresh_token":"[REDACTED:len=64]","scope":"checkout:write orders:read"}',
          sizeBytes: 103
        },
        response: {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-ratelimit-remaining': '98'
          },
          body: '{"access_token":"[REDACTED:len=152]","token_type":"Bearer","expires_in":900,"session_tier":"verified_merchant"}',
          sizeBytes: 112
        },
        wsFrames: [],
        tags: ['auth']
      },
      {
        id: 'frm_0002',
        seq: 2,
        protocol: 'HTTP/2',
        method: 'GET',
        path: '/v2/cart/crt_88219a?currency=SGD&include_tax=true',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 46,
        durationMs: 54.2,
        fingerprint: '3f92c18400b7e129',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 48.1, transferMs: 6.1, totalMs: 54.2 },
        request: {
          headers: {
            accept: 'application/json',
            authorization: 'Bearer [REDACTED:eyJh…len=152]',
            'x-trace-id': 'tr_9910a8c2'
          },
          body: '',
          sizeBytes: 0
        },
        response: {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            etag: '"W/88a1b-419"',
            'x-cache': 'HIT-REDIS'
          },
          body: '{"cart_id":"crt_88219a","currency":"SGD","subtotal_cents":42800,"gst_cents":3852,"total_cents":46652,"items":[{"sku":"HW-LOGIC-16","qty":1,"unit_cents":42800,"warehouse":"SG-JURONG-02"}]}',
          sizeBytes: 188
        },
        wsFrames: [],
        tags: ['cart']
      },
      {
        id: 'frm_0003',
        seq: 3,
        protocol: 'WS/13',
        method: 'WS',
        path: '/v2/stream/inventory-locks?warehouse=SG-JURONG-02',
        host: 'wss://api.meridian-commerce.internal',
        status: 101,
        offsetMs: 110,
        durationMs: 320.0,
        fingerprint: '77d1e094a21c8803',
        timings: { dnsMs: 0.8, tcpMs: 5.2, tlsMs: 7.0, ttfbMs: 19.0, transferMs: 288.0, totalMs: 320.0 },
        request: {
          headers: {
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
          },
          body: '',
          sizeBytes: 0
        },
        response: {
          headers: {
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-accept': 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
          },
          body: '{"stream":"inventory-locks","frames_captured":4}',
          sizeBytes: 48
        },
        wsFrames: [
          { seq: 1, dir: 'TX', offsetMs: 128, opcode: 'TEXT', bytes: 68, payload: '{"op":"SUBSCRIBE","channel":"sku:HW-LOGIC-16","warehouse":"SG-JURONG-02"}' },
          { seq: 2, dir: 'RX', offsetMs: 149, opcode: 'TEXT', bytes: 92, payload: '{"op":"SNAPSHOT","sku":"HW-LOGIC-16","available":4,"reserved":11,"lock_ttl_ms":15000}' },
          { seq: 3, dir: 'RX', offsetMs: 295, opcode: 'TEXT', bytes: 96, payload: '{"op":"DELTA","sku":"HW-LOGIC-16","available":1,"reserved":14,"contention_warn":true}' },
          { seq: 4, dir: 'TX', offsetMs: 410, opcode: 'PING', bytes: 18, payload: '{"op":"HEARTBEAT"}' }
        ],
        tags: ['websocket', 'inventory']
      },
      {
        id: 'frm_0004',
        seq: 4,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/inventory/reserve',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 412,
        durationMs: 362.5,
        fingerprint: 'c4092817fa83b012',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 354.0, transferMs: 8.5, totalMs: 362.5 },
        request: {
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'idem_reserve_88219a_1',
            'x-trace-id': 'tr_9910a8c2'
          },
          body: '{"cart_id":"crt_88219a","sku":"HW-LOGIC-16","qty":1,"warehouse":"SG-JURONG-02"}',
          sizeBytes: 79
        },
        response: {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-db-pool-wait-ms': '318',
            'x-db-replica': 'pg-primary-ap-se1a'
          },
          body: '{"reservation_id":"rsv_55019f","status":"LOCKED","expires_epoch_s":"1794387430","stock_remaining":0,"warning":"POOL_SATURATION_HIGH"}',
          sizeBytes: 134
        },
        wsFrames: [],
        tags: ['slow-query', 'schema-drift']
      },
      {
        id: 'frm_0005',
        seq: 5,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/payments/intent/capture',
        host: 'https://api.meridian-commerce.internal',
        status: 504,
        offsetMs: 790,
        durationMs: 1210.0,
        fingerprint: 'e9104b772c1a9f04',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 1206.5, transferMs: 3.5, totalMs: 1210.0 },
        request: {
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'idem_pay_88219a_attempt1',
            authorization: 'Bearer [REDACTED:eyJh…len=152]',
            'x-trace-id': 'tr_9910a8c2'
          },
          body: '{"cart_id":"crt_88219a","reservation_id":"rsv_55019f","amount_cents":46652,"currency":"SGD","payment_method":"pm_card_sg_visa_4242"}',
          sizeBytes: 132
        },
        response: {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-upstream-status': '504',
            'x-envoy-upstream-service-time': '1205'
          },
          body: '{"error":{"code":"UPSTREAM_GATEWAY_TIMEOUT","message":"Acquirer settlement RPC exceeded 1200ms deadline","retryable":true,"upstream_node":"pay-core-04"}}',
          sizeBytes: 153
        },
        wsFrames: [],
        tags: ['error', '504-timeout', 'payment']
      },
      {
        id: 'frm_0006',
        seq: 6,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/payments/intent/capture',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 2045,
        durationMs: 184.6,
        fingerprint: 'e9104b772c1a9f04',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 176.2, transferMs: 8.4, totalMs: 184.6 },
        request: {
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'idem_pay_88219a_attempt1',
            'x-retry-attempt': '2',
            'x-trace-id': 'tr_9910a8c2'
          },
          body: '{"cart_id":"crt_88219a","reservation_id":"rsv_55019f","amount_cents":46652,"currency":"SGD","payment_method":"pm_card_sg_visa_4242"}',
          sizeBytes: 132
        },
        response: {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-idempotent-replayed': 'false',
            'x-upstream-node': 'pay-core-02'
          },
          body: '{"capture_id":"cap_77103c","status":"SETTLED","amount_cents":46652,"currency":"SGD","receipt_no":"SG-2026-99812","fee_BreakDown":null}',
          sizeBytes: 135
        },
        wsFrames: [],
        tags: ['retry-ok', 'payment']
      },
      {
        id: 'frm_0007',
        seq: 7,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/orders/finalize',
        host: 'https://api.meridian-commerce.internal',
        status: 201,
        offsetMs: 2250,
        durationMs: 92.4,
        fingerprint: '9102bc88e1204f5a',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 84.0, transferMs: 8.4, totalMs: 92.4 },
        request: {
          headers: {
            'content-type': 'application/json',
            'x-trace-id': 'tr_9910a8c2'
          },
          body: '{"cart_id":"crt_88219a","capture_id":"cap_77103c","reservation_id":"rsv_55019f"}',
          sizeBytes: 80
        },
        response: {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            location: '/v2/orders/ord_20261111_441'
          },
          body: '{"order_id":"ord_20261111_441","state":"CONFIRMED","dispatch_eta":"2026-11-12T04:00:00Z","total_cents":46652}',
          sizeBytes: 109
        },
        wsFrames: [],
        tags: ['order']
      }
    ]
  },
  {
    schema: 'chronicle.v1',
    id: 'cassette_base_20261110_1400',
    title: 'BASELINE-v4.18: Clean Checkout Reference Trace',
    targetHost: 'https://api.meridian-commerce.internal',
    createdAt: '2026-11-10T14:00:00.000Z',
    environment: 'staging-ap-southeast-1',
    bookmarks: [],
    frames: [
      {
        id: 'frm_b001',
        seq: 1,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/auth/token/refresh',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 0,
        durationMs: 29.0,
        fingerprint: 'a81f49c0192b7e11',
        timings: { dnsMs: 1.0, tcpMs: 4.0, tlsMs: 7.0, ttfbMs: 14.5, transferMs: 2.5, totalMs: 29.0 },
        request: {
          headers: { 'content-type': 'application/json', authorization: 'Bearer [REDACTED:eyJh…len=148]' },
          body: '{"grant_type":"refresh_token","refresh_token":"[REDACTED:len=64]","scope":"checkout:write orders:read"}',
          sizeBytes: 103
        },
        response: {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          body: '{"access_token":"[REDACTED:len=152]","token_type":"Bearer","expires_in":900,"session_tier":"verified_merchant"}',
          sizeBytes: 112
        },
        wsFrames: [],
        tags: ['auth']
      },
      {
        id: 'frm_b002',
        seq: 2,
        protocol: 'HTTP/2',
        method: 'GET',
        path: '/v2/cart/crt_88219a?currency=SGD&include_tax=true',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 35,
        durationMs: 42.0,
        fingerprint: '3f92c18400b7e129',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 37.0, transferMs: 5.0, totalMs: 42.0 },
        request: {
          headers: { accept: 'application/json' },
          body: '',
          sizeBytes: 0
        },
        response: {
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT-REDIS' },
          body: '{"cart_id":"crt_88219a","currency":"SGD","subtotal_cents":42800,"gst_cents":3852,"total_cents":46652,"items":[{"sku":"HW-LOGIC-16","qty":1,"unit_cents":42800,"warehouse":"SG-JURONG-02"}]}',
          sizeBytes: 188
        },
        wsFrames: [],
        tags: ['cart']
      },
      {
        id: 'frm_b003',
        seq: 3,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/inventory/reserve',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 95,
        durationMs: 41.2,
        fingerprint: 'c4092817fa83b012',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 36.2, transferMs: 5.0, totalMs: 41.2 },
        request: {
          headers: { 'content-type': 'application/json' },
          body: '{"cart_id":"crt_88219a","sku":"HW-LOGIC-16","qty":1,"warehouse":"SG-JURONG-02"}',
          sizeBytes: 79
        },
        response: {
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-db-pool-wait-ms': '2' },
          body: '{"reservation_id":"rsv_55019f","status":"LOCKED","expires_epoch_s":1794387430,"stock_remaining":12}',
          sizeBytes: 99
        },
        wsFrames: [],
        tags: ['inventory']
      },
      {
        id: 'frm_b004',
        seq: 4,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/payments/intent/capture',
        host: 'https://api.meridian-commerce.internal',
        status: 200,
        offsetMs: 148,
        durationMs: 118.0,
        fingerprint: 'e9104b772c1a9f04',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 112.0, transferMs: 6.0, totalMs: 118.0 },
        request: {
          headers: { 'content-type': 'application/json' },
          body: '{"cart_id":"crt_88219a","reservation_id":"rsv_55019f","amount_cents":46652,"currency":"SGD","payment_method":"pm_card_sg_visa_4242"}',
          sizeBytes: 132
        },
        response: {
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-upstream-node': 'pay-core-01' },
          body: '{"capture_id":"cap_77100a","status":"SETTLED","amount_cents":46652,"currency":"SGD","receipt_no":"SG-2026-99100","fee_breakdown":{"processing_cents":980,"net_cents":45672}}',
          sizeBytes: 172
        },
        wsFrames: [],
        tags: ['payment']
      },
      {
        id: 'frm_b005',
        seq: 5,
        protocol: 'HTTP/2',
        method: 'POST',
        path: '/v2/orders/finalize',
        host: 'https://api.meridian-commerce.internal',
        status: 201,
        offsetMs: 280,
        durationMs: 64.0,
        fingerprint: '9102bc88e1204f5a',
        timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 58.0, transferMs: 6.0, totalMs: 64.0 },
        request: {
          headers: { 'content-type': 'application/json' },
          body: '{"cart_id":"crt_88219a","capture_id":"cap_77100a","reservation_id":"rsv_55019f"}',
          sizeBytes: 80
        },
        response: {
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: '{"order_id":"ord_20261110_112","state":"CONFIRMED","dispatch_eta":"2026-11-11T04:00:00Z","total_cents":46652}',
          sizeBytes: 109
        },
        wsFrames: [],
        tags: ['order']
      }
    ]
  }
];
