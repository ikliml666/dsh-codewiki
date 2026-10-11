---
title: update-reminder-entry-gap
type: learning
source_files:
  - index.js
tags: [reminder, gating, invariant, bugfix, hook]
---

## Overview

CodeWiki 编译流水线在 `tickIndex` 阶段新增 `ensureWikiEntry` 调用，自动在仓库根生成 `CodeWiki.md` 入口文件。该修复解决了此前 SessionStart 提醒因门控收紧至入口文件存在性检测、但链路中无代码创建该文件而导致的“永不注入”问题。

## Key Components

### 常量与配置

- `Config.updateReminder` (`index.js:45`): 布尔值配置项（默认 `true`），控制是否在会话系统提示中注入 CodeWiki 维护提醒。
- `Config.articleLanguage` (`index.js:44`): 字符串配置项（默认 `'中文'`），决定生成的入口文件语言。

### 函数

- `ensureWikiEntry(cwd, language)` (`index.js:187`): 
  - **用途**: 检查并生成仓库根 `CodeWiki.md` 入口文件。
  - **逻辑**: 
    1. 若 `cwd` 为空或文件已存在，返回 `false`（幂等，不覆盖人工入口）。
    2. 根据 `language` 参数选择中文或英文模板。
    3. 写入包含 `.codewiki` 绝对路径指引、`codewiki_generate` 收尾要求及“人工改写不覆盖”声明的 Markdown 内容。
  - **签名**: `export function ensureWikiEntry(cwd, language = '中文')`

- `reminderText(cwd)` (`index.js:2121`): 
  - **用途**: 动态生成提醒文案。
  - **逻辑**: 仅当 `updateReminder` 为真且 `CodeWiki.md` 存在时返回多行提醒文本；否则返回空字符串。

- `installUpdateReminder(ctx, config)` (`index.js:2131`): 
  - **用途**: 将提醒注入到 Agent 系统提示中。
  - **逻辑**: 
    1. 通过 `ctx.on('agent/created')` 监听新会话。
    2. 注入 `systemPrompt` section，order 设为 2901（紧接 TOOL_REPORT 之后）。
    3. `text` 回调实时求值：检查 `config.updateReminder` 开关及 `fs.existsSync(path.join(cwd, 'CodeWiki.md'))`。

- `cwToolDefinition.execute` (`index.js:813`): cw CLI 封装工具的执行逻辑，负责解析状态、运行子进程。

- `generateToolDefinition.execute` (`index.js:1787`): 编译工具的执行逻辑，负责判态、提交任务。

- `parseStatus(stdout)` (`index.js:154`): 解析 `cw status` 输出，提取 `state`, `changedFiles`, `staleArticles`。

- `normalizeArticlePath(p)` (`index.js:140`): 将 Windows 反斜杠路径规范化为正斜杠。

- `normalizeIndexLinks(cwd)` (`index.js:144`): 修正 `_index.md` 中链接头的反斜杠。

- `liveConfig(config)` (`index.js:56`): 从 Zod 对象中提取并标准化配置值。

- `val(x)` (`index.js:52`): 辅助函数，处理 Zod 代理对象的 `.get()` 方法。

### 测试

- `test-wiki-entry.mjs`: 单元测试文件，覆盖 `ensureWikiEntry` 的生成、幂等、语言切换、空输入安全，以及 `normalizeArticlePath`, `parseStatus`, `normalizeIndexLinks` 的路径规范化逻辑。

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        apply(ctx)                           │
│  ┌──────────────────┐   ┌──────────────────────────────┐   │
│  │ createJobService │   │ installUpdateReminder(ctx)   │   │
│  │                  │   │                              │   │
│  │ tickIndex(job)   │──►│ ensureWikiEntry(cwd, lang)   │   │
│  │ (final stage)    │   │  → creates CodeWiki.md       │   │
│  └──────────────────┘   └──────────────┬───────────────┘   │
│                                        │                   │
│  ┌─────────────────────────────────────▼─────────────────┐ │
│  │              installUpdateReminder                    │ │
│  │  agent/created hook → systemPrompt.section            │ │
│  │  text() callback: fs.existsSync(CodeWiki.md)?         │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **编译阶段**: `codewiki_generate` 触发全量或增量编译。
2. **收尾阶段**: `tickIndex` 执行 `cw index` 和 `cw meta update`。
3. **入口生成**: `tickIndex` 调用 `ensureWikiEntry(job.cwd, job.language)`。若文件缺失则创建，成功则记录 note `"仓库根缺 CodeWiki.md 入口，已自动生成"`。
4. **提醒注入**: 新 Agent 会话启动时，`installUpdateReminder` 注册系统提示段。每次渲染时实时检查 `CodeWiki.md` 是否存在。
5. **用户可见**: 若文件存在，Agent 在收尾前收到强制更新 wiki 的指令。

## Connections

- [[core-logic]]: 确保 Wiki 入口存在的不变量维护。
- [[testing-suite]]: `test-wiki-entry.mjs` 验证入口生成与路径规范化的正确性。

## Known Issues

- 无。此修复已通过端到端实证闭合了门控与创建者的脱节问题。