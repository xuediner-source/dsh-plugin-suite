import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGES = [
  'dsh-antigravity-boost', 'dsh-autocompact', 'dsh-grok-memory',
  'dsh-subs-hub', 'dsh-usage-board', 'dsh-xuediner-gateway',
];
export function forbiddenFile(file) {
  const pieces = file.split(/[\\/]/);
  const basename = pieces.at(-1);
  return pieces.some(p => ['node_modules', '.git', '.stubs', 'auths', 'state', 'coverage'].includes(p))
    || /^(?:auth|credentials|config)\.json$|^\.credentials\.yaml$|^\.env(?:\.|$)|\.(?:pem|key|log|tgz)$/.test(basename)
    || ['MEMORY.md', 'SOUL.md', 'USER.md'].includes(basename);
}
export function secretInText(text) {
  // Only return a boolean; credentials are never echoed in diagnostics.
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-[A-Za-z0-9_-]{32,})\b/.test(text)
    || /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/.test(text);
}
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.name === '.stubs' || entry.name === 'node_modules') return [];
    assert(!entry.isSymbolicLink(), `Symlink in source: ${path.relative(ROOT, file)}`);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

export async function checkSuite() {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
  assert(rootPackage.private, 'The workspace root is not a DSH plugin');
  const directories = fs.readdirSync(path.join(ROOT, 'packages')).sort();
  assert.deepEqual(directories, PACKAGES, 'Every source plugin must remain independently reviewable');
  const provenance = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/source-provenance.json')));
  assert.equal(provenance.plugins.length, 6);
  assert.equal(provenance.harness.version, '0.2.0-rc.2');
  for (const name of PACKAGES) {
    const dir = path.join(ROOT, 'packages', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    assert.equal(pkg.name, name);
    assert.equal(pkg.license, 'MIT');
    assert(pkg.dsh?.bundle?.patch, `${name}: missing bundle patch`);
    assert(pkg.files.includes('LICENSE'), `${name}: package must include its license`);
    for (const file of [pkg.main, pkg.dsh.bundle.patch, 'README.md', 'LICENSE', ...Object.values(pkg.exports ?? {})]) {
      assert(typeof file === 'string' && !file.includes('..'), `${name}: invalid export`);
      assert(fs.existsSync(path.join(dir, file)), `${name}: missing ${file}; run npm run build`);
    }
    // Import real published peer dependencies, rather than substituting fixtures.
    const exported = await import(pathToFileURL(path.join(dir, pkg.main)).href);
    assert(typeof exported.apply === 'function' || typeof exported.default?.apply === 'function', `${name}: missing Cordis entry`);
    for (const file of filesIn(dir)) {
      const relative = path.relative(ROOT, file);
      assert(!forbiddenFile(relative), `Private/runtime file in package source: ${relative}`);
      const text = fs.readFileSync(file, 'utf8');
      assert(!secretInText(text), `Potential credential in ${relative} (value withheld)`);
      if (/\.(?:js|mjs)$/.test(file)) {
        const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(checked.status, 0, `${relative}: syntax check failed\n${checked.stderr}`);
      }
      if (/\.(?:js|ts)$/.test(file) && !relative.includes('/test/') && !relative.includes('/client/')) {
        for (const [, dependency] of text.matchAll(/from\s*['"](@deepseek-ai\/[\w-]+)['"]/g)) {
          assert(pkg.peerDependencies?.[dependency] || pkg.dependencies?.[dependency] || file.endsWith('.d.ts'), `${name}: undeclared runtime peer ${dependency}`);
        }
      }
    }
    console.log(`ok: ${name} — entry, exports, peers, syntax and credential gate`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkSuite();
