---
title: batch-tests
type: module
source_files:
  - test-batch.mjs
  - .tmp-test-batch.log
tags: [测试, 批量处理, 回归, 日志回溯]
---

## Overview

`batch-tests` 模块由批量处理路径的测试脚本 `test-batch.mjs` 与一次运行产出的日志 `.tmp-test-batch.log` 组成。`test-batch.mjs` 共 482 行，用例矩阵较宽，覆盖纯函数（源码装填、token 估算、任务装配、本地规划、横切装填、仓库勘探、会话通道收割、锚点修正）与 mock fetch 下的百炼端点、并发池、取消、失败记账，以及宿主 llm 通道、模型目录、凭证解析和 Web 端点。`.tmp-test-batch.log` 保留当次执行的完整输出（59 通过，0 失败），用于回溯。

## Key Components

### 本模块定义的辅助函数与变量（test-batch.mjs）

- `let passed = 0` (14|) —— 通过计数器，每次 `check` 成功递增。
- `const failures = []` (15|) —— 失败消息数组，收集 `check` 未通过的描述。
- `function check(cond, msg)` (16-19) —— 断言函数：条件真则 `passed += 1` 并 `console.log('  ✓ ' + msg)`，否则 `failures.push(msg)` 并输出 `✗`。
- `function section(name)` (20) —— 打印分段标题：`console.log('\n== ' + name + ' ==')`。
- `const mockJson = (obj, status = 200) => ...` (21) —— 返回 mock Response-like：`{ ok: status>=200&&status<300, status, text: async () => JSON.stringify(obj) }`。

### 从 `./index.js` 导入的被测 API（test-batch.mjs 行 7-12）

```js
import {
  collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines,
  buildSessionSteerText,
  prepareArticleTasks, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, resolveBatchApiKey, listModelCatalog, resolveModelEfforts, installWebServer,
} from './index.js'
```

上述符号均为批量处理核心逻辑，在脚本中直接调用并断言。

### 测试段落（逻辑组件）及行号区间

| 段落名 | 行号区间 | 覆盖功能 |
| --- | --- | --- |
| estimateTokens 粗算 | 23-28 | CJK 每字 1 token、ASCII ceil(n/3.5)、空串、混合计费 |
| collectSources 装填/预算 | 30-44 | 内容内联带行号、缺失标注、token 预算、oversized/skipped |
| numberLines 前缀 | 46-51 | 行号前缀与单/双尾换行、CRLF 剥离、空文件 |
| prepareArticleTasks 装配 | 53-81 | prompt 含 mission/语言/源码/旧文、oversized 转会话通道（行78注“不再升大档”）、超大兜底已删除（行81） |
| 多文件超预算观察批 | 83-102 | 观察批分割（≥2）、keepInMemory、composePlan、批次序号 |
| classifySessionTask 收割 | 104-120 | timeout/harvest/wait 三态，超时优先、旧文未更新判 wait |
| buildSessionSteerText 档位钉死 | 122-138 | sessionTier 写进 steer 文本、review/resend 文案、无占位符 |
| runRealtimeTasks 百炼端点 | 140-167 | 普通端点并发池、请求体 model/enable_thinking、落盘 |
| 思考参数与 tps 采样 | 168-178 | budget=1024 带 thinking_budget、onTaskDone 上报 |
| 外部 signal 中止 | 180-190 | AbortController 中止后剩余任务不消费 |
| 并发池失败记账 | 192-217 | mock fetch 路由、失败进 notes、不中断、不落盘 |
| localPlan 兜底 | 219-230 | 顶层目录分组（src/root/docs），不造概念 |
| packArticles 横切装填 | 232-243 | 整篇装填与超预算头部截断 |
| scanRepoFiles 勘探 | 245-259 | 跳 node_modules/.git/二进制/超大/空文件 |
| 宿主 llm 通道 | 266-289 | provider 非空走 fakeLlm.stream，不打百炼 fetch |
| 宿主 llm 失败记账 | 291-305 | finish kind=error 记账进 notes |
| listModelCatalog | 307-329 | 宿主 provider/model 目录，跳过无 id，单 provider 失败保留 |
| GET /api/codewiki/models 端点 | 331-359 | installWebServer 注册、回环 200、非回环 403 |
| resolveModelEfforts 及端点 | 361-413 | 档位解析、默认档、上下文透出、端点参数校验 |
| resolveBatchApiKey | 415-436 | 显式配置 > 宿主凭据库，inject 数组/抛错处理 |
| fixAnchors 锚点修正 | 438-480 | 错行修正、歧义不动、区间钳制、CRLF 保真 |
| 总结输出 | 482-486 | 打印 ALL PASS/FAIL 并 `process.exit(1)` |

