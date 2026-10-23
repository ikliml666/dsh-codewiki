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

本模块是仓库根三份「项目文档」的地图与行号索引——它们不是代码，但承担着插件的对外说明、架构速查与演进史三重职责：

| 文件 | 行数 | 角色 | 主要读者 |
|------|------|------|----------|
| `README.md` | 65 行 | 使用者手册：工具表、设置项、安装步骤、开发约定 | 想装/想用本插件的人与 agent |
| `CodeWiki.md` | 65 行 | 本仓库自身 wiki 的入口文件（CodeWiki.md 公约）：架构速查 + 组件清单 + 已知问题 | 想理解/改动代码的人与 agent |
| `CHANGELOG.md` | 541 行 | 完整版本演进史：52 个版本节（0.1.0 → 0.10.2，2026-10-01 至 2026-10-23），最新在顶 | 排查回归、查行为何时引入的人与 agent |

三份文档的当前口径均为 **0.10.2（2026-10-23）**。阅读顺序建议：上手先读 `README.md:5-22`（工具表 + 关键行为）；查配置读 `README.md:24-38`；理解架构读 `CodeWiki.md:30-47`（框图）；查「某行为是哪个版本引入/删除」用本文 Key Components 里的 CHANGELOG 版本索引表。

⚠️ 已知不一致（详见 Known Issues 第 1 条）：0.10.2 把会话通道装填上限从 150k 收到 128k，但文档同步不彻底，`README.md:10`、`CodeWiki.md:7`、`CodeWiki.md:12`、`CodeWiki.md:16`、`CodeWiki.md:56` 五处仍残留「150k」旧值；引用该预算时**以 128000 为准**（依据 `CHANGELOG.md:8` 与 `README.md:31`、`CodeWiki.md:41`）。

## Key Components

### README.md — 使用者手册（:1-65）

- `README.md:1` 标题 `@local/dsh-codewiki`；`README.md:3` 一句话定位：把 [mraza007/codewiki]（Rust CLI `cw`，MIT）接入 DeepSeek Harness，wiki 落在仓库内 `<repo>/.codewiki/` 随仓库提交共享。
- `README.md:5-13` 「提供」工具表（5 行）：
  - `:9` `cw` — CLI 薄封装，子命令白名单 `status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall`。
  - `:10` `codewiki_generate` — 提交制编译：判态 → 提交后台 job 立即返回 → 宿主常驻服务按 规划→写文章→横切→审校→索引 推进；全部模型环节插件内完成（默认 `workbuddy`/`hy3`，192k 上下文，单请求输入预算 110k）；⚠️ 本行末尾「连 150k 都装不下才转会话通道」是 0.10.2 未同步的残留（应为 128k）。
  - `:11` `codewiki_update` — 日常维护入口（0.7.0 起）：固定 scope=auto，调用即返回并明确「继续下一项、不要等待」；编译完成后 steer 直达发起会话（0.8.0 起）并注入「编译完成·请提交改动」提醒，把提交动作交回模型（插件不代跑 git）。
  - `:12` `codewiki_progress` — 只读查进度（0.5.0.6 起）：stage/百分比/已写失败篇数/失败原因，立即返回不等待，与面板同源。
  - `:13` CodeWiki 设置页 — 插件管理页 Official 组条目（id `codewiki`），`view=summary` 一行简介 / `view=page` 完整表单。
