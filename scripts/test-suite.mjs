import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PACKAGES, ROOT } from './check-suite.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let failed = false;
for (const name of PACKAGES) {
  const result = spawnSync(npm, ['test', '--workspace', name], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 16_777_216, shell: process.platform === 'win32' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 || result.error) {
    failed = true;
    console.error(`FAIL: ${name}\n${output}\n${result.error?.message ?? ''}`);
  } else {
    const counts = output.split('\n').filter(line => /(?:tests |pass |fail |skipped |PASSED|passed|OK\.)/.test(line));
    console.log(`ok: ${name}\n${counts.map(line => `  ${line}`).join('\n')}`);
  }
}
if (failed) process.exitCode = 1;
