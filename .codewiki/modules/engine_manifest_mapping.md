---
title: engine_manifest_mapping
type: module
source_files:
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/native-run.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - test-engine-manifest.mjs
  - test-engine-output.mjs
tags: [engine, manifest, lock, fsoft-output, mapping, migration]
---

## Overview

本模块有两个职责相邻、但彼此不直接调用的纯函数层，它们都属于「FSoft 原生引擎迁移」里**不重写算法、只做事实翻译与可信判定**的边界：

- `lib/engine/manifest.js`（阶段 2）：引擎环境清单与锁定。回答「现在跑的是哪个引擎、哪个 Python、依赖闭不闭合」，把当前指纹与落盘的 `.codewiki/engine-lock.json` 比对，给 `absent/match/drift/unhealthy/probe-failed` 五态结论。`doctor()` 把这一切翻成「可执行建议」。它解决的是最难查的一类问题：同一份 wiki 在不同机器 / 不同 pip 状态下产出不同结果，而错误会被误诊成「模型不听话」（manifest.js:1-13）。
- `lib/engine/mapping.js`（阶段 0）：FSoft 产物 → CodeWiki 写集的映射，是迁移里唯一一处「格式翻译」，边界刻意收窄到能被完整读一遍（mapping.js:1-26）。它把 FSoft 的 docs 树（overview.md + 模块页 + module_tree.json + metadata.json + update_record.json）翻成 cw 想要的「仓库内 `.codewiki/` 五类文章 + 顶层 `CodeWiki.md` 入口」。

两者都是**纯函数**（不读写文件、不 spawn，除了 `writeLock` 与 `readLock` 这两个显式落盘/读盘函数）。`manifest` 只被 `native-run.js` 在「env 阶段」调用；`mapping` 只被 `output.js` 在 `buildWritePlan`/`validateOutput` 里调用，再由 `quality-gate.js` 与 `apply-plan.js` 消费它的常量与写集结构。

## Key Components

### lib/engine/manifest.js

常量
- `MANIFEST_VERSION`（19|，值 `1`）：清单格式版本，写进 lock 与指纹哈希前缀。
- `ENGINE_LOCK_REL`（20|，值 `'.codewiki/engine-lock.json'`）：落锁相对路径，也是 `writeLock` 的返回值。

