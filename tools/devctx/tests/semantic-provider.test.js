import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFallbackSemanticProvider } from '../src/semantic/fallback-provider.js';
import {
  assertSemanticProvider,
  createSemanticProvider,
  isSemanticProvider,
  normalizeSemanticRequest,
} from '../src/semantic/semantic-provider.js';
import { createTypeScriptProvider } from '../src/semantic/typescript-provider.js';
import { createSemanticDiagnostic, severityFromTsCategory } from '../src/semantic/types.js';
import { smartCode } from '../src/tools/smart-code.js';

const makeFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-semantic-'));
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
  fs.writeFileSync(path.join(root, 'broken.ts'), `
const value: number = 'not-a-number';
`, 'utf8');
  fs.writeFileSync(path.join(root, 'service.test.ts'), `
import { loadUser } from './service.js';
export const smoke = () => loadUser({ findByEmail: (email) => email }, 'a@b.c');
`, 'utf8');
  return root;
};

const locationFor = (root, file, needle, occurrence = 0) => {
  const filePath = path.join(root, file);
  const source = fs.readFileSync(filePath, 'utf8');
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) offset = source.indexOf(needle, offset + 1);
  assert.notEqual(offset, -1, `needle not found: ${needle}`);
  const before = source.slice(0, offset);
  const line = before.split('\n').length - 1;
  const character = offset - before.lastIndexOf('\n') - 1;
  return { filePath, line, character };
};

test('semantic provider contract accepts the fallback provider', () => {
  const provider = createFallbackSemanticProvider();
  assert.equal(isSemanticProvider(provider), true);
  assert.equal(assertSemanticProvider(provider), provider);
  assert.equal(provider.resolveSymbol({ symbol: 'x' }), null);
});

test('normalizeSemanticRequest accepts symbol-only queries', () => {
  const request = normalizeSemanticRequest({ action: 'references', symbol: 'loadUser' });
  assert.equal(request.symbol, 'loadUser');
  assert.equal(request.location, null);
});

test('diagnostic helpers normalize severity and shape', () => {
  assert.equal(severityFromTsCategory(1), 'error');
  const diagnostic = createSemanticDiagnostic({
    root: '/tmp/project',
    filePath: '/tmp/project/src/a.ts',
    start: { line: 2, character: 1 },
    end: { line: 2, character: 5 },
    severity: 'error',
    code: 2322,
    message: "Type 'string' is not assignable to type 'number'.",
    category: 'semantic',
  });
  assert.deepEqual(diagnostic, {
    filePath: 'src/a.ts',
    start: { line: 2, character: 1 },
    end: { line: 2, character: 5 },
    severity: 'error',
    code: 2322,
    message: "Type 'string' is not assignable to type 'number'.",
    category: 'semantic',
  });
});

