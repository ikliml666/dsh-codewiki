---
title: tools_fsoft_fixtures
type: module
source_files:
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/core/engine.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/handler.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/task.ts
  - tools/fsoft-engine/fixtures/中文 空格 fixture/scripts/run.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/pyproject.toml
  - tools/fsoft-engine/fixtures/中文 空格 fixture/Dockerfile
  - tools/fsoft-engine/fixtures/.gitignore
  - tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/constraints.txt
  - tools/fsoft-engine/locked-requirements.txt
  - tools/fsoft-engine/.gitignore
  - docs/fsoft-native-engine.md
tags: [fsoft, fixture, dependency-graph, python, typescript, codewiki, probe, migrate-stage-1a]
---

## Overview

`tools_fsoft_fixtures` 不是一段产品代码，而是一组**可复现的测试输入（fixture）**外加驱动它的验收探针（probe）。
它服务于 FSoft 原生引擎迁移（阶段 1A/1B/1C，契约见 [[docs/fsoft-native-engine]]），用途是：在一个**路径包含中文和空格**的小仓库里，验证 FSoft 的 tree-sitter 静态分析、依赖图、artifact 采集与多语言（Python + TypeScript）解析，能否在极端路径下完整跑通。

核心 fixture 位于 `tools/fsoft-engine/fixtures/中文 空格 fixture/`，目录名刻意带中文与空格（`中文 空格 fixture`），专门压力测试 FSoft 的解析器路径处理。它包含：

- 一个最小 Python 引擎 `src/core/engine.py`，被 web 层依赖；
- 一个薄 web 壳 `src/web/handler.py`，依赖 `core.engine`，用于验证**依赖边**是否被正确建出；
- 一个 TypeScript 样例 `src/web/task.ts`，验证 TS/JS 分析器在中文路径下也能产出节点；
- 一个 artifact 入口脚本 `scripts/run.py`，验证 artifact 节点是否被采集；
- 打包配置 `pyproject.toml` 与 `Dockerfile`。

配套的验收探针 `tools/fsoft-engine/probe-no-llm-graph.py` 在**无 LLM** 的前提下调用 FSoft 的 `handle_analyze_repo`，用五条判据（R1–R5）断言依赖图、语言覆盖、依赖边与 artifact 节点都正确。环境构建脚本 `tools/fsoft-engine/setup-env.sh` 负责从锁定清单拉起独立 venv，与 fixture 一起构成「可复现输入」。

注意：fixture 的运行时产物（`.codewiki/` 下的 session 缓存、生成的 wiki/索引）**被 .gitignore 排除**，仓库只保留源码与配置，所以 fixture 是「可重算的输入」而非「某次跑出来的快照」（见 `tools/fsoft-engine/fixtures/.gitignore:1-8`）。

## Key Components

### Fixture 源码（被测小仓库 `中文 空格 fixture/`）

#### `src/core/engine.py`（核心引擎，被 web 层依赖）
- 第 6-20 行：`class Engine` —— 持有内部状态的最小引擎。
  - 第 9-11 行：`__init__(self, name: str)` —— 初始化，字段 `name: str`（第 10 行）与 `_calls: int`（私有计数器，初值 0，第 11 行）。
  - 第 13-16 行：`run(self, payload: str) -> str` —— 执行一次任务：先 `self._calls += 1`（第 15 行），再返回 `"{self.name}:{payload}"`（第 16 行）。
  - 第 18-20 行：`@property calls(self) -> int` —— 只读属性，返回 `self._calls`。
- 第 23-25 行：`def build_engine(name: str = "default") -> Engine` —— 构造函数，web 层用它拿引擎。

#### `src/web/handler.py`（web 层，依赖 `core.engine`）
- 第 8 行：`sys.path.insert(0, str(Path(__file__).resolve().parents[1]))` —— 把 `src/` 目录塞进 `sys.path`，使 `from core.engine import ...` 可用。
- 第 10 行：`from core.engine import Engine, build_engine`。
- 第 13-20 行：`class Handler` —— 把请求转交给引擎的薄壳。
  - 第 16-17 行：`__init__(self)` —— 用 `build_engine("web")` 构造 `self.engine: Engine`。
  - 第 19-20 行：`handle(self, payload: str) -> str` —— 直接 `return self.engine.run(payload)`（验证 web→core 的依赖边）。

