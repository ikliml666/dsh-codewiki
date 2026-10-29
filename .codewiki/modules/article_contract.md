---
title: article_contract
type: module
source_files:
  - lib/article-contract.js
  - test-article-contract.mjs
  - lib/articles-agentic.js
  - index.js
  - test-engine-contract.mjs
tags: [contract, gate, article, validation, write-set]
---

## Overview

`lib/article-contract.js` 是 wiki 文章的**结构契约闸门**：它把"一篇合格的 wiki 文章必须满足的最低结构"集中在一处判断，给所有写盘点（单轮通道 `index.js` 的 `applyTaskResult`、agentic 通道 `lib/articles-agentic.js` 的 `runOneArticle`、存量体检 `auditExistingArticles`）复用同一个判据，避免各查一段。

模块是**纯函数**（不碰文件系统、不引 YAML 依赖），因此可以单测（见 `test-article-contract.mjs`）。真正的落盘动作在调用方，本模块只负责判定。

**背景缺陷（审计确认，见文件头注释 lib/article-contract.js:1-12）：** 旧闸门 `validateArticleEnvelope`（`index.js` 早期版本，约 index.js:1162）只查"frontmatter 有没有开头、有没有闭合"，于是下面这些都进了仓库：

- `concepts/wiki-generation-flow.md` 从第 64 行起又贴了一份 frontmatter 与整段正文；
- 必需章节存在但正文是空的（只有标题）；
- `source_files` 列着不存在的文件、或列了目录；
- 正文里的 `[[链接]]` 指向早已删掉的文章；
- 代码围栏没闭合，后面整篇都被当成代码块。

本模块按"文章类型 → 必需章节"配置判据（`REQUIRED_SECTIONS`），避免对 `learning`/`pattern` 类文章过度要求；并按 `SEVERITY` 把缺陷分成 **error（结构已破坏，落盘即污染 wiki，必须拒写）** 与 **warning（内容不达标但结构完整，放行但降 partial）** 两级。

模块对外暴露两类能力：

1. **文章解析与校验**：`parseFrontmatter` / `parseYamlLite` / `extractSections` / `fencesBalanced` / `collectWikiLinks` / `hasDuplicateFrontmatter` 做原子解析，`inspectArticle` 是主入口，串起全部判据返回 `issues[]`；`issueSummary` / `hasBlockingIssue` 把结果压成可读文案与"是否拒写"布尔。
2. **写集闸门**：`makeWriteSet` / `normalizeWritePath` / `isWritable` 控制 agentic 通道里"模型能写哪些文件"。

`inspectArticle` 的关键设计——判据按**严重度**分成 error 与 warning 两级，是闸门行为的分界（`lib/article-contract.js:213-238`）：error 级（结构破坏）一律拒写；warning 级（缺非必需章节、非必需章节空着）放行，但由调用方的终态判定把本次编译降为 `partial`、阻止基线前移——"装绿"不允许。

## Key Components

本模块全部导出（均位于 `lib/article-contract.js`）：

**常量（配置判据）**

- `ARTICLE_CONTRACT_VERSION`（`lib/article-contract.js:16`）：契约版本号，当前固定 `1`。
- `TYPE_BY_DIR`（`lib/article-contract.js:19-26`）：目录名 → 允许的 `type`，如 `modules`→`module`、`concepts`→`concept`、`learnings`→`learning`、`decisions`→`decision`、`patterns`→`pattern`、`queries`→`query`。`articlePath` 落在这些目录下时，`type` 必须与之匹配，否则 cw index 分类会错乱。
- `ROOT_TYPES`（`lib/article-contract.js:28-32`）：根目录特殊文章，`_architecture.md`→`architecture`、`_index.md`→`index`、`_patterns.md`→`pattern`。
- `REQUIRED_SECTIONS`（`lib/article-contract.js:36-45`）：各 `type` 的必需章节表。所有类型都要 `Overview`；`module`/`architecture` 还要 `Key Components`；`index` 为空数组（不查章节）。判据只列真正不能空的章节。
- `REQUIRED_FIELDS`（`lib/article-contract.js:46`）：必填 frontmatter 字段 `['title', 'type', 'source_files']`。注意 `tags` 是必填字段但允许空列表（单独在 `inspectArticle` 里处理，见下）。
- `SEVERITY`（`lib/article-contract.js:56-73`）：缺陷 `kind` → 严重度映射。error 级：`empty`、`frontmatter-missing`、`frontmatter-unclosed`、`missing-field`、`type-mismatch`、`bad-source`、`missing-source`、`source-not-evidence`、`empty-body`、`duplicate-frontmatter`、`duplicate-section`、`unclosed-fence`、`dead-link`、`empty-section`；warning 级：`missing-section`、`empty-section-optional`。分级是**闸门行为**分界——error 拒写、warning 放行降 partial。

