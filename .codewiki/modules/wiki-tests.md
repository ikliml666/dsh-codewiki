---
title: wiki-tests
type: module
source_files:
  - test-wiki-entry.mjs
  - .tmp-test-wiki-entry.log
  - test-wiki-anchors.mjs
  - .tmp-test-wiki-anchors.log
tags: [测试, wiki, 锚点, 入口, 质量保障]
---

## Overview

`wiki-tests` 模块是 CodeWiki 项目的自动化测试套件，围绕 Wiki 能力的两个独立测试面进行验证：

1. **entry 侧**（`test-wiki-entry.mjs`）：验证 `CodeWiki.md` 入口文件的自动生成与写入、已有入口不覆盖策略、中英双语文案、空 `cwd` 安全返回，以及 Windows 路径规范化（`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks`）。
2. **anchors 侧**（`test-wiki-anchors.mjs`）：验证 `.codewiki/` 下生成的文章中的行号锚点（如 `index.js:1774`）是否指向真实存在的源码行，并且锚点附近的反引号代码标识符（如 `createJobService`）是否确实出现在对应源码行/区间内，从而制度化拦截 LLM 幻觉锚点。

每个脚本执行时都会生成一份同名的临时日志（`.tmp-test-wiki-entry.log` 和 `.tmp-test-wiki-anchors.log`）作为执行证据。

## Key Components

### `test-wiki-entry.mjs` 测试组件

- **`check(cond, msg)`** (13-16行)：断言辅助函数，成功打印 `✓` 并累加 `failures`；失败打印 `✗` 并 `failures += 1`。
- **`tmp` / `repo(name)`** (18-23行)：在系统临时目录通过 `fs.mkdtempSync` 创建前缀为 `dsh-codewiki-entry-` 的隔离测试仓库目录。
- **`ensureWikiEntry(repo, lang)` 调用与断言** (26-54行)：
  - 缺失时生成（27-32行）：验证返回 `true`，生成的 `CodeWiki.md` 包含 `.codewiki` 绝对路径、`codewiki_generate` 收尾工具名、`_architecture.md` 架构指引及不覆盖人工入口声明。
  - 已有入口不覆盖（35-39行）：预写 `# My custom entry`，验证返回 `false` 且文件内容未被覆盖。
  - 英文语言分支（42-46行）：传入 `'English'`，验证生成文件使用英文文案（含 `living wiki`）。
  - 空 `cwd` 安全（49行）：传入 `''` 返回 `false` 不抛错。
  - 重复调用幂等（52-54行）：第二次调用返回 `false` 且文件内容不变。
- **Windows 路径规范化调用与断言** (56-72行)：
  - `normalizeArticlePath`（57-59行）：`\` 转 `/`，正斜杠原样保留，`undefined` 安全返回空串。
  - `parseStatus`（60-62行）：解析 `Changed since last compile` 与 `Stale articles:` 列表，`\` 规范化为 `/`。
  - `normalizeIndexLinks`（63-72行）：修正 `.codewiki/_index.md` 中 `[[modules\core|core]]` 的反斜杠，但保留正文 `E:\ik\repo` 反斜杠；幂等且缺失文件静默返回 `false`。

### `test-wiki-anchors.mjs` 测试组件

- **`ROOT` / `WIKI` / `SOURCES`** (14-24行)：基于 `fileURLToPath(import.meta.url)` 定位仓库根，同步读取 `index.js` 与 `client.js` 的全部行存入 `SOURCES` 对象（`{ lines: string[], total: number }`）供后续对照。
- **`check(cond, msg)`** (28-32行)：断言函数，返回 `cond` 以支持 `if (!check(...)) continue` 短路跳过后续检查。
- **`symbolsOnLine(line)`** (38-49行)：用正则 `/`([^`\n]+)`/g` 提取行内反引号代码标识符，剔除参数表，校验符号格式（`/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/`），排除长度小于 3 或尾段小于 3 的非符号，返回 `{ sym, at }` 数组。
- **`nearestSymbol(syms, anchorIndex, anchorLen)`** (52-62行)：计算离锚点中点最近的代码符号，同距优先取左侧（因中文行文多为「符号（`file:NN`）」）。
- **`walk(dir)`** (64-73行)：递归收集目录下所有 `.md` 文章路径。
- **主校验循环** (82-115行)：
  - 提取行内 `(?:index|client)\.js[:：](\d+)(?:-(\d+))?` 锚点（86行）。
  - 基础断言：起始行在 `1..total` 范围内（95行），指向非空代码行（96行）。
  - 区间断言：若存在 `MMM`，验证 `NNN ≤ MMM` 且 `MMM ≤ total`（97-100行）。
  - 符号绑定断言：仅当本行锚点数为 1 时（105行），在区间 `src.lines.slice(start-1, end)` 内搜索符号或其尾段（106-111行）。

## Architecture

测试套件分为两个互相独立的 Node.js 脚本，分别面向入口生成与锚点校验，共享相同的断言退出码机制（`process.exit(failures ? 1 : 0)`）。

