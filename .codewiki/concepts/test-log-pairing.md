---
title: test-log-pairing
type: concept
source_files:
  - test-orchestration.mjs
  - index.js
  - .tmp-test-orchestration.log
  - README.md
  - CHANGELOG.md
tags: [测试, 日志, 配对, 端到端, codewiki, 跨模块]
---

## Overview

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，测试脚本（`test-orchestration.mjs`）、运行时实现（`index.js`）、运行日志（`.tmp-test-orchestration.log`）与项目文档（`CHANGELOG.md`、`README.md`）之间通过行号引用与断言结果形成的配对与相互印证关系。该概念并非单一代码实体，而是验证体系的数据/控制流闭环：测试代码以 mock 宿主 llm 服务 + 真实 cw CLI + 真实服务 tick 驱动插件逻辑、产生日志、断言内存状态与落盘产物，并把断言规模与失败项固化到文档。

当前代码基线（0.10.9）下，`test-orchestration.mjs` 验证的是：`codewiki_generate` 提交制 + 服务阶段机（articles→crosscut→review→index，0.10.7 起无规划阶段，模块清单由 `localPlan` 按顶层目录分组生成）、大档单请求优先与观察→合成分割（0.10.8）、批量校对（0.10.8）、单项目串行（0.10.0）、编译产物自动提交 `autoCommitWiki`（0.10.9）、宿主重启按 prompt 快照重跑（0.6.0）与面板端点/取消。`CHANGELOG.md` 已记录至 0.10.9，`README.md` 与之同步。`.tmp-test-orchestration.log` 则是更早版本（0.8.4–0.8.6 时代，证据见 Flow 第 3 步）一轮运行的留档快照：其 2 项 ✗（source 标记旧形态）已被 0.8.5 的 source 改形根治，其余段落与当前测试源码存在系统性的块名/阶段名/文案错位——log 是时间点快照而非当前源码的实时投影，这一错位本身就是本概念要记录的配对事实。

## Involved Modules

- **orchestration-tests**（`test-orchestration.mjs`）：配对关系的产生地。断言机制 `check(cond, msg)`（`test-orchestration.mjs:23-27`）把代码预期绑定到日志 ✓/✗ 行，收尾汇总 PASS/FAIL 并以退出码上抛（`test-orchestration.mjs:23-24`）。mock 三件套：`makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（`test-orchestration.mjs:40-80`，`inject` 支持 cordis 切片回调与 promise 双风格 `test-orchestration.mjs:58-68`、`effect` 真实语义 `test-orchestration.mjs:73-77`）、`makeMockAgent`（`test-orchestration.mjs:83-97`）、`makeFixtureRepo`（`test-orchestration.mjs:99-116`，顶层 core/util 两目录由 localPlan 分组直接决定模块名）。模型通道 mock：`activeLlm`/`llmProxy` 唯一转发（`test-orchestration.mjs:121-129`）与 `makeBatchMock`（`test-orchestration.mjs:134-198`，`answerFor` 按 prompt 首行特征分发，审校员按 0.10.8 `@@@article` 标记逐篇回写 `test-orchestration.mjs:23-36`）。`waitJob`（`test-orchestration.mjs:23-37`）轮询 JOBS_FILE 等终态；`fakeReq`/`fakeRes`（`test-orchestration.mjs:216-228`）直调面板 handler。测试块自 `test-orchestration.mjs:23` 起按分节注释编排，覆盖系统提醒、注册/cw、codewiki_update+commitHintText、autoCommitWiki、wakeCompileSession、本地规划、全量阶段机、大 wiki 拆分、文章分割、串行、唯一通道、stale、progress、重启重跑、并发占位、面板端点、排除清单、knownRepos、工作区过滤、registry 降级、schema 校验、孤儿接管、模型缺失报错、严格 cordis、Temp 清理（各块行号见 Implementation Map）。
- **plugin-runtime**（`index.js`）：被测实现载体。`name='dsh-codewiki'`（`index.js:48-49`）、常量组（`index.js:48-59`）、`Config`（`index.js:48-68`，含 0.10.9 新增 `autoCommit` `index.js:63`）、`liveConfig`（`index.js:74-99`）；唯一模型通道 `llmChat`（`index.js:285-304`，`createUserMessage` 带 `source:{kind:'plugin:codewiki'}` `index.js:291`）；并发池 `runRealtimeTasks`（`index.js:329-358`）；装填层 `estimateTokens`（`index.js:269-277`）/`numberLines`（`index.js:387-389`）/`collectSources`（`index.js:486-513`）/`prepareArticleTasks`（`index.js:557-642`）；行号锚点兜底 `fixAnchors`（`index.js:398-481`）；prompt 模板群（`index.js:48-75`、`index.js:48-283`，0.10.8 批量校对 `batchProofreadBatchPrompt` `index.js:856-883`）；编排服务 `createJobService`（`index.js:1218-2203`，阶段机 `STAGE_HANDLER` `index.js:2024-2030` 无 plan）；工具四件 `cw`（`index.js:48-111`）/`codewiki_generate`（`index.js:48-198`）/`codewiki_update`（`index.js:48-100`）/`codewiki_progress`（`index.js:48-149`）；面板后端 `installWebServer`（`index.js:2646-2875`）；0.10.9 的 `autoCommitWiki`（`index.js:2904-2945`）与降级提醒 `commitHintText`（`index.js:2947-2976`）；系统提示提醒注入 `installUpdateReminder`（`index.js:2989-3021`）；终态唤醒 `wakeCompileSession`（`index.js:1202-1216`）；入口 `apply`（`index.js:3023-3081`）。
- **project-docs**（`CHANGELOG.md`、`README.md`）：配对结果固化层。`CHANGELOG.md` 按版本存证每轮改动的测试断言数与验证结论（0.10.9 `CHANGELOG.md:3-17`、0.10.8 `CHANGELOG.md:19-31`、0.10.7 `CHANGELOG.md:33-42`、0.10.4 `CHANGELOG.md:66-92`、0.10.1 `CHANGELOG.md:117-129`、0.10.0 `CHANGELOG.md:131-144`、0.8.5 `CHANGELOG.md:220-229` 等），其中 `CHANGELOG.md:225,227` 正是 log 两项 ✗ 的根治记录；`README.md`（工具表 `README.md:10-13`、设置段 `README.md:29-40`、验证命令 `README.md:67`）提供与测试断言对应的对外行为承诺。

## Flow

1. **控制流启动与代码配对**：测试设置隔离环境变量 `DSH_CODEWIKI_TICK_MS='300'`（`test-orchestration.mjs:15`，生产默认 10s、服务端下限 250ms 见 `index.js:1013`）与独立 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:18-19`，与真实宿主服务实例隔离避免互相洗写），随后 `await import('./index.js')`（`test-orchestration.mjs:20`）把 plugin-runtime 的实现加载进测试进程——「测试脚本—实现代码」的符号配对完成。

