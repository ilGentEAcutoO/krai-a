// deploy-cloudrun.sh in DRY_RUN=1 mode: prints every command, runs none.
// Guards the deploy shape: image-only + targeted env updates (never
// --set-env-vars, which wipes the live env), required secrets, single
// instance, judging switch, rollback + smoke steps, and the two site roles
// (SERVICE + SITE_MODE: krai-a = product, krai-a-demo = demo): the hackathon
// role never carries business secrets.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const skip = bash.status !== 0 ? 'bash not available' : false;

function dryRun(env = {}) {
  const r = spawnSync('bash', ['deploy-cloudrun.sh'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DRY_RUN: '1', PROJECT_ID: 'test-proj', SERVICE: 'krai-a', SITE_MODE: 'product', ...env },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('deploy-cloudrun.sh (DRY_RUN=1)', { skip }, () => {
  it('runs nothing, exits 0, and never replaces the live env', () => {
    const { status, out } = dryRun();
    assert.equal(status, 0, out);
    assert.match(out, /DRY RUN/);
    assert.doesNotMatch(out, /--set-env-vars/);
    assert.match(out, /--update-env-vars/);
  });

  it('sets the decided env and keeps AI test switches off', () => {
    const { out } = dryRun();
    for (const kv of ['GEMINI_MODEL=gemini-3.5-flash-lite', 'IDENTIFY_MODE=B', 'DEMO_TEXT_API=0', 'PUBLIC_BASE_URL=https://krai-a.com', 'SITE_MODE=product',
      'LIVE_MAX_SECONDS=120', 'LIVE_MAX_PER_IP_HOUR=3', 'LIVE_MAX_PER_DAY=300', 'NOTIFY_ADAPTERS=console,line']) {
      assert.ok(out.includes(kv), kv);
    }
    assert.match(out, /--remove-env-vars[ =]AI_OFFLINE,AI_LIVE_TESTS/);
    assert.ok(dryRun({ PUBLIC_BASE_URL: 'https://x.run.app' }).out.includes('PUBLIC_BASE_URL=https://x.run.app'));
  });

  it('adds the new secrets, keeps the existing ones, and checks they exist', () => {
    const { out } = dryRun();
    for (const s of ['GEMINI_API_KEY=gemini-api-key:latest', 'THSMS_API_KEY=thsms-api-key:latest', 'TWILIO_AUTH_TOKEN=twilio-auth-token:latest',
      'LINE_CHANNEL_ACCESS_TOKEN=line-channel-token:latest', 'LINE_CHANNEL_SECRET=krai-a-line-secret:latest',
      'TYPESAFE_API_KEY=typesafe-api-key:latest', 'TRIAL_TOMBSTONE_SECRET=trial-tombstone-secret:latest']) {
      assert.ok(out.includes(s), s);
    }
    for (const s of ['typesafe-api-key', 'trial-tombstone-secret']) assert.match(out, new RegExp(`secrets describe ${s}`));
  });

  it('deploys without the TypeSafe secret (Jev off, WARN), but aborts on a missing required one', () => {
    const noJev = dryRun({ DRY_RUN_ABSENT: 'typesafe-api-key' });
    assert.equal(noJev.status, 0, noJev.out);
    assert.match(noJev.out, /WARN missing optional secret: typesafe-api-key/);
    assert.match(noJev.out, /Jev disabled in prod/);
    assert.match(noJev.out, /--update-secrets/);
    assert.doesNotMatch(noJev.out, /TYPESAFE_API_KEY=typesafe-api-key/);
    assert.ok(noJev.out.includes('GEMINI_API_KEY=gemini-api-key:latest'));
    assert.ok(noJev.out.includes('TRIAL_TOMBSTONE_SECRET=trial-tombstone-secret:latest'));

    for (const name of ['trial-tombstone-secret', 'gemini-api-key']) {
      const r = dryRun({ DRY_RUN_ABSENT: name });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`missing secret: ${name}`));
      assert.match(r.out, /aborting/);
      assert.doesNotMatch(r.out, /builds submit/);
    }
  });

  it('single instance with session affinity and a long timeout; JUDGING=1 keeps one warm', () => {
    const normal = dryRun().out;
    assert.match(normal, /--max-instances 1/);
    assert.match(normal, /--session-affinity/);
    assert.match(normal, /--timeout 900/);
    assert.match(normal, /--min-instances 0/);
    assert.doesNotMatch(normal, /--no-cpu-throttling/);
    const judging = dryRun({ JUDGING: '1' }).out;
    assert.match(judging, /--min-instances 1/);
    assert.match(judging, /--no-cpu-throttling/);
  });

  it('records the current revision, prints a rollback command, and smoke-tests', () => {
    const { out } = dryRun();
    assert.match(out, /latestReadyRevisionName/);
    assert.match(out, /update-traffic krai-a .*--to-revisions/);
    for (const probe of ['/api/status', '/api/members', '/demo.html', 'content-security-policy']) assert.ok(out.toLowerCase().includes(probe.toLowerCase()), probe);
  });
});

