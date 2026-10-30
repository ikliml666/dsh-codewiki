---
title: engine_python
type: module
source_files:
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-python-entry.mjs
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/native-run.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - docs/fsoft-native-engine.md
tags: [python, native-engine, entrypoint, stage-mapping, fsoft, contract]
---

## Overview

`engine_python` 是整条「FSoft 原生引擎」迁移里**唯一一处我们手写的 Python**。它由两个文件组成：

- `lib/engine/python/entry.py` —— 一个 JSON-lines 薄入口（进程）。Node 侧（`lib/engine/client.js`）起一个 Python 子进程，写一行请求 JSON，读回若干行协议 JSON。它**不实现**任何依赖图 / 聚类 / 文章写作 / 增量算法（那是 FSoft `CLIDocumentationGenerator` 的活），只负责四件事：
  1. 把 stdin 的一行 JSON 请求变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
  2. 把 FSoft 的**五段**进度翻译成引擎**八段**契约（`stage_map.py`），以 JSON 行推给 Node；
  3. 把成功 / 失败 / 取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同一份语义，见 `entry.py:9`）；
  4. 守住两条红线：**不读本机凭证库**、**不让 FSoft 的打印污染协议流**（见 `entry.py:10`）。
- `lib/engine/python/stage_map.py` —— 纯函数模块，固定「FSoft 五段 → 引擎八段契约」的映射。它是 Node（`contract.js:ENGINE_STAGES`）与 Python 唯一共享的**枚举口径**，由 `test-engine-python-entry.mjs:344` 双向对账，任一边漂移测试立刻红。

入口的模块 docstring 解释了两个关键设计动机：

- **stdout 在 import 任何 codewiki 模块之前就被接管**（`entry.py:12-21`）：FSoft 大量用 `print` / `click.secho` / `print_banner` 往 stdout 写人类文案，而 click 会**缓存** text stdout 包装器，事后替换 `sys.stdout` 拦不住已缓存的引用，所以入口在导入期就给 `sys.stdout` 换上守卫对象。
- **不用 `ConfigManager`**（`entry.py:23-29`）：`ConfigManager` 会去读 `~/.codewiki/config.json` 或系统 keyring，而迁移后模型通道由 Node 侧 loopback 桥注入（`lib/engine/llm-bridge.js`），密钥只活在**进程环境变量**里，不需要也不允许落盘。入口直接构造 config dict 交给 adapter。

进程退出码只表达**进程层**结果，语义以最后那条 `result` 行为准（`entry.py:31-35`），与 `lib/engine/client.js` 约定一致：协议破坏用「0 退出 + failed result」表达，让 Node 侧能拿到结构化失败原因而不是一句「exit 1」。

## Key Components

### 模块级常量与全局状态（`entry.py`）

- `PROTOCOL_VERSION = 1` — `entry.py:133`：协议版本号，写进 `hello` 行（`entry.py:151`）。
- `ACTIONS = ("doctor", "generate", "update", "cancel")` — `entry.py:134`：允许的四个动作；`handle_request`（`entry.py:723`）以外的值一律 `engine-protocol` 失败。
- 模型通道环境变量名（均由 Node 侧桥注入，密钥只活在进程环境）：
  - `ENV_BASE_URL = "CODEWIKI_BASE_URL"` — `entry.py:137`
  - `ENV_API_KEY = "CODEWIKI_API_KEY"` — `entry.py:138`
  - `ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"` — `entry.py:139`
  - `ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"` — `entry.py:140`
- `WIKI_PRODUCT_PATTERNS = (".codewiki", "CodeWiki.md")` — `entry.py:282`：本插件自己的 wiki 产物，必须从源码分析面排除（否则每轮都自报「有变化」）。
- `_REAL_STDOUT` — `entry.py:48`：在换成守卫对象之前保存下来的**真** stdout 句柄；所有协议行走它（`emit`，`entry.py:146`）。
- `_real_popen_init` / `_popen_init_utf8` — `entry.py:82`、`entry.py:85`：给 `subprocess.Popen.__init__` 打的补丁（`entry.py:95`），只补 text 模式且未显式给 encoding 的调用，强制走 UTF-8（解决 Windows 上 FSoft 子进程按 locale 解码 `git` 输出导致的 `UnicodeDecodeError`）。

### 编码与流守卫（`entry.py:46-131`）

