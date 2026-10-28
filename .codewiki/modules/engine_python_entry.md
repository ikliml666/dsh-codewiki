---
title: engine_python_entry
type: module
source_files:
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-python-entry.mjs
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/process-tree.js
  - lib/engine/llm-bridge.js
tags: [python, engine, fsoft, protocol, migration, stage-2]
---

## Overview

`lib/engine/python/entry.py` 是「阶段 2」迁移里唯一一处**我们手写的 Python**——FSoft 原生引擎的 JSON-lines 薄入口。它不实现任何算法（依赖图、聚类、文章写作、增量 diff 全部由 FSoft 自己的 `CLIDocumentationGenerator` 做），只负责四件事（见文件 docstring，entry.py:2-36）：

1. 把 stdin 的一行 JSON 变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
2. 把 FSoft 的五段进度翻译成引擎八段契约（由 `lib/engine/python/stage_map.py` 承担），以 JSON 行推给 Node；
3. 把成功 / 失败 / 取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同一份语义）；
4. 守住两条红线：**不读本机凭证库**（不用 `ConfigManager`）、**不让 FSoft 的 `print` 污染协议流**（早于一切 codewiki import 接管 `sys.stdout`）。

入口是整条迁移里唯一的跨语言边界的 Python 一侧，由 Node 侧的 `lib/engine/client.js` 作为子进程拉起（写一行请求、读回 JSON-lines）。

## Key Components

### 协议流守卫（必须在 import codewiki 之前装好）

- **`_REAL_STDOUT = sys.stdout`** (entry.py:48)：保存进程原本的真实 stdout 句柄，所有协议消息都经它写出。
- **`_ProtocolOnly`** (entry.py:59-89)：`sys.stdout` 的替身类。普通 `write` / `flush` 全部改道 `sys.stderr`（变成日志），只有经 `emit()` 走 `_REAL_STDOUT` 的协议行才能进真正的 stdout。字段/方法：
  - `write(self, text)` (entry.py:66-72)：把人类文案改道 stderr，返回 `len(text or "")`。
  - `flush(self)` (entry.py:74-78)：转 flush 到 stderr——防止 FSoft 进度条 flush 把半行日志挤进协议流。
  - `isatty(self)` (entry.py:80-81)：返回 `False`（冒充非终端）。
  - `fileno(self)` (entry.py:83-85)：返回 `sys.stderr.fileno()`，避免某些库判定终端时抛错。
  - `encoding` 属性 (entry.py:87-89)：返回 `"utf-8"`。
  - 赋值 **`sys.stdout = _ProtocolOnly()`** (entry.py:92) 在导入任何 codewiki 模块前完成（原因见 entry.py:12-21：click 会缓存 text stdout 包装器，事后替换拦不住已缓存引用）。
- 编码修复 (entry.py:52-56)：对 `_REAL_STDOUT` / `sys.stderr` 调 `reconfigure(encoding="utf-8", errors="replace")`，避免 Windows cp936 下中文错误信息过管道变乱码。

### 协议常量与发射器

- **`PROTOCOL_VERSION = 1`** (entry.py:94)：协议版本号，写入 `hello`。
- **`ACTIONS = ("doctor", "generate", "update", "cancel")`** (entry.py:95)：登记的动作集合，`handle_request` 据此校验。
- **环境变量名常量** (entry.py:98-101)：
  - `ENV_BASE_URL = "CODEWIKI_BASE_URL"`
  - `ENV_API_KEY = "CODEWIKI_API_KEY"`
  - `ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"`
  - `ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"`
  - 这些值由 Node 侧 `lib/engine/llm-bridge.js` 的 loopback 桥注入，密钥只活在进程环境里，不落盘。
- **`emit(obj)`** (entry.py:104-108)：所有协议消息的唯一出口。`json.dumps(obj, ensure_ascii=False)` 后写 `_REAL_STDOUT` 并 flush。
- **`emit_hello()`** (entry.py:111-112)：发 `{"type": "hello", "protocolVersion": PROTOCOL_VERSION, "engine": "fsoft-native"}`。
- **`emit_progress(request_id, stage, percent, message="", written=0, failed=0, total=0)`** (entry.py:115-128)：发一条 `progress` 协议行（`contractVersion: 1` + `stage` + `percent` + 计数）。
- **`emit_result(request_id, result)`** (entry.py:131-132)：发 `{"type": "result", "requestId": request_id, "result": result}`。
- **`failure(code, message, stage=None, request_id="")`** (entry.py:135-153)：构造一个 `outcome: "failed"` 终态；`message` 只放给人看的说明，绝不拼凭证内容（被截断到 4000 字）。含完整 `usage` / `engine` / `artifacts` 空壳字段。

