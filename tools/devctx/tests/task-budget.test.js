import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearTaskBudgets, consumeTokenBudget, normalizeTokenBudget, peekRemainingBudget, resolveBudgetMaxTokens } from '../src/utils/task-budget.js';

describe('task budget helpers', () => {
  it('tracks shared budget consumption by id', () => {
    clearTaskBudgets();

    const tokenBudget = { id: 'shared-budget-test', maxTokens: 100, shared: true };
    assert.equal(peekRemainingBudget({ tokenBudget }), 100);
    assert.equal(consumeTokenBudget({ tokenBudget, usedTokens: 30 }), 70);
    assert.equal(peekRemainingBudget({ tokenBudget }), 70);
  });

  it('normalizes numeric token budgets', () => {
    assert.deepEqual(normalizeTokenBudget(120), {
      maxTokens: 120,
      shared: false,
    });
  });

  it('normalizes object token budgets', () => {
    assert.deepEqual(normalizeTokenBudget({ id: 'task-1', maxTokens: 300, shared: true }), {
      id: 'task-1',
      maxTokens: 300,
      shared: true,
    });
  });

  it('prefers explicit maxTokens over tokenBudget', () => {
    assert.equal(resolveBudgetMaxTokens(50, { maxTokens: 200 }), 50);
    assert.equal(resolveBudgetMaxTokens(undefined, { maxTokens: 200 }), 200);
  });
});
