/**
 * Chronicle Structural Diff & Drift Analyzer (`src/core/diff-engine.js`)
 * Compares two HTTP/WebSocket frames or two entire FlightCassettes to detect:
 *  - Status code regressions (e.g. 200 -> 502)
 *  - Latency anomalies (delta ms and percentage shift)
 *  - Header additions, removals, and value mutations
 *  - Recursive JSON schema & value drift across nested response bodies
 */

/**
 * Recursively diffs two JSON values and returns a flat list of structural changes
 * keyed by JSONPath (e.g., `$.data.order.items[0].price`).
 */
export function diffJsonPayloads(leftRaw, rightRaw) {
  const leftParsed = tryParseJson(leftRaw);
  const rightParsed = tryParseJson(rightRaw);

  if (!leftParsed.ok || !rightParsed.ok) {
    return {
      isJson: false,
      changes: diffRawLines(String(leftRaw ?? ''), String(rightRaw ?? ''))
    };
  }

  const changes = [];
  walkJsonDiff(leftParsed.value, rightParsed.value, '$', changes);
  return {
    isJson: true,
    changes
  };
}

function walkJsonDiff(a, b, path, changes) {
  const typeA = getJsonType(a);
  const typeB = getJsonType(b);

  if (typeA !== typeB) {
    changes.push({
      path,
      kind: 'type_changed',
      beforeType: typeA,
      afterType: typeB,
      before: formatScalar(a),
      after: formatScalar(b)
    });
    return;
  }

  if (typeA === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const subPath = `${path}.${k}`;
      if (!(k in a)) {
        changes.push({
          path: subPath,
          kind: 'added',
          before: undefined,
          after: formatScalar(b[k]),
          afterType: getJsonType(b[k])
        });
      } else if (!(k in b)) {
        changes.push({
          path: subPath,
          kind: 'removed',
          before: formatScalar(a[k]),
          after: undefined,
          beforeType: getJsonType(a[k])
        });
      } else {
        walkJsonDiff(a[k], b[k], subPath, changes);
      }
    }
    return;
  }

  if (typeA === 'array') {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const subPath = `${path}[${i}]`;
      if (i >= a.length) {
        changes.push({
          path: subPath,
          kind: 'added',
          before: undefined,
          after: formatScalar(b[i]),
          afterType: getJsonType(b[i])
        });
      } else if (i >= b.length) {
        changes.push({
          path: subPath,
          kind: 'removed',
          before: formatScalar(a[i]),
          after: undefined,
          beforeType: getJsonType(a[i])
        });
      } else {
        walkJsonDiff(a[i], b[i], subPath, changes);
      }
    }
    return;
  }

  if (!Object.is(a, b)) {
    changes.push({
      path,
      kind: 'modified',
      before: a,
      after: b,
      beforeType: typeA,
      afterType: typeB
    });
  }
}

/**
 * Compares two individual recorded frames (`baseFrame` vs `candidateFrame`).
 */
export function compareFrames(baseFrame, candidateFrame) {
  const statusChanged = baseFrame.status !== candidateFrame.status;
  const latencyDeltaMs = Math.round((candidateFrame.durationMs - baseFrame.durationMs) * 100) / 100;
  const latencyDeltaPct = baseFrame.durationMs > 0
    ? Math.round(((candidateFrame.durationMs - baseFrame.durationMs) / baseFrame.durationMs) * 1000) / 10
    : 0;

  const headerChanges = diffHeaders(
    baseFrame.response?.headers || {},
    candidateFrame.response?.headers || {}
  );
  const reqBodyDiff = diffJsonPayloads(baseFrame.request?.body || '', candidateFrame.request?.body || '');
  const resBodyDiff = diffJsonPayloads(baseFrame.response?.body || '', candidateFrame.response?.body || '');

  const schemaBreakingChanges = resBodyDiff.changes.filter(
    (c) => c.kind === 'removed' || c.kind === 'type_changed'
  );

  let severity = 'clean';
  if (
    (baseFrame.status < 400 && candidateFrame.status >= 400) ||
    schemaBreakingChanges.length > 0
  ) {
    severity = 'breaking';
  } else if (
    statusChanged ||
    resBodyDiff.changes.length > 0 ||
    latencyDeltaMs > 100
  ) {
    severity = 'drift';
  }

  return {
    baseId: baseFrame.id,
    candidateId: candidateFrame.id,
    method: candidateFrame.method,
    path: candidateFrame.path,
    severity,
    status: {
      before: baseFrame.status,
      after: candidateFrame.status,
      changed: statusChanged
    },
    latency: {
      beforeMs: baseFrame.durationMs,
      afterMs: candidateFrame.durationMs,
      deltaMs: latencyDeltaMs,
      deltaPct: latencyDeltaPct
    },
    headerChanges,
    requestDiff: reqBodyDiff,
    responseDiff: resBodyDiff,
    breakingCount: schemaBreakingChanges.length
  };
}

