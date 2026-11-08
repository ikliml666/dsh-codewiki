# Changelog

## 0.18.2 — 2026-11-08

### 设置页补上 TechDocs 开关

`techdocs` 在 0.17.62 就进了 Config，但面板一直没渲染它、也没进 `SAVE_KEYS`。后果是它只能在
profile 的 `cordis.patch.yml` 里手写，而设置页看着像「这个功能没有开关」——用户在页面上找不到
它，`SAVE_KEYS` 里也没有这个键，即使手工渲染了也存不下去。

补法是把它接到「产物与提醒」段（`updateReminder` / `autoCommit` / `workspaceOnly` 之后），
文案说明它每轮会多导出约 37 个文件、并且不进 cw 索引——这个量级应该让人在打开前就知道。

```
Config 字段: 28 | SAVE_KEYS: 28
SAVE_KEYS 里但 Config 没有（会静默丢值）: 无
Config 有但 SAVE_KEYS 没有（面板改不了）: 无
```

`SAVE_KEYS` 是自动保存的字段表（`client.js:1229` 逐键比对 draft 与 base 生成 `form.mutate` 的
set 操作），所以键进表才会真正落盘。

**未验证**：浏览器里点一次开关看它落盘（需要重启宿主加载新 client bundle）。

## 0.18.1 — 2026-11-07

### 会话列表：终态记录不再摸磁盘，轮询从 40ms 降到 5ms

会话页每 5s 轮询一次全局端点，而全库 meta 有两千多条。拆开看单次 `listAllSessionRecords(200)` 的成本：

```
readdir 20 个任务目录   1.9ms
statSync 2096 个 meta  38.7ms   ← 只为判断「有没有变」
readFile 2096 个       56.5ms   ← 冷启动时每条都要读一次
JSON.parse 2096 个      1.5ms
```

原来的缓存按 `mtime:size` 判定，所以每次轮询仍然要把两千多个文件全部 stat 一遍——**热轮询 40ms 里 38ms 是白花的**。

**终态记录写完之后再不会被写。** 实测 2068 条终态记录的 mtime 与 `finishedAt` 偏差全部为 0，代码里也只有 `onDone` / `onError` 各写一次。所以拆成两个缓存：

- `sessionMetaFrozen`：读到终态（status 不是 running）就永久有效，之后不再碰磁盘。
- `sessionMetaLive`：只有仍在跑的记录需要确认更新。它每次追加只会变大，比序列化长度就够，不用 mtime，也不用真的 stat 出字节数——写入路径本来就要 `JSON.stringify` 一次，直接复用那份字符串的长度。

另外每个任务目录只解析最新的 `limit` 条：结果按时间取前 limit，单个任务最多贡献 limit 条，更早的不可能进结果。零填充文件名倒序即倒序 n，所以排序文件名再切片即可，不必 parse 全部。

验证（18 个任务、2050 条记录，同一份数据两版对比，各跑 3 次）：

```
            冷启动(limit=200)   热轮询(200)   热轮询(80)
0.18.0        709 / 757 / 761ms   39-41ms     36-41ms
0.18.1        400 / 450 / 479ms    4.7-5.0ms   3.4-3.9ms
```

热轮询快 **8×**，冷启动快 **1.6×**；两版返回的 200 条记录逐条一致。

真实 HTTP 端点（真 server、真 fetch）：冷 781ms → 热 14ms；运行中的记录从 out=7 改成 4321 后，下一次轮询如实看到 4321（缓存没把活记录冻住）；单任务 limit=80 / total=690 不变。

冒烟：`test-client-panel.mjs` 24 passed、`test-sessions.mjs` 全部通过（新增 6 条：跨目录预裁剪不漏记录、运行中记录变大能看到新值、运行中转终态立刻反映）。反向验证——把运行中的记录也当终态冻结，三条断言立即 FAIL（含「startedAt 最新的排最前」），说明这层缓存确实有牙。

## 0.18.0 — 2026-11-07

### 清除历史包袱：删除 Node 兼容通道，清理全部演进记录

用户要求：「全面清除过去的技术，清除过去的设计以及改动记录，这些东西留着会影响项目
开发以及判断。」四类全清，git 提交历史不动。

**删除 Node 兼容通道（`nativeEngine: false` 那条路）。** 它已经不接收新能力，却仍在
`index.js` 里占着一整套并行实现：五个阶段 handler（`tickArticles` / `tickCrosscut` /
`tickReview` / `tickIndex` / `tickCommit`）、`STAGE_HANDLER` 分派表、批次执行器
（`startBatchChatRun` / `startAgenticRun` / `submitBatchFor` / `settleJob`）、会话通道
（`dispatchSessionTasks` / `progressSessionTasks` / `resendSessionSteer`）、本地规划
（`localPlan`）、本地校对（`localReview` / `settleProofread`）、文章落盘闸门
（`writeValidated` / `tally`）、以及三个专属模块 `lib/agentic.js`（541 行）、
`lib/articles-agentic.js`（333 行）、`lib/agentic-host.js`（135 行）。

`index.js` 5404 → 3571 行，删除 1833 行；`client.js` 3002 → 2913 行。

