---
title: test_cluster
type: module
source_files:
  - test-cluster.mjs
  - lib/cluster.js
  - lib/symbols.js
  - index.js
tags: [tests, clustering, modules, llm, subdivision, super-group]
---

## Overview

`test-cluster.mjs` 是 CodeWiki **组件聚类与模块分组**逻辑（`lib/cluster.js`）的专用测试套件。它覆盖三段式 LLM 聚类管线（顶层聚类 / 递归下钻 / 超级分组）以及全部降级路径，**全程不碰网络**——通过向 `clusterComponents` 注入假的 `llmCall` 桩模型来模拟 LLM 返回。文件是一个**顶层脚本**（无导出），在模块加载时依次 `await check(...)` 跑每个用例，末尾统计 `pass`/`fails` 并在有失败时 `process.exit(1)`（见 `test-cluster.mjs:416-420`）。

它从 `lib/cluster.js` 导入了 13 个公开符号（`test-cluster.mjs:4-9`）：`clusterComponents, heuristicCluster, fillMissing, moduleFiles, formatComponents, clusterPrompt, subClusterPrompt, superGroupPrompt, parseJsonLoose, parseClusterResponse, parseSuperGroups, normalizeModuleName, toPlanModules`。

用例按职责分成十组，全部用顶层 `await check` 注册（注释分隔行见源码）：

- 提示词（Prompts）— `test-cluster.mjs:43-62`
- JSON 抢救（JSON rescue）— `test-cluster.mjs:64-82`
- 响应解析（Response parsing）— `test-cluster.mjs:84-118`
- 启发式聚类（Heuristic clustering）— `test-cluster.mjs:120-150`
- 无 LLM 降级（No-LLM fallback）— `test-cluster.mjs:152-165`
- LLM 正常路径（LLM happy path）— `test-cluster.mjs:167-216`
- 下钻（Subdivision）— `test-cluster.mjs:218-267`
- 多层递归下钻（Multi-level recursive subdivision）— `test-cluster.mjs:269-359`
- 超级分组（Super grouping）— `test-cluster.mjs:361-402`
- plan 转换（plan conversion）— `test-cluster.mjs:404-414`

## Key Components

### 测试脚手架（Test harness）

- `check(label, fn)` — `test-cluster.mjs:13-22`：异步断言包装。`try { await fn() }` 成功则 `pass++` 并打 `PASS  <label>`；抛错则把 `{ label, err }` 压入 `fails[]` 并打 `FAIL  <label>`。无返回值。
- `makeComponents()` — `test-cluster.mjs:25-38`：造一个像真仓库的组件集。每个组件形如 `{ id: 'file#name', name, kind, relativePath, parameters: ['a'], sourceCode: 'function name(){}', dependsOn: [] }`。产出：6 个 `src/auth/login.js#login{i}`、5 个 `src/auth/token.js#token{i}`、7 个 `src/wiki/compile.js#compile{i}`、4 个 `src/panel/ui.js#render{i}`、外加 `package.json#scripts` 与 `README.md#docs`，以及一个 70 个组件的「大模块」`src/big/engine.js#engine{i}`（用于触发下钻）。
- 模块级 `components` / `allIds` — `test-cluster.mjs:40-41`：`makeComponents()` 只构造一次，供所有用例复用；`allIds = components.map(c => c.id)` 是「组件不丢失」断言的基准集合。

### 提示词用例（Prompts，line 43-62）

- `clusterPrompt 含全部 id 与数量声明` — `test-cluster.mjs:44-49`：断言 `clusterPrompt(formatComponents(components), components.length)` 命中 `/共 \d+ 个组件/`、包含 `src/auth/login.js#login0`、且含 `必须原样返回`。
- `formatComponents 按文件分组并标 artifact` — `test-cluster.mjs:51-55`：断言输出含 `# src/auth/login.js` 与 ` (artifact: config)`（验证 package.json 被标 artifact）。
- `subClusterPrompt / superGroupPrompt 结构完整` — `test-cluster.mjs:57-62`：断言 `subClusterPrompt('big', 'x', 3)` 含 `模块「big」`；断言 `superGroupPrompt([{ name:'a', path:'x', components:[1], summary:'s' }])` 含 `- a (path: x, 1 组件): s` 与 `架构子系统`。

