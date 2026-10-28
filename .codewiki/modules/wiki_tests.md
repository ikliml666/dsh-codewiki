---
title: wiki_tests
type: module
source_files:
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
tags: [wiki, anchors, entry, integration-test, codewiki]
---

## Overview

`wiki_tests` 模块由两份独立的集成测试脚本组成，分别覆盖 wiki 产物的两个正交维度：

- **`test-wiki-anchors.mjs`** — 校验 `.codewiki/` 下所有文章里的「`file:NN(-MM)`」行号锚点是否对照真实源码成立。这是流水线曾系统性幻觉 `index.js` 行号（偏移 34~760 行、校对阶段拦不住）之后，把「锚点必须对照真实源码核对」制度化的回归测试。
- **`test-wiki-entry.mjs`** — 校验 `CodeWiki.md` 入口文件的自动生成（`ensureWikiEntry`）与 Windows 路径规范化（`normalizeArticlePath` / `normalizeIndexLinks` / `parseStatus`），全部走 `index.js` 的真实导出函数。

两份脚本都用进程退出码当测试门：`failures > 0` 时 `process.exit(1)`，CI 里任一断言失败即红灯。它们不依赖测试框架，纯靠 `check(cond, msg)` 计数器 + `exit` 状态码驱动（见 `test-wiki-anchors.mjs:172-176` 与 `test-wiki-entry.mjs:13-16`）。

`test-wiki-anchors.mjs` 的核心设计是**新鲜度感知的两档严格度**：结构类错误（行号越界、区间无序）永远是硬断言；同步类错误（指向空行、符号未绑定、CHANGELOG 版本节错位）仅在「源文件与编译基线逐字相同」时才硬失败，否则降级为软报告——因为文档滞后（代码改了但 `.codewiki/` 还没重编译）在日常开发里几乎必然发生，一律硬断言会把真错误淹没在 115 处假失败里（详见 `test-wiki-anchors.mjs:1-31` 的文件头注释）。

## Key Components

### test-wiki-entry.mjs 覆盖的 `index.js` 导出函数

这些是 `test-wiki-entry.mjs` 通过 `import` 直接调用的真实函数（`test-wiki-entry.mjs:10`）：

- **`ensureWikiEntry(cwd, language)`** — `index.js:301-334`。仓库根缺失 `CodeWiki.md` 时自动生成入口文件；已存在则绝不覆盖。
  - 返回 `false` 的短路情况：`cwd` 为空（`index.js:302`）或 `CodeWiki.md` 已存在（`index.js:304`）。
  - `language` 匹配 `/中文|zh/i` 时写中文入口（`index.js:306`），否则写英文入口（`index.js:319`）。
  - 中文入口正文含：`.codewiki` 绝对路径（第 312 行用 `path.join(cwd, '.codewiki')`）、`codewiki_generate` 收尾工具名、`_architecture.md` 架构总览指引、`.codewiki/` 改动与代码一起提交的收尾提醒、以及「流水线不会覆盖」声明（第 316 行 `> 本文件由编译流水线在缺失时自动生成…`）。对应 `test-wiki-entry.mjs:27-33`。
  - 英文入口用 `living wiki` 文案（第 323 行），对应 `test-wiki-entry.mjs:45-46`。
  - 生成成功返回 `true`（`index.js:333`）。

