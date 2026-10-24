---
title: wiki-generation
type: concept
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags:
  - wiki-generation
  - codewiki
  - 生成
  - 跨模块
  - 测试
  - 核心
---

## Overview

`wiki-generation` 是指 `@local/dsh-codewiki` 插件将代码仓库转化为结构化 CodeWiki 文档的端到端过程。该过程以 `codewiki_generate` 工具为入口，由后台常驻编排服务驱动阶段机（`articles → crosscut → compose → review → index`）逐步生成模块文章、横切文章与索引，并自动创建仓库根入口 `CodeWiki.md`、校正行号锚点。概念跨越文档说明、核心实现、测试验证与运行日志四大模块。

## Involved Modules

- **docs-and-meta**：以纯文本（README.md、CodeWiki.md、CHANGELOG.md、.probe3.txt）定义 `wiki-generation` 的人机接口、配置模型字段、版本演进与内部探针标记，为接入提供零上下文描述。
- **core-and-config**：插件唯一核心代码集合（index.js、client.js、cordis.patch.yml、package.json、.gitignore），实现 `wiki-generation` 全部逻辑：工具注册、阶段机编排、模型通道、配置 schema、浏览器面板与挂载。
- **test-scripts**：由五个 `.mjs` 脚本组成的测试套件（test-batch.mjs、test-cwd-paths.mjs、test-orchestration.mjs、test-wiki-anchors.mjs、test-wiki-entry.mjs），针对 `wiki-generation` 的纯函数、路径归一化、服务编排、锚点校验与入口生成进行集成验证。
- **logs-and-temp**：保存上述测试运行产生的临时日志（.tmp-test-*.log）及 watcher2.log，记录 `wiki-generation` 各环节断言结果与 job 监听状态，用于排查。

## Flow

1. **配置与理解**：开发者/agent 读取 `docs-and-meta` 中 README.md:15-22、README.md:55-66 与 CodeWiki.md:12 获取 `codewiki_generate` 行为与 `Config` 字段；通过 client.js 设置页或 cordis.patch.yml 写入配置，插件 `apply` 热读取（volatile）。
2. **任务提交**：会话内调用 `codewiki_generate`（index.js:1213 定义），其 `execute`（index.js:2240）运行 `cw status` 判态并提交 job 至 `createJobService`（index.js:1213），立即返回。
3. **阶段机推进**：服务以 `TICK_MS=10000` 节拍（index.js:1594）推进阶段机：文章阶段 `tickArticles` 调用 `prepareArticleTasks`（index.js:555）装填源码，`submitBatchFor`→`startBatchChatRun`→`runRealtimeTasks`（index.js:327）→`llmChat`（index.js:283）走宿主 llm 生成内容；结果经 `applyTaskResult`（index.js:306）落盘，`fixAnchors`（index.js:396）校正；`tickIndex` 跑 `cw index` 与 `ensureWikiEntry`（index.js:209）生成入口。
4. **进度展示**：client.js 的 `CodewikiPanel`（client.js:1124）轮询 `/api/codewiki/jobs` 渲染进度，`ReposTab`（client.js:979）轮询 `/repos` 总览。
5. **测试验证**：test-scripts 模块直接 `import './index.js'`，通过 `test-batch.mjs` 校验纯函数、`test-orchestration.mjs` 模拟上下文驱动阶段机（`gen.execute` 于 test-orchestration.mjs:448）、`test-wiki-entry.mjs` 验证入口生成、`test-wiki-anchors.mjs` 校验锚点符号绑定；断言结果写入 `logs-and-temp` 的 `.tmp-test-batch.log`、`.tmp-test-orchestration.log`、`.tmp-test-wiki-entry.log`、`.tmp-test-wiki-anchors.log`；watcher2.log 记录 job 轮询。
6. **演进追踪**：CHANGELOG.md 按版本记录 `wiki-generation` 行为变更（如 0.10.8 大档单请求优先），文档与代码同步。

## Implementation Map

关键实现位置（文件:行号）取自各模块文章：

**核心实现（core-and-config）**
- 插件入口与挂载：`cordis.patch.yml:13`、`index.js:2928 (apply)`、`package.json:2,3,7,8`
- 配置 Schema：`index.js:48-67`、`index.js:73 (liveConfig)`
- 工具 `codewiki_generate`：`index.js:2196` 定义，`index.js:2240` execute，`index.js:2255` cw status
- 编排服务与阶段机：`index.js:1213 (createJobService)`、`index.js:2018 (tick)`、`index.js:1594 (tickArticles)`、`index.js:1985 (tickIndex)`
- 文章任务装配与执行：`index.js:555 (prepareArticleTasks)`、`index.js:484 (collectSources)`、`index.js:327 (runRealtimeTasks)`、`index.js:283 (llmChat)`、`index.js:306 (applyTaskResult)`
- 锚点与入口：`index.js:396 (fixAnchors)`、`index.js:209 (ensureWikiEntry)`、`index.js:162 (normalizeArticlePath)`、`index.js:166 (normalizeIndexLinks)`、`index.js:176 (parseStatus)`
- 客户端面板：`client.js:1124 (CodewikiPanel)`、`client.js:979 (ReposTab)`、`client.js:408 (apply)`

**文档与元信息（docs-and-meta）**
- 工具与配置说明：`README.md:15-22`、`README.md:24-39`、`CodeWiki.md:12`、`CodeWiki.md:30-48`
- 变更与探针：`CHANGELOG.md:3-627`、`.probe3.txt:1`

**测试脚本（test-scripts）**
- 批量纯函数测试：`test-batch.mjs:7` 导入，`test-batch.mjs:24-454` 各块（含 `prepareArticleTasks` 等）
- 编排冒烟：`test-orchestration.mjs:20` 导入，`test-orchestration.mjs:40 (makeCtx)`，`test-orchestration.mjs:448 (gen.execute)`，`test-orchestration.mjs:197 (waitJob)`，`test-orchestration.mjs:444-539` 全量编译块
- 入口与路径：`test-wiki-entry.mjs:26-54 (ensureWikiEntry 测试)`，`test-wiki-entry.mjs:57 (normalizeArticlePath)`，`test-wiki-entry.mjs:60 (parseStatus)`，`test-wiki-entry.mjs:67 (normalizeIndexLinks)`
- 锚点校验：`test-wiki-anchors.mjs:14-115` 主循环，`test-batch.mjs:454 (fixAnchors 互验)`
- cwd 路径：`test-cwd-paths.mjs:22-69`

**日志与临时（logs-and-temp）**
- 测试日志：`.tmp-test-batch.log:1-85`、`.tmp-test-orchestration.log:1-573`、`.tmp-test-wiki-entry.log:1-25`、`.tmp-test-wiki-anchors.log:1-161`、`.tmp-test-cwd-paths.log:1-8`
- 监听日志：`watcher2.log:1-1397`