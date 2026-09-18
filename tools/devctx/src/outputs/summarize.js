const ERROR_PATTERNS = [
  /^\s*not ok \d+/i,
  /\bassertion(?:error)?\b/i,
  /\b[A-Za-z]*Error\b/,
  /\bexception\b/i,
  /^\s*panic:/i,
  /\bFAIL(?:ED|URE)?\b/,
  /\berror\b/i,
  /^\s*✖/,
  /^\s*×/,
];

const WARNING_PATTERNS = [
  /\bwarn(?:ing)?\b/i,
  /\bdeprecat(?:ed|ion)\b/i,
];

const STACK_FRAME_RE = /^\s*at\s+\S+/;

export const classifyLine = (text) => {
  if (ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'error';
  if (WARNING_PATTERNS.some((pattern) => pattern.test(text))) return 'warning';
  if (STACK_FRAME_RE.test(text)) return 'stack';
  return 'info';
};

export const toLines = (content) => (typeof content === 'string' ? content.split('\n') : []);

const trimLine = (text, maxChars) => {
  const clean = text.replace(/\s+$/, '');
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
};

export const summarizeOutput = (content, {
  headLines = 5,
  tailLines = 10,
  maxErrorLines = 10,
  maxChars = 200,
} = {}) => {
  const lines = toLines(content);
  const counts = { total: lines.length, errors: 0, warnings: 0, stackFrames: 0 };
  const errors = [];

  lines.forEach((text, index) => {
    const kind = classifyLine(text);
    if (kind === 'error') {
      counts.errors += 1;
      if (errors.length < maxErrorLines) {
        errors.push({ line: index + 1, text: trimLine(text, maxChars) });
      }
    } else if (kind === 'warning') {
      counts.warnings += 1;
    } else if (kind === 'stack') {
      counts.stackFrames += 1;
    }
  });

  const head = lines.slice(0, headLines)
    .map((text, index) => ({ line: index + 1, text: trimLine(text, maxChars) }));
  const tailStart = Math.max(lines.length - tailLines, headLines);
  const tail = lines.slice(tailStart)
    .map((text, index) => ({ line: tailStart + index + 1, text: trimLine(text, maxChars) }));

  return { counts, errorLines: errors, head, tail };
};

export const excerptOutput = (content, {
  query = '',
  line = null,
  before = 3,
  after = 6,
  maxMatches = 5,
  maxChars = 300,
} = {}) => {
  const lines = toLines(content);

  const centers = [];
  if (Number.isInteger(line) && line > 0) {
    centers.push(line - 1);
  } else if (query) {
    const needle = query.toLowerCase();
    for (let index = 0; index < lines.length && centers.length < maxMatches; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) centers.push(index);
    }
  } else {
    const firstError = lines.findIndex((text) => classifyLine(text) === 'error');
    centers.push(firstError === -1 ? 0 : firstError);
  }

  const windows = [];
  for (const center of centers) {
    const start = Math.max(center - before, 0);
    const end = Math.min(center + after, lines.length - 1);
    const previous = windows[windows.length - 1];

    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    windows.push({ start, end });
  }

  return windows.map((window) => ({
    startLine: window.start + 1,
    endLine: window.end + 1,
    lines: lines.slice(window.start, window.end + 1)
      .map((text, index) => ({ line: window.start + index + 1, text: trimLine(text, maxChars) })),
  }));
};

export const truncateForStorage = (content, maxBytes) => {
  const raw = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= maxBytes) {
    return { content: raw, bytes, truncated: false };
  }

  const lines = toLines(raw);
  const headBudget = Math.floor(maxBytes * 0.3);
  const tailBudget = maxBytes - headBudget;

  const head = [];
  let headBytes = 0;
  for (const text of lines) {
    const size = Buffer.byteLength(text, 'utf8') + 1;
    if (headBytes + size > headBudget) break;
    head.push(text);
    headBytes += size;
  }

  const tail = [];
  let tailBytes = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const size = Buffer.byteLength(lines[index], 'utf8') + 1;
    if (tailBytes + size > tailBudget) break;
    tail.unshift(lines[index]);
    tailBytes += size;
  }

  const omitted = lines.length - head.length - tail.length;
  const marker = `… [devctx truncated ${omitted} line(s); tail preserved] …`;
  const joined = [...head, marker, ...tail].join('\n');

  return { content: joined, bytes: Buffer.byteLength(joined, 'utf8'), truncated: true };
};
