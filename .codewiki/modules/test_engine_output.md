---
title: test_engine_output
type: module
source_files:
  - test-engine-manifest.mjs
  - test-engine-process-tree.mjs
  - test-engine-output.mjs
  - test-engine-quality-gate.mjs
  - test-engine-python-entry.mjs
  - lib/engine/manifest.js
  - lib/engine/process-tree.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/article-contract.js
  - lib/update-record.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
tags: [test, engine, manifest, process-tree, output, quality-gate, python-entry]
---

## Overview

本模块是 FSoft 原生引擎迁移链路（阶段 2 / 阶段 3）的**测试集合**，由 5 个独立的 `.mjs` 测试脚本组成，分别钉死引擎侧五个子系统的行为契约：

- **`test-engine-manifest.mjs`**：测 `lib/engine/manifest.js` —— 引擎环境指纹、lock 比对、doctor 只读诊断。每条断言对应一个具体的「环境漂移」场景（版本变了、Python 变了、pip 不闭合、上游 commit 变了）。
- **`test-engine-process-tree.mjs`**：测 `lib/engine/process-tree.js` —— 受管子进程树的整树终止。用**真实**两层进程树（node → node 孙进程），断言取消必须打穿整棵树、不残留孤儿进程。
- **`test-engine-output.mjs`**：测 `lib/engine/output.js` —— FSoft 产物（docs 目录）解析、校验与映射。每条断言对应一个真实可发生的故障（缺页、空壳页、死链、source_files 编造）。
- **`test-engine-quality-gate.mjs`**：测 `lib/engine/quality-gate.js` —— 原生产物**采用门**。比 output.js 高一层：除自洽外还判目标格式契约与基线可推进性。含一组对 1C 真产物的回归断言（路径不存在则 SKIP）。
- **`test-engine-python-entry.mjs`**：测 `lib/engine/python/entry.py`（及 `stage_map.py`）—— 整条链路里唯一一处自写 Python 的 JSON-lines 薄入口。钉三条失败面：协议面（非法请求 / 非 ASCII 路径）、环境面（真 venv 的 doctor）、凭证面（不得泄漏 api_key）。

五个脚本共享同一套轻量测试框架（顶层 `check(label, fn)` + `pass`/`fails` 计数，见各文件框架函数），不依赖任何测试运行器，直接 `node xxx.mjs` 即可跑。

这些测试不是「形状好看」的断言，而是针对历史缺陷（0.14.0 的「1 篇成功 + 19 篇失败也报 done」、阶段 1C 的「取消只杀根进程、孙进程变孤儿烧 token」、阶段 6.8 的「每轮都自报 incremental 造纯记账提交」）逐条钉死。**任何绕过源模块改行为都会让对应测试变红。**

## Key Components

### test-engine-manifest.mjs

测试 `lib/engine/manifest.js`。框架见 23–28 行（`check`/`pass`/`fails`）；临时根 `root` 用 `mkdtempSync(join(tmpdir(), 'fsoft-manifest-'))`（30 行），`fakeProbe`（31–36 行）是可控的 probe 桩。

导入的被测符号（10–21 行）：`MANIFEST_VERSION`、`ENGINE_LOCK_REL`、`UPSTREAM_COMMIT`、`normalizeUpstreamCommit`、`probeEnvironment`、`fingerprintOf`、`readLock`、`compareLock`、`writeLock`、`doctor`。

覆盖的公开函数与行为（全在 `manifest.js`，行号以源码前缀为准）：

