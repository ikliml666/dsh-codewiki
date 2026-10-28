---
title: test_batch
type: module
source_files:
  - test-batch.mjs
  - index.js
tags: [test, batch, article-generation, anchor-fixing, model-catalog]
---

## Overview

`test-batch.mjs` is the self-check suite for the **batch article generation flows** of the dsh-codewiki plugin. It is a standalone Node ≥20 script (`node test-batch.mjs`) — not a harness test — that imports pure functions and a mock host-llm service directly from `index.js` and asserts their behavior with a tiny `check()` helper plus a terminal summary (`test-batch.mjs:15-21`, `test-batch.mjs:638-642`).

It exercises two layers:

1. **Pure compiler stages** (deterministic, no network): `estimateTokens`, `numberLines`, `collectSources`, `prepareArticleTasks`, `classifySessionTask`, `buildSessionSteerText`, `localPlan`, `packArticles`, `scanRepoFiles`, `fixAnchors`/`fixChangelogAnchors`, `validateArticleEnvelope`.
2. **The mock host-llm channel** `runRealtimeTasks` and the model-catalog + web endpoints (`listModelCatalog`, `resolveModelEfforts`, `installWebServer`) — driven by in-file fake `llm` objects that implement the `stream()` / `listProviders()` / `listModels()` / `resolveModelInfo()` contract.

The suite's intent is to pin down exactly the behaviors that earlier shipped as silent failures: anchor drift (`.codewiki/learnings/update-reminder-entry-gap.md` accumulated 19 dead anchors), non-converging CHANGELOG relocations, half-open frontmatter that gets written but never corrected, oversized module articles that wrongly fell through to the session channel, and the big-tier / default-tier dual concurrency pools.

## Key Components

The suite imports the following symbols from `./index.js` (`test-batch.mjs:7-13`) and tests each:

### Functions under test (defined in `index.js`)

- `estimateTokens(text)` — `index.js:520`. CJK rough token count (CJK char ≈ 1 token, else ≈ 3.5 chars/token). Tested at `test-batch.mjs:24-29`.
- `numberLines(content)` — `index.js:750`. Prefixes each line with `N| `, strips a single trailing newline, keeps CRLF on interior lines. Tested at `test-batch.mjs:47-52`.
- `collectSources(cwd, files, budget)` — `index.js:1165`. Inlines source files as `### rel` + ` ``` ` + `numberLines` blocks; returns `{ text, skipped, oversized }`; annotates missing files; returns `oversized:true` with the first file's body if it alone exceeds `budget`. Tested at `test-batch.mjs:31-45`.
- `prepareArticleTasks(tasks, { cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget })` — `index.js:1236`. Loads per-task source text, assembles prompts, splits oversized multi-file tasks into `_split/#obs*` observe batches (`keepInMemory`, `splitFor`, `composePlan`), and routes single oversized files to the big tier (provider/model on the task) or the session channel. Returns `{ prepared, sessionTasks }`. Tested at `test-batch.mjs:54-132`.
- `classifySessionTask(task, nowMs)` — `index.js:2103`. Harvest verdict for session-channel tasks: `timeout` (older than `SESSION_TASK_TIMEOUT_MS`, 30 min), `harvest` (file produced, mtime ≥ dispatchedAt, starts with frontmatter), `wait` (no file / older file / half-written). Tested at `test-batch.mjs:134-149`.
- `buildSessionSteerText({ job, snapshots, tier, resend })` — `index.js:2120`. Builds the steer text sent to the initiating session; when `tier` is set it pins the delegate `tier` and forbids auto-routing (`test-batch.mjs:152-168`).
- `runRealtimeTasks(tasks, { provider, llm, model, reasoningEffort, concurrency, bigConcurrency, notes, onTaskDone, signal, onRequestStart })` — `index.js:662`. The only execution pool: drives every task through the host-llm `stream()`, applies two concurrency pools (default vs big tier, keyed on `t.bigTier`), supports external `AbortSignal` cancellation, per-task `provider`/`model`/`reasoningEffort` override, and failure bookkeeping into `notes`. Returns `Map(customId → {ok, stopReason, content?})`. Tested extensively at `test-batch.mjs:170-345`.
- `localPlan(files)` — `index.js:1371`. Groups files by top-level directory into module stubs (`slugify` of dir name, `root` for top-level files), no concepts. Tested at `test-batch.mjs:347-358`.
- `packArticles(articles, budget)` — `index.js:1480`. Crosscut input packing: full articles when they fit, head-only (`frontmatter` + `## Overview`, truncated before `## Key Components`) when over budget. Tested at `test-batch.mjs:360-371`.
- `scanRepoFiles(cwd)` — `index.js:2192`. Repo probe: skips `SCAN_SKIP_DIRS` / dot-dirs / `SCAN_SKIP_EXT` binaries / empty / >256 KB / >2000 files. Returns `[{ path, bytes }]`. Tested at `test-batch.mjs:373-387`.
- `listModelCatalog(llm)` — `index.js:4562`. Enumerates host `llm.listProviders()` + per-provider `listModels()`, tolerant of missing `id`/per-provider errors. Tested at `test-batch.mjs:410-432`.
- `resolveModelEfforts(llm, provider, model)` — `index.js:4600`. Reads `reasoning.efforts`/`defaultEffort`/`context` via `resolveModelInfo` (falling back to `resolveModel`). Tested at `test-batch.mjs:464-516`.
- `installWebServer(ctx, service, extra)` — `index.js:4624`. Registers the loopback-only panel endpoints; the suite registers `/api/codewiki/models` and `/api/codewiki/model-efforts` via a fake `webServer.register` and asserts 200/403/400. Tested at `test-batch.mjs:434-462`.
- `validateArticleEnvelope(content)` — `index.js:1153`. Frontmatter gate: returns `null` when the content is a closed `---\n...\n---` envelope, otherwise a reason phrase (`缺 frontmatter` / `未闭合`). Tested at `test-batch.mjs:605-636`.
- `fixAnchors(content, cwd)` — `index.js:927`. Anchor correction before write: repairs unclosed frontmatter, relocates CHANGELOG anchors, and rebinds `file:NN(-MM)` anchors to the correct symbol line. Indirectly exercises `repairUnclosedFrontmatter` (`index.js:905`), `fixChangelogAnchors` (`index.js:780`), `changelogSections` (`index.js:770`) and `parseSourceFiles` (`index.js:1747`). Tested exhaustively at `test-batch.mjs:523-602`.

