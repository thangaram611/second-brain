import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocCollector } from '../docs/doc-collector.js';
import { parseMarkdown, externalLinks } from '../docs/markdown-parser.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-doc-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('parseMarkdown', () => {
  it('extracts headings, links, and code blocks', () => {
    const md = `# Title

Some intro [Anchor](https://example.com).

## Section

Inline code and a fenced block:

\`\`\`ts
const x = 1;
\`\`\`
`;
    const result = parseMarkdown(md);
    expect(result.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Section'],
    ]);
    expect(result.links).toHaveLength(1);
    expect(result.links[0].url).toBe('https://example.com');
    expect(result.codeBlocks).toHaveLength(1);
    expect(result.codeBlocks[0].language).toBe('ts');
    expect(result.codeBlocks[0].content).toContain('const x = 1');
  });

  it('parses YAML frontmatter into a key→string map', () => {
    const md = `---
title: Hello
draft: true
---

# Body
`;
    const result = parseMarkdown(md);
    expect(result.frontMatter).toEqual({ title: 'Hello', draft: 'true' });
  });

  it('externalLinks filters out non-http URLs', () => {
    const result = parseMarkdown('[A](https://x.com) [B](./local.md) [C](http://y.com)');
    expect(externalLinks(result).map((l) => l.url)).toEqual(['https://x.com', 'http://y.com']);
  });
});

describe('DocCollector', () => {
  it('emits file + concept + reference entities and links them', async () => {
    await fs.writeFile(
      path.join(tmp, 'design.md'),
      `# Architecture

Read [the spec](https://example.com/spec) for details.

## Decisions

We chose SQLite.
`,
    );

    const collector = new DocCollector({ watchPaths: ['.'] });
    const result = await collector.collect({
      namespace: 'personal',
      repoPath: tmp,
      ignorePatterns: [],
    });

    const types = new Map<string, number>();
    for (const e of result.entities) {
      types.set(e.type, (types.get(e.type) ?? 0) + 1);
    }
    expect(types.get('file')).toBe(1);
    expect(types.get('concept')).toBe(2); // H1 + H2
    expect(types.get('reference')).toBe(1);

    // Relations: derived_from + contains for each concept; derived_from for the reference.
    const relTypes = result.relations.map((r) => r.type);
    expect(relTypes.filter((t) => t === 'derived_from').length).toBeGreaterThanOrEqual(3);
    expect(relTypes).toContain('contains');
  });

  it('uses frontmatter title when present', async () => {
    await fs.writeFile(
      path.join(tmp, 'note.md'),
      `---
title: Custom Title
---

# Heading
`,
    );
    const collector = new DocCollector();
    const result = await collector.collect({
      namespace: 'personal',
      repoPath: tmp,
      ignorePatterns: [],
    });
    const file = result.entities.find((e) => e.type === 'file');
    expect(file?.name).toBe('Custom Title');
  });

  it('throws when llmEnrich is true but no extractor provided', () => {
    expect(() => new DocCollector({ llmEnrich: true })).toThrow(/extractor/);
  });

  it('handles empty directory without errors', async () => {
    const collector = new DocCollector();
    const result = await collector.collect({
      namespace: 'personal',
      repoPath: tmp,
      ignorePatterns: [],
    });
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  it('deduplicates references by URL', async () => {
    await fs.writeFile(
      path.join(tmp, 'a.md'),
      `# A
[same link](https://x.com) and [same link](https://x.com) and [other](https://x.com)
`,
    );
    const collector = new DocCollector();
    const result = await collector.collect({
      namespace: 'personal',
      repoPath: tmp,
      ignorePatterns: [],
    });
    const refs = result.entities.filter((e) => e.type === 'reference');
    expect(refs).toHaveLength(1);
  });
});
