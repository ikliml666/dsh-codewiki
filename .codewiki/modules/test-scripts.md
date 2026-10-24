---
title: test-scripts
type: module
source_files:
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
tags: [测试, 集成验证, 批量处理, 路径规范化, 锚点校验, 任务编排]
---

## Overview

`test-scripts` 模块是本仓库的端到端测试套件集合，由五个独立的 `.mjs` 脚本组成，覆盖编译执行链纯函数、宿主 llm 服务 mock、工作目录路径归一化、服务化编排阶段机、wiki 行号锚点校验以及入口文件生成等核心业务逻辑。

所有脚本均直接针对 `./index.js` 导出的插件主体（name 为 `dsh-codewiki`）进行集成与功能验证，通过临时文件系统（`fs.mkdtempSync`）构造边界场景（如超大文件、多批分割、Windows/MSYS 路径），并以轻量断言函数 `check` 落盘或抛错退出，确保重构与特性迭代不破坏既有契约。

## Key Components

### test-batch.mjs

编译执行链自检脚本，验证纯函数与 mock 宿主 llm 通道。

- `check(cond, msg)` — `16|`：断言辅助，成功计数 `passed` 并印 `✓`，失败压入 `failures` 印 `✗`。
- `section(name)` — `20|`：打印 `== name ==` 分隔段。
- `mockJson(obj, status)` — `21|`：构造类 `fetch` 响应对象，含 `ok`/`status`/`text()`。
- 测试块 `estimateTokens` — `24|`：CJK 与 ASCII 粗算（每字 1 token、ASCII `ceil(n/3.5)`）。
- 测试块 `collectSources` — `31|`：源码装填、缺失标注、token 预算溢出（`oversized`/`skipped`）。
- 测试块 `numberLines` — `47|`：行号前缀与尾换行处理（CRLF 剥离）。
- 测试块 `prepareArticleTasks` — `54|`：prompt 装配、旧文上下文、单文件大档（`bigTier`）、超大会话通道兜底、多文件观察批分割（`#obs` + `composePlan`）。
- 测试块 `classifySessionTask` — `134|`：会话通道收割三态（`timeout`/`harvest`/`wait`）。
- 测试块 `buildSessionSteerText` — `152|`：steer 文本档位钉死（`tier: "codeiwiki"`）与阶段文案。
- 测试块 `runRealtimeTasks` — `170|`：宿主 llm 通道请求体（provider/model/reasoningEffort/temperature）、混合池分派、取消信号、`failure` 记账。
- 测试块 `localPlan` — `278|`：顶层目录分组。
- 测试块 `packArticles` — `291|`：横切输入整篇装填与头部截断。
- 测试块 `scanRepoFiles` — `304|`：勘探黑名单（跳 `node_modules`/`.git`/二进制/超大/空）。
- 测试块 `listModelCatalog` — `341|`：宿主 provider/model 目录映射。
- 测试块 `installWebServer` — `365|`：`/api/codewiki/models` 端点回环 200/非回环 403。
- 测试块 `resolveModelEfforts` — `395|`：思考档位解析与 `/api/codewiki/model-efforts` 端点参数校验。
- 测试块 `fixAnchors` — `454|`：行号锚点确定性修正（错行修正、歧义不动、CRLF 保真）。
- 删除校验 — `451|`：`mod.resolveBatchApiKey === undefined` 确认 0.10.1 起移除内置百炼直连通道。

### test-cwd-paths.mjs

验证 0.2.3 路径修复：直接调 `cw` 工具覆盖三种 cwd 形态。

- `pluginDir` — `7|`：`fileURLToPath(import.meta.url)` 取插件目录。
- `repoWin` — `8|`：从 `process.argv[2]` 取 Windows 形式仓库路径（默认 `E:/ik/...`）。
- `msys` — `10|`：将 `E:/x` 推导为 `/e/x` 的 MSYS 形式。
- `registered` — `12|`：工具注册表捕获对象。
- `ctx` — `13|`：模拟宿主 `inject` 与 `effect`，将 `tools.register` 写入 `registered`。
- 验证块 — `22|`~`69|`：MSYS 路径归一化执行、Windows 路径 `status` 三态、不存在路径干净抛 `cwd 不存在`。

