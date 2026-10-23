---
title: cordis-config-injection
type: concept
source_files:
  - test-orchestration.mjs
  - .tmp-test-orchestration.log
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - index.js
  - client.js
  - package.json
tags: [cordis, 依赖注入, 配置, 热生效, 插件架构]
---

## Overview

`cordis-config-injection` 是 dsh-codewiki 插件在 DeepSeek Harness（基于 cordis 框架）中运转的核心机制，涵盖两方面：一是通过 `ctx.inject(['service'])` 严格获取宿主服务切片（如 `tools`、`webServer`、`credentials`、`agents`、`llm`、`workspaceRegistry`、`slots`、`locale`、`configForms`），遵循 cordis 严格语义（未 inject 直接访问服务属性即抛错）；二是配置的注入与热生效（via schemastery `.volatile()` 与 `liveConfig` 每次解包重读）。该概念横跨测试验证（test-orchestration.mjs）、文档描述（README.md、CodeWiki.md、CHANGELOG.md）与具体宿主/客户端代码实现（index.js、client.js、package.json），是插件装配、凭证解析与设置持久化的基石。0.10.1 起编译模型通道强制为宿主 `llm` 服务，配置项 `batchProvider`/`batchModel` 成为唯一通道声明。

## Key Components

### 配置 Schema 与热生效（index.js）
- `Config` (index.js:48-67)：schemastery `z.object`，全部字段标记 `.volatile()`。字段清单：
  - `enabled` (boolean)
  - `binaryPath` (string)
  - `batchProvider` (string, 默认 `workbuddy`，0.10.1 起留空即提交失败)
  - `batchModel` (string, 默认 `hy3`)
  - `batchReasoningEffort` (string)
  - `bigProvider` (string, 默认 `volces-ark`)
  - `bigModel` (string, 默认 `glm-5.3-flash`)
  - `bigReasoningEffort` (string)
  - `bigTokenBudget` (number, 默认 `420000`)
  - `sessionTier` (string)
  - `maxConcurrency` (number, 默认 `2`，硬顶 `8`)
  - `serialProjects` (boolean, 默认开)
  - `articleLanguage` (string)
  - `updateReminder` (boolean, 默认开)
  - `excludePaths` (array)
  - `autoUpdate` (boolean)
  - `autoUpdateMin` (number, 最小 `5`)
  - `workspaceOnly` (boolean)
