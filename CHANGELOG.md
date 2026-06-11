# Changelog

All notable changes to this project will be documented in this file.

## [1.20.0] - 2026-06-11

Minor release. Same 20 tools — no additions, no removals — but several gain new parameters and richer response fields focused on **hard token-budget control**, **search-mode discipline**, and **second-read cache reuse**. `SQLITE_SCHEMA_VERSION` bumps 7 → 8 (new `read_cache` table). `~/.devctx/global.db` schema bumps 1 → 2 (new `noise_hints` table). Both migrate automatically on first run. **Zero new runtime dependencies.**

### Added — shared `tokenBudget` across tools
- New `tokenBudget` parameter on `smart_read`, `smart_read_batch`, `smart_context`, `smart_turn` (both `start` and `end`) and `smart_resume`. Accepts either a plain `number` or `{ id?, maxTokens, shared? }`.
- When `shared: true` (or `id` is set), the budget state is shared across calls in the same task — a multi-step agent flow can stay under a hard token ceiling **without per-call bookkeeping**.
- Responses surface `taskBudget`, `remainingBudget`, and (when the budget actually changed the output) `budgetDetails` with `scope` (`content` | `batch` | `response`), `actions` taken, and the final degraded mode.
- New module `src/utils/task-budget.js` (`normalizeTokenBudget`, `resolveTokenBudgetWindow`, `peekRemainingBudget`, `consumeTokenBudget`, `clearTaskBudgets`).
- Test suite: `tests/task-budget.test.js`.

### Added — `smart_search` search modes
- New `mode: 'needle' | 'balanced' | 'semantic'` parameter. Default: `'balanced'`.
  - `needle` — literal exact only. No regex. No term expansion. Kills noise on debug / error-string queries.
  - `balanced` — exact + regex + term expansion (previous behaviour).
  - `semantic` — exact-first plus the local semantic block when the exact signal is weak.
- The legacy `semantic: true` flag is preserved as an alias for `mode: 'semantic'`.
- New `maxTokens` parameter caps the whole response payload. Compaction order: `matches` truncated first, then diagnostics, then the optional semantic block is reduced or omitted.
- Per-file ranking is now inspectable: `matchedBy`, `boostSource`, `scoreBreakdown`, `whyRanked`. Top-level response includes `hasMore`, `totalFiles`, `nextSuggestedMaxFiles` for incremental expansion.
- Actionable `suggestions` returned when the query is too broad or returns nothing useful (mode change, kind filter, narrower terms).
- Default `maxFiles` tightened **15 → 5** to match real agent usage and let `nextSuggestedMaxFiles` drive expansion explicitly.

### Added — `smart_read` persistent cache + budget-aware `full` degradation
- New SQLite table `read_cache` (`SQLITE_SCHEMA_VERSION 8`, auto-migrating) keyed by `(filePath, mode, selector, content_hash)`. Second read of an unchanged file is virtually free.
- New `getReadCache`, `setReadCache`, `clearReadCachePersistent` in `src/storage/sqlite.js`, plus GC integration in `runStorageMaintenance` (same retention window as the other caches).
- Mode `full` is now an **explicit last resort**: when `tokenBudget`/`maxTokens` is set, `smart_read` degrades to lighter modes first (outline → signatures → truncated) and reports the real mode used in `fullMode` plus `budgetDetails`. No silent truncation.
- `smart_read_batch` enforces the same logic at batch level: early-stop reports `budgetDetails` with `scope: 'batch'` and the list of files actually read.
- Test suite: `tests/smart-read-persistent-cache.test.js`.

### Added — `smart_turn` simple-task skip heuristic
- When the prompt is short (≤ 40 chars after whitespace normalization), classified as a simple task (`isSimpleTask` policy), and no session/task is pinned, `smart_turn(start)` now returns `skipSmartTurn: true` with `recommendedPath.mode='simple_task_skip'` instead of paying the full continuity / refresh-context orchestration cost.
- `minimal` verbosity additionally compacts the start payload via `compactSummaryForMinimal` and conditionally drops `summary` / `refreshedContext` when the agent does not need them (no blocked state, no ambiguity, no possible task shift). `refreshedContext` is always preserved when it carries `topFiles`, to keep the focus-list contract that downstream tools rely on.
- `smart_resume` inherits the same behaviour via `tokenBudget` plumbing.

### Added — `global_memory` noise hints
- Global DB schema bumps 1 → 2: new `noise_hints` table keyed by `(project_hash, hint_key)` tracking `reason` (`'search_noise'` by default), `hits`, `created_at`, `updated_at`. Project paths remain hashed (FNV-1a) before storage.
- New tool actions: `noise_stats` (inspect repo-local noise hints) and `noise_reset` (clear all hints for the current project, or only the entry matching `query`).
- New store APIs `recordNoiseHint` / `getNoiseHints` exposed so `smart_search` can learn from past noisy queries per project without ever persisting raw content.

### Added — KPI baseline infrastructure
- New scripts `evals/kpi-baseline.js` and `evals/kpi-utils.js`. They run the existing `harness.js` and `realworld-eval.js` once and produce a single JSON snapshot containing:
  - Top-5 precision.
  - Recall.
  - Reread task rate.
  - Reread call rate.
  - Per-task-size buckets (`short` / `long`) with `count`, `avgTokens`, `avgLatencyMs`.
- Persists `kpi-baseline-latest.json` + a timestamped copy in `evals/results/`, ready for regression checks in CI.
- Test suite: `tests/eval-kpis.test.js`.

### Changed
- `smart_read` description (server schema) rewritten to reflect budget-aware `full` degradation and the new `budgetDetails` contract.
- `smart_read_batch` description updated to document `scope: 'batch'` early-stop reporting.
- `smart_search` description updated to document `mode`, `maxTokens`, the new per-file ranking fields, `hasMore` / `nextSuggestedMaxFiles`, and `suggestions`.
- `global_memory` description and action `enum` extended with `noise_stats` / `noise_reset`.
- Default `maxFiles` in `smart_search` lowered to 5 (was 15). Old callers that need more should pass `maxFiles` explicitly or follow `nextSuggestedMaxFiles`.

### Storage
- `SQLITE_SCHEMA_VERSION`: 7 → 8 (new `read_cache` table + indexes). `EXPECTED_TABLES` updated.
- `~/.devctx/global.db` schema: 1 → 2 (new `noise_hints` table). Migrations are forward-only and idempotent.

### Fixed (rolled-up from `1.19.x` HEAD)
- CI on Node 18 / 20: SQLite-bound suites conditionally skip when `node:sqlite` is unavailable. Coverage on Node 22+ unchanged. (`bd9e16c`)
- Fixture index regenerated to `INDEX_VERSION 7` so cached `smart_read explain` tests resolve correctly. (`bd9e16c`)
- `STOP_WORDS` now includes `"via"` for cleaner token streams. (`bd9e16c`)

### Documentation
- README `What You Get` block corrected: 20 tools listed in full instead of the stale `Tools (12)` + `And 7 more`. `metrics.jsonl` no longer described as an automatic Node 18-20 fallback — it is **opt-in** via `DEVCTX_METRICS_FILE`. Storage section now references `INDEX_VERSION 7` and the opt-in `~/.devctx/global.db`. (`05007e7`)
- Hard benchmark report `docs/verification/v1.18.1-vs-v1.19.0.md` added with reproducible commands. (`7fd2255`)

### Verification
- Full test suite green on Node 22+ (new suites: `task-budget`, `smart-read-persistent-cache`, `eval-kpis`).
- CI matrix Node 18 / 20: green (SQLite-bound suites skipped, all other suites pass).
- Storage migrations (`v7 → v8`, global `v1 → v2`) verified via fresh-install + upgrade smoke runs.

## [1.19.0] - 2026-05-12

Five-step quality jump executed as sequential commits with full dogfooding. MCP grows from 18 → **20 tools** (`smart_playbook` + `global_memory`). +68 new tests, **zero new dependencies**, suite green at 882/883 (1 skipped, 0 fail). Index schema bumped 6 → 7 (auto-reindex on first run).

### Added — `smart_playbook` (new tool)
- **Declarative composite workflows** that run multiple `smart_*` tools in a single MCP call. Reduces agent planning tokens and gives deterministic, repeatable sequences.
- **Five built-in playbooks** ship with the package:
  - `preflight-merge` — `smart_review` + `smart_test(affected)` + `smart_turn(end)` checkpoint.
  - `debug-flake` — `smart_test(last_failure)` + `smart_context(intent=debug)` + `smart_test(affected)`.
  - `refactor-safe` — `smart_context(intent=refactor)` + `smart_test(affected)` + `smart_turn(end)` checkpoint.
  - `doc-sync` — `smart_search(kinds=adr,adr-section)` + `smart_context(intent=docs)`.
  - `ramp-up` — `smart_status` + `smart_doctor` + `smart_search(kinds=adr)`.
- **Project-level overrides** in `.devctx/playbooks/*.{yaml,json}` (custom playbooks discover and override built-ins by name).
- **`{{args.X}}` interpolation** against `defaults` + caller `args`, plus `when` / `label` / `stopOnFail` / `dryRun` per step.
- **Allowlist:** only `smart_*` tools can be invoked inside a playbook. No arbitrary shell exposure.
- **Zero deps:** built-in minimal YAML parser handles the subset playbooks need; JSON also accepted.
- New modules: `src/playbooks/{yaml-mini,loader,runner}.js`, `src/tools/smart-playbook.js`, `src/playbooks/builtin/*.yaml`.

### Added — Reactive FS watcher for the index
- **`fs.watch` (native, recursive, persistent=false)** with **debounce 600ms** and **batch flush every 2s** keeps the symbol index hot between calls. Agents see a fresh graph without paying full-rebuild latency.
- **Ignored paths:** `.git`, `node_modules`, `.devctx`, `dist`, `build`, `coverage`, lockfiles, `.min.*`, `.map`, `.snap`, and any non-indexable extension.
- **Stats surface on `smart_status`:** `enabled`, `flushes`, `eventsObserved`, `filesReindexed`, `filesRemoved`, `errors`, `lastFlushAt`, `pending`.
- **Gating:** opt-out via `DEVCTX_WATCH_INDEX=false`. Defaults to enabled.
- **Lifecycle:** singleton watcher handle wired to MCP shutdown for clean close + final flush.
- New module: `src/index-watcher.js`.

