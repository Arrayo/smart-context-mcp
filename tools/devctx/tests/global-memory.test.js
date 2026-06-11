import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scrubContent,
  containsLikelySecret,
  hashProjectPath,
} from '../src/global-memory/scrub.js';
import {
  saveEntry,
  recallEntries,
  markEntryUsed,
  deleteEntry,
  listKinds,
  getStats,
  recordNoiseHint,
  getNoiseHints,
  resetNoiseHints,
  isGlobalMemoryEnabled,
} from '../src/global-memory/store.js';
import { globalMemory } from '../src/tools/global-memory.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22 ? 'SQLite support requires Node 22+' : false;

describe('global-memory :: scrub', () => {
  it('redacts api keys / bearer tokens / passwords', () => {
    const dirty = 'API_KEY = "sk-1234567890abcdef1234567890abcdef" password=hunter2longenough';
    const cleaned = scrubContent(dirty);
    assert.ok(!cleaned.includes('sk-1234567890abcdef'), `still leaks: ${cleaned}`);
    assert.ok(!cleaned.includes('hunter2longenough'));
    assert.ok(cleaned.includes('[REDACTED]'));
  });

  it('redacts JWT-like tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.X-_signaturepartABC';
    const cleaned = scrubContent(`Bearer ${jwt} done`);
    assert.ok(!cleaned.includes('eyJhbGciOiJIUzI1NiJ9'));
  });

  it('redacts emails and home paths', () => {
    const cleaned = scrubContent('contact john.doe@example.com at /home/john/secrets and /Users/jane/work');
    assert.ok(!cleaned.includes('john.doe@example.com'));
    assert.ok(!cleaned.includes('/home/john'));
    assert.ok(!cleaned.includes('/Users/jane'));
    assert.ok(cleaned.includes('~'));
  });

  it('containsLikelySecret detects keys but not innocuous text', () => {
    assert.equal(containsLikelySecret('API_KEY=sk-abcdef12345678901234'), true);
    assert.equal(containsLikelySecret('just a function name'), false);
  });

  it('hashProjectPath is deterministic and opaque', () => {
    const a = hashProjectPath('/repo/foo');
    const b = hashProjectPath('/repo/foo');
    const c = hashProjectPath('/repo/bar');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith('proj-'));
    assert.ok(!a.includes('/repo'));
  });
});

describe('global-memory :: store CRUD', { skip: SKIP_SQLITE_TESTS }, () => {
  let tmpDb;
  let prevEnvDb;
  let prevEnvFlag;

  before(() => {
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-gm-')), 'global.db');
    prevEnvDb = process.env.DEVCTX_GLOBAL_DB;
    prevEnvFlag = process.env.DEVCTX_GLOBAL_MEMORY;
    process.env.DEVCTX_GLOBAL_DB = tmpDb;
    process.env.DEVCTX_GLOBAL_MEMORY = 'true';
  });

  after(() => {
    if (prevEnvDb === undefined) delete process.env.DEVCTX_GLOBAL_DB;
    else process.env.DEVCTX_GLOBAL_DB = prevEnvDb;
    if (prevEnvFlag === undefined) delete process.env.DEVCTX_GLOBAL_MEMORY;
    else process.env.DEVCTX_GLOBAL_MEMORY = prevEnvFlag;
    if (fs.existsSync(tmpDb)) fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
  });

  beforeEach(() => {
    if (fs.existsSync(tmpDb)) fs.rmSync(tmpDb);
  });

  it('saves entries with scrubbed content', async () => {
    const result = await saveEntry({
      kind: 'decision',
      content: 'Use hexagonal architecture. SECRET=ghp_abcdef1234567890abcdef',
      tags: ['architecture'],
      projectPath: '/projects/demo',
    });
    assert.ok(result.id > 0);

    const recall = await recallEntries({ kind: 'decision' });
    assert.equal(recall.hits.length, 1);
    assert.ok(!recall.hits[0].content.includes('ghp_'));
    assert.ok(recall.hits[0].content.includes('[REDACTED]'));
  });

  it('rejects invalid kinds and empty content', async () => {
    await assert.rejects(() => saveEntry({ kind: 'bogus', content: 'x' }), /Invalid kind/);
    await assert.rejects(() => saveEntry({ kind: 'note', content: '   ' }), /non-empty string/);
  });

  it('recall ranks semantically with hashing embedder', async () => {
    await saveEntry({ kind: 'pattern', content: 'Repository pattern with userRepository.findById' });
    await saveEntry({ kind: 'pattern', content: 'Notification service: sendEmail to user' });
    await saveEntry({ kind: 'pattern', content: 'Logger utility for info, debug, error levels' });

    const result = await recallEntries({ kind: 'pattern', query: 'user repository find', limit: 3 });
    assert.ok(result.hits.length > 0);
    assert.ok(result.hits[0].content.toLowerCase().includes('repository'));
  });

  it('markEntryUsed bumps usage count and timestamp', async () => {
    const saved = await saveEntry({ kind: 'note', content: 'remember this' });
    const r1 = await markEntryUsed({ id: saved.id });
    assert.equal(r1.updated, true);
    const recall = await recallEntries({ kind: 'note' });
    assert.equal(recall.hits[0].usageCount, 1);
  });

  it('deleteEntry removes the row', async () => {
    const saved = await saveEntry({ kind: 'note', content: 'temp' });
    const r = await deleteEntry({ id: saved.id });
    assert.equal(r.deleted, true);
    const recall = await recallEntries({ kind: 'note' });
    assert.equal(recall.hits.length, 0);
  });

  it('listKinds + getStats summarize state', async () => {
    await saveEntry({ kind: 'decision', content: 'A' });
    await saveEntry({ kind: 'decision', content: 'B' });
    await saveEntry({ kind: 'pattern', content: 'P' });

    const kinds = await listKinds();
    assert.equal(kinds.total, 3);

    const stats = await getStats();
    assert.equal(stats.exists, true);
    assert.equal(stats.totalEntries, 3);
    assert.equal(stats.byKind.decision, 2);
    assert.equal(stats.byKind.pattern, 1);
  });

  it('records, lists, and resets repo noise hints', async () => {
    await recordNoiseHint({ projectPath: '/projects/demo', hintKey: 'src/index.js', reason: 'semantic_dedupe' });
    await recordNoiseHint({ projectPath: '/projects/demo', hintKey: 'src/index.js', reason: 'semantic_dedupe' });

    const listed = await getNoiseHints({ projectPath: '/projects/demo' });
    assert.equal(listed.hints.length, 1);
    assert.equal(listed.hints[0].hintKey, 'src/index.js');
    assert.equal(listed.hints[0].hits, 2);
    assert.ok(listed.hints[0].penalty > 0);

    const reset = await resetNoiseHints({ projectPath: '/projects/demo', hintKey: 'src/index.js' });
    assert.equal(reset.deleted, 1);
    const after = await getNoiseHints({ projectPath: '/projects/demo' });
    assert.equal(after.hints.length, 0);
  });
});

