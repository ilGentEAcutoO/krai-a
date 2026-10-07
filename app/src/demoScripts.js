// Demo call scripts: 3 live scam scripts (police / parcel / bank) + 1 legit
// + 1 unsure, per the F4 demo plan. Each script is the simulated CALLER side;
// the AI (persona + verdict) responds live. Judges can also freestyle-type.
export const SCRIPTS = [
  {
    id: 'scam-police',
    expected: 'SCAM',
    titleTh: 'สคริปต์ 1 · อ้างตำรวจ',
    titleEn: 'Script 1 · Fake police',
    callerPhone: '+66819990001',
    lines: [
      'สวัสดีครับ ผมร้อยเวรจาก สภ.เมือง คุณมีหมายเรียกคดีฟอกเงินนะครับ',
      'บัญชีคุณพัวพันกับขบวนการค้ายา มีหมายจับออกมาแล้ว ถ้าไม่ให้ความร่วมมือจะถูกอายัดบัญชีทั้งหมด',
      'ตอนนี้ห้ามวางสาย ห้ามบอกใคร ฟังผมอย่างเดียว แล้วโอนเงินมาตรวจสอบที่บัญชีกลางก่อน',
    ],
  },
  {
    id: 'scam-parcel',
    expected: 'SCAM',
    titleTh: 'สคริปต์ 2 · พัสดุตกค้าง',
    titleEn: 'Script 2 · Stuck parcel',
    callerPhone: '+66819990002',
    lines: [
      'สวัสดีค่ะ โทรจากบริษัทขนส่ง มีพัสดุตกค้างชื่อคุณค่ะ ข้างในมีของผิดกฎหมายนะคะ',
      'ต้องยืนยันตัวตนด่วนค่ะ ไม่งั้นของจะถูกส่งคืนและโดนคดี รบกวนแจ้งเลขบัญชีกับรหัส OTP ที่ส่งไปให้หน่อยค่ะ',
    ],
  },
  {
    id: 'scam-bank',
    expected: 'SCAM',
    titleTh: 'สคริปต์ 3 · อ้างธนาคาร',
    titleEn: 'Script 3 · Fake bank',
    callerPhone: '+66819990003',
    lines: [
      'ครับผม โทรจากฝ่ายความปลอดภัยธนาคารครับ บัญชีคุณมีการโอนออกผิดปกติครับ',
      'เพื่อระงับความเสียหาย รบกวนโหลดแอปตามลิงก์ที่ผมส่งให้ แล้วแจ้งรหัสยืนยัน 6 หลักด้วยครับ ด่วนเลยนะครับ ภายใน 10 นาที',
    ],
  },
  {
    id: 'legit-hospital',
    expected: 'LEGIT',
    titleTh: 'เคสคนจริง · โรงพยาบาลนัด',
    titleEn: 'Legit · Hospital appointment',
    callerPhone: '+6621002003',
    lines: [
      'สวัสดีค่ะ โทรจากโรงพยาบาลสมิติเวช เรื่องนัดตรวจสุขภาพวันพฤหัสค่ะ',
      'ขอคอนเฟิร์มว่าคุณสะดวกมาตามนัดไหมคะ ถ้าไม่สะดวกเลื่อนได้นะคะ โทรกลับเบอร์ 02-100-2003 ได้เลยค่ะ',
    ],
  },
  {
    id: 'unsure-survey',
    expected: 'UNSURE',
    titleTh: 'เคสไม่ชัวร์ · อ้างทำแบบสอบถาม',
    titleEn: 'Unsure · Vague survey',
    callerPhone: '+66819990009',
    lines: [
      'สวัสดีครับ โทรจากศูนย์วิจัยครับ ขอสอบถามข้อมูลนิดหน่อยครับ',
      'เอ่อ ขอชื่อกับวันเกิดหน่อยครับ แล้วก็... บัญชีที่ใช้ประจำคือธนาคารไหนครับ จะได้จัดของที่ระลึกให้ถูกครับ',
    ],
  },
];

export function getScript(id) {
  return SCRIPTS.find((s) => s.id === id) || null;
}
