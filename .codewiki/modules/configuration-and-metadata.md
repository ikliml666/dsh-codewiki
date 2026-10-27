---
title: configuration-and-metadata
type: module
source_files:
  - package.json
  - cordis.patch.yml
  - .gitignore
  - .codewiki/_meta.yaml
  - index.js
  - README.md
tags: [配置, 元数据, 依赖, Cordis, Patch]
---



## Overview

本模块负责定义 `@local/dsh-codewiki` 项目的**核心包元数据、运行时依赖约束、DSH 插件挂载补丁、Git 忽略规则与 CodeWiki 产物元信息**。它由若干静态文件组成，自身不含任何可执行逻辑，但在 `dsh bundle` 打包 / 本地开发直挂时被 DSH 宿主读取，决定插件以何种 id 挂载、默认编译行为（模型、并发、分层策略）从哪取、以及哪些产物不进版本库。本模块还覆盖 `index.js` 中 `Config` schema（行60-86）与 `liveConfig()`（行92-134）这两个**配置项的唯一定义来源**——`cordis.patch.yml` 只注释了 13 个常用配置项，真正的全量字段与默认值都写在 `index.js` 里。

组成文件：

- `package.json`（行1-28）：Node.js/DSH 环境要求、基础依赖与 DSH 打包字段，是插件行为的「包级声明」。
- `cordis.patch.yml`（行1-33）：DSH 插件系统的 Cordis 挂载补丁（`- insert:` 注册 id `codewiki`），`config: {}`（行24）为空壳，默认值来自 `index.js` 的 `Config`。
- `index.js` 的 `Config` / `liveConfig`（行60-134）：编译配置 schema 与运行期归一化逻辑，是全部 25 个配置项的真实来源。
- `.gitignore`（行1-12）：构建产物、cw 二进制备份、DSH 运行期产物、测试输出不入库。
- `.codewiki/_meta.yaml`（行1-5）：CodeWiki 编译产物的元信息。
- `README.md`（行1-91）：与 `package.json` 描述同步的能力说明与配置项文档。

当前版本 `0.13.5`（`package.json` 行3）。`package.json` 行4 描述明确了：CLI（`cw`）、全仓库 Wiki 编译管线（插件内、默认 `workbuddy`/`hy3` 192k 上下文、`large tier volces-ark/glm-5.3-flash` 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能；并声明自 0.13.0 起吸收了 FSoft-AI4Code/CodeWiki 的 AST 符号提取 + LLM 语义聚类、agentic 工具循环文章写作、符号级增量更新，基于 Node + tree-sitter WASM 实现（无 Python 运行时）。

## Key Components

本模块由一组静态配置文件与 `index.js` 中的配置 schema 组成。其中 `index.js` 的 `Config`（行60-86）/ `liveConfig`（行92-134）是唯一完整的配置项定义来源；静态文件的字段含义与行号如下。

### package.json

位于仓库根目录，JSON 格式包声明文件（源码行1-28）。无代码函数/类，以下为各字段含义与行号。

- **行2** `"name": "@local/dsh-codewiki"`：项目唯一标识符（命名空间 `@local/` 表示本地私有包）。
- **行3** `"version": "0.13.5"`：当前语义化版本号。
- **行4** `"description"`：长描述，说明 CLI（`cw`）、全仓库 Wiki 编译管线（插件内、默认 `workbuddy`/`hy3` 192k、large tier `volces-ark/glm-5.3-flash` 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能；并声明自 0.13.0 起吸收 FSoft-AI4Code/CodeWiki 的三层能力（AST 符号提取+LLM 语义聚类、agentic 工具循环写作、符号级增量），用 Node + tree-sitter WASM 实现，无 Python 运行时。
- **行5** `"private": true`：私有包，防止误发布到公共注册表。
- **行6** `"type": "module"`：启用 ES Modules (ESM)，所有 `.js` 文件默认按 ESM 处理（对应 `index.js` 行8 起的 `import`、`import.meta.url` 用法）。
- **行7** `"main": "index.js"`：入口点，也是 DSH 宿主加载插件时执行的模块。
- **行8-11** `"exports"`：子路径导出。
  - **行9** `"."` 映射至 `./index.js`。
  - **行10** `"./client"` 映射至 `./client.js`（浏览器半侧 UI，见 `client-interface`）。
