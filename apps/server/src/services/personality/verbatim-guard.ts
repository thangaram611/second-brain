/**
 * Checks if output text contains verbatim reproduction of source material.
 * Tokenizes on whitespace (lowercased, punctuation stripped), builds a Set of
 * all `minNgram`-length word windows across sources, scans output for matches.
 *
 * @param output - The generated text to check
 * @param sources - Array of source texts
 * @param minNgram - Minimum n-gram window size (default 8 words)
 * @returns true if verbatim reproduction detected
 */
export function containsVerbatim(
  output: string,
  sources: string[],
  minNgram = 8,
): boolean {
  if (!output || sources.length === 0) return false;

  const tokenize = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 0);

  const sourceNgrams = new Set<string>();

  for (const source of sources) {
    const tokens = tokenize(source);
    if (tokens.length < minNgram) continue;
    for (let i = 0; i <= tokens.length - minNgram; i++) {
      sourceNgrams.add(tokens.slice(i, i + minNgram).join(' '));
    }
  }

  if (sourceNgrams.size === 0) return false;

  const outputTokens = tokenize(output);
  for (let i = 0; i <= outputTokens.length - minNgram; i++) {
    const window = outputTokens.slice(i, i + minNgram).join(' ');
    if (sourceNgrams.has(window)) return true;
  }

  return false;
}
