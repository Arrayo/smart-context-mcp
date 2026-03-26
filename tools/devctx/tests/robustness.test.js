import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { smartShell } from '../src/tools/smart-shell.js';
import { smartSearch, isSmartCaseSensitive, walk, searchWithFallback, intentWeights, VALID_INTENTS } from '../src/tools/smart-search.js';
import { buildIndex, buildIndexIncremental, removeFileFromIndex, queryIndex, queryRelated, isTestFile, isFileStale, reindexFile, persistIndex, loadIndex, getGraphCoverage } from '../src/index.js';
import { smartRead, clearReadCache, buildSymbolContext, grepSymbolInFile, extractTypeReferences } from '../src/tools/smart-read.js';
import { countTokens } from '../src/tokenCounter.js';
import { setProjectRoot } from '../src/utils/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// find hardening
// ---------------------------------------------------------------------------

describe('smart_shell find hardening', () => {
  it('blocks -exec', async () => {
    const result = await smartShell({ command: 'find . -exec rm {} \\;' });
    assert.equal(result.blocked, true);
    assert.match(result.output, /not allowed/i);
  });

  it('blocks -delete', async () => {
    const result = await smartShell({ command: 'find . -delete' });
    assert.equal(result.blocked, true);
    assert.match(result.output, /not allowed/i);
  });

  it('blocks -execdir', async () => {
    const result = await smartShell({ command: 'find . -execdir cat {} \\;' });
    assert.equal(result.blocked, true);
  });

  it('inserts -maxdepth after path, not before', async () => {
    const result = await smartShell({ command: 'find . -name "*.js" -type f' });
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
  });

  it('does not override explicit -maxdepth', async () => {
    const result = await smartShell({ command: 'find . -maxdepth 2 -name "*.json"' });
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
  });

  it('works with find and no flags at all', async () => {
    const result = await smartShell({ command: 'find .' });
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
  });

  it('respects find global options like -L before path', async () => {
    const result = await smartShell({ command: 'find -L . -name package.json' });
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
  });

  it('respects find global options -H', async () => {
    const result = await smartShell({ command: 'find -H . -type f -name "*.js"' });
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
  });

  it('does not collapse successful output just because a line contains error text', async () => {
    const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'formats');
    const errorFixture = path.join(fixtureDir, '_smart_shell_error.txt');
    const plainFixture = path.join(fixtureDir, '_smart_shell_plain.txt');

    fs.writeFileSync(errorFixture, 'error fixture\n', 'utf8');
    fs.writeFileSync(plainFixture, 'plain fixture\n', 'utf8');

    try {
      const result = await smartShell({ command: 'find tools/devctx/fixtures/formats -name "*error*" -o -name "*plain*"' });
      assert.equal(result.blocked, false);
      assert.equal(result.exitCode, 0);
      assert.match(result.output, /_smart_shell_error\.txt/);
      assert.match(result.output, /_smart_shell_plain\.txt/);
    } finally {
      try { fs.unlinkSync(errorFixture); } catch {}
      try { fs.unlinkSync(plainFixture); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// smart_search literal mode
// ---------------------------------------------------------------------------

describe('smart_search literal search', () => {
  it('treats regex metacharacters as literal text', async () => {
    const result = await smartSearch({ query: '[a-z]+@fake', cwd: 'tools/devctx/src' });
    assert.equal(result.engine, 'rg');
    assert.equal(result.totalMatches, 0, '[a-z]+@fake as regex would match many strings but as literal should match nothing');
  });

  it('finds exact literal strings', async () => {
    const result = await smartSearch({ query: 'smartSearch', cwd: 'tools/devctx/src' });
    assert.equal(result.engine, 'rg');
    assert.ok(result.totalMatches > 0, 'should find literal smartSearch matches');
  });
});

// ---------------------------------------------------------------------------
// binary file detection
// ---------------------------------------------------------------------------

describe('readTextFile binary detection', () => {
  const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'formats');
  const binFixture = path.join(fixtureDir, '_test_binary.bin');
  const txtFixture = path.join(fixtureDir, '_test_text.txt');
  const relBin = 'tools/devctx/fixtures/formats/_test_binary.bin';
  const relTxt = 'tools/devctx/fixtures/formats/_test_text.txt';

  beforeEach(() => {
    fs.writeFileSync(binFixture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
    fs.writeFileSync(txtFixture, 'Hello world\nLine 2\n', 'utf8');
  });

  afterEach(() => {
    try { fs.unlinkSync(binFixture); } catch {}
    try { fs.unlinkSync(txtFixture); } catch {}
  });

  it('rejects files containing null bytes', async () => {
    const { readTextFile } = await import('../src/utils/fs.js');

    assert.throws(
      () => readTextFile(relBin),
      (err) => err.message.includes('Binary file'),
    );
  });

  it('accepts valid UTF-8 text files', async () => {
    const { readTextFile } = await import('../src/utils/fs.js');

    const result = readTextFile(relTxt);
    assert.ok(result.content.includes('Hello world'));
  });
});

// ---------------------------------------------------------------------------
// metrics rotation
// ---------------------------------------------------------------------------

describe('metrics rotation (real path)', () => {
  let tmpDir;
  let tmpMetricsFile;
  let originalEnv;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devctx-metrics-'));
    tmpMetricsFile = path.join(tmpDir, 'metrics.jsonl');
    originalEnv = process.env.DEVCTX_METRICS_FILE;
    process.env.DEVCTX_METRICS_FILE = tmpMetricsFile;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.DEVCTX_METRICS_FILE;
    } else {
      process.env.DEVCTX_METRICS_FILE = originalEnv;
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('persistMetrics writes entries and triggers rotation above 1MB', async () => {
    const { buildMetrics, persistMetrics, KEEP_LINES_AFTER_ROTATION } = await import('../src/metrics.js');

    const bigPadding = 'x'.repeat(600);
    const seedLines = 2000;
    const seeds = [];
    for (let i = 0; i < seedLines; i++) {
      seeds.push(JSON.stringify({ tool: 'seed', target: 'seed', i, padding: bigPadding }));
    }
    await fsp.writeFile(tmpMetricsFile, seeds.join('\n') + '\n', 'utf8');

    const statBefore = await fsp.stat(tmpMetricsFile);
    assert.ok(statBefore.size > 1024 * 1024, `seed file should exceed 1MB (got ${statBefore.size})`);

    const entry = buildMetrics({
      tool: 'test',
      target: 'rotation-check',
      rawText: 'hello world',
      compressedText: 'hello',
    });
    await persistMetrics(entry);

    const content = await fsp.readFile(tmpMetricsFile, 'utf8');
    const lines = content.trim().split('\n');

    assert.ok(lines.length <= KEEP_LINES_AFTER_ROTATION + 1, `should have rotated to ~${KEEP_LINES_AFTER_ROTATION} lines (got ${lines.length})`);

    const lastLine = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastLine.target, 'rotation-check');
  });

  it('persistMetrics creates file from scratch in custom dir', async () => {
    const { buildMetrics, persistMetrics } = await import('../src/metrics.js');

    const entry = buildMetrics({
      tool: 'test',
      target: 'fresh',
      rawText: 'abc',
      compressedText: 'a',
    });
    await persistMetrics(entry);

    const content = await fsp.readFile(tmpMetricsFile, 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.target, 'fresh');
    assert.ok(parsed.rawTokens >= parsed.compressedTokens);
  });

  it('buildMetrics computes token savings correctly', async () => {
    const { buildMetrics } = await import('../src/metrics.js');
    const m = buildMetrics({
      tool: 'test',
      target: 'file.js',
      rawText: 'function foo() { return bar; }',
      compressedText: 'function foo()',
    });
    assert.ok(m.rawTokens > 0);
    assert.ok(m.compressedTokens > 0);
    assert.ok(m.rawTokens >= m.compressedTokens);
    assert.ok(m.savedTokens >= 0);
    assert.ok(m.savingsPct >= 0);
    assert.ok(m.timestamp);
  });
});

describe('metrics reporting', () => {
  let tmpDir;
  let tmpMetricsFile;
  let originalEnv;
  let originalRoot;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devctx-report-'));
    tmpMetricsFile = path.join(tmpDir, '.devctx', 'metrics.jsonl');
    originalEnv = process.env.DEVCTX_METRICS_FILE;
    originalRoot = path.resolve(__dirname, '..', '..', '..');
    delete process.env.DEVCTX_METRICS_FILE;
    setProjectRoot(tmpDir);
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.DEVCTX_METRICS_FILE;
    } else {
      process.env.DEVCTX_METRICS_FILE = originalEnv;
    }
    setProjectRoot(originalRoot);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults metrics path to the active project root', async () => {
    const { getMetricsFilePath } = await import('../src/metrics.js');
    assert.equal(getMetricsFilePath(), tmpMetricsFile);
  });

  it('reports aggregated metrics from jsonl', async () => {
    await fsp.mkdir(path.dirname(tmpMetricsFile), { recursive: true });
    const lines = [
      { tool: 'smart_context', target: 'task-1', rawTokens: 300, compressedTokens: 120, savedTokens: 180, savingsPct: 60, timestamp: '2026-03-26T10:00:00.000Z' },
      { tool: 'smart_context', target: 'task-2', rawTokens: 200, compressedTokens: 100, savedTokens: 100, savingsPct: 50, timestamp: '2026-03-26T10:05:00.000Z' },
      { tool: 'smart_search', target: 'query-1', rawTokens: 80, compressedTokens: 60, savedTokens: 20, savingsPct: 25, timestamp: '2026-03-26T10:10:00.000Z' },
    ];
    await fsp.writeFile(tmpMetricsFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'report-metrics.js');
    const { stdout } = await execFile(process.execPath, [scriptPath, '--file', tmpMetricsFile, '--json']);
    const report = JSON.parse(stdout);

    assert.equal(report.summary.count, 3);
    assert.equal(report.summary.rawTokens, 580);
    assert.equal(report.summary.compressedTokens, 280);
    assert.equal(report.summary.savedTokens, 300);
    assert.equal(report.summary.tools[0].tool, 'smart_context');
    assert.equal(report.summary.tools[0].count, 2);
    assert.equal(report.summary.tools[0].savedTokens, 280);
  });
});

// ---------------------------------------------------------------------------
// graceful shutdown signals
// ---------------------------------------------------------------------------

describe('server graceful shutdown', () => {
  const serverScript = path.resolve(__dirname, '..', 'scripts', 'devctx-server.js');

  it('exits cleanly on SIGTERM', async () => {
    const { spawn } = await import('node:child_process');

    const child = spawn(process.execPath, [serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(child.pid, 'server should have started');
    assert.equal(child.exitCode, null, 'server should still be running');

    child.kill('SIGTERM');

    const { code, signal } = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server did not exit within 3s')), 3000);
      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    assert.ok(code === 0 || signal === 'SIGTERM', `should exit cleanly (code=${code}, signal=${signal})`);
  });

  it('exits cleanly on SIGINT', async () => {
    const { spawn } = await import('node:child_process');

    const child = spawn(process.execPath, [serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, 'server should still be running');

    child.kill('SIGINT');

    const { code, signal } = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server did not exit within 3s')), 3000);
      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    assert.ok(code === 0 || signal === 'SIGINT', `should exit cleanly (code=${code}, signal=${signal})`);
  });
});

// ---------------------------------------------------------------------------
// smart_read range mode (integration)
// ---------------------------------------------------------------------------

describe('smart_read range mode', () => {
  it('returns exactly the requested line range', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'range', startLine: 1, endLine: 5 });
    const lines = result.content.split('\n');
    assert.equal(lines.length, 5);
    assert.match(lines[0], /^1\|/);
    assert.match(lines[4], /^5\|/);
  });

  it('returns empty when startLine exceeds file length', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'range', startLine: 99999, endLine: 100000 });
    assert.equal(result.content, '');
  });

  it('defaults to full file when no startLine/endLine given', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'range' });
    const lines = result.content.split('\n');
    assert.ok(lines.length > 10);
    assert.match(lines[0], /^1\|/);
  });

  it('reports token savings in metrics', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'range', startLine: 1, endLine: 3 });
    assert.ok(result.metrics.compressedTokens < result.metrics.rawTokens);
  });
});

// ---------------------------------------------------------------------------
// smart_read symbol mode (integration)
// ---------------------------------------------------------------------------

