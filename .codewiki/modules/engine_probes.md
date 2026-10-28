---
title: engine_probes
type: module
source_files:
  - tools/fsoft-engine/probe-apply-real-cw.mjs
  - tools/fsoft-engine/probe-index-missing.mjs
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/probe-generate.result.json
  - tools/fsoft-engine/probe-no-llm-graph.result.json
  - lib/engine/apply-plan.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
tags: [engine, fsoft, probe, apply, generate, testing, acceptance]
---

## Overview

`engine_probes` 不是一个产品模块，而是 `tools/fsoft-engine/` 下一组**一次性探针脚本**（probe scripts），用于在把 FSoft 原生引擎迁移进 DSH CodeWiki 插件（阶段 1A / 1B / 阶段 3）时，对引擎的两个核心行为——**apply（落地）**与 **generate（生成）**——做真实环境验收。它们刻意**不属于产品代码**：不进 `lib/`，不被 `index.js` 加载；跑完即删临时目录，不碰真实仓库。

四类探针覆盖两条主链路的不同切面：

- `probe-apply-real-cw.mjs`：用**真 `cw` 二进制**跑一次 `applyNativeOutput`，验证「写盘 → `cw index` → 基线 → 自动提交」整条落地链路在真实 git 仓库里成立，且产物（_index.md / _meta.yaml / 提交）干净。
- `probe-index-missing.mjs`：反例探针，验证「`cw index` 退出码 0 但文章没进索引」（frontmatter 被 serde_yaml 静默拒收）会被落地器抓成 `index-failed` 并回滚，而不是静默报 done。
- `probe-generate-with-fake-model.mjs`：用**假模型服务器**（永远回 429）驱动真实 FSoft 入口 `lib/engine/python/entry.py`，验证两件事：① FSoft 五段进度被桥接成引擎八段协议行（graph 段不碰 LLM，能真跑出来）；② 模型不可用时异常被分类成 `engine-model`，而不是崩栈或误报 done。
- `probe-no-llm-graph.py`：阶段 1A 引擎侧验收，验证 FSoft 的 `handle_analyze_repo`（tree-sitter 静态分析、完全无模型）在**中文/空格路径**下能产出正确的依赖图与 artifact，并把判据 R1–R5 以退出码表达（0=全过 / 2=判据未过 / 3=异常）。

配套支持文件：`setup-env.sh`（按冻结快照独立造一个可信的 FSoft venv，规避 `ResolutionImpossible`）、`locked-requirements.txt` / `constraints.txt`（冻结依赖与约束）、`probe-generate.result.json` / `probe-no-llm-graph.result.json`（两次跑通的快照结果，留作基线证据）。

## Key Components

所有探针都是「无包、无测试框架」的裸脚本，靠 `fs.mkdtempSync` / 临时目录自清洁，跑完用 `fs.rmSync(..., { recursive: true, force: true })` 删干净。被它们驱动的产品函数集中在 `lib/engine/apply-plan.js` 与 `lib/engine/python/entry.py`。

### 探针脚本

- `probe-apply-real-cw.mjs`（61 行）
  - 第 9–17 行：在 `os.tmpdir()` 建真 git 仓库（`git init` + 配 user + 提交 README.md），取得 `HEAD`。
  - 第 20–25 行：建 `docs/` 目录，写一份带 frontmatter 的入口 `overview.md`（含中文标题与 `[[modules:core|核心]]` Obsidian 链接）、一篇 `modules/core.md`（`title: "核心: 引擎"` 用引号包裹规避嵌套映射），并写 `metadata.json` / `module_tree.json`。
  - 第 27–37 行：手工构造一个 `report` 对象（仿 `gateNativeOutput` 返回值，`writable:true`、含 `rendered`、`articles`、`entry`）。
  - 第 39 行：调用 `applyNativeOutput({ repoRoot: root, report, docsDir: docs })`。
  - 第 40–49 行：打印 `outcome/applied/written/index/baseline/commit/problems/notes`。
  - 第 52–58 行：直接读盘核对 `_index.md`（有无反斜杠残留）、`_meta.yaml`（是否写了基线），并用 `git show --name-only` + `verifyCommitScope(root, 'HEAD')` 反查提交范围。

