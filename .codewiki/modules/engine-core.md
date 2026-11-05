---
title: 引擎核心（engine_core）
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
  - lib/engine/proofread.js
  - lib/engine/quality-gate.js
  - lib/engine/wiki-links.js
  - lib/engine/workspace-snapshot.js
  - lib/wiki-notes.js
tags: []
generated_by: fsoft-native
fsoft_page: engine_core.md
---
# 引擎核心（engine_core）

## 模块定位

`engine_core` 是 CodeWiki **原生编译通道**（`nativeEngine: true`，自 0.16.0 起为默认通道）在 Node 侧的引擎核心，位于 `engine_runtime_and_codewiki_kernel` 之下。它本身**不实现聚类、图 diff、文章写作等算法**——这些全部由 FSoft Python 引擎作为受管子进程完成；`engine_core` 负责的是跨语言边界上的四件大事：

1. **起管杀引擎**：以受管子进程方式拉起 Python 引擎，用 JSON-lines 协议收发请求，做超时 / 静默卡死 / 用户取消 / 进程树整树终止；
2. **立契约**：把引擎消息归一为版本化的 `EngineResult` / `EngineProgress` / `EngineError`，并把 docs 树翻译成 `.codewiki/` 写集；
3. **通模型**：在 loopback 上起 OpenAI 兼容桥，用宿主凭证调真实 provider，插件自身不保存也不传递密钥；
4. **裁决与入库**：把引擎产出经过「执行编排 → 质量门 → 原子落地」三段流水线，合成严格终态（`cancelled < failed < partial < done`），任何一环的结论都不许洗白下一步。

整个子系统的历史动机来自 0.14.0 缺陷（「引擎说 done 就 done、产物没入库也报完成」）与真机事故（静默卡死、迟到成功洗白取消、密钥落盘风险），因此核心验收标准是：**终态由整条裁决链的最弱环节决定，所有事实带证据进入终态**。

## 架构总览

```mermaid
flowchart TB
    subgraph UP["上游"]
        JOB["main_job_orchestrator<br/>JobService tick 循环"]
    end

    subgraph CORE["engine_core 引擎核心"]
        EO["engine_orchestration<br/>进程级编排：spawn / JSON-lines / 超时静默取消 / 环境指纹 / 产物自洽校验"]
        VC["article_validation_and_contract<br/>契约与校验：EngineResult 构造校验、产物写集映射、死链校对、链接正则"]
        LB["llm_bridge_integration<br/>LLM 桥：loopback OpenAI 端点 → 宿主 llm.stream"]
        NA["native_apply_and_quality_gate<br/>裁决与入库：执行编排 → 质量门 → 原子落地 → 严格终态"]
    end

    subgraph DOWN["下游与外部"]
        PY["engine_python_runtime<br/>entry.py 子进程（聚类 / 图 diff / 写作）"]
        HL["宿主 llm.stream<br/>真实凭证只存在于宿主内部"]
        REPO[".codewiki/ + CodeWiki.md<br/>已提交的 wiki 仓库"]
        PANEL["client_panel_ui<br/>步骤条、终态与会话视图"]
    end

    JOB --> NA
    NA -->|"doctor / generate / update"| EO
    EO -->|"spawn 子进程 + 一行 JSON 请求"| PY
    PY -->|"OpenAI HTTP，占位 key"| LB
    LB --> HL
    EO -->|"result 归一 + docs 树"| VC
    VC -->|"写集 + problems 列表"| NA
    NA -->|"写盘 / cw index / 自动提交"| REPO
    NA -->|"weakest 合成终态"| JOB
    NA --> PANEL
    LB -->|"onRequestStart 钩子"| PANEL
```

## 一次编译的数据流

```mermaid
sequenceDiagram
    participant Job as main_job_orchestrator
    participant NA as native-run 裁决链
    participant EO as runEngine
    participant PY as Python 引擎子进程
    participant LB as LLM 桥
    participant VC as 契约 / 映射 / 质量门
    participant AP as applyNativeOutput

    Job->>NA: runNativeJob(repoRoot, scope)
    NA->>EO: doctor 环境指纹校验
    Note over NA: 锁漂移或依赖不闭合则直接 failed，不跑引擎
    NA->>EO: runEngine(action=generate / update)
    EO->>PY: spawn 子进程（detached 进程组）
    PY->>LB: POST /v1/chat/completions（占位 key）
    LB-->>PY: 宿主 llm.stream 翻译回的 SSE / completion
    PY-->>EO: progress 帧 + result JSON-lines
    EO->>VC: validateOutput 六项自洽校验
    VC-->>NA: problems 列表 + mapFsoftOutput 写集
    NA->>NA: gateNativeOutput 质量门
    Note over NA: 有 dead-link 源页则 proofread 改写后重新过门
    NA->>AP: applyNativeOutput(report, extraFiles)
    AP-->>NA: 写盘 → cw index → 基线推进 → 自动提交
    NA-->>Job: weakest(engine, gate, apply) 严格终态 + 三段现场证据
```

## 核心组件文档

| 子模块 | 职责 | 文档 |
| --- | --- | --- |
| 引擎编排 | Node ↔ Python 唯一跨语言边界：起 / 管 / 杀子进程、JSON-lines 协议六条不变量、环境指纹锁定（`engine-lock.json`）、产物自洽校验（11 种 problem kind） | [engine_orchestration](engine-orchestration.md) |
| 文章校验与契约 | 跨进程结果契约（四态终态硬不变量、blocker / error / stage 枚举）、FSoft 产物 → `.codewiki/` 写集映射（四条迁移安全硬规则）、单轮 LLM 死链校对、链接扫描唯一正则源 | [article_validation_and_contract](article-validation-and-contract.md) |
| LLM 桥接集成 | 进程内 loopback OpenAI 兼容端点：占位 key + 随机端口 + `127.0.0.1` 绑定三层防护，把引擎请求翻译成宿主 `llm.stream`，流式逐帧 SSE 回传；凭证绝不落盘、不进日志 | [llm_bridge_integration](llm-bridge-integration.md) |
| 原生产物落地与质量门 | 原生通道中段裁决与入库子系统：`runNativeJob` 直线裁决链、`gateNativeOutput` 唯一采用门（defect / degradation / stale 三分）、`applyNativeOutput` 原子落地与 pre-image 回滚 | [native_apply_and_quality_gate](native-apply-and-quality-gate.md) |

## 关键设计原则

- **最弱环终态**：引擎、质量门、落地器三段结论取最弱值；`done` 不许带 blockers，`partial` 必须带 blockers，终态合法性由统一出口保证。
- **契约破坏必须响**：构造期非法输入抛错，反序列化期返回逐条 errors；取消是终态，迟到的 `result` 记 `late-result` 丢弃，绝不洗白。
- **边界刻意窄**：进程编排层不做写作、不连模型、不修环境；模型通道由 LLM 桥单独承担，且桥自身不持有任何 provider 配置。
- **证据宁缺勿造**：`source_files`、归属、基线推进都只信可机读证据；没证据就空数组 + warning，绝不臆造。
- **修正文不改判据**：proofread 只修模型幻觉造成的死链，改写后必须重新过质量门；门的标准绝不因校对放松。