**解析与校验函数**

- `parseFrontmatter(content)`（`lib/article-contract.js:77-90`）：只认文首第一个 `---` 块。返回 `{ fields, body, endLine, closed, raw }`；无 frontmatter 或没闭合时 `fields=null`、`closed=false`。会先剥离 UTF-8 BOM（`\uFEFF`，line 79）。
- `parseYamlLite(raw)`（`lib/article-contract.js:94-118`）：极简 YAML 解析，只支持本仓库用到的 `key: value` 与 `key:` 后跟 `- item` 列表，不引依赖。注释行（`#` 开头）与空行跳过（line 98）；行内列表 `[a, b]` 也支持（line 111）。内部调用 `unquote`。
- `unquote(s)`（`lib/article-contract.js:120-135`）：私有辅助。双引号标量优先 `JSON.parse`（YAML 1.2 是 JSON 超集，能正确还原转义与双反斜杠，line 127-128）；JSON 解析失败回退切片引号；单引号标量把 `''` 还原为 `'`（line 131-132）。
- `extractSections(body)`（`lib/article-contract.js:138-158`）：扫描正文里的 `## 标题` 章节，返回 `[{ title, content, line }]`。`line` 为 1-based 起始行。关键：处于代码围栏（` ``` ` 或 `~~~`）内的 `##` 不算章节（line 145-146），避免把代码里的 `## 注释` 误当标题。
- `fencesBalanced(body)`（`lib/article-contract.js:161-164`）：统计围栏标记数，返回 `{ balanced: count%2===0, count }`。
- `collectWikiLinks(body)`（`lib/article-contract.js:167-176`）：收集内部链接目标。`[[name|label]]` 与 `[[name#anchor]]` 取 `name`（`|`/`#` 后忽略，line 170）；markdown 相对链接 `[x](rel.md)` 取 `rel.md`，但带协议头（`a-z:` 如 `https:`）的外链**不**收（line 173）。返回去重后的数组。
- `hasDuplicateFrontmatter(body)`（`lib/article-contract.js:179-193`）：检测正文里是否又出现一份 frontmatter——从某行 `---` 起、40 行内出现第二个 `---` 且中间含 `title:`/`type:`/`source_files:` 字段即判重复（line 184-188）。
- `isRepoRelativeFile(p)`（`lib/article-contract.js:195-203`）：私有辅助。判断一个 `source_files` 条目是否是合法的仓库相对文件路径——拒绝绝对路径（`/`、`C:`）、`../` 越界、以 `/` 结尾的目录形态；要求 `path.posix.basename` 含 `.`（有扩展名，line 202），纯目录名或非文件路径不合法。
- `inspectArticle(content, opts)`（`lib/article-contract.js:213-335`）：**主入口**，返回 `issues[]`（空数组=通过）。详见下方"判定流程"。`opts` 字段：`cwd`、`articlePath`、`expectedType`、`readableSources`、`allowedLinks`、`fsImpl`、`requiredSections`、`allowEmptySourceFiles`（各自语义见 Architecture/Data Flow）。
- `issueSummary(issues)`（`lib/article-contract.js:338-343`）：把 issues 压成一行人类可读文案（`"文章契约未通过：<首条.detail>（共 N 项）"`），空数组返回 `null`。
- `hasBlockingIssue(issues)`（`lib/article-contract.js:346-348`）：只要存在任一 `severity==='error'` 的 issue 即返回 `true`（默认按 error 处理）。error 级拦落盘，warning 级放行。

