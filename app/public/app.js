// Demo console logic: scenario picker, simulated call loop, live verdict,
// LINE-style notification preview, history. Talks to /api + /ws only.
const $ = (id) => document.getElementById(id);
const state = { scripts: [], picked: null, call: null, verdict: null, lineIdx: 0, auto: false };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function speak(text) {
  if (!$('ttsToggle').checked || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'th-TH';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function renderScripts() {
  $('scripts').innerHTML = '';
  for (const s of state.scripts) {
    const b = document.createElement('button');
    b.className = 'script' + (state.picked?.id === s.id ? ' on' : '');
    b.dataset.exp = s.expected;
    b.innerHTML = `<b>${s.titleTh}<span class="tag ${s.expected}">${s.expected}</span></b><span>${s.titleEn} · ${s.lines.length} lines · ${s.callerPhone}</span>`;
    b.onclick = () => { state.picked = s; renderScripts(); };
    $('scripts').appendChild(b);
  }
}

function renderLines() {
  const box = $('scriptLines');
  box.innerHTML = '';
  const s = state.picked;
  if (!s || !state.call) { box.innerHTML = '<p class="muted">Start a call first.</p>'; return; }
  s.lines.forEach((line, i) => {
    const b = document.createElement('button');
    b.className = 'line';
    b.textContent = `${i + 1}. ${line}`;
    b.disabled = i < state.lineIdx || !state.call || state.auto;
    b.onclick = () => sendTurn(line);
    box.appendChild(b);
  });
}

function renderTranscript() {
  const box = $('transcript');
  box.innerHTML = '';
  if (!state.call || !state.call.turns.length) {
    box.innerHTML = '<p class="muted">Transcript will stream here turn by turn.</p>';
    return;
  }
  for (const t of state.call.turns) {
    const d = document.createElement('div');
    d.className = `bubble ${t.role}`;
    d.innerHTML = `<span class="who">${t.role === 'caller' ? 'Caller' : 'Krai-a AI'}</span>${escapeHtml(t.text)}`;
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

function renderVerdict() {
  const v = state.verdict;
  const box = $('verdict');
  if (!v) {
    box.className = 'verdict none';
    $('vBadge').textContent = '—';
    $('vConf').textContent = '';
    $('vReason').textContent = 'No call yet. Pick a scenario and press Start call.';
    $('vReasonEn').textContent = '';
    $('vSignals').innerHTML = '';
    return;
  }
  box.className = `verdict ${v.verdict}`;
  $('vBadge').textContent = v.verdict;
  $('vConf').textContent = `${Math.round((v.confidence || 0) * 100)}% · engine: ${v.engine || 'rules'}`;
  $('vReason').textContent = v.reason || '';
  $('vReasonEn').textContent = v.reasonEn || '';
  $('vSignals').innerHTML = (v.pressureSignals || []).map((s) => `<span>${escapeHtml(s)}</span>`).join('')
    + (v.matchesKnownScam ? '<span>matches-known-scam</span>' : '');
}

function renderNotify(payload) {
  const box = $('notify');
  if (!payload?.notify?.message) return;
  box.className = `notify ${payload.verdict.verdict}`;
  box.textContent = payload.notify.message.text
    + `\n\n— delivery: ${(payload.notify.results || []).map((r) => `${r.adapter}:${r.ok ? 'ok' : 'fail(' + r.detail + ')'}`).join(', ')}`;
}

function renderHistory(calls) {
  const box = $('history');
  if (!calls.length) { box.innerHTML = '<p class="muted">No calls yet.</p>'; return; }
  box.innerHTML = '';
  for (const c of calls.slice(0, 12)) {
    const d = document.createElement('div');
    d.className = 'hrow';
    d.innerHTML = `<span>${c.callerPhone} · ${c.turns.length} turns</span><b>${c.verdict ? c.verdict.verdict : '…'}</b>`;
    box.appendChild(d);
  }
}

function setCallActive(on) {
  $('startBtn').disabled = on;
  $('sendBtn').disabled = !on;
  $('autoBtn').disabled = !on;
  $('endBtn').disabled = !on;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function startCall() {
  if (!state.picked) { alert('Pick a scenario first.'); return; }
  const data = await api('/api/demo/call', {
    method: 'POST',
    body: JSON.stringify({ scriptId: state.picked.id }),
  });
  state.call = data.call;
  state.verdict = null;
  state.lineIdx = 0;
  state.auto = false;
  $('notify').className = 'notify empty';
  $('notify').innerHTML = '<p class="muted">Appears when the call ends.</p>';
  setCallActive(true);
  renderTranscript(); renderVerdict(); renderLines();
  speak(data.call.turns[0].text);
}

async function sendTurn(text) {
  if (!state.call) return;
  const data = await api('/api/demo/turn', {
    method: 'POST',
    body: JSON.stringify({ callId: state.call.id, text }),
  });
  state.call = data.call;
  state.verdict = data.verdict;
  state.lineIdx += 1;
  renderTranscript(); renderVerdict(); renderLines();
  if (data.ended) {
    finishCall(data);
  } else if (data.reply) {
    speak(data.reply);
  }
}

async function endCall() {
  if (!state.call) return;
  state.auto = false;
  const data = await api('/api/demo/end', {
    method: 'POST',
    body: JSON.stringify({ callId: state.call.id }),
  });
  state.call = data.call;
  state.verdict = data.verdict;
  renderTranscript(); renderVerdict();
  finishCall(data);
}

function finishCall(data) {
  renderNotify(data);
  if (data.call?.id) {
    const a = document.createElement('a');
    a.href = `/api/demo/export/${data.call.id}`;
    a.textContent = 'ดาวน์โหลดหลักฐานแจ้งความ (JSON)';
    a.style.display = 'block';
    a.style.marginTop = '8px';
    $('notify').appendChild(a);
  }
  speak(data.verdict.closingLine);
  refreshHistory();
  state.call = null;
  state.auto = false;
  setCallActive(false);
  renderLines();
}

async function autoPlay() {
  if (!state.call || !state.picked) return;
  state.auto = true;
  renderLines();
  while (state.auto && state.call && state.lineIdx < state.picked.lines.length) {
    await new Promise((r) => setTimeout(r, 1400));
    if (!state.auto || !state.call) break;
    try {
      await sendTurn(state.picked.lines[state.lineIdx]);
    } catch (e) { state.auto = false; break; }
  }
  state.auto = false;
}

async function refreshHistory() {
  try {
    const data = await api('/api/calls');
    renderHistory(data.calls);
  } catch { /* ignore */ }
}

async function init() {
  $('startBtn').onclick = startCall;
  $('endBtn').onclick = endCall;
  $('autoBtn').onclick = autoPlay;
  $('sendBtn').onclick = () => {
    const v = $('freeText').value.trim();
    if (v) { $('freeText').value = ''; sendTurn(v); }
  };
  $('freeText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sendBtn').click();
  });
  try {
    const [status, scripts] = await Promise.all([
      api('/api/status'),
      api('/api/demo/scripts'),
    ]);
    state.scripts = scripts.scripts;
    state.picked = scripts.scripts[0];
    renderScripts();
    const live = status.engine === 'gemini';
    $('status').className = 'status-pill ' + (live ? 'live' : 'mock');
    $('statusText').textContent = live ? `LIVE · ${status.model}` : 'MOCK · rules engine (no key)';
    const engineFoot = $('engineFoot');
    if (engineFoot) engineFoot.textContent = live ? `Gemini ${status.model}` : 'rules fallback — set GEMINI_API_KEY for live AI';
  } catch (e) {
    $('statusText').textContent = 'server unreachable';
  }
  refreshHistory();
  // Live updates socket (multi-viewer: judges can watch on a second screen).
  try {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'call-update' && msg.call) {
        if (!state.call || msg.call.id === state.call.id) {
          state.call = msg.ended ? state.call : msg.call;
          if (msg.verdict) { state.verdict = msg.verdict; renderVerdict(); }
          renderTranscript();
          if (msg.ended) { finishCall(msg); }
        }
        refreshHistory();
      }
    };
  } catch { /* polling fallback already in place */ }
}

init();
