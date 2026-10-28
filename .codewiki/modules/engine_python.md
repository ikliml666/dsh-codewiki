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
  - lib/engine/llm-bridge.js
tags: [engine, python, fsoft-native, entrypoint, protocol, stage-mapping]
---

## Overview

`engine_python` 是 dsh-codewiki 迁移到 FSoft 原生引擎后，**唯一一处手写的 Python**，充当
Node 侧与 FSoft（codewiki）之间的 JSON-lines 薄入口。它位于 `lib/engine/python/entry.py`，
配套一个无副作用的纯映射表 `lib/engine/python/stage_map.py`。

整个模块的哲学是「**不是算法实现**」：依赖图、模块聚类、文章写作、增量 diff 全部由 FSoft 的
`CLIDocumentationGenerator` 完成，本入口只做四件事（见 `entry.py:1-36` 的模块 docstring）：

1. 把 stdin 的一行 JSON 请求变成一次 FSoft 调用（`doctor` / `generate` / `update` / `cancel`）；
2. 把 FSoft 的五段进度翻译成引擎八段契约（`stage_map.py`），以 JSON 行推给 Node；
3. 把成功 / 失败 / 取消翻译成 `EngineResult`（与 `lib/engine/contract.js` 同一份语义）；
4. 守住两条红线：**不读本机凭证库**、**不让 FSoft 的打印污染协议流**。

入口进程由 Node 侧的 `lib/engine/client.js`（`runEngine`）启动：client 写一行
`{requestId, action, ...payload}` 到 stdin 并关闭它，然后逐行读回 JSON-lines 协议消息
（`hello` → 若干 `progress` → `result`）。模型通道由 `lib/engine/llm-bridge.js` 的
loopback 桥注入成进程环境变量（`CODEWIKI_BASE_URL` / `CODEWIKI_API_KEY` 等），密钥只活
在进程环境里，绝不落盘。

## Key Components

文件 `lib/engine/python/entry.py`（共 604 行）与 `lib/engine/python/stage_map.py`（共 98 行）。

### entry.py — 模块级常量

| 名称 | 行号 | 用途 |
| --- | --- | --- |
| `_REAL_STDOUT` | `entry.py:48` | 替换 stdout 之前保存下来的真实 stdout 句柄，协议行走它写出 |
| `PROTOCOL_VERSION` | `entry.py:94` | 协议版本，固定为 `1`（`emit_hello` 上报） |
| `ACTIONS` | `entry.py:95` | 登记的四个动作：`("doctor", "generate", "update", "cancel")` |
| `ENV_BASE_URL` | `entry.py:98` | 模型通道环境变量名 `CODEWIKI_BASE_URL` |
| `ENV_API_KEY` | `entry.py:99` | 模型通道环境变量名 `CODEWIKI_API_KEY` |
| `ENV_MAIN_MODEL` | `entry.py:100` | 模型通道环境变量名 `CODEWIKI_MAIN_MODEL` |
| `ENV_CLUSTER_MODEL` | `entry.py:101` | 模型通道环境变量名 `CODEWIKI_CLUSTER_MODEL` |

### entry.py — 协议流守卫类 `_ProtocolOnly`

在**导入任何 codewiki 模块之前**（`entry.py:92` `sys.stdout = _ProtocolOnly()`）安装。
原因见 `entry.py:12-21`：FSoft 用 `print`/`click.secho`/`print_banner` 往 stdout 写人类文案，
而 click 会缓存 text stdout 包装器，事后替换拦不住已缓存的引用，所以必须提前接管。

方法（定义区间 `entry.py:59-90`）：

- `write(self, text)` — `entry.py:66`：普通写入全部改道 `sys.stderr`（变成日志），返回 `len(text)`。
- `flush(self)` — `entry.py:74`：把 flush 也转给 stderr，避免 FSoft 进度条 flush 把半行日志挤进协议流。
- `isatty(self)` — `entry.py:80`：返回 `False`。
- `fileno(self)` — `entry.py:83`：返回 `sys.stderr.fileno()`，避免某些库拿 fileno 判断终端时抛错。
- `encoding` 属性 — `entry.py:87`：返回 `"utf-8"`。

### entry.py — 协议写出函数

