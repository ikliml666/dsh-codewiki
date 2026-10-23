---
title: documented-contract
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
tags: [文档契约, 跨模块, codewiki, frontmatter, 文章格式, 测试验证]
---

## Overview

`documented-contract` 指 dsh-codewiki 插件（当前版本 0.10.4，见 package.json:6）中由文档显式规定、并被代码与测试共同遵守的结构化约定。核心包含两层契约：(1) **入口契约**——仓库根 `CodeWiki.md` 声明为项目 wiki 入口（CodeWiki.md 公约），`codewiki_generate` 以其为起点细化出 `.codewiki/` 文章群，`ensureWikiEntry`(index.js:209) 在缺失时按语言生成模板；(2) **文章格式契约**——每篇生成的文章必须带 `---` frontmatter（`title`/`type`/`source_files`/`tags`）且含固定章节，由 `articleFormatSection`(index.js:675) 规定该模板。`writeValidated`(index.js:1396) 强制 frontmatter 闸门，`fixAnchors`(index.js:396) 依据 frontmatter `source_files` 修正行号锚点。测试侧 `articleMd`(test-orchestration.mjs:29) 与 schema 校验（test-orchestration.mjs:30-68）验证契约不被破坏，让文档自身成为可机器消费的索引。

## Key Components

### index.js 契约执行侧符号

- `articleFormatSection`(index.js:675)：定义文章模板，硬编码 frontmatter 键（`title`/`type`/`source_files`/`tags`）与章节顺序（`## Overview` 等）。
- `writeValidated`(index.js:1396)：落盘闸门，要求内容必须以 `---` frontmatter 开头，否则记 invalid 并丢弃。
- `parseSourceFiles`(index.js:1003)：解析文章 frontmatter 中的 `source_files`，支持 inline/block 格式，供 stale 更新或校对阶段消费契约。
- `fixAnchors`(index.js:396)：落盘前校正 `file:NN` 锚点，仅对 frontmatter `source_files` 内文件引用生效，符号歧义或多处出现时不改，绝不改文章其他内容。
- `ensureWikiEntry`(index.js:209)：保证入口 `CodeWiki.md` 存在，缺失时按语言生成入门模板（遵守公约）。
- `installUpdateReminder`(index.js:2842)：注入系统提示 section `codewiki:update-reminder`，仅当 cwd 存在 `CodeWiki.md` 时生效。
- `normalizeArticlePath`(index.js:162)、`normalizeIndexLinks`(index.js:166)：修正文章路径与 `_index.md` 链接反斜杠。
- `commitHintText`(index.js:2804)：基于 git log 时间戳的提交提醒（60s TTL 缓存），非 git 仓库不提醒，入口契约条件触发。
- `batchArticlePrompt`(index.js:515) 等提示词构造器：将 `articleFormatSection` 规定的格式指令注入批量编译请求。
- `createJobService`(index.js:1252)：内部 `submit`(index.js:2054) 接收编译任务，`tickArticles`(index.js:1634) 推进文章落盘，`saveJobs`(index.js:1184) 持久化且必落 `cancelRequested`。
- `generateToolDefinition`(index.js:2153) 与 `updateToolDefinition`(index.js:2312)：定义 `codewiki_generate`/`codewiki_update` 工具，复用执行并双重检查 `excludePaths`(index.js:2153 大小写不敏感子树匹配)。
- 常量：`PLUGIN_NAME='dsh-codewiki'`(index.js:1049)、`BATCH_TOKEN_BUDGET=110000`(index.js:1049)、`BATCH_TOKEN_HARD_LIMIT=128000`(index.js:1049)、`JOBS_FILE`(index.js:1049)、`MAX_JOBS_KEPT=30`(index.js:1049)、`REPOS_FILE`(index.js:1104)、`ORPHAN_TAKEOVER_MS`(index.js:1098)。

### test-orchestration.mjs 验证侧符号

