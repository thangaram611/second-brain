import type { Tree, Node } from 'web-tree-sitter';
import { namedChildren } from './util.js';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { PendingRelation } from '@second-brain/ingestion';

export interface SymbolExtractionResult {
  symbols: CreateEntityInput[];
  relations: PendingRelation[];
}

type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';

interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
}

/**
 * Extract symbols and relations from a TypeScript/JavaScript parse tree.
 */
export function extractTypeScript(
  tree: Tree,
  filePath: string,
  namespace: string,
  source: EntitySource,
): SymbolExtractionResult {
  const symbols: CreateEntityInput[] = [];
  const relations: PendingRelation[] = [];
  const extracted: ExtractedSymbol[] = [];

  walkNode(tree.rootNode, extracted);

  for (const sym of extracted) {
    symbols.push({
      type: 'symbol',
      name: sym.name,
      namespace,
      observations: [],
      properties: {
        kind: sym.kind,
        filePath,
        line: sym.line,
        exported: sym.exported,
      },
      source,
      tags: [sym.kind, ...(sym.exported ? ['exported'] : [])],
    });

    // contains: file -> symbol
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

  // Extract import dependencies
  extractImports(tree.rootNode, filePath, namespace, source, relations);

  return { symbols, relations };
}

function walkNode(node: Node, results: ExtractedSymbol[]): void {
  // Check if the parent is an export statement
  const isExported = node.parent?.type === 'export_statement';

  switch (node.type) {
    case 'function_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'function',
          line: node.startPosition.row + 1,
          exported: isExported,
        });
      }
      break;
    }

    case 'class_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'class',
          line: node.startPosition.row + 1,
          exported: isExported,
        });
      }
      break;
    }

    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'interface',
          line: node.startPosition.row + 1,
          exported: isExported,
        });
      }
      break;
    }

    case 'type_alias_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'type',
          line: node.startPosition.row + 1,
          exported: isExported,
        });
      }
      break;
    }

    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'enum',
          line: node.startPosition.row + 1,
          exported: isExported,
        });
      }
      break;
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      // Check for exported const/let/var with arrow functions or plain variables
      for (const child of namedChildren(node)) {
        if (child.type === 'variable_declarator') {
          const nameNode = child.childForFieldName('name');
          const valueNode = child.childForFieldName('value');
          if (nameNode) {
            const isArrow = valueNode?.type === 'arrow_function';
            results.push({
              name: nameNode.text,
              kind: isArrow ? 'function' : 'variable',
              line: node.startPosition.row + 1,
              exported: isExported,
            });
          }
        }
      }
      break;
    }
  }

  // Recurse into children (but not deeply nested — only top-level + export wrappers)
  if (
    node.type === 'program' ||
    node.type === 'export_statement'
  ) {
    for (const child of namedChildren(node)) {
      walkNode(child, results);
    }
  }
}

function extractImports(
  rootNode: Node,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  for (const child of namedChildren(rootNode)) {
    if (child.type === 'import_statement') {
      const sourceNode = child.childForFieldName('source');
      if (sourceNode) {
        // Strip quotes from the import path
        const importPath = sourceNode.text.replace(/^['"]|['"]$/g, '');
        // Only track relative imports (not node_modules)
        if (importPath.startsWith('.')) {
          relations.push({
            type: 'depends_on',
            sourceName: filePath,
            sourceType: 'file',
            targetName: importPath,
            targetType: 'file',
            source,
            namespace,
          });
        }
      }
    }
  }
}