describe('deploy-cloudrun.sh site roles (SERVICE + SITE_MODE)', { skip }, () => {
  const deployLine = (out) => out.split('\n').find((l) => l.startsWith('+ gcloud run deploy')) || '';

  it('needs both SERVICE and SITE_MODE, and refuses a service in the wrong role', () => {
    assert.notEqual(dryRun({ SERVICE: '' }).status, 0);
    assert.notEqual(dryRun({ SITE_MODE: '' }).status, 0);
    assert.notEqual(dryRun({ SITE_MODE: 'staging' }).status, 0);
    const wrong = dryRun({ SERVICE: 'krai-a', SITE_MODE: 'demo' });
    assert.equal(wrong.status, 2, wrong.out);
    assert.match(wrong.out, /refusing: krai-a serves the product role/);
    assert.doesNotMatch(wrong.out, /builds submit/);
    assert.equal(dryRun({ SERVICE: 'krai-a', SITE_MODE: 'demo', ROLE_OVERRIDE: '1' }).status, 0);
  });

  it('hackathon role (krai-a-demo, demo): Gemini/Jev/reCAPTCHA only, business secrets and env removed', () => {
    const { status, out } = dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo' });
    assert.equal(status, 0, out);
    assert.match(out, /service: krai-a-demo {2}site mode: demo/);
    const d = deployLine(out);
    assert.match(d, /gcloud run deploy krai-a-demo /);
    assert.match(d, /SITE_MODE=demo/);
    assert.match(d, /PUBLIC_BASE_URL=https:\/\/demo\.krai-a\.com[;']/);
    assert.match(d, /PRODUCT_BASE_URL=https:\/\/krai-a\.com/);
    assert.match(d, /NOTIFY_ADAPTERS=console[;']/);
    const upd = d.match(/--update-secrets (\S+)/)[1];
    assert.deepEqual(upd.split(',').map((x) => x.split('=')[0]).sort(), ['GEMINI_API_KEY', 'RECAPTCHA_API_KEY', 'TYPESAFE_API_KEY']);
    const rm = d.match(/--remove-secrets (\S+)/)[1].split(',');
    for (const s of ['THSMS_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'TWILIO_AUTH_TOKEN', 'TRIAL_TOMBSTONE_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) assert.ok(rm.includes(s), s);
    const rmEnv = d.match(/--remove-env-vars (\S+)/)[1].split(',');
    for (const v of ['LINE_DEFAULT_TO', 'TWILIO_ACCOUNT_SID', 'TWILIO_VERIFY_SID', 'CENTRAL_NUMBER_TH']) assert.ok(rmEnv.includes(v), v);
    assert.doesNotMatch(dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo', TWILIO_ACCOUNT_SID: 'ACx', LINE_DEFAULT_TO: 'Ux' }).out, /TWILIO_ACCOUNT_SID=ACx|LINE_DEFAULT_TO=Ux/);
    for (const probe of ['/api/me', '/voice/incoming', '/line/webhook', '/pricing.html']) assert.ok(out.includes(probe), probe);
    assert.match(out, /builds submit app --tag \S+krai-a:demo/);
  });

  it('business role (krai-a, product): every secret, webhooks on krai-a.com', () => {
    const { status, out } = dryRun();
    assert.equal(status, 0, out);
    const d = deployLine(out);
    assert.match(d, /gcloud run deploy krai-a /);
    assert.match(d, /SITE_MODE=product/);
    assert.doesNotMatch(d, /--remove-secrets/);
    assert.match(d, /NOTIFY_ADAPTERS=console,line/);
    assert.match(out, /Voice webhook POST https:\/\/krai-a\.com\/voice\/incoming/);
    assert.match(out, /LINE: Messaging API webhook https:\/\/krai-a\.com\/line\/webhook, LIFF endpoint https:\/\/krai-a\.com\/liff\.html/);
    assert.match(out, /builds submit app --tag \S+krai-a:product/);
  });

  it('SRC_DIR builds another tree (public repo); PERSIST_DOC is passed or reset', () => {
    const r = dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo', SRC_DIR: '../krai-a-public/app', PERSIST_DOC: 'krai/hackathon' });
    assert.match(r.out, /builds submit \.\.\/krai-a-public\/app /);
    assert.match(deployLine(r.out), /PERSIST_DOC=krai\/hackathon/);
    assert.match(deployLine(dryRun().out), /--remove-env-vars \S*PERSIST_DOC/);
  });

  it('each role runs as its own least-privilege SA and Firestore database (never the default compute SA)', () => {
    const demo = deployLine(dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo' }).out);
    assert.match(demo, /--service-account krai-a-demo-run@test-proj\.iam\.gserviceaccount\.com /);
    assert.match(demo, /PERSIST_DATABASE=hackathon[;']/);
    const prod = deployLine(dryRun().out);
    assert.match(prod, /--service-account krai-a-run@test-proj\.iam\.gserviceaccount\.com /);
    assert.doesNotMatch(prod, /PERSIST_DATABASE=/);
    assert.match(prod, /--remove-env-vars \S*PERSIST_DATABASE/);
    for (const d of [demo, prod]) assert.doesNotMatch(d, /compute@developer/);
    // a missing SA or demo database aborts before anything is built
    const noSa = dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo', DRY_RUN_ABSENT: 'krai-a-demo-run@test-proj.iam.gserviceaccount.com' });
    assert.equal(noSa.status, 1, noSa.out);
    assert.match(noSa.out, /missing service account: krai-a-demo-run@/);
    assert.doesNotMatch(noSa.out, /builds submit/);
    const noDb = dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo', DRY_RUN_ABSENT: '--database=hackathon' });
    assert.equal(noDb.status, 1, noDb.out);
    assert.match(noDb.out, /missing Firestore database: hackathon/);
    assert.doesNotMatch(noDb.out, /builds submit/);
    // a missing secret's fix-up hint grants the role's SA, not the service's current one
    const noKey = dryRun({ DRY_RUN_ABSENT: 'thsms-api-key' });
    assert.match(noKey.out, /secretAccessor --member=serviceAccount:krai-a-run@test-proj/);
  });

  it('refuses to deploy the local-only live recorder (LIVE_RECORD_DIR in env or the tree .env)', () => {
    const fromEnv = dryRun({ LIVE_RECORD_DIR: 'C:/tmp/rec' });
    assert.equal(fromEnv.status, 1, fromEnv.out);
    assert.match(fromEnv.out, /refusing: LIVE_RECORD_DIR is a local-only recorder/);
    assert.doesNotMatch(fromEnv.out, /builds submit|run deploy/);
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'krai-rec-'));
    try {
      fs.writeFileSync(path.join(tree, '.env'), 'GEMINI_MODEL=x\nLIVE_RECORD_DIR=./recordings\n');
      const fromFile = dryRun({ SRC_DIR: tree });
      assert.equal(fromFile.status, 1, fromFile.out);
      assert.match(fromFile.out, /refusing: LIVE_RECORD_DIR is a local-only recorder/);
      assert.doesNotMatch(fromFile.out, /builds submit|run deploy/);
      fs.writeFileSync(path.join(tree, '.env'), '# LIVE_RECORD_DIR=./recordings\nLIVE_RECORD_DIR=\n');
      assert.equal(dryRun({ SRC_DIR: tree }).status, 0); // commented out or empty is fine
    } finally { fs.rmSync(tree, { recursive: true, force: true }); }
    assert.match(deployLine(dryRun().out), /--remove-env-vars \S*LIVE_RECORD_DIR/); // never left on the service
  });

  it('COPY_ENV_FROM fills unset pass-through env from a saved describe without printing values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
    const f = path.join(dir, 'svc.json');
    fs.writeFileSync(f, JSON.stringify({ spec: { template: { spec: { containers: [{ env: [
      { name: 'TWILIO_ACCOUNT_SID', value: 'AC123' }, { name: 'RECAPTCHA_SITE_KEY', value: 'site-k' },
      { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'gemini-api-key' } } }] }] } } } }));
    try {
      const prod = dryRun({ COPY_ENV_FROM: f });
      assert.match(prod.out, /env copied from .*: RECAPTCHA_SITE_KEY TWILIO_ACCOUNT_SID/);
      assert.match(deployLine(prod.out), /TWILIO_ACCOUNT_SID=AC123/);
      const demo = dryRun({ SERVICE: 'krai-a-demo', SITE_MODE: 'demo', COPY_ENV_FROM: f });
      assert.match(deployLine(demo.out), /RECAPTCHA_SITE_KEY=site-k/);
      assert.doesNotMatch(deployLine(demo.out), /AC123/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
