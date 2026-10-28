---
title: _patterns
type: pattern
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/engine/process-tree.js
  - lib/symbols.js
  - lib/graph-diff.js
  - lib/agentic.js
  - lib/articles-agentic.js
  - lib/agentic-host.js
  - lib/article-contract.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/change-set.js
  - lib/update-record.js
  - lib/cluster.js
  - index.js
  - test-batch.mjs
  - test-orchestration.mjs
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
tags: [patterns, conventions, error-handling, build-test, directory]
---

## Overview

本仓库在多个模块文章中反复出现一组跨文件的工程约定与风格。这些模式覆盖了命名约定（常量/函数/文件布局）、错误处理风格（非法输入抛错 vs 降级返回、凭证边界、日志白名单）、构建与测试流程（纯函数 + TDD 钉死、mock 宿主、顶层自检脚本）、目录与模块约定（`lib/engine/` 薄适配层、`Map`/Set 数据形状、`type` frontmatter 体系）。下文每节归纳一个模式，并引用具体模块文章中出现过的文件与函数名作为证据。

## Patterns

### 1. 纯函数内核 + 薄 I/O 或网络边界分层

仓库反复把「无副作用的纯逻辑」与「文件/网络/进程」隔离在不同文件或同一文件的不同函数层，便于单测钉死。

- `lib/engine/openai-bridge.js` 是纯转换层（无 I/O、无网络、无密钥），而 `lib/engine/llm-bridge.js` 的 `startLlmBridge` 负责 HTTP 监听与凭证看门人（`engine_llm_bridge.md` / `engine_openai_bridge.md`）。
- `lib/engine/contract.js` 的 `engineResult` / `validateEngineResult` / `describeEngineResult` 均为无副作用纯函数，不碰文件进程（`engine_contract.md`）。
- `lib/incremental.js` 中 `slimGraph` / `filterStaleTasks` / `graphFromSnapshot` 是纯函数，而 `loadSnapshot` / `saveSnapshot` 是仅有的 IO 边界（`incremental.md`）。
- `lib/update-record.js` 的 `judgeOutcome` / `buildUpdateRecord` 是纯函数，`saveUpdateRecord` / `loadUpdateRecord` 带 `fsImpl` 注入点（`update_record.md`）。
- `lib/agentic.js` 是纯逻辑层（工具循环 `runAgenticArticle` 注入 `streamFn`），`lib/agentic-host.js` 是宿主 llm 适配层（`agentic_core.md`）。

### 2. 凭证边界：loopback + 随机端口 + 占位 key，转换层永不见真实 key

引擎适配层严格隔离宿主凭证，桥只接受自己签发的占位 key，`toLlmRequest` 返回值永远不含 `apiKey`。

- `lib/engine/llm-bridge.js` 的 `startLlmBridge` 绑定 `127.0.0.1` 随机端口、随机生成 `dsh-bridge-${randomBytes(32).toString('hex')}` 占位 key，`bearerOf` 取完即弃（`engine_llm_bridge.md`）。
- `lib/engine/openai-bridge.js` 的 `toLlmRequest({ provider, model, reasoningEffort, body })` 返回对象无 `apiKey` 字段，`PLACEHOLDER_KEY_PATTERN` 只校验格式（`engine_openai_bridge.md`）。
- `lib/engine/process-tree.js` 自身不读任何凭证，`onLog` 仅拼命令文本，测试断言其不含 api_key/token（`engine_process.md`）。
- `test-batch.mjs` 显式断言 `resolveBatchApiKey` 已删除、插件不碰任何密钥（`batch_tests.md`）。

### 3. 非法输入抛错 vs 降级返回的双重约定

构造/校验函数对「契约破坏」直接抛错，而对「外部/旧数据/采集不全」则返回带 `fallback` 的安全结构，不静默假装成功。

- `lib/engine/contract.js` 的 `engineResult` 在 `done` 带 blockers 或 `partial` 无 blockers 时抛错；而 `validateEngineResult` 不抛、返回 `{ ok, errors }`（`engine_contract.md`）。
- `lib/change-set.js` 的 `collectChangeSet` 在 git 不可达时返回 `state:'no-git'`、`fallback:'full'` 的 `ChangeSet`，调用方退回全量而非假装 clean（`change_set.md`）。
- `lib/incremental.js` 的 `loadSnapshot` 在版本不符/坏 JSON 时静默返回 `null`，调用方退化为全量（`incremental.md`）。
- `lib/cluster.js` 的 `clusterComponents` 在 LLM 抛错/空计划时回落 `heuristicCluster`，保证组件零丢失（`cluster_planning.md`）。

### 4. 日志字段白名单与无凭证泄露约定

跨进程/跨边界日志只序列化固定字段，靠约定而非强制 redaction 中间件防止凭证泄露。

- `lib/engine/llm-bridge.js` 的 `finish(status)` 仅回调 `{at, method, path, status, ms}`，`onLog` 不含 Authorization；`test-engine-llm-bridge.mjs` 用正则反向钉住（`engine_llm_bridge.md`）。
- `lib/engine/process-tree.js` 的 `onLog` 仅记 `taskkill`/`SIGTERM`/`SIGKILL` 命令文本，测试断言不含 api_key/authorization（`engine_process.md`）。
- `lib/update-record.js` 的 `buildUpdateRecord` 故意不含整张符号图与任务快照，避免敏感/庞大数据落盘（`update_record.md`）。

### 5. 版本化契约常量与快照格式守卫

