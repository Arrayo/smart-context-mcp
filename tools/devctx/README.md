# devctx-mcp

`devctx-mcp` is a local MCP server for AI coding agents that need less raw context and more useful signal.

It exposes:

- `smart_read`: compact file summaries instead of full-file dumps
- `smart_read_batch`: read multiple files in one call — reduces round-trip latency
- `smart_search`: ripgrep-first code search with grouped, ranked results and intent-aware ranking
- `smart_context`: one-call context planner that combines search + read + graph expansion
- `smart_shell`: safe diagnostic shell execution with a restricted allowlist
- `build_index`: lightweight symbol index for faster lookups and smarter ranking

## Quick start

```bash
npm install devctx-mcp
npx devctx-init --target .
```

This installs the MCP server and generates client configs for Cursor, Codex, Qwen, and Claude Code. Open the project with your IDE/agent and devctx starts automatically.

## Binaries

The package exposes three binaries:

- `devctx-server`
- `devctx-init`
- `devctx-report`

Start the MCP server against the current project:

```bash
devctx-server
```

Start it against another repository:

```bash
devctx-server --project-root /path/to/target-repo
```

## Generate client configs

Generate MCP config files for a target project:

```bash
devctx-init --target /path/to/project
```

Limit the generated clients if needed:

```bash
devctx-init --target /path/to/project --clients cursor,codex,qwen,claude
```

Override the command used in generated configs:

```bash
devctx-init --target /path/to/project --command node --args '["./tools/devctx/src/mcp-server.js"]'
```

## Metrics

Each tool call persists token metrics to the target repo by default in:

```bash
.devctx/metrics.jsonl
```

This makes per-repo usage visible without digging into `node_modules`. Running `devctx-init` also adds `.devctx/` to the target repo's `.gitignore` idempotently.

Show a quick report:

```bash
devctx-report
```

Show JSON output or a custom file:

```bash
devctx-report --json
devctx-report --file ./.devctx/metrics.jsonl
```

Example output:

```text
devctx metrics report

File:         /path/to/repo/.devctx/metrics.jsonl
Source:       default
Entries:      148
Raw tokens:   182,340
Final tokens: 41,920
Saved tokens: 140,420 (77.01%)

By tool:
  smart_context  count=42 raw=96,200 final=24,180 saved=72,020 (74.86%)
  smart_read     count=71 raw=52,810 final=9,940 saved=42,870 (81.18%)
  smart_search   count=35 raw=33,330 final=7,800 saved=25,530 (76.59%)
```

If you want to override the location entirely, set `DEVCTX_METRICS_FILE`.

## Usage per client

After installing and running `devctx-init`, each client picks up devctx automatically:

### Cursor

Open the project in Cursor. The MCP server starts automatically. Enable it in **Cursor Settings > MCP** if needed. All six tools are available in Agent mode.

### Codex CLI

```bash
cd /path/to/your-project
codex
```

Codex reads `.codex/config.toml` and starts the MCP server on launch.

### Claude Code

```bash
cd /path/to/your-project
claude
```

Claude Code reads `.mcp.json` from the project root.

### Qwen Code

Open the project in Qwen Code. The MCP server starts from `.qwen/settings.json`.

## Agent rules

`devctx-init` also generates agent rules that instruct AI agents to prefer devctx tools over their built-in equivalents. This is what makes agents actually use `smart_read` in outline/signatures mode instead of reading full files.

The rules include task-specific strategies with `intent` parameter for `smart_search`:

- **Debugging**: `intent=debug` → search error → read signatures → inspect symbol → smart_shell for errors
- **Review**: `intent=implementation` → read outline/signatures, focus on changed symbols, minimal changes
- **Refactor**: `intent=implementation` → signatures for public API, preserve behavior, small edits
- **Tests**: `intent=tests` → find existing tests (test files rank higher), read symbol of function under test
- **Config**: `intent=config` → find settings, env vars, infrastructure files (config files rank higher)
- **Architecture**: `intent=explore` → directory structure, outlines of key modules and API boundaries

