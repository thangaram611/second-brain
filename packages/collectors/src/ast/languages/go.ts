import type { Tree, Node } from 'web-tree-sitter';
import { namedChildren } from './util.js';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { PendingRelation } from '@second-brain/ingestion';
import type { SymbolExtractionResult } from './typescript.js';

type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'const';

interface ExtractedGoSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  receiver?: string;
}

function isExportedName(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

/**
 * Extract symbols and relations from a Go parse tree.
 */
export function extractGo(
  tree: Tree,
  filePath: string,
  namespace: string,
  source: EntitySource,
): SymbolExtractionResult {
  const symbols: CreateEntityInput[] = [];
  const relations: PendingRelation[] = [];
  const extracted: ExtractedGoSymbol[] = [];

  walkGoNode(tree.rootNode, extracted);

  for (const sym of extracted) {
    const properties: Record<string, unknown> = {
      kind: sym.kind,
      filePath,
      line: sym.line,
      exported: sym.exported,
    };
    if (sym.receiver) {
      properties.receiver = sym.receiver;
    }

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

  extractGoImports(tree.rootNode, filePath, namespace, source, relations);

  return { symbols, relations };
}

function walkGoNode(node: Node, results: ExtractedGoSymbol[]): void {
  switch (node.type) {
    case 'function_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        results.push({
          name: nameNode.text,
          kind: 'function',
          line: node.startPosition.row + 1,
          exported: isExportedName(nameNode.text),
        });
      }
      break;
    }

    case 'method_declaration': {
      const nameNode = node.childForFieldName('name');
      const receiverNode = node.childForFieldName('receiver');
      if (nameNode) {
        let receiver: string | undefined;
        if (receiverNode) {
          // receiver is a parameter_list, find the type inside
          const paramDecl = receiverNode.namedChildren[0];
          if (paramDecl) {
            const typeNode = paramDecl.childForFieldName('type');
            if (typeNode) {
              // strip pointer prefix if present
              receiver = typeNode.text.replace(/^\*/, '');
            }
          }
        }
        results.push({
          name: nameNode.text,
          kind: 'function',
          line: node.startPosition.row + 1,
          exported: isExportedName(nameNode.text),
          receiver,
        });
      }
      break;
    }

    case 'type_declaration': {
      for (const child of namedChildren(node)) {
        if (child.type === 'type_spec') {
          const nameNode = child.childForFieldName('name');
          const typeNode = child.childForFieldName('type');
          if (nameNode) {
            let kind: SymbolKind = 'type';
            if (typeNode) {
              if (typeNode.type === 'struct_type') kind = 'class';
              else if (typeNode.type === 'interface_type') kind = 'interface';
            }
            results.push({
              name: nameNode.text,
              kind,
              line: child.startPosition.row + 1,
              exported: isExportedName(nameNode.text),
            });
          }
        }
      }
      break;
    }

    case 'var_declaration': {
      for (const child of namedChildren(node)) {
        if (child.type === 'var_spec') {
          for (const nameNode of namedChildren(child)) {
            if (nameNode.type === 'identifier') {
              results.push({
                name: nameNode.text,
                kind: 'variable',
                line: child.startPosition.row + 1,
                exported: isExportedName(nameNode.text),
              });
            }
          }
        }
      }
      break;
    }

    case 'const_declaration': {
      for (const child of namedChildren(node)) {
        if (child.type === 'const_spec') {
          for (const nameNode of namedChildren(child)) {
            if (nameNode.type === 'identifier') {
              results.push({
                name: nameNode.text,
                kind: 'const',
                line: child.startPosition.row + 1,
                exported: isExportedName(nameNode.text),
              });
            }
          }
        }
      }
      break;
    }
  }

  // Only recurse into top-level source_file children
  if (node.type === 'source_file') {
    for (const child of namedChildren(node)) {
      walkGoNode(child, results);
    }
  }
}

function extractGoImports(
  rootNode: Node,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  for (const child of namedChildren(rootNode)) {
    if (child.type === 'import_declaration') {
      // Can contain a single import_spec or an import_spec_list
      for (const spec of namedChildren(child)) {
        if (spec.type === 'import_spec') {
          addImportRelation(spec, filePath, namespace, source, relations);
        } else if (spec.type === 'import_spec_list') {
          for (const innerSpec of namedChildren(spec)) {
            if (innerSpec.type === 'import_spec') {
              addImportRelation(innerSpec, filePath, namespace, source, relations);
            }
          }
        }
      }
    }
  }
}

function addImportRelation(
  spec: Node,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  const pathNode = spec.childForFieldName('path');
  if (pathNode) {
    const importPath = pathNode.text.replace(/^"|"$/g, '');
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