2. **模拟注入与执行驱动**：`batchCfg()`（`test-orchestration.mjs:34`）固定编译模型 workbuddy/hy3；`makeBatchMock()`（`test-orchestration.mjs:134`）把假 llm 装进 `activeLlm`；`apply(ctx, config)` 触发 `index.js:3024-3025` 的 `ctx.inject(['agents'])`/`ctx.inject(['llm'])`，而 `makeCtx` 的 `services.llm = llmProxy`（`test-orchestration.mjs:34`）使 `llmRef` 拿到的正是转发代理——实现侧全部模型环节（`llmChat` `index.js:285`）自此打到 mock。`createJobService`（`index.js:1218`）`start()` 起 tick 定时器（`index.js:2192-2196`）。工具调用（如 `codewiki_generate.execute` `index.js:2254`）走 `submit`（`index.js:2111`）：排除清单校验（`index.js:3023-3026`）→ 幂等返回现有活动任务（`index.js:3023-3024`）→ submitting 占位（`index.js:3023-3042`）→ provider/model/llm 三项校验失败即 fail+throw（`index.js:3023-3032`）→ 单项目串行排队或直达 articles（`index.js:3023-3035`）→ 先落盘再 `void tick()` 立即推进一步（`index.js:3023-3025`）。

3. **日志生成与断言配对**：服务把 job 状态整写进 JOBS_FILE（占位 job 结构 `index.js:1154-1173`，含 `usage`/`stageTimings`/`stageStartedAt`；阶段任务快照含 batchPrompt/provider/model/splitFor/composePlan/proofreadItems `index.js:1154-1165`；面板摘要 `jobSummary` `index.js:1154-1188`），测试侧 `waitJob`（`test-orchestration.mjs:720-734`）轮询该文件按 cwd 归一化过滤取终态——「测试—落盘状态」的配对通道。同时 `check()` 的 ✓/✗ 即时输出被重定向进 `.tmp-test-orchestration.log`，形成「测试代码行号—日志行」的配对。**历史日志与当前源码存在系统性错位**（log 时间戳 `batchSubmittedAt=2026-10-18…` 见 `log:410`，属 0.8.4–0.8.6 时代的运行留档，非实时投影）：
   - 断言形态错位：`log:114` `✗ source 标记 plugin/codewiki` 与 `log:195` `✗ 唤醒消息 source=plugin/codewiki` 两项 FAIL 是 0.8.5 前 `{kind:'plugin',plugin:'codewiki'}` 旧断言；0.8.5 把两处 `createUserMessage` 的 source 改为 `{kind:'plugin:codewiki'}` 并同步测试断言（`CHANGELOG.md:225,227`）后，现行断言 `test-orchestration.mjs:469` 与实现 `index.js:1214`（wake）/`index.js:291`（llmChat）已配对一致，此项闭合。`log:572` `FAIL：2 项未通过` 即指这两处。
   - 整块消失：「规划阶段改走主模型」块（`log:120-148`）随 0.10.0 删 `runMainModelPlan`（`CHANGELOG.md:137`）与 0.10.7 删整个规划阶段（`CHANGELOG.md:38`）不复存在；现行对应物是「本地规划」块（`test-orchestration.mjs:484-541`），断言全程零「勘探员」请求（`test-orchestration.mjs:509,534,554`）。
   - 阶段名错位：`log:188` `初始 stage=plan` 与 `log:330` `stage=plan`；现行断言 `stage=articles`（`test-orchestration.mjs:551`）。
   - 唤醒语义反转：`log:111` 「done → steer 一次」；0.10.9 起插件自动提交成功则 done 完全不唤醒（`test-orchestration.mjs:459-460`、`index.js:1205`），测试节名也从「与子代理 send_message 同机制」（`log:110`）改为「插件已自动提交时完全不打扰会话」（`test-orchestration.mjs:451`）。
   - 文案/模型/并发错位：`log:137,186` notes 里的 qwen3.7-flash/百炼/并发 8 与 `log:563` 的「未找到百炼 API Key」报错，分别被 0.10.0（hy3、并发 2、宿主 llm 通道，`CHANGELOG.md:136,140`）与 0.10.1（删百炼直连、报错改「编译模型提供商为空」，`CHANGELOG.md:122-124`）取代，现行断言见 `test-orchestration.mjs:1216,711-712`。
   - 篇数基线错位：`log:192` 全量 5 篇（含概念文章）、`log:302` stale 3 篇；0.10.7 起无概念文章，现行全量 ≥3（`test-orchestration.mjs:556`）、stale 恰 2 篇（`test-orchestration.mjs:747`）。