**写集闸门函数（agentic 通道用）**

- `makeWriteSet(paths)`（`lib/article-contract.js:352-355`）：把路径数组编译成 `Set`（每项经 `normalizeWritePath`）。非数组返回 `null`（调用方"没设限"）。
- `normalizeWritePath(p)`（`lib/article-contract.js:357-361`）：反斜杠归一为 `/`，`path.posix.normalize` 后返回；空串返回 `null`。
- `isWritable(target, writeSet, { cwd })`（`lib/article-contract.js:365-378`）：判定 `target` 是否在 `writeSet` 内。`writeSet` 为 `null` 直接放行（line 366）；否则按规范化 POSIX 路径比对；当传入 `cwd` 时，把相对路径以 cwd 为基准 `path.resolve` 后比对，避免 `../` 越界写到别的仓库（line 370-376）。

## Architecture

`article_contract` 是纯函数层，被两条写盘点（单轮通道、agentic 通道）和存量体检复用。组件关系如下：

```text
              文章全文 content
                   │
                   ▼
        ┌──────────────────────┐
        │   inspectArticle()   │  lib/article-contract.js:213  (主入口)
        │   opts: cwd/article  │
        │   Path/expectedType/ │
        │   readableSources/   │
        │   allowedLinks/      │
        │   fsImpl/            │
        │   requiredSections/  │
        │   allowEmptySrcFiles │
        └──────────┬───────────┘
                   │ 拆出若干判据，各自调原子解析器
   ┌───────────────┼───────────────────────────────────────┐
   ▼               ▼               ▼                        ▼
parseFrontmatter  extractSections  fencesBalanced    collectWikiLinks
:77              :138              :161               :167 ─► hasDuplicateFrontmatter:179
   │               │                                                  │
   └─parseYamlLite:94─►unquote:120                                   │
        │               │                  isRepoRelativeFile:195    │
        ▼               ▼                       (source_files 校验)   │
   REQUIRED_FIELDS   REQUIRED_SECTIONS                          allowedLinks
   :46              :36 (按 type 配必需章节)                     比对 (inspectArticle:323)
        │               │
        ▼               ▼
   ┌──────────────────────────────────────────┐
   │  push(kind, detail) → SEVERITY:56 定级    │
   │  issues[]  (空=通过)                      │
   └───────────────────┬──────────────────────┘
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
   issueSummary():338      hasBlockingIssue():346
   (一行文案/null)         (error 级? 拒写:放行)
                       │
        ┌──────────────┴───────────────┐
        ▼                               ▼
  index.js:applyTaskResult          lib/articles-agentic.js
  contractCheck():600 落盘闸门      runOneArticle():33 写集闸门
        │                               │
        ▼                               ▼
  auditExistingArticles:1871        makeWriteSet:352 / isWritable:365
  (存量体检)                         (allowedWritePaths 越界拒写)
```

**判定分两级（`inspectArticle` 内部，lib/article-contract.js:213-313）：**

- **结构判据（返回 error 级）**：空文 `empty`、缺/未闭合 frontmatter、缺必填字段 `missing-field`、`type` 与目录不符 `type-mismatch`、`source_files` 非法 `bad-source`/不存在 `missing-source`/不是本次证据 `source-not-evidence`、正文空 `empty-body`、重复 frontmatter `duplicate-frontmatter`、重复章节 `duplicate-section`、围栏未闭合 `unclosed-fence`、死链 `dead-link`、必需章节空着 `empty-section`。
- **内容判据（返回 warning 级，放行但降 partial）**：缺必需章节 `missing-section`、非必需章节空着 `empty-section-optional`。

`SEVERITY`（lib/article-contract.js:56-73）是这两级的分界——`push(kind, detail)` 时按 `SEVERITY[kind]` 定级，缺省按 `error`（line 234）。`hasBlockingIssue` 只看是否存在 `error` 级；warning 不拦落盘，但由调用方终态判定降 `partial`、阻止基线前移（"装绿"不允许，见 lib/article-contract.js:48-53）。