- `README.md:15-22` `codewiki_generate` 关键行为 6 条：`:17` scope=auto 三态（无 wiki/未编译→全量；有变更→逐篇更新；最新→直接报告）；`:18` 全部模型环节共用 `batchProvider`/`batchModel` 一个模型，不委托发起会话的主模型；`:19` 单篇失败只记账不中断，全部失败不刷新基线（`meta update` 不执行，可安全重试）；`:20` 并发 `maxConcurrency` 默认 2（硬顶 8）；`:21` `serialProjects` 默认开（单项目串行，后提交项目进 `queued` 排队，前一个收尾后自动轮到）；`:22` `scope=full` 跳过 clean 短路强制全量。
- `README.md:24-38` 设置段（命名空间 `codewiki`，全部 volatile 热生效 `:38`）：
  - `:26` 设置页说明：`configForms.mutate` 单层 op 保存，与 patch 手改等价；0.9.1 起「编译模型」是 provider/model 两级下拉（目录来自 `/api/codewiki/models`，不读插件配置）；0.10.0 起思考程度从 `/api/codewiki/model-efforts` 读取，不再手填。
  - `:29` `batchProvider` / `batchModel` — 编译模型，默认 `workbuddy`/`hy3`（免费、192k 上下文）；0.10.1 起是**唯一通道**，provider 必须指向模型设置里已注册的提供商，留空直接提交失败，插件不保存任何 API Key；本地 OpenAI 兼容端点只要注册过就能选到。
  - `:30` `batchReasoningEffort` — 思考档位 id，可选值不手填，设置页从模型目录实时读取（`GET /api/codewiki/model-efforts`）；留空 = 该模型的默认档。
  - `:31` `sessionTier`（0.9.2）— 仅超大单文件兜底时才用：超 110k 单请求预算先按 128k 大档重装（仍在插件内），连 128k 都装不下才转会话通道，此时钉死的子智能体档位 id（如 `codeiwiki`）；留空 = 自动选路。
  - `:33` `binaryPath` — cw 路径；顺序：binaryPath → PATH 探测 → 捆绑兜底（0.2.3 起）。
  - `:34` `maxConcurrency` — 默认 2（1–8，硬顶 8）。
  - `:35` `serialProjects` — 单项目串行，默认开（0.10.0）：避免多项目同时编译抢占同一个免费额度。
  - `:36` `articleLanguage` — 文章语言，默认中文。
  - `:37` `updateReminder` — 系统提示注入维护提醒（0.2.5 起），仅当会话仓库存在 `.codewiki/` 时出现；0.7.0 起同一 section 兼职编译完成提醒（编译完成时间晚于 wiki 最后提交 → 注入「编译完成·请提交改动」）；0.8.0 起编译终态另有实时唤醒（steer，与子代理消息同机制）。
- `README.md:45-60` 安装 4 步：`:44` 源码位置；`:45-52` profile `cordis.patch.yml` 顶层 `insert` 条目（id `codewiki` + file:/// 直挂 URL）；`:54` `@deepseek-ai/schemastery` 走插件本地 junction；`:55` 重启生效，client 半侧由 `package.json` 的 `dsh.client.platform: "web"` + `exports["./client"]` 声明驱动。
- `README.md:57-65` 开发段：`:60-62` 目录三行（`vendor/codewiki/` 上游源码（去 .git）、`bin/cw.exe` cargo 产物 git 跟踪、`client.js` 浏览器半侧）；`:65` 验证命令 `node --check index.js client.js` + 编排冒烟 `node test-orchestration.mjs`。

### CodeWiki.md — wiki 入口与架构速查（:1-65）

- `CodeWiki.md:3` 入口声明：本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约），重启 dsh 后可用 `codewiki_generate` 全量编译细化成 `<repo>/.codewiki/` 文章。（入口文件本身由 0.5.0.1 起「编译收尾自动补建」，见 `CHANGELOG.md:255-265`。）
- `CodeWiki.md:5-7` Overview：编译完全不走子代理、不委托发起会话的主模型；`codewiki_generate` 纯提交制，六环节（规划/写文章/横切/合成/审校/索引收尾，合成仅横切超预算拆分时出现）全部插件内由编译模型通道完成；token 预算 110k 分块装填；横切超预算自动 map-reduce 拆分；`serialProjects` 排队。⚠️ `:7` 末段「连 150k 大档都装不下才转会话通道」是残留（应为 128k）。
- `CodeWiki.md:9-28` Key Components（描述 `index.js` / `client.js` 的组件清单——实现细节见 [[plugin-core]] 与 [[client-interface]]）：
  - `:11-21` `index.js`（单文件 Node ESM）：`:12` `Config`（index.js:42，⚠️ 本条「仅超 150k 兜底」为残留）；`:13` `buildSessionSteerText`（0.9.2 纯函数，会话通道 steer 文本唯一生成处，tier 非空时要求 delegate 显式传 tier——编译主链不走档位路由，只有这段经过 delegate）；`:14` `installUpdateReminder`（`agent/created` 注册 section `codewiki:update-reminder`，门控看 `<repo>/CodeWiki.md` 入口而非 `.codewiki/` 目录，服务缺失静默跳过）；`:15` `runCw` / `parseStatus`（三态判定 missing/uncompiled/clean/stale）；`:16` 模型执行模块（`estimateTokens` / `collectSources` / `prepareArticleTasks` / `classifySessionTask` / `startBatchChatRun`+`submitBatchFor`+`settleJob` / `runRealtimeTasks` / `llmChat` / `listModelCatalog` / `resolveModelEfforts`，⚠️ 本条「单文件连 150k 大档」为残留）；`:17` `createJobService`（tick 10s、七阶段机 queued→plan→articles→crosscut→compose→review→index、单项目串行闸门、会话通道三函数、jobs.json 持久化、断点文件、`writeValidated`）；`:18` `cwToolDefinition`（子命令白名单）；`:19` `generateToolDefinition`（纯提交制：判态→断点续查→任务预构建→submit，零 LLM 调用）；`:20` 四个 webServer 端点（仅回环放行：jobs/repos/models/control）；`:21` `apply`。
  - `:22` `vendor/codewiki/` 上游源码（去 .git）+ `bin/cw.exe` cargo 产物（git 跟踪）。
  - `:23-26` `client.js`：`:24` 注册（`plugins.item` order 30 + `main`/`sidebar.panellist` 双 slot order 52）；`:25` `CodewikiCard`（设置表单：运行节 + 编译模型节，provider/model 目录与思考档位来自两个回环端点，0.10.1 删思考预算输入与 provider 空值项）；`:26` `CodewikiPanel`（2s 轮询、七阶段步骤条、双通道吞吐徽标、用量行、活动流、取消）。
  - `:27` `cordis.patch.yml` 挂载补丁；`:28` `package.json` client 扫描声明（改 dsh.client 后需重启）。