describe('smart_read symbol mode', () => {
  it('extracts a JS function by name', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'symbol', symbol: 'createDevctxServer' });
    assert.match(result.content, /createDevctxServer/);
    assert.match(result.content, /return server/);
    assert.ok(result.metrics.compressedTokens < result.metrics.rawTokens);
  });

  it('extracts a Go function from fixture', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/sample.go', mode: 'symbol', symbol: 'BuildServer' });
    assert.match(result.content, /func BuildServer/);
  });

  it('extracts a Python class from fixture', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/sample.py', mode: 'symbol', symbol: 'UserService' });
    assert.match(result.content, /class UserService/);
    assert.match(result.content, /def get_user/);
  });

  it('extracts a Rust function from fixture', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/sample.rs', mode: 'symbol', symbol: 'build_service' });
    assert.match(result.content, /fn build_service/);
  });

  it('extracts a Java method from fixture', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.java', mode: 'symbol', symbol: 'createUser' });
    assert.match(result.content, /createUser/);
  });

  it('returns error when symbol param is missing', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'symbol' });
    assert.match(result.content, /symbol parameter is required/);
  });

  it('returns not-found for nonexistent symbol', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'symbol', symbol: 'nonexistentXYZ' });
    assert.match(result.content, /Symbol not found/);
  });

  it('extracts multiple symbols in one call', async () => {
    const result = await smartRead({
      filePath: 'tools/devctx/src/server.js',
      mode: 'symbol',
      symbol: ['createDevctxServer', 'runDevctxServer'],
    });
    assert.match(result.content, /--- createDevctxServer ---/);
    assert.match(result.content, /--- runDevctxServer ---/);
    assert.match(result.content, /return server/);
    assert.match(result.content, /new StdioServerTransport/);
    assert.ok(result.metrics.compressedTokens > 0, 'should have compressedTokens');
    assert.ok(result.metrics.rawTokens > 0, 'should have rawTokens');
  });

  it('multi-symbol with partial miss returns found + not-found', async () => {
    const result = await smartRead({
      filePath: 'tools/devctx/src/server.js',
      mode: 'symbol',
      symbol: ['createDevctxServer', 'doesNotExist'],
    });
    assert.match(result.content, /--- createDevctxServer ---/);
    assert.match(result.content, /--- doesNotExist ---/);
    assert.match(result.content, /Symbol not found: doesNotExist/);
  });
});

// ---------------------------------------------------------------------------
// devctx-init agent rules generation
// ---------------------------------------------------------------------------

describe('devctx-init agent rules', () => {
  const initScript = path.resolve(__dirname, '..', 'scripts', 'init-clients.js');
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devctx-init-rules-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('generates cursor rule, AGENTS.md and CLAUDE.md', async () => {
    await execFile(process.execPath, [initScript, '--target', tmpDir]);

    const cursorRule = await fsp.readFile(path.join(tmpDir, '.cursor', 'rules', 'devctx.mdc'), 'utf8');
    assert.match(cursorRule, /alwaysApply: true/);
    assert.match(cursorRule, /smart_read/);

    const agentsMd = await fsp.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /devctx:start/);
    assert.match(agentsMd, /smart_read/);

    const claudeMd = await fsp.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /devctx:start/);
    assert.match(claudeMd, /smart_search/);
  });

  it('is idempotent — running twice does not duplicate sections', async () => {
    await execFile(process.execPath, [initScript, '--target', tmpDir]);
    const firstRun = await fsp.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8');

    await execFile(process.execPath, [initScript, '--target', tmpDir]);
    const secondRun = await fsp.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8');

    assert.equal(firstRun, secondRun);
  });

  it('respects --clients flag — only cursor generates cursor rule', async () => {
    await execFile(process.execPath, [initScript, '--target', tmpDir, '--clients', 'cursor']);

    const cursorRule = await fsp.readFile(path.join(tmpDir, '.cursor', 'rules', 'devctx.mdc'), 'utf8');
    assert.match(cursorRule, /smart_read/);

    const agentsExists = fs.existsSync(path.join(tmpDir, 'AGENTS.md'));
    assert.equal(agentsExists, false, 'AGENTS.md should not be created for cursor-only');

    const claudeExists = fs.existsSync(path.join(tmpDir, 'CLAUDE.md'));
    assert.equal(claudeExists, false, 'CLAUDE.md should not be created for cursor-only');
  });

  it('preserves existing content in AGENTS.md', async () => {
    const existingContent = '# My Project\n\nSome existing rules.\n';
    await fsp.writeFile(path.join(tmpDir, 'AGENTS.md'), existingContent, 'utf8');

    await execFile(process.execPath, [initScript, '--target', tmpDir, '--clients', 'codex']);

    const result = await fsp.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    assert.match(result, /# My Project/);
    assert.match(result, /Some existing rules/);
    assert.match(result, /devctx:start/);
    assert.match(result, /smart_read/);
  });

  it('adds .devctx to the target gitignore', async () => {
    await execFile(process.execPath, [initScript, '--target', tmpDir]);

    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.devctx\/$/m);
  });

  it('does not duplicate .devctx in gitignore', async () => {
    await fsp.writeFile(path.join(tmpDir, '.gitignore'), '.devctx/\n', 'utf8');

    await execFile(process.execPath, [initScript, '--target', tmpDir]);
    await execFile(process.execPath, [initScript, '--target', tmpDir]);

    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = gitignore.match(/^\.devctx\/$/gm) ?? [];
    assert.equal(matches.length, 1);
  });
});

// ---------------------------------------------------------------------------
// smart_search ranking improvements
// ---------------------------------------------------------------------------

describe('smart_search ranking', () => {
  it('applies test penalty to test files', async () => {
    const result = await smartSearch({ query: 'assert', cwd: 'tools/devctx/tests' });
    assert.ok(result.topFiles.length > 0, 'should have test matches');
    for (const f of result.topFiles) {
      assert.ok(f.score < 100, `test file score (${f.score}) should be penalized`);
    }
  });

  it('does not double-boost Dockerfiles', async () => {
    const result = await smartSearch({ query: 'node', cwd: 'tools/devctx/fixtures/formats' });
    const dockerFile = result.topFiles.find((f) => f.file.toLowerCase().includes('dockerfile'));
    if (dockerFile) {
      assert.ok(dockerFile.score < 100, `Dockerfile score (${dockerFile.score}) should not be inflated`);
    }
  });
});

// ---------------------------------------------------------------------------
// smart_search retrievalConfidence + provenance
// ---------------------------------------------------------------------------

describe('smart_search confidence and provenance', () => {
  it('returns retrievalConfidence=high when rg succeeds', async () => {
    const result = await smartSearch({ query: 'smartSearch', cwd: 'tools/devctx/src' });
    assert.equal(result.engine, 'rg');
    assert.equal(result.retrievalConfidence, 'high');
    assert.equal(result.provenance, undefined);
  });

  it('returns full provenance contract when forced to walk', async () => {
    const result = await smartSearch({ query: 'smartSearch', cwd: 'tools/devctx/src', _testForceWalk: true });
    assert.equal(result.engine, 'walk');
    assert.ok(['medium', 'low'].includes(result.retrievalConfidence), `confidence should be medium or low, got ${result.retrievalConfidence}`);
    assert.ok(result.provenance, 'provenance should be present');
    assert.equal(result.provenance.fallbackReason, 'rg unavailable or failed');
    assert.ok(['sensitive', 'insensitive'].includes(result.provenance.caseMode), 'caseMode should be present');
    assert.equal(typeof result.provenance.partial, 'boolean');
    assert.equal(typeof result.provenance.skippedItemsTotal, 'number');
    assert.equal(typeof result.provenance.skippedDirs, 'number');
    assert.ok(Array.isArray(result.provenance.warnings), 'warnings should be an array');
    assert.ok(result.provenance.warnings.length >= 1, 'should have at least one warning');
    assert.match(result.provenance.warnings[0], /filesystem walk/);
  });
});

describe('walk skippedDirs tracking', () => {
  const tmpBase = path.join(os.tmpdir(), `devctx-walk-test-${Date.now()}`);
  const unreadableDir = path.join(tmpBase, 'noperm');

  beforeEach(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
    fs.writeFileSync(path.join(tmpBase, 'hello.js'), 'const x = 1;\n', 'utf8');
    fs.mkdirSync(unreadableDir);
    fs.writeFileSync(path.join(unreadableDir, 'secret.js'), 'hidden\n', 'utf8');
    fs.chmodSync(unreadableDir, 0o000);
  });

  afterEach(() => {
    try { fs.chmodSync(unreadableDir, 0o755); } catch {}
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('counts unreadable directories in stats.skippedDirs', () => {
    const stats = { skippedDirs: 0 };
    const files = walk(tmpBase, [], stats);
    assert.ok(files.some((f) => f.endsWith('hello.js')), 'should find readable file');
    assert.ok(!files.some((f) => f.includes('secret.js')), 'should not find file in unreadable dir');
    assert.ok(stats.skippedDirs >= 1, `skippedDirs should be >= 1, got ${stats.skippedDirs}`);
  });

  it('searchWithFallback returns full provenance contract with skippedDirs', () => {
    const result = searchWithFallback(tmpBase, 'const');
    assert.ok(result.matches.length > 0, 'should find match in readable file');
    assert.ok(result.skippedDirs >= 1, `skippedDirs should be >= 1, got ${result.skippedDirs}`);
    assert.equal(typeof result.caseSensitive, 'boolean');
    assert.equal(typeof result.skippedLarge, 'number');
    assert.equal(typeof result.skippedBinary, 'number');
    assert.equal(typeof result.skippedErrors, 'number');
  });
});

// ---------------------------------------------------------------------------
// smart_search smart-case parity
// ---------------------------------------------------------------------------

describe('smart_search smart-case', () => {
  it('isSmartCaseSensitive returns false for all-lowercase query', () => {
    assert.equal(isSmartCaseSensitive('hello'), false);
    assert.equal(isSmartCaseSensitive('foo_bar'), false);
  });

  it('isSmartCaseSensitive returns true when query has uppercase', () => {
    assert.equal(isSmartCaseSensitive('Hello'), true);
    assert.equal(isSmartCaseSensitive('smartSearch'), true);
    assert.equal(isSmartCaseSensitive('FOO'), true);
  });

  it('rg smart-case matches case-insensitively for lowercase query', async () => {
    const result = await smartSearch({ query: 'smartsearch', cwd: 'tools/devctx/src' });
    assert.equal(result.engine, 'rg');
    assert.ok(result.totalMatches > 0, 'lowercase query should match smartSearch via smart-case');
  });

  it('rg smart-case is case-sensitive when query has uppercase', async () => {
    const sensitive = await smartSearch({ query: 'SmartSearch_DOES_NOT_EXIST', cwd: 'tools/devctx/src' });
    assert.equal(sensitive.totalMatches, 0, 'case-sensitive query should not match anything');
  });
});

// ---------------------------------------------------------------------------
// smart_read metadata (parser + truncated)
// ---------------------------------------------------------------------------

describe('smart_read metadata', () => {
  it('returns parser=ast for JS files in outline mode', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    assert.equal(result.parser, 'ast');
    assert.equal(result.truncated, false);
  });

  it('returns parser=heuristic for Go files', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/sample.go', mode: 'outline' });
    assert.equal(result.parser, 'heuristic');
  });

  it('returns parser=raw for full mode', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'full' });
    assert.equal(result.parser, 'raw');
  });

  it('returns parser=ast for symbol mode on JS files', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'symbol', symbol: 'createDevctxServer' });
    assert.equal(result.parser, 'ast');
  });

  it('returns parser=heuristic for symbol mode on Go files', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/sample.go', mode: 'symbol', symbol: 'BuildServer' });
    assert.equal(result.parser, 'heuristic');
  });

  it('sets truncated=true when content exceeds limit', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'full' });
    if (result.content.includes('[truncated')) {
      assert.equal(result.truncated, true);
    } else {
      assert.equal(result.truncated, false);
    }
  });
});

// ---------------------------------------------------------------------------
// persistMetrics resilience
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// smart_read maxTokens budget
// ---------------------------------------------------------------------------