**`inspectArticle` 的关键可选覆盖（`lib/article-contract.js:213-227`）：**

- `requiredSections`：原生引擎（FSoft）通道的正文章节名是上游 prompt 决定的（`## Introduction and Purpose` / `## 1. Purpose`），不是本仓库 agentic 通道的 `## Overview`/`## Key Components`。用默认表去判等于给"被禁止手改"的正文判死刑，每条都是不可修复的 warning → 真实产物永远 partial。传 `[]` 表示只查"结构完整"不查章节名（原生通道自己另判非空章节数）。默认仍是 `REQUIRED_SECTIONS`，既有通道行为一字不变。
- `allowEmptySourceFiles`：默认 `false`（0.14.0 语义——文章无代码依据必须拒）。唯一例外是 FSoft whole-repository 模式（`module_tree.json` 为 `{}`，无归属证据可查），空 `source_files` 是"诚实记录"而非编造，调用方显式开启后由上层判 partial 而非在此拒写。

## Data Flow

**入口 `inspectArticle(content, opts)` 的逐步流程（`lib/article-contract.js:213-335`）：**

1. **空文速断**（line 236-239）：`text.trim()` 为空直接 `push('empty', …)` 并 `return`。早于任何 frontmatter 解析，避免后续误判。
2. **解析 frontmatter**（line 241-246）：`parseFrontmatter(text)`。无 `fields` 时，按首字符是否为 `---` 区分 `frontmatter-unclosed`（只开不闭）与 `frontmatter-missing`，然后 `return`（frontmatter 都没有则后续无从判）。
3. **必填字段**（line 249-262）：遍历 `REQUIRED_FIELDS`（`title`/`type`/`source_files`）。空值判定含 undefined/null/空数组/空串（line 253）。`allowEmptySourceFiles` 只对 `source_files` 这一项放行空列表（line 252），其余必填照拒。`tags` 特殊处理（line 260-262）：要求**字段存在**（没有就 `missing-field`），但允许空列表 `[]`——与 `source_files` 不同，空 `tags` 是合法形态。
4. **type 与目录匹配**（line 264-273）：由 `articlePath` 经 `ROOT_TYPES`/`TYPE_BY_DIR` 推断 `dirType`（line 265-266），`wantType = expectedType ?? dirType`（line 268）；`gotType` 取 `fm.fields.type`。两者不等（或超过集合但 `wantType` 有值而 `gotType` 缺失）则 `type-mismatch`。`expectedType` 由调用方覆盖目录推断（如 `_index.md` 这类 cw 自产索引用 `expectedType` 放宽，test-article-contract.mjs:196-201）。
5. **source_files 校验**（line 275-292）：
   - 格式：`isRepoRelativeFile(s)` 拒绝对绝对路径/目录/`../` 越界 → `bad-source`（line 280）。
   - 证据来源：若传了 `readableSources` 数组，则 `source_files` 必须是它的子集，否则 `source-not-evidence`（line 282-288）。`readableSources` 用 `\\`→`/` 归一后比对（line 283）。
   - 存在性：若传了 `fsImpl.exists` 且 `cwd`，则 `source_files` 指向的文件必须存在 → 否则 `missing-source`（line 289-292）。路径按 `path.posix.join(cwd, s)` 探测。
6. **正文判据**（line 294-299）：`fm.body` 为空 → `empty-body`；`hasDuplicateFrontmatter(body)` 命中 → `duplicate-frontmatter`；`fencesBalanced(body).balanced` 为 false → `unclosed-fence`。
7. **章节判据**（line 301-320）：`extractSections(body)` 出章节列表；重复标题 → `duplicate-section`（line 309）。对照 `required`（= `requiredSections ?? REQUIRED_SECTIONS[wantType] ?? []`，line 310）：缺失 → `missing-section`（warning）；存在但空 → `empty-section`（error）。任何"出现且为空、又非必需"的章节 → `empty-section-optional`（warning，line 316-320）。
8. **内部链接**（line 322-332）：仅当传了 `allowedLinks` 数组时才查。对每个 `collectWikiLinks` 目标，候选含 `t`、`` `${t}.md` ``、`baseDir/t`、`baseDir/${t}.md`（`baseDir` 取 `articlePath` 目录，line 325-328）；全部候选都不在 `allowed` 集 → `dead-link`。`allowed` 同样 `\\`→`/` 归一（line 324）。
9. **返回**（line 334）：`issues` 数组，空即通过。

