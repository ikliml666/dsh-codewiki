---
title: engine_fixtures
type: module
source_files:
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - test-graphdiff.mjs
  - lib/graph-diff.js
  - test-engine-output.mjs
  - test-engine-output-real.mjs
  - test-engine-python-entry.mjs
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/client.js
tags: [fixtures, probe, golden-fixture, fsoft-engine, python-entry, graph-diff, output-validation, test]
---

## Overview

`engine_fixtures` 不是仓库里的一个独立目录，而是**围绕 fsoft 原生引擎的一组「固定基准 + 探活探针 + 真产物回归」测试资产**的统称（文档标题直译即 "Fixture code and probes for the fsoft engine"）。它散落在三个地方：

- `test-fixtures/` — 离线生成的**黄金基准**文件（一次生成、长期作为真理源）。
- `test-*.mjs` — 消费这些基准、或直接在真 venv / 真 FSoft 产物上做断言的**测试探针**。
- `lib/engine/python/` — 入口与阶段映射：它们既被引擎运行时调用，也被 `test-engine-python-entry.mjs` 当探针直接喂输入、反向对账契约。

为什么需要它：迁移后 Node 侧不再自己算依赖图 / 聚类 / 增量，一切来自 Python 引擎一次返回（见 [[engine_contract]] 与 [[engine_client_proc]]）。这条跨语言边界一旦含糊，就会出现「1 篇成功 + 19 篇失败也报 done」这类缺陷。所以三层 fixture 分别钉死三类失败面：

1. **算法逐位一致**：`test-fixtures/gen-graphdiff-golden.py` 用 Python 原生 `difflib` + `hashlib` 生成 `test-fixtures/graphdiff-golden.json`，`test-graphdiff.mjs` 逐用例比对，证明 `lib/graph-diff.js` 是上游 `graph_diff.py` 的逐位移植而非重写（见 [[graph-diff]]）。
2. **协议 / 环境 / 凭证边界**：`test-engine-python-entry.mjs` 把 `lib/engine/python/entry.py` 当黑盒喂非法请求、真跑 `doctor`、断言凭证不入流；并用内联 `probe` 反向核对 `stage_map.py` 与契约 `ENGINE_STAGES` 同集合。
3. **真实产物自洽**：`test-engine-output.mjs`（手造 docs 树）与 `test-engine-output-real.mjs`（读 `.probe-fsoft/wiki_out_1c/docs` 真产物）钉死 `lib/engine/output.js` + `lib/engine/mapping.js` 对缺页 / 空壳 / 孤儿页 / whole-repository 空模块树的判定。

注意：`.probe-fsoft/` 本身在仓库里是**空占位目录**（`list_files` 显示只有 `probe-home/` 下无文件），它的 `venv/` 与 `wiki_out_1c/` 由阶段 1A / 1C 的真实运行期产物填充，测试通过 `DSH_CODEWIKI_ENGINE_PYTHON` 环境变量或默认候选路径 `../.probe-fsoft/venv/...` 定位（见 `test-engine-python-entry.mjs:35-51`），缺失时整套测试明确 `SKIP` 而不是假装通过。

## Key Components

下面按文件逐一列出公开函数 / 常量、关键字段与用途，行号以 `read_code` 返回的「行号| 」前缀为准。

### 黄金基准生成器 `test-fixtures/gen-graphdiff-golden.py`

