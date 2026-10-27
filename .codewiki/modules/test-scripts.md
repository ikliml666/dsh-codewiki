---
title: test-scripts
type: module
source_files:
  - test-agentic.mjs
  - test-agentic-fallback.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
  - test-batch.mjs
  - test-cluster.mjs
  - test-cwd-paths.mjs
  - test-graphdiff.mjs
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-semantic-plan.mjs
  - test-sessions.mjs
  - test-symbols.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
tags: [测试, 集成验证, 批量处理, 路径规范化, 锚点校验, 任务编排, agentic写作, 语义规划, 增量编译, 符号提取]
---

## Overview

`test-scripts` 模块是本仓库的端到端/单元测试套件集合，由 18 个独立的 `.mjs` 脚本组成（旧版文章只覆盖其中 5 个）。它们按被测对象分成几类：

- **编译链纯函数 + 端点单测**：`test-batch.mjs`、`test-wiki-anchors.mjs`、`test-wiki-entry.mjs`、`test-cwd-paths.mjs`。
- **服务化编排冒烟**：`test-orchestration.mjs`（mock 宿主 llm + 真实 `cw` CLI + 真实服务 tick）。
- **agentic 写作通道**：`test-agentic.mjs`（lib/agentic.js 工具环与循环）、`test-agentic-host.mjs`（宿主消息适配层）、`test-agentic-fallback.mjs`（退回旧通道判定）、`test-articles-agentic.mjs`（agentic 执行器与子模块递归派发）。
- **语义规划/聚类**：`test-semantic-plan.mjs`（AST→聚类→模块清单端到端）、`test-cluster.mjs`（lib/cluster.js 三段式聚类）。
- **符号级增量**：`test-incremental.mjs`、`test-incremental-e2e.mjs`、`test-symbols.mjs`、`test-graphdiff.mjs`。
- **路径/闸门治理**：`test-worktree.mjs`、`test-prune-orphans.mjs`。
- **会话记录存储**：`test-sessions.mjs`。

所有脚本或直接 `import { ... } from './index.js'` 调用纯函数/端点，或用 `makeCtx` 注入 mock 的 `webServer`/`agents`/`tools`/`llm` 切片后 `apply(ctx, cfg)` 注册工具再触发。临时文件系统（`fs.mkdtempSync`）用于构造边界场景（超大文件、`'x'.repeat(420*1024)`、`'x'.repeat(800*1024)`、Windows/MSYS 路径、linked worktree），并以轻量断言（`check`/`assert`）落盘或退出，确保重构与特性迭代不破坏既有契约。当前代码覆盖 0.2.3 至 1.2.0 系列特性：大档模型接管超长输入（见 `test-batch.mjs` 行108-132）、插件自动提交编译产物（见 `test-orchestration.mjs` 行412-513）、会话通道 steer 档位钉死（见 `test-batch.mjs` 行152-168）、并行项目上限（见 `test-orchestration.mjs` 行791-820）、孤儿任务接管（见 `test-orchestration.mjs` 行1307-1339）、worktree 闸门（见 `test-orchestration.mjs` 行1341-1412）、空壳目录闸门（见 `test-orchestration.mjs` 行1414-1463）、agentic 子模块递归（见 `test-articles-agentic.mjs` 行66-124）、符号级增量判定（见 `test-incremental.mjs` 行49-158）。

## Key Components

### test-batch.mjs

编译执行链自检：纯函数（源码装填/token 估算/任务装配/本地规划/横切装填/仓库勘探/会话通道收割/锚点修正/信封校验）+ mock 宿主 llm 服务（并发池/取消/失败记账/思考档位下发/大档分池）。跑法：`node test-batch.mjs`（Node ≥20）。