### doctor：环境可信性

- **`_engine_version()`** (entry.py:159-173)：先试 `codewiki.__version__`，再退到 `importlib.metadata.version("codewiki")`，都拿不到返回 `""`。
- **`_pip_check(timeout=120)`** (entry.py:176-195)：跑 `python -m pip check`，返回 `(ok, 摘要)`。`ok` 为 `returncode == 0`；输出截断到 2000 字。这是 1A 门禁的运行时版本——避免装到一半的 venv 在生成中途因缺包崩掉。
- **`action_doctor(request_id, payload)`** (entry.py:198-237)：探测引擎版本与 pip 依赖。版本为空 → `failure("engine-missing", ...)` (entry.py:204)；pip 不闭合 → `failure("engine-deps", ...)` 并补 `engine.deps.ok=False` (entry.py:208-215)；否则返回 `outcome: "done"` 带 `engine.version` / `python` / `deps.ok=True`。`stage` 固定为 `"env"`，`startedAt` / `finishedAt` 用 `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())`。

### 模型通道

- **`_model_config()`** (entry.py:243-275)：从进程环境读模型通道。缺 `ENV_BASE_URL` / `ENV_API_KEY` / `ENV_MAIN_MODEL` 任意一项都返回 `(None, 原因)`，原因里只说「环境变量」不打印值（entry.py:262）。返回的 dict 含 `base_url` / `api_key` / `main_model` / `cluster_model`（缺省回退到 main） / `fallback_model`（必须显式给 model，否则 FSoft `create_fallback_models` 在 `model_name.lower()` 抛 `AttributeError`，见 entry.py:263-267） / `provider: "openai-compatible"`。

### 进度桥接

- **`bridge_progress(adapter, request_id, on_stage=None)`** (entry.py:281-332)：替换 `adapter.progress_tracker` 的 `start_stage` / `update_stage` / `complete_stage` 三个方法（entry.py:330-332），把 FSoft 五段进度转成协议行。用替换而非继承，因为 FSoft 在 `CLIDocumentationGenerator.__init__` 里直接 `ProgressTracker(total_stages=5)` 构造、无注入点（entry.py:284-287）。`on_stage` 收到每个到达的引擎阶段，供调用方记录「最后一个真实到达的阶段」。映射逻辑来自 `stage_map.map_stage` / `percent_of`（entry.py:292）。

### generate / update

- **`_count_docs(docs_dir)`** (entry.py:338-363)：递归 `rglob("*.md")` 清点产物页数，排除 `.` 开头目录与 `temp/` 开头路径（记账文件不是文章，entry.py:351-354）。递归是因为 hierarchical 布局把页写在子目录里（entry.py:341-344）。异常返回 0。
- **`_git_commit(repo_path)`** (entry.py:366-381)：跑 `git rev-parse HEAD` 拿 commit id，失败返回 `""`。
- **`action_generate(request_id, payload, is_update=False)`** (entry.py:384-472)：跑一次 FSoft 生成/增量更新。流程：解析 `repoPath` / `docsDir`（缺省 `repo_path / ".codewiki"`）(entry.py:390-391) → 仓库不存在 → `failure("engine-missing", ...)` (entry.py:394) → `_model_config()` 缺通道 → `failure("engine-model", ...)` (entry.py:390-391) → 构造 `config` dict（含 `update` / `max_tokens=32768` / `max_token_per_module=36369` / `max_token_per_leaf_module=16000` / `max_depth=2` / `request_limit=100` / `agent_retries=3` / `use_gitignore=True` / `prompt_caching=True`，entry.py:403-412）→ 构造 `CLIDocumentationGenerator` 并 `bridge_progress` + `adapter.generate()` (entry.py:420-431)：
  - 捕获 `SystemExit` (entry.py:432-438)：`code==0`（FSoft 在「无变更」路径 `sys.exit(0)`）当作正常终态走 `_done_result`；否则 `failure("engine-crashed", ...)`。
  - 捕获其他 `Exception` → `_classify_exception` (entry.py:439-440)。
  - 成功后 `_count_docs`，调 `adapter.validate_generated_docs` 找缺失 (entry.py:444-447)，缺失则 `_done_result` + `outcome: "partial"` + `blockers` 列出缺失文章 (entry.py:449-457)。
  - 否则 `_done_result` + 读 `job.statistics.usage_totals` 填 `usage` (entry.py:461-471)。
