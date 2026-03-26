#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFilePath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFilePath);
const devctxDir = path.resolve(scriptsDir, '..');
const supportedClients = new Set(['cursor', 'codex', 'qwen', 'claude']);

const requireValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

const parseArgs = (argv) => {
  const options = {
    target: process.cwd(),
    name: 'devctx',
    command: 'node',
    args: null,
    clients: [...supportedClients],
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--target') {
      options.target = requireValue(argv, index, '--target');
      index += 1;
      continue;
    }

    if (token === '--name') {
      options.name = requireValue(argv, index, '--name');
      index += 1;
      continue;
    }

    if (token === '--command') {
      options.command = requireValue(argv, index, '--command');
      index += 1;
      continue;
    }

    if (token === '--args') {
      const raw = requireValue(argv, index, '--args');
      try {
        options.args = JSON.parse(raw);
      } catch {
        throw new Error('--args must be valid JSON');
      }
      if (!Array.isArray(options.args)) {
        throw new Error('--args must be a JSON array');
      }
      index += 1;
      continue;
    }

    if (token === '--clients') {
      options.clients = requireValue(argv, index, '--clients')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  const invalidClients = options.clients.filter((client) => !supportedClients.has(client));

  if (invalidClients.length > 0) {
    throw new Error(`Unsupported clients: ${invalidClients.join(', ')}`);
  }

  return options;
};

const normalizeCommandPath = (value) => {
  if (path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
    return value;
  }

  return `./${value}`;
};

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
};

const writeFile = (filePath, content, dryRun) => {
  if (dryRun) {
    console.log(`[dry-run] write ${filePath}`);
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`updated ${filePath}`);
};

const getServerConfig = ({ name, command, args }) => ({
  name,
  config: {
    command,
    args,
  },
});

const updateCursorConfig = (targetDir, serverConfig, dryRun) => {
  const filePath = path.join(targetDir, '.cursor', 'mcp.json');
  const current = readJson(filePath, { mcpServers: {} });
  current.mcpServers ??= {};
  current.mcpServers[serverConfig.name] = serverConfig.config;
  writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, dryRun);
};

const updateClaudeConfig = (targetDir, serverConfig, dryRun) => {
  const filePath = path.join(targetDir, '.mcp.json');
  const current = readJson(filePath, { mcpServers: {} });
  current.mcpServers ??= {};
  current.mcpServers[serverConfig.name] = {
    ...serverConfig.config,
    env: current.mcpServers[serverConfig.name]?.env ?? {},
  };
  writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, dryRun);
};

const updateQwenConfig = (targetDir, serverConfig, dryRun) => {
  const filePath = path.join(targetDir, '.qwen', 'settings.json');
  const current = readJson(filePath, {});
  current.mcp ??= {};
  current.mcp.enabled = true;
  current.mcpServers ??= {};
  current.mcpServers[serverConfig.name] = serverConfig.config;
  writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, dryRun);
};

const buildCodexSection = (serverConfig) => {
  const header = `[mcp_servers.${serverConfig.name}]`;
  const body = [
    'enabled = true',
    'required = false',
    `command = ${JSON.stringify(serverConfig.config.command)}`,
    `args = [${serverConfig.config.args.map((value) => JSON.stringify(value)).join(', ')}]`,
    'startup_timeout_sec = 15.0',
    'tool_timeout_sec = 30.0',
  ];

  return { header, body };
};

const upsertTomlSection = (content, header, bodyLines) => {
  const lines = content.split('\n');
  const nextLines = [];
  let skipping = false;
  let found = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!skipping && trimmed === header) {
      found = true;
      skipping = true;
      continue;
    }

    if (skipping) {
      if (trimmed.startsWith('[') && trimmed !== header) {
        skipping = false;
        nextLines.push(line);
      }
      continue;
    }

    nextLines.push(line);
  }

  const preserved = nextLines.join('\n').trim();
  const section = [header, ...bodyLines].join('\n');

  if (!found && preserved.length === 0) {
    return `${section}\n`;
  }

  if (!found) {
    return `${preserved}\n\n${section}\n`;
  }

  if (preserved.length === 0) {
    return `${section}\n`;
  }

  return `${preserved}\n\n${section}\n`;
};

const updateCodexConfig = (targetDir, serverConfig, dryRun) => {
  const filePath = path.join(targetDir, '.codex', 'config.toml');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const section = buildCodexSection(serverConfig);
  const nextContent = upsertTomlSection(current, section.header, section.body);
  writeFile(filePath, nextContent, dryRun);
};

// ---------------------------------------------------------------------------
// Agent rules — instruct agents to prefer devctx tools over built-in ones
// ---------------------------------------------------------------------------