The suite also asserts the **0.10.1 removal of the built-in Aliyun direct channel** by checking `mod.resolveBatchApiKey === undefined` (`test-batch.mjs:518-521`).

### In-file test helpers (`test-batch.mjs`)

- `check(cond, msg)` — `test-batch.mjs:17`. Increments `passed` or pushes to `failures`, logs `✓`/`✗`.
- `section(name)` — `test-batch.mjs:21`. Prints a `== name ==` banner.
- `mockJson(obj, status)` — `test-batch.mjs:22`. Builds a `fetch`-like response object (`ok`/`status`/`text()`).
- `makeLlm(reply)` — `test-batch.mjs:174`. Returns a fake `llm` whose `async *stream(opts)` yields `block-start` → text (`reply`, a string/function/`Error`) → `usage` → `finish`. Errors become `finish kind:error`.
- `makeSlowLlm(reply, delayMs)` — `test-batch.mjs:233`. Same shape with a `setTimeout` sleep, used to observe in-flight concurrency.
- `poolProbe()` — `test-batch.mjs:244`. Returns `{ st, onTaskStart, onTaskEnd }` counters for `normal`/`big`/`total` pools to assert independent throttling.
- `mk(id, big)` — `test-batch.mjs:260`. Builds a task with optional big-tier fields for the dual-pool test.
- `promptOf(opts)` — `test-batch.mjs:190`. Pulls the user-message text out of an llm `opts` object to assert request bodies.
- `fa(fmBody)` / `faFm` — `test-batch.mjs:536-537`. Build a full frontmatter + body wrapper for the `fixAnchors` cases.

## Architecture

```text
test-batch.mjs
  │  imports
  ▼
index.js  ── pure stages ─────────────────────────────┐
  estimateTokens ──► collectSources ──► numberLines    │
  prepareArticleTasks ──► {prepared, sessionTasks}     │
      │  bigTier / #obs split / session fallback       │
  localPlan ── packArticles                            │
  scanRepoFiles                                         │
  fixAnchors ──► repairUnclosedFrontmatter             │
             └─► fixChangelogAnchors                   │
  validateArticleEnvelope                              │
                                                      │
  runRealtimeTasks ◄── makeLlm / makeSlowLlm ──┐       │
      │  default pool (limit=concurrency)            │  mock host-llm
      │  big pool    (limit=bigConcurrency)          │  stream() contract
      ▼                                              │
  classifySessionTask / buildSessionSteerText         │
                                                      │
  listModelCatalog ─┐                                 │
  resolveModelEfforts ┘──► installWebServer            │
        fake webServer.register + fake llm ◄───────────┘
```

