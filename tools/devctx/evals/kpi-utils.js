export const TASK_SIZE_BY_TYPE = Object.freeze({
  'find-definition': 'short',
  debug: 'short',
  tests: 'short',
  config: 'short',
  'search-comparison': 'short',
  review: 'long',
  'code-review': 'long',
  refactor: 'long',
  refactoring: 'long',
  onboard: 'long',
  explore: 'long',
  architecture: 'long',
  testing: 'long',
  entryfile: 'long',
  'budget-test': 'long',
});

export const bucketTaskSize = (taskType) => TASK_SIZE_BY_TYPE[taskType] ?? 'long';

export const average = (items, selector) => {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.reduce((sum, item) => sum + selector(item), 0) / items.length;
};

export const ratio = (numerator, denominator, digits = 3) => {
  if (!denominator) return 0;
  return +((numerator / denominator).toFixed(digits));
};

export const summarizeTaskSizes = (items, buildMetrics) => {
  const buckets = new Map([
    ['short', []],
    ['long', []],
  ]);

  for (const item of items) {
    const bucket = bucketTaskSize(item.taskType ?? item.type);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(item);
  }

  const summary = {};
  for (const [bucket, subset] of buckets.entries()) {
    if (subset.length === 0) continue;
    summary[bucket] = {
      count: subset.length,
      ...buildMetrics(subset),
    };
  }

  return summary;
};
