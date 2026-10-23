---
title: cwd-path-tests
type: module
source_files:
  - test-cwd-paths.mjs
  - .tmp-test-cwd-paths.log
tags: [测试, 路径解析, 工作目录, cw工具, 边界用例]
---

## Overview

`cwd-path-tests` 模块是一组最小化的测试脚本与日志，专注于验证工作目录（cwd）与路径解析行为在 `cw` 工具中的修复（对应版本 0.2.3 路径修复）。脚本 `test-cwd-paths.mjs` 直接调用插件模块注册的 `cw` 工具的 `execute` 方法，覆盖三种 cwd 形态：MSYS 路径、Windows 路径、不存在的路径。日志 `.tmp-test-cwd-paths.log` 显示全部用例通过，证明路径归一化与 PATH 探测生效。

## Key Components

该测试脚本 `test-cwd-paths.mjs` 本身未导出任何函数/类，但定义了以下顶层常量、对象与方法：

- 常量 `pluginDir` (行7)：通过 `path.dirname(fileURLToPath(import.meta.url))` 计算当前脚本所在目录。
- 常量 `repoWin` (行8)：从 `process.argv[2]` 获取真实仓库的 Windows 形式路径，缺省为 `'E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin'`。
- 常量 `msys` (行10)：利用正则 `/^([A-Za-z]):\//` 与箭头函数 (行10 内) 将 `repoWin` 转换为 MSYS 形式（如 `E:/x` → `/e/x`）。
- 对象 `registered` (行12)：初始为空对象 `{}`，用于动态保存插件注册的 tool 描述符，字段为 `name -> tool descriptor`。
- 对象 `ctx` (行13-18)：测试桩上下文，包含：
  - 方法 `inject(_names, fn)` (行14-16)：调用 `fn({ tools: { register(d) { registered[d.name] = d } }, subagents: {} })` 以填充 `registered`。
  - 方法 `effect()` (行17)：空函数，无操作。
- 调用 `await plugin.apply(ctx, {})` (行20)：触发插件注册，使 `registered.cw` 可用。
- 常量 `cw` (行22)：从 `registered.cw` 取出的工具对象；若未注册则报错退出 (行23)。
- 常量 `cfgProbe` (行26)：探针配置对象，字段包括 `enabled: true`、`binaryPath: ''`、`defaultProvider: ''`、`defaultModel: ''`、`maxConcurrency: 2`、`articleLanguage: '中文'`，用于说明 `resolveBinary` 预期行为，但脚本中并未直接传入。
- 常量 `execStub` (行31)：执行桩 `{ signal: undefined }`，传递给 `execute` 的第二个参数。
- 变量 `r` (行32)：保存 MSYS 路径 `execute` 结果。
- 变量 `r2` (行48)：保存 Windows 路径 `execute` 结果。
- 变量 `first` (行49)：`r2.stdout.trim().split('\n')[0]` 的首行文本。

外部模块中定义但未在本脚本导出的函数（仅注释引用）：

- `resolveBinary` (行27 注释)：未导出，通过 `execute` 结果间接验证。
- `wikiPathFor` (行59 注释)：未导出，兜底路径改为 `<cwd>/.codewiki`，契约由 `cw path` 成功路径覆盖。

## Architecture

测试流程涉及脚本、插件上下文、cw 工具执行三层组件，框图如下：

```text
┌──────────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ test-cwd-paths.mjs   │   │ ctx.inject (14-16)│   │ cw.execute       │
│ (lines 1-71)         │──►│ plugin.apply (20)│──►│ (34,48,63)       │
│                      │   │ → registered.cw  │   │                  │
└──────────────────────┘   └──────────────────┘   └──────────────────┘
        │                      │                        │
        │                      ▼                        ▼
        │               ┌──────────────┐        ┌──────────────┐
        └───────────────│ msys/repoWin │        │ stdout/exit  │
                        │ path calc    │        │ assertions   │
                        └──────────────┘        └──────────────┘
```

## Data Flow

1. 输入：命令行参数 `process.argv[2]` 或默认 Windows 路径 (行8) → 计算 `msys` (行10)。
2. 注册：构造 `ctx` 桩 (行13-18)，调用 `plugin.apply` (行20) 使 `cw` 工具登记到 `registered` (行22)。
3. 执行用例 2：以 `msys` 为 cwd 调 `cw.execute({ cwd: msys, args: ['path'] }, execStub)` (行34)，期望 `exitCode=0` 且 stdout 匹配 `/\.codewiki$/i` (行41)。
4. 执行用例 3：以 `repoWin` 为 cwd 调 `cw.execute({ cwd: repoWin, args: ['status'] }, execStub)` (行48)，检查首行非 "No wiki found" (行53)。
5. 执行用例 5：以不存在路径 `/q/nonexistent-repo-xyz` 调 `execute` (行63)，期望抛出包含 `cwd 不存在` 的错误 (行67)。
6. 输出：日志打印 `PASS`/`FAIL` 及最终 `ALL PASS` (行45,57,68,71)，对应 `.tmp-test-cwd-paths.log` 内容。

## Connections

- 测试目标为插件模块注册的 `cw` 工具，相关模块参见 [[cw-tool]]（即 `index.js` 中 `plugin.apply` 注册的 `cw`）。
- 路径归一化逻辑与 [[path-resolution]] 模块（源码中 `resolveBinary`、`wikiPathFor` 所属）直接关联。
- 版本修复背景见 [[release-0.2.3]] 路径修复说明。

## Known Issues

- `resolveBinary` 未导出 (行27 注释)：脚本无法直接调用，仅通过 MSYS 路径跑通间接验证归一化与 PATH 探测；捆绑副本一致性由外部 sha256 完成，此处不重复 (行28)。
- `wikiPathFor` 兜底路径未导出 (行59 注释)：无法直接调用，合约依赖 `cw path` 成功路径覆盖；兜底改为 `<cwd>/.codewiki` 仅在源码可查。
- 脚本用法依赖手动传入 Windows 形式路径 (行2)，若未传则使用硬编码默认 `E:/ik/...` (行8)，可能导致非该环境时路径无效。
- 日志文件 `.tmp-test-cwd-paths.log` 显示 MSYS 用例 stdout 返回 `E:\ik\...\.codewiki` (行2)，表明 `cw path` 内部将 MSYS 归一化回 Windows 风格输出，此行为符合预期但需注意日志中的反斜杠。