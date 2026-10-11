// AI number pool (mode A: one number per household).
// Mock pool serves signup instantly; when Twilio is configured, purchase
// happens through the API and the pool is only a fallback.
import { config } from './config.js';

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
  // TODO(production): buy a THAI number via Twilio IncomingPhoneNumbers API
  // when TWILIO_* is configured. Pool remains for demo/staging.
  // HARD RULE: the AI number must ALWAYS be Thai. A foreign number turns every
  // forwarded leg into an IDD call billed to the owner — unacceptable.
  const free = MOCK_POOL.find((n) => !assigned.has(n));
  if (!free) return { ok: false, error: 'pool-exhausted' };
  assigned.add(free);
  return { ok: true, number: free, source: config.twilioAccountSid ? 'pool (twilio-linked)' : 'pool (mock)' };
}

export function poolStatus() {
  return { total: MOCK_POOL.length, assigned: assigned.size, free: MOCK_POOL.length - assigned.size };
}
