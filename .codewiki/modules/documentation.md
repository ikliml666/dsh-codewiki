---
title: documentation
type: module
source_files:
  - CHANGELOG.md
  - CodeWiki.md
  - README.md
tags: [documentation, changelog, wiki, static-assets]
---

## Overview

`documentation` 模块负责维护 `@local/dsh-codewiki` 插件的静态文档资源，核心文件包括变更日志（`CHANGELOG.md`）、项目 Wiki 入口（`CodeWiki.md`）和自述文件（`README.md`）。这些文件共同构成了插件的元数据层，记录了从 v0.1.0 到 v0.8.7 的完整演进历史、架构设计、安装指南及工具行为规范。

该模块不仅作为人类阅读的项目文档，其内容还通过 `codewiki_generate` 工具被编译为 `<repo>/.codewiki/` 下的结构化文章，供智能体在会话中检索和使用。特别是 `CodeWiki.md`，它定义了插件自身的代码库结构，是“自举”编译的起点。当前版本已修复行号系统性幻觉问题（v0.8.7），确保锚点精确指向源码。

## Key Components

### CHANGELOG.md
位于仓库根目录，记录所有版本变更。格式遵循 Keep a Changelog 风格，按版本号倒序排列。最新稳定版为 **v0.8.7**。

- **v0.8.7 (2026-10-19)**：修复 wiki 文章行号系统性幻觉。新增 `numberLines()`（index.js:343），为 collectSources 内联源码添加 `N| ` 前缀，模型引用行号有据可依；校对 prompt 强制以源码前缀为准，禁止自行数行；旧文行号一律不得沿用。
- **v0.8.6 (2026-10-18)**：修复规划阶段没有真正继承当前对话模型。新增模块级 `llmRef`，`apply()` 里注入获取；`runMainModelPlan` 只读 `llmRef`，路由解析改为优先会话配置 `session.requestHeader()?.config`，解决 `hostCtxRef?.llm` 访问即抛导致的规划降级百炼问题。
- **v0.8.5 (2026-10-18)**：适配 DSH 0.2.1-rc.2 宿主协议。修正 `source` 形态为 `{kind:'plugin:codewiki'}`；新增 `engines.dsh` 声明以控制兼容性。
- **v0.8.4 (2026-10-15)**：实现文章阶段超预算分割机制。引入 `batchArticleObservePrompt` 和 `batchArticleComposePrompt`，将大源文件拆分为多个 ≤28k token 的观察批，再合成文章，避免触发 32k 档 3 倍价计费。
- **v0.8.3 (2026-10-15)**：规划阶段改走主模型。新增 `runMainModelPlan`，优先使用发起会话的主模型执行规划，仅在不可用时降级至百炼批量推理，以避开 32k 三倍价并加速编译。
- **v0.8.2 (2026-10-15)**：修复工具注册崩溃问题。根因是 `progress` schema 使用了 `type: ['object','null']` 数组形态，新宿主强制 JSON Schema 子集导致注册循环抛错并回滚全部效果。修复为 `oneOf` 结构并增加单工具防御性 try/catch。
- **v0.8.1 (2026-10-14)**：增强排除清单报错信息。工具拒绝编译时返回命中的具体排除项原文，帮助模型定位问题。
- **v0.8.0 (2026-10-14)**：实现编译终态实时唤醒。新增 `wakeCompileSession`，利用 DSH Agent inbox 机制向发起会话发送 steer 消息，提醒模型提交改动。
- **v0.7.0 (2026-10-14)**：新增 `codewiki_update` 工具和编译完成提交提醒。`updateReminder` 系统提示兼职注入完成提醒，基于 git 提交时间戳判断是否需要提醒。
- **v0.6.0 (2026-10-13)**：删除百炼批量推理专用通道。统一走百炼普通入口 `chat/completions`，保留后台并发池骨架但移除 Batch File/Batch Chat 特定逻辑，用户接受全价实时计费。
- **v0.5.0.6 (2026-10-12)**：新增 `codewiki_progress` 只读查进度工具。让模型可查询编译阶段、百分比和任务明细。
- **v0.5.0.5 (2026-10-11)**：切换百炼批量通道为 Batch Chat。从异步 Batch File 改为同步端点，免除上传排队，实现 5 折省钱（后于 0.6.0 移除此优化）。
- **v0.5.0.4 (2026-10-11)**：封死手工流程逃生通道。修改系统提示，禁止模型手动修改 `.codewiki/` 文件，强制走流水线。
- **v0.5.0.3 (2026-10-10)**：新增行号锚点自动校验测试 `test-wiki-anchors.mjs`，拦截流水线产物的幻觉行号。
- **v0.5.0.2 (2026-10-10)**：重构 `vendor/codewiki` 为本地 fork，根治 Windows 反斜杠路径污染问题。
- **v0.5.0.1 (2026-10-10)**：自动补建 `CodeWiki.md` 入口文件，闭合守护门控不变量。
- **v0.5.0 (2026-10-07)**：面板信息密度改版。六阶段步骤条、双通道吞吐徽标、用量统计、加权总进度条。
- **v0.4.11.2 (2026-10-07)**：放宽阶段实时阈值上限至 99,999,999，支持大仓库强制实时。
- **v0.4.11.1 (2026-10-07)**：孤儿任务接管机制。宿主重启后自动接管停更超过 5 分钟的旧实例任务。
- **v0.4.11 (2026-10-07)**：任务进度条与逐任务明细。显示批次进度 `n/m` 和 `taskList` 状态。
- **v0.4.10 (2026-10-06)**：端点加固与诊断。工作区过滤降级保护、handler 异常 500 响应、repos 缓存键隔离。
- **v0.4.9 (2026-10-06)**：工作区任务过滤。仅显示属于已添加 dsh 工作区的任务。
- **v0.4.8 (2026-10-06)**：仓库发现与一键排除。新增 `knownRepos` 清单和排除按钮。
- **v0.4.7 (2026-10-06)**：排除清单 + 自动更新 + 仓库总览与标签页。三标签页面板（总览/任务/设置）。
- **v0.4.6 (2026-10-06)**：面板收敛 + 实时 tps + Temp 残留自动清理。
- **v0.4.5 (2026-10-06)**：阶段实时阈值（混合通道）。`batchMinTokens` 设置，低于阈值走实时接口。
- **v0.4.4 (2026-10-06)**：侧边栏面板完善。滚动支持、工作区分组、设置参数移入面板。
- **v0.4.3 (2026-10-06)**：审查修复。取消可靠性、多实例安全、断点保真。修复 `jobServiceRef` 模块级引用导致的跨实例覆盖问题。
- **v0.4.2 (2026-10-06)**：超大任务升 256k 档继续走批量。避免直接实时兑底。
- **v0.4.1 (2026-10-06)**：横切精准拆分 (map-reduce) + 校对动态预算。
- **v0.4.0 (2026-10-06)**：服务化全批量流水线。零子代理，宿主常驻 JobService 驱动，32k 分块并行。
- **v0.3.2 (2026-10-04)**：批量推理异步化。提交即返回，宿主后台链自动收尾。
- **v0.3.1 (2026-10-04)**：批量推理凭证自动取模型设置「阿里百炼云」渠道。
- **v0.3.0 (2026-10-04)**：写文章环节可改走阿里云百炼批量推理 (Batch File)。
- **v0.2.8 (2026-10-03)**：写文章子代理活动行 label 带模型前缀。
- **v0.2.7 (2026-10-03)**：修复插件整体未装载（两个工具全部消失）。修正 `ctx.agents` 访问抛错问题。
- **v0.2.6 (2026-10-03)**：设置页支持选择子代理思考程度 (`reasoningEffort`)。
- **v0.2.5 (2026-10-03)**：Wiki 维护提醒注入会话系统提示。`installUpdateReminder`。
- **v0.2.4 (2026-10-03)**：修复子代理模型路由静默丢弃。补全两处 task 构造的 `route` 参数。
- **v0.2.3 (2026-10-03)**：修复 MSYS 路径误判、Windows 路径校验结果错、工具描述不符。
- **v0.2.2 (2026-10-02)**：审查修复 8 项。`scope=full` 不再被 clean 短路，`cw status` 非零退出抛错等。
- **v0.2.1 (2026-10-02)**：修复子代理服务接线断裂。`generateToolDefinition` 未接住 `subagents`。
- **v0.2.0 (2026-10-01)**：新增插件页设置 UI (`client.js`)。
- **v0.1.1 (2026-10-01)**：移除 codewiki 技能，默认模型钉死为 `aliyun-bailian/qwen3.8-flash`。
- **v0.1.0 (2026-10-01)**：首次发布。提供 `cw` 和 `codewiki_generate` 工具。