- `probeEnvironment`（manifest.js:52–64）：测试 47–49 行断言「没有 probe 函数直接报错」（`/需要 probe 函数/`，对应 manifest.js:76 抛错）；测试 38–45 行用 `fakeProbe()` 收集 version/pythonVersion/pipCheckOk/engineRoot，并断言 `fingerprint` 是 16 位 hex（对应 manifest.js:63 调 `fingerprintOf` 算指纹）。
- `fingerprintOf`（manifest.js:76–83）：指纹只吃 `version`+`pythonVersion`+`upstreamCommit`；测试 61–65 行断言 pipCheckOk 不进指纹（`ok`/`bad` 指纹相等）；测试 51–59 行断言版本相同→指纹相同、版本/Python 变化→指纹变化（对应 76–83 行 `sha256` 只 update `version:`/`python:`/`upstream:`）。
- `readLock`（manifest.js:88–102）：测试 136–140 行断言「无 lock 文件返回 null（首次运行不是错误）」；测试 142–147 行断言「坏 JSON 返回 null 而不是抛」。
- `compareLock`（manifest.js:113–150）：测试 149–152 行 `absent`；154–158 行 `match`；160–168 行 `drift` 且 `diffs[0].field==='version'`；170–176 行 `pythonVersion` drift；178–183 行 pip check 失败优先 `unhealthy`（即使版本一致，对应 143–145 行）。
- `writeLock`（manifest.js:185–193）与 `buildLockBody`（manifest.js:164–179）：测试 185–198 行断言落盘内容完整（含 `manifestVersion`/`fingerprint`/`recordedAt`）、`readLock` 可回读、目录自动创建；201–204 行断言缺 `fingerprint`/`repoRoot` 直接抛；206–213 行断言二次写入覆盖且不留 `.tmp`。
- `doctor`（manifest.js:199–231）：测试 215–222 行首次→`ok=true,status=absent,advice` 非空；224–231 行写 lock 后再 doctor→`match`；233–241 行换版本→`drift,ok=false`；243–254 行依赖不闭合→`unhealthy,ok=false,advice` 指向 `setup-env.sh`（对应 221 行）；256–261 行 probe 抛错→`probe-failed`，不抛给调用方（对应 203–211 行 try/catch）。

最后 263 行 `rmSync(root, { recursive: true, force: true })` 清理临时目录。

### test-engine-process-tree.mjs

测试 `lib/engine/process-tree.js`。框架见 20–25 行；导入 `isAlive`、`terminateProcessTree`（18 行）。核心设计（1–12 行注释）：**不 mock**，起真实两层进程树后真杀，因为「kill 只打到自己、孙进程变孤儿」这个 bug 只有真实进程树才暴露。

辅助函数：

- `startTree`(dir)（32–43 行）：spawn 一个 node 根进程，根进程再 `spawn(execPath, ['-e', 'setInterval(...)'])` 起一个长驻孙进程，并把孙进程 pid 写入 `grandchild.pid` 后自己长驻。
- `waitForFile`(path, timeoutMs)（45–55 行）：轮询等孙进程 pid 文件出现（超时 5s 抛错）。

覆盖的公开函数与行为（process-tree.js 行号）：

- `isAlive`(pid)（process-tree.js:41–49）：57–67 行断言已退出进程返回 false、不存在 pid `999999` 返回 false、`0`/`undefined`/负 pid 全部安全返回 false（对应 42 行 `!Number.isInteger(pid) || pid <= 0` 守卫）。
- `terminateProcessTree`(pid, options)（process-tree.js:61–103）：
  - 69–76 行「非法 pid 是 noop」：`[undefined, null, 0, -5, 1.5, 'abc']` 全部返回 `{ok:true, rootAlive:false, method:'noop'}`（对应 65–67 行）。
  - 78–100 行「根进程退出后孙进程也必须死」：`startTree` 起树→`terminateProcessTree(root.pid, {graceMs:2000})`→断言 `rootAlive===false`，且 150ms 后 `isAlive(grandPid)===false`（不留孤儿；对应 61–103 行 Windows `taskkill /T /F` 或 POSIX `process.kill(-pid,...)`）。
  - 102–112 行「已退出的进程重复终止是幂等的」：第二次终止 `method==='already-exited'`、`ok===true`（对应 68–70 行）。
  - 114–128 行「onLog 收到诊断信息且不含凭证字样」：日志含 `taskkill|SIGTERM|SIGKILL`，且 `doesNotMatch(/api[-_]?key|authorization|token|bearer/i)`（对应 18 行 `IS_WINDOWS` 分支与 74/83/94 行 `onLog` 调用）。

注意：测试对 Windows 的 `taskkill` 与 POSIX 的 `SIGTERM→SIGKILL` 两条路径都靠 `#if IS_WINDOWS` 真实进程行为覆盖，无平台分支 mock。最后 130–134 行打印结果并据 `fails.length` 设 `process.exitCode`。

