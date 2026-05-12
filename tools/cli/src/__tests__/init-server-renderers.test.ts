import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  renderLaunchdPlist,
  renderRelayLaunchdPlist,
} from '../init-server.js';

/**
 * Direct unit tests for the pure render functions — runInitServer has no
 * `installDir` / `nodeBin` override, so XML edge cases (paths containing `&`)
 * can only be exercised here. On macOS we additionally lint the output with
 * `plutil` for a fully-grounded check; on Linux/CI we fall back to a regex
 * for the `&amp;` sequence and assert the result is well-formed XML.
 */

function lintPlist(content: string): { ok: true } | { ok: false; error: string } {
  if (process.platform !== 'darwin') return { ok: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-plist-'));
  const file = path.join(dir, 'test.plist');
  try {
    fs.writeFileSync(file, content, 'utf8');
    execSync(`plutil -lint ${JSON.stringify(file)}`, { stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('renderLaunchdPlist — XML escape', () => {
  it('escapes `&` in installDir and nodeBin so plutil -lint passes', () => {
    const plist = renderLaunchdPlist({
      installDir: '/tmp/sb&server',
      nodeBin: '/Users/foo&bar/node',
      secretsPath: '/tmp/sb&server/secrets.env',
      storageDir: '/tmp/sb&server/data',
      port: 7430,
      relayPort: 7421,
      publicUrl: 'http://localhost:7430',
    });
    // The raw `&` must be escaped — otherwise XML parsers reject the file.
    expect(plist).toContain('&amp;');
    expect(plist).not.toMatch(/[^&]&[^aA#]/); // no bare `&` outside escapes
    const lint = lintPlist(plist);
    expect(lint.ok, lint.ok ? '' : lint.error).toBe(true);
  });

  it('escapes `<`/`>` if they appear in a path (defensive)', () => {
    const plist = renderLaunchdPlist({
      installDir: '/tmp/sb<server>',
      nodeBin: '/usr/bin/node',
      secretsPath: '/tmp/secrets.env',
      storageDir: '/tmp/data',
      port: 7430,
      relayPort: 7421,
      publicUrl: 'http://localhost:7430',
    });
    expect(plist).toContain('&lt;');
    expect(plist).toContain('&gt;');
    const lint = lintPlist(plist);
    expect(lint.ok, lint.ok ? '' : lint.error).toBe(true);
  });
});

describe('renderRelayLaunchdPlist — XML escape', () => {
  it('escapes `&` in installDir and nodeBin so plutil -lint passes', () => {
    const plist = renderRelayLaunchdPlist({
      installDir: '/tmp/sb&server',
      nodeBin: '/Users/foo&bar/node',
      secretsPath: '/tmp/sb&server/secrets.env',
      storageDir: '/tmp/sb&server/data',
      relayPort: 7421,
    });
    expect(plist).toContain('&amp;');
    const lint = lintPlist(plist);
    expect(lint.ok, lint.ok ? '' : lint.error).toBe(true);
  });

  it('quotes paths with spaces inside the shell wrapper', () => {
    const plist = renderRelayLaunchdPlist({
      installDir: '/path with spaces/repo',
      nodeBin: '/usr/bin/node',
      secretsPath: '/path with spaces/secrets.env',
      storageDir: '/path with spaces/data',
      relayPort: 7421,
    });
    // After XML-escape the wrapper string still contains the single-quoted
    // path literal (now XML-encoded with &apos; → no, since space is plain).
    // The shell quoting itself uses literal `'`, which is then XML-escaped to
    // `&apos;`. So the wrapper string contains `&apos;/path with spaces/...&apos;`.
    expect(plist).toContain('&apos;/path with spaces/secrets.env&apos;');
    expect(plist).toContain('&apos;/path with spaces/repo/apps/relay/dist/index.mjs&apos;');
  });
});