4. **文档层固化配对**：断言规模与结论回流文档——`CHANGELOG.md` 每个版本记录「验证」行的通过数（0.10.7「188 通过 / 0 失败」`CHANGELOG.md:41`、0.10.8「123 通过 / 0 失败」`CHANGELOG.md:30`、0.10.9「全部通过」`CHANGELOG.md:16`）与已知 FAIL 的根治记录（log 两项 ✗ → `CHANGELOG.md:225,227`）；`README.md` 把测试锁定的行为写成对外承诺（工具表 `README.md:10-13`、autoCommit 安全边界 `README.md:39`、验证命令 `README.md:67`）。文档因此成为「测试源码—实现源码—日志」三方配对结果的持久索引。

```text
┌────────────────────────┐  import/apply/waitJob  ┌────────────────────┐
│ test-orchestration.mjs │───────────────────────►│ index.js           │
│ （编排冒烟测试源码）     │◄───────────────────────│ （插件运行时实现）   │
└───────────┬────────────┘                        └─────────┬──────────┘
            │ check() 逐条 ✓/✗ 输出                          │ saveJobs/flush → JOBS_FILE
            ▼                                               （job 持久化，waitJob 轮询终态）
┌────────────────────────┐
│ .tmp-test-             │
│ orchestration.log      │
│ （历史运行快照，含 2 ✗） │
└───────────┬────────────┘
            │ 断言规模与 FAIL 归因
            ▼
┌────────────────────────┐      ┌────────────────────────┐
│ CHANGELOG.md           │      │ README.md              │
│ （版本级测试结论存证）   │      │ （工具/设置说明）        │
└────────────────────────┘      └────────────────────────┘
```

## Implementation Map