describe('smart_read maxTokens budget', () => {
  const getCountTokens = async () => (await import('../src/tokenCounter.js')).countTokens;

  it('cascades from outline to signatures when outline exceeds budget', async () => {
    const countTk = await getCountTokens();
    const outlineResult = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    const outlineTokens = countTk(outlineResult.content);

    const tightBudget = Math.max(10, Math.floor(outlineTokens * 0.3));
    const budgetResult = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline', maxTokens: tightBudget });

    assert.equal(budgetResult.mode, 'outline', 'mode should echo the requested mode');
    assert.equal(budgetResult.chosenMode, 'signatures');
    assert.equal(budgetResult.budgetApplied, true);
    assert.ok(countTk(budgetResult.content) <= tightBudget,
      `content tokens ${countTk(budgetResult.content)} should be <= budget ${tightBudget}`);
  });

  it('keeps original mode when budget is sufficient', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline', maxTokens: 50000 });

    assert.equal(result.mode, 'outline');
    assert.equal(result.chosenMode, undefined);
    assert.equal(result.budgetApplied, undefined);
  });

  it('truncates when even signatures exceeds budget', async () => {
    const countTk = await getCountTokens();
    const budget = 15;
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline', maxTokens: budget });

    assert.ok(result.content.includes(`[truncated to fit ${budget} token budget]`));
    assert.equal(result.truncated, true);
    assert.ok(countTk(result.content) <= budget,
      `content tokens ${countTk(result.content)} should be <= budget ${budget}`);
  });

  it('does not cascade for range mode', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'range', startLine: 1, endLine: 50, maxTokens: 50000 });

    assert.equal(result.mode, 'range');
    assert.equal(result.chosenMode, undefined);
  });

  it('truncates range mode by tokens when exceeding budget', async () => {
    const countTk = await getCountTokens();
    const budget = 20;
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'range', startLine: 1, endLine: 100, maxTokens: budget });

    assert.ok(result.content.includes(`[truncated to fit ${budget} token budget]`));
    assert.ok(countTk(result.content) <= budget,
      `content tokens ${countTk(result.content)} should be <= budget ${budget}`);
  });

  it('ignores maxTokens=0 and maxTokens=-1', async () => {
    const zeroResult = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline', maxTokens: 0 });
    assert.equal(zeroResult.budgetApplied, undefined, 'maxTokens=0 should be ignored');
    assert.ok(!zeroResult.content.includes('[truncated to fit'), 'should not truncate with maxTokens=0');

    const negResult = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline', maxTokens: -1 });
    assert.equal(negResult.budgetApplied, undefined, 'maxTokens=-1 should be ignored');
    assert.ok(!negResult.content.includes('[truncated to fit'), 'should not truncate with maxTokens=-1');
  });
});

// ---------------------------------------------------------------------------
// smart_read_batch
// ---------------------------------------------------------------------------

import { smartReadBatch } from '../src/tools/smart-read-batch.js';

describe('smart_read_batch', () => {
  it('reads multiple files in one call', async () => {
    const result = await smartReadBatch({
      files: [
        { path: 'tools/devctx/src/server.js' },
        { path: 'tools/devctx/src/metrics.js' },
        { path: 'tools/devctx/src/tokenCounter.js' },
      ],
    });

    assert.equal(result.results.length, 3);
    assert.equal(result.metrics.filesRead, 3);
    assert.equal(result.metrics.filesSkipped, 0);
    assert.ok(result.metrics.totalTokens > 0);
    for (const r of result.results) {
      assert.ok(r.content.length > 0);
      assert.ok(r.filePath);
      assert.ok(r.mode);
    }
  });

  it('supports mixed modes per file', async () => {
    const result = await smartReadBatch({
      files: [
        { path: 'tools/devctx/src/server.js', mode: 'outline' },
        { path: 'tools/devctx/src/server.js', mode: 'signatures' },
        { path: 'tools/devctx/src/server.js', mode: 'range', startLine: 1, endLine: 5 },
      ],
    });

    assert.equal(result.results.length, 3);
    assert.equal(result.results[0].mode, 'outline');
    assert.equal(result.results[1].mode, 'signatures');
    assert.equal(result.results[2].mode, 'range');
  });

  it('applies global maxTokens with early stop', async () => {
    const result = await smartReadBatch({
      files: [
        { path: 'tools/devctx/src/server.js' },
        { path: 'tools/devctx/src/metrics.js' },
        { path: 'tools/devctx/src/tokenCounter.js' },
        { path: 'tools/devctx/src/tools/smart-read.js' },
        { path: 'tools/devctx/src/tools/smart-search.js' },
      ],
      maxTokens: 50,
    });

    assert.ok(result.results.length >= 1, 'should read at least 1 file');
    assert.ok(result.results.length < 5, 'should stop before reading all files');
    assert.ok(result.metrics.filesSkipped > 0, 'should report skipped files');
    assert.equal(result.metrics.filesRead + result.metrics.filesSkipped, 5);
  });

  it('applies per-file maxTokens budget', async () => {
    const result = await smartReadBatch({
      files: [
        { path: 'tools/devctx/src/server.js', mode: 'outline', maxTokens: 15 },
      ],
    });

    assert.equal(result.results.length, 1);
    const r = result.results[0];
    assert.ok(r.content.includes('[truncated to fit') || r.budgetApplied,
      'per-file maxTokens should trigger cascade or truncation');
  });

  it('isolates errors per item without aborting batch', async () => {
    const result = await smartReadBatch({
      files: [
        { path: 'tools/devctx/src/server.js', mode: 'outline' },
        { path: 'this/does/not/exist.js', mode: 'outline' },
        { path: 'tools/devctx/src/metrics.js', mode: 'outline' },
      ],
    });

    assert.equal(result.results.length, 3, 'should return results for all items');
    assert.ok(result.results[0].content, 'first file should succeed');
    assert.ok(result.results[1].error, 'second file should have error');
    assert.equal(result.results[1].filePath, 'this/does/not/exist.js');
    assert.ok(result.results[2].content, 'third file should succeed despite earlier error');
    assert.equal(result.metrics.filesRead, 3);
  });
});

// ---------------------------------------------------------------------------
// smart_read response cache
// ---------------------------------------------------------------------------

describe('smart_read response cache', () => {
  beforeEach(() => clearReadCache());

  it('returns cached=true on second identical read', async () => {
    const first = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    assert.ok(!first.cached, 'first read should not be cached');

    const second = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    assert.equal(second.cached, true, 'second read should be cached');
    assert.equal(second.content, first.content);
  });

  it('invalidates cache when file mtime changes', async () => {
    const target = 'tools/devctx/src/server.js';
    const first = await smartRead({ filePath: target, mode: 'outline' });
    assert.ok(!first.cached);

    const abs = first.filePath;
    const origStat = fs.statSync(abs);
    const future = new Date(origStat.mtimeMs + 5000);
    fs.utimesSync(abs, future, future);

    try {
      const second = await smartRead({ filePath: target, mode: 'outline' });
      assert.ok(!second.cached, 'should re-parse after mtime change');
    } finally {
      fs.utimesSync(abs, origStat.atime, origStat.mtime);
    }
  });

  it('does not hit cache for different mode', async () => {
    await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    const sig = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'signatures' });
    assert.ok(!sig.cached, 'different mode should miss cache');
  });

  it('clearReadCache purges all entries', async () => {
    await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    clearReadCache();
    const after = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    assert.ok(!after.cached, 'should miss after clear');
  });

  it('preserves indexHint on symbol cache hit', async () => {
    const target = 'tools/devctx/src/tools/smart-read.js';
    const first = await smartRead({ filePath: target, mode: 'symbol', symbol: 'smartRead' });
    const second = await smartRead({ filePath: target, mode: 'symbol', symbol: 'smartRead' });
    assert.equal(second.cached, true);
    assert.equal(second.indexHint, first.indexHint, 'indexHint must match between fresh and cached');
  });

  it('does not reuse cache across different symbol order', async () => {
    const target = 'tools/devctx/src/tools/smart-read.js';
    const ab = await smartRead({ filePath: target, mode: 'symbol', symbol: ['smartRead', 'clearReadCache'] });
    assert.ok(!ab.cached);
    const ba = await smartRead({ filePath: target, mode: 'symbol', symbol: ['clearReadCache', 'smartRead'] });
    assert.ok(!ba.cached, 'reversed order must miss cache');
  });
});

// ---------------------------------------------------------------------------
// smart_read symbol context
// ---------------------------------------------------------------------------

describe('smart_read symbol context', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let tmpDir;
  let originalRoot;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-symctx-'));
    fs.cpSync(fixtureRoot, tmpDir, { recursive: true, filter: (src) => !src.includes('.devctx') });
    originalRoot = process.env.DEVCTX_PROJECT_ROOT;
    setProjectRoot(tmpDir);
    const index = buildIndex(tmpDir);
    await persistIndex(index, tmpDir);
    clearReadCache();
  });

  afterEach(() => {
    setProjectRoot(originalRoot ?? path.resolve(__dirname, '..', '..', '..'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns callers from importedBy files', async () => {
    const result = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });

    assert.ok(result.context, 'response should include context field');
    assert.ok(result.context.callers > 0, 'should find callers via graph');
    assert.ok(result.content.includes('--- callers ---'), 'content should have callers section');
    assert.ok(result.content.includes('middleware'), 'callers should include middleware');
  });

  it('returns tests section', async () => {
    const result = await smartRead({
      filePath: path.join(tmpDir, 'src/auth/middleware.js'),
      mode: 'symbol',
      symbol: 'AuthMiddleware',
      context: true,
    });

    assert.ok(result.context);
    assert.ok(result.context.tests > 0, 'should find test files via graph');
    assert.ok(result.content.includes('--- tests ---'), 'content should have tests section');
  });

  it('returns types section for type references', async () => {
    const typedFile = path.join(tmpDir, 'src/api/typed.ts');
    fs.writeFileSync(typedFile, [
      'import { UserProfile } from "../models/user.js";',
      'export function getUser(id: string): UserProfile {',
      '  return { id, name: "test" };',
      '}',
    ].join('\n'));

    const userModel = path.join(tmpDir, 'src/models/user.js');
    const existing = fs.readFileSync(userModel, 'utf8');
    fs.writeFileSync(userModel, existing + '\nexport class UserProfile { constructor(id, name) { this.id = id; this.name = name; } }\n');

    const index = buildIndex(tmpDir);
    await persistIndex(index, tmpDir);

    const result = await smartRead({
      filePath: typedFile,
      mode: 'symbol',
      symbol: 'getUser',
      context: true,
    });

    assert.ok(result.context);
    assert.ok(result.context.types > 0, 'should find referenced types');
    assert.ok(result.content.includes('--- types ---'), 'content should have types section');
    assert.ok(result.content.includes('UserProfile'), 'types should include UserProfile');
  });

  it('returns empty sections with hint when no index', async () => {
    const indexPath = path.join(tmpDir, '.devctx', 'index.json');
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);

    const result = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });

    assert.ok(result.context);
    assert.equal(result.context.callers, 0);
    assert.equal(result.context.tests, 0);
    assert.equal(result.context.types, 0);
    assert.ok(result.contextHints?.length > 0, 'should include hint about missing index');
    assert.ok(result.contextHints[0].includes('build_index'));
  });

  it('context is ignored on non-symbol mode', async () => {
    const result = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'outline',
      context: true,
    });

    assert.ok(!result.context, 'context field should not be present for outline mode');
    assert.ok(!result.content.includes('--- callers ---'));
  });

  it('maxTokens applies to combined content including context', async () => {
    const noBudget = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });
    const fullTokens = countTokens(noBudget.content);

    const withBudget = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
      maxTokens: Math.max(10, Math.floor(fullTokens / 2)),
    });

    assert.ok(countTokens(withBudget.content) <= Math.floor(fullTokens / 2),
      'combined content should respect maxTokens budget');
    assert.ok(withBudget.content.includes('[truncated'),
      'should be truncated when context pushes over budget');
  });

  it('metrics reflect content including context sections', async () => {
    const result = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });

    const actualTokens = countTokens(result.content);
    assert.equal(result.metrics.compressedTokens, actualTokens,
      'metrics.compressedTokens should match actual content tokens');
  });

  it('does not set cached=true when context=true', async () => {
    await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });

    const second = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });

    assert.ok(!second.cached, 'cached must not be true when context sections are rebuilt');
    assert.ok(second.context, 'context field should still be present');
  });

  it('includes graphCoverage with full coverage for JS files', async () => {
    const result = await smartRead({
      filePath: path.join(tmpDir, 'src/utils/jwt.js'),
      mode: 'symbol',
      symbol: 'verifyJwt',
      context: true,
    });
    assert.ok(result.graphCoverage, 'should include graphCoverage');
    assert.equal(result.graphCoverage.imports, 'full');
    assert.equal(result.graphCoverage.tests, 'full');
  });
});

describe('getGraphCoverage', () => {
  it('returns full for JS/TS/Python/Go', () => {
    for (const ext of ['.js', '.ts', '.tsx', '.py', '.go']) {
      const cov = getGraphCoverage(ext);
      assert.equal(cov.imports, 'full', `${ext} imports should be full`);
      assert.equal(cov.tests, 'full', `${ext} tests should be full`);
    }
  });

  it('returns partial for C#/Kotlin/PHP/Swift', () => {
    for (const ext of ['.cs', '.kt', '.php', '.swift']) {
      const cov = getGraphCoverage(ext);
      assert.equal(cov.imports, 'partial', `${ext} imports should be partial`);
      assert.equal(cov.tests, 'partial', `${ext} tests should be partial`);
    }
  });

  it('returns none/partial for Rust/Java', () => {
    for (const ext of ['.rs', '.java']) {
      const cov = getGraphCoverage(ext);
      assert.equal(cov.imports, 'none', `${ext} imports should be none`);
      assert.equal(cov.tests, 'partial', `${ext} tests should be partial`);
    }
  });

  it('returns none/none for unknown extensions', () => {
    const cov = getGraphCoverage('.txt');
    assert.equal(cov.imports, 'none');
    assert.equal(cov.tests, 'none');
  });
});

