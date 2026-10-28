---
title: contract
type: module
source_files:
  - test-engine-contract.mjs
  - test-article-contract.mjs
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/article-contract.js
tags: [contract, test-helper, engine, mapping, article-contract, validation]
---

## Overview

`contract`（本文档所指的「contract」模块）不是仓库里的某个源码文件，而是一组**钉死契约形状与映射断言的测试辅助（test helpers）**：它们用 `node:assert/strict` 把「跨进程引擎契约」和「wiki 文章信封契约」两套契约的边界、语义不变量、映射去向**显式断言为可执行测试**，确保任何破坏契约的改动都会被 CI/单测拦下。

它对应两个测试文件：

- `test-engine-contract.mjs`（阶段 0）——钉死 FSoft 原生引擎的**跨进程结果契约**（`EngineResult` / `EngineProgress` / `EngineError`）以及 **FSoft 产物 → `CodeWiki.md` / `.codewiki/` 的映射**（`mapFsoftOutput`）。被测实现在 `lib/engine/contract.js` 与 `lib/engine/mapping.js`。
- `test-article-contract.mjs`（P0-4）——钉死**文章信封契约**：一篇 wiki 文章要满足的最低结构（frontmatter 闭合、`source_files` 证据、必需章节非空、死链、围栏闭合、重复贴头等）。被测实现在 `lib/article-contract.js`。

### 为什么需要这些测试辅助

迁移目标是把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」。一旦 Node 侧不再自己算依赖图/聚类/增量，跨进程边界就成了唯一的真相来源。**这条边界必须先有版本化、可校验、可断言失败的契约**，否则后面所有阶段（桥、JobService、cw 索引、自动提交）都会在「引擎返回了什么」上各猜一套——这正是 0.14.0 花一整轮修掉的缺陷类型（1 篇成功 + 19 篇失败也报 `done`）。同理，文章信封契约的旧闸门（`index.js:1005` 的 `validateArticleEnvelope`）只查 frontmatter 开合，导致大量坏文章入库（重复贴头、空章节、指向已删文件的 `source_files`、未闭合围栏），于是本测试套件把这些缺陷**逐条断言**成反例。

每个测试文件都自带一个轻量 `check(label, fn)` 运行器（不依赖任何测试框架），统一收集 `pass`/`fails` 并在末尾打印汇总、`process.exitCode = 1` 失败退出。两个套件**不共享任何别的 helper 文件**——断言逻辑直接内联在各自的 `.mjs` 里。

## Key Components

下面分两个测试套件列出**被导入、被断言的公开函数/常量**及其行号、用途，以及每个 test case 实际断言了什么。

### A. `test-engine-contract.mjs`（引擎契约 + FSoft 映射断言）

导入（`test-engine-contract.mjs:14-30`）：`ENGINE_CONTRACT_VERSION`、`ENGINE_STAGES`、`TERMINAL_OUTCOMES`、`engineError`、`engineProgress`、`engineResult`、`validateEngineResult`、`describeEngineResult`（来自 `lib/engine/contract.js`）；`mapFsoftOutput`、`moduleSlug`、`WIKI_ENTRY`、`WIKI_UPDATE_RECORD_REL`、`WIKI_META_REL`（来自 `lib/engine/mapping.js`）。运行器 `check` 定义在 `test-engine-contract.mjs:34-37`。

被测试实现的公开 API 与断言点：

