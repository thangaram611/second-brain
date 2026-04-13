import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as p from '@clack/prompts';

const DEFAULT_DIR = path.join(os.homedir(), '.second-brain');
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

export interface ResetOptions {
  /** Skip interactive confirmation. */
  yes?: boolean;
  /** Also restore ~/.claude.json from its most recent backup. */
  wireClaude?: boolean;
  /** Override brain directory (defaults to ~/.second-brain). */
  dir?: string;
}

export async function runReset(options: ResetOptions): Promise<void> {
  p.intro('🧹 second-brain reset');

  const dir = options.dir ?? DEFAULT_DIR;
  const brainExists = fs.existsSync(dir);
  const claudeHasBackup = options.wireClaude && findLatestClaudeBackup(CLAUDE_CONFIG_PATH) !== null;

  if (!brainExists && !claudeHasBackup) {
    p.outro(`Nothing to reset. No directory at ${dir}.`);
    return;
  }

  const actions: string[] = [];
  if (brainExists) actions.push(`remove directory ${dir}`);
  if (options.wireClaude) {
    actions.push(
      claudeHasBackup
        ? `restore ${CLAUDE_CONFIG_PATH} from its most recent backup`
        : `clear the second-brain entry from ${CLAUDE_CONFIG_PATH} (no backup to restore)`,
    );
  }

  if (!options.yes) {
    const proceed = await p.confirm({
      message: `This will ${actions.join(' and ')}. Continue?`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.outro('Nothing changed.');
      return;
    }
  }

  if (brainExists) {
    fs.rmSync(dir, { recursive: true, force: true });
    p.note(`Removed ${dir}`, 'Brain directory');
  }

  if (options.wireClaude) {
    const restored = restoreOrClearClaudeConfig(CLAUDE_CONFIG_PATH);
    p.note(restored.message, 'Claude config');
  }

  p.outro('Reset complete.');
}

export function findLatestClaudeBackup(configPath: string): string | null {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-`))
    .map((f) => path.join(dir, f));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aStat = fs.statSync(a).mtimeMs;
    const bStat = fs.statSync(b).mtimeMs;
    return bStat - aStat;
  });
  return candidates[0];
}

export interface RestoreResult {
  action: 'restored' | 'cleared' | 'missing';
  message: string;
}

/**
 * Prefer restoring the most recent backup. If no backup exists, strip the
 * `second-brain` entry from the live file so `init --wire-claude` is cleanly
 * undone even without a backup.
 */
export function restoreOrClearClaudeConfig(configPath: string): RestoreResult {
  const backup = findLatestClaudeBackup(configPath);
  if (backup) {
    const contents = fs.readFileSync(backup, 'utf-8');
    fs.writeFileSync(configPath, contents);
    return { action: 'restored', message: `Restored ${configPath} from ${path.basename(backup)}.` };
  }

  if (!fs.existsSync(configPath)) {
    return { action: 'missing', message: `No backup found and ${configPath} does not exist. Nothing to do.` };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    } else {
      return { action: 'missing', message: `${configPath} is not a JSON object; leaving untouched.` };
    }
  } catch {
    return { action: 'missing', message: `${configPath} is not valid JSON; leaving untouched.` };
  }

  const servers = doc.mcpServers;
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const asRecord = servers as Record<string, unknown>;
    if ('second-brain' in asRecord) {
      delete asRecord['second-brain'];
      doc.mcpServers = asRecord;
      fs.writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`);
      return { action: 'cleared', message: `Removed second-brain entry from ${configPath} (no backup available).` };
    }
  }
  return { action: 'missing', message: `No second-brain entry found in ${configPath}; nothing to remove.` };
}
