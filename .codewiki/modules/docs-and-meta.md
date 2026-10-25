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

`docs-and-meta` 模块收纳 `@local/dsh-codewiki` 插件的项目说明、代码维基与变更日志等文档，并附带探针文件用于内部检测与元信息记录。本模块本身不含可执行代码，而是以纯文本形式（Markdown 与探针标记）定义插件的人机接口、架构约定、配置项语义与版本演进历史，为开发者与后续 agent 提供零上下文接入所需的完整描述。当前文档覆盖插件版本至 0.11.2（见 `CHANGELOG.md:3-10` 与 `CHANGELOG.md:11-19`）。

收录文件如下：

- `README.md`：插件安装、工具提供、设置项与开发验证说明（行 1-67）。
- `CodeWiki.md`：插件自身的 CodeWiki 入口与细化架构描述（行 1-75）。
- `CHANGELOG.md`：自 0.1.0 至 0.11.2 的全部变更记录（行 1-703）。
- `.probe3.txt`：内部探针标记文件，仅含 `probe` 字样（行 1）。

## Key Components

本模块为文档与元信息模块，无代码函数/类/常量；其结构化组件由以下文档章节与配置模型字段构成，均带源码行号锚点。

### 文档文件与核心章节

| 文件 | 行号区间 | 章节 / 组件 | 用途与内容 |
|------|----------|-------------|------------|
| `README.md` | 1-3 | 标题与简介 | 说明插件接入 `mraza007/codewiki` 与 DeepSeek Harness 的定位 |
| `README.md` | 5-13 | 提供工具表 | 列出 `cw`(行9)、`codewiki_generate`(行10)、`codewiki_update`(行11)、`codewiki_progress`(行12)、CodeWiki 设置页(行13) |
| `README.md` | 15-22 | `codewiki_generate` 关键行为 | `scope=auto`(行17)、插件内模型环节(行18)、失败记账(行19)、并发(行20)、`serialProjects`(行21)、`scope=full`(行22) |
| `README.md` | 24-40 | 设置段（配置模型字段定义） | 详述 `batchProvider` 等配置项（行29-32、34-39）及 `volatile` 热生效(行40) |
| `README.md` | 42-57 | 安装（本地 file:/// 直挂） | `cordis.patch.yml` 追加条目(行47-54)、依赖解析(行56)、客户端半侧(行57) |
| `README.md` | 59-67 | 开发 | `vendor/codewiki`(行62)、`bin/cw.exe`(行63)、`client.js`(行64)、验证命令(行67) |
| `CodeWiki.md` | 5-7 | Overview | 编译不走子代理、大档/会话通道适配说明 |
| `CodeWiki.md` | 9-31 | Key Components | 描述 `index.js` 单文件逻辑(行11-24)、`client.js`(行26-29)、`cordis.patch.yml`(行30)、`package.json`(行31) |
| `CodeWiki.md` | 33-57 | Architecture | 阶段机框图与流程（行35-57） |
| `CodeWiki.md` | 59-61 | Data Flow | 配置流、凭证流、任务流、面板流 |
| `CodeWiki.md` | 63-65 | Connections | 指向 `[[codewiki-upstream]]`(行65) |
| `CodeWiki.md` | 68-75 | Known Issues | 不热加载、junction 重建、cw 限制等（行70-75） |
| `CHANGELOG.md` | 3-10 | 0.11.2 版本 | 大档思考档位在模型目录未声明时也可手动调节（面板降级为通用档位下拉） |
| `CHANGELOG.md` | 11-19 | 0.11.1 版本 | 修复大档任务思考档位回落错误导致整批失败（job-mvnxh0am-0 根因之一） |
| `CHANGELOG.md` | 21-32 | 0.11.0 版本 | 编译会话透明化（面板可看 LLM 会话内容，保留 24h）+ 并行项目推进 + 排队可见性；新增 `parallelProjects` 配置(行26)与会话记录端点 |
| `CHANGELOG.md` | 33-45 | 0.10.11 版本 | 编译收尾新增独立 commit 阶段——产物提交改走「主题分支 → 合并回原分支」 |
| `CHANGELOG.md` | 47-61 | 0.10.10 版本 | 两轴 code-review 修复、自动提交三态 `autoCommitState` 等 |
| `CHANGELOG.md` | 63-77 | 0.10.9 版本 | 编译产物自动提交 `autoCommit`、会话模型不再等待 |
| `CHANGELOG.md` | 79-91 | 0.10.8 版本 | hy3 192k 适配、大档单请求优先、批量校对 |
| `CHANGELOG.md` | 93-102 | 0.10.7 版本 | 删除规划阶段，提交后直接进 articles |
| `CHANGELOG.md` | 104-112 | 0.10.6 版本 | 面板显式非终态任务，修复串行闸门盲区 |
| `CHANGELOG.md` | 114-124 | 0.10.5 版本 | 修复 `codewiki_progress` 输出 schema 校验失败 |
| `CHANGELOG.md` | 126-152 | 0.10.4 版本 | 思考程度目录修复、新增大档模型四项 |
| `CHANGELOG.md` | 154-163 | 0.10.3 版本 | 单文件 110k–128k 误判修复 |
| `CHANGELOG.md` | 165-175 | 0.10.2 版本 | 大档装填上限 128k 修正 |
| `CHANGELOG.md` | 177-189 | 0.10.1 版本 | 删除内置百炼直连，仅走模型设置通道 |
| `CHANGELOG.md` | 191-204 | 0.10.0 版本 | 全面改用 hy3 主模型、单项目串行、思考程度从目录读 |
| `CHANGELOG.md` | 206-217 | 0.9.2 版本 | 自建 codewiki 档位在写 CodeWiki 时从未被调用修复 |
| `CHANGELOG.md` | 219-229 | 0.9.1 版本 | 设置页编译模型改为可选配置文件中的提供商与模型 |
| `CHANGELOG.md` | 231-243 | 0.9.0 版本 | 超 32k 文章转「会话通道」 |
| `CHANGELOG.md` | 245-697 | 历史版本 | 0.8.8 至 0.1.0 全部修复/功能/测试说明 |
| `.probe3.txt` | 1 | 探针标记 | 内容 `probe`，供内部检测与元信息记录 |

