---
title: 代码引擎模块（code_engine_module）总览
type: module
source_files:
  - lib/engine/apply-plan.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/fsoft_runtime.py
  - lib/engine/python/stage_map.py
  - lib/engine/quality-gate.js
  - lib/engine/workspace-snapshot.js
tags: []
generated_by: fsoft-native
fsoft_page: code_engine_module.md
---
# 代码引擎模块（code_engine_module）总览

`code_engine_module` 是 DSH CodeWiki 扩展中**驱动 Python FSoft 原生引擎完成知识库编译**的完整子系统。它把「一次编译」固定为一条单向裁决链——从环境指纹、增量决议、模型桥、子进程协议、产物映射与自洽校验、采用门、受管状态采集，到原子落地与严格终态合成——确保任何一步的失败都不能被后续步骤洗成 `done`。

它存在的根本动因是 0.14.0 的教训：「1 篇成功 + 19 篇失败也报 done」。模块因此用版本化契约（[engine_contracts](engine-contracts.md)）、三类可机读裁决（[quality_gates](quality-gates.md) 的 defect / degradation / stale）和最弱终态合成（`weakest(engine, gate, apply)`）把模糊终态全部消灭。

## 模块架构

```mermaid
flowchart TB
    subgraph 编排层["编排与裁决层"]
        NRS["native_runtime_support<br/>runNativeJob 裁决链"]
        WSS["workspace_snapshots<br/>合成含未提交改动的临时 commit"]
        EMS["engine_manifest_management<br/>引擎环境指纹与锁定"]
    end

    subgraph 协议层["跨进程协议层"]
        EC["engine_client<br/>runEngine + JSON-lines 解析"]
        PCT["python_native_runtime<br/>entry.py 薄入口 + 进度桥接"]
        ECT["engine_contracts<br/>EngineResult / Progress / Error"]
    end

    subgraph 模型层["模型凭证隔离层"]
        LIB["llm_integration_bridges<br/>loopback OpenAI 桥"]
    end

    subgraph 产物层["产物处理与落地层"]
        MOI["module_indexing<br/>docs 树 → cw 写集映射"]
        EOP["engine_output_processing<br/>读 docs + 自洽校验"]
        QG["quality_gates<br/>gateNativeOutput 采用门"]
        PA["plan_application<br/>applyNativeOutput 原子落地"]
    end

    subgraph 状态层["增量持久化层"]
        NSM["native_state_management<br/>跨轮 _native-state 水合/采集"]
    end

    NRS --> EMS
    NRS --> WSS
    NRS --> NSM
    NRS --> LIB
    NRS --> EC
    EC --> PCT
    PCT --> FSOFT["FSoft codewiki 引擎<br/>图/聚类/写作（外部依赖）"]
    PCT -. "OpenAI 请求" .-> LIB
    LIB -. "llm.stream" .-> HOST["宿主 llm 服务"]
    EC --> ECT
    NRS --> EOP
    EOP --> MOI
    EOP --> QG
    QG --> PA
    PA --> NSM
```

## 一次编译的裁决链

```mermaid
flowchart TD
    A["开始 runNativeJob"] --> B{"信号已取消?"}
    B -->|"是"| Z["settle: cancelled"]
    B -->|"否"| C["环境校验 doctor + 锁比对"]
    C --> D{"锁状态?"}
    D -->|"drift / unhealthy / probe-failed"| E["settle: failed<br/>不跑引擎"]
    D -->|"absent / match"| F["增量决议<br/>change-set + _native-state"]
    F --> G{"能否增量?"}
    G -->|"不满足"| H["resolution = FULL"]
    G -->|"满足"| I["resolution = UPDATE<br/>hydrateDocsDir"]
    I --> K["工作区快照<br/>createWorkspaceSnapshot"]
    H --> K
    K --> L["建立模型桥 startLlmBridge"]
    L --> O["调用引擎 runEngine: generate | update"]
    O --> P{"引擎终态?"}
    P -->|"cancelled / failed"| Q["settle: 对应终态"]
    P -->|"done / partial"| S["产物留档 + 质量门 gateNativeOutput"]
    S --> W["采集受管状态 captureDocsDir"]
    W --> X["首次落锁 buildLockBody → extraFiles"]
    X --> Y["孤儿页扫描 findOrphanPages"]
    Y --> Z2["落地器 applyNativeOutput<br/>写盘 → cw index → 基线 → 提交"]
    Z2 --> AC["严格合成终态<br/>weakest(engine, gate, apply)"]
    AC --> AD["settle: finalOutcome"]
```

