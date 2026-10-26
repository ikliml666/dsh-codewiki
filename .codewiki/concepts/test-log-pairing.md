---
title: test-log-pairing
type: concept
source_files:
  - test-orchestration.mjs
  - index.js
  - .tmp-test-orchestration.log
  - README.md
  - CHANGELOG.md
  - client.js
tags: [测试, 日志, 配对, 端到端, codewiki, 跨模块]
---

## 概述

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，四类产物之间通过行号引用、prompt 特征句与断言结果形成的配对与相互印证关系：测试脚本（`test-orchestration.mjs`）、被测运行时（`index.js`）、留档运行日志（`.tmp-test-orchestration.log`，下文简称 log:NNN）与文档/面板层（`CHANGELOG.md`、`README.md`、`client.js`）。它不是单一代码实体，而是验证体系的数据/控制流闭环：测试以「mock 宿主 llm 服务（llm.stream 按 prompt 特征应答，插件零直连）+ 真实 cw CLI + 真实服务 tick」驱动插件并自述该配方（test-orchestration.mjs:27-28），用 `check(cond, msg)`（test-orchestration.mjs:27-30）把代码预期逐条绑定为 ✓/✗ 日志行，收尾汇总 `PASS：编排冒烟全部通过` / `FAIL：N 项未通过` 并以退出码上抛（test-orchestration.mjs:27-28）。

当前代码基线为 0.12.2（CHANGELOG.md:3），`test-orchestration.mjs` 含 30 个 `== … ==` 测试块（test-orchestration.mjs:235-1498），验证：`codewiki_generate` 提交制 + 服务阶段机（提交即返回且 `stage='articles'`，test-orchestration.mjs:624-626；阶段机实现在 index.js:2395-2402 的 `STAGE_HANDLER`——articles/crosscut/compose/review/index/commit 六处理器，文件头摘要只列四环节 test-orchestration.mjs:3）、stale 逐篇更新（预构建任务直达 articles，test-orchestration.mjs:849-870；任务预构建在 index.js:2395-2480）、宿主重启按持久化 prompt 快照重跑（0.6.0，test-orchestration.mjs:909-966）、面板端点 jobs/repos/sessions/control 与取消（test-orchestration.mjs:1018-1070、1337-1364）、编译模型缺失诚实报错（0.10.1，test-orchestration.mjs:1458-1471）、单项目串行（0.10.0，test-orchestration.mjs:726-782）与并行项目上限（1.1.0，test-orchestration.mjs:784-813）、worktree 闸门（1.2.0，test-orchestration.mjs:1366-1403）、空壳目录闸门（0.12.1，test-orchestration.mjs:1407-1456）、编译产物自动提交 `autoCommitWiki`（0.10.9 起、0.10.11 升级为主题分支合并式，index.js:3406-3488）及其三态判定 `autoCommitState`（0.10.10，index.js:1517-1522）。

log 则是 0.8.5 收口窗口（2026-10-18，`batchSubmittedAt=2026-10-18T02:40:36.493Z`，log:410）一轮运行的留档快照：573 行、`FAIL：2 项未通过`（log:573），2 项 ✗（log:114、log:195）断言的还是旧 source 形态 `plugin/codewiki`——正是 0.8.5「source 改为 `{kind:'plugin:codewiki'}` + 测试断言随版本收口」（CHANGELOG.md:340-342）要消灭的中间态，当前断言已写成 `source?.kind === 'plugin:codewiki'`（test-orchestration.mjs:543）。其余段落与当前测试存在系统性块名/期望值错位：log 是时间点快照而非当前源码的实时投影，这一错位本身就是本概念要记录的配对事实。0.10.10 的两处测试竞态修复（JOBS_FILE 文件名随机 token，test-orchestration.mjs:18-23；并发块 stall 挂起模拟，test-orchestration.mjs:986-990）同样源自这条链路对「偶发失败」的归因（CHANGELOG.md:111-112）。顺带一提：本篇正是由这条链路的 stale 逐篇更新路径重写的——更新 mission「以当前代码为准重写其内容，保留章节结构与 title/type/tags」写在 index.js:2395，其断言组在 test-orchestration.mjs:849-870，`STAGE_HANDLER`（index.js:2395-2402）是同一配对链的自指实例。

