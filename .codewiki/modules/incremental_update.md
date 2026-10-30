---
title: incremental_update
type: module
source_files:
  - lib/incremental.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/change-set.js
  - lib/graph-diff.js
  - lib/git-paths.js
  - test-incremental.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - test-change-set.mjs
---

## Overview

The `incremental_update` module is the layer that turns "the code changed" into
"exactly these wiki articles must be touched, and here is the proof that every
change was consumed". It is the practical answer to FSoft-AI4Code/CodeWiki's
updater, re-implemented as pure Node functions so the plugin stays zero-runtime
and keeps its own symbol graph (`lib/graph-diff.js`) instead of shelling out to
Python.

Four files form the spine, in pipeline order:

- `lib/change-set.js` — **collectChangeSet**: merges the four git surfaces
  (committed / staged / unstaged / untracked) plus deletions and renames into one
  normalized `ChangeSet`. This fixes the old `cw status` blind spot where
  uncommitted edits were silently treated as "already digested" and the baseline
  was advanced anyway (see the file header at `lib/change-set.js:1-13`).
- `lib/incremental.js` — **symbol-graph snapshots + component-level
  keep/drop**. Slims the symbol graph to a JSON snapshot stored at
  `.codewiki/temp/symbol-graph.json` and decides which articles are stale by
  diffing old vs new graph. The headline behaviour: "only implementation /
  comment changed, signature intact → don't rewrite the article".
- `lib/update-planner.js` — **planUpdate**: upgrades the old binary
  "rewrite-or-skip" question into an explicit `write / keep / delete / review`
  action per article, plus an `unmappedChanges` list so that no change is
  silently dropped. Adds reverse-dependency propagation, new-file routing, stale
  scanning of already-written pages, and a versioned `module-map.json`.
- `lib/update-record.js` — **buildUpdateRecord / judgeOutcome**: folds the
  ChangeSet + plan + per-article results into a machine-readable JSON record and
  judges the terminal stage (`done / partial / failed / cancelled`) with an
  explicit `canAdvanceBaseline` flag — the old code reported `done` even when 1
  article succeeded and 19 failed (see `lib/update-record.js:1-11`).

`lib/graph-diff.js` and `lib/git-paths.js` are shared dependencies (graph
diffing and git path un-escaping) that the four files rely on; they are listed
here because the module's behaviour is meaningless without them.

The module is deliberately split into pure functions (no filesystem access in the
core logic) plus a thin IO layer at the bottom of each file, so every decision is
unit-testable without a real git repo.

## Key Components

### `lib/change-set.js` — four-surface change collection

- `CHANGE_SET_VERSION` (20|): version constant for serialized ChangeSet.
- `WIKI_PRODUCT_PREFIX` (25|): `'.codewiki/'`. Wiki's own product dir is excluded
  from "source changes" so incremental mode never thinks its own output is new
  source.
- `isWikiProduct(relPath)` (27-30|): returns true if `relPath` is exactly
  `.codewiki` or starts with `.codewiki/`.
- `normChangePath(p)` (34-41|): normalizes a git path to POSIX, dropping `./`,
  rejecting absolute paths, drive letters, and `../` escapes. Unsafe paths become
  `null`.
- `defaultExecFile(cwd)` (43-50|): real exec backend using `execFileSync` with a
  16 MB buffer.
- `parseNameStatus(out)` (58-77|): parses `git diff --name-status` output. `R`/`C`
  lines become `{kind:'renamed'|'copied', from, path}`; deleted → `deleted`;
  everything else → `modified`. Every path runs through `normChangePath` and
  `decodeGitPath`.
- `emptyChangeSet(baseCommit, overrides)` (79-99|): builds a ChangeSet with
  `ok:false`, `state:'unknown'`, `fallback:'full'`, and empty buckets. Callers
  override specific fields.
