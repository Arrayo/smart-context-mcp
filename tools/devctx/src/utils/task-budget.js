export const normalizeTokenBudget = (value) => {
  if (Number.isFinite(value) && value >= 1) {
    return { maxTokens: Math.floor(value), shared: false };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const maxTokens = Number.isFinite(value.maxTokens) && value.maxTokens >= 1
    ? Math.floor(value.maxTokens)
    : null;

  if (!maxTokens) {
    return null;
  }

  const normalized = {
    maxTokens,
    shared: Boolean(value.shared || value.id),
  };

  if (typeof value.id === 'string' && value.id.trim()) {
    normalized.id = value.id.trim();
  }

  return normalized;
};

export const resolveBudgetMaxTokens = (maxTokens, tokenBudget) => {
  if (Number.isFinite(maxTokens) && maxTokens >= 1) {
    return maxTokens;
  }

  return normalizeTokenBudget(tokenBudget)?.maxTokens;
};

const sharedTaskBudgets = new Map();

const getSharedBudgetKey = (tokenBudget, fallbackKey = null) => {
  const normalized = normalizeTokenBudget(tokenBudget);
  if (!normalized?.shared) return null;
  if (normalized.id) return normalized.id;
  if (typeof fallbackKey === 'string' && fallbackKey.trim()) return fallbackKey.trim();
  return null;
};

const ensureSharedBudgetState = (normalizedTokenBudget, fallbackKey = null) => {
  const sharedKey = getSharedBudgetKey(normalizedTokenBudget, fallbackKey);
  if (!sharedKey) {
    return { sharedKey: null, state: null };
  }

  const existing = sharedTaskBudgets.get(sharedKey);
  if (!existing || existing.maxTokens !== normalizedTokenBudget.maxTokens) {
    const next = {
      maxTokens: normalizedTokenBudget.maxTokens,
      remainingBudget: normalizedTokenBudget.maxTokens,
    };
    sharedTaskBudgets.set(sharedKey, next);
    return { sharedKey, state: next };
  }

  return { sharedKey, state: existing };
};

export const resolveTokenBudgetWindow = ({ maxTokens, tokenBudget, fallbackKey = null } = {}) => {
  const normalized = normalizeTokenBudget(tokenBudget);
  const explicitMaxTokens = Number.isFinite(maxTokens) && maxTokens >= 1 ? Math.floor(maxTokens) : null;
  const baseMaxTokens = explicitMaxTokens ?? normalized?.maxTokens ?? null;

  if (!normalized) {
    return {
      normalized: null,
      sharedKey: null,
      remainingBudget: null,
      effectiveMaxTokens: baseMaxTokens,
    };
  }

  const { sharedKey, state } = ensureSharedBudgetState(normalized, fallbackKey);
  const remainingBudget = sharedKey ? state.remainingBudget : normalized.maxTokens;
  const effectiveMaxTokens = baseMaxTokens == null
    ? remainingBudget
    : Math.min(baseMaxTokens, remainingBudget);

  return {
    normalized,
    sharedKey,
    remainingBudget,
    effectiveMaxTokens,
  };
};

export const peekRemainingBudget = ({ tokenBudget, fallbackKey = null } = {}) =>
  resolveTokenBudgetWindow({ tokenBudget, fallbackKey }).remainingBudget;

export const consumeTokenBudget = ({ tokenBudget, usedTokens = 0, fallbackKey = null } = {}) => {
  const normalized = normalizeTokenBudget(tokenBudget);
  if (!normalized) {
    return null;
  }

  const consumed = Math.max(0, Math.floor(usedTokens));
  const { sharedKey, state } = ensureSharedBudgetState(normalized, fallbackKey);

  if (!sharedKey) {
    return Math.max(0, normalized.maxTokens - consumed);
  }

  state.remainingBudget = Math.max(0, state.remainingBudget - consumed);
  sharedTaskBudgets.set(sharedKey, state);
  return state.remainingBudget;
};

export const clearTaskBudgets = () => sharedTaskBudgets.clear();
