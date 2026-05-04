/**
 * `brain auth rotate` (PR6 §6.1).
 *
 * Wraps `POST /api/auth/rotate` (mints a new PAT, atomically revokes the
 * old one server-side) and updates the local credentials slot + keychain so
 * subsequent CLI/hook calls pick up the new token transparently.
 *
 *   brain auth rotate                     # rotate whatever the resolver chose
 *   brain auth rotate --slot hook         # force-rotate the hook slot
 *   brain auth rotate --slot cli          # force-rotate the cli slot
 *   brain auth rotate --slot default      # force-rotate the default slot
 *
 * Behavior:
 *   - Resolves the current bearer token via `resolve-token.ts`. Honors the
 *     hook > default > cli priority order; the resolved slot becomes the
 *     update target unless `--slot` overrides it.
 *   - Emits a one-line message naming the slot that fired so a user running
 *     `rotate` inside a hook session knows which token rotated.
 *   - For env-token rotation (`source === 'env'`): the mint succeeds but the
 *     CLI cannot update the env. Prints the new PAT + instructions and exits
 *     with status code **2** (special, so wrapper scripts notice the user
 *     must take action).
 *   - For keychain rotations the order is: write the NEW
 *     `pat:<host>:<newId>` keychain entry → patch ONLY the resolved slot's
 *     pointer in `~/.second-brain/credentials/<host>.json` → best-effort
 *     delete of the OLD `pat:<host>:<oldId>` entry. Doing the new-write
 *     first means a partial failure mid-rotation leaves both old and new
 *     PATs locally available (the server-side revoke of the old PAT still
 *     happened, but the user can recover with a manual edit). The other
 *     slot pointers are preserved verbatim, and the old keychain entry is
 *     ONLY deleted when no other slot still references that tokenId.
 */

import { z } from 'zod';
import { getServerUrl } from './lib/config.js';
import {
  resolveToken,
  resetTokenCache,
  patAccount,
  type CredentialsSlot,
} from './lib/resolve-token.js';
import {
  patchCredentials,
  readCredentials,
  type CredentialsRecord,
} from './credentials.js';
import { storeSecret, deleteSecret } from './keychain.js';

export const AUTH_ROTATE_ENV_FALLBACK_EXIT_CODE = 2;