- `CodeWiki.md:30-47` Architecture 框图（```text 围栏）：模型调用 codewiki_generate → 任务预构建 → JobService.submit 即返回 → 宿主后台 tick 10s 推进阶段机 → cw index + meta update，加面板 2s 轮询支线；`:41` 标注「文章/校对单文件超 128k 才转会话通道兜底」（已是 128k 口径）。
- `CodeWiki.md:49-51` Data Flow 四条流（`:51`）：配置流（patch config → cordis 注入 apply → liveConfig 每次解包热读）、凭证流（插件不保存也不传递任何密钥，请求走宿主 `llm.stream()`，凭证由 provider 自身配置解析）、任务流（预构建 → jobs.json 持久化 → tick 消费（先排队）→ 批次断点 → 落盘/回写 → cw index/meta update）、面板流（浏览器 2s 轮询回环端点）。
- `CodeWiki.md:53-56` Connections：`:55` [[codewiki-upstream]]（vendor/codewiki 布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`）；`:56` 宿主模型目录（`llm.listProviders`/`listModels`/`resolveModel`；⚠️ 本条仍写 `BATCH_TOKEN_HARD_LIMIT=150000`，应为 128000）。
- `CodeWiki.md:58-65` Known Issues 六条：`:60` 插件注册/client 声明不热加载（需重启 dsh）；`:61` schemastery junction 换机器需重建；`:62` 上游 `cw` 无 `--version`、未 init 仓库 `cw path` 走插件 fallback；`:63` 上游 stale 路径反斜杠已归一；`:64` 断点文件仅记阶段机位置（0.5.x 批量 24h 窗口语义已随 0.6.0 删除）；`:65` 会话通道任务依赖发起会话可用（面板/自动调度提交的 job 无会话可 steer，直接失败并明示原因；超时默认 30 分钟）。

### CHANGELOG.md — 版本演进史（:1-541）

`CHANGELOG.md:1` 标题；`:2` 起为版本节，**倒序排列（最新在顶）**。0.10.2 时共 52 个版本节，全部节头行号如下（区间 = 本节头到下一节头前一行；最新节在最上 `:3`）：

