---
title: test_agentic
type: module
source_files:
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-agentic-fallback.mjs
  - test-articles-agentic.mjs
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - index.js
tags: [test, agentic, article-generation, fallback]
---

## Overview

The `test_agentic` module is the collection of test files that verify the
**agentic article-writing stack** of the dsh-codewiki plugin: the tool loop
(`lib/agentic.js`), the host adapter (`lib/agentic-host.js`), the batch executor
(`lib/articles-agentic.js`), the write-set/contract gate (`lib/article-contract.js`),
and the production orchestration / fallback path in `index.js`.

Four test files belong to this module:

- `test-agentic.mjs` — exercises `lib/agentic.js` directly: `numberLines`,
  `safeRelPath`, `makeReadCodeTool`, `makeListFilesTool`, `makeArticleEditor`,
  `buildToolset`, `runAgenticArticle`, `parseToolArgs`, `buildOpeningPrompt`,
  `TOOL_SCHEMAS`. Fully offline via a fake `streamFn`.
- `test-agentic-host.mjs` — exercises `lib/agentic-host.js`:
  `toRequestMessages`, `makeHostStream`, `makeFsWorkspace`. Verifies the
  bare-message ↔ host `Message` translation, multi-tool-result expansion, chunk
  assembly, and FS path-boundary defense.
- `test-articles-agentic.mjs` — exercises `lib/articles-agentic.js`:
  `runOneArticle`, `runAgenticArticles`, `markBigAgenticTasks`, `sourceTokensOf`,
  `resolveTaskRoute`. Covers sub-module recursive dispatch, `subDepth` capping,
  big/normal dual pools, and the write-set gate (`allowedWritePaths`).
- `test-agentic-fallback.mjs` — exercises the production fallback contract in
  `index.js`: `shouldFallBackFromAgentic`, `prepareArticleTasks`,
  `runAgenticArticles`. Verifies that a batch where the agentic channel fails
  past the half mark is re-run through the single-pass channel.

## Key Components

### `test-agentic.mjs` (505 LOC)

A small in-memory harness that imitates the host without any model service.

- `makeWorkspace(over)` — lines 29–52: returns a fake `{ readFile, listDir }`
  workspace backed by the in-test `FILES` map (lines 24–28). Supports the
  `.git`/`.idea` style `../` traversal refusal by throwing `ENOENT` for unknown
  paths; `listDir` only exposes top-level entries of each directory.
- `assistant(blocks)` / `call(id, name, args)` / `text(t)` — lines 55–59:
  helpers that build the bare `{ role, content:[...] }` blocks consumed by
  `runAgenticArticle`. `call` JSON-stringifies the args unless already a string.
- `scripted(responses)` — lines 62–73: returns `{ fn, seen }`; `fn` is a
  `streamFn` that replays `responses` and records every call's
  `messageCount`/`toolNames` so a test can assert on what was sent to the model.
- `check(label, fn)` — lines 12–21: the shared pass/fail accumulator; tracks
  `pass` and `fails`, prints `PASS`/`FAIL`.

Public API asserted from `lib/agentic.js`:

- `numberLines(text)` (lib `101–106`) — prefixes every line with `N| `; test at
  test `76–78` asserts `'a\nb' → '1| a\n2| b'`.
- `safeRelPath(rel)` (lib `266–273`) — rejects absolute paths, drive letters, and
  `..` escapes; test at `80–87` covers `../etc/passwd`, `/etc/passwd`,
  `C:/Windows`.
- `makeReadCodeTool(workspace, { seen, getStep })` (lib `115–177`) — returns a
  tool fn; tests `89–129` cover line-number prefix, range reading, ENOENT,
  missing `path`, out-of-bounds path, and out-of-range line number, plus a
  character cap (test `563–571`).
- `makeListFilesTool(workspace)` (lib `179–197`) — hides `IGNORED_DIRS` (lib
  `98`); test `573–587` asserts `node_modules`/`.git` are suppressed while real
  sources survive.