| 被测导出（文件:行） | 用途 | 测试中实际断言的内容 |
| --- | --- | --- |
| `ENGINE_CONTRACT_VERSION`（`lib/engine/contract.js:20`） | 契约版本号 | `test-engine-contract.mjs:44` 断言等于 `1` |
| `ENGINE_STAGES`（`lib/engine/contract.js:24-33`） | 阶段枚举（env→graph→cluster→articles→validate→index→baseline→commit） | `:45` 断言顺序与全链路覆盖 |
| `TERMINAL_OUTCOMES`（`lib/engine/contract.js:35`） | 终态集合 `done/partial/failed/cancelled` | `:46` 断言排序后一致 |
| `engineResult(input)`（`lib/engine/contract.js:97-147`） | 构造归一化结果；非法输入**抛错** | `:49-51` 非终态 `outcome` 抛 `outcome` 错；`:54-59` `done` 带 `blockers` 抛 `done` 错；`:61-71` `partial` 缺 `blockers` 抛 `partial` 错、带则归一化；`:73-82` 数字字段归非负、缺省为 `0`；`:84-105` `engine.deps` 保留闭合证据、`ok` 仅严格 `true` 通过、summary 截断 2000 |
| `engineProgress(input)`（`lib/engine/contract.js:150-168`） | 推进中快照；非法 `stage` 抛错 | `:107-114` 非法 stage 抛 `stage` 错；`percent` 夹到 0–100 |
| `engineError(input)`（`lib/engine/contract.js:171-182`） | 可机读失败事实，`code` 决定 `retryable` | `:116-127` 未知 `code` 落 `engine-unknown`、`retryable=true`、`engine-crashed` 等确定性失败 `retryable=false` |
| `validateEngineResult(value)`（`lib/engine/contract.js:186-220`） | 反序列化边界**逐条校验、不抛错** | `:129-143` 合法结果 `ok=true`；`contractVersion` 越界/`partial` 缺 blockers/`writtenCount` 非数字均给 `errors`；`null` 返回 `ok=false` |
| `describeEngineResult(result)`（`lib/engine/contract.js:223-240`） | 四态文案 | `:145-156` 四态可一眼分清、`partial` 带首条阻塞原因 |
| `moduleSlug(name)`（`lib/engine/mapping.js:38-44`） | 模块名 → kebab-case 文件名 | `:189-194` `Core_Engine`→`core-engine`、`a/b::c`→`a-b-c`、空白→`''` |
| `mapFsoftOutput({...})`（`lib/engine/mapping.js:115-268`） | FSoft 树 → cw 写集 | `:196-334` 见下「映射断言」清单 |
| `WIKI_ENTRY`/`WIKI_UPDATE_RECORD_REL`/`WIKI_META_REL`（`lib/engine/mapping.js:32,33,32`） | 目标路径常量 | `:203`、`:322`、`:326` 断言路径值 |

**`mapFsoftOutput` 映射断言清单**（全部来自 `test-engine-contract.mjs`）：

- `:196-212` overview → `CodeWiki.md` 入口；模块页落到 `.codewiki/modules/<slug>.md`、`type=module`；`sourceFiles` 取真实文件；`meta.lastCompiledCommit/layout` 正确。
- `:214-235` 有 `children` 的模块页标 `pageKind=parent` 不平铺，叶页标 `leaf`。
- `:237-258` `source_files` 只来自真实证据：组件 id 的 `::` 前文件部分算证据、无证据组件**不猜**（空数组 + warning）。
- `:260-271` 没被映射的页进 `unmapped`（带 `reason`），绝不静默丢弃。
- `:273-290` artifact 页有明确 `pageKind=artifact`，不冒充业务模块。
- `:292-305` slug 冲突（A_B 与 A-B 都 → a-b）两页都进 `unmapped`，不覆盖。
- `:307-327` `update_record` 映射到 `.codewiki/temp/`，只搬运不改技术内容。
- `:329-334` 没有任何页时 `entry=null` 但结果仍可 JSON 序列化（`partial` 记账）。

### B. `test-article-contract.mjs`（文章信封契约断言）

导入（`test-article-contract.mjs:12-16`）：`inspectArticle`、`parseFrontmatter`、`parseYamlLite`、`extractSections`、`fencesBalanced`、`collectWikiLinks`、`hasDuplicateFrontmatter`、`issueSummary`、`REQUIRED_SECTIONS`、`TYPE_BY_DIR`、`hasBlockingIssue`、`makeWriteSet`、`isWritable`、`normalizeWritePath`、`SEVERITY`（来自 `lib/article-contract.js`）。运行器 `check` 定义在 `test-article-contract.mjs:20-23`，两个内联 helper：`GOOD(over)`（`:25-33`，生成一篇合格文章）与 `kinds(issues)`（`:34`，取 `issue.kind` 列表）。

