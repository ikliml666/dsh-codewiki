---
title: engine_contract
type: module
source_files:
  - lib/engine/contract.js
  - test-engine-contract.mjs
  - lib/engine/client.js
  - lib/engine/mapping.js
tags: [engine, contract, protocol, validation, fsoft]
---

## Overview

`lib/engine/contract.js` 是迁移（阶段 0/2，把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」）里的**跨进程契约层**。迁移后 Node 不再自己算依赖图/聚类/增量，一切都来自 Python 引擎的一次返回。这条边界一旦含糊，后面每个消费方（JobService 终态判定、面板、cw 基线、自动提交、降级提醒）都会各自猜「引擎到底成功了没有」——这正是 0.14.0 花一整轮修掉的缺陷类型（1 篇成功 + 19 篇失败也报 done）。

所以这一层把三件事固定下来（见 `lib/engine/contract.js:1-18`）：

- `EngineResult`（`engineResult`）——一次 `generate`/`update` 的完整结果，版本化、可校验；
- `EngineProgress`（`engineProgress`）——推进中的阶段/计数快照，面板与 tick 共用；
- `EngineError`（`engineError`）——可机读失败事实，`code` 决定重试语义，`message` 只给人看。

此外提供 `validateEngineResult`（反序列化边界上的逐条校验，不抛错）与 `describeEngineResult`（终态文案，与 `lib/update-record.js` 的 `describeOutcome` 同一口径）。

本模块刻意只做**纯数据校验**：不碰文件、不碰进程、不碰模型（见 `lib/engine/contract.js:18`）。所有导出都是纯函数，因而能被 TDD 钉死（`test-engine-contract.mjs`）。

### 语义硬不变量

由 `engineResult` 与 `validateEngineResult` 双重保证（见 `lib/engine/contract.js:12-17`）：

| outcome | 不变量 | 违反时 |
| --- | --- | --- |
| `done` | 完整成功，**不许**带 `blockers` | `engineResult` 抛错；`validateEngineResult` 记 `outcome=done 却带 blockers` |
| `partial` | 部分完成，**必须**带至少一条 `blockers`（否则等于伪装成功） | `engineResult` 抛错；`validateEngineResult` 记 `outcome=partial 却没有 blockers` |
| `failed` | 失败，必须带 `error` | `engineResult` 抛错；`validateEngineResult` 记 `outcome=failed 却缺 error` |
| `cancelled` | 取消，可带 `blockers` 说明已写成的部分 | 合法 |

## Key Components

### 常量（枚举/码表）

- `ENGINE_CONTRACT_VERSION`（`lib/engine/contract.js:20`）——契约当前版本号，恒为 `1`（未 `Object.freeze`，但测试断言其为显式数字，`test-engine-contract.mjs:44`）。
- `ENGINE_STAGES`（`lib/engine/contract.js:24-33`）——阶段枚举，**是契约不是实现细节**：面板步骤条、job.stage 映射、取消检查点都按它对齐。顺序即推进顺序；`env` 最前（Python 解释器/venv/依赖锁定），`commit` 最后（自动提交）。八个阶段：`env`、`graph`、`cluster`、`articles`、`validate`、`index`、`baseline`、`commit`。
- `TERMINAL_OUTCOMES`（`lib/engine/contract.js:35`）——`Object.freeze(['done', 'partial', 'failed', 'cancelled'])`，终态判定用的四态集合。
- `BLOCKER_KINDS`（`lib/engine/contract.js:42-53`）——`Object.freeze` 的阻塞原因类别列表（机读、稳定、可被终态判定与面板文案共用）。新增只允许追加、不允许改名。包含：`article-failed`、`article-missing`、`unmapped-change`、`unmapped-page`、`quality-gate`、`index-failed`、`baseline-failed`、`commit-failed`、`engine-error`、`cancelled`（`lib/engine/contract.js:43-52`）。
- `ENGINE_ERROR_CODES`（`lib/engine/contract.js:57-67`）——`Object.freeze` 的失败码表：`engine-missing`、`engine-deps`、`engine-timeout`、`engine-cancelled`、`engine-crashed`、`engine-protocol`、`engine-model`、`engine-output`、`engine-unknown`（`lib/engine/contract.js:58-66`）。

内部导出（非公开但被使用）：`OUTCOME_SET`（`lib/engine/contract.js:37`）、`STAGE_SET`（`lib/engine/contract.js:38`）、`BLOCKER_SET`（`lib/engine/contract.js:55`）、`ERROR_CODE_SET`（`lib/engine/contract.js:69`）、`RETRYABLE_CODES`（`lib/engine/contract.js:71`，`Set(['engine-timeout', 'engine-model', 'engine-unknown'])`）——可重试的码，其余一律视为确定性失败。

### 辅助函数

