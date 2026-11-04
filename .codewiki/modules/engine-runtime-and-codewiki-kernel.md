---
title: 引擎运行时与 CodeWiki 内核（engine_runtime_and_codewiki_kernel）
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
  - lib/engine/python/entry.py
  - lib/engine/python/fsoft_runtime.py
  - lib/engine/python/full_parallel_runtime.py
  - lib/engine/python/stage_map.py
  - lib/engine/python/tree_coverage.py
  - vendor/codewiki/src/config.rs
  - vendor/codewiki/src/frontmatter.rs
  - vendor/codewiki/src/main.rs
  - vendor/codewiki/src/meta.rs
  - vendor/codewiki/src/setup.rs
tags: []
generated_by: fsoft-native
fsoft_page: engine_runtime_and_codewiki_kernel.md
---
# 引擎运行时与 CodeWiki 内核（engine_runtime_and_codewiki_kernel）

## 模块定位

`engine_runtime_and_codewiki_kernel` 是 CodeWiki **原生编译通道**的运行时内核，位于任务编排层与真实算法引擎、wiki 仓库之间。它本身不实现依赖图构建、模块聚类、图 diff 或文章写作算法，而是负责把这些能力安全地串成一次可裁决、可落库、可观测的编译事务。

该模块由三个直接子模块组成：

- **[engine_core](engine-core.md)**：Node 侧引擎核心。负责拉起并受管 Python 引擎、归一化跨语言消息、提供 loopback LLM 桥、执行「执行编排 → 质量门 → 原子落地」裁决链。
- **[engine_python_runtime](engine-python-runtime.md)**：Python 薄运行时层。围绕 FSoft Python 引擎做 JSON-lines 协议转换、阶段翻译、受控并行与崩溃自救。
- **[vendored_codewiki](vendored-codewiki.md)**：随仓库 vendored 的 Rust `cw` CLI。负责 `.codewiki/` 骨架、索引重建、基线推进、过期检测与 agent 技能安装。

核心验收标准是：**终态由引擎、质量门、落地器三段裁决链的最弱环节决定，所有事实必须带证据进入终态，凭证绝不落盘或进日志。**

## 架构总览

```mermaid
flowchart TB
    JOB["上游 main_job_orchestrator<br/>触发 runNativeJob(repoRoot, scope)"]

    subgraph KERNEL["engine_runtime_and_codewiki_kernel"]
        EC["engine_core（Node 侧）<br/>进程编排 / 契约校验 / LLM 桥 / 质量门与原子落地"]
        PY["engine_python_runtime（Python 侧）<br/>JSON-lines 薄入口 / 阶段翻译 / 受控并行"]
        CW["vendored_codewiki（Rust cw CLI）<br/>init / index / meta update / status"]
    end

    FSOFT[("FSoft Python 引擎<br/>外部 venv：依赖图 / 聚类 / 文章写作")]
    HOST["宿主 llm.stream<br/>真实凭证只存在于宿主进程"]
    REPO[("仓库内 .codewiki/ 知识库<br/>_meta.yaml / _index.md / 文章 frontmatter")]
    PANEL["client_panel_ui<br/>步骤条 / 终态 / 会话视图"]

    JOB --> EC
    EC -->|"spawn 子进程，JSON-lines 收发"| PY
    PY -->|"方法替换适配器，不改 vendor 源码"| FSOFT
    PY -->|"OpenAI HTTP 请求，占位 key"| EC
    EC -->|"loopback 桥接到宿主模型"| HOST
    EC -->|"spawnSync 调用 cw"| CW
    PY -->|"产出文章与状态文件"| REPO
    CW -->|"读写骨架、索引、基线"| REPO
    EC -->|"写文章 / 删孤儿页 / 自动提交"| REPO
    EC -->|"weakest 合成终态与证据"| JOB
    EC --> PANEL
```

## 一次编译的数据流

```mermaid
sequenceDiagram
    participant Job as main_job_orchestrator
    participant Core as engine_core
    participant Py as engine_python_runtime
    participant FSoft as FSoft Python 引擎
    participant Host as 宿主 llm.stream
    participant CW as vendored cw
    participant Repo as .codewiki 知识库

    Job->>Core: runNativeJob(repoRoot, scope)
    Core->>Core: doctor 环境指纹校验
    Core->>Py: spawn 子进程，action generate 或 update
    Py->>FSoft: 安装全量或增量并行适配器
    FSoft->>Core: OpenAI loopback 请求，占位 key
    Core->>Host: 翻译为真实 provider 调用
    Host-->>Core: SSE 或 completion
    Core-->>Py: 模型响应回传
    Py-->>Core: progress 帧与 result JSON-lines
    Core->>Core: validateOutput，mapFsoftOutput，gateNativeOutput
    Core->>CW: cw init，cw index，cw meta update
    CW->>Repo: 写骨架，索引，基线
    Core->>Repo: 写盘，删孤儿页，自动提交
    Core-->>Job: weakest(engine, gate, apply) 严格终态
```

## 核心组件文档

| 组件 | 核心职责 | 文档 |
| --- | --- | --- |
| `engine_core` | Node ↔ Python 跨语言边界、进程受管、版本化契约、LLM loopback 桥、质量门与原子落地 | [engine_core](engine-core.md) |
| `engine_python_runtime` | FSoft Python 引擎薄适配层：协议转换、五段进度到八段契约映射、全量/增量并行、stdout 守卫与崩溃自救 | [engine_python_runtime](engine-python-runtime.md) |
| `vendored_codewiki` | Rust `cw` CLI：`.codewiki/` 生命周期管理、索引重建、基线推进、过期文章判定、agent 技能安装 | [vendored_codewiki](vendored-codewiki.md) |

`engine_core` 内部进一步划分为四个职责域，详见其文档：

- **引擎编排**：起管子进程、JSON-lines 协议不变量、环境指纹锁定、产物自洽校验。
- **文章校验与契约**：`EngineResult` 构造校验、FSoft 产物到 `.codewiki/` 写集映射、死链校对。
- **LLM 桥接集成**：loopback OpenAI 兼容端点，把引擎请求翻译为宿主 `llm.stream`。
- **原生产物落地与质量门**：`runNativeJob` 裁决链、`gateNativeOutput` 唯一采用门、`applyNativeOutput` 原子落地与 pre-image 回滚。

## 关键设计原则

- **最弱环终态**：`cancelled < failed < partial < done`，引擎、质量门、落地器三段结论取最弱值；迟到的成功结果只记证据，绝不洗白取消或失败。
- **边界刻意窄**：Python 运行时不读本机凭证库，Node 桥不持有 provider 配置，`cw` 只负责知识库记账而不负责编译算法。
- **索引即正确性判据**：文章写盘后必须经 `cw index` 收录；若索引与写集不一致，落地器整体回滚。
- **基线即记账**：`cw meta update` 只在正常轮且裁决允许时推进；失败会回滚已写文章，避免「文章比基线新」导致下一轮重复消费。
- **崩溃自救**：Python 运行时在模型失败或引擎崩溃时，若已写出文章则降为 `partial` 交付；一篇都没写出才判 `failed`。