import type { Tree, Node } from 'web-tree-sitter';
import { namedChildren, children } from './util.js';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { PendingRelation } from '@second-brain/ingestion';
import type { SymbolExtractionResult } from './typescript.js';

type SymbolKind = 'function' | 'class' | 'interface' | 'enum' | 'variable';

interface ExtractedJavaSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  receiver?: string;
}

function hasPublicModifier(node: Node): boolean {
  for (const child of namedChildren(node)) {
    if (child.type === 'modifiers') {
      // `modifiers` contains keyword children (public/private/protected/static/final/etc.)
      for (const mod of children(child)) {
        if (mod.type === 'public') return true;
      }
    }
  }
  return false;
}

/** Extract symbols and relations from a Java parse tree. */
export function extractJava(
  tree: Tree,
  filePath: string,
  namespace: string,
  source: EntitySource,
): SymbolExtractionResult {
  const symbols: CreateEntityInput[] = [];
  const relations: PendingRelation[] = [];
  const extracted: ExtractedJavaSymbol[] = [];

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

  extractJavaImports(tree.rootNode, filePath, namespace, source, relations);

  return { symbols, relations };
}

function walkTopLevel(node: Node, results: ExtractedJavaSymbol[]): void {
  switch (node.type) {
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'record_declaration': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const kind: SymbolKind =
        node.type === 'interface_declaration'
          ? 'interface'
          : node.type === 'enum_declaration'
            ? 'enum'
            : 'class';
      results.push({
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1,
        exported: hasPublicModifier(node),
      });
      const body = node.childForFieldName('body');
      if (body) {
        for (const bodyChild of namedChildren(body)) {
          collectClassMember(bodyChild, nameNode.text, results);
        }
      }
      break;
    }
  }
}

function collectClassMember(
  node: Node,
  className: string,
  results: ExtractedJavaSymbol[],
): void {
  switch (node.type) {
    case 'method_declaration':
    case 'constructor_declaration': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      results.push({
        name: nameNode.text,
        kind: 'function',
        line: node.startPosition.row + 1,
        exported: hasPublicModifier(node),
        receiver: className,
      });
      break;
    }
    case 'field_declaration': {
      // Declarator names live under variable_declarator → identifier.
      for (const declarator of namedChildren(node)) {
        if (declarator.type === 'variable_declarator') {
          const nameNode = declarator.childForFieldName('name');
          if (nameNode) {
            results.push({
              name: nameNode.text,
              kind: 'variable',
              line: declarator.startPosition.row + 1,
              exported: hasPublicModifier(node),
              receiver: className,
            });
          }
        }
      }
      break;
    }
    // Nested classes/interfaces → recurse with the outer class as the enclosing
    // scope. Java's tree-sitter exposes these at the same node types.
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'record_declaration':
      walkTopLevel(node, results);
      break;
  }
}

function extractJavaImports(
  rootNode: Node,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  for (const child of namedChildren(rootNode)) {
    if (child.type === 'import_declaration') {
      // The import path is the non-keyword text; simplest is full text minus keywords/semicolon.
      const pathText = child.text
        .replace(/^import\s+/, '')
        .replace(/^static\s+/, '')
        .replace(/;$/, '')
        .trim();
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
