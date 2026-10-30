---
title: test_engine_native_inc
type: module
source_files:
  - test-engine-native-incremental.mjs
  - test-fixtures/fake-native-engine.mjs
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/change-set.js
  - index.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
tags: [test, native-engine, incremental, fixture, stage-5]
---

## Overview

`test-engine-native-incremental.mjs` is the production-chain test suite (阶段 5 / stage 5: 统一增量的生产链) for the native incremental engine jobs. It does **not** assert that a single pure function computes correctly; it asserts three things that only surface in a real repository:

1. The second round really walks the engine's `update` path (not a fake increment that is actually full): the engine must receive `action=update` + `updateOptions.rung`, and it must **really read** the state persisted into `.codewiki/_native-state/` during the previous round — evidence coming from the fake engine process's own `stat` trail, not the caller's self-report.
2. Changes are neither lost nor double-consumed: the four-ways (committed/staged/unstaged/untracked) plus delete/rename must all be seen; uncommitted parts are carried by `state.json`'s `unconsumed` until they really land in a commit.
3. When increment is unavailable it must **explicitly** fall back to full (never silently clean): missing graph / unreachable base / version mismatch all become `full` + a visible reason; the baseline only advances when the round fully succeeds and the engine reports increment held.

The file runs end-to-end through the real production code path: it imports `apply` from `index.js` (test-engine-native-incremental.mjs:36| `const { apply } = await import('./index.js')`), registers the `codewiki_generate` tool, and submits real jobs that go through `runNativeJob` in `lib/engine/native-run.js`. The "engine" is a real child process: `fake-native-engine.mjs`, spawned by the production `client.js` so the spawn / protocol / process-tree path is exercised for real.

Run with `node test-engine-native-incremental.mjs` (exit code 0 on success). `ONLY_CASES=2,5` selects only cases 2 and 5 (176-178).

## Key Components

### test-engine-native-incremental.mjs

- `TEST_TOKEN` / `DSH_CODEWIKI_JOBS_FILE` (29-31): isolate the jobs file in `os.tmpdir()` so the test does not collide with a real running host instance; `DSH_CODEWIKI_TICK_MS='300'` (28) pushes the tick to its floor.
- `FAKE_ENGINE` (34): path to `test-fixtures/fake-native-engine.mjs`, used as the engine entry for injected `engineFor`.
- `check(cond, msg)` (42-46): assertion helper; increments `checks`/`failures`, prints `✓`/`✗`.
- `STATE_DIR = '.codewiki/_native-state'` (50): the directory the engine state is persisted into and read from.
- `makeRepo(tag, { mode })` (66-86): builds a temp git repo with `core/core.py` + `util/util.py`, runs `cw init`, commits `CodeWiki.md`, then writes a per-repo mode file `.native-mode-<tag>`. Returns `{ base, repo, git, calls }`. The mode file lives **outside** the repo so it is not an uncommitted source change that the quality gate's `uncommitted-input` would flag.
- `setMode(base, tag, mode)` (87-89) / `readCalls(base, tag)` (90-94): write/read the fake engine's call trail `.native-calls-<tag>.log` (also outside the repo).
- `fakeLlm` (96-100): a no-op streaming LLM used for the bridge.
- `baseDeps(extra)` (104-111): dependency injection for `runNativeJob` — `engineFor` returns `{ command: process.execPath, args: [FAKE_ENGINE], env: {} }` so the fake engine runs as a real child process.
- `freshDocs(tag)` (112): fresh temp docs dir per invocation (needed so incremental hydration does not pollute the repo `.codewiki/`).
- `nativeCfg(extra)` (114-126): config object enabling the native engine (`nativeEngine: true`, `nativeEngineEntry: FAKE_ENGINE`), `planMode: 'dirs'`, `agenticArticles: false`, `symbolIncremental: false`.
- `makeCtx({ llm })` (129-148): constructs a mock host `ctx` with `inject`, `on`, `effect`, plus `services.webServer/agents/tools/llm`, returning `{ ctx, registered, endpoints, disposers }`. Mirrors `test-engine-native-job.mjs`.
- `waitJob(cwd, { timeout })` (150-173): polls `JOBS_FILE` for the latest job at `cwd` whose `stage` is `done`/`partial`/`failed`/`cancelled`; on timeout it dumps the live scene (stage/channel/nativeStage/error/notes) instead of returning `null`.
- `runJob(repo, { cfg, scope })` (180-191): registers the tool via `apply(m.ctx, cfg)`, executes `codewiki_generate` with `{ cwd: repo, scope }`, waits for the job, disposes all ctx disposers in `finally`.
- `gitOut` (193) / `gitShowFiles` (194-195): git helpers for reading HEAD / commit file lists.
- Cases (199-504): nine end-to-end cases described in Data Flow below.
- Teardown (505-507): removes temp dirs and the jobs file.