**写集闸门流程（agentic 通道，`lib/article-contract.js:352-378`）：**

- `makeWriteSet(allowedWritePaths)` 把路径数组编译成规范化 `Set`；`allowedWritePaths === undefined` 时 `runOneArticle` 不调用、保持旧行为不设限（`lib/articles-agentic.js:33`）。
- 落盘前 `isWritable(task.articlePath, writeSet, { cwd })` 判定（lib/articles-agentic.js:155-167）：越界（含 `../` 逃逸、`/abs` 绝对路径、别的模块名）一律 `ok:false, stopReason:'write-set'`，不静默写也不静默丢，把 `writeSetViolation` 交给调用方记账（line 293-294）。子模块只拿到"自己那一条路径"的写集（lib/articles-agentic.js:112），父文章路径不在子写集内，越界写父文会被拒。

**典型数据流（单轮通道落盘，`index.js:600-666`）：**

```
模型输出 content
  └► contractCheck(content, {articlePath, cwd, sources, allowedLinks})   index.js:600
        └► inspectArticle(...) → issues[]
        └► 拆 blocking = severity==='error'，warnings = 其余
  └► blocking.length>0 ? 不落盘 + notes 记账 (stopReason:'contract')
  └► else fixAnchors(...) → fs.writeFileSync(articlePath) + 记 contractIssues
```

`contractCheck`（`index.js:590-603`）是 `inspectArticle` 在插件层的薄包装：补 `wikiRelOf(articlePath)`（把绝对路径裁成 `modules/x.md` 形态，index.js:586-593）、`fsImpl.exists` 用 `fs.existsSync`、把结果拆成 `{ issues, blocking, warnings }`。`allowedLinkTargets`（`index.js:607-629`）扫描 wiki 目录 + 本轮计划产出文章，构造 `allowedLinks` 集合（含相对路径、裸名、`modules/裸名` 三种形态）。

## Connections

本模块是 wiki 文章质量门的"判据基座"，被以下模块消费：

- **`[[index]]`**（`index.js`）：单轮通道落盘的统一定点 `contractCheck`（`index.js:590-603`）就建在 `inspectArticle` 上；`applyTaskResult`（`index.js:633-656`）在 `fixAnchors` 前先过契约闸门，error 级直接不落盘。`auditExistingArticles`（`index.js:1749-1760`）对存量 `.codewiki/` 文章做体检，只列 error 级当 quality 阻塞（终态降 partial）。`wikiRelOf`（`index.js:586-593`）把绝对路径裁成 `modules/x.md` 形态供 `articlePath` 推断类型。`allowedLinkTargets`（`index.js:617-639`）构造 `allowedLinks` 集合。旧闸门 `validateArticleEnvelope`（`index.js` 早期版本）已被本模块取代（见文件头 lib/article-contract.js:3-9）。
- **`[[articles-agentic]]`**（`lib/articles-agentic.js`）：agentic 通道用 `makeWriteSet`/`isWritable`（`lib/articles-agentic.js:17, 67, 112, 155-167`）实现写集闸门——父任务只准写自己那篇、子模块只准写调度器分配的路径，越界 `stopReason:'write-set'`。`runOneArticle` 的 `allowedWritePaths` 透传链见 lib/articles-agentic.js:48-55 / 67 / 112。
- **`[[update-record]]`**（`lib/update-record.js`）：`judgeOutcome`/`describeOutcome` 消费 `contractCheck` 返回的 `blocking`/`warnings`，把 warning 级（缺章节）当 quality 阻塞，把本次编译终态降为 `partial`、阻止基线前移（lib/article-contract.js:48-53 的"装绿不允许"策略）。
- **`[[engine-contract]]`**（`lib/engine/contract.js`）：原生引擎（FSoft）通道的产物到 wiki 映射（`mapFsoftOutput`）不调用本模块；但本模块 `inspectArticle` 的 `requiredSections`/`allowEmptySourceFiles` 两个覆盖项（`lib/article-contract.js:217-231`）正是为原生通道"被禁止手改的正文"与 whole-repository 空证据场景量身设计，二者通过 `index.js` 的通道分发协同。
- **`[[agentic]]`**（`lib/agentic.js`）：agentic 工具循环里模型写文章，落盘时经 `articles-agentic.js` 的写集闸门；本模块的 `isWritable` 是越界防护的底层判定。
- **测试**：`test-article-contract.mjs`（本模块单测，覆盖全部 `kind` 与写集用例）、`test-engine-contract.mjs`（原生引擎契约，与本模块分工不同）、`test-change-set.mjs` / `test-wiki-anchors.mjs`（相邻质量门）。

