import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildIndex, buildIndexIncremental, persistIndex } from './index.js';
import { smartRead } from './tools/smart-read.js';
import { smartSearch } from './tools/smart-search.js';
import { smartContext } from './tools/smart-context.js';
import { smartReadBatch } from './tools/smart-read-batch.js';
import { smartShell } from './tools/smart-shell.js';
import { smartTest } from './tools/smart-test.js';
import { smartReview } from './tools/smart-review.js';
import { smartPlaybook } from './tools/smart-playbook.js';
import { globalMemory } from './tools/global-memory.js';
import { startIndexWatcher, isWatchEnabled, setActiveWatcher } from './index-watcher.js';
import { smartSummary } from './tools/smart-summary.js';
import { smartStatus } from './tools/smart-status.js';
import { smartDoctor } from './tools/smart-doctor.js';
import { smartEdit } from './tools/smart-edit.js';
import { smartMetrics } from './tools/smart-metrics.js';
import { smartTurn } from './tools/smart-turn.js';
import { projectRoot, projectRootSource } from './utils/paths.js';
import { setServerForStreaming } from './streaming.js';
import { checkNodeVersion } from './utils/runtime-check.js';
import { 
  getSymbolBlame, 
  getFileAuthorshipStats, 
  findSymbolsByAuthor, 
  getRecentlyModifiedSymbols 
} from './git-blame.js';
import {
  discoverRelatedProjects,
  searchAcrossProjects,
  readAcrossProjects,
  findSymbolAcrossProjects,
  getCrossProjectDependencies,
  getCrossProjectStats,
} from './cross-project.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const SERVER_INSTRUCTIONS = `devctx — compressed context, search, and session handoff for long work (migrations, multi-file refactors, multi-session tasks).

smart_turn (session continuity — read this before calling):
- START: phase "start". Pass userPrompt (current goal). ensureSession true recommended when you want persistence. Use at the beginning of substantial work or when resuming after a break — not for one-line fixes or single-shot questions.
- END: phase "end". Pass event: milestone | blocker | task_complete. Pass sessionId if you have it; include update (nextStep, completed, etc.) when checkpointing progress. Call after a meaningful slice of work (close a phase), not after every trivial edit.
- SKIP smart_turn entirely for trivial or same-session point tasks (the tool schema also warns about this).
- smart_resume is the cheap shortcut for the first prompt of a substantial task — equivalent to smart_turn(start, ensureSession=true, verbosity=minimal).

Source of truth: devctx does not replace git history, PRs, or repo docs (e.g. MIGRATION.md). If end was not called or work was not committed, those remain authoritative.

