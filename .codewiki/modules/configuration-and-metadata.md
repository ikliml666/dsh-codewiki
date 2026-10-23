---
title: configuration-and-metadata
type: module
source_files:
  - package.json
  - cordis.patch.yml
  - .gitignore
tags: [配置, 元数据, 依赖, Cordis, Patch]
---

## Overview

本模块负责定义 `@local/dsh-codewiki` 项目的核心元数据、运行时依赖约束以及针对 DeepSeek Harness (DSH) 插件系统的补丁加载配置。它通过 `package.json`（行1-28）声明 Node.js 环境要求及基础依赖，并通过 `cordis.patch.yml`（行1-16）精确控制 CodeWiki 功能在 DSH 中的挂载方式、默认行为参数（如 batchProvider、batchModel、并发限制、单项目串行）以及二进制文件路径解析逻辑。此外，`.gitignore`（行1-12）确保了构建产物和临时日志不会污染版本控制系统。

该模块是项目静态结构的一部分，但在运行时被 `dsh bundle` 命令读取，用于生成最终的插件包或指导本地开发环境的 Cordis 挂载行为。当前版本为 `0.10.4`（见 `package.json` 行3），其描述（行4）明确了 CLI (`cw`)、全仓库 Wiki 编译管线（插件内、默认 workbuddy/hy3 192k 上下文、新增 large tier volces-ark/glm-5.3-flash 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能。

## Key Components

### package.json

位于仓库根目录，JSON 格式配置文件（源码行1-28）。

- **行2** `name`: `"@local/dsh-codewiki"`。项目唯一标识符。
- **行3** `version`: `"0.10.4"`。当前语义化版本号（较旧版 `0.10.3` 已更新）。
- **行4** `description`: `"CodeWiki for DeepSeek Harness: cw CLI + whole-repo wiki compilation pipeline (in-plugin, default workbuddy/hy3 192k, large tier volces-ark/glm-5.3-flash 512k for oversized input, zero subagents, single-project serial) with a sidebar panel."` 描述 CLI、全仓库 Wiki 编译管线及侧边栏面板功能，新增了 large tier 超大输入模型支持说明。
- **行5** `private: true`：标记为私有包，防止意外发布到 npm 公共注册表。
- **行6** `type: "module"`：启用 ES Modules (ESM) 支持，所有 `.js` 文件默认视为 ESM。
- **行7** `main: "index.js"`：入口点。
- **行8-11** `exports`：定义子路径导出。
  - **行9** `"."`: 映射至 `./index.js`。
  - **行10** `"./client"`: 映射至 `./client.js`。
- **行12** `license: "MIT"`：开源许可证类型。
- **行13-16** `engines`：
  - **行14** `node`: `">=20"`。强制要求 Node.js 版本不低于 20。
  - **行15** `dsh`: `">=0.2.0-rc.0"`。强制要求 DeepSeek Harness 版本不低于 0.2.0 的 rc.0 预发布版。
- **行17-19** `dependencies`：
  - **行18** `@deepseek-ai/schemastery`: `"^3.18.4"`。核心运行时依赖，用于 Schema 验证或工具定义。
- **行20-27** `dsh`：自定义字段，专供 DSH 工具链使用。
  - **行21-23** `client`：`platform` 为 `"web"`（行22），指定客户端运行平台为 Web。
  - **行24-26** `bundle`：`patch` 为 `"cordis.patch.yml"`（行25），指定打包时使用的 Cordis 补丁定义文件路径。

### cordis.patch.yml

位于仓库根目录，YAML 格式补丁定义文件（源码行1-16）。由 `dsh bundle` 或 Cordis 加载器读取。