- `import { ... } from './index.js'` — 行7-13：导入被测函数（collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer, validateArticleEnvelope）。
- `let passed` / `const failures` / `function check(cond, msg)` — 行15-21：断言辅助（成功计数 `passed` 印 `✓`，失败压入 `failures` 印 `✗`）。
- `function section(name)` — 行21：分段打印 `== name ==`。
- `const mockJson` — 行22：构造类 fetch 响应对象（含 `ok`/`status`/`text()`）。
- 测试块 `estimateTokens` — 行24-29：CJK 与 ASCII 粗算（每字 1 token、ASCII `ceil(n/3.5)`）。
- 测试块 `collectSources` — 行31-45：源码装填、缺失标注、token 预算溢出（`oversized`/`skipped`）、尾换行处理。
- 测试块 `numberLines` — 行47-52：行号前缀与尾换行处理（CRLF 剥离、双尾换行保留空行）。
- 测试块 `prepareArticleTasks` 单文件大档/超档 — 行54-85：prompt 装配、旧文上下文、单文件超 110k 预算装进 128k 大档（不转会话通道）、连 128k 都装不下转会话通道。
- 测试块 `prepareArticleTasks` 多文件超预算 → 观察批分割 — 行87-106：`#obs` 观察任务（`keepInMemory`、`splitFor`、`composePlan`）。
- 测试块 `prepareArticleTasks` 大档模型接管 — 行108-132：超 128k 改用 `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigBudget` 大档单请求（不再交会话模型），关掉大档退回会话通道。
- 测试块 `classifySessionTask` — 行134-149：会话通道收割三态（`timeout`/`harvest`/`wait`）。
- 测试块 `buildSessionSteerText` — 行152-168：steer 文本档位钉死（`tier: "codeiwiki"`）与阶段文案（articles/review/resend）。
- 测试块 `runRealtimeTasks` 宿主通道 — 行170-207：`makeLlm`（行174-189，`promptOf` 行190）、`kmTasks`（行191-193）与调用（行196-205），验证请求体（provider/model/reasoningEffort/temperature）与落盘。
- 测试块 `runRealtimeTasks` 混合池大档分派 — 行209-228：同一池里大档任务按自带 provider/model/档位路由。
- 测试块 `runRealtimeTasks` 大档与默认档并发分池 — 行230-297：`makeSlowLlm`（行233-242）延时吐块、`poolProbe`（行244-258）统计在飞峰值、`mk`（行260-262）构造任务；默认档并发打满 2 且大档独立限 1 两池并行（行263-283），`bigConcurrency` 缺省跟随默认档（行284-296）。
- 测试块 `runRealtimeTasks` tps 采样与取消信号 — 行299-309：onTaskDone 上报与未配置思考档位不下发。
- 测试块 `runRealtimeTasks` 外部 signal 中止 — 行311-320：已 abort 的 signal 使池不消费任务。
- 测试块 `runRealtimeTasks` 并发池失败记账 — 行323-345：失败记账进 notes，不中断其他任务。
- 测试块 `localPlan` — 行347-358：顶层目录分组。
- 测试块 `packArticles` — 行360-371：横切输入整篇装填与头部截断。
- 测试块 `scanRepoFiles` — 行373-387：勘探黑名单（跳 node_modules/.git/二进制/超大/空）。
- 测试块 `runRealtimeTasks` 失败通道错误码透传 — 行393-408：finish kind=error 记账含错误码。
- 测试块 `listModelCatalog` — 行410-432：宿主 provider/model 目录映射（兼容 provider/name 写法，跳过无 id）。
- 测试块 `GET /api/codewiki/models 端点` — 行434-462：`installWebServer` 注册端点，回环 200/非回环 403。
- 测试块 `resolveModelEfforts` 与 `/api/codewiki/model-efforts` — 行464-516：思考档位解析与端点参数校验（回环 200/缺参 400/非回环 403）。
- 删除校验 — 行518-521：`mod.resolveBatchApiKey === undefined` 确认 0.10.1 起移除内置百炼直连通道。
- 测试块 `fixAnchors` — 行523-603：行号锚点确定性修正（错行修正、歧义不动、CRLF 保真、多锚点行各自就近绑定、倒序区间翻正）。
- 测试块 `validateArticleEnvelope` — 行605-636：frontmatter 信封闸门（`---\n---` 闭合、CRLF、未闭合、缺 frontmatter）。

### test-cwd-paths.mjs

验证 0.2.3 路径修复：直接调 `cw` 工具覆盖三种 cwd 形态。跑法：`node test-cwd-paths.mjs <Windows 形式仓库路径>`。

- `import * as plugin from './index.js'` — 行5：加载插件与 `path`/`fileURLToPath`。
- `const pluginDir` — 行7：`fileURLToPath(import.meta.url)` 取插件目录。
- `const repoWin` — 行8：从 `process.argv[2]` 取 Windows 形式仓库路径（默认 `E:/ik/...`）。
- `const msys` — 行10：将 `E:/x` 推导为 `/e/x` 的 MSYS 形式。
- `const registered` / `const ctx` — 行12-18：模拟宿主 `inject` 与 `effect`，将 `tools.register` 写入 `registered`。
- `await plugin.apply(ctx, {})` — 行20：注册插件。
- `const cw = registered.cw` — 行22-23：从 registered 取 `cw` 工具，缺失则退出。
- `const cfgProbe` — 行26：测试用配置（enabled/batchProvider 等，注释说明未直接验证 `resolveBinary`）。
- 验证块 MSYS 路径 — 行30-45：调用 `cw.execute({ cwd: msys, args: ['path'] })` 归一化执行并断言返回 `.codewiki`。
- 验证块 Windows 路径 `status` 三态 — 行47-57：调用 `cw.execute({ cwd: repoWin, args: ['status'] })` 验证非 "No wiki found"。
- 兜底路径说明 — 行59：`wikiPathFor` 未导出，契约由 `cw path` 成功路径覆盖。
- 验证块 不存在路径干净报错 — 行61-69：调用 `cw.execute` 不存在路径，断言抛出 `cwd 不存在`。

### test-orchestration.mjs

