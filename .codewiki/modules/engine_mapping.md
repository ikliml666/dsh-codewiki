---
title: engine_mapping
type: module
source_files:
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - test-engine-contract.mjs
  - lib/update-record.js
tags: [engine, mapping, fsoft, codewiki, integration]
---

## Overview

`engine_mapping`（源码 `lib/engine/mapping.js`）是 FSoft 原生引擎产物接入 cw（CodeWiki）的唯一一处「格式翻译」层。这是迁移到「FSoft 原生引擎 + 薄适配层」之后边界最窄、必须能被完整读一遍的模块：FSoft 引擎产出的是一棵 `docs` 树（`overview.md` + 模块页 + `module_tree.json` + `metadata.json` + `update_record.json`），而 cw 要的是仓库内 `.codewiki/` 的五类文章 + 顶层 `CodeWiki.md` 入口。两边不是同一个模型，`mapping.js` 负责把前者映射成后者。

入参（`pages` / `moduleTree` / `componentFiles` / `metadata` / `updateRecord`）由上游引擎桥提供，本模块只做纯函数映射、不读写文件、不 spawn 进程、不改技术内容（正文一字不动，链接规范化在引擎侧 `organize_docs` 完成）。它与 `lib/engine/contract.js` 共用 `ENGINE_CONTRACT_VERSION`，输出对象可 JSON 序列化、带 `contractVersion` 字段。

四类文件的语义映射（源：`lib/engine/mapping.js` 第 1–26 行注释）：

| FSoft 产物 | cw 落点 | 说明 |
|---|---|---|
| `overview.md` | `CodeWiki.md`（入口页，不是「文章」） | 只许一个 |
| 模块页 `{Name}.md` | `.codewiki/modules/<slug>.md`（`type=module`） | slug 由 `moduleSlug` 决定 |
| `module_tree.json` | 只作 `source_files` 证据来源，不落盘 | `.codewiki` 无此类型 |
| `metadata.json` | `.codewiki/_meta.yaml` 的 `last_compiled_commit` / `layout` | 见 `meta` 出参 |
| `update_record.json` | `.codewiki/temp/update-record.json` | 原样搬运 |
| artifact 页 | `pageKind=artifact` 的模块页 | 不冒充业务模块 |
| 父模块页（有 `children`） | `pageKind=parent`（`type=module`） | 仍 `type=module` |

四条硬规则（迁移安全边界，见 `lib/engine/mapping.js` 第 16–26 行）：
1. **不臆造 source_files**：只能来自真实组件→文件证据（`componentFiles` / `module_tree.components`），拿不到就空数组 + warning，绝不按目录名猜——0.14.0 的闸门靠 `source_files` 判定增量归属，编造会让未消化变化被静默基线化。
2. **不静默丢弃**：任何没被映射的页都进 `unmapped` 带可机读原因，由上层决定 `partial`。
3. **不覆盖**：slug 冲突（`A_B` 与 `A-B` 都 → `a-b`）时两页都进 `unmapped`，不许后到的赢。
4. **不改技术内容**：这里只搬路径与类型，正文一字不动；FSoft 原始树另存。

## Key Components

`lib/engine/mapping.js` 的公开 API 全部为导出常量与纯函数：

### 导出常量（路径约定）

- `WIKI_ENTRY` — `'CodeWiki.md'`（顶层 wiki 入口文件名），`mapping.js:30`
- `WIKI_DIR` — `'.codewiki'`，`mapping.js:31`
- `WIKI_META_REL` — `'.codewiki/_meta.yaml'`，`mapping.js:32`
- `WIKI_UPDATE_RECORD_REL` — `'.codewiki/temp/update-record.json'`，`mapping.js:33`
- `WIKI_MODULES_REL` — `'.codewiki/modules'`，`mapping.js:34`

### 导出函数

- `moduleSlug(name)` — `mapping.js:38`。模块名 → cw 惯用 kebab-case 文件名：ASCII 保留，其它折叠成 `-`（连续非字母数字替换为一个 `-`，去首尾 `-`，转小写）。实现见 `mapping.js:38-44`（`String(name ?? '').trim().replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()`）。

- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })` — `mapping.js:115`。核心映射函数，纯函数、不读写文件、不 spawn。完整实现见 `mapping.js:115-229`。默认参数 `pages=[]` `moduleTree={}` `componentFiles={}` `metadata={}` `updateRecord=null` `overviewName='overview.md'`（`mapping.js:116-122`）。

  入参：
  - `pages` — 引擎产出的页相对路径列表（POSIX，相对 docs 根），`mapping.js:101`
  - `moduleTree` — FSoft `module_tree.json` 内容（可为空对象），`mapping.js:102`
  - `componentFiles` — `{组件id: 仓库相对文件}`，`source_files` 的唯一证据来源，`mapping.js:103`
  - `metadata` — FSoft `metadata.json` 内容（`generation_info` 取 commit/layout/language），`mapping.js:104`
  - `updateRecord` — 可选 FSoft `update_record.json` 内容，`mapping.js:105`
  - `overviewName` — 可选 overview 页文件名（默认 `overview.md`），`mapping.js:106`

  出参（带 `contractVersion`，`mapping.js:216-228`）：
  - `entry` — `{path: CodeWiki.md, source}` 或 `null`（`mapping.js:133`）
  - `articles` — `[{source, wikiPath, type, pageKind, moduleName, sourceFiles, warnings}]`（`mapping.js:129`，单条结构见 `mapping.js:186-194`）
  - `unmapped` — `[{source, reason}]`（`mapping.js:130`）
  - `meta` — `{lastCompiledCommit, layout, language}`（`mapping.js:221-225`，取自 `metadata.generation_info` 的 `commit_id` / `layout` / `language`，见 `mapping.js:261-263`）
  - `updateRecord` — `{path, outcome, pagesWritten, pagesRemoved, source}` 或 `null`（`mapping.js:226`，构造见 `mapping.js:206-214`）
  - `warnings` — 全局告警（如模块树含某模块但引擎未产出对应页），`mapping.js:131`

### 内部辅助函数（非导出，仅供本模块调用）

- `posix(p)` — `mapping.js:46`。把 `\` 归一为 `/`。
- `normalizeSourceFiles(list)` — `mapping.js:48`。去重 + 去空 + 去 `./` 前缀，产出规范化相对路径数组。
- `sourceFilesOf(components, componentFiles)` — `mapping.js:62`。模块页的 `source_files`：只认组件→文件证据。组件 id 形如 `src/a.py::Class.method`，取 `::` 前的文件部分；`componentFiles` 里没有该组件则不计入（宁缺勿造）；无 `::` 且无映射则跳过（`mapping.js:62-72`）。
- `indexModuleTree(moduleTree)` — `mapping.js:76`。把 FSoft 的 `module_tree`（`{name: {path, components, children}}`）walk 成 `Map<name, node>`，每个 node 含 `{name, path, components, hasChildren, artifact, parent}`。`artifact` 由 `node.artifact` 或名称匹配 `/^artifacts?$/i` 判定，`artifact` 与 `parent` 信息会直接决定输出 `pageKind`（`mapping.js:76-96`，节点构造见 `mapping.js:83-90`）。

### 关键逻辑分支（在 `mapFsoftOutput` 内）

- overview 页去重：`entry` 已占用时后续同名页进 `unmapped`（`mapping.js:136-143`）。
- 非 markdown 页进 `unmapped`（原因「非 markdown 页，不属于文章」，`mapping.js:148-151`）。
- 页名在模块树不存在 → `unmapped`（原因「页名在模块树中不存在（无法确定归属与 source_files）」，`mapping.js:130-134`）。
- slug 空 → `unmapped`（「模块名无法规范化为文件名」，`mapping.js:158-161`）。
- slug 冲突 → 两页都进 `unmapped` 且从 `articles` 里回撤先到的那条（`mapping.js:163-175`）。
- 每篇文章计算 `pageWarnings`：有组件但无真实 `sourceFiles` 证据 → 警告「组件的 source_files 无真实映射证据（未臆造，按空处理）」；无组件 → 警告「模块无组件，source_files 为空」（`mapping.js:177-184`）。
- `pageKind` 取值：artifact 页取 `'artifact'`，有 children 的取 `'parent'`，否则 `'leaf'`（`mapping.js:190`）。
- 模块树里有但引擎没产出页的模块 → 推全局 `warnings`（「模块树含 X，但未产出 X.md（该模块文章缺失）」，`mapping.js:131-136`）。
- `updateRecord` 映射：仅当为 object 时构造，把 `pages_written` / `pages_removed` 经 `posix` 归一，`source` 固定 `'incremental'`（`mapping.js:206-214`）。

### 关联契约模块 `lib/engine/contract.js`（被本模块依赖）

本模块只消费其中的 `ENGINE_CONTRACT_VERSION`（`contract.js:20`，当前值 `1`，在 `mapping.js:28` 导入、`mapping.js:217` 写进输出）。契约模块的其它导出（`ENGINE_STAGES` / `TERMINAL_OUTCOMES` / `BLOCKER_KINDS` / `ENGINE_ERROR_CODES` / `engineResult` / `engineProgress` / `engineError` / `validateEngineResult` / `describeEngineResult`）不直接参与映射，但与映射输出一起被 [[engine_contract]] 消费方（JobService 终态判定、面板）使用，详见 `contract.js:217-234`。

## Architecture

`engine_mapping` 是一个纯函数翻译层，夹在 FSoft 引擎产物（docs 树）和 cw 写集（`.codewiki/` + `CodeWiki.md`）之间。它依赖 `contract.js` 的版本号常量，不依赖任何运行时服务，也不产生任何副作用。

```text
FSoft docs 树                         engine_mapping (lib/engine/mapping.js)        cw 写集
──────────────                        ────────────────────────────────────        ────────
overview.md ─────┐
{Name}.md   ─────┤  pages[]          ┌──────────────────────────────┐
module_tree.json─┼─► moduleTree      │ mapFsoftOutput()  (纯函数)    │  entry
metadata.json ───┤  metadata  ──────►│  moduleSlug / indexModuleTree │─►  CodeWiki.md
componentFiles ──┘  componentFiles   │  sourceFilesOf / normalizeSF  │  articles[]
                                      └──────────────┬───────────────┘  (.codewiki/modules/<slug>.md)
                                                     │                    unmapped[]
   ENGINE_CONTRACT_VERSION (lib/engine/contract.js:20) ─► 输出.contractVersion
                                                     ▼
                                      meta{lastCompiledCommit,layout,language}
                                      updateRecord{path,outcome,pagesWritten,...}
