---
title: probes_root
type: module
source_files:
  - .probe-posix.mjs
  - .probe-inc.mjs
  - .probe-idxfail.mjs
  - .probe-nochange.mjs
  - .probe-nochange-commit.mjs
  - .probe-two-round.mjs
  - .probe3.mjs
  - client.js
  - index.js
  - lib/engine/native-run.js
  - lib/engine/client.js
  - lib/git-paths.js
  - test-fixtures/fake-native-engine.mjs
  - lib/engine/quality-gate.js
tags: [probes, root, client, integration-run, fake-native-engine]
---

## Overview

「probes_root」不是代码库里一个真实模块目录，而是仓库根下一组**临时集成运行探针脚本**（`.probe-*.mjs`）与其依赖的客户端工厂 / 宿主入口 / 原生引擎适配层 / 假引擎夹具的聚合视图。它们用于在不写单测的前提下，把真实服务编排（`index.js`）与原生引擎生产链路（`lib/engine/native-run.js`）跑起来，打印事实现场（终态、引擎足迹、git HEAD 进退、质量门/落地结论等）以排查具体疑点。

这组文件分三层：

1. **根探针脚本（`.probe-*.mjs`，共 7 个）**：临时排查产物，文件头注释标注「跑完即删」「不提交」或仅作一次性验证（见 `.probe-idxfail.mjs:1`、`.probe-inc.mjs:1`、`.probe-nochange.mjs:1`、`.probe-nochange-commit.mjs:1`、`.probe-two-round.mjs:1`、`.probe3.mjs:5`、`.probe-posix.mjs:1`）。它们要么直接 `import './index.js'` 拉起整个 `apply(ctx, cfg)` 服务链，要么直接 `import './lib/engine/native-run.js'` 的 `runNativeJob`。
2. **浏览器半侧工厂 `client.js`**：`window.__ModuleLoader__.load({ id:'@local/dsh-codewiki' })`（`client.js:10`）注册插件，挂载设置页（`CodewikiCard`，`client.js:570`）与侧边栏任务面板（`CodewikiPanel`，`client.js:1455`）。所有数据来自宿主 `index.js` 注册的仅回环 HTTP 端点（`client.js:19-27`）。
3. **宿主半侧 `index.js` + 原生引擎适配层 `lib/engine/*` + 假引擎 `test-fixtures/fake-native-engine.mjs`**：探针调用的 `apply`（`index.js:4965`）、`runNativeJob`（`lib/engine/native-run.js:114`）、`toPosix`（`lib/git-paths.js:34`）都来自这里；`fake-native-engine.mjs` 是「真进程、假算法」的协议级引擎替身。

探针的核心价值：原生引擎生产接线（`test-engine-native-job.mjs`、`test-engine-native-incremental.mjs`）单测无法替你回答的疑问——比如「index 失败后 HEAD 为何前移」「无变化轮到底提交了什么」「第二轮 stale 是否真的进了 update 分支」——用临时的真实服务链跑一遍把证据打出来。它们因此常硬编码本机仓库路径（如 `.probe-inc.mjs:8`）或依赖 `test-fixtures/fake-native-engine.mjs` 的「模式文件」机制（仓库同级 `.native-mode-<name>` 文件，`test-fixtures/fake-native-engine.mjs:27-30`）。

## Key Components

### Root probe scripts（集成运行探针）

表：仓库根 7 个 `.probe-*.mjs` 探针的入口、依赖与打印目标（行号均来自实读源码）。

