---
title: test_engine_apply
type: module
source_files:
  - test-engine-apply-plan.mjs
  - test-engine-output.mjs
  - test-engine-process-tree.mjs
  - lib/engine/apply-plan.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
tags: [test, engine, apply-plan, output, process-tree, quality-gate]
---

## Overview

本模块是引擎三个子能力的**测试套件集合**，本身不含任何生产代码，由三个独立 `.mjs` 顶测文件组成，分别对应 [[test_engine_apply]] 上游的三段逻辑：

- `test-engine-apply-plan.mjs` — 测试 `lib/engine/apply-plan.js`（阶段 3 落地器：原子应用 → `cw index` → 基线 → 自动提交），验收三条硬不变量：**写集封闭 / 索引基线失败回滚 / 提交失败不回滚**。
- `test-engine-output.mjs` — 测试 `lib/engine/output.js`（阶段 2 FSoft 产物解析/校验）：判「引擎交回来的东西能不能用」（缺页、空壳页、死链、`source_files` 编造）。
- `test-engine-process-tree.mjs` — 测试 `lib/engine/process-tree.js`（受管子进程树终止）：验证取消必须打穿进程树，不留下孤儿孙进程。

三个测试文件共享同一套极简测试框架（局部 `check`/`checkAsync` 包裹 `assert` 计数），**全部用临时目录 + 注入桩**，不碰真实仓库、不跑真 `cw`：验收对象是**不变量**而非 `cw` 自身行为（apply-plan 的备注见 `test-engine-apply-plan.mjs:39-44`）。process-tree 测试是唯一的例外——它用**真实子进程/孙进程**起两层进程树（`test-engine-process-tree.mjs:22-33`），因为 kill 只打到根、孙进程变孤儿的 bug 只有在真实进程树里才会出现，mock 的 `process.kill` 永远是对的。

`apply-plan` 测试里唯一的真实 git 路径是 `verifyCommitScope`（`test-engine-apply-plan.mjs:599-601` 与 `:613-648`）：它判「提交里到底有什么」，桩不出真值，所以必须起真 git 仓库（`gitRepo()` 定义在 `test-engine-apply-plan.mjs:601-611`）。

## Key Components

下面是三个测试文件各自覆盖的公开函数/常量，以及测试对它们的断言要点（行号指向源码/测试）。

### A. `test-engine-apply-plan.mjs` → `lib/engine/apply-plan.js`

被导入的符号（`test-engine-apply-plan.mjs:14-25`）：

| 导出符号 | 源码位置 | 用途 | 测试断言要点 |
|---|---|---|---|
| `APPLY_STAGES` | `lib/engine/apply-plan.js:49` | 落地阶段顺序 `['write','index','baseline','commit']` | `test-engine-apply-plan.mjs:139-141` 断言顺序即推进顺序 |
| `APPLY_PROBLEM_KINDS` | `lib/engine/apply-plan.js:52-59` | 写集校验问题类别（6 个：empty/absolute/escaping/out-of-scope/duplicate/bad-content） | `test-engine-apply-plan.mjs:157-171` 断言覆盖 `checkWriteTargets` 全部输出类别 |
| `APPLY_RESULT_KINDS` | `lib/engine/apply-plan.js:62-73` | 落地结果问题类别（8 个：write/index/baseline/commit-failed/commit-scope/not-writable/wiki-missing/gate-partial） | `test-engine-apply-plan.mjs:147-155` 断言每个都能翻成契约 `BLOCKER_KINDS` |
| `APPLY_WRITE_ROOTS` | `lib/engine/apply-plan.js:46` | 写集白名单 `[WIKI_DIR, WIKI_ENTRY]` | `test-engine-apply-plan.mjs:143-145` 断言只含 `.codewiki` 与 `CodeWiki.md` |
| `applyNativeOutput` | `lib/engine/apply-plan.js:414-725` | 落地主函数（写盘→index→基线→提交） | 第 3–6 节的全部异步用例（`:221-582`） |
| `checkWriteTargets` | `lib/engine/apply-plan.js:86-131` | 写集纯函数校验（不碰磁盘） | 第 2 节（`:177-215`） |
| `toApplyBlockers` | `lib/engine/apply-plan.js:309-320` | 落地问题 → 契约 `BLOCKER_KINDS` | `test-engine-apply-plan.mjs:147-155` 断言每个 blocker 的 kind 落在 `BLOCKER_KINDS` 且 detail 带 `[` 原类别前缀 |
| `verifyCommitScope` | `lib/engine/apply-plan.js:224-237` | 校验提交只动 wiki 产物（真 git） | 第 7 节（`:613-648`） |