内部辅助
- `posix(p)`（22|）：把 `\` 统一成 `/`，仅记账用，不导出。

函数
- `probeEnvironment({ probe, engineRoot })`（34-45|）：调外部传入的 `probe()` 拿 `{version, pythonVersion, pipCheck:{ok,output}}`，归一化出 facts 对象并附带 `fingerprint`。**不在这里 spawn**——进程管理留在 `client.js`（manifest.js:34-35、28）。无 `probe` 函数直接抛 `需要 probe 函数`（35|）。
- `fingerprintOf(facts)`（50-56|）：对「决定产物内容」的两项取 16 位 sha256——`manifest:${MANIFEST_VERSION}\n` + `version:..\n` + `python:..\n`，再 `slice(0,16)`。**`pipCheckOk` 不进指纹**（修依赖不算换引擎，见 manifest.js:55-57）。
- `readLock({ repoRoot })`（61-75|）：读落盘 lock。文件不存在或坏 JSON（含 BOM 处理 `^\uFEFF`）都返回 `null`，不是错误——首次运行本来没有 lock（58-59、61-75）。
- `compareLock({ current, lock })`（86-111|）：比对当前指纹与 lock，返回**可机读的差异项**而非布尔/异常。五态：
  - `absent`：无 lock（88-90）；
  - `unhealthy`：`pipCheckOk !== true`，哪怕指纹一致（104-106）；
  - `drift`：version 或 pythonVersion 变了（94-99、107-109）；
  - `match`：完全一致（110）；
  - 若两项一致但 `fingerprint` 不一致，说明**指纹算法变了**，单独记一条 `fingerprint` diff（100-103）。
- `buildLockBody(current)`（125-136|）：**纯函数**，构造 lock 落盘正文（不写盘）。缺 `fingerprint` 抛错（126|）。返回 JSON 字符串，字段见下「Lock 文件结构」。
- `writeLock({ repoRoot, current })`（142-150|）：原子写——先写 `${file}.${process.pid}.tmp` 再 `renameSync`，避免半截文件；自动建 `.codewiki/` 目录（145|）。缺 `repoRoot` 抛错（143|）。返回 `ENGINE_LOCK_REL`。
- `doctor({ probe, repoRoot, engineRoot })`（156-185|）：一次调用把「引擎在不在、闭不闭合、和上次比有没有漂」全判出来，**不抛**（probe 抛错 → `status:'probe-failed'` 且 `ok:false`，160-168）。返回 `{ ok, status, current, diffs, advice }`，`advice` 按 `status` 取中文建议（171-177），其中 `unhealthy` 的建议指向 `tools/fsoft-engine/setup-env.sh`（175|）。

默认导出（187-196|）：聚合上述全部符号。

数据模型（本模块涉及的全部结构字段）
- **facts 对象**（`probeEnvironment` 返回，37-44|）：`version`(string,trim)、`pythonVersion`(string,trim)、`pipCheckOk`(boolean)、`pipCheckOutput`(string,trim)、`engineRoot`(posix string)、`fingerprint`(16 位 hex)。
- **Lock 文件结构**（`buildLockBody` 输出，127-135|）：
  - `manifestVersion`：恒为 `MANIFEST_VERSION`(1)；
  - `fingerprint`：16 位 hex；
  - `version`：string；
  - `pythonVersion`：string；
  - `engineRoot`：string（仅记录，用于审计）；
  - `pipCheckOk`：boolean；
  - `recordedAt`：**自动生成字段**，`new Date().toISOString()`（134|）——每次落锁刷新。
- **compareLock / doctor 返回**：
  - `status`：`'absent'|'match'|'drift'|'unhealthy'`（compareLock）或额外 `'probe-failed'`（doctor）；
  - `diffs`：`[{ field, locked, current }]`，`field` 为 `version`/`pythonVersion`/`fingerprint`；
  - `current` / `locked`：指纹字符串（compareLock），或完整 facts 对象（doctor 的 `current`）；
  - `ok`：boolean（doctor 独有，`status==='match'||'absent'` 才算 ok，179|）；
  - `advice`：string（doctor 独有）。

### lib/engine/mapping.js

依赖：`ENGINE_CONTRACT_VERSION` 从 `./contract.js` 导入（28|），写进 `mapFsoftOutput` 的 `contractVersion`。

常量（这些被 `quality-gate.js:40` 与 `apply-plan.js:39` 直接 import）
- `WIKI_ENTRY`（30|，`'CodeWiki.md'`）：入口页路径。
- `WIKI_DIR`（31|，`'.codewiki'`）：wiki 目录。
- `WIKI_META_REL`（32|，`'.codewiki/_meta.yaml'`）：元数据落点。
- `WIKI_UPDATE_RECORD_REL`（33|，`'.codewiki/temp/update-record.json'`）：update_record 搬运落点。
- `WIKI_MODULES_REL`（34|，`'.codewiki/modules'`）：模块文章目录。

内部辅助（不导出）
- `posix(p)`（46|）、`normalizeSourceFiles(list)`（48-58|，去重 + 去 `./` 前缀）、`sourceFilesOf(components, componentFiles)`（62-72|，只认组件→文件证据：组件 id `src/a.py::Class.method` 取 `::` 前文件，映射不到就取 id 的文件部分，无 `::` 且无映射则跳过）、`indexModuleTree(moduleTree)`（76-96|，把 FSoft 的 `{name:{path,components,children}}` 拍平成 `Map<name, {name,path,components,hasChildren,artifact,parent}>`）。

导出函数
- `moduleSlug(name)`（38-44|）：模块名 → kebab-case 文件名——非 `[A-Za-z0-9]` 全折叠成 `-`，首尾去 `-`，转小写。cw 既有文章命名一致（如 `core-application.md`）。
- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（115-268|）：**纯函数**，把 FSoft docs 树映射成 cw 写集描述。逐页处理（135-232|）：
  - `overviewName`（默认 `overview.md`）→ `entry`，重复出现则后到的进 `unmapped`（136-144|）；
  - 非 `.md` 页 → `unmapped`(非 markdown)；
  - 模块树为空（`whole-repository` 模式，`module_tree.json==={}`）时，页名不在树里**不算孤儿**：照写但 `attribution:'unattributed'`、`sourceFiles:[]`、带 warning（153-188|）；
  - 普通模式页名不在树里 → `unmapped`(页名在模块树中不存在，189-192|)；
  - slug 冲突（如 `A_B` 与 `A-B` 都 → `a-b`）两页都进 `unmapped`，且把先占用的页从 `articles` 里**撤回**（不静默覆盖，200-211|、165-175|）；
  - 正常页：查 `sourceFilesOf`，`pageKind` 由 `node.artifact`/`node.hasChildren` 决定 `artifact`/`parent`/`leaf`，`attribution:'attributed'`（213-231|）；
  - 模块树里有、但引擎没产出的模块 → 进 `warnings`（不静默丢弃，235-242|）。
  返回对象字段（255-267|）：
  - `contractVersion`：来自 `ENGINE_CONTRACT_VERSION`；
  - `entry`：`{path:WIKI_ENTRY, source}` 或 `null`；
  - `articles`：`[{source, wikiPath, type:'module', pageKind, moduleName, sourceFiles, attribution, warnings}]`；
  - `unmapped`：`[{source, reason}]`；
  - `meta`：`{lastCompiledCommit, layout, language}`（取自 `metadata.generation_info` 的 `commit_id/layout/language`，261-263|）；
  - `updateRecord`：`{path:WIKI_UPDATE_RECORD_REL, outcome, pagesWritten, pagesRemoved, source:'incremental'}` 或 `null`（245-253|）；
  - `warnings`：全局告警（未产出模块等）。

四条硬规则（迁移安全边界，mapping.js:16-26）：① 不臆造 source_files（拿不到就是空数组 + warning）；② 不静默丢弃（未映射页进 `unmapped` 带原因）；③ 不覆盖（slug 冲突两页都进 `unmapped`）；④ 不改技术内容（只搬路径与类型，正文一字不动）。

## Architecture

```text
┌──────────┐   docs树    ┌──────────────┐  pages/tree  ┌─────────────────┐
│ FSoft引擎 │ ─────────► │ output.js    │ ──────────► │ mapping.js      │
│ (python) │            │ collectBuild │            │ mapFsoftOutput()│
└──────────┘            └──────────────┘            └────────┬────────┘
                                                            │ entry/articles
                                                            ▼   +unmapped/warn
                                             ┌──────────────────────┐
                                             │ quality-gate.js      │
                                             │ + apply-plan.js      │
                                             │ (消费 WIKI_* 常量)    │
                                             └──────────────────────┘