连带删除的配置项（它们只对这个通道生效）：`bigEnabled` / `bigProvider` / `bigModel` /
`bigReasoningEffort` / `bigTokenBudget` / `bigConcurrency`，以及 Config 里从未接线过的
`planMode` / `symbolIncremental` / `agenticArticles` / `agenticMaxSteps` / `sessionTier`。
Config 从 39 项降到 28 项。

连带删除的死代码（静态扫描确认零引用）：`localPlan`、`packArticles`、`collectSources`、
`runRealtimeTasks`、`applyTaskResult`、`contractCheck`、`allowedLinkTargets`、
`auditExistingArticles`、`makeLinkExists`、`currentCommit`、`classifySessionTask`、
`buildSessionSteerText`、`writeValidated`、`tally`、`settleProofread`、`pruneOrphanModules`、
`ensureWikiEntry`、`normalizeIndexLinks`、`bigTierOf`、五个 `batch*Prompt` 构造函数、
`fixAnchors` 及其配套的 `fixChangelogAnchors` / `changelogSections` /
`repairUnclosedFrontmatter` / `wikiRelOf` / `CONTRACT_FS` / `numberLines` / `slugify`。

`tick()` 的通道分派简化为单一通道：`job.channel` 仍记账，但不再有 `STAGE_HANDLER`
回落。原生引擎不可用时明确报错，不再有「悄悄换通道」的可能。

**清理历史性注释。** 删掉所有「0.x.y 起」「曾经」「旧的」「已退役」「兼容通道」类表述
以及引用了已不存在代码的注释块。这类文字会影响后续判断——例如「关闭 nativeEngine
退回 Node 流水线」在通道删除后就是假话，仍在 Config 的 description 里。

**文档瘦身。** `CHANGELOG.md` 4228 → 389 行（保留最近 10 个版本，更早见 git log）。
`docs/fsoft-native-engine.md` 432 → 290 行：删掉阶段 0/1A/1B/1C/6 的历史验收记录与
阶段门禁表，改为「关键机制」（工作区快照、取消与超时、真机上才能暴露的约束表）；
删掉实际已不存在的 `test-engine-contract.mjs` 等测试文件引用。`README.md`、
`cordis.patch.yml` 同步去掉已删功能与不存在的配置项。

**验证**（全部为当轮命令输出）：

```
$ node --check index.js && node --check client.js   → 均通过
$ for f in lib/*.js lib/engine/*.js; do node --check $f; done   → 全部通过
$ node /tmp/dead2.js   → 顶层定义 113 个，真死代码 1 个（Config，导出，正常）
$ node /tmp/apply2.mjs
  注册工具: [ 'cw', 'codewiki_generate', 'codewiki_update', 'codewiki_progress' ]
  注册路由: /api/codewiki/{jobs,repos,sessions,sessions/item,logs,models,model-efforts,control}
$ node /tmp/smoke2.mjs
  Config 字段数: 28
  已删字段仍存在: []
  保留字段: [nativeEngine, nativeEnginePython, techdocs, maxConcurrency, moduleConcurrency, requestLimit, updateRung]
```

**未验证**：真实编译一轮（需要重启宿主加载新代码；旧进程内存里仍是删除前的实现）。

## 0.17.64 — 2026-11-07

### 命中排除清单时不再向会话解释

用户原话：「我就是要排除这个仓库，但是我希望在会话中不要说这个仓库被排除，因为我就是
把他排除了，不想这个仓库编译。」

这次改动**推翻了 0.9.1 的相反要求**（那时要「返回排除项，告诉模型此工作区被排除了」）。
当时的理由是不说清会让模型不知道发生了什么；实际用下来反过来了：模型看到「被排除」会去
追问用户为什么、建议到设置页把目录移出清单，而用户本来就是要它不编译——每一句解释都在
让模型复述一件用户早就决定的事。

所以命中排除清单时 `notes` 置空，两个工具的 render 直接返回一句中性话就收尾：

```
codewiki：本仓库无需处理，继续手头工作。
```

`state: 'excluded'` 仍然返回给调用方（面板、内部判据要用），只是不再进 render 文本、
也不再附带原因与「去设置页改配置」的引导。`submit()` 里的同类抛错保留——那是内部接口，
工具入口已经提前拦下，模型看不到它。

### 验证

```
# 隔离作业文件（DSH_CODEWIKI_JOBS_FILE 必须在 import 之前设置）后直调两个工具
--- codewiki_generate
  state: excluded | submitted: false | notes: []
  render: "codewiki：本仓库无需处理，继续手头工作。"
  泄露词: 无
--- codewiki_update
  state: excluded | submitted: false | notes: []
  render: "codewiki：本仓库无需处理，继续手头工作。"
  泄露词: 无
```

泄露词表 = `排除` / `excluded` / `清单` / `建 wiki`，两者均为空。

## 0.17.63 — 2026-11-06

### 编译终态不再给会话发消息

用户要求「取消 codewiki 编译失败把消息发给模型的这个功能」。确认范围后按「全部取消」
执行：成功、部分完成、失败、产物待提交，四种终态一律不再 steer 任何消息。