describe('global-memory :: tool surface', { skip: SKIP_SQLITE_TESTS }, () => {
  let tmpDb;
  let prevEnvDb;
  let prevEnvFlag;

  before(() => {
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-gm-tool-')), 'global.db');
    prevEnvDb = process.env.DEVCTX_GLOBAL_DB;
    prevEnvFlag = process.env.DEVCTX_GLOBAL_MEMORY;
    process.env.DEVCTX_GLOBAL_DB = tmpDb;
  });

  after(() => {
    if (prevEnvDb === undefined) delete process.env.DEVCTX_GLOBAL_DB;
    else process.env.DEVCTX_GLOBAL_DB = prevEnvDb;
    if (prevEnvFlag === undefined) delete process.env.DEVCTX_GLOBAL_MEMORY;
    else process.env.DEVCTX_GLOBAL_MEMORY = prevEnvFlag;
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
  });

  it('returns disabled response when DEVCTX_GLOBAL_MEMORY is not set', async () => {
    delete process.env.DEVCTX_GLOBAL_MEMORY;
    const result = await globalMemory({ action: 'stats' });
    assert.equal(result.success, false);
    assert.equal(result.disabled, true);
  });

  it('save + recall round-trip when enabled', async () => {
    process.env.DEVCTX_GLOBAL_MEMORY = 'true';
    const save = await globalMemory({
      action: 'save',
      kind: 'decision',
      content: 'Prefer cosine similarity over euclidean for text retrieval',
      tags: ['retrieval', 'embeddings'],
    });
    assert.equal(save.success, true);
    assert.ok(save.id > 0);

    const recall = await globalMemory({
      action: 'recall',
      kind: 'decision',
      query: 'cosine retrieval',
      limit: 5,
    });
    assert.equal(recall.success, true);
    assert.ok(recall.hits.length > 0);
    assert.ok(recall.hits[0].content.includes('cosine'));
  });

  it('rejects invalid action', async () => {
    process.env.DEVCTX_GLOBAL_MEMORY = 'true';
    const r = await globalMemory({ action: 'destroy_universe' });
    assert.equal(r.success, false);
    assert.match(r.error, /Invalid action/);
  });

  it('supports noise_stats and noise_reset actions', async () => {
    process.env.DEVCTX_GLOBAL_MEMORY = 'true';
    await recordNoiseHint({ projectPath: path.resolve('.'), hintKey: 'src/index.js' });

    const stats = await globalMemory({ action: 'noise_stats' });
    assert.equal(stats.success, true);
    assert.ok(Array.isArray(stats.hints));

    const reset = await globalMemory({ action: 'noise_reset', query: 'src/index.js' });
    assert.equal(reset.success, true);
    assert.ok(reset.deleted >= 1);
  });
});
