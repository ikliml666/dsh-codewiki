---
title: engine_apply_output
type: module
source_files:
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/apply-plan.js
  - lib/engine/contract.js
  - lib/engine/quality-gate.js
  - test-engine-output.mjs
  - test-engine-apply-plan.mjs
tags: [engine, fsoft, stage-2, stage-3, write-plan, apply, validation]
---

## Overview

`engine_apply_output` 是 FSoft 原生引擎迁移里**把引擎产物变成仓库里真东西**的整条链路，横跨两个阶段、三个文件：

- **阶段 2（产物收集 + 写集计划）**：`lib/engine/output.js` + `lib/engine/mapping.js`。Python 引擎把 `docs/` 目录吐出来之后、落盘之前，这里先把 docs 读成结构化事实，再翻译成 CodeWiki 的写集描述（`entry` / `articles` / `unmapped` / `meta` / `updateRecord`），最后校验「这次产物自洽不自洽」（`validateOutput`，`lib/engine/output.js:184`）。
- **阶段 3（落地器 / apply）**：`lib/engine/apply-plan.js`。质量门（`quality-gate.js`）给出「这批页能不能入库」的采用裁决（report）之后，这里把裁决**原子地**落地成仓库内的 `.codewiki/` 与 `CodeWiki.md`——写盘 → `cw index` → 基线（`cw meta update`）→ 自动提交，并对每一步失败按三条硬不变量处置（写集封闭 / 索引基线失败回滚 / 提交失败不回滚）。这一层独立成篇，见子模块 [[engine-apply-output/apply-plan]]。

### 为什么需要这一整条链路（迁移动机）

0.14.0 的教训是「1 篇成功 + 19 篇失败也报 done」：把「写成几篇」当成了「成立」。所以迁移把「产物能不能用」「产物能不能被采用」「入库这件事真的成立了没有」拆成三道各负其责的闸门（`lib/engine/output.js:7-16`、`lib/engine/quality-gate.js:1-33`、`lib/engine/apply-plan.js:1-9` 三处文件头注释共同表述）。本模块负责其中后两道：

1. **产物自洽**（阶段 2 / output.js）：页在不在、正文空不空、链接指向的东西在不在计划内。坏输入变成 `problems` 而不是异常（`lib/engine/output.js:84-90`）。
2. **落地成立**（阶段 3 / apply-plan.js）：写盘/索引/基线/提交每一步都可能失败，必须各自独立处置，不能把「部分落盘」当成「done」（`lib/engine/apply-plan.js:1-22`）。

### 模块边界（安全不变量）

- 阶段 2 不重新聚类、不做图 diff、不改写文章正文——FSoft 已经算完了（`lib/engine/output.js:8-12`）；不臆造 `source_files`（沿用 `mapping.js` 证据规则）；不把 problem 降级成 warning（缺页就是缺页，上层据此判 partial）。
- 阶段 3「可注入」不等于「默认什么都不做」：默认自带同语义的内置提交器 `commitWikiArtifacts`，否则自己跑起来产物只落盘不入库却仍报 done——那正是「提交失败被改写成成功」的前身（`lib/engine/apply-plan.js:24-34`）。
- 阶段 3 **不 import `index.js`**（那里是插件主入口，会连带拉起宿主服务与 webServer），`runCw` / `commit` / `normalizeIndexLinks` / `verifyCommit` 全部由调用方注入（`lib/engine/apply-plan.js:24-27`）。

### 问题类别枚举（阶段 2）

`OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:22-34`）是稳定、可机读的 12 类枚举，上层按 `kind` 分派（**不要靠 message 文本匹配**）：

| kind | 含义 |
| --- | --- |
| `missing-docs-dir` | 引擎没产出 docs 目录 |
| `missing-metadata` | 缺 `metadata.json`（无法确定 commit/layout） |
| `missing-module-tree` | 缺 `module_tree.json`（无法确定归属与 source_files） |
| `empty-module-tree` | `module_tree.json` 是 `{}`：归属证据缺失，写集只能算 unattributed |
| `bad-json` | JSON 存在但不可解析 |
| `entry-missing` | 没有 `overview.md`，即没有 `CodeWiki.md` 入口 |
| `empty-body` | 页面除标题外没有正文 |
| `article-missing` | 模块树里有模块，但没有对应页 |
| `unmapped-page` | 页在 docs 里，但映射不到 wiki 的任何位置 |
| `source-missing` | `source_files` 指向的文件在仓库里不存在 |
| `dead-link` | 正文里的相对链接指向计划外的文件 |

## Key Components

### Stage 2 — output.js + mapping.js（产物收集 / 写集计划）

### Stage 2 — output.js + mapping.js（产物收集 / 写集计划）

`output.js` 全部公开符号同时挂在 `default` 导出对象上（`lib/engine/output.js:288`）。

