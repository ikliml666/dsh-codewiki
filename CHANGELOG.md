# Changelog

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