离线脚本，一次性把用例 dump 到 `graphdiff-golden.json`（共 499 行，见 `test-fixtures/graphdiff-golden.json:1-499`）。被 `test-graphdiff.mjs:15` 通过 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json` 触发。

- `_WS = re.compile(r"\s+")` — 第 15 行，空白折叠正则。
- `_TOKEN = re.compile(r"\w+|[^\w\s]")` — 第 16 行，token 切分正则（**非** Unicode 感知，与 JS 侧用 Unicode 属性类的 `tokens` 不同）。
- `normalize_body(text)` — 第 19–20 行，去前后空白并折叠空白为单空格。对应 JS `normalizeBody`（`lib/graph-diff.js:28-30`）。
- `documented_source(code, docstring="")` — 第 23–27 行，docstring 不在 code 中时拼成 `f"{doc}\n{code}"`。对应 JS `documentedSource`。
- `body_hash(code, docstring="")` — 第 30–31 行，`hashlib.sha1(normalize_body(documented_source(...)).encode("utf-8"))`。对应 JS `bodyHash`。
- `_tokens(text)` — 第 34–35 行，`_TOKEN.findall`。对应 JS `tokens`。
- `body_similarity(a, b)` — 第 38–44 行，token 化后 `difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()`；空对空 `1.0`，单侧空 `0.0`。对应 JS `bodySimilarity`（`lib/graph-diff.js:239-245`）与 `sequenceRatio`（`lib/graph-diff.js:229-236`）。
- `unified_body_diff(old_lines, new_lines, label, n=2)` — 第 47–49 行，`difflib.unified_diff(..., fromfile=f"a/{label}", tofile=f"b/{label}", n=n)`。对应 JS `unifiedDiff`（`lib/graph-diff.js:327-355`）。
- `main()` — 第 52–144 行，固定种子 `random.Random(20261027)`（第 53 行）生成四类用例：similarity（13 手写 + 30 随机，第 57–86 行）、hash（6 手写，第 89–103 行）、unified 手写（9 组，第 106–126 行）、unified 随机（20 组 `label='r'`，第 129–142 行）；末行 `json.dump(cases, sys.stdout, ensure_ascii=False, indent=1)`（第 144 行）输出 499 行 JSON。

### 黄金基准数据 `test-fixtures/graphdiff-golden.json`

纯数据文件，每行用例形如 `{ "kind": "similarity"|"hash"|"unified", ... , "expected": ... }`。`kind:'similarity'` 带 `a/b/expected`（浮点比），`kind:'hash'` 带 `code/docstring/expected`（SHA1 十六进制串），`kind:'unified'` 带 `oldText/newText/label/expected`（unified diff 文本）。随机用例已固化（如 `test-fixtures/graphdiff-golden.json:480-498` 的 `label:'r'` 多 hunk 用例），是逐位比对的真理源。

### 对拍 + 组件级测试驱动 `test-graphdiff.mjs`

无框架裸跑（靠 `process.exit(0/1)` 报结果）。

- `goldenPath` 与加载守卫（第 12–18 行）：`path.join(here, 'test-fixtures', 'graphdiff-golden.json')`；缺失则 `console.error` 提示先跑生成脚本并 `process.exit(1)`。
- 导入的被测函数（第 7–10 行）：`bodySimilarity`、`bodyHash`、`unifiedDiff`、`diffGraphs`、`serializeDiff`、`sequenceRatio`、`normalizeBody`、`documentedSource`、`truncateToTokens`。
- `splitKeepEnds(s)`（第 23–26 行）：本地辅助，正则 `/[^\n]*\n|[^\n]+$/g` 切行保留换行符。
- 对拍主循环（第 28–42 行）：按 `c.kind` 分派，`similarity` 用 `|got-expected|<1e-12`（第 30–32 行），`hash`/`unified` 用严格 `===`（第 34–40 行）。
- 失败汇总（第 44–53 行）：最多展示前 5 条明细后 `process.exit(1)`。
- `mk(id, name, src, opts={})`（第 58–66 行）：构造符号节点，`kind` 默认 `'function'`、其余字段可经 `opts` 覆盖。
- `oldG` / `newG`（第 68–82 行）：两张 `Map<id, node>`，覆盖未变 / body / edge / interface / 改名 / 新增六类。
- 组件级断言 `checks`（第 86–94 行）：body 分类、edge 分类、interface 分类、未变不登记、改名配对、改名后不算 del/add、新增登记、counts 自洽。
- 序列化往返（第 102–104 行）与退出码（第 106–107 行）。

### FSoft 产物解析 / 校验测试 `test-engine-output.mjs`

造一个「正常」docs 树（入口 + 两模块页 + 四个 JSON）后逐项钉死 `lib/engine/output.js`。

- `makeDocs(name, overrides={})`（第 31–56 行）：在临时目录造 `overview.md` / `Core.md` / `Web.md` / `metadata.json` / `module_tree.json` / `first_module_tree.json` / `update_record.json`；`overrides` 用于替换/置空某个文件（如 `{ 'metadata.json': null }` 造缺失）。
- 导入被测符号（第 12–19 行）：`OUTPUT_PROBLEM_KINDS`、`bodyLength`、`relativeLinks`、`collectOutput`、`buildWritePlan`、`validateOutput`。
- 关键断言（部分）：`bodyLength` 空壳判定（第 65–70 行）、`relativeLinks` 跳过外链/锚点/图片 data URI（第 72–77 行）、`collectOutput` 缺目录→`missing-docs-dir`（第 89–93 行）/ 缺 metadata→`missing-metadata`（第 95–99 行）/ 坏 JSON→`bad-json`（第 101–106 行）、`validateOutput` 缺 overview→`entry-missing`（第 134–139 行）/ 空壳→`empty-body（带 source）`（第 141–148 行）/ 模块有页无→`article-missing`（第 150–155 行）/ 孤儿页→`unmapped-page（带 source）`（第 157–164 行）/ `source_files` 指向不存在→`source-missing（带 target）`（第 166–178 行）/ 计划外 md 链接→`dead-link`（第 191–198 行）/ 链接到仓库源文件不算死链（第 200–204 行）/ 同输入两次稳定（第 206–212 行）/ 未登记 problem kind 被拒（第 214–217 行）/ `componentFiles` 作为 source_files 证据（第 219–227 行）。

### 真实 FSoft 产物回归 `test-engine-output-real.mjs`

只读 `.probe-fsoft/wiki_out_1c/docs` 真产物（见第 32 行 `REAL`，Windows 绝对路径），复制到临时目录后施加变形，绝不改动原产物。

- `REAL` / `REAL_REPO`（第 32–37 行）：真产物路径；`existsSync(REAL)` 缺失时 `SKIP` 退（第 33–36 行）。
- `copyDocs(name)`（第 40–44 行）：`cpSync(REAL, dir, { recursive: true })`。
- 关键断言：真实产物 `collectOutput` 读到 overview + 两模块页且 `module_tree==={}`（第 46–55 行）；空模块树 + 有模块页→页仍进写集、`source_files` 为空 `attribution='unattributed'`、`unmapped=[]`（第 57–74 行）；空模块树本身报 `empty-module-tree` 且 `ok=false`（第 76–84 行）；非空树但某页无模块→仍 `unmapped`（第 86–95 行）；hierarchical 嵌套子目录页必须被收集（第 97–114 行）；`temp/` 下 md 不算页（第 116–122 行）；`update_record` 原样读出（第 124–132 行）；metadata commit 进 `lastCompiledCommit`（第 134–139 行）；正文真实页间链接不误判死链（第 141–146 行）；空模块树时 `componentFiles` 证据也用不上（第 148–157 行）；`mapFsoftOutput` 纯函数双形态（第 159–177 行）。

### Python 入口与阶段映射探针 `test-engine-python-entry.mjs`

把 `lib/engine/python/entry.py` 当黑盒，覆盖三失败面。

- `ENTRY` / `STAGE_MAP`（第 23–24 行）：指向 `lib/engine/python/entry.py` 与 `lib/engine/python/stage_map.py`。
- `findPython()`（第 35–44 行）：优先 `DSH_CODEWIKI_ENGINE_PYTHON`，否则候选 `../.probe-fsoft/venv/Scripts/python.exe`（Windows）或 `../.probe-fsoft/venv/bin/python`；都没有则 `SKIP`（第 47–51 行）。
- `sandbox` / `repo`（第 55–61 行）：每次跑用干净临时仓库，`git init` + 提交一次（入口会读 git commit，落在真实仓库会污染基线）。
- `fakeHome` / `isolatedEnv`（第 65–67 行）：隔离 `HOME`/`USERPROFILE` + `CODEWIKI_NO_KEYRING=1`，确保入口即使机器上有 `~/.codewiki/config.json` 也读不到凭证库。
- `runEngine` 调用（第 80–157 行）：经 `lib/engine/client.js` 跑 `doctor`，断言 `outcome==='done'`、`engine.version==='2.0.0'`、`python` 匹配 `^3\.12\.`。
- 协议面（第 79–140 行）：非法 action→`engine-protocol`（第 79–108 行）、非 JSON 行→`engine-protocol`（第 110–123 行）、`cancel`→立即 `cancelled`（第 125–140 行）。
- 环境面（第 144–173 行）：真 venv 上报真实版本与 pip check 闭合状态。
- 凭证面（第 177–208 行）：`doctor` 输出不含 `api_key`/`sk-`/`credentials.json`/`keyring`（第 187 行）；缺模型通道的 `generate` 直接 `engine-model` 且不外泄凭证（第 192–208 行）。
- 阶段映射对账（第 212–247 行）：内联 `probe` 调 `stage_map.map_stage`/`percent_of` 验证五段→八段、百分数单调（第 212–234 行）；并反向断言 `stage_map.ENGINE_STAGES` 与 `contract.ENGINE_STAGES` 同集合（第 236–247 行）。

### 被测实现侧（被 fixture 直接引用）

以下不是 fixture 本身，但 fixture 的断言点名了它们的具体行，写在这里便于未来 agent 直接定位：

- `lib/engine/python/entry.py` 公开常量/函数：`PROTOCOL_VERSION=1`（第 94 行）、`ACTIONS=("doctor","generate","update","cancel")`（第 95 行）、环境变量名 `ENV_BASE_URL/ENV_API_KEY/ENV_MAIN_MODEL/ENV_CLUSTER_MODEL`（第 98–101 行）、`emit`（第 104–108 行）、`emit_hello`（第 111–112 行）、`emit_progress`（第 115–128 行）、`emit_result`（第 131–132 行）、`failure`（第 135–153 行）、`action_doctor`（第 198–237 行）、`_model_config`（第 243–275 行）、`bridge_progress`（第 281–332 行）、`action_generate`（第 384–473 行）、`_done_result`（第 475–495 行）、`_classify_exception`（第 498–526 行）、`_cancelled_result`（第 529–546 行）、`handle_request`（第 552–574 行）、`main`（第 577–590 行）。
- `lib/engine/python/stage_map.py` 常量/函数：`ENGINE_STAGES`（第 20–29 行，**必须与** `lib/engine/contract.js:24-33` 的 `ENGINE_STAGES` 同集合）、`FSOFT_STAGE_NAMES`（第 33–39 行）、`FSOFT_STAGE_WEIGHTS`（第 40–45 行）、`FSOFT_TO_ENGINE`（第 50–56 行）、`DEFAULT_ENGINE_STAGE="articles"`（第 60 行）、`FSOFT_PROGRESS_CEILING=90`（第 63 行）、`map_stage`（第 66–72 行）、`percent_of`（第 75–97 行）。
- `lib/engine/output.js` 公开符号：`OUTPUT_PROBLEM_KINDS`（第 22–34 行，11 类）、`bodyLength`（第 127–137 行）、`relativeLinks`（第 140–152 行）、`collectOutput`（第 91–124 行）、`buildWritePlan`（第 162–173 行）、`validateOutput`（第 184–282 行）。
- `lib/engine/mapping.js` 公开符号：`WIKI_ENTRY/WIKI_DIR/...`（第 30–34 行）、`moduleSlug`（第 38–44 行）、`mapFsoftOutput`（第 115–268 行）、`sourceFilesOf`（第 62–72 行）、`indexModuleTree`（第 76–96 行）。
- `lib/engine/contract.js` 公开常量/函数：`ENGINE_CONTRACT_VERSION=1`（第 20 行）、`ENGINE_STAGES`（第 24–33 行）、`TERMINAL_OUTCOMES`（第 35 行）、`BLOCKER_KINDS`（第 42–53 行）、`ENGINE_ERROR_CODES`（第 57–67 行）、`RETRYABLE_CODES`（第 71 行）、`engineResult`（第 97–147 行）、`engineProgress`（第 150–168 行）、`engineError`（第 171–182 行）、`validateEngineResult`（第 186–220 行）、`describeEngineResult`（第 223–240 行）。
- `lib/engine/client.js` 公开符号：`ENGINE_PROTOCOL_VERSION=1`（第 27 行）、`createProtocolReader`（第 39–186 行）、`spawnPlan`（第 189–199 行）、`runEngine`（第 223–422 行），协议不变量见文件头第 13–20 行。

## Architecture

三类 fixture 分别守在「移植算法」「跨进程协议」「真实产物解析」三个边界上，被两个被测实现（`lib/graph-diff.js` 与 `lib/engine/{contract,client,output,mapping,python}`）共享同一套真理源或同一份真产物。

```text
┌─────────────────────────┐  写盘    ┌────────────────────────────┐
│ gen-graphdiff-golden.py │ ───────► │ graphdiff-golden.json      │
│ (Python difflib/hashlib)│         │ 499 行用例 (kind+expected) │
└─────────────────────────┘         └──────────────┬─────────────┘
                                                    │ 读入
                                                    ▼