- `val(x)` (index.js:69)：兼容 `.get()` 函数与裸对象取值。
- `liveConfig(config)` (index.js:73-97)：合并默认值并钳制并发 `Math.min(concurrency,8)`、`autoUpdateMin` 最小 5、`bigTokenBudget` 至少 `BATCH_TOKEN_BUDGET`，每次调用重新解包 schemastery 对象实现热读取。
- 常量：`CONCURRENCY_HARD_CAP=8` (index.js:22)、`DEFAULT_CONCURRENCY=2` (index.js:24)、`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:26)、`DEFAULT_BATCH_MODEL='hy3'` (index.js:27)、`DEFAULT_BIG_PROVIDER='volces-ark'` (index.js:30)、`DEFAULT_BIG_MODEL='glm-5.3-flash'` (index.js:31)、`DEFAULT_BIG_TOKEN_BUDGET=420000` (index.js:33)、`BATCH_TOKEN_BUDGET=110000` (index.js:369)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:374)。
- `name` 导出 = `'dsh-codewiki'` (index.js:19)。

### 宿主侧 cordis 注入入口（index.js）
- `apply(ctx, config)` (index.js:2876)：cordis 入口。内部流程：
  1. `ctx.inject(['agents','llm'])` 获取宿主服务引用并缓存到模块级 `agentsRef`/`llmRef`
  2. `createJobService(config, wakeCompileSession)` 建服务并 `service.start()`
  3. `ctx.inject(['tools'])` 注册 `cwToolDefinition`/`generateToolDefinition`/`updateToolDefinition`/`progressToolDefinition`
  4. `installWebServer(ctx, service, {config,schedState,compile})` 注册 HTTP 端点
  5. `installUpdateReminder` 注入系统提示 section
  6. `setInterval` 60s 调 `generateDef.execute` 自动更新扫描。
- `installWebServer(ctx, service, ...)` (index.js:2569)：内部 `ctx.inject(['workspaceRegistry'])` 兼容切片与直传实例，`list()` 抛错降级不过滤 (index.js:2578-2597)；端点仅回环放行 (`isLoopbackRequest` index.js:2471)。
- `installUpdateReminder(ctx, ...)` (index.js:2842)：依赖 `agent/created` 注册 section `codewiki:update-reminder`，text 回调实时求值，门控不看 `.codewiki` 目录；未 inject 服务访问即抛。
- `commitHintText` (index.js:2804)：60s TTL 缓存键为 cwd，比对 `git log -1 --format=%ct` 与 `job.finishedAt`，未提交才提醒。
- `wakeCompileSession` (index.js:1239)：终态 steer 唤醒发起会话。
- `classifySessionTask` (index.js:1061)、`buildSessionSteerText` (index.js:1078)：会话任务分类与 steer 文本生成。
- `listModelCatalog` (index.js:2507)、`resolveModelEfforts` (index.js:2545)：模型目录与思考程度解析。
- `resolveBinary` (index.js:103)：PATH 优先探 `cw`，失败用捆绑副本。
- `runCw` (index.js:125)：spawn + 超时 SIGKILL + abort 监听。

### 客户端侧注入（client.js）
- `apply(ctx)` (client.js:412)：`ctx.inject(['slots','locale','configForms'])`；注册 `plugins.item`、`main`、`sidebar.panellist`。
- `NS='codewiki'` (client.js:17)：configForms 命名空间键。
- `CodewikiCard` (client.js:452)：通过 `form.subscribe` 监听快照，`form.mutate(ops, snapshot.revision)` 单层 op + CAS 乐观并发写回宿主配置。
- `ReposTab` (client.js:981)、`CodewikiPanel` (client.js:1126)：轮询回环端点展示进度/总览/取消。
- `modelTrio` (client.js:562)、`useEfforts` (client.js:524)：渲染提供商/模型/思考程度三联动。

### 测试 Mock 与验证（test-orchestration.mjs）
- `makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})` (test-orchestration.mjs:40-80)：构造 mock 宿主上下文，`inject(deps, fn)` (test-orchestration.mjs:58-68) 支持回调传切片与 promise，严格模拟宿主返回切片对象而非服务实例；`effect(fn)` (test-orchestration.mjs:73-77) 收集 disposer。
- `makeBatchMock({modules, articleMarker, stall, bigArticle, bigSources, planReply})` (test-orchestration.mjs:127-189)：mock 宿主 llm 服务，按 prompt 特征分发应答。
- `check` (test-orchestration.mjs:23-26)、`articleMd` (test-orchestration.mjs:29-30)、`batchCfg` (test-orchestration.mjs:34)、`makeMockAgent` (test-orchestration.mjs:83-97)、`makeFixtureRepo` (test-orchestration.mjs:99-109)、`waitJob` (test-orchestration.mjs:192-205)、`fakeReq`/`fakeRes` (test-orchestration.mjs:207-219) 等测试辅助。
- 严格 cordis 语义测试块 (test-orchestration.mjs:1104-1126)：未 inject 访问抛 getter，`apply` 不抛且工具仍注册。

### 文档与变更（README.md / CodeWiki.md / CHANGELOG.md）
- `README.md`：设置表，`codewiki_generate` 行为；0.10.1 起 `batchProvider/batchModel` 唯一通道 (README.md:29)。
- `CodeWiki.md`：`Config` 描述 (CodeWiki.md:12)，`apply` 注入 (CodeWiki.md:21)，`installUpdateReminder` 严格语义 (CodeWiki.md:14)。
- `CHANGELOG.md`：0.10.1 删内置百炼直连，submit 强制三项 (CHANGELOG.md:54-66)；0.8.6 改 `ctx.inject(['llm'])` 修复访问即抛 (CHANGELOG.md:147-155)；0.4.10 修复 inject 回调参数是 ctx 切片而非实例 (CHANGELOG.md:349)；0.2.7 改 `ctx.inject(['agents'], cb)` (CHANGELOG.md:488-494)。

## Architecture

```text
┌──────────────────────┐  ctx.inject(['agents','llm'])  ┌─────────────────────┐
│ cordis host (Harness)│ ────────────────────────────► │ index.js apply      │
│ services: tools,     │ ◄──── tools.register ──────── │ (index.js:2876)     │
│ webServer, agents,   │                               │  + installWebServer │
│ llm, workspaceReg,   │                               │  (index.js:2569)    │
│ configForms, creds   │                               └─────────┬───────────┘
└──────────────────────┘                                         │ ctx.inject
        │                                                        │ (['tools',
        │                                                        │  'workspaceReg'])
        │ ctx.inject(['slots','locale','configForms'])           ▼
┌──────────────────────┐                               ┌─────────────────────┐
│ client.js apply      │ ──────────────────────────── │ Config (volatile)   │
│ (client.js:412)      │  configForms.mutate          │ (index.js:48-67)    │
│ CodewikiCard/Panel   │ ───────────────────────────► │ liveConfig(index:73)│
└──────────────────────┘                               └─────────┬───────────┘
        │ makeCtx.inject mock                                      │ drives
        ▼                                                          ▼
