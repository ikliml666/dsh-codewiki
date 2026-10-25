---
title: test-log-pairing
type: concept
source_files:
  - test-orchestration.mjs
  - index.js
  - .tmp-test-orchestration.log
  - README.md
  - CHANGELOG.md
tags: [测试, 日志, 配对, 端到端, codewiki, 跨模块]
---

## Overview

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，测试脚本（`test-orchestration.mjs`）、运行时实现（`index.js`）、留档运行日志（`.tmp-test-orchestration.log`）与项目文档（`CHANGELOG.md`、`README.md`）之间通过行号引用与断言结果形成的配对与相互印证关系。该概念并非单一代码实体，而是验证体系的数据/控制流闭环：测试代码以 mock 宿主 llm 服务 + 真实 cw CLI + 真实服务 tick 驱动插件逻辑、产生日志、断言内存状态与落盘产物，并把断言规模与失败项固化到文档。

当前代码基线（0.10.11）下，`test-orchestration.mjs` 验证的是：`codewiki_generate` 提交制 + 服务阶段机（articles→crosscut→compose→review→index→commit，0.10.7 起无规划阶段、0.10.11 新增独立 commit 阶段，`STAGE_HANDLER` 见 `index.js:2060-2067`；stale 任务跳过 crosscut 直达 articles，`test-orchestration.mjs:819`）、stale 逐篇更新、宿主重启按 prompt 快照重跑（0.6.0）、面板端点（jobs/control）与取消、编译模型缺失诚实报错（0.10.1）、单项目串行排队（0.10.0）、大档单请求优先与观察→合成分割（0.10.8）、批量校对（0.10.8）、编译产物自动提交 `autoCommitWiki`（0.10.9 起，0.10.11 升级为主题分支合并式）及其三态判定 `autoCommitState`（0.10.10）。`CHANGELOG.md` 已记录至 0.10.11，`README.md` 与之同步。`.tmp-test-orchestration.log` 则是 0.8.x 时代（0.8.5 前后）一轮运行的留档快照（时间戳证据见 Flow 第 3 步）：其 2 项 ✗（source 标记旧形态）已被 0.8.5 的 source 改形根治，其余段落与当前测试源码存在系统性的块名/阶段名/文案错位——log 是时间点快照而非当前源码的实时投影，这一错位本身就是本概念要记录的配对事实。0.10.10 的两处测试竞态修复（JOBS_FILE 随机 token、并发块 stall mock）也源自这条配对链路对「偶发失败」的归因。顺带一提：本篇正是由这条链路的 stale 逐篇更新路径重写的——任务 mission 模板（`index.js:2060`）与 `test-orchestration.mjs:809-830` 的 stale 断言组是同一配对链的自指实例。

## Involved Modules

