import { z } from 'zod';

export const CopilotEnvelopeSchema = z.object({
  type: z.string(),
  data: z.unknown().optional(),
  id: z.string().optional(),
  timestamp: z.string().optional(),
  parentId: z.string().optional(),
});

export type CopilotEnvelope = z.infer<typeof CopilotEnvelopeSchema>;

export const CopilotSessionStartSchema = z.object({
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  gitRoot: z.string().optional(),
  branch: z.string().optional(),
  headCommit: z.string().optional(),
  baseCommit: z.string().optional(),
  model: z.string().optional(),
});

export const CopilotUserMessageSchema = z.object({
  content: z.string().optional(),
  transformedContent: z.string().optional(),
  attachments: z.array(z.unknown()).optional(),
  interactionId: z.string().optional(),
});

export const CopilotAssistantMessageSchema = z.object({
  content: z.string().optional(),
  toolRequests: z.array(z.unknown()).optional(),
  outputTokens: z.number().optional(),
});

export type CopilotObservation =
  | { kind: 'session-start'; sessionId: string; payload: Record<string, unknown> }
  | { kind: 'prompt'; sessionId: string; prompt: string }
  | { kind: 'assistant-text'; sessionId: string; text: string }
  | { kind: 'tool-request'; sessionId: string; toolName: string; input: unknown }
  | { kind: 'session-end'; sessionId: string; reason?: string }
  | { kind: 'other'; sessionId: string; type: string; rawPayload: unknown };

/**
 * Map a Copilot event-envelope + a known session ID to our internal
 * observation shape. Unknown types are passed through as 'other' so a
 * Copilot upgrade that adds new event types doesn't silently drop data.
 */
export function mapCopilotEnvelope(
  sessionId: string,
  raw: unknown,
): CopilotObservation | null {
  const parsed = CopilotEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const env = parsed.data;

  switch (env.type) {
    case 'session.start': {
      const data = CopilotSessionStartSchema.safeParse(env.data).data ?? {};
      return {
        kind: 'session-start',
        sessionId,
        payload: {
          cwd: data.cwd,
          gitRoot: data.gitRoot,
          branch: data.branch,
          headCommit: data.headCommit,
          baseCommit: data.baseCommit,
          model: data.model,
        },
      };
    }
    case 'user.message': {
      const data = CopilotUserMessageSchema.safeParse(env.data).data ?? {};
      const prompt = data.transformedContent ?? data.content ?? '';
      return { kind: 'prompt', sessionId, prompt };
    }
    case 'assistant.message': {
      const data = CopilotAssistantMessageSchema.safeParse(env.data).data ?? {};
      return {
        kind: 'assistant-text',
        sessionId,
        text: data.content ?? '',
      };
    }
    case 'session.end':
    case 'session.close':
      return { kind: 'session-end', sessionId, reason: 'event' };
    case 'assistant.turn_start':
    case 'assistant.turn_end':
      return null;
    default:
      return { kind: 'other', sessionId, type: env.type, rawPayload: env.data };
  }
}
