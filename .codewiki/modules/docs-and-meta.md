---
title: docs-and-meta
type: module
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
tags: [文档, 元信息, 项目说明, 变更日志, 探针, codewiki]
---

## Overview

`docs-and-meta` 模块收纳 `@local/dsh-codewiki` 插件的项目说明、代码维基与变更日志等文档，并附带探针文件用于内部检测与元信息记录。本模块本身不含可执行代码，而是以纯文本形式（Markdown 与探针标记）定义插件的人机接口、架构约定、配置项语义与版本演进历史，为开发者与后续 agent 提供零上下文接入所需的完整描述。

收录文件如下：

- `README.md`：插件安装、工具提供、设置项与开发验证说明（行 1-66）。
- `CodeWiki.md`：插件自身的 CodeWiki 入口与细化架构描述（行 1-66）。
- `CHANGELOG.md`：自 0.1.0 至 0.10.8 的全部变更记录（行 1-627）。
- `.probe3.txt`：内部探针标记文件，仅含 `probe` 字样（行 1）。

## Key Components

本模块为文档与元信息模块，无代码函数/类/常量；其结构化组件由以下文档章节与配置模型字段构成，均带源码行号锚点。

### 文档文件与核心章节

| 文件 | 行号区间 | 章节 / 组件 | 用途与内容 |
|------|----------|-------------|------------|
| `README.md` | 1-3 | 标题与简介 | 说明插件接入 `mraza007/codewiki` 与 DeepSeek Harness 的定位 |
| `README.md` | 7-13 | 提供工具表 | 列出 `cw`(行9)、`codewiki_generate`(行10)、`codewiki_update`(行11)、`codewiki_progress`(行12)、CodeWiki 设置页(行13) |
| `README.md` | 15-22 | `codewiki_generate` 关键行为 | `scope=auto`(行17)、插件内模型环节(行18)、失败记账(行19)、并发(行20)、`serialProjects`(行21)、`scope=full`(行22) |
| `README.md` | 24-39 | 设置段（配置模型字段定义） | 详述 `batchProvider` 等配置项及 `volatile` 热生效(行39) |
| `README.md` | 41-56 | 安装（本地 file:/// 直挂） | `cordis.patch.yml` 追加条目(行46-53)、依赖解析(行55)、客户端半侧(行56) |
| `README.md` | 58-66 | 开发 | `vendor/codewiki`(行61)、`bin/cw.exe`(行62)、`client.js`(行63)、验证命令(行66) |
| `CodeWiki.md` | 5-7 | Overview | 编译不走子代理、大档/会话通道适配说明 |
| `CodeWiki.md` | 9-28 | Key Components | 描述 `index.js` 单文件逻辑(行11-21)、`client.js`(行23-26)、`cordis.patch.yml`(行27)、`package.json`(行28) |
| `CodeWiki.md` | 30-48 | Architecture | 阶段机框图与流程 |
| `CodeWiki.md` | 50-52 | Data Flow | 配置流、凭证流、任务流、面板流 |
| `CodeWiki.md` | 54-56 | Connections | 指向 `[[codewiki-upstream]]`(行56) |
| `CodeWiki.md` | 59-66 | Known Issues | 不热加载、junction 重建、cw 限制等 |
| `CHANGELOG.md` | 3-627 | 版本变更记录 | 0.10.8(行3-15) 至 0.1.0(行613-627) 的全部修复/功能/测试说明 |
| `.probe3.txt` | 1 | 探针标记 | 内容 `probe`，供内部检测与元信息记录 |

### 文档中记录的配置模型字段（对应 `Config` 结构，详见 `CodeWiki.md:12` 与 `README.md:55-66`）

以下字段在文档中被定义为插件 `Config` 的键值（schemastery 声明，全部 `.volatile()` 热读取）：

