---
title: engine_python_adapter
type: module
source_files:
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-python-entry.mjs
tags: [engine, python, native, protocol, fsoft, stage-mapping]
---

## Overview

`engine_python_adapter` 是迁移后「FSoft 原生引擎 ↔ Node」跨语言边界的 **薄入口层**，由两份文件组成：

- `lib/engine/python/entry.py`（687 行）—— Python 进程入口，是整条迁移里唯一一处「我们写的 Python」。
- `lib/engine/python/stage_map.py`（98 行）—— 纯函数模块，负责 FSoft 五段进度 → 引擎八段契约的映射。

它的职责被刻意压到最小（见 `entry.py:2-10` 的模块 docstring）：**不重新实现**任何依赖图、聚类、文章写作、增量 diff（那些都是 FSoft 自己的活，由 `codewiki.cli.adapters.doc_generator.CLIDocumentationGenerator` 承担）。入口只做四件事：

1. 把 stdin 的一行 JSON 请求变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
2. 把 FSoft 的五段进度（`ProgressTracker`，见 `stage_map.py:33-46` 的镜像）翻译成引擎八段契约，以 JSON 行推给 Node；
3. 把成功/失败/取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同一份语义）；
4. 守住两条红线：**不读本机凭证库**（`~/.codewiki/config.json` / keyring，见 `entry.py:59-65`）、**不让 FSoft 的打印污染协议流**（见 `entry.py:12-21` 与 `_ProtocolOnly` 在 `entry.py:59-92`）。

进程以「读一行请求 → 调用 FSoft 公共 API → 写一行 `result`」的方式工作（`main()` 见 `entry.py:660-673`），由 Node 侧的 `lib/engine/client.js` 起子进程、写请求、读 JSON-lines。退出码只表达进程层结果，语义结果一律以最后那条 `result` 行为准（`entry.py:31-35`）。

## Key Components

### `lib/engine/python/entry.py`

**模块级常量 / 全局**

- `entry.py:48` `_REAL_STDOUT = sys.stdout` —— 在接管前保存真实 stdout 句柄，协议行走它写出（`emit` 见 `entry.py:104-108`）。
- `entry.py:52-56` 在导入任何 codewiki 模块之前，对 `_REAL_STDOUT` 与 `sys.stderr` 做 `reconfigure(encoding="utf-8", errors="replace")`。原因：Windows 下 Python stdout 默认按 locale（cp936）编码，而 Node 一律按 UTF-8 解码协议行，不先改编码中文错误过管道就是乱码（`entry.py:54-55`）。
- `entry.py:94` `PROTOCOL_VERSION = 1` —— 协议版本（独立于结果契约版本）。`emit_hello` 见 `entry.py:111-112`。
- `entry.py:95` `ACTIONS = ("doctor", "generate", "update", "cancel")` —— 登记的动作集合，`handle_request` 据此校验（`entry.py:645-646`）。
- `entry.py:98-101` 模型通道环境变量名：`CODEWIKI_BASE_URL`、`CODEWIKI_API_KEY`、`CODEWIKI_MAIN_MODEL`、`CODEWIKI_CLUSTER_MODEL`（由 Node 侧 `lib/engine/llm-bridge.js` 注入，密钥只活在进程环境）。

**类 / 守卫对象**

- `entry.py:59-91` `class _ProtocolOnly` —— `sys.stdout` 的替身，**必须在 `import codewiki` 之前装好**（`entry.py:14` `sys.stdout = _ProtocolOnly()`）。原因：click 会缓存 stdout 包装器（见 `entry.py:14-15`），事后替换拦不住已缓存的引用；而 FSoft 大量用 `print`/`click.secho` 往 stdout 写人类文案（`entry.py:14-15`）。
  - `entry.py:66-72` `write(self, text)` —— 普通写全部改道 stderr（变日志），返回 `len(text)`。
  - `entry.py:74-78` `flush(self)` —— 也转 stderr（FSoft 进度条会 flush，避免半行日志挤进协议流）。
  - `entry.py:80-81` `isatty(self)` —— 返回 `False`。
  - `entry.py:83-85` `fileno(self)` —— 返回 `sys.stderr.fileno()`，避免某些库抛错。
  - `entry.py:87-89` 属性 `encoding` —— 返回 `"utf-8"`。

**协议写出函数**