### test-engine-output.mjs

测试 `lib/engine/output.js`。框架见 21–26 行；导入 `OUTPUT_PROBLEM_KINDS`、`bodyLength`、`relativeLinks`、`collectOutput`、`buildWritePlan`、`validateOutput`（12–19 行）。临时根 `root` 用 `mkdtempSync(join(tmpdir(), 'fsoft-output-'))`（28 行）。

辅助函数：

- `makeDocs`(name, overrides)（31–56 行）：造一个「正常」docs 树（overview.md / Core.md / Web.md / metadata.json / module_tree.json / first_module_tree.json / update_record.json）；`overrides` 允许把某文件设成 `null`（表示缺失）或替换内容。
- 配套 `repoRoot`（59–63 行）：建 `src/core/engine.py` 与 `src/web/handler.py`，让 `source_files` 能对得上。

覆盖的公开函数与行为（output.js 行号）：

- `bodyLength`(text)（output.js:127–137）：65–70 行断言「只有标题算空壳、带正文算非空」（对应 133 行只跳第一个 H1，127–137 行算去空白后剩余字符数）。
- `relativeLinks`(text)（output.js:140–152）：72–77 行断言抽相对链接、跳过外链/锚点/图片 data URI（对应 147 行 `#`、148 行 `a-z...:` 协议头跳过）。
- `collectOutput`({docsDir})（output.js:91–124）：79–87 行正常树无 problems；89–93 行 `missing-docs-dir`；95–99 行 `missing-metadata`（用 `overrides` 置 `null`，对应 118 行 `readJsonIfExists` 的 `missing-metadata`）；101–106 行坏 metadata → `bad-json`（对应 79 行 `bad-json`）；108–113 行 `update_record` 缺失不算问题（对应 122 行 `optional:true`）；115–119 行 `update_record` 坏掉仍报 `bad-json`。
- `validateOutput`({docsDir, repoRoot, componentFiles, overviewName})（output.js:184–282）：
  - 121–132 行正常产物 `ok=true`，entry.path=CodeWiki.md，两篇模块页映射到 `.codewiki/modules/{core,web}.md`，`stats.pages=3,articles=2`。
  - 134–139 行缺 overview → `entry-missing`（对应 197 行）。
  - 141–148 行空壳页 → `empty-body` 且带 `source`（对应 224 行）。
  - 150–155 行模块树有模块但没产页 → `article-missing`（对应 231–233 行从 `mapped.warnings` 升级）。
  - 157–164 行页不在模块树 → `unmapped-page`（对应 228 行）。
  - 166–178 行 `source_files` 指向不存在文件 → `source-missing` 且带 `target`（对应 236–248 行，需 `repoRoot`）。
  - 180–189 行「不给 `repoRoot` 时跳过 source_files 存在性检查」（对应 236 行 `if (repoRoot)`）。
  - 191–198 行链接指向计划外 md → `dead-link`（对应 252–264 行）。
  - 200–204 行链接到仓库源文件（`../src/...`）不算死链（对应 258 行 `resolved.startsWith('../')` 跳过）。
  - 206–212 行「同一输入两次调用结果稳定（无隐藏状态）」。
  - 214–217 行 `OUTPUT_PROBLEM_KINDS` 含 `dead-link`/`source-missing`（对应 output.js:23–35 冻结表）。
- `buildWritePlan`({docsDir, componentFiles, overviewName})（output.js:162–173）：219–227 行 `componentFiles` 作为 source_files 证据被采用（key 是 `src/core/engine.py::Engine` 组件 id，对应 164–171 行传给 `mapFsoftOutput`）。

最后 229 行 `rmSync(root,...)` 清理。

### test-engine-quality-gate.mjs

测试 `lib/engine/quality-gate.js`。框架见 40–45 行；导入 `GATE_VERSION`、`GATE_DEFECT_KINDS`、`GATE_DEGRADATION_KINDS`、`GATE_STALE_KINDS`、`gateNativeOutput`、`renderArticle`、`titleOf`、`yamlScalar`、`readCommittedBaseline`、`uncommittedSourceChanges`、`assessBaseline`、`toContractBlockers`、`toQualityIssues`（21–35 行）。还交叉导入 `parseFrontmatter`（36 行，来自 `lib/article-contract.js`）、`judgeOutcome`（37 行，来自 `lib/update-record.js`）、`BLOCKER_KINDS`（38 行，来自 `lib/engine/contract.js`）。

