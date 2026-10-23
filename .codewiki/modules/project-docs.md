---
title: project-docs
type: module
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
tags: [docs, 使用者文档, 上手指南, 演进史, 维护公约]
---

## Overview

模块「project-docs」不是代码，而是插件 `@local/dsh-codewiki` 仓库根下**面向使用者的三份 Markdown 文档**，三者共同构成该插件对外的事实说明来源：

| 文档 | 规模 | 职责 | 主要读者 |
|------|------|------|----------|
| `README.md` | 65 行 | 定位与上手：插件是什么、提供哪些工具、全部设置项、安装步骤、开发与验证方式 | 首次接触本插件的人与 agent |
| `CodeWiki.md` | 65 行 | 代码结构与概念索引：单段全景 Overview + 按文件/函数的组件清单 + 架构图 + 数据流 + 已知问题；同时是 `codewiki_generate` 全量编译的入口文件（CodeWiki.md:3） | 要读懂/改动代码的人与 agent |
| `CHANGELOG.md` | 515 行（约 90KB+） | 长期演进记录：50 个版本（0.1.0 → 0.10.0，2026-10-01 至 2026-10-23）倒序逐版记录背景/实现/测试/文档同步 | 追溯某个行为「为什么是这样」的人与 agent |

三份文档与编译产物的关系：`CodeWiki.md` 顶部声明它是「插件自身的项目 wiki 入口（CodeWiki.md 公约）」，`codewiki_generate` 以它为入口把全文细化成 `<repo>/.codewiki/` 下的文章群（CodeWiki.md:3、CodeWiki.md:7）——本文件（`.codewiki/modules/project-docs.md`）正是该流水线的产物之一。`README.md` 与 `CHANGELOG.md` 不参与编译，是纯手写文档，但 CHANGELOG 的每个大版本都有「文档：」条目记录三份的同步动作（如 CHANGELOG.md:16、CHANGELOG.md:55、CHANGELOG.md:463）。

读法建议（写给零上下文的 agent）：先读 README.md:5-13 定位四个工具 → 按需读 CodeWiki.md:9-28 找函数与行号指针 → 对某个行为有疑问时按版本索引表（见下）跳 CHANGELOG 对应节读「背景（用户需求）」。

## Key Components

### README.md（65 行）——定位与上手

- **标题与一句话简介**（README.md:1-3）：「把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：仓库内代码 wiki（`<repo>/.codewiki/`，随仓库提交共享）+ 智能体编排编译，支持为编译子代理指定模型」。
- **「提供」表**（README.md:5-13），5 行清单：
  - `cw` 工具：CLI 薄封装，子命令白名单 `status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall`（README.md:9）；
  - `codewiki_generate` 工具：提交制编译，全部模型环节在插件内完成（默认 `workbuddy`/`hy3`，192k 上下文，单请求输入预算 110k），零子代理、不委托发起会话的主模型（0.10.0），只有单个源文件连 150k 都装不下时才转会话通道兜底（README.md:10）；
  - `codewiki_update` 工具（0.7.0 起）：固定 scope=auto 的提交制更新，调用即返回并明确「继续下一项、不要等待」；编译完成实时唤醒发起会话（0.8.0 起 steer 直达）并注入「编译完成·请提交改动」提醒（README.md:11）；
  - `codewiki_progress` 工具：只读查编译进度，立即返回不等待，数据与侧边栏面板同源（README.md:12）；
  - CodeWiki 设置页：插件管理页 Official 组条目（id `codewiki`），`view=summary` 一行简介、`view=page` 完整表单 + 保存条（README.md:13）。
- **`codewiki_generate` 关键行为清单**（README.md:15-22），六条：
  - `scope=auto`（默认）三态：无 wiki/未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告（README.md:17）；
  - 全部模型环节（规划/写文章/横切/审校）在插件内跑，共用 `batchProvider`/`batchModel` 一个模型（README.md:18）；
  - 单篇文章失败只记账不中断；全部失败则不刷新编译基线（`meta update` 不执行，可安全重试）（README.md:19）；
  - 请求并发 `maxConcurrency` 默认 2（硬顶 8）（README.md:20）；
  - `serialProjects` 默认开：同一时刻只推进一个仓库的编译任务，后提交的进 `queued` 排队（README.md:21）；
  - `scope=full`：跳过 clean 短路，即使 wiki 最新也强制全量重编（README.md:22）。