- **orchestration-tests**（`test-orchestration.mjs`）：配对关系的产生地。断言机制 `check(cond, msg)`（`test-orchestration.mjs:27-30`）把代码预期绑定到日志 ✓/✗ 行，收尾汇总 PASS/FAIL 并以退出码上抛（`test-orchestration.mjs:27-28`）。环境隔离先行：tick 压到 300ms（`test-orchestration.mjs:27`），JOBS_FILE 文件名追加随机 token 防 pid 复用读到历史运行（`test-orchestration.mjs:27-32`）。mock 三件套：`makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（`test-orchestration.mjs:44-84`，`inject` 支持 cordis 切片回调与 promise 双风格 `:62-72`、`effect` 真实语义 `:74-81`）、`makeMockAgent`（`:87-101`）、`makeFixtureRepo`（`:103-120`，顶层 core/util 两目录由 localPlan 分组直接决定模块名，自带 git identity 满足 autoCommitWiki 安全边界）。模型通道 mock：`activeLlm`/`llmProxy` 唯一转发（`:125-133`）与 `makeBatchMock`（`:138-202`，`answerFor` 按「你是 CodeWiki …」prompt 首行特征分发应答 `:140-170`——区分句与真实模板一一对应（`:136-137` 自述）；审校员按 0.10.8 批量标记 `@@@article`/`@@@end` 逐篇回格式化结果 `:155-168`；`stream` 吐宿主 block 协议、stall 模式挂起等取消 `:172-191`、bigArticle 撑大文章 `:186`）。收割与请求伪造：`waitJob` 轮询 JOBS_FILE 等终态（`:205-218`，终态集合 `:214`）、`fakeReq`/`fakeRes`（`:220-232`）。

- **runtime-under-test**（`index.js`）：被配对的实现侧。`apply()`（`index.js:3110-3169`）消费测试注入的 ctx 切片：`inject(['agents'])`（`:3111`）与 `inject(['llm'])`（`:3112`）取服务引用，`createJobService` 起 tick 服务（`:3113-3117`，effect 收集 disposer），注入四工具 cw/codewiki_generate/codewiki_update/codewiki_progress（`:3150-3166`）、面板端点（`installWebServer` `:2686-2915`）与会话提醒 section（`installUpdateReminder` `:3076-3108`，section 名 `codewiki:update-reminder` `:3086`）。阶段机 tick（`:2069-2146`）按 `STAGE_HANDLER`（`:2060-2067`）推进，全部模型环节经 `llmChat`（`:288-307`）打 `llmRef`——即测试里的 `llmProxy`。mock 应答所对的真实 prompt 模板区分句：文章作者 `:522`、架构观察员 `:765`、文章观察员 `:786`、审校员 `:838` 与 `:861`。

- **archived-run-log**（`.tmp-test-orchestration.log`）：一次历史运行的重定向留档，0.8.x 快照。既记录了与现行测试仍大体对应的通过面（面板端点、knownRepos、工作区过滤、schema 校验、孤儿接管、Temp 清理等块），也记录 2 项失败：`log:114` 与 `log:195` 的「source 标记 plugin/codewiki」✗，以及 `log:573` 的「FAIL：2 项未通过」汇总。它同时保存了大量已被后续版本改写的现场：初始 stage=plan（`log:188`）、stale 更新 3 篇（`log:302`）、notes 里的「规划走主模型（main-model-x）…并发 8、qwen3.7-flash」（`log:137`）、「无凭证：诚实报错」块与百炼报错文案（`log:547`、`:563`）。

- **doc-ledger**（`CHANGELOG.md` / `README.md`）：配对结论的固化端。CHANGELOG 逐版本记录每轮改动对应的测试断言与失败归因（0.10.11 commit 阶段 `:3-15`、0.10.10 三态与两处竞态修复 `:17-31`、0.10.7 删规划 `:63-72`、0.8.5 source 形态 `:250-259`）；README 维护工具表与设置语义的现行口径（工具表 `:10-12`、autoCommit `:39`、验证命令 `:67`）。

## Architecture

配对拓扑是四节点两链路：测试 → 运行时 → 磁盘任务文件 → 日志/文档。

```text
┌──────────────────────────────┐
│ test-orchestration.mjs       │
│ makeCtx / makeBatchMock 注入  │
│ check() 断言 → ✓/✗ 行        │
└──────┬───────────────┬───────┘
       │ apply(ctx)    │ waitJob 轮询读
       ▼               ▼
┌─────────────────────┐  落盘  ┌───────────────────────────┐
│ index.js            │───────▶│ JOBS_FILE                 │
│ createJobService    │◀───────│ jobs-test-<pid>-<tok>.json│
│ tick 阶段机          │  读态   └───────────────────────────┘
│ articles→crosscut→  │
│ compose→review→     │
│ index→commit        │
└──────┬──────────────┘
       │ stdout ✓/✗ 汇总（人工留档一次）
       ▼
