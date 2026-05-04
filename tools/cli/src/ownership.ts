export interface OwnershipScore {
  actor: string;
  score: number;
  signals: {
    commits: number;
    recencyWeightedBlameLines: number;
    reviews: number;
    testAuthorship: number;
    codeownerMatch: boolean;
  };
}

export async function runOwnership(options: {
  path: string;
  /**
   * Namespace to scope the ownership query to. Required by the server when
   * the caller's PAT is unbound; ownership-cmd resolves it from the team
   * manifest / credentials before calling here.
   */
  namespace: string;
  limit?: number;
  json?: boolean;
  serverUrl?: string;
  token?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { getServerUrl, buildAuthHeaders } = await import('./lib/config.js');
  const serverUrl = getServerUrl(options.serverUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  const url = new URL(`${serverUrl}/api/query/ownership`);
  url.searchParams.set('path', options.path);
  url.searchParams.set('namespace', options.namespace);
  if (options.limit !== undefined)
    url.searchParams.set('limit', String(options.limit));

  const headers: Record<string, string> = buildAuthHeaders(options.token);

  const res = await fetchImpl(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Error: ${res.status} — ${text}`);
    process.exit(1);
  }

  const scores: OwnershipScore[] = (await res.json()) as OwnershipScore[];

  if (options.json) {
    console.log(JSON.stringify(scores, null, 2));
    return;
  }

  if (scores.length === 0) {
    console.log(`No ownership data found for ${options.path}`);
    return;
  }

  console.log(`Ownership for ${options.path}:\n`);
  for (const s of scores) {
    const pct = (s.score * 100).toFixed(1);
    console.log(`  ${s.actor}  (${pct}%)`);
    console.log(
      `    commits: ${s.signals.commits}  blame: ${s.signals.recencyWeightedBlameLines.toFixed(1)}  reviews: ${s.signals.reviews}  tests: ${s.signals.testAuthorship}  codeowner: ${s.signals.codeownerMatch ? 'yes' : 'no'}`,
    );
  }
}