- `emit(obj)` — `entry.py:104-108`：把所有协议消息经 `_REAL_STDOUT` 写一行 JSON（`ensure_ascii=False`）+ 换行并 flush。
- `emit_hello()` — `entry.py:111-112`：发出 `{"type":"hello","protocolVersion":PROTOCOL_VERSION,"engine":"fsoft-native"}`。
- `emit_progress(request_id, stage, percent, message, written, failed, total)` — `entry.py:115-128`：发出一条 `progress` 行，含 `contractVersion:1`、`stage`、`percent`、`message`、`writtenCount`、`failedCount`、`totalCount`。
- `emit_result(request_id, result)` — `entry.py:131-132`：发出 `{"type":"result","requestId":...,"result":...}`。
- `failure(code, message, stage, request_id)` — `entry.py:135-153`：构造一个 `failed` 终态（outcome=`failed`），`message` 只放给人看的说明，绝不拼凭证内容；返回完整 `EngineResult` 形状（含空 `usage`/`engine`/`artifacts`）。

### entry.py — doctor（环境可信性）

- `_engine_version()` — `entry.py:159-173`：先 `import codewiki` 取 `__version__`，失败再退回 `importlib.metadata.version("codewiki")`。
- `_pip_check(timeout=120)` — `entry.py:176-195`：跑 `python -m pip check`，返回 `(ok, 摘要)`；探测失败如实上报而非吞掉。这是「1A 门禁」的运行时版本检查。
- `action_doctor(request_id, payload)` — `entry.py:198-237`：发 `env` 阶段进度，取版本与 `pip check`，返回 `done` 终态（含 `engine.deps.ok/summary`）；缺 codewiki 报 `engine-missing`、依赖未闭合报 `engine-deps`。

### entry.py — 模型通道

- `_model_config()` — `entry.py:243-275`：从进程环境读四个变量；缺任何一项返回 `(None, 原因)`，错误信息里只说「环境变量」不打印值（防密钥被写进 job 日志）。返回 config dict 含 `base_url`/`api_key`/`main_model`/`cluster_model`/`fallback_model`(=main)/`provider:"openai-compatible"`。注意 `fallback_model` 必须显式给（`entry.py:263-267` 注释说明缺省会崩在 graph 阶段开头）。

### entry.py — 进度桥接

- `bridge_progress(adapter, request_id, on_stage=None)` — `entry.py:281-332`：替换 `adapter.progress_tracker` 的 `start_stage`/`update_stage`/`complete_stage` 三个方法（`entry.py:294-332`），旁路把 FSoft 事件转成协议 `progress` 行（用 `stage_map.map_stage`/`percent_of`）。`on_stage` 收到每个到达的引擎阶段，供调用方记录「最后一个真实到达的阶段」（`entry.py:301-303`）。用替换而非继承，因为 `CLIDocumentationGenerator.__init__` 直接 `ProgressTracker(total_stages=5)` 没有注入点（`entry.py:284-287`）。

### entry.py — generate / update

- `_count_docs(docs_dir)` — `entry.py:338-363`：**递归** `rglob("*.md")` 清点产物页数，排除 `.` 开头目录与 `temp/`（`entry.py:351-355`）。只 glob 根层会漏掉 hierarchical 布局的子目录页，造成「1 篇成功 + 19 篇失败也报 done」那类误判。
- `_git_commit(repo_path)` — `entry.py:366-381`：`git rev-parse HEAD`，超时 15s，失败返回 `""`。
- `action_generate(request_id, payload, is_update=False)` — `entry.py:384-472`：跑一次 FSoft 生成/增量更新。解析 `repoPath`/`docsDir`（默认 `repoPath/.codewiki`），校验目录，调 `_model_config`，构造 config（含 `max_tokens=32768`、`max_depth=2`、`request_limit=100`、`agent_retries=3`、`use_gitignore=True`、`prompt_caching=True` 等，`entry.py:390-399`），构造 `CLIDocumentationGenerator`（`entry.py:420-429`）并 `bridge_progress`，`adapter.generate()`。捕获：`SystemExit`（`entry.py:432-438`，code 0 视为正常终态、非 0 报 `engine-crashed`）、一般异常转 `_classify_exception`。生成后 `_count_docs` + `validate_generated_docs`（`entry.py:444-448`），缺失则 `partial` + `article-missing` blockers；否则 `_done_result` 并填 `usage`（从 `job.statistics.usage_totals` 读，`entry.py:461-471`）。
- `_done_result(request_id, docs_dir, repo_path, started, written=0, stage="articles")` — `entry.py:475-496`：构造 `done` 终态，含 `engine`（`_engine_version`/`_git_commit`/`python`）、`artifacts`（`docsDir`/`rawTreeDir=module_tree.json`/`updateRecord=update_record.json`）、时间戳。
- `_classify_exception(exc, request_id, docs_dir, repo_path, started, stage="articles")` — `entry.py:499-526`：按**异常类型**分类（而非消息文本）：`IncompleteGenerationError`/`IncompleteDocumentationError` → `partial`+`article-missing`；`*APIError`/`ConfigurationError` → `engine-model`；`RepositoryError` → `engine-missing`(stage `graph`)；`KeyboardInterrupt` → `_cancelled_result`；其余 → `engine-crashed`。
- `_cancelled_result(request_id, written=0, stage="articles")` — `entry.py:529-546`：构造 `cancelled` 终态，blockers = `[{kind:"cancelled",...}]`，时间为 `null`。

