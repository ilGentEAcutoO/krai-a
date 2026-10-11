// Demo console logic: scenario picker, simulated call loop, live verdict,
// LINE-style notification preview, history. Talks to /api + /ws only.
// Bilingual dynamic strings via the shared `krai-a_lang` key (see site.js);
// re-renders on the `krai-a:lang` event.
const $ = (id) => document.getElementById(id);
const state = { scripts: [], picked: null, call: null, verdict: null, lineIdx: 0, auto: false, budget: null };

const lang = () => (localStorage.getItem('krai-a_lang') === 'en' ? 'en' : 'th');
const STR = {
  budgetLine: { th: 'งบสายนี้ %C% · ใช้ไป %U% นาที · สูงสุด %M% เทิร์น', en: 'This call budget: %C% · used %U% min · max %M% turns' },
  unlimited: { th: 'ไม่จำกัด', en: 'unlimited' },
  min: { th: '%N% นาที', en: '%N% min' },
  errRate: { th: 'คนลองเยอะ — demo เต็มโควตาชั่วโมงนี้ ลองใหม่ในอีกสักพัก', en: 'Busy — the demo quota for this hour is full, try again later' },
  errCaptchaBlocked: { th: 'โหลดตัวกันบอทไม่ได้ — ถ้าเปิด adblock อยู่ ปิดแล้วลองใหม่', en: "Couldn't load the bot check — disable adblock and retry" },
  errCaptchaBot: { th: 'โดนมองว่าเป็นบอท — ลองใหม่ในอีกสักพัก', en: 'Flagged as a bot — try again later' },
  errStart: { th: 'เริ่มสายไม่ได้ — ', en: "Couldn't start the call — " },
  startFirst: { th: 'เริ่มสายก่อน', en: 'Start a call first.' },
  transcriptEmpty: { th: 'บทสนทนาจะไหลมาทีละเทิร์น', en: 'Transcript will stream here turn by turn.' },
  caller: { th: 'ปลายสาย', en: 'Caller' },
  kraiAi: { th: 'Krai-a AI', en: 'Krai-a AI' },
  noCallYet: { th: 'ยังไม่มีสาย — เลือกสคริปต์แล้วกดเริ่มสาย', en: 'No call yet. Pick a scenario and press Start call.' },
  micListening: { th: 'กำลังฟัง… แตะเพื่อหยุด', en: 'Listening… tap to stop' },
  micTap: { th: 'กดแล้วพูด', en: 'Tap and talk' },
  micBlocked: { th: 'ไมค์ถูกบล็อก — อนุญาตไมค์ในเบราว์เซอร์ก่อน', en: 'Mic blocked — allow microphone access first' },
  micError: { th: 'ไมค์ขัดข้อง — %E% (ลองพิมพ์แทน)', en: 'Mic error — %E% (try typing instead)' },
  replacedStale: { th: 'มีสาย demo ค้างอยู่ — ตัดสายเก่าให้แล้ว', en: 'A stale demo call was hanging — ended it for you' },
  notifyEmpty: { th: 'ปรากฏเมื่อสายจบ', en: 'Appears when the call ends.' },
  pickFirst: { th: 'เลือกสคริปต์ก่อน', en: 'Pick a scenario first.' },
  sendFail: { th: 'ส่งไม่ได้ — ', en: 'Send failed — ' },
  endFail: { th: 'วางสายไม่ได้ — ', en: "Couldn't end the call — " },
  budgetCut: { th: 'งบสายนี้หมด — สรุปตามหลักฐานที่มี', en: 'Call budget spent — verdict kept from evidence so far' },
  idleTimeout: { th: 'สายเงียบนาน — ตัดสายให้แล้ว', en: 'Idle too long — call ended' },
  micNeedCall: { th: 'เริ่มสายก่อน', en: 'Start a call first' },
  voiceNoMic: { th: 'เบราว์เซอร์นี้ไม่รองรับไมค์ — ใช้ Chrome/Edge หรือพิมพ์แทน', en: 'This browser has no mic support — use Chrome/Edge or type instead' },
  voiceThai: { th: 'พูดภาษาไทย — AI ฟังแล้วตอบด้วยเสียง (แนะนำ Chrome/Edge)', en: 'Speak Thai — the AI listens and answers by voice (Chrome/Edge recommended)' },
  noHistory: { th: 'ยังไม่มีสาย', en: 'No calls yet.' },
  turns: { th: 'เทิร์น', en: 'turns' },
  expSCAM: { th: 'มุกมิจ · ลุ้นให้แดง', en: 'Scam play · expect red' },
  expLEGIT: { th: 'คนปกติ · ลุ้นให้เขียว', en: 'Normal caller · expect green' },
  expUNSURE: { th: 'ก้ำกึ่ง · ลุ้นให้เหลือง', en: 'Borderline · expect yellow' },
  notifyHead: { th: 'LINE → เจ้าของ', en: 'LINE → owner' },
  delivery: { th: 'ส่งผ่าน', en: 'delivery' },
};
const t = (k) => STR[k][lang()];

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      if (j?.error) detail = ` ${j.error}`;
      if (j?.retryAfterSec) detail += ` (retry in ${j.retryAfterSec}s)`;
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return res.json();
}