- `entry.py:104-108` `emit(obj)` —— 写一行协议 JSON 到真 stdout（`_REAL_STDOUT`），所有协议消息必须经此。
- `entry.py:111-112` `emit_hello()` —— 发 `{type:"hello", protocolVersion, engine:"fsoft-native"}`。
- `entry.py:115-128` `emit_progress(request_id, stage, percent, message="", written=0, failed=0, total=0)` —— 发 `progress` 行，含 `contractVersion:1` 与全部计数。
- `entry.py:131-132` `emit_result(request_id, result)` —— 发 `result` 行。
- `entry.py:135-153` `failure(code, message, stage=None, request_id="")` —— 构造一个 `failed` 终态。`message` 只放给人看的说明，绝不拼凭证内容；`error.message` 截断 4000 字符（`entry.py:142`）。

**doctor（环境可信性）**

- `entry.py:159-173` `_engine_version()` —— 先 `import codewiki` 取 `__version__`，失败再 `importlib.metadata.version("codewiki")`，都失败返回 `""`。
- `entry.py:176-195` `_pip_check(timeout=120)` —— 跑一次 `pip check`，返回 `(ok, 输出摘要)`。这是「1A 门禁」的运行时版本：装到一半的 venv 会让 FSoft 在生成中途崩（`entry.py:179-180`）。
- `entry.py:198-237` `action_doctor(request_id, payload)` —— 探测引擎版本与 `pip check`；缺 codewiki 报 `engine-missing`（`entry.py:204`），依赖不闭合报 `engine-deps` 并把 `deps:{ok,summary}` 塞进 `engine`（`entry.py:208-215`），否则返回带真实 `version`/`python`/`deps` 的 `done` 终态（`entry.py:216-237`）。

**模型通道**

- `entry.py:243-275` `_model_config()` —— 从进程环境读模型通道，缺任何一项返回 `(None, 原因)`。错误信息只说「环境变量」，不打印值（`entry.py:247-262`）。返回的 dict 含 `base_url`/`api_key`/`main_model`/`cluster_model`/`fallback_model`/`provider`，其中 `fallback_model` 必须显式给（否则 FSoft 的 `create_fallback_models` 会在 `model_name.lower()` 上抛 `AttributeError`，见 `entry.py:263-267`）。

**进度桥接**

- `entry.py:281-332` `bridge_progress(adapter, request_id, on_stage=None)` —— 替换 `adapter.progress_tracker` 的 `start_stage`/`update_stage`/`complete_stage` 三个方法（`entry.py:294-299`），把事件转成协议行。用「替换」而非「继承」：FSoft 在 `__init__` 里直接 `ProgressTracker(total_stages=5)` 构造，没有注入点（`entry.py:284-287`）。`on_stage` 收到每个到达的引擎阶段，调用方用它记录「最后一个真实到达的阶段」（`entry.py:301-308`）。内部复用 `stage_map.map_stage` / `percent_of`（`entry.py:292`）。

**generate / update**

- `entry.py:338-363` `_count_docs(docs_dir)` —— **递归**清点产物页数（`root.rglob("*.md")`），排除 `.` 开头的中途目录与 `temp/`（`entry.py:351-354`）。必须递归：hierarchical 布局把页写在子目录里，只 glob 根层会漏掉整棵子树，造成「1 篇成功 + 19 篇失败也报 done」那类误判（`entry.py:341-345`）。
- `entry.py:366-381` `_git_commit(repo_path)` —— 跑 `git rev-parse HEAD`，返回 commit 串或 `""`。
- `entry.py:384-496` `action_generate(request_id, payload, is_update=False)` —— 跑一次 FSoft 生成/增量更新。准备 config（含 `max_tokens:32768`、`max_token_per_module:36369`、`max_depth:2`、`agent_retries:3`、`use_gitignore:True`、`prompt_caching:True` 等见 `entry.py:403-412`）→ `CLIDocumentationGenerator(...)`（`entry.py:432-441`）→ `adapter.generate()`（`entry.py:443`）。关键分支：
  - `_model_config()` 失败 → `failure("engine-model", ...)`（`entry.py:397-398`）。
  - 捕获 `SystemExit`（`entry.py:444-454`）：FSoft 在「无变更」路径会 `sys.exit(0)`（`generate.py:640` 附近），code 0 即正常终态；非 0 报 `engine-crashed`。
  - 捕获其它异常 → `_classify_exception(...)`（`entry.py:455-456`）。
  - 成功后用 `adapter.validate_generated_docs(...)` 查缺失（`entry.py:460-463`）；有缺失 → `outcome="partial"` 带 `article-missing` blockers（`entry.py:473-481`）。
  - 用量从 `job.statistics.usage_totals` 读（`entry.py:485-495`）。
  - `updateOptions` 与 `commitId` 由调用方显式给出，决定走哪条增量算法（`entry.py:416-426`）。
