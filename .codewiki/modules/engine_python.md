---
title: engine_python
type: module
source_files:
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-python-entry.mjs
  - lib/engine/client.js
  - lib/engine/native-run.js
  - lib/engine/llm-bridge.js
  - lib/engine/contract.js
  - lib/engine/process-tree.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - index.js
tags: [engine, python, fsoft, native-engine, protocol, stage-mapping]
---

## Overview

`engine_python` 是整条「阶段 2 / 原生引擎」迁移里**唯一一处手写的 Python**。它位于 `lib/engine/python/`，由两个文件组成：

- `lib/engine/python/entry.py` — FSoft 原生引擎的 JSON-lines 薄入口；
- `lib/engine/python/stage_map.py` — FSoft 五段进度 → 引擎八段契约的纯函数映射。

它**不是算法实现**：依赖图、聚类、文章写作、增量 diff 全部由 FSoft 自己的 `CLIDocumentationGenerator` 完成（`entry.py:4-5`）。`entry.py` 只做四件事（`entry.py:5-10`）：

1. 把 stdin 的一行 JSON 变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
2. 把 FSoft 的五段进度翻译成引擎八段契约（`stage_map.py`），以 JSON 行推给 Node；
3. 把成功/失败/取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同一套语义）；
4. 守住两条红线：**不读本机凭证库**、**不让 FSoft 的打印污染协议流**。

这是 Node 侧与 Python/FSoft 之间唯一的跨语言边界：
- Node 侧经 `lib/engine/client.js`（`runEngine`）起子进程、写一行请求、读回 JSON-lines；
- 生产编排在 `lib/engine/native-run.js`（`runNativeJob`），并经由 `index.js` 的 `nativeEnginePlan` 把模型通道以占位 key 注入子进程环境。

整条通路的关键设计取舍（详见 `entry.py:12-36` 的模块 docstring）：
- **stdout 在 `import codewiki` 之前就被接管**，换成只允许协议写出的 `_ProtocolOnly` 守卫对象（`entry.py:46-92`），因为 click 会缓存 stdout 包装器，事后替换拦不住；
- **绕开 `ConfigManager`**，直接构造 config dict 交给 adapter，密钥只活在进程环境变量里，不落盘（`entry.py:23-29`）；
- **进程退出码只表达进程层结果**，语义以最后一条 `result` 行为准（`entry.py:31-35`），协议破坏用「0 退出 + failed result」表达，让 Node 拿到结构化失败原因。

## Key Components

### entry.py — 协议入口

**模块级常量**

- `PROTOCOL_VERSION = 1`（`entry.py:94`）— 协议版本，独立于结果契约版本（`client.js:27`）。
- `ACTIONS = ("doctor", "generate", "update", "cancel")`（`entry.py:95`）— 入口认识的四个动作；Node 侧 `client.js` 的 `runEngine` 只允许这四动作（`client.js:227`）。
- 模型通道环境变量名（`entry.py:98-101`）：`ENV_BASE_URL = "CODEWIKI_BASE_URL"`、`ENV_API_KEY = "CODEWIKI_API_KEY"`、`ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"`、`ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"`。这些由 `index.js:252-259` 的 `nativeEnginePlan` 注入；子进程默认还会带 `CODEWIKI_NO_KEYRING=1`（`index.js:258`）。

**协议流守卫**

- `class _ProtocolOnly`（`entry.py:59-89`）— `sys.stdout` 替身，只允许协议写出走真 stdout，其余 `write` / `flush` 全改道 stderr（`entry.py:66-78`）。提供 `isatty()`（`entry.py:80-81`，恒 `False`）、`fileno()`（`entry.py:83-85`，给 stderr 句柄避免某些库抛错）、`encoding` 属性（`entry.py:87-89`，恒 `"utf-8"`）。在 `import codewiki` 之前于 `entry.py:92` 安装。

**协议写入与消息**

