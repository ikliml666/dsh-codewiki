---
title: test_contract_change
type: module
source_files:
  - test-change-set.mjs
  - test-article-contract.mjs
  - lib/change-set.js
  - lib/article-contract.js
tags: [test, article-contract, change-set, validation, utilities]
---

## Overview

`test_contract_change` 不是一个单独的文件，而是由两篇独立的 Node ≥20 冒烟/集成测试脚本组成的**契约与基础工具测试套件**：

- `test-change-set.mjs`（P0-1，210 行）——钉死 `lib/change-set.js` 的 `collectChangeSet`「四路变更采集 + 降级语义」。
- `test-article-contract.mjs`（P0-4，239 行）——钉死 `lib/article-contract.js` 的 `inspectArticle`「文章契约闸门」。

两篇都是**独立脚本**（直接 `node test-change-set.mjs` / `node test-article-contract.mjs` 运行），不是 harness 测试。它们各自从被测模块直接 `import` 纯函数，用同款轻量 `check(label, fn)` 计数器（含 `pass`/`fails` 与结尾汇总，`test-change-set.mjs:13-18`、`test-article-contract.mjs:18-23`）断言行为，结尾按失败数设 `process.exitCode = 1`（`test-change-set.mjs:205-209`、`test-article-contract.mjs:234-238`）。

两篇测试的背景都来自审计确认的存量缺陷：

- **变更集漏检**（文件头注释见 `lib/change-set.js:1-13`）：旧 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是工作区未提交修改、暂存区、未跟踪新文件三类改动全隐形——「改完代码还没提交就编译」会把未消化变化当成已消化（基线前移），文章与源码脱节却一路绿。
- **文章闸门过松**（文件头注释见 `lib/article-contract.js:3-9`）：旧 `validateArticleEnvelope`（见 `test_batch.md` 的 `index.js:1153`）只查 frontmatter 开合，于是正文里又贴一份 frontmatter、`source_files` 指向不存在文件/越界路径、死链、代码围栏未闭合、必需章节为空等坏文章都进了仓库。

这两篇测试就是把上述两条缺陷「钉死」的回归护栏：前者保证「一次改动动了哪些文件必须一次拿全、采不全就退回全量」；后者保证「坏文章不能入库」。

## Key Components

两篇测试脚本都是「被测纯函数 + 场景化 `check` 断言」结构，没有导出任何公开 API（它们是终端脚本）。下面按「笔画工具 → 场景覆盖」列出每篇的结构与覆盖点；被测函数在 `lib/change-set.js` / `lib/article-contract.js` 里定义（详见 [[change_set]] 与文章契约模块）。

### test-change-set.mjs（P0-1）

**共享工具：**

- `check(label, fn)`（`test-change-set.mjs:15-18`）——异步断言计数器：成功 `pass++`，失败 push 进 `fails` 并打印 `FAIL`。
- `git(cwd, args)`（`test-change-set.mjs:20`）——薄封装 `execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] })`。
- `makeRepo()`（`test-change-set.mjs:23-42`）——每个场景建一个独立临时仓库：`git init` + 设置 `user.email/user.name/commit.gpgsign=false`，写入基线文件（`src/a.js`、`src/b.js`、`README.md`、`.codewiki/_meta.yaml`）后一次 `commit -qm base`，返回 `{ dir, base, write }`，`base` 为 `rev-parse HEAD`。
- `allPaths(cs)`（`test-change-set.mjs:44`）——取 `cs.all` 排序后的拷贝。
- `names(list)`（`test-change-set.mjs:45`）——把 bucket 条目（`{path}` 或字符串）映射成排序后的路径数组。

**场景覆盖（共 15 个 `check`，`test-change-set.mjs:47-203`）：**

