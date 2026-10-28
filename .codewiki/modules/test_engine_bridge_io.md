---
title: test_engine_bridge_io
type: module
source_files:
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-output.mjs
  - test-engine-output-real.mjs
tags: [tests, engine, llm-bridge, openai-bridge, output, codewiki]
---

## Overview

`test_engine_bridge_io` 是「引擎 LLM/OpenAI 桥 + 产物解析/校验」这一子系统测试的聚合模块名，它覆盖四个测试文件与一个支撑契约文件：

- `test-engine-bridge.mjs` — 纯转换契约测试（阶段 1B）。只测 `lib/engine/openai-bridge.js` 里**无 I/O、无网络、无密钥**的纯函数：`toLlmRequest`（OpenAI 请求体 → DSH `GenerateOptions`）、`finishReasonToOpenAI`、`chunksToCompletion`、`sseFrame`、`chunksToSse`、`isPlaceholderKey`、占位 key 正则。不启服务器、不连 provider。
- `test-engine-llm-bridge.mjs` — 服务器级边界行为测试（阶段 1B）。测 `lib/engine/llm-bridge.js` 的 `startLlmBridge`：**凭证边界是否真的守住**（loopback+随机端口+占位 key 校验、401 不回显 key、日志无 Authorization、上游失败转 502、流式 [DONE] 收尾、断连 abort、超时 abort）。用一个假的 `llm.stream` 模拟宿主，不碰真实密钥。
- `test-engine-output.mjs` — 产物解析/校验测试（阶段 2）。测 `lib/engine/output.js` 的 `OUTPUT_PROBLEM_KINDS`、`bodyLength`、`relativeLinks`、`collectOutput`、`buildWritePlan`、`validateOutput`。
- `test-engine-output-real.mjs` — 真实产物回归测试（阶段 2）。拿真跑出来的 FSoft docs 树钉死两个单测造数据永远抓不到的真实缺陷：hierarchical 布局的嵌套子目录页会被漏收集、whole-repository 模式下 `module_tree.json` 为空对象时页仍要进写集且 `source_files` 留空（`attribution=unattributed`）。依赖 `lib/engine/mapping.js` 与 `lib/engine/contract.js`。

整套测试的核心动机写在各文件头部注释里：桥与产物层是迁移里「最容易悄悄错、且错了极难查」的地方——请求映射错会让 agentic 工具循环退化成空壳，凭证边界错会静默把宿主凭证开放给本机任意进程，产物校验错会让 wiki 缺页/缺页归属而无人知晓。

## Key Components

下面按「被测源文件」与「测试文件」分两组列出全部公开导出与测试单元。行号以 `read_code` 返回的「行号| 」前缀为准。

### 被测源文件：`lib/engine/openai-bridge.js`（纯转换层，阶段 1B）

