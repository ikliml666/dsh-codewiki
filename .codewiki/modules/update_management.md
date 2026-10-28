---
title: update_management
type: module
source_files:
  - lib/update-planner.js
  - lib/update-record.js
  - test-update-planner.mjs
  - test-update-record.mjs
tags: [incremental, plan, update-record, terminal-state]
---

## Overview

`update_management` 由两个纯函数模块组成，承担「增量编译前规划」与「编译后复盘」两件事：

- `lib/update-planner.js`：把一次编译要处理的所有代码改动（`ChangeSet` + 旧/新符号图）翻译成**每篇文章该做什么、为什么**的 `UpdatePlan`。它是旧实现 `lib/incremental.js` 的 `filterStaleTasks`（`lib/incremental.js:140-193`）的替代品，解决了后者「只从文章既有 `source_files` 收集组件、命中就写没命中就丢」的三类缺陷：反向依赖看不见、新文件无归属、未重写页不查过期。
- `lib/update-record.js`：把 `ChangeSet` + `UpdatePlan` + 逐篇落盘结果收成一份**可机读的 `UpdateRecord`**，并判定终态（`done` / `partial` / `failed` / `cancelled`），明确回答「能不能推进编译基线」。它钉死了旧实现 `index.js` 的 `writtenCount === 0` 才失败的缺陷——1 篇成功 19 篇失败也曾被报成 `done` 并推进基线。

两条硬不变量贯穿两个模块：

1. **变化不能丢**：任何源码变更若没有任何文章认领，必须显式暴露（`unmappedChanges` + `needsFull`），调用方退回全量编译；绝不像旧实现那样静默刷新基线。
2. **终态必须诚实**：只要存在未消化项（缺页 / 失败 / 未映射变更 / 缺 `source_files` / 质量闸门不过 / 索引失败），终态就是 `partial` 或 `failed`，且 `canAdvanceBaseline === false`——基线只代表「所有变化都被消化」。

## Key Components

### lib/update-planner.js

常量：

- `UPDATE_PLAN_VERSION = 1`（`lib/update-planner.js:23`）：增量计划版本号，落盘时与读取时比对。
- `MODULE_MAP_VERSION = 1`（`lib/update-planner.js:26`）：module-map 状态文件版本号。
- `MODULE_MAP_REL = 'temp/module-map.json'`（`lib/update-planner.js:27`）：module-map 相对 wiki 根的存储路径。

公开函数：

