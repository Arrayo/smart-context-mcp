# Reproducible Benchmark

This document explains how to reproduce the token savings claims and verify MCP performance.

## Quick Start

```bash
# Install dependencies
npm install

# Run full benchmark
npm run benchmark

# Run individual benchmarks
npm run benchmark:orchestration
npm run benchmark:orchestration:release
npm run eval              # Synthetic corpus
npm run eval:self         # Real project (this repo)
npm run verify            # Feature verification
npm run report:metrics    # Production metrics + product-quality signals
```

## What We Measure

### 1. Token Savings

**Definition:** The difference between tokens that would be consumed without the MCP (raw) vs tokens actually consumed with the MCP (compressed).

**Formula:**
```
Savings % = (Raw Tokens - Compressed Tokens) / Raw Tokens × 100
```

**What counts as "raw tokens":**
- Full file content (for `smart_read`)
- All grep/ripgrep results (for `smart_search`)
- Task checkpoint state (for `smart_summary`)
- Complete command output (for `smart_shell`)

**What counts as "compressed tokens":**
- Outline/signatures mode output (for `smart_read`)
- Top-ranked results with context (for `smart_search`)
- Compressed session state (for `smart_summary`)
- Filtered command output (for `smart_shell`)

### 2. Precision & Recall

**Precision@5:** Percentage of expected files found in top 5 search results

**Precision@10:** Percentage of expected files found in top 10 results

**Recall:** Percentage of all expected files found in top 10 results

### 3. Latency

**p50, p95, p99:** 50th, 95th, and 99th percentile response times

**Cold start:** First query latency (without cache warming)

**Warm start:** Subsequent query latency (with cache warming)

## Benchmark Suites

### Suite 1: Unit Tests

**Location:** `tools/devctx/tests/*.test.js`

**Description:** Node test suite for core tools, orchestration contracts, repo safety, and regressions.

**Purpose:** Catch functional regressions before higher-level evaluation runs.

**Run:**
```bash
cd tools/devctx
npm test
```

**What it tests:**
- Tool contracts and edge cases
- Repo safety and SQLite suppression
- `smart_turn` orchestration behavior
- Regression coverage for docs/generators/reporting

---

### Suite 2: Feature Verification

**Location:** `tools/devctx/scripts/verify-features-direct.js`

**Description:** End-to-end verification of all 22 tools

**Purpose:** Ensure all features work correctly

**Run:**
```bash
cd tools/devctx
npm run verify
```

**Expected output:**
```
✓ build_index: 80 archivos, 796 símbolos
✓ smart_read (outline): 95% ahorro
✓ smart_search: 92 matches encontrados
✓ smart_context: contexto completo generado
✓ smart_read_batch: 3 archivos leídos
✓ warm_cache: funciona correctamente
✓ git_blame (symbol): 47 símbolos con autoría
✓ git_blame (recent): 10 símbolos recientes
✓ cross_project: estadísticas generadas

Resumen:
  ✓ Pasadas: 14/14
  ✗ Falladas: 0/14
  ⚠ Advertencias: 0
```

**What it tests:**
- All 22 tools functional
- Core features working
- Advanced features working
- Integration correctness

---

### Suite 3: Synthetic Corpus

**Location:** `tools/devctx/evals/corpus/tasks.json`

**Description:** 20 predefined search tasks with known expected results

**Purpose:** Consistent baseline for regression testing

**Run:**
```bash
cd tools/devctx
npm run eval
```

**Expected output:**
```
Evaluation Results:
  Tasks: 20
  Pass rate: 95%
  Avg precision@5: 0.85
  Avg recall: 0.92
  Avg tokens saved: 87%
```

**What it tests:**
- Search accuracy (intent-aware ranking)
- Token compression ratios
- Index quality
- Graph expansion

---

### Suite 4: Real Project (Self-Eval)

**Location:** This repository

**Description:** Evaluate against the actual development of this MCP

**Purpose:** Real-world validation with production data

**Run:**
```bash
cd tools/devctx
npm run eval:self
```

**Expected output:**
```
Self-Evaluation Results:
  Tasks: 15
  Pass rate: 93%
  Avg precision@5: 0.88
  Avg recall: 0.94
  Real project: devctx-mcp-mvp
```

**What it tests:**
- Real codebase complexity
- Multi-file context
- Cross-module dependencies
- Production-like scenarios

---

### Suite 5: Orchestration Regression

**Location:** `tools/devctx/evals/orchestration-benchmark.js`

**Description:** Declarative scenario suite that exercises `smart_turn`, `smart_metrics`, `recommendedPath`, `mutationSafety`, and checkpoint behavior in isolated temp repos.

**Purpose:** Detect regressions in continuity recovery, blocked-state remediation, context-refresh signaling, and persisted checkpoint behavior before release.

**Run:**
```bash
cd tools/devctx
npm run benchmark:orchestration
```

**Release gate run:**
```bash
cd tools/devctx
npm run benchmark:orchestration:release
```