**常量与内部工具**

- `OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:22-34`）— `Object.freeze` 的 12 类问题枚举数组（见 Overview 表格）。
- `PROBLEM_SET`（`lib/engine/output.js:36`）— 由 `OUTPUT_PROBLEM_KINDS` 构造的 `Set`，用于 `validateOutput` 里防自由发挥地校验 `kind` 是否登记（`lib/engine/output.js:188`）。
- `posix(p)`（`lib/engine/output.js:38`）— 路径反斜杠归一化为 `/`，空值安全。
- `stripBom(s)`（`lib/engine/output.js:39`）— 去掉 UTF-8 BOM（`\uFEFF`），JSON 解析前必过。
- `TEMP_DIR = 'temp'`（`lib/engine/output.js:43`）— `docs/temp/` 是工作文件（依赖图/引用索引/artifact 索引），递归扫描时跳过。

**导出函数**

- `listMarkdownPages(rootDir, rel='')`（内部，`lib/engine/output.js:44-62`）— 递归列出 docs 下所有 markdown 页，返回 POSIX 相对路径且已排序。跳过以 `.` 开头的隐藏目录与 `temp` 目录（`lib/engine/output.js:55`），只收 `.md`/`\.md$/`i 匹配的文件（`lib/engine/output.js:59`）；顶层 `readdirSync` 失败时返回空数组不抛（`lib/engine/output.js:49-51`）。
- `readJsonIfExists(file, problems, kind, { optional=false })`（内部，`lib/engine/output.js:64-82`）— 读一个 JSON 文件并归并进 `problems`：文件缺失仅当 `!optional` 才 `push({ kind })`（`lib/engine/output.js:69-71`，全量首轮本来没有 `update_record`）；存在但坏了**永远**报 `bad-json`，不因为「文件可选」就吞掉（`lib/engine/output.js:77-81`）。
- `collectOutput({ docsDir })`（`lib/engine/output.js:91-124`）— **只读、不抛**：把 docs 目录读成结构化事实，返回 `{ docsDir, exists, pages, json:{metadata,moduleTree,firstModuleTree,updateRecord}, problems }`。`docsDir` 为空/不可读 → `missing-docs-dir`（`lib/engine/output.js:101-111`）；`pages` 用 `listMarkdownPages` **递归**收集（`lib/engine/output.js:116`，hierarchical 布局把子模块页放在子目录里）；四个 JSON 槽位分别读 `metadata.json`/`module_tree.json`（`missing-metadata`/`missing-module-tree`）与两个可选件 `first_module_tree.json`/`update_record.json`（`bad-json`，`optional`，`lib/engine/output.js:118-122`）。
- `bodyLength(text)`（`lib/engine/output.js:127-137`）— 去掉标题行与空白后剩余的正文字符数，用于判「这页其实只有个标题」。找到首个 `#{1,6} ` 标题后才算正文，正文所有空白压掉后取 `.length`（`lib/engine/output.js:132-136`）；只有标题 → 返回 `0`。`test-engine-output.mjs:65-70` 断言覆盖。
- `relativeLinks(text)`（`lib/engine/output.js:140-152`）— 收集正文里的相对 markdown 链接目标。正则 `/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g` 抓链接；跳过空目标、锚点（`#`）、带协议头的（`http:`/`mailto:`/`data:`，`lib/engine/output.js:147-148`）；反斜杠归一化为 `/` 后返回。`test-engine-output.mjs:72-77` 验证它跳过外链/锚点/图片 data URI。
- `buildWritePlan({ docsDir, componentFiles={}, overviewName='overview.md' })`（`lib/engine/output.js:162-173`）— 建写集计划薄壳：先 `collectOutput` 再 `mapFsoftOutput`，返回 `{ collected, mapped }`（`lib/engine/output.js:164`）。`componentFiles` 是「组件 id → 仓库相对文件」的唯一证据来源（`lib/engine/output.js:164-171`）。
- `validateOutput({ docsDir, repoRoot, componentFiles={}, overviewName='overview.md' })`（`lib/engine/output.js:184-278`）— 校验产物自洽性，**不抛、也不修任何东西**，返回 `{ ok, problems, mapped, collected, stats }`。`push(kind,...)` 若 `kind` 不在 `PROBLEM_SET` 里直接抛错（`lib/engine/output.js:187-190`）。做 6 项检查 + 死链检查：`entry-missing`（`lib/engine/output.js:187`）、`empty-module-tree`（`lib/engine/output.js:199-207`）、逐页 `empty-body`（`lib/engine/output.js:214-225`）、`unmapped-page`（映射 `mapped.unmapped`，`lib/engine/output.js:228`）、`article-missing`（`mapping` 的 `warnings` 匹配 `未产出` 升级而来，`lib/engine/output.js:230-233`）、`source-missing`（仅当给了 `repoRoot` 才查 `fs.existsSync`，`lib/engine/output.js:236-248`）；死链只查 docs 内相对 `.md` 链接（`lib/engine/output.js:250-265`，指向 `../src/...` 的源文件交给阶段 3）。`ok = problems.length === 0`（`lib/engine/output.js:268`）。`collected` 原样带出供阶段 3 读 `metadata.generation_info.commit_id`（`lib/engine/output.js:271-273`）。
- `emptyStats()`（内部，`lib/engine/output.js:284-286`）— 返回全 0 的 stats，用于 `docsDir` 缺失早退。