### entry.py — 主循环

- `handle_request(msg)` — `entry.py:552-574`：校验请求为 dict、含 `requestId`、action 在 `ACTIONS`，按 action 分派 `action_doctor`/`action_generate(is_update)`/`_cancelled_result`（`cancel` 立即回 cancelled，不做实际工作，`entry.py:567-571`）。任何路径都返回 `(requestId, result)`。
- `main()` — `entry.py:577-590`：`emit_hello()` 后读**一行** stdin（`sys.stdin.readline`），非法/空 JSON 回 `engine-protocol` 失败，否则 `handle_request` 并 `emit_result`。
- `__main__` 守卫 — `entry.py:593-603`：捕获 `KeyboardInterrupt`，尽量回一条 `_cancelled_result("")` 再退出，让 Node 侧拿得到语义终态而不是只看 exit code。

### stage_map.py — 阶段映射（纯函数，无副作用）

| 名称 | 行号 | 用途 |
| --- | --- | --- |
| `ENGINE_STAGES` | `stage_map.py:20-29` | 引擎八段契约枚举，必须与 `lib/engine/contract.js:24-33` 的 `ENGINE_STAGES` 同集合（测试双向对账） |
| `FSOFT_STAGE_NAMES` | `stage_map.py:33-39` | FSoft `ProgressTracker` 五段名（1 依赖分析 / 2 聚类 / 3 文档生成 / 4 HTML / 5 收尾）的镜像 |
| `FSOFT_STAGE_WEIGHTS` | `stage_map.py:40-46` | 五段权重（0.40/0.20/0.30/0.05/0.05），与 FSoft 保持一致以防进度条跳变 |
| `FSOFT_TO_ENGINE` | `stage_map.py:50-56` | 五段→四段映射：1→graph、2→cluster、3→articles、4/5→validate |
| `DEFAULT_ENGINE_STAGE` | `stage_map.py:60` | 未知阶段归到 `"articles"`（耗时最长、最该让用户看见的阶段） |
| `FSOFT_PROGRESS_CEILING` | `stage_map.py:63` | 引擎内部进度上限 `90`（剩下 10% 留给 Node 侧 index/baseline/commit） |

- `map_stage(fsoft_stage)` — `stage_map.py:66-72`：FSoft 阶段号 → 引擎契约阶段名；非整数或未知归 `DEFAULT_ENGINE_STAGE`，**不抛错**（进度上报是旁路）。
- `percent_of(fsoft_stage, stage_progress)` — `stage_map.py:75-97`：FSoft `(阶段号, 阶段内进度 0..1)` → 整体百分数 0..90。与 FSoft `ProgressTracker.get_overall_progress` 同构（已完成阶段权重之和 + 当前阶段权重×阶段内进度），再乘 `CEILING` 并夹到 `[0,100]`；非法输入夹紧为 0。在**不持有 tracker 实例**时也能算（测试与日志回放要用）。

## Architecture

`engine_python` 是跨语言边界中的「Python 半边」。Node 侧的 `client.js`（`runEngine`）是
唯一调用者，它 spawn 出 `entry.py` 子进程、喂一行请求、读回 JSON-lines。模型流量经
`llm-bridge.js` 的 loopback 桥（127.0.0.1 + 随机端口 + 占位 key）被 FSoft 的 OpenAI 客户端
调到，密钥只活在该进程环境里。

