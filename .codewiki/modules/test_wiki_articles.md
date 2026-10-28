---
title: test_wiki_articles
type: module
source_files:
  - test-article-contract.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - lib/article-contract.js
  - index.js
tags: [tests, wiki, articles, anchors, contract]
---

## Overview

本模块不是单一的源码模块，而是**三份专注于 wiki 产物质量的测试脚本**，它们共同保证 CodeWiki 编译出来的文章「结构正确、行号锚点真实、入口文件可靠」：

- `test-article-contract.mjs` — 文章契约（P0-4）单测。把 lib/article-contract.js 的 `inspectArticle` 闸门钉死：坏文章（frontmatter 缺失/未闭合、缺必填字段、type 与目录不符、重复 frontmatter、章节缺失/重复、围栏未闭合、坏 source_files、死链等）必须被识别并拦截，不能进入 `.codewiki/`。见 `test-article-contract.mjs:1` 的注释背景。
- `test-wiki-anchors.mjs` — wiki 文章行号锚点自动校验。流水线产物曾系统性幻觉 `index.js` 行号（偏移 34~760 行），本测试把「锚点必须对照真实源码核对」制度化，但严格度是「新鲜度感知」的，分硬断言与软报告两档（见 `test-wiki-anchors.mjs:1` 头部大段说明）。
- `test-wiki-entry.mjs` — CodeWiki.md 入口自动生成与 Windows 路径规范化单测。覆盖 `ensureWikiEntry`、`normalizeArticlePath`、`normalizeIndexLinks`、`parseStatus` 四个导出函数（见 `test-wiki-entry.mjs:1`）。

这三份测试都直接 `import` 被测源文件（`lib/article-contract.js` 走纯函数路径；`index.js` 走 `ensureWikiEntry` 等插件层导出），不需要启动整条编排流水线，靠 `check()` 累加 `pass/failures` 并在末尾打印汇总。

## Key Components

### test-article-contract.mjs（纯函数契约测试，无导出）

- `check(label, fn)` — `test-article-contract.mjs:20`：断言包装。`try/fn()` 成功 `pass++`，失败压入 `fails[]` 并打 `FAIL`。返回 `{ articlePath, content, opts }` 形式的 `inspectArticle` 调用结果用 `assert` 校验。
- `GOOD(over)` — `test-article-contract.mjs:25`：构造一份合法 module 文章的字符串（含 `title/type/source_files/tags` 与 `Overview`/`Key Components` 章节），`over` 覆盖默认 frontmatter 字段，供各负面用例在其上做删改。
- `kinds(issues)` — `test-article-contract.mjs:34`：把 issue 数组映射成 `kind` 列表，便于是非断言。
- 直接 `inspectArticle(...)` 用例（`test-article-contract.mjs:36` 起）：逐项钉住 `frontmatter-missing`、`frontmatter-unclosed`、`missing-field`、`type-mismatch`、`duplicate-frontmatter`+`duplicate-section`、`missing-section`、`empty-section`、`empty-section-optional`（warning 放行）、`unclosed-fence`、`bad-source`、`missing-source`、`source-not-evidence`、`dead-link`、`empty`、`empty-body`、`expectedType` 覆盖 `type-mismatch`、`_index.md` 豁免、分级（error 拦写 / warning 放行但降 partial）、写集闸门 `makeWriteSet`/`isWritable`。
- `parseFrontmatter`/`parseYamlLite`/`extractSections`/`fencesBalanced`/`collectWikiLinks`/`hasDuplicateFrontmatter`/`REQUIRED_SECTIONS`/`TYPE_BY_DIR`/`issueSummary` 的细粒度单测：`test-article-contract.mjs:151`、`160`、`166`、`172`、`177`、`184`、`189`、`196`、`203`、`210`、`220`。
- 退出逻辑：`test-article-contract.mjs:234` 打印 `pass / fails.length`；有失败则 `process.exitCode = 1`。

### test-wiki-anchors.mjs（锚点校验，独立 CLI 脚本）