| 版本 | 日期 | 主题 | 行号 |
|------|------|------|------|
| 0.10.2 | 2026-10-23 | 大档装填上限 150k 越界修复：`BATCH_TOKEN_HARD_LIMIT` 150000→128000（192000−64000），`BATCH_TOKEN_BUDGET` 维持 110000 | :3-14 |
| 0.10.1 | 2026-10-23 | 删除内置百炼直连通道（`bailianChat`、`resolveBatchApiKey`），编译只走模型设置里的 provider，`batchProvider` 留空即提交失败 | :15-28 |
| 0.10.0 | 2026-10-23 | 默认 `workbuddy`/`hy3` 主模型；预算 110k/150k 重算；删 `runMainModelPlan`；`resolveModelEfforts` + `/api/codewiki/model-efforts`；`serialProjects` 默认开；并发默认 2 | :29-43 |
| 0.9.2 | 2026-10-23 | 自建 `sessionTier` 档位打通（排查结论：编译主链不问档位）；`buildSessionSteerText` 收口 steer 文案 | :44-56 |
| 0.9.1 | 2026-10-22 | 编译模型可选宿主已注册 provider/model（本地 9B 可用）；`listModelCatalog` + `GET /api/codewiki/models` | :57-68 |
| 0.9.0 | 2026-10-21 | 超预算文章/校对转「会话通道」（`dispatchSessionTasks`/`progressSessionTasks`/`classifySessionTask` 三态收割，超时默认 30 分钟） | :69-82 |
| 0.8.8 | 2026-10-19 | `fixAnchors` 行号锚点确定性自动修正（第四层兜底） | :83-93 |
| 0.8.7 | 2026-10-19 | `numberLines` 行号前缀治行号幻觉（三层修复） | :94-105 |
| 0.8.6 | 2026-10-18 | `llmRef` 修 cordis 严格 getter（规划真正继承对话模型） | :106-117 |
| 0.8.5 | 2026-10-18 | 适配 DSH 0.2.1-rc.2（source 形态 `{kind:'plugin:codewiki'}` + `engines.dsh` 声明） | :118-128 |
| 0.8.4 | 2026-10-15 | 文章阶段超预算分割：观察批 map + 合成请求 reduce（避开 32k 三倍价） | :129-142 |
| 0.8.3 | 2026-10-15 | 规划阶段改走主模型 `runMainModelPlan`（0.10.0 已删除） | :143-153 |
| 0.8.2 | 2026-10-15 | progress schema `type` 数组致 4 工具全部消失（`oneOf` 等价形态修复） | :154-164 |
| 0.8.1 | 2026-10-14 | 工具拒绝编译时报错带命中的排除项（`excludedItem`） | :165-173 |
| 0.8.0 | 2026-10-14 | 编译终态实时唤醒发起会话（`wakeCompileSession`，借用子代理 send_message 机制） | :174-185 |
| 0.7.0 | 2026-10-14 | 新增 `codewiki_update` 日常维护工具 + 编译完成提交提醒（`commitHintText`） | :186-195 |
| 0.6.0 | 2026-10-13 | 删除百炼批量推理通道，编译全部改走普通入口（batchMinTokens 等设置删除） | :196-207 |
| 0.5.0.6 | 2026-10-12 | 新增 `codewiki_progress` 只读查进度工具 | :208-218 |
| 0.5.0.5 | 2026-10-11 | 百炼通道从 Batch File 切换为 Batch Chat（同步端点实时价 5 折） | :219-227 |
| 0.5.0.4 | 2026-10-11 | 封死「手工流程」逃生通道：reminderText 收口为「收尾必须调用 codewiki_generate」 | :228-237 |
| 0.5.0.3 | 2026-10-10 | `test-wiki-anchors.mjs` 行号锚点自动校验守卫 | :238-245 |
| 0.5.0.2 | 2026-10-10 | cw 真源码本地重建（vendor/codewiki 成为可维护 fork）+ 反斜杠 Rust 层根治 | :246-254 |
| 0.5.0.1 | 2026-10-10 | 编译收尾自动补建 CodeWiki.md 入口 + Windows 路径规范化收口 | :255-265 |
| 0.5.0 | 2026-10-07 | 面板信息密度改版（六阶段步骤条/双通道吞吐/用量统计/加权总进度） | :266-278 |
| 0.4.11.2 | 2026-10-07 | 阶段实时阈值上限放宽（大仓库强制实时） | :279-285 |
| 0.4.11.1 | 2026-10-07 | 孤儿任务接管（宿主重启僵尸任务修复，心跳停更 5 分钟判定） | :286-292 |
| 0.4.11 | 2026-10-07 | 任务进度条与逐任务明细（`taskList`/`batchProgress`） | :293-301 |
| 0.4.10 | 2026-10-06 | 端点加固与诊断（workspaceRegistry 降级、500+stack、`DSH_CODEWIKI_REPOS_FILE`、output schema 修复） | :302-311 |
| 0.4.9 | 2026-10-06 | 工作区任务过滤（workspaceOnly，hindsight 同机制） | :312-319 |
| 0.4.8 | 2026-10-06 | knownRepos 仓库发现 + 一键排除 + control refresh | :320-328 |
| 0.4.7 | 2026-10-06 | excludePaths 排除清单 + 自动更新 + 面板三标签页 + `GET /api/codewiki/repos` | :329-338 |
| 0.4.6 | 2026-10-06 | 面板收敛（焦点卡片）+ 实时 tps + Temp 残留自动清理 | :339-347 |
| 0.4.5 | 2026-10-06 | 阶段实时阈值 batchMinTokens 混合通道（0.6.0 随批量通道一并删除） | :348-355 |
| 0.4.4 | 2026-10-06 | 侧边栏面板完善（滚动/工作区分组/设置入面板/Key 遮蔽） | :356-365 |
| 0.4.3 | 2026-10-06 | 审查修复：取消可靠性（jobServiceRef 多实例串台根因）、多实例安全、断点保真 | :366-385 |
| 0.4.2 | 2026-10-06 | 超大任务升 256k 档（3 倍价）继续走批量 | :386-394 |
| 0.4.1 | 2026-10-06 | 横切精准拆分（map-reduce）+ 校对动态预算 | :395-402 |
| 0.4.0 | 2026-10-06 | 服务化全批量流水线：零子代理 + 侧边栏面板 + 32k 分块并行（架构定型） | :403-414 |
| 0.3.2 | 2026-10-04 | 批量推理异步化：提交即返回，宿主后台链自动收尾（batchAsync） | :415-423 |
| 0.3.1 | 2026-10-04 | 批量凭证自动取模型设置「阿里百炼云」渠道（resolveBatchApiKey，0.10.1 删） | :424-429 |
| 0.3.0 | 2026-10-04 | 写文章环节改走百炼批量推理（Batch File，实时价 50%） | :430-441 |
| 0.2.8 | 2026-10-03 | 子代理活动行 label 带模型前缀 | :442-448 |
| 0.2.7 | 2026-10-03 | 插件整体未装载修复（严格 cordis getter 语义：未 inject 访问即抛） | :449-456 |
| 0.2.6 | 2026-10-03 | 设置页支持选择子代理思考程度（defaultReasoningEffort） | :457-465 |
| 0.2.5 | 2026-10-03 | wiki 维护提醒注入会话系统提示（installUpdateReminder） | :466-473 |
| 0.2.4 | 2026-10-03 | 子代理模型路由两条编排路径被静默丢弃（修复） | :474-481 |
| 0.2.3 | 2026-10-03 | MSYS 路径误判/二进制顺序/wiki 位置三缺陷（normalizeCwd 引入） | :482-490 |
| 0.2.2 | 2026-10-02 | 审查修复 8 项（scope=full 不被 clean 短路等） | :491-503 |
| 0.2.1 | 2026-10-02 | 子代理服务两处接线断裂（codewiki_generate 一进编译路径即抛，0.1.0 起从未真正可用） | :504-511 |
| 0.2.0 | 2026-10-01 | 插件页设置 UI（client.js 浏览器半侧首次出现） | :512-521 |
| 0.1.1 | 2026-10-01 | 移除 codewiki 技能；默认模型改 aliyun-bailian/qwen3.8-flash | :522-526 |
| 0.1.0 | 2026-10-01 | 首次发布（cw + codewiki_generate + vendor 编译）+ CLI 冒烟验证记录 | :527-541 |

