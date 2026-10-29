---
title: engine_python
type: module
source_files:
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-python-entry.mjs
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/native-run.js
tags: [python, native-engine, entrypoint, stage-mapping, protocol]
---

## Overview

`engine_python` 是原生引擎（FSoft / `codewiki`）的 Python JSON-lines 薄入口，对应迁移的「阶段 2」。它**不是算法实现**：依赖图、聚类、文章写作、增量 diff 全部由 FSoft 自己的 `CLIDocumentationGenerator` 完成（见 `entry.py` 第 2–10 行模块 docstring）。本模块只负责四件事：

1. 把 stdin 的一行 JSON 请求变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
2. 把 FSoft 的**五段**进度翻译成引擎**八段**契约（`stage_map.py`），以 JSON 行推给 Node；
3. 把成功 / 失败 / 取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同一份语义）；
4. 守住两条红线：**不读本机凭证库**、**不让 FSoft 的打印污染协议流**。

它由 Node 侧的 `lib/engine/client.js` 通过受管子进程启动：写一行请求 JSON，读回 JSON-lines（`hello` → `progress*` → `result`）。本模块是整条迁移里唯一一处「我们写的 Python」（见 `test-engine-python-entry.mjs` 第 1–14 行注释）。

核心设计约束：

- **stdout 接管必须在 `import codewiki` 之前**（`entry.py` 第 46–92 行）：FSoft 用 `print` / `click.secho` / `print_banner` 往 stdout 写人类文案，且 click 会缓存 text stdout 包装器，事后替换 `sys.stdout` 拦不住已缓存的引用。所以入口先把 `sys.stdout` 换成 `_ProtocolOnly()` 守卫，协议行走保存下来的 `_REAL_STDOUT`。
- **不用 `ConfigManager`**（`entry.py` 第 23–29 行）：它会读 `~/.codewiki/config.json` 或系统 keyring。迁移后模型通道由 Node 侧 loopback 桥注入（环境变量），密钥只活在进程环境里，构造 config dict 直接交给 adapter 即可。

## Key Components

### entry.py

文件 `lib/engine/python/entry.py`（共 687 行）。

**模块级常量：**

- `PROTOCOL_VERSION = 1`（第 94 行）— 协议版本，与 `client.js` 的 `ENGINE_PROTOCOL_VERSION` 对账。
- `ACTIONS = ("doctor", "generate", "update", "cancel")`（第 95 行）— 登记的四个动作，由 `handle_request` 校验。
- `ENV_BASE_URL = "CODEWIKI_BASE_URL"`（第 98 行）、`ENV_API_KEY = "CODEWIKI_API_KEY"`（第 99 行）、`ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"`（第 100 行）、`ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"`（第 101 行）— 模型通道环境变量名，由 Node 侧桥注入，密钥只活在进程环境里。

**类：**

- `class _ProtocolOnly`（第 59–89 行）— `sys.stdout` 的替身：只允许协议写出走真 stdout，其余一律改道 stderr。方法：
  - `write(self, text)`（第 66–72 行）— 普通文本写 stderr（变成日志），返回 `len(text or "")`。
  - `flush(self)`（第 74–78 行）— 转 stderr，防进度条 flush 把半行日志挤进协议流。
  - `isatty(self)`（第 80–81 行）— 返回 `False`。
  - `fileno(self)`（第 83–85 行）— 返回 `sys.stderr.fileno()`，避免某些库因拿不到终端句柄抛错。
  - 属性 `encoding`（第 87–89 行）— 返回 `"utf-8"`。

**函数 / 方法：**

