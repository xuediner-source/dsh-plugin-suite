import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const POOL_HUB_MAX_BODY_BYTES = 8 * 1024;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export type PoolRouteMethod = 'GET' | 'POST';

export interface PoolRequestGuardOptions {
  method: PoolRouteMethod;
  /** Bound DSH web server's port, not a port trusted from the request. */
  port: number;
  /** Apply application/json checks to non-empty POST bodies. */
  expectedJSON?: boolean;
}

export type BoundedJsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; message: string };

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function reject(req: IncomingMessage, res: ServerResponse, status: number, message: string, allow?: string): false {
  // Do not leave an attacker-controlled request body queued behind a response.
  req.resume();
  res.writeHead(status, { ...JSON_HEADERS, ...(allow ? { allow } : {}) });
  res.end(JSON.stringify({ ok: false, message }));
  return false;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined | null {
  const matches: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) matches.push(req.rawHeaders[index + 1] ?? '');
  }
  if (matches.length > 1) return null;
  if (matches.length === 1) return matches[0];
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const ipv4 = mapped ?? address;
  if (isIP(ipv4) !== 4) return false;
  const octets = ipv4.split('.').map(Number);
  return octets[0] === 127;
}

function parseLocalHost(value: string, port: number): URL | undefined {
  if (value.length === 0 || value.trim() !== value || /[\s,\\]/.test(value)) return undefined;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    const hostname = url.hostname.toLowerCase();
    const isLocalName = hostname === 'localhost' || hostname === '[::1]';
    const parts = hostname.split('.');
    const isLocalIPv4 = parts.length === 4
      && parts[0] === '127'
      && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    if (!isLocalName && !isLocalIPv4) return undefined;
    const effectivePort = url.port === '' ? 80 : Number(url.port);
    if (!Number.isInteger(effectivePort) || effectivePort !== port) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function isExactOrigin(value: string, expectedOrigin: string): boolean {
  if (value === 'null' || value.trim() !== value) return false;
  try {
    const origin = new URL(value);
    return origin.origin === expectedOrigin
      && value === origin.origin
      && origin.username === ''
      && origin.password === ''
      && origin.pathname === '/'
      && origin.search === ''
      && origin.hash === '';
  } catch {
    return false;
  }
}

/**
 * Admit one pool-hub request only from a loopback socket and a loopback Host
 * bound to DSH's actual port. Browser markers are fenced against that exact
 * origin; POSTs require Origin and JSON for any non-empty body.
 * @returns true if the handler may continue; false means a JSON refusal was sent.
 */
export function guardPoolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: PoolRequestGuardOptions,
): boolean {
  const allowedMethod = options.method;
  if (req.method !== allowedMethod) {
    return reject(req, res, 405, `${allowedMethod} only`, allowedMethod);
  }

  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return reject(req, res, 403, 'loopback connection required');
  }

  const hostHeader = singleHeader(req, 'host');
  if (!hostHeader) return reject(req, res, 403, 'request Host is not allowed');
  const hostUrl = parseLocalHost(hostHeader, options.port);
  if (!hostUrl) return reject(req, res, 403, 'request Host is not allowed');

  const fetchSite = singleHeader(req, 'sec-fetch-site');
  if (fetchSite === null || fetchSite?.trim().toLowerCase() === 'cross-site') {
    return reject(req, res, 403, 'cross-site request refused');
  }

  const originHeader = singleHeader(req, 'origin');
  if (originHeader === null) return reject(req, res, 403, 'request Origin is not allowed');
  const expectedOrigin = hostUrl.origin;
  if (originHeader !== undefined && !isExactOrigin(originHeader, expectedOrigin)) {
    return reject(req, res, 403, 'request Origin is not allowed');
  }
  if (allowedMethod === 'POST' && originHeader === undefined) {
    return reject(req, res, 403, 'same-origin Origin required');
  }

  if (allowedMethod === 'POST' && options.expectedJSON !== false) {
    const contentLength = singleHeader(req, 'content-length');
    const transferEncoding = singleHeader(req, 'transfer-encoding');
    if (contentLength === null || transferEncoding === null) {
      return reject(req, res, 400, 'invalid request framing');
    }
    const hasDeclaredBody = transferEncoding !== undefined
      || (contentLength !== undefined && contentLength !== '0');
    const contentType = singleHeader(req, 'content-type');
    if (contentType === null) return reject(req, res, 415, 'application/json required');
    if (hasDeclaredBody || contentType !== undefined) {
      const essence = contentType?.split(';', 1)[0]?.trim().toLowerCase();
      if (essence !== 'application/json') return reject(req, res, 415, 'application/json required');
    }
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength)
      && Number(contentLength) > POOL_HUB_MAX_BODY_BYTES) {
      return reject(req, res, 413, 'request body too large');
    }
  }

  return true;
}

/** Read one bounded JSON object. A truly empty POST is the `{}` shorthand. */
export async function readBoundedJson(req: IncomingMessage): Promise<BoundedJsonResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > POOL_HUB_MAX_BODY_BYTES) {
        req.resume();
        return { ok: false, status: 413, message: 'request body too large' };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: 'request body unreadable' };
  }

  if (size === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch {
    return { ok: false, status: 400, message: 'request body must be valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: 'request body must be a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Send the stable JSON refusal shape used for body validation. */
export function sendPoolRequestError(res: ServerResponse, status: 400 | 413, message: string): void {
  sendJson(res, status, { ok: false, message });
}