- `isSourcePath(p)`（`lib/update-planner.js:33-36`）：仅看扩展名判断是否为源码文件；非源码文件（`.md`/`.json`/`.log`…）无归属时只记 warning，不触发全量重编（否则随手一篇笔记就会让增量永远退回 full）。
- `realChangedIds(diff, oldGraph, newGraph, { ignoreCommentOnly = true })`（`lib/update-planner.js:57-81`）：在 `changedIds` 基础上区分 `real`、`cosmetic`（仅注释/文档变化）、`structural`（interface/added/deleted/renamed/edge）。`codeHash` 复用 `lib/graph-diff.js`，不另造哈希规则；`docstring` 变化单独检查，不算 cosmetic。
- `dependentsOf(graph, ids)`（`lib/update-planner.js:85-101`）：反向依赖索引——返回「被变更组件 `ids` 依赖的组件列表」。`node.dependsOn` 里既能是组件 id 也能是文件路径，两种都认，保证「被依赖方变了 → 使用方文章重写」成立。
- `scanStaleArticle(article, { deletedComponents, renamedComponents, linkExists })`（`lib/update-planner.js:106-145`）：单篇 stale scan（纯函数，不碰磁盘）。检测正文里仍引用着已删除/已改名符号（`deleted-symbol` / `renamed-symbol`），以及指向不存在文章的死链（`dead-link`，`[[name]]` 与相对 `.md` 链接两种形态）。`needsRewrite` 仅对「引用已删/改名符号」为真；死链只要求 `review`（链接可能只是被改名成等价标题）。
- `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`lib/update-planner.js:156-436`）：**主入口**，纯函数。见下方「数据模型」与 `Architecture`。
- `buildModuleMap({ articles, graph, plan, now })`（`lib/update-planner.js:442-468`）：从文章 `source_files` 与符号图构建文章→源码/组件/模块映射；`module` 优先取 full 编译 plan 里的模块名，否则用 `source_files` 的公共目录。
- `migrateModuleMap({ articles, now })`（`lib/update-planner.js:472-481`）：旧 wiki 没有 module-map 时从 frontmatter 保守迁移，只记 `sources`、`components` 留空（下次编译由真实 plan 重建），绝不臆造归属。
- `sameModuleMap(a, b)`（`lib/update-planner.js:484-492`）：忽略 `generatedAt` 比较两份 module-map 实质内容，避免空转提交。

内部辅助（文件内使用，理解控制流时需要）：

- `dirOf(p)`（`lib/update-planner.js:38-41`）、`commonDir(a, b)`（`lib/update-planner.js:44-53`）：目录级归属计算，`commonDir` 用于新文件按「最长公共目录」保守路由给已有文章。

### lib/update-record.js

常量：

- `UPDATE_RECORD_VERSION = 1`（`lib/update-record.js:17`）：更新记录版本号。
- `UPDATE_RECORD_REL = 'temp/update-record.json'`（`lib/update-record.js:18`）：更新记录相对 wiki 根的存储路径。
- `TERMINAL = new Set(['done','partial','failed','cancelled'])`（`lib/update-record.js:24`）：终态集合（本模块融合新增 `partial`）。

公开函数：

- `isTerminalStage(stage)`（`lib/update-record.js:26-28`）：判断某 stage 是否为终态。
- `judgeOutcome({ plan, results, options })`（`lib/update-record.js:37-128`）：**终态判定核心**。从逐篇 `results` 与 `plan` 算出 `{ outcome, blockers, canAdvanceBaseline, writtenCount, failedCount }`。blocker 类别含 `missing-article`、`article-failed`、`unmapped-changes`、`missing-sources`、`quality`、`index`、`extra`。`outcome` 规则：`blockers/failed/missing/requiredMissing` 全空 ⇒ `done`；写成了一部分（有成功文章）⇒ `partial`；0 篇成功且还有其他问题 ⇒ `failed`；`options.cancelled` ⇒ `cancelled`。注意：非源码文件无归属不计入 `unmapped-changes`，只对源码变更放行（`lib/update-record.js:83-91`）。
- `buildUpdateRecord({ jobId, scope, changeSet, plan, results, outcome, wikiPath, qualityIssues, notes, startedAt, finishedAt })`（`lib/update-record.js:131-211`）：组装可序列化记录，每个 action 都带 `reason`（可复盘最低要求），且**只存摘要不塞整张符号图**（`'graph' in rec === false`，`lib/update-record.js:183-184`）。
- `recordPath(wikiPath)`（`lib/update-record.js:213-215`）：返回 `<wikiPath>/temp/update-record.json` 绝对路径。
- `saveUpdateRecord(wikiPath, record, fsImpl = fs)`（`lib/update-record.js:217-227`）：写盘助手，`fsImpl` 默认 `node:fs`，可注入便于单测；返回 `{ ok, path }` 或 `{ ok, reason }`。
- `loadUpdateRecord(wikiPath, fsImpl = fs)`（`lib/update-record.js:229-238`）：回读，**版本不符直接返回 `null`**（`lib/update-record.js:233`），避免旧格式被当新格式读。
- `describeOutcome(outcome, blockers)`（`lib/update-record.js:241-253`）：面板/工具文案，`done`/`partial`/`cancelled`/`failed` 三态+取消一眼可分，且带首个阻塞原因。

### 数据模型（返回对象，非 class）

`planUpdate` 返回值 `UpdatePlan`（`lib/update-planner.js:154-179`）字段：

- `version`：计划版本。
- `fileLevel`：是否退化为文件级判定（`oldGraph`/`newGraph` 缺失或 `options.fileLevel === true`）。
- `changedComponents` / `cosmeticComponents` / `structuralComponents`：变更组件分类（`realChangedIds` 产出）。
- `counts`：图 diff 计数（interface/added/deleted/renamed/body/edge）。
- `actions`：每篇文章一个 action 对象（见下）。
- `summary`：`{ write, keep, delete, review }`——注意 `delete` 永远为 `0`，本模块注释声称有 `delete` action 但 `planUpdate` 实际只产出 `write`/`keep`/`review`（见 Known Issues）。
- `unmappedChanges`：所有无归属变更（含非源码）。
- `unmappedSourceChanges`：仅源码无归属变更（判定基线的真依据）。
- `routedTo`、`missingSources`、`missingRequired`、`requiredNames`、`warnings`、`needsFull`、`fullReason`、`hasChanges`。

每个 `action` 对象基础字段（`lib/update-planner.js:243-250`，按分支追加）：`name`、`articlePath`、`sources`、`changedComponents`、`impactedBy`、`reasons`、`action`（`'write'|'keep'|'review'`）、`reason`，可附加 `needsFull`/`fileLevel`/`staleIssues`/`newFiles`。

`buildUpdateRecord` 返回值 `UpdateRecord`（`lib/update-record.js:131-196`）字段：`version`、`jobId`、`scope`、`startedAt`、`finishedAt`、`baseCommit`、`headCommit`、`changeSet`(精简摘要)、`plan`(精简摘要)、`results`、`qualityIssues`、`outcome`、`blockers`、`canAdvanceBaseline`、`writtenCount`、`failedCount`、`notes`、`wikiPath`。

`buildModuleMap` 返回值 `ModuleMap`（`lib/update-planner.js:442`）：`{ version, generatedAt, articles: { [name]: { sources, components, module } } }`；`migrateModuleMap` 还带 `migrated: true` 与顶层 `migratedFromFrontmatter: true`（`lib/update-planner.js:472`）。

## Architecture

```text
        ChangeSet (lib/change-set.js)        oldGraph / newGraph (符号图)
                 │                                  │
                 │                                  ▼
                 ▼                       diffGraphs / realChangedIds
        planUpdate (lib/update-planner.js:156) ──► dependentsOf (反向依赖闭包)
                 │                                        │
   ┌─────────────┼─────────────┐                         │
   ▼             ▼             ▼                         ▼
 write         keep          review           unmappedChanges / routedTo
 (自身变更/反向依赖/stale)  (无实质变更)  (死链/缺 source_files)
   │                                                   │
   │  moduleMap 由 buildModuleMap/migrateModuleMap 提供  │ needsFull ⇒ 退回全量
   ▼                                                   ▼
 UpdatePlan ───────────────► job.updatePlan (index.js:3931, slimPlanForJob) ─┐
                                                                             │ tickIndex (index.js:3619)
                                                                             ▼
                                                              judgeOutcome (lib/update-record.js:37)
                                                                             │
                                                                   blockers / canAdvanceBaseline
                                                                             │
                                                                             ▼
                                                              buildUpdateRecord → saveUpdateRecord
                                                              (lib/update-record.js:131/217) ⇒ temp/update-record.json
