---
title: Tests for agentic, article, and contract modules
type: module
source_files:
  - test-agentic.mjs
  - test-article-contract.mjs
  - test-articles-agentic.mjs
  - test-agentic-host.mjs
  - test-agentic-fallback.mjs
  - lib/agentic.js
  - lib/article-contract.js
  - lib/articles-agentic.js
  - lib/agentic-host.js
  - index.js
tags: [tests, agentic, article-contract, articles-agentic, agentic-host, fallback]
---

## Overview

This module is a **test suite**, not a production subsystem. Its five files exercise
the agentic writing path and the article contract gate of the `@local/dsh-codewiki`
plugin. Together they guard the second writing channel (agentic tool-loop) plus the
pure-function article-contract validator that both channels rely on for落盘.

Coverage by test file:

- `test-agentic.mjs` — unit tests for `lib/agentic.js`: the tool definitions
  (`TOOL_SCHEMAS`), the four tool implementations (`makeReadCodeTool`,
  `makeListFilesTool`, `makeArticleEditor`, `buildToolset`), the dispatch loop
  (`runAgenticArticle`), prompt assembly (`buildOpeningPrompt`), and argument
  repair (`parseToolArgs`, `stripJsonFence`, `sliceBalancedObject`). Runs fully
  offline with a scripted `streamFn` and an in-memory `workspace` (lines
  1–605).
- `test-article-contract.mjs` — unit tests for `lib/article-contract.js`: the
  `inspectArticle` gate (frontmatter, required fields/sections, source_files
  validity, dead links, fences, empty-body) plus helpers `parseFrontmatter`,
  `parseYamlLite`, `extractSections`, `fencesBalanced`, `collectWikiLinks`,
  `hasDuplicateFrontmatter`, `issueSummary`, `hasBlockingIssue`, and the
  write-set gate `makeWriteSet`/`isWritable` (lines 1–239).
- `test-articles-agentic.mjs` — integration tests for `lib/articles-agentic.js`:
  `runOneArticle` (落盘, sub-module dispatch & depth cap), `runAgenticArticles`
  (pooling, dual-pool big/small tier, notes), `markBigAgenticTasks`,
  `sourceTokensOf`, `resolveTaskRoute`, and the `allowedWritePaths` gate (lines
  1–475). Uses a real temp filesystem, no network.
- `test-agentic-host.mjs` — unit tests for `lib/agentic-host.js`:
  `toRequestMessages` (naked→host Message translation, tool-result fan-out,
  stable MessageId), `makeHostStream` (chunk assembly, reasoningEffort, error
  propagation), and `makeFsWorkspace` (越界 read/list rejection) (lines 1–191).
- `test-agentic-fallback.mjs` — the agentic→single-round fallback decision:
  `shouldFallBackFromAgentic` and `prepareArticleTasks` from `index.js`, plus
  `runAgenticArticles` Map-return-on-failure behaviour (lines 1–127).

The tests are plain `node --test`-style scripts: each defines a local `check`
helper that `try/catch`es an async assertion body and tallies `pass`/`fails`,
printing `PASS`/`FAIL` per case (e.g. `test-agentic.mjs:10-21`). They are pure
Node (no test framework dependency) and import directly from the `lib/` modules.

## Key Components

### test-agentic.mjs (exercises lib/agentic.js)

`check(label, fn)` — local harness at `test-agentic.mjs:11-21`: runs `fn`,
increments `pass` on success, pushes `{label, err}` on throw, logs `PASS`/`FAIL`.

`makeWorkspace(over)` — `test-agentic.mjs:29-52`: builds an in-memory fake
`workspace` (`readFile` throws `ENOENT` for unknown paths, `listDir` emits
`{path, dir}` entries). The test `FILES` fixture (`test-agentic.mjs:24-28`) is a
3-file fake repo (`src/index.js`, `src/a.js`, `README.md`).

`assistant/ call/ text` — `test-agentic.mjs:55-59`: helpers that build
`{role:'assistant', content:[...]}` blocks; `call(id, name, args)` wraps a
tool-call with `arguments` as JSON-string or raw string.

`scripted(responses)` — `test-agentic.mjs:62-73`: returns `{fn, seen}` where
`fn` returns canned `blocks` per call (forward only), recording message counts
and tool names.

Key assertions map to production functions:

- `numberLines` prefixes each line `N| ` — `test-agentic.mjs:76-78` → `lib/agentic.js:101-106`.
- `safeRelPath` rejects `../`, absolute, `C:` — `test-agentic.mjs:80-87` → `lib/agentic.js:266-273`.
- `makeReadCodeTool` returns带行号 full text / range / `isError` paths (missing,越界, out-of-range) — `test-agentic.mjs:89-129` → `lib/agentic.js:115-177`.
- `makeListFilesTool` lists root/subdir, reports empty, hides nothing — `test-agentic.mjs:131-148` → `lib/agentic.js:179-197`.
- `makeArticleEditor` `insert`/`str_replace`/`view`: skeleton build, unique-match
  enforced, no-match hints `view`, line out-of-range, unknown command lists
  valid values, CRLF normalize-then-restore — `test-agentic.mjs:151-207`, `542-561` → `lib/agentic.js:200-263`.
- `runAgenticArticle` stop reasons: `finished` (no tool-call → keep text),
  `max-steps`, `stream-error`, `empty-response`, `aborted`; tool results feed
  back as `role:'tool'`; assistant kept verbatim (keeps tool-call); unknown tool
  → `isError`; bad JSON arg → warning; tool throw → `isError`; missing
  `streamFn` rejects — `test-agentic.mjs:210-453` → `lib/agentic.js:331-432`.
- Sub-module dispatch: `onSubModule` callback invoked; **without** `onSubModule`
  the tool must return `isError` (NOT a fake success) and must NOT say
  "已记录子模块"; `subModuleBlocked:'max-depth'` reports nested-depth limit —
  `test-agentic.mjs:380-449` → `lib/agentic.js:279-315`.
- `buildOpeningPrompt` embeds禁用项 and tool list — `test-agentic.mjs:456-462` → `lib/agentic.js:506-541`.
- `parseToolArgs` handles object直通, empty→`{}`, ```json fence strip, JSON
  embedded in prose, balanced-brace extraction that respects string literals,
  bad JSON → warning + `{}`, non-object JSON → warning — `test-agentic.mjs:464-499` → `lib/agentic.js:439-500`.
- `buildToolset` exposes exactly `edit_article`, `generate_sub_module`,
  `list_files`, `read_code` — `test-agentic.mjs:597-600` → `lib/agentic.js:279-315`.
- Read de-dup: same `(path,start,end)` re-read returns "你已在第 N 步读过"
  with real step number, does not hit FS again; different range / different file
  still reads; char cap truncates oversized single line — `test-agentic.mjs:501-571` → `lib/agentic.js:115-177`.
- `list_files` hides `node_modules`/`.git` — `test-agentic.mjs:573-587` → `lib/agentic.js:98`, `179-197`.
- `insert` with negative line errors (not silently to top) — `test-agentic.mjs:589-595` → `lib/agentic.js:231-255`.

### test-article-contract.mjs (exercises lib/article-contract.js)

`check` harness at `test-article-contract.mjs:18-23`; `GOOD(over)` builds a
valid `modules/util.md` string at `test-article-contract.mjs:34-42`; `kinds(issues)`
projects issue kinds at `:34`.

Assertions → production (`lib/article-contract.js`):

- `inspectArticle` on a good doc → `[]` — `test-article-contract.mjs:36-40` → `213-335`.
- `frontmatter-missing` / `frontmatter-unclosed` — `:42-51` → `241-246`.
- `missing-field` for absent `title`/`type`/`source_files` — `:53-58` → `248-257`.
- `type-mismatch` when `type` disagrees with directory — `:60-63` → `264-273`.
- `duplicate-frontmatter` + `duplicate-section` when body re-pastes a frontmatter — `:65-75` → `297`, `309`.
- `duplicate-section`, `missing-section`, `empty-section` — `:72-86` → `302-320`.
- `empty-section-optional` is warning-only and does not block — `:88-96` → `316-320`, `hasBlockingIssue` at `346-348`.
- `unclosed-fence` — `:98-101` → `298-299`.
- `bad-source` for dir/absolute/`../`/`C:` — `:103-108` → `279-280`, `isRepoRelativeFile` at `195-203`.
- `missing-source` via injected `fsImpl.exists` — `:110-119` → `289-292`.
- `source-not-evidence` when source not in `readableSources` — `:121-126` → `282-288`.
- `dead-link` for `[[...]]`/markdown links to non-allowed targets — `:128-134` → `323-332`.
- `empty` and `empty-body` — `:136-144` → `236-239`, `295-296`.
- `expectedType` overrides directory inference — `:146-149` → `268`.
- `parseFrontmatter` (block list, inline list, quoted value, CRLF) → `:151-158` → `77-90`.
- `parseYamlLite` ignores comments/blank lines → `:160-164` → `94-118`.
- `extractSections` ignores `##` inside fences → `:166-170` → `138-158`.
- `fencesBalanced` → `:172-175` → `161-164`.
- `collectWikiLinks` collects `[[name]]` and relative `.md` links, not external http → `:177-182` → `167-176`.
- `hasDuplicateFrontmatter` → `:184-187` → `179-193`.
- `REQUIRED_SECTIONS`/`TYPE_BY_DIR` config — `:189-194` → `19-45`.
- `_index.md` lax handling (frontmatter-missing detected, callers exempt) — `:196-201`.
- `issueSummary` formats first cause — `:203-208` → `338-343`.
- Severity split: structural breaks are `error` (blocks), missing-section is
  `warning` — `:210-218` → `SEVERITY` at `56-73`, `hasBlockingIssue` at `346-348`.
