---
title: test_engine_native
type: module
source_files:
  - lib/engine/native-run.js
  - test-engine-native-job.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-engine-output-real.mjs
  - .codewiki/modules/engine_apply.md
  - .codewiki/modules/engine_runtime.md
tags: [test, native-engine, fake, job-execution, wiring, quality-gate, apply-plan]
---

## Overview

`test_engine_native` 是阶段 4「原生引擎接入 JobService 的生产接线」测试集合与配套假引擎。它守的不是「某个函数算得对」，而是**「`codewiki_generate` 提交的 job 真的走到了原生通道，且终态由质量门 + 落地器裁决」**这条端到端接线。核心文件：

- `test-engine-native-job.mjs` — 16 个用例的生产接线测试，除两个纯裁决用例（15、16）外全部走真实链路：`codewiki_generate.execute` → `JobService.submit` → `tick(300ms)` → `tickNative` → `runNativeJob` → `doctor`/`lock` → `runEngine(client.js` 真 spawn`)` → 假引擎进程 → `gateNativeOutput(真实)` → `applyNativeOutput(真实)` → `cw init/index/meta(真实)` → `autoCommitWiki(真实 git)` → `finishJob`。
- `test-fixtures/fake-native-engine.mjs` — **真进程**假引擎，只实现协议与产物、不实现算法。它是 `node` 当解释器、本文件当入口脚本，因此 `client.js` 的 spawn / stdin 一行 JSON / stdout JSON-lines / 进程树终止全部走真实代码——那正是最容易悄悄坏掉的一段。
- `lib/engine/native-run.js` — 被测的生产编排器（被本测试直接 import 与间接经 `tickNative` 调用），其职责边界见 [[engine_apply]] / [[engine_runtime]]。

测试加速手段（`test-engine-native-job.mjs:28-32`）：把 `DSH_CODEWIKI_TICK_MS` 压到 `300`（生产默认 10s），并用随机 `DSH_CODEWIKI_JOBS_FILE` 与真实宿主服务实例隔离，防止 pid 复用读到历史 fixture 任务。

覆盖场景（`test-engine-native-job.mjs:15-17`）：成功 / 首次编译不得伪 done / 引擎 done 被质量门拦下 / 引擎 failed / 协议破坏 / 环境缺失 / 锁漂移 / index 失败 / 基线失败 / 提交失败 / 取消（进程树终止）/ 单项目串行 / 旧默认通道不受影响 / 裁决链短路分支。

## Key Components

## Key Components

本模块全部公开符号以源码 `行号| ` 前缀为准。被测的生产编排器 `runNativeJob` 与其字段详见 [[engine_apply]]（`lib/engine/native-run.js:68-488`）；下文只列本测试集合自身导出的函数/类/常量与假引擎的实现点。

### test-fixtures/fake-native-engine.mjs — 真进程假引擎

不导出任何 JS 符号（作为 `nativeEngineEntry` 被 `node` 直接执行），全部行为由文件级常量与函数驱动：