- `readSourceFile(rel, { head, ref })` — `test-wiki-anchors.mjs:57`：从三个基准读源文件行数组——`ref`（编译基线 `git show <commit>:rel`）、`head`（`HEAD:rel`）、工作区（`fs.readFileSync`）；任一缺失返回 `null` 跳过该锚点。
- `compiledCommitForViews` — `test-wiki-anchors.mjs:86`：从 `.codewiki/_meta.yaml` 读 `last_compiled_commit`，作为语义最正的第三基准。
- `loadSource(rel, preferHead)` — `test-wiki-anchors.mjs:96`：返回该文件在「工作区 ∪ HEAD ∪ 编译基线」三基准下的视图数组，按全文去重，工作区版在前（除非 `preferHead`）。
- `isFresh(rel)` — `test-wiki-anchors.mjs:135`：逐字比较工作区与编译基线内容——`--strict` 或无基线时按滞后（软报告）处理。
- `clSectionsOf(src)` — `test-wiki-anchors.mjs:157`：解析 CHANGELOG 的版本节（`## X.Y.Z`）区间。
- `symbolsOnLine(line)` — `test-wiki-anchors.mjs:187`：抽取行内反引号代码符号（点分/带括号），过滤文件名与非符号串（`FILE_LIKE` 正则 `test-wiki-anchors.mjs:186`）。
- `walk(dir)` — `test-wiki-anchors.mjs:213`：递归收集 `.codewiki/` 下所有 `.md`。
- `check(cond, msg)` — `test-wiki-anchors.mjs:172`：硬断言，失败 `failures++`。
- `soft(msg)` — `test-wiki-anchors.mjs:177`：软报告压入 `softReports`，不计入失败。
- `judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })` — `test-wiki-anchors.mjs:293`：单基准下判定一个锚点；返回 `{ ok, msg, kind }`，`kind ∈ {struct, sync, changelog}`。`struct`（越界/区间无序）永远硬失败；`sync`（空行/符号绑定）滞后时降级软报告；`changelog` 永远软报告。
- `describeOk(a, views)` — `test-wiki-anchors.mjs:280`：通过时说明是哪个基准解释了该锚点。
- 主循环 `test-wiki-anchors.mjs:293`：遍历每篇文章每行，用正则 `([A-Za-z0-9_\-./]+\.(?:js|...))[:：](\d+)(?!\.\d)(?:-(\d+))?`（`test-wiki-anchors.mjs:241`）抽取锚点，逐基准 `judgeAnchor`，按新鲜度与 kind 决定硬失败 / 软报告 / 通过。
- 退出：`test-wiki-anchors.mjs:403` —— `process.exit(failures > 0 ? 1 : 0)`；`--strict` 通过 `FORCE_STRICT`（`test-wiki-anchors.mjs:39`）强制全硬断言。

### test-wiki-entry.mjs（入口生成与路径规范化单测，无导出）

- `check(cond, msg)` — `test-wiki-entry.mjs:13`：断言，失败 `failures++`。
- 用例分组（`test-wiki-entry.mjs:25` 起）：① 缺失→生成中文入口并校验含绝对路径/`codewiki_generate`/`.codewiki/_architecture.md`/「不会覆盖」；② 已有入口绝不被覆盖且返回 `false`；③ 英文文案；④ 空 cwd 安全返回 `false`；⑤ 重复调用幂等；⑥ Windows 路径规范化（`normalizeArticlePath`、`parseStatus`、`normalizeIndexLinks`）。
- 退出：`test-wiki-entry.mjs:76` —— 全部通过打印 `全部断言通过`，否则 `process.exit(1)`。

### 被测试的导出（源侧，写于此以便定位）