辅助函数：

- `makeDocs`(name, overrides)（51–76 行）：合成 docs 树，默认三页 + 四个 JSON。
- `makeRepo`(name)（79–93 行）：造一个真 git 仓库（含 `src/core/engine.py`、`src/web/handler.py`），返回 `{dir, g, head}`。
- `componentFiles`（95–100 行）：key 是**组件 id**（`文件::符号`，对应 `mapped` 的证据查找），不是模块名。

覆盖的公开常量与函数（quality-gate.js 行号）：

- 常量（43、46–73 行）：104–109 行断言 `GATE_VERSION===1`，且 `defect/degradation/stale` 三表互不重名、全为字符串（消费者按 kind 分派）。
- `gateNativeOutput`({docsDir, repoRoot, componentFiles, ...})（quality-gate.js:397–568）：
  - 113–134 行「干净产物 + 已提交 HEAD + 基线一致 → done，可推进基线」（`outcome==='done'`、`writable`、`canAdvanceBaseline`、`entry.ok`、`articles` 全 `write`）。
  - 138–145 行缺入口 → `failed` 且 `writable===false`（对应 439–449 行、534 行）。
  - 147–156 行空壳页 → `partial`，该篇 `action==='skip'`，且不进 `rendered`（对应 510、513 行）。
  - 158–167 行 `source-missing` → `partial`（对应 236–248 行逻辑在 output.js，gate 透传为 defect，418–437 行）。
  - 169–175 行死链 → `partial`（对应 252–264 行）。
  - 177–183 行坏 metadata JSON → `partial` + `bad-json`（对应 46–60 行 `GATE_DEFECT_KINDS` 含 `bad-json`）。
  - 185–193 行「未登记 kind 不会被吞」：所有 defects/degradations/stale 的 kind 必须在三张登记表里（对应 406、410、435 行 throw）。
  - 197–209 行 `module_tree={}`（whole-repository）→ 算 `degradation`（`empty-module-tree` + `no-source-evidence`），**不是** defect，但 `canAdvanceBaseline===false`（对应 418–422、496–501 行）。
  - 211–224 行「空 source_files 的页不会被 `judgeOutcome` 默默算成功」：演示不喂 `toQualityIssues` → `done`/可推进，喂进去 → `partial`/不可推进（交叉验证 `lib/update-record.js` 的 `judgeOutcome`）。
- `readCommittedBaseline`({repoRoot})（quality-gate.js:116–151）：
  - 228–237 行「只有工作区有 _meta.yaml（未提交）→ ok=false, dirty=true, source='worktree-only'」（对应 140–146 行）。
  - 239–252 行「HEAD 里有、工作区改了它 → 用 HEAD 值并标 dirty」（对应 131–137 行 `git show HEAD:`）。
- `assessBaseline`({repoRoot, artifactCommit, baseline, requireCommittedInput})（quality-gate.js:188–244）：
  - 254–259 行产物 commit ≠ HEAD → `commit-mismatch`（对应 209–213 行）。
  - 261–268 行工作区有未提交源码改动 → `uncommitted-input`（对应 215–219 行）。
  - 270–283 行「只有 wiki 自身的未提交改动不算脏」（`uncommittedSourceChanges` 的 `WIKI_PATHS` 过滤，155 行；`uncommittedSourceChanges` 见 157–173 行）。
  - 285–294 行基线未入库（只在工作区）→ `baseline-uncommitted` 阻塞推进（对应 229–230、241 行）。
  - 296–310 行基线落后 HEAD → `baseline-behind-head` 只报告、不阻塞（对应 232–235 行）。
- `renderArticle`({article, body})（quality-gate.js:322–339）：
  - 314–327 行「正文一字不动」（frontmatter `title/type/source_files/fsoft_page` 正确，正文逐字相同）。
  - 329–336 行「空 `source_files` 显式写成 `[]`」（对应 326–328 行）。