- `for _stream in (_REAL_STDOUT, sys.stderr): ... reconfigure(encoding="utf-8", errors="replace")` — `entry.py:62-66`：把 stdout / stderr 钉成 UTF-8（replace 风格，坏字节宁可丢不要断协议行）。
- `sys.stdin.reconfigure(encoding="utf-8")` — `entry.py:67-70`：stdin 用默认 strict，非法字节当场报错，而不是被替换成乱码路径后继续往下走。
- `class _ProtocolOnly` — `entry.py:98`：`sys.stdout` 的替身，import codewiki 之前装上（`entry.py:131`）。只允许经 `_REAL_STDOUT` 的协议写；其它一律改道 stderr。方法：
  - `write(text)` — `entry.py:105`：把普通写全部改道 `sys.stderr`，返回 `len(text)`。
  - `flush()` — `entry.py:113`：转给 `sys.stderr.flush()`，防止 FSoft 进度条 flush 把半行日志挤进协议流。
  - `isatty()` — `entry.py:119`：返回 `False`。
  - `fileno()` — `entry.py:122`：返回 `sys.stderr.fileno()`，避免某些库拿 fileno 判终端时抛错。
  - `@property encoding` — `entry.py:126`：返回 `"utf-8"`。

### 协议写出（`entry.py:143-192`）

- `emit(obj)` — `entry.py:143`：写一行协议 JSON 到真 stdout，所有协议消息都必须经这里；`ensure_ascii=False`（中文可读）。
- `emit_hello()` — `entry.py:150`：写 `{"type":"hello","protocolVersion":...,"engine":"fsoft-native"}`（`entry.py:151`）。
- `emit_progress(request_id, stage, percent, message, written, failed, total)` — `entry.py:154`：写一条 `progress` 行（`entry.py:155-167`），字段含 `contractVersion:1`、`stage`、`percent`、`writtenCount`、`failedCount`、`totalCount`。
- `emit_result(request_id, result)` — `entry.py:170`：写一条 `{"type":"result","requestId":...,"result":...}` 行。
- `failure(code, message, stage, request_id)` — `entry.py:174`：构造一个 `failed` 终态。`message` 只放给人看的说明，绝不拼凭证内容（`entry.py:175`）；`error.message` 截断到 4000 字符（`entry.py:181`）。返回完整 `EngineResult` 形态（含全 0 的 usage / engine / artifacts）。

### doctor 动作（`entry.py:195-277`）

- `_engine_version()` — `entry.py:198`：优先 `codewiki.__version__`，回退 `importlib.metadata.version("codewiki")`（`entry.py:207-210`）；都拿不到返回 `""`。
- `_pip_check(timeout=120)` — `entry.py:215`：跑 `python -m pip check`，返回 `(ok, 输出摘要)`（`entry.py:221-234`）。这是 doctor 门禁的运行时版：装一半的 venv 会在生成中途才崩，代价是一整轮模型调用白烧。
- `action_doctor(request_id, payload)` — `entry.py:237`：探测引擎版本 + 跑 pip check。版本缺失 → `failure("engine-missing", ...)`（`entry.py:243`）；pip 不闭合 → `failure("engine-deps", ...)` 但带上 `engine.deps`（`entry.py:247-253`）；两者 OK → 返回 `done` 终态并填 `engine.deps.ok`（`entry.py:255-276`）。`startedAt` / `finishedAt` 用 `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())` 生成（`entry.py:238`、`entry.py:275`）。

### 源码分析面（`entry.py:279-291`）

- `source_exclude_patterns()` — `entry.py:285`：返回 `WIKI_PRODUCT_PATTERNS` 的**新列表**（`entry.py:291`），避免调用方（RepoAnalyzer）合并 default 与 user 两组模式时共享同一个 list 互相污染。

### 模型通道（`entry.py:294-329`）

- `_model_config()` — `entry.py:297`：从进程环境读模型通道。缺任一项（base_url / api_key / main_model）返回 `(None, 原因)`（`entry.py:303-316`），错误信息只说「环境变量」不打印值。返回的 dict 含 `base_url` / `api_key` / `main_model` / `cluster_model`（缺省回退 main_model，`entry.py:326`）/ `fallback_model`（显式给 main_model，避免 FSoft `create_fallback_models` 在 `None.lower()` 上崩，`entry.py:319`）/ `provider:"openai-compatible"`。