const RotateResponseSchema = z.object({
  pat: z.string().min(8),
  tokenId: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export type RotateResponse = z.infer<typeof RotateResponseSchema>;

const SLOT_VALUES = ['hook', 'default', 'cli'] as const satisfies readonly CredentialsSlot[];
const SLOT_FIELDS: Record<CredentialsSlot, keyof CredentialsRecord> = {
  hook: 'hookTokenId',
  default: 'defaultTokenId',
  cli: 'cliTokenId',
};

export interface AuthRotateOptions {
  /** Override which slot to rotate. Default: whichever slot the resolver chose. */
  slot?: CredentialsSlot;
  /** Override server URL (tests / one-off overrides). */
  serverUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override HOME (tests). */
  homeDir?: string;
  /** Override host (tests). Falls back to URL parsed from server-url envs. */
  host?: string;
  /** Stream destination (tests). */
  stdout?: { write(s: string): void };
  /** Stream destination for warning messages (tests). */
  stderr?: { write(s: string): void };
}

export type AuthRotateOutcome =
  | {
      kind: 'keychain';
      host: string;
      slot: CredentialsSlot;
      oldTokenId: string;
      newTokenId: string;
      pat: string;
      expiresAt: string;
    }
  | {
      kind: 'env';
      newTokenId: string;
      pat: string;
      expiresAt: string;
      exitCode: typeof AUTH_ROTATE_ENV_FALLBACK_EXIT_CODE;
    };

function hostFromUrl(url: string, fallback: string): string {
  try {
    return new URL(url).host;
  } catch {
    return fallback;
  }
}

export function isCredentialsSlot(value: unknown): value is CredentialsSlot {
  return typeof value === 'string' && (SLOT_VALUES as readonly string[]).includes(value);
}

async function fetchWithError(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetchImpl(url, init);
  if (res.ok) return res;
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  // Tailor the error message for the most common failure modes so users
  // get actionable hints rather than a raw HTTP dump.
  const method = init.method ?? 'GET';
  if (res.status === 401) {
    throw new Error(
      `${method} ${url} → 401 unauthorized (current PAT is invalid or already revoked). ` +
        `Re-redeem an invite via \`brain init client --refresh\` and try again.${detail ? ` Server said: ${detail}` : ''}`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `${method} ${url} → 404 token-not-found (the resolved token id is not on this server). ` +
        `Run \`brain doctor\` to diagnose.${detail ? ` Server said: ${detail}` : ''}`,
    );
  }
  throw new Error(
    `${method} ${url} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
  );
}

/**
 * Drive a PAT rotation end-to-end. Pure function modulo network + filesystem
 * + keychain side effects; the CLI command wrapper handles process exit.
 */
export async function runAuthRotate(opts: AuthRotateOptions = {}): Promise<AuthRotateOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  // Always reset the cache so the resolver re-reads credentials + keychain
  // for this invocation. Hook sessions memoize the previous token; rotate
  // would otherwise read a stale value if invoked back-to-back.
  resetTokenCache();
  const resolved = await resolveToken({
    homeDir: opts.homeDir,
    host: opts.host,
    noCache: true,
  });
  if (!resolved) {
    throw new Error(
      'no current token to rotate — set BRAIN_AUTH_TOKEN or run `brain init client` first.',
    );
  }

  const serverUrl = getServerUrl(opts.serverUrl);
  const host = opts.host ?? hostFromUrl(serverUrl, 'localhost');

  // POST /api/auth/rotate with no body — server picks up the bearer token
  // and rotates that one.
  const res = await fetchWithError(fetchImpl, `${serverUrl}/api/auth/rotate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const json: unknown = await res.json();
  const parsed = RotateResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `server response did not match expected shape: ${z.prettifyError(parsed.error)}`,
    );
  }
  const minted: RotateResponse = parsed.data;

  // Env-source rotation: we cannot mutate the user's environment. Surface the
  // new PAT + a clear instruction; exit code 2 so wrappers can detect this.
  if (resolved.source === 'env') {
    stdout.write(
      [
        '✓ rotated env-bound PAT',
        '',
        `  new token id:   ${minted.tokenId}`,
        `  new PAT:        ${minted.pat}`,
        `  expires:        ${minted.expiresAt}`,
        '',
        '  IMPORTANT: BRAIN_AUTH_TOKEN was the source — the CLI cannot update',
        '  your shell environment. Update the variable yourself and re-export:',
        '',
        `    export BRAIN_AUTH_TOKEN=${minted.pat}`,
        '',
        '  The previous token has already been revoked server-side — until you',
        '  update the env var, subsequent calls will return 401.',
        '',
      ].join('\n'),
    );
    return {
      kind: 'env',
      newTokenId: minted.tokenId,
      pat: minted.pat,
      expiresAt: minted.expiresAt,
      exitCode: AUTH_ROTATE_ENV_FALLBACK_EXIT_CODE,
    };
  }

  // Keychain rotation. The resolver always sets `slot` when source ===
  // 'keychain' (see resolve-token.ts), but TypeScript can't see that
  // narrowing across the discriminated union — guard explicitly so the
  // failure mode is a clear error rather than a silent undefined-write.
  if (resolved.source !== 'keychain' || !resolved.slot || !resolved.tokenId) {
    throw new Error(
      `internal: keychain-source token resolved without a slot/tokenId pointer (source=${resolved.source})`,
    );
  }

  // Override-slot semantics: the user can ask to rotate a slot OTHER than
  // the one the resolver chose. We still mint via the resolver's bearer
  // token (only that token is currently authenticated), but we update the
  // OVERRIDE slot's pointer locally — useful when the resolver picks `hook`
  // but the user wants the `cli` pointer refreshed.
  const targetSlot: CredentialsSlot = opts.slot ?? resolved.slot;
  if (targetSlot !== resolved.slot) {
    stderr.write(
      `note: --slot=${targetSlot} overrides resolver slot=${resolved.slot}; updating ${targetSlot}TokenId pointer.\n`,
    );
  } else {
    stderr.write(
      `note: rotating slot '${resolved.slot}' (the resolver fired this slot — re-run with --slot=<other> to update a different pointer).\n`,
    );
  }

  // Confirm the credentials record exists before we touch the keychain;
  // otherwise we'd write a NEW keychain entry for a host with no pointer
  // file, which `brain doctor` would flag as orphaned.
  const existing = readCredentials(host, opts.homeDir);
  if (!existing) {
    throw new Error(
      `no credentials file for host ${host} — cannot update slot pointers. Run \`brain init client\` first.`,
    );
  }

  // Determine which OLD tokenId to revoke from the keychain. When --slot
  // overrides, we delete the override slot's previous pointer (if it
  // exists), not the resolver's. The resolver's keychain entry stays put
  // unless it was the same id — `revokeToken` server-side already handles
  // the no-longer-valid case.
  const slotField = SLOT_FIELDS[targetSlot];
  const slotValue = existing[slotField];
  const oldSlotTokenId = typeof slotValue === 'string' && slotValue.length > 0 ? slotValue : null;

  // Write the new keychain entry FIRST. If anything below fails, the user
  // can recover by manually re-pointing the credentials file at the new
  // tokenId (printed on error) — losing only the local bookkeeping, not
  // the secret itself.
  const newAccount = patAccount(host, minted.tokenId);
  const stored = await storeSecret(newAccount, minted.pat);
  if (!stored.ok) {
    throw new Error(
      `keychain unavailable while storing new token: ${stored.message}. ` +
        `Server-side rotation already happened; the new PAT is: ${minted.pat} ` +
        `(token id ${minted.tokenId}, expires ${minted.expiresAt}).`,
    );
  }

  // Patch the credentials file. patchCredentials() reads the existing
  // record, applies the slot-pointer update, and atomically rewrites — so
  // the other two slot pointers are guaranteed to be preserved.
  const patch: Partial<CredentialsRecord> = {
    [slotField]: minted.tokenId,
    patExpiresAt: minted.expiresAt,
  };
  try {
    patchCredentials(host, patch, opts.homeDir);
  } catch (patchErr) {
    // Server-side rotation already succeeded AND the new PAT is in the
    // keychain. Surface enough info for the user to recover manually —
    // mirrors the keychain-failure message above so the operator UX is
    // consistent: print the new tokenId + the credentials path + the exact
    // recovery commands, then re-throw so the CLI exits non-zero.
    const detail = patchErr instanceof Error ? patchErr.message : String(patchErr);
    stdout.write(
      [
        '',
        `Server rotated successfully and the new PAT is stored in the keychain at`,
        `  pat:${host}:${minted.tokenId}`,
        `but failed to update the credentials file: ${detail}`,
        '',
        'Recovery: either re-run',
        `  brain init client --refresh --invite <new-invite>`,
        `or manually edit ~/.second-brain/credentials/${host}.json so that`,
        `  ${slotField}: "${minted.tokenId}"`,
        `(the previous tokenId for this slot was ${oldSlotTokenId ?? '(none)'} — already revoked server-side).`,
        '',
      ].join('\n'),
    );
    throw patchErr;
  }

  // Best-effort delete of the old keychain entry. If the user had multiple
  // slot pointers sharing one tokenId, only delete after we've confirmed no
  // other slot still references it.
  if (oldSlotTokenId && oldSlotTokenId !== minted.tokenId) {
    const stillReferenced = SLOT_VALUES.some((s) => {
      if (s === targetSlot) return false;
      const other = existing[SLOT_FIELDS[s]];
      return typeof other === 'string' && other === oldSlotTokenId;
    });
    if (!stillReferenced) {
      await deleteSecret(patAccount(host, oldSlotTokenId));
    }
  }

  // Reset cache so the next resolveToken() call sees the new pointer.
  resetTokenCache();

  stdout.write(
    [
      `✓ rotated PAT for slot '${targetSlot}' on ${host}`,
      '',
      `  old token id:   ${oldSlotTokenId ?? '(none)'}`,
      `  new token id:   ${minted.tokenId}`,
      `  expires:        ${minted.expiresAt}`,
      '',
      '  The old token has been revoked server-side and removed from the',
      '  keychain. Subsequent CLI / hook calls pick up the new PAT.',
      '',
    ].join('\n'),
  );

  return {
    kind: 'keychain',
    host,
    slot: targetSlot,
    oldTokenId: oldSlotTokenId ?? '',
    newTokenId: minted.tokenId,
    pat: minted.pat,
    expiresAt: minted.expiresAt,
  };
}
