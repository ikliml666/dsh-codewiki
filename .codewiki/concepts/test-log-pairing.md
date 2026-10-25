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

## Overview

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，测试脚本（`test-orchestration.mjs`）、运行时实现（`index.js`）、留档运行日志（`.tmp-test-orchestration.log`）与项目文档（`CHANGELOG.md`、`README.md`）之间通过行号引用与断言结果形成的配对与相互印证关系。该概念并非单一代码实体，而是验证体系的数据/控制流闭环：测试代码以 mock 宿主 llm 服务 + 真实 cw CLI + 真实服务 tick 驱动插件逻辑（自述见 `test-orchestration.mjs:1-5`）、产生日志、断言内存状态与落盘产物，并把断言规模与失败项固化到文档。

当前代码基线（0.10.11）下，`test-orchestration.mjs` 验证的是：`codewiki_generate` 提交制 + 服务阶段机（articles→crosscut→compose→review→index→commit，0.10.7 起无规划阶段、0.10.11 新增独立 commit 阶段，`STAGE_HANDLER` 见 `index.js:2060-2067`；stale 任务提交直达 articles 且跳过 crosscut，`test-orchestration.mjs:819`）、stale 逐篇更新、宿主重启按 prompt 快照重跑（机制 0.5.0.5 引入）、面板端点（jobs/control）与取消、编译模型缺失诚实报错（0.10.1）、单项目串行排队（0.10.0）、大档单请求优先与观察→合成分割（0.10.8）、批量校对（0.10.8）、编译产物自动提交 `autoCommitWiki`（0.10.9 起，0.10.11 升级为主题分支合并式）及其三态判定 `autoCommitState`（0.10.10）。`CHANGELOG.md` 已记录至 0.10.11（`:3-15`），`README.md` 与之同步。`.tmp-test-orchestration.log` 则是 0.8.x 时代（0.8.5/0.8.6 前后）一轮运行的留档快照（时间戳证据见 Flow 第 3 步）：其 2 项 ✗（source 标记旧形态）已被 0.8.5 的 source 改形根治，其余段落与当前测试源码存在系统性的块名/阶段名/文案错位——log 是时间点快照而非当前源码的实时投影，这一错位本身就是本概念要记录的配对事实。0.10.10 的两处测试竞态修复（JOBS_FILE 随机 token、并发块 stall mock）也源自这条配对链路对「偶发失败」的归因。顺带一提：本篇正是由这条链路的 stale 逐篇更新路径重写的——阶段机 `STAGE_HANDLER`（index.js:2060-2067）与 `test-orchestration.mjs:809-830` 的 stale 断言组是同一配对链的自指实例。

## Involved Modules

- **orchestration-tests**（`test-orchestration.mjs`）：配对关系的产生地。断言机制 `check(cond, msg)`（`:27-30`）把代码预期绑定到日志 ✓/✗ 行，收尾汇总 PASS/FAIL 并以退出码上抛（`:1357-1358`）。环境隔离先行：tick 压到 300ms（`:15`），JOBS_FILE 文件名追加随机 token 防 pid 复用读到历史运行（`:18-23`）。mock 三件套：`makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（`:44-84`，`inject` 支持 cordis 切片回调与 promise 双风格 `:62-72`、`effect` 真实语义 `:74-81`）、`makeMockAgent`（`:87-101`）、`makeFixtureRepo`（`:103-120`，顶层 core/util 两目录由 localPlan 分组直接决定模块名，自带 git identity 满足 autoCommitWiki 安全边界）。模型通道 mock：`activeLlm`/`llmProxy` 唯一转发（`:125-133`）与 `makeBatchMock`（`:138-202`，`answerFor` 按「你是 CodeWiki …」prompt 特征分发应答 `:140-170`——区分句与真实模板一一对应（`:136-137` 自述）；审校员按 0.10.8 批量标记 `@@@article`/`