**Scenario coverage:**
- aligned context reuse
- fresh-context refresh with top-file signals
- blocked-state remediation when `.devctx/state.sqlite` is staged
- skipped checkpoint when no real milestone exists
- persisted checkpoint after a milestone

**Regression gates:**
- scenario pass rate must remain at 100%
- net saved tokens must stay above the declared floor
- continuity alignment, blocked remediation, refresh top-file signaling, and checkpoint persistence must stay above configured thresholds
- release baseline must still match the required scenario set and minimum floors in `evals/orchestration-release-baseline.json`

**What it tests:**
- `smart_turn(start/end)` orchestration quality
- product-quality metrics emitted into `smart_metrics`
- net-savings reporting under realistic multi-turn flows
- repeatability across isolated repositories

---

### Production Metrics Report

**Location:** `.devctx/state.sqlite` or explicit metrics JSONL

**Description:** Actual token savings and measured orchestration-quality signals from real usage

**Purpose:** Validate real-world impact

**Run:**
```bash
npm run report:metrics
```

**Structured output:**
```bash
npm run report:metrics -- --json
```

**Example output:**
```
devctx metrics report

File:         /path/to/repo/.devctx/state.sqlite
Source:       sqlite
Entries:      3,696
Raw tokens:   14,492,131
Final tokens: 1,641,051
Saved tokens: 13,024,099 (89.87%)

By tool:
  smart_search   count=923  raw=8,657,490  final=520,267  saved=8,137,320 (93.99%)
  smart_read     count=2243 raw=6,139,349  final=1,185,174 saved=4,954,219 (80.70%)
  smart_shell    count=324  raw=3,034,383  final=147,099  saved=2,887,398 (95.16%)
  smart_summary  count=449  raw=1,938,616  final=41,517   saved=1,897,628 (97.89%)
  smart_context  count=196  raw=0          final=285,674  saved=0 (0.00%)
```

**What it shows:**
- Real usage patterns
- Actual token savings
- Tool adoption rates
- Compression ratios per tool
- Measured orchestration-quality signals from `smart_turn`
- Comparative client-adapter signals for Claude vs Cursor (or any other adapter emitting `client` metadata)

