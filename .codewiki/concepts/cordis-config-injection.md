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

`cordis-config-injection` 是 dsh-codewiki 插件在 DeepSeek Harness（基于 cordis 框架）中运转的核心机制，涵盖两方面：一是通过 `ctx.inject(['service'])` 严格获取宿主服务切片（如 tools、webServer、credentials、agents、llm、workspaceRegistry、slots、locale、configForms），遵循 cordis 严格语义（未 inject 直接访问服务属性即抛错）；二是配置的注入与热生效（via schemastery `.volatile()` 与 `liveConfig` 每次解包重读）。该概念横跨测试验证、文档描述与具体宿主/客户端代码实现，是插件装配、凭证解析与设置持久化的基石。

## Involved Modules

1. **orchestration-tests**（源文件 `test-orchestration.mjs`、`.tmp-test-orchestration.log`）：通过 `makeCtx` 构造 mock 宿主，其内部实现 `ctx.inject(deps, fn)` 支持带回调与 promise 风格（`test-orchestration.mjs:58-68`）；文末专门测试「严格 cordis 语义」——未 inject 访问 `ctx.agents` 抛错但 `apply` 不抛且工具仍注册（`test-orchestration.mjs:40-62`）。
2. **project-docs**（源文件 `README.md`、`CodeWiki.md`、`CHANGELOG.md`）：文档描述配置流（`profile patch config:` → cordis 注入 `apply` → `liveConfig` 每次解包，volatile 热生效，见 CodeWiki.md:51-53），以及 `apply` 内部 `ctx.inject(['tools','webServer','credentials'])` 注册工具与端点（CodeWiki.md:21）、`installUpdateReminder` 中 cordis 严格语义（CodeWiki.md:14）。
3. **plugin-runtime**（源文件 `index.js`、`client.js`、`package.json`）：宿主侧 `apply(ctx, config)` 的实际装配（`index.js:2775-2834`）与客户端侧 `apply(ctx)` 的插槽注入（`client.js:7-43`），包含 `liveConfig`（`index.js:2775-2797`）、`hostCtx.inject(['credentials'])`（`index.js:2775-2795`）、`ctx.inject(['workspaceRegistry'])`（`index.js:2775-2834`）等具体实现。

## Flow

1. **插件加载与配置注入**：宿主根据 profile patch 中的 `config:` 段构建 schemastery 配置对象，以 `apply(ctx, config)` 形式注入插件入口（`CodeWiki.md:49-51`）。`config` 内含 16 个键，全部标记 `.volatile()`，允许改完即生效（`index.js:2775-2792`）。
2. **服务切片注入（apply 装配）**：`apply` 执行时，首先通过 `ctx.inject(['agents'])` 与 `ctx.inject(['llm'])` 获取宿主服务引用并赋给模块级 `agentsRef`/`llmRef`（`index.js:2775-2780`、`index.js:2775-2834`）；随后 `ctx.inject(['tools'])` 注册四个工具，`installWebServer` 内 `ctx.inject(['workspaceRegistry'])` 获取仓库注册表（`index.js:2775-2834`），客户端 `client.js` 则 `inject(['slots','locale','configForms'])` 获得 UI 挂载点与配置表单（`client.js:390-426`）。
3. **严格语义保障**：cordis 要求服务必须显式 inject 才能访问；测试中模拟未 inject 访问 `ctx.agents` 抛错，而 `apply` 本身捕获异常不抛、已注册工具保留（`test-orchestration.mjs:57-79`）；`installUpdateReminder` 也依赖 `ctx.on('agent/created')` 与 inject 补装（`index.js:2767-2799`）。
4. **配置热读取与持久化**：运行时每次调用 `liveConfig(config)` 或 `val(x)` 重新解包 schemastery 对象并钳制范围（`index.js:59-87`）；client.js 侧通过 `form.subscribe` 监听快照，保存时以 `form.mutate(ops, snapshot.revision)` 单层 op + CAS 乐观并发写回宿主 `configForms`（`client.js:469-496`），形成「配置页修改 → 宿主持久化 → 下次 tick/execute 热读取」的闭环。
5. **按需凭证注入**：在批量编译需百炼通道时，`resolveBatchApiKey` 通过 `hostCtx.inject(['credentials'])` 动态解析 `ALIYUN_BAILIAN_API_KEY`，与 3 秒超时竞速（`index.js:352-372`）。

## Implementation Map

- **mock 与测试验证**：
  - `test-orchestration.mjs:58-68`：`makeCtx` 内 `ctx.inject(deps, fn)` 的 mock 实现（支持回调传切片与 promise 返回）。
  - `test-orchestration.mjs:1104-1126`：严格 cordis 语义测试块（未 inject 抛错，`apply` 不抛）。
  - `test-orchestration.mjs:83-97`：`makeMockAgent` 中 `agent.ctx.inject` 用于注册 systemPrompt section。
- **配置 schema 与热生效**：
  - `index.js:42-59`：`Config` 定义（16 键，全 `.volatile()`）。
  - `index.js:59-87`：`val(x)` 与 `liveConfig(config)` 重读取值并钳制。
  - `CodeWiki.md:12`、`:49-51`：文档对 volatile 热生效与配置流的说明。
- **宿主侧 apply 装配注入**：
  - `index.js:1154-1159`：模块级 `agentsRef`/`llmRef` 经 `ctx.inject` 赋值（cordis 语义强制）。
  - `index.js:2775-2834`：`apply(ctx, config)` 步骤 1（`inject(['agents'])`/`inject(['llm'])`）、步骤 4（`ctx.inject(['tools'])` 注册）。
  - `index.js:2468-2688`：`installWebServer` 中 `ctx.inject(['workspaceRegistry'])`（失败降级不过滤）。
  - `index.js:550-551`：`hostCtxRef` 捕获宿主上下文供批量路径注入凭证。
  - `index.js:352-372`：`resolveBatchApiKey` 中 `hostCtx.inject(['credentials'])` 竞速解析。
  - `index.js:2741-2773`：`installUpdateReminder` 中 `ctx.inject(['agents'])` 遍历补装系统提示。
- **客户端侧注入**：
  - `client.js:390-426`：`apply(ctx)` 内 `inject(['slots','locale','configForms'])` 及 `ctx.configForms.get(NS)` 获取表单句柄。
  - `client.js:428-455`：`CodewikiCard` 中 `form.subscribe` / `form.mutate` 配置持久化。
- **文档索引**：
  - `CodeWiki.md:21`：`apply` 的 `ctx.inject(['tools','webServer','credentials'])` 描述。
  - `CodeWiki.md:14`：`installUpdateReminder` 的 cordis 严格语义说明。
  - `README.md:26`：设置页保存走 `configForms.mutate`，与 patch 手改等价、热生效。