| 场景（label） | 行号 | 钉死的行为 |
|---|---|---|
| 非 git 目录 → `state:'no-git'`、`ok:false`、`all:[]`、带 `reason` | `test-change-set.mjs:47-55` | 明确 no-git，不假装 clean |
| 缺 `baseCommit` → `state:'missing-base'`、`fallback:'full'` | `test-change-set.mjs:57-63` | |
| base 不可达 → `state:'unreachable-base'`、退回 `full`、reason 含短 sha | `test-change-set.mjs:65-72` | |
| 干净仓库（base==HEAD）→ `ok:true`、`all:[]` | `test-change-set.mjs:74-82` | |
| 仅 unstaged → 进 `all` 且归类 `unstaged` | `test-change-set.mjs:84-93` | |
| 仅 staged → 进 `all` 且归类 `staged`（不是 unstaged） | `test-change-set.mjs:95-103` | |
| untracked 新文件 → 进 `all` 且归类 `untracked` | `test-change-set.mjs:105-111` | |
| 删除文件 → 进 `deleted` 与 `all` | `test-change-set.mjs:113-119` | |
| 改名 → 记 `renamed`（from→to）、`all` 同时含两端 | `test-change-set.mjs:121-129` | |
| committed（`base..HEAD`）→ 进 `committed` 与 `all` | `test-change-set.mjs:131-139` | |
| 四路合并去重：同一文件既 committed 又 unstaged 时 `all` 只出现一次 | `test-change-set.mjs:141-150` | |
| `.codewiki/` 自身产物不计入 `sourceChanges`、`ignored` 记账 | `test-change-set.mjs:152-164` | README/CHANGELOG 仍算 source |
| 路径一律规范化为 POSIX（无反斜杠、无 `./` 前缀） | `test-change-set.mjs:166-175` | |
| 可注入 `execFile`（离线单测，不依赖真实 git） | `test-change-set.mjs:177-194` | 用假执行器喂 `rev-parse`/`cat-file`/`name-status`/`ls-files` |
| ChangeSet 可 `JSON.stringify/parse`（要写进 update-record） | `test-change-set.mjs:196-203` | 断言 `round.all === cs.all`、`round.version === cs.version` |

### test-article-contract.mjs（P0-4）

**共享工具：**

- `check(label, fn)`（`test-article-contract.mjs:20-23`）——同 `test-change-set.mjs` 的计数器。
- `GOOD(over = {})`（`test-article-contract.mjs:25-33`）——构造一篇合法文章字符串：默认 `title:Util Module`、`type:module`、`source_files:['src/util/strings.js']`、`tags:[util]`，正文含 `## Overview` 与 `## Key Components`。`over` 可覆盖 frontmatter 字段。
- `kinds(issues)`（`test-article-contract.mjs:34`）——把 `issues` 映射成 `kind` 数组。

**导入的被测纯函数**（`test-article-contract.mjs:12-16`，全部定义在 `lib/article-contract.js`）：`inspectArticle`、`parseFrontmatter`、`parseYamlLite`、`extractSections`、`fencesBalanced`、`collectWikiLinks`、`hasDuplicateFrontmatter`、`issueSummary`、`REQUIRED_SECTIONS`、`TYPE_BY_DIR`、`hasBlockingIssue`、`makeWriteSet`、`isWritable`、`normalizeWritePath`、`SEVERITY`。

**场景覆盖（共 25 个 `check`，`test-article-contract.mjs:36-232`）：**

