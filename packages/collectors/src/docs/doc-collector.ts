import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { Collector, ExtractionResult, PendingRelation, PipelineConfig } from '@second-brain/ingestion';
import { computeContentHash, LLMExtractor } from '@second-brain/ingestion';
import { scanFiles } from '../ast/file-scanner.js';
import { parseMarkdown, externalLinks, type MarkdownExtraction } from './markdown-parser.js';

export interface DocCollectorOptions {
  /** Directories (relative or absolute) to scan for markdown. Defaults to `['.']`. */
  watchPaths?: string[];
  /** Glob-substring ignore patterns. Defaults to `['node_modules','dist','.git']`. */
  ignorePatterns?: string[];
  /** When true, run the LLM extractor over each doc body for prose-level extraction. */
  llmEnrich?: boolean;
  /** LLM extractor instance (required when `llmEnrich` is true). */
  extractor?: LLMExtractor;
}

const MD_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

/**
 * Walks markdown files and emits:
 *  - 1 file entity per doc (with frontmatter as properties)
 *  - 1 concept entity per top-level (H1/H2) heading
 *  - 1 reference entity per external http(s) link
 *  - relates_to / derived_from / contains relations linking them together
 *
 * If `llmEnrich` is enabled, additionally calls LLMExtractor on each doc body
 * and merges the resulting decisions/facts/patterns.
 */
export class DocCollector implements Collector {
  readonly name = 'docs';

  constructor(private options: DocCollectorOptions = {}) {
    if (options.llmEnrich && !options.extractor) {
      throw new Error('DocCollector: llmEnrich=true requires `extractor` option');
    }
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const root = config.repoPath ?? process.cwd();
    const watchPaths = (this.options.watchPaths ?? ['.']).map((p) =>
      path.isAbsolute(p) ? p : path.join(root, p),
    );
    const ignore = this.options.ignorePatterns ?? config.ignorePatterns ?? [
      'node_modules',
      'dist',
      '.git',
    ];

    const merged: ExtractionResult = { entities: [], relations: [] };
    let processed = 0;

    for (const dir of watchPaths) {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat) continue;
      const files = stat.isDirectory()
        ? await scanFiles(dir, { extensions: MD_EXTENSIONS, ignorePatterns: ignore })
        : MD_EXTENSIONS.has(path.extname(dir))
          ? [dir]
          : [];

      for (const fullPath of files) {
        const relPath = path.relative(root, fullPath);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        const docResult = await this.processFile(content, relPath, config.namespace);
        merged.entities.push(...docResult.entities);
        merged.relations.push(...docResult.relations);
        processed += 1;

        if (config.onProgress) {
          config.onProgress({
            stage: 'collecting',
            collector: this.name,
            current: processed,
            total: files.length,
            message: `parsed ${relPath}`,
          });
        }
      }
    }

    return merged;
  }

  private async processFile(
    content: string,
    relPath: string,
    namespace: string,
  ): Promise<ExtractionResult> {
    const md = parseMarkdown(content);
    const source: EntitySource = { type: 'doc', ref: relPath };
    const contentHash = computeContentHash(content);

    const fileName = pickFileName(relPath, md);
    const fileEntity: CreateEntityInput = {
      type: 'file',
      name: fileName,
      namespace,
      observations: [],
      properties: {
        path: relPath,
        kind: 'doc',
        contentHash,
        ...(md.frontMatter ?? {}),
      },
      tags: ['docs', 'markdown'],
      source,
    };

    const entities: CreateEntityInput[] = [fileEntity];
    const relations: PendingRelation[] = [];

    // Top-level headings → concept entities (level ≤ 2 only, to avoid noise).
    const conceptHeadings = md.headings.filter((h) => h.level <= 2);
    for (const h of conceptHeadings) {
      entities.push({
        type: 'concept',
        name: h.text,
        namespace,
        observations: [`Documented in ${relPath}`],
        tags: ['from-doc'],
        source,
      });
      relations.push({
        type: 'derived_from',
        sourceName: h.text,
        sourceType: 'concept',
        targetName: fileName,
        targetType: 'file',
        namespace,
        source,
      });
      relations.push({
        type: 'contains',
        sourceName: fileName,
        sourceType: 'file',
        targetName: h.text,
        targetType: 'concept',
        namespace,
        source,
      });
    }

    // External http(s) links → reference entities.
    const refs = externalLinks(md);
    const seenUrl = new Set<string>();
    for (const link of refs) {
      if (seenUrl.has(link.url)) continue;
      seenUrl.add(link.url);
      const refName = link.text || link.url;
      entities.push({
        type: 'reference',
        name: refName,
        namespace,
        observations: [link.url],
        properties: { url: link.url },
        tags: ['from-doc'],
        source,
      });
      relations.push({
        type: 'derived_from',
        sourceName: refName,
        sourceType: 'reference',
        targetName: fileName,
        targetType: 'file',
        namespace,
        source,
      });
    }

    // Optional LLM enrichment.
    if (this.options.llmEnrich && this.options.extractor) {
      const enrich = await this.options.extractor.extract(md.body, {
        namespace,
        source,
      });
      entities.push(...enrich.entities);
      relations.push(...enrich.relations);
    }

    return { entities, relations };
  }
}

function pickFileName(relPath: string, md: MarkdownExtraction): string {
  if (md.frontMatter && typeof md.frontMatter.title === 'string' && md.frontMatter.title.trim()) {
    return md.frontMatter.title.trim();
  }
  // First h1 wins, otherwise fall back to file basename.
  const h1 = md.headings.find((h) => h.level === 1);
  if (h1) return h1.text;
  return path.basename(relPath, path.extname(relPath));
}