- `emit(obj)`（`entry.py:104-108`）— 写一行协议 JSON 到真 stdout（`_REAL_STDOUT`），所有协议消息必经此函数。
- `emit_hello()`（`entry.py:111-112`）— 发 `{"type":"hello","protocolVersion":1,"engine":"fsoft-native"}`。
- `emit_progress(request_id, stage, percent, message="", written=0, failed=0, total=0)`（`entry.py:115-128`）— 发一条 `progress` 消息，含 `contractVersion`、阶段、百分点、计数。
- `emit_result(request_id, result)`（`entry.py:131-132`）— 发 `result` 终态消息。
- `failure(code, message, stage=None, request_id="")`（`entry.py:135-153`）— 构造一个 `failed` 终态。`message` 只放给人看的说明，**绝不拼凭证内容**（字符串截断到 4000 字符，`entry.py:142`）。返回的字典含 `contractVersion / outcome / stage / blockers / error / writtenCount / failedCount / keptCount / removedCount / unmappedCount / usage / engine / artifacts / startedAt / finishedAt` 全套字段。

**action 处理函数**

- `action_doctor(request_id, payload)`（`entry.py:198-237`）— 探测引擎版本（`_engine_version`，`entry.py:159-173`）+ 跑 `pip check`（`_pip_check`，`entry.py:176-195`）。返回 `engine-deps` 失败（依赖不闭合）或 `engine-missing`（无法导入 codewiki），通过则在 `engine.deps` 里附上 `{ok, summary}`（`entry.py:209-233`）。
- `_model_config()`（`entry.py:243-275`）— 从进程环境读模型通道，缺任何一项返回 `(None, 原因)`，原因只说「环境变量」不打印值（`entry.py:265-278`）；成功返回含 `base_url / api_key / main_model / cluster_model / fallback_model / provider` 的 dict。注意 `fallback_model` 必须显式给，否则 FSoft 的 `create_fallback_models` 会在 `model_name.lower()` 上抛 `AttributeError`（`entry.py:263-267`）。
- `action_generate(request_id, payload, is_update=False)`（`entry.py:384-472`）— 跑一次 FSoft 生成/增量更新。准备 config（含 `max_tokens`、`max_depth`、`use_gitignore`、`prompt_caching` 等，`entry.py:403-412`），构造 `CLIDocumentationGenerator`（`entry.py:420-429`），接进度桥，跑 `adapter.generate()`（`entry.py:431`）。处理 `SystemExit`（FSoft 在「无变更」路径会 `sys.exit(0)`）与所有异常（`entry.py:432-440`），并对缺失文章翻成 `partial`（`entry.py:449-457`）。
- `_done_result(...)`（`entry.py:475-496`）— 构造 `done` 终态，附带 `engine`（版本/commit/python）、`artifacts`（`docsDir` / `rawTreeDir`=`module_tree.json` / `updateRecord`=`update_record.json`）。
- `_classify_exception(exc, ...)`（`entry.py:499-526`）— 按异常**类型**（非文本）分类成契约错误码：`IncompleteGenerationError`/`IncompleteDocumentationError` → `partial`；`*APIError`/`ConfigurationError` → `engine-model`；`RepositoryError` → `engine-missing`；`KeyboardInterrupt` → `cancelled`；其余 → `engine-crashed`（`entry.py:504-526`）。
- `_cancelled_result(request_id, written=0, stage="articles")`（`entry.py:529-546`）— 构造 `cancelled` 终态。

**进度桥接**

- `bridge_progress(adapter, request_id, on_stage=None)`（`entry.py:281-332`）— 替换 `adapter.progress_tracker` 的 `start_stage` / `update_stage` / `complete_stage` 三个方法（`entry.py:330-332`），把事件转成协议行并调用 `map_stage` / `percent_of`（`entry.py:292`、`entry.py:307` 等）。`on_stage` 用来记录「最后一个真实到达的阶段」（`entry.py:289-291`），使 done 结果的 `stage` 是实测值而非写死的常量。

**辅助 / 主循环**

- `_count_docs(docs_dir)`（`entry.py:338-363`）— 递归清点产物页数，排除 `.` 开头目录与 `temp/`（`entry.py:354-357`），避免漏计子目录导致「1 篇成功 + 19 篇失败也报 done」类误判。
- `_git_commit(repo_path)`（`entry.py:366-381`）— 跑 `git rev-parse HEAD` 取 commit id。
- `handle_request(msg)`（`entry.py:552-574`）— 处理一条请求，返回 `(requestId, result)`：校验 JSON 对象、requestId、action ∈ `ACTIONS`，分发到四个 action（`entry.py:554-574`）；非法路径一律 `failure("engine-protocol", ...)`。
- `main()`（`entry.py:577-590`）— 发 `hello`、读一行 stdin、解析 JSON、`handle_request`、发 `result`；非法 JSON 也回可机读失败。
- 模块末的 `__main__` 入口（`entry.py:593-603`）— 包一层 `KeyboardInterrupt` 兜底，被外层杀进程树时仍尽量回一条 `cancelled`（`entry.py:599-602`）。