| 文件 | 行号范围 | 入口 / 依赖 | 验证目的 | 打印目标（关键行） |
| --- | --- | --- | --- | --- |
| `.probe-posix.mjs` | `1–4` | `toPosix` from `lib/git-paths.js` | 验证 Windows 反斜杠路径归一化 | 遍历 `win` 数组逐个打印 `toPosix` 结果（`:3`） |
| `.probe-inc.mjs` | `1–78` | `import './index.js'`（`apply`）、`test-fixtures/fake-native-engine.mjs`、`makeCtx`（`32–44`）、`waitJob`（`46–55`） | 两轮 native 增量在生产链上的真实行为 | 第 1 轮 full 的 `incremental`、状态目录（`68`）、引擎足迹（`:69`）；第 2 轮 stale 的 `incremental`/`apply`/`blockers`（`:73–77`） |
| `.probe-idxfail.mjs` | `1–57` | `runNativeJob` from `lib/engine/native-run.js`、`makeDeps`（`24–29`，注入 `runCw` 让 index 失败） | index 失败后 HEAD 为何前移 | `r1` 提交 sha（`:32`）、v2 HEAD（`:36`）、idx 后 `rIdx.apply` 是否回滚（`:50`）、idx 后 HEAD 是否变化（`:51–56`） |
| `.probe-nochange.mjs` | `1–83` | `import './index.js'`（`apply`）、`makeCtx`（`32–43`）、`poll`（`55–69`） | 用例 2（update-nochange）为什么卡住 | 两轮 job 的 stage/outcome/error/blockers/notes/nativeStage（`:74`、`:81`），以及引擎调用足迹（`:83`） |
| `.probe-nochange-commit.mjs` | `1–44` | `runNativeJob` from `lib/engine/native-run.js`、`fake-native-engine.mjs` | 无变化轮到底提交了什么内容 | 第 1 轮 `incremental.resolution`/commit files（`:31`）；第 2 轮 `update-nochange` 的 HEAD diff（`:34–43`） |
| `.probe-two-round.mjs` | `1–70` | `runNativeJob` from `lib/engine/native-run.js`、`fake-native-engine.mjs` | 确认第二轮 stale 真的进了 update 分支 | 第 1 轮 full 的 outcome/stage/engineLock/blockers/incremental/apply/notes（`:39–48`）与状态目录文件清单（`:50–55`）；第 2 轮 stale 的 `baseCommit`/`headCommit`/`changeCount`/`updateOutcome`/`hydrated`/`fallbackReason`（`:61–67`） |
| `.probe3.mjs` | `1–61` | `import './index.js'`（`apply`）、`reg` Map（`20–21`）、`wait`（`36–49`） | staged 文件场景：staged 后 stale 是否认账 | 两次 `gen.execute`（full/stale，`:50`、`:56`）与第 2 轮的 `kind`/`scope`/`channel`/`incremental`（`:59–61`） |

#### 关键辅助函数（探针内）

- `makeCtx(llm)`（`.probe-inc.mjs:32-44` 与 `.probe-nochange.mjs:32-43`）：用最小宿主服务桩（`webServer`/`agents`/`tools`/`llm`）构造 `ctx`，`apply(m.ctx, cfg)` 注册 `codewiki_generate` 后从 `registered.get('codewiki_generate')` 取工具并执行 `gen.execute({ cwd, scope }, { agent:{ id } })`。
- `waitJob(cwd, timeout)`（`.probe-inc.mjs:46-55`）/ `poll(tag, timeout)`（`.probe-nochange.mjs:55-69`）/ `wait(cwd)`（`.probe3.mjs:36-49`）：轮询 `DSH_CODEWIKI_JOBS_FILE` 指向的独立 jobs JSON，直到 job 进入 `['done','partial','failed','cancelled']` 或超时。
- `mkDeps(applyDeps)`（`.probe-idxfail.mjs:24-29`）/ `deps`（`.probe-nochange-commit.mjs:24-29`、`probe-two-round.mjs:27-31`）：构造 `runNativeJob` 的 `deps`，其中 `engineFor` 返回 `{ command: process.execPath, args: [fixture] }`——用 node 当「Python 解释器」、用 `fake-native-engine.mjs` 当「入口脚本」，从而走**完全真实**的 spawn / 协议 / 进程树路径（见 `test-fixtures/fake-native-engine.mjs:1-16`）。

#### 共享配置与运行前准备（probe 通用）

