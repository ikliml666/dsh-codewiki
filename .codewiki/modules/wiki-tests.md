---
title: wiki-tests
type: module
source_files:
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - index.js
  - client.js
  - README.md
tags: [测试, wiki, 锚点, 入口, 质量保障]
---

## Overview

`wiki-tests` 模块是 CodeWiki 项目零依赖（直接 `node <file>`，无测试框架）的自动化测试套件，覆盖 Wiki 产物正确性的两个独立测试面：

1. **entry 侧**（`test-wiki-entry.mjs`）：黑盒调用 `index.js` 导出的 `ensureWikiEntry` 与 Windows 路径规范化函数（`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks`），在 `os.tmpdir()` 下的隔离沙箱里验证入口文件生成（含 `.codewiki` 绝对路径、`codewiki_generate` 收尾指引、`_architecture.md` 架构指引、不覆盖人工入口声明）、已有入口绝不覆盖、中英双语文案、空 `cwd` 安全返回，以及 cw 在 Windows 输出 `\` 分隔路径时的规范化。
2. **anchors 侧**（`test-wiki-anchors.mjs`）：扫描 `.codewiki/` 下全部文章，把其中的 `file:行号`（含区间 `N-M`）锚点对照真实源码逐条核对，制度化拦截 LLM 幻觉锚点。校验基准为「编译基线版 ∪ 工作区源码 ∪ 已提交 HEAD 版」三取一即有效；结构事实（越界/区间倒序）永远硬断言，同步事实（空行/符号绑定/CHANGELOG 版本节）按源文件相对编译基线的新鲜度分档——滞后时降级为软报告（记为「待重编译」）而非失败。

两个脚本断言失败均以 `process.exit(1)` 退出，结果直接打到 stdout（用 `console.log`/`console.error`）；**不落盘任何日志文件**（旧文档提到的 `.tmp-test-wiki-entry.log` / `.tmp-test-wiki-anchors.log` 已不存在）。

## Key Components

### `test-wiki-entry.mjs` 测试组件

- **`check(cond, msg)`** (13-16行)：断言辅助函数，成功打印 `✓`；失败打印 `✗` 并 `failures += 1`。通过副作用与退出码体现，返回值未使用。
- **`tmp` / `repo(name)`** (18-23行)：用 `fs.mkdtempSync` 在 `os.tmpdir()` 下创建前缀 `dsh-codewiki-entry-` 的隔离测试仓库根 `tmp`；`repo(name)` 在其下再建子目录供各用例独立使用（`repo1`~`repo6`）。
- **`ensureWikiEntry(cwd, lang)` 用例** (26-54行，函数定义见 `index.js` 291-324行)：
  - 缺失时生成（27-32行）：验证返回 `true`，生成的 `CodeWiki.md` 包含 `.codewiki` 绝对路径、`codewiki_generate` 收尾工具名、`_architecture.md` 架构指引及不覆盖人工入口声明（`不会覆盖`）。
  - 已有入口不覆盖（35-39行）：预写 `# My custom entry\n手写速查。\n`，验证返回 `false` 且文件内容未被覆盖。
  - 英文语言分支（42-46行）：传入 `'English'`，验证生成文件使用英文文案（含 `living wiki`，不含中文「活 wiki」）。
  - 空 `cwd` 安全（49行）：传入 `''` 返回 `false` 不抛错（对应 `index.js` 292行 `if (!cwd) return false`）。
  - 重复调用幂等（52-54行）：第二次调用返回 `false` 且文件内容不变。
