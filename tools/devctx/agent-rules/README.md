# Agent Rules

## What This Is

Agent rules are **task-specific guidance** that help AI agents use the MCP effectively. They're not just documentation—they're a core part of the product.

## Why This Matters

The MCP provides 22 tools, but without guidance, agents often:
- Read full files when signatures would suffice
- Use Grep instead of `smart_search`
- Skip task checkpoint recovery
- Waste tokens on irrelevant content

**Agent rules solve this** by providing clear, actionable workflows per task type.

## Structure

```
agent-rules/
├── core.md                    ← Universal rules (always apply)
└── profiles/
    ├── debugging.md           ← Debugging workflow
    ├── code-review.md         ← Code review workflow
    ├── refactoring.md         ← Refactoring workflow
    ├── testing.md             ← Testing workflow
    └── architecture.md        ← Architecture exploration
```

## How It Works

### 1. Installation

```bash
npx smart-context-init --target .
```

Creates:
- `.cursor/rules/devctx.mdc` (Cursor)
- `AGENTS.md` (Codex, Qwen)
- `CLAUDE.md` (Claude Desktop)
- `.git/hooks/pre-commit` (safety)
- `.gitignore` entry for `.devctx/`

### 2. Agent Reads Rules

When the agent starts, it reads:
- Core rules (tool preference, task checkpoint recovery)
- Profile rules (task-specific workflows)

### 3. Agent Applies Rules

The agent **decides** when to use devctx tools based on:
- Your prompts
- Task type (debug, review, refactor, etc.)
- Available context
- Token budget

**Important:** Rules are **guidance**, not guarantees. The agent makes the final decision.

## Profiles

### Debugging

**When:** Fixing bugs, investigating errors, reproducing failures

**Key tools:**
- `smart_search(intent=debug)` - Find error locations
- `smart_read(symbol)` - Extract failing function
- `smart_shell('npm test')` - Reproduce error

**Workflow:**
```
smart_turn(start) → smart_search(debug) → smart_read(symbol) → fix → test → smart_turn(end)
```

**Token savings:** 90% (150K → 15K)

---

### Code Review

**When:** Reviewing PRs, checking changes, security audit

**Key tools:**
- `smart_context(diff=true)` - Get changed files
- `smart_read(signatures)` - Understand API
- `git_blame(symbol)` - Check authorship

**Workflow:**
```
smart_turn(start) → smart_context(diff) → smart_read(signatures) → review → smart_turn(end)
```

**Token savings:** 87% (200K → 25K)

---

### Refactoring

**When:** Extracting functions, renaming, moving code, simplifying

**Key tools:**
- `smart_context(entryFile)` - Understand impact
- `smart_read(signatures)` - Preserve API
- `smart_read(symbol)` - Extract functions

**Workflow:**
```
smart_turn(start) → smart_context → smart_read(signatures) → refactor → test → smart_turn(end)
```

**Token savings:** 89% (180K → 20K)

---

### Testing

**When:** Writing tests, TDD, fixing failing tests, coverage

**Key tools:**
- `smart_search(intent=tests)` - Find existing tests
- `smart_read(symbol)` - Extract function to test
- `smart_shell('npm test')` - Run tests

**Workflow:**
```
smart_turn(start) → smart_search(tests) → smart_read(symbol) → write test → run → smart_turn(end)
```

**Token savings:** 90% (120K → 12K)

---

### Architecture

**When:** Onboarding, exploration, dependency analysis, planning

**Key tools:**
- `smart_context(detail=minimal)` - High-level overview
- `smart_read(signatures)` - Module interfaces
- `cross_project` - Multi-project analysis

**Workflow:**
```
smart_turn(start) → smart_context(minimal) → smart_read(signatures) → analyze → smart_turn(end)
```

**Token savings:** 90% (300K → 30K)

## Core Principles

### 1. Compressed First, Full Later

```javascript
// Always start compressed
smart_read({ mode: 'outline' })      // Structure only
smart_read({ mode: 'signatures' })   // API only
smart_read({ mode: 'symbol' })       // Specific function

// Full mode only when necessary
smart_read({ mode: 'full' })         // Last resort
```

### 2. Search Before Read

```javascript
// Find first
smart_search({ query: 'authentication', intent: 'implementation' })

// Then read specific files
smart_read({ filePath: 'src/auth.js', mode: 'signatures' })
```

### 3. Task Checkpoint Recovery

```javascript
// Start every non-trivial task
smart_turn({ phase: 'start', userPrompt: '...', ensureSession: true })

// End meaningful milestones
smart_turn({ phase: 'end', event: 'milestone', summary: '...', nextStep: '...' })
```

### 4. Intent-Aware Search

