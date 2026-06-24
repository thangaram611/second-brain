import { describe, it, expect } from 'vitest';
import { upsertSentinelDedup, removeSentinelEntries, upsertSentinelBlock } from '../sentinel.js';
import { HOOK_SENTINEL } from '../../types.js';

interface Entry {
  command: string;
}

describe('upsertSentinelDedup', () => {
  it('appends a fresh entry when the list is empty (changed)', () => {
    const list: Entry[] = [];
    const desired = `brain-hook stop --adapter claude ${HOOK_SENTINEL}`;
    const { changed } = upsertSentinelDedup(list, desired, (command) => ({ command }));
    expect(changed).toBe(true);
    expect(list).toEqual([{ command: desired }]);
  });

  it('rewrites a stale sentinel command in place (changed)', () => {
    const list: Entry[] = [{ command: `brain-hook stop --adapter claude ${HOOK_SENTINEL}` }];
    const desired = `/abs/brain-hook stop --adapter claude ${HOOK_SENTINEL}`;
    const { changed } = upsertSentinelDedup(list, desired, (command) => ({ command }));
    expect(changed).toBe(true);
    expect(list).toEqual([{ command: desired }]);
  });

  it('is idempotent — an exact match produces no change', () => {
    const desired = `brain-hook stop --adapter claude ${HOOK_SENTINEL}`;
    const list: Entry[] = [{ command: desired }];
    const { changed } = upsertSentinelDedup(list, desired, (command) => ({ command }));
    expect(changed).toBe(false);
    expect(list).toEqual([{ command: desired }]);
  });
});

describe('removeSentinelEntries', () => {
  it('drops only sentinel-carrying entries', () => {
    const list: Entry[] = [
      { command: 'user-custom-hook' },
      { command: `brain-hook stop --adapter claude ${HOOK_SENTINEL}` },
    ];
    const { list: kept, removed } = removeSentinelEntries(list);
    expect(removed).toBe(true);
    expect(kept).toEqual([{ command: 'user-custom-hook' }]);
  });
});

describe('upsertSentinelBlock', () => {
  it('inserts a block into empty content with default markers', () => {
    const out = upsertSentinelBlock('', 'hello');
    expect(out).toContain('<!-- begin:second-brain -->');
    expect(out).toContain('hello');
    expect(out).toContain('<!-- end:second-brain -->');
  });

  it('replaces an existing block, preserving surrounding content', () => {
    const initial = '# Title\n\n<!-- begin:second-brain -->\nold\n<!-- end:second-brain -->\n';
    const out = upsertSentinelBlock(initial, 'fresh');
    expect(out).toContain('# Title');
    expect(out).toContain('fresh');
    expect(out).not.toContain('old');
  });
});
