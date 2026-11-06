# Changelog

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

## 0.17.54 — 2026-11-06

### 修 0.17.53 的白屏：档位下拉把 `{id,name,description}` 对象当 React child

现象：装 0.17.53 后 CodeWiki 面板整块白屏，控制台是

```
Error: Minified React error #31 ... args[]=object%20with%20keys%20%7Bid%2C%20name%2C%20description%7D
client.js:638 slot entry crashed in 'main'
```

根因：`/api/codewiki/model-efforts` 返回的 `efforts` 是对象数组（`index.js` 的 `resolveModelEfforts` 逐个映射成 `{id, name, description}`），而 0.17.53 的「按环节设档位」写成了 `el('option', { key: e, value: e }, e)` —— 第三个参数是 children，传对象就命中 React #31。同一份数据在 `modelTrio`（`client.js:1086-1098`）里一直是对的：取 `e.id` 做 value、`labelOf(e)` 做文本。这段没照它写。

修复：

- 档位选项统一走 `toOption(e)`：字符串按 id 处理，对象取 `id`/`name`，文本形如 `Low（low）`。
- 「当前值不在目录里」的判据从 `efforts.includes(current)` 换成 `knownIds.includes(current)`——对对象数组，前者永远是 false，会让已配置的档位被误判成陌生值。

测试侧真正的漏洞：桩 React 的 `render` 遇到普通对象子节点会静默展开成空串，所以旧写法在桩里也「通过」。现在桩遇到非元素对象子节点直接抛 `Objects are not valid as a React child（React #31）`，与真实 React 对齐。同时新增用例「档位接口返回对象数组时按环节下拉不崩」，桩 `model-efforts` 返回 `[{id:'low',name:'Low',description:'快速'},{id:'high',...}]`，并等到标签渲染出来再断言（档位目录是二次异步拉取，一帧跑不完）。

反向验证：把 `map(toOption)` 退回 `map((e) => el('option', {...}, e))` 后该用例失败（`Objects are not valid as a React child（React #31）：["id","name","description"]`），恢复后 18 passed。

回归：`test-client-panel.mjs` 18（原 17）、`test-config.mjs`、`test-engine-llm-bridge.mjs` 30、`test-engine-apply-plan.mjs` 62、`test-article-contract.mjs` 33、`test-engine-contract.mjs` 19、`test-engine-quality-gate.mjs` 37、`test-engine-output.mjs` 34、`test-engine-native-job.mjs` 142/142、`test-engine-native-incremental.mjs` 164/164、`test-job-reliability.mjs` 125/125、`test-batch.mjs` 117、`test-article-repair.mjs` 49、`test-wiki-entry.mjs` 全部通过。

## 0.17.53 — 2026-11-05

### 设置页补上「按环节设档位」的控件（0.17.52 只做了后端）

0.17.52 加了 `effortByStage` 配置项，但设置页的字段是 `client.js` 手工渲染的、不读 Config schema，所以设置页里看不到它。这一版补上：

- `client.js` 的 `SAVE_KEYS` 加 `effortByStage`（不加就改了不落盘）。
- 「编译模型」区块在 `requestLimit` 之后新增一组「按环节设档位」下拉：依赖图 / 模块聚类、文章写作、语义校对、质量门各一个。选项来自模型目录（与上面的思考程度同一份 `useEfforts`），另有「（用兜底档）」空选项；当前值不在目录里时保留成额外选项，避免换模型后静默丢配置。
- 新增 `[data-dscw-stages]` / `[data-dscw-stage]` / `[data-dscw-stagelabel]` 三段 CSS：每环节一行「名字 96px + 下拉」。
- 中英文案各 6 条。
- `test-config.mjs` 新增 7 条用例：默认空对象、环节档位原样透出、空串被剔除、两端空白被裁。

## 0.17.52 — 2026-11-05

### 按环节分别设思考档位（effortByStage）

此前所有模型环节（依赖图/模块树/文章/横切/审校）共用同一个 `batchReasoningEffort`，无法按环节分别开。新增 `effortByStage` 配置项：key 是阶段名（`graph`/`cluster`/`articles`/`proofread`/`validate`/`index`/`baseline`/`commit`），value 是该环节的 reasoning effort 档位。缺省（空对象或该环节没配）用 `batchReasoningEffort` 兜底，与之前行为完全一致。

实现位置：`lib/engine/llm-bridge.js` 新增 `effortByStage` 参数与 `setStage()` 方法；`lib/engine/native-run.js` 在 `onProgress` 回调里同步阶段给桥；`index.js` 配置 schema 用 `z.dict(z.string())` 接收（schemastery 没有 `z.record`）。

测试：`test-engine-llm-bridge.mjs` 新增 2 条（按阶段选档 + 无 effortByStage 时兜底），30 passed。

## 0.17.51 — 2026-11-05

### 陈旧模块树的死组件不再污染 source_files：基线卡死 9 个提交的病根

本仓库连着 5 个编译任务终态 `partial`，阻塞点恒为一条：
`[source-missing/product] Shared_Infrastructure_Utilities 的 source_files 指向不存在的文件：lib/wiki-notes.js`。结果是 `cw meta update` 永不执行，`_meta.yaml` 的 `last_compiled_commit` 钉在 `23a0b17f`，而 HEAD 已经走到 `56c49ec6`——中间 9 次 `docs(wiki)` 自动提交全是白跑的产物。

根因不在判据，在证据的时效性，两处叠加：

- **module_tree 只增不减**。上游 `cluster_modules.py:488-496` 在增量轮把新子树**合并进**旧树（`current_module_tree == {}` 才整体替换），删掉的文件不会从旧树消失。本仓库的 `.codewiki/_native-state/docs/module_tree.json` 因此一直留着 `lib\wiki-notes.js::buildNote`（0.17.49 已删该文件）；实测 148 个组件里只有这 1 个是死的，而增量日志确认该轮直接进 `[2/5] Incremental Update`，没有重新聚类的阶段。
- **`sourceFilesOf` 不做存在性判断**。`lib/engine/mapping.js:70` 从组件 id 的 `::` 前部分直接取文件名塞进 `source_files`，于是死路径被渲染进 frontmatter，`validateOutput` 第 5 段（`lib/engine/output.js:333-346`）每轮如实报 `source-missing`，error 级 → 终态 partial → 基线不推进。这是一条自锁：越不推进基线，越没有机会重新聚类。

修法落在证据链上游（`sourceFilesOf`），不在判据上：

- **`sourceFilesOf(components, componentFiles, fileExists)`**：从组件 id 推出的路径要先过 `fileExists`，不存在就不计入。`componentFiles` 的显式映射**不**受此限——那是调用方给的证据，指错了仍由 `source-missing` 如实报出来（补了用例锁住这条边界）。
- **`mapFsoftOutput({ fileExists })` / `buildWritePlan({ repoRoot })` 新增可选入参**：`mapping.js` 保持纯函数（不碰磁盘），存在性由调用方以回调形式注入；`buildWritePlan` 只在给了 `repoRoot` 时才传 `(rel) => fs.existsSync(path.join(repoRoot, rel))`，`validateOutput` 沿用已有的 `repoRoot` 参数透传。
- **不给 `repoRoot` 时行为不变**：`buildWritePlan` 单独调用（测试、离线分析）仍全收组件，不因缺上下文而少算 source_files——「宁缺勿造」只对**已知不存在**生效，不对**未知**生效。

验证：本仓库真实状态目录跑 `gateNativeOutput` → `source-missing` 从 3 条 defect 降到 0，剩下的 2 条是 `commit-mismatch` 与 `uncommitted-input`（工作区 22 个未提交改动，与本缺陷无关，属预期）。
- `test-engine-output.mjs` 34 passed（原 33，新增「陈旧 module_tree 的组件指向已删文件 → 不计入 source_files，不判 source-missing」；原「source_files 指向不存在的文件 → source-missing」改成走 `componentFiles` 显式证据，锁住判据没被削弱）
- `test-engine-output-real.mjs` 11 passed、`test-engine-contract.mjs` 19、`test-engine-quality-gate.mjs` 37、`test-engine-apply-plan.mjs` 62、`test-engine-native-job.mjs` 142/142、`test-engine-native-incremental.mjs` 164/164、`test-article-contract.mjs` 33、`test-batch.mjs` 117、`test-wiki-entry.mjs`、`test-wiki-anchors.mjs` 2 过 / 0 败 —— 全部通过。

## 0.17.50 — 2026-11-05

### 适配 DSH 0.2.2-rc.1：54 条破坏性变更逐项核对后，只有 Node 下限这一条落到本插件

`C:/Users/ik/.dsh/reports/dsh-0.2.2-rc.1-breaking-changes.md` 列了 54 条（rc.5 → rc.1 之间的 2624 个提交）。逐条比对后，真正生效的只有 §1.1：`engines.node` 下限提到 `>=24.9.0`。其余 53 条在本仓库**零命中**，不是「改过了」，而是从来没用到那些接口。

- **`engines.node`: `>=20` → `>=24.9.0`**。这条在 rc.5 上不产生任何行为变化（rc.5 的 `dsh-app-boot` 不校验插件 `engines.node`，全库搜 `engines.node` 零命中），它是对齐 rc.1 要求，不是修 bug。
- **`engines.dsh` 保持 `>=0.2.0-rc.0`**，不收紧。三种写法的 semver 实测（用从 rc.5 asar 里提取的真 semver，`includePrerelease: true`）：`>=0.2.0-rc.0` 在两种 runtime 上都 PASS；`>=0.2.2-rc.1` 只在 rc.1 上 PASS；`>=0.2.0-rc.0 <0.2.2-0` 在 rc.5 上 PASS、rc.1 上 **REJECTED**。写死上界是最坏选择——插件反而会在新宿主上被整层跳过。
- **§0 的引擎判定语义 rc.5 就已经有**：`dsh-app-boot/lib/index.js:251-299` 的 `unmetRequirements` 里，`engines.dsh` 存在即单独决定（`:1099-1102`），否则才回落到 `@deepseek-ai/dsh*` peerDependencies。报告 §11 说「这 54 条在 rc.5 都还没落地」，对 §0 这一条不成立。
- **零命中的关键项**（逐条 `rg`，排除 `node_modules`/`vendor`/`.codewiki`/`.probe-fsoft`/`.agents`）：`MenuTarget`/`useMenuTarget`/`menuTarget`（§6.1 P0 编译期改名，本插件不碰菜单）、`SessionProjectionStateMap`/`EntryTree`/`sessionProjections`（§3）、`assembly.tools`（§2.2 高危静默项——本插件只调 `sp.section({name, order, text})`，从不读 `assembly.tools`）、`dsh-tools` 的 `mode`/`maxParallelSubCalls`/`DSH_TOOLS_MODE`（§2.1 P0，本插件不 import `dsh-tools`）、`schedule_*` 工具（§7.4，本插件自带调度器，不调宿主调度工具）、`apply_patch`/`fs-observation`（§7.1）、`session/attachment`（§8）。
- **`result.tools` 的 7 处命中是误报**：全在 `lib/engine/openai-bridge.js:157` 的 `if (tools) result.tools = tools`，那是 OpenAI 兼容桥自己的响应体，与 `system-prompt/assemble` 的返回值无关。
- **`purpose` 的 112 处命中也是误报**：全是自然语言与变量名，没有一处走 `GenerateOptions.purpose`。

验证（rc.1 真实加载，不是纸面推演）：用 `E:/software/deepseek-harness`（`dsh-v0.2.2-rc.1-28-g0584c790b4`）起隔离实例 `DSH_HOME=E:/tmp/rc1-cw`、profile `cwtest`、端口 63100，`--version` 输出 `0.2.2-rc.1`。
- `--dump-config` 尾部出现 `- id: codewiki / name: '@local/dsh-codewiki'` → bundle 组装成功、engines 判定通过。
- `/api/codewiki/jobs`、`/api/codewiki/repos`、`/api/codewiki/models` 全部 **200** 且返回真实数据；`/api/codewiki/logs` 无 jobId 时 400（预期）。
- 客户端 bundle `GET /plugins/??@local/dsh-codewiki/client.js` → **200，169771 字节**，且被列进页面 HTML 的 client 模块清单。
- 4 个工具（`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`）用 rc.1 的 `assertSupportedJsonSchema` + `assertObjectJsonSchema` 逐个过 **PASS**；rc.1 的 `tools.register()` 新增了对 `output.render` 的存在性检查（`packages/core/tools/lib/index.js:480`），本插件 4 个工具本来就有。
- `installUpdateReminder` 在 rc.1 契约下生成 section `codewiki:update-reminder`、`order=2901`、`text()` 渲染 617 字符且含 `codewiki_generate`；`agent/created` 监听正常挂上。

回归：**40 个测试文件全量 `exit=0`，失败 0**。关键数字：`test-engine-apply-plan.mjs` 62、`test-article-contract.mjs` 33、`test-engine-native-job.mjs` 142/142、`test-engine-native-incremental.mjs` 164/164、`test-job-reliability.mjs` 125/125、`test-engine-quality-gate.mjs` 37、`test-agentic.mjs` 55、`test-article-repair.mjs` 49。

已知未覆盖：`engines.node` 与 `engines.dsh` 在 rc.1 上**只有判定函数层面的验证**，没有在 rc.1 宿主里故意用不合规 manifest 跑一遍拒绝路径；`systemPrompt` 注入验证到 section 生成，没有在 rc.1 的真实对话轮次里确认它进了最终提示词（该路径在 rc.5 上由 `test-batch.mjs` 覆盖）。

## 0.17.49 — 2026-11-05

### 手工维护页整体下线：wiki 内容只由流水线产出

真机上两篇手写 learnings 页积了 22 处失效行号锚点（`test-wiki-anchors.mjs` 347 过 / 22 败全来自它们）：页里写 `normalizeArticlePath` 在 `index.js:321`，实际在 369；`resolveBinary` 写 185-200，实际 233。这类页是唯一不受编译流水线管辖的内容，源码一动锚点就漂，而 `codewiki_generate` 按设计不覆盖手工页，所以重编译永远消化不掉——只能靠人每隔一段时间回去手改，而这正是用户明确不要的维护负担。

- **删除**：`.codewiki/learnings/`（3 篇：`cw-binary-source-lost.md`、`update-reminder-entry-gap.md`、`update-rung-hardcoded.md`）与 `.codewiki/decisions/`（1 篇：`artifact-page-threshold.md`）连同两个空目录一并移除；`lib/wiki-notes.js`（98 行）与 `test-wiki-notes.mjs`（21 条用例）删除。
- **工具下线**：`codewiki_note` 从注册表摘除（`index.js` 的 import、`noteToolDefinition` 整块 95 行、注册数组末项）。可用工具从 5 个回到 4 个。
- **提醒文案**：`updateReminder` 里的「- 例外：本轮真修完了一个 bug 就用 codewiki_note…」整行删除。其余提醒项未改动——「不要手工编写或修改 `.codewiki/` 下的文章」那条 0.17.48 就有，本来就在覆盖这件事，不需要补写。
- **vendor 侧写入口同步改掉**：`vendor/codewiki/skills/codewiki-session.md` 的「After Every Completed Task」第 2、3 条（写 `learnings/`、`decisions/`）与 `vendor/codewiki/src/setup.rs` 里 `CODEX_AGENTS_SECTION` 的同一对要求一并删除，改为「更新受影响文章」。否则 `cw setup` 会把与已删提醒直接矛盾的 MANDATORY 指令重新注入 `~/.claude/skills/` 或 `~/.codex/AGENTS.md`。二进制已按 FORK.md 重编译并同步两处。
- **保留读取侧兼容**：`TYPE_BY_DIR`（`lib/article-contract.js:26-27`）、`ARTICLE_DIRS`（`index.js:1614`）、`wikiRelOf` 的目录表（`index.js:694`）仍含 `learnings`/`decisions`。理由不是「兼容旧数据」，而是 `cw init` 仍会建这两个目录（`main.rs:105-107` 的 `create_dir_all`），而插件在 `index.js:3374`、`index.js:4159`、`lib/engine/apply-plan.js:1277` 三处都调它——新仓库里空目录照建，删掉读取表就等于「目录建出来了，里面的历史页却识别不了」。三处都补了说明这条理由的注释。
- 内容去向：4 篇页里的历史结论（cw 二进制源码丢失的来龙去脉、维护提醒的存在性门控、增量档位写死、artifact 页占比门槛）在对应 modules 页里都有覆盖，剩余只在 git 历史里。

验证：`test-engine-apply-plan.mjs` 62 passed、`test-article-contract.mjs` 33 passed、`test-engine-native-job.mjs` 142/142、`test-engine-native-incremental.mjs` 164/164、`test-job-reliability.mjs` 125/125、`test-wiki-entry.mjs`、`test-orchestration.mjs`、`test-batch.mjs` 117 全通过；39 个测试文件全量 `exit=0`。`test-wiki-anchors.mjs` 由「347 过 / 22 败 / 3 待重编译」变为「2 过 / 0 败」：那 22 处失效锚点全部来自被删的两篇手写页，剩下的 2 条是 `vendor/codewiki/src/main.rs:236-256`（此前不扫 `.rs`，一直漏检）。

## 0.17.48 — 2026-11-05

### 首次编译要先问用户，被排除的仓库不再伪装成失败

三件事，都来自真机：模型在 `dsh-subagent-auto-router` 这类从没建过 wiki 的仓库上顺手调一次 `codewiki_generate`，于是在用户毫不知情的情况下落下几十篇文档并自动提交一次；被排除清单命中的仓库抛出异常，模型把它读成「编译失败」，回头去重试、去排障，白烧一整轮推理。

- **首次编译闸门**：仓库里原本没有 `.codewiki`（`cw status` 判 `missing`）或建了但从未编译（`uncompiled`）时，工具不再提交，改为返回 `submitted: false` + 四行 notes，指名「此仓库尚无 CodeWiki」「首次编译会在仓库里生成整套文档并自动提交一次，需要用户点头」「先问用户，得到同意后显式传 `scope="full"`」。判据看的是**用户原始 `scope`**，不是修正后的 `effectiveScope`——`stale` 遇到无 wiki 的仓库会在上游被自动升成全量，看 `effectiveScope` 等于「凡是以 stale 调进来的都放行」，闸门形同虚设（第一版就是这么写错的，测试直接抓出来）。放行只有两种：`scope="full"`（调用方显式要求全量）与 `confirmed: true`（面板编译按钮，用户本人按下就是确认）。自动调度两条内部路径也都带上了 `confirmed`。
- **被排除的仓库返回终态而不是抛错**：`state: 'excluded'` + notes 三行，明说「此仓库不编译 CodeWiki，命中了用户设置的排除清单（条目 …）」「这是用户在面板上主动排除的，不是编译失败，也不是配置错误——不要重试、不要排障、不要换成其它 scope 再试」「需要为它建 wiki 时请到设置页把目录移出清单」。`submit()` 里的同类抛错保留（那是内部接口，调用方都已提前判过排除）。
- **小仓库不做特殊处理**：`empty-module-tree` 那一类（引擎走 whole-repository 模式、`module_tree.json` 是空对象）维持现状。

验证：`test-orchestration.mjs` 补了 26 处 `confirmed` 并新增「仓库里还没有 CodeWiki：工具不得替用户决定建 wiki」用例（六条断言：不提交、state 如实、notes 含「尚无 CodeWiki」与「先问用户」、零模型请求、`stale` 同样被拦、`full` 放行且跑到 done）；`test-engine-native-job.mjs` 的 stale 升全量用例拆成「先被闸门拦下」+「确认后提交」两段。全量 41 个测试 `fail=0`。

## 0.17.47 — 2026-11-05

### 泄漏页不再卡基线：从「记阻塞」改成「连同残骸一并删掉」

0.17.45 把存量坏文章分成两类：能修的自动修，修不动的（正文就是模型提示泄漏）记一条 `existing-bad-article`，终态降 partial、基线不推进，等人工处理。真机 Wxxy-CampusLogin 立刻暴露了这个设计的代价：58 篇格式坏掉的修好了、30 篇 `concepts/` 清空了，剩下的 2 篇泄漏页把基线钉在原地，整条增量链照样停摆。用户的原话是「不要让我手动删除」。

现在的处置：

- `healExistingArticles` 的判定**提前到轮次判定之前**。判 drop 的页直接并进 `deleteFiles`，于是「无变化 + 只剩泄漏页要清」的仓库从 `idle` 变成 `delete-only`，走正常的删除 + 索引路径。放在轮次之后的话，这类仓库会永远停在 idle，每轮只记一笔阻塞、一页都不删。
- 删掉的页每题都在 notes 里点名，原文只剩 git 历史一份。删之前仍走 `checkDeleteTargets` 的同一把尺子（只许 `.codewiki/`），回滚语义与孤儿页删除完全一致。
- `existing-bad-article` 这个 problem kind 随之退场（`APPLY_RESULT_KINDS` 与 `toApplyBlockers` 里都删掉）。它存在的唯一理由是「不删但要拦住基线」，现在没有可拦的对象了。
- `blockedByExisting` 一票否决一并移除：轮次结束后库里不再有坏页，没有理由再拿它们压住基线。

### 补一条泄漏标记

`压缩对话范围：m01175–m01238 (CodeWiki Update)` 是文章生成器自己的压缩块标题，只出现在喂给模型的上下文里。原来靠 `TASK AS OF THIS BLOCK` 兜住它，但两者是独立来源，缺一条就有整批只带这个标记的页漏过去。新增 `/^压缩(对话范围|范围|上下文)/m`。

### 验证

- `test-article-repair.mjs` 48 → **49 passed**（新增中文压缩块样本）。
- `test-engine-apply-plan.mjs` 两条用例按新语义重写：「内容不可救的直接删掉，不阻塞终态」（断言泄漏页消失、终态 done、基线推进、跑了 `meta update`）、「无变化轮：内容不可救的存量页照样被删掉，基线不动」（断言泄漏页消失、`seq(calls) === ['index']`、基线不动）。**62 passed / 0 failed**。
- 全量回归 41 个测试 **fail=0**。

## 0.17.46 — 2026-11-05

### 进度条收成一条，各阶段按时间占比着色

真机截图里一张完成任务卡有两根条：上面是满格的绿色主进度条，下面是灰绿相间的分段带。信息重复了一次，而主条在终态恒为 100%，什么都没说。

现在只有一根条，它本身就是分段带：

- **段宽** = 该阶段的真实耗时占全部耗时的比例（进行中按进度权重，见 `stageWeight`）。
- **色相** = 阶段身份，从 `STAGE_HUE` 取（准备 196° / 文章 262° / 校验 32° / 索引 152° / 提交 220°），五段彼此可分辨。此前段色表达的是「完成状态」，于是五个阶段全是同一个绿色——用户要的「不同颜色区分截断」根本看不出来。
- **填充宽度** = 段内完成度。所以「这段是什么」和「这段做到哪」不抢同一个视觉通道。
- 最小段宽 3px：真机上准备段常占 99%（06:54 对 790ms），不给保底宽度，`校验 24ms` 会缩成亚像素直接消失——而它恰恰是「这几步都不慢」的证据。

`[data-dscw-p-bar]`（纯色填充条）保留但退成兜底：只有既没有 `stageTimings`、也没进到可计时阶段的老任务才用它。

### 图例文案跟着改

原来写「颜色是阶段状态：绿=已完成，蓝=进行中…」，与新的按阶段着色矛盾。改为「每段一个颜色代表一个阶段，段宽是该阶段真实耗时」。`legendState_*` 四个键保留，仍用于进行中标签的悬停说明。

### 验证

`test-client-panel.mjs` 17 passed / 0 failed，新增两条断言：有分段信息时不得再画纯色填充条、五个阶段色相必须互不相同且图例与分段带同序。测试桩 `render` 此前只序列化 `data-*` 属性，`style` 里的 `--seg-hue` 断言不到，一并补上。

## 0.17.45 — 2026-11-05

### 存量坏文章：从「只记账」改成「先修再删」

0.17.38 加进来的存量体检（`auditExistingArticles`）发现坏页就 `pushProblem('existing-bad-article', …)`，然后由 `blockedByExisting` 一票否决基线推进。当时的理由是「存量页不是本轮写的，回滚会连好文章一起撤掉」——回滚确实不对，但只记账的代价在真机上暴露得很彻底：**七个仓库全部卡在这个状态**，基线最长落后 71 个提交（`dsh-subagent-auto-router` 900ff14 → 67569d5）。下一轮 change-set 从同一个旧基线算起，同一批文件被反复判成「未消化」，增量链断在原地。

而这些页绝大多数只是格式坏了。实测 `Wxxy-CampusLogin` 的 61 篇坏页：缺 frontmatter 20 篇、未闭合 9 篇、`type` 与目录不符 13 篇、正文前粘了一句模型前言 8 篇、正文真的是模型输出泄漏 11 篇。用前四类否掉整条增量链显然不划算。

于是处置分两步：

- **能修的修**。新增 `lib/article-repair.js`，纯函数 `repairArticle(text, rel)` 返回 `keep` / `repair` / `drop` 三态。它认六种可修形态：纯正文（按目录补 `title` / `type` / `source_files: []` / `tags: []`）、frontmatter 未闭合（补上缺失的 `---`）、`--- frontmatter` 这种带词的分隔符、嵌套的 `frontmatter:` 块（展开成顶层）、`type` 与目录不符（改成目录对应的类型）、整篇被包进 ` ```markdown ` 围栏（连同围栏没闭合的情况）。修完的正文一字不动，只动元数据。
- **修不动的删**。判据是「文首是不是模型在跟人说话」：`m00270–m00270 …`、`### Compression of Compressed Context`、`The user wants to…`、`我注意到你提供的…`、`你是 CodeWiki 文章作者`、`I will now update…` 等十六种标记。代码块内的同类文本不算（文章里贴日志、引用对话是正常写法）。

`lib/engine/apply-plan.js` 新增 `healExistingArticles(repoRoot, skipRels)`：走 `auditExistingArticles` 找坏页 → 逐篇读盘 → `repairArticle` 分流。它接在两个位置：正常轮在收集写集时调用（可修的并进 `items`，与文章同批写、同批回滚、同批建索引），无变化轮在 idle 短路前调用（只记账不修——idle 轮刻意不碰索引，否则每次状态查询都会制造 wiki 提交）。`existing-bad-article` 的语义随之收窄：只有 `drop` 那批记阻塞，可修的不再拦基线。

删除目标要排除本轮删除集：给一篇待删的孤儿页补 frontmatter，会让它重新成为「合法页」而被 `deleteTargets` 的 `keepRels` 过滤掉（写优先），残骸就永远清不掉。

### 废弃 `concepts/` 目录

原生通道只产 `modules/` 与根 `CodeWiki.md`，从不写 `concepts/`。该目录是 Node 通道横切层的遗留（从模块页全文再蒸馏一遍「概念」），内容与模块页大面积重复，`source_files` 还指向已删掉的 lib 模块。新增 `findDeprecatedConceptPages(repoRoot, keepPages)` 整目录清理，不看模块树——整仓模式下 `liveTree` 为 null，正是这些孤儿最没人管的时候。`learnings/` 与 `decisions/` 不在清理范围：那是人工维护的诊断记录与设计取舍。

### 模块页残留判据收成一条

`findStaleModulePages` 此前有三条可证特征（`title` 等于 slug / 落在 `modules/` 子目录 / `source_files` 部分幸存），每加一条就多一类旧页能绕过：真机上先后漏掉三批（描述性 title 如 `apply_plan（阶段 3 落地器）`、平铺在 `modules/` 根下的 11 篇、`source_files` 只剩附属文件没被覆盖）。现在反过来：`modules/` 是引擎的专属产物目录，**只要页名对不上当前模块树就删**，不逐条证明「它像旧页」。嵌套目录里的页即便 slug 与 live 模块同名也删（原生页永远 flat，旧树按子模块命名目录会撞 slug）。`findSupersededLegacyPages` 保留，职责收窄为「标注这篇页的代码现在归谁」，供运维决定要不要从 git 历史里捞回来。

### 代码块里的链接示例不再判死链

`lib/engine/output.js` 的 `relativeLinks` 直接在原文上跑 `\[..\](目标)` 正则，没有掩蔽代码。本仓库的文章讲「扫两种链接形态」时把 `[文字](x.md)` 写进行内代码当示例，于是被当成真链接去解析，目标页不存在 → `dead-link` → 整轮从 done 掉成 partial（真机 `job-mw32wsci-h`：`[dead-link/product] article_validation_and_contract.md 链接到 x.md，但该页不在本次产出里`）。

改成先 `stripCode` 再取链接。`stripCode` 是等长替换，匹配偏移与原文一一对应，不影响同一条链路上 `rewritePageLinks` 的原位改写；文章里贴真实链接仍照常校验。

### 验证

- 新增 `test-article-repair.mjs`，48 条断言：六种可修形态各自修完必须过同一套契约（`inspectArticle` 零 error）、六类泄漏标记必须 `drop`、代码块内的施工文本不判泄漏、合规页 `keep` 时一字不改、目录推不出 type 时不动。
- `test-engine-apply-plan.mjs` 62 passed（原 61，新增 `concepts/` 清理用例）；`test-engine-native-incremental.mjs` 164 passed（用例 16 的断言按新判据改写：`modules/` 下页名对不上树的页全删，`learnings/` 下的人工页保留）。
- 全量回归 41 个测试（含 6 个真 venv）`FAILED: 0`。
- 六仓实测 `healExistingArticles`：可修 62 篇**修完全部过契约**（Wxxy-CampusLogin 58、dsh-git-worktree 2、dsh-presets-Switch 1、dsh-subagent-auto-router 1），`drop` 3 篇（全部确认是提示泄漏）。`findDeprecatedConceptPages` 命中 Wxxy-CampusLogin 30 篇、Wxxy-CampusHub 2 篇、dsh-presets-Switch 4 篇。

## 0.17.44 — 2026-11-05

### 语义校对：从「从不触发」到真能触发

审计时查了 30 个任务的 `stageTimings`，**没有任何一个任务有 `proofread` 计时**；notes 里搜「校对」「死链」也是零命中。0.17.41 把校对从面板上并进了校验，说明它是「质量门死链检查的修复动作」——但这个动作在真机上从未发生过。

第一层原因看着像「判据太严」，实测后是另一个：本仓库 19 篇模块页有 128 条跨页链接（18/19 篇都有），逐页算失效链接数是 **0**。Wxxy-CampusHub（46 页）、Wxxy-CampusLogin（57 页）同样是 0。FSoft 写的链接全部有效，`deadLinkSources` 返回空是正确结果。

真正的断点在链路中间，两处：

1. **契约层判出的死链认不出来。** 引擎原始页走 `lib/engine/output.js` 报 `kind: 'dead-link'`；落地后的 wiki 页走 `lib/article-contract.js` 报 `dead-link`，但 `lib/engine/quality-gate.js:619` 把它统一压成 `kind: 'article-contract'`，真实类别只留在 `issue` 字段。`deadLinkSources` 只认 `p.kind === 'dead-link'`，于是这条路永远进不了校对。

2. **`[[词条]]` 形态的死链根本不算引用。** 渲染期的 `rewritePageLinks(..., { dropUnresolved: true })` 只降级 `[文字](x.md)`，`[[ghost]]` 原样保留。实跑验证：`正文引用 [[ghost]] 与 [链接](gone.md) 与 [正常](core.md)` 渲染后是 `正文引用 [[ghost]] 与 链接 与 [正常](core.md)` —— `[链接]` 被降级成纯文字，`[[ghost]]` 留着。而 `article-contract` 的 `collectWikiLinks` 认 `[[...]]`，于是它被判成死链、改名成 `article-contract`、然后被第 1 条挡住。

两处都修：

- `deadLinkSources` 判据改为 `p?.kind === 'dead-link' || (p?.kind === 'article-contract' && p?.issue === 'dead-link')`，JSDoc 写明为什么有两个来源。
- `missingLinksOf` 重写：先 `stripCode` 剥掉代码块（围栏里的 `[[词条]]` 是语法示例，不是引用），再用 `scanPageLinks` 收 `[文字](x.md)`、用 `\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]` 收 `[[词条]]`。词条形态按 wiki 约定省略 `.md` 后缀，所以裸目标和 `目标.md` 都算命中已知页。

补测试：

- `test-engine-proofread.mjs` 新增 3 条（契约层死链要认、`[[词条]]` 与 `[文字](x.md)` 双形态、代码块里的词条不算引用）→ **16 passed / 0 failed**（基线 13）。
- `test-engine-proofread-e2e.mjs` 新增用例 4，假引擎加 `wikilink` 模式（`overview.md` 正常链向 `core.md`，`core.md` 正文用 `[[ghost-entry]]` 链到不存在的词条），断言校对提示里点出 `ghost-entry`、改写后 `[[core]]` 落盘、`ghost-entry` 不残留、notes 有记录 → **17/17 通过**。

顺带确认：这份端到端用例不能把死链放在 `overview.md` 里。入口页不走 `mapped.articles` 循环，只做 `bodyLength` 与围栏配对两项检查（`quality-gate.js:555-563`），它的死链根本不参与契约判定。第一版就栽在这里——断言全红，而产物确实没被检查过。

### 验证

- `node test-engine-proofread.mjs` → 16 passed / 0 failed
- `node test-engine-proofread-e2e.mjs` → 17/17 通过
- 40 个测试全量回归全绿（含 6 个需要 `.probe-fsoft/venv` 的）

## 0.17.43 — 2026-11-05

### 增量档位与阈值可配

原生通道把「增量怎么做」整条交给 FSoft updater，插件侧只写死 `rung: '3'`。上游五个档位（`0`/`1`/`2`/`3`/`3b`）与十几个阈值因此一个都碰不到：怀疑增量判错、想退回全量、想放宽 growth 门槛，都只能改源码。

新增设置项（面板「增量策略」section）：

| 设置 | 取值 | 说明 |
| --- | --- | --- |
| `updateRung` | 空（上游默认 3）/ `3` / `3b` / `2` / `1` / `0` | `3b` 多跳一层（`k_hop=2`）；`2` 关掉叶子页自改；`1` 关掉路由/重聚类/UP/叶子补丁/关联补丁/陈旧扫描/归属闭包；**`0` 不是最弱的增量，是放弃增量——上游见到 0 直接跳过整条增量分支，本轮按全量重写** |
| `updateTauNb` | 0–1 | 新边界采纳阈值（上游默认 0.5） |
| `updateTauGrow` | 0–1 | 增长重聚类阈值（上游默认 0.33） |
| `updateTauFull` | 0–1 | 全量重建判定（上游默认 0.5） |
| `updateTauTree` | 0–1 | 树级重建判定（上游默认 0.3） |

四处接线：`Config` 增字段 → `liveConfig` 透出 → `updateOptionsOf(cfg)` 在 `submit` 时就校验（非法档位在提交时抛错，不等引擎子进程起来）→ `startNativeRun` 的 `deps.updateOptions` 交给 `native-run.js` 合进引擎请求的 `updateOptions`。

`rung=0` 在 `native-run.js` 决议阶段就翻译成 `RESOLUTION.FULL`，并记一条 note。**不挂 `incremental-fallback` blocker**——那是「增量判失败退回全量」的记账，用户主动选的全量不该算降级。

`test-config.mjs` 新增 7 条（空配置不下发任何键 / 3b 透传 / 0 透传 / 阈值字符串转数字 / 越界不写入 / 非数字不写入 / 非法档位报错且消息含可选值）；`test-engine-native-incremental.mjs` 新增用例 18（`rung=0` 时 `resolution === 'full'`、引擎侧 `update` 动作出现 0 次、blockers 不含 `incremental-fallback`）。163/163 通过。

### learnings / decisions 终于有写入路径

mraza007/codewiki 的技能约定「After Every Completed Task」要求修完 bug 写 learning、定了设计写 decision。原生通道只产模块页与入口 `CodeWiki.md`，这两类目录一直没有生产者——0.17.39 把系统提示里的假承诺删掉了（原先写着「由流水线完成」），但没有补上真实现。

新增工具 `codewiki_note`（`lib/wiki-notes.js` 承载拼装与校验）：

- `kind=learning` → `.codewiki/learnings/<slug>.md`；`kind=decision` → `.codewiki/decisions/<slug>.md`
- 落盘前用与编译流水线**同一套**契约校验（`inspectArticle`），不通过直接报错且不写盘
- 写完自动 `cw index` 刷新索引；仓库没有入口时顺带生成 `CodeWiki.md`
- 章节口径：正文必须含非空的 `## Overview`（`REQUIRED_SECTIONS.learning/decision`）
- **`allowEmptySourceFiles: true`**：空的 `source_files` 对这两类页是合法形态（「选了 A 不选 B」不必然指向某个文件），且存量体检本来就放行——写入闸门若拒，就会出现「写的时候拒、下一轮体检放行」的自相矛盾

这两类页由模型手动维护，编译不覆盖；孤儿页清理的三个判据（`findOrphanPages` / `findStaleModulePages` / `findSupersededLegacyPages`）都只扫 `modules/`，不会误删。`reminderText` 里补了对应例外条款。

新建 `test-wiki-notes.mjs`（21 条）：slug 保留 CJK、frontmatter 字段形态、空数组显式写出、Overview 空判 `empty-section`、source_files 不存在判 `missing-source`、内部链接死链、type 与目录不符、`listWikiPages` 只列 `.md`。

真机验证：对本仓库各写一篇（`learnings/update-rung-hardcoded.md`、`decisions/artifact-page-threshold.md`），`cw index` 从 21 篇涨到 23 篇，`## Decision` / `## Learning` 两段都正确收录。

### artifact 独立页：不是未接入，是占比门槛未触发

审计里把「19 篇模块页没有一篇独立 artifact 页」记成缺口，实测后纠正：`ensure_artifact_module` 的门槛是 `ARTIFACT_MIN_SHARE = 0.8`——聚类 LLM 漏掉不到 20% 就原样返回。本仓库 3 个 artifact 节点（`package.json`、`cordis.patch.yml`、`tools/fsoft-engine/setup-env.sh`）全被正确归类，share=100%，函数在第二个判断就 return 了。依赖图节点、`artifact_index.json`（200k 预算 / 3083 用量 / 3 节点 20 边）都在正常工作。

用真实入口函数实跑三个分岔确认：漏得多且 token ≥ `DEFAULT_MIN_TOKEN_PER_MODULE`（1000）→ 插顶层模块 `Build, Deployment and Configuration`；漏得多但 token 不够 → 并进最近叶子；没漏 → 原样返回。结论写进 `decisions/artifact-page-threshold.md`，改代码是错的。

### 文档残留

- `CodeWiki.md:52` 旧 Node 通道分支补上 `→ commit`（原写 `queued → articles → crosscut → review → index`，漏了最后一个阶段）
- `codewiki_progress` 的 stage 枚举改为「进行中：`queued`/`prepare`/`articles`/`crosscut`/`review`/`validate`/`index`/`commit`；终态：`done`/`partial`/`failed`/`cancelled`」（原只列终态与部分进行态，漏 `prepare`/`validate`）
- `nativeStage` 描述从「八段契约阶段」改为九段并补 `proofread`，注明该段只在有失效跨页链接时才出现

## 0.17.42 — 2026-11-05

### 面板：任务结束后显示各阶段真实耗时

此前任务一结束，阶段分段带整条不画，只剩一根绿色满格进度条。耗时数据一直都在（`setStage` 每次切阶段都把上一段耗时累加进 `job.stageTimings`），是渲染层把它关掉了：调用点写的是 `active && pct > 0 ? stageSegments(job) : null`。

改为终态也画，段宽口径随状态切换：

- 进行中仍用 `STAGE_WEIGHTS`（进度权重，与总进度条同口径），图例读数是百分比。
- 终态用 `stageTimings` 的真实毫秒，图例读数换成 `fmtMs` 的结果，百分比降级到悬停。悬停是给想复盘的场合留的，主读数应该是「时间花在哪一步」。
- 终态**刻意不依赖 `pct`**：失败与取消的任务总进度是 `null`，而这两类恰恰最需要看时间分布。
- `queued` 在两种带子里都返回 0 宽度。排队是等别的项目跑完，不是编译干了什么；真机上它常比整个编译还长（`job-mw2ymhxw-5` 排队 4:17、阶段合计 0:10），画进去会把真正的阶段全压成细线。排队时长在上方用时行里单独报。
- `fmtMs` 补亚秒分支（`< 1000` 直接给 `NNNms`）。索引、校验、提交常是几百毫秒，原来的 `00:00` 等于没有读数。
- 没有 `stageTimings` 的历史任务不画耗时带，退回原来的空态，不会显示一排 `00:00`。

真机读数示例（本仓库）：

| 任务 | 准备 | 文章 | 校验 | 索引 | 提交 |
| --- | --- | --- | --- | --- | --- |
| `job-mw2zcr1p-7`（no_change 轮） | 03:46 | 813ms | 33ms | 00:02 | 00:03 |
| `job-mw2x5yw7-6`（写 7 篇） | 03:31 | 07:31 | 30ms | 00:01 | 14ms |
| `job-mw2ymi71-6`（只删旧页） | 00:05 | 922ms | 18ms | 00:03 | — |

`prepare` 占大头是真实开销，不是记账错位：FSoft 的 `build_dependency_graph()` 在 `doc_generator.py:223` 同步跑完 654 个组件、16 种语言的解析，`start_stage(2, "Incremental Update")` 直到 `:436` 才调。增量轮复用阶段 1 的槽位跑全程，所以这段全记在依赖图阶段。

### 验证

- `test-client-panel.mjs` **17 passed / 0 failed**（基线 14）：新增终态耗时读数、老任务不画带、进行中仍读百分比三条。
- 39 个测试全绿（含 6 个需要 `.probe-fsoft/venv` 的）。

## 0.17.41 — 2026-11-05

### 面板：校对并进校验，七步收成六步

`proofread`（语义校对）与 `validate`（质量门）在面板上是两个并列步骤，名字都像「检查」，看着像同一件事做了两遍。实际流程是检测→修复→复检：质量门纯确定性判产物（frontmatter、source_files、基线、入口契约），校对只针对质量门报出的死链源页调模型改正文，改完再跑一次质量门。

职责不同，但不该占两格。两者合并成一个 `validate` 步骤：

- `client.js` 的 `ACTIVE_STAGES` 去掉 `review`，`LEGACY_STAGE` 把历史任务的 `review` 折回 `validate`（不折的话 `indexOf` 得 -1，失败/取消时整条步骤条熄灭、看不出卡在哪）。
- `NATIVE_TO_STEP` 与 `index.js` 的 `NATIVE_STAGE_TO_PANEL` 都把 `proofread` 映射到 `validate`，两侧算法保持一致。
- `STAGE_WEIGHTS` 从 `{prepare .24, articles .46, review .14, validate .07}` 合并为 `{prepare .24, articles .46, validate .21}`——校对在大仓库上要逐页调模型，权重不能只按质量门的 .07 算。
- 细分阶段名没丢：`NATIVE_STAGE_KEYS.proofread` 仍在，活动流里照样显示「语义校对」。面板并列的格子没了，日志里的信息还在。

### 被取代的旧页改为自动清理

0.17.40 把「源码已被当前树接手、但页名对不上任何模块」的旧页做成只报告不删，理由是它们含人工维护内容（真机 Wxxy-CampusHub 的 11 篇各有 4~20 次人工提交）。用户明确要求不要留待办清单：索引干净比保留过期页重要。

改为进删除集，与孤儿页、残留页同批走落地器事务（`deleteFiles` → pre-image → 可回滚 → 同一个 commit）：

- `findSupersededLegacyPages` 的语义从「只报告」改为「进删除集」，JSDoc 同步改写。判据不变：页名不在树里 + 无 `fsoft_page` + 至少一个 source_file 已被当前树某模块认领。
- `native-run.js` 把结果并入 `deleteFiles`，notes 里逐篇点名**接手它的源码路径**（`campus-auth.md（→ crates/campus-auth/src/cas.rs）`），并提示原文见 git 历史。删后要捞回来，按这条路径查历史即可。
- 保护边界没动：`decisions/`、`learnings/`、`concepts/` 这些非模块页不在扫描范围（只看 `modules/`）；没有模块接手其源码的页（source_files 全不被认领）仍然保留。

真机复验（Wxxy-CampusHub）：11 篇全部进删除集，每篇都带接手路径；`decisions/` 14 篇、`learnings/` 29 篇、`concepts/` 2 篇一篇未动。

### 验证

- `test-engine-apply-plan.mjs` 59 passed / 0 failed；用例改名并补断言，明确「进删除集 + 报出 coveredSource」是现在的契约。
- `test-engine-native-incremental.mjs` **159/159**。用例 16 的人工页 fixture 改成 `source_files: notes/handbook.md`（存在但无模块认领）——保护它的是「没有别的模块接手它的源码」，而不是「title 看上去不像 slug」：真机上旧通道页的标题同样常带括号描述。
- 39 个测试全绿（含 6 个需要 `.probe-fsoft/venv` 的）。`test-client-panel.mjs` 14 passed、`test-config.mjs` PASS。
- `test-wiki-anchors.mjs`：**369 过 / 0 败 / 3 待重编译**。两篇 `learnings/` 的锚点随 `index.js` 增长（5098 → 5100 行）漂移 7 处，已逐条按符号当前位置对齐——learnings 是人工产出、`codewiki_generate` 不重写，只能手工修。

真机复验（Wxxy-CampusHub，重启宿主后）：`job-mw2ymi71-6` 一轮删掉 11 篇旧页，提交 `efa8ccb` 恰好 12 个文件（1 个 `_index.md` + 11 个 `D`），索引里的模块条目从 102 降到 46，与磁盘 46 篇一致。`decisions/` 14 篇、`learnings/` 29 篇、`concepts/` 2 篇零变化。

## 0.17.40 — 2026-11-05

拿真实项目（`Wxxy-CampusHub`，254 个文件、80 Rust + 47 TSX，从 9 月底的旧 Node 通道产物起飞）全量编译了一遍，逼出两个 0.17.39 没覆盖到的问题。

### 自动提交失败时只报 git 警告，真正的错误被挤出可视窗口

`commitWikiArtifacts` 用 `(add.stderr || add.stdout).trim().slice(0, 200)` 当失败原因。Windows 上 `git add` 会先打一串 `warning: in the working copy of '...', LF will be replaced by CRLF`，200 字全花在这些警告上，真正的 `error: open("CodeWiki.md"): Permission denied` / `fatal: adding files failed` 一个字都看不到——排查时只能靠猜。

改为新增 `errText(r)`：优先取 `/^(error|fatal):/i` 开头的行，取不到才退回原文，上限放到 400 字。`git add` 与 `git commit` 两处失败都改用它。

（这次真机撞到的具体成因是 `CodeWiki.md` 的 Windows ACL 只剩一条陌生 SID 条目，`git add` exit 128。ACL 与代码无关，已单独修好；代码侧要修的是「别把警告当原因」。）

### 旧格式页的第三条判据：报告，不删除

0.17.39 给旧通道页加了两条判别式（`title` 等于 slug / 落在 `modules/` 子目录）。真机上还有第三类：标题写成「CAS 协议核心（campus-auth）」这种描述性名字（第一条不中），平铺在 `modules/` 根下（第二条不中），而 `findOrphanPages` 要求 source_files **全部**失效，这几篇只缺一两个 `NOTICE.md` / live 测试文件（第三条也不中）——三个判据同时擦肩而过，11 篇旧页原地留存。

第一版把「任一 source_file 已被当前树认领」也做成**删除**判据，真机精度确实是 11/11（`campus-auth` ← `crates/campus-auth/src/cas.rs`、`frontend-shell` ← `tauri-app/frontend/src/App.tsx`……）。但随即发现这 11 篇各有 4~20 次人工提交（`campus-hub-tauri` 20 次、`frontend-shell` 15 次），正文里是人工补的迁移警告、行号更正和 `[[decisions/...]]` 交叉链接——它们是**人工维护的知识页**，只是 slug 恰好撞上旧聚类。自动删就是凭页名毁掉用户手写的内容。

所以拆成两个函数：

- `findStaleModulePages`（进删除集）保留两条判据，删掉第三判据；
- 新增 `findSupersededLegacyPages`（只报告，不进删除集），判据是「slug 不在树里 + 无 `fsoft_page` + 至少一个 source_file 已被当前树别的模块认领」，返回命中的那个文件作为「被谁接手」的证据。

`native-run.js` 把它接进 notes：「有 N 篇旧页的源码已被当前模块树接手，但页内含人工维护内容，未自动删除（需人工决定合并或移除）：…」。删除权留给人。

### 校验

- 39 个测试全绿（33 个非 venv + 6 个 venv 全跑）：`test-engine-apply-plan` 59 条、`test-engine-native-incremental` 159 条、`test-engine-native-job` 141 条、`test-wiki-anchors` 369 过 / 0 败 / 3 待重编译。
- 真机双仓验证：`Wxxy-CampusHub` 自动删除 **0** 篇、仅报告 **11** 篇（每条都带接手源码）；`dsh-codewiki` 自动删除 0 篇、仅报告 0 篇。
- `Wxxy-CampusHub` 全量编译结果：基线 `124863b3` → `ac7bdcbb`（=HEAD），`modules/` 11 篇 → 57 篇，9 个顶层模块覆盖 134 个源文件，`_index.md` 收录 102 条。
- 两篇 `learnings/` 的锚点随代码前移再对齐一次（`normalizeIndexLinks` 落到 `index.js:325-333`、`installUpdateReminder` 落到 `index.js:4933`）。

## 0.17.39 — 2026-11-04

全仓审计后的收口：修掉让基线永不推进的死锁、让换通道后的残骸页永远堆积的判据缺口、以及一整批「文档说的事代码里没有」。另外把旧 Node 通道遗留的横切产物（`_architecture.md` / `_patterns.md` / `concepts/`）整体下线——它们描述的是 0.16.0 已删除的规划层。

### 基线死锁：脏工作区不再一票否决基线

**症状**：连续 6 轮原生编译全部落 `partial`，blocker 恒为同一条 `[quality-gate] [uncommitted-input/product] 工作区有 22~25 个未提交源码改动…`，`baselineAdvanced` 与 `baselineEligible` 全 false。`_meta.yaml` 的 `last_compiled_commit` 停在 `17c43b7b`，而 HEAD 已经到了 `a370691a`——**产物每轮都被自动提交，只有基线不推进**，于是 `cw status` 永远 stale，`stale` 范围下每轮都在重写同一批页。

**根因**：`native-run.js` 早就把工作区快照的 SHA 传给了质量门（`consumedInputCommit`），但门里只把它用于**绕过 commit-mismatch**（`art !== headCommit && art !== consumed`），`uncommitted-input` 那条分支完全不看它。于是「脏工作区 → 合成快照 → 产物对得上快照 → 仍然报缺陷」这条闭环谁也走不出去。

**修法**：不放松 `baselineEligible = outcome === 'done'`（0.16.1 的教训是让 partial 偷偷推进，等于把没消化完的变化记成已消化），而是让**脏工作区在快照成立时不再产生缺陷**：

- `quality-gate.js` 的 `assessBaseline` 新增 `consumedInput` 返回值。脏工作区的分支改成：`consumed` 有效且产物 commit 恰等于 `consumed` 时，把脏路径收进 `consumedInput = { commit, paths }` 并**不 push defect**；只有「脏但没被快照覆盖」（`!consumed || art !== consumed`）才照旧报 `uncommitted-input`。
- `gateNativeOutput` 把 `consumedInput` 透传进 report 的 `baseline` 对象。
- `native-run.js` 在 validate 段之后落一条可见的 note：「本轮把 N 个未提交源码改动一并写进产物（快照 xxxxxxxx）：paths…」。**吞下脏改动是事实，必须在面板与日志里看得见**，否则「基线推进了」和「悄悄忽略了你的改动」在外部无法区分。
- 未消费的变化仍由 `_native-state/state.json` 的 `unconsumed` 跨轮携带（只有出现在下一轮 `committed` 里才算消化），所以放行脏工作区不会丢变化。

`test-engine-native-incremental.mjs` 原有用例断言的正是旧行为（stage ≠ done、基线不推进、blockers 含 uncommitted-input），已改写成新语义，并补一条「notes 必须点名吞下的改动」。`test-engine-quality-gate.mjs` 的旧用例不传 `consumedInputCommit`，仍然成立，无需改动。

### 残骸页：判据只认新格式，旧格式页永远删不掉

**症状**：模块树 19 个节点、磁盘 `.codewiki/modules/` 45 篇、`_index.md` 收录 46 条——26 篇是历史残骸，新旧页在索引里并存（`engine_core` 与 `engine-core` 各一条）。`findStaleModulePages` 与 `findOrphanPages` 对它们**都返回 0**。

**根因**：两个判据都只认本引擎写的新格式。`findOrphanPages` 要求 `source_files` **全部**失效才算孤儿，而残骸页的 `source_files`（`lib/agentic.js`、`index.js` 等）全都还在；`findStaleModulePages` 要求 frontmatter 有 `fsoft_page`，残骸页一个都没有，于是被当成「人工页，一律不动」。

**修法**：`findStaleModulePages` 在「无 `fsoft_page`」分支里补一条旧格式判别，命中任一条即可：

1. `title` 恒等于自己的文件名 slug（旧通道的 frontmatter 模板就是 `title: <模块名>`）；
2. 落在 `modules/` 的**子目录**里——原生通道的模块页永远是 flat（映射只产出 `modules/<slug>.md`，metadata 里 `layout: flat`），嵌套只可能来自旧通道。

再叠加两道闸（`type: module`、`source_files` 非空）防止误删人写的内容。真机验证：对本仓库模块树跑该函数，**26 篇命中，全部 `legacy: true`**，名单与人工核对的残骸完全一致。

第 2 条是补真机漏网来的：`modules/engine-apply-output/apply-plan.md` 的 title 是「apply_plan（阶段 3 落地器）」这种描述性标题，第 1 条抓不到，而它在目录里，第 2 条能抓到。这篇页正文写的是 739 行的 `apply-plan.js`，实际源码已经 1335 行。

同步删掉的 27 篇（26 篇顶层 + 1 篇嵌套）已 `git rm`，`.codewiki/modules/` 现在 19 篇，与模块树的 live slug 一一对应；`cw index` 重建后 `_index.md` 无重复、无残骸。

### 横切产物下线

`.codewiki/_architecture.md`（27KB）、`_patterns.md`（24KB）、`concepts/`（9 篇）全部是旧 Node 通道 `tickCrosscut` 的产物，mtime 停在 Node 通道最后一次写入。grep `crosscut` 在本仓库只命中 `index.js`（文案与旧阶段机）和 `native-run.js` 一句性能注释——原生通道**从不写这三类文件**。

内容审计的结论是「留着比没有更糟」：`concepts/wiki-generation-flow.md` 整篇在讲 `lib/cluster.js` + `lib/symbols.js` 的 semanticPlan、`planMode`、`agenticArticles`、`prepareArticleTasks`、`runRealtimeTasks` 双池——这些在 0.16.0/0.17.x 已全部删除；`_architecture.md` 的 96 项 `source_files` 里有 24 项已失效。`test-wiki-anchors.mjs` 修复前报的 26 处锚点漂移**全部**落在这批页上。

已整体删除，并同步修掉三处仍指向它们的引用：

- `index.js` 的 `ensureWikiEntry` 生成文案（原指向 `_architecture.md` 与 `concepts/`，原生通道永不产出）；
- `index.js` 的 `reminderText`（原承诺「learnings/、decisions/ 补文章与索引刷新均由流水线完成」，而全库没有任何代码向这两个目录写文章，`decisions/` 目录根本不存在）；
- `README.md` 的 `updateReminder` 条目同款假承诺。

架构总览的替代品本来就有：引擎每轮重写的 `overview` 页；模块级结构表达由模块页内的 mermaid 图承担（45 篇里 20 篇有图）。仓库根 `CodeWiki.md` 也已重写：原内容停留在 0.10.x 的 Node 通道（`prepareArticleTasks`/`sessionTier`/`localPlan`/`workbuddy`/`hy3`），现在是当前原生通道的速查。

### 文档债与死代码

- `requestLimit` 的默认值在三处口径不一：`DEFAULT_REQUEST_LIMIT = 100`、`index.js` 的 description 写「默认 300」、`client.js` 面板 `?? 300`。统一为 100（上游默认值），并说明 300 是「先全部改回上游逻辑验证」之前的临时值。
- 删除 `index.js` 里连续两个 `return result` 的重复死代码。
- `.codewiki/learnings/` 两篇（`cw-binary-source-lost.md`、`update-reminder-entry-gap.md`）的 17 处 `index.js:NNN` 锚点随代码前移全部漂移，已逐条按当前符号位置重定位。这两篇是人工产出的，`codewiki_generate` 不会重写 `learnings/`，所以只能手工对齐。
- 大档（`bigEnabled`/`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`）在原生通道 grep 零命中——原生通道的输入预算由 FSoft 引擎按模块切分，不经这一档；`llm-bridge` 的模型在桥启动时就固定了，`body.model` 只用于记账，没法在请求级切档。**没有凭空接线**（那要改上游引擎的请求路由），改为在 Config 描述与设置页提示里诚实标注「仅 Node 兼容通道生效」。

### 验证

- **33 个不依赖 venv 的测试 + 6 个需要 `.probe-fsoft/venv` 的测试，共 39 个全部 exit 0。** 后者（`test-engine-output-real` / `test-engine-python-entry` / `test-engine-quality-gate` / `test-fsoft-coverage` / `test-fsoft-runtime` / `test-upstream-parallel`）此前长期被跳过，这次用 `DSH_CODEWIKI_PYTHON=.probe-fsoft/venv/Scripts/python.exe` 真跑了一遍：11 / 24 / 37 / 6 / 6 / 11 条断言全过。
- **真机验证基线放行**（`assessBaseline` 对真实仓库，28 个未提交改动）：
  - 不传 `consumedInputCommit` → `defects: ['missing-metadata', 'uncommitted-input']`（旧行为不变）；
  - 传快照 `c9987fba` 且产物 commit 等于它 → `defects: []`，`consumedInput` 收下 28 条路径；
  - 传快照但产物 commit 不匹配 → `defects: ['commit-mismatch', 'uncommitted-input']`（没被快照覆盖的照旧拦）。

  三态都对，说明放行有明确边界，不是无脑跳过。
- **真机验证 cw 侧闭环**（临时仓库）：`cw init` → `cw meta update` → `cw status` 报 `Wiki is up to date.`；工作区脏但未提交时 status 仍是 up to date（cw 只看已提交历史，符合预期）；提交后 status 才列出变更。这印证「基线推进后 stale 自动消解」这条链路本体没问题——之前卡住的是插件侧不推进，不是 cw 判错。
- `test-wiki-anchors.mjs --strict`：**369 过 / 0 败 / 3 待重编译**（修复前 59 败）。两篇 `learnings/` 的锚点行号已随代码前移逐条对齐。
- `findStaleModulePages` 真机命中 26 篇残骸，全部 `legacy: true`。

## 0.17.38 — 2026-11-04

原生通道有了存量体检：库里躺着的坏文章不再只有被重写时才可能被发现。顺带修掉九处「判据与事实脱节」的缺陷，以及契约层把无扩展名文件一律判成坏源文件的老误判。

### 存量体检：坏文章不再依赖「恰巧被重写」

Node 通道的 `tickIndex` 一直在扫全库（`index.js` 的 `auditExistingArticles`），原生通道却没有这一步：落地器只比对「本轮写集 vs `_index.md` 实收」，再加上删孤儿页。于是没被重写的存量坏文章永远发现不了，`_index.md` 也永远缺一条——`cw index` 对 frontmatter 写坏的文章是静默跳过的，退出码照样 0。

现在 `lib/engine/apply-plan.js` 导出 `auditExistingArticles(repoRoot, skipRels)`，在索引段的缺页校验之后、基线之前跑：

- 递归扫 `.codewiki/`，只取 `.md`，相对路径以 `_` 开头的整棵子树跳过（与 `vendor/codewiki/src/main.rs` 的 `rel_str.starts_with('_')` 同一条规则，所以 `_index.md`、`_native-state/`、`temp/` 不会被误扫）。
- `skipRels` 传本轮裁决里的页（写集 + `report.rendered` 的 `wikiPath`），已经由质量门判过的页不重复上报。
- 口径与 `checkRendered` 完全对齐：`fsImpl: null`、`allowedLinks: null`、`requiredSections: []`、`allowEmptySourceFiles: true`、`expectedType: null`（让目录推断生效）。带 `fsImpl` 会额外判 `missing-source`，本仓库实测会多报 12 篇——那些多数是「引用了早已删除的文件」的真实缺陷，但把它们塞进同一个闸门的结果是终态永远 partial、基线永不推进，闸门退化成噪声。源文件存在性仍归 output 侧的 `source-missing` 管。
- 命中则 `pushProblem('existing-bad-article', …)`，**不触发回滚**：存量坏页不是本轮写的，回滚会连本轮的好文章一起删掉。它只让终态落到 partial、让基线一票否决（`blockedByExisting` → `shouldAdvance = false`，`baseline.reason = 'existing-bad-article'`）。

配套修了同一条链上的两处：

- **契约层误判**：`lib/article-contract.js` 的 `isRepoRelativeFile` 末行原本是 `return path.posix.basename(s).includes('.')`，凡是文件名不含点的合法文件（`Dockerfile`、`Makefile`、`LICENSE`）一律被判 `bad-source`。本仓库的 `_architecture.md` 与 `modules/fsoft_fixtures.md` 就因此常年被判坏——它们引用的是真实存在的 `tools/fsoft-engine/fixtures/中文 空格 fixture/Dockerfile`。去掉了扩展名判据，目录判定交给前面的 `endsWith('/')` 与后面的越界检查。
- **索引缺页正则**：`findArticlesMissingFromIndex` 原本用 `/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g` 整条匹配，`cw` 写进索引的 title 是原文照搬，一旦标题含 `]` 就整条漏匹配，合法页被判缺页 → 整批回滚，而且重跑也一样。改成逐行找 `[[`、按 `]` 或 `|` 截断取路径段。

### 九处判据与事实脱节

都是「闸门在，但判的不是那件事」这一类。

1. **partial 会推进基线**（最严重）。`native-run.js` 原本传 `advanceBaseline: stateIncomplete ? false : null`，`null` 的含义是「交给 `report.canAdvanceBaseline`」，而质量门里的 `baselineEligible = outcome === 'done'` 只看产物质量、不知道引擎有失败叶子。于是引擎 partial + 门 done 时基线照常前移，终态却是 partial——下一轮从新基线算变化集，那批没写完的变化永久失明。现在 `engineOutcome !== 'done'` 也一起否决。
2. **已落地的轮次被报成 cancelled**。落地器全程不接 signal，取消却无条件把终态改写成 cancelled，于是已提交、已推进基线的那一轮在结果里变成「产物未落地、基线未推进」。现在取消分支加前提 `applyRes?.applied !== true`，并让 `index.js` 的 `applyDeps.runCw` 不再透传 signal——原来取消会 kill 掉正在跑的 `cw meta update` 并触发回滚，一次取消吞掉一整轮成果。
3. **`canAdvanceBaseline` 恒为 false**。settle 的兼容字段读 `patch.baselineAdvanced`，而 19 个业务分支一个都没传过它。现在成功路径补 `baselineEligible` 与 `baselineAdvanced` 两个字段，各有独立来源。
4. **回滚快照把读失败当「文件不存在」**。`capturePre` 的 catch 原本把非 ENOENT 也记成 `exists = false`，回滚时 `restorePre` 会 `unlinkSync` 真删掉用户文件。现在非 ENOENT（`EISDIR` 除外，目录形态的 `_index.md` 是测试用来制造 index 失败的，必须容忍）一律抛。
5. **裁剪根可穿透删源码**。`collectPruneTargets` 的白名单只做字符串前缀比较，`.codewiki/../src` 能穿过；改用与写集同一套 `checkTargetPath`（normalize + 判 `..`）。
6. **merge commit 下越界检查被洗白**。`defaultVerifyCommit` 跑的是 `git show --name-only --pretty=format:<sha>`，对 merge commit 输出空清单，越界检查于是 `ok: true`；补 `--first-parent`。
7. **dryRun 在 idle 轮被跳过**。无变化 + dryRun 时返回 `applied: true`，与「没有落任何盘」相反。
8. **索引收录校验只看本轮写了什么**。`writeAll` 把「内容相同」与「仅行尾差异」的页归入 unchanged 不重写，这些页逃过 `findArticlesMissingFromIndex` 的检查；改用完整写集。
9. **同一磁盘状态的三种口径**。`native-run.js` 的完整性检查 catch 里只 `notes.push` 后继续走增量，而同文件对同一个 `module_tree.json` 又规定「ENOENT 才吞、JSON 损坏必须抛」。现在 `SyntaxError` 一律判 `engine-output` 失败。另外 `manifest.js` 的 `compareLock` 在 lock 缺失时早退，绕过了后面的 `pipCheckOk !== true` 判定；把 pip check 提到前面、`absent` 也照样判 unhealthy。`client.js` 的 `flushProgress` 也不再把 `onProgress` 的异常吞掉——`native-run.js` 那边的注释写着「不吞异常」，两处口径本来就相反。

顺手把 `settle` 的 `writtenCount` 改成只认落地器的实际写入数。原来是 `written || 引擎自报值`，整批回滚的一轮在账上仍是「写入了 N 篇」，用户在面板上看到「写入 N 篇」而库一个字没变。

### 口径收成一处，无变化轮也要体检

上一版把存量体检接进原生通道时，`apply-plan.js` 和 `quality-gate.js` 各自手写了一组 `inspectArticle` 配置。两处当时碰巧一致，但它们之间没有任何联系——改一处、忘另一处，判据就分叉了，而且分叉后两边都自称在「按契约检查」。现在这组口径是 `lib/article-contract.js` 导出的 `NATIVE_ARTICLE_OPTS`，两边都展开它，各自的差异项（`cwd`、`articlePath`、`expectedType`、`allowedLinks`）才单独写。

同一条链上还漏了一格：无变化轮（引擎与四路变化集都空）在落地器里是提前返回的，返回点排在存量体检之前，于是「库里躺着坏文章」这件事在这条路径上永远看不到——终态照样报 done。Node 通道的 `tickIndex` 是在开头无条件跑体检的，两边行为不一致。现在 idle 分支先跑体检再返回，命中则终态降为 partial、基线照旧不动（无变化轮本来也不推进会基线）。

契约层补回目录判定。上一版为了让 `Dockerfile` 这类无扩展名文件不被误判，把 `isRepoRelativeFile` 的最后一行直接改成了 `return true`，代价是「`source_files` 指向一个目录」这条判据彻底消失。现在恢复为「尾斜杠即目录、绝对路径与上跳即非法」，并且 `inspectArticle` 在调用方提供了 `isDirectory` 能力时，对不带尾斜杠的目录路径也判 `bad-source`——`index.js` 的 `contractCheck` 把它接上了。

另外三处：

- `apply-plan.js` 挑写哪些页时读 `r.defects ?? 0`。`rendered` 项由 `quality-gate.js` 生成，`defects` 是那里的必填字段，`?? 0` 永远用不上，只会让「字段没填」看起来像「零缺陷」。去掉。
- `collectPruneTargets` 拒掉非法裁剪根时是静默 `continue`。于是「裁剪根写错了」和「那里本来就没东西可裁」在结果里长得完全一样，调用方无从知道自己的参数被丢弃。现在拒绝进 `problems`（`[prune-<kind>]`），终态可见。
- `native-run.js` 的完整性检查失败文案改成「产物完整性检查未执行（<code>）：本轮增量决议未经缺页/陈页校验」。原来写「检查失败」，读者会以为检查跑了并给了结论，实际是没跑。

契约版本升到 `3`。`ENGINE_STAGES` 在 0.17.32 补了 `'proofread'`，但 `ENGINE_CONTRACT_VERSION` 一直留在 `2`——`docs/fsoft-native-engine.md` 明文要求「改契约必须同步升版本」，而 python 侧的 `CONTRACT_VERSION` 也存在同一条要求。两处一起改成 `3`，文档里的版本号、JSON 示例与 stage 枚举补齐。

### 修掉 4 篇存量坏文章

存量体检上线后立刻在本库查出 6 篇；2 篇是上面那处契约层误判的假阳性，另外 4 篇是文章自身的真实结构缺陷：

- `learnings/update-reminder-entry-gap.md`：frontmatter 只有开头一个 `---`，补闭合。
- `modules/incremental_update.md`：frontmatter 缺 `tags`，补 `tags: []`。
- `modules/clustering.md`：末尾重复的空标题 `## Connections`、`## Data Flow`、`## Connections`，删掉。
- `modules/graph_diff.md`：末尾重复的 `## Architecture` 改名 `## Architecture Detail`，并补回被截断的正文首句。

修完后 `auditExistingArticles(process.cwd())` 返回空集。

### 实测

```
test-engine-apply-plan.mjs          55 passed, 0 failed   （基线 48，新增 7 条）
test-article-contract.mjs           33 passed, 0 failed   （基线 31，新增 2 条）
test-engine-native-job.mjs          141/141 通过
test-engine-native-incremental.mjs  157/157 通过
test-job-reliability.mjs            125/125 通过
test-batch.mjs                      117 通过
test-engine-client.mjs              29 passed
test-engine-manifest.mjs            27 passed
test-engine-contract.mjs            19 passed
test-engine-quality-gate.mjs        37 passed
test-engine-output.mjs              32 passed
test-engine-proofread.mjs           13 passed
test-engine-python-entry.mjs        24 passed
test-engine-bridge.mjs              25 passed
test-engine-llm-bridge.mjs          28 passed
test-agentic.mjs                    55 passed
```

新增的 7 条覆盖：存量坏文章阻碍基线推进但绝不回滚本轮产物、不重复上报本轮裁决里的页、跳过 `_` 开头的路径、标题含 `]` 不被判缺页、裁剪根 `.codewiki/../src` 不得删源码、dryRun + 无变化不得报 `applied: true`、无变化轮同样要体检存量。其中「不进回滚」那条比对的是回滚前后的库内容，而不是只看 `rolledBack` 标志。

`test-wiki-anchors.mjs` 仍是红的（2527 过 / 26 败）：`.codewiki/` 里的行号引用滞后于工作区代码，属既有未提交改动造成的历史状态，需要一次重编译才能消化。

## 0.17.37 — 2026-11-04

总览先回答「要处理几个仓」，会话按工作区分组，设置页改成分类卡片 + 自动保存。另核实了过期会话清理确实在跑。

### 总览不再只是仓库清单

原来的页面从调度条直接跳到十几个仓库的平铺列表，读者得自己数「有变更」才知道总量，等于没有总览；而且清单按插入序排，刚加入的新仓库会插到中间，每天最该点的几行位置天天变。

现在顶部先给五格数字：待确认 / 有变更 / 进行中 / 干净 / 合计。待确认与有变更非零时整格标成 warn 色，进行中非零标成 ok 色——扫一眼就知道要不要动手。清单改成待办优先排序（待确认 → 有变更 → 其他 → 干净 → 已排除），左侧 2px 色条区分档位，不需要逐个读状态词。

### 会话按工作区分组

全局会话里几十条请求分属十几个仓库，平铺时「这条属于哪个仓」只能靠每行尾部那个目录名字去认，滚动时上下文完全丢失。改成一组一个 `<details>`，头部是仓库名 + 条数，组顺序按组内最新一条的时间倒序（刚活动过的仓排最前），首组默认展开。单任务视图只有一个仓，不再套这层分组容器。

### 设置页：分类卡片 + 自动保存

- 取消「保存 / 放弃更改」按钮，改为改动后 500ms 自动落盘，底部状态行显示「修改会自动保存 / 保存中… / 已保存 / 保存失败（可重试）」。保存串行执行，保存期间又改动的会在这一轮结束后补一次，不会丢改动。退出页面时若还有未提交的改动，卸载钩子里补提交一次。
- 参数按用途分成六张卡片（运行 / 并发与语言 / 原生引擎 / 编译模型 / 大档模型 / 调度与排除），自适应多列排布，最宽 1280px（原来固定 880px，宽面板右侧全是空白）。卡片内改成单列字段 + 标签在上，不再用「132px 标签列 + 输入」的两栏网格——卡片最窄 340px 时那套网格会把输入框压到 200px 以下，长 placeholder 直接被截掉。
- 字段校验在保存前跑：并发 1–8、大档并发 0 或 1–8、请求上限 1–1000；不合法就不提交，状态行报错并给重试按钮。

### 布局再修：卡片高度不齐、开关字段空半行

第一版卡片用的是网格（`auto-fit` + `minmax(340px, 1fr)`），运行卡有十个字段、大档卡只有两行，同一个网格行里两张卡被拉成同一高度，短卡底部就剩一大片空白；加上每条说明都是两到四行，整页看起来像五块高度随机的白板。三处改动：

- **换成多列布局**。`columns: 3` 按列填充，卡片之间不再有「行内高度差」这个视觉对象，短卡自然被下一张卡接上。窄面板退两列（≤1020px）/ 一列（≤660px），并且给 `break-inside: avoid-column` 兜住 Safari 的列内断卡。
- **开关字段改成标签与开关同行**。开关本来只有一行高，之前按「标签一行 + 控件一行 + 说明三行」堆，卡片里会连续出现几条只有右边一个小圆点的空白带。新增 `[data-dscw-toggle]` 行（标签左、开关右、`justify-content: space-between`），八个开关字段全部改用。
- **运行卡拆成两张**：行为开关（启用 / 提醒 / 自动提交 / 只看工作区）留在「运行」，并发数与文章语言另立「并发与语言」。原来那张卡独占一列还最矮，是三列里最难看的那个。

文案同步压短：设置页实际渲染的说明从 1015 字降到 719 字，每条压到一句。顺手修掉两处已不成立的表述——`bigProviderHint` 还写「留空则关闭大档通道」（0.17.5 起开关是 `bigEnabled`），`bigModelHint` 还写「默认 glm-5.3-flash」（0.17.34 起没有默认模型，provider 与 model 都填空由用户选）。

底部自动保存行加了状态圆点（空闲灰、保存中品牌色呼吸、成功绿、失败红，`prefers-reduced-motion` 下不呼吸）。原来只有「改动会自动保存」六个字贴在左下角，读起来像一句孤立的注解。

### 顺带核实：过期会话确实在删

`pruneSessionRecords` 按文件 mtime 判过期（24h TTL），挂在 10 分钟一轮的 tick 上；job 目录删空后连同目录一起移除。实测本机会话目录当前 3 个 job / 64 个文件 / 超期 0 个（最旧 17:10，最新 17:23），即清理在工作，只是还没产生超期记录。`test-sessions.mjs` 已覆盖（把 mtime 改到 25h 前 → 断言删除数、目录移除、重复执行幂等）。

### 面板测试从 8 条扩到 14 条

新增 6 条，覆盖本轮三个改动面：总览统计条五格与 warn 着色、待办优先排序、会话全局视图按仓分组并核对条数、单任务视图不分组、设置页 cards 容器包住全部 section、保存按钮换成自动保存状态行。

这 6 条都做过变异验证：把统计条的 total 格删掉、单任务视图强制分组、排序改成字典序、保存行去掉 `data-state`，四种改动各自只让对应的那一条变红——说明断言确实打在行为上，不是同义反复。其中「会话分组条数」那条还需要给桩注入真实 `t`，否则 `{n}` 占位符没被替换，「条数写错」这种缺陷照样能通过。

### 实测

```
test-client-panel.mjs     14 passed, 0 failed
test-wiki-entry.mjs       全部断言通过
test-config.mjs           PASS：设置项契约全部通过
test-reasoning-effort.mjs PASS：思考档位校验全部通过
test-sessions.mjs         PASS：会话记录存储冒烟全部通过
```

全量 39 个测试文件里仍红两个：`test-wiki-anchors.mjs`（wiki 产物滞后于源码，需重编译）、`test-engine-native-job.mjs`（用例 22「取消晚于落地」两条，属既有时序 flake，单独重跑 141/141 通过）。

## 0.17.36 — 2026-11-04

### 四个标签页统一重做：导航、总览、会话、设置

这一轮只动界面，不改行为。目标是让四个标签页看起来像同一个产品的四个面，
而不是四段各自生长的代码。

**1）标签条从「四个药丸」改成等分格子 + 滑动下划线**——原先当前页是一个实心品牌色
药丸，视觉重量和旁边的操作按钮相当，读者第一眼分不清「哪个能点、哪个是位置指示」。
现在四格等分、透明底，当前页用一条 2px 品牌色下划线条标出（`::after` 画线，
`transform: scaleX(0→1)` 过渡 0.22s），并补了 `:focus-visible` 焦点环——
键盘 Tab 过来时能看见自己在哪一格。

**2）总览页去掉「每个仓库一个描边盒子」的堆叠**——调度信息和十几个仓库各套一个
0.5px 圆角框时，页面上出现十几个同等重量的边界，看不出主次，滚动时也读不出
「哪几行是同一件事」。改成：调度信息是一块浅底摘要（它不是一个可操作对象，
不该被框成卡），仓库列表用行级分隔线 + 悬停淡底，最后一个不画线。
仓库容器补了 `data-dscw-p-repolist` 包裹层，测试据此断言行数。

**3）空状态从一句灰字改成带标题的引导块**——原先空态就是一个 `<span>`，
读者分不清「这里确实是空的」和「还没加载出来」。现在三处空态（总览没有仓库、
任务页没有记录、会话页没有请求）都带一个 `<strong>` 标题 + 一句说明，
垂直留白 18px，不再是挤在边上的小灰字。

**4）加载态用骨架屏替掉裸「…」**——新增 `Skeleton` 组件（三行不同宽度的呼吸条，
`dscw-shimmer` 1.4s 线性动画，`prefers-reduced-motion` 下关闭动画）。
骨架让人在等待时就知道「马上会出现什么、大概多高」，数据到达时也不会整块跳一下。

**5）会话列表从「一行一个描边框」改成列表 + 左侧状态色细条**——并发池的请求动辄
几十条，每行描边就成了一叠等重的盒子。现在每行左侧一条 2px 竖条（跑动=成功色、
出错=错误色、其余=边框色），悬停淡底，`:focus-visible` 有轮廓。
`pre` 区块去掉边框改淡底 + 等宽字体（10.5px），`<summary>` 用 `▸` 指示器并在展开时
旋转 90°，`word-break` 从 `break-all` 改成 `break-word`——前者会把英文单词从中间劈开。

**6）设置页：分组有标签线、左列改为顶对齐、保存条钉底**——五个分组原先只靠 24px
空白区隔，滚动时看不出边界，现在每个分组标题下有一条 0.5px 细线（比再加一个描边
盒子轻得多），设置区本身那层「盒中盒」也去掉了。`align-items` 从 `center` 改为
`start`：字段列里有 textarea 和多行提示时，居中对齐会让标签浮在两行中间，看起来和
上一行错位。左列宽度 160px → 132px，行间距 10px → 12px。
保存条 `position: sticky; bottom: -1px` + `backdrop-filter: blur(6px)`——
设置页比一屏高，滚到一半想保存时不该再滚回去找按钮。

**7）`articleLanguage` 补上缺失的字段容器与说明**——它是唯一一个「label 后面直接跟
裸 `<Input>`」的字段：没包进 `data-dscw-field`，也就没有 hint，grid 里那一格的高度
和别的行不齐。现在补齐容器与「留空则跟随当前会话语言」的说明。

**8）可折叠行统一 `▸` 指示器**——`tasklist`、`repofold` 设了 `list-style: none`
之后连原生三角都没了，读者无从判断「这行能点开」；`history`、`engine-log` 则靠浏览器
默认 marker，不同字号下行高对不齐。现在四类折叠行共用一条 `::before` 三角规则，
展开时统一旋转。

**9）顺带修掉一处 sed 事故**——`content: "\u25b8"` 曾被 sed 改坏成 `"25b8"`，
`node --check` 能过但渲染出来是字面量四个字符。已还原为转义序列。

实测：探针渲染四个标签页各一遍——总览 1 个调度摘要 + 1 个仓库列表 + 3 行仓库，
任务页 1 张卡 / 1 条分段带 / 1 行图例 / 4 条活动流行，会话页 3 行请求，
设置页 5 个分组 + 5 个 grid + 1 条保存条，四个页面 `Panel error` 均为 false，
裸键名 0 个；中英文字典各 216 键，键集完全一致、无空值。
`test-client-panel.mjs` 从 5 条扩到 8 条（新增总览仓库列表、空态标题、
设置页分组三条护栏，另修掉桩里函数组件不透传 `children` 的缺陷——
该缺陷会让所有 `Button`/`Tag` 的子内容渲染成空，`确认编译` 按钮因此从未被断言到）。

## 0.17.35 — 2026-11-04

### 任务面板改成百分比驱动；卡片收成三分之一高；同时显示多个进行中的任务

**1）进度读数是百分比，一行给全**——大数字（22px，tabular-nums）+ 主进度条
+ 当前步骤说明压在同一行。原来的七步步骤条（10px 圆点 + 连接线）删掉，因为它只能
表达「到第几步」，表达不了「这一步走了多少」。数字块、进度条、说明各占一行会
把一张卡撑到 300px 以上，信息量没变，高度翻了四倍。

**2）阶段进度收成一条分段带 + 一行图例**——早先每个阶段一条独立轨道（七行，
每行名字 + 轨 + 百分比），一张卡就吃掉半屏；而且「排队」权重为 0 却也渲染一行
100%，纯噪声。现在是一条 5px 高的带子，**段宽 = 该阶段在总进度里的权重，
段内填充 = 该阶段自己的完成度**——「文章那段最宽」这件事本身就在说它最费时间；
下面跟一行小字图例「准备 36% 文章 0% …」，当前阶段加粗，放不下就换行。
宽度为 0 的阶段（排队）不出段也不出图例。

**3）分段带有了颜色图例，活动流改成时间线**——分段带的颜色原先只表达了状态，
但没有任何地方说明「绿色是什么、灰色是什么」，颜色信息等于白给。现在每一项
图例前带一个与上方对应段同色的色块，悬停还能看到该阶段的状态词与准确耗时。
活动流从「一坨等宽文字」改成时间线：每条前面一个状态点（绿=推进、黄=需要注意、
红=出错、灰=普通），备注里含 `（articles）` 这类写法的会被摘成阶段小标签，
`3/6` 的计数说明折叠里少的那条是已经常显的最新一条。折叠头写了这个原因。

**4）卡片高度砍到原来的三分之一**——真机截图里一张卡吃掉近 500px，罪魁是每样次要
信息各占一行：独立 meta 行、独立用量行、独立备注、活动流、引擎日志、逐篇清单。
现在 meta / 用量 / 最新一条备注合成**一条可折行的流水线**，逐篇清单与活动流收进
`<details>` 默认收起，排队中的卡不再画分段带（进度是 0，画出来就是空条）。
活动流折叠里不再重复已经常显的那条备注。

**5）同时显示多个进行中的任务**——原先前端只取第一个进行中任务做 hero 卡，
其余全塞进「历史」折叠，并发跑两三个仓库时只有一个能看见。现在
`actives = all.filter(isActive)` 全部平铺在「进行中 (N)」分区，各自带仓库名；
只有没有进行中任务时才退回「最近一个任务」单卡展示。历史列表按仓库折叠，
不再重复出现在进行中分区里。
**6）卡片视觉重做**——左侧 2px 状态色竖轨（`data-tone` 区分
done/partial/cancelled/failed），12px 圆角，进度条 5px 圆角轨道 +
`cubic-bezier(.22,.61,.36,1)` 0.45s 过渡，卡片内间距 10px、元素间距 7px，
徽标改方角淡底去描边，tab 补 hover 底色。终态卡片不展开分阶段（避免一排 100% 的噪声）。

**7）每阶段耗时进悬停提示**——分段带每一段的 `title` 里带该阶段精确耗时。
绝对毫秒跨仓库不可比，但「这一轮里哪一步最费时」可比；段宽已经把这件事画出来了，
精确值放悬停里，不占常驻高度。

**8）进度趋势线**——进度区右侧一条小 spark，记录最近 24 次采样的总进度。
只看数字不知道「还剩多久」，看斜率才知道：曲线平了说明卡住，还在涨说明在推进。
`overallPct` 没取到的采样直接跳过，不会把曲线拉成 0。

**9）并发总览**——「进行中 (N)」标题右侧给出池内平均进度与最慢的那个仓库。
排队中的任务不计入平均（它的进度恒为 0，算进来会让「最慢」永远是还没开始的仓库），
排队数单独报。一次跑多个仓库时不用逐个点开卡片拼整体节奏。

**10）历史区按仓库折叠**——原来几十轮同一仓库的历史平铺在一起，会把别的仓库
彻底挤出视野。改成 `<details>` 按仓库分组，默认收起，头部右侧标这一组有几轮。

实测：注入 3 个任务复现真机截图（trae_tools 准备中·聚类 36%、
dsh-presets-Switch 排队中、dsh-codewiki 写文章 62%）跑渲染，得到 3 张卡、
2 条分段带（排队那张不出带）共 12 段、3 条紧凑优先信息行；旧的七行轨道节点数为 0，
独立的 meta / usage / note 行数也都是 0。第一张卡的图例读数
`准备 36% 文章 0% 校对 0% 校验 0% 索引 0% 提交 0%`，次要信息行是
`已写 2/3 篇 · 引擎阶段 聚类 36% · 已用时 …（排队 … · 执行 …） 用量 … 第三条备注` 一条。
换一份 6 条备注的任务再验：图例 6 项各带色块、活动流 5 行（1 行常显 + 5 条折叠、
`5/6` 计数），语气序列 `warn ok plain ok error`，`（articles）` 被摘成阶段标签，
`未过契约闸门` 判为红点、`空产出` 判为黄点。
`test-client-panel.mjs` 5 passed；`test-wiki-entry.mjs`、`test-config.mjs`、
`test-batch.mjs`（117 通过）、`test-reasoning-effort.mjs`、`test-engine-client.mjs`
（29 passed）全部通过。

## 0.17.34 — 2026-11-04

### 设置页不再替你猜模型；大档默认关闭；原生引擎参数进面板

**1）编译模型取消默认值**——`batchProvider`/`batchModel`/`bigProvider`/`bigModel`
四项默认值全改为空字符串，并删掉 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL`/
`DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` 四个常量。`liveConfig` 里两处
`|| DEFAULT_*_MODEL` 兜底一并去掉——留着它，用户清空模型会被静默改回 `glm-5.3-flash`，
而模型目录里没有这个 id 时上游回 200 + 空内容，整轮编译空跑（0.17.24 的事故形态）。
提交任务时仍由 `index.js:3671` 的两条校验明确报错，不会静默失败。

**2）大档默认关闭**——`bigEnabled` 默认 `true` 改为 `false`，
`liveConfig` 的 `bigEnabled = val(c.bigEnabled) !== false` 改为 `=== true`。两处口径必须
一致：只改 Config 的话，老 settings.json 没这个字段时 `liveConfig` 仍按开启处理，
等于默认值形同虚设。大档关闭时 `bigProvider` 一并清空，模型与预算保留，
重新开启不用重填。

**3）移除 `sessionTier`**——它只被旧通道 `tickArticles` 的会话兜底路径读取，
而原生任务一律只走 `tickNative`（`index.js:3544`），这条路径在原生编译里不可达；
默认值本就是空字符串，删除等价于固定「自动选路」，无行为损失。连带
`buildSessionSteerText` 去掉 `tier` 形参与三行档位文案。

**4）原生引擎四项参数进设置页**——`nativeEngine`（编译通道开关）、
`nativeEnginePython`（解释器路径）、`nativeEngineEntry`（入口脚本）、
`nativeEngineTimeoutMs`（单次超时）此前只能改配置文件，现在补进设置页新增的
「原生引擎」分组，渲染、save 字段表、中英文案一并补齐。至此 `Config` 的 27 个字段
全部可在面板调整（逐字段核对，无遗漏无多余）。

**5）修掉三处 `z.number()` 字段的保存缺陷**——`requestLimit`、`bigTokenBudget`、
`nativeEngineTimeoutMs` 的 `onChange` 直接把 `e.target.value`（字符串）塞进 draft，
而 schemastery 对 `z.number()` 收到字符串会抛 `expected number but got 500`，
保存直接失败。改为空串给 0、其余 `Number()`。

**6）说明文字按「不查文档猜不到的那一句」重写**——中英各 20 条 hint 全部压缩：
去掉复述字段名的句子、过时措辞（「横切」「审校」）、真机吞吐数字与「12 分钟」这类
会过期的细节，只保留改动后果与边界条件。

## 0.17.33 — 2026-11-04

### 校对格子真的能亮了；行尾差异不再制造噪声提交

0.17.32 声称修好了「校对格子不显示」，实际只是把 bug 换了个位置。这一版把根因修掉，
并把同一批审查里发现的相关缺陷一起处理。

**1）`proofread` 不在引擎契约里，进度帧在构造时就被抛掉了**——0.17.32 把
`progress('review', …)` 改成 `progress('proofread', …)`，而 `ENGINE_STAGES` 只有
`env/graph/cluster/articles/validate/index/baseline/commit` 八段。`engineProgress` 对着
非法 stage 直接抛错，调用处的空 catch 把它吞了，于是 `onProgress` 一帧都没收到，
`NATIVE_STAGE_TO_PANEL.proofread → 'review'` 这条映射从来没被执行过。
实测证据：同一轮里校对确实跑了（notes 记着「校对改写 1 处失效链接」「语义校对改写了 1 篇，
改后重新判门」），但 `onProgress` 收到的 11 帧里 `proofread` 出现 0 次。
修法：把 `proofread` 登记进 `lib/engine/contract.js` 与 `lib/engine/python/stage_map.py`
（阶段枚举是契约不是实现细节，面板步骤条、`job.stage` 映射、取消检查点都按它对齐），
并删掉两处吞异常的 `try/catch` —— 契约名对不上属于必须当场看见的编程错误。

**2）行尾差异在比对侧被豁免，在写入侧没有**——`findStaleLanded` 用 `
 → 
` 归一后
比较，`writeAll` 却逐字节比。结果：只要有一篇真 stale 触发规范化轮，写集取的是全部
`rendered`，那批「只差 CRLF」的页会被一起翻成 LF，制造一次纯行尾的噪声提交
（实测 written 里混进了 `.codewiki/modules/b.md`，它的内容与磁盘只差行尾）。
修法：抽出 `sameContent()`，比对与写入共用同一口径。

**3）缺陷页永远不参与比对**——`rendered` 只收 `pageDefects.length === 0` 的页，于是
「库里那篇旧的自己也不合规」这种情况落地器根本看不见，而渲染规则改进后要修的恰恰是它们。
修法：`rendered` 收全部页并带 `defects` 计数；写不写由落地器按轮次决定——正常轮只写
`defects === 0` 的页（坏内容不落库），规范化轮全写（职责是与当前渲染规则对齐，
缺陷仍由门如实上报）。

**4）顺带收口的实现问题**：`apply-plan.js` 的三布尔组合（`noChanges`/`deleteOnly`/
`normalizeOnly` 散在五处）收成单一的 `roundKind` 枚举；跨页链接扫描原来在三处各写一个
正则且已经分叉，统一到 `lib/engine/wiki-links.js`；`/api/codewiki/repos` 与 control 端点
对同一作用域的 `schedState` 不再层层可选链，confirm 的路径键改用既有的 `normPathKey`
（原先手写的版本总是折叠大小写，在大小写敏感平台会误删不相干的待确认条目）。

**5）记录一处从未入账的行为变更**：0.17.27 的提交（`feat(scheduler): 首次编译需确认`）
同时改了 `quality-gate.js` 的渲染路径，让**未命中的 `.md` 链接在渲染期降级成纯文字**
（`dropUnresolved`）。这让产物里不再有任何指向不存在页面的链接语法，读者只看到一段普通
文字——死链事实仍由 `output.js` 报，但「点开 404」这件事已经从产物层消失了。这个改动
与当版 CHANGELOG 一起发布却没有任何记录，现补记于此。

**关于「全套回归全绿」**：0.17.32 那句「39 个文件全绿」不实。当时有两个文件是红的：
`test-wiki-anchors.mjs`（23 条 `.codewiki/` 文章的锚点失效——wiki 产物滞后于源码，
需要重编译，不是源码缺陷）与 `test-engine-native-job.mjs` 的 2 条用例（用例 22
「取消晚于落地」，来自 2026-11-01 的提交，在本次改动前的基线上同样失败，属既有失败）。
本版如实记录，不再用「全绿」概括。

验证：`test-engine-contract.mjs` / `test-engine-quality-gate.mjs` / `test-engine-apply-plan.mjs`
/ `test-engine-proofread.mjs` / `test-engine-python-entry.mjs` 等全部通过；
`test-wiki-anchors.mjs` 的 23 条锚点失效由本轮收尾的 wiki 重编译解决。

## 0.17.32 — 2026-11-04

### 面板「有变更」不再被自己的产物顶住；校对阶段能显示出来

两个用户反馈合成一条修复链：

**1）「已经完成的工作区为什么还显示有变更」**——`cw status` 比的是
`git diff last_compiled_commit..HEAD`，而编译基线**必然落在产物提交之前**：提交内容里写着
`last_compiled_commit`，无法自指，所以基线只能是父提交。于是每轮编译刚结束、工作区明明
干净，`.codewiki/` 那一整批产物仍然出现在差异清单里，面板永远显示「有变更」。

修法：`parseStatus` 把 `.codewiki/` 下的条目从 `changedFiles` 里摘出来单列 `wikiChanges`，
判据与 `lib/change-set.js` 的 `isWikiProduct` 一致；摘完只剩产物时判 `clean`。验收：真机
`dsh-git-worktree` 的 `cw status` 过滤后一行不剩 → clean；本仓过滤后仍有 11 个真实源码
改动 → stale（正确）。

**2）「根本没触发校对」**——`native-run.js` 里校对段写的是 `progress('review', …)`，而
`NATIVE_STAGE_TO_PANEL` 的键是 `proofread`，映射不到任何面板阶段，校对这一格永远不显示。
已改为 `progress('proofread', …)`。

校对仍**只在质量门报出 `dead-link` 时执行**（门没报错就是这轮产物没问题，不烧模型预算
逐页复查——这条按用户 2026-11-04 口径确定）。

验证：`test-wiki-entry.mjs` 新增两条断言（产物被摘出 `changedFiles`、只剩产物判 clean），
全套回归 **39 个文件全绿**。

## 0.17.31 — 2026-11-04

### 步骤条对齐真实流程 + 新增语义校对（模型编造的页名当场改对）

用户反馈「任务标签展示的流程与现有流程不符，请改进」并「增加校对流程」。核对后确认面板
确实在说两件不成立的事：

- **「横切」永远不会发生**：单轮写作通道 0.17.5 已退役，原生任务只走 `tickNative`，
  `crosscut` 这个格子在真实编译里始终是空的；
- **「校对」装的是结构校验**：`NATIVE_STAGE_TO_PANEL` 把引擎的 `validate`（质量门结构校验）
  塞进 `review` 格子，而当时根本没有语义校对这回事。写作前的 `env`/`graph`/`cluster`
  三段又全被映射成「文章」，等于什么都没说。

改法：

1. `client.js` 步骤条改为对齐真实动作的七步：排队／准备／文章／校对／校验／索引／提交。
   `NATIVE_STAGE_TO_PANEL` 同步改为 `env|graph|cluster → prepare`、`proofread → review`、
   `validate → validate`。旧任务记录里的 `crosscut`/`plan` 经 `LEGACY_STAGE` 归并，
   历史任务不会因为字段消失而显示空白。
2. **新增语义校对阶段**（`lib/engine/proofread.js`）：在质量门之前，把「正文链到不存在
   页面」的链接当场改对。

校对为什么需要、以及它不是什么：原生引擎写作时，模型会照着旧版聚类的记忆编造页面名
（真机 `dsh-git-worktree` 的 `client_review_console/status_readouts.md`、`dsh-hindsight-on-demand`
漏写 `_ui` 后缀的 `settings_and_logs.md`），模块树里根本没有那些页。质量门如实判 `dead-link`，
于是这些仓库每轮都停在「部分完成」——判据没错，是产物真的错。所以校对**修正文、不放宽判据**：
它只处理这一类可证伪的问题（只看本页 + 真实页名清单就能改对），改完仍要重新判一遍门，
改不掉就照旧判 partial。

实现要点：

- `proofreadPages({docsDir, sources, chat, maxPages})` 逐篇：解析本页失效链接 → 一次单轮
  模型请求 → 解析 `<PAGE>` 段 → **三重护栏**（缺 frontmatter 保留原文、模型没改对即失效数
  未减少保留原文、模型报 `NO_CHANGE` 不写盘）→ 写盘并记 note。
- 只把有失效链接的页送去校对（`missingLinksOf` 为 0 的页不发请求），默认上限 6 篇，
  单篇一次请求。
- 接线在 `native-run.js` 的「2.6) 校对」段：先跑一次门拿到 `dead-link` 的源页（门是纯读
  `docsDir` 的，跑两次无副作用），校对后若真有改写就重判门。`deps.chat` 未注入时整段跳过，
  行为与旧版完全一致。
- `index.js` 用 `llmChat` 接上 `deps.chat`，复用编译模型的 provider/model/思考档位，
  不额外配置一套模型。

验证：

- `test-engine-proofread.mjs`（新增，13 项）覆盖判据、提示词、回复解析与三类护栏；
- `test-engine-proofread-e2e.mjs`（新增，11 项）走真实链路（真 spawn 假引擎 → 真门 →
  真校对 → 再判门 → 真落地）：开校对后 `dead-link` 消失、关校对时如实 partial、
  模型没改对时保留原文仍 partial；
- `test-client-panel.mjs` 步骤键清单同步为七步（`stepCrosscut` 已不存在）；
- 全套回归 **39 个文件全绿**。

## 0.17.30 — 2026-11-03

### 无变化轮也要清残留页：残骸不再只能等「源码刚好有改动」才被清理

0.17.28 的残留页清理只在真的写文章那轮生效。真机五仓验证（2026-11-03）暴露了后果：
`dsh-git-worktree`、`dsh-hindsight-on-demand`、`Wxxy-CampusLogin`、`dsh-subagent-auto-router`
四个仓库本轮全是 `updateOutcome=no_change`，残留页一个都没被清掉——`idleRound` 让落地器以
`noChanges: true` 直接短路，连 `deleteFiles` 都不看一眼。而「绝大多数轮次都是 no_change」
正是日常状态，等于这条清理规则实际上常年不执行。

两处修改：

1. `lib/engine/native-run.js`：孤儿页/残留页扫描不再包在 `if (!idleRound)` 里——源码没变
   不代表库里没有残骸，扫一遍的开销远小于留着一堆指向不存在页面的死链。
2. `lib/engine/apply-plan.js`：`noChanges` 短路增加 `deleteOnly` 例外——只当本轮确实有
   待删页时才继续走到删除与索引，且该分支**一件都不写**（不写文章、不写受管状态、不推进基线），
   只做「删除 → `cw index` → 提交」。提交失败照旧进 `problems`，终态不会因此变 done。

验证：`test-engine-native-incremental.mjs` 新增用例 17「无变化轮也要清残留页」，先红
（2/5，残留页仍在、HEAD 未变、提交里没有该页）后绿（5/5）。用例里残骸必须**先提交进
git** 再删——写成未跟踪文件后直接删除，对 git 而言净变化为零（"无内容可提交"），会把用例
测成假命题。整文件 **157/157**。

## 0.17.29 — 2026-11-03

### 叶子组件是「旧值真子集」时不再判冲突：并行全量不再整轮中断

真机 `dsh-codewiki`（`job-mw0rkcel-0`）articles 阶段整轮中断：

```
RuntimeError: module_tree 冲突：fsoft_engine_runtime/fsoft_engine_js_core/
engine_runtime_orchestration/native_apply_plan 在两个并行分支里组件归属不一致
```

树里该叶子记着 3 个组件（`applyNativeOutput` / `defaultRunCw` / `findOrphanPages`），
而某个并行分支看到的是「这 3 个 + 本轮新出现的 `findStaleModulePages`」共 4 个。这是
**旧值是新值真子集**——另一分支还没见到本轮新符号，不是「同一个叶子被分给不同组件」的
归属矛盾。旧实现只要两边 `components` 不相等就报错，于是整轮 articles 停在这一个模块上。

`_merge_tree`（`lib/engine/python/full_parallel_runtime.py`）改为先判包含关系：任一方向是
子集就取并集继续，只有两边各有对方没有的组件才抛冲突。0.17.17 的补挂写盘撞过同一形态
（当时用 `write_tree_exclusive` 绕过合并），这次把判据修在合并函数本身。

验证：`test-upstream-parallel.mjs` 新增「叶子组件是旧值真子集时不报冲突，取并集」，
先红（10 passed / 1 failed，实际返回 `['c']` 而非 `['a','b','c','d']`）后绿（11 passed / 0
failed）。既有「同一个叶子被分到不同组件仍然显式报冲突」用例继续通过，证明真矛盾没被
静默吞掉。

## 0.17.28 — 2026-11-03

### 残留页随本轮编译一并清理：聚类重构留下的旧页不再永久堆积

真机 `dsh-codewiki` 落地 92 页，而当前模块树只有 20 个模块——其余 72 页是历次聚类重构的
残骸，仍挂在 `_index.md` 上，正文里 128 条链接指向已不存在的页。`dsh-git-worktree` 残骸
22 页、`dsh-hindsight-on-demand` 16 页，同样情形。

既有清理逻辑 `findOrphanPages` 命中不了它们：判据是「`source_files` 里每个文件都已不存在」
（`lib/engine/apply-plan.js:449-452`），而这些旧页指向的 `lib/agentic.js`、
`lib/article-contract.js` **都还在**，只是不再归属任何模块。于是页永久留在库里，读者看到的
是一份描述已不存在模块的文档，且没有任何一处报错。

新增 `findStaleModulePages({ repoRoot, moduleTree, keepPages })`（`lib/engine/apply-plan.js`）：
拿**本轮产物的** `module_tree.json` 当权威名单，扫 `.codewiki/modules/` 下的原生页，页名 slug
对不上树里任何模块就进删除集。三条边界都写进判据：只有带 `fsoft_page` 的引擎页才可能被删
（人工页与更早版本生成器的页一律不动）；`module_tree={}` 的整仓模式直接返回空（没有权威
模块名，凭名字猜会删掉全部正文）；本轮写集里的页不算残留（写优先）。

删除统一走落地器 `deleteFiles`，与写盘同事务：索引/基线失败一起回滚，删除进同一个 commit。
判据每轮重跑，所以下次聚类重构产生的残骸同样会被清掉，不需要人工干预。

验证：`test-engine-apply-plan.mjs` 新增单测（命中旧页、保留无 `fsoft_page` 的人工页、
写集优先、整仓模式返回空），42 passed；`test-engine-native-incremental.mjs` 新增用例 16
（建库 → 塞入旧页 → 改源码触发出增量 → 旧页被删、人工页保留、notes 点名数量），152/152。

真机实测命中：`dsh-codewiki` 46 页、`dsh-git-worktree` 16 页、`dsh-hindsight-on-demand` 13 页、
`Wxxy-CampusLogin` 0 页、`dsh-subagent-auto-router` 0 页（整仓模式）。

## 0.17.27 — 2026-11-03

### 首次编译必须先问用户：自动调度只登记，不替用户决定

用户口径（原话）：「原来没有编译 codewiki 的项目，需要编译需要确认是否编译，不需要就加入排除」。
自动调度原来对清单里的每个仓库直接 `scope=auto` 提交，等于插件替用户决定了「这个仓库该有 wiki」——
对一个刚 clone 的仓库、或只是临时放着的目录，这会悄悄在它里面生成 `.codewiki/` 并提交。

`autoScan` 新增待确认闸门：**既没有任何编译任务历史、`cw status` 又是 missing/uncompiled** 的仓库
不提交，登记进 `schedState.pendingConfirm`。判据取两者的交集，两个单独都不够——只看任务历史，
历史被 `MAX_JOBS_KEPT` 截断后编译过的仓库会被当成首次（每次清历史都要重新确认）；只看 status，
wiki 目录被删掉的仓库报 missing，但用户早就表过态。有历史的仓库走原路径，零额外成本（不跑
`cw status`）。判态失败时本轮跳过该仓库并记 `lastError`，不替用户做决定。

新端点动作 `POST /api/codewiki/control {"action":"confirm","cwd":"…"}`：从待确认清单摘掉并立即提交，
语义等于用户手动点编译（手动路径本来就不需要确认）。被排除的仓库会同步从待确认清单移除。

`/api/codewiki/repos` 的 `scheduler` 块新增 `lastScanPending` / `pendingConfirm`，每行新增
`needsConfirm`。这两个字段**不进 30s 总览缓存**——待确认状态随心跳实时变化，缓存会让用户在登记后
30 秒内看不到确认按钮。

面板仓库卡片：待确认时显示「待确认」标签、「确认编译」与「排除」两个按钮，并给出一句说明
（自动调度不会替你做这个决定；不想要就排除）。待确认的仓库不再同时显示「更新」按钮。

验证：`test-orchestration.mjs` 新增一节 7 项断言——从没编译过的仓库进入待确认清单、待确认期间
零编译任务、零模型请求、总览行 `needsConfirm=true`、`confirm` 动作被接受并立即提交、确认后
不再留在清单、`needsConfirm=false`。既有「历史清空后仍自动提交过期编译」与
「job 历史清空后 repos 仍发现已编译仓库」两条老用例继续通过，证明交集判据没有误伤已编译仓库。

## 0.17.26 — 2026-11-03

### overview 里的陈链不再被永远复用：与当前模块树比对不符就重建

真机 `dsh-git-worktree` 剩下的 10 条死链全部来自 `overview.md`，指向
`build_and_configuration.md`、`client.md`、`console_control_plane_and_services.md` 等
**当前 38 节点树里不存在的模块**。这些页在 git 史里真实存在过（`4c61dac`、`3f758ad`
提交过 `.codewiki/modules/build-and-configuration.md`），是上一版聚类的产物；聚类重构后
模块改名/合并，页消失了，而 overview 一直被复用、从未重建——它的 mtime 比
`module_tree.json` 早 18 小时。

根因在上游判据：`reusable_overview()` 只把「空页」和「未完成的 reading preamble」判为
不可复用，链接正确性完全不在判据里；而 `--update` 只在 `modules_to_invalidate` 非空时
才把 `overview` 加进去，`no_change` 轮什么都不删，于是永远不重建。

新增 `overviewStaleLinks({overviewText, pages, moduleTree})`（`lib/engine/output.js`）：
用当前 `module_tree.json` + docs 实际页名（含 `pageAliases` 的别名）逐条核对 overview 正文里的
相对链接，返回指向不存在页面的目标。空模块树（whole-repository 模式没有权威模块名）返回空——
判不出对错就不删页。

`lib/engine/native-run.js` 的增量轮完整性检查从「只看缺页」扩成「缺页 **或** overview 陈链」：
命中时把旧的 `overview.md` 从产物目录删掉再转全量——上游对不存在的文件 `reusable_overview`
返回 False，于是根总览会真的重建。陈链清单与缺页清单一并写进 `state.json` 的
`missingRepair.overviewLinks`，收敛判据同时比对两份清单：同样的缺页 + 同样的陈链 + 基线没变 +
本轮无源码变化才跳过重复全量，且终态仍如实 partial。

验证：`test-engine-output.mjs` 新增 1 项（陈链被点名、命中页与别名不算、空树不判），31 项全绿；
`test-engine-native-incremental.mjs` 新增用例 15（overview 指向已消失页 → 删页重建、终态 done、
重建后不含旧链接），148/148 全绿。

## 0.17.25 — 2026-11-03

### 引擎页名与正文写法不一致时，链接按唯一别名解析

真机 `dsh-git-worktree` 一轮 29 条 `[dead-link/product]`，逐条核对后发现 19 条是同一个页的两种写法：
引擎按模块名把页命名成 `src_session-checkout-module.ts.md`，兄弟页正文写 `src_session-checkout-module.md`；
子模块页被加父模块前缀，`client_review_console/` 下实际落成 `client_review_console_review_surfaces.md`，
而父页正文写的是短名 `review_surfaces.md`。两类都是固定命名约定，目标页确实存在，不算死链。

新增 `pageAliases(pages)`（`lib/engine/output.js`）产出「别名 → 真实页」表，只认这两类可证伪的约定，
且**候选必须唯一**——同目录同时有 `mod.ts.md` 与 `mod.js.md` 时 `mod.md` 不猜，仍按死链报。
同一张表在两处生效：`validateOutput` 的死链判定（别名命中后仍要过计划页/落地页判一次，避免把
「别名指向一篇没进落地方案的页」放过），以及 `gateNativeOutput` 构造 `pageMap` 时合入，
让 `rewritePageLinks` 真的把这批链接改写成落地页名——只认别名而不改写，等于消掉告警但留下 404。

剩 10 条**不豁免**：`overview.md` 指向 `build_and_configuration.md`、`shared_contracts_and_domain_ports.md`
等模块在 `module_tree.json` 里根本不存在（38 节点逐一比对，cands=0），是模型凭空编造；
`overview.md` 的 mtime 比 `module_tree.json` 早一天，说明它是旧轮次遗留且从不重建
（上游 `reusable_overview` 只把「空页 / 未完成的 preamble」判为不可复用，链接正确性不在判据里）。
这类仍判 `dead-link`、终态仍 partial——缺陷如实可见，不靠放宽质量门消掉。

验证：`test-engine-output.mjs` 新增 4 项（扩展名约定命中、父前缀约定命中、候选不唯一仍判死链、
只是名字相近仍判死链），30 项全绿；`test-engine-quality-gate.mjs` 新增 1 项端到端（判命中 + 渲染后
链接确实被改写），36 项全绿。真实产物对比：`dsh-git-worktree` 死链 29 → 10、`CampusLogin` 保持 1、
`hindsight` 保持 1、`auto-router` 保持 8（该仓 `module_tree.json` 为 `{}`，目标页压根不存在）。

## 0.17.24 — 2026-11-03

### 思考档位不在模型目录里时，提交就拦下

真机事故的根因终于定位：编译模型配成 `trae/deepseek-v4.1-flash` + `batchReasoningEffort: off`，
而该模型目录声明的档位只有 `low/high/xhigh`——**没有 off**。provider 不报错，回 200 加空内容，
桥日志只剩一个 `finish` chunk、`chunkTotal:1`、耗时 8–18ms、没有 usage；引擎侧记
`Tokens used: 0 (in 0 / out 0)`，40 次调用全部空跑。任务看起来正常走完，实际一篇文章都没写。

档位表是唯一事实来源，所以合法性在提交入口校验一次（系统边界：用户配置 × 外部 provider 能力），
不再等每篇文章都空跑一遍再靠 note 提示。新增 `effortError(efforts, effort)`：返回 null 放行、
返回文案拦下，报错里点名配错的档位并列出该模型真实可用的档位。
`submit` 在原有 provider/model/llm 校验之后读 `resolveModelEfforts`，`ok:false`（读不到档位表）
一律放行——「不知道」不等于「不支持」，否则没暴露档位目录的 provider 会被一刀切拦死。

验证：新增 `test-reasoning-effort.mjs`（12 项，覆盖在表里/不在表里/留空/null/空白/清单缺失/
空 id/大小写区分）；`test-orchestration.mjs` 新增两段——档位不在目录时提交报错、一次模型请求都不发出、
失败留痕在 job；合法档位照常提交。全套回归 37 个文件全绿。

## 0.17.23 — 2026-11-03

### 同一批缺页不再每轮重跑全量，但仍如实报 partial

0.17.12 让「产物缺页」在本轮直接转全量修复，解决了「增量早退 no_change 永不补页」。
但它没有收敛机制：如果全量修复本身也补不齐（provider 空响应时常见），下一轮水合后仍会看到同一批缺页，
于是再转一次全量。真机 `dsh-git-worktree` 连续 4 轮都是这个形态——每轮 `resolution=full`、`fallbackReason` 为空、
`written` 只有 3 篇，几分钟白跑一次，终态始终 partial。

现在把「上一轮已因同样缺口转过全量」这一事实记进受管状态：`state.json` 新增
`missingRepair: { baseCommit, modules, attempts, at }`。下一轮发现缺页时，若**编译基线没变**、
**缺口清单逐项相同**、且**本轮没有源码变化**，就不再重复全量，notes 写明原因并提示「如需强制重试请用 scope=full」。

判据用已提交的基线而不是 HEAD：partial 轮同样会产生一次 wiki 提交，HEAD 每轮都变，拿它比对等于永远不收敛；
基线只有 done 才推进，所以「基线没变」才真正意味着「还是同一棵树上的同一批缺口」。
而一旦本轮有源码变化就照旧重试全量——新变化可能正是补齐缺口所需要的内容。缺口补齐后凭据自动清除，
不会把下一次同样的缺口误判成「已经试过」。

这条只跳过「重复的全量」，**缺页一条都不豁免**：缺页仍由 `mapping.js` 的 `findMissingModuleDocs` 判定、
仍被 `output.js` 升级成 `article-missing` blocker、终态仍然是 partial、基线仍然不推进。

验证：`test-engine-native-incremental.mjs` 新增用例 14（首轮转 full 且跑 `generate` → 第二轮 `resolution=update`、
足迹 `["doctor","update"]` 不含 `generate`、notes 解释不重复、终态仍 partial、`article-missing` 仍在），
红证据为实现前 3 项断言失败；整文件 142/142 通过。
## 0.17.22 — 2026-11-03

### 模型通道的空产出必须在任务里看得见

真机四仓（`job-mw0byob0-0`、`job-mw0e3vl8-9`、`job-mw0cn6cv-4`、`job-mw0dkvg4-6`）的桥日志里，
**每一次**请求都是 `{"chunks":{"usage":1,"finish":1},"chunkTotal":2}`、`usage={"input":0,"output":0}`、
HTTP 200：上游 provider 只回了 usage 和 finish，既没有正文 chunk，也没有 tool-call chunk。
连终态本仓库 done 的 `job-mw0bvl9n-b` 也是 12/12 全空。引擎把这轮调用记成「这一页无需改动」
（0.17.21 已能靠账本把失败叶子翻成 partial），但任务侧此前**完全看不到「多少个请求是空的」**这个事实，
只能从 stderr 里的 `Exceeded maximum output retries` 反推。

现在桥把这件事直接统计出来：`llm-bridge.js` 在每个请求内跟踪有没有产生过产出型 chunk
（`text-delta` 或 `tool-call-delta`），正常结束时没有就 `stats.emptyResponses++`；
`native-run.js` 关桥前取一次 `bridge.stats()`，空产出非零就往任务 notes 里写
「模型通道空产出 N/M 次（上游 200 但无正文、无工具调用）；引擎会把这类调用记成「无需改动」，
请检查编译模型是否可用」。

这条只做可见性：不改终态、不动质量门、不放宽任何判据。空响应本身是 provider 侧的问题
（本 profile 的编译模型是 `qoder/qfmodel`），插件能做的是让它在任务页上第一眼就能看见，
而不是让人从 20 多个模块的失败日志里猜。

验证：`test-engine-llm-bridge.mjs` 28 项（新增两条：只有 usage+finish 记为空产出；有正文或
工具调用不记）+ `test-engine-native-job.mjs` 141 项（新增用例 26/27：空产出 8/8 时 notes 点名并给
出下一步、无空产出时不写这条 note）。红证据：未修时 `stats.emptyResponses` 为 `undefined`。
## 0.17.21 — 2026-11-03

### 引擎记账的写作失败不再被读成「这一页无需改动」

真机 `job-mw0cn6cv-4`（本仓库）报 `done`、`blockers` 为空、`writtenCount` 5，但那个 5 全是
状态文件：`git show --stat 947c2df8` 里 `modules/` 零改动，`.codewiki/modules/` 一篇文章都没变。
引擎自己的 `update_record.json` 才是真相：`pages_written=[]`、24 条 verdict 全是
`verdict="no-op"` + `reason="no verdict returned by agent"`，而 `calls` 里两条
`{"kind":"leaf_agent","error":"UnexpectedModelBehavior: Exceeded maximum output retries (3)"}`。

机制在上游 `leaf_agent.py:142-176`：agent 抛异常被 `except` 吞掉（只 `logger.error`），
之后照常 `add_call(..., error)`，再给该叶子要改的每一页记一条 `no-op`。于是「模型连续
三轮没吐任何内容」在账本上长得跟「这一页确实不用改」一模一样，`update_record.outcome`
仍是 `incremental`、`errors=[]`。同一类盲区还有 Step 6.1：`orchestrator.py:432-438` 把缺页
生成异常只写进 `rec.errors` 与 `calls`（`kind=missing_pages`），outcome 同样不变。
插件出口此前只看 `validate_generated_docs` 的缺页与 `update_outcome`，两条都干净 → 整轮报 done。

现在 `action_generate` 的出口额外读 `record.calls`：`kind` 为 `leaf_agent` 或 `missing_pages`
且 `error` 非空的，按 `(kind, target)` 去重，一条失败一条 `article-failed` blocker（detail 分别
写「叶子写作失败：…」「缺页生成失败：…」并保留原始错误文本），终态随 `blockers` 降 partial。
全量 generate 路径没有 UpdateRecord，那一轮的失败仍由异常上抛表达，函数返回空列表而不是编造。

这条改动不动质量门、不放宽任何判据 —— 它补的正是「引擎自己把失败记成 no-op」这个盲区。

验证：`test-engine-python-entry.mjs` 24 项。新用例「引擎记账的失败必须进 blockers」直接喂
真机形态的 `calls`（含重复 target、成功叶子、`missing_pages` 失败、非写作类 kind），断言去重后
的失败三元组、每条都落成 `article-failed`、两类 detail 都点名，以及 `action_generate` 源码里
真的调了 `_failed_calls_of` 与 `_failed_blockers`。对 HEAD 版红对照：23 passed / 1 failed，
失败信息 `action_generate 必须真的用失败调用判终态`。

## 0.17.20 — 2026-11-03

### 层级布局的跨页链接按引擎源目录解析，不再成片变死链

真机 `job-mw0byomb-1`（Wxxy-CampusLogin）25 条 blockers 全是链接类。它的 layout 是
`hierarchical`：引擎把子模块页放在 `android_frontend_hooks/` 子目录里，正文里同目录兄弟写
`x_sibling.md`、父级写 `../parent.md`，这些相对链接都相对**引擎页所在目录**。

但落地时 `mapping.js` 的 `moduleSlug` 把所有页拍平到 `.codewiki/modules/` 单层。
`rewritePageLinks` 当时按**落地目录**去解析链接，于是正文里每一条 `x_sibling.md`
都被当成模块根下还有一层目录的写法，pageMap 一条也命不中 —— 整篇的跨页链接原样留在
扁平目录里，全部 404。

改为按 `article.source`（引擎源页相对路径）的目录解析，再落到目标页的落地目录重算相对
路径；解析不到的仍退回「原样名字」，扁平布局（`LAYOUT_FLAT`）因此不受影响。

真实产物实测（campus 的 58 页、756 条内部链接）：修复前命中 470 / 未命中 286，
修复后命中 754 / 未命中 2。剩下 2 条是产物本身的坏链接（模型写了一段把模块名叠了
三遍的路径、以及一条指向从未产出的 `android_backend_update.md`），属于该报的真问题。

验证：`test-engine-quality-gate.mjs` 35 项。新用例直接给层级布局的源页路径，断言同目录
兄弟链接与 `../` 父级链接都命中落地名、下划线原名不残留；对 HEAD 版实现为红
（`同目录兄弟链接应按引擎源目录解析后写成落地名`）。相关 `test-engine-output` 26、
`test-article-contract` 31、`test-engine-apply-plan` 41、`test-engine-output-real` 11 全绿。

---

## 0.17.19 — 2026-11-03

### partial 终态丢掉本轮用量：写了一半的任务，成本永远是 0

真机 `job-mw0aep74-7`（dsh-git-worktree）发了 46 次请求、写了 8 篇页，任务 `usage`
四个字段却全是 0。原因是 `action_generate` 的出口顺序：`if missing:` 的 partial
分支在 `return result` 之后才轮到后面的 usage 采集段，于是只有 done 那条出口会带用量。

用量不是装饰：它是判断「这一轮到底花了多少」和「值不值得重跑」的唯一依据，写了一半的
任务恰恰是最需要看到成本的。改为独立函数 `_usage_of(job)`，两条出口各调一次，
不再有「先 return、后采集」这种顺序依赖。

验证：`test-engine-python-entry.mjs` 23 项。新用例不用「只测函数本身」这种会漏抓的写法——
它用 Python AST 统计 `action_generate` 里「`return result` 的条数」与
「`result[...] = _usage_of(...)` 的条数」，断言两者相等，所以少调一处就红。
红对照：删掉两条采集行 → 22 passed / 1 failed；恢复后 23 passed / 0 failed。
全套 36 个测试文件（跳过 test-wiki-anchors）FAILED_FILES=0；
`test-engine-native-job.mjs` 连跑两次均 138/138（首轮曾 136/138，属既有时序 flake）。

## 0.17.18 — 2026-11-03

### 桥日志记录 chunk 类型计数：这才分得清「模型返回空」和「桥丢包」

真机 `job-mw0aep74-7`（dsh-git-worktree）40 次桥请求全部 200、单次 200–1300ms，
引擎却报 16 个模块 `Exceeded maximum output retries (3)`、父页 `empty page`，
任务 `usage` 四个字段全 0。此前只能靠会话记录的 `outputChars` 猜，而那个值对
agentic 通道天然是 0（正文在 tool-call 的 arguments 里，会话记录只累计文本 delta），
据此下的「模型退化」判断是错的。

现在每条桥日志带 `chunks`（按类型计数）、`chunkTotal` 与 `usage`（若上游给了）：
若 `reasoning-delta` 有、`text-delta` / `tool-call-delta` 为 0，是上游没给可用输出；
若有 `tool-call-delta` 而引擎仍说没工具调用，才是桥的转换问题。计数里不含正文，
日志不会夹带源码或文章内容。

验证：`test-engine-llm-bridge.mjs` 26 项（新增一条断言 `chunks` 计数与 `chunkTotal`，
并断言日志不夹带 chunk 正文）；全套 36 个测试文件全绿。

## 0.17.17 — 2026-11-03

### 补挂写回走了合并语义，把「超集」误判成叶子归属冲突

0.17.16 之后本仓库增量轮（job-mw09j6e4-5）又中断在 articles：已写 32 篇，
唯一失败是

```
RuntimeError: module_tree 冲突：Code_Engine_Processing_Pipeline/code_engine_module/python_native_runtime
在两个并行分支里组件归属不一致
```

栈顶落在 `fsoft_runtime.py:289` 的 `adopt_tree_coverage(updater, new_tree, new_graph)`。

链条：补挂函数 `adopt_unowned_files` 把未归属文件挂到已有叶子，叶子的 `components`
从 5 个变成 6 个；随后 `file_manager.save_json` 走的是 **0.17.12 引入的合并语义**
（`_merge_tree`）——磁盘旧值 `[5 个]` 与待写新值 `[6 个]` 不等，而该叶子没有
`children`，于是被判定成「同一个叶子被两个并行分支分给不同组件」直接抛错。

判据本身没错：合并语义只适用于「并行分支各自带着自己那部分增量去写」。而补挂
已经基于磁盘最新树算出了完整目标树（旧值是新值的真子集），再合并属于误用。

### 修法：为覆盖写单开一条路径

- `lib/engine/python/full_parallel_runtime.py` 新增 `write_tree_exclusive(filepath, mutate)`：
  在同一把 `_TREE_LOCK` 内做「读磁盘 → 调 `mutate(tree)` → 覆盖写」，跳过合并。
  安装时把原始 `save_json`/`load_json` 记进 `_ORIG_SAVE`/`_ORIG_LOAD` 供它使用。
- `lib/engine/python/fsoft_runtime.py` 的 `adopt_tree_coverage` 改为走这条路径，
  并且**基于磁盘最新树**补挂而不是 Step 4 的 `new_tree` 快照——盘上可能已有本仓库
  历史轮次写下的更多节点，用快照会丢掉它们。`_merge_tree` 的叶子冲突判据保持不变。

### 验证

- `test-fsoft-coverage.mjs` 新增「目标树是磁盘树的超集时独占写不被误判成冲突」：
  先断言把超集交给合并写入确实抛「module_tree 冲突」，再断言 `write_tree_exclusive`
  能正常覆盖、且 `mutate` 拿到的是磁盘当前值。6 项全绿。
- `test-fsoft-runtime.mjs` 6 项、`test-upstream-parallel.mjs` 10 项、
  `test-engine-native-incremental.mjs` 129 项全绿。

## 0.17.16 — 2026-11-03

### 有陈页但没缺页的仓库永远 partial

`Wxxy-CampusLogin` 的增量轮（job-mw089jcq-2）终态 partial，20 条 blockers 里 10 条是
`unmapped-page [文件名冲突：与 android_frontend_hooks/android_frontend_hooks_state_stores.md 都规范化为 android-frontend-hooks-state-stores.md]`。
真实现场：该仓 docs 下同时存在正常页与一份 `docs/` 前缀的嵌套副本（`docs/docs/...`），
是本仓历史上某轮把页写进了嵌套目录留下的。

`staleDocPages` 一直把它们判得对——但清退逻辑写在
`if (missing.length > 0)` 里面，只在「产物缺页」时才顺带执行。
于是模块树一页不缺的仓库永远带着这批副本，每轮都被映射成同名冲突，形成永久 partial。

### 修法：陈页清退独立于缺页判定

- `lib/engine/native-run.js` 的水合后完整性检查把清退提到缺页判定之前：只要走增量
  （`resolution === RESOLUTION.UPDATE`）且模块树非空，就先清退不属于当前模块树的陈页。
- 清退后重新收集页面再判缺页，否则刚删掉的副本会被算作「已有页面」而漏补。
- 只动仓库外的临时产物目录；已提交的 wiki 页仍由落地器按写集与孤儿判定处理。

### 验证

- `test-engine-native-incremental.mjs` 新增用例 13「没有缺页、只有陈页 → 也要清退」：
  先在 docs 里造 `docs/modules/core.md` 与 `docs/overview.md` 两份嵌套副本，再跑 `scope: 'stale'`。
  断言副本被清退、notes 记录清退条数、决议仍是 `update`（不该被迫转全量）、终态 `done` 且 blockers 为空。
  对修复前的实现为红（实测 4 项失败，终态 partial、blockers 含 `文件名冲突` 与 `empty-body`），
  修复后 6 项全绿。
- 全套 36 个测试文件复跑，除既有的 `test-engine-native-job.mjs` 时序 flake 外全绿。

## 0.17.15 — 2026-11-03

### 并行合并把父模块的组件并集当成归属矛盾，整轮增量被中断

0.17.14 修好未归属文件补挂后，本仓库真机增量（job-mw07tzcb-0）又只剩一个失败：
`RuntimeError: module_tree 冲突：Code_Engine_Processing_Pipeline 在两个并行分支里组件归属不一致`，
32 篇已写页面因此被判 `article-failed`。

`_merge_tree` 原先对任何节点的 `components` 不一致都直接抛错。但父模块的 `components`
是它整棵子树的组件并集：两个并行分支各自新增了不同子模块时，两边写回的并集本来就不同，
这是信息互补而不是归属矛盾。真正矛盾只有一种——同一个**叶子**被两个分支分给不同组件。

### 修法：父节点取并集，叶子节点仍显式报冲突

- `lib/engine/python/full_parallel_runtime.py` 的 `_merge_tree` 先判定节点是不是父节点
  （新旧任一有 `children`）；父节点 components 不一致时取并集继续合并，
  叶子节点不一致仍 `raise RuntimeError("module_tree 冲突：…")`。
- 冲突消息与叶子判据保持不变：静默丢弃叶子归属会丢内容且无法回溯，这条不能放宽。

### 验证

- `test-upstream-parallel.mjs` 新增两项：父模块 components 不同不构成冲突且两分支子模块都保留；
  同一个叶子被分到不同组件仍然显式报冲突。对修复前的实现为红
  （实测 `父模块 components 不一致时合并不该抛错，实际抛了：module_tree 冲突：parent 在两个并行分支里组件归属不一致`），
  修复后 10 项全绿。
- 相关回归同步复跑：`test-fsoft-coverage.mjs` 5 项、`test-fsoft-runtime.mjs` 6 项、
  `test-engine-native-incremental.mjs` 全部通过、`test-engine-native-job.mjs` 全部通过。
## 0.17.14 — 2026-11-03

### 增量轮：树里未收录的历史文件让 coverage 校验每轮抛错

0.17.13 修好流式转发后，本仓库增量轮只剩一条 stderr ERROR：
`Generating missing pages failed: Invalid module file coverage: missing=['lib\\engine\\python\\full_parallel_runtime.py'], duplicate_owners={}, outside_scope=[]`。

链条是这样的：Step 2 的 `repair_tree` 只处理**本轮 `diff.added`** 的组件
（`tree_repair.py` 里 `to_route = sorted(c for c in diff.added if c in tracked_new and c in new_graph)`），
而 `validate_module_file_coverage` 每轮都拿**全量组件**比对树的叶子归属
（`expected = component_files(list(components), components)`，取的是所有组件所在文件，不区分叶子类型）。
于是「历史上某一轮没写进树」的文件永远不会补进来——该文件早就不在 diff 里了——
校验就每轮都缺这一个文件、每轮都抛，且不会自愈。

`full_parallel_runtime.py` 是 `60b5903e` 新增的，正好跨在新旧基线之间：旧树从未收录它。
这与「缺页」是同一类问题的另一半——mapping 侧管页面缺失，上游 coverage 侧管文件归属缺失。

### 修法：按上游自己的规则把未归属文件补挂到已有叶子

- 新增 `lib/engine/python/tree_coverage.py` 的 `adopt_unowned_files(tree, components, opts)`：
  求出 `expected - owned` 的缺失文件，对每个文件取其组件、用上游 `filter_leaf_nodes` 挑合格叶子，
  再用上游 `route_by_rules`（同文件 → 同目录 → 邻居多数）找到目标叶子；都没有线索时挂到
  目录最接近的叶子（按共享目录前缀、叶子文件数）。补挂只调用上游 `T.add_component`，
  **不放宽任何校验**——`validate_module_file_coverage` 仍按原样执行。
- `lib/engine/python/fsoft_runtime.py` 的 `run_leaf_agents` 在算出 `order`、折叠 whole_repo 之后、
  派活之前调用 `adopt_tree_coverage(updater, new_tree, new_graph)`：有补挂就写回
  `module_tree.json`，并把「补齐 N 个未归属文件」记进 `detector_notes`；补挂自身失败只记 note 不中断整轮。
  空树（上游整仓单页模式）直接放过，与上游 `if not tree: return` 一致。

### 验证

- 新增 `test-fsoft-coverage.mjs`（5 项）：缺失文件被补挂且上游校验通过、没有缺失时不改动树、
  空树原样放过、无同文件/同目录线索时挂到目录最近的叶子、同目录已有叶子优先。
- 用本仓真实依赖图（607 组件 / 42 个文件 / 真实 `module_tree.json`）实测：
  补挂前 `missing=['lib\\engine\\python\\full_parallel_runtime.py']`、上游校验 FAIL；
  补挂后 `missing=[]`、校验 OK，文件归属落到 `Code_Engine_Processing_Pipeline/code_engine_module/python_native_runtime`。
## 0.17.13 — 2026-11-03

### 桥逐帧转发 SSE 时伪造 finish_reason，引擎以为每轮都结束

0.17.12 真机跑 `dsh-git-worktree` 时，约 20 个模块同时报
`Exceeded maximum output retries (3)` 与 `Please return text or call a tool`。
当时先怀疑是并行度把模型打崩，实测否掉了：按运行期平均并发分桶，并发 1~1.5 的空输出率
83%、1.5~2.5 是 95%，低并发一样空；bridge 也没有任何模块级可变状态。

真正的根因在 `lib/engine/llm-bridge.js`：它把每个 chunk 单独交给
`chunksToSse({ chunks: [chunk] })`，而 `chunksToSse` 的语义是「入参是一整条已结束的流」，
内部 `if (!sawFinish)` 会补一个 `finish_reason` 结束帧。逐帧调用等于给每个中间分片都补了一个
假的结束标记，引擎（pydantic-ai）收到后认为这一轮已经结束——既不执行工具调用，也没有正文，
连续 3 次就抛 `ToolRetryError`。会话记录里 `outputChars === 0` 占 94%（133/142）正是这个形态：
`003.full.json` 的 messages 是 `system > user > assistant > tool`，assistant 只有一句开场白、
没有 `tool_calls`，下一轮 tool 消息为空。

该 bug 由提交 `ccc95441`（阶段 1A/1B/1C）引入，与并行实现无关，串行时代同样存在——
只是并行让它一次暴露在更多模块上。

### 修法：逐帧转发与整条流折叠彻底分开

- `lib/engine/openai-bridge.js` 新增 `streamChunkToSse(chunk, { id, model, created })`：
  单个 chunk → 帧数组，**不补 finish、不补 `[DONE]`**。`text-delta` / `tool-call-delta` 帧一律
  `finish_reason: null`；`usage` 出 `choices: []`；只有真正的 `finish` chunk 才产出结束帧；
  `reasoning-delta` / `block-*` 返回空数组。
- **删除 `chunksToSse`**：修好后它已无生产调用方，「入参是完整流、缺 finish 就补」的语义
  正是事故来源，留着只会被下一次误用。整条流折叠仍由 `chunksToCompletion` 负责。
- `lib/engine/llm-bridge.js` 的流式循环改为 `for (const frame of streamChunkToSse(chunk, {...})) res.write(frame)`。

### 验证

- `test-engine-llm-bridge.mjs` 新增「非结尾 chunk 不得提前补 finish_reason」
  （断言 finish 序列为 `["tool_calls"]`、以 `data: [DONE]` 收尾）与「同一 index 的参数分片
  拼到同一个 `tool_calls` 条目」；对修复前的实现为红（实测序列 `["stop","tool_calls","tool_calls","tool_calls"]`）。
  现 25 项全绿。
- `test-engine-bridge.mjs` 的 3 个 `chunksToSse` 用例改写为 `streamChunkToSse` 逐帧用例，
  并新增「reasoning/block 类 chunk 不产出任何帧」。现 25 项全绿。
- 全套 36 个测试文件（跳过 `test-wiki-anchors.mjs` 的文档锚点检查外）全部通过。
## 0.17.12 — 2026-11-03

### 四个仓库恒定 partial：质量门没错，产物真的缺页

用户报「过夜后 4 个仓库每轮都 partial、written 恒为 5」。先怀疑质量门误判，实测后否掉了：
用上游自带的 `be.module_naming.find_missing_module_docs` 跑真机 docs，`dsh-git-worktree`
的 26 个模块里有 24 个没有对应页——产物真的缺。本地判据当时报 23 条，比上游少 1 条，
差的正是「模块搬家」那个：`workspace_provider_lifecycle` 在树里已挪到
`…/session_checkout_runtime/` 下，而磁盘上只有旧路径 `worktree_lifecycle_management_core/`
里的同名页。本地的扁平比对按 basename 兜底，把旧位置的同名页当成已存在。

缺页的成因链（每一步都有现场物证）：

1. 增量轮图 diff 非空但 `r_leaf=0.71 > tau=0.50`，触发 `full_fallback`
   （`orchestrator.py`）。上游把旧 docs 整体移到 `<docsDir>.prev-<commit>` 后重建，
   只记 `previous_docs` 路径、**不搬回**。
2. 该轮重建期间宿主进程消失（静默 5 分 13 秒，未达 10 分钟静默阈值），26 个模块只写出 2 篇。
   上游 `cli/adapters/doc_generator.py` 只在 `outcome in ("incremental","no_change")` 时校验
   缺页，`full_fallback` 不在其中，于是「26 树 + 2 页」落盘不报错。
3. 宿主重放同一 docsDir：旧图已被上一段写成新图 → 下一轮 `diff.is_empty` →
   `OUTCOME_NO_CHANGE` 早退（`LLM calls: 0`），Step 5 与 Step 6.1 都不执行，缺页永远不补。
4. 质量门每轮照跑、按整棵树判 `article-missing` → 恒 partial。

上游语义不是「缺页免责」：`documentation_generator` 明确「遍历完整树是安全的，已有页会短路」
（缺的要补），`no_change` 轮也校验缺页。所以修法不是豁免，而是把缺口补上。

### 判据对齐上游的层级口径

`lib/engine/mapping.js` 过去把所有模块塞进一张扁平的 `byName` 表，丢弃层级路径，
于是「同一模块换到更深一层」看起来仍是「页已存在」。上游 `doc_layout.module_doc_relpath()`
是 `hierarchical` 取 `path[:-1]` 作目录、`path[-1]` 作文件名，`flat` 落在根部，
`find_doc()` 先试层级路径再退根部同名、**不认其它目录的同名页**。现在：

- `indexModuleTree` 的节点新增 `modulePath`（完整层级，含自己），`parent` 改为父名。
- 新增 `moduleDocRelPath(modulePath, layout)`，与上游同一口径。
- `findMissingModuleDocs` / `staleDocPages` 都改用层级口径；空树（whole-repository 模式
  没有权威模块名）不点任何页。

改用层级口径后，真机 `dsh-git-worktree` 报 **24 缺页 / 17 陈页**，缺页数与上游校验器完全一致。

### 缺页即转修复性全量，并先清退不属于当前模块树的旧页

`lib/engine/native-run.js` 在增量水合之后、决议冻结之前检查产物完整性：模块树里有模块
没有对应页时，把 `resolution` 改成 `FULL`（不是豁免缺页），并记一条可查的 note。
只补写不清退不够——模块重聚类后旧页名还在 docsDir 里，引擎写完全部新页后旧页仍会被
映射成 `unmapped-page`，质量门照样 partial。因此修复前先用 `staleDocPages` 把
`<模块名>.md` 之外、也不在当前模块树里的 `.md` 从 **docsDir（仓库外的临时产物目录）**
删掉，并记下清退数量。已提交的 wiki 页仍由落地器按写集与孤儿判定处理，这里不碰仓库。

质量门判据一个字都没放宽：`article-missing` 仍然是阻塞项，`partial` 仍然不推进基线。
改的是「发现缺口之后做什么」，不是「缺口算不算问题」。

### 全量模块代理并行（`moduleConcurrency` 真正生效）

新增 `lib/engine/python/full_parallel_runtime.py`，只替换 `DocumentationGenerator`
的 `_generate_modules_in_order`，吸收社区 fork 中可用的部分：

- 模块级 `asyncio.Semaphore` 限流（不用 fork 的请求级 `AgentSlots` 借还机制：那套为
  「父代理等子代理时让出槽位」设计，模块级闸门没有这种等待，不会死锁）。
- 父节点等全部子节点完成后再写自己的 overview，兄弟分支互不阻塞。
- `FileManager.save_json`/`load_json` 在**类方法层面**替换：`module_tree.json` 的写入走
  锁内 read-merge-write，只补缺节点；同路径 components 不一致直接抛错而不是静默取一个。
  只在 `documentation_generator` 模块里替换 `file_manager` 名字是不够的——真实后端
  （`pydantic_ai_backend` / `caw_backend`）用的是各自 import 的那份，并行分支仍会互相覆盖
  （这一点由读-睡-写竞态夹具红过再绿的用例钉住）。
- 收尾保留上游三件事：`validate_module_file_coverage` → `organize_docs` → 有失败就
  `raise RuntimeError("Documentation failed for modules: …")`。fork 里被删掉的失败清单
  与覆盖校验一概不吸收。
- 空模块树走与上游一致的整仓分支（`preserve_incomplete_overviews` + `complete_file_candidates`）。

### 测试夹具改到 flat 布局

假引擎过去把页写在 `modules/core.md`，那不是任何 layout 的落地位置。本地判据与上游对齐后，
这些页被正确判成缺页，增量用例批量红。夹具改为 `core.md` / `web.md` 并把 metadata 的
`layout` 记为 `flat`——这才与真实产物一致（本仓库真机产物也是 `layout: flat`）。

### 验证

- `test-engine-output.mjs` 26 项：新增 `moduleDocRelPath`、层级口径缺页、搬家场景、陈页清退
  （含「空树不点页」与「旧路径同名页算陈页」）。
- `test-engine-native-incremental.mjs` 123 项：新增用例 12「源码无变化但产物缺页 → 自动转
  全量补写」，断言决议 `full`、notes 说明理由、确实以全量重跑、终态 `done`、缺的页被补写、
  旧页被清退。
- `test-upstream-parallel.mjs` 8 项：同层并行用 `max_inflight` 断言（并发 1 时必须为 1），
  并含真实读-睡-写竞态下的树合并用例。
- `test-fsoft-runtime.mjs` 6 项：增量叶子并行、写冲突串行重跑、断点续跑、签名漂移拒复用。
- 全套 36 个测试文件：35 个全绿（含 `test-engine-output-real.mjs` 11 项真实产物断言）；
  `test-wiki-anchors.mjs` 的失败项为本次改动后的文档符号滞后，随本轮 `codewiki_generate` 重编译消除。
## 0.17.11 — 2026-11-02

### 仓库总览把「正在跑」显示成「失败」

用户反馈面板总览五个仓库齐刷刷标「失败」，而实际它们刚被自动调度拉起来在跑。查下来是
`lastJob` 的选取用了「先到者胜」：`service.list()` 按提交顺序返回，`putCwd` 里
`if (!lastByCwd.get(k)) set(...)` 于是同仓有多个任务时永远显示**最旧**的那个——也就是
三小时前那批在 env 阶段失败的旧任务。这个位置叫「上次编译」，要回答的是「这个仓库现在
怎么样了」，显示一个已被取代的失败任务比不显示更误导。

- 新增 `export function pickOverviewJob(jobs)`：活动任务优先，其次按 `updatedAt`、缺失时
  退回 `finishedAt`/`createdAt` 取最新；空/脏输入返回 `null`。
- `repos` 端点改为按仓库收集全部候选任务，再统一用该函数挑选，不再「谁先到谁上」。

### 验证

- `test-orchestration.mjs` 新增 5 项断言：活动优先于更晚的失败、终态之间取最新、多个
  活动任务取最新、空/脏输入返回 null、老 job 回退 `finishedAt` 比较。
- 用真机 31 条任务实测：五个仓库分别显示 `articles` / `queued` ×4，不再是旧的 `failed`。
## 0.17.10 — 2026-11-02

### 根页别名豁免不彻底：入口页不在产物里就仍报死链

0.17.9 给根页别名（`README.md`/`overview.md` → `CodeWiki.md`）开了豁免，但判据里还留着
「`CodeWiki.md` 必须出现在落地集或引擎产物里」。入口页由本插件维护，这两处通常都没有，
于是豁免形同虚设：真机 `job-mvzdjxh8-1` 又报了两条同源死链（`testing_fixtures.md` 引用
同属父模块的 `./README.md`）。改为「根页别名即命中」——入口缺页由 `entry-missing`
单独负责，死链判定不该替它发言，也不该因为入口页不在产物里就把整批文章判 partial。

### 代码示例被当成真链接：文档解释契约反被契约判违规

同一轮剩下的 4 条 `article-contract` 阻塞项，全部是文章在**讲链接语法**：
`article_validation.md` 用反引号里的 `](xxx.md)` 说明死链判据，`plan_application` 与
`codewiki_vendor_binary` 同理。收集链接的正则不区分代码与正文，于是「文档解释了契约」
被契约判成违规拒写——这是最不该发生的一类误报，它惩罚的正是写清楚机制的那一篇。

- `lib/article-contract.js` 新增 `stripCode(text)`：按行状态机剥掉围栏块与行内代码，
  **替换成等长空白**。等长是硬契约——`rewritePageLinks` 要按匹配偏移回写原文，长度一变
  就整体错位（第一版用空串占位，症状是真实夹具两篇都判死链、渲染出 0 篇）。
  `collectWikiLinks` 改为先剥代码再收集。
- `lib/engine/quality-gate.js` 的 `rewritePageLinks` 重写为「在剥代码后的副本上找匹配 →
  记录偏移与长度 → 倒序回写原文」：示例文本原样保留，真实链接照常改写。

### 验证

- `test-article-contract.mjs` 31 项：新增「行内代码与代码块里的链接写法不算真链接」。
- `test-engine-quality-gate.mjs` 34 项：新增「行内代码里的链接写法不计入真实链接」
  （主动往真实产物夹具里注入一行 `` `](xxx.md)` `` 示例，否则断言会空转）。
- 用真实产物（32 页）实测：290 条真实链接 **0 失效**（0.17.9 修复前 412 条失效）。
- 全套 36 个文件：35 绿；`test-wiki-anchors.mjs` 2523 过 / 32 败 / 203 待重编译，均为
  文档滞后（重编译推进基线后自动升级为硬断言）。
## 0.17.9 — 2026-11-02

### 跨页链接全部失效：wiki 里点任何一页都是 404

起因是面板截图里三条 `quality-gate` 阻塞项。逐个核下去，其中一条不是误报，而是把
一个更严重的问题暴露了出来：**引擎产出的每一篇之间都互相链不起来**。

引擎的页名是下划线形态（`agent_runtime.md`），落地时 `mapping.js` 的 `moduleSlug()`
把非字母数字一律换成 `-` 并小写（`agent-runtime.md`），而正文里的跨页链接仍然写着
原名。实测本仓 420 条 wiki 内部链接里 **412 条点开即 404**——`19721a54` 之后产出的
页全部如此。质量门此前也报不出来：死链判定的命中集合里带着「浏览器里不存在的原始
页名」，把「页存在于引擎产物、但落地后被改名」这种情况当成了命中放过。

- `lib/engine/quality-gate.js` 新增 `rewritePageLinks(text, pageMap, articleWikiPath)`，
  `renderArticle` 增加 `pageMap` 参数：只重写指向 `.md` 的链接，外链与非 md 相对路径
  （源码引用）原样保留；同目录链接直接写文件名，跨目录补 `./`。
- `gateNativeOutput` 由映射结果构造 `pageMap`（`source → wikiPath`，根页指向
  `CodeWiki.md`），既传给渲染做重写，也作为契约层的允许链接集合。
- `lib/engine/output.js` 的死链判定改为只认「能落地的页」：保留原始页名是为了照顾
  渲染前的形态，去掉 `collected.pages.includes(resolved)` 这条放宽——页在产物里但没被
  映射进落地方案，落地后就是真死链。根页别名（`README.md`/`overview.md`）继续豁免。

### 质量门两处误报

- `hasDuplicateFrontmatter` 不跳代码围栏，把正文里演示 frontmatter 的 ```yaml 示例
  当成「重复贴头」拒写。改为带 `inFence` 状态机的实现，围栏内的 `---` 不参与配对，
  围栏外真重复仍然判出（真机 `codewiki_vendor_binary.md`）。
- 根页别名：上游把入口页写 `README.md`/`overview.md`，本 wiki 入口是 `CodeWiki.md`，
  链接到它们不是死链（真机 `job-mvzbcw87-0` 因这条误报判了 partial）。只豁免根目录下
  这两个名字，子目录里的 `README.md` 仍按真实目标校验。

### 面板：步骤条裸键名与已退役的合成阶段

- 步骤条第 7 项显示裸键名 `stepCommit`：0.17.5 把「提交」接进步骤条，字典里却没补这项。
  补 `stepCommit`（提交 / Commit），删除已退役的 `stepCompose`。
- 步骤条仍画「合成」：`ACTIVE_STAGES` 与 `STAGE_WEIGHTS` 里还有 compose，而 0.17.5 起
  `STAGE_HANDLER` 已无该阶段。去掉 compose，权重重新分配为
  `articles 0.66 / crosscut 0.11 / review 0.16 / index 0.05 / commit 0.02`（合计仍为 1）。
- `codewiki_progress` 的工具描述同步去掉 compose。

### 验证

- `test-engine-quality-gate.mjs` 33 项：新增「跨页链接按落地路径重写」「真实产物渲染后
  每个链接都指向落地页」；`test-engine-output.mjs` 22 项：新增根页别名与子目录对照。
- `test-client-panel.mjs` 5 项：新增「步骤条每个阶段都有中英文文案」，该用例在修复前
  对 `HEAD` 的 client.js 是红的。
- `test-article-contract.mjs` 30 项：新增围栏内 frontmatter 示例不算重复贴头。

## 0.17.8 — 2026-11-02

### 单模块请求上限可配置（默认 300）

上游 `1b4af43` 给写作加了补写校验：模块跑完没写出页面时，会在同一对话里续发最多
2 次提醒，**每次提醒都是一次独立的 `agent.run(usage_limits=...)`，各自吃满一份请求
预算**。而 `entry.py` 把 `request_limit` 硬编码成上游默认的 100。真机上本仓库全量
编译时，大模块 `Extension_Host_Execution_Orchestration/change_set_management` 撞满
100 次请求，pydantic-ai 抛 `The next request would exceed the request_limit of 100`，
经 `_classify_exception` 翻成 `article-missing`，整轮从 `done` 掉成 `partial`——
**已经写好的 31 篇白写，基线也不推进**。失败显式化本身是对的（这正是同步上游要的
语义），错的是预算。

现在它是设置项 `requestLimit`（默认 300，范围 1–1000）：`index.js` 的 `Config` 与
`liveConfig` → `runNativeJob({ requestLimit })` → 引擎 `payload.requestLimit` →
`config["request_limit"]`。非正值一律退回默认 300（0 会让 agent 循环一开就撞上限，
比用 100 更糟），超 1000 夹到 1000。设置页在「编译模型」区加了对应输入框与保存期
校验。

### 验证

`test-config.mjs` 新增 5 项断言（默认 300、显式值透出、下限 1、硬顶 1000、非正值
退回默认）；`test-engine-python-entry.mjs` 22 项、`test-engine-native-job.mjs` 137 项、
`test-client-panel.mjs` 4 项、`test-orchestration.mjs` 全部通过。

## 0.17.7 — 2026-11-02

### 修引擎锁：升级上游后不能自己卡死在 env 阶段

0.17.6 把 `UPSTREAM_COMMIT` 从 `03d0a294` 换到 `1b4af43` 之后，所有既有仓库的
`.codewiki/engine-lock.json` 仍指向旧 commit，`compareLock` 因此报 `drift`，而
`lib/engine/native-run.js:291` 对 `drift` 是直接 `settle({outcome:"failed", stage:"env"})`
（`engine-deps`）——下一轮原生编译会在环境校验这一步就失败，而不是跑起来。落锁原本只
在 `absent` 时发生（那时把 `buildLockBody` 放进 apply 写集，与产物同批提交），`drift`
没有对应的自动修复路径。

这次用 `buildLockBody` 生成与引擎自己落锁完全一致的正文，把 5 个受管仓库的锁重写到当前
上游：指纹 `08d65ee03119e8eb` → `815347593ef61e2a`。`version`/`pythonVersion` 沿用旧锁定
值——本次只修「上游源码 commit 指错了」，环境本身没有变化。

### 验证

- 用生产路径（`nativeEnginePlan` + `runEngine`）跑真实 doctor：`outcome: done`，
  `engine: 2.0.0 / python 3.12.10 / deps ok`。
- 对 5 个仓库逐个 `doctor({ probe, repoRoot })`：全部 `status: match`，无 `diffs`。
- `test-engine-manifest.mjs` 27 passed；`test-engine-python-entry.mjs` 22 passed；
  `test-upstream-parallel.mjs` 8 passed。

## 0.17.6 — 2026-11-02

### 同步上游 15 个提交：写作失败不再静默、模块边界按文件归属

锁定的上游 commit 一直是错的：`lib/engine/manifest.js` 写的是 `03d0a294…`，
而那个对象在本机 clone 里根本不存在（`git cat-file` 报 `could not get object
info`），`compareLock()` 等于一直在比对两棵不同的源码树。这次把锁改成实际运行的
`1b4af43d…`（2026-11-01），并把中间 15 个提交（56 文件 / +3449 −358）一并同步。

三个直接改善质量的问题：

- **写完不落盘现在会被发现**（上游 `doc_guard.py`）。agent 跑完只回一段话、页面没写
  的情况过去被当成成功，现在会在**同一对话里**续发提醒（最多 2 次），点名要求
  `str_replace_editor` 用 `working_dir="docs"`、`command="create"` 建页；仍然没写则抛
  `DocumentationWriteError`。
- **总览页失败不再毁掉整棵子树**（上游 `overview_support.py`）。子文档摘录直接进
  prompt，不再要求 overview 模型自己读文件；失败时 `preserve_incomplete_overviews`
  把旧页恢复回去，避免半截总览覆盖可用内容。
- **有模块写失败就显式报错**，不再 `logger.error` 之后 continue 假装成功。

模块划分也按文件归属收敛（上游 `module_scope.py`）：模块大小按文件内全部索引组件
算而不是只看入口点、一个文件只能有一个 leaf owner、过小模块并入邻近兄弟、委派前先
校验 `get_module_token_count`。叶子模块阈值 4000 → 8000，新增
`min_token_per_module = 1000`（`Config.__post_init__` 校验）。另外分析器补了 C/C++
指针返回值、C# 构造函数、C 宏 `(void)`、Dart/Java/Go 的解析修复。

### 失败语义：模块写失败降 partial，不丢已写内容

上游让「有模块失败就 raise」，而我们的 `_classify_exception` 只按异常类型分类，
`RuntimeError` 会落进笼统的 `engine-crashed`。这有两个问题：已写文章虽然会被
`_salvage` 兜成 partial（这条路径 0.17.0 就有），但 blockers 只说「编译中断」，
用户不知道该重跑哪一块。

现在识别 `RuntimeError` 且消息以 `Documentation failed for modules:` 开头的形态，
拆出失败模块清单，blockers 逐条给 `article-missing` 并点名模块路径。真正的崩溃/
模型失败仍走原来的 `_salvage` 路径。

### 并行补丁重导

上游在 `_generate_modules_in_order` 里加了 `failures` 与最终的 raise，与我们的
「按拓扑层并行」正面相撞。用 `git apply --3way` 解两处冲突：保留上游的
`failures = []`，保留我们的子树合并逻辑，并把 `asyncio.gather` 结果里的 `err`
**追加进 `failures`** —— 否则并行化会把上游新增的失败判据悄悄吃掉。
`patches/README.md` 记了这两步的收口理由与新的应用方式（`--3way` 必需）。

### 验证

全新 venv 上实测：`doc_guard` / `overview_support` / `module_scope` 均可导入，
`DocumentationGenerator._generate_modules_in_order` 同时含 `asyncio.gather` 与
`Documentation failed for modules`，叶子阈值 8000、最小模块 1000。
`test-upstream-parallel.mjs` 8 项通过（新增「失败模块进异常消息」断言，并改为在
外层捕获上游的 raise）；`test-engine-python-entry.mjs` 22 项通过（新增「上游模块
失败异常要降 partial 并点名失败模块」）；`test-fsoft-runtime.mjs` 6 项通过，证明
增量 Step 5 的锚点在升级后仍然命中。其余 33 个测试文件全绿。

## 0.17.5 — 2026-11-02

### 会话页看不见「正在进行的任务」

会话标签页只读「LLM 请求记录」，而记录只在真的发出请求后才存在。于是一个正在跑依赖图/
聚类/落盘、或本轮根本无需写文章（增量直接命中）的任务，在会话页里完全不可见：面板任务页
明明显示它在动，会话页却只有一堆旧记录，看起来像「没在跑」。真机上一轮增量编译的会话
目录里连该 job 的子目录都不存在（NDJSON 只有 11 条 progress + 2 条 stderr，http 条目 0 条），
正是这个原因。

现在会话端点在原有 `sessions` 之外多返回一个 `active`：仍在跑的任务本身，带阶段、原生阶段与
百分比、已写篇数、批量进度和**已发请求数**（0 表示此刻还没发），按开始时间倒序。面板在请求
列表上方单独列出这一块，有进行中任务时不再显示「暂无会话记录」。

### 设置页清理与大档开关

- 删除 `planMode`、`symbolIncremental`、`agenticArticles`、`agenticMaxSteps` 四个设置项。
  `planMode`/`symbolIncremental` 早已是纯兼容残留（对应实现随 0.16.0 阶段 7 退役）；
  `agenticArticles`/`agenticMaxSteps` 描述的是「写作走哪条通道」「工具循环最多几步」，
  而写作通道已经只剩一条。
- 大档模型改为显式开关 `bigEnabled`（默认开）。此前靠「`bigProvider` 留空」表达关闭——一个
  空字符串承担开关语义，设了模型再清空就等于关掉，而模型名与预算一并丢失。现在 `bigEnabled`
  是唯一判据：关闭时 `liveConfig` 直接把 `bigProvider` 置空，五处按「大档是否配置」判定的
  下游路径（文章写作双池、横切/校对大档装填、`markBigAgenticTasks`）一并退回默认档，而
  `bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`bigConcurrency` 的取值保留，重新打开
  不需要重填。设置页把大档整组字段收进开关之下，关闭时折叠。

### 单轮写作通道退役

写作原本有两条通道：agentic 工具循环（模型按需 `read_code`）与「整包内联」单轮（把整个模块
源码塞进一个 prompt，超预算就拆观察批→合成批）。后者在 0.13.0 后只剩兼容价值，而它带来的
是三类长期问题：大模块必须拆两轮才能写、拆分决策要写进 notes 却没人看得懂、以及模块源码
超预算时的一次性失败。现在整条删除：`prepareArticleTasks`、`batchArticlePrompt`、
`shouldFallBackFromAgentic`、`batchObservePrompt`、`batchArticleObservePrompt`、
`batchArticleComposePrompt`，以及 `tickArticles` 的观察批收割、`tickCrosscut` 的
`crosscutSplit` 分支、`tickCompose` 与 `submitComposeBatch`。横切改为单批直出（仅超预算时
打大档标记）。

校对阶段的「单篇源码连大档都装不下就转会话模型」兜底**保留**——它服务的对象是超大单文件，
与写作通道是两件事。

### 验证

新增 `test-config.mjs`（设置项契约：四个退役字段不得回流、`bigEnabled` 两侧行为、真实
`markBigAgenticTasks` 的标记结果）。`test-sessions.mjs` 增加 8 项 `activeSessionJobs` 断言
（终态剔除、排序、请求计数、零请求仍列出）；`test-client-panel.mjs` 增加 2 项会话页渲染断言，
在改动前的 client.js 上是红的。`test-orchestration.mjs` 的 mock 改为会写含 `type`/
`source_files` 的 agentic 文章，两组依赖观察批/合成批计数的用例随通道退役改写；
`test-batch.mjs` 删掉三节单轮通道断言；`test-agentic-fallback.mjs` 按「逐篇收敛、互不牵连」
重写。全套 35 个测试文件通过。


## 0.17.4 — 2026-11-02

### 僵尸排队项永久卡死

宿主重启前提交、还没开始执行的任务会永远停在 `queued`。`tick` 里「别的实例拥有的任务」
分支对 `queued`/`submitting` 直接 `continue`（本意是这两个阶段没有执行器可丢，不能当孤儿
接管），但没有任何替代路径把它唤醒或终结。后果是双向的：它既占着单项目串行的闸门窗口，
又因为 `findActiveJob` 把 `queued` 算作活动任务，让同一仓库的幂等一直命中它——用户想重新
提交都只能拿回这条僵尸任务。真机上积了 4 条，最久的停更 18 小时。

处置口径按来源分流（`planForeignJob`）：

- **自动调度**（`auto: true`）遗留的排队项直接作废。理由：自动更新下一轮扫描会重新提交，
  而 18 小时前的旧任务突然跑起来要占掉几小时。
- **用户手动提交**的排队项由当前实例接管、继续排队。理由：那是用户明确要求的编译，不能
  因为换了宿主就消失。
- `submitting`（提交写到一半）作废：没有可续状态，任何来源都无法恢复。
- 对方实例还活着、或任务属于自己，一律不动。

作废走 `fail(job, reason, { notify: false })`——被取代不是编译失败，不推「编译失败」唤醒
会话；`lib/job-store.js` 的 `planForeignJob` 是纯函数，tick 与测试共用同一份判定。

### 验证

`test-job-reliability.mjs` 125 项通过（新增「用例 7b」14 项：两条处置规则、提交占位作废、
对方存活不抢、自己任务不动、无 owner 历史残留接管，以及共享磁盘的端到端——作废后同仓可
重新提交、被接管的排队项仍占住幂等）。

## 0.17.3 — 2026-11-02

### 面板白屏：`t is not defined`

0.17.1 给侧边栏面板加引擎日志块时，`engineLogBlock` 与 `jobCard` 用的是各自组件内的
`t`——但它们定义在 `CodewikiPanel` 之外，闭包里根本没有这个绑定。于是任何一次渲染
（任务列表里有一个带 `nativeLogs` 的任务即可）都在 `engineLogBlock(job)` 处抛
`ReferenceError: t is not defined`，被面板顶层 try/catch 兜成「Panel error: …」整块白屏。
两处各补 `const t = tBound`，与同文件其它模块级渲染辅助函数一致。

`node --check` 与协议层测试都发现不了这类缺陷：它不是语法错，也不经过引擎边界。新增
`test-client-panel.mjs` 用最小 React 桩把面板真的渲染一遍（切换到任务 Tab、带一个
含引擎日志的已完成任务），断言不出现 `Panel error` 且日志块与文案都正常渲染；该用例在
本修复前是红的（`ReferenceError: t is not defined`）。

### 验证

`test-client-panel.mjs` 2 项通过；`test-engine-client.mjs` 29 项通过；`node --check
index.js client.js` 通过。

## 0.17.2 — 2026-11-01

### 增量并行与跨重启断点续跑

- 原生增量轮不再严格逐叶串行：各叶子先在独立产物目录、模块树与记录中运行，按实际写页合并；没有写冲突的叶子并行，写同一页面或改变模块树的后序叶子在合并现场按原顺序重跑。默认并发为 3，仍受 `moduleConcurrency` 的 1–8 上限约束。
- 每个增量叶子终态后原子保存检查点。宿主异常退出后，新实例保留原 `docsDir`，水合历史状态时不再覆盖本轮现场；签名匹配时跳过已完成叶子，代码、图、模块树、顺序或选项变化则拒绝复用。
- 全量轮同样保留异常退出现场，借助原生引擎已有的模块树与文章复用逻辑继续，不再由宿主主动删掉半成品后从头开始。
- 恢复只减少重复写作：依赖分析、缺失页处理、质量闸、状态采集与落地事务每轮仍完整执行。正常失败和取消仍清理现场，不会被误当成可续跑任务。
- 运行时适配以 FSoft `IncrementalUpdater._run` 的 Step 5 精确源码为锚点，上游结构变化时明确拒绝安装，不静默退回另一套算法。

### 验证

新增 `test-fsoft-runtime.mjs` 5 项：真实并行、写冲突重跑、宿主中断后续跑、签名漂移拒绝复用、生产源码锚点；`test-job-reliability.mjs` 111 项、`test-engine-native-job.mjs` 137 项、`test-engine-native-incremental.mjs` 108 项及既有编排、质量门、落地与 Python 入口回归。

## 0.17.1 — 2026-11-01

### 真机可观测性：99 分钟的编译到底在干什么，现在能查了

起因是一次真实编译：本仓库一轮增量编译耗时 99.6 分钟（`stageTimings.articles` 占
99.9%），而面板上它从第 3 分钟到第 99 分钟一直显示「已写 10 篇 · 引擎阶段 聚合类模块
36%」，看不出是在慢跑还是已经僵死。逐条查下来是三个独立的观测缺陷——编译结果本身是
对的（`done`、产物已提交 `5b50cdd9`），但**过程完全不可解释**。

### 进度：写文章阶段的百分比不再冻结

FSoft 在阶段 3（Documentation Generation）内部的所有 `update_stage` 都写在
`if self.verbose:` 里，而 `entry.py` 传的是 `verbose=False`——于是从
`start_stage(3)` 到 `complete_stage()` 之间一帧进度都不发，百分比停在槽位起点。
现在 `articles` 槽位内的百分比按「本轮已写篇数 / 本轮开始时 docs 里的 `.md` 篇数」
插值（`stage_map.articles_percent`），心跳帧也带真实篇数，面板能看出它在动。

顺带修掉一处更误导的错标：增量轮的 `_run_incremental_update` 借用了
`start_stage(2, "Incremental Update")` 的槽位，按阶段号会被映射成 `cluster`——面板把
整场文章写作显示成「聚合类模块」。现在按 description 里的 `incremental update` 标记
识别（`stage_map.is_incremental`），整轮报 `articles`。

### 用量：引擎报的 token 不再被丢掉

`entry.py` 从 FSoft 的 `usage_ledger` 汇总出 `inputTokens/outputTokens/cachedTokens/
requests` 并随 `result` 回传，`native-run.js` 也一路带到了 `EngineResult.usage`——但
`index.js` 的收割段从来没把它写进 `job.usage`，面板与 `codewiki_progress` 恒显示 0。
现在按字段映射落账（沿用旧通道的 `inputTok/outputTok/requests` 形状），并写进
`nativeResult.usage` 便于事后核对。

### 日志：引擎事件落盘 + 面板可查 + 端点可翻

此前 `onLog` 只把事件塞进 `job.nativeLogs` 的最近 20 条内存数组，而这个字段既不进
`jobSummary` 也不被面板渲染——真机上 99 分钟的编译结束后，能查到的日志只有最后 3
分钟（20 条桥请求）。现在：

- 新增 `lib/job-logs.js`：逐条追加到仓库外的 NDJSON（默认
  `%TEMP%/dsh-codewiki-logs/<jobId>.ndjson`，可用 `DSH_CODEWIKI_LOG_DIR` /
  `DSH_CODEWIKI_LOG_MAX_BYTES` 覆盖），单文件上限 2MB，超限保留后半段现场。
- 进度帧按「阶段|百分比|篇数」去重后入档：引擎每秒可能发好几帧，全量落盘只会把
  桥请求失败、stderr、阶段切换这些真正有用的事件挤出去。
- `jobSummary` 增加 `nativeLogs`（最近 40 条）、`logFile`、`logError`；面板新增可展开
  的「引擎日志」块；新增 `GET /api/codewiki/logs?jobId=&limit=` 翻全量。
- 日志写不进去不再静默：记 `job.logError` 并在 notes 里明说「后续只在内存里保留
  最近 40 条」。

### 验证

`test-job-logs.mjs`（新增，12 项：写入/读回、坏行跳过、缺失文件、体积上限、幂等删除）、
`test-engine-native-job.mjs` 137 项（新增用例 24 用量落账、用例 25 日志落盘与端点可见）、
`test-engine-python-entry.mjs` 21 项（新增增量轮识别与 articles 插值断言）、
`test-orchestration.mjs` 257 项、`test-job-reliability.mjs` 109 项、
`test-engine-client.mjs` 29 项、`test-engine-quality-gate.mjs` 31 项、
`test-engine-apply-plan.mjs` 41 项、`test-engine-native-incremental.mjs` 104 项、
`test-engine-contract.mjs` 全 PASS。

## 0.17.0 — 2026-11-01

### 任务生命周期：从「能跑」到「换实例、被取消、半路死掉都能收场」

这一版没有加新能力，全部是**生命周期与交付状态**的修补。起因是一次现状审查：主架构
（常驻服务 + 原生引擎裁决链 + 事务落地）是合理的，但「引擎跑完」「wiki 落库」「Git 交付」
这三种状态在代码里被同一个 `canAdvanceBaseline` 字段混着表达，于是任何一条链路出问题都会
表现成「任务看起来做完了，其实没交付」或「已经交付了，却一直催你提交」。

**1. 基线语义收敛为一个判据：`done`**

`canAdvanceBaseline` 此前在三个地方各有一套算法：`lib/engine/native-run.js` 按
`outcome==='partial' && rawTreeFiles>0` 推算、`lib/engine/apply-plan.js` 按
`applied && baseline.advanced`、`index.js` 的 `finishJob` 又按最终 `done` 重算。同一个名字
在 job 文件里能同时表示「质量门许可」「落地器已推进」「最终完整性」三种事实，读的人无从判断。

现在拆成三个字段，各管一件事：

| 字段 | 含义 | 唯一来源 |
|------|------|---------|
| `baselineEligible` | 质量门**许可**推进基线 | `lib/engine/quality-gate.js`（`outcome==='done'`，`canAdvanceBaseline` 作为兼容别名同值） |
| `baselineAdvanced` | 基线**事实上**是否已前移 | `lib/engine/apply-plan.js` 的 `cw meta update` 结果 |
| `deliveryComplete` | 本轮是否完整交付（产物入库 + 基线推进 + 无 blocker） | `index.js` 的 `finishJob` |

`finishJob` 不再用 `stage==='done'` 反推基线事实，改为读 `baselineAdvanced`。因此
「产物提交失败」这类场景能如实显示 `baselineAdvanced:true` + `deliveryComplete:false`，
而不是二者一起为假。

**2. 首次编译不再必然 `partial`**

旧的质量门把本轮刚 `cw init` 出来的空骨架判成「未入库基线（`baseline-uncommitted`）」，
于是**第一次编译无论多成功都只能 `partial`**，基线也不推进，下一轮得从头再跑一遍。测试里
甚至有专门用例（`preInit`）绕开这个限制，说明它早被当成既成事实。

修法是把「空骨架」单独判成一类：`isEmptyBaseline(base)` —— 无编译提交、来源是
`worktree-only` 或 `git-head` 即判 `baseline-absent`（不阻塞）；已有进度的未提交基线与
脏工作区仍然阻塞。初版实现用「读 `_meta.yaml` 里是否写着 `last_compiled_commit: null`」
做启发式判断，在 `cw init` 已把骨架提交进 HEAD 的场景下失效（来源变成 `git-head`），
已删除该分支，只保留结构判据。

**3. 原生任务跨重启接管**

此前 native 通道一旦宿主重启，`nativeRuns` 丢失，tick 直接判 failed 并提示「重新提交编译」；
而工具描述却写着「宿主重启后活动任务自动恢复推进」。现在：

- `lib/job-store.js` 的 `snapshotNativeRun` 在每次原生推进后落一份**非敏感**快照
  （cwd、wikiPath、kind/scope、attempt、引擎通道参数，不含凭证）；
- 重启后 `planNativeReplay` 给出重放计划：无快照/已完成/被取消 → 不重放；有快照则重跑当前
  阶段，`attempt` 最多 3 次（取 `plan.attempt`，否则重试上限形同虚设），旧 `docsDir` 在新
  run 之前清掉；
- 取消是终态：`cancelRequested` 的任务不重放；
- 被取消/已收割的结果不再丢弃：`tickNative` 先收割已有结果，再处理取消请求——此前取消分支
  直接 `nativeResults.delete()`，会把**已经 apply/meta/commit 成功、只差收尾**的结果一起扔掉，
  磁盘上产物落地了而任务终态写的是 cancelled。

**4. 旧实例接管与幽灵任务**

- `mergeFromDisk` 此前是纯并集（只增不删）：磁盘上已被清理（Temp 终态回收、`MAX_JOBS_KEPT`
  截断、别的实例删除）的任务会永远留在本实例内存里，且因为不是终态而**永久占住单项目串行
  闸门**，新提交一律排队、永不推进。现在按 `diskIds ∪ 自己的任务 ∪ dirty` 回收，幽灵任务
  随 merge 消失。
- 新增 `occupancyHeld(job)`：他人任务停更超过 `ORPHAN_TAKEOVER_MS` 就不算占闸门。此前只能
  等原实例自己回来推进，而它可能已经不在了。
- `stop()` 之后飞行中的 tick 仍会 `flush` 内存旧阶段，把别的实例已推进到终态的任务「复活」
  成 `index`。新增 `stopped` 标志，`tick()` 与 `flush()` 开头直接返回。

**5. 持久化与跨实例幂等（`lib/job-store.js`，新增 415 行）**

`saveJobs` 此前直接 `fs.writeFileSync(JOBS_FILE)` 并吞掉异常，`loadJobs` 读失败返回空数组：
半写/损坏的任务文件会让整个任务现场静默消失。现在：

- `save` 走 tmp + fsync + rename（重试），损坏文件隔离成 `<file>.corrupt` **并显式报错**，
  而不是当成「没有任务」返回空（fail-open 会把下一次写入变成数据丢失）；
- tick 锁按 token 校验归属，锁存活判定只用文件 mtime（此前混用合成 `now`，会把活锁判死）；
- `findActiveJob` / `reassignSession` 跨实例幂等：每轮 merge 之后再判，同仓不再可能出现
  两个并行的活动任务；
- 心跳 `HEARTBEAT_MS=30000`、`lastSeenAt` 取 `heartbeatAt/updatedAt/createdAt` 的最大值，
  孤儿判定不再依赖单个字段。

**6. 交付状态回传到会话与面板**

`tickNative` 从未把原生结果的 `apply.commit` 写回 `job.autoCommit`，于是**原生任务自动提交
成功后仍会被判成「产物待提交」并唤醒会话催人提交**；而提交提醒只筛 `stage==='done'`，所有
`partial`（包括首次编译、提交失败）反而收不到提醒。两处都改为读同一份交付事实：
`job.autoCommit = res.apply.commit`，提醒覆盖所有「有产物但没提交成功」的终态。

**7. 旧通道（`nativeEngine:false`）终态**

`tickIndex` 先 `judgeOutcome`、再把索引/基线失败塞进 `hardBlockers`，但 `finishJob` 仍用
旧的判定结果，于是索引写失败也能收成 `done`。改为在 index/meta 之后二次 `judgeOutcome`，
并让 `baselineAdvanced` 反映 meta 是否真的成功。同时补上 wiki 骨架前置：仓库还没有
`.codewiki/` 时先 `cw init`；目录存在却缺 `_meta.yaml` 时记 `wiki-missing` blocker 且不推进
基线（与 `lib/engine/apply-plan.js` 的同类判据一致，不猜也不手写）。

**8. 文档与工具描述**

`codewiki_generate` 的工具描述还写着旧的四阶段与「宿主重启自动恢复」；`README` 的原生引擎
章节标题仍写「可选，默认关闭」，基线段落与 `partial` 段落互相矛盾（一处说 partial 可推进、
一处说不可）。已统一为本文档描述的语义。

**9. 「结果已到、进程不退」不再被改判成卡死**

协议不变量 4 早写着「语义以 `result` 为准，退出码只表达进程层结果」，但进程层只等 `exit`：
引擎发完 `result(done)` 后若卡在收尾（僵死的收尾线程、没关的 pipe、忘了 `return` 的事件
循环），这轮**已经确定成功**的编译会被 10 分钟静默阈值或 180 分钟超时改判成「卡死」→
`partial`、基线不推进，下一轮把同一批变化再跑一遍。

现在 `runEngine` 在收到 `result` 后给进程一个 `resultGraceMs`（默认 2000ms）的自行收场
窗口，超时就终止进程树按已有 `result` 收尾，并记一条 `result-grace` 日志把「引擎自己退」
与「我们杀」分开。顺带修 `nonzero-exit` 违规的误报：被我们主动终止的进程退出码是终止方式
的产物，不再记成引擎的非零退出。

### 安装形态：从 file:/// 直挂改为标准本地插件（profile bundle 依赖）

此前本插件靠 profile `cordis.patch.yml` 里手写的 `file:///…/index.js` insert 条目挂载，混在
一堆官方条目中间：换一台机器、换一个 profile 都得手工复制那段 YAML，`config` 还分散在两条
同 id 条目里（一条给三项、一条给十几项），改配置的人根本分不清哪条生效。

现在与 `dsh-git-worktree` / `dsh-frontend-design` / `@local/dsh-subagent-auto-router` 一致：
`package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，插件自带的那份 patch 里 insert
的是裸包名 `"@local/dsh-codewiki"`；profile 侧只要在 `dependencies` 加一条 `link:` 并在
`dsh.profile.bundles` 里登记包名，插件行就由 bundle 层自动合并，用户层只保留一条同 id 的
`- id: codewiki config:` 覆盖条目。`name` 必须是裸包名（不带 `/dsh` 子路径）——client 半边
的激活扫描只认裸包名行。

`file:///` 直挂仍保留为装法 B（改插件源码时不必建 link），README「安装」章节把两种装法并列
写清，并写明覆盖条目的 `config` 是整对象替换（未写的键回落到 `Config` 默认值，不与 bundle
层的 `config: {}` 深合并）——这一条不写清，用户改一项就会把其余十几项一起打回默认。

### 验证

- `test-job-reliability.mjs`（新增，109 项）：原子写、损坏隔离、锁归属、双实例幂等、原生
  重启重放、取消不复活、`queued`/`submitting` 不被抢、心跳与合并；
- `test-orchestration.mjs`（257 项）：补齐块间实例清理（此前 30+ 个 JobService 实例共享同一
  `JOBS_FILE` 且从不 `stop`，残留任务占住串行闸门）、重启重跑与旧 plan 迁移用例补 `cw init`
  夹具；
- `test-engine-client.mjs`（29 项）：新增「`result` 已到但进程不退 → 按 `result` 收尾」
  （`result-then-hang` 夹具，静默/超时都设得很大，证明是结果宽限先动手）；
- `test-engine-native-job.mjs` 121 项（新增用例 22 取消与落地交错、用例 23 `commitHintText`
  覆盖 `partial`）、`quality-gate` 31 项、`apply-plan` 41 项、`native-incremental` 104 项、
  `contract` 19 项，全部通过；全仓 30 套测试仅 `test-wiki-anchors.mjs` 报 9 处符号锚点失效
  （文档滞后，待 `codewiki_generate` 重编译）。

## 0.16.16 — 2026-10-30

### 面板两处修正：会话记录接到原生通道；焦点任务卡自报目录

**1. 「会话」标签页恒空 —— 根因是原生通道没接会话记录钩子**

会话记录的写入点此前只有两处：`startBatchChatRun`（index.js:2841）与
`startAgenticRun`（index.js:2896），都在并发池里挂 `onRequestStart`。
但 0.12.x 起 `nativeEngine` 就成了默认通道（提交 29bcde44），原生通道的模型请求
由 Python 引擎经 **loopback 桥**（`lib/engine/llm-bridge.js` 的 `startLlmBridge`）
打回宿主 `llm.stream`，桥里只有 `onLog`，没有任何会话记录钩子 ——
于是走默认通道的编译永远不产生记录，面板会话列表实测恒为 `{"sessions":[]}`。

修法（三条链路各改一处，钩子只传不落盘）：
- `lib/engine/llm-bridge.js`：`startLlmBridge` 新增 `onRequestStart` 参数；
  每个 `POST /v1/chat/completions` 开始时调一次，拿到 `{onDelta,onDone,onError}` 句柄，
  分别挂在 chunk 循环、正常收尾、异常分支上。新增 `messagesToPrompt(body)` 把
  OpenAI `messages` 拼成可读文本（`[role]\n正文`，content 支持 string 与 parts 数组），
  超 `MAX_SESSION_PROMPT_CHARS`（200k 字符）截断并**显式标注原长**——
  原生通道单请求输入可达 110k–420k token，全文落盘是几百 KB/请求，但静默截断会让
  看的人以为原文就这么短。`callSession()` 沙箱包裹回调：面板记账失败绝不影响模型请求。
- `lib/engine/native-run.js:467`：桥实例化处透传 `deps.onRequestStart`。
- `index.js:2675`（`startNativeRun`）：`onRequestStart: (task) => beginSessionRecord(job, task)`。
  `beginSessionRecord` 同时改为导出（与 `estimateTokens`/`classifySessionTask` 同一理由：
  并发池与桥两条路径都要喂它同一套字段，只有能直连测才锁得住字段一致性）。

凭证红线不变：记录只含 messages 文本与模型输出，不含 Authorization、不含占位 key；
新增用例专门断言记录里 `authorization` 与 `dsh-bridge-` 都不出现。

**2. 「会话」标签页套了两层滚动容器**

`tab === 'sessions'` 把 `SessionView` 渲染进已经带 `[data-dscw-p-page]` 的面板里，
而 `SessionView` 自己也套一层 —— 双层 padding + 双层 `height:100%` + 双层滚动条，
会话列表被压进一条窄缝里滚。`SessionView` 加 `embedded` 参数：嵌入时改用
`[data-dscw-p-sesswrap]`（无内边距、不自滚），标题收成一行 `[data-dscw-p-sessbar]`
（面板头部已有大标题，不再重复）。

**3. 进行中任务卡不显示所属目录**

`jobCard` 只在「历史任务」分组头标了 `repoName(cwd)`，焦点任务被排除在分组之外，
于是正在进行的任务完全看不出是哪个仓库的编译。现在 `job === focus` 时在行内
（Tag 之后）显示 `repoName(cwd)`（父目录/目录名两段，`title` 是全路径）。

**验证**：`node test-engine-llm-bridge.mjs` → 23 passed（新增 6 条钩子用例：
开始记一次、流式收尾的正文与 output token、失败走 onError 不影响 502、记录不含
Authorization/占位 key、超长截断标注、钩子抛错不拖垮请求）；`node test-engine-native-job.mjs`
→ 114/114（新增用例 21 锁「钩子透传到桥」）；`node test-sessions.mjs` → PASS（新增
`beginSessionRecord` 句柄用例 9 条）；其余 24 个测试文件全绿。另用真实桥 + 真实
`beginSessionRecord` 跑了一次端到端（临时脚本已删）：SSE 200 收尾、全局列表 1 条、
prompt 保留 `[system]` 段、output 是完整正文、记录文件里无凭证 —— 全绿。

## 0.16.15 — 2026-10-30

### /code-review 双轴评审：修三条真回归，并行度拆成独立设置项

**背景**：0.16.14 落地后跑 `/code-review`（Standards + Spec 双轴），
同时用真机 `job-mvuk7e20-1` 验证提速。评审报了若干条，逐条回代码核实，
其中三条是真问题，已修并各自做了反向验证。

**1. `else` 分支被并行改造吞掉（严重回归，两个评审各自独立发现）**

`documentation_generator.py` 里「整仓能装进上下文就直接写整个仓库」的
`else:` 段落，缩进在改造时丢了归属。后果比评审描述的更严重：有模块树的
仓库会先走 `generate_parent_module_docs`，**再无条件 `run_module_agent`
跑一遍 whole-repo** —— 双跑，白烧一次全量预算。

修法：恢复 `else:`，并用 AST 复核（`if at line 274` 的 `orelse` 有 6 条语句，
首条是 `logger.info("Processing whole repo ...")`）。
补测试「空模块树时必须走 else 分支写整仓总览」：摘掉 `else:` 红
（`空模块树时 backend 一次都没被调用`），恢复即绿。

**2. 误删逐模块 emoji 日志** — 并行改造顺手删掉了 `📄`/`📁`/`📚` 三处
`logger.info` 的 emoji，与并行毫无关系。已恢复，`git diff` 现在只剩缩进变化。
这些日志正是 0.16.11 细节探针的数据源，删了会让进度帧退化成「已写 0 篇」。

**3. 死变量 + 白付深拷贝** — `processed_modules` 只 `add` 不读（原去重守卫
被删后成了死代码）；`branch_tree = deepcopy(module_tree)` 只用于
`is_leaf_module` 判断，而两条下游路径都自己从磁盘 load 树，深拷贝纯浪费。
已删掉死变量，改用 `module_info = module_tree`（主树写入只发生在 gather
之后的合并阶段，单线程，无需拷贝）。

**4. `moduleConcurrency` 不再复用 `c.maxConcurrency`（Standards 硬违规）**

0.16.14 初版写的是 `moduleConcurrency: c.maxConcurrency`，而 `maxConcurrency`
是**LLM 请求并发**、默认 2 —— 于是「默认 1 = 上游串行、向后兼容」当场落空，
所有既有用户升级后立刻变并行 2，行为静默改变。

改为独立设置项 `moduleConcurrency`，沿用 `bigConcurrency` 的既有约定：
**0 / 未填 = 跟随默认档并发，填 1 = 上游严格串行**。设置面板已加输入框
（中英双语文案），保存键已纳入。
补测试钉住语义边界：把回落表达式改回 `c.maxConcurrency` 即红
（`填 1 = 串行会失效`），恢复即绿。

### 真机提速验证（0.16.14 生效后）

宿主 PID 31460 启动 `16:47:19` 晚于提交 `16:22:57`，确认已加载新代码。
观测 `job-mvuk7e20-1`（Wxxy-CampusLogin，被新引擎接管重跑）：

| 指标 | 旧（0.16.14 前 `job-mvubwirb-3`） | 新（`job-mvuk7e20-1`） |
| --- | --- | --- |
| 产出 | 6 篇 / 14.5 分钟 | 21 篇 / 16.8 分钟 |
| 吞吐 | 0.41 篇/分钟 | 1.19 篇/分钟 |
| 单篇 | 2.42 分钟 | 0.84 分钟 |

**吞吐 2.9×**。并发铁证：从磁盘 `dsh-codewiki-jobs.json` 的 nativeLogs 取
20 条请求做区间扫描，**峰值并发 5、20/20 条都与其他请求时间重叠**
（串行时区间绝不相交）。典型片段 `09:10:41 ms=99232 end=09:12:20` 与
`09:10:43 ms=3856`、`09:10:48 ms=4290` 重叠。

### 补丁与文档修正

- `patches/README.md`：上游仓库名 `mraza007/codewiki` → **`FSoft-AI4Code/CodeWiki`**
  （`git remote -v` 实证）；删掉「基准 commit 与 `UPSTREAM_COMMIT` 对应」这句
  假陈述（实际不一致，本地浅克隆比锁的 commit 新两个 PR），改成打补丁前先
  `git -C .probe-fsoft/src log -1` 核对 HEAD。
- `patches/upstream-module-parallel.patch` 重新导出（190 行），
  `grep -c "^-        else:"` = 0，确认不再删除原 `else`。
- 未修（判断题，留作后续）：`test-upstream-parallel.mjs` 未登记进 README 的
  测试清单；`native-run.js` 只钳下限而 `entry.py` 钳上限 8（不同源）。

## 0.16.14 — 2026-10-30

### 上游模块生成并行化：同层并发，父模块仍等子模块

**背景**：`job-mvuf1c5b-5` 在阶段 3 跑满 180 分钟预算，只写出 18 篇被判失败。
慢不是模型问题，是上游 `_generate_modules_in_order` 的**严格串行**：

```
for module_path, module_name in processing_order:
    final_module_tree = await self.backend.run_module_agent(...)
```

单篇文档是一个 agentic 工具循环（读文件 → 写稿 → 自查 → 修订），
实测约 15–20 次 LLM 请求，其中 3–4 次是 3–5 分钟长思考，**单篇约 12 分钟**。
本仓库模块树 16 个节点，加上复杂模块递归派子模块，串跑就是 3 小时起步。
180 分钟的超时上限对 16+ 节点的仓库根本不够。

**改法**：按拓扑层分批并行（`documentation_generator.py`）。

- `processing_order` 本来就是自底向上的拓扑序，按路径深度分层后，
  **同一层的模块互不依赖**，用 `asyncio.gather` 并发；层与层之间仍串行，
  父模块读到的子模块文档才是完整的。
- 并发度由 `asyncio.Semaphore` 限制，新增配置项 `module_concurrency`
  （`Config` 字段 + CLI 适配层透传 + `entry.py` 从 payload 读，默认 **1 = 串行**）。
  链路：`index.js` 把 `c.maxConcurrency` → `runNativeJob({moduleConcurrency})`
  → payload `moduleConcurrency` → `config["module_concurrency"]`。
- 失败语义不变：单模块异常只记日志并跳过，不拖垮同批其它模块。

**共享状态的处理**（并行的真正难点，不是把 for 换成 gather）：

| 状态 | 是否并行安全 | 处理 |
| --- | --- | --- |
| `module_tree` 内存对象 | 否：子模块递归直接 mutate | 每分支 `deepcopy`，结束只把**本路径子树**并回主树 |
| `module_tree.json` 磁盘 | 否：`save_json` 非原子、非加锁 | 每层结束用合并后的主树重写一次，下一层读到完整态 |
| `UsageContext` | 是：`ContextVar`，每 task 独立 | 不动 |
| `UsageLedger.add` | 是：自带 `threading.Lock` | 不动 |
| `os.chdir` | 不在本路径 | 只有 caw 后端 chdir；本插件走 `openai-compatible` → `PydanticAIBackend`，不 chdir |

**验证**：新增 `test-upstream-parallel.mjs`（6 条，真 venv 驱动真实上游类，
只把 backend 换成记录事件的可控实现）。

- 同层并行：3 个 0.3s 模块并发 3，实测 0.66s、峰值并发 3（串行需 ≥0.9s）
- `module_concurrency=1`：峰值并发 1、耗时 ≥0.6s，确认向后兼容
- 拓扑序：父模块开始时刻 ≥ 最后一个子模块结束时刻
- 树合并：两个并行分支各自新增的 `complex_*_sub` 都保留，没互相覆盖
- 失败隔离：`beta` 抛错时 `alpha`/`gamma` 照常产出
- **反向验证**：把 `max_concurrency` 强写成 1 → `5 passed, 1 failed`
  （`峰值并发必须 >=2，实际 1`）；恢复后 `6 passed, 0 failed`

**补丁留档**：`.probe-fsoft/` 被 gitignore，上游改动不进 git，故导出为
`patches/upstream-module-parallel.patch`（基准 `364b67a1`），应用方式见
`patches/README.md`。未打补丁的上游只是少了并行能力，不会报错。

引擎回归串行全绿：`test-engine-python-entry.mjs` 21/0、
`test-engine-client.mjs` 28/0、`test-engine-native-job.mjs`、
`test-engine-native-incremental.mjs`、`test-engine-contract.mjs` 19/0。

## 0.16.13 — 2026-10-30

### 默认编译模型换代：workbuddy/hy3 → volces-ark/glm-5.3-flash

**背景**：用户要求停用 hy3。此前插件内两处「兜底默认值」还指着
`workbuddy`/`hy3`（192k 上下文），而用户实际配置早已是
`volces-ark`/`glm-5.3-flash`（512k）。默认值和实际配置分叉会带来两个后果：
① 配置项留空时插件仍悄悄回落到 192k 窗口，本仓库的模块源码装不下就拆批、
拆到单模块仍超预算再转会话通道，一路降级而设置页上看不出原因；
② 文档/包描述写着 hy3，人照着读会以为默认还是那个。

hy3 的 192k 窗口对这类整仓编译本身就不够用——真机 `job-mvu2lmd1-a` 就是
hy3 返回空内容（`LLM returned empty content for dsh-codewiki overview
(possible output truncation at max_tokens)`）导致整轮失败。

**改了什么**：

- `index.js` 的 `DEFAULT_BATCH_PROVIDER` / `DEFAULT_BATCH_MODEL`：
  `'workbuddy'`/`'hy3'` → `'volces-ark'`/`'glm-5.3-flash'`。
- 一并订正注释与工具描述里残留的「默认 workbuddy/hy3」「hy3 免费档」
  「hy3 默认 192k」「默认 workbuddy」（`index.js` 文件头、`maxConcurrency`
  描述、兼容通道说明、`codewiki_generate` 工具描述、`client.js` 的中英双语
  settings hint）。
- `package.json` description、`README.md` 工具表 / `batchProvider` 说明 /
  `maxConcurrency` 说明同步为新默认值。

**刻意没动**：

- `BATCH_TOKEN_BUDGET = 110000` / `BATCH_TOKEN_HARD_LIMIT = 128000` 两个常量
  的**值**。它们被 20 多处消费，改值会连带改变装填与拆批行为，超出「换默认
  模型」的范围；只把注释里的「hy3 默认 192k」改成「512k 模型 + 保留 128k 为
  兼容档」。真要吃到 512k 窗口，应当单独做一次装填策略调整并实测。
- 用户已配好的 `~/.dsh/profiles/desktop/cordis.patch.yml` **一个字没改**。
- `README.md`「hy3 硬门禁未通过」与 `docs/fsoft-native-engine.md` 同款段落，
  那是当时的验收记录，改了就变成篡改历史。
- `CodeWiki.md` 与 `.codewiki/` 下的文章属于编译产物，不手改，等重编。

**验证**：`node --check index.js` / `node --check client.js` 通过，
`package.json` 可解析，四个改动文件 U+FFFD 计数均为 0；
`test-batch.mjs` 148 通过 0 失败、`test-wiki-entry.mjs` 全部断言通过。

**注意**：测试 fixture 里大量显式写 `provider: 'workbuddy'` / `model: 'hy3'`
是**显式传参**、不走默认值，故保留不动——它们验证的是「任意 provider/model
都能被路由」，与默认值无关。

## 0.16.12 — 2026-10-30

### 阶段 2 也带出子树名：真机复验补上的半块

**背景**：0.16.11 上线后在真机复验（宿主 12:36:34 重启，晚于 12:35:22 的提交，
确认加载的是新代码；引擎进程 12:41:02 创建）。心跳帧确实在按 60 秒跳动
（`04:46:06` → `04:47:06`），但 `nativeMessage` 是
`引擎仍在运行（阶段 2，已写 0 篇）`——**阶段 2 完全没有被覆盖**。

**为什么**：0.16.11 的四条正则只覆盖阶段 3（`documentation_generator.py` 的
`Processing leaf module: X` 一族）。阶段 2 的 `cluster_modules.py` 不逐模块打印，
而是围绕当前子树发消息，形如
`Requesting LLM module clustering for %s because %d tokens exceed...`
（`cluster_modules.py:326`）、
`Module clustering input for %s: %d leaf nodes...`（`:292`），
`label` 在 `:290 module_label = current_module_name or "repository"` 赋值。
阶段 2 在真机上能跑十几分钟，只报「阶段 2」等于没有信息。

**改了什么**（`lib/engine/python/entry.py`）：

- `_DETAIL_PATTERNS` 补 8 条阶段 2 正则，按「越接近现在正在做什么越靠前」排序：
  `Requesting LLM module clustering for (.+?) because`、
  `Module clustering input for (.+?):`、
  `Partitioned \d+ leaf nodes for (.+?) into`、
  `LLM module clustering for (.+?) produced`、
  `Skipping LLM module clustering for (.+?) because`、
  `Skipping LLM clustering result for (.+?) because`，
  以及两条无模块名的 `super-group` 阶段。
- `detail_suffix()` 按阶段分措辞：阶段 3 是「，正在写 X」，阶段 2 是「，正在聚类 X」，
  归并阶段是「，正在归并 X」/「，正在做子系统归并」。
  **不能混用**——阶段 2 用「正在写」会让人以为已经在产出文章，反而更误导。

**回归**：`细节探针` 用例补三条断言——阶段 2 子树名抽得出来、措辞必须是「聚类」
而不是「写」、归并阶段能看见。`21 passed, 0 failed`。

**反向验证**：删掉
`Requesting LLM module clustering for (.+?) because` 这一条 →
`20 passed, 1 failed`，报
`AssertionError: 阶段 2 的子树名必须抽出来：{"phase":"cluster","module":"xxx...","suffix":"，正在写 xxx..."}`
（模块名滞留在上一条超长 `xxx`、措辞也错成「正在写」，正好证明两条断言都在真拦）；
恢复后 `21 passed, 0 failed`，`REVERSE-VERIFY` 计数 0。

**真实模块验证**（不是构造 logger 名）：用 venv 真 import
`codewiki.src.be.documentation_generator` 与 `codewiki.src.be.cluster_modules`，
确认二者 `logger.name` 分别是 `codewiki.src.be.documentation_generator` /
`codewiki.src.be.cluster_modules`，都是 tap 挂载点 `codewiki.src.be` 的子 logger，
且用真实 logger 打一条日志就能抽出 `lib/engine/client.js`。

## 0.16.11 — 2026-10-30

### 进度帧带上模块名：让「已写 0 篇」变成「正在写 lib/engine/client.js」

**背景**：0.16.9 的心跳解决了「阶段 3 一帧不发、面板上与挂死无法区分」，但真机跑起来
仍然是 `引擎仍在运行（阶段 3，已写 0 篇）`——一个数字，不知道卡在哪。用户明确要求
把进度粒度做细（选项 B）。

**为什么拿不到模块名**：FSoft 以 `verbose=False` 运行时会把 `codewiki.src.be` 的 logger
压到 `WARNING`（`.probe-fsoft/src/codewiki/cli/adapters/doc_generator.py:96-125`），
于是逐模块日志——`documentation_generator.py:293` 的
`📄 Processing leaf module: {module_key}`、`:302` 的 `📁 Processing parent module: {module_key}`、
`:315` 的 `📚 Generating repository overview`——全被吞掉。桥接层于是只知道「已写 N 篇」。

**改法（旁路只读，不改 FSoft 源码）**：`lib/engine/python/entry.py` 新增

- `_DETAIL` 状态 + `_DETAIL_PATTERNS`（四条正则，**只吃 ASCII 部分**，不碰 emoji 前缀——
  cp936 控制台下打印 emoji 会抛 `UnicodeEncodeError`）；
- `_DetailHandler(logging.Handler)`：从日志文本抽模块名，**任何异常都吞掉**
  （观测失败绝不能弄崩编译）；
- `attach_detail_tap()` / `release_detail_tap(tap)`：把 `codewiki.src.be` 临时降到 `INFO`
  并挂 handler，返回句柄供还原；
- `detail_suffix()`：拼出 `，正在写 <模块>` 或 `，正在生成仓库总览`；模块名超过 80 字符截断。

**两个必须同时处理的副作用**：

1. **不能让 INFO 灌进 stderr**。FSoft 自己在 `doc_generator.py:115` 挂了
   `StreamHandler(sys.stderr)`，`verbose=False` 时靠「logger level = WARNING」挡住 INFO。
   只降 logger level 会让这条 INFO 冲进 stderr，被 `client.js` 当 stderr tail 收走，
   噪音暴涨。所以 `attach_detail_tap()` 同时把已有 handler 的 level 提到 `WARNING`，
   让 INFO 只走我们这个只读 handler——`silenced` 句柄负责还原。
2. **探针存活期严格等于一次编译**。tap 挂在 `generate_with_heartbeat()` 里，
   `finally: release_detail_tap(tap)` 摘掉并还原 level，不给后续请求留下被降级过的 logger。

**接入点**：`start_stage` / `update_stage` / `complete_stage` 三处都改成
`with_detail(description)` / `with_detail(message)`，心跳帧也拼 `detail_suffix()`。
`with_detail` 只在有额外信息时补一段，不改调用方传进来的语义；
FSoft 的 message 在 `verbose=False` 时常常是空的，此时模块名就是唯一可读的进度信息。

**回归**：`test-engine-python-entry.mjs` 新增
`细节探针：逐模块日志要变成进度帧里的模块名（否则面板只有「已写 0 篇」）`——
复刻 FSoft 的 `handlers.clear()` + WARNING 配置，断言挂 tap 前 INFO 被吞、
挂 tap 后 `lib/engine/client.js` / `lib/engine` 都能抽出来、总览阶段有「总览」字样、
超长名截断到 ≤90 字符、摘掉后 level 还原成 `30`（WARNING）且状态不再变化。
`21 passed, 0 failed`。

**反向验证**：在 `attach_detail_tap()` 里插 `return None  # REVERSE-VERIFY` →
`20 passed, 1 failed`，报
`AssertionError: 叶子模块名必须解析出来：{"phase":"leaf","module":"","suffix":""}`
（`+ ''` vs `- 'lib/engine/client.js'`）；恢复后 `21 passed, 0 failed`。

## 0.16.10 — 2026-10-30

### 澄清：`update-record` 的基线判据写全，但实测该分支当前不可达

**背景**：Standards 轴评审指出 `canAdvanceBaseline` 在仓库里散布五处、语义不一致，
其中 `lib/update-record.js` 用的是 `outcome === 'done' && blockers.length === 0`，
看起来是 0.16.1「允许 partial 推进基线」时漏改的一处。

**核查结论（实测，不是推断）**：写了个探针把 `judgeOutcome` 的 6 类降级来源
（逐篇失败 / 缺页 / 未归属变更 / 质量闸门 / extraBlockers / 索引未过）逐个单独触发，
结果 **`partial` 恒带至少一条 blocker**——每个降级来源自己就 push blocker。
于是 `partial && blockers.length === 0` 这个组合在本函数里根本构造不出来，
旧写法与新写法**行为完全一致**，这处不是 bug。

**改了什么**：把判据从 `outcome === 'done'` 写成显式的
`outcome === 'done' || (outcome === 'partial' && writtenCount > 0 && blockers.length === 0)`，
并在注释里写清三件事——

1. 本函数服务兼容通道（`tickIndex`），它的 blocker 含「未归属变更」「缺页」这类
   「没消化完」语义；一旦放宽，未消化的变化会被记成已消化，下一轮这些变化不再触发
   文章更新，wiki 就会静默落后于代码。所以这里**刻意**保持比
   `native-run.js` / `quality-gate.js` 更严，不是漏改。
2. `partial` 分支当前不可达的事实与实测依据。
3. 将来若放宽 blocker 规则，partial 分支会自动按「有成果且无缺陷才推进」生效，
   而不是靠 `done` 这个别名悄悄失效。

**为什么不直接删掉多余分支**：两处通道的严格度不同是有意的（原生通道有原始树可回放，
兼容通道没有），删掉会抹掉这个区别；而把判据写全，读者才看得出「严」在哪里。

**验证**：`test-update-record.mjs` → `18 passed, 0 failed`（含「1 成功 19 失败 → partial，
不得推进基线」「未映射变更 → partial，基线不前移」等用例）。


## 0.16.9 — 2026-10-30

### 修复：编译挂死没人收尸——加引擎心跳与静默检测

**现象**：真机 `job-mvubmj6v-1`（本仓库增量）进入阶段 3 后彻底静止：

| 观测项 | 数值 | 说明 |
| --- | --- | --- |
| `job.updatedAt` | `2026-10-30T02:03:32.338Z` 起冻结 | 52 分钟零更新 |
| `nativePercent` | 恒 54 | 恰为 `percent_of(3, 0.0)` = (0.40+0.20)×90 |
| 引擎 PID 30284 CPU | 275.5s → 289.56s | 52 分钟只涨 14 秒，不是慢是死 |
| `py-spy` 主线程 | `_poll (asyncio\windows_events.py:774)` | 事件循环空转，无待办任务 |
| 产物 docsDir 的 md | 三次采样恒 3 篇 | 无任何新写入 |

更严重的后果不在这一轮本身：调度闸门 `parallelLimit` 默认 1，被这个僵死任务一直占着，
另外 3 个仓库（`dsh-git-worktree` / `Wxxy-CampusLogin` / `memory/dsh-hindsight-on-demand`）
的自动编译全部排队饿死——**这就是「看不到过期自动编译」的真凶**。

**两条独立成因**

1. **阶段 3 零进度帧**（引擎侧）。FSoft 阶段 3 内所有 `update_stage` 都在
   `if self.verbose:` 里（`.probe-fsoft/src/codewiki/cli/adapters/doc_generator.py:377/381/389`），
   而 `lib/engine/python/entry.py` 传的是 `verbose=False`。于是从
   `start_stage(3, "Documentation Generation")` 到 `complete_stage()` 之间一帧都不发，
   真机上这段能跑 40 分钟以上。
2. **同实例僵死无人接管**（Node 侧）。`index.js:2800` 的 `tickNative` 只判
   `if (nativeRuns.has(job.id)) return true`，而孤儿接管（`index.js:3659-3670`）
   只在 `job.owner !== instanceId` 时生效。同实例内的僵死任务没有任何人发现，
   唯一兜底是 `runEngine` 的 180 分钟总超时；且即使等到超时，最后一条进度帧的
   `writtenCount` 仍是 0 → 仍判 failed，partial 自救（0.16.5）拿不到任何东西。

**修法**

- `lib/engine/python/entry.py`：
  - 新增 `_EMIT_LOCK = threading.Lock()`，`emit(obj)` 用锁包住协议行写入——心跳线程
    与主线程并发写时，半行 JSON 会让 Node 侧解析丢帧。
  - 新增 `_HEARTBEAT_SEC = 60.0`（必须显著小于 Node 侧静默窗口默认 10 分钟）。
  - `bridge_progress` 末尾把 `adapter.generate` 包成 `generate_with_heartbeat`：
    起一个 daemon 线程按 `_HEARTBEAT_SEC` 重发**当前**阶段与**当前**真实篇数
    （`引擎仍在运行（阶段 N，已写 M 篇）`），`try/finally` 保证任务结束即停表。
  - 心跳**不推进 percent**——只证明「还活着」，不谎报进展。
  - `tracker.current_stage == 0` 时跳过（FSoft 还没进第一个阶段，`map_stage` 只认 1..5）。
  - `orig_generate = getattr(adapter, "generate", None)`：进度桥的既定契约只要求
    adapter 有 `progress_tracker`，拿不到 `generate` 就只装桥不装心跳
    （少一层观测，不能少一层功能）。
- `lib/engine/client.js`：
  - 新增 `DEFAULT_SILENCE_MS = Math.max(30_000, DSH_CODEWIKI_ENGINE_SILENCE_MS || 10 * 60 * 1000)`。
  - `stdout.on('data')` 第一行 `markFrame()` 记录最后一次收到协议帧的时刻。
  - 新增 `silence` promise 参与 `Promise.race`：超过 `silenceMs` 没有任何帧就判卡死
    （`silenceMs` 可按次传入，测试用）。
  - 卡死分支：先 `killTree('silence')` 终止进程树，再按最后一条进度帧的 `writtenCount`
    分流——有产物走 `partial`（带 `engine-timeout` + `engine-timeout` blocker），
    零产物走 `failed`。口径与 timeout 分支完全一致，不新增第二套语义。

**反向验证（红 → 绿）**

- 摘掉 `silence` 的 `Promise.race` → `test-engine-client.mjs` 报
  `必须在静默窗口后立刻返回，不该等满 timeoutMs：20299ms`，`27 passed, 1 failed`；
  恢复即 `28 passed, 0 failed`。这个 `20299ms` 恰好复现真机病态：等满 `timeoutMs` 才返回。
- 把 `adapter.generate = generate_with_heartbeat` 短路 → `test-engine-python-entry.mjs` 报
  `0.5s 内按 0.08s 心跳必须有帧：[{"stage":"articles","percent":54,...,"message":"Documentation Generation"}]`，
  `19 passed, 1 failed`；恢复即 `20 passed, 0 failed`。失败输出里只剩 `start_stage` 那一帧、
  percent 冻结在 54——正是真机现场。

**新增测试**

- `test-engine-client.mjs`：`silent-hang` / `silent-hang-with-progress` 两个假引擎 mode，
  外加两条用例（「静默卡死 → partial 交付已写文章，不等 180 分钟超时」与
  「静默卡死且零进展 → 仍判 failed」），用 `silenceMs: 1200 / timeoutMs: 20000`
  证明是静默检测先触发、而不是超时先到。
- `test-engine-python-entry.mjs`：`心跳：长阶段无进度事件时也要持续发帧`。探针把
  `_HEARTBEAT_SEC` 压到 0.08s，`Tracker.current_stage` 从 0 起步，`generate` 期间真写一篇
  `written-during-hang.md`，断言心跳帧存在、`stage === 'articles'`、且 `written` 会跟着涨
  （用 `some` 而非 `every`：前几帧文章还没写出来，那时恒 0 是对的）。

**回归**：全量 `for f in test-*.mjs` → `ok=28 red=1`，唯一红的是
`test-wiki-anchors.mjs`（已知：`.codewiki` 文章锚点滞后于源码，随一次成功编译消失）。


## 0.16.8 — 2026-10-30

### 修复：编译中途崩溃时把已写文章交出来，别再整轮作废

**现象**：真机 `job-mvu2lmd1-a`（本仓库增量）在阶段 3「Documentation Generation」跑到一半，上游抛

```
Documentation generation failed: LLM returned empty content for dsh-codewiki overview (possible output truncation at max_tokens)
```

终态是 `stage=failed, writtenCount=0, failedCount=0`，`artifacts` 四个字段全是空字符串，`canAdvanceBaseline` 连值都没有，notes 末尾「任务终态：失败（无可用成果）」。而那一轮 docsDir 里**并不是没有东西**——它已经写了十几分钟。

**根因是两段叠加的死循环**：

1. `lib/engine/python/entry.py` 的 `_classify_exception()` 对 `APIError`/`ConfigurationError` 和兜底的「未知异常」一律走 `failure()`，`writtenCount` 恒 0、`artifacts` 全空，**完全不看 docsDir 里已经写了多少**。
2. `lib/engine/native-run.js` 对 `engineOutcome === 'failed'` 是**直接 settle 短路**——不做原始树留档（`rawArchive`）、也不采集受管状态（`.codewiki/_native-state`）。

两段一叠加就是一个闭环：失败轮不产出 `_native-state` → 下一轮增量读到「还没有持久化状态（首次增量）」→ 退回全量 → 全量本身要 174 分钟、更容易撞上同样的中途崩溃 → 又失败。**只要崩一次，就再也增量不起来。**

**修法**：`_classify_exception()` 的这两条分支改走新增的 `_salvage()`：

| 场景 | 结果 |
| --- | --- |
| `_count_docs(docs_dir) > 0`（确有文章落盘） | `outcome = 'partial'`，`writtenCount` 如实上报，`artifacts` 带出 docsDir/rawTreeDir/updateRecord，`error` 保留原始错误码与信息，`blockers` 加一条 `article-failed`（说明「编译在 X 阶段中断（已写 N 篇）」） |
| `written <= 0`（一篇没写出来） | 仍走 `failure()` 判 `failed`——不许用空产物冒充 partial |
| `RepositoryError` | 仍直接 `failure('engine-missing')`：连仓库都没读出来，docsDir 里不可能有成果 |
| `KeyboardInterrupt` | 仍走 `_cancelled_result`（取消不是失败） |

`_salvage()` 里 `updateOutcome` 显式交 `None`（`_update_outcome_of_safe()`）：它没有 adapter 句柄，而 `updateOutcome` 是「基线能不能推进」的唯一证据——猜错会让 `full_fallback` 被当成普通 `done`，基线悄悄前移，那次没消化的变化就永久失明。

**为什么这比「多写点重试」重要**：原生全量实测约 174 分钟（`job-mvt1mrvu-6`：queued 29.2 + articles 66.0 + crosscut 10.0 + review 68.9 分钟）。在任何一小时级别的长任务里，「崩了就全丢」等于「重试平均打水漂一半」，而且失败轮永远不产生增量状态，第二次一定还是全量。

### 新增回归

`test-engine-python-entry.mjs` 两条（用真 venv 直接调 `_classify_exception`）：

- 「异常分类：中途崩溃时已写文章降 partial 交付，产物目录要带出去」——docsDir 里放 2 篇 .md + `temp/update-record.json`，断言 `outcome==='partial'`、`writtenCount===2`（`temp/` 下记账文件不算文章）、`artifacts.docsDir` 非空、`error.code==='engine-crashed'`、`blockers[0].kind==='article-failed'`。
- 「异常分类：一篇没写出来时仍是 failed，不许用空产物冒充 partial」。

**探针踩坑（写进测试注释）**：`entry.py:99-131` 在**导入时**就把 `sys.stdout` 换成了只放行协议行的 `_ProtocolOnly()` 替身，所以探针里 `print(json.dumps(res))` 会被改道到 **stderr**，Node 侧 `raw.stdout` 永远是空串。取结果必须显式 `pathlib.Path(outFile).write_text(...)` 再读文件。

**反向验证**（逐条红）：把两条分支还原成 `failure(...)` → `FAIL 异常分类：中途崩溃时已写文章降 partial 交付，产物目录要带出去`（`1 !== 0`）、`18 passed, 1 failed`；恢复后 `19 passed, 0 failed`。

## 0.16.7 — 2026-10-30

### 修复：Spec 评审确认的六条契约缺陷（含两条「设置项静默失效」）

`/code-review` 双轴评审（基准 `main`，142 文件 / +29009-4757）中，Spec 轴报出 6 条与 `docs/fsoft-native-engine.md` 不符的项，逐条回代码核实后全部成立并修复。其中 P1/P2 属于「设置或语义静默失效」——用户改了设置、系统也接受了，但行为完全没变。

| # | 缺陷 | 根因 | 修法 |
| --- | --- | --- | --- |
| P1 | `articleLanguage` 在默认（原生）通道完全失效，引擎永远按英文写 | `index.js` 的 `startNativeRun → runNativeJob` 入参没有 `language`；`nativeEnginePlan` 不接；`entry.py` 的 `config["agent_instructions"]` 只设了 `exclude_patterns`。上游 `config.py:179` 的 `language` property 读的正是 `agent_instructions.language` | `index.js:2659` 传 `language: job.language`；`native-run.js` 签名/payload 收 `language`（空值整个字段不写，保持上游默认）；`entry.py` 取 `payload.language` 后写进 `agent_instructions.language` |
| P2 | `engine-timeout` 被静默改名成 `engine-error`，超时语义在终态与面板里丢失 | `client.js:381/387` 把 `{kind:'engine-timeout'}` 当 blocker，但 `BLOCKER_KINDS` 没登记它，`normalizeBlocker` 走 `else → 'engine-error'` | `lib/engine/contract.js` 的 `BLOCKER_KINDS` 追加 `engine-timeout`（只追加不改名，符合「枚举只许追加」约定） |
| P3 | `cancel` 动作出参是一整份 `EngineResult`，契约要求 `{cancelled:boolean}` | `entry.py` 的 `handle_request` 直接 `return _cancelled_result(...)` | 改成 `return request_id, {"cancelled": True}`；cancel 是控制面动作，回 EngineResult 会让下游把它当成「这轮编译结束了」 |
| P4 | `doctor` 出参缺 `checks:[{name,ok,detail}]`，上层拿到 `done` 也不知道过了哪几项检查 | `entry.py` 的 `action_doctor` 只回 EngineResult 形状 | 三个分支（正常/pip 不闭合/引擎缺失）都补 `checks`；`contract.js` 新增 `normalizeChecks()` 做归一（非数组→`[]`、缺 name 丢弃、`ok` 只认布尔 `true`），`engineResult()` 带出 `checks` |
| P5 | `keptCount`/`removedCount`/`unmappedCount` 恒 0，`settle()` 与最终 `settle` 都不带 | `entry.py` 四处结果构造硬编码 0；`native-run.js:157` 的 `base` 与 `:866` 的最终 `settle` 都没有这三项 | `entry.py` 新增 `_counts_of(adapter)`：`keptCount` = `verdicts` 里 `no-op` 的页数、`removedCount` = `pages_removed` 去重、`unmappedCount` = `repair.orphans` 长度；`_done_result` 接 `counts`；`native-run.js` 两处 `settle` 补三字段 |
| P6 | 改契约未升 `ENGINE_CONTRACT_VERSION`，也没同步测试 | `contract.js` 版本停在 1；`test-engine-contract.mjs` 断言 `=== 1` | 升到 `2`；`entry.py` 抽出 `CONTRACT_VERSION = 2` 常量替换 5 处字面量（避免「同一进程报两个版本」）；同步测试断言 |

**顺带修掉的自造 bug**：P1 首次落地时 `config["agent_instructions"]` 展开 `language` 的位置**排在** `language = str(payload.get(...))` 赋值之前，会抛 `UnboundLocalError`。已把取值上移到 `config = dict(cfg)` 之前，并在注释里写明踩坑原因。

**同时修正的文档自相矛盾**（Standards 轴 S1/S2/S3）：

- `docs/fsoft-native-engine.md:139` 与 `lib/engine/native-run.js:16` 的不变量 4 都还写着「partial/failed 一律不推进基线」，而实现从 0.16.1 起允许 **有产物的 partial** 推进——这两处注释/文档正是 0.16.1 改代码时漏改的。现统一表述为「`done` 一律推进；`partial` 仅在 `rawTreeFiles > 0` 时推进；`failed`/`cancelled` 不动」，并写明死循环的实际后果。
- `README.md:27`/`:57` 同款表述一并修正；`:112` 的 `nativeEngineTimeoutMs` 默认值从「`10800000`（180 分钟）」改为「`0`（= 用默认 180 分钟）」——`index.js:92` 的实现值就是 `0`，靠 `native-run.js:83` 兜底，数值等效但写法不是实现。
- `README.md:252` 补 `articleLanguage` 在两条通道的生效路径。

**新增回归**（4 处，均已反向验证）：

- `test-engine-native-job.mjs` 用例 18：`language` 必须进引擎 payload（`language: '中文'` → payload 带 `中文`；不传 → 字段整个不出现）；用例 19：三计数必须透传（7/3/2 原样到终态）；用例 20：`engine-timeout` 不许被改名、未登记 kind 仍须降级。
- `test-engine-python-entry.mjs`：cancel 断言改为「出参是 `{cancelled:boolean}` 且不含 `outcome`/`blockers`」；新增 doctor `checks` 两项用例（真实 venv 至少 import/python/pip 三项，且 `ok` 必须是布尔、`detail` 必须有内容；归一函数对非数组/缺 name/字符串 `'true'` 的处理）。
- `test-engine-contract.mjs`：版本断言升 2。

**反向验证（逐条，全部当场跑出红）**：去掉 payload 的 `language` 展开 → `✗ 引擎 payload 必须带 language=中文（实际 undefined）`、`110/111`；`BLOCKER_KINDS` 移除 `engine-timeout` → `✗ BLOCKER_KINDS 必须含 engine-timeout`、`✗ blocker kind 必须原样保留（实际 engine-error）`、`109/111`；最终 `settle` 去掉三计数 → 三条 `✗`、`108/111`；`cancel` 改回 `_cancelled_result` → `FAIL 协议：cancel 出参是 {cancelled:boolean}`、`16 passed, 1 failed`；doctor 去掉 `checks` → `FAIL doctor：出参必须带 checks`、`16 passed, 1 failed`；版本改回 1 → `FAIL 契约版本是显式数字`、`18 passed, 1 failed`。全部 `cp` 备份恢复后复绿。

**全量回归**：`ok suites: 28`、`failed suites: test-wiki-anchors.mjs`（红项仍是 `.codewiki` 文章锚点滞后于源码，随一次成功编译消失）。

## 0.16.6 — 2026-10-30

### 修复：仓库清单落点只看目录，测试会把 fixture 路径写进真实宿主清单

**现象**：真机 `%TEMP%/dsh-codewiki-repos.json`（自动更新的已知仓库清单）里出现 `%TEMP%/cw-orch-txSQbO` 这类**目录早已不存在**的 fixture 路径，且每次跑完测试都会多几条。自动扫描每轮都要对它们空跑 `hasCompilableSources` / `isWorktreeCwd` 探测，面板上的「扫描 N 个仓库」也因此虚高。

**根因**：`REPOS_FILE` 原先按**目录**推导——`path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')`。但测试通过 `DSH_CODEWIKI_JOBS_FILE` 换掉的是**文件名**（`dsh-codewiki-jobs-test-<pid>-<token>.json`），目录仍是系统临时目录，于是测试与被测产品推导出**同一个**宿主清单文件：测试里 `rememberRepo()` 登记的 fixture 仓库、`fs.unlinkSync(reposFile)` 的清理，全部作用在真实宿主的清单上。`test-orchestration.mjs` 自己也有两处同样写死 `dirname(JOBS_FILE)` 的推导，属于测试与产品同错共振。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `index.js` | 新增 `export function reposFileFor(jobsFile, explicit = null)`：显式环境变量最优先；否则把文件名里的 `-jobs` 换成 `-repos`（无 `-jobs` 时追加 `.repos`）；`REPOS_FILE = reposFileFor(JOBS_FILE, process.env.DSH_CODEWIKI_REPOS_FILE || null)`。默认形态（`dsh-codewiki-jobs.json`）仍推导出原路径，既有登记不丢 |
| `test-orchestration.mjs` | 三处硬编码推导改为 `reposFileFor(JOBS_FILE)`（`import` 增加该导出） |
| `test-repos-isolation.mjs` | 新增回归：隔离 JOBS_FILE 后 `REPOS_FILE` 必须换路径、默认形态仍指向宿主清单、显式环境变量最优先，并**实证**跑一遍 `apply()` 后宿主清单逐字节未变 |

**反向验证**：把 `reposFileFor` 改回 `path.join(dir, 'dsh-codewiki-repos.json')` → `✗ 隔离 JOBS_FILE 后 REPOS_FILE 必须换路径`、`✗ 宿主清单必须逐字节未变（测试不得污染真实宿主）`、`FAIL：2 项未通过`；恢复后全绿。回退运行当场就把宿主清单从 2 条冲成 1 条失效 fixture 路径——缺陷可复现，不是纸面推断。

**全量回归**：`ok suites: 28`、`failed suites: test-wiki-anchors.mjs`（wiki 文章滞后于源码，重编译后消失）。

## 0.16.5 — 2026-10-30

### 修复：原生通道超时预算低于真机耗时（45 分钟 → 180 分钟），且超时抢救一直失效

**现象**：本仓库连续 25 条原生通道任务**没有一条成功**，最近六条 `kind=stale` 全部卡在同一处：`nativePercent: 54`、`nativeMessage: "Documentation Generation"`、articles 阶段 45.0~48.1 分钟后 `引擎在 2700000ms 内未完成（进程树已终止）`、`writtenCount: 0`、一篇都没写出来就失败。面板上永远是「过期 → 自动编译 → 又失败 → 还是过期」，看起来像自动更新根本没生效。

**根因（两条独立缺陷叠加）**：

1. **超时预算低于物理耗时**。`DEFAULT_ENGINE_TIMEOUT_MS = 45 * 60 * 1000` 是阶段 1C 按小 fixture（约 1 分钟）估的。真机实测 `job-mvt1mrvu-6`（本仓库唯一一次真正跑完的编译，走旧兼容通道）分阶段耗时：`articles 66.0min` + `crosscut 10.0min` + `review 68.9min` + `queued 29.2min` ≈ **174 分钟**。按 45 分钟给预算，等于在阶段 3「Documentation Generation」刚开头（`percent_of(3, 0.0)` = (0.40+0.20)×90 = **54%**）就砍掉进程——这不是编译失败，是预算低于物理耗时，重试多少次都必然一样。
2. **超时抢救路径在真机上从未生效**。0.16.1 已给 `lib/engine/client.js:368` 加了「超时但有进度 → partial」，判据是 `reader.progress.at(-1)?.writtenCount > 0`。但 `lib/engine/python/entry.py` 的 `bridge_progress()` 三处 `emit_progress(...)` 都**没传 `written` 参数**（默认 0），进度帧里的 `writtenCount` 恒为 0，于是这条分支永远走不进去——即使引擎真的写出了文章，也被记成 `failed` + `writtenCount: 0`。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `lib/engine/native-run.js:83` | `DEFAULT_ENGINE_TIMEOUT_MS`：`45 * 60 * 1000` → `180 * 60 * 1000`，注释写清实测数据与「预算低于物理耗时等于永远失败」的教训 |
| `index.js:92` | `nativeEngineTimeoutMs` 配置描述同步（0=默认 180 分钟），并说明超时按 partial 抢救已写文章 |
| `lib/engine/python/entry.py:411-497` | `bridge_progress(..., docs_dir)` 新增必给 `docs_dir`；新增 `_doc_fingerprints(docs_dir)` 与 `written_now(force=False)`，每帧带**本轮真实改动篇数** |
| `test-engine-native-job.mjs` | 新增用例「默认引擎超时必须覆盖真机全量实测耗时」 |
| `test-engine-client.mjs` | 新增「超时但有进度 → partial」「超时且零进展 → 仍 failed」两条协议用例 |
| `test-engine-python-entry.mjs` | 新增「writtenCount 必须是本轮真实改动篇数」与「普通 update 帧节流」两条用例 |

**为什么 `writtenCount` 用「指纹差」而不是篇数净差**：增量轮通常**原地重写**同一批路径、篇数不变，净差会把真实改动记成零进展；也不能直接用 docs 目录的绝对篇数——增量轮进场时 docsDir 已被 Node 侧 `hydrateDocsDir` 灌入上一轮文章，零进展轮也会报几十篇，导致误判 partial 并推进基线，比不报更坏。所以按「进场时的 `(size, mtime_ns)` 指纹表 vs 当前指纹表」算真实改动（新增/改写/删除都计），并加 2 秒节流（start/complete 帧强制重算，普通 update 帧复用）避免每帧全树遍历拖慢编译。

**验证**（当轮输出）：

- `node test-engine-native-job.mjs` → `102/102 通过`，含 `✓ 默认超时 180 分钟 ≥ 真机实测 174 分钟`、`✓ 未显式配置时通道沿用默认超时（实际 10800000）`、`✓ 显式 nativeEngineTimeoutMs 仍优先（实际 12345）`。
- `node test-engine-client.mjs` → `26 passed, 0 failed`，含 `✓ 进程：超时但有进度 → partial（已写的文章要救回来，不能判 failed）`、`✓ 进程：超时且零进展 → 仍判 failed（不能把空轮伪装成 partial）`。
- `node test-engine-python-entry.mjs` → `15 passed, 0 failed`，含 `✓ 进度帧：writtenCount 必须是本轮真实改动篇数（超时全靠它判 partial）`、`✓ 进度帧：普通 update 帧节流（不能让每帧都全树遍历拖慢编译）`。
- **反向验证**（每条都先红后绿）：把默认超时改回 `45 * 60 * 1000` → `✗ 默认超时 45 分钟 ≥ 真机实测 174 分钟`、`101/102 通过，1 失败`，恢复后 `102/102`；把 `emit_progress(..., written=written_now())` 还原成不传 written → `FAIL 进度帧：writtenCount 必须是本轮真实改动篇数`、`13 passed, 1 failed`；改成只算净篇数差 → 同样 `FAIL`；把节流条件改 `if False:` → `FAIL 进度帧：普通 update 帧节流（紧凑 update 必须节流掉遍历：13 次遍历 / 12 帧）`。三次 `cp` 备份恢复后均回到 `15 passed, 0 failed`。
- 全量：27/28 套件 `ok`；唯一 FAIL 仍是 `test-wiki-anchors.mjs`（wiki 文章引用的 `index.js` 行号越界 / 符号已不存在），属文档滞后于源码，重新编译后消失。

---

## 0.16.4 — 2026-10-30

### 修复：孤立 gitlink 被当成源码，引擎编译超时零产出

**现象**：任务 `job-mvtkkua9-4`（`kind=stale, scope=auto`）跑了整整 45 分钟（`DEFAULT_ENGINE_TIMEOUT_MS = 45 * 60 * 1000`）后被进程树终止，`writtenCount: 0`、`failedCount: 0`，notes 只有一句「任务终态：失败（无可用成果）」。同一时间段里 `/api/codewiki/repos` 里该仓库一直是 `state: stale`，看起来就像「过期了、也真的去编译了、但永远编译不出文章」。

**根因**：`.probe-fsoft/src` 是开发期探针克隆（上游 `FSoft-AI4Code/CodeWiki`，18MB / 186 个文件），它以**孤立 gitlink**（索引里 mode `160000`，但没有 `.gitmodules` 登记）的形式被误提交进了本仓库。这带来两个叠加后果：

1. 它是 **tracked** 的，所以引擎的 `use_gitignore=True` 拦不住它——gitignore 只管未跟踪文件；
2. 它又不是本仓库源码——`git checkout` 永远恢复不出内容，克隆本仓库的人只拿到一条指针。

于是引擎把那个无关子仓库整个当成源码建图、聚类，`job.nativeLogs` 里成片刷出 `Skipping invalid leaf node '.probe-fsoft/src/codewiki/mcp/server.py::main' - not found in components`（`session.py::SessionStore`、`workspace.py::SessionWorkspace`、`mcp/tools/*.py` 同样中招），编译预算全耗在它身上，最终撞上超时上限被强杀。本仓库真正的源码只有 7 个 `.py`。用真实引擎分析器复现：排除前源码面 239 个文件、其中探针占 186 个；排除后 53 个文件、探针 0 个。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `lib/engine/python/entry.py` `dangling_gitlink_patterns(repo_path)` | 新增：`git ls-files --stage -z` 取 mode `160000` 条目，减去 `.gitmodules` 已登记的路径，只留下**孤立** gitlink。读不到索引/git 缺失/超时一律返回空列表——排除是优化，不能成为编译的前置条件 |
| `lib/engine/python/entry.py` `source_exclude_patterns(repo_path=None)` | 签名扩展：给了仓库路径就并入孤立 gitlink；省略时保持旧语义（只返回 `.codewiki`/`CodeWiki.md`），旧调用方不受影响 |
| `lib/engine/python/entry.py:555` | `config["agent_instructions"]["exclude_patterns"]` 改为传 `repo_path` |
| `.gitignore` | `.probe-fsoft/venv/` → `.probe-fsoft/`（整个探针环境不入库，并写明这个教训） |
| git 索引 | `git rm --cached .probe-fsoft/src`：移除误提交的 gitlink。磁盘上的探针目录**保留**，venv 照常可用于引擎测试 |

**为什么不排除正规 submodule**：`.gitmodules` 里登记过的子模块是项目架构的一部分，改变其既有语义不在本次缺陷范围内；这里只收「没有 `.gitmodules` 就永远 checkout 不出来」的孤立指针。

**验证**（当轮输出）：

- 新增用例「源码面：孤立 gitlink（无 .gitmodules 的嵌套仓库）必须排除出源码分析面」（`test-engine-python-entry.mjs`）：建真实嵌套仓库 + `git add` 形成 gitlink，用真实 `RepoAnalyzer` 走一遍，断言路径进排除清单、其内部文件不进文件树、常规源码仍在、省略 `repo_path` 时语义不变；并追加一段：写了 `.gitmodules` 登记之后该路径**必须**回到源码面。
- **反向验证**：把 `if repo_path is not None:` 临时短路成 `if False:` → `FAIL  源码面：孤立 gitlink（无 .gitmodules 的嵌套仓库）必须排除出源码分析面`、`12 passed, 1 failed`；恢复后 `PASS  源码面：孤立 gitlink ...`、`13 passed, 0 failed`。
- 真实引擎复现：`.probe-fsoft/venv/Scripts/python.exe` 跑 `RepoAnalyzer`，修复前 `{"total_files": 239, "probe_files": 186}`，修复后 `{"patterns": [".codewiki", "CodeWiki.md", ".probe-fsoft/src"], "total_files": 53, "probe_files": 0}`，本仓库 7 个 `.py` 全部仍在。
- 全量：27/28 套件 `ok`；唯一 FAIL 仍是 `test-wiki-anchors.mjs`（wiki 文章引用的 `index.js` 行号越界 / 符号已不存在），属文档滞后于源码，重新编译后消失。

---

## 0.16.3 — 2026-10-30

### 修复：自动更新链路的五处缺陷（幂等、缓存、清单清理、口径、工作区语义）

**背景**：0.16.2 修好「调度器只扫 job 历史」之后，继续逐项审查自动更新链路，发现仍有五处会让「过期了却没人编译 / 编译了却看不见」的问题。

**修改**：

| 位置 | 缺陷 | 改动 |
| --- | --- | --- |
| `index.js:467` `normPathKey` | 无条件 `toLowerCase()`，在 Linux/macOS 上把 `/home/u/Foo` 与 `/home/u/foo` 判成同一仓库，幂等吞任务、清单少登记 | 只在 `process.platform === 'win32'` 时小写化 |
| `index.js` `submit` / `findActive`（`index.js:3838`） | 用严格 `j.cwd === cwd` 比较，未归一化；同一仓库以尾分隔符或盘符大小写不同写法出现时并发两条任务，破坏单项目串行与自动调度幂等 | 统一用 `normPathKey` 比较 |
| `index.js:484-506` `hasCompilableSources` | 「无源码」也缓存 600s，自动路径不调用 `clearSourceProbeCache`；一旦误判成空壳就静默跳过 10 分钟 | 新增 `DSH_CODEWIKI_SOURCE_PROBE_EMPTY_TTL_MS`（默认 60s）：`has=true` 仍缓存 10 分钟，`has=false` 只缓存 60s |
| `index.js` 启动清理 | `rememberRepo` 只追加；掉出 `MAX_JOBS_KEPT` 的失效目录永久留在 `REPOS_FILE`，每轮被重扫、清单无界增长 | 启动时整写一次 `loadKnownRepos().filter((dir) => isDeadCompileTarget(dir) === false)` |
| `index.js` `schedState` + `/api/codewiki/repos` | 幂等命中不设 `submitted`，面板「扫到 N 仓、提交 0」看不出是在编译还是无事可做 | 拆成 `lastScanSubmitted` / `lastScanBusy` / `lastScanNoop` / `lastScanSkipped` 四个口径 |

### 修复：自动调度现在遵守 `workspaceOnly`（默认开）

**问题**：`wsFilterPaths()` 只用于 `/api/codewiki/jobs` 与 `/api/codewiki/repos` 的**展示过滤**，`autoScan` 完全不用它。于是被移出 dsh 工作区清单的仓库仍会被后台定时编译、产物悄悄写进它的 `.codewiki/`，而面板上根本看不到这条任务——用户既不知道它在编译，也无法取消。

**修改**：

- 新增导出函数 `workspaceFilterPaths(registry, config)`（`index.js:4506`）：注册表不可用或 `workspaceOnly === false` 时返回 null，`list()` 抛错时告警降级（过滤是体验优化，不能拖垮端点）。`installWebServer` 内改为复用它，端点行为不变。
- `apply()` 新增 `schedWorkspaceRegistry`，经 `ctx.inject(['workspaceRegistry'], ...)` 取宿主注册表；`autoScan` 在排除清单判定**之前**加闸门：命中工作区外则 `lastScanSkipped++` 并跳过。只影响「是否新提交」，不打断进行中的编译。
- `client.js` 面板统计串新增「工作区外跳过 N」，中英词表各补 `skippedLabel`——否则「清单里有 N 个仓库、扫到 M 个」的缺口无法解释。

**验证**（当轮输出）：

- 新增用例「幂等：同一仓库以不同路径写法提交只允许一条活动任务」（`test-orchestration.mjs:1595` 起）：首轮实测红（`✗ 幂等命中：cwd 尾分隔符 ... 实际 submitted=true jobId=job-mvtqhcrj-1`、`✗ ...盘符大小写不同...`、`FAIL：2 项未通过`），修复后转绿（`✓ ... submitted=false jobId=job-mvtqjzyq-0`、`PASS：编排冒烟全部通过`）。
- 新增用例「空判定缓存必须短暂」（`test-worktree.mjs`）：`✓ 空判定在 TTL 内仍走缓存（不立刻反转）`、`✓ 空判定 TTL 过后重新探测：补回源码即恢复 === true`。
- 新增用例「自动调度遵守 workspaceOnly：工作区外仓库不被后台编译」：**反向验证**——把闸门临时短路成 `if (false && ...)`，立刻红（`✗ 工作区外仓库未被自动提交（实际 1 条：[{"kind":"full","stage":"crosscut"}]）`、`✗ 面板可见工作区外跳过计数（实际 0）`、`FAIL：2 项未通过`）；恢复后转绿（`✓ 实际 0 条`、`✓ 跳过计数 1`）。
- 全量：27/28 套件 `ok`；唯一 FAIL 是 `test-wiki-anchors.mjs`（wiki 文章引用的 `index.js` 行号越界，源码已从 5079 行长到 5095 行），属文档滞后于源码，重新编译后消失。

---

## 0.16.2 — 2026-10-29

### 修复：自动更新只扫任务历史，已编译仓库被截断后再也不自动编译

**问题**：自动更新调度器（`autoUpdate`）在 `index.js:4989` 只从 `service.list()` 取 cwd——也就是**当前 job 历史**里的工作区。但 job 记录会被 `MAX_JOBS_KEPT=30` 截断、启动时还会清掉 Temp 目录的终态任务，于是「编译过一次、后来没再手动编译」的仓库一旦掉出历史，就永久退出自动扫描：面板上仍显示它 `state: stale`、过期文章数一屏，可 `lastScanRepos` 里根本没有它，`lastScanSubmitted` 恒为 0。用户看到的现象正是「过期了却不会自动更新文章」。

同一份插件里早有独立的持久清单 `REPOS_FILE`（`loadKnownRepos()` / `rememberRepo()`，`index.js:2028-2050`），`/api/codewiki/repos` 总览接口也一直是用「job 历史 ∪ 已知仓库」拼出来的（`index.js:4591`）——只有调度器漏用了它。

**修改**：

| 文件 | 改动 |
| --- | --- |
| `index.js:4991` | 扫描来源改为 `loadKnownRepos() ∪ service.list()`（去重），并注释说明为何必须合并（历史会截断、启动会清 Temp 终态） |
| `index.js:5012` | 心跳间隔支持 `DSH_CODEWIKI_AUTO_SCAN_MS` 覆盖（下限 100ms），生产默认仍 60s——否则真实心跳没法在测试里等 |
| `test-orchestration.mjs:16` | 压到 100ms 的真实心跳，仍走 `apply()` 里那套 `autoScan`，不 mock 调度器 |

**验证**（当轮输出）：

- 新增用例「历史清空后，真实心跳仍扫描已知仓库并自动提交过期编译」：真 git fixture + mock LLM，先 `scope=auto` 全量编译一次并确认 `REPOS_FILE` 里有它 → **dispose 旧服务**再清空 `JOBS_FILE`（`mergeFromDisk()` 只增不删，运行中清盘造不出「历史为空」现场）→ 新起 `autoUpdate:true, autoUpdateMin:5` 的服务 → 改 `core/core.py` → 断言 `cw status` 已是 stale，再等心跳。
- **反向验证**：把 `index.js:4991` 临时改回旧实现（只扫 `service.list()`），该用例立刻红（`✗ ...（现场 []）`，`FAIL：1 项未通过`）；恢复修复后转绿（`✓ ...（现场 [{"scope":"auto","kind":"stale","stage":"articles"}]）`）。证明它抓的正是这条缺陷，而不是恰好通过。
- 全量：`node test-orchestration.mjs` → `PASS：编排冒烟全部通过`（exit 0）。前序用例遗留的活动态 fixture 任务会占住单项目串行闸门（初始化一直 `queued`、wiki 从未编译出来），因此本用例把清盘动作放在 `apply` 之前，并新增「初始化必须到 done」与「心跳前判态必须已过期」两条前置断言，避免把排队失败伪装成判态 bug。

---

## 0.16.1 — 2026-10-29

### 修复：允许 partial 推进基线，打破编译死循环

**问题**：引擎超时时（articles 阶段 2700000ms 超时），35 篇文章已写入但 `_meta.yaml` 基线未更新（`last_compiled_commit` 仍指向上次提交）。由于 `canAdvanceBaseline` 仅在 `done` 时为 true，partial 状态永不推进基线，导致每轮编译都全量重跑，形成死循环。

**修改**：

| 文件 | 改动 |
| --- | --- |
| `lib/engine/native-run.js:169` | `canAdvanceBaseline` 允许 `partial` + `rawTreeFiles>0` |
| `lib/engine/quality-gate.js:552` | `canAdvanceBaseline` 允许 `partial` + 有文章写入 + 无 defect/degradation |
| `lib/engine/apply-plan.js:656` | 删除 `problems.length===0` 条件（质量门已裁决） |
| `lib/engine/client.js:368` | **关键修复**：超时后检查 `reader.progress`，有 `writtenCount>0` 时返回 `partial` 而非 `failed` |

**验证**：

- `test-engine-native-job.mjs`：99/99 通过
- `test-engine-native-incremental.mjs`：96/96 通过
- `test-engine-quality-gate.mjs`：29/29 通过
- 全量回归：所有功能测试通过（test-wiki-anchors 的 10 败为历史文档引用错误，待下次 codewiki_generate 重编译修复）

**提交**：`dec253e4`

---

## 0.16.0 — 2026-10-29

### 阶段 7 受控退役：原生引擎转正为默认通道，删除 Node 侧重写的 FSoft 算法

用户明确指示「可以删除」。0.15.0 时的决定是「两条通道都保留、`nativeEngine` 默认 `false`」，
理由是留住回退路径且符号级增量只有 Node 侧实现——本版推翻该决定：同一套算法（符号提取、
聚类、图 diff、增量裁决、更新规划）在 Node 侧维护一份、Python 侧再由上游维护一份，等于
每次算法演进要改两处、验证两遍，而 Node 版无法自证与上游一致（0.13.2 那次靠 78 条黄金
对拍才发现偏差）。真实验收（0.15.0 八场景）已覆盖迁移目标，退役前置条件解除。

**默认值切换**

- `index.js` Config：`nativeEngine: z.boolean().default(false)` → `default(true)`；
  `liveConfig` 判定 `val(c.nativeEngine) === true` → `val(c.nativeEngine) !== false`
  （未设置即视为开启，与其它布尔项口径一致）。
- `client.js` 提示文案同步：`nativeEngine` 相关说明改为「0.16.0 起默认开启」。

**删除被替代的实现**（合计 2627 行）

| 删除文件 | 行数 | 被谁替代 |
| --- | --- | --- |
| `lib/symbols.js` | 884 | 原生引擎 Python 侧符号图 |
| `lib/cluster.js` | 467 | 原生引擎模块树构建 |
| `lib/graph-diff.js` | 578 | 上游 `updater/graph_diff.py` |
| `lib/incremental.js` | 206 | 原生引擎增量裁决 |
| `lib/update-planner.js` | 492 | 原生引擎 ownership / stale scan |

连带删除 7 套测试：`test-symbols.mjs`、`test-cluster.mjs`、`test-graphdiff.mjs`、
`test-incremental.mjs`、`test-incremental-e2e.mjs`、`test-update-planner.mjs`、
`test-semantic-plan.mjs`（该套测的是 `cluster.js` 的 `semanticPlan`）。

**`index.js` 侧清理**

- 删 `semanticPlan()`（AST 提取 → LLM 聚类 → 模块清单）与 `extractCurrentGraph()`。
- 删 `slimPlanForJob()`、`loadModuleMap()`、`saveModuleMap()`、`tickIndex` 里的符号快照写入。
- 新增 `attributeChanges(changeSet, articles)`：文件级归属判定，返回 `{unmapped, touched}`
  ——变更集里每个源码路径只要被某篇既有文章的 `source_files` 认领（或它是一次 `git mv`
  改名的源路径）就算「已消化」；`touched` 是认领了变更的文章名集合。
- `runStaleUpdate` 与「stale 但解析不出过期文章」两条分支重写：任务清单 = 「`source_files`
  命中变更的文章」∪「`cw status` 报出的过期文章」；`blockers` 只保留未归属源码变更；
  两处 `svc.submit` 不再传 `updatePlan`。
- `job.updatePlan` 字段保留但恒为 `null`（兼容已落盘旧 jobs、面板与 `update-record` 的读法），
  终态判定由 `judgeOutcome` 的 `expectedNames` 通道承担。
- `localPlan()` 由 `buildPlan()` 直接调用（不再有 `planMode==='auto'` 分支），注释写明它只
  服务 `nativeEngine=false` 兼容通道。
- `planMode`、`symbolIncremental` 两个配置项**保留但已无实际效果**（仅兼容既有
  `settings.json`），`description` 与 `client.js` 表单提示改写为「已退役」，不再声称提供
  语义聚类/符号级增量。

**保留**：`lib/agentic.js`、`lib/agentic-host.js`、`lib/articles-agentic.js`（agentic 写作
通道，兼容通道仍用）、`lib/article-contract.js`（两条通道共用的文章契约）、
`lib/change-set.js`（四路变更采集）、`lib/update-record.js`（可机读更新记录）、
`lib/git-paths.js`、`lib/engine/`（原生引擎适配层，全部保留）。

**已知能力损失**（如实记录）：`nativeEngine:false` 从「功能对等的第二套实现」降级为
「最小兼容通道」——只按顶层目录分组、只做文件级 `source_files` 归属判定，没有反向依赖
闭包、没有纯注释跳过、没有新文件 ownership 路由。改一个被 10 篇引用的函数，兼容通道只会
重写直接认领它的那一篇。需要符号级增量请用原生通道。

**测试**：`node --check index.js client.js` 通过；`import('./index.js')` 成功（46 个导出）。
剩余 28 套测试逐个实跑：**27 套全绿、退出码 0**。`test-orchestration.mjs` 需把
`LEGACY_CHANNEL` 补上 `nativeEngine: false`（该文件守护的是兼容通道的请求次数与落盘时序，
不钉住会被默认值切换带到原生引擎上）；`test-wiki-anchors.mjs` 默认档
**3315 过 / 7 败 / 123 待重编译**，7 条失败全部是 `.codewiki/` 文章引用了已删除的符号
（`saveSnapshot`/`sameSnapshotContent`/`runEngine`/`rawCode`/`ENGINE_CONTRACT_VERSION`/
`inspectArticle`）或行号越界，属文档滞后，按纪律不手改文章、留待重编译覆盖——与 0.15.0
的基线（5 败）相比新增的 2 条正是本次删除造成的，重编译后消失。

## 0.15.0 — 2026-10-29

### 原生引擎通道通过真实生产验收（阶段 6/7）：八场景真跑 + 修掉 8 个只有真机才暴露的缺陷

用**真实** Python venv（Python 3.12.10、`codewiki 2.0.0`、`pip check` 零破损、源码锁上游 commit `03d0a294ad58f3c878bd8aeb0ef5e95a2ff8c3ca`）+ **真实** `workbuddy` 模型（经 `lib/engine/llm-bridge.js` 转发真凭证真云端）跑完整生产链路（`codewiki_generate` 工具 → JobService → `lib/engine/native-run.js`），fixture 是 `tools/fsoft-engine/fixtures/中文 空格 fixture` 的临时 git 副本（含中文与空格路径）。八场景实测：

| 场景 | 终态 | 关键数字 |
|------|------|----------|
| 全量编译 | `done` | 241s、written 13、`commit.scope.ok=true`、工作区干净 |
| 已提交改动的 stale 增量 | `done` | 10.7s（全量的 ~4%）、written 9、无 `_native-state` 自嵌套 |
| 工作区未提交改动 | `partial` | `uncommitted-input` 记账、基线不推进、文章照写 |
| 重命名（`git mv` + 类改名） | `done` | 3 条变化、新增并重写模块页 |
| 删除模块 | `done` | 孤儿页在同提交清理（3 篇 → `fixture-boot.md`/`fixture-web.md`） |
| 取消（`POST /api/codewiki/control`） | `cancelled` | 基线不推进、HEAD 不变 |
| 解释器路径不存在 | `failed` | stage=env、原始 ENOENT 带出 |
| 无变化轮（连跑两轮） | `done` 零副作用 | `written 0`、`commit.noChanges=true`、HEAD 不变、`git status` 空 |

**真机才暴露、本轮修掉的 8 个缺陷**（假引擎测试一条都测不出，因为 `test-fixtures/fake-native-engine.mjs` 读平铺字段、自报 `no_change`、产物全是 ASCII 名）：

1. **非 ASCII 路径被误判越界**。`git show/diff --name-only` 默认 `core.quotepath=true`，中文路径变成八进制转义串，`verifyCommitScope` 按字面量判 `.codewiki/` 前缀失败 → 每次编译都被拉成 `partial`。新增 `lib/git-paths.js`（`withQuotepathOff` / `decodeGitPath` / `decodeGitPaths`），`apply-plan.js`、`change-set.js`、`index.js` 的路径读取全部改走它；只加参数挡不住已写进历史或外部传入的转义串，所以两层都要。
2. **引擎锁落在提交之外**。`writeLock` 在 apply（含自动提交）之后写盘，锁永远进不了提交、留成未跟踪脏文件，无变化轮也会因此产生提交。改为 `lockStatus==='absent'` 时把 `buildLockBody(doctor.current)` 塞进 apply 写集（与文章、受管状态共享同一 pre-image → 同回滚、同提交）。
3. **更新记录落在提交之外**。原生通道的提交发生在落地器内部，`saveRecord` 必然晚于提交 → 每轮留 `?? .codewiki/temp/update-record.json`。原生通道改为写到仓库外 `os.tmpdir()/dsh-codewiki-native-records/<jobId>/`（可用 `DSH_CODEWIKI_NATIVE_RECORD_DIR` 覆盖），面板仍读得到路径；旧 Node 通道不变（它的 `saveRecord` 本就在 `tickCommit` 之前）。
4. **协议字段位置不一致**。客户端按平铺发 `{requestId, action, ...payload}`（契约也是平铺），入口只读 `msg.payload` → `docsDir` 丢失，上游回退写进仓库 `.codewiki`，增量轮把受管状态水合成 `.codewiki/_native-state/docs/_native-state/docs/...` 逐轮自嵌套（实测 gate `unmapped:8 defects:14`）。`entry.py` 改为两种形状都认、平铺优先。
5. **入口 stdin 按 locale 解码**。客户端按 UTF-8 写请求行，Windows Python stdin 默认 cp936 → 中文仓库路径读成 `涓?鏂? 绌烘牸` 后报「仓库路径不存在」。入口把 stdin 也钉成 UTF-8（stdout/stderr 仍 `errors="replace"`，stdin 用 strict：坏字节当场报错，别把乱码路径带下去）。
6. **上游内部子进程按 locale 解码**。上游 `subprocess.run(..., text=True)` 在 Windows 用 gbk 解 UTF-8 路径，reader 线程抛 `UnicodeDecodeError` 使 `stdout` 变 `None`，`repo_analyzer.py:65` 直接 `AttributeError`。入口 import 后给 `subprocess.Popen.__init__` 补 UTF-8 编码兜底（只在 `text=True` 且未显式指定编码时生效）。
7. **无变化轮仍产生提交**。上游把 `.codewiki/_meta.yaml` 当源码组件分析（`use_gitignore=True` 但不排除 `.codewiki/`），图 diff 永远有 `body:1` → 永远 `incremental`，每轮一笔纯记账提交 + 白花 routing 模型调用（~528 prompt tokens / 3.5s）。入口给依赖分析传 `agent_instructions.exclude_patterns = ['.codewiki', 'CodeWiki.md']`（实测扫描面 24 文件 → 4 文件，wiki 产物命中 0），不影响 git 变化集、`cw index`、基线或 docsDir 输出。
8. **删除模块后孤儿页残留**。gate 只体检本次产物，而删除时上游可能回 `full_fallback` 且 `pages_removed: []`，描述已删代码的页永久留在库里还挂在 `_index.md` 上。新增 `apply-plan.js` 的 `findOrphanPages()`（`source_files` 非空且**全部**失效才判孤儿；空 source_files 与部分失效一律不动）与 `checkDeleteTargets()`，`applyNativeOutput({deleteFiles})` 让删除走落地事务（同 pre-image、同回滚、同提交、收空目录），`native-run.js` 在真的落地轮才扫（无变化轮不扫不删）。

**测试**：34 套全绿——`test-engine-native-job.mjs` **99/99**（+3 条真机断言：引擎锁进同一提交、提交清单是真实路径而非转义写法、落地后 `.codewiki` 工作区干净）、`test-engine-native-incremental.mjs` **82/82**、`test-engine-apply-plan.mjs` **41/41**（+3 条孤儿页语义）、`test-engine-python-entry.mjs` **12/12**（+2 条：平铺字段、非 ASCII 请求行）、`test-change-set.mjs` **16/16**（+1 条非 ASCII 产物不被当成源码变化），其余各套与改前一致。`node --check index.js` 通过。

**如实记录的未达成项**：

- **`workbuddy/hy3` 硬门禁未通过**。阶段 1B 第 4 条要求实测 `workbuddy/hy3`；当期 hy3 返回 `429 quota_exceeded`（“您的使用量已超出频率限制，将在 2026-10-29 14:23:38 UTC+8 重置”），故八场景真实验收用 `workbuddy/glm-5.3`。这属上游配额、不是适配层问题，但规格的硬门禁确实没满足——额度恢复后必须把 `batchModel` 改回 `hy3` 重跑八场景才算闭环。首两次重跑因此 `failed`（`Exceeded maximum output retries (3)`，engine 字段全空），未计入验收。
- **`test-wiki-anchors.mjs --strict` 未全绿**。本轮实测（2026-10-29，11 项修复全部落盘后重跑）：strict **3354 过 / 59 败 / 32 待重编译**，默认档 **3354 过 / 5 败 / 86 待重编译**。59 条构成：**34 条「指向空行」**（锚点行号落在空行、或区间内无代码）、**20 条「符号未绑定」**（`idleRound`/`symbolIncremental`/`runEngine`/`normalizeIndexLinks`/`normalizeArticlePath`/`resolveBinary`/`numberLines`/`reminderText`/`tickIndex` 等符号不在所引区间内）、**4 条「符号不存在」**（该符号在目标文件里 0 次出现）、**1 条「起始行越界」**（`test-wiki-anchors.mjs:778` 超出该文件当前 404 行）。按目标文件分布：`test-engine-apply-plan.mjs` 26 条、`index.js` 8 条、`README.md` 6 条，其余零散分布在各 `.codewiki/modules/*.md`。**主体是 `.codewiki/` 文章滞后于本轮代码，不是校验器缺陷**——按纪律不手改文章，留待一次真实全量重编译覆盖（重编译后基线前移，这些会自动升级为硬断言）。此前记录的「严格档 3234 过 / 63 败 / 33 待重编译」「默认档 2196 过 / 8 败」均已过期，以本次实测为准（总数从 3234 涨到 3354 是本轮新增测试断言带来的有效锚点增量，失败数 63→59 是修复过程中 `.codewiki` 基线随提交前移的结果）。
- **阶段 7 退役未执行，待用户决策**。规格 L93 要求「真实通过后才删除被替代的 Node 路径」；`nativeEngine` 当前默认仍为 `false`，旧 Node 流水线仍是主路，`symbols`/`cluster`/`graph-diff`/`incremental`/`update-planner` 一行未删。是否把原生通道切成默认通道、以及何时删旧路径，**由用户决策后再动**，本仓库不擅自切换。
- 上游 rung3 语义使**单模块内的方法级新增**不触发重写（component id 不在 tracked 集 → `untracked` → 不进 ownership），因此「增量改了文章」这一条用结构性变化（新增/删除/重命名）验证，而非方法级改动。

### 文档与默认策略（阶段 7）

- **旧 Node 流水线保留，`nativeEngine` 默认仍为 `false`。** Node 通道是默认路径也是原生通道的回退；两条通道共用落地器/质量闸/变化集/受管状态/文章契约，退役不会减少维护面。退役前置条件（尚未满足，故未执行）：原生通道在大仓（>2000 文件）与多语言混合仓跑通，且原生编译后 `--strict` 全绿。
- `README.md` 新增「原生引擎通道（0.15.0，可选，默认关闭）」整节：四环节分工、运行要求（Python 3.10+ 独立 venv + `pip check` 零破损 + 非 ASCII 路径两处编码修复）、四个新设置项、八场景真实验收表、8 条修掉的缺陷、4 条已知限制、保留/退役决定。原「不引入 Python 运行时」的表述已按事实改写（默认通道仍不需要 Python，原生通道需要）。测试清单从 18 个文件更正为 34 个并分通道列出。
- `docs/fsoft-native-engine.md` 新增「上游同步」章节：固定 commit 与如何升级、上游 changelog 要点、契约测试与 fixture 如何复现、真实编译怎么跑、回滚步骤。
- `cordis.patch.yml` 注释补齐 `autoCommit` 与四个原生键（含「不做找可用解释器」与「不悄悄换通道」两条硬规则）；`index.js` 里 `nativeEngine` 系列字段的描述与阶段注释同步为最终语义（full 与 stale 都接管，决议权在 native-run）。
- `package.json` `version` → **0.15.0**；`description` 改为如实描述两条通道与各自运行前提。

### 修复：main...HEAD 双轴 code-review 的 11 项发现（Spec 7 项 + Standards 4 项）

一轮 Standards + Spec 双轴审查（`main...HEAD`）在原生引擎通道上找出 11 项问题，本轮逐项处理：

**Spec 轴**

- **S1 上游锁 commit 抄错 38 位**。规格锁 `03d0a294ad58f3c878bd8aeb0ef5e95a2ff8c3ca`（40 位），仓库四处写成 38 位的 `03d0a294adf3c878bd8aeb0ef5e95a2ff8c3ca`（缺 `d58`）——那不是合法 git sha，锁定无从对账。四处（`docs/fsoft-native-engine.md:221`/`:266`、`CHANGELOG.md:7`、`README.md:85`）全部改为 40 位。
- **S2 manifest 指纹不含上游 commit**。原 `fingerprintOf()` 只哈希 `manifestVersion+version+pythonVersion`，而 `codewiki 2.0.0` 这个版本号写在上游 pyproject 里、换 commit 不变 → **换了引擎源码会被静默判成 match**。现在 `lib/engine/manifest.js` 导出 `UPSTREAM_COMMIT` 常量 + `normalizeUpstreamCommit()`（只认 40 位十六进制），`probeEnvironment()` 把它带进 facts、`fingerprintOf()` 哈希进指纹、`buildLockBody()` 落进 `.codewiki/engine-lock.json` 的 `upstreamCommit` 字段、`compareLock()` 逐字段比对（仅上游变也判 drift 并点名 `upstreamCommit`）；声明不合法时 `doctor()` 的 advice 明确写「本轮不构成有效锁定」。`test-engine-manifest.mjs` 新增 8 条（合法性、38 位/大写/空白归一、上游变化→指纹变化、锁可读回、drift 字段、doctor advice）。上游锁是**声明**不是探测结果，所以 `native-run.js` 显式透传 `upstreamCommit` 而不是等 probe 自报。
- **S3 阶段 7 退役未执行**（不是缺陷，是待决策项）。规格 L93 要求「真实通过后才删除被替代的 Node 路径」，当前 `nativeEngine` 默认 `false`、旧流水线仍是主路。本轮**没有删旧代码**：是否切成默认通道、何时删旧路径由用户决策。状态已写进本文件与 `README.md` 的「保留与退役」节。
- **S4 四路变更只落了 committed**。原实现把 staged/unstaged/untracked 记进 `state.json` 的 unconsumed，却仍让引擎按 HEAD 记账——产物反映工作区内容、账本指向 HEAD，正是「变化悄悄丢」的入口。新增 `lib/engine/workspace-snapshot.js`：`createWorkspaceSnapshot()` 用**独立的临时 `GIT_INDEX_FILE`**（在 `os.tmpdir()`，不碰用户 index）跑 `read-tree <parent>` → `add -A -- .` → `write-tree` → `commit-tree`，造一个挂在 HEAD 上的 commit 而**不写任何 ref**（实测 `git for-each-ref --contains <sha>` 为空、HEAD 不变、工作区仍脏、`git diff --cached` 仍空）；`native-run.js` 的 1.9 段在引擎启动前造快照，把本轮 `commitId` 指向它（无快照时退回 HEAD）。质量门相应增加 `consumedInputCommit`：产物对得上快照不再误报 `commit-mismatch`，但 `uncommitted-input` 照旧判 defect —— 快照不挂 ref，把它记成已提交基线是不可逆的，终态仍 `partial`、基线不推进。造不出快照不算失败（退回 HEAD 记账 + note）：快照是「对齐精度」的改进，不是编译成立的前提。`test-engine-native-incremental.mjs` 用例 3 新增 5 条断言（40 位 sha、parent 是 HEAD 祖先、快照本身不进 HEAD、引擎收到的 commitId 就是快照、无 `commit-mismatch`、无跳过文件）。
- **S5 strict 锚点未绿**。实测已如实记录并分析构成（见上文「如实记录的未达成项」第 2 条）：最新实测 59 败（34 指向空行 / 20 符号未绑定 / 4 符号不存在 / 1 越界），主体是 `.codewiki/` 文章滞后，**校验器代码不改**，留待真实全量重编译。
- **S6 原始树未独立保留**。原 `artifacts.rawTreeDir` 只指向 `module_tree.json` 单个文件，FSoft 整棵 docs 树被原地消费、无法回溯引擎原始输出。`lib/engine/native-state.js` 新增 `archiveDocsTree({docsDir, destDir})`（逐文件复制、双向重叠校验、失败只记 note——留档是证据不是产物），`native-run.js` 的 2.9 段在质量门前把 `outDocsDir` 整棵拷到仓库外（`os.tmpdir()/dsh-codewiki-native-raw/<requestId>`，可用 `DSH_CODEWIKI_NATIVE_RAW_TREE_DIR` 覆盖），`artifacts` 增 `rawTree`/`rawTreeFiles` 两字段（`contract.js` 同步），`index.js` 的 `job.nativeResult.artifacts` 一并带出，finally 只清临时 docsDir 不清留档。`test-engine-native-incremental.mjs` 用例 1 新增 8 条断言（落点在仓库外、不与落地产物重叠、含 `module_tree.json`/`metadata.json`/`modules/*.md`）。
- **S7 hy3 硬门禁被绕过**。已按事实写入「如实记录的未达成项」第 1 条：hy3 `429 quota_exceeded`，改用 `glm-5.3` 完成八场景，属**替代验证**而非符合规格，额度恢复后需重跑。

**Standards 轴**

- **R1 路径归一函数重复 5 份**（实为 6 处）。`String(p ?? '').replace(/\\/g,'/')` 复制在 `apply-plan.js`、`manifest.js`、`mapping.js`、`native-state.js`、`output.js`、`quality-gate.js`；全部收口到 `lib/git-paths.js:34` 的唯一 `export function toPosix(p)`，六模块改为 import（`toPosix` 或 `toPosix as posix`）。**故意不并的三处**语义不同，已在代码注释里写明理由：`article-contract.js` 的 `normalizeWritePath` 额外 `trim()+posix.normalize`、`change-set.js` 的 `normChangePath` 额外 trim + 越界判据、`incremental.js` 的 `normRel` 额外去 `./` + trim。
- **R2 写集/删除集越界校验重复**。`checkWriteTargets` 与 `checkDeleteTargets` 四段同形 if 抽成 `checkTargetPath(original, { scopeLabel })`（空 → 绝对路径/盘符/前导斜杠 → `..` 上跳 → 白名单），两侧只保留各自的特有判据（content 类型与重复投递 / 目录不许当删除目标与幂等跳过）。
- **R3 双提交器漂移**（`apply-plan.js` 的 `commitWikiArtifacts` 与 `index.js` 的 `autoCommitWiki`）。**本轮不改**：牵涉阶段 4 的通道切换，属另一张票。已知差异点：安全边界（只 add wiki 两路径、不 amend/push、无 HEAD 与冲突拒绝）两者一致，差异集中在 stage 前置条件与返回值形状，当前由两条通道各自使用、没有交叉调用。
- **R4 巨函数**（`index.js` 的 `createJobService` 1655 行、`native-run.js` 的 `runNativeJob` 710 行）。**本轮不改**：属架构级重构，另开票处理；拆分需要先固定八段管线的输入输出契约，否则拆完只是把耦合搬个位置。

**测试**：R1+R2 后 `test-engine-apply-plan.mjs` **41/41**；S2 后 `test-engine-manifest.mjs` **27/27**（21 → 27）；S6/S4 后 `test-engine-native-incremental.mjs` **96/96**（82 → 96）；`test-engine-quality-gate.mjs` **29/29**；`node --check` 对 `git-paths.js`/`manifest.js`/`mapping.js`/`native-state.js`/`output.js`/`quality-gate.js`/`apply-plan.js`/`native-run.js`/`contract.js`/`workspace-snapshot.js`/`index.js` 全部通过。

**全量复跑**（11 项修完后，2026-10-29）：34 套功能测试**全部通过、总退出码 0**——`test-engine-native-job.mjs` **99/99**、`test-engine-native-incremental.mjs` **96/96**、`test-engine-apply-plan.mjs` 41、`test-engine-manifest.mjs` 27、`test-engine-quality-gate.mjs` 29、`test-engine-contract.mjs` 19、`test-engine-client.mjs` 24、`test-engine-bridge.mjs` 24、`test-engine-llm-bridge.mjs` 17、`test-engine-output.mjs` 20、`test-engine-output-real.mjs` 11、`test-engine-python-entry.mjs` 12、`test-engine-process-tree.mjs` 5、`test-agentic.mjs` 55、`test-agentic-host.mjs` 16、`test-agentic-fallback.mjs` 10、`test-articles-agentic.mjs` 20、`test-article-contract.mjs` 29、`test-change-set.mjs` 16、`test-cluster.mjs` 30、`test-incremental.mjs` 20、`test-incremental-e2e.mjs` 8、`test-prune-orphans.mjs` 12、`test-semantic-plan.mjs` 11、`test-symbols.mjs` 24、`test-update-planner.mjs` 20、`test-update-record.mjs` 18，其余（`test-batch`/`test-cwd-paths`/`test-graphdiff`/`test-orchestration`/`test-sessions`/`test-wiki-entry`/`test-worktree`）无失败。锚点：strict **3354 过 / 59 败 / 32 待重编译**、默认档 **3354 过 / 5 败 / 86 待重编译**（构成与处置见上文「如实记录的未达成项」第 2 条）。

### 接入：FSoft 原生引擎统一增量与跨轮受管状态（阶段 5）

- **不再只查 committed diff**。`lib/change-set.js` 汇总基线至 HEAD、staged、unstaged、untracked、删除与改名；`.codewiki/` 与本轮临时 docs 排除在源码变化外。基线不可达时显式降级 full，不把失败当 clean。
- **跨轮状态跟文章同一事务**。新增 `lib/engine/native-state.js`，把模块树、metadata、依赖图、`update_record` 和上一轮文章水合进引擎输入，并作为 `.codewiki/_native-state/` 的受管状态随文章同批写盘、回滚和提交；`state.json` 记录已消费基线及未提交路径，未提交改动跨轮保留直到对应源码提交后成功消费。
- **增量走 FSoft `update`，不是重跑 generate**。引擎动作由 change-set 决议；缺图/树、版本变化显式 full 并记录原因；质量门/索引/基线失败回滚状态，自动提交失败保留产物并 partial。未提交输入诚实 partial、不推进基线。
- **无变化轮零副作用**。引擎 `no_change` 且四路变化集与未消费路径都为空时，落地器走明确 no-op：不写盘、不建索引、不推基线、不创建提交。修复了原实现仍写 `update-record`/更新 `_meta.yaml` 导致每轮制造空提交的问题。
- **生产接线**。`codewiki_update` 与 stale 任务在 `nativeEngine` 开启时进入原生通道；默认仍关闭，旧流水线保留。
- **验证**：`test-engine-native-incremental.mjs` **82/82**、`test-engine-native-job.mjs` **96/96**、`test-engine-apply-plan.mjs` **37/37** 全过；独立无变化探针 HEAD 保持不变。真实 FSoft 生产全量→增量仍待阶段 6 验收，本阶段测试使用真实子进程协议下的假引擎。

## 未发布 — 2026-10-28

### 新增：FSoft 原生引擎迁移的契约层与三段门禁（0/1A/1B/1C），尚未接生产

目标是把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」。本轮只做契约、锁定环境与真实链路验证，**生产路径一行未改，旧核心一行未删**。

- **阶段 0 冻结契约**：新增 `docs/fsoft-native-engine.md` 与 `lib/engine/contract.js`（版本化 `EngineResult/EngineProgress/EngineError`，`contractVersion=1`，八段 `ENGINE_STAGES`，四终态 `done/partial/failed/cancelled`，`validateEngineResult` 在反序列化边界做校验而不是信任磁盘对象）；`lib/engine/mapping.js` 定 FSoft 产物 → `CodeWiki.md`/`.codewiki/modules/`/`_meta.yaml`/`temp/update-record.json` 的落点，四条硬规则是「不臆造 `source_files`、不静默丢弃、不覆盖 slug 冲突、不改技术内容」。`test-engine-contract.mjs` 18 条。
- **阶段 1A 锁定环境**：`tools/fsoft-engine/setup-env.sh` 从零建 venv，`pip check` 零问题、六个 import 全 ok。安装**故意不走正常解析**——`openai`/`pydantic-ai-slim`/`pydantic` 约束互相打架，正常解析必然 `ResolutionImpossible`；冻结清单是已解析快照，按 `--no-deps` + `-c constraints.txt` 落盘再 `pip check` 反向验证。`probe-no-llm-graph.py` 在中文/空格路径 fixture 上跑无模型依赖图，`ok: true`，15 组件 / 6 叶子（python 9 + typescript 4 + null 2），结果固化在 `probe-no-llm-graph.result.json`。venv 与 fixture 运行产物不入 git（`tools/fsoft-engine/fixtures/.gitignore` 只留源码）。
- **阶段 1B 宿主模型桥**：`lib/engine/llm-bridge.js` 起只绑 `127.0.0.1` 的 OpenAI-compatible 服务，FSoft 只拿到 loopback URL/模型名/占位 key，真凭证留在宿主 provider 内；`lib/engine/openai-bridge.js` 双向翻译 OpenAI 请求体 ↔ 宿主 `llm.stream()` 的 `GenerateOptions`/`StreamChunk`。真机 `workbuddy`/`deepseek-v4.1-flash` 实测：流式 230 chunk、首 chunk 1847 ms、总 3144 ms；非流式带 usage。**工具调用往返暴露了一个只有真跑才看得见的 bug**：assistant 历史消息缺 `source` 字段会被宿主适配层丢弃，第二轮起模型看不见自己上一轮的工具调用（已修，`test-engine-bridge.mjs` 24 条含回归）。
- **阶段 1C 原生端到端**：Python+TypeScript fixture 全量真实跑通，五类增量逐类验证——注释改动 `no_change`（0 次 LLM 调用）、公开接口 `interface:1` → 重写 overview、新文件 `added:2` → 重写 overview、删除+改名触发 `stale_scan.fixed` 并修好旧符号名（页面里旧名 0 次/新名 20 次）、未变页面 mtime 未动。工作区未提交改动**FSoft 不认**（只取 committed diff），留给阶段 5 由 Node 侧合成 change-set。新增 `lib/engine/process-tree.js`：`terminateProcessTree` 用 `taskkill /T /F` 终止整棵树，实测 204 ms、残留进程 0；异常退出用 `--request-limit 1` 验证语义失败与进程退出码分离（退出码 4）。

**复核**：主代理重新运行 `pip check` 与无模型依赖图探针，分别得到 `No broken requirements found.`、`ok: true`（15 组件 / 6 叶子，R1–R5 全 true）；新增四套测试复跑为 18 / 24 / 17 / 5 全过。桥准入修复为 `randomBytes(32)` 随机占位 key + 与本次 key 精确比对，新增「同格式伪造 key 返回 401 且不触发模型」用例。1C 只确认原生 committed-diff 的四类场景；未提交工作区变更仍待阶段 5，不计作已通过。真实全量/增量、工具调用和进程树取消为子智能体报告，尚未由主代理重放。

### 新增：FSoft 原生引擎的阶段 2 可复用薄适配层（子进程协议/清单/产物校验），仍未接生产

阶段 2 只做「怎么可靠地跟引擎说话」与「怎么可靠地判它的产物」，**不重写任何 FSoft 算法**，也不改生产路径与旧核心。

- **`lib/engine/client.js`（424 行）——子进程协议层**。`runEngine()` 起子进程、把请求写成一行 JSON、按 `requestId` 关联 stdout 的 JSON-lines，四个动作 `doctor/generate/update/cancel` 同一套通道。协议违规逐条记 `protocolViolations` 而不是抛栈：`not-json` / `bad-shape` / `unknown-request` / `duplicate-result` / `late-result` / `bad-result` / `line-too-long` / `protocol-version`。三条关键设计：① 多字节 UTF-8 跨 chunk 不切坏（按 Buffer 缓冲再按行切）；② **语义结果只看 `result` 消息**——进程退出码 0 但无 result 记 `engine-protocol`，非零退出但给了 `done` 保留 `done` 并记 `nonzero-exit` 违规，避免「进程正常退出 = 成功」的误读；③ 取消后到达的 result 记 `late-result` 丢弃，不让已取消的任务把结果塞回来。超时/取消都走 `terminateProcessTree` 杀整棵树，不是只 kill 父进程。
- **`lib/engine/manifest.js`（181 行）——环境清单与锁定**。`probeEnvironment()` 拿引擎版本/解释器版本/`pip check` 结论，`fingerprintOf()` 只对「版本 + 解释器版本」取 16 位 sha256（不拿机器路径当指纹，换目录不该算漂移）。`readLock/compareLock/writeLock` 维护 `.codewiki/engine-lock.json`，`compareLock` 给 `absent/match/drift/unhealthy` 四态与逐项 diffs。`doctor()` 把环境不可信翻译成**可执行建议**而不是一句报错。
- **`lib/engine/output.js`（284 行）——产物校验**。`collectOutput()` 收集页/`module_tree`/`metadata`/`update_record`，`validateOutput()` 给可机读 problem 列表：缺 overview、页名与模块树对不上、`source_files` 指向不存在的文件、正文里的死链、`temp/` 下的工作文件被当成文章。`buildWritePlan()` 只产出「写哪些路径」，**不碰文章内容**。
- **`lib/engine/python/entry.py`（582 行）+ `stage_map.py`（97 行）——唯一的 Python 薄壳**。读一行请求 → 调 FSoft 公共 API → 写协议行；不实现依赖图、聚类、增量。`doctor` 真跑 `pip check` 并把结论放进 `EngineResult.engine.deps`（成功时也给证据，不能只说一句 done）。凭证面按「不回退读本机配置」设计：测试把 `HOME`/`USERPROFILE` 隔离到临时目录并设 `CODEWIKI_NO_KEYRING=1`，缺模型通道时走明确失败而不是去翻 `~/.codewiki`。
- **`EngineResult.engine.deps` 进契约**（`lib/engine/contract.js:131-136`）。原契约只保留 `version/commit/python`，`deps` 会被归一化**静默丢弃**，doctor 就白跑了。

**验证**：八套引擎测试 19 / 24 / 19 / 20 / 11 / 9 / 24 / 17 全绿（contract/client/manifest/output/output-real/python-entry/bridge/llm-bridge）；真实 venv 跑 `doctor` 端到端得到 `outcome: done`、`engine.version 2.0.0`、`python 3.12.10`、`deps.ok true`、`No broken requirements found.`、0 违规、834 ms。真实模型 `generate/update` 的薄壳通道**未验证**——本轮只用假模型探针验协议，不宣称真实编译通过。工作区变更增量仍是阶段 5 的事。

### 新增：FSoft 原生引擎的阶段 3 采用门与落地器（质量门 / 原子应用 / 索引基线回滚 / 自动提交），仍未接生产

阶段 3 补的是「引擎交回产物之后」的两层：**这批产物能不能被采用**，以及**采用这件事真的成立了没有**。仍然不重写任何 FSoft 算法，也不改生产路径与旧核心。

- **`lib/engine/quality-gate.js`（639 行）——采用门**。把三件事合成一个可机读裁决：① 产物自洽（复用 `output.js` 的 `validateOutput`，不重写判定）；② 目标格式契约（把映射结果渲染成真正的 wiki 文章，再走 `article-contract.js` 的 `inspectArticle`）；③ 基线可推进性（产物对应的 commit 必须等于 `HEAD`，且 `_meta.yaml` 的基线本身已入库）。**三类问题必须分开**是这层的核心理由：`defect`（产物自身坏了：缺入口/空正文/死链/`source_files` 指向不存在的文件/`commit-mismatch`）、`degradation`（页是真的但证据不足：whole-repository 模式下 `module_tree` 为 `{}`、页 `source_files` 为空 → 可入库但**不得推进基线**）、`stale`（wiki 陈旧，不是本次产物的错）。终态仍严格：三类皆空才是 `done`。渲染层用 `yamlScalar` 安全序列化标题，含 `:`、中文、反斜杠、换行的标题都不会产出坏 YAML。
- **`renderArticle` 只把 `action==='write'` 的页交出去**，且带缺陷的页**不放进 `rendered`**——否则调用方拿到一份「大部分成功」的写集，缺的那几篇没人知道缺。
- **`lib/engine/apply-plan.js`（738 行）——落地器**。四条硬不变量：① **写集封闭**（只允许 `.codewiki/` 之下与仓库根 `CodeWiki.md`，绝对路径/盘符/`..` 上跳/白名单外路径**整批拒写**，不是跳过该条——残缺写集会制造一份没人在意的半成品）；② **索引/基线失败即回滚**（`pre-image` 快照，新文件删掉、旧内容原样写回、`_index.md`/`_meta.yaml` 复原）；③ **提交失败不回滚**（文章本身是好的，只记 `commit-failed` 并如实返回 partial）；④ **未提交不许 done**（兜底再推一次 `commit-failed`）。
- **两条只有真跑才看得见的坑，都变成了闸门**。一是 `cw index` **退出码 0 不代表文章被收录**：`vendor/codewiki/src/main.rs:236-256` 逐篇 `frontmatter::parse`，解析失败就 `continue`，最后照样写索引并返回 0——落地器在 index 之后**比对写集与 `_index.md` 的实际链接**，缺页即记 `index-failed` 整体回滚。二是 Windows 上 `cw` 写出的链接可能是 `[[modules\a|x]]`，落地器自己带一份 `normalizeIndexLinksIn`（不 import `index.js`，避免单测拉起宿主服务），规范化**失败要回滚**而不是吞掉——否则「索引文件坏到读不出来」会被当成「不需要规范化」然后判成功。
- **`cw init` 前置**：仓库还没有 wiki 时先跑 `cw init` 建骨架（对齐 `index.js:4021` 的 `state=missing` 分支）；`.codewiki/` 存在但缺 `_meta.yaml` 视为人工删改，记 `wiki-missing` 拒绝自动初始化。
- **默认自带同语义提交器 `commitWikiArtifacts`**，安全边界逐条对齐 `index.js` 的 `autoCommitWiki`（只 add wiki 两个路径 / 不 amend 不 push / 无 HEAD 与冲突一律拒绝），提交成立后再用 `verifyCommitScope` **反查实际提交内容**，混进 wiki 之外的路径记 `commit-scope`（不回滚，如实报出来）。
- **三处既有模块的极小改动，默认行为一字不变**：`lib/article-contract.js` 增加 `requiredSections`（原生通道的章节名是 FSoft 自己的 `## Introduction and Purpose` 之类，用 agentic 通道的 `## Overview` 去判它等于给一份**被禁止手改**的正文判死刑）与 `allowEmptySourceFiles`（whole-repository 模式下空 `source_files` 是**诚实记录**而非编造），并修了 `unquote` 对双引号标量的转义还原；`lib/engine/output.js` 把 `collected` 原样带出（避免上层为读 `commit_id` 再扫一遍 docs 造成判据漂移）；`lib/engine/python/entry.py` 的 `_count_docs` 改为 `rglob` 递归（hierarchical 布局把页写在子目录，只 glob 根层会漏计子树）并排除 `temp/` 与点目录。

**验证**：新增两套测试 `test-engine-quality-gate.mjs` 29 条、`test-engine-apply-plan.mjs` 37 条全绿；全套 33 套测试复跑全绿（`test-batch` 148、`test-agentic` 55、`test-article-contract` 29、既有 8 套引擎测试 19/24/19/20/11/9/24/17 等），只有 `test-wiki-anchors` 报「3335 过 / 46 败 / 39 待重编译」——存量锚点问题，非本次引入。真实 cw 端到端两次实测（临时 git 仓库）：`tools/fsoft-engine/probe-apply-real-cw.mjs` 走完写盘 → `cw index` → `cw meta update` → 自动提交，提交内容恰为 `.codewiki/_index.md`、`.codewiki/_meta.yaml`、`.codewiki/modules/core.md`、`CodeWiki.md`，`verifyCommitScope` 返回 `{"ok":true,...,"unexpected":[]}`；`tools/fsoft-engine/probe-index-missing.mjs` 验证「退出 0 但缺页」被记 `index-failed` 并回滚。这两项仍**未接生产**：`index.js` 的编译主流程尚未调用 `gateNativeOutput`/`applyNativeOutput`，是阶段 4 的接线。

### 接入：FSoft 原生引擎进入生产 JobService（阶段 4），默认仍走旧 Node 流水线

阶段 3 的门与落地器此前只有测试能调；这一轮把它们**接进真实的 JobService**，`codewiki_generate` / `codewiki_update` 的 full 编译可以走原生通道。**默认关**（`nativeEngine: false`），打开才切；旧流水线一行没删，仍是默认路径。

- **`lib/engine/native-run.js`（494 行）——单次编译的裁决管线**。把四段串成一条链：环境（`doctor` + 引擎锁比对）→ 引擎 `generate`/`update` → `gateNativeOutput` → `applyNativeOutput`，终态取**三者最弱**（`cancelled < failed < partial < done`）。这条规则是这层的全部意义：**引擎报 done 不能替代质量门**（假引擎写空产物 → 真 gate 判 failed → 整批 failed，`test-engine-native-job.mjs` 用例 15），**落地器 partial 不能报 done**（提交不成立 → partial + `canAdvanceBaseline:false`，用例 10）。`partial`/`failed`/`cancelled` 一律不推进基线。
- **模型桥**：`startLlmBridge` 起 loopback 桥，FSoft 只拿 `CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`(占位)/模型名。修了一个**必然踩中**的接线 bug：`bridge` 对象根本没有 `model` 字段（`Object.keys(bridge)` 只有 `url/placeholderKey/port/stats/close`），原写法 `bridge.model ?? ''` 恒为空串 → `entry.py:_model_config()` 判缺模型通道 → 每次原生编译都在 cluster 段 `engine-model` 失败。改为由调用方传 `model`/`clusterModel`（`nativeEnginePlan(channel,{...,model,clusterModel})`，index.js:252）。占位 key 每次 `randomBytes(32)` 随机生成、只进子进程 env、不进日志（`onLog` 只记 `{at,method,path,status,ms}`）。
- **`docsDir` 必须放仓库外**。原设计写 `.codewiki/temp/native-docs`，实测首次编译**整批失败**：引擎先把这个目录建出来但没有 `_meta.yaml`，`apply-plan.js:549` 的 `wikiExisted` 判定据此认为「人工删改过半截库」→ `wiki-missing` 拒绝初始化。改为 `os.tmpdir()/dsh-codewiki-native-<jobId>`，落地后清理（`index.js:2727` 起）。
- **环境失败如实失败，不绕过**：`doctor` 报 `probe-failed` → `engine-missing`；锁 `drift` → `engine-deps`（版本/Python 变化必须重新锁）；`pip check` 不闭合 → `engine-deps`，**不自动 `pip install` 糊过去**。首跑 `absent` 时**不**在编译前写锁（否则编译失败也会留下「已锁定」的假象），改为产物落地成功且 `.codewiki/_meta.yaml` 已存在后才写。
- **JobService 接线**（`index.js:2713-2890`）：`nativeRuns`/`nativeResults`/`nativeAborters` 三张表，`startNativeRun` 建 `AbortController` 并起 `runNativeJob`，`tickNative` 在 10s 节拍上收割结果；阶段映射 `NATIVE_STAGE_TO_PANEL` 把八段映射回既有面板契约（`env/graph/cluster/articles→articles`、`validate→review`、`index/baseline→index`、`commit→commit`），**不新增面板阶段值**。取消沿用既有语义：`cancelRequested` → abort 进程树 → 只写 cancelled、迟到结果不覆盖终态。单项目串行、幂等 findActive、面板 record 全部复用既有实现。
- **`client.js` 面板**：新增「原生引擎」通道标识与 `nativeStageLabel`/`gateLabel`/`applyLabel` 等文案（中英双语），终态后展示质量门与落地器各自的 outcome；不影响旧通道显示。
- **保守默认的理由**：真实全量/增量编译仍未由主代理端到端重放（本轮验证到「真 gate + 真 apply + 假引擎真进程」这一层），且 stale 增量还走内置流水线（统一增量是阶段 5）。所以默认 `nativeEngine:false`，原生是显式 opt-in；`symbols`/`cluster`/`graph-diff`/`incremental`/`update-planner` 一行未删。

**验证**：新增 `test-engine-native-job.mjs`，**96 项断言全过**，16 个用例全部走真实链路（`codewiki_generate.execute → JobService.submit → tick(300ms) → tickNative → runNativeJob`），gate/apply 是真的、引擎用真 node 进程跑的假引擎（真 stdio + 真 JSON-lines 协议，不是 stub 函数）：成功 done（写盘+索引+基线+提交全成立）、partial（引擎少写一篇）、failed（引擎崩）、取消（stall 模式，断言进程树被终止且迟到结果不覆盖终态）、引擎 done 但产物为空被质量门拦下、环境失败（`probe-failed`/`deps-bad`）、锁漂移、`cw index` 失败（`_index.md` 变目录 → 真 exit 1）回滚、`cw meta update` 失败（`_meta.yaml` 删 `project:` 行 → 真 exit 1）回滚、提交失败（`commit-failed` 不回滚产物）、单项目串行（第二个仓库 queued 后自动轮到）、**旧通道默认不受影响**（`nativeEngine` 关闭时引擎足迹为空数组、`channel` 未设、无 `nativeResult`）、stale 不走原生。全套 34 套测试复跑全绿；`test-wiki-anchors` 仍报「3263 过 / 12 败」——存量锚点问题（`git stash` 掉本轮改动后基线为 3138 过 / 44 败，本轮改动让失败数从 44 降到 12、无新增失败项）。

**未完成边界（如实）**：① 真实 FSoft 全量/增量编译**未**在本轮由生产通道端到端重放（只用假引擎验证了接线与裁决，真实 Python 引擎的单次编译仍是阶段 1C 的 fixture 级证据）；② 统一增量（含未提交工作区变更合成 change-set）是阶段 5，`stale` 不走原生；③ 阶段 5-7 未动。

## 0.14.0 — 2026-10-27

### 修复：增量漏检、部分失败仍报成功、坏文章入库（融合 FSoft 的 updater/质量门）

一轮审计确认了三类缺陷，共同后果是「wiki 看起来编译完了，但库里的文章与代码对不上」。本轮按 P0 顺序逐项修，每项都有回归测试。

- **增量漏检（最严重：工作区改动永远不被看见）**。过期判定只跑 `git diff <last_compiled_commit>..HEAD`，**未提交、已暂存、未跟踪的改动完全不参与**——改完源码不 commit 就编译，`cw status` 报「最新」，这些改动从此永久失明；删除与改名也认不出。新增 `lib/change-set.js`：`collectChangeSet()` 一次采集四路（`<base>..HEAD` / `--cached HEAD` / 工作区 / `ls-files --others`），识别 `D` 与 `R`，路径规范化成仓库相对 POSIX，`.codewiki/` 自身产物排除在源码变更之外（README/CHANGELOG/CodeWiki.md 仍是合法 source）。基线不可达/非 git 仓库时**明确退回全量并记原因**，不再假装干净。`test-change-set.mjs` 15 条覆盖仅未提交/仅暂存/未跟踪/删除/改名/去重/排除/降级。
- **把没被理解的变化基线化**。旧代码在 `changedFiles` 有内容但**没有任何文章命中** `source_files` 时照样 `meta update`，等于宣布「这些变化已经消化」，下次增量再也不会看它们。新增 `lib/update-planner.js`：`planUpdate()` 纯函数，以文章 `source_files` 为初始 ownership，用当前依赖图做**反向依赖闭包**（接口级变更连带重写使用方文章，函数体实现细节变更不波及依赖方），新文件按最长公共目录归给最匹配的文章、无法归属的源码文件让规划退回全量，未重写页做 stale scan（引用已删/改名组件、内部死链）。每篇 `write`/`keep`/`review` 都带**可机读原因**；关系存版本化 `.codewiki/temp/module-map.json`（老 wiki 从 frontmatter 保守迁移）。纯注释改动仍按 `codeHash` 跳过（0.13.2 行为不变）。`test-update-planner.mjs` 20 条覆盖反向依赖、新文件路由、未映射、缺 source_files、stale scan、文件级降级。顺带修掉一个真问题：`extractCurrentGraph()` 原先只调 `extractRepoGraph()` **从不建依赖边**，增量侧根本没有 `dependsOn`，反向依赖影响不可能生效（只有语义聚类路径建边）；现在两条路径都建。
- **部分失败仍报 `done`**。旧判定只有 `writtenCount === 0` 才算失败，**1 篇成功 + 19 篇失败照样 `done` 并推进基线**。新增终态 `partial`（`JOB_TERMINAL` 与面板/`codewiki_progress` 文案同步），`done` 只表示完整成功。硬不变量：计划内必需文章缺失/失败、有未映射变更、质量闸门拦下文章、存量文章体检不过 → `partial`（附 `blockers` 逐条原因）；`partial`/`failed` **不执行 `meta update`**，下次编译还会重新处理这些变化。每次编译写 `.codewiki/temp/update-record.json`（基线/HEAD、每篇 action+原因、变更统计、未映射变更、质量问题、最终结果），job 只存摘要与记录路径。`test-update-record.mjs` 18 条覆盖终态判定矩阵与记录可序列化。
- **坏文章能入库**。旧闸门只查 frontmatter 开合；重复 frontmatter、空必需章节、指向不存在文件的 `source_files`、坏链接全都能写进 wiki 再被 `cw index` 收进索引（已提交的 `.codewiki/concepts/wiki-generation-flow.md` 就有第二份 frontmatter + 重复正文）。新增 `lib/article-contract.js`：`inspectArticle()` 纯函数，检查 frontmatter 唯一闭合、必填字段、`type` 与目录一致、正文非空、必需章节非空、正文不重复 frontmatter、围栏闭合、`source_files` 真实存在且来自本次读取证据、内部链接目标存在、重复章节/正文块拒绝；按文章类型配置必需章节。接在**所有写盘点**（单轮通道、校对回写、agentic 通道）。agentic 通道另加 write-set 闸门（父文只准写自己那篇、子模块只准写调度器分配路径，越界 `stopReason='write-set'` 且不落盘）。`test-article-contract.mjs` 29 条。
- **文档口径同步**：README 新增「增量与质量保证（0.14.0）」一节，改掉「零子代理」这类与实现不符的整体化表述；`symbolIncremental`/`agenticArticles`/增量判定三处描述补上 0.14.0 行为。

**验证**：新增 4 套测试（`test-change-set` 15 / `test-update-planner` 20 / `test-update-record` 18 / `test-article-contract` 29）全绿；既有 20 套测试全部保持通过（含 `test-orchestration` 编排冒烟、`test-batch` 148、`test-agentic` 55、`test-articles-agentic` 20、`test-incremental*`、`test-graphdiff`）；`node --check` 全部通过。

## 0.13.7 — 2026-10-27

### 修复：锚点测试补「编译基线版」第三基准，消除提交前后的结果跳变

0.13.6 落地两档判据后，`--strict` 在**提交前**是 18 败。但提交完 0.13.6 自己那份 commit 后再跑，同样的文档跳到 **111 败**——同一套代码、同一套文档，只因为多做了一次 `git commit`。

- **根因**：当时只有「工作区 ∪ HEAD」两个基准。提交前，工作区是新源码、HEAD 是文档写成时的旧源码，两者并集正好覆盖；提交后 HEAD 立刻**变成**新源码，旧源码从两个基准里同时消失，所有写在旧版行号上的锚点（22 处 `index.js:1374`、16 处 `index.js:1390` 一类）全部无处安放。败因清一色是「指向空行（区间内也无代码）」——不是文档错，而是那一带的行号在新源码里已经挪走了。
- **修法**：补第三个基准**编译基线版**，取 `.codewiki/_meta.yaml` 里 `last_compiled_commit` 指的那版源码（`git show <commit>:<path>`）。判据变成「编译基线 ∪ 工作区 ∪ HEAD 任一能解释即通过」。语义上它才是最正的那个——文档本来就写在它上面；前两个是为了兜住「改完代码还没提交」的窗口。
- **验证**：补完后 4897 过 / 0 败 / 133 待重编译，`--strict` 回到 18 败，与提交前完全一致。反向验证：把 `last_compiled_commit` 临时改成 `0000000…`（不存在的 commit）→ `--strict` 立刻从 18 跳回 111；还原后回到 18。证明第三个基准确实在起作用，不是碰巧。
- 顺带把测试里残留的「工作区与 HEAD 双基准」表述改成三基准，日志首行会分别打印三个基准的行数（工作区 4413 / HEAD 4412 / 编译基线 4132）。

## 0.13.6 — 2026-10-27

### 修复：锚点测试从「一律硬断言」改为「新鲜度感知两档」，并把修正器与校验器的判据对齐

背景：0.13.5 把 `test-wiki-anchors` 修到 0 败（10356 处全过），但那是把检查范围限定在 `index.js`/`client.js` 两个文件时达成的。本轮把检查范围扩到**全仓所有被引用的文件**（`test-*.mjs`、`lib/*.js`、`CHANGELOG.md`、`README.md`、`vendor/` 等），立刻暴露 263 处失败。逐条查下来，**绝大多数不是文档错**，而是测试自身的基准选错了。

- **锚点测试的基准错位（本轮最重要的一条）**。测试拿**工作区**的源文件当基准判断「锚点的行号里是否含该符号」，但 `.codewiki/` 的编译基线是上一次 `codewiki_generate` 时的源码。两者一旦不同（本分支有大量未提交改动，`index.js` 净增约 40 行），所有锚点整体漂移，测试就把它们全判成「符号未绑定」。实测：同一批锚点，用 `git show HEAD:<file>` 当基准时 4961 过 / 51 败，用工作区当基准时 4864 过 / 166 败——**115 处是纯粹的假失败**。修法：`test-wiki-anchors.mjs` 分两档判据。

  - **结构事实永远硬断言**：行号越界、区间起止倒序、区间终点超出文件行数——这些与源码变不变无关，是真错。
  - **符号绑定按新鲜度分档**：源文件自编译基线（`.codewiki/_meta.yaml` 的 `last_compiled_commit`）以来**没变** → 硬断言（文档必须与源码对齐）；**变了** → 记为「待重编译」不计失败，因为文档这时候本来就该滞后，下次 `codewiki_generate` 会让基线前移，同一批检查自动升级为硬断言。`--strict` 可随时按硬断言跑，用于发版前自查。

- **修正器与校验器判据必须同源（这条踩了三次）**。`fixAnchors` 改完的锚点必须能被 `test-wiki-anchors` 认可，否则出现「修正器认为已对、校验器判错」的死循环。本轮把三处判据对齐：

  - **区间锚点**：校验器判「符号出现在区间内任何一行即算对」（`index.js:779` 的 `fixAnchors` 内 span 分支），修正器原先只看首行，于是把校验器认可的正确锚点判成错再拿去重定位（实测 `_patterns.md` 的 `plan` 每轮被记成「符号歧义未改」）。
  - **「已正确」快路径**：旧实现对多锚点行要求「符号在全文有唯一声明行」，而大量符号在文件里被引用多次（`locate` 返回 ambiguous），于是**本来正确的锚点被判错**、再被改成别的行——实测因此引入 35 行真回归（`client.js:489` 与 `client.js:495` 各自正确且指向不同行，修后都变成 495）。改为与单锚点行同一套宽松判定：锚点起始行提到「离它最近、尚未被占用」的符号即认可；防拉平靠 `used` 占用集合 + 就近排序，不靠全局唯一性。
  - **就近绑定的方向约束**：只在**锚点之前**的符号里选。中文行文的锚注写在「符号（锚点）」的括号里，锚点之后的符号属于后文、不可能拥有这个锚点。原先纯按字符距离排，实测 `articleMd（test-orchestration.mjs:33-35）：…用 makeBatchMock 生成…` 这行里，后文的 `makeBatchMock`（距 39）比主符号 `articleMd`（距 40）只近 1 个字符就被选中，锚点被改到 145-147；下一轮文本已变、距离关系翻转，又改回 33-35——无限来回、5 轮不收敛。

- **新增 `changelogSections` / `fixChangelogAnchors`（`index.js:622`、`index.js:632`）**。`CHANGELOG.md` 是**追加式流水账**，每次发版在顶部插入一节，所有指向它的行号必然单向漂移；而它里面没有可声明的符号，`fixAnchors` 的符号分支遇到「行内无反引号符号」直接原样返回，连尝试都不做。这批锚点几乎都写了版本号（`0.13.0（CHANGELOG.md:109）`），版本标题 `## 0.13.0` 是稳定锚。重定位规则：同一版本 V 被引用的所有失效锚点里取最小行号 `Hmin` 当「写作时该节首的估计」，新行号 = 当前节首 `S` + `(n - Hmin)`。**必须保留相对偏移**——若一律改写成节首 S，`CHANGELOG.md:8` 与 `CHANGELOG.md:10` 会双双变成 S（拉平，正是 0.13.5 修过的数据破坏）。两个关键实现细节都写在注释里：`Hmin` 必须**按行内聚合**（跨行取最小会引入假偏移，让历史错锚点算出「节首+258」直接越界）；幂等的关键是基准必须由**该行该版本的全部锚点**（有效 + 失效）决定，只统计失效项会振荡。

- **新增 `repairUnclosedFrontmatter`（`index.js:757`）**。frontmatter 未闭合（闭合 `---` 被写成空行）的文章，`fixAnchors` 的 `/^---\n([\s\S]*?)\n---/` 匹配不上，**整篇锚点一次都不会被校正**，而文章照常落盘、编译照常「成功」——失败完全不可见。实测 `.codewiki/learnings/update-reminder-entry-gap.md` 就这样积了 19 处失效锚点且每轮编译都过。三条判据同时满足才动手（首行是 `---`、紧随其后至少一行无缩进 `key: value` 元数据、元数据块后紧跟空行），正文里的 `---` 分隔线与普通 md 都不受影响。

- **`fixAnchors` 的 `resolveFile` 补仓库根优先**（`index.js:779` 内）。`source_files` 里写的是**模块相对路径**（`modules/test-suite/index.js`），而文章正文引用的是**仓库根**路径（`index.js:941-954`）；两者 basename 相同 → 按 basename 匹配会把根锚点映射到不存在的 `modules/test-suite/index.js` → `loadSource` 返回 `null` → 整行静默跳过。改为仓库根真实存在的同路径优先：文档锚点的语义永远是「仓库里的这个文件」，虚拟映射只是文章元数据。

- **删不掉的孤儿文章必须留痕**（`index.js:261` 的 `pruneOrphanModules`）。旧实现 `catch { /* 删不掉的留给下次 */ }` 是静默吞错，而删不掉的孤儿会一直占着 `modules/` 并被 `cw index` 收录，下次编译仍然「成功」、无从知道有篇死文章还在。改为记进 `job.plan.prunedFailed` 并在编译 note 里报出前 5 个。测试同时补了 `rmSync` 抛错的分支。

- **抽 `validateArticleEnvelope`（`index.js:1005`）**。这段闸门原先只藏在 `writeValidated` 里，只能靠整轮 orchestration 间接覆盖。抽出为导出函数后由 `test-batch.mjs` 直接钉住 14 种边界（正常闭合 / 前置空行 / 只有 frontmatter 无正文 / CRLF / 缺开头 / 空串 / null / 非字符串 / 缺结束 / 结束符不在行首 / 正文含 `---` 分隔线等）。同时修正了闭合判据：结束标记必须**独占一行**（`---(?:\r?\n|$)`）而不是裸 `---`，否则正文里行首的 `---`（分隔线带说明）会被当成 frontmatter 闭合，把真正缺失的结束符放过去。

- **`symbolsWithPos` 排除文件名**（`index.js:779` 内）。`package.json`（`package.json:1-28`）这类写法里反引号包的是文件路径，拿它去源文件里搜必然搜不到，会一直记「符号未绑定」假阳性。

测试：`test-wiki-anchors.mjs` 检查总量从 10356 升到 16042 条（范围扩到全仓），两档判据下默认档 **4895 过 / 0 败 / 135 待重编译**，`--strict` 档 18 败（全部是历史遗留的文档真错，留给下次 `codewiki_generate` 重编译解决）。`test-batch.mjs` 132 → 148 条。`test-prune-orphans.mjs` 9 → 12 条。全量 18 个测试文件回归全绿。

### 说明：为什么不全修那 18 处 strict 失败

它们不是漂移，是**文档本身引用了已删除的符号或写错了位置**（如 `resolveBatchApiKey` 在 0.10.1 就随「插件不碰密钥」一起删了，文档仍在描述它）。这类错的正解是让下一次真实编译重新读源码重写那几段，而不是由修正器按启发式去猜——修正器猜错的代价是「把锚点改成能过校验的值，却与正文描述不符」，那正是 0.13.5 之前几轮手改修到 0 败却掩盖根因的老路。

## 0.13.5 — 2026-10-27

### 修复：孤儿文章清理 + `fixAnchors` 锚点归属（一行多锚点不再被拉平）

背景：`test-wiki-anchors` 报 251~375 处失败，逐条查下来是**两类互相掩盖**的问题——孤儿文章（占了 169 处）与 `fixAnchors` 自身的锚点归属错误。先前几轮手改修到 0 败过，但那是把锚点硬改成「能过校验」的值，掩盖了根因。

- **新增 `pruneOrphanModules(job)`（`index.js:240-282`）**。模块划分随聚类结果变化：上一次编译产出 `modules/plugin-core.md`，下次同样的代码被切成 `core-and-config.md` + `core-application.md`，旧的两篇再没人重写也没人删除，成了「被 `_index.md` 遗漏、内容永久过期」的死文章，还让锚点校验一直拿过期行号去校验已挪位的源码。安全边界写进注释与测试：① 只在全量编译（`kind==='full'` 且 `plan.modules` 完整）时动手——增量编译只重写变化模块，拿它当全集会把「本次没变的模块」全删；② 只删 `.codewiki/modules/*.md`，`concepts/`、`learnings/`、`decisions/`、`_architecture.md` 等横切产物一律不碰；③ 本次 job 写过的（含失败）保留，失败可能是暂时的，不顺手删证据；④ 删除失败只记账不中断。本次实际清掉 5 篇孤儿（`docs-and-meta`、`documentation-and-config`、`plugin-core`、`plugin-runtime`、`project-docs`）。

- **`fixAnchors` 锚点归属改为「就近绑定」（`index.js:625-730`）**。原实现把行内所有反引号符号收集成数组，对同一行的**每个**锚点都用这一整组符号去查唯一出现——一旦命中就把该锚点改成那个符号的位置。后果是一行里并列多个锚点（表格一行多列、一句话串多个符号，实测 `_patterns.md` 单行有 15 个）会被逐个改写成**同一个行号**（拉平），`configuration-management.md:227` 里 5 个不同常量被压成 5 个 `index.js:1572`、`test-log-pairing.md:24` 四处 `createUserMessage` 被压成 4 个 `index.js:15`。修法：`symbolsOnLine` 改为 `symbolsWithPos`，返回每个符号在行内的字符位置；按锚点在行内的位置取**最近**的符号（同距取左侧，符合中文「符号（`file:NNN`）」的行文习惯）再定位，一行多个锚点各自绑定正确的符号。

- **顺带修掉的四个连带缺陷**：`writeValidated` 增加 frontmatter 闭合校验（`---` 缺结束符时不落盘——`documentation-and-config.md` 就是开头多了个空 `---` 对，导致 frontmatter 解析失败、被索引归进 `Unknown` 段）；`fixAnchors` 倒序区间（`9-7`）原会算出负跨度，改为 `Math.abs(end-start)` 并夹到行数内；`test-wiki-anchors.mjs` 的符号绑定判定由「本行 index/client 锚点数 === 1」改为「本行**全部文件**锚点数 === 1」，避免一行串 `test-orchestration.mjs:94` 与 `index.js:114` 时把属于另一个文件的符号强行要求出现在 index.js 区间内；`documentation-and-config.md` 的 `source_files` 去掉 `modules/` 前缀。

测试：新增 `test-prune-orphans.mjs`（9 条：非全量跳过、无清单跳过、删孤儿、保计划内、保已写过、保横切目录、只删 .md、删除失败不中断、返回清单）；`test-batch.mjs` 128 → 132 条（新增倒序区间 `a.js:9-7`→`a.js:5-5`、`a.js:8-2`→`a.js:3-5` 与一行多锚点归属不拉平）；`test-wiki-anchors.mjs` 由 375 败 → **0 败**（10356 处锚点全过）。全量 16 个测试文件回归全绿。

### 说明：本轮锚点修复的方法与教训

第一版修法是「按符号全仓唯一出现定位」，遇到 `plan`/`fail`/`fixAnchors` 这类同名多次的直接跳过（剩 75 处）；第二版改成「行内第一个有唯一声明行的符号」，与校验器判据不一致（校验器取离锚点最近的符号）导致修好的行仍判失败（剩 7 处）。第三版才与校验器严格对齐。中途还试过「按 `git diff` 行号偏移整体换算」的方案，实测反而变差（93→104 败）——行号偏移对所有约定成立，但对「本来该指向哪个符号」无信息量，且会把末尾行算到 `total+1`。教训：**锚点必须按符号语义定位，不能按位置偏移推算**。

## 0.13.4 — 2026-10-27

### 修复：工具层的四个真实翻车点（独立核查 + 逐条实测复核后确认）

背景：0.13.3 修完真实运行暴露的问题后，另派子代理对 agentic 工具层做了只读核查。报告列 6 条，我逐条实测复核，**5 条成立**（第 6 条「子模块重名产生丑陋路径」属设计取舍、未改），并按严重性重排——**封顶静默撒谎比 CRLF 更严重**，因为它产出死链且父任务仍报 `ok:true`，属于无人察觉的静默错误。

- **`str_replace` 在 CRLF 文章里跨行必然失败（`lib/agentic.js`）**。原实现是纯字面 `indexOf`，不做行尾归一化。真实仓库 `core.autocrlf=true`、`.codewiki` 下 36 篇 md 里 28 篇是 CRLF；模型 `view` 看到的是 `7| 第一段正文。\r\n`（`\r` 不可见），它按看到的行写跨行 `old_str` 用 `\n`，永远匹配不上 → 收到「未找到」→ 换锚点再试 → 步数耗尽，文章没写完。这是增量改旧文的主路径，必踩。修法：匹配前把文章与 `old_str` 的行尾统一成 `\n`，命中后按原文风格写回（CRLF 文章仍写回 CRLF，不悄悄把整个文件改成 LF）。`insert` 同样处理。实测真实 CRLF 文章 `batch-tests.md`（118 行）跨行替换：命中、内容已变、行尾仍 CRLF。

- **子模块封顶时静默撒谎，产出死链（`lib/agentic.js` + `lib/articles-agentic.js`）**。封顶逻辑本身正确（`_depth >= subDepth` 时为 `null`，递归时传 `onSubModule: null` 让子层重建判定），但工具层把「不可用」一律回成 `isError:false` + `「已记录子模块 X（本模式下不递归成文）」`。模型据此在父文里写「详见 xxx.md」，**而那个文件从未生成** —— 死链，且父任务仍记 `ok:true`，无人察觉。修法：`buildToolset` 新增 `subModuleBlocked`（`'max-depth'` / `'unsupported'`），两种情况分别返回 `isError:true` 并给出可执行指令（「已到嵌套上限，请在本文里作为普通小节直接写清楚，不要留下指向外部文件的死链」）。`runOneArticle` 逐层透传。

- **`read_code` 只有行数上限、没有字符上限（`lib/agentic.js`）**。`MAX_READ_LINES = 2000` 挡不住压缩产物：实测单行 20 万字符的文件一次返回 200026 字符 ≈ 5.7 万 token（2000 行上限对它完全无效，因为它只有 1 行）。新增 `MAX_READ_CHARS = 40000`（≈11k token），超限截断并提示「请用更小的行范围读，不要整包读压缩产物/打包文件」。

- **`list_files` 列出 `node_modules`/`.git`（`lib/agentic.js`）**。模型看到会当源码探索，白烧步数。新增 `IGNORED_DIRS`（node_modules/.git/dist/build/.next/target/vendor/__pycache__/.venv/venv），过滤后提示「已隐藏 N 个依赖/版本控制目录」。
  - 注：核查报告另称「`list_files` 的 `depth` 参数完全无效」——这条我复核后**判为不准确**：`lib/agentic.js` 确实把 `depth` 传给了 `workspace.listDir(rel, depth)`，但适配层 `lib/agentic-host.js:125` 的签名是 `async listDir(rel)`，多传的实参被忽略。所以现象描述对（`depth=1/2/4` 返回条数相同）、但根因是**适配层不接**而非工具层不传。本次未改递归展开（`list_files` 定位是「看一眼有哪些文件」，深读靠 `read_code`），只修了忽略目录；若后续确有需要，应在 `makeFsWorkspace.listDir` 里实现深度递归。

- **`insert` 负行号被静默吞掉（`lib/agentic.js`）**。原 `Math.max(0, Number(args?.line) || 0)` 把 `-5` 变成 `0`，内容被插到文件最前，模型还以为插到了指定位置。改为负数直接 `isError:true` 并说明「0 表示插到最前，1 表示第 1 行之后」。

测试：`test-agentic.mjs` 48 → 55 条（新增 CRLF 跨行命中、CRLF 行尾保持、LF 不被污染、字符上限、忽略目录、负数行号 6 条；另把旧的「无 onSubModule 时子模块调用不报错」改为「必须报错并说明原因」+ 新增「深度到顶报错」）。全量 17 个测试文件回归全绿（`test-batch` 128、`test-symbols` 24、`test-cluster` 30、`test-agentic-host` 16、`test-articles-agentic` 16 等）。回退验证：四处劣化（去掉行尾归一化 / 关掉字符上限 / 关掉忽略目录 / 关掉负数检查）分别触发对应测试 FAIL，恢复后全过。

## 0.13.3 — 2026-10-27

### 修复：首次真实运行（真模型 + 真落盘）暴露的三个缺陷

背景：此前 0.13.x 的 191 条断言全部由注入的假 `streamFn` 驱动，agentic 写作通道**从未真实跑过一次**（用户追问「测试过写文章吗」后核实）。本轮改用真实宿主 `llm.stream` 跑通，立刻暴露出离线测试结构性看不到的问题。

- **`read_code` 重复读抑制（`lib/agentic.js`）**。真实运行里模型会反复读同一个大文件：一次 45 步的探针中 `read_code` 调用 16 次、其中 12 次是重复读，`index.js` 被读了 13 遍，累计请求上下文 2144KB，步数全耗在读码上，最终 `stopReason='max-steps'` 而文章没写完。根因是模型没有「我读过这个」的记忆，而工具每次都老实回吐全文。修法：`makeReadCodeTool` 增加 `seen` 记账（键为 `path + 起始行 + 结束行`），同一段再读只回一句「你已经在第 N 步读过这段，内容就在你上面的上下文里」。**去重判定必须发生在读盘之前**——初版写在 `readFile` 之后，重复读照样把整份文件读进内存，白省不了 IO（该时序缺陷由新增测试「重复读不应再碰文件系统」捕获，回退验证劣化后 2 条 FAIL）。修后同一探针：重复读 12 → 5 次、上下文 2144 → 1413KB、步数 45 → 17、`stopReason` 由 `max-steps` 变为 `finished`。
  - 步号经 `buildToolset({ getStep })` 由循环内的 `stepRef` 注入，循环每步刷新，模型看到的「第 N 步」是真实步号。

- **`toRequestMessages` 的 MessageId 身份漂移（`lib/agentic-host.js`）**。宿主 d.ts 对 `MessageId` 的要求是 `Stable identity preserved across every representation boundary`（`message.d.ts:126`），而工具循环每轮都拿同一份裸 `messages` 重新过一遍 `toRequestMessages`，每次都 `createUserMessage` / `createAssistantMessage`，同一条消息每步换一个新 UUID。实测同一批裸消息连调两次，`user` 与 `assistant` 的 id 全不同。修法：模块级 `WeakMap` 以裸消息对象为键缓存已构造的正式消息（tool 角色一拆多，键里带 `toolCallId`），对象随循环消息生命周期回收。**首版只缓存了 assistant 分支、漏了 user**，被新增测试「同一批裸消息多次转换，MessageId 保持稳定」直接判 FAIL，补上 user 分支后通过。

- **真实探针的三个配套坑（已一并修掉）**。
  1. `runOneArticle` 落盘读的是 `task.articlePath`，探针先前传 `articleFile` 导致文章不落盘、误判成「跑了但没写」——答案在 `lib/articles-agentic.js:132` 的 `task?.articlePath`。
  2. 工具 JSON 参数被包在 markdown 围栏里时 `parseToolArgs` 原先不剥围栏，已按「原样 → 剥 ```json 围栏 → 截首个括号平衡对象」三级递进处理。
  3. 真实宿主 `llm.stream` 的 `signal` 需透传，否则长请求无法中断。

测试：`test-agentic.mjs` 44 → 48 条（新增 4 条覆盖去重、跨行范围、跨文件、不带 `end_line` 的同段判定），`test-agentic-host.mjs` 15 → 16 条（身份稳定）。全量 17 个测试文件回归：`test-agentic-fallback` 10、`test-agentic-host` 16、`test-agentic` 48、`test-articles-agentic` 16、`test-batch` 128、`test-cluster` 30、`test-cwd-paths` ALL PASS、`test-graphdiff` ALL PASS、`test-incremental-e2e` 8、`test-incremental` 20、`test-orchestration` PASS、`test-semantic-plan` 11、`test-sessions` PASS、`test-symbols` 24、`test-wiki-entry` 全部断言通过、`test-worktree` PASS。

## 0.13.2 — 2026-10-27

### 修复：0.13.0/0.13.1 的审计整改（一条真缺陷 + 一批诚实性与一致性问题）

- 背景：对 `feat/sess-session-absorb-fsoft` 分支做双轴代码审查（Standards + Spec），逐条实测复核后确认 1 条真缺陷、一批文档/一致性偏差。用户裁定「全部修复」。

- **P0 真缺陷：`subDepth` 递归封顶失效（`lib/articles-agentic.js`）**。`dispatchSub` 是**本层**的闭包，深度判定 `_depth >= subDepth` 绑在本层的 `_depth` 上；递归时原样传 `onSubModule: dispatchSub`，子层永远用父层的深度判定 → 封顶永不触发，模型可以无限往下拆。实测：`subDepth=1`/`maxSteps=4` 时模型调用 81 次；`subDepth=2` 直接 `JavaScript heap out of memory`。修法：递归时传 `onSubModule: null`，让子层按自己的 `_depth` 重建 `dispatchSub`（绑定 `_depth + 1`）。补测试：`subDepth=1` 只允许一层、`subDepth=2` 允许两层；回退验证（把 `onSubModule: null` 改回 `dispatchSub`）两条测试均 FAIL。

- **纯注释改动不再触发重写（`lib/graph-diff.js` + `lib/incremental.js`）**。README 与 CHANGELOG 原先宣称「纯注释、空白改动不再触发全文重写」，但 `normalizeBody` 与上游 Python 逐字一致、只做空白归一，所以是文档过度承诺而非移植错。修法：**不动 `diffGraphs`**（与上游逐位对齐、有 78 条 golden 对拍），在判定层加降级——新增 `codeHash(node)` = 剥离注释与空白归一后的 sha1；`stripComments` 支持 `/* */` 块注释与 `//`、`#`、`--`、`;`、`%` 五种行首注释，并新增 `stripTrailingComment` 处理行尾注释；快照新增 `codeHash` 字段；`filterStaleTasks` 里「`bodyHash` 变了但 `codeHash` 没变且 `docstring` 没变」的组件归入 `cosmeticOnly` 不重写，其余变更照旧。返回值新增 `cosmeticOnly: string[]`，`dropped` 条目带 `cosmeticOnlyComponents` 便于解释「为什么这篇没重写」。`opts.ignoreCommentOnly === false` 可关掉该降级回到严格模式。快照缺 `codeHash`（旧快照）时该组件不降级，行为与旧版一致。
  - 行尾注释只认 `//` 与 `#`（`TRAILING_COMMENT_MARKS`），**不认** `--`/`;`/`%`——它们在表达式里出现太多（`a--`、`for(;;)`、`50%2`），按行尾截断会吃掉真代码。行首注释仍认全五种。

- **`lib/symbols.js` 补正则降级（239 行）**。原实现 AST 不可用时 `return []` 静默丢符号，整块语言的模块凭空从模块清单里消失，日志只有「skipped +N」。新增表驱动 `REGEX_RULES`（16 种语言，`fn`/`cls`/`arrow`/`iface`/`params`）+ `regexExtract(relPath, content, lang)`：按行扫、跳过块注释与单行注释、产出与 AST 同形状的符号记录；仅在 AST 路径不可用时启用，命中数记进 `stats.regex` 让调用方看得见降级。测试 24 条（含「WASM 不可用时自动走正则」「WASM 可用时 `stats.regex` 为 0」）。

- **`lib/cluster.js` 下钻真递归（452→467 行）**。`subdivide` 原先只被顶层 `for` 循环调一次、内部不再递归，`maxDepth` 实际只当 `maxDepth > 1` 的布尔开关用——配 3 和配 2 行为完全一样。改为 `subdivide(..., depth, maxDepth, splitThreshold)`：子模块仍 `>= splitThreshold` 且 `depth < maxDepth` 时继续下钻，`stats.levels` 记录真实层数。测试 30 条。

- **agentic 通道接双池（`lib/articles-agentic.js` + `index.js`）**。`runAgenticArticles` 早就有 `bigConcurrency` 双池实现，但生产链路从未传这个参数、也没给任务打 `bigTier` 标记——大档在 agentic 通道事实上不生效。新增导出 `sourceTokensOf(task, cwd)`（与 `index.js` 的 `estimateTokens` 同口径：CJK 按 1、其余按 3.5 字符/token）与 `markBigAgenticTasks(tasks, {bigTier, sizeOf})`（模块源文本量超 `bigTokenBudget` 才打标，`bigProvider` 未配置时原样返回）；`index.js` 的 `startAgenticRun` 传 `bigConcurrency: c.bigConcurrency` 并据此打标。新增导出 `resolveTaskRoute`：任务自带 provider/model 时以任务为准、**不回落**默认档的 `reasoningEffort`（默认档的 effort 可能不被大档模型支持）。

- **`DEFAULT_MAX_STEPS` 统一（`lib/agentic.js` → `lib/articles-agentic.js` 再导出）**。原先 `lib/agentic.js` 内部写 24、`lib/articles-agentic.js` 导出 30，直接调 `runAgenticArticle` 拿 24、走生产链路拿 30，同一配置两种行为。改为唯一定义在 `lib/agentic.js`（= 30，与 `index.js` Config 默认值一致），`articles-agentic.js` 导入并再导出保持既有导入路径可用。

- **`tally` 去重语义收窄（`index.js`）**。0.13.0 把「按名字去重」改成无条件执行（本意是修重跑重复计数），但它顺带改变了校对阶段以外的所有 `tally` 调用语义（属于 scope creep）。收窄为两个独立开关：`replace=true`（校对阶段，同名覆盖）与 `mergeByName=true`（文章/观察/合成的重跑路径）；正常首次 tally 不合并。调用点按语义各自传参。

- **`plan` 不再携带全量源码（`index.js`）**。`semanticPlan` 返回的 `plan.graph.components` 原先把每个组件的 `sourceCode` 一起带上，而 `plan` 会随 job 整体写进 `JOBS_FILE`——本仓 341 个组件约 347KB 纯冗余（判变更只用 `bodyHash`/签名/依赖，源码没有任何消费者）。已移除；`extractCurrentGraph` 的现场图不受影响。

- **`cordis.patch.yml` 补配置示例**：`config: {}` 保留（含义是全部用 Config schema 默认值），补上被注释的完整字段示例（`batchProvider`/`batchModel`/`maxConcurrency`/`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`）并注明「留空即用 schema 默认值」。

- **文档一致性**：README 的工具表把 `edit_article` 误写成 `insert/replace/str_replace/delete`（实际只有 `view`/`str_replace`/`insert` 三种命令）已改正；CHANGELOG 0.13.0 里各模块行数（`symbols.js` 701→884、`cluster.js` 452→467、`agentic.js` 388→401、`articles-agentic.js` 131→292、`graph-diff.js` 497→578、`incremental.js` 169→206）按当前实际核对更新；`client.js` 一处缩进错位已修。

- **清理**：`index.js` 删掉未使用的 `isDiffEmpty`/`serializeDiff`/`changedIds` 导入；`semanticPlan` 的 `extractRepoGraph` 调用去掉未使用的 `rootDir` 参数；`lib/agentic-host.js` 里 `content.map((b) => ... ? b : b)` 这种恒等映射（Middle Man）改为直接传 `content`。

- 测试：`test-symbols` 19→24、`test-cluster` 28→30、`test-articles-agentic` 7→16、`test-incremental` 15→20、`test-semantic-plan` 10→11。全套回归：`test-agentic` 39、`test-agentic-host` 15、`test-agentic-fallback` 10、`test-batch` 128、`test-graphdiff` 全过、`test-incremental-e2e` 8、`test-orchestration` 编排冒烟、`test-cwd-paths`/`test-sessions`/`test-wiki-entry`/`test-worktree` 全过。

- 版本 0.13.1 → 0.13.2（patch：修一条真缺陷 + 诚实性与一致性整改，无新增配置项）。

## 0.13.1 — 2026-10-27

### 修复：`generate_sub_module` 在生产链路上是空转的

- 背景（自查发现）：0.13.0 宣传「`generate_sub_module`（委派子模块成文）」，`lib/agentic.js` 也确实实现了该工具的调度与 `onSubModule` 回调，但 `index.js` 的 `startAgenticRun` 调 `runAgenticArticles` 时**没有传 `onSubModule`**，`lib/articles-agentic.js` 也没把这个参数往下接。结果是模型调这个工具只得到一句「已记录子模块 X（本模式下不递归成文）」——目标里「派子模块」这条能力事实上没生效，是诚实性问题而非优化项。

- **递归派发接线（`lib/articles-agentic.js`）**：`runOneArticle` 现在自带 `dispatchSub`，模型调 `generate_sub_module` 时就地递归跑一次 `runOneArticle` 写子模块文章：
  - 落盘路径 `<wiki>/modules/<父模块>/<子模块>.md`，父文章在 `<wiki>/modules/<父模块>.md`，父子分开写、互不覆盖；
  - `subDepth`（默认 2）封顶递归深度，防止模型无限往下拆；`_depth`/`_takenNames` 为内部递归参数；
  - 子模块**全局重名保护**（上游 issue #76/#113 的教训）：重名先加父模块名前缀重试，仍重则跳过并在工具结果里说明；
  - 子模块失败只记账、不拖垮父文章：工具返回里会告诉模型「把它当普通章节描述」，父文章照常算成功；
  - 返回值新增 `subModules: [{name, path, ok, stopReason}]`，`runAgenticArticles` 汇总进结果并写 job note（「X 派生出 N 个子模块文章：…」），面板可见。
  - `streamFn` 改为可注入（`streamFn` 参数优先，缺省才走宿主 `llm`），这样递归子任务在离线测试里也能用假模型驱动。

- **提示词（`lib/agentic.js`）**：`buildOpeningPrompt` 只在 `generate_sub_module` 真的出现在工具表里时才追加「拆分（可选，只在确实必要时）」一节，并写明滥用代价（拆太碎让读者在文章间跳转）与小模块阈值（<3 个组件自己写完）。工具不存在时不出现这段话，避免模型被提示去调一个不存在的工具。

- **测试（`test-articles-agentic.mjs`，7 条）**：写出文章并落盘、`generate_sub_module` 真的递归写出子文章（断言子文章路径与内容、父文章里的链接）、重名不互相覆盖、`subDepth=0` 时派发被禁用、子模块失败被记账而父文章仍成功、`runAgenticArticles` 汇总 `subModules` 并记 note、单任务抛错不影响其它任务。全部注入假 `streamFn`、走真实临时目录，离线可跑。

- 全套回归：`test-agentic` 39、`test-agentic-host` 15、`test-agentic-fallback` 10、`test-articles-agentic` 7、`test-cluster` 28、`test-symbols` 19、`test-incremental` 15、`test-incremental-e2e` 8、`test-semantic-plan` 10、`test-graphdiff` 全过、`test-batch` 128、`test-orchestration` 编排冒烟、`test-cwd-paths`/`test-sessions`/`test-wiki-entry`/`test-worktree` 全过。

- 版本 0.13.0 → 0.13.1（patch：修一条已宣称但不生效的链路）。

## 0.13.0 — 2026-10-27

### 新增：吸收 FSoft-AI4Code/CodeWiki 的三层能力（AST 聚类 / agentic 写作 / 符号级增量）

- 背景（用户需求）：用户看到 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（ACL 2026，MIT）比底层的 [mraza007/codewiki](https://github.com/mraza007/codewiki) 活跃得多，问能否换掉。核查后的结论是**不该换栈、该吸收**：`mraza007/codewiki` 是 Rust CLI 骨架，提供 `status`/`init`/`index`/`meta update` 这套文件级接口，插件与它 1:1 相符；而它**不含**「模块怎么划分」与「文章怎么写」这两件真正决定 wiki 质量的事——插件原先补的是最省事的两刀（顶层目录分组 + 源码整包内联一次成文）。FSoft 那套恰好就是在这两处做工程化，但它本身没有 `status`/`index`/`meta`，换掉会把插件的三态判定与增量链路一起丢掉，且要引入 Python 运行时（实测装下来 668MB）。用户 2026-10-26 选定「路线三：吸收优势、不换栈」，语言经三方案实测后定为 Node + tree-sitter WASM（不引 Python/Rust 运行时）。

- **符号提取（`lib/symbols.js`，884 行）**：表驱动 `LANG_RULES` 替代上游按语言逐个 `analyzer`（约 800 行/语言）。用 `web-tree-sitter` + `tree-sitter-wasms` 的 36 个 WASM 语法，覆盖 16 种语言（js/ts/py/rs/go/java/c/cpp/c#/rb/php/kotlin/scala/dart/bash/lua），产出 `Map<id, {name, kind, parameters, baseClasses, dependsOn, bodyHash, sourceCode, docstring}>`；`resolveImportEdges` 建跨文件依赖边（相对路径、包名、`__init__.py`、Go module 路径、Rust `crate::` 都有归一）。某语言无 WASM 语法时退回正则级符号提取，不影响其它语言。本仓库自检：135 个组件、0 解析失败。

- **模块划分（`lib/cluster.js`，467 行）**：移植上游 `cluster_modules.py` 的两阶段聚类——先按组件职责聚类，再对超大模块递归下钻（`CLUSTER_MODULE_PROMPT` 分支），最后 super-group 合并。`heuristicCluster` 兜底：**单顶层目录（极常见的 `src/` 布局）时自动下探到第二层**，否则整仓会被塞进一个模块。模型请求失败或没有模型时退回 `localPlan` 顶层目录分组，并在 job note 里写明降级原因。

- **文章写作（`lib/agentic.js` 401 + `lib/agentic-host.js` 101 + `lib/articles-agentic.js` 292）**：上游 `run_module_agent` 的工具循环。工具 `read_code`（带行号前缀、支持行范围）、`list_files`（递归深度）、`edit_article`（view / str_replace / insert，空文章用 insert 从第 0 行搭骨架）、`generate_sub_module`（委派子模块成文）。好处是不再把源码整包塞进 prompt，因此**没有「超预算 → 拆观察批 → 合成」那一整套**，大文件也不会退化成观察批。`agentic-host.js` 负责裸消息 ↔ 宿主 `llm.stream` 的 Message/chunk 协议适配（`makeHostStream`/`makeFsWorkspace`/`toRequestMessages`），`articles-agentic.js` 接 job 生命周期（并发池、落盘、锚点修正）。单篇空文章算失败，不会用空文件覆盖旧文。

- **符号级增量（`lib/graph-diff.js` 578 + `lib/incremental.js` 206）**：逐位移植上游 `updater/graph_diff.py`——组件级 `bodyHash` + 签名比对，区分 `interface` / `added` / `deleted` / `renamed` / `body` / `edge` 六类变更，其中 `renamed` 用「删除+新增近似」配对。`incremental.js` 负责快照存取（`.codewiki/temp/symbol-graph.json`，随 wiki 入库）、文件级 → 组件级折算、按文章 frontmatter 的 `source_files` 过滤出「哪些文章真的要重写」。**收益**：纯注释、空白、格式化、函数体局部改动不再触发全文重写。快照缺失/版本不符/提取失败一律退回文件级 mtime/hash 判定。

- **接入（`index.js`）**：新增 `planMode` / `agenticArticles` / `agenticMaxSteps` / `symbolIncremental` 四个配置，**默认全开**；三者分别设成 `dirs`/`false`/`false` 即恢复 0.12.x 旧行为。`buildPlan` 走 `semanticPlan`（新导出）并由 `extractCurrentGraph` 提供符号图；`tickArticles` 增加 agentic 通道分支，与 `startBatchChatRun` 并列的第二条执行器（结果同样进 `batchResults` 由 `settleJob` 收割），宿主重启后按 `t.tasks[*].agentic === true` 重跑而不再找 `batchPrompt`。

- **补齐退回链路（本次自查发现注释写了、代码没写）**：`index.js` 原注释称「失败率过半且旧通道可用时退回单轮通道重跑一次（见下）」，但「见下」处并不存在该实现。新增导出 `shouldFallBackFromAgentic(results)`（**严格过半**才算系统性失败，恰好一半不退）+ 内部 `shouldFallBackHere`（另守 `job.agenticRetried`，**只退一次**，否则退回后仍失败会每 tick 重新提交成死循环）。退回时**只重排失败篇**，已写成功的文章不再重写（重复写同一路径既费 token，又会覆盖掉 agentic 现场读代码写出的更好版本）。

- **修复 `tally` 的重复计数**：原逻辑只在 `replace=true`（校对阶段）时按名字查旧条目，其它阶段一律 `push`。这对新增的重跑路径是错的——agentic 失败退回单轮重跑、宿主重启整批重跑都会第二次收到同一个 `name`，导致 `writtenCount` 重复累加、`job.articles` 里留两条同名记录（面板显示成两篇）。改为**始终按名字去重**（文章名就是落盘路径，天然唯一）：曾在成功的条目不因后续失败被抹掉，由失败转成功时才把计数从 `failedCount` 挪到 `writtenCount`。

- **依赖落位（`vendor/tree-sitter/`）**：`web-tree-sitter` + `tree-sitter-wasms` 装在插件根的独立 npm 子根，**不装进插件根 `node_modules`**——后者是宿主注入的，在那里 `npm i` 会把宿主包标记 retire 并破坏运行环境（实测）。体积 56MB（对比 Python 方案 668MB）。`node_modules/` 按 `.gitignore` 规则不入库，新机器按需 `cd vendor/tree-sitter && npm i`；没装时插件照常启动，只是没有 AST 能力、三层全部自动降级。

- **设置页（`client.js`）**：新增「编译流程（吸收自 FSoft CodeWiki）」一节，含 `planMode` 下拉（auto/dirs）与 `agenticArticles` / `symbolIncremental` 开关、`agenticMaxSteps` 数字输入（1–100，硬顶 100）；中英 i18n 词条齐备。

- **测试**：新增 6 个测试文件、共 121 条断言——`test-symbols.mjs`（19）、`test-cluster.mjs`（28）、`test-agentic.mjs`（39）、`test-agentic-host.mjs`（15）、`test-agentic-fallback.mjs`（10，覆盖退回判定与可装填性）、`test-semantic-plan.mjs`（10，AST→聚类→模块清单端到端）；另有 `test-graphdiff.mjs`（78 条与 Python 原版**逐位对拍**全过）与 `test-incremental.mjs`（15）+ `test-incremental-e2e.mjs`（8，含真实临时仓库的快照落盘与四类改动场景）。`test-orchestration.mjs` 的配置基线显式钉住 `LEGACY_CHANNEL = { planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`——该文件断言的是旧通道的请求次数与装填时序，不钉住会因「通道换了」而不是「功能坏了」失败；新通道由上面几个文件守护。全套回归：新通道 9 个文件全绿、`test-batch.mjs` 128 条全过、`test-orchestration.mjs` 编排冒烟全过、其余既有测试（cwd-paths / sessions / wiki-entry / worktree）全过。

- 版本 0.12.2 → 0.13.0（minor：新增能力与配置，默认行为改变但可一键回退）。

## 0.12.2 — 2026-10-26

### 新增：编译并发按「大档 / 默认档」分开设置

- 背景（用户需求）：「编译并发的设置，大档和默认档位分开设置」。0.12.1 及以前只有一个 `maxConcurrency`，普通档任务（`batchModel`，免费 hy3）与大档任务（`bigModel`，`volces-ark/glm-5.3-flash`）在**同一个 worker 池**里抢同一个名额：一批请求里只要有 2 个大档任务在飞，默认档就被完全堵住；反过来把并发调大让默认档跑满，又会把付费长上下文的大档一起放出去。两档的额度、单价、上游限流特性本就无关，共用一个数字无法同时满足。

- 分池执行器（`index.js`，`runRealtimeTasks`）：把原来的单一 cursor/worker 组拆成两个**独立池**——`bigTier === true` 的任务进大档池（`bigConcurrency`），其余进默认档池（`concurrency`）；两个池各自维护 cursor 与 worker 数量，用 `Promise.all` 同时推进，互不阻塞。判定只看任务装填时打的 `bigTier` 标记，**不按 provider 猜**——用户完全可能把默认档也配成同一个 provider。`bigConcurrency` 为 `0`/未传时回落到 `concurrency`，与 0.12.1 的单一池行为完全等价（向后兼容）。

- 新配置项（`index.js`）：`bigConcurrency`（默认 `0`），`liveConfig` 里钳到 `1–8`（`CONCURRENCY_HARD_CAP`），`0`/非数字保持 `0` 表示「跟随默认档」。`maxConcurrency` 的描述同步收窄为「默认档并发上限」。

- 补齐两处**漏打 `bigTier` 标记**的大档任务（分池能生效的前提）：横切单批直出（`index.js` 的 `submitBatchFor` 前，原来只设 `t.provider`/`t.model`/`t.reasoningEffort`）与批量校对的 `markBigTask`。漏了标记的后果不只是「没进大档池」——它会以默认档身份占一个默认档名额，同时用大档模型发请求，池子语义与统计全错。`job.tasks` 持久化也补上 `bigTier: true`：宿主重启按 prompt 快照重跑时，否则所有请求都会掉进默认档池。

- 启动日志（`index.js`）：有大档任务时并发文案写全两档（`并发 2 + 大档 3`），大档跟随默认档时显示为 `并发 2 + 大档 2`，不再只报一个数字。

- 设置页（`client.js`）：`maxConcurrency` 标签改为「默认档并发上限」，新增「大档并发上限」数字输入（`min: 0`、`max: 8`、`placeholder: 0`，空输入归一为 `0`）。保存校验对 `bigConcurrency` 单独把关：`0` 是合法语义不报错，负值/小数/超硬顶一律拦下并提示 `invalidConcurrency`。新增 `bigConcurrency` 的中英 i18n 词条（标签 + 说明）。

- 测试（`test-batch.mjs`）：新增「大档与默认档并发分池」段 5 条，用 30ms 延迟的 mock llm 统计在飞峰值——`concurrency=2 / bigConcurrency=1` 下 7 个任务（4 默认 + 3 大档）全部完成、默认档峰值恰为 2、大档峰值恰为 1、总峰值 3（证明两池同时推进）；另一组只给大档任务、不传 `bigConcurrency`，峰值 2（证明「跟随默认档」语义）。`test-batch.mjs` 128 条全过。

- 文档：`README.md` 的并发条目拆成 `maxConcurrency`（默认档）与 `bigConcurrency`（大档）两条并写明「总在飞为两者之和」的代价；`cordis.patch.yml` 顶部配置注释同步拆行。

- 版本 0.12.1 → 0.12.2。

## 未发布 — 2026-10-26

### 文档：hy3 子智能体并发的实测结果与配置根因

- 新增 `docs/hy3-concurrency-handoff.md` 第七章「实测结果」，记录方案 B（给
  `subagent-auto-router.config.allowedModels` 补 `workbuddy/hy3`）生效后
  在同一会话内跑出的 8 路并发数据：**8/8 成功、0 限流**，总墙钟 72.6 s，
  串行估算 361.5 s，**并行加速比 5.0×**；单任务跨度 26.8–62.8 s，
  输入稳定 ~66 k tok，`agent_inspect` 身份行 8 路全为 `provider=workbuddy/hy3`。
  同时修正第一章「选方案 A」的过时前提（B 已实施并在本会话生效）。

- 补充根因说明：后台 `delegate(persist="durable")` 为 continuable 模式，
  **不下发 `structured_output` schema**（该能力只在同步模式或 workflow
  `agent(opts.schema)` 时挂载），因此要求子智能体「必须调 structured_output」
  不可行，回报走 `send_message` 自包含文本即可——属预期行为而非故障。

## 0.12.1 — 2026-10-26

### 修复：worktree / 空壳目录彻底不出现在面板与调度里

- 背景（用户需求）：「全部执行，确保 worktree 目录不会出现在任务列表中」。0.12.0 只拦住了**提交**这条路径，面板仍会显示这些目录的**历史任务**：用户截图里 `Wxxy-CampusLogin` 出现在「总览」两条相邻条目中——一条是真仓库（273 篇，增量已完成），另一条 `Wxxy-CampusLogin/adapter-switch-login-check-20261025`（未编译，排队中·自动）。后者是 worktree 删除后留下的空壳：`git rev-parse` 报 `fatal: not a git repository`（所以 `detectLinkedWorktree` 抓不到），目录里只剩 `.codewiki/_meta.yaml` 一个文件加空的 `node_modules` 骨架，`scanRepoFiles` 返回 `[]`，于是每轮自动调度都提交、每次都在本地规划阶段 fail `仓库没有可编译的源码文件`，在 `%TEMP%/dsh-codewiki-jobs.json` 里攒出了 14 条任务（13 failed + 1 queued）。

- 统一判定 `isDeadCompileTarget(cwd)`（index.js）：`isWorktreeCwd(cwd)` 或［目录存在且 `!hasCompilableSources(cwd)`］。**目录已不存在时不算 dead**——那是「历史任务的目录后来被删了」，历史记录仍有查看价值，不因 `statSync` 失败就抹掉用户数据（移动硬盘/网络盘临时不可访问同理）。面板任务列表、仓库总览、启动清理三处共用这一个判据，避免三套条件各自漂移。

- 三个带缓存的判定（index.js）：`isWorktreeCwd(cwd)`（60s 缓存，包 `detectLinkedWorktree` 返回布尔）、`hasCompilableSources(cwd)`（10min 缓存，`scanRepoFiles(dir).length > 0`）、`clearSourceProbeCache(cwd)`（手动提交前清缓存，刚 clone / 刚 checkout 不被 10 分钟前的空判定挡住）。加缓存的原因：`/api/codewiki/jobs` 是 2s 轮询端点，逐任务 `spawnSync git` 会把宿主事件循环拖住（git 冷启动数十毫秒 × N 任务 × 每 2 秒），大仓库的文件树遍历也不该每分钟重跑。

- 空壳目录闸门（index.js，`svc.submit` 与 `codewiki_generate` 双处）：`auto` 返回 `{skipped:'no-source'}` / `state:'no-source'` 静默跳过，手动抛 `该目录没有可编译的源码文件（空目录或只剩 .codewiki / node_modules 等黑名单目录），不编译：<cwd>`。**闸门放在跑 `cw status` 之前**——空壳目录里的 `_meta.yaml` 往往本身也残缺（主仓库被删后只剩骨架），先让 `cw status` 跑只会抛 `Failed to parse _meta.yaml: missing field project` 这种对用户毫无意义的解析错。

- 启动清理（index.js，`createJobService`）：遍历 jobs，`isDeadCompileTarget` 命中的 cwd 全部历史任务从 `JOBS_FILE` 移除并对每个 `forgetRepo(dir)`（新增导出，从已知仓库登记里摘掉，只改插件自己的 `%TEMP%/dsh-codewiki-repos.json`，不碰用户磁盘目录）。只在启动时跑一次。

- 面板过滤（index.js）：`/api/codewiki/jobs` 的 `list = list.filter((j) => !isDeadCompileTarget(j.cwd))`；`/api/codewiki/repos` 的 `putCwd()` 开头 `if (isDeadCompileTarget(dir)) return`；`autoScan` 里 `detectLinkedWorktree(cwd)` 换成带缓存的 `isWorktreeCwd(cwd)`，其后新增 `if (!hasCompilableSources(cwd)) continue`（不产生 job、不进 `queueAhead` 的「在等谁」名单）。

- 测试：`test-worktree.mjs` 从 8 条扩到 22 条（新增 `isWorktreeCwd` 布尔封装与缓存一致性、`hasCompilableSources` 有源码/只剩 .codewiki/不存在路径、`isDeadCompileTarget` 主工作区/worktree/空壳/目录不存在/空值五态）全过；`test-orchestration.mjs` 新增「空壳目录」段 7 条（提交报错、auto 不提交、jobs 端点过滤掉空壳任务且保留正常任务、仓库总览不含空壳目录）全过，其余 `test-batch`（123）、`test-cwd-paths`、`test-sessions`、`test-wiki-entry` 全过。修正一处测试自身的问题：面板过滤段的「正常任务」cwd 原用 tmp 里的 fixture，会被 0.4.6 的 Temp 残留清理先一步移走，改用仓库自身路径。

- 已知边界：`isDeadCompileTarget` 对**已删除的目录**返回 `false`，所以「目录已被用户删掉」的历史任务仍留在面板（有意为之，见上）；空壳判定依赖 `scanRepoFiles` 的 2000 文件上限与黑名单目录，全部源码都落在 `node_modules` / `.next` / `dist` 这类黑名单里的极端仓库会被误判为空壳——正常仓库不受影响。

- 版本 0.12.0 → 0.12.1。

## 0.12.0 — 2026-10-26

### 新增：全局「会话」Tab + worktree 拒绝编译 + 会话记录定时清理确认

- 背景（用户需求）：①「增加可以查看目前正在进行的会话内容，就像给 codewiki 专门开的会话，保存一天时间只在 codewiki 界面查看。这个好似没有实现」——0.11.0 的记录能力只挂在**每个任务行**的「会话」按钮上，不点进任务就看不到，跨任务也汇总不了；②「不要给 worktree 中的文件编译 code wiki，等它合并到仓库中再统一编译」——隔离工作区与主仓库各编一遍会让产物互相覆盖、提交时机混乱。
- 全局会话 Tab（index.js + client.js）：`listAllSessionRecords({limit, jobIds})` 跨所有任务聚合记录元数据（只读轻量 meta，全文仍按 `(jobId, n)` 单条拉），按 `startedAt` 倒序、limit 兜底 200。`GET /api/codewiki/sessions`（不带 `jobId`）改为全局聚合，并回填每个任务的 `cwd`——面板行里能直接看出「哪个任务 · 哪个仓库」在跟模型说什么；带 `jobId` 时行为不变（向后兼容）。面板顶部新增「会话」Tab，直接渲染 `SessionView job={null}`；该视图与原单任务视图共用组件：`global=!job` 时走聚合接口、行内追加任务短 id 与仓库名、选中项由 `n` 改为 `{jobId, n}` 以支持跨任务拉全文。5s 轮询与 running 闪烁不变，仍保留 24h。
- worktree 闸门（index.js，`detectLinkedWorktree`）：判据只用 git 自己——`git rev-parse --git-dir --git-common-dir` 两者 resolve 后不同即 linked worktree（主工作区两者都是 `.git`；submodule 也相同，不误判；非 git 仓库放行）。三处拦截：`svc.submit`（所有入口的公共汇合点，`auto` 时返回 `{skipped:'worktree', reason}` 不抛错）、`codewiki_generate` 工具（在跑 `cw status` **之前**就拦，报错文案含真实 `gitDir` 并说明「请等合并回主仓库后统一编译」；`auto` 直调时降级为 `state:'worktree'` + note 返回，`wikiPath` 给空串以满足 output schema）、`autoScan`（历史任务里的 worktree 路径静默跳过，不污染 note）。
- 清理确认：`pruneSessionRecords()` 在 `tick()` 内每 10 分钟静默跑一轮（`SESSION_TTL_MS=24h`），过期记录与随之为空的 job 目录一并移除。
- 测试：新建 `test-worktree.mjs`（真实 `git init` + `git worktree add` 造环境，8 条断言：主工作区放行 / linked worktree 命中 / gitDir 指 `.git/worktrees/<name>` / commonDir 指主仓库 `.git` / 不存在路径不误报 / worktree 子目录命中 / 非 git 目录放行 / 空输入放行）全过；`test-sessions.mjs` 加全局聚合段（跨任务聚合、startedAt 排序、每条带 jobId、limit、jobIds 过滤、无匹配为空）全过；`test-orchestration.mjs` 加 worktree 闸门段（worktree 目录提交报错、文案核对、主工作区照常提交到 done、auto 调度扫到 worktree 记 note 不提交）并修正会话单任务断言，全过；`test-batch.mjs` 123/123。
- 版本 0.11.2 → 0.12.0。

## 0.11.2 — 2026-10-25

### 变更：大档思考档位在模型目录未声明时也可手动调节

- 背景（用户需求）：trae/mimo-v2.6-flash 等模型在宿主模型目录中不声明 reasoning efforts（`/api/codewiki/model-efforts` 返回空数组），面板设置页遇到这种情况就把大档「思考程度」锁死为「模型默认」无法调节。
- 面板（client.js）：目录未声明 efforts 时不再渲染死下拉，改为通用档位下拉（模型默认 + off/low/medium/high/xhigh/max，常量 `GENERIC_EFFORTS`），配文案说明「若模型不支持所选值，请求会自动回落模型默认档（不会失败）」——安全性由 0.11.1 的 llmChat 剥档重试兜底保证。已配置但不在通用列表的残留值保留为自定义选项。
- 验证：`node --check client.js` 通过；`test-batch.mjs` 123/123。版本 0.11.1 → 0.11.2。

## 0.11.1 — 2026-10-25

### 修复：大档任务思考档位回落错误导致整批失败（job-mvnxh0am-0 根因之一）

- 现象：codewiki 仓库自编译任务 19 篇全失败。8 个大档请求（trae/mimo-v2.6-flash）全部 `UNSUPPORTED_REASONING_EFFORT: does not support reasoning effort "off"`；其余 11 个是 workbuddy 上游 502（账号池 3 个账号全不可用，外部服务问题）。
- 根因（index.js `runRealtimeTasks`）：`markBig` 给大档任务 `delete t.reasoningEffort`（大档未配 effort → 用模型默认档），但并发池 `reasoningEffort: t.reasoningEffort || reasoningEffort` 把它回落到普通档配置的 `off` 下发——大档模型不支持 off，请求全灭。
- 修复一：任务自带 provider+model（大档任务）时 effort 完全以任务为准（空=模型默认档），不回落普通档配置。
- 修复二（兜底，index.js `llmChat`）：流式 finish 为 error 且 code=`UNSUPPORTED_REASONING_EFFORT` 且本次带了 effort 时，剥掉 effort 用模型默认档重试一次——任何模型/配置组合不再因此整篇失败。
- 测试：test-batch 断言按新语义更新（「大档任务未指定档位时不回落普通档」），123/123 过；`test-orchestration.mjs` 冒烟全过。版本 0.11.0 → 0.11.1。

## 0.11.0 — 2026-10-25

### 新增：编译会话透明化（面板可看 LLM 会话内容，保留 24h）+ 并行项目推进 + 排队可见性

- 背景（用户需求）：①编译任务排队长（实测单任务排队 2h05m：serialProjects 串行闸门 + 当天 32 个任务逐个排队），面板「已用时」把排队计入且看不到「在等谁」，严重误导；②用户要求「增加可以查看目前正在进行的会话内容，就像给 codewiki 专门开的会话，保存一天时间只在 codewiki 界面查看」。
- 并行调度（index.js）：新增配置 `parallelProjects`（z.number().default(2)，1–4）；派生 `parallelLimit`——`serialProjects=true` 时恒 1（行为与旧版完全一致），否则 clamp(round(parallelProjects),1..4)。tick 闸门由单选 activeId 改为 `activeIds` 集合：忙碌项优先入集，再按提交顺序唤醒最早 queued 直到上限；submit 的排队判定改为 `busyOthers.length >= limit`。关闭单项目串行后多仓库同时编译，不再互相排队。
- 排队可见性（index.js）：jobs 端点为每个 queued job 注入 `queueAhead`（正在跑的 + 排在前面 queued 的仓库 basename 数组）与 `queueAheadCount`。
- 会话记录（index.js，新模块）：`SESSIONS_DIR=<tmp>/dsh-codewiki-sessions/<jobId>/`，每请求双文件 `nnn.meta.json`（轻元数据）+ `nnn.full.json`（prompt/output 全文）；`SESSION_TTL_MS=24h`、流式 3s 节流落盘。导出 `listSessionRecords(jobId)` / `readSessionRecord(jobId,n)` / `pruneSessionRecords(now,ttl)` / `SESSIONS_DIR`；私有 `beginSessionRecord(job,task)` 返回 `{onDelta,onDone,onError}`——`onDelta` 尽力从流 chunk 提取增量文本，完成时以全文覆盖。`llmChat` 加可选 `onDelta` 回调（逐 chunk try/catch），`runRealtimeTasks` 加可选 `onRequestStart`，`startBatchChatRun` 接线记录每个请求。tick 每 10 分钟静默 prune 一次。新端点 `GET /api/codewiki/sessions?jobId=`（倒序列表）与 `GET /api/codewiki/sessions/item?jobId=&n=`（全文，404=过期），仅回环可达。
- 面板（client.js）：①任务卡「已用时」拆「排队 X · 执行 Y」（queued 态只显排队，排队时长取 stageTimings.queued ?? 实时差）；②queued 且 queueAhead 非空时渲染「在等：a → b」行；③每张任务卡新增「会话」按钮 → SessionView：列表 5s 轮询（running 项闪烁指示），点击拉单条全文（prompt 折叠 + output 正文）；④设置页新增 `parallelProjects` 数字输入（serialProjects=true 时禁用并提示）。样式追加 sess/queueahead 系列 + `@keyframes dscw-pulse`。
- 测试：新建 `test-sessions.mjs`（列表倒序/全文读取/TTL prune/幂等/空目录移除）全过；`test-orchestration.mjs` 串行段加 queueAhead 断言（实测 `["cw-orch-…"]` ✓）、新增「并行项目上限」段（serialProjects:false + parallelProjects:3，A/B 两仓库同时提交，断言 B 不 queued、双双 done）✓。`test-batch.mjs` 123/123 ✓。
- 版本 0.10.11 → 0.11.0。

## 0.10.11 — 2026-10-25

### 变更：编译收尾新增独立 commit 阶段——产物提交改走「主题分支 → 合并回原分支」

- 背景（用户需求）：0.10.9 的 autoCommit 是在 index 收尾后顺带执行、直接提交到当前分支，不是流程里的显式一步，产物提交也永远长在用户的当前分支上。用户要求「增加流程，最后一步提交分支合并」：把提交升级为阶段机里的独立阶段，并以主题分支合并的方式落库。
- 阶段机（index.js）：`STAGE_HANDLER` 新增 `commit: tickCommit`，阶段顺序变为 queued → articles → crosscut → compose → review → index → commit → done。`tickIndex` 末尾在有产物且开关开启时 `setStage('commit')` 提前返回，不再就地提交；`tickCommit` 执行提交后才置 done/finishedAt 并唤醒会话——终态因此最多晚一个 tick（默认 TICK_MS 10s，测试 300ms），换面板上可见的「提交产物中」一步。中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等。
- 提交方式（index.js `autoCommitWiki` 重写）：先建主题分支 `codewiki/wiki-<jobId>`，在其上 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（pathspec 限定两个路径的老规矩不变），再切回原分支 `git merge --no-edit` 合并（能 ff 则 ff），成功后 `git branch -d` 删主题分支（`-d` 只删已合并分支，绝不强删）。
- 降级与安全：detached HEAD（无「原分支」可回）或建主题分支失败 → 降级为直接提交（`mode:'direct'` + `fallback` 原因，与 0.10.9 行为一致）；进入主题分支后任何失败先切回原分支，绝不把用户留在插件建出的分支上；合并冲突/失败 → `git merge --abort`、保留主题分支，返回 `committed:false` 与说明（产物不丢，等手动合并），绝不强合。0.10.9 的全部前置安全检查（非 git 仓库、无 HEAD、merge/rebase 中、未解决冲突、被 .gitignore 忽略、缺 user.name、无改动 noChanges）原样保留且在分支切换之前执行。
- 面板（client.js）：`ACTIVE_STAGES` 加 `commit`（步骤条显示「提交产物中」/「Committing」），进度权重改为 articles 0.63 / commit 0.02（总和不变）；任务卡自动提交成功行追加主题分支名；`autoCommitHint` 双语说明改为分支合并式语义。
- schema/文案（index.js）：`codewiki_progress` 的 job.autoCommit 输出增加 `mode`/`branch`/`fallback` 字段；`autoCommit` 配置描述与 `codewiki_generate`/`codewiki_update` 工具描述、系统提示 section 同步为「主题分支提交后合并回原分支」。
- 测试（test-orchestration.mjs）：正常提交断言升级（mode==='branch'、主题分支已删除）；新增 detached HEAD 降级直接提交用例、主题分支名被占用降级用例（预占分支不被误删）；端到端补断言「走过独立 commit 阶段（stageTimings 含 commit）」与「mode==='branch'」。合并 add/add 冲突路径（编译期间用户在原分支推进）同步流程内构造不出来，为防御性代码、单测不覆盖（用例内注释说明）。
- 验证：`node test-orchestration.mjs` → `PASS：编排冒烟全部通过`（exit 0；无 ✗，端到端阶段计时含 articles/crosscut/review/index/commit）。
- 版本 0.10.10 → 0.10.11。

## 0.10.10 — 2026-10-24

### 修复：两轴 code-review 的全部发现（自动提交语义、边界与测试竞态）

- 背景：0.10.9 把「编译产物提交」从会话模型收回插件侧后，做了双轴评审（Standards：是否守本仓成文约定；Spec：是否忠实实现「会话模型不必等编译、产物由插件自己提交」）。评审发现三类问题：①三态语义漏了「产物无改动」——插件其实没失败，却被唤醒通道和系统提示各催一次提交；②文档/注释与代码不一致（`git add -A` 与「只 add 两个路径、绝不 -A」的自述矛盾）；③测试存在两处竞态，其中一处是历史遗留的 tmp 文件污染。
- 修复一（index.js `autoCommitState`，新增导出）：`committed` / `no-changes` / `pending` 三态的唯一判定。`wakeCompileSession`（实时 steer）与 `commitHintText`（系统提示 section）原先各写一遍判断，只看 `committed===true`，于是 `noChanges` 被当成失败：会话被唤醒一次、系统提示再注入一次「产物待提交」，让会话模型去提交一个不存在的东西——正是本次要消灭的「无谓等待/无谓动作」。现在两条通道共用同一函数，`no-changes` 一律静默；旧 job（无 `autoCommit` 字段）仍按 `pending`，与升级前行为一致。
- 修复二（index.js `autoCommitWiki`）：`git add -A -- .codewiki CodeWiki.md` 改为 `git add -- .codewiki CodeWiki.md`。`-A` 与 pathspec 同用时行为虽等价，但与本函数注释、README、CHANGELOG 反复强调的「只 add 这两个路径，绝不 `-A`」直接冲突——读代码的人会以为哪儿写错了，或以为将来去掉 pathspec 也安全。改动由 `WIKI_PATHS`（index.js:36）唯一定义，`git log`/`check-ignore`/`add` 三处共用。
- 修复三（错误上报）：`autoCommit` 被拒时不再只写 `committed:false`——`git add`/`git commit` 自身失败（含 `index.lock` 被并发 git 占用的常见情形）现在返回具体 stderr 摘录进 `reason`，降级提醒里能看到真实原因，而不是笼统的「产物尚未提交」。
- 修复四（client.js 面板）：任务卡显示自动提交三态——成功显示短 sha、`noChanges` 显示「产物无改动，未提交」、失败显示「产物未自动提交（原因）」。此前 `autoCommit` 只进 `jobSummary` 不进 UI，用户在面板上看不到插件到底提交了没有。
- 修复五（测试竞态 A，`test-orchestration.mjs` 并发提交块）：旧块用「模型通道失败」当 mock，任务在几百毫秒内进入 failed 终态，`Promise.all` 的第二次 `execute` 走到 `submit` 时已经查不到活动任务，于是新建第二个 job，偶发报「并发提交共享同一 job」失败——与占位逻辑无关，纯测试竞态（复现率约 1/4）。改为 `makeBatchMock({ stall: true })`：任务挂起在 articles 不自行终态，并在前后各用 `/api/codewiki/control` 取消收尾。连跑 5 次全部通过（改前 4 次里失败 1 次）。
- 修复六（测试竞态 B，tmp 文件污染）：测试的 jobs 文件只按 pid 命名（`dsh-codewiki-jobs-test-<pid>.json`），Windows pid 复用后会把历史运行留下的同名文件原样读入，其中的 `job-tmp-active`（`cw-orch-alive`，articles 阶段）被单项目串行逻辑判为「已有项目在编译」，后续所有提交变成 `queued`，表现为「偶发 20 项失败」（实测复现过）。现在文件名追加随机 token，收尾删除本文件；tmp 下 74 个历史残留文件即为证据。
- 测试补充：`autoCommitState` 三态单测（含 `committed` 优先于 `noChanges`、空 job 不抛）、`wakeCompileSession` 在 `noChanges` 时零唤醒、`commitHintText` 在 `committed`/`noChanges` 时静默、`pending` 时提醒且带失败原因。
- 文档：README/CodeWiki.md 同步三态语义、pathspec 表述与失败原因上报。
- 验证：`node test-orchestration.mjs` 连跑 5 次全通过（0 失败）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths.mjs` / `test-wiki-entry.mjs` 全部通过；`test-wiki-anchors.mjs` 6918 过 / 335 败（失败全为 wiki 文章里的历史行号漂移，且本次代码改动导致行号整体下移，由随后的 codewiki 编译与 `fixAnchors` 校正）。
- 版本 0.10.9 → 0.10.10。

## 0.10.9 — 2026-10-24

### 修复：编译产物由插件自己提交，会话模型不再等待编译完成（设计缺陷根治）

- 背景（用户报障）：`codewiki_generate` 提交后，会话模型习惯性地「等编译完成 → 自己跑 git 提交」，而编译是宿主后台任务、动辄几分钟——会话模型就在那儿空转/轮询，一轮对话被编译拖住。根因不是文案不够清楚，而是**提交这件事被外包给了会话模型**：产物落盘在后台，提交却要前台做，前台自然要等后台。
- 修法一（index.js 新增 `autoCommitWiki`）：编译终态（done 且有文章写成功）由插件自己 `git add .codewiki CodeWiki.md` + `git commit --no-verify -m "docs(wiki): … <jobId> <N> 篇"`。责任从会话模型收回到插件侧，会话调用完工具就可以继续干活，编译完成后没有任何一步需要它参与。结果写入 `job.autoCommit`（`committed/sha/message/noChanges/reason`），面板与 `codewiki_progress` 直接显示。
- 修法二（安全边界，任一不满足即**拒绝并降级**、绝不做半个提交）：非 git 仓库、无 HEAD、`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 存在（不把 wiki 夹进别人的合并提交）、`git ls-files -u` 有未解决冲突、`.codewiki/` 或未 tracked 的 `CodeWiki.md` 被 `git check-ignore` 忽略（否则 `git add` 会静默什么都不做、误报「无改动」丢产物）、缺 `user.name`/`user.email`、add/commit 失败。只 add 这两个路径（绝不 `-A`）、不 amend/push/改写历史、不跑仓库钩子、不触碰工作区其它改动。
- 修法三（`wakeCompileSession`）：旧行为编译 done 也 steer 会话、要求会话模型提交，这正是「会话模型停下来等编译」的机械根源。现在 `autoCommit.committed === true` 时**直接 return，完全不打扰会话**；只有 failed、或成功但自动提交被拒时才 steer 一次，且文案改为「请处理失败原因」而非「请提交」。面板/自动调度提交与冷会话仍静默跳过。
- 修法四（工具返回文案 `codewiki_generate`/`codewiki_update` 与系统提示 section）：把「调用后继续下一项、提交由插件自动完成」写进工具返回值顶层 `notes` 与 description，明确「**本步不必等待编译、不必调用 `codewiki_progress` 轮询、不必自己 git 提交**」；`commitHintText` 从「请提交改动」改为只在自动提交失败时出现的「产物待提交（附原因）」，并写明不要为此中断任务。
- 设置项：新增 `autoCommit`（默认 true）。关掉即退回旧行为（插件只提醒、由会话模型提交）。
- 面板（client.js）：编译设置节加「产物自动提交」开关与说明；任务详情显示自动提交结果（成功显示短 sha，失败显示原因）。
- 测试（test-orchestration.mjs）：新增自动提交断言组——正常提交（只含两个路径、信息前缀 `docs(wiki):`）、无改动 `noChanges` 不空提交、非 git 仓库/合并中/冲突/被 ignore/缺身份各拒绝分支、`autoCommit=false` 不提交、唤醒在自动提交成功时不 steer。
- 文档：README/CodeWiki.md 同步自动提交边界与会话侧新姿势。
- 验证：`node test-orchestration.mjs` 全部通过；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths.mjs` / `test-wiki-anchors.mjs` 全部通过。
- 版本 0.10.8 → 0.10.9。

## 0.10.8 — 2026-10-24

### 变更：编译流水线全面适配 hy3 192k 上下文——放弃 32k 时代定制的拆批策略，改「大档单请求优先」

- 背景：110k/128k 分块与「观察→合成」拆批是 32k 上下文 qwen3.7flash 时代的遗产。hy3 192k + 大档 420k（volces-ark/glm-5.3-flash 512k）装得下绝大多数模块，为比价而拆批纯属浪费请求与轮次。用户拍板：①观察→合成链保留，但仅超 420k（大档预算）才启用；②会话通道保留不动；③校对改批量。
- 写文章（index.js `prepareArticleTasks` 重写）：装填直接按大档预算（未配大档=128k 硬上限）整模块单请求——110k–420k 区间输入升大档一次写完；仅当模块源码总量超 420k（或有单文件在装填中被跳过）才按 110k 逐文件拆观察批（原「110k 即拆」与 batches.length===1 特例删除）；单文件连大档都装不下的整任务转会话通道（唯一兜底）。
- 横切（`tickCrosscut`）：总量 ≤ 大档预算即单批直出（超 110k 时任务标大档模型，note「（大档装填）」）；超 420k 才走原有观察拆分 → compose 合成。
- 批量校对（`tickReview` 重写 + 新增 `batchProofreadBatchPrompt`/`settleProofread`）：逐篇准备（文章 + 按「预算−文章 token」装填源码，110k 装不下升大档重装）后按 110k 贪心合并成批量校对请求，请求数从 ≈文章数降到 ≈总输入/110k；模型输出按 `@@@article: 名`/`@@@end` 标记分节拆回逐篇，`writeValidated` 校验通过才覆写，缺席/非法文章保留原文（校对失败不推翻已写成功的文章）；单篇源码连大档都装不下转会话通道兜底；`submitBatchFor` 持久化快照补记 `proofreadItems`（宿主重启重跑与 settle 拆回都依赖）。
- 修复（评审遗留）：① client.js `lastTimedStage` 过滤 `ACTIVE_STAGES`——旧任务残留 `stageTimings.plan` 键不再导致失败/取消时步骤条全熄不标红；② `localPlan` slugify 保留 CJK（`\p{Script=Han}`），多个中文顶层目录不再合并成单模块 'module'；③ `bigTokenBudget` 设置描述同步新语义。
- 文档：README/CodeWiki.md 同步五环节阶段机、大档 420k 语义、批量校对、repos 缓存签名失效（补 0.10.7 遗留的文档失同步）。
- 测试（test-orchestration.mjs / test-batch.mjs）：mock 审校员支持批量标记格式；分割 fixture 改 15×100KB/模块（合计 ≈439k>420k 才触发拆分，256KB 扫描上限内）；test-batch 断言按新装填语义校准。
- 验证：`node test-orchestration.mjs` 全部通过；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` / `test-wiki-anchors`（断言部分）全部通过。
- 版本 0.10.7 → 0.10.8。

## 0.10.7 — 2026-10-24

### 变更：删除编译流水线规划（plan）阶段——提交后直接进 articles

- 背景：单独的规划阶段为模块划分花一次独立模型请求（勘探员批：扫源码→应答模块清单 JSON）。现在编译模型上下文足够大，模块划分不值得一次独立请求；且规划应答非 JSON 时还要走降级路径。
- 修法（index.js）：① 删 `tickPlan`（规划阶段处理）、`batchPlannerPrompt`（「你是代码结构勘探员」勘探员批 prompt）、`parsePlan`（规划 JSON 收割）三段；② `STAGE_HANDLER` 去 plan 行，queued 唤醒恒进 articles，提交（submit）恒 `setStage('articles')`；③ `tickArticles` 组装分支：full 编译无 `job.plan` 时就地 `localPlan(scanRepoFiles(cwd))`（按顶层目录分组，原降级路径升为唯一规划路径），notes 记「规划：N 个模块（本地顶层目录分组，规划阶段已移除）」；④ 兼容旧磁盘任务：stage='plan' 的存量任务（宿主升级瞬间恢复）清掉规划批次引用与旧勘探员任务清单，迁移到 articles 按 localPlan 重建，notes 记「旧版规划阶段任务迁移到 articles」；⑤ 横切阶段对 concepts 空数组已兼容（只产 `_architecture`/`_patterns`）。
- 面板（client.js）：阶段条去 plan（`ACTIVE_STAGES`/`STAGE_WEIGHTS`——plan 的 0.05 权重并入 articles 得 0.65，总进度分母不变）、删 stagePlan/stepPlan 中英文标签、编译设置文案去「规划」。
- 测试（test-orchestration.mjs）：规划块重写为本地规划断言（零勘探员请求、localPlan 入库、concepts 空、notes 记录），删「规划应答非 JSON 降级」场景；fixture 仓库从单层 `src/` 改为顶层 `core/`、`util/` 两目录（localPlan 顶层目录分组直接决定模块名）；恢复块场景 B 改为旧 plan 快照迁移断言（勘探员快照作废、迁移后按 localPlan 重建）；横切/串行/面板各块的 plan 阶段断言改 articles；`writtenCount` 基线 5→4（无概念文章）、stale 精确更新 3→2 篇。
- 验证：`node test-orchestration.mjs` 188 通过 / 0 失败（含本地规划、旧任务迁移、分割、串行、面板、schema 校验全块）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` 全部通过。
- 版本 0.10.6 → 0.10.7。

## 0.10.6 — 2026-10-24

### 修复：面板藏掉占串行闸门的工作区外编译任务（「到底哪个在编译」盲区）

- 症状：面板上多个任务排队（note「已有项目在编译（perf-dock-glass-primitives-20261024）」），但面板历史里找不到这个正在编译的项目——用户看不到谁占着串行闸门、也无法从面板取消它。实际占用者是 `E:\...\worktrae\Wxxy-CampusLogin\perf-dock-glass-primitives-20261024` 的 worktree 编译任务（jobs 磁盘状态 30 条，面板 API 只回 29 条，缺的正是它）。
- 根因：`/api/codewiki/jobs` 与 `/api/codewiki/repos` 的 workspaceOnly 过滤（默认开）把 cwd 不在宿主工作区清单里的任务一概藏掉——worktree 目录天然不在清单内。编译服务（tick 闸门）用完整任务表不受此过滤，于是出现「面板不可见的项目占住闸门、其余项目全部排队」的盲区。
- 修法（index.js）：① jobs 端点过滤改为 `!JOB_TERMINAL.has(j.stage) || isExcluded(j.cwd, wsPaths)`——**非终态（queued/编译中）任务始终显示**，只有终态任务按工作区过滤降噪；② repos 总览的 `putCwd` 同样放行非终态任务的工作区；③ repos 30s 缓存签名加入当前非终态任务的工作区路径——编译中仓库进出总览立即反映，不吃陈旧缓存。
- 验证：`node test-orchestration.mjs` 编排冒烟全部通过（0.4.9 块新增断言：stall 占住的工作区外 full 编译任务在 jobs 端点与 repos 总览均可见、取消终态后恢复被过滤）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` 全部通过。
- 版本 0.10.5 → 0.10.6。

## 0.10.5 — 2026-10-24

### 修复：codewiki_progress 工具输出校验失败（progress 为 null 时整个调用报错）

- 症状：调用 `codewiki_progress` 报 `tool "codewiki_progress" returned invalid output: "value.jobs[27].progress" must be a number`，进度查询完全不可用；任务列表里只要有一个无 taskList 的任务（如「已是最新、无需编译」的任务 `taskList: 0`）就必现。
- 根因：`progressView`（index.js:2380）在任务无 taskList 时输出 `progress: null`（render 分支 `j.progress === null ? '' : …` 证明 null 是设计内取值），但输出 schema 把 `progress` 声明为 `{ type: 'number' }` 不允许 null，宿主对工具输出做 schema 校验时整个结果被拒。同 schema 里 `tps`/`error`/`finishedAt`/`batchProgress` 四个可空字段都写了 `oneOf: [type, null]`，唯独 `progress` 漏了。
- 修法（index.js）：`progress` schema 改为 `oneOf: [{ type: 'number' }, { type: 'null' }]`，与其他可空字段写法一致。
- 验证：`node test-orchestration.mjs` 编排冒烟全部通过（其断言本就覆盖 `progress === null` 合法取值）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` 全部通过。`test-wiki-anchors` 27 处锚点漂移为既有状态（文章行号基线未跟上源码），与本次一行替换（不增删行）无关，由 0.10.5 增量编译修正。
- 附注：编译任务本身的会话通道报错「超批量预算需走会话通道，但发起会话不可用」为 0.9.0 设计内降级（面板/自动调度提交无发起会话，无法派子智能体），从会话内重新提交即可，非本次修复范围。
- 注意：插件以 `file://` 挂载，改源码后宿主不热重载，需重启 DeepSeek Harness 生效。
- 版本 0.10.4 → 0.10.5。

## 0.10.4 — 2026-10-23

### 修复：设置页「思考程度」永远读不到档位（调错了宿主方法名）

- 症状：插件页「编译模型 → 思考程度」一直显示「读取思考档位失败（llm 服务未注入或缺少 resolveModel，无法读取思考档位）」，下拉无法选择任何档位。运行中宿主实测复现：`GET /api/codewiki/model-efforts?provider=workbuddy&model=hy3` 返回该错误串。
- 根因：`resolveModelEfforts` 调 `llm.resolveModel(provider, model)`。但宿主提供的 `LlmService` 暴露的方法是 **`resolveModelInfo(provider, model, signal)`**；`resolveModel` 只存在于 adapter 注册表接口（`LlmAdapterRegistry`，`packages/llm/llm/lib/types/index.d.ts:180` vs `:377`）。插件持有的是 `LlmService`，所以这次调用恒失败——配置链路本身没问题，是方法名写错。
- 修法（index.js）：新增 `resolveModelInfoOf(llm)`，优先 `resolveModelInfo`、缺失时回落 `resolveModel`（兼容旧宿主与测试桩）；错误文案同步改为「缺少 resolveModelInfo」。返回结构保持 `{ok, provider, model, efforts, defaultEffort, context}` 不变，设置页无需改动。
- 验证：假 llm（只实现 `resolveModelInfo`）→ 正确读出 hy3 的 `off/low/high` + `defaultEffort: high`；未知路由 → `ok:false` 不崩；`llm=null` → 明确提示未注入；旧 adapter 形态仍可用。

### 新增：大档模型（超长输入不再交会话模型）

- 需求：超过 128k 的内容也不再交给发起会话的主模型/子智能体，插件内自己跑完。
- 新配置四项：`bigProvider`（默认 `volces-ark` 火山方舟）、`bigModel`（默认 `glm-5.3-flash`，512k 上下文、maxTokens 128000、思考档 low/high/max）、`bigReasoningEffort`（默认空 = 模型默认 high）、`bigTokenBudget`（默认 420000，下限被 `BATCH_TOKEN_BUDGET` 110k 兜住）。
- 分派（index.js `prepareArticleTasks`）：新增 `bigProvider/bigModel/bigReasoningEffort/bigBudget` 参数。普通档装不下（单文件超 110k、或整条 prompt 超预算）时，先按大档预算重新装填；装得下就把任务标 `bigTier` 并带上自己的 `provider/model/reasoningEffort` 进 prepared，在插件内一次写完。**只有大档也装不下，才落到会话通道**；`bigProvider` 留空 = 关闭大档，退回 0.10.3 的旧行为（超 128k 走会话通道）。
- 执行（`runRealtimeTasks`）：改成按每个任务自带的 `provider/model/reasoningEffort` 分派，缺省回落参数里的普通档——同一并发池里可以混合两档模型，并发仍受 `maxConcurrency`（2）约束。
- 持久化（`submitBatchFor`）：`bigTier` 任务的 `provider/model/reasoningEffort` 一并写进 `job.tasks`，宿主重启接管后按同档重派，不会掉回装不下的普通档。阶段 note 会显示 `普通档 + 大档（N 个）`。
- 设置页（client.js）：抽出 `modelTrio({pKey,mKey,eKey,state,...})` 复用「提供商/模型/思考程度」三行渲染与目录联动（换提供商清空模型与旧档位），普通档与大档共用；新增「大档模型（超长输入）」分区与「大档输入预算」输入框。`bigProvider` 留空时下拉首项为「（未启用大档）」。中英词条 18 个新 key 全部齐备。

### 测试

- test-batch.mjs 新增两块共 14 项：大档接管（800KB/≈234k token 单文件不再进 `sessionTasks`、带 `bigTier` 与自身 provider/model/档位）、大档关闭退回会话通道、普通任务不被误标；以及混合池分派（大档任务覆盖 provider/model、未指定档位回落参数档位）。
- 结果：`node test-batch.mjs` **123 通过 / 0 失败**；`node test-orchestration.mjs` **编排冒烟全部通过**；`node --check index.js` / `client.js` 均 OK。

### 注意

- 插件以 `file://` 路径挂载（`~/.dsh/profiles/desktop/cordis.patch.yml`），改源码后**宿主不会热重载**，需重启 DeepSeek Harness 才生效。
- 版本 0.10.3 → 0.10.4。

## 0.10.3 — 2026-10-23

### 修复：单文件 110k–128k 的文章被误判「装不下」而白送会话通道

- 背景：0.10.0 把 `BATCH_TOKEN_BUDGET` 提到 110k、0.10.2 把 `BATCH_TOKEN_HARD_LIMIT` 收到 128k 后，实际编译一次 stale 更新时**15–16 篇全部转会话通道**，与「全流程回插件内、会话通道只在超 128k 时兜底」的设计相反。实测复现：这些文章的单文件装填本身只有 44k–108k token，远在 128k 大档之内。
- 根因（`index.js:562` 附近的古老分支）：`prepareArticleTasks` 在「总量超 110k」后按文件切批，随后只有 `batches.length > 1` 才走观察批分割，`batches.length === 1`（单文件占满全部体积、分不出多批）直接落到函数末尾的 `forceSession = true`。而 `batches.length === 1` 恰恰是「一个源文件在 110k–128k 之间」的常见情形——不是装不下，只是超过主预算。
- 修法（index.js）：在观察批分支前插入「大档单请求」出口——`!hasOversizeSingle && batches.length === 1` 时，用 `BATCH_TOKEN_HARD_LIMIT` 装填重建整条 prompt，`estimateTokens(bigPrompt) <= BATCH_TOKEN_HARD_LIMIT` 就作为普通 prepared 任务在插件内一次写完（清掉 `splitFor`/`composePlan` 残留、照常分配 customId）；只有整条 prompt 仍超 128k 才继续落到 `forceSession`。这样「超 110k」不再等于「转会话通道」，判定口径统一为「装不进 128k 大档才是装不下」。
- 效果（本仓库 15 篇 Stale 文章实测）：修复前 15 篇全部 `sessionTasks`，修复后 `prepared=21（含 7 个观察批）、sessionTasks=0`——一次 stale 更新零子智能体。
- 测试（test-batch.mjs）：原「单文件超 110k 且分不出多批 → 会话通道」断言按新语义改写为「→ 插件内大档单请求」，并新增「不拆观察批」断言；`huge.ts`（800KB）那条保留，措辞改为「连 128k 大档都装不下 → 会话通道（唯一兜底）」。109 项全过。
- 版本 0.10.2 → 0.10.3。

## 0.10.2 — 2026-10-23

### 修复：大档装填上限 150k 越界（150k 输入 + 64k 输出 > hy3 的 192k 窗口）

- 背景（用户确认的取舍）：192k 是 hy3 的**输入+输出共享**窗口（`cordis.patch.yml` 里 `hy3` 声明 `contextWindow: 192000` / `maxTokens: 64000`），而 0.10.0 把 `BATCH_TOKEN_HARD_LIMIT` 设成 150000，最坏情况 150k 输入 + 64k 输出 = 214k 已超出窗口，上游会直接拒答。用户选择「维持 110k 主预算，只修硬上限」——不扩大单请求容量，只把越界那档收进合法区间。
- 实现（index.js）：`BATCH_TOKEN_HARD_LIMIT` 150000 → **128000**（192000 − 64000，输入侧可用的真实上限），注释写明推导过程与旧值越界的事实。`BATCH_TOKEN_BUDGET` 维持 110000 不动。
- 语义澄清（同批注释）：该常量现在只作**会话通道任务 prompt 的装填上限**（`prepareArticleTasks` 里单文件超观察预算后按大档重装、`compose` 阶段按 `HARD_LIMIT - articleTokens` 装源文件）；`index.js:964` 的兜底通道说明由「单文件 ≤150k」改为「≤128k」。
- 文案（client.js 中英双份）：`sessionTierHint` 的「连 150k 都装不下」→「连 128k 都装不下」。
- 文档：README 的 `sessionTier` 段、`CodeWiki.md` 架构图的超预算说明同步为 128k。
- 测试：test-batch.mjs 三处断言与措辞对齐新档位——「单文件超 28k 预算」（早已过时的旧数字）改为「超 110k 预算」，「200k 大档」改为「128k 大档」；新增一条 `estimateTokens(hugePrep.sessionTasks[0].batchPrompt) > 128000`，锁住「连大档都装不下时仍按原始全长装填、交会话模型处理」这一行为。108 项全过，编排冒烟全过。
- 版本 0.10.1 → 0.10.2。

## 0.10.1 — 2026-10-23

### 变更：删除内置百炼直连通道，插件只走模型设置里的编译模型

- 背景（用户需求）："删除批量通道，全面放弃批量通道，全部改用模型配置中的数据"（经确认，范围为内置百炼直连通道 `bailianChat`）。0.10.0 之后仍保留一条"provider 留空即回落到插件自带百炼兼容通道"的老路，凭证靠 `batchApiKey` 或模型设置「阿里百炼云」渠道注入——这条路径与本插件"不改动密钥、配置全在模型设置里"的定位冲突，且默认模型早已是 `workbuddy/hy3`，实际无消费者。
- 实现 ①（index.js 删除直连）：移除 `bailianChat()`（原 index.js:295-313）与 `BAILIAN_BASE` 常量；`llmChat` 头注释改为「唯一通道」。`runRealtimeTasks` 签名去掉 `apiKey`/`thinkingBudget`，改为 `(tasks, { model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider })`，内部固定 `chat = (args) => llmChat({ ...args, llm, provider, reasoningEffort })`。
- 实现 ②（index.js 删除凭证解析链）：删除 `hostCtxRef`、导出函数 `resolveBatchApiKey`（原 index.js:524-552，含 credentials 注入与 3s Promise.race）、内部 `apiKeyOf(job)`；`apply()` 里 `hostCtxRef = ctx` 一并删除。`startBatchChatRun` 去掉 creds 分支，直接以 `provider: c.batchProvider` + `llm: llmRef` 起跑；note 文案恒为 `${batchProvider}/${batchModel}`。
- 实现 ③（提交前置校验硬化）：`submit()` 改为强制三项——`batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失即抛错并落 job `failed`（错误文案指向设置项，不静默跑空、不降级子代理）。`job.credentialSource` 恒为 `llm(<provider>/<model>)`；`job.apiKey` 字段彻底移除，`saveJobs` 不再做 apiKey 剥离（`{ apiKey, ...rest }` 的 map 删除）。
- 实现 ④（Config/liveConfig）：删除 `batchApiKey`、`batchThinkingBudget` 两字段及其 `[0,32768]` 钳制；`batchProvider` 描述改为「必须是 DSH 模型设置里已注册的 provider id……留空将无法提交任务」。
- 实现 ⑤（client.js 设置页）：删掉 `batchThinkingBudget`/`batchThinkingBudgetHint`/`batchProviderBuiltin`/`invalidBatchThinking` 四组词条（中英）、整段「思考预算」输入、provider 下拉的空值项（不再有"内置百炼通道"可选）；provider 手填 placeholder `aliyun-bailian` → `workbuddy`；切换 provider 时清空 `batchReasoningEffort`；无 provider 时的思考档位提示改走 `batchReasoningEffortNone`。保存键白名单 16 → 14 项。
- 实现 ⑥（文档）：README 把 `batchProvider`/`batchModel` 两条合并为「0.10.1 起为唯一通道」并注明删除直连、`batchProvider` 留空即提交失败，删掉 `batchApiKey`/`batchThinkingBudget` 两条；`cordis.patch.yml` 注释同步。`codewiki_generate` 工具描述末条改为「凭证由模型设置里该 provider（默认 workbuddy）的配置解析，插件不保存也不传递任何密钥」。
- 测试：test-batch.mjs 的「凭证解析链」7 断言整块替换为「不再导出 `resolveBatchApiKey`」的反向断言，并新增 `makeLlm`/`promptOf` 夹具按 `llm.stream` 协议应答，覆盖 provider/model/reasoningEffort 原样下发、temperature=0、未配思考档位时不下发 `reasoningEffort`、取消与失败记账，107 项全过。test-orchestration.mjs 把 `makeBatchMock` 从 fetch mock（打 `dashscope.aliyuncs.com`）整体改为假 `llm` 服务（`activeLlm` 转发、`llmCalls` 记录、支持 stall/bigArticle/bigSources/planReply），所有 `apply(ctx, {})` 改为 `batchCfg()`；「阶段实时阈值」块改名为「唯一通道：宿主 llm 服务」并断言零直连；「无凭证诚实报错」块改为「编译模型/provider 缺失」块并追加 job `failed` 留痕断言；编排冒烟全过。test-cwd-paths / test-wiki-entry 全过。
- 版本 0.10.0 → 0.10.1。

## 0.10.0 — 2026-10-23

### 功能：全面改用免费 hy3 主模型，全流程回到插件内，单项目串行，设置页思考程度从模型目录读取

- 背景（用户需求）：放弃 qwen3.7-flash，改用免费的 `workbuddy/hy3` 作主模型（192k 上下文，足够应付大部分篇目），因此「超预算就委托发起会话的主模型 / 转会话通道」这条主路径不再需要；同时要求 hy3 并发为 2、同一时刻只允许一个项目在编译，以及插件页的思考程度改为直接从模型列表读取。两处架构级歧义经用户确认：①超 192k 的单个源文件仍保留会话通道作**最后兜底**（`sessionTier` 配置保留）；②多项目同时提交时后者**排队等待**而不是被拒。
- 实现 ①（index.js 默认模型与预算重算）：新增 `DEFAULT_BATCH_PROVIDER='workbuddy'` / `DEFAULT_BATCH_MODEL='hy3'` 常量，`Config.batchProvider`/`batchModel` 默认值改为它们（`liveConfig` 的空值回落同步）。`BATCH_TOKEN_BUDGET` 28000 → **110000**（hy3 上下文 192k、单请求输出上限 64k，输入侧留 128k 再扣输出与估算余量）；`BATCH_TOKEN_HARD_LIMIT` 200000 → **150000**（超此才转会话通道兜底）。`estimateTokens` 与各装填点注释同步改写，不再提 32k 低价档。
- 实现 ②（删除主模型规划）：移除 `createJobService` 内的 `runMainModelPlan`（原逻辑：向发起会话的 `agentsRef.get(job.sessionId)` 取 `requestHeader().config` 或 `agent.options` 的路由，再用 `llm.stream()` 跑规划，失败降级批量）。规划阶段不再出现「规划走主模型（…）」note，全部走插件内并发池——hy3 的 192k 装得下文件清单。`tickPlan` 里调用它的分支一并删除，只留批量规划任务。
- 实现 ③（思考程度 → 模型目录）：新增导出纯函数 `resolveModelEfforts(llm, provider, model)`——走宿主 `llm.resolveModel()`，返回 `{ok, provider, model, efforts:[{id,name,description}], defaultEffort, context}`；`listModels` 不携带 reasoning 信息，所以必须单独解析。新增端点 `GET /api/codewiki/model-efforts?provider=&model=`（回环限定、60s 进程内缓存、缺参 400、`ok:false` 不抛 500）。`llmChat` 新增 `reasoningEffort` 入参，仅在非空时写入 `llm.stream({ ...reasoningEffort })`；`runRealtimeTasks` 与 `startBatchChatRun` 透传 `liveConfig().batchReasoningEffort`。Config 新增 `batchReasoningEffort`（默认空 = 模型默认档）。
- 实现 ④（单项目串行）：Config 新增 `serialProjects`（默认 true）。`submit` 时若已有别的项目在推进（`jobs` 里非终态、非 queued、非 submitting 且不是自己），本任务直接进 `queued`，首个阶段与 stale 预置任务先存 `pendingStage`/`pendingTasks`，并 note「已有项目在编译（X），本任务排队等待（单项目串行）」。`tick` 每轮先算 `activeId`（已有在跑的就是它，否则取最早 `queued`），排到自己的 job 才把 `pendingStage` 落地并 note「排队结束，开始编译」；其余项目本轮跳过（不推进、不失败），取消不受闸门限制——排队期间零请求。
- 实现 ⑤（并发默认 2）：`Config.maxConcurrency` 默认值 `CONCURRENCY_HARD_CAP`(8) → `DEFAULT_CONCURRENCY`(2)，`liveConfig` 的回落同样改为 2（硬顶仍是 8）。
- 实现 ⑥（client.js 设置页）：新增「单项目串行」Switch（中英案齐备，保存键列表加入 `serialProjects`）；「编译模型」区新增「思考程度」下拉——选中 provider/model 后拉 `/api/codewiki/model-efforts` 渲染该模型真实档位（含「模型默认（<defaultEffort>）」空值项），加载中/无档位/读取失败三种提示齐备；删掉前端写死的 `qwen3.7-flash` 默认值与 placeholder；用量行「超 32k 档（3 倍价）」改为「超单请求预算（按大档装填）」；面板阶段条把 `queued` 放最前（点亮第 0 个点表示排队）。
- 实现 ⑦（文案对齐）：`codewiki_generate` 工具描述、提交成功 note、校对阶段注释、`cordis.patch.yml` 设置清单、README 设置段与工具表、`CodeWiki.md` 的 Overview/Key Components/Architecture/Data Flow/Connections 全部改写为 hy3 + 插件内 + 串行口径（删掉已不存在的 `defaultProvider`/`defaultModel`/`defaultReasoningEffort` 描述）。
- 测试：test-batch.mjs 新增 `resolveModelEfforts` + `/api/codewiki/model-efforts` 端点 11 项断言（档位解析/默认档/描述/context 透出、未知模型 ok:false、llm 未注入诚实报错、无档位模型空列表、端点注册/200/缺参 400/非回环 403），107 → 118 项全过。test-orchestration.mjs 新增「单项目串行」11 项断言（A 进 plan 占住推进权、B 提交即 queued、note 文案、pendingStage 预置、排队期间零请求、取消 A 后 B 自动轮到并 done、排队结束 note、A 终态 cancelled）全过；test-cwd-paths / test-wiki-entry 全过。test-wiki-anchors 的 287 处失败为编译前 wiki 文章行号漂移（预期，收尾由 codewiki_generate 重编修正）。
- 文档：README 工具表与设置段、CodeWiki.md 同步；版本 0.9.2 → 0.10.0。

## 0.9.2 — 2026-10-23

### 修复：自建 codewiki 档位在写 CodeWiki 时从未被调用（用户反馈：创建了 codewiki 档位，写 wiki 时模型仍走 default 档）

- 排查结论（分两层，均经实测）：①**编译主链不问档位**——规划/写文章/横切/校对全部走 `runRealtimeTasks`，模型由 `batchProvider`/`batchModel` 直接决定，与子智能体档位是两套独立机制，所以 28k 以内的篇目根本不会经过档位；②**唯一经过 `delegate` 的环节是超预算转会话通道**（`dispatchSessionTasks` 的 steer），而它的文本只写「请调用子智能体（delegate/subagent）」，不给 `tier`——会话模型于是走上层决策模型的自动选路。用 `ask_route` 实测「写 CodeWiki 模块文章」两次都判 `default`（置信 0.88 / 0.99，阈值 0.6），自建档位永远轮不到。
- 实现 ①（index.js 新增配置 `sessionTier`）：`.volatile()` 字符串，留空 = 保持旧行为（自动选路）；非空 = steer 文本要求 `delegate` 显式传该 `tier`。`liveConfig` 同步解包。
- 实现 ②（index.js 抽出纯函数 `buildSessionSteerText({job, snapshots, tier, resend})`）：把原本散在 `dispatchSessionTasks` 与 `resendSessionSteer` 里重复的两段 steer 文案合并为一处（含 review 阶段的校对措辞、重发措辞、任务文件与目标路径清单），`tier` 非空时插入「派单要求：调用 delegate 时必须显式传 tier: "<id>"（不要依赖自动选路），mode 用 spec」。两处调用点改为调用它，删掉各自的字符串拼接——顺带消除了两条文案路径再次分叉的风险。
- 实现 ③（`dispatchSessionTasks` 的 note）：转会话通道时写明「档位钉死 <id>」或「档位自动选路」，面板上能直接看出这次用的是哪种。
- 实现 ④（client.js）：设置页「编译模型」区新增「会话通道档位」文本输入（中英文案齐备），保存键列表加入 `sessionTier`。
- 测试（test-batch.mjs）：新增 8 项 `buildSessionSteerText` 断言——未填档位不提 tier、填了要求显式传、含「不要依赖自动选路」、任务文件与目标路径都写进文本、无未替换的模板占位符、review 阶段按校对措辞且同样钉死、重发文案带「重新派发」、重发且未填档位不提 tier。98 → 107 项全过；test-orchestration / test-cwd-paths / test-wiki-entry / test-wiki-anchors 全过。
- 配置：本机 profile 的 `codewiki` 插件配置补 `sessionTier: codeiwiki`，并把路由插件 `default` 档描述里的「文档测试」改为「测试执行与排错」、`codeiwiki` 档描述从 7 字扩为可判定的职责说明（减少自动选路时的语义抢占）。
- 文档：README 设置段补 `sessionTier` 与其存在理由；版本 0.9.2。

## 0.9.1 — 2026-10-22

### 功能：设置页编译模型改为可选配置文件中的提供商与模型（用户需求：使用本地部署的 9b 模型能胜任工作吗）

- 背景：0.9.0 及之前编译模型的调用链写死百炼兼容端点（`BAILIAN_BASE`），设置页只有一个「模型名」文本输入，模型只能从百炼目录里挑。用户问「本地部署的 9B 模型能不能胜任」，结论是「能，但当时插件没有入口把它接进来」。本次把编译模型的来源改成宿主模型设置（llm 服务）里已注册的 provider + model，本地 OpenAI 兼容端点因此可用。
- 实现 ①（index.js 新增导出纯函数 `listModelCatalog(llm)`）：枚举 `llm.listProviders()`（兼容 `id`/`provider`、`displayName`/`name` 两种字段写法，跳过空 id），逐个 `llm.listModels(id)` 映射为 `{id,name}`；单个 provider 探测失败（缺凭证/端点不通）不影响其它条目——该条目保留、models 为空、附 `error`。llm 服务未注入时返回 `{ok:false, providers:[]}`，设置页据此降级为手填。
- 实现 ②（index.js 新端点 `GET /api/codewiki/models`）：回环限定（`guard`），30 秒进程内缓存，返回目录；llm 服务缺失时 200 + `ok:false` 而非 500，让前端有可读原因。
- 实现 ③（index.js 调用链分流）：`batchProvider` 非空时不再拼百炼 URL，改走宿主 llm 服务的 `llm.stream()`（`runRealtimeTasks` 的 `chat` 参数改为二选一：`llmChat` 走宿主、`bailianChat` 走百炼；请求携带 `{provider, model}` 路由，用 `BlockAssembler` 收集 text 块与 usage，finish 为 `error`/`aborted` 时抛错交给并发池按单任务失败记账），凭证与思考程度交给该 provider 自身配置——宿主侧思考程度是 `reasoningEffort` 枚举档位而非 token 数，故该通道不下发 `batchThinkingBudget`；为空时完全保持 0.9.0 的百炼直连行为（含 `batchApiKey` 覆盖与 `batchThinkingBudget` 映射 `enable_thinking`）。两条通道共用同一个「拆包 → 校验 frontmatter → 落盘」出口，下游流水线零改动。
- 实现 ④（client.js 设置页）：`batchModel` 文本框改为两级下拉——provider 下拉（首项「内置百炼通道（默认）」= 空值）+ model 下拉（随所选 provider 的目录刷新，选 provider 时自动带出该 provider 首个模型）。已配置但目录里没有的 provider/model 仍作为选项保留，避免静默丢失配置；目录拉取失败或该 provider 无可枚举模型时回退为文本输入并给出原因。中英文案齐备。
- 测试（test-batch.mjs）：新增 `listModelCatalog` 6 项断言（跳过空 id、displayName 展示名、listModels 映射、`provider`/`name` 字段兼容、单 provider 失败隔离、llm 未注入降级）与 `/api/codewiki/models` 端点 4 项断言（端点注册、回环 200 + 目录内容、非回环 403）；94 → 98 项全过。test-cwd-paths / test-orchestration / test-wiki-entry 全过。
- 文档：README 设置段重写（provider/model 两级语义、两条通道的凭证与思考预算归属）；版本 0.9.1。

## 0.9.0 — 2026-10-21

### 功能：超 32k 文章转「会话通道」（用户需求：超过 32k 的文章通过消息传给会话模型，由会话模型调用子智能体完成）

- 背景：0.8.x 对超批量预算文章有两条昂贵/不可靠路径——单文件超 28k 先升 200k 大档（32k–256k 档按 3 倍价）、连大档都装不下走 `runRealtimeTasks` 同模型同步兜底（长请求阻塞 tick、失败面大）；校对阶段另有「连 200k 大档都装不下就跳过校对」的静默降级。用户要求统一改为：超 32k 的文章通过消息传给发起会话的会话模型，由它调用子智能体完成。触发范围与失败语义经用户确认：升大档、超大兜底、校对跳过三条路径全改走会话通道；发起会话不可用（面板/自动调度提交、会话已关）直接整体失败；会话通道任务超时未产出按失败处理，不降级百炼。
- 实现 ①（index.js `prepareArticleTasks`）：返回值 `{ prepared, oversized }` → `{ prepared, sessionTasks }`。28k 装得下照旧进 prepared；分割判定（prompt 超预算或有文件被 skip）里逐文件检测——单文件连观察批预算都装不下（`hasOversizeSingle`）或分不出多批时不再落回大档提交，而是按 200k 大档装填出 `batchPrompt` 后进 `sessionTasks`；连 200k 都装不下（`tooBig`）同样进 `sessionTasks`。多文件可拆的情形仍走观察→合成批，行为不变。
- 实现 ②（新常量/纯函数）：`SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调，下限 5 分钟）、`SESSION_TASK_DIR`（`os.tmpdir()/dsh-codewiki-session-tasks/`，与 JOBS_FILE 同目录）；导出纯函数 `classifySessionTask(task, nowMs)` 三态——`timeout`（派发超过时限，超时判定优先）、`harvest`（目标文件 mtime ≥ 派发时间且以 frontmatter 开头）、`wait`（未产出/旧文未更新/写一半）。
- 实现 ③（`createJobService` 新增三函数）：`dispatchSessionTasks`——校验 `job.sessionId` 与 `agentsRef.get` 的 steer 可用性（不可用直接 `fail` 明示「请从会话内重新提交编译」），逐任务把 batchPrompt 写任务文件、建文章目录、记快照 `{name, articlePath, promptFile, dispatchedAt}` 存入 `job.sessionTasks`（随 job 持久化），再 `agent.steer(createUserMessage)` 一条短消息（含任务文件路径与目标文章路径、子智能体写作要求）；`progressSessionTasks`——每 tick 对等待中的任务分类：timeout 记 `{ok:false, stopReason:'timeout'}` 并 note，harvest 读文件经 `writeValidated` 闸门（frontmatter 校验 + fixAnchors 校正）落盘入账，wait 留待下轮；`resendSessionSteer`——宿主重启接管（tick 的 owner 接管分支）后重发一次 steer，不重置 dispatchedAt，幂等。
- 实现 ④（`tickArticles` 重构）：batchRef 分支收割后不再直接 setStage，落到统一收尾（等会话通道收割完再推进）；`!job.sessionTasks?.length` 时才组装任务——`prepareArticleTasks` 出的 sessionTasks 先 dispatch（失败已记账则 return），prepared 非空则照旧 `submitBatchFor`；统一收尾：`progressSessionTasks` 未终态 return，终态后 `job.sessionTasks = null`，`writtenCount===0` fail（原文案不变），否则 `setStage(crosscut/review)`。观察批全部失败且无在途会话任务时保持旧行为（直接推进）。
- 实现 ⑤（`tickReview` 校对阶段同样接入）：原先「首个源文件连 200k 大档预算都装不下 → 跳过校对批次」改为转会话通道——`batchProofreadPrompt` 装填后进 `sessionTasks`（`job.stage === 'review'` 时 dispatch 文案为「超预算校对任务」、任务文件即校对指令、收割结果按 `replace` 覆盖同名文章条目，校对失败不推翻已写成功的原文）。校对批与会话任务可并行：batchRef 分支收割后若仍有在途会话任务则继续收割，未终态 return；无在校任务才进 index。`resendSessionSteer` 文案按阶段区分。`runRealtimeTasks` 函数本身保留（`startBatchChatRun` 仍是批量执行器，校对/横切/合成照旧）。
- 删除：`tickArticles` 里的超大兜底段（`runRealtimeTasks` 同步调用 + `rt*` customId + 转超大兜底 note）。`runRealtimeTasks` 函数本身保留（`startBatchChatRun` 仍是批量执行器，校对/横切/合成照旧）。
- 测试（test-batch.mjs）：`prep.oversized` → `prep.sessionTasks`；300KB 单文件断言进 sessionTasks（prompt 内联完整源码）、800KB 断言进 sessionTasks；多文件 4×90KB 断言仍拆观察批；新增 `classifySessionTask` 6 项断言（超时优先于已产出、harvest、无 frontmatter wait、旧文未更新 wait）。64→82 项全过；test-orchestration / test-cwd-paths / test-wiki-entry 全过。
- 文档：README.md 工具表、CodeWiki.md（Overview / Key Components / Architecture / Known Issues）同步；版本 0.9.0。

## 0.8.8 — 2026-10-19

### 修复：行号锚点确定性自动修正（第四层兜底，接 0.8.7）

- 背景：0.8.7 的三层修复（源码行号前缀 + prompt 条款 + stale 禁沿用）证实对弱模型（qwen3.7-flash）不充分——重编译后仍出现新幻觉锚点（client.js NS 实 17 写 20、STAGE_WEIGHTS 实 684 写 468）与未刷新的旧锚点（index.js prepareArticleTasks 441-497 因 +9 偏移过期）。用户选定「确定性自动修正」方案。
- 实现：新增 `fixAnchors(content, cwd)`（index.js，numberLines 旁）——文章落盘前把「file:NN(-MM)」锚点对照 source_files 源码做机械校正，语义与 test-wiki-anchors.mjs 一致：锚点起点行应包含同行反引号符号（或其末段）；不包含时在源文件全文找符号——恰好一处 → 修正；多处 → 取唯一的声明形态行（`^[ \t]*(?:export )?(?:async )?(?:function|class) SYMBOL` 或 `(?:const|let) SYMBOL =`，缩进容忍；`const gamma = beta()` 这类「别的符号的声明」不算）；点分符号（如 `Config.articleLanguage`）歧义时退试首段——首段才是可声明的部分；仍歧义/找不到 → 不动并记 unresolved。区间锚点起点对齐符号行、区间尾越界钳到文件尾（修正起点是净改善）。文件解析：source_files 精确路径 → basename 唯一匹配 → 歧义不碰；source_files 之外的引用一律不动。CRLF 文章行尾保真。readSourceFiles 拆出 `parseSourceFiles(fm)` 共用。
- 集成：两个写盘出口统一过修正——`applyTaskResult`（普通文章直写，源码根取 `task.cwd`）与 `writeValidated`（keepInMemory 落盘闸门——校对/合成/横切结果，取 `job.cwd`）。修正与存疑均记 notes（「自动修正 N 处行号锚点」/「行号锚点存疑（未改）」）。full/stale 文章任务构建与 submitBatchFor 持久化快照补 `cwd` 字段。
- 测试：test-batch.mjs 新增 fixAnchors 13 项断言（唯一修正/已正确不动/未找到/多声明歧义/声明形态命中/区间对齐与钳制/basename 唯一与歧义/清单外不碰/CRLF 保真/无 frontmatter 原样），64→77 全过。
- 真实验证：对本仓库真实文章 documentation-and-config.md 跑 fixAnchors——8 处修正全部命中真实行号（Config 37、prepareArticleTasks 538-594、updateToolDefinition 2113、progressToolDefinition 2184-2280，grep 实证），含 0.8.7 遗留的 3 个 client.js 幻觉锚点（NS 20→17、ACTIVE_STAGES 29→25、STAGE_WEIGHTS 468→684）；4 处复合引用行（反引号为「SYMBOL = value」形态，提不出纯标识符）保守未改。job-mveup23z-a 重编译后对全量文章机械运行 fixAnchors：锚点校验 165 过/46 败 → 186 过/21 败（净修 21 处，cw-binary-source-lost.md 8 处全修）；剩余失败均为预期保守行为——点分符号/复合引用的校验语义局限（锚点实际正确）、真歧义、source_files 清单外锚点。注：编译服务是长驻进程，本次编译时内存仍为旧版代码，fixAnchors 未在服务写盘时生效，产物由会话侧机械运行补正；服务重启后下次编译自动生效。
- 版本 0.8.8。

## 0.8.7 — 2026-10-19

### 修复：wiki 文章行号系统性幻觉（用户报告：build.rs 锚点偏移）

- 现象：Wxxy-CampusLogin 产物把 38 行的 `tauri-app/src-tauri/build.rs` 各锚点写偏（fn main 4→3、conf_path 12→17、总行数 38→39 等），同一错误经 4 次 stale 重写原样固化。诊断三层：① collectSources 内联源码无行号标注，弱模型（qwen3.7-flash）自己数行——首尾可数对、中段必错、尾换行多算；② 校对 prompt「上源码逐个核对」但未指明行号依据，拦不住；③ stale 重写沿用旧文行号，错误延续。
- 修复 ①：新增 `numberLines()`（index.js:343），collectSources 内联的每行源码加 grep 风格「N| 」前缀，模型引用行号有据可依。尾换行只去一个（多去会挤掉真实空行）；CRLF 行尾 `\r` 剥离（校对比对噪音）。token 预算经 estimateTokens 自动计入，装填逻辑不变。
- 修复 ②：校对 prompt 核对项改为「行号以源码『行号| 』前缀为准，禁止自行数行」；articleFormatSection 共享条款同步（405/708 两个调用方都有前缀源码或前缀观察输入）。
- 修复 ③：batchArticlePrompt / batchArticleComposePrompt 的 prevArticle 注入段加「旧文行号可能已过期，一律不得沿用」；观察员 prompt 的行号产出条款同样绑定前缀。
- 测试：test-batch.mjs 新增 numberLines 断言（单/双尾换行、CRLF、空文件）+ collectSources 前缀断言（59→64 项）；用真实 build.rs 逐行比对 38/38 行 0 mismatch、6 个用户锚点全部命中——源码层前缀正确性已证实。
- 重编译验证（job-mvesr9e4-7，修复后的流水线跑本仓库）：观察/合成/校对链看到带前缀源码后仍产生新锚点错误（重写文章新增 client.js 锚点错位：NS 实为 17 写成 20、STAGE_WEIGHTS 实为 684 写成 468），且未修正沿用的旧 index.js 锚点——test-wiki-anchors 121 过/37 败 → 168 过/44 败。结论：prompt 层对 qwen3.7-flash 不充分，行号正确性需机械校验兜底（后续方向）。
- 版本 0.8.7。

## 0.8.6 — 2026-10-18

### 修复：规划阶段没有真正继承当前对话模型（用户需求）

- 现象：用户要求「修改规划调用模型，直接继承当前对话的模型进行」。代码看似早已这么做（0.8.3 的 `runMainModelPlan`），但实际每次全量编译都降级百炼 —— `%TEMP%/dsh-codewiki-jobs.json` 里两条 full 任务的 notes 首条均为 `主模型规划异常 —— cannot get property "llm" without inject`。
- 根因：`runMainModelPlan` 里 `let llm = hostCtxRef?.llm` 在真实 cordis 下**访问即抛**（未 inject 的服务属性不允许读，`typeof` 守卫拦不住），异常被函数外层 catch 吞成一条 note → 规划恒走批量 qwen3.7-flash。原 inject 兜底也走不到（异常先抛）。
- 修复 ①：新增模块级 `llmRef`，`apply()` 里 `ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })`，与 `agentsRef` 同款；`runMainModelPlan` 只读 `llmRef`，删掉 `hostCtxRef?.llm` 属性访问与那段走不通的 inject 兜底。服务未注入时明确 note「主模型规划不可用（llm 服务未注入）」再降级。
- 修复 ②（更贴近「当前对话模型」）：路由解析改为「会话已路由 `session.requestHeader()?.config` → 未路由退回 `agent.options.{provider,model}`」，与 compaction 的 `latest ?? agentTarget` 同序，不再因会话尚未路由而静默降级。
- 测试：test-orchestration.mjs 新增场景 1b —— mock ctx 上把 `llm` 定义成抛错 getter（复刻真宿主故障），断言规划仍走主模型、路由取自 `agent.options`、notes 无「主模型规划异常」、计划正常入库。
- 回归：node --check ✓；test-orchestration / test-batch / test-wiki-entry / test-cwd-paths 全 EXIT=0。
- 版本 0.8.6。

## 0.8.5 — 2026-10-18

### 适配 DSH 0.2.1-rc.2：wake/plan source 形态 + engines.dsh 声明

- 背景：宿主升级 0.2.0-rc.2 → 0.2.1-rc.2（hostProtocolVersion 4，asar 内 dsh commit 59e68c58）。
- source 形态（1e6fbe5，随本版一并测试收口）：index.js 两处 createUserMessage 的 source 从 `{kind:'plugin',plugin:'codewiki'}` 改为 `{kind:'plugin:codewiki'}`（wakeCompileSession 的 agent.steer 与 runMainModelPlan 的 llm.stream messages）。asar 核实：user/message 校验仅要求 source.kind 非空字符串（dsh agent-loop.js:1205），PLUGIN_RECORD_TYPE 正则只管插件记录事件类型名，不约束 source.kind；`plugin:codewiki` 两边皆合法。
- 补 `"engines": {"dsh": ">=0.2.0-rc.0"}`（package.json）：0.2.1-rc.1 起第三方插件兼容性优先按 engines.dsh 判定（dsh-app-boot plugin-compatibility.js：engines.dsh 为 semver 范围、includePrerelease:true、声明后单独决定兼容性并忽略 dsh-* peerDependencies；未声明沿用旧规则）。实测 `0.2.1-rc.2` 与 `0.2.0-rc.2` 均满足该范围。
- 测试：test-orchestration.mjs:343、:494 断言改新形态 `source?.kind === 'plugin:codewiki'`；test-batch/orchestration/wiki-entry/cwd-paths 全 EXIT=0；test-wiki-anchors 36 败为 .codewiki 行号锚过期，由本次 codewiki_generate 重编译刷新。
- 宿主面实测存活（本会话即 0.2.1-rc.2 宿主）：cw/codewiki_generate/codewiki_update/codewiki_progress 4 工具注册生效；/api/codewiki/jobs、/repos 200（webServer exact + loopback guard + workspaceRegistry 生效）；【CodeWiki 维护】systemPrompt.section 注入正常。浏览器半侧面板待用户目验。
- 版本 0.8.5。

## 0.8.4 — 2026-10-15

### 文章阶段超预算分割：观察批 map + 合成请求 reduce（避开 32k 三倍价，用户需求）

- 背景：文章阶段一个模块的源码总量超 28k token 预算时，原先整体升 200k 大档继续装填（实测单阶段 9 个请求超 32k 档、按 3 倍价计费，441.9k 输入）；且 collectSources 把装不下的文件静默 skip（「不得涉及它们」），超预算内容直接丢失。用户要求：超预算必须拆分成多个 ≤28k 请求，而不是升大档。
- 新增 `batchArticleObservePrompt(language,moduleName,sourcesText,batchIndex,batchTotal)`（index.js）：分批观察 prompt，要求保留全部函数/类/导出名、常量默认值、行号、调用关系、文件清单；禁 frontmatter。
- 新增 `batchArticleComposePrompt({language,mission,moduleName,observationsText,prevArticle})`：观察包 → 完整文章，沿用观察中的「文件:行号」，汇总 source_files，articleFormatSection() 收尾。
- `prepareArticleTasks`（index.js:441-497）分割判定：collectSources 28k 装填后 prompt 估算 >BATCH_TOKEN_BUDGET **或存在装不下的溢出文件**（overflowFiles，堵静默 skip）→ 逐单文件重新分批，batches.length>1 → 每批一个观察任务 `{customId:'split{n}o{i}', name:'<article>#obs{i}', keepInMemory:true, splitFor, composePlan:{mission,articlePath,prevArticlePath,batchCount,files}}`；单文件占满分不出多批时落回 BATCH_TOKEN_HARD_LIMIT 大档（原行为）。
- `tickArticles` 收割侧两段状态机：results 含 `#obs` → 按 articleName 分组（composedArticles Set 去重，每篇一条合成任务）→ 从持久化任务快照重建合成任务（customId `o\d+$`→`c`）→ submitBatchFor 合成轮 → 下一轮收割写盘；观察全失败该篇缺席并 note；部分失败合成基于剩余观察。
- `submitBatchFor` 持久化 job.tasks 补带 `splitFor/composePlan`（宿主重启后收割重建合成所需的元数据，原快照会丢）。
- 测试：test-batch.mjs §3 改分割语义断言 + 新 3b 节（4×90KB fixture：obs 任务 ≥2、batchPrompt token ≤28000、splitFor/composePlan 绑定）；test-orchestration.mjs 新 e2e 块（bigSources 仓库：4 观察批 → 2 合成 → modules/*.md 落盘 → PROOFED 校对回写 → 零 3 倍价 notes）；makeBatchMock 加 bigSources 参数与「文章观察员」应答分支。
- 回归：test-batch/orchestration/wiki-entry/cwd-paths 全 EXIT=0；test-wiki-anchors 失败均为 .codewiki 锚过期，由重编译刷新。
- 版本 0.8.4。

## 0.8.3 — 2026-10-15

### 规划阶段改走主模型（避开百炼 32k 三倍价，用户需求）

- 背景：规划阶段把全仓文件清单塞进一个百炼请求，仓库一大就超 32k 低价档（实测 41.8k 单请求按 3 倍价计费），且规划串行拖慢整体编译。用户要求改由发起会话的主模型执行规划。
- 新增 `runMainModelPlan(job, prompt)`（index.js）：取发起会话 agent（`agentsRef.get(job.sessionId)`）→ `agent.session.requestHeader()?.config` 拿主模型 {provider, model} → `ctx.llm.stream()`（hostCtxRef 属性 + inject(['llm']) 双取法，兼容 mock ctx 与真实 cordis）+ `BlockAssembler` 收文本，`createUserMessage` 带 `source:{kind:'plugin',plugin:'codewiki'}`；temperature 0；AbortController 入 batchAborters（取消编译可中断规划）；usage 按实测 outputTokens + estimateTokens(input) 记账（requests:1, realtime:true）。
- tickPlan 改造：先主模型规划 → parsePlan 成功入库并 note「规划（主模型）」；主模型不可用（无 sessionId/路由/llm）或未产出可用 JSON → 降级百炼批量规划（原 submitBatchFor 路径与 batchRef 收割逻辑零改动）。
- 测试（test-orchestration.mjs 新块 3 场景）：①agent 带路由 → ctx.llm 恰 1 次、百炼零规划请求、计划入库（fixture-mm）、overTier2 不计；②主模型回非 JSON → 降级百炼、done；③无 sessionId → 不碰 llm、批量照旧。makeCtx 增 llm 注入选项。踩坑：fake 流 block-end 必须携带与 delta 一致的完整 block（BlockAssembler closed-block-wins 语义），空 block 导致文本为空误走回退。
- 回归：test-orchestration/batch/wiki-entry/cwd-paths 全 EXIT=0；test-wiki-anchors 失败均为 .codewiki 文章行号锚过期（新增代码使行号后移），由本次 codewiki_generate 重编译刷新。
- 版本 0.8.3。

## 0.8.2 — 2026-10-15

### 修复：4 个 cw 工具在新宿主全部消失（根因：progress schema type 数组）

- 现象：宿主更新后 cw/codewiki_generate/codewiki_update/codewiki_progress 4 个工具全部消失，但面板端点（GET /api/codewiki/jobs）正常——工具注册回调整体未生效。
- 根因（最小复现坐实）：0.7.0 修复 progress 输出 schema 的 nullable 字段时用了 `type: ['object','null']` 数组形态（4 处：batchProgress/tps/error/finishedAt）；新宿主 ToolRuntime.register 强制 JSON Schema 子集（assertSupportedJsonSchema，type 必须单字符串——"type arrays are not supported"）。注册循环第 4 个定义（progress）抛错 → apply 回调失败 → cordis 把该 fiber 判 FAILED 并**回滚其全部 effect**（含已成功注册的前 3 个工具）→ 4 个全没，宿主吞错（exit=0 静默无日志）。纯 cordis 复现脚本验证：抛错后 registered=(none)，与真实宿主观察完全一致。
- 修复 ①：4 处 type 数组改子集合法的 nullable 表达 `{ oneOf: [{type:'object'},{type:'null'}] }` 等价形态（oneOf 恰两支、不与 type 并存，均在新子集白名单内）。
- 修复 ②（防御）：工具注册循环加 per-definition try/catch——未来任一工具 schema 违规只丢该工具并 console.error，不再炸回调回滚全部。
- 回归验证：node --check ✓；静态断言 index.js 无 `type: [` 残留 ✓；端到端模拟宿主校验 4 工具全部注册 ✓；单工具失败隔离（progress 模拟抛错，其余 3 个存活）✓；test-batch.mjs 51/0 ✓；test-orchestration.mjs 全 PASS ✓。
- 版本 0.8.2。

## 0.8.1 — 2026-10-14

### 工具拒绝编译时报错同时返回命中的排除项（用户需求）

- 背景：用户要求「调用工具时，同时要返回排除项告诉模型此工作区被排除了」。原报错只说「该目录在 CodeWiki 排除清单中」，排除清单有多条时模型无法定位是哪条规则拒绝的。
- `codewiki_generate` / `codewiki_update`（及编排服务 submit 路径）对被排除目录的报错改为同时带命中的排除项原文：`该目录在 CodeWiki 排除清单中，不编译：…（命中排除项：<清单条目>；在插件设置或面板「设置」页编辑排除清单）`。
- 实现新增 `excludedItem(cwd, list)`（返回命中的清单条目原文），`isExcluded` 改为 `excludedItem(...) !== null` 的布尔包装（面板 repos 总览 excluded 字段布尔语义不变，全部调用点行为不变）。
- 版本 0.8.1；test-orchestration.mjs 排除清单断言补「报错含命中排除项」（compile 400 / 直调 / 子目录三处，子目录场景校验排除项为父目录条目）。

## 0.8.0 — 2026-10-14

### 编译终态实时唤醒发起会话（用户需求：借用子智能体发送消息机制）

- 背景：0.7.0 的提交提醒靠系统提示 section 拉取（会话因别的原因醒来才看得到）。调研确认 DSH 唯一的续步队列就是 Agent inbox（subagent/continuation.ts:7-11），子代理 send_message 对父会话最终也是 `agent.steer()`；插件经 `ctx.inject(['agents'])` 拿同一注册表即可纯插件侧实时唤醒，harness 零改动。先例：dsh-turn-verify-guard 插件同机制在线运行。
- 新增 `wakeCompileSession(job, outcome, agents?)`（index.js，export 供测试）：编译终态对发起会话 `steer(createUserMessage({...source:{kind:'plugin',plugin:'codewiki'}}))`——done（writtenCount>0）发「【CodeWiki 编译完成·请提交改动】」、failed 发「【CodeWiki 编译失败】」；sessionId 缺失（面板/自动调度提交）、会话不在注册表（冷会话）、steer 异常一律静默跳过（系统提示 section 拉取兜底仍在）。
- 会话来源：generate execute 记 `exec.agent?.id`（工具执行上下文自带发起 agent，tools/src/index.ts:338）→ submit 存 `job.sessionId`；同仓库重复调用（幂等路径）最新会话拿唤醒权。createJobService 增 onSettled 回调参数（apply 传 wakeCompileSession）：tickIndex done 且 writtenCount>0、fail 且非提交期（提交期失败随工具调用同步返回，不重复唤醒）时触发。
- 依赖：node_modules 目录联接引 `@deepseek-ai/dsh-llm`（及 dsh-typert-protocol/util-crypto/util-values/brand/timeout/cordis/cosmokit 等宿主包，junction 模式同 dsh-turn-verify-guard；node_modules/ 不入 git）。
- 修复 0.6.0 回归：submitComposeBatch 仍按 Promise 链式调 `submitBatchFor(...).then(...)`，而 submitBatchFor 自 0.6.0 起是同步函数（返回 undefined）——横切精准拆分分支（模块文章总量超预算）提交合成批时抛 `Cannot read properties of undefined (reading 'then')` 致任务 failed。改 try/catch 同步调用。
- 测试基建突破：会话沙箱拦 node 子进程 Temp 写入（mkdtemp EPERM）——TEMP/TMP 重定向到仓库内 .tmp-test 后 test-orchestration.mjs 首次完整跑通（编排冒烟全 PASS，test-batch 51/0）；测试残留目录已清理。顺带修正 0.7.0 测试缺陷：wrapper 断言改临时替换 gen.execute（原 fakeGen 未注入）、commitHintText 60s 缓存跨断言污染改独立 fixture 仓库、同秒提交/编译竞态 sleep 隔开；新增 wakeCompileSession 单测（done/failed 文案、source 标记、无 sessionId/冷会话/registry 抛/steer 抛/缺省 agentsRef 全静默）与端到端断言（sess-e2e 提交 → 终态 steer 捕获）。
- 版本 0.8.0；README 工具表与 updateReminder 说明同步；test-orchestration.mjs 增补 wakeCompileSession 断言（done/failed 文案、无 sessionId 不唤醒、冷会话不唤醒）。

## 0.7.0 — 2026-10-14

### 新增 codewiki_update 日常维护工具 + 编译完成提交提醒（用户需求）

- 背景：用户要求「新增工具，让模型可以提交更新请求，告诉模型已经开始更新，继续下一项，同时更新完成后向主模型返回消息，让模型去提交改动」。
- 新工具 `codewiki_update`（index.js，updateToolDefinition）：固定 scope=auto 的提交制更新请求，execute 复用 generateToolDefinition 的 execute（{...args, scope:'auto'} 透传，幂等/短路/逐篇/全量路径全继承），仅追加引导 note「更新已在后台进行：继续下一项工作，不要等待……完成后系统提示会出现提交提醒」；错误消息里的 codewiki_generate 字样改写为 codewiki_update。参数仅 cwd/language（scope=full/stale 仍走 codewiki_generate）。apply() 注册为第四个工具。
- 编译完成提交提醒（commitHintText，export 供测试）：update-reminder 系统 prompt section 兼职——最近一次成功编译（stage=done 且 writtenCount>0）的 finishedAt 晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交（`git log -1 --format=%ct -- .codewiki CodeWiki.md`）→ 注入「【CodeWiki 编译完成·请提交改动】」提醒（只 add 这两个路径、docs(wiki) 前缀、禁 git add -A；模型自己提交，插件不代跑 git）。零持久状态：时间戳派生自 jobs 文件与 git log，提交后时间戳反超自动静默；非 git 仓库/无 .codewiki 提交史（log 空）/读 jobs 失败一律不提醒；60s TTL 缓存（text 回调每次组装求值）。受 updateReminder 开关与「仓库根存在 CodeWiki.md」门控约束。
- 版本 0.7.0；README 工具表补 codewiki_update 行、updateReminder 说明同步；test-orchestration.mjs 增补 wrapper 与 commitHintText 断言。
- 验证：node --check index.js 过。test-orchestration.mjs 因会话沙箱拦截 node 子进程文件写入（mkdtemp EPERM，同 0.6.0 记录）未能在会话内运行，需用户在正常 shell 验证。

## 0.6.0 — 2026-10-13

### 删除百炼批量推理通道：编译全部改走普通入口（用户决策）

- 背景：用户配置早已用 batchMinTokens 99999999 把全部阶段钉死实时（0.5.0.5 曾撤下又被架空的批量通道形同虚设），且批量 5 折需排队（分钟~小时级）。决策：删除 batch.dashscope.aliyuncs.com 专用链路，全部模型环节统一走百炼普通入口 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`；代价是放弃 5 折（用户已接受，实际早已全价实时）。
- index.js：删 BATCH_CHAT_BASE/BATCH_CHAT_TIMEOUT_MS、bailianChat 的 batch 参数与 1h 超时/重试包装、linkedSignal（唯一调用方是批量超时）、submitOrRun 阈值分流整函数与 localResults 就地实时路径（无进度无取消且阻塞 tick，弃用）；6 个提交点统一 `submitBatchFor`；startBatchChatRun/submitBatchFor/settleJob 文案与记账改「阶段执行器」措辞（addUsage `batch:true`→`realtime:true`，batchId 前缀 `batchchat-`→`stage-`）；Config schema 删 batchMinTokens（liveConfig 同步），batchModel/batchThinkingBudget/maxConcurrency 描述改普通入口措辞；工具描述/notes/错误消息去批量措辞。
- 保留骨架（有意不删）：后台执行器 startBatchChatRun/settleJob 与 batchRuns/batchResults/batchAborters 三 Map、job 持久字段 batchRef/batchProgress/batchSubmittedAt/batchPrompt、宿主重启按 prompt 快照重跑、取消中断在飞请求、面板进度展示——0.5.0 起「批量对话」实际只是这套后台并发池执行器的旧名，全部行为不变，仅端点从批量换普通。
- client.js：设置页删「批量编译（百炼）」节（secBatch 标题/batchApiKey 输入/batchMinTokens 输入与校验）；batchModel/batchThinkingBudget 保留为「编译模型（百炼）」节（secCompile，新增 zh/en 词条）；batchRunLabel '批量执行中'→'执行中'；keys 数组删 batchMinTokens（batchApiKey 保留以同步存量值，UI 不再渲染）。面板 batchLabel「批次」/双通道用量拼接保留（batchRequests 恒 0 自然退化，骨架不动）。
- 测试：test-batch.mjs 第 4 节重写为普通端点断言（URL、请求体、思考参数、tps、signal 中止），删超时/重试节；test-orchestration.mjs 删 BATCH_URL 双通道 mock 与 batchMinTokens 混合节，改「全程走百炼普通端点（零专用批量端点）」断言，重启重跑场景 A 前缀改 stage-（场景 B 保留 local 旧格式验证兼容）。
- 验证：node --check index.js/client.js/test-batch.mjs/test-orchestration.mjs 全过；test-batch.mjs 51/0 PASS。test-orchestration.mjs 因会话沙箱拦截 node 子进程文件写入（mkdtemp EPERM，PowerShell/bash 下同样）未能在会话内跑通，需用户在正常 shell 验证。
- 迁移说明：用户 live 配置残留的 batchMinTokens 值在 schema 删除后无害（未知键忽略）；设置页不再渲染 batchApiKey 输入，存量值仍生效（凭证优先级不变：显式 batchApiKey > 模型设置「阿里百炼云」渠道）。

## 0.5.0.6 — 2026-10-12

### 新增 codewiki_progress 只读查进度工具（后台编译语义对模型显式化）

- 背景：codewiki_generate 虽是提交制（调用即返回、宿主服务后台推进），但工具描述与 reminder 都把「进度」指向侧边栏面板/HTTP 端点——模型在会话内无从得知编译到哪了，容易提交后空等或反复重提交。用户要求「增加工具让模型查询进度、无需考虑编译是否完成」。
- 改动：新增第三个工具 `codewiki_progress`（index.js:1815-1911，samePath/progressView/progressToolDefinition）：只读、立即返回；可选 `cwd` 或 `jobId` 过滤（samePath 做路径归一化，都不传列全部）；数据 = jobSummary 同源 + progressView 计算 taskList 完成百分比；render 输出 stage=xx NN% + ✓/✗/· 任务明细 + 错误 + 最近 3 条 notes。apply() 注册三工具。
- 后台语义写进两处模型可见面：generateToolDefinition description 的「进度」行改为「提交后继续手头工作，不要等待或反复轮询；需要进度时用 codewiki_progress」；reminderText 新增一行「codewiki_generate 是后台编译……不要等待编译完成，提交后继续其他工作，需要进度时用 codewiki_progress 查询」。README 工具表补 codewiki_progress 行、updateReminder 说明同步。
- 测试：test-orchestration.mjs 新增 11 项断言（注册、cwd 归一化过滤、终态 progress=100、taskList 全 done、usage 块、jobId 单条/无匹配空、其他仓库空、render 含 stage/✓、进行中 job stage=plan progress=0、完成后 100）全过。
- 验证：node --check index.js/test-orchestration.mjs/client.js 全过；test-orchestration.mjs PASS（143/0）。test-wiki-anchors.mjs 130 过/32 败——失败均为既有行号漂移（index.js 2121→2225 行），属 0.5.0.5 已记录的同款系统性幻觉锚点问题，待收尾重编译后由守卫下一轮勘定。
- 附带确认（用户第三问）：.codewiki/ 推送 GitHub 无需适配 git 命令——cw 的 git 交互全在 Rust 层（meta.rs:43 current_commit、main.rs:146 cmd_status 的 git diff、main.rs:217-223 cmd_meta_update），插件层只调 cw CLI；仓库推送由宿主会话 git 工作流负责（.codewiki/ 与代码同提交），插件无托管仓库、无 push 逻辑。

## 0.5.0.5 — 2026-10-11

### 百炼批量通道从 Batch File 切换为 Batch Chat（省钱需求落地）

- 背景：0.5.0.4 时代批量走百炼异步 Batch File（JSONL 上传 → `/batches` 排队 → 轮询结算），但 batchMinTokens 99999999 把所有阶段钉死实时全价架空批量；用户明确「省钱」指让插件 qwen3.7-flash 批量编译省费用，而非会话模型。百炼 Batch Chat（同步端点 batch.dashscope.aliyuncs.com，实时价 5 折，服务端最长保持 1h、超时未调度不计费）免除上传/排队/轮询全链。
- 改动：合并 feat/batch-chat（f662483）进 main 并接线——删 buildBatchJsonl/parseBatchResults/bailianRequest/BATCH_TERMINAL/settleBatch/batchStateFile/submitBatch/resume 孤儿续查整条 JSONL 链（index.js 净删 ~175 行）；BATCH_CHAT_BASE/BATCH_CHAT_TIMEOUT_MS(1h) 常量；bailianChat(+batch,signal) batch=true 换端点、超时重试 1 次；runRealtimeTasks 共享并发池兼做两通道执行器；settleJob 重写（localResults/batchResults 收割 + 宿主重启按 job.tasks 的 batchPrompt 快照重跑当前阶段，幂等覆盖）；startBatchChatRun 的 onTaskDone 补 addUsage(outputTok)（批量输出 token 实测入账，对齐实时路径先例）；submitBatchFor 补 job.batchSubmittedAt（面板计时起点）与 32k 档 3 倍价明示 note。
- 同步配置：~/.dsh/profiles/desktop/cordis.patch.yml codewiki 块 batchMinTokens 99999999 → 30000（文章/审校阶段估算 ~210k tok 均走批量 5 折；99999999 是 0.4.11.2 有意的「强制全实时」用法，已按需撤下）。
- 验证：test-batch 55/0（分支版重写，测 Batch Chat 执行器/mock fetch）、test-orchestration PASS、test-cwd-paths PASS、test-wiki-entry 全过、node --check 过；锚点守卫轮 4：迁移致行号漂移+已删符号 → 17 处手改修正（concepts 实现地图 9 + 两篇 learning 8，基线 2121 行 index.js），守卫扩至 185 断言全过。

## 0.5.0.4 — 2026-10-11

### 收尾提醒封死「手工流程」逃生通道（模型手改 wiki 不被记录的根因修复）

- 根因：插件注入的系统提示 reminder（index.js reminderText）写着「运行 codewiki_generate，**或手工流程** cw status → 更新命中文章 → cw index → cw meta update」，并要求「修 bug 补 learnings/」——模型读到合法逃生通道就走手改路径；插件无任何 watcher 感知手改，面板无任务、派生索引不刷新，正是「模型不调用工具编译、不被插件记录」的来源。
- 修复：reminderText 改为「收尾必须调用 codewiki_generate（scope=auto），learnings/decisions 补文章与索引刷新由流水线完成，不要手工编写/修改 .codewiki/ 下的文章（手改不进流水线、不被面板记录、会被下次编译覆盖）」，验收句改为「收尾未调用 codewiki_generate 视为任务未完成」；README updateReminder 说明与 ~/.dsh/skills/codewiki/SKILL.md（description、stale 分支、收尾清单）同步收口，并顺手把 SKILL.md 第 12 行过时的重装源码路径更新为 vendor/codewiki fork。
- 依据：流水线写文章阶段本就产出 learnings/decisions（vendor/codewiki/src/setup.rs:45-46 上游 prompt），手工补文非必需。
- 验证：test-orchestration（系统提示提醒断言组）+ test-wiki-entry + test-batch（75/0）+ test-cwd-paths + test-wiki-anchors（163/0）全部通过。
- 锚点第三轮复发（同日）：修复后收尾狗粮调用 codewiki_generate 重编译 5 篇文章，批量通道再注入 17 个幻觉锚点——0.5.0.3 守卫当场全数拦截（146 过/17 败）。逐个 grep/awk 勘定真实行号修正（concepts 实现地图 12 处 + 两篇 learning 5 处，index.js/client.js 行号基线 7a61424），守卫扩至 180 断言全过。幻觉为系统性（第二轮 10 个、第三轮 17 个），守卫测试是最后防线；流水线锚点可靠性问题留待上游（vendor/codewiki 校对阶段拦不住行号幻觉）。

## 0.5.0.3 — 2026-10-10

### wiki 行号锚点自动校验（审核教训制度化）

- 新增 test-wiki-anchors.mjs：扫描 .codewiki/**/*.md 的全部 `index.js:` / `client.js:` 锚点，做三重断言——基础（行号在源文件范围内且指向非空行）、符号绑定（同行反引号标识符必须出现在锚点行源码中，如 `createJobService` (`index.js:1042`)）、区间（起止有序且在范围内）。当前 160 断言全过；注入幻觉锚点的负向测试被正确拦截（含真实幻觉形式 `createJobService` 606）。
- 背景：流水线产物曾系统性幻觉行号（偏移 34~760 行，校对阶段拦不住，见 .codewiki/learnings/cw-binary-source-lost.md 审核补记）；本测试把「锚点必须对照真实源码核对」固化为可回归的守卫。
- FORK.md 补「构建噪音」节：cargo 的 dead_code 警告（WikiMeta.tags 未读，上游固有）记录为已知可忽略——不为消警告重编译验证过的二进制。

## 0.5.0.2 — 2026-10-10

### cw 真源码本地重建（vendor/codewiki 成为可维护 fork）+ 反斜杠 Rust 层根治

- 取证收敛：上游 main（64323823）与 vendor 快照逐字节一致；现役二进制的「仓库内 .codewiki」架构魔改面收敛到 config.rs 单点 `wiki_path()`（`repo_path.join(".codewiki")`）——init/status/meta/index/path 全部随之仓库内化，`cw projects` 保留中心枚举（与现役行为一致）。
- vendor/codewiki 重构为本地 fork：config.rs 重施魔改 + main.rs 新增 `rel_path_string()`（`/` 分隔渲染文章相对路径）替换两处 `Path::display()`——Windows 反斜杠污染 stale 清单与 `_index.md` 链接的问题在 Rust 层根治（0.5.0.1 的插件层收口保留为纵深防御）。fork 基线、构建安装、警告与行为规格文档化在 vendor/codewiki/FORK.md。
- 对比验证：探测仓库上 init/path/status（未编译态）/meta update/index/projects 与旧二进制逐字节一致；`_index.md` 与 stale 清单唯一差异 `\`→`/`（预期）；插件测试 23 断言 + 编排 117 项全过；本仓库 `cw index` 原生输出与插件规范化后的 `_index.md` 逐字节一致。
- 安装：新二进制（md5 952b0282523ad016c13688cc594afdd8）同步 bin/cw.exe 与 ~/.cargo/bin/cw.exe；丢失源码的最后产物备份为 bin/cw.exe.bak-20261010（md5 835702…，已 gitignore）。

## 0.5.0.1 — 2026-10-10

### 编译收尾自动补建 CodeWiki.md 入口（守护门控不变量闭合）

- 修复 139052c 遗留的不变量缺口：更新提醒门控收紧到 `<repo>/CodeWiki.md` 入口文件，但流水线全链路（插件 + cw CLI）从未创建它——「编译过但无入口」的仓库（如 Wxxy-CampusLogin / CampusHub，均有真实 .codewiki/ 而无入口）永远收不到收尾编译提醒，模型收尾时没有任何指向 codewiki_generate 的强信号，导致模型不调用工具编译。
- index 阶段（writtenCount>0）在 cw index / meta update 之后自动检查：仓库根缺 CodeWiki.md 则生成中/英双语入口（含 .codewiki 绝对路径、_index/_architecture/modules/concepts 指引、codewiki_generate 收尾要求与「人工改写不覆盖」声明）；已有入口绝不覆盖；生成失败只记 note 不影响任务。老仓库重编译一次即自愈。
- codewiki-nudge hook（~/.dsh/hooks/codewiki-nudge.js，仓库外全局钩子）文案补上工具名：从只列手工流程改为「收尾运行 codewiki_generate（scope=auto）更新受影响文章并随代码提交（手工流程则 cw index + cw meta update）」。
- vendor/codewiki/skills/codewiki-session.md:30 承诺的 "entry file at `<repo>/CodeWiki.md`" 至此才真正兑现。
- 测试：新增 test-wiki-entry.mjs（13 断言：生成内容/.codewiki 绝对路径/双语/已有入口不覆盖/幂等/空 cwd）；test-orchestration.mjs 117 项全过，真实编译任务 notes 出现「仓库根缺 CodeWiki.md 入口，已自动生成」实证集成生效。
- Windows 路径规范化收口：cw（Rust `Path::display()`）在 Windows 输出 `\` 分隔的文章相对路径，污染 stale 清单与 _index.md 的 `[[...]]` 链接。根治本应修 Rust 上游，但现役 cw 二进制源码（Temp/cw-src，cargo path 安装）已被清理，vendor/codewiki 是旧架构过期快照（wiki 在 `~/.codewiki/<project>`，其编译产物报 "No wiki found"，**勿从它构建安装**）。故在插件层收口：`normalizeArticlePath`/`parseStatus`（stale 与 changed 路径进插件即规范化）+ `normalizeIndexLinks`（tickIndex 在 cw index 成功后修正 _index.md 链接头，幂等、不碰正文）。test-wiki-entry.mjs 扩至 23 断言。

## 0.5.0 — 2026-10-07

### 面板信息密度改版（阶段步骤条 + 双通道吞吐 + 用量统计）

- 六阶段步骤条：任务卡以 规划→文章→横切→合成→校对→索引 六节点呈现流水线位置——已完成绿点（悬停显示各阶段耗时）、当前阶段实心点带实时计时、失败/取消在最后计时段标红/黄。服务端 `setStage` 统一收口全部阶段切换点并累计 `job.stageTimings`，`jobSummary` 新增 `stageStartedAt/stageTimings`。
- 双通道吞吐徽标：实时通道显示 tok/s + 30 点微趋势 spark（面板侧 2s 轮询滚动采样）；批量通道显示完成速率（篇/分，EWMA 平滑）与预计剩余时间（batchProgress 差分），批次尚无完成样本时显示「批量执行中 + 已排队时长」——修复实时 tps 在批量期间恒为空的断供：批量阶段改用吞吐口径，从提交即有反馈（`jobSummary` 新增 `batchSubmittedAt`）。
- 用量行：输入（提交时估算）/ 输出（响应实测）token 与请求数（批量/实时分通道计数），超 32k 档请求数红字提示 3 倍价。`parseBatchResults` 提取结果行 `usage.output_tokens`（兼容 `completion_tokens`），收尾按批次 id 防双计入账（`jobSummary` 新增 `usage`）。
- 总进度条改为六阶段加权推进（articles 0.6、review 0.15 等，阶段内按 taskList 完成数折算），不再随批次/阶段切换跨阶段回跳；封顶 99%，done 才 100%。
- 活动流：notes 多于 1 条时折叠展开全部（此前只显示最后 1 条且截 3 行）；`job.error` 首次渲染——此前服务端一直返回但面板从未显示，失败只剩一个词无从排查。
- 总览卡：仓库行显示 wiki 篇数（递归统计 `.codewiki/` 下 .md，`articleCount`）与上次编译相对时间；调度卡显示下次扫描时刻（≈ 倒计时）与上次扫描统计（扫 N 库 · 提交 M，`lastScanRepos/lastScanSubmitted`）。
- 历史卡显示总耗时；wiki 路径行加「复制路径」按钮；面板标题栏显示进行中任务计数（宿主 panellist 图标不支持角标，落位在面板头）。
- 测试：test-batch 补 `outputTokens` 提取断言（75 项）；test-orchestration 补 stageTimings/usage/batchSubmittedAt/articleCount/调度统计断言，并补齐 139052c 守护收紧后缺失的提醒用例（`.codewiki` 存在但根无 CodeWiki.md → 不注入）——该缺口是上一提交遗留的既有失败，本版修正。

## 0.4.11.2 — 2026-10-07

### 阶段实时阈值上限放宽（大仓库强制实时）

- 面板校验上限 1,000,000 → 99,999,999：大仓库（单一大源文件被多篇文章的 sources 重复引用）单阶段总输入可超百万 token，旧上限挡住了「设 999999 强制全实时」的用法——dsh-hindsight-on-demand 16 任务总估算超上限被拦回批量通道。
- zh/en 阈值提示补充：大仓库想强制全部实时，可设 99999999。

## 0.4.11.1 — 2026-10-07

### 孤儿任务接管（宿主重启僵尸任务修复）

- 修复宿主重启后旧任务永久搁置：tick 对 `owner !== instanceId` 的任务一律跳过（多实例隔离设计），但宿主重启后 instanceId 重新生成，重启前提交的任务从此无人推进——批次不轮询、进度不动、取消也失效，面板却仍显示「写文章中」。改为停更心跳接管：owner 不匹配但 `updatedAt` 停更超过 5 分钟（`DSH_CODEWIKI_ORPHAN_TAKEOVER_MS` 可调）视为孤儿，本实例接管推进并写 note 留痕；对方实例活着时每轮 tick 都会 touch（批次轮询前进），不会误抢。
- 任务卡「已写」篇数带分母：批次进行中显示「已写 0/16 篇」（分母 = 任务明细长度），不再只剩光秃秃的「已写 0 篇」。

## 0.4.11 — 2026-10-07

### 任务进度条与逐任务明细

- 批量任务中间进度透出：`settleBatch` 轮询到非终态时把百炼批次的 `request_counts`（total/completed/failed，OpenAI batch 兼容字段）经 `onProgress` 回调写进 `job.batchProgress`，任务卡与总览行实时显示「批次 n/m」进度条——此前批次提交后只能干等终态，中间毫无反馈；批次收尾后中间进度作废清空。
- `jobSummary` 新增 `taskList`：已结算条目（done/failed）在前、当前批次待办（pending）在后，进度条分母即其长度——任务卡（活动任务）逐行列出每个文章任务的状态（✓/✗/·），每篇文章各自进度一目了然。
- 总览页仓库行的 lastJob 对活动任务附带 `taskList/batchProgress/tps`：不切到任务页也能看到该工作区当前任务的进度条、批次进度与 tps。
- 修复总览行 meta 文案拼贴（「变更文件 12stale」）：两个相邻文本子节点被 React 拼在一起，改为单字符串拼接；lastJob.kind 顺带本地化（full/stale/resume → kindLabel）。

## 0.4.10 — 2026-10-06

### 端点加固与诊断（真宿主 HTTP 400 排查产物）

- `workspaceRegistry.list()` 抛错（宿主注册表内部不一致，如 order references missing workspace）时工作区过滤自动降级停用：jobs/repos 端点保持 200 可用，不再把面板整个拖成 HTTP 400——过滤是体验优化，不允许破坏基础功能。
- jobs/repos 端点包诊断 try/catch：handler 异常时响应 500 + `{error, stack}` JSON。此前宿主 webserver 对 handler reject 只回 400 空 body，异常无从排查。
- 仓库清单持久化文件支持 `DSH_CODEWIKI_REPOS_FILE` 环境变量隔离（0.4.7 的测试隔离只覆盖了 JOBS_FILE，测试与真实宿主共享 repos.json 导致 fixture 污染真宿主总览）。
- 修复 codewiki_generate 输出校验失败（`"value.jobId" must be a string`）：clean 短路等不提交路径的返回值带 `jobId: null / stage: null` 占位，宿主按 output schema 校验时 null 不是 string——改为仅在提交/幂等/续查路径赋值，不提交路径不含这两个键；编排测试新增与宿主同构的 output schema 校验断言（提交路径 + clean 短路双覆盖）。
- 修复总览/任务页 `cannot get property "list" without inject`：cordis `ctx.inject(['svc'], cb)` 的回调参数是注入了服务的 ctx 切片（服务在切片同名属性上），此前把切片当 WorkspaceRegistry 实例存下，`wr.list` 属性访问触发 cordis 严格 getter 抛错——改为 `rc?.workspaceRegistry ?? rc` 取实例并校验 list 方法，拿不到降级不过滤；测试 makeCtx 的 inject mock 同步改为切片语义（宿主同构），0.4.9/0.4.10 断言全链路重验。

## 0.4.9 — 2026-10-06

### 工作区任务过滤（hindsight 同机制）

- 任务页只显示属于已添加 dsh 工作区的任务：服务端经 `ctx.inject(['workspaceRegistry'])` 读取宿主工作区注册表（侧边栏「添加工作区」的持久化列表），任务 cwd 等于某工作区或位于其子目录内才显示（语义同 hindsight withinPath）——Temp 沙箱与任意路径任务不再出现在面板。
- 新设置「只显示工作区任务」（workspaceOnly，默认开）；宿主未注册任何工作区或老宿主无该服务时自动不过滤（降级安全）。
- 总览页（仓库列表）同样过滤：knownRepos/job 历史里的 Temp 沙箱与任意路径目录不再出现；repos 缓存键含工作区清单签名，开关或清单变化立即生效。设置开关关闭后恢复全显。

## 0.4.8 — 2026-10-06

### 仓库发现与一键排除

- 已知仓库清单（knownRepos）：提交过一次编译的工作区永久登记到独立持久化清单（与任务记录同目录），任务历史被截断或清理后，总览页仍能发现并展示这些工作区——hindsight recentWorkspaces 同思路。旧任务历史在服务启动时一次性灌入清单。
- 总览页每个仓库行新增「排除 / 取消排除」按钮：直接改插件配置 excludePaths（与设置卡保存同一条 configForms 链路，持久化并热生效），不再需要手动填路径清单；排除后自动刷新总览状态。
- control 新增 refresh 动作：让仓库总览的 30s 缓存立即失效（排除操作后自动调用）。
- 总览扫描源合并任务历史与 knownRepos 清单（路径规范化去重，任务历史形态优先）。

## 0.4.7 — 2026-10-06

### 排除清单 + 自动更新 + 仓库总览与标签页

- 排除清单（excludePaths）：换行/分号/逗号分隔的绝对路径列表，命中的目录（含子目录）不编译 CodeWiki——工具调用与自动扫描都会拒绝并提示；面板「设置」页可编辑。
- 自动更新（autoUpdate，默认关）：开启后服务每分钟自检，距上次扫描超过扫描间隔（autoUpdateMin，默认 30 分钟，最小 5）时对所有历史工作区逐仓 scope=auto 增量编译（被排除目录跳过），单仓失败记入调度信息不中断。
- 面板改三标签页（总览/任务/设置）：「总览」页轮询 /api/codewiki/repos 展示所有编译过的工作区——每仓 wiki 状态（最新/有变更/未编译/未初始化/出错/已排除）、过期文章数与变更文件数、最近一次任务摘要，有变更的仓库可直接点「更新」立即编译；顶部调度卡显示自动更新开关状态、扫描间隔、上次扫描时间与最近错误。
- 新端点：GET /api/codewiki/repos（30s 缓存，逐仓 cw status 判态）；control 动作新增 compile（指定 cwd 立即编译，供总览页按钮与外部自动化调用）。
- jobSummary 增加 auto 字段区分自动扫描触发的任务。

## 0.4.6 — 2026-10-06

### 面板收敛 + 实时 tps + Temp 残留自动清理

- 面板默认只显示一张焦点卡片（活动任务优先，无活动则最近更新的任务），其余任务收进「历史任务 (N)」折叠区，展开后保留按工作区分组视图。
- 焦点卡片显示实时 tps：实时通道每任务上报输出 token 数与耗时，取最近 20 个样本聚合（总 token / 总毫秒）；批量阶段无样本不显示。
- 服务启动自动清理系统临时目录（Temp）下已终态（完成/失败/取消）的调试残留任务，活动任务与工作区任务保留——不再需要手工取消清理。
- 健壮性：note() 对磁盘残留的缺字段 job 防御性补齐 notes，畸形任务不再崩掉服务 tick。

## 0.4.5 — 2026-10-06

### 阶段实时阈值（混合通道）

- 新增设置「阶段实时阈值」（batchMinTokens，默认 30000，0=全走批量）：服务在提交每个阶段前估算全部任务输入 token，低于阈值时改走百炼实时对话接口（/chat/completions）按 maxConcurrency 并发执行——免批量排队等待，小阶段（规划、少量续查/增量）明显提速；达到阈值仍提交批量任务（实时价 5 折），单阶段决策并在任务 notes 留痕。
- 实时结果与批量结果同构收割：keepInMemory 任务（横切）内容经 frontmatter 校验落盘；断点/取消/续查语义不变。
- 面板设置卡新增阈值输入框（0–1000000 整数校验，实时生效）。

## 0.4.4 — 2026-10-06

### 侧边栏面板完善（真实环境反馈）

- 面板可滚动：根容器 `height:100%; overflow-y:auto`，任务多时不再溢出裁切。
- 任务按工作区（cwd）分组显示，组头显示仓库名（悬停见完整路径），组内最新在前。
- 进行中卡片强化：brand 色高亮边框 + 阶段徽章呼吸动画 + 实时已耗时（mm:ss）+ 文章进度 `已写 X/Y 篇`（取 articles 数组 ok 计数/总数）。
- 设置参数移入面板：面板头部「设置」按钮展开插件设置表单（复用 CodewikiCard，configForms 热生效），插件页卡片保留。
- 百炼 API Key 密码遮蔽：输入框 `type="password"`，不再明文显示。

## 0.4.3 — 2026-10-06

### 审查修复：取消可靠性、多实例安全、断点保真

审查（bb72b2c..675d51f）发现的问题全部修复：

- **取消标记跨实例丢失（根因修复）**——`codewiki_generate` 工具的 execute 闭包原引用模块级 `jobServiceRef`（每次 apply 覆盖），多插件实例并存时（插件重载/测试重复 apply）提交与取消/面板端点会打到不同 service 实例：A 实例 cancel 落盘的 cancelRequested 在几 ms 内被 B 实例 tick 的内存副本整写覆盖，取消永远不生效。修复：service 作为参数注入工具定义，execute 闭包绑定自己 apply 创建的实例；模块级引用删除。
- **生命周期**——`ctx.effect(() => () => service.stop())`（此前写成 `() => service.stop()` 会在启动时当场停掉服务）。
- **多实例写盘安全**——job 带 `owner`（创建实例 id），tick 只推进自家 job；flush 脏标记（无变更不整写）+ `mergeFromDisk` 磁盘吸收（同 id 磁盘更新且非本实例现场才替换）；tick 进程级 `JOBS_FILE.lock` 串行；每轮 tick 开头从磁盘跨实例拾取 cancelRequested；cancel/list 先 mergeFromDisk。
- **凭证窗口重复提交**——submit 占位先行（stage=submitting、无凭证即落盘），resolveBatchApiKey 失败则 fail+落盘后抛错；tick 跳过 submitting。
- **断点保真**——批次断点文件记录 `stage`/`crosscutSplit`/任务清单，resume 按原阶段恢复（0.3.x 旧断点无 stage 回退 articles）。
- **jobs 端点**——jobSummary 补 `cancelRequested` 字段（面板取消按钮状态）。
- **横切/校对批次异常信息**——非终态时读 errors 数组（此前只读 error.message，错误被吞）。
- **localReview 文件丢失回退**——降级时 writtenCount-- 不再虚报已写篇数。
- **tickCompose 无断点**——上次进程中断于提交后落盘前时写 note 留痕再跳过。
- **面板**——effect 返回 disposer（slots 注入可卸载）、style 防重复插入、轮询防重入+卸载守卫、加载态词典 loadingLabel（此前显示「已保存」）。
- 文案：cw 工具描述改「后台批量流水线服务」；服务注释同步 0.4.x 行为。

测试：test-orchestration 新增「断点 stage 字段」「并发提交占位与 flush 磁盘合并」块，取消块断言补齐（终态 cancelled + 断点保留 note）；test-batch 74 通过；test-cwd-paths 通过。

## 0.4.2 — 2026-10-06

### 超大任务升 256k 档（3 倍价）继续走批量

- 单文件超 28k 预算的任务不再直接实时兑底/跳过校对：先升 `BATCH_TOKEN_HARD_LIMIT`（200k，256k 档内留余量）重装继续走批量——百炼按请求实际输入 token 自动分档计价，无需 API 参数，批量仍 5 折（$0.05/M，仍比实时兑底便宜一半）。单文件连 200k 大档都装不下才回退实时兑底（文章任务）/跳过校对。
- 校对动态预算同理：剩余预算装不下先升大档重装，长文章不再整篇跳过校对。
- 提交时统计输入超 32k 档的请求数写入 notes（「N 个请求输入超 32k 档，按 3 倍价计费」），费用可预期。
- 测试：test-batch 大文件断言更新（86k→升大档批量、新增 234k→实时兑底）；编排测试 bigArticle 提到 3 万字并断言 3 倍价明示。

## 0.4.1 — 2026-10-06

### 横切精准拆分（map-reduce）+ 校对动态预算

- **横切 map-reduce**（用户请求：不要把所有代码堆进一个任务，精准拆小靠并发提速）：模块文章原始总量超 `BATCH_TOKEN_BUDGET`（28k）时，横切不再把截头 pack 塞进单任务，而是每篇模块文章一个「架构观察」任务（`obs0..n`，输入=单篇全文，并发跑批量），settle 后拼观察 pack 提交合成批（arch/patterns/concepts 输入=观察，体积小、永不超限）；阶段机新增 `compose`（面板文案「合成中/Composing」）。总量装得下（小仓库）保持单批直出，零拆分开销。新增 `batchObservePrompt`；观察批不走 tally（不写盘不计数），`crosscutTasks` 抽出供单批/合成批共用。拆分判定必须用原始总量——`packArticles` 只截后续文章头部，pack 体积永远装得下。
- **校对动态预算**：源码装填改用「`BATCH_TOKEN_BUDGET` − 文章 token」的剩余预算（装不下首个源文件才跳过校对）——原实现先按整预算装满再判总和，文章一长整篇跳过校对。
- 测试：`test-orchestration.mjs` mock 暴露 uploaded、新增 obs 应答与 bigArticle 选项；新增「大 wiki 横切精准拆分」块（每篇 2 万汉字 ×2 触发拆分：断言观察输入单篇、合成批不含原文、横切照常落盘、校对动态预算回写）。

## 0.4.0 — 2026-10-06

### 服务化全批量流水线：零子代理 + 侧边栏面板 + 32k 分块并行

- **编译不再依赖子代理，改为宿主常驻服务驱动**（用户请求：生成 codewiki 不靠子代理，模型调用工具后自动开始生成）：`codewiki_generate` 改为纯提交制——normalizeCwd、cw status 判态、规划/文章/横切/校对任务预构建后交给 `createJobService` 即返回 `{submitted, jobId, stage}`；服务 tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调）推进阶段机 plan→articles→crosscut→review→index，收尾 `cw index`+`meta update`。job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（saveJobs 只剥 apiKey，cancelRequested 跨 tick 存活）；多实例并发以脏标记防互相覆盖（persist 置脏、tick 末 flush，submit/cancel 先落盘再异步 tick）。工具路径零 LLM 调用、零子代理派发；测试 `test-orchestration.mjs` 全文重写为提交制 + mock 百炼批量 API + 轮询 jobs.json 等终态。
- **五个环节全部走百炼批量推理**（原 0.3.0 只写文章环节）：规划、横切文章、审校均新增批量任务模板（JSONL 单轮生成；横切/校对产物 keepInMemory，由服务落盘/回写）；仅超预算单文件（>BATCH_TOKEN_BUDGET 或源码过大）回退实时兑底 `runRealtimeTasks`（并发池硬顶 8，结果与批量同构）。
- **32k 输入分块吃满低价档**（qwen3.7-flash 输入 ≤32k 档 $0.03/M、批量再 5 折）：`BATCH_LINE_BUDGET 800KB → BATCH_TOKEN_BUDGET 28000`（estimateTokens：CJK≈1/字、ASCII≈3.5 字符/token，留 4k 余量）；`collectSources`/`prepareArticleTasks` 按 token 预算装填，模块/概念源码超预算自动拆多任务，断点/收尾语义不变。
- **hindsight 式侧边栏面板**（用户请求：和 dsh-hindsight-on-demand 一样的插件显示）：client.js 重写——`main` + `sidebar.panellist` 双 slot（key/id='codewiki'，order 52），2s 轮询 `GET /api/codewiki/jobs`，任务卡显示仓库名/类型（全量/增量/续查）/阶段（中文）/已写篇数/最近 notes/wiki 路径，活动任务可取消（`POST /api/codewiki/control {action:'cancel'}`，断点保留可续查）；端点仅回环放行、payload 不含 apiKey。设置卡删除子代理机器（编译模型级联/模型目录轮询/batchEnabled/batchAsync/batchWaitMinutes 全删——批量已是唯一路径），仅留 enabled/updateReminder/maxConcurrency（实时兑底）/articleLanguage/binaryPath/batchApiKey/batchModel/batchThinkingBudget。
- **提交制入口语义**：missing/stale 态判给服务端做（cw status 变慢不再是主模型等待）；取消幂等；孤儿断点（0.3.x 遗留 checkpoint）发现即并入 resume job 自动收尾；无凭证诚实报错「未找到百炼 API Key」不再回退子代理。
- fix：`writeValidated` 对 keepInMemory 任务直接写盘（原委托 applyTaskResult 导致横切/校对产物全部丢失）；`touch` 标脏（取消终态原先进不了 jobs.json）。
- test：test-batch.mjs 重写（73 断言：token 预算/分块/断点/实时兑底/keepInMemory）；test-orchestration.mjs 重写（提交制全流程/stale 直达 articles/孤儿续查/端点+取消+403+404/无凭证/严格 cordis 不碰未 inject 服务）；test-cwd-paths.mjs 不变全 PASS。

## 0.3.2 — 2026-10-04

### 批量推理异步化：提交即返回，宿主后台链自动收尾

- 动机：批量推理就地等待（默认 20 分钟，批次最长 24h）会把主模型挂起干等；用户要求「使用两层子代理……主模型无需一直等待」。落地为两层：主模型提交批次后立即返回；宿主内后台收尾链（代码实现，零 LLM 成本）等待批次、落盘、派发横切/审校子代理、刷新索引。横切/审校子代理模型走插件默认路由（设置 defaultModel 可换 `qwen3.7-flash`）。
- 新设置 `batchAsync`（默认 true，volatile）：关闭则回退旧的就地等待行为。
- 位置：`runBatchTasks` 增 `background` 模式（提交即返回 `{submitted, prepared}`）；execute 内 `backgroundFinalize` 闭包——不绑 exec.signal（主调用返回后等待继续），轮询 10s→60s（上限 24h）→ `settleBatch` 落盘 → 派发「横切文章（批量后台）」「审校（批量后台）」子代理 → cw index/meta update，结果以 `[dsh-codewiki]` 前缀写 console；断点机制不变（宿主关闭则下次调用自动续查）。异步模式下续查遇批次未终态不再抛错，直接返回并说明后台跟进中。
- 测试：test-batch.mjs 增 background 节（提交后不再轮询、prepared 带 customId/batchPrompt、断点写入）；test-orchestration.mjs 增异步集成节（主调用立即返回 0 篇、1.5s 后后台链落盘并派发横切/审校、断点清理），原就地集成节显式 `batchAsync:false` 保留覆盖。

## 0.3.1 — 2026-10-04


- feat：**批量推理凭证自动取模型设置「阿里百炼云」渠道**（用户请求：直接使用模型设置中的阿里百炼云）：`batchApiKey` 留空时经宿主凭据库解析——`ctx.inject(['credentials'])` → `resolve('ALIYUN_BAILIAN_API_KEY')`（`resolveBatchApiKey`，index.js:421），与模型适配器同一份凭证（继承 env > 凭据库 > .env）；显式填写 `batchApiKey` 则覆盖。取不到凭证仍回退智能体子代理。宿主上下文在 `apply` 时捕获；解析链 3s 超时防服务缺失挂起。
- test：`test-batch.mjs` 增 `resolveBatchApiKey` 解析链 7 断言（显式优先/无上下文/数组形态/条目缺失/inject 抛错）；`test-orchestration.mjs` 批量集成节改走凭据库路径（`batchApiKey` 留空 + mock credentials 服务），新增 notes「凭证来源 credentials(file)」断言。三套测试全 PASS。

## 0.3.0 — 2026-10-04

- feat：**写文章环节可改走阿里云百炼批量推理（Batch File，实时价 50%）**（用户请求：用批量推理给 code wiki 编译降本）：
  - 只把「写文章」环节（成本大头、单轮文本生成）转批量：插件内联源码 → JSONL 上传百炼 → 轮询批次 → 插件落盘；规划/横切/审校仍走智能体子代理（多轮工具调用，批量通道不适用）。默认关闭；`batchApiKey` 留空自动回退智能体子代理，默认行为零变化。
  - 新设置（全部 volatile 热生效）：`batchEnabled`（默认 false）/ `batchApiKey`（DashScope Key）/ `batchModel`（默认 `qwen3.7-flash`；仅华北2 支持，须用别名——快照版不支持批量）/ `batchThinkingBudget`（默认 0=关思考，省输出 Token；1–32768=开思考并限预算）/ `batchWaitMinutes`（默认 20，就地轮询等待）。
  - 思考参数按百炼官方 JSONL 规范放 `body` 顶层与 `model` 同级（`enable_thinking`/`thinking_budget`，extra_body 无效）；单行预算 800KB（百炼上限 1MB），整文件粒度装填、超限任务回退智能体子代理而非丢弃。
  - 断点续跑：批次未收尾时断点存 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`——超时/中止保留，下次 `codewiki_generate` 调用先续查收尾（含 cw index/meta update）再谈新任务，24h 窗口内不丢工作。
  - 结果对账：结果文件行（status_code）+ 错误文件行（message）合并为逐篇成败与原因；仅成功文章落盘，失败记账不中断。
  - 位置：index.js 批量推理模块（`collectSources`/`buildBatchJsonl`/`parseBatchResults`/`settleBatch`/`runBatchTasks`，导出供测试）；`generateToolDefinition` 两条写文章路径（stale 逐篇、全量模块）改走统一出口 `runArticleTasks`（批量或智能体分批）。
- feat：**写文章并发上限放宽到 8**（用户请求）：`CONCURRENCY_HARD_CAP` 2→8，默认值随硬顶=8；schema/设置页校验与提示、CodeWiki.md 同步。原红线 2 为早期保守值，写文章子代理是独立短任务，8 并发配合批量/子代理路由无相互干扰。
- test：新增 `test-batch.mjs`（35 断言）：buildBatchJsonl 思考参数位置与取值、parseBatchResults 结果/错误/坏行、collectSources 装填与预算边界、mock fetch 全流程（提交→轮询→收尾→落盘→删断点）、超预算 oversized 回退、超时保留断点、断点续查收尾。`test-orchestration.mjs`（默认智能体路径回归）与 `test-cwd-paths.mjs` 全 PASS。

## 0.2.8 — 2026-10-03

- feat：**写文章子代理活动行 label 带模型前缀**（用户实测报告「活动行看不出子代理用什么模型」）：
  - `launchAgent` 统一给 label 加 `[<model>] ` 前缀（如 `[qwen3.8-flash] codewiki:更新 xxx`）：显式 route（调用参数或插件默认）直接用其 model；继承会话模型时经 `parentRouteOf`（鸭子类型：`agent.session.requestHeader()?.config` 优先 → `agent.options` 兜底，异常返回 undefined）解析真实模型名，解析不出则不加前缀（不编造）。model-only 前缀是因为活动行标题截断早（约 28 字符），provider/model 全称会把文章名挤没；provider 差异靠结果 notes 已有的全称汇总兜底。
  - 位置在 `launchAgent` 汇聚点（6 个调用点零改动）；记账/notes 仍用原始 label，仅活动行显示前缀。
- test：mock 子代理按 label 路由改子串匹配（startsWith → includes + split，label 现可带前缀）；新增断言「全量路径全部 spawn 的活动行 label 带模型前缀」。

## 0.2.7 — 2026-10-03

- fix：**插件整体未装载（两个工具全部消失）**——0.2.5 引入的回归，用户实测报告「没有安装上」：
  - 根因：`installUpdateReminder` 里 `ctx.agents?.list()` 直接访问插件 ctx 上的 `agents` 服务属性。真实 cordis 对未声明 inject 的服务属性，**访问本身即抛**（`Error: cannot get property "agents" without inject`，`typeof` 守卫无效），`apply` 同步崩溃 → fiber FAILED → cordis 回滚该 fiber 全部效果 → `cw` 与 `codewiki_generate` 从未注册。0.2.5 之前无此代码故正常；mock 测试里 `.agents` 是普通对象，测不出 cordis 严格语义。
  - 修复：存量代理改经 `ctx.inject(['agents'], cb)` 枚举（服务缺失静默跳过；参照 `packages/context/file-reference-local/src/index.ts:45` `static inject = ['agents']`），新会话仍走 `agent/created`。
  - 定位手段：用 CLI 自家 `runProfile` 做隔离子进程真启动（overlay 补丁禁用 webserver/billion-context 避免端口冲突），启动审计显示 codewiki `fiberState: 3（FAILED）`；修复后同法重跑，失败清单中 codewiki 消失＝激活成功。
- test：`test-orchestration.mjs` 新增 3 项「严格 cordis 语义」断言（未 inject 的服务属性以 getter 抛错模拟真实 cordis；apply 不抛错、两工具仍注册、agent/created 已布线）——先 RED（报错与守护进程逐字一致）后 GREEN；`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.6 — 2026-10-03

- feat：**设置页支持选择子代理思考程度**（用户请求）：
  - 新设置 `defaultReasoningEffort`（默认空=跟随所选模型默认，volatile 热生效）；`codewiki_generate` 新增调用参数 `reasoningEffort`（优先于插件默认，与 provider/model 同级）。effort 是 adapter 自有的不透明值（deepseek 适配器为 off/low/high/max），插件不硬编码枚举。
  - 路由流：`launchAgent` 的 `agentOptions` 改为只从 route 里真实存在的字段构建——provider+model 成对才设、reasoningEffort 有值才设。修复隐患：effort-only route（provider/model 留空继承会话模型、只调 effort）时旧代码会写出 `{provider:undefined,model:undefined}` 覆盖继承的父路由。
  - 设置页（client.js）「编译模型」区新增「思考程度」：下拉选项来自 `modelCatalog()` 对当前 provider+model 广播的 `reasoning.efforts`（含名称），随 provider/model 级联；目录无该模型或无档位时退文本输入（可手输 adapter 自有值）；当前值不在档位里时保留显示。zh/en 双语提示同步。
  - notes 现在会注明思考程度：`子代理模型：p/m（插件默认配置，思考程度 low）`。
- test：`test-orchestration.mjs` 新增 2 项断言（全量路径全部 spawn 携带 `defaultReasoningEffort=low`；stale 调用参数 `reasoningEffort=max` 覆盖插件默认）——先 RED 后实现全 PASS；顺带暴露并修复 liveConfig 白名单漏掉新键的问题。`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.5 — 2026-10-03

- feat：**wiki 维护提醒注入会话系统提示**（用户请求：提醒模型在改动完成后更新 codewiki）：
  - `apply` 新增 `installUpdateReminder`：`agent/created` 时在 agent 作用域注册系统提示 section `codewiki:update-reminder`（order = TOOL_REPORT+1，工具报告之后）。text 回调每次组装求值——`updateReminder=false`、会话无仓库或仓库无 `.codewiki/` 时返回空字符串（renderPrompt 丢弃空 section，零噪音），否则注入 4 行收尾提醒：`codewiki_generate`（scope=auto）或手工 `cw status`→更新→`cw index`→`cw meta update`、修 bug 补 `learnings/`、决策补 `decisions/`、wiki 与代码同提交。
  - 新设置 `updateReminder`（默认开，volatile 热生效）；设置页（client.js zh/en）运行区新增开关；profile patch 注释同步。
  - 注入按 agent 作用域安装，section 随 agent 处置自动销毁；已知子代理会话不受影响（提醒只装在宿主会话 agent 上，由 agent/created 事件对象形状决定）。
- test：`test-orchestration.mjs` 新增 5 项断言（agent/created 注册 section、section 名、有 `.codewiki` 时文本非空含 codewiki、无 `.codewiki` 时空文本、`updateReminder=false` 时空文本）——先 RED 后实现，全 PASS；`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.4 — 2026-10-03

- fix：**子代理模型路由在两条编排路径上被静默丢弃**（用户实测报告：指定/默认模型被「路由冲突」覆盖成继承模型；实际与路由插件无关）：
  - 根因：`launchAgent` 从 task 解构 `route` 再设置 `payload.agentOptions`，但 6 处 task 构造中有 2 处漏传 `route`——① stale/auto 逐篇更新（`codewiki:更新 …`）② 全量编译的模块文章（`codewiki:模块 …`）。task.route=undefined → `if (route)` 不触发 → 子代理继承父会话模型（含 reasoningEffort）。规划/降级/横切/审校 4 处显式传参未受影响；notes 的「子代理模型：…（插件默认配置）」独立于 task 计算，照样显示——声称与实际不符。
  - 修复：两处 task 构造补上 `route,`；全量与逐篇两条路径的所有 spawn 调用现在都携带 agentOptions。
  - 排查记录：核心链路（subagents.start → spawn provider → resolveChildAgentOptions → agent-loop prepareRequest）checkout 与运行时（app.asar 解包比对）逐字一致且全部正确；子会话 `request/header` 的 effort 被保留、0 次指定路由尝试，是把嫌疑收敛回插件编排层的关键证据。
- test：`test-orchestration.mjs` 补 3 项断言（规划 agent 之外）：模块文章 agent 携带 agentOptions、全量路径全部 spawn 调用携带 agentOptions、逐篇更新 agent 携带 agentOptions。修复前 RED（精确复现 3 项缺失），修复后全 PASS；`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.3 — 2026-10-03

- fix：三个路径/描述缺陷（用户实测报告，Wxxy-CampusLogin 仓库复现）：
  - **MSYS 路径被误判不存在**：win32 上 `/e/...` 形式 Node fs 不认，`existsSync` 失败直接抛「cwd 不存在」。新增 `normalizeCwd`（仅 win32 把 `/x/...` → `X:/...`，POSIX 原样），cw 与 codewiki_generate 两工具 cwd 校验统一接入。
  - **Windows 路径校验通过但结果错**：`resolveBinary` 原先捆绑二进制优先，`bin/cw.exe` 是旧布局（`~/.codewiki`）版本，导致 bash 原生 `cw status` 正常而包装层报 "No wiki found"。改为 binaryPath → PATH 探测（win32 `where` / POSIX `which`）→ 捆绑兜底；捆绑副本同步刷新为当前源码构建（sha256 953adcb5…，与 `~/.cargo/bin/cw.exe` 一致）。
  - **工具描述与实现不符**：描述/wikiPathFor 兜底从 `~/.codewiki/<project>/` 全部对齐上游 `wiki_path()` 的 `<repo>/.codewiki/`（随仓库提交共享）；`projects` 子命令说明改为「只列出 ~/.codewiki 旧位置的项目，一般用不到」。
- test：新增 `test-cwd-paths.mjs`（import 真实 index.js，mock ctx 注册捕获，MSYS / Windows / 不存在路径三态实测）——MSYS 归一化后 `cw path` 返回 `<repo>/.codewiki`、Windows 路径 `cw status` 返回真实三态、非法路径干净报错，ALL PASS。
- 文档：README / CodeWiki.md / client.js（zh+en）/ cordis.patch.yml 同步仓库内 wiki 位置与 PATH 优先顺序。

## 0.2.2 — 2026-10-02

- fix：审查修复 8 项（test-orchestration.mjs 先行 RED：clean + scope=full 强制全量被短路）：
  - `scope=full` 在 clean 态不再被「无需编译」短路，强制全量重编与文档一致；
  - `cw status` 非零退出且无输出时直接抛错（此前二进制缺失/崩溃会被兜底成 stale 空清单白走全量）；
  - 横切文章失败计入 `failedCount`（与 stale / 降级路径口径一致）；
  - `runCw` 响应 `exec.signal`（abort 即 SIGKILL 子进程），cw / codewiki_generate 的全部子进程调用接入；
  - `cw index` / `cw meta update` 失败时 notes 追加「编译基线可能未刷新，可重试」告警；
  - 移除 execute 末尾不可达死代码；
  - 设置页：保存条在 dirty 时不显示「放弃更改」文案 Tag（按钮 disabled 态已表达）；
  - 文档同步：README / CodeWiki 中子代理派发写法与 0.2.1 实现一致（直用注入服务）。
- test：新增「clean + scope=full 强制全量」编排用例；修复前 RED，修复后全 PASS。

## 0.2.1 — 2026-10-02

- fix：子代理服务两处接线断裂，codewiki_generate 一进编译路径即抛错，0.1.0 起从未真正可用（当时验证只做了 node --check 与 CLI 冒烟，没跑过编排路径）：
  - `generateToolDefinition(cfg)` 没接住 `apply()` 传入的 `subagents`（index.js:685 → 432），execute 内 6 处引用即抛 `ReferenceError: subagents is not defined`；
  - `launchAgent(rc, …)` 实际收到的是子代理服务本身，却按 `rc.subagents.start` 取用（index.js:118），前一处修完后又抛 `TypeError: Cannot read properties of undefined (reading 'start')`。
  - 两处均改为直接使用传入的 `subagents` 服务。
- test：新增 `test-orchestration.mjs` 编排行为冒烟（mock 子代理服务 + 真实 cw CLI）：覆盖全量编译（规划→分批写文章→横切→审校→index/meta update）与 stale 逐篇更新两条路径。修复前 RED（精确复现 ReferenceError@598），修复后 PASS。

## 0.2.0 — 2026-10-01

- 新增插件页设置 UI（`client.js`，浏览器半侧）：插件管理页 Official 组出现 **CodeWiki** 条目（`plugins.item`，id `codewiki`，order 30），点进详情页可设置：
  - **编译模型**：provider/model 级联下拉（目录来自 `ctx.remote.session.modelCatalog()`，4s×3 退避重试 + `llm/adapters-updated` / `connection/reset` 刷新；目录不可用退化为文本输入）。
  - **运行**：启用开关、写文章并发上限（1–2 校验）、文章语言、cw 可执行路径。
  - 保存经 `configForms.mutate` 单层 op（revision CAS），脏检测 + 放弃更改 + 冲突提示；与 patch 文件手改等价，均热生效。
- `package.json`：加 `exports["./client"]` + `dsh.client.platform: "web"`——宿主 client 扫描器沿 file:/// 挂载条目发现本包（无需 profile link）；「非 client 包」判定按条目缓存，**生效需重启 dsh**。
- 注册形状对齐已装插件实证：`locale.bind/register`（词典值全字符串）、`slots.inject('plugins.item', …)` 包 `configForms.whileServed([NS], …)`、React `el()` + dsh-client-ui-primitives（Switch/Button/Input/Pill/StateDot/Tag）。
- 静态验证：`node --check client.js` / `index.js` 通过；`package.json` 解析校验通过（exports + dsh.client 齐全）。设置页 UI 需重启后在插件页实测。

## 0.1.1 — 2026-10-01

- 移除 `codewiki` 技能（skills/codewiki.md 与 skillProvider 注册一并删除）：保留纯工具面（`cw` + `codewiki_generate`），wiki 编译一律走工具。
- `defaultProvider`/`defaultModel` 默认值从空改为 `aliyun-bailian`/`qwen3.8-flash`（即路由插件 wiki 档）：不传参时子代理固定走便宜模型；显式置空两项才继承会话模型。

## 0.1.0 — 2026-10-01

首次发布。

- 工具 `cw`：CodeWiki CLI 薄封装（子命令白名单：init/status/index/meta/path/projects/setup/uninstall；120s 超时）。
- 工具 `codewiki_generate`：智能体编排编译（规划 → 分批写文章 ≤2 并发 → 横切 → 审校 → index + meta update），支持 provider+model 指定子代理模型、scope auto/full/stale、规划失败降级单 agent、部分失败不刷新基线。
- 技能 `codewiki`：上游 codewiki-session.md 的 DSH 适配版。
- vendor 上游 codewiki（mraza007/codewiki @ HEAD，MIT），cargo release 编译出 `bin/cw.exe`。
- 挂载：profile cordis.patch.yml file:/// 直挂（id `codewiki`）；`@deepseek-ai/schemastery` 本地 junction → harness vendor。

验证记录（2026-10-01）：

- `node --check index.js` 通过；`import(index.js)` 通过（name/apply/Config 导出齐全）。
- CLI 冒烟（/tmp/cw-smoke 临时 git 仓库）：`cw init` / `path` / `projects` / `status` 三态（No wiki found → has not been compiled → up to date）/ `index`（2 articles）/ `meta update` / 提交后 stale 判定（`Changed since last compile` + `M src/app.py` + `Stale articles: ! modules\app.md`）全部符合预期；注意 stale 文章路径是反斜杠，插件侧已归一。
- 挂载生效需重启 dsh（CWD 配置热读取，但插件注册本身不热加载）。