原来的 `wakeCompileSession(job, outcome, agents)` 有两个出口——失败发「【CodeWiki 编译
失败】任务 …」，`done` 但自动提交没成功发「【CodeWiki 产物待提交】…」。整条路径连同
`createJobService` 的 `onSettled` 回调参数、`fail()` 的 `notify` 选项一起删掉了：留着
一个永远传不到的回调只会让下一个人以为终态还有出口。`fail(job, msg, {notify:false})`
的唯一调用点（原实例停更作废排队项）也随之退回两参数。

保留的部分是**会话通道**，它跟终态通知是两件事：超批量预算的文章要 steer 给发起会话、
由会话模型派子智能体写作（`dispatchSessionTasks` / `resendSessionSteer`）。`agentsRef`、
`createUserMessage`、`reassignSession` 因此都还在，只是注释里「唤醒」的措辞改成了
「会话通道」——否则读代码的人会以为唤醒机制还在。

终态现在只从三处体现：面板任务列表、`codewiki_progress` 工具的返回、以及系统提示里
那条 `codewiki:update-reminder` section（自动提交失败时它仍会注入一次性的「产物待提交」
提醒——那是拉取式的，不会主动打断会话）。

### 验证

```
node --check index.js lib/job-store.js                     SYNTAX_OK
grep -rn "wakeCompileSession" --include=*.js .             无输出（已彻底移除）

# 模块导出面：唤醒函数消失，其余导出不变（57 个）
has wakeCompileSession: false   has autoCommitState: true   has commitHintText: true

# apply() 起来后不产生任何 steer（fake agents 服务记录每次 steer）
apply 完成，steered 条数: 0

# 端到端触发失败：用不存在的引擎解释器提交一次编译，等 tick 走到终态
submit 返回: {"submitted":false}
steered 条数（8 秒后）: 0

# 拉取式提醒没被误删：造一条 done + 写入 3 篇 + autoCommit 未成功的 job 记录
commitHintText(repo) → 1 条，文本为「【CodeWiki 产物待提交·一次性】…写入 3 篇文章…」
```

## 0.17.62 — 2026-11-06

### 同步上游 a1b9f4a，把 PR #155 的 TechDocs 导出接成开关

上游从 `1b4af43` 走到 `a1b9f4a` 只有两个提交，全是 PR #155「export Backstage TechDocs
projects」（13 文件 / +982 行）。**没有触及本插件依赖的任何内部模块**：`updater.py`、
`agent_orchestrator.py`、`generate_sub_module_documentations.py`、`call_graph_analyzer`
一行未动，两处运行时适配器的源码锚点（`IncrementalUpdater._run` 的 Step 5 段、
`DocumentationGenerator._generate_modules_in_order`）在新版本上仍然命中。

新能力本身是纯文件转换，不调模型：读一份引擎产物目录，产出 `mkdocs.yml` + `docs/`，
每页加 front matter、来源横幅（commit/日期/模型）与可折叠组件清单，交给 Backstage
TechDocs 渲染。接成配置项 `techdocs`，默认关。

**为什么默认关**：它是给文档站点发布用的附加产物，每轮提交会多出 37 个文件；编译本身
不需要它。

**为什么站点目录必须建在仓库外**：上游这一步是直接写盘的。让它往 `.codewiki/` 里写，
就绕过了落地器的写集封闭与回滚——`partial`/`failed` 的一轮会留下一份半截站点，而落地
器不知道它存在，既不会算进写集也不会回滚它。现在 `index.js` 在 `os.tmpdir()` 下建临时
站点，`entry.py` 把它传给 adapter，跑完由 `lib/engine/techdocs.js` 的 `captureSite()`
读成 `{rel, content}` 写集，在 `native-run.js` 段 3.8 并进本轮 `stateFiles`，与文章
**同一个事务**落进 `.codewiki/_techdocs/`。

**为什么只有真的读到站点才裁剪它**：`pruneRoots` 里 `_techdocs` 是有条件的
（`siteCapture.captured.length ? [TECHDOCS_DIR] : []`）。写死进去的话，某一次导出失败
（上游那条路径只 `click.secho` 警告、不失败整轮）就会让裁剪把上一轮整站删光，而这一轮
什么也没写——静默丢产物。

**站点里没有图片**：落地器的 extraFiles 通道要求 `content` 是字符串
（`apply-plan.js:1148`），二进制走不了。`captureSite()` 把非 UTF-8 文件记进 `skipped`。

`.codewiki/_techdocs/` 以 `_` 开头，因此与 `_native-state/` 完全一致的待遇：`cw index`
跳过整棵子树，孤儿页与索引收录校验不管它，`lib/change-set.js` 的 `isWikiProduct` 不会
把站点改动算成源码变化。它随编译一起提交，不进 wiki 索引。

### 顺带重写 7 个受管仓库的引擎锁

