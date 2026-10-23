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

本模块负责定义 `@local/dsh-codewiki` 项目的核心元数据、运行时依赖约束以及针对 DeepSeek Harness (DSH) 插件系统的补丁加载配置。它通过 `package.json` 声明 Node.js 环境要求及基础依赖，并通过 `cordis.patch.yml` 精确控制 CodeWiki 功能在 DSH 中的挂载方式、默认行为参数（如 Provider、Model、并发限制）以及二进制文件路径解析逻辑。此外，`.gitignore` 确保了构建产物和临时日志不会污染版本控制系统。

该模块是项目静态结构的一部分，但在运行时被 `dsh bundle` 命令读取，用于生成最终的插件包或指导本地开发环境的 Cordis 挂载行为。当前版本为 `0.9.2`（见 `package.json` 行3）。

## Key Components

### package.json

位于仓库根目录，JSON 格式配置文件（源码行1-28）。

- **行2** `name`: `"@local/dsh-codewiki"`。项目唯一标识符。
- **行3** `version`: `"0.9.2"`。当前语义化版本号（旧版为 0.9.1，已更新）。
- **行4** `description`: `"CodeWiki for DeepSeek Harness: cw CLI + whole-repo wiki compilation pipeline (plain Bailian endpoint, zero subagents) with a sidebar panel."` 描述 CLI (`cw`)、全仓库 Wiki 编译管线（纯 Bailian 端点，零子代理）及侧边栏面板功能。
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

位于仓库根目录，YAML 格式补丁定义文件（源码行1-15）。由 `dsh bundle` 或 Cordis 加载器读取。

