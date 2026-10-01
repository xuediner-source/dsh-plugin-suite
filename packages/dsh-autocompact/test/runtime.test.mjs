import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

test('classifies token overflow narrowly, not HTTP payload or context mentions', () => {
  assert.equal(plugin.overflowLikely('request_body_too_large'),false);
  assert.equal(plugin.overflowLikely('model supports a context window'),false);
  assert.equal(plugin.overflowLikely('prompt is too long: 33000 tokens > 32000 maximum'),true);
  assert.equal(plugin.captureWindow('maximum context length is 32,000 tokens'),32000);
});
for (const mode of ['observe','correct']) test(`real rc.2 normal and prepared streams: ${mode}`, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-compact-test-'));
  const previous=process.env.DSH_HOME; process.env.DSH_HOME=root;
  const ctx=new Context();
  try {
    await ctx.plugin(LlmRuntime);
    const llm=ctx.llm;
    llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async resolveModel(provider,id) { return {provider,id,name:id,context:{contextWindow:64000}}; }
      async *stream() { throw new LlmError('prompt is too long: 33000 tokens > 32000 maximum','SERVER'); }
    }());
    const fork=await ctx.plugin(plugin,{mode});
    const options={provider:'mock',model:'m',messages:[]};
    const first=[]; for await(const item of llm.stream(options))first.push(item);
    assert.equal(first.at(-1).type,'finish');
    assert.equal(first.at(-1).reason.failure.code,mode==='correct'?'CONTEXT_WINDOW_EXCEEDED':'SERVER');
    assert.equal((await llm.resolveModelInfo('mock','m')).context.contextWindow,mode==='correct'?32000:64000);
    const call=await llm.prepareCall({provider:'mock',model:'m'});
    assert.equal(call.context.contextWindow,mode==='correct'?32000:64000);
    const second=[]; for await(const item of call.stream({...call.config,messages:[]}))second.push(item);
    assert.equal(second.at(-1).reason.failure.code,mode==='correct'?'CONTEXT_WINDOW_EXCEEDED':'SERVER');
    assert.equal(fs.existsSync(path.join(root,'.agent-presets')),false);
    await fork.dispose();
    assert.equal(Object.hasOwn(llm, 'prepareCall'),false);
    assert.equal((await llm.resolveModelInfo('mock','m')).context.contextWindow,64000);
    const after=[]; for await(const item of llm.stream(options)) after.push(item);
    assert.equal(after.at(-1).reason.failure.code,'SERVER');
  } finally {
    await ctx.fiber.dispose();
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
