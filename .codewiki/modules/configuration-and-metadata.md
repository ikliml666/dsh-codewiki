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

该模块是项目静态结构的一部分，但在运行时被 `dsh bundle` 命令读取，用于生成最终的插件包或指导本地开发环境的 Cordis 挂载行为。

## Key Components

### package.json
位于仓库根目录，JSON 格式配置文件。

- **行 1**: `name`: `"@local/dsh-codewiki"`。项目唯一标识符。
- **行 2**: `version`: `"0.8.6"`。当前语义化版本号。
- **行 3**: `description`: 描述 CLI (`cw`)、全仓库 Wiki 编译管线（纯 Bailian 端点，零子代理）及侧边栏面板功能。
- **行 4**: `private: true`
    - 标记为私有包，防止意外发布到 npm 公共注册表。
- **行 5**: `type: "module"`
    - 启用 ES Modules (ESM) 支持，所有 `.js` 文件默认视为 ESM。
- **行 6-9**: `main`, `exports`
    - `main`: `"index.js"`。入口点。
    - `exports`: 定义子路径导出。
        - `"."`: 映射至 `./index.js`。
        - `"./client"`: 映射至 `./client.js`。
- **行 10**: `license: "MIT"`
    - 开源许可证类型。
- **行 11-15**: `engines`
    - `node`: `">=20"`。强制要求 Node.js 版本不低于 20。
    - `dsh`: `">=0.2.0-rc.0"`。强制要求 DeepSeek Harness 版本不低于 0.2.0 的 rc.0 预发布版。
- **行 16-18**: `dependencies`
    - `@deepseek-ai/schemastery`: `"^3.18.4"`。核心运行时依赖，用于 Schema 验证或工具定义。
- **行 19-27**: `dsh`
    - 自定义字段，专供 DSH 工具链使用。
    - `client.platform`: `"web"`。指定客户端运行平台为 Web。
    - `bundle.patch`: `"cordis.patch.yml"`。指定打包时使用的 Cordis 补丁定义文件路径。

### cordis.patch.yml
位于仓库根目录，YAML 格式补丁定义文件。由 `dsh bundle` 或 Cordis 加载器读取。

- **行 1-10**: 注释块
    - 说明文件用途：供 bundle 形式安装使用；本地开发应使用 `profiles/web/cordis.patch.yml` 中的 `file:///` 直挂方式。
    - 强调 ID 一致性：ID 必须保持为 `codewiki`。
    - 详细列出 `config` 命名空间下的配置项含义：
        - `binaryPath`: `cw` 可执行文件路径。留空则优先查找 PATH，再回退到插件自带 `bin/cw.exe`。
        - `defaultProvider`: 子代理默认 Provider（与 `defaultModel` 成对生效）。
        - `defaultModel`: 子代理默认 Model。
        - `defaultReasoningEffort`: 思考程度（adapter 自有值如 off/low/high/max；留空跟随模型默认）。
        - `maxConcurrency`: 写文章子代理并发上限（硬顶 2）。
        - `articleLanguage`: 文章语言。
        - `updateReminder`: 会话系统提示注入 wiki 维护提醒开关（仅当会话仓库存在 `.codewiki/`；默认开启）。
- **行 11**: `- insert:`
    - 定义插入操作。
- **行 12**: `- id: codewiki`
    - 插件 ID。必须全局唯一，此处固定为 `codewiki`。
- **行 13**: `name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`
    - **关键路径**：指向本地绝对路径的 `index.js`。
    - **注意**：此路径包含空格编码 `%20`，且为 Windows 绝对路径。在生产 Bundle 中，此路径通常会被替换或相对化处理，但在当前源码中保留为绝对路径，表明这可能是一个本地开发调试副本或特定环境配置。在实际分发中，`name` 字段通常应指向资源包内的相对路径或 URL。
- **行 14**: `config: {}`
    - 初始配置对象为空。实际配置项（如 `defaultProvider` 等）需在用户侧或后续合并过程中注入，或者在此处展开具体值。根据注释，这些配置项属于 `codewiki` 命名空间。

### .gitignore
位于仓库根目录，Git 忽略规则文件。

- **行 1**: `node_modules/`
    - 忽略 npm/yarn/pnpm 安装的依赖目录。
- **行 2**: `vendor/codewiki/target/`
    - 忽略 vendor 目录下 CodeWiki 构建的目标输出文件夹。
- **行 3**: `*.log`
    - 忽略所有日志文件。
