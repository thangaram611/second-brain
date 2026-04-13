import type { Node } from 'web-tree-sitter';

/**
 * web-tree-sitter ≥ 0.25 returns `(Node | null)[]` from namedChildren/children.
 * In practice the iterable doesn't contain nulls for these accessors, but the
 * types force the guard. This helper keeps iteration ergonomic and type-safe.
 */
export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

export function children(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null);
}