- `articleMd`(test-orchestration.mjs:29)：合成符合 frontmatter 契约的假文章 markdown 文本，用于验证解析与落盘。
- `check`(test-orchestration.mjs:23)：断言收集器，`failures` 计数。
- `batchCfg`(test-orchestration.mjs:34)：返回 `{ batchProvider: 'workbuddy', batchModel: 'hy3' }` 等编译配置（0.10.1 起唯一通道）。
- `makeBatchMock`(test-orchestration.mjs:127)：核心 mock llm 服务，`answerFor`(test-orchestration.mjs:129) 按首行特征分发规划/观察/文章 markdown。
- `waitJob`(test-orchestration.mjs:192)：轮询 `JOBS_FILE` 取某 cwd 最新 job 终态（done/failed/cancelled）。
- `fakeReq`(test-orchestration.mjs:207) / `fakeRes`(test-orchestration.mjs:217)：模拟 HTTP 请求/响应验证回环端点守卫。
- 输出 schema 校验测试（test-orchestration.mjs:1015-1053）：同构校验器验证 `codewiki_generate` 输出，null 占位不报错。

### 数据结构（Struct/Model）字段

- **文章 frontmatter（文档契约结构）**：规定字段 `title`(字符串)、`type`(字符串，如 concept/module)、`source_files`(数组，含 POSIX 路径)、`tags`(数组)。文章正文须含 `## Overview`/`## Key Components`/`## Architecture`/`## Data Flow`/`## Connections`/`## Known Issues` 等固定章节（由 `articleFormatSection` index.js:675 规定）。
- **job 对象（持久化结构，index.js:2218 内部创建）**：字段 `id`(任务ID)、`cwd`(项目路径)、`wikiPath`(wiki路径)、`kind`(标记 `plugin:codewiki`，index.js:2218/471)、`scope`(auto/full)、`stage`(阶段机状态：queued→plan→articles→crosscut→compose→review→index)、`articles`(文章列表)、`tasks`(任务列表)、`usage`(用量)、`batchProgress`(进度)、`notes`(备注)、`updatedAt`(时间戳，用于孤儿接管 `ORPHAN_TAKEOVER_MS` 判断)、`cancelRequested`(取消标记，saveJobs 必落 index.js:2218)。`jobSummary`(index.js:1191) 聚合输出 `taskList`/`tps`。

## Architecture

```text
┌──────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ CodeWiki.md  │   │ index.js             │   │ test-orchestration  │
│ (入口公约)    │   │ articleFormatSection │   │ .mjs                │
│             │   │ (index.js:675)       │   │ articleMd           │
└──────┬───────┘   └──────────┬───────────┘   │ (test-orch:29)      │
       │                      │               └─────────┬───────────┘
       ▼                      ▼                         │
┌──────────────┐   ┌──────────────────────┐            │
│ ensureWiki   │   │ createJobService     │            │
│ Entry        │   │ (index.js:1252)      │            │
│(index.js:209)│   │ submit/tickArticles  │            │
└──────┬───────┘   │ (2054/1634)          │            │
       │           └──────────┬───────────┘            │
       │                      ▼                         │
       │           ┌──────────────────────┐            │
       └──────────►│ writeValidated       │◄───────────┘
                   │ (index.js:1396)      │ 校验 frontmatter
                   │ fixAnchors           │
                   │ (index.js:396)       │
                   └──────────┬───────────┘
                              ▼
                   ┌──────────────────────┐
                   │ client.js            │
                   │ CodewikiPanel        │
                   │ (client.js:1126)     │
                   └──────────────────────┘
```

## Data Flow

