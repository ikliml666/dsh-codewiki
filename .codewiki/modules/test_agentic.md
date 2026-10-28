---
title: test_agentic
type: module
source_files:
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-agentic-fallback.mjs
  - test-articles-agentic.mjs
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - index.js
  - lib/article-contract.js
tags: [test, agentic, articles, host, fallback]
---

## Overview

`test_agentic` 是「agentic 文章生成与 host 适配」这条链路的全部测试集合，由 4 个独立可执行的 `.mjs` 文件组成。它们都**完全离线**：用注入的假 `streamFn`（按脚本返回 assistant blocks / 文件系统的假 `workspace`）模拟模型，不触碰任何真实 LLM，因此可以在 CI 里确定性跑通。

四个文件按职责分工：

- `test-agentic.mjs` —— `lib/agentic.js` 的单测：工具循环（`read_code` / `list_files` / `edit_article` / `generate_sub_module` 四个工具的实现）、`runAgenticArticle` 主循环及全部异常/边界路径、`parseToolArgs` 参数解析、`buildOpeningPrompt` 提示词构造。605 行，约 40 个 `check`。
- `test-agentic-host.mjs` —— `lib/agentic-host.js` 的适配层单测：裸消息 ↔ 宿主 `Message`（展开/透传/稳定身份）、`makeHostStream` 把 chunk 收成 blocks、`makeFsWorkspace` 的越界防护。191 行。
- `test-agentic-fallback.mjs` —— agentic 通道大失败时退回单轮通道的判定与可装填性：覆盖 `shouldFallBackFromAgentic`（`index.js:1364`）和 `prepareArticleTasks`（`index.js:1236`）两段，并用 `runAgenticArticles` 验证「失败结果逐篇可辨」。127 行。
- `test-articles-agentic.mjs` —— `lib/articles-agentic.js` 的执行器与子模块递归派发：落盘、`generate_sub_module` 真递归写子文、`subDepth` 封顶、`markBigAgenticTasks` 双池大档、`resolveTaskRoute` 选档、写集闸门。475 行。

所有文件共用同一套轻量测试框架：一个 `check(label, fn)` 收集器（见 `test-agentic.mjs:12`），`check` 内部 `try/catch` 捕获后计入 `fails`，最后打印 `PASS/FAIL` 并 `process.exit(fails.length ? 1 : 0)`（如 `test-agentic.mjs:604`）。每个文件末尾都有这个收尾逻辑（`test-agentic-host.mjs:190`、`test-agentic-fallback.mjs:126`、`test-articles-agentic.mjs:474`）。

## Key Components

### 测试框架（四个文件共用）

- `check(label, fn)`：`test-agentic.mjs:12-21`。`async fn` 成功计数 `pass++` 并 `console.log('PASS …')`；失败把 `{label,err}` 塞进 `fails` 并打印 `FAIL`。其余三文件同形：`test-agentic-host.mjs:12`、`test-agentic-fallback.mjs:20`、`test-articles-agentic.mjs:18`。
- 假仓库 `makeWorkspace(over)`：`test-agentic.mjs:29-52`。返回 `{readFile, listDir}` 抽象，基于内存 `FILES` 表（`test-agentic.mjs:24-28`，含 `src/index.js` / `src/a.js` / `README.md`）。`listDir` 用 `top = rest.split('/')[0]` 取顶层目录名并标 `dir`。
- 假消息构造器：`assistant(blocks)`（`test-agentic.mjs:55`）、`call(id,name,args)`（`test-agentic.mjs:56-58`，把 args 序列化成 `arguments` 字符串）、`text(t)`（`test-agentic.mjs:59`）。`test-articles-agentic.mjs:31-34` 另有同形 `call`/`text`。
- 假 `streamFn`：`scripted(responses)`（`test-agentic.mjs:62-73`）按调用顺序依次吐 `responses[i]`，并记录每轮收到的 `{messageCount, toolNames}` 到 `seen`，越界后回 `[text('done')]`。`test-articles-agentic.mjs:37-43` 的 `scripted` 额外带 `finish:{kind:'stop'}`。

### test-agentic.mjs 逐测试（标注其断言的源函数）

