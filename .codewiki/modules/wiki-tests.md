---
title: wiki-tests
type: module
source_files:
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - index.js
  - client.js
  - test-batch.mjs
tags: [测试, wiki, 锚点, 入口, 质量保障]
---

## Overview

`wiki-tests` 模块是 CodeWiki 项目零依赖（直接 `node <file>` 运行，无测试框架）的自动化测试套件，覆盖 Wiki 产物正确性的两个独立测试面；二者都只依赖 Node.js 内置模块，断言失败一律 `process.exit(1)`，结果只打到 stdout/stderr，**不落盘任何日志文件**：

1. **entry 侧**（`test-wiki-entry.mjs`，共 77 行）：黑盒调用 `index.js` 导出的 `ensureWikiEntry` 与三个 Windows 路径规范化函数（`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks`）。在 `os.tmpdir()` 下用 `fs.mkdtempSync` 建前缀 `dsh-codewiki-entry-` 的隔离沙箱（6 个子目录 `repo1`~`repo6`），验证入口文件生成（含 `.codewiki` 绝对路径、`codewiki_generate` 收尾工具名、`_architecture.md` 架构指引、「不会覆盖」人工入口声明）、已有入口绝不覆盖、中英双语文案、空 `cwd` 安全返回，以及 cw 在 Windows 输出的 `\` 分隔路径被规范化为 `/`。
2. **anchors 侧**（`test-wiki-anchors.mjs`，共 404 行）：扫描 `.codewiki/` 下全部 `.md` 文章，用正则逐行提取 `file:行号`（含区间 `N-M`）锚点，对照真实源码逐条核对，制度化拦截 LLM 幻觉锚点。校验基准为「编译基线版 ∪ 工作区源码 ∪ 已提交 HEAD 版」三取一即有效；结构事实（越界 / 区间起止无序 / 区间终点越界）永远硬断言，同步事实（指向空行 / 符号绑定 / CHANGELOG 版本节）按源文件相对编译基线的逐字新鲜度分档——滞后时降级为软报告（记为「待重编译」）而非失败（机制细节见本文 Known Issues）。

## Key Components

### `test-wiki-entry.mjs` 测试组件（文件头注释 test-wiki-entry.mjs:1-6）

- **`check(cond, msg)`** (test-wiki-entry.mjs:13-16)：断言辅助函数，成功打印 `  ✓ ${msg}`；失败打印 `  ✗ ${msg}` 并 `failures += 1`。仅通过副作用与退出码体现，返回值未使用。
- **`tmp` / `repo(name)`** (test-wiki-entry.mjs:18-23)：用 `fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codewiki-entry-'))` 建隔离测试仓库根 `tmp`；`repo(name)` 在其下 `fs.mkdirSync(dir, { recursive: true })` 再建子目录供各用例独立使用（`repo1`~`repo6`，分别见 26/35/42/63/64 行调用）。
- **`ensureWikiEntry(cwd, lang)` 用例** (test-wiki-entry.mjs:26-54，被测函数定义见 `index.js` 301-334)：
  - 缺失时生成（26-32）：调用 `ensureWikiEntry(repo1, '中文')` 期望返回 `true`；读回 `CodeWiki.md` 断言包含 `.codewiki` 绝对路径（27-29）、`codewiki_generate` 收尾工具名（30）、`.codewiki/_architecture.md` 架构指引（31）、`不会覆盖` 人工入口声明（32）。
  - 已有入口不覆盖（34-39）：预写 `# My custom entry\n手写速查。\n`，调用期望返回 `false` 且文件内容未被覆盖（38-39）。
  - 英文语言分支（41-46）：传入 `'English'`，期望返回 `true` 且生成文件含 `living wiki`、不含中文「活 wiki」（44-45），同样含 `codewiki_generate`（46）。
  - 空 `cwd` 安全（48-49）：传入 `''` 期望返回 `false` 不抛错（对应 `index.js` 302 行 `if (!cwd) return false`）。
  - 重复调用幂等（51-54）：第二次调用 `repo1` 期望返回 `false` 且文件内容不变（52-54）。