- `yamlScalar`(value)（quality-gate.js:275–287）：338–371 行一组危险值（含冒号空格、`#`、反斜杠、裸数字/布尔、`~`、控制字符等）经 `yamlScalar` → 双引号标量 → `parseFrontmatter` 读回原值（对应 263–286 行判定逻辑；双引号标量走 JSON 转义，363–365 行）。
- `titleOf`(bodyText, fallback)（quality-gate.js:297–296）：389–393 行「有 H1 用 H1，没有则退回模块名」。
- `toContractBlockers`(report)（quality-gate.js:597–595）：397–408 行产出的 kind 全部在 `BLOCKER_KINDS` 里，detail 保留原 kind（对应 571–586 行 `TO_CONTRACT_KIND` 映射）。
- `toQualityIssues`(report)（quality-gate.js:618–623）：410–429 行「只把阻塞性陈旧（`baseline-uncommitted`）算进去，`baseline-behind-head` 不算」（对应 618–620 行）。

真产物回归（431–502 行）：源路径 `REAL = 'E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs'`（433 行），不存在则 SKIP。复制后变形断言：3 页可写但 `module_tree={}` → `partial`、每篇过 article-contract、掏空一篇正文 → skip+partial、断开跨页链接 → `dead-link`、改坏 commit_id → `commit-mismatch`。最后 504 行清理。

### test-engine-python-entry.mjs

测试 `lib/engine/python/entry.py`（及 `stage_map.py`）。框架见 26–31 行。入口路径 `ENTRY`/`STAGE_MAP`（23–24 行）；用 `lib/engine/client.js` 的 `runEngine` 驱动真实子进程（20 行导入，79–108 行协议面测试也用 `spawnSync` 直接打入口）。

环境准备（35–73 行）：

- `findPython`(35–44 行)：优先 `DSH_CODEWIKI_ENGINE_PYTHON` 环境变量，否则找 1A 造的 venv（`Scripts/python.exe` 或 `bin/python`）；找不到则**显式 SKIP** 而非假装通过（47–51 行）。
- sandbox（55–61 行）：每次跑用干净临时 git 仓库（含中文路径 `中文 空格 repo`，验证 UTF-8，见 157–184 行）。
- `isolatedEnv`（65–67 行）：隔离 `HOME`/`USERPROFILE` + `CODEWIKI_NO_KEYRING=1`，确保入口不会读本机 `~/.codewiki` 凭证库（凭证面测试前提）。
- `engineOf`(extraEnv)（69–73 行）：拼 `{command:PY, args:[ENTRY], env}`，`line`(obj)（75 行）拼 `JSON + '\n'`。

覆盖的行为面（entry.py / stage_map.py 行号）：

- 协议面（77–201 行，对应 entry.py `handle_request` 702–735 行、`main` 738–751 行）：
  - 79–108 行「非法 action 回可机读失败（`engine-protocol`）」：入口先发 `hello`（`protocolVersion:1`，对应 entry.py:150–151）、再发 `result`（`outcome:'failed'`），`result.requestId` 回原值（对应 723–724 行 `failure('engine-protocol', ...)`）。
  - 110–123 行「非 JSON 请求行回 `engine-protocol`」（对应 745–747 行 `json.loads` 失败）。
  - 125–155 行「入参按契约**平铺**在顶层，入口必须认」：用指向不存在目录的 `repoPath` 判别——若入口真读顶层 `repoPath` 回 `engine-missing`，否则拿 cwd 走到底（对应 719–721 行 `flat`/`nested` 合并，只读 `msg.payload` 的旧 bug 复现）。
  - 157–184 行「非 ASCII 路径按 UTF-8 读入」：中文仓库路径必须走到 `engine-model`（缺模型通道）而非 `engine-missing`（乱码路径），验证 entry.py:62–70 行 `sys.stdin.reconfigure(encoding='utf-8')`。
  - 186–201 行「cancel 动作立即回 `cancelled` 终态」（`error:null`、blockers 含 `cancelled`，对应 728–732 行 `_cancelled_result`）。