- **行12** `"license": "MIT"`：开源许可证。
- **行13-16** `"engines"`：
  - **行14** `"node": ">=20"`：强制 Node.js ≥ 20。
  - **行15** `"dsh": ">=0.2.0-rc.0"`：强制 DeepSeek Harness ≥ 0.2.0-rc.0。
- **行17-19** `"dependencies"`：
  - **行18** `"@deepseek-ai/schemastery": "^3.18.4"`：运行时依赖，`index.js` 行14 通过 `import z from '@deepseek-ai/schemastery'` 用它定义 `Config` schema（行60-86）与各类工具参数 schema。
- **行20-27** `"dsh"`：自定义字段，专供 DSH 工具链使用。
  - **行21-23** `"client"`：`"platform": "web"`（行22），指定客户端运行平台为 Web（对应 `client.js` 浏览器半侧）。
  - **行24-26** `"bundle"`：`"patch": "cordis.patch.yml"`（行25），指定 `dsh bundle` 打包时使用的 Cordis 补丁文件路径。





### cordis.patch.yml

位于仓库根目录，YAML 格式补丁定义文件（源码行1-33）。由 `dsh bundle` 或 Cordis 加载器读取。

- **行1-4** 注释块：
  - 行1 说明文件用途：dsh-codewiki — CodeWiki (mraza007/codewiki) for DeepSeek Harness。
  - 行2 说明 0.13.0 起吸入 AST 聚类 / agentic 写作 / 符号级增量三层能力。
  - 行3-4 说明挂载方式：本文件供 **bundle 形式安装**用；本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂（URL 中空格写 `%20`），二者保持 id 一致为 `codewiki`。⚠️ 注意：仓库当前**不存在 `profiles/` 目录**（见 `README.md` 行66-81 的安装说明，该直挂文件需手动追加），本文件是 bundle 形态的挂载声明。
- **行5** 说明设置项 config 命名空间 = `codewiki`（注释，非 YAML 键）。
- **行6-18** 注释块列出 13 个常用配置项含义（仅注释，未在 YAML 主体展开默认值）：
  - `binaryPath`（行6）：cw 可执行路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`。
  - `batchProvider`（行7）：编译模型提供商（必须是模型设置里已注册的 provider；默认 `workbuddy`，留空=提交失败）。
  - `batchModel`（行8）：编译模型 id（默认 `hy3`，免费 192k 上下文）。
  - `batchReasoningEffort`（行9）：思考档位（取值来自模型目录 `reasoning.efforts`；留空=模型默认档）。
  - `maxConcurrency`（行10）：默认档并发上限（1–8，默认 2）。
  - `bigConcurrency`（行11）：大档并发上限（1–8，默认 0=跟随默认档），与默认档各自独立限流、同时推进。
  - `serialProjects`（行12）：单项目串行（默认开）。
  - `articleLanguage`（行13）：文章语言（默认中文）。
  - `planMode`（行14）：模块划分 auto=AST 符号+LLM 语义聚类（默认）｜dirs=顶层目录分组（旧行为）。
  - `agenticArticles`（行15）：文章写作走 agentic 工具循环（默认开）。
  - `agenticMaxSteps`（行16）：agentic 单篇步数上限（默认 30，1–100）。
  - `symbolIncremental`（行17）：增量按 AST 符号级判定（默认开）。
  - `updateReminder`（行18）：会话系统提示注入 wiki 维护提醒（默认开）。
  - 注：注释覆盖 13 项，**未列出** `enabled`/`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`parallelProjects`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 这些字段。它们全部定义在 `index.js` 的 `Config` schema（行60-86）里，默认值见 `liveConfig()`（行92-134）；含义与可选值在 `README.md` 行47-64 有完整文档。
