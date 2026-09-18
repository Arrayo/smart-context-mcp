# Client Compatibility & Recommended Modes

> **Quick Overview:** See the [Compatibility Matrix](../README.md#client-compatibility) in the main README for a comprehensive comparison table with limitations and decision guidance.

This document provides detailed information about each client's capabilities, installation, and recommended workflows.

If you want the workflow layer, read [Task Runner Workflows](./task-runner.md) alongside this document.

---

## Compatibility Matrix (Detailed)

| Feature | Cursor | Claude Desktop | Codex CLI | Qwen Code |
|---------|--------|----------------|-----------|-----------|
| **MCP Support** | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **Agent Rules** | ✅ `.cursor/rules/*.mdc` | ✅ `CLAUDE.md` | ✅ `AGENTS.md` | ✅ `AGENTS.md` |
| **Conditional Rules** | ✅ Globs + context | ❌ No | ❌ No | ❌ No |
| **Native Hooks** | ❌ No | ✅ SessionStart, PostToolUse, Stop | ❌ No | ❌ No |
| **Task Checkpoints** | ✅ `smart_turn` | ✅ `smart_turn` + hooks | ✅ `smart_turn` | ✅ `smart_turn` |
| **Task Runner / Assisted Path** | ✅ `cursor-devctx` | ⚠️ Manual `smart-context-task` | ✅ `smart-context-task` | ✅ `smart-context-task` |
| **Auto smart_turn** | ❌ Agent decides | ⚠️ Via hooks (opt-in) | ❌ Agent decides | ❌ Agent decides |
| **Blocked-State Remediation** | ✅ Guided via rules | ✅ Guided via hooks + rules | ✅ Guided via `AGENTS.md` | ✅ Guided via `AGENTS.md` |
| **Node 22+ (SQLite)** | ✅ Recommended | ✅ Recommended | ✅ Recommended | ✅ Recommended |
| **Node 18-20 Fallback** | ⚠️ Metrics only | ⚠️ Metrics only | ⚠️ Metrics only | ⚠️ Metrics only |

**Legend:**
- ✅ Full support
- ⚠️ Partial support or fallback
- ❌ Not supported

**For a more comprehensive matrix with "Near-Automatic" levels and key limitations, see the [main README](../README.md#client-compatibility).**

---

## Recommended Mode by Client

### Cursor

**Best for:** Complex tasks with conditional workflows

**Recommended flow:**
```
1. smart_turn(start, userPrompt, ensureSession=true)
2. smart_context(...) or smart_search(intent=...)
3. smart_read(mode=outline|signatures|symbol)
4. [work]
5. smart_shell('npm test')
6. smart_turn(end, event=milestone)
```

**Why Cursor is optimal:**
- ✅ Conditional rules (debugging.mdc, code-review.mdc, etc.)
- ✅ Agent sees base rule + profile when relevant
- ✅ Low fixed context cost (150 tokens base + 120 tokens profile when needed)
- ✅ Full `smart_turn` support for session persistence
- ✅ Generated rules now surface `mutationSafety` / `recommendedActions`

**Installation:**
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients cursor
```

**Files created:**
- `.cursor/mcp.json` - MCP server config
- `.cursor/rules/devctx.mdc` - Base rule (always active)
- `.cursor/rules/profiles-compact/*.mdc` - Task profiles (conditional)
- `.devctx/bin/cursor-devctx` - Optional assisted task-runner launcher using the shared wrapper/policy stack
- `.git/hooks/pre-commit` - Safety hook
- `.gitignore` - Adds `.devctx/`

**Restart Cursor. Tools appear in Agent mode.**

**Automaticity level:** Medium by default, Medium-High with assisted launcher
- Agent reads rules automatically
- Agent decides when to use devctx tools
- Conditional profiles activate based on file globs
- `smart_turn` requires agent to call it (not automatic)
- Blocked-state remediation is still guided, not enforced
- `./.devctx/bin/cursor-devctx` provides an assisted path for long tasks using the same shared start/end wrapper contract and task-runner policy as terminal clients
- The assisted launcher supports `task`, `implement`, `continue`, `resume`, `review`, `debug`, `refactor`, `test`, `doctor`, `status`, `checkpoint`, and `cleanup`

**Best practices:**
- Use Agent mode (not Ask mode)
- Let agent follow workflows naturally
- For long multi-step tasks, prefer `./.devctx/bin/cursor-devctx task --prompt "..." -- <agent-command>`
- For implementation-heavy work, prefer `./.devctx/bin/cursor-devctx implement --prompt "..." -- <agent-command>`
- For resumable work, prefer `./.devctx/bin/cursor-devctx continue --session-id <id> -- <agent-command>`
- For specialized workflows, use subcommands like `review`, `debug`, `refactor`, `test`, `doctor`, `status`, `checkpoint`, or `cleanup`
- Check metrics: `npm run report:metrics`
- Verify profiles activate: Check `.cursor/rules/profiles-compact/`

---

### Claude Desktop

**Best for:** Session-aware workflows with hooks

**Recommended flow:**
```
1. smart_turn(start, userPrompt, ensureSession=true)
   → Can be triggered via SessionStart hook (opt-in)
2. smart_context(...) or smart_search(intent=...)
3. smart_read(mode=outline|signatures|symbol)
4. [work]
5. smart_shell('npm test')
6. smart_turn(end, event=milestone)
   → Can be triggered via PostToolUse hook (opt-in)
```

**Why Claude Desktop is powerful:**
- ✅ Native hooks (SessionStart, PostToolUse, Stop)
- ✅ Can auto-trigger `smart_turn(start)` on session start
- ✅ Can auto-checkpoint after significant tool use
- ✅ Full `smart_turn` support for session persistence
- ✅ Agent rules in `CLAUDE.md`
- ✅ Hooks and rules can surface `mutationSafety.recommendedActions`

**Installation:**
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients claude
```

**Files created:**
- `.mcp.json` - MCP server config
- `.claude/settings.json` - Hook config
- `CLAUDE.md` - Agent rules
- `.git/hooks/pre-commit` - Safety hook
- `.gitignore` - Adds `.devctx/`

**Restart Claude Desktop.**

**Automaticity level:** High (with hooks)
- Agent reads `CLAUDE.md` rules
- Hooks can auto-trigger `smart_turn(start)` on SessionStart
- Hooks can auto-checkpoint on PostToolUse
- Closest to "automatic" behavior (but still opt-in)

**Hook configuration:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node ./scripts/claude-hook.js --event SessionStart"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|mcp__.*__smart_turn|mcp__.*__smart_summary",
        "hooks": [
          {
            "type": "command",
            "command": "node ./scripts/claude-hook.js --event PostToolUse"
          }
        ]
      }
    ]
  }
}
```

**What hooks do:**
- `SessionStart`: Can call `smart_turn(start)` automatically
- `PostToolUse`: Can call `smart_turn(end)` after significant edits
- `Stop`: Can finalize session

**Important:** Hooks are **opt-in**. They don't force behavior, they **suggest** it.

**Best practices:**
- Enable hooks for session-aware workflows
- Use `smart_turn` for multi-step tasks
- Check session history: `sqlite3 .devctx/state.sqlite "SELECT * FROM sessions"`
- Verify hooks: Check `.claude/settings.json`

---

### Codex CLI

**Best for:** Lightweight, rule-guided workflows

**Recommended flow:**
```
1. smart_turn(start, userPrompt, ensureSession=true)
   → Agent decides when to use (no hooks)
2. smart_search(intent=...) or smart_read(mode=...)
   → Prefer compressed modes
3. [work]
4. smart_shell('npm test')
5. smart_turn(end, event=milestone)
```

**Why Codex is practical:**
- ✅ Full MCP support
- ✅ Agent rules in `AGENTS.md`
- ✅ `smart_turn` support for session persistence
- ✅ Generated rules surface `mutationSafety`, `blockedBy`, and `recommendedActions`
- ✅ Global `smart-context-task` CLI provides an assisted path when rules alone are not enough
- ✅ Lightweight (no conditional rules, no hooks)
- ✅ Fast startup

**Installation:**
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients codex
```

**Files created:**
- `.codex/config.toml` - MCP server config
- `AGENTS.md` - Agent rules
- `.git/hooks/pre-commit` - Safety hook
- `.gitignore` - Adds `.devctx/`

**Restart Codex.**

**Automaticity level:** Low-Medium
- Agent reads `AGENTS.md` rules
- Agent decides when to use devctx tools
- No conditional rules (all rules always visible)
- No hooks (agent must call `smart_turn` manually)
- Generated rules now tell the agent how to react to blocked persistence/remediation states

**Best practices:**
- Use for medium-sized tasks
- Prefer `smart_read` and `smart_search` for quick operations
- Use `smart_turn` for multi-step tasks
- For repeatable non-trivial flows, prefer `smart-context-task task|implement|continue|review|debug`
- Check metrics: `npm run report:metrics`

**Limitations:**
- No conditional rules (all rules always active)
- No hooks (can't auto-trigger `smart_turn`)
- Agent must still decide to use `smart_turn` based on rules

---

### Qwen Code

**Best for:** Lightweight, rule-guided workflows

**Recommended flow:**
```
1. smart_turn(start, userPrompt, ensureSession=true)
   → Agent decides when to use (no hooks)
2. smart_search(intent=...) or smart_read(mode=...)
   → Prefer compressed modes
3. [work]
4. smart_shell('npm test')
5. smart_turn(end, event=milestone)
```

**Why Qwen is practical:**
- ✅ Full MCP support
- ✅ Agent rules in `AGENTS.md`
- ✅ `smart_turn` support for session persistence
- ✅ Generated rules surface `mutationSafety`, `blockedBy`, and `recommendedActions`
- ✅ Global `smart-context-task` CLI provides an assisted path when rules alone are not enough
- ✅ Lightweight (no conditional rules, no hooks)
- ✅ Fast startup

**Installation:**
```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients qwen
```

**Files created:**
- `.qwen/settings.json` - MCP server config
- `AGENTS.md` - Agent rules
- `.git/hooks/pre-commit` - Safety hook
- `.gitignore` - Adds `.devctx/`

**Restart Qwen Code.**

**Automaticity level:** Low-Medium
- Agent reads `AGENTS.md` rules
- Agent decides when to use devctx tools
- No conditional rules (all rules always visible)
- No hooks (agent must call `smart_turn` manually)
- Generated rules now tell the agent how to react to blocked persistence/remediation states

**Best practices:**
- Use for medium-sized tasks
- Prefer `smart_read` and `smart_search` for quick operations
- Use `smart_turn` for multi-step tasks
- For repeatable non-trivial flows, prefer `smart-context-task task|implement|continue|review|debug`
- Check metrics: `npm run report:metrics`

**Limitations:**
- No conditional rules (all rules always active)
- No hooks (can't auto-trigger `smart_turn`)
- Agent must still decide to use `smart_turn` based on rules

---

## Feature Comparison

### Agent Rules

| Client | Rule File | Type | Fixed Cost | Conditional |
|--------|-----------|------|------------|-------------|
| Cursor | `.cursor/rules/devctx.mdc` | Base (always) | ~150 tokens | ✅ Yes |
| Cursor | `.cursor/rules/profiles-compact/*.mdc` | Profiles (globs) | ~120 tokens (when active) | ✅ Yes |
| Claude Desktop | `CLAUDE.md` | Embedded | ~200 tokens | ❌ No |
| Codex CLI | `AGENTS.md` | Embedded | ~200 tokens | ❌ No |
| Qwen Code | `AGENTS.md` | Embedded | ~200 tokens | ❌ No |

**Key insight:** Cursor has the lowest fixed context cost (150 tokens) with conditional profiles.

---

### Task Checkpoint Persistence

| Client | `smart_turn` Support | Auto-trigger | Checkpoint Recovery | Hooks |
|--------|---------------------|--------------|---------------------|-------|
| Cursor | ✅ Full | ❌ Agent decides | ✅ Manual | ❌ No |
| Claude Desktop | ✅ Full | ⚠️ Via hooks (opt-in) | ✅ Manual + hooks | ✅ Yes |
| Codex CLI | ✅ Full | ❌ Agent decides | ✅ Manual | ❌ No |
| Qwen Code | ✅ Full | ❌ Agent decides | ✅ Manual | ❌ No |

**What gets persisted:**
- Task goal, status, decisions, blockers, next step (~100 tokens compressed)
- File access patterns for prediction
- Token metrics per tool call

**What does NOT get persisted:**
- Full conversation transcript
- Complete message history
- User prompts verbatim

**Key insight:** Claude Desktop can auto-trigger `smart_turn` via hooks (closest to automatic).

### Blocked-State Remediation

| Client | `mutationSafety` surfacing | `recommendedActions` guidance | Enforcement |
|--------|----------------------------|-------------------------------|-------------|
| Cursor | ✅ Via generated rules | ✅ Via generated rules | ❌ Agent-mediated |
| Claude Desktop | ✅ Via hooks + `CLAUDE.md` | ✅ Via hooks + `CLAUDE.md` | ❌ Agent-mediated |
| Codex CLI | ✅ Via `AGENTS.md` | ✅ Via `AGENTS.md` | ❌ Agent-mediated |
| Qwen Code | ✅ Via `AGENTS.md` | ✅ Via `AGENTS.md` | ❌ Agent-mediated |

**What the generated guidance now standardizes:**
- start non-trivial tasks with `smart_turn(start, userPrompt, ensureSession=true)`
- treat `mutationSafety.blocked` as a stop signal for write-heavy work
- surface `blockedBy` and follow `recommendedActions`
- use `workflow` / continuity fields as the current task state
- prefer the task runner or assisted launcher when the client cannot guarantee the full lifecycle by rules alone

**Key insight:** client integration is now more consistent, but still guidance-driven outside Claude hooks.

---

### Node Version Requirements

| Client | Node 22+ (SQLite) | Node 18-20 (Fallback) |
|--------|-------------------|----------------------|
| Cursor | ✅ Full persistence | ⚠️ Metrics only |
| Claude Desktop | ✅ Full persistence | ⚠️ Metrics only |
| Codex CLI | ✅ Full persistence | ⚠️ Metrics only |
| Qwen Code | ✅ Full persistence | ⚠️ Metrics only |

**Recommendation:** Use Node 22+ for full session persistence.

**Fallback (Node 18-20):**
- ✅ All tools work
- ✅ Metrics tracked (`.devctx/metrics.jsonl`)
- ❌ No session persistence (no SQLite)
- ❌ No `smart_turn` context recovery

---

## Quick Start by Client

### Cursor

```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients cursor
# Restart Cursor
# Use Agent mode
# Check: .cursor/rules/devctx.mdc exists
```

---

### Claude Desktop

```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients claude
# Restart Claude Desktop
# Check: .claude/settings.json has hooks
# Optional: Enable hooks for auto smart_turn
```

---

### Codex CLI

```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients codex
# Restart Codex
# Check: .codex/config.toml exists
# Check: AGENTS.md has devctx rules
```

---

### Qwen Code

```bash
npm install -g smart-context-mcp
npx smart-context-init --target . --clients qwen
# Restart Qwen Code
# Check: .qwen/settings.json exists
# Check: AGENTS.md has devctx rules
```

---

## Verification

### Check MCP is running

**Cursor:**
```
Settings → MCP → Check "smart-context" is active
```

**Claude Desktop:**
```
Check logs for MCP server startup
```

**Codex CLI:**
```bash
# MCP servers listed on startup
codex
```

**Qwen Code:**
```
Settings → MCP → Check "smart-context" is active
```

---

### Check rules are installed

**Cursor:**
```bash
cat .cursor/rules/devctx.mdc
ls .cursor/rules/profiles-compact/
```

**Claude Desktop:**
```bash
cat CLAUDE.md | grep "devctx:start"
```

**Codex CLI:**
```bash
cat AGENTS.md | grep "devctx:start"
```

**Qwen Code:**
```bash
cat AGENTS.md | grep "devctx:start"
```

---

### Check metrics

```bash
npm run report:metrics
```

**Good signs:**
- Tool usage > 0
- Savings 60-90%
- Multiple tools used

**Bad signs:**
- Tool usage = 0
- Check: MCP running? Rules installed?

---

## Honest Limitations by Client

### Cursor

**Can do:**
- ✅ Conditional rules (profiles activate based on globs)
- ✅ Low fixed context cost (150 tokens base)
- ✅ Full `smart_turn` support
- ✅ Agent decides when to use tools

**Cannot do:**
- ❌ Auto-trigger `smart_turn` (no hooks)
- ❌ Force agent to use tools
- ❌ Intercept prompts automatically

---

### Claude Desktop

**Can do:**
- ✅ Native hooks (SessionStart, PostToolUse)
- ✅ Can auto-trigger `smart_turn` via hooks (opt-in)
- ✅ Full `smart_turn` support
- ✅ Closest to "automatic" behavior

**Cannot do:**
- ❌ Conditional rules (all rules always visible)
- ❌ Force agent to use tools (hooks suggest, not enforce)
- ❌ Intercept prompts automatically

---

### Codex CLI

**Can do:**
- ✅ Full MCP support
- ✅ Agent rules in `AGENTS.md`
- ✅ Full `smart_turn` support
- ✅ Surface blocked-state remediation in generated rules
- ✅ Lightweight and fast

**Cannot do:**
- ❌ Conditional rules (all rules always visible)
- ❌ Auto-trigger `smart_turn` (no hooks)
- ❌ Force agent to use tools

---

### Qwen Code

**Can do:**
- ✅ Full MCP support
- ✅ Agent rules in `AGENTS.md`
- ✅ Full `smart_turn` support
- ✅ Surface blocked-state remediation in generated rules
- ✅ Lightweight and fast

**Cannot do:**
- ❌ Conditional rules (all rules always visible)
- ❌ Auto-trigger `smart_turn` (no hooks)
- ❌ Force agent to use tools

---

## Choosing the Right Client

### Use Cursor if:
- ✅ You want conditional rules (low fixed context cost)
- ✅ You work on complex, multi-file tasks
- ✅ You want task-specific workflows (debugging, review, refactor)
- ✅ You prefer agent-driven tool selection

---

### Use Claude Desktop if:
- ✅ You want hooks for session-aware workflows
- ✅ You want closest to "automatic" behavior
- ✅ You work on long, multi-step tasks
- ✅ You want auto-trigger `smart_turn` on session start

---

### Use Codex CLI if:
- ✅ You want lightweight, fast startup
- ✅ You work on medium-sized tasks
- ✅ You prefer command-line interface
- ✅ You want simple rule structure

---

### Use Qwen Code if:
- ✅ You want lightweight, fast startup
- ✅ You work on medium-sized tasks
- ✅ You prefer IDE interface
- ✅ You want simple rule structure

---

## Migration Between Clients

### From Cursor to Claude Desktop

```bash
# Already have Cursor setup
npx smart-context-init --target . --clients claude
# Restart Claude Desktop
# Rules copied to CLAUDE.md
# Hooks configured in .claude/settings.json
```

---

### From Claude Desktop to Cursor

```bash
# Already have Claude setup
npx smart-context-init --target . --clients cursor
# Restart Cursor
# Rules split into base + profiles
# Conditional rules active
```

---

### Support All Clients

```bash
npx smart-context-init --target .
# Generates configs for all clients
# Restart your preferred client
```

---

## Troubleshooting by Client

### Cursor: Agent not using devctx tools

**Check:**
```bash
# 1. MCP running?
# Settings → MCP → Check "smart-context" active

# 2. Rules installed?
cat .cursor/rules/devctx.mdc

# 3. Metrics show usage?
npm run report:metrics
```

**Possible causes:**
- Agent in Ask mode (read-only, no MCP)
- Task too simple (built-in tools sufficient)
- Rules not installed

---

### Claude Desktop: Hooks not triggering

**Check:**
```bash
# 1. Hooks configured?
cat .claude/settings.json | grep -A 5 "hooks"

# 2. Hook script exists?
ls tools/devctx/scripts/claude-hook.js

# 3. Permissions?
chmod +x tools/devctx/scripts/claude-hook.js
```

**Possible causes:**
- Hooks not configured
- Script not executable
- Node not in PATH

---

### Codex CLI: MCP not loading

**Check:**
```bash
# 1. Config exists?
cat .codex/config.toml

# 2. MCP server listed on startup?
codex
# Should show: "smart-context" MCP server

# 3. Rules installed?
cat AGENTS.md | grep "devctx:start"
```

**Possible causes:**
- Config file missing
- TOML syntax error
- Rules not embedded

---

### Qwen Code: MCP not loading

**Check:**
```bash
# 1. Config exists?
cat .qwen/settings.json

# 2. MCP enabled?
cat .qwen/settings.json | grep "mcp"

# 3. Rules installed?
cat AGENTS.md | grep "devctx:start"
```

**Possible causes:**
- Config file missing
- MCP not enabled
- Rules not embedded

---

## Summary

| Client | Automaticity | Fixed Cost | Best For |
|--------|-------------|------------|----------|
| **Cursor** | Medium | Low (150t) | Complex tasks, conditional workflows |
| **Claude Desktop** | High | Medium (200t) | Session-aware, hooks, multi-step |
| **Codex CLI** | Low-Medium | Medium (200t) | Lightweight, CLI, medium tasks |
| **Qwen Code** | Low-Medium | Medium (200t) | Lightweight, IDE, medium tasks |

**Key insights:**
- **Cursor:** Best for complex tasks with low context cost
- **Claude Desktop:** Best for session-aware workflows with hooks
- **Codex/Qwen:** Best for lightweight, medium-sized tasks

**All clients support:**
- ✅ Full MCP
- ✅ Agent rules
- ✅ `smart_turn` session persistence (Node 22+)
- ✅ All 22 tools

**Differences:**
- Conditional rules (Cursor only)
- Hooks (Claude Desktop only)
- Fixed context cost (Cursor lowest)

**Choose based on your workflow, not on promises of magic.**
