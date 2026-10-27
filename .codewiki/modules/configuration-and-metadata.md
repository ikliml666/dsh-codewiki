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

本模块负责定义 `@local/dsh-codewiki` 项目的**核心元数据、运行时依赖约束、DSH 插件挂载补丁、Git 忽略规则与 CodeWiki 产物元信息**。它由五个静态文件组成，自身不含任何可执行逻辑，但在 `dsh bundle` 打包 / 本地开发直挂时被读取，决定了插件以何种 id 挂载、默认编译行为从哪取、以及哪些产物不进版本库。

- `package.json`（行1-29）声明 Node.js/DHS 环境要求、基础依赖与 DSH 打包字段，是当前插件所有行为的「包级声明」。
- `cordis.patch.yml`（行1-34）是 DSH 插件系统的 Cordis 挂载补丁：以 `- insert:` 把本插件注册为 id `codewiki`，并声明 config 命名空间 = `codewiki`。注意它**不在此处声明任何默认值**——注释块（行6-18）只列出配置项含义，真正的默认值在 `index.js` 的 `Config` schema（行60-86）里定义，`cordis.patch.yml` 的 `config: {}`（行24）只是空壳，留空即用 schema 默认。
- `.gitignore`（行1-13）保证构建产物、cw 二进制备份、DSH 运行期产物、探针与测试输出不污染版本库。
- `.codewiki/_meta.yaml`（行1-6）是 CodeWiki 编译产物的元信息（项目名、仓库绝对路径、最近编译 commit 与时间戳）。

> 关键更新：旧版配置清单只列了 `cordis.patch.yml` 注释里的 14 项，**漏掉了 `index.js` 的 `Config` schema 中新增的 `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`parallelProjects`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 等字段**。这些才是「large tier 超大输入分层编译」真正启用与并发/自动提交策略的配置来源，详见下文「Config schema」小节。

当前版本为 `0.13.4`（`package.json` 行3）。`package.json` 行4 的描述明确了：CLI（`cw`）、全仓库 Wiki 编译管线（插件内、默认 `workbuddy`/`hy3` 192k 上下文、`large tier volces-ark/glm-5.3-flash` 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能；并声明自 0.13.0 起吸收了 FSoft-AI4Code/CodeWiki 的 AST 符号提取 + LLM 语义聚类、agentic 工具循环文章写作、符号级增量更新，基于 Node + tree-sitter WASM 实现（无 Python 运行时）。`README.md` 行1-5 与 `CodeWiki.md` 同步描述了同一套能力，其中 `README.md` 行2 说明了 `cw` 是 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI，MIT）的接入包装。

 `@local/dsh-codewiki` 项目的核心元数据、运行时依赖约束以及针对 DeepSeek Harness (DSH) 插件系统的补丁加载配置。它通过 `package.json`（行1-28）声明 Node.js 环境要求及基础依赖，并通过 `cordis.patch.yml`（行1-33）精确控制 CodeWiki 功能在 DSH 中的挂载方式、默认行为参数（如 `binaryPath`、`batchProvider`、`batchModel`、并发限制、单项目串行、计划模式、agentic 写作、符号级增量等）以及二进制文件路径解析逻辑。此外，`.gitignore`（行1-12）确保了构建产物和临时日志不会污染版本控制系统。

该模块是项目静态结构的一部分，但在运行时被 `dsh bundle` 命令读取，用于生成最终的插件包或指导本地开发环境的 Cordis 挂载行为。当前版本为 `0.13.4`（见 `package.json` 行3），其描述（行4）明确了 CLI (`cw`)、全仓库 Wiki 编译管线（插件内、默认 workbuddy/hy3 192k 上下文、large tier volces-ark/glm-5.3-flash 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能，并声明自 0.13.0 起吸收了 FSoft-AI4Code/CodeWiki 的 AST 符号提取 + LLM 语义聚类、agentic 工具循环文章写作、符号级增量更新，基于 Node + tree-sitter WASM 实现（无 Python 运行时）。

## Key Components

本模块由三个配置文件组成，无代码函数/类，以下列出各文件结构及字段含义。

### package.json

位于仓库根目录，JSON 格式配置文件（源码行1-29）。无代码函数/类，以下为各字段含义与行号。

- **行2** `"name": "@local/dsh-codewiki"`：项目唯一标识符（命名空间 `@local/` 表示本地私有包）。
- **行3** `"version": "0.13.4"`：当前语义化版本号。
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

位于仓库根目录，YAML 格式补丁定义文件（源码行1-34）。由 `dsh bundle` 或 Cordis 加载器读取。

- **行1-4** 注释块：
  - 行1 说明文件用途：dsh-codewiki — CodeWiki (mraza007/codewiki) for DeepSeek Harness。
  - 行2 说明 0.13.0 起吸入 AST 聚类 / agentic 写作 / 符号级增量三层能力。
  - 行3-4 说明挂载方式：本文件供 **bundle 形式安装**用；本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂（URL 中空格写 `%20`），二者保持 id 一致为 `codewiki`。⚠️ 注意：仓库当前**不存在 `profiles/` 目录**（`list_files('profiles')` 报 ENOENT），该本地开发直挂文件实际缺失，仅 bundle 形态可用。
- **行5** 指明设置项 config 命名空间 = `codewiki`。
- **行6-18** 注释块列出配置项含义（仅注释，未在 YAML 主体展开默认值）：
  - `binaryPath`（行6）：cw 可执行路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe` / `bin/cw`。
  - `batchProvider`（行7）：编译模型提供商（必须是模型设置里已注册的 provider；默认 `workbuddy`，留空=提交失败）。
  - `batchModel`（行8）：编译模型 id（默认 `hy3`，免费 192k 上下文）。
  - `batchReasoningEffort`（行9）：思考档位（取值来自模型目录 `reasoning.efforts`；留空=模型默认档）。
  - `maxConcurrency`（行10）：默认档并发上限（1–8，默认 2）。
  - `bigConcurrency`（行11）：大档并发上限（1–8，默认 0=跟随默认档），与默认档各自独立限流。
  - `serialProjects`（行12）：单项目串行（默认开）。
  - `articleLanguage`（行13）：文章语言（默认中文）。
  - `planMode`（行14）：模块划分 auto=AST 符号+LLM 语义聚类（默认）｜dirs=顶层目录分组（旧行为）。
  - `agenticArticles`（行15）：文章写作走 agentic 工具循环（默认开）。
  - `agenticMaxSteps`（行16）：agentic 单篇步数上限（默认 30，1–100）。
  - `symbolIncremental`（行17）：增量按 AST 符号级判定（默认开）。
  - `updateReminder`（行18）：会话系统提示注入 wiki 维护提醒（默认开）。
  - ⚠️ 注意：上述注释只覆盖了 14 个配置项，**未提及** `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`parallelProjects`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`/`enabled`，这些真实字段全部定义在 `index.js` 的 `Config` schema 中（见本节末尾与下方「Config schema」小节）。
