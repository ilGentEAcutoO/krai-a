// Evidence export (AOC 1441 / police report bundle) + privacy notice text.
// Bundle = transcript + metadata + verdict/audit + sha256 integrity hash.
// Audio: Twilio <Record> not wired yet — recordingUrl stays null until then.
import { createHash } from 'node:crypto';
import { config } from './config.js';

export function buildEvidenceBundle(call) {
  if (!call) return null;
  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    call: {
      id: call.id,
      memberId: call.memberId,
      callerPhone: call.callerPhone,
      aiNumber: call.aiNumber,
      source: call.source,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      minutesBilled: call.minutesBilled || 0,
    },
    transcript: (call.turns || []).map((t) => ({ role: t.role, text: t.text, at: t.at })),
    verdict: call.verdict ? {
      verdict: call.verdict.verdict,
      confidence: call.verdict.confidence,
      engine: call.verdict.engine,
      reason: call.verdict.reason,
      reasonEn: call.verdict.reasonEn || null,
      action: call.verdict.action || null,
      judgedAt: call.verdict.judgedAt || null,
    } : null,
    recordingUrl: call.recordingUrl || null,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  return { ...bundle, sha256 };
}

// Short-form notice read/disclosed to callers (PDPA ม.23: purpose + basis +
// data + processors + recipients + retention + rights). Accurate to what the
// system does today: TEXT transcripts only (no audio is stored), alerts go
// to the household payer and the family watchers they added, and Twilio /
// Google Gemini / TypeSafe Jev process the conversation to answer and judge
// it. The final policy is pending a lawyer's draft.
export function privacyNoticeTh() {
  const site = (config.publicBaseUrl || 'https://krai-a.com').replace(/^https?:\/\//, '');
  return [
    'นโยบายความเป็นส่วนตัว ใครอะ — ฉบับย่อสำหรับผู้โทร',
    '1. เราเก็บอะไร: เบอร์ที่โทรมา บทสนทนาเป็นข้อความ (ถอดจากเสียงระหว่างสาย ไม่เก็บไฟล์เสียง) และผลการคัดกรองสาย',
    '2. ทำไม (ฐานกฎหมาย PDPA): ประโยชน์โดยชอบด้วยกฎหมาย (legitimate interests) — ป้องกันภัยมิจฉาชีพ และป้องกันอันตรายต่อชีวิต/ทรัพย์สิน (vital interests)',
    '3. ผู้ประมวลผลข้อมูล: Twilio (รับสายและแปลงเสียงพูดเป็นข้อความ) · Google Gemini และ TypeSafe Jev (ตอบและวิเคราะห์บทสนทนา) · LINE (แจ้งเตือน) · THSMS (SMS) · Stripe (ชำระเงินของสมาชิก)',
    `4. เก็บนานแค่ไหน: สายปกติ ${config.retentionLegitDays} วัน สายไม่ชัวร์ ${config.retentionUnsureDays} วัน สายต้องสงสัย ${config.retentionScamDays} วัน แล้วลบอัตโนมัติ`,
    '5. ใครเห็นบ้าง: สมาชิกที่ดูแลเบอร์ที่ท่านโทรเข้า และผู้ดูแลครอบครัวที่สมาชิกเพิ่มไว้ (ต้องยืนยันตัวตนเอง ได้รับแจ้งเตือนทาง LINE) — ไม่แชร์ป้ายเตือนข้ามบ้าน',
    '6. เมื่อลบบัญชี: เราเก็บเพียงค่าแฮชของเบอร์ (ถอดกลับเป็นเบอร์ไม่ได้) 12 เดือน เพื่อป้องกันการใช้ช่วงทดลองฟรีซ้ำ (ประโยชน์โดยชอบด้วยกฎหมาย — ป้องกันการทุจริต)',
    `7. สิทธิของคุณ: คัดค้าน/ขอลบข้อมูลได้ทางหน้าเว็บ ${site} · สมาชิกลบบัญชีและข้อมูลทั้งหมดได้เองในห้องของฉัน · เจ้าของเบอร์ที่ถูกปกป้องถอนความยินยอมได้ที่ ${site}/withdraw.html`,
  ].join('\n');
}
