# smart-context-mcp

MCP server that reduces agent token usage and improves response quality with compact file summaries, ranked code search, and curated context.

It provides seven focused tools:

- `smart_read`: compact file summaries instead of full file dumps
- `smart_read_batch`: read multiple files in one call — reduces round-trip latency
- `smart_search`: ripgrep-first code search with intent-aware, grouped, ranked results
- `smart_context`: one-call context planner — search + read + graph expansion in a single response
- `smart_summary`: maintain compressed conversation state across sessions without token bloat
- `smart_shell`: safe diagnostic shell execution with restricted commands
- `build_index`: lightweight symbol index for faster lookups and smarter ranking

The project is already useful across real repos. It is strongest in modern web/backend codebases and infra-heavy repositories. It is not fully universal yet.

## Quick reference

| Task | Tool | Key parameters |
|------|------|----------------|
| Read one file efficiently | `smart_read` | `mode`: `outline` \| `signatures` \| `symbol` \| `full` |
| Read multiple files at once | `smart_read_batch` | array of `{ path, mode, symbol }` |
| Search code by keyword/pattern | `smart_search` | `query`, `intent`: `debug` \| `implementation` \| `tests` \| `config` |
| Get full context for a task | `smart_context` | `task` (natural language), `detail`: `minimal` \| `balanced` \| `deep` |
| Maintain conversation context | `smart_summary` | `action`: `get` \| `update` \| `append` \| `reset` \| `list_sessions` |
| Run diagnostic commands | `smart_shell` | `command` (allowlisted only) |
| Build symbol index (once) | `build_index` | `incremental`: `true` for faster updates |

**When to use what:**
- **Starting a task?** → `smart_summary` to get context, then `smart_context` with your goal
- **Need specific file content?** → `smart_read` in `outline` or `signatures` mode
- **Searching for a pattern?** → `smart_search` with appropriate `intent`
- **Reading many files?** → `smart_read_batch` to reduce round-trips
- **After each milestone?** → `smart_summary` with `action: "append"` to track progress
- **Resuming after break?** → `smart_summary` with `action: "get"` to restore context
- **First time in repo?** → `build_index` once for better ranking

## Best fit

| Level | Languages / Stack | Use cases |
|-------|------------------|-----------|
| **Strong** | JS/TS, React, Next.js, Node.js, Python | Modern web apps, monorepos, backend services, scripts |
| **Strong** | Terraform, Docker, YAML, shell, SQL | Infra/platform repos, config-heavy codebases |
| **Good** | Go, Rust, Java, C#/.NET, Kotlin, PHP, Swift | Services, libraries, Android/iOS, Laravel/Symfony |
| **Partial** | Enterprise Java/C# with heavy frameworks | Generated code, polyglot monorepos needing semantic ranking |
| **Limited** | Ruby, Elixir, Scala | Deep semantic understanding required, general shell needs |

## Install in your project

```bash
npm install smart-context-mcp
npx smart-context-init --target .
```

This installs the MCP server and generates client configs for all supported clients. `npm install` downloads a platform-specific `rg` binary via `@vscode/ripgrep`. No system ripgrep is required.

To install only for a specific client:

```bash
npx smart-context-init --target . --clients cursor
npx smart-context-init --target . --clients codex
npx smart-context-init --target . --clients codex,claude
```

## Usage per client

After installing, each client picks up the server automatically:

### Cursor

Open the project in Cursor. The MCP server starts automatically. Enable it in **Cursor Settings > MCP** if needed. All tools (`smart_read`, `smart_read_batch`, `smart_search`, `smart_context`, `smart_summary`, `smart_shell`, `build_index`) are available in Agent mode.

Config: `.cursor/mcp.json`

### Codex CLI

```bash
cd /path/to/your-project
codex
```

Codex reads `.codex/config.toml` and starts the MCP server on launch.

Config: `.codex/config.toml`

### Claude Code

```bash
cd /path/to/your-project
claude
```

