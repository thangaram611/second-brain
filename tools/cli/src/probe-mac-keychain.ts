/**
 * Non-interactive macOS keychain probe.
 *
 * Goal: detect whether `~/Library/Keychains/login.keychain-db` exists and
 * is the user's default, WITHOUT calling any API that could pop the
 * Security-framework "Keychain Not Found / Reset to Defaults" dialog.
 *
 * The `security list-keychains -d user` subcommand is documented to be
 * read-only and never triggers UI — it exits non-zero or with an empty
 * list when there is no usable default keychain. We invoke it by absolute
 * path so a stripped PATH (e.g. inside launchd) can't bypass it.
 *
 * SSH context: when `SSH_TTY` or `SSH_CONNECTION` is set the user is on a
 * remote shell where the login keychain is never unlocked, so we skip the
 * probe and report "not available". Same outcome as the probe failing,
 * but cheaper and avoids spurious dialog risk on remote macs.
 *
 * Result is memoized for the process lifetime — re-running the probe per
 * call is wasteful and could increase the chance of races.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const SECURITY_BIN = '/usr/bin/security';
const PROBE_TIMEOUT_MS = 2000;

let cached: boolean | null = null;

export function resetMacKeychainProbeCache(): void {
  cached = null;
}

/**
 * Test-only override — preset the cached probe result so callers that
 * pass no `injectedResult` (e.g. the dispatcher in `keychain.ts`) see a
 * deterministic value.
 */
export function setMacKeychainProbeForTest(result: boolean | null): void {
  cached = result;
}

export interface ProbeMacKeychainOptions {
  /** Test override — when set, bypasses the real `security` invocation. */
  injectedResult?: boolean;
  /** Test override — read instead of `process.env.SSH_TTY`. */
  sshTty?: string | undefined;
  /** Test override — read instead of `process.env.SSH_CONNECTION`. */
  sshConnection?: string | undefined;
}

export async function probeMacKeychain(
  opts: ProbeMacKeychainOptions = {},
): Promise<boolean> {
  if (cached !== null) return cached;
  if (opts.injectedResult !== undefined) {
    cached = opts.injectedResult;
    return cached;
  }
  const sshTty = opts.sshTty ?? process.env.SSH_TTY;
  const sshConn = opts.sshConnection ?? process.env.SSH_CONNECTION;
  if ((sshTty && sshTty.length > 0) || (sshConn && sshConn.length > 0)) {
    cached = false;
    return cached;
  }
  try {
    const { stdout } = await execFileP(
      SECURITY_BIN,
      ['list-keychains', '-d', 'user'],
      { timeout: PROBE_TIMEOUT_MS },
    );
    cached = stdout.includes('login.keychain-db');
    return cached;
  } catch {
    cached = false;
    return cached;
  }
}