## 涉及模块

- **orchestration-tests**（`test-orchestration.mjs`）：配对关系的产生地。环境隔离先行：tick 压到 300ms（test-orchestration.mjs:44-45，生产默认 10s、下限 250ms 见 index.js:1163）、JOBS_FILE 文件名追加随机 token 防 pid 复用读到历史运行（test-orchestration.mjs:44-50）、编译模型显式 `batchCfg → workbuddy/hy3`（test-orchestration.mjs:44）。mock 三件套：`makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（test-orchestration.mjs:44-84，`inject` 支持 cordis 切片回调与 promise 双风格 :62-72、`effect` 真实语义「立即执行 body、返回函数收集为 disposer」:77-81——注释 :75-76 明言这是防 0.4.3 式 `() => service.stop()` 错写的回归防线）、`makeMockAgent`（test-orchestration.mjs:87-101，`TOOL_REPORT: 2900` :94 支撑提醒 section 的 order，index.js:3545 同源）、`makeFixtureRepo`（test-orchestration.mjs:103-120，顶层 `core/`、`util/` 两目录 :105-110 由 localPlan 顶层分组直接决定模块名 index.js:832-845；自带 git identity :113-116 满足 autoCommitWiki 的安全边界检查 index.js:3432-3433）。模型通道模拟：`activeLlm`/`llmProxy` 唯一转发（test-orchestration.mjs:125-133）与 `makeBatchMock`（test-orchestration.mjs:138-202，`answerFor` 按「你是 CodeWiki …」prompt 特征分发应答 :140-170——区分句与实现侧模板族一一对应；stall 挂起模拟取消语义 :177-184；`bigArticle` 追加 70000 个「长」:186 触发横切拆分）。轮询与 HTTP：`waitJob`（test-orchestration.mjs:205-218，终态判定 :214）与 `fakeReq`/`fakeRes` 直打端点 handler（test-orchestration.mjs:220-232）。

- **runtime-plugin**（`index.js`）：配对的另一端。阶段机 `STAGE_HANDLER`（index.js:2395-2402）；`tickIndex` 有产物且开关开启时转入独立 commit 阶段（index.js:2395-2398），`tickCommit` 执行提交后才置 done（index.js:2377-2393）。自动提交三件套共用 `autoCommitState` 三态（index.js:1517-1522）：`autoCommitWiki`（index.js:3406-3488，产物唯一定义 `WIKI_PATHS` :36，分支合并式 :3450-3484）、`wakeCompileSession`（index.js:1524-1539，成功且已提交/无改动即静默 :1528，steer 消息 source 标记 :1537）、`commitHintText`（index.js:3490-3521，:3501 复用三态判定、:3507 编译晚于提交才提醒），再加系统提示 section `codewiki:update-reminder`（index.js:2395-2406，section 名 :3544、CodeWiki.md 门控 :3549）。模型执行：`llmChat`（index.js:392-417，source 标记 :398，思考档位不支持时剥档重试 :406-410）与 `runRealtimeTasks`（index.js:449-508，0.12.2 起大档/默认档分池 :451-459）。断点与重启：`submitBatchFor` 持久化每任务 `batchPrompt` 快照（index.js:1828-1862，:1839「宿主重启后重跑本阶段的唯一依据」；bigTier 持久化 :1843）、`settleJob` 丢执行器后按快照重跑（index.js:1681-1702，:1694-1698）、旧 plan 阶段任务迁移到 articles（index.js:2395-2404）、foreign 孤儿按停更超时接管（index.js:2395-2397、:2434-2439，阈值 :1355）。落盘质量闸门：`numberLines` 行号前缀（index.js:537-539）、`fixAnchors` 锚点机械校正（index.js:548-631）、`writeValidated` frontmatter 闸门（index.js:1707-1723）、批量校对 `settleProofread` 按 `@@@article`/`