- `emit(obj)`（第 104–108 行）— 写一行协议 JSON 到真 stdout；所有协议消息必须经这里（`json.dumps(obj, ensure_ascii=False)` + `\n` + flush）。
- `emit_hello()`（第 111–112 行）— 发 `{"type": "hello", "protocolVersion": PROTOCOL_VERSION, "engine": "fsoft-native"}`。
- `emit_progress(request_id, stage, percent, message="", written=0, failed=0, total=0)`（第 115–128 行）— 发一条 `progress` 协议行（含 `contractVersion: 1`、`writtenCount`/`failedCount`/`totalCount`）。
- `emit_result(request_id, result)`（第 131–132 行）— 发一条 `result` 协议行。
- `failure(code, message, stage=None, request_id="")`（第 135–153 行）— 构造 `failed` 终态；`message` 只放给人看的说明，绝不拼凭证；截断到 4000 字符。
- `_engine_version()`（第 159–173 行）— 读 codewiki 版本：`codewiki.__version__` 优先，否则回退 `importlib.metadata.version("codewiki")`。
- `_pip_check(timeout=120)`（第 176–195 行）— 跑 `pip check`，返回 `(ok, 输出摘要)`；这是 1A 门禁的运行时版本，装到一半的 venv 会让生成中途崩。
- `action_doctor(request_id, payload)`（第 198–237 行）— 环境可信性探测：发 `env` 进度、读版本、跑 `pip check`；缺 codewiki 回 `engine-missing`，依赖不闭合回 `engine-deps`（带 `deps` 明细），正常回 `done`（带 `engine.deps`）。
- `_model_config()`（第 243–275 行）— 从进程环境读模型通道，缺任何一项回 `(None, 原因)`；必须显式给 `fallback_model`（否则 FSoft 的 `create_fallback_models` 在 `model_name.lower()` 抛 `AttributeError`）。返回 dict 含 `base_url/api_key/main_model/cluster_model/fallback_model/provider`。
- `bridge_progress(adapter, request_id, on_stage=None)`（第 281–332 行）— 替换 `adapter.progress_tracker` 的 `start_stage`/`update_stage`/`complete_stage` 三个方法，把 FSoft 五段事件转成协议行（`map_stage` + `percent_of`）；`on_stage` 回调记录「最后一个真实到达的引擎阶段」。用替换而非继承，因为 FSoft 在 `__init__` 里直接 `ProgressTracker(total_stages=5)` 无注入点。
- `_count_docs(docs_dir)`（第 338–363 行）— 递归清点产物 `*.md` 页数，排除 `.` 开头目录与 `temp/`；必须递归，否则 hierarchical 布局子目录页会被漏计导致误判 `done`。
- `_git_commit(repo_path)`（第 366–381 行）— `git rev-parse HEAD`，取 commit 供 `engine.commit` 与 commit_id 记账。
- `action_generate(request_id, payload, is_update=False)`（第 384–496 行）— 跑一次 FSoft 生成/增量更新：准备 config（`update`/`max_tokens=32768`/`max_depth=2`/`request_limit=100`/`agent_retries=3`/`use_gitignore`/`prompt_caching` 等，第 403–418 行）→ 构造 `CLIDocumentationGenerator`（`entry.py` 第 432–441 行）→ `bridge_progress` → `adapter.generate()`。捕获 `SystemExit`（`code==0` 视为正常无变更，`code!=0` 回 `engine-crashed`）、其他异常走 `_classify_exception`。最后用 `_count_docs` 与 `adapter.validate_generated_docs` 判定 `done`/`partial`，并填 `usage`（读 `job.statistics.usage_totals`，第 485–494 行）。
- `_update_outcome_of(adapter)`（第 499–513 行）— 读 `adapter._last_update_record.outcome`；只有真的进了增量分支才有值，拿不到返回 `None`（区分「引擎没说」与「引擎说回退了」）。
- `_state_files(docs_dir)`（第 516–545 行）— 列出引擎在 docsDir 真实产出的跨轮状态文件（顶层 `*.json`、`temp/reference_index.json`、`temp/artifact_index.json`、`temp/dependency_graphs/*`），只报磁盘上存在的文件，不按白名单编造。
- `_done_result(request_id, docs_dir, repo_path, started, written=0, stage="articles", update_outcome=None)`（第 548–579 行）— 构造 `done` 终态，含 `engine`/`artifacts`（`docsDir`/`rawTreeDir`/`updateRecord`/`stateFiles`）与并列的 `updateOutcome` 字段。
- `_classify_exception(exc, request_id, docs_dir, repo_path, started, stage="articles")`（第 582–609 行）— 按异常**类型**分类：`IncompleteGenerationError`/`IncompleteDocumentationError` → `partial` + `article-missing` blockers；`*APIError`/`ConfigurationError` → `engine-model`；`RepositoryError` → `engine-missing`；`KeyboardInterrupt` → `cancelled`；其余 → `engine-crashed`。
- `_cancelled_result(request_id, written=0, stage="articles")`（第 612–629 行）— 构造 `cancelled` 终态。
- `handle_request(msg)`（第 635–657 行）— 处理一条请求，返回 `(requestId, result)`：校验 JSON 对象 / `requestId` / `action ∈ ACTIONS`；`doctor`→`action_doctor`，`cancel`→`_cancelled_result`（立即回，不跑实际工作），`update`→`action_generate(is_update=True)`，其余→`action_generate(is_update=False)`。
- `main()`（第 660–673 行）— 先 `emit_hello()`，读一行 stdin，解析 JSON，调 `handle_request`，发 `result`；非法 JSON / 空行回 `engine-protocol` 失败。
- `__main__` 守卫（第 676–686 行）— 捕获 `KeyboardInterrupt`，尽量补发一条 `cancelled` 终态再 `sys.exit(0)`。

### stage_map.py

文件 `lib/engine/python/stage_map.py`（共 98 行）。纯函数、无副作用，是 Node 与 Python 唯一共享的**枚举口径**（见第 1–17 行模块 docstring）。`test-engine-python-entry.mjs` 第 236–247 行反向断言两边集合完全一致。

**常量：**

- `ENGINE_STAGES`（第 20–29 行）— 引擎八段契约阶段名列表：`["env","graph","cluster","articles","validate","index","baseline","commit"]`，必须与 `contract.js` 的 `ENGINE_STAGES` 完全一致（测试双向对账）。
- `FSOFT_STAGE_NAMES`（第 33–39 行）— FSoft `ProgressTracker` 五段名的镜像：`{1:"Dependency Analysis", 2:"Module Clustering", 3:"Documentation Generation", 4:"HTML Generation", 5:"Finalization"}`，权重与 FSoft 保持一致。
- `FSOFT_STAGE_WEIGHTS`（第 40–46 行）— 五段权重：`{1:0.40, 2:0.20, 3:0.30, 4:0.05, 5:0.05}`。
- `FSOFT_TO_ENGINE`（第 50–56 行）— 五段 → 四段映射：`{1:"graph", 2:"cluster", 3:"articles", 4:"validate", 5:"validate"}`（4/5 都落在 `validate`，因为 HTML 我们不做、finalization 是产物整理）。
- `DEFAULT_ENGINE_STAGE = "articles"`（第 60 行）— 未知阶段归到 `articles`（耗时最长、最需要让用户看见的阶段），不抛错。
- `FSOFT_PROGRESS_CEILING = 90`（第 63 行）— 引擎内部进度只占到 90%，剩下 10% 留给 Node 侧收尾（`index`/`baseline`/`commit`），避免「引擎说 100% 但 wiki 还没索引/没提交」这种假完成。