辅助常量：`APPLY_VERSION`（`lib/engine/apply-plan.js:43`）。源码内未导出的关键内部函数（被测试间接触发）：`capturePre`/`restorePre`（`:138-176` 回滚快照）、`writeAll`（`:178-187`）、`defaultRunCw`（`:191-201`）、`defaultVerifyCommit`（`:203-210`）、`commitWikiArtifacts`（`:250-295` 内置提交器）、`findArticlesMissingFromIndex`（`:338-359` 缺页探测）、`normalizeIndexLinksIn`（`:376-390` 索引链接 `\`→`/` 规范化）、`entryBody`（`:395-398` 剥 frontmatter）。

`applyNativeOutput` 返回的 `ApplyResult` 关键字段（`lib/engine/apply-plan.js:412-428` 的 `base`，并在 `done()` `:450-460` 补全）：`version`、`startedAt`、`repoRoot`、`applied`、`outcome`、`written`、`entry`、`index`、`baseline`、`commit`、`rolledBack`、`problems`、`blockers`、`notes`、`canAdvanceBaseline`、`finishedAt`。`done()` 的硬规则（`:453-457`）：终态若本应 `done` 却带 blockers 则降级 `partial`；`ok` 当且仅当 `outcome==='done'`；`canAdvanceBaseline` 要求 `applied && baseline.advanced && 无 problems`。

`deps` 注入契约（`lib/engine/apply-plan.js:411、532-537`）：`runCw`/`commit`/`normalizeIndexLinks`/`verifyCommit`/`cwBinary`/`jobId` 全部可选；未注入 `commit` 时回落到内置 `commitWikiArtifacts`（`:536`），**绝非「不注入就不提交」**——这正是 `test-engine-apply-plan.mjs:379-389` 与 `:571-596` 要钉死的边界。

`verifyCommitScope` 的 `o` 参数（`lib/engine/apply-plan.js:221-224`）：`{ allowExtra?:string[], files?:string[] }`。`files` 可直接传入省一次 git（`test-engine-apply-plan.mjs:637-642`），`allowExtra` 里的路径不算越界（`:644-648`）。

### B. `test-engine-output.mjs` → `lib/engine/output.js`

被导入的符号（`test-engine-output.mjs:12-19`）：

| 导出符号 | 源码位置 | 用途 | 测试断言要点 |
|---|---|---|---|
| `OUTPUT_PROBLEM_KINDS` | `lib/engine/output.js:22-34` | 11 个可报问题类别 | `test-engine-output.mjs:214-217` 断言未登记 kind 会被拒 |
| `bodyLength` | `lib/engine/output.js:127-137` | 去标题后正文字符数 | `:65-70` 只有标题算空壳（返回 0），带正文算非空 |
| `relativeLinks` | `lib/engine/output.js:140-152` | 抽相对 md 链接，跳过外链/锚点/data URI | `:72-77` 断言抽 `[a](A.md)` + `../src/x.py`，跳过 `https`/`#anchor`/`data:` |
| `collectOutput` | `lib/engine/output.js:91-124` | 读 docs 目录成结构化事实 | `:79-119` 正常无 problem；缺目录/缺 metadata/坏 json 分别报 |
| `buildWritePlan` | `lib/engine/output.js:162-173` | docs→mapping.js 建写集 | `:219-227` `componentFiles` 作为 source_files 证据被采用 |
| `validateOutput` | `lib/engine/output.js:184-282` | 自洽性校验，返回 `{ok,problems,mapped,collected,stats}` | `:121-212` 各类 problem 路径 |

`validateOutput` 报出的问题类别（`lib/engine/output.js:187-265`）：入口缺失 `entry-missing`（`:197`）、空模块树 `empty-module-tree`（`:204-207`）、空壳页 `empty-body`（`:224`）、未映射页 `unmapped-page`（`:228`）、模块树有页没产 `article-missing`（`:231-233`）、`source_files` 不存在 `source-missing`（`:236-248`，需 `repoRoot`）、死链 `dead-link`（`:252-265`）。`update_record.json` 缺不算问题（`:108-113`，全量首轮本来没有），但其存在却坏掉仍报 `bad-json`（`:115-119`）。

