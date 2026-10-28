---
title: engine_manifest
type: module
source_files:
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/output.js
  - lib/engine/apply-plan.js
  - test-engine-manifest.mjs
  - test-engine-output.mjs
tags: [engine, manifest, lockfile, environment-probing, source-mapping, fsoft, migration]
---

## Overview

`engine_manifest` 这个模块名实际覆盖仓库里**两个紧邻的源文件**，它们都属于 Node ↔ Python 引擎（FSoft）迁移的「引擎对接」层：

- `lib/engine/manifest.js` —— 引擎环境探测、lockfile（指纹）比对、只读诊断。回答「现在跑的是哪个引擎、哪个环境、和上次比有没有漂」。
- `lib/engine/mapping.js` —— FSoft 产物（docs 树）到 CodeWiki 写集（`.codewiki/` + 仓库根 `CodeWiki.md`）的**格式翻译**。回答「引擎吐出来的这些页，分别落到 wiki 的哪个位置、带什么 `source_files`」。

两者的共同命题都是**「外部引擎的产物必须可被校验、可机读、不准静默出错」**：FSoft 是外部引擎，版本与依赖不受本仓库控制；同一份 wiki 在不同机器/不同 pip 状态下会产出不同结果，而错误会表现为「模型不听话」而不是「环境漂了」——最难查的一类问题。`manifest.js` 把环境漂移项用指纹固定下来，`mapping.js` 则把产物结构按四条硬规则翻译成 wiki 写集，杜绝臆造 `source_files`、静默丢弃页、静默覆盖。

两个文件都是**纯函数 / 只读诊断**：不装依赖、不修环境、不联网、不 spawn 进程。`manifest.js` 把进程管理（spawn Python、拿 `version`/`pythonVersion`/`pipCheck`）交给调用方通过 `probe` 注入（见 `probeEnvironment` 第 34 行）；`mapping.js` 把文件读写交给上层 `output.js`（`buildWritePlan` 第 162 行）。这样两层都保持「纯的、可单测」。

## Key Components

### lib/engine/manifest.js

**常量**

- `MANIFEST_VERSION` — `lib/engine/manifest.js:19`，清单格式版本，当前为 `1`。写入 lock 与指纹盐里都带它（见 `fingerprintOf` 第 52 行、`writeLock` 第 123 行）。
- `ENGINE_LOCK_REL` — `lib/engine/manifest.js:20`，lock 文件的相对路径常量 `.codewiki/engine-lock.json`。`readLock`/`writeLock` 都用它拼路径。
- `posix` — `lib/engine/manifest.js:22`，内部小工具，把 Windows 反斜杠统一成 `/`，用于 `engineRoot` 与临时文件路径归一（不导出）。

**函数**

- `probeEnvironment({ probe, engineRoot })` — `lib/engine/manifest.js:34`。调用方注入 `probe`（`() => Promise<{version, pythonVersion, pipCheck:{ok,output}}>`）；它只做「只读收集」：trim 出 `version` / `pythonVersion`，取 `pipCheck.ok` 与 `pipCheck.output`，记录 `engineRoot`（仅审计，POSIX 化），最后算出 `fingerprint`。没有 `probe` 函数直接抛 `需要 probe 函数`（第 35 行）。返回对象（即下面的 `facts` 结构）。

- `fingerprintOf(facts)` — `lib/engine/manifest.js:50`。**指纹只吃决定产物内容的因素**：`MANIFEST_VERSION` + `version` + `pythonVersion`，用 sha256 取前 16 位 hex。**`pipCheck.ok` 不进指纹**——依赖闭合是「能不能跑」的闸门，不是「产物会是什么」的输入（第 47–49 行注释），否则每次修依赖都像换了引擎。

- `readLock({ repoRoot })` — `lib/engine/manifest.js:61`。读已落盘的 lock。文件不存在或 JSON 坏了都返回 `null`（不是错误：首次运行本来没有 lock，第 59 行注释）。会先剥 BOM（`\uFEFF`，第 70 行）。

- `compareLock({ current, lock })` — `lib/engine/manifest.js:86`。比对当前指纹与 lock，返回**可机读的差异项**（不是抛错、不是布尔）。四种 `status`：
  - `'absent'` — 没有 lock（首次运行，第 89 行）；
  - `'match'` — 完全一致（第 110 行）；
  - `'drift'` — `version` 或 `pythonVersion` 变了（产物可能不同，第 108 行）；`diffs` 逐项指出 `locked`/`current`；
  - `'unhealthy'` — 指纹一致但 `pipCheckOk !== true`（能跑但不可信，第 105 行）；
  - 若 `version`/`pythonVersion` 都一致但 `fingerprint` 不一致，说明指纹算法变了（第 100–103 行）。
  - 缺 `current` 直接抛 `需要 current 指纹`（第 87 行）。