### test-orchestration.mjs

服务化编排冒烟测试，mock 宿主 llm 服务 + 真实 cw CLI + 真实服务 tick。

- `makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — `40|`：构造 cordis 风格 `inject`/`on`/`effect` 上下文，返回 `{ ctx, registered, endpoints, listeners, disposers }`。
- `makeMockAgent(cwd)` — `83|`：构造 `agent.ctx.inject` 以注册 `systemPrompt.section`。
- `makeFixtureRepo()` — `99|`：创建含 `core/`+`util/` 的 git 仓库 fixture。
- `makeBatchMock({ modules, articleMarker, stall, bigArticle })` — `130|`：按 prompt 首行特征分发应答的假 llm 流；返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`。
- `waitJob(cwd, { timeout })` — `197|`：轮询 `JOBS_FILE` 等某 cwd 最新 job 终态（`done`/`failed`/`cancelled`）。
- `fakeReq(body, addr, method)` — `212|`：模拟 HTTP 请求（回环地址 `127.0.0.1`）。
- `fakeRes()` — `222|`：模拟 HTTP 响应，捕获 `code` 与 `out`。
- 系统提示提醒块 — `227|`：验证 `agent/created` 监听与 `codewiki:update-reminder` section。
- `codewiki_update` 与 `commitHintText` 块 — `278|`：scope 强制 `auto`、提交引导 note、git 提交史提醒。
- `wakeCompileSession` 块 — `357|`：终态 steer 唤醒（done/failed 文案、冷会话静默）。
- 本地规划块 — `385|`：0.10.7 起无规划阶段，`localPlan` 顶层目录分组。
- 全量编译/大 wiki/大模块块 — `444|`~`539|`：阶段机 `articles→crosscut→review→index`、观察批 map + 合成批 reduce。
- 单项目串行块 — `542|`：已有项目在跑时新提交进 `queued`。
- 重启重跑块 — `684|`：0.6.0 宿主重启按持久化 prompt 快照重跑/迁移。
- 面板端点块 — `784|`：`/api/codewiki/jobs`、`/api/codewiki/control` 回环守卫与取消。
- 排除清单/knownRepos/工作区过滤块 — `838|`~`993|`：`excludePaths`、`workspaceOnly`、registry 异常降级。
- 孤儿接管块 — `1066|`：foreign 任务停更超时接管。
- 严格 cordis 语义块 — `1115|`：未 inject 服务属性访问即抛。

### test-wiki-anchors.mjs

wiki 文章行号锚点自动校验脚本，拦截幻觉锚点。

- `ROOT` / `WIKI` / `SOURCES` — `14|`~`24|`：定位仓库根、`.codewiki` 目录与待校验源文件（`index.js`/`client.js`）行缓存。
- `check(cond, msg)` — `28|`：断言并返回 `cond` 供短路。
- `symbolsOnLine(line)` — `38|`：提取行内反引号代码标识符（允许点分/调用形式，排除短符号）。
- `nearestSymbol(syms, anchorIndex, anchorLen)` — `52|`：取离锚点最近的符号（同距取左侧）。
- `walk(dir)` — `64|`：递归收集 `.md` 文章路径。
- 主校验循环 — `82|`~`115|`：基础行号范围、非空行、区间有序、单锚点符号绑定区间搜索。

### test-wiki-entry.mjs

`CodeWiki.md` 入口生成与 Windows 路径规范化单元测试。