### JSON 抢救用例（JSON rescue，line 64-82）

- `parseJsonLoose 剥围栏` — `test-cluster.mjs:65-68`：`'```json\n{"a":1}\n```'` → `{ a: 1 }`。
- `parseJsonLoose 取前后废话中的对象` — `test-cluster.mjs:70-73`：`'好的，结果如下：\n{"a":2}\n以上。'` → `{ a: 2 }`。
- `parseJsonLoose 修尾逗号` — `test-cluster.mjs:75-78`：`'{"a":[1,2,],}'` → `r.a` 深等于 `[1, 2]`。
- `parseJsonLoose 无 JSON 返回 null` — `test-cluster.mjs:80-82`：`'抱歉我不能'` → `null`。

### 响应解析用例（Response parsing，line 84-118）

- `parseClusterResponse 丢弃不存在的 id 并记警告` — `test-cluster.mjs:85-94`：返回的模块里含一个幽灵 id `src/auth/login.js#ghost`，验证被丢弃、警告数组含 `ghost`，且模块名被规范化为 `auth`。
- `parseClusterResponse 去重复分配（全空的模块被丢弃）` — `test-cluster.mjs:96-107`：同一 id 出现在两个模块，后出现的被丢弃导致第二个模块变空，验证最终只剩 1 个模块、警告含 `重复`。
- `parseClusterResponse 缺 modules 返回 null` — `test-cluster.mjs:109-111`：`'{"foo":1}'` → `null`。
- `normalizeModuleName 处理空格与特殊字符` — `test-cluster.mjs:113-118`：验证 `'Wiki Compile'`→`wiki_compile`、`'a/b:c'`→`a_b_c`、空串→`module`、中文 `'架构层'`→`'架构层'` 原样保留。

### 启发式聚类用例（Heuristic clustering，line 120-150）

- `heuristicCluster 按顶层目录分组` — `test-cluster.mjs:121-128`：断言模块名集合含 `src` 与 `root`；`src` 组的组件数等于 `allIds.length - 2`（除两个根文件外全在 src 下）。
- `fillMissing 把漏掉的组件挂到同目录模块` — `test-cluster.mjs:130-136`：构造只有 `auth` 模块的 modules，验证漏掉的 `src/auth/token.js#token0` 被补回 auth 模块。
- `fillMissing 无处归属时建 misc` — `test-cluster.mjs:138-144`：构造只有空 `auth` 模块，验证 `README.md#docs` 无处归属时新建 `misc` 模块且其 `components` 深等于 `['README.md#docs']`。
- `moduleFiles 汇总去重源文件` — `test-cluster.mjs:146-150`：同目录两个 id 只生成去重后的一个文件名 `['src/auth/login.js', 'src/auth/token.js']`。

### 无 LLM 降级用例（No-LLM fallback，line 152-165）

- `无 llmCall 时走目录启发式，组件不丢` — `test-cluster.mjs:153-159`：`clusterComponents({ components })`（不传 `llmCall`）→ 断言 `r.stats.llm === false`、最终 `Set(模块.components).size === components.length`、每个模块 `files.length > 0`。
- `空组件集返回空结果不抛错` — `test-cluster.mjs:161-165`：`clusterComponents({ components: [] })` → `r.modules` 深等于 `[]` 且 `r.warnings.length` 非空。

### LLM 正常路径用例（LLM happy path，line 167-216）

