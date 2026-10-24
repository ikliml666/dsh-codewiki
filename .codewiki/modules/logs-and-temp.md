---
title: logs-and-temp
type: module
source_files:
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [logs, temp, testing, watcher, debugging]
---

## Overview

`logs-and-temp` 模块负责保存各测试运行产生的临时日志以及 watcher 监听日志，用于排查错误与记录运行时输出信息。模块本身不包含可执行代码，仅由以下六个数据文件组成，这些文件在测试执行与 watcher 轮询期间生成，直接落盘于仓库根目录（或临时目录），供开发者事后审查：

- `.tmp-test-batch.log`：批量单元测试结果（行 1-85）
- `.tmp-test-cwd-paths.log`：cwd 路径规范化测试（行 1-8）
- `.tmp-test-orchestration.log`：编排集成测试（行 1-573）
- `.tmp-test-wiki-anchors.log`：Wiki 文章锚点校验（行 1-161）
- `.tmp-test-wiki-entry.log`：Wiki 入口生成测试（行 1-25）
- `watcher2.log`：watcher 对 job 状态的监听轮询日志（行 1-1394）

## Key Components

本模块为纯日志数据，无代码函数/类/常量。以下将每个日志文件视为数据组件，列出其行号区间、用途与记录字段结构。

### `.tmp-test-batch.log`（行 1-85）
- **用途**：记录 `estimateTokens`、`collectSources`、`prepareArticleTasks`、`runRealtimeTasks`、`localPlan`、`packArticles`、`scanRepoFiles`、`resolveBatchApiKey` 等单元的分组测试结果。
- **格式**：以 `== 分组 ==` 起始（如行 2 `== estimateTokens：CJK 与 ASCII 粗算 ==`），条目缩进 `  ✓ 描述` 或 `  ✗ 描述`（本文件全为 ✓）。
- **结尾**：行 85 `ALL PASS：59 通过，0 失败`。

### `.tmp-test-cwd-paths.log`（行 1-8）
- **用途**：验证 MSYS/Windows cwd 路径归一化、`cw status` 真实三态、不存在路径错误清理。
- **关键行**：行 1 `MSYS cwd=...` 归一化；行 4 `Windows cwd=...`；行 7 `PASS: nonexistent path errors cleanly`；行 8 `ALL PASS`。

### `.tmp-test-orchestration.log`（行 1-573）
- **用途**：覆盖 wiki 维护提醒、插件注册、`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` 工具、全量编译、横切拆分、文章分割、面板端点、knownRepos、workspace 过滤等编排行为。
- **失败项**：行 114 `✗ source 标记 plugin/codewiki`；行 195 `✗ 唤醒消息 source=plugin/codewiki`；行 573 `FAIL：2 项未通过`。
- **附带信息**：大量 git 初始化提示与 CRLF 替换警告（如行 9-21 为 init 默认分支 `hint:` 提示，行 22 起出现 `warning: ... LF will be replaced by CRLF`）。

### `.tmp-test-wiki-anchors.log`（行 1-161）
- **用途**：校验 15 篇 `.codewiki` 文章中的行号锚点（如 `index.js:126`）及符号绑定是否正确。
- **条目结构**：`  ✓ 文件:行 \`index.js:行\` 校验项` 或 `  ✗ 文件:行 ... 符号绑定：... 应出现在 index.js:行`。
- **失败汇总**：行 161 `锚点校验：122 过 / 36 败`；示例失败见行 4、7、10、13、16、19、22、25、28、31（部分 ✓ 行 28、31 通过）、43、46、49、52、55、58、61、64、67、70、73、75、80、83、95、100、105、110、115、120、125、130、135、146、149、154、159。

### `.tmp-test-wiki-entry.log`（行 1-25）
- **用途**：验证缺失入口生成、`normalizeArticlePath`、`parseStatus`、`normalizeIndexLinks` 等函数行为及幂等性。
- **结尾**：行 25 `全部断言通过`。