- 环境面（203–234 行，对应 entry.py `action_doctor` 237–276 行、`_engine_version` 198–212、`_pip_check` 215–234）：
  - 205–218 行「真 venv 上报真实版本与闭合依赖」：`res.engine.version==='2.0.0'`、`python` 匹配 `^3\.12\.`、`protocolViolations` 为空。
  - 220–234 行「pip check 闭合状态被如实上报」（不闭合要能看出来，对应 244–254 行 `engine-deps`）。
- 凭证面（236–269 行，对应 entry.py `_model_config` 297–329 行）：
  - 238–251 行「doctor 输出不含 `api_key/apiKey/sk-/credentials.json/keyring`」（隔离 HOME 下，入口若偷读配置会暴露）。
  - 253–269 行「缺模型通道的 generate 直接失败 `engine-model`，不去读本机配置/凭证库」，且失败路径不泄漏凭证（对应 450–452 行 `_model_config` 返回 None → `failure('engine-model', ...)`）。
- 阶段映射（271–355 行，对应 stage_map.py）：
  - 273–295 行「FSoft 五段 → 引擎八段契约，百分数单调」：`map_stage(1..5)`→`['graph','cluster','articles','validate','validate']`，未知阶段归 `articles`，`percent_of` 单调递增且 ≤100（对应 stage_map.py:75–97 行）。
  - 344–355 行「与 `contract.js` 的 `ENGINE_STAGES` 同集合」（双向对账，对应 stage_map.py:20–29 行与 contract.js:24–33 行）。
- 源码面（297–342 行，对应 entry.py `source_exclude_patterns` 285–291 行、`WIKI_PRODUCT_PATTERNS` 282 行）：
  - 299–342 行「引擎不把本插件自己的 wiki 产物（`.codewiki/`、`CodeWiki.md`）当成源码」：用排除清单建 `RepoAnalyzer`，断言 wiki 文件不进文件树、常规源码 `src/app.py` 仍在（对应 479 行 `config["agent_instructions"]` 排除）。

注意：本测试**不**测真实模型生成（`test-engine-client.mjs` 已用真模型验桥），这里用「缺模型通道」路径证明入口不会自己去读凭证库。最后 359–365 行清理 sandbox 并打印结果。

## Architecture

五个测试文件各自独立、针对一个源模块，但合起来覆盖了从「引擎进程启动」到「产物被 wiki 采用」的完整链路。它们在架构里处在**源模块之上、消费方之下**——只验证契约边界，不关心 1A 装环境、不关心阶段 3/4/5/6/7 的写集/索引/提交（那些由各自的 test-*.mjs 钉）。

```text
           引擎侧链路（被测）+ 对应测试                         
 ┌────────────────────┐    test-engine-python-entry.mjs       
 │ python/entry.py     │──► 协议/环境/凭证面；stage_map.py 五段→八段
 │ python/stage_map.py │                                       
 └─────────┬──────────┘    test-engine-process-tree.mjs        
           │ spawn + JSON-lines                              
 ┌─────────▼──────────┐                                       
 │ client.js           │──► runEngine / createProtocolReader   
 │ (process+protocol)  │      取消→ terminateProcessTree        
 └─────────┬──────────┘                                       
           │ result (contract.js: EngineResult)             
 ┌─────────▼──────────┐    test-engine-manifest.mjs           
 │ manifest.js         │──► 指纹/lock/doctor（环境可信性）      
 └─────────┬──────────┘                                       
           │ docsDir (产物)                                 
 ┌─────────▼──────────┐    test-engine-output.mjs             
 │ output.js          │──► collectOutput/buildWritePlan/       
 │                     │      validateOutput（产物自洽）        
 └─────────┬──────────┘                                       
           │ mapped (mapping.js)                            
 ┌─────────▼──────────┐    test-engine-quality-gate.mjs       
 │ quality-gate.js     │──► gateNativeOutput：自洽+格式契约+基线
 │                     │      renderArticle/assessBaseline/...  
 └─────────┬──────────┘                                       
           ▼                                                 
      采用 → CodeWiki.md / .codewiki/（阶段 3+ 负责）           
```

