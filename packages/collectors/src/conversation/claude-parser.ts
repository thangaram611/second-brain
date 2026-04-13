import { z } from 'zod';

/**
 * Schema for an individual JSONL line in a Claude Code conversation log.
 * Lenient — unknown line types are silently dropped during parsing.
 */
const ClaudeLineSchema = z
  .object({
    type: z.string().optional(),
    sessionId: z.string().optional(),
    uuid: z.string().optional(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    message: z
      .object({
        role: z.enum(['user', 'assistant']).optional(),
        content: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface ParsedConversation {
  /** Stable identifier for the session (sessionId from the log if present). */
  sessionId: string;
  /** Working directory when the conversation occurred (if available). */
  projectPath?: string;
  turns: ConversationTurn[];
}

/**
 * Parse a Claude Code .jsonl file into a sequence of user↔assistant turns.
 * Skips system/permission/snapshot/attachment/tool-use lines.
 * Returns null when no conversational content is present.
 */
export function parseClaudeConversation(
  jsonl: string,
  fallbackSessionId = 'unknown',
): ParsedConversation | null {
  const lines = jsonl.split('\n').filter((l) => l.trim().length > 0);
  const turns: ConversationTurn[] = [];
  let sessionId = fallbackSessionId;
  let projectPath: string | undefined;

  for (const raw of lines) {
    let parsed;
    try {
      parsed = ClaudeLineSchema.parse(JSON.parse(raw));
    } catch {
      // Malformed JSON or unexpected shape — skip.
      continue;
    }

    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.cwd && !projectPath) projectPath = parsed.cwd;

    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
    const role = parsed.message?.role ?? (parsed.type === 'user' ? 'user' : 'assistant');
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractTextContent(parsed.message?.content);
    if (!text) continue;

    turns.push({
      role,
      content: text,
      timestamp: parsed.timestamp,
    });
  }

  if (turns.length === 0) return null;
  return { sessionId, projectPath, turns };
}

/**
 * Pull readable text from Claude content fields.
 * Handles: plain string, array of content blocks (text + thinking + tool_use).
 * Skips thinking blocks (internal reasoning) and tool_use blocks.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object') {
      const obj = block as Record<string, unknown>;
      const blockType = typeof obj.type === 'string' ? obj.type : '';
      if (blockType === 'text' && typeof obj.text === 'string') {
        parts.push(obj.text);
      }
      // Skip 'thinking', 'tool_use', 'tool_result', 'image', etc.
    }
  }
  return parts.join('\n').trim();
}

/**
 * Render a parsed conversation as a single text blob for LLM extraction.
 * Trims very long contents and skips empty turns.
 */
export function conversationToText(convo: ParsedConversation, maxChars = 24_000): string {
  const lines: string[] = [];
  for (const turn of convo.turns) {
    if (!turn.content.trim()) continue;
    lines.push(`### ${turn.role.toUpperCase()}\n${turn.content}`);
  }
  const joined = lines.join('\n\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
