---
title: article_contract
type: module
source_files:
  - lib/article-contract.js
  - test-article-contract.mjs
  - index.js
  - agentic.js
tags: [article, contract, validation, frontmatter, gate]
---

## Overview

`lib/article-contract.js` 是 CodeWiki 的「文章契约闸门」：定义一篇 wiki 文章要落盘前必须满足的最低结构，并集中在这里判定。它是一个**纯函数模块**（不碰文件系统，只在调用方传入 `fsImpl` 时由调用方提供 `exists` 能力，见 `inspectArticle` 的 `fsImpl` 参数，第 213–232 行），因此可以被单测（`test-article-contract.mjs`）。真正的「落盘闸门」由 `index.js` 在写入前调用本模块完成拦截。

设计动机（第 1–11 行注释）：旧闸门 `validateArticleEnvelope`（index.js:1170 一带）只检查「frontmatter 有没有开头、有没有闭合」，于是下列真实缺陷都能入库：

- `concepts/wiki-generation-flow.md` 从第 64 行起又贴了一份 frontmatter 与整段正文；
- 必需章节存在但正文是空的（只有标题）；
- `source_files` 列着不存在的文件、或列了目录；
- 正文里的 `[[链接]]` 指向早已删掉的文章；
- 代码围栏没闭合，后面整篇都被当成代码块。

本模块把判据按「文章类型 → 必需章节」配置（第 36–45 行 `REQUIRED_SECTIONS`），避免对 `learning`/`pattern` 类文章过度要求。核心入口是 `inspectArticle(content, opts)`（第 213 行），返回 `issues[]`（空数组 = 通过）。每条 issue 带 `severity` 字段，区分 `error`（结构已破坏，必须拒写）与 `warning`（内容不达标但结构完整，放行但让本次编译终态降为 `partial`，阻止基线前移）。

## Key Components

全部公开导出项均来自 `lib/article-contract.js`。下面按「常量 → 解析函数 → 主校验函数 → 便捷/闸门函数」分组列出作用与行号。

### 常量

- `ARTICLE_CONTRACT_VERSION = 1`（第 16 行）：文章契约版本，纯标记，目前仅 1。
- `TYPE_BY_DIR`（第 19–26 行）：目录名 → 允许的 `type`。映射：`modules→module`、`concepts→concept`、`learnings→learning`、`decisions→decision`、`patterns→pattern`、`queries→query`。注释强调「type 与目录不匹配时 `cw index` 的分类会错乱」。
- `ROOT_TYPES`（第 28–32 行）：根目录下的特殊文章名 → type。映射：`_architecture.md→architecture`、`_index.md→index`、`_patterns.md→pattern`。
- `REQUIRED_SECTIONS`（第 36–45 行）：各类型的必需章节（必须存在且非空）。`module`/`architecture` 要求 `["Overview","Key Components"]`，其余 `concept`/`learning`/`decision`/`pattern`/`query` 只要求 `["Overview"]`，`index` 为 `[]`。
- `REQUIRED_FIELDS = ['title','type','source_files']`（第 46 行）：frontmatter 必填字段。
- `SEVERITY`（第 56–73 行）：14 种 issue 的 `kind` → 严重级别映射。这是**闸门行为**的分界：`empty`、`frontmatter-missing`、`frontmatter-unclosed`、`missing-field`、`type-mismatch`、`bad-source`、`missing-source`、`source-not-evidence`、`empty-body`、`duplicate-frontmatter`、`duplicate-section`、`unclosed-fence`、`dead-link`、`empty-section` 全部为 `error`（拒写）；`missing-section` 与 `empty-section-optional` 为 `warning`（放行但降 `partial`）。

### 解析函数