┌────────────────┐  doctor ┌──────────────────────┐
│ native-run.js  │ ◄────── │ lib/engine/manifest.js│
│ env门 + 落锁    │        │ probe/compare/write   │
└────────────────┘        └──────────────────────┘
```

- `manifest.js` 与 `mapping.js` 互不 import；它们分别挂在 `native-run.js`（env 阶段）与 `output.js`（产物解析）这两根不同的消费链上。
- `mapping.js` 是唯一真正 import `contract.js` 的（取 `ENGINE_CONTRACT_VERSION`），`manifest.js` 不依赖契约层——它的产出是 `doctor` 结论，由 `native-run.js` 翻译成 `engineError({code:'engine-deps'/...})`（native-run.js:243-268）。
- `quality-gate.js:40` 与 `apply-plan.js:39` 只从 `mapping.js` 取 `WIKI_*` 路径常量，不调 `mapFsoftOutput`——后者只由 `output.js` 调（output.js:19、162-173）。

## Data Flow

### 环境可信判定流（manifest）
1. `native-run.js` 组装 `probe`（`runEngine({action:'doctor'})` 翻成 facts，native-run.js:194-216），调 `doctor({probe, repoRoot, engineRoot})`（220|）。
2. `doctor` → `probeEnvironment`（159|）拿 facts+指纹 → `readLock`（169|）读旧 lock → `compareLock`（170|）得 `status`/`diffs` → 拼 `advice` 返回（178-184|）。
3. `native-run.js` 按 `status` 裁决 env 阶段（native-run.js:228-268）：`probe-failed`/`drift`/`unhealthy` → 直接 `failed`（不跑引擎）；`absent` → 记「待落锁」；`match` → 继续。
4. 编译成功且 `.codewiki/_meta.yaml` 已存在后，才在 native-run.js:699-711 真正 `writeLockImpl({repoRoot, current:doc.current})` 落锁（首次运行不在编译前写，避免留下假锁，见 native-run.js:269-276）。

### 产物映射流（mapping）
1. `output.js:collectOutput`（91-124|）递归读 docs 目录，产出 `pages` 与 `json.{metadata,moduleTree,updateRecord}`（坏文件变 problem 不抛）。
2. `output.js:buildWritePlan`（162-173|）把上述喂给 `mapFsoftOutput`，得到写集描述（entry/articles/unmapped/meta/updateRecord/warnings）。
3. `output.js:validateOutput`（184-282|）在 `mapFsoftOutput` 结果上叠加自洽性判定（缺 overview、空正文、unmapped 页、`source_files` 指向不存在文件、死链、空模块树降级）。
4. `quality-gate.js` 复用 `validateOutput`，把 `articles` 渲染成真实 wiki 文章走 `article-contract.js` 校验，并按 `WIKI_ENTRY`/`WIKI_META_REL` 判定入口与基线。
5. `apply-plan.js` 用 `WIKI_DIR`/`WIKI_ENTRY` 作写集白名单（apply-plan.js:39、46|），只接受 `.codewiki/` 之下与仓库根 `CodeWiki.md`。

## Connections

- [[engine-native-run]]：`manifest.doctor`/`writeLock` 的唯一生产调用方，env 阶段裁决与落锁时机都在这（native-run.js:194-216、220、699-711）。
- [[engine-output]]：`mapFsoftOutput` 的唯一调用方，负责读 docs 树并把结果交给映射（output.js:19、162-173、184-282）。
- [[engine-contract]]：被 `mapping.js` 导入 `ENGINE_CONTRACT_VERSION`（mapping.js:28）；`manifest` 不依赖它，但 `native-run.js` 把 doctor 结论翻成 `engineError`/`engineResult`（contract.js:76-86 的 `engine-deps`/`engine-missing` code）。
- [[engine-quality-gate]]：复用 `mapFsoftOutput` 产物并消费 `WIKI_ENTRY`/`WIKI_META_REL`（quality-gate.js:40）；三类问题分类（defect/degradation/stale）建立在 mapping 的 `unmapped`/`warnings` 之上。
- [[engine-apply-plan]]：消费 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL` 作写集白名单（apply-plan.js:39、46|）。
- [[engine-native-state]]：跨轮受管状态的「无变化轮」判定与 lock 落锁时机相邻（native-run.js:528-623、699-711）；两者都体现「与文章同事务 / 不提前写」的同一思路。
- [[engine-client]]：`doctor` 动作的真正实现方——`native-run.js` 的 `probe` 经 `runEngine({action:'doctor'})` 走到这里（client.js），返回 `engine.deps` 证据。