- **行19** `- insert:`：Cordis 的插入操作根节点。
- **行20** `- id: codewiki`：插件 ID，固定为 `codewiki`，须全局唯一且须与本地开发配置一致。
- **行21** `name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`：指向本地绝对路径的 `index.js`，含空格编码 `%20`，为 Windows 绝对路径。此为 bundle 安装形态声明。
- **行22-23** 注释：默认值不在本文件重复声明——留空即用插件 `Config` schema 里的默认值（见 `index.js` 的 `Config`）。想改哪项就填哪项。
- **行24** `config: {}`：初始配置对象为空。实际默认值来自 `index.js` 的 `Config`（行60-86）与 `liveConfig()`（行92-134）合并逻辑；本文件只作为用户覆盖层。
- **行25-33** 注释示例：展示如何填写 `config`（行26-33 注掉）以换编译模型、调并发、关掉 agentic 写作等，逐项对应行6-18 的配置项。

### index.js — Config schema（行60-86）与 liveConfig（行92-134）

`index.js` 是配置项的唯一完整定义处。靠顶部的常量（行30-45）给出若干默认值常量，再经 `Config`（行60-86，基于 `@deepseek-ai/schemastery` 的 `z.object`）声明 25 个字段。`liveConfig()`（行92-134）把读取到的 patch 配置归一化为运行期值（处理缺省、钳制范围、空串回退到默认常量）。全部字段如下：

| 字段 | 声明行 | 默认值（schema） | 用途 |
|------|--------|------------------|------|
| `enabled` | 行61 | `true` | 停用后两个工具立即报错 |
| `binaryPath` | 行62 | `''` | cw 可执行路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | 行63 | `workbuddy`（常量行35） | 编译模型提供商（模型设置里已注册的 provider id） |
| `batchModel` | 行64 | `hy3`（常量行36） | 编译模型 id（该 provider 下的模型 id） |
| `batchReasoningEffort` | 行65 | `''` | 思考档位 id；留空=模型默认档 |
| `bigProvider` | 行66 | `volces-ark`（常量行39） | 大档模型提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | 行67 | `glm-5.3-flash`（常量行40） | 大档模型 id（默认 512k 上下文） |
| `bigReasoningEffort` | 行68 | `''` | 大档模型思考档位；留空=模型默认档 |
| `bigTokenBudget` | 行69 | `420000`（常量行42） | 大档单请求输入预算（token）；输入超 110k 普通预算改用大档 |
| `sessionTier` | 行70 | `''` | 会话通道档位 id（仅大档都装不下且 `bigProvider` 留空时兜底） |
| `maxConcurrency` | 行71 | `2`（常量行33） | 默认档并发上限（1–8，硬顶 8） |
| `bigConcurrency` | 行72 | `0` | 大档并发上限（1–8，硬顶 8）；0/留空=跟随默认档 |
| `serialProjects` | 行73 | `true` | 单项目串行；关闭后按 `parallelProjects` 并行推进多仓库 |
| `parallelProjects` | 行74 | `2` | 并行推进的仓库编译任务上限（1–4），关闭单项目串行后生效 |
| `articleLanguage` | 行75 | `中文` | wiki 文章书写语言 |
| `planMode` | 行76 | `auto` | 模块划分方式：`auto`=AST 符号+LLM 语义聚类，`dirs`=顶层目录分组 |
| `agenticArticles` | 行77 | `true` | 文章写作走 agentic 工具循环；关闭走单轮整包装填旧通道 |
| `agenticMaxSteps` | 行78 | `30` | agentic 写作单篇最大步数（硬顶 100） |
| `symbolIncremental` | 行79 | `true` | stale 增量按 AST 符号级判定；关闭按文件级 mtime/hash |
| `updateReminder` | 行80 | `true` | 会话系统提示注入 wiki 维护提醒（仅当仓库根存在 `CodeWiki.md`） |
| `autoCommit` | 行81 | `true` | 编译完成后插件自己在主题分支提交产物（`git add .codewiki CodeWiki.md`） |
| `excludePaths` | 行82 | `''` | 排除清单：这些目录（含子目录）不编译；换行/分号/逗号分隔绝对路径 |
| `autoUpdate` | 行83 | `false` | 定时扫描已编译工作区、检测到变更自动增量编译 |
| `autoUpdateMin` | 行84 | `30` | 自动更新扫描间隔（分钟），最小 5 |
| `workspaceOnly` | 行85 | `true` | 任务页只显示属于已添加 dsh 工作区的任务 |

