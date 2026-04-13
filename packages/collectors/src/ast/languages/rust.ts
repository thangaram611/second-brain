import type { Tree, Node } from 'web-tree-sitter';
import { namedChildren, children } from './util.js';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { PendingRelation } from '@second-brain/ingestion';
import type { SymbolExtractionResult } from './typescript.js';

type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'const';

interface ExtractedRustSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  receiver?: string;
}

// Rust export rule: any sibling `visibility_modifier` child whose text starts with `pub`
// (covers `pub`, `pub(crate)`, `pub(super)`, `pub(in ...)`).
function hasPubVisibility(node: Node): boolean {
  for (const child of children(node)) {
    if (child.type === 'visibility_modifier' && child.text.startsWith('pub')) return true;
  }
  return false;
}

/** Extract symbols and relations from a Rust parse tree. */
export function extractRust(
  tree: Tree,
  filePath: string,
  namespace: string,
  source: EntitySource,
): SymbolExtractionResult {
  const symbols: CreateEntityInput[] = [];
  const relations: PendingRelation[] = [];
  const extracted: ExtractedRustSymbol[] = [];

  for (const child of namedChildren(tree.rootNode)) {
    walkTopLevel(child, extracted);
  }

  for (const sym of extracted) {
    const properties: Record<string, unknown> = {
      kind: sym.kind,
      filePath,
      line: sym.line,
      exported: sym.exported,
    };
    if (sym.receiver) properties.receiver = sym.receiver;

    symbols.push({
      type: 'symbol',
      name: sym.name,
      namespace,
      observations: [],
      properties,
      source,
      tags: [sym.kind, ...(sym.exported ? ['exported'] : [])],
    });

    relations.push({
      type: 'contains',
      sourceName: filePath,
      sourceType: 'file',
      targetName: sym.name,
      targetType: 'symbol',
      source,
      namespace,
    });
  }

  extractRustImports(tree.rootNode, filePath, namespace, source, relations);

  return { symbols, relations };
}

function walkTopLevel(node: Node, results: ExtractedRustSymbol[]): void {
  switch (node.type) {
    case 'function_item': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'function',
          line: node.startPosition.row + 1,
          exported: hasPubVisibility(node),
        });
      }
      break;
    }

    case 'struct_item': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'class',
          line: node.startPosition.row + 1,
          exported: hasPubVisibility(node),
        });
      }
      break;
    }

    case 'enum_item': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'enum',
          line: node.startPosition.row + 1,
          exported: hasPubVisibility(node),
        });
      }
      break;
    }

    case 'trait_item': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'interface',
          line: node.startPosition.row + 1,
          exported: hasPubVisibility(node),
        });
      }
      break;
    }

    case 'type_item': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'type',
          line: node.startPosition.row + 1,
          exported: hasPubVisibility(node),
        });
      }
      break;
    }

    case 'const_item':
    case 'static_item': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: node.type === 'const_item' ? 'const' : 'variable',
          line: node.startPosition.row + 1,
          exported: hasPubVisibility(node),
        });
      }
      break;
    }

    case 'impl_item': {
      // Emit methods declared in the impl block, tagged with the implementing type.
      const typeNode = node.childForFieldName('type');
      const receiver = typeNode?.text ?? undefined;
      const body = node.childForFieldName('body');
      if (body) {
        for (const bodyChild of namedChildren(body)) {
          if (bodyChild.type === 'function_item') {
            const nameNode = bodyChild.childForFieldName('name');
            if (nameNode) {
              results.push({
                name: nameNode.text,
                kind: 'function',
                line: bodyChild.startPosition.row + 1,
                exported: hasPubVisibility(bodyChild),
                receiver,
              });
            }
          }
        }
      }
      break;
    }
  }
}

function extractRustImports(
  rootNode: Node,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  for (const child of namedChildren(rootNode)) {
    if (child.type === 'use_declaration') {
      const arg = child.childForFieldName('argument');
      if (arg) {
        const pathText = extractRustUsePath(arg);
        if (pathText) {
          relations.push({
            type: 'depends_on',
            sourceName: filePath,
            sourceType: 'file',
            targetName: pathText,
            targetType: 'file',
            source,
            namespace,
          });
        }
      }
    }
  }
}

/**
 * Extract the root path of a `use` declaration. For `use foo::bar::{Baz, Qux}`,
 * returns `foo::bar`; for `use foo::Bar`, returns `foo::Bar`.
 */
function extractRustUsePath(node: Node): string {
  if (node.type === 'scoped_identifier' || node.type === 'identifier') return node.text;
  if (node.type === 'scoped_use_list') {
    const pathNode = node.childForFieldName('path');
    return pathNode?.text ?? node.text;
  }
  if (node.type === 'use_as_clause') {
    const pathNode = node.childForFieldName('path');
    return pathNode?.text ?? node.text;
  }
  if (node.type === 'use_wildcard') {
    // `use foo::bar::*` — strip the trailing `::*`
    return node.text.replace(/::\*$/, '');
  }
  return node.text;
}