- **Windows 路径规范化用例** (56-72行)：
  - `normalizeArticlePath`（57-59行，定义见 `index.js` 199行）：`\` 转 `/`、正斜杠原样保留、`undefined` 安全返回空串。
  - `parseStatus`（60-62行，定义见 `index.js` 213-226行）：解析 `Changed since last compile` 与 `Stale articles:` 清单，把 `\` 规范化为 `/`，返回 `{ state, changedFiles, staleArticles }`。
  - `normalizeIndexLinks`（63-72行，定义见 `index.js` 203-211行）：仅把 `.codewiki/_index.md` 里 `[[link|title]]` 链接头的 `\` 改成 `/`，保留正文 `E:\ik\repo` 反斜杠；有改动返回 `true`、再次调用幂等返回 `false`、缺 `_index.md` 静默返回 `false`。
- **清理与汇总** (74-76行)：`fs.rmSync(tmp, { recursive: true, force: true })` 清理沙箱（74行）；打印断言汇总，`process.exit(failures ? 1 : 0)`（75-76行）。

### `test-wiki-anchors.mjs` 测试组件

- **`ROOT` / `WIKI` / `FORCE_STRICT`** (37-39行)：基于 `fileURLToPath(import.meta.url)` 定位仓库根 `ROOT` 与 wiki 目录 `WIKI`；`FORCE_STRICT` 由 `process.argv` 是否含 `--strict` 决定（用于发版前强制硬断言）。
- **`sourceCache` + `readSourceFile(rel, { head, ref })`** (56-78行)：把被引用源文件的「三档视图」缓存起来——`ref`=编译基线版（`git show <last_compiled_commit>:rel`）、`head`=已提交 HEAD 版（`git show HEAD:rel`）、无选项=工作区版（`fs.readFileSync`）；任一项读不到（新增/已删文件）返回 `null`，该锚点跳过校验。
- **`compiledCommitForViews`** (86-91行)：从 `.codewiki/_meta.yaml` 用正则取 `last_compiled_commit` 作为第三档基准；取不到返回 `null`。
- **`loadSource(rel, preferHead)`** (96-118行)：返回该文件所有可用基准的视图数组 `{ lines, total, head, base }`，按全文去重同内容版本；顺序默认工作区在前、HEAD 其次、编译基线最后（`preferHead` 时反之）。
- **`SOURCES`** (119-122行)：预加载 `index.js` 与 `client.js` 的视图数组（注意：存的是「视图数组」而非单份 `{lines,total}`，后续按基准逐版校验）。
- **`META_PATH` / `compiledCommit` / `freshnessCache` / `isFresh(rel)`** (127-149行)：`isFresh` 用 `git show <compiledCommit>:rel` 与工作区文件**逐字**比较判定源文件是否新鲜；`FORCE_STRICT` 时一律新鲜，`compiledCommit` 缺失时一律滞后（软报告）。
- **`clSectionsOf(src)` / `CL_VIEWS` / `CL_SECTIONS_OF_VIEW`** (157-167行)：解析 `CHANGELOG.md` 各 `## X.Y.Z` 版本节的行区间，供版本节语义校验（HEAD 版与工作区版章节行号不同）。
- **`check(cond, msg)` / `soft(msg)`** (172-180行)：`check` 成功 `passed++`、失败 `failures++`，返回 `cond` 以支持 `if (!check(...)) continue` 短路；`soft` 把「无法定性」项推入 `softReports`，不参与退出码。
- **`FILE_LIKE` / `symbolsOnLine(line)`** (186-202行)：用正则 `` /`([^`\n]+)`/g `` 提取行内反引号代码标识符，剔参数表、校验符号格式、排除长度<3 或尾段<3 的项，并排除文件名式写法（如 `package.json`、`watcher2.log`，避免稳定假阳性），返回 `{ sym, at }` 数组。
- **多锚点死代码说明** (204-211行，注释)：曾写过的「离锚点最近符号」启发式函数**已被删除**（未调用、且会系统性误报），多锚点行不再做符号绑定，由 `test-batch.mjs` 的 `fixAnchors` 对抗用例兜底。
- **`walk(dir)`** (213-222行)：递归收集目录下所有 `.md` 文章路径。
- **主校验循环** (224-277行)：
  - 收集 `.codewiki/` 下全部文章（224行），为空直接 `exit(1)`（225-228行）。
  - 逐行正则 `/([A-Za-z0-9_\-./]+\.(?:js|mjs|ts|md|json|yml|yaml|txt|log))[:：](\d+)(?!\.\d)(?:-(\d+))?/g`（241行）匹配**仓内所有文件类型**的锚点（已不再只认 `index.js`/`client.js`）；`(?!\.\d)` 防止把「版本号」误当行号。
  - 对每个锚点 `loadSource(srcName)` 取视图（250行），逐基准 `judgeAnchor` 校验，任一版通过即整体通过（258-263行）。
  - 失败分档（269-274行）：`kind==='struct'` 永远硬失败；`kind==='sync'` 且源文件滞后于编译基线 → 软报告；`kind==='changelog'` 或源文件为 `CHANGELOG.md` 的同步失败 → 一律软报告（追加式流水账导致历史锚点必然漂移）。
  - 末尾汇总 `锚点校验：X 过 / Y 败 / Z 待重编译`（402行），`process.exit(failures > 0 ? 1 : 0)`（403行）。
- **`describeOk(a, views)`** (280-288行)：通过时写明是哪个基准解释了这个锚点，避免「过了但不知道为什么」。
- **`judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })`** (293-394行)：在单个基准视图下判定锚点是否成立，返回 `{ ok, msg, kind }`（`kind ∈ {struct, sync, changelog}`）：
  - **struct 类**（293-309行）：起始行越界（`< 1` 或 `> total`）、单行锚点指向空行且区间内也无代码、区间 `start > end`（起止无序）、区间 `end > total`（终点越界）——与源码变动无关，永远硬失败。
  - **changelog 类**（321-334行）：仅当 `srcName === 'CHANGELOG.md'` 时，要求锚点落在行内左侧版本号所对应的 `## V` 版本节区间内；此判据永远软报告（发版会让上一批锚点失效）。
  - **sync 类·符号绑定**（358-392行）：仅当本行文件锚点数 `allFileAnchors.length === 1` 时校验；先用分句分隔符 `CLAUSE_SEP`（358-363行，`[。；;，,|\n]`）取锚点左侧分句内的符号，再在区间 `[start-1, end]`（或首行）内搜索该符号或其尾段。未命中时分两种：符号在文件中**完全不存在** → `kind='struct'`（铁证真错，硬失败）；符号存在但不在区间 → `kind='sync'`（可能漂移，滞后时软报告）。

