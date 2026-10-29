---
title: engine_output
type: module
source_files:
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/native-run.js
  - test-engine-output.mjs
  - test-engine-output-real.mjs
  - lib/engine/client.js
  - lib/engine/native-state.js
tags: [engine, fsoft, validation, write-plan, mapping]
---

## Overview

模块 `engine_output` 负责把 FSoft 原生引擎产出的 `docs/` 目录解析、映射到 CodeWiki 写集、并校验其自洽性。它是迁移中「阶段 2」的核心，逻辑集中在 `lib/engine/output.js`，但所有的「格式翻译」规则都委托给 `lib/engine/mapping.js`（阶段 0 已冻结）。两者共同构成「引擎产物 → cw 写集」的唯一边界。

文件头注释（`lib/engine/output.js:1-16`）明确规定了本层**只做三件事**，且每件都必须可被测试逐条钉死：

1. **读**（`collectOutput`，`lib/engine/output.js:91-124`）：把 docs 目录读成结构化事实——页清单 + 四个 JSON（`metadata.json` / `module_tree.json` / `first_module_tree.json` / `update_record.json`）。坏文件变成 `problems` 而不是异常。
2. **映射**（委托 `mapFsoftOutput`，`lib/engine/mapping.js:115-268`）：交给 `mapping.js` 的四条硬规则（不臆造 source_files、不静默丢弃、不覆盖、不改技术内容），这里不重复实现任何规则。
3. **校验**（`validateOutput`，`lib/engine/output.js:184-282`）：把「能不能算成功」判成可机读的 `problems` 列表。

明确**绝不在这里做的事**（`lib/engine/output.js:8-12`，这是迁移的安全边界）：

- 不重新聚类、不做图 diff、不改写文章正文——FSoft 已经算完了；
- 不臆造 `source_files`（沿用 `mapping.js` 的证据规则）；
- 不把 problem 降级成 warning：缺页就是缺页，上层据此判 `partial`；把缺失静默吞掉会让 wiki 少一篇而没人知道。

与阶段 3 的分界（`lib/engine/output.js:14-15`）：这里只判「产物自身是否自洽」（页在不在、正文空不空、链接指向的东西在不在计划内）。frontmatter / 锚点 / 写集冲突这类**目标格式**的闸门属于 `quality-gate.js`（阶段 3）。

## Key Components

### `lib/engine/output.js` 公开 API

| 名称 | 行号 | 类型 | 用途 |
|------|------|------|------|
| `OUTPUT_PROBLEM_KINDS` | `lib/engine/output.js:22-34` | `const`（冻结数组） | 校验能报出的问题类别枚举，稳定可机读，上层按 `kind` 分派（不靠 `message` 文本）。 |
| `PROBLEM_SET` | `lib/engine/output.js:36` | `const`（Set） | `OUTPUT_PROBLEM_KINDS` 的集合形态，供 `validateOutput` 拒绝未登记类别。 |
| `TEMP_DIR` | `lib/engine/output.js:43` | `const` | 值为 `'temp'`，docs 下工作目录（依赖图/索引），不算页。 |
| `collectOutput` | `lib/engine/output.js:91-124` | 函数 | 只读地读 docs 目录，产出结构化事实 `{docsDir, exists, pages, json, problems}`，**不抛**，坏输入变 problems。 |
| `bodyLength` | `lib/engine/output.js:127-137` | 函数 | 去掉标题行与空白后剩余的正文字符数，用于判「这页其实只有个标题」。 |
| `relativeLinks` | `lib/engine/output.js:140-152` | 函数 | 收集页面正文里的相对 markdown 链接目标，跳过外链（`http:`/`mailto:`/`data:`）、锚点、图片 data URI。 |
| `buildWritePlan` | `lib/engine/output.js:162-173` | 函数 | 建写集计划：读 docs → 交给 `mapFsoftOutput`，返回 `{collected, mapped}`。 |
| `validateOutput` | `lib/engine/output.js:184-282` | 函数 | 校验产物自洽性，返回 `{ok, problems, mapped, collected, stats}`，**不抛、不修任何东西**。 |
| `emptyStats` | `lib/engine/output.js:284-286` | 函数 | 返回全 0 的 stats 对象（docs 目录不存在时复用）。 |
| 默认导出 | `lib/engine/output.js:288` | 对象 | `{ OUTPUT_PROBLEM_KINDS, collectOutput, buildWritePlan, validateOutput, bodyLength, relativeLinks }`。 |

