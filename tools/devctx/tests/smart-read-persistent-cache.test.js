import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smartRead, clearReadCache } from '../src/tools/smart-read.js';
import { clearReadCachePersistent } from '../src/storage/sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '../evals/fixtures/sample-project');
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22 ? 'SQLite support requires Node 22+' : false;

describe('smart_read persistent cache', { skip: SKIP_SQLITE_TESTS }, () => {
  let originalEnv;
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-read-cache-'));
    originalEnv = process.env.DEVCTX_STATE_DB_PATH;
    process.env.DEVCTX_STATE_DB_PATH = path.join(tempDir, 'state.sqlite');
  });

  after(() => {
    if (originalEnv !== undefined) {
      process.env.DEVCTX_STATE_DB_PATH = originalEnv;
    } else {
      delete process.env.DEVCTX_STATE_DB_PATH;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearReadCache();
    await clearReadCachePersistent();
  });

  it('reuses persistent cache for outline after memory cache is cleared', async () => {
    const filePath = path.join(fixturesDir, 'src/auth/middleware.js');
    const first = await smartRead({ filePath, mode: 'outline', cwd: fixturesDir });
    assert.equal(first.cached, false);

    clearReadCache();

    const second = await smartRead({ filePath, mode: 'outline', cwd: fixturesDir });
    assert.equal(second.cached, true);
    assert.equal(second.content, first.content);
  });

  it('reuses persistent cache for symbol mode after memory cache is cleared', async () => {
    const filePath = path.join(fixturesDir, 'src/auth/middleware.js');
    const first = await smartRead({ filePath, mode: 'symbol', symbol: 'AuthMiddleware', cwd: fixturesDir });
    assert.equal(first.cached, false);

    clearReadCache();

    const second = await smartRead({ filePath, mode: 'symbol', symbol: 'AuthMiddleware', cwd: fixturesDir });
    assert.equal(second.cached, true);
    assert.equal(second.content, first.content);
  });
});
