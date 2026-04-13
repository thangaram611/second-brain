/**
 * Lightweight regex-based markdown parser. Produces deterministic structural
 * extraction (headings, links, frontmatter, code blocks). For prose-level
 * extraction (decisions, facts, patterns), pair with `LLMExtractor`.
 *
 * Trade-off: this skips edge cases a full CommonMark parser would handle
 * (nested fences, complex link syntax, tables). Good enough for typical
 * developer docs / READMEs / design notes.
 */

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

export interface MarkdownLink {
  text: string;
  url: string;
  line: number;
}

export interface MarkdownCodeBlock {
  language: string;
  content: string;
  line: number;
}

export interface MarkdownExtraction {
  headings: MarkdownHeading[];
  links: MarkdownLink[];
  /** YAML frontmatter as a key→string map. Multi-line values supported via simple line continuation. */
  frontMatter: Record<string, string> | null;
  codeBlocks: MarkdownCodeBlock[];
  /** Body content with frontmatter and code blocks stripped. */
  body: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const FENCE_RE = /^```\s*([a-zA-Z0-9_+\-]*)\s*$/;

export function parseMarkdown(input: string): MarkdownExtraction {
  let content = input;
  const frontMatter = extractFrontMatter(content);
  if (frontMatter) {
    content = content.replace(FRONTMATTER_RE, '');
  }

  const lines = content.split('\n');
  const headings: MarkdownHeading[] = [];
  const links: MarkdownLink[] = [];
  const codeBlocks: MarkdownCodeBlock[] = [];
  const bodyLines: string[] = [];

  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let codeStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (inCode) {
        codeBlocks.push({
          language: codeLang,
          content: codeBuf.join('\n'),
          line: codeStart + 1,
        });
        inCode = false;
        codeBuf = [];
        codeLang = '';
      } else {
        inCode = true;
        codeLang = fence[1];
        codeStart = i;
        codeBuf = [];
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    bodyLines.push(line);

    const heading = HEADING_RE.exec(line);
    if (heading) {
      headings.push({
        level: heading[1].length,
        text: heading[2].trim(),
        line: i + 1,
      });
    }

    let m: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line)) !== null) {
      links.push({ text: m[1].trim(), url: m[2], line: i + 1 });
    }
  }

  // Unterminated fence — emit what we have.
  if (inCode) {
    codeBlocks.push({
      language: codeLang,
      content: codeBuf.join('\n'),
      line: codeStart + 1,
    });
  }

  return {
    headings,
    links,
    frontMatter,
    codeBlocks,
    body: bodyLines.join('\n'),
  };
}

function extractFrontMatter(input: string): Record<string, string> | null {
  const m = FRONTMATTER_RE.exec(input);
  if (!m) return null;

  const out: Record<string, string> = {};
  const lines = m[1].split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  const flush = () => {
    if (currentKey !== null) {
      out[currentKey] = currentValue.join('\n').trim();
    }
  };

  for (const line of lines) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      currentKey = kv[1];
      currentValue = kv[2] ? [kv[2]] : [];
    } else if (currentKey !== null && line.startsWith('  ')) {
      currentValue.push(line.trim());
    }
  }
  flush();
  return out;
}

/** Extract candidate external URLs (http/https) from links. */
export function externalLinks(extraction: MarkdownExtraction): MarkdownLink[] {
  return extraction.links.filter((l) => /^https?:\/\//i.test(l.url));
}