```text
┌──────────────────────── lib/engine/client.js ────────────────────────┐
│ runEngine(): spawn 子进程, 写一行 {requestId,action,payload} 到 stdin  │
│           │ 读回 JSON-lines (hello/progress/result)                  │
│           ▼                                                          │
│   createProtocolReader  ←─ stdout ──┐   terminateProcessTree (取消)  │
└───────────┬────────────────────────┘                                │
            │ spawn(python entry.py)                                   │
            ▼                                                          │
┌───────── lib/engine/python/entry.py (fsoft-native) ─────────────────┐
│ _ProtocolOnly 接管 sys.stdout（先装，拦 FSoft 打印污染协议流）      │
│ handle_request → action_doctor / action_generate / _cancelled_result │
│ action_generate: _model_config() → CLIDocumentationGenerator        │
│   bridge_progress(): 替换 progress_tracker 三方法                    │
│     └─► stage_map.map_stage / percent_of (FSoft 5段→契约8段, ≤90%)   │
│   emit_progress / emit_result 经 _REAL_STDOUT 写真 stdout           │
└───────────┬─────────────────────────────────────────────────────────┘
            │ import codewiki
            ▼
┌──────────── FSoft codewiki (CLIDocumentationGenerator) ─────────────┐
│ 依赖图 / 模块聚类 / agentic 文章写作 / 增量 diff / validate          │
└─────────────────────────────────────────────────────────────────────┘

模型通道（不落盘，仅进程环境）:
  llm-bridge.js (loopback 127.0.0.1:random) ──注入──► env CODEWIKI_BASE_URL/API_KEY/MAIN_MODEL
        ▲  FSoft OpenAI 客户端 (占位 key dsh-bridge-*) 打过来
        │
   宿主 llm.stream（真实凭证只在这里，桥看不见）
```

组件 ≥3 且存在跨进程/跨语言编排，故画框图如上。框内标注文件名/类，箭头标注关系。

## Data Flow

一次 `generate` 请求的端到端流转（行号以源码为准）：

1. **启动与握手**：`client.js:288` spawn `python entry.py`，`client.js:325` 写一行
   `{requestId, action, ...payload}\n` 到 stdin 并 `end()`。`entry.py:520` `main()` 先 `emit_hello()`
   （`entry.py:112`），client 经 `createProtocolReader` 校验 `protocolVersion`（`client.js:74-79`）。
2. **stdout 接管**：`entry.py:92` 在 import codewiki 之前把 `sys.stdout` 换成 `_ProtocolOnly`，
   之后 FSoft 的任何 `print` 都改道 stderr（`entry.py:14-19`），协议行走 `_REAL_STDOUT`（`entry.py:48`）。
3. **模型通道**：`entry.py:243` `_model_config()` 从环境变量读 `CODEWIKI_*`，缺一项即
   `failure("engine-model", ...)`（`entry.py:397-398`）。这些变量由 `llm-bridge.js:233` 返回的
   `url` 与 `placeholderKey` 在启动子进程时被注入进程环境（Node 侧编排）。
4. **生成**：`entry.py:420-429` 构造 `CLIDocumentationGenerator` 并 `bridge_progress`
   （`entry.py:430`），`entry.py:431` 调 `adapter.generate()`。
5. **进度回传**：FSoft 每动一个阶段，`bridge_progress` 替换的方法（`entry.py:305-328`）把
   FSoft 阶段号经 `stage_map.map_stage`（`stage_map.py:66`）与 `percent_of`（`stage_map.py:75`）
   翻成契约 `stage` 与 0..90 百分数，经 `emit_progress`（`entry.py:115`）推给 Node。
6. **终态**：成功走 `_done_result`（`entry.py:475`）+ `_count_docs`（`entry.py:338`）+ 用量
   （`entry.py:461-471`，取自 `job.statistics.usage_totals`）；缺页走 `partial`
   （`entry.py:449-457` 或 `_classify_exception`）；异常被分类成 `engine-model`/`engine-missing`/
   `engine-crashed`（`entry.py:499-526`）；取消走 `_cancelled_result`（`entry.py:529`）。
7. **收尾**：`entry.py:131` `emit_result` 写出最后一条 `result` 行；client 的 `finish`
   （`client.js:253-272`）把它归一成 `EngineResult`，附 `protocolViolations`/`exitCode`/`stderrTail`/
   `durationMs`。退出码只表达进程层结果，语义以 `result` 为准（`client.js:17-18`、`entry.py:31-35`）。

注意：FSoft 只覆盖契约八段中的前四段（`graph`/`cluster`/`articles`/`validate`，
`stage_map.py:12-16`），进度上限 90%；`index`/`baseline`/`commit` 由 Node 侧后续执行（阶段 3-7），
`env` 由 doctor 承担。