- `parseFrontmatter(content)`（第 77–90 行）：只认文首第一个 `---` 块。先去 BOM 字符 `\uFEFF`（第 79 行），按 `\r?\n` 切行；若首行不是 `---` 或找不到结束 `---`，返回 `{ fields:null, body: normalized, endLine:0, closed:false, raw:'' }`（第 81、86 行）。找到则把中间段交给 `parseYamlLite`，正文为结束 `---` 之后的全部内容，返回 `{ fields, body, endLine: end+1, closed:true, raw }`。
- `parseYamlLite(raw)`（第 94–118 行）：极简 YAML，只支持本仓库文章用到的形态——`key: value` 与 `key:` 后跟 `- item` 列表。逐行处理：空行/注释行跳过（第 98 行）；列表项 `- xxx` 追加到当前 key 的数组（第 99–104 行）；`key: value` 解析（第 105–115 行），空值记 `[]`，`[a, b]` 内联列表按逗号 split 并 `unquote`（第 111–114 行）。
- `unquote(s)`（第 120–135 行）：去掉 YAML 引号。双引号标量优先 `JSON.parse`（第 127–128 行，因为 YAML 1.2 是 JSON 超集，`"C:\\src\\a.py"` 能正确还原转义），失败回退到切引号（第 128 行）；单引号标量把 `''` 还原成 `'`（第 130–133 行）。
- `extractSections(body)`（第 138–158 行）：从正文提取 `## 标题` 章节，返回 `[{ title, content, line }]`。`line` 为 1-based 起始行（第 150 行）。关键细节：用 `inFence` 状态位（第 142、145 行）跳过代码围栏内的 `##`，避免把代码注释里的 `##` 当成章节。
- `fencesBalanced(body)`（第 161–164 行）：统计正文里 ```` ``` ```` / `~~~` 围栏行数，返回 `{ balanced: count%2===0, count }`。
- `collectWikiLinks(body)`（第 167–176 行）：收集文章里的 wiki 链接目标，返回去重数组。同时识别 `[[name|alias]]`（第 170 行）和 markdown 相对链接 `(xxx.md)`（第 171–174 行，且 `xxx.md` 不以 `scheme:` 开头才收，外链不收）。
- `hasDuplicateFrontmatter(body)`（第 179–193 行）：检测正文里是否又出现一份 frontmatter。特征是某 `---` 之后 40 行内出现第二个 `---`，且中间含 `title:`/`type:`/`source_files:` 字段（第 184–188 行），即「重复贴头」的判据。
- `isRepoRelativeFile(p)`（第 195–203 行）：判断 `source_files` 条目是否合法仓库相对文件路径。拒绝：空串、绝对路径（`/` 或盘符）、`../` 越界、以 `/` 结尾（目录形态）、无扩展名的 basename（目录形态）。返回 `path.posix.basename(s).includes('.')`（第 202 行）。

### 主校验入口

- `inspectArticle(content, opts={})`（第 213–335 行）：核心入口。参数见下。返回 `issues[]`，空数组即通过。

  `opts` 字段（第 214–232 行）：
  - `cwd`：仓库根，用于 `source_files` 存在性判定（可选）。
  - `articlePath`：文章在 wiki 里的相对路径（如 `modules/x.md`），用于 type 与目录匹配。
  - `expectedType`：调用方期望的 type，覆盖目录推断。
  - `readableSources`：本次实际读取/提供给模型的文件清单，`source_files` 必须是它的子集（证据约束）。
  - `allowedLinks`：允许的 wiki 链接目标集合（`null` 表示不检查）。
  - `fsImpl`：提供 `exists(relPath)` 的文件系统适配（可选）。
  - `requiredSections`：章节要求覆盖。默认用 `REQUIRED_SECTIONS`；传 `[]` 表示只查「结构完整」不查章节名（供原生 FSoft 引擎通道——其章节名是 `## Introduction and Purpose` 之类，不是本仓库 agentic 通道的 `## Overview`，用默认表会误判一批不可修复的 warning，详见第 217–224 行注释）。
  - `allowEmptySourceFiles`：空 `source_files` 是否合法。默认 `false`（0.14.0 语义——无代码依据必须拒）；唯一例外是原生 whole-repository 通道（FSoft 在该模式下 `module_tree.json` 是 `{}`，无归属证据可查，空 `source_files` 是诚实记录而非编造），开启后空 `source_files` 交由上层判 `partial` 而非拒写（详见第 225–231 行注释）。

  执行流程（第 233–334 行）：
  1. 空内容 → `empty`（第 236–239 行）。
  2. 解析 frontmatter；无字段按 `frontmatter-unclosed`/`frontmatter-missing` 区分（第 241–246 行）。
  3. 必填字段 `REQUIRED_FIELDS` 缺失 → `missing-field`（第 249–257 行），但 `source_files` 在 `allowEmptySourceFiles` 时放行；`tags` 字段本身缺失（即便空列表也算缺失）→ `missing-field`（第 260–262 行，第 258–259 行注释说明 `tags` 允许空列表但必须有该字段）。
  4. type 与目录匹配：`dirType` 由 `ROOT_TYPES`/`TYPE_BY_DIR` 推断，`wantType = expectedType ?? dirType`；type 不匹配或缺失 → `type-mismatch`（第 264–273 行）。
  5. `source_files`：格式（`bad-source`，第 279–281 行）、证据来源（`source-not-evidence`，与 `readableSources` 比对，第 282–288 行）、存在性（`missing-source`，用 `fsImpl.exists` 与 `cwd` 拼接，第 289–292 行）。
  6. 正文：`empty-body`（第 296 行）、`duplicate-frontmatter`（第 297 行）、`unclosed-fence`（第 298–299 行）。
  7. 章节：重复章节 `duplicate-section`（第 305–309 行）；必需章节缺 → `missing-section`（warning）、空 → `empty-section`（error）（第 310–315 行）；非必需空章节 → `empty-section-optional`（warning）（第 316–320 行）。
  8. 内部链接：`allowedLinks` 非空时，候选目标含裸名、`name.md`、相对 `baseDir` 的两种归一化形态（第 327–329 行），命中不存在 → `dead-link`（第 331 行）。

  `push(kind, detail)` 闭包（第 234 行）统一把 issue 压成 `{ kind, detail, severity: SEVERITY[kind] ?? 'error' }`。