| 测试 label（行号） | 断言的源符号（行号） |
| --- | --- |
| `numberLines 用「行号| 」前缀`（76） | `numberLines` `lib/agentic.js:101`，`1\| a` |
| `safeRelPath 拒绝越界与绝对路径`（80） | `safeRelPath` `lib/agentic.js:266`；拒 `../etc/passwd`、`/etc/passwd`、`C:/Windows` |
| `read_code 返回带行号全文`（89）等 6 项 | `makeReadCodeTool` `lib/agentic.js:115`；含行范围（98）、缺 path（112）、越界（117）、行号越界（124，命中 `第 145 行` 的 `超出文件长度`） |
| `list_files 列根目录`（131）等 4 项 | `makeListFilesTool` `lib/agentic.js:179`；含隐藏 `node_modules/.git`（573，走 `IGNORED_DIRS` `lib/agentic.js:98`） |
| `edit_article insert/str_replace/view` 系列（151-207） | `makeArticleEditor` `lib/agentic.js:200`；CRLF 跨行命中（542）、CRLF 保持（550）、负数行号报错（589，命中 `不能为负`） |
| `单轮无工具调用直接收正文`（210） | `runAgenticArticle` `lib/agentic.js:331`，`stopReason==='finished'`、`usedTools.length===0` |
| `读文件→写文章的完整两轮`（221） | 同上；工具结果回灌 `tool` 消息（237）、模型原样进历史（259） |
| `未知工具回灌错误但不中断`（276） | 命中 `未知工具：（可用：…）`（405） |
| `工具参数坏 JSON 记警告并继续`（293） | `parseToolArgs` `lib/agentic.js:476`，`steps` 记 `不是合法 JSON` |
| `工具抛错被捕获为 isError`（307） | `impl` 抛错兜底（410） |
| `达到 maxSteps 时停止`（324） | `stopReason='max-steps'`（365/423） |
| `streamFn 抛错时优雅停止`（337） | `stopReason='stream-error'`（377） |
| `空响应停止`（347）/ `abort 信号生效`（355） | `stopReason='empty-response'`（380）/ `'aborted'`（369） |
| `finish 前清空的文章不会被正文覆盖`（365） | 第 391 行「模型给了文章但 editor 还空才收下」的语义 |
| `子模块委派走 onSubModule 回调`（380） | `buildToolset` 的 `generate_sub_module`（285-313） |
| `无 onSubModule 时子模块调用必须报错`（401） | 旧实现谎称「已记录子模块」的回归（291-305），断言 `没有派出`/`不支持递归\|嵌套上限`，且 `doesNotMatch(/已记录子模块/)` |
| `深度到顶时子模块调用报错`（421） | `subModuleBlocked='max-depth'` 走「普通小节」提示（294-299） |
| `只有 3 个工具声明给模型`（438） | 默认仍声明 4 个（含安全桩 `generate_sub_module`），`tools.length===4`（354） |
| `缺 streamFn 直接抛错`（451） | `throw new Error('runAgenticArticle 需要 streamFn')`（347） |
| `buildOpeningPrompt 含工作步骤与禁用项`（456） | `buildOpeningPrompt` `lib/agentic.js:506`，含 `不许编造文件、函数、行号`/`不要用 markdown 围栏把整篇文章包起来` |
| `parseToolArgs …`（464-499） | 对象直通（465）、空串→`{}`（466）、剥 ` ```json ` 围栏（470）、截取夹在说明里的 JSON（477）、平衡括号不误截字符串内花括号（482）、坏 JSON 记警告（487）、非对象 JSON（495） |
| `read_code 重复读不再回吐正文`（501） | `makeReadCodeTool` 的 `seen` 去重（115/128-135），第二次回「你已经在第 N 步读过这段」；不同行范围/不同文件不互相影响（516/525） |
| `read_code 有字符上限`（563） | `MAX_READ_CHARS=40000`（`lib/agentic.js:96`），超长文件截断并提示「字符上限」 |
| `buildToolset 暴露四个工具`（597） | 断言键集合 `['edit_article','generate_sub_module','list_files','read_code']`（279） |

### test-agentic-host.mjs 逐测试（标注其断言的源函数）

| 测试 label（行号） | 断言的源符号（行号） |
| --- | --- |
| `user 消息转正式 UserMessage`（18） | `toRequestMessages` `lib/agentic-host.js:34`，补 `id` |
| `assistant 消息带 provider/model 与 tool-call`（26） | 同上，写 `source.kind='model'`、`source.provider/model`（32-34） |
| `一条 tool 消息的多个结果展开成多条 ToolResultMessage`（38） | 一个 `tool` 消息多 `tool-result` → 多条（58-76） |
| `已有 id 的 assistant 消息透传不重造`（55） | `if (m.id) { out.push(m); continue }`（48） |
| `未知 role 被忽略`（61） | 第 36-77 行的 role 过滤 |
| `makeHostStream 把 chunk 收成 blocks`（79） | `makeHostStream` `lib/agentic-host.js:83`，`temperature:0`（94/98） |
| `makeHostStream 无 tools 时不带 tools 字段`（101） | `tools` 为 `undefined`（93） |
| `makeHostStream finish=error 抛错`（114） | 命中 `boom`（102） |
| `makeHostStream 缺 llm 抛错`（124） | `throw new Error('makeHostStream 需要宿主 llm 服务')`（84） |
| `makeHostStream reasoningEffort 透传`（128） | `captured.reasoningEffort==='high'`（91） |
| `makeFsWorkspace 读/列/越界`（142-168） | `makeFsWorkspace` `lib/agentic-host.js:111`，`readFile('../../etc/passwd')` 拒 `越界`（122）、`listDir('../..')` 拒 `越界`（127） |
| `同一批裸消息多次转换，MessageId 保持稳定`（171） | `IDENTITY` WeakMap（26）+ `stableKeyFor`（29）保证身份跨边界不变 |

### test-agentic-fallback.mjs 逐测试

- `shouldFallBackFromAgentic` 全判定（27-51）→ 断言 `lib/index.js:1364`：`[]`/`null` 不触发（28-30）、全成功不触发（32）、`1/4` 不触发（36）、`2/4` 严格不触发（40）、`3/4` 触发（44）、`1/1`、`3/3` 触发（48）。核心是 `failed * 2 > relevant.length`（1368）——「过半失败才算系统性失败」。
- `重排任务带 mission/articlePath 时可被旧通道装填`（59-73）→ `prepareArticleTasks`（`lib/index.js:1236`）把 agentic 快照（`{customId,name,mission,sources,cwd,articlePath,prevArticlePath}`）重装填成单轮请求，`prepared.length===1`、`sessionTasks.length===0`（小模块不进会话通道）、`prompt` 含源码、`name` 保持一致。
- `缺 mission 的重试任务装填后仍保留`（75-85）→ 缺 `mission` 时 `prepareArticleTasks` 仍能产 prompt（容错），断言 `prepared.length===1`。
- `源码文件不存在时退回任务退化为可继续的空装填`（87-98）→ `collectSources` 容错（`lib/index.js:1165`），`prepared.length + sessionTasks.length === 1`，宁可空装填也不整批消失。
- `runAgenticArticles 分批失败时结果逐篇可辨`（101-120）→ `runAgenticArticles`（`lib/articles-agentic.js:231`）在 `llm:null` 下每篇都抛错，仍返回 `Map`、逐篇 `ok:false`、失败过半再触发 `shouldFallBackFromAgentic`。这是退回链路第③段（前两段由本文件覆盖，第③段由 `test-orchestration` 间接守护）。

### test-articles-agentic.mjs 逐测试

- `写出文章并落盘到 articlePath`（48-63）→ `runOneArticle`（`lib/articles-agentic.js:33`）`out.ok===true`、落盘 `FULL_ARTICLE`、`subModules===[]`。
- `generate_sub_module 真的递归写出子模块文章`（66-98）→ 子任务自起一个 `streamFn`；断言 `subModules[0].path === <modules>/commerce/cart.md`（第 93 行，`lib/articles-agentic.js:69`）、父文链接到 `commerce/cart.md`、子文含「子模块正文」。
- `子模块重名时加父前缀`（100-124）→ 两次同名 `core` 不互相覆盖，`paths` 长度 2（去重逻辑 `lib/articles-agentic.js:88-94`）。
- `subDepth=0 时派发被禁用`（126-141）→ `subModules.length===0`。
- `subDepth=1`（182）/ `subDepth=2`（201）→ 磁盘文章目录层数分别 `≤2` 与 `≥3`（脚本 `alwaysDispatch` 175-180，扫描 `scanArticleDepths` 151-163）。这是 `subDepth` 失效（旧 `dispatchSub` 本层闭包导致深度永不递增）的回归防护（见注释 143-149）。
- `子模块写作失败被记账，父文章仍算成功`（217-245）→ `out.subModules[0].ok===false`、`out.ok===true`。
- `runAgenticArticles 汇总 subModules 并记 note`（248-270）→ `notes` 记「派生出 1 个子模块文章」（第 282 行 `articles-agentic.js`）。
- `任务抛错不影响其它任务`（272-293）→ 流抛错收敛为 `stopReason='error'`/`'未产出正文'`（291）。
- `markBigAgenticTasks` 系列（299-329）→ `lib/articles-agentic.js:320`：超预算打 `bigTier`（305）、未配置 `bigTier` 原样返回（315）、不传 `reasoningEffort` 时任务上不出现该字段（322）。
- `双池：大档/默认档都能跑完并各自落盘`（331-347）→ `provider/bigTier` 标记生效、两篇都落盘。
- `resolveTaskRoute`（349-365）→ `lib/articles-agentic.js:208`：任务自带 provider/model 全生效、缺 effort 回落空（不回落默认档 `off`）、普通全用默认档、只写一半回落默认档。
- `bigConcurrency=0 回落 concurrency`（367-387）→ `peak===2`。
- `sourceTokensOf`（389-397）→ `lib/articles-agentic.js:185`，CJK 100 字符估 100 token，读不到跳过。
- 写集闸门 5 项（399-470）→ `runOneArticle` 的 `allowedWritePaths`（153-167）→ `makeWriteSet`/`isWritable`（`lib/article-contract.js:365/365`）：越界写 `ok=false`/`stopReason='write-set'`（412）、写集内正常落盘（417）、不设限旧行为不变（433）、子层越界写父文被拒（449，`allowedWritePaths:[parentPath]` 下子文只拿自己那条路径）。

## Architecture

四个测试文件都只依赖被测的纯逻辑模块；离线的关键在于把 `streamFn` / `workspace` / `llm` 全部注入，而不是走真实宿主。

```text
┌─ test-agentic.mjs ──────────────┐      ┌─ lib/agentic.js ─────────────┐
│ fake workspace + scripted()      │─────▶│ runAgenticArticle (331)      │
│ check: tool impl / loop / args / │      │ buildToolset (279) → 4 工具  │
│  prompt / dedup / read limit     │      │ parseToolArgs (476)          │
└─────────────────────────────────┘      │ buildOpeningPrompt (506)     │
                                         └──────────────────────────────┘
