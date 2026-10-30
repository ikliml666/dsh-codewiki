---
title: fsoft_fixtures
type: module
source_files:
  - tools/fsoft-engine/fixtures/.gitignore
  - tools/fsoft-engine/fixtures/中文 空格 fixture/pyproject.toml
  - tools/fsoft-engine/fixtures/中文 空格 fixture/Dockerfile
  - tools/fsoft-engine/fixtures/中文 空格 fixture/scripts/run.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/core/engine.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/handler.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/task.ts
  - tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/summary.json
  - tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/component_index.json
  - tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/leaf_nodes.json
  - tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/languages.json
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/probe-no-llm-graph.result.json
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
  - tools/fsoft-engine/probe-generate.result.json
  - tools/fsoft-engine/probe-apply-real-cw.mjs
  - tools/fsoft-engine/probe-index-missing.mjs
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/constraints.txt
  - tools/fsoft-engine/locked-requirements.txt
  - tools/fsoft-engine/.gitignore
tags: [testing, fixtures, fsoft, dependency-graph, acceptance-probe]
---

## Overview

`fsoft_fixtures` 是「FSoft 原生引擎」迁移验收所用的**测试输入 fixture 与探针集合**，全部位于 `tools/fsoft-engine/`。它解决一个具体问题：把上游 FSoft 引擎（mraza007/codewiki 的 Python 实现，装在仓库外的 `.probe-fsoft/`）接入本插件时，需要一组**可复现、带中文/空格路径、且跨 Python+TypeScript 两种语言**的小仓库，来验收无 LLM 的静态依赖图（`handle_analyze_repo` / `DependencyGraphBuilder`）在中文空格路径下能正确建出组件、叶子节点、依赖边与 artifact。

模块分成两层：

- **`fixtures/中文 空格 fixture/`** —— 被入库的「可复现输入」。它是一个故意包含中文+空格目录名的微仓库：Python 的 `core` 引擎模块、`web` 薄壳 handler、一个 `task.ts`、一个 `Dockerfile`，以及一个作为 artifact 节点的 `scripts/run.py` 入口。`.gitignore`（tools/fsoft-engine/fixtures/.gitignore:2）刻意只忽略运行时产物（`docs/`、`docs2/`、`.codewiki/`），保证入库的只是源码与配置，fixture 是「输入」而非「某次跑出来的结果快照」。
- **探针与配套脚本** —— 在 `tools/fsoft-engine/` 顶层，用于驱动上面这个 fixture 跑通引擎侧验收：
  - `probe-no-llm-graph.py` —— 阶段 1A 引擎侧验收探针（无模型、无凭证），参数化为 `--fsoft-src / --fixture / --out`，跑 `handle_analyze_repo` 并校验 5 条判据 R1–R5（tools/fsoft-engine/probe-no-llm-graph.py:1）。
  - `probe-generate-with-fake-model.mjs` —— 用**假模型服务器**（固定 429 限流）驱动真实 FSoft `generate` 入口，验证五段进度被桥接成引擎八段协议行、且模型不可用被分类成 `engine-model`（tools/fsoft-engine/probe-generate-with-fake-model.mjs:1）。
  - `probe-apply-real-cw.mjs` / `probe-index-missing.mjs` —— 一次性探针，用真 `cw` 在临时目录跑 `applyNativeOutput`，验证产物落盘、提交范围、index/meta 正确性（tools/fsoft-engine/probe-apply-real-cw.mjs:1、tools/fsoft-engine/probe-index-missing.mjs:33）。
  - `setup-env.sh` —— 阶段 1A 环境构建脚本，把冻结清单按快照落盘（避免 openai/pydantic-ai 版本打架导致的 `ResolutionImpossible`），再 editable 安装 FSoft 引擎本体（tools/fsoft-engine/setup-env.sh:1）。
  - `constraints.txt` / `locked-requirements.txt` —— 依赖约束与已解析的冻结快照（156 / 163 行，tools/fsoft-engine/constraints.txt:1、tools/fsoft-engine/locked-requirements.txt:1）。

