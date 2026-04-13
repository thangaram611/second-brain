import { Parser, Language } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { Collector, ExtractionResult, PipelineConfig, PendingRelation } from '@second-brain/ingestion';
import { computeContentHash } from '@second-brain/ingestion';
import { scanFiles } from './file-scanner.js';
import { extractTypeScript } from './languages/typescript.js';
import { extractGo } from './languages/go.js';
import { extractPython } from './languages/python.js';
import { extractRust } from './languages/rust.js';
import { extractJava } from './languages/java.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.go',
  '.py',
  '.rs',
  '.java',
]);

/** Map file extension to grammar WASM filename */
function grammarForExtension(ext: string): string | null {
  switch (ext) {
    case '.ts':
      return 'tree-sitter-typescript.wasm';
    case '.tsx':
      return 'tree-sitter-tsx.wasm';
    case '.js':
    case '.jsx':
      return 'tree-sitter-javascript.wasm';
    case '.go':
      return 'tree-sitter-go.wasm';
    case '.py':
      return 'tree-sitter-python.wasm';
    case '.rs':
      return 'tree-sitter-rust.wasm';
    case '.java':
      return 'tree-sitter-java.wasm';
    default:
      return null;
  }
}

/**
 * Resolve the path to a grammar WASM file from the tree-sitter-wasms package.
 */
function resolveGrammarPath(grammarFile: string): string {
  const require = createRequire(import.meta.url);
  const wasmPkgDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  return path.join(wasmPkgDir, 'out', grammarFile);
}

export class ASTCollector implements Collector {
  readonly name = 'ast';

  private parserReady: Promise<Parser> | null = null;
  private languageCache = new Map<string, Language>();

  private getParser(): Promise<Parser> {
    if (!this.parserReady) {
      this.parserReady = Parser.init().then(() => new Parser());
    }
    return this.parserReady;
  }

  private async loadLanguage(grammarFile: string): Promise<Language> {
    const cached = this.languageCache.get(grammarFile);
    if (cached) return cached;

    const grammarPath = resolveGrammarPath(grammarFile);
    const language = await Language.load(grammarPath);
    this.languageCache.set(grammarFile, language);
    return language;
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const parser = await this.getParser();
    const entities: CreateEntityInput[] = [];
    const relations: PendingRelation[] = [];

    const repoPath = config.repoPath ?? process.cwd();
    const files = await scanFiles(repoPath, {
      extensions: SUPPORTED_EXTENSIONS,
      ignorePatterns: config.ignorePatterns,
    });

    const source: EntitySource = { type: 'ast', ref: repoPath };

    for (const fullPath of files) {
      const relPath = path.relative(repoPath, fullPath);
      const ext = path.extname(fullPath);
      const grammarFile = grammarForExtension(ext);
      if (!grammarFile) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const contentHash = computeContentHash(content);

      // Create file entity
      entities.push({
        type: 'file',
        name: relPath,
        namespace: config.namespace,
        observations: [],
        properties: {
          path: relPath,
          extension: ext,
          contentHash,
          role: classifyFileRole(relPath),
        },
        source: { type: 'ast', ref: relPath },
        tags: classifyFileTags(relPath),
      });

      // Parse and extract symbols
      try {
        const language = await this.loadLanguage(grammarFile);
        parser.setLanguage(language);
        const tree = parser.parse(content);
        if (tree === null) continue;

        const result = extractForExtension(ext, tree, relPath, config.namespace, source);
        if (result) {
          entities.push(...result.symbols);
          relations.push(...result.relations);
        }
      } catch {
        // Skip files that fail to parse
      }
    }

    return { entities, relations };
  }
}

function extractForExtension(
  ext: string,
  tree: Tree,
  filePath: string,
  namespace: string,
  source: EntitySource,
) {
  switch (ext) {
    case '.go':
      return extractGo(tree, filePath, namespace, source);
    case '.py':
      return extractPython(tree, filePath, namespace, source);
    case '.rs':
      return extractRust(tree, filePath, namespace, source);
    case '.java':
      return extractJava(tree, filePath, namespace, source);
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      return extractTypeScript(tree, filePath, namespace, source);
    default:
      return null;
  }
}

function classifyFileRole(relPath: string): string {
  const lower = relPath.toLowerCase();
  if (lower.includes('test') || lower.includes('spec')) return 'test';
  if (lower.includes('config') || lower.endsWith('.config.ts') || lower.endsWith('.config.js')) return 'config';
  if (lower.endsWith('.d.ts')) return 'type';
  if (lower.includes('component') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'component';
  if (lower.includes('util') || lower.includes('helper') || lower.includes('lib/')) return 'util';
  if (lower.includes('index.')) return 'barrel';
  return 'module';
}

function classifyFileTags(relPath: string): string[] {
  const tags: string[] = [];
  const lower = relPath.toLowerCase();
  const ext = path.extname(relPath);

  if (ext === '.ts' || ext === '.tsx') tags.push('typescript');
  if (ext === '.js' || ext === '.jsx') tags.push('javascript');
  if (ext === '.go') tags.push('go');
  if (ext === '.py') tags.push('python');
  if (ext === '.rs') tags.push('rust');
  if (ext === '.java') tags.push('java');
  if (lower.includes('test') || lower.includes('spec')) tags.push('test');
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) tags.push('component');

  return tags;
}