- 环境变量：`process.env.DSH_CODEWIKI_TICK_MS='300'` 加速 tick（`.probe-inc.mjs:9`、`.probe3.mjs:7`）；`process.env.DSH_CODEWIKI_JOBS_FILE` 指向 `os.tmpdir()` 下 `pid+随机token` 的独立 jobs 文件，避免历史残留污染（`.probe-inc.mjs:10-11`、`.probe3.mjs:6-7`）。
- 仓库引导：`git init` → `cw init` → 写 `CodeWiki.md` → 提交「wiki init」（如 `.probe-inc.mjs:17-29`）。`cw` CLI 必须已在 PATH（探针直接 `execFileSync('cw', ...)`）。
- 假引擎模式文件：仓库同级 `.native-mode-<repoName>` 写入 `done`/`update-nochange`/`idle` 等模式，控制 `fake-native-engine.mjs` 行为（`.probe-inc.mjs:29`、`.probe-nochange.mjs:78`、`.probe-nochange-commit.mjs:21,34`）。

### test-fixtures/fake-native-engine.mjs — 真进程假引擎

`fake-native-engine.mjs`（324 行）是阶段 4/5 生产接线测试的「假引擎」：**只实现协议与产物，不实现任何算法**（`test-fixtures/fake-native-engine.mjs:1-16`）。它被 node 直接当解释器、本文件当入口脚本执行，因此 `lib/engine/client.js` 走的是完全真实的 spawn / 协议解析 / 进程树终止路径。

关键成员（行号来自实读）：

| 成员 | 行号 | 用途 |
| --- | --- | --- |
| `modeFileFor(repoPath)` / `modeOf(repoPath)` | `27-40` | 模式解析优先级：环境变量 `FAKE_ENGINE_MODE` → 仓库同级 `.native-mode-<name>` 文件 → 仓库目录名的 `__<mode>__` 段；放仓库外避免污染被测对象 |
| `logCall(repoPath, action, extra)` | `52-57` | 写调用足迹到仓库同级 `.native-calls-<name>.log`（证据：环境失败/锁漂移时引擎根本没被生成调用） |
| `readStateInputs(docsDir, repoPath)` | `65-88` | 引擎侧 stat 受管状态（module_tree/metadata/dependency_graph/update_record/docs_markdown），证明水合进来的旧状态真的被引擎读取 |
| `emit` / `progress` / `result` | `90-98` | 向 stdout 写 JSON-lines（`type: 'progress' | 'result'`） |
| `realSourceFiles(repoPath, limit)` | `112-129` | 真实扫描仓库源码（仅引用仓库里存在的文件作 source_files，避免质量门误判 source-missing） |
| `writeDocs(docsDir, repoPath, { action, commitId })` | `131-201` | 写 `modules/*.md`（无 frontmatter）、`metadata.json`、`module_tree.json`、依赖图、`update_record.json`；`action==='update'` 时 `keep()` 不重写已有页 |
| `run(req)` | `203-314` | 动作分发：`doctor` → 回 engine 现场；`stall`/`slow`/`fail`/`crash`/`empty-docs` 各模式；默认路径 `writeDocs` 后回 `outcome:'done'` 并附 `artifacts` 与 `updateOutcome` |
| stdin 监听 | `316-324` | 读首行 JSON 请求，`run` 抛错则回 `engine-crashed` 失败 result |

行为模式（通过 `.probe-inc.mjs:29`、`.probe-nochange.mjs:62`、`.probe-nochange-commit.mjs:21,34` 等模式文件切换）：`done`（干净产物）、`partial`（缺失一篇 web.md → 质量门判 partial，`167-172`）、`fail`（引擎自回 failed，`264-272`）、`crash`（协议破坏、无 result，`273-277`）、`empty-docs`（引擎 done 但无产物，`278-282`）、`stall`（不返回等被取消，`238-243`）、`slow`（慢但跑完，`244-263`）、`deps-bad`（doctor pip check 不过，`217-223`）、`bad-commit`/`update-fallback`/`update-nochange`（影响 `update_record` outcome，`194`、`296`）。

### client.js — 浏览器半侧工厂

`client.js` 通过 `window.__ModuleLoader__.load({ id:'@local/dsh-codewiki', factory(require) {...} })`（`client.js:10-12`）注册插件。工厂内 `apply(ctx)`（`client.js:528-564`）通过 cordis 注入 `['slots','locale','configForms']`，完成三件事：

