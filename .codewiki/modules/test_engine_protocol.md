---
title: test_engine_protocol
type: module
source_files:
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/engine/client.js
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
tags: [test, engine, contract, client, bridge, protocol]
---

## Overview

The `test_engine_protocol` module is a test suite of four root-level `.mjs` files that pins down the **native engine channel** migration — the path where a Node plugin drives the upstream FSoft Python engine as a subprocess instead of re-implementing its algorithm in Node. It locks in three pillars, because the cross-process boundary becomes the single source of truth:

1. **Engine contract + output mapping** — `test-engine-contract.mjs` pins the shape/semantics of `EngineResult` / `EngineProgress` / `EngineError` (`lib/engine/contract.js`) and the FSoft docs-tree → CodeWiki.md / `.codewiki/` mapping (`lib/engine/mapping.js`). The hard invariants: `done` must NOT carry blockers, `partial` MUST carry at least one blocker, and unmapped pages must never be silently dropped.
2. **Node ↔ Python thin adapter** — `test-engine-client.mjs` pins `lib/engine/client.js` at two layers: the pure protocol reader (`createProtocolReader`) and the real-spawn process layer (`runEngine`). Priority is "what happens when the protocol breaks" (half-line JSON, wrong requestId, exit code 0 but failed) rather than the happy path.
3. **Host model loopback bridge** — `test-engine-bridge.mjs` pins the *pure* OpenAI↔DSH conversions in `lib/engine/openai-bridge.js`, and `test-engine-llm-bridge.mjs` pins the *server* boundary in `lib/engine/llm-bridge.js`: the credential gate (127.0.0.1 + random port + placeholder key) and the SSE/usage streaming.

All four files share the same lightweight harness: a `check(label, fn)` helper (e.g. `test-engine-contract.mjs:34-37`, `test-engine-client.mjs:29-32`, `test-engine-bridge.mjs:31-34`, `test-engine-llm-bridge.mjs:22-25`) that tallies `pass`/`fails`, prints `PASS`/`FAIL`, and sets `process.exitCode = 1` on any failure. No external test runner is used.

## Key Components

### Test files (this module's components)

| File | Lines | Subject under test | Imports asserted |
|------|-------|--------------------|------------------|
| `test-engine-contract.mjs` | 1–340 | `contract.js` result shape + `mapping.js` FSoft→wiki mapping | `ENGINE_CONTRACT_VERSION`, `ENGINE_STAGES`, `TERMINAL_OUTCOMES`, `engineError`, `engineProgress`, `engineResult`, `validateEngineResult`, `describeEngineResult` (`14-23`); `mapFsoftOutput`, `moduleSlug`, `WIKI_ENTRY`, `WIKI_UPDATE_RECORD_REL`, `WIKI_META_REL` (`24-30`) |
| `test-engine-client.mjs` | 1–365 | `client.js` protocol + process layers | `createProtocolReader`, `runEngine`, `ENGINE_PROTOCOL_VERSION` (`21-25`) |
| `test-engine-bridge.mjs` | 1–421 | `openai-bridge.js` pure conversion | `toLlmRequest`, `finishReasonToOpenAI`, `chunksToCompletion`, `sseFrame`, `chunksToSse`, `PLACEHOLDER_KEY_PATTERN`, `isPlaceholderKey` (`19-27`) |
| `test-engine-llm-bridge.mjs` | 1–300 | `llm-bridge.js` HTTP server boundary | `startLlmBridge` (`18`) |

### `lib/engine/contract.js` — public API exercised by `test-engine-contract.mjs`

