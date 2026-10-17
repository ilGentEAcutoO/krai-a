#!/usr/bin/env node
// Live session timeline report (TASK-041/042).
//   node scripts/live-report.mjs <sessionDir> | --all <dir>
// Per session: timeline.html (two lanes, caller / AI, RMS bars over time,
// transcript at its time, markers for interrupted / CONTROL / verdicts /
// closing, talk-over highlighted red, plus analysis.json flags when present)
// and mix.wav (stereo: left = caller mic, right = AI at its modelled browser
// playback time) so the call can be heard as it happened. With --all, also
// <dir>/index.html listing every session with a summary table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeMetrics, loadSession, readWav, sessionArgs, WIN_MS } from './live-lib.mjs';

const PX_PER_S = 60;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} วิ`);
const x = (ms) => Math.round((ms / 1000) * PX_PER_S * 10) / 10;
const END_TH = { client: 'ผู้โทรวางสาย', idle: 'เงียบนาน', cap: 'หมดเวลา', scam: 'AI วางสาย (มิจ)', message: 'รับเรื่องแล้ววางสาย', error: 'ผิดพลาด' };
const VERDICT_TH = { SCAM: 'มิจ', LEGIT: 'สายจริง', UNSURE: 'ไม่แน่ใจ' };

// ---------- mix.wav ----------
export function writeMix(s) {
  const caller = readWav(path.join(s.dir, 'caller.wav'));
  const ai = readWav(path.join(s.dir, 'ai.wav'));
  const rate = 16000;
  const total = Math.ceil(((s.durationMs || 0) / 1000 + 1) * rate);
  const L = new Int16Array(total), R = new Int16Array(total);
  if (caller) {
    // window i of the recorder = the next 1600 samples, arriving at mic[i].t
    let off = 0;
    for (const w of s.mic) {
      const n = Math.round((w.ms / 1000) * rate);
      const at = Math.round((w.t / 1000) * rate);
      for (let k = 0; k < n && off + 2 * k + 1 < caller.data.length; k++) if (at + k < total) L[at + k] = caller.data.readInt16LE(off + 2 * k);
      off += n * 2;
    }
  }
  if (ai) {
    for (const g of s.segs) {
      const n = Math.round(((g.end - g.start) / 1000) * rate);
      const at = Math.round((g.start / 1000) * rate);
      const step = g.rate / rate;
      for (let k = 0; k < n; k++) {
        const pos = k * step, i = Math.floor(pos), f = pos - i;
        const a = g.offset + i * 2, b = a + 2;
        if (b + 1 >= ai.data.length || b >= g.offset + g.bytes) break;
        const v = ai.data.readInt16LE(a) * (1 - f) + ai.data.readInt16LE(b) * f;
        if (at + k < total) R[at + k] = Math.round(v);
      }
    }
  }
  const data = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) { data.writeInt16LE(L[i], i * 4); data.writeInt16LE(R[i], i * 4 + 2); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(s.dir, 'mix.wav'), Buffer.concat([h, data]));
}

const CSS = `
:root{color-scheme:light only;--ink:#1d2433;--mute:#667085;--line:#e4e7ec;--bg:#f7f8fa;--card:#fff;--caller:#2f6fde;--callerq:#b7cdf5;--ai:#14936b;--aiq:#a7dcc9;--red:#e5484d;--amber:#d97706;--violet:#7c4dff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Sarabun","Noto Sans Thai",system-ui,sans-serif}
header{padding:16px 20px 8px}h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mute);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:4px 20px 10px}.chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:13px}
.chip b{font-variant-numeric:tabular-nums}.chip.bad{border-color:#f5b5b7;background:#fff1f1}.chip.ok{border-color:#b7e4cf;background:#f0fbf6}
.player{display:flex;align-items:center;gap:12px;padding:0 20px 10px;flex-wrap:wrap}.player audio{width:420px;max-width:100%}.player small{color:var(--mute)}
.wrap{margin:0 20px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto;position:relative}
.tl{position:relative;height:430px;cursor:pointer}.tl svg{position:absolute;left:0;top:0}
.lab{position:sticky;left:0;z-index:5;width:0;height:0}.lab div{position:absolute;left:6px;font-size:11px;color:var(--mute);background:rgba(255,255,255,.85);padding:0 4px;border-radius:4px;white-space:nowrap}
.tx{position:absolute;font-size:12px;line-height:1.35;padding:3px 6px;border-radius:6px;border:1px solid var(--line);background:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx.c{border-color:var(--callerq)}.tx.a{border-color:var(--aiq)}.tx.bg{background:#fff7e6;border-color:#f3c77a}.tx.rep{background:#fff1f1;border-color:#f5b5b7}
.tag{display:inline-block;font-size:10px;font-weight:700;border-radius:4px;padding:0 4px;margin-right:4px;color:#fff}.tag.r{background:var(--red)}.tag.o{background:var(--amber)}.tag.g{background:#98a2b3}
.mk{position:absolute;font-size:11px;white-space:nowrap;padding:1px 5px;border-radius:4px;color:#fff}
.mk.ctl{background:var(--violet)}.mk.ver{background:#475467}.mk.ver.SCAM{background:var(--red)}.mk.ver.LEGIT{background:var(--ai)}.mk.clo{background:#101828}.mk.int{background:var(--amber)}.mk.err{background:var(--red)}
#ph{position:absolute;top:0;bottom:0;width:2px;background:#101828;pointer-events:none;z-index:4}
.legend{display:flex;gap:14px;flex-wrap:wrap;padding:8px 20px;color:var(--mute);font-size:12px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
section{padding:10px 20px}h2{font-size:15px;margin:10px 0 6px}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line);border-radius:8px;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f2f4f7;font-weight:600;white-space:nowrap}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap}tr.r td{background:#fff6f6}tr.o td{background:#fffaf0}
details{margin:6px 0}summary{cursor:pointer;color:var(--mute)}pre{white-space:pre-wrap;font-size:12px;background:#f2f4f7;padding:8px;border-radius:6px;max-height:300px;overflow:auto}
a{color:var(--caller)}
`;

function chip(label, value, cls = '') { return `<span class="chip ${cls}">${esc(label)} <b>${esc(value)}</b></span>`; }

function summaryChips(m, an) {
  const out = [
    chip('ความยาว', sec(m.durationMs)),
    chip('จบเพราะ', END_TH[m.endReason] || m.endReason),
    chip('ผลตัดสิน', VERDICT_TH[m.finalVerdict] || m.finalVerdict || '–'),
    chip('AI พูดทับ', `${sec(m.talkOverMs)} · ${m.talkOverCount} ครั้ง`, m.talkOverCount ? 'bad' : 'ok'),
    chip('AI ตอบหลังเงียบ (มัธยฐาน)', sec(m.responseLatencyMedianMs)),
    chip('ผู้โทรพูดแทรกจน AI หยุด', `${m.interruptedCount} ครั้ง`),
  ];
  if (an?.jev?.used) {
    const x = an.summary;
    out.push(chip('AI พูดซ้ำ', `${x.repeatCount}/${an.aiTurns.length} ประโยค`, x.repeatCount ? 'bad' : 'ok'));
    out.push(chip('เสียงรอบข้าง/ทีวี', `${x.backgroundCount}/${an.callerTurns.length} ท่อน`, x.backgroundCount ? 'bad' : ''));
    out.push(chip('ลาซ้ำตอนจบ', x.finalRepeat == null ? '–' : x.finalRepeat ? 'ซ้ำ' : 'ไม่ซ้ำ', x.finalRepeat ? 'bad' : 'ok'));
    out.push(chip('ได้ข้อมูลผู้โทร', `${x.slotsObtained}/4`, x.slotsObtained === 4 ? 'ok' : ''));
  } else {
    out.push(chip('Jev', an ? `ยังไม่ได้วิเคราะห์ (${an.jev?.error || 'off'})` : 'รัน live-analyze.mjs ก่อน'));
  }
  return out.join('');
}

export function renderTimeline(s, an) {
  const m = codeMetrics(s);
  const durMs = Math.max(s.durationMs, s.events.at(-1)?.t || 0, 1000);
  const W = x(durMs) + 160;
  // lane geometry (px)
  const Y = { mk: 8, callerTop: 64, callerH: 80, callerTx: 150, aiTop: 220, aiH: 80, aiTx: 306, axis: 400 };
  const peakRms = Math.max(0.05, ...s.mic.map((w) => w.rms), ...s.ai.map((w) => w.rms));
  const h = (rms, H) => Math.max(1, Math.sqrt(rms / peakRms) * H);
  const svg = [];
  // talk-over bands (behind the bars)
  for (const o of s.talkOver) svg.push(`<rect x="${x(o.start)}" y="${Y.callerTop - 6}" width="${Math.max(2, x(o.end) - x(o.start))}" height="${Y.aiTop + Y.aiH - Y.callerTop + 12}" fill="#e5484d" opacity=".16"><title>AI พูดทับ ${sec(o.end - o.start)}</title></rect>`);
  // caller lane
  const cBase = Y.callerTop + Y.callerH;
  svg.push(`<line x1="0" x2="${W}" y1="${cBase}" y2="${cBase}" stroke="#e4e7ec"/>`);
  for (const w of s.mic) {
    const hh = h(w.rms, Y.callerH);
    const fill = w.muted ? '#d0d5dd' : w.loud ? '#2f6fde' : '#b7cdf5';
    svg.push(`<rect x="${x(w.t)}" y="${cBase - hh}" width="${Math.max(1, x(w.ms) - 1)}" height="${hh}" fill="${fill}"/>`);
  }
  const fy = cBase - h(s.floor, Y.callerH);
  svg.push(`<line x1="0" x2="${W}" y1="${fy}" y2="${fy}" stroke="#2f6fde" stroke-dasharray="4 4" opacity=".6"><title>ระดับเสียงพื้นหลัง (noise floor) RMS ${s.floor.toFixed(4)}</title></line>`);
  // AI lane
  const aBase = Y.aiTop + Y.aiH;
  svg.push(`<line x1="0" x2="${W}" y1="${aBase}" y2="${aBase}" stroke="#e4e7ec"/>`);
  for (const g of s.segs) svg.push(`<rect x="${x(g.start)}" y="${aBase + 2}" width="${Math.max(1, x(g.end) - x(g.start))}" height="3" fill="${g.cut ? '#d97706' : '#14936b'}"/>`);
  for (const w of s.ai) {
    const hh = h(w.rms, Y.aiH);
    svg.push(`<rect x="${x(w.t)}" y="${aBase - hh}" width="${Math.max(1, x(w.ms) - 1)}" height="${hh}" fill="#14936b" opacity=".85"/>`);
  }
  // interrupted / closing lines across lanes
  for (const e of s.events) {
    if (e.type === 'interrupted') svg.push(`<line x1="${x(e.t)}" x2="${x(e.t)}" y1="${Y.callerTop - 10}" y2="${aBase + 8}" stroke="#d97706" stroke-width="2"/>`);
    if (e.type === 'closing-begin') svg.push(`<line x1="${x(e.t)}" x2="${x(e.t)}" y1="${Y.mk}" y2="${aBase + 8}" stroke="#101828" stroke-dasharray="3 3"/>`);
    if (e.type === 'turnComplete') svg.push(`<line x1="${x(e.t)}" x2="${x(e.t)}" y1="${Y.aiTop}" y2="${aBase}" stroke="#14936b" opacity=".35"><title>turnComplete ${sec(e.t)}</title></line>`);
  }
  // axis
  for (let t = 0; t <= durMs; t += 1000) {
    const major = t % 5000 === 0;
    svg.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${Y.axis}" y2="${Y.axis + (major ? 8 : 4)}" stroke="#98a2b3"/>`);
    if (major) svg.push(`<text x="${x(t) + 2}" y="${Y.axis + 20}" font-size="11" fill="#667085">${t / 1000}s</text>`);
  }

  // HTML overlays: markers + transcript boxes
  const html = [];
  const mkRows = [0, 0, 0]; // simple 3-row staggering for markers by x
  const marker = (t, cls, label, title) => {
    const px = x(t);
    let row = mkRows.findIndex((end) => end < px - 4);
    if (row < 0) row = 0;
    mkRows[row] = px + Math.min(220, label.length * 6.5 + 12);
    html.push(`<div class="mk ${cls}" style="left:${px}px;top:${Y.mk + row * 18}px" title="${esc(title)}">${esc(label)}</div>`);
  };
  for (const e of s.events) {
    if (e.type === 'control') marker(e.t, 'ctl', `CONTROL ${e.text.replace(/^⟦[^⟧]*⟧\s*/, '').slice(0, 26)}…`, e.text);
    else if (e.type === 'verdict') marker(e.t, `ver ${esc(e.verdict)}`, `${VERDICT_TH[e.verdict] || e.verdict} ${Math.round((e.confidence || 0) * 100)}%`, JSON.stringify({ engine: e.engine, signals: e.signals, latencyMs: e.latencyMs }));
    else if (e.type === 'action' && e.act !== 'continue') marker(e.t, 'clo', `สั่ง ${e.act}`, JSON.stringify(e));
    else if (e.type === 'closing-begin') marker(e.t, 'clo', `เริ่มปิดสาย: ${e.reason}`, JSON.stringify(e));
    else if (e.type === 'interrupted') marker(e.t, 'int', 'ผู้โทรพูดแทรก', 'interrupted: Gemini หยุดพูดเพราะได้ยินผู้โทร');
    else if (e.type === 'error' || e.type === 'upstream-close') marker(e.t, 'err', e.type, JSON.stringify(e));
  }
  const anAi = new Map((an?.aiTurns || []).map((t) => [t.index, t]));
  const anC = new Map((an?.callerTurns || []).map((t) => [t.index, t]));
  const boxes = (items, top, cls) => {
    const rows = [-1e9, -1e9];
    items.forEach((it) => {
      const px = x(it.t);
      let row = rows.findIndex((end) => end < px);
      if (row < 0) row = rows[0] <= rows[1] ? 0 : 1;
      const next = items.find((o) => x(o.t) > px + 20);
      const w = Math.max(120, Math.min(420, (next ? x(next.t) - px : 420) * 2 - 8));
      rows[row] = px + w;
      html.push(`<div class="tx ${cls} ${it.extra || ''}" style="left:${px}px;top:${top + row * 26}px;max-width:${w}px" title="${esc(it.title || it.text)}">${it.tag || ''}${esc(it.text)}</div>`);
    });
  };
  boxes(s.callerTurns.map((t) => {
    const a = anC.get(t.index);
    const bg = a?.addressed === 'BACKGROUND', un = a?.addressed === 'UNCLEAR';
    return { t: t.firstText, text: t.text, extra: bg ? 'bg' : '', tag: bg ? '<span class="tag o">ทีวี/รอบข้าง</span>' : un ? '<span class="tag g">ฟังไม่ชัด</span>' : '',
      title: `${t.text}${a?.probabilities ? `\nJev: ${JSON.stringify(a.probabilities)}` : ''}` };
  }), Y.callerTx, 'c');
  boxes(s.aiTurns.map((t) => {
    const a = anAi.get(t.index);
    return { t: t.playStart, text: t.text, extra: a?.repeat ? 'rep' : '',
      tag: `${a?.repeat ? '<span class="tag r">ซ้ำ</span>' : ''}${t.interrupted ? '<span class="tag o">ถูกตัด</span>' : ''}`,
      title: `${t.text}${a?.repeatP != null ? `\nJev: ซ้ำ p=${a.repeatP}` : ''}` };
  }), Y.aiTx, 'a');

  const labels = `<div class="lab"><div style="top:${Y.callerTop - 4}px">ผู้โทร (ไมค์)</div><div style="top:${Y.callerTx - 16}px">คำที่ผู้โทรพูด</div><div style="top:${Y.aiTop - 4}px">AI (เสียงที่เล่น)</div><div style="top:${Y.aiTx - 16}px">คำที่ AI พูด</div></div>`;

  const turnRows = [
    ...s.aiTurns.map((t) => ({ t: t.playStart, who: 'AI', text: t.text, a: anAi.get(t.index), ai: true, interrupted: t.interrupted })),
    ...s.callerTurns.map((t) => ({ t: t.firstText, who: 'ผู้โทร', text: t.text, a: anC.get(t.index) })),
  ].sort((p, q) => p.t - q.t).map((r) => {
    const flag = r.ai ? (r.a?.repeat ? `ซ้ำ (p=${r.a.repeatP})` : r.a?.repeatP != null ? `ไม่ซ้ำ (p=${r.a.repeatP})` : '') : (r.a?.addressed ? { ADDRESSED: 'พูดกับ AI', BACKGROUND: 'ทีวี/เสียงรอบข้าง', UNCLEAR: 'ฟังไม่ชัด' }[r.a.addressed] : '');
    const cls = r.ai && r.a?.repeat ? 'r' : !r.ai && r.a?.addressed === 'BACKGROUND' ? 'o' : '';
    return `<tr class="${cls}"><td class="n">${sec(r.t)}</td><td>${r.who}</td><td>${esc(r.text)}${r.interrupted ? ' <span class="tag o">ถูกตัด</span>' : ''}</td><td>${esc(flag)}</td></tr>`;
  }).join('');
  const slots = an?.jev?.used ? Object.entries(an.slots).map(([k, p]) => chip({ name: 'ชื่อ', organisation: 'หน่วยงาน', purpose: 'ธุระ', callback: 'เบอร์โทรกลับ' }[k], p >= 0.5 ? `ได้ (${p})` : `ไม่ได้ (${p})`, p >= 0.5 ? 'ok' : 'bad')).join('') : '';
  const setup = s.events.find((e) => e.type === 'setup')?.setup;
  const controls = s.controls.map((c) => `<tr><td class="n">${sec(c.t)}</td><td>${esc(c.text)}</td></tr>`).join('');
  const lat = s.latencies.map((l) => `${sec(l.ms)}`).join(', ') || '–';

  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<title>สาย ${esc(s.name)}</title><style>${CSS}</style></head><body>
<header><h1>สายทดสอบ ${esc(s.name)}</h1><div class="sub">ภาษา ${esc(s.lang)} · โมเดล ${esc(s.start.model || '?')} · <a href="../index.html">← ทุกสาย</a></div></header>
<div class="chips">${summaryChips(m, an)}</div>
<div class="player"><audio id="au" controls preload="auto" src="mix.wav"></audio><small>หูฟังซ้าย = ผู้โทร · ขวา = AI (จัดตามเวลาที่เบราว์เซอร์เล่นจริงโดยประมาณ) · คลิกที่เส้นเวลาเพื่อกระโดดไปฟัง · ไฟล์ดิบ <a href="caller.wav">caller.wav</a> · <a href="ai.wav">ai.wav</a></small></div>
<div class="wrap" id="wrap"><div class="tl" id="tl" style="width:${W}px">${labels}<svg width="${W}" height="430">${svg.join('')}</svg>${html.join('')}<div id="ph" style="left:0"></div></div></div>
<div class="legend"><span><i class="sw" style="background:#2f6fde"></i>ผู้โทรมีเสียงเกินพื้นหลัง</span><span><i class="sw" style="background:#b7cdf5"></i>เสียงเบา/พื้นหลัง</span><span><i class="sw" style="background:#d0d5dd"></i>ไมค์ถูกปิดเป็นเงียบ (ช่วงทักทาย/ปิดสาย)</span><span><i class="sw" style="background:#14936b"></i>AI พูด</span><span><i class="sw" style="background:#e5484d;opacity:.4"></i>AI พูดทับผู้โทร</span><span><i class="sw" style="background:#d97706"></i>ผู้โทรพูดแทรก (interrupted) / เสียง AI ที่ถูกตัด</span><span><i class="sw" style="background:#7c4dff"></i>คำสั่งระบบ CONTROL</span><span>เส้นประน้ำเงิน = ระดับเสียงพื้นหลัง</span></div>
<section><h2>บทสนทนา</h2>${slots ? `<div class="chips" style="padding:0 0 8px">${slots}</div>` : ''}<table><tr><th>เวลา</th><th>ใคร</th><th>ข้อความ</th><th>Jev</th></tr>${turnRows}</table>
<p class="sub">AI ตอบหลังผู้โทรหยุดพูด: ${lat} · ระดับเสียงพื้นหลัง RMS ${s.floor.toFixed(4)}${an?.jev?.used ? ` · Jev ${esc(an.jev.model)} ${an.jev.latencyMs} ms, ${an.jev.questions} คำถามในคำขอเดียว` : ''}</p>
<details><summary>คำสั่งระบบ (CONTROL) ${s.controls.length} ครั้ง</summary><table><tr><th>เวลา</th><th>ข้อความ</th></tr>${controls}</table></details>
<details><summary>ค่าตั้ง Gemini Live ตอนเริ่มสาย</summary><pre>${esc(JSON.stringify(setup, null, 2))}</pre></details></section>
<script>
const au=document.getElementById('au'),tl=document.getElementById('tl'),ph=document.getElementById('ph'),wrap=document.getElementById('wrap'),PX=${PX_PER_S};
tl.addEventListener('click',e=>{const r=tl.getBoundingClientRect();au.currentTime=Math.max(0,(e.clientX-r.left)/PX);au.play().catch(()=>{});});
function tick(){const px=au.currentTime*PX;ph.style.left=px+'px';if(!au.paused&&(px<wrap.scrollLeft+40||px>wrap.scrollLeft+wrap.clientWidth-80))wrap.scrollLeft=px-120;requestAnimationFrame(tick);}tick();
</script></body></html>`;
}

export function renderIndex(root, rows) {
  const tr = rows.map(({ name, m, an }) => {
    const x = an?.jev?.used ? an.summary : null;
    const bad = (v) => (v ? ' style="color:#c0262d;font-weight:600"' : '');
    return `<tr><td><a href="${esc(name)}/timeline.html">${esc(name)}</a></td><td>${esc(an?.lang || '')}</td><td class="n">${sec(m.durationMs)}</td><td>${esc(END_TH[m.endReason] || m.endReason)}</td><td>${esc(VERDICT_TH[m.finalVerdict] || m.finalVerdict || '–')}</td>`
      + `<td class="n"${bad(m.talkOverCount)}>${sec(m.talkOverMs)} · ${m.talkOverCount}</td><td class="n">${sec(m.responseLatencyMedianMs)}</td><td class="n">${m.interruptedCount}</td>`
      + `<td class="n"${bad(x?.repeatCount)}>${x ? `${x.repeatCount}/${an.aiTurns.length}` : '–'}</td><td class="n"${bad(x?.backgroundCount)}>${x ? `${x.backgroundCount}/${an.callerTurns.length}` : '–'}</td>`
      + `<td${bad(x?.finalRepeat)}>${x ? (x.finalRepeat == null ? '–' : x.finalRepeat ? 'ซ้ำ' : 'ไม่ซ้ำ') : '–'}</td><td class="n">${x ? `${x.slotsObtained}/4` : '–'}</td></tr>`;
  }).join('');
  const sum = (f) => rows.reduce((n, r) => n + (f(r) || 0), 0);
  const total = rows.length ? `<tr><th>รวม ${rows.length} สาย</th><th></th><th class="n">${sec(sum((r) => r.m.durationMs))}</th><th></th><th></th><th class="n">${sec(sum((r) => r.m.talkOverMs))} · ${sum((r) => r.m.talkOverCount)}</th><th></th><th class="n">${sum((r) => r.m.interruptedCount)}</th><th class="n">${sum((r) => r.an?.summary?.repeatCount)}</th><th class="n">${sum((r) => r.an?.summary?.backgroundCount)}</th><th class="n">${sum((r) => (r.an?.summary?.finalRepeat ? 1 : 0))}</th><th></th></tr>` : '';
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<title>สายทดสอบคุยสด</title><style>${CSS}</style></head><body>
<header><h1>สายทดสอบ "คุยกับ AI เอง" — ${rows.length} สาย</h1><div class="sub">โฟลเดอร์ ${esc(root)} · สร้างเมื่อ ${esc(new Date().toLocaleString('th-TH'))}</div></header>
<section><table><tr><th>สาย</th><th>ภาษา</th><th>ความยาว</th><th>จบเพราะ</th><th>ผลตัดสิน</th><th>AI พูดทับ (เวลา · ครั้ง)</th><th>AI ตอบช้า (มัธยฐาน)</th><th>พูดแทรก</th><th>AI พูดซ้ำ</th><th>ทีวี/รอบข้าง</th><th>ลาซ้ำ</th><th>ข้อมูลผู้โทร</th></tr>${tr}${total}</table>
<p class="sub">AI พูดทับ = ช่วงที่เสียง AI กำลังเล่นขณะไมค์ผู้โทรดังเกินระดับพื้นหลัง (คำนวณในโค้ด) · พูดซ้ำ / ทีวี / ลาซ้ำ / ข้อมูลผู้โทร = Jev ตัดสินจากคำถอดเสียง (คำขอเดียวต่อสาย) · สายที่ยังไม่รัน live-analyze.mjs จะขึ้น –</p></section></body></html>`;
}

export function reportSession(dir) {
  const s = loadSession(dir);
  const anFile = path.join(dir, 'analysis.json');
  const an = fs.existsSync(anFile) ? JSON.parse(fs.readFileSync(anFile, 'utf8')) : null;
  writeMix(s);
  fs.writeFileSync(path.join(dir, 'timeline.html'), renderTimeline(s, an));
  return { name: s.name, m: codeMetrics(s), an };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { root, dirs } = sessionArgs(argv);
  const rows = [];
  for (const dir of dirs) {
    try { rows.push(reportSession(dir)); console.log(path.join(dir, 'timeline.html')); } catch (e) { console.error(`${path.basename(dir)}: ${e.message}`); }
  }
  if (argv.includes('--all')) {
    fs.writeFileSync(path.join(root, 'index.html'), renderIndex(root, rows));
    console.log(path.join(root, 'index.html'));
  }
}