- 注册词典 `ctx.locale.register(NS, { zh: zh(), en: en() })`（`client.js:532`，词典见 `client.js:35-406`）。
- 挂载插件设置页条目 `ctx.slots.register({ name:'plugins.item', id:NS, order:30 }, CodewikiCard)`（`client.js:538-545`），仅在宿主服务 `codewiki` 命名空间时显形（`configForms.whileServed`，`client.js:546-547`）。
- 挂载侧边栏面板 `ctx.slots.inject('main', { key: KEY }, CodewikiPanel)` + `ctx.slots.inject('sidebar.panellist', { id: KEY, order: PANEL_ORDER }, PanelIcon)`（`client.js:553-564`）。

关键组件（行号与职责）：

| 组件 | 行号 | 职责 |
| --- | --- | --- |
| `zh()` / `en()` | `client.js:35-406` | 中英文案；键 `NS='codewiki'`（`client.js:17`），值必须全为字符串（`client.js:8`） |
| `el(tag, props, ...children)` | `client.js:507-509` | `React.createElement` 薄封装 |
| `apiGet(p)` / `apiPost(p, data)` | `client.js:511-526` | fetch 封装，`!res.ok` 抛 `body.error \|\| HTTP <status>`；端点常量见 `client.js:511-523` |
| `CodewikiCard(props)` | `client.js:570-1058` | 设置表单：模型目录拉取（`582-593`）、草稿订阅（`596-613`）、`useEfforts`（`642-673`）、`modelTrio` 三联（`680-784`）、`save()` 校验+`form.mutate`（`786-825`） |
| `CodewikiPanel()` | `client.js:1455-1724` | 任务面板：2s 轮询 `JOBS_PATH`（`1472-1512`）、`cancel`（`1517-1525`）、`jobCard`（`1553-1670`）、`stageBar`（`1131-1156`） |
| `ReposTab()` | `client.js:1213-1357` | 总览 Tab：10s 轮询 `REPOS_PATH`、`toggleExclude`（`1243-1261`）、`compile`（`1263-1271`） |
| `SessionView({job, onClose})` | `client.js:1363-1453` | 会话（LLM 请求记录）视图，5s 轮询 `SESSIONS_PATH` |
| `PanelIcon(props)` | `client.js:1726-1737` | 摊开书本 SVG 图标 |

注意 `client.js` 仅消费服务端数据，不持有任何模型凭证（头注释 `client.js:1-8`）；它依赖 `index.js` 注册的 `/api/codewiki/*` 七端点与 `codewiki` 配置命名空间。

## Architecture

```text
┌─ 仓库根探针（.probe-*.mjs，临时、标「跑完即删」）──────────────────────┐
│ .probe-inc.mjs / .probe-nochange.mjs / .probe3.mjs                    │
│   import './index.js' → apply(ctx, cfg) → 真服务链                   │
│ .probe-idxfail.mjs / .probe-nochange-commit.mjs / .probe-two-round.mjs│
│   import runNativeJob (lib/engine/native-run.js)                      │
│ .probe-posix.mjs → toPosix (lib/git-paths.js)                        │
└───────────────┬──────────────────────────────┬──────────────────────┘
                │ apply()                      │ runNativeJob()
                ▼                              ▼
┌──────────────────────────┐   ┌────────────────────────────────────┐
│ index.js (宿主半侧)       │   │ lib/engine/native-run.js           │
│ apply 5178 / Config 74   │   │ 裁决链 env→决议→引擎→gate→apply     │
│ codewiki_generate 工具    │   │ DEFAULT_UPDATE_OPTIONS rung=3 68    │
│ autoCommitWiki 5014      │   │ runEngine=lib/engine/client.js      │
└───────────────┬──────────┘   └──────────────┬─────────────────────┘
                │ fetch /api/codewiki/*        │ spawn 真进程
                ▼                              ▼
┌──────────────────────────┐   ┌────────────────────────────────────┐
│ client.js (浏览器半侧)     │   │ test-fixtures/fake-native-engine.mjs│
│ CodewikiCard 570         │   │ 真进程(node)、假算法；模式文件控制   │
│ CodewikiPanel 1455       │   │ doctor/generate/update/stall/...    │
└──────────────────────────┘   └────────────────────────────────────┘
```

架构要点：