- **设置段**（README.md:26-38）：开头说明设置页保存走 `configForms.mutate`（单层 op），与 patch 手改等价、热生效（README.md:26）；随后逐项列出全部配置键——`batchProvider`/`batchModel`（0.10.0，0.10.1 起为唯一通道：内置百炼直连已删，必须指向模型设置里已注册的 provider，留空直接提交失败；默认 `workbuddy`/`hy3`，走宿主 llm 服务，本地 OpenAI 兼容端点亦可，README.md:29）、`batchReasoningEffort`（0.10.0，可选值不手填，设置页从 `/api/codewiki/model-efforts` 实时读取，README.md:30）、`sessionTier`（0.9.2，仅超大单文件兜底转会话通道时钉死子智能体档位，留空=自动选路，README.md:31）、`binaryPath`（PATH 优先、捆绑 `bin/cw.exe` 兜底，0.2.3 起此顺序，README.md:33）、`maxConcurrency`（默认 2，1–8，README.md:34）、`serialProjects`（0.10.0 默认开，README.md:35）、`articleLanguage`（默认中文，README.md:36）、`updateReminder`（系统提示注入 wiki 维护提醒，默认开；0.2.5 起维护提醒、0.7.0 起兼职编译完成提交提醒、0.8.0 起编译终态另有实时 steer 唤醒，README.md:37）；收尾注明**所有设置 `volatile`，改完即生效**（README.md:38）。
- **安装段**（README.md:48-63）：本地 file:/// 直挂四步——源码位置（README.md:48）、`profiles/web/cordis.patch.yml` 顶层追加 `insert` 条目（含 yaml 片段 `id: codewiki` + file:/// 路径，README.md:48-55）、`@deepseek-ai/schemastery` 走插件本地 junction（README.md:48）、重启 dsh 生效（客户端半侧由 `package.json` 的 `dsh.client.platform: "web"` + `exports["./client"]` 包声明驱动，README.md:55）。
- **开发段**（README.md:57-65）：目录说明三行——`vendor/codewiki/` 上游源码（去除 .git）、`bin/cw.exe` cargo build --release 产物（git 内跟踪，改了 vendor 记得重编）、`client.js` 插件页设置卡片（README.md:60-62）；验证命令（README.md:65）：`node --check index.js client.js`、编排冒烟 `node test-orchestration.mjs`（mock 子代理 + 真实 cw CLI）、CLI 冒烟见 CHANGELOG 0.1.0、设置页需重启 dsh 后实测。

### CodeWiki.md（65 行）——代码结构与概念索引

