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
import { smartSummary } from './tools/smart-summary.js';
import { projectRoot, projectRootSource } from './utils/paths.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

export const asTextResult = (result) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(result, null, 2),
    },
  ],
});

export const createDevctxServer = () => {
  const server = new McpServer({
    name: 'devctx',
    version,
  });

  server.tool(
    'smart_read',
    'Read a file with token-efficient modes. outline/signatures: compact structure (~90% savings). range: specific line range with line numbers. symbol: extract function/class/method by name (string or array for batch). full: file content capped at 12k chars. maxTokens: token budget — auto-selects the most detailed mode that fits (full -> outline -> signatures -> truncated). context=true (symbol mode only): includes callers, tests, and referenced types from the dependency graph; returns graphCoverage (imports/tests: full|partial|none) so the agent knows how reliable the cross-file context is. Responses are cached in memory per session and invalidated by file mtime; cached=true when served from cache. Every response includes a unified confidence block: { parser, truncated, cached, graphCoverage? }. Supports JS/TS, Python, Go, Rust, Java, C#, Kotlin, PHP, Swift, shell, Terraform, Dockerfile, SQL, JSON, TOML, YAML.',
    {
      filePath: z.string(),
      mode: z.enum(['full', 'outline', 'signatures', 'range', 'symbol']).optional(),
      startLine: z.number().optional(),
      endLine: z.number().optional(),
      symbol: z.union([z.string(), z.array(z.string())]).optional(),
      maxTokens: z.number().int().min(1).optional(),
      context: z.boolean().optional(),
    },
    async ({ filePath, mode = 'outline', startLine, endLine, symbol, maxTokens, context }) =>
      asTextResult(await smartRead({ filePath, mode, startLine, endLine, symbol, maxTokens, context })),
  );

  server.tool(
    'smart_read_batch',
    'Read multiple files in one call. Each item accepts path, mode, symbol, startLine, endLine, maxTokens (per-file budget). Optional global maxTokens budget with early stop when exceeded. Max 20 files per call.',
    {
      files: z.array(z.object({
        path: z.string(),
        mode: z.enum(['full', 'outline', 'signatures', 'range', 'symbol']).optional(),
        symbol: z.union([z.string(), z.array(z.string())]).optional(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        maxTokens: z.number().int().min(1).optional(),
      })).min(1).max(20),
      maxTokens: z.number().int().min(1).optional(),
    },
    async ({ files, maxTokens }) =>
      asTextResult(await smartReadBatch({ files, maxTokens })),
  );

  server.tool(
    'smart_search',
    'Search code across the project using ripgrep (with filesystem fallback). Returns grouped, ranked results. Optional intent (implementation/debug/tests/config/docs/explore) adjusts ranking: tests boosts test files, config boosts config files, docs reduces penalty on READMEs. Includes a unified confidence block: { level, indexFreshness } plus retrievalConfidence and provenance metadata.',
    {
      query: z.string(),
      cwd: z.string().optional(),
      intent: z.enum(['implementation', 'debug', 'tests', 'config', 'docs', 'explore']).optional(),
    },
    async ({ query, cwd = '.', intent }) => asTextResult(await smartSearch({ query, cwd, intent })),
  );

  server.tool(
    'smart_context',
    'Get curated context for a task in one call. Combines smart_search + smart_read + graph expansion. Returns relevant files, evidence for why each file was included, related tests, dependencies, symbol previews from the index, and symbol details — optimized for tokens. Includes a unified confidence block: { indexFreshness, graphCoverage } indicating index state and how complete the relational context is. Replaces the manual search → read → read cycle. Optional intent override, token budget, diff mode (pass diff=true for HEAD or diff="main" to scope context to changed files only), detail mode (minimal=index+signatures+snippets, balanced=default, deep=full content), and include array to control which fields are returned (["content","graph","hints","symbolDetail"]).',
    {
      task: z.string(),
      intent: z.enum(['implementation', 'debug', 'tests', 'config', 'docs', 'explore']).optional(),
      maxTokens: z.number().optional(),
      entryFile: z.string().optional(),
      diff: z.union([z.boolean(), z.string()]).optional(),
      detail: z.enum(['minimal', 'balanced', 'deep']).optional(),
      include: z.array(z.enum(['content', 'graph', 'hints', 'symbolDetail'])).optional(),
    },
    async ({ task, intent, maxTokens, entryFile, diff, detail, include }) =>
      asTextResult(await smartContext({ task, intent, maxTokens, entryFile, diff, detail, include })),
  );

  server.tool(
    'smart_shell',
    'Run a diagnostic shell command from an allowlist. Allowed: pwd, ls, find, rg, git (status/diff/show/log/branch/rev-parse), npm/pnpm/yarn/bun (test/run/lint/build/typecheck/check). Blocks shell operators, pipes, and unsafe commands. Includes a unified confidence block: { blocked, timedOut }.',
    {
      command: z.string(),
    },
    async ({ command }) => asTextResult(await smartShell({ command })),
  );

  server.tool(
    'build_index',
    'Build a lightweight symbol index for the project. Speeds up smart_search ranking and smart_read symbol lookups. Pass incremental=true to only reindex files with changed mtime (much faster for large repos). Without incremental, rebuilds from scratch.',
    {
      incremental: z.boolean().optional(),
    },
    async ({ incremental }) => {
      if (incremental) {
        const { index, stats } = buildIndexIncremental(projectRoot);
        await persistIndex(index, projectRoot);
        const symbolCount = Object.values(index.files).reduce((sum, f) => sum + f.symbols.length, 0);
        return asTextResult({ status: 'ok', files: stats.total, symbols: symbolCount, ...stats });
      }

      const index = buildIndex(projectRoot);
      await persistIndex(index, projectRoot);
      const fileCount = Object.keys(index.files).length;
      const symbolCount = Object.values(index.files).reduce((sum, f) => sum + f.symbols.length, 0);
      return asTextResult({ status: 'ok', files: fileCount, symbols: symbolCount });
    },
  );

  server.tool(
    'smart_summary',
    'Maintain compressed conversation state across turns. Actions: get (retrieve current/last session), update (create or replace a session; omitted fields are cleared), append (add to existing session), reset (clear session), list_sessions (show all sessions). Sessions persist in .devctx/sessions/ with 30-day retention. Auto-generates sessionId from goal if not provided. Returns a resume summary capped at maxTokens (default 500) plus compression metadata (`truncated`, `compressionLevel`, `omitted`) and `schemaVersion`. Tracks: goal, status, pinned context, unresolved questions, current focus, blockers, next step, completed steps, key decisions, and touched files.',
    {
      action: z.enum(['get', 'update', 'append', 'reset', 'list_sessions']),
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
      maxTokens: z.number().int().min(100).max(2000).optional(),
    },
    async ({ action, sessionId, update, maxTokens }) =>
      asTextResult(await smartSummary({ action, sessionId, update, maxTokens })),
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

  const shutdown = () => {
    transport.close().catch(() => {}).finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
};