- `LLM 返回合法分组时按职责成模块` — `test-cluster.mjs:168-186`：桩模型按 `auth/wiki_compile/panel_ui/big/build` 五个职责返回合法分组（`splitThreshold: 1000`）。断言 `r.stats.llm === true`、模块名排序后等于 `['auth','big','build','panel_ui','wiki_compile']`、`auth.files` 等于 `['src/auth/login.js','src/auth/token.js']`、无组件丢失。
- `LLM 漏组件的部分由 fillMissing 补齐` — `test-cluster.mjs:188-199`：桩模型只返回 auth/wiki_compile（故意漏 panel/big/配置），验证 `fillMissing` 补齐后 `Set.size === components.length`。
- `LLM 抛错时整体降级为目录分组` — `test-cluster.mjs:201-208`：`llmCall` 抛 `quota exceeded`，断言 `r.stats.fallbacks >= 1`、警告含 `quota exceeded`、降级后组件不丢失。
- `LLM 返回垃圾文本时降级` — `test-cluster.mjs:210-216`：`llmCall` 返回 `'I cannot help with that'`，断言 `r.stats.fallbacks >= 1` 且组件不丢失。

### 下钻用例（Subdivision，line 218-267）

- `大模块超阈值时下钻成子模块，父节点不单独成文` — `test-cluster.mjs:219-250`：桩模型对 `模块「big」` 返回 `big_core`/`big_ext` 两个子模块（`splitThreshold: 60`）。断言 `r.stats.levels === 2`、模块名集合含 `big_core`/`big_ext`、不含 `big`（父节点只做导航容器，不成文）、组件无丢失、`r.tree` 中 `big` 节点的 `children.length === 2`。
- `下钻只返回一个子模块时视为不可再分` — `test-cluster.mjs:252-267`：桩模型对 `模块「big」` 只返回单子模块（保持原名），断言 `big` 仍作为一个成文模块存在（不拆开）。

### 多层递归下钻用例（Multi-level recursive subdivision，line 269-359）

- `makeDeepComponents()` — `test-cluster.mjs:274-282`：构造 72 个 `src/deep/a.js#deep{i}` + 3 个 `src/other/x.js#other{i}`，供层数可配的递归用例使用。
- `deepLlm(pool)` — `test-cluster.mjs:286-311`：桩模型——通过 `prompt.includes('共 ') && !prompt.includes('模块「')` 识别顶层调用，否则按提示词里的模块名把传入的 id 拆成两半（后缀 `_a`/`_b`），只要 id 数 ≥ 2 就继续拆。`pool` 显式传入（闭包捕获不了 `check` 回调里的局部变量）。
- `maxDepth=2 时只下钻一层（子模块不再往下拆）` — `test-cluster.mjs:313-327`：`splitThreshold: 2`、`maxDepth: 2` → 断言 `r.stats.levels === 2`，且遍历 `r.tree` 后所有节点 `!n.children || !n.children.length`（不应出现第三层）。
- `maxDepth=3 时下钻两层（出现孙模块）` — `test-cluster.mjs:329-343`：`splitThreshold: 2`、`maxDepth: 3` → 断言 `r.stats.levels === 3`、遍历树后 `maxSeen >= 3`。
- `下钻抛错不影响整体结果` — `test-cluster.mjs:345-359`：桩模型对 `模块「big」` 抛 `boom`，断言结果仍含 `big` 且组件不丢失。

### 超级分组用例（Super grouping，line 361-402）

- `顶层模块过多时归成子系统` — `test-cluster.mjs:362-387`：桩模型对含 `架构子系统` 的提示词返回 `core`(`auth`,`wiki_compile`) 与 `ui`(`panel_ui`,`build`) 两个子系统（`splitThreshold: 1000`、`topFanout: 3`）。断言 `r.tree` 中带 `children` 的父节点名排序后等于 `['core','ui']`、组件无丢失。
- `parseSuperGroups 对未归类模块保留在顶层` — `test-cluster.mjs:389-395`：`[{a},{b},{c}]` 喂入只收 `a,b` 的子系统，断言返回长度 2、`out[0].children.length === 2`、`out[1].name === 'c'`（未被收走的 `c` 留在顶层）。
- `parseSuperGroups 忽略不存在模块名` — `test-cluster.mjs:397-402`：子系统引用幽灵模块 `ghost`，断言 `out[0].children.length === 1`、警告含 `ghost`。