- **`normalizeArticlePath(p)`** — `index.js:209`。把 `\` 统一替换为 `/`（纵深防御旧 cw 二进制在 Windows 输出的反斜杠），`undefined`/`null` 经 `String(p ?? '')` 落到空串。对应 `test-wiki-entry.mjs:57-59`。

- **`normalizeIndexLinks(cwd)`** — `index.js:213-221`。改写 `.codewiki/_index.md` 中 `[[link|title]]` 链接头（`[[` 到 `|` 之间）的反斜杠为 `/`，不碰标题与正文；文件不存在静默返回 `false`（第 216 行 `try/catch`）；无任何改动也返回 `false`（第 218 行）。对应 `test-wiki-entry.mjs:63-72`。

- **`parseStatus(stdout)`** — `index.js:223-236`。解析 cw 三态输出：
  - `No wiki found` → `{ state: 'missing', ... }`（第 225 行）
  - `has not been compiled yet` → `{ state: 'uncompiled', ... }`（第 226 行）
  - `Wiki is up to date` → `{ state: 'clean', ... }`（第 227 行）
  - 否则逐行匹配 `/^\s+[M!]\s+(.+)$/gm`（第 230 行）：`M` 行进 `changedFiles`、`!` 行进 `staleArticles`，两者都先过 `normalizeArticlePath`（第 232/233 行）。对应 `test-wiki-entry.mjs:60-62`。

### test-wiki-anchors.mjs 内部组件（自包含，不依赖外部函数）

- **`readSourceFile(rel, { head, ref })`** — `test-wiki-anchors.mjs:57-78`。读取三类基准源码视图：编译基线版（`git show <ref>:<rel>`，第 61 行）、HEAD 版（`git show HEAD:<rel>`，第 69 行）、工作区版（`fs.readFileSync`，第 76 行）。任一类取不到返回 `null` 跳过该基准。

- **`compiledCommitForViews`** — `test-wiki-anchors.mjs:86-91`。从 `.codewiki/_meta.yaml` 正则提取 `last_compiled_commit` 作为编译基线 commit。

- **`loadSource(rel, preferHead)`** — `test-wiki-anchors.mjs:96-118`。按 `preferHead` 决定「工作区 ∪ HEAD ∪ 编译基线」三基准的顺序（第 101-103 行），对每版去重（按全文比对，第 111-113 行），返回 `{ lines, total, head, base }` 视图数组。

- **`SOURCES`** — `test-wiki-anchors.mjs:119-122`。预加载 `index.js` 与 `client.js` 两种文件视图；其余引用文件按需 `loadSource` 加载。

- **`isFresh(rel)`** — `test-wiki-anchors.mjs:135-149`。新鲜度判据：编译基线文件与当前工作区文件**逐字相同**才新鲜（第 145 行 `base === now`）；`--strict` 时无条件返回 `true`（第 136 行），无基线时返回 `false`（第 137 行）。带 `freshnessCache` 缓存。

- **`clSectionsOf(src)`** — `test-wiki-anchors.mjs:157-165`。把 CHANGELOG 的 `## 版本号` 切成 `{ ver, start, end }` 章节区间，逐节收缩 `end`（第 163 行）。`CL_VIEWS` / `CL_SECTIONS_OF_VIEW` 在 `:166-167` 预构建。

- **`symbolsOnLine(line)`** — `test-wiki-anchors.mjs:187-202`。从行内反引号提取符号，规则：去参数/调用括号（第 191 行）、拒绝非标识符（第 192 行）、长度 ≥3 且末段 ≥3（第 193-194 行）、排除文件名（`FILE_LIKE`，第 198 行）。与 `index.js` 的 `symbolsWithPos`（`index.js:912-922`）同源。

- **`walk(dir)`** — `test-wiki-anchors.mjs:213-222`。递归收集 `.codewiki/` 下所有 `.md`。

- **`check(cond, msg)`** — `test-wiki-anchors.mjs:172-176`。硬断言：`cond` 真则 `passed++`、假则 `failures++` 且 `console.error`；返回 `cond` 供 `if (!check(...)) continue` 短路。

- **`soft(msg)`** — `test-wiki-anchors.mjs:177-180`。软报告：推入 `softReports`，不计入 `failures`。

- **`judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })`** — `test-wiki-anchors.mjs:293-394`。单基准下判定一个锚点，返回 `{ ok, msg, kind }`，`kind` 分 `'struct'`（行号越界 `:297`、区间无序 `:308`、区间越界 `:309`、符号在文件里根本不存在 `:385` 结构铁证）与 `'sync'`（指向空行 `:305`、符号存在但未绑定区间 `:385`）。CHANGELOG 版本节错位判 `kind: 'changelog'`（第 332 行）。符号绑定仅在「本行唯一文件锚点」时校验（第 364 行），且只查锚点左侧最近分句（以 `CLAUSE_SEP = /[。；;，,|\n]/` 切分，第 358-363 行）。

- **`describeOk(a, views)`** — `test-wiki-anchors.mjs:280-288`。通过时说明是哪个基准解释了这个锚点。

### 与测试相互印证的源函数（`index.js`）

- **`fixAnchors(content, cwd)`** — `index.js:856-1073`。落盘前确定性校正锚点，是 `test-wiki-anchors.mjs` 校验语义的对偶实现：区间锚点在整段搜符号（第 1018 行）、多锚点行按锚点前就近符号逐点绑定（第 988-1001 行）、符号归属 `locate`（第 969-987 行）与校验器 `judgeAnchor` 同规则。

- **`fixChangelogAnchors(content, cwd)`** — `index.js:709-825`。CHANGELOG 按版本节首 + 相对偏移重定位（第 796 行 `nn = sec.start + (it.n - base)`）；归属判据 `verOf` 取锚点左侧最近版本号（第 746-753 行），与 `test-wiki-anchors.mjs:320-324` 完全同源。

- **`changelogSections(clLines)`** — `index.js:699-707`。与 `test-wiki-anchors.mjs` 的 `clSectionsOf`（第 157-165 行）算法相同的章节切分。

## Architecture

两份脚本各自独立、互不调用，但共享同一个「对照真实源码」的契约——`test-wiki-anchors.mjs` 校验锚点、`index.js` 的 `fixAnchors` 修正锚点，两者符号判定规则同源（见 `index.js:856-860` 注释）。

```text
test-wiki-anchors.mjs                 index.js (生产代码)
┌────────────────────┐                ┌─────────────────────────┐
│ walk(.codewiki/)   │                │ fixAnchors /            │
│ 收集全部 .md 文章   │                │  fixChangelogAnchors    │
└─────────┬──────────┘                └───────────┬─────────────┘
          │ 逐行正则提取 file:NN(-MM) 锚点          │ 落盘前逐行校正
          ▼                                        ▼
┌────────────────────┐                ┌─────────────────────────┐
│ loadSource(rel)    │                │ symbolsWithPos /       │
│ 三基准: 工作区∪HEAD │◄── 同源码视图 ──┤  locate (符号归属)      │
│ ∪编译基线 (git show)│                │  (同源规则)             │
└─────────┬──────────┘                └───────────┬─────────────┘
          │ 逐个基准跑 judgeAnchor                  │
          ▼                                        │
┌────────────────────┐                ┌─────────────────────────┐
│ isFresh(rel)       │                │ changelogSections /    │
│ 新鲜度 → 两档严格度 │                │  verOf (版本节归属)     │
└─────────┬──────────┘                └─────────────────────────┘
          │ struct→硬失败  sync→软报告(滞后)  changelog→软报告
          ▼
┌────────────────────┐
│ check / soft       │
│ exit(failures>0?1) │
└────────────────────┘

test-wiki-entry.mjs ──import──► index.js: ensureWikiEntry / normalizeArticlePath
                                         normalizeIndexLinks / parseStatus
```

## Data Flow

### test-wiki-anchors.mjs 数据流

1. **入口**：`ROOT` = 脚本所在目录（`test-wiki-anchors.mjs:37`），`WIKI` = `ROOT/.codewiki`（第 38 行）。`FORCE_STRICT` 由 `--strict` 参数触发（第 39 行）。
2. **加载基准**：预读 `_meta.yaml` 取 `compiledCommit`（第 128-133 行）；预加载 `index.js`/`client.js` 视图（第 119-122 行）与 `CHANGELOG.md` 版本节（第 166-167 行）。
3. **遍历文章**：`walk(WIKI)` 收集所有 `.md`（第 224 行）→ 逐行 `text.split(/\r?\n/)`（第 235 行）。
4. **提取锚点**：正则 `/([A-Za-z0-9_\-./]+\.(?:js|mjs|ts|md|json|yml|yaml|txt|log))[:：](\d+)(?!\.\d)(?:-(\d+))?/g`（第 241 行）抓 `file:NN(-MM)`；`(?!\.\d)` 防止把 `README.md：0.13.0` 的版本号误当行号 0（第 239 行注释）。
5. **逐基准判定**：对每个锚点 `loadSource(srcName)` 取视图数组（第 250 行），循环每个视图跑 `judgeAnchor`（第 260 行），任一 `ok` 即整体通过。
6. **两档分流**：`firstKind` 记录首个失败类别（第 262 行）；`softOnly = firstKind==='changelog' || (firstKind==='sync' && srcName==='CHANGELOG.md')`（第 270 行）一律软报告；`sync` 且源文件滞后（`!isFresh`）降级软报告（第 272 行）；其余 `check(ok, ...)` 硬断言（第 274 行）。
7. **汇总**：`softReports.length>0` 时末尾列出滞后来源（第 396-401 行）；最终 `process.exit(failures > 0 ? 1 : 0)`（第 403 行）。

### test-wiki-entry.mjs 数据流

1. **准备**：用 `fs.mkdtempSync` 建临时根（第 18 行），`repo(name)` 造子目录（第 19-23 行）。
2. **用例 1 缺失→生成**：`ensureWikiEntry(repo1,'中文')` 应返回 `true`（第 27 行），再读回 `CodeWiki.md` 断言含绝对路径/`codewiki_generate`/`_architecture.md`/`不会覆盖`（第 28-32 行）。
3. **用例 2 已有→不覆盖**：手写 `CodeWiki.md` 后调用返回 `false` 且内容不变（第 36-39 行）。
4. **用例 3 英文**：`'English'` 触发英文文案、含 `living wiki`（第 42-46 行）。
5. **用例 4 空 cwd**：`ensureWikiEntry('','中文')` 返回 `false` 不抛错（第 49 行）。
6. **用例 5 幂等**：第二次调用返回 `false` 且内容不变（第 52-54 行）。
7. **用例 6 Windows 路径**：`normalizeArticlePath` 三种输入（`\`→`/`、原样、undefined）、`parseStatus` 解析 `changedFiles`/`staleArticles`（第 60-62 行）、`normalizeIndexLinks` 改写 `_index.md` 链接头并保留正文反斜杠、幂等返回 `false`（第 63-72 行）。
8. **收尾**：删除临时目录（第 74 行），`process.exit(failures ? 1 : 0)`（第 76 行）。

## Connections

- [[index.js]] — 被本模块直接测试的源文件：`ensureWikiEntry`、`normalizeArticlePath`、`normalizeIndexLinks`、`parseStatus`、`fixAnchors`、`fixChangelogAnchors` 均在此定义。
- [[test-batch]] — `fixAnchors` 的对抗用例（多锚点行「唯一归属行」判定）在此回归，与本模块的锚点校验共用同一套符号归属规则。
- [[article-contract]] — `index.js` 的 `contractCheck`/`inspectArticle` 是落盘闸门；锚点校验器与契约闸门协同保证文章质量。
- [[engine-output]] — `lib/engine/output.js` 负责把编译产物（含文章）落盘，落盘前调用 `fixAnchors`，本模块的锚点校验是其下游回归保护。
- [[incremental]] / [[update-planner]] — 增量编译依赖模块清单；`pruneOrphanModules`（`index.js:271`）清理孤儿模块的动机注释里点出 `test-wiki-anchors` 会因过期行号持续失败（第 258 行）。

## Known Issues

- **多锚点行不做符号绑定校验**：`test-wiki-anchors.mjs:204-211` 明确说明一行并列多个「符号 + 锚点」时**有意不校验**——曾写过一个「取离锚点最近的符号」的启发式函数但从未被调用（死代码），接入会产生大批误报，且与 `fixAnchors` 的「唯一归属行」判据不同源。这类行的正确性只由「行号在范围内 + 指向非空行」兜底，真正的对抗用例在 `test-batch.mjs`。

- **CHANGELOG 锚点永远软报告**：`judgeAnchor` 的 CHANGELOG 版本节错位（第 321-334 行）与 `test-wiki-anchors.mjs:293-297` 的 `softOnly` 逻辑决定：由于 CHANGELOG 是追加式流水账、发版本身就会让上一批锚点失效，这类失败不参与硬失败。兜底靠 `## X.Y.Z` 标题稳定锚与 `fixChangelogAnchors` 落盘前重定位。

- **基线不可达时一律按滞后（软报告）**：`isFresh` 在无编译基线 / 基线 commit 不可达时返回 `false`（`test-wiki-anchors.mjs:137`、`146` 的 `catch`），宁可少报也不做无法举证的硬失败。这意味着非 git 仓库或浅克隆下，同步类问题不会触发红灯。

- **提交前后基准不一致的历史坑（已修复）**：最初只有「工作区 ∪ HEAD」双基准，提交瞬间 HEAD 变成新源码、兜底消失，同一份文档 `--strict` 败数从 18 跳到 111（见 `test-wiki-anchors.mjs:86-89`）。补上「编译基线」第三基准（`compiledCommitForViews`，第 86-91 行）后，提交前后结果一致。

- **`symbolsOnLine` 与 `index.js` 的 `symbolsWithPos` 必须同源维护**：两处符号提取规则（长度 ≥3、排除文件名、去参数括号）复制粘贴，改一处须同步另一处（见 `index.js:908-911` 注释）。一旦漂移，修正器与校验器会出现「修正器认为已对、校验器判错」的死循环。

- **`test-wiki-entry.mjs` 依赖临时目录且假定有 `.codewiki/` 存在**：用例 6 的 `normalizeIndexLinks` 子用例显式 `fs.mkdirSync(.codewiki)`（第 64 行），但其余 `ensureWikiEntry` 用例在临时目录根直接写 `CodeWiki.md`，不依赖 `.codewiki/`；若运行环境 `os.tmpdir()` 不可写会整体失败。