**函数：**

- `map_stage(fsoft_stage)`（第 66–72 行）— FSoft 阶段号 → 引擎契约阶段名；`int()` 失败或不在映射表时归到 `DEFAULT_ENGINE_STAGE`。
- `percent_of(fsoft_stage, stage_progress)`（第 75–97 行）— FSoft `(阶段号, 阶段内进度 0..1)` → 整体百分数 `0..90`。算法与 FSoft `ProgressTracker.get_overall_progress` 同构（已完成阶段权重之和 + 当前阶段权重×阶段内进度），再乘 `CEILING` 并夹到 `[0,100]`；非法输入夹紧。

## Architecture

本模块是「Node 编排层 → FSoft 引擎」之间的跨语言薄边界，组件 ≥3 且流程非平凡，框图如下（≤20 行）：

```text
┌─────────────────────────┐   request JSON (1 line)   ┌──────────────────────────┐
│ lib/engine/client.js    │ ─────────────────────────► │ python/entry.py  main()  │
│ (spawn 子进程, 读 JSONL)│ ◄───────────────────────── │ emit_hello / handle_      │
└───────────┬─────────────┘   hello/progress/result    │ request → action_*()      │
            │                                          └────────────┬─────────────┘
            │                                                       │ doctor / generate / update
            │                                          ┌────────────┴─────────────┐
            │                                          │ _model_config (env vars) │
            │                                          │ _ProtocolOnly (stdout 守卫)│
            │                                          └────────────┬─────────────┘
            │                                                       │ CLIDocumentationGenerator
            │                                          ┌────────────┴─────────────┐
            │                                          │ bridge_progress 替换      │
            │                                          │ progress_tracker 三方法   │
            │                                          └────────────┬─────────────┘
            │                                                       │ FSoft 5 段进度事件
            │                                          ┌────────────┴─────────────┐
            │                                          │ stage_map.py             │
            │                                          │ map_stage / percent_of   │
            │                                          │ (5段→8段契约, 0..90%)     │
            └──────────────────────────────────────────┘ emit_progress → client.js
```

职责切分说明：

- `entry.py` 是「请求分发 + 结果成形」薄壳；它不持有任何算法，只把 FSoft 公共 API 包成协议行。
- `stage_map.py` 是纯函数枚举映射，被 `bridge_progress` 调用（第 292 行 `from stage_map import map_stage, percent_of`）。
- `_ProtocolOnly`（第 59–89 行）与 `_model_config`（第 243–275 行）是两条红线的落实点：前者保证协议流纯净，后者保证不读本机凭证库。
- FSoft 只覆盖八段中的前四段（`env` 由 doctor 承担，不在生成流程里；`index`/`baseline`/`commit` 由 Node 侧后续执行），故进度上限压在 90%（`FSOFT_PROGRESS_CEILING`，第 63 行）。

## Data Flow

单次 `generate` 请求的数据流（对应 `action_generate`，`entry.py` 第 384–496 行）：

1. **读取请求** — Node 侧 `client.js` 写一行 `{"requestId","action":"generate","payload":{...}}`；`main()`（第 660 行）读一行 stdin，`handle_request`（第 635 行）校验 `requestId`/`action`，路由到 `action_generate(is_update=False)`。
2. **解析路径** — `repoPath`/`docsDir` 解析（第 390–391 行）；仓库不存在回 `engine-missing`；`_model_config()`（第 396 行）读环境变量，缺通道回 `engine-model`（`cluster` 阶段）。
3. **构造 adapter** — 发 `env/100` 进度后，构造 `CLIDocumentationGenerator(repo_path, output_dir=docs_dir, config, commit_id)`（第 432–441 行）。`config` 含模型通道 + 生成参数（`max_tokens=32768`、`max_depth=2`、`request_limit=100`、`agent_retries=3`、`use_gitignore=True`、`prompt_caching=True`，第 403–418 行）；`commit_id` 由 `payload.commitId` 或 `_git_commit` 退回 HEAD（第 426 行），最终落进 `metadata.json` 的 `generation_info.commit_id`，即下轮增量的 `old_commit`。
4. **进度旁路** — `bridge_progress`（第 442 行）替换 `progress_tracker` 三方法，`on_stage` 回调把「最后一个真实到达的引擎阶段」记进 `reached["stage"]`（第 429 行起）。FSoft 五段事件 → `map_stage`+`percent_of` → `emit_progress`（0..90%）。
5. **跑引擎** — `job = adapter.generate()`（第 443 行）。`SystemExit(0)`（FSoft「无变更」路径）视为正常终态；`SystemExit(non-0)` 回 `engine-crashed`；异常走 `_classify_exception`（第 456 行）。
6. **成形结果** — `written = _count_docs(docs_dir)`（递归清点，第 458 行）；`adapter.validate_generated_docs`（第 461 行）缺失则 `partial` + `article-missing` blockers；否则 `done`。`usage` 读 `job.statistics.usage_totals`（第 485–494 行）。`updateOutcome` 由 `_update_outcome_of(adapter)`（第 471 行）填 —— `incremental`/`no_change`/`full_fallback`/`detector_failure`/`null`。
7. **发回** — `emit_result(request_id, result)`（第 131 行）写一条 `result` 协议行；`client.js` 的 `createProtocolReader` 把它翻译成 `contract.js` 的 `EngineResult`。

