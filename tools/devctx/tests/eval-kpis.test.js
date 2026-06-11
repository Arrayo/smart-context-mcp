import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bucketTaskSize, summarizeTaskSizes, ratio } from '../evals/kpi-utils.js';

describe('eval KPI helpers', () => {
  it('buckets task types into short and long deterministically', () => {
    assert.equal(bucketTaskSize('debug'), 'short');
    assert.equal(bucketTaskSize('find-definition'), 'short');
    assert.equal(bucketTaskSize('review'), 'long');
    assert.equal(bucketTaskSize('refactor'), 'long');
    assert.equal(bucketTaskSize('unknown-type'), 'long');
  });

  it('summarizes results by task size', () => {
    const summary = summarizeTaskSizes([
      { taskType: 'debug', score: 1 },
      { taskType: 'tests', score: 3 },
      { taskType: 'review', score: 10 },
    ], (subset) => ({ avgScore: subset.reduce((sum, item) => sum + item.score, 0) / subset.length }));

    assert.deepEqual(summary, {
      short: { count: 2, avgScore: 2 },
      long: { count: 1, avgScore: 10 },
    });
  });

  it('computes ratios safely', () => {
    assert.equal(ratio(1, 4), 0.25);
    assert.equal(ratio(0, 0), 0);
  });
});
