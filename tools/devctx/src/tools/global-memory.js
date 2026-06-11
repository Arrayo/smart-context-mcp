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
  VALID_GLOBAL_KINDS,
} from '../global-memory/store.js';
import { containsLikelySecret } from '../global-memory/scrub.js';
import { projectRoot } from '../utils/paths.js';
import { recordDevctxOperation } from '../missed-opportunities.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';

const VALID_ACTIONS = new Set(['save', 'recall', 'list', 'delete', 'stats', 'mark_used', 'noise_stats', 'noise_reset']);

export const globalMemory = async ({
  action = 'stats',
  kind,
  content,
  tags,
  query,
  limit,
  id,
  projectScope = true,
} = {}) => {
  if (!VALID_ACTIONS.has(action)) {
    return { success: false, error: `Invalid action: ${action}. Must be one of: ${[...VALID_ACTIONS].join(', ')}` };
  }

  if (!isGlobalMemoryEnabled()) {
    return {
      success: false,
      disabled: true,
      message: 'Global memory is opt-in. Set DEVCTX_GLOBAL_MEMORY=true to enable.',
      hint: 'Stored content is automatically scrubbed for secrets/emails/paths before persistence.',
    };
  }

  recordDevctxOperation();

  try {
    switch (action) {
      case 'save': {
        if (!kind || !content) return { success: false, error: 'save requires kind and content' };
        if (!VALID_GLOBAL_KINDS.has(kind)) {
          return { success: false, error: `Invalid kind. Must be one of: ${[...VALID_GLOBAL_KINDS].join(', ')}` };
        }
        const secretFlag = containsLikelySecret(content);
        const result = await saveEntry({
          kind,
          content,
          tags,
          projectPath: projectScope ? projectRoot : null,
        });
        recordDecision({
          tool: 'global_memory',
          action: `save ${kind}`,
          reason: DECISION_REASONS.RELATED_FILES ?? 'cross-project memory',
          alternative: 'Re-derive context next session manually',
          expectedBenefit: EXPECTED_BENEFITS.TOKEN_SAVINGS(content.length / 4),
          context: secretFlag ? 'Content contained likely secrets; scrubbed before persistence' : 'Saved without secret hits',
        });
        return { success: true, ...result, scrubbedFromSecrets: secretFlag };
      }
      case 'recall': {
        const result = await recallEntries({
          kind,
          query,
          limit: limit ?? 10,
          projectPath: projectScope ? projectRoot : null,
        });
        return { success: true, action, ...result };
      }
      case 'list': {
        const result = await listKinds();
        return { success: true, action, ...result };
      }
      case 'delete': {
        if (!id) return { success: false, error: 'delete requires id' };
        const result = await deleteEntry({ id });
        return { success: true, action, ...result };
      }
      case 'mark_used': {
        if (!id) return { success: false, error: 'mark_used requires id' };
        const result = await markEntryUsed({ id });
        return { success: true, action, ...result };
      }
      case 'stats':
      default: {
        const stats = await getStats();
        return { success: true, action: 'stats', ...stats };
      }
      case 'noise_stats': {
        const result = await getNoiseHints({ projectPath: projectScope ? projectRoot : null, limit: limit ?? 50 });
        return { success: true, action, ...result };
      }
      case 'noise_reset': {
        const result = await resetNoiseHints({ projectPath: projectScope ? projectRoot : null, hintKey: query });
        return { success: true, action, ...result };
      }
    }
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) };
  }
};