- **`_done_result(request_id, docs_dir, repo_path, started, written=0, stage="articles")`** (entry.py:475-496)：构造 `outcome: "done"` 终态；`artifacts` 含 `docsDir` / `rawTreeDir = docs_dir/module_tree.json` / `updateRecord = docs_dir/update_record.json` (entry.py:489-493)；`engine.commit` 由 `_git_commit` 填。
- **`_classify_exception(exc, request_id, docs_dir, repo_path, started, stage="articles")`** (entry.py:499-526)：按**异常类型**分类（非文本，文本随版本变）：
  - `IncompleteGenerationError` / `IncompleteDocumentationError` → `partial` + 缺页 blockers (entry.py:508-517)。
  - 以 `APIError` 结尾 / `APIError` / `ConfigurationError` → `failure("engine-model", ...)` (entry.py:520-521)。
  - `RepositoryError` → `failure("engine-missing", ..., "graph")` (entry.py:522-523)。
  - `KeyboardInterrupt` → `_cancelled_result` (entry.py:524-525)。
  - 其它 → `failure("engine-crashed", ...)` (entry.py:526)。
- **`_cancelled_result(request_id, written=0, stage="articles")`** (entry.py:529-546)：构造 `outcome: "cancelled"` 终态，`blockers` 含 `{kind: "cancelled", detail: "用户取消了这次编译"}`，`artifacts` 全部留空。

### 主循环

- **`handle_request(msg)`** (entry.py:552-574)：处理一条请求，返回 `(requestId, result)`。非 dict → `failure("engine-protocol", ...)` (entry.py:555)；缺 `requestId` → `failure("engine-protocol", ...)` (entry.py:558)；`action` 不在 `ACTIONS` → `failure("engine-protocol", ...)` (entry.py:562-563)；`doctor` → `action_doctor`；`cancel` → `_cancelled_result`（立即回 cancelled，不做实际工作，entry.py:567-571）；`update` → `action_generate(is_update=True)`；其它 → `action_generate(is_update=False)`。
- **`main()`** (entry.py:577-590)：`emit_hello()` → 读 stdin 一行 → 空行 → `failure("engine-protocol", "没有收到请求行")` (entry.py:581)；非法 JSON → `failure("engine-protocol", ...)` (entry.py:586)；否则 `handle_request` 后 `emit_result`。返回 0。
- **`__main__` 守卫** (entry.py:593-603)：`main()` 抛 `KeyboardInterrupt`（外层杀进程树时可能落到这里）仍尽量 `emit_result("", _cancelled_result(""))` 让 Node 拿得到语义终态。

### stage_map.py（Node↔Python 共享的枚举口径）

- **`ENGINE_STAGES`** (stage_map.py:20-29)：与 `lib/engine/contract.js:24-33` 的 `ENGINE_STAGES` **必须完全一致**（测试双向对账，test-engine-python-entry.mjs:236-247）。八段：`env, graph, cluster, articles, validate, index, baseline, commit`。注意 FSoft 只覆盖前四段，`env` 由 doctor 承担，`index/baseline/commit` 由 Node 侧后续执行（stage_map.py:12-16）。
- **`FSOFT_STAGE_NAMES`** (stage_map.py:33-39) / **`FSOFT_STAGE_WEIGHTS`** (stage_map.py:40-46)：FSoft `ProgressTracker` 五段的镜像（权重 0.40/0.20/0.30/0.05/0.05）。
- **`FSOFT_TO_ENGINE`** (stage_map.py:50-56)：五段→四段映射（`{1:graph, 2:cluster, 3:articles, 4:validate, 5:validate}`；4/5 都落 `validate`）。
- **`DEFAULT_ENGINE_STAGE = "articles"`** (stage_map.py:60)：未知阶段不抛错，归到 articles（耗时最长、最需可见）。
- **`FSOFT_PROGRESS_CEILING = 90`** (stage_map.py:63)：引擎内部进度只到 90%，剩 10% 留给 Node 侧收尾（避免假完成）。
- **`map_stage(fsoft_stage)`** (stage_map.py:66-72)：阶段号→引擎阶段名，未知/非法归 `DEFAULT_ENGINE_STAGE`。
- **`percent_of(fsoft_stage, stage_progress)`** (stage_map.py:75-97)：五段 (阶段号, 0..1) → 整体百分数 0..90（已完成阶段权重之和 + 当前阶段权重×进度）× CEILING，夹到 [0,100]；测试断言百分数单调递增 (test-engine-python-entry.mjs:212-234)。