`doctor` 数据流更短（`action_doctor`，第 198 行）：发 `env` 进度 → `_engine_version()` → `_pip_check()` → 回 `done`（带 `engine.deps`）或 `engine-missing`/`engine-deps` 失败。`cancel` 由 Node 侧直接杀进程树（`client.js` 依赖 `process-tree.js`），入口侧 `cancel` 仅用于「已受理未开跑」，立即回 `_cancelled_result`（第 654 行）。

## Connections

- [[engine-contract]] — `entry.py` 产出的 `EngineResult`/进度/错误与 `lib/engine/contract.js` 同一份语义；`ENGINE_STAGES`、`UPDATE_OUTCOMES`、`BLOCKER_KINDS`、`ENGINE_ERROR_CODES` 全部对应。阶段枚举的双向对账由 `test-engine-python-entry.mjs` 第 236–247 行保证。
- [[engine-client]] — `lib/engine/client.js` 是启动本入口的子进程管理 + 协议读取层（`spawn` + `createProtocolReader`），`ENGINE_PROTOCOL_VERSION = 1` 与入口 `PROTOCOL_VERSION` 对齐；取消由 `client.js` 经 `process-tree.js` 杀进程树实现。
- [[engine-native-run]] — `lib/engine/native-run.js` 是生产通道编排层（`DEFAULT_ENGINE_ENTRY = path.join(here,'python','entry.py')`，第 56 行），把 `env → 增量决议 → 引擎(full|update) → gate → apply` 串成裁决链。
- [[engine-llm-bridge]] — 模型通道由 Node 侧 loopback 桥注入本入口环境变量（`CODEWIKI_BASE_URL/API_KEY/MAIN_MODEL/CLUSTER_MODEL`），密钥只活在进程环境、不落盘。
- [[engine-manifest]] — `doctor` 动作的运行时版本是 1A 门禁（`_pip_check` 对应 `manifest.js` 的锁校验）；依赖不闭合回 `engine-deps`。
- [[engine-quality-gate]] — 入口只负责前四段（到 `validate`），质量门（`validate`/`index`/`baseline`/`commit` 后续三段的落地）由 Node 侧 `quality-gate.js` + `apply-plan.js` 完成。
- [[engine-process-tree]] — `cancel` 真实取消靠 `process-tree.js` 杀进程树；入口的 `cancel` action 仅用于「已受理未开跑」立即回 `cancelled`。

## Known Issues

---
title: engine_python
type: module
source_files:
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-python-entry.mjs
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/native-run.js
  - lib/engine/process-tree.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
tags: [python, native-engine, protocol, stage-mapping]
---

## Overview

`lib/engine/python/` 是迁移后唯一一处由本项目手写的 Python 代码，定位为
**FSoft 原生引擎的 JSON-lines 薄入口**（阶段 2）。它本身**不实现**任何依赖图、
聚类、文章写作或增量 diff——这些全部由 FSoft 的 `CLIDocumentationGenerator`
承担。Python 入口只做四件事（`entry.py:1-36` 的模块 docstring）：

1. 把 stdin 的一行 JSON 请求变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
2. 把 FSoft 的五段进度翻译成引擎八段契约（`stage_map.py` + `bridge_progress`，见 `entry.py:281-332`）；
3. 把成功/失败/取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同语义）；
4. 守住两条红线：**不读本机凭证库**、**不让 FSoft 的打印污染协议流**。

目录里只有两个文件：
- `entry.py`：进程入口、动作分发、结果翻译（686 行）；
- `stage_map.py`：FSoft 五段进度 → 引擎八段契约的纯函数映射（97 行），
  是 Node 与 Python 之间唯一共享的「枚举口径」。

这两条红线对应两个关键设计：
- **stdout 在 import 任何 codewiki 模块之前就被接管**（`entry.py:46-92`），
  因为 FSoft 用 `print`/`click.secho` 往 stdout 写人类文案，而 click 会缓存
  text stdout 包装器，事后替换 `sys.stdout` 拦不住已缓存的引用。
- **不使用 `ConfigManager`**（见 `entry.py:23-29`）：它读 `~/.codewiki/config.json`
  或系统 keyring；迁移后模型通道由 Node 侧 loopback 桥注入，密钥只活在进程环境变量里，
  因此直接构造 config dict 交给 adapter，绕开整套凭证解析。

## Key Components

### entry.py — 公开常量与函数

模块级常量：

- `PROTOCOL_VERSION = 1`（`entry.py:94`）：本端协议版本，hello 消息里上报。
- `ACTIONS = ("doctor", "generate", "update", "cancel")`（`entry.py:95`）：允许的四个动作。
- `ENV_BASE_URL = "CODEWIKI_BASE_URL"`（`entry.py:98`）：模型通道 base url 的环境变量名。
- `ENV_API_KEY = "CODEWIKI_API_KEY"`（`entry.py:99`）：API key 环境变量名。
- `ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"`（`entry.py:100`）：主模型环境变量名。
- `ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"`（`entry.py:101`）：聚类模型环境变量名。

公开函数：

- `emit(obj)`（`entry.py:104-108`）：写一行协议 JSON 到**真** stdout（`_REAL_STDOUT`），
  所有协议消息必须经这里。带 `ensure_ascii=False` 以保证中文可读、写完即 flush。
