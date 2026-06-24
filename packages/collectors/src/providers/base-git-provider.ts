/**
 * Shared base for forge providers that resolve a webhook author's email via a
 * network lookup with a TTL cache. GitHub and GitLab differ only in HOW they
 * fetch the email (Octokit vs raw fetch) — that single divergent step is the
 * abstract `fetchUserEmail`. Internal to providers/ — NOT re-exported.
 */
import { canonicalizeEmail, type Author } from '@second-brain/types';

interface CachedUser {
  email: string;
  at: number;
}

export abstract class BaseGitProvider {
  private readonly userCache = new Map<string, CachedUser>();
  protected readonly userCacheTtlMs: number;
  protected readonly now: () => number;

  constructor(opts: { userCacheTtlMs?: number; now?: () => number } = {}) {
    this.userCacheTtlMs = opts.userCacheTtlMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Fetch the canonical email for `username` from the forge (subclass-specific). */
  protected abstract fetchUserEmail(username: string): Promise<string>;

  /** Resolve an Author, caching the email lookup for `userCacheTtlMs`. */
  protected async resolveAuthor(username: string): Promise<Author> {
    const cached = this.userCache.get(username);
    const age = cached ? this.now() - cached.at : Infinity;
    let email: string;
    if (cached && age < this.userCacheTtlMs) {
      email = cached.email;
    } else {
      email = await this.fetchUserEmail(username);
      this.userCache.set(username, { email, at: this.now() });
    }
    return {
      canonicalEmail: canonicalizeEmail(email),
      displayName: username,
      aliases: [],
    };
  }
}