## Known Issues

- **`buildLockBody` 的「同事务落锁」设想未接线（歧义点）**：`manifest.js:125-132` 的注释说把 lock 正文拆成 `buildLockBody`（纯函数，不写盘）是「为了 native-run 把这份正文当成 apply 写集里的一项，与文章/状态共享同一份 pre-image——写入与提交都跟着产物走，失败一起回滚」。但 `native-run.js` 实际接线（699-711|）是编译成功后在 apply **之外**单独调 `writeLockImpl`（即 `writeLock` 的原子写盘，内部于 manifest.js:142 调 `buildLockBody`）——**没有**把 `buildLockBody` 的产出嵌进 apply 的 `extraFiles` 写集。`buildLockBody` 本身仍被 `writeLock`（manifest.js:147）调用，不是孤儿函数；真正落空的是注释里设想的「lock 与文章同事务提交」。当前实现靠「只在 `_meta.yaml` 已存在 + apply 成功后才写」（native-run.js:699-711）规避「首次失败也留半截锁」的风险，但「无变化的轮也产生一次文档提交」的结构性风险注释里原本想靠同事务解决，现在并未实现。写文档时以实际代码（native-run.js:699-711）为准。
- **manifest 不联网、不装依赖、不修环境**（manifest.js:12-13）：`unhealthy` 只报不修，`native-run.js` 也明确「不重试、不装包、不先跑起来再说」（native-run.js:255-268）。这点是设计硬约束，不是未完成——上层（`tools/fsoft-engine/setup-env.sh`，即 doctor advice 里指向的脚本）才负责修复。
- **指纹不含 `engineRoot` / 机器路径**（manifest.js:22、50-56）：换目录、换机器不算漂移——指纹只吃 `version`+`pythonVersion`。这是有意设计（避免「换目录就误报 drift」），文档里「环境可信」仅指引擎与解释器版本 + pip 闭合，不含路径。