## Architecture

测试脚本执行涉及辅助函数、临时文件系统、mock 全局 fetch、被测 API 与日志输出，框图如下：

```text
┌────────────┐   ┌──────────────┐   ┌────────────────┐
│ test-batch │   │ mockJson /   │   │ globalThis.fetch│
│ .mjs 辅助  │──►│ section/check│   │ (mock handler) │
│ (行14-21)  │   └──────────────┘   └───────┬────────┘
└────────────┘                              │ calls
       │                                    ▼
       ▼                            ┌────────────────┐
┌────────────┐   ┌──────────────┐   │ batchCalls 记录│
│ 被测 API   │◄──│ 临时目录/文件 │   │ (行143,147)   │
│ (index.js) │   │ (fs.mkdtemp) │   └────────────────┘
└─────┬──────┘   └──────────────┘
      │
      ▼
┌────────────┐   ┌──────────────┐
│ console.log│──►│ .tmp-test-   │
│ (section/  │   │ batch.log    │
│ check)     │   │ (回溯日志)   │
└────────────┘   └──────────────┘
```

## Data Flow

1. 脚本启动，导入 `./index.js` 被测函数（行 7-12），定义 `passed`/`failures`/`check`/`section`/`mockJson`（行 14-21）。
2. 各测试段调用 `fs.mkdtempSync` 创建临时根（如行 32 `tmpRoot`、行 55 `workRoot`、行 247 `scanRoot`、行 440 `faRoot`），写入假源码文件。
3. 调用被测函数（如 `collectSources`、`prepareArticleTasks`），获取返回对象。
4. 使用 `check` 断言返回属性（如 `cs.text.includes(...)`、`prep.prepared.length`）。
5. 对于网络请求，在行 145 起替换 `globalThis.fetch` 为 mock，记录 `batchCalls` 并路由到 `handler`（行 144），返回 `mockJson`；测试后恢复 `originalFetch`（行 261）。
6. 宿主 llm 通道测试使用 `fakeLlm.stream` 生成器（行 272-279）替代 fetch。
7. 所有 `console.log` 输出被捕获进 `.tmp-test-batch.log`，最终在行 482 打印汇总。

## Connections

- 被测核心逻辑来自 [[index]] 模块（通过 `import ... from './index.js'` 在 test-batch.mjs 行 7-12 引用）。
- 日志回溯关联 [[batch-tests-log]]（即 `.tmp-test-batch.log` 实体）。
- 会话通道与任务装配关联 [[session-channel]]、[[article-tasks]]（基于 `prepareArticleTasks`、`classifySessionTask` 等命名推测的模块）。

## Known Issues

- **日志与脚本文案偏差**：`.tmp-test-batch.log` 第 22-24 行记载 `单文件超 28k 预算 → 升大档（200k）重装继续（分不出多批不拆分）` 与 `单文件连 200k 大档都装不下 → oversized（转超大兜底）`；而 `test-batch.mjs` 行 78 断言文案为 `单文件超 28k 预算且分不出多批 → 会话通道（不再升大档）`，行 81 为 `单文件连 200k 大档都装不下 → 会话通道（超大兜底已删除）`。表明日志可能是早期版本脚本的运行产出，回溯时需注意行为已变更为“不再升大档、直接会话通道”。
- **超大兜底删除**：test-batch.mjs 行 81 注释明确“超大兜底已删除”，即原可能的 oversized 兜底逻辑在当前被测代码中已移除，测试仅验证会话通道兜底。
- **CRLF 保真锁定**：fixAnchors 测试中（行 471-472）验证 CRLF 文章行尾保真，属回归锁定，无故障。
- **非回环拒绝依赖**：Web 端点测试（行 356-358、410-412）断言非回环地址返回 403，依赖 `socket.remoteAddress` 注入，实际部署需确保仅回环可达。