┌────────────────────────────┐ 归因  ┌──────────────────────────┐
│ .tmp-test-orchestration.log│──────▶│ CHANGELOG.md / README.md │
│ 0.8.x 快照，2 ✗            │       │ 版本记录 / 现行口径        │
└────────────────────────────┘       └──────────────────────────┘
```

两条配对链路：正向链路「测试驱动 → 实现执行 → 日志留痕 → 文档固化」，每一跳都有可引用的行号锚点；反向链路「文档里的失败归因 → 测试源码的修复（断言更新/竞态修复）→ 实现行为改变」，0.8.5 source 改形与 0.10.10 竞态修复走的都是这条反向链。mock 应答与真实 prompt 模板的区分句（「你是 CodeWiki 文章作者/观察员/审校员」）是两条链路的公共耦合点：实现侧措辞一动（`index.js:522`、`:765`、`:786`、`:861`），测试侧 `answerFor`（`test-orchestration.mjs:140-170`）必须同步，否则应答错路、任务落 unknown task（`:169`）。

## Flow

1. **装配与隔离**：压 tick 到 300ms（`test-orchestration.mjs:15`）、JOBS_FILE 追加随机 token（`:18-23`），随后 import 真实 `index.js`（`:24`）——测试不复制实现，直接驱动真模块。
2. **注入与注册**：`apply(main.ctx, mainConfig)`（`:271`）消费 makeCtx 服务切片；`index.js:3110-3169` 完成 inject 接线、服务启动（effect disposer `:3117`）、四工具注册与提醒 section 安装；测试侧同步捕获 `e2eSteers`（sess-e2e 的 steer 收集器，`test-orchestration.mjs:268-269`）以断言终态唤醒。
3. **提交与推进**：`gen.execute({cwd})` → `svc.submit`（`index.js:2148-2213`，排除清单/幂等/串行排队在此分岔）→ job 占位落盘 → tick 阶段机（`:2069-2146`；compose 仅在横切拆分时出现）经 llmProxy 打 mock；`waitJob`（`test-orchestration.mjs:205-218`）轮询 JOBS_FILE 收割终态。留档日志属于这条链的一次历史运行：`log:410` 的 `batchSubmittedAt=2026-10-18T02:40:36.493Z` 把它钉在 0.8.5/0.8.6 发布当日（`CHANGELOG.md:442`、`:250`），与 log 内残留的「规划走主模型」「stage=plan」互相印证。
4. **断言与落库核查**：`check()`（`test-orchestration.mjs:27-30`）除内存断言（job.stage、notes、`llmCalls` 的 provider/model）外，还有 git/磁盘级核查——全量编译后 HEAD 提交只含 `.codewiki/` 与 `CodeWiki.md`、工作区干净（`:634-644`）、autoCommit 不卷入源码改动（`:423-425`）。
5. **日志固化与文档回流**：stdout 的 ✓/✗ 汇总被人工重定向留档为 `.tmp-test-orchestration.log`（当轮 2 ✗，`log:573`）；失败归因写进 CHANGELOG——0.8.5 的 source 形态变更（`CHANGELOG.md:255`）根治 `log:114`/`:195` 两处 ✗，0.10.10 对「偶发 20 项失败」的归因产出两处测试竞态修复（`CHANGELOG.md:26-27`），对应测试侧 JOBS_FILE 随机 token（`test-orchestration.mjs:18-23`）与并发块 stall mock（`:928-976`）。

## Implementation Map

| 配对事实 | 测试侧（test-orchestration.mjs） | 实现侧（index.js） | 日志/文档侧 |
|---|---|---|---|
| source 标记 `plugin:codewiki` | `:543` 断言 steer 消息 source.kind | `:294`（llmChat）、`:1234`（wakeCompileSession）、`:1564`/`:1608`（会话通道 steer） | log:114/:195 旧断言 ✗；CHANGELOG:255（0.8.5 改形） |
| 零规划请求（0.10.7） | `:583`、`:608`、`:628`、`:672` 断言无「勘探员」prompt | localPlan `:685-698`、tickArticles 就地规划 `:1692-1697` | CHANGELOG:63-72；README:10 |
| 批量校对（0.10.8） | `:652`、`:718`、`:802` 断言 PROOFED 回写 | batchProofreadBatchPrompt `:859-886`、settleProofread `:1426-1450`、writeValidated `:1382-1398` | CHANGELOG:56 |
| autoCommit 三态（0.10.10） | `:508-518` 直接单测 autoCommitState | autoCommitState `:1214-1219`、唤醒闸门 `:1225`、提醒闸门 `:3043` | CHANGELOG:22；README:39 |
| 分支合并式提交（0.10.11） | `:405-506` 边界组、`:632-633` 端到端 stageTimings.commit 与 mode='branch' | autoCommitWiki `:2948-3030`（主题分支 `:2999`、合并 `:3015-3026`、direct 降级 `:2995-3002`）、tickCommit `:2042-2058`、STAGE_HANDLER `:2060-2067` | CHANGELOG:3-15 |
| 单项目串行（0.10.0） | `:726-773`（queued、排队零请求、取消后轮到） | submit 排队 `:2196-2209`、tick 闸门 `:2077-2083` | CHANGELOG:169；README:21 |
| 唯一通道（0.10.1） | `:775-807` 断言全请求 workbuddy/hy3、`:789` 无档位不下发 reasoningEffort | llmChat `:288-307`、提交校验 `:2182-2191` | CHANGELOG:147-159 |
| 宿主重启快照重跑（0.6.0） | `:869-926`（stage-* 快照重跑与旧 plan 迁移两场景） | settleJob 快照重跑 `:1366-1376` | CHANGELOG:328-338 |
| 测试竞态修复（0.10.10） | JOBS_FILE 随机 token `:18-23`；并发块 stall mock `:928-976` | —（修复在测试自身） | CHANGELOG:26-27 |

## Connections

- [[auto-commit]]：`autoCommitWiki` 的分支合并式提交与三态判定是本配对链近三个版本（0.10.9–0.10.11）的主要被验证对象，测试侧 `:405-556` 三个块（边界组/三态/唤醒）与之对应。
- [[batch-proofread]]：0.10.8 批量校对的 `@@@article`/`@@@end` 标记协议同时约束实现（`index.js:859-886`）与 mock 应答（`test-orchestration.mjs:155-168`），是「区分句耦合」的最典型实例。
- [[local-plan]]：0.10.7 删规划阶段后 localPlan 成为唯一规划路径，测试 fixture 的顶层目录结构（`test-orchestration.mjs:103-108`）直接决定断言里的模块名——fixture 与实现共享「按顶层目录分组」这一约定。
- [[workspace-filter]]：0.4.9/0.4.10/0.4.11.2 三块（工作区过滤、registry 降级、孤儿接管，`test-orchestration.mjs:1127-1292`）展示同一配对模式在面板半侧的复用，log 里也有对应通过记录。

## Known Issues

1. **留档日志是时间点快照，不得当现行规格读**。log 与当前测试源码存在系统性错位：块名（`log:110`「与子代理 send_message 同机制」 vs `test-orchestration.mjs:521`「插件已自动提交时完全不打扰会话」）、初始阶段（`log:188` stage=plan vs `:625` stage=articles）、stale 篇数（`log:302` 3 篇 vs `:823` 2 篇）、模型与并发（`log:137` qwen3.7-flash/并发 8 vs `:787-788` workbuddy/hy3）、无凭证文案（`log:563` 百炼 vs `:1302` 编译模型提供商为空）。引用日志前必须先对照 CHANGELOG 定其版本位。
2. **源内注释滞后于 0.10.11 阶段机**。`test-orchestration.mjs:3`、`index.js:2060-2063` 与工具描述 `index.js:2060` 仍写「articles→crosscut→review→index」（无 commit），而 `STAGE_HANDLER`（`index.js:2060-2067`）与 `tickIndex`/`tickCommit`（`index.js:2060-2062`、`:2042-2058`）已有独立 commit 阶段——配对链上「注释 ↔ 行为」这一对当前不一致，以行为为准。
3. **日志不会自动再生**。`README.md:67` 的验证命令输出到 stdout；`.tmp-test-orchestration.log` 是一次人工重定向的留档。当前源码重跑应得 0 ✗（source 断言已是 `plugin:codewiki`，`test-orchestration.mjs:543`），log 里的 2 ✗ 不代表现存缺陷。
4. **配对在面板半侧断开**。client.js（面板 UI）的改动只有 CHANGELOG 文字记录（如 `CHANGELOG.md:11` 步骤条加 commit），无测试断言覆盖——文档 ↔ 代码的配对在该半侧是单向的，靠人工目验。
5. **mock 应答与 prompt 措辞强耦合**。`answerFor` 按「你是 CodeWiki …」区分句分发（`test-orchestration.mjs:140-141`、`:140-170`）；`index.js` 对应模板（`:522`、`:765`、`:786`、`:838`、`:861`）措辞一变，mock 即落 unknown task（`:169`），表现为任务失败而非断言失败——排查时先对模板措辞。