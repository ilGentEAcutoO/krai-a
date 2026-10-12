// Demo call scripts: 3 scam scripts (police / parcel / bank) + 1 legit +
// 1 unsure. Each script is the simulated CALLER side; the AI side (persona +
// verdict) comes from the real engine. scripts/render-demo.mjs records one
// real run of every script and freezes it as /demo/scenarios.json + mp3, so
// public visitors replay it without any API call.
// `say` overrides the spoken form when the display text reads badly aloud
// (phone numbers digit-by-digit, abbreviations).
const line = (th, en, say) => ({ th, en, ...(say ? { say } : {}) });

const RAW = [
  {
    id: 'scam-police',
    expected: 'SCAM',
    titleTh: 'ตำรวจปลอม',
    titleEn: 'Fake police',
    callerTh: 'อ้างตัวเป็นตำรวจ สภ.เมือง',
    callerEn: 'Claims to be a police officer',
    callerPhone: '+66819990001',
    icon: 'police',
    voice: 'Alnilam',
    style: 'a stern, authoritative Thai policeman; pressuring and slightly fast, intimidating',
    turns: [
      line('สวัสดีครับ ผมร้อยตำรวจโทสมศักดิ์ จาก สภ.เมืองครับ มีหมายเรียกคดีฟอกเงินออกในชื่อเจ้าของเบอร์นี้ครับ',
        "Hello, this is Police Lieutenant Somsak from the city police station. There's a summons for a money-laundering case in the name of this number's owner."),
      line('บัญชีธนาคารของเจ้าของเบอร์พัวพันกับขบวนการค้ายาเสพติด ถ้าไม่ให้ความร่วมมือภายในวันนี้ บัญชีจะถูกอายัดทั้งหมดนะครับ',
        "The owner's bank account is linked to a drug ring. If they don't cooperate today, every account will be frozen."),
      line('ห้ามวางสาย ห้ามบอกใครทั้งนั้น ให้เจ้าของเบอร์โอนเงินมาพักไว้ที่บัญชีกลางเพื่อตรวจสอบก่อนเลยครับ',
        "Don't hang up and don't tell anyone. The owner must transfer the money into a holding account for inspection right now."),
    ],
  },
  {
    id: 'scam-parcel',
    expected: 'SCAM',
    titleTh: 'พัสดุตกค้าง',
    titleEn: 'Stuck parcel',
    callerTh: 'อ้างเป็นบริษัทขนส่ง',
    callerEn: 'Claims to be a courier company',
    callerPhone: '+66819990002',
    icon: 'parcel',
    // Pulcherrima rated robotic in Thai on 4/4 takes (nat 2/5); Laomedeia 5/5.
    voice: 'Laomedeia',
    style: 'a brisk, pushy Thai call-centre agent; rushed and insistent',
    turns: [
      line('สวัสดีค่ะ ติดต่อจากบริษัทขนส่งค่ะ มีพัสดุตกค้างในชื่อเจ้าของเบอร์นี้ ส่งไม่สำเร็จมาสองรอบแล้วค่ะ',
        "Hello, this is the courier company. There's a parcel under this number's owner that we've failed to deliver twice."),
      line('ทางเราตรวจพบของผิดกฎหมายอยู่ข้างในค่ะ ถ้าไม่ยืนยันตัวตนภายในวันนี้ จะถูกส่งเรื่องให้ตำรวจดำเนินคดีนะคะ',
        "We found illegal items inside. If the identity isn't confirmed today, the case goes to the police."),
      line('รบกวนแจ้งเลขบัญชีกับรหัส OTP ที่เพิ่งส่งไปทาง SMS ด้วยค่ะ ด่วนเลยนะคะ',
        'Please give me the bank account number and the OTP code we just sent by SMS. It is urgent.',
        'รบกวนแจ้งเลขบัญชีกับรหัสโอทีพี ที่เพิ่งส่งไปทางเอสเอ็มเอสด้วยค่ะ ด่วนเลยนะคะ'),
    ],
  },
  {
    id: 'scam-bank',
    expected: 'SCAM',
    titleTh: 'ธนาคารปลอม',
    titleEn: 'Fake bank',
    callerTh: 'อ้างเป็นฝ่ายความปลอดภัยธนาคาร',
    callerEn: "Claims to be the bank's security team",
    callerPhone: '+66819990003',
    icon: 'bank',
    voice: 'Alnilam',
    style: 'a smooth but urgent Thai bank officer; professional tone with mounting pressure',
    turns: [
      line('สวัสดีครับ ผมโทรจากฝ่ายความปลอดภัยของธนาคารครับ ระบบตรวจพบการโอนเงินออกจากบัญชีของเจ้าของเบอร์แบบผิดปกติครับ',
        "Hello, I'm calling from the bank's security department. Our system detected unusual transfers out of the owner's account."),
      line('เพื่อระงับความเสียหาย ต้องติดตั้งแอปป้องกันตามลิงก์ที่ผมส่งให้ทาง SMS แล้วแจ้งรหัสยืนยันหกหลักภายในสิบนาทีครับ',
        'To stop the damage, install the protection app from the link I sent by SMS and read me the 6-digit code within ten minutes.',
        'เพื่อระงับความเสียหาย ต้องติดตั้งแอปป้องกันตามลิงก์ที่ผมส่งให้ทางเอสเอ็มเอส แล้วแจ้งรหัสยืนยันหกหลักภายในสิบนาทีครับ'),
    ],
  },
  {
    id: 'legit-hospital',
    expected: 'LEGIT',
    titleTh: 'โรงพยาบาลนัดตรวจ',
    titleEn: 'Hospital appointment',
    callerTh: 'เจ้าหน้าที่โรงพยาบาลยืนยันนัด',
    callerEn: 'Hospital staff confirming an appointment',
    callerPhone: '+6621002003',
    icon: 'hospital',
    voice: 'Callirrhoe',
    style: 'a friendly, cheerful Thai hospital receptionist; relaxed and kind',
    turns: [
      line('สวัสดีค่ะ ติดต่อจากโรงพยาบาลรักษ์สุขภาพค่ะ โทรมายืนยันนัดตรวจสุขภาพประจำปี วันพฤหัสนี้ เก้าโมงเช้าค่ะ',
        'Hello, this is Raksukkhaphap Hospital, confirming the annual check-up this Thursday at 9 a.m.'),
      line('ดิฉันชื่อสุดา ฝ่ายนัดหมายค่ะ ถ้าวันนั้นไม่สะดวก เลื่อนได้นะคะ โทรกลับที่ 02-100-2003 ได้เลยค่ะ',
        "I'm Suda from appointments. If that day doesn't work, it can be moved. Please call back on 02-100-2003.",
        'ดิฉันชื่อสุดา ฝ่ายนัดหมายค่ะ ถ้าวันนั้นไม่สะดวก เลื่อนได้นะคะ โทรกลับที่ ศูนย์สอง หนึ่งศูนย์ศูนย์ สองศูนย์ศูนย์สาม ได้เลยค่ะ'),
    ],
  },
  {
    id: 'unsure-survey',
    expected: 'UNSURE',
    titleTh: 'แบบสอบถามแปลก ๆ',
    titleEn: 'Odd survey',
    callerTh: 'อ้างทำแบบสอบถาม ข้อมูลไม่ชัด',
    callerEn: 'Vague survey caller',
    callerPhone: '+66819990009',
    icon: 'survey',
    voice: 'Umbriel',
    style: 'a hesitant, unsure young Thai man; pauses and um-s, a little awkward',
    turns: [
      line('เอ่อ สวัสดีครับ ผมโทรจากศูนย์วิจัยการตลาดครับ ขอรบกวนสอบถามข้อมูลนิดหน่อยครับ',
        "Uh, hello. I'm calling from a marketing research centre. May I ask a few quick questions?"),
      line('คือ... ขอชื่อจริงกับปีเกิดของเจ้าของเบอร์หน่อยครับ จะได้ลงทะเบียนรับของที่ระลึกครับ',
        "Well... could I get the owner's full name and birth year? It's to register them for a free gift."),
    ],
  },
];

export const SCRIPTS = RAW.map((s) => ({
  ...s,
  // Back-compat shape used by /api/demo/scripts and /api/demo/start.
  lines: s.turns.map((t) => t.th),
  linesEn: s.turns.map((t) => t.en),
}));

export function getScript(id) {
  return SCRIPTS.find((s) => s.id === id) || null;
}

// "+66819990001" -> "081-999-0001", "+6621002003" -> "02-100-2003"
export function displayPhone(e164) {
  const local = String(e164).replace(/^\+66/, '0');
  if (/^0[689]\d{8}$/.test(local)) return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  if (/^02\d{7}$/.test(local)) return `${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5)}`;
  return local;
}