- `num(v)`（`lib/engine/contract.js:73-76`）——把值归一成「有限且 >0 的数」，否则返回 `0`。供所有计数与 token 字段复用。
- `normalizeUsage(usage)`（`lib/engine/contract.js:78-86`）——把用法对象归一为 `{ inputTokens, outputTokens, cachedTokens, requests }` 四字段，缺失或非法一律 `0`。
- `normalizeBlocker(b)`（`lib/engine/contract.js:88-94`）——归一单个阻塞项：`kind` 必须是 `BLOCKER_SET` 成员，否则回退 `'engine-error'`；`detail` 截到 2000 字符；`target`/`source` 若存在则保留为字符串。

### 公开函数

- `engineResult(input = {})`（`lib/engine/contract.js:97-147`）——构造一次 `generate`/`update` 的完整结果。**非法输入抛错而非静默归一**（契约破坏必须响）。返回的 `EngineResult` 对象完整字段如下：
  - `contractVersion: ENGINE_CONTRACT_VERSION`（`:114`）
  - `outcome`（`:115`）——字符串，必须 ∈ `TERMINAL_OUTCOMES`，否则 `:99-101` 抛错
  - `stage`（`:117`）——引擎侧阶段终态，必须 ∈ `STAGE_SET`，否则置 `null`
  - `blockers`（`:118`）——`input.blockers` 经 `normalizeBlocker` 映射；`done` 带 blockers 在 `:103-105` 抛错，`partial` 无 blockers 在 `:106-108` 抛错
  - `error`（`:109-119`）——`input.error` 经 `engineError` 归一；`failed` 缺 error 在 `:110-112` 抛错
  - `writtenCount`、`failedCount`、`keptCount`、`removedCount`、`unmappedCount`（`:120-124`）——均经 `num` 归一（非负、缺省 0）
  - `usage`（`:125`）——`normalizeUsage` 结果
  - `engine`（`:127-137`）——`{ version, commit, python, deps }`，doctor 产物，用于面板展示与回滚取证
  - `artifacts`（`:139-143`）——`{ docsDir, rawTreeDir, updateRecord }`，产物位置
  - `startedAt`、`finishedAt`（`:144-145`）——字符串时间戳或 `null`
- `engineProgress(input = {})`（`lib/engine/contract.js:150-168`）——推进中快照，tick 与面板共用，字段只增不减。返回的 `EngineProgress` 对象：
  - `contractVersion`（`:158`）、`stage`（`:151` 及 `:152-154` 校验）、`percent`（`:155-156`，夹到 0–100 并四舍五入）、`message`（`:161`）
  - `writtenCount`、`failedCount`、`totalCount`（`:162-164`，经 `num`）、`usage`（`:165`）、`at`（`:166`，时间戳或 `null`）
- `engineError(input = {})`（`lib/engine/contract.js:171-182`）——可机读失败事实：
  - `code`（`:173`）——`input.code` 若 ∈ `ERROR_CODE_SET` 则保留，否则归 `'engine-unknown'`
  - `message`（`:176`，截到 4000 字符）
  - `stage`（`:177`，∈ `STAGE_SET` 或 `null`）
  - `retryable`（`:178`）——`RETRYABLE_CODES.has(code)`
  - `rawCode`（`:180`）——仅当 `code === 'engine-unknown'` 且原 code 非空时保留前 200 字符，便于排障
- `validateEngineResult(value)`（`lib/engine/contract.js:186-220`）——校验「可能来自外部/旧版本/磁盘」的结果对象。**不抛错**，返回 `{ ok, errors }`。检查项：必须是对象（`:188-190`）、`contractVersion` 匹配（`:191-193`）、`outcome` 合法与四态自洽（`:194-200`）、五个计数字段非负（`:201-206`）、`blockers` 是数组且每项 `kind` 已登记（`:207-215`）、`failed` 必须带 `error`（`:216-218`）。
- `describeEngineResult(result)`（`lib/engine/contract.js:223-239`）——终态文案。四态可一眼分清：`done`→「完成（写入 N 篇）」、`partial`→「部分完成（写入 N 篇、M 篇未完成）：首个阻断原因」、`failed`→「失败：message」、`cancelled`→「已取消（已写入 N 篇）」；不可读对象返回「引擎结果不可读」。

> 备注：`EngineResult` / `EngineProgress` / `EngineError` 在本模块内是普通 JS 对象（由上述工厂函数构造），没有独立的 class 定义，因此无独有属性方法、`__str__`、`save()` 等；它们只有上面列出的数据字段。`mapFsoftOutput`（在 `lib/engine/mapping.js`）的返回结构也带 `contractVersion`（`lib/engine/mapping.js:256`），但与 `EngineResult` 是不同的形状。

## Architecture

