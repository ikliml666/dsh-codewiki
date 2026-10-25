---
title: project-docs
type: module
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
tags: [docs, 使用者文档, 上手指南, 演进史, 维护公约]

## Overview

本模块是仓库根三份「项目文档」的地图与行号索引——它们不是代码，但承担着插件的对外说明、架构速查与演进史三重职责：

| 文件 | 行数 | 角色 | 主要读者 |
|------|------|------|----------|
| `README.md` | 67 行 | 使用者手册：工具表、设置项、安装步骤、开发约定 | 想装/想用本插件的人与 agent |
| `CodeWiki.md` | 75 行 | 本仓库自身 wiki 的入口文件（CodeWiki.md 公约）：架构速查 + 组件清单 + 已知问题 | 想理解/改动代码的人与 agent |
| `CHANGELOG.md` | 673 行 | 完整版本演进史：61 个版本节（0.1.0 → 0.10.11，2026-10-01 至 2026-10-25），最新在顶 | 排查回归、查行为何时引入的人与 agent |

三份文档的当前口径：`README.md` 描述的行为对齐到 0.10.9 的架构（默认 `workbuddy`/`hy3`、唯一通道、大档 420k、自动提交 `autoCommit` 等，见 `README.md:10-11`、`README.md:29-39`）；`CodeWiki.md` 描述的行为对齐到 0.10.10（含 `autoCommitState` 三态判定，见 `CodeWiki.md:16`、阶段机 `CodeWiki.md:20`、架构框图 `CodeWiki.md:42-43`）；`CHANGELOG.md` 已记录至 **0.10.11（2026-10-25）**（新增独立 commit 阶段——产物提交改走「主题分支 → 合并回原分支」，见 `CHANGELOG.md:3-15`）。阅读顺序建议：上手先读 `README.md:5-13`（工具表）+ `README.md:15-22`（关键行为）；查配置读 `README.md:24-40`；理解架构读 `CodeWiki.md:5-7`（Overview）与 `CodeWiki.md:33-57`（框图）；查「某行为是哪个版本引入/删除」用本文 Key Components 里的 CHANGELOG 版本索引表。

## Key Components

### README.md — 使用者手册（:1-67）

- `README.md:1` 标题 `@local/dsh-codewiki`；`README.md:3` 一句话定位：把 [mraza007/codewiki]（Rust CLI `cw`，MIT）接入 DeepSeek Harness，wiki 落在仓库内 `<repo>/.codewiki/` 随仓库提交共享。
- `README.md:5-13` 「提供」工具表（表头 `:7`，行 `:9`-`:13`）：
  - `:9` `cw` — CLI 薄封装，子命令白名单 `status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall`。
  - `:10` `codewiki_generate` — 提交制编译：判态 → 提交后台 job 立即返回 → 宿主常驻服务按 写文章 → 横切 → 审校 → 索引 推进（侧边栏 CodeWiki 面板可见，0.10.7 起无规划阶段，模块清单由 localPlan 本地分组），全部模型环节在插件内完成（默认 `workbuddy`/`hy3`，192k 上下文，单请求输入预算 110k；110k–420k 输入自动升大档单请求，0.10.8），零子代理，不委托发起会话的主模型（0.10.0）；只有单模块源码连 420k 大档都装不下时才走观察→合成或会话通道兜底。
  - `:11` `codewiki_update` — 日常维护入口（0.7.0 起）：固定 scope=auto 的提交制更新请求，调用即返回并明确「本步收尾、继续下一项」，不要等待、不要轮询；编译产物由插件自动提交入库（0.10.9，`autoCommit`），**成功时不再唤醒会话**，只有自动提交失败才发一条一次性「产物待提交」降级提醒。
  - `:12` `codewiki_progress` — 只读查进度：提交后随时查 stage/百分比/已写/失败篇数/失败原因，立即返回不等待（数据与侧边栏面板同源）。可选按 `cwd` 或 `jobId` 过滤，都不传列全部任务。
  - `:13` CodeWiki 设置页 — 插件管理页 Official 组出现 CodeWiki 条目（id `codewiki`），点进详情页可改编译模型（provider/model 级联下拉，目录来自 modelCatalog）与运行选项；`view=summary` 一行简介，`view=page` 完整表单 + 保存条。