```text
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ test-wiki-entry.mjs          │       │ test-wiki-anchors.mjs        │
│ (entry 侧验证)               │       │ (anchors 侧验证)             │
├──────────────────────────────┤       ├──────────────────────────────┤
│ ensureWikiEntry 用例 (27-54) │       │ walk() 收集 .md (64-75)      │
│ normalizeArticlePath (57-59) │       │ symbolsOnLine (38-49)        │
│ parseStatus (60-62)          │       │ nearestSymbol (52-62)        │
│ normalizeIndexLinks (63-72)  │       │ 主循环校验区间/符号 (82-115) │
└───────────┬──────────────────┘       └───────────┬──────────────────┘
            │ 导入并验证                            │ 读取并验证
            ▼                                      ▼
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ ./index.js 出口函数           │       │ index.js / client.js 源码行   │
│ (ensureWikiEntry 等)         │       │ (真实行号与内容对照)         │
└──────────────────────────────┘       └──────────────────────────────┘
            │                                      │
            └─────────────► 临时日志证据 ◄──────────┘
                 (.tmp-test-wiki-entry.log /     
                  .tmp-test-wiki-anchors.log)     
```

## Data Flow

### entry 侧数据流

1. `test-wiki-entry.mjs` 通过 `fs.mkdtempSync` 在 `os.tmpdir()` 下建立 `repo1`~`repo6` 沙箱目录（18-23行）。
2. 调用从 `./index.js` 导入的 `ensureWikiEntry` 等函数，操作沙箱内的 `CodeWiki.md` 与 `.codewiki/_index.md`。
3. 通过 `fs.readFileSync` 读取生成内容，用 `check()` 断言关键字符串（如 `.codewiki` 绝对路径、`codewiki_generate`、英文 `living wiki` 等）。
4. 最终 `fs.rmSync(tmp, { recursive: true, force: true })` 清理沙箱（74行），打印断言汇总并以退出码 `0` 或 `1` 结束（75-76行）。

### anchors 侧数据流

1. `test-wiki-anchors.mjs` 启动即同步读取仓库根下 `index.js` 与 `client.js` 的全部行存入 `SOURCES`（20-24行）。
2. `walk(WIKI)` 递归收集 `.codewiki/` 下所有 `.md` 文件（75行），若为空直接 `exit(1)`（76-79行）。
3. 逐行正则匹配 `index.js:NN` / `client.js:NN` 锚点，结合 `symbolsOnLine` 提取的符号，对照 `SOURCES` 中对应源文件行内容进行校验。
4. 累计 `passed` 与 `failures`，输出 `锚点校验：X 过 / Y 败` 并据此退出（117-118行）。

## Connections

- 被测核心逻辑来自 [[index]] 模块（`ensureWikiEntry`、`normalizeArticlePath`、`parseStatus`、`normalizeIndexLinks` 均从其导出）。
- 锚点校验直接读取并绑定 [[index]] 与 `client.js` 的源码行，是保障 [[codewiki-generation]] 产物准确性的守门员。
- 临时日志（`.tmp-test-wiki-entry.log`、`.tmp-test-wiki-anchors.log`）为 [[ci-pipeline]] 提供合入门禁证据。

## Known Issues

1. **anchors 测试存在系统性符号绑定失败**
   根据 `.tmp-test-wiki-anchors.log` 的执行记录（第 4、7、10、13、16、19、22、25 等行），大量 `符号绑定` 断言失败（总计 122 过 / 36 败）。失败集中在 `cw-binary-source-lost.md` 与 `update-reminder-entry-gap.md` 等文章，表明生成文章引用的行号（如 `index.js:199`、`index.js:199`）虽然落在文件行数内且非空，但对应行并未包含行内反引号标注的符号（如 `normalizeArticlePath`、`parseStatus`）。这说明流水线产物仍存在锚点与符号不匹配的幻觉，测试已成功将其拦截，但源码生成侧（见 `test-wiki-anchors.mjs` 第 1-8 行注释）仍需修复偏移问题。
2. **单锚点限制导致多锚点行跳过符号绑定**
   在 `test-wiki-anchors.mjs` 第 101-103 行明确注释：当一行存在多个锚点时（如表格一行多列），无法可靠判断符号归属，强行绑定会误判，因此仅做“行号在范围内 + 指向非空行”的兜底，放弃符号绑定校验。
3. **`nearestSymbol` 就近绑定可能误绑**
   第 51-62 行实现的最近符号查找，在一句话并列引用多个符号时仅取最近者（或左侧者），可能未精确绑定到作者意图的符号，但因测试策略已限制“单行单锚点才校验”（105行），实际误判风险被控制。
4. **entry 测试依赖真实文件系统**
   `test-wiki-entry.mjs` 第 18 行使用 `fs.mkdtempSync` 依赖系统临时目录写入权限，在极简容器环境若 `os.tmpdir()` 不可写则可能抛错（尽管空 `cwd` 路径已通过第 49 行安全返回覆盖）。