- Write-set gate `makeWriteSet`/`isWritable`: allows own target, rejects
  out-of-bounds/absolute/`../`; cwd-normalizes abs↔rel — `:220-232` → `352-378`.

### test-articles-agentic.mjs (exercises lib/articles-agentic.js)

`makeTmp()` — `test-articles-agentic.mjs:23-29`: temp dir with `src/cart.js`,
`src/order.js`. `call/text/scripted` helpers at `:31-43`. `FULL_ARTICLE` fixture at `:45`.

Assertions → production (`lib/articles-agentic.js`):

- `runOneArticle` writes to `articlePath`, returns `{ok, subModules:[]}` — `:48-63` → `33-179`.
- `generate_sub_module` recursively writes `modules/<parent>/<child>.md` — `:66-98` → `dispatchSub` at `79-128`.
- Duplicate sub names get parent prefix, never overwrite — `:100-124` → `85-94`.
- `subDepth=0` disables dispatch (`subModules` empty) — `:126-141` → `82-84`.
- `subDepth` cap actually enforced (disk depth ≤ cap; model-call count bounded) — `:182-215` → production depth increment at `lib/articles-agentic.js:117-121`; the disk scan `scanArticleDepths` (`test-articles-agentic.mjs:151-163`) and the "always dispatch" driver `alwaysDispatch` (`167-180`) are **test helpers** that keep the assertion order-insensitive by design.
- Sub-module failure is accounted, parent still `ok` — `:217-245` → `122-127`, `148-178`.
- `runAgenticArticles` aggregates `subModules` and pushes a note ("派生出 N 个子模块文章") — `:248-270` → `257-311`.
- One task's stream error does not break others; recorded as note — `:272-293` → `300-304`.
- `markBigAgenticTasks` stamps big tier when `sizeOf > budget`; pure (does not
  mutate input); undefined when bigTier unconfigured; omits `reasoningEffort`
  when not passed — `:299-329` → `320-333`.
- Dual pool (big + default) both finish and落盘; `bigConcurrency=0` falls back to
  `concurrency` — `:331-387` → `231-312`.
