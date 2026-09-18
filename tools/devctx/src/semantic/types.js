export const SEMANTIC_ACTIONS = Object.freeze([
  'definition',
  'references',
  'implementations',
  'hover',
  'diagnostics',
]);

export const SMART_CODE_ACTIONS = Object.freeze([
  'definition',
  'references',
  'implementations',
  'diagnostics',
  'impact',
  'rename',
]);

export const DIAGNOSTIC_SEVERITIES = Object.freeze([
  'warning',
  'error',
  'suggestion',
  'message',
]);

export const normalizeSemanticLocation = (location) => {
  if (!location || typeof location !== 'object') return null;
  const filePath = typeof location.filePath === 'string' ? location.filePath : null;
  if (!filePath) return null;

  const line = Number.isInteger(location.line) ? location.line : 0;
  const character = Number.isInteger(location.character) ? location.character : 0;
  return {
    filePath,
    line: Math.max(0, line),
    character: Math.max(0, character),
  };
};

export const createSemanticLocation = ({ filePath, start, end, root }) => ({
  filePath: root && filePath.startsWith(root)
    ? filePath.slice(root.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/'),
  start,
  ...(end ? { end } : {}),
});

export const severityFromTsCategory = (category) => {
  switch (category) {
    case 0: return 'warning';
    case 1: return 'error';
    case 2: return 'suggestion';
    case 3: return 'message';
    default: return 'message';
  }
};

export const createSemanticDiagnostic = ({
  filePath,
  start,
  end,
  severity = 'message',
  code = null,
  message,
  category = 'semantic',
  root,
} = {}) => {
  if (!filePath || typeof message !== 'string' || !message) return null;
  const relativePath = root && filePath.startsWith(root)
    ? filePath.slice(root.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
    : String(filePath).replace(/\\/g, '/');

  return {
    filePath: relativePath,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    severity: DIAGNOSTIC_SEVERITIES.includes(severity) ? severity : 'message',
    ...(code != null ? { code: Number(code) } : {}),
    message,
    category: category === 'syntactic' ? 'syntactic' : 'semantic',
  };
};