- `README.md:15-22` `codewiki_generate` 关键行为 6 条：`:17` scope=auto 三态（无 wiki/未编译→全量；有变更→逐篇更新；最新→直接报告）；`:18` 全部模型环节共用 `batchProvider`/`batchModel` 一个模型，不委托发起会话的主模型；`:19` 单篇失败只记账不中断，全部失败不刷新基线（`meta update` 不执行，可安全重试）；`:20` 并发 `maxConcurrency` 默认 2（硬顶 8）；`:21` `serialProjects` 默认开（单项目串行，后提交项目进 `queued` 排队，前一个收尾后自动轮到）；`:22` `scope=full` 跳过 clean 短路强制全量。
- `README.md:24-40` 设置段（命名空间 `codewiki`，全部 volatile 热生效 `:40`）：
  - `:26` 设置页说明：`configForms.mutate` 单层 op 保存，与 patch 手改等价；0.9.1 起「编译模型」是 provider/model 两级下拉（目录来自 `/api/codewiki/models`，不读插件配置）；0.10.0 起思考程度从 `/api/codewiki/model-efforts` 读取，不再手填。
  - `:29` `batchProvider` / `batchModel` — 编译模型，默认 `workbuddy`/`hy3`（免费、192k 上下文）；0.10.1 起是**唯一通道**，provider 必须指向模型设置里已注册的提供商，留空直接提交失败，插件不保存任何 API Key；本地 OpenAI 兼容端点只要注册过就能选到。
  - `:30` `batchReasoningEffort` — 思考档位 id，可选值不手填，设置页从模型目录实时读取（`GET /api/codewiki/model-efforts`）；留空 = 该模型的默认档。
  - `:31-32` `bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget` — 大档模型（0.10.4，0.10.8 全面启用）：默认 `volces-ark`/`glm-5.3-flash` 512k，预算 420k；输入超 110k 普通预算的请求升大档单请求写完；模块源码总量超 420k 才拆观察批；单文件连大档都装不下才转会话通道。`sessionTier`（0.9.2）— 仅超大输入兜底时才用：超 420k 大档装填上限仍装不下才转会话通道，此时钉死的子智能体档位 id（如 `codeiwiki`）；留空 = 自动选路。
  - `:34` `binaryPath` — cw 路径；顺序：binaryPath → PATH 探测 → 捆绑兜底（0.2.3 起）。
  - `:35` `maxConcurrency` — 默认 2（1–8，硬顶 8）。
  - `:36` `serialProjects` — 单项目串行，默认开（0.10.0）。
  - `:37` `articleLanguage` — 文章语言，默认中文。
  - `:38` `updateReminder` — 系统提示注入维护提醒（0.2.5 起），仅当会话仓库存在 `CodeWiki.md` 入口时出现；0.10.9 起同一 section 只兼职**降级**提醒（自动提交失败时「产物待提交」）。
  - `:39` `autoCommit`（0.10.9）— 编译产物自动提交，默认开；成功时完全不打扰会话。
- `README.md:42-57` 安装 4 步：`:46` 源码位置；`:47-54` profile `cordis.patch.yml` 顶层 `insert` 条目（id `codewiki` + file:/// 直挂 URL）；`:56` `@deepseek-ai/schemastery` 走插件本地 junction 与重启生效说明（client 半侧由 `package.json` 的 `dsh.client.platform: "web"` + `exports["./client"]` 声明驱动，`:57` 末句）；`:59-65` 开发段（`:62-64` 目录三行：`vendor/codewiki/` 上游源码、`bin/cw.exe` cargo 产物、`client.js` 浏览器半侧；`:67` 验证命令 `node --check index.js client.js` + 编排冒烟 `node test-orchestration.mjs`）。