### 文档中记录的配置模型字段（对应 `Config` 结构，详见 `CodeWiki.md:12` 与 `README.md:56-67`）

以下字段在文档中被定义为插件 `Config` 的键值（schemastery 声明，全部 `.volatile()` 热读取）：

- `enabled`：开关，见于 `CodeWiki.md:12`。
- `binaryPath`：`cw` 可执行路径；留空优先 PATH（README.md:34，CodeWiki.md:12）。
- `maxConcurrency`：编译并发上限，默认 2，硬顶 8（README.md:35，CodeWiki.md:12）。
- `serialProjects`：单项目串行，默认 true（README.md:36，CodeWiki.md:12）。
- `articleLanguage`：文章语言，默认中文（README.md:37，CodeWiki.md:12）。
- `updateReminder`：系统提示注入提醒，默认开（README.md:38，CodeWiki.md:12）。
- `autoCommit`：编译产物自动提交，默认开（README.md:39，CodeWiki.md:12）。
- `batchProvider`：编译模型 provider，默认 `workbuddy`；0.10.1 起必须已注册，留空提交失败（README.md:29，CodeWiki.md:12）。
- `batchModel`：编译模型 id，默认 `hy3`（README.md:29，CodeWiki.md:12）。
- `batchReasoningEffort`：思考档位 id，从模型目录读取（README.md:30，CodeWiki.md:12）。
- `sessionTier`：仅超大输入兜底时钉死的子智能体档位 id（README.md:32，CodeWiki.md:12）。
- `bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`：大档模型四项，默认 `volces-ark`/`glm-5.3-flash`/空/420000（README.md:31，CodeWiki.md:12）。
- `parallelProjects`：并行项目数，默认 2，1–4（CHANGELOG.md:26 新增，0.11.0；`serialProjects=true` 时恒 1，关闭单项目串行后多仓库同时编译）。注：该字段在 `CodeWiki.md:12` 的 Config 描述中尚未同步列出，属文档失同步（见 Known Issues）。

### 探针文件组件

- `.probe3.txt:1` — 文件唯一内容为一行 `probe`，作为内部检测锚点与元信息存在证明，无结构化 schema。