- **`modeFileFor(repoPath)`**（:27-30）：返回「仓库同级目录」的模式文件 `.native-mode-<basename>` 路径；放仓库外是为了避免把它写成一次未提交源码改动（否则质量门 `uncommitted-input` 会判成产品缺陷）。
- **`modeOf(repoPath)`**（:31-40）：模式解析优先级——环境变量 `FAKE_ENGINE_MODE` → 模式文件 → 仓库目录名里的 `__<mode>__段`。不用纯 env 切换是因为同一测试进程连续跑多个用例，子进程继承的是启动那一刻的 env，会与收尾中的上一个任务竞态。
- **`MODE`**（:41）：当前用例模式（模块级可变），由 `run` 每请求重置（:145）。
- **`VERSION` / `PYVER`**（:42-43）：来自 `FAKE_ENGINE_VERSION` / `FAKE_ENGINE_PYVERSION`（默认 `9.9.9` / `3.13.0`），回给 `doctor` 的引擎指纹。
- **`logCall(repoPath, action)`**（:52-57）：把「谁跑过、跑了哪个动作」追加写到仓库同级的 `.native-calls-<basename>.log`，供测试断言「环境失败/锁漂移时引擎根本没被 generate 调用」。写不进去不影响引擎行为。
- **`emit(obj)`**（:59-61）：把一条消息 JSON 序列化后写真 stdout（一行 = 一条协议消息）。
- **`progress(requestId, stage, percent, message)`**（:62-64）/ **`result(requestId, body)`**（:65-67）：协议 `progress` / `result` 写出器。
- **`head(repoPath)`**（:69-73）：`git rev-parse HEAD`，作为产物 `metadata.generation_info.commit_id` 的真实来源。
- **`realSourceFiles(repoPath, limit=4)`**（:81-98）：递归扫仓库真实存在的源码文件（`.py/.ts/.js/.mjs/.go/.rs/.java`），只返回相对路径。必须真扫——`source_files` 的唯一合法证据是「文件在仓库里存在」（见 [[engine_output]] 的 `source-missing`）；早先硬编码 `src/core/engine.py` 而仓库没有，会让质量门永远 partial。
- **`writeDocs(docsDir, repoPath)`**（:100-140）：写出干净 docs 树——`overview.md` / `modules/core.md`（永远写）/ `modules/web.md`（仅非 `partial` 模式且存在第二个文件时写；`partial` 模式则把该页正文掏空只留标题，:120-124）/ `metadata.json` / `module_tree.json` / `first_module_tree.json` / `update_record.json`。页内**不带 frontmatter**（真实 FSoft 产物就是纯 markdown，frontmatter 由渲染层合成；自带会触发 `article-contract` 的 `duplicate-frontmatter`）。页与模块树都只引用 `realSourceFiles` 返回的真实文件（:135-136），避免质量门 `source-missing`。
- **`run(req)`**（:142-231）：请求主入口。先 `emit` 一条 `hello`（:146）并 `logCall`（:147），再按 `action` 分发：
  - `doctor`（:149-164）：默认回 `done` + `engine.deps.ok:true`；`MODE==='deps-bad'` 回 `deps.ok:false`（对应 `engine_runtime` 的 unhealthy）。
  - 未知动作（:166-169）：回 `failed`（`engine-protocol`）。
  - `stall`（:171-176）：只发一条 progress 后 `setInterval` 不退出——只能被杀，用于验证取消会终止进程树。
  - `slow`（:177-195）：延迟 `FAKE_ENGINE_DELAY_MS`（默认 1200ms）后自己跑完，用于验证串行排队（不用 stall 以免顺带验证取消）。
  - `fail`（:196-204）：直接回 `failed`（`engine-crashed`）。
  - `crash`（:205-209）：**协议破坏**——只把人类日志写真 stdout、不写 `result`（退出码 0 也救不了，`client.js` 判定 `engine-protocol`）。
  - `empty-docs`（:210-214）：回 `done` 但**不写任何产物**，验证「引擎 done 不能替代质量门」。
  - 默认分支（:216-231）：走真实 `writeDocs` 并回 `done`，`writtenCount` 在 `partial` 模式为 1、否则 2。
- **stdin 收尾**（:233-241）：按行读 stdin 首行 JSON，调 `run`；异常兜底回 `failed`（`engine-crashed`）。

支持的模式（`fake-native-engine.mjs:9-16` 注释）：`done` / `partial` / `fail` / `crash` / `stall` / `bad-yaml` / `empty-docs`（`deps-bad` 走 doctor 分支，非 generate 分支）。

### test-engine-native-job.mjs — 接线测试

顶层常量与工具函数（均文件级）：