- **Windows 路径规范化用例** (test-wiki-entry.mjs:56-72)：
  - `normalizeArticlePath`（57-59，定义见 `index.js` 209）：`\`→`/`、`modules/core.md` 正斜杠原样保留、`undefined` 安全返回空串。
  - `parseStatus`（60-62，定义见 `index.js` 223-236）：喂入含 `Changed since last compile (abc1234):` 与 `Stale articles:` 的样例输出，断言 `state==='stale'`、`changedFiles` 与 `staleArticles` 中的 `\` 均被规范化为 `/`（61-62）。
  - `normalizeIndexLinks`（63-72，定义见 `index.js` 213-221）：在 `repo6/.codewiki/_index.md` 写入含 `[[modules\core|core]]` 链接头与正文 `E:\ik\repo` 反斜杠的样例；断言有改动时返回 `true`（67）、链接头 `\`→`/`（69）、正文反斜杠不受影响（70）、幂等再次调用返回 `false`（71）、缺失 `_index.md` 静默返回 `false`（72）。
- **清理与汇总** (test-wiki-entry.mjs:74-76)：`fs.rmSync(tmp, { recursive: true, force: true })` 清理沙箱（74）；打印 `N FAILURES` 或 `全部断言通过`（75），`process.exit(failures ? 1 : 0)`（76）。

### `test-wiki-anchors.mjs` 测试组件（文件头注释 test-wiki-anchors.mjs:1-31 详述分档设计动机）

- **`ROOT` / `WIKI` / `FORCE_STRICT`** (test-wiki-anchors.mjs:37-39)：`ROOT = path.dirname(fileURLToPath(import.meta.url))`、`WIKI = path.join(ROOT, '.codewiki')`；`FORCE_STRICT` 由 `process.argv.includes('--strict')` 决定（用于发版前强制硬断言，使 `isFresh` 一律返回真）。
- **`sourceCache` + `readSourceFile(rel, { head, ref })`** (test-wiki-anchors.mjs:56-78)：把被引用源文件的「三档视图」缓存起来——`ref`=编译基线版（`git show ${ref}:${rel}`，57-66）、`head`=已提交 HEAD 版（`git show HEAD:${rel}`，67-74）、无选项=工作区版（`fs.readFileSync`，75-77）；任一项读不到（新增/已删文件）返回 `null`，该锚点跳过校验。读取基线/HEAD 失败与读不到只记 `null`，不抛错（65/73/77 行的 `catch { return null }`）。
- **`compiledCommitForViews`** (test-wiki-anchors.mjs:86-91)：IIFE 从 `.codewiki/_meta.yaml` 用正则 `/^last_compiled_commit:\s*([0-9a-f]{7,40})\s*$/m` 取 `last_compiled_commit` 作为第三档基准；取不到返回 `null`。
- **`loadSource(rel, preferHead)`** (test-wiki-anchors.mjs:96-118)：返回该文件所有可用基准的视图数组 `{ lines, total, head, base }`；按**全文** `body` 去重同内容版本（109-113），顺序默认工作区在前、HEAD 其次、编译基线最后（`preferHead` 时反之，101-103）；`ref===null` 的基准直接跳过（105）；结果按 `W:`/`H:` 前缀 + rel 缓存（97-98、116）。
- **`SOURCES`** (test-wiki-anchors.mjs:119-122)：预加载 `index.js` 与 `client.js` 的**视图数组**（注意：存的是数组而非单份 `{lines,total}`，主循环按基准逐版校验，且 `SOURCES['index.js']` 在 229 行被 map 出各版行数以打日志）。
- **`META_PATH` / `compiledCommit` / `freshnessCache` / `isFresh(rel)`** (test-wiki-anchors.mjs:127-149)：`compiledCommit` 同样从 `_meta.yaml` 取 `last_compiled_commit`（128-133）；`isFresh` 用 `git show ${compiledCommit}:${rel}` 与工作区文件**逐字**比较判定源文件是否新鲜（140-146），结果存 `freshnessCache`（147）；`FORCE_STRICT` 时一律真（136），`compiledCommit` 缺失时一律滞后（137），读不到同样滞后（146）。
- **`clSectionsOf(src)` / `CL_VIEWS` / `CL_SECTIONS_OF_VIEW`** (test-wiki-anchors.mjs:157-167)：`clSectionsOf` 用 `/^##\s+(\d+\.\d+(?:\.\d+)*)/` 解析 `CHANGELOG.md` 各版本节行区间（160-164，末节 `end` 取全文末行），供版本节语义校验；`CL_VIEWS = loadSource('CHANGELOG.md')`（166）、`CL_SECTIONS_OF_VIEW` 以视图为键映射各版章节（167，因 HEAD 版与工作区版章节行号不同）。
- **`check(cond, msg)` / `soft(msg)`** (test-wiki-anchors.mjs:172-180)：`check` 成功 `passed++`、失败 `failures++`，返回 `cond` 以支持 `if (!check(...)) continue` 短路（172-176）；`soft` 把「无法定性」项推入 `softReports`（171、177-180），不参与退出码。
- **`FILE_LIKE` / `symbolsOnLine(line)`** (test-wiki-anchors.mjs:186-202)：`FILE_LIKE = /\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|yml|yaml|txt|log|toml|lock|cfg|ini)$/i`（186）；`symbolsOnLine` 用 `` /`([^`\n]+)`/g `` 提取行内反引号代码标识符（189），剔参数表（191）、要求符号格式 `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$`（192）、排除长度<3 或尾段<3（193-194）、排除文件名式写法避免稳定假阳性（195-198），返回 `{ sym, at }` 数组（199）。
- **多锚点死代码说明** (test-wiki-anchors.mjs:204-211 注释)：曾写过的「取离锚点最近的符号」启发式函数**已被删除**（未调用、且会系统性误报）；多锚点行不再做符号绑定，由 `test-batch.mjs` 的 `fixAnchors` 对抗用例兜底（见 [[batch-tests]]）。
- **`walk(dir)`** (test-wiki-anchors.mjs:213-222)：递归收集目录下所有 `.md` 文章路径（含子目录，`walk` 在 218 行递归，219 行 `.md` 结尾入列）。
- **主校验循环** (test-wiki-anchors.mjs:224-277)：
  - 收集 `.codewiki/` 下全部文章并排序（224），为空直接 `process.exit(1)`（225-228）。
  - 逐行正则 `/([A-Za-z0-9_\-./]+\.(?:js|mjs|ts|md|json|yml|yaml|txt|log))[:：](\d+)(?!\.\d)(?:-(\d+))?/g`（241）匹配**仓内所有文件类型**的锚点（不限于 `index.js`/`client.js`）；`(?!\.\d)` 防止把「版本号」误当行号（239 行注释）。
  - 对每个锚点 `loadSource(srcName)` 取视图（250），逐基准调 `judgeAnchor` 校验，任一版通过即整体通过（258-263）；`firstKind` 记录首个失败的种类（257、262）。
  - 失败分档（269-274）：`kind==='changelog'` 或（`kind==='sync'` 且 `srcName==='CHANGELOG.md'`）→ 一律软报告（271）；`kind==='sync'` 且源文件滞后于编译基线 → 软报告（272）；其余（`struct` 或新鲜时的 `sync`）走 `check` 硬断言（274，失败计入 `failures`）。
  - 末尾汇总 `锚点校验：X 过 / Y 败 / Z 待重编译`（402），`process.exit(failures > 0 ? 1 : 0)`（403）。
- **`describeOk(a, views)`** (test-wiki-anchors.mjs:280-288)：通过时写明是哪个基准解释了这个锚点（单基准版具体到基准名，多基准版只报 `锚点在 ... 有效`），避免「过了但不知道为什么」。
- **`judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })`** (test-wiki-anchors.mjs:293-394)：在单个基准视图下判定锚点是否成立，返回 `{ ok, msg, kind }`（`kind ∈ {struct, sync, changelog}`）：
  - **struct 类**（293-310）：起始行越界（`!(start >= 1 && start <= src.total)`，297）、单行锚点指向空行且区间内也无代码（302-306，`spanHasCode` 判定见 302-303）、区间 `start > end` 起止无序（308）、区间 `end > total` 终点越界（309）——与源码变动无关，永远硬失败。
  - **changelog 类**（321-334）：仅当 `srcName === 'CHANGELOG.md'` 时（321），取锚点左侧最近的版本号（324-328），要求锚点落在该 `## V` 版本节区间内（330-332）；此判据在 321 注释中明确**永远软报告**，因 CHANGELOG 是追加式流水账，发版必让历史锚点下移。
  - **sync 类·符号绑定**（358-392）：仅当本行文件锚点数 `allFileAnchors.length === 1` 时校验（364）；用分句分隔符 `CLAUSE_SEP = /[。；;，,|\n]/`（358）取锚点左侧分句内的符号（359-363、365），在区间 `[start-1, end]`（或首行，367）搜索该符号或其尾段（368-369）。未命中时分两种：符号在文件**完全不存在** → `kind='struct'`（铁证真错，硬失败，381-388）；符号存在但不在区间 → `kind='sync'`（可能漂移，滞后时软报告）。