- `makeArticleEditor(initial)` (lib `200–263`) — returns `{ edit, article }`;
  tests `151–207` cover `insert` at `line:0`, `str_replace` unique/multiple/missing
  match, `view` with line numbers; tests `542–561` cover CRLF normalization
  (cross-line match works, and the line-ending style is preserved in/out).
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`
  (lib `279–315`) — test `597–600` asserts exactly the four tools
  `edit_article`, `generate_sub_module`, `list_files`, `read_code`.
- `runAgenticArticle(opts)` (lib `331–432`) — the loop. Tests `210–419` cover:
  single-turn no-tool → `stopReason:'finished'`, two-turn
  read→write, tool-result `tool` message echo-back (`237–257`), model blocks kept
  verbatim (`259–274`), unknown-tool error without abort (`276–291`), bad-JSON
  warning (`293–305`), tool throw captured as `isError` (`307–322`),
  `maxSteps`/`empty-response`/`stream-error`/`aborted` stop reasons
  (`324–363`), explanation text not overwriting an already-written article
  (`365–378`), sub-module dispatch via `onSubModule` (`380–399`), and the hard
  rule that **without `onSubModule` a sub-module call must return `isError:true`**
  (`401–419`) so the model cannot believe a dead file exists.
- `parseToolArgs(raw, steps, step, toolName)` (lib `476–500`) — tests `464–499`
  handle object passthrough, empty-string→`{}`, ```` ```json ```` fence
  stripping, balanced-`{}` slicing inside prose, and bad-JSON → empty object +
  warning step.
- `buildOpeningPrompt({ mission, schemas, ... })` (lib `506–541`) — test
  `456–462` asserts the prompt contains the mission text, the
  "不许编造文件、函数、行号" hard rule, the tool names, and the
  "不要用 markdown 围栏把整篇文章包起来" instruction.

### `test-agentic-host.mjs` (191 LOC)

- `fakeLlm(chunkScripts)` — lines 67–77: a fake `llm` whose `stream(req)` yields
  each `chunkScripts[i]` in order and captures the request when `req.__capture`
  is set.
- `P`/`M` constants — lines 15–16: `'workbuddy'` / `'hy3'` provider+model names
  baked into every `toRequestMessages` call.
- Asserts on `toRequestMessages` (lib `34–79`): user→`UserMessage` with `id`
  (18–24); assistant gets `source.kind='model'` + provider/model (26–36); one
  `tool` message with N results expands into N `ToolResultMessage`s (38–53);
  an already-`id`'d assistant message passes through by reference (55–59);
  unknown role ignored (61–64); stable `MessageId` across repeated conversions
  (171–184). Asserts on `makeHostStream` (lib `83–108`): chunks assembled into
  `blocks`, tools passthrough, `temperature:0` (79–99); no `tools` field when
  empty (101–112); `finish.kind==='error'` throws (114–122); missing `llm`
  throws "需要宿主 llm 服务" (124–126); `reasoningEffort` passthrough (128–134).
  Asserts on `makeFsWorkspace(fs, path, cwd)` (lib `111–135`): `readFile` /
  `listDir` honor `dir` flag, and reject `../../` traversal (142–168).

### `test-articles-agentic.mjs` (475 LOC)

- `makeTmp()` — lines 23–29: creates a temp repo with
  `src/cart.js` / `src/order.js`.
- `call`/`text` — lines 31–34 (same shape as `test-agentic.mjs`).
- `scripted(responses)` — lines 37–43: `streamFn` returning
  `{ blocks, finish:{kind:'stop'} }`.
- `FULL_ARTICLE` — line 45: the canonical frontmatter+body article string.
- `scanArticleDepths(root)` — lines 151–163: walks the wiki tree and returns the
  directory-depth of every `.md`, used to prove `subDepth` capping.
- `alwaysDispatch(counter)` — lines 167–180: a `streamFn` that on every call
  issues an `edit_article` + `generate_sub_module` pair (and increments
  `counter.calls`), so unbounded recursion explodes the call count.

Asserted API from `lib/articles-agentic.js` (see [[articles-agentic]] for the
full source walk):

- `runOneArticle(task, opts)` — writes to `task.articlePath`; tests `48–141`
  cover basic落盘, recursive sub-module article writing (`66–98`),
  name-collision prefixing (`100–124`), and `subDepth=0` disabling dispatch.
- `subDepth` cap (libs `82–128`) — tests `182–215` prove the cap is *real*:
  with `subDepth:1` the deepest article is ≤2 path segments, and with
  `subDepth:2` a grandchild (3 segments) appears, while the model call count
  stays bounded (depth must increment per layer, not via a same-closure
  `dispatchSub` that would recurse forever).
