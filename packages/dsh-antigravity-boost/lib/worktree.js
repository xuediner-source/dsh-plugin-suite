/**
 * Ephemeral isolated worktrees — the workspace model behind Antigravity /boost.
 *
 * From the official spec (antigravity.google/docs/boost/), the Boost row of the
 * comparison table:
 *
 *   Workspace model   Ephemeral isolated worktrees
 *   Task horizon      Seconds to hours
 *   Verification      Multi-round independent verification
 *
 * Contrast with the Teamwork row: "Persistent isolated worktrees per
 * milestone". /boost worktrees are throwaway — created for one hard task,
 * verified inside, merged or discarded, then removed.
 *
 * State lives under `<workspace>/.dsh-boost/runs/<runId>/` alongside the
 * worktree itself so a crash leaves an inspectable trail.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const RUNS_DIR = '.dsh-boost';
const RUNS_SUBDIR = 'runs';
const WORKTREES_SUBDIR = 'worktrees';
const RUN_ID_PATTERN = /^boost-[a-z0-9]+-[a-z0-9]{4}$/;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitBuffer(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** True when the directory is inside a git work tree. */
export function isGitRepo(dir) {
  try { return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch { return false; }
}

/** Root of the git repository containing `dir`. */
export function repoRoot(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); }
  catch { return dir; }
}

