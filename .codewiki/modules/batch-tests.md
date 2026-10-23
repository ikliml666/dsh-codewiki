---
title: batch-tests
type: module
source_files:
  - test-batch.mjs
  - .tmp-test-batch.log
tags: [测试, 批量处理, 回归, 日志回溯]
---

## Overview

`batch-tests` 模块由批量处理路径的测试脚本 `test-batch.mjs` 与一次历史运行产出的日志 `.tmp-test-batch.log` 组成。`test-batch.mjs` 当前共 451 行，用例矩阵覆盖纯函数（源码装填、token 估算、任务装配、本地规划、横切装填、仓库勘探、会话通道收割判定、锚点修正）与 mock 宿主 llm 服务（并发池、取消信号、失败记账、思考档位下发）、会话通道 steer 文本钉死档位、模型目录与思考程度解析、Web 端点回环校验，以及 0.10.1 起内置百炼直连通道的整体移除验证。`.tmp-test-batch.log` 保留早期版本脚本的运行产出（59 通过，0 失败），其记载的百炼端点与 28k/200k 升档行为已过时，仅作文件存在性回溯，不可用于推断当前代码行为。

## Key Components

### 本模块定义的辅助函数与变量（test-batch.mjs）

- `import fs from 'node:fs'` (4|) 、`import os from 'node:os'` (5|) 、`import path from 'node:path'` (6|) —— Node 内置模块，用于临时目录与文件操作。
- `let passed = 0` (14|) —— 通过计数器，每次 `check` 成功递增。
- `const failures = []` (15|) —— 失败消息数组，收集 `check` 未通过的描述。
- `function check(cond, msg)` (16-19) —— 断言函数：条件真则 `passed += 1` 并 `console.log('  ✓ ' + msg)`，否则 `failures.push(msg)` 并输出 `✗`。
- `function section(name)` (20) —— 打印分段标题：`console.log('\n== ' + name + ' ==')`。
- `const mockJson = (obj, status = 200) => ...` (21|) —— 返回 mock Response-like 对象；当前测试已改用 `makeLlm` 模拟宿主 llm 通道，此常量未被后续用例调用（遗留）。
- `function makeLlm(reply)` (145-160) —— 构造 fake llm 对象，其 `async *stream(opts)` 生成器按协议吐块：推 `block-start`、`text-delta`、`usage`、`finish`；`reply` 可为字符串、函数（拿到 opts 返回文本）或 `Error`（触发 error finish）。用于 `runRealtimeTasks` 宿主通道 mock。
- `const promptOf = (opts) => ...` (161|) —— 从 `opts.messages[0].content[0].text` 提取 prompt 文本辅助断言。
- 各测试段内声明的临时根变量：`tmpRoot` (32|)、`workRoot` (55|)、`sessDir` (107|)、`scanRoot` (255|)、`faRoot` (405|) 等，均通过 `fs.mkdtempSync` 创建并最后 `fs.rmSync` 清理（如行 269-271、444）。

### 从 `./index.js` 导入的被测 API（test-batch.mjs 行 7-12）

```js
import {
  collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines,
  buildSessionSteerText,
  prepareArticleTasks, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer,
} from './index.js'
```

注意：当前导入列表**不包含** `resolveBatchApiKey`（该符号已在 0.10.1 移除，见行 398-401 断言）。

### 测试段落（逻辑组件）及行号区间

| 段落名 | 行号区间 | 覆盖功能 |
| --- | --- | --- |
| estimateTokens 粗算 | 23-28 | CJK 每字 1 token、ASCII ceil(n/3.5)、空串、混合计费 |
| collectSources 装填/预算 | 30-44 | 内容内联带行号标题、缺失标注、token 预算、oversized/skipped |
| numberLines 前缀 | 46-51 | 行号前缀与单/双尾换行、CRLF 剥离、空文件 |
| prepareArticleTasks 装配 | 53-82 | prompt 含 mission/语言/源码/旧文；单文件超 110k 预算且分不出多批 → 会话通道（行78「不再升大档」）；单文件连 128k 大档都装不下 → 会话通道（行81「超大兜底已删除」） |
| 多文件超预算观察批 | 84-103 | 观察批分割（≥2）、keepInMemory、composePlan、批次序号标注 |
| classifySessionTask 收割 | 105-121 | timeout/harvest/wait 三态，超时优先、旧文未更新判 wait |
| buildSessionSteerText 档位钉死 | 123-139 | sessionTier 写进 steer 文本、review/resend 文案、无占位符 |
| runRealtimeTasks 宿主 llm 通道 | 141-177 | 每任务一次流式调用、provider/model 路由、reasoningEffort 下发、temperature=0、落盘/keepInMemory |
| tps 采样与取消信号 | 179-201 | onTaskDone 上报 outputTokens/durationMs；未配置 reasoningEffort 不下发；AbortController 中止后剩余任务不消费 |
| 并发池失败记账 | 203-225 | mock llm 路由、失败进 notes、不中断、不落盘 |
| localPlan 兜底 | 227-238 | 顶层目录分组（src/root/docs），不造概念 |
| packArticles 横切装填 | 240-251 | 整篇装填与超预算头部截断 |
| scanRepoFiles 勘探 | 253-267 | 跳 node_modules/.git/二进制/超大/空文件 |
| 宿主 llm 失败记账（错误码透传） | 273-288 | finish kind=error → 任务失败，错误码进 notes |
| listModelCatalog | 290-312 | 宿主 provider/model 目录，跳过无 id，单 provider 失败保留并附 error |
| GET /api/codewiki/models 端点 | 314-342 | installWebServer 注册、回环 200、非回环 403 |
| resolveModelEfforts 及端点 | 344-396 | 档位解析、默认档、上下文透出、端点参数校验 400、非回环 403 |
| 0.10.1 删除内置百炼直连通道 | 398-401 | 断言 `mod.resolveBatchApiKey === undefined` |
| fixAnchors 锚点修正 | 403-445 | 错行修正、歧义不动、区间钳制、CRLF 保真、basename 歧义不碰 |
| 总结输出 | 447-451 | 打印 ALL PASS/FAIL 并 `process.exit(1)` |

