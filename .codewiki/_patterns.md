---
title: _patterns
type: pattern
source_files:
  - test-orchestration.mjs
  - modules/orchestration-tests.md
  - modules/plugin-runtime.md
  - modules/project-docs.md
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - index.js
  - client.js
  - package.json
tags: [模式, 命名约定, 错误处理, 构建测试, 目录约定]
---

## Overview

本文基于仓库的三个模块文章（`modules/orchestration-tests.md`、`modules/project-docs.md`、`modules/plugin-runtime.md`）总结 dsh-codewiki 插件在命名约定、错误处理风格、构建/测试流程、目录约定等方面反复出现的模式。证据均引自对应模块文章中出现的具体源文件与函数名（如 `test-orchestration.mjs`、`index.js`、`README.md` 等），以便溯源。

## Patterns

### 模式：提交制工具与六阶段状态机

仓库的核心编译流程统一采用“提交即返回、后台推进”的提交制模式，并由常驻服务驱动六阶段状态机（queued→plan→articles→crosscut→compose→review→index→done）。

证据：
- `modules/orchestration-tests.md` 中描述 `codewiki_generate` 调用即提交返回 `{submitted, jobId, stage}`（`test-orchestration.mjs:459-463`），并验证阶段机推进与重启重跑（`test-orchestration.mjs:693-745`）。
- `modules/plugin-runtime.md` 中 `generateToolDefinition` 标注为“提交制（调用即入队、立即返回）”（`index.js:2064-2213`），`createJobService` 内含 `STAGE_HANDLER` 映射与 `tick()` 推进（`index.js:2064-2071`、`index.js:2064-2129`）。
- `modules/project-docs.md` 中 `README.md:10` 说明 `codewiki_generate` 为“提交制编译”，`CodeWiki.md:30-47` 架构图描摹同一阶段机。

### 模式：严格 Cordis 注入与 volatile 配置热生效

插件遵循 cordis 严格语义：未通过 `ctx.inject` 获取的服务属性访问即抛错；配置全部标记为 `.volatile()`，运行时经 `liveConfig` 重读并钳制。

证据：
- `modules/orchestration-tests.md` 记录“严格 cordis 语义：未 inject 访问 `ctx.agents` 抛错”（`test-orchestration.mjs:57-79`），且 `makeCtx` 使用 `ctx.inject(deps, fn)`（`test-orchestration.mjs:58-68`）。
- `modules/plugin-runtime.md` 中 `apply` 经 `ctx.inject(['agents','llm','tools','webServer','credentials'])` 装配（`index.js:2775-2834`），`Config` 全部 `.volatile()`（`index.js:42-59`），`liveConfig` 每次钳制（`index.js:2775-2797`），`hostCtxRef` 在 apply 捕获（`index.js:2775-2776`）。
- `modules/project-docs.md` 中 `CodeWiki.md:14` 提及“cordis 严格语义：未 inject 的服务属性访问即抛”，`README.md:38` 声明所有设置 `volatile` 热生效。

### 模式：错误处理——静默降级与显式抛错结合

仓库对预期边界采用静默容错（返回 null、降级过滤、记 note 不抛），对配置/凭证缺失则显式抛错带指引。

证据：
- `modules/plugin-runtime.md`：`runCw` 不抛错仅返回 `{exitCode, stdout, stderr, timedOut}`（`index.js:111-136`）；`resolveBatchApiKey` 超时返回 null（`index.js:111-131`）；`writeValidated` frontmatter 无效记 `invalid` 不落盘（`index.js:111-127`）；`workspaceRegistry.list()` 抛错时端点降级不过滤（`index.js:243-463`）。
- `modules/orchestration-tests.md`：`brokenRegistry=true` 时 jobs/repos 降级不过滤仍 200（`test-orchestration.mjs:985-1013`）；`wakeCompileSession` 无 sessionId/异常静默不抛（`test-orchestration.mjs:351-377`）。
- `modules/plugin-runtime.md` 中 `submit` 在百炼凭证缺失时显式抛“未找到百炼 API Key……编译流水线没有子代理回退”（`index.js:1965-2036`）。