- `collectChangeSet(cwd, baseCommit, opts)` (108-210|): the main entry. Returns
  early with a non-ok ChangeSet (`state` + `reason`, `fallback:'full'`) when:
  - `baseCommit` is empty → `state:'missing-base'` (110-112|)
  - not a git repo (`rev-parse --is-inside-work-tree` ≠ `true`) → `state:'no-git'`
    (124-126|)
  - `rev-parse HEAD` fails → `state:'git-error'` (127|)
  - baseline commit unreachable (`cat-file -e <base>^{commit}` fails) →
    `state:'unreachable-base'` (134-143|)
  - any collection step throws → `state:'git-error'` (163-165|)
  Otherwise it runs four-way collection with `-M` rename detection
  (147-165|): `committed` (`base..HEAD`), `staged` (`--cached HEAD`), `unstaged`
  (working tree), `untracked` (`ls-files --others --exclude-standard`). It then
  merges into `all` (including both ends of renames, 167-182|), drops
  deleted-then-recreated paths from `deletedSet` (184-186|), and splits
  `sourceChanges` (everything not matching `isWikiProduct`) from `ignored`
  (188-190|). Returns an object with fields: `version`,
  `ok`, `state`, `fallback`, `reason`, `baseCommit`, `headCommit`, `committed`,
  `staged`, `unstaged`, `untracked`, `deleted`, `renamed`, `all`, `sourceChanges`,
  `ignored` (192-209|).

The `ChangeSet` shape used downstream: `version`, `ok`, `state`, `fallback`,
`reason`, `baseCommit`, `headCommit`, `committed`, `staged`, `unstaged`,
`untracked`, `deleted`, `renamed`, `all`, `sourceChanges`, `ignored`. See
`test-change-set.mjs` for the full contract.

### `lib/incremental.js` — symbol snapshots & component-level keep/drop

- `SNAPSHOT_VERSION` (19|): snapshot format version (= 1).
- `SNAPSHOT_REL` (22|): `temp/symbol-graph.json` (relative to wiki root).
- `SLIM_FIELDS` (26|): the field allow-list kept in a snapshot:
  `id, name, kind, relativePath, parameters, baseClasses, dependsOn, bodyHash,
  codeHash`. Source code is never stored.
- `slimComponent(node)` (28-34|): copies only `SLIM_FIELDS` from a graph node,
  forcing `id` and `relativePath` to strings.
- `slimGraph(graph, {commit, now})` (37-48|): maps every node through
  `slimComponent`, freezing `bodyHash`/`codeHash` into the snapshot so replays
  don't need source. Returns `{version, generatedAt, commit, components}` sorted by
  id.
- `sameSnapshotContent(a, b)` (53-66|): compares two snapshots ignoring
  `generatedAt`/`commit` and ordering. Used so a content-less timestamp bump does
  not produce an empty auto-commit.
- `graphFromSnapshot(snap)` (69-88|): reconstructs a `Map<id,node>` for
  `graph-diff`. Reconstructed nodes carry empty `sourceCode`/`docstring` and the
  frozen `bodyHash`/`codeHash`.
- `snapshotPath(wikiPath)` (90-92|): joins `wikiPath` with `SNAPSHOT_REL`.
- `loadSnapshot(wikiPath, fsImpl)` (94-104|): reads and JSON-parses the snapshot;
  returns `null` if version mismatches or `components` is not an array (so a bad
  snapshot degrades to full recompile rather than misjudge).
- `saveSnapshot(wikiPath, snap, fsImpl, pathImpl)` (106-115|): writes the snapshot,
  creating the directory; returns `{ok, path}` or `{ok:false, reason}`.
- `normRel(p)` (118-120|): normalizes a relative path — replaces `\` with `/`,
  strips a leading `./`, trims.
- `componentsByFile(graph)` (123-132|): builds `Map<file, componentId[]>`.
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)` (140-194|): the core pure
  decision. Calls `diffGraphs`, `changedIds`, `graphDiffCounts`, then:
  - Applies a **cosmetic-only downgrade** (154-169|): a component whose
    `bodyHash` changed but whose `codeHash` is unchanged (and whose docstring is
    unchanged) is moved from "changed" to `cosmeticOnly`, i.e. its article is NOT
    rewritten. `interface/added/deleted/renamed/edge` changes are never downgraded.
  - For each task, looks up which of its `sources` files' components hit a real
    change. If none and the article has no resolvable symbols, it is `keep` with
    `symbolFallback:true` (179-183|). Otherwise it is `keep` with
    `changedComponents`, or `dropped` (with `cosmeticOnlyComponents` if applicable)
    (185-192|).
  Returns `{ keep, dropped, change, counts, cosmeticOnly }`.
