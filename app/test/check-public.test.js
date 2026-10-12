// Leak guard: an untracked-but-not-ignored file (one `git add -A` away
// from a commit) is scanned too; ignored files are not.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/check-public.js');
const FAKE_KEY = ['AI', 'zaSyFakeKeyForTest1234567890abcdefg'].join(''); // split: never a literal key here

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'leakguard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });

describe('scripts/check-public.js', () => {
  it('fails on a secret in an untracked, not-ignored file', () => {
    const dir = repo();
    try {
      writeFileSync(path.join(dir, 'notes.txt'), `key=${FAKE_KEY}\n`);
      const r = run(dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /notes\.txt: possible google-api-key/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores git-ignored files and passes a clean tree', () => {
    const dir = repo();
    try {
      mkdirSync(path.join(dir, 'ignored'));
      writeFileSync(path.join(dir, 'ignored', 'local.txt'), `key=${FAKE_KEY}\n`);
      writeFileSync(path.join(dir, 'readme.txt'), 'hello\n');
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