### plan 转换用例（plan conversion，line 404-414）

- `toPlanModules 输出插件任务清单形状` — `test-cluster.mjs:405-414`：对 `clusterComponents({ components })` 结果调 `toPlanModules`，断言数组非空、每个 `m.name` 为字符串、`m.files` 为长度 >0 的数组、`m.summary` 为字符串。

### 被测试源（lib/cluster.js，供定位；全量细节见 [[cluster]]）

以下均从 `test-cluster.mjs:4-9` 导入，行号对应 `lib/cluster.js`：

- `formatComponents` — `lib/cluster.js:28-46`
- `clusterPrompt` — `lib/cluster.js:57-81`
- `subClusterPrompt` — `lib/cluster.js:84-103`
- `superGroupPrompt` — `lib/cluster.js:106-129`
- `parseJsonLoose` — `lib/cluster.js:135-153`
- `parseClusterResponse` — `lib/cluster.js:156-195`
- `normalizeModuleName` — `lib/cluster.js:198-206`
- `heuristicCluster` — `lib/cluster.js:219-244`
- `fillMissing` — `lib/cluster.js:247-268`
- `moduleFiles` — `lib/cluster.js:274-281`
- `clusterComponents` — `lib/cluster.js:291-389`
- `parseSuperGroups` — `lib/cluster.js:425-456`
- `toPlanModules` — `lib/cluster.js:460-467`

## Architecture

`test-cluster.mjs` 是扁平顶层脚本：一段共享 fixture 构造 + 十个用例组，全部经 `check()` 串联到末尾的计数与退出。组件数 ≥3、流程非平凡，框图如下：

```text
   test-cluster.mjs  (顶层脚本，13 个导入自 lib/cluster.js)
   ┌──────────────────────────────────────────────────────┐
   │ makeComponents()-> components/allIds  (line 25-41)    │
   └───────────────────────────┬──────────────────────────┘
                               │ 共享 fixture
        ┌──────────┬───────────┼────────────┬──────────────┐
        ▼          ▼           ▼            ▼              ▼
   prompt     JSON rescue  parse resp   heuristic     LLM path
   cases      cases        + normalize  cases         (fallback/happy)
   (44-62)    (64-82)      (84-118)     (120-150)     (152-216)
                                                          │
                                          ┌───────────────┼───────────────┐
                                          ▼               ▼               ▼
                                      subdivide      multi-level       super-group
                                      (218-267)      (269-359)         (361-402)
                                                                │
                                                                ▼
                                                      toPlanModules (404-414)
        │
        ▼
   check() 累加 pass/fails -> process.exit(fails?1:0)  (416-420)
```

调用关系补充：
- `check`（`test-cluster.mjs:13`）是唯一的断言入口；所有用例都用 `await check('label', async () => {...})` 注册。
- LLM 路径用例通过闭包判断 `prompt.includes('模块「big」')` 区分「顶层聚类」与「下钻」两次请求（如 `test-cluster.mjs:220-240`），从而用同一个 `llmCall` 桩精确喂不同响应。
- 多层递归用例用 `deepLlm(pool)`（`test-cluster.mjs:286`）根据提示词形态决定拆两份，专门验证 `maxDepth` 是真实层数上限（旧实现把它当 `>1` 的布尔开关，配 2 与配 3 行为相同）。

## Data Flow

