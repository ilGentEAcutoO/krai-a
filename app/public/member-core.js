// Member app core — ONE codebase for the web dashboard (dashboard.html),
// LINE LIFF (liff.html) and the signup flow (start.html).
// Sections: Home (status + recent calls + quota) · People (who I protect,
// family watchers) · Settings (plan, LINE, account, cancel).
// Bilingual via S (th/en); everything re-renders on language change.
import { api, session, i18n, applyLang } from '/site.js';

// ---------- small helpers ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];
const locale = () => (i18n.lang === 'th' ? 'th-TH' : 'en-US');
const fmtDate = (iso, opts = { day: 'numeric', month: 'short' }) => {
  try { return new Date(iso).toLocaleDateString(locale(), opts); } catch { return ''; }
};
const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

// Thai mobile only (forwarding codes need a mobile): 0[689]x-xxx-xxxx or
// +66[689]xxxxxxxx. Checked in the browser before any request; the server
// keeps its own check.
export function isThaiMobile(raw) {
  const d = String(raw || '').replace(/[\s()-]/g, '');
  return /^0[689]\d{8}$/.test(d) || /^\+66[689]\d{8}$/.test(d);
}

// +66812345678 -> 081-234-5678 · +6621000142 -> 02-100-0142
export function fmtPhone(p) {
  const s = String(p || '');
  const d = s.startsWith('+66') ? `0${s.slice(3)}` : s;
  if (/^0[689]\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (/^02\d{7}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (/^0\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return s;
}

const S = {
  // relations
  r_self: { th: 'ตัวฉัน', en: 'Me' }, r_mother: { th: 'แม่', en: 'Mom' }, r_father: { th: 'พ่อ', en: 'Dad' },
  r_grandparent: { th: 'ปู่ย่าตายาย', en: 'Grandparent' }, r_child: { th: 'ลูก', en: 'Child' },
  r_partner: { th: 'คู่ชีวิต', en: 'Partner' }, r_other: { th: 'คนอื่น', en: 'Someone else' },
  a_self: { th: 'ฉัน', en: 'Me' }, a_mother: { th: 'แม่', en: 'Mom' }, a_father: { th: 'พ่อ', en: 'Dad' },
  a_grandparent: { th: 'ตายาย', en: 'Gran' }, a_child: { th: 'ลูก', en: 'Kid' }, a_partner: { th: 'คู่', en: 'Ptnr' },
  // shell
  tHome: { th: 'หน้าหลัก', en: 'Home' }, tPeople: { th: 'คนที่ฉันปกป้อง', en: 'My people' }, tSettings: { th: 'ตั้งค่า', en: 'Settings' },
  backSite: { th: 'กลับหน้าเว็บ', en: 'Back to site' }, logout: { th: 'ออกจากระบบ', en: 'Log out' },
  loading: { th: 'กำลังโหลด…', en: 'Loading…' },
  loadFail: { th: 'โหลดข้อมูลไม่สำเร็จ', en: "Couldn't load your account" },
  loadFailSub: { th: 'เช็กอินเทอร์เน็ตแล้วลองใหม่ ข้อมูลของคุณยังอยู่ครบ', en: 'Check your connection and retry — your data is safe.' },
  retry: { th: 'ลองใหม่', en: 'Retry' },
  // home status
  live: { th: 'ป้องกันอยู่', en: 'Protected' },
  liveH: { th: 'AI กำลังเฝ้าสายให้', en: 'AI is guarding calls for' },
  liveP: { th: 'สายแปลกที่โทรหาเครื่องเหล่านี้ จะเจอ AI ก่อน แล้วเราสรุปให้คุณ', en: 'Unknown callers reach the AI first — you get the summary.' },
  pendingFwd: { th: '%N% ยังไม่ได้ตั้งโอนสาย', en: '%N% still needs call forwarding' },
  setNow: { th: 'ตั้งเลย', en: 'Set up' },
  emptyH: { th: 'เริ่มปกป้องคนที่คุณรัก', en: 'Start protecting someone you love' },
  emptyP: { th: 'เลือกเครื่องที่อยากให้ AI รับสายแปลกแทน', en: 'Pick the phone the AI should answer unknown calls for.' },
  pickLoved: { th: 'เครื่องของคนที่ฉันรัก', en: "A loved one's phone" },
  pickLovedSub: { th: 'พ่อแม่ ปู่ย่าตายาย หรือลูก', en: 'Parents, grandparents or kids' },
  pickSelf: { th: 'เครื่องนี้ของฉัน', en: 'This phone (mine)' },
  setupH: { th: 'ตั้งโอนสายบนเครื่องของ%N%', en: 'Set up forwarding on %N%’s phone' },
  setupHSelf: { th: 'ตั้งโอนสายบนเครื่องนี้', en: 'Set up forwarding on this phone' },
  waitH: { th: 'เบอร์กลางกำลังเปิด', en: 'Our AI number is opening soon' },
  waitP: { th: 'บัญชีของคุณพร้อมแล้ว เราจะแจ้งทันทีที่ตั้งโอนสายได้', en: 'Your account is ready. We’ll tell you the moment forwarding opens.' },
  waitVia: { th: 'แจ้งฉันทาง', en: 'Notify me by' },
  waitSms: { th: 'SMS', en: 'SMS' }, waitLine: { th: 'LINE', en: 'LINE' },
  waitSaved: { th: 'บันทึกแล้ว ✓', en: 'Saved ✓' },
  waitReady: { th: 'พร้อมปกป้อง: %N%', en: 'Ready to protect: %N%' },
  waitAdd: { th: 'ระหว่างนี้ เพิ่มคนที่อยากปกป้องไว้ก่อน', en: 'Meanwhile, add the people you want to protect' },
  offH: { th: 'AI หยุดรับสายแล้ว', en: 'The AI has stopped answering' },
  offP: { th: 'ยกเลิกสมาชิกเมื่อ %D% · ข้อมูลยังเก็บไว้', en: 'Cancelled on %D% · your data is kept' },
  reactivate: { th: 'เปิดใช้อีกครั้ง', en: 'Reactivate' },
  // banners
  paidOk: { th: 'ชำระเงินสำเร็จ ✓ สิทธิ์กำลังเข้า', en: 'Payment received ✓ — benefits on the way' },
  paidCancel: { th: 'ยกเลิกการชำระเงินแล้ว', en: 'Checkout cancelled' },
  graceLeft: { th: 'ครบทดลองฟรีแล้ว — AI ยังรับสายให้อีก %D% วัน', en: 'Your trial ended — the AI keeps answering for %D% more day(s)' },
  graceLeftPlan: { th: 'แผนหมดอายุแล้ว — AI ยังรับสายให้อีก %D% วัน', en: 'Your plan expired — the AI keeps answering for %D% more day(s)' },
  planEndsSoon: { th: 'แผนจะหมดอายุในอีก %D% วัน', en: 'Your plan expires in %D% day(s)' },
  renew: { th: 'ต่ออายุ', en: 'Renew' },
  seatSoon: { th: 'ที่นั่งเสริมจะหมดอายุใน %D% วัน — %N% จะไม่มี AI รับสายแทน', en: 'An extra seat ends in %D% day(s) — %N% will lose AI answering' },
  seatGrace: { th: 'ที่นั่งเสริมหมดอายุ — AI ยังรับสายแทน %N% อีก %D% วัน', en: 'An extra seat ended — the AI keeps answering for %N% %D% more day(s)' },
  seatStopped: { th: 'AI หยุดรับสายแทน %N% แล้ว (ที่นั่งเสริมหมดอายุ)', en: 'The AI stopped answering for %N% (extra seat ended)' },
  suspended: { th: 'หยุดแล้ว', en: 'Stopped' },
  paidUntil: { th: 'ใช้ได้ถึง %D%', en: 'Active until %D%' },
  lapsedHPlan: { th: 'แผนหมดอายุแล้ว', en: 'Your plan has expired' },
  lapsedPPlan: { th: 'AI หยุดรับสายแทนแล้ว ต่ออายุเพื่อเปิดใช้อีกครั้ง — ถ้าไม่ต่อ ให้กด ##002# ที่เครื่องที่ตั้งโอนไว้ สายจะได้ดังตามปกติ', en: 'The AI has stopped answering. Renew to switch it back on — not renewing? Dial ##002# on forwarded phones so calls ring as usual.' },
  lapsedH: { th: 'ครบทดลองฟรีแล้ว', en: 'Your free trial is over' },
  deniedH: { th: 'เบอร์นี้เคยใช้ช่วงทดลองฟรีแล้ว', en: 'This number already used its free trial' },
  deniedP: { th: 'เลือกแผนเพื่อเริ่มให้ AI รับสายแทน — ตั้งโอนสายหลังชำระแล้วเท่านั้น ไม่อย่างนั้นสายที่โอนมาจะไม่มีใครรับ', en: 'Pick a plan to start the AI answering — set up forwarding only after paying, or forwarded calls will go unanswered.' },
  lapsedP: { th: 'AI หยุดรับสายแทนแล้ว เลือกแผนเพื่อเปิดใช้อีกครั้ง — ถ้ายังไม่ต่อ ให้กด ##002# ที่เครื่องที่ตั้งโอนไว้ สายจะได้ดังตามปกติ', en: 'The AI has stopped answering. Pick a plan to switch it back on — not renewing? Dial ##002# on forwarded phones so calls ring as usual.' },
  trialLeft: { th: 'ทดลองฟรีเหลือ %D% วัน', en: '%D% free-trial days left' },
  quotaLow: { th: 'โควต้าใกล้หมด — เติมได้ในตั้งค่า', en: 'Quota running low — top up in Settings' },
  pickPlan: { th: 'เลือกแผน', en: 'Pick a plan' }, topUp: { th: 'เติม', en: 'Top up' },
  // calls
  callsH: { th: 'สายล่าสุด', en: 'Recent calls' },
  callsMonth: { th: 'เดือนนี้ %N% สาย', en: '%N% this month' },
  noCalls: { th: 'ยังไม่มีสายเข้า', en: 'No calls yet' },
  noCallsP: { th: 'เมื่อ AI รับสายแทน สรุปและบทสนทนาจะขึ้นที่นี่', en: 'When the AI answers, the summary and transcript show up here.' },
  howTest: { th: 'ดูวิธีโทรทดสอบ', en: 'How to place a test call' },
  callsFail: { th: 'โหลดสายล่าสุดไม่สำเร็จ', en: "Couldn't load recent calls" },
  to: { th: 'ถึง', en: 'to' },
  vSCAM: { th: 'น่าสงสัย', en: 'Suspicious' }, vLEGIT: { th: 'คนจริง', en: 'Real person' }, vUNSURE: { th: 'ไม่ชัวร์', en: 'Unsure' },
  transcript: { th: 'บทสนทนา', en: 'Transcript' }, caller: { th: 'ปลายสาย', en: 'Caller' }, ai: { th: 'AI', en: 'AI' },
  exportEv: { th: 'บันทึกหลักฐาน (.json)', en: 'Save evidence (.json)' },
  delCall: { th: 'ลบบทสนทนา', en: 'Delete transcript' },
  delCallQ: { th: 'ลบสายนี้และบทสนทนาถาวร?', en: 'Delete this call and its transcript for good?' },
  delCallYes: { th: 'ลบถาวร', en: 'Delete' },
  showAll: { th: 'ดูทั้งหมด', en: 'Show all' },
  // quota
  quotaH: { th: 'โควต้าเดือนนี้', en: 'This month' },
  quotaLeft: { th: 'เหลือ %M% นาที', en: '%M% min left' },
  quotaSub: { th: 'เหลือ %C% จาก %Q% สาย · รีเซ็ต %D%', en: '%C% of %Q% calls left · resets %D%' },
  quotaFail: { th: 'โหลดโควต้าไม่สำเร็จ', en: "Couldn't load quota" },
  // people
  peopleH: { th: 'เครื่องที่ AI เฝ้า', en: 'Phones the AI guards' },
  guarding: { th: 'เฝ้าอยู่', en: 'Guarding' }, needsFwd: { th: 'รอตั้งโอนสาย', en: 'Needs forwarding' },
  pendingOtp: { th: 'รอรหัส', en: 'Awaiting code' }, pendingSub: { th: 'รอรหัสจากเครื่องนั้น', en: 'Waiting for the code from that phone' },
  addPerson: { th: 'เพิ่มคนที่อยากปกป้อง', en: 'Add someone to protect' },
  addFirst: { th: 'เพิ่มคนแรก', en: 'Add the first person' },
  noPeople: { th: 'ยังไม่มีใครถูกปกป้อง', en: 'Nobody is protected yet' },
  withdrewNote: { th: '%N% (%P%) ถอนความยินยอมเมื่อ %D% — AI ไม่รับสายแทนเบอร์นี้แล้ว', en: '%N% (%P%) withdrew consent on %D% — the AI no longer answers for that number' },
  noPeopleP: { th: 'เพิ่มเบอร์ของพ่อแม่ ลูก หรือตัวคุณเอง', en: 'Add a parent’s, a child’s or your own number.' },
  capReached: { th: 'แผน %P% ปกป้องได้ %N% เครื่อง', en: 'The %P% plan protects %N% phone(s)' },
  upgrade: { th: 'อัปเกรด', en: 'Upgrade' },
  buySeat: { th: 'เพิ่มอีกเครื่อง %P%/เดือน', en: 'Add a phone %P%/mo' },
  watchersH: { th: 'ผู้ดูแลที่รับแจ้งเตือน', en: 'Family who get alerts' },
  watchersP: { th: 'ได้แจ้งเตือนทาง LINE ทุกครั้งที่ AI รับสายแทนครอบครัว', en: 'They get a LINE alert every time the AI answers for your family.' },
  lineOk: { th: 'LINE ✓', en: 'LINE ✓' }, lineNo: { th: 'ยังไม่เชื่อม LINE', en: 'LINE not linked' },
  invite: { th: 'ส่งลิงก์เชิญ', en: 'Send invite' },
  inviteText: { th: 'ช่วยเป็นผู้ดูแลครอบครัวใน "ใครอะ" หน่อย กดลิงก์นี้ใน LINE แล้วยืนยันเบอร์ของคุณ: ', en: 'Be our family watcher on Krai-A — open this in LINE and verify your number: ' },
  noWatchers: { th: 'ยังไม่มีผู้ดูแล', en: 'No watchers yet' },
  addWatcher: { th: 'เพิ่มผู้ดูแล', en: 'Add watcher' },
  save: { th: 'บันทึก', en: 'Save' }, remove: { th: 'ลบ', en: 'Remove' },
  phone: { th: 'เบอร์มือถือ', en: 'Mobile number' },
  // add person
  addH: { th: 'ปกป้องใคร?', en: 'Who are you protecting?' },
  addName: { th: 'ชื่อเรียก', en: 'Name' },
  theirPhone: { th: 'เบอร์มือถือของเขา', en: 'Their mobile number' },
  sendCode: { th: 'ส่งรหัสไปที่เครื่องนั้น', en: 'Text a code to that phone' },
  consent: { th: 'เจ้าของเครื่องต้องอ่านรหัสให้คุณ — เป็นการยืนยันว่าเขายินยอม', en: 'The phone’s owner reads the code to you — that’s their consent.' },
  codeFrom: { th: 'กรอกรหัสจากเครื่องของ%N%', en: 'Enter the code from %N%’s phone' },
  codeSentTo: { th: 'ส่งรหัส 6 หลักไปที่', en: 'We texted a 6-digit code to' },
  change: { th: 'เปลี่ยนเบอร์', en: 'Change' },
  resendIn: { th: 'ขอรหัสใหม่ได้ใน %S%', en: 'Resend code in %S%' },
  resend: { th: 'ขอรหัสใหม่', en: 'Resend code' },
  devCode: { th: 'โหมดทดสอบ — รหัสคือ', en: 'Test mode — the code is' },
  verified: { th: 'ยืนยันแล้ว', en: 'Verified' },
  // forwarding
  modeH: { th: 'ให้ AI รับสายไหน', en: 'Which calls go to the AI' },
  modeAll: { th: 'ทุกสาย', en: 'Every call' },
  modeMissed: { th: 'เฉพาะสายที่ไม่ได้รับ', en: 'Only missed calls' },
  modeAllP: { th: 'เหมาะกับผู้สูงอายุ — สายแปลกจะไม่ถึงเครื่องเลย AI รับทุกสายแล้วสรุปให้', en: 'Best for elders — unknown calls never ring through; the AI takes every call and briefs you.' },
  modeMissedP: { th: 'เครื่องยังดังก่อน ถ้าไม่ได้รับหรือสายไม่ว่าง AI จะรับแทน', en: 'The phone rings first; if unanswered or busy, the AI picks up.' },
  tapToDial: { th: 'แตะเพื่อโทรตั้งโอนสาย', en: 'Tap to dial the forwarding code' },
  dialMissed: { th: '1 · ไม่ได้รับสาย', en: '1 · Not answered' },
  dialBusy: { th: '2 · สายไม่ว่าง', en: '2 · Busy' },
  onTheirPhone: { th: 'ทำบนเครื่องของ%N%', en: 'Do this on %N%’s phone' },
  stepOpen: { th: 'เปิดแอปโทรศัพท์บนเครื่องนั้น', en: 'Open the Phone app on that phone' },
  stepDial: { th: 'กดรหัสด้านล่างแล้วกดโทรออก', en: 'Dial the code below and press call' },
  stepWait: { th: 'รอข้อความว่าตั้งค่าสำเร็จ', en: 'Wait for the “forwarding set” message' },
  copy: { th: 'คัดลอก', en: 'Copy' }, copied: { th: 'คัดลอกแล้ว ✓', en: 'Copied ✓' },
  shareLine: { th: 'ส่งวิธีตั้งทาง LINE', en: 'Send the steps via LINE' },
  shareText: { th: 'ตั้งโอนสายให้ AI "ใครอะ" รับสายแปลกแทน: เปิดแอปโทรศัพท์ กด %C% แล้วโทรออก', en: 'Let the Krai-A AI answer unknown calls: open the Phone app, dial %C% and press call.' },
  testH: { th: 'โทรทดสอบ', en: 'Test it' },
  testAll: { th: 'ใช้อีกเครื่องโทรหา %P% — AI จะรับสาย', en: 'Call %P% from another phone — the AI will answer.' },
  testMissed: { th: 'ใช้อีกเครื่องโทรหา %P% แล้วปล่อยให้ดังจนตัด — AI จะรับสาย', en: 'Call %P% from another phone and let it ring out — the AI will answer.' },
  waiting: { th: 'รอสายทดสอบ… เมื่อ AI รับสายที่โอนมาครั้งแรก สถานะจะเป็น ✓ เอง', en: 'Waiting for a test call… the first forwarded call turns this ✓ by itself.' },
  fwdWorks: { th: 'โอนสายใช้งานได้แล้ว ✓', en: 'Forwarding works ✓' },
  cancelFwd: { th: 'เลิกโอนสายเมื่อไรก็ได้ กด', en: 'Stop forwarding anytime: dial' },
  guardSince: { th: 'AI เฝ้าเครื่องนี้ตั้งแต่ %D%', en: 'The AI has guarded this phone since %D%' },
  seeCodes: { th: 'ดูรหัสโอนสายอีกครั้ง', en: 'Show the forwarding code again' },
  unprotect: { th: 'เลิกปกป้องเบอร์นี้', en: 'Stop protecting this number' },
  unprotectWarn: { th: 'กด ##002# ที่เครื่องนั้นก่อน ไม่อย่างนั้นสายที่ยังโอนมาจะไม่มีใครรับ', en: 'Dial ##002# on that phone first — otherwise forwarded calls will go unanswered.' },
  unprotectYes: { th: 'เลิกปกป้อง', en: 'Stop protecting' },
  done: { th: 'เสร็จแล้ว', en: 'Done' },
  // settings
  planH: { th: 'แผนและการชำระเงิน', en: 'Plan & billing' },
  perMonth: { th: '/เดือน', en: '/mo' },
  planIncl: { th: 'ปกป้อง %N% เครื่อง · %M% นาที · %C% สาย/เดือน', en: '%N% phone(s) · %M% min · %C% calls/mo' },
  inTrial: { th: 'ทดลองฟรีเหลือ %D% วัน', en: '%D% trial days left' },
  payPlan: { th: 'ชำระค่าแผนนี้', en: 'Pay for this plan' },
  payMonth: { th: 'ชำระ %P%/เดือน', en: 'Pay %P%/month' },
  payYear: { th: 'ชำระ %P%/ปี', en: 'Pay %P%/year' },
  perMonthShort: { th: 'รายเดือน', en: 'Monthly' }, perYearShort: { th: 'รายปี', en: 'Yearly' },
  yearSave: { th: 'ประหยัด %S%', en: 'save %S%' },
  giftH: { th: 'จ่ายล่วงหน้า 1 ปี (ของขวัญ)', en: 'Prepay 1 year (gift)' },
  giftP: { th: 'จ่ายครั้งเดียวได้ 1 ปีสำหรับบ้านนี้ ไม่ต่ออายุอัตโนมัติ เหมาะซื้อให้พ่อแม่', en: 'One payment covers this household for a year. Never auto-renews — a good gift for parents.' },
  giftBtn: { th: '%N% 1 ปี', en: '%N% · 1 year' },
  trialCallsUsed: { th: 'ทดลองใช้ไปแล้ว %N%/%T% สาย', en: 'Trial: %N%/%T% calls used' },
  trialUntil: { th: 'ทดลองฟรีถึง %D% หรือครบ %T% สาย', en: 'Free trial until %D% or %T% calls' },
  payGo: { th: 'กำลังเปิดหน้าชำระเงิน…', en: 'Opening checkout…' },
  payUnavailable: { th: 'ระบบชำระเงินยังไม่เปิด (โหมดทดลอง)', en: 'Payments are not open yet (test mode)' },
  payFailed: { th: 'เปิดหน้าชำระเงินไม่สำเร็จ ลองใหม่', en: 'Could not open checkout — retry' },
  topupH: { th: 'เติมนาทีและสาย', en: 'Top up minutes + calls' },
  topupP: { th: 'แพ็กเสริมไม่หมดอายุ ไม่รีเซ็ต', en: 'Packs never expire or reset.' },
  autoH: { th: 'เติมอัตโนมัติเมื่อใกล้หมด', en: 'Auto top-up when low' },
  autoCard: { th: 'ตัดบัตรที่บันทึกไว้ให้อัตโนมัติ', en: 'Your saved card is charged automatically.' },
  autoManual: { th: 'PromptPay ตัดอัตโนมัติไม่ได้ — กดเติมเองเมื่อได้แจ้งเตือน', en: 'PromptPay can’t auto-charge — top up when we alert you.' },
  lineH: { th: 'แจ้งเตือนทาง LINE', en: 'LINE alerts' },
  lineLinked: { th: 'เชื่อม LINE แล้ว ✓ สรุปทุกสายจะส่งเข้า LINE', en: 'LINE linked ✓ — every call summary goes to LINE.' },
  lineNot: { th: 'รับสรุปทุกสายใน LINE ทันทีที่ AI วางสาย', en: 'Get every call summary in LINE the moment the AI hangs up.' },
  lineBtn: { th: 'เชื่อม LINE', en: 'Link LINE' },
  lineThis: { th: 'เชื่อม LINE นี้', en: 'Link this LINE' },
  lineTaken: { th: 'LINE นี้เชื่อมกับเบอร์อื่นแล้ว', en: 'This LINE is linked to another number.' },
  accountH: { th: 'บัญชี', en: 'Account' },
  language: { th: 'ภาษา', en: 'Language' },
  cancelLink: { th: 'ยกเลิกสมาชิก', en: 'Cancel membership' },
  cancelH: { th: 'ยกเลิกสมาชิก?', en: 'Cancel your membership?' },
  rCalls: { th: 'สายที่ AI รับแทน', en: 'calls answered' }, rScam: { th: 'สายน่าสงสัยที่กันไว้', en: 'suspicious calls stopped' },
  rPeople: { th: 'คนที่ปกป้อง', en: 'people protected' },
  pauseH: { th: 'พักไว้ก่อนก็ได้', en: 'You can pause instead' },
  pauseP: { th: 'กด ##002# ที่เครื่องที่ตั้งโอนไว้ สายจะกลับไปดังที่เครื่องตามปกติ สมาชิกยังอยู่ กลับมาเปิดด้วยรหัสเดิมได้ทุกเมื่อ', en: 'Dial ##002# on the forwarded phone and calls ring there as usual. Your membership stays — re-dial the same code anytime.' },
  cancelWhat: { th: 'ยกเลิกแล้ว AI หยุดรับสายแทนทันที และไม่มีการตัดเงินอีก ข้อมูลยังเก็บไว้ กลับมาเปิดใช้ได้ทุกเมื่อ', en: 'Cancel and the AI stops answering right away, with no further charges. Your data stays; reactivate anytime.' },
  cancelFwdWarn: { th: 'อย่าลืมกด ##002# ที่เครื่องของ%N% ไม่อย่างนั้นสายที่ยังโอนมาจะไม่มีใครรับ', en: 'Remember to dial ##002# on %N%’s phone, or forwarded calls will go unanswered.' },
  keep: { th: 'เก็บไว้ก่อน', en: 'Keep my membership' },
  cancelYes: { th: 'ยกเลิกสมาชิก', en: 'Cancel membership' },
  cancelledOk: { th: 'ยกเลิกแล้ว — อย่าลืมกด ##002# ที่เครื่องที่ตั้งโอนไว้', en: 'Cancelled — remember to dial ##002# on forwarded phones.' },
  eraseLink: { th: 'ลบบัญชีและข้อมูลทั้งหมด', en: 'Delete my account and all data' },
  eraseH: { th: 'ลบบัญชีและข้อมูลทั้งหมด?', en: 'Delete your account and all data?' },
  eraseWhat: { th: 'เราจะลบถาวร: บัญชีนี้ เบอร์ที่ปกป้อง %P% เบอร์ ผู้ดูแล %W% คน และสาย/บทสนทนาทั้งหมด %C% สาย — กู้คืนไม่ได้', en: 'Permanently deleted: this account, %P% protected number(s), %W% watcher(s) and all %C% call(s) with transcripts. This cannot be undone.' },
  eraseSms: { th: 'เราจะส่ง SMS บอกทุกเบอร์ที่ปกป้องให้กด ##002# เพื่อให้สายดังตามปกติ', en: 'We text every protected number to dial ##002# so calls ring normally.' },
  eraseAck: { th: 'ฉันเข้าใจว่าลบแล้วกู้คืนไม่ได้', en: 'I understand this cannot be undone' },
  eraseYes: { th: 'ลบถาวร', en: 'Delete permanently' },
  erasedH: { th: 'ลบบัญชีและข้อมูลแล้ว', en: 'Your account and data are deleted' },
  erasedP: { th: 'ขอบคุณที่ใช้ใครอะ อย่าลืมกด ##002# ที่เครื่องที่เคยตั้งโอนสายไว้', en: 'Thanks for using Krai-A. Remember to dial ##002# on any phone that forwarded calls.' },
  // errors
  e_invalid_phone: { th: 'รูปแบบเบอร์ไม่ถูกต้อง ใช้ 08x-xxx-xxxx', en: 'Invalid number — use 08x-xxx-xxxx' },
  'e_plan-limit': { th: 'ครบจำนวนเครื่องของแผนนี้แล้ว — อัปเกรดในตั้งค่า', en: 'Plan limit reached — upgrade in Settings' },
  'e_already-protected': { th: 'เบอร์นี้อยู่ในรายชื่อแล้ว', en: 'This number is already protected' },
  'e_protected-elsewhere': { th: 'เบอร์นี้ถูกปกป้องโดยอีกบัญชีแล้ว', en: 'Another account already protects this number' },
  'e_pending-elsewhere': { th: 'มีอีกบัญชีกำลังขอรหัสให้เบอร์นี้อยู่ ลองใหม่ใน 10 นาที', en: 'Another account is verifying this number — try again in 10 minutes' },
  'e_otp-pending': { th: 'เบอร์นี้มีรหัสอื่นรออยู่ ลองใหม่ใน 10 นาที', en: 'This number already has a code pending — try again in 10 minutes' },
  'e_demo-household': { th: 'บัญชีเดโมลบไม่ได้', en: 'The demo account cannot be deleted' },
  'e_sms-unavailable': { th: 'ระบบส่ง SMS ปิดชั่วคราว ลองใหม่ภายหลัง', en: 'SMS is unavailable right now — try again later' },
  'e_not-a-watcher': { th: 'เบอร์นี้ยังไม่อยู่ในรายชื่อผู้ดูแล', en: 'This number is not on the watcher list' },
  'e_too-many-requests': { th: 'ขอรหัสบ่อยเกินไป รอสักครู่แล้วลองใหม่', en: 'Too many codes requested — wait a bit and retry' },
  'e_sms-failed': { th: 'ส่ง SMS ไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'SMS failed — try again' },
  'e_wrong-code': { th: 'รหัสไม่ถูกต้อง', en: 'Wrong code' },
  'e_code-expired': { th: 'รหัสหมดอายุ กดขอรหัสใหม่', en: 'Code expired — request a new one' },
  'e_too-many-attempts': { th: 'กรอกผิดหลายครั้ง กดขอรหัสใหม่', en: 'Too many attempts — request a new code' },
  'e_seat-not-found': { th: 'หมดเวลายืนยัน กดขอรหัสใหม่', en: 'This request expired — request a new code' },
  'e_cannot-whitelist-self': { th: 'ใส่เบอร์ของตัวเองไม่ได้', en: 'You can’t add your own number' },
  e_generic: { th: 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', en: 'Something went wrong — try again' },
  left: { th: 'เหลือ %N% ครั้ง', en: '%N% tries left' },
};
export function t(key, vars = {}) {
  const e = S[key];
  let s = e ? e[i18n.lang] : key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`%${k}%`).join(v);
  return s;
}
export function errText(e) {
  const code = String(e?.message || e || '').replace('invalid-phone', 'invalid_phone');
  const base = S[`e_${code}`] ? t(`e_${code}`) : t('e_generic');
  const left = e?.data?.attemptsLeft;
  return left !== undefined && code === 'wrong-code' ? `${base} (${t('left', { N: left })})` : base;
}

const RELATIONS = ['mother', 'father', 'grandparent', 'child', 'partner', 'other'];
const ELDERS = new Set(['mother', 'father', 'grandparent']);
export const relationName = (label) => (S[`r_${label}`] ? t(`r_${label}`) : String(label || ''));
const avatarText = (label) => (S[`a_${label}`] ? t(`a_${label}`) : String(label || '?').slice(0, 2));

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
export const ICON = {
  home: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.5a3 3 0 0 1 0 6M21 20c0-2.6-1.5-4.5-3.8-5.2"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>', ' stroke-width="2.4"'),
  checkCircle: svg('<circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 10"/>', ' stroke-width="2"'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  shieldX: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  warn: svg('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  line: svg('<path d="M21 11.5c0-4.4-4-8-9-8s-9 3.6-9 8c0 4 3.2 7.3 7.6 7.9.3.1.7.2.8.5.1.2.1.6 0 .8l-.1.8c0 .2-.2.9.8.5s5.4-3.2 7.4-5.5c1-1.2 1.5-2.4 1.5-3z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', ' stroke-width="2.2"'),
};
const VERDICT_ICON = { SCAM: ICON.shieldX, LEGIT: ICON.checkCircle, UNSURE: ICON.help };

// ---------- OTP input: digits only, paste-strip, auto-submit on the 6th ----------
export function wireOtp(input, onComplete) {
  let last = '';
  const take = (raw) => {
    const d = String(raw || '').replace(/\D/g, '').slice(0, 6);
    if (input.value !== d) input.value = d;
    if (d.length === 6 && d !== last) { last = d; onComplete(d); }
    if (d.length < 6) last = '';
  };
  input.addEventListener('input', () => take(input.value));
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (text) { e.preventDefault(); take(text); }
  });
  return { reset() { last = ''; input.value = ''; } };
}

// Resend button with a countdown (default 60 s). Returns stop().
export function resendTimer(btn, seconds = 60) {
  let left = seconds;
  const paint = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? t('resendIn', { S: `0:${String(left).padStart(2, '0')}` }) : t('resend');
  };
  paint();
  const id = setInterval(() => { left -= 1; paint(); if (left <= 0) clearInterval(id); }, 1000);
  return () => clearInterval(id);
}

async function copyText(btn, text) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const old = btn.textContent;
  btn.textContent = t('copied');
  setTimeout(() => { btn.textContent = old; }, 1600);
}

// ---------- add a protected person (relation + phone -> OTP on THAT phone) ----------
// opts: { onDone(household, phone), defaultRelation, pending: {phone,label} (resume) }
export function mountAddPerson(el, opts = {}) {
  let relation = opts.pending?.label || opts.defaultRelation || 'mother';
  let phone = opts.pending?.phone || '';
  let busy = false;
  let stopTimer = () => {};

  const nameFor = () => (RELATIONS.includes(relation) && relation !== 'other' ? relationName(relation) : relation === 'other' ? t('r_other') : relation);

  function stepForm() {
    stopTimer();
    const custom = !RELATIONS.includes(relation) || relation === 'other';
    el.innerHTML = `<div class="m-stack">
      <h2 class="m-h2">${t('addH')}</h2>
      <div class="m-chips" role="radiogroup" aria-label="${esc(t('addH'))}">
        ${RELATIONS.map((r) => `<button type="button" class="m-chip" role="radio" data-rel="${r}" aria-checked="${r === relation || (r === 'other' && custom)}">${esc(relationName(r))}</button>`).join('')}
      </div>
      <div ${custom ? '' : 'hidden'} data-custom><label class="m-label" for="apName">${t('addName')}</label>
        <input id="apName" class="m-input" maxlength="24" autocomplete="off" value="${esc(custom && relation !== 'other' ? relation : '')}"></div>
      <div><label class="m-label" for="apPhone">${t('theirPhone')}</label>
        <input id="apPhone" class="m-input" type="tel" inputmode="tel" autocomplete="off" placeholder="08x-xxx-xxxx" value="${esc(phone ? fmtPhone(phone) : '')}">
        <p class="m-err" role="alert" id="apErr"></p></div>
      <button type="button" class="btn primary big m-btn-block" id="apSend">${t('sendCode')}</button>
      <p class="m-fine">${t('consent')}</p>
    </div>`;
    $$(el, '[data-rel]').forEach((b) => {
      b.onclick = () => {
        relation = b.dataset.rel;
        $$(el, '[data-rel]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        $(el, '[data-custom]').hidden = relation !== 'other';
      };
    });
    $(el, '#apSend').onclick = send;
    $(el, '#apPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  async function send() {
    if (busy) return;
    const input = $(el, '#apPhone');
    if (input) phone = input.value;
    if (relation === 'other') {
      const nm = ($(el, '#apName')?.value || '').trim();
      if (nm) relation = nm;
    }
    const errBox = $(el, '#apErr');
    if (!isThaiMobile(phone)) {
      errBox.textContent = t('e_invalid_phone');
      input?.setAttribute('aria-invalid', 'true');
      input?.focus();
      if (relation !== 'other' && !RELATIONS.includes(relation)) relation = 'other';
      return;
    }
    busy = true;
    try {
      const r = await api('/api/me/protected', { method: 'POST', auth: true, body: { phone, label: relation } });
      phone = r.phone;
      stepCode(r.devCode);
    } catch (e) {
      if (errBox) { errBox.textContent = errText(e); input?.setAttribute('aria-invalid', 'true'); input?.focus(); }
      if (relation !== 'other' && !RELATIONS.includes(relation)) relation = 'other';
    } finally { busy = false; }
  }

  function stepCode(devCode) {
    el.innerHTML = `<div class="m-stack">
      <h2 class="m-h2">${esc(t('codeFrom', { N: nameFor() }))}</h2>
      <p class="m-lead">${t('codeSentTo')} <b class="tnum">${esc(fmtPhone(phone))}</b> · <button type="button" class="m-link" id="apChange">${t('change')}</button></p>
      ${devCode ? `<div class="m-dev">${t('devCode')} <code>${esc(devCode)}</code></div>` : ''}
      <input id="apCode" class="m-input m-otp" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••" aria-label="${esc(t('codeFrom', { N: nameFor() }))}">
      <p class="m-err" role="alert" id="apErr"></p>
      <button type="button" class="btn ghost" id="apResend" disabled></button>
    </div>`;
    const code = $(el, '#apCode');
    const otp = wireOtp(code, verify);
    code.focus();
    $(el, '#apChange').onclick = stepForm;
    stopTimer = resendTimer($(el, '#apResend'));
    $(el, '#apResend').onclick = async () => {
      stopTimer();
      try {
        const r = await api('/api/me/protected', { method: 'POST', auth: true, body: { phone, label: relation } });
        stepCode(r.devCode);
      } catch (e) { $(el, '#apErr').textContent = errText(e); stopTimer = resendTimer($(el, '#apResend'), 0); }
    };
    async function verify(c) {
      if (busy) return;
      busy = true;
      $(el, '#apErr').textContent = '';
      try {
        const r = await api('/api/me/protected/verify', { method: 'POST', auth: true, body: { phone, code: c } });
        stopTimer();
        el.innerHTML = `<div class="su-verified" role="status"><span class="m-ok">${ICON.checkCircle}${t('verified')}</span></div>`;
        setTimeout(() => opts.onDone?.(r.household, phone), 700);
      } catch (e) {
        $(el, '#apErr').textContent = errText(e);
        code.setAttribute('aria-invalid', 'true');
        otp.reset();
        code.focus();
      } finally { busy = false; }
    }
  }

  if (opts.pending) stepCode(null); else stepForm();
  return { destroy: () => stopTimer() };
}

// ---------- generic phone -> 6-digit code flow (LIFF link, watcher invite) ----------
// opts: { title, lead, cta, codeLead?, request(phone) -> {devCode?}, verify(phone, code) -> any, onDone(result) }
export function mountPhoneOtp(el, opts) {
  let phone = '';
  let busy = false;
  let stopTimer = () => {};
  function stepPhone() {
    stopTimer();
    el.innerHTML = `<div class="m-stack"><h1 class="m-h1">${esc(opts.title)}</h1><p class="m-lead">${esc(opts.lead)}</p>
      <div><label class="m-label" for="poPhone">${t('phone')}</label>
      <input id="poPhone" class="m-input" type="tel" inputmode="tel" autocomplete="tel" placeholder="08x-xxx-xxxx" value="${esc(phone)}">
      <p class="m-err" role="alert" id="poErr"></p></div>
      <button type="button" class="btn primary big m-btn-block" id="poSend">${esc(opts.cta)}</button></div>`;
    const go = async () => {
      if (busy) return;
      phone = $(el, '#poPhone').value.trim();
      if (!isThaiMobile(phone)) {
        $(el, '#poErr').textContent = t('e_invalid_phone');
        $(el, '#poPhone').setAttribute('aria-invalid', 'true');
        return;
      }
      busy = true;
      try { const r = await opts.request(phone); stepCode(r?.devCode); }
      catch (e) { $(el, '#poErr').textContent = errText(e); $(el, '#poPhone').setAttribute('aria-invalid', 'true'); }
      finally { busy = false; }
    };
    $(el, '#poSend').onclick = go;
    $(el, '#poPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  function stepCode(devCode) {
    el.innerHTML = `<div class="m-stack"><h1 class="m-h1">${i18n.lang === 'th' ? 'กรอกรหัส 6 หลัก' : 'Enter the 6-digit code'}</h1>
      <p class="m-lead">${opts.codeLead ? esc(opts.codeLead) : t('codeSentTo')} <b class="tnum">${esc(fmtPhone(phone.replace(/[\s-]/g, '').replace(/^0/, '+66')))}</b> · <button type="button" class="m-link" id="poChange">${t('change')}</button></p>
      ${devCode ? `<div class="m-dev">${t('devCode')} <code>${esc(devCode)}</code></div>` : ''}
      <input id="poCode" class="m-input m-otp" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••" aria-label="${i18n.lang === 'th' ? 'รหัส 6 หลัก' : '6-digit code'}">
      <p class="m-err" role="alert" id="poErr"></p><button type="button" class="btn ghost" id="poResend" disabled></button></div>`;
    const code = $(el, '#poCode');
    const otp = wireOtp(code, async (c) => {
      if (busy) return;
      busy = true;
      $(el, '#poErr').textContent = '';
      try {
        const out = await opts.verify(phone, c);
        stopTimer();
        el.innerHTML = `<div class="su-verified" role="status"><span class="m-ok">${ICON.checkCircle}${t('verified')}</span></div>`;
        setTimeout(() => opts.onDone?.(out), 700);
      } catch (e) {
        $(el, '#poErr').textContent = opts.errorText?.(e) || errText(e);
        code.setAttribute('aria-invalid', 'true');
        otp.reset();
        code.focus();
      } finally { busy = false; }
    });
    code.focus();
    $(el, '#poChange').onclick = stepPhone;
    stopTimer = resendTimer($(el, '#poResend'));
    $(el, '#poResend').onclick = async () => {
      stopTimer();
      try { const r = await opts.request(phone); stepCode(r?.devCode); }
      catch (e) { $(el, '#poErr').textContent = errText(e); stopTimer = resendTimer($(el, '#poResend'), 0); }
    };
  }
  stepPhone();
  return { destroy: () => stopTimer() };
}

// ---------- forwarding setup for one protected phone ----------
// opts: { central, person:{phone,label,self,forwardingVerifiedAt}, onThisPhone, onVerified }
export function mountForwarding(el, { central, person, onThisPhone, onVerified } = {}) {
  let mode = ELDERS.has(person.label) ? 'all' : 'missed';
  let timer = null;
  const codes = central?.codes;
  if (!codes) { el.innerHTML = ''; return { destroy() {} }; }
  const who = person.self ? '' : relationName(person.label);

  const dial = (href, code, label, alt) => `<div class="m-code-row">
      <a class="m-dial${alt ? ' alt' : ''}" href="${esc(href)}"><small>${esc(label)}</small><b>${esc(code)}</b></a>
      <button type="button" class="m-copy" data-copy="${esc(code)}">${t('copy')}</button></div>`;

  function render() {
    const alt = !onThisPhone;
    const dials = mode === 'all'
      ? dial(codes.allTel, codes.all, onThisPhone ? t('tapToDial') : t('stepDial'), alt)
      : dial(codes.noAnswerTel, codes.noAnswer, t('dialMissed'), alt) + dial(codes.busyTel, codes.busy, t('dialBusy'), alt);
    const shareCode = mode === 'all' ? codes.all : `${codes.noAnswer} + ${codes.busy}`;
    const share = `https://line.me/R/share?text=${encodeURIComponent(t('shareText', { C: shareCode }))}`;
    const testLine = t(mode === 'all' ? 'testAll' : 'testMissed', { P: fmtPhone(person.phone) });
    const verified = !!person.forwardingVerifiedAt;
    el.innerHTML = `<div class="m-fwd">
      <div>
        <span class="m-label" id="fwdModeL">${t('modeH')}</span>
        <div class="m-chips" role="radiogroup" aria-labelledby="fwdModeL">
          <button type="button" class="m-chip" role="radio" data-mode="all" aria-checked="${mode === 'all'}">${t('modeAll')}</button>
          <button type="button" class="m-chip" role="radio" data-mode="missed" aria-checked="${mode === 'missed'}">${t('modeMissed')}</button>
        </div>
        <p class="m-fine" style="margin-top:8px">${t(mode === 'all' ? 'modeAllP' : 'modeMissedP')}</p>
      </div>
      ${onThisPhone ? '' : `<ol class="m-steps"><li><span><b>${esc(t('onTheirPhone', { N: who }))}</b> — ${t('stepOpen')}</span></li><li><span>${t('stepDial')}</span></li><li><span>${t('stepWait')}</span></li></ol>`}
      <div class="m-codes">${dials}</div>
      ${onThisPhone ? '' : `<a class="btn secondary m-btn-block" href="${esc(share)}" target="_blank" rel="noopener">${ICON.line}${t('shareLine')}</a>`}
      <div><span class="m-label">${t('testH')}</span><p class="m-fine" style="font-size:var(--fs-sm);color:var(--ink2)">${esc(testLine)}</p></div>
      <div class="m-wait${verified ? ' ok' : ''}" role="status" aria-live="polite"><span class="m-pulse" aria-hidden="true"></span><span>${verified ? t('fwdWorks') : t('waiting')}</span></div>
      <p class="m-fine m-row">${t('cancelFwd')} <a class="m-tel" href="${esc(codes.cancelTel)}">${esc(codes.cancel)}</a></p>
    </div>`;
    $$(el, '[data-mode]').forEach((b) => { b.onclick = () => { mode = b.dataset.mode; render(); }; });
    $$(el, '[data-copy]').forEach((b) => { b.onclick = () => copyText(b, b.dataset.copy); });
  }

  // Poll while visible: the first real forwarded call stamps forwardingVerifiedAt.
  async function poll() {
    if (document.hidden || person.forwardingVerifiedAt) return;
    try {
      const { household } = await api('/api/me/household', { auth: true });
      const p = household.protected.find((x) => x.phone === person.phone);
      if (p?.forwardingVerifiedAt) {
        person.forwardingVerifiedAt = p.forwardingVerifiedAt;
        render();
        onVerified?.(household);
      }
    } catch { /* keep waiting */ }
  }
  render();
  if (!person.forwardingVerifiedAt) timer = setInterval(poll, 6000);
  return { destroy() { clearInterval(timer); } };
}

// ---------- sheet (native <dialog>) ----------
function openSheet(title, build, { onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = 'm-sheet';
  d.setAttribute('aria-label', title);
  d.innerHTML = `<div class="m-sheet-in"><div class="m-sheet-head"><h2 class="m-h2">${esc(title)}</h2><button type="button" class="m-x" aria-label="${i18n.lang === 'th' ? 'ปิด' : 'Close'}">×</button></div><div class="m-sheet-body"></div></div>`;
  document.body.appendChild(d);
  let cleanup = () => {};
  const close = () => d.close();
  d.addEventListener('close', () => { cleanup(); d.remove(); onClose?.(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  $(d, '.m-x').onclick = close;
  d.showModal();
  const head = $(d, '.m-sheet-head h2');
  head.setAttribute('tabindex', '-1');
  head.focus();
  const out = build($(d, '.m-sheet-body'), close);
  if (out?.destroy) cleanup = out.destroy;
  return { close };
}

// =====================================================================
// The member app
// =====================================================================
const TABS = ['home', 'people', 'settings'];
const TAB_ICON = { home: ICON.home, people: ICON.people, settings: ICON.gear };
const TAB_KEY = { home: 'tHome', people: 'tPeople', settings: 'tSettings' };
const LEGACY_TAB = { status: 'home', calls: 'home', allow: 'people', settings: 'settings' };

// opts: { platform: 'web'|'liff', onAuthFail(), linkLine(): Promise<idToken> }
export function mountMemberApp(root, opts = {}) {
  const platform = opts.platform || 'web';
  const app = { me: null, hh: null, quota: null, calls: null, plans: null, status: null, err: {}, fatal: false, loaded: false, showAllCalls: false };
  const params = new URLSearchParams(location.search);
  const flash = params.get('paid') ? 'paid' : params.get('cancelled') ? 'cancelled' : '';
  if (flash) { try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* keep */ } }
  let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : (LEGACY_TAB[params.get('tab')] || 'home');
  let live = [];
  const destroyLive = () => { live.forEach((c) => c.destroy?.()); live = []; };

  root.innerHTML = `<div class="ma${platform === 'liff' ? ' liff' : ''}">
    <header class="ma-top"><a class="brand" href="${platform === 'liff' ? '#home' : '/'}"><span class="dot" aria-hidden="true">ค</span><span data-th="ใครอะ" data-en="Krai-A">ใครอะ</span></a><span class="ma-who" id="maWho"></span></header>
    <aside class="ma-rail"><a class="brand" href="/"><span class="dot" aria-hidden="true">ค</span><span data-th="ใครอะ" data-en="Krai-A">ใครอะ</span></a>
      <nav aria-label="Member">${TABS.map((k) => `<a class="ma-tab" href="#${k}" data-tab="${k}">${TAB_ICON[k]}<span data-tab-label="${k}"></span></a>`).join('')}</nav>
      <div class="ma-rail-foot"><span class="m-fine tnum" id="maWho2"></span><a class="m-link quiet" href="/" id="maBack"></a></div></aside>
    <div class="ma-toast" id="maToast" role="status" aria-live="polite" hidden></div>
    <main class="ma-main" id="maMain">
      <section class="ma-sec" id="sec-home" aria-labelledby="h-home"></section>
      <section class="ma-sec" id="sec-people" hidden></section>
      <section class="ma-sec" id="sec-settings" hidden></section>
    </main>
    <nav class="ma-tabs" aria-label="Member">${TABS.map((k) => `<a class="ma-tab" href="#${k}" data-tab="${k}">${TAB_ICON[k]}<span data-tab-label="${k}"></span></a>`).join('')}</nav>
  </div>`;
  const main = $(root, '#maMain');
  const sec = (k) => $(root, `#sec-${k}`);

  function paintShell() {
    $$(root, '[data-tab-label]').forEach((s) => { s.textContent = t(TAB_KEY[s.dataset.tabLabel]); });
    $$(root, '[data-tab]').forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    TABS.forEach((k) => { sec(k).hidden = k !== tab; });
    const who = app.me ? fmtPhone(app.me.ownerPhone) : '';
    $(root, '#maWho').textContent = who;
    $(root, '#maWho2').textContent = who;
    $(root, '#maBack').textContent = t('backSite');
    $(root, '#maBack').hidden = platform === 'liff';
    applyLang();
  }

  function go(k) {
    if (!TABS.includes(k)) k = 'home';
    tab = k;
    if (location.hash.slice(1) !== k) { try { history.replaceState(null, '', `#${k}`); } catch { /* keep */ } }
    render();
    main.scrollIntoView?.({ block: 'start' });
    window.scrollTo?.(0, 0);
  }
  $$(root, '[data-tab]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); go(a.dataset.tab); }; });
  window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (TABS.includes(k) && k !== tab) go(k); });

  async function load() {
    const get = (p) => api(p, { auth: true });
    const [me, hh, quota, calls, plans, status] = await Promise.allSettled([
      get('/api/me'), get('/api/me/household'), get('/api/me/quota'), get('/api/me/calls'), api('/api/plans'), api('/api/status'),
    ]);
    app.fatal = false;
    if (me.status === 'rejected') {
      if (me.reason?.status === 401) { opts.onAuthFail?.(); return; }
      app.fatal = true;
    } else app.me = me.value.member;
    app.fatal = app.fatal || hh.status === 'rejected';
    if (hh.status === 'fulfilled') app.hh = hh.value.household;
    app.quota = quota.status === 'fulfilled' ? quota.value : null;
    app.err.quota = quota.status === 'rejected';
    app.calls = calls.status === 'fulfilled' ? calls.value.calls : null;
    app.err.calls = calls.status === 'rejected';
    if (plans.status === 'fulfilled') app.plans = plans.value;
    if (status.status === 'fulfilled') app.status = status.value;
    app.loaded = true;
  }

  async function refresh() { await load(); render(); }
  // Every button-driven change goes through here: a failed request (4xx,
  // offline) is announced in the toast and the view still re-syncs — nothing
  // is left as an unhandled rejection.
  async function mutate(fn) {
    try { await fn(); } catch (e) { toast(errText(e)); }
    finally { await refresh().catch(() => {}); }
  }
  let toastTimer = null;
  function toast(msg) {
    const el = $(root, '#maToast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  // ---------- render ----------
  function render() {
    destroyLive();
    if (!app.loaded) {
      sec('home').innerHTML = `<div class="ma-skel" aria-label="${esc(t('loading'))}"></div><div class="ma-skel"></div>`;
      paintShell();
      return;
    }
    if (app.fatal) {
      TABS.forEach((k) => { sec(k).innerHTML = ''; });
      sec(tab).innerHTML = `<div class="ma-card"><div class="ma-empty err">${ICON.warn}<b>${t('loadFail')}</b><p>${t('loadFailSub')}</p><button type="button" class="btn primary" data-retry>${t('retry')}</button></div></div>`;
      $(sec(tab), '[data-retry]').onclick = () => { app.loaded = false; render(); refresh(); };
      paintShell();
      return;
    }
    renderHome();
    renderPeople();
    renderSettings();
    paintShell();
  }

  const names = (list) => list.map((p) => (p.self ? t('r_self') : relationName(p.label))).join(' · ');
  // Who withdrew consent recently (server keeps 30 days) — one line each.
  const withdrewNotes = () => (app.hh.withdrawn || [])
    .map((w) => `<p class="m-lead" role="status" style="color:var(--unsure-ink)">${esc(t('withdrewNote', { N: relationName(w.label), P: fmtPhone(w.phone), D: fmtDate(w.at) }))}</p>`).join('');

  function homeState() {
    if (!app.me.active) return 'cancelled';
    if (app.hh.lifecycle?.state === 'lapsed') return 'lapsed';
    if (app.hh.central.state !== 'live') return 'waitlist';
    if (!app.hh.protected.length) return 'empty';
    if (!app.hh.protected.some((p) => p.forwardingVerifiedAt && !p.suspendedAt)) return 'setup';
    return 'live';
  }

  function banner() {
    if (flash === 'paid') return { cls: 'ok', text: t('paidOk') };
    if (flash === 'cancelled') return { cls: '', text: t('paidCancel') };
    const q = app.quota;
    const lc = app.hh.lifecycle || {};
    if (lc.state === 'grace') return lc.kind === 'plan'
      ? { cls: 'warn', text: t('graceLeftPlan', { D: lc.daysLeft }), action: 'settings', label: t('renew') }
      : { cls: 'warn', text: t('graceLeft', { D: lc.daysLeft }), action: 'settings', label: t('pickPlan') };
    const sn = app.hh.seatNotice;
    if (sn) {
      const who = names(app.hh.protected.filter((p) => sn.phones.includes(p.phone)));
      const key = sn.state === 'soon' ? 'seatSoon' : sn.state === 'stopped' ? 'seatStopped' : 'seatGrace';
      return { cls: sn.state === 'soon' ? '' : 'warn', text: t(key, { N: who, D: sn.daysLeft ?? '' }), action: 'seat', label: t('renew') };
    }
    if (lc.state === 'paid' && lc.daysLeft !== null && lc.daysLeft <= 2) return { cls: '', text: t('planEndsSoon', { D: lc.daysLeft }), action: 'settings', label: t('renew') };
    if (q && (q.autoTopup?.manualPrompt || q.autoTopup?.due || q.remaining <= 2 || q.callsRemaining <= 1)) return { cls: 'warn', text: t('quotaLow'), action: 'settings', label: t('topUp') };
    if (lc.state === 'trial' && app.me.trialDaysLeft <= 3) return { cls: '', text: t('trialLeft', { D: app.me.trialDaysLeft }), action: 'settings', label: t('pickPlan') };
    return null;
  }

  function renderHome() {
    const el = sec('home');
    const state = homeState();
    const hh = app.hh;
    let html = '';
    const b = state === 'live' ? banner() : null;
    if (b) html += `<div class="ma-banner ${b.cls}" role="status"><span>${esc(b.text)}</span>${b.action === 'seat' ? (billingOn() ? `<button type="button" class="btn small secondary" data-buyseat>${esc(b.label)}</button><span class="m-fine" id="seatMsg" role="status"></span>` : `<span class="m-fine">${t('payUnavailable')}</span>`) : b.action ? `<button type="button" class="btn small secondary" data-go="${b.action}">${esc(b.label)}</button>` : ''}</div>`;

    if (state === 'live') {
      const on = hh.protected.filter((p) => p.forwardingVerifiedAt && !p.suspendedAt);
      const off = hh.protected.filter((p) => !p.forwardingVerifiedAt && !p.suspendedAt);
      html += `<div class="ma-card ma-status"><span class="m-live"><span class="m-pulse" aria-hidden="true"></span>${t('live')}</span>
        <h1 id="h-home">${t('liveH')} <span class="who">${esc(names(on))}</span> ✓</h1>
        <p>${t('liveP')}</p>
        ${off.length ? `<p class="ma-pending">${esc(t('pendingFwd', { N: names(off) }))} · <button type="button" class="m-link" data-person="${esc(off[0].phone)}">${t('setNow')}</button></p>` : ''}</div>`;
      html += callsCard() + quotaCard();
    } else if (state === 'lapsed') {
      html += `<div class="ma-card ma-status off">
        <h1 id="h-home">${t(app.hh.lifecycle.denied ? 'deniedH' : app.hh.lifecycle.kind === 'plan' ? 'lapsedHPlan' : 'lapsedH')}</h1><p>${t(app.hh.lifecycle.denied ? 'deniedP' : app.hh.lifecycle.kind === 'plan' ? 'lapsedPPlan' : 'lapsedP')}</p>
        <div style="margin-top:20px"><button type="button" class="btn primary big" data-go="settings">${t(app.hh.lifecycle.kind === 'plan' ? 'renew' : 'pickPlan')}</button></div></div>`;
      html += callsCard();
    } else if (state === 'cancelled') {
      html += `<div class="ma-card ma-status off">
        <h1 id="h-home">${t('offH')}</h1><p>${esc(t('offP', { D: fmtDate(app.me.cancelledAt) }))}</p>
        <div style="margin-top:20px"><button type="button" class="btn primary big" data-react>${t('reactivate')}</button></div></div>`;
      html += callsCard();
    } else if (state === 'waitlist') {
      const ch = hh.waitlist?.channel || 'sms';
      html += `<div class="ma-card ma-status">
        <h1 id="h-home">${t('waitH')}</h1><p>${t('waitP')}</p>
        <div class="m-row" style="margin-top:20px"><span class="m-fine">${t('waitVia')}</span>
          <div class="ma-seg" role="group" aria-label="${esc(t('waitVia'))}">
            <button type="button" data-wait="sms" aria-pressed="${ch === 'sms'}">${t('waitSms')} · ${esc(fmtPhone(app.me.ownerPhone))}</button>
            <button type="button" data-wait="line" aria-pressed="${ch === 'line'}">${t('waitLine')}</button></div></div>
        <p class="m-fine" id="waitMsg" role="status" style="margin-top:8px"></p></div>`;
      html += hh.protected.length
        ? `<div class="ma-card"><p class="m-lead" style="margin:0">${esc(t('waitReady', { N: names(hh.protected) }))}</p></div>`
        : `<div class="ma-card"><div class="ma-empty">${ICON.people}<b>${t('waitAdd')}</b><button type="button" class="btn secondary" data-add>${t('addFirst')}</button></div></div>`;
    } else if (state === 'empty') {
      html += `<div class="ma-card"><h1 class="m-h1" id="h-home">${t('emptyH')}</h1>${withdrewNotes()}<p class="m-lead">${t('emptyP')}</p>
        <div class="m-choices" style="margin-top:20px">
          <button type="button" class="m-choice" data-add><span class="m-ava">${esc(t('a_mother'))}</span><span class="m-choice-t"><b>${t('pickLoved')}</b><span>${t('pickLovedSub')}</span></span></button>
          <button type="button" class="m-choice" data-self><span class="m-ava">${esc(t('a_self'))}</span><span class="m-choice-t"><b>${t('pickSelf')}</b><span class="tnum">${esc(fmtPhone(app.me.ownerPhone))}</span></span></button>
        </div><p class="m-err" role="alert" id="selfErr"></p></div>`;
    } else { // setup: the whole screen until forwarding works
      const p = hh.protected[0];
      html += `<div class="ma-card"><h1 class="m-h1" id="h-home">${esc(p.self ? t('setupHSelf') : t('setupH', { N: relationName(p.label) }))}</h1>
        <p class="m-lead tnum">${esc(fmtPhone(p.phone))}</p><div id="homeFwd" style="margin-top:20px"></div></div>`;
    }
    // A household that already had calls (e.g. the only protected person
    // withdrew) keeps its history and quota under the onboarding/setup card.
    if (['empty', 'setup', 'waitlist'].includes(state) && (app.calls || []).length) html += callsCard() + quotaCard();
    el.innerHTML = html;

    if (state === 'setup') {
      const p = hh.protected[0];
      live.push(mountForwarding($(el, '#homeFwd'), { central: hh.central, person: { ...p }, onThisPhone: p.self, onVerified: () => setTimeout(refresh, 1200) }));
    }
    $$(el, '[data-go]').forEach((x) => { x.onclick = () => go(x.dataset.go); });
    const buySeat = $(el, '[data-buyseat]');
    if (buySeat) buySeat.onclick = () => checkout({ kind: 'seat' }, $(el, '#seatMsg'));
    $$(el, '[data-person]').forEach((x) => { x.onclick = () => personSheet(x.dataset.person); });
    $$(el, '[data-add]').forEach((x) => { x.onclick = addSheet; });
    const self = $(el, '[data-self]');
    if (self) self.onclick = async () => {
      try { await api('/api/me/protected/self', { method: 'POST', auth: true }); await refresh(); } catch (e) { $(el, '#selfErr').textContent = errText(e); }
    };
    const react = $(el, '[data-react]');
    if (react) react.onclick = () => mutate(() => api('/api/me/reactivate', { method: 'POST', auth: true }));
    $$(el, '[data-wait]').forEach((x) => {
      x.onclick = async () => {
        try {
          const r = await api('/api/me/waitlist', { method: 'POST', auth: true, body: { channel: x.dataset.wait } });
          app.hh = r.household;
          $$(el, '[data-wait]').forEach((y) => y.setAttribute('aria-pressed', String(y === x)));
          $(el, '#waitMsg').textContent = t('waitSaved');
        } catch (e) { $(el, '#waitMsg').textContent = errText(e); }
      };
    });
    wireCalls(el);
  }

  function callsCard() {
    const head = `<div class="ma-card-head"><h2 class="m-h2">${t('callsH')}</h2>${app.quota ? `<span class="m-fine">${esc(t('callsMonth', { N: app.quota.callsUsed }))}</span>` : ''}</div>`;
    if (app.err.calls) {
      return `<div class="ma-card">${head}<div class="ma-empty err">${ICON.warn}<b>${t('callsFail')}</b><button type="button" class="btn secondary" data-retry-calls>${t('retry')}</button></div></div>`;
    }
    const calls = app.calls || [];
    if (!calls.length) {
      const first = app.hh.protected[0];
      return `<div class="ma-card">${head}<div class="ma-empty">${ICON.phone}<b>${t('noCalls')}</b><p>${t('noCallsP')}</p>${first && app.me.active ? `<button type="button" class="btn secondary" data-person="${esc(first.phone)}">${t('howTest')}</button>` : ''}</div></div>`;
    }
    const shown = app.showAllCalls ? calls.slice(0, 20) : calls.slice(0, 5);
    const who = (phone) => {
      const p = app.hh.protected.find((x) => x.phone === phone);
      return p ? (p.self ? t('r_self') : relationName(p.label)) : '';
    };
    return `<div class="ma-card">${head}<div class="ma-list">${shown.map((c) => {
      const v = c.verdict?.verdict || 'UNSURE';
      const reason = i18n.lang === 'th' ? (c.verdict?.reason || '') : (c.verdict?.reasonEn || c.verdict?.reason || '');
      const to = c.protectedPhone && who(c.protectedPhone) ? ` · ${t('to')} ${who(c.protectedPhone)}` : '';
      return `<details class="ma-call"><summary><span class="v ${v}">${VERDICT_ICON[v] || ICON.help}</span>
        <span class="ma-item-main"><b class="tnum">${esc(fmtPhone(c.callerPhone))}</b><span>${esc(fmtTime(c.startedAt))}${esc(to)}</span>${reason ? `<span style="white-space:normal">${esc(reason)}</span>` : ''}</span>
        <span class="ma-pill ${v === 'SCAM' ? 'bad' : v === 'LEGIT' ? 'ok' : 'warn'}">${t(`v${v}`)}</span></summary>
        <div class="ma-turns"><span class="m-label">${t('transcript')}</span>${(c.turns || []).map((x) => `<p class="ma-turn"><b>${x.role === 'caller' ? t('caller') : t('ai')}</b>${esc(x.text)}</p>`).join('')}
        <div class="m-row" data-delrow="${esc(c.id)}"><button type="button" class="m-link quiet" data-export="${esc(c.id)}">${t('exportEv')}</button><button type="button" class="m-link danger" data-delcall="${esc(c.id)}">${t('delCall')}</button></div></div></details>`;
    }).join('')}</div>${calls.length > 5 && !app.showAllCalls ? `<button type="button" class="btn ghost" data-allcalls>${t('showAll')}</button>` : ''}</div>`;
  }

  function wireCalls(el) {
    $$(el, '[data-delcall]').forEach((b) => {
      b.onclick = () => {
        const row = b.closest('[data-delrow]');
        row.innerHTML = `<span class="m-fine" role="alert">${t('delCallQ')}</span><button type="button" class="btn small secondary" data-delyes style="color:var(--scam-ink)">${t('delCallYes')}</button>`;
        $(row, '[data-delyes]').onclick = () => mutate(() => api(`/api/me/calls/${encodeURIComponent(b.dataset.delcall)}`, { method: 'DELETE', auth: true }));
      };
    });
    const retry = $(el, '[data-retry-calls]');
    if (retry) retry.onclick = refresh;
    const all = $(el, '[data-allcalls]');
    if (all) all.onclick = () => { app.showAllCalls = true; render(); };
    $$(el, '[data-export]').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api(`/api/me/calls/${encodeURIComponent(b.dataset.export)}/export`, { auth: true });
          const url = URL.createObjectURL(new Blob([JSON.stringify(r.bundle, null, 2)], { type: 'application/json' }));
          const a = document.createElement('a');
          a.href = url; a.download = `krai-a-evidence-${b.dataset.export.slice(5, 13)}.json`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch { /* nothing to save */ }
      };
    });
  }

  function quotaCard() {
    if (app.err.quota || !app.quota) {
      return `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('quotaH')}</h2></div><div class="ma-empty err">${ICON.warn}<b>${t('quotaFail')}</b><button type="button" class="btn secondary" data-retry-calls>${t('retry')}</button></div></div>`;
    }
    const q = app.quota;
    if (q.trial?.active) {
      const used = Math.max(0, q.trial.calls - q.trial.callsRemaining);
      const tp = Math.min(100, Math.round((used / Math.max(1, q.trial.calls)) * 100));
      return `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('quotaH')}</h2></div>
        <div class="ma-quota-n">${esc(t('trialCallsUsed', { N: used, T: q.trial.calls }))}</div>
        <div class="ma-meter${tp >= 80 ? ' low' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${tp}" aria-label="${esc(t('quotaH'))}"><i style="width:${tp}%"></i></div>
        <p class="m-fine tnum">${esc(t('trialUntil', { D: fmtDate(q.trial.endsAt), T: q.trial.calls }))}</p></div>`;
    }
    const usedPct = Math.max(q.quota ? q.used / q.quota : 0, q.callsQuota ? q.callsUsed / q.callsQuota : 0);
    const pct = Math.min(100, Math.round(usedPct * 100));
    return `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('quotaH')}</h2></div>
      <div class="ma-quota-n">${esc(t('quotaLeft', { M: q.remaining }))}</div>
      <div class="ma-meter${pct >= 80 ? ' low' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(t('quotaH'))}"><i style="width:${pct}%"></i></div>
      <p class="m-fine tnum">${esc(t('quotaSub', { C: q.callsRemaining, Q: q.callsQuota, D: fmtDate(q.resetAt) }))}</p></div>`;
  }

  // ---------- People ----------
  function renderPeople() {
    const el = sec('people');
    const hh = app.hh;
    const plan = planMeta();
    const canAdd = hh.protected.length + hh.pendingProtected.length < hh.protectedMax;
    const people = hh.protected.map((p) => `<li><button type="button" class="ma-item-btn" data-person="${esc(p.phone)}">
        <span class="m-ava${p.forwardingVerifiedAt && !p.suspendedAt ? ' on' : ''}">${esc(avatarText(p.self ? 'self' : p.label))}</span>
        <span class="ma-item-main"><b>${esc(p.self ? t('r_self') : relationName(p.label))}</b><span>${esc(fmtPhone(p.phone))}</span></span>
        ${p.suspendedAt ? `<span class="ma-pill bad">${t('suspended')}</span>` : `<span class="ma-pill ${p.forwardingVerifiedAt ? 'ok' : 'warn'}">${p.forwardingVerifiedAt ? t('guarding') : t('needsFwd')}</span>`}<span class="ma-chev" aria-hidden="true"></span></button></li>`).join('')
      + hh.pendingProtected.map((p) => `<li><button type="button" class="ma-item-btn" data-pending="${esc(p.phone)}" data-label="${esc(p.label)}">
        <span class="m-ava">${esc(avatarText(p.label))}</span>
        <span class="ma-item-main"><b>${esc(relationName(p.label))}</b><span>${esc(fmtPhone(p.phone))} · ${t('pendingSub')}</span></span>
        <span class="ma-pill">${t('pendingOtp')}</span><span class="ma-chev" aria-hidden="true"></span></button></li>`).join('');
    let html = `<h1 class="ma-title">${t('tPeople')}</h1>${withdrewNotes() ? `<div class="ma-banner">${withdrewNotes()}</div>` : ''}`;
    html += `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('peopleH')}</h2><span class="m-fine">${hh.protected.length}/${hh.protectedMax}</span></div>`;
    if (!people) {
      html += `<div class="ma-empty">${ICON.shield}<b>${t('noPeople')}</b><p>${t('noPeopleP')}</p>${canAdd ? `<button type="button" class="btn primary" data-add>${t('addFirst')}</button>` : ''}</div>`;
    } else {
      html += `<ul class="ma-list">${people}</ul>`;
      html += canAdd
        ? `<button type="button" class="btn secondary m-btn-block" data-add style="margin-top:12px">${ICON.plus}${t('addPerson')}</button>`
        : `<p class="m-fine" style="margin-top:12px">${esc(t('capReached', { P: plan.name, N: hh.protectedMax }))}${seatsAllowed(plan.id)
          ? (hh.protectedMax < (app.plans?.extraSeat?.maxNumbers || app.plans?.maxNumbers || 5) && billingOn() ? ` · <button type="button" class="m-link" data-buyseat>${esc(t('buySeat', { P: seatPrice() }))}</button>` : '')
          : ` · <button type="button" class="m-link" data-go="settings">${t('upgrade')}</button>`}</p><p class="m-fine" id="seatMsg" role="status"></p>`;
    }
    html += '</div>';

    if (hh.watchersUnlimited || hh.watchersMax > 0) {
      const canW = hh.watchersUnlimited || hh.watchers.length < hh.watchersMax;
      html += `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('watchersH')}</h2><span class="m-fine">${hh.watchers.length}${hh.watchersUnlimited ? '' : `/${hh.watchersMax}`}</span></div>
        <p class="m-fine">${t('watchersP')}</p>
        ${hh.watchers.length ? `<ul class="ma-list">${hh.watchers.map((w) => `<li class="ma-item"><span class="m-ava${w.line ? ' on' : ''}">${ICON.user}</span>
          <span class="ma-item-main"><b class="tnum">${esc(fmtPhone(w.phone))}</b><span>${w.line ? t('lineOk') : t('lineNo')}</span></span>
          ${w.line ? '' : `<a class="mini" href="${esc(inviteShare())}" target="_blank" rel="noopener">${t('invite')}</a>`}
          <button type="button" class="mini del" data-unwatch="${esc(w.phone)}">${t('remove')}</button></li>`).join('')}</ul>` : `<p class="m-fine" style="margin:12px 0">${t('noWatchers')}</p>`}
        ${canW ? `<div class="m-row" style="margin-top:12px"><input class="m-input" style="flex:1;min-width:0;min-height:48px;font-size:17px" id="wPhone" type="tel" inputmode="tel" autocomplete="off" placeholder="08x-xxx-xxxx" aria-label="${esc(t('addWatcher'))}"><button type="button" class="btn secondary" id="wAdd">${t('addWatcher')}</button></div><p class="m-err" role="alert" id="wErr"></p>` : ''}
      </div>`;
    }

    // Known contacts + safe word are not used on real calls yet (voiceTurn
    // judges without the whitelist), so the app does not offer or promise them.
    el.innerHTML = html;

    $$(el, '[data-person]').forEach((x) => { x.onclick = () => personSheet(x.dataset.person); });
    $$(el, '[data-pending]').forEach((x) => { x.onclick = () => addSheet({ pending: { phone: x.dataset.pending, label: x.dataset.label } }); });
    $$(el, '[data-add]').forEach((x) => { x.onclick = () => addSheet(); });
    $$(el, '[data-go]').forEach((x) => { x.onclick = () => go(x.dataset.go); });
    const seat = $(el, '[data-buyseat]');
    if (seat) seat.onclick = () => checkout({ kind: 'seat' }, $(el, '#seatMsg'));
    $$(el, '[data-unwatch]').forEach((x) => { x.onclick = () => mutate(() => api('/api/me/watchers', { method: 'DELETE', auth: true, body: { phone: x.dataset.unwatch } })); });
    const wAdd = $(el, '#wAdd');
    if (wAdd) wAdd.onclick = async () => {
      const input = $(el, '#wPhone');
      if (!isThaiMobile(input.value)) {
        $(el, '#wErr').textContent = t('e_invalid_phone');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      try { await api('/api/me/watchers', { method: 'POST', auth: true, body: { phone: input.value } }); await refresh(); } catch (e) { $(el, '#wErr').textContent = errText(e); }
    };
  }

  function inviteShare() {
    const id = app.status?.liffId;
    const link = id ? `https://liff.line.me/${id}?watch=1` : `${location.origin}/liff.html?watch=1`;
    return `https://line.me/R/share?text=${encodeURIComponent(t('inviteText') + link)}`;
  }

  function addSheet(extra = {}) {
    let done = false;
    openSheet(t('addPerson'), (body, close) => mountAddPerson(body, {
      ...extra,
      onDone: async (household, phone) => {
        done = true;
        close();
        app.hh = household;
        await refresh();
        personSheet(phone);
      },
    }), {
      // Closed mid-way (e.g. at the code step): the server may now hold a
      // pending request — re-fetch so its "รอรหัส" row shows at once.
      onClose: () => { if (!done) refresh(); },
    });
  }

  function personSheet(phone) {
    const p = app.hh.protected.find((x) => x.phone === phone);
    if (!p) return;
    const title = p.self ? t('r_self') : relationName(p.label);
    openSheet(title, (body, close) => {
      const verified = !!p.forwardingVerifiedAt;
      body.innerHTML = `<p class="m-lead tnum" style="margin-top:-8px">${esc(fmtPhone(p.phone))}</p>
        ${verified ? `<div class="m-wait ok" style="margin-top:16px"><span class="m-pulse" aria-hidden="true"></span><span>${esc(t('guardSince', { D: fmtDate(p.forwardingVerifiedAt) }))}</span></div>
          <details class="ma-details" style="margin-top:12px"><summary>${t('seeCodes')}</summary><div id="psFwd" style="padding:8px 0"></div></details>`
        : '<div id="psFwd" style="margin-top:16px"></div>'}
        <div class="ma-quiet-zone" style="flex-direction:column;align-items:center;gap:8px" id="psRemove"><button type="button" class="m-link danger" id="psRm">${t('unprotect')}</button></div>`;
      // No forwarding codes while the household is lapsed: a forward the gate
      // rejects means that person silently misses every call.
      const lapsed = app.hh.lifecycle?.state === 'lapsed';
      if (lapsed && !verified) $(body, '#psFwd').innerHTML = `<p class="m-lead">${t(app.hh.lifecycle.denied ? 'deniedP' : 'lapsedP')}</p>`;
      const ctl = app.hh.central.state === 'live' && !lapsed
        ? mountForwarding($(body, '#psFwd'), { central: app.hh.central, person: { ...p }, onThisPhone: p.self, onVerified: () => refresh() })
        : { destroy() {} };
      $(body, '#psRm').onclick = () => {
        $(body, '#psRemove').innerHTML = `<p class="m-fine" style="text-align:center" role="alert">${t('unprotectWarn')}</p>
          <button type="button" class="btn secondary" id="psRmYes" style="color:var(--scam-ink)">${t('unprotectYes')}</button>`;
        $(body, '#psRmYes').onclick = async () => { close(); await mutate(() => api('/api/me/protected', { method: 'DELETE', auth: true, body: { phone: p.phone } })); };
      };
      return ctl;
    });
  }

  // ---------- Settings ----------
  // Plan names, prices and limits all come from /api/plans (no plan ids in
  // this file): `name` may be a string or {th,en}; otherwise the id's family
  // ("solo-99" -> "Solo"). Seats can be bought on plans that say so
  // (`seats: true`), falling back to the family-* convention.
  const planLabel = (id, meta = {}) => {
    const n = meta.name;
    if (n && typeof n === 'object') return n[i18n.lang] || n.en || n.th;
    if (typeof n === 'string' && n) return n;
    const base = String(id || '').split('-')[0];
    return base ? base[0].toUpperCase() + base.slice(1) : '';
  };
  const seatsAllowed = (id) => {
    const on = app.plans?.extraSeat?.allowedOn;
    return Array.isArray(on) ? on.includes(id) : (app.plans?.plans?.[id]?.numbers || 1) > 1;
  };
  function planMeta() {
    const id = app.me.plan;
    const pm = app.me.planMeta || app.plans?.plans?.[id] || {};
    return { ...pm, id, name: planLabel(id, pm) };
  }
  const money = (n, cur) => `${cur}${Number(n).toLocaleString('en-US')}`;
  const price = (p) => (i18n.lang === 'th' ? money(p.price, '฿') : money(p.usd ?? p.price, '$'));
  const seatInfo = () => app.plans?.extraSeat || app.plans?.addon || null;
  const seatPrice = () => (seatInfo() ? price(seatInfo()) : '');
  // Annual is THB-only today (annualUsd null): offered in the Thai view only.
  const yearPrice = (p) => (i18n.lang === 'th' ? (p?.annual ? money(p.annual, '฿') : '') : (p?.annualUsd ? money(p.annualUsd, '$') : ''));
  // Payments open? (/api/me/quota canTopup mirrors the server's Stripe config.)
  const billingOn = () => !!app.quota?.canTopup;

  function lcPill() {
    const lc = app.hh.lifecycle || {};
    if (lc.state === 'trial' && lc.daysLeft !== null) return `<span class="ma-pill ok">${esc(t('inTrial', { D: lc.daysLeft }))}</span>`;
    if (lc.state === 'paid' && lc.endsAt) return `<span class="ma-pill ok">${esc(t('paidUntil', { D: fmtDate(lc.endsAt) }))}</span>`;
    if (lc.state === 'grace' || lc.state === 'lapsed') return `<span class="ma-pill warn">${esc(t(lc.kind === 'plan' ? 'lapsedHPlan' : 'lapsedH'))}</span>`;
    return '';
  }

  function renderSettings() {
    const el = sec('settings');
    const pm = planMeta();
    const plans = app.plans?.plans || {};
    const q = app.quota;
    // Which plan/interval to PAY for (a local choice — the plan changes when paid).
    const sel = plans[app.selPlan] ? app.selPlan : (plans[app.hh.intendedPlan] && app.hh.lifecycle?.state !== 'paid' ? app.hh.intendedPlan : pm.id);
    const selMeta = plans[sel] || pm;
    if (!app.selInterval) { try { app.selInterval = localStorage.getItem('krai-a_interval') || ''; } catch { app.selInterval = ''; } }
    const interval = app.selInterval === 'year' && yearPrice(selMeta) ? 'year' : 'month';
    const yearSave = selMeta.annual && selMeta.price && i18n.lang === 'th' ? money(selMeta.price * 12 - selMeta.annual, '฿') : '';
    const canPay = billingOn() && selMeta.purchasable?.[interval] !== false;
    const payLabel = interval === 'year' ? t('payYear', { P: yearPrice(selMeta) }) : t('payMonth', { P: price(selMeta) });
    const gifts = i18n.lang === 'th' && billingOn() ? Object.values(app.plans?.gifts || {}).filter((g) => g.purchasable) : [];
    const lineLinked = !!app.me.lineUserId;
    // One primary per screen: paying wins once the trial/plan has ended.
    const urgent = ['grace', 'lapsed'].includes(app.hh.lifecycle?.state);
    const lineCls = urgent ? 'secondary' : 'primary';
    const lineAction = platform === 'liff'
      ? (lineLinked ? '' : `<button type="button" class="btn ${lineCls}" id="lineLink">${ICON.line}${t('lineThis')}</button>`)
      : (lineLinked ? '' : `<a class="btn ${lineCls}" href="/liff.html">${ICON.line}${t('lineBtn')}</a>`);
    let html = `<h1 class="ma-title">${t('tSettings')}</h1>`;
    html += `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('planH')}</h2></div>
      <div class="ma-kv"><b style="text-align:left">${esc(pm.name)} · ${esc(price(pm))}${t('perMonth')}</b>${lcPill()}</div>
      <p class="m-fine" style="margin-top:8px">${esc(t('planIncl', { N: pm.numbers ?? 1, M: pm.quota ?? 0, C: pm.calls ?? 0 }))}</p>
      <div class="m-chips" role="radiogroup" aria-label="${esc(t('planH'))}" style="margin:16px 0 12px">${Object.keys(plans).map((id) => `<button type="button" class="m-chip" role="radio" data-plan="${esc(id)}" aria-checked="${id === sel}">${esc(planLabel(id, plans[id]))} · ${esc(price(plans[id]))}</button>`).join('')}</div>
      ${yearPrice(selMeta) ? `<div class="ma-seg" role="group" aria-label="${esc(t('planH'))}" style="margin-bottom:12px"><button type="button" data-interval="month" aria-pressed="${interval === 'month'}">${t('perMonthShort')}</button><button type="button" data-interval="year" aria-pressed="${interval === 'year'}">${t('perYearShort')}${yearSave ? ` · ${esc(t('yearSave', { S: yearSave }))}` : ''}</button></div>` : ''}
      <div><button type="button" class="btn ${urgent ? 'primary' : 'secondary'}" id="payPlan"${canPay ? '' : ' disabled aria-describedby="payMsg"'}>${esc(payLabel)}</button></div><p class="m-fine" id="payMsg" role="status" style="margin-top:8px">${billingOn() ? '' : t('payUnavailable')}</p>
      ${gifts.length ? `<details class="ma-details"><summary>${t('giftH')}</summary><div style="padding:4px 0 8px"><p class="m-fine">${t('giftP')}</p>
        ${gifts.map((g) => `<div class="ma-kv"><span>${esc(t('giftBtn', { N: planLabel(g.plan, plans[g.plan]) }))}</span><button type="button" class="mini" data-gift="${esc(g.id)}">${esc(money(g.price, '฿'))}</button></div>`).join('')}
      </div></details>` : ''}
      ${q ? `<details class="ma-details" style="margin-top:8px"><summary>${t('topupH')}</summary><div style="padding:4px 0 8px">
        <p class="m-fine">${t('topupP')}</p>
        ${Object.entries(q.packs || {}).map(([id, p]) => `<div class="ma-kv"><span>+${p.minutes} ${i18n.lang === 'th' ? 'นาที' : 'min'} · +${p.calls} ${i18n.lang === 'th' ? 'สาย' : 'calls'}</span>${q.canTopup ? `<button type="button" class="mini" data-pack="${esc(id)}">${esc(price(p))}</button>` : `<b>${esc(price(p))}</b>`}</div>`).join('')}
        ${q.canTopup ? '' : `<p class="m-fine" style="margin-top:8px">${t('payUnavailable')}</p>`}
        <label class="ma-kv" style="cursor:${q.canTopup ? 'pointer' : 'not-allowed'}"><span>${t('autoH')}</span><input type="checkbox" id="autoOn" ${q.autoTopup?.enabled ? 'checked' : ''}${q.canTopup ? '' : ' disabled'} style="width:22px;height:22px;accent-color:var(--ink)"></label>
        ${q.autoTopup?.enabled ? `<p class="m-fine">${q.payMethod === 'card' ? t('autoCard') : t('autoManual')}</p>` : ''}
      </div></details>` : ''}</div>`;
    html += `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('lineH')}</h2></div>
      <p class="m-lead" style="margin:0 0 ${lineAction ? '16px' : '0'}">${lineLinked ? t('lineLinked') : t('lineNot')}</p>${lineAction}<p class="m-err" role="alert" id="lineErr"></p></div>`;
    html += `<div class="ma-card"><div class="ma-card-head"><h2 class="m-h2">${t('accountH')}</h2></div>
      <div class="ma-kv"><span>${t('phone')}</span><b>${esc(fmtPhone(app.me.ownerPhone))}</b></div>
      <div class="ma-kv"><span>${t('language')}</span><div class="ma-seg" role="group" aria-label="${esc(t('language'))}"><button type="button" data-lang-set="th" aria-pressed="${i18n.lang === 'th'}" lang="th">ไทย</button><button type="button" data-lang-set="en" aria-pressed="${i18n.lang === 'en'}" lang="en">English</button></div></div>
      ${platform === 'liff' ? '' : `<div class="ma-kv"><a class="m-link quiet" href="/">${t('backSite')}</a><button type="button" class="m-link quiet" id="logout">${t('logout')}</button></div>`}</div>`;
    html += app.me.active
      ? `<div class="ma-quiet-zone"><button type="button" class="m-link quiet" id="cancelOpen">${t('cancelLink')}</button></div>`
      : `<div class="ma-card"><p class="m-lead" style="margin:0 0 16px">${esc(t('offP', { D: fmtDate(app.me.cancelledAt) }))}</p><button type="button" class="btn primary" data-react>${t('reactivate')}</button></div>`;
    html += `<div class="ma-quiet-zone" style="padding-top:0"><button type="button" class="m-link quiet" id="eraseOpen">${t('eraseLink')}</button></div>`;
    el.innerHTML = html;

    $$(el, '[data-plan]').forEach((b) => { b.onclick = () => { app.selPlan = b.dataset.plan; renderSettings(); applyLang(); }; });
    $$(el, '[data-interval]').forEach((b) => { b.onclick = () => { app.selInterval = b.dataset.interval; renderSettings(); applyLang(); }; });
    $(el, '#payPlan').onclick = () => checkout({ kind: 'plan', plan: sel, interval }, $(el, '#payMsg'));
    $$(el, '[data-gift]').forEach((b) => { b.onclick = () => checkout({ kind: 'gift', gift: b.dataset.gift }, $(el, '#payMsg')); });
    $$(el, '[data-pack]').forEach((b) => { b.onclick = () => checkout({ kind: 'topup', pack: b.dataset.pack }, $(el, '#payMsg')); });
    const auto = $(el, '#autoOn');
    if (auto) auto.onchange = () => mutate(() => api('/api/me/auto-topup', { method: 'POST', auth: true, body: { enabled: auto.checked } }));
    $$(el, '[data-lang-set]').forEach((b) => { b.onclick = () => { i18n.lang = b.dataset.langSet; }; });
    const lo = $(el, '#logout');
    if (lo) lo.onclick = () => opts.onLogout?.();
    const link = $(el, '#lineLink');
    if (link) link.onclick = async () => {
      try {
        const idToken = await opts.linkLine?.();
        await api('/api/me/link-line', { method: 'POST', auth: true, body: { idToken } });
        await refresh();
      } catch (e) { $(el, '#lineErr').textContent = e.message === 'line-already-linked' ? t('lineTaken') : errText(e); }
    };
    const react = $(el, '[data-react]');
    if (react) react.onclick = () => mutate(() => api('/api/me/reactivate', { method: 'POST', auth: true }));
    const co = $(el, '#cancelOpen');
    if (co) co.onclick = cancelSheet;
    $(el, '#eraseOpen').onclick = eraseSheet;
  }

  async function checkout(body, box) {
    if (!billingOn()) { box.textContent = t('payUnavailable'); return; } // never a doomed request
    box.textContent = t('payGo');
    try {
      const s = await api('/api/billing/checkout', { method: 'POST', auth: true, body: { ...body, region: i18n.lang === 'th' ? 'th' : 'intl', ...(platform === 'liff' ? { from: 'liff' } : {}) } });
      if (platform === 'liff' && window.liff?.openWindow) window.liff.openWindow({ url: s.url, external: true });
      else location.href = s.url;
    } catch (e) {
      box.textContent = ['billing-unconfigured', 'price-unconfigured'].includes(e.message) ? t('payUnavailable') : t('payFailed');
    }
  }

  function cancelSheet() {
    const calls = app.calls || [];
    const month = (app.quota?.period) || new Date().toISOString().slice(0, 7);
    const thisMonth = calls.filter((c) => String(c.startedAt || '').startsWith(month));
    const scams = calls.filter((c) => c.verdict?.verdict === 'SCAM').length;
    const forwarded = app.hh.protected.filter((p) => p.forwardingVerifiedAt);
    openSheet(t('cancelH'), (body, close) => {
      body.innerHTML = `<div class="ma-recap"><div><b>${thisMonth.length}</b><span>${t('rCalls')}</span></div><div><b>${scams}</b><span>${t('rScam')}</span></div><div><b>${app.hh.protected.length}</b><span>${t('rPeople')}</span></div></div>
        <h3 class="m-h2" style="font-size:var(--fs-body)">${t('pauseH')}</h3><p class="m-lead" style="margin-top:4px">${t('pauseP')}</p>
        <p class="m-lead" style="margin-top:16px;color:var(--ink)">${t('cancelWhat')}</p>
        ${forwarded.length ? `<p class="m-lead" style="color:var(--scam-ink)">${esc(t('cancelFwdWarn', { N: names(forwarded) }))}</p>` : ''}
        <div class="m-stack" style="margin-top:20px"><button type="button" class="btn primary big m-btn-block" id="keep">${t('keep')}</button>
        <div style="text-align:center"><button type="button" class="m-link danger" id="doCancel">${t('cancelYes')}</button></div></div>`;
      $(body, '#keep').onclick = close;
      $(body, '#doCancel').onclick = async () => { close(); await mutate(() => api('/api/me/cancel', { method: 'POST', auth: true })); go('home'); };
    });
  }

  // PDPA erasure: in-page confirm (no window.confirm), explicit acknowledgement.
  function eraseSheet() {
    const prot = app.hh.protected.length + app.hh.pendingProtected.length;
    openSheet(t('eraseH'), (body, close) => {
      body.innerHTML = `<p class="m-lead" style="margin-top:0;color:var(--ink)">${esc(t('eraseWhat', { P: prot, W: app.hh.watchers.length, C: (app.calls || []).length }))}</p>
        ${prot ? `<p class="m-lead">${t('eraseSms')}</p>` : ''}
        <label class="ma-kv" style="cursor:pointer;margin-top:12px"><span>${t('eraseAck')}</span><input type="checkbox" id="eraseAck" style="width:22px;height:22px;accent-color:var(--scam)"></label>
        <p class="m-err" role="alert" id="eraseErr"></p>
        <div class="m-stack" style="margin-top:16px"><button type="button" class="btn primary big m-btn-block" id="eraseKeep">${t('keep')}</button>
        <div style="text-align:center"><button type="button" class="m-link danger" id="eraseYes" disabled>${t('eraseYes')}</button></div></div>`;
      $(body, '#eraseAck').onchange = (e) => { $(body, '#eraseYes').disabled = !e.target.checked; };
      $(body, '#eraseKeep').onclick = close;
      $(body, '#eraseYes').onclick = async () => {
        try {
          await api('/api/me', { method: 'DELETE', auth: true, body: { confirm: true } });
          close();
          session.token = null;
          root.innerHTML = `<div class="ma${platform === 'liff' ? ' liff' : ''}"><main class="ma-main"><div class="ma-card"><div class="ma-empty">${ICON.checkCircle}<b>${t('erasedH')}</b><p>${t('erasedP')}</p>${platform === 'liff' ? '' : `<a class="btn secondary" href="/">${t('backSite')}</a>`}</div></div></main></div>`;
        } catch (e) { $(body, '#eraseErr').textContent = errText(e); }
      };
    });
  }

  window.addEventListener('krai-a:lang', render);
  render();
  refresh();
  return { refresh };
}