- **入口声明**（CodeWiki.md:1-3）：「本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约）。重启 dsh 后可用 `codewiki_generate` 对本仓库做全量编译，把本文细化成 `<repo>/.codewiki/` 文章」。
- **Overview**（CodeWiki.md:5-7）：单段全景，覆盖——接入目标（mraza007/codewiki 的 Rust CLI `cw`）、wiki 位置（`<repo>/.codewiki/` 随仓库提交共享）、编译形态（纯提交制；六环节 规划/写文章/横切/合成/审校/索引收尾，合成仅在横切超预算拆分时出现）、模型通道（0.10.0 起默认宿主 `llm.stream()` 的 `workbuddy`/`hy3`：免费、192k 上下文、单请求输出上限 64k，`BATCH_TOKEN_BUDGET=110000`、`BATCH_TOKEN_HARD_LIMIT=150000`）、横切 map-reduce 拆分、请求并发默认 2、`serialProjects` 排队、会话通道兜底（完整写作指令写入任务文件、服务每 tick 轮询目标文件收割——frontmatter 校验 + 行号锚点校正后入账，超时默认 30 分钟按失败处理）、hindsight 式侧边栏面板（轮询进度、可取消）。
- **Key Components**（CodeWiki.md:9-28）：按文件的组件清单，每个条目自带行号指针——
  - `index.js`（插件全部逻辑，单文件 Node ESM，CodeWiki.md:11）下列 11 条：
    - `Config`（index.js:42）——schemastery 设置全集：enabled / binaryPath / maxConcurrency（默认 2，1–8）/ serialProjects（默认 true）/ articleLanguage / updateReminder / 编译模型三项（`batchProvider` 默认 `workbuddy`，0.10.1 起必须是模型设置里已注册的 provider 留空即提交失败；`batchModel` 默认 `hy3`；`batchReasoningEffort` 默认空=模型默认档）/ `sessionTier`（仅超 150k 兜底转会话通道时钉死的子智能体档位 id，留空=自动选路），全部 `.volatile()`，execute/tick 时热读取（CodeWiki.md:12）；
    - `buildSessionSteerText`（0.9.2，纯函数）——会话通道 steer 文本的唯一生成处，`dispatchSessionTasks` 与 `resendSessionSteer` 共用；含「存在理由」：编译主链不走档位路由，只有这段经过 delegate，不给 tier 就会按职责描述自动选路（CodeWiki.md:13）；
    - `installUpdateReminder`——`agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过（CodeWiki.md:14）；
    - `runCw` / `parseStatus`——cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）（CodeWiki.md:15）；
    - 模型执行模块——`estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（超预算拆观察批，单文件连 150k 大档都装不下的整任务进 sessionTasks）/ `classifySessionTask`（会话通道收割三态 harvest/timeout/wait）/ `startBatchChatRun` + `submitBatchFor` + `settleJob`（阶段执行器）/ `runRealtimeTasks`（后台并发池唯一执行器，0.10.1 起内部固定走 `llmChat`）/ `llmChat`（同步单轮，唯一模型通道：宿主 `llm.stream()`，凭证由 provider 自身配置决定）/ `listModelCatalog`（设置页级联目录）/ `resolveModelEfforts`（0.10.0，思考档位单独解析）（CodeWiki.md:16）；
    - `createJobService`——宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调）推进阶段机 queued→plan→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`；单项目串行闸门（每 tick 先算 activeId）；会话通道三函数（`dispatchSessionTasks` 写任务文件+steer、`progressSessionTasks` 每 tick 收割、`resendSessionSteer` 重启接管后重发）；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（多实例安全：owner/tick 串行锁/mergeFromDisk/cancel 跨实例拾取）；批次断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`；`writeValidated` 校验 frontmatter 后写盘（CodeWiki.md:17）；
    - `cwToolDefinition`——cw CLI 封装工具（子命令白名单）（CodeWiki.md:18）；
    - `generateToolDefinition`——纯提交制：normalizeCwd → 凭证解析 → cw status 判态 → 孤儿断点并入（resume）→ 任务预构建 → `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用（CodeWiki.md:19）；
    - webServer 端点——四个精确端点全部仅回环放行（否则 403）：`GET /api/codewiki/jobs`、`GET /api/codewiki/repos`（30s 缓存）、`GET /api/codewiki/models`（30s 缓存）、`POST /api/codewiki/control {action:'cancel'|'refresh'|'compile', jobId}`（CodeWiki.md:20）；
    - `apply`——`ctx.inject(['tools','webServer','credentials'])` 注册两工具 + 端点；`agent/created` 布提醒（CodeWiki.md:21）。
  - `vendor/codewiki/`（上游源码，去 .git）+ `bin/cw.exe`（cargo release 产物，git 跟踪）（CodeWiki.md:22）。
  - `client.js`（插件页设置卡片 + 侧边栏面板，浏览器半侧，CodeWiki.md:24）：`__ModuleLoader__.load` 注册（`plugins.item` order 30 + `main`/`sidebar.panellist` 双 slot order 52，CodeWiki.md:24）、`CodewikiCard` 设置表单（快照订阅、provider/model 两级下拉、思考档位二次拉取、回环限定 + 60s 缓存、保存 `form.mutate` 单层 op + revision CAS，CodeWiki.md:25）、`CodewikiPanel` 任务面板（2s 轮询 `GET /api/codewiki/jobs`、七阶段步骤条 `queued` 最前、双通道吞吐徽标、用量行、加权总进度条、活动任务可取消，CodeWiki.md:26）。
  - `cordis.patch.yml`（bundle 形式挂载补丁，本地开发走 profile patch 的 file:/// 直挂，CodeWiki.md:27）、`package.json`（`exports["./client"]` + `dsh.client.platform:"web"`，CodeWiki.md:28）。
- **Architecture**（CodeWiki.md:30-47）：```text 流程框图——模型调用 `codewiki_generate(cwd, scope)`（纯提交零 LLM）→ 任务预构建 → `JobService.submit` 立即返回 `{submitted, jobId, stage}` → 宿主后台 tick 10s 推进 `queued→plan→articles→crosscut→review→index`（queued 仅单项目串行时出现；全部走插件内后台并发池，文章/校对单文件超 150k 才转会话通道兜底→会话模型派子智能体写盘→服务轮询收割）→ `cw index + cw meta update`（有成功文章才刷新基线）；面板 2s 轮询 GET jobs、取消走 POST control（CodeWiki.md:32-47）。
- **Data Flow**（CodeWiki.md:49-51）：四条流一段写完——配置流（profile patch `config:` → cordis 注入 apply → liveConfig 每次解包，volatile 热生效）、凭证流（插件不保存也不传递任何密钥，请求经宿主 `llm.stream()`，凭证由所选 provider 在模型设置里的配置解析）、任务流（execute 预构建含 token 预算分块 → jobs.json 持久化 → 服务 tick 消费 → 批次断点跨会话续查 → 文章落盘 + 校对回写 → cw index/meta update）、面板流（浏览器 2s 轮询，回环 only）。
- **Connections**（CodeWiki.md:53-56）：`[[codewiki-upstream]]`（vendor 布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`；上游技能正文仅存于 `vendor/codewiki/skills/`，插件不再注册技能）与宿主模型目录（`llm.listProviders` / `llm.listModels` / `llm.resolveModel`；hy3 的预算推导 110k/150k、可换模型设置里已注册的任意 provider/model 含本地 OpenAI 兼容端点；0.10.1 起 `batchProvider` 留空直接提交失败，内置百炼通道已删除）。
- **Known Issues**（CodeWiki.md:65-65），六条：插件注册不热加载（改 index.js / profile patch 后需重启；client.js 的「非 client 包」判定按条目缓存同样需重启，CodeWiki.md:65）、`@deepseek-ai/schemastery` 靠插件本地 junction 换机器需重建（CodeWiki.md:65）、上游 `cw` 无 `--version` 且 `cw path` 未 init 时退回插件侧 fallback `<cwd>/.codewiki`（CodeWiki.md:65）、上游 stale 文章路径输出为反斜杠已被插件消费侧归一为 `/`（CodeWiki.md:65）、断点文件仅记录 stage/crosscutSplit 且 0.5.x 的 24h 批次窗口语义已随 0.6.0 删除（CodeWiki.md:65）、会话通道任务依赖发起会话（面板/自动调度提交的 job 没有会话可 steer，超预算文章/校对任务直接整体失败并明示原因；超时默认 30 分钟 `DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调，不降级百炼；任务文件落 `os.tmpdir()/dsh-codewiki-session-tasks/`，CodeWiki.md:65）。