- `entry.py:499-513` `_update_outcome_of(adapter)` —— 读 `adapter._last_update_record.outcome`，拿不到返回 `None`（区分「引擎没说」与「引擎说回退了」，见 `entry.py:502-505`）。
- `entry.py:516-545` `_state_files(docs_dir)` —— 列出引擎在 docsDir 里**真实产出**的跨轮状态文件（顶层 `*.json`、`temp/reference_index.json`、`temp/artifact_index.json`、`temp/dependency_graphs/*`），只报磁盘上存在的（`entry.py:519-522`）。
- `entry.py:548-579` `_done_result(request_id, docs_dir, repo_path, started, written=0, stage="articles", update_outcome=None)` —— 构造 `done` 终态。其中 `artifacts.stateFiles = _state_files(docs_dir)`（`entry.py:571`），`artifacts.rawTreeDir`/`updateRecord` 指向 `module_tree.json`/`update_record.json`（`entry.py:563-565`），顶层并列 `updateOutcome`（`entry.py:576`）。
- `entry.py:582-609` `_classify_exception(exc, request_id, docs_dir, repo_path, started, stage="articles")` —— 按异常**类型**（不是文本）分类成契约错误码：`IncompleteGenerationError`/`IncompleteDocumentationError` → `partial`+`article-missing`（`entry.py:591-600`）；`APIError`/`ConfigurationError` → `engine-model`（`entry.py:603-604`）；`RepositoryError` → `engine-missing`（`entry.py:605-606`）；`KeyboardInterrupt` → `_cancelled_result`（`entry.py:607-608`）；其余 → `engine-crashed`（`entry.py:591`）。
- `entry.py:612-629` `_cancelled_result(request_id, written=0, stage="articles")` —— 构造 `cancelled` 终态，带 `blockers:[{kind:"cancelled",...}]`，`error:null`。

**主循环**

- `entry.py:635-657` `handle_request(msg)` —— 处理一条请求，返回 `(requestId, result)`。校验 JSON 对象（`entry.py:637-638`）、`requestId`（`entry.py:639-641`）、`action`（`entry.py:645-646`）；分派到 `action_doctor`/`_cancelled_result`（仅受理未开始的取消，见 `entry.py:650-654`）/`action_generate(is_update)`。
- `entry.py:660-673` `main()` —— `emit_hello()` → 读一行 stdin → `json.loads` → `handle_request` → `emit_result`。非法 JSON 也回可机读失败（`entry.py:669`）。
- `entry.py:676-687` `__main__` 守卫：被外层杀进程树时仍尽量回一条 `_cancelled_result`（`entry.py:679-686`）。

### `lib/engine/python/stage_map.py`（纯函数，无副作用）

- `stage_map.py:20-29` `ENGINE_STAGES` —— 八段契约阶段名列表，**必须与 `lib/engine/contract.js:24-33` 的 `ENGINE_STAGES` 完全一致**（由 `test-engine-python-entry.mjs:236-247` 双向对账）。顺序即推进顺序：`env, graph, cluster, articles, validate, index, baseline, commit`。
- `stage_map.py:33-39` `FSOFT_STAGE_NAMES` —— FSoft `ProgressTracker.STAGE_NAMES` 的镜像（1 Dependency Analysis / 2 Module Clustering / 3 Documentation Generation / 4 HTML Generation / 5 Finalization）。
- `stage_map.py:40-46` `FSOFT_STAGE_WEIGHTS` —— FSoft 阶段权重镜像（0.40 / 0.20 / 0.30 / 0.05 / 0.05）；与 FSoft 保持一致，否则进度条在阶段交界处跳变（`stage_map.py:31-32`）。
- `stage_map.py:50-56` `FSOFT_TO_ENGINE` —— 五段映射到四段（4/5 都落在 `validate`，因为 HTML 不做、`finalization` 是产物整理，两者都属「文章写完在收口」，见 `stage_map.py:48-49`）。
- `stage_map.py:60` `DEFAULT_ENGINE_STAGE = "articles"` —— 未知阶段归到此处（不抛错，见 `stage_map.py:58-59`）。
- `stage_map.py:63` `FSOFT_PROGRESS_CEILING = 90` —— 引擎内部进度只占 90%，剩 10% 留给 Node 侧 `index/baseline/commit` 收尾（`stage_map.py:12-16`）。
- `stage_map.py:66-72` `map_stage(fsoft_stage)` —— FSoft 阶段号 → 引擎契约阶段名；非整数或未知 → `DEFAULT_ENGINE_STAGE`。
- `stage_map.py:75-97` `percent_of(fsoft_stage, stage_progress)` —— 算整体百分数 0..90。与 FSoft `ProgressTracker.get_overall_progress` 同构（已完成阶段权重之和 + 当前阶段权重×阶段内进度），再乘 `CEILING` 并夹到 `[0,100]`（`stage_map.py:78-96`）。非法输入夹紧不抛。