- `probe-index-missing.mjs`（41 行）
  - 第 22 行：**关键构造**——`core.md` 的 frontmatter 写成裸值 `title: 核心: 引擎`，serde_yaml 会把 `引擎` 解析成嵌套映射，导致整篇 frontmatter 解析失败、`cw index` 静默跳过该篇却仍退出 0。
  - 第 25–31 行：构造 `report`，`rendered` 里塞的是这份坏内容。
  - 第 33 行：调 `applyNativeOutput`。
  - 第 34–40 行：断言 `outcome`（应为非 done）、`rolledBack`、磁盘上文章/入口/`_index.md` 是否已被回滚清除。

- `probe-generate-with-fake-model.mjs`（100 行）
  - 第 13–16 行：定位 venv 的 `python.exe`（`.probe-fsoft/venv/Scripts/python.exe`）、入口 `lib/engine/python/entry.py`、临时仓 `../.probe-fsoft/wiki_out_entry2`。
  - 第 19–30 行：起一个 http 假模型服务器，`createServer` 永远回 `429`（`{ error: { message: 'probe: 假模型服务器固定限流', type: 'rate_limit' } }`），逼出 `engine-model` 分类路径；端口用 `listen(0)` 随机分配。
  - 第 35–47 行：`spawn` 真实 `entry.py`，注入 `CODEWIKI_BASE_URL/CODEWIKI_API_KEY/CODEWIKI_MAIN_MODEL`（fake）与 `CODEWIKI_NO_KEYRING=1`、并把 `HOME/USERPROFILE` 指到 `.probe-fsoft/probe-home`。
  - 第 49–54 行：向 stdin 写一行 JSON `{ requestId:'probe-gen', action:'generate', payload:{ repoPath, docsDir } }` 后 `end()`。
  - 第 58–68 行：逐行解析 stdout 协议流（按 `\n` 切分、跳过空行、`JSON.parse`，失败记 `NOT-JSON`）。
  - 第 75–86 行：过滤 `progress` 行、抽取 `result`，统计 `hello/progress/非JSON` 行数、`stages` 序列、终态 `outcome/errorCode`。
  - 第 88–98 行：把报告写进 `probe-generate.result.json`（含 `exitCode/protocolLines/stages/outcome/errorCode/stderrTail`）。

- `probe-no-llm-graph.py`（180 行）
  - 第 33–42 行：`parse_args`：`--fsoft-src`（FSoft 源码根，其下须有 `codewiki/` 包）、`--fixture`（默认 `fixtures/中文 空格 fixture`）、`--out`（默认 `out-1a`）。
  - 第 45–75 行：`main` 先校验 `codewiki/` 包存在，把 `src_root` 插到 `sys.path` 头，再 `import` `SessionStore` 与 `handle_analyze_repo`。
  - 第 67–74 行：调 `handle_analyze_repo({ repo_path, output_dir, use_gitignore:False }, store)`。
  - 第 79–86 行：**R1**——解析返回、要求无 `error` 且含 `session_id` 与 `files`。
  - 第 87–98 行：**R2**——`stats.total_components>0`、`total_leaf_nodes>0`、语言集含 `python` 与 `typescript`。
  - 第 100–121 行：**R4**——`component_index/leaf_nodes/summary` 三个 workspace JSON 真存在且可解析。
  - 第 123–162 行：**R3**——额外 `import DependencyGraphBuilder` 与 `Config`，`build_dependency_graph()` 后检查存在 `core/engine -> web/handler` 方向的依赖边。
  - 第 164–167 行：**R5**——存在采集到 `scripts/run.py` 的 artifact 节点（`run.py` 出现在组件 id 中）。
  - 第 169–175 行：全部判据 `all(...)==True` 才 `ok`，退出码 0；判据未过 2，异常 3。