私有辅助（同文件）：

- `listMarkdownPages(rootDir, rel)`（`lib/engine/output.js:44-62`）：递归收集 docs 下所有 markdown 页（POSIX 相对路径、已排序），跳过隐藏目录与 `temp/`。
- `readJsonIfExists(file, problems, kind, {optional})`（`lib/engine/output.js:64-82`）：读 JSON，可选文件缺失不算问题，存在但坏了永远报 `bad-json`。
- `posix(p)`（`lib/engine/output.js:38`）、`stripBom(s)`（`lib/engine/output.js:39`）：路径/文本归一化小工具。

#### `OUTPUT_PROBLEM_KINDS` 全部类别（`lib/engine/output.js:22-34`）

| kind | 含义 |
|------|------|
| `missing-docs-dir` | 引擎没产出 docs 目录 |
| `missing-metadata` | 缺 `metadata.json`（无法确定 commit/layout） |
| `missing-module-tree` | 缺 `module_tree.json`（无法确定归属与 source_files） |
| `empty-module-tree` | `module_tree.json` 是 `{}`：归属证据缺失，写集算 unattributed |
| `bad-json` | JSON 存在但不可解析 |
| `entry-missing` | 没有 `overview.md`，即没有 `CodeWiki.md` 入口 |
| `empty-body` | 页面除标题外没有正文 |
| `article-missing` | 模块树里有模块，但没有对应页 |
| `unmapped-page` | 页在 docs 里，但映射不到 wiki 的任何位置 |
| `source-missing` | `source_files` 指向的文件在仓库里不存在 |
| `dead-link` | 正文里的相对链接指向计划外的文件 |

`validateOutput` 内部对 `push(kind, …)` 有注册校验：`if (!PROBLEM_SET.has(kind)) throw`（见 `lib/engine/output.js:187-190`），防止自由发挥新的类别。

### `lib/engine/mapping.js` 公开 API

| 名称 | 行号 | 类型 | 用途 |
|------|------|------|------|
| `WIKI_ENTRY` | `lib/engine/mapping.js:30` | `const` | `'CodeWiki.md'`，仓库根入口文件。 |
| `WIKI_DIR` | `lib/engine/mapping.js:31` | `const` | `'.codewiki'` 目录。 |
| `WIKI_META_REL` | `lib/engine/mapping.js:32` | `const` | `'.codewiki/_meta.yaml'`。 |
| `WIKI_UPDATE_RECORD_REL` | `lib/engine/mapping.js:33` | `const` | `'.codewiki/temp/update-record.json'`（update_record 原样搬运）。 |
| `WIKI_MODULES_REL` | `lib/engine/mapping.js:34` | `const` | `'.codewiki/modules'`。 |
| `moduleSlug` | `lib/engine/mapping.js:38-44` | 函数 | 模块名 → kebab-case 文件名（ASCII 保留，其它折叠成 `-`，小写）。 |
| `mapFsoftOutput` | `lib/engine/mapping.js:115-268` | 函数 | 纯函数：把 FSoft 的 docs 树映射成 cw 的写集描述，返回 `{contractVersion, entry, articles, unmapped, meta, updateRecord, warnings}`。 |

私有辅助（同文件）：`normalizeSourceFiles`（`lib/engine/mapping.js:48-58`）、`sourceFilesOf`（`lib/engine/mapping.js:62-72`，只认组件→文件证据）、`indexModuleTree`（`lib/engine/mapping.js:76-96`，把模块树拍平成 `name → node` Map）。

#### `mapFsoftOutput` 返回结构（字段全表，`lib/engine/mapping.js:115-127`）