演进主线（时间正序，7 段）：

1. **0.1.x 奠基期（:522-541）**：0.1.0 首发工具面（`cw` CLI 封装 + `codewiki_generate` 子代理编排 + vendor 上游编译，`:527-541`）；0.1.1 删技能只留纯工具面、默认模型固定百炼 qwen3.8-flash（`:522-526`）。
2. **0.2.x 子代理编排修补期（:442-521）**：设置 UI 落地（0.2.0 `:512-521`）后发现整条编排路径从未真正可用——0.2.1 两处接线断裂（`:504-511`）、0.2.2 审查 8 项（`:491-503`）、0.2.3 路径三缺陷（`:482-490`）、0.2.4 路由静默丢弃（`:474-481`）接连修复；0.2.5 系统提示提醒（`:466-473`）、0.2.6 思考程度（`:457-465`）、0.2.7 整体未装载（严格 cordis 语义，`:449-456`）、0.2.8 label 前缀（`:442-448`）。
3. **0.3.x-0.4.x 批量降本与服务化（:286-441）**：0.3.0 写文章走百炼批量（`:430-441`）→ 0.3.1 凭证自动化（`:424-429`）→ 0.3.2 异步化（`:415-423`）→ **0.4.0 服务化全批量流水线（架构定型：纯提交制 + 宿主常驻 JobService + 零子代理 + 侧边栏面板，`:403-414`）** → 0.4.1 横切 map-reduce（`:395-402`）→ 0.4.2 升 256k 档（`:386-394`）→ 0.4.3 审查修复（`:366-385`）→ 0.4.4-0.4.11 面板与仓库管理（`:279-365`）。
4. **0.5.0.x 质量与 fork 期（:208-278）**：面板改版（0.5.0 `:266-278`）→ CodeWiki.md 入口自动补建（0.5.0.1 `:255-265`）→ vendor fork 重建（0.5.0.2 `:246-254`）→ 锚点守卫测试（0.5.0.3 `:238-245`）→ 封死手工流程（0.5.0.4 `:228-237`）→ Batch Chat（0.5.0.5 `:219-227`）→ progress 工具（0.5.0.6 `:208-218`）。
5. **0.6.0-0.8.5 全实时化与可靠性期（:118-207）**：0.6.0 删批量通道全走普通入口（`:196-207`）→ 0.7.0 update 工具 + 提交提醒（`:186-195`）→ 0.8.0 实时唤醒（`:174-185`）→ 0.8.1/0.8.2 修复（`:154-173`）→ 0.8.3 主模型规划（`:143-153`，后被 0.10.0 删）→ 0.8.4 观察批分割（`:129-142`）→ 0.8.5 DSH 0.2.1-rc.2 适配（`:118-128`）。
6. **0.8.6-0.9.x 锚点与会话通道期（:44-117）**：0.8.6 `llmRef`（`:106-117`）→ 0.8.7/0.8.8 行号锚点双层修复（`:94-105`、`:83-93`）→ 0.9.0 超预算转会话通道（`:69-82`）→ 0.9.1 编译模型可选宿主 provider（`:57-68`）→ 0.9.2 `sessionTier`（`:44-56`）。
7. **0.10.x 现状定型（:3-43）**：0.10.0 hy3 免费主模型 + 全流程回插件内 + 单项目串行（`:29-43`）→ 0.10.1 唯一通道（删百炼直连，`:15-28`）→ 0.10.2 大档 128k 修复（`:3-14`）。