- `setup-env.sh`（78 行）
  - 第 19–24 行：`set -euo pipefail`，参数 `<目标 venv 目录> <FSoft 源码根> [python]`。
  - 第 26–37 行：校验 `codewiki/` 包、`locked-requirements.txt` 存在。
  - 第 42–51 行：建 venv（跨平台定位 `bin/python` 或 `Scripts/python.exe`）。
  - 第 55–56 行：**step1**——`pip install --no-deps -c constraints.txt -r locked-requirements.txt`，按冻结快照落盘、不重解析（规避 openai/pydantic-ai-slim/pydantic 的 `ResolutionImpossible`）。
  - 第 61–62 行：**step2**——`pip install --no-deps -e <FSoft 源码根>` editable 安装引擎本体（freeze 不含 codewiki 自身）。
  - 第 65–75 行：**step3/4**——`pip check` 反向验证依赖闭合 + import 冒烟（`codewiki/openai/pydantic/tree_sitter/litellm/tiktoken`）。

### 被探针驱动的产品函数（行号见下）

- `lib/engine/apply-plan.js`
  - `APPLY_VERSION`：第 43 行，落地协议版本常量（值 `1`）。
  - `APPLY_WRITE_ROOTS`：第 46 行，写集白名单（`['.codewiki', 'CodeWiki.md']`，来自 `mapping.js` 的 `WIKI_DIR`/`WIKI_ENTRY`）。
  - `APPLY_STAGES`：第 49 行，落地四阶段 `['write','index','baseline','commit']`。
  - `APPLY_PROBLEM_KINDS`：第 52–59 行，写集校验问题类别（空路径/绝对路径/上跳/越界/重复/坏内容）。
  - `APPLY_RESULT_KINDS`：第 62–73 行，落地结果问题类别（`write-failed`/`index-failed`/`baseline-failed`/`commit-failed`/`commit-scope`/`not-writable`/`wiki-missing`/`gate-partial`）。
  - `checkWriteTargets(items)`：第 86–131 行，纯函数写集校验（不碰磁盘），整批拒写而非逐条跳过。
  - `capturePre`：第 138–153 行 / `restorePre`：第 155–176 行，pre-image 快照与逆序回滚（含新建文件删除）。
  - `writeAll`：第 178–187 行，原子写盘。
  - `defaultRunCw`：第 191–201 行，默认 `cw` 通道（同步 `spawnSync`）。
  - `defaultVerifyCommit` / `verifyCommitScope`：第 203–237 行，校验提交是否只动了 wiki 产物（`git show --name-only` 反查）。
  - `commitWikiArtifacts`：第 250–295 行，阶段 3 自带小提交器，安全边界逐条照抄 `autoCommitWiki`，`--no-verify` 提交，不 amend 不 push。
  - `toApplyBlockers`：第 309–320 行，落地问题 → 契约 `BLOCKER_KINDS` 词表。
  - `findArticlesMissingFromIndex`：第 338–359 行，找出「已写盘但没进 `_index.md`」的缺页（应对 `cw index` 退出 0 但静默缺页）。
  - `normalizeIndexLinksIn`：第 376–390 行，把 `_index.md` 链接头 `\` 规范成 `/`。
  - `entryBody`：第 395–398 行，剥掉入口页 frontmatter 只留正文。
  - `applyNativeOutput({...})`：第 414–725 行，落地主入口：写盘 → `cw index` → 基线 → 自动提交，失败按三条硬不变量回滚（第 10–22 行）。`index`/`baseline`/`commit` 失败整批回滚；`commit` 失败不回滚产物。

- `lib/engine/python/entry.py`
  - `emit`/`emit_hello`/`emit_progress`/`emit_result`：第 104–132 行，协议流写出（全部走真 stdout 句柄 `_REAL_STDOUT`）。
  - `_ProtocolOnly`：第 59–91 行，`sys.stdout` 替身，非协议写全部改道 stderr；必须在 `import codewiki` 之前装好（第 92 行）。
  - `action_doctor`：第 198–237 行，`env` 阶段探测引擎版本与 `pip check` 闭合。
  - `_model_config`：第 243–275 行，从 `CODEWIKI_*` 环境变量读模型通道，缺项返回 `engine-model` 原因；强制带 `fallback_model`。
  - `bridge_progress`：第 281–332 行，替换 `adapter.progress_tracker` 三方法，把 FSoft 五段进度翻成引擎八段协议行（依赖 `stage_map.map_stage`/`percent_of`）。
  - `_count_docs`：第 338–363 行，递归清点产物页（排除 `temp/` 与 `.` 开头目录）。
  - `action_generate`：第 384–472 行，跑 FSoft 生成/增量，把异常分类成契约终态。
  - `_done_result` / `_classify_exception` / `_cancelled_result`：第 475–546 行，各类终态构造与异常分类（按**异常类型**而非文本分 `engine-model`/`engine-crashed`/`engine-missing`/`cancelled`/`partial+article-missing`）。
  - `handle_request` / `main`：第 552–603 行，读 stdin 一行 JSON、dispatch `doctor/generate/update/cancel`。

- `lib/engine/python/stage_map.py`
  - `ENGINE_STAGES`：第 20–29 行，引擎八段契约（`env/graph/cluster/articles/validate/index/baseline/commit`），须与 `lib/engine/contract.js` 双向对账。
  - `FSOFT_TO_ENGINE`：第 50–56 行，FSoft 五段 → 引擎前四段（4/5 都归 `validate`）。
  - `FSOFT_PROGRESS_CEILING`：第 63 行，进度上限压在 `90%`（剩 10% 留给 Node 侧收尾）。
  - `map_stage`：第 66–72 行 / `percent_of`：第 75–97 行，阶段号映射与整体进度计算（夹紧非法输入）。

## Architecture

四个探针分属两条验收链路，分别驱动「落地（apply）」与「生成（generate/graph）」两端。apply 链路只依赖 Node 侧 `lib/engine/apply-plan.js` + 真实 `cw` 二进制；generate 链路跨越 Node 探针 → Python `entry.py` → FSoft 引擎 → 假模型（或真实 tree-sitter 静态分析）。

```text
                ┌─────────────────────────── engine_probes (tools/fsoft-engine/) ───────────────────────────┐
                │                                                                                            │
  APPLY 链路 ──► probe-apply-real-cw.mjs ──► applyNativeOutput() ──► lib/engine/apply-plan.js               │
                probe-index-missing.mjs     (写盘→index→基线→提交)            │  真 git 仓库 + 真 cw 二进制   │
                │                            verifyCommitScope()              ▼                              │
                │                            findArticlesMissingFromIndex()  .codewiki/(_index.md,_meta.yaml)│
                │                                                                                            │
  GENERATE ───► probe-generate-with-fake-model.mjs ──spawn──► lib/engine/python/entry.py                     │
  链路          (假模型=429 服务器)                       (bridge_progress→stage_map.py)                     │
                │                                            │   FSoft CLIDocumentationGenerator              │
                │                                            ▼   (graph 段不碰 LLM，能真跑)                   │
                │                                          <fake-model http :429> → engine-model             │
                │                                                                                            │
  GRAPH 链路 ─► probe-no-llm-graph.py ──import──► FSoft handle_analyze_repo / DependencyGraphBuilder        │
                (中文/空格 fixture)         (tree-sitter 静态分析，完全无模型)                                │
                │                                                                                            │
  ENV 支撑 ───► setup-env.sh ──► venv (locked-requirements.txt + constraints.txt) ──► 被 entry.py 用       │
                └────────────────────────────────────────────────────────────────────────────────────────┘