### CHANGELOG.md（515 行，约 90KB+）——长期演进记录

**结构与条目模板**（每个版本一节）：

- `## <版本> — <日期>`（如 `## 0.10.0 — 2026-10-23`，CHANGELOG.md:3）；
- `### <类型>：<一句话主题>（触发来源）`（如 CHANGELOG.md:20 `### 修复：自建 codewiki 档位在写 CodeWiki 时从未被调用（用户反馈：创建了 codewiki 档位，写 wiki 时模型仍走 default 档）`）；类型取值：功能 / 修复 / 适配 / 审查修复；
- 固定条目模式：`- 背景（用户需求）：…`（决策动机，多数版本有，如 CHANGELOG.md:7）、`- 实现 ①②③…（<文件> <符号/位置>）：<行为>`（如 0.10.0 的实现①-⑦，CHANGELOG.md:8-14）、`- 删除：…`（如 0.9.0 删超大兜底段，CHANGELOG.md:53）、`- 测试（test-*.mjs）：…N → M 项全过`（断言数前后对照，如 CHANGELOG.md:15、CHANGELOG.md:27）、`- 文档：README/CodeWiki.md 同步；版本 x.y.z`（如 CHANGELOG.md:16、CHANGELOG.md:29）、`- 验证：…`（早期版本有，如 0.1.0 的验证记录 CHANGELOG.md:511-515）。

