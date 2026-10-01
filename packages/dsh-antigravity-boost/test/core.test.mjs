import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateStateHome, loadLib } from './harness.mjs';

// Keep the cross-repo active-run registry out of the developer's real ~/.dsh.
isolateStateHome();

const worktree = await loadLib('worktree');
const pipeline = await loadLib('pipeline');
const verify = await loadLib('verify');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'boost-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.name', 'boost-test');
  git('config', 'user.email', 'boost@localhost');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'boost-fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test tests/*.test.js' } }));
  writeFileSync(join(dir, 'math.js'), 'export function add(a, b) { return a + b; }\nexport function divide(a, b) { return a / b; }\n');
  writeFileSync(join(dir, 'tests', 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { divide } from '../math.js';\ntest('divide', () => assert.equal(divide(4, 2), 2));\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { dir, git };
}

describe('worktree: ephemeral isolation', () => {
  it('creates an isolated worktree on a boost branch', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'fix the divide-by-zero case' });
    assert.equal(created.ok, true);
    // Windows `path.join` yields backslashes; assert on the platform separator
    // instead of a hardcoded forward slash.
    const expected = join('.dsh-boost', 'worktrees');
    assert.ok(created.state.worktree.includes(expected), `worktree must live under ${expected}: ${created.state.worktree}`);
    assert.match(created.state.branch, /^boost\//);
    assert.equal(worktree.isGitRepo(created.state.worktree), true);
  });

  it('rejects a non-git workspace with an actionable reason', () => {
    const plain = mkdtempSync(join(tmpdir(), 'boost-plain-'));
    const created = worktree.createRun(plain, { task: 'x' });
    assert.equal(created.ok, false);
    assert.match(created.reason, /not a git repository/i);
  });

  it('rejects run-id path traversal and refuses tampered worktree paths', () => {
    const { dir } = makeRepo();
    assert.equal(worktree.createRun(dir, { runId: '../../outside', task: 'unsafe' }).ok, false);
    const created = worktree.createRun(dir, { task: 'tamper state' });
    const sentinelDir = mkdtempSync(join(tmpdir(), 'boost-sentinel-'));
    writeFileSync(join(sentinelDir, 'keep.txt'), 'keep me');
    const stateFile = join(dir, '.dsh-boost', 'runs', created.state.runId, 'state.json');
    const tampered = JSON.parse(readFileSync(stateFile, 'utf8'));
    tampered.worktree = sentinelDir;
    writeFileSync(stateFile, JSON.stringify(tampered));
    assert.equal(worktree.readState(dir, created.state.runId), null);
    assert.equal(worktree.removeWorktree(dir, created.state.runId).ok, false);
    assert.equal(readFileSync(join(sentinelDir, 'keep.txt'), 'utf8'), 'keep me');
    assert.equal(existsSync(created.state.worktree), true);
  });

  it('refuses a symlinked worktrees directory before creating anything outside the repo', () => {
    const { dir } = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'boost-outside-'));
    mkdirSync(join(dir, '.dsh-boost'), { recursive: true });
    try { symlinkSync(outside, join(dir, '.dsh-boost', 'worktrees'), 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    const created = worktree.createRun(dir, { task: 'symlink path' });
    assert.equal(created.ok, false);
    assert.match(created.reason, /symlink/i);
    assert.deepEqual(execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  });

  it('fails closed when it cannot inspect a run worktree', () => {
    const { dir } = makeRepo();
    const result = worktree.worktreeHasChanges(dir, 'boost-invalid-id');
    assert.equal(result.hasChanges, true);
    assert.ok(result.error);
  });

  it('main repo is untouched while the run edits the worktree', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'edit math' });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function divide(a, b) { if (b === 0) throw new Error("zero"); return a / b; }\n');
    const main = execFileSync('git', ['-C', dir, 'diff', '--name-only'], { encoding: 'utf8' }).trim();
    assert.equal(main, '', 'main worktree must show no diff');
  });

  it('diff summary reports the changed files', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'edit math' });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function divide(a, b) { return b === 0 ? 0 : a / b; }\n');
    const diff = worktree.worktreeDiff(dir, created.state.runId);
    assert.equal(diff.ok, true);
    assert.ok(diff.files.includes('math.js'));
  });
});

