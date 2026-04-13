import type { Tree, Node } from 'web-tree-sitter';
import { namedChildren } from './util.js';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { PendingRelation } from '@second-brain/ingestion';
import type { SymbolExtractionResult } from './typescript.js';

type SymbolKind = 'function' | 'class' | 'variable';

interface ExtractedPythonSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  receiver?: string;
}

// Python convention: leading underscore marks non-public API.
// (We intentionally do not parse `__all__` — it's opt-in and rare in app code.)
function isExportedName(name: string): boolean {
  return name.length > 0 && name[0] !== '_';
}

/** Extract symbols and relations from a Python parse tree. */
export function extractPython(
  tree: Tree,
  filePath: string,
  namespace: string,
  source: EntitySource,
): SymbolExtractionResult {
  const symbols: CreateEntityInput[] = [];
  const relations: PendingRelation[] = [];
  const extracted: ExtractedPythonSymbol[] = [];

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

  extractPythonImports(tree.rootNode, filePath, namespace, source, relations);

  return { symbols, relations };
}

function walkTopLevel(node: Node, results: ExtractedPythonSymbol[]): void {
  // Unwrap `@decorator`-wrapped definitions — their actual def lives inside.
  if (node.type === 'decorated_definition') {
    const def = node.childForFieldName('definition');
    if (def) walkTopLevel(def, results);
    return;
  }

  switch (node.type) {
    case 'function_definition': {
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

    case 'class_definition': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      results.push({
        name: nameNode.text,
        kind: 'class',
        line: node.startPosition.row + 1,
        exported: isExportedName(nameNode.text),
      });
      // Emit each method inside the class body with the class as receiver.
      const body = node.childForFieldName('body');
      if (body) {
        for (const bodyChild of namedChildren(body)) {
          collectClassMethod(bodyChild, nameNode.text, results);
        }
      }
      break;
    }

    case 'expression_statement': {
      // Module-level top-level assignments → variables (UPPER_CASE = convention-constant,
      // still kind=variable; callers can filter on name casing).
      const assignment = node.namedChildren[0];
      if (assignment && assignment.type === 'assignment') {
        const left = assignment.childForFieldName('left');
        if (left && left.type === 'identifier') {
          results.push({
            name: left.text,
            kind: 'variable',
            line: node.startPosition.row + 1,
            exported: isExportedName(left.text),
          });
        }
      }
      break;
    }
  }
}

function collectClassMethod(
  node: Node,
  className: string,
  results: ExtractedPythonSymbol[],
): void {
  if (node.type === 'decorated_definition') {
    const def = node.childForFieldName('definition');
    if (def) collectClassMethod(def, className, results);
    return;
  }
  if (node.type !== 'function_definition') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  results.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    exported: isExportedName(nameNode.text),
    receiver: className,
  });
}

function extractPythonImports(
  rootNode: Node,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  for (const child of namedChildren(rootNode)) {
    if (child.type === 'import_statement') {
      // `import a, b.c` → dotted_name nodes as named children
      for (const name of namedChildren(child)) {
        if (name.type === 'dotted_name' || name.type === 'aliased_import') {
          const pathText = name.type === 'aliased_import'
            ? (name.childForFieldName('name')?.text ?? name.text)
            : name.text;
          pushImport(pathText, filePath, namespace, source, relations);
        }
      }
    } else if (child.type === 'import_from_statement') {
      const moduleNode = child.childForFieldName('module_name');
      if (moduleNode) {
        pushImport(moduleNode.text, filePath, namespace, source, relations);
      }
    }
  }
}

function pushImport(
  importPath: string,
  filePath: string,
  namespace: string,
  source: EntitySource,
  relations: PendingRelation[],
): void {
  if (!importPath) return;
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