各测试与源模块的行数规模：manifest 测试 268 行 / 源 245 行；process-tree 测试 134 行 / 源 113 行；output 测试 235 行 / 源 287 行；quality-gate 测试 509 行 / 源 638 行；python-entry 测试 365 行 / 入口 764 行 + stage_map 97 行。quality-gate 测试体量最大，是因为它站在 output.js、article-contract.js、update-record.js（judgeOutcome）、contract.js（BLOCKER_KINDS）多个契约的交叉点上。

## Data Flow

五个测试的输入构造策略各不相同，但都遵循「造最小可控输入 → 断言可观测输出」：

- **manifest 测试**：纯内存，用 `fakeProbe`（test-engine-manifest.mjs:31–36）喂固定的 `{version, pythonVersion, pipCheck}`；lock 落盘到 `tmpdir()` 下的临时仓库，再 `readLock` 回读比对。不依赖真 git、不依赖真 Python。
- **process-tree 测试**：真实 OS 进程。临时目录里 `startTree` 起 node 根进程，根进程再 `spawn` 孙进程；断言 `terminateProcessTree` 后根+孙都 `isAlive===false`，用 `existsSync`/`readFileSync` 轮询孙进程 pid 文件（test-engine-process-tree.mjs:49–55）。
- **output 测试**：文件系统 + 合成 docs 树。`makeDocs` 把 7 个文件（3 md + 4 json）写进 `mkdtempSync` 目录，`overrides` 用 `null`/替换串模拟缺失或坏文件（test-engine-output.mjs:28–56）；`repoRoot` 提供 `src/**.py` 供 `source_files` 存在性检查（59–63 行）。
- **quality-gate 测试**：文件系统 + 真 git 仓库（`makeRepo`，79–93 行） + 合成的 docs 树。`assessBaseline`/`readCommittedBaseline` 走真实 `git show HEAD:` 与 `git status --porcelain`（quality-gate.js:116、160）。一组断言复制 1C 真产物（REAL 路径，433 行）到临时目录后变形——路径不存在则整组 SKIP（436–437 行），不污染原产物。
- **python-entry 测试**：真实子进程，直接用 `spawnSync(PY, [ENTRY], {input})` 喂一行 JSON（绕过 client），或经 `runEngine` 走完整协议（test-engine-python-entry.mjs:79–108）。用 `isolatedEnv` 隔离 HOME 防读凭证库；`findPython` 找不到 venv 时整体 SKIP（47–51 行）。

共同的收尾模式：四个测试用 `rmSync(root/sandbox, {recursive:true, force:true})` 清理临时目录（test-engine-manifest.mjs:263、test-engine-output.mjs:229、test-engine-quality-gate.mjs:504、test-engine-python-entry.mjs:359）；process-tree 在每个 `check` 的 `finally` 里清理单棵子树（test-engine-process-tree.mjs:97–98、125–127）。结果统一用顶层 `check` 累加 `pass`/`fails`，末尾打印并通过 `process.exitCode=1`/`process.exit(1)` 暴露失败。

测试间不共享状态、不互相依赖；每个 `.mjs` 可单独 `node` 运行。它们与 `test-engine-client.mjs`（协议/桥）、`test-engine-bridge.mjs`、`test-engine-llm-bridge.mjs`、`test-engine-contract.mjs`、`test-engine-native-job.mjs`、`test-engine-native-incremental.mjs` 等共同构成引擎迁移的测试网，但本模块只覆盖其中「manifest / process-tree / output / quality-gate / python-entry」这五个面。

## Connections

这些测试直接守护以下源模块（Obsidian 反链）：