| Symbol | Line | Kind | Purpose |
|--------|------|------|---------|
| `ENGINE_CONTRACT_VERSION` | 20 | const | Version stamp baked into every result; contract assertions check it equals `1` (`test-engine-contract.mjs:44`). |
| `ENGINE_STAGES` | 24–33 | const (array) | Ordered pipeline stages `['env','graph','cluster','articles','validate','index','baseline','commit']`; asserted exactly at `test-engine-contract.mjs:45`. |
| `TERMINAL_OUTCOMES` | 35 | const | Frozen `['done','partial','failed','cancelled']`; asserted at `test-engine-contract.mjs:46`. |
| `UPDATE_OUTCOMES` | 45–50 | const | Incremental outcomes incl. `full_fallback`/`detector_failure` (means "engine didn't really increment"). |
| `CONSUMING_UPDATE_OUTCOMES` | 53 | const | `['incremental','no_change']` = only these advance the baseline. |
| `BLOCKER_KINDS` | 57–72 | const | Frozen list of machine-readable blocker categories (append-only). |
| `ENGINE_ERROR_CODES` | 76–86 | const | Frozen list of `engine-*` error codes; `RETRYABLE_CODES` (`90`) = `engine-timeout`/`engine-model`/`engine-unknown`. |
| `engineResult(input)` | 116–185 | fn | Whitelist-normalizes a result; throws on non-terminal outcome (`test-engine-contract.mjs:49-52`), on `done`+blockers (`54-59`), on `partial` w/o blockers (`61-71`); normalizes counts to non-negative (`73-82`) and preserves `engine.deps` evidence (`84-105`). Returns object with `contractVersion`, `outcome`, `stage`, `blockers`, `error`, counts, `updateOutcome`, `usage`, `engine`, `artifacts`, `startedAt`/`finishedAt`. |
| `engineProgress(input)` | 188–206 | fn | Validates `stage ∈ ENGINE_STAGES` (else throw, `test-engine-contract.mjs:107-108`); clamps `percent` to 0–100 (`109-113`). |
| `engineError(input)` | 209–220 | fn | Maps unknown code → `engine-unknown`, sets `retryable` from `RETRYABLE_CODES`; keeps raw text in `rawCode`. Asserted at `test-engine-contract.mjs:116-127`. |
| `validateEngineResult(value)` | 224–265 | fn | Non-throwing validator returning `{ok, errors}`; checks version mismatch, `done`+blockers, `partial`−blockers, non-negative counts, blocker kinds, `failed`−error, `updateOutcome` enum. Asserted at `129-143`. |
| `describeEngineResult(result)` | 268–285 | fn | Human text for 4 outcomes; `partial` embeds first blocker detail. Asserted at `145-156`. |

### `lib/engine/mapping.js` — public API exercised by `test-engine-contract.mjs`

| Symbol | Line | Kind | Purpose |
|--------|------|------|---------|
| `WIKI_ENTRY` | 31 | const | `'CodeWiki.md'` — overview entry path. |
| `WIKI_DIR` | 32 | const | `'.codewiki'`. |
| `WIKI_META_REL` | 33 | const | `'.codewiki/_meta.yaml'`. |
| `WIKI_UPDATE_RECORD_REL` | 34 | const | `'.codewiki/temp/update-record.json'`. |
| `WIKI_MODULES_REL` | 35 | const | `'.codewiki/modules'`. |
| `moduleSlug(name)` | 39–45 | fn | ASCII → kebab-case; non-ASCII folded to `-`; `''` → `''`. Asserted at `test-engine-contract.mjs:189-194`. |
| `mapFsoftOutput({pages,moduleTree,componentFiles,metadata,updateRecord,overviewName})` | 114–267 | fn | Pure mapping. Returns `{contractVersion, entry, articles, unmapped, meta, updateRecord, warnings}`. Hard rules: never fabricate `sourceFiles` (`test-engine-contract.mjs:237-258`), never silently drop unmapped (`260-271`), conflict → both unmapped (`292-305`), move update_record unchanged (`307-327`), empty pages still serializable (`329-334`). |

Note: `mapping.js` also exposes internal helpers `sourceFilesOf` (61–71, derives files from `id::Sym` or `componentFiles`) and `indexModuleTree` (75–95) used by the assertions at `test-engine-contract.mjs:237-258`.

### `lib/engine/client.js` — public API exercised by `test-engine-client.mjs`

| Symbol | Line | Kind | Purpose |
|--------|------|------|---------|
| `ENGINE_PROTOCOL_VERSION` | 27 | const | Line-format version (separate from `ENGINE_CONTRACT_VERSION`). Asserted at `test-engine-client.mjs:148-154`. |
| `createProtocolReader({requestId,maxLineBytes})` | 39–186 | fn | Incremental JSON-lines reader. `push(chunk)` buffers bytes (multi-byte UTF-8 safe), emits progress; `markCancelled()`; `end()` flushes half-line as `not-json`. Protocol invariants: non-JSON → `not-json` (`test-engine-client.mjs:52-62`), half-line → `not-json` (`64-71`), unknown requestId isolated (`73-90`), duplicate result → first wins (`92-99`), bad type → `bad-shape` (`101-106`), cancel → `late-result` (`108-116`), CRLF/empty tolerated (`118-127`), multi-byte safe (`129-138`), line cap (`140-146`). |
| `runEngine(options)` | 223–422 | fn | Spawns engine, writes one request JSON to stdin, normalizes to `EngineResult`. Handles timeout (`368-374`), abort/cancel (`376-391`), crash-without-result (`403-414`), nonzero-exit recorded as violation (`416-419`). |

