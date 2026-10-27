---
title: batch-tests
type: module
source_files:
  - test-batch.mjs
  - index.js
tags: [测试, 批量处理, 回归, 编译执行链]
---

## Overview

`batch-tests` 模块由批量编译执行链的自检脚本 `test-batch.mjs` 构成（当前源码至 test-batch.mjs:521）。它覆盖编译主链上的一批纯函数与宿主 llm 通道 mock：源码装填 `collectSources`、token 估算 `estimateTokens`、行号前缀 `numberLines`、任务装配 `prepareArticleTasks`（含 128k 大档单请求、420k 大档模型接管 bigTier、多文件观察批拆分、会话通道兜底）、本地规划 `localPlan`、横切装填 `packArticles`、仓库勘探 `scanRepoFiles`、会话通道收割判定 `classifySessionTask`、锚点修正 `fixAnchors`、frontmatter 信封校验 `validateArticleEnvelope`；mock 宿主 llm 服务的并发池 `runRealtimeTasks`（普通档/大档分池限流、tps 采样、外部 signal 中止、失败记账、错误码透传、思考档位下发）、会话通道 steer 文本钉死 `buildSessionSteerText`、模型目录 `listModelCatalog` 与思考程度解析 `resolveModelEfforts`、Web 端点（`/api/codewiki/models`、`/api/codewiki/model-efforts`）回环校验；以及 0.10.1 起内置百炼直连通道的整体移除验证（断言 `resolveBatchApiKey` 未导出，见 test-batch.mjs:518-521）。

注意：旧文章曾引用一个历史运行日志 `.tmp-test-batch.log`，该文件在当前仓库中已不存在（读取返回 ENOENT），故本文仅描述 `test-batch.mjs` 这一个真实存在的 source file，不再保留过期日志的回溯段落。

## Key Components

### 本模块定义的辅助函数与变量（test-batch.mjs）

- `import fs from 'node:fs'`（test-batch.mjs:4）、`import os from 'node:os'`（test-batch.mjs:5）、`import path from 'node:path'`（test-batch.mjs:6）—— Node 内置模块，用于临时目录与文件操作。
- `let passed = 0`（test-batch.mjs:17）—— 通过计数器，每次 `check` 成功递增。
- `const failures = []`（test-batch.mjs:17）—— 失败消息数组，收集 `check` 未通过的描述。
- `function check(cond, msg)`（test-batch.mjs:16-19）—— 断言函数：条件真则 `passed += 1` 并 `console.log('  ✓ ' + msg)`，否则 `failures.push(msg)` 并输出 `✗`。
- `function section(name)`（test-batch.mjs:21）—— 打印分段标题：`console.log('\n== ' + name + ' ==')`。
- `const mockJson = (obj, status = 200) => ...`（test-batch.mjs:174）—— 返回 mock Response-like 对象；当前测试已改用 `makeLlm` 模拟宿主 llm 通道，此常量未被后续用例调用（遗留未用，功能禁用）。
- `function makeLlm(reply)`（test-batch.mjs:174-189）—— 构造 fake llm 对象，其 `async *stream(opts)` 生成器方法按协议吐块：推 `block-start`、`text-delta`、`usage`、`finish`；`reply` 可为字符串、函数（拿到 opts 返回文本）或 `Error`（触发 error finish）。用于 `runRealtimeTasks` 宿主通道 mock。
- `const promptOf = (opts) => ...`（test-batch.mjs:190）—— 从 `opts.messages[0].content[0].text` 提取 prompt 文本辅助断言。
- `function makeSlowLlm(reply, delayMs = 30)`（test-batch.mjs:233-243）—— 带延迟的 fake llm，用于观测并发分池的「在飞峰值」。
- `function poolProbe()`（test-batch.mjs:244-258）—— 返回 `{ st, onTaskStart, onTaskEnd }`，按 `t.bigTier` 分别统计普通档/大档的并发峰值与总峰值，配合 `onRequestStart` 钩子探测分池限流。
- `const mk = (id, big) => ...`（test-batch.mjs:260-263）—— 生成测试任务的工厂：`big` 为真时带 `provider/ model/ bigTier` 标记。
- 各测试段内声明的临时根变量：`tmpRoot`（test-batch.mjs:33）、`workRoot`（test-batch.mjs:56）、`sessDir`（test-batch.mjs:136）、`scanRoot`（test-batch.mjs:375）、`faRoot`（test-batch.mjs:525），均通过 `fs.mkdtempSync` 创建，段末 `fs.rmSync` 清理（test-batch.mjs:389-391、602）。

