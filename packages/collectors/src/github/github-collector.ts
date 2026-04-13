import { Octokit } from '@octokit/rest';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { Collector, ExtractionResult, PendingRelation, PipelineConfig, LLMExtractor } from '@second-brain/ingestion';
import { withRetry } from '@second-brain/ingestion';
import { GitHubPRSchema, GitHubIssueSchema } from './github-types.js';
import type { GitHubPR, GitHubIssue } from './github-types.js';

export interface GitHubCollectorOptions {
  /** Repository in 'owner/repo' format — required. */
  repo: string;
  /** GitHub PAT; falls back to process.env.GITHUB_TOKEN. */
  token?: string;
  /** Maximum PRs to fetch. Default 50. */
  maxPRs?: number;
  /** Maximum issues to fetch. Default 50. */
  maxIssues?: number;
  /** Filter by state. Default 'all'. */
  state?: 'open' | 'closed' | 'all';
  /** If provided, used on PR descriptions for decision extraction. */
  extractor?: LLMExtractor;
}

function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${repo}". Expected "owner/repo".`);
  }
  return { owner: parts[0], name: parts[1] };
}

export class GitHubCollector implements Collector {
  readonly name = 'github';
  private options: Required<Pick<GitHubCollectorOptions, 'maxPRs' | 'maxIssues' | 'state'>> &
    GitHubCollectorOptions;

