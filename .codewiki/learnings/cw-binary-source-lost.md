---
title: cw-binary-source-lost
type: learning
source_files:
  - index.js
tags: [vendor, rust, cw-cli, path-separator, windows, lesson]
---

## Overview

本文记录 `cw` CLI（Rust 编写的 CodeWiki 编译器）二进制源码丢失事件、插件层路径规范化修复的演进，以及最终通过 fork 上游源码完成根治的全过程。核心教训在于：`cargo install` 将源码置于临时目录导致不可恢复；盲目修改 vendor 快照会因架构差异导致“编译成功但行为错误”的陷阱；在无法控制上游时，应在消费点（插件层）收口并如实记录。当前代码已重建 fork，路径规范化下沉至 Rust 层，插件层保留纵深防御。

## Key Components

### index.js 中的路径规范化与状态解析

以下函数负责在插件层拦截 Windows 反斜杠污染，确保 `_index.md` 链接与 stale 任务路径跨平台安全：

- **`normalizeArticlePath(p)`** (`index.js:140`): 接收任意路径字符串，将 `\` 替换为 `/`。用于 `parseStatus` 清洗 stale/changed 文件列表。注释说明：cw 0.5.0.2 起 Rust 层已用 `rel_path_string` 输出 `/` 分隔路径，本层作为纵深防御（旧二进制或上游原版在 Windows 仍输出 `\`）。
- **`parseStatus(stdout)`** (`index.js:154`): 解析 `cw status` 输出。识别三态（`missing`, `uncompiled`, `clean`）及 `stale` 态。在 `stale` 态下，遍历匹配行 `^\s+[M!]\s+(.+)$`，分别调用 `normalizeArticlePath` 清洗 `changedFiles` 和 `staleArticles`。
- **`normalizeIndexLinks(cwd)`** (`index.js:144`): 读取 `.codewiki/_index.md`，正则替换 `[[link|` 头部的 `\` 为 `/`。幂等设计（无改动返回 `false`），静默跳过不存在文件。由 `tickIndex` 在 `cw index` 成功后调用。
- **`tickIndex(job)`** (`index.js:1579`): 编译收尾阶段。执行 `cw index` 和 `cw meta update` 后，若成功则调用 `normalizeIndexLinks` 并记录 note。同时调用 `ensureWikiEntry` 生成入口文件。

### 编排服务与批量流水线

- **`createJobService(config)`** (`index.js:1042`): 工厂函数，创建任务调度器。包含 `submit`, `cancel`, `list`, `findActive`, `start`, `stop` 方法。内部维护 `jobs` 数组、锁机制 (`acquireTickLock`)、断点续查 (`batchStateFile`) 及 TPS 采样。
- **`generateToolDefinition(cfg, svc)`** (`index.js:1744`): 定义 `codewiki_generate` 工具。执行逻辑包括：`cw status` 判态 → 幂等检查 → 孤儿断点续查 → scope 修正 → 提交后台 job。
- **`cwToolDefinition(cfg)`** (`index.js:773`): 定义 `cw` CLI 薄封装工具。提供 `init`, `status`, `index`, `meta`, `path`, `projects`, `setup`, `uninstall` 子命令。
- **`resolveBinary(cfg)`** (`index.js:81`): 解析 `cw` 可执行文件路径。优先级：`cfg.binaryPath` > PATH 探测 (`where`/`which`) > 插件自带 `bin/cw(.exe)`。注释强调：PATH 优先，避免捆绑二进制落后于源码时出现分叉。

### 配置项 (Config)

- **`Config`** (`index.js:36`): 基于 `@deepseek-ai/schemastery` 的定义对象。关键字段：
    - `binaryPath`: `cw` 可执行文件路径（留空优先用 PATH）。
    - `batchModel`: 批量推理模型（默认 `qwen3.7-flash`）。
    - `batchApiKey`: 阿里云百炼 API Key。
    - `excludePaths`: 排除编译的绝对路径清单。
    - `autoUpdate`: 是否启用自动增量编译。
    - `workspaceOnly`: 任务页是否仅显示已添加工作区的任务。

## Architecture

```text
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Tool Layer  │────>│  Job Service     │────>│  Bailian Batch  │
│ (cw /        │     │  (index.js       │     │  / Realtime     │
│  generate)   │     │   :606+)         │     │  (DashScope)    │
└──────────────┘     │                  │     └─────────────────┘
                     │  Stage Machine:  │              │
                     │  plan -> articles│              │
                     │  -> crosscut     │<-------------+
                     │  -> review       │
                     │  -> index        │
                     └────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  File System      │
                    │  .codewiki/       │
                    │  _index.md        │
                    │  modules/         │
                    │  concepts/        │
                    └───────────────────┘
```

**数据流说明：**
1. 用户调用 `codewiki_generate`，触发 `cw status` 获取仓库状态。
2. 根据状态（missing/uncompiled/stale/clean）决定提交 `full`、`stale` 或 `resume` 类型的 job。
3. Job 进入阶段机：`plan`（规划模块）→ `articles`（批量写模块文章）→ `crosscut`（横切：架构/模式/概念，可能拆分为观察批+合成批）→ `review`（批量校对）→ `index`（执行 `cw index` 并规范化链接）。
4. 全部模型调用走百炼批量推理（5折价），超预算任务实时兜底。
5. `cw` CLI 封装工具直接调用本地二进制，用于状态查询、初始化、索引重建等运维操作。

## Data Flow

### 路径规范化流程（Windows 修复）

```text
cw status 输出
      │
      ▼
 parseStatus() [index.js:154]
      │  匹配 /^\s+[M!]\s+(.+)$/gm
      ▼
 normalizeArticlePath(line) [index.js:140]
      │  replace(/\\/g, '/')
      ▼
 标准化路径 (/)
      │
      ├──> 存入 job.tasks (stale 更新)
      │
      ▼
cw index 落盘 _index.md
      │
      ▼
 normalizeIndexLinks(cwd) [index.js:144]
      │  正则 /\[\[([^\]|\n]*?)\|/g
      │  替换链接头部 \ 为 /
      ▼
 修正后的 _index.md
```

### 编译流水线阶段

1. **Plan**: 扫描源码文件 (`scanRepoFiles`) → 提交批量规划请求 → 解析 JSON 计划（模块/概念分组）。
2. **Articles**: 按模块分组提交批量写文章请求 → 处理 oversized 任务（实时兜底）→ 落盘模块文章。
3. **Crosscut**: 
   - 若总 token ≤ 预算：单批直出 `_architecture.md`, `_patterns.md`, `concepts/*`。
   - 若超预算：拆分观察批（每模块一篇观察）→ 合成批（基于观察写横切文章）。
4. **Review**: 对每篇成功文章提交批量校对请求（核对行号/source_files）→ 校验 frontmatter 后落盘。
5. **Index**: 执行 `cw index` → 规范化 `_index.md` 链接 → 执行 `cw meta update` → 确保 `CodeWiki.md` 入口存在。

## Connections

- [[core-logic]]：`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks` / `tickIndex` 所在模块。
- [[testing-suite]]：`test-wiki-entry.mjs` 23 断言（含规范化组）。
- [[batch-inference]]：百炼批量推理与实时兜底机制。
- [[job-service]]：`createJobService` 阶段机与断点续查逻辑。

## Known Issues

1. **vendor 快照误导**：早期尝试修改 `vendor/codewiki` 源码根治反斜杠问题，但因 vendor 是旧架构（wiki 位于 `~/.codewiki/`）而非现役二进制（wiki 位于仓库内 `.codewiki/`），导致“编译成功但行为错误”。教训：vendor 必须与现役二进制同源，否则修改无效。
2. **源码丢失风险**：`cargo install` 安装的 Rust 项目源码位于系统临时目录（如 `Temp/cw-src`），易被清理。事后追查仅能通过 `.crates2.json` 定位。教训：重要依赖源码应落盘至稳定位置（如 `vendor/` 或独立仓库）。
3. **上游架构差异**：上游 `mraza007/codewiki` 始终使用中心式 wiki 架构（`~/.codewiki/`），从未支持仓库内 `.codewiki/`。现役二进制是经过魔改的私有版本。教训：无法改上游时，在消费点（插件层）收口更可靠。
4. **路径分隔符污染**：Windows 下 Rust `Path::display()` 输出 `\`，污染 `_index.md` 的 Obsidian 链接格式。已在插件层通过 `normalizeIndexLinks` 和 `normalizeArticlePath` 解决，并在 cw 0.5.0.2 起下沉至 Rust 层根治。
5. **断点续查兼容性**：旧版断点文件（0.3.x）无 `stage` 字段，回退到 `articles` 阶段；新版（0.4.3+）携带 `stage` 和 `crosscutSplit` 标志。`submit` 函数需兼容两种形态。
## 审核补记（2026-10-10 下午）

本篇与前批流水线产物中的 `index.js:` 行号锚点系生成时幻觉（系统性偏移约 34~760 行，如 createJobService 606→实际 1042、tickIndex 975→实际 1579、resolveBinary 97→实际 81），审核时已全部对照真实源码修正（基线 main d14f7c9）。教训：流水线产物的行号声称必须抽查核对，校对阶段不可依赖。

> 2026-10-10 晚补记：该教训已制度化——test-wiki-anchors.mjs 对全部文章锚点做「行号范围 + 符号绑定 + 区间有序」三重自动断言（160 断言，负向注入可拦截），新增文章合入前跑一次即可。