### stage_map.py — 阶段映射

纯函数、无副作用，是 Node 与 Python 唯一共享的**枚举口径**（由 `test-engine-python-entry.mjs:236-247` 双向对账：改一边不改另一边测试即红）。

**常量**

- `ENGINE_STAGES`（`stage_map.py:20-29`）— 引擎八段契约：`env / graph / cluster / articles / validate / index / baseline / commit`，必须与 `lib/engine/contract.js:24-33` 的 `ENGINE_STAGES` 完全一致。
- `FSOFT_STAGE_NAMES`（`stage_map.py:33-39`）— FSoft 五段名镜像（1 Dependency Analysis、2 Module Clustering、3 Documentation Generation、4 HTML Generation、5 Finalization）。
- `FSOFT_STAGE_WEIGHTS`（`stage_map.py:40-46`）— 五段权重（0.40 / 0.20 / 0.30 / 0.05 / 0.05），与 FSoft 保持一致避免进度条跳变。
- `FSOFT_TO_ENGINE`（`stage_map.py:50-56`）— 五段 → 四段映射（1→graph、2→cluster、3→articles、4→validate、5→validate；4/5 都落 validate，因为 HTML 我们不做、finalization 是产物整理，都属「文章已写完在收口」）。
- `DEFAULT_ENGINE_STAGE = "articles"`（`stage_map.py:60`）— 未知阶段不抛错，归到 `articles`（耗时最长、最需让用户看见的阶段）。
- `FSOFT_PROGRESS_CEILING = 90`（`stage_map.py:63`）— 引擎内部进度只占到 90%，剩余 10% 留给 Node 侧 `index / baseline / commit` 收尾（`stage_map.py:12-16`）。

**函数**

- `map_stage(fsoft_stage)`（`stage_map.py:66-72`）— FSoft 阶段号 → 引擎契约阶段名；非整数或未知归到 `DEFAULT_ENGINE_STAGE`。
- `percent_of(fsoft_stage, stage_progress)`（`stage_map.py:75-97`）— FSoft (阶段号, 阶段内进度 0..1) → 整体百分数 0..90。算法与 FSoft `ProgressTracker.get_overall_progress` 同构（已完阶段权重之和 + 当前阶段权重×阶段内进度），多乘 CEILING 并夹到 `[0,100]`（`stage_map.py:78-81`）。

## Architecture

`engine_python` 在原生引擎链路里处于「Node 编排层 ↔ FSoft Python 引擎」之间，是一个协议翻译 + 红线守护的薄层。组件数 ≥3 且流程非平凡，下图为跨进程框图：

```text
┌─────────────── Node 侧 ───────────────┐        ┌──────── Python / FSoft ────────┐
│ client.js (runEngine)                  │ 子进程  │ entry.py (main→handle_request) │
│   spawn(PY, [entry.py], env)           │ ─────► │   _ProtocolOnly 接管 stdout     │
│   push(JSON-lines)                     │  stdin  │   doctor/generate/update/cancel│
│   read  hello/progress/result          │ ◄───── │   emit_* → 真 stdout             │
│                                        │  协议流 │                                 │
│ native-run.js (runNativeJob)           │        │   bridge_progress 替换 tracker   │
│   engineFor→nativeEnginePlan(index.js) │        │     └─ stage_map.py              │
│   注入 CODEWIKI_* 环境 (占位 key)      │  env    │       map_stage/percent_of       │
│ llm-bridge.js (loopback 127.0.0.1)     │ ◄───── │   CLIDocumentationGenerator      │
│   宿主 llm 经占位 key 转发             │ HTTP    │     (依赖图/聚类/文章/校验)       │
└────────────────────────────────────────┘        └─────────────────────────────────┘
```

要点：