- **测试与日志配对实体（orchestration-tests）**
  - `test-orchestration.mjs:1-6` — 文件头注释：冒烟目标一览（提交制、阶段机 articles→crosscut→review→index、0.10.7 无规划阶段、stale 逐篇、宿主重启按 prompt 快照重跑、面板 jobs/control、编译模型缺失诚实报错、单项目串行 0.10.0、编译终态 steer 唤醒 0.8.0）与运行方式 `node test-orchestration.mjs`。
  - `test-orchestration.mjs:14-15` — `DSH_CODEWIKI_TICK_MS='300'` 测试加速（配对 `index.js:1013` 的下限钳制）。
  - `test-orchestration.mjs:18-19` — 独立 `DSH_CODEWIKI_JOBS_FILE`（`os.tmpdir()/dsh-codewiki-jobs-test-<pid>.json`），配对 `index.js:1012` 的同名环境变量。
  - `test-orchestration.mjs:20` — `const { name, apply } = await import('./index.js')`。
  - `test-orchestration.mjs:22-26` — `check(cond, msg)` 断言与 `failures` 累计；`:1269-1270` PASS/FAIL 汇总与退出码——日志每行 ✓/✗ 的唯一来源。
  - `test-orchestration.mjs:29-30` — `articleMd(title, source, marker, type)` 合成 frontmatter 文章应答；`marker`（Batch-written/Stale-batch/Restarted-batch/PROOFED）区分编译代次。
  - `test-orchestration.mjs:34-36` — `batchCfg(extra)` 固定 `batchProvider:'workbuddy'/batchModel:'hy3'`（0.10.1 起唯一通道，provider 留空即提交失败）。
  - `test-orchestration.mjs:36-80` — `makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`：`inject` 回调式传 ctx 切片（`:58-65`，0.4.10 教训）与 promise 式（`:66-67`）；`effect` 立即执行 body、返回函数收集为 disposer（`:73-77`——错写 `() => service.stop()` 会让 tick 停摆、整套测试挂死）；`services.llm = llm ?? llmProxy`（`:49`）；brokenRegistry 形态 `list()` 抛错（`:53-56`）。
  - `test-orchestration.mjs:82-97` — `makeMockAgent(cwd)`：`session.header.cwd` + `ctx.inject` 注册 `systemPrompt.section`（`getSectionOrder` mock `TOOL_REPORT=2900`）。
  - `test-orchestration.mjs:99-116` — `makeFixtureRepo()`：顶层 `core/`/`util/`（`:101-104`，localPlan 分组输入）+ git init + 自带 identity（`:109-112`，0.10.9 autoCommitWiki 安全边界）。
  - `test-orchestration.mjs:121-132` — `activeLlm`/`llmProxy` 唯一通道转发（未接线 stream 抛「测试未接线」`:124`）；`:130` `promptOf`。
  - `test-orchestration.mjs:134-198` — `makeBatchMock({modules,articleMarker,stall,bigArticle})`：`answerFor` 特征分发（观察员 `:137-140`、作者 `:141-144`、架构观察员 `:145-147`、总览/模式/概念 `:148-150`、审校员 `@@@article` 批量标记 `:151-164`）；假 stream 吐 `block-start/text-delta/usage/finish`（`:172-185`）、stall 挂起等 abort（`:173-179`）、bigArticle 追加 7 万字（`:182`）；`llmCalls` 记录 `{provider, model, reasoningEffort, prompt, signal}`（`:171`）；`restore()`（`:196`）。0.10.7 后无 `planReply`/`bigSources`。
  - `test-orchestration.mjs:201-215` — `waitJob(cwd,{timeout})` 轮询终态；`:216-228` — `fakeReq`/`fakeRes`。
  - 系统提示提醒 `test-orchestration.mjs:230-259`：布线（:242）、section 名（:245）、有 .codewiki 非空（:246）、无 .codewiki 空（:247）、有 .codewiki 但根无 CodeWiki.md 空（守护收紧 ：253）、`updateReminder=false` 生效（:256）。
  - 注册与 cw `:261-279`：插件名（:268）、两工具注册（:269）、progress 注册（:273）、cw status missing（:277-278）。
  - codewiki_update + commitHintText `:281-374`：`commitHintText` 动态导入（:293）、scope 强制 auto（:300）、「继续下一项」note（:302）、错误前缀改写（:303-305）；commitHint 分支——无 .codewiki 提交史提醒（:315-318）、编译早于提交静默（:330-338，换新仓库绕 60s 缓存）、编译晚于提交提醒（:341-349，`jobSec > commitSec` 严格大于，sleep 1100ms 隔同秒竞态 ：347）、自动提交失败原因带出（:351-364）、writtenCount=0 静默（:367-371）。
  - autoCommitWiki 安全边界（0.10.9）`:376-448`：动态导入（:379）；正常提交只含两路径与 `docs(wiki)` 前缀（:387-391）、源码改动留工作区（:392-393）、noChanges 不空提交（:395-396）；非 git（:400-405）、.gitignore 忽略（:408-415）、merge 进行中（:418-425）、缺 git identity（:428-447，`GIT_CONFIG_GLOBAL` 指空文件模拟裸环境）各拒绝分支。
  - wakeCompileSession `:450-482`：动态导入（:453）；autoCommit 成功 → done 完全不唤醒（:459-460）；失败 → 降级提醒一次带原因与「不要为此中断或轮询」（:462-468）；`source.kind === 'plugin:codewiki'`（v4，:469）；failed 消息含原因（:470-472）；无 sessionId/冷会话/registry.get 抛/steer 抛/缺省 agents 全静默（:473-481）。
  - 本地规划（0.10.7）`:484-541`：场景 1 带会话路由仍按 workbuddy/hy3 发请求（:490-519，:505-508）、零「勘探员」请求（:509）、`job.plan.project === '（本地规划：按顶层目录分组）'` 2 模块（:511-512）、concepts 空（:514）；场景 3 面板提交同路径（:523-538）。
  - 全量编译阶段机 `:543-582`：提交即返回（:550-552）、零规划（:554）、done（:555）、autoCommit sha（:557）、HEAD 只含 wiki 产物（:559-561）、工作区干净（:566-567）、不唤醒会话（:569）、落盘清单（:571-575）、PROOFED 回写（:576）、cw index note（:577）、零子代理（:578）。
  - 大 wiki 横切拆分 `:584-612`：2 观察请求各单篇（:594-599）、合成只吃观察（:600）、横切落盘（:602-603）、notes 记拆分/大档/合成（:605-607）。
  - 文章阶段分割 `:614-648`：15×100KB/模块 ≈439k>420k 才拆（:618-624）、10 观察批 + 2 合成（:635-638）、照常校对回写（:642）。
  - 单项目串行（0.10.0）`:650-697`：A 占推进权（:666）、B queued + pendingStage（:670-672）、排队零请求（:674-676）、cancel A → B 轮到（:678-689）。
  - 唯一通道 `:699-731`：全走 workbuddy/hy3（:711-712）、不下发 reasoningEffort（:713）、tps（:719）、stageStartedAt/stageTimings（:720-721）、usage（:722-723）。
  - stale 逐篇 `:733-754`：直达 articles（:743）、kind=stale（:745）、恰 2 篇（:747）、未变更不动（:750）。
  - codewiki_progress `:756-792`：cwd/jobId 过滤（:760-772）、终态 100%（:763）、taskList/usage（:764-765）、render（:774-775）、进行中百分比合法（:783-784）。
  - 宿主重启重跑（0.6.0）`:793-850`：场景 A articles 快照重跑（:795-821，notes「自动重跑阶段」:817）；场景 B 旧 plan 快照迁移到 articles、勘探员作废、localPlan 重建（:823-848，:842-844）。
  - 并发占位 + flush 合并 `:852-890`：共享同一 job（:878-882）、外部实例 job 不丢（:884-885）。
  - 面板端点与取消 `:892-944`：403（:903-905）、无 apiKey（:910）、batchProgress/taskList（:912-919）、repos 字段与 scheduler（:920-930）、cancel/404（:931-939）。
  - 排除清单/repos/compile（0.4.7）`:946-999`：compile 提交（:955-959）、auto 幂等（:961-963）、排除 400 且报错含命中排除项（0.8.1，:969-982）、repos excluded/state/scheduler（:985-993）。
  - knownRepos/refresh（0.4.8）`:1001-1039`：登记（:1019-1020）、历史清空仍发现（:1022-1033）。
  - 工作区过滤（0.4.9/0.10.5）`:1041-1102`：非终态放行（:1066-1077）、终态过滤（:1082-1091）、开关关闭不过滤（:1093-1095）。
  - registry 降级（0.4.10）`:1104-1132`（:1119-1127）；schema 校验（0.4.10b）`:1134-1172`（`validateOut` :1138-1153，:1164-1167）；孤儿接管（0.4.11.2）`:1174-1206`（:1199-1204）；编译模型缺失（0.10.1）`:1208-1221`（:1216-1219）；严格 cordis `:1223-1245`（getter :1237-1239，:1241-1244）；Temp 清理（0.4.6）`:1247-1264`（:1261-1263）。
  - `.tmp-test-orchestration.log:114` — `✗ source 标记 plugin/codewiki`（0.8.5 前旧断言，已闭合，见 Flow 第 3 步）。
  - `.tmp-test-orchestration.log:195` — `✗ 唤醒消息 source=plugin/codewiki`（同上）。
  - `.tmp-test-orchestration.log:572` — `FAIL：2 项未通过`（当轮仅此两处失败）。
  - `.tmp-test-orchestration.log:410` — `batchSubmittedAt=2026-10-18T02:40:36.493Z`：日志运行年代（0.8.4–0.8.6）的证据。