`UPSTREAM_COMMIT` 一变，所有既有仓库的 `.codewiki/engine-lock.json` 就与当前环境不符，
`compareLock` 报 `drift`，而 `native-run.js:305` 对 `drift` 是直接
`settle({outcome:'failed', stage:'env'})`——下一轮会在环境校验就失败。这次用
`buildLockBody` 生成与引擎自己落锁完全一致的正文，把 7 个仓库的锁重写到 a1b9f4a
（指纹 `815347593ef61e2a` → `deb591f66b067016`）。`version`/`pythonVersion`/`pipCheckOk`
沿用旧锁里的真实值：本次只有上游源码 commit 变了，venv 与解释器都没动。

### 验证

```
# 引擎升级后的接口兼容与锚点
CLIDocumentationGenerator.__init__ 参数 = [self, repo_path, output_dir, config,
  verbose, generate_html, commit_id, techdocs_dir]        has techdocs_dir: True
install_full_runtime(1) / install_incremental_runtime()   均成功，Step5 replaced: True
pip check                                    No broken requirements found.

# 真引擎算图（不花模型费）
probe-no-llm-graph.py --fsoft-src .probe-fsoft/src
  → "ok": true，R1–R5 五条判据全 true，total_components=15，edge_count=8

# 上游 techdocs 在本仓库真产物上实跑
codewiki.cli.main techdocs .codewiki/_native-state/docs <tmp>
  → ✓ Wrote 36 TechDocs pages，mkdocs.yml nav 38 行

# entry.py 接线
注入假 generator 后调 action_generate：techdocs_dir 已传入（绝对路径）
  C:\...\entry-td-site，generate_html=False

# runNativeJob 端到端（假引擎产物 + 假站点）
notes: "TechDocs 站点已导出 3 个文件到 .codewiki/_techdocs/"
artifacts.techdocsDir = '.codewiki/_techdocs'，techdocsFiles: 3
落盘 4 个文件（含 docs/.codewiki-techdocs marker）全部存在
_index.md 不收录 _techdocs（正确），git status --porcelain 为 clean（与文章同批提交）
captureSite 单独跑真站点：captured 38、skipped 0，隐藏文件确实收录
  二进制站点文件（PNG 头 + 非法 utf8）被跳过并记进 skipped，不冒充成写集项

# 上游 adapter 真导出分支（真 CLIDocumentationGenerator + 真 generate_techdocs，不碰模型）
_run_techdocs_generation() → site file count: 38，mkdocs.yml: True，
  marker: True，page count: 36

# 7 个受管仓库的锁重写后逐个跑生产路径 doctor
match  dsh-codewiki / dsh-git-worktree / dsh-presets-Switch / dsh-subagent-auto-router
match  Wxxy-CampusHub / Wxxy-CampusLogin / dsh-hindsight-on-demand
   （全部 status: match，无 diffs）
```

**未验证**：真引擎 + 真模型的完整一轮（宿主进程启动于本次改动之前，插件仍是旧代码，
`techdocs` 开关尚未生效）。这一环要重启宿主后跑一次真实编译才能确认。

## 0.17.61 — 2026-11-06

### 会话行：正在生成时标「生成中」，不再误报「无内容」

用户截图三条 `原生请求 · doubao-seed-2.1-lite` 都是「无内容」，问「这没有问题吗」。查证分两层。

**那三条是旧版本写的记录，内容确实丢了。** `job-mw4re442-f` 的 #11/#12/#13（17:25:51 / 17:25:56 / 17:26:00）meta 里连 `stage`、`reasoningChars`、`toolCalls` 三个字段都不存在——它们是 0.17.60 上线前写的。对应的 `full.json` 里 `promptLen` 分别 183977 / 184131 / 185137 字符，`outputLen` 全是 0。桥日志显示这三条请求的 chunk 构成：

```
#11  reasoning-delta 369, text-delta 43, tool-call-delta 15
#12  reasoning-delta  30, text-delta  0, tool-call-delta 28
#13  reasoning-delta   0, text-delta  0, tool-call-delta 28
```

内容都在思考与工具调用里，旧的 `textDeltaOf` 只认正文，整段丢掉了。这正是 0.17.60 修的那个 bug，历史记录无法回填。

**0.17.60 上线后的新记录是完整的。** `job-mw4s9yyc-2` 的 #1 是改动后第一条：`stage=articles`、`outputChars=89`、`reasoningChars=4191`、`toolCalls=1`、`outputTokens=3818`；详情端点返回思考全文（4191 字符）与 `str_replace_editor` 的完整参数（`{"working_dir":"docs","command":"view","path":"overview.md"}`）。

**但这轮还暴露一个真瑕疵：请求正在跑、增量还没到时，三者都是 0，行上也会标「无内容」。** 那个状态是「即将长出来」，不是「没有」。`emptyHint` 原来只在 `outputChars` 为 0 后依次看思考与工具，最后无条件落到 `sessHintEmpty`；现在在兜底前加一层：状态为 running 时显示 `sessLive`（生成中）。同一行的 `data-empty`（给行名降饱和度的标记）也同步排除 running，否则「生成中」的行名会比同组其他行更灰，看着像失败。

验证：

```
test-client-panel.mjs  24 passed, 0 failed
  （新增「正在生成且尚无增量时行上标生成中，不误报无内容」）
反向验证：临时删掉 running 分支 → 该用例 FAIL「生成中的空记录被报成了无内容」，
          还原后 24 passed
```