### 从 `./index.js` 导入的被测 API（test-batch.mjs:7-13）

```js
import {
  collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines,
  buildSessionSteerText,
  prepareArticleTasks, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer,
  validateArticleEnvelope,
} from './index.js'
```

注意：当前导入列表**不包含** `resolveBatchApiKey`（该符号已在 0.10.1 移除，见 test-batch.mjs:521-524 断言 `mod.resolveBatchApiKey === undefined`）。另较旧文章多导入了 `validateArticleEnvelope`（test-batch.mjs:12），对应新增的 frontmatter 信封校验测试段（test-batch.mjs:605-636）。

### 测试段落（逻辑组件）及行号区间

| 段落名 | 行号区间 | 覆盖功能 |
| --- | --- | --- |
| estimateTokens 粗算 | test-batch.mjs:24-29 | CJK 每字 1 token、ASCII ceil(n/3.5)、空串、混合计费 |
| collectSources 装填/预算 | test-batch.mjs:31-45 | 内容内联带行号标题、缺失标注、token 预算、oversized/skipped |
| numberLines 前缀 | test-batch.mjs:47-52 | 行号前缀与单/双尾换行、CRLF 剥离、空文件 |
| prepareArticleTasks 装配与大档单请求 | test-batch.mjs:54-86 | prompt 含 mission/语言/源码/旧文；单文件超 110k 预算但在 128k 大档内 → 大档单请求不转会话通道（test-batch.mjs:78-82）；单文件连 128k 大档都装不下 → 会话通道兜底（test-batch.mjs:83-85） |
| 多文件超预算观察批分割 | test-batch.mjs:87-106 | 观察批分割（≥2）、keepInMemory、composePlan、批次序号标注、prompt ≤110k |
| 大档模型接管超长输入 | test-batch.mjs:108-132 | 0.10.4 大档模型（bigProvider/bigModel/bigReasoningEffort/bigBudget）接管超 128k 单文件、自带 provider/model/档位路由（test-batch.mjs:110-120）；关闭大档退回会话通道（test-batch.mjs:123-126）；普通任务不误标大档（test-batch.mjs:128-132） |
| classifySessionTask 收割判定 | test-batch.mjs:134-150 | timeout/harvest/wait 三态，超时优先、旧文未更新判 wait |
| buildSessionSteerText 档位钉死 | test-batch.mjs:152-168 | sessionTier 写进 steer 文本、review/resend 文案、无占位符 |
| runRealtimeTasks 宿主 llm 通道 | test-batch.mjs:170-207 | 每任务一次流式调用、provider/model 路由、reasoningEffort 下发、temperature=0、落盘/keepInMemory |
| 大档任务混合池分派 | test-batch.mjs:208-228 | 同一池里大档任务按自带 provider/model/档位路由，普通任务走默认档（test-batch.mjs:211-228） |
| 大档与默认档并发分池 | test-batch.mjs:230-297 | 0.12.2 分池限流：普通档 concurrency、大档 bigConcurrency 各自独立计数（test-batch.mjs:264-282）；bigConcurrency 缺省跟随默认档（test-batch.mjs:284-297） |
| tps 采样与取消信号 | test-batch.mjs:299-321 | onTaskDone 上报 outputTokens/durationMs（test-batch.mjs:299-309）；外部 signal 中止不再消费剩余任务（test-batch.mjs:311-321） |
| 并发池失败记账 | test-batch.mjs:323-345 | mock llm 路由、失败进 notes、不中断、不落盘 |
| localPlan 兜底 | test-batch.mjs:347-358 | 顶层目录分组（src/root/docs），不造概念 |
| packArticles 横切装填 | test-batch.mjs:360-371 | 整篇装填与超预算头部截断 |
| scanRepoFiles 勘探 | test-batch.mjs:373-387 | 跳 node_modules/.git/二进制/超大/空文件 |
| 宿主 llm 失败通道错误码透传 | test-batch.mjs:393-408 | finish kind=error → 任务失败，错误码进 notes |
| listModelCatalog | test-batch.mjs:410-432 | 宿主 provider/model 目录，跳过无 id，单 provider 失败保留并附 error |
| GET /api/codewiki/models 端点 | test-batch.mjs:434-462 | installWebServer 注册、回环 200、非回环 403 |
| resolveModelEfforts 及端点 | test-batch.mjs:464-516 | 档位解析、默认档、上下文透出、端点参数校验 400、非回环 403 |
| 0.10.1 删除内置百炼直连通道 | test-batch.mjs:518-521 | 断言 `mod.resolveBatchApiKey === undefined` |
| fixAnchors 锚点修正 | test-batch.mjs:523-603 | 错行修正、歧义不动、区间钳制、倒序区间翻正、CRLF 保真、basename 歧义不碰、一行多锚点就近绑定 |
| validateArticleEnvelope 信封校验 | test-batch.mjs:605-636 | 闭合/前置空行/CRLF/缺 frontmatter/未闭合/null/非字符串/正文 --- 分隔线 |
| 总结输出 | test-batch.mjs:641-642 | 打印 ALL PASS/FAIL 并 `process.exit(1)` |

