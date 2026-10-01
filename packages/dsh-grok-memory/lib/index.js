/**
 * dsh-grok-memory — five-track cross-session memory for DeepSeek Harness.
 *
 * Storage: five tracks with narrowed injection scope (see lib/tracks.js).
 * Search:  SQLite FTS5 + BM25 + temporal decay + MMR (lib/search.js).
 * Context: first-turn / post-compaction injection (lib/inject.js).
 * Trust:   global and key facts queue for user confirmation (lib/suggest.js).
 *
 * Commands:  /memory  /remember  /flush  /dream  /memclear  /suggest
 * Tools:     memory (five tracks)  memory_suggest
 *
 * The entry format is byte-compatible with dsh-memory-evolve's `§`-delimited
 * layout, so an existing memory directory is read and rewritten in place
 * rather than migrated.
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clearPath, defaultMemoryRoot, MemoryTracks, readText, resolveTracks, TRACKS } from './tracks.js';
import { DEFAULTS, search } from './search.js';
import { DREAM_DEFAULTS, appendSession, dream, gatesOpen, noteSessionEnd, renderSummaryMarkdown, sessionSummary } from './dream.js';
import { INJECTION_DEFAULTS, buildInjection, latestUserText, recallHits, renderRecall, withIndex } from './inject.js';
import { GATED_TRACKS, SuggestionQueue, suggestionsFile } from './suggest.js';

export const name = 'dsh-grok-memory';
export const inject = ['commands', 'agents', 'tools', 'systemPrompt'];

export const Config = z.object({
  memoryRoot: z.string().default(defaultMemoryRoot()),
  enabled: z.boolean().default(true),
  promptSectionOrder: z.number().default(128),
  injectionScan: z.boolean().default(true),
  search: z.object({
    maxResults: z.number().min(1).default(DEFAULTS.maxResults),
    minScore: z.number().default(DEFAULTS.minScore),
  }),
  dream: z.object({
    enabled: z.boolean().default(DREAM_DEFAULTS.enabled),
    minHours: z.number().default(DREAM_DEFAULTS.minHours),
    minSessions: z.number().default(DREAM_DEFAULTS.minSessions),
    staleLockSecs: z.number().default(DREAM_DEFAULTS.staleLockSecs),
  }),
  injection: z.object({
    enabled: z.boolean().default(INJECTION_DEFAULTS.enabled),
    minScore: z.number().default(INJECTION_DEFAULTS.minScore),
    maxChars: z.number().default(INJECTION_DEFAULTS.maxChars),
    memoryMaxChars: z.number().default(INJECTION_DEFAULTS.memoryMaxChars),
    userMaxChars: z.number().default(INJECTION_DEFAULTS.userMaxChars),
    keyMaxChars: z.number().default(INJECTION_DEFAULTS.keyMaxChars),
    recallMaxChars: z.number().default(INJECTION_DEFAULTS.recallMaxChars),
  }),
});

const ok = (text) => ({ kind: 'success', text });
const err = (text) => ({ kind: 'error', text });

const sessionOf = (owner) => owner?.session ?? owner;
const workspaceOf = (owner) => sessionOf(owner)?.header?.cwd;
const sessionIdOf = (owner) => String(sessionOf(owner)?.id ?? 'unknown');

function userText(message) {
  const kind = message?.source?.kind ?? message?.role;
  // DSH user-role events include synthetic goal/plan/compaction context too.
  // Only count user-originated prompts as conversation memory; preserve
  // compatibility with older serialized fixtures that have no source field.
  if (kind && kind !== 'user') return '';
  if (typeof message?.content === 'string') return message.content.trim();
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block && (block.type === 'text' || typeof block.text === 'string'))
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function newTurnBuffer() {
  return { user: [], userIds: new Set(), pendingUser: [], assistant: 0, toolResults: 0 };
}

/** `{root, cwd, label}` for the injected-track titles and recall filtering. */
function pathsOf(cwd, root) {
  return { root, cwd, label: cwd };
}

const TRACK_LIST = TRACKS.map((t) => `\`${t}\``).join(' / ');