- `lib/article-contract.js` 导出（被 `test-article-contract.mjs:12` 全量导入）：
  - `ARTICLE_CONTRACT_VERSION` — `lib/article-contract.js:16`。
  - `TYPE_BY_DIR` — `lib/article-contract.js:19`：目录→type 映射。
  - `ROOT_TYPES` — `lib/article-contract.js:28`：根目录特殊文章（_architecture/_index/_patterns）。
  - `REQUIRED_SECTIONS` — `lib/article-contract.js:36`：各类型必需章节。
  - `REQUIRED_FIELDS` — `lib/article-contract.js:46`：`title/type/source_files`。
  - `SEVERITY` — `lib/article-contract.js:56`：issue 分级，区分 `error`（拒写）与 `warning`（放行但降 partial）。
  - `parseFrontmatter` — `lib/article-contract.js:77`：只认文首第一个 `---` 块，返回 `{ fields, body, endLine, closed, raw }`。
  - `parseYamlLite` — `lib/article-contract.js:94`：极简 YAML（key/列表/行内数组），`unquote` 见 `lib/article-contract.js:120`。
  - `extractSections(body)` — `lib/article-contract.js:127`：正文 `## 标题` 章节，围栏内不算章节（`inFence` 跳过）。
  - `fencesBalanced(body)` — `lib/article-contract.js:150`：围栏是否成对。
  - `collectWikiLinks(body)` — `lib/article-contract.js:156`：`[[x]]` 与 `.md` 相对链接，外链不收。
  - `hasDuplicateFrontmatter(body)` — `lib/article-contract.js:168`：正文又出现第二份 `---` 且含 `title/type/source_files` 即判重复。
  - `inspectArticle(content, opts)` — `lib/article-contract.js:202`：主入口，返回 `issues[]`（空=通过）；`opts` 含 `cwd/articlePath/expectedType/readableSources/allowedLinks/fsImpl`。
  - `issueSummary(issues)` — `lib/article-contract.js:309`：压成一行文案，`null` 表示通过。
  - `hasBlockingIssue(issues)` — `lib/article-contract.js:317`：仅 `error` 级拦落盘。
  - `makeWriteSet(paths)` — `lib/article-contract.js:323`：`null`（不检查）或规范化 `Set`。
  - `normalizeWritePath(p)` — `lib/article-contract.js:328`：把反斜杠 `\` 归一化为 `/` 后 `posix.normalize`。
  - `isWritable(target, writeSet, { cwd })` — `lib/article-contract.js:336`：写集闸门，相对路径以 cwd 解析比对，拒绝 `../` 越界。
- `index.js` 导出（被 `test-wiki-entry.mjs:10` 导入）：
  - `ensureWikiEntry(cwd, language)` — `index.js:301`：仓库根缺 `CodeWiki.md` 时生成（中/英双语、含 `.codewiki` 绝对路径与 `codewiki_generate` 指引），已有入口返回 `false` 绝不覆盖。
  - `normalizeArticlePath(p)` — `index.js:209`：把反斜杠 `\` 归一化为 `/`。
  - `normalizeIndexLinks(cwd)` — `index.js:213`：把 `_index.md` 链接头 `[[...|` 内的 `\` 规范化为 `/`，正文不动；无改动返回 `false`。
  - `parseStatus(stdout)` — `index.js:223`：解析 `cw status` 三态输出（missing/uncompiled/clean/stale），`M`→changedFiles、`!`→staleArticles，均过 `normalizeArticlePath`。

## Architecture

三份测试各自独立运行，但都与「wiki 产物质量」这条纵切相关。它们分别校验流水线的三道防线：落盘前的契约闸门、落盘后的锚点真实性、编译收尾的入口生成。

```text
  test-article-contract.mjs          test-wiki-anchors.mjs            test-wiki-entry.mjs
  (P0-4 契约单测)                    (行号锚点校验 CLI)               (入口生成单测)
        │                                  │                                │
        ▼                                  ▼                                ▼
  inspectArticle()                   walk(.codewiki/*.md)            ensureWikiEntry()
  lib/article-contract.js            judgeAnchor()                   index.js:301
  (纯函数，无 IO)                    loadSource() 三基准              normalizeArticlePath/IndexLinks
                                        │  readSourceFile()           parseStatus()
                                        ▼                            index.js:209/213/223
                                git show <baseline>:rel ┐
                                git show HEAD:rel       ├─ 编译基线 ∪ 工作区 ∪ HEAD
                                fs.readFileSync 工作区  ┘
                                        │
                                        ▼
                                hard-fail(struct) / soft-report(sync,changelog)
```

调用关系补充：
- `test-article-contract.mjs:16` 直接 `import` 自 `lib/article-contract.js`（纯函数路径）。
- `test-wiki-entry.mjs:10` 直接 `import { ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus }` 自 `index.js`。
- `test-wiki-anchors.mjs` 不依赖被测模块（`index.js` 的 `fixAnchors` 仅作注释对照，见 `test-wiki-anchors.mjs:204` 与 `index.js:856` 的 `anchorRe`）：它是独立的「事后审计」脚本，直接扫已编译的 `.codewiki/` 并对真实源码做三基准比对。

## Data Flow

### article-contract 测试数据流
`GOOD()` 生成合法文章串 → 在某用例里删改某字段（如 `test-article-contract.mjs:54` 删 `source_files:`）→ `inspectArticle(text, { articlePath })` → 断言 `kinds(issues)` 含预期 `kind`。`inspectArticle` 内部流程：`parseFrontmatter`（识别/闭合/缺字段）→ 必填字段校验 → type 与目录匹配（用 `TYPE_BY_DIR`/`ROOT_TYPES`）→ source_files 格式/存在性/证据来源 → 正文（duplicate-frontmatter / fencesBalanced / extractSections 章节校验 / collectWikiLinks 死链）→ 返回 `issues[]`。`SEVERITY[kind]` 决定该 issue 是否 error。最后用 `hasBlockingIssue` / `issueSummary` 验证分级与文案。

### wiki-anchors 测试数据流
启动读取 `.codewiki/_meta.yaml` 的 `last_compiled_commit`（`compiledCommitForViews` `test-wiki-anchors.mjs:86`、`compiledCommit` `test-wiki-anchors.mjs:128`）→ `walk(.codewiki)` 收集文章 → 逐行正则抽锚点 → 对每条锚点 `loadSource(srcName)` 取三基准视图（缓存 `sourceCache` `test-wiki-anchors.mjs:56`）→ `judgeAnchor` 逐基准判 `struct/sync/changelog` → 用 `isFresh(srcName)` 决定：struct 永远硬失败；sync 在滞后时降级软报告；changelog 永远软报告 → 末尾汇总 `passed / failures / softReports`，`failures>0` 退出 1。

### wiki-entry 测试数据流
在 `os.tmpdir()` 建临时仓库 → 调 `ensureWikiEntry(repo, lang)` → 读回 `CodeWiki.md` 断言含关键串 → 再调一次断言幂等/不覆盖。路径规范化用例直接调 `normalizeArticlePath`/`parseStatus`/`normalizeIndexLinks` 并断言反斜杠 `\` 收敛为 `/`（如 `test-wiki-entry.mjs:18`、`60`、`69`）。

## Connections

- [[article-contract]] — `lib/article-contract.js` 是被 `test-article-contract.mjs` 全量钉住的纯函数契约模块，本模块是它的主要测试集。
- [[index]] — `index.js` 既是 `ensureWikiEntry`/`normalizeArticlePath`/`normalizeIndexLinks`/`parseStatus` 的源，也是 `fixAnchors`（`index.js:856` 的 `anchorRe`）的源；`test-wiki-anchors.mjs` 独立审计其产物。
- [[codewiki-generate]] — 流水线 `codewiki_generate` 在收尾阶段调用 `ensureWikiEntry`（`index.js:3446`）与 `normalizeIndexLinks`（`index.js:3403`），并经由 `fixAnchors` 校正行号锚点（`index.js:2530`）；本模块三份测试分别覆盖这些收尾动作的正确性。
- [[update-planner]] / [[incremental]] — `parseStatus` 解析的 `staleArticles/changedFiles` 被增量编译与变更集判定消费（见 `index.js:3802`、`3856` 等），本模块验证其解析不漏反斜杠路径。

## Known Issues

- `test-wiki-anchors.mjs` 的锚点校验**默认是软报告优先的**：当源文件与编译基线不一致（lag）时，`sync` 类失败（空行/符号未绑定）与 `changelog` 类失败一律降级为「待重编译」软报告，不退出 1。这意味着它在日常开发里会**放过**真正漂移的锚点——设计上有意为之（避免淹没真错误），但意味着该测试不能单独作为「锚点全对」的发布级保证，发布前需 `--strict`（`test-wiki-anchors.mjs:30`、`39`、`136`）。
- `_index.md` 的豁免只验证了「缺 frontmatter 会被 `inspectArticle` 识别为 `frontmatter-missing`」（`test-article-contract.mjs:196`），并未真正跑 `cw index` 对 `_index.md` 的放行路径（放行逻辑在 `index.js` 而非本模块）。
- `source_files` 存在性判定依赖注入的 `fsImpl.exists`（`test-article-contract.mjs:114`），测试用临时目录造出 `src/util/strings.js` 充当证据；若 `fsImpl` 不传，`inspectArticle` 不会主动查文件系统（`lib/article-contract.js:202` 判定 `typeof fsImpl?.exists === 'function'`），这是纯函数隔离的设计，但意味着「坏路径」只在给定 `fsImpl` 时才报 `missing-source`。
- `test-wiki-entry.mjs` 的 Windows 反斜杠规范化断言依赖 `parseStatus`/`normalizeIndexLinks` 的正则替换行为；正文里的 `E:\ik\repo` 反斜杠（`test-wiki-entry.mjs:65`）被 `normalizeIndexLinks` 明确保留（`index.js:213` 只改 `[[...|` 链接头），测试已覆盖。
