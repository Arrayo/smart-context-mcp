import { smartRead } from './smart-read.js';
import { countTokens } from '../tokenCounter.js';

export const smartReadBatch = async ({ files, maxTokens, tokenBudget }) => {
  const results = [];
  let totalTokens = 0;
  let filesSkipped = 0;
  let budgetStoppedAt = null;

  for (const item of files) {
    try {
      const readResult = await smartRead({
        filePath: item.path,
        mode: item.mode,
        symbol: item.symbol,
        startLine: item.startLine,
        endLine: item.endLine,
        maxTokens: item.maxTokens,
        tokenBudget,
      });

      if (readResult.error) {
        results.push({
          filePath: item.path,
          mode: item.mode ?? 'outline',
          error: readResult.error,
        });
        continue;
      }

      const itemTokens = countTokens(readResult.content);

      if (maxTokens && totalTokens + itemTokens > maxTokens && results.length > 0) {
        filesSkipped = files.length - results.length;
        budgetStoppedAt = item.path;
        break;
      }

      results.push({
        filePath: readResult.filePath,
        mode: readResult.mode,
        parser: readResult.parser,
        truncated: readResult.truncated,
        content: readResult.content,
        ...(readResult.indexHint !== undefined ? { indexHint: readResult.indexHint } : {}),
        ...(readResult.chosenMode ? { chosenMode: readResult.chosenMode } : {}),
        ...(readResult.budgetApplied ? { budgetApplied: true, budgetDetails: readResult.budgetDetails } : {}),
      });

      totalTokens += itemTokens;
    } catch (err) {
      results.push({
        filePath: item.path,
        mode: item.mode ?? 'outline',
        error: err.message || 'Failed to read file',
      });
    }
  }

  const response = {
    results,
    metrics: {
      totalTokens,
      filesRead: results.length,
      filesSkipped,
    },
  };

  if (maxTokens && filesSkipped > 0) {
    response.budgetApplied = true;
    response.budgetDetails = {
      scope: 'batch',
      maxTokens,
      actions: ['batch_stopped_early'],
      filesRead: results.length,
      filesSkipped,
      stopReason: 'batch_token_limit',
      ...(budgetStoppedAt ? { stoppedBefore: budgetStoppedAt } : {}),
    };
  }

  if (tokenBudget) {
    response.taskBudget = tokenBudget;
  }

  return response;
};