Key process-layer helpers in the test: a fake Python engine script written to `tmp/fake_engine.py` (`test-engine-client.mjs:162-218`) with `FAKE_MODE` env controlling emitted protocol (`ok`, `garbage`, `noresult`, `failed-but-exit0`, `done-but-exit3`, `crash`, `slow`, `late`, `wrongid`); `pyEngine(mode)` (`237-241`) and `fakeEngine(mode)` node-wrapper (`220-233`) to inject `FAKE_MODE` on Windows.

### `lib/engine/openai-bridge.js` — public API exercised by `test-engine-bridge.mjs`

| Symbol | Line | Kind | Purpose |
|--------|------|------|---------|
| `PLACEHOLDER_KEY_PATTERN` | 29 | const regex | `/^dsh-bridge-[a-z0-9-]+$/`. |
| `isPlaceholderKey(value)` | 31–33 | fn | True only for bridge-issued placeholder keys. Asserted at `test-engine-bridge.mjs:340-346`. |
| `toLlmRequest({provider,model,reasoningEffort,body})` | 128–161 | fn | OpenAI request → DSH `GenerateOptions`. System pulled to `system` slot (`test-engine-bridge.mjs:40-59`), assistant `tool_calls` → tool-call blocks with raw JSON string (`66-91`), `tool` → tool result with `toolCallId` (`93-109`), `tools` → `ToolSchema` (`111-132`), params mapped (`134-151`), no empty messages/provider/model (`167-175`). |
| `finishReasonToOpenAI(reason)` | 164–173 | fn | Maps `stop`/`tool-calls`/`max-tokens`/`error`/`aborted`. Asserted at `test-engine-bridge.mjs:181-188`. |
| `chunksToCompletion({id,model,chunks})` | 236–256 | fn | Assembles non-streaming response; tool args concatenated (`test-engine-bridge.mjs:192-225`), content `null` when only tools (`227-236`), reasoning excluded from content (`258-268`). |
| `sseFrame(payload)` | 259–262 | fn | `data: <json>\n\n`; `[DONE]` is its own frame. Asserted at `test-engine-bridge.mjs:274-277`. |
| `chunksToSse({id,model,created,chunks})` | 265–317 | fn | SSE frames; first frame has `role`, text deltas per frame, `usage` own frame (`test-engine-bridge.mjs:320-334`), terminates with `[DONE]` (`315`). |

### `lib/engine/llm-bridge.js` — public API exercised by `test-engine-llm-bridge.mjs`

| Symbol | Line | Kind | Purpose |
|--------|------|------|---------|
| `startLlmBridge({llm,provider,model,reasoningEffort,timeoutMs,onLog})` | 90–241 | fn | Starts HTTP server bound to `127.0.0.1:0`. Returns `{url, placeholderKey, port, stats(), close()}`. Generates random `placeholderKey` (`96`), rejects non-matching keys with 401 (`118-126`), `/v1/models` (`128-131`), `/healthz` (`112-115`), proxies to `llm.stream` with abort on client close/timeout (`163-167`), non-stream returns `chunksToCompletion` (`216-218`), stream returns `chunksToSse` terminated by `[DONE]` (`183-213`), upstream failure → 502 / error frame (`189-203`). Missing `llm`/`provider`/`model` throws (`91-93`, asserted `test-engine-llm-bridge.mjs:290-294`). |

## Architecture

Four test files wrap five source modules across two boundaries (engine subprocess and host-model loopback). The protocol reader and the mapping are pure; the process layer and the HTTP bridge are exercised against real subprocesses / a real local server with a `fakeLlm`.

```text
┌────────────────────┐  JSON-lines (stdio) ┌────────────────────────┐
│ FSoft Python engine│ ──────────────────► │ lib/engine/client.js    │
│ (subprocess)       │ ◄────────────────── │ createProtocolReader    │
└────────────────────┘  request + stdin    │ runEngine (spawn)       │
                                           └───────────┬────────────┘
                                                       │ EngineResult
                                                       ▼
                              ┌──────────────────────────────────────┐
                              │ lib/engine/contract.js  (shape/validate)│
                              │ lib/engine/mapping.js   (mapFsoftOutput)│
                              └──────────────────────────────────────┘

┌────────────────────┐  OpenAI /v1   ┌──────────────────────┐  GenerateOptions ┌──────────────────────┐
│ FSoft engine (LLM) │ ─────────────► │ lib/engine/llm-bridge│ ───────────────► │ openai-bridge.js     │
│                    │ ◄───────────── │ startLlmBridge (HTTP)│ ◄─────────────── │ toLlmRequest/chunksTo│
└────────────────────┘  SSE / JSON    └──────────────────────┘  StreamChunks    └──────────────────────┘

Test wrappers: test-engine-contract.mjs · test-engine-client.mjs ·
               test-engine-bridge.mjs · test-engine-llm-bridge.mjs
```

