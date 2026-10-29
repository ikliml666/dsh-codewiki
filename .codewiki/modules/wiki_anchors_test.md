---
title: wiki_anchors_test
type: module
source_files:
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
tags: [testing, wiki, anchors, entry, path-normalization]
---

## Overview

本模块收录两个**编译产物质量门**测试，分别校验「wiki 文章里的行号锚点是否对照真实源码」与「入口文件自动生成 / Windows 路径规范化」：

- `test-wiki-anchors.mjs`（第 1–403 行）：扫描 `.codewiki/` 下所有 `.md` 文章，核对每个 `file:line[-line]` 锚点的行号与符号绑定。核心难点是**新鲜度感知的严格度**——把锚点分为「结构事实（永远硬失败）」与「同步事实（源文件滞后编译基线时降级为软报告）」两档，避免把「文档滞后」误报成「文档写错」。校验基准取 **编译基线版 ∪ 工作区版 ∪ HEAD 版** 三者的并集，任一能解释该锚点即算通过。
- `test-wiki-entry.mjs`（第 1–76 行）：单元测试 `index.js` 导出的 `ensureWikiEntry`（缺失时生成中英双语入口、已有绝不覆盖、空 cwd 安全返回）与三个 Windows 路径规范化工具 `normalizeArticlePath` / `normalizeIndexLinks` / `parseStatus`。

两者都是**零外部依赖的纯 Node 脚本**，直接 `node test-*.mjs [--strict]` 运行，断言失败 `process.exit(1)`。

## Key Components

### test-wiki-anchors.mjs（锚点校验器）

常量与缓存：

- `sourceCache`（第 56 行）：`Map`，按 `W:<rel>` / `H:<rel>` 缓存 `loadSource` 结果，避免同一文件重复读盘/调 git。
- `FORCE_STRICT`（第 39 行）：`process.argv` 含 `--strict` 时为 `true`，无条件按"新鲜"处理（发布前把关）。
- `compiledCommitForViews`（第 86–91 行）：从 `.codewiki/_meta.yaml` 读 `last_compiled_commit` 作为**编译基线**（第三个基准）。
- `SOURCES`（第 119–122 行）：预加载 `index.js` / `client.js` 两个高频引用文件的视图数组。
- `META_PATH`（第 127 行）：`.codewiki/_meta.yaml` 路径。
- `compiledCommit`（第 128–133 行）：新鲜度判据用的编译基线 commit（与 `compiledCommitForViews` 同源，独立再读一次）。
- `freshnessCache`（第 134 行）：`Map`，缓存每个 `rel` 的 isFresh 结果。
- `passed` / `failures`（第 169–170 行）：硬断言计数。
- `softReports`（第 171 行）：数组，盛放"因文档滞后无法定性"的软报告项，不计失败但末尾汇总。

函数：

- `readSourceFile(rel, { head, ref })`（第 57–78 行）：读一个基准下的源文件行数组。`ref` 走 `git show <ref>:<rel>`（编译基线版，第 61 行）；`head` 走 `git show HEAD:<rel>`（第 69 行）；否则读工作区 `fs.readFileSync`（第 76 行）。任一路径拿不到内容（文件新增/已删/非 git）返回 `null`，调用方跳过该锚点。
- `loadSource(rel, preferHead)`（第 96–118 行）：返回该文件**所有可用基准下的源码视图数组** `{ lines, total, head, base }`，工作区版在前（默认 `preferHead=false`，第 102–103 行），HEAD 版其次，编译基线版最后。`seen` 按**全文**去重（第 111–113 行），避免编译基线恰好等于工作区时重复校验。
- `isFresh(rel)`（第 135–149 行）：判断某源文件工作区内容是否与编译基线逐字相同（第 141–145 行）。`FORCE_STRICT` 直接返回 `true`；无基线或基线不可达返回 `false`（按滞后，软报告）。
- `clSectionsOf(src)`（第 157–165 行）：从某一基准视图里解析 CHANGELOG 的 `## X.Y.Z` 版本节，返回 `[{ver,start,end}]`（end 由下一节起点前推，第 163 行）。
- `CL_VIEWS`（第 166 行）/ `CL_SECTIONS_OF_VIEW`（第 167 行）：CHANGELOG 各基准视图及其版本节映射。
- `check(cond, msg)`（第 172–176 行）：硬断言，成功 `passed++` 打印 `✓`，失败 `failures++` 打印 `✗`；返回 `cond` 供 `if (!check(...)) continue` 短路。
- `soft(msg)`（第 177–180 行）：软报告，只入 `softReports` 并打印 `~`，不参与退出码。
- `FILE_LIKE`（第 186 行）：正则，识别 `.js/.md/.json/...` 等文件名，用于把"反引号包的是文件路径"过滤出符号提取（第 198 行）。
- `symbolsOnLine(line)`（第 187–202 行）：从一行里提取反引号代码标识符（允许点分与参数/调用形式，去尾部括号，第 190–191 行），过滤非符号写法（长度、尾段过短、文件名形如 `package.json`，第 192–198 行），返回 `[{sym, at}]`（`at` 为原文字符偏移，用于分句归属）。
- `walk(dir)`（第 213–222 行）：递归收集目录下所有 `.md` 文件。
- 主校验循环（第 232–277 行）：遍历每篇文章每行，正则 `([A-Za-z0-9_\-./]+\.(?:js|mjs|ts|md|json|yml|yaml|txt|log))[:：](\d+)(?!\.\d)(?:-(\d+))?`（第 241 行）抓全部仓内文件锚点（`(?!\.\d)` 防把 `README.md：0.13.0` 的版本号截成行号 0）。逐基准调 `judgeAnchor`（第 260 行），任一通过即 `ok`；否则按 `kind`（struct/sync/changelog）+ 新鲜度决定硬失败还是软报告（第 269–274 行）。
- `describeOk(a, views)`（第 280–288 行）：通过时打印"是哪个基准解释了这个锚点"。
- `judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })`（第 293–394 行）：在单个基准视图下判一个锚点是否成立，返回 `{ ok, msg, kind }`。逻辑顺序：
  1. 起始行越界 `1..total` → `struct`（第 297 行）。
  2. 非空检查：单行锚点必须指向非空行；区间锚点只要区间内**有代码**即可（起点空行属正常，第 302–306 行）；否则 → `sync`。
  3. 区间起止无序 / 终点越界 → `struct`（第 307–310 行）。
  4. CHANGELOG 版本节语义校验：锚点须落在行内左侧最近版本号对应的 `## V` 节内，失败 → `changelog`（第 321–334 行，**永远软报告**）。
  5. 符号绑定**仅当本行锚点唯一**时校验（第 364 行），且只认锚点所属分句内的符号（按 `。；,|\n` 切分，第 358–363 行）。区间内搜符号，命中 `span.includes(sym)` 或尾部 `tailOf(s)` 即通过；符号在本文件**根本不存在** → `struct`（铁证真错，第 385 行），符号存在但不在区间 → `sync`（可能漂移，第 385 行）。