`liveConfig()`（行92-134）的关键归一化逻辑：
- `maxConcurrency` 经 `CONCURRENCY_HARD_CAP`（行31，=8）钳制，越界或非有限回落 `DEFAULT_CONCURRENCY`（行33，=2）（行107-109）。
- `bigConcurrency` 同样钳制到 8，0/未填回落 0（跟随默认档）（行111-113）。
- `parallelLimit`（行115-119）：`serialProjects` 为真时恒为 `1`；关闭后取 `parallelProjects` 钳到 4，缺省回落 2。
- `batchModel`/`bigModel`/`articleLanguage` 空串回落默认（行100、行103、行120）。
- `planMode` 非 `auto`/`dirs` 回落 `auto`（行121）；`agenticMaxSteps` 钳到 100、缺省 30（行123-126）；`autoUpdateMin` 最小 5（行130）；`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行581，=110000）（行105）。

### .gitignore

位于仓库根目录，Git 忽略规则文件（源码行1-12）。无代码函数/类，以下为各规则行号与含义。

- **行1** `node_modules/`：忽略 npm/yarn/pnpm 安装依赖目录。
- **行2** `vendor/codewiki/target/`：忽略 vendor 目录下 CodeWiki 构建目标输出文件夹。
- **行3** `*.log`：忽略所有日志文件。
- **行4** 空行。
- **行5** 注释：说明 `bin/*.bak-*` 用途为 cw 二进制备份（丢失源码的最后产物，安全网）。
- **行6** `bin/*.bak-*`：忽略 `bin/` 目录下以 `.bak-` 开头的备份文件（当前仓库 `bin/` 下有 `cw.exe` 与 `cw.exe.bak-20261010`，后者被忽略、前者保留）。
- **行7** 空行。
- **行8** `.orch-test-out.txt`：忽略编排测试输出文件。
- **行9** `.probe3.txt`：忽略探针测试标记文件。
- **行10** 空行。
- **行11** 注释：说明 `.dsh-ops/` 用途为 DSH 运行期产物（面板会话流、工具调用记录），不入库。
- **行12** `.dsh-ops/`：忽略 DSH 运行期产物目录。

### .codewiki/_meta.yaml

位于 `.codewiki/` 目录，CodeWiki 编译产物的元信息文件（源码行1-5）。无代码函数/类，以下为各字段含义与行号。

- **行1** `project: dsh-codewiki`：项目标识，与 `package.json` 行2 的包名对应。
- **行2** `repo_path: E:\ik\Documents\trae_projects\1\dsh plugin\dsh-codewiki`：仓库绝对路径（Windows 反斜杠，含空格，与 `cordis.patch.yml` 行21 指向同一目录）。
- **行3** `last_compiled_commit: 2658208d92c132bf2391e12dff9b427f77053c0d`：最近一次成功编译时的 git commit 哈希。
- **行4** `last_compiled_at: 2026-10-27T05:09:53.711955800Z`：最近一次编译完成时间（UTC ISO 8601）。
- **行5** `created_at: 2026-10-10T04:14:56.349123500Z`：该 wiki 产物首次生成时间（UTC）。

## Architecture

```text
┌──────────────────┐    ┌──────────────────────┐
│ package.json     │    │ cordis.patch.yml     │
│ (行1-28)         │    │ (行1-33)             │
│ metadata, deps,  │    │ insert id:codewiki   │
│ dsh.bundle.patch │    │ name, config:{}      │
└────────┬─────────┘    └──────────┬───────────┘
         │ (行25)                  │ (行19-24)
         ▼                         ▼
┌─────────────────────────────────────────────┐
│ DSH Runtime                                 │
│ load patch from package.json (行25)         │
│ register plugin (行20-24) apply defaults    │
│ from index.js Config schema (行22-23 note,  │
│   全量字段行60-86 liveConfig 行92-134)       │
└─────────────────────────────────────────────┘

┌──────────────────┐    ┌──────────────────┐
│ .gitignore       │    │ Git VCS          │
│ (行1-12)         │───►│ exclude artifacts│
└──────────────────┘    └──────────────────┘
```

`.gitignore`（行1-12）独立于上述运行时加载流程，在 Git 版本控制阶段过滤产物。`index.js` 的 `Config`/`liveConfig`（行60-134）才是全部 25 个配置项与运行期归一化的唯一来源，`cordis.patch.yml` 仅作空壳覆盖层。

## Data Flow

1. **初始化阶段**：
   - DSH 启动时，首先读取根目录的 `package.json`（行1-28）。
   - 验证 `engines` 字段（行13-16），确保当前 Node.js 版本 `>=20`（行14）且 DSH 版本 `>=0.2.0-rc.0`（行15）。若不满足，抛出错误并终止。
   - 解析 `dependencies`（行17-19），安装或链接 `@deepseek-ai/schemastery`（行18）。

2. **插件加载阶段**：
   - DSH 检查 `package.json` 中的 `dsh.bundle.patch` 字段（行20-27，具体为行25），获取值 `"cordis.patch.yml"`。
   - 读取 `cordis.patch.yml` 文件内容（行1-33）。
   - 解析 YAML 结构，找到 `- insert:` 列表（行19）。
   - 提取元素（行20-24）：
     - `id`: `"codewiki"`（行20）。
     - `name`: 解析 `file:///E:/ik/.../index.js` 路径（行21）。
     - `config`: 初始化为 `{}`（行24）。
   - 将 `codewiki` 插件注册到 DSH 插件管理器中，并把插件的 `Config` schema（行60-86）作为该命名空间的配置契约。

3. **配置应用阶段**：
   - 当用户调用 CodeWiki 相关功能时，DSH 会从插件配置中读取 `codewiki` 命名空间下的设置。
   - 由于 `cordis.patch.yml` 中 `config: {}` 为空（行24），实际生效的配置来自插件 `index.js` 的 `Config` schema 默认值（行60-86）经 `liveConfig()`（行92-134）归一化后的结果，未填的项沿用 schema 默认，用户覆盖项通过 patch 注入。全量 25 个字段见上文「index.js — Config schema」表。其中与本阶段相关的默认行为：
     - 若未设置 `binaryPath`，`resolveBinary()`（行140-160）搜索 `$PATH` 中的 `cw`，失败则使用内置 `bin/cw(.exe)`（注释见 `cordis.patch.yml` 行6）。
     - 若未设置 `batchProvider`/`batchModel`，默认 `workbuddy`/`hy3`。
     - `maxConcurrency` 默认 2，范围 1–8 硬顶 8（`liveConfig` 行107-109、常量行31/33）。
     - `bigConcurrency` 默认 0=跟随默认档，范围 1–8 硬顶 8（`liveConfig` 行111-113）。
     - `serialProjects` 默认开启；关闭后 `parallelLimit` 取 `parallelProjects`（1–4，默认 2）（`liveConfig` 行115-119）。
     - `planMode` 默认 `auto`=AST 符号 + LLM 语义聚类（`liveConfig` 行121）。
     - `agenticArticles` 默认开启，`agenticMaxSteps` 默认 30、硬顶 100（行123-126）。
     - `symbolIncremental` 默认开启（行79）。
     - `updateReminder` 默认开启，但仅在仓库根存在 `CodeWiki.md` 时注入提醒（行80；详见 `README.md` 行62）。

4. **排除流程**：
   - Git 在提交前扫描工作区，匹配 `.gitignore` 规则（行1-12）。
   - 若发现 `node_modules/`（行1）、`vendor/codewiki/target/`（行2）、`*.log`（行3）、`bin/*.bak-*`（行6）、`.orch-test-out.txt`（行8）、`.probe3.txt`（行9）或 `.dsh-ops/`（行12）等文件/目录，直接跳过索引，不纳入版本控制。

## Connections

- [[cli-interface]]：`package.json` 的 `main`（行7）和 `exports`（行8-11）定义了 CLI 和 Client 的入口，与命令行接口模块紧密相连。
- [[runtime-environment]]：`engines` 字段（行13-16）严格限制了 Node.js 和 DSH 版本，与运行时环境检测模块交互。
- [[dependency-management]]：`dependencies` 中的 `@deepseek-ai/schemastery`（行18）是运行时核心库，`index.js` 行14 用它定义 `Config` schema（行60-86），其 API 变更会影响全部配置项声明。
- [[plugin-system]]：`cordis.patch.yml` 是 DSH 插件系统的标准扩展点，遵循 Cordis 规范（行19-24）；设置页表单（`client.js`）通过 `configForms.mutate` 热改同一命名空间，与 patch 手改等价（见 `README.md` 行43-45）。
- [[wiki-compilation]]：配置项 `batchProvider`/`batchModel`/`bigProvider`/`bigModel`/`bigTokenBudget`（见 `cordis.patch.yml` 行7-8 注释与 `index.js` 行63-69）直接影响 Wiki 编译管线使用的 AI 后端与超大输入分层策略；`serialProjects`（行12/`index.js` 行73）控制单项目串行；`planMode` 控制划分策略；`agenticArticles` 控制写作方式；`symbolIncremental` 控制增量粒度；`package.json` 行4 描述提及 `large tier volces-ark/glm-5.3-flash 512k for oversized input`。

## Known Issues

- `cordis.patch.yml` 行21 的 `name` 字段硬编码为 Windows 绝对路径 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`，包含空格编码 `%20`。此路径仅适用于特定本地开发机器；根据行2-4 注释，bundle 安装形态使用此文件，本地开发直挂应走 `profiles/web/cordis.patch.yml`（安装步骤见 `README.md` 行66-81，需手动追加，仓库当前无 `profiles/` 目录）。若跨机器或生产环境未替换该路径，插件加载将失败。
- `cordis.patch.yml` 行24 `config: {}` 为空，所有默认配置未在 YAML 结构里显式声明，而是依赖插件 `index.js` 中的 `Config` schema 默认值（行60-86）经 `liveConfig()`（行92-134）归一化（见行22-23 注释）。若 DSH 加载器未将 patch 配置与插件 Config schema 合并，仅使用此空对象，则运行时可能缺少预期默认值（尽管设计意图是留空即用 schema 默认）。
- `.gitignore` 行6 忽略 `bin/*.bak-*`，但并未忽略 `bin/cw.exe` 本身；若非 Windows 平台且未提供对应二进制，`resolveBinary()`（行140-160）中 PATH 优先、找不到回退本地 `bin/cw` 的兜底逻辑可能失效。
- `package.json` 行4 `description` 声称 `zero subagents, single-project serial`，与 `serialProjects`（行73）默认开一致，但 `maxConcurrency`（行71）允许 1–8 并发编译请求，且 `bigConcurrency`（行72）独立限流，在单项目串行下仅约束跨项目并发，代理内仍可能并发，需文档澄清。
- `cordis.patch.yml` 行6-18 的注释只列出 13 个常用配置项，未暴露 `enabled`/`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`parallelProjects`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 这些字段。它们定义在 `index.js` 的 `Config`（行60-86）中且 `README.md` 行47-64 有完整文档，但仅看 patch 注释的读者看不到其存在——属于文档分散、非功能缺陷。