`collectOutput` 返回的 `json` 四件套（`lib/engine/output.js:98`）：`metadata` / `moduleTree` / `firstModuleTree` / `updateRecord`，外加 `docsDir`、`exists`、`pages`、`problems`。`stats`（`:275-280`）：`pages`/`articles`/`unmapped`/`problems`。

### C. `test-engine-process-tree.mjs` → `lib/engine/process-tree.js`

被导入的符号（`test-engine-process-tree.mjs:18`）：`isAlive`、`terminateProcessTree`。

| 导出符号 | 源码位置 | 用途 | 测试断言要点 |
|---|---|---|---|
| `isAlive` | `lib/engine/process-tree.js:41-49` | `process.kill(pid,0)` 探测存活 | `test-engine-process-tree.mjs:57-67` 已退出/不存在/0/负数/undefined 均返回 false |
| `terminateProcessTree` | `lib/engine/process-tree.js:61-103` | 终止受管进程树 | `:69-128` 非法 pid noop、根死后孙进程也死、幂等、onLog 不含凭证 |

`terminateProcessTree` 返回 `{ ok, rootAlive, method }`（`:58-59`）。`method` 取值来自代码：合法非法 pid → `'noop'`（`:66`）、已退出 → `'already-exited'`（`:69`）、Windows `taskkill`（`:79`）、POSIX SIGTERM 成功 → `'sigterm'`（`:92`）、超时后 SIGKILL → `'sigkill'`（`:102`）。`options`（`lib/engine/process-tree.js:55-57`）：`graceMs`（默认 3000）与 `onLog`。平台分支由 `IS_WINDOWS`（`lib/engine/process-tree.js:18`）决定，POSIX 走 `process.kill(-pid,...)` 进程组（`:85`、`:96`）。

## Architecture

三套测试各自独立，但都围绕同一句设计哲学：**用临时目录 + 注入桩锁定不变量，而不是重放真实引擎**。它们通过 `lib/engine/*` 的生产模块间接相连，构成一个「读产物 → 校验 → 落地 → 取消」的引擎侧测试环：

```text
                 ┌──────────────────────────── test-engine-output.mjs ─────────────────────────┐
                 │  collectOutput / validateOutput / buildWritePlan  (lib/engine/output.js)     │
                 └───────────────┬──────────────────────────────────────────────────────────────┘
                                 │ 校验「产物自洽」→ rendered / entry（阶段 2）
                                 ▼
                 ┌──────────────────────────── test-engine-apply-plan.mjs ─────────────────────┐
                 │  applyNativeOutput (lib/engine/apply-plan.js)                                 │
                 │   checkWriteTargets → writeAll → runCw(index) → meta update → commit          │
                 │   不变量: 写集封闭 / 索引基线失败回滚 / 提交失败不回滚                         │
                 └───────────────┬──────────────────────────────────────────────────────────────┘
                                 │ 同语义依赖（被钉死边界）
        ┌────────────────────────┼───────────────────────────────────────────┐
        ▼                        ▼                                            ▼
 lib/engine/mapping.js    lib/engine/contract.js                     test-engine-process-tree.mjs
 (WIKI_DIR/ENTRY/         (BLOCKER_KINDS, apply-problem→blocker      (lib/engine/process-tree.js)
  META_REL 常量)           映射在 toApplyBlockers)                   isAlive / terminateProcessTree
                                                                     （取消打穿进程树）
```

被测源码的共同依赖：`output.js` 调用 `mapping.js` 的 `mapFsoftOutput`（`lib/engine/output.js:19`、`buildWritePlan:164`）；`apply-plan.js` 依赖 `mapping.js` 的 `WIKI_DIR/WIKI_ENTRY/WIKI_META_REL`（`lib/engine/apply-plan.js:39`）与 `contract.js` 的 `BLOCKER_KINDS`（`lib/engine/apply-plan.js:40`、`toApplyBlockers:309-313`）；`process-tree.js` 不依赖其它引擎模块（`:16` 只 import `node:child_process`），是 client.js 取消路径的地基。

## Data Flow

### apply-plan 测试数据流（`test-engine-apply-plan.mjs`）

测试通过一个 `recordingDeps` 桩（`test-engine-apply-plan.mjs:104-133`）注入被调方，桩的 `runCw` 会按命令模拟 `cw init/index/meta` 的真实副作用（建 `.codewiki/modules`、写 `_index.md`/`_meta.yaml`），`failOn` 控制某条命令返回 exitCode 7。生产调用链是：