  constructor(options: GitHubCollectorOptions) {
    this.options = {
      maxPRs: 50,
      maxIssues: 50,
      state: 'all',
      ...options,
    };
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const { owner, name } = parseRepo(this.options.repo);
    const token = this.options.token ?? process.env.GITHUB_TOKEN;
    const octokit = new Octokit({ auth: token });

    const entities: CreateEntityInput[] = [];
    const relations: PendingRelation[] = [];
    const seenPersons = new Set<string>();

    const repoSlug = this.options.repo;
    const source: EntitySource = { type: 'github', ref: repoSlug, actor: 'github' };

    const addPerson = (login: string): void => {
      if (seenPersons.has(login)) return;
      seenPersons.add(login);
      entities.push({
        type: 'person',
        name: login,
        namespace: config.namespace,
        observations: [],
        properties: { login },
        source: { type: 'github', ref: repoSlug, actor: login },
        tags: ['github'],
      });
    };

    // ── Fetch PRs ──
    try {
      const perPage = Math.min(this.options.maxPRs, 100);
      const { data: rawPRs } = await withRetry(
        () =>
          octokit.pulls.list({
            owner,
            repo: name,
            state: this.options.state,
            per_page: perPage,
            sort: 'updated',
            direction: 'desc',
          }),
        { onRetry: (_, attempt, delay) => reportRetry(config, this.name, 'PRs', attempt, delay) },
      );

      const prs = rawPRs.slice(0, this.options.maxPRs);

      for (let i = 0; i < prs.length; i++) {
        const parsed = GitHubPRSchema.safeParse(prs[i]);
        if (!parsed.success) continue;
        const pr: GitHubPR = parsed.data;

        const prName = `${repoSlug}#${pr.number}: ${pr.title}`;
        entities.push({
          type: 'reference',
          name: prName,
          namespace: config.namespace,
          observations: pr.body ? [pr.body.slice(0, 500)] : [],
          properties: { number: pr.number, state: pr.state, mergedAt: pr.merged_at, repo: repoSlug },
          source: { type: 'github', ref: pr.html_url, actor: 'github' },
          tags: ['github', 'pull-request'],
        });

        // Author
        if (pr.user?.login) {
          addPerson(pr.user.login);
          relations.push({
            type: 'authored_by',
            sourceName: prName,
            sourceType: 'reference',
            targetName: pr.user.login,
            targetType: 'person',
            namespace: config.namespace,
            source: { type: 'github', ref: pr.html_url },
          });
        }

        // Merge event
        if (pr.merged_at) {
          const mergeName = `Merge: ${repoSlug}#${pr.number}`;
          entities.push({
            type: 'event',
            name: mergeName,
            namespace: config.namespace,
            observations: [],
            properties: { mergedAt: pr.merged_at, repo: repoSlug },
            eventTime: pr.merged_at,
            source: { type: 'github', ref: pr.html_url, actor: 'github' },
            tags: ['github', 'merge'],
          });
        }

        // LLM extraction on long PR bodies
        if (this.options.extractor && pr.body && pr.body.length > 200) {
          try {
            const extracted = await this.options.extractor.extract(pr.body, {
              namespace: config.namespace,
              source: { type: 'github', ref: pr.html_url, actor: 'github' },
            });
            entities.push(...extracted.entities);
            relations.push(...extracted.relations);

            // Link decisions back to the PR
            for (const e of extracted.entities) {
              if (e.type === 'decision') {
                relations.push({
                  type: 'decided_in',
                  sourceName: e.name,
                  sourceType: 'decision',
                  targetName: prName,
                  targetType: 'reference',
                  namespace: config.namespace,
                  source: { type: 'github', ref: pr.html_url },
                });
              }
            }
          } catch {
            // Extraction failure shouldn't break the run
          }
        }

        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: i + 1,
          total: prs.length,
          message: `PR #${pr.number}`,
        });
      }
    } catch (err: unknown) {
      if (isRequestError(err)) {
        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: 0,
          total: 0,
          message: `GitHub API error fetching PRs: ${err.status} ${err.message}`,
        });
      } else {
        throw err;
      }
    }

    // ── Fetch Issues (filter out PRs) ──
    try {
      const perPage = Math.min(this.options.maxIssues, 100);
      const { data: rawIssues } = await withRetry(
        () =>
          octokit.issues.listForRepo({
            owner,
            repo: name,
            state: this.options.state,
            per_page: perPage,
            sort: 'updated',
            direction: 'desc',
          }),
        { onRetry: (_, attempt, delay) => reportRetry(config, this.name, 'issues', attempt, delay) },
      );

      // Filter out pull requests (issues.listForRepo returns both)
      const issueOnly = rawIssues
        .filter((item) => !('pull_request' in item && item.pull_request))
        .slice(0, this.options.maxIssues);

      for (let i = 0; i < issueOnly.length; i++) {
        const parsed = GitHubIssueSchema.safeParse(issueOnly[i]);
        if (!parsed.success) continue;
        const issue: GitHubIssue = parsed.data;

        const issueName = `${repoSlug}#${issue.number}: ${issue.title}`;
        const labelNames = issue.labels.map((l) => l.name);

        entities.push({
          type: 'reference',
          name: issueName,
          namespace: config.namespace,
          observations: issue.body ? [issue.body.slice(0, 500)] : [],
          properties: { number: issue.number, state: issue.state, repo: repoSlug, labels: labelNames },
          source: { type: 'github', ref: issue.html_url, actor: 'github' },
          tags: ['github', 'issue', ...labelNames],
        });

        // Author
        if (issue.user?.login) {
          addPerson(issue.user.login);
          relations.push({
            type: 'authored_by',
            sourceName: issueName,
            sourceType: 'reference',
            targetName: issue.user.login,
            targetType: 'person',
            namespace: config.namespace,
            source: { type: 'github', ref: issue.html_url },
          });
        }

        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: i + 1,
          total: issueOnly.length,
          message: `Issue #${issue.number}`,
        });
      }
    } catch (err: unknown) {
      if (isRequestError(err)) {
        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: 0,
          total: 0,
          message: `GitHub API error fetching issues: ${err.status} ${err.message}`,
        });
      } else {
        throw err;
      }
    }

    return { entities, relations };
  }
}

/** Duck-type check for Octokit's RequestError (avoids importing the package). */
function isRequestError(err: unknown): err is { status: number; message: string } {
  return (
    err instanceof Error &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  );
}

function reportRetry(
  config: PipelineConfig,
  collector: string,
  label: string,
  attempt: number,
  delay: number,
): void {
  config.onProgress?.({
    stage: 'collecting',
    collector,
    current: 0,
    total: 0,
    message: `Retrying ${label} (attempt ${attempt}, sleeping ${Math.round(delay)}ms)`,
  });
}