## Architecture

测试脚本执行涉及辅助函数、临时文件系统、fake llm 流、被测 API 与日志输出，框图如下：

```text
┌────────────┐   ┌──────────────┐   ┌────────────────┐
│ test-batch │   │ section/check│   │ makeLlm (fake  │
│ .mjs 辅助  │──►│ (行14-20)    │   │ llm.stream)    │
│ (行14-21,  │   └──────────────┘   │ (行145-160)    │
│  145-161)  │   ┌──────────────┐   └───────┬────────┘
└────────────┘   │ 临时目录/文件 │           │ stream
       │         │ (fs.mkdtemp) │           ▼
       ▼         └──────────────┘   ┌────────────────┐
┌────────────┐   ┌──────────────┐   │ runRealtimeTasks│
│ 被测 API   │◄──│ (index.js)   │   │ (宿主 llm 通道)│
│ (index.js) │   │              │   └───────┬────────┘
└─────┬──────┘   └──────────────┘           │ results
      │                                    ▼
      ▼                            ┌────────────────┐
┌────────────┐   ┌──────────────┐   │ batchNotes/    │
│ console.log│──►│ .tmp-test-   │   │ disk files     │
│ (section/  │   │ batch.log    │   └────────────────┘
│ check)     │   │ (回溯日志)   │
└────────────┘   └──────────────┘
```

## Data Flow

1. 脚本启动，导入 `./index.js` 被测函数（行 7-12），定义 `passed`/`failures`/`check`/`section`/`mockJson`（行 14-21）及 `makeLlm`/`promptOf`（行 145-161）。
2. 各测试段调用 `fs.mkdtempSync` 创建临时根（如行 32 `tmpRoot`、行 55 `workRoot`、行 107 `sessDir`、行 255 `scanRoot`、行 405 `faRoot`），写入假源码文件。
3. 调用被测函数（如 `collectSources`、`prepareArticleTasks`、`runRealtimeTasks`），获取返回对象或 Map。
4. 使用 `check` 断言返回属性（如 `cs.text.includes(...)`、`prep.prepared.length`、 `rt.get('rt0').ok`）。
5. 对于宿主 llm 通道测试，在行 145 起构造 `makeLlm` 伪对象，其 `stream` 生成器被 `runRealtimeTasks` 调用，记录 `llmCalls` 并路由到对应 reply（字符串/函数/Error），不产生真实网络请求。
6. Web 端点测试通过 `installWebServer` 注入假 `webServer` 注册路由（行 317-327、378-383），再用模拟 `ctx`/`res` 调用 handler 断言状态码与 body。
7. 所有 `console.log` 输出在旧版运行中被捕获进 `.tmp-test-batch.log`；当前脚本本身不写该日志，仅文件留存作回溯。
8. 最终在行 447 打印汇总，失败时 `process.exit(1)`（行 450）。

## Connections

- 被测核心逻辑来自 [[index]] 模块（通过 `import ... from './index.js'` 在 test-batch.mjs 行 7-12 引用）。
- 日志回溯关联 [[batch-tests-log]]（即 `.tmp-test-batch.log` 实体，但内容已过期）。
- 会话通道与任务装配关联 [[session-channel]]、[[article-tasks]]（基于 `prepareArticleTasks`、`classifySessionTask`、`buildSessionSteerText` 等命名推测的模块）。
- 模型目录与思考档位关联 [[model-catalog]]（基于 `listModelCatalog`、`resolveModelEfforts` 推测）。

## Known Issues

- **日志与脚本文案严重偏差**：`.tmp-test-batch.log` 第 22-24 行记载 `单文件超 28k 预算 → 升大档（200k）重装继续（分不出多批不拆分）` 与 `单文件连 200k 大档都装不下 → oversized（转超大兜底）`；而当前 `test-batch.mjs` 行 78 断言 `单文件超 110k 预算且分不出多批 → 会话通道（不再升大档）`，行 81 断言 `单文件连 128k 大档都装不下 → 会话通道（超大兜底已删除）`。表明日志是早期版本脚本的运行产出，回溯时需注意行为已变更为“不再升大档、直接会话通道，且预算阈值改为 110k/128k”。
- **日志记载百炼端点已废弃**：旧日志第 36-41 行描述 `runRealtimeTasks：百炼普通端点与请求体`、`dashscope.aliyuncs.com`、`enable_thinking:false` 等；当前代码（行 141-225）已改为宿主 llm 通道（`provider: 'workbuddy'`、`llm.stream` 生成器），不再有任何 fetch 百炼端点的逻辑。0.10.1 起内置百炼直连通道整体移除（行 398-401 断言 `resolveBatchApiKey` 未导出）。
- **mockJson 遗留未用**：行 21 定义 `mockJson` 但在当前用例中未被调用，属重构残留，不影响测试。
- **CRLF 保真锁定**：fixAnchors 测试中（行 436-437）验证 CRLF 文章行尾保真，属回归锁定，无故障。
- **非回环拒绝依赖**：Web 端点测试（行 339-341、393-395）断言非回环地址返回 403，依赖 `socket.remoteAddress` 注入，实际部署需确保仅回环可达。
- **临时目录清理**：所有测试段末尾均调用 `fs.rmSync` 清理（如行 269-271、444），若进程中途崩溃可能留临时文件，但不影响断言。