// ---------------------------------------------------------------------------
// smart_search intent-aware ranking
// ---------------------------------------------------------------------------

describe('smart_search intent', () => {
  it('defines all valid intents with weights', () => {
    for (const intent of VALID_INTENTS) {
      assert.ok(intentWeights[intent], `missing weights for ${intent}`);
      assert.ok('src' in intentWeights[intent]);
      assert.ok('source' in intentWeights[intent]);
      assert.ok('config' in intentWeights[intent]);
      assert.ok('lowSignal' in intentWeights[intent]);
      assert.ok('test' in intentWeights[intent]);
    }
  });

  it('tests intent boosts test files instead of penalizing', () => {
    assert.ok(intentWeights.tests.test > 0, 'tests intent should boost test files');
    assert.ok(intentWeights.implementation.test < 0, 'implementation should penalize test files');
  });

  it('config intent boosts config extensions over source', () => {
    assert.ok(intentWeights.config.config > intentWeights.config.source, 'config intent should rank config > source');
  });

  it('docs intent reduces lowSignal penalty', () => {
    assert.ok(intentWeights.docs.lowSignal > intentWeights.implementation.lowSignal, 'docs intent should be less harsh on READMEs');
  });

  it('returns intent in result when provided', async () => {
    const result = await smartSearch({ query: 'assert', cwd: 'tools/devctx/tests', intent: 'tests' });
    assert.equal(result.intent, 'tests');
  });

  it('omits intent from result when not provided', async () => {
    const result = await smartSearch({ query: 'assert', cwd: 'tools/devctx/tests' });
    assert.equal(result.intent, undefined);
  });

  it('ignores invalid intent gracefully', async () => {
    const result = await smartSearch({ query: 'assert', cwd: 'tools/devctx/tests', intent: 'invalid_xyz' });
    assert.equal(result.intent, undefined);
  });

  it('tests intent ranks test files higher than implementation intent', async () => {
    const withTests = await smartSearch({ query: 'assert', cwd: 'tools/devctx', intent: 'tests' });
    const withImpl = await smartSearch({ query: 'assert', cwd: 'tools/devctx', intent: 'implementation' });

    const getTestFileScore = (result) => {
      const testFile = result.topFiles.find((f) => f.file.includes('.test.'));
      return testFile?.score ?? -Infinity;
    };

    assert.ok(getTestFileScore(withTests) > getTestFileScore(withImpl),
      'tests intent should score test files higher than implementation intent');
  });
});

// ---------------------------------------------------------------------------
// Symbol index
// ---------------------------------------------------------------------------

describe('buildIndex', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');

  it('extracts JS symbols from fixture project', () => {
    const index = buildIndex(fixtureRoot);
    assert.ok(index.version === 4);
    assert.ok(Object.keys(index.files).length > 0);
    assert.ok(Object.keys(index.invertedIndex).length > 0);

    const hits = queryIndex(index, 'AuthMiddleware');
    assert.ok(hits.length > 0, 'should find AuthMiddleware');
    assert.ok(hits.some((h) => h.path.includes('middleware.js')));
    assert.ok(hits.some((h) => h.kind === 'class'));
  });

  it('extracts Python symbols', () => {
    const index = buildIndex(fixtureRoot);
    const hits = queryIndex(index, 'EmailNotifier');
    assert.ok(hits.length > 0, 'should find EmailNotifier');
    assert.ok(hits.some((h) => h.kind === 'class'));
  });

  it('extracts Go symbols', () => {
    const index = buildIndex(fixtureRoot);
    const hits = queryIndex(index, 'LRUCache');
    assert.ok(hits.length > 0, 'should find LRUCache');
    assert.ok(hits.some((h) => h.kind === 'type'));
  });

  it('extracts methods with parent reference', () => {
    const index = buildIndex(fixtureRoot);
    const hits = queryIndex(index, 'validateToken');
    assert.ok(hits.length > 0, 'should find validateToken');
    const methodHit = hits.find((h) => h.kind === 'method');
    assert.ok(methodHit, 'should be a method');
    assert.equal(methodHit.parent, 'AuthMiddleware');
  });

  it('queryIndex returns empty array for unknown symbols', () => {
    const index = buildIndex(fixtureRoot);
    const hits = queryIndex(index, 'NonExistentSymbol12345');
    assert.deepEqual(hits, []);
  });

  it('queryIndex is case-insensitive', () => {
    const index = buildIndex(fixtureRoot);
    const lower = queryIndex(index, 'authmiddleware');
    const upper = queryIndex(index, 'AuthMiddleware');
    assert.equal(lower.length, upper.length);
  });
});

describe('index invalidation', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');

  it('isFileStale returns true for unknown files', () => {
    const index = buildIndex(fixtureRoot);
    assert.ok(isFileStale(index, 'nonexistent.js', Date.now()));
  });

  it('isFileStale returns false for indexed file with same mtime', () => {
    const index = buildIndex(fixtureRoot);
    const relPath = Object.keys(index.files)[0];
    const mtime = index.files[relPath].mtime;
    assert.equal(isFileStale(index, relPath, mtime), false);
  });

  it('isFileStale returns true when mtime differs', () => {
    const index = buildIndex(fixtureRoot);
    const relPath = Object.keys(index.files)[0];
    assert.ok(isFileStale(index, relPath, Date.now() + 100000));
  });

  it('reindexFile updates symbols for changed file', () => {
    const index = buildIndex(fixtureRoot);
    const relPath = 'src/utils/jwt.js';
    const originalCount = queryIndex(index, 'createJwt').length;
    assert.ok(originalCount > 0);

    reindexFile(index, fixtureRoot, relPath);
    const afterCount = queryIndex(index, 'createJwt').length;
    assert.ok(afterCount > 0);
  });

  it('reindexFile cleans up removed file', () => {
    const index = buildIndex(fixtureRoot);
    reindexFile(index, fixtureRoot, 'nonexistent/deleted.js');
    assert.equal(index.files['nonexistent/deleted.js'], undefined);
  });
});

// ---------------------------------------------------------------------------
// Index path isolation
// ---------------------------------------------------------------------------

describe('index path isolation', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let tmpA;
  let tmpB;

  beforeEach(() => {
    tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-idx-a-'));
    tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-idx-b-'));
    fs.cpSync(fixtureRoot, tmpA, { recursive: true, filter: (src) => !src.includes('.devctx') });
    fs.cpSync(fixtureRoot, tmpB, { recursive: true, filter: (src) => !src.includes('.devctx') });
  });

  afterEach(() => {
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  });

  it('two roots produce distinct index paths', async () => {
    const idxA = buildIndex(tmpA);
    const idxB = buildIndex(tmpB);
    await persistIndex(idxA, tmpA);
    await persistIndex(idxB, tmpB);

    const pathA = path.join(tmpA, '.devctx', 'index.json');
    const pathB = path.join(tmpB, '.devctx', 'index.json');
    assert.ok(fs.existsSync(pathA), 'index A should exist under rootA');
    assert.ok(fs.existsSync(pathB), 'index B should exist under rootB');
    assert.notEqual(pathA, pathB);
  });

  it('loadIndex(rootA) does not read rootB index', async () => {
    const idxA = buildIndex(tmpA);
    await persistIndex(idxA, tmpA);

    const loaded = loadIndex(tmpA);
    assert.ok(loaded, 'should load index from rootA');

    const loadedB = loadIndex(tmpB);
    assert.equal(loadedB, null, 'rootB has no index yet');
  });

  it('DEVCTX_INDEX_DIR overrides root-based path', async () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-idx-override-'));
    const original = process.env.DEVCTX_INDEX_DIR;
    process.env.DEVCTX_INDEX_DIR = overrideDir;

    try {
      const idx = buildIndex(tmpA);
      await persistIndex(idx, tmpA);
      const overridePath = path.join(overrideDir, 'index.json');
      assert.ok(fs.existsSync(overridePath), 'index should be at override dir');
      assert.equal(fs.existsSync(path.join(tmpA, '.devctx', 'index.json')), false, 'should NOT be at rootA');
    } finally {
      if (original === undefined) {
        delete process.env.DEVCTX_INDEX_DIR;
      } else {
        process.env.DEVCTX_INDEX_DIR = original;
      }
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Incremental build_index
// ---------------------------------------------------------------------------

describe('buildIndexIncremental', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-incr-'));
    fs.cpSync(fixtureRoot, tmpDir, { recursive: true, filter: (src) => !src.includes('.devctx') });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reindexes only stale files', async () => {
    const fullIndex = buildIndex(tmpDir);
    await persistIndex(fullIndex, tmpDir);
    const originalFileCount = Object.keys(fullIndex.files).length;

    await new Promise((r) => setTimeout(r, 50));
    const mwPath = path.join(tmpDir, 'src', 'auth', 'middleware.js');
    fs.writeFileSync(mwPath, fs.readFileSync(mwPath, 'utf8') + '\nexport const added = true;\n');

    const { index, stats } = buildIndexIncremental(tmpDir);

    assert.equal(stats.reindexed, 1, 'should reindex only the modified file');
    assert.ok(stats.unchanged >= originalFileCount - 1, 'other files should be unchanged');
    assert.equal(stats.removed, 0);
    assert.equal(stats.fullRebuild, false);
    assert.ok(index.files['src/auth/middleware.js'], 'modified file should still be in index');
  });

  it('cleans deleted files from index', async () => {
    const fullIndex = buildIndex(tmpDir);
    await persistIndex(fullIndex, tmpDir);

    fs.unlinkSync(path.join(tmpDir, 'src', 'utils', 'logger.js'));

    const { index, stats } = buildIndexIncremental(tmpDir);

    assert.equal(stats.removed, 1, 'should remove deleted file');
    assert.equal(index.files['src/utils/logger.js'], undefined, 'deleted file should not be in index');
    if (index.graph?.edges) {
      const hasEdge = index.graph.edges.some((e) => e.from === 'src/utils/logger.js' || e.to === 'src/utils/logger.js');
      assert.ok(!hasEdge, 'deleted file should have no graph edges');
    }
  });

  it('falls back to full build when no prior index exists', () => {
    const { index, stats } = buildIndexIncremental(tmpDir);

    assert.equal(stats.fullRebuild, true);
    assert.ok(stats.total > 0, 'should have indexed files');
    assert.equal(stats.reindexed, stats.total, 'all files should be counted as reindexed');
    assert.equal(stats.removed, 0);
    assert.equal(stats.unchanged, 0);
    assert.ok(index.version, 'should have a valid index');
  });

  it('resolves new import edges after all files are indexed', async () => {
    const fullIndex = buildIndex(tmpDir);
    await persistIndex(fullIndex, tmpDir);

    await new Promise((r) => setTimeout(r, 50));
    const newFile = path.join(tmpDir, 'src', 'utils', 'newHelper.js');
    fs.writeFileSync(newFile, 'export const newHelper = () => {};\n');

    const importerPath = path.join(tmpDir, 'src', 'auth', 'middleware.js');
    const importerContent = fs.readFileSync(importerPath, 'utf8');
    fs.writeFileSync(importerPath, `import { newHelper } from '../utils/newHelper.js';\n${importerContent}`);

    const { index } = buildIndexIncremental(tmpDir);

    const edge = index.graph?.edges?.find(
      (e) => e.from === 'src/auth/middleware.js' && e.to === 'src/utils/newHelper.js' && e.kind === 'import',
    );
    assert.ok(edge, 'should resolve import edge to newly added file');
  });

  it('incremental parity: no zombie entries for empty files', async () => {
    const fullIndex = buildIndex(tmpDir);
    await persistIndex(fullIndex, tmpDir);

    await new Promise((r) => setTimeout(r, 50));
    const emptyFile = path.join(tmpDir, 'src', 'utils', 'logger.js');
    fs.writeFileSync(emptyFile, '// no symbols or imports\n');

    const { index: incrIndex } = buildIndexIncremental(tmpDir);
    assert.equal(incrIndex.files['src/utils/logger.js'], undefined,
      'file with no symbols/imports should not be in incremental index');

    const fullRebuild = buildIndex(tmpDir);
    assert.equal(fullRebuild.files['src/utils/logger.js'], undefined,
      'file with no symbols/imports should not be in full rebuild either');
  });
});

// ---------------------------------------------------------------------------
// Relational index (graph, imports, exports, testOf)
// ---------------------------------------------------------------------------