function ttsEnabled() {
  return $('ttsToggle').checked || $('ttsToggleVoice').checked;
}

function speak(text, onend) {
  if (!ttsEnabled() || !('speechSynthesis' in window)) { if (onend) onend(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'th-TH';
  if (onend) { u.onend = onend; u.onerror = onend; }
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function notice(text) {
  $('callNotice').textContent = text || '';
}

function renderBudget(b) {
  state.budget = b || state.budget;
  const el = $('budgetLine');
  b = b || state.budget;
  if (!b) return;
  const cap = b.minutes == null ? t('unlimited') : t('min').replace('%N%', b.minutes);
  el.textContent = t('budgetLine').replace('%C%', cap).replace('%U%', b.elapsedMin).replace('%M%', b.turnsMax);
  const bar = $('budgetBar');
  if (bar) {
    const frac = b.minutes == null ? 0 : Math.min(1, (b.elapsedMin || 0) / b.minutes);
    bar.style.width = `${Math.round(frac * 100)}%`;
    bar.parentElement.classList.toggle('hot', frac >= 0.8);
  }
}

function startErrorMessage(e) {
  const m = String(e?.message || e);
  if (m.includes('demo-rate-limited')) return t('errRate') + (/retry in \d+s/.exec(m)?.[0] ? ` (${/retry in \d+s/.exec(m)[0]})` : '');
  if (m.includes('captcha-required')) return t('errCaptchaBlocked') + ' (CAPTCHA blocked)';
  if (m.includes('captcha-')) return t('errCaptchaBot') + ' (bot check failed)';
  return t('errStart') + m;
}

// ---- reCAPTCHA v3 (invisible): one token per demo start, verified server-side ----
const captcha = { siteKey: '', scriptLoading: null };
function loadRecaptcha() {
  if (!captcha.siteKey || window.grecaptcha) return Promise.resolve(!!window.grecaptcha);
  if (!captcha.scriptLoading) {
    captcha.scriptLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(captcha.siteKey)}`;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  return captcha.scriptLoading;
}
async function captchaToken(action) {
  if (!captcha.siteKey) return '';
  const loaded = await loadRecaptcha();
  if (!loaded || !window.grecaptcha) return '';
  try {
    await new Promise((resolve) => window.grecaptcha.ready(resolve));
    return await window.grecaptcha.execute(captcha.siteKey, { action });
  } catch { return ''; }
}

function renderScripts() {
  $('scripts').innerHTML = '';
  for (const s of state.scripts) {
    const b = document.createElement('button');
    b.className = 'script' + (state.picked?.id === s.id ? ' on' : '');
    b.dataset.exp = s.expected;
    const title = lang() === 'en' ? (s.titleEn || s.titleTh) : s.titleTh;
    b.innerHTML = `<b>${title}<span class="tag ${s.expected}">${s.expected}</span></b><span class="meta">${s.callerPhone} · ${s.lines.length} lines</span><span class="exp-label ${s.expected}">${t('exp' + s.expected)}</span>`;
    b.onclick = () => { state.picked = s; renderScripts(); };
    $('scripts').appendChild(b);
  }
}

function renderLines() {
  const box = $('scriptLines');
  box.innerHTML = '';
  const s = state.picked;
  if (!s || !state.call) { box.innerHTML = `<p class="muted">${t('startFirst')}</p>`; return; }
  s.lines.forEach((line, i) => {
    const b = document.createElement('button');
    b.className = 'line';
    b.textContent = `${i + 1}. ${line}`;
    b.disabled = i < state.lineIdx || !state.call || state.auto;
    b.onclick = () => { sendTurn(line).catch(() => {}); }; // sendTurn already shows the notice
    box.appendChild(b);
  });
}

function renderTranscript() {
  const box = $('transcript');
  box.innerHTML = '';
  if (!state.call || !state.call.turns.length) {
    box.innerHTML = `<p class="muted">${t('transcriptEmpty')}</p>`;
    return;
  }
  for (const tr of state.call.turns) {
    const d = document.createElement('div');
    d.className = `bubble ${tr.role}`;
    d.innerHTML = `<span class="who">${tr.role === 'caller' ? t('caller') : t('kraiAi')}</span>${escapeHtml(tr.text)}`;
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

function renderVerdict() {
  const v = state.verdict;
  const box = $('verdict');
  if (!v) {
    box.className = 'verdict none';
    box.dataset.v = '';
    $('vBadge').className = 'badge';
    $('vBadge').textContent = '—';
    $('vConf').textContent = '';
    $('vReason').textContent = t('noCallYet');
    $('vReasonEn').textContent = '';
    $('vSignals').innerHTML = '';
    const cb0 = $('vConfBar');
    if (cb0) cb0.style.width = '0';
    return;
  }
  const changed = box.dataset.v !== v.verdict;
  box.dataset.v = v.verdict;
  box.className = `verdict ${v.verdict}`;
  if (changed) { void box.offsetWidth; box.classList.add('pop'); }
  $('vBadge').className = `badge ${v.verdict}`;
  $('vBadge').textContent = v.verdict;
  const pct = Math.round((v.confidence || 0) * 100);
  $('vConf').textContent = `${pct}% · engine: ${v.engine || 'rules'}`;
  $('vReason').textContent = v.reason || '';
  $('vReasonEn').textContent = v.reasonEn || '';
  const cb = $('vConfBar');
  if (cb) cb.style.width = `${pct}%`;
  $('vSignals').innerHTML = (v.pressureSignals || []).map((s) => `<span>${escapeHtml(s)}</span>`).join('')
    + (v.matchesKnownScam ? '<span>matches-known-scam</span>' : '');
}

function renderNotify(payload) {
  const box = $('notify');
  if (!payload?.notify?.message) return;
  const v = payload.verdict.verdict;
  box.className = `notify ${v}`;
  box.innerHTML = `<div class="n-head"><span>${t('notifyHead')}</span><span class="badge ${v}">${v}</span></div>`
    + `<div class="n-body">${escapeHtml(payload.notify.message.text)}</div>`
    + `<div class="n-dlv">— ${t('delivery')}: ${escapeHtml((payload.notify.results || []).map((r) => `${r.adapter}:${r.ok ? 'ok' : 'fail(' + r.detail + ')'}`).join(', '))}</div>`;
}

function renderHistory(calls) {
  const box = $('history');
  if (!calls.length) { box.innerHTML = `<p class="muted">${t('noHistory')}</p>`; return; }
  box.innerHTML = '';
  for (const c of calls.slice(0, 12)) {
    const d = document.createElement('div');
    d.className = 'hrow';
    const vv = c.verdict ? c.verdict.verdict : '';
    d.innerHTML = `<span class="hdot ${vv}"></span><span>${c.callerPhone} · ${c.turns.length} ${t('turns')}</span><b>${vv || '…'}</b>`;
    box.appendChild(d);
  }
}

function setCallActive(on) {
  $('startBtn').disabled = on;
  $('sendBtn').disabled = !on;
  $('autoBtn').disabled = !on;
  $('endBtn').disabled = !on;
  $('vStartBtn').disabled = on;
  $('vEndBtn').disabled = !on;
  $('voiceSendBtn').disabled = !on;
  $('micBtn').disabled = !on || !voiceSupported();
}

function switchTab(name) {
  const voice = name === 'voice';
  $('tabScript').hidden = voice;
  $('tabVoice').hidden = !voice;
  $('tabBtnScript').classList.toggle('on', !voice);
  $('tabBtnVoice').classList.toggle('on', voice);
}

// ---- Voice chat (browser speech recognition, $0 — same /demo/* loop) ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceSupported = () => !!SR;
const mic = { rec: null, listening: false };

function setMicUI() {
  $('micBtn').classList.toggle('live', mic.listening);
  $('micLabel').textContent = mic.listening ? t('micListening') : t('micTap');
  if (!mic.listening) $('voiceInterim').textContent = '';
}

function startListening() {
  if (!voiceSupported() || mic.listening || !state.call) return;
  const rec = new SR();
  rec.lang = 'th-TH';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (ev) => {
    let interim = '', final = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) $('voiceInterim').textContent = interim;
    if (final.trim()) { sendTurn(final.trim()).catch(() => {}); } // sendTurn already shows the notice
  };
  rec.onerror = (ev) => {
    mic.listening = false;
    setMicUI();
    if (ev.error === 'not-allowed') notice(t('micBlocked'));
    else if (ev.error !== 'no-speech' && ev.error !== 'aborted') notice(t('micError').replace('%E%', ev.error));
  };
  rec.onend = () => { mic.listening = false; setMicUI(); };
  mic.rec = rec;
  mic.listening = true;
  setMicUI();
  try { rec.start(); } catch { mic.listening = false; setMicUI(); }
}

function stopListening() {
  try { mic.rec?.stop(); } catch { /* ignore */ }
  mic.listening = false;
  if ($('micBtn')) setMicUI();
}

function resumeVoice() {
  if ($('autoListen').checked && state.call) {
    setTimeout(() => { if (state.call) startListening(); }, 400);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function beginCall(data) {
  state.call = data.call;
  state.verdict = null;
  state.lineIdx = 0;
  state.auto = false;
  notice('');
  if (data.replacedCallId) notice(t('replacedStale'));
  $('notify').className = 'notify empty';
  $('notify').innerHTML = `<div class="n-head"><span>${t('notifyHead')}</span></div><div class="n-body"><p class="muted">${t('notifyEmpty')}</p></div>`;
  setCallActive(true);
  renderBudget(data.budget);
  renderTranscript(); renderVerdict(); renderLines();
  speak(data.call.turns[0].text, resumeVoice);
}

async function startCall() {
  if (!state.picked) { alert(t('pickFirst')); return; }
  try {
    const recaptchaToken = await captchaToken('demo_call');
    const data = await api('/api/demo/call', {
      method: 'POST',
      body: JSON.stringify({ scriptId: state.picked.id, ...(recaptchaToken ? { recaptchaToken } : {}) }),
    });
    beginCall(data);
  } catch (e) { notice(startErrorMessage(e)); }
}

async function startVoiceCall() {
  try {
    const recaptchaToken = await captchaToken('demo_call');
    const data = await api('/api/demo/call', {
      method: 'POST',
      body: JSON.stringify({ ...(recaptchaToken ? { recaptchaToken } : {}) }),
    });
    beginCall(data);
  } catch (e) { notice(startErrorMessage(e)); }
}

async function sendTurn(text) {
  if (!state.call) return;
  stopListening(); // mic must not hear the AI's own reply
  try {
    const data = await api('/api/demo/turn', {
      method: 'POST',
      body: JSON.stringify({ callId: state.call.id, text }),
    });
    state.call = data.call;
    state.verdict = data.verdict;
    state.lineIdx += 1;
    renderBudget(data.budget);
    renderTranscript(); renderVerdict(); renderLines();
    if (data.ended) {
      finishCall(data);
    } else if (data.reply) {
      speak(data.reply, resumeVoice);
    }
  } catch (e) {
    notice(t('sendFail') + e.message);
    throw e;
  }
}

async function endCall() {
  if (!state.call) return;
  state.auto = false;
  stopListening();
  try {
    const data = await api('/api/demo/end', {
      method: 'POST',
      body: JSON.stringify({ callId: state.call.id }),
    });
    state.call = data.call;
    state.verdict = data.verdict;
    renderBudget(data.budget);
    renderTranscript(); renderVerdict();
    finishCall(data);
  } catch (e) { notice(t('endFail') + e.message); }
}

function finishCall(data) {
  stopListening();
  renderNotify(data);
  speak(data.verdict.closingLine);
  refreshHistory();
  state.call = null;
  state.auto = false;
  setCallActive(false);
  renderLines();
  if (data?.endReason === 'budget') notice(t('budgetCut'));
  else if (data?.idleTimeout) notice(t('idleTimeout'));
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

function renderVoiceSupport() {
  $('voiceSupport').textContent = voiceSupported() ? t('voiceThai') : t('voiceNoMic');
}

async function init() {
  $('startBtn').onclick = startCall;
  $('endBtn').onclick = endCall;
  $('autoBtn').onclick = autoPlay;
  $('sendBtn').onclick = () => {
    const v = $('freeText').value.trim();
    if (v) { $('freeText').value = ''; sendTurn(v).catch(() => {}); }
  };
  $('freeText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sendBtn').click();
  });
  // Voice tab: same call loop, mic input.
  $('tabBtnScript').onclick = () => switchTab('script');
  $('tabBtnVoice').onclick = () => switchTab('voice');
  $('vStartBtn').onclick = startVoiceCall;
  $('vEndBtn').onclick = endCall;
  $('micBtn').onclick = () => {
    if (!state.call) { notice(t('micNeedCall')); return; }
    if (mic.listening) stopListening();
    else { notice(''); startListening(); }
  };
  $('voiceSendBtn').onclick = () => {
    const v = $('voiceText').value.trim();
    if (v) { $('voiceText').value = ''; sendTurn(v).catch(() => {}); }
  };
  $('voiceText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('voiceSendBtn').click();
  });
  // One TTS switch, two tabs: keep both checkboxes in sync.
  $('ttsToggle').addEventListener('change', (e) => { $('ttsToggleVoice').checked = e.target.checked; });
  $('ttsToggleVoice').addEventListener('change', (e) => { $('ttsToggle').checked = e.target.checked; });
  renderVoiceSupport();
  setMicUI();
  // Language switch re-renders every dynamic string (static ones via site.js).
  window.addEventListener('krai-a:lang', () => {
    renderBudget(); renderTranscript(); renderVerdict(); renderLines();
    renderScripts(); setMicUI(); renderVoiceSupport(); refreshHistory();
  });
  try {
    const [status, scripts] = await Promise.all([
      api('/api/status'),
      api('/api/demo/scripts'),
    ]);
    state.scripts = scripts.scripts;
    state.picked = scripts.scripts[0];
    captcha.siteKey = status.recaptchaSiteKey || '';
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
