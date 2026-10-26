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

所有脚本均直接针对 `./index.js` 导出的插件主体（name 为 `dsh-codewiki`，见 `test-orchestration.mjs` 行279）进行集成与功能验证，通过临时文件系统（`fs.mkdtempSync`）构造边界场景（如超大文件、多批分割、Windows/MSYS 路径），并以轻量断言函数 `check` 落盘或抛错退出，确保重构与特性迭代不破坏既有契约。当前代码已涵盖 0.10.x 至 1.2.0 系列特性：大档模型接管超长输入（见 `test-batch.mjs` 行107-131）、插件自动提交编译产物（见 `test-orchestration.mjs` 行412-513）、会话通道 steer 档位钉死（行151-167）、并行项目上限（行791-820）、孤儿任务接管（行1307-1339）、worktree 闸门（行1341-1412）、空壳目录闸门（行1414-1463）等。

## Key Components

### test-batch.mjs

编译执行链自检脚本，验证纯函数与 mock 宿主 llm 通道。

- `import { ... } from './index.js'` — 行7-12：导入被测函数（collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer）。
- `let passed` / `const failures` / `function check(cond, msg)` — 行14-19：断言辅助（成功计数 `passed` 印 `✓`，失败压入 `failures` 印 `✗`）。
- `function section(name)` — 行20：分段打印 `== name ==`。
- `const mockJson = (obj, status = 200) => ...` — 行21：构造类 fetch 响应对象（含 `ok`/`status`/`text()`）。
- 测试块 `estimateTokens` — 行23-28：CJK 与 ASCII 粗算（每字 1 token、ASCII `ceil(n/3.5)`）。
- 测试块 `collectSources` — 行30-44：源码装填、缺失标注、token 预算溢出（`oversized`/`skipped`）、尾换行处理。
- 测试块 `numberLines` — 行46-51：行号前缀与尾换行处理（CRLF 剥离、双尾换行保留空行）。
- 测试块 `prepareArticleTasks` — 行53-105：prompt 装配、旧文上下文、单文件大档（`bigTier`）、超大会话通道兜底、多文件观察批分割（`#obs` + `composePlan`）。
- 测试块 `prepareArticleTasks` 大档模型接管 — 行107-131：超长输入改用 `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigBudget` 大档单请求（不再交会话模型）。
- 测试块 `classifySessionTask` — 行133-149：会话通道收割三态（`timeout`/`harvest`/`wait`）。
- 测试块 `buildSessionSteerText` — 行151-167：steer 文本档位钉死（`tier: "codeiwiki"`）与阶段文案（articles/review/resend）。
- `function makeLlm(reply)` / `const promptOf` — 行173-189：构造假 llm 服务（按 stream 协议吐块；reply 可为字符串、函数或 Error）；从 `opts.messages[0].content[0].text` 提取 prompt。
- 测试块 `runRealtimeTasks` 宿主通道 — 行169-205：含上述 `makeLlm`/`promptOf`、`kmTasks`（行190-193）与 `runRealtimeTasks` 调用（行195-205），验证请求体（provider/model/reasoningEffort/temperature）与落盘。
- 测试块 `runRealtimeTasks` 混合池大档分派 — 行207-227：同一池里大档任务按自带 provider/model/档位路由。
- 测试块 `runRealtimeTasks` 大档与默认档并发分池 — 行229-296：分池限流（0.12.2），`makeSlowLlm`（行232-242）延时吐块、`poolProbe`（行243-258）统计在飞峰值、`mk`（行259-262）构造任务；默认档并发打满 2 且大档独立限 1 两池并行（行263-282），`bigConcurrency` 缺省跟随默认档（行283-296）。
- 测试块 `runRealtimeTasks` tps 采样与取消信号 — 行298-308：onTaskDone 上报与未配置思考档位不下发。
- 测试块 `runRealtimeTasks` 外部 signal 中止 — 行310-320：已 abort 的 signal 使池不消费任务。
- 测试块 `runRealtimeTasks` 并发池失败记账 — 行322-344：失败记账进 notes，不中断其他任务。
- 测试块 `localPlan` — 行346-358：顶层目录分组。
- 测试块 `packArticles` — 行359-371：横切输入整篇装填与头部截断。
- 测试块 `scanRepoFiles` — 行372-387：勘探黑名单（跳 node_modules/.git/二进制/超大/空）。
- 测试块 `runRealtimeTasks` 失败通道错误码透传 — 行392-407：finish kind=error 记账含错误码。
- 测试块 `listModelCatalog` — 行409-431：宿主 provider/model 目录映射（兼容 provider/name 写法，跳过无 id）。
- 测试块 `GET /api/codewiki/models 端点` — 行433-461：`installWebServer` 注册端点，回环 200/非回环 403。
- 测试块 `resolveModelEfforts` 与 `/api/codewiki/model-efforts` — 行463-515：思考档位解析与端点参数校验（回环 200/缺参 400/非回环 403）。
- 删除校验 — 行517-520：`mod.resolveBatchApiKey === undefined` 确认 0.10.1 起移除内置百炼直连通道。
- 测试块 `fixAnchors` — 行522-564：行号锚点确定性修正（错行修正、歧义不动、CRLF 保真）。