验收产物（如 `.codewiki/sessions/0ace1c6a91af/*` 与 `out-1a/`）是探针跑出来的**可重算结果**，按 `tools/fsoft-engine/.gitignore:1` 不入库；其中一份已落地的 `summary.json` / `component_index.json` 被保留作为 fixture 的样例数据，便于没有 FSoft 源码时也能直接读到依赖图长什么样。

## Key Components

### Fixture 输入：`fixtures/中文 空格 fixture/`

> 目录名本身含中文+空格，是刻意的：验收「中文/空格路径下 tree-sitter 分析与 artifact 采集不崩」。

**`pyproject.toml`**（tools/fsoft-engine/fixtures/中文 空格 fixture/pyproject.toml:1）
- 包名 `fixture-cn-space`，`version="0.0.1"`，`requires-python = ">=3.12"`（:5–9）。无运行时依赖，纯做被扫描目标。

**`Dockerfile`**（tools/fsoft-engine/fixtures/中文 空格 fixture/Dockerfile:1）
- `FROM python:3.12-slim`，`WORKDIR /app`，`COPY src ./src`、`COPY scripts ./scripts`，`CMD ["python", "scripts/run.py", "boot"]`（:1–6）。被依赖图识别为 `Dockerfile::Dockerfile` 节点，并反向依赖 `scripts/run.py::main`（见 `probe-no-llm-graph.result.json:94`）。

**`scripts/run.py`**（tools/fsoft-engine/fixtures/中文 空格 fixture/scripts/run.py:1）
- 模块 docstring 声明它是「artifact 类」入口，验证 artifact 节点是否被采集（:2）。
- `main(argv: list[str]) -> int`（:11）——构造 `Handler()`，打印 `handler.handle(" ".join(argv[1:]) or "ping")` 并返回 0（:12–14）。它是 fixture 里唯一的 artifact 节点（`scripts\run.py::main`，被 `probe-no-llm-graph.py:165` 的 R5 判据 `run.py` in `cid` 抓到）。
- `if __name__ == "__main__": raise SystemExit(main(sys.argv))`（:17–18）。

**`src/core/engine.py`**（tools/fsoft-engine/fixtures/中文 空格 fixture/src/core/engine.py:1）—— 阶段 1A 依赖图 fixture 的「核心引擎」模块，被 `web` 层依赖。
- `class Engine`（:6）——持有内部状态的最小引擎：
  - `__init__(self, name: str) -> None`（:9）——`self.name = name`、`self._calls = 0`（:10–11）。
  - `run(self, payload: str) -> str`（:13）——`self._calls += 1; return f"{self.name}:{payload}"`（:15–16）。
  - `@property calls(self) -> int`（:18–20）——返回 `self._calls`，统计调用次数。
- `build_engine(name: str = "default") -> Engine`（:23）——构造函数，web 层用它拿引擎（:24–25）。

**`src/web/handler.py`**（tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/handler.py:1）—— Web 层，依赖 `core.engine`，用于验证依赖边是否建出。
- `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))`（:8）——把 `src` 加入路径，使 `from core.engine import ...`（:10）能解析。
- `class Handler`（:13）——薄壳：
  - `__init__(self) -> None`（:16）——`self.engine: Engine = build_engine("web")`（:17）。
  - `handle(self, payload: str) -> str`（:19）——`return self.engine.run(payload)`（:20）。
- 依赖边由 analyzer 实建出：`Handler.__init__` → `build_engine` → `Engine`；`Handler.handle` → `Engine.run`（见 `probe-no-llm-graph.result.json:64` 与 :70）。