真机对账（`%TEMP%/dsh-codewiki-sessions`，603 条记录）：601 条是旧格式（其中 379 条无正文），2 条新格式且字段齐全。

## 0.17.60 — 2026-11-06

### 会话页：按流程分类、正文 Markdown 预览、修掉「打开没有内容」

用户第二轮反馈四件事：「还是不美观」「每个工作区的会话要按流程分类」「打开一些会话发现没有输出内容，这没有问题吧」「会话内部按 md 预览显示」。第三条不是观感问题——查下来是真 bug。

**一、「没有输出内容」是记录环节把内容丢了，不是模型没说话。**

真机上统计 101 条会话记录：48 条有正文，53 条 `outputChars=0` 但 `outputTokens>0`（#4 tok192、#5 tok284、#7 tok156、#8 tok371…）。token 确实产生了，正文却是空。翻桥日志 `/tmp/dsh-codewiki-logs/*.ndjson` 里的 chunk 构成：

```
{"block-start":3,"reasoning-delta":1094,"block-end":3,"text-delta":17,"tool-call-delta":11,"usage":1,"finish":1}
```

模型这一轮几乎没写正文，token 全在 `reasoning-delta`（思考）与 `tool-call-delta`（工具调用）里。而 `textDeltaOf(chunk)` 只认 `chunk.text` / `chunk.delta.text` / `chunk.content`——DSH 的 chunk 类型是 `{type:'reasoning-delta', text}` 与 `{type:'tool-call-delta', id, argumentsDelta}`（`@deepseek-ai/dsh-llm/lib/types/types.d.ts:463-472`），两种都不匹配，于是整段被当成「非文本 chunk」直接 `return`。

改成 `sessionDeltaOf(chunk)` 按 `type` 分流成 `{text}` / `{reasoning}` / `{tool}`；`beginSessionRecord` 分别累积正文、思考与工具（工具按 `id` 合并分片，`argumentsDelta` 是逐片流下来的，不合并会把一次调用记成几十条半截 JSON）。meta 新增 `reasoningChars` / `toolCalls`，full 新增 `reasoning` / `tools`。终态仍以 `onDone` 给的全文为准，只有它为空时才保留流式结果。

体感变化：那 53 条「空的」请求，点开能看到模型当时想的是什么、调了哪些工具、参数是什么。列表行上也会直接标注原因（「内容在思考里」/「这轮在调工具」），不必点开才发现是空的。

**二、按流程分类：阶段信息此前根本没进会话记录。**

会话 meta 里没有 stage 字段——95 条记录的 `name` 全是「原生请求 · doubao-seed-2.1-lite」，列表上完全分不清哪条是解析代码图、哪条是在写文章。阶段信息在引擎里是有的（`llm-bridge.js` 的 `currentStage`，由 `native-run.js:702` 的 `onProgress` 通过 `bridge.setStage(p.stage)` 同步），但 `onRequestStart` 的 task 只带了 `name/model/provider/batchPrompt`，没传 stage。

三处补上：桥的 `onRequestStart` 带 `stage: currentStage`；native 通道用 `task.stage || job.nativeStage`；batch chat 与 agentic 通道用 `t.stage || job.stage || 'articles'`。历史记录没有阶段，面板统一归到「未标注」，不回填、不猜。

面板因此变成三层：工作区（仓库名 + 条数）→ 编译阶段（阶段名 + 条数 + 完成/失败/在跑）→ 单条请求。阶段按流程序排（排队→解析→聚类→写文章→校对→校验→索引→提交），不按时间——按时间排会让同一个阶段在列表里出现多次、来回跳。折叠态全在 `collapsed` map 里，默认全展开：进这一页就是想一眼看完，折叠是用户的额外动作而不是前提。

**三、正文改 Markdown 预览。**

原来 prompt 与输出都是 `<pre>{text}</pre>`，模型输出的 `## 标题`、列表、代码块全按原文摊着。改用宿主 primitives 里的 `MarkdownText`（`variant: 'compact'`，未完成的请求带 `streaming`——它走增量解析器，能看着输出逐段长出来），分类用 `SegmentedTabs`：输出 / 提示词 / 思考 / 工具，后两个只在真有内容时出现。提示词按 `[system]/[user]/[assistant]` 切块，每块带粘顶的角色标签。

**四、视觉：三层各有各的语法，不再一律描边。**

仓库层只有标题与条数，靠留白和一条底边分隔；阶段层左侧一条 1px 竖线把「同一步的请求」圈在一起（缩进用 padding，竖线才连续）；请求层只用状态点，不描边。详情区两块面板吃掉剩余高度自己滚，`pre` 的 300px 限高彻底删除。

验证：

```
test-client-panel.mjs  23 passed, 0 failed
  （新增：同一工作区内按编译阶段分组 / 输出为空但产出了思考时行上说明原因 /
    会话详情正文按 Markdown 渲染且四个页签齐全 / 全局视图默认全展开）
test-sessions.mjs      全部通过
  （新增：阶段落进 meta / 思考全文落盘 / 同一 id 的工具分片合并成一条 /
    onDone 正文覆盖流式累积）
真实 HTTP（起真 server，打三个会话端点）：
  全局列表行带 stage=graph、outputChars=0 且 reasoningChars=11
  单条端点返回思考全文与合并后的工具调用 read_file {"path":"a.ts"}
  jobs 端点 nativeResult 不再携带 gate.articles 全量清单
```