## Architecture

三份文档的分工与联动（行号为 0.10.2 时刻快照）：

```text
┌────────────────────────────────────────────────────────────┐
│           仓库根项目文档三件套（本模块全部内容）            │
├────────────────────┬───────────────────┬───────────────────┤
│ README.md  :1-65   │ CodeWiki.md :1-65 │ CHANGELOG.md      │
│ 使用者手册：       │ wiki 入口公约：   │ :1-541（52 版）   │
│ · 工具表    :5-13  │ · Overview :5-7   │ · 最新节在顶 :3   │
│ · 关键行为  :15-22 │ · 组件清单 :9-28  │ · 最早节在底      │
│ · 设置      :24-38 │ · 架构框图 :30-47 │   :527（0.1.0）   │
│ · 安装      :40-55 │ · Data Flow :49-51│ · 版本倒序排列    │
│ · 开发      :57-65 │ · 已知问题 :58-65 │                   │
└─────────┬──────────┴────────┬──────────┴─────────┬─────────┘
          │ 描述的对象         │ 架构口径同源        │ 行号锚点
          ▼                    ▼                    ▼
   [[plugin-core]]      [[documentation-     每次发布在 :3 前
   等实现模块文章        and-config]] 等      插入新节，其后全部
                        文章                  旧行号整体下移
```

## Data Flow

两条流向：

- **消费流（agent 读文档）**：上手/装插件 → `README.md:5-22`（工具表与关键行为）+ `README.md:40-55`（安装）；查/改设置 → `README.md:24-38`（设置段）+ `CodeWiki.md:12`（Config 字段）；理解架构 → `CodeWiki.md:30-47`（框图）+ `CodeWiki.md:49-51`（四条流）；排查「行为何时引入/删除」 → 本文版本索引表 → CHANGELOG 对应版本节原文；遇到已知坑 → `CodeWiki.md:58-65` + 本文 Known Issues。
- **维护流（发布版本时写文档）**：版本发布 → ① `CHANGELOG.md` 在 `:3` 前插入新版本节（倒序约定，含背景/实现/测试/文档同步各条）→ ② 同步 `README.md` 工具表/设置段（例：0.10.2 的 `CHANGELOG.md:11`「README 的 sessionTier 段」）→ ③ 同步 `CodeWiki.md` 架构口径（例：同条「CodeWiki.md 架构图的超预算说明同步为 128k」）→ ④ `package.json` 版本号 → ⑤ 收尾调用 `codewiki_generate` 重编译 wiki（0.5.0.4 起的硬纪律，`CHANGELOG.md:233`：「收尾未调用 codewiki_generate 视为任务未完成」）。