- **行19** `- insert:`：Cordis 的插入操作根节点。
- **行20** `- id: codewiki`：插件 ID，固定为 `codewiki`，须全局唯一且须与本地开发配置一致。
- **行21** `name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`：指向本地绝对路径的 `index.js`，含空格编码 `%20`，为 Windows 绝对路径。此为 bundle 安装形态声明。
- **行22-23** 注释：默认值不在本文件重复声明——留空即用插件 `Config` schema 里的默认值（见 `index.js` 的 `Config`）。想改哪项就填哪项。
- **行24** `config: {}`：初始配置对象为空。实际默认值来自 `index.js` 的 `Config`（行60-86）与 `liveConfig()`（行92-134）合并逻辑；本文件只作为用户覆盖层。
- **行25-33** 注释示例：展示如何填写 `config`（行26-33 注掉）以换编译模型、调并发、关掉 agentic 写作等，逐项对应行6-18 的配置项。

### .gitignore

位于仓库根目录，Git 忽略规则文件（源码行1-13）。无代码函数/类，以下为各规则行号与含义。

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
- **行13** 空行（文件末）。

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
│ from index.js Config schema (行22-23 note)  │
└─────────────────────────────────────────────┘

┌──────────────────┐    ┌──────────────────┐
│ .gitignore       │    │ Git VCS          │
│ (行1-12)         │───►│ exclude artifacts│
└──────────────────┘    └──────────────────┘
```

`.gitignore`（行1-12）独立于上述运行时加载流程，在 Git 版本控制阶段过滤产物。

## Data Flow

1. **初始化阶段**：
   - DSH 启动时，首先读取根目录的 `package.json`（行1-28）。
   - 验证 `engines` 字段（行13-16），确保当前 Node.js 版本 `>=20`（行14）且 DSH 版本 `>=0.2.0-rc.0`（行15）。若不满足，抛出错误并终止。
   - 解析 `dependencies`（行17-19），安装或链接 `@deepseek-ai/schemastery`（行18）。

2. **插件加载阶段**：
   - DSH 检查 `package.json` 中的 `dsh.bundle.patch` 字段（行24-26，具体为行25），获取值 `"cordis.patch.yml"`。
   - 读取 `cordis.patch.yml` 文件内容（行1-33）。
   - 解析 YAML 结构，找到 `- insert:` 列表（行19）。
   - 提取元素（行20-24）：
     - `id`: `"codewiki"`（行20）。
     - `name`: 解析 `file:///E:/ik/.../index.js` 路径（行21）。
     - `config`: 初始化为 `{}`（行24）。
   - 将 `codewiki` 插件注册到 DSH 插件管理器中。