一处取舍：`readSessionRecordDetail` 合并 full 与 meta 时，思考与工具的**计数**取 meta（3s 节流期间 meta 是内存里最新的），**内容**取 full（节流快照）。正在生成的请求点开时，计数可能比正文多出最后几秒的部分——这个差在 3s 内自愈，比让面板显示过期计数更好。

## 0.17.59 — 2026-11-06

### 会话页重做：详情占满整屏、进行中任务可读、轮询不再白跑

用户反馈三件事叠在一起：「会话标签页会话一多加载就慢」「UI 过于简陋」「点进会话详情只显示半屏，下面一半不显示还要滚动」「无法查看正在进行的会话」。查下来是四个独立缺陷。

**一、详情只占半屏：双层滚动容器把内容压成自己的高度。**

`[data-dscw-p-page]` 自带 `height:100%; overflow-y:auto`。打开会话视图时 `SessionView` 又用同一属性做根节点，于是两个 `height:100%` 套在一起——内层的高度落在「高度不确定的父滚动容器」里，撑不出满高；而详情里唯一的输出块还带着 `pre { max-height: 300px }`。结果就是详情撑到内容高度就停，剩下半屏空白，想看全还得滚外层。

改成：面板根节点在会话页加 `data-dscw-p-fixed`（`overflow:hidden`），高度由 `sesswrap` → `sessdetail` 一路 `flex:1 1 auto; min-height:0` 分配下去；prompt 与输出各自是一块 `[data-dscw-p-sesspane]`，内部 `pre` 自己滚，300px 限高整条删掉。两块面板都能点标题折叠，展开时各占一半可用高度。

**二、进行中任务是裸文本：两个 data 属性没有任何样式规则。**

`[data-dscw-p-active]` / `[data-dscw-p-activerow]` 从 0.17.5 起就在 JSX 里用着，样式表里却一条匹配都没有。渲染出来是几行无边框、无色条的纯文字，和下面带状态色条的请求行完全不在一个视觉体系里，看着就像没画完。

补齐了这两条规则（边框 + 浅底 + pulse 圆点 + `[data-idle="true"]` 灰化），并让全局视图里点一行进行中任务等于「只看这个任务的请求」（`focus`），顶部给一条可清除的筛选条——原本要在一堆跨仓库的请求里自己找。

**三、轮询每 5s 重建整棵列表，滚动位置与焦点被打断。**

`SessionView` 的 `pull` 无条件 `setList/setActiveJobs`，即使 payload 一字未变也触发重渲染。改成先算指纹（total + 每个活跃任务的 stage/percent/requests + 每条记录的 status/outputChars），与上次相同就直接 return。内容没变时列表不重建，滚动位置与键盘焦点都保住。

**四、服务端三处白跑。**

| 位置 | 旧做法 | 新做法 |
| --- | --- | --- |
| 全局会话端点算「已发几个请求」 | 对每个活跃任务 `listSessionRecords(id).length`——读全部 meta 再取 length | `countSessionRecords`：只数 `.meta.json` 文件名 |
| 全局会话列表排序 | 每次轮询读完全部 meta 才能按 startedAt 排序 | meta 按 `mtime:size` 缓存，命中只花 stat；排序换掉 `localeCompare`（ISO 时间串词法序即时间序） |
| 单任务会话列表 | 一次返回全部（446 条的旧任务是常态） | `limit` 参数，默认 80，配 `total` 供前端「再加载」 |
| jobs 端点 payload | `nativeResult` 原样带出 `gate.articles`/`incremental.hydrated` 等，前端只用两个 outcome | `nativeResultBrief` 只留 `outcome/stage/gate.outcome/apply.outcome` |

验证（同形态造数：30 个任务 / 2224 条请求记录，新旧两版 `installWebServer` 装在同一份数据上跑真实 HTTP）：

```
GET /api/codewiki/jobs
  旧 11.3ms / 601.9KB    新 6.5ms / 254.7KB    体积降 58%
  nativeResult 字段：旧 344.7KB → 新 2.6KB
GET /api/codewiki/sessions（全局）
  旧 990.9ms / 63.8KB    新 52.1ms / 63.8KB
GET /api/codewiki/sessions?jobId=job-bench-00
  旧 283.5ms / 114.3KB   新 14.2ms / 20.8KB    体积降 82%
  旧 sessions=446（无 total/limit）→ 新 sessions=80 total=446 limit=80
```

`test-client-panel.mjs` 21 passed（新增「详情：两块可伸缩面板取代限高盒子」一条，断言两块 pane、默认都展开、旧 `sessbody` 已消失）；`test-sessions.mjs` 全部通过。

## 0.17.58 — 2026-11-06

### 进度条只画已执行的阶段，未执行的不再占位