- `describeChange(counts)` (197-206|): human-readable Chinese summary of the
  diff counts for a job note.

### `lib/update-planner.js` — per-article action plan

- `UPDATE_PLAN_VERSION` (23|), `MODULE_MAP_VERSION` (26|), `MODULE_MAP_REL`
  (27| = `'temp/module-map.json'`).
- `SOURCE_EXTS` (30|): supported source extensions derived from `SUPPORTED_EXTS`
  in `lib/symbols.js`.
- `isSourcePath(p)` (33-36|): true if the extension is a known source ext.
- `dirOf(p)` (38-41|), `commonDir(a, b)` (44-53|): directory helpers for
  module routing (longest common directory, at least one level).
- `realChangedIds(diff, oldGraph, newGraph, {ignoreCommentOnly})` (57-81|): mirrors
  the cosmetic downgrade from `lib/incremental.js` exactly, returning
  `{ changed, cosmetic, real, structural }` where `structural` = real changes that
  are interface/added/deleted/renamed/edge.
- `dependentsOf(graph, ids)` (85-101|): builds a reverse-dependency index; a
  component's `dependsOn` may be an id or a file path — both are recognized so
  "used component changed → its users' articles rewrite".
- `scanStaleArticle(article, {deletedComponents, renamedComponents, linkExists})`
  (106-145|): pure stale scan of an already-written page. Detects references to
  deleted symbols (`deleted-symbol`), renamed symbols (`renamed-symbol`), and dead
  wiki links (`dead-link`, via `[[name]]` and `(rel.md)`). `needsRewrite` is true
  only for deleted/renamed symbol references; dead links only raise a `review`.
  `linkExists` is injected by the caller.
- `planUpdate({changeSet, oldGraph, newGraph, articles, moduleMap, options})`
  (156-436|): the main entry. Produces an `UpdatePlan` with:
  - `fileLevel` (179|): true when `options.fileLevel` is set or either graph is
    null (symbol-level unavailable → file-level fallback).
  - reverse-dependency impact set `impactByFile` from `structural` changes (209-219|).
  - ownership set `claimedFiles` from article `sources` + `moduleMap` (221-236|).
  - per-article action `write / keep / delete / review` (238-347|). A missing
    `source_files` → `review` + `needsFull` (253-258|). Deleted source file →
    `write` (270-279|). Renamed source → `write` (280-289|). No resolvable symbols
    but file changed → `write`; unchanged → `keep` (290-304|). `ownHit` or
    `depHit` → `write` (305-318|). Otherwise stale scan decides `write`/`review`/`keep`
    (319-346|).
  - **unmapped change routing** (349-390|): source files that no article claims are
    routed to an article sharing a directory prefix (`routedTo`); truly orphan
    source files go into `unmappedChanges` and force `needsFull` (392|). Non-source
    files (docs) are only warned, never full (122-134| in the test, 385-389| in code).
  - `requiredNames` (399-408|): only `write` actions are required outputs for
    completeness; `keep`/`review` are not, to avoid spurious partials.
  Returns `{version, fileLevel, changedComponents, cosmeticComponents,
    structuralComponents, counts, actions, summary, unmappedChanges,
    unmappedSourceChanges, routedTo, missingSources, missingRequired, requiredNames,
    warnings, needsFull, fullReason, hasChanges}`.
- `buildModuleMap({articles, graph, plan, now})` (442-468|): builds the
  versioned `{version, generatedAt, articles}` map; each entry has
  `{sources, components, module}`. Module attribution prefers the plan's module
  name, else the common source directory.
- `migrateModuleMap({articles, now})` (472-481|): conservative migration from
  frontmatter when no `module-map.json` exists — records only `sources` and `module`,
  `components:[]`, and `migrated:true`.
- `sameModuleMap(a, b)` (484-492|): content comparison ignoring `generatedAt`.

### `lib/update-record.js` — terminal-stage judgment & record