Claude Code reads `.mcp.json` from the project root.

Config: `.mcp.json`

### Qwen Code

Open the project in Qwen Code. The MCP server starts from `.qwen/settings.json`.

Config: `.qwen/settings.json`

## Agent rules

`smart-context-init` generates agent rules that instruct AI agents to prefer devctx tools over their built-in equivalents. This is what makes agents use `smart_read` in outline/signatures mode instead of reading full files.

### Intent-based workflows

The `intent` parameter in `smart_search` and `smart_context` adjusts ranking and suggests optimal workflows:

| Intent | Ranking priority | Suggested workflow |
|--------|-----------------|-------------------|
| `debug` | Error messages, stack traces, logs | Search error → read signatures → inspect symbol → smart_shell |
| `implementation` | Source files, changed files | Read outline/signatures → focus on changed symbols |
| `tests` | Test files, spec files | Find tests → read symbol of function under test |
| `config` | Config files, env vars, YAML/JSON | Find settings → read full config files |
| `explore` | Entry points, main modules | Directory structure → outlines of key modules |

### Generated files per client

- **Cursor**: `.cursor/rules/devctx.mdc` (always-apply rule)
- **Codex**: `AGENTS.md` (devctx section with sentinel markers)
- **Claude Code**: `CLAUDE.md` (devctx section with sentinel markers)

The rules are idempotent — running `smart-context-init` again updates the section without duplicating it. Existing content in `AGENTS.md` and `CLAUDE.md` is preserved.

## Quick start (from source)

```bash
cd tools/devctx
npm install
npm start
```

For normal IDE use, the MCP client should start the server automatically from its project config.

The package exposes three binaries: `smart-context-server`, `smart-context-init`, and `smart-context-report`.

## Use against another repo

By default, `devctx` works against the repo where it is installed. You can point it at another repo without modifying that target project:

```bash
node ./src/mcp-server.js --project-root /path/to/target-repo
```

or:

```bash
DEVCTX_PROJECT_ROOT=/path/to/target-repo node ./src/mcp-server.js
```

This is the basis for non-invasive validation before writing client config into another repository.

## Generate client configs

To generate or update MCP config files for a target project:

```bash
cd tools/devctx
npm run init:clients -- --target ../..
```

Limit clients or override the command if needed:

```bash
node ./scripts/init-clients.js --target /path/to/project --clients cursor,codex,qwen,claude
node ./scripts/init-clients.js --target /path/to/project --command node --args '["./tools/devctx/src/mcp-server.js"]'
```

If installed as a binary, the same initializer is available as:

```bash
smart-context-init --target /path/to/project
```

The MCP server binary is:

```bash
smart-context-server --project-root /path/to/target-repo
```

## Validation

Human-readable smoke test:

```bash
cd tools/devctx
npm run smoke
```

JSON smoke test for CI:

```bash
cd tools/devctx
npm run smoke:json
```

Multi-language fixture validation:

```bash
cd tools/devctx
npm run smoke:formats
```

`smoke:formats` validates local fixtures for:

- Go
- Rust
- Java
- Shell
- Terraform / HCL
- Dockerfile
- SQL

You can also validate `devctx` against an external repo without modifying it:

```bash
node ./scripts/smoke-test.js --json \
  --project-root /path/to/project \
  --read-file package.json \
  --read-mode outline \
  --read-expect name \
  --search-query jsonwebtoken \
  --search-cwd . \
  --search-expect jsonwebtoken
```

The JSON variant returns a stable object with `ok`, timestamps, and per-check results, and exits non-zero on failure.

## Tool behavior

### `smart_read`

Modes:

- `outline`: imports, exports, declarations, structure (~90% token savings)
- `signatures`: function/class signatures (~90% token savings)
- `range`: read specific lines by number — pass `startLine` and `endLine`
- `symbol`: extract a function/class/method by name — pass `symbol` parameter (string or array of strings for batch extraction). Uses language-aware parsing (AST for JS/TS including class methods, indent-tracking for Python, brace-counting for Go/Rust/Java/C#/Kotlin/PHP/Swift). Handles multiline signatures. Pass `context: true` to include callers, tests, and referenced types from the dependency graph in a single call. Response includes `graphCoverage: { imports, tests }` (`full|partial|none`) so the agent knows how reliable the cross-file context is.
- `full`: file content capped at 12k chars, with truncation marker when needed
- `maxTokens`: token budget — the tool auto-selects the most detailed mode that fits (`full` -> `outline` -> `signatures` -> truncated). Response includes `chosenMode` and `budgetApplied` when the mode was downgraded.

Responses are cached in memory per session and invalidated by file `mtime`. `cached: true` appears when the response is served from cache without re-parsing.

Every response includes a `confidence` block:

```json
{ "parser": "ast|heuristic|fallback|raw", "truncated": false, "cached": false }
```

Additional metadata: `indexHint` (symbol mode), `chosenMode`/`budgetApplied` (token budget), `graphCoverage` (symbol+context mode).

**Example response (outline mode):**

```json
{
  "mode": "outline",
  "parser": "ast",
  "truncated": false,
  "cached": false,
  "tokens": 245,
  "confidence": { "parser": "ast", "truncated": false, "cached": false },
  "content": "import express from 'express';\nexport class AuthMiddleware { ... }\nexport function requireRole(role: string) { ... }"
}
```

Current language / format support:

- First-class (AST): JS, JSX, TS, TSX
- Heuristic: Python, Go, Rust, Java, C#, Kotlin, PHP, Swift, shell, Terraform, HCL, Dockerfile, SQL, JSON, TOML, YAML
- Symbol extraction: JS, TS, Python, Go, Rust, Java, C#, Kotlin, PHP, Swift (+ generic fallback)
- Fallback: plain-text structural extraction for unsupported formats

### `smart_read_batch`

- Read multiple files in one MCP call (max 20 per call)
- Each item accepts `path`, `mode`, `symbol`, `startLine`, `endLine`, `maxTokens` (per-file budget)
- Optional global `maxTokens` budget with early stop when exceeded
- Returns aggregated `metrics`: `totalTokens`, `filesRead`, `filesSkipped`, `totalSavingsPct`

**Example response:**

```json
{
  "results": [
    { "filePath": "src/auth.js", "mode": "outline", "parser": "ast", "truncated": false, "tokens": 180, "content": "..." },
    { "filePath": "tests/auth.test.js", "mode": "signatures", "parser": "heuristic", "truncated": false, "tokens": 95, "content": "..." }
  ],
  "metrics": { "totalTokens": 275, "filesRead": 2, "filesSkipped": 0, "totalSavingsPct": 87 }
}
```

### `smart_search`

- Uses `rg` first, falls back to filesystem walking if rg is unavailable or fails
- Groups matches by file, ranks results to reduce noise
- Optional `intent` parameter: `implementation`, `debug`, `tests`, `config`, `docs`, `explore`
- When a symbol index exists (via `build_index`), files containing matching definitions get a ranking bonus (+50), and related files (importers, tests, neighbors) get a graph boost (+25)
- Returns `confidence` block: `{ "level": "high", "indexFreshness": "fresh" }`
- Index is loaded from `projectRoot`, not from `cwd`, so subdirectory searches still benefit from the project-level index

**Example response:**

```json
{
  "engine": "rg",
  "retrievalConfidence": "high",
  "indexFreshness": "fresh",
  "confidence": { "level": "high", "indexFreshness": "fresh" },
  "sourceBreakdown": { "textMatch": 7, "indexBoost": 2, "graphBoost": 1 },
  "results": [
    { "file": "src/auth/middleware.js", "matches": 3, "rank": 150, "preview": "export class AuthMiddleware { ..." }
  ]
}
```

### `smart_context`

One-call context planner that replaces the manual `smart_search` → `smart_read` → `smart_read` cycle.

**Pipeline:**

```
task input → intent detection → search/diff → graph expansion → smart_read_batch → symbol extraction → response
```

**Parameters:**
- `task` (required) — natural language description (e.g., `"debug the auth flow in AuthMiddleware"`)
- `intent` (optional) — override auto-detected intent
- `detail` (optional) — `minimal` | `balanced` (default) | `deep`
- `maxTokens` (optional, default 8000) — token budget
- `entryFile` (optional) — guarantee specific file inclusion
- `diff` (optional) — `true` (vs HEAD) or git ref (`"main"`) to scope to changed files only
- `include` (optional) — `["content","graph","hints","symbolDetail"]` to control response fields

**Detail modes:**

| Mode | Behavior | Use when |
|------|----------|----------|
| `minimal` | Index-first: paths, roles, evidence, signatures, symbol previews (no file reads) | Fastest exploration, budget-constrained |
| `balanced` | Batch read with smart compression (outline/signatures) | Default, most tasks |
| `deep` | Full content reads | Deep investigation, debugging |

**How it works:**

1. **Search or diff**: Extracts queries from task and runs `smart_search`, OR runs `git diff` when `diff` parameter provided
2. **Graph expansion**: Expands top results via relational graph (imports, importedBy, tests, neighbors)
3. **Read strategy**: Index-first mode (no file reads) OR batch read mode using `smart_read_batch` with role-based compression
4. **Symbol extraction**: Detects identifiers in task and extracts focused symbol details
5. **Deduplication**: In `minimal` mode, omits redundant outline when `symbolDetail` covers same file
6. **Assembly**: Returns curated context with `reasonIncluded` / `evidence` per item, graph summary, hints, and confidence block

Diff mode is ideal for PR review and debugging recent changes — reads only changed files plus their tests and dependencies.

### `smart_summary`

Maintain compressed conversation state across sessions. Solves the context-loss problem when resuming work after hours or days.

**Actions:**

| Action | Purpose | Returns |
|--------|---------|---------|
| `get` | Retrieve current or specified session | Resume summary (≤500 tokens) + compression metadata |
| `update` | Create or replace session | New session with compressed state |
| `append` | Add to existing session | Merged session state |
| `reset` | Clear session | Confirmation |
| `list_sessions` | Show all available sessions | Array of sessions with metadata |

**Parameters:**
- `action` (required) — one of the actions above
- `sessionId` (optional) — session identifier; auto-generated from `goal` if omitted
- `update` (required for update/append) — object with:
  - `goal`: primary objective
  - `status`: current state (`planning` | `in_progress` | `blocked` | `completed`)
  - `pinnedContext`: critical context that should survive compression when possible
  - `unresolvedQuestions`: open questions that matter for the next turn
  - `currentFocus`: current work area in one short phrase
  - `whyBlocked`: blocker summary when status is `blocked`
  - `completed`: array of completed steps
  - `decisions`: array of key decisions with rationale
  - `blockers`: array of current blockers
  - `nextStep`: immediate next action
  - `touchedFiles`: array of modified files
- `maxTokens` (optional, default 500) — hard cap on summary size

`update` replaces the stored session state for that `sessionId`, so omitted fields are cleared. Use `append` when you want to keep existing state and add progress incrementally.

**Storage:**
- Sessions persist in `.devctx/sessions/<sessionId>.json`
- Active session tracked in `.devctx/sessions/active.json`
- 30-day retention for inactive sessions
- No expiration for active sessions

**Resume summary fields:**
- `status` and `nextStep` are preserved with highest priority
- `pinnedContext` and `unresolvedQuestions` preserve critical context and open questions
- `currentFocus` and `whyBlocked` are included when relevant
- `recentCompleted`, `keyDecisions`, and `hotFiles` are derived from the persisted state
- `completedCount`, `decisionsCount`, and `touchedFilesCount` preserve activity scale cheaply
- Empty fields are omitted to save tokens

**Response metadata:**
- `schemaVersion`: persisted session schema version
- `truncated`: whether the resume summary had to be compressed
- `compressionLevel`: `none` | `trimmed` | `reduced` | `status_only`
- `omitted`: fields dropped from the resume summary to fit the token budget

**Compression strategy:**
- Keeps the persisted session state intact and compresses only the resume summary
- Prioritizes `nextStep`, `status`, and active blockers over history
- Deduplicates repeated completed steps, decisions, and touched files
- Uses token-aware reduction until the summary fits `maxTokens`

**Example workflow:**

```javascript
// Start of work session
smart_summary({ action: "get" })
// → retrieves last active session or returns "not found"

// After implementing auth middleware
smart_summary({ 
  action: "append",
  update: {
    completed: ["auth middleware"],
    decisions: ["JWT with 1h expiry, refresh tokens in Redis"],
    touchedFiles: ["src/middleware/auth.js"],
    nextStep: "add role-based access control"
  }
})

// Monday after weekend - resume work
smart_summary({ action: "get" })
// → full context restored, continue from nextStep

// List all sessions
smart_summary({ action: "list_sessions" })
// → see all available sessions, pick one to resume
```

### `build_index`

- Builds a lightweight symbol index (functions, classes, methods, types, etc.)
- Supports JS/TS (via TypeScript AST), Python, Go, Rust, Java, C#, Kotlin, PHP, Swift
- Extracts imports/exports and builds a dependency graph with `import` and `testOf` edges
- Test files are linked to their source files via import analysis and naming conventions
- Each symbol includes a condensed `signature` (one line, max 200 chars) and a short `snippet` preview — agents can inspect likely definitions from the index without opening files
- Index stored per-project in `.devctx/index.json`, invalidated by file mtime
- `incremental=true`: only reindex files with changed mtime — much faster for large repos. Falls back to full rebuild if no prior index exists.
- Run once after checkout or when many files changed; not required but recommended

### `smart_shell`

- Runs only allowlisted diagnostic commands
- Resolves execution from the effective project root
- Intentionally blocks shell operators and unsafe commands
- Useful for `pwd`, `git status`, `rg`, `ls`, `find`, and other low-risk diagnostics

## Evaluations (repo development only)

The eval harness and corpora live in `tools/devctx/evals/` and are **not included in the npm package**. Clone this repo to run evaluations.

```bash
cd tools/devctx
npm run eval
npm run eval -- --baseline
npm run eval:self
npm run eval:context
npm run eval:both
npm run eval:report
```

Commands:
- `eval` — synthetic corpus with index + intent
- `eval -- --baseline` — baseline without index/intent
- `eval:self` — self-eval against the real devctx repo
- `eval:context` — evaluate smart_context alongside search
- `eval:both` — search + context evaluation
- `eval:report` — scorecard with delta vs baseline

The harness supports `--root=`, `--corpus=`, and `--tool=search|context|both` for evaluating against any repo. When `--tool=context`, pass/fail is governed by `smart_context` precision; `--tool=both` requires both search and context to pass. Token metrics (`totalTokens`) reflect the full JSON response payload. Reports include confidence calibration (accuracy, over/under-confident rates) and, for `smart_context`, explanation coverage (`reasonIncluded` + `evidence`), preview coverage (`symbolPreviews`), preview symbol recall, and context precision.

## Notes

- Paths are resolved relative to the effective project root, not the caller cwd.
- Metrics are written to `<projectRoot>/.devctx/metrics.jsonl` (override with `DEVCTX_METRICS_FILE` env var).
- Symbol index stored in `<projectRoot>/.devctx/index.json` when `build_index` is used.
- Conversation sessions stored in `<projectRoot>/.devctx/sessions/` when `smart_summary` is used.
- `smart_shell` is intentionally conservative by design.
- Today this is a strong navigation and diagnostics layer, not a full semantic code intelligence system.