**`lib/engine/mapping.js` 公开导出（阶段 2 的映射依赖）**

`output.js` 通过 `mapFsoftOutput` 把 docs 翻译成写集描述。关键公开符号：

- `WIKI_ENTRY = 'CodeWiki.md'` / `WIKI_DIR = '.codewiki'` / `WIKI_META_REL = '.codewiki/_meta.yaml'` / `WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'` / `WIKI_MODULES_REL = '.codewiki/modules'`（`lib/engine/mapping.js:30-34`）— 写集落点常量。
- `moduleSlug(name)`（`lib/engine/mapping.js:38-44`）— 模块名 → kebab-case 文件名（ASCII 保留，其它折叠成 `-`）。
- `mapFsoftOutput({ pages, moduleTree={}, componentFiles={}, metadata={}, updateRecord=null, overviewName='overview.md' })`（`lib/engine/mapping.js:115-268`）— 纯函数，返回 `{ contractVersion, entry, articles, unmapped, meta:{lastCompiledCommit,layout,language}, updateRecord, warnings }`（`lib/engine/mapping.js:255-267`）。四条硬规则：不臆造 `source_files`、`unmapped` 不静默丢弃、slug 冲突两页都进 unmapped（不覆盖）、正文一字不动（`lib/engine/mapping.js:16-26`）。`articles[].pageKind ∈ leaf/parent/artifact`（`lib/engine/mapping.js:62`）；空模块树（whole-repository 模式）下页仍进写集但 `sourceFiles=[]`/`attribution='unattributed'`（`lib/engine/mapping.js:177-187`）；`source_files` 只认组件→文件证据（`sourceFilesOf`，`lib/engine/mapping.js:62-72`）。

**测试文件（阶段 2）**

- `test-engine-output.mjs`（28 项 `check`）— 覆盖 `bodyLength`/`relativeLinks`/`collectOutput`/`buildWritePlan`/`validateOutput` 的每一类 problem，含「两次调用结果稳定（无隐藏状态）」与「未登记的 problem kind 会被拒」（`test-engine-output.mjs:206-217`）。

### Stage 3 — apply-plan.js（落地器，已派生子模块）

阶段 3 落地器把质量门（`lib/engine/quality-gate.js` 的 `gateNativeOutput` 返回值）的采用裁决原子地落地成仓库内的 `.codewiki/` 与 `CodeWiki.md`，完整实现见子模块 **[[engine-apply-output/apply-plan]]**。本模块文章的 Overview、Architecture、Data Flow、Known Issues 都已把它纳入整体链路。

落地器对外暴露的关键符号（行号以源码前缀为准）：

- `APPLY_VERSION`（`lib/engine/apply-plan.js:43`）、`APPLY_WRITE_ROOTS = ['.codewiki','CodeWiki.md']`（`lib/engine/apply-plan.js:52`）、`APPLY_STAGES = ['write','index','baseline','commit']`（`lib/engine/apply-plan.js:62`）、`APPLY_PROBLEM_KINDS`（6 类写集校验问题，`lib/engine/apply-plan.js:52-59`）、`APPLY_RESULT_KINDS`（8 类落地结果词表，`lib/engine/apply-plan.js:62-73`）。
- `checkWriteTargets(items)`（`lib/engine/apply-plan.js:86-131`）— 写集校验纯函数（写集封闭：绝对路径/盘符/`..` 上跳/白名单外/空路径/重复/非字符串 content）。
- `verifyCommitScope(repoRoot, sha, {allowExtra, files})`（`lib/engine/apply-plan.js:224-237`）— `git show --name-only` 反查提交范围，判是否只动了 wiki 产物。
- `commitWikiArtifacts(cwd, {jobId, writtenCount})`（`lib/engine/apply-plan.js:250-295`）— 阶段 3 自带的小提交器（同 `autoCommitWiki` 安全边界，但不建主题分支）。
- `toApplyBlockers(problems)`（`lib/engine/apply-plan.js:309-320`）— 落地问题 → 契约 `BLOCKER_KINDS`（`lib/engine/contract.js:42-53`，`lib/engine/apply-plan.js:298-307` 是映射表）。
- `applyNativeOutput({ repoRoot, report, docsDir, ... })`（`lib/engine/apply-plan.js:414-725`）— 主入口：写盘 → cw index → 基线 → 自动提交，失败按三条硬不变量回滚。

