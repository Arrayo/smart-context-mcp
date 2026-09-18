#!/usr/bin/env node

/**
 * Direct feature verification - calls functions directly instead of via MCP.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, buildIndexIncremental, persistIndex } from '../src/index.js';
import { smartRead } from '../src/tools/smart-read.js';
import { smartSearch } from '../src/tools/smart-search.js';
import { smartContext } from '../src/tools/smart-context.js';
import { smartReadBatch } from '../src/tools/smart-read-batch.js';
import { warmCache, getCacheStats } from '../src/cache-warming.js';
import { getSymbolBlame, getFileAuthorshipStats, getRecentlyModifiedSymbols } from '../src/git-blame.js';
import { discoverRelatedProjects, getCrossProjectStats } from '../src/cross-project.js';
import { projectRoot } from '../src/utils/paths.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromPackage = (relativePath) =>
  path.relative(projectRoot, path.join(packageDir, relativePath)).split(path.sep).join('/');

const SERVER_FILE = fromPackage('src/server.js');
const INDEX_FILE = fromPackage('src/index.js');

const results = {
  passed: [],
  failed: [],
  warnings: [],
};

const success = (msg) => {
  console.log(`✓ ${msg}`);
  results.passed.push(msg);
};

const fail = (msg, error) => {
  console.log(`✗ ${msg}`);
  console.log(`  Error: ${error.message}`);
  results.failed.push({ test: msg, error: error.message });
};

const warn = (msg) => {
  console.log(`⚠ ${msg}`);
  results.warnings.push(msg);
};

console.log('🔍 Verificando todas las funcionalidades del MCP...\n');

const runTests = async () => {
  console.log('📦 1. Verificando herramientas básicas...\n');

  try {
    const index = buildIndex(projectRoot);
    await persistIndex(index, projectRoot);
    const fileCount = Object.keys(index.files).length;
    const symbolCount = Object.values(index.files).reduce((sum, f) => sum + (f.symbols?.length || 0), 0);
    success(`build_index: ${fileCount} archivos, ${symbolCount} símbolos`);
  } catch (error) {
    fail('build_index', error);
  }

  try {
    const result = await smartRead({
      filePath: SERVER_FILE,
      mode: 'outline'
    });
    
    if (result.content && result.mode === 'outline') {
      success(`smart_read: modo ${result.mode}, parser ${result.parser}`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('smart_read', error);
  }

  try {
    const result = await smartSearch({
      query: 'export function',
      intent: 'implementation'
    });
    
    if (result.matches && result.totalMatches !== undefined) {
      success(`smart_search: ${result.totalMatches} matches en ${result.matchedFiles} archivos`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('smart_search', error);
  }

  try {
    const result = await smartContext({
      task: 'understand the MCP server',
      detail: 'minimal',
      maxTokens: 2000
    });
    
    if (result.context && Array.isArray(result.context)) {
      success(`smart_context: ${result.context.length} items`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('smart_context', error);
  }

  try {
    const result = await smartReadBatch({
      files: [
        { path: SERVER_FILE, mode: 'outline' },
        { path: INDEX_FILE, mode: 'outline' }
      ]
    });

    if (result.results?.length === 2 && result.results.every((item) => !item.error)) {
      success(`smart_read_batch: ${result.metrics.filesRead} archivos`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('smart_read_batch', error);
  }

  console.log('\n🆕 2. Verificando nuevas funcionalidades...\n');

  try {
    const result = await warmCache(projectRoot);
    
    if (result.warmed !== undefined && result.skipped !== undefined) {
      success(`warm_cache: ${result.warmed} precargados, ${result.skipped} omitidos`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('warm_cache', error);
  }

  try {
    const result = await getSymbolBlame('tools/devctx/src/server.js', projectRoot);
    
    if (Array.isArray(result)) {
      success(`git_blame (symbol): ${result.length} símbolos`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('git_blame (symbol)', error);
  }

  try {
    const result = await getFileAuthorshipStats('tools/devctx/src/server.js', projectRoot);
    
    if (result.authors && Array.isArray(result.authors)) {
      success(`git_blame (file): ${result.authors.length} autores, ${result.totalLines} líneas`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('git_blame (file)', error);
  }

  try {
    const result = await getRecentlyModifiedSymbols(projectRoot, 10, 30);
    
    if (Array.isArray(result)) {
      success(`git_blame (recent): ${result.length} símbolos recientes`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('git_blame (recent)', error);
  }

  try {
    const result = discoverRelatedProjects(projectRoot);
    
    if (Array.isArray(result)) {
      success(`cross_project (discover): ${result.length} proyectos`);
      if (result.length === 0) {
        warn('No hay .devctx-projects.json (normal si no usas multi-proyecto)');
      }
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('cross_project (discover)', error);
  }

  try {
    const result = getCrossProjectStats(projectRoot);
    
    if (result.totalProjects !== undefined) {
      success(`cross_project (stats): ${result.totalProjects} proyectos, ${result.indexedProjects} indexados`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('cross_project (stats)', error);
  }

  console.log('\n📊 3. Verificando funcionalidades avanzadas...\n');

  try {
    const result = await smartContext({
      task: 'review recent changes',
      diff: 'HEAD~5',
      detail: 'minimal',
      maxTokens: 2000
    });
    
    if (result.context) {
      const diffInfo = result.diffSummary ? ` (${result.diffSummary.totalChanged || 0} cambios)` : '';
      success(`smart_context (diff)${diffInfo}`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('smart_context (diff)', error);
  }

  try {
    const result = await smartContext({
      task: 'understand server implementation',
      prefetch: true,
      detail: 'minimal',
      maxTokens: 2000
    });
    
    if (result.context) {
      const confidence = result.prefetch?.confidence || 0;
      success(`smart_context (prefetch): confianza ${confidence.toFixed(2)}`);
    } else {
      throw new Error('Invalid result');
    }
  } catch (error) {
    fail('smart_context (prefetch)', error);
  }

  try {
    const { index, stats } = buildIndexIncremental(projectRoot);
    await persistIndex(index, projectRoot);
    
    const cacheResult = await warmCache(projectRoot);
    
    success(`build_index (incremental + warmCache): ${stats.total} archivos, ${cacheResult.warmed} precargados`);
  } catch (error) {
    fail('build_index (incremental + warmCache)', error);
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n📋 RESUMEN DE VERIFICACIÓN\n');
  console.log(`✓ Tests pasados: ${results.passed.length}`);
  console.log(`✗ Tests fallidos: ${results.failed.length}`);
  console.log(`⚠ Advertencias: ${results.warnings.length}`);

  if (results.failed.length > 0) {
    console.log('\n❌ Tests fallidos:');
    results.failed.forEach(f => {
      console.log(`  - ${f.test}: ${f.error}`);
    });
  }

  if (results.warnings.length > 0) {
    console.log('\n⚠️  Advertencias:');
    results.warnings.forEach(w => {
      console.log(`  - ${w}`);
    });
  }

  console.log('\n' + '='.repeat(60));

  if (results.failed.length === 0) {
    console.log('\n✅ TODAS LAS FUNCIONALIDADES VERIFICADAS CORRECTAMENTE\n');
    process.exit(0);
  } else {
    console.log('\n❌ ALGUNAS FUNCIONALIDADES FALLARON\n');
    process.exit(1);
  }
};

runTests().catch(error => {
  console.error('\n💥 Error fatal:', error);
  process.exit(1);
});