**`src/web/task.ts`**（tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/task.ts:1）—— TypeScript fixture，验证 TS/JS 分析器在中文空格路径下也能出节点。
- `interface TaskInput { id: string; payload: string }`（:3–6）。
- `normalize(input: TaskInput): TaskInput`（:8）——trim 后返回（:9–10）。
- `class TaskQueue`（:12）——`private items: TaskInput[] = []`（:13）；`push(input): number`（:15）调用 `normalize` 后入队并返回长度（:16–18）。
- 被分析出 `TaskInput`(interface)、`normalize`(function)、`TaskQueue`(class)、`TaskQueue.push`(method) 四类节点，`TaskQueue`/`TaskQueue.push` 均依赖 `TaskInput`（见 `probe-no-llm-graph.result.json:88`）。

### Fixture 样例数据：`.codewiki/sessions/0ace1c6a91af/`

> 这是 `probe-no-llm-graph.py` 在某次运行后落地的依赖图 JSON。注意路径分隔符是 Windows 反斜杠（`\`），这正是「中文/空格路径」验收点。

- **`summary.json`**（tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/summary.json:1）
  - 字段：`session_id`（:2，`"0ace1c6a91af"`）、`repo_name`（:3，`"中文 空格 fixture"`）、`repo_path`（:4）、`output_dir`（:5）、`total_components`（:6，`15`）、`total_leaf_nodes`（:7，`6`）、`languages`（:8–12，`{"python":9,"typescript":4,"null":2}`）、`leaf_nodes_preview`（:13–20，6 个叶子节点 id 列表）。
- **`component_index.json`**（tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/component_index.json:1）—— 组件数组，每个元素含 `id` / `type` / `file` 三字段（:2–6）。`type` 取值覆盖 `function` / `class` / `method` / `interface`（:4、:9、:14、:49）。共 15 个组件。
- **`leaf_nodes.json`**（tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/leaf_nodes.json:1）—— 叶子节点 id 数组（:1–8），含 `src\web\task.ts::TaskQueue`、`Dockerfile::Dockerfile`、`src\core\engine.py::Engine`、`pyproject.toml::pyproject.toml`、`src\web\handler.py::Handler`、`src\web\task.ts::TaskInput`。
- **`languages.json`**（tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/languages.json:1）—— `{"python":9,"typescript":4,"null":2}`（:1–5），与 `summary.json` 的 `languages` 同构。

### 探针 1：阶段 1A 无 LLM 依赖图验收 —— `probe-no-llm-graph.py`

- `DEFAULT_FIXTURE = HERE / "fixtures" / "中文 空格 fixture"`（:30）——默认被测小仓库。
- `parse_args(argv)`（:33）——argparse：`--fsoft-src`（必填，FSoft 源码根，其下须有 `codewiki/` 包，:35–39）、`--fixture`（默认仓库内 fixture，:40）、`--out`（默认 `HERE/out-1a`，:41）。
- `main(argv)`（:45）——主流程：
  - 前置校验：`--fsoft-src` 下须有 `codewiki/`（:51–53，否则退出码 3）；`--fixture` 须存在（:54–56，否则 3）。
  - `sys.path.insert(0, str(src_root))`（:58），构造 `out`。
  - 调用 `SessionStore()` 与 `handle_analyze_repo({repo_path, output_dir, use_gitignore:False}, store)`（:63–74），`json.loads` 解析（:75）。
  - **R1**（`R1_analyze_returned`，:79–81）：返回非 error JSON，且含 `session_id` 与 `files`。
  - **R2**（`R2_nodes_and_languages`，:90–98）：`total_components>0`、`total_leaf_nodes>0`，语言集合同时含 `python` 与 `typescript`。
  - **R4**（`R4_workspace_files`，:100–121）：`files` 里的 `component_index` / `leaf_nodes` / `summary` 三个路径真实存在且可解析。
  - **R3**（`R3_dependency_edge`，:123–162）：直接调 `DependencyGraphBuilder(cfg).build_dependency_graph()`（:124–139，构造 `Config` 时 `use_gitignore=False`、各 LLM 字段填 `not-needed`/`unused`，:127–138），遍历组件找「`engine` 在 deps 里且 `handler` 在 cid 里」的边（:143–152），退一步允许 handler 组件声明对 engine 的依赖（:156–161）。
  - **R5**（`R5_artifact_node`，:164–167）：`cid` 含 `run.py` 即视为 artifact 节点被采集。
  - 退出码：全过 `0`；判据未过 `2`；异常 `3`（:169–175）。
- 配套结果样例 `probe-no-llm-graph.result.json`（tools/fsoft-engine/probe-no-llm-graph.result.json:2）：`checks` 五条全 `true`、`ok:true`、`stats.total_components=15`、`total_leaf_nodes=6`、`edge_count=8`、`artifact_ids=["scripts\run.py::main"]`（:1–105）。

### 探针 2：协议桥接 + 错误分类 —— `probe-generate-with-fake-model.mjs`

- 起一个**固定 429 限流**的假模型 HTTP 服务器（:19–30），把 `CODEWIKI_BASE_URL` 指向它（:43）。
- 拉起真实 FSoft `lib/engine/python/entry.py` 子进程（:14、:35–47），喂一条 `action:"generate"` 请求（:49–54）。
- 逐行解析 stdout 的协议行（:56–68），统计 `progress` 与 stage 序列（:75–85）。
- 判据输出（:88–98）：`exitCode`、`protocolLines`、`nonJsonLines`、`progressCount`、`stages`、`outcome`、`errorCode`、`stderrTail`，写入 `probe-generate.result.json`（:98）。
- 配套结果样例 `probe-generate.result.json`（tools/fsoft-engine/probe-generate.result.json:1）：`exitCode=0`、`protocolLines=8`、`progressCount=6`、`stages=["env","graph","cluster","articles"]`、`outcome="failed"`、`errorCode="engine-model"`（:1–14）——证明「graph 段不碰 LLM 真能跑出」且「模型不可用被分类为 engine-model 而非崩栈」。

### 探针 3/4：真 `cw` 落地器验收 —— `probe-apply-real-cw.mjs` / `probe-index-missing.mjs`

- `probe-apply-real-cw.mjs`（tools/fsoft-engine/probe-apply-real-cw.mjs:1）——在临时 git 仓库里用真 `cw` 跑 `applyNativeOutput` + `verifyCommitScope`（:7、:39），核对 `_index.md`（含中文标题与冒号、`"核心: 引擎"` 的 YAML 安全，:23）无反斜杠残留、`_meta.yaml` 写基线（:51–55）、提交内容范围（:56–58）。
- `probe-index-missing.mjs`（tools/fsoft-engine/probe-index-missing.mjs:33）——构造一份 frontmatter 带 `title: 核心: 引擎`（裸值里 `: ` 会被 serde_yaml 解析成嵌套映射 → frontmatter 整篇失败，:21–22）的 report，喂 `applyNativeOutput`，验证「cw index 退出 0 但文章没进索引」会被落地器抓成 `index-failed`、并回滚盘上文件（:33–40）。
- 两者都 `import { applyNativeOutput }`（来自 `../../lib/engine/apply-plan.js`）。`probe-apply-real-cw.mjs` 跑完会 `fs.rmSync` 删掉临时 `root`/`docs`（:59）；`probe-index-missing.mjs` 因首行注释声明「跑完即删」但实际只在临时目录操作、未显式清理（:40 为末行日志）。

### 环境构建 —— `setup-env.sh`

- 阶段 1A 在**独立目录**造可信 FSoft 运行环境（tools/fsoft-engine/setup-env.sh:1）。用法 `bash tools/fsoft-engine/setup-env.sh <目标目录> <FSoft 源码根> [python]`（:15–16）。
- 关键约束：自由依赖树 openai/pydantic-ai/pydantic 版本打架，正常 `pip install` 必 `ResolutionImpossible`（:4–12），所以不重解析、按冻结快照落盘：
  - step1：`pip install --no-deps -c constraints.txt -r locked-requirements.txt`（:54–56）。
  - step2：editable 安装 FSoft 引擎本体（冻结快照不含 codewiki 自身，:58–62）。
  - step3/4：`pip check` 验证依赖闭合 + import 冒烟 `codewiki/openai/pydantic/tree_sitter/litellm/tiktoken`（:64–75）。
- `constraints.txt`（156 行）与 `locked-requirements.txt`（163 行）是同一份已解析环境的两种沉淀：前者是精确版本约束、后者是完整冻结清单（多 `mermaid-py`/`pythonmonkey`/`pyreadline3`/`win32_setctime`/`pminit`/`loguru` 等少数包，见两者 diff 于 `locked-requirements.txt:69,75,95,114,118,160` 等）。

## Architecture

模块是一个「输入 fixture + 驱动它的探针 + 复现它的环境」三层结构。组件 ≥3，画框图如下（组件名/文件标注于框内，箭头标注关系）：

```text
┌──────────────────────────────────────────────────────────────┐
│ fixtures/中文 空格 fixture/   (可复现输入，入库)                │
│  pyproject.toml / Dockerfile / scripts/run.py(artifact)        │
│  src/core/engine.py(Engine,build_engine)                       │
│  src/web/handler.py(Handler) ──dependsOn──► src/core/engine.py  │
│  src/web/task.ts(TaskInput,normalize,TaskQueue)                │
└───────────────┬──────────────────────────────────────────────┘
                │  run.py --fsoft-src / --fixture / --out
                ▼