```

关键设计取舍：探针**不 import `index.js`**（落地器 `apply-plan.js` 也刻意不 import 它，见第 24–27 行），避免为测一个写盘函数而拉起宿主服务与 webServer；默认自带同语义提交器 `commitWikiArtifacts`（第 250 行）而非「不注入就不提交」，防止产物只落盘不入库却仍报 done（第 29–34 行、第 534–536 行）。

## Data Flow

**apply 链路（probe-apply-real-cw.mjs / probe-index-missing.mjs）**

1. 探针在 `os.tmpdir()` 建裸 git 仓库（`git init` + 初始提交），取得 `HEAD`（probe-apply-real-cw.mjs:9-17）。
2. 建 `docs/` 写 frontmatter 入口 + 文章 + `metadata.json`/`module_tree.json`（probe-apply-real-cw.mjs:20-25；probe-index-missing.mjs:18-22 故意写坏 `title: 核心: 引擎`）。
3. 手工构造 `report`（仿 `gateNativeOutput` 返回：`writable:true`、`rendered`、`articles`、`entry`）。
4. 调 `applyNativeOutput({ repoRoot, report, docsDir })`（apply-plan.js:414）：写集校验 `checkWriteTargets` → 写盘 `writeAll` → `cw index` → `normalizeIndexLinksIn` → `findArticlesMissingFromIndex`（抓静默缺页）→ `cw meta update` 基线 → `commitWikiArtifacts` 自动提交。
5. 任意一步失败 → `rollback()` 恢复 pre-image（新文件删除、旧文件原样写回），`rolledBack=true`。
6. 探针读盘核对：`_index.md`（反斜杠残留）、`_meta.yaml`（基线）、`git show --name-only` + `verifyCommitScope(root,'HEAD')` 反查提交范围（probe-apply-real-cw.mjs:52-58；probe-index-missing.mjs:34-40 断言已被回滚清除）。
7. 完事 `fs.rmSync(..., {recursive:true, force:true})` 删临时目录（两脚本末行）。

**generate 链路（probe-generate-with-fake-model.mjs）**

1. 起 http 服务器永远回 429（probe-generate-with-fake-model.mjs:19-30）。
2. `spawn` 真实 `entry.py`，注入 `CODEWIKI_*` 假环境变量 + `CODEWIKI_NO_KEYRING=1`，`HOME/USERPROFILE` 指向 `probe-home`（第 35-47 行）。
3. stdin 写一行 `{action:'generate', payload:{repoPath, docsDir}}` 后 `end()`（第 49-54 行）。
4. `entry.py`：`emit_hello` → `_model_config` 读到假 `CODEWIKI_MAIN_MODEL` → `action_generate` → `bridge_progress` 把 FSoft 五段翻成引擎八段协议行（`stage_map.py`）→ 调 `CLIDocumentationGenerator.generate()` → 模型层 `_completions_create` 命中 429 → 异常被 `_classify_exception` 翻成 `engine-model` 终态（entry.py:100、entry.py:520-521）。
5. 探针逐行解析 stdout（第 58-68 行），统计 `hello/progress/非JSON` 行数与 `stages` 序列，提取 `result.outcome/error.code`（第 75-86 行）。
6. 报告写 `probe-generate.result.json`（第 88-98 行）。快照显示：退出码 0、协议行 8、`progress` 6 条、`stages=[env,graph,cluster,articles]`、终态 `failed/engine-model`（probe-generate.result.json）。

**graph 链路（probe-no-llm-graph.py）**

1. 校验 `--fsoft-src` 下 `codewiki/` 包，把 `src_root` 插入 `sys.path`（probe-no-llm-graph.py:51-58）。
2. `handle_analyze_repo({repo_path, output_dir, use_gitignore:False}, SessionStore)` 产出 `session_id/files/stats`（第 67-74 行）。
3. 直接读 workspace 的 `component_index.json`/`leaf_nodes.json`/`summary.json` 验 R4（第 100-121 行）。
4. 另 `DependencyGraphBuilder(cfg).build_dependency_graph()` 取 `components`，查 `core/engine → web/handler` 依赖边（R3）与 `scripts/run.py` artifact（R5）（第 123-167 行）。
5. 全部判据 `all()==True` 才 `ok`，退出码 0；判据未过 2、异常 3（第 169-175 行）。快照 `probe-no-llm-graph.result.json` 显示 5 项 R* 全 true（R1-R5），`total_components=15`、`total_leaf_nodes=6`、含 `python`/`typescript`。

## Connections

- [[engine-apply-plan]]：`applyNativeOutput` / `verifyCommitScope` / `commitWikiArtifacts` / `findArticlesMissingFromIndex` 是 apply 链路探针直接驱动的产品函数（本文 `lib/engine/apply-plan.js`）。
- [[engine-python-entry]]：`probe-generate-with-fake-model.mjs` 直接 spawn 的 Python 入口（本文 `lib/engine/python/entry.py`），含协议守卫与异常分类。
- [[engine-stage-map]]：FSoft 五段 → 引擎八段契约的映射（本文 `lib/engine/python/stage_map.py`），generate 探针通过它断言 `stages` 序列。
- [[engine-contract]]：`BLOCKER_KINDS` / `ENGINE_STAGES` 词表，落地器与 stage_map 都须与之一致；探针终态 `engine-model` 等码源于此。
- [[engine-quality-gate]]：探针构造的 `report` 是 `gateNativeOutput` 的返回值；落地器只认 `report.writable/outcome` 结论，不重复 gate 判定（apply-plan.js:466-478）。
- [[engine-mapping]]：`WIKI_DIR` / `WIKI_ENTRY` / `WIKI_META_REL` 决定写集白名单与 `_meta.yaml` 路径（apply-plan.js:39、第 46 行）。
- [[engine-llm-bridge]]：模型通道由 Node 侧 loopback 桥注入（entry.py:26-29 拒绝读本机 keyring）；探针用假模型服务器替代真实桥，专门验证协议与分类。

## Known Issues

- **probe-generate-with-fake-model.mjs 的 venv 路径写死 Windows**（第 14 行）：`PY = join(HERE,'..','..','..','.probe-fsoft','venv','Scripts','python.exe')`，非 Windows 平台（`bin/python`）无法运行，需手动改。
- **apply 探针依赖系统 `cw` 二进制**（apply-plan.js:533 默认 `cw`，可被 `DSH_CODEWIKI_CW` 覆盖）：若 PATH 里没有 FSoft 的 `cw`，`cw index`/`cw meta update` 会直接失败导致整批回滚——这是探针「环境未就绪」的假阴性。
- **probe-no-llm-graph.py 依赖外部 FSoft 源码树**：`--fsoft-src` 必须传一个含 `codewiki/` 包的目录，且 editable 安装进入 `sys.path`；若冻结清单与源码版本不匹配，`pip check`（setup-env.sh:40）会先在环境层拦下。
- **graph 探针 workspace 路径含中文/空格**：fixture 名即 `中文 空格 fixture`（probe-no-llm-graph.py:30），`summary.json` 路径在结果 JSON 里以 Windows 反斜杠写出（probe-no-llm-graph.result.json:34-44）——这恰好验证了「中文/空格路径下跑通」的判据，但结果文件是平台相关快照，跨平台重跑会得到不同绝对路径。
- **probe-generate.result.json / probe-no-llm-graph.result.json 是一次性快照**：内含绝对路径与本地栈回溯（如 `E:\ik\Documents\...\dsh plugin\...`），仅作历史证据，`git diff` 会把这些本地路径带进提交；新机器重跑会刷新。
- **generate 探针不验证文章质量**：刻意不接真模型（第 5-6 行注释），只验证协议桥接与异常分类；真模型那一环由 `test-engine-llm-bridge.mjs` 用 loopback 桥单独验证（见 entry.py:4-6 注释指向 `docs/fsoft-native-engine.md`）。
- **apply 探针的 `report` 是手工构造**：字段必须与 `quality-gate.js` 的返回同构（含 `rendered[].wikiPath/content`、`articles[]`、`entry`），一旦契约字段改名而探针未同步，会误报落地失败（见 apply-plan.js:482-513 对 `report.rendered`/`report.entry` 的读取）。