### CodeWiki.md — wiki 入口与架构速查（:1-75）

- `CodeWiki.md:3` 入口声明：本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约），重启 dsh 后可用 `codewiki_generate` 全量编译细化成 `<repo>/.codewiki/` 文章。（入口文件本身由 0.5.0.1 起「编译收尾自动补建」，见 `CHANGELOG.md:387-396`。）
- `CodeWiki.md:5-7` Overview：编译完全不走子代理、不委托发起会话的主模型；`codewiki_generate` 纯提交制，五环节（写文章/横切/审校/索引收尾，0.10.7 删规划，合成仅超 420k 拆分时出现）全部插件内由编译模型通道完成；hy3 192k 适配（0.10.8）：普通单请求输入预算 110k，110k–420k 升大档单请求，超 420k 拆观察→合成，单文件连大档都装不下才转会话通道；审校为批量校对（0.10.8）。
- `CodeWiki.md:9-31` Key Components（描述 `index.js` / `client.js` 的组件清单）：
  - `:11-12` `index.js`（单文件 Node ESM）：`:12` `Config`（schemastery 设置，含 batchProvider/batchModel/batchReasoningEffort/sessionTier/bigProvider 等，全部 volatile）。
  - `:13` `buildSessionSteerText`（0.9.2 纯函数，会话通道 steer 文本唯一生成处）。
  - `:14` `installUpdateReminder`（`agent/created` 注册 section，门控看 `<repo>/CodeWiki.md` 入口）。
  - `:15` `autoCommitWiki`（0.10.9，编译终态由插件自己 git 提交，边界安全见 `CHANGELOG.md:33-47`）。
  - `:16` `autoCommitState(job)`（0.10.10 新增导出纯函数，自动提交三态 `committed`/`no-changes`/`pending` 的唯一判定，根治无谓唤醒，见 `CHANGELOG.md:17-31`）。
  - `:17` `wakeCompileSession`（0.10.9 起自动提交成功直接 return）。
  - `:18` `runCw`/`parseStatus`（cw 子进程封装与三态判定）。
  - `:19` 模型执行模块（`estimateTokens`/`collectSources`/`prepareArticleTasks`/`batchProofreadBatchPrompt`+`settleProofread`/`classifySessionTask`/`runRealtimeTasks`/`llmChat`/`listModelCatalog`/`resolveModelEfforts`）。
  - `:20` `createJobService`（tick 10s、阶段机 queued→articles→crosscut→compose→review→index、单项目串行闸门、会话通道三函数、jobs.json 持久化）。
  - `:21` `cwToolDefinition`；`:22` `generateToolDefinition`（纯提交制）；`:23` 四个 webServer 端点（仅回环放行：jobs/repos/models/control）；`:24` `apply`。
  - `:25` `vendor/codewiki/` 上游源码 + `bin/cw.exe` cargo 产物。
  - `:26-29` `client.js`：`:27` 注册（`plugins.item` order 30 + `main`/`sidebar.panellist` 双 slot order 52）；`:28` `CodewikiCard`（设置表单：运行节 + 编译模型节，provider/model 目录与思考档位来自两个回环端点，0.10.1 删思考预算输入）；`:29` `CodewikiPanel`（2s 轮询、六阶段步骤条、双通道吞吐徽标、用量行、活动流、取消）。
  - `:30` `cordis.patch.yml` 挂载补丁；`:31` `package.json` client 扫描声明。