The suite drives `index.js` with **mock llm objects** (only `stream`, `listProviders`, `listModels`, `resolveModelInfo`) and a **fake `webServer`** (only `register`), so no real network or host service is touched.

## Data Flow

The end-to-end batch article path the suite mirrors (`prepareArticleTasks` → `runRealtimeTasks` → write) is:

1. `prepareArticleTasks(tasks, {cwd, language, bigProvider, …})` reads each task's `sources` via `collectSources` at a single-file limit (`bigTier ? bigBudget : BATCH_TOKEN_HARD_LIMIT = 128000`). For each task it produces:
   - a **plain single request** (`emitSingle`) when it fits, marked big-tier if `estimateTokens(batchPrompt) > BATCH_TOKEN_BUDGET` (110k) — `index.js:1267`.
   - an **observe split** (`#obs0/1/…`, `keepInMemory:true`, `splitFor`, `composePlan`) when multiple files overflow the 110k budget — `index.js:1299-1315`.
   - a **session-channel task** (`sessionTasks`) when a single file exceeds even the hard limit — `index.js:1279`.
   - a **big-tier single request** when `bigProvider` is set and the task exceeds 110k but fits `bigBudget` — task carries `provider`/`model`/`reasoningEffort`/`bigTier:true` — `index.js:1248-1256`, `test-batch.mjs:108-132`.
2. `runRealtimeTasks` consumes `prepared` through two pools: default tasks use the passed `provider`/`model`/`reasoningEffort`; big-tier tasks override with their own `t.provider`/`t.model` (and only their own `reasoningEffort`, never falling back to the default — `index.js:700-702`). Each result goes through `applyTaskResult` (`index.js:624`) which gates on the article contract, runs `fixAnchors`, and writes to `articlePath` (or returns `content` for `keepInMemory`).
3. `classifySessionTask` is polled by the orchestration tick to decide harvest/timeout/wait for `sessionTasks`.

The model-catalog path (`listModelCatalog` / `resolveModelEfforts`) feeds `installWebServer`'s `/api/codewiki/models` and `/api/codewiki/model-efforts` handlers, both guarded to **loopback only** (`isLoopbackRequest`, `index.js:4526`). The suite calls these handlers with a fake `req`/`res` and verifies 200 + body, 403 for non-loopback, and 400 for missing query params.

The anchor path: `validateArticleEnvelope` is the write-gate; `fixAnchors` (called by `applyTaskResult` / `writeValidated`, `index.js:2601`/`index.js:624`) first repairs unclosed frontmatter, then relocates CHANGELOG version anchors, then rebinds `file:NN` symbols — the suite nails down the many non-converging / flattening edge cases that previously produced quiet data corruption.

## Connections

- [[article_batch]] — the production batch module that owns `prepareArticleTasks`, `runRealtimeTasks`, `collectSources`, `packArticles`, `localPlan`.
- [[endpoint_helpers]] — `installWebServer`, `listModelCatalog`, `resolveModelEfforts` live here.
- [[orchestration_tests]] — exercises the tick/orchestration layer that consumes `prepareArticleTasks`/`classifySessionTask` results.
- [[wiki_tests]] — broader wiki test coverage (status parsing, index, etc.).
- [[graph_diff_tests]] — related test module for graph-diff behavior.
- [[mock_helpers]] — shared fake llm / workspace helpers used across tests.
- [[articles_agentic]] — the agentic alternative writing channel (`runAgenticArticles`), contrasted with the batch channel here.

## Known Issues

- The suite relies on **absolute file sizes** for the oversized fixtures (`'x'.repeat(420 * 1024)` ≈ 200k+ tokens for `big.ts`, `800 * 1024` for `huge.ts`, `410-432`). `estimateTokens` is therefore indirectly asserted with large tolerances rather than exact token counts (`test-batch.mjs:83-85`, `test-batch.mjs:121`).
- `runRealtimeTasks` failure tests use a per-task prompt string match (`promptOf` contains `'boom'`) to route the error — this couples the test to the prompt content, not to a stable task id (`test-batch.mjs:335-337`).
- The `/api/codewiki/models` and `/api/codewiki/model-efforts` cases pass a fake `webServer.register` but only assert the two relevant endpoints; `installWebServer` also registers jobs/repos/sessions/control handlers that are not exercised here.
- `fixAnchors` tests encode several real regressions by path/line (`index.js:927-928` reverse-range, `_patterns.md` 15× `index.js:49`, `_architecture.md:74` ambiguous symbol) — these are load-bearing assertions guarding previously-fixed bugs, not cosmetic checks.