- `enabled`：开关，见于 `CodeWiki.md:12`。
- `binaryPath`：`cw` 可执行路径；留空优先 PATH（README.md:34）。
- `maxConcurrency`：编译并发上限，默认 2，硬顶 8（README.md:35）。
- `serialProjects`：单项目串行，默认 true（README.md:36，CodeWiki.md:12）。
- `articleLanguage`：文章语言，默认中文（README.md:37）。
- `updateReminder`：系统提示注入提醒，默认开（README.md:38）。
- `batchProvider`：编译模型 provider，默认 `workbuddy`；0.10.1 起必须已注册，留空提交失败（README.md:29，CodeWiki.md:12）。
- `batchModel`：编译模型 id，默认 `hy3`（README.md:29）。
- `batchReasoningEffort`：思考档位 id，从模型目录读取（README.md:30）。
- `sessionTier`：仅超大输入兜底时钉死的子智能体档位 id（README.md:32，CodeWiki.md:12）。
- `bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`：大档模型四项，默认 `volces-ark`/`glm-5.3-flash`/空/420000（README.md:31，CodeWiki.md:12）。

### 探针文件组件

- `.probe3.txt:1` — 文件唯一内容为一行 `probe`，作为内部检测锚点与元信息存在证明，无结构化 schema。

## Architecture

文档模块与插件实现之间的元信息映射与内部检测关系如下：

```text
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ README.md    │  │ CodeWiki.md  │  │ CHANGELOG.md │
│ (行1-66)     │  │ (行1-66)     │  │ (行1-627)    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ 工具/设置说明     │ 自身Wiki细化    │ 版本演进记录
       ▼                 ▼                 ▼
┌──────────────────────────────────────────────────┐
│ @local/dsh-codewiki 插件 (index.js/client.js)      │
│ 实现 cw 封装、codewiki_generate 等工具与服务        │
└──────────────────────────────────────────────────┘
       ▲
       │ 内部检测元信息
       ▼
┌──────────────┐
│ .probe3.txt  │
│ (行1: probe) │
└──────────────┘
```

## Data Flow

文档信息流与配置同步路径：

1. **阅读与理解**：开发者/agent 读取 `README.md`(行 24-39) 与 `CodeWiki.md`(行 12) 获取配置模型字段定义与默认值。
2. **配置落地**：通过修改 `profiles/web/cordis.patch.yml`(README.md:46-53) 或插件设置页（`client.js`，README.md:56) 写入配置。
3. **热生效**：插件 `apply` 注入时 `liveConfig` 每次调用解包，配置 `volatile` 改完即生效（README.md:39）。
4. **演进追踪**：`CHANGELOG.md`(行 3-627) 按版本记录行为变更，如 0.10.1 删除内置直连(行101-113)、0.10.8 大档单请求优先(行3-15)。
5. **元信息检测**：`.probe3.txt`(行1) 提供探针标记，供外部脚本或内部检测确认模块存在性与仓库布局。
6. **交叉连接**：`CodeWiki.md` 通过 `[[codewiki-upstream]]`(行56) 关联上游 vendor 源码布局。

## Connections

- [[codewiki-upstream]] — `CodeWiki.md:56` 指向 `vendor/codewiki`（MIT）上游源码与布局约定，文档模块与之形成描述与被描述关系。
- 插件主逻辑（`index.js` / `client.js`）在 `CodeWiki.md:11-26` 被细化描述，本文档模块为其对外说明面。
- 探针文件 `.probe3.txt` 与文档同源提交，构成 `docs-and-meta` 模块的内部检测基底。

## Known Issues

- **文档同步风险**：`CHANGELOG.md:11-12` 记录 0.10.8 修复了 0.10.7 遗留的文档失同步（五环节阶段机、大档 420k 语义等），未来改代码须同步 `README.md`/`CodeWiki.md`。
- **插件注册不热加载**：`README.md:39`、`CodeWiki.md:61` 明确指出改 `index.js` / `client.js` / profile patch 后需重启 dsh，仅配置值热读。
- **探针文件无 schema**：`.probe3.txt:1` 仅含 `probe` 字面量，无字段结构，依赖外部解析器约定，不保证扩展性。
- **上游 cw 限制**：`CodeWiki.md:63-64` 记录上游 `cw` 无 `--version`、stale 路径反斜杠等已知问题，文档已说明但底层未完全解决（仅插件层归一化）。
- **junction 依赖**：`CodeWiki.md:62` 指出 `@deepseek-ai/schemastery` 靠插件本地 junction，换机器需重建，文档已提示但非代码修复。