本模块是 `lib/engine/` 子系统的「契约核心」。它不 spawn、不读写文件，纯函数被上下两层包夹：上层（`client.js` 协议/进程层、`output.js` 产物校验层、`mapping.js` 映射层）生产结果对象，下游（JobService 终态判定、面板、cw 索引、自动提交、降级提醒）消费结果对象。

```text
                FSoft 原生引擎 (Python 子进程)
                          │ stdout: JSON-lines (progress / result / error)
                          ▼
        ┌─────────────────────────────────────────────┐
        │ lib/engine/client.js  (协议/进程层)           │
        │  createProtocolReader / runEngine            │
        │   产出 → engineProgress / engineResult ──────┐│
        │   失败 → engineError ─────────────────────┐  ││
        └──────────────────────────────────────────│──│┘
                                                   │  │
        docs 产物目录 ──► output.js ──► mapping.js  │  │
        (collectOutput / buildWritePlan /          │  │
         validateOutput)      (mapFsoftOutput)     │  │
                                                   │  │
        ┌──────────────────────────────────────────▼──▼┐
        │ lib/engine/contract.js  (本模块·纯函数)        │
        │  ENGINE_* 枚举/码表                           │
        │  engineResult / engineProgress / engineError  │
        │  validateEngineResult (反序列化校验)           │
        │  describeEngineResult (终态文案)               │
        └──────────────────────────────────────────────┘
                          │
                          ▼
        消费方：JobService 终态判定 / 面板 / cw 基线 /
                自动提交 / 降级提醒
```

模块内函数关系（验证/归一是共享内环）：

```text
  engineResult ──► normalizeBlocker ─┐
       │            normalizeUsage ──┤
       ├─► engineError ──────────────┤
       │            (RETRYABLE_CODES) │
  engineProgress ─► normalizeUsage ──┤
                                     │
  validateEngineResult ── 查 OUTCOME_SET / STAGE_SET / BLOCKER_SET
                                     │
  describeEngineResult ── 取 result.blockers[0] / result.error.message
```

> 说明：`contract.js` 被 `client.js`（`lib/engine/client.js:23`）、`mapping.js`（`lib/engine/mapping.js:28`）直接 import；`output.js` 经由 `mapping.js` 间接受其 `ENGINE_CONTRACT_VERSION` 约束（见 `lib/engine/output.js` 注释与 `mapping.js:256`）。本模块自身只 import 标准库（无外部依赖）。

## Data Flow

本模块处于「引擎 → 消费方」的中间纯函数层，自身不产生数据，只接收原始对象并输出归一/校验后的对象。典型链路：

1. **协议归一路（实时）**：Python 引擎向 stdout 写 JSON-lines；`lib/engine/client.js` 的 `createProtocolReader.handleLine`（`lib/engine/client.js:56-126`）按 `type` 分派——
   - `progress` → `engineProgress(msg)`（`lib/engine/client.js:90`）
   - `error` → `engineError(msg.error ?? msg)`（`lib/engine/client.js:100`）
   - `result` → `engineResult(msg.result ?? {})`（`lib/engine/client.js:115`）；非法（含 `done` 带 blockers 等自相矛盾）会抛错并被记作 `bad-result` violation（`lib/engine/client.js:118-121`）
   - 进程层失败（超时/崩溃/协议破坏/取消）由 `runEngine` 的 `fail`/`finish` 直接构造 `engineResult({ outcome: 'failed' | 'cancelled', ... })`（`lib/engine/client.js:275`、`:383`）。
   最终 `finish` 把 `contractVersion: ENGINE_CONTRACT_VERSION` 再盖到结果上（`lib/engine/client.js:253`）。

2. **反序列化校验路（磁盘/旧版本）**：当结果来自磁盘残留、旧版本 payload 或不可信外部输入时，走 `validateEngineResult(value)`（`lib/engine/contract.js:186`），逐条返回 `errors` 而非抛错——因为反序列化边界的对象必须被检查而不是被信任（`:184-185`）。这是 `engineResult` 抛错路径之外、专门用于「软校验」的入口。

3. **产物映射路（写入前）**：`lib/engine/mapping.js` 的 `mapFsoftOutput` 用 `ENGINE_CONTRACT_VERSION` 给自己的写集描述打版本戳（`lib/engine/mapping.js:256`），与 `EngineResult` 是不同的形状，但共用同一个版本号常量，保证版本语义统一。该路径不直接调用 `engineResult`/`validateEngineResult`，而是通过共享常量与 `output.js` 的校验结果（`OUTPUT_PROBLEM_KINDS`）协同判 `partial`。

4. **展示/终态文案路**：`describeEngineResult(result)`（`lib/engine/contract.js:223`）把归一后的结果转成四态可读文案，供面板与终态判定展示；其口径与 `lib/update-record.js` 的 `describeOutcome` 对齐（`lib/engine/contract.js:222`）。

