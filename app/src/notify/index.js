// Owner alerts: one message builder, two faces — plain text for the console
// adapter (and LINE altText fallback), cute Flex bubble for LINE push.
import { config } from '../config.js';
import { quotaSummary } from '../store.js';
import { watcherLineIds } from '../household.js';
import { sendTextSms } from '../sms.js';
import { take } from '../ratelimit.js';

// Production logs are operator-readable: headline only, never the caller
// number, reason or LINE id.
const consoleAdapter = {
  name: 'console',
  async send({ to, message }) {
    if (process.env.NODE_ENV === 'production') console.log(`[notify:console] ${message.text.split('\n')[0]} (details hidden)`);
    else console.log(`[notify:console → ${to}]\n${message.text}`);
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

// Numbers read like the app: +66812220001 -> 081-222-0001, +6621002003 -> 02-100-2003.
export function prettyPhone(e164) {
  const local = String(e164 || '').replace(/^\+66/, '0');
  if (/^0[689]\d{8}$/.test(local)) return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  if (/^02\d{7}$/.test(local)) return `${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5)}`;
  return local;
}

// Who the call was for: central-number calls carry the protected phone they
// were forwarded from ("แม่ 089-000-0202"); the payer's own phone (or a
// mode A call without one) is "เบอร์คุณ".
const RELATION_TH = { mother: 'แม่', father: 'พ่อ', grandparent: 'ปู่ย่าตายาย', child: 'ลูก', partner: 'คู่ชีวิต', other: '' };
export function protectedName(call, member) {
  const p = call?.protectedPhone;
  if (!p || p === member?.ownerPhone) return 'เบอร์คุณ';
  const entry = (member?.protected || []).find((e) => e.phone === p);
  const rel = entry ? (RELATION_TH[entry.label] ?? String(entry.label || '').slice(0, 24)) : '';
  return `${rel ? `${rel} ` : ''}${prettyPhone(p)}`;
}

export function buildMessage({ call, member, verdict }) {
  const color = verdict.verdict === 'SCAM' ? '🔴' : verdict.verdict === 'LEGIT' ? '🟢' : '🟡';
  const label = verdict.verdict === 'SCAM' ? 'สายต้องสงสัย (ตัดสายแล้ว)' : verdict.verdict === 'LEGIT' ? 'คนจริง (ฝากข้อความ)' : 'ไม่ชัวร์ (รอคุณตัดสิน)';
  const lines = [
    `${color} ใครอะรับสายให้แล้ว! ${label}`,
    `จาก: ${prettyPhone(call.callerPhone)} → ${protectedName(call, member)}`,
    `เหตุผล: ${verdict.reason}`,
    `EN: ${verdict.reasonEn || '-'}`,
    `ความมั่นใจ: ${Math.round((verdict.confidence || 0) * 100)}% (engine: ${verdict.engine || 'rules'})`,
    `บทสนทนา: ${call.turns.length} เทิร์น · ${call.minutesBilled || 1} นาที`,
  ];
  // Count only: every recipient (watchers too) reads this text, and
  // watchers must not learn each other's phone numbers.
  if (member.familyWatchers?.length) lines.push(`สำเนาถึงผู้ดูแล ${member.familyWatchers.length} คน`);
  lines.push('💛 ใครอะกันมิจให้ทุกวัน');
  return { text: lines.join('\n'), label, color };
}

// Cute Flex bubble: pastel header per verdict, big caller number, reason,
// confidence + tape stats, optional dashboard button. Wording stays
// suspicion-safe (PDPA): never a definitive "scammer" label.
export function buildFlexMessage({ call, member, verdict }) {
  const themes = {
    SCAM: { bg: '#FFF1F1', bar: '#E5484D', emoji: '🛡️', title: 'สายต้องสงสัย!', sub: 'ไม่ต้องห่วงนะ ใครอะรับให้แล้ว ตัดสายเรียบร้อย~' },
    LEGIT: { bg: '#EDFBF3', bar: '#0E9D80', emoji: '💚', title: 'คนจริงโทรมา!', sub: 'ฝากข้อความไว้ให้แล้วจ้า โทรกลับได้เลย~' },
    UNSURE: { bg: '#FFF8E1', bar: '#C07F00', emoji: '🤔', title: 'ยังไม่ชัวร์!', sub: 'ใครอะไม่ชัวร์ ช่วยดูหน่อยน้า~' },
  };
  const theme = themes[verdict.verdict] || themes.UNSURE;
  const conf = Math.round((verdict.confidence || 0) * 100);
  const body = [
    { type: 'text', text: `📞 ${prettyPhone(call.callerPhone)}`, weight: 'bold', size: 'xl', wrap: true },
    { type: 'text', text: `ถึง ${protectedName(call, member)}`, size: 'sm', color: '#666666', wrap: true },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: `💬 ${verdict.reason}`, wrap: true, size: 'sm', color: '#333333', margin: 'md' },
    { type: 'text', text: `🎯 มั่นใจ ${conf}% · ${verdict.engine || 'rules'}`, size: 'xs', color: '#888888', margin: 'md' },
    { type: 'text', text: `💬 บทสนทนา ${call.turns.length} เทิร์น · ${call.minutesBilled || 1} นาที`, size: 'xs', color: '#888888' },
  ];
  if (member.familyWatchers?.length) {
    body.push({ type: 'text', text: `👀 สำเนาถึงผู้ดูแล ${member.familyWatchers.length} คน`, size: 'xs', color: '#888888' });
  }
  const footer = [{ type: 'text', text: 'ใครอะ 💛 กันมิจให้ทุกวัน', size: 'xs', color: '#AAAAAA', align: 'center' }];
  if (config.publicBaseUrl) {
    footer.unshift({
      type: 'button', style: 'primary', color: theme.bar, margin: 'sm',
      action: { type: 'uri', label: 'เปิดดูในใครอะ', uri: `${config.publicBaseUrl}/dashboard.html` },
    });
  }
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: theme.bg, paddingAll: '16px',
      contents: [
        { type: 'text', text: `${theme.emoji} ใครอะ ${theme.title}`, weight: 'bold', size: 'lg', color: theme.bar, wrap: true },
        { type: 'text', text: theme.sub, size: 'sm', color: '#666666', margin: 'xs', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer },
  };
}

// ---- who may receive a member's alerts (PDPA) ----
// A member's LINE alerts go only to LINE accounts linked by that member or
// their watchers — never to the operator's LINE_DEFAULT_TO. The one
// exception is the operator's own demo household (SEED_MEMBER_PHONE), whose
// owner IS the operator (phone-demo flow).
const isDemoHousehold = (m) => Boolean(m?.ownerPhone) && m.ownerPhone === config.seedMemberPhone;
const ownerLine = (m) => m?.lineUserId || (isDemoHousehold(m) ? config.lineDefaultTo : '');

const NUDGE_PER_HOUR = 60; // global SMS cost cap for link-LINE nudges

// One SMS per member, ever: "link LINE to get alerts". No caller data.
export async function maybeNudgeLineLink(m) {
  if (!m?.ownerPhone || ownerLine(m) || m.lineNudgedAt) return null;
  if (!take('sms:line-nudge', NUDGE_PER_HOUR, 3600000).ok) return { ok: false, adapter: 'sms-nudge', detail: 'rate-limited' };
  const where = config.publicBaseUrl ? ` ${config.publicBaseUrl}/dashboard.html` : ' ในแอปใครอะ';
  const sent = await sendTextSms(m.ownerPhone, `ใครอะรับสายแทนคุณแล้ว เชื่อม LINE เพื่อรับแจ้งเตือน${where}`).catch(() => ({ ok: false, detail: 'transport-error' }));
  if (sent.ok) m.lineNudgedAt = new Date().toISOString();
  return { ok: sent.ok, adapter: 'sms-nudge', detail: sent.ok ? 'sent' : sent.detail };
}

// console logs once; line pushes each recipient (one failure never skips
// the rest). No linked owner → nothing pushed, one nudge SMS instead.
async function deliver(member, lineTo, message, flex, { nudge = true } = {}) {
  const results = [];
  for (const name of config.notifyAdapters) {
    const adapter = ADAPTERS[name];
    if (!adapter) continue;
    const targets = name === 'line' ? lineTo : [lineTo[0] || 'owner'];
    if (name === 'line' && !targets.length) results.push({ ok: false, adapter: 'line', detail: 'not-linked' });
    for (const to of targets) {
      try {
        results.push(await adapter.send({ to, message, flex }));
      } catch (e) {
        results.push({ ok: false, adapter: name, detail: e.message });
      }
    }
  }
  if (nudge && config.notifyAdapters.includes('line') && !ownerLine(member)) {
    const sent = await maybeNudgeLineLink(member);
    if (sent) results.push(sent);
  }
  return results;
}

// ---- quota warnings (soft quota: screening never stops) ----
// Fired from every call-end path after consumeMinutes(). Two levels per
// billing period, once each (member.quotaAlerts): 'low' at 80% used (or the
// auto-topup threshold) and 'out' at 100%. Payer only — LINE if linked,
// else SMS — and never any caller data. Auto-topup card members get the
// reassuring variant, everyone else the top-up prompt. Never throws.
const pctOf = (quota) => Math.min(999, Math.floor((Number(quota?.usedPct) || 0) * 100));

export function buildQuotaLowMessage({ quota, level = 'low' }) {
  const auto = quota?.autoTopup || {};
  const autoCharged = auto.enabled && quota.payMethod === 'card';
  let reset = '';
  try {
    reset = new Date(quota.resetAt).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  } catch { reset = ''; }
  const head = level === 'out'
    ? `🔴 ใช้โควตาใครอะเดือนนี้ครบแล้ว — AI ยังรับสายให้ต่อ ไม่ตัดการป้องกัน${reset ? ` (รีเซ็ต ${reset})` : ''}`
    : `🟡 โควตาใครอะใกล้หมดแล้ว — ใช้ไปแล้ว ${pctOf(quota)}% · เหลือ ${quota.remaining}/${quota.quota} นาที · ${quota.callsRemaining} สาย${reset ? ` (รีเซ็ต ${reset})` : ''}`;
  const lines = [
    head,
    autoCharged
      ? 'เปิดเติมอัตโนมัติไว้แล้ว — ระบบจะชาร์จบัตรที่บันทึกไว้ให้เอง (หรือกดชาร์จเลยใน LINE)'
      : 'เติมแพ็กเสริมใน LINE หรือห้องของฉันได้เลย — แพ็กไม่หมดอายุ ใช้ได้จนกว่าจะหมด',
    level === 'out'
      ? 'EN: Monthly quota used up — screening continues; top up or upgrade.'
      : 'EN: Quota running low — top up to keep screening every call.',
    '💛 ใครอะกันมิจให้ทุกวัน',
  ];
  return { text: lines.join('\n') };
}

export function buildQuotaLowFlex({ quota, level = 'low' }) {
  const bar = '#C07F00';
  const auto = quota?.autoTopup || {};
  const hint = auto.enabled && quota.payMethod === 'card'
    ? 'เติมอัตโนมัติเปิดอยู่ — เดี๋ยวระบบชาร์จบัตรให้เองน้า~'
    : 'เติมแพ็กเสริมได้เลย — แพ็กไม่หมดอายุน้า~';
  const body = [
    { type: 'text', text: `⏳ เหลือ ${quota.remaining}/${quota.quota} นาที · ${quota.callsRemaining} สาย`, weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: hint, wrap: true, size: 'sm', color: '#333333', margin: 'md' },
  ];
  const footer = [{ type: 'text', text: 'ใครอะ 💛 กันมิจให้ทุกวัน', size: 'xs', color: '#AAAAAA', align: 'center' }];
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
        { type: 'text', text: level === 'out' ? '🔴 ใครอะ ใช้โควต้าครบแล้ว!' : '🟡 ใครอะ โควต้าใกล้หมด!', weight: 'bold', size: 'lg', color: bar, wrap: true },
        { type: 'text', text: 'ยังกันมิจให้ต่อ ไม่ตัดการป้องกันน้า', size: 'sm', color: '#666666', margin: 'xs', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer },
  };
}