Generated files per client:

- **Cursor**: `.cursor/rules/devctx.mdc` (always-apply rule)
- **Codex**: `AGENTS.md` (devctx section with sentinel markers)
- **Claude Code**: `CLAUDE.md` (devctx section with sentinel markers)

The rules are idempotent — running `devctx-init` again updates the section without duplicating it. Existing content in `AGENTS.md` and `CLAUDE.md` is preserved.

## What it is good at

Strong fit:

- JavaScript / TypeScript apps and monorepos
- React, Next.js, Node.js backends
- Python services and scripts
- Infra / platform repos with Terraform, Docker, YAML, shell, SQL

Good fit:

- Go services
- Rust services and libraries
- Java backends with straightforward structure
- C# / .NET projects
- Kotlin backends and Android projects
- PHP applications (Laravel, Symfony, etc.)
- Swift projects and iOS codebases

Partial fit:

- Large enterprise Java/C# codebases with heavy framework magic
- Repos with a lot of generated code
- Polyglot monorepos where semantic ranking matters more than text structure

Not a strong fit yet:

- Ruby, Elixir, Scala
- Codebases that need deep semantic understanding everywhere
- Use cases where `smart_shell` must behave like a general shell

## Tool behavior

### `smart_read`

Modes:

- `outline` — compact structural summary (~90% token savings)
- `signatures` — exported API surface only
- `range` — specific line range with line numbers (`startLine`, `endLine`)
- `symbol` — extract function/class/method by name; accepts a string or an array for batch extraction
- `full` — file content capped at 12k chars, with truncation marker when needed

The `symbol` mode supports nested methods (class methods, object methods), interface signatures, and multiline function signatures across all supported languages.

Cross-file symbol context:

- Pass `context: true` with `symbol` mode to include callers, tests, and referenced types from the dependency graph
- Callers: files that import the current file and reference the symbol (via graph + ripgrep)
- Tests: test files related to the current file that mention the symbol
- Types: type/interface names referenced in the symbol definition that exist in the index
- Requires `build_index` for graph data; without it, the definition is returned with an empty context and a hint
- Response includes `context: { callers, tests, types }` with counts, `graphCoverage: { imports, tests }` (`full|partial|none`), and `contextHints` if applicable
- `graphCoverage` indicates how reliable cross-file context is: `full` for JS/TS/Python/Go (imports resolved), `partial` for C#/Kotlin/PHP/Swift (imports extracted but namespace-based), `none` for other languages

Token budget mode:

- Pass `maxTokens` to let the tool auto-select the most detailed mode that fits the budget
- Cascade order: `full` -> `outline` -> `signatures` -> truncated
- If the requested mode (or default `outline`) exceeds the budget, the tool falls back to a more compact mode automatically
- `range` and `symbol` modes do not cascade but will truncate by tokens if needed
- When the mode changes, the response includes `chosenMode` (the mode actually used) and `budgetApplied: true`

Responses are cached in memory per session. If the same file+mode is requested again and the file's `mtime` has not changed, the cached result is returned without re-parsing. The response includes `cached: true` when served from cache.

Every response includes a unified `confidence` block:

```json
{ "parser": "ast", "truncated": false, "cached": false }
```

- `parser` — `"ast"` (JS/TS via TypeScript compiler), `"heuristic"` (line-based patterns), `"fallback"` (structural text extraction), or `"raw"` (full and range modes only).
- `truncated` — `true` when output was capped, so the agent knows to request a more targeted mode
- `cached` — `true` when served from in-memory cache without re-parsing
- `graphCoverage` — (symbol mode with `context: true` only) `{ imports, tests }` each `"full"|"partial"|"none"`

Additional flat metadata fields (backward-compatible):