## Architecture

入口层是「Node ↔ Python」之间唯一的跨语言边界，串在 `lib/engine/client.js`（进程+协议）之下、`CLIDocumentationGenerator`（FSoft 算法）之上：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Node 侧 (lib/engine/client.js)                                         │
│  runEngine() ── spawn python entry.py ── 写一行请求 JSON ── 关 stdin    │
│   ▲                              │                                     │
│   │ JSON-lines (hello/progress/result)                                 │
│   │  stderr = 日志（永不进协议流）                                       │
└───┼──────────────────────────────┼─────────────────────────────────────┘
    │                              │
┌───▼──────────────────────────────▼─────────────────────────────────────┐
│ Python 入口 (lib/engine/python/entry.py)                                 │
│  _ProtocolOnly 守卫 sys.stdout (entry.py:59-92)                          │
│  main() → handle_request() ─┬─ doctor  → action_doctor                  │
│                             ├─ generate → action_generate(is_update=F)  │
│                             ├─ update  → action_generate(is_update=T)    │
│                             └─ cancel  → _cancelled_result              │
│  bridge_progress() 替换 adapter.progress_tracker 三方法 (entry.py:281)   │
└───┬──────────────────────────────┬─────────────────────────────────────┘
    │ map_stage/percent_of          │ CLIDocumentationGenerator.generate()
    ▼                               ▼
