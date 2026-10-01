// End-to-end proof that the /subscriptions-auth channel answers.
//
// The channel used to be mounted through `connection.rpc.handle()`, which
// registers routes on the CONNECTION plugin's own context. Cordis resolves an
// undeclared service by walking that context's fiber chain, so the plugin's own
// inject list could never satisfy it: the route never registered, the browser
// request fell through to the frontend-static fallback, and every call died as
// "transport failure for /subscriptions-auth/<endpoint>: HTTP 405".
//
// This test extracts the shipped route handler, mounts it on a real
// node:http server behind a dispatcher that mimics the host (longest-prefix
// match, else a 405-for-non-GET fallback), and drives it with the host
// client's exact envelope. It fails if the envelope, the method, the content
// type, or the Host/Origin fence ever drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');

/** Pull one top-level `[async] function NAME(...) {...}` out of the bundle. */
function extractFunction(name) {
  const plain = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(plain, -1, `helper ${name} must exist`);
  const start = SOURCE.startsWith('async ', plain - 6) ? plain - 6 : plain;
  let depth = 0;
  let i = SOURCE.indexOf('{', start);
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return SOURCE.slice(start, i + 1);
}

/** Pull `function registerAuthRpc(...) {...}` out of the bundle. */
function extractRegisterAuthRpc() {
  const at = SOURCE.indexOf('function registerAuthRpc(');
  assert.notEqual(at, -1, 'registerAuthRpc must exist');
  let depth = 0;
  let i = SOURCE.indexOf('{', at);
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return SOURCE.slice(at, i + 1);
}

const declaration = (needle) => {
  const line = SOURCE.split('\n').find((l) => l.includes(needle));
  assert.ok(line, `missing declaration: ${needle}`);
  return line;
};

/** Build the shipped handler as a real module, with minimal host stubs. */
async function loadHandler() {
  const register = extractRegisterAuthRpc();
  // The regression this guards: rpc.handle() can never satisfy its webServer
  // lookup from the calling plugin's context.
  assert.ok(!register.includes('rpc.handle'), 'must not mount through connection.rpc.handle');
  assert.match(register, /webCtx\.webServer\.register\(/, 'must register on the plugin webServer context');

  const module_ = [
    'const BadRequest = class BadRequest extends Error {};',
    'const ok = (value) => ({ ok: true, value });',
    'const failure = (error) => ({ ok: false, error: { code: error instanceof BadRequest ? "bad-request" : "internal", message: String(error?.message ?? error), details: {} } });',
    'const dispatch = async (_c, _s, endpoint) => {',
    '  if (endpoint === "status") return ok({ providers: { antigravity: { loggedIn: false } } });',
    '  if (endpoint === "login") return ok({ flow: "started" });',
    '  throw new BadRequest(`unknown endpoint ${endpoint}`);',
    '};',
    declaration('const SUBSCRIPTIONS_AUTH_CHANNEL ='),
    declaration('const RPC_ENDPOINT_SEGMENT ='),
    declaration('const AUTH_RPC_MAX_BODY_BYTES ='),
    extractFunction('endpointFromPath'),
    extractFunction('isLoopbackAddress'),
    extractFunction('isLoopbackAuthRequest'),
    extractFunction('sendRpcJson'),
    extractFunction('readJsonBody'),
    register,
    'export function mount(webServer, controller, speed) {',
    '  const disposers = [];',
    '  const ctx = { inject: (_names, cb) => cb({ effect: (fn) => { const disposer = fn(); if (typeof disposer === "function") disposers.push(disposer); }, webServer }) };',
    '  registerAuthRpc(ctx, controller, speed);',
    '  return { dispose() { for (const dispose of disposers.splice(0)) dispose(); } };',
    '}',
    'export const isAllowed = isLoopbackAuthRequest;',
  ].join('\n');

  const dir = mkdtempSync(join(tmpdir(), 'auth-channel-'));
  const file = join(dir, 'extracted.mjs');
  writeFileSync(file, module_);
  return import(pathToFileURL(file).href);
}

/** Mount the channel and a host-shaped dispatcher on a real server. */
async function startServer() {
  const H = await loadHandler();
  const routes = [];
  const webServer = {
    register(route) {
      if (routes.some((r) => r.path === route.path)) throw new Error(`webserver: duplicate prefix route ${route.path}`);
      routes.push(route);
      return () => routes.splice(routes.indexOf(route), 1);
    },
  };
  const mounted = H.mount(webServer, {}, {});

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    let best;
    for (const route of routes) {
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
      if (!best || route.path.length > best.path.length) best = route;
    }
    if (best) {
      await best.handler(req, res);
      return;
    }
    // the frontend-static fallback that produced the reported 405
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (endpoint, payload, init = {}) => {
    const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
    return fetch(`${base}/subscriptions-auth/${endpoint}`, {
      method: 'POST',
      ...init,
      headers,
      body: init.body ?? JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload }),
    });
  };
  return { server, base, call, routes, port: server.address().port, dispose: mounted.dispose, isAllowed: H.isAllowed };
}