- `entry`：`{path: 'CodeWiki.md', source} | null` —— 入口页，只允许一个；重复出现则后到的进 `unmapped`。
- `articles`：`[{source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings}]`
  - `type`：固定 `'module'`。
  - `pageKind`：`'leaf' | 'parent' | 'artifact'`（父模块有 children，`artifact` 节点或名为 artifacts/artifact 的模块）。
  - `attribution`：`'attributed' | 'unattributed'` —— whole-repository 模式（空模块树）下为真页但无归属证据时为 `'unattributed'`，`source_files` 留空，并带 warning。
  - `sourceFiles`：来自真实组件→文件证据，**绝不臆造**；拿不到就是空数组 + warning。
- `unmapped`：`[{source, reason}]` —— 任何没被映射的页都带可机读原因。
- `meta`：`{lastCompiledCommit, layout, language}`（取自 `metadata.generation_info`）。
- `updateRecord`：`{path, outcome, pagesWritten, pagesRemoved, source} | null`（原样搬运）。
- `warnings`：全局告警（模块树有模块但没产页等）。
- `contractVersion`：`ENGINE_CONTRACT_VERSION`（`lib/engine/contract.js:20`，当前为 `1`）。

### 被本层消费的契约常量（`lib/engine/contract.js`）

- `ENGINE_CONTRACT_VERSION`（`lib/engine/contract.js:20`）：映射结果里的 `contractVersion`。
- `UPDATE_OUTCOMES` / `CONSUMING_UPDATE_OUTCOMES`（`lib/engine/contract.js:45-53`）：增量结局枚举，本层不判定，但 `quality-gate.js` 与 `native-run.js` 据此决定基线能否推进。
- `BLOCKER_KINDS`（`lib/engine/contract.js:57-72`）：`gateNativeOutput` 与 `applyNativeOutput` 把 problem 翻成统一 blocker 词表时复用。

## Architecture

本模块（阶段 2）位于「引擎跑完 → 写进 wiki 之前」的链路中，由三道闸门构成一条直线。组件 ≥3，框图如下：

```text
 FSoft 引擎产出 docs/ 目录 (overview.md + *.md + 4 个 JSON)
        │
        ▼
┌────────────────────────┐
│ collectOutput          │ lib/engine/output.js:91
├────────────────────────┤
│ mapFsoftOutput         │ lib/engine/mapping.js:115
├────────────────────────┤
│ validateOutput         │ lib/engine/output.js:184
└───────────┬────────────┘
            │ 阶段2：产物自身自洽 → {ok, problems, mapped}
            ▼
┌────────────────────────┐
│ gateNativeOutput       │ quality-gate.js:390
├────────────────────────┤
│ applyNativeOutput      │ apply-plan.js:495
└────────────────────────┘
```

关键设计取舍（来自 `lib/engine/output.js:8-15` 与 `lib/engine/mapping.js:16-26`）：

- **映射规则只在一处**：`mapping.js` 是唯一「格式翻译」点；`output.js` 不重复实现任何规则，只负责读与校验。这让迁移的安全边界可被完整读一遍。
- **坏输入变 problems，不抛**：`collectOutput` / `validateOutput` / `buildWritePlan` 全部「不抛」。这保证上层（阶段 3 质量门、阶段 4 编排）能拿到完整判据，而不是被异常中断。
- **阶段 2 只判产物自洽，阶段 3 判目标格式与基线**：`dead-link` 在 `output.js` 只查「docs 内相对路径」，且跳过 `../` 开头（仓库源文件）交给阶段 3 的 source 校验（`lib/engine/output.js:257-258`）。

## Data Flow

一次校验的完整数据流（以 `validateOutput` 为主线，`lib/engine/output.js:184-282`）：