### 进度桥接（`entry.py:332-386`）

- `bridge_progress(adapter, request_id, on_stage=None)` — `entry.py:335`：替换 `adapter.progress_tracker` 的 `start_stage` / `update_stage` / `complete_stage` 三个方法（`entry.py:384-386`），把 FSoft 事件转成协议行。用**替换**而不是继承：FSoft 在 `CLIDocumentationGenerator.__init__` 里直接 `ProgressTracker(total_stages=5)` 构造，没有注入点（`entry.py:338-341`）。`on_stage` 收到每一个到达的引擎阶段，调用方用它记录「最后一个真实到达的阶段」（`entry.py:343-344`、`entry.py:357`）。内部用 `map_stage` / `percent_of`（`entry.py:346`）。

### generate / update（`entry.py:389-563`）

- `_count_docs(docs_dir)` — `entry.py:392`：**递归**清点 `*.md` 页数（`entry.py:405`）；排除点开头目录与 `temp/`（`entry.py:408-411`），否则 hierarchical 子目录漏计会让 `written` 少计、终态误判成功。
- `_git_commit(repo_path)` — `entry.py:420`：`git rev-parse HEAD`，拿不到返回 `""`（`entry.py:420-435`）。
- `action_generate(request_id, payload, is_update=False)` — `entry.py:438`：跑一次 FSoft 生成 / 增量更新。流程：解析 `repoPath` / `docsDir`（`entry.py:444-445`）→ 仓库不存在 → `failure("engine-missing", ...)`（`entry.py:448`）；`_model_config` 失败 → `failure("engine-model", ...)`（`entry.py:452`）；组装 config（`entry.py:457-479`，含 `max_tokens:32768`、`max_depth:2`、`use_gitignore:True`、`prompt_caching:True`、`agent_instructions.exclude_patterns` 来自 `source_exclude_patterns()`）；透传 `updateOptions`（`entry.py:483-485`）与 `commitId`（`entry.py:493`，缺省回退 `_git_commit`）；构造 `CLIDocumentationGenerator` 并 `bridge_progress`（`entry.py:499-509`）；`adapter.generate()`（`entry.py:510`）。异常分支：
  - `SystemExit`：`code==0`（FSoft 在无变更路径 `sys.exit(0)`，`entry.py:512`）→ `_done_result`；否则 `failure("engine-crashed", ...)`（`entry.py:521`）。
  - 其它 `Exception` → `_classify_exception`（`entry.py:523`）。
  - 成功后用 `adapter.validate_generated_docs` 检查缺页（`entry.py:527-548`），缺页 → `partial` + `article-missing` blockers；否则 `_done_result` 并填充 `usage`（来自 `job.statistics.usage_totals`，`entry.py:551-561`）。
- `_update_outcome_of(adapter)` — `entry.py:566`：读 `adapter._last_update_record.outcome`（`entry.py:575-578`）。拿不到返回 `None` 而不是编 `full`：区分「引擎没说」（显式 full 请求）与「引擎说回退了」（`entry.py:569-572`）。
- `_state_files(docs_dir)` — `entry.py:583`：列出引擎在 docsDir 里**真实产出**的跨轮状态文件（顶层 `*.json` + `temp/reference_index.json` + `temp/artifact_index.json` + `temp/dependency_graphs/*`，`entry.py:592-612`）。只报磁盘上存在的文件，不按白名单编造（`entry.py:584-591`），供上层交叉校验。
- `_done_result(request_id, docs_dir, repo_path, started, written, stage, update_outcome)` — `entry.py:615`：构造 `done` 终态。`artifacts` 含 `docsDir` / `rawTreeDir`（`module_tree.json`）/ `updateRecord`（`update_record.json`）/ `stateFiles`（来自 `_state_files`，`entry.py:638`）；顶层 `updateOutcome` 与 artifacts 并列（`entry.py:643`）；`engine.commit` 来自 `_git_commit`（`entry.py:628`）。
- `_classify_exception(exc, request_id, docs_dir, repo_path, started, stage)` — `entry.py:649`：按异常**类型**分类（不是消息文本）。`IncompleteGenerationError` / `IncompleteDocumentationError` → `partial` + `article-missing`（或 `article-failed`）blockers（`entry.py:658-667`）；`*APIError` / `ConfigurationError` → `failure("engine-model", ...)`（`entry.py:670-671`）；`RepositoryError` → `failure("engine-missing", ..., "graph")`（`entry.py:672-673`）；`KeyboardInterrupt` → `_cancelled_result`（`entry.py:674-675`）；其它 → `failure("engine-crashed", ...)`（`entry.py:670`）。
- `_cancelled_result(request_id, written, stage)` — `entry.py:679`：构造 `cancelled` 终态，`blockers:[{kind:"cancelled",...}]`（`entry.py:684`）。