- `UPDATE_RECORD_VERSION` (17|), `UPDATE_RECORD_REL` (18| =
  `'temp/update-record.json'`).
- `TERMINAL` (24|): `Set(['done','partial','failed','cancelled'])`.
- `isTerminalStage(stage)` (26-28|): membership test.
- `judgeOutcome({plan, results, options})` (37-128|): computes the terminal
  outcome. Inputs: `plan` (a `planUpdate` result or null), `results`
  (`[{name, ok, error?}]`), `options` `{expectedNames, qualityIssues, indexOk,
  cancelled, extraBlockers}`. It accumulates `blockers` of kinds:
  `missing-article` (60-69|), `article-failed` (78|), `unmapped-changes`
  (83-91| — only **source** changes block), `missing-sources` (92-97|), `quality`
  (100-102|), `index` (105|), and `extra` from caller (108-110|). Outcome logic
  (112-118|): `done` only when no blockers/failures/missing; `failed` when nothing
  was delivered (0 written and there is any failure/missing/blocker); otherwise
  `partial`. `canAdvanceBaseline` is true only for `done` with no blockers (124|).
- `buildUpdateRecord({jobId, scope, changeSet, plan, results, outcome, wikiPath,
  qualityIssues, notes, startedAt, finishedAt})` (131-211|): assembles the
  serializable record. The job only stores a path + summary, never the full graph
  (`graph`/`tasks` are intentionally absent, 183-184|). Records `changeSet` with a
  `counts` summary (153-169|), a slimmed `plan` with every action's `reason`
  (170-195|), per-article `results` (196-201|), `qualityIssues`, and the judged
  `outcome`/`blockers`/`canAdvanceBaseline` (203-208|).
- `recordPath(wikiPath)` (213-215|), `saveUpdateRecord(wikiPath, record, fsImpl)`
  (217-227|), `loadUpdateRecord(wikiPath, fsImpl)` (229-238|): IO helpers; load
  returns null on version mismatch (233|).
- `describeOutcome(outcome, blockers)` (241-253|): Chinese one-line text for the
  panel; `done`/`partial`/`cancelled`/`failed` each distinguishable at a glance.

### `lib/graph-diff.js` — shared symbol diff (dependency)

- `diffGraphs(oldGraph, newGraph, opts)` (447-564|): component-level diff. Adds
  missing ids to `added`, removes to `deleted`; for common ids, signature change →
  `interface`, body hash change → `body`, edge change only → `edge`. Renames are
  paired by `pairRenames` body-similarity (499-524|). Returns a diff object with
  `added/deleted/interface/body/edge` (Sets) and `renamed` (Map) plus `records`.
- `graphDiffCounts(d)` (425-434|): counts per change class.
- `changedIds(d)` (436-440|): all changed ids as a Set.
- `codeHash(node)` (108-111|): hash of source with comments stripped — the basis
  of the cosmetic downgrade. Reuses a frozen `codeHash` when no source is present.
- `bodyHash(node)` (121-126|): hash of normalized body + docstring; frozen hash
  reused when no source.
- `stripComments(text)` (69-100|): removes comments/whitespace to isolate "real
  code" for `codeHash`. `stripComments` is exported and directly tested in
  `test-incremental.mjs:120-126`.

### `lib/git-paths.js` — shared git path un-escaping (dependency)

- `GIT_QUOTEPATH_OFF` (20|), `withQuotepathOff(args)` (23-27|): disable git's
  octal path escaping.
- `decodeGitPath(p)` (37-72|): reverses `"\344\270\255.md"`-style escapes
  (byte-level, UTF-8 decoded). Idempotent on already-clean paths.
- `decodeGitPaths(list)` (75-79|): batch decode.

## Architecture

The module is a four-stage pure-function pipeline. Each stage owns one concern;
the only filesystem touches are the small IO helpers at the foot of each file
(`save*`/`load*`) and the git calls in `collectChangeSet`.