- `check(cond, msg)` — `13|`：断言辅助。
- `repo(name)` — `19|`：在 tmp 下创建子仓库目录。
- `ensureWikiEntry` 测试 — `26|`~`54|`：缺失生成（含绝对路径/双语）、已有不覆盖、空 cwd 安全、幂等。
- `normalizeArticlePath` 测试 — `57|`：反斜杠转正斜杠、undefined 安全。
- `parseStatus` 测试 — `60|`：解析 `cw status` 输出，stale 清单 `\` 规范化。
- `normalizeIndexLinks` 测试 — `63|`：修复 `_index.md` 链接头反斜杠，正文反斜杠不受影响。

## Architecture

测试套件以 `./index.js` 插件为被测核心，通过轻量 mock 上下文驱动，按验证粒度分为纯函数单测、工具路径单测、服务编排冒烟、产物质量校验四类。

```text
┌─────────────────────────────┐
│ test-orchestration.mjs     │
│ (makeCtx/makeBatchMock)    │─apply(ctx)─► ./index.js (dsh-codewiki)
│ 服务阶段机/端点/重启恢复     │◄── steer & /api/* endpoints
└──────────────┬──────────────┘
               │ 共享 mock llm 注入模式
┌──────────────┴──────────────┐  ┌──────────────────────┐
│ test-batch.mjs              │  │ test-cwd-paths.mjs   │
│ 纯函数+端点单测              │  │ cw 工具路径归一化     │
└──────────────┬──────────────┘  └──────────────────────┘
               │ 依赖 index.js 导出函数
┌──────────────┴──────────────┐  ┌──────────────────────┐
│ test-wiki-anchors.mjs       │  │ test-wiki-entry.mjs  │
│ 锚点符号绑定校验             │  │ 入口生成/路径规范     │
└─────────────────────────────┘  └──────────────────────┘
```

## Data Flow

1. 脚本启动即通过 `import { ... } from './index.js'`（`test-batch.mjs` `7|`）或 `await import('./index.js')`（`test-orchestration.mjs` `20|`）加载插件主体。
2. 利用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))` 构造临时仓库（如 `test-batch.mjs` `32|` `tmpRoot`），写入源码、超大文件（`'x'.repeat(420*1024)`）模拟 token 预算边界。
3. `test-orchestration.mjs` 调用 `makeCtx`（`40|`）注入模拟 `webServer`/`agents`/`tools`/`llm` 切片，执行 `apply(ctx, cfg)` 注册 `cw` 与 `codewiki_generate` 等工具。
4. 触发 `gen.execute({ cwd, scope }, { agent })`（`test-orchestration.mjs` `448|`），插件异步推进阶段机；测试侧通过 `waitJob`（`197|`）轮询 `DSH_CODEWIKI_JOBS_FILE` 获取终态。
5. `test-batch.mjs` 与 `test-wiki-*` 则直接调用纯函数，用 `check()` 比对返回值、落盘文件内容（如 `fs.readFileSync(path.join(outDir, 'b0.md'), 'utf8')` `204|`）及 `notes` 数组。

## Connections

- [[dsh-codewiki]]：所有脚本验证的插件主体（导出自 `./index.js`，`name === 'dsh-codewiki'`）。
- [[wiki-anchors]]：`fixAnchors`（`test-batch.mjs` `454|`）与 `test-wiki-anchors.mjs` 符号绑定逻辑互验。
- [[cw-cli]]：`cw.execute` 路径与 `status` 三态在 `test-cwd-paths.mjs` `34|` 与 `test-orchestration.mjs` `273|` 覆盖。

## Known Issues

- `test-cwd-paths.mjs` `28|` 注释明确：捆绑副本一致性校验交由外部 sha256 完成，测试内不再重复验证 `resolveBinary` 内部细节，仅通过 MSYS 路径跑通间接证明归一化生效。
- `test-orchestration.mjs` `779|`：并发块清理使用 `fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`，注释指出 Windows 句柄延迟释放可能导致异常，留待 tmp 自清。
- `test-batch.mjs` `451|`：断言 `mod.resolveBatchApiKey === undefined`，标记 0.10.1 起内置百炼直连通道与凭证解析链整体删除，插件不再触碰任何密钥。
- `test-cwd-paths.mjs` `59|`：注释声明 `wikiPathFor` 兜底路径未直接导出，契约由 `cw path` 成功路径覆盖。