服务化编排冒烟测试，mock 宿主 llm 服务 + 真实 `cw` CLI + 真实服务 tick。1530 行，是本套件最大文件。

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
- 系统提示提醒块 — 行241-270：验证 `agent/created` 监听与 `codewiki:update-reminder` section。
- 注册与 cw 工具块 — 行272-290：apply 注册，断言 `cw`/`codewiki_generate`/`codewiki_progress` 存在，cw status 判定 missing。
- `codewiki_update` 与 `commitHintText` 块 — 行292-410：scope 强制 `auto`、提交引导 note、git 提交史提醒（含 autoCommit 状态分支）。
- `autoCommitWiki` 块 — 行412-513：安全边界（主题分支提交→合并回原分支，只提交 `.codewiki/` 与 `CodeWiki.md`；非 git/忽略/merge/detached/预占分支降级）。
- `autoCommitState` 块 — 行515-525：三态判定（committed/no-changes/pending）。
- `wakeCompileSession` 块 — 行527-563：终态 steer 唤醒（done/failed 文案、冷会话静默；autoCommit 成功则零唤醒）。
- 本地规划块 — 行565-622：0.10.7 起无规划阶段，`localPlan` 顶层目录分组。
- 全量编译块 — 行624-665：阶段机 `articles→crosscut→review→index`、自动提交校验。
- 大 wiki 横切拆分块 — 行667-695：观察任务 map + 合成批 reduce。
- 大模块文章分割块 — 行697-731：文章阶段观察批 map + 合成请求 reduce。
- 单项目串行块 — 行733-789：已有项目在跑时新提交进 `queued`，`queueAhead` 在等谁。
- 并行项目上限块 — 行791-820：关闭单项目串行后多仓库同时推进（`serialProjects: false, parallelProjects: 3`）。
- 唯一通道块 — 行822-854：全程走宿主 llm 服务（零直连），含 tps/`stageTimings`/`usage` 透出。
- stale 逐篇更新块 — 行856-877：`scope: 'stale'` 直达 articles。
- `codewiki_progress` 块 — 行879-915：只读查进度、百分比与明细。
- 0.6.0 重启重跑块 — 行916-973：按持久化 prompt 快照重跑/迁移（旧 plan 任务迁移到 articles）。
- 并发提交占位块 — 行975-1023：首个 tick 窗口共享 job 与 flush 合并。
- 面板端点与取消块 — 行1025-1077：`/api/codewiki/jobs`、`/api/codewiki/control` 回环守卫与取消、`/api/codewiki/repos` 总览。
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

wiki 文章行号锚点自动校验脚本，拦截幻觉锚点。运行：`node test-wiki-anchors.mjs [--strict]`。

- `const ROOT` / `const WIKI` / `const FORCE_STRICT` — 行37-39：定位仓库根、`.codewiki` 目录与 `--strict` 标志。
- `function readSourceFile(rel, { head, ref })` — 行57-78：三基准读取（编译基线版 `git show ref:` / HEAD 版 `git show HEAD:` / 工作区版 `fs.readFileSync`）。
- `const compiledCommitForViews` — 行86-91：从 `.codewiki/_meta.yaml` 的 `last_compiled_commit` 取编译基线。
- `function loadSource(rel, preferHead)` — 行96-118：返回该锚点所有可用基准下的「源码视图」数组（工作区 ∪ HEAD ∪ 编译基线），逐版去重。
- `const SOURCES` — 行119-122：预加载 `index.js`/`client.js` 两个主源文件的视图。
- `const META_PATH` / `compiledCommit` / `isFresh(rel)` — 行127-149：新鲜度判定（逐字比较工作区与编译基线）。
- `const clSectionsOf` / `CL_VIEWS` / `CL_SECTIONS_OF_VIEW` — 行157-167：CHANGELOG.md 版本节解析。
- `let passed` / `let failures` / `function check` / `function soft` — 行169-180：断言与软报告辅助。
- `const FILE_LIKE` / `function symbolsOnLine(line)` — 行186-202：提取行内反引号代码标识符（允许点分/调用形式，排除短符号与文件类），返回 `{ sym, at }` 数组。
- `function walk(dir)` — 行213-222：递归收集 `.md` 文章路径。
- 主校验循环 — 行232-277：基础行号范围、非空行、区间有序、单锚点符号绑定区间搜索；三基准任一有效即通过，结构类失败硬失败、同步类滞后软报告。
- `function describeOk(a, views)` — 行280-288：通过时打出是哪个基准解释了该锚点。
- `function judgeAnchor(...)` — 行293-394：单基准视图下判定一个锚点是否成立，返回 `{ ok, msg, kind }`；`kind: 'struct'`（越界/区间无序，永远硬失败）与 `kind: 'sync'`（空行/符号绑定，可降级软报告）/ `kind: 'changelog'`。

### test-wiki-entry.mjs

`CodeWiki.md` 入口生成与 Windows 路径规范化单元测试。运行：`node test-wiki-entry.mjs`。

