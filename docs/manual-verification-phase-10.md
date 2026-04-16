# Manual verification — Phase 10

Sub-phase checklists for things not covered by unit / integration tests (i.e.
anything that touches a real filesystem, real git, real launchd, or a real
provider). Automated tests give us functional coverage — this doc is for the
sensory-grounded checks an engineer runs once before tagging a release.

## 10.2 — `flipBranchStatus`, `find_parallel_work`, post-merge hook

Pre-reqs: Phase 10.1 `brain wire` completed against a local repo; server
running at `http://localhost:7430`; `brain watch` daemon is up.

1. **WIP baseline.** `git checkout -b feat/foo`, edit a file under the wired
   repo, save.
   ```
   brain recall --query <file-basename>
   ```
   Expected: an entity with `branchContext.status='wip'`, `branch='feat/foo'`.

2. **Local merge flips status.** `git checkout main && git merge feat/foo`
   (or use `--no-ff` to force a merge commit; both paths exercised).
   Within 1s, run the same recall — `branchContext.status='merged'`,
   `mergedAt` populated, `mrIid=null` (local merge has no MR yet).

3. **Fast-forward merge flips status.** On a fresh branch `feat/bar` that is
   ahead of main, `git checkout main && git merge feat/bar`. Reflog subject is
   `merge feat/bar: Fast-forward` — verify the flip ran.

4. **No-op merge returns 201.** Merge a branch whose entities have never been
   observed (e.g. the hook was off when you edited on it): the POST still
   returns 201; `branch_flips_total` stays 0.

5. **Parallel-work detection (single-machine sim).** In the wired repo, use
   the CLI to simulate two actors on different branches touching the same
   file:
   ```
   # as alice, on feat/a
   SECOND_BRAIN_TOKEN=... curl -s http://localhost:7430/api/observe/file-change \
     -H 'content-type: application/json' \
     -d '{"repo":"'"$PWD"'","namespace":"proj","branch":"feat/a", \
          "author":{"canonicalEmail":"alice@x","aliases":[]}, \
          "changes":[{"path":"src/shared.ts","kind":"change","mtime":"2026-04-13T10:00:00Z"}], \
          "batchedAt":"2026-04-13T10:00:05Z","idempotencyKey":"a-1"}'
   # as bob, on feat/b (same file)
   # ... author bob@x, branch feat/b, idempotencyKey b-1
   ```
   Then:
   ```
   brain mcp call find_parallel_work
   ```
   Expected: one row for `src/shared.ts` with both actors and both branches.

6. **Alert surfaces inside recall.** Same state as step 5:
   ```
   brain mcp call recall_session_context --includeParallelWork true
   ```
   Expected: output begins with a `<parallel-work-alert>` block naming the
   file, both actors, both branches, before the regular `## Prior context`
   section.

7. **Manual escape hatch.** After the merge in step 2, if the hook missed:
   ```
   brain flip-branch feat/foo --status merged --merged-at 2026-04-13T10:00:00Z
   ```
   Expected: prints `Flipped "feat/foo" → merged. entities=N relations=M`.
   Subsequent `brain recall` shows merged status.

8. **Abandoned branch.** Create a branch, edit, then delete without merging:
   ```
   brain flip-branch feat/dead --status abandoned
   ```
   Expected: all entities on feat/dead transition to `status='abandoned'`;
   `find_parallel_work` no longer surfaces them.

Ship-blockers: **any step 1-4 failure.** Steps 5-8 are feature-verification
and can be waived for a manual regression run.

## 10.3 — GitLab provider, webhook auto-register, MR entities

Pre-reqs: VPN up; `git.csez.zohocorpin.com` (or gitlab.com) reachable; a
test project the user owns; `brain serve` running at `http://localhost:7430`;
`brain watch` daemon running against the repo after wire completes.

1. **Fresh wire.** In a repo with a `git remote` pointing at the GitLab
   instance, run:
   ```
   brain wire --provider gitlab --gitlab-url https://git.csez.zohocorpin.com \
              --gitlab-token glpat-xxx --namespace myproj
   ```
   Expected stdout: `provider: gitlab projectId=<N> hook=<N>`; the smee.io
   channel URL is printed. Confirm in GitLab UI *Settings → Webhooks*:
   one entry pointing at the smee URL, scoped to `merge_requests_events`
   + `note_events` + `pipeline_events`.
2. **Live MR open.** Push a branch, open an MR in the GitLab UI. Within
   30 s, `brain mcp call recall_session_context --query "<mr-title>"`
   returns the `merge_request` entity with `properties.iid`,
   `properties.projectId`, `properties.webUrl`, `authored_by` edge to
   the `person` entity, `touches_file` edges for each path.
3. **Comment round-trip.** Add a comment in GitLab UI. Within 30 s,
   `brain mcp call get_observations_by_ids --ids <mr-id>` shows the
   comment body appended to the MR entity's observations.