┌─────────────────────────┐  逐位比对 ┌────────────────────────────┐
│ test-graphdiff.mjs      │ ───────► │ lib/graph-diff.js           │
│  对拍 + 组件级          │          │ (difflib 逐位移植)          │
└─────────────────────────┘         └────────────────────────────┘

┌─────────────────────────┐  spawn    ┌────────────────────────────┐
│ test-engine-python-     │ ───────►  │ lib/engine/python/entry.py │
│ entry.mjs               │  喂请求   │ (JSON-lines 薄入口)         │
│  ▸ 协议面 / 环境面 /    │ ◄───────  │ emit hello/progress/result │
│    凭证面 / 阶段映射对账│  hello+   └──────────────┬─────────────┘
└─────────────────────────┘  result    │ 内联 probe 调
                                       ▼
                            ┌────────────────────────────┐
                            │ stage_map.py               │
                            │ ENGINE_STAGES 与 contract  │
                            │ ENGINE_STAGES 同集合对账   │
                            └──────────────┬─────────────┘
                                           │ 经 client.runEngine
                                           ▼
                            ┌────────────────────────────┐
                            │ lib/engine/contract.js     │
                            │ EngineResult/Progress/Error│
                            └────────────────────────────┘

┌─────────────────────────┐  读真产物  ┌────────────────────────────┐
│ test-engine-output-     │ ───────►  │ .probe-fsoft/wiki_out_1c/   │
│ real.mjs                │  cpSync   │ docs (1C 真输出)            │
│ test-engine-output.mjs  │           └──────────────┬─────────────┘
│  (手造 docs 树)         │  调用      │
└─────────────────────────┘ ─────────► ▼
                            ┌────────────────────────────┐
                            │ output.js + mapping.js     │
                            │ collectOutput/validate/    │
                            │ mapFsoftOutput (产物自洽)  │
                            └────────────────────────────┘