test('TypeScript provider resolves definitions and references across files', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const callSite = locationFor(root, 'service.ts', 'findByEmail');
    const definitions = await provider.definition(callSite);
    const references = await provider.references(callSite);

    assert.ok(definitions.some((item) => item.filePath === 'repository.ts'));
    assert.ok(references.some((item) => item.filePath === 'service.ts'));
    assert.ok(references.some((item) => item.filePath === 'repository.ts'));
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript provider resolves interface implementations', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const interfaceSite = locationFor(root, 'repository.ts', 'UserRepository');
    const implementations = await provider.implementations(interfaceSite);
    assert.ok(implementations.some((item) => item.filePath === 'repository.ts'));
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript provider resolves symbols by name without positions', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const byName = provider.resolveSymbol({ symbol: 'loadUser' });
    assert.ok(byName);
    assert.equal(byName.filePath, 'service.ts');
    assert.equal(typeof byName.line, 'number');
    assert.equal(typeof byName.character, 'number');

    const scoped = provider.resolveSymbol({ symbol: 'findByEmail', filePath: 'repository.ts' });
    assert.ok(scoped);
    assert.equal(scoped.filePath, 'repository.ts');

    const missing = provider.resolveSymbol({ symbol: 'DoesNotExistAnywhere' });
    assert.equal(missing, null);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript provider returns compact normalized diagnostics', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const diagnostics = await provider.diagnostics({ filePath: 'broken.ts', line: 0, character: 0 });
    assert.ok(diagnostics.length >= 1);
    const first = diagnostics[0];
    assert.equal(first.filePath, 'broken.ts');
    assert.ok(['error', 'warning', 'suggestion', 'message'].includes(first.severity));
    assert.ok(typeof first.message === 'string' && first.message.length > 0);
    assert.ok(['semantic', 'syntactic'].includes(first.category));
    assert.ok(first.start?.line >= 1);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript provider returns empty results for unknown locations', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    assert.deepEqual(await provider.definition({ filePath: 'missing.ts', line: 0, character: 0 }), []);
    assert.deepEqual(await provider.references({ filePath: 'missing.ts', line: 0, character: 0 }), []);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code resolves references by symbol name', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const result = await smartCode({
      action: 'references',
      symbol: 'loadUser',
      cwd: root,
      _provider: provider,
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, 'typescript');
    assert.equal(result.resolution, 'symbol');
    assert.ok(result.total >= 1);
    assert.ok(result.results.some((item) => item.filePath === 'service.ts' || item.filePath === 'service.test.ts'));
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code can exclude test paths and truncate results', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const result = await smartCode({
      action: 'references',
      symbol: 'loadUser',
      includeTests: false,
      maxResults: 1,
      cwd: root,
      _provider: provider,
    });

    assert.equal(result.success, true);
    assert.ok(result.results.every((item) => !item.filePath.includes('.test.')));
    assert.equal(result.returned, Math.min(1, result.total));
    if (result.total > 1) assert.equal(result.truncated, true);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code falls back without throwing when provider is fallback', async () => {
  const root = makeFixture();
  const provider = createFallbackSemanticProvider({ reason: 'test fallback' });

  const result = await smartCode({
    action: 'definition',
    symbol: 'loadUser',
    cwd: root,
    _provider: provider,
  });

  assert.equal(result.success, true);
  assert.equal(result.provider, 'fallback');
  assert.equal(result.confidence, 'none');
  assert.deepEqual(result.results, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('smart_code impact separates direct, transitive, tests and heuristic risk', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });
  const { buildIndex, persistIndex } = await import('../src/index.js');
  const index = buildIndex(root);
  await persistIndex(index, root);

  try {
    const result = await smartCode({
      action: 'impact',
      symbol: 'loadUser',
      cwd: root,
      _provider: provider,
      maxResults: 20,
      maxHops: 2,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'impact');
    assert.ok(result.impact);
    assert.equal(result.impact.direct.source, 'semantic');
    assert.equal(result.impact.transitive.source, 'import-graph');
    assert.equal(result.impact.transitive.basis, 'heuristic-expansion');
    assert.equal(result.impact.risk.basis, 'heuristic');
    assert.ok(['low', 'medium', 'high'].includes(result.impact.risk.level));
    assert.ok(Array.isArray(result.impact.risk.reasons));
    assert.match(result.impact.risk.note, /not a semantic certainty/i);
    assert.ok(result.impact.coverage);
    assert.equal(typeof result.impact.coverage.hasDefinition, 'boolean');
    assert.ok(result.totals);
    assert.ok(result.impact.direct.counts.files >= 1 || result.definition);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code impact with fallback provider stays diagnostic', async () => {
  const root = makeFixture();
  const result = await smartCode({
    action: 'impact',
    symbol: 'loadUser',
    cwd: root,
    _provider: createFallbackSemanticProvider({ reason: 'test fallback' }),
  });

  assert.equal(result.success, true);
  assert.equal(result.action, 'impact');
  assert.equal(result.provider, 'fallback');
  assert.equal(result.impact.risk.basis, 'heuristic');
  fs.rmSync(root, { recursive: true, force: true });
});

test('validateNewName rejects invalid and reserved identifiers', async () => {
  const { validateNewName } = await import('../src/semantic/rename.js');
  assert.equal(validateNewName('fetchUser').valid, true);
  assert.equal(validateNewName('2bad').valid, false);
  assert.equal(validateNewName('has space').valid, false);
  assert.equal(validateNewName('class').valid, false);
  assert.equal(validateNewName('').valid, false);
});