- `import { ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus } from './index.js'` — 行10。
- `let failures` / `function check(cond, msg)` — 行12-16：断言辅助。
- `const tmp` / `const repo(name)` — 行18-23：临时目录与子仓库创建。
- `ensureWikiEntry` 测试 — 行25-54：缺失生成（含绝对路径/双语）、已有不覆盖、空 cwd 安全、幂等。
- `normalizeArticlePath` 测试 — 行57-59：反斜杠转正斜杠、undefined 安全。
- `parseStatus` 测试 — 行60-62：解析 `cw status` 输出（返回 `{ state, changedFiles, staleArticles }`），stale 清单 `\` 规范化。
- `normalizeIndexLinks` 测试 — 行63-72：修复 `_index.md` 链接头反斜杠，正文反斜杠不受影响。

### test-agentic.mjs

`lib/agentic.js` 测试：工具环（read_code / list_files / edit_article / generate_sub_module）与全部异常路径，用假 `streamFn` 模拟模型、完全离线。

- `import { runAgenticArticle, makeArticleEditor, makeReadCodeTool, makeListFilesTool, buildToolset, buildOpeningPrompt, parseToolArgs, safeRelPath, numberLines, TOOL_SCHEMAS } from './lib/agentic.js'` — 行4-8。
- `let pass` / `const fails` / `async function check(label, fn)` — 行10-21。
- `const FILES` / `function makeWorkspace(over)` — 行24-52：假仓库与 workspace 桩（`readFile`/`listDir`）。
- `function scripted(responses)` — 行62-73：按脚本依次返回 blocks 的 streamFn。
- 基础工具块 — 行76-148：`numberLines`、`safeRelPath`（行80-87）、`read_code`（行89-129：行号前缀、行范围、不存在/越界/行号越界）、`list_files`（行131-148）。
- 文章编辑器块 — 行151-207：`edit_article` 的 insert/str_replace/view 与各类异常（多处匹配被拒、未匹配提示、行号越界、未知命令）。
- 循环本体块 — 行210-454：单轮无工具、读文件→写文章两轮、tool 消息回灌、模型消息保留、未知工具、坏 JSON、工具抛错、maxSteps、stream 抛错、空响应、abort、finish 后文章不被正文覆盖、子模块委派 `onSubModule`、无 onSubModule 报错、深度到顶报错。
- 提示词块 — 行456-462：`buildOpeningPrompt` 含工作步骤与禁用项。
- `parseToolArgs` 块 — 行464-498：对象直通、空串、剥 ` ```json ` 围栏、夹说说明里的 JSON、平衡括号、坏 JSON、非对象 JSON。
- read_code 去重/字符上限/CRLF 块 — 行501-587：重复读不回吐、换范围正常、不同文件互不影响、不带 end_line 命中、字符上限（行563-571）、list_files 隐藏 node_modules/.git（行573-587）、insert 负数行号报错（行589-594）。
- `buildToolset` 块 — 行597-600：暴露四个工具。

### test-agentic-host.mjs

agentic-host 适配层测试：裸消息 ↔ 宿主 Message、多工具结果展开、chunk 收流、FS 越界。

- `import { toRequestMessages, makeHostStream, makeFsWorkspace } from './lib/agentic-host.js'` — 行6。
- `async function check(label, fn)` — 行10-13。
- `toRequestMessages` 块 — 行18-65：user/assistant/tool 消息转换、多结果展开、已有 id 透传、未知 role 忽略。
- `function fakeLlm(chunkScripts)` — 行67-77：按脚本吐 chunk 的假 llm。
- `makeHostStream` 块 — 行79-134：chunk 收成 blocks、透传 tools、无 tools 不带字段、finish=error 抛错、缺 llm 抛错、reasoningEffort 透传。
- `makeFsWorkspace` 块 — 行136-168：读文件/列目录/列子目录/越界读与越界列。
- MessageId 稳定性块 — 行171-184：同一批裸消息多次转换身份稳定。

### test-agentic-fallback.mjs

agentic 通道失败退回单轮通道的判定与可装填性测试，覆盖退回链路前两段（第三段由 `test-orchestration.mjs` 守护）。

- `import { shouldFallBackFromAgentic, prepareArticleTasks } from './index.js'` 与 `import { runAgenticArticles } from './lib/articles-agentic.js'` — 行13-14。
- ① 判定块 — 行27-51：`shouldFallBackFromAgentic` 严格过半触发（空/全成功/少数失败/恰好一半/过半/全失败）。
- ② 可装填性块 — 行59-98：重排任务带 mission/articlePath 可被旧通道装填（行59-73）、缺 mission 仍保留（行75-85）、源码缺失退化为可继续空装填（行87-98）。
- ③ 失败与成功并存块 — 行101-120：`runAgenticArticles` 分批失败时结果逐篇可辨（返回 Map，逐篇 ok:false），失败过半触发退回。

### test-articles-agentic.mjs

`lib/articles-agentic.js` 测试：agentic 执行器与子模块递归派发接线，用注入的假 streamFn + 真实文件系统。

- `import { runOneArticle, runAgenticArticles, markBigAgenticTasks, sourceTokensOf, resolveTaskRoute } from './lib/articles-agentic.js'` — 行7。
- `function makeTmp()` / `function call` / `function text` / `function scripted(responses)` — 行23-43。
- 基本写作落盘块 — 行48-63：`runOneArticle` 写出文章并落盘到 `articlePath`。
- 子模块派发块 — 行66-124：`generate_sub_module` 真的递归写出子模块文章（行66-98）、重名加父前缀（行100-124）。
- `subDepth=0` 禁用派发块 — 行126-141。
- subDepth 封顶（多层）块 — 行182-215：`scanArticleDepths` 递归扫描、`alwaysDispatch` 桩；subDepth=1 只一层（行182-199）、subDepth=2 允许孙模块（行201-215）。
- 子模块失败记账块 — 行217-245：父文章仍算成功。
- 池化块 — 行248-293：`runAgenticArticles` 汇总 subModules 记 note、任务抛错不影响其它任务。
- 双池与大档标记块 — 行299-387：`markBigAgenticTasks`（行299-329）、`bigConcurrency=0` 回落（行367-387）、`sourceTokensOf`（行389-397）。
- `resolveTaskRoute` 块 — 行349-365：任务自带 provider/model 覆盖默认档，effort 也以任务为准。

### test-semantic-plan.mjs

semanticPlan 端到端测试：AST 提取 → 聚类 → 模块清单。场景：有模型（LLM 聚类）、无模型（降级目录聚类）、tree-sitter 不可用（退回 localPlan）。