被测试实现的公开 API 与断言点：

| 被测导出（文件:行） | 用途 | 测试中实际断言的内容 |
| --- | --- | --- |
| `inspectArticle(content, opts)`（`lib/article-contract.js:213-335`） | 主入口，返回 `issues[]` | `:36-39` 合格文章无 issue、`issueSummary` 为 `null`；`:42-51` 缺/unclosed frontmatter；`:53-58` 缺必填字段 `missing-field`；`:60-63` type 与目录不符 `type-mismatch`；`:65-75` 重复贴头 `duplicate-frontmatter` + `duplicate-section`、重复章节；`:77-86` 必需章节缺失/空 `missing-section`/`empty-section`；`:88-96` 非必需空章节只 `warning` 且 `hasBlockingIssue=false`；`:98-101` 围栏未闭合 `unclosed-fence`；`:103-108` `bad-source`（目录/绝对/越界）；`:110-119` `missing-source`（磁盘存在性，用 `fsImpl`）；`:121-126` `source-not-evidence`（不在 `readableSources`）；`:128-134` `dead-link`（不在 `allowedLinks`）；`:136-139` 空文章 `empty`；`:141-144` 有 frontmatter 但正文空 `empty-body`；`:146-149` `expectedType` 覆盖目录推断 |
| `parseFrontmatter(content)`（`lib/article-contract.js:77-90`） | 解析首份 `---` 块 | `:151-158` 块列表/行内列表/引号值/CRLF 解析正确，`closed=true` |
| `parseYamlLite(raw)`（`lib/article-contract.js:94-118`） | 极简 YAML | `:160-164` 注释行与空行不影响解析 |
| `extractSections(body)`（`lib/article-contract.js:138-158`） | 提取 `## 标题` 章节 | `:166-170` 围栏内的 `##` 不算章节 |
| `fencesBalanced(body)`（`lib/article-contract.js:161-164`） | 围栏成对 | `:172-175` 成对/单数 |
| `collectWikiLinks(body)`（`lib/article-contract.js:167-176`） | 收集 `[[名]]` 与 md 相对链接 | `:177-182` 收 `[[a]]` 与 `(b.md)`、不收外链 |
| `hasDuplicateFrontmatter(body)`（`lib/article-contract.js:179-193`） | 正文再贴一份 frontmatter | `:184-187` 单份不误报、双份报 `true` |
| `issueSummary(issues)`（`lib/article-contract.js:338-343`） | 压成一行文案 | `:203-208` 含「文章契约未通过」与首因 |
| `REQUIRED_SECTIONS`（`lib/article-contract.js:36-45`） | 按类型的必需章节表 | `:189-194` `concept` 不要求 `Key Components`、`module` 要求 |
| `TYPE_BY_DIR`（`lib/article-contract.js:19-26`） | 目录→type | `:193` `modules→module`、`learnings→learning` |
| `hasBlockingIssue(issues)`（`lib/article-contract.js:346-348`） | 是否有 error 级 | `:210-218` 结构破坏为 `error`（拒写）、缺章节为 `warning`（放行降 partial） |
| `makeWriteSet(paths)`（`lib/article-contract.js:352-355`） | 构造可写路径集 | `:220-232` 仅放行自身、拒绝越界 `../../`、绝对路径与 `cwd` 归一互通 |
| `isWritable(target, writeSet, opts)`（`lib/article-contract.js:365-378`） | 目标是否可写 | 同上 `:220-232` |
| `normalizeWritePath(p)`（`lib/article-contract.js:357-361`） | 规范化 POSIX 路径 | 被 `makeWriteSet`/`isWritable` 间接断言 |
| `SEVERITY`（`lib/article-contract.js:56-73`） | 问题分级表 | 通过 `empty-section-optional` 等 kind 间接断言 `severity` 字段 |

