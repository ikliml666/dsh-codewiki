---
title: 仓库反复出现的模式
type: pattern
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/incremental.js
  - lib/update-planner.js
  - lib/change-set.js
  - lib/symbols.js
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - test-update-planner.mjs
  - lib/update-record.js
  - lib/engine/client.js
  - lib/engine/manifest.js
  - lib/engine/process-tree.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-manifest.mjs
  - test-engine-process-tree.mjs
  - test-engine-client.mjs
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - test-engine-contract.mjs
  - test-engine-apply-plan.mjs
  - lib/article-contract.js
  - test-engine-output.mjs
  - test-engine-output-real.mjs
  - lib/articles-agentic.js
  - test-batch.mjs
  - test-articles-agentic.mjs
  - test-engine-quality-gate.mjs
  - test-engine-python-entry.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-bridge.mjs
  - tools/fsoft-engine/probe-apply-real-cw.mjs
  - tools/fsoft-engine/probe-index-missing.mjs
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/probe-generate.result.json
  - tools/fsoft-engine/probe-no-llm-graph.result.json
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-cwd-paths.mjs
  - test-prune-orphans.mjs
  - test-sessions.mjs
  - test-worktree.mjs
tags: [pattern, naming, error-handling, testing, directory, contract]
---

## Overview

通读仓库各模块文章（涵盖图差异、聚类、变更集、引擎运行时、契约、落地、输出、质量门、Python 入口、测试等）后，可以提取出一组在多个模块中反复出现的工程模式。这些模式体现了仓库在命名、错误处理、测试、目录布局、跨进程契约等方面的统一约定。下文按模式分节，每节均引用具体模块文章中出现过的文件路径与函数名/行号作为证据。

## Patterns

### 组件 ID 与路径命名约定

仓库中“组件”这一概念贯穿图提取、差异、聚类、规划等多个模块，其标识符与路径格式高度一致。

