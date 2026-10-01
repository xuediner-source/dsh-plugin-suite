import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { XuedinerApiAdapter, isContextOverflow } from '../lib/adapter.js';

const options = { provider: 'xuedinerAPI', model: 'hy4-preview', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const collect = async iterable => { const out = []; for await (const chunk of iterable) out.push(chunk); return out; };
const reply = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const adapterFor = fetchImpl => new XuedinerApiAdapter({ baseUrl: 'http://127.0.0.1:7863/v1', apiKey: 'unit-placeholder', fetchImpl });

test('current DSH runtime accepts transient request messages, wire tools, usage and finish', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    ctx.llm.registerAdapter(['xuedinerAPI'], adapterFor(async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:7863/v1/chat/completions');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer unit-placeholder');
      assert.match(new Headers(init.headers).get('user-agent'), /deepseek/i);
      const body = JSON.parse(init.body);
      assert.equal(body.messages.at(-1).content, 'hello');
      assert.equal(body.tools[0].function.name, 'inspect');
      return reply(event({ choices: [{ delta: { content: 'OK' } }] })
        + event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } })
        + 'data: [DONE]\n\n');
    }));
    const chunks = await collect(ctx.llm.stream({ ...options, tools: [{ name: 'inspect', description: 'inspect', parameters: { type: 'object' } }] }));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'OK');
    assert.equal(chunks.find(c => c.type === 'usage').usage.inputTokens, 15);
    assert.equal(chunks.find(c => c.type === 'usage').usage.cacheReadTokens, 5);
  } finally { await ctx.fiber.dispose(); }
});

test('truncated output never becomes a successful finish', async () => {
  const adapter = adapterFor(async () => reply(event({ choices: [{ delta: { content: 'partial' } }] })));
  await assert.rejects(collect(adapter.stream(options)), error => error.code === 'TRANSPORT');
});

test('caller cancellation after response headers stops an idle reader', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const adapter = adapterFor(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = collect(adapter.stream({ ...options, signal: controller.signal }));
  const timer = setTimeout(() => controller.abort(new Error('user cancelled')), 10);
  try { await assert.rejects(pending, /user cancelled/); assert.equal(cancelled, true); }
  finally { clearTimeout(timer); }
});

test('explicit overflow and quota in HTTP-200 SSE are typed and secrets are redacted', async () => {
  for (const [payload, code] of [
    [{ error_code: '11115', error_msg: 'prompt is too long: 33000 tokens > 32000 maximum' }, 'CONTEXT_WINDOW_EXCEEDED'],
    [{ error: { message: '14018 Credits exhausted Bearer unit-private-secret' } }, 'QUOTA'],
  ]) {
    const adapter = adapterFor(async () => reply(event(payload)));
    await assert.rejects(collect(adapter.stream(options)), error => error.code === code && !error.message.includes('unit-private-secret'));
  }
  assert.equal(isContextOverflow('request_body_too_large'), false);
  assert.equal(isContextOverflow('documentation says maximum context'), false);
  assert.equal(isContextOverflow('tracking reference 1111500'), false);
});

test('unbounded SSE frames and unsafe gateway endpoints fail explicitly', async () => {
  const adapter = adapterFor(async () => reply('data: ' + 'x'.repeat(4_194_305)));
  await assert.rejects(collect(adapter.stream(options)), error => error.code === 'INVALID_RESPONSE');
  for (const baseUrl of ['http://remote.example/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?token=value']) {
    assert.throws(() => new XuedinerApiAdapter({ baseUrl }), /gateway/);
  }
});


test('dynamic gateway settings are resolved for each call with endpoint validation', async () => {
  let current = { baseUrl: 'http://127.0.0.1:7001/v1', apiKey: 'first-placeholder' };
  const seen = [];
  const adapter = new XuedinerApiAdapter({ resolveGateway: async () => ({ ...current }), fetchImpl: async (url, init) => {
    seen.push([url, new Headers(init.headers).get('authorization')]);
    return reply(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  } });
  await collect(adapter.stream(options));
  current = { baseUrl: 'http://127.0.0.1:7002/v1', apiKey: 'second-placeholder' };
  await collect(adapter.stream(options));
  assert.deepEqual(seen, [
    ['http://127.0.0.1:7001/v1/chat/completions', 'Bearer first-placeholder'],
    ['http://127.0.0.1:7002/v1/chat/completions', 'Bearer second-placeholder'],
  ]);
  current = { baseUrl: 'http://remote.example/v1', apiKey: 'third-placeholder' };
  await assert.rejects(collect(adapter.stream(options)), error => error.code === 'INVALID_REQUEST');
  assert.equal(seen.length, 2);
});