## Architecture

测试脚本执行涉及辅助函数、临时文件系统、fake llm 流、被测 API 与控制台输出，框图如下：

```text
┌────────────┐   ┌──────────────┐   ┌────────────────┐
│ test-batch │   │ section/check│   │ makeLlm/       │
│ .mjs 辅助  │──►│ (test-batch  │   │ makeSlowLlm    │
│ (行15-22,  │   │  .mjs:15-22) │   │ (fake         │
│  174-263)  │   └──────────────┘   │  llm.stream)  │
└────────────┘   ┌──────────────┐   │ (行174-243)   │
       │         │ 临时目录/文件 │   └───────┬────────┘
       │         │ (fs.mkdtemp) │           │ stream
       ▼         └──────────────┘           ▼
┌────────────┐   ┌──────────────┐   ┌────────────────┐
│ 被测 API   │◄──│ (index.js   │   │ runRealtimeTasks│
│ (index.js) │   │  行7-13)     │   │ (宿主 llm 通道)│
│ collectSrc │   └──────────────┘   │ 普通档/大档分池│
│ prepareArt │                      └───────┬────────┘
│ fixAnchors │                             │ results
│ validateEnv│                             ▼
└─────┬──────┘                   ┌────────────────┐
      │                          │ batchNotes /   │
      ▼                          │ disk files     │
┌────────────┐                   └────────────────┘
│ console.log│──► (terminal)   installWebServer →
│ (section/  │                 GET /api/codewiki/
│ check)     │                 models|model-efforts
└────────────┘                 (回环200/非回环403)
```

## Data Flow