/**
 * Compares two full FlightCassettes by pairing frames via fingerprint or method+path.
 */
export function compareCassettes(baseCassette, candidateCassette) {
  const baseByKey = new Map();
  for (const f of baseCassette.frames) {
    const key = `${f.method} ${f.path}`;
    if (!baseByKey.has(key)) baseByKey.set(key, []);
    baseByKey.get(key).push(f);
  }

  const pairedReports = [];
  const unmatchedCandidate = [];
  const consumedBaseIds = new Set();

  for (const cand of candidateCassette.frames) {
    const key = `${cand.method} ${cand.path}`;
    const bucket = baseByKey.get(key) || [];
    const match = bucket.find((b) => !consumedBaseIds.has(b.id) && b.fingerprint === cand.fingerprint)
      || bucket.find((b) => !consumedBaseIds.has(b.id));

    if (match) {
      consumedBaseIds.add(match.id);
      pairedReports.push(compareFrames(match, cand));
    } else {
      unmatchedCandidate.push(cand);
    }
  }

  const unmatchedBase = baseCassette.frames.filter((b) => !consumedBaseIds.has(b.id));
  const breakingTotal = pairedReports.filter((r) => r.severity === 'breaking').length;
  const driftTotal = pairedReports.filter((r) => r.severity === 'drift').length;

  return {
    baseTitle: baseCassette.title,
    candidateTitle: candidateCassette.title,
    pairedCount: pairedReports.length,
    breakingCount: breakingTotal,
    driftCount: driftTotal,
    unmatchedBaseCount: unmatchedBase.length,
    unmatchedCandidateCount: unmatchedCandidate.length,
    reports: pairedReports,
    unmatchedBase,
    unmatchedCandidate
  };
}

function diffHeaders(a = {}, b = {}) {
  const normA = {};
  const normB = {};
  for (const [k, v] of Object.entries(a)) normA[k.toLowerCase()] = String(v);
  for (const [k, v] of Object.entries(b)) normB[k.toLowerCase()] = String(v);

  const allKeys = [...new Set([...Object.keys(normA), ...Object.keys(normB)])].sort();
  const out = [];
  for (const k of allKeys) {
    if (!(k in normA)) {
      out.push({ header: k, kind: 'added', before: null, after: normB[k] });
    } else if (!(k in normB)) {
      out.push({ header: k, kind: 'removed', before: normA[k], after: null });
    } else if (normA[k] !== normB[k]) {
      out.push({ header: k, kind: 'modified', before: normA[k], after: normB[k] });
    }
  }
  return out;
}

function diffRawLines(a, b) {
  if (a === b) return [];
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      diffs.push({
        path: `line:${i + 1}`,
        kind: aLines[i] === undefined ? 'added' : bLines[i] === undefined ? 'removed' : 'modified',
        before: aLines[i] ?? null,
        after: bLines[i] ?? null
      });
    }
  }
  return diffs;
}

function tryParseJson(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: false, value: null };
  if (typeof raw === 'object') return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: null };
  }
}

function getJsonType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function formatScalar(val) {
  if (val === null || typeof val !== 'object') return val;
  return JSON.stringify(val);
}
