// Run after `npm run build`; all network traffic is confined to local fake servers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pool-hub-http-'));
const gatewayDir = path.join(tempRoot, 'gateway');
fs.mkdirSync(path.join(gatewayDir, 'auths'), { recursive: true });

const upstreamRequests = [];
let upstreamMode = 'ok';
const upstream = http.createServer((req, res) => {
  upstreamRequests.push({ url: req.url, authorization: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/panel/api/login/start') {
    if (upstreamMode === 'error') {
      res.writeHead(502).end(JSON.stringify({
        message: 'fake-secret-canary http://credential-endpoint.invalid/?token=private',
      }));
      return;
    }
    res.end(JSON.stringify({ url: 'https://auth.example/device?state=fake-state', state: 'fake-state' }));
    return;
  }
  if (req.url?.startsWith('/panel/api/login/poll?')) {
    res.end(JSON.stringify({ done: true, access_token: 'fake-access-token-canary' }));
    return;
  }
  res.writeHead(404).end('{}');
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const upstreamPort = await listen(upstream);
const gatewayOrigin = `http://127.0.0.1:${upstreamPort}`;
process.env.XUEDINER_GATEWAY_URL = gatewayOrigin;
process.env.XUEDINER_GATEWAY_DIR = gatewayDir;
process.env.XUEDINER_API_KEY = 'fake-api-key-canary';

const unexpectedNetwork = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (!url.startsWith(gatewayOrigin)) {
    unexpectedNetwork.push(url);
    return Promise.reject(new Error(`network blocked by pool-hub HTTP test: ${url}`));
  }
  return nativeFetch(input, init);
};

const {
  registerPoolRoute,
  ROUTE_PATH,
  REFRESH_ROUTE_PATH,
  LOGIN_START_ROUTE_PATH,
  LOGIN_POLL_ROUTE_PATH,
  TASKS_RUN_ROUTE_PATH,
  TASKS_STATUS_ROUTE_PATH,
  INTL_LOGIN_START_ROUTE_PATH,
  INTL_LOGIN_POLL_ROUTE_PATH,
  GPT_LOGIN_START_ROUTE_PATH,
  GPT_LOGIN_POLL_ROUTE_PATH,
} = await import('../lib/pool-hub.js');

const routeHandlers = new Map();
const routeServer = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const route = routeHandlers.get(pathname);
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  void route(req, res);
});
const routePort = await listen(routeServer);
const webServer = {
  host: '127.0.0.1',
  port: routePort,
  register({ kind, path: routePath, handler }) {
    assert.equal(kind, 'exact');
    assert.equal(routeHandlers.has(routePath), false);
    routeHandlers.set(routePath, handler);
    return () => routeHandlers.delete(routePath);
  },
};
let cleanupRoutes;
const ctx = {
  get(name) { return name === 'webServer' ? webServer : undefined; },
  effect(effect) { cleanupRoutes = effect(); },
  logger: { info() {}, warn() {} },
};
registerPoolRoute(ctx);
assert.equal(routeHandlers.size, 10, 'all ten pool routes should be registered');

