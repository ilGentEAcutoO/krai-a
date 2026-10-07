// Public-repo leak guard. Fails if private paths or secrets are tracked or
// staged. Run: node scripts/check-public.js [--self-test]
// Enforced by: .git/hooks/pre-push (local) + .github/workflows (CI).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const FORBIDDEN_PATHS = [
  { re: /^instruction\// },
  { re: /(^|\/)\.env($|\.[^/]*$)/, except: /\.example$/ }, // .env.example is a safe template
  { re: /^agent-temp\// },
  { re: /^\.playwright-mcp\// },
];

const SELF = 'scripts/check-public.js';

const SECRET_PATTERNS = [
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{20,}/ },
  { name: 'twilio-sid', re: /AC[0-9a-f]{32}/ },
  { name: 'line-id', re: /\bU[0-9a-f]{32}\b/ },
  { name: 'slack-token', re: /\bxox[bap]-[0-9A-Za-z-]{10,}/ },
  { name: 'sk-live', re: /\bsk-live-[0-9A-Za-z]{10,}/ },
  { name: 'private-key', re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { name: 'bearer-token', re: /Bearer [A-Za-z0-9._~+/-]{20,}/ },
];

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zip']);

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scanFiles(files) {
  const hits = [];
  for (const f of files) {
    for (const { re, except } of FORBIDDEN_PATHS) {
      if (re.test(f) && !(except && except.test(f))) hits.push(`${f}: forbidden path (${re})`);
    }
    if (f === SELF) continue; // this guard's own patterns + fixtures would match itself
    const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    let size = 0;
    try { size = statSync(f).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = readFileSync(f); } catch { continue; }
    // Scan UTF-8 and, when null bytes exist, UTF-16 too (PowerShell Out-File
    // writes UTF-16 by default — a leak hiding in it must still be caught).
    const text = buf.includes(0) ? buf.toString('utf8') + '\n' + buf.toString('utf16le') : buf.toString('utf8');
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push(`${f}: possible ${name}`);
    }
  }
  return hits;
}

function selfTest() {
  // Fixtures are split-joined so this file itself never contains a contiguous
  // secret-looking string (GitHub push protection would block the push).
  const cases = [
    ['AI' + 'zaSyFakeKeyForTest1234567890abcdefg', 'google-api-key', true],
    ['AC006d21' + '665387bc189f80e9f6e78fb4ef', 'twilio-sid', true],
    ['U08a8864' + '39f7da786b6e358be1bb72c9e', 'line-id', true],
    ['Authorization: `Bearer ${token}`', 'bearer-token', false],
    ['Bea' + 'rer abcdefghij1234567890XYZ', 'bearer-token', true],
    ['-----BE' + 'GIN RSA PRIVATE KEY-----', 'private-key', true],
    ['GEMINI_API_KEY=', 'google-api-key', false],
    ['instruction/work/pricing.html', null, false], // path rule tested below
  ];
  let fail = 0;
  for (const [sample, pattern, want] of cases) {
    if (!pattern) continue;
    const got = SECRET_PATTERNS.find((p) => p.name === pattern).re.test(sample);
    if (got !== want) { console.error(`self-test FAIL: ${pattern} on ${JSON.stringify(sample)}`); fail += 1; }
  }
  const blocked = (f) => FORBIDDEN_PATHS.some(({ re, except }) => re.test(f) && !(except && except.test(f)));
  if (!blocked('instruction/work/pricing.html')) { console.error('self-test FAIL: path rule'); fail += 1; }
  if (blocked('app/src/store.js')) { console.error('self-test FAIL: path false positive'); fail += 1; }
  if (!blocked('app/.env')) { console.error('self-test FAIL: .env must be blocked'); fail += 1; }
  if (blocked('app/.env.example')) { console.error('self-test FAIL: .env.example must pass'); fail += 1; }
  console.log(fail ? `self-test: ${fail} FAIL` : 'self-test: ok');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--self-test')) selfTest();

const files = [...new Set([...git(['ls-files']), ...git(['diff', '--cached', '--name-only'])])];
const hits = scanFiles(files.filter((f) => !f.startsWith('instruction/.git/')));
if (hits.length) {
  console.error('public-guard FAILED:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`public-guard ok (${files.length} files)`);