## Architecture

入口是进程级薄胶水，组件分三层：协议守卫（import 前装好）、动作分派、FSoft 适配。框图如下（组件标注文件/类/行）：

```text
 stdin 一行 JSON
      │
      ▼
┌─────────────────────────┐   _REAL_STDOUT  ┌──────────────┐
│ main()  entry.py:577    │ ───────────────►│ Node client   │
│  emit_hello + handle    │  协议行(JSON)    │ client.js:39  │
└───────────┬─────────────┘                 └──────────────┘
            │ handle_request entry.py:552
            ▼
   ┌────────────────────────┐
   │ ACTIONS 校验 entry.py:95│
   └───┬───────┬──────┬─────┘
       │       │      │
   doctor    generate/update   cancel
       │       │              │
       ▼       ▼              ▼
 action_   action_generate   _cancelled_result
 doctor    entry.py:384      entry.py:529
 entry.py:198     │
       │       _model_config  entry.py:243
       │       (ENV_* 注入)    │
       │          ▼
       │   ┌──────────────────────────────┐
       │   │ CLIDocumentationGenerator     │
       │   │ codewiki.cli.adapters...      │
       │   │   │ bridge_progress           │
       │   │   │ entry.py:281  (替换3方法)  │
       │   │   ▼                            │
       │   │ FSoft ProgressTracker(5段)     │
       │   └───┬──────────────────────────┘
       │       │ map_stage/percent_of
       │       ▼ (stage_map.py:66/75)
       │   emit_progress → 8段契约 entry.py:115
       ▼
   emit_result EngineResult entry.py:131
   (语义同 contract.js:24 ENGINE_STAGES)
```

关键点：协议流只能经 `_REAL_STDOUT` 输出，`_ProtocolOnly` (entry.py:59) 把所有 FSoft 的 print 改道 stderr；进度翻译由 `stage_map.py` 这个**纯函数**模块承担，其 `ENGINE_STAGES` 与 `contract.js:24` 双向对账，防止两边漂移。

## Data Flow

一次 `generate` 请求的端到端流向（其它动作是子集）：

1. **启动**：Node `client.js` 以 `spawn` 拉起 `python entry.py`，入口先 `emit_hello` (entry.py:578, entry.py:111)。`sys.stdout` 此前已被 `_ProtocolOnly` 接管 (entry.py:92)。
2. **请求入**：Node 写一行请求 JSON（`action: "generate"` + `payload.repoPath` / `payload.docsDir`）。入口 `main()` 读一行 stdin (entry.py:390) → `json.loads` (entry.py:584) → `handle_request` (entry.py:588)。
3. **分派与模型通道**：`handle_request` 校验 `requestId` / `action` (entry.py:557-563) → `action_generate` (entry.py:384)。`_model_config` 从 `ENV_*` 读通道 (entry.py:243)；缺项即 `failure("engine-model")` 经 `emit_result` 回 Node (entry.py:398)。
4. **跑 FSoft**：构造 `CLIDocumentationGenerator`（config 含 `max_tokens=32768`、`max_depth=2`、`agent_retries=3` 等，entry.py:403-412）并 `adapter.generate()` (entry.py:431)。`bridge_progress` 已把三个 tracker 方法换成发 `progress` 行的版本 (entry.py:330-332)。
5. **进度回传**：FSoft 每推进一段，`start_stage`/`update_stage`/`complete_stage` 经 `map_stage` (stage_map.py:66) 与 `percent_of` (stage_map.py:75) 翻成八段契约百分数（上限 90%，stage_map.py:63），`emit_progress` 写真 stdout (entry.py:115)。
6. **终态翻译**：
   - 正常完成 → `_count_docs` 清点数 → `validate_generated_docs` 查缺失 (entry.py:445) → 缺页则 `outcome:"partial"` + blockers，否则 `outcome:"done"` 并填 `usage` (entry.py:459-471)。
   - `SystemExit(0)`（无变更）视为正常终态 (entry.py:432)；`SystemExit(非0)` → `engine-crashed` (entry.py:438)。
   - 其它异常 → `_classify_exception` 按类型映射错误码 (entry.py:499)。
   - `KeyboardInterrupt` → `_cancelled_result` (entry.py:524)。
7. **终态回传**：`emit_result` 发 `{"type":"result", ...}` (entry.py:131)，Node `client.js` 收齐 `result` 后判终态（协议不变量见 client.js:13-20）。

