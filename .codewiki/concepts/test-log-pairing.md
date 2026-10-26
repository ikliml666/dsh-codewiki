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

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，四类产物之间通过行号引用与断言结果形成的配对与相互印证关系：测试脚本（`test-orchestration.mjs`）、被测运行时（`index.js`）、留档运行日志（`.tmp-test-orchestration.log`，下文简称 log:NNN）与文档层（`CHANGELOG.md`、`README.md`、面板半侧 `client.js`）。它不是单一代码实体，而是验证体系的数据/控制流闭环：测试以「模拟宿主 llm 服务（llm.stream 按 prompt 特征应答，插件零直连）+ 真实 cw CLI + 真实服务 tick」驱动插件（自述 `test-orchestration.mjs:27-32`），用 `check()`（`test-orchestration.mjs:27-30`）把代码预期逐条绑定为 ✓/✗ 日志行，并断言内存状态与 `.codewiki/` 落盘产物；文档再把断言规模与失败归因固化成版本条目。

当前代码基线（0.12.1，`CHANGELOG.md:3`）下，`test-orchestration.mjs`（30 个 `== … ==` 测试块，`:235`–`:1498`）验证：`codewiki_generate` 提交制 + 服务阶段机（提交即返回且 `stage='articles'`，`:624-626`；阶段机实现在 `index.js:2395-2402` 的 `STAGE_HANDLER`：articles/crosscut/compose/review/index/commit 六处理器）、stale 逐篇更新（预构建任务直达 articles、跳过 crosscut，`test-orchestration.mjs:849-870`、`index.js:2395`）、宿主重启按持久化 prompt 快照重跑（0.6.0，`:909-966`）、面板端点 jobs/repos/sessions/control 与取消（`:1018-1070`、`:1339-1364`）、编译模型缺失诚实报错（0.10.1，`:1458-1471`）、单项目串行（0.10.0，`:726-782`）与并行项目上限（1.1.0，`:784-813`）、worktree 闸门（1.2.0，`:1367-1403`）、空壳目录闸门（0.12.1，`:1407-1456`）、编译产物自动提交 `autoCommitWiki`（0.10.9 起、0.10.11 升级为主题分支合并式，`index.js:3406-3488`）及其三态判定 `autoCommitState`（0.10.10，`index.js:1517-1522`）。log 则是 0.8.5 收口窗口（2026-10-18，`batchSubmittedAt=2026-10-18T02:40:36.493Z`，log:410）一轮运行的留档快照：573 行、`FAIL：2 项未通过`（log:573），2 项 ✗（log:114、log:195）断言的还是旧 source 形态 `plugin/codewiki`——正是 0.8.5「source 改形 + 测试断言随版本收口」（`CHANGELOG.md:318-320`）要消灭的中间态；其余段落与当前测试存在系统性的块名/期望值错位。log 是时间点快照而非当前源码的实时投影，这一错位本身就是本概念要记录的配对事实。0.10.10 的两处测试竞态修复（JOBS_FILE 文件名随机 token `test-orchestration.mjs:18-23`、并发块 stall 模拟 `:986-990`）同样源自这条链路对「偶发失败」的归因（`CHANGELOG.md:89-90`）。顺带一提：本篇正是由这条链路的 stale 逐篇更新路径重写的——`STAGE_HANDLER`（`index.js:2395-2402`）与 `test-orchestration.mjs:849-870` 的 stale 断言组是同一配对链的自指实例。

## 涉及模块

- **orchestration-tests**（`test-orchestration.mjs`）：配对关系的产生地。断言机制 `check(cond, msg)`（`:27-30`）把代码预期绑定到日志 ✓/✗ 行，收尾汇总 `PASS：编排冒烟全部通过` / `FAIL：N 项未通过` 并以退出码上抛（`:1521-1522`）。环境隔离先行：tick 压到 300ms（`:15`）、JOBS_FILE 文件名追加随机 token 防 pid 复用读到历史运行（`:18-23`）、编译模型显式 `batchCfg → workbuddy/hy3`（`:36-38`）。模拟三件套：`makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（`:44-84`，`inject` 支持 cordis 切片回调与 promise 双风格 `:62-72`、`effect` 真实语义「立即执行 body、返回函数收集为 disposer」`:74-81`）、`makeMockAgent`（`:87-101`，`TOOL_REPORT: 2900` 支撑提醒 section 的 order `:94`）、`makeFixtureRepo`（`:103-120`，顶层 `core/`、`util/` 两目录由 localPlan 顶层分组直接决定模块名 `:105-110`，自带 git identity 满足 autoCommitWiki 安全边界 `:113-116`）。模型通道模拟：`activeLlm`/`llmProxy` 唯一转发（`:125-133`）与 `makeBatchMock`（`:138-202`，`answerFor` 按「你是 CodeWiki …」prompt 特征分发应答 `:140-170`——区分句与实现侧模板族一一对应（`:136-137` 自述）；审校员按 0.10.8 批量标记 `@@@article`/`