## 核心不变量

| # | 不变量 | 实现位置 |
|---|--------|----------|
| 1 | 锁不一致 / 依赖不闭合 → 直接 `failed`，**不跑引擎** | [engine_manifest_management](engine-manifest-management.md) |
| 2 | 引擎 `done` 不能替代质量门：gate 说 `partial`，终态就是 `partial` | [quality_gates](quality-gates.md) |
| 3 | 落地器说 `partial`/`failed`，终态不许是 `done` | [plan_application](plan-application.md) |
| 4 | 写集封闭：只写 `.codewiki/` 与根 `CodeWiki.md`，白名单外路径整批拒写 | [plan_application](plan-application.md) |
| 5 | 水合是**复制**而不是移动；只有「完整成功」才把本轮状态写成下一轮基线 | [native_state_management](native-state-management.md) |
| 6 | 桥自始至终看不见真实凭证——真实 key 只存在于宿主 provider 内部 | [llm_integration_bridges](llm-integration-bridges.md) |

## 核心组件文档

| 模块 | 职责一句话 |
|------|-----------|
| [native_runtime_support](native-runtime-support.md) | 最关键的编排层：把环境校验、增量决议、引擎调用、质量门、落地固定成一条单向裁决链 |
| [engine_contracts](engine-contracts.md) | 跨进程契约层：版本化的 `EngineResult` / `EngineProgress` / `EngineError` 与终态语义硬不变量 |
| [engine_client](engine-client.md) | Node ↔ Python 唯一跨语言边界：`runEngine` 进程编排 + `createProtocolReader` 增量 JSON-lines 解析 |
| [python_native_runtime](python-native-runtime.md) | Python 侧薄入口：协议守卫、五段→八段进度映射、异常分类与 `_salvage` 部分成功交付 |
| [llm_integration_bridges](llm-integration-bridges.md) | 凭证隔离层：loopback OpenAI 桥 + 纯转换层，让引擎的 OpenAI 客户端落到宿主 `llm.stream` |
| [engine_manifest_management](engine-manifest-management.md) | 引擎环境指纹与锁定：版本 + Python + 上游 commit 的 sha256 漂移判定与 `engine-lock.json` 落盘 |
| [workspace_snapshots](workspace-snapshots.md) | 输入对齐：用独立 `GIT_INDEX_FILE` 合成含未提交改动的临时 commit（不写 ref），纠正记账基线 |
| [module_indexing](module-indexing.md) | 格式翻译层：FSoft docs 树 → cw 写集计划的唯一纯函数映射边界（不臆造 `source_files`） |
| [engine_output_processing](engine-output-processing.md) | 阶段 2：读 `docs/` 为结构化事实、调映射、对产物自洽性给出可机读 `problems` |
| [quality_gates](quality-gates.md) | 采用门：把产物自洽问题、入口页、逐篇契约、基线可推进性合成 `GateReport` |
| [plan_application](plan-application.md) | 原子落地器：写集校验 → pre-image 快照 → 写盘 → `cw index` → 基线 → 自动提交，失败整体回滚 |
| [native_state_management](native-state-management.md) | 跨轮增量持久化底座：`.codewiki/_native-state/` 的水合、采集、消费与回滚语义 |