- `emit_hello()`（`entry.py:111-112`）：发 `{type:"hello", protocolVersion, engine:"fsoft-native"}`。
- `emit_progress(request_id, stage, percent, message, written, failed, total)`（`entry.py:115-128`）：
  发一条 `type:"progress"` 协议行，字段包含 `contractVersion:1`、`stage`、`percent`、
  `message`、`writtenCount`、`failedCount`、`totalCount`。
- `emit_result(request_id, result)`（`entry.py:131-132`）：发 `{type:"result", requestId, result}`。
- `failure(code, message, stage, request_id)`（`entry.py:135-153`）：构造一个 `failed` 终态。
  `message` 只放给人看的说明，且 `str(message)[:4000]`，**绝不拼凭证内容**。
- `action_doctor(request_id, payload)`（`entry.py:198-237`）：执行环境可信性检查——
  探测引擎版本（`_engine_version`）、跑 `pip check`（`_pip_check`），返回 `done` 结果
  并带 `engine.deps.ok/summary`，或 `engine-missing` / `engine-deps` 失败。
- `action_generate(request_id, payload, is_update=False)`（`entry.py:384-496`）：跑一次
  FSoft 生成/增量更新；准备 config → 构造 `CLIDocumentationGenerator` → `bridge_progress`
  → `adapter.generate()`，最后把异常/部分缺失翻成契约终态。详见下文 Data Flow。
- `handle_request(msg)`（`entry.py:635-657`）：处理一条请求，返回 `(requestId, result)`，
  任何路径都返回 result（协议错误、未知 action、未知动作都返回 failed）。
- `main()`（`entry.py:660-673`）：读 stdin 一行 → `json.loads` → `handle_request` →
  `emit_result`。非法 JSON 也回可机读失败而不是直接异常退出。
- 辅助/内部函数：
  - `_engine_version()`（`entry.py:159-173`）：优先 `codewiki.__version__`，否则 `importlib.metadata.version("codewiki")`。
  - `_pip_check(timeout=120)`（`entry.py:176-195`）：跑 `python -m pip check`，返回 `(ok, 输出摘要)`，超时 120s。
  - `_model_config()`（`entry.py:243-275`）：从进程环境读模型通道，缺项返回 `(None, 原因)`；
    成功返回含 `base_url/api_key/main_model/cluster_model/fallback_model/provider` 的 dict。
  - `bridge_progress(adapter, request_id, on_stage)`（`entry.py:281-332`）：替换
    `adapter.progress_tracker` 的 `start_stage`/`update_stage`/`complete_stage` 三个方法，
    把事件转成协议行。见 Architecture。
  - `_count_docs(docs_dir)`（`entry.py:338-363`）：**递归**清点 `.md` 产物页数，排除
    `temp/` 与点开头目录。
  - `_git_commit(repo_path)`（`entry.py:366-381`）：跑 `git rev-parse HEAD` 拿 commit id。
  - `_update_outcome_of(adapter)`（`entry.py:499-513`）：读 `adapter._last_update_record.outcome`，
    拿不到返回 `None`（表示这轮不是 update）。
  - `_state_files(docs_dir)`（`entry.py:516-545`）：列出引擎在 docsDir 里**真实产出**的
    跨轮状态文件（顶层 `*.json`、`temp/reference_index.json`、`temp/artifact_index.json`、
    `temp/dependency_graphs/*`），不按白名单编造。
  - `_done_result(...)`（`entry.py:548-579`）：构造 `done`（或带 `updateOutcome` 的）终态。
  - `_classify_exception(exc, ...)`（`entry.py:582-609`）：按异常**类型**分类成契约错误码
    （`IncompleteGenerationError`/`IncompleteDocumentationError` → partial；
    `*APIError`/`ConfigurationError` → `engine-model`；`RepositoryError` → `engine-missing`；
    `KeyboardInterrupt` → cancelled；其余 → `engine-crashed`）。
  - `_cancelled_result(request_id, written, stage)`（`entry.py:612-629`）：构造 `cancelled` 终态。

### entry.py — `_ProtocolOnly` 协议流守卫

`_ProtocolOnly`（类中无字段，仅方法）是 `sys.stdout` 的替身对象，定义在
`entry.py:59-90`，在 `entry.py:92` 处 `sys.stdout = _ProtocolOnly()`。

**为什么需要它**：FSoft 大量用 `print`/`click.secho`/`print_banner` 往 stdout 写人类文案，
而 click 8.5 的 `_default_text_stdout` 会**缓存** text stdout 包装器。因此「事后替换
sys.stdout」拦不住已经缓存的引用，必须在**导入任何 codewiki 模块之前**就装好守卫
（模块 docstring `entry.py:12-21`）。

此外在装上守卫前（`entry.py:48-56`），把 `_REAL_STDOUT` 与 `sys.stderr` 的编码
`reconfigure(encoding="utf-8", errors="replace")`，避免 Windows 下 cp936 经管道变乱码。

方法（全部把人类文案改道 stderr，只让协议行走 `_REAL_STDOUT`）：
- `write(self, text)`（`entry.py:66-72`）：非空文本一律 `sys.stderr.write`，返回 `len(text or "")`。
- `flush(self)`（`entry.py:74-78`）：转调 `sys.stderr.flush()`——因为 FSoft 进度条会 flush，
  若 flush 打到真 stdout 会把半行日志挤进协议流中间。