```

组件与职责边界：
- `mapFsoftOutput`（`mapping.js:115`）是唯一入口，编排 overview/模块页/元数据/更新记录的映射。
- `moduleSlug`（`mapping.js:38`）与 `indexModuleTree`（`mapping.js:76`）把外部命名规范化与层级展开。
- `sourceFilesOf`（`mapping.js:62`）+ `normalizeSourceFiles`（`mapping.js:48`）是「不臆造 source_files」硬规则的执行点。
- `contract.js` 仅提供版本常量，无行为耦合。

## Data Flow

完整数据流（行号指向 `mapping.js`）：

1. 入参解包与归一：`pages` 经 `posix` 归一（`mapping.js:123`），`moduleTree` 经 `indexModuleTree` 展开成 `Map`（`mapping.js:76`），`metadata.generation_info` 取出生成信息（`mapping.js:125-127`）。
2. 逐页处理（`mapping.js:135` 循环）：
   - overview 页 → 唯一 `entry`（`mapping.js:136-143`）。
   - 取页名 stem（`mapping.js:130-131`），非 `.md` 进 `unmapped`（`mapping.js:148-151`）。
   - stem 在模块树查节点，查不到进 `unmapped`（`mapping.js:130-134`）。
   - slug 计算（`mapping.js:130`），空则 `unmapped`（`mapping.js:159-161`）。
   - slug 冲突检测用 `usedSlug` Map（`mapping.js:164-175`）。
   - `sourceFilesOf` 取值 + 计算 `pageWarnings`（`mapping.js:214-221`）。
   - 组装 article 推入 `articles`（`mapping.js:129-137`）。
3. 模块树 vs 页清单对账：树里有但没产出页的模块推全局 `warnings`（`mapping.js:131-136`）。
4. update_record 映射（`mapping.js:205-214`）：仅当为 object 时构造，`source` 固定 `'incremental'`。
5. 返回带 `contractVersion` 的对象（`mapping.js:216-228`）。

输出语义要点：
- `entry` 可能为 `null`（没有任何页时，`mapping.js:133` 不触发，`mapping.js:133` 保留 `null`；测试见 `test-engine-contract.mjs:306-311`）。
- `articles` 每篇含 `sourceFiles`（真实证据或空数组）与 `warnings`（如 `mapping.js:179-184`）。
- `unmapped` 每条带 `reason` 字符串，供上层判 `partial`（硬规则第 2 条，`mapping.js:21-22`）。

## Connections

- [[engine_contract]] — `lib/engine/contract.js` 提供 `ENGINE_CONTRACT_VERSION`（`contract.js:20`），被本模块输出携带（`mapping.js:256`）。该模块的 `engineResult` / `validateEngineResult` / `describeEngineResult` 是消费本模块 `mapFsoftOutput` 输出（含 `unmapped` / `warnings`）的上层终态判定与面板文案依据。
- [[engine_llm_bridge]] — `lib/engine/llm-bridge.js` 与 `lib/engine/openai-bridge.js` 是同一引擎适配层的「模型桥」侧；它们处理 FSoft 引擎 → 宿主 `llm.stream` 的协议转换，而本模块处理的是引擎产物 → cw 文章的「落盘前格式翻译」。二者同属 `lib/engine/`，是迁移后「FSoft 原生引擎 + 薄适配层」的两个并行边界（`llm-bridge.js:90` 起桥、`openai-bridge.js:1` 纯转换）。
- [[engine_process_tree]] — `lib/engine/process-tree.js`（`terminateProcessTree` / `isAlive`，`process-tree.js:41-103`）是引擎子进程取消/终止的地基；本模块不碰进程，但二者同属引擎侧支撑层。
- [[update_record]] — cw 侧的 `buildUpdateRecord` / `saveUpdateRecord` / `describeOutcome`（`lib/update-record.js`）与本模块的 `updateRecord` 出参（`mapping.js:206-214`，搬运 FSoft `update_record.json` 到 `.codewiki/temp/update-record.json`）互为产物位置约定；`WIKI_UPDATE_RECORD_REL`（`mapping.js:33`）即 cw 侧读取路径。
- [[update_planner]] — `lib/update-planner.js` 的 `planUpdate` / `buildModuleMap` 是 cw 原有（非 FSoft）的模块规划与增量归属判定；本模块输出的 `sourceFiles` 正是 0.14.0 增量归属闸门要用的证据来源（见硬规则第 1 条，`mapping.js:213-216`）。
- 测试契约见 [[engine_contract]] 的测试 `test-engine-contract.mjs`（`test-engine-contract.mjs:24-30` 导入本模块 `mapFsoftOutput` / `moduleSlug` / 路径常量，并覆盖 overview/模块页/artifact/冲突/unmapped/空输入等全部分支）。

## Known Issues

- **source_files 证据缺失时只能空数组 + warning**：当模块组件既无 `::` 文件部分也无 `componentFiles` 映射时（`sourceFilesOf`，`mapping.js:62-72`），`source_files` 取空数组并写入 `pageWarnings`（`mapping.js:214-219`）。这是设计内的「不臆造」行为，但意味着上游若未提供证据，增量归属会缺依据——属硬规则约束，不是 bug。
- **slug 冲突导致两页都丢**：`A_B` 与 `A-B` 都规范化为 `a-b` 时，两页都进 `unmapped` 且先到的会从 `articles` 回撤（`mapping.js:163-175`）。这是「不覆盖」硬规则（`mapping.js:23-24`）的直接后果；命名冲突需在 FSoft 侧解决，本模块不会自动选边。
- **模块树列出但引擎未产页只告警不阻断**：`warnings` 会记录「模块树含 X，但未产出 X.md」（`mapping.js:131-136`），但不自动判定 `partial`——由上层根据 `unmapped` / `warnings` 决定是否 `partial`（硬规则第 2 条，`mapping.js:21-22`）。
- **无已知禁用/注释掉的功能**：本模块所有导出函数与常量均处于生效状态，`lib/engine/mapping.js` 与 `test-engine-contract.mjs` 中均无被注释或禁用的分支（测试覆盖见 `test-engine-contract.mjs:173-311`）。