### Added — Pluggable parser registry + richer Python / Go coverage (index v7)
- **`src/parsers/registry.js`** exposes `registerParser` / `getParser`. `index.js` consults the registry first and falls back to built-in extractors. Tree-sitter (WASM) parsers can register at runtime without touching core.
- **Python parser:**
  - Decorators tracked per symbol (`decorators: ["dataclass", "cached", ...]`).
  - `async def` → kind `async-function` / `async-method`.
  - `TypeAlias`, `TypeVar`, `NewType`, `ParamSpec`, `TypeVarTuple` captured as `kind="type"`.
  - Class scope respected by indent — no false-positive nesting after dedent.
- **Go parser:**
  - Methods extracted with receiver type as `parent` (e.g. `func (s *Service) Run() → kind="method"`, `parent="Service"`).
  - Interfaces detected as `kind="interface"` (vs structs as `"type"`).
  - Top-level `const` / `var` captured as `kind="const"` / `"var"`.
- **`INDEX_VERSION` 6 → 7.** Indexes rebuild automatically on first run.

### Added — Local semantic re-rank on `smart_search`
- **Opt-in `semantic: true` (with `semanticLimit`)** returns a `semantic: { embedder, symbols[], files[] }` block ranked by hashing/TF-IDF embeddings. Default behavior unchanged.
- **Engine:** tokenizer splits camelCase + snake_case + strips stop-words / short tokens, feature hashing (FNV-1a, signed buckets, 256 dims), TF-IDF over the index corpus, L2-normalized vectors, cosine similarity. **<5ms** even on indexes with thousands of symbols.
- **Pluggable embedder interface** (`id`, `dimensions`, `embed(text, opts)`, `similarity(a, b)`). Future ONNX/transformers/OpenAI embedders can register at runtime without touching `smart_search` or callers.
- New modules: `src/embeddings/{tokenize,hashing,embedder,index}.js`.

### Added — `global_memory` (new tool, opt-in)
- **Cross-project memory** persisted to `~/.devctx/global.db` (override via `DEVCTX_GLOBAL_DB`). Gated by `DEVCTX_GLOBAL_MEMORY=true` (defaults to disabled).
- **Kinds:** `decision` | `pattern` | `playbook` | `note`.
- **Actions:** `save` (kind + content + tags?), `recall` (kind? + query? + limit?), `list` (counts per kind), `delete` (id), `mark_used` (id), `stats`.
- **Privacy by default — content is scrubbed before persistence:**
  - API keys / bearer tokens / passwords / AWS / OpenAI (sk-) / GitHub (ghp_) / Slack (xoxb-) / Google API (AIza) / JWT-like / `-----BEGIN PRIVATE KEY-----` blocks / DB URLs / emails.
  - Home paths (`/home/USER`, `/Users/USER`, `C:\Users\USER`) collapsed to `~`.
- **Project paths stored as FNV-1a hash**, not raw path.
- **Recall uses the local hashing/TF-IDF embedder** (zero deps) for semantic ranking; falls back to chronological order when no query.
- New modules: `src/global-memory/{scrub,store}.js`, `src/tools/global-memory.js`.

### Dogfooding
- The whole 5-step plan was implemented while using devctx as the primary tool. Bug found and fixed mid-flight: `nextActions[guided_refresh].args.paths` was leaking object references instead of string paths (fixed in commit `1b1c8bb`).
- Documentation synchronized from outdated `12 / 14 / 18` tool counts to the current **20**.

### Stats
- **+68 tests** across 5 new suites (`smart-playbook.test.js`, `index-watcher.test.js`, `parser-coverage.test.js`, `embeddings.test.js`, `global-memory.test.js`).
- **Suite verde:** 882 pass / 883 tests / 1 skipped / 0 fail.
- **Zero new runtime dependencies** added.

## [1.18.1] - 2026-05-12

Agent-MCP simbiosis. No new tools (still 18) — discovery and tool selection improve at the boundary of every turn and mid-task. Zero breaking changes.

### Added — `smart_turn` returns `nextActions[]`
- **Machine-readable, intent-aware list** of `{ tool, args, why, when }` returned alongside the existing `nextTools` strings and prose `next` / `instructions`. Models anchor better to a typed list than to prose.
- **Adapts to mode + inferred intent.** Resolved mode (`blocked_guided` / `guided_refresh` / `guided_context` / `lightweight`) and intent inferred from the prompt drive the suggestions:
  - `debug` → `smart_test({ action: 'last_failure' })` first, then `smart_context({ intent: 'debug' })`.
  - `tests` → `smart_test({ action: 'affected' })` first, then `smart_test({ action: 'run', runner: 'node-test' })`.
  - `review` → `smart_review({ ref: 'HEAD' })` first, then `smart_test({ action: 'affected' })` to validate coverage gaps.
  - `refactor` / `implementation` → `smart_context({ intent })` first, then `smart_read({ mode: 'outline' })`, `smart_read({ mode: 'explain' })`, `smart_test({ action: 'affected' })`.
  - `docs` → `smart_search({ kinds: ['adr', 'adr-section'] })` first.
  - `explore` → `smart_context({ intent: 'explore' })` first, then `smart_read({ mode: 'outline' })`, `smart_context({ paths: { from, to } })` for graph traversal.
- **Ambiguous continuity disambiguation.** When `summaryResult.ambiguous` is set, `nextActions[0]` is `smart_turn({ phase: 'start', sessionId, ensureSession: true })` so multi-agent runs lock onto the recommended session explicitly.
- **End actions.** `smart_turn(end)` also returns `nextActions[]`: `repo_safety` first when blocked, milestone retry when checkpoint was skipped, fresh `smart_turn(start)` when the workflow ended, otherwise `smart_turn(start)` + `smart_review` on handoff.
- **New module:** `src/turn/next-actions.js` (`deriveStartActions`, `deriveEndActions`, intent inference with corrected regex boundaries — `\btests?\b`, `fail\w*`, `implement\w*`). 15 unit tests covering every branch.

### Added — Reactive soft-prompts on `PostToolUse`
- **Cursor and Claude adapters now inject contextual hints** through the existing `additionalContext` channel of the `PostToolUse` hook when the agent drifts back to native tools on a clear signal. Non-blocking, never returns an error, and the hint is included in hook metrics for observability.
- **Three triggers (pure heuristics, no LLM):**
  - `large_read` — `Read` returned >12KB → suggest `smart_read({ mode: 'outline', paths: ['<actual path>'] })`.
  - `repeated_reads` — `meaningfulReadCount ≥ 5` with zero writes → suggest `smart_context({ task: '<your task>' })` or `smart_context({ paths: { from, to } })`.
  - `repeated_search` — `≥3 Grep / SemanticSearch` calls in the same turn → suggest `smart_search({ query, intent, kinds: [...] })`.
- **Throttle.** In-memory `Map<hookKey, lastIssuedAt>`; default window 2 minutes per hook so the agent never sees the same hint twice in a turn. No schema changes, no migrations.
- **Gating.** `DEVCTX_DISABLE_SOFT_PROMPTS=true` turns the feature off.
- **New module:** `src/orchestration/policy/soft-prompts.js`. 12 unit tests covering gating, every trigger, write-detection short-circuit, and throttle semantics.

### Why this matters
- `nextActions` anchors the *first* tool proactively at the boundary of a task.
- Soft-prompts catch the agent *mid-task* when it drifts to native tools on a concrete signal.
- Together they cover the full turn without enforcing rules, without errors, and without breaking any client. Existing `nextTools` and `instructions` outputs stay identical.

## [1.18.0] - 2026-05-12

Five-feature expansion. Tool count goes from **16 to 18** (two new tools, three new modes/features over existing tools). All additions are offline-first, indexed, and validated.

### Added — `smart_read(mode: 'explain')`
- **Structural explanation of indexed symbols, no LLM call.** Combines signature, parent, kind, JSDoc/comment block, first body line, detected side effects (I/O, network, process, logging, mutation, throws, async, DB), and caller count from the import graph.
- **SQLite cache (`explain_cache`, schema v7).** Keyed by `file + symbol + contentHash`. Repeated explains of unchanged symbols cost zero tokens and zero LLM latency.
- **New helpers in `src/explain/explainer.js`:** `buildStructuralExplanation`, `explainSymbol`, `explainSymbols`, `detectSideEffects`, `extractDocstring`, `extractFirstBodyLine`, `formatExplanationText`.
- **Storage maintenance updated.** `runStorageMaintenance` prunes `explain_cache` rows older than the configured retention window alongside the other tables.

### Added — ADR / Spec markdown indexing (search index v6)
- **`buildIndex` now indexes architecture decision records and spec docs.** Path-based detection (`docs/adr/`, `decisions/`, `architecture/`, `design-docs/`) and filename-based (`SPEC.md`, `ARCHITECTURE.md`, `DESIGN.md`, `ADR-*.md`, `RFC-*.md`, `0001-*.md`, …). Other markdown is skipped at walker level so the index stays slim.
- **Symbols emitted:** H1 → `kind: 'adr'` with `name`, `title`, normalized `status` (accepted, deprecated, superseded, draft, proposed, rejected, amended, in-review), `signature`, `snippet`. H2/H3 → `kind: 'adr-section'` with slugified names. Filename fallback when no H1.
- **Index version bumped from 5 to 6.**

### Added — `smart_search(kinds: string[])`
- **Optional filter to scope results by symbol kind.** Examples: `kinds=['adr','adr-section']` to surface design decisions, `kinds=['class']` to restrict to declarations. Omitting the filter preserves prior behavior.
- **`filterGroupsByKinds`** crosses post-rank groups against `loadedIndex.files[rel].symbols[].kind`; result includes the normalized `kinds` field when applied.

### Added — `smart_context paths` mode
- **BFS over the import graph between two entities.** `paths: { from, to }` accepts either a relative file path or a symbol name on each side. Default `pathMaxHops: 5`, undirected (configurable via `pathDirected: true`).
- **Returns the file chain with per-step `{ file, symbol, signature, line, kind }`.** When no path exists, falls back to the nearest neighbors of each endpoint (3 each).
- **`task` is now optional in this mode.** New module `src/graph-paths.js` exports `findPath`, `resolveEntityToFiles`, `buildPathsResult`, `describePath`.