- sub-module failure accounting — `217–245`: a failed child is recorded
  (`ok:false`) but the parent still succeeds.
- `runAgenticArticles(tasks, opts)` — `248–293`: aggregates `subModules`, pushes
  `notes`, isolates per-task failures into `Map(customId → result)`.
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })` — `299–329`: tags
  oversized modules with `bigTier` provider/model/reasoningEffort; pure; no-op
  when bigTier unconfigured; drops `reasoningEffort` when absent.
- dual-pool execution — `331–387`: big-tier and normal-tier tasks both run and
  land; `resolveTaskRoute` (lib `208–222`) lets a task's own
  provider/model/effort override the default (without falling back to the
  default effort); `bigConcurrency=0` falls back to `concurrency`.
- `sourceTokensOf(task, cwd)` — `389–397`: CJK≈1 token/char, non-CJK by
  3.5 chars/token, missing files count as 0.
- write-set gate (`allowedWritePaths`) — `399–470`: paths outside the set are
  rejected with `stopReason:'write-set'` and not written; the set is inherited
  downward so a recursive child cannot overwrite the parent's article.

### `test-agentic-fallback.mjs` (127 LOC)

- `r(ok)` / `rn(name, ok)` — lines 23–24: tiny result-shape builders used to
  feed `shouldFallBackFromAgentic`.
- Three guard segments, mirroring the production fallback chain documented in
  `lib/articles-agentic.js` / `index.js`:
  1. **`shouldFallBackFromAgentic(results)`** (index `1293–1298`) — empty/`null`
     → `false`; all-success → `false`; 1/4 failure → `false`; exactly half
     → `false` (**strict majority**, "过半"); 3/4 and all-fail → `true`
     (tests `27–51`).
  2. **re-fillability** (prepareArticleTasks, index `1165–1250`) — a re-queued
     retry task carrying `mission`+`articlePath` must produce a single-pass
     request `prepared[0]` whose `batchPrompt` includes the source text and whose
     `name` matches for later harvest (tests `59–73`); a retry missing `mission`
     is still produced (not silently dropped) (75–85); a retry whose source file
     was concurrently deleted degrades to an empty-but-present fill so the whole
     batch doesn't vanish (87–98).
  3. **per-article result distinctness** — `runAgenticArticles` with `llm:null`
     must still return a `Map` with one entry per task, each `ok:false`, so the
     caller can pick *which* articles failed rather than re-running everything
     (tests `101–120`).

## Architecture

```
            ┌──────────────────────┐   fake streamFn (offline)
            │   test-*.mjs         │  ─────────────────────────┐
            │  (test harnesses)    │                           │
            └──────────────────────┘                           │
                       │ asserts on                           ▼
   ┌───────────────────────────┐   ┌────────────────────────────────────┐
   │ lib/agentic.js            │   │ lib/agentic-host.js                │
   │ runAgenticArticle (loop)  │   │ toRequestMessages / makeHostStream │
   │ makeReadCodeTool /        │──▶│ makeFsWorkspace                    │
   │ makeArticleEditor /       │   │ (bare ↔ host Message adapter)      │
   │ buildToolset /            │   └────────────────────────────────────┘
   │ parseToolArgs /           │
   │ buildOpeningPrompt        │                │
   └──────────────┬────────────┘                │
                  │ uses                          │
                  ▼                               ▼
   ┌───────────────────────────┐   ┌────────────────────────────────────┐
   │ lib/articles-agentic.js   │   │ lib/article-contract.js             │
   │ runOneArticle             │   │ makeWriteSet / isWritable           │
   │ runAgenticArticles (pools)│   │ (write-set gate + inspectArticle)   │
   │ markBigAgenticTasks       │   └────────────────────────────────────┘
   │ sourceTokensOf            │
   │ resolveTaskRoute          │
   └──────────────┬────────────┘
                  │ drives (agentic path) / triggers fallback
                  ▼
   ┌───────────────────────────┐
   │ index.js                  │
   │ shouldFallBackFromAgentic │──▶ prepareArticleTasks (single-pass refill)
   │ startAgenticRun           │
   └───────────────────────────┘