- `writeLock({ repoRoot, current })` — `lib/engine/manifest.js:117`。把当前环境事实写成 lock，**原子写**：先写 `${file}.${pid}.tmp` 再 `renameSync`（第 131–133 行），避免半截文件。缺 `repoRoot` 抛 `需要 repoRoot`（第 118 行），缺 `fingerprint` 抛 `需要带 fingerprint 的 current`（第 119 行）。返回写入的相对路径（`ENGINE_LOCK_REL`）。

- `doctor({ probe, repoRoot, engineRoot })` — `lib/engine/manifest.js:141`。一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出来，返回 `{ok, status, current, diffs, advice}`——**不抛**：`probe` 抛错变成 `status:'probe-failed'`、`ok:false`（第 145–153 行）。`ok` 为真仅当 `match` 或 `absent`（第 164 行）；`advice` 文案按 `status` 映射（第 156–162 行），`unhealthy` 会指向 `tools/fsoft-engine/setup-env.sh` 修复环境。

- 默认导出对象 — `lib/engine/manifest.js:172`，聚合上面所有导出。

**数据结构（由函数产出的事实对象）**

`probeEnvironment` 返回的 `facts` 对象（`lib/engine/manifest.js:37-44`）字段：
- `version: string` — 引擎版本（trim）。
- `pythonVersion: string` — Python 版本（trim）。
- `pipCheckOk: boolean` — `pipCheck.ok === true`。
- `pipCheckOutput: string` — pip check 输出（trim）。
- `engineRoot: string` — POSIX 化的引擎源码根（仅审计；无则空串）。
- `fingerprint: string` — 由 `fingerprintOf` 算出，16 位 hex。

`writeLock` 写入磁盘的 lock 文件体（`lib/engine/manifest.js:117-125`）字段：
- `manifestVersion: number` — 即 `MANIFEST_VERSION`。
- `fingerprint: string` — 当前指纹。
- `version: string` / `pythonVersion: string` — 记录用。
- `engineRoot: string` — 记录用。
- `pipCheckOk: boolean` — 记录用。
- `recordedAt: string` — `new Date().toISOString()`，自动生成的写入时间戳（第 129 行）。

### lib/engine/mapping.js

**常量**

- `WIKI_ENTRY = 'CodeWiki.md'` — `lib/engine/mapping.js:30`，顶层入口页（不是「文章」）。
- `WIKI_DIR = '.codewiki'` — `lib/engine/mapping.js:31`，wiki 根目录。
- `WIKI_META_REL = '.codewiki/_meta.yaml'` — `lib/engine/mapping.js:32`。
- `WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'` — `lib/engine/mapping.js:33`。
- `WIKI_MODULES_REL = '.codewiki/modules'` — `lib/engine/mapping.js:34`。
- 内部 `posix`（第 46 行）、内部 `normalizeSourceFiles`（第 48 行，去重 + 剥离 `./` 前缀）不导出。

**函数**

- `moduleSlug(name)` — `lib/engine/mapping.js:38`。模块名 → kebab-case 文件名：非 `[A-Za-z0-9]` 折叠成 `-`、去首尾 `-`、转小写。与 cw 现有命名（如 `core-application.md`）一致。

- `sourceFilesOf(components, componentFiles)` — `lib/engine/mapping.js:62`（内部）。模块页的 `source_files`：组件 id 形如 `src/a.py::Class.method`，取 `::` 前的文件部分；`componentFiles` 里没有该组件则不计入（宁缺勿造，第 60–71 行）。无 `::` 且无映射的组件跳过（不猜）。

- `indexModuleTree(moduleTree)` — `lib/engine/mapping.js:76`（内部）。把 FSoft `module_tree.json`（`{name:{path,components,children}}`）拍平成 `Map<name, node>`，`node` 含 `name/path/components/hasChildren/artifact/parent`。`artifact` 在节点标记 `artifact` 或名字匹配 `^artifacts?$` 时为 `true`（第 88 行）。

- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })` — `lib/engine/mapping.js:115`。**本模块核心纯函数**。把 FSoft docs 树翻译为 cw 写集描述，不读写文件、不 spawn。入参见签名（第 115–122 行），返回对象（`lib/engine/mapping.js:255-267`）：

  - `contractVersion` — 取自 `ENGINE_CONTRACT_VERSION`（`contract.js:20`）。
  - `entry` — `{path:'CodeWiki.md', source}` 或 `null`（overview 页）。
  - `articles` — `[{source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings}]`。`pageKind` 为 `leaf`/`parent`/`artifact`（第 226 行）；`attribution` 为 `attributed`（有树证据）或 `unattributed`（whole-repository 空树模式，第 184 行）。
  - `unmapped` — `[{source, reason}]`，任何没被映射的页都进这里，带可机读原因（第 22 行硬规则 2：不静默丢弃）。
  - `meta` — `{lastCompiledCommit, layout, language}`，取自 `metadata.generation_info`。
  - `updateRecord` — `{path, outcome, pagesWritten, pagesRemoved, source:'incremental'}` 或 `null`。
  - `warnings` — 全局告警（如「模块树含 X，但未产出 X.md」第 241 行）。

  **四条硬规则（迁移安全边界，`lib/engine/mapping.js:16-26`）**：
  1. 不臆造 `source_files`：拿不到真实证据就是空数组 + warning（第 17–20 行、第 215–216 行）；
  2. 不静默丢弃：未映射页进 `unmapped`（第 21–22 行、第 189–190 行）；
  3. 不覆盖：slug 冲突（如 `A_B` 与 `A-B` 都 → `a-b`）两页都进 `unmapped`（第 23–24 行、第 200–211 行）；
  4. 不改技术内容：只搬路径与类型，正文一字不动。

  特殊分支：whole-repository 模式下 `module_tree.json` 是 `{}`（第 153 行注释引用 `documentation_generator.py:241`），页名不在树里不等于孤儿页——页照写，但 `source_files` 留空 + `attribution:'unattributed'` + warning（第 153–187 行）。

## Architecture

两文件都是「纯函数 + 只读」，处于 Node 接入链的最外缘。它们被 `output.js`（产物校验）和 `engine/client.js`（进程 + 协议）消费，向下对 Python 引擎与磁盘只读：

```text
                Python 引擎 (FSoft, 外部)
                       │  spawn + JSON-lines (client.js)
                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │ lib/engine/client.js  runEngine()                         │
   │   • action: doctor/generate/update/cancel                 │
   │   • probe() 注入 → 拿 version/pythonVersion/pipCheck      │
   └───────────────┬───────────────────────┬──────────────────┘
                   │ doctor 结果            │ generate/update 产出 docs/
                   ▼                        ▼
   ┌───────────────────────────┐   ┌──────────────────────────────────────┐
   │ lib/engine/manifest.js     │   │ lib/engine/output.js (buildWritePlan) │
   │  probeEnvironment          │   │   collectOutput(docs/)                │
   │  fingerprintOf             │   │      │                                 │
   │  readLock / compareLock    │   │      ▼                                 │
   │  writeLock / doctor        │   │   lib/engine/mapping.js               │
   │   → .codewiki/engine-lock  │   │     mapFsoftOutput()                  │
   │     .json                  │   │      → articles/unmapped/entry/meta   │
   └───────────────────────────┘   └───────────────┬──────────────────────┘
                                                    │ 写入集
                                                    ▼
                              lib/engine/apply-plan.js  applyNativeOutput()
                              (落盘 .codewiki/ + CodeWiki.md)
```

`contract.js` 的 `ENGINE_CONTRACT_VERSION`（`contract.js:20`）被 `mapping.js:256` 直接引用写进返回体的 `contractVersion`；`apply-plan.js:39` 复用 `mapping.js` 的 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL` 作为写集白名单（`APPLY_WRITE_ROOTS`，`apply-plan.js:46`）。

## Data Flow

### manifest.js 数据流

1. 调用方（如 `client.js` 的 `doctor` action）注入 `probe`，`probeEnvironment`（`manifest.js:34`）收集 `version`/`pythonVersion`/`pipCheck` → 调 `fingerprintOf`（第 50 行）算 16 位指纹。
2. `readLock`（`manifest.js:61`）读 `.codewiki/engine-lock.json` 回放上次落盘事实（不存在/坏 JSON → `null`）。
3. `compareLock`（`manifest.js:86`）把「当前指纹」与「lock」比对，产出 `status` + `diffs`。
4. `doctor`（`manifest.js:141`）把上述三步合成为 `{ok, status, current, diffs, advice}`；`status` 与 `advice` 的对应关系见第 156–162 行。
5. 若上层决定「接受当前环境」，`writeLock`（`manifest.js:117`）以「写 tmp + rename」原子落盘 `engine-lock.json`，含 `recordedAt` 时间戳（第 129 行）。