- **常量** `TEST_TOKEN`（:31，4 字节随机 hex）、`FAKE_ENGINE`（:35，指向 `test-fixtures/fake-native-engine.mjs`）、`JOBS_FILE`（:36，来自 env `DSH_CODEWIKI_JOBS_FILE`）。
- **`check(cond, msg)`**（:43-47）：断言累加器，`checks`/`failures` 计数；失败打印 `✗`、成功打印 `✓`。
- **`norm(p)`**（:48）、**`readJson(p)`**（:49）、**`exists(p)`**（:50）：路径规范化 / 读 JSON / 存在性。
- **`makeRepo(tag, {mode, preInit, metaReadonly, noEmail})`**（:57-93）：造一个带 git 与（可选）预初始化 wiki 的临时仓库。目录布局：`<base>/<tag>` 是仓库，`<base>/.native-mode-<tag>` 是引擎模式文件（:91）。`preInit`（:71-81）真实跑 `cw init` + 入口页提交，避免首次编译被质量门 `baseline-uncommitted` 连带失败；`metaReadonly`（:82-86）把 `_meta.yaml` 设为 `0o444` 让 `cw meta update` 真实失败；`noEmail`（:87-90）清空 identity 让 `autoCommitWiki` 守卫返回 `committed:false`。返回 `{base, repo, calls}` 其中 `calls()` 读引擎足迹。
- **`readCalls(base, tag)`**（:96-100）：读 `.native-calls-<tag>.log` 的引擎动作足迹。
- **`fakeLlm`**（:106-110）：默认宿主 llm 桩——`stream` 只 yield 一次 `finish`，`listModels`/`resolveModel` 返回空。原生通道用例不访问桥，只需「桥能建立」这一事实。
- **`articleMd(title, source, type)`**（:119-120）：旧通道用例按 frontmatter 模板拼 markdown（用例 13 用）。
- **`realSources(repo)`**（:122-137）：递归扫仓库真实源码文件（上限 8、深度 3），供旧通道 llm 桩按真实存在文件生成 `source_files`，避免旧通道被 `contract` 闸门误判 partial。
- **`legacyLlmFor(repo)`**（:139-176）：旧 Node 流水线最小可用 llm 桩，按 prompt 首行特征分发（观察员/作者/架构观察员/总览/模式/概念/审校），`root` 模块只挂 `CodeWiki.md`（见注释 :141-143）。
- **`makeCtx({llm})`**（:178-206）：宿主 ctx mock（与 `test-orchestration.mjs` 同构），提供 `inject`/`on`/`effect` 与 `services.{webServer,agents,tools,llm}`，注册表 `registered`、面板端点 `endpoints`、清理器 `disposers`。
- **`nativeCfg(extra)`**（:208-223）：原生通道配置——`nativeEngine:true`、`nativeEnginePython:process.execPath`、`nativeEngineEntry:FAKE_ENGINE`、`planMode:'dirs'`、`agenticArticles:false`、`symbolIncremental:false`，关闭旧通道三档以免干扰。
- **`waitJob(cwd, {timeout=90000})`**（:226-238）：轮询 `JOBS_FILE` 直到该 cwd 的最新 job 到终态（`done/partial/failed/cancelled`）。
- **`runJob(repo, {cfg, scope, waitMs, llm})`**（:241-252）：起服务 + 提交仓库 + 等终态，返回 `{job, submitted, m}`；`finally` 里跑全部 `disposers`。
- **`gitLog(repo, n)`**（:254）/ **`gitShowFiles(repo, sha)`**（:255-256）：git 断言辅助。

用例清单（`test-engine-native-job.mjs`，每用例断言目标）：