### 运行器行为（两个套件共有）

- `check(label, fn)`：包一层 `try/catch`，成功 `pass++` 打印 `PASS`，失败 push 进 `fails` 打印 `FAIL`（见 `test-engine-contract.mjs:34-37`、`test-article-contract.mjs:20-23`）。
- 末尾 `console.log(\`\n${pass} passed, ${fails.length} failed\`)`，有失败则遍历 `fails` 打印堆栈并置 `process.exitCode = 1`（见 `test-engine-contract.mjs:336-340`、`test-article-contract.mjs:234-238`）。

## Architecture

两个测试套件各自独立、互不共享 helper，但它们**断言的是同一批纯函数实现**（这些实现本身在 `lib/engine/` 与 `lib/article-contract.js`）。套件在「实现之上」加一层可执行的契约边界钉死。

```text
  ┌──────────────────────────── test-engine-contract.mjs ────────────────────────────┐
  │  check(label,fn) 运行器                                                       │
  │     │                                                                          │
  │     ├─► lib/engine/contract.js ── engineResult / engineProgress / engineError  │
  │     │                          ── validateEngineResult / describeEngineResult  │
  │     └─► lib/engine/mapping.js  ── mapFsoftOutput / moduleSlug                  │
  └───────────────────────────────────────────────────────────────────────────────┘
  ┌──────────────────────────── test-article-contract.mjs ──────────────────────────┐
  │  check(label,fn) 运行器  +  GOOD(over)/kinds(issues) helpers                    │
  │     │                                                                          │
  │     └─► lib/article-contract.js ── inspectArticle / parseFrontmatter /         │
  │                                 parseYamlLite / extractSections / fences...    │
  │                                 hasDuplicateFrontmatter / issueSummary /       │
  │                                 hasBlockingIssue / makeWriteSet / isWritable   │
  └───────────────────────────────────────────────────────────────────────────────┘
        │                                         │
        ▼                                         ▼
   引擎结果契约（版本/不变量）            文章信封契约（frontmatter/章节/证据）
   FSoft→CodeWiki 映射断言                source_files/死链/围栏/写集闸门
```

设计要点：

- **被断言的实现都是纯函数**（不碰文件系统、不 spawn 进程、不碰模型），所以测试套件可以在内存里喂构造好的输入直接断言返回结构，无需真实仓库或 Python 引擎（见 `lib/engine/contract.js:18`、`lib/engine/mapping.js:98`、`lib/article-contract.js:11`）。
- 唯一例外：文章信封测试里 `missing-source` 用 `fs.mkdtempSync` + `fsImpl = { exists: fs.existsSync }` 造了一个临时目录来断言磁盘存在性判定（`test-article-contract.mjs:110-119`）。
- 两套件都**不引入测试框架**，仅用 `node:assert/strict` + 内联 `check`，降低运行门槛（直接 `node test-*.mjs`）。

## Data Flow

测试辅助是「离线、内存内」的，数据流不触及真实引擎或磁盘（除一处磁盘存在性用例）：

1. **引擎契约套件**：`node test-engine-contract.mjs` → 内联构造 `moduleTree`/`componentFiles`/`metadata`（`test-engine-contract.mjs:162-187`）→ 喂给 `mapFsoftOutput` 与 `engineResult` 等纯函数 → `check` 用 `assert` 比对返回结构/抛错行为 → 汇总 `pass`/`fails`。
2. **文章信封套件**：`node test-article-contract.mjs` → `GOOD(over)` 生成合格文章字符串（`:25-33`）→ 喂给 `inspectArticle` 等纯函数（部分 case 提供 `fsImpl`/`readableSources`/`allowedLinks`/`expectedType` 注入依赖）→ `kinds(issues)` 取 `kind` 列表 → `assert.ok(kinds(...).includes(...))` 比对 → 汇总。
3. **失败路径**：任一 `check` 抛错 → 进入 `fails` → 末尾 `process.exitCode = 1`，可被 CI 捕获。