test('smart_code rename defaults to dryRun and writes nothing', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });
  const before = fs.readFileSync(path.join(root, 'service.ts'), 'utf8');

  try {
    const result = await smartCode({
      action: 'rename',
      symbol: 'loadUser',
      newName: 'fetchUser',
      cwd: root,
      _provider: provider,
    });

    assert.equal(result.action, 'rename');
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.equal(result.canApply, true);
    assert.equal(result.newName, 'fetchUser');
    assert.ok(result.plan.filesAffected >= 2, 'rename should span declaration and call site files');
    assert.ok(result.plan.totalEdits >= 2);

    const serviceEntry = result.plan.files.find((item) => item.file === 'service.ts');
    assert.ok(serviceEntry, 'planned files should include service.ts');
    assert.ok(serviceEntry.hunks.length >= 1);
    assert.match(serviceEntry.hunks[0].before, /loadUser/);
    assert.match(serviceEntry.hunks[0].after, /fetchUser/);
    assert.equal(serviceEntry.originalContent, undefined, 'plan must not leak file bodies');
    assert.match(result.message, /dry run/i);

    assert.equal(fs.readFileSync(path.join(root, 'service.ts'), 'utf8'), before);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code rename applies edits and reports diagnostics afterwards', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });

  try {
    const result = await smartCode({
      action: 'rename',
      symbol: 'loadUser',
      newName: 'fetchUser',
      dryRun: false,
      cwd: root,
      _provider: provider,
    });

    assert.equal(result.applied, true);
    assert.equal(result.dryRun, false);
    assert.ok(result.written.includes('service.ts'));
    assert.ok(Array.isArray(result.diagnosticsAfter));

    const service = fs.readFileSync(path.join(root, 'service.ts'), 'utf8');
    assert.match(service, /export function fetchUser/);
    assert.doesNotMatch(service, /loadUser/);

    const spec = fs.readFileSync(path.join(root, 'service.test.ts'), 'utf8');
    assert.match(spec, /fetchUser/);
    assert.doesNotMatch(spec, /loadUser/);

    const leftover = result.diagnosticsAfter.filter((item) => /cannot find name/i.test(item.message ?? ''));
    assert.deepEqual(leftover, [], 'rename should not leave unresolved identifiers');
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code rename blocks on error conflicts without writing', async () => {
  const root = makeFixture();
  const provider = createTypeScriptProvider({ root });
  const before = fs.readFileSync(path.join(root, 'service.ts'), 'utf8');

  try {
    const invalidName = await smartCode({
      action: 'rename',
      symbol: 'loadUser',
      newName: 'class',
      dryRun: false,
      cwd: root,
      _provider: provider,
    });
    assert.equal(invalidName.applied, false);
    assert.equal(invalidName.conflicts[0].type, 'invalid-name');

    const sameName = await smartCode({
      action: 'rename',
      symbol: 'loadUser',
      newName: 'loadUser',
      dryRun: false,
      cwd: root,
      _provider: provider,
    });
    assert.equal(sameName.applied, false);
    assert.equal(sameName.conflicts[0].type, 'same-name');

    const unknown = await smartCode({
      action: 'rename',
      symbol: 'notAThing',
      newName: 'whatever',
      dryRun: false,
      cwd: root,
      _provider: provider,
    });
    assert.equal(unknown.success, false);
    assert.equal(unknown.applied, false);
    assert.equal(unknown.conflicts[0].type, 'unresolved-target');

    const tooMany = await smartCode({
      action: 'rename',
      symbol: 'loadUser',
      newName: 'fetchUser',
      dryRun: false,
      maxFiles: 1,
      cwd: root,
      _provider: provider,
    });
    assert.equal(tooMany.applied, false);
    assert.equal(tooMany.conflicts[0].type, 'too-many-files');

    assert.equal(fs.readFileSync(path.join(root, 'service.ts'), 'utf8'), before);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smart_code rename with fallback provider reports unsupported provider', async () => {
  const root = makeFixture();

  const result = await smartCode({
    action: 'rename',
    symbol: 'loadUser',
    newName: 'fetchUser',
    cwd: root,
    _provider: createFallbackSemanticProvider({ reason: 'test fallback' }),
  });

  assert.equal(result.applied, false);
  assert.equal(result.provider, 'fallback');
  assert.ok(['unresolved-target', 'no-locations'].includes(result.conflicts[0].type));
  fs.rmSync(root, { recursive: true, force: true });
});

test('createSemanticProvider forceFallback returns fallback provider', () => {
  const provider = createSemanticProvider({ forceFallback: true });
  assert.equal(provider.provider, 'fallback');
});