┌───────────────────┐      ┌──────────────────────────────────────────┐
│ stage_map.py      │      │ FSoft 算法 (外部，锁定上游 commit)         │
│ 五段→八段 + 0..90 │      │ 依赖图 / 聚类 / 写文 / 组件级增量 / 校验   │
└───────────────────┘      └──────────────────────────────────────────┘
```

组件关系要点：

- `entry.py` 在**导入任何 codewiki 模块之前**就把 `sys.stdout` 换成 `_ProtocolOnly`（`entry.py:19-21, 92`），这是它先于一切的初始动作。
- `bridge_progress`（`entry.py:281-332`）在 `adapter.generate()` 调用前替换 `adapter.progress_tracker` 的三个方法（`start_stage`/`update_stage`/`complete_stage`），把 FSoft 五段事件旁路翻译成协议行；翻译口径来自 `stage_map.py` 的 `map_stage`/`percent_of`。
- `stage_map.py` 是 Node 与 Python 唯一共享的**枚举口径**（`stage_map.py:1-17`），集合一致性由 `test-engine-python-entry.mjs:236-247` 反向断言。
- `action_generate` 不读凭证、不走 `ConfigManager`（`entry.py:23-29`），模型通道只从进程环境变量 `_model_config()`（`entry.py:243-275`）取，由 `lib/engine/llm-bridge.js` 注入。

## Data Flow

一次 `generate`/`update` 编译的端到端数据流：

1. **启动**：Node 侧 `runEngine`（`lib/engine/client.js:223`）`spawn` Python 解释器，写 `{requestId, action, ...payload}\n` 进 stdin 后 `child.stdin.end()`（`client.js:324-329`）。入口 `main()` 读这一行（`entry.py:662`）。
2. **hello**：入口先 `emit_hello()`（`entry.py:661, 111-112`），Node 的 `createProtocolReader` 校验 `protocolVersion`（`client.js:74-80`）。
3. **env 就绪**：`action_generate` 跑 `_model_config()`（`entry.py:396-398`）；若缺环境变量直接回 `failure("engine-model", ...)`。就绪发 `env` 100% 进度（`entry.py:400`）。
4. **构造 adapter**：`CLIDocumentationGenerator(repo_path, output_dir, config, ..., commit_id)`（`entry.py:432-441`）；`bridge_progress` 接管 `progress_tracker`（`entry.py:442`）。
5. **进度回推**：FSoft 每进入/更新/完成一个阶段，`start_stage`/`update_stage`/`complete_stage` 被触发（`entry.py:305-328`）：先调原方法，再用 `map_stage`/`percent_of` 把 FSoft 五段翻成引擎八段（上限 90%，见 `stage_map.py:75`）+ 百分数，经 `emit_progress` 发协议行（`entry.py:115-128`）。
6. **完成**：`adapter.generate()` 返回 `job`（`entry.py:443`）。入口 `_count_docs` 递归清点页数（`entry.py:458`），`adapter.validate_generated_docs` 查缺失（`entry.py:460-463`）；有缺失 → `partial`+`article-missing` blockers（`entry.py:473-481`），否则 `_done_result`（`entry.py:548-579`）。用量从 `job.statistics.usage_totals` 读（`entry.py:485-495`）。
7. **stateFiles / updateOutcome**：`_done_result` 把 `_state_files(docs_dir)` 塞进 `artifacts.stateFiles`（`entry.py:571`），把 `_update_outcome_of(adapter)` 的值放在顶层 `updateOutcome`（`entry.py:576`）。Node 侧 `native-run.js` 用 `result?.artifacts?.stateFiles` 与自己的采集交叉核对（`native-run.js:543-548`），用 `result?.updateOutcome` 决定基线能否推进（`native-run.js:459-460, 651`）。
8. **result**：`emit_result(request_id, result)`（`entry.py:131-132, 673`）。Node 侧 `reader.end()` 必须见到 `result` 才算成功，否则即便退出码 0 也判 `engine-protocol`/`engine-crashed`（`client.js:403-414`）。
9. **异常/取消**：FSoft `sys.exit(0)` 被当正常无变更终态（`entry.py:444-454`）；其它异常经 `_classify_exception` 分类（`entry.py:582-609`）；`KeyboardInterrupt`→取消（`entry.py:607-608`）。取消也可由 Node 侧直接杀进程树（`lib/engine/process-tree.js`），入口这一侧 `cancel` 仅用于「已受理但未开始」（`entry.py:650-654`）。
10. **收尾**：进程退出码只表达进程层结果（`entry.py:31-35`）；Node 侧 `finish()` 把 `protocolViolations`、`exitCode`、`stderrTail`、`durationMs` 等附加到归一结果上（`client.js:253-272`）。

进度百分数映射（`stage_map.py:75-97`）举例：FSoft 第 3 段（Documentation Generation，权重 0.30）走到 100% 时，已完成权重 `0.40+0.20=0.60`，当前段 `0.30×1.0=0.30`，合计 `0.90×90≈81%`，远未到 100%——留给 Node 侧 `index/baseline/commit` 的那 10%。

## Connections

- [[engine-contract]] —— `entry.py` 产出的 `EngineResult`/`EngineProgress` 必须服从 `lib/engine/contract.js` 的同名语义：`engineResult()` 的硬不变量（`done` 不带 blockers、`partial` 必带 blockers、`failed` 必有 error，见 `contract.js:116-142`）、`ENGINE_STAGES` 枚举（`contract.js:24-33`，与 `stage_map.py:20-29` 双向对账）、`UPDATE_OUTCOMES`（契约 `contract.js:45-50`，入口在 `updateOutcome` 里透传 `incremental/no_change/full_fallback/detector_failure`）。
- [[engine-client]] —— `lib/engine/client.js` 是起本入口、解析 JSON-lines、超时/取消/协议破坏处理的 Node 侧；`createProtocolReader`（`client.js:39-186`）与 `runEngine`（`client.js:223-422`）共同定义进程+协议边界，`DEFAULT_ENGINE_ENTRY` 指向本入口（`native-run.js:56`，即 `lib/engine/python/entry.py`）。
- [[engine-process-tree]] —— 取消由 Node 侧 `terminateProcessTree`（`lib/engine/process-tree.js`）整棵杀掉受管子进程树；入口 `cancel` 动作本身只回立即 cancelled 终态（`entry.py:650-654`），真正的运行时取消走进程树终止。
- [[engine-llm-bridge]] —— 模型通道由 `lib/engine/llm-bridge.js` 启动 loopback 桥注入：入口只从 `CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`/`CODEWIKI_MAIN_MODEL`/`CODEWIKI_CLUSTER_MODEL` 环境变量读（`entry.py:98-101, 243-275`），密钥不落盘、不读 keyring。桥的真实凭证始终留在宿主 provider 内。
- [[engine-native-run]] —— `lib/engine/native-run.js` 的 `runNativeJob` 编排一次完整编译：`env(doctor)`→增量决议→水合→`runEngine(generate|update)`→质量门→落地器（`native-run.js:9, 27`）。它把 `updateOutcome`（`native-run.js:459-460, 651`）与 `artifacts.stateFiles`（`native-run.js:543-548`）用于基线推进裁决。
- [[engine-manifest]] —— `doctor` 动作的事实（引擎版本、Python 版本、`pipCheck`）被 `runNativeJob` 的 probe 翻成 manifest 的 facts（`native-run.js:194-216`），再由 `lib/engine/manifest.js` 比对 lock、判 `drift`/`unhealthy`（`native-run.js:243-268`）。
- [[fsoft-native-engine]] —— `docs/fsoft-native-engine.md` 是迁移的冻结契约，本入口完全服从它定义的四动作接口面（`doctor`/`generate`/`update`/`cancel`，见 `fsoft-native-engine.md:80-97`）与协议约束（`fsoft-native-engine.md:91-97`）。
- 测试：`test-engine-python-entry.mjs` 钉住协议面（非法 action/非 JSON）、环境面（真 venv 报真实版本+`pip check`）、凭证面（输出不含 `api_key`/`sk-`/`keyring`），以及 `stage_map` 与 `ENGINE_STAGES` 同集合断言（`test-engine-python-entry.mjs:79-247`）。

## Known Issues

- **`fallback_model` 必须显式给**：`_model_config()` 显式把 `fallback_model` 设成 `main_model`（`entry.py:271`）。若缺失，FSoft 的 `create_fallback_models` 会在 `model_name.lower()` 上抛 `AttributeError`（`llm_services.py:263-269`），崩在 graph 阶段开头，表现为 `engine-crashed` 而非可理解的模型错误（`entry.py:263-267`）。
- **`done` 误判风险（已部分缓解）**：`_count_docs` 必须**递归**清点（`entry.py:338-363`），hierarchical 布局把页写在子目录里；若只 glob 根层会漏掉整棵子树，导致「1 篇成功 + 19 篇失败也报 done」。入口的 `validate_generated_docs` 缺失检查（`entry.py:460-481`）是第二道防线。
- **进度天花板 90% 的语义约定**：`stage_map.py:63` 把引擎内部进度压到 90%，剩 10% 留给 Node 侧 `index/baseline/commit`。若 Node 侧没跑这 10%（例如只跑到引擎终止），面板会永远停在 90% 而非 100%——这是设计约定而非 bug，但排障时要知道。
- **`updateOutcome` 为 `null` 的歧义**：`_update_outcome_of` 拿不到 `_last_update_record` 时返回 `None`（`entry.py:509-510`），可能是「这次是显式全量 generate」而非「想增量却没进入增量分支」。上层（`native-run.js`）据此区分 `null`（显式 full）与 `full_fallback`（想增量却回退），两者对基线处置不同（`entry.py:502-505, native-run.js:651`）。
- **取消语义分两侧**：入口 `cancel` 动作只对「已受理但未开始」立即回 cancelled（`entry.py:650-654`）；运行时取消由 Node 侧 `terminateProcessTree` 杀进程树，入口 `__main__` 守卫在落到 `KeyboardInterrupt` 时仍尽量回一条 `_cancelled_result`（`entry.py:679-686`）。
- **`_state_files` 依赖磁盘真实产出**：它只报 docsDir 里真实存在的状态文件（`entry.py:516-545`），不按白名单编造。若 FSoft 某次真的没产出依赖图，入口会如实报缺失；若 Node 侧采集与之不符会记 `notes`（`native-run.js:543-548`），而不是把「引擎其实没产出图」误记成「已持久化」导致下一轮图 diff 恒空。
- **Windows cp936 编码**：入口在 `import codewiki` 前强制 UTF-8 重配置 stdout/stderr（`entry.py:52-56`），否则中文错误过管道是乱码。此处理仅对真实 `TextIOWrapper` 生效，被重定向的非 `TextIOWrapper` 会静默跳过（`entry.py:55`）。
- **无功能禁用/注释标记**：本模块的两份文件无被禁用或注释掉的公开能力；所有函数（`doctor`/`generate`/`update`/`cancel` 及桥接、映射）均在生效路径上。