### mapping.js 数据流

1. `output.js` 的 `collectOutput`（`output.js:91`）递归扫 docs 目录得到 `pages`（markdown 列表）与四个 JSON（`metadata.json`/`module_tree.json`/`first_module_tree.json`/`update_record.json`）。
2. `output.js` 的 `buildWritePlan`（`output.js:162`）把上述产物连同 `componentFiles`（组件 id → 仓库相对文件）传给 `mapFsoftOutput`（`mapping.js:115`）。
3. `mapFsoftOutput` 内部：`indexModuleTree`（`mapping.js:76`）把模块树拍平 → 逐页走映射逻辑：overview 归入口、其他页按 `moduleSlug` 归 `.codewiki/modules/<slug>.md`，`sourceFilesOf`（`mapping.js:62`）只认 `componentFiles` 证据 → 产出 `entry/articles/unmapped/meta/updateRecord/warnings`。
4. `output.js` 的 `validateOutput`（`output.js:184`）消费 `mapped`：把 `unmapped` 升级为 `unmapped-page` problem（第 228 行）、把 `warnings` 里「未产出」升级为 `article-missing`（第 231–233 行）、`repoRoot` 存在时校验 `sourceFiles` 真实存在（第 236–248 行）。
5. 最终写集交给 `apply-plan.js` 的 `applyNativeOutput` 落地；`apply-plan.js:414` 复用 `mapping.js` 的 `WIKI_*` 常量做路径白名单。

## Connections

- [[engine-client]] — `client.js` 通过 `runEngine` 的 `doctor` action 跑环境探测，是 `manifest.js` 在进程层的唯一调用方；`ENGINE_STAGES` 里的 `env` 阶段即对应 doctor（`contract.js:25`）。
- [[engine-contract]] — `contract.js` 的 `ENGINE_CONTRACT_VERSION`（`contract.js:20`）被 `mapping.js:256` 写进返回体；`engine.deps` 结构（`contract.js:133-136`）承载 doctor 结论（ok + pip check 摘要）。
- [[engine-output]] — `output.js` 的 `buildWritePlan`（`output.js:162`）与 `validateOutput`（`output.js:184`）消费 `mapping.js` 的 `mapFsoftOutput` 结果。
- [[engine-apply-plan]] — `apply-plan.js:39` 复用 `mapping.js` 的 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL` 作为写集白名单（`APPLY_WRITE_ROOTS`，`apply-plan.js:46`）。
- [[engine-quality-gate]] — 质量门基于 `output.js`/`mapping.js` 产出的写集做采用裁决，与 `manifest.js` 的环境可信判据共同决定本次编译能否成立。

## Known Issues

- `manifest.js` 的 `doctor` 是**只读诊断**，不联网、不修环境（第 12–13 行注释）。环境不闭合（`unhealthy`）时只给建议指向 `tools/fsoft-engine/setup-env.sh`，真正修复依赖是 1A 阶段 `setup-env.sh` 的职责——`manifest.js` 本身无此能力。
- `fingerprintOf`（`manifest.js:50`）有意**不含 `pipCheck.ok`**：意味着「修依赖、但版本不变」不会触发 `drift`，只会把已落盘 lock 里的 `pipCheckOk` 留旧（直到下次 `writeLock` 才更新）。这是设计取舍，不是 bug；但要注意 lock 在 `unhealthy` 修复后应被重写。
- `readLock`（`manifest.js:61`）对坏 JSON 返回 `null` 且**不报原因**：首次运行与坏 lock 在 `compareLock` 眼里都是 `absent`，上层无法区分「从没写过」与「写坏了」。排查时需直接看 `.codewiki/engine-lock.json` 内容。
- `mapping.js` 在 whole-repository 空树模式（`module_tree.json === {}`，`mapping.js:213`）下，所有页都标 `attribution:'unattributed'`、`sourceFiles` 全空——这会直接削弱 0.14.0 增量归属（`source_files` 闸门），使未消化的变化可能被基线化。这是引擎产物模式决定的，调用方（`output.js` 的 `empty-module-tree` problem，`output.js:204-207`）已把它升级为告警，但仍非致命。
- `mapFsoftOutput` 是纯函数、不校验磁盘上页是否真实存在；页「存在但正文为空」这类问题由 `output.js` 的 `bodyLength`（`output.js:127`）在 `validateOutput` 阶段（`output.js:184-200`）补判，不在 `mapping.js` 职责内。