┌──────────────────────┐                               ┌─────────────────────┐
│ test-orchestration   │                               │ JobService          │
│ makeCtx (mjs:40-80)  │                               │ createJobService    │
└──────────────────────┘                               └─────────────────────┘
```

## Data Flow

1. **配置加载与注入**：宿主根据 profile patch 中的 `config:` 段构建 schemastery 配置对象，以 `apply(ctx, config)` 形式注入插件入口。`config` 内含 18 个键（index.js:2876-2895），全部 `.volatile()`，允许改完即生效。
2. **服务切片注入（apply 装配）**：`apply` 执行时，首先 `ctx.inject(['agents','llm'])` 获取宿主服务引用并赋给模块级 `agentsRef`/`llmRef`；随后 `ctx.inject(['tools'])` 注册四个工具；`installWebServer` 内 `ctx.inject(['workspaceRegistry'])` 获取仓库注册表（兼容切片与直传，抛错降级不过滤）；客户端 `client.js` 则 `inject(['slots','locale','configForms'])` 获得 UI 挂载点与配置表单。
3. **严格语义保障**：cordis 要求服务必须显式 inject 才能访问；测试模拟未 inject 访问 `ctx.agents` 抛错，而 `apply` 本身捕获异常不抛、已注册工具保留 (test-orchestration.mjs:57-79)。真实宿主同理（CHANGELOG.md:349, :494）。
4. **配置热读取与持久化**：运行时每次调用 `liveConfig(config)` 或 `val(x)` 重新解包 schemastery 对象并钳制范围 (index.js:73-97)；client.js 侧通过 `form.subscribe` 监听快照，保存时以 `form.mutate(ops, snapshot.revision)` 单层 op + CAS 乐观并发写回宿主 `configForms` (client.js:493 与 679)，形成「配置页修改 → 宿主持久化 → 下次 tick/execute 热读取」闭环。
5. **通道演进**：0.10.1 删除内置百炼直连，submit 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，否则落 job `failed` (CHANGELOG.md:61)；旧版 `resolveBatchApiKey` 经 `hostCtx.inject(['credentials'])` 竞速解析已废弃，当前唯一通道为宿主 `llm` 服务（test-orchestration.mjs:114-122 `llmProxy` 恒转发 `activeLlm`）。

## Connections

- [[index.js]] 实现 `apply` 与 `Config` 及服务注入。
- [[client.js]] 实现配置表单注入与轮询。
- [[test-orchestration.mjs]] 端到端验证严格 cordis 语义。
- [[README.md]] 与 [[CodeWiki.md]] 描述配置流与注入点。
- [[CHANGELOG.md]] 记录注入修复与通道变更。
- [[dsh-codewiki]] 插件整体架构关联概念。

## Known Issues

- **测试日志 FAIL 2 项**：`.tmp-test-orchestration.log:301` 与 `:195` 显示 `source 标记 plugin:codewiki` 断言 ✗（wakeCompileSession 与全量编译块），实际 steer 消息 `source.kind` 形态未完全满足 v4 预期；日志中「规划走主模型」等 notes (`:137`) 与 mjs 源码注释「0.10.0 全流程插件内」存在版本错位，说明日志来自中间态构建。
- **严格语义降级风险**：未 inject 服务属性访问即抛 getter (test-orchestration.mjs:1104-1126, index.js installUpdateReminder)，但 `apply` 在严格语义下不抛错且工具仍注册，可能掩盖缺失服务导致静默降级。
- **registry 异常防御**：`brokenRegistry:true` 使 `workspaceRegistry.list()` 抛错，jobs/repos 端点仍 200 且不过滤 (index.js:2574-2593, test-orchestration.mjs:985-1013)。
- **commitHintText 缓存陷阱**：60s TTL 缓存键是 cwd，测试需用不同 fixture 仓库或大小写变体绕开 (index.js:2804-2829, test-orchestration.mjs:315-346)；writtenCount=0 不提醒。
- **自动更新扫描异常吞没**：扫描异常只记 `schedState.lastError` 不打断主流程 (index.js:2888-2890)。
- **路径归一局限**：`normalizeCwd` 仅 win32 将 `/c/...` 归一成 `C:/...`，POSIX 上 `/e/...` 可能是真实绝对路径原样保留 (index.js:37-42)。
- **排除清单精确报错**：compile/直调/子目录命中排除项时错误含命中排除项原文 (index.js:2056-2059, test-orchestration.mjs:866-879)。