3. **配置应用阶段**：
   - 当用户调用 CodeWiki 相关功能时，DSH 会从插件配置中读取 `codewiki` 命名空间下的设置。
   - 由于 `cordis.patch.yml` 中 `config: {}` 为空（行24），实际生效的配置取决于插件 `index.js` 的 Config schema 默认值（见行22-23 注释），或外部注入覆盖：
     - 若未设置 `binaryPath`，系统搜索 `$PATH` 中的 `cw`，失败则使用内置 `bin/cw.exe`（行6）。
     - 若未设置 `batchProvider`，默认为 `workbuddy`（行7）。
     - 若未设置 `batchModel`，默认为 `hy3`（行8）。
     - 若未设置 `batchReasoningEffort`，留空跟随模型默认档（行9）。
     - `maxConcurrency` 默认 2，允许范围 1–8（行10）。
     - `bigConcurrency` 默认 0=跟随默认档，允许范围 1–8（行11）。
     - `serialProjects` 默认开启，同一时刻只推进一个仓库编译（行12）。
     - `articleLanguage` 默认为中文（行13）。
     - `planMode` 默认 `auto`=AST 符号 + LLM 语义聚类（行14）。
     - `agenticArticles` 默认开启，走 agentic 工具循环（行15）。
     - `agenticMaxSteps` 默认 30，范围 1–100（行16）。
     - `symbolIncremental` 默认开启，按 AST 符号级判定增量（行17）。
     - `updateReminder` 默认开启，但仅在检测到 `.codewiki/` 目录时注入提醒（行18）。

4. **排除流程**：
   - Git 在提交前扫描工作区，匹配 `.gitignore` 规则（行1-12）。
   - 若发现 `node_modules/`（行1）、`vendor/codewiki/target/`（行2）、`*.log`（行3）、`bin/*.bak-*`（行6）、`.orch-test-out.txt`（行8）、`.probe3.txt`（行9）或 `.dsh-ops/`（行12）等文件/目录，直接跳过索引，不纳入版本控制。

## Connections

- [[cli-interface]]：`package.json` 的 `main`（行7）和 `exports`（行8-11）定义了 CLI 和 Client 的入口，与命令行接口模块紧密相连。
- [[runtime-environment]]：`engines` 字段（行13-16）严格限制了 Node.js 和 DSH 版本，与运行时环境检测模块交互。
- [[dependency-management]]：`dependencies` 中的 `@deepseek-ai/schemastery`（行18）是运行时核心库，其 API 变更可能影响插件行为。
- [[plugin-system]]：`cordis.patch.yml` 是 DSH 插件系统的标准扩展点，遵循 Cordis 规范（行19-24）。
- [[wiki-compilation]]：配置项 `batchProvider` 和 `batchModel`（见 `cordis.patch.yml` 行7-8 注释）直接影响 Wiki 编译管线使用的 AI 后端；`serialProjects`（行12）控制单项目串行；`planMode`（行14）控制模块划分策略；`agenticArticles`（行15）控制文章写作方式；`symbolIncremental`（行17）控制增量更新粒度；`package.json` 行4 描述提及 `large tier volces-ark/glm-5.3-flash 512k for oversized input` 的分层编译策略。

## Known Issues

- `cordis.patch.yml` 行21 的 `name` 字段硬编码为 Windows 绝对路径 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`，包含空格编码 `%20`。此路径仅适用于特定本地开发机器；根据行2-4 注释，bundle 安装形态应使用此文件，而本地开发直挂应走 `profiles/web/cordis.patch.yml`。若跨机器或生产环境未替换该路径，插件加载将失败。
- `cordis.patch.yml` 行24 `config: {}` 为空，所有默认配置未在 YAML 结构里显式声明，而是依赖插件 `index.js` 中的 Config schema 默认值（见行22-23 注释）。若 DSH 加载器未将 patch 配置与插件 Config schema 合并，仅使用此空对象，则运行时可能缺少预期默认值（尽管设计意图是留空即用 schema 默认）。
- `.gitignore` 行6 忽略 `bin/*.bak-*`，但并未忽略 `bin/cw.exe` 本身；若非 Windows 平台且未提供对应二进制，cordis.patch.yml 行6 注释中的回退逻辑（优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`）可能失效。
- `package.json` 行4 `description` 声称 `zero subagents, single-project serial`，与 `cordis.patch.yml` 行12 `serialProjects` 默认开一致，但 `maxConcurrency`（行10）允许 1–8 并发编译请求，且新增 `bigConcurrency`（行11）独立限流，在单项目串行下仅约束跨项目并发，代理内仍可能并发，需文档澄清。
- `package.json` 行4 `description` 声明支持 `large tier volces-ark/glm-5.3-flash 512k for oversized input`，但 `cordis.patch.yml` 行6-18 的配置项注释仅列出了 `batchProvider` 和 `batchModel`（默认 workbuddy/hy3 192k 上下文），未提供用于超大输入的 large tier 模型（volces-ark/glm-5.3-flash 512k）的独立配置项或自动路由规则，可能导致实际运行无法按描述启用分层编译。尽管存在 `bigConcurrency`（行11）用于大档并发，但未指定对应模型，分层策略不明确。