### `watcher2.log`（行 1-1394）
- **用途**：watcher 进程对编译 job 的周期性状态监听日志，记录每次轮询的时刻与 job 快照。
- **行结构字段**（以行 1 为例：`40ms mtime=1791272798593 job-muwdk1pk-2 plan cancelReq=undefined upd=2026-10-06T07:46:08.259Z notes=1`）：
  - `相对时间ms`：自 watcher 启动起的毫秒数（如 `40ms`，见行 1）
  - `mtime`：关联文件修改时间 epoch 毫秒（如 `1791272798593`）
  - `job`：任务标识（如 `job-muwdk1pk-2`）
  - `stage`：任务阶段（如 `plan`）
  - `cancelReq`：取消请求标记（`undefined` 或具体值）
  - `upd`：更新时间 ISO8601 字符串（如 `2026-10-06T07:46:08.259Z`）
  - `notes`：附加注释计数（如 `1`）
- **观测**：行 1-304 主要记录 `job-muwdk1pk-2 plan`（其间行 20-22 出现 `job-muwdmx5z-0`、行 108-115 出现 `job-muwdmz8x-1` 穿插）；行 305 起切换为 `job-muwdn4lx-2` 并大量轮询至行 1394，体现多任务顺序监听。

## Architecture

```text
┌──────────────┐   ┌──────────────┐
│ Test Runners │   │ Watcher Loop │
│ (batch,cwd,  │   │ (poll jobs)  │
│ orch,entry,  │   └──────┬───────┘
│ anchors)     │          │ watcher2.log
└──────┬───────┘          │
       │ .tmp-test-*.log  ▼
┌──────────────────────────────────┐
│ logs-and-temp (模块)             │
│ 临时日志与监听日志存储           │
│ 用于错误排查与运行时输出记录     │
└──────────────────────────────────┘
```

## Data Flow

1. 测试执行器（batch/cwd/orchestration/anchors/entry）将分组断言结果按固定文本格式写入对应的 `.tmp-test-*.log`（如 `.tmp-test-batch.log:2` 起始分组）。
2. watcher 进程以约 30ms 间隔轮询活动 job，将单行状态追加到 `watcher2.log`（如 `watcher2.log:1`）。
3. 开发者或 CI 脚本读取这些日志：从 `.tmp-test-orchestration.log:573` 获知失败总数，从 `.tmp-test-wiki-anchors.log:161` 获知锚点失误，从 `watcher2.log` 追踪 job 卡留阶段（如 `watcher2.log:1-304` 的 `plan` 停滞）。
4. 日志为临时性质，通常在仓库根或临时目录，不纳入版本库最终产物，仅用于运行时排查。

## Connections

- [[test-suite]]（批量与单元测试用例集合）
- [[orchestration]]（编排流程，对应 `.tmp-test-orchestration.log`）
- [[wiki-entry]]（入口生成，对应 `.tmp-test-wiki-entry.log`）
- [[wiki-anchors]]（锚点校验，对应 `.tmp-test-wiki-anchors.log`）
- [[watcher]]（监听进程，对应 `watcher2.log`）
- [[cwd-paths]]（路径归一化，对应 `.tmp-test-cwd-paths.log`）

## Known Issues

- `.tmp-test-orchestration.log:114` 与 `.tmp-test-orchestration.log:195` 中 `source` 标记未正确等于 `plugin/codewiki`（显示 `✗`），导致 `.tmp-test-orchestration.log:573` 汇总 `FAIL：2 项未通过`。
- `.tmp-test-wiki-anchors.log:161` 报告 36 个符号绑定失败，具体如 `.tmp-test-wiki-anchors.log:4` 期望 `normalizeArticlePath` 等符号出现在 `index.js:126` 但实际未匹配，涉及 `cw-binary-source-lost.md` 与 `update-reminder-entry-gap.md` 等多处。
- `watcher2.log` 中 `job-muwdk1pk-2` 在 `watcher2.log:1` 至 `watcher2.log:304` 多次输出 `plan cancelReq=undefined`（其间行 20-22 出现 `job-muwdmx5z-0`、行 108-115 出现 `job-muwdmz8x-1` 等穿插轮询），长达约 9 秒未推进阶段，可能暗示调度延迟或取消信号未抵达（但 `cancelReq` 始终为 `undefined` 表明未发起取消）。
- 本模块无禁用/注释掉的功能代码；所有日志文件均按预期生成。