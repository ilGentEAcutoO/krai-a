// deploy-cloudrun.sh in DRY_RUN=1 mode: prints every command, runs none.
// Guards the deploy shape: image-only + targeted env updates (never
// --set-env-vars, which wipes the live env), required secrets, single
// instance, judging switch, rollback + smoke steps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const skip = bash.status !== 0 ? 'bash not available' : false;

function dryRun(env = {}) {
  const r = spawnSync('bash', ['deploy-cloudrun.sh'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DRY_RUN: '1', PROJECT_ID: 'test-proj', ...env },
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
    for (const kv of ['GEMINI_MODEL=gemini-3.5-flash-lite', 'IDENTIFY_MODE=B', 'DEMO_TEXT_API=0', 'PUBLIC_BASE_URL=https://krai-a.com',
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
