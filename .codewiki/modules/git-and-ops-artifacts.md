---
title: git-and-ops-artifacts
type: module
source_files:
  - .gitignore
  - .orch-test-out.txt
  - .probe3.txt
tags: [version-control, logging, probes, error-handling]
---

## Overview
本模块定义了代码仓库的运维边界与运行时产物管理规范。核心职责包括：通过 `.gitignore` 排除构建依赖、二进制备份及日志文件，防止敏感或大型数据污染版本库；同时记录内部探针状态（`.probe3.txt`）及编排测试中的系统级异常（`.orch-test-out.txt`），为环境稳定性提供诊断依据。

## Key Components
### 1. Git Ignore Rules (`.gitignore`)
位于根目录的 `.gitignore` 文件，定义了以下忽略规则：
- **行 1**: `node_modules/` - 忽略 Node.js 依赖包目录。
- **行 2**: `vendor/codewiki/target/` - 忽略特定 vendor 下的构建目标目录。
- **行 3**: `*.log` - 忽略所有扩展名为 `.log` 的文件，涵盖运行时产生的大型日志。
- **行 5-6**: `bin/*.bak-*` - 注释说明：用于 cw 二进制备份，作为丢失源码时的安全网。

### 2. Internal Probe State (`.probe3.txt`)
- **文件**: `.probe3.txt`
- **内容**: `probe`
- **用途**: 存储内部探针的当前状态或标识，表明探针功能已激活或处于默认状态。

### 3. Orchestration Test Output (`.orch-test-out.txt`)
- **文件**: `.orch-test-out.txt`
- **内容**: 记录了 Node.js 执行编排测试脚本 `test-orchestration.mjs` 时发生的未捕获异常。
- **关键错误信息**:
  - **类型**: `Error: EPERM: operation not permitted`
  - **操作**: `mkdtempSync`
  - **路径**: `E:\ik\Documents\trae_projects\1\dsh plugin\dsh-codewiki\.tmptest\cw-remind-XXXXXX`
  - **Node.js 版本**: v24.19.0
  - **位置**: 源文件 `test-orchestration.mjs` 第 197 行附近（根据堆栈跟踪推断）。

## Architecture
```text
┌──────────────────────┐       ┌─────────────────────────┐
│   Version Control    │       │   Runtime & Testing     │
│   (.gitignore)       │       │   (.orch-test-out.txt)  │
│                      │       │                         │
│ • node_modules/      │       │ • Error: EPERM          │
│ • *.log              │       │ • Syscall: mkdtempSync  │
│ • bin/*.bak-*        │       │ • Path: .tmptest/...    │
└──────────────────────┘       └─────────────────────────┘
           ▲                               ▲
           │                               │
           ▼                               ▼
┌──────────────────────┐       ┌─────────────────────────┐
│   Artifact Storage   │       │   Diagnostic Data       │
│   (.probe3.txt)      │       │   (System Logs)         │
│                      │       │                         │
│ • Status: probe      │       │ • Env: Windows          │
└──────────────────────┘       └─────────────────────────┘
```

## Data Flow
1. **构建与运行阶段**: 项目生成 `node_modules`、`vendor/codewiki/target/` 以及各类 `.log` 文件。
2. **版本控制过滤**: `.gitignore` 拦截上述文件，确保它们不被提交。同时，`bin/*.bak-*` 的二进制备份也被忽略，尽管其被标记为“安全网”，但可能因包含二进制大文件或避免版本冲突而被显式排除。
3. **探针记录**: 运行时探针状态写入 `.probe3.txt`，内容为静态字符串 `probe`。
4. **测试执行与异常捕获**: 编排测试脚本 `test-orchestration.mjs` 尝试在 `.tmptest` 目录下创建临时文件夹。由于权限不足（EPERM），操作失败，错误详情被输出并保存至 `.orch-test-out.txt`。

## Connections
- 关联模块：[[version-control-basics]] (Git 基础配置)
- 关联模块：[[runtime-monitoring]] (运行时监控与探针)
- 关联模块：[[testing-infrastructure]] (测试基础设施与环境配置)

## Known Issues
1. **临时目录权限错误**:
   - **现象**: 在 Windows 环境 (`E:\ik\...`) 下，`test-orchestration.mjs` 调用 `mkdtempSync` 时抛出 `EPERM` 错误。
   - **原因**: 进程缺乏对 `.tmptest` 目录或其父目录的写权限，或者该路径被防病毒软件/系统策略锁定。
   - **影响**: 编排测试中的提醒功能（`cw-remind`）无法正常工作，可能导致测试流程中断或状态不一致。
   - **建议**: 检查 `.tmptest` 目录的权限设置，或确保运行测试的用户账户具有足够的文件系统访问权限。