```

## Data Flow

1. **Offline tool-loop path** (`test-agentic.mjs`): `scripted`/`check` build a
   `streamFn` and call `runAgenticArticle({ mission, workspace, streamFn })`
   (lib `331`). The loop builds `buildToolset` (lib `279`), filters
   `TOOL_SCHEMAS` to only the tools actually present (lib `354`), and on each
   step calls `streamFn({ messages, tools, signal })` → `out.blocks`. Tool calls
   are executed locally and echoed back as a `role:'tool'` message
   (`runAgenticArticle` lines `397–422`); the final article lives in
   `editor.article` and is returned as `{ article, steps, usedTools, stopReason, messages }`.
2. **Host-adapter path** (`test-agentic-host.mjs`): `toRequestMessages`
   (lib `34`) translates the bare loop `messages` into typed host messages
   (caching identities in a `WeakMap`, lib `26`); `makeHostStream` (lib `83`)
   wraps `llm.stream` and assembles chunks into `blocks` via `BlockAssembler`,
   throwing on `finish.kind==='error'`. `makeFsWorkspace` (lib `111`) is the
   concrete `readFile`/`listDir` over a real temp dir.
3. **Batch execution path** (`test-articles-agentic.mjs`): `runOneArticle`
   (lib `33`) creates an `editor` + `makeFsWorkspace`, runs `runAgenticArticle`
   with `makeHostStream`, then recursively dispatches `generate_sub_module`
   calls (`dispatchSub`, lib `83–128`), and finally writes the article to
   `task.articlePath` subject to the `allowedWritePaths` gate (lib `155–167`).
   `runAgenticArticles` (lib `231`) splits tasks into normal/big pools and
   collects a `Map(customId → result)`.
4. **Fallback path** (`test-agentic-fallback.mjs`): `shouldFallBackFromAgentic`
   (index `1293`) inspects the agentic batch results; if more than half failed
   and the job hasn't retried (`shouldFallBackHere`, index `2585–2592`),
   `tickArticles` (index `2944`) re-queues only the failed names and runs them
   through `prepareArticleTasks` (index `1165`) — the single-pass channel that
   inlines sources and yields `prepared`/`sessionTasks`.

## Connections

- [[articles-agentic]] — the executor under test in `test-articles-agentic.mjs`
  and `test-agentic-fallback.mjs`; read this for the real source of
  `runOneArticle`, dual pools, and the write-set gate.
- [[agentic]] — the pure tool loop (`runAgenticArticle`, `buildToolset`,
  `parseToolArgs`, `buildOpeningPrompt`) exercised by `test-agentic.mjs`.
- [[article-contract]] — `makeWriteSet`/`isWritable` (lib `article-contract.js`
  `323–349`) back the `allowedWritePaths` gate asserted in
  `test-articles-agentic.mjs`.
- [[index]] — production orchestration (`startAgenticRun`, `shouldFallBackHere`,
  `prepareArticleTasks`, `tally`) that the fallback tests pin down.

## Known Issues

- `test-agentic.mjs:451–453` ("缺 streamFn 直接抛错") asserts `runAgenticArticle`
  throws `/需要 streamFn/`. This is the **only** behavioral contract on the
  missing-`streamFn` guard (lib `347`), and it matches `makeHostStream`'s
  "需要宿主 llm 服务" sibling (test-agentic-host `124–126`) — keep the two
  messages in sync if one changes.
- `test-agentic-fallback.mjs:1–12` self-documents that it covers only the first
  two segments of the fallback chain (judgment + refillability); the third
  segment — "harvested results converge into `job.articles` by name" — is
  guarded indirectly by `test-orchestration` via the old-channel assertions and
  `tally` de-duplication (see `tally`, index `2550–2581`), not by this file.
- `shouldFallBackFromAgentic` uses a **strict-majority** rule (`failed*2 >
  length`, index `1297`). The tests at `test-agentic-fallback.mjs:40–46`
  deliberately assert that *exactly half* failure (2/4) does **not** trigger
  fallback — any change to "half counts as failure" would break those tests and
  silently widen the re-run blast radius.
- `test-articles-agentic.mjs` drives the executor with an injected `streamFn`
  (`injectedStreamFn`, lib `52`), so it never touches the host `llm` service;
  real `llm` wiring is only proven by `test-agentic-host.mjs` against a fake
  `llm`. Production behavior (dual pool limits, `markBigAgenticTasks` wiring)
  is asserted at the unit level here but the end-to-end `startAgenticRun`
  scheduling in `index.js` is out of scope of this module's tests.