/** Current branch, or the commit SHA when detached. */
export function currentRef(dir) {
  try { return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']); }
  catch { return ''; }
}

export function pathsFor(workspace) {
  const root = repoRoot(workspace);
  const base = join(root, RUNS_DIR);
  return {
    repoRoot: root,
    runsRoot: join(base, RUNS_SUBDIR),
    worktreesRoot: join(base, WORKTREES_SUBDIR),
  };
}

function runDir(workspace, runId) {
  if (!RUN_ID_PATTERN.test(String(runId ?? ''))) throw new Error(`invalid boost run id: ${String(runId)}`);
  return join(pathsFor(workspace).runsRoot, runId);
}

function statePath(workspace, runId) {
  return join(runDir(workspace, runId), 'state.json');
}

export function readState(workspace, runId) {
  if (!workspace || !RUN_ID_PATTERN.test(String(runId ?? ''))) return null;
  try {
    const file = statePath(workspace, runId);
    if (lstatSync(file).isSymbolicLink()) return null;
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const expectedWorktree = resolve(pathsFor(workspace).worktreesRoot, runId);
    if (!state || typeof state !== 'object' || state.runId !== runId) return null;
    if (state.branch !== `boost/${runId}` || typeof state.worktree !== 'string' || resolve(state.worktree) !== expectedWorktree) return null;
    if (typeof state.base !== 'string' || !state.base || !Array.isArray(state.verifyCommands) || !Array.isArray(state.verifications)) return null;
    return state;
  }
  catch { return null; }
}

export function writeState(workspace, state) {
  if (!state || typeof state !== 'object' || !RUN_ID_PATTERN.test(String(state.runId ?? ''))) {
    throw new Error('invalid boost run state id');
  }
  const expectedWorktree = resolve(pathsFor(workspace).worktreesRoot, state.runId);
  if (state.branch !== `boost/${state.runId}` || typeof state.worktree !== 'string' || resolve(state.worktree) !== expectedWorktree) {
    throw new Error(`refusing unsafe state paths for boost run ${state.runId}`);
  }
  const dir = runDir(workspace, state.runId);
  const runsRoot = pathsFor(workspace).runsRoot;
  for (const path of [join(repoRoot(workspace), RUNS_DIR), runsRoot, dir]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing symlink in boost state path: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  mkdirSync(dir, { recursive: true });
  const target = statePath(workspace, state.runId);
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`refusing symlink state file: ${target}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  writeFileSync(target, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/** Short deterministic run id: boost-<epoch36>-<rand4>. */
export function newRunId(now = Date.now()) {
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `boost-${now.toString(36)}-${random}`;
}

function ensureGitExclude(workspace) {
  try {
    const root = repoRoot(workspace);
    const gitPath = git(root, ['rev-parse', '--git-path', 'info/exclude']);
    const excludeFile = isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
    const infoDir = resolve(excludeFile, '..');
    if (existsSync(excludeFile)) {
      const content = readFileSync(excludeFile, 'utf8');
      if (!content.includes('.dsh-boost')) {
        writeFileSync(excludeFile, `${content.trimEnd()}\n.dsh-boost\n`, 'utf8');
      }
    } else {
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(excludeFile, '.dsh-boost\n', 'utf8');
    }
  } catch {
    // Non-fatal if info/exclude is inaccessible
  }
}

/**
 * Create an ephemeral worktree for one Boost run.
 *
 * The branch is `boost/<runId>` based on `ref` (default: current HEAD). The
 * worktree path is `<repo>/.dsh-boost/worktrees/<runId>` — inside the repo's
 * boost state dir so cleanup is one rm -rf, never scattered across the disk.
 */
export function createRun(workspace, { runId = newRunId(), task = '', ref, verifyCommands = [], mode = 'implementation', now = Date.now() } = {}) {
  if (typeof workspace !== 'string' || !workspace.trim()) {
    return { ok: false, reason: 'a session workspace or explicit repository path is required' };
  }
  if (!RUN_ID_PATTERN.test(String(runId ?? ''))) {
    return { ok: false, reason: 'invalid boost run id' };
  }
  const paths = pathsFor(workspace);
  if (!isGitRepo(workspace)) {
    // The session cwd is often a parent folder of many projects (e.g.
    // F:\DPH). Say so, and list the repos that ARE usable instead of a bare
    // refusal.
    const nearby = nearbyRepos(workspace);
    const lines = [`${workspace} is not a git repository — /boost needs a repo to isolate worktrees.`];
    if (nearby.length > 0) {
      lines.push('', 'Git repositories available here:');
      for (const repo of nearby) {
        lines.push(`  ${repo}${repoHasRuns(repo) ? '  (has boost runs)' : ''}`);
      }
      lines.push('', 'Point /boost at one of them:  /boost <repo-path> <task>');
    } else {
      lines.push('', 'No git repositories found in this directory or its subdirectories.');
      lines.push('Point /boost at a repository explicitly:  /boost <repo-path> <task>');
    }
    return { ok: false, reason: lines.join('\n') };
  }
  const targetBranch = currentRef(workspace);
  const targetCommit = git(workspace, ['rev-parse', 'HEAD']);
  const base = ref && ref.trim() ? ref.trim() : targetBranch;
  if (!base) return { ok: false, reason: 'could not resolve the base ref' };
  let baseCommit;
  try { baseCommit = git(workspace, ['rev-parse', '--verify', `${base}^{commit}`]); }
  catch { return { ok: false, reason: `could not resolve base commit ${base}` }; }

  ensureGitExclude(workspace);

  const branch = `boost/${runId}`;
  const worktree = join(paths.worktreesRoot, runId);
  if (existsSync(worktree) || existsSync(statePath(workspace, runId))) {
    return { ok: false, reason: `worktree already exists at ${worktree}` };
  }
  const boostDir = join(paths.repoRoot, RUNS_DIR);
  for (const dir of [boostDir, paths.runsRoot, paths.worktreesRoot]) {
    try {
      if (lstatSync(dir).isSymbolicLink()) return { ok: false, reason: `refusing symlink in boost state path: ${dir}` };
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, reason: `could not inspect boost state path: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    mkdirSync(boostDir, { recursive: true });
    mkdirSync(paths.worktreesRoot, { recursive: true });
    mkdirSync(paths.runsRoot, { recursive: true });
    for (const dir of [boostDir, paths.runsRoot, paths.worktreesRoot]) {
      if (lstatSync(dir).isSymbolicLink()) return { ok: false, reason: `refusing symlink in boost state path: ${dir}` };
    }
    git(workspace, ['worktree', 'add', '-q', '-b', branch, worktree, base]);
  } catch (error) {
    return { ok: false, reason: `git worktree add failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const state = {
    runId,
    task,
    mode,
    branch,
    worktree,
    base,
    baseCommit,
    targetBranch,
    targetCommit,
    verifyCommands,
    phase: 'execution',
    round: 0,
    maxRounds: 3,
    workstreams: [],
    verifications: [],
    createdAt: now,
    updatedAt: now,
  };
  writeState(workspace, state);
  return { ok: true, state };
}

/** Check if the worktree on disk has any uncommitted or untracked file changes. */
export function worktreeHasChanges(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { hasChanges: true, files: [], error: `unknown or invalid run ${runId}` };
  try {
    const status = git(state.worktree, ['status', '--porcelain']);
    if (!status.trim()) return { hasChanges: false, files: [] };
    const files = status.split('\n').filter(Boolean).map((line) => line.slice(3).trim());
    return { hasChanges: true, files };
  } catch (error) {
    return { hasChanges: true, files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Auto-commit uncommitted changes in the ephemeral worktree to keep the boost branch current. */
export function autoCommitWorktree(workspace, runId, message = 'auto-commit') {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  try {
    const status = git(state.worktree, ['status', '--porcelain']);
    if (!status.trim()) {
      return { ok: true, committed: false, state };
    }
    git(state.worktree, ['add', '-A']);
    git(state.worktree, ['commit', '-q', '-m', `boost(${runId}): ${message}`]);
    state.updatedAt = Date.now();
    writeState(workspace, state);
    return { ok: true, committed: true, state };
  } catch (error) {
    return { ok: false, reason: `auto-commit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Fingerprint changed tracked and untracked file contents against the run's immutable base. */
function worktreeFingerprint(state) {
  try {
    const baseCommit = state.baseCommit || git(state.worktree, ['merge-base', state.base, 'HEAD']);
    const changed = gitBuffer(state.worktree, ['diff', '--no-renames', '--name-only', '-z', baseCommit]).toString('utf8');
    const untracked = gitBuffer(state.worktree, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8');
    const files = [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))].sort();
    const root = resolve(state.worktree);
    const hash = createHash('sha256');
    for (const relative of files) {
      const file = resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}/`) && !file.startsWith(`${root}\\`)) {
        return { ok: false, reason: `changed path escapes the worktree: ${relative}` };
      }
      hash.update(`${relative}\0`);
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) {
          hash.update(`link\0${readlinkSync(file)}\0`);
        } else if (stat.isFile()) {
          hash.update(`file\0${stat.mode & 0o111}\0`);
          hash.update(readFileSync(file));
          hash.update('\0');
        } else if (stat.isDirectory()) {
          let submodule = '';
          try { submodule = git(file, ['rev-parse', 'HEAD']); } catch { /* ordinary directory */ }
          hash.update(`directory\0${submodule}\0`);
        } else {
          hash.update(`special\0${stat.mode}\0`);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        hash.update('missing\0');
      }
    }
    return { ok: true, fingerprint: hash.digest('hex') };
  } catch (error) {
    return { ok: false, reason: `could not fingerprint verified worktree: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Record one workstream's outcome (implementation or investigation). */
export function recordWorkstream(workspace, runId, { kind, summary, files = [], findings = '' }) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  state.workstreams.push({ kind, summary, files, findings, at: Date.now() });
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, state };
}

/** Append one verification round's result. */
export function recordVerification(workspace, runId, result) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  let fingerprint;
  if (result.passed) {
    const snapshot = worktreeFingerprint(state);
    if (!snapshot.ok) return snapshot;
    fingerprint = snapshot.fingerprint;
  }
  state.round += 1;
  state.verifications.push({ round: state.round, ...result, ...(fingerprint ? { fingerprint } : {}) });
  if (fingerprint) state.verifiedFingerprint = fingerprint;
  else delete state.verifiedFingerprint;
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, state };
}

/** Diff summary of the worktree against its base, including uncommitted/untracked files. */
export function worktreeDiff(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  try {
    const base = state.baseCommit || state.base;
    const stat = git(state.worktree, ['diff', '--stat', base]);
    const names = git(state.worktree, ['diff', '--name-only', base]);
    const untracked = git(state.worktree, ['status', '--porcelain']);
    const untrackedFiles = untracked
      ? untracked.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
      : [];
    const diffFiles = names ? names.split('\n').filter(Boolean) : [];
    const allFiles = Array.from(new Set([...diffFiles, ...untrackedFiles]));
    return { ok: true, stat, files: allFiles };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Deliver the run: merge the boost branch into the target branch when all
 * verification rounds passed, then remove the ephemeral worktree. On failure
 * the worktree is kept for inspection — the official Boost model reports the
 * diagnostics rather than merging an unverified change.
 */
export function closeRun(workspace, runId, { target, keepWorktree = false } = {}) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  if (state.phase === 'delivered') return { ok: false, reason: 'run is already delivered', state };
  if (state.phase === 'aborted') return { ok: false, reason: 'run was discarded', state };
  const latest = state.verifications.at(-1);
  const passed = state.phase === 'verified' && latest?.passed === true && typeof latest.fingerprint === 'string';
  if (!passed) {
    return {
      ok: false,
      merged: false,
      reason: 'latest verification round has not passed — worktree kept for inspection',
      worktree: state.worktree,
      state,
    };
  }

  const snapshot = worktreeFingerprint(state);
  if (!snapshot.ok) return { ok: false, merged: false, reason: snapshot.reason, worktree: state.worktree, state };
  if (snapshot.fingerprint !== latest.fingerprint || snapshot.fingerprint !== state.verifiedFingerprint) {
    return {
      ok: false,
      merged: false,
      reason: 'worktree changed after verification — run boost_verify again before delivery',
      worktree: state.worktree,
      state,
    };
  }

  const targetBranch = target || state.targetBranch || state.base;
  if (target && state.targetBranch && target !== state.targetBranch) {
    return { ok: false, merged: false, reason: `run was prepared for ${state.targetBranch}; create a new run to target ${target}`, state };
  }
  const checkedOut = currentRef(workspace);
  if (checkedOut !== targetBranch) {
    return { ok: false, merged: false, reason: `target ${targetBranch} is not checked out (current branch: ${checkedOut || '(unknown)'}); switch to the target and retry`, state };
  }
  const targetHead = git(workspace, ['rev-parse', 'HEAD']);
  const expectedTargetHead = state.targetCommit || state.baseCommit || git(state.worktree, ['merge-base', state.branch, targetBranch]);
  if (targetHead !== expectedTargetHead) {
    return { ok: false, merged: false, reason: 'target branch advanced after the run opened — update the worktree and verify again before delivery', state };
  }

  // Do not merge or remove anything if local identity/hooks prevent the
  // verified worktree changes from being preserved on its branch.
  const committed = autoCommitWorktree(workspace, runId, 'verified changes');
  if (!committed.ok) return { ok: false, merged: false, reason: committed.reason, worktree: state.worktree, state };

  try {
    git(workspace, ['merge', '--no-ff', '-q', state.branch, '-m', `boost(${runId}): ${state.task.slice(0, 60) || 'verified change'}`]);
  } catch (error) {
    try { git(workspace, ['merge', '--abort']); } catch { /* ignore if already clean */ }
    return { ok: false, merged: false, reason: `merge failed: ${error instanceof Error ? error.message : String(error)}`, state };
  }
  state.phase = 'delivered';
  state.updatedAt = Date.now();
  writeState(workspace, state);
  if (keepWorktree) return { ok: true, merged: true, target: targetBranch, worktreeRemoved: false, state };
  const removed = removeWorktree(workspace, runId);
  return removed.ok
    ? { ok: true, merged: true, target: targetBranch, worktreeRemoved: true, state: removed.state }
    : { ok: true, merged: true, target: targetBranch, worktreeRemoved: false, reason: `changes merged, but worktree cleanup failed: ${removed.reason}`, state };
}

/** Remove the ephemeral worktree and its branch, keeping the run record. */
export function removeWorktree(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  if (existsSync(state.worktree)) {
    try { git(workspace, ['worktree', 'remove', '--force', state.worktree]); }
    catch (error) {
      return { ok: false, reason: `git worktree remove refused ${state.worktree}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try { git(workspace, ['branch', '-D', state.branch]); }
  catch (error) {
    let branchExists = false;
    try { git(workspace, ['show-ref', '--verify', '--quiet', `refs/heads/${state.branch}`]); branchExists = true; } catch { /* branch already gone */ }
    if (branchExists) return { ok: false, reason: `could not remove branch ${state.branch}: ${error instanceof Error ? error.message : String(error)}` };
  }
  state.phase = state.phase === 'delivered' ? 'delivered' : 'aborted';
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, state };
}

/** List run records under a workspace. */
export function listRuns(workspace) {
  if (!workspace) return [];
  const paths = pathsFor(workspace);
  if (!existsSync(paths.runsRoot)) return [];
  return readdirSync(paths.runsRoot).filter((n) => RUN_ID_PATTERN.test(n));
}

// ---------------------------------------------------------------------------
// Active-run pointers
//
// A session is often started in a parent folder that is not itself a repo
// (e.g. F:\DPH), while `/boost <repo-path> <task>` creates the run INSIDE the
// target repo. Without a pointer, follow-up commands (/boost-verify,
// /boost-status, ...) would look for the run under the session cwd, find
// nothing, and make /boost unusable from a parent folder. This registry
// records which run each session is currently driving.
// ---------------------------------------------------------------------------

/** Cross-repo bookkeeping root, analogous to the harness home. */
export function stateHome() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'dsh-boost');
}

function activeRegistryPath() {
  return join(stateHome(), 'active.json');
}

export function readActiveRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(activeRegistryPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember that `sessionId` is driving `runId` inside `workspace`. */
export function rememberActiveRun(sessionId, workspace, runId) {
  if (!sessionId || !workspace || !runId) return;
  const all = readActiveRegistry();
  all[String(sessionId)] = { workspace, runId, at: Date.now() };
  // Keep the file bounded: newest 50 sessions only.
  const kept = Object.entries(all)
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, 50);
  try {
    mkdirSync(stateHome(), { recursive: true });
    writeFileSync(activeRegistryPath(), JSON.stringify(Object.fromEntries(kept), null, 2), 'utf8');
  } catch {
    // A registry write failure must never break a boost run.
  }
}

/** Drop the pointer once a run is delivered or discarded. */
export function forgetActiveRun(sessionId, workspace, runId) {
  if (!sessionId) return;
  const all = readActiveRegistry();
  const key = String(sessionId);
  const active = all[key];
  if (!active) return;
  if (workspace && active.workspace !== workspace) return;
  if (runId && active.runId !== runId) return;
  delete all[key];
  try {
    mkdirSync(stateHome(), { recursive: true });
    writeFileSync(activeRegistryPath(), JSON.stringify(all, null, 2), 'utf8');
  } catch {
    // non-fatal
  }
}

/**
 * The run this session is currently driving, when it still exists on disk.
 * Returns null for an unknown session or a run already cleaned up.
 */
export function activeRunFor(sessionId) {
  if (!sessionId) return null;
  const rec = readActiveRegistry()[String(sessionId)];
  if (!rec || typeof rec.workspace !== 'string' || typeof rec.runId !== 'string') return null;
  const state = readState(rec.workspace, rec.runId);
  return state && !['delivered', 'aborted'].includes(state.phase) ? { workspace: rec.workspace, state } : null;
}

/** True when a directory has at least one recorded boost run. */
export function repoHasRuns(dir) {
  return listRuns(dir).length > 0;
}

/**
 * Git repositories reachable from `dir`: the directory itself plus its
 * immediate subdirectories. Used to turn "not a git repository" into an
 * actionable message — the session cwd is often a parent folder holding many
 * projects, and /boost just needs to be pointed at one of them.
 */
export function nearbyRepos(dir, limit = 8) {
  const out = [];
  const consider = (d) => {
    if (out.includes(d)) return;
    try { if (isGitRepo(d)) out.push(d); } catch { /* skip */ }
  };
  consider(dir);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      consider(join(dir, entry.name));
    }
  } catch { /* unreadable directory — nothing nearby to offer */ }
  return out.slice(0, limit);
}
