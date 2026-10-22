---
title: git-and-ops-artifacts
type: module
source_files:
  - .gitignore
  - .probe3.txt
tags: [version-control, logging, probes, error-handling]
---

## Overview
本模块定义了代码仓库的运维边界与运行时产物管理规范。核心职责包括：通过 `.gitignore` 排除构建依赖、二进制备份及日志文件，防止敏感或大型数据污染版本库；同时记录内部探针状态（`.probe3.txt`）。注意：编排测试输出文件 `.orch-test-out.txt` 和探针状态文件 `.probe3.txt` 在当前 `.gitignore` 中均被显式忽略，需关注其潜在的版本控制影响。

## Key Components
### 1. Git Ignore Rules (`.gitignore`)
位于根目录的 `.gitignore` 文件，定义了以下忽略规则：
- **行 1**: `node_modules/` - 忽略 Node.js 依赖包目录，避免将庞大的第三方库提交至版本库。
- **行 2**: `vendor/codewiki/target/` - 忽略特定 vendor 下的构建目标目录，通常包含编译后的中间产物。
- **行 3**: `*.log` - 忽略所有扩展名为 `.log` 的文件，涵盖运行时产生的各类日志，防止磁盘空间浪费及敏感信息泄露。
- **行 5-6**: `bin/*.bak-*` - 注释说明：用于 cw 二进制备份，作为丢失源码时的安全网。此类二进制备份文件被明确排除在版本控制之外。
- **行 8**: `.orch-test-out.txt` - 忽略编排测试输出文件。
- **行 9**: `.probe3.txt` - 忽略内部探针状态文件。
- **行 10**: 空行，用于分隔不同组的忽略规则。
- **行 11-12**: 注释说明 DSH 运行期产物。
- **行 12**: `.dsh-ops/` - 忽略 DSH 运行期产物目录，包括面板会话流、工具调用记录等，这些动态生成的数据不入库。

### 2. Internal Probe State (`.probe3.txt`)
- **文件**: `.probe3.txt`
- **内容**: `probe`
- **用途**: 存储内部探针的当前状态或标识。该文件内容简单固定，表明探针功能已激活或处于默认状态。尽管其内容静态，但作为运行时产物的一部分，它被纳入 `.gitignore` 进行管理（见下文 Data Flow 分析）。

## Architecture
```text
┌──────────────────────┐       ┌─────────────────────────┐
│   Version Control    │       │   Runtime & Testing     │
│   (.gitignore)       │       │   (.probe3.txt)         │
│                      │       │                         │
│ • node_modules/      │       │ • Status: probe         │
│ • *.log              │       │                         │
│ • bin/*.bak-*        │       │                         │
│ • .orch-test-out.txt │       │                         │
│ • .probe3.txt        │       │                         │
│ • .dsh-ops/          │       │                         │
└──────────────────────┘       └─────────────────────────┘
           ▲                               ▲
           │ Ignored                       │ Written/Runtime
           ▼                               ▼
┌──────────────────────┐       ┌─────────────────────────┐
│   Artifact Storage   │       │   Diagnostic Data       │
│   (Local FS)         │       │   (System Logs)         │
│                      │       │                         │
│ • Excluded from Git  │       │ • Not in Git            │
│ • Local Safety Net   │       │ • Probe State           │
└──────────────────────┘       └─────────────────────────┘
```

## Data Flow
1. **构建与运行阶段**: 项目生成 `node_modules`、`vendor/codewiki/target/` 以及各类 `.log` 文件。DSH 系统运行时产生 `.dsh-ops/` 目录下的会话和工具调用记录。
2. **版本控制过滤**: `.gitignore` 拦截上述文件，确保它们不被提交。
    - `node_modules/`, `*.log`, `.dsh-ops/` 是主要的运行时噪音源。
    - `bin/*.bak-*` 虽然被标记为“安全网”，但因其二进制性质和潜在的大小，被显式排除以避免版本冲突。
    - `.orch-test-out.txt` 和 `.probe3.txt` 也被纳入忽略列表，防止非源代码文件入库。
3. **探针记录**: 运行时探针状态写入 `.probe3.txt`，内容为静态字符串 `probe`。此文件虽小，但作为运行时产物，遵循忽略策略。
4. **测试执行**: 编排测试脚本可能生成 `.orch-test-out.txt` 用于记录异常或输出。当前 `.gitignore` 包含对此文件的忽略规则，确保测试过程中的临时或错误输出不会污染版本库。

## Connections
- 关联模块：[[version-control-basics]] (Git 基础配置)
- 关联模块：[[runtime-monitoring]] (运行时监控与探针)
- 关联模块：[[testing-infrastructure]] (测试基础设施与环境配置)

## Known Issues
1. **编排测试输出文件管理**:
   - **现象**: `.orch-test-out.txt` 在 `.gitignore` 中被忽略。
   - **原因**: 该文件通常包含测试运行时的异常堆栈或调试信息，属于临时或诊断性数据。
   - **影响**: 如果测试失败，开发者需要本地查看该文件以获取错误详情，无法通过版本历史回溯过去的测试错误状态。
   - **建议**: 对于关键测试失败的记录，建议考虑将其归档到专门的 CI/CD 日志系统，而非依赖本地文件或版本控制。

2. **DSH 运行期产物隔离**:
   - **现象**: `.dsh-ops/` 目录被完全忽略。
   - **原因**: 该目录包含大量动态生成的会话和工具调用记录，数据量大且无长期版本控制价值。
   - **影响**: 无法通过 Git 历史恢复过去的会话状态或工具调用链。
   - **建议**: 如需审计或回溯，应依赖外部日志收集系统或定期导出重要会话数据。