## Connections

- [[engine-contract]]：Python 终态与 `EngineResult`/`EngineProgress`/`EngineError` 字段完全对齐
  （`entry.py:135` 的 `failure`、`entry.py:475` 的 `_done_result` 字段形状与 `contract.js:97`
  `engineResult` 校验一致；`stage_map.py:20` 的 `ENGINE_STAGES` 与 `contract.js:24-33` 同集合，
  由 `test-engine-python-entry.mjs:236-247` 双向对账）。
- [[engine-client]]：唯一的进程 + 协议调用方，`runEngine`（`client.js:223`）spawn 本入口、
  读 JSON-lines、`createProtocolReader`（`client.js:39`）逐行解析、`terminateProcessTree`
  取消时打整棵子进程树（`client.js:331`）。
- [[engine-process-tree]]：取消语义的地基——FSoft 会派生子进程（flake8/find/后端 fork），
  只 kill 直接子进程会留孤儿烧 token，故 client 用 `terminateProcessTree` 整树打掉
  （`entry.py:567-571` 的 cancel 注释也指向它）。
- [[engine-llm-bridge]]：模型通道的来源。loopback 桥把宿主 `llm.stream` 暴露成
  `http://127.0.0.1:<port>/v1`，并把 `url`/`placeholderKey` 注入成 `CODEWIKI_*` 环境变量
  （`llm-bridge.js:233`），本入口在 `_model_config`（`entry.py:243`）里读取；凭证只活在进程环境，
  绝不落盘（与 `entry.py:23-29`、`llm-bridge.js:6-17` 的红线一致）。
- [[engine-quality-gate]] / [[engine-output]]：本入口只把 docs 树交回（落在 `.codewiki/`），
  产物自洽判读与「能不能被 wiki 采用」的质量门在 Node 侧阶段 3 完成，不在 Python 这边。
- [[engine-manifest]]：1A 依赖锁定的证据来源（doctor 的 `pip check` 是运行时版本门禁，
  `entry.py:176-195`）。

## Known Issues

- **stdout 必须在 import codewiki 之前接管**：如果 `_ProtocolOnly`（`entry.py:92`）安装得晚于
  任何 codewiki 模块导入，click 已缓存的 text stdout 包装器会把 FSoft 打印挤进协议流
  （`entry.py:16-21`），破坏 `client.js` 的 `not-json` 不变量。已在模块 docstring 与代码里钉死顺序。
- **`fallback_model` 必须显式给**：`entry.py:263-267` 注释指出，若 adapter 的 `fallback_model`
  为 `None`，FSoft 的 `create_fallback_models` 会在 `model_name.lower()` 上抛 `AttributeError`，
  崩在 graph 阶段开头，表现为 `engine-crashed` 而非可理解的模型错误。本入口固定把
  `fallback_model` 设为与 `main_model` 相同（`entry.py:271`）。
- **`SystemExit(0)` 被当作正常终态**：FSoft 在「无变更」等路径会 `sys.exit(0)`（`entry.py:433`），
  这不是失败；增量更新时「没有要改的」是正常终态，故 `code==0` 走 `_done_result`（`entry.py:436-437`），
  非 0 才报 `engine-crashed`。
- **`_count_docs` 必须递归**：只 glob 根层会把 hierarchical 布局的子目录页漏掉，曾造成
  「1 篇成功 + 19 篇失败也报 done」的误判（`entry.py:338-347`）。已排除 `.`/开头目录与 `temp/`。
- **进度上限压在 90%**：`stage_map.py:63` `FSOFT_PROGRESS_CEILING = 90`，刻意不报 100%，
  留给 Node 侧 `index`/`baseline`/`commit`。若未来 Node 侧不执行这三段，面板会停在 90% 而非 100%。
- **`cancel` 在 Python 侧只是「受理但未开始」**：真正取消由 Node 侧 `terminateProcessTree`
  杀进程树（`entry.py:567-571`）；入口这一侧 cancel 立即回 `_cancelled_result`，不做实际工作。
- **凭证红线**：`_model_config`（`entry.py:243`）与 `failure`（`entry.py:135`）刻意只说「环境变量」
  不打印值，且本入口绕开 `ConfigManager`（不会读 `~/.codewiki/config.json` 或 keyring，
  `entry.py:23-29`），避免密钥被写进 job 日志或落盘。