### Added — `smart_test` (new tool)
- **`action: 'affected'`** — Without executing anything, expand a git diff (default `HEAD`, also uncommitted via the same path resolver used by `smart_context`) through `importedBy ∪ testOf` (default 2 hops) and return the deduped list of test files to re-run.
- **`action: 'run'`** — Execute a runner from an allowlist (`npm-test`, `npm-run`, `pnpm-test`, `pnpm-run`, `yarn-test`, `yarn-run`, `bun-test`, `bun-run`, `node-test`, `vitest`, `jest`). Optional `script` for `*-run`, optional `files` list to scope. All arguments are sanitized (no shell metacharacters, no `..` traversal). Output is compressed via `smart_shell`; on red, persists `last_test_failure` in SQLite (`meta` table); on green, clears it.
- **`action: 'last_failure'`** — Returns the last persisted red run (command, runner, exit code, parsed TAP/jest failures, truncated output/stderr, `recordedAt`).
- **New module `src/tools/smart-test.js`** plus helpers in `src/storage/sqlite.js` (`getLastTestFailure`, `setLastTestFailure`, `clearLastTestFailure`).

### Added — `smart_review` (new tool)
- **Code review preflight in one call.** Per file: `additions`, `deletions`, `changeType`, `callers` (importedBy from the graph, capped), `affectedTests` (testOf, capped), `changedSymbols`, and `issues[]` from offline heuristic checks.
- **Heuristic detectors** (regex over diff hunks, no LLM): TODO/FIXME/XXX/HACK (low), console.log/print/println (med), debugger (high), eval/new Function/process.exit (high), `as any` / `: any` scoped to TS (med), alert (med), possible hardcoded secret patterns (high).
- **Summary aggregates:** `issuesBySeverity { high, med, low }`, `coverageGap` (source files changed without their tests touched), `layersTouched` + `crossLayer` flag based on common architecture paths (`domain`/`application`/`infrastructure`/`presentation`), and short actionable `hints`.
- **`includeBlame: true` (opt-in)** runs `git blame -L` on changed symbol lines (max 3 per file) and returns short `{ sha, author, summary }` records.
- **Strict validation.** Refs and paths are validated with `/^[A-Za-z0-9._/\-]+$/` before reaching the git CLI to block injection.
- **New modules:** `src/review/heuristics.js`, `src/tools/smart-review.js`.

### Tooling
- **Total tool count: 18** (was 16). Two new tools (`smart_test`, `smart_review`) and three new modes/features over existing tools (`smart_read explain`, ADR/Spec indexing + `kinds`, `smart_context paths`).

## [1.17.0] - 2026-05-08

### Added — token savings & continuity (P0 + P1)
- **`verbosity` on `smart_turn`** (`minimal` | `standard` | `full`, default `minimal`). Minimal trims the response body and replaces verbose `recommendedPath.instructions` with a compact `next` string. ~40-55% fewer tokens per `smart_turn(start)`.
- **`smart_resume` alias.** Convenience tool that maps to `smart_turn(phase: 'start', ensureSession: true, verbosity: 'minimal')` for one-call session rehydration.
- **`smart_summary(get)` falls back to `task_handoffs`.** When no live session is found, returns the latest handoff entry (≤7 days old) so multi-agent runs and post-restart agents recover task context instead of starting blank.
- **Rolling window in summary snapshots.** `decisions`, `completed`, and `touchedFiles` are trimmed to the 20 most recent items when they exceed 30; full counts surfaced via `archivedCounts`.
- **Read-aware auto-checkpoints in adapters.** `claude-adapter` and `cursor-adapter` extract concrete paths from `Read`, `Grep`, `Glob`, and `SemanticSearch` tool calls, accumulate them per turn, and after 8 meaningful reads (throttled at 60s) trigger `smart_summary auto_append` plus a `task_handoff` with `trigger: 'read_progress'`.

### Changed — leaner index & shell output
- **Search index v5.** `invertedIndex` entries now store only `{ path, line, kind, parent? }`. `signature`/`snippet` (already in `files[].symbols`) are enriched at query time by `queryIndex`. ~30-40% smaller `index.json`, identical API surface.
- **`smart_shell` TAP compression.** `compressTapOutput` collapses passing `ok …` lines to a single counter, preserves `not ok …` failures with their YAML diagnostic block, and keeps the final summary (`# tests`, `# pass`, `# fail`, …).
- **`smart_shell` git-log compression.** `compressGitLog` reduces multi-line commit blocks to one `<sha7> subject` line, capped at 40 commits with a "skipped N commits" note.
- **Hook metrics filtered.** Adapters now skip persisting `PostToolUse` metrics when there is no checkpoint/auto-trigger, no block, and zero overhead tokens — removing pure noise from the metrics store.
- **`smart_search` compact text output.** Removed `query`, `total`, and `# Top files` headers from the text payload; JSON `topFiles` capped at 5.

### Added — background maintenance & pre-warm
- **`runStorageMaintenance()` in `sqlite.js`.** Prunes `metrics_events`, `session_events`, `task_handoffs`, `agent_runs`, `workflow_metrics`, and `context_access` older than 30 days. Persists `last_storage_gc_at` in `meta`, throttled 24h, with a `force` override for admin/testing.
- **`triggerBackgroundIndexBuild()` in `index-manager.js`.** Fires `ensureIndexReady` fire-and-forget, re-uses a single in-flight promise, and short-circuits when the existing index is already fresh.
- **Hooked into `smart_turn(start)`.** Both helpers run on every start turn (gated by `DEVCTX_DISABLE_BACKGROUND_TASKS=true`) so the SQLite store stays bounded and the agent never pays for a cold index on the first `smart_search`.

### Tests
- New: `tests/smart-shell-compression.test.js` (TAP and git-log compressors).
- Extended: `event-policy`, `cursor-adapter`, `claude-adapter`, `robustness` (index v5 assertions), `sqlite-storage` (GC + throttle + force), `index-manager` (fresh short-circuit + missing-root failure path).
- Suite: 755 total, 754 pass, 1 skipped.

## [1.16.5] - 2026-05-06

### Added
- **Always-on context persistence in adapters:** Claude/Cursor adapters now auto-checkpoint meaningful turns on `PostToolUse` when write tools touch files, without requiring an explicit `smart_turn(end)` call from the user.
- **Automatic handoff continuity on writes:** Auto-checkpoint path now emits `task_handoffs` with `trigger: post_tool_use` so multi-agent continuity is preserved even if the conversation ends before a manual checkpoint.

## [1.16.4] - 2026-04-24

### Added
- **Multi-agent continuity foundation:** SQLite schema v6 now persists `tasks`, `task_handoffs`, `agent_runs`, and links `task_id`/`agent_id` across sessions, session events, cache, and hook state.
- **Task-aware continuity APIs:** `smart_summary` now resolves by `taskId`, persists task metadata, and surfaces latest handoff; `smart_turn(start)` now exposes `task` + `handoff` context for the next agent.
- **Adapter handoff persistence:** Claude/Cursor adapters now persist `taskId`/`agentId`, register agent runs, and write automatic handoffs on end-of-turn carryover.

### Fixed
- **SQLite insert mismatch:** `smart_summary` session event insert now uses the correct placeholder count for the expanded v6 schema (`8 columns / 8 values`), removing cascading `ERR_SQLITE_ERROR` failures.
- **Adapter hook key stability:** `agentId='main'` now maps to the expected `:main:` hook key (not subagent), restoring turn-state persistence and stop-flow enforcement in adapter/hook tests.
- **Prefetch test flakiness:** Added lock-retry handling in `smart-context-prefetch` tests to tolerate transient `database is locked` conditions under full-suite load.

## [1.16.3] - 2026-04-23

### Added
- **MCP server `instructions`:** Cursor and other clients that surface server instructions now get a short guide up front: when to use `smart_turn(start)` vs `smart_turn(end)`, required-ish fields (`phase`, `userPrompt`, `event`, `sessionId`), when to skip, and that git/PR/repo docs remain source of truth. Reduces need to open each tool JSON descriptor before the first call.

## [1.16.2] - 2026-04-17

### Fixed
- **Pre-commit hook:** No longer uses hardcoded Node path (`process.execPath`) which broke after nvm upgrades. Resolves script via `npm root -g`, runs only if the file exists, and still blocks commits with the usual message when repo safety fails.
- **Agent rules:** Added explicit tool substitution block (`smart_search OVER Grep`, `smart_read OVER Read`, `smart_shell OVER Shell`) to `agentRuleBody` so agents consistently prefer devctx tools. Re-run `npx smart-context-init` to apply to existing projects.