### 便捷 / 写集闸门函数

- `issueSummary(issues)`（第 338–343 行）：把 issues 压成一行人类可读文案；无 issue 返回 `null`，否则返回 `文章契约未通过：<首因 detail>（共 N 项）`。
- `hasBlockingIssue(issues)`（第 346–348 行）：硬拒写判据——只有含 `severity === 'error'` 的 issue 才拦落盘；warning 放行但记账。
- `makeWriteSet(paths)`（第 352–355 行）：构建允许写入的路径集合（agentic 工具的 `allowedWritePaths` 闸门）。`paths` 非数组返回 `null`（表示调用方没设限）；否则返回规范化后的 `Set`。
- `normalizeWritePath(p)`（第 357–361 行）：把路径转成规范化 POSIX 路径（统一 `/`、trim、`path.posix.normalize`），空串返回 `null`。
- `isWritable(target, writeSet, { cwd=null })`（第 365–378 行）：判定写入目标是否在写集内。写集为 `null` 直接放行（第 366 行）；先按规范化 POSIX 比较，再在 `cwd` 下把相对路径解析成绝对路径比较（第 370–375 行），避免 `../` 越界写到别的仓库。

## Architecture

`inspectArticle` 是唯一的编排入口，内部调用一系列纯解析函数（frontmatter / 章节 / 链接 / 围栏 / 路径），再按 `SEVERITY` 映射把每个缺陷标为 error 或 warning。下游通过 `hasBlockingIssue` 决定是否拒写。