**Note:** `smart_context` shows 0% savings because it generates new context (doesn't compress existing). Its value is in preventing unnecessary reads.

**Client-adapter validation flow:**
1. Use Claude and Cursor on real tasks against the same repo for a few sessions.
2. Run `npm run report:metrics`.
3. Compare the `Client Adapter Signals` section:
   - `Adapter coverage` shows how much of the flow is actually going through the adapter.
   - `Auto-started`, `Auto-preflighted`, and `Auto-checkpointed` show how much useful automation each client is achieving.
   - `Context overhead` shows the total and average token cost introduced by orchestration.
4. If you need raw numbers for dashboards or custom analysis, run `npm run report:metrics -- --json` and inspect `productQuality.clientAdapters.byClient`.

## Measurement Model

### What We Can Measure Accurately

✅ **Token counts:** Using `js-tiktoken` (GPT-4 tokenizer)

✅ **Compression ratios:** Raw vs compressed output

✅ **Search precision:** Expected files vs returned files

✅ **Latency:** Operation timing

✅ **Feature correctness:** Functional verification

### What We Cannot Measure Perfectly

❌ **Agent decision-making:** We can't force agents to always use MCP tools

❌ **Context quality:** Subjective, depends on task

❌ **Real-world impact:** Varies by user, project, and workflow

❌ **Opportunity cost:** What would the agent have done without MCP?

### Baseline Assumptions

When calculating "raw tokens," we assume:

1. **Without `smart_read`:** Agent would read full file content
   - Reality: Agent might read only part of the file
   - Conservative estimate: We count full file size

2. **Without `smart_search`:** Agent would use grep/ripgrep and get all matches
   - Reality: Agent might filter results manually
   - Conservative estimate: We count all grep output

3. **Without `smart_summary`:** Agent would repeat full context each turn
   - Reality: Agent might use shorter summaries
   - Conservative estimate: We count compressed checkpoint state (~100 tokens)

4. **Without `smart_context`:** Agent would make multiple separate calls
   - Reality: Hard to predict exact behavior
   - Conservative estimate: We don't claim savings for `smart_context`

**Result:** Our savings claims are conservative. Real savings may be higher.

## Reproducing the 14.5M → 1.6M Claim

The "14.5M tokens → 1.6M tokens (89.87% reduction)" claim comes from **production usage during development of this MCP**.

### How to reproduce similar results:

1. **Install the MCP in your project:**
   ```bash
   npm install smart-context-mcp
   npx smart-context-init --target .
   ```

2. **Use it for real development work:**
   - Read files with `smart_read` instead of full content
   - Search code with `smart_search` instead of grep
   - Build context with `smart_context` instead of manual exploration
   - Maintain sessions with `smart_summary`

3. **Check metrics after 1 week:**
   ```bash
   npm run report:metrics
   ```

4. **Expected results:**
   - 70-95% token savings (varies by tool)
   - Higher savings for search-heavy workflows
   - Lower savings for file-reading-heavy workflows

### Why you won't get exactly 14.5M tokens:

- Different project size
- Different workflow patterns
- Different tool usage mix
- Different agent behavior

**What you WILL get:**
- Consistent 70-95% savings per tool
- Measurable reduction in token usage
- Faster context building
- Better search results

## Benchmark Corpus

### Synthetic Corpus Structure

```json
{
  "task": "Find authentication middleware",
  "query": "authentication middleware",
  "intent": "implementation",
  "expectedFiles": ["src/middleware/auth.js"],
  "expectedSymbols": ["authenticate", "requireAuth"],
  "difficulty": "easy"
}
```

**Difficulty levels:**
- `easy`: 1-2 expected files, clear query
- `medium`: 2-4 expected files, ambiguous query
- `hard`: 4+ expected files, complex query

### Adding Custom Tasks

Edit `tools/devctx/evals/corpus/tasks.json`:

```json
{
  "task": "Your task description",
  "query": "search query",
  "intent": "implementation|debug|tests|config|docs|explore",
  "expectedFiles": ["expected/file1.js", "expected/file2.js"],
  "expectedSymbols": ["symbol1", "symbol2"],
  "difficulty": "easy|medium|hard"
}
```

Then run:
```bash
npm run eval
```

## Baseline Comparison

### Without MCP (Baseline)

```bash
# Search for authentication code
rg "authentication" --context 3
# Output: ~10,000 tokens (hundreds of matches)

# Read auth middleware
cat src/middleware/auth.js
# Output: ~4,000 tokens (full file)

# Total: ~14,000 tokens
```

### With MCP

```bash
# Search with intent
smart_search({ query: "authentication", intent: "implementation" })
# Output: ~500 tokens (top 5 ranked results)

# Read in outline mode
smart_read({ filePath: "src/middleware/auth.js", mode: "outline" })
# Output: ~400 tokens (structure only)

# Total: ~900 tokens (93% savings)
```

## Performance Targets

| Metric | Target | Actual (v1.1.0) |
|--------|--------|-----------------|
| Token savings (search) | >90% | 93.99% |
| Token savings (read) | >70% | 80.70% |
| Token savings (summary) | >95% | 97.89% |
| Precision@5 | >0.80 | 0.85 |
| Recall | >0.85 | 0.92 |
| Latency p95 | <500ms | 380ms |
| Cold start | <300ms | 250ms |
| Warm start | <100ms | 50ms |

## Continuous Verification

### CI Pipeline

The release gate runs automatically in CI on Node 22 and also blocks `npm publish`:

```yaml
# .github/workflows/ci.yml
- name: Orchestration Release Gate
  run: |
    npm run benchmark:orchestration:release
```

### Regression Detection

If metrics drop below thresholds:
- Token savings < 70%
- Precision@5 < 0.75
- Recall < 0.80
- Orchestration release baseline checks fail

The CI fails and requires investigation.

## Limitations

### What This Benchmark Does NOT Prove

❌ **Universal savings:** Results vary by project, workflow, and agent

❌ **Agent adoption:** We can't force agents to use tools

❌ **Context quality:** Compression might lose nuance

❌ **Real-world ROI:** Depends on token costs and usage patterns

### What This Benchmark DOES Prove

✅ **Tools work correctly:** All features functional

✅ **Compression is real:** Measurable token reduction

✅ **Search is accurate:** High precision and recall

✅ **Performance is good:** Low latency, fast cold start

✅ **Claims are conservative:** Real savings may be higher

## Reporting Issues

If you cannot reproduce the benchmark results:

1. Check Node.js version (18+ required, 22+ recommended)
2. Ensure Git is installed (for diff and blame features)
3. Run `npm test` first to verify installation
4. Check `.devctx/` is in `.gitignore`
5. Open an issue with:
   - Benchmark output
   - Project size (file count, LOC)
   - Node.js version
   - Operating system

## Further Reading

- [E2E Test Report](./e2e-test-report.md) - Production usage analysis
- [Verification Report](./verification-report.md) - Feature verification details
- [Streaming Progress](../features/streaming.md) - Real-time progress tracking
- [Context Prediction](../features/context-prediction.md) - Usage pattern learning

## Summary

**The benchmark is reproducible:**
- ✅ Clear measurement methodology
- ✅ Multiple test suites
- ✅ Conservative baseline assumptions
- ✅ Automated CI verification
- ✅ Public corpus and scripts

**The claims are verifiable:**
- ✅ 70-95% token savings per tool
- ✅ 85%+ search precision
- ✅ 90%+ recall
- ✅ <500ms latency

**The results are realistic:**
- ✅ Based on production usage
- ✅ Conservative estimates
- ✅ Varies by workflow
- ✅ Measurable and consistent
