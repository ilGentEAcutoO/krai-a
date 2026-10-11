// LINE webhook: follow/message/postback for the call-screener bot.
// Secrets via env only. Always reply fast; never throw out of the handler.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getMemberByLineUserId } from '../store.js';

const liffUrl = (state) => `https://liff.line.me/${config.liffId}?liff.state=${state}`;

export function verifyLineSignature(rawBody, signature) {
  if (!signature || !config.lineChannelSecret) return false;
  const mac = createHmac('sha256', config.lineChannelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(mac);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function reply(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.lineChannelAccessToken}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) throw new Error(`line-reply-${res.status}`);
}

const linkFlex = (title, text, state, label = 'เปิดใครอ่ะ') => ({
  type: 'flex',
  altText: title,
  contents: {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text, size: 'sm', color: '#666666', wrap: true },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical',
      contents: [{ type: 'button', style: 'primary', color: '#06c755', action: { type: 'uri', label, uri: liffUrl(state) } }],
    },
  },
});

const HELP_TEXT = 'พิมพ์: สถานะ (เบอร์ AI + วิธีโอนสาย) · สาย (สายล่าสุด) · หรือกดปุ่มเปิดใครอ่ะตั้งค่าทุกอย่างได้เลยค่ะ';

export async function handleFollow(event) {
  await reply(event.replyToken, [linkFlex(
    'สวัสดีค่ะ 👋 ใครอ่ะมาแล้ว!',
    'ผูกบัญชีเพื่อรับแจ้งเตือนสายต้องสงสัย กดปุ่มด้านล่างได้เลยค่ะ',
    'status',
  )]);
}

export async function handleMessage(event) {
  const text = (event.message?.text || '').trim();
  const member = getMemberByLineUserId(event.source?.userId || '');
  if (/^(help|ช่วยเหลือ|ช่วย|เมนู|menu)/i.test(text)) {
    await reply(event.replyToken, [{ type: 'text', text: HELP_TEXT }]);
    return;
  }
  if (/^(สถานะ|status|เบอร์)/i.test(text)) {
    if (!member) {
      await reply(event.replyToken, [linkFlex('ยังไม่ได้ผูกบัญชี', 'กดปุ่มเพื่อผูกบัญชี LINE กับใครอ่ะก่อนนะคะ', 'status', 'ผูกบัญชี')]);
      return;
    }
    await reply(event.replyToken, [{
      type: 'text',
      text: `เบอร์ AI ของคุณ: ${member.aiNumber}\nตั้งโอนสาย: **21*${member.aiNumber.replace(/^\+/, '')}# แล้วกดโทรออก\nโอนสาย${member.forwardingConfirmed ? 'แล้ว ✓' : 'หรือยัง? ตั้งแล้วกดยืนยันในแอปนะคะ'}`,
    }]);
    return;
  }
  if (/^(สาย|call|ล่าสุด)/i.test(text)) {
    await reply(event.replyToken, [linkFlex('ดูสายล่าสุด', 'เปิดดูสายที่ใครอ่ะรับให้ พร้อมดาวน์โหลดหลักฐานแจ้งความค่ะ', 'calls', 'ดูสายล่าสุด')]);
    return;
  }
  await reply(event.replyToken, [linkFlex('ใครอ่ะช่วยอะไรดีคะ?', HELP_TEXT, 'status')]);
}

export async function handlePostback(event) {
  const data = new URLSearchParams(event.postback?.data || '');
  const action = data.get('action') || 'help';
  await handleMessage({ ...event, message: { type: 'text', text: action } });
}

export function lineWebhookHandler(req, res) {
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  if (!verifyLineSignature(raw, req.headers['x-line-signature'])) {
    return res.status(401).json({ error: 'bad-signature' });
  }
  const events = req.body?.events || [];
  // Acknowledge fast; process async (LINE retries on timeout).
  res.json({ ok: true, events: events.length });
  (async () => {
    for (const event of events) {
      try {
        if (event.type === 'follow') await handleFollow(event);
        else if (event.type === 'message' && event.message?.type === 'text') await handleMessage(event);
        else if (event.type === 'postback') await handlePostback(event);
      } catch (e) {
        console.error('[line] event failed:', event.type, e.message);
      }
    }
  })();
}