### 主循环（`entry.py:699-765`）

- `handle_request(msg)` — `entry.py:702`：处理一条请求，返回 `(requestId, result)`，**任何路径都必须返回 result**。非 dict → `failure("engine-protocol", ...)`（`entry.py:705`）；缺 `requestId` → `failure("engine-protocol", ...)`（`entry.py:708`）；入参同时认**顶层平铺**与嵌套 `payload` 对象，顶层优先（`entry.py:719-721`，因为 `client.js` 按 `{requestId, action, ...payload}` 平铺发，`client.js:325`）；未知 action → `failure("engine-protocol", ...)`（`entry.py:724`）；`doctor` → `action_doctor`（`entry.py:727`）；`cancel` → `_cancelled_result`（入口侧 cancel 只用于「已受理但未开始」，立即回终态，`entry.py:728-732`）；`update` → `action_generate(..., is_update=True)`（`entry.py:733-734`）；其余 → `action_generate(is_update=False)`（`entry.py:735`）。
- `main()` — `entry.py:738`：`emit_hello()`（`entry.py:739`）→ 读一行 stdin（`entry.py:745`）→ 空行 → `failure("engine-protocol", "没有收到请求行")`（`entry.py:742`）→ `json.loads` 失败 → `failure("engine-protocol", ...)`（`entry.py:747`）→ `handle_request`（`entry.py:749`）→ `emit_result`（`entry.py:750`）。
- `__main__` 守卫（`entry.py:754-764`）：`KeyboardInterrupt`（被外层杀进程树）仍尽量回一条 `_cancelled_result`，让 Node 侧拿得到语义终态（`entry.py:757-763`）。

### 阶段映射（`stage_map.py`）

- `ENGINE_STAGES` — `stage_map.py:20-29`：引擎八段契约枚举 `['env','graph','cluster','articles','validate','index','baseline','commit']`。必须与 `contract.js:ENGINE_STAGES` 完全一致（测试双向对账，`stage_map.py:19`、`test-engine-python-entry.mjs:344`）。
- `FSOFT_STAGE_NAMES` — `stage_map.py:33-39`：FSoft 五段的镜像（1:Dependency Analysis … 5:Finalization）。
- `FSOFT_STAGE_WEIGHTS` — `stage_map.py:40-46`：五段权重 `0.40/0.20/0.30/0.05/0.05`，与 FSoft 一致以免进度条在阶段交界处跳变。
- `FSOFT_TO_ENGINE` — `stage_map.py:50-56`：五段 → 四段映射（1→graph、2→cluster、3→articles、4→validate、5→validate）。4/5 都落 validate（HTML 我们不做，finalization 算收口）。
- `DEFAULT_ENGINE_STAGE = "articles"` — `stage_map.py:60`：未知阶段归到 articles（耗时最长、最该让用户看见的阶段），不抛错（进度上报是旁路，`stage_map.py:58-59`）。
- `FSOFT_PROGRESS_CEILING = 90` — `stage_map.py:63`：引擎内部进度只占到 90%，剩下 10% 留给 Node 侧 index/baseline/commit 收尾，避免「引擎说 100% 但 wiki 还没提交」假完成（`stage_map.py:12-16`）。
- `map_stage(fsoft_stage)` — `stage_map.py:66`：FSoft 阶段号 → 引擎阶段名；非整数 → `DEFAULT_ENGINE_STAGE`（`stage_map.py:68-72`）。
- `percent_of(fsoft_stage, stage_progress)` — `stage_map.py:75`：计算整体百分数 0..90。算法与 FSoft `ProgressTracker.get_overall_progress` 同构（已完成阶段权重之和 + 当前阶段权重×阶段内进度）× CEILING，并夹紧到 [0,100]（`stage_map.py:78-92`）。自己再算一遍而不是调 tracker 方法，以便在不持有实例时（测试 / 日志回放）也能算。