## Data Flow

**Contract / mapping path** (`test-engine-contract.mjs`): the test builds synthetic `moduleTree`/`componentFiles`/`metadata` fixtures (e.g. `162-187`) and calls `mapFsoftOutput(...)` (e.g. `196-212`), then asserts the resulting `entry`/`articles`/`unmapped`/`meta`/`updateRecord`. Contract tests feed raw objects into `engineResult`/`engineProgress`/`engineError`/`validateEngineResult`/`describeEngineResult` and assert throws + normalized fields (e.g. `49-156`).

**Client protocol path** (pure, `test-engine-client.mjs:39-154`): construct `createProtocolReader({requestId})`, `push(JSON.stringify(...)+'\n')` per message, `end()`, assert `outcome`/`violations`/`progress`/`endedWithResult`. Violation kinds asserted: `not-json`, `unknown-request`, `duplicate-result`, `bad-shape`, `late-result`, `line-too-long`, `protocol-version`.

**Client process path** (real spawn, `test-engine-client.mjs:156-361`): `runEngine({engine: pyEngine(mode), requestId, action, timeoutMs, signal?})` spawns the fake Python engine; the test asserts final `outcome`, `error.code`, `protocolViolations`, `exitCode`, `terminated`. Modes exercise garbage/no-result/exit-code-vs-semantic mismatch/crash/timeout/cancel/wrong-requestId (`243-360`).

**Bridge conversion path** (pure, `test-engine-bridge.mjs`): call `toLlmRequest`/`chunksToCompletion`/`chunksToSse`/`finishReasonToOpenAI`/`sseFrame` directly and assert the OpenAI-shaped output (e.g. `40-356`).

**Bridge server path** (real HTTP, `test-engine-llm-bridge.mjs`): `withBridge({llm: fakeLlm(...), provider, model}, ...)` starts `startLlmBridge`, then `post(bridge, body, {key})` issues real `fetch` to `${bridge.url}/chat/completions`; the test asserts status (200/400/401/502), OpenAI body shape, SSE `[DONE]` termination, credential rejection, and that upstream `signal` is aborted on client disconnect/timeout (`59-294`).

## Connections

- [[engine_contract]] — `lib/engine/contract.js` result/shape layer pinned by `test-engine-contract.mjs`.
- [[engine_mapping]] — `lib/engine/mapping.js` FSoft→wiki mapping pinned by the same test file.
- [[engine_client]] — `lib/engine/client.js` protocol+process adapter pinned by `test-engine-client.mjs`.
- [[openai_bridge]] — `lib/engine/openai-bridge.js` pure conversions pinned by `test-engine-bridge.mjs`.
- [[llm_bridge]] — `lib/engine/llm-bridge.js` HTTP credential gate pinned by `test-engine-llm-bridge.mjs`.
- Related real-model/end-to-end probes live outside this module (referenced in comments at `test-engine-bridge.mjs:17` and `test-engine-client.mjs:4`): `1B`/`1C` real-model tests cover live provider behavior.

## Known Issues

None of the code under test is disabled, commented-out, or feature-flagged off in these four files. Documented limitations (not defects) worth knowing for future agents:

- **Pure-conversion bridge tests do not start a server** — `test-engine-bridge.mjs:17` states that real model calls are covered separately by `1B` live-model tests; this file only pins the pure transforms.
- **Process-layer client tests require a Python interpreter.** The fake engine is a real `python` subprocess (overridable via the `FSOFT_TEST_PY` env var, `test-engine-client.mjs:224`/`:238`). On Windows, a Node wrapper (`fakeEngine`, `220-233`) injects `FAKE_MODE` so `env` is set reliably; the direct `pyEngine` (`237-241`) is the primary path.
- **Half-line / CRLF robustness** is covered at the unit level (`test-engine-client.mjs:64-127`) but depends on the real engine honoring newline-delimited JSON-lines; the contract can only assert *our* reader, not the writer.
- **`unknown-request` vs missing-result ordering**: the protocol reader treats a missing `requestId` as `unknown-request` (`test-engine-client.mjs:84-90`) — there is no default fallback, by design.