### Docs
- Documented that agent rules (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`) are not updated automatically on package upgrade — added explicit re-init instructions to both READMEs.

## [1.16.1] - 2026-04-17

### Changed
- **Agent rules:** Stronger tool substitution guidance (`smart_search OVER Grep/SemanticSearch`, `smart_read OVER Read` for large/multi-file context, `smart_shell OVER Shell` for build/test/lint/git checks, `smart_turn(end, milestone)` after every significant change).

## [1.16.0] - 2026-04-20

### Changed — signatures quality + context self-sufficiency

- **Arrow function signatures in `signatures` mode.** `const fn = (a, b) => {}` now shows parameters instead of just the name. Applies to all arrow functions and function expressions assigned to variables. (~70% of JS/TS functions are written this way.)
- **Dependencies with `matchedSymbols` always read content.** `shouldReadContentForItem` now returns `true` for dependency files that contain query-relevant symbols, even when the index signal is strong. Previously these files were returned as symbol lists only, forcing follow-up `smart_read` calls.
- **`matchedFiles` reflects capped output.** `smart_search` now reports the number of files actually shown (after cap). `totalFiles` is added only when uncapped count differs, keeping the response compact.
- **Real-world eval harness** (`npm run eval:realworld`). 10 diverse scenarios (debug, code-review, refactoring, testing, architecture, search comparison, entryFile, tight budget) run against the MCP's own codebase. Measures self-sufficiency, follow-up reads, token usage, and search noise. Fully read-only.

### Impact

Self-sufficiency rate rises from 63% to 88% (7/8 context scenarios pass without follow-up reads). Follow-up `smart_read` calls drop from 5 to 0. Token waste from follow-ups drops to 0%.

## [1.15.0] - 2026-04-20

### Changed — smart_context self-sufficiency

- **`maxTokens` default raised to 12000** (was 8000). A single `smart_context` call now returns enough content to work without follow-up `smart_read` calls in most cases.
- **Primary files always read content in balanced mode.** Previously, files with strong index signal were returned as symbol lists only, forcing 3-5 extra `smart_read(symbol)` calls. Now primary items always include signatures content.
- **`allocateReads` uses signatures mode for all roles.** Previously primary files used `outline` (names only). Now they use `signatures` (params + return types) — the agent gets the API surface in one call.
- **`entryFile` guaranteed in top results.** `scorePrimarySeed` now gives +100 score to `entryFile` evidence, ensuring it never falls out of the `slice(0, 5)` limit after reranking.
- **Silent catch blocks replaced with stderr logging.** Three empty `catch {}` in `smart_context` (entryFile resolution, prefetch path, recordContextAccess) now log to `[devctx]` stderr for diagnostics.
- **`smart_context` tool description updated.** Documents new default budget (12000) and that primary files always include content.

### Impact

Net token usage per task drops ~25-30% because the first `smart_context` call is self-sufficient, eliminating 3-5 follow-up `smart_read` calls that previously cost 3-5K tokens each.

## [1.14.0] - 2026-04-20

### Changed — smart_search noise reduction

- **Result cap:** Output limited to top 15 files by default (was unlimited). New `maxFiles` parameter (1-50) lets agents control this.
- **Proportional samples:** High-scoring files get 5 sample lines, low-scoring files get 2 (was 3 for all).
- **Broad query hint:** When >30 files match, results include a note suggesting Grep for exact pattern matching.
- **Tool description rewritten:** Now explicitly states when NOT to use smart_search (exact matches → Grep, file lookup → Glob, broad queries → noisy).

### Changed — Agent orchestration docs

- **CLAUDE.md:** Added decision flow for smart_search vs Grep vs Glob. Added anti-patterns for broad queries and file-name searches.
- **AGENTS.md:** Tool selection table now separates symbol search (smart_search) from exact search (Grep) and file lookup (Glob).
- **Tool descriptions (server.js):** `smart_read` emphasizes reading cascade. `smart_context` marked as PREFERRED with "call this FIRST". `smart_search` lists NOT-ideal scenarios. `smart_shell` trimmed.
- **MCP prompts:** Rewritten to be more directive — emphasize `smart_context` first, cascade, and never skip to full.
- **Profiles-compact:** All 5 workflows updated — removed `detail=moderate` (→ `balanced`), trimmed prose, added "Key:" guidance per workflow.

### Changed — Smoke test alignment

- **smoke-test.js:** Removed assertions on deleted fields (`metrics.rawTokens`, `metrics.compressedTokens`, `engine`). Aligned with v1.13.0 lean responses.

### Changed — Test performance (~74s faster)

- **find hardening tests:** Now use a minimal tmpdir instead of the full repo (48s → 1s).
- **10 smart_context suites:** `buildIndex` moved from `beforeEach` to `before` (index built once per suite, not per test).
- **`test:fast` script:** New `npm run test:fast` runs with `--test-concurrency=4` (~3x faster, may have intermittent SQLite contention).

## [1.13.0] - 2026-04-17

### Changed — Token Optimization (8K-30K tokens/session saved)

- **JSON compacto:** `asTextResult` now uses `JSON.stringify(result)` without indentation (~15-25% fewer tokens globally on every tool call)
- **Remove `metrics`/`metricsDisplay` from tool responses:** Telemetry is persisted internally; agent responses no longer include raw token counts, savings percentages, or display strings. Affects `smart_read`, `smart_search`, `smart_context`, `smart_shell` (~100-500 tokens/call)
- **`smart_context` lean stats:** Replaced verbose `metrics` object with compact `stats: { filesIncluded, filesEvaluated, detailMode }`; removed `metricsDisplay` and `totalTokens` computation
- **Outline/signatures: imports excluded:** `summarizeCode` no longer emits `import` lines in `outline` or `signatures` mode — imports are noise for structural analysis (~40-60 tokens per file, biggest impact on `smart_read` which has 850+ uses)
- **Export default truncated:** `export default <expr>` expressions capped at 60 chars to avoid HOC/compose() lines bloating the outline
- **`uniqueLines` collapses consecutive blank lines:** Prevents repeated empty lines from accumulating tokens in compressed text
- **`smart_turn` continuity compact:** Removed debug fields `sharedTerms`, `promptTermCount`, `summaryTermCount`, `matchScore` from `continuity` object — agent only needs `state`, `shouldReuseContext`, `reason`
- **`smart_turn` recommendedPath compact:** `steps[]` array of objects replaced by `instructions` string (concatenated tool:instruction pairs)
- **`smart_turn` conditional fields:** `storageHealth` only included when status is not ok; `mutationSafety` only included when `blocked === true`; `repoSafety` only included when blocked or side effects suppressed (~200-800 tokens/call)
- **`smart_read` signatures mode with real signatures:** `formatTopLevelStatement` now extracts full function signature (params + return type) up to 120 chars instead of just the name — reduces follow-up `smart_read(symbol)` calls

## [1.12.0] - 2026-04-17

### Fixed
- **index-manager:** Critical bug — `ensureIndexReady` was calling `buildIndexCore({ root, incremental: true })` (wrong signature) causing auto-index build to fail silently and always return `status: 'fallback'`. Now uses `buildIndexIncremental(root)` + `persistIndex` (correct call).
- **README:** Corrected `detail: 'moderate'` examples to `detail: 'balanced'` (valid schema value)
- **README:** Removed `maxResults` from `smart_search` API reference (not in schema)
- **README:** Removed `cwd` from `smart_shell` API reference (not in schema)

### Added
- **smart_shell:** Timeout configurable via `DEVCTX_SHELL_TIMEOUT_MS` env var (default 15 000 ms). Set to e.g. `60000` for large test suites.
- **tokenCounter:** Encoder configurable via `DEVCTX_TOKEN_MODEL` env var. Supports any model name accepted by `js-tiktoken` (e.g. `gpt-4o`, `gpt-4`). Use `claude` as alias for `gpt-4o` encoding (±15-20% accuracy vs native Claude tokenizer).

## [1.11.0] - 2026-04-17

### Fixed
- **smart_shell:** Diff-aware compression — unified diff output is now split by file (max 8 files, 60 lines each) with a hint to run `git show -- <file>` for truncated bodies; avoids mid-hunk truncation
- **smart_turn:** Added explicit skip guidance for single-session point-in-time tasks (commit review, quick lookup) — setup overhead only pays off when the session will be resumed later
- **smart_shell description:** Documents diff behaviour and recommends `git diff --stat` first, then `git show -- <file>` per file for targeted reading
- **smart_read/smart_read_batch descriptions:** `full` mode now starts with `PREFER outline/signatures/symbol — full saves 0 tokens`; each mode documented with savings estimate and exact use case

### Changed
- **comment cleanup:** Removed 100+ redundant narrating comments across `src/` and `scripts/`; translated remaining Spanish strings to English

## [1.10.0] - 2026-04-16

### Fixed
- **smart_search zero results:** Implemented three-pass search cascade to eliminate "0 results" failures:
  1. **Pass 1 (exact):** `--fixed-strings` literal match (original behavior)
  2. **Pass 2 (regex fallback):** If exact returns 0, retries without `--fixed-strings` to handle camelCase fragments, partial words, and phrases
  3. **Pass 3 (term expansion):** If regex also returns 0 and the query has multiple words, splits into individual terms (≥3 chars), searches each independently, and merges with deduplication
- **smart_search 0-result message:** When all passes return 0, now shows actionable message explaining what was tried and suggesting alternatives (shorter term, Grep, build_index)
- **smart_search confidence:** `retrievalConfidence` now correctly reports `none` (0 results), `low` (term expansion), `medium` (regex), or `high` (exact match)
- **MCP protocol safety:** Replaced `console.error` in ripgrep error path with `process.stderr.write`

## [1.9.0] - 2026-04-16

### Fixed
- **smart_read outline:** IIFEs (userscripts, legacy bundles) now expose internal functions and consts instead of returning just `(function () {`. Each symbol lists name and line number.
- **build_index:** Symbols inside IIFEs are now indexed correctly. Previously a `.user.js` file would produce 0 symbols; now all internal `function` declarations and `const fn = () =>` are extracted.
- **Snippets:** Symbols extracted from IIFEs get an AST-scoped snippet (only their own node body, capped at 280 chars) instead of a runaway snippet that included the rest of the IIFE.

### Changed
- **npm version badge:** Switched from `badge.fury.io` (slow CDN cache, showed stale version) to `shields.io/npm/v/` which reflects the published version within minutes.

## [1.8.1] - 2026-04-15

### Changed
- **MCP Registry:** Added `mcpName` field to package.json for official registry listing
- **MCP Registry:** Added `server.json` with registry metadata

## [1.8.0] - 2026-04-15

### Changed
- **README:** Added honest "When to Use / When Not To" section based on real user feedback
  - Documents when devctx adds value vs when native tools are faster
  - Includes real user quotes from production usage

## [1.7.9] - 2026-04-15

### Fixed
- **MCP Protocol Broken:** Replaced `console.log` with `process.stderr.write` in index-manager
  - The previous fix (environment detection) was fragile and didn't cover all cases
  - `stderr` is the correct channel for diagnostics — stdout is reserved for MCP JSON protocol
  - Eliminates "Unexpected token '📦'" errors in Cursor permanently

## [1.7.8] - 2026-04-10

### Fixed
- **Search Quality:** Eliminated noise from data files and node_modules in results
  - Added `--max-filesize 1M` to ripgrep — files like 50k-line JSONs are now skipped
  - Added `**/{dir}/**` glob pattern to reliably exclude nested node_modules
  - Added `IGNORED_FILE_PATTERNS` to filter minified files (.min.js, .map, .snap) and data fixtures
  - Addresses feedback: "node_modules/fraction.js/README.md appearing as top result"
  - Addresses feedback: "questions.json (50k lines) returned instead of source code"

## [1.7.7] - 2026-04-01

### Fixed
- **MCP Protocol Pollution:** Console.log messages from auto-index build were breaking MCP JSON protocol
  - Error: `Client error: Unexpected token '📦', "📦 Buildin"... is not valid JSON`
  - Logs now silenced in MCP server mode (only shown in CLI usage)
  - Fixes connection failures in Cursor when building index automatically

## [1.7.6] - 2026-04-01

### Added
- **Auto-build index on first use:** `smart_search` and `smart_context` now automatically build the search index if missing or stale
  - Eliminates manual `build_index` requirement
  - Index freshness cached for 24h or until git HEAD changes
  - 30-60s delay on first call, then instant on subsequent calls
  - Graceful fallback to grep if build fails or times out
  - Addresses feedback: "smart_search failed with indexFreshness: unavailable"

### Changed
- **Index management:** New `index-manager.js` module handles lazy index construction with intelligent caching
- **User experience:** Zero-configuration search - works out of the box without manual index building

### Tests
- Added 4 unit tests for index manager (build, cache, status, force rebuild)
- 72/72 tests passing (index-manager + streaming + simple-task + metrics-display + orchestration)

## [1.7.4] - 2026-04-01

### Fixed
- **README Links:** Converted relative documentation links to absolute GitHub URLs to fix npm rendering
  - Changed `../../docs/task-runner.md` to full GitHub URL
  - Changed `../../docs/mcp-prompts.md` to full GitHub URL
  - Fixes README not displaying on npmjs.com web interface

## [1.7.3] - 2026-04-01

### Fixed
- **npm Package:** Added `README.md` to `files` array in `package.json` so it appears on npm registry

## [1.7.2] - 2026-04-01

### Added
- **Streaming Progress Notifications:** Real-time visibility into long-running operations
  - Optional `progress` parameter in `smart_read`, `smart_search`, `smart_context`, `smart_shell`
  - Emits MCP `notifications/progress` events with phase, elapsed time, and operation-specific data
  - Phases: planning → searching → reading → compressed → complete
  - Throttled to max 1 update per 100ms to avoid spam
  - Addresses feedback: "Caja negra: no pude ver el proceso paso a paso"
  - Impact: Agents can show real-time progress instead of appearing frozen

- **Fast Path for Simple Tasks:** Automatic detection of simple tasks to skip overhead
  - Detects patterns: "move X to Y", "rename Z", "fix typo", "add comment", etc.
  - Fast path: skips preflight, skips session isolation, skips checkpoint enforcement
  - Only tracks basic metrics
  - Impact: Simple tasks 3-5x faster (2-3s → <500ms)
  - Addresses feedback: "Overkill para refactor pequeño: gastó más tiempo en entender el contexto"
  - New `fastPath` flag in automaticity metrics

- **Inline Metrics Display:** All tools now include `metricsDisplay` field with human-readable summary
  - Format: `✓ {tool}, {target}, {files} files, {raw}→{compressed} tokens ({ratio})`
  - Examples:
    - `✓ smart_read, src/auth.js, 1.2K→120 tokens (10.0:1)`
    - `✓ smart_search, buildMetrics, 10 files, 1.7K→781 tokens (2.2:1)`
    - `✓ smart_context, analyze auth flow, 8 files, 15.0K→1.5K tokens (10.0:1)`
  - Agents can surface this directly without formatting
  - Addresses feedback: "Métricas ocultas: no hubo feedback sobre tokens consumidos"

- **Top Tools Visibility:** `smart_metrics` now includes `summary.topTools` field
  - Highlights top 3 tools by net savings (e.g., smart_context: 850 tokens, smart_read: 400 tokens)
  - Filters out tools with negative or zero net savings
  - Makes compression tool value immediately visible in session reports
  - Addresses feedback: "el valor práctico de smart_context y smart_read se notó durante el trabajo, pero no quedó tan visible en la métrica agregada"

### Fixed
- **Client Detection:** Auto-detect client from environment variables (`CURSOR_AGENT=1`, `CLAUDE_AGENT=1`, etc.)
  - `task-runner` and `headless-wrapper` now detect client automatically instead of defaulting to `generic`
  - Metrics now correctly distinguish `cursor` from `generic` based on `CURSOR_AGENT` env var
  - Added `detectClient()` utility with caching and reset capability
  - CLI scripts use auto-detection by default
  - Supports cursor, claude, gemini, codex, with fallback to generic

### Changed
- **Documentation:** Removed version-specific references from README files
- **Repository:** Cleaned up local development files (.cursor/rules/, .cursorrules, .gitlab-ci.yml, PUBLISH.md)

### Tests
- Added 4 unit tests for streaming progress (notifications, throttling, error handling)
- Added 10 unit tests for simple task detection
- Added 8 unit tests for `metricsDisplay` formatting
- Added 8 unit tests for client detection
- Added test for `topTools` ordering and filtering
- 68/68 tests passing (streaming + simple-task + metrics-display + orchestration)

### Documentation
- `docs/issues/execution-visibility-and-task-sizing.md`: Analysis of visibility and overhead issues
- `docs/issues/tool-level-metrics-visibility.md`: Problem analysis and solution for topTools

## [1.7.0] - 2026-04-01

### Added
- **Shared Orchestration Layer:** Centralized orchestration logic in `base-orchestrator.js` and `event-policy.js`
  - Managed start/end cycle with session isolation
  - Wrapped prompts with context overhead tracking
  - Preflight logic (smart_context/smart_search) with policy composition
  - Continuity guidance and automaticity signals
  - Eliminates 433 lines of duplication from task-runner and headless-wrapper

- **Client Adapter Pattern:** Reusable adapters for IDE-specific hooks
  - `claude-adapter.js`: SessionStart, UserPromptSubmit, PostToolUse, Stop events
  - `cursor-adapter.js`: ConversationStart, UserMessageSubmit, PostToolUse, ConversationEnd events
  - Full dependency injection for testability
  - Turn tracking in SQLite with checkpoint enforcement
  - Auto-append carryover on conversation end
  - Backward compatible: legacy hooks reduced to 1-line re-exports

- **Comparative Client Metrics:** Cross-client benchmarking in product quality analytics
  - Per-client aggregation: adapter events, auto-start/checkpoint coverage, context overhead
  - Comparative signals: lowest avg overhead client, best auto-start rate
  - Standardized metadata: client, managedByClientAdapter, autoStartTriggered, autoCheckpointTriggered, overheadTokens
  - New report section: "Client Adapter Signals" with per-client breakdown
  - Prevents double-counting: overheadTokens only from events that declare it

### Changed
- **task-runner.js:** Refactored to consume shared orchestration (-265 lines)
- **headless-wrapper.js:** Refactored to delegate to base orchestrator (-225 lines)
- **claude-hooks.js:** Reduced to 1-line re-export for backward compatibility
- **product-quality.js:** Extended with client adapter quality analysis
- **report-metrics.js:** Fixed bug that hid quality section when turnsMeasured was 0

### Tests
- Added 54 unit tests for base-orchestrator and event-policy
- Added 17 unit tests for claude-adapter and cursor-adapter
- Added 3 unit tests for product-quality
- Total: 93/93 tests passing

### Documentation
- `docs/auto-orchestration-design.md`: Architecture and implementation plan
- `docs/phase-1-consolidation.md`: Shared orchestration validation summary
- `docs/phase-2-client-adapters.md`: Client adapter pattern documentation
- `docs/auto-orchestration-summary.md`: Executive summary of all phases
- `docs/verification/benchmark.md`: Validation workflow for client comparison

## [1.6.2] - 2026-04-01

### Improved
- **smart_shell Security:** Fixed false positives for legitimate shell patterns
  - Allow pipe character inside quoted arguments: `rg "foo|bar" src`
  - Allow `eval`/`exec` in path names: `find evals -name "*.json"`, `npm run eval:report`
  - Block `eval`/`exec` as commands: `eval "code"`, `exec /bin/sh`
  - Properly handle escaped characters: `find -exec rm {} \;`
  - Test coverage: Added 3 new tests, updated 4 security tests

- **Runtime Preflight:** Check Node version on startup
  - New `runtime-check.js` utility validates Node 22+ requirement
  - Server and task runner exit early with clear error if Node < 22
  - Message: "Node X.Y.Z is below minimum requirement (22+). node:sqlite and node:test require Node 22+"
  - Test coverage: `runtime-check.test.js`

- **smart_doctor Impact Estimation:** Show estimated cleanup impact
  - Compaction recommendations now include: `~3247 rows, ~15.2MB (45% reduction)`
  - New `estimatedImpact` field in details: `{ rowsToDelete, bytesReclaimed, pctReduction }`
  - Helps users decide when to run compaction

- **Legacy Cleanup Workflow:** Guided cleanup with visual feedback
  - `smart-context-task cleanup --mode legacy` shows table of eligible files
  - Displays file names, sizes, and total impact before cleanup
  - Clear instruction: "To apply cleanup, run: smart-context-task cleanup --mode legacy --apply"

### Changed
- **Package Version:** Bumped to 1.6.2

## [1.6.1] - 2026-03-31

### Fixed
- **Task Runner CLI Project Root:** `runtime-config.js` now uses `process.cwd()` as default instead of deriving from installed package path
  - Result: `smart-context-task` and `cursor-devctx` launcher now correctly use `.devctx` from the project where they're invoked
  - Test coverage: `runtime-config.test.js` validates `projectRoot === cwd` when no `--project-root` or env is set

- **SQLite Lock Handling:** Improved resilience for transient database locks
  - `sqlite.js`: Added `busy_timeout=1000ms` and retry logic with 3 attempts and incremental backoff (75ms × attempt)
  - `task-runner.js`: Wrapped all `smart_turn`, `smart_doctor`, `smart_status` calls with retry (100ms × attempt)
  - Result: Task runner workflows tolerate brief SQLite contention without failing
  - Test coverage: `task runner review dry-run tolerates transient SQLite locks` simulates real lock with child process

- **Prompt Rendering:** Fixed `[object Object]` appearing in task runner prompts
  - New `extractContextTopFiles` function normalizes `topFiles` to string paths
  - Handles both object format (`{file, path}`) and string format
  - Result: `Refreshed top files: tests/robustness.test.js, src/task-runner/policy.js` instead of `[object Object]`
  - Applied to preflight and continuity guidance rendering

### Changed
- **Package Version:** Bumped to 1.6.1

## [1.6.0] - 2026-03-31

### Added
- **smart_doctor Tool:** Comprehensive health checks for devctx state
  - Repo safety checks (tracked/staged state.sqlite detection)
  - Storage diagnostics with SQLite integrity verification
  - Compaction recommendations (stale sessions, old events, oversized metrics)
  - Legacy state detection and cleanup guidance
  - CLI: `smart-context-doctor` with `--json` and `--no-integrity` flags
  - Overall status: ok/warning/error with prioritized recommended actions

- **Orchestration Benchmark:** Release gating for production quality
  - 5 core scenarios: aligned-resume, context-refresh, blocked-remediation, skipped-checkpoint, persisted-checkpoint
  - Baseline enforcement in `orchestration-release-baseline.json`
  - CI integration: `npm run benchmark:orchestration:release` blocks on regression
  - `prepublishOnly` hook prevents npm publish if benchmark fails

- **Product Quality Metrics:** Beyond token savings
  - Continuity alignment rate (% of turns with aligned context)
  - Blocked remediation coverage (% of blocked turns with recommendedActions)
  - Refresh top-file signal rate (% of refreshes with topFiles)
  - Checkpoint persistence rate (% of checkpoints actually persisted)
  - Average recommended actions when blocked
  - Exposed in `smart_metrics` and `report-metrics.js`

- **Operational Guidance:** `recommendedPath` in smart_turn
  - Modes: blocked_guided, guided_refresh, guided_context, lightweight, continue_until_milestone, checkpointed
  - `nextTools`: Array of recommended tools (e.g., ['repo_safety', 'smart_search', 'smart_read'])
  - `steps`: Array of instructions with priority (required/recommended)
  - Surfaced in Claude hooks and headless wrapper

### Enhanced
- **Uniform mutationSafety Contract:** Consistent across all tools
  - New `mutation-safety.js` utility with `buildMutationSafety`, `buildDegradedMode`, `attachSafetyMetadata`
  - All tools expose: `{ blocked, blockedBy, stateDbPath, recommendedActions, message }`
  - `degradedMode` when side effects are suppressed
  - Centralized subject/message generation

- **SQLite Diagnostics:** Structured recovery guidance
  - `diagnoseStateStorage()` with PRAGMA quick_check
  - `getStateStorageHealth()` for missing/oversized/corrupted detection
  - `classifyStateDbError()` for locked/permission/corrupted classification
  - Enriched error messages with recovery actions

- **Client Integration:** Consistent guidance across all clients
  - Updated `init-clients.js` to surface mutationSafety contract
  - New blocked-state remediation row in `client-compatibility.md`
  - All clients (Cursor, Claude Desktop, Codex, Qwen) get guidance on blockedBy and recommendedActions

### Changed
- **Test Suite:** Expanded to 598+ tests (99%+ coverage)
- **CI/CD:** Release gating with orchestration benchmark
- **Package Version:** Bumped to 1.6.0

## [1.5.0] - 2026-03-31

### Added
- **Session Isolation:** Automatic new session creation in `smart_turn(start)`
  - Triggers when `ensureSession=true`, no fixed `sessionId`, and prompt mismatches active session
  - Prevents context contamination between unrelated tasks
  - Returns `isolatedSession` and `previousSessionId` in response

- **Net Token Savings:** Honest accounting of overhead
  - Calculates `netSavedTokens = savedTokens - overheadTokens`
  - Tracks overhead from `smart_summary`, hooks, and wrapper operations
  - Exposed in `smart_metrics` and `report-metrics.js`
  - Shows both gross and net savings percentages

- **Workflow Tracking in Core:** Integrated into `smart_turn`
  - Enabled via `DEVCTX_WORKFLOW_TRACKING=true` environment variable
  - `smart_turn(start)` auto-tracks workflow (debugging, code review, etc.)
  - `smart_turn(end)` closes workflow for events: milestone, task_complete, session_end, blocker
  - Persists `overheadTokens`, `netSavedTokens`, `netSavingsPct` in workflow metadata

- **Context Refresh:** Lightweight rehydration in `smart_turn(start)`
  - Calls `smart_context(minimal)` to rehydrate context for current prompt
  - Incrementally refreshes index if stale or unavailable
  - Returns `refreshedContext` with `topFiles`, `hints`, `indexRefreshed`
  - Propagated to Claude hooks and headless wrapper

- **Net Metrics Coverage API:** Transparency for historical data
  - `netMetricsCoverage` per workflow: `{ available, source }` (persisted/derived/none)
  - `netMetricsCoverage` in summary: `{ coveredWorkflows, totalWorkflows, coveragePct, complete }`
  - Exposed in `workflow-tracker.js` public API

### Enhanced
- **Selective Context Refresh:** Optimized to avoid unnecessary overhead
  - Only triggers for: new/isolated sessions, ambiguous cases, real continuity changes
  - Skips refresh for aligned or trivial prompts
  - Reduces token cost for routine operations

- **Anti-Commit Enforcement:** Hardened for SQLite state
  - Centralized policy in `repo-safety.js` with `getRepoMutationSafety()`
  - Closes bypasses in `workflow-tracker.js`, `context-patterns.js`, `metrics.js`
  - `smart_turn` exposes `workflow.blocked` when writes are blocked
  - Claude hooks avoid persisting state when repo safety blocks SQLite

### Changed
- **Documentation:** Aligned for workflow tracking, net savings, session isolation
- **Test Suite:** Expanded coverage for new features
- **Package Version:** Bumped to 1.5.0

## [1.4.0] - 2026-03-31

### Added
- **smart_edit Tool:** Batch file editing with pattern replacement
  - Edit multiple files in one call with literal or regex patterns
  - Supports `dryRun` mode for preview without modifications
  - Returns match count and detailed results per file
  - Use cases: bulk refactoring, removing console.log, pattern cleanup
  - Example: Remove all `console.log` from 10 files in one call
  - Max 50 files per call for safety

- **smart_status Tool:** Session context visibility
  - Displays current session: goal, status, nextStep, currentFocus
  - Shows recent decisions, touched files, pinned context, unresolved questions
  - Progress stats: completed count, decisions count, files count
  - Two formats: `detailed` (formatted with emojis) and `compact` (minimal JSON)
  - Updates automatically with each MCP operation
  - Fallback to most recent session if no active session exists

### Enhanced
- **smart_summary Flat API:** Simplified parameter structure (backward compatible)
  - New: `{ action: 'update', goal: '...', status: '...' }` (flat)
  - Old: `{ action: 'update', update: { goal: '...', status: '...' } }` (nested)
  - Both formats supported - nested takes priority if both provided
  - No breaking changes - existing code continues to work
  - Makes API more intuitive and easier to use

- **smart_context Pattern Detection:** Automatically detects and prioritizes literal patterns
  - Detects: `/**`, `/*`, `// TODO`, `// FIXME`, `// XXX`, `// HACK`
  - Detects: `console.log`, `console.error`, `debugger`
  - When task mentions these patterns, they're prioritized in search results
  - No manual search needed - smart_context handles it automatically
  - Example: "Find all TODO comments" → automatically searches for `// TODO`

- **smart_read Range with Outline:** Support line ranges in outline/signatures mode
  - Previously: `{ mode: 'outline', startLine, endLine }` would extract raw text
  - Now: Applies outline summarization to the specified range
  - Useful for large files - get outline of specific section only
  - Reduces tokens when you know which part of file is relevant

## [1.3.1] - 2026-03-30

### Changed
- **All Visibility Features Now Enabled by Default:**
  - `DEVCTX_SHOW_USAGE` - Changed from opt-in to **enabled by default**
  - `DEVCTX_EXPLAIN` - Changed from opt-in to **enabled by default**
  - `DEVCTX_DETECT_MISSED` - Changed from opt-in to **enabled by default**
  - Rationale: Make devctx usage visible by default, ensure agents use MCP when installed
  - Users can still disable: `export DEVCTX_SHOW_USAGE=false` (etc.)
  - Updated all tests to reflect new default behavior
  - Updated all documentation (README, tool README, feature docs)
  - Goal: Maximize visibility, drive adoption, make non-usage immediately obvious

### Added
- **Multi-Client Agent Rules:**
  - New `.cursorrules` file for Cursor (committed to git)
  - Updated `CLAUDE.md` for Claude Desktop (gitignored, user-specific)
  - Updated `AGENTS.md` for other agents (gitignored, user-specific)
  - New `docs/agent-rules-template.md` with templates for all clients
  - All rules enforce MANDATORY devctx usage policy
  - Enforces: Use smart_read instead of Read, smart_search instead of Grep, etc.
  - Provides recommended workflow and preflight checklist
  - Explains when to use devctx vs native tools
  - Requires agent to explain if native tools are used
  - Goal: Ensure agents use devctx when MCP is installed, across all clients

- **MCP Prompts (Automatic Forcing):**
  - New MCP prompts feature allows automatic injection of forcing instructions
  - 3 prompts available: `use-devctx`, `devctx-workflow`, `devctx-preflight`
  - Invoke with `/prompt use-devctx` in Cursor chat
  - `use-devctx`: Ultra-short forcing prompt (injects: `Use devctx: smart_turn(start) → ...`)
  - `devctx-workflow`: Complete step-by-step workflow template
  - `devctx-preflight`: Preflight checklist (build index + init session)
  - Implemented in `src/server.js` using MCP SDK `server.prompt()` API
  - Benefits: No manual typing, centrally managed, no typos, discoverable
  - New doc: `docs/mcp-prompts.md` with complete guide
  - Updated: `README.md` and `tools/devctx/README.md` with prompts section
  - Goal: Make forcing devctx usage effortless and automatic
  - Replaces need for manual forcing prompts or `.cursorrules`

- **Missed Opportunities Detector:**
  - New detector identifies when devctx should have been used but wasn't
  - Analyzes session patterns to detect adoption gaps and potential token savings
  - Enable with `export DEVCTX_DETECT_MISSED=true`
  - Detects: No devctx usage in long sessions (>5 min), Low adoption (<30%), Usage dropped (>3 min gap)
  - Shows session stats: duration, devctx operations, estimated total, adoption rate
  - Estimates potential token savings per opportunity
  - Provides actionable suggestions: forcing prompt, check index, verify MCP
  - Severity levels: 🔴 High (no usage), 🟡 Medium (low adoption, dropped)
  - Session-scoped tracking (resets on MCP server restart)
  - Heuristic-based: estimates total operations from time gaps (can't intercept native tools)
  - New module: `src/missed-opportunities.js` with detection and formatting functions
  - New tests: `tests/missed-opportunities.test.js` (11 tests covering all scenarios)
  - Integrated into all major tools after `persistMetrics()`
  - New doc: `docs/missed-opportunities.md` with complete guide
  - Updated: `README.md` and `tools/devctx/README.md` with missed opportunities section
  - Goal: Identify adoption gaps, quantify potential savings, validate forcing prompts
  - Benefits: Detect when agent switches to native tools, see missed savings, verify rules working
  - Disabled by default to avoid false positives
  - Can combine with usage feedback and decision explainer for maximum visibility
  - Limitations: Total operations estimated (not measured), may have false positives, session-scoped only

- **Decision Explainer System:**
  - New decision explainer provides transparency into agent decision-making
  - Explains why devctx tools were used, what alternatives were considered, and expected benefits
  - Enable with `export DEVCTX_EXPLAIN=true`
  - Tracks smart_read, smart_search, smart_context, smart_shell, smart_summary
  - Shows reasoning: "Why was smart_read used instead of Read?"
  - Shows expected benefits: "~45.0K tokens saved"
  - Shows context: "2500 lines, 50000 tokens → 5000 tokens"
  - Predefined reasons for consistency (LARGE_FILE, INTENT_AWARE, TASK_CONTEXT, etc.)
  - Predefined benefits for consistency (TOKEN_SAVINGS, BETTER_RANKING, COMPLETE_CONTEXT, etc.)
  - Session-scoped tracking (resets on MCP server restart)
  - New module: `src/decision-explainer.js` with tracking and formatting functions
  - New tests: `tests/decision-explainer.test.js` (11 tests covering all scenarios)
  - Integrated into all major tools after `persistMetrics()`
  - New doc: `docs/decision-explainer.md` with complete guide
  - Updated: `README.md` and `tools/devctx/README.md` with decision explainer section and examples
  - Goal: Provide transparency to understand agent decisions, learn best practices, debug tool selection
  - Benefits: Understand why tools were chosen, learn when to use which tool, validate agent behavior
  - Disabled by default to avoid verbose output
  - Can combine with usage feedback for maximum visibility

- **Real-Time Usage Feedback:**
  - New usage feedback system provides immediate visibility into devctx tool usage
  - Shows which tools were used, call counts, and tokens saved at end of agent responses
  - **Auto-enabled for first 10 tool calls (onboarding mode)**, then auto-disables
  - Manual control: `export DEVCTX_SHOW_USAGE=true` (keep enabled) or `false` (disable immediately)
  - Tracks smart_read, smart_search, smart_context, smart_shell, smart_summary
  - Automatic aggregation of multiple calls to same tool
  - Smart formatting of token counts (K/M) and target paths
  - Session-scoped tracking (resets on MCP server restart)
  - Onboarding message shows remaining calls: `*Onboarding mode: showing for N more tool calls*`
  - New module: `src/usage-feedback.js` with tracking, formatting, and onboarding logic
  - New tests: `tests/usage-feedback.test.js` (14 tests covering all scenarios including onboarding)
  - Integrated into all major tools after `persistMetrics()`
  - New doc: `docs/usage-feedback.md` with complete guide
  - Updated: `README.md` and `tools/devctx/README.md` with usage feedback section and examples
  - Goal: Provide real-time visibility to verify agent is using devctx, debug adoption issues, measure impact
  - Benefits: Know immediately if devctx is used, see savings in real-time, validate forcing prompts
  - Onboarding mode ensures new users see feedback without manual configuration

- **Adoption Metrics (Experimental):**
  - New adoption analytics to measure how often devctx is actually used in practice
  - Analyzes sessions with/without devctx tools, adoption rate by inferred complexity
  - Tracks tool usage count, average tools per session, token savings when used
  - Integrated into `npm run report:metrics` output
  - Honest limitations: complexity inferred (not actual), can't measure feedback or forcing prompts
  - New module: `src/analytics/adoption.js` with `analyzeAdoption()` and `formatAdoptionReport()`
  - New tests: `tests/adoption-analytics.test.js` (9 tests covering all scenarios)
  - Updated: `src/tools/smart-metrics.js` to include adoption analysis
  - Updated: `scripts/report-metrics.js` to display adoption report
  - Updated: `README.md` with adoption metrics section and example output
  - New doc: `docs/adoption-metrics-design.md` with complete design rationale
  - Goal: Complement compression metrics with usage metrics, verify rules are working
  - Limitations: Can only measure when devctx IS used (tool calls visible), not when ignored

- **Adoption Improvements Phase 2:**
  - Added "Quick Start: Which Client Should I Use?" table in README with automaticity levels and recommendations
  - Added "How to Force devctx Usage" section with official prompts (complete + ultra-short)
  - Added 3 concrete feedback examples to docs/agent-rules/feedback-when-not-used.md
  - Enhanced Troubleshooting section with forcing prompt and index check
  - Goal: Make adoption easier, provide standardized forcing prompts, show concrete examples
  - New doc: docs/adoption-improvements-phase2.md with complete analysis

### Changed
- **Quality Claim Further Matization (Phase 2):**
  - Changed "Responses are often faster and more context-efficient" to "Token usage drops 85-90% (proven, measured) + Responses often faster due to less data to process (inferred)"
  - Expanded "Honest claim" to explicitly separate: What's proven (90% tokens) | What's inferred (quality) | What we don't control (accuracy)
  - Added "can help" instead of "can improve" (more conservative)
  - Goal: Maximum honesty, clear separation of proven vs inferred, manage expectations
  - Updated: README.md (best case scenario, honest claim section)

- **Quality Claim Final Matization:**
  - Changed "Responses are faster and more focused on relevant context" to "Responses are often faster and more context-efficient"
  - Added qualifier "often" to acknowledge variability (not always)
  - Changed "focused" to "context-efficient" (more precise, describes mechanism)
  - Added explicit disclaimer: "Responses will NOT be 'more accurate' (accuracy depends on agent, not just context)"
  - Added honest claim: "We provide better context, which CAN improve response quality in complex tasks when the agent follows the workflow"
  - Separated proven (token savings 90%) from inferred (quality improvement)
  - Goal: Manage expectations, reduce risk of disappointment, align marketing with evidence
  - Updated: `README.md` (best case scenario wording, "What 'Better Context' Means" section)
  - New doc: `docs/agent-rules/quality-claim-final-matization.md` with evolution analysis and rationale

- **Base Rule Reduction (76% smaller):**
  - Reduced base rule from 42 lines to 10 lines (76% reduction in fixed context cost)
  - Moved all task-specific workflows to conditional profiles in `.cursor/rules/profiles-compact/`
  - Base rule now only shows: tool preference, smart_turn flow, reading cascade, pointer to profiles
  - Profiles (debugging, code-review, refactoring, testing, architecture) are conditionally applied based on file globs
  - Impact: Simple tasks see 10 lines instead of 42 lines; complex tasks see 50 lines (base + 1 profile) instead of 42 lines
  - Goal: Minimize fixed context cost, maximize coherence with token savings, improve agent learning
  - Updated: `.cursor/rules/devctx.mdc`, `AGENTS.md`, `CLAUDE.md`, `tools/devctx/agent-rules/base.md`, `tools/devctx/agent-rules/compact.md`, `tools/devctx/scripts/init-clients.js`
  - New doc: `docs/agent-rules/base-rule-reduction.md` with analysis and verification steps

### Added
- **Preflight Visibility (build_index Prominence):**
  - New preflight line in base rule: "First time in project? Run build_index to enable search/context quality."
  - New README section: "⚠️ Preflight: Build Index First" with clear without/with comparison
  - Updated workflow: Added Step 0 (build_index) before Step 1 (smart_turn)
  - Changed "Day 1" to "Getting Started" with emphasis on index being REQUIRED for quality
  - Without index: smart_search has no ranking, smart_context has no graph, quality degraded, agent prefers native tools
  - With index: ranked search, optimal context, 90% token savings enabled
  - Impact: Prevents most common setup failure, ensures quality from first use
  - Fixed context cost: +1 line (13 → 14 lines, still 66% smaller than original 42 lines)
  - Goal: Make index build impossible to miss, prevent quality degradation, maximize token savings
  - Updated: `.cursor/rules/devctx.mdc`, `tools/devctx/agent-rules/base.md`, `tools/devctx/agent-rules/compact.md`, `tools/devctx/scripts/init-clients.js`, `README.md`
  - New doc: `docs/agent-rules/preflight-visibility.md` with rationale, scenarios, and expected behavior

- **Feedback When devctx Not Used:**
  - New rule: Agent adds note when not using devctx tools in non-trivial programming tasks
  - Feedback format: "Note: devctx not used because: [reason]. To use devctx next time: [prompt]"
  - Allowed reasons (constrained): task too simple | MCP unavailable | index not built | already had sufficient context | native tool more direct
  - Forcing prompt: "Use smart-context-mcp: smart_turn(start) → smart_context/smart_search → smart_read → smart_turn(end)"
  - Impact: Makes non-usage visible, educates users, increases adoption, identifies setup issues
  - Fixed context cost: +3 lines (10 → 13 lines, still 68% smaller than original 42 lines)
  - Goal: Maximize adoption by making ignoring devctx rare, visible, and easy to correct
  - Updated: `.cursor/rules/devctx.mdc`, `tools/devctx/agent-rules/base.md`, `tools/devctx/agent-rules/compact.md`, `tools/devctx/scripts/init-clients.js`
  - New doc: `docs/agent-rules/feedback-when-not-used.md` with rationale, examples, and expected behavior

- **Security Rejection Examples:**
  - New test file: `tests/smart-shell-security.test.js` with 60+ security tests
  - New doc: `docs/security/rejection-examples.md` with 50+ concrete rejection examples
  - Added "Real Rejection Examples" section to SECURITY.md
  - Enhanced README security section with actual rejection responses
  - Test categories: shell operators, dangerous commands, git writes, package installs, find args, malformed commands
  - All blocked commands return exitCode 126, blocked: true, and human-readable rejection reason
  - Verification: `npm test -- tests/smart-shell-security.test.js` proves documented behavior
  - New doc: `docs/security-examples-analysis.md` with design rationale
  - Goal: Build trust through concrete examples, verifiable behavior, and transparency

- **Enhanced Compatibility Matrix:**
  - Added comprehensive 8-column matrix to README with "Near-Automatic" levels and key limitations
  - New columns: MCP, Rules, Hooks, `smart_turn`, Persistence, Near-Automatic, Key Limitations
  - Added "What Near-Automatic Means" explanation section
  - Added "What It Does NOT Mean" clarification (no prompt interception, no forced usage)
  - Added "Which Client Should I Use?" decision guide
  - Updated docs/client-compatibility.md to reference main README matrix
  - New doc: docs/compatibility-matrix-design.md with design rationale
  - Goal: Make client differences explicit, avoid ambiguity, facilitate adoption decisions

### Changed
- **Quality Claim Matization:**
  - Replaced "Responses are faster and more accurate" with "Responses are faster and more focused on relevant context"
  - Replaced "Improves search and context quality" with "Improves search ranking and context relevance"
  - Added "What 'Better Context' Means" clarification section in README
  - Rationale: "Accurate" is subjective and hard to measure; "focused on relevant context" is honest and verifiable
  - New doc: docs/quality-claim-analysis.md with critical analysis and recommendations
  - Goal: Avoid over-promising, align marketing with evidence, maintain credibility

- **Naming Clarity: "Persistent Task Context" vs "Total Conversation Context":**
  - Replaced "context persistence" with "persistent task context" throughout docs
  - Replaced "session context" with "task checkpoint" for precision
  - Replaced "context recovery" with "checkpoint recovery" or "task recovery"
  - Added explicit "What is NOT persisted" sections in all key docs
  - Clarified that checkpoints are ~100 tokens (goal, status, decisions, next step), not full transcripts
  - Updated package.json description to mention "task checkpoint persistence"
  - Updated README, tools/devctx/README, docs/how-it-works.md, docs/smart-turn-entry-point.md
  - Updated docs/client-compatibility.md table headers
  - Updated all agent rules (base.md, compact.md, core.md, profiles/*.md)
  - New doc: docs/persistent-task-context.md explaining conceptual distinction
  - Goal: Maximum conceptual clarity, avoid over-promising, honest about what gets stored

### Added
- **Workflow Metrics System:**
  - Track token savings for complete task workflows (debugging, review, refactor, testing, architecture)
  - Auto-detect workflow type from session goal and tools used
  - Calculate savings vs realistic baselines (150K-300K tokens per workflow type)
  - New `workflow_metrics` table in SQLite (migration v5)
  - New `npm run report:workflows` command with `--summary`, `--type`, `--session`, `--json` options
  - Opt-in via `DEVCTX_WORKFLOW_TRACKING=true` environment variable
  - Auto-tracking when agent uses `smart_turn(start)` and `smart_turn(end)`
  - Workflow summary by type with avg savings, duration, steps
  - Comprehensive docs/workflow-metrics.md with baselines, examples, and limitations
  - Example workflow tracking in docs/examples/workflow-tracking-example.md
  - Baselines: Debugging (150K), Code Review (200K), Refactoring (180K), Testing (120K), Architecture (300K)
  - Expected savings: 87-90% per workflow type, 98%+ vs baseline
  - 16 new tests for workflow detection and baseline calculation
- **Client Compatibility Matrix & Recommended Modes:**
  - Created comprehensive docs/client-compatibility.md
  - Compatibility matrix comparing all 4 clients
  - Recommended mode per client (Cursor, Claude Desktop, Codex, Qwen)
  - Feature comparison (rules, hooks, persistence, automaticity)
  - Quick start guides per client
  - Honest limitations per client
  - Troubleshooting per client
  - Migration guides between clients
  - Added summary table to README

### Changed
- **`smart_turn(start)` as Recommended Entry Point:**
  - Emphasized as optimal flow for non-trivial tasks
  - Added 5 complete workflow examples (debugging, review, refactor, testing, architecture)
  - Updated base rules to highlight `smart_turn` benefits
  - Updated all task profiles to start with `smart_turn(start)`
  - Created comprehensive docs/smart-turn-entry-point.md
  - Benefits: Task checkpoint recovery, state persistence, metrics tracking, repo safety
  - When to use: Debugging, review, refactor, testing, architecture
  - When to skip: Trivial tasks, one-off questions, simple reads
- **Two-Layer Agent Rules Architecture:**
  - Base rule ultra-short (~150 tokens, always active)
  - Task-specific profiles compact (~100-150 tokens, conditional)
  - Reduces fixed context cost by 75% (600 → 150 tokens)
  - Profiles: debugging, code-review, refactoring, testing, architecture
  - Cursor: `.cursor/rules/devctx.mdc` + `.cursor/rules/profiles-compact/*.mdc`
  - Codex/Qwen/Claude: Updated `AGENTS.md` and `CLAUDE.md` with base rules
  - Maintains compatibility with existing installations

### Added
- **Simplified Installation Experience:**
  - Direct, copy-paste installation blocks per client (Cursor, Codex, Claude, Qwen)
  - Clear "How it Works in Practice" section explaining real flow
  - Honest documentation about what MCP can/cannot do
  - `docs/how-it-works.md` - Complete step-by-step example with token breakdown
  - Realistic expectations (best/typical/worst case scenarios)
  - Troubleshooting guide for common issues
- **Agent Rules as Core Product Feature:**
  - Task-specific workflow profiles (debugging, code review, refactoring, testing, architecture)
  - Compact core rules auto-generated during installation
  - Detailed profile documentation in `tools/devctx/agent-rules/`
  - Design rationale document explaining rule philosophy
  - README for agent rules explaining structure and usage
- Agent rules now highlight **when** and **how** to use tools, not just what they do
- Token savings quantified per profile (87-90% reduction)

### Security
- Enhanced command validation with dangerous pattern detection (`rm -rf`, `sudo`, `curl|`, `eval`)
- Added `DEVCTX_SHELL_DISABLED` environment variable to disable shell execution
- Improved error messages showing allowed commands and subcommands
- Added 16 new security tests (435 total, 26 security-focused)
- Comprehensive security documentation:
  - `SECURITY.md` - Security policy and threat model
  - `docs/security/threat-model.md` - Attack surface analysis
  - `docs/security/configuration.md` - Hardening guide
  - `docs/security/risk-mitigation-summary.md` - Mitigation summary
- Graceful error handling in `smart_read` (returns `{ error }` instead of throwing)
- Error isolation in `smart_read_batch` (partial results on failure)
- Security sections added to both READMEs

### Changed
- Agent rules refactored from verbose to compact, workflow-oriented format
- Rules now organized by task type (debugging, review, refactor, test, architecture)
- `smart_read` now returns error objects instead of throwing exceptions
- `smart_read_batch` continues processing after individual file errors
- Command length limited to 500 characters
- `git blame` added to allowed git subcommands
- `eval` added to allowed npm script patterns
- Both READMEs updated to highlight agent rules as key differentiator

## [1.1.0] - 2026-03-29

### Added

- **Cache Warming**: Preload frequently accessed files into OS cache for 5x faster cold start
  - `warm_cache` tool with automatic frequency analysis
  - SQLite-based access tracking
  - Configurable via `DEVCTX_CACHE_WARMING` and `DEVCTX_WARM_FILES`
  - See [docs/features/cache-warming.md](./docs/features/cache-warming.md)

- **Symbol-Level Git Blame**: Function-level code attribution
  - `git_blame` tool with multiple modes (symbol, file, author, recent)
  - Primary author detection with contribution percentages
  - Multi-contributor tracking
  - See [docs/features/git-blame.md](./docs/features/git-blame.md)

- **Cross-Project Context**: Share context across monorepos and microservices
  - `cross_project` tool with search, read, symbol, and dependency modes
  - `.devctx-projects.json` configuration support
  - Cross-project dependency graph
  - See [docs/features/cross-project.md](./docs/features/cross-project.md)

- **Repository Metadata**: Updated all URLs to point to `Arrayo/smart-context-mcp`

- **Documentation**: Refactored README for clarity with Core vs Advanced tool separation

### Changed

- Incremented package version to 1.1.0
- Reorganized documentation into `/docs` structure

### Fixed

- All tests passing (421 tests)
- End-to-end feature verification working

## [1.0.4] - 2026-03-28

### Added

- **Streaming Progress Notifications**: Real-time updates for long-running operations
  - Progress reporting for indexing, cache warming, and batch operations
  - See [docs/features/streaming.md](./docs/features/streaming.md)

- **Diff-Aware Context**: Intelligent git change analysis
  - Analyze diffs vs HEAD, branches, or tags
  - Prioritize changes by impact (high/medium/low)
  - Expand context with related files (tests, importers, dependencies)
  - Symbol-level change detection
  - See [docs/features/diff-aware.md](./docs/features/diff-aware.md)

- **Context Prediction**: Learn from usage patterns and predict needed files
  - Jaccard similarity-based pattern matching
  - Automatic file prediction after 3+ similar tasks
  - 40-60% fewer round-trips, 15-20% additional token savings
  - See [docs/features/context-prediction.md](./docs/features/context-prediction.md)

### Changed

- SQLite schema version updated to 4 (added `context_access` table)
- Improved test coverage and CI pipeline compatibility

## [1.0.3] - 2026-03-27

### Added

- Session management with `smart_summary`
- Turn orchestration with `smart_turn`
- Batch file reading with `smart_read_batch`

### Changed

- Migrated from JSONL to SQLite for state management (Node 22+)
- Improved metrics tracking and reporting

## [1.0.2] - 2026-03-26

### Added

- Symbol index with `build_index`
- Graph-based context expansion
- Intent-aware search ranking

### Changed

- Enhanced `smart_context` with graph relationships
- Improved parser support for multiple languages

## [1.0.1] - 2026-03-25

### Added

- `smart_shell` for safe command execution
- `smart_metrics` for usage inspection

### Fixed

- Various bug fixes and performance improvements

## [1.0.0] - 2026-03-24

### Added

- Initial release with core tools:
  - `smart_read`: Compressed file reading
  - `smart_search`: Intent-aware code search
  - `smart_context`: One-call context builder
- Multi-client support (Cursor, Codex, Claude Code, Qwen)
- Automatic client configuration generation
- Real-time metrics tracking

---

For detailed changes per feature, see:
- [Diff-Aware Context](./docs/changelog/diff-aware.md)
- [Cache Warming](./docs/changelog/cache-warming.md)
- [Git Blame](./docs/changelog/git-blame.md)
- [Cross-Project Context](./docs/changelog/cross-project.md)
