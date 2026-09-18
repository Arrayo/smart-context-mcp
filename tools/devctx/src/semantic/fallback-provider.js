const EMPTY_RESULT = Object.freeze([]);

export const createFallbackSemanticProvider = ({ reason = 'semantic provider unavailable' } = {}) => ({
  provider: 'fallback',
  reason,
  resolveSymbol() { return null; },
  touchFiles() {},
  async renameLocations() { return EMPTY_RESULT; },
  async definition() { return EMPTY_RESULT; },
  async references() { return EMPTY_RESULT; },
  async implementations() { return EMPTY_RESULT; },
  async diagnostics() { return EMPTY_RESULT; },
  async hover() { return null; },
});
