---
title: _patterns
type: pattern
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags:
  - 模式
  - 命名约定
  - 错误处理
  - 测试流程
  - 目录约定
  - 配置热生效
  - 锚点引用
---

## Overview

本仓库围绕 `@local/dsh-codewiki` 插件形成了一系列一致的工程实践，涵盖命名约定、错误处理风格、构建与测试流程、目录布局、配置热加载与文档锚点等方面。基于 `README.md`、`CodeWiki.md`、`CHANGELOG.md`、`test-*.mjs`、`index.js`、`client.js` 等源文件证据，以下总结反复出现的模式，每一模式均引用具体文件与函数/常量名作为出处。

## Patterns

### 命名约定模式

- 常量使用全大写蛇形命名：在 `index.js` 中，`CONCURRENCY_HARD_CAP`、`DEFAULT_CONCURRENCY`、`BATCH_TOKEN_BUDGET`、`JOBS_FILE` 等均遵循此风格。
- 函数与变量使用小驼峰：如 `index.js` 的 `normalizeCwd`、`resolveBinary`、`runCw`、`estimateTokens`；`client.js` 的 `apiGet` (389|)、`apiPost` (395|)。
- 测试辅助函数统一命名：各测试脚本均定义 `check(cond, msg)`（`test-batch.mjs` 16|、`test-wiki-anchors.mjs` 28|、`test-wiki-entry.mjs` 13|）与 `section`（`test-batch.mjs` 20|）。
- 配置字段小驼峰且按模型角色加前缀：`Config` schema（`index.js`）中 `batchProvider`、`batchModel`、`bigProvider`、`bigModel`、`sessionTier` 等体现出 `batch*`/`big*` 分组。
- 文档与元信息文件沿用大写首字母 Markdown：`README.md`、`CodeWiki.md`、`CHANGELOG.md`。

### 错误处理与失败记账风格

- 断言收集而非立即中断：测试脚本中 `check` 函数成功计数 `passed` 并印 `✓`，失败压入 `failures` 印 `✗`，结尾汇总（如 `test-batch.mjs` 16| 定义的 `check`，以及 `.tmp-test-batch.log` 85| `ALL PASS：59 通过，0 失败`）。
- 外部命令与路径错误干净抛出：`test-cwd-paths.mjs` 验证块 (22|~69|) 确认 Windows 路径三态及不存在路径干净抛 `cwd 不存在`；`index.js` 的 `runCw` 带超时/中止收集 stdout/stderr。
- 任务失败记账与落盘：`index.js` 的 `applyTaskResult` 将结果落盘或回内存，`runRealtimeTasks` 并发池执行中标记 `failure` 记账（见 `test-batch.mjs` 170| 测试块描述）。
- 并发安全与锁防护：`index.js` 使用 `JOBS_LOCK_FILE` 与 `instanceId` 防双提交，崩溃残留锁 60s 过期强删（见 Known Issues）。
- 兜底失败直接置败：会话通道兜底若超预算且 `bigProvider` 留空直接 `fail`（`dispatchSessionTasks`）。
- 锚点错误自动校正：`index.js` 的 `fixAnchors` 作为第四层兜底确定性校正 `file:NN` 引用；`test-wiki-anchors.mjs` 的 `symbolsOnLine` (38|) 与 `nearestSymbol` (52|) 用于校验绑定，失败记录在测试日志供排查。

### 构建与测试流程模式

- 被测核心统一为 `./index.js` 插件主体：测试脚本通过 `import { ... } from './index.js'` (`test-batch.mjs` 7|) 或 `await import('./index.js')` (`test-orchestration.mjs` 20|) 加载，验证 `name === 'dsh-codewiki'`。
- 临时文件系统构造边界场景：利用 `fs.mkdtempSync` 创建 fixture 仓库，如 `test-batch.mjs` 32| `tmpRoot`、`test-orchestration.mjs` 的 `makeFixtureRepo` (99|)，写入超大文件模拟 token 预算。
- Mock 宿主上下文驱动：`test-orchestration.mjs` 的 `makeCtx` (40|) 构造 cordis 风格 `inject`/`on`/`effect`，`makeBatchMock` (130|) 按 prompt 分发假 llm 流。
- 轮询终态：`waitJob` (197|) 轮询 `JOBS_FILE` 等 job 达 `done`/`failed`/`cancelled`；对应 `index.js` 的 `TICK_MS` 节拍推进。
- 日志产物落盘：测试运行写入 `.tmp-test-*.log`（如 `.tmp-test-batch.log` 2| 分组起始），watcher 进程追加日志记录 job 阶段；CI/开发者读日志排查。
- 开发验证指令：`README.md` 58-66 提及 `vendor/codewiki`、`bin/cw.exe`、`client.js` 及验证命令。

### 目录与仓库布局约定

- 核心代码与配置共置根目录：`index.js`、`client.js`、`cordis.patch.yml`、`package.json`、`.gitignore` 共处于插件根。
- 捆绑二进制与上游源码分离：捆绑 `bin/cw` 由 `resolveBinary` 解析，上游 `vendor/codewiki` 在 `.gitignore` 2| 忽略 `vendor/codewiki/target/`。
- 生成 Wiki 目录约定：默认 `<repo>/.codewiki` 存放文章，`wikiPathFor` 返回该路径；`test-wiki-anchors.mjs` 的 `WIKI` (14|~24|) 定位此目录校验。
- 测试与临时日志平铺根目录：`test-*.mjs` 与 `.tmp-test-*.log`、`watcher2.log`、`.probe3.txt` 均位于仓库根。
- 模块文档归入 `modules/`：本仓库 CodeWiki 横切模块文章存放于 `modules/*.md`，而源文件描述对象在根（如 `README.md`）；插件自身入口 `CodeWiki.md` 在根。

### 配置热生效与 Schema 声明模式

- 全部配置项 `.volatile()` 热读取：`index.js` 的 `Config` 所有字段 `.volatile()`；`README.md` 39| 说明改完即生效；`CodeWiki.md` 12| 记录 `enabled` 等字段。
- 运行期扁平规范化：`liveConfig` 每次调用解包并钳制并发、兜底大档预算。
- 默认值常量集中：如 `DEFAULT_BATCH_PROVIDER`、`DEFAULT_BIG_MODEL`、`DEFAULT_BIG_TOKEN_BUDGET` 等。
- 配置挂载通过 cordis 补丁：`cordis.patch.yml` 13| `- insert:` 以 `id: codewiki` 挂载 `index.js`；`package.json` 20| `dsh.bundle.patch` 指向同文件。

### 行号锚点与文档引用约定

- 文档普遍使用 `文件:行号` 锚点：`CodeWiki.md` 56| 使用 `[[codewiki-upstream]]` 交叉连接。
- 代码自动修正锚点：`index.js` 的 `fixAnchors` 对照源码确定性校正 `file:NN`；`normalizeArticlePath` 规范路径反斜杠。
- 测试守护锚点真实性：`test-wiki-anchors.mjs` 主循环 (82|~115|) 校验符号绑定。
- 入口生成双语：`ensureWikiEntry` 缺失 `CodeWiki.md` 时生成中/英版，测试 `test-wiki-entry.mjs` 26|~54| 验证。