4. **Approve.** Click Approve. Within 30 s a `review` entity exists with
   `reviewed_by` → reviewer person, `relates_to` → MR.
5. **Merge.** Merge via GitLab UI. Within 30 s, `brain recall --query
   <source-branch>` shows every entity+relation tagged with that branch
   now has `branchContext.status='merged'` and `mrIid=<iid>`;
   `find_parallel_work` no longer lists them.
6. **Replay guard.** In GitLab UI *Webhooks → Edit → Test* fire the
   merge event again. Response: 201. `counters.mr_events_deduped`
   bumps by 1; no duplicate flip.
7. **Concurrent wire lock.** In two shells, invoke `brain wire`
   simultaneously. Exactly one succeeds; the other prints
   `another wire operation is in progress (pid X)` and exits non-zero.
8. **Unwire.** Happy path: `brain unwire`; in GitLab UI the webhook is
   gone; `security find-generic-password -s second-brain -a
   gitlab.pat:<host>` returns "not found"; `~/.second-brain/config.json`
   no longer lists this repo. Historical MR entities remain recallable.
9. **Unwire --force.** Simulate expired PAT by revoking it; `brain
   unwire` without `--force` exits non-zero with actionable error;
   `brain unwire --force` succeeds with a warning naming the webhook id
   to delete manually.

Ship-blockers: **steps 2, 5, 6, and 8.** Others are feature-verification
and can be waived for a manual regression run.

## 10.4 — Personal namespace export/import/stats CLI

Pre-reqs: `brain init` completed; some personal-namespace entities exist
(e.g. from a prior `brain ingest --source personality` or manual insertion);
`brain` CLI is on `$PATH`.

1. **Stats baseline.** Run:
   ```
   brain personal stats
   ```
   Expected: prints `Personal namespace stats:` with entity/relation counts,
   per-source-type breakdown, and per-personality-stream breakdown.

2. **Stats JSON mode.** Run:
   ```
   brain personal stats --json
   ```
   Expected: valid JSON with `stats`, `sourceTypes`, `streams` fields.

3. **Stats audit.** Run:
   ```
   brain personal stats --audit
   ```
   Expected: lists every personality entity with `[streamName] name (type,
   conf=X.XX, derived_from=N)` format.

4. **Plain export.** Run:
   ```
   brain personal export -o personal-backup.json
   ```
   Expected: file written; prints entity/relation/dangling counts;
   `cat personal-backup.json | jq .version` → `"1.0"`.

5. **Export JSON mode.** Run:
   ```
   brain personal export -o personal-backup.json --json
   ```
   Expected: single-line JSON with `entities`, `relations`,
   `danglingEdges`, `file`, `encrypted` fields.

6. **Encrypted export.** Run:
   ```
   brain personal export -o personal-backup.enc --encrypt
   ```
   Expected: prompts for passphrase twice; mismatched passphrases print
   `Passphrases do not match.` and exit non-zero; matching passphrases
   write a binary file beginning with `SBP1` magic bytes.

7. **Plain import into fresh brain.** Run:
   ```
   BRAIN_DB_PATH=./test-import.db brain init
   BRAIN_DB_PATH=./test-import.db brain personal import personal-backup.json
   ```
   Expected: prints `Imported N entities, M relations`.

8. **Import JSON mode.** Run:
   ```
   BRAIN_DB_PATH=./test-import2.db brain init
   BRAIN_DB_PATH=./test-import2.db brain personal import personal-backup.json --json
   ```
   Expected: valid JSON with `entitiesImported`, `relationsImported`,
   `droppedDanglingEdges`, `conflicts` fields.

9. **Encrypted import.** Run:
   ```
   BRAIN_DB_PATH=./test-enc.db brain init
   BRAIN_DB_PATH=./test-enc.db brain personal import personal-backup.enc
   ```
   Expected: prompts for passphrase; correct passphrase imports
   successfully; wrong passphrase prints `Decryption failed. Wrong
   passphrase?` and exits non-zero.

10. **Round-trip fidelity.** Compare stats before export and after import:
    ```
    brain personal stats --json > before.json
    BRAIN_DB_PATH=./test-rt.db brain init
    BRAIN_DB_PATH=./test-rt.db brain personal import personal-backup.json
    BRAIN_DB_PATH=./test-rt.db brain personal stats --json > after.json
    ```
    Expected: `totalEntities` and `totalRelations` match between
    `before.json` and `after.json`.

11. **Dangling edge handling.** If the export contains cross-namespace
    dangling edges (visible in `danglingEdges` count from step 5), import
    without `--reattach` drops them:
    ```
    BRAIN_DB_PATH=./test-dangle.db brain init
    BRAIN_DB_PATH=./test-dangle.db brain personal import personal-backup.json
    ```
    Expected: prints `Dropped N dangling edges (use --reattach to keep)`.

Ship-blockers: **steps 1, 4, 7, and 10.** Steps 6, 9, and 11 are
feature-verification and can be waived for a manual regression run.
