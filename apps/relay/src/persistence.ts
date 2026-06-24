import * as Y from 'yjs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Persist dirs already ensured this process, so mkdir stays off the steady-state save path. */
const ensuredDirs = new Set<string>();

/** True for a Node errno error whose code matches the given value (no `as` cast). */
function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

/**
 * Load persisted Y.Doc state from disk into the given doc.
 * If no state file exists for the namespace, this is a no-op.
 */
export async function loadDocState(
  persistDir: string,
  namespace: string,
  doc: Y.Doc,
): Promise<void> {
  const filePath = path.join(persistDir, `${namespace}.ystate`);

  // No existsSync pre-check: that is a TOCTOU race. Read directly and treat a
  // missing file (ENOENT) as the no-op case.
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return;
    }
    throw err;
  }

  Y.applyUpdate(doc, new Uint8Array(buffer));
}

/** Ensure the persist directory exists, caching the result per process. */
async function ensureDir(persistDir: string): Promise<void> {
  if (ensuredDirs.has(persistDir)) {
    return;
  }
  await fs.mkdir(persistDir, { recursive: true });
  ensuredDirs.add(persistDir);
}

/**
 * Persist the current Y.Doc state to disk, retrying transient write failures.
 * The persist directory is created once per process (and re-created if it
 * disappears at runtime).
 */
export async function saveDocState(
  persistDir: string,
  namespace: string,
  doc: Y.Doc,
): Promise<void> {
  const filePath = path.join(persistDir, `${namespace}.ystate`);
  const update = Y.encodeStateAsUpdate(doc);
  const payload = Buffer.from(update);

  await ensureDir(persistDir);

  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.writeFile(filePath, payload);
      return;
    } catch (err) {
      lastError = err;
      // The directory vanished at runtime — re-create it and try again.
      if (isErrnoCode(err, 'ENOENT')) {
        ensuredDirs.delete(persistDir);
        await ensureDir(persistDir);
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  throw lastError;
}