- **stdout 守卫先于一切**：`entry.py:48-92` 在 `import codewiki` 之前就把 `_REAL_STDOUT` 存好、把 `sys.stdout` 换成 `_ProtocolOnly`，保证 FSoft 的 `print` / `click.secho` / `print_banner` 只会落到 stderr，污染不到协议流（`entry.py:14-21`）。
- **模型通道零落盘**：`index.js:259-266` 把 `CODEWIKI_BASE_URL / CODEWIKI_API_KEY / CODEWIKI_MAIN_MODEL / CODEWIKI_CLUSTER_MODEL` 注入子进程环境，其中 `API_KEY` 是 `llm-bridge.js` 每次随机生成的占位 key，真实凭证只活在宿主 provider 内部（`entry.py:23-29`、`llm-bridge.js:6-17`）。
- **阶段映射是单一可信口径**：`stage_map.py` 与 `contract.js` 的 `ENGINE_STAGES` 双向对账（`test-engine-python-entry.mjs:236-247`），防止面板与引擎各自漂移（`stage_map.py:3-10`）。

## Data Flow

一次 `generate` 完整流程（沿真实代码行号）：

1. **启动与协议握手**：Node 经 `client.js` 的 `spawnPlan` 把 `command`/`args`/`env` 规范成 spawn 参数（`client.js:189-198`）并 `spawn` 子进程（`client.js:288-298`）。`entry.py:main` 先 `emit_hello`（`entry.py:578`），再 `sys.stdin.readline()` 读一行请求（`entry.py:579`），`json.loads` 失败也回 `engine-protocol` 失败（`entry.py:584-587`）。
2. **派发**：`handle_request` 校验 `requestId`/`action`（`entry.py:554-563`），分发到 `action_generate`（`entry.py:572-574`）。
3. **模型通道校验**：`_model_config` 读 `CODEWIKI_*` 环境（`entry.py:396-398`），缺项则回 `engine-model` 失败且**不去读本机配置/凭证库**（测试钉在 `test-engine-python-entry.mjs:192-208`）。
4. **构造 adapter + 接桥**：`CLIDocumentationGenerator(...)`（`entry.py:420-429`）→ `bridge_progress` 替换 tracker 三方法（`entry.py:430`、`entry.py:330-332`）→ `adapter.generate()`（`entry.py:431`）。
5. **进度上报**：FSoft 五个阶段经 `start_stage`/`update_stage`/`complete_stage` 回调，调 `map_stage` + `percent_of` 翻成引擎八段、整体百分数上限 90（`entry.py:307-328`、`stage_map.py:66-97`），经 `emit_progress` 推真 stdout（`entry.py:115-128`）。
6. **收尾/异常翻终态**：
   - `SystemExit(0)`（无变更）当作正常 `done`（`entry.py:432-438`）；
   - 其他异常按类型经 `_classify_exception` 翻成 `partial` / `engine-model` / `engine-missing` / `cancelled` / `engine-crashed`（`entry.py:439-440`、`entry.py:499-526`）；
   - 跑后 `adapter.validate_generated_docs` 发现缺页 → `partial` + `article-missing` blocker（`entry.py:444-457`）；
   - 用量从 `job.statistics.usage_totals` 取（`entry.py:460-471`）。
7. **回 result**：`emit_result` 发终态（`entry.py:589`），进程退出码恒表达进程层结果（`entry.py:31-35`）。Node `client.js` 的 reader 把 `result` 归一为 `EngineResult`，并记 `protocolViolations`（`client.js:253-272`、`client.js:169-184`）。
8. **上层裁决**：`native-run.js` 的 `runNativeJob` 把 `env(doctor+锁) → graph/cluster/articles(引擎) → validate(质量门) → index/baseline/commit(落地器)` 固定成一条严格裁决链（`native-run.js:9`、`native-run.js:68-149`），引擎 `done` 不能替代质量门与落地器。

## Connections

