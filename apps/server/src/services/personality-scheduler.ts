import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Brain } from '@second-brain/core';
import type { PersonalityExtractor } from './personality-extractor.js';

/** The on-disk user config, narrowed to the fields this scheduler touches. */
const ConfigFileSchema = z
  .object({
    personality: z
      .object({ lastRunAt: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

/** Distinct source actors discovered for nightly personality extraction. */
const ActorRowSchema = z.object({ source_actor: z.string() });

export interface PersonalitySchedulerOptions {
  configPath?: string;
  intervalMs?: number;
  bootDelayMs?: number;
}

/**
 * Manages recurring personality extraction runs with restart-recovery.
 * Persists `lastRunAt` in the user config file so the scheduler survives
 * restarts without immediately re-running.
 */
export function startPersonalityScheduler(
  brain: Brain,
  extractor: PersonalityExtractor,
  options: PersonalitySchedulerOptions = {},
): void {
  const configPath =
    options.configPath ?? join(homedir(), '.second-brain', 'config.json');
  const intervalMs =
    options.intervalMs ??
    Number(process.env.PERSONALITY_EXTRACT_INTERVAL_MS ?? 86_400_000); // 24h
  const bootDelayMs = options.bootDelayMs ?? 10 * 60 * 1000; // 10 min

  function readLastRunAt(): string | null {
    try {
      if (!existsSync(configPath)) return null;
      const config = ConfigFileSchema.parse(
        JSON.parse(readFileSync(configPath, 'utf-8')),
      );
      return config.personality?.lastRunAt ?? null;
    } catch {
      return null;
    }
  }

  function writeLastRunAt(iso: string): void {
    try {
      const dir = dirname(configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const config = existsSync(configPath)
        ? ConfigFileSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')))
        : ConfigFileSchema.parse({});
      config.personality = { ...config.personality, lastRunAt: iso };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      console.warn(
        '[second-brain] failed to write personality lastRunAt:',
        err,
      );
    }
  }

  async function runPersonalityExtraction(): Promise<void> {
    try {
      const actors = z.array(ActorRowSchema).parse(
        brain.storage.sqlite
          .prepare(
            `SELECT DISTINCT source_actor FROM entities WHERE source_actor IS NOT NULL LIMIT 20`,
          )
          .all(),
      );

      for (const row of actors) {
        await extractor.run(row.source_actor);
      }
      writeLastRunAt(new Date().toISOString());
    } catch (err) {
      console.warn(
        '[second-brain] nightly personality extraction error:',
        err,
      );
    }
  }

  function scheduleNext(): void {
    const lastRun = readLastRunAt();
    const now = Date.now();
    let nextDue: number;

    if (lastRun) {
      nextDue = new Date(lastRun).getTime() + intervalMs;
      if (nextDue <= now) {
        nextDue = now + bootDelayMs;
      }
    } else {
      nextDue = now + bootDelayMs;
    }

    const delayMs = Math.max(nextDue - now, bootDelayMs);
    setTimeout(async () => {
      await runPersonalityExtraction();
      scheduleNext();
    }, delayMs);

    console.log(
      `[second-brain] personality extraction scheduled in ${Math.round(delayMs / 1000)}s`,
    );
  }

  scheduleNext();
}