本套件是纯脚手架：构造 fixture → 注入桩 `llmCall`（或不注入）→ `await clusterComponents` → 对返回值 `r.modules` / `r.tree` / `r.stats` / `r.warnings` 断言。两个 fixture 构造器：`makeComponents()`（`test-cluster.mjs:25`，6+5+7+4+2+70 个组件）供通用/下钻/超级分组用例；`makeDeepComponents()`（`test-cluster.mjs:274`，72+3 个组件）供 `maxDepth` 可配的递归用例。`allIds = components.map(c => c.id)`（`test-cluster.mjs:41`）即传给 `parseClusterResponse` 的 `validIds` 池，也是「组件不丢失」不变量的目标。

核心不变量：无论 LLM 全程成功、部分失败还是完全不可用，最终 `new Set(r.modules.flatMap(m => m.components)).size === components.length` 必须成立。该断言出现在几乎每个 LLM / 降级 / 下钻用例中（如 `test-cluster.mjs:157`、`185`、`198`、`207`、`215`、`247`、`358`）。

每个用例的通用形态：

1. 构造 `llmCall` 闭包（常据 `prompt.includes('模块「big」')` 分流顶层 vs 下钻，见 `test-cluster.mjs:220-240`）；
2. `await clusterComponents({ components, llmCall, splitThreshold?, maxDepth?, topFanout? })`；
3. 断言 `r.stats` / `r.modules` / `r.tree` / `r.warnings`。

关于 `maxDepth` 可配性：`cluster.md` 源历史实现中 `maxDepth` 只被当布尔 `>1` 开关（配 2 与 3 行为完全一样）；`deepLlm`（`test-cluster.mjs:286`）+ `maxDepth=2/3` 用例（`test-cluster.mjs:313-343`）把「层数可配」这一正确行为钉死。

## Connections

- [[cluster]] — 被测模块。`lib/cluster.js` 的全部 13 个导出都在 `test-cluster.mjs:4-9` 被导入并逐一测试；函数级细节、返回值形状与三段式管线全貌见 [[cluster]]。
- [[symbols]] — `makeComponents`/`makeDeepComponents` 构造的组件形状（`{id, name, kind, relativePath, parameters, sourceCode, dependsOn}`）镜像自 `lib/symbols.js` 的 `extractRepoGraph` 输出（形状见 `lib/symbols.js:785-786`，id 约定 `path#name` 见 `lib/symbols.js:10`）。
- [[index]] — `semanticPlan()`（`index.js:1322`）是 `clusterComponents`/`toPlanModules` 唯一的生产调用方；本套件保证其规划阶段确定性且永不丢组件。

## Known Issues

- 套件只通过公开契约（返回的 `modules`/`tree`/`stats`/`warnings`）验证行为，**不断言 `llmCall` 被调用的确切次数**，因此「模型直接返回已正确数据、根本没触发下钻」的桩也能通过无丢失检查。
- 多层递归用例里的下钻桩 `deepLlm`（`test-cluster.mjs:286`）依赖 `prompt.includes('共 ') && !prompt.includes('模块「')` 来识别顶层；若 `clusterPrompt` 文案变动，该桩会静默误判、导致过度拆分——这个测试与提示词文本耦合。
- `topFanout` 默认 14（`lib/cluster.js:347`）但测试只用了 `topFanout: 3`（`test-cluster.mjs:382`）；默认的超级分组触发阈值，以及 `superGroup !== false` 这个 opt-out 分支（`lib/cluster.js:348`）未直接覆盖。
- `下钻抛错不影响整体结果` 用例（`test-cluster.mjs:345-359`）只断言 `big` 存活且组件无丢失，**未断言 `stats.fallbacks >= 1`** 来精确确认下钻失败被计入降级。
- 默认 `splitThreshold` 为 60（`lib/cluster.js:330`），测试在 60/30/2 三档都跑了，但没显式断言该默认值本身；测试靠「不传 `splitThreshold` 即走默认」这一隐式依赖而非显式检查。