- [[lib/engine/manifest]] —— `test-engine-manifest.mjs` 钉环境指纹、lock 比对、doctor。
- [[lib/engine/process-tree]] —— `test-engine-process-tree.mjs` 钉受管子进程树整树终止。
- [[lib/engine/output]] —— `test-engine-output.mjs` 钉产物解析/校验/映射。
- [[lib/engine/quality-gate]] —— `test-engine-quality-gate.mjs` 钉采用门（自洽+契约+基线）。
- [[lib/engine/client]] —— `test-engine-python-entry.mjs` 经 `runEngine` 驱动真实子进程；process-tree 经 `killTree` 复用 `terminateProcessTree`。
- [[lib/engine/contract]] —— 质量门与 python-entry 测试交叉验证 `ENGINE_STAGES`、`BLOCKER_KINDS`、`engineResult` 的不变式（done 不带 blockers / partial 必带 blockers）。
- [[lib/engine/python/entry]] 与 [[lib/engine/python/stage_map]] —— `test-engine-python-entry.mjs` 的被测对象。
- [[lib/article-contract]] —— `test-engine-quality-gate.mjs` 用 `parseFrontmatter` 验证 `renderArticle` 产物可读回（quality-gate.js:322、test-engine-quality-gate.mjs:36）。
- [[lib/update-record]] —— `test-engine-quality-gate.mjs` 用 `judgeOutcome` 交叉验证 `toQualityIssues` 必须喂空 source_files 证据（test-engine-quality-gate.mjs:37、211–224 行）。
- [[lib/engine/mapping]] —— output.js 的 `buildWritePlan` 与 quality-gate 的 `gateNativeOutput` 都委托 `mapFsoftOutput`（output.js:19、quality-gate.js:397），测试中的 moduleName/sourceFiles/wikiPath 语义来自此处。
- 同层相邻测试：[[test-engine-client]]（协议/桥，python-entry 测试互补）、[[test-engine-contract]]（契约校验）、[[test-engine-native-job]]、[[test-engine-native-incremental]]（质量门输出的下游消费方）。

环境依赖（非代码）：1A 造的 venv（`setup-env.sh` 在 `tools/fsoft-engine/`）是 python-entry 测试运行前提；1C 全量编译真产物（`REAL` 路径，test-engine-quality-gate.mjs:433）是质量门真产物回归的前提，两者缺失时对应测试组 SKIP 而非失败。

## Known Issues

- **python-entry 测试需要外部 venv，缺失则整体 SKIP**：`findPython`（test-engine-python-entry.mjs:35–44）找不到 `DSH_CODEWIKI_ENGINE_PYTHON` 或 1A 造的 `venv` 时直接 `process.exit(0)` 且 `0 passed, 0 failed, SKIP`（47–51 行）。这意味着在没有 venv 的环境里，协议面/环境面/凭证面/阶段映射/源码面那一整套断言**完全不执行**——CI 必须保证 venv 存在，否则这层覆盖静默空转。
- **quality-gate 真产物回归依赖硬编码绝对路径**：`REAL = 'E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs'`（test-engine-quality-gate.mjs:433）是写死在作者机器上的位置。其它机器/CI 上不存在 → 整组真产物断言（445–502 行）被 SKIP（436–437 行）。这组断言是唯一对「1C 全量真输出」的回归保护，路径不可移植是已知短板。
- **quality-gate 测试里 `uncommittedSourceChanges` 仅作为间接断言**：270–283 行通过 `assessBaseline` 间接验证 wiki 改动不算脏，没有直接单测 `uncommittedSourceChanges` 的 `WIKI_PATHS` 过滤（quality-gate.js:155、157–173）；若 `WIKI_PATHS` 被改错，只有走到 `assessBaseline` 的那条断言能发现问题。
- **process-tree 测试无法在 Windows 上验证 `taskkill` 路径的日志不含凭证**：114–128 行的 `onLog` 断言对 `taskkill|SIGTERM|SIGKILL` 都放行（测试 123 行），在 POSIX 上 `SIGTERM/SIGKILL` 命中，但 Windows `taskkill` 分支的日志措辞同样包含 pid（process-tree.js:74），该正则对两种平台都过，未分别钉死各自措辞。
- **manifest 测试不覆盖 `buildLockBody` 的独立导出**：`buildLockBody`（manifest.js:164–179）作为 `writeLock` 的纯函数拆分，test-engine-manifest.mjs 只通过 `writeLock` 间接测它（185–213 行），没有断言 `buildLockBody` 返回的字符串本身（如 `recordedAt` 是 ISO 时间戳、`manifestVersion` 字段名）。
- **无 mock 的取舍**：process-tree 与 python-entry 测试刻意不起 mock（注释见 test-engine-process-tree.mjs:1–12、test-engine-python-entry.mjs:7–13），代价是运行更慢、依赖真实系统（git/node/python）。这与「不 mock 才能抓到真实进程树/编码 bug」的设计权衡一致，但意味着这些测试在受限沙箱里可能不稳定。