```text
         content + opts{cwd, articlePath, expectedType,
                        readableSources, allowedLinks, fsImpl,
                        requiredSections, allowEmptySourceFiles}
                          │
                          ▼
                  ┌───────────────────────┐
                  │  inspectArticle()     │  lib/article-contract.js:213
                  │  (唯一编排入口)        │
                  └───────────┬───────────┘
        ┌─────────┬───────────┼────────────┬──────────────┬─────────────┐
        ▼         ▼           ▼            ▼               ▼             ▼
┌──────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  ┌──────────┐  ┌────────────┐
│parse-    │ │extract- │ │collect- │ │fences-   │  │hasDupl.  │  │isRepo-     │
│Frontmatter│ │Sections │ │WikiLinks│ │Balanced  │  │Frontmatter│ │RelativeFile│
│  :77     │ │  :138   │ │  :167   │ │  :161    │  │  :179    │  │  :195      │
└────┬─────┘ └────┬────┘ └────┬────┘ └────┬─────┘  └────┬─────┘  └─────┬──────┘
     │parseYamlLite:94          │                │                       │
     ▼ unquote:120              ▼                ▼                       ▼
  字段/type匹配           章节必填/空判定     dead-link/duplicate     bad-source/
  source_files校验        (REQUIRED_SECTIONS   -section            missing-source
   (SEVERITY:56)           :36, TYPE_BY_DIR:19)                   (fsImpl.exists)
        │                    │                │                       │
        └────────────────────┴────────────────┴───────────────────────┘
                          ▼
                  ┌───────────────────────┐
                  │  issues[] {kind,      │
                  │   detail, severity}   │
                  └───────────┬───────────┘
                              ▼
                   ┌─────────────────────┐      ┌────────────────────────┐
                   │ hasBlockingIssue()  │  ──► │ error → 拒写 (落盘闸门) │
                   │   :346              │      └────────────────────────┘
                   └─────────┬───────────┘      ┌────────────────────────┐
                             └───warning──────► │ 放行但终态降 partial    │
                                                └────────────────────────┘
```

配套写集闸门（与内容契约正交）：`makeWriteSet`(:352) / `normalizeWritePath`(:357) / `isWritable`(:365) 构成 `allowedWritePaths` 路径越界防护，被 agentic 工具链复用。

## Data Flow

一条典型的「坏文章被拦下」调用链（以 `test-article-contract.mjs` 的用例为蓝本）：

1. 调用方（如 `index.js` 落盘前、`agentic.js`/articles-agentic 的校验步骤）拿到模型产出的 `content` 与元信息（`articlePath`、`cwd`、`readableSources`、`allowedLinks`、`fsImpl`），调用 `inspectArticle(content, opts)`（第 213 行）。
2. `parseFrontmatter` 解析出 `fields` 与 `body`（第 241 行）。若模型漏写或漏闭合 `---` → 立即返回 `frontmatter-missing`/`frontmatter-unclosed`（第 243–245 行），短路。
3. 字段层校验：`REQUIRED_FIELDS` 与 `tags` 必填性（第 249–262 行）；`type` 与 `articlePath` 推断出的 `dirType`/`expectedType` 比对（第 264–273 行）。
4. `source_files` 三重校验：格式 `isRepoRelativeFile`（第 279–281 行）→ 证据 `readableSources` 子集（第 282–288 行）→ 存在性 `fsImpl.exists` + `cwd`（第 289–292 行）。
5. 正文层：`empty-body`、`hasDuplicateFrontmatter`、`fencesBalanced`（第 296–299 行）。
6. 章节层：`extractSections` 提取后经 `REQUIRED_SECTIONS[wantType]` 比对，产出 `missing-section`/`empty-section`/`empty-section-optional`/`duplicate-section`（第 302–320 行）。
7. 链接层：`allowedLinks` 非空时 `collectWikiLinks` + `baseDir` 归一化候选，未命中 → `dead-link`（第 323–332 行）。
8. 所有 `push` 进的 issue 带 `severity`（第 234 行，查 `SEVERITY` 第 56–73 行）。返回 `issues[]`（第 334 行）。
9. 调用方用 `hasBlockingIssue(issues)`（第 346 行）判门：有 `error` 即拒写；否则 `issueSummary(issues)`（第 338 行）记入编译终态，让终态降为 `partial`（阻止基线前移，但「装绿」不被允许）。
10. 写盘前再用 `isWritable(target, makeWriteSet(allowedWritePaths), { cwd })`（第 365、352 行）做第二道路径越界防护。