- [[engine-client]] — `lib/engine/client.js` 的 `runEngine` 是跨语言边界薄适配层：起子进程、读 JSON-lines、把引擎消息翻成 `EngineResult/EngineProgress/EngineError`，并定义协议不变量（`client.js:13-20`、`client.js:223-298`）。本模块的 `entry.py` 是它 spawn 的那个 `engine.command`（`DEFAULT_ENGINE_ENTRY` 在 `native-run.js:34`）。
- [[engine-native-run]] — `lib/engine/native-run.js` 的 `runNativeJob` 编排一次完整编译，调用 `runEngine` 跑本模块动作，并把引擎终态经质量门 + 落地器严格裁决（`native-run.js:68-488`）。`DEFAULT_ENGINE_TIMEOUT_MS = 45*60*1000`（`native-run.js:68`）。
- [[engine-contract]] — `lib/engine/contract.js` 定义 `EngineResult/EngineProgress/EngineError`、`ENGINE_STAGES`（`contract.js:24-33`）、`BLOCKER_KINDS`、`ENGINE_ERROR_CODES`。本模块 `stage_map.py` 的 `ENGINE_STAGES` 必须与它完全一致（`stage_map.py:19`），`entry.py` 的所有终态字典字段与之同一套语义（`entry.py:135-153`、`entry.py:475-496`）。
- [[engine-llm-bridge]] — `lib/engine/llm-bridge.js` 是宿主模型 loopback 桥，每次随机生成占位 key 与随机端口（`llm-bridge.js:96-113`），其返回的 `url`/`placeholderKey` 经 `index.js:nativeEnginePlan` 注入本模块子进程的 `CODEWIKI_*` 环境（`index.js:259-266`），真实凭证从不进子进程环境。
- [[engine-process-tree]] — `lib/engine/process-tree.js` 的 `terminateProcessTree` 负责取消时整组打掉引擎进程树（`client.js:24`、`entry.py:567-571` 的 cancel 语义：请求已受理但未开始跑时立即回 `cancelled`）。
- [[index-entry]] — `index.js` 的 `nativeChannelFor`（`index.js:223-233`）、`resolveNativePython`（`index.js:237-243`）、`nativeEnginePlan`（`index.js:252-268`）决定何时走原生通道、用哪个 python、注入哪些环境变量；`nativeEngine` 开关默认 `false`（`index.js:99`）。
- [[engine-quality-gate]] — `lib/engine/quality-gate.js` 的 `gateNativeOutput` 在校验阶段（`validate`）对引擎产物做质量门；引擎 `done` 不能替代它（`native-run.js:337`）。
- [[engine-apply-plan]] — `lib/engine/apply-plan.js` 的 `applyNativeOutput` 负责写盘 → index → 基线 → 提交；失败自行回滚，终态不许被引擎 `done` 洗白（`native-run.js:362-418`）。

## Known Issues

- **`fallback_model` 必须显式给**：`entry.py:263-267` 注释指出，若 `fallback_model` 缺省 `None`，FSoft 的 `create_fallback_models` 会在 `model_name.lower()` 上抛 `AttributeError`（`llm_services.py:263-269`），实测必崩且表现为 `engine-crashed` 而非可理解的模型错误。`_model_config` 已显式设为 `model`（`entry.py:273`）规避。
- **FSoft「无变更」路径靠 `sys.exit(0)` 退出**：`entry.py:432-438` 必须特判 `SystemExit`——增量更新时「没有要改的」是正常终态，崩成 `engine-crashed` 会误报。
- **stdout 守卫必须早于 `import codewiki`**：`entry.py:14-21` 说明 click 会缓存 text stdout 包装器，事后替换 `sys.stdout` 拦不住已缓存引用，所以守卫在 `entry.py:46-92` 极早安装。
- **`_count_docs` 必须递归且排除 `temp/` 与 `.` 目录**：`entry.py:338-363` 注释警告，只 glob 根层会把 hierarchical 布局的子目录子树漏掉，导致 `written` 少计、终态看着像成功——这是「1 篇成功 + 19 篇失败也报 done」误判的来源之一。
- **`percent_of` 必须夹紧非法输入并乘 CEILING=90**：`stage_map.py:75-97` 说明进度上限刻意压在 90%，否则会出现「引擎说 100% 但 wiki 还没索引/没提交」的假完成（`stage_map.py:12-16`）。
- **模型名必须由调用方显式传入**：`index.js:247-251` 的注释警告，曾误写成 `bridge.model`（桥不含 model 字段），导致 `CODEWIKI_MAIN_MODEL` 变空串 → `_model_config` 判「缺少模型通道」→ 每次原生编译在 cluster 阶段以 `engine-model` 失败。
- **阶段映射漂移风险**：`stage_map.py:3-10` 指出 `ENGINE_STAGES` 与 `contract.js` 一旦各自漂移，表现是「面板显示在写作，实际已经在校验」；已由 `test-engine-python-entry.mjs:236-247` 双向对账捕获。
- **退出码语义坑**：协议破坏一律「0 退出 + failed result」（`entry.py:34-35`），Node 侧 `client.js:16-18` 约定语义以 `result` 为准、退出码 0 + 语义 failed 也算失败，调用方不能直接用退出码判成功。
