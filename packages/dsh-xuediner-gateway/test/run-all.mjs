// Required package gates. No missing toolchain is silently counted as success.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failures = 0;
async function step(name, cmd, args, options = {}) {
  try {
    const { stdout } = await run(cmd, args, { cwd: ROOT, timeout: 300_000, maxBuffer: 16_777_216, ...options });
    console.log(`ok: ${name}`);
    const summary = (stdout ?? '').split('\n').filter(line => /tests |pass |fail |skipped |OK|^ok[ \t]/.test(line));
    if (summary.length) console.log(summary.map(line => `  ${line}`).join('\n'));
  } catch (error) {
    failures++;
    console.error(`FAIL: ${name}\n${error.stdout ?? ''}${error.stderr ?? ''}\n${error.message}`);
  }
}
await step('no-secrets', process.execPath, ['test/no-secrets.mjs', ROOT]);
await step('contracts', process.execPath, ['test/contracts.mjs']);
await step('commandcode', process.execPath, ['test/commandcode.test.mjs']);
await step('stream protocol / published DSH runtime', process.execPath, ['--test', 'test/stream.test.mjs']);
await step('native volatile settings', process.execPath, ['--test', 'test/settings-compat.test.mjs']);
await step('pool HTTP lifecycle', process.execPath, ['test/pool-hub-http.test.mjs']);
await step('TypeScript', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit']);
await step('Go regressions', 'go', ['test', './...'], { cwd: path.join(ROOT, 'gateway') });
await step('Go vet', 'go', ['vet', './...'], { cwd: path.join(ROOT, 'gateway') });
if (failures) { console.error(`run-all FAILED (${failures})`); process.exitCode = 1; }
else console.log('run-all OK. (zero skipped gates)');