### CodeWiki.md
位于仓库根目录，是插件自身的项目 Wiki 入口。
- **功能**：定义插件代码库结构，供 `codewiki_generate` 编译成 `<repo>/.codewiki/` 下的文章。
- **关键部分**：
  - `Overview`：描述插件接入方式、编译流程（六环节）、Token 预算策略。
  - `Key Components`：详细列出 `index.js`、`client.js`、`vendor/codewiki` 等文件的职责和内部函数（如 `estimateTokens`, `collectSources`, `createJobService`）。
  - `Architecture`：ASCII 图展示编译流程和面板轮询机制。
  - `Data Flow`：配置流、凭证流、任务流、面板流。
  - `Connections`：链接上游 `codewiki-upstream` 和百炼接口。
  - `Known Issues`：注册不热加载、junction 依赖、cw 无 version 命令等。

### README.md
位于仓库根目录，项目自述文件。
- **提供**：表格列出 `cw`, `codewiki_generate`, `codewiki_update`, `codewiki_progress` 四个工具及设置页 UI。
- **设置**：详细说明 `binaryPath`, `defaultProvider/Model`, `maxConcurrency`, `articleLanguage`, `updateReminder` 等配置项的行为和热生效特性。
- **安装**：指导如何通过 `cordis.patch.yml` file:/// 直挂插件，以及 junction 依赖处理。
- **开发**：列出源码结构 (`vendor`, `bin`, `client`) 和验证命令。