值得注意的输入注入点（`lib/article-contract.js:213-232` 的 `inspectArticle` 选项）：

- `cwd` + `fsImpl.exists` → 触发 `missing-source`（`test-article-contract.mjs:110-119`）；
- `readableSources` → 触发 `source-not-evidence`（`:121-126`）；
- `allowedLinks` → 触发 `dead-link`（`:128-134`）；
- `expectedType` → 覆盖目录推断（`:146-149`）；
- `requiredSections` / `allowEmptySourceFiles` → 测试里未直接断言，但属于同一 `opts` 面，调用方（`lib/engine/output.js`、`index.js`）会用到。

## Connections

- [[engine_contract]] —— 被测实现 `lib/engine/contract.js` 的模块说明（语义不变量、`EngineResult` 四态）。
- [[engine_mapping]] —— 被测实现 `lib/engine/mapping.js` 的模块说明（FSoft→CodeWiki 写集、`mapFsoftOutput`）。
- [[article_contract]] —— 被测实现 `lib/article-contract.js` 的模块说明（文章信封闸门本身）。
- [[engine_output]] / [[engine_core]] —— 运行时真正调用这些契约/映射的引擎侧（`buildWritePlan`/`validateOutput`）。
- [[update_record]] —— `validateEngineResult` 与 `describeEngineResult` 与 `lib/update-record.js` 同口径的四态文案。
- [[engine_bridge]] / [[engine_client_proc]] —— 运行时真正消费 `engineResult` 终态、`blockers` 决定 `partial` 的引擎桥/客户端（终态判定、面板、cw 基线、自动提交、降级提醒都在其下游）。

## Known Issues

- **两个套件不共享 helper、也不复用 fixtures**：`moduleTree`/`componentFiles`/`metadata` 在 `test-engine-contract.mjs:162-187` 内联；文章合格样本 `GOOD` 在 `test-article-contract.mjs:25-33` 内联。新增契约断言时容易各自复制一份，导致契约口径漂移风险——目前靠人工对齐，没有单一的「契约样本库」。
- **文章信封测试的 `GOOD` 只覆盖 `type=module`**：`test-article-contract.mjs:25-33` 写死了 `type: module` + `tags: [util]`，对 `concept`/`learning`/`decision`/`pattern`/`query` 等类型的缺省章节差异只通过 `REQUIRED_SECTIONS` 间接断言（`:189-194`），没有针对「非 module 类型缺 Key Components 不该报错」的正面用例。
- **`expectedType` / `requiredSections` / `allowEmptySourceFiles` 这些 `inspectArticle` 选项**：测试文件里**没有被直接断言**（见 `test-article-contract.mjs:146-149` 只测了 `expectedType` 触发 `type-mismatch`；`requiredSections`/`allowEmptySourceFiles` 仅源码中存在，调用方在 `lib/engine/output.js` 与 `index.js` 使用）。这是覆盖盲区，未来若改这些选项语义需手动补测。
- **映射套件依赖字符串常量断言而非类型**：`mapFsoftOutput` 的 `pageKind` 取值（`leaf`/`parent`/`artifact`）与 `attribution`（`attributed`/`unattributed`）仅以字符串比对断言（`:214-235` 的 `parent`/`leaf`、`:237-258` 的 `attribution=unattributed`、`:273-290` 的 `artifact`）；若枚举改名，测试会静默失配（断言失败而非编译失败）。
- **没有 golden diff 比对**：与 `test-fixtures/graphdiff-golden.json` 那种「产物快照」比对不同，两套件都是结构断言而非整文件快照，因此「字段被悄悄改名但不影响值」的回归（如 `writtenCount`→`written`）可能被漏掉——`validateEngineResult` 的逐条校验（`lib/engine/contract.js:201-206`）只对反序列化后的对象生效，构造路径（白名单归一化）的字段增删不在此列。