┌─ test-agentic-host.mjs ─────────┐      ┌─ lib/agentic-host.js ────────┐
│ fakeLlm(chunkScripts)            │─────▶│ toRequestMessages (34)       │
│ check: bare↔Message / expand /   │      │ makeHostStream (83)          │
│  stable MessageId / FS 越界      │      │ makeFsWorkspace (111)        │
└─────────────────────────────────┘      └──────────────────────────────┘
┌─ test-agentic-fallback.mjs ─────┐      ┌─ lib/index.js ───────────────┐
│ check: fallback 判定 / 可装填    │─────▶│ shouldFallBackFromAgentic    │
│  / runAgenticArticles 逐篇可辨   │      │   (1364) / prepareArticleTasks│
└─────────────────────────────────┘      │   (1236)                     │
                                         └──────────────────────────────┘
┌─ test-articles-agentic.mjs ────┐      ┌─ lib/articles-agentic.js ────┐
│ makeTmp() + scripted()           │─────▶│ runOneArticle (33) → 递归    │
│ check: 落盘 / 子模块递归 /       │      │   generate_sub_module        │
│  subDepth 封顶 / 双池大档 /      │      │ runAgenticArticles (231)     │
│  写集闸门                        │      │ markBigAgenticTasks (320)    │
└─────────────────────────────────┘      └────────────┬────────────────┘
                                                      │ uses
                                                      ▼
                                         ┌─ lib/article-contract.js ───┐
                                         │ makeWriteSet (352) /         │
                                         │ isWritable (365) 写集闸门    │
                                         └──────────────────────────────┘
