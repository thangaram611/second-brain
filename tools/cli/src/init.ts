import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as p from '@clack/prompts';
import { z } from 'zod';
import { Brain } from '@second-brain/core';
import { LLM_PROVIDERS, EMBEDDING_PROVIDERS } from '@second-brain/ingestion';

const DEFAULT_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DIR, 'personal.db');
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

const ConfigSchema = z.object({
  defaultNamespace: z.string().min(1),
  dbPath: z.string().min(1),
  llm: z
    .object({
      provider: z.enum(LLM_PROVIDERS),
      model: z.string().min(1),
    })
    .optional(),
  embedding: z
    .object({
      provider: z.enum(EMBEDDING_PROVIDERS),
      model: z.string().min(1),
    })
    .optional(),
});

export type BrainConfig = z.infer<typeof ConfigSchema>;

export interface InitOptions {
  /** Non-interactive: skip all prompts and use defaults. */
  yes?: boolean;
  /** Explicit opt-in to mutate ~/.claude.json. Required even with --yes. */
  wireClaude?: boolean;
  /** Override default DB path. */
  db?: string;
  /** Override default namespace. */
  project?: string;
}

export interface ClaudeMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const DEFAULT_MODELS: Record<string, { chat: string; embed: string }> = {
  ollama: { chat: 'llama3.2', embed: 'nomic-embed-text' },
  anthropic: { chat: 'claude-sonnet-4-6', embed: 'text-embedding-3-small' },
  openai: { chat: 'gpt-5', embed: 'text-embedding-3-small' },
  groq: { chat: 'llama-3.3-70b', embed: 'text-embedding-3-small' },
};

