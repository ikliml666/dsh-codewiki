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

`documented-contract` 指 dsh-codewiki 插件中由文档显式规定、并被代码与测试共同遵守的结构化约定。核心包含两层契约：(1) **入口契约**——仓库根 `CodeWiki.md` 声明为项目 wiki 入口（CodeWiki.md:1-3），`codewiki_generate` 以其为起点细化出 `.codewiki/` 文章群；(2) **文章格式契约**——每篇生成的文章必须带 `---` frontmatter（`title`/`type`/`source_files`/`tags`）且含固定章节（`## Overview`/`## Key Components`/`## Architecture`/`## Data Flow`/`## Connections`/`## Known Issues`），由 `articleFormatSection()` 规定（index.js:597-626）。该契约让代码能解析 `source_files` 回溯源码、让测试能同构校验输出、让文档自身成为可机器消费的索引。

## Involved Modules

- **project-docs**（源文件 README.md / CodeWiki.md / CHANGELOG.md）：承载契约的文本侧。CodeWiki.md 公约定义入口与组件清单行号指针；README.md 描述工具与设置；CHANGELOG.md 记录契约演进。文档与代码同步是纪律，行号指针漂移由 `fixAnchors` 等机制补偿。
- **plugin-runtime**（源文件 index.js / client.js / package.json）：契约的执行侧。`index.js` 内 `articleFormatSection` 定义文章模板，`writeValidated` 强制 frontmatter 闸门，`parseSourceFiles`/`readSourceFiles` 消费契约，`ensureWikiEntry` 保证入口存在，`installUpdateReminder` 仅在存在 `CodeWiki.md` 时注入提醒。client.js 仅通过 HTTP API 展示契约产物。
- **orchestration-tests**（源文件 test-orchestration.mjs / .tmp-test-orchestration.log）：契约的验证侧。`articleMd` 构造符合 frontmatter 的假文章，`validateOut` 同构校验 `codewiki_generate` 输出格式，全量编译断言落盘文章路径与 frontmatter 合规，系统提示提醒测试验证入口契约生效条件。

## Flow

1. **契约定义**：`articleFormatSection()`（index.js:597-626）硬编码 frontmatter 键与章节顺序；CodeWiki.md（手写）声明入口公约（CodeWiki.md:1-3）。
2. **入口校验**：`codewiki_generate` 执行时，`installUpdateReminder`（index.js:2741-2773）检查 cwd 是否有 `CodeWiki.md` 决定是否注入系统提示 section；`ensureWikiEntry`（index.js:195-228）在缺失时生成入门模板（遵守公约）。
3. **文章生成与落盘**：规划/写文章阶段由 `prepareArticleTasks` 装填，`batchArticlePrompt` 等注入格式指令；`writeValidated`（index.js:531-547）在落盘前校验内容以 `---` frontmatter 开头，否则丢弃；`fixAnchors`（index.js:531-614）依据 frontmatter `source_files` 修正行号锚点。
4. **契约回读**：后续 stale 更新或校对阶段，`readSourceFiles`（index.js:939-947）解析文章 frontmatter 的 `source_files` 获取源码清单；`parseSourceFiles`（index.js:923-935）支持 inline/block 格式。
5. **测试验证**：`orchestration-tests` 中 `articleMd`（test-orchestration.mjs:29-30）仿造契约文章；全量编译测试（test-orchestration.mjs:29-59）断言落盘 `modules/core.md` 等含正确 frontmatter；`validateOut`（test-orchestration.mjs:1019-1057）对 `codewiki_generate` 输出做同构校验，确保契约不被破坏。
6. **面板消费**：client.js 轮询 jobs 端点获取文章进度，最终文章群（含契约 frontmatter）由人类/agent 通过 project-docs 索引阅读。

## Implementation Map

| 契约要素 | 实现位置（文件:行号） | 说明 |
|----------|----------------------|------|
| 入口公约声明 | CodeWiki.md:1-3 | 手写文档声明自身为 wiki 入口 |
| 文章格式规范 | index.js:597-626 (`articleFormatSection`) | 规定 frontmatter 与章节 |
| 入口缺失补全 | index.js:195-228 (`ensureWikiEntry`) | 按语言生成 CodeWiki.md 模板 |
| 入口存在判定注入提醒 | index.js:2741-2773 (`installUpdateReminder`) | 仅当 cwd 有 CodeWiki.md 注入 |
| 落盘 frontmatter 闸门 | index.js:1318-1334 (`writeValidated`) | 必须以 `---` 开头否则记 invalid |
| source_files 解析 | index.js:925-937 (`parseSourceFiles`), index.js:925-933 (`readSourceFiles`) | 供后续阶段消费契约 |
| 行号锚点修正依赖契约 | index.js:374-457 (`fixAnchors`) | 解析 frontmatter source_files 找符号 |
| 测试假文章构造 | test-orchestration.mjs:29-30 (`articleMd`) | 拼接含 frontmatter 假文 |
| 输出同构校验 | test-orchestration.mjs:1019-1057 (`validateOut`) | 验证 codewiki_generate 输出 |
| 全量编译落盘断言 | test-orchestration.mjs:450-480 | 断言 modules/*.md 等产出 |
| 系统提示入口契约测试 | test-orchestration.mjs:223-250 | 验证 CodeWiki.md 存在才注入 |