#### `src/web/task.ts`（TypeScript 样例，验证中文路径下 TS 节点产出）
- 第 3-6 行：`interface TaskInput` —— 字段 `id: string`（第 4 行）、`payload: string`（第 5 行）。
- 第 8-10 行：`function normalize(input: TaskInput): TaskInput` —— 对 `id`/`payload` 各做一次 `trim()` 后返回（第 9 行）。
- 第 12-18 行：`class TaskQueue` —— 私有字段 `items: TaskInput[]`（第 13 行）。
  - 第 15-18 行：`push(input: TaskInput): number` —— 先 `normalize(input)` 再 push，返回 `this.items.length`。

#### `scripts/run.py`（artifact 入口，验证 artifact 节点采集）
- 第 8 行：`from src.web.handler import Handler`。
- 第 11-14 行：`def main(argv: list[str]) -> int` —— 构造 `Handler()`，调用 `handler.handle(" ".join(argv[1:]) or "ping")`（第 13 行），`return 0`。
- 第 17-18 行：`if __name__ == "__main__": raise SystemExit(main(sys.argv))`。

#### `pyproject.toml`（打包配置）
- 第 1-3 行：`[build-system]` —— `requires=["setuptools>=68"]`，`build-backend="setuptools.build_meta"`。
- 第 5-8 行：`[project]` —— `name="fixture-cn-space"`（第 6 行）、`version="0.0.1"`（第 7 行）、`requires-python=">=3.12"`（第 8 行）。

#### `Dockerfile`（容器化运行 artifact）
- 第 1-5 行：`FROM python:3.12-slim`，`WORKDIR /app`，`COPY src ./src`，`COPY scripts ./scripts`。
- 第 5 行：`CMD ["python", "scripts/run.py", "boot"]` —— 启动 `run.py`。

#### `.codewiki`（运行时产物，被忽略）
- 目录 `中文 空格 fixture/.codewiki/sessions/` 下含 7 个 session 子目录（`0ace1c6a91af/`、`4f2f21e869b4/`、`650f658cdb80/`、`9531307e94c9/`、`d8495cb3cd83/`、`d9b4d6e47dcd/`、`dfb408068bcb/`），是 FSoft 跑出来的 session 缓存，**不入库**。

#### `tools/fsoft-engine/fixtures/.gitignore`
- 第 1-8 行：注释说明 1C fixture 的运行时产物不入库；忽略 `.codewiki/`、`docs/`、`docs2/`。

### 验收探针与配套脚本

#### `tools/fsoft-engine/probe-no-llm-graph.py`（阶段 1A 无 LLM 依赖图探针）
- 第 29-30 行：`HERE` / `DEFAULT_FIXTURE = HERE / "fixtures" / "中文 空格 fixture"` —— 默认就测本模块 fixture。
- 第 33-42 行：`parse_args()` —— 参数 `--fsoft-src`（FSoft 源码根，含 `codewiki/`，第 36-39 行）、`--fixture`（默认本 fixture，第 40 行）、`--out`（默认 `out-1a`，第 41 行）。
- 第 45-175 行：`main()` —— 验收主体。
  - 第 63-74 行：导入 `codewiki.mcp.session.SessionStore` 与 `codewiki.mcp.tools.analysis.handle_analyze_repo`，调用它得到 `raw`（含 `session_id`/`files`）。
  - 第 79-85 行：**R1** —— `raw` 非 error 且含 `session_id`/`files`。
  - 第 90-98 行：**R2** —— 组件数 >0、叶子节点数 >0、语言集含 python 与 typescript。
  - 第 100-121 行：**R4** —— workspace 里 `component_index.json`/`leaf_nodes.json`/`summary.json` 真实存在且可解析。
  - 第 123-162 行：**R3** —— 直接调 `codewiki.src.be.dependency_analyzer.DependencyGraphBuilder`（第 124 行）与 `codewiki.src.config.Config`（第 125 行），用 `build_dependency_graph()`（第 139 行）拿 components，断言存在 `core.engine -> web.handler` 方向依赖边（第 151、158-161 行）。
  - 第 164-167 行：**R5** —— artifact 节点里存在 `scripts/run.py`（`"run.py" in cid`，第 165 行）。
  - 第 169-175 行：汇总 `ok`、输出 JSON、按 0=全过/2=判据未过/3=异常 退出。

