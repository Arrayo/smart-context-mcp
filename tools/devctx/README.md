# smart-context-mcp

MCP server that reduces AI agent token usage by up to 90% with intelligent context compression (measured on this project).

[![npm version](https://img.shields.io/npm/v/smart-context-mcp.svg)](https://www.npmjs.com/package/smart-context-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

### Cursor
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients cursor
```
Restart Cursor. Done.

Optional assisted mode for long tasks:
```bash
./.devctx/bin/cursor-devctx task --prompt "your task" -- <agent-command> [args...]
./.devctx/bin/cursor-devctx implement --prompt "implement the auth guard" -- <agent-command> [args...]
./.devctx/bin/cursor-devctx review --prompt "review the latest diff" -- <agent-command> [args...]
./.devctx/bin/cursor-devctx doctor
```

### Codex CLI
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients codex
```
Restart Codex. Done.

### Claude Desktop
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients claude
```
Restart Claude Desktop. Done.

### Qwen Code
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients qwen
```
Restart Qwen Code. Done.

### All Clients
```bash
npm install -g smart-context-mcp
npx smart-context-init --target .
```
Restart your AI client. Done.

### Verify Installation

```bash
# Check installed version
npm list -g smart-context-mcp

# Should show: smart-context-mcp@1.20.0 (or later)

# Update to latest version
npm update -g smart-context-mcp

# Or reinstall from scratch
npm uninstall -g smart-context-mcp
npm install -g smart-context-mcp
```

**After updating:** The binary is updated globally, but agent rules (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`) in each project are generated from the installed version and are **not updated automatically**.

Re-run init after each update to get the latest rules:

```bash
# Re-apply rules to a project after updating
npx smart-context-init --target /path/to/your/project --clients cursor
# or for all clients
npx smart-context-init --target /path/to/your/project --clients all
```

Then restart your AI client to load the new version.

---

## Task Runner

`smart-context-task` is a workflow-oriented CLI on top of the raw MCP tools.

Use it when you want a more repeatable path than “agent reads rules and hopefully picks the right flow”.

```bash
smart-context-task task --prompt "inspect the auth flow and continue the bugfix"
smart-context-task implement --prompt "add a token guard to loginHandler"
smart-context-task continue --session-id my-session-id
smart-context-task review --prompt "review the latest diff"
smart-context-task doctor
```

The runner now covers:

- `task`
- `implement`
- `continue`
- `resume`
- `review`
- `debug`
- `refactor`
- `test`
- `doctor`
- `status`
- `checkpoint`
- `cleanup`

For Cursor projects, `smart-context-init` also generates `./.devctx/bin/cursor-devctx`, which routes through the same runner/policy stack.

See [Task Runner Workflows](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/task-runner.md) for the full behavior and command guidance.

---

## When to Use (and When Not To)

**Use devctx when:**
- You're exploring an unfamiliar codebase
- The task spans multiple sessions (checkpoints save context)
- You need to understand how files relate to each other (graph/imports)
- The context is too large to manage manually
- You're doing complex multi-file refactors or debugging across layers

**Skip devctx when:**
- You already know exactly which files to touch
- It's a single-file or surgical change (2-3 edits max)
- You have the full mental map from a recent exploration
- Native tools (Grep, Read, StrReplace) are more direct for the task

**Honest verdict from real users:**

> "The MCP shines in long, multi-session tasks or when you don't know the codebase. For contained refactors where you already know what to touch, native tools are just as fast or faster. The real value was `smart_read(outline)` for the initial analysis and checkpoints to not lose the thread between sessions."

The 90% token savings are real, but they require the right task type to materialize.

---

## 📊 Real Metrics

**Production use on this project:**
- ~7M tokens → ~800K tokens (approximately 89% reduction)
- 1,500+ operations tracked
- Compression ratios: 3x to 46x

**Workflow savings:**
- Debugging: ~85-90% reduction
- Code Review: ~85-90% reduction
- Refactoring: ~85-90% reduction
- Testing: ~85-90% reduction
- Architecture: ~85-90% reduction

**Real adoption:**
- Approximately 70-75% of complex tasks use devctx
- Top tools: `smart_read` (850+), `smart_search` (280+), `smart_shell` (220+)
- Non-usage: task too simple, no index built, native tools preferred

---

## 🚀 How to Invoke the MCP

The MCP doesn't intercept prompts automatically. **You need to tell the agent to use it.**

### Option 1: Use MCP Prompts (Easiest)

In Cursor, type in the chat:

```
/prompt use-devctx

[Your task here]
```

**Available prompts:**
- `/prompt use-devctx` - Force devctx tools for current task
- `/prompt devctx-workflow` - Full workflow (start → context → work → end)
- `/prompt devctx-preflight` - Preflight only (build_index + smart_turn start)

### Option 2: Explicit Instruction

Just tell the agent directly:

```
Use smart_turn(start) to recover context, then [your task]
```

Or:

```
Use the MCP to review this code
```

### Option 3: Automatic (via Rules)

The agent *should* use devctx automatically for complex tasks because:
- ✅ `.cursorrules` is active in Cursor
- ✅ `CLAUDE.md` is active in Claude Desktop (if you created it)
- ✅ `AGENTS.md` is active in other clients (if you created it)

**But it's not guaranteed** - the agent decides based on task complexity.

### ⚡ Quick Reference

| Scenario | Command |
|----------|---------|
| Start new task | `/prompt devctx-workflow` |
| Continue previous task | `smart_turn(start) and continue` |
| Force MCP usage | `/prompt use-devctx` |
| First time in project | `/prompt devctx-preflight` |
| Trust automatic rules | Just describe your task normally |

---

## 🚨 Agent Ignored devctx? → Paste This Next

<table>
<tr>
<td width="100%" bgcolor="#FFF3CD">

### 📋 Official Prompt (Copy & Paste)

```
Use smart-context-mcp for this task.
Start with smart_turn(start), then use smart_context or smart_search before reading full files.
End with smart_turn(end) if you make progress.
```

### ⚡ Ultra-Short

```
Use devctx: smart_turn(start) → smart_context → smart_turn(end)
```

</td>
</tr>
</table>

**When:** Agent read large files with `Read`, used `Grep` repeatedly, or no devctx tools in complex task.

**Why:** Task seemed simple, no index built, native tools appeared more direct, or rules weren't strong enough.

---

## How it Works in Practice

**The reality:** This MCP does not intercept prompts automatically. Here's the actual flow:

1. **You:** "Fix the login bug"
2. **Agent reads rules:** Sees debugging workflow
3. **Agent decides:** Uses `smart_search(intent=debug)`
4. **MCP returns:** Ranked results (errors prioritized)
5. **Agent continues:** Calls `smart_read(symbol)` for function
6. **Agent fixes:** Makes changes
7. **Agent verifies:** Calls `smart_shell('npm test')`
8. **Agent checkpoints:** Calls `smart_turn(end)`

**Key points:**
- ✅ Agent **chooses** to use devctx tools (not forced)
- ✅ Rules **guide** the agent (not enforce)
- ✅ Agent can use built-in tools when appropriate
- ✅ Token savings: 85-90% on complex tasks
- ✅ Reports can show both gross savings and net savings after context overhead
- ✅ Workflow JSON/reporting now exposes net-metrics coverage, so historical rows without persisted overhead are explicit
- ✅ `smart_metrics` now exposes measured orchestration-quality signals from `smart_turn` (continuity recovery, blocked-state remediation coverage, context-refresh signals)
- ✅ If `.devctx/state.sqlite` is tracked or staged, runtime SQLite mutations pause across checkpoints, workflow tracking, hook state, and pattern learning

Check actual usage:
- **Real-time feedback** - Enabled by default (disable with `export DEVCTX_SHOW_USAGE=false`)
- `npm run report:metrics` - Tool-level savings + adoption analysis
- `npm run report:workflows` - Workflow-level savings (requires `DEVCTX_WORKFLOW_TRACKING=true`)
- `npm run benchmark:orchestration` - Repeatable orchestration regression suite for continuity, refresh, blocked-state remediation, and checkpoint quality
- `npm run benchmark:orchestration:release` - Same suite with a checked-in release baseline, used by CI and `prepublishOnly`

## What it does

Provides **two key components**:

### 1. Specialized Tools (20 tools)

| Tool | Purpose | Savings |
|------|---------|---------|
| `smart_read` | Read files in outline / signatures / symbol / explain mode | 90% |
| `smart_read_batch` | Read multiple files in one call | 90% |
| `smart_search` | Intent-aware code search with ranking and `kinds` filter (incl. ADRs) | 95% |
| `smart_context` | One-call context builder; `paths: { from, to }` mode traverses the import graph | 85% |
| `smart_shell` | Safe command execution (TAP / git-log / diff compression) | 94% |
| `smart_test` | Affected tests via graph + sandboxed runner + persisted `last_failure` | - |
| `smart_review` | One-call review preflight: diff + callers + tests + heuristic findings | - |
| `build_index` | Symbol index builder (incremental) | - |
| `warm_cache` | File preloading (5x faster cold start) | - |
| `git_blame` | Function-level code attribution | - |
| `cross_project` | Multi-project context | - |
| `smart_summary` | Task checkpoint management with rolling window | 98% |
| `smart_status` | Quick session / project state inspection | - |
| `smart_doctor` | Health checks for storage, index, hooks | - |
| `smart_edit` | Targeted symbol-aware edits | - |
| `smart_turn` | Turn boundary + `nextActions[]` machine-readable plan | - |
| `smart_resume` | Lightweight alias for `smart_turn(phase: 'start', verbosity: 'minimal')` | - |
| `smart_metrics` | Token usage inspection | - |
| `smart_playbook` | Declarative workflows: composes `smart_*` tools in one call (preflight-merge, debug-flake, refactor-safe, doc-sync, ramp-up) | - |
| `global_memory` | Cross-project memory in `~/.devctx/global.db` (opt-in, scrubbed for secrets, semantic recall) | - |

### 2. Agent Rules (Task-Specific Guidance)

Installation generates rules that teach agents optimal workflows:

**Debugging:** `smart_search(intent=debug)` → `smart_read(symbol)` → fix (90% savings)  
**Code Review:** `smart_context(diff=true)` → `smart_read(signatures)` → review (87% savings)  
**Refactoring:** `smart_context(entryFile)` → `smart_read(signatures)` → refactor (89% savings)  
**Testing:** `smart_search(intent=tests)` → `smart_read(symbol)` → write test (90% savings)  
**Architecture:** `smart_context(detail=minimal)` → `smart_read(signatures)` → analyze (90% savings)

**Key insight:** The value isn't just in the tools—it's in teaching agents **when** and **how** to use them.

## Real Metrics

Production usage: **14.5M tokens → 1.6M tokens** (89.87% reduction)

## Verify It's Working

### Real-Time Feedback (Enabled by Default)

Feedback is **enabled by default** and shows after every devctx tool call.

**To disable:**
```bash
export DEVCTX_SHOW_USAGE=false
```

You'll see at the end of agent responses:

```markdown
---

📊 **devctx usage this session:**
- **smart_read**: 3 calls | ~45.0K tokens saved (file1.js, file2.js, file3.js)
- **smart_search**: 1 call | ~12.0K tokens saved (query)

**Total saved:** ~57.0K tokens

*To disable this message: `export DEVCTX_SHOW_USAGE=false`*
```

**Why this is useful:**
- ✅ Verify agent is following rules
- ✅ See token savings in real-time
- ✅ Debug adoption issues instantly
- ✅ Validate forcing prompts worked

### Historical Metrics

```bash
npm run report:metrics
```

Shows adoption analysis + token savings over time.

### Decision Explanations (Optional)

Understand **why** the agent chose devctx tools:

```bash
export DEVCTX_EXPLAIN=true
```

You'll see explanations like:

```markdown
🤖 **Decision explanations:**

**smart_read** (read server.js (outline mode))
- **Why:** File is large (2500 lines), outline mode extracts structure only
- **Instead of:** Read (full file)
- **Expected benefit:** ~45.0K tokens saved

**smart_search** (search "bug" (intent: debug))
- **Why:** Intent-aware search prioritizes relevant results
- **Expected benefit:** Better result ranking
```

**When to use:**
- Learning how devctx works
- Debugging tool selection
- Understanding best practices

### Missed Opportunities Detection (Optional)

Detect when devctx **should have been used but wasn't**:

```bash
export DEVCTX_DETECT_MISSED=true
```

You'll see warnings like:

```markdown
⚠️ **Missed devctx opportunities detected:**

**Session stats:**
- devctx operations: 2
- Estimated total: 25
- Adoption: 8%

🟡 **low devctx adoption**
- **Issue:** Low adoption (8%). Target: >50%
- **Potential savings:** ~184.0K tokens
```

**Detects:**
- No devctx usage in long sessions
- Low adoption (<30%)
- Usage dropped mid-session

**All features enabled by default.** To disable:

```bash
export DEVCTX_SHOW_USAGE=false
export DEVCTX_EXPLAIN=false
export DEVCTX_DETECT_MISSED=false
```

## MCP Prompts

The MCP server provides **prompts** for automatic forcing:

```
/prompt use-devctx
```

**Available prompts:**
- `use-devctx` - Ultra-short forcing prompt
- `devctx-workflow` - Complete workflow template
- `devctx-preflight` - Preflight checklist

**Benefits:**
- No manual typing
- Centrally managed
- No typos

See [MCP Prompts Documentation](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/mcp-prompts.md).

## Core Tools

### smart_read

Read files without full content:

```javascript
// Outline mode: structure only (~400 tokens vs 4000)
{ filePath: 'src/server.js', mode: 'outline' }

// Extract specific function
{ filePath: 'src/auth.js', mode: 'symbol', symbol: 'validateToken' }
```

**Modes**: `outline`, `signatures`, `symbol`, `range`, `full`

### smart_search

Intent-aware search with ranking:

```javascript
{ query: 'authentication', intent: 'debug' }  // Prioritizes errors, logs
{ query: 'UserModel', intent: 'implementation' }  // Prioritizes source
```

**Intents**: `implementation`, `debug`, `tests`, `config`, `docs`, `explore`

### smart_context

Get everything for a task in one call:

```javascript
{
  task: 'Fix authentication bug',
  detail: 'balanced',  // minimal | balanced | deep
  maxTokens: 8000
}
```

Returns: relevant files + compressed content + symbol details + graph relationships

**Smart pattern detection:** Automatically detects literal patterns (TODO, FIXME, /**, console.log, debugger) and prioritizes them in search.

### smart_summary

Maintain task checkpoint:

```javascript
// Save checkpoint (flat API - recommended)
{ action: 'update', goal: 'Implement OAuth', status: 'in_progress', nextStep: '...' }

// Or nested format (backward compatible)
{ action: 'update', update: { goal: 'Implement OAuth', status: 'in_progress', nextStep: '...' }}

// Resume task
{ action: 'get' }
```

Stores compressed task state (~100 tokens: goal, status, decisions, blockers), not full conversation. Supports both flat and nested parameter formats.
When git hygiene or SQLite storage health affects persisted state, responses expose `mutationSafety`, `repoSafety`, `degradedMode`, and `storageHealth` so clients can remediate consistently.

### smart_doctor

Run a single operational health check across repo hygiene, SQLite state, compaction hygiene, and legacy cleanup:

```javascript
smart_doctor({})
smart_doctor({ verifyIntegrity: false })
```

CLI:

```bash
smart-context-doctor --json
smart-context-doctor --no-integrity
```

### smart_status

Display current session context:

```javascript
{ format: 'detailed' }  // Full output with progress stats
{ format: 'compact' }   // Minimal JSON
```

Shows goal, status, recent decisions, touched files, and progress. Updates automatically with each MCP operation.
When repo safety or SQLite health blocks normal state access, `smart_status` still exposes the same safety contract plus `storageHealth`.

### SQLite Recovery

If `.devctx/state.sqlite` is unhealthy, use the surfaced `storageHealth.issue`:

- `missing`: initialize local state with a persisted action
- `oversized`: run `smart_summary compact`
- `locked`: stop competing devctx writers, then retry
- `corrupted`: back up and remove the file so devctx can recreate it
- broader inspection: run `smart_doctor` / `smart-context-doctor`

### smart_edit

Batch edit multiple files:

```javascript
{
  pattern: 'console.log',
  replacement: 'logger.info',
  files: ['src/a.js', 'src/b.js'],
  mode: 'literal'  // or 'regex'
}
```

Use `dryRun: true` for preview. Max 50 files per call.

## New Features

### Diff-Aware Context

Analyze git changes intelligently:

```javascript
{ task: 'Review changes', diff: 'main' }
```

Returns changed files prioritized by impact + related files (importers, tests).

### Context Prediction

Learn from usage and predict needed files:

```javascript
{ task: 'Implement auth', prefetch: true }
```

After 3+ similar tasks: 40-60% fewer round-trips, 15-20% additional savings.

### Cache Warming

Eliminate cold-start latency:

```javascript
{ incremental: true, warmCache: true }
```

First query: 250ms → 50ms (5x faster).

### Git Blame

Function-level attribution:

```javascript
// Who wrote each function?
{ mode: 'symbol', filePath: 'src/server.js' }

// Find code by author
{ mode: 'author', authorQuery: 'alice@example.com' }

// Recent changes
{ mode: 'recent', daysBack: 7 }
```

### Cross-Project Context

Work across monorepos:

```javascript
// Search all projects
{ mode: 'search', query: 'AuthService' }

// Find symbol across projects
{ mode: 'symbol', symbolName: 'validateToken' }
```

Requires `.devctx-projects.json` config.

## Supported Languages

**AST parsing**: JavaScript, TypeScript, JSX, TSX

**Heuristic**: Python, Go, Rust, Java, C#, Kotlin, PHP, Swift

**Structural**: Shell, Terraform, HCL, Dockerfile, SQL, JSON, YAML, TOML

## Client Support

- Cursor (`.cursor/mcp.json`)
- Codex CLI (`.codex/config.toml`)
- Claude Code (`.mcp.json` + `.claude/settings.json`)
- Qwen Code (`.qwen/settings.json`)

## Commands

```bash
# Start server
smart-context-server

# Against another repo
smart-context-server --project-root /path/to/repo

# Generate configs
smart-context-init --target /path/to/project

# View metrics
smart-context-report

# Verify features
npm run verify
```

## Storage

Data stored in `.devctx/`:
- `index.json` - Symbol index (`INDEX_VERSION 7`: ADR + ADR sections, richer Python/Go)
- `state.sqlite` - Sessions, metrics, patterns, task handoffs, test failures, explain cache (Node 22+)
- `metrics.jsonl` - Opt-in legacy file, only when `DEVCTX_METRICS_FILE=path.jsonl` is set

Cross-project (opt-in via `DEVCTX_GLOBAL_MEMORY=true`):
- `~/.devctx/global.db` - Scrubbed decisions, patterns, playbooks, notes with semantic recall

Add to `.gitignore`:
```
.devctx/
```

## Requirements

- Node.js 18+ (22+ for SQLite features)
- Git (for diff and blame features)

## Security

This MCP is **secure by default**:

- ✅ **Allowlist-only commands** - Only safe diagnostic commands (`ls`, `git status`, `npm test`, etc.)
- ✅ **No shell operators** - Blocks `|`, `&`, `;`, `>`, `<`, `` ` ``, `$()`
- ✅ **Path validation** - Cannot escape project root
- ✅ **No write access** - Cannot modify your code
- ✅ **Repository safety** - Prevents accidental commit of local state
- ✅ **Resource limits** - 15s timeout, 10MB buffer

**Configuration:**

```bash
# Disable shell execution entirely
export DEVCTX_SHELL_DISABLED=true

# Disable cache warming
export DEVCTX_CACHE_WARMING=false
```

See [SECURITY.md](https://github.com/Arrayo/smart-context-mcp/blob/main/SECURITY.md) for complete security documentation.

## Documentation

Full documentation in [GitHub repository](https://github.com/Arrayo/smart-context-mcp):

- [Streaming Progress](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/features/streaming.md) - Progress notifications
- [Context Prediction](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/features/context-prediction.md) - File prediction
- [Diff-Aware Context](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/features/diff-aware.md) - Change analysis
- [Cache Warming](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/features/cache-warming.md) - Cold-start optimization
- [Git Blame](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/features/git-blame.md) - Code attribution
- [Cross-Project Context](https://github.com/Arrayo/smart-context-mcp/blob/main/docs/features/cross-project.md) - Multi-project support

## Links

- [GitHub](https://github.com/Arrayo/smart-context-mcp)
- [npm](https://www.npmjs.com/package/smart-context-mcp)
- [Issues](https://github.com/Arrayo/smart-context-mcp/issues)

## Author

**Francisco Caballero Portero**  
fcp1978@hotmail.com  
[@Arrayo](https://github.com/Arrayo)

## License

MIT
