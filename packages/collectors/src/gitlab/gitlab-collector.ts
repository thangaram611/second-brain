/**
 * Legacy one-shot GitLab collector — predates Phase 10.3's
 * `GitLabProvider` webhook pipeline. Still exported for external users
 * of `@second-brain/collectors`; not called by the server / CLI runtime.
 *
 * Writes MRs as `type='reference'` with name `${project}!${iid}: ${title}`.
 * Phase 10.3+ writes `type='merge_request'` via the new provider path,
 * so the two entity shapes never co-exist for a given repo in practice.
 * Do NOT call this from new code — use `GitLabProvider` instead.
 */
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type {
  Collector,
  ExtractionResult,
  PendingRelation,
  PipelineConfig,
  LLMExtractor,
} from '@second-brain/ingestion';
import { withRetry } from '@second-brain/ingestion';
import {
  GitLabMergeRequestSchema,
  GitLabIssueSchema,
  labelName,
  type GitLabMergeRequest,
  type GitLabIssue,
} from './gitlab-types.js';

export interface GitLabCollectorOptions {
  /** Project in 'group/project' or 'group/subgroup/project' format — required. */
  project: string;
  /** GitLab PAT; falls back to process.env.GITLAB_TOKEN. */
  token?: string;
  /** Base URL for self-hosted (e.g. 'https://gitlab.example.com/api/v4'). Default 'https://gitlab.com/api/v4'. */
  baseUrl?: string;
  /** Maximum merge requests to fetch. Default 50. */
  maxMRs?: number;
  /** Maximum issues to fetch. Default 50. */
  maxIssues?: number;
  /** Filter MRs by state: 'opened' | 'closed' | 'merged' | 'all'. Default 'all'. */
  mrState?: 'opened' | 'closed' | 'merged' | 'all';
  /** Filter issues by state: 'opened' | 'closed' | 'all'. Default 'all'. */
  issueState?: 'opened' | 'closed' | 'all';
  /** If provided, used on MR descriptions for decision extraction. */
  extractor?: LLMExtractor;
  /** Override the fetch implementation (primarily for tests). */
  fetchImpl?: typeof fetch;
}