## Known Issues

- **旧闸门残留语义**：`index.js` 文件头注释（lib/article-contract.js:3-9）提到旧闸门 `validateArticleEnvelope`（`index.js` 早期版本，约 index.js:1162）只查 frontmatter 开合，导致重复 frontmatter、空必需章节、`source_files` 指向已删文件、死链、未闭合围栏等坏文章入库。本模块是取代者，但 `index.js` 的 `index.js:1005` 注释仍指向旧实现，属于历史引用而非当前代码路径（当前落盘全走 `contractCheck` / `runOneArticle` 写集闸门）。
- **`isRepoRelativeFile` 不识别无扩展名的数据文件**：`source_files` 条目要求 `path.posix.basename(s).includes('.')`（`lib/article-contract.js:202`），即必须含扩展名。仓库里若确有"无扩展名但真实存在"的证据文件（如 `Makefile`、`Dockerfile` 无扩展名），会被判 `bad-source` 拒写——`Dockerfile` 在原生映射里靠 `componentFiles` 兜底（`test-engine-contract.mjs:273-290`），单轮/agentic 通道若直接列 `Dockerfile` 则会踩中此限制。
- **`extractSections` 只认识 `##` 二级标题**：正文里的 `###` 子标题被并入父 `##` 的 content，不单独成节点（`lib/article-contract.js:138`）。必需章节判据只配 `## Overview` / `## Key Components`，因此文章若用 `### Key Components` 会被判 `missing-section`（warning，放行）。
- **`unquote` 双引号回退切片**：当双引号标量含 YAML 专有转义（如 `\e`，JSON 不认）时，`JSON.parse` 失败回退到"切引号"（`lib/article-contract.js:127-129`），此时值保持原样含反斜杠——存量文章的 YAML 专有转义不会被还原，但也不判坏，符合"不能因旧格式误杀"的意图。
- **`hasDuplicateFrontmatter` 只看 40 行窗口**：正文里第二份 frontmatter 距第一个 `---` 超过 40 行则漏报（`lib/article-contract.js:179`），但配合 `duplicate-section` + `duplicate-frontmatter` 双重检测，绝大多数重复贴头场景仍能被 `unclosed-fence`/`empty-section` 等相邻判据兜住。
- **写集闸门依赖调用方显式传 `allowedWritePaths`**：`runOneArticle` 在 `allowedWritePaths === undefined` 时**不设限**（`lib/articles-agentic.js:33`）；只有显式传数组/空数组才启用闸门。测试与既有调用方若漏传，模型可越界写任意文件——这是有意的旧行为保留，非缺陷。
- **`missing-source` 仅在 `cwd` + `fsImpl.exists` 都传时生效**：纯内存场景（未传 `cwd`/`fsImpl`）下无法判存在性，`test-article-contract.mjs:110-119` 通过传 `cwd` + `fsImpl:{ exists: fs.existsSync }` 触发；单轮通道 `contractCheck` 默认带了 `fsImpl`（index.js:596），agentic 通道不调 `inspectArticle`（只调写集闸门），二者分工需留意。