| 场景（label） | 行号 | 钉死的行为 |
|---|---|---|
| 合格文章 → 无 issue | `test-article-contract.mjs:36-40` | `issueSummary === null` |
| 缺 frontmatter → `frontmatter-missing` | `test-article-contract.mjs:42-45` | |
| frontmatter 未闭合 → `frontmatter-unclosed` | `test-article-contract.mjs:47-51` | |
| 必填字段缺失（title/type/source_files）→ `missing-field` | `test-article-contract.mjs:53-58` | |
| type 与目录不匹配 → `type-mismatch` | `test-article-contract.mjs:60-63` | |
| 正文里又出现一份 frontmatter → `duplicate-frontmatter` + `duplicate-section` | `test-article-contract.mjs:65-70` | |
| 重复章节 → `duplicate-section` | `test-article-contract.mjs:72-75` | |
| 必需章节缺失 → `missing-section` | `test-article-contract.mjs:77-80` | |
| 必需章节是空的 → `empty-section` | `test-article-contract.mjs:82-86` | |
| 非必需章节空着 → `empty-section-optional`（warning、放行） | `test-article-contract.mjs:88-96` | `hasBlockingIssue === false` |
| 代码围栏未闭合 → `unclosed-fence` | `test-article-contract.mjs:98-101` | |
| `source_files` 指向目录/绝对路径/越界 → `bad-source` | `test-article-contract.mjs:103-108` | |
| `source_files` 指向不存在文件 → `missing-source`（注入 `fsImpl.exists`） | `test-article-contract.mjs:110-119` | |
| `source_files` 不在可读证据里 → `source-not-evidence` | `test-article-contract.mjs:121-126` | |
| 内部链接目标不存在 → `dead-link`（传 `allowedLinks`） | `test-article-contract.mjs:128-134` | |
| 空文章 → `empty` | `test-article-contract.mjs:136-139` | |
| frontmatter 有内容但正文空 → `empty-body` | `test-article-contract.mjs:141-144` | |
| `expectedType` 覆盖目录推断 → `type-mismatch` | `test-article-contract.mjs:146-149` | |
| `parseFrontmatter`：块列表/行内列表/引号值/CRLF | `test-article-contract.mjs:151-158` | |
| `parseYamlLite`：注释行与空行不影响解析 | `test-article-contract.mjs:160-164` | |
| `extractSections`：围栏内的 `##` 不算章节 | `test-article-contract.mjs:166-170` | |
| `fencesBalanced`：成对/单数 | `test-article-contract.mjs:172-175` | |
| `collectWikiLinks`：`[[名]]` 与 markdown 相对链接都收，外链不收 | `test-article-contract.mjs:177-182` | |
| `hasDuplicateFrontmatter`：单份正文不误报 | `test-article-contract.mjs:184-187` | |
| 必需章节表按类型配置（concept 不要求 Key Components） | `test-article-contract.mjs:189-194` | 断言 `TYPE_BY_DIR.modules==='module'`、`learnings==='learning'` |
| `_index.md` 这类 cw 自产索引缺 frontmatter 会被识别 | `test-article-contract.mjs:196-201` | |
| `issueSummary` 汇总条数与首因 | `test-article-contract.mjs:203-208` | |
| 分级：结构破坏是 error（拒写），章节缺失是 warning（放行降 partial） | `test-article-contract.mjs:210-218` | 验证 `hasBlockingIssue` 边界 |
| 写集闸门：允许自身目标、拒绝越界（agentic `allowedWritePaths`） | `test-article-contract.mjs:220-232` | 覆盖绝对路径/`../`/cwd 归一互通 |

## Architecture

两篇测试都是「独立脚本 + 注入执行器/纯函数」的扁平结构，没有模块间依赖。下面是各自的「输入构造 → 调用被测纯函数 → `check` 断言」流程框图。

```text
test-change-set.mjs (P0-1)                     test-article-contract.mjs (P0-4)
  │ import collectChangeSet                      │ import inspectArticle + 工具函数
  ▼                                              ▼
makeRepo() ──► 真实临时 git 仓库          GOOD(over) ──► 合法文章字符串
git()/git init/commit                              │
  │                                                │ 可选注入: cwd/fsImpl/readableSources
  ▼                                                │           /allowedLinks/expectedType
collectChangeSet(cwd, base, {execFile})   ────────┼──► inspectArticle(content, opts)
  │  lib/change-set.js:102                          │     lib/article-contract.js:213
  │  • 缺 base   → missing-base                     │ 返回 issues[] (kind/severity/detail)
  │  • 非 git    → no-git                           ▼
  │  • 不可达    → unreachable-base           kinds()/issueSummary()/hasBlockingIssue()
  │  • 四路采集 + 去重 + 分离 wiki 产物             │
  ▼                                                ▼
ChangeSet {ok,state,all,committed,            check(label,fn) 计数器
           staged,unstaged,untracked,         pass++ / fails.push
           deleted,renamed,sourceChanges}    └─► 末尾 process.exitCode=1
  │
  ▼
check(label,fn) 计数器
pass++ / fails.push
  └─► 末尾 process.exitCode=1
```