- `import { semanticPlan, localPlan, scanRepoFiles } from './index.js'` — 行7。
- 造混合职责仓库 `files` — 行20-33（`src/billing/`、`src/api/`、`src/util/`、`README.md`）。
- `scanRepoFiles(tmp)` — 行35：扫描源码。
- 无模型降级块 — 行38-50：降级为目录聚类、project 文案标注降级、组件数 > 0。
- 模块带 source_files 块 — 行52-58；文件并集 = 有符号源文件块 — 行60-69。
- 有模型 LLM 聚类块 — 行71-112：假模型按路径前缀切两组、`normalizeModuleName` 小写。
- 坏 JSON 降级块 — 行114-128；模型请求抛错降级块 — 行130-140；空仓库 fallback 块 — 行142-149。
- `plan.graph` 序列化块 — 行151-172：含组件与边、不携带源码（判变更只用 hash/签名/依赖）、体积 < 400_000。
- localPlan 保活块 — 行174-178；slugify 不冲突块 — 行180-184。

### test-cluster.mjs

`lib/cluster.js` 测试：LLM 聚类三段式（顶层/下钻/超级分组）与全部降级路径，用注入的 completer 模拟模型。

- `import { clusterComponents, heuristicCluster, fillMissing, moduleFiles, formatComponents, clusterPrompt, subClusterPrompt, superGroupPrompt, parseJsonLoose, parseClusterResponse, parseSuperGroups, normalizeModuleName, toPlanModules } from './lib/cluster.js'` — 行4-9。
- `function makeComponents()` — 行25-38：构造像真仓库的组件集（src/auth/src/wiki/src/panel/配置/大模块）。
- 提示词块 — 行44-62：`clusterPrompt`/`formatComponents`/`subClusterPrompt`/`superGroupPrompt`。
- JSON 抢救块 — 行65-82：`parseJsonLoose` 剥围栏、取前后废话中的对象、修尾逗号、无 JSON 返回 null。
- `parseClusterResponse` 块 — 行85-118：丢弃不存在 id 并记警告、去重复分配、缺 modules 返回 null、`normalizeModuleName` 处理空格与特殊字符。
- 启发式聚类块 — 行121-150：`heuristicCluster` 按顶层目录分组、`fillMissing` 补齐/建 misc、`moduleFiles` 汇总去重。
- 无 LLM 降级块 — 行153-166；LLM 正常路径块 — 行168-199（含 fillMissing 补齐）；LLM 抛错/垃圾降级块 — 行201-216。
- 下钻块 — 行219-267：大模块超阈值下钻成子模块、单子模块视为不可再分。
- 多层递归下钻块 — 行274-359：`makeDeepComponents`/`deepLlm` 桩；`maxDepth=2` 只下钻一层（行313-327）、`maxDepth=3` 出现孙模块（行329-343）、下钻抛错不影响整体（行345-359）。
- 超级分组块 — 行362-402：`parseSuperGroups` 对未归类模块保留在顶层、忽略不存在模块名。
- `toPlanModules` 块 — 行405-414：输出插件任务清单形状。

### test-incremental.mjs

符号级增量测试：快照存取 + 组件级变更折算 + 文章保留/跳过判定（上游 FSoft updater 核心收益是「文件变了但接口没变 → 不重写」）。

- `import { slimGraph, graphFromSnapshot, snapshotPath, loadSnapshot, saveSnapshot, filterStaleTasks, describeChange, normRel, componentsByFile, SNAPSHOT_VERSION, sameSnapshotContent } from './lib/incremental.js'` 与 `extractRepoGraph`（`lib/symbols.js`）、`bodyHash`/`stripComments`（`lib/graph-diff.js`）— 行7-12。
- `const A/A2/A3/B` — 行21-24：签名一致实现不同的样本。
- `slimGraph` 块 — 行31-40：不含源码但带固化 bodyHash。
- 快照往返/body/interface 块 — 行42-67。
- 纯注释改动降级块 — 行69-118：`stripComments` 去掉注释（行120-126）、只有注释变更文章不重写（行77-88）、改代码必须重写（行90-97）、改签名+注释 interface 优先（行99-107）、老快照无 codeHash 退回原行为（行109-118）。
- 文件内容变但符号没变 → 跳过块 — 行128-140；新增文件 added 块 — 行142-150；删除 deleted 块 — 行152-158；无符号配置保守保留块 — 行160-167；normRel 归一块 — 行169-176；多源文件块 — 行178-184；`componentsByFile` 块 — 行186-191。
- 快照落盘/回读块 — 行193-204；版本不符/坏 JSON 退化为 null 块 — 行206-214；改名归 renamed 块 — 行216-225；`sameSnapshotContent` 忽略元数据块 — 行227-237。

### test-incremental-e2e.mjs

端到端：stale 的符号级判定链路（快照落盘 → 代码改动 → 判定 → 是否重写），用真实仓库目录与 `extractCurrentGraph`/`currentCommit`。

- `import { extractCurrentGraph, currentCommit } from './index.js'` 与 `slimGraph, loadSnapshot, saveSnapshot, filterStaleTasks, describeChange`（`./lib/incremental.js`）— 行7-8。
- `write(rel, content)` — 行19-23；`V1`/`STRINGS` 样本 — 行25-41。
- 提取当前符号图块 — 行43-50；快照落盘块 — 行52-59；只改函数体实现块 — 行61-76；只改空白/注释块 — 行78-95；签名加参数块 — 行97-110；新增源文件块 — 行112-123；删掉整个源文件块 — 行125-137；无 `.codewiki` 时 `loadSnapshot` 返回 null 块 — 行139-141。

