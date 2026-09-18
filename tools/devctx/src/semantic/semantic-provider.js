import { SEMANTIC_ACTIONS, normalizeSemanticLocation } from './types.js';
import { createFallbackSemanticProvider } from './fallback-provider.js';
import { createTypeScriptProvider } from './typescript-provider.js';

const REQUIRED_METHODS = ['definition', 'references', 'implementations', 'diagnostics', 'hover'];

export const isSemanticProvider = (provider) =>
  provider && REQUIRED_METHODS.every((method) => typeof provider[method] === 'function');

export const assertSemanticProvider = (provider) => {
  if (!isSemanticProvider(provider)) {
    throw new TypeError(`Semantic provider must implement: ${REQUIRED_METHODS.join(', ')}`);
  }
  return provider;
};

export const normalizeSemanticRequest = ({ action, location, symbol, filePath } = {}) => {
  if (!SEMANTIC_ACTIONS.includes(action)) {
    throw new Error(`Unsupported semantic action: ${action}`);
  }

  const normalizedLocation = normalizeSemanticLocation(
    location ?? (filePath ? { filePath, line: 0, character: 0 } : null),
  );

  const hasSymbol = typeof symbol === 'string' && symbol.trim().length > 0;
  if (!normalizedLocation && !hasSymbol) {
    throw new Error('A semantic location with filePath, or a symbol name, is required');
  }

  return {
    action,
    location: normalizedLocation,
    symbol: hasSymbol ? symbol.trim() : null,
  };
};

export const createSemanticProvider = ({ root = process.cwd(), forceFallback = false } = {}) => {
  if (forceFallback) {
    return createFallbackSemanticProvider({ reason: 'forced fallback' });
  }

  try {
    return createTypeScriptProvider({ root });
  } catch (error) {
    return createFallbackSemanticProvider({
      reason: error?.message ?? 'failed to initialize TypeScript semantic provider',
    });
  }
};