- **被测实现配对位置（plugin-runtime）**
  - `index.js:18-19` — `PLUGIN_NAME = 'dsh-codewiki'`，`export const name`。
  - `index.js:22-33` — `CONCURRENCY_HARD_CAP=8`（22）、`DEFAULT_CONCURRENCY=2`（24）、`DEFAULT_BATCH_PROVIDER='workbuddy'`（26）、`DEFAULT_BATCH_MODEL='hy3'`（27）、`DEFAULT_BIG_PROVIDER='volces-ark'`（30）、`DEFAULT_BIG_MODEL='glm-5.3-flash'`（31）、`DEFAULT_BIG_TOKEN_BUDGET=420000`（33）。
  - `index.js:37-42` — `normalizeCwd`（win32 MSYS `/e/...` → `E:/...`）。
  - `index.js:48-68` — `Config`：`enabled/binaryPath/batchProvider/batchModel/batchReasoningEffort/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget/sessionTier/maxConcurrency(59)/serialProjects(60)/articleLanguage/updateReminder/autoCommit(63，0.10.9)/excludePaths/autoUpdate(65)/autoUpdateMin(66)/workspaceOnly(67)`，全部 volatile。
  - `index.js:74-99` — `liveConfig` 解包：`bigTokenBudget` 下限钳到 `BATCH_TOKEN_BUDGET`（:86）、`maxConcurrency` 夹 1–8（:88-90）、`autoCommit` 默认开（:96）。
  - `index.js:105-125` — `resolveBinary`（binaryPath → PATH 探测 → 捆绑 `bin/cw(.exe)` 兜底）；`index.js:127-152` — `runCw`（spawn Promise，120s 超时 + signal abort）。
  - `index.js:164,168-176,178-191` — `normalizeArticlePath`/`normalizeIndexLinks`/`parseStatus`（三态 + changedFiles/staleArticles，`\`→`/`）；`index.js:194-206` — `countWikiArticles`。
  - `index.js:211-244` — `ensureWikiEntry`（收尾自动生成 CodeWiki.md 入口，已有不覆盖，0.5.0.1）。
  - `index.js:249-261` — `excludedItem`（返回命中排除项原文，0.8.1）/`isExcluded`。
  - `index.js:269-277` — `estimateTokens`（CJK≈1 token/字，其余≈3.5 字符/token）。
  - `index.js:285-304` — `llmChat` 唯一模型通道：`llm.stream` + `BlockAssembler`，finish `error/aborted` 抛错（:298-300）；`source:{kind:'plugin:codewiki'}`（:291）。
  - `index.js:308-321` — `applyTaskResult`（keepInMemory 回内存；普通任务 `fixAnchors` 后落盘）；`index.js:329-358` — `runRealtimeTasks` 并发池（按任务自带 provider/model/reasoningEffort 分派，缺省回落参数；`onTaskDone` 上报 tps 样本）。
  - `index.js:371,376` — `BATCH_TOKEN_BUDGET=110000` / `BATCH_TOKEN_HARD_LIMIT=128000`（192k 窗口 − 64k 输出，0.10.2 收口 `CHANGELOG.md:110`）。
  - `index.js:387-389` — `numberLines` 源码加「N| 」前缀（0.8.7，`CHANGELOG.md:201`）。
  - `index.js:398-481` — `fixAnchors` 行号锚点确定性修正（0.8.8）：符号提取 `symbolsOnLine`（:418-427）、声明形态判定（:458-461）、区间尾钳到文件尾（:474）。
  - `index.js:486-513` — `collectSources`（整文件粒度装填，不做半文件截断；跳过文件在文内标注 ：510）。
  - `index.js:517-544` — `batchArticlePrompt`（prevArticle 注入「行号不得沿用」条款 ：527-534）。
  - `index.js:557-642` — `prepareArticleTasks`：`markBig` 标大档（:569-577）、装填按 `singleLimit`（大档开启=大档预算，否则 128k，:582）；装得下单请求（:603）；超了按普通预算拆观察批（`#obs` keepInMemory + `composePlan`，:604-637）；单文件连大档都装不下 → `emitSession` 会话通道兜底（:600,619）。
  - `index.js:648-677` — `articleFormatSection`（frontmatter/章节/行号前缀条款/box-drawing 图/backlinks）；`index.js:682-695` — `localPlan`（0.10.7 起唯一规划路径：顶层目录分组，concepts 恒空）；`index.js:699-718` — `packArticles`。
  - `index.js:720-756` — `crosscutIntro`/`batchArchitecturePrompt`(734)/`batchPatternsPrompt`(742)/`batchConceptPrompt`(750)；`index.js:760-777` — `batchObservePrompt`（横切观察）；`index.js:781-797` — `batchArticleObservePrompt`（文章分割观察）；`index.js:801-829` — `batchArticleComposePrompt`（合成）；`index.js:833-852` — `batchProofreadPrompt`（单篇校对）；`index.js:856-883` — `batchProofreadBatchPrompt`（0.10.8 批量校对 `@@@article`/`@@@end` 标记）。
  - `index.js:889-952` — `cwToolDefinition`（子命令白名单 `CW_SUBCOMMANDS` `index.js:20`）；`index.js:960-962` — `slugify`（保留 CJK，0.10.8 修复 `CHANGELOG.md:27`）；`index.js:966-988` — `parseSourceFiles`/`readSourceFiles`；`index.js:990-995` — `wikiPathFor`。
  - `index.js:1012-1018` — `JOBS_FILE`/`TICK_MS`(1013)/`SESSION_TASK_TIMEOUT_MS`(1017)/`SESSION_TASK_DIR`(1018)；`index.js:1024-1034` — `classifySessionTask` 三态 timeout/harvest/wait（0.9.0，`CHANGELOG.md:177`）；`index.js:1041-1059` — `buildSessionSteerText`（0.9.2，`CHANGELOG.md:152`）；`index.js:1061-1062` — `ORPHAN_TAKEOVER_MS`(5min)/`MAX_JOBS_KEPT=30`；`index.js:1067-1079` — `REPOS_FILE`/`loadKnownRepos`/`rememberRepo`（0.4.8）；`index.js:1080` — `JOB_TERMINAL`；`index.js:1012-1024` — 扫描常量（黑名单目录/二进制后缀/单文件 256KB/总数 2000）；`index.js:1097-1120` — `scanRepoFiles`（localPlan 输入）。
  - `index.js:1130-1148` — `acquireTickLock`/`releaseTickLock`（跨进程推进锁，60s 过期强删）；`index.js:1147-1152` — `saveJobs`（只留最近 30 条，0.10.1 起无 apiKey 剥离）；`index.js:1154-1188` — `jobSummary`（tps 聚合 ：1156-1158,1186、taskList 已结算在前待办在后 ：1172-1175）。
  - `index.js:1195,1200` — `agentsRef`/`llmRef` 模块级服务引用；`index.js:1202-1216` — `wakeCompileSession`（0.10.9：`outcome!=='failed' && job?.autoCommit?.committed` 直接 return :1205；降级提醒文案 :1212；steer `source:{kind:'plugin:codewiki'}` :1214）。
  - `index.js:1218-2203` — `createJobService(config, onSettled)`：`mergeFromDisk`/`flush`（:1250-1275）、`note`（:1276-1279）、`touch`（:1280-1284）、`setStage`（:1287-1297，累计 stageTimings）、`addUsage`（:1299-1308）、`syncCancelFlags`（:1312-1323）、`fail`（:1325-1333）、`settleJob`（:1336-1357，执行器丢失按 batchPrompt 快照重跑 :1347-1355）、`writeValidated`（:1362-1378，frontmatter 闸门 + fixAnchors）、`tally`（:1381-1402）、`settleProofread`（:1406-1430，按 @@@ 标记拆回）、`startBatchChatRun`（:1439-1479，batchRuns/batchResults/batchAborters :1436-1438）、`submitBatchFor`（:1481-1509，任务快照 :1489-1500）、`dispatchSessionTasks`（:1517-1551）/`progressSessionTasks`（:1555-1574）/`resendSessionSteer`（:1578-1591）、`tickArticles`（:1599-1720，full 无 plan 就地 localPlan :1672-1677、`#obs` 收割重建合成 ：1606-1663、`writtenCount===0` fail :1718）、`crosscutTasks`（:1723-1742）/`tickCrosscut`（:1744-1826，总量 ≤ 大档预算单批直出 ：1795-1812、超了才观察拆分 ：1813-1825）/`tickCompose`（:1829-1841）/`submitComposeBatch`（:1843-1853）、`localReview`（:1856-1876）/`tickReview`（:1878-1988，批量校对贪心合并 ：1889-1961、单篇超档转会话通道 ：1911-1919）、`tickIndex`（:1990-2022，cw index/meta update :1993-1998、ensureWikiEntry :2002-2006、autoCommitWiki :2014-2020）。
  - `index.js:2024-2030` — `STAGE_HANDLER`：articles/crosscut/compose/review/index（无 plan，0.10.7）；`index.js:2032-2109` — `tick`（跨实例取消拾取 ：2037、单项目串行闸门 ：2040-2046、孤儿接管 ：2049-2058、取消中断在飞请求 ：2060-2069、queued 轮到 ：2072-2082、旧 plan 任务迁移 ：2087-2094）。
  - `index.js:2111-2176` — `submit`：排除清单（:2113-2116）、幂等（:2118-2119）、submitting 占位 job（:2121-2140）、provider/model/llm 三项校验（:2145-2154）、`credentialSource = llm(...)`（:2155）、串行排队（:2159-2171）、先落盘再推进（:2172-2174）；`index.js:2178-2187` — `cancel`；`index.js:2189-2190` — `list`/`findActive`；`index.js:2192-2200` — `start`/`stop`。
  - `index.js:2210-2360` — `generateToolDefinition`（execute :2254：normalizeCwd、排除清单 ：2260-2261、cw status 判态 ：2269-2274、幂等 ：2280-2288、stale 升全量 ：2291-2295、clean 短路 ：2299-2302、stale 预构建任务 mission「更新过期文章……保留章节结构与 title/type/tags」:2305-2321（mission 在 ：2315）、cw init :2344-2350、全量提交 ：2352-2357）。
  - `index.js:2370-2422` — `updateToolDefinition`（固定 `scope:'auto'` :2412、「继续下一项」note :2414、错误前缀改写 ：2418）；`index.js:2430-2439` — `samePath`/`progressView`；`index.js:2441-2542` — `progressToolDefinition`（`progress` 字段 oneOf number|null :2471，0.10.5 修复 `CHANGELOG.md:60`）。
  - `index.js:2548-2577` — `isLoopbackRequest`/`writeJson`/`readBodyJson`；`index.js:2584-2605` — `listModelCatalog`（0.9.1，`CHANGELOG.md:164`）；`index.js:2611-2616,2622-2644` — `resolveModelInfoOf`/`resolveModelEfforts`（0.10.4 方法名修复，`CHANGELOG.md:71-72`）。
  - `index.js:2646-2875` — `installWebServer`：`/api/codewiki/jobs`（:2687-2705，workspaceOnly 过滤但非终态放行 ：2694-2698，0.10.6）、`/repos`（:2709-2795，30s 缓存且签名含活动任务 ：2715-2722）、`/models`（:2802-2817）、`/model-efforts`（:2821-2841）、`/control`（:2842-2873，cancel/refresh/compile）。
  - `index.js:2904-2945` — `autoCommitWiki`（0.10.9）：安全边界（非 git :2910-2911、无 HEAD :2912、merge/rebase/cherry-pick :2913-2916、未解决冲突 ：2917、check-ignore :2921-2924、缺 identity :2926-2928）、只 `git add -A -- <两路径>`（:2929）、`commit --no-verify`（:2938）。
  - `index.js:2947-2976` — `commitHintText`（仅自动提交失败时提醒 ：2960-2965，60s 缓存 ：2949-2950,2974）；`index.js:2978-2987` — `reminderText`；`index.js:2989-3021` — `installUpdateReminder`（门控 CodeWiki.md :3003-3006）；`index.js:3023-3081` — `apply`（inject agents/llm :3024-3025、createJobService+start :3026-3027、effect disposer :3030、自动更新调度 ：3033-3062、4 工具注册 per-definition try/catch :3063-3079、installWebServer :3080、installUpdateReminder :3081）。