## Architecture

文档模块与插件实现之间的元信息映射与内部检测关系如下：

```text
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ README.md    │  │ CodeWiki.md  │  │ CHANGELOG.md │
│ (行1-67)     │  │ (行1-75)     │  │ (行1-703)    │
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

1. **阅读与理解**：开发者/agent 读取 `README.md`(行 24-40) 与 `CodeWiki.md`(行 12) 获取配置模型字段定义与默认值。
2. **配置落地**：通过修改 `profiles/web/cordis.patch.yml`(`README.md:47-54`) 或插件设置页（`client.js`，`README.md:57`) 写入配置。
3. **热生效**：插件 `apply` 注入时 `liveConfig` 每次调用解包，配置 `volatile` 改完即生效（`README.md:40`）。
4. **演进追踪**：`CHANGELOG.md`(行 1-703) 按版本记录行为变更，如 0.10.1 删除内置直连、0.10.8 大档单请求优先、0.10.9 自动提交、0.10.10 三态语义、0.10.11 独立 commit 阶段、0.11.0 并行项目与会话记录、0.11.1 大档思考档位回落修复等。
5. **元信息检测**：`.probe3.txt`(行1) 提供探针标记，供外部脚本或内部检测确认模块存在性与仓库布局。
6. **交叉连接**：`CodeWiki.md` 通过 `[[codewiki-upstream]]`(行65) 关联上游 vendor 源码布局。

## Connections

- [[codewiki-upstream]] — `CodeWiki.md:65` 指向 `vendor/codewiki`（MIT）上游源码与布局约定，文档模块与之形成描述与被描述关系。
- 插件主逻辑（`index.js` / `client.js`）在 `CodeWiki.md:11-24` 与 `CodeWiki.md:26-29` 被细化描述，本文档模块为其对外说明面。
- 探针文件 `.probe3.txt` 与文档同源提交，构成 `docs-and-meta` 模块的内部检测基底。

## Known Issues

- **文档同步风险**：`CHANGELOG.md` 各版本记录代码与文档同步要求，但存在失同步：① `CodeWiki.md` 架构图(行42-43)阶段机未包含 0.10.11 新增的 `commit` 独立阶段（见 `CHANGELOG.md:33-45` 阶段顺序变为 queued→articles→crosscut→compose→review→index→commit→done）；② 0.11.0 新增 `parallelProjects` 配置与会话记录端点(`CHANGELOG.md:21-32`)，但 `CodeWiki.md:12` 的 Config 描述与 `README.md:39-55` 设置段均未提及；③ 0.11.0 会话透明化新增 `GET /api/codewiki/sessions` 端点，但 `CodeWiki.md:23` 的 webServer 端点列表仅列四个精确端点。未来改代码须同步 `README.md`/`CodeWiki.md`。
- **插件注册不热加载**：`CodeWiki.md:70`、`README.md:57` 明确指出改 `index.js` / `client.js` / profile patch 后需重启 dsh，仅配置值热读。
- **探针文件无 schema**：`.probe3.txt:1` 仅含 `probe` 字面量，无字段结构，依赖外部解析器约定，不保证扩展性。
- **上游 cw 限制**：`CodeWiki.md:72-73` 记录上游 `cw` 无 `--version`、stale 路径反斜杠等已知问题，文档已说明但底层未完全解决（仅插件层归一化）。
- **junction 依赖**：`CodeWiki.md:71` 指出 `@deepseek-ai/schemastery` 靠插件本地 junction，换机器需重建，文档已提示但非代码修复。
- **断点文件语义**：`CodeWiki.md:75-75` 记录未终态断点仅存阶段机位置，0.5.x 批量窗口语义已删；会话通道任务依赖发起会话可用，否则整体失败并明示原因（用户定案，不退超大兜底、不静默跳过校对）；会话通道任务超时默认 30 分钟（`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调），超时按失败处理、不降级。文章阶段与校对阶段共用 `job.sessionTasks`（按 stage 区分文案与 tally 的 replace 语义）；任务文件与 prompt 快照落在 `os.tmpdir()/dsh-codewiki-session-tasks/`，重启接管后重发 steer。