用户看图反馈：进度条的颜色分布是「按固定比例预先排好」的——准备中那一格明明只跑到「解析代码图 2%」，右边却已经摆着聚类、文章、校验、索引、提交的浅色块，看着像五条空槽而不是「现在到哪了」。

根因在 `stageSegments` 的过滤条件：`stageWeight(job, r.stage, running) > 0`。进行中时 `stageWeight` 对**每个**非排队阶段都返回 `STAGE_WEIGHTS[stage]`（非零），于是四个还没轮到的阶段照样被画成 `data-state="todo"` 的浅色段。

改成只画「已跑完 / 正在跑 / 失败在这一步」的段；未执行阶段的权重留成一段透明 spacer（`data-dscw-p-seg-ahead`），让带子的总宽不随阶段推进而跳变，同时把 `[data-dscw-p-segbar]` 的底色补成与普通进度条轨道一致——未执行的地方就是轨道底色，不是阶段色。

图例同口径：未执行的阶段不列出（列出来只有一排 0%，没有信息量）。prepare 展开的三格里，只保留已完成与正在跑的子阶段。

验证：`test-client-panel.mjs` 20 passed（三条受影响断言按新口径改写：准备中 2 段而非 7 段、写文章阶段 2 段而非 5 段、未开始的 cluster 不进图例，并新增「未执行部分留成 spacer」断言）。

## 0.17.57 — 2026-11-06

### 没源码变化就不再提交任务：丢掉永久携带的死路径 + 提交前的空转闸门

用户问「怎么感觉每次重启应用后都会有更新任务，不是已经更新完了吗」。查下来是两个独立缺陷叠加，两个都修了。

**根因一：`state.json` 的 `unconsumed` 会把死路径永久携带。**

`mergeUnconsumed`（`lib/engine/native-state.js:545`）的旧规则是「上一轮携带的路径只有出现在本轮 `committed` 里才算消化」。于是「文件已被删掉、又从未提交过」的路径永远进不了 `committed`，被无限携带，`effectiveChanges` 永远非空，`idleRound` 永不成立——工作区明明干净，每轮仍跑完整的依赖分析。

真机实测（修复前）：

| 仓库 | `unconsumed` | 其中磁盘上已不存在 |
| --- | --- | --- |
| `dsh-subagent-auto-router` | 37 | 37（全是 `.dsh-ops/panel/*.json`） |
| `dsh-git-worktree` | 7 | 6（全是 `.diag-tmp/*`） |
| `dsh-presets-Switch` | 0 | 0 |

修法：`mergeUnconsumed` 增加第三类判定——不在本轮 git 任何一路（committed / staged / unstaged / untracked / deleted / renamed）里的旧账判为**死条目**，`dropped` 出账并在 notes 里点名。被 `.gitignore` 忽略的文件同样丢弃：用户写进 `.gitignore` 就是声明「这不是仓库内容」，它永远进不了 commit，携带它等于保证空转，而丢掉不会少编译任何东西。被 git 看见的未跟踪文件仍然继续携带。

修复后用同一批真实仓库复验：`dsh-git-worktree` 丢 7 条、`dsh-subagent-auto-router` 丢 37 条，两仓库的 `effectiveChanges` 从「恒非空」降到 **0**。

**根因二：AutoScan 无条件提交任务。**

`codewiki_generate` 的原生通道分支（`index.js:4029`）必须接住 `cw status` 报 clean 的情况——`cw status` 只看 committed，看不见工作区变化与受管状态。代价是 AutoScan 每小时把每个仓库都提交成一条任务，真跑起来要 3 分钟以上依赖分析，之后才发现「变化 0 项」。

修法：新增 `idleNativeReason({ cwd, wikiPath })`（`index.js:1616`），在提交任务前判一次「这一轮没有任何可做的事」。判据乐观——任何一项判不准都返回 `null`（照常提交），宁可漏跳也不许丢变化：

- 变更采集失败 → 不跳（不知道有没有变化）；
- 受管状态缺件（`module_tree.json` / `metadata.json` / 依赖图）→ 不跳（引擎会转全量）；
- `state.json` 记录的 `headCommit` ≠ 当前 cw 基线 → 不跳（有别的任务前移过基线，范围对不上）；
- `effectiveChanges` 非空 → 不跳。

用 `headCommit` 而不是 `baseCommit` 对基线：`cw meta update` 写在基线阶段、取的是那一刻的 HEAD，也就是本轮跑完时的 `headCommit`；`baseCommit` 是本轮开始时的旧基线，天然落后。

**验证（当轮实测）**

- `test-engine-native-incremental.mjs`：用例 19 新增 8 条断言（死条目丢弃 / 活口保留 / gitignore 同样丢弃 / 未跟踪新文件仍进变化集 / state.json 不再写回死条目 / notes 点名）→ **172/172 通过**。
- `test-batch.mjs`：新增 6 条断言直接测 `idleNativeReason`（干净→跳、有未提交改动→不跳、改动撤回→重新可跳、旧账有活口→不跳、状态缺件→不跳、headCommit 对不上→不跳）→ **123 通过**。
- `test-engine-native-job.mjs` 142/142、`test-job-reliability.mjs` 125/125、`test-engine-apply-plan.mjs` 62、`test-article-contract.mjs` 33、`test-config.mjs`、`test-worktree.mjs`、`test-wiki-entry.mjs` 全通过。
- 真实仓库复验：`dsh-git-worktree` / `dsh-subagent-auto-router` / `dsh-presets-Switch` / `Wxxy-CampusHub` 四个仓库的 `idleNativeReason` 全部判为「跳过本轮」，`dsh-codewiki` 因工作区有 27 项真实改动判为不跳。