### test-fixtures/fake-native-engine.mjs

A real process (not an injected function) that implements only the protocol and artifacts — no algorithm — so the JobService→engine wiring is exercised for real.

- `modeOf(repoPath)` (31-40) / `modeFileFor(repoPath)` (27-30): resolves engine behavior from env `FAKE_ENGINE_MODE`, else a per-repo mode file, else a `__<mode>__` segment in the repo dir name. Mode file lives outside the repo for the same pollution reason.
- `VERSION` (42) / `PYVER` (43): reported engine/python versions (mutable via `FAKE_ENGINE_VERSION` / `FAKE_ENGINE_PYVERSION`).
- `logCall(repoPath, action, extra)` (52-57): appends `{action, at, mode, ...extra}` to `.native-calls-<repo>.log` — the passive-side evidence of which action ran and what was read.
- `readStateInputs(docsDir, repoPath)` (65-88): `stat`s the four managed inputs (`module_tree.json`, `metadata.json`, `dependency_graph`, `update_record.json`, plus a markdown count) and writes the result into the call trail — proving the engine really consumed the hydrated state.
- `realSourceFiles(repoPath, limit)` (112-129): scans the real repo for source files so the fixture's module tree / pages only reference files that actually exist (avoids `source-missing` gate defects).
- `writeDocs(docsDir, repoPath, { action, commitId })` (131-201): writes the dependency graph, `overview.md`, `modules/core.md`, `modules/web.md` (skipped in `partial` mode), `metadata.json` (with `generation_info.commit_id`), `module_tree.json`, and `update_record.json` whose `outcome` is `incremental`/`no_change`/`full_fallback` for `update`, else `full`. On `update` it does **not** overwrite existing pages (in-place patch).
- `run(req)` (203-314): emits `hello`, logs the call (with `updateOptions` and `readStateInputs`), handles `doctor`, `generate`, `update`; implements modes `stall`/`slow`/`fail`/`crash`/`empty-docs` and the normal `done` path. The emitted `result` carries `updateOutcome`, `artifacts.stateFiles` (cross-checked by `native-run.js`).
- `MODE` (41): the per-call behavior, including `update-nochange` (case 2), `update-fallback` (case 6).

### lib/engine/native-run.js (the production code under test)

- `runNativeJob({ repoRoot, scope, kind, requestId, signal, timeoutMs, requireCommittedInput, docsDir, deps, onProgress, onLog })` (113-860): the strict-orchestration entry. Returns an `EngineResult` augmented with `incremental`, `gate`, `apply`, `engineLock`, `notes`, `canAdvanceBaseline`.
- `DEFAULT_UPDATE_OPTIONS = { rung: '3' }` (68): component-level increment; explicitly passed so tests can assert it reached the engine.
- `DEFAULT_ENGINE_TIMEOUT_MS = 45*60*1000` (72).
- `RESOLUTION = { FULL: 'full', UPDATE: 'update' }` (87) / `RANK` (75) / `weakest` (76).
- `readCommittedBaseline` is imported from `quality-gate.js`; `isUpdateEligible`, `mergeUnconsumed`, `hydrateDocsDir`, `captureDocsDir`, `buildStatePayload`, `stateFileItem`, `stateFingerprint` are imported from `native-state.js` (as namespace) and exercised here.

### lib/engine/native-state.js (the persistence base under test)