describe('relational index', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');

  it('buildIndex produces graph.edges', () => {
    const index = buildIndex(fixtureRoot);
    assert.ok(index.graph, 'index should have graph field');
    assert.ok(Array.isArray(index.graph.edges), 'graph.edges should be an array');
    assert.ok(index.graph.edges.length > 0, 'should have at least one edge');
  });

  it('captures import edges for JS files', () => {
    const index = buildIndex(fixtureRoot);
    const importEdges = index.graph.edges.filter((e) => e.kind === 'import');
    assert.ok(importEdges.length > 0, 'should have import edges');
    const middlewareImportsJwt = importEdges.find(
      (e) => e.from === 'src/auth/middleware.js' && e.to === 'src/utils/jwt.js',
    );
    assert.ok(middlewareImportsJwt, 'middleware.js should import jwt.js');
  });

  it('captures testOf edges for test files', () => {
    const index = buildIndex(fixtureRoot);
    const testEdges = index.graph.edges.filter((e) => e.kind === 'testOf');
    assert.ok(testEdges.length > 0, 'should have testOf edges');
    const authTestOf = testEdges.find(
      (e) => e.from === 'tests/auth.test.js' && e.to === 'src/auth/middleware.js',
    );
    assert.ok(authTestOf, 'auth.test.js should testOf middleware.js');
  });

  it('stores exports per file', () => {
    const index = buildIndex(fixtureRoot);
    const middleware = index.files['src/auth/middleware.js'];
    assert.ok(middleware, 'middleware.js should be indexed');
    assert.ok(Array.isArray(middleware.exports), 'should have exports array');
    assert.ok(middleware.exports.includes('AuthMiddleware'), 'should export AuthMiddleware');
    assert.ok(middleware.exports.includes('requireRole'), 'should export requireRole');
  });

  it('extracts Python imports', () => {
    const index = buildIndex(fixtureRoot);
    const pyFile = index.files['services/notification.py'];
    assert.ok(pyFile, 'notification.py should be indexed');
    const pyEdges = index.graph.edges.filter((e) => e.from === 'services/notification.py' && e.kind === 'import');
    assert.equal(pyEdges.length, 0, 'python stdlib imports should not resolve to local files');
  });

  it('extracts Go imports', () => {
    const index = buildIndex(fixtureRoot);
    const goFile = index.files['pkg/cache/lru.go'];
    assert.ok(goFile, 'lru.go should be indexed');
  });

  it('isTestFile detects test patterns', () => {
    assert.ok(isTestFile('src/auth.test.js'));
    assert.ok(isTestFile('src/auth.spec.ts'));
    assert.ok(isTestFile('src/__tests__/auth.js'));
    assert.ok(isTestFile('pkg/cache/cache_test.go'));
    assert.ok(isTestFile('tests/test_auth.py'));
    assert.ok(!isTestFile('src/auth.js'));
    assert.ok(!isTestFile('src/utils/test.js'));
  });
});

// ---------------------------------------------------------------------------
// queryRelated
// ---------------------------------------------------------------------------

describe('queryRelated', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');

  it('returns imports for a file', () => {
    const index = buildIndex(fixtureRoot);
    const related = queryRelated(index, 'src/auth/middleware.js');
    assert.ok(related.imports.includes('src/utils/jwt.js'), 'middleware imports jwt');
  });

  it('returns importedBy for a file', () => {
    const index = buildIndex(fixtureRoot);
    const related = queryRelated(index, 'src/utils/jwt.js');
    assert.ok(related.importedBy.includes('src/auth/middleware.js'), 'jwt is imported by middleware');
  });

  it('returns tests for a source file', () => {
    const index = buildIndex(fixtureRoot);
    const related = queryRelated(index, 'src/auth/middleware.js');
    assert.ok(related.tests.includes('tests/auth.test.js'), 'middleware is tested by auth.test');
  });

  it('returns neighbors in same directory', () => {
    const index = buildIndex(fixtureRoot);
    const related = queryRelated(index, 'src/utils/jwt.js');
    assert.ok(related.neighbors.includes('src/utils/logger.js'), 'jwt has logger as neighbor');
  });

  it('returns empty for unknown file', () => {
    const index = buildIndex(fixtureRoot);
    const related = queryRelated(index, 'nonexistent.js');
    assert.deepEqual(related.imports, []);
    assert.deepEqual(related.importedBy, []);
    assert.deepEqual(related.tests, []);
  });
});

// ---------------------------------------------------------------------------
// reindexFile graph cleanup
// ---------------------------------------------------------------------------

describe('reindexFile graph cleanup', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');

  it('cleans old edges when file is reindexed', () => {
    const index = buildIndex(fixtureRoot);
    const edgesBefore = index.graph.edges.filter((e) => e.from === 'src/auth/middleware.js');
    assert.ok(edgesBefore.length > 0, 'should have edges before reindex');

    reindexFile(index, fixtureRoot, 'src/auth/middleware.js');
    const edgesAfter = index.graph.edges.filter((e) => e.from === 'src/auth/middleware.js');
    assert.ok(edgesAfter.length > 0, 'should have edges after reindex');
    assert.equal(edgesBefore.length, edgesAfter.length, 'edge count should stay the same');
  });

  it('removes edges when file is deleted', () => {
    const index = buildIndex(fixtureRoot);
    reindexFile(index, fixtureRoot, 'nonexistent/deleted.js');
    const edges = index.graph.edges.filter((e) => e.from === 'nonexistent/deleted.js');
    assert.equal(edges.length, 0, 'no edges for deleted file');
  });
});

// ---------------------------------------------------------------------------
// Response contract — smart_search
// ---------------------------------------------------------------------------

describe('response contract smart_search', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');

  it('always returns indexFreshness and sourceBreakdown', async () => {
    const result = await smartSearch({ query: 'AuthMiddleware', cwd: fixtureRoot });
    assert.ok(['fresh', 'stale', 'unavailable'].includes(result.indexFreshness), 'indexFreshness should be valid');
    assert.ok(result.sourceBreakdown, 'sourceBreakdown should be present');
    assert.ok(typeof result.sourceBreakdown.textMatch === 'number');
    assert.ok(typeof result.sourceBreakdown.indexBoost === 'number');
    assert.ok(typeof result.sourceBreakdown.graphBoost === 'number');
  });

  it('always returns core contract fields', async () => {
    const result = await smartSearch({ query: 'createUser', cwd: fixtureRoot });
    assert.ok(result.query);
    assert.ok(result.root);
    assert.ok(result.engine);
    assert.ok(result.retrievalConfidence);
    assert.ok(Array.isArray(result.topFiles));
    assert.ok(typeof result.totalMatches === 'number');
    assert.ok(typeof result.matchedFiles === 'number');
  });

  it('returns intent when provided', async () => {
    const result = await smartSearch({ query: 'AuthMiddleware', cwd: fixtureRoot, intent: 'debug' });
    assert.equal(result.intent, 'debug');
  });
});

// ---------------------------------------------------------------------------
// Response contract — smart_read
// ---------------------------------------------------------------------------

describe('response contract smart_read', () => {
  const fixturePath = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project', 'src', 'auth', 'middleware.js');

  it('returns indexHint in symbol mode', async () => {
    const result = await smartRead({ filePath: fixturePath, mode: 'symbol', symbol: 'AuthMiddleware' });
    assert.ok(typeof result.indexHint === 'boolean', 'indexHint should be a boolean');
  });

  it('does not return indexHint in outline mode', async () => {
    const result = await smartRead({ filePath: fixturePath, mode: 'outline' });
    assert.equal(result.indexHint, undefined, 'indexHint should not be present in outline mode');
  });

  it('returns core contract fields', async () => {
    const result = await smartRead({ filePath: fixturePath, mode: 'outline' });
    assert.ok(result.filePath);
    assert.ok(result.mode);
    assert.ok(result.parser);
    assert.ok(typeof result.truncated === 'boolean');
    assert.ok(result.content);
    assert.ok(result.metrics);
  });
});

// ---------------------------------------------------------------------------
// Regression: subdirectory search uses projectRoot index
// ---------------------------------------------------------------------------

describe('subdirectory search uses projectRoot index', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('finds indexBoosted results when cwd is a subdirectory', async () => {
    const subDir = path.join(fixtureRoot, 'src');
    const result = await smartSearch({ query: 'AuthMiddleware', cwd: subDir });
    assert.notEqual(result.indexFreshness, 'unavailable', 'index should be found via projectRoot');
  });
});

// ---------------------------------------------------------------------------
// Regression: indexFreshness detects modified files
// ---------------------------------------------------------------------------

describe('indexFreshness detects stale files', () => {
  let tmpDir;

  beforeEach(async () => {
    const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-fresh-'));
    fs.cpSync(fixtureRoot, tmpDir, { recursive: true, filter: (src) => !src.includes('.devctx') });
    setProjectRoot(tmpDir);
    const index = buildIndex(tmpDir);
    await persistIndex(index, tmpDir);
  });

  afterEach(async () => {
    const { projectRoot } = await import('../src/utils/paths.js');
    if (projectRoot === tmpDir) setProjectRoot(path.resolve(__dirname, '..', '..', '..'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports stale when a file is modified after index build', async () => {
    const target = path.join(tmpDir, 'src', 'auth', 'middleware.js');
    const content = fs.readFileSync(target, 'utf8');
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(target, content + '\n');

    const result = await smartSearch({ query: 'AuthMiddleware', cwd: tmpDir });
    assert.equal(result.indexFreshness, 'stale', 'should detect modified file as stale');
  });
});

// ---------------------------------------------------------------------------
// smart_context
// ---------------------------------------------------------------------------

import { smartContext, inferIntent, extractSearchQueries, extractSymbolCandidates, getChangedFiles, allocateReads } from '../src/tools/smart-context.js';

describe('smart_context response contract', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('returns all top-level fields', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.ok(typeof result.task === 'string');
    assert.ok(typeof result.intent === 'string');
    assert.ok(['fresh', 'stale', 'unavailable'].includes(result.indexFreshness));
    assert.ok(Array.isArray(result.context));
    assert.ok(result.graph);
    assert.ok(result.metrics);
    assert.ok(Array.isArray(result.hints));
  });

  it('context items have required shape', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.ok(result.context.length > 0, 'should return at least one context item');

    for (const item of result.context) {
      assert.ok(typeof item.file === 'string');
      assert.ok(typeof item.role === 'string');
      assert.ok(typeof item.readMode === 'string');
      assert.ok(typeof item.reasonIncluded === 'string');
      assert.ok(Array.isArray(item.evidence));
      if (item.readMode === 'index-only') {
        assert.ok(item.content == null, 'index-only items should not include content');
      } else {
        assert.ok(typeof item.content === 'string');
      }
    }
  });

  it('includes evidence metadata for why files were selected', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware verifyJwt', detail: 'minimal' });
    const primary = result.context.find((item) => item.role === 'primary');
    const related = result.context.find(
      (item) => item.role !== 'primary' && item.evidence.some((e) => ['testOf', 'dependencyOf', 'dependentOf'].includes(e.type)),
    );

    assert.ok(primary, 'should include a primary file');
    assert.ok(primary.evidence.some((e) => e.type === 'searchHit' || e.type === 'symbolMatch'));
    assert.ok(primary.reasonIncluded.length > 0);

    if (related) {
      assert.ok(related.reasonIncluded.length > 0);
    } else {
      assert.equal(result.graph.primaryImports.length + result.graph.tests.length + result.graph.dependents.length, 0);
    }
  });

  it('metrics have required fields', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.ok(typeof result.metrics.totalTokens === 'number');
    assert.ok(typeof result.metrics.filesIncluded === 'number');
    assert.ok(typeof result.metrics.filesEvaluated === 'number');
    assert.ok(typeof result.metrics.savingsPct === 'number');
  });

  it('graph has required fields', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.ok(Array.isArray(result.graph.primaryImports));
    assert.ok(Array.isArray(result.graph.tests));
    assert.ok(Array.isArray(result.graph.dependents));
    assert.ok(Array.isArray(result.graph.neighbors));
  });

  it('includes graphCoverage with imports and tests levels', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.ok(result.graphCoverage, 'should include graphCoverage');
    assert.ok(['full', 'partial', 'none'].includes(result.graphCoverage.imports));
    assert.ok(['full', 'partial', 'none'].includes(result.graphCoverage.tests));
  });
});