`cancel` 动作在入口侧仅用于「请求已受理但还没开始跑」的场景，立即回 `_cancelled_result` (entry.py:567-571)；真正进行中的取消由 Node `process-tree.js` 杀进程树完成 (entry.py:568)。

## Connections

- [[engine-client]]：`lib/engine/client.js` 是跨语言边界的 Node 一侧，以子进程拉起本入口、读回 JSON-lines 并翻译成 `EngineResult`/`EngineProgress`/`EngineError`；其协议不变量（退出码只表达进程层、语义以 `result` 为准等）与本入口的退出码约定对齐（client.js:13-20，entry.py:31-35）。
- [[engine-contract]]：`lib/engine/contract.js` 的 `ENGINE_STAGES`（contract.js:24-33）是八段契约的唯一真源，本入口的 `stage_map.py:ENGINE_STAGES`（stage_map.py:20-29）与之双向对账（test-engine-python-entry.mjs:236-247）；`EngineResult` 的 `done/partial/failed/cancelled` 语义不变量由两侧共同遵守。
- [[engine-process-tree]]：`lib/engine/process-tree.js` 负责杀进程树实现真正的取消（含孙进程），入口侧 `cancel` 只处理「未开始」的边界情况（entry.py:567-571，entry.py:568 注释指向 process-tree.js）。
- [[engine-llm-bridge]]：`lib/engine/llm-bridge.js` 的 loopback 桥向本入口注入 `CODEWIKI_BASE_URL` / `CODEWIKI_API_KEY` / `CODEWIKI_MAIN_MODEL` / `CODEWIKI_CLUSTER_MODEL` 等环境变量（entry.py:98-101），密钥只活在进程环境、不落盘也不由 `ConfigManager` 读取（entry.py:23-29）。
- [[engine-quality-gate]]：`stage_map.py` 把 FSoft 第 4/5 段（HTML / Finalization）都映射到 `validate`，与质量门阶段对应（stage_map.py:48-56）。

## Known Issues

- **进度上限被刻意压到 90%**（stage_map.py:63，`FSOFT_PROGRESS_CEILING = 90`）：`index` / `baseline` / `commit` 三段由 Node 侧后续执行，入口从不报 100%，避免「引擎说 100% 但 wiki 还没索引/没提交」的假完成。这是设计而非 bug，但消费方若误判 100% 会漏掉最后 10%。
- **缺 `fallback_model` 必崩**：`_model_config` 必须显式把 `fallback_model` 设为 `main_model`（entry.py:271），否则 FSoft 的 `create_fallback_models` 在 `model_name.lower()` 抛 `AttributeError`（llm_services.py:263-269），且崩在 graph 阶段开头，表现为 `engine-crashed` 而非可理解的模型错误（entry.py:263-267）。
- **`SystemExit(0)` 被当作正常终态**（entry.py:432）：FSoft 在「无变更」等路径会 `sys.exit(0)`（generate.py:640 附近），入口据此走 `_done_result`；若未来 FSoft 在真正的失败路径也用 `sys.exit(0)`，会被误判为成功。
- **凭证泄漏防护靠纪律而非机制**：`failure` 的 `message` 被截断到 4000 字且禁止拼凭证（entry.py:142），`_model_config` 报错只说「环境变量」不打印值（entry.py:262）；但若 FSoft 内部异常文本本身含密钥，会从 `_classify_exception` 的 `traceback` 片段（entry.py:526）漏进 `engine-crashed` 终态的 `error.message`（同样地，被截断到 1200 字 / 1500 字）。测试 `test-engine-python-entry.mjs:177-208` 钉住了 `api_key`/`sk-`/`credentials.json`/`keyring` 不得出现在输出里。
- **`usage` 统计依赖 FSoft 内部结构**：`action_generate` 读 `job.statistics.usage_totals`（doc_generator.py:559-580）的 `input_tokens` / `output_tokens` / `cache_read_tokens` / `requests`（entry.py:462-469），这些字段名随 FSoft 版本漂移时会被静默吞掉（`except` 后 `pass`，entry.py:470-471），`usage` 退化为全 0。
- **`validate_generated_docs` 缺失的兜底**：若该方法自身抛异常，`missing` 被置为 `[]`（entry.py:446-447），此时即便确有文章缺失也可能报 `done` 而非 `partial`。
- **无增量 diff 判断在入口侧**：`action_generate` 不判断改了什么、该写哪些文章（entry.py:387）——那是 FSoft 的职责；入口只是一层胶水，任何 FSoft 内部的 diff 行为变化都不会在本模块被发现。