export async function runInit(options: InitOptions): Promise<void> {
  p.intro('🧠 second-brain init');

  const dbPath = options.db ?? DEFAULT_DB_PATH;
  const dir = path.dirname(dbPath);
  const configPath = path.join(dir, 'config.json');
  const envPath = path.join(dir, '.env');
  fs.mkdirSync(dir, { recursive: true });

  const dbExists = fs.existsSync(dbPath);
  if (dbExists && !options.yes) {
    const proceed = await p.confirm({
      message: `A brain already exists at ${dbPath}. Reconfigure anyway?`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.outro('Nothing changed.');
      return;
    }
  } else if (dbExists && options.yes) {
    p.note(`Brain already exists at ${dbPath}. Leaving DB alone; only config updates will be written.`);
  }

  const namespace = options.project ?? (options.yes ? 'personal' : await askNamespace());
  if (p.isCancel(namespace)) return cancelled();

  const llmChoice = options.yes ? 'ollama' : await askLLMProvider();
  if (p.isCancel(llmChoice)) return cancelled();

  let apiKey: string | undefined;
  if (llmChoice !== 'skip' && llmChoice !== 'ollama' && !options.yes) {
    const envName = `BRAIN_LLM_API_KEY (or ${llmChoice.toUpperCase()}_API_KEY)`;
    const keyInput = await p.password({
      message: `API key for ${llmChoice} (leave blank to set later via ${envName}):`,
    });
    if (p.isCancel(keyInput)) return cancelled();
    apiKey = keyInput || undefined;
  }

  const embeddingDefault = llmChoice === 'anthropic' ? 'ollama' : llmChoice === 'skip' ? 'ollama' : llmChoice;
  const embeddingChoice = options.yes
    ? embeddingDefault
    : await askEmbeddingProvider(embeddingDefault as (typeof EMBEDDING_PROVIDERS)[number]);
  if (p.isCancel(embeddingChoice)) return cancelled();

  // Create the DB if it doesn't exist.
  if (!dbExists) {
    const brain = new Brain({ path: dbPath });
    brain.close();
  }

  // Write config.json (Zod-validated).
  const config: BrainConfig = {
    defaultNamespace: namespace,
    dbPath,
    ...(llmChoice !== 'skip'
      ? { llm: { provider: llmChoice, model: DEFAULT_MODELS[llmChoice].chat } }
      : {}),
    ...(embeddingChoice
      ? { embedding: { provider: embeddingChoice, model: DEFAULT_MODELS[embeddingChoice].embed } }
      : {}),
  };
  ConfigSchema.parse(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  // Persist API key out-of-band in a 0600 env file (never in config.json).
  if (apiKey) {
    writeEnvKey(envPath, 'BRAIN_LLM_API_KEY', apiKey);
  }

  // Claude Code MCP wiring: PRINT by default; only MUTATE when --wire-claude
  // is set AND the user confirms. --yes alone does not imply --wire-claude.
  const mcpEntry: ClaudeMcpEntry = buildMcpEntry(dbPath);
  if (options.wireClaude) {
    if (options.yes) {
      patchClaudeConfig(CLAUDE_CONFIG_PATH, mcpEntry);
      p.note(`Patched ${CLAUDE_CONFIG_PATH} (backup written).`, 'Claude Code MCP');
    } else {
      const confirmWire = await p.confirm({
        message: `Patch ${CLAUDE_CONFIG_PATH} with the MCP server entry?`,
        initialValue: false,
      });
      if (p.isCancel(confirmWire)) return cancelled();
      if (confirmWire) {
        patchClaudeConfig(CLAUDE_CONFIG_PATH, mcpEntry);
        p.note(`Patched ${CLAUDE_CONFIG_PATH} (backup written).`, 'Claude Code MCP');
      } else {
        p.note(JSON.stringify({ mcpServers: { 'second-brain': mcpEntry } }, null, 2), 'Snippet for ~/.claude.json');
      }
    }
  } else {
    p.note(
      JSON.stringify({ mcpServers: { 'second-brain': mcpEntry } }, null, 2),
      'Claude Code MCP snippet (paste into ~/.claude.json, or re-run with --wire-claude to apply)',
    );
  }

  p.outro(
    [
      `Brain at:   ${dbPath}`,
      `Config:     ${configPath}`,
      `Namespace:  ${namespace}`,
      '',
      'Next steps:',
      '  brain add decision "Use SQLite" --obs "Local-first"',
      '  brain index git',
      '  brain search "SQLite"',
    ].join('\n'),
  );
}

async function askNamespace(): Promise<string | symbol> {
  return p.text({
    message: 'Default namespace for this brain',
    placeholder: 'personal',
    defaultValue: 'personal',
  });
}

async function askLLMProvider(): Promise<(typeof LLM_PROVIDERS)[number] | 'skip' | symbol> {
  const choice = await p.select({
    message: 'LLM provider for extraction',
    initialValue: 'ollama' as const,
    options: [
      { value: 'ollama', label: 'Ollama (local, no API key)' },
      { value: 'anthropic', label: 'Anthropic (Claude)' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'groq', label: 'Groq' },
      { value: 'skip', label: 'Skip — no LLM (deterministic extractors only)' },
    ],
  });
  return choice;
}

async function askEmbeddingProvider(
  suggestion: (typeof EMBEDDING_PROVIDERS)[number],
): Promise<(typeof EMBEDDING_PROVIDERS)[number] | symbol> {
  const choice = await p.select({
    message: 'Embedding provider for vector search',
    initialValue: suggestion,
    options: EMBEDDING_PROVIDERS.map((provider) => ({
      value: provider,
      label: provider === 'ollama' ? 'Ollama (local, no API key)' : provider,
    })),
  });
  return choice;
}

function cancelled(): void {
  p.cancel('Init cancelled. Nothing was written.');
  process.exit(0);
}

function writeEnvKey(envPath: string, key: string, value: string): void {
  // Append-or-update a KEY=value line in a shell-style env file with 0600 perms.
  let existing = '';
  if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, 'utf-8');
  const lines = existing.split('\n').filter((l) => l && !l.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  // Also fix perms on an existing file that was created with default mode.
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // best-effort on platforms without chmod (Windows)
  }
}

export function buildMcpEntry(dbPath: string): ClaudeMcpEntry {
  return {
    command: 'npx',
    args: ['-y', '@second-brain/mcp-server'],
    env: { BRAIN_DB_PATH: dbPath },
  };
}

const ClaudeConfigShape = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Idempotently patch ~/.claude.json with an mcpServers entry for second-brain.
 * Backs up the original to <path>.bak-<timestamp> before writing.
 * If the file is missing or unparseable, writes a fresh {mcpServers: {...}} doc.
 */
export function patchClaudeConfig(configPath: string, entry: ClaudeMcpEntry): void {
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      const validated = ClaudeConfigShape.parse(parsed);
      current = validated;
    } catch {
      // Unparseable — preserve as backup and start fresh to avoid corrupting
      // an unfamiliar schema shape.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(`${configPath}.bak-${stamp}`, raw);
      current = {};
    }
    // Always back up an existing parseable file too.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(`${configPath}.bak-${stamp}`, raw);
  }
  const servers = (current.mcpServers as Record<string, unknown>) ?? {};
  servers['second-brain'] = entry;
  current.mcpServers = servers;
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`);
}