- `lib/graph-diff.js:9-10` 与 `lib/symbols.js:13-14` 共同约定节点 id 为 `<相对路径>#<符号名>`（上游为 `path::name`，这里用 `#` 避免与 Windows 盘符冲突）。
- `lib/cluster.js:57` 的 `clusterPrompt` 提示词中明确要求模型返回 `<相对路径>#<符号名>` 形式，且必须原样返回。
- 路径归一化函数多处出现：`lib/change-set.js:33` 的 `normChangePath` 将反斜杠转 POSIX、丢弃 `../` 越界路径；`index.js:209` 的 `normalizeArticlePath` 将 `\` 统一替换为 `/`；`lib/engine/apply-plan.js:75` 的 `toPosix` 做类似处理。
- 模块文件名生成使用 slug：`lib/engine/mapping.js:38` 的 `moduleSlug` 将模块名转 kebab-case，`index.js:1670` 的 `slugify` 保留 CJK 清空格，两者均用于 `.codewiki/modules/<slug>.md` 落盘。

### 冻结常量与只增不删的枚举表

跨模块普遍使用大写蛇形常量，并通过 `Object.freeze` 固化，枚举类词表强调“只增不删”以保持向后兼容。

- `lib/engine/contract.js:20` 定义 `ENGINE_CONTRACT_VERSION` 及 `BLOCKER_KINDS`（`lib/engine/contract.js:42`）等冻结枚举，注释要求新增只允许追加。
- `lib/engine/apply-plan.js:46` 的 `APPLY_WRITE_ROOTS` 为 `Object.freeze(['.codewiki','CodeWiki.md'])`；`lib/engine/apply-plan.js:49` 的 `APPLY_STAGES` 同样冻结。
- `lib/engine/quality-gate.js:45-59` 的 `GATE_DEFECT_KINDS` / `GATE_DEGRADATION_KINDS` / `GATE_STALE_KINDS` 均为 `Object.freeze` 数组，供 `DEFECT_SET` 等 `Set` 做合法性校验（`lib/engine/quality-gate.js:74-76`）。
- `lib/change-set.js:19` 的 `CHANGE_SET_VERSION` 与 `lib/engine/manifest.js:19` 的 `MANIFEST_VERSION` 均取固定版本号 `1`，写入产物供反序列化校验。

### 信任边界内的抛错与边界外的可校验返回

模块对“内部构造”与“外部输入”采取双轨错误处理：纯构造函数在可信边界内遇非法输入直接抛错；反序列化/解析函数在信任边界外返回 `{ok, errors}` 或 `null`+警告，绝不抛异常中断流程。

- `lib/engine/contract.js:97` 的 `engineResult` 在 `done` 带 blockers 等非法情况下抛错；而 `lib/engine/contract.js:186` 的 `validateEngineResult` 在磁盘/旧版本对象上返回 `{ok, errors}` 不抛。
- `lib/change-set.js:99-102` 规定 `ChangeSet.ok=false` 时一定带 `state` 与 `fallback='full'`，调用方据此退回全量，不把“采不到”当“没变化”。
- `lib/cluster.js:156` 的 `parseClusterResponse` 解析失败返回 `null` 并 `warnings.push`；`lib/cluster.js:294` 的 `normalizeModuleName` 空名回落 `'module'` 而非报错。
- `lib/engine/quality-gate.js:405` 的 `pushDefect`/`pushDegradation` 先校验 kind 是否在冻结表内，否则抛错，逼调用方补映射。

### 降级而非中断的 Fallback 策略

面对 LLM 失效、环境缺失、超预算等情形，模块倾向降级到安全路径而非让整条流水线崩溃。

- `lib/cluster.js:311-324` 在无 `llmCall` 或 LLM 抛错时 `stats.fallbacks += 1` 并回落 `heuristicCluster`（按目录分组），保证组件不丢。
- `lib/change-set.js:73` 的 `emptyChangeSet` 配合各降级分支统一补 `fallback:'full'`，如 `missing-base`/`no-git`/`unreachable-base` 均退回全量编译。
- `lib/graph-diff.js:391` 的长度剪枝仅为性能优化，最终仍以 `sim >= tauRen`（`lib/graph-diff.js:393`）为准，不因近似而误判。
- `lib/engine/client.js:331` 的 `killTree` 在超时/取消时调用 `terminateProcessTree`（`lib/engine/process-tree.js:61`）杀整棵进程组而非仅直接子进程，避免孤儿进程烧 token。

### 依赖注入以支持离线单测

核心逻辑均通过参数注入外部依赖（git 执行器、LLM 调用、进程启动器），从而可在不启动宿主服务或真实引擎的情况下单测。

- `lib/change-set.js:102,107` 的 `collectChangeSet(cwd, baseCommit, opts={})` 接受 `opts.execFile` 注入，测试用假执行器绕过真实 git。
- `lib/cluster.js:291` 的 `clusterComponents(opts)` 接受 `opts.llmCall`，不传则走 `heuristicCluster`；`test-cluster.mjs` 注入模拟 llmCall。
- `lib/engine/apply-plan.js:414` 的 `applyNativeOutput(opts)` 通过 `deps` 注入 `runCw`/`commit`/`verifyCommit`，且刻意不 import `index.js` 避免拉起宿主。
- `lib/engine/llm-bridge.js:90` 的 `startLlmBridge({llm, provider, model})` 注入宿主 `llm.stream`，桥自身不存凭证。

### 黄金基准对拍与零框架测试

测试普遍采用裸 Node 脚本（`process.exit` 门），并通过 Python 原版生成 JSON 基准做逐字节对拍，保证移植一致性。

- `test-fixtures/gen-graphdiff-golden.py` 用 Python `difflib`/`hashlib` 生成 `test-fixtures/graphdiff-golden.json`；`test-graphdiff.mjs:2-16` 遍历 `cases` 对拍 `bodySimilarity`/`bodyHash`/`unifiedDiff`，容差 `<1e-12`。
- `test-wiki-anchors.mjs:172-176` 与 `test-wiki-entry.mjs:13-16` 定义 `check(cond,msg)` 计数器，失败 `process.exit(1)`；`test-orchestration.mjs:27-30` 同样用 `check` 宏。
- `test-batch.mjs` 与 `test-orchestration.mjs` 用 `makeBatchMock` / `makeCtx` 模拟宿主 llm 与 ctx，跑真实 `index.js` 纯函数与服务 tick，无外部框架。

### 跨语言 JSON-lines 协议与契约版本化

Node 与 Python 引擎边界通过单行 JSON 协议通信，双方共享同一套冻结的枚举与版本常量。

- `lib/engine/python/entry.py:104` 的 `emit` 经 `_REAL_STDOUT` 写一行 JSON；`lib/engine/client.js:39` 的 `createProtocolReader` 增量解析 `hello`/`progress`/`result`。
- `lib/engine/contract.js:24` 的 `ENGINE_STAGES` 与 `lib/engine/python/stage_map.py:20` 的 `ENGINE_STAGES` 必须为同集合，由 `test-engine-python-entry.mjs:236-247` 双向对账。
- `lib/engine/contract.js:20` 的 `ENGINE_CONTRACT_VERSION=1` 被 `lib/engine/mapping.js:115` 的 `mapFsoftOutput` 写入返回；`lib/engine/manifest.js:19` 的 `MANIFEST_VERSION=1` 独立但同构。

### 写集封闭与路径越界防护

凡是涉及写盘或采集变更，均先以白名单或归一化函数拦截越界路径，且采用“整批拒写”而非逐条跳过。

- `lib/engine/apply-plan.js:46` 的 `APPLY_WRITE_ROOTS` 限定只写 `.codewiki` 与 `CodeWiki.md`；`lib/engine/apply-plan.js:86-131` 的 `checkWriteTargets` 对绝对路径、`..` 上跳、白名单外路径整批拒写。
- `lib/change-set.js:33-40` 的 `normChangePath` 将 Windows 反斜杠转 POSIX、丢弃 `../` 与盘符路径，越界路径静默丢弃。
- `index.js:209` 的 `normalizeArticlePath` 纵深防御旧 cw 二进制在 Windows 输出的反斜杠；`lib/engine/apply-plan.js:75` 的 `toPosix` 在写集校验前归一。

### 产物目录自排除与映射口径统一

wiki 自身产物目录 `.codewiki/` 在各处被统一识别并排除在“源码变更”之外，映射口径集中由 `mapping.js` 定义。

- `lib/change-set.js:26` 的 `WIKI_PRODUCT_PREFIX='.codewiki/'` 用于 `isWikiProduct`（`lib/change-set.js:184`）剔除自身重写；`sourceChanges` 过滤掉 wiki 产物（`lib/change-set.js:184`）。
- `lib/engine/mapping.js:31-34` 定义 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`/`WIKI_MODULES_REL`，被 `lib/engine/output.js` 与 `lib/engine/apply-plan.js:46` 复用为唯一映射口径。
- `lib/engine/output.js:42-43` 的 `TEMP_DIR='temp'` 在递归收页时跳过，但 `temp/update-record.json` 在 mapping 中仍被搬运（`lib/engine/mapping.js:33`）。

### 日志脱敏与凭证不落地

所有涉及模型密钥的环节严格脱敏：占位 key、环境变量注入、日志不打印 Authorization。

- `lib/engine/llm-bridge.js:38` 的 `bearerOf` 取完 token 即弃；`lib/engine/llm-bridge.js:103-109` 的 `onLog` 只记 method/path/status/ms，测试 `test-engine-llm-bridge.mjs:232-247` 断言无 authorization。
- `lib/engine/python/entry.py:23-29` 注释明确绕开 `ConfigManager`/keyring，不从本机凭证库读 key；`_model_config`（`lib/engine/python/entry.py:243`）错误信息只说“环境变量”不打印值。
- `lib/engine/quality-gate.js:269` 的 `yamlScalar` 安全序列化避免密钥泄露；`failure`（`lib/engine/python/entry.py:135`）的 message 不拼凭证内容。

以上模式在仓库中交叉验证，构成了 CodeWiki 插件在移植 FSoft 引擎、增量编译、测试守护等方面的统一骨架。