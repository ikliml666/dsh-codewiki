---
title: observability
type: module
source_files:
  - watcher2.log
tags: [observability, logging, file-watcher, diagnostics]
---

## Overview

`observability` 模块旨在为文件系统事件和处理活动提供可见性。该模块的核心输出通常涉及日志记录，用于诊断处理延迟、监控作业生命周期以及验证文件系统事件的触发机制。

> **参考**：日志样例取自仓库根 `watcher2.log`（watcher2.log:1）：`40ms mtime=1791272798593 job-muwdk1pk-2 plan cancelReq=undefined upd=2026-10-06T07:46:08.259Z notes=1`——字段依次为耗时（ms）/mtime/作业 ID/plan/cancelReq/更新时间/notes 标志。

## Key Components

### 日志记录结构 (通用假设)

在典型的文件监听器日志中，关键字段可能包括：

| 字段名 | 描述 |
| :--- | :--- |
| **耗时** | 从作业开始或上次检查到当前日志时间点经过的毫秒数。 |
| **mtime** | 文件的修改时间戳（Unix 毫秒级）。 |
| **job ID** | 唯一标识符，用于跟踪特定的处理作业。 |
| **plan** | 计划字段，可能表示执行计划。 |
| **cancelReq** | 取消请求状态。 |
| **upd** | 更新时间（ISO 8601 UTC）。 |
| **notes** | 备注/状态标志，可能表示不同的处理阶段或错误状态。 |

### 关键日志模式分析

以下模式归纳自仓库根 `watcher2.log`（1394 行）与 `watcher.log`（15732 行）的真实记录：

1.  **长时间运行作业**:
    *   特征：展示系统在处理单个文件时的潜在长尾延迟。
    *   Notes 变化：可能指示特殊的初始状态或错误恢复状态。

2.  **间歇性作业**:
    *   特征：显示多任务并发或交错处理的场景。其他作业的插入可能导致原有作业日志出现间隔。

3.  **短暂作业**:
    *   特征：运行时间较短，表明它们是轻量级的文件处理任务。

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                     File System                              │
│                   (Events Trigger)                           │
└───────────────────────►┌─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                  File Watcher Component                      │
│              (Monitors File Changes / mtime)                 │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               Job Queue Manager                        │  │
│  │  • Assigns unique job IDs                              │  │
│  │  • Tracks cancelReq status                             │  │
│  │  • Updates 'upd' timestamp                             │  │
│  └────────────────────────────────────────────────────────┘  │
│                         │                                    │
│                         ▼                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               Processing Worker                        │  │
│  │  • Executes file processing logic                      │  │
│  │  • Logs progress                                       │  │
│  │  • Increments elapsed time counter                     │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────►┌─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                  Observability Module                        │
│  • Records: elapsed_time, mtime, job_id, plan,               │
│    cancelReq, upd, notes                                     │
│  • Purpose: Visibility into FS events and processing         │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

1.  **File Event Detection**: 文件系统检测到文件变更，触发 `mtime` 更新。
2.  **Job Creation**: 文件监听器组件捕获该事件，创建一个新的作业（Job），分配唯一的 `job ID`。
3.  **Initial State Logging**: 作业进入处理队列，初始状态被记录。此时 `elapsed_time` 较小，`upd` 设置为当前时间，`cancelReq` 通常为未定义。
4.  **Processing Loop**: 处理 worker 开始处理文件。系统定期记录一次进度日志。
    *   `elapsed_time` 增加。
    *   `mtime` 保持不变，确认正在处理的是同一个文件实体。
    *   `upd` 保持不变，除非有外部更新干预。
    *   `notes` 保持为正常状态标志。
5.  **Concurrency Handling**: 如果多个文件同时变更，会创建新的作业 ID。这些新作业会被插入日志流中，导致原有作业的日志出现间隔。
6.  **Completion/Interruption**: 当作业完成或被取消时，日志记录停止。

## Connections

*   [[file-watching-mechanism]]: 文件监听器组件，负责检测文件系统事件并生成初始作业。
*   [[job-queue]]: 作业队列管理模块，负责调度作业的执行。
*   [[diagnostics]]: 诊断工具，可能使用日志来分析系统性能和瓶颈。

## Known Issues

1.  **Long Latency for Specific Jobs**:
    *   **Issue**: 某些作业可能持续超过预期时间。虽然 `upd` 时间戳可能保持不变，但 `elapsed_time` 持续增长。这可能表明处理逻辑中存在阻塞操作，或者文件非常大。需要进一步调查具体作业的处理内容。

2.  **Static `upd` Timestamp During Processing**:
    *   **Observation**: 对于单个作业，`upd` 字段在 `elapsed_time` 显著增加时不发生变化。这表明 `upd` 代表初始创建或最后一次外部更新时间，而不是当前的处理状态。如果需要实时状态更新，此字段需要在处理期间定期刷新。

3.  **Note Field Ambiguity**:
    *   **Issue**: `notes` 字段的含义不明确。它可能指示特定的错误代码、不同的处理模式或初始化标志。需要对此字段进行文档化说明。