### test-sessions.mjs

会话记录存储冒烟（1.1.0）：list/read/prune 导出函数 + TTL 清理（1.2.0 增加 `listAllSessionRecords` 跨任务聚合）。

- `process.env.DSH_CODEWIKI_JOBS_FILE` 设置 — 行7；`import { SESSIONS_DIR, listSessionRecords, readSessionRecord, pruneSessionRecords, listAllSessionRecords } from './index.js'` — 行8。
- 不存在 job 空列表块 — 行15；手工构造记录 + `listSessionRecords` 倒序 — 行17-25；`readSessionRecord` 全文读取 — 行27-29。
- `listAllSessionRecords` 全局聚合块 — 行31-43：跨任务汇总、最新在前、带 jobId、limit/jobIds 过滤。
- TTL 清理块 — 行45-64：mtime 改到 25h 前、`pruneSessionRecords` 删过期（幂等）、全过期后目录移除。

### test-symbols.mjs

`lib/symbols.js` 测试：多语言 AST 符号提取 + import 依赖边，覆盖函数/方法/类归属、参数去默认、基类、箭头函数、多语言节点、import 解析、降级（语法缺失不抛错）。

- `import { SymbolExtractor, extractRepoGraph, resolveImportEdges, extractImportSpecs, resolveSpec, LANG_RULES, SUPPORTED_EXTS, regexExtract } from './lib/symbols.js'` — 行8-12。
- `const ex = new SymbolExtractor()` / `await ex.init()` — 行38-39；WASM 不可用时 SKIP — 行42-45。
- JS/TS/Python/Go/Rust/Java/C#/C 提取块 — 行63-226（类+方法+函数+箭头函数、docstring、baseClasses、参数剥默认值/rest）。
- 边界块 — 行214-226：未知扩展名返回空、语法错误不抛错、空文件返回空。
- import 边块 — 行229-269：`extractImportSpecs`、`resolveSpec`（相对/Python 点号/找不到 null）、`resolveImportEdges` 连线到目标组件。
- 真实仓库自检块 — 行272-286：`index.js`/`lib/symbols.js`/`lib/graph-diff.js`/`client.js` 完整提取。
- 正则降级块 — 行288-359：`regexExtract` JS/Python/Go/Rust 各自认出定义、无规则语言返回空、`SymbolExtractor({ vendorDir: '.no-such-vendor' })` 逼 WASM 失败走正则（行333-342）、WASM 可用时不走正则（行344-351）、语言表覆盖常见扩展名（行353-359）。

### test-graphdiff.mjs

对拍测试：`lib/graph-diff.js` 与 FSoft 上游 Python 原版逐位一致。基准由 `test-fixtures/gen-graphdiff-golden.py` 生成（缺失则退出）。

- `import { bodySimilarity, bodyHash, unifiedDiff, diffGraphs, serializeDiff, sequenceRatio, normalizeBody, documentedSource, truncateToTokens } from './lib/graph-diff.js'` — 行7-10。
- 对拍用例块 — 行14-52：从 `test-fixtures/graphdiff-golden.json` 读 cases，逐条比对 similarity/hash/unified。
- 组件级 diff 块 — 行55-107：`mk` 构造组件、`diffGraphs` 改名配对、interface/body/edge 分类、未变不登记、新增登记、`serializeDiff` 往返。

### test-worktree.mjs

worktree / 空壳目录闸门：0.12.0 的 `detectLinkedWorktree` 三态，以及 0.12.1 的 `isWorktreeCwd`/`hasCompilableSources`/`isDeadCompileTarget` 统一判定，用真实 git 命令建 linked worktree。

- `process.env.DSH_CODEWIKI_JOBS_FILE` 设置 — 行10；`import { detectLinkedWorktree, isWorktreeCwd, hasCompilableSources, isDeadCompileTarget } from './index.js'` — 行11。
- git 环境搭建 — 行16-36（init/main/linked worktree，无 git 则 SKIP）。
- `detectLinkedWorktree` 块 — 行38-53：主工作区 null、linked 命中、gitDir 指向 `.git/worktrees`、commonDir 指向主仓库、不存在/非 git/空值返回 null。
- `isWorktreeCwd` 块 — 行55-62：布尔封装 + 缓存命中一致。
- `hasCompilableSources` 块 — 行64-70；`isDeadCompileTarget` 块 — 行72-77（worktree 与空壳算 dead，不存在目录不算）。

### test-prune-orphans.mjs

`pruneOrphanModules` 的安全边界（会删文件，重点是「会不会误删」）。