跨进程/跨会话数据均带版本戳，旧格式/版本不符直接丢弃或报错。

- `lib/engine/contract.js` 的 `ENGINE_CONTRACT_VERSION = 1`，被 `lib/engine/mapping.js` 的 `mapFsoftOutput` 输出携带（`engine_contract.md` / `engine_mapping.md`）。
- `lib/incremental.js` 的 `SNAPSHOT_VERSION = 1`，`loadSnapshot` 校验不符返回 `null`（`incremental.md`）。
- `lib/update-record.js` 的 `UPDATE_RECORD_VERSION = 1`，`loadUpdateRecord` 版本不符返回 `null`（`update_record.md`）。
- `lib/change-set.js` 的 `CHANGE_SET_VERSION = 1` 写入每个 `ChangeSet.version`（`change_set.md`）。
- `lib/update-planner.js` 的 `UPDATE_PLAN_VERSION = 1` / `MODULE_MAP_VERSION = 1`（`update_planner.md`）。

### 6. 组件 id 与路径约定统一

符号/组件 id 与相对路径处理在全仓库保持一致形态，避免 Windows 盘符与越界问题。

- `lib/symbols.js` 的 `componentId(relPath, name)` 返回 `${relPath}#${name}`，注释明确用 `#` 避免 Windows 盘符 `:` 混淆（`symbol_extraction.md`）。
- `lib/graph-diff.js` 的节点形状 `{id, name, kind, relativePath, ...}` 与 `lib/symbols.js` 提取契约一致，id 同为 `<相对路径>#<符号名>`（`graph_diff.md`）。
- `lib/change-set.js` 的 `normChangePath` 拒绝绝对路径/`..`/盘符；`lib/incremental.js` 的 `normRel` 把 `\` 换成 `/` 并去 `./` 前缀（`change_set.md` / `incremental.md`）。
- `lib/engine/mapping.js` 的 `moduleSlug(name)` 把模块名转 kebab-case（`engine_mapping.md`）。

### 7. 双池并发：默认档与大档模型分池限流

批量文章执行器普遍把任务按「是否大档」分两个独立限流池同时推进。

- `lib/articles-agentic.js` 的 `runAgenticArticles` 分 `normalTasks` / `bigTasks` 双池，`bigConcurrency` 缺省回落 `concurrency`（`articles_agentic.md`）。
- `index.js` 的 `runRealtimeTasks` 按 `bigTier` 标记分进两个独立限流池（`prepareArticleTasks` 打标），`test-batch.mjs` 用 `poolProbe` 探测峰值（`batch_tests.md`）。
- `lib/articles-agentic.js` 的 `markBigAgenticTasks` 按源文本量超 `budget` 打大档标记，与 `resolveTaskRoute` 配合选档（`articles_agentic.md`）。

### 8. 测试风格：TDD 钉死纯函数 + mock 宿主离线跑

仓库测试要么直接 import 纯函数做断言，要么用 mock llm/ctx 跑端到端，不依赖真实密钥或网络。

- `lib/engine/openai-bridge.js` 的 `toLlmRequest` / `chunksToSse` 被 `test-engine-bridge.mjs` 直接 TDD 钉死（`engine_openai_bridge.md`）。
- `test-orchestration.mjs` 的 `makeBatchMock` / `llmProxy` / `fakeReq` / `fakeRes` 造离线假宿主，驱动 `apply(ctx, cfg)` 冒烟（`agent_mocks.md`）。
- `test-batch.mjs` 用 `makeLlm` 模拟 `llm.stream` 协议，覆盖 `index.js` 的 `runRealtimeTasks` / `prepareArticleTasks` 等（`batch_tests.md`）。
- `test-graphdiff.mjs` 对照 `test-fixtures/gen-graphdiff-golden.py` 产出的 golden JSON 逐位比对（`graph_diff.md`）。

### 9. `lib/engine/` 薄适配层与 FSoft 迁移边界

引擎相关代码集中在 `lib/engine/`，分为「loopback 桥」「纯转换」「跨进程契约」「产物映射」「进程树终止」几个并行边界。

- `lib/engine/llm-bridge.js` + `lib/engine/openai-bridge.js`：模型 loopback 桥（`engine_llm_bridge.md`）。
- `lib/engine/contract.js` + `lib/engine/mapping.js`：结果契约与产物格式映射（`engine_contract.md` / `engine_mapping.md`）。
- `lib/engine/process-tree.js`：取消时终止受管 Python 子进程树（`engine_process.md`）。

### 10. frontmatter `type` 与文章/模块分类约定

仓库文章与 wiki 模块用 frontmatter `type` 字段区分种类，映射层据此落盘到固定目录。

- `lib/engine/mapping.js` 的 `WIKI_ENTRY='CodeWiki.md'`、`WIKI_DIR='.codewiki'`、`WIKI_MODULES_REL='.codewiki/modules'`，文章 `type:module`、`pageKind` 取 `artifact`/`parent`/`leaf`（`engine_mapping.md`）。
- `test-orchestration.mjs` 的 `articleMd(title, source, marker, type)` 默认 `type:'module'`，按 prompt 特征映射 `architecture`/`pattern`/`concept`/`learning`（`agent_mocks.md`）。
- 本模式文件自身 frontmatter `type: pattern`，模块文章 `type: module`，与 `articleMd` 的 `type` 体系一致（`app_client.md` 描述 `validateArticleEnvelope` 校验信封）。