- **行1-12** 注释块：
  - 行1 说明文件用途：dsh-codewiki — CodeWiki (mraza007/codewiki) for DeepSeek Harness。
  - 行2-3 说明挂载方式：本文件供 bundle 形式安装用；本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂（URL 中空格写 `%20`），二者保持 id 一致为 `codewiki`。
  - 行4 指明设置项 config 命名空间 = `codewiki`。
  - 行5-12 详细列出配置项含义（仅注释，未在 YAML 主体展开）：
    - `binaryPath`（行5）：cw 可执行文件路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`。
    - `batchProvider`（行6）：编译模型提供商（必须是模型设置里已注册的 provider；默认 `workbuddy`，留空=提交失败）。
    - `batchModel`（行7）：编译模型 id（默认 `hy3`，免费 192k 上下文）。
    - `batchReasoningEffort`（行8）：思考程度档位（取值来自模型目录 `reasoning.efforts`；留空=模型默认档）。
    - `maxConcurrency`（行9）：编译请求并发上限（1–8，默认 2）。
    - `serialProjects`（行10）：单项目串行（默认开；同一时刻只推进一个仓库的编译任务，其余排队）。
    - `articleLanguage`（行11）：文章语言（默认中文）。
    - `updateReminder`（行12）：会话系统提示注入 wiki 维护提醒（仅当会话仓库存在 `.codewiki/`；默认开）。
- **行13** `- insert:`：定义插入操作。
- **行14** `- id: codewiki`：插件 ID，固定为 `codewiki`，须全局唯一且与本地开发配置一致。
- **行15** `name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`：指向本地绝对路径的 `index.js`，包含空格编码 `%20`，为 Windows 绝对路径。根据行2-3注释，此路径为 bundle 安装形态；本地开发直挂走另一文件。
- **行16** `config: {}`：初始配置对象为空。实际配置项（如上述 `binaryPath` 等）需外部注入或依赖注释中的默认值说明。

### .gitignore

位于仓库根目录，Git 忽略规则文件（源码行1-12）。

- **行1** `node_modules/`：忽略 npm/yarn/pnpm 安装的依赖目录。
- **行2** `vendor/codewiki/target/`：忽略 vendor 目录下 CodeWiki 构建的目标输出文件夹。
- **行3** `*.log`：忽略所有日志文件。
- **行4** 空行。
- **行5** 注释说明 `bin/*.bak-*` 用途：cw 二进制备份（丢失源码的最后产物，安全网）。
- **行6** `bin/*.bak-*`：忽略 `bin/` 目录下以 `.bak-` 开头的备份文件。
- **行7** 空行。
- **行8** `.orch-test-out.txt`：忽略编排测试输出文件。
- **行9** `.probe3.txt`：忽略探针测试文件。
- **行10** 空行。
- **行11** 注释说明 `.dsh-ops/` 用途：DSH 运行期产物（面板会话流、工具调用记录），不入库。
- **行12** `.dsh-ops/`：忽略 DSH 运行期产物。

## Architecture

```text
┌──────────────────┐    ┌──────────────────────┐
│ package.json     │    │ cordis.patch.yml     │
│ (行1-28)         │    │ (行1-16)             │
│ metadata, deps,  │    │ insert id:codewiki   │
│ dsh.bundle.patch │    │ name, config:{}      │
└────────┬─────────┘    └──────────┬───────────┘
         │ (行25)                  │ (行14-16)
         ▼                         ▼
┌─────────────────────────────────────────────┐
│ DSH Runtime                                 │
│ load patch from package.json (行25)         │
│ register plugin (行14-16) apply defaults    │
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
   - 读取 `cordis.patch.yml` 文件内容（行1-16）。
   - 解析 YAML 结构，找到 `- insert:` 列表（行13）。
   - 提取元素（行14-16）：
     - `id`: `"codewiki"`（行14）。
     - `name`: 解析 `file:///E:/ik/.../index.js` 路径（行15）。
     - `config`: 初始化为 `{}`（行16）。
   - 将 `codewiki` 插件注册到 DSH 插件管理器中。

3. **配置应用阶段**：
   - 当用户调用 CodeWiki 相关功能时，DSH 会从插件配置中读取 `codewiki` 命名空间下的设置。
   - 由于 `cordis.patch.yml` 中 `config: {}` 为空（行16），实际生效的配置取决于 DSH 的全局配置覆盖或默认值逻辑（见行5-12 注释中的默认值说明）：
     - 若未设置 `binaryPath`，系统搜索 `$PATH` 中的 `cw`，失败则使用内置 `bin/cw.exe`（行5）。
     - 若未设置 `batchProvider`，默认为 `workbuddy`（行6）。
     - 若未设置 `batchModel`，默认为 `hy3`（行7）。
     - 若未设置 `batchReasoningEffort`，留空跟随模型默认档（行8）。
     - `maxConcurrency` 默认 2，允许范围 1–8（行9）。
     - `serialProjects` 默认开启，同一时刻只推进一个仓库编译（行10）。
     - `articleLanguage` 默认为中文（行11）。
     - `updateReminder` 默认开启，但仅在检测到 `.codewiki/` 目录时注入提醒（行12）。

4. **排除流程**：
   - Git 在提交前扫描工作区，匹配 `.gitignore` 规则（行1-12）。
   - 若发现 `node_modules/`（行1）、`vendor/codewiki/target/`（行2）、`*.log`（行3）、`bin/*.bak-*`（行6）、`.orch-test-out.txt`（行8）、`.probe3.txt`（行9）或 `.dsh-ops/`（行12）等文件/目录，直接跳过索引，不纳入版本控制。

## Connections

- [[cli-interface]]：`package.json` 的 `main`（行7）和 `exports`（行8-11）定义了 CLI 和 Client 的入口，与命令行接口模块紧密相连。
- [[runtime-environment]]：`engines` 字段（行13-16）严格限制了 Node.js 和 DSH 版本，与运行时环境检测模块交互。
- [[dependency-management]]：`dependencies` 中的 `@deepseek-ai/schemastery`（行18）是运行时核心库，其 API 变更可能影响插件行为。
- [[plugin-system]]：`cordis.patch.yml` 是 DSH 插件系统的标准扩展点，遵循 Cordis 规范（行13-16）。
- [[wiki-compilation]]：配置项 `batchProvider` 和 `batchModel`（见 `cordis.patch.yml` 行6-7 注释）直接影响 Wiki 编译管线使用的 AI 后端；`serialProjects`（行10）控制单项目串行；`package.json` 行4 描述提及 `large tier volces-ark/glm-5.3-flash 512k for oversized input` 的分层编译策略。

## Known Issues

- `cordis.patch.yml` 行15 的 `name` 字段硬编码为 Windows 绝对路径 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`，包含空格编码 `%20`。此路径仅适用于特定本地开发机器；根据行2-3 注释，bundle 安装形态应使用此文件，而本地开发直挂应走 `profiles/web/cordis.patch.yml`。若跨机器或生产环境未替换该路径，插件加载将失败。
- `cordis.patch.yml` 行16 `config: {}` 为空，所有默认配置仅存在于注释（行5-12）中，并未在 YAML 结构里显式声明。若 DSH 加载器不解析注释，则必须依赖外部注入配置，否则运行时可能缺少预期默认值（尽管注释声明了默认行为）。
- `.gitignore` 行6 忽略 `bin/*.bak-*`，但并未忽略 `bin/cw.exe` 本身；若非 Windows 平台且未提供对应二进制，cordis.patch.yml 行5 注释中的回退逻辑（优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`）可能失效。
- `package.json` 行4 `description` 声称 `zero subagents, single-project serial`，与 `cordis.patch.yml` 行10 `serialProjects` 默认开一致，但 `maxConcurrency`（行9）允许 1–8 并发编译请求，在单项目串行下仅约束跨项目并发，代理内仍可能并发，需文档澄清。
- `package.json` 行4 `description` 声明支持 `large tier volces-ark/glm-5.3-flash 512k for oversized input`，但 `cordis.patch.yml` 行5-12 的配置项注释仅列出了 `batchProvider` 和 `batchModel`（默认 workbuddy/hy3 192k 上下文），未提供用于超大输入的 large tier 模型（volces-ark/glm-5.3-flash 512k）的独立配置项或自动路由规则，可能导致实际运行无法按描述启用分层编译。