- `import { pruneOrphanModules } from './index.js'` — 行10。
- `function makeWiki()` / `const ls` — 行19-31：造 wiki 目录（modules 4 篇 + concepts 1 篇 + 根 1 篇）。
- 全量编译删孤儿块 — 行33-42；保留失败文章块 — 行44-55；增量一律不动块 — 行57-68；无 plan.modules 不删块 — 行70-77；空数组不删块 — 行79-85；concepts/_architecture 永不被碰块 — 行87-96；modules 不存在安全返回块 — 行98-102；只删 .md 块 — 行104-113。
- slugify 匹配块 — 行115-149：带空格/中文/斜杠/括号的模块名与文件名一致。
- 删除失败记账块 — 行153-181：mock `fs.rmSync` 造 EBUSY，删不掉的保留、能删的照删、failed 带文件名与原因。
- 非空但残缺 plan 按非空数组当全集块 — 行186-195。

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│ 被测主体：./index.js (name=dsh-codewiki) 与 lib/*          │
│ 编译链/端点/自动提交/会话/规划/增量/符号/闸门               │
└───────┬──────────────────────────────┬─────────────────────┘
        │ 直接 import 纯函数/端点        │ makeCtx 注入 mock 切片后 apply(ctx)
        ▼                               ▼
┌───────────────────────┐   ┌────────────────────────────────┐
│ 纯函数/单元单测         │   │ 服务化编排冒烟                  │
│ test-batch            │   │ test-orchestration (makeCtx/    │
│ test-wiki-anchors     │   │   makeBatchMock 真实 tick)      │
│ test-wiki-entry       │   └────────────────────────────────┘
│ test-cwd-paths        │                │
│ test-worktree         │   ┌────────────┴───────────────────┐
│ test-prune-orphans    │   │ 离线 agentic 通道              │
│ test-sessions         │   │ agentic / agentic-host /       │
└───────────────────────┘   │ agentic-fallback / articles-   │
                            │ agentic                       │
                            └────────────┬───────────────────┘
        ┌─────────────────────────────┐ │
        │ 语义规划/聚类 + 符号级增量     │ │
        │ semantic-plan / cluster /     │ │
        │ incremental(+e2e) / symbols / │ │
        │ graphdiff                    │ │
        └─────────────────────────────┘ │
```

各脚本均依赖 `./index.js` 导出函数；agentic 相关脚本额外依赖 `lib/agentic.js`、`lib/agentic-host.js`、`lib/articles-agentic.js`；semantic/cluster 依赖 `lib/cluster.js`；incremental/symbols/graphdiff 依赖 `lib/incremental.js`、`lib/symbols.js`、`lib/graph-diff.js`。编排冒烟与端点测试通过 `installWebServer`/`makeCtx` 注入的 `webServer` 切片验证回环守卫。

## Data Flow

1. 脚本启动即通过 `import { ... } from './index.js'`（`test-batch.mjs` 行7-13）或 `await import('./index.js')`（`test-orchestration.mjs` 行24）加载插件主体。
2. 利用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))` 构造临时仓库（如 `test-batch.mjs` 行33-34 `tmpRoot` 与行56 `workRoot`，`test-orchestration.mjs` 行110-127 `makeFixtureRepo`），写入源码、超大文件（`'x'.repeat(420*1024)` 见 `test-batch.mjs` 行58）模拟 token 预算边界。
3. `test-orchestration.mjs` 调用 `makeCtx`（行51-91）注入模拟 `webServer`/`agents`/`tools`/`llm` 切片，执行 `apply(ctx, cfg)`（如行278）注册 `cw` 与 `codewiki_generate` 等工具；假 llm 由 `makeBatchMock`（行145-209）按 prompt 首行特征分发应答。
4. 触发 `gen.execute({ cwd, scope }, { agent })`（`test-orchestration.mjs` 行629 等）后插件异步推进阶段机；测试侧通过 `waitJob`（行212-225）轮询 `DSH_CODEWIKI_JOBS_FILE` 获取终态。
5. `test-batch.mjs`、`test-wiki-*`、`test-agentic*`、`test-cluster*`、`test-incremental*`、`test-symbols*`、`test-graphdiff*`、`test-prune-orphans*` 等直接调用纯函数/库，用 `check()`/`assert` 比对返回值、落盘文件内容（如 `fs.readFileSync(path.join(outDir, 'b0.md'), 'utf8')` `test-batch.mjs` 行205）及 `notes` 数组。

## Connections

- [[dsh-codewiki]]：所有脚本验证的插件主体（导出自 `./index.js`，`name === 'dsh-codewiki'` 见 `test-orchestration.mjs` 行279）。
- [[codewiki-generate]]：`codewiki_generate` 工具注册与提交占位逻辑在 `test-orchestration.mjs` 行280 等覆盖。
- [[cw-cli]]：`cw.execute` 路径（`test-cwd-paths.mjs` 行34）与 `status` 三态（`test-cwd-paths.mjs` 行48 及 `test-orchestration.mjs` 行288-289）覆盖。
- [[wiki-anchors]]：`fixAnchors`（`test-batch.mjs` 行523-603）与 `test-wiki-anchors.mjs` 符号绑定逻辑互验。
- [[wiki-entry]]：`ensureWikiEntry`/`normalizeIndexLinks` 等路径规范化在 `test-wiki-entry.mjs` 覆盖。
- [[agentic-articles]]：agentic 通道的环、执行器、子模块派发、退回判定由 `test-agentic.mjs`/`test-articles-agentic.mjs`/`test-agentic-fallback.mjs`/`test-agentic-host.mjs` 覆盖。
- [[semantic-plan]] 与 [[cluster]]：AST 聚类与模块清单由 `test-semantic-plan.mjs`/`test-cluster.mjs` 覆盖。
- [[incremental]] 与 [[symbol-extraction]]：符号级增量与多语言符号提取由 `test-incremental*.mjs`/`test-symbols.mjs`/`test-graphdiff.mjs` 覆盖。
- [[worktree-gate]] 与 [[prune-orphans]]：worktree/空壳闸门与孤儿清理由 `test-worktree.mjs`/`test-prune-orphans.mjs` 覆盖。
- [[sessions-storage]]：会话记录存储由 `test-sessions.mjs` 覆盖。

## Known Issues

- `test-cwd-paths.mjs` 行26：`cfgProbe` 注释明确：捆绑副本一致性校验交由外部 sha256 完成，测试内不再重复验证 `resolveBinary` 内部细节，仅通过 MSYS 路径跑通间接证明归一化生效。
- `test-cwd-paths.mjs` 行59：注释声明 `wikiPathFor` 兜底路径未直接导出，契约由 `cw path` 成功路径覆盖。
- `test-orchestration.mjs` 行1021：并发块清理使用 `fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`，注释指出 Windows 句柄延迟释放可能导致异常，留待 tmp 自清。
- `test-batch.mjs` 行518-521：断言 `mod.resolveBatchApiKey === undefined`，标记 0.10.1 起内置百炼直连通道与凭证解析链整体删除，插件不再触碰任何密钥。
- `test-orchestration.mjs` 行44：`LEGACY_CHANNEL` 显式关掉三档新通道（语义规划/agentic 写作/符号级增量），以守护旧通道断言；新通道验证见 `test-agentic-host.mjs`、`test-semantic-plan.mjs`、`test-incremental*.mjs`。
- `test-orchestration.mjs` 行1341-1412：会话全局 Tab 聚合接口与 worktree 闸门测试中，worktree 目录提交报错文案要求说明「等合并回主仓库后再编译」，主工作区对照不受影响。
- `test-symbols.mjs` 行42-45：若 `web-tree-sitter` 未安装，AST 相关用例整体 SKIP（打印提示并 `process.exit(0)`），仅正则降级用例在无 WASM 时仍执行；环境差异会让该脚本通过/跳过两种结果都合法。
- `test-graphdiff.mjs` 行14-17：必须先跑 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json` 生成基准文件，否则该脚本直接退出（视为未配置而非失败）。

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

`test-scripts` 模块是本仓库的端到端测试套件集合，由五个独立的 `.mjs` 脚本组成，覆盖编译执行链纯函数、宿主 llm 服务 mock、工作目录路径归一化、服务化编排阶段机、wiki 行号锚点校验以及入口文件生成等核心业务逻辑。，覆盖编译执行链纯函数、宿主 llm 服务 mock、工作目录路径归一化、服务化编排阶段机、wiki 行号锚点校验以及入口文件生成等核心业务逻辑。

所有脚本均直接针对 `./index.js` 导出的插件主体（name 为 `dsh-codewiki`，见 `test-orchestration.mjs` 行279）进行集成与功能验证，通过临时文件系统（`fs.mkdtempSync`）构造边界场景（如超大文件、多批分割、Windows/MSYS 路径），并以轻量断言函数 `check` 落盘或抛错退出，确保重构与特性迭代不破坏既有契约。当前代码已涵盖 0.10.x 至 1.2.0 系列特性：大档模型接管超长输入（见 `test-batch.mjs` 行107-131）、插件自动提交编译产物（见 `test-orchestration.mjs` 行412-513）、会话通道 steer 档位钉死（见 `test-batch.mjs` 行151-167）、并行项目上限（见 `test-orchestration.mjs` 行791-820）、孤儿任务接管（见 `test-orchestration.mjs` 行1307-1339）、worktree 闸门（见 `test-orchestration.mjs` 行1341-1412）、空壳目录闸门（见 `test-orchestration.mjs` 行1414-1463）等。

## Key Components

### test-batch.mjs

编译执行链自检脚本，验证纯函数与 mock 宿主 llm 通道。

- `import { ... } from './index.js'` — 行1-12：导入被测函数（collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer）。
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
- `function makeLlm(reply)` — 行173-188：构造假 llm 服务（按 stream 协议吐块；reply 可为字符串、函数或 Error）。
- `const promptOf` — 行189：从 `opts.messages[0].content[0].text` 提取 prompt。
- 测试块 `runRealtimeTasks` 宿主通道 — 行169-205：含上述 `makeLlm`/`promptOf`、`kmTasks`（行190-193）与 `runRealtimeTasks` 调用（行195-205），验证请求体（provider/model/reasoningEffort/temperature）与落盘。
- 测试块 `runRealtimeTasks` 混合池大档分派 — 行207-227：同一池里大档任务按自带 provider/model/档位路由。
- 测试块 `runRealtimeTasks` 大档与默认档并发分池 — 行229-296：`makeSlowLlm`（行232-242）延时吐块、`poolProbe`（行243-258）统计在飞峰值、`mk`（行259-262）构造任务；默认档并发打满 2 且大档独立限 1 两池并行（行263-282），`bigConcurrency` 缺省跟随默认档（行283-296）。
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

- `test-cwd-paths.mjs` 行26：`cfgProbe` 注释明确：捆绑副本一致性校验交由外部 sha256 完成，测试内不再重复验证 `resolveBinary` 内部细节，仅通过 MSYS 路径跑通间接证明归一化生效。
- `test-cwd-paths.mjs` 行59：注释声明 `wikiPathFor` 兜底路径未直接导出，契约由 `cw path` 成功路径覆盖。
- `test-orchestration.mjs` 行1021：并发块清理使用 `fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`，注释指出 Windows 句柄延迟释放可能导致异常，留待 tmp 自清。
- `test-orchestration.mjs` 行44：`LEGACY_CHANNEL` 显式关掉三档新通道（语义规划/agentic 写作/符号级增量），以守护旧通道断言；新通道验证见其他专用测试文件（未在本文覆盖）。