### test-cwd-paths.mjs

验证 0.2.3 路径修复：直接调 `cw` 工具覆盖三种 cwd 形态。

- `import * as plugin from './index.js'` — 行1-5：加载插件与 path/fileURLToPath。
- `const pluginDir` — 行7：`fileURLToPath(import.meta.url)` 取插件目录。
- `const repoWin` — 行8：从 `process.argv[2]` 取 Windows 形式仓库路径（默认 `E:/ik/...`）。
- `const msys` — 行9-10：将 `E:/x` 推导为 `/e/x` 的 MSYS 形式。
- `const registered` / `const ctx` — 行12-18：模拟宿主 `inject` 与 `effect`，将 `tools.register` 写入 `registered`。
- `await plugin.apply(ctx, {})` — 行20：注册插件。
- `const cw = registered.cw` — 行22-23：从 registered 取 `cw` 工具，缺失则退出。
- `const cfgProbe` — 行26：测试用配置（enabled/batchProvider 等，仅注释说明未直接用 resolveBinary）。
- 验证块 MSYS 路径 — 行30-45：调用 `cw.execute({ cwd: msys, args: ['path'] })` 归一化执行并断言返回 `.codewiki`。
- 验证块 Windows 路径 `status` 三态 — 行47-57：调用 `cw.execute({ cwd: repoWin, args: ['status'] })` 验证非 "No wiki found"。
- 验证块 不存在路径干净报错 — 行61-69：调用 `cw.execute` 不存在路径，断言抛出 `cwd 不存在`。

### test-orchestration.mjs

服务化编排冒烟测试，mock 宿主 llm 服务 + 真实 cw CLI + 真实服务 tick。