const USAGE_SECTION = `Memory tools (five-track cross-session memory):
- The "Cross-session memory (this project)" snapshot is injected automatically
  on the first turn, so earlier conversations in this repo are already in
  context. Use the tools below when you need more than the snapshot.
- memory — the single entry point for all five tracks: ${TRACK_LIST}.
  Read it before writing: the per-track semantics differ, and only some tracks
  are injected.
- memory_suggest — propose a durable GLOBAL fact (memory/user) or a project KEY
  fact. Those tracks steer every future session, so they queue for user
  confirmation instead of writing directly.
Memory holds conventions, decisions and durable project facts. Task state,
tentative conclusions, secrets, and anything the repository already documents
belong OUTSIDE memory. Instructions in the current conversation take precedence
over anything stored in a note.`;

/** DSH `defineTool` reads `options.output.render` unguarded; missing output
 *  crashes the whole plugin tree (`Cannot read properties of undefined
 *  (reading 'render')`). Parameters are an implicit property map, not JSON
 *  Schema (`required: true` lives on each field). */
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      output: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.output ?? '') }],
};

/** One-line summary of a mutation outcome for the model. */
const summarize = (result) => (result.ok
  ? `${result.message}${result.chars !== undefined ? `  [${result.chars} 字符]` : ''}`
  : `失败：${result.message}`);

/** Render `list` rows as a compact numbered block. */
function renderRows(target, result) {
  if (!result.rows.length) {
    return `${target}${result.archived ? '（归档）' : ''}：0 条匹配`;
  }
  const header = `${target}${result.archived ? '（归档）' : ''}：${result.rows.length} 条  (${result.file})`;
  const lines = result.rows.map((row, i) => `${i + 1}. ${row.body}`);
  return [header, ...lines].join('\n');
}

