import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const generateObjectMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateObject: generateObjectMock };
});

const { ConversationCollector } = await import('../conversation/conversation-collector.js');
const { parseClaudeConversation, conversationToText } = await import(
  '../conversation/claude-parser.js'
);
const { parseGenericConversation } = await import('../conversation/generic-parser.js');
const { LLMExtractor } = await import('../extraction/llm-extractor.js');

const cfg = {
  provider: 'ollama' as const,
  model: 'llama3.2',
  embeddingModel: 'nomic-embed-text',
};

let tmp: string;
beforeEach(async () => {
  generateObjectMock.mockReset();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-convo-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('parseClaudeConversation', () => {
  it('extracts user + assistant turns and skips system lines', () => {
    const jsonl = [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
      JSON.stringify({
        type: 'user',
        sessionId: 'sess1',
        cwd: '/proj',
        timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: 'How do CRDTs work?' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess1',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal' },
            { type: 'text', text: 'CRDTs are conflict-free replicated data types.' },
            { type: 'tool_use', name: 'WebSearch' },
          ],
        },
      }),
      JSON.stringify({ type: 'file-history-snapshot' }),
    ].join('\n');

    const convo = parseClaudeConversation(jsonl, 'fallback');
    expect(convo).not.toBeNull();
    expect(convo!.sessionId).toBe('sess1');
    expect(convo!.projectPath).toBe('/proj');
    expect(convo!.turns).toHaveLength(2);
    expect(convo!.turns[0].role).toBe('user');
    expect(convo!.turns[1].content).toContain('CRDTs are conflict-free');
    // Thinking and tool_use blocks must be filtered out.
    expect(convo!.turns[1].content).not.toContain('internal');
  });

  it('returns null when no conversational content present', () => {
    expect(parseClaudeConversation('', 'x')).toBeNull();
    expect(parseClaudeConversation('not json\n', 'x')).toBeNull();
  });
});

describe('parseGenericConversation', () => {
  it('parses standard role/content lines and drops system role', () => {
    const jsonl = [
      JSON.stringify({ role: 'system', content: 'You are helpful' }),
      JSON.stringify({ role: 'user', content: 'Hi' }),
      JSON.stringify({ role: 'assistant', content: 'Hello!' }),
    ].join('\n');

    const convo = parseGenericConversation(jsonl, 'g1');
    expect(convo).not.toBeNull();
    expect(convo!.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });
});

describe('conversationToText', () => {
  it('renders turns into a single transcript', () => {
    const convo = parseClaudeConversation(
      JSON.stringify({
        type: 'user',
        sessionId: 's',
        message: { role: 'user', content: 'Hello' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          sessionId: 's',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi back' }] },
        }),
      'x',
    );
    expect(convo).not.toBeNull();
    const text = conversationToText(convo!);
    expect(text).toContain('USER');
    expect(text).toContain('ASSISTANT');
    expect(text).toContain('Hello');
    expect(text).toContain('Hi back');
  });
});

describe('ConversationCollector', () => {
  function fileWithBody(body: string): string {
    const filePath = path.join(tmp, 'session.jsonl');
    return filePath;
  }

  it('emits a conversation entity + LLM-extracted decisions linked back', async () => {
    const filePath = path.join(tmp, 'session.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 's-test',
          cwd: '/repo',
          message: { role: 'user', content: 'Should we use SQLite?' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's-test',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Yes — local-first.' }] },
        }),
      ].join('\n'),
    );

    generateObjectMock.mockResolvedValue({
      object: {
        entities: [
          { type: 'decision', name: 'Use SQLite', observations: ['for local-first'] },
          { type: 'fact', name: 'SQLite supports FTS5' },
        ],
        relations: [],
      },
    });

    const extractor = new LLMExtractor(cfg);
    const collector = new ConversationCollector({ file: filePath, extractor, format: 'claude' });
    const result = await collector.collect({
      namespace: 'personal',
      ignorePatterns: [],
    });

    const types = result.entities.map((e) => e.type);
    expect(types).toContain('conversation');
    expect(types).toContain('decision');
    expect(types).toContain('fact');

    // Auto-link: decision --decided_in--> conversation, fact --derived_from--> conversation.
    const relTypes = result.relations.map((r) => r.type);
    expect(relTypes).toContain('decided_in');
    expect(relTypes).toContain('derived_from');
  });

  it('handles missing files gracefully', async () => {
    const extractor = new LLMExtractor(cfg);
    const collector = new ConversationCollector({
      file: path.join(tmp, 'does-not-exist.jsonl'),
      extractor,
    });
    const result = await collector.collect({
      namespace: 'personal',
      ignorePatterns: [],
    });
    expect(result.entities).toEqual([]);
  });

  it('respects maxConversations limit', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(tmp, `s${i}.jsonl`),
        JSON.stringify({
          type: 'user',
          sessionId: `s${i}`,
          message: { role: 'user', content: 'hi' },
        }),
      );
    }
    generateObjectMock.mockResolvedValue({ object: { entities: [], relations: [] } });

    const extractor = new LLMExtractor(cfg);
    const collector = new ConversationCollector({
      source: tmp,
      extractor,
      maxConversations: 2,
      format: 'claude',
    });
    const result = await collector.collect({
      namespace: 'personal',
      ignorePatterns: [],
    });
    const convos = result.entities.filter((e) => e.type === 'conversation');
    expect(convos).toHaveLength(2);
  });
});