```javascript
// Task-specific ranking
smart_search({ query: 'error', intent: 'debug' })        // Prioritizes error handling
smart_search({ query: 'User', intent: 'implementation' }) // Prioritizes source files
smart_search({ query: 'test', intent: 'tests' })         // Prioritizes test files
```

### 5. Graph-Based Expansion

```javascript
// Get relationships automatically
smart_context({ entryFile: 'src/auth.js' })

// Returns:
// - Direct imports
// - Importers (who uses this)
// - Tests (coverage)
// - Neighbors (same directory)
```

## Installation Per Client

### Cursor

File: `.cursor/rules/devctx.mdc`

```markdown
---
description: Prefer devctx MCP tools
alwaysApply: true
---

[core rules + profiles]
```

### Codex / Qwen

File: `AGENTS.md`

```markdown
<!-- devctx:start -->
## devctx

[core rules + profiles]
<!-- devctx:end -->
```

### Claude Desktop

File: `CLAUDE.md`

```markdown
<!-- devctx:start -->
## devctx

[core rules + profiles]
<!-- devctx:end -->
```

## Customization

### Option 1: Extend Rules

Add project-specific rules:

```markdown
<!-- devctx:start -->
## devctx

[generated rules]

## Project-specific

- Always check `config/security.js` for auth changes
- Run `npm run e2e` before approving PRs
- Use `smart_search(intent=debug)` for production errors
<!-- devctx:end -->
```

### Option 2: Profile Selection

Install only specific profiles:

```bash
# Copy only debugging profile
cp node_modules/smart-context-mcp/agent-rules/profiles/debugging.md .cursor/rules/
```

### Option 3: Custom Profiles

Create your own:

```markdown
# Custom Profile: Performance Optimization

## Workflow
1. smart_search(intent=implementation, query='performance bottleneck')
2. smart_read(mode=symbol, symbol='slowFunction')
3. [optimize]
4. smart_shell('npm run benchmark')
```

## Verification

Check if rules are installed:

```bash
# Cursor
cat .cursor/rules/devctx.mdc

# Codex/Qwen
cat AGENTS.md

# Claude Desktop
cat CLAUDE.md
```

Check if agent uses them:

```bash
# View metrics
npm run report:metrics

# Should show smart_read, smart_search, smart_context usage
```

## Troubleshooting

### Agent not using devctx tools

1. **Check rules installed:**
   ```bash
   ls -la .cursor/rules/devctx.mdc
   ```

2. **Reinstall:**
   ```bash
   npx smart-context-init --target .
   ```

3. **Verify MCP running:**
   - Cursor: Settings → MCP → Check "smart-context" is active
   - Claude: Check `claude_desktop_config.json`

4. **Check metrics:**
   ```bash
   npm run report:metrics
   ```
   
   If no metrics, agent isn't using tools.

### Agent using built-in tools instead

This is **expected behavior**. Rules are guidance, not enforcement.

The agent will use built-in tools when:
- Task is simple (single file read)
- Built-in tool is more appropriate
- devctx tool would add unnecessary overhead

**This is fine.** The goal is to reduce token usage on complex tasks, not replace all tools.

## Metrics

Track rule effectiveness:

```bash
npm run report:metrics
```

Shows:
- Tool usage frequency
- Token savings per tool
- Compression ratios
- Session continuity

## Design Philosophy

### 1. Guidance, Not Enforcement

Rules suggest better paths, but agents decide. This is intentional:
- Agents have context we don't
- Flexibility for edge cases
- No false guarantees

### 2. Task-Specific Workflows

Different tasks need different approaches:
- Debugging: error-first, symbol-focused
- Review: diff-aware, API-focused
- Refactoring: graph-aware, test-verified
- Testing: coverage-aware, TDD-friendly
- Architecture: index-first, minimal-detail

### 3. Progressive Disclosure

Start compressed, drill down when needed:
- `outline` → `signatures` → `symbol` → `full`
- `minimal` → `balanced` → `deep`
- Search → Read → Edit

### 4. Context Continuity

Session persistence reduces redundant work:
- Recover previous context
- Resume interrupted work
- Track decisions
- Maintain state

## Future Enhancements

### v1.2.0
- [ ] Profile auto-detection (detect task type from prompt)
- [ ] Custom profile templates
- [ ] Rule validation and linting
- [ ] Usage analytics per profile

### v1.3.0
- [ ] Dynamic rule generation based on project
- [ ] A/B testing different rule sets
- [ ] Rule effectiveness scoring
- [ ] Auto-tuning based on metrics

## Contact

Questions about agent rules: [GitHub Issues](https://github.com/Arrayo/smart-context-mcp/issues)
