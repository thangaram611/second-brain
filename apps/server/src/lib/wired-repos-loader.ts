import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

/**
 * Server-side loader for `~/.second-brain/config.json`. Lives here (and
 * not in `@second-brain/cli`) so the server doesn't depend on the CLI
 * package. Schema is a structural dup of
 * `tools/cli/src/git-context-daemon.ts:WiredReposEntrySchema`. If they
 * diverge, the safeParse silently drops malformed entries — acceptable
 * since unwired repos just don't receive mr-events.
 */

const WiredReposEntrySchema = z.object({
  repoHash: z.string(),
  absPath: z.string(),
  namespace: z.string(),
  providerId: z.enum(['gitlab', 'github', 'custom']).optional(),
  projectId: z.string().optional(),
  relayUrl: z.string().optional(),
  gitlabBaseUrl: z.string().optional(),
  gitlabProjectId: z.string().optional(),
  webhookId: z.number().int().optional(),
  installedAt: z.string(),
});

const WiredReposSchema = z.object({
  version: z.literal(1),
  wiredRepos: z.record(z.string(), WiredReposEntrySchema),
});

export type WiredReposEntryServer = z.infer<typeof WiredReposEntrySchema>;
export type WiredReposServer = z.infer<typeof WiredReposSchema>;

const CONFIG_PATH = path.join(os.homedir(), '.second-brain', 'config.json');

export function loadWiredReposForServer(configPath = CONFIG_PATH): WiredReposServer {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = WiredReposSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // fall through
  }
  return { version: 1, wiredRepos: {} };
}

/**
 * Extract the `(providerKey → namespace)` map the ObservationService
 * uses for mr-event namespace derivation. Skips entries that aren't
 * provider-wired.
 */
export function buildProviderNamespaceEntries(
  config: WiredReposServer,
): Array<{ provider: 'gitlab' | 'github' | 'custom'; projectId: string; namespace: string }> {
  const out: Array<{ provider: 'gitlab' | 'github' | 'custom'; projectId: string; namespace: string }> = [];
  for (const entry of Object.values(config.wiredRepos)) {
    if (entry.providerId && entry.gitlabProjectId) {
      out.push({
        provider: entry.providerId,
        projectId: entry.gitlabProjectId,
        namespace: entry.namespace,
      });
    }
  }
  return out;
}