export class GitLabCollector implements Collector {
  readonly name = 'gitlab';
  private readonly project: string;
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly maxMRs: number;
  private readonly maxIssues: number;
  private readonly mrState: NonNullable<GitLabCollectorOptions['mrState']>;
  private readonly issueState: NonNullable<GitLabCollectorOptions['issueState']>;
  private readonly extractor: LLMExtractor | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitLabCollectorOptions) {
    this.project = options.project;
    this.token = options.token ?? process.env.GITLAB_TOKEN;
    this.baseUrl = (options.baseUrl ?? 'https://gitlab.com/api/v4').replace(/\/$/, '');
    this.maxMRs = options.maxMRs ?? 50;
    this.maxIssues = options.maxIssues ?? 50;
    this.mrState = options.mrState ?? 'all';
    this.issueState = options.issueState ?? 'all';
    this.extractor = options.extractor;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private projectPath(): string {
    return encodeURIComponent(this.project);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.token) h['PRIVATE-TOKEN'] = this.token;
    return h;
  }

  private async fetchJson(url: string, onProgress?: PipelineConfig['onProgress'], label = 'request'): Promise<unknown> {
    return withRetry(
      async () => {
        const res = await this.fetchImpl(url, { headers: this.headers() });
        if (!res.ok) {
          throw Object.assign(new Error(`GitLab API ${res.status} for ${url}`), {
            status: res.status,
          });
        }
        return res.json();
      },
      {
        onRetry: (_, attempt, delay) => {
          onProgress?.({
            stage: 'collecting',
            collector: this.name,
            current: 0,
            total: 0,
            message: `Retrying ${label} (attempt ${attempt}, sleeping ${Math.round(delay)}ms)`,
          });
        },
      },
    );
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const entities: CreateEntityInput[] = [];
    const relations: PendingRelation[] = [];
    const seenPersons = new Set<string>();

    const source: EntitySource = { type: 'gitlab', ref: this.project, actor: 'gitlab' };

    const addPerson = (username: string): void => {
      if (seenPersons.has(username)) return;
      seenPersons.add(username);
      entities.push({
        type: 'person',
        name: username,
        namespace: config.namespace,
        observations: [],
        properties: { username },
        source: { type: 'gitlab', ref: this.project, actor: username },
        tags: ['gitlab'],
      });
    };

    // ── Fetch merge requests ──
    try {
      const perPage = Math.min(this.maxMRs, 100);
      const mrUrl =
        `${this.baseUrl}/projects/${this.projectPath()}/merge_requests` +
        `?state=${this.mrState}&order_by=updated_at&sort=desc&per_page=${perPage}`;
      const raw = await this.fetchJson(mrUrl, config.onProgress, 'MRs');
      if (!Array.isArray(raw)) throw new Error('Expected array from GitLab MRs endpoint');
      const mrs = raw
        .map((r) => GitLabMergeRequestSchema.safeParse(r))
        .flatMap((p) => (p.success ? [p.data] : []))
        .slice(0, this.maxMRs);

      for (let i = 0; i < mrs.length; i++) {
        const mr = mrs[i];
        const mrName = `${this.project}!${mr.iid}: ${mr.title}`;
        const labelNames = (mr.labels ?? []).map(labelName);

        entities.push({
          type: 'reference',
          name: mrName,
          namespace: config.namespace,
          observations: mr.description ? [mr.description.slice(0, 500)] : [],
          properties: {
            number: mr.iid,
            state: mr.state,
            mergedAt: mr.merged_at ?? null,
            project: this.project,
          },
          source: { type: 'gitlab', ref: mr.web_url, actor: 'gitlab' },
          tags: ['gitlab', 'merge-request', ...labelNames],
        });

        if (mr.author?.username) {
          addPerson(mr.author.username);
          relations.push({
            type: 'authored_by',
            sourceName: mrName,
            sourceType: 'reference',
            targetName: mr.author.username,
            targetType: 'person',
            namespace: config.namespace,
            source: { type: 'gitlab', ref: mr.web_url },
          });
        }

        if (mr.merged_at) {
          const mergeName = `Merge: ${this.project}!${mr.iid}`;
          entities.push({
            type: 'event',
            name: mergeName,
            namespace: config.namespace,
            observations: [],
            properties: { mergedAt: mr.merged_at, project: this.project },
            eventTime: mr.merged_at,
            source: { type: 'gitlab', ref: mr.web_url, actor: 'gitlab' },
            tags: ['gitlab', 'merge'],
          });
        }

        if (this.extractor && mr.description && mr.description.length > 200) {
          try {
            const extracted = await this.extractor.extract(mr.description, {
              namespace: config.namespace,
              source: { type: 'gitlab', ref: mr.web_url, actor: 'gitlab' },
            });
            entities.push(...extracted.entities);
            relations.push(...extracted.relations);

            for (const e of extracted.entities) {
              if (e.type === 'decision') {
                relations.push({
                  type: 'decided_in',
                  sourceName: e.name,
                  sourceType: 'decision',
                  targetName: mrName,
                  targetType: 'reference',
                  namespace: config.namespace,
                  source: { type: 'gitlab', ref: mr.web_url },
                });
              }
            }
          } catch {
            // Extraction failure shouldn't break the run.
          }
        }

        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: i + 1,
          total: mrs.length,
          message: `MR !${mr.iid}`,
        });
      }
    } catch (err: unknown) {
      if (isHttpError(err)) {
        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: 0,
          total: 0,
          message: `GitLab API error fetching MRs: ${err.status} ${err.message}`,
        });
      } else {
        throw err;
      }
    }

    // ── Fetch issues ──
    try {
      const perPage = Math.min(this.maxIssues, 100);
      const issueUrl =
        `${this.baseUrl}/projects/${this.projectPath()}/issues` +
        `?state=${this.issueState}&order_by=updated_at&sort=desc&per_page=${perPage}`;
      const raw = await this.fetchJson(issueUrl, config.onProgress, 'issues');
      if (!Array.isArray(raw)) throw new Error('Expected array from GitLab issues endpoint');
      const issues = raw
        .map((r) => GitLabIssueSchema.safeParse(r))
        .flatMap((p) => (p.success ? [p.data] : []))
        .slice(0, this.maxIssues);

      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        const issueName = `${this.project}#${issue.iid}: ${issue.title}`;
        const labelNames = (issue.labels ?? []).map(labelName);

        entities.push({
          type: 'reference',
          name: issueName,
          namespace: config.namespace,
          observations: issue.description ? [issue.description.slice(0, 500)] : [],
          properties: {
            number: issue.iid,
            state: issue.state,
            project: this.project,
            labels: labelNames,
          },
          source: { type: 'gitlab', ref: issue.web_url, actor: 'gitlab' },
          tags: ['gitlab', 'issue', ...labelNames],
        });

        if (issue.author?.username) {
          addPerson(issue.author.username);
          relations.push({
            type: 'authored_by',
            sourceName: issueName,
            sourceType: 'reference',
            targetName: issue.author.username,
            targetType: 'person',
            namespace: config.namespace,
            source: { type: 'gitlab', ref: issue.web_url },
          });
        }

        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: i + 1,
          total: issues.length,
          message: `Issue #${issue.iid}`,
        });
      }
    } catch (err: unknown) {
      if (isHttpError(err)) {
        config.onProgress?.({
          stage: 'collecting',
          collector: this.name,
          current: 0,
          total: 0,
          message: `GitLab API error fetching issues: ${err.status} ${err.message}`,
        });
      } else {
        throw err;
      }
    }

    return { entities, relations };
  }
}

function isHttpError(err: unknown): err is { status: number; message: string } {
  return (
    err instanceof Error &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  );
}