```

`runAgenticArticle`（`lib/agentic.js:331`）消费裸 `{role,content}` 消息与 `blocks`，不绑定宿主 `Message`；`test-agentic-host.mjs` 验证的 `toRequestMessages`（`lib/agentic-host.js:34`）正是把它适配回宿主 `Message`，使生产链路（`startAgenticRun` `index.js:2932`）能把 `runRealtimeTasks` 式的裸消息交给真实 `llm.stream`。

## Data Flow

1. **单测驱动**：测试构造 `workspace`（内存或临时目录）和 `streamFn`（按脚本返回 assistant blocks），调用被测函数。
2. **`runAgenticArticle` 主循环**（`lib/agentic.js:331-387`）：每步 `streamFn({messages,tools})` → 把 assistant 消息原样进 `messages`（383）→ 对其中的 `tool-call` 执行 `tools` 实现（399-420）→ 结果打包成 `role:'tool'` 消息回灌（421）→ 步号 `stepRef.current` 刷新供 `read_code` 报「第 N 步读过」（350/368）。
3. **落盘**：`runOneArticle`（`lib/articles-agentic.js:33-81`）拿到 `runAgenticArticle` 的 `article`，空文章判失败（147-149），否则按 `allowedWritePaths` 闸门（155-167）写盘（175-176），并把 `subModules`（`lib/articles-agentic.js:122`）一起返回。
4. **退回链路**（`test-agentic-fallback.mjs`）：`shouldFallBackFromAgentic`（`index.js:1364`）看过半失败 → `tickArticles`（`index.js:3135`）把失败篇 `filter` 成 `retryTasks` 并调用 `prepareArticleTasks`（`index.js:1236`）重装填成单轮/会话任务。
5. **双池执行**：`runAgenticArticles`（`lib/articles-agentic.js:231`）按 `bigTier` 把任务分进普通池/大档池（245-255），各自 `Promise.all` 限流（307），结果收进 `Map`（284-291），子模块派生记 `notes`（282）。

## Connections

- [[lib/agentic]] —— `test-agentic.mjs` 的直接被测对象（工具循环、参数解析、提示词）。
- [[lib/agentic-host]] —— `test-agentic-host.mjs` 的直接被测对象（裸消息↔宿主 Message 适配、chunk 收流、FS workspace）。
- [[lib/articles-agentic]] —— `test-articles-agentic.mjs` 的直接被测对象（单篇执行、子模块递归、双池、写集闸门）。
- [[index]] —— `test-agentic-fallback.mjs` 测的 `shouldFallBackFromAgentic`/`prepareArticleTasks`/`startAgenticRun` 所在；`Config.agenticArticles`（`index.js:90`）与 `agenticMaxSteps`（`index.js:91`）是这条通道的总开关。
- [[lib/article-contract]] —— 写集闸门 `makeWriteSet`/`isWritable`（`article-contract.js:365/365`）被 `test-articles-agentic.mjs` 的写集用例间接守护。
- [[test-orchestration]] —— `test-agentic-fallback.mjs` 注释点明其退回链路第③段「收割计入 tally」由 `test-orchestration` 旧通道断言与 tally 去重逻辑间接守护。

## Known Issues

- **退回链路只覆盖前两段**：`test-agentic-fallback.mjs:3-8` 明确写明，第三段「收割计入 tally」不在本文件，而是依赖 `test-orchestration` 的旧通道断言与 `index.js` 中 `tally`（`index.js:2629`）的去重逻辑间接守护——若那一侧改动破坏去重，本文件不会告警。
- **`runAgenticArticle` 步数上限双来源**：`lib/agentic.js:331` 的 `DEFAULT_MAX_STEPS=30` 与 `index.js:2938` 的 `Config.agenticMaxSteps` 默认 30 必须保持一致，否则「直接调用」拿 24、「走生产链路」拿 30（`lib/agentic.js:321-324` 注释）。该一致性没有独立断言，仅靠 `lib/articles-agentic.js:21` 的再导出维持单一常量。
- **子模块深度封顶曾失效**：旧实现 `dispatchSub` 是父层闭包，递归时原样下传导致 `_depth >= subDepth` 永远用父层深度判定（`lib/articles-agentic.js:83-89`），理论上 `subDepth=2` 会堆溢出。回归由 `test-articles-agentic.mjs` 的 `subDepth=1/2` 两条「看磁盘层数 + 调用次数有界」的断言兜住，但断言是与顺序无关的（不校验精确调用序列），只对极端失效敏感。
- **`subDepth=0 时派发被禁用` 用例未断言 stopReason**：`test-articles-agentic.mjs:138` 只断言 `subModules.length===0` 与 `ok===true`，没有校验 `stopReason==='finished'`，对「派发被禁用但仍正常收尾」的语义覆盖是宽松的。
- **`runAgenticArticles` 在 `llm:null` 下返回 Map 的断言是行为契约而非源码行**：`test-agentic-fallback.mjs:115` 断言「执行器必须返回 Map，不能整体抛错」，这是对 `lib/articles-agentic.js:231` 的 `try/catch` 入池（300-304）的间接约束，没有逐行钉死。