- **行 5-6**: `bin/*.bak-*`
    - 忽略 `bin/` 目录下以 `.bak-` 开头的备份文件。注释说明这是 `cw` 二进制的最后产物安全网。
- **行 8**: `.orch-test-out.txt`
    - 忽略编排测试输出文件。
- **行 9**: `.probe3.txt`
    - 忽略探针测试文件。

## Architecture

```text
┌─────────────────────┐       ┌──────────────────────────┐
│   package.json      │       │   cordis.patch.yml       │
│                     │       │                          │
│ 1. Project Metadata │       │ 1. Plugin Definition     │
│    - name/version   │       │    - id: codewiki        │
│    - engines (Node  │       │    - name (URL/Path)     │
│      >=20, DSH >=   │       │    - config: {}          │
│      0.2.0-rc.0)    │       │                          │
│ 2. Dependencies     │       │ 2. Config Namespace      │
│    - schemastery    │       │    - binaryPath          │
│                     │       │    - defaultProvider     │
│ 3. DSH Hooks        │       │    - defaultModel        │
│    - client.platform│       │    - maxConcurrency      │
│    - bundle.patch   │       │    - articleLanguage     │
└─────────┬───────────┘       │    - updateReminder      │
          │                   └──────────┬───────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────────────────────────────────────────┐
│              DeepSeek Harness (DSH) Runtime             │
│                                                         │
│ 1. Load package.json to resolve dependencies & hooks    │
│ 2. Read 'bundle.patch' field -> load cordis.patch.yml   │
│ 3. Parse 'insert' block -> Register 'codewiki' plugin   │
│ 4. Apply config defaults (if any)                       │
│ 5. Initialize @deepseek-ai/schemastery                  │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

1.  **初始化阶段**:
    - DSH 启动时，首先读取根目录的 `package.json`。
    - 验证 `engines` 字段，确保当前 Node.js 版本 `>=20` 且 DSH 版本 `>=0.2.0-rc.0`。若不满足，抛出错误并终止。
    - 解析 `dependencies`，安装或链接 `@deepseek-ai/schemastery`。

2.  **插件加载阶段**:
    - DSH 检查 `package.json` 中的 `dsh.bundle.patch` 字段，获取值 `"cordis.patch.yml"`。
    - 读取 `cordis.patch.yml` 文件内容。
    - 解析 YAML 结构，找到 `insert` 列表。
    - 提取第一个元素：
        - `id`: `"codewiki"`。
        - `name`: 解析 `file:///...` URL 或路径。*注意：源码中为绝对路径，若用于跨机器分发，此路径需替换为相对路径或 CDN 地址。*
        - `config`: 初始化为 `{}`。
    - 将 `codewiki` 插件注册到 DSH 插件管理器中。

3.  **配置应用阶段**:
    - 当用户调用 CodeWiki 相关功能时，DSH 会从插件配置中读取 `codewiki` 命名空间下的设置。
    - 由于 `cordis.patch.yml` 中 `config: {}` 为空，实际生效的配置取决于 DSH 的全局配置覆盖或默认值逻辑（见注释中的默认值说明）：
        - 若未设置 `binaryPath`，系统搜索 `$PATH` 中的 `cw`，失败则使用内置 `bin/cw.exe`。
        - 若未设置 `defaultProvider`，默认为 `aliyun-bailian`。
        - 若未设置 `defaultModel`，默认为 `qwen3.8-flash`。
        - `maxConcurrency` 硬限制为 2。
        - `articleLanguage` 默认为中文。
        - `updateReminder` 默认开启，但仅在检测到 `.codewiki/` 目录时注入提醒。

4.  **排除流程**:
    - Git 在提交前扫描工作区，匹配 `.gitignore` 规则。
    - 若发现 `node_modules/`、`*.log` 或 `bin/*.bak-*` 等文件，直接跳过索引，不纳入版本控制。

## Connections

- [[cli-interface]]: `package.json` 的 `main` 和 `exports` 定义了 CLI 和 Client 的入口，与命令行接口模块紧密相连。
- [[runtime-environment]]: `engines` 字段严格限制了 Node.js 和 DSH 版本，与运行时环境检测模块交互。
- [[dependency-management]]: `dependencies` 中的 `@deepseek-ai/schemastery` 是运行时核心库，其 API 变更可能影响插件行为。
- [[plugin-system]]: `cordis.patch.yml` 是 DSH 插件系统的标准扩展点，遵循 Cordis 规范。
- [[wiki-compilation]]: 配置项 `defaultProvider` 和 `defaultModel` 直接影响 Wiki 编译管线使用的 AI 后端。