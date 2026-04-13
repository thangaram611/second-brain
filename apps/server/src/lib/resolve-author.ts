import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalizeEmail, type Author, AuthorSchema } from '@second-brain/types';

const exec = promisify(execFile);

/**
 * Resolve the git author identity for a working directory. Returns null
 * if `git config` is unset or the directory isn't a git repo. Never
 * throws — the caller is allowed to skip author stamping rather than
 * fail the request.
 */
export async function resolveAuthor(cwd: string): Promise<Author | null> {
  try {
    const [{ stdout: emailRaw }, { stdout: nameRaw }] = await Promise.all([
      exec('git', ['config', '--get', 'user.email'], { cwd, timeout: 2000 }),
      exec('git', ['config', '--get', 'user.name'], { cwd, timeout: 2000 }).catch(() => ({ stdout: '' })),
    ]);
    const email = emailRaw.trim();
    if (!email) return null;
    const canonical = canonicalizeEmail(email);
    const parsed = AuthorSchema.safeParse({
      canonicalEmail: canonical,
      displayName: nameRaw.trim() || undefined,
      aliases: email === canonical ? [] : [email],
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
