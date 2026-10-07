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
// data + retention). Full policy lives here until a lawyer drafts the final.
export function privacyNoticeTh() {
  return [
    'นโยบายความเป็นส่วนตัว ใครอ่ะ (Krai-a) — ฉบับย่อสำหรับผู้โทร',
    `1. เราเก็บอะไร: เบอร์โทร เสียง/ข้อความถอดเสียง และผลการคัดกรองสาย`,
    '2. ทำไม (ฐานกฎหมาย PDPA): ประโยชน์โดยชอบด้วยกฎหมาย (legitimate interests) — ป้องกันภัยมิจฉาชีพ และป้องกันอันตรายต่อชีวิต/ทรัพย์สิน (vital interests)',
    `3. เก็บนานแค่ไหน: สายปกติ ${config.retentionLegitDays} วัน สายไม่ชัวร์ ${config.retentionUnsureDays} วัน สายต้องสงสัย ${config.retentionScamDays} วัน แล้วลบอัตโนมัติ`,
    '4. ใครเห็นบ้าง: เจ้าของสายที่ท่านโทรเข้าเท่านั้น ไม่แชร์ป้ายเตือนข้ามผู้ใช้',
    '5. สิทธิของคุณ: คัดค้าน/ขอลบข้อมูลได้ ติดต่อผ่านหน้าเว็บ krai-a.com (ช่องทางติดต่อจะประกาศก่อนเปิดจริง)',
  ].join('\n');
}