- `process.env.DSH_CODEWIKI_TICK_MS` / `DSH_CODEWIKI_JOBS_FILE` — 行14-23：测试加速 tick 间隔与独立 JOBS_FILE（追加随机 token 避免复用）。
- `const { name, apply, SESSIONS_DIR } = await import('./index.js')` — 行24：加载插件主体。
- `let failures` / `function check` — 行26-30：断言辅助。
- `const JOBS_FILE` / `articleMd` — 行32-34：任务文件路径与构造文章 markdown 的辅助函数。
- `const LEGACY_CHANNEL` / `const batchCfg` — 行44-45：测试配置基线（行44 关掉三档新通道：`planMode: 'dirs', agenticArticles: false, symbolIncremental: false`；行45 `batchProvider: 'workbuddy', batchModel: 'hy3'` 合并）。
- `function makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — 行51-91：构造 cordis 风格 `inject`/`on`/`effect` 上下文，返回 `{ ctx, registered, endpoints, listeners, disposers }`；支持 `workspaceRegistry` 与 `brokenRegistry` 形态。
- `function makeMockAgent(cwd)` — 行94-108：构造 `agent.ctx.inject` 以注册 `systemPrompt.section`。
- `function makeFixtureRepo()` — 行110-127：创建含 `core/`+`util/` 的 git 仓库 fixture（自带 git identity）。
- `let activeLlm` / `const llmProxy` / `const promptOf` — 行132-141：当前生效假 llm 与转发代理，提取 prompt。
- `function makeBatchMock({ modules, articleMarker, stall, bigArticle })` — 行145-209：按 prompt 首行特征分发应答的假 llm 流；返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`。
- `async function waitJob(cwd, { timeout })` — 行212-225：轮询 `JOBS_FILE` 等某 cwd 最新 job 终态。
- `function fakeReq(body, addr, method)` / `function fakeRes()` — 行227-239：模拟 HTTP 请求（回环地址 `127.0.0.1`）与响应（捕获 `code` 与 `out`）。
- 系统提示提醒块 — 行242-270：验证 `agent/created` 监听与 `codewiki:update-reminder` section。
- 注册与 cw 工具块 — 行272-290：apply 注册，断言 `cw`/`codewiki_generate`/`codewiki_progress` 存在，cw status 判定 missing。
- `codewiki_update` 与 `commitHintText` 块 — 行292-410：scope 强制 `auto`、提交引导 note、git 提交史提醒（含 autoCommit 状态分支）。
- `autoCommitWiki` 块 — 行412-513：安全边界（主题分支提交→合并回原分支，只提交 `.codewiki/` 与 `CodeWiki.md`；非 git/忽略/merge/detached/预占分支降级）。
- `autoCommitState` 块 — 行515-525：三态判定（committed/no-changes/pending）。
- `wakeCompileSession` 块 — 行527-563：终态 steer 唤醒（done/failed 文案、冷会话静默）。
- 本地规划块 — 行565-622：0.10.7 起无规划阶段，`localPlan` 顶层目录分组。
- 全量编译块 — 行624-665：阶段机 `articles→crosscut→review→index`、自动提交校验。
- 大 wiki 横切拆分块 — 行667-695：观察任务 map + 合成批 reduce。
- 大模块文章分割块 — 行697-731：文章阶段观察批 map + 合成请求 reduce。
- 单项目串行块 — 行733-789：已有项目在跑时新提交进 `queued`，`queueAhead` 在等谁。
- 并行项目上限块 — 行791-820：关闭单项目串行后多仓库同时推进（`serialProjects: false, parallelProjects: 3`）。
- 唯一通道块 — 行822-854：全程走宿主 llm 服务（零直连）。
- stale 逐篇更新块 — 行856-877：`scope: 'stale'` 直达 articles。
- `codewiki_progress` 块 — 行879-915：只读查进度、百分比与明细。
- 0.6.0 重启重跑块 — 行916-973：按持久化 prompt 快照重跑/迁移（旧 plan 任务迁移到 articles）。
- 并发提交占位块 — 行975-1023：首个 tick 窗口共享 job 与 flush 合并。
- 面板端点与取消块 — 行1025-1077：`/api/codewiki/jobs`、`/api/codewiki/control` 回环守卫与取消。
- 排除清单/repos 总览/compile 动作块 — 行1079-1132：excludePaths 拒绝与 repos 总览。
- knownRepos 登记/refresh 块 — 行1134-1172：knownRepos 独立于 job 历史、refresh 动作。
- 工作区任务过滤块 — 行1174-1235：jobs/repos 按 workspaceOnly 过滤（含 registry 异常降级）。
- registry 异常防御块 — 行1237-1265：workspaceRegistry.list() 抛错时降级不过滤。
- 工具输出 schema 块 — 行1267-1305：codewiki_generate 输出过 schema 校验。
- 孤儿任务接管块 — 行1307-1339：foreign 任务停更超时接管。
- 会话全局 Tab + worktree 闸门块 — 行1341-1412：sessions 端点聚合接口、worktree 目录提交报错与 auto 调度跳过。
- 空壳目录闸门块 — 行1414-1463：扫不出源码的空壳目录手动提交报错、auto 调度静默跳过，且面板 jobs/repos 过滤掉此类终态任务。
- 编译模型缺失诚实报错块 — 行1465-1478：provider 留空诚实报错并落 job failed 态。
- 严格 cordis 语义块 — 行1480-1502：未 inject 服务属性访问即抛，apply 不回滚。
- Temp 残留清理块 — 行1504-1521：Temp 目录终态任务自动移除，活动/工作区任务保留。

### test-wiki-anchors.mjs

wiki 文章行号锚点自动校验脚本，拦截幻觉锚点。

- `const ROOT` / `const WIKI` / `const SOURCES` — 行14-24：定位仓库根、`.codewiki` 目录与待校验源文件（`index.js`/`client.js`）行缓存，结构为 `{ lines: null, total: 0 }`。
- `let passed` / `let failures` / `function check(cond, msg)` — 行26-32：断言并返回 `cond` 供短路。
- `function symbolsOnLine(line)` — 行38-49：提取行内反引号代码标识符（允许点分/调用形式，排除短符号），返回 `{ sym, at }` 数组。
- `function nearestSymbol(syms, anchorIndex, anchorLen)` — 行52-62：取离锚点最近的符号（同距取左侧），返回 `{ ...s, d, left }`。
- `function walk(dir)` — 行64-73：递归收集 `.md` 文章路径。
- 主校验循环 — 行75-115：基础行号范围、非空行、区间有序、单锚点符号绑定区间搜索；调用 `check` 落断言。

### test-wiki-entry.mjs