```

`planUpdate` 的控制流（按 `lib/update-planner.js` 行号）：归一变更集（171-175）→ 文件级判定（179-192）→ 组件→文件索引与反向依赖影响（195-219）→ 文章 ownership（221-236）→ 逐篇判 `write`/`keep`/`review`（238-347：删文件 270、改名 280、无符号 290、自身/依赖命中 305、stale scan 320-344）→ 无归属变更兜底（349-392）→ 必需文章与缺页（399-408）→ 组装返回（410-435）。

`judgeOutcome` 的判定顺序（`lib/update-record.js`）：cancelled 优先（46-54）→ 计划内必需文章缺页/失败（56-75）→ 逐篇失败（77-78）→ 未映射源码变更（83-91）→ 缺 `source_files`（92-97）→ 质量闸门（99-102）→ 索引（104-105）→ 调用方 extraBlockers（107-110）→ 合成 outcome（112-118）。

## Data Flow

1. **入口采集**：`codewiki_generate`（`index.js:4132` 的 `runStaleUpdate`）先 `collectChangeSet(cwd, baseline)`（`lib/change-set.js:102`）拿到 `ChangeSet`，再 `loadModuleMap`（`index.js:1826`，缺失时 `migrateModuleMap`）与 `extractCurrentGraph`/`loadSnapshot` 得到 `oldGraph`/`newGraph`，最后 `collectWikiArticles`（`index.js:1794`）收集 `articles`。
2. **规划**：`planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options: { staleArticles, linkExists } })`（`index.js:4173`）。`linkExists` 由 `index.js:1867` 的 `makeLinkExists` 注入，供 stale scan 判死链。
3. **转任务**：`plan.actions.filter(a => a.action === 'write')` 映射成 `submit` 的 `prebuiltTasks`（`index.js:4178-4191`、`4280-4290`），连同 `plan` 通过 `updatePlan` 落进 `job.updatePlan`（`index.js:3931`）。`plan.needsFull` ⇒ 退回全量（`index.js:4177`）。
4. **终态判定**：编译末态阶段 `tickIndex`（`index.js:3602`）调 `judgeOutcome({ plan: job.updatePlan, results: job.articles, options: { expectedNames, qualityIssues, extraBlockers } })`（`index.js:3619`），结果存 `job.judged`。
5. **落盘复盘**：`saveRecord(job, judged)`（`index.js:2574`）调 `buildUpdateRecord` + `saveUpdateRecord` 写 `temp/update-record.json`（`index.js:2588`）；原生通道 `tickNative` 在收割后同样调 `saveRecord`（`index.js:2805`）。
6. **基线闸门**：`job.judged.canAdvanceBaseline === true` 才 `cw meta update` 推进基线（`index.js:3655-3671`）；否则 `done` 之外一律不推进（`index.js:3669-3670`）。

## Connections

- [[change-set]]：`collectChangeSet` 产出 `planUpdate` 的 `changeSet` 输入（四路 git 改动合一）。
- [[graph-diff]]：`diffGraphs` / `changedIds` / `graphDiffCounts` / `codeHash` 被 `planUpdate` 与 `realChangedIds` 使用（`lib/update-planner.js:57`）。
- [[symbols]]：`SUPPORTED_EXTS` 被 `isSourcePath` 用来判断源码扩展名（`lib/update-planner.js:33`、30）。
- [[incremental]]：`normRel` 被 `planUpdate` 大量用于路径归一（`lib/update-planner.js:156`）；`filterStaleTasks`（`lib/incremental.js:140-193`）是 `planUpdate` 的旧实现，本模块显式取代它。
- [[quality-gate]]：`judgeOutcome` 的 `qualityIssues` 来自质量闸门（`lib/update-record.js:99-102`），`buildUpdateRecord` 的 `qualityIssues` 字段直接落盘。
- [[apply-plan]]：`applyNativeOutput` 的 `canAdvanceBaseline` 与 `judgeOutcome` 的语义同源——产物没入库就不能算消化完（`lib/engine/apply-plan.js:455-457`）。
- `index.js`（JobService）：`runStaleUpdate`/`tickIndex`/`saveRecord`/`loadModuleMap`/`submit` 是这两个模块的生产调用方（见 Data Flow）。

## Known Issues

- **`delete` action 从未产出**：模块头注释（`lib/update-planner.js:12`）声称四类 action `write / keep / delete / review`，`summary` 也声明了 `delete`（`lib/update-planner.js:169`），但 `planUpdate` 全文只设置 `write`/`keep`/`review`（如 `270`、`281`、`295`、`300`、`309`、`331`、`341`、`345`），`delete` 计数恒为 `0`。孤儿文章的实际删除由 `index.js` 的 `pruneOrphanModules` 在 `tickIndex` 完成（`:3637`），并不走 planner 的 action。
- **`options.staleArticles` 被传入但未消费**：`index.js:4173` 传了 `options: { staleArticles: [...staleRel] }`，但 `planUpdate` 只解构 `options.linkExists`（`lib/update-planner.js:164`），`staleArticles` 字段被忽略，规划完全依赖 `changeSet` + 符号图，不依赖 cw status 的 stale 清单。
- **反向依赖依赖图边完整性**：若符号图没有任何 `dependsOn` 边（旧链路 `extractCurrentGraph` 曾经不建边），`planUpdate` 会记 warning 并退化为只按 `source_files` 自身判定（`lib/update-planner.js:395-397`），此时「接口变了但依赖方文章不重写」会被如实记账而非假装做到。
- **`loadUpdateRecord` 版本不符返回 `null`**：`version !== UPDATE_RECORD_VERSION` 直接丢弃（`lib/update-record.js:233`），旧记录不会被误读为当前格式。