两条护栏的被测函数本身都是纯函数（`collectChangeSet` 仅通过注入的 `execFile` 触 I/O，`inspectArticle` 完全不碰文件系统除非显式传 `fsImpl`/`cwd`），因此两篇测试都可在无网络、无真实 git 环境下单跑——`test-change-set.mjs:177-194` 用假 `execFile` 注入器即可离线验证四路采集语义。

## Data Flow

两篇测试都是「构造输入 → 调纯函数 → 断言」的单向数据流，不涉及跨模块运行时串联；但每个断言都对应着生产链路里的一条真实缺陷修复。

### test-change-set.mjs 的数据流

1. `makeRepo()`（`test-change-set.mjs:23-42`）在每个 `check` 里建一个隔离临时仓库并收 `base` 基线 commit。
2. 针对该仓库做「某种改动」（unstaged 写文件 / `git add` / `ls-files` 新文件 / `git rm` / `git mv` / `git commit`）或故意喂非法输入（非 git 目录、空 `baseCommit`、虚假 40 个 `0` 的 sha）。
3. 调 `collectChangeSet(dir, base)`（或带 `execFile` 注入），拿到 `ChangeSet`。
4. `check` 断言 `cs.ok`/`cs.state`/`cs.fallback`/`cs.reason` 以及 `all`/`committed`/`staged`/`unstaged`/`untracked`/`deleted`/`renamed`/`sourceChanges`/`ignored` 的精确内容（`allPaths`/`names` 做排序比对，`test-change-set.mjs:44-45`）。
5. 关键回归点：脏改动必须进 `all`（不漏检）、采不全必须 `fallback:'full'`、`.codewiki/` 产物必须落 `ignored` 而 README 仍算 source、ChangeSet 必须可 `JSON` 序列化（写进 `update-record.json`，见 [[update_record]]）。

### test-article-contract.mjs 的数据流

1. `GOOD(over)`（`test-article-contract.mjs:25-33`）造一篇合格文章；各 `check` 通过 `.replace()` 注入缺陷（删 frontmatter、删章节、重复 frontmatter、空章节、坏 source、死链等）。
2. 调 `inspectArticle(text, opts)`，可选注入 `cwd`+`fsImpl.exists`（`test-article-contract.mjs:114`）、`readableSources`（`121-126`）、`allowedLinks`（`128-134`）、`expectedType`（`146-149`）。
3. 用 `kinds(issues)` 取 `kind` 列表断言特定问题被识别；用 `issueSummary` 断言汇总文案（`203-208`）；用 `hasBlockingIssue` 断言 error/warning 分级边界（`210-218`）。
4. 写集闸门单独走 `makeWriteSet` + `isWritable`（`220-232`）：验证允许自身目标、拒绝越界（`../`、`/abs`）、相对路径以 `cwd` 归一后与绝对路径互通。
5. 关键回归点：这些 `kind` 对应审计里那些「进了仓库的坏文章」（`concepts/wiki-generation-flow.md` 第 64 行重贴 frontmatter、`modules/client-interface.md` 第 227 行重复整篇、`learnings/update-reminder-entry-gap.md` 未闭合 frontmatter、`.tmp-test-*.log` 等不存在 source），现在会被 `inspectArticle` 拦下。

## Connections