┌──────────────────────────────────────────────────────────────┐
│ probe-no-llm-graph.py  (R1..R5 验收无 LLM 依赖图)              │
│  handle_analyze_repo + DependencyGraphBuilder → components/edges│
│  → out-1a/ 或 .codewiki/sessions/<id>/*.json (R4 工作区文件)   │
└───────────────┬──────────────────────────────────────────────┘
                │ 驱动真实引擎（可选项）
                ▼
┌────────────────────────────┐   ┌────────────────────────────┐
│ probe-generate-with-       │   │ probe-apply-real-cw.mjs /  │
│ fake-model.mjs             │   │ probe-index-missing.mjs    │
│ (假模型429→engine-model)   │   │ (真cw→applyNativeOutput)   │
└───────────────┬────────────┘   └─────────────┬──────────────┘
                │                                │
                ▼                                ▼
┌──────────────────────────────────────────────────────────────┐
│ setup-env.sh + constraints.txt + locked-requirements.txt      │
│ (在 .probe-fsoft/ 外建 venv：--no-deps 冻结快照 + editable 装  │
│  codewiki 本体 + pip check + import 冒烟)                     │
└──────────────────────────────────────────────────────────────┘
```

要点：
- fixture 是**被扫描目标**，本身不含任何测试逻辑；探针从外部用 `--fsoft-src` 指向仓库外的 FSoft 源码来跑它（probe-no-llm-graph.py:40、:63）。
- `probe-no-llm-graph.py` 是引擎侧验收主入口（无模型、无凭证），它同时调用 MCP 层 `handle_analyze_repo` 与 builder 层 `DependencyGraphBuilder` 两条路径来交叉验证 R1/R4 与 R3（:63–64、:124–139）。
- 探针 2（`probe-generate-with-fake-model.mjs`）与探针 3/4 在**有** FSoft 环境时才会真跑；它们分别验证「协议桥接」与「真 `cw` 落地器」，属于 1B/1C 阶段，与 1A 的纯静态图验收解耦。

## Data Flow

**fixture → 依赖图（阶段 1A，纯静态、无 LLM）**

1. `probe-no-llm-graph.py --fsoft-src <FSoft根> --fixture fixtures/中文\ 空格\ fixture --out out-1a`（:45）启动。
2. 调用 MCP 层 `handle_analyze_repo({"repo_path": fixture, "output_dir": out, "use_gitignore": False}, store)`，返回 JSON（payload）含 `session_id` / `files` / `stats`（:67–75）。`stats` 给出 `total_components=15`、`total_leaf_nodes=6`、`languages={python:9, typescript:4, null:2}`（见 `probe-no-llm-graph.result.json:23`）。
3. 直接用 builder 层 `DependencyGraphBuilder(cfg).build_dependency_graph()` 拿 `components`（含 `dependsOn` 边）与 `leaf_nodes`（:139），验证 `web.handler → core.engine` 依赖边（R3）与 `run.py` artifact 节点（R5）。
4. 工作区文件（`component_index.json` / `leaf_nodes.json` / `summary.json`）由 `files` 字段给出的路径落地，探针 R4 校验它们存在且可 JSON 解析（:101–121）。
5. 产物写 stdout JSON + 退出码；`out-1a/`（tools/fsoft-engine/.gitignore:2）与 `.codewiki/`（fixtures/.gitignore:4）按 .gitignore **不入库**，仅样例 `sessions/0ace1c6a91af/*` 被保留作静态样例。

**fixture → 引擎生成（探针 2，需 FSoft 环境）**

1. `probe-generate-with-fake-model.mjs` 起固定 429 的假模型服务器（:19–30），把 `CODEWIKI_BASE_URL` 注入子进程环境（:43）。
2. spawn `lib/engine/python/entry.py` 跑 `action:"generate"`（:35–54），逐行解析 stdout 协议行（:56–68）。
3. 产出 `probe-generate.result.json`：`stages=["env","graph","cluster","articles"]`、`outcome="failed"`、`errorCode="engine-model"`（:1–14）——证明 graph 段无需 LLM 即跑通，且模型不可用被归类为 `engine-model`。

**fixture 产物 → 真 cw 落地（探针 3/4）**

1. `probe-apply-real-cw.mjs` 在临时 git 仓库用真 `cw` 调 `applyNativeOutput` + `verifyCommitScope`（:39、:58），核对 `_index.md` / `_meta.yaml` / 提交范围（:51–58）。
2. `probe-index-missing.mjs` 构造 frontmatter 含 `title: 核心: 引擎`（裸 `: ` 触发 serde_yaml 嵌套映射解析失败，:21–22）的 report，喂 `applyNativeOutput`，验证盘上文章/入口/`_index.md` 被正确回滚、问题被记为 `index-failed`（:33–40）。

## Connections

- [[engine_python]] — 探针 2 拉起的真实引擎入口 `lib/engine/python/entry.py`、`applyNativeOutput` 来自 `lib/engine/apply-plan.js`（probe-apply-real-cw.mjs:7、probe-index-missing.mjs:7）；FSoft 引擎本体的 editable 安装由 `setup-env.sh` 完成。
- [[engine_apply]] — `probe-apply-real-cw.mjs` / `probe-index-missing.mjs` 验证的 `applyNativeOutput` / `verifyCommitScope` 落盘与提交范围逻辑；`index-failed` 兜底即在此模块落地。
- [[engine_core]] — 阶段 1A 验收的 `handle_analyze_repo` 与 `DependencyGraphBuilder` 来自 FSoft 引擎核心（`probe-no-llm-graph.py:63–64、:124–139`）；`Config` 构造（`use_gitignore`、LLM 字段占位）见 `:127–138`。
- [[symbol_extraction]] — fixture 的 `task.ts` / `engine.py` / `handler.py` 依赖 tree-sitter 静态分析出组件与叶子节点；`tree_sitter`/`tree-sitter-python`/`tree-sitter-typescript` 在 `locked-requirements.txt:137,141,145` 钉死。
- [[graph_diff]] — 依赖图组件/叶子节点/边的 JSON 形态（`component_index.json` / `leaf_nodes.json` / `summary.json`）与图 diff 产物同源；`out-1a/` 即依赖图工作区。
- [[root]] — 本插件根 `CodeWiki.md` 描述了 FSoft 引擎接入的整体阶段（1A 静态图 → 1B 模型链路 → 1C artifact 链路），本模块对应 1A 验收与探针。
- [[codewiki-upstream]] — FSoft 引擎源自上游 mraza007/codewiki（Python 实现），与本插件 Rust `cw` 是两套体系；本模块在仓库外 `.probe-fsoft/` 装的就是这套 Python 引擎。

## Known Issues

- **Windows 反斜杠路径污染 fixture 样例数据**：样例 `summary.json` / `component_index.json` / `leaf_nodes.json` 里的 `id` 与文件路径用的是 `\`（如 `src\core\engine.py::Engine`，见 `component_index.json:8`），且 `repo_path` 带 `E:\...` 绝对盘符（summary.json:4）。这些是某次 Windows 上跑 `probe-no-llm-graph.py` 的产物。跨平台消费时必须先归一化为 `/`（上游 `cw` 也有反斜杠输出，参见 `CodeWiki.md` 已知问题中「上游 stale 文章路径输出为反斜杠」一条）。源码内 `probe-no-llm-graph.py` 的判据（:151、:158）直接用 `"engine" in joined` 与 `"run.py" in cid` 子串匹配，正是为了容忍这种分隔符差异。
- **`languages` 出现 `"null": 2`**：样例中 `languages={"python":9,"typescript":4,"null":2}`（languages.json:4），说明有 2 个节点（如 `Dockerfile::Dockerfile`、`pyproject.toml::pyproject.toml`）无法识别语言、被归为 `null`。这是 analyzer 对无语言归属文件的正常归类，但消费侧（如按语言分组）需显式处理 `null` 键，否则会漏掉这两类 artifact/config 节点。
- **fixture 样例是静态快照、非权威**：`.codewiki/sessions/0ace1c6a91af/*` 是一次运行的产物，不被 `.gitignore` 忽略（fixtures/.gitignore:4 只忽略 `.codewiki/`，但 `sessions/` 子目录下的具体 session 没单独列出），所以这份样例会随提交漂移。要取得权威结果应重跑 `probe-no-llm-graph.py` 指向当前 FSoft 源码（`--fsoft-src`）。
- **`setup-env.sh` 仅支持类 Unix shell**：脚本用 `bash`、`"$@"` 与 venv 路径分支（bin/python vs Scripts/python.exe，setup-env.sh:47–51），Windows 下需走 Git Bash / WSL；且它只在仓库**之外**建环境、不把 venv 提进 git（:18），依赖 `.probe-fsoft/` 已存在（见 `.probe-fsoft/probe-home/`）。
- **探针脚本非产品代码、不进 CI 默认路径**：`probe-generate-with-fake-model.mjs` 注释明确「不属于产品代码」（:1），且依赖仓库外 `.probe-fsoft/venv/Scripts/python.exe` 与 `.probe-fsoft/wiki_out_entry2` 等具象路径（:14、:16），换机需先跑 `setup-env.sh` 重建环境，否则这些绝对路径不存在。
- **`R3` 判据对组件 id 命名敏感**：`probe-no-llm-graph.py` 依赖 `"handler" in cid` 且 `"engine" in deps` 子串匹配（:151、:158），若 FSoft 改了组件 id 命名规则（如去掉 `::`、改小写），该判据会误报失败，需要同步更新子串关键字。
- **`out-1a/` 与 `.codewiki/` 的产物不入库但会被误扫**：`tools/fsoft-engine/.gitignore:2` 忽略 `out-*/`，`fixtures/.gitignore:4` 忽略 `.codewiki/`；若有人手动跑探针却未删，这些临时依赖图/文档不应进 review，靠 .gitignore 兜底。
