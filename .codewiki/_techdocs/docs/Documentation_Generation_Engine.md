---
title: Documentation_Generation_Engine 模块概览
description: DocumentationGenerationEngine 是 CodeWiki 的文档生成引擎：它接收一次「为某个仓库生成或更新 wiki」的请求，把请求从环境探测推进到可机读的终态结论（done / partial / failed / cancelled），并且只把通过质量门的产物真正写进…
---

# Documentation_Generation_Engine 模块概览

!!! info "Generated documentation"
    This page was written by CodeWiki from the source code at commit [`bc7e15a2`](https://github.com/ikliml666/dsh-codewiki/commit/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26) on 2026-11-09 with `deepseek-v4.1-flash`. Check the code before relying on details.

`Documentation_Generation_Engine` 是 CodeWiki 的**文档生成引擎**：它接收一次「为某个仓库生成或更新 wiki」的请求，把请求从环境探测推进到可机读的终态结论（`done` / `partial` / `failed` / `cancelled`），并且只把通过质量门的产物真正写进 `.codewiki/` 与 `CodeWiki.md`。

它**不实现文章生成算法**：聚类、图 diff、写作都在 vendored 的 Python 引擎里（见 [Execution_Runtime___Vendored_Engine 概览](Execution_Runtime___Vendored_Engine.md)）。本模块实现的是围绕这台外部引擎的**全部工程约束**：跨语言进程协议、结果契约、质量裁决、跨轮状态记忆、模型桥接、变更采集、落地事务与回滚。整条设计主线只有一句：**每一步的结论都不能被下一步洗白**。

模块分为两个互补部分：

| 部分 | 角色 | 关键性质 |
| --- | --- | --- |
| [engine-core 模块概览](Documentation_Generation_Engine/engine-core.md) | 原生（FSoft）编译内核，五层结构 | 编排、裁决、状态、桥接、工具各司其职；只有 `apply-plan` 写盘 |
| [文章流水线（article-pipeline）](Documentation_Generation_Engine/article-pipeline.md) | 最靠近磁盘的一层：文章契约、存量修复、变更采集 | 三个模块以纯函数为主，可单测、可被门与落地器共用 |

## 架构

模块的依赖方向单一：工具层不认业务，裁决层不写盘，编排层不直接改仓库；`article-pipeline` 既向增量决议提供「这一轮改了什么」，又向质量门与落地器提供「这篇文章能不能入库」。

```mermaid
flowchart TD
    UI["ui-client 面板"] --> JOB["JobService<br/>任务调度与状态落账"]
    JOB -->|"提交编译请求"| ORC

    subgraph DGE["Documentation_Generation_Engine"]
        subgraph CORE["engine-core 原生编译内核"]
            ORC["engine-orchestration<br/>runNativeJob 裁决链"]
            AP["apply-plan<br/>唯一写盘通道"]
            CQ["engine-contract-quality<br/>契约词表与质量裁决"]
            SM["engine-state-manifest<br/>引擎清单与受管状态"]
            INT["engine-integrations<br/>模型桥与 TechDocs 回读"]
            RU["engine-runtime-utils<br/>产物读取与进程回收"]
        end
        PIPE["article-pipeline<br/>文章契约 / 存量修复 / 变更采集"]
    end

    ORC --> CQ
    ORC --> SM
    ORC --> INT
    ORC --> RU
    CQ --> RU
    CQ --> SM
    INT --> RU
    ORC --> AP

    ORC -->|"JSON-lines 协议"| PY["vendored Python 引擎<br/>entry.py"]
    PY -->|"POST /v1/chat/completions"| INT
    PIPE -->|"ChangeSet 增量依据"| ORC
    CQ -->|"inspectArticle / stripCode"| PIPE
    AP -->|"repairArticle / 存量体检"| PIPE

    AP --> REPO["仓库<br/>.codewiki/ 与 CodeWiki.md"]
    AP -->|"cw index / meta update"| CW["cw CLI"]
    AP -->|"自动提交"| GIT["git"]
    ORC -->|"EngineResult 终态"| JOB
```

| 层 | 职责 | 是否写盘 |
| --- | --- | --- |
| [engine-orchestration 模块概览](Documentation_Generation_Engine/engine-core/engine-orchestration.md) | `client.js` 跨语言边界与 `runNativeJob` 裁决链；`apply-plan` 写盘、索引、基线、提交与回滚 | 仅 `apply-plan` |
| [engine-contract-quality：引擎契约与质量裁决层](Documentation_Generation_Engine/engine-core/engine-contract-quality.md) | `EngineResult` / `EngineProgress` / `EngineError` 契约、采用门、死链语义校对、wiki 链接扫描规则 | 仅 `proofread.js` 改正文 |
| [engine-state-manifest：引擎清单与跨轮受管状态](Documentation_Generation_Engine/engine-core/engine-state-manifest.md) | 引擎指纹与 `engine-lock.json`、跨轮受管状态、产物映射、工作区快照 | 产出写集项，不直接落盘 |
| [引擎外部集成层（模型桥与 TechDocs 回读）](Documentation_Generation_Engine/engine-core/engine-integrations.md) | 进程内 loopback 模型桥（OpenAI 兼容 ↔ 宿主 LLM）、TechDocs 站点回读 | 否 |
| [引擎运行时工具层（engine-runtime-utils）](Documentation_Generation_Engine/engine-core/engine-runtime-utils.md) | `docs` 树读取与自洽性校验、受管子进程树终止 | 否 |
| [文章流水线（article-pipeline）](Documentation_Generation_Engine/article-pipeline.md) | `article-contract.js` 结构契约、`article-repair.js` 存量修复、`change-set.js` 四路 git 变更采集 | 仅采集侧调用 git（只读） |

## 一次编译的主干流程

```mermaid
sequenceDiagram
    participant J as JobService
    participant N as runNativeJob
    participant S as 状态与清单
    participant B as 模型桥
    participant E as Python 引擎
    participant Q as 质量门
    participant A as apply-plan
    participant R as 仓库
    J->>N: 编译请求
    N->>S: doctor + 增量决议 + 状态水合
    alt 环境不成立
        N-->>J: failed（engine-missing / engine-deps）
    else 环境成立
        N->>B: startLlmBridge
        N->>E: 一行 JSON 请求
        E-->>N: JSON-lines：hello / progress / result
        E->>B: POST /v1/chat/completions
        B-->>E: SSE 或 chat.completion
        alt 引擎 cancelled 或 failed
            N-->>J: 直接收口，不进质量门
        else 引擎成功
            N->>Q: gateNativeOutput
            Q-->>N: GateReport（defects / degradations / stale）
            N->>A: applyNativeOutput + 写集 + extraFiles
            A->>R: capturePre → 写盘 → cw index
            alt 索引或基线失败
                A->>R: restorePre 回滚
                A-->>N: applied=false, rolledBack=true
            else 索引与基线成功
                A->>R: git 自动提交
                A-->>N: done 或 partial
            end
            N-->>J: 终态取最弱一环
        end
    end
```

贯穿全层的硬约束：

- **终态取最弱**：引擎、质量门、落地器三者中任一降级，终态都不能是 `done`；`done` 不许带 blockers，`partial` 必须带 blockers，`failed` 必须带 error。
- **契约是唯一词表**：`BLOCKER_KINDS`、`ENGINE_STAGES`、`ENGINE_ERROR_CODES` 只允许追加，其它模块不得硬编码复制；文章结构判据同样只在 `article-contract.js` 里定义一份。
- **写盘单通道**：只有 `apply-plan` 修改 `.codewiki/` 与 `CodeWiki.md`，文章、受管状态、`engine-lock.json`、TechDocs 站点共享同一份 pre-image 与回滚语义。
- **状态只由完整成功推进**：`partial` / `failed` / `cancelled` 一律不推进基线、不裁剪状态，未消费的改动显式携带到下一轮。
- **采不到不等于没变化**：变更采集失败时显式 `fallback='full'` 退回全量编译，绝不假装干净。

## 核心组件文档

| 文档 | 覆盖内容 |
| --- | --- |
| [engine-core 模块概览](Documentation_Generation_Engine/engine-core.md) | 原生编译内核总览：模块定位、五层架构、主干流程与硬约束 |
| [engine-orchestration 模块概览](Documentation_Generation_Engine/engine-core/engine-orchestration.md) | 执行与裁决层总览，含 [engine-runner：原生引擎执行与裁决编排](Documentation_Generation_Engine/engine-core/engine-orchestration/engine-runner.md)、[engine-runner 进程与协议层](Documentation_Generation_Engine/engine-core/engine-orchestration/engine-runner/engine-runner_process-protocol.md)、[engine-runner 原生编译流水线](Documentation_Generation_Engine/engine-core/engine-orchestration/engine-runner/engine-runner_native-pipeline.md)、[apply-plan 落地器](Documentation_Generation_Engine/engine-core/engine-orchestration/apply-plan.md) |
| [engine-contract-quality：引擎契约与质量裁决层](Documentation_Generation_Engine/engine-core/engine-contract-quality.md) | 结果契约、采用门三类问题（defect / degradation / stale）、死链语义校对、基线可推进性 |
| [engine-state-manifest：引擎清单与跨轮受管状态](Documentation_Generation_Engine/engine-core/engine-state-manifest.md) | 引擎指纹与锁状态机、受管状态水合与采集、未消费账合并、工作区快照 |
| [引擎外部集成层（模型桥与 TechDocs 回读）](Documentation_Generation_Engine/engine-core/engine-integrations.md) | 模型桥安全模型、OpenAI 双向转换语义、空产出可观测性与熔断、TechDocs 回读 |
| [引擎运行时工具层（engine-runtime-utils）](Documentation_Generation_Engine/engine-core/engine-runtime-utils.md) | `collectOutput` / `validateOutput` 问题类别、页别名与死链判定、跨平台进程树终止 |
| [文章流水线（article-pipeline）](Documentation_Generation_Engine/article-pipeline.md) | 文章结构契约与 `NATIVE_ARTICLE_OPTS` 统一口径、存量页修复与判删边界、四路 git 变更采集与降级 |

## 相关模块

- 上游引擎实现：[Execution_Runtime___Vendored_Engine 概览](Execution_Runtime___Vendored_Engine.md)（`entry.py`、并行运行时、`stage_map.py`、`cw index` 的 frontmatter 解析语义）
- 任务调度与进度落账：[作业编排与状态管理（Job Orchestration & State Management）](Job_Orchestration___State_Management.md)
- 引擎环境与依赖闭合、`git-paths.js` 路径归一：[构建与开发基础设施（Build___Development_Infrastructure）概述](Build___Development_Infrastructure.md)
- 面板进度消费：[ui-client（浏览器半侧客户端）](ui-client.md)

??? abstract "Documented components (65)"
    - [`applyNativeOutput`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Capply-plan.js) — `lib\engine\apply-plan.js`
    - [`defaultRunCw`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Capply-plan.js) — `lib\engine\apply-plan.js`
    - [`findDeprecatedConceptPages`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Capply-plan.js) — `lib\engine\apply-plan.js`
    - [`findOrphanPages`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Capply-plan.js) — `lib\engine\apply-plan.js`
    - [`findStaleModulePages`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Capply-plan.js) — `lib\engine\apply-plan.js`
    - [`findSupersededLegacyPages`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Capply-plan.js) — `lib\engine\apply-plan.js`
    - [`runEngine`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cclient.js) — `lib\engine\client.js`
    - [`describeEngineResult`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Ccontract.js) — `lib\engine\contract.js`
    - [`normalizeBlocker`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Ccontract.js) — `lib\engine\contract.js`
    - [`validateEngineResult`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Ccontract.js) — `lib\engine\contract.js`
    - [`setStage`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cllm-bridge.js) — `lib\engine\llm-bridge.js`
    - [`startLlmBridge`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cllm-bridge.js) — `lib\engine\llm-bridge.js`
    - [`doctor`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cmanifest.js) — `lib\engine\manifest.js`
    - [`writeLock`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cmanifest.js) — `lib\engine\manifest.js`
    - [`findMissingModuleDocs`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cmapping.js) — `lib\engine\mapping.js`
    - [`noop`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cnative-run.js) — `lib\engine\native-run.js`
    - [`stateDocFiles`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cnative-state.js) — `lib\engine\native-state.js`
    - [`isPlaceholderKey`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Copenai-bridge.js) — `lib\engine\openai-bridge.js`
    - [`add`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Coutput.js) — `lib\engine\output.js`
    - [`isAlive`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cprocess-tree.js) — `lib\engine\process-tree.js`
    - [`proofreadPages`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cproofread.js) — `lib\engine\proofread.js`
    - [`gateNativeOutput`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cquality-gate.js) — `lib\engine\quality-gate.js`
    - [`toQualityIssues`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cquality-gate.js) — `lib\engine\quality-gate.js`
    - [`captureSite`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Ctechdocs.js) — `lib\engine\techdocs.js`
    - [`isExternalTarget`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cwiki-links.js) — `lib\engine\wiki-links.js`
    - [`createWorkspaceSnapshot`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cworkspace-snapshot.js) — `lib\engine\workspace-snapshot.js`
    - [`shortSha`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cworkspace-snapshot.js) — `lib\engine\workspace-snapshot.js`
    - [`snapshotExists`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Cworkspace-snapshot.js) — `lib\engine\workspace-snapshot.js`
    - [`hasBlockingIssue`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`isWritable`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`issueSummary`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`makeWriteSet`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`assemble`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-repair.js) — `lib\article-repair.js`
    - [`collect`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cchange-set.js) — `lib\change-set.js`
    - [`parseFrontmatter`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`parseYamlLite`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`unquote`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`extractSections`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`fencesBalanced`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`collectWikiLinks`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`stripCode`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`blank`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`hasDuplicateFrontmatter`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`isRepoRelativeFile`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`inspectArticle`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`push`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Carticle-contract.js) — `lib\article-contract.js`
    - [`textBlock`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Copenai-bridge.js) — `lib\engine\openai-bridge.js`
    - [`contentToBlocks`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Copenai-bridge.js) — `lib\engine\openai-bridge.js`
    - [`toolsToSchemas`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Copenai-bridge.js) — `lib\engine\openai-bridge.js`
    - [`messageToDsh`](https://github.com/ikliml666/dsh-codewiki/blob/bc7e15a2499b5c4f334d4c0611eace4ad97c1c26/lib%5Cengine%5Copenai-bridge.js) — `lib\engine\openai-bridge.js`
    - … and 15 more

