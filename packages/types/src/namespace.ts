export const SESSION_NAMESPACE_PREFIX = 'session:';

export function sessionNamespace(sessionId: string): string {
  return `${SESSION_NAMESPACE_PREFIX}${sessionId}`;
}

export function isSessionNamespace(namespace: string): boolean {
  return namespace.startsWith(SESSION_NAMESPACE_PREFIX);
}

export function extractSessionId(namespace: string): string | null {
  if (!isSessionNamespace(namespace)) return null;
  return namespace.slice(SESSION_NAMESPACE_PREFIX.length);
}