1. **契约定义**：`articleFormatSection`(index.js:675) 硬编码 frontmatter 键与章节顺序；CodeWiki.md（手写）声明入口公约。
2. **入口校验与补全**：`codewiki_generate` 执行时，`installUpdateReminder`(index.js:2842) 检查 cwd 是否有 `CodeWiki.md` 决定是否注入系统提示 section；`ensureWikiEntry`(index.js:209) 在缺失时生成入门模板（遵守公约）。
3. **文章生成与落盘**：规划/写文章阶段由 `prepareArticleTasks`(index.js:555) 装填，`batchArticlePrompt`(index.js:515) 等注入格式指令；`writeValidated`(index.js:1396) 在落盘前校验内容以 `---` frontmatter 开头，否则丢弃；`fixAnchors`(index.js:396) 依据 frontmatter `source_files` 修正行号锚点。
4. **契约回读**：后续 stale 更新或校对阶段，`parseSourceFiles`(index.js:1003) 解析文章 frontmatter 的 `source_files` 获取源码清单供消费。
5. **测试验证与面板消费**：`orchestration-tests` 中 `articleMd`(test-orchestration.mjs:29) 仿造契约文章；全量编译测试（test-orchestration.mjs:29）断言落盘 `modules/core.md` 等含正确 frontmatter；schema 校验（test-orchestration.mjs:29-67）对 `codewiki_generate` 输出做同构校验；client.js `CodewikiPanel`(client.js:1126) 轮询 `JOBS_PATH`(client.js:19) 获取文章进度并最终展示契约产物。

## Connections

- [[index.js]]：宿主侧主逻辑，包含 `articleFormatSection`(index.js:675)、`writeValidated`(index.js:1396)、`parseSourceFiles`(index.js:1003) 等契约执行器与阶段机。
- [[client.js]]：浏览器侧 React 面板（`CodewikiPanel` client.js:1126），通过回环端点消费契约产物并展示进度。
- [[test-orchestration.mjs]]：契约验证侧，构造假文章 `articleMd`(test-orchestration.mjs:29) 并校验输出 schema（test-orchestration.mjs:29-67）。
- [[CodeWiki.md]]：入口公约声明源，自身即 wiki 入口契约实例。
- [[README.md]]：描述工具与设置项（`batchProvider`/`batchModel` 等），承载契约文本侧。
- [[CHANGELOG.md]]：记录契约演进（如 0.8.5 source.kind 改 `plugin:codewiki`，0.10.1 删直连唯一通道等）。
- [[package.json]]：插件元数据（`version="0.10.4"` package.json:3），界定当前契约实现版本。

## Known Issues

- **版本错位非显然点**：`.tmp-test-orchestration.log` 记录旧版（主模型规划 + 百炼端点 + qwen3.7-flash + source 写作 `plugin/codewiki` 致 2 FAIL），与现行 `test-orchestration.mjs`（插件内批量池 + 宿主 llm 唯一通道 + workbuddy/hy3 + `plugin:codewiki`）矛盾；该日志仅作历史行为参考，合成文档须以源码+CHANGELOG 现行语义为准。

- **文档滞后点**：CodeWiki.md Overview 称「会话通道仅在超 128k 兜底」，但 CHANGELOG 0.10.4 已新增 bigTier 大档（`DEFAULT_BIG_PROVIDER='volces-ark'` index.js:555，超 128k 先走大档、连大档都装不下才会话通道），且本批 `test-orchestration.mjs` 未含 bigTier 测试（应在 index.js `prepareArticleTasks` index.js:555 覆盖）。

- **锚点修正局限**：`fixAnchors`(index.js:396) 只对 frontmatter `source_files` 内文件引用生效，符号歧义或多处出现时不改，绝不改文章其他内容，可能导致部分手工锚点未被规范化。

- **排除清单双重检查**：`excludedItem`(index.js:247) 大小写不敏感子树匹配，`submit`(index.js:2054) 与 `generateToolDefinition`(index.js:2153) 双重检查抛错，若含命中项直接拒绝提交。

- **日志非运行时调用**：`.tmp-test-orchestration.log` 是早期 test-orchestration.mjs 运行产物，不与现行源码直接调用，仅佐证历史行为。