| 用例 | 行号 | 假引擎模式 | 守的是什么 |
| --- | --- | --- | --- |
| 1 完整成功 | :259-295 | `done`+`preInit` | `channel==='native'`、`outcome==='done'`、`canAdvanceBaseline===true`、`gate`/`apply` 均 done+applied、基线推进、自动提交只落 wiki 路径、引擎锁落盘、`nativeStage` 挂在真实八段之一、持久化 job 里没有桥占位 key |
| 2 首次编译不得伪 done | :297-312 | `done`（无 `preInit`） | 终态 `partial` 而非 done、`canAdvanceBaseline===false`、`blockers` 含 `baseline-failed`、文章仍落地、`_meta.yaml` 基线仍为 `null` |
| 3 引擎 done 被质量门拦下 | :314-326 | `empty-docs`+`preInit` | 引擎被调用但 `gate.outcome==='failed'`、终态 `failed`、`canAdvanceBaseline===false`、无 `web.md` 落地、HEAD 未被推动 |
| 4 引擎 failed | :328-338 | `fail`+`preInit` | 终态 `failed`、`job.error` 非空、`gate==null`、`apply==null`、不进 gate/apply |
| 5 协议破坏 | :340-348 | `crash`+`preInit` | 终态 `failed`，错误点明协议破坏或异常退出 |
| 6 环境缺失 | :350-365 | `done`+`bogus python` | 终态 `failed`、`gate==null`+`apply==null`、`generate` 从未被调用、无产物落地 |
| 7 锁漂移 | :367-383 | `done`+手工写旧 lock | 终态 `failed`、`engineLock.status==='drift'`、生成未调用、产物/基线未动 |
| 8 index 失败回滚 | :385-398 | `done`+`_index.md` 建成目录 | 终态 `failed`、`apply.rolledBack===true`、`blockers` 含 `index-failed`、新文章回滚 |
| 9 基线失败回滚 | :400-412 | `done`+`metaReadonly` | 终态 `failed`、`baseline.advanced===false`、`blockers` 含 `baseline-failed`、`rolledBack===true`、整批回滚 |
| 10 提交失败 partial | :414-425 | `done`+`noEmail` | 终态 `partial`、`apply.applied===true`、`commit.committed===false`、`blockers` 含 `commit-failed`、产物保留不回滚、`canAdvanceBaseline===false` |
| 11 取消进程树终止 | :427-465 | `stall`+`preInit` | 引擎启动后被取消、终态 `cancelled`、`canAdvanceBaseline===false`、`notes` 记「进程树已终止」、无新文章落地、迟到结果不覆盖终态 |
| 12 单项目串行 | :467-493 | `slow`+`done` | 第二个仓库进 `queued`、note 说明通道已满、前一个完成后排队者随后完成且走原生通道 |
| 13 旧默认通道 | :495-504 | `done`（`nativeEngine:false`） | `channel==='legacy'`、`nativeResult==null`、原生引擎零调用 |
| 14 stale 不走原生 | :506-524 | `done`+`preInit` | `nativeChannelFor(kind=stale)` 返回 `null`、`nativeChannelFor(kind=full)` 返回快照、`nativeEngine=false` 返回 `null`；scope=stale 无产物时被升为 full 且引擎仍收 `generate` 而非 `update` |
| 15 假 runEngine + 真 gate/apply | :526-559 | `done`+空 docsDir | 直接调 `runNativeJob`，注入假 `runEngine` 报 done（空产物目录），真质量门拦下 → `failed`、落地器不写空产物 |
| 16 裁决链短路 | :561-604 | `done`+docsDir | 注入假 `runEngine`：①cancelled → 终态 cancelled 且 gate/apply 不跑；②failed → 终态 failed 且引擎错误原样带出；③提交前已 abort → cancelled |

### test-engine-output-real.mjs — 真实 FSoft 产物钉缺陷（关联）

本文件不测接线，但同属原生引擎产物质量保证，且被本模块的用例 3/15 所依赖的质量门逻辑覆盖，列于此以便交叉引用：

- **`REAL`**（:32）：硬编码真实产物路径 `.probe-fsoft/wiki_out_1c/docs`；不存在则 `process.exit(0)` 整体 SKIP（:33-36）。
- **`copyDocs(name)`**（:40-44）：复制真实产物到临时目录后施加变形，绝不改动原产物。
- 用例覆盖（:46-177）：`collectOutput` 读到 overview + 两模块页且 `module_tree={}`；`module_tree={}` 而模块页存在 → 页进写集、`source_files` 空（不丢不臆造）、`attribution==='unattributed'`；空模块树本身报 `empty-module-tree` 且 `ok:false`；非空模块树有孤儿页 → `unmapped`；hierarchical 嵌套子目录页必须被收集；`temp/` 里的 md 不算页；`update_record` 原样读出；metadata commit 进 `meta.lastCompiledCommit`；真实页间链接不误判死链；`componentFiles` 有证据时 unattributed 仍不臆造。

## Architecture

## Data Flow

## Connections

## Known Issues