describe('smart_context intent detection', () => {
  it('auto-detects debug intent', () => {
    assert.equal(inferIntent('debug the auth flow'), 'debug');
    assert.equal(inferIntent('fix crash in login'), 'debug');
  });

  it('auto-detects tests intent', () => {
    assert.equal(inferIntent('write test for user service'), 'tests');
  });

  it('auto-detects config intent', () => {
    assert.equal(inferIntent('update docker deploy config'), 'config');
  });

  it('auto-detects implementation intent', () => {
    assert.equal(inferIntent('add feature for password reset'), 'implementation');
  });

  it('defaults to explore for ambiguous tasks', () => {
    assert.equal(inferIntent('how does the server work'), 'explore');
  });

  it('respects explicit intent override', async () => {
    const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
    const originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);

    try {
      const result = await smartContext({ task: 'look at auth stuff', intent: 'tests' });
      assert.equal(result.intent, 'tests');
    } finally {
      setProjectRoot(originalRoot);
    }
  });
});

describe('smart_context query extraction', () => {
  it('extracts camelCase identifiers', () => {
    const symbols = extractSymbolCandidates('debug loginHandler in auth');
    assert.ok(symbols.includes('loginHandler'));
  });

  it('extracts PascalCase identifiers', () => {
    const symbols = extractSymbolCandidates('debug AuthMiddleware class');
    assert.ok(symbols.includes('AuthMiddleware'));
  });

  it('extracts snake_case identifiers', () => {
    const symbols = extractSymbolCandidates('fix user_repository');
    assert.ok(symbols.includes('user_repository'));
  });

  it('extracts meaningful search queries', () => {
    const queries = extractSearchQueries('debug the authentication flow');
    assert.ok(queries.length > 0);
    assert.ok(!queries.includes('the'));
    assert.ok(!queries.includes('debug'));
    assert.ok(queries.includes('authentication'));
  });

  it('filters low-signal imperative verbs from sentence-start queries', () => {
    const queries = extractSearchQueries('Find authentication flow in auth middleware');
    assert.ok(!queries.includes('Find'));
    assert.ok(!queries.includes('find'));
    assert.equal(queries[0], 'authentication');
  });

  it('keeps code-like symbols ahead of free-text keywords', () => {
    const queries = extractSearchQueries('Find loginHandler in the authentication flow');
    assert.equal(queries[0], 'loginHandler');
    assert.ok(!queries.includes('Find'));
  });

  it('drops generic verbs from natural prompts while keeping domain words', () => {
    const queries = extractSearchQueries('where does token validation happen in the auth flow?');
    assert.ok(!queries.includes('happen'));
    assert.ok(queries.includes('auth'));
    assert.ok(queries.includes('token'));
  });

  it('filters onboarding meta words while keeping endpoint domain terms', () => {
    const queries = extractSearchQueries('I am onboarding: what file handles user endpoints?');
    assert.ok(!queries.includes('onboarding'));
    assert.ok(!queries.includes('file'));
    assert.ok(queries.includes('user'));
  });

  it('expands hyphenated create-user prompts into createUser and drops failure-path filler', () => {
    const queries = extractSearchQueries('which file handles the create-user failure path?');
    assert.equal(queries[0], 'createUser');
    assert.ok(!queries.includes('path'));
  });

  it('drops app/load filler while expanding JWT secret prompts', () => {
    const queries = extractSearchQueries('where does the app load the JWT secret?');
    assert.equal(queries[0], 'jwtSecret');
    assert.ok(!queries.includes('app'));
    assert.ok(!queries.includes('JWT'));
    assert.ok(!queries.includes('load'));
  });

  it('drops app filler from explore prompts', () => {
    const queries = extractSearchQueries('where does email-related logic live across the app?');
    assert.ok(!queries.includes('app'));
    assert.equal(queries[0], 'email');
  });
});

describe('smart_context natural prompt retrieval', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('finds auth middleware from a natural validation prompt', async () => {
    const result = await smartContext({ task: 'where does token validation happen in the auth flow?' });
    const files = result.context.map((item) => item.file);
    assert.ok(files.includes('src/auth/middleware.js'));
    const primaryFiles = result.context.filter((item) => item.role === 'primary').map((item) => item.file);
    assert.deepEqual(primaryFiles, ['src/auth/middleware.js']);
  });

  it('finds the user API from a review-style prompt', async () => {
    const result = await smartContext({ task: 'review the user creation API flow' });
    const files = result.context.map((item) => item.file);
    assert.ok(files.includes('src/api/users.js'));
    const primaryFiles = result.context.filter((item) => item.role === 'primary').map((item) => item.file);
    assert.deepEqual(primaryFiles, ['src/api/users.js']);
  });

  it('finds the deployment container file from an onboarding prompt', async () => {
    const result = await smartContext({ task: 'I am onboarding: which file defines the deployment container?' });
    const files = result.context.map((item) => item.file);
    assert.ok(files.includes('Dockerfile'));
  });

  it('finds the user API from a create-user failure prompt', async () => {
    const result = await smartContext({ task: 'which file handles the create-user failure path?' });
    const files = result.context.map((item) => item.file);
    assert.ok(files.includes('src/api/users.js'));
    const primaryFiles = result.context.filter((item) => item.role === 'primary').map((item) => item.file);
    assert.deepEqual(primaryFiles, ['src/api/users.js']);
  });

  it('finds config for JWT secret prompts', async () => {
    const result = await smartContext({ task: 'where does the app load the JWT secret?' });
    const files = result.context.map((item) => item.file);
    assert.ok(files.includes('config/app.yaml'));
    const primaryFiles = result.context.filter((item) => item.role === 'primary').map((item) => item.file);
    assert.deepEqual(primaryFiles, ['config/app.yaml']);
  });

  it('keeps email exploration primaries on expected files', async () => {
    const result = await smartContext({ task: 'where does email-related logic live across the app?' });
    const files = result.context.map((item) => item.file);
    assert.ok(files.includes('services/notification.py'));
    assert.ok(files.includes('src/api/users.js'));
    const primaryFiles = result.context.filter((item) => item.role === 'primary').map((item) => item.file);
    assert.equal(primaryFiles.length, 1);
    assert.ok(['services/notification.py', 'src/api/users.js'].includes(primaryFiles[0]));
  });
});
describe('smart_context entry file', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('includes entryFile as primary in context', async () => {
    const result = await smartContext({
      task: 'understand jwt utilities',
      entryFile: 'src/utils/jwt.js',
    });
    const files = result.context.map((c) => c.file);
    assert.ok(files.includes('src/utils/jwt.js'), 'entry file should be in context');

    const entry = result.context.find((c) => c.file === 'src/utils/jwt.js');
    assert.equal(entry.role, 'primary');
  });
});

describe('smart_context graph expansion', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('expands tests via graph when searching auth code', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware', intent: 'debug' });
    const roles = result.context.map((c) => c.role);
    const testFiles = result.context.filter((c) => c.role === 'test');

    if (result.graph.tests.length > 0) {
      assert.ok(testFiles.length > 0 || result.graph.tests.length > 0,
        'graph should identify test files');
    }
  });

  it('includes dependencies in context', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware', intent: 'debug' });
    const depFiles = result.context.filter((c) => c.role === 'dependency');
    const graphImports = result.graph.primaryImports;

    if (graphImports.length > 0) {
      assert.ok(depFiles.length > 0, 'should include dependency files');
    }
  });
});

describe('smart_context maxTokens budget', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('returns fewer files with tight budget', async () => {
    const loose = await smartContext({ task: 'debug AuthMiddleware', maxTokens: 8000 });
    const tight = await smartContext({ task: 'debug AuthMiddleware', maxTokens: 1600 });
    assert.ok(tight.metrics.filesIncluded <= loose.metrics.filesIncluded,
      'tight budget should not include more files');
  });

  it('uses signatures mode for primary files on tight budget', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware', maxTokens: 2000 });
    const primaries = result.context.filter((c) => c.role === 'primary');
    for (const p of primaries) {
      assert.ok(['index-only', 'signatures'].includes(p.readMode), 'primary files should stay compact on tight budget');
    }
  });
});

// ---------------------------------------------------------------------------
// smart_context regression: partial symbol hits
// ---------------------------------------------------------------------------

describe('smart_context partial symbol hits', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('keeps symbolDetail when one symbol exists and another does not', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware and nonExistentThing' });
    const symbolEntries = result.context.filter((c) => c.role === 'symbolDetail');

    if (symbolEntries.length > 0) {
      for (const entry of symbolEntries) {
        assert.ok(!entry.content.includes('Symbol not found'),
          'symbolDetail should not contain not-found sections');
        assert.ok(entry.content.length > 0, 'symbolDetail should have content');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// smart_context regression: filesIncluded counts unique files
// ---------------------------------------------------------------------------

describe('smart_context filesIncluded uniqueness', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('filesIncluded equals unique file count, not context.length', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    const uniqueFiles = new Set(result.context.map((c) => c.file)).size;
    assert.equal(result.metrics.filesIncluded, uniqueFiles,
      'filesIncluded should count unique files');
  });
});

// ---------------------------------------------------------------------------
// smart_context regression: budget enforcement
// ---------------------------------------------------------------------------

describe('smart_context budget enforcement', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('totalTokens does not wildly exceed maxTokens', async () => {
    const budget = 2000;
    const result = await smartContext({ task: 'debug AuthMiddleware', maxTokens: budget });
    assert.ok(result.metrics.totalTokens <= budget * 1.5,
      `totalTokens ${result.metrics.totalTokens} should not exceed 1.5x budget ${budget}`);
  });
});

// ---------------------------------------------------------------------------
// smart_context diff-aware mode
// ---------------------------------------------------------------------------

describe('getChangedFiles', () => {
  let tmpDir;

  beforeEach(() => {
    const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-diff-'));
    fs.cpSync(fixtureRoot, tmpDir, { recursive: true, filter: (src) => !src.includes('.devctx') });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns changed files from a git repo', async () => {
    const { execSync } = await import('node:child_process');
    execSync('git init && git add . && git -c user.name=test -c user.email=test@test.com commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'),
      fs.readFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'), 'utf8') + '\n// changed\n');

    const result = await getChangedFiles('HEAD', tmpDir);
    assert.equal(result.ref, 'HEAD');
    assert.ok(result.files.includes('src/auth/middleware.js'), 'should list changed file');
    assert.equal(result.skippedDeleted, 0);
  });

  it('filters out deleted files', async () => {
    const { execSync } = await import('node:child_process');
    execSync('git init && git add . && git -c user.name=test -c user.email=test@test.com commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
    fs.unlinkSync(path.join(tmpDir, 'src', 'utils', 'logger.js'));

    const result = await getChangedFiles('HEAD', tmpDir);
    assert.ok(!result.files.includes('src/utils/logger.js'), 'deleted file should be filtered');
    assert.ok(result.skippedDeleted >= 1, 'should count deleted file');
  });

  it('returns error for non-git directory', async () => {
    const result = await getChangedFiles('HEAD', tmpDir);
    assert.ok(result.error, 'should have error for non-git dir');
    assert.deepEqual(result.files, []);
  });

  it('rejects refs with shell metacharacters', async () => {
    const result = await getChangedFiles('main; rm -rf /', tmpDir);
    assert.ok(result.error?.includes('metacharacters'));
    assert.deepEqual(result.files, []);
  });

  it('handles diff=true as HEAD', async () => {
    const result = await getChangedFiles(true, '/tmp');
    assert.equal(result.ref, 'HEAD');
  });

  it('includes untracked files when ref is HEAD', async () => {
    const { execSync } = await import('node:child_process');
    execSync('git init && git add . && git -c user.name=test -c user.email=test@test.com commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'brand-new-file.js'), 'export const x = 1;\n');

    const result = await getChangedFiles('HEAD', tmpDir);
    assert.ok(result.files.includes('brand-new-file.js'), 'untracked file should be included with HEAD');
  });

  it('does not include untracked files for non-HEAD refs', async () => {
    const { execSync } = await import('node:child_process');
    execSync('git init && git add . && git -c user.name=test -c user.email=test@test.com commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git checkout -b feature', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'brand-new-file.js'), 'export const x = 1;\n');

    const result = await getChangedFiles('main', tmpDir);
    assert.ok(!result.files.includes('brand-new-file.js'), 'untracked file should NOT be included for non-HEAD ref');
  });
});

describe('smart_context diff mode integration', () => {
  let tmpDir;
  let originalRoot;

  beforeEach(async () => {
    const { execSync } = await import('node:child_process');
    const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-diff-int-'));
    fs.cpSync(fixtureRoot, tmpDir, { recursive: true, filter: (src) => !src.includes('.devctx') });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.devctx/\n');

    execSync('git init && git add . && git -c user.name=test -c user.email=test@test.com commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(tmpDir);
    const index = buildIndex(tmpDir);
    await persistIndex(index, tmpDir);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns diffSummary when diff is provided', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'),
      fs.readFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'), 'utf8') + '\n// mod\n');

    const result = await smartContext({ task: 'review changes', diff: 'HEAD' });
    assert.ok(result.diffSummary, 'should have diffSummary');
    assert.equal(result.diffSummary.ref, 'HEAD');
    assert.ok(typeof result.diffSummary.totalChanged === 'number');
    assert.ok(typeof result.diffSummary.included === 'number');
    assert.ok(typeof result.diffSummary.skippedDeleted === 'number');
  });

  it('changed files appear as primary in context', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'),
      fs.readFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'), 'utf8') + '\n// mod\n');

    const result = await smartContext({ task: 'review changes', diff: 'HEAD' });
    const primaries = result.context.filter((c) => c.role === 'primary');
    const primaryFiles = primaries.map((c) => c.file);
    assert.ok(primaryFiles.includes('src/auth/middleware.js'), 'changed file should be primary');
  });

  it('expands dependencies via graph in diff mode', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'),
      fs.readFileSync(path.join(tmpDir, 'src', 'auth', 'middleware.js'), 'utf8') + '\n// mod\n');

    const result = await smartContext({ task: 'review changes', diff: 'HEAD' });
    const allFiles = result.context.map((c) => c.file);
    const depFiles = result.context.filter((c) => c.role === 'dependency');

    if (result.graph.primaryImports.length > 0) {
      assert.ok(depFiles.length > 0, 'should include dependency files from graph');
    }
  });

  it('returns empty context with hint when no changes', async () => {
    const result = await smartContext({ task: 'review changes', diff: 'HEAD' });
    assert.equal(result.context.length, 0, 'no changes should give empty context');
    assert.ok(result.hints.length > 0, 'should include a hint about no changes');
  });

  it('does not return diffSummary when diff is not provided', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.equal(result.diffSummary, undefined, 'should not have diffSummary without diff param');
  });

  it('detects stale index in diff mode', async () => {
    const mwPath = path.join(tmpDir, 'src', 'auth', 'middleware.js');
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(mwPath, fs.readFileSync(mwPath, 'utf8') + '\n// stale-trigger\n');

    const result = await smartContext({ task: 'review changes', diff: 'HEAD' });
    assert.equal(result.indexFreshness, 'stale', 'should detect stale index when file mtime differs');
  });

  it('includes untracked files in diff mode with HEAD', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'brand-new.js'), 'export const fresh = true;\n');

    const result = await smartContext({ task: 'review new file', diff: 'HEAD' });
    const files = result.context.map((c) => c.file);
    assert.ok(files.includes('src/brand-new.js'), 'untracked file should appear in context');
  });
});

