/**
 * Server-URL + host helpers — a dependency leaf (no imports) so both
 * `lib/config.ts` and `lib/resolve-token.ts` can share them without forming a
 * runtime import cycle (config dynamically imports resolve-token).
 */

/**
 * Resolve the server URL from an explicit override or the env chain, falling
 * back to the localhost default.
 */
export function getServerUrl(override?: string): string {
  return (
    override ??
    process.env.BRAIN_API_URL ??
    process.env.BRAIN_SERVER_URL ??
    process.env.SECOND_BRAIN_SERVER_URL ??
    'http://localhost:7430'
  );
}

/** Parse the host out of a URL, returning `fallback` when the URL is invalid. */
export function hostFromUrl(url: string, fallback: string): string {
  try {
    return new URL(url).host;
  } catch {
    return fallback;
  }
}