- `PLACEHOLDER_KEY_PATTERN` (29|) — 正则 `/^dsh-bridge-[a-z0-9-]+$/`，占位 key 的形态约束（随机 hex 之前含 `dsh-bridge-`）。
- `isPlaceholderKey(value)` (31|) — 仅当 `value` 是字符串且命中 `PLACEHOLDER_KEY_PATTERN` 才返回 `true`；真实 key、空串、`undefined` 均返回 `false`。
- `contentToBlocks(content)` (38|) — 内部：OpenAI 的 string / parts 数组统一摊平成 DSH `ContentBlock[]`，非文本部分（image_url 等）显式跳过。
- `toolsToSchemas(tools)` (53|) — 内部：把 `tools[].function` 映射成 `ToolSchema`（name/description/parameters 原样），无函数名则跳过。
- `messageToDsh(msg, route)` (76|) — 内部：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`；assistant 历史消息强制带 `source.kind='model'`（见 `route` 参数），tool 消息带 `toolCallId`/`isError`。
- `toLlmRequest({provider, model, reasoningEffort, body})` (128|) — **核心导出**。OpenAI chat.completion 请求体 → DSH `GenerateOptions` 子集。缺 provider(129|)/model(130|)/非空 messages(132|) 时抛错；system 抽到 `system` 槽(152|)；tools/temperature/max_tokens/stop 按名映射(155–159|)。返回值里**永远没有 apiKey 字段**。
- `finishReasonToOpenAI(reason)` (164|) — DSH `FinishReason` → OpenAI `finish_reason`：`tool-calls`→`tool_calls`、`max-tokens`→`length`、`error`/`aborted`→`error`、其余(含 undefined)→`stop`。
- `usageToOpenAI(usage)` (176|) — 内部：DSH 互斥计数 `inputTokens`+`cacheReadTokens`+`cacheWriteTokens` → OpenAI `prompt_tokens`（含缓存），`prompt_tokens_details.cached_tokens` 单列缓存。
- `foldChunks(chunks)` (192|) — 内部：把 chunk 流折叠成 `{text, finish, usage, toolCalls}`；按 `index` 拼接 tool-calls，只保留带 `name` 的调用。
- `chunksToCompletion({id, model, chunks})` (236|) — chunk 流 → OpenAI 非流式响应体 `chat.completion`；纯工具调用时 `content` 为 `null`(249|)。
- `sseFrame(payload)` (259|) — 一帧 SSE：`data: <json|文本>\n\n`；`[DONE]` 作为字符串原样包裹。
- `chunksToSse({id, model, created, chunks})` (265|) — chunk 流 → SSE 帧数组，末帧 `[DONE]`(315|)；流没给 finish 也补终帧(311–314|) 防止引擎挂住。

### 被测源文件：`lib/engine/llm-bridge.js`（服务器层，阶段 1B 薄桥）

- `DEFAULT_TIMEOUT_MS = 10*60*1000` (33|)；`MAX_BODY_BYTES = 32*1024*1024` (34|)。
- `bearerOf(req)` (38|) — 内部：从 `Authorization` 头取 bearer token，**取完即弃**，不写日志、不进请求、不传 llm。
- `sendJson(res, status, body, extraHeaders)` (45|)；`readBody(req, limit)` (56|，超 `limit` 抛 413)；`errorBody(message, type, code)` (75|，OpenAI 风格错误体)。
- `startLlmBridge({llm, provider, model, reasoningEffort, timeoutMs, onLog})` (90|) — **核心导出**。返回 Promise 解析为 `{url, placeholderKey, port, stats(), close()}`：
  - 占位 key 每次启动随机生成 `dsh-bridge-${randomBytes(32).toString('hex')}` (96|)；绑 `127.0.0.1` 随机端口(230|)。
  - 所有 `/v1` 请求必须带占位 key 校验(118–126|)，失败 401 且不回显收到的 key(120–124|)。
  - `POST /v1/chat/completions` 走 `toLlmRequest`(151|) → `llm.stream({...options, signal})`(171|)；流式边收边转 `chunksToSse`(183|)、以 `[DONE]` 收尾(210|)；上游抛错时非流式转 502(202|)、流式先发错误帧再 `[DONE]`(195–197|)。
  - 客户端断连 `res.on('close')`→`ac.abort()`(164–165|)，`timeoutMs` 到点也 abort(166|)。
  - `GET /v1/models` 需占位 key 返回配置模型(128–131|)；`GET /healthz` 不需 key 且不含凭证信息(112–115|)。
  - `stats()` 返回 `{requests, streamRequests, authRejected, failures, lastError}`(97|)。

### 被测源文件：`lib/engine/output.js`（产物解析/校验，阶段 2）

- `OUTPUT_PROBLEM_KINDS` (22|) — 冻结数组：11 类可机读 problem（`missing-docs-dir` / `missing-metadata` / `missing-module-tree` / `empty-module-tree` / `bad-json` / `entry-missing` / `empty-body` / `article-missing` / `unmapped-page` / `source-missing` / `dead-link`）。
- `listMarkdownPages(rootDir, rel)` (44|) — 内部：递归收集 docs 下 `.md`（POSIX 相对路径、已排序），跳过 `.` 开头目录与 `temp/`(43|,55|)。
- `readJsonIfExists(file, problems, kind, {optional})` (64|) — 内部：读 JSON，缺失按 `optional` 决定是否报 problem；存在但坏了永远报 `bad-json`。
- `collectOutput({docsDir})` (91|) — 只读不抛，产出 `{docsDir, exists, pages[], json:{metadata,moduleTree,firstModuleTree,updateRecord}, problems[]}`。
- `bodyLength(text)` (127|) — 去掉标题行与空白后剩余正文字符数，用来判「只有标题的空壳页」。
- `relativeLinks(text)` (140|) — 收集正文里的相对 markdown 链接目标，跳过外链/锚点/`data:` 图片。
- `buildWritePlan({docsDir, componentFiles, overviewName})` (162|) — 读 docs → 调 `mapFsoftOutput` 返回 `{collected, mapped}`。
- `validateOutput({docsDir, repoRoot, componentFiles, overviewName})` (184|) — **核心导出**。返回 `{ok, problems[], mapped, stats}`；不抛、不修任何东西。逐条 push problem（未登记 kind 直接 `throw` 184–189|）。校验项：入口(197|)、空模块树(204–207|)、空壳页(224|)、unmapped(228|)、模块树缺页升级 article-missing(231–233|)、source_files 存在性(236–248|)、死链(252–265|)。`stats = {pages, articles, unmapped, problems}`(275–280|)。
- `default` 导出 (284|) — 聚合上述导出。

### 支撑源文件：`lib/engine/mapping.js` 与 `lib/engine/contract.js`

- `lib/engine/mapping.js`：导出常量 `WIKI_ENTRY='CodeWiki.md'`(30|)、`WIKI_DIR='.codewiki'`(31|)、`WIKI_META_REL`(32|)、`WIKI_UPDATE_RECORD_REL`(33|)、`WIKI_MODULES_REL='.codewiki/modules'`(34|)；`moduleSlug(name)`(38|) kebab-case 文件名；核心 `mapFsoftOutput({pages, moduleTree, componentFiles, metadata, updateRecord, overviewName})`(115|) 纯函数，输出 `{contractVersion, entry, articles[], unmapped[], meta, updateRecord, warnings}`。空模块树(153–188|) 与非空但无匹配(189–192|) 走不同分支；slug 冲突两页都进 unmapped(200–211|)。
- `lib/engine/contract.js`：`ENGINE_CONTRACT_VERSION=1`(20|)；`mapFsoftOutput` 引用它(28|, `mapping.js` 输出 `contractVersion`)。

### 测试文件一：`test-engine-bridge.mjs`（纯转换契约，阶段 1B）

统一入口 `check(label, fn)` (31|)：包 try/catch 统计 `pass`/`fails`，失败进 `fails` 并在末尾(417–421|) 以 `process.exitCode=1` 退出。导入源 `openai-bridge.js` 的 7 个符号(19–27|)。测试单元（每个一行 `await check(...)`）：

- 请求映射：system 抽槽 (40|)、无 system 为 undefined (61|)、assistant tool_calls 还原成 tool-call 块 (66|)、tool 角色映射成 tool 结果 (93|)、tools 映射 ToolSchema (111|)、temperature/max_tokens/stop 映射且未知字段不塞 (134|)、多模态 content 摊平 (153|)、空 messages 抛错 (167|)、缺 provider/model 抛错 (172|)。
- 响应映射：`finishReasonToOpenAI` 一一对应 (181|)、`chunksToCompletion` 文本+工具+usage (192|)、纯工具调用 content 为 null (227|)、空流返回 stop 且 content 空串 (238|)、无 name 的 tool-call-delta 不产出半截工具 (245|)、reasoning 块不混进 content (258|)。
- SSE 流式：`sseFrame` 格式 (274|)、`chunksToSse` 首帧带 role/末帧 [DONE] (279|)、tool call 增量逐帧 (300|)、usage 单独成帧 (320|)。
- 占位 key：`isPlaceholderKey` (340|)、`toLlmRequest` 绝不带 api key (348|)。
- 回归（1C 真实模型暴露）：assistant 历史消息必须带 source (368|)、source 的 provider/model 取自本次路由且不伪造 replayState (391|)、tool 消息带 toolCallId (402|)。

### 测试文件二：`test-engine-llm-bridge.mjs`（服务器边界行为，阶段 1B）

同样 `check` 入口 (22|)、import `startLlmBridge` (18|)。辅助：`fakeLlm(script)` (28|) 假宿主（记录 `calls`、按脚本产出 chunk，不碰真实密钥）；`withBridge(opts, fn)` (42|) 启桥并 `finally` close；`post(bridge, body, {key, signal})` (47|) 打 `/chat/completions`；`simpleBody` (57|)；`sleep` (40|)。测试单元：

- 绑定 127.0.0.1 随机端口、url 指向 `/v1` (59|)。
- 凭证闸门：缺 Authorization→401 且不触达 llm (68|)、真实形态 key→401 且 key 不回显 (80|)、同格式但非本次生成的占位 key→401 (211|)。
- 非流式：返回 OpenAI 形状且 usage 正确折算 (91|)、工具调用拼完整 arguments (114|)、上游失败→502+OpenAI 错误体 (165|)。
- 流式：SSE 逐帧并以 [DONE] 收尾 (131|)、上游中途失败→错误帧+[DONE] 不挂住 (151|)。
- 防御面：非法 JSON→400 不触达 llm (176|)、空 messages→400 (189|)、`/v1/models` 需占位 key (198|)、`/healthz` 不需 key 且不泄露凭证 (222|)、日志不含 Authorization 与占位 key 本身 (232|)。
- 取消语义：客户端断连→上游 signal abort (249|)、超时→上游 signal abort+非流式 502 (274|)。
- 启动参数缺失→抛错 (290|)。

### 测试文件三：`test-engine-output.mjs`（产物解析/校验，阶段 2）

`check` 入口 (23|)；import `output.js` 6 个符号(12–19|)。辅助：`makeDocs(name, overrides)` (31|) 造「正常」docs 树（overview/Core/Web 三页 + 四个 JSON），`repoRoot` 造 `src/core/engine.py` 与 `src/web/handler.py`(59–63|)；末尾 `rmSync(root, ...)`(229|)。测试单元：

- 工具函数：`bodyLength` 空壳判定 (65|)、`relativeLinks` 跳过外链/锚点/data URI (72|)。
- 读取：`collectOutput` 正常完整无 problem (79|)、缺 docs 目录→missing-docs-dir (89|)、metadata 缺失 (95|)/坏掉→bad-json (101|)、update_record 缺失不算问题 (108|)/坏掉→bad-json (115|)。
- 校验：`validateOutput` 正常 (121|)、缺 overview→entry-missing (134|)、空壳页→empty-body 带 source (141|)、模块树有模块没产页→article-missing (150|)、页不在模块树→unmapped-page (157|)、source_files 不存在→source-missing (166|)、不给 repoRoot 跳过 source 检查 (180|)、链接指向计划外 md→dead-link (191|)、链接到仓库源文件不算死链 (200|)、两次调用结果稳定 (206|)、未登记 problem kind 会被拒 (214|)、`buildWritePlan` 的 componentFiles 作为 source_files 证据 (219|)。

### 测试文件四：`test-engine-output-real.mjs`（真实产物回归，阶段 2）

`check` 入口 (27|)；import `output.js` 与 `mapping.js`(22–23|)。真实产物根 `REAL='E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs'`(32|)；不存在则 `console.log('SKIP ...')` 并 `process.exit(0)`(33–36|)。`copyDocs(name)` (40|) 复制到临时目录后施加变形，**绝不改动原产物**。测试单元：

- `collectOutput` 读到 overview+两模块页、module_tree 为空对象 (46|)。
- `module_tree={}` 而模块页存在→页仍进写集、source_files 为空、attribution=unattributed (57|)。
- 空模块树本身报 `empty-module-tree` 且 ok=false (76|)。
- 模块树非空但某页无对应模块→仍是 unmapped (86|)。
- 嵌套子目录的页必须被收集（hierarchical 布局）(97|)。
- `temp/` 里的 md 不算页 (116|)。
- `update_record` 原样读出、pages_written/pages_removed 可机读 (124|)。
- metadata 的 commit 进 `meta.lastCompiledCommit` (134|)。
- 正文真实页间链接不误判死链 (141|)。
- componentFiles 有证据时 unattributed 页仍不臆造 (148|)。
- `mapping` 纯函数：空模块树→unattributed、非空无此页→unmapped (159|)。

## Architecture

这些测试覆盖的是一个分层系统：纯转换层（`openai-bridge.js`）被服务器层（`llm-bridge.js`）包裹成 loopback HTTP 桥；产物层（`output.js`）委托给纯映射层（`mapping.js`），后者引用 `contract.js` 的版本常量。框图如下（每个框标注组件与文件）：

```text
                FSoft 引擎 (OpenAI-compatible client)
                          │  POST /v1/chat/completions (占位 key)
                          ▼
        ┌─────────────────────────────────────────────┐
        │  llm-bridge.js  startLlmBridge  (server层)    │
        │  127.0.0.1:随机端口 /v1 + 占位key校验          │
        │  401/400/502 错误体 · [DONE] 收尾 · abort     │
        └───────────────┬─────────────────────────────┘
                        │  toLlmRequest() → llm.stream()
                        ▼
        ┌─────────────────────────────────────────────┐
        │  openai-bridge.js  (纯转换层, 无I/O无密钥)     │
        │  toLlmRequest / finishReasonToOpenAI          │
        │  chunksToCompletion / chunksToSse / sseFrame  │
        │  isPlaceholderKey + PLACEHOLDER_KEY_PATTERN   │
        └───────────────┬─────────────────────────────┘
                        │  委托给宿主 llm（凭证只在此处）
                ========┼========
                        │  FSoft 产物 docs 树（真实运行输出）
                        ▼
        ┌─────────────────────────────────────────────┐
        │  output.js  collectOutput/buildWritePlan/     │
        │  validateOutput · OUTPUT_PROBLEM_KINDS       │
        │  bodyLength · relativeLinks                  │
        └───────────────┬─────────────────────────────┘
                        │  mapFsoftOutput() (纯函数)
                        ▼
        ┌─────────────────────────────────────────────┐
        │  mapping.js  moduleSlug/indexModuleTree/      │
        │  sourceFilesOf · WIKI_* 常量 → 写集描述        │
        │  引用 contract.js ENGINE_CONTRACT_VERSION     │
        └──────────────────────────────────────────────┘