## Architecture

测试套件分为两个互相独立的 Node.js 脚本，分别面向入口生成与锚点校验，共享 `process.exit(failures ? 1 : 0)` 的退出码机制；两者都不落盘日志，结果只经 stdout/stderr 打印。

```text
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ test-wiki-entry.mjs          │       │ test-wiki-anchors.mjs        │
│ (entry 侧黑盒验证)           │       │ (anchors 侧扫描校验)         │
├──────────────────────────────┤       ├──────────────────────────────┤
│ ensureWikiEntry 用例 (26-54) │       │ walk() 收集 .md (213-224)   │
│ normalizeArticlePath (57-59) │       │ 逐行锚点正则 (241)          │
│ parseStatus (60-62)          │       │ 主循环/判定 (224-394)        │
│ normalizeIndexLinks (63-72)  │       │ loadSource 三基准 (96-118)  │
└───────────┬──────────────────┘       └───────────┬──────────────────┘
            │ 导入并验证                            │ 读取并验证
            ▼                                      ▼
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ ./index.js 导出函数           │       │ 三档源码视图（loadSource）   │
│ (ensureWikiEntry 等)         │       │ (真实行号与内容对照)         │
└──────────────────────────────┘       └──────────────────────────────┘
            │                                      │
            └─────────────► 结果仅打印至 stdout/stderr（不落盘日志）◄───┘
```