1. **入口**：`validateOutput({docsDir, repoRoot, componentFiles, overviewName})` 先调 `buildWritePlan`，后者调 `collectOutput`（`lib/engine/output.js:163`）拿到 `collected`，再调 `mapFsoftOutput`（`lib/engine/output.js:164-171`）拿到 `mapped`，返回 `{collected, mapped}`。
2. **problems 初始化**：`problems = [...collected.problems]`（`lib/engine/output.js:186`），即读阶段已发现的 `missing-docs-dir` / `missing-metadata` / `bad-json` 等。
3. **docs 不存在短路**：若 `!collected.exists` 直接返回 `{ok:false, problems, mapped, collected, stats: emptyStats()}`（`lib/engine/output.js:192-194`），不再做后续校验。
4. **入口校验**：`mapped.entry` 为空则 `push('entry-missing', …)`（`lib/engine/output.js:197`）。
5. **空模块树**：`module_tree.json` 是空对象且页数 >1 时 `push('empty-module-tree', …)`（`lib/engine/output.js:202-207`）—— whole-repository 模式的正常产物，但归属证据缺失，必须让上层看见。
6. **逐页读正文**：对 `collected.pages` 读文件、用 `bodyLength` 判空壳，空则 `push('empty-body', …, {source})`（`lib/engine/output.js:214-225`）。
7. **未映射页**：`mapped.unmapped` 每条 `push('unmapped-page', u.reason, {source})`（`lib/engine/output.js:228`）。
8. **缺页升级**：`mapped.warnings` 中带「未产出」字样的 `push('article-missing', w)`（`lib/engine/output.js:231-233`）—— mapping 已在 warnings 报事实，这里升级成 problem。
9. **source_files 存在性**：`repoRoot` 给出时，逐个 `a.sourceFiles` 检查 `fs.existsSync`，不存在则 `push('source-missing', …, {source, target})`（`lib/engine/output.js:236-248`）；不给 `repoRoot` 则跳过该项（阶段 2 可选）。
10. **死链**：对每页 `relativeLinks` 抽出的相对链接做路径归一化，跳过 `../` 与计划内/存在于 docs 的目标，剩下指向 `.md` 且不在计划内的 `push('dead-link', …, {source, target})`（`lib/engine/output.js:252-265`）。
11. **终态合成**：返回 `{ok: problems.length === 0, problems, mapped, collected, stats}`（`lib/engine/output.js:267-281`）。`collected` 原样带出，因为阶段 3 要读 `metadata.generation_info.commit_id` 判产物对应哪个 commit（`lib/engine/output.js:271-274`）。

`collectOutput` 自身的读取细节（`lib/engine/output.js:91-124`）：

- 页用 `listMarkdownPages` 递归收集，跳过隐藏目录与 `temp/`（`lib/engine/output.js:44-62`、`113-116`）。
- 四个 JSON 中 `metadata.json` / `module_tree.json` 为必需（缺失报 `missing-*`），`first_module_tree.json` / `update_record.json` 为可选（缺失不报，坏了报 `bad-json`）（`lib/engine/output.js:118-122`）。

`mapFsoftOutput` 的映射决策（`lib/engine/mapping.js:115-222`）：

- overview 页 → `entry`（只一个，重复则后到的进 `unmapped`）。
- 模块树为空（`tree.size === 0`，whole-repository 模式）但有页：页进 `articles`、source_files 留空、`attribution: 'unattributed'` + warning（`lib/engine/mapping.js:153-188`）。
- 模块树非空但页名不在树里 → `unmapped`（`lib/engine/mapping.js:189-192`）。
- slug 冲突（A_B 与 A-B 都 → `a-b`）→ 两页都进 `unmapped`、不覆盖（`lib/engine/mapping.js:200-211`）。
- 模块树有但没产页 → `warnings`（`lib/engine/mapping.js:235-242`），由上一步 8 升级成 problem。

## Connections