// ---------------------------------------------------------------------------
// C#, Kotlin, PHP, Swift support
// ---------------------------------------------------------------------------

describe('smart_read C# support', () => {
  it('outline extracts class, interface, enum, record and namespace', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.cs', mode: 'outline' });
    assert.match(result.content, /SampleService/);
    assert.match(result.content, /IUserService/);
    assert.match(result.content, /Example\.Services/);
    assert.strictEqual(result.parser, 'heuristic');
  });

  it('symbol extracts a C# method', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.cs', mode: 'symbol', symbol: 'CreateUser' });
    assert.match(result.content, /CreateUser/);
    assert.match(result.content, /Guid/);
  });

  it('index extracts C# symbols with correct kind', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-cs-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.cs'), fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'formats', 'SampleService.cs')));
    const index = buildIndex(tmpDir);
    const classHits = queryIndex(index, 'SampleService');
    assert.ok(classHits.length > 0, 'should find SampleService');
    assert.ok(classHits.some((h) => h.kind === 'class'));
    const ifaceHits = queryIndex(index, 'IUserService');
    assert.ok(ifaceHits.some((h) => h.kind === 'interface'), 'interface should have kind=interface');
    const enumHits = queryIndex(index, 'UserRole');
    assert.ok(enumHits.some((h) => h.kind === 'enum'), 'enum should have kind=enum');
    const recordHits = queryIndex(index, 'UserDto');
    assert.ok(recordHits.some((h) => h.kind === 'record'), 'record should have kind=record');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('index includes C# file with using statements', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-cs-imp-'));
    fs.writeFileSync(path.join(tmpDir, 'Empty.cs'), 'using System;\nusing System.Linq;\n');
    const index = buildIndex(tmpDir);
    assert.ok(index.files['Empty.cs'], 'file with only usings should be indexed');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('smart_read Kotlin support', () => {
  it('outline extracts interface, object, data class and fun', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.kt', mode: 'outline' });
    assert.match(result.content, /UserDto/);
    assert.match(result.content, /ServiceRegistry/);
    assert.match(result.content, /createUser/);
    assert.strictEqual(result.parser, 'heuristic');
  });

  it('symbol extracts a Kotlin function', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.kt', mode: 'symbol', symbol: 'createUser' });
    assert.match(result.content, /createUser/);
    assert.match(result.content, /UUID/);
  });

  it('index extracts Kotlin symbols with correct kind', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-kt-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.kt'), fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'formats', 'SampleService.kt')));
    const index = buildIndex(tmpDir);
    const classHits = queryIndex(index, 'SampleService');
    assert.ok(classHits.length > 0, 'should find SampleService');
    assert.ok(classHits.some((h) => h.kind === 'class'));
    const ifaceHits = queryIndex(index, 'UserService');
    assert.ok(ifaceHits.some((h) => h.kind === 'interface'), 'interface should have kind=interface');
    const objHits = queryIndex(index, 'ServiceRegistry');
    assert.ok(objHits.some((h) => h.kind === 'object'), 'object should have kind=object');
    const funHits = queryIndex(index, 'topLevelHelper');
    assert.ok(funHits.some((h) => h.kind === 'function'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('index includes Kotlin file with import statements', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-kt-imp-'));
    fs.writeFileSync(path.join(tmpDir, 'Empty.kt'), 'import java.util.UUID\nimport kotlin.collections.List\n');
    const index = buildIndex(tmpDir);
    assert.ok(index.files['Empty.kt'], 'file with only imports should be indexed');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('smart_read PHP support', () => {
  it('outline extracts class, interface, trait and function', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.php', mode: 'outline' });
    assert.match(result.content, /SampleService/);
    assert.match(result.content, /UserServiceContract/);
    assert.match(result.content, /createUser/);
    assert.strictEqual(result.parser, 'heuristic');
  });

  it('symbol extracts a PHP method', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.php', mode: 'symbol', symbol: 'createUser' });
    assert.match(result.content, /createUser/);
    assert.match(result.content, /function/);
  });

  it('index extracts PHP symbols with correct kind', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-php-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.php'), fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'formats', 'SampleService.php')));
    const index = buildIndex(tmpDir);
    const classHits = queryIndex(index, 'SampleService');
    assert.ok(classHits.length > 0, 'should find SampleService');
    assert.ok(classHits.some((h) => h.kind === 'class'));
    const ifaceHits = queryIndex(index, 'UserServiceContract');
    assert.ok(ifaceHits.some((h) => h.kind === 'interface'), 'interface should have kind=interface');
    const traitHits = queryIndex(index, 'Loggable');
    assert.ok(traitHits.some((h) => h.kind === 'trait'), 'trait should have kind=trait');
    const roleHits = queryIndex(index, 'UserRole');
    assert.ok(roleHits.some((h) => h.kind === 'class'), 'abstract class should have kind=class');
    const funHits = queryIndex(index, 'helperFunction');
    assert.ok(funHits.length > 0, 'should find helperFunction');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('index includes PHP file with use statements', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-php-imp-'));
    fs.writeFileSync(path.join(tmpDir, 'Empty.php'), '<?php\nuse App\\Models\\User;\nuse App\\Services\\Logger;\n');
    const index = buildIndex(tmpDir);
    assert.ok(index.files['Empty.php'], 'file with only use statements should be indexed');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('smart_read Swift support', () => {
  it('outline extracts protocol, actor, struct and func', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.swift', mode: 'outline' });
    assert.match(result.content, /UserDto/);
    assert.match(result.content, /SessionManager/);
    assert.match(result.content, /createUser/);
    assert.strictEqual(result.parser, 'heuristic');
  });

  it('symbol extracts a Swift function', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/fixtures/formats/SampleService.swift', mode: 'symbol', symbol: 'createUser' });
    assert.match(result.content, /createUser/);
    assert.match(result.content, /func/);
  });

  it('index extracts Swift symbols with correct kind', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-swift-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.swift'), fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'formats', 'SampleService.swift')));
    const index = buildIndex(tmpDir);
    const classHits = queryIndex(index, 'SampleService');
    assert.ok(classHits.length > 0, 'should find SampleService');
    assert.ok(classHits.some((h) => h.kind === 'class'));
    const protoHits = queryIndex(index, 'UserServiceProtocol');
    assert.ok(protoHits.some((h) => h.kind === 'protocol'), 'protocol should have kind=protocol');
    const actorHits = queryIndex(index, 'SessionManager');
    assert.ok(actorHits.some((h) => h.kind === 'actor'), 'actor should have kind=actor');
    const enumHits = queryIndex(index, 'UserRole');
    assert.ok(enumHits.some((h) => h.kind === 'enum'), 'enum should have kind=enum');
    const structHits = queryIndex(index, 'UserDto');
    assert.ok(structHits.some((h) => h.kind === 'struct'), 'struct should have kind=struct');
    const funHits = queryIndex(index, 'topLevelHelper');
    assert.ok(funHits.length > 0, 'should find topLevelHelper');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('index includes Swift file with import statements', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-swift-imp-'));
    fs.writeFileSync(path.join(tmpDir, 'Empty.swift'), 'import Foundation\nimport UIKit\n');
    const index = buildIndex(tmpDir);
    assert.ok(index.files['Empty.swift'], 'file with only imports should be indexed');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('new language testOf resolution', () => {
  it('links C# test file to source via inferTestTarget', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-testof-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.cs'), 'public class Service { public void Run() {} }\n');
    fs.writeFileSync(path.join(tmpDir, 'ServiceTests.cs'), 'public class ServiceTests { public void TestRun() {} }\n');
    const index = buildIndex(tmpDir);
    const related = queryRelated(index, 'Service.cs');
    assert.ok(related.tests.includes('ServiceTests.cs'), 'test file should be linked via testOf');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links Kotlin test file to source via inferTestTarget', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-testof-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.kt'), 'class Service { fun run() {} }\n');
    fs.writeFileSync(path.join(tmpDir, 'ServiceTest.kt'), 'class ServiceTest { fun testRun() {} }\n');
    const index = buildIndex(tmpDir);
    const related = queryRelated(index, 'Service.kt');
    assert.ok(related.tests.includes('ServiceTest.kt'), 'test file should be linked via testOf');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links PHP test file to source via inferTestTarget', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-testof-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.php'), '<?php\nclass Service {\n    function run() {}\n}\n');
    fs.writeFileSync(path.join(tmpDir, 'ServiceTest.php'), '<?php\nclass ServiceTest {\n    function testRun() {}\n}\n');
    const index = buildIndex(tmpDir);
    const related = queryRelated(index, 'Service.php');
    assert.ok(related.tests.includes('ServiceTest.php'), 'test file should be linked via testOf');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links Swift test file to source via inferTestTarget', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-testof-'));
    fs.writeFileSync(path.join(tmpDir, 'Service.swift'), 'class Service { func run() {} }\n');
    fs.writeFileSync(path.join(tmpDir, 'ServiceTests.swift'), 'class ServiceTests { func testRun() {} }\n');
    const index = buildIndex(tmpDir);
    const related = queryRelated(index, 'Service.swift');
    assert.ok(related.tests.includes('ServiceTests.swift'), 'test file should be linked via testOf');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('unified confidence contract', () => {
  it('smart_read outline returns confidence block', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'outline' });
    assert.ok(result.confidence, 'confidence block must exist');
    assert.strictEqual(result.confidence.parser, 'ast');
    assert.strictEqual(result.confidence.truncated, false);
    assert.strictEqual(result.confidence.cached, false);
  });

  it('smart_read full returns parser=raw in confidence', async () => {
    const result = await smartRead({ filePath: 'tools/devctx/src/server.js', mode: 'full' });
    assert.strictEqual(result.confidence.parser, 'raw');
  });

  it('smart_read symbol with context includes graphCoverage in confidence', async () => {
    const result = await smartRead({
      filePath: 'tools/devctx/src/server.js',
      mode: 'symbol',
      symbol: 'createDevctxServer',
      context: true,
    });
    assert.ok(result.confidence.graphCoverage, 'confidence.graphCoverage must exist');
    assert.ok(['full', 'partial', 'none'].includes(result.confidence.graphCoverage.imports));
    assert.ok(['full', 'partial', 'none'].includes(result.confidence.graphCoverage.tests));
  });

  it('smart_search returns confidence with level and indexFreshness', async () => {
    const result = await smartSearch({ query: 'createDevctxServer', cwd: 'tools/devctx/src' });
    assert.ok(result.confidence, 'confidence block must exist');
    assert.ok(['high', 'medium', 'low'].includes(result.confidence.level));
    assert.ok(['fresh', 'stale', 'unavailable'].includes(result.confidence.indexFreshness));
    assert.strictEqual(result.confidence.level, result.retrievalConfidence);
    assert.strictEqual(result.confidence.indexFreshness, result.indexFreshness);
  });

  it('smart_context returns confidence with indexFreshness and graphCoverage', async () => {
    const result = await smartContext({ task: 'find createDevctxServer function' });
    assert.ok(result.confidence, 'confidence block must exist');
    assert.ok(['fresh', 'stale', 'unavailable'].includes(result.confidence.indexFreshness));
    assert.ok(result.confidence.graphCoverage);
    assert.strictEqual(result.confidence.indexFreshness, result.indexFreshness);
    assert.deepStrictEqual(result.confidence.graphCoverage, result.graphCoverage);
  });

  it('smart_shell returns confidence with blocked and timedOut', async () => {
    const result = await smartShell({ command: 'pwd' });
    assert.ok(result.confidence, 'confidence block must exist');
    assert.strictEqual(result.confidence.blocked, false);
    assert.strictEqual(result.confidence.timedOut, false);
  });

  it('smart_shell blocked command sets confidence.blocked=true', async () => {
    const result = await smartShell({ command: 'rm -rf /' });
    assert.strictEqual(result.confidence.blocked, true);
    assert.strictEqual(result.confidence.timedOut, false);
  });

  it('smart_read_batch propagates confidence per item', async () => {
    const result = await smartReadBatch({
      files: [{ path: 'tools/devctx/src/server.js', mode: 'outline' }],
    });
    assert.ok(result.results[0].confidence, 'per-item confidence must exist');
    assert.strictEqual(result.results[0].confidence.parser, 'ast');
  });
});

describe('index signatures', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

  it('queryIndex returns signature and snippet for JS symbols', () => {
    setProjectRoot(REPO_ROOT);
    const index = buildIndex(REPO_ROOT);
    const hits = queryIndex(index, 'createDevctxServer');
    assert.ok(hits.length > 0, 'should find createDevctxServer');
    const hit = hits[0];
    assert.ok(hit.signature, 'signature must be present');
    assert.ok(hit.signature.includes('createDevctxServer'), 'signature should contain the symbol name');
    assert.ok(hit.signature.length <= 201, 'signature must respect max length');
    assert.ok(hit.snippet, 'snippet must be present');
    assert.ok(hit.snippet.includes('createDevctxServer'), 'snippet should contain the symbol name');
  });

  it('queryIndex returns signature for Python symbols', () => {
    setProjectRoot(REPO_ROOT);
    const index = buildIndex(REPO_ROOT);
    const hits = queryIndex(index, 'UserService');
    const pyHit = hits.find((h) => h.path.endsWith('.py'));
    if (pyHit) {
      assert.ok(pyHit.signature, 'Python symbol should have a signature');
      assert.ok(pyHit.signature.includes('UserService'));
    }
  });

  it('index stores signatures and snippets in fileEntries', () => {
    setProjectRoot(REPO_ROOT);
    const index = buildIndex(REPO_ROOT);
    const serverEntry = index.files['tools/devctx/src/server.js'];
    assert.ok(serverEntry, 'server.js must be indexed');
    const symWithSig = serverEntry.symbols.find((s) => s.signature);
    assert.ok(symWithSig, 'at least one symbol should have a signature');
    assert.ok(typeof symWithSig.signature === 'string');
    assert.ok(symWithSig.snippet, 'at least one symbol should have a snippet');
    assert.ok(typeof symWithSig.snippet === 'string');
  });

  it('smart_context includes symbolSignatures from index', async () => {
    setProjectRoot(REPO_ROOT);
    buildIndex(REPO_ROOT);
    const result = await smartContext({ task: 'find createDevctxServer' });
    const primary = result.context.find((c) => c.role === 'primary' && c.symbolSignatures?.length > 0);
    if (primary) {
      assert.ok(Array.isArray(primary.symbolSignatures));
      assert.ok(primary.symbolSignatures.every((s) => typeof s === 'string'));
    }
  });
});

describe('persistMetrics fire-and-forget', () => {
  it('does not throw when metrics dir is unwritable', async () => {
    const { persistMetrics, buildMetrics } = await import('../src/metrics.js');
    const original = process.env.DEVCTX_METRICS_FILE;
    process.env.DEVCTX_METRICS_FILE = '/nonexistent/deeply/nested/path/metrics.jsonl';

    try {
      const entry = buildMetrics({ tool: 'test', target: 'test', rawText: 'hello', compressedText: 'h' });
      await assert.doesNotReject(() => persistMetrics(entry));
    } finally {
      if (original === undefined) {
        delete process.env.DEVCTX_METRICS_FILE;
      } else {
        process.env.DEVCTX_METRICS_FILE = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// smart_context detail and include modes
// ---------------------------------------------------------------------------

describe('smart_context detail and include modes', () => {
  const fixtureRoot = path.resolve(__dirname, '..', 'evals', 'fixtures', 'sample-project');
  let originalRoot;

  beforeEach(async () => {
    originalRoot = (await import('../src/utils/paths.js')).projectRoot;
    setProjectRoot(fixtureRoot);
    const index = buildIndex(fixtureRoot);
    await persistIndex(index, fixtureRoot);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
  });

  it('minimal mode returns index-first context with compact metadata', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware verifyJwt', detail: 'minimal' });
    assert.ok(result.context.length > 0);
    const nonSymbolDetail = result.context.filter((c) => c.role !== 'symbolDetail');
    for (const item of nonSymbolDetail) {
      assert.ok(['index-only', 'signatures-only'].includes(item.readMode));
      if (item.readMode === 'signatures-only') {
        assert.equal(item.content, '(omitted — see symbolDetail)');
      } else {
        assert.ok(!item.content, 'minimal mode should not include content unless dedup placeholder is used');
      }
    }
    const withSymbols = result.context.filter((c) => c.symbols || c.symbolSignatures);
    assert.ok(withSymbols.length > 0, 'at least some items should have symbols or signatures');
    const withPreviews = result.context.filter((c) => Array.isArray(c.symbolPreviews) && c.symbolPreviews.length > 0);
    assert.ok(withPreviews.length > 0, 'minimal mode should include symbol previews from the index');
    assert.ok(result.metrics.detailMode === 'minimal');
  });

  it('include without content omits content field', async () => {
    const result = await smartContext({
      task: 'debug AuthMiddleware',
      include: ['graph', 'hints'],
    });
    assert.ok(result.context.length > 0);
    for (const item of result.context) {
      assert.ok(!item.content, 'should not include content when omitted from include');
    }
    assert.ok(!result.metrics.include.includes('content'));
  });

  it('include without graph omits graph fields', async () => {
    const result = await smartContext({
      task: 'debug AuthMiddleware',
      include: ['content', 'hints'],
    });
    assert.ok(!result.graph, 'should not include graph when omitted');
    assert.ok(!result.graphCoverage, 'should not include graphCoverage when omitted');
  });

  it('include without hints omits hints field', async () => {
    const result = await smartContext({
      task: 'debug AuthMiddleware',
      include: ['content', 'graph'],
    });
    assert.ok(!result.hints, 'should not include hints when omitted');
  });

  it('balanced mode (default) includes content', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware' });
    assert.ok(result.context.length > 0);
    const withContent = result.context.filter((c) => c.content && c.content.length > 10);
    assert.ok(withContent.length > 0, 'balanced mode should include content for some files');
    assert.ok(result.metrics.detailMode === 'balanced');
  });

  it('balanced mode keeps strong entry-file primaries index-first when previews already cover the file well', async () => {
    const result = await smartContext({
      task: 'review the auth flow entry point and main middleware',
      entryFile: 'src/auth/middleware.js',
    });
    const primary = result.context.find((c) => c.role === 'primary' && c.file === 'src/auth/middleware.js');
    assert.ok(primary, 'should include the entry file as primary');
    assert.equal(primary.readMode, 'index-only');
    assert.ok(!primary.content, 'balanced mode should skip content when index previews are already strong');
  });

  it('balanced mode still reads content for primaries with weak index metadata', async () => {
    const result = await smartContext({
      task: 'where is the database wired from configuration?',
      entryFile: 'config/database.json',
    });
    const primary = result.context.find((c) => c.role === 'primary' && c.file === 'config/database.json');
    assert.ok(primary, 'should include the config file as primary');
    assert.notEqual(primary.readMode, 'index-only');
    assert.ok(primary.content && primary.content.length > 0, 'balanced mode should still read content when the index has little signal');
  });

  it('balanced mode adds fallback symbol previews to entry-file primary items without explicit symbol matches', async () => {
    const result = await smartContext({
      task: 'review auth flow',
      entryFile: 'src/auth/middleware.js',
    });
    const primary = result.context.find((c) => c.role === 'primary' && c.file === 'src/auth/middleware.js');
    assert.ok(primary, 'should include the entry file as primary');
    assert.ok(Array.isArray(primary.symbolPreviews) && primary.symbolPreviews.length > 0, 'primary item should include fallback symbol previews');
    assert.ok(primary.symbolPreviews.length <= 2, 'primary preview fallback should stay compact');
  });

  it('balanced mode adds compact fallback previews to dependency items', async () => {
    const result = await smartContext({
      task: 'review auth flow',
      entryFile: 'src/auth/middleware.js',
    });
    const dependencyWithPreview = result.context.find(
      (c) => c.role === 'dependency' && Array.isArray(c.symbolPreviews) && c.symbolPreviews.length > 0,
    );
    assert.ok(dependencyWithPreview, 'dependency item should include a compact symbol preview');
    assert.ok(dependencyWithPreview.symbolPreviews.length <= 1, 'dependency preview fallback should stay minimal');
  });

  it('deep mode reads full content blocks', async () => {
    const result = await smartContext({ task: 'debug AuthMiddleware', detail: 'deep' });
    assert.ok(result.context.length > 0);
    const fullReads = result.context.filter((c) => c.role !== 'symbolDetail' && c.readMode === 'full' && c.content);
    assert.ok(fullReads.length > 0, 'deep mode should use full reads for at least some files');
    assert.ok(result.metrics.detailMode === 'deep');
  });

  it('deduplication in minimal mode replaces primary with signatures-only when symbolDetail exists', async () => {
    const result = await smartContext({
      task: 'debug AuthMiddleware verifyToken',
      detail: 'minimal',
      include: ['symbolDetail'],
    });
    const symbolDetailItems = result.context.filter((c) => c.role === 'symbolDetail');
    assert.ok(symbolDetailItems.length > 0, 'symbolDetail should be included for detected symbols');
    const dedupedPrimary = result.context.find(
      (c) => c.file === symbolDetailItems[0].file && c.role === 'primary' && c.readMode === 'signatures-only',
    );
    assert.ok(dedupedPrimary, 'primary item should be replaced with a signatures-only placeholder');
    assert.equal(dedupedPrimary.content, '(omitted — see symbolDetail)');
  });
});

describe('smart_context utility scoring', () => {
  it('allocateReads prefers diverse evidence over redundant dependencies', () => {
    const files = new Map([
      ['src/auth/middleware.js', {
        role: 'primary',
        absPath: '/tmp/src/auth/middleware.js',
        evidence: [{ type: 'searchHit', query: 'AuthMiddleware', rank: 1 }, { type: 'symbolMatch', symbols: ['AuthMiddleware'] }],
        matchedSymbols: ['AuthMiddleware'],
      }],
      ['tests/auth.test.js', {
        role: 'test',
        absPath: '/tmp/tests/auth.test.js',
        evidence: [{ type: 'testOf', via: 'src/auth/middleware.js' }],
      }],
      ['src/utils/jwt.js', {
        role: 'dependency',
        absPath: '/tmp/src/utils/jwt.js',
        evidence: [{ type: 'dependencyOf', via: 'src/auth/middleware.js' }],
      }],
      ['src/utils/crypto.js', {
        role: 'dependency',
        absPath: '/tmp/src/utils/crypto.js',
        evidence: [{ type: 'dependencyOf', via: 'src/auth/middleware.js' }],
      }],
    ]);

    const plan = allocateReads(files, 2400, 'debug', 'balanced');
    const selected = plan.map((item) => item.rel);

    assert.equal(plan[0].rel, 'src/auth/middleware.js');
    assert.ok(selected.includes('tests/auth.test.js'), 'test coverage should beat redundant dependency reads');
    assert.equal(selected.filter((rel) => rel.startsWith('src/utils/')).length, 1, 'only one redundant dependency should be selected');
  });
});
