/** Optional error/window correction. Native DSH owns compaction and presets. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, isContextWindowExceededError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-autocompact';
export const inject = ['llm'];
export interface Config { mode?: 'observe' | 'correct' }
export const Config = Schema.object({ mode: Schema.union(['observe', 'correct']).default('observe') });
interface WindowEntry { contextWindow: number; source: string; updatedAt: number }
interface State { version: 1; windows: Record<string, WindowEntry>; classified: number; learned: number }
const ownerKey = Symbol.for('dsh-autocompact.owner');
const validWindow = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1024 && value <= 10_000_000;
const counter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const home = () => process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
function readJson(file: string): unknown {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 1_048_576) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function windowTable(value: unknown): Record<string, WindowEntry> {
  const out: Record<string, WindowEntry> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value).slice(0, 1024)) {
    if (!key.includes('/') || key.length > 400 || !entry || typeof entry !== 'object') continue;
    const row = entry as Partial<WindowEntry>;
    if (validWindow(row.contextWindow)) out[key] = { contextWindow: row.contextWindow, source: 'local configured or observed limit', updatedAt: counter(row.updatedAt) };
  }
  return out;
}
export function overflowLikely(message: string): boolean {
  // HTTP 413, arbitrary request size errors and a mention of "context window"
  // alone do not prove token overflow. Never turn those into compaction loops.
  return isContextWindowExceededError(message) || /超出模型长度上限/.test(message)
    || /prompt is too long[^\n]*tokens?\s*>\s*[\d,]+\s*maximum/i.test(message);
}
export function captureWindow(message: string): number | undefined {
  for (const expression of [/tokens?\s*>\s*([\d,]+)\s*maximum/i, /maximum context (?:length|window) is\s*([\d,]+)/i]) {
    const found = expression.exec(message); const value = found ? Number(found[1].replace(/,/g, '')) : NaN;
    if (validWindow(value)) return value;
  }
  return undefined;
}
export function apply(ctx: Context, config: Config = {}): void {
  if (config.mode !== undefined && !['observe', 'correct'].includes(config.mode)) throw new Error('invalid autocompact mode');
  const correct = config.mode === 'correct';
  const llm = ctx.get('llm');
  const owner = randomUUID();
  const target = llm as unknown as Record<symbol, unknown>;
  if (!llm || target[ownerKey]) throw new Error('autocompact requires one llm registration');
  target[ownerKey] = owner;
  const dir = path.join(home(), name), stateFile = path.join(dir, 'state.json');
  const raw = readJson(stateFile) as Partial<State> | null;
  const state: State = { version: 1, windows: { ...windowTable(readJson(path.join(dir, 'seeds.json'))), ...windowTable(raw?.windows) }, classified: counter(raw?.classified), learned: counter(raw?.learned) };
  const persist = () => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return;
      const temporary = path.join(dir, `state-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, stateFile);
    } catch { ctx.logger.warn('[autocompact] state could not be saved'); }
  };
  const classify = (options: GenerateOptions, message: string, code: string): string => {
    if (!overflowLikely(message)) return code;
    state.classified += 1;
    const limit = captureWindow(message), key = `${options.provider}/${options.model}`;
    if (limit !== undefined && key.length <= 400 && Object.keys(state.windows).length < 1024) {
      const existing = state.windows[key];
      // An observed rejection can only reduce the recorded bound.
      if (!existing || limit < existing.contextWindow) {
        state.windows[key] = { contextWindow: limit, source: 'observed upstream token bound', updatedAt: Date.now() }; state.learned += 1;
      }
    }
    persist();
    return correct ? CONTEXT_WINDOW_EXCEEDED_CODE : code;
  };
  const correctedContext = <T extends { contextWindow?: number }>(provider: string, model: string, context: T): T => {
    const limit = state.windows[`${provider}/${model}`]?.contextWindow;
    const declared = context.contextWindow;
    return correct && validWindow(limit) && validWindow(declared) && limit < declared
      ? { ...context, contextWindow: limit } : context;
  };
  // The supported waterfall covers both ordinary streams and registration-
  // bound prepareCall().stream(). It is automatically removed on unload.
  ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          const failure = chunk.reason.failure;
          const code = classify(options, failure.message, failure.code);
          yield code === failure.code ? chunk : { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code } } };
        } else yield chunk;
      }
    } catch (error) {
      if (error instanceof Error) {
        const code = classify(options, error.message, String((error as { code?: string }).code ?? 'UNKNOWN'));
        if (correct && code === CONTEXT_WINDOW_EXCEEDED_CODE) throw new LlmError(error.message, code, { cause: error });
      }
      throw error;
    }
  });
  // Public metadata seams have no middleware hook. Preserve registration-bound
  // dispatch/config and restore only wrappers still owned by this instance.
  ctx.effect(() => {
    const resolve = llm.resolveModelInfo, prepare = llm.prepareCall;
    const resolveDescriptor = Object.getOwnPropertyDescriptor(llm, 'resolveModelInfo');
    const prepareDescriptor = Object.getOwnPropertyDescriptor(llm, 'prepareCall');
    const resolveWrapped: typeof resolve = async function (provider, model, ...rest) {
      const info = await resolve.call(llm, provider, model, ...rest);
      return info.context ? { ...info, context: correctedContext(provider, model, info.context) } : info;
    };
    const prepareWrapped: typeof prepare = async function (callConfig, ...rest) {
      const prepared = await prepare.call(llm, callConfig, ...rest);
      return prepared.context ? Object.freeze({ ...prepared, context: Object.freeze(correctedContext(callConfig.provider, callConfig.model, prepared.context)) }) : prepared;
    };
    if (correct) { llm.resolveModelInfo = resolveWrapped; llm.prepareCall = prepareWrapped; }
    return () => {
      if (Object.getOwnPropertyDescriptor(llm, 'resolveModelInfo')?.value === resolveWrapped) {
        if (resolveDescriptor) Object.defineProperty(llm, 'resolveModelInfo', resolveDescriptor); else delete (llm as unknown as Record<string, unknown>).resolveModelInfo;
      }
      if (Object.getOwnPropertyDescriptor(llm, 'prepareCall')?.value === prepareWrapped) {
        if (prepareDescriptor) Object.defineProperty(llm, 'prepareCall', prepareDescriptor); else delete (llm as unknown as Record<string, unknown>).prepareCall;
      }
      if (target[ownerKey] === owner) delete target[ownerKey];
    };
  });
  const commands = ctx.get('commands') as { register?: (command: object) => unknown } | undefined;
  if (commands?.register) ctx.effect(() => {
    const dispose = commands.register!({ name: 'autocompact', description: 'Optional overflow/window correction status', handler: async () => ({ kind: 'success', text: JSON.stringify({ mode: correct ? 'correct' : 'observe', nativeCompaction: 'owned by DSH; no preset files modified', ...state }, null, 2) }) });
    return typeof dispose === 'function' ? dispose as () => void : () => {};
  });
}