```

对应关系：测试文件与源文件的对应是 `test-engine-bridge.mjs`→`openai-bridge.js`（纯转换）、`test-engine-llm-bridge.mjs`→`llm-bridge.js`（服务器）、`test-engine-output.mjs`/`test-engine-output-real.mjs`→`output.js`（后者再委托 `mapping.js`）。`test-engine-output-real.mjs` 还直接 import `mapping.js` 的 `mapFsoftOutput` 单测纯函数分支 (23|)。

## Data Flow

### 桥的请求方向（引擎 → 宿主）

1. 引擎持 `http://127.0.0.1:<port>/v1` 与本次生成的占位 key，POST 一个 OpenAI `chat.completions` 请求体（含 `messages`/`tools`/`temperature` 等）。
2. `llm-bridge.js` 的 `bearerOf`(38|) 只取 token 用于校验，`startLlmBridge` 校验 `PLACEHOLDER_KEY_PATTERN` 且 `token===placeholderKey`(120|)，不符则 `stats.authRejected++` 并 401(121–124|)。
3. 合法请求经 `toLlmRequest`(128|) 转成 DSH `GenerateOptions`：system 抽槽(152|)、assistant 的 `tool_calls` 还原成 tool-call 块且带 `source`(76–111|)、tool 消息带 `toolCallId`(112–119|)、`tools` 映射 `ToolSchema`(155|)。返回值**不含 apiKey**。
4. `llm.stream({...options, signal})`(171|) 触发宿主真模型调用，chunk 流被收集(169–172|)。

