/**
 * Sanitize a raw query string into an FTS5 MATCH expression.
 *
 * Strips FTS5 metacharacters, splits on whitespace, wraps each surviving
 * token in double-quotes with a trailing `*` for prefix matching, and
 * joins the tokens with implicit AND.
 *
 * Returns an empty string when no usable tokens remain.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => {
      const sanitized = term.replace(/['"()*^~{}[\]:]/g, '');
      if (!sanitized) return null;
      return `"${sanitized}"*`;
    })
    .filter(Boolean)
    .join(' ');
}