- **文档配对位置（project-docs）**
  - `CHANGELOG.md:8-22` — 0.10.9：`autoCommitWiki` 责任收回（:8）与安全边界（:9）、`wakeCompileSession` 自动提交成功不唤醒（:10）、工具/系统提示文案（:11）、新增 `autoCommit` 设置（:12）、测试新增自动提交断言组（:14）、验证「全部通过」（:16）。
  - `CHANGELOG.md:26-38` — 0.10.8：`prepareArticleTasks` 重写大档单请求优先（:24）、横切单批直出（:25）、批量校对 `batchProofreadBatchPrompt`/`settleProofread`（:26）、CJK slugify 修复（:27）、验证「123 通过 / 0 失败」（:30）。
  - `CHANGELOG.md:38-47` — 0.10.7：删 `tickPlan`/`batchPlannerPrompt`/`parsePlan`（:38）、`localPlan` 升唯一规划路径、测试块重写与 writtenCount 基线 5→4、stale 3→2（:40）、验证「188 通过 / 0 失败」（:41）。
  - `CHANGELOG.md:44-52` — 0.10.6：非终态任务不被 workspaceOnly 藏掉（:50）；`CHANGELOG.md:54-64` — 0.10.5：progress schema `oneOf` null 修复（:60）。
  - `CHANGELOG.md:72-98` — 0.10.4：`resolveModelInfo` 方法名根因（:71）与 `resolveModelInfoOf` 修法（:72）、大档配置四项（:78）、`prepareArticleTasks` bigTier 分派（:79）、`runRealtimeTasks` 按任务分派（:80）。
  - `CHANGELOG.md:105-115` — 0.10.2：`BATCH_TOKEN_HARD_LIMIT` 150000→128000 推导（:110）；`CHANGELOG.md:94-103` — 0.10.3：单文件 110k–128k 误判修复。
  - `CHANGELOG.md:117-129` — 0.10.1：删 `bailianChat`（:122）、删 `resolveBatchApiKey`/`hostCtxRef` 与 job.apiKey（:123）、submit 三项校验（:124）、测试 `makeBatchMock` 改假 llm 服务（:128）。
  - `CHANGELOG.md:131-144` — 0.10.0：hy3 主模型与 `BATCH_TOKEN_BUDGET` 110000（:136）、删 `runMainModelPlan`（:137）、`serialProjects`（:139）、并发默认 2（:140）。
  - `CHANGELOG.md:146-157` — 0.9.2：`sessionTier`（:151）与 `buildSessionSteerText`（:152）；`CHANGELOG.md:159-169` — 0.9.1：`listModelCatalog`（:164）；`CHANGELOG.md:171-183` — 0.9.0：会话通道 `classifySessionTask`（:177）与 `dispatchSessionTasks`/`progressSessionTasks`/`resendSessionSteer`（:178）。
  - `CHANGELOG.md:185-194` — 0.8.8：`fixAnchors`（:190）；`CHANGELOG.md:196-206` — 0.8.7：`numberLines`（:201）；`CHANGELOG.md:220-229` — 0.8.5：source 改形 `{kind:'plugin:codewiki'}`（:225）与测试断言同步（:227）——log 两项 ✗ 的根治记录。
  - `CHANGELOG.md:276-286` — 0.8.0：`wakeCompileSession` 终态 steer 唤醒（:281）；`CHANGELOG.md:288-296` — 0.7.0：`codewiki_update` 与 `commitHintText`（:294）；`CHANGELOG.md:310-319` — 0.5.0.6：`codewiki_progress`（:315）；`CHANGELOG.md:357-366` — 0.5.0.1：`ensureWikiEntry`（:362）；`CHANGELOG.md:381-393` — 0.4.11.2：孤儿接管（:392）；`CHANGELOG.md:404-412` — 0.4.10：output schema 校验（:411）；`CHANGELOG.md:414-420`/`422-429`/`431-439`/`441-448` — 0.4.9 workspaceOnly / 0.4.8 knownRepos / 0.4.7 排除清单+repos / 0.4.6 Temp 清理。
  - `README.md:10-13` — 工具表：`codewiki_generate`（提交制、0.10.7 无规划阶段、大档 0.10.8、零子代理）、`codewiki_update`（autoCommit 0.10.9，成功不再唤醒）、`codewiki_progress`、CodeWiki 设置页。
  - `README.md:17-22` — `codewiki_generate` 关键行为（scope=auto 语义 ：17、全部模型环节插件内 ：18、单篇失败不中断 ：19、`maxConcurrency` 2 :20、`serialProjects` :21、`scope=full` 强制全量 ：22）。
  - `README.md:29-32` — `batchProvider`/`batchModel` 唯一通道（0.10.1 删直连，:29）、`batchReasoningEffort` 目录实时读取（:30）、大档四项与 0.10.8 拆分门槛（:31）、`sessionTier` 仅超大输入兜底（:32）。
  - `README.md:34-40` — `binaryPath`（:34）、`maxConcurrency`（:35）、`serialProjects`（:36）、`articleLanguage`（:37）、`updateReminder` 0.10.9 降级提醒（:38）、`autoCommit` 安全边界全清单（:39）、全部 volatile 热生效（:40）。
  - `README.md:67` — 验证命令：`node --check index.js client.js`；编排冒烟 `node test-orchestration.mjs`（mock 子代理 + 真实 cw CLI；0.10.x 起为 mock 宿主 llm 服务）。