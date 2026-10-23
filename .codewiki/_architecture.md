---
title: 系统总览
type: architecture
source_files:
  - test-orchestration.mjs
  - .tmp-test-orchestration.log
  - modules/orchestration-tests.md
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - index.js
  - client.js
  - package.json
tags: [架构, 总览, codewiki, dsh-codewiki, 插件, 测试, 文档]
---

## Overview

`dsh-codewiki` 是 DeepSeek Harness（DSH）插件（package.json:2-3），将 Rust CLI `cw` 接入宿主，并在其上实现一条零子代理、服务化、分批 LLM 的全仓库 wiki 编译流水线。本文章为系统总览，基于以下三个模块文章编写，面向零上下文的未来 agent：

- **plugin-runtime**（源文件 `index.js`、`client.js`、`package.json`）：插件核心代码，宿主侧流水线与服务 + 浏览器侧设置与面板。
- **orchestration-tests**（源文件 `test-orchestration.mjs`、`.tmp-test-orchestration.log` 及自身 markdown）：端到端编排冒烟测试，验证阶段机与工具行为。
- **project-docs**（源文件 `README.md`、`CodeWiki.md`、`CHANGELOG.md`）：面向使用者的三份手写文档，其中 `CodeWiki.md` 同时是 `codewiki_generate` 全量编译的入口。

下文通过总框图、数据流图、依赖方向图及模块职责说明，梳理各模块责任与相互连接。

## System Overview

插件运行时由宿主加载 `index.js` 的 `apply` 注册工具与常驻服务；测试模块动态导入同一 `index.js` 并在 mock 宿主中驱动验证；文档模块描述并引用运行时符号，且由运行时编译产出 `.codewiki` 文章群（含 `modules/project-docs.md` 自身）。