- Constants: `NATIVE_STATE_VERSION` (46), `NATIVE_STATE_DIR = '.codewiki/_native-state'` (48), `NATIVE_STATE_FILE = 'state.json'` (49), `STATE_REQUIRED_DOCS = ['module_tree.json','metadata.json']` (53), `STATE_TEMP_FILES` (57-60), `STATE_TEMP_DIRS = ['temp/dependency_graphs']` (61).
- `graphFileName(repoRoot)` (146-150): sanitizes repo name with `\p{L}\p{N}` (Unicode-aware) to match FSoft's graph filename.
- `stateDocsDir(stateDir)` (153-155), `isStateDocPath(rel)` (170-179), `stateDocFiles(stateDir)` (187-192).
- `readState(stateDir, repoRoot)` (204-231): returns `{ok, state, reason}`; fails on `ENOENT`/`unreadable`/`corrupt`/version mismatch.
- `readStateText(stateDir, repoRoot)` (234-240).
- `isUpdateEligible({ stateDir, repoRoot, baseCommit, engineVersion, headCommit })` (256-303): returns `{eligible, reason, missing}`; checks required docs, graph, engine version, committed baseline.
- `hydrateDocsDir({ stateDir, repoRoot, docsDir })` (334-352): copies (not moves) managed state into the engine's temp docsDir.
- `captureDocsDir({ docsDir, stateDir })` (369-402): collects state files as `{rel, content}` for `apply` extraFiles; reports `missing` for absent required docs/graph.
- `buildStatePayload({...})` (421-475): builds `state.json` content (records `consumedRange`, `pendingChanges`, `unconsumed`, `engineVersion`, `scope`/`effectiveScope`, `updateOutcome`, `fallbackReason`, `updatedAt`).
- `stateFileItem(payload, stateDir)` (478-483), `stateFingerprint(text)` (494-504) (drops `updatedAt`/`notes` for stable comparison).
- `mergeUnconsumed({ changeSet, prevUnconsumed })` (524-566): pure function that merges four-ways + carried `unconsumed`, computes `consumedNow`, `effectiveChanges`, `carried`.

### lib/change-set.js (the change collector under test)

- `collectChangeSet(cwd, baseCommit, opts)` (108-209): returns a ChangeSet with `ok`, `state`, `fallback` (always `'full'` on failure), `committed`/`staged`/`unstaged`/`untracked`/`deleted`/`renamed`, `headCommit`, `all`, `sourceChanges`, `ignored`. Imports `withQuotepathOff` and `decodeGitPath(s)` from `lib/git-paths.js`. Note: the test injects a fake `collectChangeSet` only in case 6 (badbase) to simulate an unreachable base.
- `CHANGE_SET_VERSION` (20), `isWikiProduct(relPath)` (27-30) (excludes `.codewiki/` from source changes), `normChangePath(p)` (34-41), `parseNameStatus(out)` (58-77), `emptyChangeSet(base, overrides)` (79-99).

### index.js (production entry exercised)

- `apply(ctx, config)` (5178-5242): registers the `codewiki_generate` tool (`generateToolDefinition`) and starts the job service; the test calls `m.registered.get('codewiki_generate').execute(...)`.
- `nativeEngine` config flag (100) and `nativeEngineEntry` (102) are what flip the test onto the native pipeline.
- `nativeChannelFor(cfg, { kind, scope })` (238-252) decides whether the native channel takes over a task.

## Architecture

```text
  test-engine-native-incremental.mjs
  ┌─────────────────────────────────────────────┐
  │ makeRepo + makeCtx + runJob                  │
  │   apply(cfg) → codewiki_generate.execute     │
  └───────────────┬─────────────────────────────┘
                  │ submits job (real path)
                  ▼
  ┌─────────────────────────────────────────────┐
  │ index.js :: apply/service (JobService)       │
  │   nativeChannelFor → runNativeJob            │
  └───────────────┬─────────────────────────────┘
                  │
                  ▼
  ┌─────────────────────────────────────────────┐
  │ lib/engine/native-run.js :: runNativeJob     │
  │  env → 增量决议 → 水合 → 引擎 → gate → apply │
  │  uses: change-set.js / native-state.js       │
  └───┬───────────────────┬─────────────────────┘
      │ spawn (real)      │ read/persist
      ▼                  ▼
┌──────────────┐  ┌─────────────────────────────┐
│ fake-native- │  │ .codewiki/_native-state/     │
│ engine.mjs   │  │ state.json + docs copy       │
│ (node proc)  │  │ (managed cross-round state)  │
└──────┬───────┘  └─────────────────────────────┘
       │ logCall trail (.native-calls-<tag>.log)
       ▼  (passive evidence of action + readState)
   test asserts engine really ran update & read state
```

## Data Flow

The nine cases cover the production chain. Each `runJob` (180-191) drives the real `codewiki_generate` tool via `apply`, and case 6/7/8 also call `runNativeJob` directly with injected deps for finer failure injection.