describe('verify: local verification and diagnostics', () => {
  it('passes when the command exits 0', () => {
    const r = verify.runCommand('node -e ""', { cwd: tmpdir() });
    assert.equal(r.passed, true);
    assert.equal(r.exitCode, 0);
  });

  it('captures diagnostics on failure', () => {
    const r = verify.runCommand('node -e "process.exit(3)"', { cwd: tmpdir() });
    assert.equal(r.passed, false);
    assert.equal(r.exitCode, 3);
  });

  it('reports spawn errors instead of throwing', () => {
    const r = verify.runCommand('definitely-not-a-command-xyz', { cwd: tmpdir() });
    assert.equal(r.passed, false);
    assert.ok(r.diagnostics.length > 0, 'diagnostics must explain what went wrong');
  });

  it('round stops at the first failure and returns its diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boost-round-'));
    const round = verify.runRound(['node -e ""', 'node -e "console.error(\'boom\'); process.exit(1)"', 'node -e ""'], { cwd: dir });
    assert.equal(round.passed, false);
    assert.equal(round.results.length, 2, 'third command never runs after a failure');
    assert.match(round.diagnostics, /boom/);
  });
});

describe('pipeline: three phases and the feedback loop', () => {
  it('plan rejects an empty task', () => {
    const planned = pipeline.plan('   ');
    assert.equal(planned.ok, false);
  });

  it('plan produces both official workstream kinds', () => {
    const planned = pipeline.plan('fix the race condition');
    assert.equal(planned.ok, true);
    const kinds = planned.workstreams.map((w) => w.kind).sort();
    assert.deepEqual(kinds, ['implementation', 'investigation']);
  });

  it('rejects an investigation workstream that reports file changes', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'investigate deadlock' });
    const rejected = pipeline.report(dir, created.state.runId, {
      kind: 'investigation',
      summary: 'root cause found',
      files: ['src/lock.js'],
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /must not modify files/i);
  });

  it('accepts an investigation workstream with no file changes', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'investigate deadlock' });
    const accepted = pipeline.report(dir, created.state.runId, {
      kind: 'investigation',
      summary: 'lock acquired before await; released after',
      files: [],
    });
    assert.equal(accepted.ok, true);
  });

  it('fails a round and returns feedback with diagnostics', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'verify loop', verifyCommands: ['node -e "process.exit(1)"'] });
    const outcome = pipeline.iterate(dir, created.state.runId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 'iterating');
    assert.equal(outcome.failedCommand, 'node -e "process.exit(1)"');
    assert.ok(outcome.feedback.includes('diagnostics'), 'feedback must carry diagnostics for the next iteration');
  });

  it('delivers when a round passes', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'verify loop', verifyCommands: ['node -e ""'] });
    const outcome = pipeline.iterate(dir, created.state.runId);
    assert.equal(outcome.status, 'delivered');
  });

  it('escalates to needs_review once maxRounds are exhausted', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'broken', verifyCommands: ['node -e "process.exit(1)"'] });
    const state = worktree.readState(dir, created.state.runId);
    state.maxRounds = 2;
    worktree.writeState(dir, state);
    let outcome;
    for (let i = 0; i < 2; i++) outcome = pipeline.iterate(dir, created.state.runId);
    assert.equal(outcome.status, 'needs_review');
    assert.match(outcome.feedback, /human review/i);
  });

  it('refuses to deliver when the latest verification round failed', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'fail run', verifyCommands: ['node -e "process.exit(1)"'] });
    pipeline.iterate(dir, created.state.runId);
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, false);
    assert.equal(closed.merged, false);
    assert.ok(closed.worktree, 'unverified worktree is kept for inspection');
    assert.match(closed.reason, /latest verification round/);
  });

  it('allows delivery after a failed round is fixed and the latest verification passes', () => {
    const { dir, git } = makeRepo();
    const created = worktree.createRun(dir, { task: 'feedback loop', verifyCommands: ['node -e "process.exit(1)"'] });
    assert.equal(pipeline.iterate(dir, created.state.runId).status, 'iterating');
    const passed = pipeline.iterate(dir, created.state.runId, { verifyCommands: ['node -e ""'] });
    assert.equal(passed.status, 'delivered');
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, true, closed.reason);
    assert.equal(git('status', '--porcelain').trim(), '');
  });

  it('rejects edits made after a passing verification and preserves the worktree', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'stale verification', verifyCommands: ['node -e ""'] });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function add(a, b) { return 9; }\n');
    assert.equal(pipeline.iterate(dir, created.state.runId).status, 'delivered');
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function add(a, b) { return 10; }\n');
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, false);
    assert.match(closed.reason, /changed after verification/);
    assert.equal(existsSync(created.state.worktree), true);
  });

  it('does not deliver to a branch other than the run target', () => {
    const { dir, git } = makeRepo();
    const targetBranch = worktree.currentRef(dir);
    const created = worktree.createRun(dir, { task: 'target branch guard', verifyCommands: ['node -e ""'] });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function add(a, b) { return 9; }\n');
    pipeline.iterate(dir, created.state.runId);
    git('switch', '-q', '-c', 'other-target');
    const wrong = worktree.closeRun(dir, created.state.runId);
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason, /not checked out/);
    assert.equal(git('show', 'HEAD:math.js'), 'export function add(a, b) { return a + b; }\nexport function divide(a, b) { return a / b; }\n');
    git('switch', '-q', targetBranch);
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, true, closed.reason);
  });

  it('does not remove a worktree when an auto-commit hook rejects verified edits', () => {
    const { dir, git } = makeRepo();
    const hookDir = join(dir, 'test-hooks');
    mkdirSync(hookDir);
    const hook = join(hookDir, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    execFileSync('chmod', ['+x', hook]);
    git('config', 'core.hooksPath', hookDir);
    const created = worktree.createRun(dir, { task: 'failed auto commit', verifyCommands: ['node -e ""'] });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function add(a, b) { return 7; }\n');
    pipeline.iterate(dir, created.state.runId);
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, false);
    assert.match(closed.reason, /auto-commit failed/);
    assert.equal(existsSync(created.state.worktree), true);
    assert.equal(git('show', 'HEAD:math.js'), 'export function add(a, b) { return a + b; }\nexport function divide(a, b) { return a / b; }\n');
  });

  it('merges verified changes and removes the ephemeral worktree', () => {
    const { dir, git } = makeRepo();
    const created = worktree.createRun(dir, { task: 'safe fix', verifyCommands: ['node -e ""'] });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function add(a, b) { return a + b; }\nexport function divide(a, b) { if (b === 0) throw new Error("zero"); return a / b; }\n');
    execFileSync('git', ['-C', created.state.worktree, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', created.state.worktree, 'commit', '-q', '-m', 'fix divide'], { stdio: 'ignore' });
    pipeline.iterate(dir, created.state.runId, { verifyCommands: ['node -e ""'] });
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, true, closed.reason);
    assert.equal(closed.merged, true);
    const merged = execFileSync('git', ['-C', dir, 'show', 'HEAD:math.js'], { encoding: 'utf8' });
    assert.match(merged, /zero/, 'verified change must be merged into the target branch');
  });

  it('auto-commits pending worktree changes so uncommitted edits are preserved and merged on deliver', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'auto-commit test', verifyCommands: ['node -e ""'] });
    // Agent modifies file directly in worktree WITHOUT running git commit!
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function divide(a, b) { return 42; }\n');
    pipeline.iterate(dir, created.state.runId, { verifyCommands: ['node -e ""'] });
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, true, closed.reason);
    assert.equal(closed.merged, true);
    const merged = execFileSync('git', ['-C', dir, 'show', 'HEAD:math.js'], { encoding: 'utf8' });
    assert.match(merged, /42/, 'uncommitted worktree edits must be safely auto-committed and merged into main repo');
  });

  it('rejects investigation workstream when files were modified on disk even if report passed files=[]', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'investigate with sneak edit' });
    // Sneakily edit a file in worktree
    writeFileSync(join(created.state.worktree, 'math.js'), 'corrupted');
    const rejected = pipeline.report(dir, created.state.runId, {
      kind: 'investigation',
      summary: 'claimed no file changes',
      files: [],
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /must not modify files on disk/i);
  });

  it('automatically adds .dsh-boost to .git/info/exclude', () => {
    const { dir } = makeRepo();
    worktree.createRun(dir, { task: 'exclude test' });
    const excludeContent = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.ok(!excludeContent.includes('.dsh-boost'), '.dsh-boost must not show up in main git status');
  });

  it('uses Git’s resolved exclude path inside a linked worktree', () => {
    const { dir, git } = makeRepo();
    const linked = mkdtempSync(join(tmpdir(), 'boost-linked-'));
    git('worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const created = worktree.createRun(linked, { task: 'linked worktree exclude' });
    assert.equal(created.ok, true, created.reason);
    const ignored = execFileSync('git', ['-C', linked, 'check-ignore', '-q', '.dsh-boost'], { stdio: 'ignore' });
    assert.equal(ignored, null);
  });

  it('refuses delivery when the target branch changed after verification', () => {
    const { dir, git } = makeRepo();
    const created = worktree.createRun(dir, { task: 'conflict test', verifyCommands: ['node -e ""'] });
    // Make conflicting change in worktree
    writeFileSync(join(created.state.worktree, 'math.js'), 'export const conflict = "from worktree";\n');
    execFileSync('git', ['-C', created.state.worktree, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', created.state.worktree, 'commit', '-q', '-m', 'wt conflict'], { stdio: 'ignore' });
    // Make conflicting change in main branch
    writeFileSync(join(dir, 'math.js'), 'export const conflict = "from main";\n');
    git('add', 'math.js');
    git('commit', '-q', '-m', 'main conflict');

    pipeline.iterate(dir, created.state.runId, { verifyCommands: ['node -e ""'] });
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, false);
    assert.match(closed.reason, /target branch advanced/i);
    // Main repo should remain clean and outside a merge state.
    const status = git('status', '--porcelain');
    assert.equal(status.trim(), '', 'main repo must be clean after aborted merge');
  });
});
