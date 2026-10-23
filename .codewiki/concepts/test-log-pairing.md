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

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，测试脚本（`test-orchestration.mjs`）、运行时实现（`index.js`）、运行日志（`.tmp-test-orchestration.log`）与项目文档（`README.md`/`CHANGELOG.md`）之间通过行号引用与断言结果形成的配对与相互印证关系。该概念并非单一代码实体，而是验证体系的数据/控制流闭环：测试代码调用真实插件逻辑、产生日志、断言日志与内存状态，并将断言规模与失败项固化到文档中。

## Involved Modules

- **orchestration-tests**：配对关系的产生地。提供端到端测试脚本 `test-orchestration.mjs` 与对应日志 `.tmp-test-orchestration.log`，通过 `check` 断言机制将代码预期与日志输出行号绑定。
- **plugin-runtime**：被测实现载体。宿主侧 `index.js` 内的 `createJobService`、`wakeCompileSession` 等符号是被测试直接导入与调用的对象，其行号在测试中断言配对。
- **project-docs**：配对结果固化层。`README.md` 记录验证命令，`CHANGELOG.md` 按版本存证测试断言数（如「107 → 118 项全过」）与已知日志 FAIL 项，形成文档到测试日志的回溯配对。

## Flow

1. **控制流启动与代码配对**：测试启动设置隔离环境变量（`test-orchestration.mjs:14-19`），动态导入 `./index.js` 取得 `{name, apply}`（`test-orchestration.mjs:20`），将 plugin-runtime 的 `index.js` 实现加载进测试进程，完成“测试脚本—实现代码”的符号配对。
2. **模拟注入与执行驱动**：`makeCtx` 构造 mock 宿主（`test-orchestration.mjs:40-80`），测试块调用 `apply` 注册工具（如 `test-orchestration.mjs:258`）；`makeBatchMock` 构造假 llm 服务模拟编译模型通道（`test-orchestration.mjs:127-189`）。调用 `registered.get('codewiki_generate').execute`（如 `test-orchestration.mjs:40`）触发 `index.js` 的 `createJobService` 阶段机在后台 tick 推进。
3. **日志生成与断言配对**：测试执行产生 `.tmp-test-orchestration.log`。`check(cond, msg)` 断言（`test-orchestration.mjs:23-27`）验证内存态；针对 `wakeCompileSession`，测试预期 `source.kind='plugin:codewiki'`（`test-orchestration.mjs:364` 与 `:471`），而日志中对应断言未通过，汇总于日志 FAIL 项，形成“测试代码行号—日志行”的精确配对。
4. **文档层固化配对**：测试规模与结论回流文档：`README.md:65` 记录验证命令 `node test-orchestration.mjs`；`CHANGELOG.md` 记录当轮断言数前后对照与「文档：」条目存证同步动作，完成跨模块的测试-日志-文档闭环。

## Implementation Map

- **测试与日志配对实体**
  - `test-orchestration.mjs:22-26` — `failures` 计数与 `check` 断言机制，驱动日志输出与失败标记。
  - `test-orchestration.mjs:351-377` — `wakeCompileSession` 测试块，包含 `source.kind` 预期。
  - `test-orchestration.mjs:364, 471` — 预期 `source.kind='plugin:codewiki'` 的精确断言位置。
  - `.tmp-test-orchestration.log` — 汇总 FAIL 项的日志位置。
  - `.tmp-test-orchestration.log` — 具体断言未通过（✗）的日志行。
- **被测实现配对位置（plugin-runtime）**
  - `index.js` — `wakeCompileSession(job, outcome)` 定义，实际生成唤醒消息 `source` 标记的逻辑。
  - `index.js` — `createJobService` 六阶段任务状态机，被测试提交与轮询驱动。
  - `index.js` — Data Flow 中 `wakeCompileSession` 在终态时 steer 发起会话的实现点。
- **文档配对位置（project-docs）**
  - `README.md:65` — 验证命令 `node test-orchestration.mjs`（mock 子代理 + 真实 cw CLI）。
  - `CHANGELOG.md` — 测试断言数历史快照（如「107 → 118 项全过」）。
  - `CHANGELOG.md` — 文档同步存证条目，将测试与文档改写配对。