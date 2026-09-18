# Security Configuration

## Environment Variables

### `DEVCTX_SHELL_DISABLED`

Disable `smart_shell` entirely.

```bash
export DEVCTX_SHELL_DISABLED=true
```

**When to use:**
- High-security environments
- Untrusted projects
- When shell access is not needed

**Impact:**
- `smart_shell` returns blocked error
- Other tools unaffected

---

### `DEVCTX_CACHE_WARMING`

Disable cache warming feature.

```bash
export DEVCTX_CACHE_WARMING=false
```

**When to use:**
- Resource-constrained environments
- When file access patterns are unpredictable
- To reduce startup overhead

**Impact:**
- `warm_cache` tool disabled
- Cold-start performance may be slower
- Memory usage reduced

---

### `DEVCTX_METRICS_READONLY`

Disable metrics persistence (read-only mode).

```bash
export DEVCTX_METRICS_READONLY=true
```

**When to use:**
- CI/CD environments
- When `.devctx/` is read-only
- To prevent metrics accumulation

**Impact:**
- Metrics not persisted to SQLite
- `smart_metrics` returns empty results

---

### `DEVCTX_WORKFLOW_TRACKING`

Enable workflow-level metrics tracking (opt-in).

```bash
export DEVCTX_WORKFLOW_TRACKING=true
```

**When to use:**
- Production deployments
- Measuring real-world savings
- Benchmarking workflows

**Impact:**
- Tracks complete task workflows (debugging, review, refactor, testing, architecture)
- Calculates savings vs realistic baselines
- Enables `npm run report:workflows`

**Overhead:** Minimal (SQLite writes on `smart_turn` start/end)
- Context prediction disabled

---

### `DEVCTX_PROJECT_ROOT`

Lock MCP to specific directory.

```bash
export DEVCTX_PROJECT_ROOT=/path/to/safe/directory
```

**When to use:**
- Multi-project environments
- When default detection is incorrect
- To restrict access to specific directory

**Impact:**
- All operations scoped to specified directory
- Cannot access files outside this root

---

## Cursor Configuration

Add to `.cursor/settings.json`:

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "smart-context-server",
      "env": {
        "DEVCTX_SHELL_DISABLED": "false",
        "DEVCTX_CACHE_WARMING": "true",
        "DEVCTX_METRICS_READONLY": "false"
      }
    }
  }
}
```

---

## Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "smart-context-server",
      "env": {
        "DEVCTX_SHELL_DISABLED": "false",
        "DEVCTX_CACHE_WARMING": "true"
      }
    }
  }
}
```

---

## Security Profiles

### Minimal (Highest Security)

```bash
export DEVCTX_SHELL_DISABLED=true
export DEVCTX_CACHE_WARMING=false
export DEVCTX_METRICS_READONLY=true
```

**Use case:** Untrusted projects, public demos

**Available tools:**
- `smart_read`, `smart_read_batch`
- `smart_search`
- `smart_context` (limited)
- `build_index`

**Disabled tools:**
- `smart_shell`
- `warm_cache`
- `smart_metrics` (read-only)

---

### Standard (Recommended)

```bash
# Default configuration (no env vars needed)
```

**Use case:** Normal development in trusted projects

**Available tools:** All 22 tools

**Security:**
- Allowlist-only commands
- Path validation
- Repository safety checks

---

### Permissive (Development)

```bash
export DEVCTX_CACHE_WARMING=true
export DEVCTX_METRICS_READONLY=false
```

**Use case:** Active development, performance testing

**Available tools:** All 22 tools with full features

**Security:**
- Same protections as Standard
- Metrics accumulation enabled
- Cache warming on startup

---

## Customizing Allowlists

Currently, allowlists are hardcoded in `src/tools/smart-shell.js`:

```javascript
const allowedCommands = new Set([
  'pwd', 'ls', 'find', 'rg', 'git', 'npm', 'pnpm', 'yarn', 'bun'
]);

const allowedGitSubcommands = new Set([
  'status', 'diff', 'show', 'log', 'branch', 'rev-parse', 'blame'
]);

const allowedPackageManagerSubcommands = new Set([
  'test', 'run', 'lint', 'build', 'typecheck', 'check'
]);
```

**Planned (v1.2.0):** Configuration file support:

```json
{
  "security": {
    "allowedCommands": ["pwd", "ls", "git"],
    "allowedGitSubcommands": ["status", "diff"],
    "allowedScripts": ["test", "lint"]
  }
}
```

---

## Pre-commit Hook