## 0.17.56 — 2026-11-06

### 「准备中」不再是一格黑箱：按引擎子阶段展开，并按已解析文件数推进

面板的 `prepare` 一格吞了引擎三段：`env`（探测环境）、`graph`（解析代码图）、`cluster`（模块聚类）。真机上这三段耗时差两个数量级——`env` 三秒，`graph` 三到四分钟，`cluster` 十几分钟——而进度条整段**一动不动**。

不动的原因在上游：FSoft 把阶段内的 `update_stage` 全写在 `if self.verbose:` 里（`.probe-fsoft/src/codewiki/cli/adapters/doc_generator.py:207/225/234`），`entry.py:1015` 传的是 `verbose=False`，于是 `stage_progress` 恒为 0，`percent_of(1, 0.0)` = 0%。直到阶段跑完 `complete_stage()` 才一跳跳到 36%。实测 `job-mw4d5snr-7`：`02:36:58 graph 0%` → `02:40:24 graph 36%`，中间 3 分 26 秒零帧。

两处改动：

1. **引擎侧（`lib/engine/python/entry.py`）**：`_DetailHandler` 新增 `parse` / `parse-start` 两条正则，从上游 `call_graph_analyzer.py:118` 的 `[12/36] lib/engine/client.js (4.2s elapsed, ~8.1s remaining)` 里抽出已解析数与总数；`frame_percent` 在阶段 1 用 `percent_of(1, done/total)` 算真实比例；进度帧的 message 补「已解析 12/36 个源文件」。心跳从 60s 收到 10s——FSoft 每解析约十分之一文件才打一条日志，60s 一帧意味着整段只闪 3 次。心跳仍不推进 `percent` 之外的东西，也不改任何 FSoft 行为；`nativeLogSig` 去重让重复帧不进日志。

2. **面板侧（`client.js`）**：`prepareRows()` 在「当前正处在 prepare」时把一格拆成 `env`/`graph`/`cluster` 三段，段宽按 `nativeStageTimings`（新字段）的真实耗时、未跑到的按预估权重补齐；色相从 `prepare` 的 196 向两侧各偏 12°。引擎自报 percent 是整轮口径，三段的区间并不相同（`env` 0-100、`graph` 0-36、`cluster` 36-54，来自 `stage_map.py` 的 `FSOFT_STAGE_WEIGHTS` × `CEILING`），所以按 `ENGINE_PCT` 表归一化，否则 `graph` 跑完只显示 36%。

顺带修两处：

- `stageFraction` 对 `prepare` 段也按 0..54 归一化。此前直接用引擎整体 percent / 100，准备跑完时这一段只填到 8.6%，总进度偏小一半。
- 分段带的触发条件从 `pct > 0` 改成 `hasLiveSegments(job)`。刚进 `graph` 时归一化后就是 0%，旧的判据会退回一条空的纯色条——恰恰把用户要看的「解析到第几个文件」藏起来。

`index.js` 新增 `job.nativeStageTimings`（按引擎阶段累加的真实耗时）与 `nativeStageAt`，并在 `jobSummary` 与 `codewiki_progress` 的 schema 里暴露。`stageTimings` 仍是面板粗粒度五段的口径，两者不混用。

验证：`test-engine-python-entry.mjs` 24 passed（新增解析进度断言）、`test-client-panel.mjs` 20 passed（新增「准备中按引擎子阶段展开三段」「离开准备段后不再展开」，含反向验证）、`test-engine-native-job.mjs` 142/142、`test-engine-apply-plan.mjs` 62、`test-batch.mjs` 117、`test-config.mjs`、`test-wiki-entry.mjs` 全过。

## 0.17.55 — 2026-11-06

### 删掉进度条右侧的迷你趋势线

0.17.35 起进度条右端有一条 48×14 的 SVG 折线，画的是最近 24 次轮询的 `overallPct`。本意是「数字告诉你在哪，斜率告诉你还动不动」，实际不成立：分段带已经把阶段、完成度、耗时全画出来了，多一条折线既重复又不解释任何东西；它的颜色用 `--dsw-alias-brand-primary`，这个变量在本机主题里映射到 `--dsw-static-neutral-bluish-1000` = `#0f1115`，画出来是一条黑线，看着像进度条末尾的残影。

删除范围：渲染块（`trendOf(job.id).length > 1 ? … el(Spark, …)`）、采样块（每轮 `pctTrendRef` 写入）、`pctTrendRef` / `trendOf` 定义、`[data-dscw-p-trend]` CSS、中英 `trendHint` 两条文案。`Spark` 组件保留——吞吐徽标（tok/s）还在用它。

---

更早版本（0.17.54 及以前）见 git log。
