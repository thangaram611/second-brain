export { PostClient } from './post-client.js';
export type { PostClientOptions, ObservePath } from './post-client.js';

export { mapCopilotEnvelope } from './parsers/copilot-events.js';
export type {
  CopilotEnvelope,
  CopilotObservation,
} from './parsers/copilot-events.js';
export {
  CopilotEnvelopeSchema,
  CopilotSessionStartSchema,
  CopilotUserMessageSchema,
  CopilotAssistantMessageSchema,
} from './parsers/copilot-events.js';

export { createCopilotTailer } from './copilot-tailer.js';
export type { CopilotTailerOptions, CopilotTailerHandle } from './copilot-tailer.js';

export { createCopilotSqlitePoller } from './copilot-sqlite.js';
export type { CopilotSqlitePollerOptions } from './copilot-sqlite.js';

export { createCodexSqlitePoller } from './codex-sqlite.js';
export type { CodexSqlitePollerOptions } from './codex-sqlite.js';

export { ingestClaudeMemOnce } from './claude-mem-reader.js';
export type { ClaudeMemReaderOptions, ClaudeMemReaderResult } from './claude-mem-reader.js';