## Architecture

`engine_python` 是 Node ↔ Python 跨语言边界里 Python 这一侧。整个模块只有两个文件，均位于 `lib/engine/python/`。下面框图给出进程内组件及与 Node 侧的接线关系（行号标注组件所在）。

```text
┌──────────────────────────── Node 侧 (lib/engine/client.js) ───────────────────────────┐
│  spawn(PY, [entry.py]) ──写一行请求 JSON──► stdin                                       │
│  read JSON-lines ◄── stdout(协议) ── stderr(日志)                                        │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                        │ 子进程
┌──────────────────── Python entry.py (sys.stdout 已被 _ProtocolOnly 接管) ───────────────┐
│                                                                                         │
│  main()  entry.py:738                                                                   │
│    └─ handle_request(msg)  entry.py:702   ┌─ doctor  ─► action_doctor  entry.py:237      │
│       (平铺+嵌套双认, entry.py:719)       │─ cancel  ─► _cancelled_result entry.py:679   │
│                                          ├─ generate/update ─► action_generate entry.py:438
│                                          │       └─ CLIDocumentationGenerator.generate() │
│ emit_hello / emit / emit_progress / emit_result  entry.py:150/143/154/170               │
│                                                                                         │
│  _model_config  entry.py:297  ◄── ENV CODEWIKI_BASE_URL/API_KEY/MAIN_MODEL/CLUSTER_MODEL │
│  bridge_progress entry.py:335  ──替换 adapter.progress_tracker 三方法──► emit_progress   │
│  _classify_exception entry.py:649  异常类型 → 契约错误码                                │
│  _count_docs / _state_files / _done_result / _cancelled_result  entry.py:392/583/615/679 │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                        │ import stage_map
┌──────────────────── stage_map.py (纯函数，无副作用) ───────────────────────────────────┐
│  map_stage()    stage_map.py:66       FSoft 阶段号 → 引擎八段名                          │
│  percent_of()   stage_map.py:75       五段权重×进度 ×CEILING(90) → 0..90                 │
│  ENGINE_STAGES  stage_map.py:20  ◄──与 contract.js:ENGINE_STAGES 双向对账                │
│  FSOFT_TO_ENGINE stage_map.py:50      1→graph 2→cluster 3→articles 4/5→validate         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

数据流之外，两处关键「自洽边界」值得点名：

- **stdout 守卫**：`_ProtocolOnly`（`entry.py:98`）在 `import codewiki` 之前就换上（`entry.py:14`），所有协议写经 `_REAL_STDOUT`（`entry.py:146`），其余改道 stderr——否则 FSoft 的 `print` / `click.secho` 会把人类文案塞进协议流。
- **UTF-8 三流钉死**：stdout/stderr 用 replace、stdin 用 strict（`entry.py:76-84`），并给 `subprocess.Popen.__init__` 打 UTF-8 补丁（`entry.py:85`、`entry.py:95`），解决 Windows locale（cp936/gbk）下中文路径 / `git` 输出乱码导致的「仓库路径不存在」与 `UnicodeDecodeError`。

## Data Flow

以一次 `generate` 动作为例，追踪一行请求从 Node 到 Python 再回到 Node 的全过程（所有行号来自 `entry.py` 与 `client.js`）：

1. **Node 发起**：`runEngine`（`client.js:223`）用 `spawnPlan`（`client.js:189`）起 `python entry.py`，写一行 `JSON.stringify({requestId, action, ...payload}) + "\n"` 到 stdin 并 `stdin.end()`（`client.js:325-326`）。`native-run.js:418-447` 在 `resolution===UPDATE` 时把 `action` 设成 `update`、并塞入 `repoPath` / `docsDir` / `updateOptions`(rung:3) / `commitId`。
2. **入口启动**：`main()`（`entry.py:738`）先 `emit_hello()`（`entry.py:739`，协议版本 1、engine=`fsoft-native`）。此时 stdout 已是 `_ProtocolOnly`（`entry.py:131`），FSoft 后续任何 `print` 只进 stderr。
3. **解析请求**：读一行 stdin → `json.loads`（`entry.py:744-745`）→ `handle_request`（`entry.py:702`）。入参双认平铺+嵌套（`entry.py:719-721`），action 不在 `ACTIONS` 则立即 `failure("engine-protocol")`（`entry.py:724`）。
4. **准备**：`action_generate`（`entry.py:438`）解析 `repoPath`/`docsDir`（`entry.py:444-445`）；`_model_config`（`entry.py:297`）从 `CODEWIKI_*` 环境变量取模型通道，缺项 → `failure("engine-model")`（`entry.py:452`）；`emit_progress(env, 100)`（`entry.py:454`）。
5. **跑 FSoft**：构造 `CLIDocumentationGenerator`（`entry.py:499-508`），`bridge_progress`（`entry.py:335`）替换其 `progress_tracker` 三方法；调 `adapter.generate()`（`entry.py:510`）。FSoft 每进一段，`start_stage`/`update_stage`/`complete_stage` 先调原方法再 `emit_progress`（`entry.py:359-382`），其中 `stage` 经 `map_stage`（`stage_map.py:66`）、`percent` 经 `percent_of`（`stage_map.py:75`，封顶 90）。
6. **终态**：
   - 正常完成 → `_count_docs` 清点页数（`entry.py:525`）→ `adapter.validate_generated_docs` 查缺页（`entry.py:528`）→ 缺页则 `partial`+`article-missing`（`entry.py:540-548`），否则 `_done_result`（`entry.py:550`）并填 `usage`（`entry.py:551-561`）。
   - `sys.exit(0)`（无变更）→ `_done_result`（`entry.py:516`）。
   - 其它异常 → `_classify_exception`（`entry.py:649`）按类型翻成 `engine-model` / `engine-missing` / `engine-crashed` 等。
7. **回写**：`emit_result(request_id, result)`（`entry.py:750` ⇒ `entry.py:170`）写一条 `result` 行到 `_REAL_STDOUT`。`main()` 返回 0（`entry.py:751`），进程退出码只表达进程层结果（`entry.py:31-35`）。
8. **Node 收口**：`client.js` 的 `createProtocolReader`（`client.js:39`）逐行解析，`result` 行经 `engineResult` 规整成 `EngineResult`（`client.js:115`、`client.js:275`）。`native-run.js` 据此做严格裁决：引擎 `done` 不能替代质量门（`native-run.js:543-566`），`partial`/`failed` 一律不推进基线（`native-run.js:112`、`native-run.js:11-16`）。

`done` 结果里两个跨轮关键字段的来路：

- `artifacts.stateFiles`（`entry.py:638`）= `_state_files(docs_dir)`（`entry.py:583`）：磁盘上真实存在的图/树/metadata/index 文件，**只报存在的不编造**，供 `native-run.js:623-631` 交叉校验。
- 顶层 `updateOutcome`（`entry.py:643`）= `_update_outcome_of(adapter)`（`entry.py:566`）：引擎 `update_record.outcome`（incremental/no_change/full_fallback/detector_failure/null）。`null` 表示这轮不是 update（全量），与「引擎说回退了」语义不同（`entry.py:640-643`），`native-run.js:146`、`native-run.js:544-547` 据此决定基线能不能推进。

## Connections

- [[engine-client]] — Node ↔ Python 薄适配层：`engine_python` 的进程与协议消费方。`runEngine`（`client.js:223`）起 `python entry.py`、读回 JSON-lines，`createProtocolReader`（`client.js:39`）逐行翻译成 `EngineResult` / `EngineProgress`。
- [[engine-contract]] — 跨进程结果契约（阶段 0）。`entry.py` 的 `failure` / `_done_result` / `_cancelled_result` 必须产出与 `contract.js:ENGINE_STAGES`（`contract.js:24`）、`UPDATE_OUTCOMES`（`contract.js:45`）、`BLOCKER_KINDS`（`contract.js:57`）同口径的对象；`stage_map.py:20` 的 `ENGINE_STAGES` 与之一字不差，由 `test-engine-python-entry.mjs:344` 双向对账。
- [[engine-native-run]] — 一次完整编译的编排。`runNativeJob`（`native-run.js:114`）决定 `generate`/`update`（`native-run.js:416-447`）、注入 `repoPath`/`docsDir`/`commitId`、消费入口返回的 `updateOutcome` 与 `stateFiles` 做严格裁决（`native-run.js:623-624`、`native-run.js:799-807`）。
- [[engine-llm-bridge]] — 宿主模型 loopback 桥。入口**绝不**读本机凭证库（`entry.py:23-29`），模型通道完全靠 `CODEWIKI_*` 环境变量（`entry.py:137-140`）由该桥注入，密钥只活在进程环境里。
- [[engine-process-tree]] — 受管子进程树终止。入口侧 `cancel` 只处理「已受理未开始」（`entry.py:728-732`），真正运行中取消由 Node 侧 `terminateProcessTree`（`process-tree.js:61`）整组杀掉，`__main__` 守卫（`entry.py:754-764`）尽量回一条 `cancelled` 让 Node 拿得到语义终态。
- [[engine-manifest]] — 引擎清单 / 指纹。`doctor` 动作（`entry.py:237`）产出的 `engine.version` / `python` / `deps` 被 `native-run.js:195-217` 的 probe 收集，喂给 `manifest.js:probeEnvironment`（`manifest.js:199`）算指纹、与落盘的 lock 比对。

## Known Issues

- **stdin 编码不能靠外部兜底**：入口自己把三条流钉成 UTF-8（`entry.py:57-65`），因为 `nativeEnginePlan` 派生的进程里的 `PYTHONUTF8`/`PYTHONIOENCODING` 只覆盖它自己，任何直接调入口的调用方（测试、诊断脚本）都会踩 Windows locale（cp936）下中文路径变乱码、`engine-missing` 的坑（`entry.py:50-61`、`test-engine-python-entry.mjs:157-184`）。这是已修复项，但属于易回归边界，改动需谨慎。
- **子进程 text 模式默认 UTF-8 补丁**：Windows 上 FSoft 内部 `subprocess.run(..., text=True)` 按 gbk 解码 `git` 输出会抛 `UnicodeDecodeError`（`entry.py:72-81`），已用 `_popen_init_utf8`（`entry.py:85`）兜底。**注意**：二进制调用（无 text）保持原样，否则会把 bytes 改成 str 破坏别人（`entry.py:87-88`）。该补丁依赖 `subprocess.Popen.__init__` 未被冻结，frozen 打包后可能失效（`entry.py:79-80` 注释已点名）。
- **docDir 丢失会自嵌套**：入参**只**认顶层平铺或显式 `payload` 对象（`entry.py:719-721`）。若只认 `msg["payload"]`，真引擎拿不到 `docsDir` 会回退写进 `repo/.codewiki`，增量轮把水合状态目录写回去，长出 `_native-state/docs/_native-state/docs/...` 自嵌套与重复页——假引擎测试因为按平铺读而永远碰不到（`entry.py:710-718`、`test-engine-python-entry.mjs:125-155`）。
- **FSoft 在「无变更」路径 `sys.exit(0)`**：`action_generate` 把 `SystemExit`（code==0）当正常终态而非失败（`entry.py:511-520`），与 `generate.py:640` 的退出行为强绑定；若上游改这个退出码语义，此处会误报 `engine-crashed`。
- **进度上限刻意压在 90%**：`FSOFT_PROGRESS_CEILING = 90`（`stage_map.py:63`）意味着进入 `validate`/`index`/`baseline`/`commit` 后进度条不再前进（这些由 Node 侧 `native-run.js` 推进，`native-run.js:9`）。若有人误以为引擎该报 100%，需看 `stage_map.py:12-16` 的解释。
- **`fallback_model` 必须显式给**：`_model_config` 强制 `fallback_model = model`（`entry.py:327`），否则 FSoft `create_fallback_models` 在 `None.lower()` 上 `AttributeError`（`entry.py:317-321`）。这是实测必崩点，不能「留空交给引擎默认」。
- **`pip check` 是运行时门禁**：`action_doctor` 在生成前跑 `pip check`（`entry.py:215-234`），装一半的 venv 会在生成中途才崩；doctor 不绕过、不修环境、不联网（`manifest.js:12-13`）。
- **`_state_files` / `_count_docs` 都按磁盘实况**：两者都不按白名单编造（`entry.py:584-591`、`entry.py:392-417`）。若引擎布局改了文件名（如 `module_tree.json`），上层 `native-run.js:557-560` 会记 `disagree` 但未报错——属于「可见但未强失败」的弱校验点。
