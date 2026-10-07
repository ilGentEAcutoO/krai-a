// Demo notifications: console only. Judges watch alerts land in the web
// console (/demo.html history + notify panel). LINE/SMS adapters live in
// krai-a-app (private) — this lean build stays keyless-runnable.
export function buildMessage({ call, member, verdict }) {
  const color = verdict.verdict === 'SCAM' ? '🔴' : verdict.verdict === 'LEGIT' ? '🟢' : '🟡';
  const label = verdict.verdict === 'SCAM' ? 'สายต้องสงสัย (ตัดสายแล้ว)' : verdict.verdict === 'LEGIT' ? 'คนจริง (ฝากข้อความ)' : 'ไม่ชัวร์ (รอคุณตัดสิน)';
  const lines = [
    `${color} ใครอ่ะ ${label}`,
    `จาก: ${call.callerPhone} → เบอร์คุณ`,
    `เหตุผล: ${verdict.reason}`,
    `EN: ${verdict.reasonEn || '-'}`,
    `ความมั่นใจ: ${Math.round((verdict.confidence || 0) * 100)}% (engine: ${verdict.engine || 'rules'})`,
    `คลิปเสียง: ${call.turns.length} เทิร์น · ${call.minutesBilled || 1} นาที`,
  ];
  if (member.familyWatchers?.length) lines.push(`สำเนาถึงผู้ดูแล: ${member.familyWatchers.join(', ')}`);
  return { text: lines.join('\n'), label, color };
}

const consoleAdapter = {
  name: 'console',
  async send({ to, message }) {
    console.log(`[notify:console → ${to}]\n${message.text}`);
    return { ok: true, adapter: 'console', detail: 'logged' };
  },
};

export async function notifyOwner({ call, member, verdict }) {
  const message = buildMessage({ call, member: member || {}, verdict });
  const results = [await consoleAdapter.send({ to: member?.ownerPhone || 'demo-owner', message })];
  return { message, results };
}