const origin = `http://127.0.0.1:${routePort}`;
function request(routePath, {
  method = 'GET',
  headers = {},
  body,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: routePort,
      path: routePath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

const sameOrigin = {
  origin,
  'sec-fetch-site': 'same-origin',
};

try {
  // Wrong methods receive 405 and the exact allowed method, for every route.
  const methods = [
    [ROUTE_PATH, 'GET'],
    [REFRESH_ROUTE_PATH, 'POST'],
    [LOGIN_START_ROUTE_PATH, 'POST'],
    [LOGIN_POLL_ROUTE_PATH, 'GET'],
    [TASKS_RUN_ROUTE_PATH, 'POST'],
    [TASKS_STATUS_ROUTE_PATH, 'GET'],
    [INTL_LOGIN_START_ROUTE_PATH, 'POST'],
    [INTL_LOGIN_POLL_ROUTE_PATH, 'GET'],
    [GPT_LOGIN_START_ROUTE_PATH, 'POST'],
    [GPT_LOGIN_POLL_ROUTE_PATH, 'GET'],
  ];
  for (const [routePath, allowed] of methods) {
    const response = await request(routePath, { method: allowed === 'GET' ? 'POST' : 'GET' });
    assert.equal(response.status, 405, `${routePath} should enforce ${allowed}`);
    assert.equal(response.headers.allow, allowed);
  }
  assert.equal(upstreamRequests.length, 0, 'wrong methods must have no upstream effect');

  const rejectedHost = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, host: `attacker.example:${routePort}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rejectedHost.status, 403, 'non-loopback Host must be refused');

  const wrongHostPort = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, host: '127.0.0.1:1', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongHostPort.status, 403, 'Host must use the live DSH port');

  const rejectedOrigin = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, origin: 'http://attacker.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rejectedOrigin.status, 403, 'cross-origin POST must be refused');

  const missingPostOrigin = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(missingPostOrigin.status, 403, 'mutating POST must include Origin');

  const crossSiteGet = await request(LOGIN_POLL_ROUTE_PATH + '?state=not-polled', {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSiteGet.status, 403, 'cross-site GET login poll must be refused');

  const wrongOriginGet = await request(LOGIN_POLL_ROUTE_PATH + '?state=not-polled', {
    headers: { origin: 'http://attacker.example', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(wrongOriginGet.status, 403, 'any supplied GET Origin must match exactly');
  assert.equal(upstreamRequests.length, 0, 'rejected requests must not trigger upstream calls');

  const wrongContentType = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongContentType.status, 415);

  const malformedPost = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformedPost.status, 400);

  const oversizedPost = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: {
      ...sameOrigin,
      'content-type': 'application/json',
      'content-length': String(8 * 1024 + 1),
    },
    body: ' '.repeat(8 * 1024 + 1),
  });
  assert.equal(oversizedPost.status, 413);
  assert.equal(upstreamRequests.length, 0, 'invalid POST bodies must have no upstream effect');

  const malformedRefresh = await request(REFRESH_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformedRefresh.status, 400, 'malformed refresh JSON must not mean refresh all');
  assert.deepEqual(unexpectedNetwork, [], 'malformed refresh must not reach an external credential API');

  // Existing UI bodyless POSTs remain accepted as the empty object shorthand.
  const started = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: sameOrigin,
  });
  assert.equal(started.status, 200);
  assert.deepEqual(JSON.parse(started.text), {
    ok: true,
    url: 'https://auth.example/device?state=fake-state',
    state: 'fake-state',
  });
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].authorization, 'Bearer fake-api-key-canary');

  const polled = await request(LOGIN_POLL_ROUTE_PATH + '?state=fake-state', { headers: sameOrigin });
  assert.equal(polled.status, 200);
  assert.deepEqual(JSON.parse(polled.text), { done: true });
  assert.equal(polled.text.includes('fake-access-token-canary'), false, 'poll must not project upstream credential fields');

  upstreamMode = 'error';
  const failedStart = await request(LOGIN_START_ROUTE_PATH, {
    method: 'POST',
    headers: { ...sameOrigin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(failedStart.status, 200);
  assert.equal(failedStart.text.includes('fake-api-key-canary'), false);
  assert.equal(failedStart.text.includes('fake-secret-canary'), false);
  assert.equal(failedStart.text.includes('credential-endpoint.invalid'), false);

  cleanupRoutes();
  assert.equal(routeHandlers.size, 0, 'disposing the route effect must unregister every route');
  const afterDispose = await request(ROUTE_PATH);
  assert.equal(afterDispose.status, 404);

  const partialRoutes = new Map();
  let registrations = 0;
  const failingContext = {
    get(name) {
      return name === 'webServer' ? {
        host: '127.0.0.1',
        port: routePort,
        register({ path: routePath, handler }) {
          registrations += 1;
          if (registrations === 4) throw new Error('fake duplicate route');
          partialRoutes.set(routePath, handler);
          return () => partialRoutes.delete(routePath);
        },
      } : undefined;
    },
    effect(effect) {
      try { effect(); } catch { /* registerPoolRoute reports and rolls back */ }
    },
    logger: { info() {}, warn() {} },
  };
  registerPoolRoute(failingContext);
  assert.equal(partialRoutes.size, 0, 'failed partial registration must dispose prior routes');
  assert.deepEqual(unexpectedNetwork, []);
  console.log('pool-hub HTTP hardening tests OK');
} finally {
  cleanupRoutes?.();
  await close(routeServer);
  await close(upstream);
  globalThis.fetch = nativeFetch;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