- `indexHint` — (symbol mode only) `true` when the symbol index guided the extraction
- `chosenMode` — (token budget only) the mode that was actually used after cascade
- `budgetApplied` — (token budget only) `true` when the mode was downgraded to fit the budget

Current support:

- First-class (AST): JS, JSX, TS, TSX
- Heuristic: Python, Go, Rust, Java, C#, Kotlin, PHP, Swift, shell, Terraform, HCL, Dockerfile, SQL, JSON, TOML, YAML
- Fallback: plain-text structural extraction for unsupported formats

### `smart_read_batch`

Read multiple files in one MCP call. Reduces round-trip latency for common patterns like "read the outline of these 5 files".

Parameters:

- `files` (required, max 20) — array of items, each with:
  - `path` (required) — file path
  - `mode` (optional) — `outline`, `signatures`, `full`, `range`, `symbol`
  - `symbol`, `startLine`, `endLine` (optional) — as in `smart_read`
  - `maxTokens` (optional) — per-file token budget with automatic mode cascade
- `maxTokens` (optional) — global token budget; stops reading more files once exceeded (at least 1 file is always read)

Response:

```json
{
  "results": [
    { "filePath": "...", "mode": "outline", "parser": "ast", "truncated": false, "content": "..." },
    { "filePath": "...", "mode": "signatures", "parser": "heuristic", "truncated": false, "content": "..." }
  ],
  "metrics": { "totalTokens": 450, "filesRead": 2, "filesSkipped": 0, "totalSavingsPct": 88 }
}
```

### `smart_search`

- Uses embedded ripgrep via `@vscode/ripgrep`
- Falls back to filesystem walking if rg is unavailable or fails
- Groups matches by file, ranks results to reduce noise
- Optional `intent` parameter adjusts ranking: `implementation`, `debug`, `tests`, `config`, `docs`, `explore`
- When a symbol index exists (via `build_index`), files with matching definitions get +50 ranking bonus, and related files (importers, tests, neighbors) get +25 graph boost
- Index is loaded from `projectRoot`, so subdirectory searches still benefit from the project-level index
- Returns a unified `confidence` block: `{ "level": "high", "indexFreshness": "fresh" }`
- `retrievalConfidence`: `"high"` (rg), `"medium"` (walk, no skips), `"low"` (walk with skipped files)
- `indexFreshness`: `"fresh"`, `"stale"` (files modified since last build), or `"unavailable"`
- Returns `sourceBreakdown`: how many top-10 results came from text match, index boost, or graph boost
- When fallback is used, includes `provenance` with `fallbackReason`, `caseMode`, `partial`, skip counts, and `warnings`

Example response:

```json
{
  "engine": "rg",
  "retrievalConfidence": "high",
  "indexFreshness": "fresh",
  "confidence": { "level": "high", "indexFreshness": "fresh" },
  "sourceBreakdown": { "textMatch": 7, "indexBoost": 2, "graphBoost": 1 },
  "intent": "tests",
  "indexBoosted": 2
}
```

### `smart_context`

One-call context planner. Instead of the manual cycle of `smart_search` → `smart_read` → `smart_read` → ..., `smart_context` receives a task description and returns curated context in a single response.

Parameters:

- `task` (required) — natural language task description (e.g., `"debug the auth flow in AuthMiddleware"`)
- `intent` (optional) — override auto-detected intent (`implementation`, `debug`, `tests`, `config`, `docs`, `explore`)
- `maxTokens` (optional, default 8000) — token budget for the response; fewer files are included with tighter budgets
- `entryFile` (optional) — hint file to guarantee inclusion as primary context
- `diff` (optional) — scope context to changed files only. Pass `true` for uncommitted changes vs HEAD, or a git ref string (`"main"`, `"HEAD~1"`, `"origin/main"`) to diff against that ref. Requires a git repository.
- `detail` (optional, default `balanced`) — control response detail level:
  - `minimal`: index-first mode, returns file paths, roles, `reasonIncluded`, `evidence`, symbols, signatures, and `symbolPreviews` from the index without reading file content (fastest, lowest tokens)
  - `balanced`: default mode, reads file content with smart compression (outline/signatures modes)
  - `deep`: full content mode (highest tokens, most detail)