**全部 50 个版本的行号索引**（倒序，接手时按行号直接跳转）：

| 版本 | 日期 | 主题 | CHANGELOG 行号 |
|--------|------------|------|----------------|
| 0.10.0 | 2026-10-23 | hy3 主模型、全流程回插件内、单项目串行、思考程度从模型目录读取 | :3-16 |
| 0.9.2 | 2026-10-23 | `sessionTier` 自建档位、`buildSessionSteerText` 收口 steer 文案 | :17-29 |
| 0.9.1 | 2026-10-22 | 编译模型可选宿主 provider/model（本地 9B 可用）、`listModelCatalog` | :31-41 |
| 0.9.0 | 2026-10-21 | 超 32k 文章/校对转「会话通道」（`classifySessionTask` 三态收割） | :43-55 |
| 0.8.8 | 2026-10-19 | `fixAnchors` 行号锚点确定性自动修正（第四层兜底） | :57-66 |
| 0.8.7 | 2026-10-19 | `numberLines` 行号前缀治行号幻觉（三层修复） | :68-78 |
| 0.8.6 | 2026-10-18 | `llmRef` 修 cordis 严格 getter（规划继承对话模型） | :80-90 |
| 0.8.5 | 2026-10-18 | 适配 DSH 0.2.1-rc.2（source 形态 + engines.dsh 声明） | :92-101 |
| 0.8.4 | 2026-10-15 | 文章阶段超预算分割：观察批 map + 合成 reduce | :103-115 |
| 0.8.3 | 2026-10-15 | 规划阶段改走主模型 `runMainModelPlan`（0.10.0 已删除） | :117-126 |
| 0.8.2 | 2026-10-15 | progress schema type 数组致 4 工具全部消失（oneOf 等价修复） | :128-137 |
| 0.8.1 | 2026-10-14 | 工具拒绝编译时报错带命中排除项（`excludedItem`） | :139-146 |
| 0.8.0 | 2026-10-14 | 编译终态实时唤醒发起会话（`wakeCompileSession`） | :148-158 |
| 0.7.0 | 2026-10-14 | `codewiki_update` 工具 + 编译完成提交提醒（`commitHintText`） | :160-168 |
| 0.6.0 | 2026-10-13 | 删除百炼批量通道，全部走普通入口 chat/completions | :170-180 |
| 0.5.0.6 | 2026-10-12 | `codewiki_progress` 只读查进度工具 | :182-191 |
| 0.5.0.5 | 2026-10-11 | 百炼 Batch File → Batch Chat（同步端点实时价 5 折） | :193-200 |
| 0.5.0.4 | 2026-10-11 | 封死「手工流程」改 wiki 的逃生通道（reminderText 收口） | :202-210 |
| 0.5.0.3 | 2026-10-10 | `test-wiki-anchors.mjs` 行号锚点自动校验守卫 | :212-218 |
| 0.5.0.2 | 2026-10-10 | cw 真源码本地重建 fork + 反斜杠 Rust 层根治 | :220-227 |
| 0.5.0.1 | 2026-10-10 | 编译收尾自动补建 `CodeWiki.md` 入口 + Windows 路径收口 | :229-238 |
| 0.5.0 | 2026-10-07 | 面板信息密度改版（六阶段步骤条/双通道吞吐/用量统计） | :240-251 |
| 0.4.11.2 | 2026-10-07 | 阶段实时阈值上限放宽（大仓库强制实时） | :253-258 |
| 0.4.11.1 | 2026-10-07 | 孤儿任务接管（宿主重启僵尸任务修复） | :260-265 |
| 0.4.11 | 2026-10-07 | 任务进度条与逐任务明细（taskList/batchProgress） | :267-274 |
| 0.4.10 | 2026-10-06 | 端点加固与诊断（真宿主 HTTP 400 排查产物） | :276-284 |
| 0.4.9 | 2026-10-06 | 工作区任务过滤（workspaceOnly，hindsight 同机制） | :286-292 |
| 0.4.8 | 2026-10-06 | knownRepos 仓库发现 + 一键排除 + control refresh | :295-301 |
| 0.4.7 | 2026-10-06 | 排除清单 + 自动更新 + 面板三标签页 + GET /api/codewiki/repos | :303-311 |
| 0.4.6 | 2026-10-06 | 面板收敛 + 实时 tps + Temp 残留自动清理 | :313-320 |
| 0.4.5 | 2026-10-06 | 阶段实时阈值 batchMinTokens 混合通道（0.6.0 删除） | :322-328 |
| 0.4.4 | 2026-10-06 | 侧边栏面板完善（真实环境反馈） | :330-338 |
| 0.4.3 | 2026-10-06 | 审查修复：取消可靠性、多实例安全、断点保真 | :340-358 |
| 0.4.2 | 2026-10-06 | 超大任务升 256k 档（3 倍价）继续走批量 | :360-367 |
| 0.4.1 | 2026-10-06 | 横切精准拆分（map-reduce）+ 校对动态预算 | :369-375 |
| 0.4.0 | 2026-10-06 | 服务化全批量流水线：零子代理 + 侧边栏面板 + 32k 分块并行 | :377-387 |
| 0.3.2 | 2026-10-04 | 批量推理异步化：提交即返回，宿主后台链自动收尾 | :389-396 |
| 0.3.1 | 2026-10-04 | 批量凭证自动取模型设置「阿里百炼云」渠道 | :398-402 |
| 0.3.0 | 2026-10-04 | 写文章环节改走百炼批量推理（Batch File，实时价 50%） | :404-414 |
| 0.2.8 | 2026-10-03 | 子代理活动行 label 带模型前缀 | :416-421 |
| 0.2.7 | 2026-10-03 | 插件整体未装载修复（严格 cordis getter 语义） | :423-429 |
| 0.2.6 | 2026-10-03 | 设置页支持选择子代理思考程度 | :431-438 |
| 0.2.5 | 2026-10-03 | wiki 维护提醒注入会话系统提示 | :440-446 |
| 0.2.4 | 2026-10-03 | 子代理模型路由两条编排路径被静默丢弃（修复） | :448-454 |
| 0.2.3 | 2026-10-03 | MSYS 路径误判 / 二进制顺序 / wiki 位置三缺陷 | :456-463 |
| 0.2.2 | 2026-10-02 | 审查修复 8 项（scope=full 不短路等） | :465-476 |
| 0.2.1 | 2026-10-02 | 子代理服务两处接线断裂（0.1.0 起从未真正可用） | :478-484 |
| 0.2.0 | 2026-10-01 | 插件页设置 UI（client.js 浏览器半侧） | :486-494 |
| 0.1.1 | 2026-10-01 | 移除 codewiki 技能、默认模型改 aliyun-bailian/qwen3.8-flash | :496-499 |
| 0.1.0 | 2026-10-01 | 首次发布 + CLI 冒烟验证记录 | :501-515 |