### 模式：测试构建流程——Mock 宿主、llm 通道模拟与环境变量隔离

端到端测试统一通过动态导入 `./index.js` 获取 `{name, apply}`，用 mock 上下文与替换 `activeLlm`（经 `llmProxy` 转发）模拟宿主 llm 服务（百炼通道），并通过环境变量加速 tick 与隔离 JOBS 文件。

证据：
- `modules/orchestration-tests.md`：动态导入 `./index.js`（`test-orchestration.mjs:40`）；`makeCtx` 构造 mock 宿主（`test-orchestration.mjs:40-80`）；`makeBatchMock` 构造 mock llm 服务并经 `activeLlm`/`llmProxy` 模拟百炼通道（`test-orchestration.mjs:127-189`）；`process.env.DSH_CODEWIKI_TICK_MS='300'` 与 `DSH_CODEWIKI_JOBS_FILE` 隔离（`test-orchestration.mjs:40,19,28`）；`check(cond, msg)` 断言（`test-orchestration.mjs:23-26`）。
- `modules/project-docs.md`：`README.md:65` 验证命令含 `node test-orchestration.mjs`（mock 子代理 + 真实 cw CLI），`CHANGELOG.md:15` 记录测试断言数前后对照。

### 模式：目录与文件命名约定

仓库对产物、临时文件、捆绑二进制、上游源码有固定布局：wiki 产物置于 `<repo>/.codewiki/`（`modules/`、`concepts/`、`_architecture.md`、`_patterns.md`）；临时状态在 `os.tmpdir()` 下以 `dsh-codewiki-*` 前缀；捆绑 `bin/cw(.exe)`；上游 `vendor/codewiki/`；补丁 `cordis.patch.yml`。

证据：
- `modules/plugin-runtime.md`：`JOBS_FILE = env DSH_CODEWIKI_JOBS_FILE || os.tmpdir()/dsh-codewiki-jobs.json`（`index.js:977`），`SESSION_TASK_DIR` 同目录（`index.js:977`），`resolveBinary` 解析 `pluginDir/bin/cw(.exe)`（`index.js:89-109`）。
- `modules/project-docs.md`：`CodeWiki.md:28` 列 `vendor/codewiki/` + `bin/cw.exe`；`CodeWiki.md:27-28` 列 `cordis.patch.yml` 与 `package.json`；`README.md:45-46` 说明 `vendor/codewiki/` 与 `bin/cw.exe`。
- `modules/orchestration-tests.md`：`makeFixtureRepo` 建临时 git 仓库写 `src/core.py`（`test-orchestration.mjs:99-109`），全量编译落盘 `modules/core.md`、`_patterns.md` 等（`test-orchestration.mjs:99-129`）。

### 模式：文章 frontmatter 与章节结构约定

所有 wiki 文章遵循统一 frontmatter（`title/type/source_files/tags`）与固定章节（`## Overview / Key Components / Architecture / Data Flow / Connections / Known Issues`），横切模式文件类型标记为 `pattern`。

证据：
- `modules/plugin-runtime.md`：`articleFormatSection()` 规定 frontmatter 与章节（`index.js:597-626`）；`batchPatternsPrompt` 生成 `_patterns.md` (type:pattern)（`index.js:597-633`）；`slugify` 生成 kebab-case 文件名（`index.js:597-599`）。
- `modules/orchestration-tests.md`：`articleMd(title, source, marker='Batch-written', type='module')` 拼接假文章（`test-orchestration.mjs:29-30`），全量编译落盘 `_patterns.md`（`test-orchestration.mjs:29-59`）。
- `modules/project-docs.md`：`CodeWiki.md:3` 声明自身为入口公约，`CHANGELOG.md` 每版记录文档同步条目（如 `CHANGELOG.md:16`）。