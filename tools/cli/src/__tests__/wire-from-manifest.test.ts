import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runWireFromManifest } from '../wire.js';
import type { TeamManifest } from '../team-manifest.js';

let repo: string;
let prevHome: string | undefined;
let homeOverride: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-mfst-'));
  homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = homeOverride;
  // Initialize a real git repo so the git-hooks installer has somewhere to write.
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(homeOverride, { recursive: true, force: true });
});

const MANIFEST: TeamManifest = {
  version: 1,
  namespace: 'team-graph',
  server: { url: 'http://localhost:7430' },
  hooks: {
    git: ['post-commit'],
    assistants: ['claude'],
    scope: 'user',
  },
  providers: { github: { owner: 'acme', repo: 'graph', webhookManagedBy: 'admin' } },
};

describe('runWireFromManifest', () => {
  it('installs git hooks listed in manifest, adapter hooks, and snapshots wired-repos', async () => {
    const result = await runWireFromManifest({
      repoRoot: repo,
      manifest: MANIFEST,
    });
    expect(result.namespace).toBe('team-graph');
    expect(result.installedAssistants).toContain('claude');
    expect(result.installedGitHooks).not.toBeNull();
    expect(result.installedGitHooks!.installed).toContain('post-commit');
    // Provider webhook admin-managed → skipped.
    expect(result.providerSkipped?.provider).toBe('github');
    expect(result.providerSkipped?.reason).toBe('admin-managed');
    // git hook file exists with our sentinel
    const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain('Installed by second-brain');
  });

  it('is idempotent — repeated calls do not duplicate hooks or sidecars', async () => {
    await runWireFromManifest({ repoRoot: repo, manifest: MANIFEST });
    await runWireFromManifest({ repoRoot: repo, manifest: MANIFEST });
    const hooks = fs.readdirSync(path.join(repo, '.git', 'hooks'));
    // Exactly one post-commit, plus possibly the sample.
    const ours = hooks.filter((h) => h === 'post-commit');
    expect(ours).toHaveLength(1);
  });

  it('loads from disk when manifest is omitted', async () => {
    const dir = path.join(repo, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(MANIFEST));
    const result = await runWireFromManifest({ repoRoot: repo });
    expect(result.namespace).toBe('team-graph');
  });

  it('throws clearly when manifest is missing or invalid', async () => {
    await expect(
      runWireFromManifest({ repoRoot: repo }),
    ).rejects.toThrow(/cannot wire from manifest/);
  });

  it('skips git hooks when not a git repo', async () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-nogit-'));
    try {
      const result = await runWireFromManifest({
        repoRoot: noGit,
        manifest: MANIFEST,
      });
      expect(result.installedGitHooks).toBeNull();
      expect(result.warnings.some((w) => w.includes('not a git repo'))).toBe(true);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  it('skips git hooks entirely when manifest lists none', async () => {
    const m: TeamManifest = { ...MANIFEST, hooks: { git: [], assistants: ['claude'], scope: 'user' } };
    const result = await runWireFromManifest({ repoRoot: repo, manifest: m });
    expect(result.installedGitHooks).toBeNull();
  });
});