Other entry points: smart_context for curated multi-file context; smart_search with intent for exploration; smart_read in outline|signatures|symbol before full reads; smart_shell for safe git/npm diagnostics.`;

export const asTextResult = (result) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(result),
    },
  ],
});

export const createDevctxServer = () => {
  const runtimeCheck = checkNodeVersion();
  if (!runtimeCheck.ok) {
    console.error(`[devctx] Runtime check failed: ${runtimeCheck.message}`);
    console.error(`[devctx] Current: ${runtimeCheck.current}, Required: ${runtimeCheck.minimum}+`);
    process.exit(1);
  }

  const server = new McpServer(
    { name: 'devctx', version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  setServerForStreaming(server);

  server.prompt(
    'use-devctx',
    'Force the agent to use devctx tools for the current task.',
    {},
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Use devctx MCP tools for this task. Start with smart_context(task) for multi-file context. Use smart_read(outline) → smart_read(symbol) cascade for individual files. Never use native Read on large files.',
          },
        },
      ],
    })
  );

  server.prompt(
    'devctx-workflow',
    'Complete devctx workflow for complex tasks with session continuity.',
    {},
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Follow devctx workflow: 1) smart_turn(start) to recover session 2) smart_context(task) for curated context (replaces search+read cycle) 3) smart_read(symbol) only for specific functions not covered by smart_context 4) smart_turn(end) to checkpoint. Never skip to smart_read(full) — use the cascade: outline → signatures → symbol → full.',
          },
        },
      ],
    })
  );

  server.prompt(
    'devctx-preflight',
    'Preflight: build index and initialize session before work.',
    {},
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Preflight: 1) build_index(incremental=true) 2) smart_turn(start) 3) Proceed with devctx tools.',
          },
        },
      ],
    })
  );

  server.tool(
    'smart_read',
    'Read a file with token-efficient modes. ALWAYS prefer outline/signatures/symbol/explain over full. Reading cascade: outline → signatures → symbol → explain → range → full (last resort). Mode guide: outline (~90% savings): file structure, exports, top-level symbols — use first for orientation. signatures (~85% savings): function signatures with parameters and return types — use when you need the API surface. symbol: extract specific functions/classes by name (string or array) — use when you know what to read; add context=true for callers, tests, and dependencies. explain (~95% savings): one-shot compact summary of a symbol (signature, docstring, first body line, side effects, caller count). Cached in SQLite by content hash — second call is free. Requires symbol. range: specific line range — use only when you need exact lines. full: raw content, no savings — explicit last resort; with a token budget it degrades to lighter modes first and reports `fullMode` metadata explaining whether full was actually used. maxTokens: token budget — auto-degrades to lighter modes before truncation; when the budget changes the result, `budgetDetails` reports the final mode, truncation actions, and marks `scope="content"`. Supports JS/TS, Python, Go, Rust, Java, C#, Kotlin, PHP, Swift, shell, Terraform, Dockerfile, SQL, JSON, TOML, YAML.',
    {
      filePath: z.string(),
      mode: z.enum(['full', 'outline', 'signatures', 'range', 'symbol', 'explain']).optional(),
      startLine: z.number().optional(),
      endLine: z.number().optional(),
      symbol: z.union([z.string(), z.array(z.string())]).optional(),
      maxTokens: z.number().int().min(1).optional(),
      tokenBudget: z.union([
        z.number().int().min(1),
        z.object({
          id: z.string().optional(),
          maxTokens: z.number().int().min(1),
          shared: z.boolean().optional(),
        }),
      ]).optional(),
      context: z.boolean().optional(),
    },
    async ({ filePath, mode = 'outline', startLine, endLine, symbol, maxTokens, tokenBudget, context }) =>
      asTextResult(await smartRead({ filePath, mode, startLine, endLine, symbol, maxTokens, tokenBudget, context })),
  );

  server.tool(
    'smart_read_batch',
    'Read multiple files in one call. Each item accepts path, mode (prefer outline/signatures/symbol/explain — full saves 0 tokens), symbol, startLine, endLine, maxTokens (per-file budget). Optional global maxTokens budget with early stop when exceeded; when that happens, `budgetDetails` reports the batch-level stop point, marks `scope="batch"`, and includes `actions`. Max 20 files per call.',
    {
      files: z.array(z.object({
        path: z.string(),
        mode: z.enum(['full', 'outline', 'signatures', 'range', 'symbol', 'explain']).optional(),
        symbol: z.union([z.string(), z.array(z.string())]).optional(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        maxTokens: z.number().int().min(1).optional(),
      })).min(1).max(20),
      maxTokens: z.number().int().min(1).optional(),
      tokenBudget: z.union([
        z.number().int().min(1),
        z.object({
          id: z.string().optional(),
          maxTokens: z.number().int().min(1),
          shared: z.boolean().optional(),
        }),
      ]).optional(),
    },
    async ({ files, maxTokens, tokenBudget }) =>
      asTextResult(await smartReadBatch({ files, maxTokens, tokenBudget })),
  );

  server.tool(
    'smart_search',
    'Search code with ranked, deduplicated results and index boosting. Best for: finding where a symbol is defined/used, understanding call chains, locating implementations. NOT ideal for: exact string matching (use Grep), finding files by name (use Glob), broad multi-word queries (generates noise). Optional intent adjusts ranking. `mode` controls search strategy: `needle` = exact literal only (no regex or term expansion), `balanced` = exact + regex + term expansion (default), `semantic` = exact-first plus a local semantic block only when exact signal is weak. maxFiles caps the number of files returned (default 5). maxTokens caps the overall response payload: `matches` is truncated first, then optional diagnostics and semantic blocks are compacted or omitted if needed. When budgeting happens, `budgetDetails` reports `actions`, which sections were compacted, and marks `scope="response"`. kinds filters results by symbol kind from the index — e.g. ["adr","adr-section"] returns only architecture decision docs; ["class","function"] returns only those declarations; use to scope a query to a domain. `semantic=true` remains supported as a legacy alias for `mode="semantic"`. semanticLimit caps the semantic block (default 8). Top ranked files include `matchedBy`, `boostSource`, `scoreBreakdown`, and `whyRanked` so ranking decisions are inspectable. Semantic block adds zero deps and runs in <5ms even on large indexes. When more files exist beyond the initial window, the response includes `hasMore`, `totalFiles`, and `nextSuggestedMaxFiles` to support expansion on demand. When the search is too broad or returns nothing useful, the response also includes actionable `suggestions` for refining the query, mode, or kinds.',
    {
      query: z.string(),
      cwd: z.string().optional(),
      intent: z.enum(['implementation', 'debug', 'tests', 'config', 'docs', 'explore']).optional(),
      maxFiles: z.number().int().min(1).max(50).optional(),
      maxTokens: z.number().int().min(1).optional(),
      kinds: z.array(z.string()).optional(),
      mode: z.enum(['needle', 'balanced', 'semantic']).optional(),
      semantic: z.boolean().optional(),
      semanticLimit: z.number().int().min(1).max(50).optional(),
    },
    async ({ query, cwd = '.', intent, maxFiles, maxTokens, kinds, mode, semantic, semanticLimit }) =>
      asTextResult(await smartSearch({ query, cwd, intent, maxFiles, maxTokens, kinds, mode, semantic, semanticLimit })),
  );

  server.tool(
    'smart_context',
    'PREFERRED for multi-file tasks. Gets curated context in one call — replaces the manual search → read → read cycle. Combines search + graph expansion + selective reading. Primary files always include content (signatures) in balanced mode — reduces follow-up smart_read calls. Options: intent, maxTokens (budget, default 12000), diff (true for HEAD or branch name), detail (minimal/balanced/deep), include (content/graph/hints/symbolDetail), prefetch (true for predictive loading). Paths mode: pass `paths: { from, to }` to traverse the import graph between two files or symbols (BFS, max 5 hops by default). Returns the chain of files with signatures per hop, or nearest neighbors when no path exists. Use this instead of multiple smart_read+smart_search cycles to answer "how does X reach Y?". Call smart_context FIRST before individual smart_read/smart_search calls.',
    {
      task: z.string().optional(),
      intent: z.enum(['implementation', 'debug', 'tests', 'config', 'docs', 'explore']).optional(),
      maxTokens: z.number().optional(),
      tokenBudget: z.union([
        z.number().int().min(1),
        z.object({
          id: z.string().optional(),
          maxTokens: z.number().int().min(1),
          shared: z.boolean().optional(),
        }),
      ]).optional(),
      entryFile: z.string().optional(),
      diff: z.union([z.boolean(), z.string()]).optional(),
      detail: z.enum(['minimal', 'balanced', 'deep']).optional(),
      include: z.array(z.enum(['content', 'graph', 'hints', 'symbolDetail'])).optional(),
      prefetch: z.boolean().optional(),
      paths: z.object({
        from: z.string(),
        to: z.string(),
      }).optional(),
      pathMaxHops: z.number().int().min(1).max(10).optional(),
      pathDirected: z.boolean().optional(),
    },
    async ({ task, intent, maxTokens, tokenBudget, entryFile, diff, detail, include, prefetch, paths, pathMaxHops, pathDirected }) =>
      asTextResult(await smartContext({ task, intent, maxTokens, tokenBudget, entryFile, diff, detail, include, prefetch, paths, pathMaxHops, pathDirected })),
  );

  server.tool(
    'smart_shell',
    'Run a diagnostic shell command from an allowlist. Allowed: pwd, ls, find, rg, git (status/diff/show/log/branch/rev-parse), npm/pnpm/yarn/bun (test/run/lint/build/typecheck/check). Blocks shell operators, pipes, and unsafe commands. For large diffs: output is split by file (up to 8 files, 60 lines each); prefer git diff --stat first, then git show -- <file> per file.',
    {
      command: z.string(),
    },
    async ({ command }) => asTextResult(await smartShell({ command })),
  );

  server.tool(
    'smart_test',
    'Test orchestration tied to the import graph. Three actions: (1) action="affected" — given a git diff (default HEAD), expand changed files through the import graph (max 2 hops by default) and return the list of test files that should re-run; no execution. (2) action="run" — execute a test runner from an allowlist (npm-test, npm-run, pnpm-test, pnpm-run, yarn-test, yarn-run, bun-test, bun-run, node-test, vitest, jest). Optional `script` for `*-run`, optional `files` list to target specific tests. Output is compressed; on failure the last_failure record is persisted in SQLite. (3) action="last_failure" — return the last persisted red run (command, exit code, failures, output excerpt). Replaces "run full suite + manually inspect failures" cycles.',
    {
      action: z.enum(['affected', 'run', 'last_failure']),
      diff: z.union([z.boolean(), z.string()]).optional(),
      maxHops: z.number().int().min(1).max(5).optional(),
      maxFiles: z.number().int().min(1).max(200).optional(),
      runner: z.enum(['npm-test', 'npm-run', 'pnpm-test', 'pnpm-run', 'yarn-test', 'yarn-run', 'bun-test', 'bun-run', 'node-test', 'vitest', 'jest']).optional(),
      script: z.string().optional(),
      files: z.array(z.string()).optional(),
      ref: z.string().optional(),
    },
    async ({ action, diff, maxHops, maxFiles, runner, script, files, ref }) =>
      asTextResult(await smartTest({ action, diff, maxHops, maxFiles, runner, script, files, ref })),
  );

  server.tool(
    'smart_review',
    'Code review preflight in one call. Given a git ref (default HEAD), returns per-file: additions/deletions, changeType, callers (importedBy), affected tests (testOf), changed symbols, and offline heuristic findings (TODO/FIXME, console.log, print, debugger, eval, dynamic Function, process.exit, "as any"/": any", alert, hardcoded secret patterns). Summary aggregates issuesBySeverity, coverageGap (files changed without their tests touched), layersTouched + crossLayer flag (domain/application/infrastructure/presentation by path heuristic). Optional includeBlame: true performs git blame on changed symbol lines (capped to 3 per file). Replaces "git diff + manual grep + locate tests + check callers" loops with a single structured payload an agent can reason over.',
    {
      ref: z.string().optional(),
      maxFiles: z.number().int().min(1).max(200).optional(),
      maxCallers: z.number().int().min(0).max(50).optional(),
      maxTests: z.number().int().min(0).max(50).optional(),
      includeBlame: z.boolean().optional(),
    },
    async ({ ref, maxFiles, maxCallers, maxTests, includeBlame }) =>
      asTextResult(await smartReview({ ref, maxFiles, maxCallers, maxTests, includeBlame })),
  );

  server.tool(
    'smart_playbook',
    'Run a declarative workflow (playbook) that composes other smart_* tools in one call. Built-in playbooks: preflight-merge (smart_review + smart_test affected + checkpoint), debug-flake (last_failure + curated debug context + affected tests), refactor-safe (curated context + affected tests + checkpoint), doc-sync (ADR search + docs context), ramp-up (status + doctor + ADR overview). Override or add your own in .devctx/playbooks/*.yaml (or *.json). Pass list=true to enumerate available playbooks. Pass dryRun=true to resolve and validate steps without executing them. Args support {{args.X}} interpolation against defaults + caller args. Only smart_* tools are allowed inside playbooks; shell access stays gated by smart_shell allowlist.',
    {
      name: z.string().optional(),
      args: z.record(z.string(), z.any()).optional(),
      list: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      stopOnFail: z.boolean().optional(),
    },
    async ({ name, args, list, dryRun, stopOnFail }) =>
      asTextResult(await smartPlaybook({ name, args, list, dryRun, stopOnFail })),
  );

  server.tool(
    'global_memory',
    'Opt-in cross-project memory persisted to ~/.devctx/global.db (override with DEVCTX_GLOBAL_DB). Enable via DEVCTX_GLOBAL_MEMORY=true. Stores canonical decisions, recurring patterns, playbook drafts, notes, and repo-local noise hints so an agent can carry insights between repos without re-deriving them. Content is scrubbed for likely secrets/JWTs/API keys/emails/home paths before being persisted. Project paths are stored hashed (FNV-1a) instead of raw. Actions: save (kind+content+tags?), recall (kind?+query?+limit? — uses local hashing/TF-IDF embedder for ranking, zero deps), list (counts per kind), delete (id), mark_used (id), stats (db size + per-kind totals), noise_stats (inspect repo noise hints), noise_reset (reset repo noise hints or one hint via query). Valid kinds: decision, pattern, playbook, note. projectScope=true (default) hashes the current project so recall can be filtered per-project; set false for repo-agnostic access.',
    {
      action: z.enum(['save', 'recall', 'list', 'delete', 'stats', 'mark_used', 'noise_stats', 'noise_reset']),
      kind: z.enum(['decision', 'pattern', 'playbook', 'note']).optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      id: z.number().int().optional(),
      projectScope: z.boolean().optional(),
    },
    async ({ action, kind, content, tags, query, limit, id, projectScope }) =>
      asTextResult(await globalMemory({ action, kind, content, tags, query, limit, id, projectScope })),
  );

  server.tool(
    'build_index',
    'Build a lightweight symbol index for the project. Speeds up smart_search ranking and smart_read symbol lookups. Pass incremental=true to only reindex files with changed mtime (much faster for large repos). Pass warmCache=true to preload frequently accessed files after indexing. Without incremental, rebuilds from scratch. Sends progress notifications during indexing for large projects.',
    {
      incremental: z.boolean().optional(),
      warmCache: z.boolean().optional(),
    },
    async ({ incremental, warmCache }) => {
      const { createProgressReporter } = await import('./streaming.js');
      const progress = createProgressReporter('build_index');

      try {
        if (incremental) {
          const { index, stats } = buildIndexIncremental(projectRoot, progress);
          await persistIndex(index, projectRoot);
          const symbolCount = Object.values(index.files).reduce((sum, f) => sum + f.symbols.length, 0);
          const result = { status: 'ok', files: stats.total, symbols: symbolCount, ...stats };
          
          if (warmCache) {
            const { warmCache: warmCacheFn } = await import('./cache-warming.js');
            const warmResult = await warmCacheFn(projectRoot, progress);
            result.cacheWarming = warmResult;
          }
          
          progress.complete(result);
          return asTextResult(result);
        }

        const index = buildIndex(projectRoot, progress);
        await persistIndex(index, projectRoot);
        const fileCount = Object.keys(index.files).length;
        const symbolCount = Object.values(index.files).reduce((sum, f) => sum + f.symbols.length, 0);
        const result = { status: 'ok', files: fileCount, symbols: symbolCount };
        
        if (warmCache) {
          const { warmCache: warmCacheFn } = await import('./cache-warming.js');
          const warmResult = await warmCacheFn(projectRoot, progress);
          result.cacheWarming = warmResult;
        }
        
        progress.complete(result);
        return asTextResult(result);
      } catch (error) {
        progress.error(error);
        throw error;
      }
    },
  );

  server.tool(
    'warm_cache',
    'Preload frequently accessed files into OS cache to reduce cold-start latency. Analyzes last 30 days of access patterns and warms the top 50 most-used files (configurable via DEVCTX_WARM_FILES env). Skips files >1MB. Returns warmed/skipped counts. Use after build_index or before starting intensive work sessions.',
    {},
    async () => {
      const { createProgressReporter } = await import('./streaming.js');
      const { warmCache: warmCacheFn } = await import('./cache-warming.js');
      
      const progress = createProgressReporter('warm_cache');
      
      try {
        const result = await warmCacheFn(projectRoot, progress);
        progress.complete(result);
        return asTextResult(result);
      } catch (error) {
        progress.error(error);
        throw error;
      }
    },
  );

  server.tool(
    'git_blame',
    'Get symbol-level git blame attribution. Modes: symbol (blame for specific file symbols), file (aggregated file stats), author (find symbols by author), recent (recently modified symbols). Returns author, email, date, commit, and authorship percentage for each symbol. Requires git repository and symbol index.',
    {
      mode: z.enum(['symbol', 'file', 'author', 'recent']),
      filePath: z.string().optional(),
      authorQuery: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      daysBack: z.number().int().min(1).max(365).optional(),
    },
    async ({ mode, filePath, authorQuery, limit, daysBack }) => {
      try {
        if (mode === 'symbol') {
          if (!filePath) {
            throw new Error('filePath is required for symbol mode');
          }
          const result = await getSymbolBlame(filePath, projectRoot);
          return asTextResult({ mode, filePath, symbols: result });
        }

        if (mode === 'file') {
          if (!filePath) {
            throw new Error('filePath is required for file mode');
          }
          const result = await getFileAuthorshipStats(filePath, projectRoot);
          return asTextResult({ mode, filePath, ...result });
        }

        if (mode === 'author') {
          if (!authorQuery) {
            throw new Error('authorQuery is required for author mode');
          }
          const result = await findSymbolsByAuthor(authorQuery, projectRoot, limit || 50);
          return asTextResult({ mode, authorQuery, matches: result.length, symbols: result });
        }

        if (mode === 'recent') {
          const result = await getRecentlyModifiedSymbols(projectRoot, limit || 20, daysBack || 30);
          return asTextResult({ mode, daysBack: daysBack || 30, symbols: result });
        }

        throw new Error(`Unknown mode: ${mode}`);
      } catch (error) {
        return asTextResult({ error: error.message, mode, filePath, authorQuery });
      }
    },
  );

  server.tool(
    'cross_project',
    'Work with multiple related projects (monorepos, microservices, shared libraries). Modes: discover (list related projects), search (search across projects), read (read files from multiple projects), symbol (find symbol definitions across projects), deps (get cross-project dependency graph), stats (usage statistics). Requires .devctx-projects.json config file in project root.',
    {
      mode: z.enum(['discover', 'search', 'read', 'symbol', 'deps', 'stats']),
      query: z.string().optional(),
      intent: z.enum(['implementation', 'debug', 'tests', 'config', 'docs']).optional(),
      symbolName: z.string().optional(),
      fileRefs: z.array(z.object({
        project: z.string(),
        file: z.string(),
        mode: z.enum(['full', 'outline', 'symbols']).optional(),
      })).optional(),
      maxResultsPerProject: z.number().int().min(1).max(20).optional(),
      includeProjects: z.array(z.string()).optional(),
      excludeProjects: z.array(z.string()).optional(),
    },
    async ({ mode, query, intent, symbolName, fileRefs, maxResultsPerProject, includeProjects, excludeProjects }) => {
      try {
        if (mode === 'discover') {
          const projects = discoverRelatedProjects(projectRoot);
          return asTextResult({ mode, projects });
        }

        if (mode === 'search') {
          if (!query) {
            throw new Error('query is required for search mode');
          }
          const results = await searchAcrossProjects(query, {
            root: projectRoot,
            intent: intent || 'implementation',
            maxResultsPerProject: maxResultsPerProject || 5,
            includeProjects,
            excludeProjects,
          });
          return asTextResult({ mode, query, intent, totalProjects: results.length, results });
        }

        if (mode === 'read') {
          if (!fileRefs || fileRefs.length === 0) {
            throw new Error('fileRefs is required for read mode');
          }
          const results = await readAcrossProjects(fileRefs, projectRoot);
          return asTextResult({ mode, filesRead: results.length, results });
        }

        if (mode === 'symbol') {
          if (!symbolName) {
            throw new Error('symbolName is required for symbol mode');
          }
          const results = await findSymbolAcrossProjects(symbolName, projectRoot);
          return asTextResult({ mode, symbolName, matches: results.length, results });
        }

        if (mode === 'deps') {
          const deps = getCrossProjectDependencies(projectRoot);
          return asTextResult({ mode, ...deps });
        }

        if (mode === 'stats') {
          const stats = getCrossProjectStats(projectRoot);
          return asTextResult({ mode, ...stats });
        }

        throw new Error(`Unknown mode: ${mode}`);
      } catch (error) {
        return asTextResult({ error: error.message, mode });
      }
    },
  );

  server.tool(
    'smart_summary',
    'Maintain compressed conversation state across turns. Actions: get (retrieve current/last session), update (create or replace a session; omitted fields are cleared), append (add to existing session), auto_append (append only if something meaningful changed), checkpoint (event-driven orchestration that decides whether to auto-persist), reset (clear session), list_sessions (show all sessions), compact (apply retention/compaction to SQLite events), cleanup_legacy (inspect or remove imported legacy JSON/JSONL files). Sessions persist in project-local SQLite with 30-day retention defaults. Auto-generates sessionId from goal if omitted. `get` auto-resumes the active session when present, otherwise falls back to the best saved session when unambiguous; pass `sessionId: "auto"` to accept the recommended session even when multiple recent candidates exist. Returns a resume summary capped at maxTokens (default 500) plus compression metadata (`truncated`, `compressionLevel`, `omitted`) and `schemaVersion`. Exposes `repoSafety`, `mutationSafety`, `degradedMode`, and `storageHealth` so agents can detect blocked, read-only, missing, oversized, locked, or corrupted local state. Tracks: goal, status, pinned context, unresolved questions, current focus, blockers, next step, completed steps, key decisions, and touched files.',
    {
      action: z.enum(['get', 'update', 'append', 'auto_append', 'checkpoint', 'reset', 'list_sessions', 'compact', 'cleanup_legacy']),
      sessionId: z.string().optional(),
      update: z.object({
        goal: z.string().optional(),
        status: z.enum(['planning', 'in_progress', 'blocked', 'completed']).optional(),
        pinnedContext: z.array(z.string()).optional(),
        unresolvedQuestions: z.array(z.string()).optional(),
        currentFocus: z.string().optional(),
        whyBlocked: z.string().optional(),
        completed: z.array(z.string()).optional(),
        decisions: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        nextStep: z.string().optional(),
        touchedFiles: z.array(z.string()).optional(),
      }).optional(),
      event: z.enum(['manual', 'milestone', 'decision', 'blocker', 'status_change', 'file_change', 'task_switch', 'task_complete', 'session_end', 'read_only', 'heartbeat']).optional(),
      force: z.boolean().optional(),
      maxTokens: z.number().int().min(100).max(2000).optional(),
      retentionDays: z.number().int().min(1).max(3650).optional(),
      keepLatestEventsPerSession: z.number().int().min(0).max(10000).optional(),
      keepLatestMetrics: z.number().int().min(0).max(100000).optional(),
      vacuum: z.boolean().optional(),
      apply: z.boolean().optional(),
      goal: z.string().optional(),
      status: z.enum(['planning', 'in_progress', 'blocked', 'completed']).optional(),
      pinnedContext: z.array(z.string()).optional(),
      unresolvedQuestions: z.array(z.string()).optional(),
      currentFocus: z.string().optional(),
      whyBlocked: z.string().optional(),
      completed: z.array(z.string()).optional(),
      decisions: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      nextStep: z.string().optional(),
      touchedFiles: z.array(z.string()).optional(),
    },
    async ({ action, sessionId, update, event, force, maxTokens, retentionDays, keepLatestEventsPerSession, keepLatestMetrics, vacuum, apply, goal, status, pinnedContext, unresolvedQuestions, currentFocus, whyBlocked, completed, decisions, blockers, nextStep, touchedFiles }) =>
      asTextResult(await smartSummary({
        action,
        sessionId,
        update,
        event,
        force,
        maxTokens,
        retentionDays,
        keepLatestEventsPerSession,
        keepLatestMetrics,
        vacuum,
        apply,
        goal,
        status,
        pinnedContext,
        unresolvedQuestions,
        currentFocus,
        whyBlocked,
        completed,
        decisions,
        blockers,
        nextStep,
        touchedFiles,
      })),
  );

  server.tool(
    'smart_status',
    'Display the current session context including goal, status, recent decisions, touched files, and progress. Returns a formatted summary of what has been done and what is being tracked in the active session. Use this to understand the current state of work without modifying the session. Supports format=detailed (default, full formatted output) or format=compact (minimal JSON). Optional maxItems limits how many recent items to show (default 10). Exposes `mutationSafety`, `repoSafety`, `degradedMode`, and `storageHealth` when repo-safety or SQLite storage health affects session reads.',
    {
      format: z.enum(['detailed', 'compact']).optional(),
      maxItems: z.number().int().min(1).max(50).optional(),
    },
    async ({ format, maxItems }) => asTextResult(await smartStatus({ format, maxItems })),
  );

  server.tool(
    'smart_doctor',
    'Run an operational health check for local devctx state. Aggregates repo hygiene, SQLite `storageHealth`, retention/compaction hygiene, and legacy JSON/JSONL cleanup guidance into one inspect-only result with explicit remediation steps. Use this when `.devctx/state.sqlite` is missing, oversized, locked, corrupted, or when you want a release/preflight check for local state durability.',
    {
      verifyIntegrity: z.boolean().optional(),
    },
    async ({ verifyIntegrity }) => asTextResult(await smartDoctor({ verifyIntegrity })),
  );

  server.tool(
    'smart_edit',
    'Batch edit multiple files with pattern replacement. Supports literal string replacement or regex patterns. Use for bulk refactoring, removing patterns (comments, console.log, etc.), or renaming across files. Optional dryRun shows preview without modifying files. Returns match count and results per file.',
    {
      pattern: z.string(),
      replacement: z.string(),
      files: z.array(z.string()).min(1).max(50),
      mode: z.enum(['literal', 'regex']).optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ pattern, replacement, files, mode, dryRun }) => 
      asTextResult(await smartEdit({ pattern, replacement, files, mode, dryRun })),
  );

  server.tool(
    'smart_turn',
    'Orchestrate start/end of a meaningful agent turn for multi-session tasks where context continuity matters. SKIP for single-session point-in-time tasks (reviewing a specific commit, answering a quick question, one-off lookup) — the setup overhead exceeds the benefit if the session will never be resumed. USE when: the task spans multiple chat sessions, you may return to it the next day, or the codebase context is large enough that re-reading is expensive. `phase: "start"` rehydrates persisted context, classifies prompt continuity against the saved session, optionally auto-creates a planning session for a new substantial task, returns `recommendedPath` guidance for the next safe devctx actions, and can include compact metrics. `phase: "end"` writes a checkpoint through smart_summary, returns follow-up `recommendedPath` guidance, and can optionally include compact metrics. Both phases expose `mutationSafety` when repo-safety blocks persisted writes and surface `storageHealth` when SQLite state is missing, oversized, locked, or corrupted.',
    {
      phase: z.enum(['start', 'end']),
      sessionId: z.string().optional(),
      prompt: z.string().optional(),
      update: z.object({
        goal: z.string().optional(),
        status: z.enum(['planning', 'in_progress', 'blocked', 'completed']).optional(),
        pinnedContext: z.array(z.string()).optional(),
        unresolvedQuestions: z.array(z.string()).optional(),
        currentFocus: z.string().optional(),
        whyBlocked: z.string().optional(),
        completed: z.array(z.string()).optional(),
        decisions: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        nextStep: z.string().optional(),
        touchedFiles: z.array(z.string()).optional(),
      }).optional(),
      event: z.enum(['manual', 'milestone', 'decision', 'blocker', 'status_change', 'file_change', 'task_switch', 'task_complete', 'session_end', 'read_only', 'heartbeat']).optional(),
      force: z.boolean().optional(),
      maxTokens: z.number().int().min(100).max(2000).optional(),
      tokenBudget: z.union([
        z.number().int().min(1),
        z.object({
          id: z.string().optional(),
          maxTokens: z.number().int().min(1),
          shared: z.boolean().optional(),
        }),
      ]).optional(),
      ensureSession: z.boolean().optional(),
      includeMetrics: z.boolean().optional(),
      metricsWindow: z.enum(['24h', '7d', '30d', 'all']).optional(),
      latestMetrics: z.number().int().min(1).max(20).optional(),
      verbosity: z.enum(['minimal', 'standard', 'full']).optional().describe('Default "minimal" — returns compact recommendedPath/continuity/task. Use "standard" or "full" only when you need long instructions, candidates, or full checkpoint diagnostics.'),
    },
    async ({ phase, sessionId, prompt, update, event, force, maxTokens, tokenBudget, ensureSession, includeMetrics, metricsWindow, latestMetrics, verbosity }) =>
      asTextResult(await smartTurn({
        phase,
        sessionId,
        prompt,
        update,
        event,
        force,
        maxTokens,
        tokenBudget,
        ensureSession,
        includeMetrics,
        metricsWindow,
        latestMetrics,
        verbosity,
      })),
  );

  server.tool(
    'smart_resume',
    'Lightweight entry point for the first prompt of a substantial task. Equivalent to smart_turn(phase=start, ensureSession=true, verbosity=minimal): rehydrates the most recent persisted session for this project, classifies prompt continuity, and returns a compact recommendedPath. Prefer this over smart_turn(start) when you just want to recover context cheaply at the beginning of a session. SKIP for one-off lookups, single-line fixes, or trivial questions where re-reading is faster than rehydration.',
    {
      prompt: z.string().optional(),
      sessionId: z.string().optional(),
      taskId: z.string().optional(),
      maxTokens: z.number().int().min(100).max(2000).optional(),
      tokenBudget: z.union([
        z.number().int().min(1),
        z.object({
          id: z.string().optional(),
          maxTokens: z.number().int().min(1),
          shared: z.boolean().optional(),
        }),
      ]).optional(),
      verbosity: z.enum(['minimal', 'standard', 'full']).optional(),
    },
    async ({ prompt, sessionId, taskId, maxTokens, tokenBudget, verbosity }) =>
      asTextResult(await smartTurn({
        phase: 'start',
        prompt,
        sessionId,
        taskId,
        maxTokens,
        tokenBudget,
        ensureSession: true,
        verbosity: verbosity ?? 'minimal',
      })),
  );

  server.tool(
    'smart_metrics',
    'Inspect token metrics recorded in project-local SQLite storage by default. Returns aggregated totals, per-tool savings, recent entries, adoption analysis, and `productQuality` signals measured from `smart_turn` orchestration events (continuity recovery, blocked-state remediation coverage, context-refresh signals, checkpoint persistence). Supports time windows (`24h`, `7d`, `30d`, `all`), optional tool filtering, and optional session filtering (`sessionId: "active"` resolves the current active session automatically). Pass `file` to inspect a legacy/custom JSONL file explicitly. When `.devctx/state.sqlite` is tracked or staged, reads fall back to a temporary read-only snapshot and expose `repoSafety`, `mutationSafety`, `degradedMode`, `sideEffectsSuppressed`, and `storageHealth`; metrics writes from other tools are skipped until git hygiene is fixed.',
    {
      file: z.string().optional(),
      tool: z.string().optional(),
      sessionId: z.string().optional(),
      window: z.enum(['24h', '7d', '30d', 'all']).optional(),
      latest: z.number().int().min(1).max(50).optional(),
    },
    async ({ file, tool, sessionId, window, latest }) =>
      asTextResult(await smartMetrics({ file, tool, sessionId, window, latest })),
  );

  return server;
};

export const runDevctxServer = async () => {
  if (process.env.DEVCTX_DEBUG === '1') {
    process.stderr.write(`devctx project root (${projectRootSource}): ${projectRoot}\n`);
  }

  const server = createDevctxServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const watcher = isWatchEnabled() ? startIndexWatcher() : null;
  if (watcher) {
    setActiveWatcher(watcher);
    if (process.env.DEVCTX_DEBUG === '1') {
      process.stderr.write('[devctx] reactive index watcher: ENABLED\n');
    }
  }

  const shutdown = () => {
    const finalize = async () => {
      try { if (watcher) await watcher.stop(); } catch { /* noop */ }
      try { setActiveWatcher(null); } catch { /* noop */ }
      try { await transport.close(); } catch { /* noop */ }
      process.exit(0);
    };
    finalize();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
};