### 桥的响应方向（宿主 → 引擎）

- 非流式：`chunksToCompletion`(236|) 折叠成 `chat.completion` JSON（usage 由 `usageToOpenAI` 折算 176|），`sendJson` 200(216–218|)。
- 流式：边收边用 `chunksToSse`(265|) 逐帧发(183–187|)，最终统一发 `[DONE]`(210|)；上游中途失败则先发错误帧再 `[DONE]`(195–197|)，防止引擎 SSE 读取挂住。
- 上游抛错（非流式）：转 502 + OpenAI 错误体(202|)，`stats.failures++`/`lastError`(192|)。

### 产物方向（FSoft docs 树 → cw 写集）

1. `collectOutput`(91|) 递归读 docs 目录：`listMarkdownPages`(44|) 收集 `.md`（跳过 `.` 目录与 `temp/`），`readJsonIfExists`(64|) 读四个 JSON（metadata/module_tree 必需，first_module_tree/update_record 可选），坏文件变 `bad-json` problem 而非异常。
2. `buildWritePlan`(162|) → `mapFsoftOutput`(115|)：纯映射成 `{entry, articles[], unmapped[], meta, updateRecord, warnings}`，`contractVersion=ENGINE_CONTRACT_VERSION`(mapping.js 256|)。
3. `validateOutput`(184|) 在 `collected.problems` 基础上再 push 自洽性 problem（入口/空壳/未映射/缺页/缺 source/死链），返回 `ok = problems.length===0`(268|) 与 `stats`。