**演进主线**（时期归纳，9 段）：

1. **0.1.x（10-01）**：子代理编排时代。cw CLI 封装 + `codewiki_generate` 智能体编排（规划 → 分批写文章 → 横切 → 审校 → index/meta update），带技能、默认走便宜模型（CHANGELOG.md:501-515、CHANGELOG.md:496-499）。
2. **0.2.x（10-01→10-03）**：工程化补课。设置页 UI（0.2.0）、接线/路由/路径/严格语义四类修复（0.2.1/0.2.3/0.2.4/0.2.7）、系统提示维护提醒（0.2.5）、思考程度设置（0.2.6）。
3. **0.3.x（10-04）**：成本优化第一轮。写文章环节转百炼批量推理（0.3.0）→ 凭证自动解析（0.3.1）→ 批量异步化（0.3.2）。
4. **0.4.x（10-06→10-07）**：架构定型。服务化流水线零子代理（0.4.0）、横切 map-reduce + 校对动态预算（0.4.1）、取消/多实例/断点审查修复（0.4.3）、面板与运维能力齐备（0.4.4-0.4.11.2：排除清单、自动更新、工作区过滤、进度条、孤儿接管）。
5. **0.5.x（10-07→10-12）**：可靠性收口。面板改版（0.5.0）、CodeWiki.md 入口自动补建（0.5.0.1）、cw fork 重建（0.5.0.2）、锚点守卫与封死手改（0.5.0.3/0.5.0.4）、Batch Chat（0.5.0.5）、progress 工具（0.5.0.6）。
6. **0.6.0（10-13）**：删除批量专用通道，全部走普通入口；后台执行器骨架保留（CHANGELOG.md:170-180）。
7. **0.7.0-0.8.x（10-14→10-19）**：与宿主/会话的协同。codewiki_update + 提交提醒（0.7.0）、实时唤醒（0.8.0）、宿主适配与 schema 修复（0.8.2/0.8.5）、规划主模型两轮（0.8.3 引入、0.8.6 修复、0.10.0 删除）、行号幻觉三层修复 + fixAnchors（0.8.7/0.8.8）。
8. **0.9.x（10-21→10-23）**：会话通道与模型开放。超预算文章/校对转会话通道（0.9.0）、编译模型开放宿主任意 provider/model（0.9.1）、sessionTier（0.9.2）。
9. **0.10.0（10-23）**：当前形态。免费 hy3 主模型（`workbuddy`/`hy3`）、全流程回插件内、单项目串行、思考程度从模型目录读取（CHANGELOG.md:3-16）。