test('status answers 200 instead of the fallback 405', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const res = await call('status', {});
  assert.equal(res.status, 200, 'the channel must own this route');
  const body = await res.json();
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'rpc-1', 'the rpcId must round-trip for correlation');
  assert.equal(body.result.ok, true);
  assert.ok(body.result.value.providers, 'status must carry the provider map');
});

test('login answers 200 instead of the fallback 405', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const res = await call('login', { provider: 'antigravity' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.ok, true);
  assert.equal(body.result.value.flow, 'started');
});

test('error paths keep the host carrier contract', async (t) => {
  const { server, base, call } = await startServer();
  t.after(() => server.close());

  const unknown = await call('nope', {});
  assert.equal(unknown.status, 200, 'application errors ride HTTP 200');
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.result.ok, false);
  assert.equal(unknownBody.result.error.code, 'bad-request');

  const get = await fetch(`${base}/subscriptions-auth/status`);
  assert.equal(get.status, 404, 'a GET is a route miss, not a 405');

  const root = await call('', {});
  assert.equal(root.status, 404, 'the channel root is not an endpoint');

  const wrongType = await call('status', {}, { headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);

  const badJson = await fetch(`${base}/subscriptions-auth/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(badJson.status, 400);
});

test('the Host/Origin fence rejects foreign and cross-site callers', async (t) => {
  const { server, port, call } = await startServer();
  t.after(() => server.close());

  const crossOrigin = await call('status', {}, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(crossOrigin.status, 403);

  const sameOrigin = await call('status', {}, { headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameOrigin.status, 200, 'a same-origin browser must pass');

  // fetch() forbids setting Host, so the forged-authority case needs raw http.
  const forged = await new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'status', payload: {} });
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/subscriptions-auth/status',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), host: 'evil.example.com' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', () => resolve(0));
    req.end(body);
  });
  assert.equal(forged, 403, 'a non-loopback Host must be refused');
});

test('the auth fence requires a loopback peer and exact same-origin HTTP authority', async (t) => {
	const { server, isAllowed } = await startServer();
	t.after(() => server.close());
  const req = (remoteAddress, host, extra = {}) => ({
    socket: { remoteAddress },
    headers: { host, ...extra },
  });
  assert.equal(isAllowed(req('127.0.0.1', '127.0.0.1:7863')), true);
  assert.equal(isAllowed(req('::ffff:127.8.9.10', 'localhost:7863')), true);
  assert.equal(isAllowed(req('192.168.1.9', '127.0.0.1:7863')), false);
  assert.equal(isAllowed(req('127.0.0.1', '127.evil.example:7863')), false);
  assert.equal(isAllowed(req('127.0.0.1', '127.0.0.1:7863', { origin: 'https://127.0.0.1:7863' })), false);
  assert.equal(isAllowed(req('127.0.0.1', '127.0.0.1:7863', { 'sec-fetch-site': 'cross-site' })), false);
});

test('route disposer unregisters the auth prefix', async (t) => {
  const { server, base, call, routes, dispose } = await startServer();
  t.after(() => server.close());
  assert.equal(routes.some((route) => route.path === '/subscriptions-auth'), true);
  dispose();
  assert.equal(routes.some((route) => route.path === '/subscriptions-auth'), false);
  const res = await call('status', {});
  assert.equal(res.status, 405, 'the host fallback takes over after plugin disposal');
});

test('sibling prefix routes on the same server are unaffected', async (t) => {
  const { server, base, routes } = await startServer();
  t.after(() => server.close());
  routes.push({ path: '/api/pool-hub', handler: (_q, r) => { r.writeHead(200); r.end('pool'); } });
  const res = await fetch(`${base}/api/pool-hub`);
  assert.equal(res.status, 200, 'longest-prefix matching must still pick the other route');
});
