import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CustomProvider,
  CustomProviderMappingSchema,
  type CustomProviderMapping,
} from '@second-brain/collectors';

/**
 * Server-side loader for custom git-provider mappings. Lives here (and not in
 * `@second-brain/cli`) so the server doesn't depend on the CLI package.
 *
 * Mapping files live at `~/.second-brain/providers/<name>.json` and are
 * validated against `CustomProviderMappingSchema`. Malformed files are skipped
 * (a custom provider that fails to parse simply isn't registered), matching the
 * lenient behavior of `loadWiredReposForServer`.
 */

const PROVIDERS_DIR = path.join(os.homedir(), '.second-brain', 'providers');

function loadCustomProviderMappings(
  providersDir = PROVIDERS_DIR,
): CustomProviderMapping[] {
  let files: string[];
  try {
    files = fs.readdirSync(providersDir);
  } catch {
    // Directory doesn't exist → no custom providers configured.
    return [];
  }

  const out: CustomProviderMapping[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(providersDir, file), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const result = CustomProviderMappingSchema.safeParse(parsed);
      if (result.success) out.push(result.data);
    } catch {
      // Skip unreadable / malformed mapping files.
    }
  }
  return out;
}

/**
 * Build the single `CustomProvider` the observe-route registry serves under the
 * `'custom'` provider key. The mr-event envelope's `provider` field is an enum
 * (`gitlab | github | custom`), so the registry holds at most one custom
 * provider; if multiple mapping files exist, the first valid one wins.
 *
 * Returns `null` when no valid mapping is present so the caller can leave the
 * `'custom'` key unregistered (a `provider:custom` webhook then 400s, exactly
 * as before this wiring existed).
 */
export function loadCustomProvider(providersDir = PROVIDERS_DIR): CustomProvider | null {
  const [mapping] = loadCustomProviderMappings(providersDir);
  if (!mapping) return null;
  return new CustomProvider(mapping);
}