- `CodeWiki.md:33-57` Architecture 框图（```text 围栏 `:35-57`）：模型调用 codewiki_generate → 任务预构建 → JobService.submit 即返回 → 宿主后台 tick 10s 推进阶段机 → cw index + meta update → autoCommitWiki（`:50-53`），加面板 2s 轮询支线；`:44` 标注「单文件连大档都装不下才转会话通道兜底」。
- `CodeWiki.md:59-61` Data Flow 四条流（`:61`）：配置流、凭证流（插件不保存也不传递任何密钥）、任务流、面板流。
- `CodeWiki.md:63-66` Connections：`:65` [[codewiki-upstream]]（vendor/codewiki 布局）；`:66` 宿主模型目录（`llm.listProviders`/`llm.listModels`/`llm.resolveModel`；BATCH_TOKEN_HARD_LIMIT 语义已更新为 420k 大档预算）。
- `CodeWiki.md:68-75` Known Issues 六条：`:70` 插件注册/client 声明不热加载；`:71` schemastery junction 换机器需重建；`:72` 上游 `cw` 无 `--version`、未 init 仓库 `cw path` 走插件 fallback；`:73` 上游 stale 路径反斜杠已归一；`:74` 断点文件仅记阶段机位置、0.6.0 删 24h 批次窗口；`:75` 会话通道任务依赖发起会话可用（超时默认 30 分钟）。

### CHANGELOG.md — 版本演进史（:1-673）

`CHANGELOG.md:1` 标题；`:2` 起为版本节，**倒序排列（最新在顶）**。当前共 61 个版本节，全部节头行号如下（区间 = 本节头到下一节头前一行；最新节在最上 `:3`）：

| 版本 | 日期 | 主题 | 行号 |
|------|------|------|------|
| 0.10.11 | 2026-10-25 | 编译收尾新增独立 commit 阶段——产物提交改走「主题分支 → 合并回原分支」 | :3-15 |
| 0.10.10 | 2026-10-24 | 两轴 code-review 修复：autoCommitState 三态、边界与测试竞态 | :17-31 |
| 0.10.9 | 2026-10-24 | 编译产物由插件自己提交（autoCommitWiki），会话模型不再等待编译完成（设计缺陷根治） | :33-47 |
| 0.10.8 | 2026-10-24 | 编译流水线全面适配 hy3 192k：大档单请求优先、观察→合成仅超 420k 启用、批量校对 | :49-61 |
| 0.10.7 | 2026-10-24 | 删除规划（plan）阶段：提交后直接进 articles，localPlan 本地分组 | :63-72 |
| 0.10.6 | 2026-10-24 | 面板显示工作区外编译任务（非终态任务始终显示） | :74-82 |
| 0.10.5 | 2026-10-24 | 修复 codewiki_progress 输出校验失败（progress 可空） | :84-94 |
| 0.10.4 | 2026-10-23 | 修复设置页思考程度读不到档位（resolveModelInfo）；新增大档模型（bigProvider/bigModel 等） | :96-122 |
| 0.10.3 | 2026-10-23 | 修复单文件 110k–128k 文章被误判装不下白送会话通道 | :124-133 |
| 0.10.2 | 2026-10-23 | 大档装填上限 150k 越界修复：HARD_LIMIT 150000→128000 | :135-145 |
| 0.10.1 | 2026-10-23 | 删除内置百炼直连通道，编译只走模型设置里的 provider，batchProvider 留空即提交失败 | :147-159 |
| 0.10.0 | 2026-10-23 | 默认 workbuddy/hy3 主模型；预算 110k/128k 重算；删 runMainModelPlan；serialProjects 默认开 | :161-174 |
| 0.9.2 | 2026-10-23 | 自建 sessionTier 档位打通；buildSessionSteerText 收口 steer 文案 | :176-187 |
| 0.9.1 | 2026-10-22 | 编译模型可选宿主已注册 provider/model（listModelCatalog + /api/codewiki/models） | :189-199 |
| 0.9.0 | 2026-10-21 | 超预算文章/校对转「会话通道」（dispatchSessionTasks 等，超时 30 分钟） | :201-213 |
| 0.8.8 | 2026-10-19 | fixAnchors 行号锚点确定性自动修正 | :215-224 |
| 0.8.7 | 2026-10-19 | numberLines 行号前缀治行号幻觉 | :226-236 |
| 0.8.6 | 2026-10-18 | llmRef 修 cordis 严格 getter（规划真正继承对话模型） | :238-248 |
| 0.8.5 | 2026-10-18 | 适配 DSH 0.2.1-rc.2（source 形态 + engines.dsh 声明） | :250-259 |
| 0.8.4 | 2026-10-15 | 文章阶段超预算分割：观察批 map + 合成请求 reduce | :261-273 |
| 0.8.3 | 2026-10-15 | 规划阶段改走主模型 runMainModelPlan（0.10.0 已删除） | :275-284 |
| 0.8.2 | 2026-10-15 | progress schema type 数组致 4 工具全部消失（oneOf 修复） | :286-295 |
| 0.8.1 | 2026-10-14 | 工具拒绝编译时报错带命中的排除项（excludedItem） | :297-304 |
| 0.8.0 | 2026-10-14 | 编译终态实时唤醒发起会话（wakeCompileSession） | :306-316 |
| 0.7.0 | 2026-10-14 | 新增 codewiki_update 日常维护工具 + 编译完成提交提醒 | :318-326 |
| 0.6.0 | 2026-10-13 | 删除百炼批量推理通道，编译全部改走普通入口 | :328-338 |
| 0.5.0.6 | 2026-10-12 | 新增 codewiki_progress 只读查进度工具 | :340-349 |
| 0.5.0.5 | 2026-10-11 | 百炼通道从 Batch File 切换为 Batch Chat | :351-358 |
| 0.5.0.4 | 2026-10-11 | 封死「手工流程」逃生通道 | :360-368 |
| 0.5.0.3 | 2026-10-10 | test-wiki-anchors.mjs 行号锚点自动校验守卫 | :370-377 |
| 0.5.0.2 | 2026-10-10 | cw 真源码本地重建（vendor/codewiki fork）+ 反斜杠 Rust 层根治 | :379-385 |
| 0.5.0.1 | 2026-10-10 | 编译收尾自动补建 CodeWiki.md 入口 + Windows 路径规范化 | :387-396 |
| 0.5.0 | 2026-10-07 | 面板信息密度改版（六阶段步骤条/双通道吞吐/用量统计） | :398-409 |
| 0.4.11.2 | 2026-10-07 | 阶段实时阈值上限放宽 | :411-416 |
| 0.4.11.1 | 2026-10-07 | 孤儿任务接管（宿主重启僵尸任务修复） | :418-422 |
| 0.4.11 | 2026-10-07 | 任务进度条与逐任务明细 | :424-432 |
| 0.4.10 | 2026-10-06 | 端点加固与诊断 | :434-443 |
| 0.4.9 | 2026-10-06 | 工作区任务过滤（workspaceOnly） | :445-451 |
| 0.4.8 | 2026-10-06 | knownRepos 仓库发现 + 一键排除 + control refresh | :453-459 |
| 0.4.7 | 2026-10-06 | excludePaths 排除清单 + 自动更新 + 面板三标签页 | :461-469 |
| 0.4.6 | 2026-10-06 | 面板收敛（焦点卡片）+ 实时 tps + Temp 残留自动清理 | :471-478 |
| 0.4.5 | 2026-10-06 | 阶段实时阈值 batchMinTokens 混合通道（0.6.0 删） | :480-486 |
| 0.4.4 | 2026-10-06 | 侧边栏面板完善 | :488-496 |
| 0.4.3 | 2026-10-06 | 审查修复：取消可靠性、多实例安全、断点保真 | :498-516 |
| 0.4.2 | 2026-10-06 | 超大任务升 256k 档（3 倍价）继续走批量 | :518-525 |
| 0.4.1 | 2026-10-06 | 横切精准拆分（map-reduce）+ 校对动态预算 | :527-533 |
| 0.4.0 | 2026-10-06 | 服务化全批量流水线：零子代理 + 侧边栏面板 + 32k 分块并行（架构定型） | :535-545 |
| 0.3.2 | 2026-10-04 | 批量推理异步化：提交即返回，宿主后台链自动收尾 | :547-554 |
| 0.3.1 | 2026-10-04 | 批量凭证自动取模型设置「阿里百炼云」渠道（0.10.1 删） | :556-560 |
| 0.3.0 | 2026-10-04 | 写文章环节改走百炼批量推理（Batch File） | :562-572 |
| 0.2.8 | 2026-10-03 | 子代理活动行 label 带模型前缀 | :574-579 |
| 0.2.7 | 2026-10-03 | 插件整体未装载修复（严格 cordis getter 语义） | :581-587 |
| 0.2.6 | 2026-10-03 | 设置页支持选择子代理思考程度 | :589-596 |
| 0.2.5 | 2026-10-03 | wiki 维护提醒注入会话系统提示 | :598-604 |
| 0.2.4 | 2026-10-03 | 子代理模型路由两条编排路径被静默丢弃（修复） | :606-612 |
| 0.2.3 | 2026-10-03 | MSYS 路径误判/二进制顺序/wiki 位置三缺陷 | :614-620 |
| 0.2.2 | 2026-10-02 | 审查修复 8 项（scope=full 不被 clean 短路等） | :622-634 |
| 0.2.1 | 2026-10-02 | 子代理服务两处接线断裂（0.1.0 起从未真正可用） | :636-642 |
| 0.2.0 | 2026-10-01 | 插件页设置 UI（client.js 浏览器半侧首次出现） | :644-652 |
| 0.1.1 | 2026-10-01 | 删技能只留纯工具面、默认模型固定百炼 | :654-657 |
| 0.1.0 | 2026-10-01 | 首次发布（cw + codewiki_generate + vendor 编译）+ CLI 冒烟验证记录 | :659-673 |

演进主线（时间正序，7 段）：

1. **0.1.x 奠基期**：0.1.0 首发工具面（`:659-673`）；0.1.1 删技能只留纯工具面、默认模型固定百炼（`:654-657`）。
2. **0.2.x 子代理编排修补期（:574-652）**：设置 UI 落地（0.2.0 `:644`）后发现整条编排路径从未真正可用——0.2.1 两处接线断裂（`:636`）、0.2.2 审查 8 项（`:622`）、0.2.3 路径三缺陷（`:614`）、0.2.4 路由静默丢弃（`:606`）、0.2.5 系统提示提醒（`:598`）、0.2.6 思考程度（`:589`）、0.2.7 整体未装载（`:581`）、0.2.8 label 前缀（`:574`）。
3. **0.3.x-0.4.x 批量降本与服务化（:480-572）**：0.3.0 写文章走百炼批量（`:562`）→ 0.3.1 凭证自动化（`:556`）→ 0.3.2 异步化（`:547`）→ **0.4.0 服务化全批量流水线（架构定型：纯提交制 + 宿主常驻 JobService + 零子代理 + 侧边栏面板，`:535`）** → 0.4.1 横切 map-reduce（`:527`）→ 0.4.2 升 256k 档（`:518`）→ 0.4.3 审查修复（`:498`）→ 0.4.4-0.4.11 面板与仓库管理（`:411-496`）。
4. **0.5.0.x 质量与 fork 期（:340-409）**：面板改版（0.5.0 `:398`）→ CodeWiki.md 入口自动补建（0.5.0.1 `:387`）→ vendor fork 重建（0.5.0.2 `:379`）→ 锚点守卫测试（0.5.0.3 `:370`）→ 封死手工流程（0.5.0.4 `:360`）→ Batch Chat（0.5.0.5 `:351`）→ progress 工具（0.5.0.6 `:340`）。
5. **0.6.0-0.8.5 全实时化与可靠性期（:215-338）**：0.6.0 删批量通道全走普通入口（`:328`）→ 0.7.0 update 工具 + 提交提醒（`:318`）→ 0.8.0 实时唤醒（`:306`）→ 0.8.1/0.8.2 修复（`:286-304`）→ 0.8.3 主模型规划（`:275`，后被 0.10.0 删）→ 0.8.4 观察批分割（`:261`）→ 0.8.5 DSH 0.2.1-rc.2 适配（`:250`）。
6. **0.8.6-0.9.x 锚点与会话通道期（:176-248）**：0.8.6 llmRef（`:238`）→ 0.8.7/0.8.8 行号锚点双层修复（`:226-236`、`:215-224`）→ 0.9.0 超预算转会话通道（`:201`）→ 0.9.1 编译模型可选宿主 provider（`:189`）→ 0.9.2 sessionTier（`:176`）。
7. **0.10.x 现状定型（:3-174）**：0.10.0 hy3 免费主模型 + 全流程回插件内 + 单项目串行（`:161`）→ 0.10.1 唯一通道（删百炼直连，`:147`）→ 0.10.2 大档 128k 修复（`:135`）→ 0.10.3 单文件 110k–128k 误判修复（`:124`）→ 0.10.4 思考程度档位修复 + 大档模型（`:96`）→ 0.10.5 progress 校验修复（`:84`）→ 0.10.6 面板显示工作区外任务（`:74`）→ 0.10.7 删规划阶段（`:63`）→ 0.10.8 大档单请求优先 + 批量校对（`:49`）→ 0.10.9 自动提交根治等待（`:33`）→ 0.10.10 两轴 code-review 修复自动提交三态与测试竞态（`:17`）→ 0.10.11 独立 commit 阶段（主题分支合并，`:3`）。

## Architecture

三份文档的分工与联动（行号为当前快照）：

```text
┌────────────────────────────────────────────────────────────┐
│           仓库根项目文档三件套（本模块全部内容）            │
├────────────────────┬───────────────────┬───────────────────┤
│ README.md  :1-67   │ CodeWiki.md :1-75 │ CHANGELOG.md      │
│ 使用者手册：       │ wiki 入口公约：   │ :1-673（61 版）   │
│ · 工具表    :5-13  │ · Overview :5-7   │ · 最新节在顶 :3   │
│ · 关键行为  :15-22 │ · 组件清单 :9-31  │ · 最早节在底      │
│ · 设置      :24-40 │ · 架构框图 :33-57 │   :659（0.1.0）   │
│ · 安装      :42-57 │ · Data Flow :59-61│ · 版本倒序排列    │
│ · 开发      :59-67 │ · 已知问题 :68-75│                   │
└─────────┬──────────┴────────┬──────────┴─────────┬─────────┘
          │ 描述的对象         │ 架构口径同源        │ 行号锚点
          ▼                    ▼                    ▼
   [[plugin-core]]      [[documentation-     每次发布在 :3 前
   等实现模块文章        and-config]] 等      插入新节，其后全部
                        文章                  旧行号整体下移