## Architecture

```text
[开发者/Agent] ──调用──► [codewiki_generate / cw 工具]
        │
        ▼
[JobService.submit] ──► {submitted, jobId, stage} (立即返回)
        │ (宿主后台 tick 10s)
        ▼
[阶段机] ► plan ► articles ► crosscut ► review ► index ► meta update
        │     (全部走百炼普通入口 chat/completions)
        │     (装不下大档转超大兜底，超预算拆分观察批)
        ▼
[持久化] ◄── jobs.json (os.tmpdir)
        │
        ▼
[面板面板] ◄─2s 轮询── GET /api/codewiki/jobs
        │
        ▼
[浏览器 UI] ► CodewikiPanel (进度/取消/设置)
```

## Data Flow

1.  **配置流**：`profile patch config:` → cordis 注入 `apply(ctx, config)` → `liveConfig` 每次调用解包（volatile 热生效）。
2.  **凭证流**：显式 `batchApiKey` > 宿主凭据库 `resolve('ALIYUN_BAILIAN_API_KEY')`（模型设置「阿里百炼云」渠道）。
3.  **任务流**：`execute` 预构建（含 token 预算分块）→ `jobs.json` 持久化 → 服务 `tick` 消费 → 批次断点（未终态保留，跨会话续查）→ 文章落盘 + 校对回写 → `cw index/meta update`。
4.  **面板流**：浏览器 2s 轮询 `jobs` 端点（回环 only），获取任务状态、进度、用量等信息。

## Connections

- [[@local/dsh-codewiki]] — 本模块所属的插件模块，包含 `index.js`, `client.js` 等源码。
- [[codewiki-upstream]] — 上游 Rust CLI `cw` 项目，MIT 许可，位于 `vendor/codewiki/`。
- [[dsh-harness]] — DeepSeek Harness 宿主环境，提供 `agent`, `llm`, `webServer` 等服务注入。

## Known Issues

- **插件注册不热加载**：修改 `index.js` 或 profile patch 后需重启 dsh。`client.js` 同理，`dsh.client` 声明新增后需重启才能被宿主扫描器识别。
- **依赖 Junction**：`@deepseek-ai/schemastery` 依赖本地 junction，换机器需重建。
- **上游限制**：`cw` 无 `--version` 命令；`cw path` 在未 init 仓库退回 fallback；stale 文章路径输出反斜杠（插件侧已归一）。
- **断点语义变化**：0.5.x 批量通道的 24h 批次窗口语义已于 0.6.0 删除，当前断点仅记录阶段机位置。