```text
 cw status + git baseline (.codewiki/_meta.yaml:last_compiled_commit)
        │
        ▼
┌────────────────────────┐  execFile(git diff/ls-files, -M)
│ lib/change-set.js      │  four-way: committed/staged/unstaged/untracked
│ collectChangeSet       │  + deleted + renamed + decodeGitPath
└───────────┬────────────┘
            │ ChangeSet { all, sourceChanges, deleted, renamed, ... }
            ▼
┌────────────────────────┐  loadSnapshot(.codewiki/temp/symbol-graph.json)
│ lib/incremental.js     │  + extractCurrentGraph(cwd)  ──►  oldGraph / newGraph
│ slimGraph / loadSnap.. │
│ graphFromSnapshot      │
└───────────┬────────────┘
            │ oldGraph, newGraph (Map<id,node>)
            ▼
┌────────────────────────┐  buildModuleMap / migrateModuleMap (.codewiki/temp/module-map.json)
│ lib/update-planner.js  │  articles = collectWikiArticles(wikiPath)
│ planUpdate             │  diffGraphs + realChangedIds + dependentsOf
│  write/keep/delete/    │  scanStaleArticle + new-file routing + unmappedChanges
│  review per article    │
└───────────┬────────────┘
            │ UpdatePlan { actions, summary, needsFull, unmappedChanges, requiredNames }
            ▼
┌────────────────────────┐  job.articles = [{name, ok}]
│ lib/update-record.js   │  judgeOutcome(plan, results, options)
│ judgeOutcome /         │  ──► done / partial / failed / cancelled
│ buildUpdateRecord      │        + blockers[] + canAdvanceBaseline
│ saveUpdateRecord       │  saveUpdateRecord → .codewiki/temp/update-record.json
└───────────┬────────────┘
            │ canAdvanceBaseline? ── yes ─► runCw meta update (advance baseline)
            │                          └─ no  ─► baseline frozen; next compile re-sees changes
```

Key cross-file invariants:

1. **Cosmetic downgrade is implemented twice but must stay in lock-step.**
   `lib/incremental.js:140-155` (`filterStaleTasks`) and
   `lib/update-planner.js:57-81` (`realChangedIds`) both use `codeHash` from
   `lib/graph-diff.js:108-111` to skip comment-only changes. `filterStaleTasks` is
   the legacy keep/drop filter (still referenced by the e2e test and some paths);
   `realChangedIds`/`planUpdate` is the newer full planner. They share the exact
   rule so articles behave consistently whichever path runs them.
2. **Snapshot and module-map are durable inputs, not derived on the fly.**
   `saveSnapshot` runs at the end of a successful compile
   (`index.js:28-49`), and `buildModuleMap` is rebuilt from a real plan during
   full compiles. Both live under `.codewiki/temp/` and are committed with the wiki
   so a fresh machine/session can still do symbol-level diff (they are excluded from
   `sourceChanges` via `isWikiProduct`).
3. **`needsFull` is a hard backstop, never a soft hint.** Both `planUpdate`
   (`lib/update-planner.js:392`) and `judgeOutcome` (`lib/update-record.js:37-45`)
   treat an unmapped *source* change as a completeness failure, so a change is never
   silently dropped.

## Data Flow

The end-to-end flow is orchestrated in `index.js` (the `codewiki_generate` /
`codewiki_update` tools and the job-service tick). Positions below cite the real
call sites:

1. **Baseline read** — `readCompiledBaseline(wikiPath)` (`index.js:1794-1802`)
   reads `.codewiki/_meta.yaml:last_compiled_commit`. This is the `baseCommit` for
   `collectChangeSet`. If absent, the planner degrades to file-level.

2. **Change capture** — `collectChangeSet(cwd, baseline)` (`index.js:4205`,
   `4319`) produces the four-way `ChangeSet`. If `!changeSet.ok`, the caller
   returns `{needFull:true, reason}` and aborts the incremental path
   (`index.js:4206-4208`).

3. **Graph build** — if `symbolIncremental` is on, `loadSnapshot(wikiPath)`
   (`index.js:2243`) is paired with `extractCurrentGraph(cwd)` (`index.js:4223`,
   defined at `index.js:2243`) to yield `oldGraph`/`newGraph`. A missing snapshot
   or an unready graph degrades to file-level (`index.js:4224-4231`).