## Connections

- [[index]]：旧闸门 `validateArticleEnvelope`（`index.js:1170` 一带）只查 frontmatter 开合，是本模块要替代的对象；`lib/article-contract.js` 第 3–11 行注释记录了被它放过的真实缺陷。本模块由 `index.js` 在写入前调用形成落盘闸门。
- [[agentic]]：`makeArticleEditor`（agentic.js:200）负责文章的精确编辑，`allowedWritePaths` 闸门复用本模块的 `makeWriteSet`/`isWritable`/`normalizeWritePath`（article-contract.js:357–378）做路径越界防护。
- [[articles-agentic]]：agentic 文章执行器，是 `inspectArticle` 的主要调用方之一，把文章契约作为质量关卡。
- [[engine-contract]] / [[engine-mapping]]：FSoft 原生引擎通道的 `requiredSections`/`allowEmptySourceFiles` 覆盖参数（article-contract.js:217–231 注释）正是为适配 `documentation_generator.py` 的产物章节形态与 `module_tree.json` 的 `{}` 边界而设；`mapFsoftOutput` 决定文章落点与 `type`。
- [[wiki-anchors]]：行号锚点校验（`test-wiki-anchors.mjs` 同源逻辑，index.js:998–1009）与本文的「结构契约」正交——前者管锚点指到的代码行是否真实，后者管文章结构是否完整。

## Known Issues

- **`REQUIRED_SECTIONS` 不含 `tags`/无 `connections` 强制约束**：`tags` 只作为「必填字段」存在（第 260–262 行），不要求非空；`Connections`/`Architecture` 等节并非所有类型必需。`missing-section` 是 warning 而非 error（第 71 行），故缺章节文章仍可能被写入（终态降 partial），不阻落盘——这是有意设计（第 51–53 行注释），但意味着「结构完整」与「内容达标」是两个层级。
- **原生引擎通道的依赖注入**：`requiredSections` 与 `allowEmptySourceFiles` 是为 FSoft 原生通道特设的逃生口（第 217–231 行）。若不传，原生通道真实产物会因章节名（`## Introduction and Purpose` 等）不符而永远 partial，闸门退化成噪声。这属于「调用方必须正确配置」的隐含契约，文档化在注释里，但易误用。
- **`parseYamlLite` 是最小实现**：只支持 `key: value` 与列表形态（第 94–118 行）。复杂 YAML（锚点、多行块标量、嵌套映射）无法解析。`unquote` 对 YAML 专有转义（如 `\e`）JSON 不认时回退到「切引号」（第 126–128 行），存量文章不会因此判坏，但值语义可能与标准 YAML 解析器不同。
- **死链检测依赖调用方传入 `allowedLinks`**：`collectWikiLinks` 只收集目标（第 167–176 行），`dead-link` 仅在 `allowedLinks` 为数组时才判定（第 323 行）。若调用方不传，死链不检查（第 211 行注释）。
- **`type-mismatch` 同时覆盖「不匹配」与「缺失」**：第 270–273 行把 type 缺失也归到 `type-mismatch` kind，未单列 `missing-type`，调用方若按 kind 严格区分会丢失该信息。
- **无导出 `validateArticleEnvelope` 等价物**：旧入口在 `index.js`，本模块未提供完整替换函数的导出名，迁移边界需调用方自行对接（见 [[index]]）。