- `isatty(self)`（`entry.py:80-81`）：返回 `False`。
- `fileno(self)`（`entry.py:83-85`）：返回 `sys.stderr.fileno()`，避免某些库拿 fileno 判断是否终端时抛错。
- 属性 `encoding`（`entry.py:87-89`）：返回 `"utf-8"`。

### stage_map.py — 五段↔八段映射表与纯函数

`stage_map.py` 是 Node 与 Python 唯一共享的**枚举口径**（模块 docstring `stage_map.py:1-17`）。
FSoft 自己的 `ProgressTracker` 只有五段（`codewiki/cli/utils/progress.py:26-35`），而契约里的
`ENGINE_STAGES`（`lib/engine/contract.js:24-33`）有八段。两者一旦各自漂移，会出现
「面板显示在写作，实际已在校验」的错乱。所以映射固定成一张表，并由
`test-engine-python-entry.mjs:236-247` 反向断言两边集合完全一致。

常量（全部在 `stage_map.py`）：

- `ENGINE_STAGES`（`stage_map.py:20-29`）：八段契约阶段名列表
  `["env","graph","cluster","articles","validate","index","baseline","commit"]`，
  **必须与 `contract.js:24-33` 的 `ENGINE_STAGES` 完全一致**。
- `FSOFT_STAGE_NAMES`（`stage_map.py:33-39`）：FSoft 五段阶段名镜像
  `{1:"Dependency Analysis", 2:"Module Clustering", 3:"Documentation Generation", 4:"HTML Generation", 5:"Finalization"}`。
- `FSOFT_STAGE_WEIGHTS`（`stage_map.py:40-46`）：五段权重 `{1:0.40, 2:0.20, 3:0.30, 4:0.05, 5:0.05}`，
  与 FSoft 保持一致以免整体进度条在阶段交界处跳变。
- `FSOFT_TO_ENGINE`（`stage_map.py:50-56`）：五段 → 四段映射
  `{1:"graph", 2:"cluster", 3:"articles", 4:"validate", 5:"validate"}`
  （4/5 都落 `validate`，因为 HTML 我们不做、finalization 是产物整理，两者都属于「文章已写完在收口」）。
- `DEFAULT_ENGINE_STAGE = "articles"`（`stage_map.py:60`）：未知阶段归到的默认段
  （第 3 段耗时最长、最需要让用户看见）。
- `FSOFT_PROGRESS_CEILING = 90`（`stage_map.py:63`）：引擎内部进度只占到 90%，
  剩下 10% 留给 Node 侧 `index`/`baseline`/`commit` 收尾，避免「引擎说 100% 但 wiki 还没索引/没提交」的假完成。

纯函数：

- `map_stage(fsoft_stage)`（`stage_map.py:66-72`）：FSoft 阶段号（int）→ 引擎契约阶段名；
  非 int 或未知号都归 `DEFAULT_ENGINE_STAGE`，不抛错（进度上报是旁路，绝不能因版本差异打断编译）。
- `percent_of(fsoft_stage, stage_progress)`（`stage_map.py:75-97`）：FSoft `(阶段号, 阶段内进度 0..1)`
  → 整体百分数 0..90。算法与 FSoft `ProgressTracker.get_overall_progress` 同构
  （已完成阶段权重之和 + 当前阶段权重×阶段内进度），再乘 `CEILING` 并夹到 `[0, 100]`。
  自己重算而不是调 FSoft 方法，是因为要在**不持有 tracker 实例**时也能算（测试与日志回放都要用），
  且必须夹紧非法输入（`p=min(1.0,max(0.0,p))`）。

### 测试覆盖（test-engine-python-entry.mjs）

测试钉的是「这条边界的三个失败面」（`test-engine-python-entry.mjs:1-13`）：协议面、环境面、凭证面。
真实模型生成不在这里测（用「缺模型通道」路径证明入口不会自己去读 `~/.codewiki` 凭证库）。

关键前置：
- `ENTRY`/`STAGE_MAP` 指向 `lib/engine/python/entry.py` 与 `stage_map.py`（`test-engine-python-entry.mjs:23-24`）。
- `findPython()`（`test-engine-python-entry.mjs:35-44`）：优先 `DSH_CODEWIKI_ENGINE_PYTHON` 环境变量，
  否则找 `.probe-fsoft/venv` 里的 python；找不到就明确 SKIP，而不是假装通过。
- 每次跑用干净临时仓库（含中文空格路径，避免污染真实 git 基线），`HOME`/`USERPROFILE`
  被隔离成空目录（`test-engine-python-entry.mjs:54-67`），确保入口不会因用户机器上有
  `~/.codewiki/config.json` 而去读凭证库。

断言清单（9 个 `check` 块）：
- 协议：非法 action 回 `engine-protocol` 失败且带原 `requestId`（`test-engine-python-entry.mjs:79-108`）。
- 协议：非 JSON 请求行回 `engine-protocol` 失败（`test-engine-python-entry.mjs:110-123`）。
- 协议：cancel 动作立即回 `cancelled`、`error=null`、带 `blockers[0].kind==="cancelled"`（`test-engine-python-entry.mjs:125-140`）。
- 环境：doctor 在真 venv 上报真实版本 `2.0.0` 与 python `3.12.x`（`test-engine-python-entry.mjs:144-157`）。
- 环境：doctor 的 `pip check` 闭合状态被如实上报（`test-engine-python-entry.mjs:159-173`）。
- 凭证：doctor 输出不含 `api_key/apiKey/sk-/credentials.json/keyring`（`test-engine-python-entry.mjs:177-190`）。
- 凭证：缺模型通道的 generate 直接 `failed`/`engine-model`，且失败路径不泄漏凭证（`test-engine-python-entry.mjs:192-208`）。
- 阶段映射：`map_stage` 把 (1..5) 映射成 `["graph","cluster","articles","validate","validate"]`，
  未知阶段归 `articles`，`percent_of` 单调递增且不超 100（`test-engine-python-entry.mjs:212-234`）。
