import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  embed,
  cosineSimilarity,
  buildCorpusIdf,
  tokenize,
  DEFAULT_DIMENSIONS,
  getEmbedder,
  setEmbedder,
  resetEmbedder,
  semanticRankSymbols,
  semanticRankFiles,
  buildIndexCorpusIdf,
} from '../src/embeddings/index.js';
import { buildIndex } from '../src/index.js';
import { setProjectRoot, projectRoot as savedProjectRoot } from '../src/utils/runtime-config.js';
import { smartSearch } from '../src/tools/smart-search.js';

describe('embeddings :: tokenize', () => {
  it('splits camelCase and snake_case identifiers', () => {
    const t = tokenize('getUserById find_user_by_id UserRepository');
    assert.ok(t.includes('user'), `missing "user" in ${JSON.stringify(t)}`);
    assert.ok(t.includes('id'), `missing "id" in ${JSON.stringify(t)}`);
    assert.ok(t.includes('userrepository'));
    assert.ok(t.includes('repository'));
    assert.ok(t.includes('get') || t.includes('find'));
  });

  it('removes stop words and very short tokens', () => {
    const t = tokenize('the user and a service');
    assert.ok(!t.includes('the'));
    assert.ok(!t.includes('and'));
    assert.ok(!t.includes('a'));
    assert.ok(t.includes('user'));
    assert.ok(t.includes('service'));
  });
});

describe('embeddings :: hashing embed', () => {
  it('produces a unit-norm Float32Array of expected dimensions', () => {
    const v = embed('UserRepository findById getUserBySomething');
    assert.ok(v instanceof Float32Array);
    assert.equal(v.length, DEFAULT_DIMENSIONS);
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    assert.ok(Math.abs(Math.sqrt(sumSq) - 1) < 1e-5, `expected unit norm, got ${Math.sqrt(sumSq)}`);
  });

  it('cosine similarity is higher for semantically related strings', () => {
    const a = embed('user repository find by id');
    const b = embed('UserRepository findById');
    const c = embed('JWT token signing crypto hmac');
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    assert.ok(simAB > simAC, `expected user/repo to beat jwt: ${simAB} vs ${simAC}`);
  });

  it('returns zero vector for empty input', () => {
    const v = embed('');
    assert.equal(v.length, DEFAULT_DIMENSIONS);
    for (let i = 0; i < v.length; i++) assert.equal(v[i], 0);
  });
});

describe('embeddings :: IDF', () => {
  it('downweights common tokens and upweights rare ones', () => {
    const docs = [
      'user service repository',
      'user notification email',
      'user auth password',
      'rare singleton token',
    ];
    const idf = buildCorpusIdf(docs);
    const userIdf = idf.get('user');
    const rareIdf = idf.get('rare');
    assert.ok(rareIdf > userIdf, `expected rare(${rareIdf}) > user(${userIdf})`);
  });
});

describe('embeddings :: pluggable embedder', () => {
  after(() => resetEmbedder());

  it('setEmbedder accepts custom embedder with required interface', () => {
    const custom = {
      id: 'mock',
      dimensions: 4,
      embed: () => new Float32Array([1, 0, 0, 0]),
      similarity: (a, b) => a[0] * b[0],
    };
    setEmbedder(custom);
    const active = getEmbedder();
    assert.equal(active.id, 'mock');
    assert.equal(active.dimensions, 4);
  });

  it('rejects embedders without required methods', () => {
    assert.throws(() => setEmbedder({}), /must implement/);
    assert.throws(() => setEmbedder({ embed: () => {} }), /must implement/);
  });
});