### test-wiki-entry.mjs（入口生成与路径规范化测试）

- 导入（第 10 行）：`ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus` 全部来自 `./index.js`。
- `check(cond, msg)`（第 13–16 行）：本测试的轻量断言，失败 `failures++`。
- `tmp` / `repo(name)`（第 18–23 行）：用 `fs.mkdtempSync(os.tmpdir())` 建临时根，每个用例一个子目录。
- 用例 1：缺失入口 → 生成中文（第 25–32 行），校验返回 `true`、正文含 `.codewiki` 绝对路径、`codewiki_generate`、`_architecture.md`、"不会覆盖"声明。
- 用例 2：已有入口绝不覆盖（第 34–39 行），含手写 `CodeWiki.md` 内容比对。
- 用例 3：英文语言 → 英文文案（第 41–46 行），校验 `living wiki` 且不含"活 wiki"。
- 用例 4：空 cwd → 安全返回 `false` 不抛错（第 48–49 行）。
- 用例 5：重复调用幂等（第 51–54 行），第二次返回 `false` 且内容不变。
- 用例 6：Windows 路径规范化（第 56–72 行）：
  - `normalizeArticlePath('learnings\\update-gap.md')` → `learnings/update-gap.md`（第 57 行）；正斜杠原样（第 58 行）；`undefined` 安全返回空串（第 59 行）。
  - `parseStatus(...)`（第 60–62 行）：`changedFiles` 保留并规范化、`staleArticles` 的 `\` 规范为 `/`。
  - `normalizeIndexLinks(repo6)`（第 63–71 行）：只动 `[[link|...]]` 链接头的 `\` → `/`（第 69 行），正文 `E:\ik\repo` 反斜杠不受影响（第 70 行）；幂等（已规范再调返回 `false`，第 71 行）；无 `_index.md` 静默返回 `false`（第 72 行）。

### 被测源函数（index.js）

- `normalizeArticlePath(p)`（第 296 行）：`String(p ?? '').replace(/\\/g, '/')`，Windows `\` 归一化。
- `normalizeIndexLinks(cwd)`（第 300–308 行）：读 `.codewiki/_index.md`，正则 `/\[\[([^\]|\n]*?)\|/g` 只把链接头内的 `\` → `/`，无变化返回 `false`，否则写盘返回 `true`；文件不存在 catch 返回 `false`。
- `parseStatus(stdout)`（第 310–323 行）：解析 `cw status` 三态输出（`missing`/`uncompiled`/`clean`/`stale`），逐行 `/^\s+[M!]\s+(.+)$/gm` 抽取 `changedFiles`（`M`）与 `staleArticles`（`!`），均经 `normalizeArticlePath` 规范化。
- `ensureWikiEntry(cwd, language)`（第 388–421 行）：`cwd` 为空返回 `false`（第 389 行）；入口已存在返回 `false` 绝不覆盖（第 391 行）；否则按语言（`/中文|zh/i`，第 393 行）写中文或英文 `CodeWiki.md` 并 `return true`（第 420 行）。正文含 `.codewiki` 绝对路径、索引/架构/模块/概念四类文章指引、收尾运行 `codewiki_generate` 的提醒，以及"流水线不会覆盖人工入口"的声明（第 394–418 行）。

## Architecture

```text
                 .codewiki/*.md (编译产物)
                          │ walk() 递归收集
                          ▼
             每篇文章每行锚点 file:line[-line]
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   loadSource(rel) 三基准并集       symbolsOnLine() 提取符号
   ┌───────────────────────────┐
   │ 工作区版 (fs.readFileSync) │
   │ HEAD 版  (git show HEAD:)  │
   │ 编译基线版 (git show <ref>:)│  ref=last_compiled_commit
   └───────────────────────────┘
            │ 逐基准 judgeAnchor()
            ▼
   ┌─────────────────────────────────────┐
   │ kind: struct  → 永远硬失败 (check)   │
   │ kind: sync    → 滞后则 soft() 软报告 │
   │ kind: changelog→ 永远 soft() 软报告  │
   │ 任一基准 ok → 通过                   │
   └─────────────────────────────────────┘
            │ isFresh(srcName) 决定降级
            ▼
   硬失败→exit(1)   软报告→末尾汇总(不影响退出码)

  test-wiki-entry.mjs ──▶ index.js: ensureWikiEntry / parseStatus
                                  / normalizeArticlePath / normalizeIndexLinks
```

## Data Flow

锚点校验的数据流核心是**三基准源码视图并集**：

1. `readSourceFile`（第 57–78 行）按 `ref`(编译基线) / `head`(HEAD) / 工作区三选一返回行数组，拿不到返回 `null`。
2. `loadSource`（第 96–118 行）按 `preferHead` 决定顺序把三版拼成 `views`，按全文去重避免重复校验同一份内容。
3. 主循环对每个锚点（第 246–275 行）调 `loadSource(srcName)` 拿视图数组，逐个基准传 `judgeAnchor`（第 260 行）。首个失败的 `kind` 记在 `firstKind`（第 262 行）。
4. 降级决策（第 269–274 行）：`softOnly` = `kind==='changelog'` 或 `kind==='sync'` 且源文件是 CHANGELOG；否则 `kind==='sync'` 且 `isFresh(srcName)` 为 `false` 时降级软报告。结构类(`struct`) 永远硬失败。
5. 末尾（第 396–402 行）汇总软报告，提示"跑一次 `codewiki_generate` 重编译后基线前移，检查自动升级为硬断言"。

`test-wiki-entry.mjs` 的数据流简单：临时目录 `repo()` 建样例仓库 → 调用 `index.js` 导出函数 → `fs.readFileSync` 回读落盘结果做断言。

## Connections

- [[index]]：本模块测试的全部源函数（`ensureWikiEntry`/`parseStatus`/`normalizeArticlePath`/`normalizeIndexLinks`）定义于此，路径规范化是 cw Windows 兼容纵深的插件层收口（见 index.js 第 291–295 行说明）。
- 锚点修正逻辑（index.js 的 `fixAnchors` / `fixChangelogAnchors`）的**对抗用例**在 `test-batch.mjs` 中（test-wiki-anchors.mjs 第 208–211 行注释明确：多锚点行的价值由"行号范围+非空"兜底，真正钉死修错行为的是 test-batch.mjs 的 fixAnchors 对抗用例）；本测试只做"读后核对"，不写锚点。
- 孤儿模块清理 `pruneOrphanModules`（index.js 第 358–383 行）与本测试相关：过期的 `modules/*.md` 会让本测试拿过期行号校验已挪位源码（注释第 345–346 行实测 251 处失败里 169 处来自孤儿）。

## Known Issues

- **多锚点行不校验符号绑定**：一行并列多个 `file:NN`（表格一行多列、一句串多文件）时无法可靠归属，只靠"行号在范围内+指向非空行"兜底（test-wiki-anchors.mjs 第 204–211 行、第 356–357 行）。真正的修错行为由 test-batch.mjs 的 fixAnchors 对抗用例兜底。
- **CHANGELOG 锚点永远软报告**：追加式流水账使历史锚点必然单向下移，发版本身即让上一批锚点失效；fixChangelogAnchors 在落盘前尽力重定位，但同一行多版本并列引用时相对偏移无解（test-wiki-anchors.mjs 第 314–320 行，实测 40 修 / 8 越界）。故此处只报告不判负。
- **符号绑定只用"锚点左侧最近分句"判定**：依赖中文标点 `。；,|\n` 切分（第 358–363 行），对无标点分隔的表格行无效（故多锚点行整体不校验）。
- **`compiledCommitForViews` 与 `compiledCommit` 同源读了两次 `_meta.yaml`**（第 86–91 行、第 128–133 行）：前者供 `loadSource` 取基准内容，后者供 `isFresh` 做逐字比对新鲜度，二者职责不同故未合并。