- [[change_set]] — `test-change-set.mjs` 的被测模块，定义 `collectChangeSet`/`parseNameStatus`/`normChangePath`/`isWikiProduct`/`CHANGE_SET_VERSION`。本测试直接覆盖了该模块的全部公开 API 与其降级语义。
- 文章契约模块（`lib/article-contract.js`）— `test-article-contract.mjs` 的被测模块，定义 `inspectArticle`/`parseFrontmatter`/`parseYamlLite`/`extractSections`/`fencesBalanced`/`collectWikiLinks`/`hasDuplicateFrontmatter`/`issueSummary`/`hasBlockingIssue`/`makeWriteSet`/`isWritable`/`normalizeWritePath`/`SEVERITY`/`REQUIRED_SECTIONS`/`TYPE_BY_DIR`。
- [[update_planner]] / [[update_record]] — 消费 `collectChangeSet` 产出的 `ChangeSet`：`planUpdate` 把 `sourceChanges`/`deleted`/`renamed`/`untracked`/`all` 折算成判定输入，`buildUpdateRecord` 把 ChangeSet 写进 `update-record.json`（这正是 `test-change-set.mjs:196-203` 钉死 JSON 可序列化的原因）。
- `index.js` 的 `applyTaskResult`/`writeValidated`（见 [[test_batch]] 的 `index.js:2601`/`index.js:624`）——生产落盘闸门调用 `inspectArticle` 决定拒写还是降 partial，本测试钉死其判据。
- [[test_batch]] — 同属契约/闸门测试套件，覆盖旧 `validateArticleEnvelope`（`index.js:1153`）与本测试的新 `inspectArticle` 形成「新旧闸门」对照。
- [[test_core]] — 通用测试基础设施；本篇两脚本沿用其中的 `check(label,fn)` 计数器范式（`test_core.md:30` 记录了 `test-article-contract.mjs:20-23` 的同源实现）。

## Known Issues

- **两篇测试都是独立脚本而非 harness 测试**：直接 `node test-*.mjs` 运行，结尾靠 `process.exitCode = 1`（`test-change-set.mjs:17`、`test-article-contract.mjs:22`）标记失败——没有统一的 tap/jest 报告，失败场景需要人工看 `FAIL` 行（`test-change-set.mjs:17`、`test-article-contract.mjs:22`）。
- **`test-change-set.mjs` 的「改名」场景不验证 bucket 字段**：`test-change-set.mjs:121-129` 只断言 `renamed[0].from`/`renamed[0].path`，没有断言 `renamed[0].bucket`（来自 `lib/change-set.js:173`），`renamed` 的真实来源桶未被覆盖。
- **`test-change-set.mjs` 的 `copied` 分支未覆盖**：`parseNameStatus`（`lib/change-set.js:59-64`）支持 `C` 前缀（记 `copied`），但测试只喂了 `M`（`test-change-set.mjs:184`），`copied` kind 没有断言。
- **`test-article-contract.mjs` 未覆盖 `allowEmptySourceFiles` 与 `requiredSections` 注入分支**：`inspectArticle`（`lib/article-contract.js:224-231`）对原生 FSoft 通道开放了 `allowEmptySourceFiles` 与 `requiredSections` 覆盖，但本测试全走默认 `REQUIRED_SECTIONS`，这两支放行逻辑无断言。
- **`test-article-contract.mjs` 的 `tags` 缺失分支无独立断言**：`inspectArticle`（`lib/article-contract.js:260-262`）对缺 `tags` 字段单独 push `missing-field`，但测试只通过 `GOOD()` 自带 `tags:[util]` 间接覆盖，未专门构造缺 `tags` 的文章去验证该分支。
- **`test-article-contract.mjs` 的 `ROOT_TYPES` 推断未测**：`inspectArticle`（`lib/article-contract.js:213`）对 `_architecture.md`/`_index.md`/`_patterns.md` 走 `ROOT_TYPES` 推断，但测试只覆盖了 `modules`/`concepts`/`learnings` 三类目录（`test-article-contract.mjs:60-63,189-201`），根目录特殊文章的 type 匹配无断言。
- **`allowedLinks` 的死链判定只覆盖 `[[...]]` 与 `.md` 相对链接**：`test-article-contract.mjs:128-134` 验证了 `dead-link` 与放行，但没验证「带锚点的 markdown 链接 `#`」（见 `lib/article-contract.js:171` 的 `#[^)\s]*` 截断）与「同目录朴素链接」这两支 candidate 拼接路径（`lib/article-contract.js:328`）。