describe('embeddings :: rank against built index', () => {
  let tmp;
  let savedRoot;
  let index;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-emb-'));
    savedRoot = savedProjectRoot;
    setProjectRoot(tmp);
    fs.writeFileSync(path.join(tmp, 'user-repo.js'), [
      'export class UserRepository {',
      '  async findById(id) { return null; }',
      '  async findByEmail(email) { return null; }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'auth-jwt.js'), [
      'export const signJwt = (payload, secret) => { return null; };',
      'export const verifyJwt = (token, secret) => { return null; };',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'notification-email.js'), [
      'export const sendEmail = async (to, subject, body) => { return null; };',
    ].join('\n'));
    index = buildIndex(tmp);
  });

  after(() => {
    setProjectRoot(savedRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('semanticRankSymbols puts UserRepository symbols on top for a user query', () => {
    const idf = buildIndexCorpusIdf(index);
    const ranks = semanticRankSymbols({ query: 'user repository find by id', index, limit: 5, idf });
    assert.ok(ranks.length > 0);
    const topPath = ranks[0].path;
    assert.equal(topPath, 'user-repo.js');
  });

  it('semanticRankFiles ranks jwt-related file higher for jwt query', () => {
    const idf = buildIndexCorpusIdf(index);
    const ranks = semanticRankFiles({ query: 'sign jwt token secret hmac', index, limit: 3, idf });
    assert.ok(ranks.length > 0);
    assert.equal(ranks[0].path, 'auth-jwt.js');
  });
});

describe('smart_search :: semantic opt-in', () => {
  let tmp;
  let savedRoot;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-emb-search-'));
    savedRoot = savedProjectRoot;
    setProjectRoot(tmp);
    fs.writeFileSync(path.join(tmp, 'user-service.js'), [
      'export class UserService {',
      '  async registerNewUser(email, password) { return null; }',
      '  async loginUser(email, password) { return null; }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'logger.js'), [
      'export class Logger { info(msg) {} error(msg) {} }',
    ].join('\n'));
    const { persistIndex } = await import('../src/index.js');
    const idx = buildIndex(tmp);
    await persistIndex(idx, tmp);
  });

  after(() => {
    setProjectRoot(savedRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns semantic block when semantic=true', async () => {
    const result = await smartSearch({ query: 'user registration', cwd: tmp, semantic: true, semanticLimit: 3 });
    assert.ok(result.semantic, 'expected semantic block');
    assert.equal(result.semantic.embedder, 'hashing-v1');
    assert.ok(Array.isArray(result.semantic.symbols));
    assert.ok(Array.isArray(result.semantic.files));
    assert.equal(result.mode, 'semantic');
    if (result.semantic.symbols.length > 0) {
      assert.equal(result.semantic.symbols[0].matchedBy, 'semantic');
      assert.match(result.semantic.symbols[0].whyRanked, /semantic similarity/);
    }
  });

  it('returns semantic block when mode=semantic and exact signal is weak', async () => {
    const result = await smartSearch({ query: 'user registration', cwd: tmp, mode: 'semantic', semanticLimit: 3 });
    assert.equal(result.mode, 'semantic');
    assert.ok(result.semantic, 'expected semantic block for semantic mode');
  });

  it('needle mode skips term expansion for conceptual multi-word queries', async () => {
    const result = await smartSearch({ query: 'register new user', cwd: tmp, mode: 'needle' });
    assert.equal(result.mode, 'needle');
    assert.equal(result.totalMatches, 0);
    assert.equal(result.semantic, undefined);
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(result.suggestions.some((item) => item.includes('mode="balanced"')));
    assert.ok(result.suggestions.some((item) => item.includes('mode="semantic"')));
    assert.match(result.matches, /Suggestions:/);
  });

  it('balanced mode preserves term expansion behavior by default', async () => {
    const result = await smartSearch({ query: 'register new user', cwd: tmp });
    assert.equal(result.mode, 'balanced');
    assert.ok(result.totalMatches > 0, 'expected default balanced mode to recover term matches');
  });

  it('does NOT include semantic block by default', async () => {
    const result = await smartSearch({ query: 'register', cwd: tmp });
    assert.equal(result.mode, 'balanced');
    assert.equal(result.semantic, undefined);
  });
});