`CodeWiki.md` 入口生成与 Windows 路径规范化单元测试。

- `let failures` / `function check(cond, msg)` — 行12-16：断言辅助。
- `const tmp` / `const repo(name)` — 行18-23：临时目录与子仓库创建。
- `ensureWikiEntry` 测试 — 行25-54：缺失生成（含绝对路径/双语）、已有不覆盖、空 cwd 安全、幂等。
- `normalizeArticlePath` 测试 — 行56-59：反斜杠转正斜杠、undefined 安全。
- `parseStatus` 测试 — 行60-62：解析 `cw status` 输出（返回 `{ state, changedFiles, staleArticles }`），stale 清单 `\` 规范化。
- `normalizeIndexLinks` 测试 — 行63-72：修复 `_index.md` 链接头反斜杠，正文反斜杠不受影响。

## Architecture

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

1. 脚本启动即通过 `import { ... } from './index.js'`（`test-batch.mjs` 行7-12）或 `await import('./index.js')`（`test-orchestration.mjs` 行24）加载插件主体。
2. 利用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))` 构造临时仓库（如 `test-batch.mjs` 行32-34 `tmpRoot` 与行55 `workRoot`，`test-orchestration.mjs` 行110-127 `makeFixtureRepo`），写入源码、超大文件（`'x'.repeat(420*1024)` 见 `test-batch.mjs` 行57）模拟 token 预算边界。
3. `test-orchestration.mjs` 调用 `makeCtx`（行51-91）注入模拟 `webServer`/`agents`/`tools`/`llm` 切片，执行 `apply(ctx, cfg)`（如行278）注册 `cw` 与 `codewiki_generate` 等工具。
4. 触发 `gen.execute({ cwd, scope }, { agent })`（`test-orchestration.mjs` 行629 等，另见行582、行673、行712），插件异步推进阶段机；测试侧通过 `waitJob`（行212-225）轮询 `DSH_CODEWIKI_JOBS_FILE` 获取终态。
5. `test-batch.mjs` 与 `test-wiki-*` 则直接调用纯函数，用 `check()` 比对返回值、落盘文件内容（如 `fs.readFileSync(path.join(outDir, 'b0.md'), 'utf8')` `test-batch.mjs` 行204）及 `notes` 数组。

## Connections

- [[dsh-codewiki]]：所有脚本验证的插件主体（导出自 `./index.js`，`name === 'dsh-codewiki'` 见 `test-orchestration.mjs` 行279）。
- [[wiki-anchors]]：`fixAnchors`（`test-batch.mjs` 行522-564）与 `test-wiki-anchors.mjs` 符号绑定逻辑互验。
- [[cw-cli]]：`cw.execute` 路径（`test-cwd-paths.mjs` 行34）与 `status` 三态（`test-cwd-paths.mjs` 行48 及 `test-orchestration.mjs` 行288-289）覆盖。
- [[codewiki-generate]]：`codewiki_generate` 工具注册与提交占位逻辑在 `test-orchestration.mjs` 行280 等覆盖。

## Known Issues

- `test-cwd-paths.mjs` 行25-28：注释明确：捆绑副本一致性校验交由外部 sha256 完成，测试内不再重复验证 `resolveBinary` 内部细节，仅通过 MSYS 路径跑通间接证明归一化生效。
- `test-cwd-paths.mjs` 行59：注释声明 `wikiPathFor` 兜底路径未直接导出，契约由 `cw path` 成功路径覆盖。
- `test-orchestration.mjs` 行1021：并发块清理使用 `fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`，注释指出 Windows 句柄延迟释放可能导致异常，留待 tmp 自清。
- `test-batch.mjs` 行517-520：断言 `mod.resolveBatchApiKey === undefined`，标记 0.10.1 起内置百炼直连通道与凭证解析链整体删除，插件不再触碰任何密钥。
- `test-orchestration.mjs` 行515-525：`autoCommitState` 三态判定与 `wakeCompileSession` 块（行527-563）依赖 `autoCommit` 字段存在，自动提交成功则零唤醒，失败才降级提醒。
- `test-orchestration.mjs` 行1341-1412：会话全局 Tab 聚合接口与 worktree 闸门测试中，worktree 目录提交报错文案要求说明「等合并回主仓库后再编译」，主工作区对照不受影响。
- `test-orchestration.mjs` 行44：`LEGACY_CHANNEL` 显式关掉三档新通道（语义规划/agentic 写作/符号级增量），以守护旧通道断言；新通道验证见其他专用测试文件（未在本文覆盖）。