#### `tools/fsoft-engine/setup-env.sh`（阶段 1A 环境构建）
- 第 15-18 行：用法说明；只在插件仓库**之外**建环境，不提 venv 进 git。
- 第 26-29 行：校验 `$FSOFT_SRC/codewiki` 存在。
- 第 31-37 行：定位 `locked-requirements.txt`（冻结清单）与 `constraints.txt`（约束）。
- 第 42-51 行：按需建 venv（兼容 Windows `Scripts/python.exe`）。
- 第 54-56 行：**step1** —— `--no-deps` 全量装冻结快照（避免 `ResolutionImpossible`），`-c constraints.txt` 防间接依赖跑偏。
- 第 58-62 行：**step2** —— editable 安装 FSoft 引擎本体（`-e "$FSOFT_SRC"`，因为 freeze 不含 codewiki 自身）。
- 第 64-75 行：**step3/4** —— `pip check` 反向验证闭合 + `importlib` 冒烟（`codewiki`/`openai`/`pydantic`/`tree_sitter`/`litellm`/`tiktoken`）。

#### `tools/fsoft-engine/constraints.txt` 与 `locked-requirements.txt`
- `constraints.txt`：157 行，钉死 FSoft 依赖树（openai/pydantic-ai-slim/pydantic 等版本约束，防 `--no-deps` 装的间接依赖跑偏，见 `setup-env.sh:13`）。
- `locked-requirements.txt`：164 行，已解析完成的完整环境快照，与 `constraints.txt` 并用于无解析落盘。

#### `tools/fsoft-engine/.gitignore`
- 第 1-3 行：忽略 `out-*/`（探针生成的临时依赖图/文档）。

### 相关但不属于本模块的探针（仅说明，不展开）
- `probe-apply-real-cw.mjs`、`probe-index-missing.mjs`、`probe-generate-with-fake-model.mjs` 用于验证 `lib/engine/apply-plan.js` 与 `lib/engine/python/entry.py` 的桥接/落地逻辑，依赖本 fixture 概念但代码不在本模块，详见其各自归属文档。

## Architecture

本模块是「输入 + 驱动」两件套：fixture 提供被分析的源码树，probe 调用 FSoft 引擎断言分析结果。组件间无循环依赖，依赖方向单一（web → core），正是 probe 要验证的边。

```text
┌──────────────────────────────────────────────────────────┐
│  中文 空格 fixture/  (含中文+空格的极端路径)                │
│                                                          │
│  src/core/engine.py  (Engine, build_engine)              │
│        ▲  dependsOn (web -> core 依赖边, R3 验证)         │
│        │                                                  │
│  src/web/handler.py  (Handler)                            │
│  src/web/task.ts    (TaskInput, TaskQueue)  ── TS 节点    │
│  scripts/run.py     (main)            ── artifact 节点 R5 │
└───────────────┬──────────────────────────────────────────┘
                │ repo_path (含中文空格)
                ▼
┌──────────────────────────────────────────────────────────┐
│  probe-no-llm-graph.py  (无 LLM 验收, R1–R5)               │
│    ├─ handle_analyze_repo (codewiki.mcp.tools.analysis)   │
│    └─ DependencyGraphBuilder (codewiki.src.be)            │
└───────────────┬──────────────────────────────────────────┘
                │ 需要 FSoft 引擎与 venv
                ▼
┌──────────────────────────────────────────────────────────┐
│  setup-env.sh + locked-requirements.txt + constraints.txt │
│    → 独立 venv / 可导入冒烟 / pip check                   │
└──────────────────────────────────────────────────────────┘
```

## Data Flow

