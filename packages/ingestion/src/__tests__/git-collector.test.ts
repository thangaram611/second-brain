import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { simpleGit } from 'simple-git';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitCollector } from '../git/git-collector.js';
import type { PipelineConfig } from '../pipeline/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-git-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    namespace: 'test',
    repoPath: tmpDir,
    ignorePatterns: ['node_modules', 'dist'],
    ...overrides,
  };
}

describe('GitCollector', () => {
  it('extracts entities from a git repo', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.email', 'alice@test.com');
    await git.addConfig('user.name', 'Alice');

    // Create a file and commit
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'console.log("hello")');
    await git.add('index.ts');
    await git.commit('initial commit');

    const collector = new GitCollector({ maxCommits: 10 });
    const result = await collector.collect(makeConfig());

    // Should have at least: 1 person, 1 event, 1 file
    const personEntities = result.entities.filter((e) => e.type === 'person');
    const eventEntities = result.entities.filter((e) => e.type === 'event');
    const fileEntities = result.entities.filter((e) => e.type === 'file');

    expect(personEntities.length).toBeGreaterThanOrEqual(1);
    expect(personEntities[0].name).toBe('Alice');

    expect(eventEntities.length).toBeGreaterThanOrEqual(1);
    expect(eventEntities[0].observations?.[0]).toBe('initial commit');

    expect(fileEntities.length).toBeGreaterThanOrEqual(1);
    expect(fileEntities[0].name).toBe('index.ts');
  });

  it('creates authored_by and contains relations', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.email', 'bob@test.com');
    await git.addConfig('user.name', 'Bob');

    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export {}');
    await git.add('app.ts');
    await git.commit('add app');

    const collector = new GitCollector({ maxCommits: 10 });
    const result = await collector.collect(makeConfig());

    const authoredBy = result.relations.filter((r) => r.type === 'authored_by');
    expect(authoredBy.length).toBeGreaterThanOrEqual(1);
    expect(authoredBy[0].targetName).toBe('Bob');

    const contains = result.relations.filter((r) => r.type === 'contains');
    expect(contains.length).toBeGreaterThanOrEqual(1);
  });

  it('detects co-changes across commits', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.email', 'alice@test.com');
    await git.addConfig('user.name', 'Alice');

    // Two commits that both change fileA and fileB
    fs.writeFileSync(path.join(tmpDir, 'fileA.ts'), 'v1');
    fs.writeFileSync(path.join(tmpDir, 'fileB.ts'), 'v1');
    await git.add('.');
    await git.commit('commit 1');

    fs.writeFileSync(path.join(tmpDir, 'fileA.ts'), 'v2');
    fs.writeFileSync(path.join(tmpDir, 'fileB.ts'), 'v2');
    await git.add('.');
    await git.commit('commit 2');

    const collector = new GitCollector({ maxCommits: 10 });
    const result = await collector.collect(makeConfig());

    const coChanges = result.relations.filter((r) => r.type === 'co_changes_with');
    expect(coChanges.length).toBeGreaterThanOrEqual(1);
    // Weight should be min(1.0, 2/10) = 0.2
    expect(coChanges[0].weight).toBe(0.2);
  });

  it('deduplicates person entities across commits', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.email', 'alice@test.com');
    await git.addConfig('user.name', 'Alice');

    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'v1');
    await git.add('.');
    await git.commit('first');

    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'v1');
    await git.add('.');
    await git.commit('second');

    const collector = new GitCollector({ maxCommits: 10 });
    const result = await collector.collect(makeConfig());

    const persons = result.entities.filter((e) => e.type === 'person');
    expect(persons).toHaveLength(1);
  });

  it('respects ignore patterns', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.email', 'alice@test.com');
    await git.addConfig('user.name', 'Alice');

    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'ignored');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'kept');
    await git.add('.');
    await git.commit('with ignored files');

    const collector = new GitCollector({ maxCommits: 10 });
    const result = await collector.collect(makeConfig());

    const files = result.entities.filter((e) => e.type === 'file');
    const fileNames = files.map((f) => f.name);
    expect(fileNames).toContain('app.ts');
    expect(fileNames).not.toContain('node_modules/pkg.js');
  });
});