## Architecture

测试套件分为两个互相独立的 Node.js 脚本，分别面向入口生成与锚点校验，共享 `process.exit(failures ? 1 : 0)` 的退出码机制；两者都不落盘日志，结果只经 stdout/stderr 打印。

```text
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ test-wiki-entry.mjs          │       │ test-wiki-anchors.mjs        │
│ (entry 侧黑盒验证)           │       │ (anchors 侧扫描校验)         │
├──────────────────────────────┤       ├──────────────────────────────┤
│ ensureWikiEntry 用例 (27-54) │       │ walk() 收集 .md (213-224)   │
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

1. `test-wiki-entry.mjs` 通过 `fs.mkdtempSync` 在 `os.tmpdir()` 下建立 `repo1`~`repo6` 沙箱目录（18-23行定义辅助函数，各用例调用建立子目录）。
2. 调用从 `./index.js` 导入的 `ensureWikiEntry` 等函数，操作沙箱内的 `CodeWiki.md` 与 `.codewiki/_index.md`。
3. 通过 `fs.readFileSync` 读取生成内容，用 `check()` 断言关键字符串（如 `.codewiki` 绝对路径、`codewiki_generate`、英文 `living wiki` 等）。
4. 最终 `fs.rmSync(tmp, { recursive: true, force: true })` 清理沙箱（74行），打印断言汇总并以退出码 `0` 或 `1` 结束（75-76行）。

### anchors 侧数据流

1. `test-wiki-anchors.mjs` 启动即同步通过 `loadSource` 预加载仓库根下 `index.js` 与 `client.js` 的视图数组存入 `SOURCES`（119-122行）。
2. `walk(WIKI)` 递归收集 `.codewiki/` 下所有 `.md` 文件（224行），若为空直接 `exit(1)`（225-228行）。
3. 逐行正则匹配 `index.js:NN` / `client.js:NN` 等仓内所有文件锚点（241行），结合 `symbolsOnLine` 提取的符号，对照 `SOURCES` 中对应源文件视图行内容进行校验。
4. 累计 `passed` 与 `failures`，输出 `锚点校验：X 过 / Y 败 / Z 待重编译` 并据此退出（402-403行）。

## Connections

- 被测核心逻辑来自 [[index]] 模块（`ensureWikiEntry`、`normalizeArticlePath`、`parseStatus`、`normalizeIndexLinks` 均从其导出）。
- 锚点校验直接读取并绑定 [[index]] 与 `client.js` 的源码行，是保障 [[codewiki-generation]] 产物准确性的守门员。
- 测试不落盘任何日志文件，结果只经 stdout/stderr 打印，由 [[ci-pipeline]] 直接捕获控制台输出作为合入门禁证据。

## Known Issues

1. **anchors 测试存在系统性符号绑定失败**
   测试脚本（`test-wiki-anchors.mjs`）不落盘日志，所有断言结果直接打印到 stdout/stderr（成功 `✓`、失败 `✗`）。根据源码注释（1-31行）与实现，测试将锚点分为结构事实与同步事实，符号绑定属于同步事实，按源文件新鲜度分档：源文件滞后于编译基线时降级为软报告（待重编译），而非硬失败。若曾出现符号绑定失败（如文章引用的行号虽有效但符号不匹配），会在控制台打印失败并累计 `failures`，由退出码反映。源码生成侧如需修复偏移，应参考 `index.js` 中 `fixAnchors` 的确定性校正逻辑，而非依赖测试脚本日志。
2. **单锚点限制导致多锚点行跳过符号绑定**
   在 `test-wiki-anchors.mjs` 第 204-211 行明确注释：当一行存在多个锚点时（如表格一行多列），无法可靠判断符号归属，强行绑定会误判，因此仅做“行号在范围内 + 指向非空行”的兜底，放弃符号绑定校验。
3. **`nearestSymbol` 就近绑定可能误绑**
   第 204-211 行注释说明：曾写过一个「取离锚点最近的符号」的启发式函数做符号绑定，但从未被调用（死代码），且接入后会系统性误报；多锚点行的价值由「行号在范围内 + 指向非空行」兜底，真正能钉住修错行为的是 `test-batch.mjs` 的 `fixAnchors` 对抗用例。当前测试策略限制“单行单锚点才校验符号绑定”（见 364 行 `if (allFileAnchors.length === 1)`），实际误判风险被控制。
4. **entry 测试依赖真实文件系统**
   `test-wiki-entry.mjs` 第 18 行使用 `fs.mkdtempSync` 依赖系统临时目录写入权限，在极简容器环境若 `os.tmpdir()` 不可写则可能抛错（尽管空 `cwd` 路径已通过第 49 行安全返回覆盖）。
