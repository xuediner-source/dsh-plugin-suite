// Guards the host-API contract this plugin depends on. These bugs are
// invisible to unit tests (the plugin code itself is correct) and only show up
// as a dead /subscriptions-auth channel at runtime, so they are asserted
// against the source text here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');

test('dsh-llm imports only names the current host actually exports', () => {
  // The host renamed CallId -> ToolCallId. Importing the old name fails at
  // module-evaluation time, which takes down the whole plugin (and with it
  // every model the hub provides), not just the one code path that used it.
  const renamed = ['CallId'];
  const importLine = source.split('\n').find((l) => l.includes('from "@deepseek-ai/dsh-llm"'));
  assert.ok(importLine, 'expected a dsh-llm import');
  for (const gone of renamed) {
    assert.ok(
      !new RegExp(`[{,\\s]${gone}[,\\s}]`).test(importLine),
      `import must not reference the removed host export ${gone} (now ToolCallId)`,
    );
  }
  assert.match(importLine, /ToolCallId/, 'expected the current export name');
});

test('the /subscriptions-auth channel does not mount through connection.rpc.handle', () => {
  // dsh-client-connection's register() reads `owner.webServer`, where `owner`
  // is the CONNECTION plugin's own context. Cordis resolves an undeclared
  // service by walking THAT context's fiber chain, so it never reaches the
  // calling plugin's context: connection injects only "credentials", the
  // lookup throws, the route never registers, and the request falls through to
  // the frontend-static fallback — the browser sees
  // "transport failure for /subscriptions-auth/status: HTTP 405".
  //
  // The channel must therefore register on the plugin's own webServer context,
  // the way @linxin666/dsh-usage and dsh-usage-board do.
  const at = source.indexOf('function registerAuthRpc(');
  assert.ok(at !== -1, 'expected registerAuthRpc');
  let depth = 0;
  let i = source.indexOf('{', at);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(at, i + 1);
  assert.ok(!body.includes('rpc.handle'), 'must not use connection.rpc.handle');
  assert.match(body, /ctx\.inject\(\["webServer"\]/, 'must inject webServer on its own context');
  assert.match(body, /webServer\.register\(/, 'must register the route on webServer');
});

test('webServer is scoped to the RPC channel, not the top-level inject list', () => {
  // Headless profiles have no webServer. Declaring it at the top level would
  // stop the LLM adapters from loading there at all, so it stays scoped to the
  // RPC channel registration.
  const injectLine = source.split('\n').find((l) => l.startsWith('const inject ='));
  assert.ok(injectLine, 'expected a top-level inject');
  assert.ok(!injectLine.includes('webServer'), 'webServer must not be a top-level dependency');
  assert.match(injectLine, /"llm"/, 'the adapters still need llm');
});

test('every named import from a dsh-* package is a plausible current export', () => {
  // Catches the whole CallId-style breakage class without needing the host
  // bundle present: any import from the host must be a plain identifier.
  const lines = source.split('\n').filter((l) => /^import\s.*from\s"@deepseek-ai\//.test(l));
  assert.ok(lines.length >= 3, 'expected several host imports');
  let named = 0;
  for (const line of lines) {
    const open = line.indexOf('{');
    const close = line.lastIndexOf('}');
    if (open === -1 || close < open) continue; // e.g. `import z from "..."` — no named clause
    for (const raw of line.slice(open + 1, close).split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name === '') continue;
      named += 1;
      assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/, `suspicious import name ${JSON.stringify(name)}`);
    }
  }
  assert.ok(named >= 5, `expected to have checked several named imports, checked ${named}`);
});