## Architecture

```text
   使用者（agent/人类）读取顺序：① 定位上手  ② 结构概念  ③ 演进查询
          │                     │                      │
          ▼                     ▼                      ▼
 ┌──────────────────┐  ┌───────────────────┐  ┌─────────────────────┐
 │ README.md（65行）│  │ CodeWiki.md（65行）│  │ CHANGELOG.md（515行）│
 │ 工具表 :5-13     │  │ 组件清单 :9-28    │  │ 版本节倒序 :3-515   │
 │ 设置表 :24-38    │  │ 架构图 :30-47     │  │ 50 版 0.1.0→0.10.0  │
 │ 安装 :40-55      │  │ 已知问题 :58-65   │  │ 每版=背景+实现+测试 │
 └────────┬─────────┘  └─────────┬─────────┘  └─────────────────────┘
          │                      │ CodeWiki.md 公约（:3）
          │                      ▼
          │        codewiki_generate 全量编译（六环节流水线）
          │                      ▼
          │        <repo>/.codewiki/ 文章群（本文即产物之一）
          │
          └── 版本发布：CHANGELOG 顶部插入新节 + README/CodeWiki 同步改写
              （同步存证 = 各版「文档：」条目，如 CHANGELOG.md:16/:55/:463）
```

## Data Flow

**消费流（读）**——三类典型入口：

1. 新会话定位工具与行为口径：README.md:5-13（工具表）→ README.md:15-22（generate 关键行为）→ README.md:24-38（设置表）。
2. 理解代码结构：CodeWiki.md:9-28（组件清单按 `index.js:行号` 跳源码）→ CodeWiki.md:30-47（流水线全景）→ 更细粒度读 `<repo>/.codewiki/` 文章群（由 CodeWiki.md 入口编译产出）。
3. 追溯决策：按本文 Key Components 的版本索引表定位 CHANGELOG 节 → 读「背景（用户需求）」拿决策原因、「实现 ①②③」拿改动位置、「测试」拿验证手段。

**维护流（写）**——三份文档的更新纪律：

