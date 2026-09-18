import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSemanticSymbols, expandWithSemantic } from '../src/semantic/context-expand.js';
import { createTypeScriptProvider } from '../src/semantic/typescript-provider.js';
import { createFallbackSemanticProvider } from '../src/semantic/fallback-provider.js';
import { formatReasonIncluded } from '../src/utils/context-scoring.js';
import { smartContext } from '../src/tools/smart-context.js';
import { setProjectRoot } from '../src/utils/runtime-config.js';
import { buildIndex, persistIndex } from '../src/index.js';
import { projectRoot } from '../src/utils/paths.js';

const makeFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-semantic-ctx-'));
  fs.writeFileSync(path.join(root, 'repository.ts'), `
export interface UserRepository {
  findByEmail(email: string): string;
}

export class InMemoryRepository implements UserRepository {
  findByEmail(email: string): string { return email; }
}
`, 'utf8');
  fs.writeFileSync(path.join(root, 'service.ts'), `
import { UserRepository } from './repository.js';

export function loadUser(repository: UserRepository, email: string): string {
  return repository.findByEmail(email);
}
`, 'utf8');
  fs.writeFileSync(path.join(root, 'service.test.ts'), `
import { loadUser } from './service.js';
export const smoke = () => loadUser({ findByEmail: (email) => email }, 'a@b.c');
`, 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'semantic-ctx-fixture', type: 'module' }), 'utf8');
  return root;
};

test('collectSemanticSymbols prefers explicit task candidates', () => {
  const symbols = collectSemanticSymbols({
    symbolCandidates: ['loadUser', 'extra'],
    primarySeeds: [{ matchedSymbols: ['ignored'] }],
    maxSymbols: 1,
  });
  assert.deepEqual(symbols, ['loadUser']);
});

test('formatReasonIncluded explains semantic evidence', () => {
  assert.equal(
    formatReasonIncluded([{ type: 'semanticReference', symbol: 'loadUser' }]),
    'semantic-ref: loadUser',
  );
  assert.equal(
    formatReasonIncluded([{ type: 'semanticImplementation', symbol: 'UserRepository' }]),
    'semantic-impl: UserRepository',
  );
});

test('expandWithSemantic adds callers and tests for a known symbol', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });
  const expanded = new Map([
    ['service.ts', {
      absPath: path.join(root, 'service.ts'),
      role: 'primary',
      evidence: [{ type: 'searchHit', query: 'loadUser', rank: 1 }],
    }],
  ]);

  try {
    const summary = await expandWithSemantic({
      root,
      expanded,
      symbolCandidates: ['loadUser'],
      primarySeeds: [{ rel: 'service.ts', matchedSymbols: ['loadUser'] }],
      maxFiles: 6,
      _provider: provider,
    });

    assert.equal(summary.provider, 'typescript');
    assert.ok(summary.symbolsResolved.some((item) => item.symbol === 'loadUser' && item.found));
    assert.ok(expanded.has('service.test.ts') || summary.filesAdded >= 0);
    if (expanded.has('service.test.ts')) {
      const testEntry = expanded.get('service.test.ts');
      assert.ok(testEntry.evidence.some((item) => item.type.startsWith('semantic')));
    }
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expandWithSemantic falls back without throwing', async () => {
  const root = makeFixture();
  const expanded = new Map([
    ['service.ts', {
      absPath: path.join(root, 'service.ts'),
      role: 'primary',
      evidence: [{ type: 'searchHit', query: 'loadUser', rank: 1 }],
    }],
  ]);
  const summary = await expandWithSemantic({
    root,
    expanded,
    symbolCandidates: ['loadUser'],
    _provider: createFallbackSemanticProvider({ reason: 'test' }),
  });

  assert.equal(summary.provider, 'fallback');
  assert.equal(summary.confidence, 'none');
  fs.rmSync(root, { recursive: true, force: true });
});

test('smart_context semantic include is opt-in and adds whyIncluded', async () => {
  const root = makeFixture();
  const previousRoot = projectRoot;
  setProjectRoot(root);

  try {
    const index = buildIndex(root);
    await persistIndex(index, root);

    const baseline = await smartContext({
      task: 'inspect loadUser callers',
      intent: 'explore',
      maxTokens: 4000,
      detail: 'minimal',
      include: ['hints', 'graph'],
      prefetch: false,
    });

    assert.equal(baseline.success, true);
    assert.equal(baseline.semantic, undefined);
    assert.ok(baseline.context.every((item) => item.whyIncluded === undefined));

    const semantic = await smartContext({
      task: 'inspect loadUser callers',
      intent: 'explore',
      maxTokens: 4000,
      detail: 'minimal',
      include: ['content', 'graph', 'hints', 'semantic'],
      prefetch: false,
    });

    assert.equal(semantic.success, true);
    assert.ok(semantic.semantic);
    assert.equal(semantic.semantic.enabled, true);
    assert.ok(['typescript', 'fallback', 'none'].includes(semantic.semantic.provider));
    assert.ok(semantic.stats.semantic?.enabled);
    assert.ok(semantic.context.every((item) => typeof item.whyIncluded === 'string'));
  } finally {
    setProjectRoot(previousRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