- `resolveTaskRoute`: task provider/model override defaults; effort stays empty
  for big task (not default's `'off'`); half-missing provider falls back — `:349-365` → `208-222`.
- `sourceTokensOf` estimates CJK=1/nCJK=ceil(len/3.5), skips unreadable — `:389-397` → `185-203`.
- `allowedWritePaths` gate: out-of-bounds → `ok:false`/`stopReason:'write-set'`,
  no file written; inside set writes; unset → legacy behaviour; child gets only
  its own path — `:399-470` → `67`, `151-167`.

### test-agentic-host.mjs (exercises lib/agentic-host.js)

`check` harness at `test-agentic-host.mjs:8-13`. `fakeLlm(chunkScripts)` at `:67-77`.

Assertions → production (`lib/agentic-host.js`):

- `toRequestMessages`: user→`UserMessage` w/ id; assistant carries
  provider/model + tool-call; **one** tool message with multiple results fans
  out to multiple `ToolResultMessage` (preserving `toolCallId`/`source.callId`/
  `isError`); existing-id assistant passes through; unknown role ignored —
  `test-agentic-host.mjs:18-64` → `34-79`.
- Stable `MessageId` across repeated conversion (identity preserved across
  boundaries) — `:171-184` → `WeakMap` identity at `26`, `40-75`.
- `makeHostStream`: assembles chunks into `blocks`, passes `tools` through,
  `temperature:0`, omits `tools` when empty, throws on `finish:error`,
  throws without `llm`, forwards `reasoningEffort` — `:79-134` → `83-108`.
- `makeFsWorkspace`: reads files, lists dirs with `dir` flag, full relative
  paths for subdirs, rejects越界 read/list (`../../etc/passwd`, `../..`) —
  `:142-168` → `111-135`.

### test-agentic-fallback.mjs (exercises index.js fallback + runAgenticArticles)

`check` harness at `test-agentic-fallback.mjs:18-21`. Imports `shouldFallBackFromAgentic`,
`prepareArticleTasks` from `./index.js` and `runAgenticArticles` from
`./lib/articles-agentic.js` — `test-agentic-fallback.mjs:13-14`. `r(ok)`/`rn(name,ok)`
fixtures at `:23-24`.

Assertions → production (`index.js`):

- `shouldFallBackFromAgentic`: empty/null→`false`; all-success→`false`; 1/4
  failure→`false`; exactly half (2/4)→`false` (strict majority); 3/4→`true`;
  1/1 and 3/3→`true` — `test-agentic-fallback.mjs:27-51` → `1293-1298`.
- `prepareArticleTasks` turn a retried agentic task (with `mission`/`articlePath`)
  into an装填able single-round request whose batchPrompt contains source text;
  keeps `name` so harvest matches — `:59-73` → `1165-1250` (and `collectSources`
  at `1094-1121`, `batchArticlePrompt` at `1125-1152`).
- Missing `mission` still fills (no silent drop) — `:75-85` → `1165-1250`.
- Missing source file degrades to a still-present single task — `:87-98`.
- `runAgenticArticles` with `llm:null` returns a `Map`, one entry per task, each
  `ok:false` (per-task failure, not whole-batch throw) → `shouldFallBackFromAgentic`
  sees majority-fail — `:101-120` → `231-312`.

## Architecture

The five test files split cleanly by the two production components they pin down:
`lib/agentic.js` (the tool-loop + tools) and `lib/article-contract.js` (the落盘
gate), plus their orchestration wrappers `lib/articles-agentic.js` /
`lib/agentic-host.js`, and the fallback glue in `index.js`.

```text
test-agentic.mjs ───────────────► lib/agentic.js
   (offline streamFn, fake ws)      runAgenticArticle
                                   makeReadCodeTool / makeListFilesTool
                                   makeArticleEditor  / buildToolset
                                   buildOpeningPrompt / parseToolArgs

test-article-contract.mjs ──────► lib/article-contract.js
   (string in, inspectArticle)      inspectArticle / hasBlockingIssue
                                   parseFrontmatter / extractSections
                                   makeWriteSet / isWritable

test-articles-agentic.mjs ──────► lib/articles-agentic.js
   (temp fs, scripted llm)          runOneArticle ── dispatchSub (recurse)
                                   runAgenticArticles (dual pool)
                                   markBigAgenticTasks / sourceTokensOf

test-agentic-host.mjs ──────────► lib/agentic-host.js
   (fakeLlm chunk seq)              toRequestMessages / makeHostStream
                                   makeFsWorkspace

test-agentic-fallback.mjs ───────► index.js
   (r()/rn() fixtures)              shouldFallBackFromAgentic
                                   prepareArticleTasks  ◄── lib/articles-agentic.js / collectSources
                                   runAgenticArticles (Map return on failure)
```

All five are standalone `node` scripts (no runner import). Each owns a local
`check(label, fn)` tally loop; production modules are imported by relative path
(`./lib/agentic.js`, `./index.js`, …). No mocking library — `streamFn` and
`workspace` are hand-rolled closures.

## Data Flow

Per test family:

1. **Agentic loop (test-agentic.mjs).** The script builds `FILES` + `makeWorkspace`,
   then drives `runAgenticArticle({ mission, workspace, streamFn })`. `streamFn`
   returns canned `blocks`; `runAgenticArticle` runs the loop
   (`lib/agentic.js:367-423`): push assistant → execute tool calls → push `role:'tool'`
   result → repeat until `stopReason`. Tests read back `r.article`,
   `r.stopReason`, `r.usedTools`, `r.steps`. Tool-result fan-out and MessageId
   stability are verified through `lib/agentic-host.js` in the separate host test.

2. **Contract gate (test-article-contract.mjs).** A markdown string (often via
   `GOOD()`) is fed straight to `inspectArticle(content, {articlePath, cwd,
   fsImpl, readableSources, allowedLinks})` (`lib/article-contract.js:213-335`);
   the returned `issues[]` array is matched on `kind` (`frontmatter-missing`,
   `missing-field`, `duplicate-frontmatter`, `bad-source`, `dead-link`,
   `unclosed-fence`, `empty-section`, `empty-section-optional`, …). Severity is
   split by `SEVERITY` (`lib/article-contract.js:56-73`) and gated by
   `hasBlockingIssue` (`346-348`). The write-set helpers `makeWriteSet`/`isWritable`
   (`352-378`) take explicit path arrays.

3. **Runner (test-articles-agentic.mjs).** `makeTmp()` gives a real temp repo;
   `runOneArticle` writes `articlePath` (or a child path under
   `modules/<parent>/<child>.md` when `generate_sub_module` fires), then
   `fs.readFileSync` asserts the file content. `runAgenticArticles` returns a
   `Map(customId→{ok,stopReason,subModules})`; notes are appended to the passed
   `notes[]` array. `markBigAgenticTasks`/`sourceTokensOf`/`resolveTaskRoute` are
   pure functions checked on their return value.

4. **Host adapter (test-agentic-host.mjs).** `toRequestMessages` turns naked
   messages into host Messages; `makeHostStream` consumes a `fakeLlm` chunk
   generator and yields `{blocks, finish, usage}`; `makeFsWorkspace` wraps
   `fs`/`path`/`cwd` and throws on越界.

5. **Fallback (test-agentic-fallback.mjs).** `shouldFallBackFromAgentic(results)`
   (`index.js:1293-1298`) returns a boolean from a `results`-like array;
   `prepareArticleTasks` (`index.js:1165-1250`) converts retried agentic tasks
   into装填able single-round requests; `runAgenticArticles` is asserted to return
   a per-task `Map` even when `llm:null` (no whole-batch throw).

## Connections

- [[agentic]] — the production module under test (`lib/agentic.js`): tool-loop,
  four tools, prompt assembly. See also `lib/articles-agentic.js`
  ([[articles-agentic]]) and the host adapter `lib/agentic-host.js`
  ([[agentic-host]]) that these tests pin down.
- [[article-contract]] — the落盘 gate (`lib/article-contract.js`) verified by
  `test-article-contract.mjs`; both writing channels route through `inspectArticle`.
- [[index]] — `index.js` owns `shouldFallBackFromAgentic`, `prepareArticleTasks`,
  `runAgenticArticles` wiring, and the dual-pool big/small tier dispatch that
  `test-articles-agentic.mjs` and `test-agentic-fallback.mjs` exercise.
- [[engine-orchestration]] — the `tickArticles` stage machine in `index.js`
  (around `index.js:2880-3099`) is where agentic runs are launched and where
  `shouldFallBackHere`/`shouldFallBackFromAgentic` trigger the single-round
  fallback; these tests guard that decision boundary.

## Known Issues

- **No unified runner / no `package.json` test script.** The five files are
  standalone `node` scripts with hand-rolled `check` loops; there is no test
  runner in `package.json` (`package.json:1-29` has no `scripts.test`). They must
  be run individually (e.g. `node test-agentic.mjs`), so coverage is opt-in and
  easy to skip in CI.
- **Fallback test only covers two of three fallback legs.** `test-agentic-fallback.mjs:1-8`
  documents that leg ③ (harvest into `job.articles` by name, no double counting)
  is only indirectly guarded by `test-orchestration.mjs` and `tally`'s
  `mergeByName` logic in `index.js` — not directly asserted here.
- **`subDepth` regression is order-insensitive, not exact.** Because the old
  implementation's bug caused unbounded recursion (stack overflow at `subDepth=2`),
  `test-articles-agentic.mjs:143-215` deliberately asserts only disk depth ≤ cap
  and bounded call count rather than a precise call sequence, trading specificity
  for brittleness resistance.
- **`test-agentic.mjs` asserts 4 tools are exposed even without `onSubModule`.**
  `test-agentic.mjs:438-449` confirms `generate_sub_module` remains a declared
  tool (returning an honest `isError` when `onSubModule` is absent), rather than
  being hidden — a deliberate contract that prevents silent dead links.
- **No tests for `getDelta`/chunk `usage` accounting** in `makeHostStream`; the
  host test stubs `usage` only inside the fake llm and never asserts on the
  assembled `usage` field (`test-agentic-host.mjs:79-134`).
- **`index.js` import in fallback test is heavy.** `test-agentic-fallback.mjs:13`
  imports from the 4800-line `index.js` merely to reach `shouldFallBackFromAgentic`
  and `prepareArticleTasks`; any break in `index.js`'s top-level import graph
  would fail this otherwise-pure test.