```

## Data Flow

两条流向：

- **消费流（agent 读文档）**：上手/装插件 → `README.md:5-22`（工具表与关键行为）+ `README.md:42-57`（安装）；查/改设置 → `README.md:24-40`（设置段）+ `CodeWiki.md:12`（Config 字段）；理解架构 → `CodeWiki.md:33-57`（框图）+ `CodeWiki.md:59-61`（四条流）；排查「行为何时引入/删除」 → 本文版本索引表 → CHANGELOG 对应版本节原文；遇到已知坑 → `CodeWiki.md:68-75` + 本文 Known Issues。
- **维护流（发布版本时写文档）**：版本发布 → ① `CHANGELOG.md` 在 `:3` 前插入新版本节（倒序约定，含背景/实现/测试/文档同步各条）→ ② 同步 `README.md` 工具表/设置段（例：0.10.10 的 `CHANGELOG.md:29`「README/CodeWiki.md 同步三态语义」）→ ③ 同步 `CodeWiki.md` 架构口径（例：同条「CodeWiki.md 架构图的超预算说明同步为 420k」）→ ④ `package.json` 版本号 → ⑤ 收尾调用 `codewiki_generate` 重编译 wiki（0.5.0.4 起的硬纪律，`CHANGELOG.md:360-368`：「收尾未调用 codewiki_generate 视为任务未完成」）。

同步的可靠性依赖锚点守卫链：`numberLines`（0.8.7，`CHANGELOG.md:226-236`）→ `fixAnchors`（0.8.8，`CHANGELOG.md:215-224`）→ `test-wiki-anchors.mjs` 守卫（0.5.0.3，`CHANGELOG.md:370-377`），详见 [[wiki-tests]]。

## Connections

- [[plugin-core]] — README/CodeWiki.md 所描述的 `index.js` 插件主体（Config、JobService、工具定义等）。
- [[client-interface]] — `client.js` 设置卡与侧边栏面板（`README.md:13`、`CodeWiki.md:26-29` 描述的对象）。
- [[configuration-and-metadata]] — `package.json`（版本号与 CHANGELOG 版本一一对应）与 `cordis.patch.yml`（安装挂载）。
- [[documentation-and-config]] — 文档同步行为在 CHANGELOG 各版本节中的记录与 0.5.0.4 封死手工流程的维护公约。
- [[codewiki-upstream]] — vendor/codewiki 上游（`CodeWiki.md:65` 引用的上游布局与 fork 说明）。
- [[wiki-tests]] — `test-wiki-anchors.mjs` 行号锚点守卫（本文引用的全部行号的最后防线）。

## Known Issues

1. **本文行号是快照，必然漂移**：CHANGELOG 倒序加节意味着每次发布后 `:3` 以下全部行号整体下移；本文章所有行号对准提供源码时刻（README 67 行 / CodeWiki 75 行 / CHANGELOG 673 行）。历史上流水线产物曾系统性幻觉行号（偏移 34~760 行，`CHANGELOG.md:360-368` 提及的审核教训），治理链为 `numberLines` → `fixAnchors` → `test-wiki-anchors.mjs` 守卫——引用行号前若怀疑漂移，以守卫测试与 grep 实测为准。
2. **CHANGELOG 内的测试断言数是历史快照**：如 `CHANGELOG.md:117`「123 通过 / 0 失败」、`CHANGELOG.md:349`「55/0」均为当版本时点值，不代表当前测试规模；查当前规模直接跑测试套件（见 [[testing-suite]]）。
3. **版本号不总升一位**：0.5.0.x 出现四段式（0.5.0.1~0.5.0.6），是 0.5.0 发布当周的突发修复序列；同理 0.4.11.1/0.4.11.2。字符串排序或版本比较时注意。
4. **六条已知问题挂 CodeWiki.md:68-75**（随该文件维护，本文不重复展开）：插件不热加载、schemastery junction、`cw` 无 `--version`、反斜杠路径、断点文件语义、会话通道依赖发起会话。
5. **CHANGELOG 只增不减、最新在顶**：查「当前行为」先读顶部节（0.10.11，`CHANGELOG.md:3-15`），再按版本索引回溯；被删除的行为（如 0.6.0 删批量通道 `:328-338`、0.10.0 删 `runMainModelPlan` `:161-174`、0.10.1 删百炼直连 `:147-159`）只有删除记录没有正文，勿据旧节推断现状。
6. **文档同步滞后于 CHANGELOG**：0.10.11 已在 `CHANGELOG.md:3-15` 新增独立 `commit` 阶段（阶段机变为 queued→articles→crosscut→compose→review→index→commit→done，主题分支合并式提交），但提供的 `CodeWiki.md:42-43` 架构框图与阶段机描述仍停留在 index 收尾后直接 autoCommitWiki（无独立 commit 阶段），`README.md` 亦未提及；以 CHANGELOG 与代码实现为准，重编译 wiki 时应同步更新这些文档。
7. **当前源码中 0.1.1 已有独立节头且顺序正常**：`CHANGELOG.md:654-657` 为 0.1.1 独立节头，`0.2.0`（`:644-652`）早于 `0.1.0`（`:659-673`），顺序正常无倒挂；查 0.1.1 内容直接读该节即可，行为以 0.1.0 基线为准。