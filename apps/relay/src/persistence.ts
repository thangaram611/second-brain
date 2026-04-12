import * as Y from 'yjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Load persisted Y.Doc state from disk into the given doc.
 * If no state file exists for the namespace, this is a no-op.
 */
export function loadDocState(
  persistDir: string,
  namespace: string,
  doc: Y.Doc,
): void {
  const filePath = path.join(persistDir, `${namespace}.ystate`);

  if (!fs.existsSync(filePath)) {
    return;
  }

  const buffer = fs.readFileSync(filePath);
  Y.applyUpdate(doc, new Uint8Array(buffer));
}

/**
 * Persist the current Y.Doc state to disk.
 * Creates the persist directory if it does not exist.
 */
export function saveDocState(
  persistDir: string,
  namespace: string,
  doc: Y.Doc,
): void {
  fs.mkdirSync(persistDir, { recursive: true });

  const filePath = path.join(persistDir, `${namespace}.ystate`);
  const update = Y.encodeStateAsUpdate(doc);
  fs.writeFileSync(filePath, Buffer.from(update));
}