```text
┌─────────────────────────── System Overview 总框图 ───────────────────────────┐
│                                                                              │
│  ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────┐ │
│  │   plugin-runtime     │◄─────│  orchestration-tests │─────►│  project-docs│ │
│  │ (index.js/client.js/ │      │ (test-orchestration  │      │ (README/     │
│  │  package.json)       │      │  .mjs + log)         │      │  CodeWiki/   │
│  └─────────┬────────────┘      └─────────┬────────────┘      │  CHANGELOG)  │ │
│            │                             │                    └──────┬───────┘ │
│            │ dynamic import             │ mock ctx/apply             │ referenced│
│            ▼                             ▼                            ▼         │
│  ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────┐ │
│  │ JobService + LLM     │      │ makeCtx/apply/       │      │ CodeWiki.md  │ │
│  │ channels + HTTP API  │      │ makeBatchMock        │      │ convention   │ │
│  └──────────────────────┘      └──────────────────────┘      └──────────────┘ │
│            │                             │                                    │
│            │ produces                    │ validates                          │
│            ▼                             ▼                                    │
│  ┌──────────────────────┐      ┌──────────────────────┐                      │
│  │ <repo>/.codewiki/    │      │ .tmp-test-          │                      │
│  │ articles (incl.      │      │ orchestration.log    │                      │
│  │ project-docs.md)     │      └──────────────────────┘                      │
│  └──────────────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `plugin-runtime` 是系统核心：`index.js` 提供 `Config`（index.js:42-59）、`createJobService`（index.js:42-944）、`apply`（index.js:42-102）等；`client.js` 提供 `CodewikiCard` 与 `CodewikiPanel`（client.js:428-1273）。
- `orchestration-tests` 通过 `import('./index.js')` 获取 `{ name, apply }`（test-orchestration.mjs:20），用 `makeCtx` 构造 mock 宿主（test-orchestration.mjs:40-80）并调用 `apply` 注册工具，再借 `makeBatchMock` mock 宿主 llm 服务（test-orchestration.mjs:127-189）来验证阶段机。
- `project-docs` 中 `CodeWiki.md:3` 声明自身为插件 wiki 入口，`codewiki_generate` 将其细化为 `.codewiki/` 文章群（含本文 `modules/project-docs.md`），形成“文档描述代码、代码编译文档”的闭环。

## Data Flow

系统存在三条主要数据流：编译任务流（宿主侧）、面板轮询流（客户端）、测试模拟流（验证侧），以及文档消费/维护流。

```text
┌─────────────────────────── Request/Data Flow 数据流 ───────────────────────────┐
│                                                                                │
│  Agent/Human ──► codewiki_generate ──► submit() ──► JobService.queue           │
│      │             (index.js:2140)   (index.js:1962) (queued→plan→...→done)    │
│      │                    │                                                    │
│      ▼                    ▼                                                    │
│  client.js ──GET /api/codewiki/jobs──► HTTP API (index.js:2458) ──► list()     │
│  (2s poll)          ◄──── jobs JSON ◄───────────────────────────────────────  │
│      │                                                                         │
│  ┌───┴──────────────── LLM Batch Channel ────────────────┐                    │
│  │ plugin-runtime: runRealtimeTasks ─► llmChat/bailianChat│                    │
│  │   (index.js:311)                (index.js:269/295)     │                    │
│  └───────────────────────────┬───────────────────────────┘                    │
│                              ▼                                                 │
│                   writeValidated ──► <repo>/.codewiki/**.md (articles)         │
│                              │                                                 │
│  orchestration-tests: makeBatchMock mock 宿主 llm 服务 ─► 驱动阶段机         │
│   (test-orchestration.mjs:127)                                                │
│      │                                                                         │
│      ▼                                                                         │
│   waitJob轮询 JOBS_FILE ─► 终态 ─► wakeCompileSession (index.js:1151)          │
│                                                                                │
│  project-docs: README/CodeWiki/CHANGELOG 被阅读 ─► 理解结构 ─► 追溯决策         │
└────────────────────────────────────────────────────────────────────────────────┘
```

流程要点：

1. **任务提交**：`codewiki_generate.execute` 调用 `submit()`（index.js:1965），经凭证校验与 `serialProjects` 排队后，`void tick()` 立即推进阶段机（queued→plan→articles→crosscut→compose→review→index→done）。
2. **批量执行**：`tickArticles`/`tickCrosscut` 等阶段通过 `runRealtimeTasks`（index.js:311）并发调用 `llmChat`（provider 非空）或 `bailianChat`（百炼通道），结果经 `writeValidated` 落盘 `.codewiki` 文章（index.js:1550）。
3. **面板反馈**：`client.js` 每 2s 轮询 `GET /api/codewiki/jobs`（client.js:1077），经 `installWebServer` 注册的端点（index.js:2468）返回 `jobSummary` 视图。
4. **测试驱动**：`orchestration-tests` 用 `makeBatchMock` mock 宿主 llm 服务（test-orchestration.mjs:127），使 LLM 请求走预设答案，再以 `waitJob` 轮询 `JOBS_FILE` 取终态（test-orchestration.mjs:192），验证全流程。
5. **文档流**：使用者读 `README.md:5-13` 定位工具，读 `CodeWiki.md:9-28` 查组件行号，疑问时查 `CHANGELOG.md` 版本节（如 CHANGELOG.md:3）；版本发布时 `codewiki_generate` 重编译 `CodeWiki.md` 产出文章群。

## Dependency Graph

模块间依赖方向明确：测试与文档均依赖运行时实现，运行时不反向依赖二者（但产出文档产物）。外部依赖 `cw` 二进制与宿主服务。

```text
┌─────────────────────────── Dependency Graph 依赖方向 ───────────────────────────┐
│                                                                                │
│   orchestration-tests.md ──depends on──► plugin-runtime (index.js)              │
│        │                                   │   ▲                               │
│        │ test-orchestration.mjs:20         │   │ referenced by                  │
│        ▼                                   ▼   │                               │
│   test-orchestration.mjs ──────import────► index.js (export name,apply,        │
│                                              commitHintText,wakeCompileSession)│
│                                              │                                 │
│   project-docs.md ──described by──► README.md/CodeWiki.md/CHANGELOG.md         │
│        │                                   │   ▲                               │
│        │ generated from                    │   │ line-number refs               │
│        ▼                                   ▼   │                               │
│   CodeWiki.md (entry) ──compiled by──► codewiki_generate (index.js:2140)       │
│        │                                   │                                   │
│        ▼                                   ▼                                   │
│   .codewiki/modules/project-docs.md ◄──── plugin-runtime output                │
│                                              │                                 │
│   plugin-runtime ──bundles──► cw binary (vendor/codewiki, bin/cw.exe)          │
│   plugin-runtime ──uses─────► host llm/credentials/webServer (ctx.inject)      │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **orchestration-tests → plugin-runtime**：测试脚本动态导入 `./index.js`（test-orchestration.mjs:20），并使用其导出的 `commitHintText`（test-orchestration.mjs:284）、`wakeCompileSession`（test-orchestration.mjs:354）等符号；插件行为变更会直接破坏测试断言。
- **project-docs → plugin-runtime**：`CodeWiki.md` 组件清单硬编码 `index.js` 行号指针（如 CodeWiki.md:12 指向 `Config` index.js:42）；`codewiki_generate` 以 `CodeWiki.md` 为入口编译出 `modules/project-docs.md`（本文即产物），形成生成依赖。
- **plugin-runtime → 外部**：依赖捆绑的 `cw` 二进制（resolveBinary，index.js:2816）与宿主注入的 `tools`/`webServer`/`credentials`/`agents`/`llm`（apply 中 ctx.inject，index.js:2816）。
- 测试与文档之间无直接依赖，二者通过 plugin-runtime 间接关联。

## Module Roles

### plugin-runtime（核心实现模块）
- **职责**：提供插件全部逻辑。宿主侧 `index.js`（2911 行）定义 16 键 `Config`（index.js:42-59）、`cw` CLI 包装（index.js:42-198）、四个工具 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`（index.js:42-1668）、六阶段 `createJobService` 任务状态机（index.js:42-944）、loopback HTTP API（index.js:42-262）、系统提示提醒（index.js:42-74）。浏览器侧 `client.js` 提供设置卡 `CodewikiCard`（client.js:428）与侧边栏面板 `CodewikiPanel`/`ReposTab`（client.js:932-1277）。`package.json` 声明 ESM、依赖 schemastery、挂载 patch 与 client 平台。
- **连接**：被测试模块导入验证；被文档模块引用并编译产出文档文章；调用外部 `cw` 与宿主服务。

### orchestration-tests（编排测试模块）
- **职责**：端到端冒烟验证。 `test-orchestration.mjs`（66KB）通过 mock 宿主 llm 服务、真实 cw CLI、真实服务 tick，覆盖提交制、阶段机（plan→articles→crosscut→review→index）、stale 更新、宿主重启重跑、面板端点与取消、编译模型缺失诚实报错等（test-orchestration.mjs:1-6, 450-480, 688-742, 783-835, 1089-1102）。`.tmp-test-orchestration.log` 记录运行观测。自身 markdown 归纳组件与已知问题。
- **连接**：依赖 plugin-runtime 的符号与行为；不直接依赖 project-docs，但验证的插件行为在文档中有对应描述。

### project-docs（使用者文档模块）
- **职责**：对外说明插件。`README.md`（67 行）定位上手与设置项（README.md:5-13, 26-42）；`CodeWiki.md`（65 行）提供代码结构索引与架构图（CodeWiki.md:9-28, 30-47），并作为编译入口（CodeWiki.md:3）；`CHANGELOG.md`（515 行）倒序记录 50 版本演进（CHANGELOG.md:3-515）。三份文档通过“文档：”条目保持同步（如 CHANGELOG.md:16）。
- **连接**：被 plugin-runtime 编译产出 `.codewiki/modules/project-docs.md`；引用 index.js 行号指向 plugin-runtime；供未来 agent 与人类阅读，不直接参与代码执行。

以上为系统总览，未来 agent 可据此定位模块边界、数据流与依赖，进一步深入各模块文章。