1. 版本发布时 CHANGELOG.md 顶部插入新 `## <版本> — <日期>` 节（倒序追加，当前最新为 0.10.0，CHANGELOG.md:3），README/CodeWiki.md 受影响段落同步改写；同步动作以「文档：」条目存证（如 0.10.0 CHANGELOG.md:16、0.9.0 CHANGELOG.md:55、0.2.3 CHANGELOG.md:463）。
2. `.codewiki/` 文章群（含本文）由 `codewiki_generate` 流水线产出，收尾必须调用它更新（CHANGELOG.md:207 记录的纪律：手改不进流水线、不被面板记录、会被下次编译覆盖）。
3. `updateReminder` 三层提醒机制保障前两条被执行：系统提示 section（0.2.5，CHANGELOG.md:440-446）→ 编译完成提交提醒（0.7.0，CHANGELOG.md:160-168）→ 终态实时 steer 唤醒（0.8.0，CHANGELOG.md:148-158）；三层语义汇总见 README.md:37。

## Connections

- [[codewiki-upstream]] — 上游 vendor 模块。CodeWiki.md:62 直接回链它（wiki 布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`）；README.md:60 与 CHANGELOG 0.5.0.2（CHANGELOG.md:239-246）记录 vendor fork 的维护方式（config.rs `wiki_path()` 魔改、main.rs `rel_path_string()` 反斜杠根治、FORK.md 规格）。
- [[documentation-and-config]] — index.js 配置与工具定义的模块文章；CHANGELOG.md:65（0.8.8 节）记录 `fixAnchors` 对它的真实验证——8 处修正全部命中真实行号（Config 37、prepareArticleTasks 538-594、updateToolDefinition 2113、progressToolDefinition 2184-2280）。
- 三份文档与 `.codewiki/` 文章群是**引用与被引用**关系：本文引用 README/CodeWiki/CHANGELOG 的行号；反过来 CodeWiki.md:9-28 的组件清单是指向 index.js/client.js 各专题文章的天然索引。

## Known Issues

1. **文档与代码的同步是纪律不是机制**：README/CodeWiki.md/CHANGELOG.md 均为手写，同步依赖版本发布流程自觉（存证仅到「文档：」条目粒度）。接手任何行为疑问时，先读 CHANGELOG.md:3-16（最新版本节）确认当前口径，不要引用旧版本节的描述——例如 0.8.3 的「规划走主模型」已被 0.10.0 删除（CHANGELOG.md:9）。
2. **文档内嵌的 index.js 行号指针会随代码演进漂移**：CodeWiki.md:12 的 `Config`（index.js:42）等指针在后续版本可能过期。行号可靠性本身有专门机制链：0.8.7 `numberLines` 行号前缀（CHANGELOG.md:68-78）→ 0.8.8 `fixAnchors` 确定性修正（CHANGELOG.md:57-66）→ 守卫测试 `test-wiki-anchors.mjs`（0.5.0.3，CHANGELOG.md:212-218）。
3. **CHANGELOG 的测试断言数是历史快照**：如「107 → 118 项全过」（CHANGELOG.md:15）是当轮全量计数，不能据此推断当前测试规模；当前规模以重跑 `node test-orchestration.mjs` 等为准（README.md:65）。
4. **版本号存在四段补丁形态**（0.4.11.2、0.5.0.5 等），且 0.5.0.x 曾单日三版（0.5.0.1/0.5.0.2/0.5.0.3 均为 2026-10-10，CHANGELOG.md:220、CHANGELOG.md:229、CHANGELOG.md:212）；版本比较需逐段比较，不能按两段语义化版本惯例。
5. **CodeWiki.md:58-65 的六条已知问题挂在文档里，无独立 issue 跟踪**：插件注册不热加载（CodeWiki.md:60）、schemastery junction 需重建（CodeWiki.md:61）、`cw` 无 `--version` / path fallback（CodeWiki.md:62）、stale 反斜杠已归一（CodeWiki.md:63）、断点文件仅记 stage/crosscutSplit（CodeWiki.md:64）、会话通道依赖发起会话（CodeWiki.md:65）——排查插件行为异常时先对照这六条。