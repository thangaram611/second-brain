import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createJsonlTail } from '../watch/jsonl-tail.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('createJsonlTail', () => {
  it('emits lines appended after startup', async () => {
    const file = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(file, '');
    const received: unknown[] = [];
    const handle = createJsonlTail({
      filePath: file,
      pollIntervalMs: 50,
      onLine: (value) => {
        received.push(value);
      },
    });

    fs.appendFileSync(file, JSON.stringify({ a: 1 }) + '\n');
    await wait(150);
    fs.appendFileSync(file, JSON.stringify({ b: 2 }) + '\n');
    await wait(150);

    handle.close();
    expect(received).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('tolerates partial lines — waits for newline before parsing', async () => {
    const file = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(file, '');
    const received: unknown[] = [];
    const handle = createJsonlTail({
      filePath: file,
      pollIntervalMs: 50,
      onLine: (value) => {
        received.push(value);
      },
    });

    fs.appendFileSync(file, '{"partia');
    await wait(120);
    expect(received).toHaveLength(0);
    fs.appendFileSync(file, 'l":1}\n');
    await wait(150);

    handle.close();
    expect(received).toEqual([{ partial: 1 }]);
  });

  it('persists offset so a restart resumes where we left off', async () => {
    const file = path.join(tmp, 'events.jsonl');
    const offsetFile = path.join(tmp, 'offsets.json');
    fs.writeFileSync(file, JSON.stringify({ a: 1 }) + '\n');

    const recv1: unknown[] = [];
    const h1 = createJsonlTail({
      filePath: file,
      persistOffsetPath: offsetFile,
      pollIntervalMs: 50,
      onLine: (v) => {
        recv1.push(v);
      },
    });
    await wait(150);
    h1.close();
    expect(recv1).toEqual([{ a: 1 }]);

    fs.appendFileSync(file, JSON.stringify({ b: 2 }) + '\n');

    const recv2: unknown[] = [];
    const h2 = createJsonlTail({
      filePath: file,
      persistOffsetPath: offsetFile,
      pollIntervalMs: 50,
      onLine: (v) => {
        recv2.push(v);
      },
    });
    await wait(200);
    h2.close();
    // Should only see the newly-appended line.
    expect(recv2).toEqual([{ b: 2 }]);
  });

  it('handles file rotation (inode change) by replaying from 0 on new inode', async () => {
    const file = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(file, JSON.stringify({ a: 1 }) + '\n');

    const received: unknown[] = [];
    const handle = createJsonlTail({
      filePath: file,
      pollIntervalMs: 50,
      onLine: (v) => {
        received.push(v);
      },
    });
    await wait(150);

    // Simulate rotation: rename + recreate.
    fs.renameSync(file, file + '.1');
    fs.writeFileSync(file, JSON.stringify({ c: 3 }) + '\n');
    await wait(200);

    handle.close();
    expect(received).toEqual([{ a: 1 }, { c: 3 }]);
  });
});