- [[engine_mapping]] —— `lib/engine/mapping.js` 是阶段 0 冻结的「格式翻译」唯一实现点；本模块的 `buildWritePlan` / `validateOutput` 全部委托 `mapFsoftOutput`，二者共同构成「引擎产物 → cw 写集」的边界。本文模块即该子能力的「读 + 校验」外壳。
- [[engine_contract]] —— `contract.js` 提供 `ENGINE_CONTRACT_VERSION`（映射结果版本号）、`UPDATE_OUTCOMES`、`BLOCKER_KINDS`。阶段 2 不判定增量结局，但阶段 3/4 据其决定基线推进。
- [[engine_quality_gate]] —— `quality-gate.js` 的 `gateNativeOutput`（`lib/engine/quality-gate.js:390`）**复用** `validateOutput`（`lib/engine/quality-gate.js:400`），把本层的 problems 分流成 `defect` / `degradation` / `stale` 三类（阶段 3 采用门）。注意 `empty-module-tree` 在 `output.js` 是 problem，在 gate 里被降级为 degradation（`lib/engine/quality-gate.js:418-422`）。
- [[engine_apply_plan]] —— `apply-plan.js` 的 `applyNativeOutput`（`lib/engine/apply-plan.js:495`）消费 `gateNativeOutput` 的 `GateReport`，把写集真正落地（写盘 → cw index → 基线 → 自动提交）。它只认 gate 的结论，不再重复本层判定。
- [[engine_native_run]] —— 阶段 4 编排 `native-run.js` 在一次完整编译里串起 `gateImpl`（= `gateNativeOutput`）与 `applyImpl`（=`applyNativeOutput`）（`lib/engine/native-run.js:503-535`、`606-625`）。硬不变量「引擎 done 不能替代质量门、落地器说 partial/failed 终态不许 done」正是为了防止老缺陷（1 篇成功 + 19 篇失败也报 done）复发。
- [[engine_client]] —— `client.js` 是 Node↔Python 薄适配层，负责起子进程拿回产物目录（`result.artifacts.docsDir`），即本模块 `validateOutput` 的 `docsDir` 来源（`lib/engine/client.js:46` 注释明言「产物落盘与映射在 output.js / mapping.js」）。
- [[engine_native_state]] —— `native-state.js` 的跨轮受管状态决定增量能否成立；其 `captureDocsDir` 采集的就是本模块读取的同一批 `docs/` 产物（module_tree / metadata / 文章），并与文章同事务提交。

## Known Issues

- **死链判据只查 docs 内相对路径**：`validateOutput` 的死链检测（`lib/engine/output.js:184-185`）显式跳过 `../` 开头的链接（指向仓库源文件），把它们交给阶段 3 的 source 校验。这意味着指向仓库源码的坏链接在阶段 2 **不会**被 `dead-link` 捕获，只有写到 `.codewiki/` 后由 `quality-gate.js` / `article-contract.js` 兜底。
- **`source_files` 存在性检查是可选的**：只有 `validateOutput` 收到 `repoRoot` 时才做 `source-missing` 判定（`lib/engine/output.js:236-248`）。单元测试 `validateOutput：不给 repoRoot 时跳过 source_files 存在性检查`（`test-engine-output.mjs:180-189`）明确验证此行为——调用方若忘记传 `repoRoot`，编造/错写的 source_files 会被放行。
- **`bad-json` 被复用为「文件不可读」的兜底**：`validateOutput` 在读页正文失败时 `push('bad-json', …)`（`lib/engine/output.js:220`），而非独立的 `unreadable` 类别。这会让「页存在但读不了」与「JSON 坏掉」在 `kind` 上混为一谈，上游按 `kind` 分派时需注意。
- **阶段 2 不判目标格式契约**：frontmatter 闭合、围栏、锚点、章节结构等由 `quality-gate.js` 的 `article-contract` 路径负责（`lib/engine/quality-gate.js:9-11`、`346-373`）。阶段 2 的 `bodyLength` 仅判「除标题外是否有正文」，不拦截 frontmatter 损坏的页——那类页会过阶段 2 但被阶段 3 拦下。
- **`empty-module-tree` 的语义是「降级而非致命」**：whole-repository 模式下 `module_tree.json` 恒为 `{}` 是引擎的正常行为（`lib/engine/output.js:199-207` 注释引用 `documentation_generator.py:241`）。阶段 2 把它报成 problem 使 `ok=false`，但阶段 3 把它重分类为 degradation（页照写、基线不推进）。若上层只看 `validateOutput.ok` 而不看 gate，会把正常产物误判为不可入库。
- **`collected` 原样回带是有意设计**：`validateOutput` 把 `collected` 一并返回（`lib/engine/output.js:274`），避免阶段 3 再读一次 docs 目录导致两次读之间目录漂移（`lib/engine/output.js:184-186`）。任何派生逻辑都应复用同一份 `collected`，不要重新 `collectOutput`。
- **无测试覆盖 `first_module_tree.json` 内容语义**：该文件仅作为可选文件被读出（`lib/engine/output.js:121`），当前实现没有消费其内容的逻辑，也无断言其结构；它只是被原样读取以防「存在但坏了」被吞。