1. **环境就绪（一次）**：`setup-env.sh` 用 `--no-deps` 把 `locked-requirements.txt` 落盘进独立 venv，editable 装 FSoft 本体，跑 `pip check` + import 冒烟（见 `setup-env.sh:54-75`）。这一步把「可复现输入」从源码变成「可信运行环境」。
2. **探针调用引擎（无模型）**：`probe-no-llm-graph.py` 以 `--fixture tools/fsoft-engine/fixtures/中文 空格 fixture --fsoft-src <FSoft 仓库根> --out out-1a` 运行（第 9-11、30、40-41 行）。它把 fixture 作为 `repo_path` 传给 `handle_analyze_repo`（第 67-74 行）。
3. **静态分析产出**：FSoft 走 tree-sitter 分析，返回含 `session_id`/`files`/`stats` 的 JSON（`raw`，第 67-75 行）。`stats.languages` 应含 python 与 typescript（R2，第 91-97 行）。
4. **依赖图边验证**：探针再直接调 `DependencyGraphBuilder(cfg).build_dependency_graph()`（第 139 行），遍历 components 断言存在 `core.engine → web.handler` 方向边（R3，第 143-162 行）。
5. **artifact 验证**：断言组件表里存在 `scripts/run.py` 节点（R5，第 165-167 行）。
6. **workspace 落盘验证**：检查 `files` 指到的 `component_index.json`/`leaf_nodes.json`/`summary.json` 真实存在且可解析（R4，第 100-121 行）。
7. **结果汇总**：`result["ok"] = all(checks.values())`（第 169 行），输出 JSON 到 stdout，退出码 0/2/3（第 170-175 行）。固化结果见 `tools/fsoft-engine/probe-no-llm-graph.result.json`（被 [[docs/fsoft-native-engine]] 引用，统计 15 组件 / 6 叶子节点）。

> 注意 fixture 自身的 `.codewiki/sessions/` 是产物、被忽略；`out-1a/` 也是探针临时输出、被 `tools/fsoft-engine/.gitignore:1-3` 忽略，二者都不进版本库。

## Connections

- 契约与阶段门禁总文档：[[docs/fsoft-native-engine]]（章节「1A：锁定环境」直接引用本 fixture 与 `probe-no-llm-graph.py`，「1C：原生端到端」复用同一 fixture）。
- 桥接/落地逻辑（消费 fixture 概念、代码不在本模块）：`lib/engine/apply-plan.js`、`lib/engine/python/entry.py`、`lib/engine/contract.js`、`lib/engine/mapping.js`、`lib/engine/process-tree.js`（由 `probe-apply-real-cw.mjs` / `probe-index-missing.mjs` / `probe-generate-with-fake-model.mjs` 验证）。
- 环境构建依赖：[[tools-fsoft-engine]] 的 `setup-env.sh` 与锁定清单（本模块内 `tools/fsoft-engine/` 同目录），是 FSoft 原生引擎迁移产线的一部分。
- FSoft 引擎源码（被 probe import）：`codewiki.mcp.tools.analysis.handle_analyze_repo`、`codewiki.mcp.session.SessionStore`、`codewiki.src.be.dependency_analyzer.DependencyGraphBuilder`、`codewiki.src.config.Config`（均来自独立的 FSoft 源码根，不在此仓库内）。

## Known Issues

- **fixture 不含模型链路**：`probe-no-llm-graph.py` 仅验证无 LLM 的静态分析（依赖图/artifact/多语言）。模型链路（cluster/articles/validate/index/baseline/commit）需走 1B/1C 的其它探针（如 `probe-generate-with-fake-model.mjs` 固定 429 逼出 `engine-model` 分类），本模块不覆盖。
- **R3 依赖边依赖实现细节**：`probe-no-llm-graph.py:143-162` 先取 `dependsOn`，缺失再取 `depends_on`，再退一步用 handler 组件名 + engine 子串判断。说明 FSoft 的 `DependencyGraphBuilder` 产出字段名不固定，判据有兼容兜底而非单一契约。
- **workspace 变更不在 fixture 验收范围**：据 [[docs/fsoft-native-engine]] 第 193-200 行，FSoft `generate.py` 只认 committed diff，未提交改动不进 `update_record`；这条非 fixture 缺陷，而是 FSoft 限制，由 `lib/change-set.js` 在阶段 5 合成临时 change-set 兜底。
- **运行时产物被忽略**：`中文 空格 fixture/.codewiki/` 与 `out-1a/` 均为可重算产物，不入库（见 `tools/fsoft-engine/fixtures/.gitignore:1-8` 与 `tools/fsoft-engine/.gitignore:1-3`）。因此 `.codewiki/sessions/` 下的 7 个 session 目录不能被当作「测试结果证据」，仅作本地调试残留。
- **环境靠冻结快照而非解析**：因 FSoft 依赖树互相打架，`setup-env.sh:54-56` 用 `--no-deps` 落盘 + `-c constraints.txt` 防跑偏。一旦上游升级 `openai`/`pydantic-ai`，需重新生成 `locked-requirements.txt`，否则 `pip check` 可能暴露新的断裂（[[docs/fsoft-native-engine]] 第 157-162 行）。