- 原生引擎**裁决链唯一收敛点**是 `lib/engine/native-run.js` 的 `runNativeJob`（`lib/engine/native-run.js:114`）。探针直接调它（`deps.engineFor` 返回 `{ command: process.execPath, args: [fixture] }`），跳过 `index.js` 服务阶段机，但仍走真实的 `lib/engine/client.js` spawn 与协议解析（`fake-native-engine.mjs:1-16`）——这正是它能验证「接线」而非「算法」的原因。
- `index.js` 侧：`apply`（`index.js:4965`）构造 `createJobService` + 注册 `cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress` 四个工具（`index.js:2234-2247`）、安装 web 端点（`index.js:5240`）与更新提醒（`index.js:5241`）。`client.js` 只读它注册的回环端点。
- 增量决议 `scope(full|stale|auto)` → `RESOLUTION.FULL|UPDATE`（`lib/engine/native-run.js:87`、`308`）由 `changeSet` + `nativeState.isUpdateEligible` 决定，`updateOptions.rung='3'`（组件级，`DEFAULT_UPDATE_OPTIONS`，`lib/engine/native-run.js:69`）显式下传，避免依赖引擎内部默认。

## Data Flow

1. **整链探针（`.probe-inc.mjs` / `.probe-nochange.mjs` / `.probe3.mjs`）**：设 `DSH_CODEWIKI_JOBS_FILE` 独立文件（`.probe-inc.mjs:10-11`）→ `makeCtx` 桩宿主服务 → `apply(m.ctx, cfg)` 注册 `codewiki_generate`（`index.js:4965`）→ `gen.execute({ cwd, scope }, { agent:{id} })` 提交任务 → `waitJob`/`poll`/`wait` 轮询 jobs JSON 到终态 → 打印 `j.stage/j.outcome/j.nativeResult.incremental/j.blockers` 与假引擎足迹 `.native-calls-<repo>.log`。
2. **原生直调探针（`.probe-idxfail.mjs` / `.probe-nochange-commit.mjs` / `.probe-two-round.mjs`）**：构造 `deps.engineFor` = `{ command: process.execPath, args:[fixture] }`（`fake-native-engine.mjs` 当入口）→ `runNativeJob({ repoRoot, scope, docsDir, deps })`（`lib/engine/native-run.js:114`）→ 走 `env→增量决议→runEngine(client.js realSpawn)→gate→apply` 全链 → 返回 `r.outcome/r.incremental/r.apply/r.blockers`。`.probe-idxfail.mjs` 额外注入 `runCw` 让 `index` 步骤失败（`:43-47`），验证 HEAD 不前进。
3. **假引擎协议流**：`engineFor` 产生的子进程读 stdin 首行 JSON（`fake-native-engine.mjs:316-324`）→ `run(req)` 按模式文件 `modeOf` 决定动作（`fake-native-engine.mjs:206`）→ 写 `progress`/`result` JSON-lines 到 stdout（`:90-98`）→ `logCall` 把调用足迹写仓库同级 `.native-calls-<repo>.log`（`:52-57`）；`fake-native-engine.mjs` 的 `readStateInputs` 由引擎侧 stat 受管状态回传，证明水合生效（`:65-88`）。
4. **客户端数据流（`client.js`）**：`CodewikiPanel` 2s GET `/api/codewiki/jobs`（`client.js:1455-1495`）→ 差分采样 tps/批量速率 → `jobCard`/`stageBar`/`overallPct` 渲染；`ReposTab` 10s GET `/api/codewiki/repos`（`client.js:1213-1217`）；`SessionView` 5s GET `/api/codewiki/sessions`（`.probe-*` 不直接覆盖此路径，但面板同链路）。
5. **路径归一化（`.probe-posix.mjs`）**：`toPosix(p)`（`lib/git-paths.js:34`）把 `\` 统一成 `/`，是 `decodeGitPath`（`lib/git-paths.js:53`）、`withQuotepathOff`（`lib/git-paths.js:39`）之外的唯一分隔符归一实现；探针仅验证 `['src\\web\\task.ts','a\\b',null,undefined,'','lib/engine\\manifest.js']` 各值的转换（`.probe-posix.mjs:2-3`）。

## Connections

- [[index]] —— 宿主半侧入口：`.probe-inc.mjs`/`.probe-nochange.mjs`/`.probe3.mjs` 直接 `import './index.js'` 并调用 `apply`（`index.js:4965`）；`client.js` 的全部 fetch 目标（`/api/codewiki/*`、`client.js:19-27`）与配置命名空间 `codewiki`（`client.js:17`）都由它注册。
- [[engine-core]] —— 原生引擎适配核心：`lib/engine/native-run.js`（`runNativeJob`，`lib/engine/native-run.js:114`）、`lib/engine/client.js`（协议层 + 真实 spawn，`lib/engine/client.js:1-60`）是 `.probe-idxfail.mjs`/`.probe-nochange-commit.mjs`/`.probe-two-round.mjs` 的主要调用对象。
- [[engine-state]] —— `nativeState.isUpdateEligible` / `readState` / `hydrateDocsDir`（被 `lib/engine/native-run.js:303-352` 调用）与 `captureDocsDir`（`:587-591`）决定增量决议，是 `.probe-inc.mjs`/`.probe-two-round.mjs` 打印 `incremental` 字段的来源。
- [[test-fixtures]] —— `test-fixtures/fake-native-engine.mjs` 是探针「真进程假引擎」替身，`test-fixtures/graphdiff-golden.json` 是 `test-graphdiff.mjs` 对拍基准（探针未直接用）。
- [[lib-agentic]] —— `lib/agentic.js` 等 agentic 通道由 `index.js` 在 `codewiki_generate` 内调用；探针用 `agenticArticles:false`（`fake-native-engine.mjs` 时代）或 `planMode:'dirs'` 关闭以走旧/原生通道。
- [[root]] —— 仓库根模块是这组探针与服务/客户端的完整背景；本文聚焦「临时探针脚本 + 它们直连的客户端工厂/宿主入口/原生适配层/假引擎」。

## Known Issues

1. **探针硬编码本机绝对路径**：`.probe-inc.mjs:17` 写死 `E:/ik/Documents/trae_projects/1/dsh plugin/dsh-codewiki`，其它机器无法直接运行；`.probe-nochange.mjs`/`.probe-nochange-commit.mjs`/`.probe-two-round.mjs`/`.probe-idxfail.mjs`/`probe3.mjs` 依赖 `fs.mkdtempSync(os.tmpdir())` 生成临时仓库，相对可移植，但仍要求本地 `cw` CLI 与 node/python 可用。
2. **探针残留未清理**：`.probe-idxfail.mjs:1`、`.probe-nochange-commit.mjs:1`、`.probe-inc.mjs:1`、`.probe-nochange.mjs:1` 均标注「跑完即删」/「不提交」，但 7 个探针目前全部留在仓库根（`.probe-posix.mjs` 最新加入、无清理标注），属排查期残留，应在排查结束后删除。
3. **假引擎产物契约耦合**：`fake-native-engine.mjs:131-201` 的 `writeDocs` 必须「不写 frontmatter、引用仓库真实存在的源码文件、update 动作不重写已有页」，否则质量门 `quality-gate.js` 会把夹具本身格式错误当成接线缺陷（见 `fake-native-engine.mjs:151-157`、`181-184` 注释）。
4. **模式文件必须放仓库外**：`fake-native-engine.mjs:27-30` 解析模式文件时固定在仓库同级目录（`.native-mode-<repoName>`），放进仓库会变成未提交源码改动，被质量门 `uncommitted-input` 判成产品缺陷——探针与单测共用这条约束（`.probe-inc.mjs:29`、`.probe-nochange.mjs:78`）。
5. **fake-engine 的 `MODE` 是模块级可变全局**：`fake-native-engine.mjs:41` `let MODE='done'` 在 `run` 内被 `modeOf` 改写（`fake-native-engine.mjs:206`）；同一测试进程连续跑多用例时靠「仓库同级模式文件」而非 env 切换（`:21-26` 注释），否则会与仍在收尾的上一个任务竞态。
6. **`index.js` 整体未被探针单文件覆盖**：根探针只覆盖「集成运行」与「原生增量链路」，并不替代 35 个 `test-*.mjs` 的单元/契约断言——例如 `.probe-posix.mjs` 仅验证 `toPosix` 一条路径，未覆盖 `decodeGitPath` 的八进制转义解码（`lib/git-paths.js:53-88`）。