export function apply(ctx, config) {
  // `enabled` defaults to true: only an explicit false turns the plugin off.
  // Testing `!config.enabled` instead would silently disable the plugin for
  // every caller that passes a raw config object without the schema default.
  if (config.enabled === false) {
    ctx.logger?.info?.(`${name}: disabled by config`);
    return;
  }

  const opts = {
    ...config,
    search: { ...DEFAULTS, ...(config.search ?? {}) },
    dream: { ...DREAM_DEFAULTS, ...(config.dream ?? {}) },
    injection: { ...INJECTION_DEFAULTS, ...(config.injection ?? {}) },
  };
  const root = opts.memoryRoot || defaultMemoryRoot();
  const store = new MemoryTracks(root, { injectionScan: opts.injectionScan !== false });
  const queue = new SuggestionQueue(suggestionsFile(root));
  /** sessionId -> { user: string[], assistant: number, toolResults: number } */
  const turnBuffers = new Map();
  /** sessionIds that already contributed a session-end summary / dream count. */
  const savedSessions = new Set();
  /** sessionId -> first-turn recall markdown (stable until compaction). */
  const recallCache = new Map();
  const bufferFor = (id) => {
    let buffer = turnBuffers.get(id);
    if (!buffer) {
      buffer = newTurnBuffer();
      turnBuffers.set(id, buffer);
    }
    return buffer;
  };

  ctx.systemPrompt.section({
    name: 'grok-memory:usage',
    order: opts.promptSectionOrder,
    text: USAGE_SECTION,
  });

  const snapshotOf = (context) => {
    try {
      const agent = context?.agent;
      // Bare system-prompt assemblies have no project identity. Do not invent
      // a project hash from `undefined` or leak global facts into diagnostics.
      if (!agent?.session) return '';
      if (agent?.session?.header?.origin === 'subagent') return '';
      const paths = pathsOf(workspaceOf(agent), root);
      const id = sessionIdOf(agent);
      if (opts.injection.enabled !== false && id && id !== 'unknown' && !recallCache.has(id)) {
        // The workspace path is not a useful semantic query and FTS5 treats
        // space-separated terms as AND, so appending path tokens hid otherwise
        // relevant project notes from first-turn recall.
        const query = latestUserText(context, turnBuffers);
        recallCache.set(id, renderRecall(recallHits(paths, query, opts.injection), opts.injection));
      }
      return buildInjection({
        paths,
        includeRecall: opts.injection.enabled !== false,
        recallText: recallCache.get(id) ?? '',
        cfg: opts.injection,
      });
    } catch (error) {
      ctx.logger?.warn?.(`${name}: injection failed: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  };

  if (typeof ctx.systemPrompt.context === 'function') {
    ctx.systemPrompt.context({
      name: 'grok-memory:snapshot',
      order: 480,
      text: snapshotOf,
    });
  } else {
    ctx.logger?.warn?.(`${name}: systemPrompt.context unavailable; first-turn injection disabled`);
  }

  // -------------------------------------------------------------- helpers
  const guard = (fn) => (invocation) => {
    try {
      return fn(invocation);
    } catch (error) {
      return err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // -------------------------------------------------------------- commands
  const commands = [
    {
      name: 'memory',
      description: 'browse the five memory tracks (memory / user / project / key / daily)',
      input: { hint: '[track — optional]' },
      handler: guard((invocation) => {
        const cwd = workspaceOf(invocation.agent);
        const wanted = invocation.rawInput.trim();
        const rows = store.overview(cwd);
        const project = cwd ? `${cwd} [${resolveTracks(root, cwd).projectDir}]` : '(no workspace cwd)';
        const lines = [`Memory root: ${root}`, `Project: ${project}`, ''];
        for (const row of rows) {
          const mark = wanted === row.target ? ' <-- ' : '';
          const injected = ['memory', 'user', 'key'].includes(row.target) ? ' (injected)' : '';
          const counts = row.live === null ? 'unavailable' : `${row.live} 条, 归档 ${row.archived} 条`;
          lines.push(`  ${row.target.padEnd(8)} ${counts}${injected}${mark}`);
        }
        const pending = queue.read().length;
        lines.push('', `Pending suggestions: ${pending}`);
        return ok(lines.join('\n'));
      }),
    },
    {
      name: 'remember',
      description: 'save a durable statement to project memory',
      input: { hint: '[track::]<statement>   tracks: memory|user|project|key|daily' },
      handler: guard((invocation) => {
        const raw = invocation.rawInput.trim();
        if (!raw) return err('Usage: /remember [track::]<statement>  (default track: project)');
        const parts = raw.split('::');
        let target = 'project';
        let statement = raw;
        if (parts.length > 1 && TRACKS.includes(parts[0].trim())) {
          target = parts[0].trim();
          statement = parts.slice(1).join('::').trim();
        }
        if (!statement) return err('Usage: /remember [track::]<statement>');
        const cwd = workspaceOf(invocation.agent);
        if (GATED_TRACKS.includes(target)) {
          if (target === 'key' && !cwd) return err(`${name}: key 建议需要有效的项目 cwd`);
          const outcome = queue.enqueue(target, statement, '通过 /remember 提交', cwd);
          return outcome.ok
            ? ok(`${name}: ${target} 是注入轨，已进入待确认队列（${outcome.queued} 条）——确认后才会写入并注入`)
            : err(`${name}: ${outcome.message}`);
        }
        const result = store.add(target, statement, cwd);
        return result.ok ? ok(`${name}: saved to ${store.trackOf(target, cwd).file}`) : err(`${name}: ${result.message}`);
      }),
    },
    {
      name: 'flush',
      description: "write the current session's summary into the memory session log",
      input: { hint: '[note — optional one-line context]' },
      handler: guard((invocation) => {
        const agent = invocation.agent;
        const cwd = workspaceOf(agent);
        if (!cwd) return err(`${name}: this session has no workspace directory; /flush needs a project cwd`);
        const paths = pathsOf(cwd, root);
        const buffer = turnBuffers.get(sessionIdOf(agent)) ?? newTurnBuffer();
        const userMessages = buffer.user;
        const note = invocation.rawInput.trim();
        const summary = sessionSummary({
          userMessages: note ? [...userMessages, note] : userMessages,
          assistantMessages: buffer.assistant,
          toolResults: buffer.toolResults,
          sessionId: sessionIdOf(agent),
        });
        if (!summary) {
          return ok(`${name}: session too small to flush (fewer than 3 substantive prompts or <50 bytes of user text)`);
        }
        const file = appendSession(resolveTracks(root, paths.cwd), summary.timestamp.slice(0, 10), renderSummaryMarkdown(summary));
        return ok(`${name}: flushed session summary to ${file}`);
      }),
    },
    {
      name: 'dream',
      description: 'consolidate session logs into deduplicated topic files',
      input: { hint: '[force — bypass auto-dream gates]' },
      handler: guard((invocation) => {
        const cwd = workspaceOf(invocation.agent);
        if (!cwd) return err(`${name}: this session has no workspace directory; /dream needs a project cwd`);
        const paths = resolveTracks(root, cwd);
        const force = invocation.rawInput.trim().toLowerCase() === 'force';
        if (!force) {
          const gate = gatesOpen(paths, opts.dream);
          if (!gate.open) return ok(`${name}: dream gates closed — ${gate.reason}`);
        }
        const markdown = [readText(paths.memory.file), readText(paths.key.file)].filter(Boolean).join('\n');
        const result = dream(paths, markdown, { cfg: opts.dream });
        if (!result.ok) return err(`${name}: dream could not run — ${result.reason}`);
        return ok(`${name}: consolidated ${result.topics} topic file(s)\n${result.files.join('\n')}`);
      }),
    },
    {
      name: 'suggest',
      description: 'list or clear the pending memory suggestions awaiting confirmation',
      input: { hint: '[list | accept <n> | clear | drop <n>]' },
      handler: guard((invocation) => {
        const arg = invocation.rawInput.trim().toLowerCase();
        if (arg === 'clear') return ok(`${name}: ${queue.clear().message}`);
        if (arg.startsWith('accept')) {
          const n = Number.parseInt(arg.split(/\s+/)[1] ?? '', 10);
          if (!Number.isSafeInteger(n) || n < 1) return err('Usage: /suggest accept <n>');
          const entry = queue.read()[n - 1];
          if (!entry) return err(`${name}: 序号 ${n} 超出范围`);
          if (!GATED_TRACKS.includes(entry.target)) return err(`${name}: #${n} 的目标轨无效，建议未写入`);
          const cwd = entry.cwd ?? workspaceOf(invocation.agent);
          if (entry.target === 'key' && !cwd) return err(`${name}: #${n} 是项目 key 建议，但队列中没有项目 cwd`);
          const result = store.add(entry.target, entry.content, cwd);
          if (!result.ok) return err(`${name}: #${n} 未写入：${result.message}`);
          queue.drop(n);
          return ok(`${name}: 已确认并写入 #${n} 到 ${entry.target}`);
        }
        if (arg.startsWith('drop')) {
          const n = Number.parseInt(arg.split(/\s+/)[1] ?? '', 10);
          if (!Number.isInteger(n)) return err('Usage: /suggest drop <n>');
          const outcome = queue.drop(n);
          return outcome.ok ? ok(`${name}: ${outcome.message}`) : err(`${name}: ${outcome.message}`);
        }
        const entries = queue.read();
        if (!entries.length) return ok(`${name}: 待确认队列为空`);
        const lines = [`${name}: 待确认建议 ${entries.length} 条`];
        entries.forEach((e, i) => {
          lines.push(`  #${i + 1} [${e.target}]${e.hits > 1 ? ` (x${e.hits})` : ''} ${e.content}`);
          if (e.reason) lines.push(`      reason: ${e.reason}`);
        });
        return ok(lines.join('\n'));
      }),
    },
    {
      name: 'memclear',
      description: 'clear memory for this project (project | key | daily | all | suggestions)',
      input: { hint: '[project|key|daily|all|suggestions]  (default: project)' },
      handler: guard((invocation) => {
        const cwd = workspaceOf(invocation.agent);
        const paths = resolveTracks(root, cwd);
        const scope = invocation.rawInput.trim() || 'project';
        if (!cwd && ['project', 'key', 'all'].includes(scope)) {
          return err(`${name}: this session has no workspace directory; ${scope} memory needs a project cwd`);
        }
        const targets = {
          project: paths.project.file,
          key: paths.key.file,
          daily: paths.daily.file,
          suggestions: suggestionsFile(root),
          all: paths.projectDir,
        }[scope];
        if (!targets) return err('Usage: /memclear [project|key|daily|all|suggestions]');
        clearPath(targets);
        return ok(`${name}: cleared ${scope} memory (${targets})`);
      }),
    },
  ];

  for (const def of commands) {
    ctx.effect(() => ctx.commands.register(def), `${name}: /${def.name}`);
  }

  // ----------------------------------------------------------------- tools
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd;

  const tools = [
    defineTool({
      name: 'memory',
      description: `Read and write the five-track cross-session memory. Tracks: memory (global durable facts, injected), user (durable user facts, injected), key (per-project long-term facts, injected), project (per-project progress log, on demand), daily (per-day log, on demand). Actions: list, add, replace, remove, archive, promote, search. Global and key tracks require user confirmation, so prefer memory_suggest for them.`,
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'list | add | replace | remove | archive | promote | search',
        },
        target: {
          type: 'string',
          description: `Track: ${TRACKS.join(' | ')}. Required for add/replace/remove/archive/promote/list.`,
        },
        content: { type: 'string', description: 'add: the entry text; replace: the new entry text' },
        match: {
          type: 'string',
          description: 'replace/remove/archive/promote: a short substring uniquely identifying ONE entry',
        },
        query: { type: 'string', description: 'search: what to look for' },
        filter: { type: 'string', description: 'list: case-insensitive substring filter' },
        since: { type: 'string', description: 'list: earliest entry date, YYYY-MM-DD' },
        until: { type: 'string', description: 'list: latest entry date, YYYY-MM-DD' },
        branch: { type: 'string', description: 'list (key track): only entries visible on this git branch' },
        archived: { type: 'boolean', description: 'list: read the archive file instead of the live track' },
        recent: { type: 'boolean', description: 'list: newest first' },
        limit: { type: 'number', description: 'list: maximum rows to return' },
        maxResults: { type: 'number', description: 'search: maximum results' },
      },
      output: textOutput,
      async execute(args, exec) {
        const cwd = cwdOf(exec);
        const action = String(args.action ?? '').trim();
        const target = String(args.target ?? '').trim();
        try {
          if (GATED_TRACKS.includes(target) && ['add', 'replace', 'remove', 'archive', 'promote'].includes(action)) {
            return { output: `${target} 是会注入提示词的记忆轨。请使用 memory_suggest 提议，再由用户通过 /suggest accept <n> 确认写入。` };
          }
          switch (action) {
            case 'add': {
              if (!target) return { output: 'add 需要 target。' };
              const result = store.add(target, args.content, cwd);
              return { output: summarize(result) };
            }
            case 'replace': {
              if (!target) return { output: 'replace 需要 target。' };
              return { output: summarize(store.replace(target, args.match, args.content, cwd)) };
            }
            case 'remove': {
              if (!target) return { output: 'remove 需要 target。' };
              return { output: summarize(store.remove(target, args.match, cwd)) };
            }
            case 'archive': {
              if (!target) return { output: 'archive 需要 target。' };
              return { output: summarize(store.archive(target, args.match, cwd)) };
            }
            case 'promote': {
              if (!target) return { output: 'promote 需要 target。' };
              return { output: summarize(store.promote(target, args.match, cwd)) };
            }
            case 'list': {
              if (!target) return { output: `list 需要 target。可用轨：${TRACKS.join(' / ')}` };
              const result = store.list(target, cwd, {
                filter: args.filter,
                since: args.since,
                until: args.until,
                branch: args.branch,
                archived: args.archived === true,
                recent: args.recent === true,
                limit: args.limit,
              });
              return { output: renderRows(target, result) };
            }
            case 'search': {
              const query = String(args.query ?? '').trim();
              if (!query) return { output: 'search 需要 query。' };
              if (!cwd) return { output: `${name}: 搜索需要有效的会话工作目录` };
              const hits = withIndex(pathsOf(cwd, root), (db) => search(db, query, {
                maxResults: args.maxResults ?? opts.search.maxResults,
                minScore: opts.search.minScore,
              }));
              if (!hits.length) return { output: `No memory matched "${query}".` };
              return {
                output: hits
                  .map((h, i) => `${i + 1}. [${h.source}] ${h.file}${h.stale ? ' (may be stale — verify before relying on it)' : ''}\n   ${h.body.slice(0, 300)}`)
                  .join('\n'),
              };
            }
            default:
              return { output: `未知 action "${action}"。可用：list / add / replace / remove / archive / promote / search` };
          }
        } catch (error) {
          return { output: `${name}: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    }),
    defineTool({
      name: 'memory_suggest',
      description: 'Propose a durable memory entry that needs user confirmation before it is written and injected. Use for the global tracks (memory, user) and the injected key track. Repeated proposals collapse into one pending entry.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: `Track: memory | user | key  (project and daily write directly via the memory tool)`,
        },
        content: { type: 'string', required: true, description: 'The durable statement to record' },
        reason: { type: 'string', description: 'Why this is worth remembering (evidence from the session)' },
      },
      output: textOutput,
      async execute(args, exec) {
        const target = String(args.target ?? '').trim();
        if (!GATED_TRACKS.includes(target)) {
          return { output: `memory_suggest 只用于注入轨（${GATED_TRACKS.join(' / ')}）。${target} 轨请用 memory 工具直接写入。` };
        }
        const cwd = cwdOf(exec);
        if (target === 'key' && !cwd) return { output: `${name}: key 建议需要有效的项目 cwd` };
        const outcome = queue.enqueue(target, args.content, args.reason, cwd);
        if (!outcome.ok) return { output: `失败：${outcome.message}` };
        return {
          output: outcome.deduped
            ? `${outcome.message}——用户确认后才会写入并注入`
            : `已提交待确认的 ${target} 记忆建议（队列 ${outcome.queued} 条）——用户确认后才会写入并注入`,
        };
      },
    }),
  ];

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`);
  }

  const maybeDream = (paths) => {
    if (!opts.dream.enabled) return;
    const gate = gatesOpen(paths, opts.dream);
    if (!gate.open) return;
    const markdown = [readText(paths.memory.file), readText(paths.key.file)].filter(Boolean).join('\n');
    const result = dream(paths, markdown, { cfg: opts.dream });
    if (!result.ok) ctx.logger?.warn?.(`${name}: auto-dream skipped — ${result.reason}`);
  };

  const persistSession = (owner) => {
    const session = sessionOf(owner);
    if (!session || session.header?.origin === 'subagent' || !session.header?.cwd) return;
    const id = sessionIdOf(session);
    if (savedSessions.has(id)) return;
    const buffer = turnBuffers.get(id);
    const userMessages = buffer?.user ?? [];
    const paths = resolveTracks(root, workspaceOf(session));
    const summary = sessionSummary({
      userMessages,
      assistantMessages: buffer?.assistant ?? 0,
      toolResults: buffer?.toolResults ?? 0,
      sessionId: id,
    });
    if (!summary) return;
    appendSession(paths, summary.timestamp.slice(0, 10), renderSummaryMarkdown(summary));
    if (!savedSessions.has(id)) {
      noteSessionEnd(paths);
      savedSessions.add(id);
      maybeDream(paths);
    }
  };

  // DSH publishes agent/inbox/claimed before prompt assembly, then commits
  // user/message, assistant/message, tool/result and turn/end through the
  // session/event feed. There is no agent/settled Cordis event.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const session = sessionOf(agent);
    if (!session || session.header?.origin === 'subagent') return;
    const text = userText(message);
    if (!text) return;
    const buffer = bufferFor(sessionIdOf(session));
    const id = String(message?.id ?? '');
    if (id && (buffer.userIds.has(id) || buffer.pendingUser.some((item) => item.id === id))) return;
    buffer.pendingUser.push({ id, text });
  });

  ctx.on('session/event', (session, event) => {
    if (!session || session.header?.origin === 'subagent') return;
    const id = sessionIdOf(session);
    if (id === 'unknown') return;
    const buffer = bufferFor(id);
    if (event?.type === 'user/message') {
      const text = userText(event.data);
      const messageId = String(event.data?.id ?? '');
      if (text && (!messageId || !buffer.userIds.has(messageId))) {
        buffer.user.push(text);
        if (messageId) buffer.userIds.add(messageId);
      }
      buffer.pendingUser = buffer.pendingUser.filter((item) => item.id !== messageId);
    } else if (event?.type === 'assistant/message') {
      buffer.assistant++;
    } else if (event?.type === 'tool/result') {
      buffer.toolResults++;
    } else if (event?.type === 'compaction/end') {
      recallCache.delete(id);
    } else if (event?.type === 'turn/end') {
      buffer.pendingUser = [];
      try { persistSession(session); }
      catch (error) {
        ctx.logger?.warn?.(`${name}: auto-save failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    try { persistSession(agent); }
    catch (error) {
      ctx.logger?.warn?.(`${name}: dispose-save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const id = sessionIdOf(agent);
    turnBuffers.delete(id);
    recallCache.delete(id);
    savedSessions.delete(id);
  });

  ctx.logger?.info?.(`${name}: five-track memory enabled (root=${root})`);
}