const agentRuleBody = `Always prefer devctx MCP tools over built-in file reading, code search, and diagnostics.

- Use smart_read outline or signatures before full (~90% token savings).
- Use smart_read symbol (string or array) to extract specific functions/classes before editing.
- Use smart_read range for specific lines when you know the location.
- Use full mode only when outline/signatures/symbol are insufficient.
- Use smart_search instead of grep/ripgrep — it groups, ranks, and filters automatically.
- Pass intent to smart_search to get task-aware ranking (implementation/debug/tests/config/docs/explore).
- Use smart_shell for diagnostics: git status, ls, find, pwd, test output.

By task:
- Debugging: smart_search with intent=debug → read signatures → inspect symbol → smart_shell for tests/errors.
- Review: smart_search with intent=implementation → read outline/signatures, focus on changed symbols, minimal changes.
- Refactor: smart_search with intent=implementation → signatures for public API, preserve behavior, small edits, verify with tests.
- Tests: smart_search with intent=tests → find existing tests, read symbol of function under test.
- Config: smart_search with intent=config → find settings, env vars, infrastructure files.
- Architecture: smart_search with intent=explore → directory structure, outlines of key modules and API boundaries.`;

const cursorRuleContent = `---
description: Prefer devctx MCP tools for file reading, code search, and diagnostics
alwaysApply: true
---

${agentRuleBody}
`;

const updateCursorRule = (targetDir, dryRun) => {
  const filePath = path.join(targetDir, '.cursor', 'rules', 'devctx.mdc');
  writeFile(filePath, cursorRuleContent, dryRun);
};

const SECTION_START = '<!-- devctx:start -->';
const SECTION_END = '<!-- devctx:end -->';

const markdownSection = `${SECTION_START}
## devctx

${agentRuleBody}
${SECTION_END}`;

const upsertMarkdownSection = (content) => {
  const startIdx = content.indexOf(SECTION_START);
  const endIdx = content.indexOf(SECTION_END);

  if (startIdx !== -1 && endIdx !== -1) {
    return content.slice(0, startIdx) + markdownSection + content.slice(endIdx + SECTION_END.length);
  }

  const trimmed = content.trimEnd();
  return trimmed.length === 0 ? `${markdownSection}\n` : `${trimmed}\n\n${markdownSection}\n`;
};

const updateAgentsMd = (targetDir, dryRun) => {
  const filePath = path.join(targetDir, 'AGENTS.md');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  writeFile(filePath, upsertMarkdownSection(current), dryRun);
};

const updateClaudeMd = (targetDir, dryRun) => {
  const filePath = path.join(targetDir, 'CLAUDE.md');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  writeFile(filePath, upsertMarkdownSection(current), dryRun);
};

const hasGitignoreEntry = (content, entry) => {
  const target = entry.replace(/\/+$/, '');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\/+$/, ''))
    .includes(target);
};

const ensureGitignoreEntry = (targetDir, dryRun) => {
  const filePath = path.join(targetDir, '.gitignore');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  if (hasGitignoreEntry(current, '.devctx/')) return;

  const trimmed = current.trimEnd();
  const next = trimmed.length === 0 ? '.devctx/\n' : `${trimmed}\n\n.devctx/\n`;
  writeFile(filePath, next, dryRun);
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const targetDir = path.resolve(options.target);
  const defaultArgs = [normalizeCommandPath(path.relative(targetDir, path.join(devctxDir, 'src', 'mcp-server.js')))];
  const args = options.args ?? defaultArgs;
  const serverConfig = getServerConfig({
    name: options.name,
    command: options.command,
    args,
  });

  const clientSet = new Set(options.clients);
  ensureGitignoreEntry(targetDir, options.dryRun);

  if (clientSet.has('cursor')) {
    updateCursorConfig(targetDir, serverConfig, options.dryRun);
    updateCursorRule(targetDir, options.dryRun);
  }

  if (clientSet.has('codex')) {
    updateCodexConfig(targetDir, serverConfig, options.dryRun);
    updateAgentsMd(targetDir, options.dryRun);
  }

  if (clientSet.has('qwen')) {
    updateQwenConfig(targetDir, serverConfig, options.dryRun);
  }

  if (clientSet.has('claude')) {
    updateClaudeConfig(targetDir, serverConfig, options.dryRun);
    updateClaudeMd(targetDir, options.dryRun);
  }

  console.log(`configured clients: ${[...clientSet].join(', ')}`);
  console.log(`target: ${targetDir}`);
  console.log(`command: ${serverConfig.config.command} ${serverConfig.config.args.join(' ')}`);
};

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