- 阶段映射：与 `contract.js` 的 `ENGINE_STAGES` 同集合，改一边必须改另一边（`test-engine-python-entry.mjs:236-247`）。

注意：client 层只允许四个动作，所以「非法 action」用例绕过 `runEngine`，直接用 `spawnSync`
把非法 action 喂给入口（`test-engine-python-entry.mjs:88-95`）。

## Architecture

组件 ≥3，下面用 UTF-8 框图描述「Node 进程 → Python 入口 → FSoft」的接线与进度旁路：

```text
┌────────────────────────────────────────────────────────────────────┐
│ Node 侧 (lib/engine/client.js)                                       │
│  spawn python entry.py  ◄── 一行请求 JSON (stdin)                   │
│  read JSON-lines (stdout) ──► createProtocolReader                  │
└───────────────┬───────────────────────────┬───────────────────────┘
                │                            │
                ▼                            ▼
┌───────────────────────────┐   ┌──────────────────────────────────┐
│ entry.py  (sys.stdout=     │   │ _ProtocolOnly (entry.py:59-92)    │
│  _ProtocolOnly 早于 import)│   │ 人类文案→stderr，协议行→_REAL_STDOUT│
└───────────┬───────────────┘   └──────────────────────────────────┘
            │ action=doctor/generate/update/cancel
            ▼
┌───────────────────────────┐   bridge_progress() 替换 3 个 stage 方法
│ CLIDocumentationGenerator │   (entry.py:281-332) ──emit_progress──┐
│ (codewiki, FSoft 算法)     │                                       │
└───────────┬───────────────┘                                       │
            │ generate()                                             │
            ▼                                                        │
┌───────────────────────────┐   map_stage/percent_of (stage_map.py) │
│ FSoft ProgressTracker      │   FSoft 5 段 ──► ENGINE 8 段 (≤90%)   │
│ (5 段: 1..5)               │◄──────────────────────────────────────┘
└───────────────────────────┘
```

要点：
- Python 入口与 FSoft 之间是**替换而非继承**（`entry.py:284-287`）：FSoft 在
  `CLIDocumentationGenerator.__init__` 里直接 `ProgressTracker(total_stages=5)` 构造，
  没有注入点，所以替换三个方法做旁路观察，比 fork tracker 类更不易随上游漂移。
- `on_stage` 回调记录「最后一个真实到达的阶段」（`entry.py:289-291`、`442`），
  使 done 结果里的 `stage` 是实测值而非写死常量。
- `stage_map.py` 是 Node 与 Python 的唯一共享枚举口径，双方集合由测试双向对账。

## Data Flow

一次 `generate`/`update` 请求在 `action_generate`（`entry.py:384-496`）里的完整链路：

1. **解析路径**：`repo_path = payload.repoPath`（缺省 `os.getcwd()`），`docs_dir = payload.docsDir`
   （缺省 `repoPath/.codewiki`），均 `resolve()`（`entry.py:390-391`）；仓库不存在 → `engine-missing`。
2. **模型通道**：调 `_model_config()`（`entry.py:396-398`）；缺项 → `failure("engine-model", ..., "cluster")`。
3. **emit env 100%**：`emit_progress(..., "env", 100, "环境与模型通道就绪")`（`entry.py:400`）。
4. **装配 config**：以 `_model_config()` 为基底，追加
   `update`/`max_tokens=32768`/`max_token_per_module=36369`/`max_token_per_leaf_module=16000`/
   `max_depth=2`/`request_limit=100`/`agent_retries=3`/`use_gitignore=True`/`prompt_caching=True`
   （`entry.py:403-412`）；`updateOptions` 原样透传进 `config["update_options"]`
   （`entry.py:426-428`）；`commitId` 由调用方给出，否则回退 `_git_commit(repo_path)` 或 `None`
   （`entry.py:426`）。
5. **构造 adapter**：`CLIDocumentationGenerator(repo_path, output_dir=docs_dir, config, verbose=False,
   generate_html=False, commit_id=commit_id)`（`entry.py:432-441`）。
6. **旁路进度**：`bridge_progress(adapter, request_id, on_stage=lambda s: reached.__setitem__("stage", s))`
   （`entry.py:442`）。
7. **跑引擎**：`job = adapter.generate()`（`entry.py:443`）。
8. **异常分类**：
   - `SystemExit`：FSoft 在「无变更」等路径会 `sys.exit(0)`（`entry.py:444-454`）——这不是失败，
     `code==0` 直接走 `_done_result`；非 0 → `engine-crashed`。
   - 其他 `Exception` → `_classify_exception(...)`（`entry.py:455-456`）。
9. **清点与校验**：`_count_docs(docs_dir)`；`adapter.validate_generated_docs(str(docs_dir))`
   返回缺失页清单（`entry.py:458-463`）。