同步的可靠性依赖锚点守卫链：`numberLines`（0.8.7，`CHANGELOG.md:94-105`）→ `fixAnchors`（0.8.8，`CHANGELOG.md:83-93`）→ `test-wiki-anchors.mjs` 守卫（0.5.0.3，`CHANGELOG.md:238-245`），详见 [[wiki-tests]]。

## Connections

- [[plugin-core]] — README/CodeWiki.md 所描述的 `index.js` 插件主体（Config、JobService、工具定义等）。
- [[client-interface]] — `client.js` 设置卡与侧边栏面板（`README.md:13`、`CodeWiki.md:23-26` 描述的对象）。
- [[configuration-and-metadata]] — `package.json`（版本号与 CHANGELOG 版本一一对应）与 `cordis.patch.yml`（安装挂载）。
- [[documentation-and-config]] — 文档同步行为在 CHANGELOG 各版本节中的记录与 0.5.0.4 封死手工流程的维护公约。
- [[codewiki-upstream]] — vendor/codewiki 上游（`CodeWiki.md:55` 引用的上游布局与 fork 说明）。
- [[wiki-tests]] — `test-wiki-anchors.mjs` 行号锚点守卫（本文引用的全部行号的最后防线）。

## Known Issues

1. **0.10.2 文档同步不彻底（150k/128k 并存）**：`CHANGELOG.md:8` 把 `BATCH_TOKEN_HARD_LIMIT` 改为 128000，`CHANGELOG.md:11` 声明文档同步范围只覆盖「README 的 sessionTier 段、CodeWiki.md 架构图」——因此 `README.md:10`（工具表「连 150k 都装不下」）、`CodeWiki.md:56`（Overview「150k 大档」）、`CodeWiki.md:56`（Config 条目「仅超 150k 兜底」）、`CodeWiki.md:56`（prepareArticleTasks「连 150k 大档」）、`CodeWiki.md:56`（Connections「`BATCH_TOKEN_HARD_LIMIT=150000`」）五处仍残留 150k。同一仓库内与 `README.md:31`、`CodeWiki.md:56` 的 128k 口径并存；**引用该预算一律以 128000 为准**，残留点待下个版本清零。
2. **本文行号是快照，必然漂移**：CHANGELOG 倒序加节意味着每次发布后 `:3` 以下全部行号整体下移；本文章所有行号对准 0.10.2（2026-10-23）。历史上流水线产物曾系统性幻觉行号（偏移 34~760 行，`CHANGELOG.md:243`），治理链为 `numberLines` → `fixAnchors` → `test-wiki-anchors.mjs` 守卫——引用行号前若怀疑漂移，以守卫测试与 grep 实测为准。
3. **CHANGELOG 内的测试断言数是历史快照**：如 `CHANGELOG.md:12`「108 项全过」、`CHANGELOG.md:242`「160 断言」均为当版本时点值，不代表当前测试规模；查当前规模直接跑测试套件（见 [[testing-suite]]）。
4. **版本号不总升一位**：0.5.0.x 出现四段式（0.5.0.1~0.5.0.6），是 0.5.0 发布当周的突发修复序列；同理 0.4.11.1/0.4.11.2。字符串排序或版本比较时注意。
5. **六条已知问题挂 CodeWiki.md:58-65**（随该文件维护，本文不重复展开）：插件不热加载、schemastery junction、`cw` 无 `--version`、反斜杠路径、断点文件语义、会话通道依赖发起会话。
6. **CHANGELOG 只增不减、最新在顶**：查「当前行为」先读顶部节（0.10.2，`CHANGELOG.md:3-14`），再按版本索引回溯；被删除的行为（如 0.6.0 删批量通道 `:196-207`、0.10.0 删 `runMainModelPlan` `:36`）只有删除记录没有正文，勿据旧节推断现状。