## Data Flow

### entry 侧数据流

1. `test-wiki-entry.mjs` 顶部用 `fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codewiki-entry-'))` 建根沙箱 `tmp`（18），再用 `repo(name)` 在各用例处建子目录 `repo1`~`repo6`（19-23、26/35/42/63/64 行调用）。
2. 调用从 `./index.js` 导入的 `ensureWikiEntry` / `normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks`（10 行 import），操作沙箱内 `CodeWiki.md` 与 `repo6/.codewiki/_index.md`。
3. 通过 `fs.readFileSync` 读回生成内容，用 `check()` 断言关键字符串（如 `.codewiki` 绝对路径、`codewiki_generate`、英文 `living wiki`、链接头 `\`→`/` 等，见 27-72 行各用例）。
4. 最终 `fs.rmSync(tmp, { recursive: true, force: true })` 清理沙箱（74），打印 `N FAILURES` / `全部断言通过`（75），并以 `process.exit(failures ? 1 : 0)` 结束（76）。

### anchors 侧数据流

1. `test-wiki-anchors.mjs` 启动即同步通过 `loadSource` 预加载仓库根下 `index.js` 与 `client.js` 的视图数组存入 `SOURCES`（119-122），另预加载 `CHANGELOG.md` 视图 `CL_VIEWS` 并算各版章节（166-167）。
2. `walk(WIKI)` 递归收集 `.codewiki/` 下所有 `.md` 文件并排序（224），若为空直接 `process.exit(1)`（225-228）。
3. 逐行用正则（241）匹配仓内所有文件锚点，结合 `symbolsOnLine`（243）提取的符号，对每个锚点 `loadSource(srcName)` 取视图后逐基准调 `judgeAnchor` 校验（250-263），并依 `isFresh` 分档（269-274）。
4. 累计 `passed` / `failures` / `softReports`，先打印滞后的软报告汇总（396-401），再输出 `锚点校验：X 过 / Y 败 / Z 待重编译`（402），并据此 `process.exit(failures > 0 ? 1 : 0)`（403）。

## Connections

- 被测核心函数（`ensureWikiEntry`、`normalizeArticlePath`、`parseStatus`、`normalizeIndexLinks`）均从 `index.js` 导出，函数实现与常量归属见 [[core-and-config]]（`ensureWikiEntry` 在 index.js:301-334、`normalizeArticlePath` 在 index.js:209、`parseStatus` 在 index.js:223-236、`normalizeIndexLinks` 在 index.js:213-221）。
- 锚点校验直接读取并绑定 `index.js` 与 `client.js`（`client.js` 详见 [[client-interface]]）的真实源码行，是保障 [[documentation-and-config]] 编译产物（`.codewiki/` 下的文章）锚点准确性的守门员；其行号修正的「正确解」由 `index.js` 的 `fixAnchors` 提供，对应的对抗用例落在 [[batch-tests]]（`test-batch.mjs` 的 `fixAnchors` 段落，test-batch.mjs:523-603）。
- 两个脚本都不落盘日志，结果只经 stdout/stderr 打印，由外层测试集合（见 [[test-suite]]、[[testing-suite]]、[[test-scripts]]）统一汇总；与 `test-batch.mjs` / `test-orchestration.mjs` / `test-cwd-paths.mjs` 等同属仓库的零依赖回归套件（各自 `node <file>` 运行、断言失败 `exit(1)`）。

## Known Issues

1. **anchors 测试「符号绑定」失败默认降级为软报告，非硬失败**
   测试脚本（`test-wiki-anchors.mjs`）不落盘日志，所有断言结果直接打印到 stdout/stderr（成功 `✓`、失败 `✗`）。按文件头注释（test-wiki-anchors.mjs:135-165）与实现，测试将锚点分为结构事实与同步事实：符号绑定属于同步事实，按源文件相对编译基线的逐字新鲜度分档——源文件滞后于编译基线（`isFresh` 返回假，见 135-149）时降级为软报告（「待重编译」），而非硬失败。因此若出现符号绑定失败（文章引用的行号虽有效但符号已漂移），控制台只打 `~` 软报告并累计进 `softReports`，由退出码反映不了；真正能钉住修错行为的是 `index.js` 的 `fixAnchors` 确定性校正，其对抗用例见 [[batch-tests]]（test-batch.mjs:523-603）。若要强制硬断言，可带 `--strict` 运行（`FORCE_STRICT` 见 39、136）。
2. **单锚点限制导致多锚点行跳过符号绑定**
   在 `test-wiki-anchors.mjs` 第 204-211 行明确注释：当一行存在多个锚点时（如表格一行多列），无法可靠判断符号归属，强行绑定会误判，因此仅做“行号在范围内 + 指向非空行”的兜底，放弃符号绑定校验。
3. **`nearestSymbol` 就近绑定可能误绑**
   第 204-211 行注释说明：曾写过一个「取离锚点最近的符号」的启发式函数做符号绑定，但从未被调用（死代码），且接入后会系统性误报；多锚点行的价值由「行号在范围内 + 指向非空行」兜底，真正能钉住修错行为的是 `test-batch.mjs` 的 `fixAnchors` 对抗用例。当前测试策略限制“单行单锚点才校验符号绑定”（见 364 行 `if (allFileAnchors.length === 1)`），实际误判风险被控制。
4. **entry 测试依赖真实文件系统**
   `test-wiki-entry.mjs` 第 18 行使用 `fs.mkdtempSync` 依赖系统临时目录写入权限，在极简容器环境若 `os.tmpdir()` 不可写则可能抛错（尽管空 `cwd` 路径已通过第 49 行安全返回覆盖）。