10. **终态合成**：
    - 有缺失页 → `_done_result(..., outcome="partial", blockers=[{kind:"article-missing",...}],
      failedCount=len(missing)`（`entry.py:473-481`）。
    - 无缺失 → `_done_result(...)`，再补 `usage`（来自 `job.statistics.usage_totals`：
      `input_tokens`/`output_tokens`/`cache_read_tokens`/`requests`，`entry.py:484-495`）。
11. **增量结局**：`_update_outcome_of(adapter)` 读 `adapter._last_update_record.outcome`，
    返回 `incremental`/`no_change`/`full_fallback`/`detector_failure` 或 `None`
    （`entry.py:576`、`499-513`），写入结果的 `updateOutcome` 字段（`entry.py:576`）。

`doctor` 数据流（`entry.py:198-237`）：`_engine_version()` → `_pip_check()` → 构造
`engine.deps.ok/summary` 的 done 结果，或 `engine-missing`/`engine-deps` 失败。

`cancel` 数据流（`entry.py:650-654`）：入口侧 cancel 只用于「请求已受理但还没开始跑」，
立即回 `_cancelled_result`，不做实际工作（真正的取消由 Node 侧 `process-tree.js` 杀进程树）。

## Connections

- [[contract]] — `lib/engine/contract.js`：双方共享的 `ENGINE_STAGES`（契约八段，`contract.js:24-33`）
  必须与 `stage_map.py:20-29` 同集合；`EngineResult`/`EngineProgress`/`EngineError` 的语义
  （done/partial/failed/cancelled 不变量、`UPDATE_OUTCOMES`、`BLOCKER_KINDS`）是入口产出终态的判据。
- [[client]] — `lib/engine/client.js`：Node 侧跨语言边界，spawn `entry.py`、写一行请求、
  读回 JSON-lines（`createProtocolReader`，协议不变量 1-6 见 `client.js:13-20`）。
- [[native-run]] — `lib/engine/native-run.js`：`DEFAULT_ENGINE_ENTRY = path.join(here, 'python', 'entry.py')`
  （`native-run.js:56`）指向本入口；`DEFAULT_UPDATE_OPTIONS = {rung:'3'}`（`native-run.js:66`）
  是传给引擎的增量算法档位；编排直线 `env→增量决议→水合→引擎→gate→apply` 把本入口夹在中间。
- [[process-tree]] — `lib/engine/process-tree.js`：取消由 Node 侧 `terminateProcessTree` 杀整棵
  进程树（`entry.py:650-654` 注释、`process-tree.js:1-14`），入口侧 cancel 只是快速回终态。
- [[llm-bridge]] — `lib/engine/llm-bridge.js`：模型通道由 Node 侧 loopback 桥注入环境变量，
  入口 `_model_config()` 只从环境读，不落盘、不回退读 `~/.codewiki`。
- [[manifest]] — `lib/engine/manifest.js`：doctor 的环境可信性与锁校验在 Node 侧 `manifest.js`
  的 `doctor`/`writeLock` 完成，入口的 `action_doctor` 只是 FSoft 视角的版本/pip check。

## Known Issues

- **进度上限被刻意压在 90%**（`stage_map.py:63` + 模块 docstring `stage_map.py:12-17`）：
  FSoft 只覆盖八段中的前四段（`env` 由 doctor 承担、`index`/`baseline`/`commit` 由 Node 侧执行），
  所以 `FSOFT_PROGRESS_CEILING=90`，避免「引擎说 100% 但 wiki 还没索引/没提交」的假完成。
  这是设计而非 bug，但意味着前端若直接拿引擎 percent 当整体进度会低估 10%。
- **`SystemExit(0)` 被吞成正常终态**（`entry.py:444-454`）：FSoft 在「无变更」等路径会
  `sys.exit(0)`（generate.py:640 附近）。入口把 `code==0` 当「无变更 = 正常」，但若上游
  未来在真正的失败路径也改用 `sys.exit(0)`，会被误判为成功。
- **`fallback_model` 必须显式传**（`entry.py:263-267`）：adapter 用
  `self.config.get("fallback_model")` 透传（`doc_generator.py:155`），缺省 `None` 会让 FSoft 的
  `create_fallback_models` 在 `model_name.lower()` 上抛 `AttributeError`
  （`llm_services.py:263-269`）——实测必崩在 graph 阶段开头，表现为 `engine-crashed`。
  入口通过 `_model_config()` 固定把 `fallback_model` 设为 `main_model` 规避。
- **`env` 阶段计数只有 5 与 100 两档**（`entry.py:200`、`entry.py:206`）：doctor 的 env 进度
  只在开始与结束时各 emit 一条，中间过程不细分，前端 env 步骤条会「先跳一下再满」。
- **`commitId` 回退到 `HEAD` 是旧行为**（`entry.py:426`）：不传 commitId 时回退 `_git_commit`，
  旧注释说明组件级增量（rung 3）比较的是**依赖图**而非 commit 号；调用方（native-run）应显式给出基线。
- **`_count_docs` 排除规则依赖命名约定**（`entry.py:348-360`）：靠「`temp/` 与点开头目录」排除
  记账文件，若未来 FSoft 改变产物布局（如新增非 `temp` 的非文章 json 目录），written 计数可能失真。
- **stdout 守卫只拦 Python 层 print**（`entry.py:59-92`）：原生子进程（flake8、find 等）若直接
  写 fd 1 会绕过 `_ProtocolOnly`——但那类子进程输出本就走 stderr/stdout 混流，已在 client.js 的
  `not-json` 违规兜底里记下来（`client.js:62-65`）。