## Connections

- [[lib/engine/openai-bridge]] — 纯转换层，被 `test-engine-bridge.mjs` 直接钉死。
- [[lib/engine/llm-bridge]] — 服务器层，被 `test-engine-llm-bridge.mjs` 钉死凭证边界。
- [[lib/engine/output]] — 产物解析/校验，被 `test-engine-output.mjs` 与 `test-engine-output-real.mjs` 钉死。
- [[lib/engine/mapping]] — 纯映射函数，被产物测试间接与直接（real 测试 23|）覆盖。
- [[lib/engine/contract]] — `ENGINE_CONTRACT_VERSION` 被 `mapping.js` 引用，产物测试通过 `contractVersion` 间接依赖。
- [[test-engine-contract]] — 同属阶段 0 契约的纯函数测试（engineResult/engineProgress/validateEngineResult），本模块不覆盖但同族。
- [[test-engine-client]] — 引擎进程客户端层测试，与桥/产物层是上下游。

## Known Issues

- `test-engine-output-real.mjs` 是**条件跳过**测试：真实产物根写死为 `E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs`(32|)，该绝对路径不存在时整个文件 `SKIP` 并 `process.exit(0)`(33–36|)。只有在阶段 1C 真跑过引擎才会存在，CI 上与其它三套不保证可跑——这是设计上的真实产物回归探针，不是缺陷。
- `openai-bridge.js` 的多模态处理是**受限**的：`contentToBlocks`(38–51|) 显式跳过 image_url 等非文本部分（注释 46|："引擎只发文本"），测试 `test-engine-bridge.mjs:153|` 只验证了 text 部分摊平，未覆盖图片/音频等多模态块。
- `tool` 消息的 `is_error` 映射只读 `msg.is_error === true`(117|)，OpenAI 协议中 tool 结果通常不带该字段，测试 `test-engine-bridge.mjs:93|` 只断言 `isError=false`，没有覆盖 `is_error` 为真的路径。
- `llm-bridge.js` 的 `timeoutMs` 默认 `10*60*1000`(33|)，测试 `test-engine-llm-bridge.mjs:284|` 用 `timeoutMs:150` 验证超时 abort，但正常路径下的超时只是间接被 abort 信号覆盖，没有专门断言「超时后上游确实被中断」以外的日志/统计细节。
- 桥的安全边界依赖「真实凭证只存在于宿主 provider 内部」这一外部前提（`llm-bridge.js` 注释 6–17|）；测试用 `fakeLlm` 模拟宿主，因此**不验证真实 provider 凭证是否真的没经桥泄露**——该断言只覆盖桥自身不读/不转发/不记录密钥。
