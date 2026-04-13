import { z } from 'zod';
import type { ConversationTurn, ParsedConversation } from './claude-parser.js';

const GenericLineSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string().optional(),
});

/**
 * Parse a generic JSONL conversation export with shape:
 *   { "role": "user" | "assistant" | "system", "content": "...", "timestamp"?: "..." }
 *
 * System messages are filtered out — they're typically prompts not knowledge.
 */
export function parseGenericConversation(
  jsonl: string,
  sessionId = 'generic',
): ParsedConversation | null {
  const lines = jsonl.split('\n').filter((l) => l.trim().length > 0);
  const turns: ConversationTurn[] = [];
  for (const raw of lines) {
    let parsed;
    try {
      parsed = GenericLineSchema.parse(JSON.parse(raw));
    } catch {
      continue;
    }
    if (parsed.role === 'system') continue;
    turns.push({
      role: parsed.role,
      content: parsed.content.trim(),
      timestamp: parsed.timestamp,
    });
  }
  if (turns.length === 0) return null;
  return { sessionId, turns };
}