1. 脚本启动，从 `./index.js` 导入被测函数（test-batch.mjs:15-21），定义 `passed`/`failures`/`check`/`section`/`mockJson`（test-batch.mjs:22-29）及 `makeLlm`/`promptOf`/`makeSlowLlm`/`poolProbe`/`mk`（test-batch.mjs:174-263）。
2. 各测试段调用 `fs.mkdtempSync` 创建临时根（如 test-batch.mjs:33 `tmpRoot`、test-batch.mjs:56 `workRoot`、test-batch.mjs:136 `sessDir`、test-batch.mjs:375 `scanRoot`、test-batch.mjs:525 `faRoot`），写入假源码文件。
3. 调用被测函数（如 `collectSources` test-batch.mjs:36、`prepareArticleTasks` test-batch.mjs:67、`runRealtimeTasks` test-batch.mjs:196），获取返回对象或 Map。
4. 使用 `check` 断言返回属性（如 `cs.text.includes(...)` test-batch.mjs:37、`prep.prepared.length` test-batch.mjs:68、`rt.get('rt0').ok` test-batch.mjs:341）。
5. 对于宿主 llm 通道测试，从 test-batch.mjs:174 起构造 `makeLlm`/`makeSlowLlm` 伪对象，其 `stream` 生成器被 `runRealtimeTasks` 调用，记录 `llmCalls`（test-batch.mjs:172）并路由到对应 reply（字符串/函数/Error），不产生真实网络请求。
6. Web 端点测试通过 `installWebServer` 注入假 `webServer` 注册路由（test-batch.mjs:434-438、498-502），再用模拟 `ctx`/`res` 调用 handler 断言状态码与 body（test-batch.mjs:450-461、506-515）。
7. 0.10.1 删除百炼通道的验证单独在 test-batch.mjs:518-521 通过动态 `import('./index.js')` 后断言 `resolveBatchApiKey === undefined`。
8. 所有 `console.log` 直接输出到终端；脚本本身不写任何日志文件。最终在 test-batch.mjs:638 打印汇总，失败时遍历 `failures` 并 `process.exit(1)`（test-batch.mjs:639-642）。

## Connections

- 被测核心逻辑来自 [[core-and-config]] 模块（通过 `import ... from './index.js'` 在 test-batch.mjs:7-13 引用，覆盖 `collectSources`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`packArticles`/`scanRepoFiles`/`classifySessionTask`/`buildSessionSteerText`/`fixAnchors`/`validateArticleEnvelope`/`listModelCatalog`/`resolveModelEfforts`/`installWebServer`）。
- 会话通道任务装配与收割关联 [[test-scripts]] / [[orchestration-tests]]（基于 `prepareArticleTasks`、`classifySessionTask`、`buildSessionSteerText`、`runRealtimeTasks` 会话通道兜底的命名）。
- 模型目录与思考档位关联 [[configuration-and-metadata]]（基于 `listModelCatalog`、`resolveModelEfforts` 与 `installWebServer` 注册的端点）。
- 锚点修正与信封校验关联 [[wiki-tests]]（基于 `fixAnchors`、`validateArticleEnvelope` 的 frontmatter 行号锚点回归）。

## Known Issues

- **`mockJson` 遗留未用**：test-batch.mjs:22 定义 `mockJson` 但在当前用例中未被调用，属重构残留，不影响测试。
- **历史日志已删除**：旧文章曾引用 `.tmp-test-batch.log` 并据此描述「百炼端点 / 28k-200k 升档」行为；该文件当前仓库中已不存在（读取返回 ENOENT），不可用于推断当前代码行为，故已从本文 source_files 中移除。当前 0.10.1 起已无百炼直连（test-batch.mjs:518-521 断言 `resolveBatchApiKey === undefined`），预算阈值改为 110k/128k/420k（test-batch.mjs:78-85、108-132）。
- **CRLF 保真锁定**：fixAnchors 测试中（test-batch.mjs:563-564）验证 CRLF 文章行尾保真，属回归锁定，无故障。
- **非回环拒绝依赖**：Web 端点测试（test-batch.mjs:458-461、513-515）断言非回环地址返回 403，依赖 `socket.remoteAddress` 注入，实际部署需确保仅回环可达。
- **临时目录清理**：所有测试段末尾均调用 `fs.rmSync` 清理（test-batch.mjs:389-391、602），若进程中途崩溃可能留临时文件，但不影响断言。
- **分池限流动态性**：大档/默认档分池的峰值断言（test-batch.mjs:233-249）依赖 `makeSlowLlm` 的 `delayMs` 人为延迟与 `onRequestStart` 钩子同步计数；若 `runRealtimeTasks` 内部改为更细粒度的并发调度，峰值探测逻辑可能失效，但该测试本身只断言「峰值达到上限」而非精确时序。