- **行1-11** 注释块：
  - 行1-3 说明文件用途：供 bundle 形式安装使用；本地开发应使用 `profiles/web/cordis.patch.yml` 中的 `file:///` 直挂方式（URL 中空格写 `%20`），二者保持 id 一致为 `codewiki`。
  - 行4-11 详细列出 `config` 命名空间（= `codewiki`）下的配置项含义：
    - `binaryPath`：cw 可执行文件路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`。
    - `defaultProvider`：子代理默认 provider（与 `defaultModel` 成对生效；默认 `aliyun-bailian`）。
    - `defaultModel`：子代理默认 model（默认 `qwen3.8-flash`，即路由插件 wiki 档）。
    - `defaultReasoningEffort`：子代理默认思考程度（adapter 自有值如 off/low/high/max；留空跟随模型默认）。
    - `maxConcurrency`：写文章子代理并发上限（硬顶 2）。
    - `articleLanguage`：文章语言（默认中文）。
    - `updateReminder`：会话系统提示注入 wiki 维护提醒（仅当会话仓库存在 `.codewiki/`；默认开）。
- **行12** `- insert:`：定义插入操作。
- **行13** `- id: codewiki`：插件 ID，固定为 `codewiki`，须全局唯一且与本地开发配置一致。
- **行14** `name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`：指向本地绝对路径的 `index.js`，包含空格编码 `%20`，为 Windows 绝对路径。根据行2-3注释，此路径为 bundle 安装形态；本地开发直挂走另一文件。
- **行15** `config: {}`：初始配置对象为空。实际配置项（如上述 `binaryPath` 等）需在用户侧或后续合并过程中注入，或在此处展开具体值（当前源码未展开）。

### .gitignore

位于仓库根目录，Git 忽略规则文件（源码行1-12）。

- **行1** `node_modules/`：忽略 npm/yarn/pnpm 安装的依赖目录。
- **行2** `vendor/codewiki/target/`：忽略 vendor 目录下 CodeWiki 构建的目标输出文件夹。
- **行3** `*.log`：忽略所有日志文件。
- **行5** 注释说明 `bin/*.bak-*` 用途：cw 二进制备份（丢失源码的最后产物，安全网）。
- **行6** `bin/*.bak-*`：忽略 `bin/` 目录下以 `.bak-` 开头的备份文件。
- **行8** `.orch-test-out.txt`：忽略编排测试输出文件。
- **行9** `.probe3.txt`：忽略探针测试文件。
- **行11** 注释说明 `.dsh-ops/` 用途：DSH 运行期产物（面板会话流、工具调用记录），不入库。
- **行12** `.dsh-ops/`：忽略 DSH 运行期产物。

## Architecture

```text
┌──────────────────┐    ┌──────────────────────┐
│ package.json     │    │ cordis.patch.yml     │
│ (行1-28)         │    │ (行1-15)             │
│ metadata, deps,  │    │ insert id:codewiki   │
│ dsh.bundle.patch │    │ name, config:{}      │
└────────┬─────────┘    └──────────┬───────────┘
         │                         │
         ▼                         ▼
┌─────────────────────────────────────────────┐
│ DSH Runtime                                 │
│ load patch from package.json (行25)         │
│ register plugin (行13-15) apply defaults    │
└─────────────────────────────────────────────┘
```

## Data Flow

1. **初始化阶段**：
   - DSH 启动时，首先读取根目录的 `package.json`（行1-28）。
   - 验证 `engines` 字段（行13-16），确保当前 Node.js 版本 `>=20`（行14）且 DSH 版本 `>=0.2.0-rc.0`（行15）。若不满足，抛出错误并终止。
   - 解析 `dependencies`（行17-19），安装或链接 `@deepseek-ai/schemastery`（行18）。

2. **插件加载阶段**：
   - DSH 检查 `package.json` 中的 `dsh.bundle.patch` 字段（行24-25），获取值 `"cordis.patch.yml"`。
   - 读取 `cordis.patch.yml` 文件内容（行1-15）。
   - 解析 YAML 结构，找到 `- insert:` 列表（行12）。
   - 提取元素（行13-15）：
     - `id`: `"codewiki"`（行13）。
     - `name`: 解析 `file:///E:/ik/.../index.js` 路径（行14）。
     - `config`: 初始化为 `{}`（行15）。
   - 将 `codewiki` 插件注册到 DSH 插件管理器中。

3. **配置应用阶段**：
   - 当用户调用 CodeWiki 相关功能时，DSH 会从插件配置中读取 `codewiki` 命名空间下的设置。
   - 由于 `cordis.patch.yml` 中 `config: {}` 为空（行15），实际生效的配置取决于 DSH 的全局配置覆盖或默认值逻辑（见行4-11 注释中的默认值说明）：
     - 若未设置 `binaryPath`，系统搜索 `$PATH` 中的 `cw`，失败则使用内置 `bin/cw.exe`。
     - 若未设置 `defaultProvider`，默认为 `aliyun-bailian`。
     - 若未设置 `defaultModel`，默认为 `qwen3.8-flash`。
     - `maxConcurrency` 硬限制为 2。
     - `articleLanguage` 默认为中文。
     - `updateReminder` 默认开启，但仅在检测到 `.codewiki/` 目录时注入提醒。

4. **排除流程**：
   - Git 在提交前扫描工作区，匹配 `.gitignore` 规则（行1-12）。
   - 若发现 `node_modules/`（行1）、`vendor/codewiki/target/`（行2）、`*.log`（行3）、`bin/*.bak-*`（行6）、`.orch-test-out.txt`（行8）、`.probe3.txt`（行9）或 `.dsh-ops/`（行12）等文件/目录，直接跳过索引，不纳入版本控制。

## Connections

- [[cli-interface]]：`package.json` 的 `main`（行7）和 `exports`（行8-11）定义了 CLI 和 Client 的入口，与命令行接口模块紧密相连。
- [[runtime-environment]]：`engines` 字段（行13-16）严格限制了 Node.js 和 DSH 版本，与运行时环境检测模块交互。
- [[dependency-management]]：`dependencies` 中的 `@deepseek-ai/schemastery`（行18）是运行时核心库，其 API 变更可能影响插件行为。
- [[plugin-system]]：`cordis.patch.yml` 是 DSH 插件系统的标准扩展点，遵循 Cordis 规范（行12-15）。
- [[wiki-compilation]]：配置项 `defaultProvider` 和 `defaultModel`（见 `cordis.patch.yml` 行6-7 注释）直接影响 Wiki 编译管线使用的 AI 后端。

## Known Issues

- `cordis.patch.yml` 行14 的 `name` 字段硬编码为 Windows 绝对路径 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`，包含空格编码 `%20`。此路径仅适用于特定本地开发机器；根据行2-3 注释，bundle 安装形态应使用此文件，而本地开发直挂应走 `profiles/web/cordis.patch.yml`。若跨机器或生产环境未替换该路径，插件加载将失败。
- `cordis.patch.yml` 行15 `config: {}` 为空，所有默认配置仅存在于注释（行4-11）中，并未在 YAML 结构里显式声明。若 DSH 加载器不解析注释，则必须依赖外部注入配置，否则运行时可能缺少预期默认值（尽管注释声明了默认行为）。
- `.gitignore` 行6 忽略 `bin/*.bak-*`，但并未忽略 `bin/cw.exe` 本身；若非 Windows 平台且未提供对应二进制，cordis.patch.yml 行5 注释中的回退逻辑（优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`）可能失效。