## Connections

- [[engine-client]] —— `lib/engine/client.js` 是本模块最主要的直接消费方：`createProtocolReader` 在解析每条协议消息时调用 `engineProgress`/`engineError`/`engineResult`（`lib/engine/client.js:90,100,115`），`runEngine` 在超时/崩溃/取消等进程层失败时构造 `engineResult`（`lib/engine/client.js:275,383`）。协议层的所有「可机读失败」最终都落到本模块的 `engineError`/`ENGINE_ERROR_CODES` 语义上。
- [[engine-mapping]] —— `lib/engine/mapping.js` 直接 import 本模块的 `ENGINE_CONTRACT_VERSION`（`lib/engine/mapping.js:28`），用它给 `mapFsoftOutput` 的写集描述打版本戳（`lib/engine/mapping.js:115`）。本模块定义的 `BLOCKER_KINDS`（`unmapped-page` 等）与 mapping 的「不静默丢弃」硬规则同源。
- [[engine-output]] —— `lib/engine/output.js` 经 `mapping.js` 间接依赖本模块；它把产物自洽性判成 `OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:22-34`），上层据此把一次编译降为 `partial`——这与本模块 `partial` 必须带 `blockers` 的语义互为表里。
- [[engine-manifest]] —— `lib/engine/manifest.js` 同属 `lib/engine/` 子系统，回答「跑的是哪个引擎/环境」，其 doctor 产物（`engine.version`/`engine.commit`/`engine.python`）正好是 `engineResult` 返回的 `engine` 字段来源（`lib/engine/contract.js:127-137`）。
- [[update-record]] —— 终态文案 `describeEngineResult` 与 `lib/update-record.js` 的 `describeOutcome` 同一口径（`lib/engine/contract.js:222`）；JobService 终态判定是 `EngineResult.outcome` 的最终消费方。
- [[engine-bridge]] / [[engine-llm-bridge]] / [[engine-process-tree]] —— 同属 `lib/engine/` 跨语言边界子系统；`engine-process-tree` 提供 `terminateProcessTree` 供 `client.js` 取消进程树（`lib/engine/client.js:24,336`），与 `cancelled` 终态的 `blockers:[{kind:'cancelled'}]` 配合。

## Known Issues

- **`ENGINE_CONTRACT_VERSION` 未 `Object.freeze`**：与同模块其他枚举（`TERMINAL_OUTCOMES`/`BLOCKER_KINDS`/`ENGINE_ERROR_CODES` 等，见 `lib/engine/contract.js:57,42,57`）不同，该常量（`:20`）只是 `export const ENGINE_CONTRACT_VERSION = 1`，没有冻结。目前仅测试断言其为显式数字（`test-engine-contract.mjs:44`），运行期若被改写不会被拦。属于小隐患，非功能缺陷。
- **`validateEngineResult` 不校验 `engine`/`artifacts`/`usage`/`startedAt`/`finishedAt` 子结构**：该函数（`lib/engine/contract.js:186-220`）只覆盖了 `outcome`、`blockers`、`error` 与五个计数字段；`engine`/`artifacts`/`usage` 等子对象若为畸形（如 `startedAt` 非字符串）不会被检出。这依赖上游 `engineResult` 先归一，因此 `validateEngineResult` 定位为「软兜底」而非「完整 schema 校验」——磁盘残留若绕过 `engineResult` 直接构造对象，这些字段可能失真。
- **`num` 把负数/NaN 全部归 0 而非报错**：`lib/engine/contract.js:73-76` 与五计数归一（`:120-124`）对非法输入一律返回 `0`，而非像 `engineResult` 对 `outcome` 那样抛错。这意味着「引擎报出 `-1` 篇」会被静默当成 0 篇，依赖上层 `output.js` 的 `validateOutput` 用 `problems` 暴露缺页，而不是靠契约层拦截。
- **`done` 带 blockers 在 `validateEngineResult` 下只报 errors 不抛错**：`engineResult` 在构造时直接抛错（`:103-105`），但如果一个 `done + blockers` 的对象是从磁盘/旧版本反序列化进来、`validateEngineResult` 路径会把它记为 `['outcome=done 却带 blockers']`（`lib/engine/contract.js:196-197`）并返回 `ok:false`——两条路径语义一致（都拒绝），但调用方必须区分「构造期抛错」与「校验期 errors」，不能假设所有非法对象都会在 `engineResult` 阶段被拦下。
- **`describeEngineResult` 的 `partial` 文案只取首个 blocker**：`lib/engine/contract.js:223-224` 仅取 `blockers[0].detail || blockers[0].kind`，多阻塞项时其余不展示；若首个 blocker 既无 `detail` 也无 `kind` 会落到「存在未消化项」兜底文案（`:226`）。这是展示层取舍，不涉及终态判定。