1. 构造 `report`（`makeReport` `:68-87`，两篇页 + 入口 + `writable/canAdvanceBaseline/outcome`）、`docs`（`makeDocs` `:90-96` 放 `overview.md`/`core.md`）、`root`（`makeRepo` `:50-54`）。
2. 调 `applyNativeOutput({ repoRoot, report, docsDir, deps, dryRun?, entryMode? })`。
3. 断言结果：正常路径（`:221-236`）要求 `outcome==='done'`、`applied===true`、四文件落盘、`seq(calls)===['index','meta update']`、`commit.scope.ok`。
4. 不变量分支：
   - **写集封闭**（`:283-299`）：越界 `wikiPath` 整批拒，不跑 `cw`，合法页也不写。
   - **索引失败回滚**（`:305-323`）：`failOn:'index'` → `rolledBack`、`_meta.yaml` 不动、新 `CodeWiki.md` 删掉、旧 `core.md` 原样复原。
   - **基线失败回滚**（`:325-338`）：`failOn:'meta'` → 文章与索引都撤回，`_meta.yaml` 复原。
   - **提交失败不回滚**（`:357-401`）：`commit` 失败 → `outcome==='partial'`、`rolledBack===false`、文章保留、`commit-failed` blocker；`noChanges` 不算失败（`:370-377`）；混进 wiki 外路径 → `commit-scope` 且不回滚（`:391-401`）。
   - **入口策略**（`:407-438`）：`entryMode='keep'` 保留人工入口（action `keep`），`overwrite` 覆盖，`entryMode` 默认 `keep`。
   - **partial 不洗成 done**（`:445-482`）：`outcome!=='done' && writable=true` 照写但终态保持 `partial`、基线不推进、记 `gate-partial`。
   - **索引规范化**（`:484-519`）：`\`→`/` 被改；缺页不报错（空库无索引）。
   - **规范化/缺页失败回滚**（`:521-569`）：`normalizeIndexLinks` 抛错或 index 退出 0 却缺页 → `index-failed` 整批回滚。
   - **零注入**（`:571-596`）：只给 `runCw` 时回落内置提交器；真 git 仓库下能真正提交且 `scope.ok`。

`verifyCommitScope` 真 git 路径（`:613-648`）：`gitRepo()`（`:601-611`）起真仓库并首提交，构造只含 wiki 的提交判 `ok`，混 `src/app.js` 判失败并列出越界文件，`files`/`allowExtra` 各减一次 git。

### output 测试数据流（`test-engine-output.mjs`）

`makeDocs(name, overrides)`（`:31-56`）在临时目录下造一份「正常」docs 树（overview/Core/Web + 四个 JSON），`overrides` 用 `null` 表示「该文件缺失」、`'...'` 表示坏文件。另造一个 `repoRoot`（`src/core/engine.py`、`src/web/handler.py`）让 `source_files` 能对上（`:59-63`）。调用 `collectOutput`/`validateOutput`/`buildWritePlan` 后按 `problem.kind` 断言。关键的「不静默丢弃」断言：`entry-missing`（`:134-139`）、`empty-body` 带 `source`（`:141-148`）、`article-missing`（`:150-155`）、`unmapped-page` 带 `source`（`:157-164`）、`source-missing` 带 `target`（`:166-178`）、`dead-link` 带 `target`（`:191-204`）；不给 `repoRoot` 时跳过 `source_files` 检查（`:180-189`）。`validateOutput` 同一输入两次调用结果稳定（`:206-212`）。

### process-tree 测试数据流（`test-engine-process-tree.mjs`）

`startTree(dir)`（`:32-43`）用 `node -e` 起一个长驻 root 进程，它 `spawn` 一个同样长驻的 grandchild 并把自己 pid 写进 `grandchild.pid`；`waitForFile`（`:45-55`）轮询等孙进程起来。断言链：

1. `isAlive`（`:57-67`）：已退出/不存在/0/负数/undefined 均 false。
2. `terminateProcessTree` 非法 pid（`:69-76`）：`undefined/null/0/-5/1.5/'abc'` 全为 `{ok:true, rootAlive:false, method:'noop'}`。
3. 真实进程树（`:78-100`）：杀 root 后 `rootAlive===false` 且 `isAlive(grandPid)===false`（不留孤儿）。
4. 幂等（`:102-112`）：已退出进程重复终止第二次仍 `ok`。
5. `onLog` 诊断（`:114-128`）：日志含 `taskkill|SIGTERM|SIGKILL`，且**不含** `api_key/authorization/token/bearer` 等凭证字样。

## Connections

## Known Issues