- `include` (optional, default `["content","graph","hints","symbolDetail"]`) — array of fields to include in the response. Omit fields to reduce payload size:
  - `content`: file content blocks (if omitted, only metadata and signatures are returned)
  - `graph`: relational graph summary (imports, tests, dependents, neighbors)
  - `hints`: actionable suggestions for follow-up reads or index rebuilds
  - `symbolDetail`: focused symbol extraction for identifiers detected in the task

Pipeline:

1. **Search mode** (default): Extracts search queries and symbol candidates from the task, runs `smart_search` with the best query and intent
2. **Diff mode** (when `diff` is provided): Runs `git diff --name-only <ref>` to get changed files, skips search entirely
3. Expands top results via the relational graph (`queryRelated`): imports, importedBy, tests, neighbors
4. **Index-first mode** (when `detail=minimal` or `include` omits `content`): Returns file metadata, evidence, symbols, signatures, and short symbol previews from the index without opening files
5. **Batch read mode** (when `detail=balanced|deep` and `include` has `content`): Uses `smart_read_batch` internally to read multiple files in one batched call, reducing round-trips
6. Allocates read modes per file role: `outline` for primary files in `balanced`, `signatures` for tests/dependencies, and `full` reads in `deep`
7. Extracts symbol details when identifiers (camelCase/PascalCase/snake_case) are detected in the task (if `include` has `symbolDetail`)
8. **Deduplication** (when `detail=minimal`): If `symbolDetail` is included, omits redundant outline content from the same file to save tokens
9. Assembles everything into a single response with graph summary, actionable hints, and per-file inclusion evidence

Diff mode is ideal for PR review and debugging recent changes — instead of searching the full codebase, it reads only the changed files plus their tests and dependencies.

Example response:

```json
{
  "task": "debug AuthMiddleware",
  "intent": "debug",
  "indexFreshness": "fresh",
  "confidence": { "indexFreshness": "fresh", "graphCoverage": { "imports": "full", "tests": "full" } },
  "context": [
    { "file": "src/auth/middleware.js", "role": "primary", "readMode": "outline", "reasonIncluded": "Matched task search: AuthMiddleware", "evidence": [{ "type": "searchHit", "query": "AuthMiddleware", "rank": 1 }, { "type": "symbolMatch", "symbols": ["AuthMiddleware"] }], "symbols": ["AuthMiddleware", "requireRole"], "symbolPreviews": [{ "name": "AuthMiddleware", "kind": "class", "signature": "export class AuthMiddleware", "snippet": "export class AuthMiddleware { ..." }], "content": "..." },
    { "file": "tests/auth.test.js", "role": "test", "readMode": "signatures", "reasonIncluded": "Test for src/auth/middleware.js", "evidence": [{ "type": "testOf", "via": "src/auth/middleware.js" }], "content": "..." },
    { "file": "src/utils/jwt.js", "role": "dependency", "readMode": "signatures", "reasonIncluded": "Imported by src/auth/middleware.js", "evidence": [{ "type": "dependencyOf", "via": "src/auth/middleware.js" }], "content": "..." },
    { "file": "src/auth/middleware.js", "role": "symbolDetail", "readMode": "symbol", "reasonIncluded": "Focused symbol detail: AuthMiddleware", "evidence": [{ "type": "symbolDetail", "symbols": ["AuthMiddleware"] }], "content": "..." }
  ],
  "graph": {
    "primaryImports": ["src/utils/jwt.js"],
    "tests": ["tests/auth.test.js"],
    "dependents": [],
    "neighbors": ["src/utils/logger.js"]
  },
  "graphCoverage": { "imports": "full", "tests": "full" },
  "metrics": { "totalTokens": 1200, "filesIncluded": 4, "filesEvaluated": 8, "savingsPct": 82 },
  "hints": ["Inspect symbols with smart_read: verifyJwt, createJwt"]
}
```