Installed by `smart-context-init`:

```bash
#!/bin/bash
# .git/hooks/pre-commit

if git diff --cached --name-only | grep -q '^\.devctx/'; then
  echo "ERROR: .devctx/ is staged for commit"
  echo "Run: git reset HEAD .devctx/"
  exit 1
fi
```

**Manual installation:**

```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
if git diff --cached --name-only | grep -q '^\.devctx/'; then
  echo "ERROR: .devctx/ is staged for commit"
  echo "Run: git reset HEAD .devctx/"
  exit 1
fi
EOF

chmod +x .git/hooks/pre-commit
```

---

## Monitoring

### Check Metrics

```bash
npm run report:metrics
```

**Look for:**
- Unexpected tool usage
- High token consumption
- Repeated failed commands
- Unusual file access patterns

### Inspect SQLite

```bash
sqlite3 .devctx/state.sqlite << 'EOF'
SELECT 
  tool_name,
  target,
  created_at,
  raw_tokens,
  compressed_tokens
FROM metrics_events
WHERE created_at > datetime('now', '-1 hour')
ORDER BY created_at DESC;
EOF
```

### Audit Trail

All operations logged with:
- Tool name
- Target (file, query, command)
- Timestamp
- Session ID
- Token metrics

---

## Security Checklist

Before using this MCP:

- [ ] Project is trusted (your code or verified open source)
- [ ] No secrets hardcoded in files
- [ ] `.devctx/` is in `.gitignore`
- [ ] Pre-commit hook is installed
- [ ] You understand what `smart_shell` can run
- [ ] Node.js and dependencies are up to date
- [ ] You've reviewed [SECURITY.md](../../SECURITY.md)

---

## Incident Response

If you suspect a security issue:

1. **Stop using the MCP immediately**
2. **Check `.devctx/state.sqlite` for suspicious activity**
3. **Review recent git commits**
4. **Email fcp1978@hotmail.com with details**
5. **Do NOT open a public issue**

---

## Security Updates

Subscribe to releases on GitHub to receive security updates:

[https://github.com/Arrayo/smart-context-mcp/releases](https://github.com/Arrayo/smart-context-mcp/releases)

Security fixes are released as:
- **Patch** (1.1.x) - Minor issues
- **Minor** (1.x.0) - Moderate issues
- **Major** (x.0.0) - Critical issues

---

## Compliance

### Data Privacy

- ✅ All data stays local (`.devctx/` directory)
- ✅ No telemetry or external reporting
- ✅ No data sent to external services
- ✅ Metrics are project-local only

### GDPR

- ✅ No personal data collected
- ✅ No data processing outside user's machine
- ✅ User has full control over `.devctx/` data

### SOC 2

- ✅ Audit trail available
- ✅ Access controls (path validation)
- ✅ Security monitoring (metrics)
- ⚠️ No encryption at rest (SQLite plaintext)

---

## Hardening Recommendations

### 1. Restrict File Access

Create `.devctx-ignore` to exclude sensitive files:

```
.env
.env.*
credentials.json
secrets.yaml
*.key
*.pem
```

(Note: `.devctx-ignore` is not yet implemented but planned for v1.2.0)

### 2. Limit Command Execution

Fork the project and customize allowlists in `src/tools/smart-shell.js`.

### 3. Enable Audit Logging

```bash
export DEVCTX_AUDIT_LOG=/var/log/devctx-audit.log
```

(Note: Audit logging is not yet implemented but planned for v1.2.0)

### 4. Use Read-Only Mode in CI

```bash
export DEVCTX_METRICS_READONLY=true
export DEVCTX_CACHE_WARMING=false
```

### 5. Monitor Resource Usage

```bash
# Check SQLite size
du -h .devctx/state.sqlite

# Check metrics
npm run report:metrics

# Check index size
du -h .devctx/index.json
```

---

## Security Testing

### Manual Testing

```bash
# Test command blocking
npm run verify

# Test path validation
node -e "import('./src/utils/fs.js').then(m => m.resolveSafePath('/etc/passwd'))"

# Test shell operators
node -e "import('./src/tools/smart-shell.js').then(m => m.smartShell({ command: 'ls | grep test' }))"
```

### Automated Testing

```bash
# Run all security tests
npm test -- --grep "security|blocked|dangerous|path validation"

# Run full test suite
npm test
```

---

## Contact

**Security issues:** fcp1978@hotmail.com

**General issues:** [GitHub Issues](https://github.com/Arrayo/smart-context-mcp/issues)