```

关键关系：

- `gen-graphdiff-golden.py` 与 `lib/graph-diff.js` 是「同算法双实现」，前者是 Python 原创、后者逐位移植；两个 `test-graphdiff.mjs` 只消费后者、以前者产出的 JSON 为真理。
- `stage_map.py` 与 `lib/engine/contract.js` 是「同枚举双端」，由 `test-engine-python-entry.mjs:236-247` 双向对账（改一边不改另一边测试即红）。
- `output.js` + `mapping.js` 共用一套 `OUTPUT_PROBLEM_KINDS` / 映射规则，被两个 output 测试从「手造」与「真实产物」两侧覆盖。
- `.probe-fsoft/` 是运行期产物目录（venv、wiki_out_1c），仓库里为空占位，测试定位失败即 `SKIP`。

## Data Flow

**基准生成（离线、一次性）：**

1. `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`（`gen-graphdiff-golden.py:147-148` 的 `__main__` 触发 `main()`）。
2. `main()` 以固定随机种子 `random.Random(20261027)`（第 53 行）构造 `cases`，三类用例各带 `kind` 与 `expected`。
3. `json.dump(..., ensure_ascii=False, indent=1)`（第 144 行）输出 499 行 JSON 落盘。

**对拍测试运行（每次 `node test-graphdiff.mjs`）：**

1. 加载守卫 `fs.existsSync(goldenPath)`（第 14 行）；缺失则报错退出，否则 `JSON.parse` 得 `cases`（第 18 行）。
2. 对拍循环（第 28–42 行）：按 `kind` 调 `lib/graph-diff.js` 对应函数得 `got` 与 `expected` 比对。
3. 组件级（第 55–100 行）：`mk` 造节点 → 填 `oldG`/`newG` → `diffGraphs` → `serializeDiff` → 8 条 `checks` 断言。
4. 退出码（第 106–107 行）：全过 `0`，否则 `1`。

**Python 入口探针运行（每次 `node test-engine-python-entry.mjs`）：**

1. `findPython()` 定位 venv（第 35–51 行），找不到 `SKIP`。
2. 建隔离临时仓库 + 隔离 `HOME`（`fakeHome`/`isolatedEnv`，第 55–67 行），保证入口读不到本机凭证库。
3. 协议面：`spawnSync(PY, [ENTRY], { input: 一行请求 })` 喂非法 action / 非 JSON / `cancel`，解析 stdout 的 JSON-lines，断言 `result.result.outcome`（第 79–140 行）。
4. 环境面：`runEngine({ action:'doctor' })` 经 `client.js` 跑，断言 `engine.version==='2.0.0'`、`python` 匹配 `^3\.12\.`（第 144–173 行）。
5. 凭证面：断言 `doctor` 输出与 `engine-model` 失败路径均不含 `api_key`/`sk-`/`credentials.json`/`keyring`（第 177–208 行）。
6. 阶段映射对账：内联 `probe` 调 `stage_map`，并 `import('./lib/engine/contract.js')` 取 `ENGINE_STAGES` 双向 `deepEqual`（第 212–247 行）。

**产物校验测试运行（每次 `node test-engine-output(-real).mjs`）：**

1. `test-engine-output.mjs`：用 `makeDocs` 在 `mkdtempSync` 临时目录造 docs 树（第 28–56 行），逐断言喂 `collectOutput`/`validateOutput`/`buildWritePlan`，覆盖 11 类 problem kind（第 65–227 行）。
2. `test-engine-output-real.mjs`：若 `existsSync(REAL)` 为假则 `SKIP`（第 33–36 行）；否则 `copyDocs` 复制真产物到临时目录，施加变形后断言 `collectOutput`/`validateOutput`/`mapFsoftOutput`（第 40–177 行）。

## Connections

- [[graph-diff]] — 本模块 `test-graphdiff.mjs` + `test-fixtures/gen-graphdiff-golden.py` 唯一逐位对拍的被测实现（`lib/graph-diff.js`，FSoft 上游 `graph_diff.py` 的移植）。
- [[test-graph-diff]] — 已存在的对拍测试专文（与本文互补：本文把 output / python-entry 探针一并纳入「engine_fixtures」视角）。
- [[engine_contract]] — `ENGINE_STAGES` / `engineResult` / `EngineError` 等契约常量与函数，被 `stage_map.py` 与 `test-engine-python-entry.mjs` 反向对账。
- [[engine_client_proc]] — `lib/engine/client.js` 的 `runEngine` / `createProtocolReader`，`test-engine-python-entry.mjs` 经它跑 `doctor` 并断言协议不变量。
- [[engine_mapping]] / [[engine_output]] — `lib/engine/mapping.js` 与 `lib/engine/output.js`，被 `test-engine-output.mjs` 与 `test-engine-output-real.mjs` 从手造 / 真产物两侧覆盖。
- [[incremental]] / [[update-planner]] — 增量更新管线，依赖 `lib/graph-diff.js` 的 `diffGraphs` 判定驱动文章重写；对拍回归保护其输入精度。

## Known Issues

- **`.probe-fsoft/` 仓库内为空占位**：`list_files` 显示该目录下只有 `probe-home/` 且其中无文件。`venv/` 与 `wiki_out_1c/` 由阶段 1A / 1C 的真实运行填充；测试通过 `DSH_CODEWIKI_ENGINE_PYTHON` 或默认候选路径 `../.probe-fsoft/venv/...` 定位（`test-engine-python-entry.mjs:35-51`），缺失时整套 `SKIP` 而非报错。这意味着 CI 没有 1A/1C 产物时，协议面 / 环境面 / 凭证面 / 真实产物回归三条线全部静默跳过，潜在回归不会被发现。
- **基准文件非随测生成**：`graphdiff-golden.json` 必须手工重跑 `gen-graphdiff-golden.py` 才能刷新（`test-graphdiff.mjs:15` 提示）。随手改 `lib/graph-diff.js` 后若对拍失败，需人工区分「实现回归」还是「基准该重生成」。
- **随机用例已固化但种子固定**：`gen-graphdiff-golden.py:53` 用 `random.Random(20261027)` 固定种子，只有重跑脚本才重算；JSON 里固化的随机 `label:'r'` 用例（如 `test-fixtures/graphdiff-golden.json:480-498`）是固定真理，改种子会令整份基准失真。
- **`splitKeepEnds` 双份实现**：测试侧 `test-graphdiff.mjs:23-26` 与库侧 `lib/graph-diff.js:263-269` 各有一份同名逻辑，非共用；库内实现变化时测试侧不会自动跟随。
- **组件级断言未正向覆盖 `deleted`**：`test-graphdiff.mjs:86-94` 的 `checks` 验证了 `body/edge/interface/renamed/added`，但 `deleted` 列表仅在「改名后不算 deleted」间接验证（第 92 行），未单独构造「仅删除」用例做正向断言。
- **真实产物测试路径硬编码 Windows 绝对路径**：`test-engine-output-real.mjs:34` 的 `REAL = 'E:/ik/Documents/...'` 是机器相关路径，换机或换盘符必 `SKIP`，非可移植。
- **output 测试用 `validateOutput` 假定 `moduleTree.Core` 含 `components`**：`test-engine-output.mjs:166-178` 的 `source-missing` 用例直接把 `components` 写进 `module_tree.json`；与 `test-engine-output-real.mjs` 中 `whole-repository` 模式 `module_tree==={}` 的路径互不覆盖，二者正好钉住「有树 / 无树」两端。
- **功能禁用 / 注释**：本模块无被禁用或注释掉的功能；所有断言分支（similarity/hash/unified、协议面三态、output 11 类 problem）均生效。阶段映射 `stage_map.py` 的 `FSOFT_PROGRESS_CEILING=90`（第 63 行）是**有意**把引擎进度压在 90%、留 10% 给 Node 收尾，不是缺陷。