`graphCoverage` indicates how complete the relational context is: `full` for JS/TS/Python/Go (imports resolved to local files), `partial` for C#/Kotlin/PHP/Swift (imports extracted but namespace-based), `none` for other languages. When files from multiple languages are included, the level reflects the weakest coverage.

File roles: `primary` (search hits or changed files), `test` (related test files), `dependency` (imports), `dependent` (importedBy), `symbolDetail` (extracted symbol bodies). Each item also includes `reasonIncluded` and structured `evidence` so the agent knows why it was selected.

When using diff mode, the response includes a `diffSummary`:

```json
{
  "diffSummary": { "ref": "main", "totalChanged": 5, "included": 3, "skippedDeleted": 1 }
}
```

### `build_index`

- Builds a lightweight symbol index for the project (functions, classes, methods, types, etc.)
- Supports JS/TS (via TypeScript AST), Python, Go, Rust, Java, C#, Kotlin, PHP, Swift
- Extracts imports/exports and builds a dependency graph with `import` and `testOf` edges
- Test files are linked to source files via import analysis and naming conventions
- Index stored per-project in `.devctx/index.json`, invalidated by file mtime
- Each symbol includes a condensed `signature` (one line, max 200 chars) and a short `snippet` preview so agents can inspect likely definitions without opening files
- Accelerates `smart_search` (symbol + graph ranking) and `smart_read` symbol mode (line hints)
- Pass `incremental=true` to only reindex files with changed mtime — much faster for large repos (10k+ files). Falls back to full rebuild if no prior index exists.
- Incremental response includes `reindexed`, `removed`, `unchanged` counts
- Run once after checkout or when many files changed; not required but recommended for large projects

### `smart_shell`

- Runs only allowlisted diagnostic commands
- Executes from the effective project root
- Blocks shell operators and unsafe commands by design

## Evaluations (repo development only)

The eval harness and corpora are available in the [source repository](https://github.com/Arrayo/devctx-mcp-mvp) but are **not included in the npm package**. Clone the repo to run evaluations.

```bash
# from the repo root:
cd tools/devctx
npm run eval                # synthetic corpus with index + intent
npm run eval -- --baseline  # baseline without index/intent
npm run eval:self           # self-eval against the real devctx repo
npm run eval:context        # evaluate smart_context alongside search
npm run eval:both           # search + context evaluation
npm run eval:report         # scorecard with delta vs baseline
```

The harness supports `--root=` and `--corpus=` for evaluating against any repo with custom task corpora. Use `--tool=search|context|both` to control which tools are evaluated. When `--tool=context`, pass/fail is determined by `smart_context` precision; when `--tool=both`, both search and context must pass.

Metrics include: P@5, P@10, Recall, wrong-file rate, retrieval honesty, follow-up reads, tokens-to-success, latency p50/p95, confidence calibration (accuracy, over-confident rate, under-confident rate), and smart_context metrics when applicable. smart_context reporting now includes precision, explanation coverage (`reasonIncluded` + `evidence`), preview coverage (`symbolPreviews`), and preview symbol recall. Token metrics (`totalTokens`) reflect the full JSON payload, not just content blocks.

## Notes

- `@vscode/ripgrep` provides a bundled `rg` binary, so a system install is not required.
- Metrics are written under `.devctx/metrics.jsonl` in the package root.
- Symbol index stored in `.devctx/index.json` when `build_index` is used.
- This package is a navigation and diagnostics layer, not a full semantic code intelligence system.

## Repository

Source repository and full project documentation:

- https://github.com/Arrayo/devctx-mcp-mvp
