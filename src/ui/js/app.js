/**
 * Chronicle Dense Utilitarian Dark UI Inspector Engine (`src/ui/js/app.js`)
 * Implements:
 * - Multi-track hardware logic-analyzer waterfall canvas & time-window scrubber
 * - Real-time playback transport (Play/Pause, 0.25x..2x speed, frame step `[` / `]`)
 * - Live proxy frame generator & `.chronicle.json` import/export
 * - Deep Frame Inspector: Headers, Formatted JSON, Hex/ASCII Dump, Phase Waterfall,
 *   Structural Baseline Diff (`INC-409` vs `BASELINE-v4.18`), Replay Mutator, & Codegen (cURL/Fetch/Playwright)
 */

(function () {
  const cassettes = window.CHRONICLE_BUILT_IN_CASSETTES ? [...window.CHRONICLE_BUILT_IN_CASSETTES] : [];

  const state = {
    cassettes,
    activeCassetteIdx: 0,
    baselineCassetteIdx: 1,
    selectedFrameId: cassettes[0]?.frames[4]?.id || cassettes[0]?.frames[0]?.id || null,
    activeTab: 'payload', // 'payload' | 'headers' | 'waterfall' | 'ws' | 'diff' | 'hex' | 'replay'
    filterMethod: 'ALL',
    filterStatus: 'ALL',
    searchQuery: '',
    onlyErrors: false,
    playheadMs: 790,
    isPlaying: false,
    playbackSpeed: 1.0,
    isLiveRecording: false,
    windowStartMs: 0,
    windowEndMs: 2450,
    replayDraftStatus: 200,
    replayDraftBody: '',
    toastMessage: null
  };

  let rafId = null;
  let lastTickTs = 0;
  let liveIntervalId = null;

  function getActiveCassette() {
    return state.cassettes[state.activeCassetteIdx] || state.cassettes[0];
  }

  function getBaselineCassette() {
    return state.cassettes[state.baselineCassetteIdx] || state.cassettes[0];
  }

  function computeSpanMs(cassette) {
    if (!cassette || !cassette.frames.length) return 1000;
    const maxEnd = Math.max(...cassette.frames.map((f) => f.offsetMs + f.durationMs));
    return Math.max(100, Math.ceil(maxEnd * 1.05));
  }

  function getFilteredFrames() {
    const cassette = getActiveCassette();
    if (!cassette) return [];
    const q = state.searchQuery.trim().toLowerCase();

    return cassette.frames.filter((f) => {
      if (f.offsetMs > state.windowEndMs || f.offsetMs + f.durationMs < state.windowStartMs) {
        return false;
      }
      if (state.filterMethod !== 'ALL' && f.method !== state.filterMethod) {
        return false;
      }
      if (state.onlyErrors && f.status < 400 && f.status !== 0) {
        return false;
      }
      if (state.filterStatus !== 'ALL') {
        if (state.filterStatus === '2XX' && (f.status < 200 || f.status >= 300)) return false;
        if (state.filterStatus === '4XX' && (f.status < 400 || f.status >= 500)) return false;
        if (state.filterStatus === '5XX' && f.status < 500) return false;
        if (state.filterStatus === 'WS' && f.protocol !== 'WS/13' && f.method !== 'WS') return false;
      }
      if (q) {
        const hay = `${f.id} ${f.method} ${f.path} ${f.status} ${f.fingerprint} ${f.request?.body || ''} ${f.response?.body || ''} ${(f.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function getSelectedFrame() {
    const cassette = getActiveCassette();
    if (!cassette) return null;
    return cassette.frames.find((f) => f.id === state.selectedFrameId) || cassette.frames[0] || null;
  }

  function computeSummary(frames) {
    if (!frames.length) {
      return { count: 0, errors: 0, p50: 0, p95: 0, max: 0, bytes: 0 };
    }
    const sorted = frames.map((f) => f.durationMs).sort((a, b) => a - b);
    const errors = frames.filter((f) => f.status >= 400).length;
    const bytes = frames.reduce((s, f) => s + (f.request?.sizeBytes || 0) + (f.response?.sizeBytes || 0), 0);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
    const max = sorted[sorted.length - 1] || 0;
    return {
      count: frames.length,
      errors,
      p50: p50.toFixed(1),
      p95: p95.toFixed(1),
      max: max.toFixed(1),
      bytes
    };
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  // Structural JSON diff for browser UI (mirrors src/core/diff-engine.js)
  function computeStructuralDiff(baseFrame, candFrame) {
    if (!baseFrame || !candFrame) return null;
    const changes = [];

    function getType(v) {
      if (v === null) return 'null';
      if (Array.isArray(v)) return 'array';
      return typeof v;
    }

    function walk(a, b, path) {
      const tA = getType(a);
      const tB = getType(b);
      if (tA !== tB) {
        changes.push({ path, kind: 'TYPE_DRIFT', before: `${JSON.stringify(a)} (${tA})`, after: `${JSON.stringify(b)} (${tB})` });
        return;
      }
      if (tA === 'object') {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        for (const k of keys) {
          const p = `${path}.${k}`;
          if (!(k in a)) changes.push({ path: p, kind: 'ADDED', before: '—', after: JSON.stringify(b[k]) });
          else if (!(k in b)) changes.push({ path: p, kind: 'REMOVED', before: JSON.stringify(a[k]), after: '—' });
          else walk(a[k], b[k], p);
        }
        return;
      }
      if (tA === 'array') {
        const max = Math.max(a.length, b.length);
        for (let i = 0; i < max; i++) {
          const p = `${path}[${i}]`;
          if (i >= a.length) changes.push({ path: p, kind: 'ADDED', before: '—', after: JSON.stringify(b[i]) });
          else if (i >= b.length) changes.push({ path: p, kind: 'REMOVED', before: JSON.stringify(a[i]), after: '—' });
          else walk(a[i], b[i], p);
        }
        return;
      }
      if (a !== b) {
        changes.push({ path, kind: 'MODIFIED', before: JSON.stringify(a), after: JSON.stringify(b) });
      }
    }

    try {
      const leftObj = JSON.parse(baseFrame.response?.body || '{}');
      const rightObj = JSON.parse(candFrame.response?.body || '{}');
      walk(leftObj, rightObj, '$');
    } catch {
      if ((baseFrame.response?.body || '') !== (candFrame.response?.body || '')) {
        changes.push({ path: 'raw.body', kind: 'MODIFIED', before: baseFrame.response?.body || '', after: candFrame.response?.body || '' });
      }
    }

    return {
      baseFrame,
      candFrame,
      statusBefore: baseFrame.status,
      statusAfter: candFrame.status,
      latencyDeltaMs: (candFrame.durationMs - baseFrame.durationMs).toFixed(1),
      changes
    };
  }

  function toHexDump(str) {
    if (!str) return '00000000  [EMPTY PAYLOAD]';
    const bytes = new TextEncoder().encode(str);
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const slice = bytes.slice(offset, offset + 16);
      const hexPart = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47, ' ');
      const asciiPart = Array.from(slice)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('');
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart}  |${asciiPart}|`);
    }
    return lines.join('\n');
  }

  function showToast(msg) {
    state.toastMessage = msg;
    const footerEl = document.getElementById('footer-status-msg');
    if (footerEl) footerEl.textContent = msg;
    setTimeout(() => {
      if (state.toastMessage === msg) {
        state.toastMessage = null;
        if (footerEl) footerEl.textContent = 'READY // LOCAL-FIRST ENGINE ACTIVE (SHA-256 FINGERPRINTING + PII SCRUBBER)';
      }
    }, 3200);
  }

  // Render Timeline Canvas
  function renderTimelineCanvas() {
    const canvas = document.getElementById('timeline-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, rect.width);
    const height = Math.max(54, rect.height);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const cassette = getActiveCassette();
    const spanMs = computeSpanMs(cassette);

    // Background grid
    ctx.fillStyle = '#090b0e';
    ctx.fillRect(0, 0, width, height);

    const gridSteps = 10;
    ctx.strokeStyle = '#161b22';
    ctx.lineWidth = 1;
    for (let i = 1; i < gridSteps; i++) {
      const x = Math.round((width / gridSteps) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Active window shading
    const winX1 = (state.windowStartMs / spanMs) * width;
    const winX2 = (Math.min(spanMs, state.windowEndMs) / spanMs) * width;
    ctx.fillStyle = 'rgba(229, 153, 0, 0.04)';
    ctx.fillRect(winX1, 0, Math.max(2, winX2 - winX1), height);

    // Draw bookmark markers
    for (const bm of cassette.bookmarks || []) {
      const bx = (bm.offsetMs / spanMs) * width;
      ctx.strokeStyle = bm.color || '#f59f00';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw waterfall bars for each frame
    const frames = cassette.frames || [];
    const laneCount = Math.max(1, frames.length);
    const rowH = Math.min(10, Math.max(4, Math.floor((height - 8) / laneCount)));
    const gap = 2;

    frames.forEach((f, idx) => {
      const x = (f.offsetMs / spanMs) * width;
      const w = Math.max(4, (f.durationMs / spanMs) * width);
      const y = 4 + idx * (rowH + gap);

      let color = '#2fb344';
      if (f.status >= 500) color = '#e03131';
      else if (f.status >= 400) color = '#f59f00';
      else if (f.status === 101 || f.method === 'WS') color = '#ae3ec9';
      else if (f.durationMs > 300) color = '#e59900';

      ctx.fillStyle = f.id === state.selectedFrameId ? '#ffffff' : color;
      ctx.fillRect(x, y, w, rowH);

      if (f.id === state.selectedFrameId) {
        ctx.strokeStyle = '#e59900';
        ctx.strokeRect(Math.max(0, x - 1), Math.max(0, y - 1), w + 2, rowH + 2);
      }
    });

    // Draw Playhead Cursor
    const playX = Math.min(width - 1, Math.max(0, (state.playheadMs / spanMs) * width));
    ctx.strokeStyle = '#22b8cf';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, height);
    ctx.stroke();

    ctx.fillStyle = '#22b8cf';
    ctx.beginPath();
    ctx.moveTo(playX - 5, 0);
    ctx.lineTo(playX + 5, 0);
    ctx.lineTo(playX, 6);
    ctx.closePath();
    ctx.fill();
  }

  function renderRuler() {
    const cassette = getActiveCassette();
    const spanMs = computeSpanMs(cassette);
    const rulerEl = document.getElementById('timeline-ruler');
    if (!rulerEl) return;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => `${Math.round(spanMs * t)}ms`);
    rulerEl.innerHTML = `
      <span>0ms [ORIGIN]</span>
      <span>${ticks[1]}</span>
      <span>${ticks[2]} [PLAYHEAD: ${Math.round(state.playheadMs)}ms]</span>
      <span>${ticks[3]}</span>
      <span>${ticks[4]} [SPAN]</span>
    `;
  }

  function renderHeaderBar() {
    const cassette = getActiveCassette();
    const filtered = getFilteredFrames();
    const summary = computeSummary(filtered);

    const selEl = document.getElementById('cassette-select');
    if (selEl) {
      selEl.innerHTML = state.cassettes
        .map((c, idx) => `<option value="${idx}" ${idx === state.activeCassetteIdx ? 'selected' : ''}>[${c.environment}] ${c.title}</option>`)
        .join('');
    }

    const telemetryEl = document.getElementById('telemetry-strip');
    if (telemetryEl) {
      telemetryEl.innerHTML = `
        <div class="metric-cell"><span class="metric-label">FRAMES</span><span class="metric-val">${summary.count}/${cassette.frames.length}</span></div>
        <div class="metric-cell"><span class="metric-label">ERR</span><span class="metric-val" style="color:${summary.errors > 0 ? '#ff6b6b' : '#2fb344'}">${summary.errors}</span></div>
        <div class="metric-cell"><span class="metric-label">P50</span><span class="metric-val">${summary.p50}ms</span></div>
        <div class="metric-cell"><span class="metric-label">P95</span><span class="metric-val" style="color:${Number(summary.p95) > 300 ? '#f59f00' : '#e4e8ee'}">${summary.p95}ms</span></div>
        <div class="metric-cell"><span class="metric-label">BYTES</span><span class="metric-val">${formatBytes(summary.bytes)}</span></div>
      `;
    }

    const playBtn = document.getElementById('btn-play-toggle');
    if (playBtn) {
      playBtn.textContent = state.isPlaying ? 'PAUSE [SPC]' : 'PLAY [SPC]';
      playBtn.classList.toggle('active', state.isPlaying);
    }

    const recBtn = document.getElementById('btn-live-sim');
    if (recBtn) {
      recBtn.innerHTML = `<span class="led-dot ${state.isLiveRecording ? 'recording' : ''}"></span> ${state.isLiveRecording ? 'STOP PROXY SIM' : 'SIMULATE LIVE TRAFFIC'}`;
      recBtn.classList.toggle('active', state.isLiveRecording);
    }
  }

  function renderFrameTable() {
    const tbody = document.getElementById('frame-table-body');
    if (!tbody) return;
    const frames = getFilteredFrames();

    if (!frames.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">NO FRAMES MATCH CURRENT FILTER / TIME WINDOW</td></tr>`;
      return;
    }

    const cassette = getActiveCassette();
    const spanMs = computeSpanMs(cassette);

    tbody.innerHTML = frames
      .map((f) => {
        const isSelected = f.id === state.selectedFrameId;
        const isPastPlayhead = f.offsetMs <= state.playheadMs;
        const statusClass = f.status === 101 ? 'status-101' : f.status >= 500 ? 'status-5xx' : f.status >= 400 ? 'status-4xx' : f.status >= 300 ? 'status-3xx' : 'status-2xx';
        const leftPct = Math.min(92, Math.max(0, (f.offsetMs / spanMs) * 100)).toFixed(1);
        const widthPct = Math.min(100 - Number(leftPct), Math.max(3, (f.durationMs / spanMs) * 100)).toFixed(1);
        const barColor = f.status >= 500 ? '#e03131' : f.status === 101 ? '#ae3ec9' : f.durationMs > 300 ? '#f59f00' : '#2fb344';

        return `
          <tr data-frame-id="${f.id}" class="${isSelected ? 'selected' : ''}" style="opacity:${isPastPlayhead ? '1' : '0.55'}">
            <td style="width:46px;color:var(--text-muted)">#${String(f.seq).padStart(2, '0')}</td>
            <td style="width:62px"><span class="method-tag method-${f.method}">${f.method}</span></td>
            <td style="width:54px"><span class="status-tag ${statusClass}">${f.status}</span></td>
            <td title="${f.path}" class="selectable">${escapeHtml(f.path)}</td>
            <td style="width:68px;text-align:right;color:${f.durationMs > 300 ? '#f59f00' : 'var(--text-primary)'}">${f.durationMs.toFixed(1)}ms</td>
            <td style="width:64px;text-align:right;color:var(--text-secondary)">${formatBytes((f.request?.sizeBytes || 0) + (f.response?.sizeBytes || 0))}</td>
            <td style="width:110px">
              <div style="position:relative;height:8px;background:#090b0d;border:1px solid #22262e">
                <div style="position:absolute;left:${leftPct}%;width:${widthPct}%;top:0;bottom:0;background:${barColor}"></div>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  function renderInspectorPane() {
    const frame = getSelectedFrame();
    const headerEl = document.getElementById('inspector-frame-summary');
    const bodyEl = document.getElementById('inspector-content');
    if (!headerEl || !bodyEl) return;

    if (!frame) {
      headerEl.innerHTML = `<span>NO FRAME SELECTED</span>`;
      bodyEl.innerHTML = `<div style="color:var(--text-muted);padding:16px">Select a frame from the table or timeline to inspect headers, payloads, timing phases, and structural drift.</div>`;
      return;
    }

    headerEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
        <span class="method-tag method-${frame.method}">${frame.method}</span>
        <span class="mono selectable" style="font-weight:700;color:var(--text-primary)">${escapeHtml(frame.path)}</span>
      </div>
      <div class="mono" style="color:var(--text-muted);font-size:10px;white-space:nowrap">
        FP:${frame.fingerprint} | +${frame.offsetMs}ms
      </div>
    `;

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
    });

    if (state.activeTab === 'payload') {
      const reqFormatted = formatJsonSafe(frame.request?.body || '');
      const resFormatted = formatJsonSafe(frame.response?.body || '');
      bodyEl.innerHTML = `
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;color:var(--text-secondary)">
            <span>REQUEST PAYLOAD (${frame.request?.sizeBytes || 0} B)</span>
            <span style="color:var(--accent-amber)">PII SCRUBBER: ACTIVE</span>
          </div>
          <pre class="code-block selectable">${escapeHtml(reqFormatted || '// Empty request body')}</pre>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;color:var(--text-secondary)">
            <span>RESPONSE PAYLOAD (${frame.response?.sizeBytes || 0} B) — STATUS ${frame.status}</span>
            <span>PROTO: ${frame.protocol}</span>
          </div>
          <pre class="code-block selectable">${escapeHtml(resFormatted || '// Empty response body')}</pre>
        </div>
      `;
      return;
    }

    if (state.activeTab === 'headers') {
      const reqRows = Object.entries(frame.request?.headers || {})
        .map(([k, v]) => `<tr><td class="kv-key selectable">${escapeHtml(k)}</td><td class="kv-val selectable">${escapeHtml(String(v))}</td></tr>`)
        .join('');
      const resRows = Object.entries(frame.response?.headers || {})
        .map(([k, v]) => `<tr><td class="kv-key selectable">${escapeHtml(k)}</td><td class="kv-val selectable">${escapeHtml(String(v))}</td></tr>`)
        .join('');

      bodyEl.innerHTML = `
        <div style="margin-bottom:6px;color:var(--text-secondary);font-weight:600">REQUEST HEADERS</div>
        <table class="kv-table">${reqRows || '<tr><td colspan="2">None</td></tr>'}</table>
        <div style="margin-bottom:6px;color:var(--text-secondary);font-weight:600">RESPONSE HEADERS</div>
        <table class="kv-table">${resRows || '<tr><td colspan="2">None</td></tr>'}</table>
      `;
      return;
    }

    if (state.activeTab === 'waterfall') {
      const t = frame.timings || { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: frame.durationMs, transferMs: 0, totalMs: frame.durationMs };
      const total = Math.max(0.1, t.totalMs);
      const phases = [
        { label: 'DNS Lookup', ms: t.dnsMs, color: '#4dabf7' },
        { label: 'TCP Handshake', ms: t.tcpMs, color: '#22b8cf' },
        { label: 'TLS Negotiation', ms: t.tlsMs, color: '#ae3ec9' },
        { label: 'TTFB (Server Wait)', ms: t.ttfbMs, color: t.ttfbMs > 250 ? '#e03131' : '#e59900' },
        { label: 'Content Transfer', ms: t.transferMs, color: '#2fb344' }
      ];

      let accMs = 0;
      const rowsHtml = phases
        .map((p) => {
          const left = ((accMs / total) * 100).toFixed(1);
          const width = Math.max(1.5, (p.ms / total) * 100).toFixed(1);
          accMs += p.ms;
          return `
            <div style="display:grid;grid-template-columns:130px 1fr 65px;align-items:center;gap:8px;margin-bottom:8px">
              <span style="color:var(--text-secondary)">${p.label}</span>
              <div style="position:relative;height:12px;background:#090b0d;border:1px solid var(--border-hairline)">
                <div style="position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${p.color}"></div>
              </div>
              <span style="text-align:right">${p.ms.toFixed(1)} ms</span>
            </div>
          `;
        })
        .join('');

      const wsHtml = (frame.wsFrames && frame.wsFrames.length)
        ? `
          <div style="margin-top:14px;margin-bottom:6px;color:var(--text-secondary);font-weight:600">WEBSOCKET SUB-FRAMES (${frame.wsFrames.length})</div>
          <table class="kv-table">
            <thead>
              <tr style="border-bottom:1px solid var(--border-strong);color:var(--text-muted)">
                <td>#</td><td>DIR</td><td>T+MS</td><td>OPCODE</td><td>PAYLOAD</td>
              </tr>
            </thead>
            <tbody>
              ${frame.wsFrames.map((wf) => `
                <tr>
                  <td>${wf.seq}</td>
                  <td style="color:${wf.dir === 'TX' ? '#4dabf7' : '#51cf66'}">${wf.dir}</td>
                  <td>+${wf.offsetMs}ms</td>
                  <td>${wf.opcode}</td>
                  <td class="selectable">${escapeHtml(wf.payload)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `
        : '';

      bodyEl.innerHTML = `
        <div style="margin-bottom:10px;color:var(--text-secondary)">PHASE WATERFALL BREAKDOWN (TOTAL: <strong style="color:var(--text-primary)">${total.toFixed(1)} ms</strong>)</div>
        ${rowsHtml}
        ${wsHtml}
      `;
      return;
    }

    if (state.activeTab === 'diff') {
      const baseCassette = getBaselineCassette();
      const baseMatch = baseCassette.frames.find((b) => b.fingerprint === frame.fingerprint)
        || baseCassette.frames.find((b) => b.method === frame.method && b.path === frame.path);

      if (!baseMatch) {
        bodyEl.innerHTML = `<div style="color:var(--status-warn);padding:10px;border:1px solid var(--border-strong)">No matching baseline frame found in "${escapeHtml(baseCassette.title)}" for ${frame.method} ${escapeHtml(frame.path)}.</div>`;
        return;
      }

      const diff = computeStructuralDiff(baseMatch, frame);
      const latSign = Number(diff.latencyDeltaMs) >= 0 ? `+${diff.latencyDeltaMs}ms` : `${diff.latencyDeltaMs}ms`;

      const changeRows = diff.changes.length
        ? diff.changes.map((c) => {
            const color = c.kind === 'REMOVED' || c.kind === 'TYPE_DRIFT' ? '#ff6b6b' : c.kind === 'ADDED' ? '#51cf66' : '#f59f00';
            return `
              <tr>
                <td style="color:${color};font-weight:700">${c.kind}</td>
                <td class="selectable">${escapeHtml(c.path)}</td>
                <td class="selectable" style="color:var(--text-secondary)">${escapeHtml(String(c.before))}</td>
                <td class="selectable" style="color:var(--text-primary)">${escapeHtml(String(c.after))}</td>
              </tr>
            `;
          }).join('')
        : `<tr><td colspan="4" style="color:var(--status-ok);padding:8px">ZERO JSON SCHEMA OR VALUE DRIFT DETECTED</td></tr>`;

      bodyEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-root);border:1px solid var(--border-hairline);margin-bottom:10px">
          <span>BASELINE: <strong>${escapeHtml(baseCassette.title)}</strong> [${baseMatch.id}]</span>
          <span>STATUS: <strong>${diff.statusBefore} → ${diff.statusAfter}</strong> | LATENCY DELTA: <strong style="color:${Number(diff.latencyDeltaMs) > 50 ? '#ff6b6b' : '#2fb344'}">${latSign}</strong></span>
        </div>
        <table class="kv-table">
          <thead>
            <tr style="color:var(--text-muted);border-bottom:1px solid var(--border-strong)">
              <td style="width:18%">CHANGE</td>
              <td style="width:30%">JSONPATH</td>
              <td style="width:26%">BASELINE</td>
              <td style="width:26%">CANDIDATE</td>
            </tr>
          </thead>
          <tbody>${changeRows}</tbody>
        </table>
      `;
      return;
    }

    if (state.activeTab === 'hex') {
      const hexDump = toHexDump(frame.response?.body || '');
      bodyEl.innerHTML = `
        <div style="margin-bottom:6px;color:var(--text-secondary)">RESPONSE WIRE PAYLOAD — HEX / ASCII DUMP (${frame.response?.sizeBytes || 0} BYTES)</div>
        <pre class="code-block selectable">${escapeHtml(hexDump)}</pre>
      `;
      return;
    }

    if (state.activeTab === 'replay') {
      const curlCmd = buildCurlSnippet(frame);
      const pwSnippet = buildPlaywrightSnippet(frame);
      bodyEl.innerHTML = `
        <div style="margin-bottom:12px;padding:8px;background:var(--bg-root);border:1px solid var(--border-strong)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="color:var(--accent-amber);font-weight:700">DETERMINISTIC REPLAY & FAULT MUTATOR</span>
            <button type="button" class="hw-btn active" id="btn-trigger-replay">EXECUTE REPLAY FORK</button>
          </div>
          <div style="display:grid;grid-template-columns:90px 1fr;gap:6px;align-items:center;margin-bottom:6px">
            <label for="mutate-status" style="color:var(--text-secondary)">OVERRIDE STATUS</label>
            <input id="mutate-status" type="number" class="search-input" style="width:90px" value="${frame.status}" />
          </div>
          <div style="color:var(--text-secondary);margin-bottom:4px">MUTATE REQUEST BODY (JSON)</div>
          <textarea id="mutate-body" class="code-block" style="width:100%;height:64px;resize:vertical">${escapeHtml(frame.request?.body || '{}')}</textarea>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="color:var(--text-secondary)">GENERATED cURL COMMAND</span>
          <button type="button" class="hw-btn" id="btn-copy-curl">COPY cURL</button>
        </div>
        <pre class="code-block selectable" style="margin-bottom:10px">${escapeHtml(curlCmd)}</pre>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="color:var(--text-secondary)">GENERATED PLAYWRIGHT REGRESSION TEST</span>
          <button type="button" class="hw-btn" id="btn-copy-pw">COPY TEST</button>
        </div>
        <pre class="code-block selectable">${escapeHtml(pwSnippet)}</pre>
      `;

      const replayBtn = document.getElementById('btn-trigger-replay');
      if (replayBtn) {
        replayBtn.addEventListener('click', () => {
          const statusInput = document.getElementById('mutate-status');
          const bodyInput = document.getElementById('mutate-body');
          const newStatus = Number(statusInput?.value || frame.status);
          const newBody = bodyInput?.value ?? frame.request?.body;

          const cassette = getActiveCassette();
          const span = computeSpanMs(cassette);
          const cloned = JSON.parse(JSON.stringify(frame));
          cloned.id = `frm_${String(cassette.frames.length + 1).padStart(4, '0')}`;
          cloned.seq = cassette.frames.length + 1;
          cloned.status = newStatus;
          cloned.offsetMs = Math.round(span + 25);
          cloned.durationMs = Math.max(12, Math.round(frame.durationMs * 0.65 * 10) / 10);
          cloned.request.body = newBody;
          cloned.request.sizeBytes = new TextEncoder().encode(newBody).length;
          cloned.tags = [...(cloned.tags || []), 'replayed-fork'];

          cassette.frames.push(cloned);
          state.windowEndMs = computeSpanMs(cassette);
          state.selectedFrameId = cloned.id;
          state.playheadMs = cloned.offsetMs;
          state.activeTab = 'payload';
          showToast(`REPLAY FORK RECORDED -> ${cloned.id} (${cloned.method} ${cloned.path} -> ${cloned.status})`);
          renderAll();
        });
      }

      const copyCurlBtn = document.getElementById('btn-copy-curl');
      if (copyCurlBtn) {
        copyCurlBtn.addEventListener('click', () => copyTextSafe(curlCmd, 'cURL command copied to clipboard'));
      }
      const copyPwBtn = document.getElementById('btn-copy-pw');
      if (copyPwBtn) {
        copyPwBtn.addEventListener('click', () => copyTextSafe(pwSnippet, 'Playwright regression test copied to clipboard'));
      }
    }
  }

  function buildCurlSnippet(frame) {
    const url = `${frame.host.replace(/\/$/, '')}${frame.path}`;
    const lines = [`curl -i -X ${frame.method} '${url}'`];
    for (const [k, v] of Object.entries(frame.request?.headers || {})) {
      lines.push(`  -H '${k}: ${v}'`);
    }
    if (frame.request?.body) {
      lines.push(`  --data-raw '${frame.request.body}'`);
    }
    return lines.join(' \\\n');
  }

  function buildPlaywrightSnippet(frame) {
    return `test('Chronicle [${frame.id}] ${frame.method} ${frame.path}', async ({ request }) => {\n  const res = await request.${frame.method.toLowerCase()}('${frame.path}');\n  expect(res.status()).toBe(${frame.status});\n});`;
  }

  function copyTextSafe(text, label) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast(label)).catch(() => fallbackCopy(text, label));
      } else {
        fallbackCopy(text, label);
      }
    } catch {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    showToast(label);
  }

  function formatJsonSafe(raw) {
    if (!raw) return '';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stepFrame(delta) {
    const frames = getFilteredFrames();
    if (!frames.length) return;
    const idx = frames.findIndex((f) => f.id === state.selectedFrameId);
    const nextIdx = Math.min(frames.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + delta));
    const target = frames[nextIdx];
    if (target) {
      state.selectedFrameId = target.id;
      state.playheadMs = target.offsetMs;
      renderAll();
    }
  }

  function togglePlayback() {
    state.isPlaying = !state.isPlaying;
    if (state.isPlaying) {
      const cassette = getActiveCassette();
      const span = computeSpanMs(cassette);
      if (state.playheadMs >= span) state.playheadMs = 0;
      lastTickTs = performance.now();
      const tick = (now) => {
        if (!state.isPlaying) return;
        const dt = (now - lastTickTs) * state.playbackSpeed;
        lastTickTs = now;
        state.playheadMs += dt;
        const currentSpan = computeSpanMs(getActiveCassette());

        // Auto-select latest frame crossed by playhead
        const crossed = getActiveCassette().frames.filter((f) => f.offsetMs <= state.playheadMs);
        if (crossed.length) {
          state.selectedFrameId = crossed[crossed.length - 1].id;
        }

        if (state.playheadMs >= currentSpan) {
          state.playheadMs = currentSpan;
          state.isPlaying = false;
          renderAll();
          return;
        }
        renderTimelineCanvas();
        renderRuler();
        renderFrameTable();
        renderInspectorPane();
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    renderHeaderBar();
  }

  function toggleLiveTrafficSimulation() {
    state.isLiveRecording = !state.isLiveRecording;
    if (liveIntervalId) {
      clearInterval(liveIntervalId);
      liveIntervalId = null;
    }

    if (state.isLiveRecording) {
      const endpoints = [
        { method: 'GET', path: '/v2/catalog/sku/HW-LOGIC-16/stock', status: 200, baseMs: 28 },
        { method: 'POST', path: '/v2/cart/crt_88219a/voucher', status: 422, baseMs: 64 },
        { method: 'GET', path: '/v2/rates/fx?pair=SGD-USD', status: 200, baseMs: 19 },
        { method: 'POST', path: '/v2/webhooks/stripe/ack', status: 202, baseMs: 45 },
        { method: 'POST', path: '/v2/payments/intent/verify', status: 503, baseMs: 480 }
      ];

      liveIntervalId = setInterval(() => {
        const cassette = getActiveCassette();
        const sample = endpoints[Math.floor(Math.random() * endpoints.length)];
        const seq = cassette.frames.length + 1;
        const lastEnd = cassette.frames.length
          ? Math.max(...cassette.frames.map((f) => f.offsetMs + f.durationMs))
          : 0;
        const offsetMs = Math.round(lastEnd + 35);
        const jitter = Math.round((Math.random() * 24 - 8) * 10) / 10;
        const durationMs = Math.max(8, sample.baseMs + jitter);

        const newFrame = {
          id: `frm_${String(seq).padStart(4, '0')}`,
          seq,
          protocol: 'HTTP/2',
          method: sample.method,
          path: sample.path,
          host: cassette.targetHost,
          status: sample.status,
          offsetMs,
          durationMs,
          fingerprint: Math.random().toString(16).slice(2, 18),
          timings: {
            dnsMs: 0,
            tcpMs: 0,
            tlsMs: 0,
            ttfbMs: Math.round(durationMs * 0.85 * 10) / 10,
            transferMs: Math.round(durationMs * 0.15 * 10) / 10,
            totalMs: durationMs
          },
          request: {
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer [REDACTED:eyJh…len=152]',
              'x-live-capture': 'true'
            },
            body: sample.method === 'POST' ? JSON.stringify({ seq, ts: new Date().toISOString(), probe: 'live-proxy' }) : '',
            sizeBytes: sample.method === 'POST' ? 64 : 0
          },
          response: {
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              ok: sample.status < 400,
              status: sample.status,
              frame_seq: seq,
              captured_at_ms: offsetMs
            }),
            sizeBytes: 82
          },
          wsFrames: [],
          tags: ['live-stream']
        };

        cassette.frames.push(newFrame);
        state.windowEndMs = computeSpanMs(cassette);
        state.playheadMs = newFrame.offsetMs + newFrame.durationMs;
        state.selectedFrameId = newFrame.id;
        renderAll();
      }, 1100);

      showToast('LIVE PROXY STREAM SIMULATION STARTED (APPENDING FRAMES EVERY 1.1S)');
    } else {
      showToast('LIVE PROXY STREAM PAUSED');
    }
    renderHeaderBar();
  }

  function exportActiveCassette() {
    const cassette = getActiveCassette();
    const blob = new Blob([JSON.stringify(cassette, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cassette.id}.chronicle.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`EXPORTED ${cassette.id}.chronicle.json`);
  }

  function renderAll() {
    renderHeaderBar();
    renderRuler();
    renderTimelineCanvas();
    renderFrameTable();
    renderInspectorPane();
  }

  function bindEvents() {
    const selEl = document.getElementById('cassette-select');
    if (selEl) {
      selEl.addEventListener('change', (e) => {
        state.activeCassetteIdx = Number(e.target.value) || 0;
        const c = getActiveCassette();
        state.windowStartMs = 0;
        state.windowEndMs = computeSpanMs(c);
        state.selectedFrameId = c.frames[0]?.id || null;
        state.playheadMs = c.frames[0]?.offsetMs || 0;
        renderAll();
      });
    }

    document.getElementById('btn-play-toggle')?.addEventListener('click', togglePlayback);
    document.getElementById('btn-step-prev')?.addEventListener('click', () => stepFrame(-1));
    document.getElementById('btn-step-next')?.addEventListener('click', () => stepFrame(1));
    document.getElementById('btn-live-sim')?.addEventListener('click', toggleLiveTrafficSimulation);
    document.getElementById('btn-export-cassette')?.addEventListener('click', exportActiveCassette);

    document.getElementById('speed-select')?.addEventListener('change', (e) => {
      state.playbackSpeed = Number(e.target.value) || 1.0;
    });

    // Import JSON file
    const fileInput = document.getElementById('cassette-file-input');
    document.getElementById('btn-import-cassette')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!Array.isArray(parsed.frames)) throw new Error('Missing frames array');
          state.cassettes.unshift(parsed);
          state.activeCassetteIdx = 0;
          state.windowStartMs = 0;
          state.windowEndMs = computeSpanMs(parsed);
          state.selectedFrameId = parsed.frames[0]?.id || null;
          showToast(`LOADED CASSETTE: ${parsed.title || file.name}`);
          renderAll();
        } catch (err) {
          showToast(`INVALID CASSETTE JSON: ${err.message}`);
        }
      };
      reader.readAsText(file);
    });

    // Timeline click/drag scrubbing
    const canvas = document.getElementById('timeline-canvas');
    if (canvas) {
      let dragging = false;
      const scrubAt = (clientX) => {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const cassette = getActiveCassette();
        const span = computeSpanMs(cassette);
        state.playheadMs = Math.round(ratio * span);

        // Snap selection to nearest frame at playhead
        let nearest = null;
        let minDist = Infinity;
        for (const f of cassette.frames) {
          const dist = Math.abs(f.offsetMs - state.playheadMs);
          if (dist < minDist) {
            minDist = dist;
            nearest = f;
          }
        }
        if (nearest) state.selectedFrameId = nearest.id;
        renderAll();
      };

      canvas.addEventListener('mousedown', (e) => {
        dragging = true;
        scrubAt(e.clientX);
      });
      window.addEventListener('mousemove', (e) => {
        if (dragging) scrubAt(e.clientX);
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
      });
    }

    // Filter buttons
    document.querySelectorAll('[data-filter-method]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filterMethod = btn.dataset.filterMethod;
        document.querySelectorAll('[data-filter-method]').forEach((b) => b.classList.toggle('active', b === btn));
        renderAll();
      });
    });

    document.querySelectorAll('[data-filter-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filterStatus = btn.dataset.filterStatus;
        document.querySelectorAll('[data-filter-status]').forEach((b) => b.classList.toggle('active', b === btn));
        renderAll();
      });
    });

    const searchEl = document.getElementById('search-filter-input');
    searchEl?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderAll();
    });

    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
      state.filterMethod = 'ALL';
      state.filterStatus = 'ALL';
      state.searchQuery = '';
      if (searchEl) searchEl.value = '';
      const c = getActiveCassette();
      state.windowStartMs = 0;
      state.windowEndMs = computeSpanMs(c);
      document.querySelectorAll('[data-filter-method]').forEach((b) => b.classList.toggle('active', b.dataset.filterMethod === 'ALL'));
      document.querySelectorAll('[data-filter-status]').forEach((b) => b.classList.toggle('active', b.dataset.filterStatus === 'ALL'));
      renderAll();
    });

    // Frame table row selection
    document.getElementById('frame-table-body')?.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-frame-id]');
      if (!row) return;
      state.selectedFrameId = row.dataset.frameId;
      const frame = getSelectedFrame();
      if (frame) state.playheadMs = frame.offsetMs;
      renderAll();
    });

    // Inspector tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        renderInspectorPane();
      });
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        stepFrame(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepFrame(-1);
      } else if (e.key === '[') {
        e.preventDefault();
        stepFrame(-1);
      } else if (e.key === ']') {
        e.preventDefault();
        stepFrame(1);
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlayback();
      } else if (e.key === '/') {
        e.preventDefault();
        searchEl?.focus();
      }
    });

    window.addEventListener('resize', () => renderTimelineCanvas());
  }

  window.addEventListener('DOMContentLoaded', () => {
    const c = getActiveCassette();
    state.windowEndMs = computeSpanMs(c);
    bindEvents();
    renderAll();
  });
})();
