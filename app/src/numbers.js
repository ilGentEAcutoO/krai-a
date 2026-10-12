// AI numbers.
// Mode B (default business model): ONE central shared AI number per country.
// A call is answered only when it was forwarded from a registered protected
// number (see household.js gate). No number configured = waitlist: signup
// works, but no forwarding code is handed out — forwarding to a number nobody
// owns would silently drop the protected person's calls.
// Mode A (legacy demo): one pool number per household.
import { config } from './config.js';

// Per-country central numbers, read at call time so a new number goes live
// with an env change only. HARD RULE: the number must be domestic for its
// country — a foreign number turns every forwarded leg into an IDD call
// billed to the protected person.
export const CENTRAL_COUNTRIES = {
  TH: { env: 'CENTRAL_NUMBER_TH', prefix: '+66', launch: true },
  VN: { env: 'CENTRAL_NUMBER_VN', prefix: '+84' },
  PH: { env: 'CENTRAL_NUMBER_PH', prefix: '+63' },
  ID: { env: 'CENTRAL_NUMBER_ID', prefix: '+62' },
  MY: { env: 'CENTRAL_NUMBER_MY', prefix: '+60' },
};

export function centralNumber(country = 'TH') {
  const c = CENTRAL_COUNTRIES[country];
  if (!c) return '';
  const n = String(process.env[c.env] || '').replace(/[\s-]/g, '');
  return /^\+\d{8,15}$/.test(n) && n.startsWith(c.prefix) ? n : '';
}

// state: 'live' (number configured) | 'waitlist' (launch country, number
// not ready yet) | 'coming-soon' (country staged for later).
export function centralStatus(country = 'TH') {
  const number = centralNumber(country);
  if (number) return { country, state: 'live', number };
  return { country, state: CENTRAL_COUNTRIES[country]?.launch ? 'waitlist' : 'coming-soon', number: '' };
}

// +66812345678 -> 0812345678 (Thai dial format); other countries keep E.164.
export function toLocalNumber(e164) {
  const p = String(e164 || '');
  return p.startsWith('+66') ? `0${p.slice(3)}` : p;
}

// GSM call-forwarding codes. `all` (**21*) suits elders who should never
// pick up unknown calls; noAnswer (**61*) + busy (**67*) keep the phone
// ringing first. ##002# cancels every forward. tel: links escape '#'.
export function forwardingCodes(number) {
  const n = toLocalNumber(number);
  const tel = (code) => `tel:${code.replace(/#/g, '%23')}`;
  const codes = {
    all: `**21*${n}#`,
    noAnswer: `**61*${n}#`,
    busy: `**67*${n}#`,
    cancel: '##002#',
  };
  return {
    ...codes,
    allTel: tel(codes.all),
    noAnswerTel: tel(codes.noAnswer),
    busyTel: tel(codes.busy),
    cancelTel: tel(codes.cancel),
  };
}

// ---- Mode A pool (legacy demo) ----
const MOCK_POOL = [
  '+6621000142', '+6621000143', '+6621000144', '+6621000145',
  '+6621000146', '+6621000147', '+6621000148', '+6621000149',
];
const assigned = new Set();

export function markAssigned(number) {
  assigned.add(number);
}

// Seats that expire before OTP verification give their number back.
export function releaseNumber(number) {
  assigned.delete(number);
}

export async function assignNumber() {
  // Mode A only: these are demo numbers nobody owns. Mode B signups never
  // call this (household.js provisionMember uses the central number).
  const free = MOCK_POOL.find((n) => !assigned.has(n));
  if (!free) return { ok: false, error: 'pool-exhausted' };
  assigned.add(free);
  return { ok: true, number: free, source: config.twilioAccountSid ? 'pool (twilio-linked)' : 'pool (mock)' };
}

export function poolStatus() {
  return { total: MOCK_POOL.length, assigned: assigned.size, free: MOCK_POOL.length - assigned.size };
}
