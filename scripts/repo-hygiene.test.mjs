import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Publication guards for the tracked tree. Patterns stay generic: this file is public.
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const tracked = () => git('ls-files', '-z').split('\0').filter(Boolean);

test('no tracked file is also matched by an ignore rule', () => {
  assert.equal(git('ls-files', '-ci', '--exclude-standard'), '');
});

test('new experiment and documentation folders stay local until allowlisted', () => {
  for (const file of ['experiments/__new_experiment__/probe.ts', 'docs/__new_note__.md']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', file], { cwd: root }).status, 0, file);
  }
});

test('tracked files contain no local databases, recordings, environment files or validation reports', () => {
  const blocked = /^docs\/validation\/|\.(sqlite3?|db|wav|m4a|mp3|flac)$|(^|\/)runtime\.env$|(^|\/)\.env(\.(?!example$)[^/]*)?$/;
  assert.deepEqual(tracked().filter(file => blocked.test(file)), []);
});

test('tracked text contains no machine-specific absolute paths', () => {
  const result = spawnSync('git', ['grep', '-I', '-n', '-E', '/Users/[^/[:space:]]+/|/private/tmp/|/Volumes/',
    '--', '.', ':(exclude)scripts/repo-hygiene.test.mjs'], { cwd: root, encoding: 'utf8' });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const lines = result.stdout.split('\n').filter(line => line && !line.includes('/Users/example/'));
  assert.deepEqual(lines, []);
});