**测试文件（阶段 3）**

- `test-engine-apply-plan.mjs`（~50 项断言）— 全部用临时目录 + 注入桩，不碰真仓库、不跑真 cw，验收对象是**三条不变量**：写集封闭（`test-engine-apply-plan.mjs:283-299`）、索引/基线失败回滚（`test-engine-apply-plan.mjs:305-338`）、提交失败不回滚（`test-engine-apply-plan.mjs:357-368`）；真实 git 只用于 `verifyCommitScope`（`test-engine-apply-plan.mjs:613-648`）。

## Architecture

整条链路是「阶段 2 读+映射+校验 → 质量门裁决 → 阶段 3 落地」三段式，组件少但职责边界严格。框图如下：

```text
┌──────────────────────────────────────────────────────────────┐
│ Python 引擎 (lib/engine/python/entry.py) 吐出 docs/ 目录        │
│   overview.md + *.md + metadata.json + module_tree.json        │
│   + first_module_tree.json(可选) + update_record.json(可选)     │
└───────────────────────────────┬──────────────────────────────┘
                                  │ docsDir
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ 阶段 2  collectOutput()           lib/engine/output.js:91     │
│   读 docs → { pages, json{4}, problems }                       │
│   listMarkdownPages(递归,跳 . /temp)  readJsonIfExists         │
└───────────────────────────────┬──────────────────────────────┘
                                  │ {pages, moduleTree, metadata, updateRecord}
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ 阶段 2  mapFsoftOutput()         lib/engine/mapping.js:115    │
│   docs 树 → 写集描述 { entry, articles, unmapped, meta,        │
│   updateRecord, warnings }  (硬规则：不臆造/不丢弃/不覆盖)      │
└───────────────────────────────┬──────────────────────────────┘
                                  │ buildWritePlan() → {collected, mapped}
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ 阶段 2  validateOutput()         lib/engine/output.js:184    │
│   6 项自洽检查 + 死链检查 → { ok, problems, mapped, stats }    │
└───────────────────────────────┬──────────────────────────────┘
                                  │ { ok, problems } (自洽性)
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ 质量门 quality-gate.js (gateNativeOutput)  lib/engine/quality-gate.js│
│   产物自洽 + 目标格式契约 + 基线可推进性 → report{writable,      │
│   outcome, canAdvanceBaseline, rendered[]}                     │
└───────────────────────────────┬──────────────────────────────┘
                                  │ report (采用裁决)
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ 阶段 3  applyNativeOutput()       lib/engine/apply-plan.js:414 │
│   checkWriteTargets → 写盘 → cw index → 基线(meta update)      │
│   → commitWikiArtifacts → verifyCommitScope                    │
│   失败按三不变量回滚 (写集封闭/索引基线失败回滚/提交失败不回滚)  │
└───────────────────────────────┬──────────────────────────────┘
                                  │ ApplyResult { outcome, applied,
                                  │   written, index, baseline, commit, blockers }
                                  ▼
                     仓库内 .codewiki/ + CodeWiki.md（或回滚）
                     终态判定 done/partial/failed
```

要点：

- `buildWritePlan` 只是把 `collectOutput` 与 `mapFsoftOutput` 串起来的薄壳（`lib/engine/output.js:162-173`）；`validateOutput` 在其上叠加 6 项自洽检查 + 死链检查，`ok` 仅由 `problems.length === 0` 决定（`lib/engine/output.js:184`），不修任何东西也不抛。
- 阶段 2 与质量门之间、`validateOutput` 的 `problems` 类别（`OUTPUT_PROBLEM_KINDS`）与质量门的 `GATE_DEFECT_KINDS` 高度重叠（都含 `entry-missing`/`empty-body`/`article-missing`/`unmapped-page`/`source-missing`/`dead-link`/`bad-json` 等，`lib/engine/quality-gate.js:45-59`），质量门复用 `validateOutput` 而不重写判定（`lib/engine/quality-gate.js:8`）。
- 阶段 3 与质量门之间：落地器只认 `report.writable` 与 `report.canAdvanceBaseline` 等结论，不重复 gate 的判定（`lib/engine/apply-plan.js:466-478`）。
- 阶段 3 全程依赖注入：`defaultRunCw`/`commitWikiArtifacts`/`normalizeIndexLinksIn` 是默认实现，阶段 4（index.js）注入 `runCw` 与 `autoCommitWiki`（`lib/engine/apply-plan.js:24-27, 532-537`）。

## Data Flow

## Connections

## Known Issues