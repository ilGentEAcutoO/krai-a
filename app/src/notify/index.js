// Owner alerts: one message builder, two faces — plain text for the console
// adapter (and LINE altText fallback), cute Flex bubble for LINE push.
import { config } from '../config.js';
import { quotaSummary, AUTO_TOPUP_DEFAULT_THRESHOLD } from '../store.js';

const consoleAdapter = {
  name: 'console',
  async send({ to, message }) {
    console.log(`[notify:console → ${to}]\n${message.text}`);
    return { ok: true, adapter: 'console', detail: 'logged' };
  },
};

const lineAdapter = {
  name: 'line',
  async send({ to, message, flex }) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.lineChannelAccessToken}`,
      },
      body: JSON.stringify({
        to,
        messages: [{ type: 'flex', altText: message.text.slice(0, 400), contents: flex }],
      }),
    });
    if (!res.ok) throw new Error(`line ${res.status}`);
    return { ok: true, adapter: 'line', detail: `pushed to ${to}` };
  },
};

const ADAPTERS = { console: consoleAdapter, line: lineAdapter };

export function buildMessage({ call, member, verdict }) {
  const color = verdict.verdict === 'SCAM' ? '🔴' : verdict.verdict === 'LEGIT' ? '🟢' : '🟡';
  const label = verdict.verdict === 'SCAM' ? 'สายต้องสงสัย (ตัดสายแล้ว)' : verdict.verdict === 'LEGIT' ? 'คนจริง (ฝากข้อความ)' : 'ไม่ชัวร์ (รอคุณตัดสิน)';
  const lines = [
    `${color} ใครอ่ะรับสายให้แล้ว! ${label}`,
    `จาก: ${call.callerPhone} → เบอร์คุณ`,
    `เหตุผล: ${verdict.reason}`,
    `EN: ${verdict.reasonEn || '-'}`,
    `ความมั่นใจ: ${Math.round((verdict.confidence || 0) * 100)}% (engine: ${verdict.engine || 'rules'})`,
    `คลิปเสียง: ${call.turns.length} เทิร์น · ${call.minutesBilled || 1} นาที`,
  ];
  if (member.familyWatchers?.length) lines.push(`สำเนาถึงผู้ดูแล: ${member.familyWatchers.join(', ')}`);
  lines.push('💛 ใครอ่ะกันมิจให้ทุกวัน');
  return { text: lines.join('\n'), label, color };
}

// Cute Flex bubble: pastel header per verdict, big caller number, reason,
// confidence + tape stats, optional dashboard button. Wording stays
// suspicion-safe (PDPA): never a definitive "scammer" label.
export function buildFlexMessage({ call, member, verdict }) {
  const themes = {
    SCAM: { bg: '#FFF1F1', bar: '#E5484D', emoji: '🛡️', title: 'สายต้องสงสัย!', sub: 'ไม่ต้องห่วงนะ ใครอ่ะรับให้แล้ว ตัดสายเรียบร้อย~' },
    LEGIT: { bg: '#EDFBF3', bar: '#0E9D80', emoji: '💚', title: 'คนจริงโทรมา!', sub: 'ฝากข้อความไว้ให้แล้วจ้า โทรกลับได้เลย~' },
    UNSURE: { bg: '#FFF8E1', bar: '#C07F00', emoji: '🤔', title: 'ยังไม่ชัวร์!', sub: 'ใครอ่ะไม่ชัวร์ ช่วยดูหน่อยน้า~' },
  };
  const theme = themes[verdict.verdict] || themes.UNSURE;
  const conf = Math.round((verdict.confidence || 0) * 100);
  const body = [
    { type: 'text', text: `📞 ${call.callerPhone}`, weight: 'bold', size: 'xl', wrap: true },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: `💬 ${verdict.reason}`, wrap: true, size: 'sm', color: '#333333', margin: 'md' },
    { type: 'text', text: `🎯 มั่นใจ ${conf}% · ${verdict.engine || 'rules'}`, size: 'xs', color: '#888888', margin: 'md' },
    { type: 'text', text: `🎙️ ${call.turns.length} เทิร์น · ${call.minutesBilled || 1} นาที`, size: 'xs', color: '#888888' },
  ];
  if (member.familyWatchers?.length) {
    body.push({ type: 'text', text: `👀 สำเนาถึงผู้ดูแล ${member.familyWatchers.length} คน`, size: 'xs', color: '#888888' });
  }
  const footer = [{ type: 'text', text: 'ใครอ่ะ 💛 กันมิจให้ทุกวัน', size: 'xs', color: '#AAAAAA', align: 'center' }];
  if (config.publicBaseUrl) {
    footer.unshift({
      type: 'button', style: 'primary', color: theme.bar, margin: 'sm',
      action: { type: 'uri', label: 'เปิดดูในใครอ่ะ', uri: `${config.publicBaseUrl}/dashboard.html` },
    });
  }
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: theme.bg, paddingAll: '16px',
      contents: [
        { type: 'text', text: `${theme.emoji} ใครอ่ะ ${theme.title}`, weight: 'bold', size: 'lg', color: theme.bar, wrap: true },
        { type: 'text', text: theme.sub, size: 'sm', color: '#666666', margin: 'xs', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer },
  };
}

// ---- quota-low warning ("warn before quota runs out", per pricing FAQ) ----
// Fired from every call-end path after consumeMinutes(). Protection never
// cuts past quota (spec) — the alert nudges a topup instead. Once per
// billing period (member.quotaWarnedPeriod), auto-topup members get the
// reassuring variant, everyone else gets the top-up prompt. Never throws.
export function buildQuotaLowMessage({ quota }) {
  const auto = quota?.autoTopup || {};
  const autoCharged = auto.enabled && quota.payMethod === 'card';
  let reset = '';
  try {
    reset = new Date(quota.resetAt).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  } catch { reset = ''; }
  const lines = [
    `🟡 โควตาใครอ่ะใกล้หมดแล้ว — เหลือ ${quota.remaining}/${quota.quota} นาที · ${quota.callsRemaining} สาย${reset ? ` (รีเซ็ต ${reset})` : ''}`,
    autoCharged
      ? 'เปิดเติมอัตโนมัติไว้แล้ว — ระบบจะชาร์จบัตรที่บันทึกไว้ให้เอง (หรือกดชาร์จเลยใน LINE)'
      : 'เติมแพ็กเสริมใน LINE หรือห้องของฉันได้เลย — แพ็กไม่หมดอายุ ใช้ได้จนกว่าจะหมด',
    'EN: Quota running low — top up to keep screening every call.',
    '💛 ใครอ่ะกันมิจให้ทุกวัน',
  ];
  return { text: lines.join('\n') };
}

export function buildQuotaLowFlex({ quota }) {
  const bar = '#C07F00';
  const auto = quota?.autoTopup || {};
  const hint = auto.enabled && quota.payMethod === 'card'
    ? 'เติมอัตโนมัติเปิดอยู่ — เดี๋ยวระบบชาร์จบัตรให้เองน้า~'
    : 'เติมแพ็กเสริมได้เลย — แพ็กไม่หมดอายุน้า~';
  const body = [
    { type: 'text', text: `⏳ เหลือ ${quota.remaining}/${quota.quota} นาที · ${quota.callsRemaining} สาย`, weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: hint, wrap: true, size: 'sm', color: '#333333', margin: 'md' },
  ];
  const footer = [{ type: 'text', text: 'ใครอ่ะ 💛 กันมิจให้ทุกวัน', size: 'xs', color: '#AAAAAA', align: 'center' }];
  if (config.publicBaseUrl) {
    footer.unshift({
      type: 'button', style: 'primary', color: bar, margin: 'sm',
      action: { type: 'uri', label: 'เปิดห้องของฉัน', uri: `${config.publicBaseUrl}/dashboard.html` },
    });
  }
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#FFF8E1', paddingAll: '16px',
      contents: [
        { type: 'text', text: '🟡 ใครอ่ะ โควต้าใกล้หมด!', weight: 'bold', size: 'lg', color: bar, wrap: true },
        { type: 'text', text: 'ยังกันมิจให้ต่อ ไม่ตัดการป้องกันน้า', size: 'sm', color: '#666666', margin: 'xs', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer },
  };
}

export async function maybeNotifyQuotaLow(member) {
  try {
    if (!member) return { warned: false, reason: 'unknown-member' };
    const q = quotaSummary(member);
    const threshold = q.autoTopup.enabled ? q.autoTopup.threshold : AUTO_TOPUP_DEFAULT_THRESHOLD;
    const callsLowAt = Math.max(1, Math.round(threshold / 2));
    const low = q.remaining <= threshold || q.callsRemaining <= callsLowAt;
    if (!low) return { warned: false, reason: 'quota-healthy' };
    if (member.quotaWarnedPeriod === q.period) return { warned: false, reason: 'already-warned' };
    const message = buildQuotaLowMessage({ member, quota: q });
    const flex = buildQuotaLowFlex({ member, quota: q });
    const to = member.lineUserId || config.lineDefaultTo || member.ownerPhone;
    const results = [];
    for (const name of config.notifyAdapters) {
      const adapter = ADAPTERS[name];
      if (!adapter) continue;
      try {
        results.push(await adapter.send({ to, message, flex }));
      } catch (e) {
        results.push({ ok: false, adapter: name, detail: e.message });
      }
    }
    member.quotaWarnedPeriod = q.period;
    return { warned: true, results, quota: q };
  } catch (e) {
    return { warned: false, reason: 'notify-failed', detail: e.message };
  }
}

export async function notifyOwner({ call, member, verdict }) {
  const message = buildMessage({ call, member, verdict });
  const flex = buildFlexMessage({ call, member, verdict });
  const to = member.lineUserId || config.lineDefaultTo || member.ownerPhone;
  const recipients = [to, ...(member.familyWatchers || [])];
  const results = [];
  // Owner-only: PDPA-sensitive verdicts go to the single owner line.
  // Family watchers stay listed in the message, never messaged directly.
  for (const name of config.notifyAdapters) {
    const adapter = ADAPTERS[name];
    if (!adapter) continue;
    try {
      for (const toOne of recipients.slice(0, 1)) {
        results.push(await adapter.send({ to: toOne, message, flex }));
      }
    } catch (e) {
      results.push({ ok: false, adapter: name, detail: e.message });
    }
  }
  return { message, flex, results };
}
