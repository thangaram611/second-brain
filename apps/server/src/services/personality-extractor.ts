import type { Brain } from '@second-brain/core';

export interface PersonalityStream {
  readonly name: string;
  run(ctx: PersonalityContext): Promise<{ created: number; updated: number }>;
}

export interface PersonalityContext {
  brain: Brain;
  actor: string;
  llm: LLMHandle | null;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  now: Date;
}

export interface LLMHandle {
  generate(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface PersonalityExtractorOptions {
  llm?: LLMHandle | null;
  logger?: PersonalityContext['logger'];
  now?: Date;
}

export interface PersonalityRunResult {
  actor: string;
  streams: Record<string, { created: number; updated: number; error?: string }>;
  durationMs: number;
}

export class PersonalityExtractor {
  private streams: PersonalityStream[] = [];
  private running = false;

  constructor(
    private brain: Brain,
    private options: PersonalityExtractorOptions = {},
  ) {}

  registerStream(stream: PersonalityStream): void {
    this.streams.push(stream);
  }

  async run(actor: string): Promise<PersonalityRunResult> {
    if (this.running) {
      return { actor, streams: {}, durationMs: 0 };
    }
    this.running = true;
    const start = Date.now();
    const results: Record<string, { created: number; updated: number; error?: string }> = {};
    const logger = this.options.logger ?? console;

    const ctx: PersonalityContext = {
      brain: this.brain,
      actor,
      llm: this.options.llm ?? null,
      logger,
      now: this.options.now ?? new Date(),
    };

    for (const stream of this.streams) {
      try {
        const result = await stream.run(ctx);
        results[stream.name] = result;
        logger.info(
          `[personality] stream=${stream.name} created=${result.created} updated=${result.updated}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[stream.name] = { created: 0, updated: 0, error: message };
        logger.error(`[personality] stream=${stream.name} error: ${message}`);
      }
    }

    this.running = false;
    return { actor, streams: results, durationMs: Date.now() - start };
  }

  /** For session-end calls — runs only if not already running */
  async runForSession(
    _sessionId: string,
    opts: { actor: string },
  ): Promise<PersonalityRunResult | null> {
    if (this.running) {
      this.options.logger?.info?.(
        `[personality] skipping session-end run — already running`,
      );
      return null;
    }
    return this.run(opts.actor);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get registeredStreams(): readonly PersonalityStream[] {
    return this.streams;
  }
}