4. **Module map** — `loadModuleMap(wikiPath, articles)` (`index.js:4233`, defined
   `index.js:1845-1852`) returns the persisted `module-map.json`, or a migrated
   frontmatter-only map via `migrateModuleMap`.

5. **Plan** — `planUpdate({changeSet, oldGraph, newGraph, articles, moduleMap,
   options})` (`index.js:4235`) yields `plan`. If `plan.needsFull`, the caller
   bails to full recompile (`index.js:4239-4241`). `write` actions become
   prebuilt tasks submitted to the job service (`index.js:4243-4253`,
   `4275`); `keep`/`review`/`unmapped`/`missingSources` blockers prevent a
   baseline advance (`index.js:4286-4296`).

6. **Execute & record** — per-article `results` accumulate on `job.articles`. At
   the `index` stage, `judgeOutcome({plan: job.updatePlan, results: job.articles,
   options})` (`index.js:3660-3668`) decides the terminal stage. `canAdvanceBaseline`
   gates the `cw meta update` call (`index.js:3696-3711`); on `partial`/`failed`
   the baseline is **frozen** so the next compile re-sees the unconsumed changes.

7. **Persist evidence** — `saveRecord(job, judged)` (`index.js:2603-2630`) calls
   `buildUpdateRecord` + `saveUpdateRecord` to write
   `.codewiki/temp/update-record.json` (or a repo-external dir for the native
   channel, `index.js:1909-1911`, `2894`). `slimPlanForJob` (`index.js:1909-1932`)
   trims the plan into `job.updatePlan` so the jobs file stays small.

8. **Snapshot refresh** — after a successful compile, `slimGraph` +
   `saveSnapshot` (`index.js:3720-3741`) rewrites the symbol snapshot, but only if
   `sameSnapshotContent` shows it actually changed (`index.js:3728`) — preventing
   an empty auto-commit that bumps only the timestamp.

Two parallel channels consume the same module:

- The **legacy/stale channel** in `index.js` (described above) uses
  `planUpdate`/`judgeOutcome` directly.
- The **native engine channel** (`lib/engine/native-run.js` via `tickNative`,
  `index.js:2839-2924`) delegates update/full resolution to the Python engine and
  writes its record outside the repo (`saveRecord(job, judged, {outDir:
  nativeRecordDir()})`, `index.js:2894`). The native channel deliberately skips
  the legacy `planUpdate.needsFull` decision (`index.js:4164-4183`) because the
  engine itself handles deletes/renames; the module's `planUpdate` would otherwise
  force a wasteful full recompile.

## Connections

- [[graph-diff]] — `lib/graph-diff.js` is the shared component-level diff engine
  (`diffGraphs`, `codeHash`, `bodyHash`) that both `lib/incremental.js` and
  `lib/update-planner.js` depend on for change classification and the cosmetic
  downgrade.
- [[symbols]] — `lib/symbols.js` provides `extractRepoGraph`,
  `resolveImportEdges`, and `SUPPORTED_EXTS`; `extractCurrentGraph`
  (`index.js:2243`) and `update-planner.js:30` consume it to build the dependency
  edges that reverse-dependency propagation needs.
- [[native-state]] — `lib/engine/native-state.js` is the cross-round persistence
  layer (`.codewiki/_native-state`) that the native engine channel relies on for
  component-level increment. It is the engine-side sibling of this module's
  own snapshot/module-map persistence.
- [[apply-plan]] — `lib/engine/apply-plan.js` is the landing layer that actually
  writes articles, builds the index, advances the baseline (`cw meta update`), and
  auto-commits. `update-record.js`'s `canAdvanceBaseline` is the gate it consults;
  see `index.js:3696-3711`.
- [[engine-quality-gate]] — the quality gate's per-article verdicts feed
  `judgeOutcome`'s `qualityIssues` option (`index.js:3665`), turning a gate
  failure into a `partial` terminal stage.
- [[orchestration]] — `index.js` is the orchestrator that wires
  `collectChangeSet` → `planUpdate` → `judgeOutcome`/`buildUpdateRecord` into the
  job-service tick (call sites at `index.js:4205`, `4235`, `3660`, `2603`,
  `3720`). The `codewiki_generate` / `codewiki_update` tools are its entry points.

## Known Issues