const QUOTA_SMS_PER_HOUR = 100; // global SMS cost cap for quota warnings
const quotaSms = (level, quota) => {
  const url = `${config.publicBaseUrl || 'https://krai-a.com'}/dashboard.html`;
  return level === 'out'
    ? `ใครอะ: ใช้โควตาเดือนนี้ครบแล้ว AI ยังรับสายให้ต่อ ไม่ตัดการป้องกัน เติมแพ็กหรืออัปเกรดได้ที่ ${url}`
    : `ใครอะ: ใช้โควตาเดือนนี้ไปแล้ว ${pctOf(quota)}% AI ยังรับสายให้ต่อ เติมแพ็กได้ที่ ${url}`;
};

export async function maybeNotifyQuotaLow(member) {
  try {
    if (!member) return { warned: false, reason: 'unknown-member' };
    const q = quotaSummary(member);
    const auto = q.autoTopup;
    const autoLow = auto.enabled && (q.remaining <= auto.threshold || q.callsRemaining <= Math.max(1, Math.round(auto.threshold / 2)));
    const level = q.usedPct >= 1 ? 'out' : (q.usedPct >= 0.8 || autoLow) ? 'low' : null;
    if (!level) return { warned: false, reason: 'quota-healthy' };
    const alerts = member.quotaAlerts?.period === q.period ? member.quotaAlerts : { period: q.period };
    if (!member.quotaAlerts && member.quotaWarnedPeriod === q.period) alerts.low = alerts.low || 'legacy';
    if (alerts[level]) return { warned: false, reason: 'already-warned' };
    const at = new Date().toISOString();
    alerts[level] = at; // mark first: never twice
    if (level === 'out') alerts.low = alerts.low || at; // straight to 100%: one alert, not two
    member.quotaAlerts = alerts;
    member.quotaWarnedPeriod = q.period;
    const message = buildQuotaLowMessage({ member, quota: q, level });
    const flex = buildQuotaLowFlex({ member, quota: q, level });
    const results = await deliver(member, [ownerLine(member)].filter(Boolean), message, flex, { nudge: false });
    if (config.notifyAdapters.includes('line') && !ownerLine(member) && member.ownerPhone) {
      if (take('sms:quota', QUOTA_SMS_PER_HOUR, 3600000).ok) {
        const sent = await sendTextSms(member.ownerPhone, quotaSms(level, q)).catch(() => ({ ok: false, detail: 'transport-error' }));
        results.push({ ok: sent.ok, adapter: 'sms', detail: sent.ok ? 'sent' : sent.detail });
      } else {
        results.push({ ok: false, adapter: 'sms', detail: 'rate-limited' });
      }
    }
    return { warned: true, level, results, quota: q };
  } catch (e) {
    return { warned: false, reason: 'notify-failed', detail: e.message };
  }
}

export async function notifyOwner({ call, member, verdict }) {
  const message = buildMessage({ call, member, verdict });
  const flex = buildFlexMessage({ call, member, verdict });
  // Owner first, then family watchers who linked their OWN LINE (phone OTP
  // + LINE ID token = consent). Unlinked people get nothing pushed.
  const recipients = [...new Set([ownerLine(member), ...watcherLineIds(member)].filter(Boolean))];
  const results = await deliver(member, recipients, message, flex);
  return { message, flex, results };
}