- **Case 1 — production two rounds (199-268):** first `scope:'full'` builds the store and persists `.codewiki/_native-state/` (`state.json`, `docs/module_tree.json`, `docs/metadata.json`, `docs/update_record.json`, `docs/temp/dependency_graphs/*_dependency_graph.json`, and the previous round's article copies, 201-211). The commit contains only wiki paths and the state files share the same commit (213-218); baseline advances and the round resolves `full` (219-220). `cw index` must skip `_native-state` (223-224). A source change is committed, then `scope:'stale'` must resolve `update` with `baseCommit` ≠ HEAD (246-252), the engine's `update` action is called exactly once with `updateOptions.rung='3'` (256-258), and the engine really read `module_tree`/`metadata`/`dependency_graph`/`update_record` and the previous markdown (259-263); engine self-reports `incremental` and the baseline advances (264-266).
- **Case 2 — no change → no rewrite/no commit (270-284):** second round sets mode `update-nochange`; engine reports `no_change` and no new commit is produced (`commit.noChanges`/`committed=false`, 281-283).
- **Case 3 — four-ways + delete/rename (286-321):** committed (delete `util.py` + rename `core.py`→`renamed.py`), staged (`staged.py`), unstaged (`renamed.py` edited), untracked (`brand-new.py`) are all seen in `inc.changes` (307-311); uncommitted paths enter `state.json`'s `unconsumed` (313-315); because of uncommitted source input the round must NOT be `done` and the baseline must not advance (317-318).
- **Case 4 — uncommitted changes survive two rounds (323-349):** a dirty `core/core.py` is recorded in `unconsumed` across rounds 2 and 3 (`carried` visible, 330, 337); only after a real commit does it move into `consumedNow` and out of `unconsumed` (342-348).
- **Case 5 — missing graph → explicit full (351-365):** deleting the dependency graph forces `resolution:'full'` with a `fallbackReason` naming the graph; the engine receives no `update` action; baseline advances because full succeeded (363-364).
- **Case 6 — unreachable base / version mismatch → explicit full (367-394):** `badbase` injects a `collectChangeSet` returning `{ok:false, state:'unreachable-base', fallback:'full'}` (373) → resolves `full`. `badver` rewrites `state.json`'s `engineVersion` to `0.0.1-not-compatible` (384-387) → `isUpdateEligible` returns `eligible:false` on version and resolves `full` (391-393).
- **Case 7 — index / baseline / commit failures (396-468):** `idxfail` injects `runCw` returning exit 1 on `index` → `outcome:'failed'`, `rolledBack:true`, state files restored to pre-image, no commit (408-418). `basefail` injects failure on `meta` → `failed`, state rolled back, blocker `baseline-failed` (435-446). `commitfail` injects `commit` returning `{committed:false}` → `outcome:'partial'`, product NOT rolled back, blocker `commit-failed` (460-463).
- **Case 8 — cancel (470-486):** `AbortController.abort()` before run → `outcome:'cancelled'`, `canAdvanceBaseline:false`, no commit, no baseline advance (479-485).
- **Case 9 — legacy channel unaffected (488-504):** with `nativeEngine:false`, `codewiki_generate` submits via the legacy channel (`channel:'legacy'`), `nativeResult` is `null`, the native engine is never invoked, and no `_native-state` is produced (491-500).

## Connections

- [[test-engine-native-job]] — sibling native-engine test (single full round, same `makeCtx` shape)
- [[native-run]] / lib/engine/native-run.js — the orchestration under test
- [[native-state]] / lib/engine/native-state.js — the cross-round managed state
- [[change-set]] / lib/change-set.js — the four-way change collector
- [[quality-gate]] / lib/engine/quality-gate.js — `gateNativeOutput` (engine done ≠ gate pass)
- [[apply-plan]] / lib/engine/apply-plan.js — `applyNativeOutput` (index/baseline/commit, rollback)
- [[engine-contract]] — `engineResult`/`engineError` invariants (done must not carry blockers)
- [[index]] — `apply` / `codewiki_generate` / `nativeChannelFor`

## Known Issues

- The fake engine is a protocol/artifact stub only: it does not implement FSoft's real incremental algorithm. "Incremental held" is asserted via the engine's self-reported `updateOutcome` and `update_record.json` (fake-native-engine.mjs 193-200, 294-296), not by a real graph diff. This is intentional — see the fixture header (1-17).
- `gen-graphdiff-golden.py` and `test-fixtures/graphdiff-golden.json` are NOT part of this module: they feed `test-graphdiff.mjs` (the `lib/graph-diff.js` vs Python `difflib` golden comparison), not the native incremental suite.
- Mode files and call-trail logs are written **outside** the repo (sibling dir at `path.dirname(repo)`) on purpose (makeRepo 66-86, fake-native-engine.mjs 27-30, 52-57): leaving them inside the repo would make them uncommitted source changes, which the quality gate's `uncommitted-input` would flag as a product defect and break cases 3/4.
- The test depends on a real `cw` CLI being on PATH (`makeRepo` calls `cw init`, 79) and real `git`; it is an integration test, not a unit test.
