import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { PACKAGES, ROOT, checkSuite, forbiddenFile, secretInText } from './check-suite.mjs';

await checkSuite();
const destination = path.join(ROOT, 'artifacts');
fs.mkdirSync(destination, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const manifest = [];
for (const name of PACKAGES) {
  const dir = path.join(ROOT, 'packages', name);
  const result = spawnSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: dir, encoding: 'utf8', maxBuffer: 16_777_216, shell: process.platform === 'win32' });
  assert.equal(result.status, 0, `${name}: npm pack failed\n${result.stderr}`);
  const packed = JSON.parse(result.stdout)[0];
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
  const paths = packed.files.map(file => file.path);
  assert(paths.includes('LICENSE') && paths.includes('package.json') && paths.includes('lib/index.js') && paths.includes('cordis.patch.yml'), `${name}: incomplete installable package`);
  for (const exported of Object.values(pkg.exports ?? {})) assert(paths.includes(exported.replace(/^\.\//, '')), `${name}: exported file missing from archive: ${exported}`);
  for (const file of paths) {
    assert(!forbiddenFile(file), `${name}: forbidden file in archive: ${file}`);
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert(!secretInText(text), `${name}: potential credential in archive (value withheld)`);
  }
  const bytes = fs.readFileSync(path.join(destination, packed.filename));
  manifest.push({ name, version: packed.version, filename: packed.filename, sha256: createHash('sha256').update(bytes).digest('hex'), files: paths.length });
  console.log(`ok: ${packed.filename} (${paths.length} checked files)`);
}
fs.writeFileSync(path.join(destination, 'SHA256SUMS'), manifest.map(pkg => `${pkg.sha256}  ${pkg.filename}\n`).join(''));
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
