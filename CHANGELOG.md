# Changelog

## 0.16.10 — 2026-10-30

### 澄清：`update-record` 的基线判据写全，但实测该分支当前不可达

**背景**：Standards 轴评审指出 `canAdvanceBaseline` 在仓库里散布五处、语义不一致，
其中 `lib/update-record.js` 用的是 `outcome === 'done' && blockers.length === 0`，
看起来是 0.16.1「允许 partial 推进基线」时漏改的一处。

**核查结论（实测，不是推断）**：写了个探针把 `judgeOutcome` 的 6 类降级来源
（逐篇失败 / 缺页 / 未归属变更 / 质量闸门 / extraBlockers / 索引未过）逐个单独触发，
结果 **`partial` 恒带至少一条 blocker**——每个降级来源自己就 push blocker。
于是 `partial && blockers.length === 0` 这个组合在本函数里根本构造不出来，
旧写法与新写法**行为完全一致**，这处不是 bug。

**改了什么**：把判据从 `outcome === 'done'` 写成显式的
`outcome === 'done' || (outcome === 'partial' && writtenCount > 0 && blockers.length === 0)`，
并在注释里写清三件事——

1. 本函数服务兼容通道（`tickIndex`），它的 blocker 含「未归属变更」「缺页」这类
   「没消化完」语义；一旦放宽，未消化的变化会被记成已消化，下一轮这些变化不再触发
   文章更新，wiki 就会静默落后于代码。所以这里**刻意**保持比
   `native-run.js` / `quality-gate.js` 更严，不是漏改。
2. `partial` 分支当前不可达的事实与实测依据。
3. 将来若放宽 blocker 规则，partial 分支会自动按「有成果且无缺陷才推进」生效，
   而不是靠 `done` 这个别名悄悄失效。

**为什么不直接删掉多余分支**：两处通道的严格度不同是有意的（原生通道有原始树可回放，
兼容通道没有），删掉会抹掉这个区别；而把判据写全，读者才看得出「严」在哪里。

**验证**：`test-update-record.mjs` → `18 passed, 0 failed`（含「1 成功 19 失败 → partial，
不得推进基线」「未映射变更 → partial，基线不前移」等用例）。


## 0.16.9 — 2026-10-30

### 修复：编译挂死没人收尸——加引擎心跳与静默检测

**现象**：真机 `job-mvubmj6v-1`（本仓库增量）进入阶段 3 后彻底静止：

| 观测项 | 数值 | 说明 |
| --- | --- | --- |
| `job.updatedAt` | `2026-10-30T02:03:32.338Z` 起冻结 | 52 分钟零更新 |
| `nativePercent` | 恒 54 | 恰为 `percent_of(3, 0.0)` = (0.40+0.20)×90 |
| 引擎 PID 30284 CPU | 275.5s → 289.56s | 52 分钟只涨 14 秒，不是慢是死 |
| `py-spy` 主线程 | `_poll (asyncio\windows_events.py:774)` | 事件循环空转，无待办任务 |
| 产物 docsDir 的 md | 三次采样恒 3 篇 | 无任何新写入 |

更严重的后果不在这一轮本身：调度闸门 `parallelLimit` 默认 1，被这个僵死任务一直占着，
另外 3 个仓库（`dsh-git-worktree` / `Wxxy-CampusLogin` / `memory/dsh-hindsight-on-demand`）
的自动编译全部排队饿死——**这就是「看不到过期自动编译」的真凶**。

**两条独立成因**

1. **阶段 3 零进度帧**（引擎侧）。FSoft 阶段 3 内所有 `update_stage` 都在
   `if self.verbose:` 里（`.probe-fsoft/src/codewiki/cli/adapters/doc_generator.py:377/381/389`），
   而 `lib/engine/python/entry.py` 传的是 `verbose=False`。于是从
   `start_stage(3, "Documentation Generation")` 到 `complete_stage()` 之间一帧都不发，
   真机上这段能跑 40 分钟以上。
2. **同实例僵死无人接管**（Node 侧）。`index.js:2800` 的 `tickNative` 只判
   `if (nativeRuns.has(job.id)) return true`，而孤儿接管（`index.js:3659-3670`）
   只在 `job.owner !== instanceId` 时生效。同实例内的僵死任务没有任何人发现，
   唯一兜底是 `runEngine` 的 180 分钟总超时；且即使等到超时，最后一条进度帧的
   `writtenCount` 仍是 0 → 仍判 failed，partial 自救（0.16.5）拿不到任何东西。

**修法**

- `lib/engine/python/entry.py`：
  - 新增 `_EMIT_LOCK = threading.Lock()`，`emit(obj)` 用锁包住协议行写入——心跳线程
    与主线程并发写时，半行 JSON 会让 Node 侧解析丢帧。
  - 新增 `_HEARTBEAT_SEC = 60.0`（必须显著小于 Node 侧静默窗口默认 10 分钟）。
  - `bridge_progress` 末尾把 `adapter.generate` 包成 `generate_with_heartbeat`：
    起一个 daemon 线程按 `_HEARTBEAT_SEC` 重发**当前**阶段与**当前**真实篇数
    （`引擎仍在运行（阶段 N，已写 M 篇）`），`try/finally` 保证任务结束即停表。
  - 心跳**不推进 percent**——只证明「还活着」，不谎报进展。
  - `tracker.current_stage == 0` 时跳过（FSoft 还没进第一个阶段，`map_stage` 只认 1..5）。
  - `orig_generate = getattr(adapter, "generate", None)`：进度桥的既定契约只要求
    adapter 有 `progress_tracker`，拿不到 `generate` 就只装桥不装心跳
    （少一层观测，不能少一层功能）。
- `lib/engine/client.js`：
  - 新增 `DEFAULT_SILENCE_MS = Math.max(30_000, DSH_CODEWIKI_ENGINE_SILENCE_MS || 10 * 60 * 1000)`。
  - `stdout.on('data')` 第一行 `markFrame()` 记录最后一次收到协议帧的时刻。
  - 新增 `silence` promise 参与 `Promise.race`：超过 `silenceMs` 没有任何帧就判卡死
    （`silenceMs` 可按次传入，测试用）。
  - 卡死分支：先 `killTree('silence')` 终止进程树，再按最后一条进度帧的 `writtenCount`
    分流——有产物走 `partial`（带 `engine-timeout` + `engine-timeout` blocker），
    零产物走 `failed`。口径与 timeout 分支完全一致，不新增第二套语义。

**反向验证（红 → 绿）**

- 摘掉 `silence` 的 `Promise.race` → `test-engine-client.mjs` 报
  `必须在静默窗口后立刻返回，不该等满 timeoutMs：20299ms`，`27 passed, 1 failed`；
  恢复即 `28 passed, 0 failed`。这个 `20299ms` 恰好复现真机病态：等满 `timeoutMs` 才返回。
- 把 `adapter.generate = generate_with_heartbeat` 短路 → `test-engine-python-entry.mjs` 报
  `0.5s 内按 0.08s 心跳必须有帧：[{"stage":"articles","percent":54,...,"message":"Documentation Generation"}]`，
  `19 passed, 1 failed`；恢复即 `20 passed, 0 failed`。失败输出里只剩 `start_stage` 那一帧、
  percent 冻结在 54——正是真机现场。

**新增测试**

- `test-engine-client.mjs`：`silent-hang` / `silent-hang-with-progress` 两个假引擎 mode，
  外加两条用例（「静默卡死 → partial 交付已写文章，不等 180 分钟超时」与
  「静默卡死且零进展 → 仍判 failed」），用 `silenceMs: 1200 / timeoutMs: 20000`
  证明是静默检测先触发、而不是超时先到。
- `test-engine-python-entry.mjs`：`心跳：长阶段无进度事件时也要持续发帧`。探针把
  `_HEARTBEAT_SEC` 压到 0.08s，`Tracker.current_stage` 从 0 起步，`generate` 期间真写一篇
  `written-during-hang.md`，断言心跳帧存在、`stage === 'articles'`、且 `written` 会跟着涨
  （用 `some` 而非 `every`：前几帧文章还没写出来，那时恒 0 是对的）。

**回归**：全量 `for f in test-*.mjs` → `ok=28 red=1`，唯一红的是
`test-wiki-anchors.mjs`（已知：`.codewiki` 文章锚点滞后于源码，随一次成功编译消失）。


## 0.16.8 — 2026-10-30

### 修复：编译中途崩溃时把已写文章交出来，别再整轮作废

**现象**：真机 `job-mvu2lmd1-a`（本仓库增量）在阶段 3「Documentation Generation」跑到一半，上游抛

```
Documentation generation failed: LLM returned empty content for dsh-codewiki overview (possible output truncation at max_tokens)
```

终态是 `stage=failed, writtenCount=0, failedCount=0`，`artifacts` 四个字段全是空字符串，`canAdvanceBaseline` 连值都没有，notes 末尾「任务终态：失败（无可用成果）」。而那一轮 docsDir 里**并不是没有东西**——它已经写了十几分钟。

**根因是两段叠加的死循环**：

1. `lib/engine/python/entry.py` 的 `_classify_exception()` 对 `APIError`/`ConfigurationError` 和兜底的「未知异常」一律走 `failure()`，`writtenCount` 恒 0、`artifacts` 全空，**完全不看 docsDir 里已经写了多少**。
2. `lib/engine/native-run.js` 对 `engineOutcome === 'failed'` 是**直接 settle 短路**——不做原始树留档（`rawArchive`）、也不采集受管状态（`.codewiki/_native-state`）。

两段一叠加就是一个闭环：失败轮不产出 `_native-state` → 下一轮增量读到「还没有持久化状态（首次增量）」→ 退回全量 → 全量本身要 174 分钟、更容易撞上同样的中途崩溃 → 又失败。**只要崩一次，就再也增量不起来。**

**修法**：`_classify_exception()` 的这两条分支改走新增的 `_salvage()`：

| 场景 | 结果 |
| --- | --- |
| `_count_docs(docs_dir) > 0`（确有文章落盘） | `outcome = 'partial'`，`writtenCount` 如实上报，`artifacts` 带出 docsDir/rawTreeDir/updateRecord，`error` 保留原始错误码与信息，`blockers` 加一条 `article-failed`（说明「编译在 X 阶段中断（已写 N 篇）」） |
| `written <= 0`（一篇没写出来） | 仍走 `failure()` 判 `failed`——不许用空产物冒充 partial |
| `RepositoryError` | 仍直接 `failure('engine-missing')`：连仓库都没读出来，docsDir 里不可能有成果 |
| `KeyboardInterrupt` | 仍走 `_cancelled_result`（取消不是失败） |

`_salvage()` 里 `updateOutcome` 显式交 `None`（`_update_outcome_of_safe()`）：它没有 adapter 句柄，而 `updateOutcome` 是「基线能不能推进」的唯一证据——猜错会让 `full_fallback` 被当成普通 `done`，基线悄悄前移，那次没消化的变化就永久失明。

**为什么这比「多写点重试」重要**：原生全量实测约 174 分钟（`job-mvt1mrvu-6`：queued 29.2 + articles 66.0 + crosscut 10.0 + review 68.9 分钟）。在任何一小时级别的长任务里，「崩了就全丢」等于「重试平均打水漂一半」，而且失败轮永远不产生增量状态，第二次一定还是全量。

### 新增回归

`test-engine-python-entry.mjs` 两条（用真 venv 直接调 `_classify_exception`）：

- 「异常分类：中途崩溃时已写文章降 partial 交付，产物目录要带出去」——docsDir 里放 2 篇 .md + `temp/update-record.json`，断言 `outcome==='partial'`、`writtenCount===2`（`temp/` 下记账文件不算文章）、`artifacts.docsDir` 非空、`error.code==='engine-crashed'`、`blockers[0].kind==='article-failed'`。
- 「异常分类：一篇没写出来时仍是 failed，不许用空产物冒充 partial」。

**探针踩坑（写进测试注释）**：`entry.py:99-131` 在**导入时**就把 `sys.stdout` 换成了只放行协议行的 `_ProtocolOnly()` 替身，所以探针里 `print(json.dumps(res))` 会被改道到 **stderr**，Node 侧 `raw.stdout` 永远是空串。取结果必须显式 `pathlib.Path(outFile).write_text(...)` 再读文件。

**反向验证**（逐条红）：把两条分支还原成 `failure(...)` → `FAIL 异常分类：中途崩溃时已写文章降 partial 交付，产物目录要带出去`（`1 !== 0`）、`18 passed, 1 failed`；恢复后 `19 passed, 0 failed`。

## 0.16.7 — 2026-10-30

### 修复：Spec 评审确认的六条契约缺陷（含两条「设置项静默失效」）

`/code-review` 双轴评审（基准 `main`，142 文件 / +29009-4757）中，Spec 轴报出 6 条与 `docs/fsoft-native-engine.md` 不符的项，逐条回代码核实后全部成立并修复。其中 P1/P2 属于「设置或语义静默失效」——用户改了设置、系统也接受了，但行为完全没变。

| # | 缺陷 | 根因 | 修法 |
| --- | --- | --- | --- |
| P1 | `articleLanguage` 在默认（原生）通道完全失效，引擎永远按英文写 | `index.js` 的 `startNativeRun → runNativeJob` 入参没有 `language`；`nativeEnginePlan` 不接；`entry.py` 的 `config["agent_instructions"]` 只设了 `exclude_patterns`。上游 `config.py:179` 的 `language` property 读的正是 `agent_instructions.language` | `index.js:2659` 传 `language: job.language`；`native-run.js` 签名/payload 收 `language`（空值整个字段不写，保持上游默认）；`entry.py` 取 `payload.language` 后写进 `agent_instructions.language` |
| P2 | `engine-timeout` 被静默改名成 `engine-error`，超时语义在终态与面板里丢失 | `client.js:381/387` 把 `{kind:'engine-timeout'}` 当 blocker，但 `BLOCKER_KINDS` 没登记它，`normalizeBlocker` 走 `else → 'engine-error'` | `lib/engine/contract.js` 的 `BLOCKER_KINDS` 追加 `engine-timeout`（只追加不改名，符合「枚举只许追加」约定） |
| P3 | `cancel` 动作出参是一整份 `EngineResult`，契约要求 `{cancelled:boolean}` | `entry.py` 的 `handle_request` 直接 `return _cancelled_result(...)` | 改成 `return request_id, {"cancelled": True}`；cancel 是控制面动作，回 EngineResult 会让下游把它当成「这轮编译结束了」 |
| P4 | `doctor` 出参缺 `checks:[{name,ok,detail}]`，上层拿到 `done` 也不知道过了哪几项检查 | `entry.py` 的 `action_doctor` 只回 EngineResult 形状 | 三个分支（正常/pip 不闭合/引擎缺失）都补 `checks`；`contract.js` 新增 `normalizeChecks()` 做归一（非数组→`[]`、缺 name 丢弃、`ok` 只认布尔 `true`），`engineResult()` 带出 `checks` |
| P5 | `keptCount`/`removedCount`/`unmappedCount` 恒 0，`settle()` 与最终 `settle` 都不带 | `entry.py` 四处结果构造硬编码 0；`native-run.js:157` 的 `base` 与 `:866` 的最终 `settle` 都没有这三项 | `entry.py` 新增 `_counts_of(adapter)`：`keptCount` = `verdicts` 里 `no-op` 的页数、`removedCount` = `pages_removed` 去重、`unmappedCount` = `repair.orphans` 长度；`_done_result` 接 `counts`；`native-run.js` 两处 `settle` 补三字段 |
| P6 | 改契约未升 `ENGINE_CONTRACT_VERSION`，也没同步测试 | `contract.js` 版本停在 1；`test-engine-contract.mjs` 断言 `=== 1` | 升到 `2`；`entry.py` 抽出 `CONTRACT_VERSION = 2` 常量替换 5 处字面量（避免「同一进程报两个版本」）；同步测试断言 |

**顺带修掉的自造 bug**：P1 首次落地时 `config["agent_instructions"]` 展开 `language` 的位置**排在** `language = str(payload.get(...))` 赋值之前，会抛 `UnboundLocalError`。已把取值上移到 `config = dict(cfg)` 之前，并在注释里写明踩坑原因。

**同时修正的文档自相矛盾**（Standards 轴 S1/S2/S3）：

- `docs/fsoft-native-engine.md:139` 与 `lib/engine/native-run.js:16` 的不变量 4 都还写着「partial/failed 一律不推进基线」，而实现从 0.16.1 起允许 **有产物的 partial** 推进——这两处注释/文档正是 0.16.1 改代码时漏改的。现统一表述为「`done` 一律推进；`partial` 仅在 `rawTreeFiles > 0` 时推进；`failed`/`cancelled` 不动」，并写明死循环的实际后果。
- `README.md:27`/`:57` 同款表述一并修正；`:112` 的 `nativeEngineTimeoutMs` 默认值从「`10800000`（180 分钟）」改为「`0`（= 用默认 180 分钟）」——`index.js:92` 的实现值就是 `0`，靠 `native-run.js:83` 兜底，数值等效但写法不是实现。
- `README.md:252` 补 `articleLanguage` 在两条通道的生效路径。

**新增回归**（4 处，均已反向验证）：

- `test-engine-native-job.mjs` 用例 18：`language` 必须进引擎 payload（`language: '中文'` → payload 带 `中文`；不传 → 字段整个不出现）；用例 19：三计数必须透传（7/3/2 原样到终态）；用例 20：`engine-timeout` 不许被改名、未登记 kind 仍须降级。
- `test-engine-python-entry.mjs`：cancel 断言改为「出参是 `{cancelled:boolean}` 且不含 `outcome`/`blockers`」；新增 doctor `checks` 两项用例（真实 venv 至少 import/python/pip 三项，且 `ok` 必须是布尔、`detail` 必须有内容；归一函数对非数组/缺 name/字符串 `'true'` 的处理）。
- `test-engine-contract.mjs`：版本断言升 2。

**反向验证（逐条，全部当场跑出红）**：去掉 payload 的 `language` 展开 → `✗ 引擎 payload 必须带 language=中文（实际 undefined）`、`110/111`；`BLOCKER_KINDS` 移除 `engine-timeout` → `✗ BLOCKER_KINDS 必须含 engine-timeout`、`✗ blocker kind 必须原样保留（实际 engine-error）`、`109/111`；最终 `settle` 去掉三计数 → 三条 `✗`、`108/111`；`cancel` 改回 `_cancelled_result` → `FAIL 协议：cancel 出参是 {cancelled:boolean}`、`16 passed, 1 failed`；doctor 去掉 `checks` → `FAIL doctor：出参必须带 checks`、`16 passed, 1 failed`；版本改回 1 → `FAIL 契约版本是显式数字`、`18 passed, 1 failed`。全部 `cp` 备份恢复后复绿。

**全量回归**：`ok suites: 28`、`failed suites: test-wiki-anchors.mjs`（红项仍是 `.codewiki` 文章锚点滞后于源码，随一次成功编译消失）。

## 0.16.6 — 2026-10-30

### 修复：仓库清单落点只看目录，测试会把 fixture 路径写进真实宿主清单

**现象**：真机 `%TEMP%/dsh-codewiki-repos.json`（自动更新的已知仓库清单）里出现 `%TEMP%/cw-orch-txSQbO` 这类**目录早已不存在**的 fixture 路径，且每次跑完测试都会多几条。自动扫描每轮都要对它们空跑 `hasCompilableSources` / `isWorktreeCwd` 探测，面板上的「扫描 N 个仓库」也因此虚高。

**根因**：`REPOS_FILE` 原先按**目录**推导——`path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')`。但测试通过 `DSH_CODEWIKI_JOBS_FILE` 换掉的是**文件名**（`dsh-codewiki-jobs-test-<pid>-<token>.json`），目录仍是系统临时目录，于是测试与被测产品推导出**同一个**宿主清单文件：测试里 `rememberRepo()` 登记的 fixture 仓库、`fs.unlinkSync(reposFile)` 的清理，全部作用在真实宿主的清单上。`test-orchestration.mjs` 自己也有两处同样写死 `dirname(JOBS_FILE)` 的推导，属于测试与产品同错共振。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `index.js` | 新增 `export function reposFileFor(jobsFile, explicit = null)`：显式环境变量最优先；否则把文件名里的 `-jobs` 换成 `-repos`（无 `-jobs` 时追加 `.repos`）；`REPOS_FILE = reposFileFor(JOBS_FILE, process.env.DSH_CODEWIKI_REPOS_FILE || null)`。默认形态（`dsh-codewiki-jobs.json`）仍推导出原路径，既有登记不丢 |
| `test-orchestration.mjs` | 三处硬编码推导改为 `reposFileFor(JOBS_FILE)`（`import` 增加该导出） |
| `test-repos-isolation.mjs` | 新增回归：隔离 JOBS_FILE 后 `REPOS_FILE` 必须换路径、默认形态仍指向宿主清单、显式环境变量最优先，并**实证**跑一遍 `apply()` 后宿主清单逐字节未变 |

**反向验证**：把 `reposFileFor` 改回 `path.join(dir, 'dsh-codewiki-repos.json')` → `✗ 隔离 JOBS_FILE 后 REPOS_FILE 必须换路径`、`✗ 宿主清单必须逐字节未变（测试不得污染真实宿主）`、`FAIL：2 项未通过`；恢复后全绿。回退运行当场就把宿主清单从 2 条冲成 1 条失效 fixture 路径——缺陷可复现，不是纸面推断。

**全量回归**：`ok suites: 28`、`failed suites: test-wiki-anchors.mjs`（wiki 文章滞后于源码，重编译后消失）。

## 0.16.5 — 2026-10-30

### 修复：原生通道超时预算低于真机耗时（45 分钟 → 180 分钟），且超时抢救一直失效

**现象**：本仓库连续 25 条原生通道任务**没有一条成功**，最近六条 `kind=stale` 全部卡在同一处：`nativePercent: 54`、`nativeMessage: "Documentation Generation"`、articles 阶段 45.0~48.1 分钟后 `引擎在 2700000ms 内未完成（进程树已终止）`、`writtenCount: 0`、一篇都没写出来就失败。面板上永远是「过期 → 自动编译 → 又失败 → 还是过期」，看起来像自动更新根本没生效。

**根因（两条独立缺陷叠加）**：

1. **超时预算低于物理耗时**。`DEFAULT_ENGINE_TIMEOUT_MS = 45 * 60 * 1000` 是阶段 1C 按小 fixture（约 1 分钟）估的。真机实测 `job-mvt1mrvu-6`（本仓库唯一一次真正跑完的编译，走旧兼容通道）分阶段耗时：`articles 66.0min` + `crosscut 10.0min` + `review 68.9min` + `queued 29.2min` ≈ **174 分钟**。按 45 分钟给预算，等于在阶段 3「Documentation Generation」刚开头（`percent_of(3, 0.0)` = (0.40+0.20)×90 = **54%**）就砍掉进程——这不是编译失败，是预算低于物理耗时，重试多少次都必然一样。
2. **超时抢救路径在真机上从未生效**。0.16.1 已给 `lib/engine/client.js:368` 加了「超时但有进度 → partial」，判据是 `reader.progress.at(-1)?.writtenCount > 0`。但 `lib/engine/python/entry.py` 的 `bridge_progress()` 三处 `emit_progress(...)` 都**没传 `written` 参数**（默认 0），进度帧里的 `writtenCount` 恒为 0，于是这条分支永远走不进去——即使引擎真的写出了文章，也被记成 `failed` + `writtenCount: 0`。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `lib/engine/native-run.js:83` | `DEFAULT_ENGINE_TIMEOUT_MS`：`45 * 60 * 1000` → `180 * 60 * 1000`，注释写清实测数据与「预算低于物理耗时等于永远失败」的教训 |
| `index.js:92` | `nativeEngineTimeoutMs` 配置描述同步（0=默认 180 分钟），并说明超时按 partial 抢救已写文章 |
| `lib/engine/python/entry.py:411-497` | `bridge_progress(..., docs_dir)` 新增必给 `docs_dir`；新增 `_doc_fingerprints(docs_dir)` 与 `written_now(force=False)`，每帧带**本轮真实改动篇数** |
| `test-engine-native-job.mjs` | 新增用例「默认引擎超时必须覆盖真机全量实测耗时」 |
| `test-engine-client.mjs` | 新增「超时但有进度 → partial」「超时且零进展 → 仍 failed」两条协议用例 |
| `test-engine-python-entry.mjs` | 新增「writtenCount 必须是本轮真实改动篇数」与「普通 update 帧节流」两条用例 |

**为什么 `writtenCount` 用「指纹差」而不是篇数净差**：增量轮通常**原地重写**同一批路径、篇数不变，净差会把真实改动记成零进展；也不能直接用 docs 目录的绝对篇数——增量轮进场时 docsDir 已被 Node 侧 `hydrateDocsDir` 灌入上一轮文章，零进展轮也会报几十篇，导致误判 partial 并推进基线，比不报更坏。所以按「进场时的 `(size, mtime_ns)` 指纹表 vs 当前指纹表」算真实改动（新增/改写/删除都计），并加 2 秒节流（start/complete 帧强制重算，普通 update 帧复用）避免每帧全树遍历拖慢编译。

**验证**（当轮输出）：

- `node test-engine-native-job.mjs` → `102/102 通过`，含 `✓ 默认超时 180 分钟 ≥ 真机实测 174 分钟`、`✓ 未显式配置时通道沿用默认超时（实际 10800000）`、`✓ 显式 nativeEngineTimeoutMs 仍优先（实际 12345）`。
- `node test-engine-client.mjs` → `26 passed, 0 failed`，含 `✓ 进程：超时但有进度 → partial（已写的文章要救回来，不能判 failed）`、`✓ 进程：超时且零进展 → 仍判 failed（不能把空轮伪装成 partial）`。
- `node test-engine-python-entry.mjs` → `15 passed, 0 failed`，含 `✓ 进度帧：writtenCount 必须是本轮真实改动篇数（超时全靠它判 partial）`、`✓ 进度帧：普通 update 帧节流（不能让每帧都全树遍历拖慢编译）`。
- **反向验证**（每条都先红后绿）：把默认超时改回 `45 * 60 * 1000` → `✗ 默认超时 45 分钟 ≥ 真机实测 174 分钟`、`101/102 通过，1 失败`，恢复后 `102/102`；把 `emit_progress(..., written=written_now())` 还原成不传 written → `FAIL 进度帧：writtenCount 必须是本轮真实改动篇数`、`13 passed, 1 failed`；改成只算净篇数差 → 同样 `FAIL`；把节流条件改 `if False:` → `FAIL 进度帧：普通 update 帧节流（紧凑 update 必须节流掉遍历：13 次遍历 / 12 帧）`。三次 `cp` 备份恢复后均回到 `15 passed, 0 failed`。
- 全量：27/28 套件 `ok`；唯一 FAIL 仍是 `test-wiki-anchors.mjs`（wiki 文章引用的 `index.js` 行号越界 / 符号已不存在），属文档滞后于源码，重新编译后消失。

---

## 0.16.4 — 2026-10-30

### 修复：孤立 gitlink 被当成源码，引擎编译超时零产出

**现象**：任务 `job-mvtkkua9-4`（`kind=stale, scope=auto`）跑了整整 45 分钟（`DEFAULT_ENGINE_TIMEOUT_MS = 45 * 60 * 1000`）后被进程树终止，`writtenCount: 0`、`failedCount: 0`，notes 只有一句「任务终态：失败（无可用成果）」。同一时间段里 `/api/codewiki/repos` 里该仓库一直是 `state: stale`，看起来就像「过期了、也真的去编译了、但永远编译不出文章」。

**根因**：`.probe-fsoft/src` 是开发期探针克隆（上游 `FSoft-AI4Code/CodeWiki`，18MB / 186 个文件），它以**孤立 gitlink**（索引里 mode `160000`，但没有 `.gitmodules` 登记）的形式被误提交进了本仓库。这带来两个叠加后果：

1. 它是 **tracked** 的，所以引擎的 `use_gitignore=True` 拦不住它——gitignore 只管未跟踪文件；
2. 它又不是本仓库源码——`git checkout` 永远恢复不出内容，克隆本仓库的人只拿到一条指针。

于是引擎把那个无关子仓库整个当成源码建图、聚类，`job.nativeLogs` 里成片刷出 `Skipping invalid leaf node '.probe-fsoft/src/codewiki/mcp/server.py::main' - not found in components`（`session.py::SessionStore`、`workspace.py::SessionWorkspace`、`mcp/tools/*.py` 同样中招），编译预算全耗在它身上，最终撞上超时上限被强杀。本仓库真正的源码只有 7 个 `.py`。用真实引擎分析器复现：排除前源码面 239 个文件、其中探针占 186 个；排除后 53 个文件、探针 0 个。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `lib/engine/python/entry.py` `dangling_gitlink_patterns(repo_path)` | 新增：`git ls-files --stage -z` 取 mode `160000` 条目，减去 `.gitmodules` 已登记的路径，只留下**孤立** gitlink。读不到索引/git 缺失/超时一律返回空列表——排除是优化，不能成为编译的前置条件 |
| `lib/engine/python/entry.py` `source_exclude_patterns(repo_path=None)` | 签名扩展：给了仓库路径就并入孤立 gitlink；省略时保持旧语义（只返回 `.codewiki`/`CodeWiki.md`），旧调用方不受影响 |
| `lib/engine/python/entry.py:555` | `config["agent_instructions"]["exclude_patterns"]` 改为传 `repo_path` |
| `.gitignore` | `.probe-fsoft/venv/` → `.probe-fsoft/`（整个探针环境不入库，并写明这个教训） |
| git 索引 | `git rm --cached .probe-fsoft/src`：移除误提交的 gitlink。磁盘上的探针目录**保留**，venv 照常可用于引擎测试 |

**为什么不排除正规 submodule**：`.gitmodules` 里登记过的子模块是项目架构的一部分，改变其既有语义不在本次缺陷范围内；这里只收「没有 `.gitmodules` 就永远 checkout 不出来」的孤立指针。

**验证**（当轮输出）：

- 新增用例「源码面：孤立 gitlink（无 .gitmodules 的嵌套仓库）必须排除出源码分析面」（`test-engine-python-entry.mjs`）：建真实嵌套仓库 + `git add` 形成 gitlink，用真实 `RepoAnalyzer` 走一遍，断言路径进排除清单、其内部文件不进文件树、常规源码仍在、省略 `repo_path` 时语义不变；并追加一段：写了 `.gitmodules` 登记之后该路径**必须**回到源码面。
- **反向验证**：把 `if repo_path is not None:` 临时短路成 `if False:` → `FAIL  源码面：孤立 gitlink（无 .gitmodules 的嵌套仓库）必须排除出源码分析面`、`12 passed, 1 failed`；恢复后 `PASS  源码面：孤立 gitlink ...`、`13 passed, 0 failed`。
- 真实引擎复现：`.probe-fsoft/venv/Scripts/python.exe` 跑 `RepoAnalyzer`，修复前 `{"total_files": 239, "probe_files": 186}`，修复后 `{"patterns": [".codewiki", "CodeWiki.md", ".probe-fsoft/src"], "total_files": 53, "probe_files": 0}`，本仓库 7 个 `.py` 全部仍在。
- 全量：27/28 套件 `ok`；唯一 FAIL 仍是 `test-wiki-anchors.mjs`（wiki 文章引用的 `index.js` 行号越界 / 符号已不存在），属文档滞后于源码，重新编译后消失。

---

## 0.16.3 — 2026-10-30

### 修复：自动更新链路的五处缺陷（幂等、缓存、清单清理、口径、工作区语义）

**背景**：0.16.2 修好「调度器只扫 job 历史」之后，继续逐项审查自动更新链路，发现仍有五处会让「过期了却没人编译 / 编译了却看不见」的问题。

**修改**：

| 位置 | 缺陷 | 改动 |
| --- | --- | --- |
| `index.js:467` `normPathKey` | 无条件 `toLowerCase()`，在 Linux/macOS 上把 `/home/u/Foo` 与 `/home/u/foo` 判成同一仓库，幂等吞任务、清单少登记 | 只在 `process.platform === 'win32'` 时小写化 |
| `index.js` `submit` / `findActive`（`index.js:3838`） | 用严格 `j.cwd === cwd` 比较，未归一化；同一仓库以尾分隔符或盘符大小写不同写法出现时并发两条任务，破坏单项目串行与自动调度幂等 | 统一用 `normPathKey` 比较 |
| `index.js:484-506` `hasCompilableSources` | 「无源码」也缓存 600s，自动路径不调用 `clearSourceProbeCache`；一旦误判成空壳就静默跳过 10 分钟 | 新增 `DSH_CODEWIKI_SOURCE_PROBE_EMPTY_TTL_MS`（默认 60s）：`has=true` 仍缓存 10 分钟，`has=false` 只缓存 60s |
| `index.js` 启动清理 | `rememberRepo` 只追加；掉出 `MAX_JOBS_KEPT` 的失效目录永久留在 `REPOS_FILE`，每轮被重扫、清单无界增长 | 启动时整写一次 `loadKnownRepos().filter((dir) => isDeadCompileTarget(dir) === false)` |
| `index.js` `schedState` + `/api/codewiki/repos` | 幂等命中不设 `submitted`，面板「扫到 N 仓、提交 0」看不出是在编译还是无事可做 | 拆成 `lastScanSubmitted` / `lastScanBusy` / `lastScanNoop` / `lastScanSkipped` 四个口径 |

### 修复：自动调度现在遵守 `workspaceOnly`（默认开）

**问题**：`wsFilterPaths()` 只用于 `/api/codewiki/jobs` 与 `/api/codewiki/repos` 的**展示过滤**，`autoScan` 完全不用它。于是被移出 dsh 工作区清单的仓库仍会被后台定时编译、产物悄悄写进它的 `.codewiki/`，而面板上根本看不到这条任务——用户既不知道它在编译，也无法取消。

**修改**：

- 新增导出函数 `workspaceFilterPaths(registry, config)`（`index.js:4506`）：注册表不可用或 `workspaceOnly === false` 时返回 null，`list()` 抛错时告警降级（过滤是体验优化，不能拖垮端点）。`installWebServer` 内改为复用它，端点行为不变。
- `apply()` 新增 `schedWorkspaceRegistry`，经 `ctx.inject(['workspaceRegistry'], ...)` 取宿主注册表；`autoScan` 在排除清单判定**之前**加闸门：命中工作区外则 `lastScanSkipped++` 并跳过。只影响「是否新提交」，不打断进行中的编译。
- `client.js` 面板统计串新增「工作区外跳过 N」，中英词表各补 `skippedLabel`——否则「清单里有 N 个仓库、扫到 M 个」的缺口无法解释。

**验证**（当轮输出）：

- 新增用例「幂等：同一仓库以不同路径写法提交只允许一条活动任务」（`test-orchestration.mjs:1595` 起）：首轮实测红（`✗ 幂等命中：cwd 尾分隔符 ... 实际 submitted=true jobId=job-mvtqhcrj-1`、`✗ ...盘符大小写不同...`、`FAIL：2 项未通过`），修复后转绿（`✓ ... submitted=false jobId=job-mvtqjzyq-0`、`PASS：编排冒烟全部通过`）。
- 新增用例「空判定缓存必须短暂」（`test-worktree.mjs`）：`✓ 空判定在 TTL 内仍走缓存（不立刻反转）`、`✓ 空判定 TTL 过后重新探测：补回源码即恢复 === true`。
- 新增用例「自动调度遵守 workspaceOnly：工作区外仓库不被后台编译」：**反向验证**——把闸门临时短路成 `if (false && ...)`，立刻红（`✗ 工作区外仓库未被自动提交（实际 1 条：[{"kind":"full","stage":"crosscut"}]）`、`✗ 面板可见工作区外跳过计数（实际 0）`、`FAIL：2 项未通过`）；恢复后转绿（`✓ 实际 0 条`、`✓ 跳过计数 1`）。
- 全量：27/28 套件 `ok`；唯一 FAIL 是 `test-wiki-anchors.mjs`（wiki 文章引用的 `index.js` 行号越界，源码已从 5079 行长到 5095 行），属文档滞后于源码，重新编译后消失。

---

## 0.16.2 — 2026-10-29

### 修复：自动更新只扫任务历史，已编译仓库被截断后再也不自动编译

**问题**：自动更新调度器（`autoUpdate`）在 `index.js:4989` 只从 `service.list()` 取 cwd——也就是**当前 job 历史**里的工作区。但 job 记录会被 `MAX_JOBS_KEPT=30` 截断、启动时还会清掉 Temp 目录的终态任务，于是「编译过一次、后来没再手动编译」的仓库一旦掉出历史，就永久退出自动扫描：面板上仍显示它 `state: stale`、过期文章数一屏，可 `lastScanRepos` 里根本没有它，`lastScanSubmitted` 恒为 0。用户看到的现象正是「过期了却不会自动更新文章」。

同一份插件里早有独立的持久清单 `REPOS_FILE`（`loadKnownRepos()` / `rememberRepo()`，`index.js:2028-2050`），`/api/codewiki/repos` 总览接口也一直是用「job 历史 ∪ 已知仓库」拼出来的（`index.js:4591`）——只有调度器漏用了它。

**修改**：

| 文件 | 改动 |
| --- | --- |
| `index.js:4991` | 扫描来源改为 `loadKnownRepos() ∪ service.list()`（去重），并注释说明为何必须合并（历史会截断、启动会清 Temp 终态） |
| `index.js:5012` | 心跳间隔支持 `DSH_CODEWIKI_AUTO_SCAN_MS` 覆盖（下限 100ms），生产默认仍 60s——否则真实心跳没法在测试里等 |
| `test-orchestration.mjs:16` | 压到 100ms 的真实心跳，仍走 `apply()` 里那套 `autoScan`，不 mock 调度器 |

**验证**（当轮输出）：

- 新增用例「历史清空后，真实心跳仍扫描已知仓库并自动提交过期编译」：真 git fixture + mock LLM，先 `scope=auto` 全量编译一次并确认 `REPOS_FILE` 里有它 → **dispose 旧服务**再清空 `JOBS_FILE`（`mergeFromDisk()` 只增不删，运行中清盘造不出「历史为空」现场）→ 新起 `autoUpdate:true, autoUpdateMin:5` 的服务 → 改 `core/core.py` → 断言 `cw status` 已是 stale，再等心跳。
- **反向验证**：把 `index.js:4991` 临时改回旧实现（只扫 `service.list()`），该用例立刻红（`✗ ...（现场 []）`，`FAIL：1 项未通过`）；恢复修复后转绿（`✓ ...（现场 [{"scope":"auto","kind":"stale","stage":"articles"}]）`）。证明它抓的正是这条缺陷，而不是恰好通过。
- 全量：`node test-orchestration.mjs` → `PASS：编排冒烟全部通过`（exit 0）。前序用例遗留的活动态 fixture 任务会占住单项目串行闸门（初始化一直 `queued`、wiki 从未编译出来），因此本用例把清盘动作放在 `apply` 之前，并新增「初始化必须到 done」与「心跳前判态必须已过期」两条前置断言，避免把排队失败伪装成判态 bug。

---

## 0.16.1 — 2026-10-29

### 修复：允许 partial 推进基线，打破编译死循环

**问题**：引擎超时时（articles 阶段 2700000ms 超时），35 篇文章已写入但 `_meta.yaml` 基线未更新（`last_compiled_commit` 仍指向上次提交）。由于 `canAdvanceBaseline` 仅在 `done` 时为 true，partial 状态永不推进基线，导致每轮编译都全量重跑，形成死循环。

**修改**：

| 文件 | 改动 |
| --- | --- |
| `lib/engine/native-run.js:169` | `canAdvanceBaseline` 允许 `partial` + `rawTreeFiles>0` |
| `lib/engine/quality-gate.js:552` | `canAdvanceBaseline` 允许 `partial` + 有文章写入 + 无 defect/degradation |
| `lib/engine/apply-plan.js:656` | 删除 `problems.length===0` 条件（质量门已裁决） |
| `lib/engine/client.js:368` | **关键修复**：超时后检查 `reader.progress`，有 `writtenCount>0` 时返回 `partial` 而非 `failed` |

**验证**：

- `test-engine-native-job.mjs`：99/99 通过
- `test-engine-native-incremental.mjs`：96/96 通过
- `test-engine-quality-gate.mjs`：29/29 通过
- 全量回归：所有功能测试通过（test-wiki-anchors 的 10 败为历史文档引用错误，待下次 codewiki_generate 重编译修复）

**提交**：`dec253e4`

---

## 0.16.0 — 2026-10-29

### 阶段 7 受控退役：原生引擎转正为默认通道，删除 Node 侧重写的 FSoft 算法

用户明确指示「可以删除」。0.15.0 时的决定是「两条通道都保留、`nativeEngine` 默认 `false`」，
理由是留住回退路径且符号级增量只有 Node 侧实现——本版推翻该决定：同一套算法（符号提取、
聚类、图 diff、增量裁决、更新规划）在 Node 侧维护一份、Python 侧再由上游维护一份，等于
每次算法演进要改两处、验证两遍，而 Node 版无法自证与上游一致（0.13.2 那次靠 78 条黄金
对拍才发现偏差）。真实验收（0.15.0 八场景）已覆盖迁移目标，退役前置条件解除。

**默认值切换**

- `index.js` Config：`nativeEngine: z.boolean().default(false)` → `default(true)`；
  `liveConfig` 判定 `val(c.nativeEngine) === true` → `val(c.nativeEngine) !== false`
  （未设置即视为开启，与其它布尔项口径一致）。
- `client.js` 提示文案同步：`nativeEngine` 相关说明改为「0.16.0 起默认开启」。

**删除被替代的实现**（合计 2627 行）

| 删除文件 | 行数 | 被谁替代 |
| --- | --- | --- |
| `lib/symbols.js` | 884 | 原生引擎 Python 侧符号图 |
| `lib/cluster.js` | 467 | 原生引擎模块树构建 |
| `lib/graph-diff.js` | 578 | 上游 `updater/graph_diff.py` |
| `lib/incremental.js` | 206 | 原生引擎增量裁决 |
| `lib/update-planner.js` | 492 | 原生引擎 ownership / stale scan |

连带删除 7 套测试：`test-symbols.mjs`、`test-cluster.mjs`、`test-graphdiff.mjs`、
`test-incremental.mjs`、`test-incremental-e2e.mjs`、`test-update-planner.mjs`、
`test-semantic-plan.mjs`（该套测的是 `cluster.js` 的 `semanticPlan`）。

**`index.js` 侧清理**

- 删 `semanticPlan()`（AST 提取 → LLM 聚类 → 模块清单）与 `extractCurrentGraph()`。
- 删 `slimPlanForJob()`、`loadModuleMap()`、`saveModuleMap()`、`tickIndex` 里的符号快照写入。
- 新增 `attributeChanges(changeSet, articles)`：文件级归属判定，返回 `{unmapped, touched}`
  ——变更集里每个源码路径只要被某篇既有文章的 `source_files` 认领（或它是一次 `git mv`
  改名的源路径）就算「已消化」；`touched` 是认领了变更的文章名集合。
- `runStaleUpdate` 与「stale 但解析不出过期文章」两条分支重写：任务清单 = 「`source_files`
  命中变更的文章」∪「`cw status` 报出的过期文章」；`blockers` 只保留未归属源码变更；
  两处 `svc.submit` 不再传 `updatePlan`。
- `job.updatePlan` 字段保留但恒为 `null`（兼容已落盘旧 jobs、面板与 `update-record` 的读法），
  终态判定由 `judgeOutcome` 的 `expectedNames` 通道承担。
- `localPlan()` 由 `buildPlan()` 直接调用（不再有 `planMode==='auto'` 分支），注释写明它只
  服务 `nativeEngine=false` 兼容通道。
- `planMode`、`symbolIncremental` 两个配置项**保留但已无实际效果**（仅兼容既有
  `settings.json`），`description` 与 `client.js` 表单提示改写为「已退役」，不再声称提供
  语义聚类/符号级增量。

**保留**：`lib/agentic.js`、`lib/agentic-host.js`、`lib/articles-agentic.js`（agentic 写作
通道，兼容通道仍用）、`lib/article-contract.js`（两条通道共用的文章契约）、
`lib/change-set.js`（四路变更采集）、`lib/update-record.js`（可机读更新记录）、
`lib/git-paths.js`、`lib/engine/`（原生引擎适配层，全部保留）。

**已知能力损失**（如实记录）：`nativeEngine:false` 从「功能对等的第二套实现」降级为
「最小兼容通道」——只按顶层目录分组、只做文件级 `source_files` 归属判定，没有反向依赖
闭包、没有纯注释跳过、没有新文件 ownership 路由。改一个被 10 篇引用的函数，兼容通道只会
重写直接认领它的那一篇。需要符号级增量请用原生通道。

**测试**：`node --check index.js client.js` 通过；`import('./index.js')` 成功（46 个导出）。
剩余 28 套测试逐个实跑：**27 套全绿、退出码 0**。`test-orchestration.mjs` 需把
`LEGACY_CHANNEL` 补上 `nativeEngine: false`（该文件守护的是兼容通道的请求次数与落盘时序，
不钉住会被默认值切换带到原生引擎上）；`test-wiki-anchors.mjs` 默认档
**3315 过 / 7 败 / 123 待重编译**，7 条失败全部是 `.codewiki/` 文章引用了已删除的符号
（`saveSnapshot`/`sameSnapshotContent`/`runEngine`/`rawCode`/`ENGINE_CONTRACT_VERSION`/
`inspectArticle`）或行号越界，属文档滞后，按纪律不手改文章、留待重编译覆盖——与 0.15.0
的基线（5 败）相比新增的 2 条正是本次删除造成的，重编译后消失。

## 0.15.0 — 2026-10-29

### 原生引擎通道通过真实生产验收（阶段 6/7）：八场景真跑 + 修掉 8 个只有真机才暴露的缺陷

用**真实** Python venv（Python 3.12.10、`codewiki 2.0.0`、`pip check` 零破损、源码锁上游 commit `03d0a294ad58f3c878bd8aeb0ef5e95a2ff8c3ca`）+ **真实** `workbuddy` 模型（经 `lib/engine/llm-bridge.js` 转发真凭证真云端）跑完整生产链路（`codewiki_generate` 工具 → JobService → `lib/engine/native-run.js`），fixture 是 `tools/fsoft-engine/fixtures/中文 空格 fixture` 的临时 git 副本（含中文与空格路径）。八场景实测：

| 场景 | 终态 | 关键数字 |
|------|------|----------|
| 全量编译 | `done` | 241s、written 13、`commit.scope.ok=true`、工作区干净 |
| 已提交改动的 stale 增量 | `done` | 10.7s（全量的 ~4%）、written 9、无 `_native-state` 自嵌套 |
| 工作区未提交改动 | `partial` | `uncommitted-input` 记账、基线不推进、文章照写 |
| 重命名（`git mv` + 类改名） | `done` | 3 条变化、新增并重写模块页 |
| 删除模块 | `done` | 孤儿页在同提交清理（3 篇 → `fixture-boot.md`/`fixture-web.md`） |
| 取消（`POST /api/codewiki/control`） | `cancelled` | 基线不推进、HEAD 不变 |
| 解释器路径不存在 | `failed` | stage=env、原始 ENOENT 带出 |
| 无变化轮（连跑两轮） | `done` 零副作用 | `written 0`、`commit.noChanges=true`、HEAD 不变、`git status` 空 |

**真机才暴露、本轮修掉的 8 个缺陷**（假引擎测试一条都测不出，因为 `test-fixtures/fake-native-engine.mjs` 读平铺字段、自报 `no_change`、产物全是 ASCII 名）：

1. **非 ASCII 路径被误判越界**。`git show/diff --name-only` 默认 `core.quotepath=true`，中文路径变成八进制转义串，`verifyCommitScope` 按字面量判 `.codewiki/` 前缀失败 → 每次编译都被拉成 `partial`。新增 `lib/git-paths.js`（`withQuotepathOff` / `decodeGitPath` / `decodeGitPaths`），`apply-plan.js`、`change-set.js`、`index.js` 的路径读取全部改走它；只加参数挡不住已写进历史或外部传入的转义串，所以两层都要。
2. **引擎锁落在提交之外**。`writeLock` 在 apply（含自动提交）之后写盘，锁永远进不了提交、留成未跟踪脏文件，无变化轮也会因此产生提交。改为 `lockStatus==='absent'` 时把 `buildLockBody(doctor.current)` 塞进 apply 写集（与文章、受管状态共享同一 pre-image → 同回滚、同提交）。
3. **更新记录落在提交之外**。原生通道的提交发生在落地器内部，`saveRecord` 必然晚于提交 → 每轮留 `?? .codewiki/temp/update-record.json`。原生通道改为写到仓库外 `os.tmpdir()/dsh-codewiki-native-records/<jobId>/`（可用 `DSH_CODEWIKI_NATIVE_RECORD_DIR` 覆盖），面板仍读得到路径；旧 Node 通道不变（它的 `saveRecord` 本就在 `tickCommit` 之前）。
4. **协议字段位置不一致**。客户端按平铺发 `{requestId, action, ...payload}`（契约也是平铺），入口只读 `msg.payload` → `docsDir` 丢失，上游回退写进仓库 `.codewiki`，增量轮把受管状态水合成 `.codewiki/_native-state/docs/_native-state/docs/...` 逐轮自嵌套（实测 gate `unmapped:8 defects:14`）。`entry.py` 改为两种形状都认、平铺优先。
5. **入口 stdin 按 locale 解码**。客户端按 UTF-8 写请求行，Windows Python stdin 默认 cp936 → 中文仓库路径读成 `涓?鏂? 绌烘牸` 后报「仓库路径不存在」。入口把 stdin 也钉成 UTF-8（stdout/stderr 仍 `errors="replace"`，stdin 用 strict：坏字节当场报错，别把乱码路径带下去）。
6. **上游内部子进程按 locale 解码**。上游 `subprocess.run(..., text=True)` 在 Windows 用 gbk 解 UTF-8 路径，reader 线程抛 `UnicodeDecodeError` 使 `stdout` 变 `None`，`repo_analyzer.py:65` 直接 `AttributeError`。入口 import 后给 `subprocess.Popen.__init__` 补 UTF-8 编码兜底（只在 `text=True` 且未显式指定编码时生效）。
7. **无变化轮仍产生提交**。上游把 `.codewiki/_meta.yaml` 当源码组件分析（`use_gitignore=True` 但不排除 `.codewiki/`），图 diff 永远有 `body:1` → 永远 `incremental`，每轮一笔纯记账提交 + 白花 routing 模型调用（~528 prompt tokens / 3.5s）。入口给依赖分析传 `agent_instructions.exclude_patterns = ['.codewiki', 'CodeWiki.md']`（实测扫描面 24 文件 → 4 文件，wiki 产物命中 0），不影响 git 变化集、`cw index`、基线或 docsDir 输出。
8. **删除模块后孤儿页残留**。gate 只体检本次产物，而删除时上游可能回 `full_fallback` 且 `pages_removed: []`，描述已删代码的页永久留在库里还挂在 `_index.md` 上。新增 `apply-plan.js` 的 `findOrphanPages()`（`source_files` 非空且**全部**失效才判孤儿；空 source_files 与部分失效一律不动）与 `checkDeleteTargets()`，`applyNativeOutput({deleteFiles})` 让删除走落地事务（同 pre-image、同回滚、同提交、收空目录），`native-run.js` 在真的落地轮才扫（无变化轮不扫不删）。

**测试**：34 套全绿——`test-engine-native-job.mjs` **99/99**（+3 条真机断言：引擎锁进同一提交、提交清单是真实路径而非转义写法、落地后 `.codewiki` 工作区干净）、`test-engine-native-incremental.mjs` **82/82**、`test-engine-apply-plan.mjs` **41/41**（+3 条孤儿页语义）、`test-engine-python-entry.mjs` **12/12**（+2 条：平铺字段、非 ASCII 请求行）、`test-change-set.mjs` **16/16**（+1 条非 ASCII 产物不被当成源码变化），其余各套与改前一致。`node --check index.js` 通过。

**如实记录的未达成项**：

- **`workbuddy/hy3` 硬门禁未通过**。阶段 1B 第 4 条要求实测 `workbuddy/hy3`；当期 hy3 返回 `429 quota_exceeded`（“您的使用量已超出频率限制，将在 2026-10-29 14:23:38 UTC+8 重置”），故八场景真实验收用 `workbuddy/glm-5.3`。这属上游配额、不是适配层问题，但规格的硬门禁确实没满足——额度恢复后必须把 `batchModel` 改回 `hy3` 重跑八场景才算闭环。首两次重跑因此 `failed`（`Exceeded maximum output retries (3)`，engine 字段全空），未计入验收。
- **`test-wiki-anchors.mjs --strict` 未全绿**。本轮实测（2026-10-29，11 项修复全部落盘后重跑）：strict **3354 过 / 59 败 / 32 待重编译**，默认档 **3354 过 / 5 败 / 86 待重编译**。59 条构成：**34 条「指向空行」**（锚点行号落在空行、或区间内无代码）、**20 条「符号未绑定」**（`idleRound`/`symbolIncremental`/`runEngine`/`normalizeIndexLinks`/`normalizeArticlePath`/`resolveBinary`/`numberLines`/`reminderText`/`tickIndex` 等符号不在所引区间内）、**4 条「符号不存在」**（该符号在目标文件里 0 次出现）、**1 条「起始行越界」**（`test-wiki-anchors.mjs:778` 超出该文件当前 404 行）。按目标文件分布：`test-engine-apply-plan.mjs` 26 条、`index.js` 8 条、`README.md` 6 条，其余零散分布在各 `.codewiki/modules/*.md`。**主体是 `.codewiki/` 文章滞后于本轮代码，不是校验器缺陷**——按纪律不手改文章，留待一次真实全量重编译覆盖（重编译后基线前移，这些会自动升级为硬断言）。此前记录的「严格档 3234 过 / 63 败 / 33 待重编译」「默认档 2196 过 / 8 败」均已过期，以本次实测为准（总数从 3234 涨到 3354 是本轮新增测试断言带来的有效锚点增量，失败数 63→59 是修复过程中 `.codewiki` 基线随提交前移的结果）。
- **阶段 7 退役未执行，待用户决策**。规格 L93 要求「真实通过后才删除被替代的 Node 路径」；`nativeEngine` 当前默认仍为 `false`，旧 Node 流水线仍是主路，`symbols`/`cluster`/`graph-diff`/`incremental`/`update-planner` 一行未删。是否把原生通道切成默认通道、以及何时删旧路径，**由用户决策后再动**，本仓库不擅自切换。
- 上游 rung3 语义使**单模块内的方法级新增**不触发重写（component id 不在 tracked 集 → `untracked` → 不进 ownership），因此「增量改了文章」这一条用结构性变化（新增/删除/重命名）验证，而非方法级改动。

### 文档与默认策略（阶段 7）

- **旧 Node 流水线保留，`nativeEngine` 默认仍为 `false`。** Node 通道是默认路径也是原生通道的回退；两条通道共用落地器/质量闸/变化集/受管状态/文章契约，退役不会减少维护面。退役前置条件（尚未满足，故未执行）：原生通道在大仓（>2000 文件）与多语言混合仓跑通，且原生编译后 `--strict` 全绿。
- `README.md` 新增「原生引擎通道（0.15.0，可选，默认关闭）」整节：四环节分工、运行要求（Python 3.10+ 独立 venv + `pip check` 零破损 + 非 ASCII 路径两处编码修复）、四个新设置项、八场景真实验收表、8 条修掉的缺陷、4 条已知限制、保留/退役决定。原「不引入 Python 运行时」的表述已按事实改写（默认通道仍不需要 Python，原生通道需要）。测试清单从 18 个文件更正为 34 个并分通道列出。
- `docs/fsoft-native-engine.md` 新增「上游同步」章节：固定 commit 与如何升级、上游 changelog 要点、契约测试与 fixture 如何复现、真实编译怎么跑、回滚步骤。
- `cordis.patch.yml` 注释补齐 `autoCommit` 与四个原生键（含「不做找可用解释器」与「不悄悄换通道」两条硬规则）；`index.js` 里 `nativeEngine` 系列字段的描述与阶段注释同步为最终语义（full 与 stale 都接管，决议权在 native-run）。
- `package.json` `version` → **0.15.0**；`description` 改为如实描述两条通道与各自运行前提。

### 修复：main...HEAD 双轴 code-review 的 11 项发现（Spec 7 项 + Standards 4 项）

一轮 Standards + Spec 双轴审查（`main...HEAD`）在原生引擎通道上找出 11 项问题，本轮逐项处理：

**Spec 轴**

- **S1 上游锁 commit 抄错 38 位**。规格锁 `03d0a294ad58f3c878bd8aeb0ef5e95a2ff8c3ca`（40 位），仓库四处写成 38 位的 `03d0a294adf3c878bd8aeb0ef5e95a2ff8c3ca`（缺 `d58`）——那不是合法 git sha，锁定无从对账。四处（`docs/fsoft-native-engine.md:221`/`:266`、`CHANGELOG.md:7`、`README.md:85`）全部改为 40 位。
- **S2 manifest 指纹不含上游 commit**。原 `fingerprintOf()` 只哈希 `manifestVersion+version+pythonVersion`，而 `codewiki 2.0.0` 这个版本号写在上游 pyproject 里、换 commit 不变 → **换了引擎源码会被静默判成 match**。现在 `lib/engine/manifest.js` 导出 `UPSTREAM_COMMIT` 常量 + `normalizeUpstreamCommit()`（只认 40 位十六进制），`probeEnvironment()` 把它带进 facts、`fingerprintOf()` 哈希进指纹、`buildLockBody()` 落进 `.codewiki/engine-lock.json` 的 `upstreamCommit` 字段、`compareLock()` 逐字段比对（仅上游变也判 drift 并点名 `upstreamCommit`）；声明不合法时 `doctor()` 的 advice 明确写「本轮不构成有效锁定」。`test-engine-manifest.mjs` 新增 8 条（合法性、38 位/大写/空白归一、上游变化→指纹变化、锁可读回、drift 字段、doctor advice）。上游锁是**声明**不是探测结果，所以 `native-run.js` 显式透传 `upstreamCommit` 而不是等 probe 自报。
- **S3 阶段 7 退役未执行**（不是缺陷，是待决策项）。规格 L93 要求「真实通过后才删除被替代的 Node 路径」，当前 `nativeEngine` 默认 `false`、旧流水线仍是主路。本轮**没有删旧代码**：是否切成默认通道、何时删旧路径由用户决策。状态已写进本文件与 `README.md` 的「保留与退役」节。
- **S4 四路变更只落了 committed**。原实现把 staged/unstaged/untracked 记进 `state.json` 的 unconsumed，却仍让引擎按 HEAD 记账——产物反映工作区内容、账本指向 HEAD，正是「变化悄悄丢」的入口。新增 `lib/engine/workspace-snapshot.js`：`createWorkspaceSnapshot()` 用**独立的临时 `GIT_INDEX_FILE`**（在 `os.tmpdir()`，不碰用户 index）跑 `read-tree <parent>` → `add -A -- .` → `write-tree` → `commit-tree`，造一个挂在 HEAD 上的 commit 而**不写任何 ref**（实测 `git for-each-ref --contains <sha>` 为空、HEAD 不变、工作区仍脏、`git diff --cached` 仍空）；`native-run.js` 的 1.9 段在引擎启动前造快照，把本轮 `commitId` 指向它（无快照时退回 HEAD）。质量门相应增加 `consumedInputCommit`：产物对得上快照不再误报 `commit-mismatch`，但 `uncommitted-input` 照旧判 defect —— 快照不挂 ref，把它记成已提交基线是不可逆的，终态仍 `partial`、基线不推进。造不出快照不算失败（退回 HEAD 记账 + note）：快照是「对齐精度」的改进，不是编译成立的前提。`test-engine-native-incremental.mjs` 用例 3 新增 5 条断言（40 位 sha、parent 是 HEAD 祖先、快照本身不进 HEAD、引擎收到的 commitId 就是快照、无 `commit-mismatch`、无跳过文件）。
- **S5 strict 锚点未绿**。实测已如实记录并分析构成（见上文「如实记录的未达成项」第 2 条）：最新实测 59 败（34 指向空行 / 20 符号未绑定 / 4 符号不存在 / 1 越界），主体是 `.codewiki/` 文章滞后，**校验器代码不改**，留待真实全量重编译。
- **S6 原始树未独立保留**。原 `artifacts.rawTreeDir` 只指向 `module_tree.json` 单个文件，FSoft 整棵 docs 树被原地消费、无法回溯引擎原始输出。`lib/engine/native-state.js` 新增 `archiveDocsTree({docsDir, destDir})`（逐文件复制、双向重叠校验、失败只记 note——留档是证据不是产物），`native-run.js` 的 2.9 段在质量门前把 `outDocsDir` 整棵拷到仓库外（`os.tmpdir()/dsh-codewiki-native-raw/<requestId>`，可用 `DSH_CODEWIKI_NATIVE_RAW_TREE_DIR` 覆盖），`artifacts` 增 `rawTree`/`rawTreeFiles` 两字段（`contract.js` 同步），`index.js` 的 `job.nativeResult.artifacts` 一并带出，finally 只清临时 docsDir 不清留档。`test-engine-native-incremental.mjs` 用例 1 新增 8 条断言（落点在仓库外、不与落地产物重叠、含 `module_tree.json`/`metadata.json`/`modules/*.md`）。
- **S7 hy3 硬门禁被绕过**。已按事实写入「如实记录的未达成项」第 1 条：hy3 `429 quota_exceeded`，改用 `glm-5.3` 完成八场景，属**替代验证**而非符合规格，额度恢复后需重跑。

**Standards 轴**

- **R1 路径归一函数重复 5 份**（实为 6 处）。`String(p ?? '').replace(/\\/g,'/')` 复制在 `apply-plan.js`、`manifest.js`、`mapping.js`、`native-state.js`、`output.js`、`quality-gate.js`；全部收口到 `lib/git-paths.js:34` 的唯一 `export function toPosix(p)`，六模块改为 import（`toPosix` 或 `toPosix as posix`）。**故意不并的三处**语义不同，已在代码注释里写明理由：`article-contract.js` 的 `normalizeWritePath` 额外 `trim()+posix.normalize`、`change-set.js` 的 `normChangePath` 额外 trim + 越界判据、`incremental.js` 的 `normRel` 额外去 `./` + trim。
- **R2 写集/删除集越界校验重复**。`checkWriteTargets` 与 `checkDeleteTargets` 四段同形 if 抽成 `checkTargetPath(original, { scopeLabel })`（空 → 绝对路径/盘符/前导斜杠 → `..` 上跳 → 白名单），两侧只保留各自的特有判据（content 类型与重复投递 / 目录不许当删除目标与幂等跳过）。
- **R3 双提交器漂移**（`apply-plan.js` 的 `commitWikiArtifacts` 与 `index.js` 的 `autoCommitWiki`）。**本轮不改**：牵涉阶段 4 的通道切换，属另一张票。已知差异点：安全边界（只 add wiki 两路径、不 amend/push、无 HEAD 与冲突拒绝）两者一致，差异集中在 stage 前置条件与返回值形状，当前由两条通道各自使用、没有交叉调用。
- **R4 巨函数**（`index.js` 的 `createJobService` 1655 行、`native-run.js` 的 `runNativeJob` 710 行）。**本轮不改**：属架构级重构，另开票处理；拆分需要先固定八段管线的输入输出契约，否则拆完只是把耦合搬个位置。

**测试**：R1+R2 后 `test-engine-apply-plan.mjs` **41/41**；S2 后 `test-engine-manifest.mjs` **27/27**（21 → 27）；S6/S4 后 `test-engine-native-incremental.mjs` **96/96**（82 → 96）；`test-engine-quality-gate.mjs` **29/29**；`node --check` 对 `git-paths.js`/`manifest.js`/`mapping.js`/`native-state.js`/`output.js`/`quality-gate.js`/`apply-plan.js`/`native-run.js`/`contract.js`/`workspace-snapshot.js`/`index.js` 全部通过。

**全量复跑**（11 项修完后，2026-10-29）：34 套功能测试**全部通过、总退出码 0**——`test-engine-native-job.mjs` **99/99**、`test-engine-native-incremental.mjs` **96/96**、`test-engine-apply-plan.mjs` 41、`test-engine-manifest.mjs` 27、`test-engine-quality-gate.mjs` 29、`test-engine-contract.mjs` 19、`test-engine-client.mjs` 24、`test-engine-bridge.mjs` 24、`test-engine-llm-bridge.mjs` 17、`test-engine-output.mjs` 20、`test-engine-output-real.mjs` 11、`test-engine-python-entry.mjs` 12、`test-engine-process-tree.mjs` 5、`test-agentic.mjs` 55、`test-agentic-host.mjs` 16、`test-agentic-fallback.mjs` 10、`test-articles-agentic.mjs` 20、`test-article-contract.mjs` 29、`test-change-set.mjs` 16、`test-cluster.mjs` 30、`test-incremental.mjs` 20、`test-incremental-e2e.mjs` 8、`test-prune-orphans.mjs` 12、`test-semantic-plan.mjs` 11、`test-symbols.mjs` 24、`test-update-planner.mjs` 20、`test-update-record.mjs` 18，其余（`test-batch`/`test-cwd-paths`/`test-graphdiff`/`test-orchestration`/`test-sessions`/`test-wiki-entry`/`test-worktree`）无失败。锚点：strict **3354 过 / 59 败 / 32 待重编译**、默认档 **3354 过 / 5 败 / 86 待重编译**（构成与处置见上文「如实记录的未达成项」第 2 条）。

### 接入：FSoft 原生引擎统一增量与跨轮受管状态（阶段 5）

- **不再只查 committed diff**。`lib/change-set.js` 汇总基线至 HEAD、staged、unstaged、untracked、删除与改名；`.codewiki/` 与本轮临时 docs 排除在源码变化外。基线不可达时显式降级 full，不把失败当 clean。
- **跨轮状态跟文章同一事务**。新增 `lib/engine/native-state.js`，把模块树、metadata、依赖图、`update_record` 和上一轮文章水合进引擎输入，并作为 `.codewiki/_native-state/` 的受管状态随文章同批写盘、回滚和提交；`state.json` 记录已消费基线及未提交路径，未提交改动跨轮保留直到对应源码提交后成功消费。
- **增量走 FSoft `update`，不是重跑 generate**。引擎动作由 change-set 决议；缺图/树、版本变化显式 full 并记录原因；质量门/索引/基线失败回滚状态，自动提交失败保留产物并 partial。未提交输入诚实 partial、不推进基线。
- **无变化轮零副作用**。引擎 `no_change` 且四路变化集与未消费路径都为空时，落地器走明确 no-op：不写盘、不建索引、不推基线、不创建提交。修复了原实现仍写 `update-record`/更新 `_meta.yaml` 导致每轮制造空提交的问题。
- **生产接线**。`codewiki_update` 与 stale 任务在 `nativeEngine` 开启时进入原生通道；默认仍关闭，旧流水线保留。
- **验证**：`test-engine-native-incremental.mjs` **82/82**、`test-engine-native-job.mjs` **96/96**、`test-engine-apply-plan.mjs` **37/37** 全过；独立无变化探针 HEAD 保持不变。真实 FSoft 生产全量→增量仍待阶段 6 验收，本阶段测试使用真实子进程协议下的假引擎。

## 未发布 — 2026-10-28

### 新增：FSoft 原生引擎迁移的契约层与三段门禁（0/1A/1B/1C），尚未接生产

目标是把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」。本轮只做契约、锁定环境与真实链路验证，**生产路径一行未改，旧核心一行未删**。

- **阶段 0 冻结契约**：新增 `docs/fsoft-native-engine.md` 与 `lib/engine/contract.js`（版本化 `EngineResult/EngineProgress/EngineError`，`contractVersion=1`，八段 `ENGINE_STAGES`，四终态 `done/partial/failed/cancelled`，`validateEngineResult` 在反序列化边界做校验而不是信任磁盘对象）；`lib/engine/mapping.js` 定 FSoft 产物 → `CodeWiki.md`/`.codewiki/modules/`/`_meta.yaml`/`temp/update-record.json` 的落点，四条硬规则是「不臆造 `source_files`、不静默丢弃、不覆盖 slug 冲突、不改技术内容」。`test-engine-contract.mjs` 18 条。
- **阶段 1A 锁定环境**：`tools/fsoft-engine/setup-env.sh` 从零建 venv，`pip check` 零问题、六个 import 全 ok。安装**故意不走正常解析**——`openai`/`pydantic-ai-slim`/`pydantic` 约束互相打架，正常解析必然 `ResolutionImpossible`；冻结清单是已解析快照，按 `--no-deps` + `-c constraints.txt` 落盘再 `pip check` 反向验证。`probe-no-llm-graph.py` 在中文/空格路径 fixture 上跑无模型依赖图，`ok: true`，15 组件 / 6 叶子（python 9 + typescript 4 + null 2），结果固化在 `probe-no-llm-graph.result.json`。venv 与 fixture 运行产物不入 git（`tools/fsoft-engine/fixtures/.gitignore` 只留源码）。
- **阶段 1B 宿主模型桥**：`lib/engine/llm-bridge.js` 起只绑 `127.0.0.1` 的 OpenAI-compatible 服务，FSoft 只拿到 loopback URL/模型名/占位 key，真凭证留在宿主 provider 内；`lib/engine/openai-bridge.js` 双向翻译 OpenAI 请求体 ↔ 宿主 `llm.stream()` 的 `GenerateOptions`/`StreamChunk`。真机 `workbuddy`/`deepseek-v4.1-flash` 实测：流式 230 chunk、首 chunk 1847 ms、总 3144 ms；非流式带 usage。**工具调用往返暴露了一个只有真跑才看得见的 bug**：assistant 历史消息缺 `source` 字段会被宿主适配层丢弃，第二轮起模型看不见自己上一轮的工具调用（已修，`test-engine-bridge.mjs` 24 条含回归）。
- **阶段 1C 原生端到端**：Python+TypeScript fixture 全量真实跑通，五类增量逐类验证——注释改动 `no_change`（0 次 LLM 调用）、公开接口 `interface:1` → 重写 overview、新文件 `added:2` → 重写 overview、删除+改名触发 `stale_scan.fixed` 并修好旧符号名（页面里旧名 0 次/新名 20 次）、未变页面 mtime 未动。工作区未提交改动**FSoft 不认**（只取 committed diff），留给阶段 5 由 Node 侧合成 change-set。新增 `lib/engine/process-tree.js`：`terminateProcessTree` 用 `taskkill /T /F` 终止整棵树，实测 204 ms、残留进程 0；异常退出用 `--request-limit 1` 验证语义失败与进程退出码分离（退出码 4）。

**复核**：主代理重新运行 `pip check` 与无模型依赖图探针，分别得到 `No broken requirements found.`、`ok: true`（15 组件 / 6 叶子，R1–R5 全 true）；新增四套测试复跑为 18 / 24 / 17 / 5 全过。桥准入修复为 `randomBytes(32)` 随机占位 key + 与本次 key 精确比对，新增「同格式伪造 key 返回 401 且不触发模型」用例。1C 只确认原生 committed-diff 的四类场景；未提交工作区变更仍待阶段 5，不计作已通过。真实全量/增量、工具调用和进程树取消为子智能体报告，尚未由主代理重放。

### 新增：FSoft 原生引擎的阶段 2 可复用薄适配层（子进程协议/清单/产物校验），仍未接生产

阶段 2 只做「怎么可靠地跟引擎说话」与「怎么可靠地判它的产物」，**不重写任何 FSoft 算法**，也不改生产路径与旧核心。

- **`lib/engine/client.js`（424 行）——子进程协议层**。`runEngine()` 起子进程、把请求写成一行 JSON、按 `requestId` 关联 stdout 的 JSON-lines，四个动作 `doctor/generate/update/cancel` 同一套通道。协议违规逐条记 `protocolViolations` 而不是抛栈：`not-json` / `bad-shape` / `unknown-request` / `duplicate-result` / `late-result` / `bad-result` / `line-too-long` / `protocol-version`。三条关键设计：① 多字节 UTF-8 跨 chunk 不切坏（按 Buffer 缓冲再按行切）；② **语义结果只看 `result` 消息**——进程退出码 0 但无 result 记 `engine-protocol`，非零退出但给了 `done` 保留 `done` 并记 `nonzero-exit` 违规，避免「进程正常退出 = 成功」的误读；③ 取消后到达的 result 记 `late-result` 丢弃，不让已取消的任务把结果塞回来。超时/取消都走 `terminateProcessTree` 杀整棵树，不是只 kill 父进程。
- **`lib/engine/manifest.js`（181 行）——环境清单与锁定**。`probeEnvironment()` 拿引擎版本/解释器版本/`pip check` 结论，`fingerprintOf()` 只对「版本 + 解释器版本」取 16 位 sha256（不拿机器路径当指纹，换目录不该算漂移）。`readLock/compareLock/writeLock` 维护 `.codewiki/engine-lock.json`，`compareLock` 给 `absent/match/drift/unhealthy` 四态与逐项 diffs。`doctor()` 把环境不可信翻译成**可执行建议**而不是一句报错。
- **`lib/engine/output.js`（284 行）——产物校验**。`collectOutput()` 收集页/`module_tree`/`metadata`/`update_record`，`validateOutput()` 给可机读 problem 列表：缺 overview、页名与模块树对不上、`source_files` 指向不存在的文件、正文里的死链、`temp/` 下的工作文件被当成文章。`buildWritePlan()` 只产出「写哪些路径」，**不碰文章内容**。
- **`lib/engine/python/entry.py`（582 行）+ `stage_map.py`（97 行）——唯一的 Python 薄壳**。读一行请求 → 调 FSoft 公共 API → 写协议行；不实现依赖图、聚类、增量。`doctor` 真跑 `pip check` 并把结论放进 `EngineResult.engine.deps`（成功时也给证据，不能只说一句 done）。凭证面按「不回退读本机配置」设计：测试把 `HOME`/`USERPROFILE` 隔离到临时目录并设 `CODEWIKI_NO_KEYRING=1`，缺模型通道时走明确失败而不是去翻 `~/.codewiki`。
- **`EngineResult.engine.deps` 进契约**（`lib/engine/contract.js:131-136`）。原契约只保留 `version/commit/python`，`deps` 会被归一化**静默丢弃**，doctor 就白跑了。

**验证**：八套引擎测试 19 / 24 / 19 / 20 / 11 / 9 / 24 / 17 全绿（contract/client/manifest/output/output-real/python-entry/bridge/llm-bridge）；真实 venv 跑 `doctor` 端到端得到 `outcome: done`、`engine.version 2.0.0`、`python 3.12.10`、`deps.ok true`、`No broken requirements found.`、0 违规、834 ms。真实模型 `generate/update` 的薄壳通道**未验证**——本轮只用假模型探针验协议，不宣称真实编译通过。工作区变更增量仍是阶段 5 的事。

### 新增：FSoft 原生引擎的阶段 3 采用门与落地器（质量门 / 原子应用 / 索引基线回滚 / 自动提交），仍未接生产

阶段 3 补的是「引擎交回产物之后」的两层：**这批产物能不能被采用**，以及**采用这件事真的成立了没有**。仍然不重写任何 FSoft 算法，也不改生产路径与旧核心。

- **`lib/engine/quality-gate.js`（639 行）——采用门**。把三件事合成一个可机读裁决：① 产物自洽（复用 `output.js` 的 `validateOutput`，不重写判定）；② 目标格式契约（把映射结果渲染成真正的 wiki 文章，再走 `article-contract.js` 的 `inspectArticle`）；③ 基线可推进性（产物对应的 commit 必须等于 `HEAD`，且 `_meta.yaml` 的基线本身已入库）。**三类问题必须分开**是这层的核心理由：`defect`（产物自身坏了：缺入口/空正文/死链/`source_files` 指向不存在的文件/`commit-mismatch`）、`degradation`（页是真的但证据不足：whole-repository 模式下 `module_tree` 为 `{}`、页 `source_files` 为空 → 可入库但**不得推进基线**）、`stale`（wiki 陈旧，不是本次产物的错）。终态仍严格：三类皆空才是 `done`。渲染层用 `yamlScalar` 安全序列化标题，含 `:`、中文、反斜杠、换行的标题都不会产出坏 YAML。
- **`renderArticle` 只把 `action==='write'` 的页交出去**，且带缺陷的页**不放进 `rendered`**——否则调用方拿到一份「大部分成功」的写集，缺的那几篇没人知道缺。
- **`lib/engine/apply-plan.js`（738 行）——落地器**。四条硬不变量：① **写集封闭**（只允许 `.codewiki/` 之下与仓库根 `CodeWiki.md`，绝对路径/盘符/`..` 上跳/白名单外路径**整批拒写**，不是跳过该条——残缺写集会制造一份没人在意的半成品）；② **索引/基线失败即回滚**（`pre-image` 快照，新文件删掉、旧内容原样写回、`_index.md`/`_meta.yaml` 复原）；③ **提交失败不回滚**（文章本身是好的，只记 `commit-failed` 并如实返回 partial）；④ **未提交不许 done**（兜底再推一次 `commit-failed`）。
- **两条只有真跑才看得见的坑，都变成了闸门**。一是 `cw index` **退出码 0 不代表文章被收录**：`vendor/codewiki/src/main.rs:236-256` 逐篇 `frontmatter::parse`，解析失败就 `continue`，最后照样写索引并返回 0——落地器在 index 之后**比对写集与 `_index.md` 的实际链接**，缺页即记 `index-failed` 整体回滚。二是 Windows 上 `cw` 写出的链接可能是 `[[modules\a|x]]`，落地器自己带一份 `normalizeIndexLinksIn`（不 import `index.js`，避免单测拉起宿主服务），规范化**失败要回滚**而不是吞掉——否则「索引文件坏到读不出来」会被当成「不需要规范化」然后判成功。
- **`cw init` 前置**：仓库还没有 wiki 时先跑 `cw init` 建骨架（对齐 `index.js:4021` 的 `state=missing` 分支）；`.codewiki/` 存在但缺 `_meta.yaml` 视为人工删改，记 `wiki-missing` 拒绝自动初始化。
- **默认自带同语义提交器 `commitWikiArtifacts`**，安全边界逐条对齐 `index.js` 的 `autoCommitWiki`（只 add wiki 两个路径 / 不 amend 不 push / 无 HEAD 与冲突一律拒绝），提交成立后再用 `verifyCommitScope` **反查实际提交内容**，混进 wiki 之外的路径记 `commit-scope`（不回滚，如实报出来）。
- **三处既有模块的极小改动，默认行为一字不变**：`lib/article-contract.js` 增加 `requiredSections`（原生通道的章节名是 FSoft 自己的 `## Introduction and Purpose` 之类，用 agentic 通道的 `## Overview` 去判它等于给一份**被禁止手改**的正文判死刑）与 `allowEmptySourceFiles`（whole-repository 模式下空 `source_files` 是**诚实记录**而非编造），并修了 `unquote` 对双引号标量的转义还原；`lib/engine/output.js` 把 `collected` 原样带出（避免上层为读 `commit_id` 再扫一遍 docs 造成判据漂移）；`lib/engine/python/entry.py` 的 `_count_docs` 改为 `rglob` 递归（hierarchical 布局把页写在子目录，只 glob 根层会漏计子树）并排除 `temp/` 与点目录。

**验证**：新增两套测试 `test-engine-quality-gate.mjs` 29 条、`test-engine-apply-plan.mjs` 37 条全绿；全套 33 套测试复跑全绿（`test-batch` 148、`test-agentic` 55、`test-article-contract` 29、既有 8 套引擎测试 19/24/19/20/11/9/24/17 等），只有 `test-wiki-anchors` 报「3335 过 / 46 败 / 39 待重编译」——存量锚点问题，非本次引入。真实 cw 端到端两次实测（临时 git 仓库）：`tools/fsoft-engine/probe-apply-real-cw.mjs` 走完写盘 → `cw index` → `cw meta update` → 自动提交，提交内容恰为 `.codewiki/_index.md`、`.codewiki/_meta.yaml`、`.codewiki/modules/core.md`、`CodeWiki.md`，`verifyCommitScope` 返回 `{"ok":true,...,"unexpected":[]}`；`tools/fsoft-engine/probe-index-missing.mjs` 验证「退出 0 但缺页」被记 `index-failed` 并回滚。这两项仍**未接生产**：`index.js` 的编译主流程尚未调用 `gateNativeOutput`/`applyNativeOutput`，是阶段 4 的接线。

### 接入：FSoft 原生引擎进入生产 JobService（阶段 4），默认仍走旧 Node 流水线

阶段 3 的门与落地器此前只有测试能调；这一轮把它们**接进真实的 JobService**，`codewiki_generate` / `codewiki_update` 的 full 编译可以走原生通道。**默认关**（`nativeEngine: false`），打开才切；旧流水线一行没删，仍是默认路径。

- **`lib/engine/native-run.js`（494 行）——单次编译的裁决管线**。把四段串成一条链：环境（`doctor` + 引擎锁比对）→ 引擎 `generate`/`update` → `gateNativeOutput` → `applyNativeOutput`，终态取**三者最弱**（`cancelled < failed < partial < done`）。这条规则是这层的全部意义：**引擎报 done 不能替代质量门**（假引擎写空产物 → 真 gate 判 failed → 整批 failed，`test-engine-native-job.mjs` 用例 15），**落地器 partial 不能报 done**（提交不成立 → partial + `canAdvanceBaseline:false`，用例 10）。`partial`/`failed`/`cancelled` 一律不推进基线。
- **模型桥**：`startLlmBridge` 起 loopback 桥，FSoft 只拿 `CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`(占位)/模型名。修了一个**必然踩中**的接线 bug：`bridge` 对象根本没有 `model` 字段（`Object.keys(bridge)` 只有 `url/placeholderKey/port/stats/close`），原写法 `bridge.model ?? ''` 恒为空串 → `entry.py:_model_config()` 判缺模型通道 → 每次原生编译都在 cluster 段 `engine-model` 失败。改为由调用方传 `model`/`clusterModel`（`nativeEnginePlan(channel,{...,model,clusterModel})`，index.js:252）。占位 key 每次 `randomBytes(32)` 随机生成、只进子进程 env、不进日志（`onLog` 只记 `{at,method,path,status,ms}`）。
- **`docsDir` 必须放仓库外**。原设计写 `.codewiki/temp/native-docs`，实测首次编译**整批失败**：引擎先把这个目录建出来但没有 `_meta.yaml`，`apply-plan.js:549` 的 `wikiExisted` 判定据此认为「人工删改过半截库」→ `wiki-missing` 拒绝初始化。改为 `os.tmpdir()/dsh-codewiki-native-<jobId>`，落地后清理（`index.js:2727` 起）。
- **环境失败如实失败，不绕过**：`doctor` 报 `probe-failed` → `engine-missing`；锁 `drift` → `engine-deps`（版本/Python 变化必须重新锁）；`pip check` 不闭合 → `engine-deps`，**不自动 `pip install` 糊过去**。首跑 `absent` 时**不**在编译前写锁（否则编译失败也会留下「已锁定」的假象），改为产物落地成功且 `.codewiki/_meta.yaml` 已存在后才写。
- **JobService 接线**（`index.js:2713-2890`）：`nativeRuns`/`nativeResults`/`nativeAborters` 三张表，`startNativeRun` 建 `AbortController` 并起 `runNativeJob`，`tickNative` 在 10s 节拍上收割结果；阶段映射 `NATIVE_STAGE_TO_PANEL` 把八段映射回既有面板契约（`env/graph/cluster/articles→articles`、`validate→review`、`index/baseline→index`、`commit→commit`），**不新增面板阶段值**。取消沿用既有语义：`cancelRequested` → abort 进程树 → 只写 cancelled、迟到结果不覆盖终态。单项目串行、幂等 findActive、面板 record 全部复用既有实现。
- **`client.js` 面板**：新增「原生引擎」通道标识与 `nativeStageLabel`/`gateLabel`/`applyLabel` 等文案（中英双语），终态后展示质量门与落地器各自的 outcome；不影响旧通道显示。
- **保守默认的理由**：真实全量/增量编译仍未由主代理端到端重放（本轮验证到「真 gate + 真 apply + 假引擎真进程」这一层），且 stale 增量还走内置流水线（统一增量是阶段 5）。所以默认 `nativeEngine:false`，原生是显式 opt-in；`symbols`/`cluster`/`graph-diff`/`incremental`/`update-planner` 一行未删。

**验证**：新增 `test-engine-native-job.mjs`，**96 项断言全过**，16 个用例全部走真实链路（`codewiki_generate.execute → JobService.submit → tick(300ms) → tickNative → runNativeJob`），gate/apply 是真的、引擎用真 node 进程跑的假引擎（真 stdio + 真 JSON-lines 协议，不是 stub 函数）：成功 done（写盘+索引+基线+提交全成立）、partial（引擎少写一篇）、failed（引擎崩）、取消（stall 模式，断言进程树被终止且迟到结果不覆盖终态）、引擎 done 但产物为空被质量门拦下、环境失败（`probe-failed`/`deps-bad`）、锁漂移、`cw index` 失败（`_index.md` 变目录 → 真 exit 1）回滚、`cw meta update` 失败（`_meta.yaml` 删 `project:` 行 → 真 exit 1）回滚、提交失败（`commit-failed` 不回滚产物）、单项目串行（第二个仓库 queued 后自动轮到）、**旧通道默认不受影响**（`nativeEngine` 关闭时引擎足迹为空数组、`channel` 未设、无 `nativeResult`）、stale 不走原生。全套 34 套测试复跑全绿；`test-wiki-anchors` 仍报「3263 过 / 12 败」——存量锚点问题（`git stash` 掉本轮改动后基线为 3138 过 / 44 败，本轮改动让失败数从 44 降到 12、无新增失败项）。

**未完成边界（如实）**：① 真实 FSoft 全量/增量编译**未**在本轮由生产通道端到端重放（只用假引擎验证了接线与裁决，真实 Python 引擎的单次编译仍是阶段 1C 的 fixture 级证据）；② 统一增量（含未提交工作区变更合成 change-set）是阶段 5，`stale` 不走原生；③ 阶段 5-7 未动。

## 0.14.0 — 2026-10-27

### 修复：增量漏检、部分失败仍报成功、坏文章入库（融合 FSoft 的 updater/质量门）

一轮审计确认了三类缺陷，共同后果是「wiki 看起来编译完了，但库里的文章与代码对不上」。本轮按 P0 顺序逐项修，每项都有回归测试。

- **增量漏检（最严重：工作区改动永远不被看见）**。过期判定只跑 `git diff <last_compiled_commit>..HEAD`，**未提交、已暂存、未跟踪的改动完全不参与**——改完源码不 commit 就编译，`cw status` 报「最新」，这些改动从此永久失明；删除与改名也认不出。新增 `lib/change-set.js`：`collectChangeSet()` 一次采集四路（`<base>..HEAD` / `--cached HEAD` / 工作区 / `ls-files --others`），识别 `D` 与 `R`，路径规范化成仓库相对 POSIX，`.codewiki/` 自身产物排除在源码变更之外（README/CHANGELOG/CodeWiki.md 仍是合法 source）。基线不可达/非 git 仓库时**明确退回全量并记原因**，不再假装干净。`test-change-set.mjs` 15 条覆盖仅未提交/仅暂存/未跟踪/删除/改名/去重/排除/降级。
- **把没被理解的变化基线化**。旧代码在 `changedFiles` 有内容但**没有任何文章命中** `source_files` 时照样 `meta update`，等于宣布「这些变化已经消化」，下次增量再也不会看它们。新增 `lib/update-planner.js`：`planUpdate()` 纯函数，以文章 `source_files` 为初始 ownership，用当前依赖图做**反向依赖闭包**（接口级变更连带重写使用方文章，函数体实现细节变更不波及依赖方），新文件按最长公共目录归给最匹配的文章、无法归属的源码文件让规划退回全量，未重写页做 stale scan（引用已删/改名组件、内部死链）。每篇 `write`/`keep`/`review` 都带**可机读原因**；关系存版本化 `.codewiki/temp/module-map.json`（老 wiki 从 frontmatter 保守迁移）。纯注释改动仍按 `codeHash` 跳过（0.13.2 行为不变）。`test-update-planner.mjs` 20 条覆盖反向依赖、新文件路由、未映射、缺 source_files、stale scan、文件级降级。顺带修掉一个真问题：`extractCurrentGraph()` 原先只调 `extractRepoGraph()` **从不建依赖边**，增量侧根本没有 `dependsOn`，反向依赖影响不可能生效（只有语义聚类路径建边）；现在两条路径都建。
- **部分失败仍报 `done`**。旧判定只有 `writtenCount === 0` 才算失败，**1 篇成功 + 19 篇失败照样 `done` 并推进基线**。新增终态 `partial`（`JOB_TERMINAL` 与面板/`codewiki_progress` 文案同步），`done` 只表示完整成功。硬不变量：计划内必需文章缺失/失败、有未映射变更、质量闸门拦下文章、存量文章体检不过 → `partial`（附 `blockers` 逐条原因）；`partial`/`failed` **不执行 `meta update`**，下次编译还会重新处理这些变化。每次编译写 `.codewiki/temp/update-record.json`（基线/HEAD、每篇 action+原因、变更统计、未映射变更、质量问题、最终结果），job 只存摘要与记录路径。`test-update-record.mjs` 18 条覆盖终态判定矩阵与记录可序列化。
- **坏文章能入库**。旧闸门只查 frontmatter 开合；重复 frontmatter、空必需章节、指向不存在文件的 `source_files`、坏链接全都能写进 wiki 再被 `cw index` 收进索引（已提交的 `.codewiki/concepts/wiki-generation-flow.md` 就有第二份 frontmatter + 重复正文）。新增 `lib/article-contract.js`：`inspectArticle()` 纯函数，检查 frontmatter 唯一闭合、必填字段、`type` 与目录一致、正文非空、必需章节非空、正文不重复 frontmatter、围栏闭合、`source_files` 真实存在且来自本次读取证据、内部链接目标存在、重复章节/正文块拒绝；按文章类型配置必需章节。接在**所有写盘点**（单轮通道、校对回写、agentic 通道）。agentic 通道另加 write-set 闸门（父文只准写自己那篇、子模块只准写调度器分配路径，越界 `stopReason='write-set'` 且不落盘）。`test-article-contract.mjs` 29 条。
- **文档口径同步**：README 新增「增量与质量保证（0.14.0）」一节，改掉「零子代理」这类与实现不符的整体化表述；`symbolIncremental`/`agenticArticles`/增量判定三处描述补上 0.14.0 行为。

**验证**：新增 4 套测试（`test-change-set` 15 / `test-update-planner` 20 / `test-update-record` 18 / `test-article-contract` 29）全绿；既有 20 套测试全部保持通过（含 `test-orchestration` 编排冒烟、`test-batch` 148、`test-agentic` 55、`test-articles-agentic` 20、`test-incremental*`、`test-graphdiff`）；`node --check` 全部通过。

## 0.13.7 — 2026-10-27

### 修复：锚点测试补「编译基线版」第三基准，消除提交前后的结果跳变

0.13.6 落地两档判据后，`--strict` 在**提交前**是 18 败。但提交完 0.13.6 自己那份 commit 后再跑，同样的文档跳到 **111 败**——同一套代码、同一套文档，只因为多做了一次 `git commit`。

- **根因**：当时只有「工作区 ∪ HEAD」两个基准。提交前，工作区是新源码、HEAD 是文档写成时的旧源码，两者并集正好覆盖；提交后 HEAD 立刻**变成**新源码，旧源码从两个基准里同时消失，所有写在旧版行号上的锚点（22 处 `index.js:1374`、16 处 `index.js:1390` 一类）全部无处安放。败因清一色是「指向空行（区间内也无代码）」——不是文档错，而是那一带的行号在新源码里已经挪走了。
- **修法**：补第三个基准**编译基线版**，取 `.codewiki/_meta.yaml` 里 `last_compiled_commit` 指的那版源码（`git show <commit>:<path>`）。判据变成「编译基线 ∪ 工作区 ∪ HEAD 任一能解释即通过」。语义上它才是最正的那个——文档本来就写在它上面；前两个是为了兜住「改完代码还没提交」的窗口。
- **验证**：补完后 4897 过 / 0 败 / 133 待重编译，`--strict` 回到 18 败，与提交前完全一致。反向验证：把 `last_compiled_commit` 临时改成 `0000000…`（不存在的 commit）→ `--strict` 立刻从 18 跳回 111；还原后回到 18。证明第三个基准确实在起作用，不是碰巧。
- 顺带把测试里残留的「工作区与 HEAD 双基准」表述改成三基准，日志首行会分别打印三个基准的行数（工作区 4413 / HEAD 4412 / 编译基线 4132）。

## 0.13.6 — 2026-10-27

### 修复：锚点测试从「一律硬断言」改为「新鲜度感知两档」，并把修正器与校验器的判据对齐

背景：0.13.5 把 `test-wiki-anchors` 修到 0 败（10356 处全过），但那是把检查范围限定在 `index.js`/`client.js` 两个文件时达成的。本轮把检查范围扩到**全仓所有被引用的文件**（`test-*.mjs`、`lib/*.js`、`CHANGELOG.md`、`README.md`、`vendor/` 等），立刻暴露 263 处失败。逐条查下来，**绝大多数不是文档错**，而是测试自身的基准选错了。

- **锚点测试的基准错位（本轮最重要的一条）**。测试拿**工作区**的源文件当基准判断「锚点的行号里是否含该符号」，但 `.codewiki/` 的编译基线是上一次 `codewiki_generate` 时的源码。两者一旦不同（本分支有大量未提交改动，`index.js` 净增约 40 行），所有锚点整体漂移，测试就把它们全判成「符号未绑定」。实测：同一批锚点，用 `git show HEAD:<file>` 当基准时 4961 过 / 51 败，用工作区当基准时 4864 过 / 166 败——**115 处是纯粹的假失败**。修法：`test-wiki-anchors.mjs` 分两档判据。

  - **结构事实永远硬断言**：行号越界、区间起止倒序、区间终点超出文件行数——这些与源码变不变无关，是真错。
  - **符号绑定按新鲜度分档**：源文件自编译基线（`.codewiki/_meta.yaml` 的 `last_compiled_commit`）以来**没变** → 硬断言（文档必须与源码对齐）；**变了** → 记为「待重编译」不计失败，因为文档这时候本来就该滞后，下次 `codewiki_generate` 会让基线前移，同一批检查自动升级为硬断言。`--strict` 可随时按硬断言跑，用于发版前自查。

- **修正器与校验器判据必须同源（这条踩了三次）**。`fixAnchors` 改完的锚点必须能被 `test-wiki-anchors` 认可，否则出现「修正器认为已对、校验器判错」的死循环。本轮把三处判据对齐：

  - **区间锚点**：校验器判「符号出现在区间内任何一行即算对」（`index.js:779` 的 `fixAnchors` 内 span 分支），修正器原先只看首行，于是把校验器认可的正确锚点判成错再拿去重定位（实测 `_patterns.md` 的 `plan` 每轮被记成「符号歧义未改」）。
  - **「已正确」快路径**：旧实现对多锚点行要求「符号在全文有唯一声明行」，而大量符号在文件里被引用多次（`locate` 返回 ambiguous），于是**本来正确的锚点被判错**、再被改成别的行——实测因此引入 35 行真回归（`client.js:489` 与 `client.js:495` 各自正确且指向不同行，修后都变成 495）。改为与单锚点行同一套宽松判定：锚点起始行提到「离它最近、尚未被占用」的符号即认可；防拉平靠 `used` 占用集合 + 就近排序，不靠全局唯一性。
  - **就近绑定的方向约束**：只在**锚点之前**的符号里选。中文行文的锚注写在「符号（锚点）」的括号里，锚点之后的符号属于后文、不可能拥有这个锚点。原先纯按字符距离排，实测 `articleMd（test-orchestration.mjs:33-35）：…用 makeBatchMock 生成…` 这行里，后文的 `makeBatchMock`（距 39）比主符号 `articleMd`（距 40）只近 1 个字符就被选中，锚点被改到 145-147；下一轮文本已变、距离关系翻转，又改回 33-35——无限来回、5 轮不收敛。

- **新增 `changelogSections` / `fixChangelogAnchors`（`index.js:622`、`index.js:632`）**。`CHANGELOG.md` 是**追加式流水账**，每次发版在顶部插入一节，所有指向它的行号必然单向漂移；而它里面没有可声明的符号，`fixAnchors` 的符号分支遇到「行内无反引号符号」直接原样返回，连尝试都不做。这批锚点几乎都写了版本号（`0.13.0（CHANGELOG.md:109）`），版本标题 `## 0.13.0` 是稳定锚。重定位规则：同一版本 V 被引用的所有失效锚点里取最小行号 `Hmin` 当「写作时该节首的估计」，新行号 = 当前节首 `S` + `(n - Hmin)`。**必须保留相对偏移**——若一律改写成节首 S，`CHANGELOG.md:8` 与 `CHANGELOG.md:10` 会双双变成 S（拉平，正是 0.13.5 修过的数据破坏）。两个关键实现细节都写在注释里：`Hmin` 必须**按行内聚合**（跨行取最小会引入假偏移，让历史错锚点算出「节首+258」直接越界）；幂等的关键是基准必须由**该行该版本的全部锚点**（有效 + 失效）决定，只统计失效项会振荡。

- **新增 `repairUnclosedFrontmatter`（`index.js:757`）**。frontmatter 未闭合（闭合 `---` 被写成空行）的文章，`fixAnchors` 的 `/^---\n([\s\S]*?)\n---/` 匹配不上，**整篇锚点一次都不会被校正**，而文章照常落盘、编译照常「成功」——失败完全不可见。实测 `.codewiki/learnings/update-reminder-entry-gap.md` 就这样积了 19 处失效锚点且每轮编译都过。三条判据同时满足才动手（首行是 `---`、紧随其后至少一行无缩进 `key: value` 元数据、元数据块后紧跟空行），正文里的 `---` 分隔线与普通 md 都不受影响。

- **`fixAnchors` 的 `resolveFile` 补仓库根优先**（`index.js:779` 内）。`source_files` 里写的是**模块相对路径**（`modules/test-suite/index.js`），而文章正文引用的是**仓库根**路径（`index.js:941-954`）；两者 basename 相同 → 按 basename 匹配会把根锚点映射到不存在的 `modules/test-suite/index.js` → `loadSource` 返回 `null` → 整行静默跳过。改为仓库根真实存在的同路径优先：文档锚点的语义永远是「仓库里的这个文件」，虚拟映射只是文章元数据。

- **删不掉的孤儿文章必须留痕**（`index.js:261` 的 `pruneOrphanModules`）。旧实现 `catch { /* 删不掉的留给下次 */ }` 是静默吞错，而删不掉的孤儿会一直占着 `modules/` 并被 `cw index` 收录，下次编译仍然「成功」、无从知道有篇死文章还在。改为记进 `job.plan.prunedFailed` 并在编译 note 里报出前 5 个。测试同时补了 `rmSync` 抛错的分支。

- **抽 `validateArticleEnvelope`（`index.js:1005`）**。这段闸门原先只藏在 `writeValidated` 里，只能靠整轮 orchestration 间接覆盖。抽出为导出函数后由 `test-batch.mjs` 直接钉住 14 种边界（正常闭合 / 前置空行 / 只有 frontmatter 无正文 / CRLF / 缺开头 / 空串 / null / 非字符串 / 缺结束 / 结束符不在行首 / 正文含 `---` 分隔线等）。同时修正了闭合判据：结束标记必须**独占一行**（`---(?:\r?\n|$)`）而不是裸 `---`，否则正文里行首的 `---`（分隔线带说明）会被当成 frontmatter 闭合，把真正缺失的结束符放过去。

- **`symbolsWithPos` 排除文件名**（`index.js:779` 内）。`package.json`（`package.json:1-28`）这类写法里反引号包的是文件路径，拿它去源文件里搜必然搜不到，会一直记「符号未绑定」假阳性。

测试：`test-wiki-anchors.mjs` 检查总量从 10356 升到 16042 条（范围扩到全仓），两档判据下默认档 **4895 过 / 0 败 / 135 待重编译**，`--strict` 档 18 败（全部是历史遗留的文档真错，留给下次 `codewiki_generate` 重编译解决）。`test-batch.mjs` 132 → 148 条。`test-prune-orphans.mjs` 9 → 12 条。全量 18 个测试文件回归全绿。

### 说明：为什么不全修那 18 处 strict 失败

它们不是漂移，是**文档本身引用了已删除的符号或写错了位置**（如 `resolveBatchApiKey` 在 0.10.1 就随「插件不碰密钥」一起删了，文档仍在描述它）。这类错的正解是让下一次真实编译重新读源码重写那几段，而不是由修正器按启发式去猜——修正器猜错的代价是「把锚点改成能过校验的值，却与正文描述不符」，那正是 0.13.5 之前几轮手改修到 0 败却掩盖根因的老路。

## 0.13.5 — 2026-10-27

### 修复：孤儿文章清理 + `fixAnchors` 锚点归属（一行多锚点不再被拉平）

背景：`test-wiki-anchors` 报 251~375 处失败，逐条查下来是**两类互相掩盖**的问题——孤儿文章（占了 169 处）与 `fixAnchors` 自身的锚点归属错误。先前几轮手改修到 0 败过，但那是把锚点硬改成「能过校验」的值，掩盖了根因。

- **新增 `pruneOrphanModules(job)`（`index.js:240-282`）**。模块划分随聚类结果变化：上一次编译产出 `modules/plugin-core.md`，下次同样的代码被切成 `core-and-config.md` + `core-application.md`，旧的两篇再没人重写也没人删除，成了「被 `_index.md` 遗漏、内容永久过期」的死文章，还让锚点校验一直拿过期行号去校验已挪位的源码。安全边界写进注释与测试：① 只在全量编译（`kind==='full'` 且 `plan.modules` 完整）时动手——增量编译只重写变化模块，拿它当全集会把「本次没变的模块」全删；② 只删 `.codewiki/modules/*.md`，`concepts/`、`learnings/`、`decisions/`、`_architecture.md` 等横切产物一律不碰；③ 本次 job 写过的（含失败）保留，失败可能是暂时的，不顺手删证据；④ 删除失败只记账不中断。本次实际清掉 5 篇孤儿（`docs-and-meta`、`documentation-and-config`、`plugin-core`、`plugin-runtime`、`project-docs`）。

- **`fixAnchors` 锚点归属改为「就近绑定」（`index.js:625-730`）**。原实现把行内所有反引号符号收集成数组，对同一行的**每个**锚点都用这一整组符号去查唯一出现——一旦命中就把该锚点改成那个符号的位置。后果是一行里并列多个锚点（表格一行多列、一句话串多个符号，实测 `_patterns.md` 单行有 15 个）会被逐个改写成**同一个行号**（拉平），`configuration-management.md:227` 里 5 个不同常量被压成 5 个 `index.js:1572`、`test-log-pairing.md:24` 四处 `createUserMessage` 被压成 4 个 `index.js:15`。修法：`symbolsOnLine` 改为 `symbolsWithPos`，返回每个符号在行内的字符位置；按锚点在行内的位置取**最近**的符号（同距取左侧，符合中文「符号（`file:NNN`）」的行文习惯）再定位，一行多个锚点各自绑定正确的符号。

- **顺带修掉的四个连带缺陷**：`writeValidated` 增加 frontmatter 闭合校验（`---` 缺结束符时不落盘——`documentation-and-config.md` 就是开头多了个空 `---` 对，导致 frontmatter 解析失败、被索引归进 `Unknown` 段）；`fixAnchors` 倒序区间（`9-7`）原会算出负跨度，改为 `Math.abs(end-start)` 并夹到行数内；`test-wiki-anchors.mjs` 的符号绑定判定由「本行 index/client 锚点数 === 1」改为「本行**全部文件**锚点数 === 1」，避免一行串 `test-orchestration.mjs:94` 与 `index.js:114` 时把属于另一个文件的符号强行要求出现在 index.js 区间内；`documentation-and-config.md` 的 `source_files` 去掉 `modules/` 前缀。

测试：新增 `test-prune-orphans.mjs`（9 条：非全量跳过、无清单跳过、删孤儿、保计划内、保已写过、保横切目录、只删 .md、删除失败不中断、返回清单）；`test-batch.mjs` 128 → 132 条（新增倒序区间 `a.js:9-7`→`a.js:5-5`、`a.js:8-2`→`a.js:3-5` 与一行多锚点归属不拉平）；`test-wiki-anchors.mjs` 由 375 败 → **0 败**（10356 处锚点全过）。全量 16 个测试文件回归全绿。

### 说明：本轮锚点修复的方法与教训

第一版修法是「按符号全仓唯一出现定位」，遇到 `plan`/`fail`/`fixAnchors` 这类同名多次的直接跳过（剩 75 处）；第二版改成「行内第一个有唯一声明行的符号」，与校验器判据不一致（校验器取离锚点最近的符号）导致修好的行仍判失败（剩 7 处）。第三版才与校验器严格对齐。中途还试过「按 `git diff` 行号偏移整体换算」的方案，实测反而变差（93→104 败）——行号偏移对所有约定成立，但对「本来该指向哪个符号」无信息量，且会把末尾行算到 `total+1`。教训：**锚点必须按符号语义定位，不能按位置偏移推算**。

## 0.13.4 — 2026-10-27

### 修复：工具层的四个真实翻车点（独立核查 + 逐条实测复核后确认）

背景：0.13.3 修完真实运行暴露的问题后，另派子代理对 agentic 工具层做了只读核查。报告列 6 条，我逐条实测复核，**5 条成立**（第 6 条「子模块重名产生丑陋路径」属设计取舍、未改），并按严重性重排——**封顶静默撒谎比 CRLF 更严重**，因为它产出死链且父任务仍报 `ok:true`，属于无人察觉的静默错误。

- **`str_replace` 在 CRLF 文章里跨行必然失败（`lib/agentic.js`）**。原实现是纯字面 `indexOf`，不做行尾归一化。真实仓库 `core.autocrlf=true`、`.codewiki` 下 36 篇 md 里 28 篇是 CRLF；模型 `view` 看到的是 `7| 第一段正文。\r\n`（`\r` 不可见），它按看到的行写跨行 `old_str` 用 `\n`，永远匹配不上 → 收到「未找到」→ 换锚点再试 → 步数耗尽，文章没写完。这是增量改旧文的主路径，必踩。修法：匹配前把文章与 `old_str` 的行尾统一成 `\n`，命中后按原文风格写回（CRLF 文章仍写回 CRLF，不悄悄把整个文件改成 LF）。`insert` 同样处理。实测真实 CRLF 文章 `batch-tests.md`（118 行）跨行替换：命中、内容已变、行尾仍 CRLF。

- **子模块封顶时静默撒谎，产出死链（`lib/agentic.js` + `lib/articles-agentic.js`）**。封顶逻辑本身正确（`_depth >= subDepth` 时为 `null`，递归时传 `onSubModule: null` 让子层重建判定），但工具层把「不可用」一律回成 `isError:false` + `「已记录子模块 X（本模式下不递归成文）」`。模型据此在父文里写「详见 xxx.md」，**而那个文件从未生成** —— 死链，且父任务仍记 `ok:true`，无人察觉。修法：`buildToolset` 新增 `subModuleBlocked`（`'max-depth'` / `'unsupported'`），两种情况分别返回 `isError:true` 并给出可执行指令（「已到嵌套上限，请在本文里作为普通小节直接写清楚，不要留下指向外部文件的死链」）。`runOneArticle` 逐层透传。

- **`read_code` 只有行数上限、没有字符上限（`lib/agentic.js`）**。`MAX_READ_LINES = 2000` 挡不住压缩产物：实测单行 20 万字符的文件一次返回 200026 字符 ≈ 5.7 万 token（2000 行上限对它完全无效，因为它只有 1 行）。新增 `MAX_READ_CHARS = 40000`（≈11k token），超限截断并提示「请用更小的行范围读，不要整包读压缩产物/打包文件」。

- **`list_files` 列出 `node_modules`/`.git`（`lib/agentic.js`）**。模型看到会当源码探索，白烧步数。新增 `IGNORED_DIRS`（node_modules/.git/dist/build/.next/target/vendor/__pycache__/.venv/venv），过滤后提示「已隐藏 N 个依赖/版本控制目录」。
  - 注：核查报告另称「`list_files` 的 `depth` 参数完全无效」——这条我复核后**判为不准确**：`lib/agentic.js` 确实把 `depth` 传给了 `workspace.listDir(rel, depth)`，但适配层 `lib/agentic-host.js:125` 的签名是 `async listDir(rel)`，多传的实参被忽略。所以现象描述对（`depth=1/2/4` 返回条数相同）、但根因是**适配层不接**而非工具层不传。本次未改递归展开（`list_files` 定位是「看一眼有哪些文件」，深读靠 `read_code`），只修了忽略目录；若后续确有需要，应在 `makeFsWorkspace.listDir` 里实现深度递归。

- **`insert` 负行号被静默吞掉（`lib/agentic.js`）**。原 `Math.max(0, Number(args?.line) || 0)` 把 `-5` 变成 `0`，内容被插到文件最前，模型还以为插到了指定位置。改为负数直接 `isError:true` 并说明「0 表示插到最前，1 表示第 1 行之后」。

测试：`test-agentic.mjs` 48 → 55 条（新增 CRLF 跨行命中、CRLF 行尾保持、LF 不被污染、字符上限、忽略目录、负数行号 6 条；另把旧的「无 onSubModule 时子模块调用不报错」改为「必须报错并说明原因」+ 新增「深度到顶报错」）。全量 17 个测试文件回归全绿（`test-batch` 128、`test-symbols` 24、`test-cluster` 30、`test-agentic-host` 16、`test-articles-agentic` 16 等）。回退验证：四处劣化（去掉行尾归一化 / 关掉字符上限 / 关掉忽略目录 / 关掉负数检查）分别触发对应测试 FAIL，恢复后全过。

## 0.13.3 — 2026-10-27

### 修复：首次真实运行（真模型 + 真落盘）暴露的三个缺陷

背景：此前 0.13.x 的 191 条断言全部由注入的假 `streamFn` 驱动，agentic 写作通道**从未真实跑过一次**（用户追问「测试过写文章吗」后核实）。本轮改用真实宿主 `llm.stream` 跑通，立刻暴露出离线测试结构性看不到的问题。

- **`read_code` 重复读抑制（`lib/agentic.js`）**。真实运行里模型会反复读同一个大文件：一次 45 步的探针中 `read_code` 调用 16 次、其中 12 次是重复读，`index.js` 被读了 13 遍，累计请求上下文 2144KB，步数全耗在读码上，最终 `stopReason='max-steps'` 而文章没写完。根因是模型没有「我读过这个」的记忆，而工具每次都老实回吐全文。修法：`makeReadCodeTool` 增加 `seen` 记账（键为 `path + 起始行 + 结束行`），同一段再读只回一句「你已经在第 N 步读过这段，内容就在你上面的上下文里」。**去重判定必须发生在读盘之前**——初版写在 `readFile` 之后，重复读照样把整份文件读进内存，白省不了 IO（该时序缺陷由新增测试「重复读不应再碰文件系统」捕获，回退验证劣化后 2 条 FAIL）。修后同一探针：重复读 12 → 5 次、上下文 2144 → 1413KB、步数 45 → 17、`stopReason` 由 `max-steps` 变为 `finished`。
  - 步号经 `buildToolset({ getStep })` 由循环内的 `stepRef` 注入，循环每步刷新，模型看到的「第 N 步」是真实步号。

- **`toRequestMessages` 的 MessageId 身份漂移（`lib/agentic-host.js`）**。宿主 d.ts 对 `MessageId` 的要求是 `Stable identity preserved across every representation boundary`（`message.d.ts:126`），而工具循环每轮都拿同一份裸 `messages` 重新过一遍 `toRequestMessages`，每次都 `createUserMessage` / `createAssistantMessage`，同一条消息每步换一个新 UUID。实测同一批裸消息连调两次，`user` 与 `assistant` 的 id 全不同。修法：模块级 `WeakMap` 以裸消息对象为键缓存已构造的正式消息（tool 角色一拆多，键里带 `toolCallId`），对象随循环消息生命周期回收。**首版只缓存了 assistant 分支、漏了 user**，被新增测试「同一批裸消息多次转换，MessageId 保持稳定」直接判 FAIL，补上 user 分支后通过。

- **真实探针的三个配套坑（已一并修掉）**。
  1. `runOneArticle` 落盘读的是 `task.articlePath`，探针先前传 `articleFile` 导致文章不落盘、误判成「跑了但没写」——答案在 `lib/articles-agentic.js:132` 的 `task?.articlePath`。
  2. 工具 JSON 参数被包在 markdown 围栏里时 `parseToolArgs` 原先不剥围栏，已按「原样 → 剥 ```json 围栏 → 截首个括号平衡对象」三级递进处理。
  3. 真实宿主 `llm.stream` 的 `signal` 需透传，否则长请求无法中断。

测试：`test-agentic.mjs` 44 → 48 条（新增 4 条覆盖去重、跨行范围、跨文件、不带 `end_line` 的同段判定），`test-agentic-host.mjs` 15 → 16 条（身份稳定）。全量 17 个测试文件回归：`test-agentic-fallback` 10、`test-agentic-host` 16、`test-agentic` 48、`test-articles-agentic` 16、`test-batch` 128、`test-cluster` 30、`test-cwd-paths` ALL PASS、`test-graphdiff` ALL PASS、`test-incremental-e2e` 8、`test-incremental` 20、`test-orchestration` PASS、`test-semantic-plan` 11、`test-sessions` PASS、`test-symbols` 24、`test-wiki-entry` 全部断言通过、`test-worktree` PASS。

## 0.13.2 — 2026-10-27

### 修复：0.13.0/0.13.1 的审计整改（一条真缺陷 + 一批诚实性与一致性问题）

- 背景：对 `feat/sess-session-absorb-fsoft` 分支做双轴代码审查（Standards + Spec），逐条实测复核后确认 1 条真缺陷、一批文档/一致性偏差。用户裁定「全部修复」。

- **P0 真缺陷：`subDepth` 递归封顶失效（`lib/articles-agentic.js`）**。`dispatchSub` 是**本层**的闭包，深度判定 `_depth >= subDepth` 绑在本层的 `_depth` 上；递归时原样传 `onSubModule: dispatchSub`，子层永远用父层的深度判定 → 封顶永不触发，模型可以无限往下拆。实测：`subDepth=1`/`maxSteps=4` 时模型调用 81 次；`subDepth=2` 直接 `JavaScript heap out of memory`。修法：递归时传 `onSubModule: null`，让子层按自己的 `_depth` 重建 `dispatchSub`（绑定 `_depth + 1`）。补测试：`subDepth=1` 只允许一层、`subDepth=2` 允许两层；回退验证（把 `onSubModule: null` 改回 `dispatchSub`）两条测试均 FAIL。

- **纯注释改动不再触发重写（`lib/graph-diff.js` + `lib/incremental.js`）**。README 与 CHANGELOG 原先宣称「纯注释、空白改动不再触发全文重写」，但 `normalizeBody` 与上游 Python 逐字一致、只做空白归一，所以是文档过度承诺而非移植错。修法：**不动 `diffGraphs`**（与上游逐位对齐、有 78 条 golden 对拍），在判定层加降级——新增 `codeHash(node)` = 剥离注释与空白归一后的 sha1；`stripComments` 支持 `/* */` 块注释与 `//`、`#`、`--`、`;`、`%` 五种行首注释，并新增 `stripTrailingComment` 处理行尾注释；快照新增 `codeHash` 字段；`filterStaleTasks` 里「`bodyHash` 变了但 `codeHash` 没变且 `docstring` 没变」的组件归入 `cosmeticOnly` 不重写，其余变更照旧。返回值新增 `cosmeticOnly: string[]`，`dropped` 条目带 `cosmeticOnlyComponents` 便于解释「为什么这篇没重写」。`opts.ignoreCommentOnly === false` 可关掉该降级回到严格模式。快照缺 `codeHash`（旧快照）时该组件不降级，行为与旧版一致。
  - 行尾注释只认 `//` 与 `#`（`TRAILING_COMMENT_MARKS`），**不认** `--`/`;`/`%`——它们在表达式里出现太多（`a--`、`for(;;)`、`50%2`），按行尾截断会吃掉真代码。行首注释仍认全五种。

- **`lib/symbols.js` 补正则降级（239 行）**。原实现 AST 不可用时 `return []` 静默丢符号，整块语言的模块凭空从模块清单里消失，日志只有「skipped +N」。新增表驱动 `REGEX_RULES`（16 种语言，`fn`/`cls`/`arrow`/`iface`/`params`）+ `regexExtract(relPath, content, lang)`：按行扫、跳过块注释与单行注释、产出与 AST 同形状的符号记录；仅在 AST 路径不可用时启用，命中数记进 `stats.regex` 让调用方看得见降级。测试 24 条（含「WASM 不可用时自动走正则」「WASM 可用时 `stats.regex` 为 0」）。

- **`lib/cluster.js` 下钻真递归（452→467 行）**。`subdivide` 原先只被顶层 `for` 循环调一次、内部不再递归，`maxDepth` 实际只当 `maxDepth > 1` 的布尔开关用——配 3 和配 2 行为完全一样。改为 `subdivide(..., depth, maxDepth, splitThreshold)`：子模块仍 `>= splitThreshold` 且 `depth < maxDepth` 时继续下钻，`stats.levels` 记录真实层数。测试 30 条。

- **agentic 通道接双池（`lib/articles-agentic.js` + `index.js`）**。`runAgenticArticles` 早就有 `bigConcurrency` 双池实现，但生产链路从未传这个参数、也没给任务打 `bigTier` 标记——大档在 agentic 通道事实上不生效。新增导出 `sourceTokensOf(task, cwd)`（与 `index.js` 的 `estimateTokens` 同口径：CJK 按 1、其余按 3.5 字符/token）与 `markBigAgenticTasks(tasks, {bigTier, sizeOf})`（模块源文本量超 `bigTokenBudget` 才打标，`bigProvider` 未配置时原样返回）；`index.js` 的 `startAgenticRun` 传 `bigConcurrency: c.bigConcurrency` 并据此打标。新增导出 `resolveTaskRoute`：任务自带 provider/model 时以任务为准、**不回落**默认档的 `reasoningEffort`（默认档的 effort 可能不被大档模型支持）。

- **`DEFAULT_MAX_STEPS` 统一（`lib/agentic.js` → `lib/articles-agentic.js` 再导出）**。原先 `lib/agentic.js` 内部写 24、`lib/articles-agentic.js` 导出 30，直接调 `runAgenticArticle` 拿 24、走生产链路拿 30，同一配置两种行为。改为唯一定义在 `lib/agentic.js`（= 30，与 `index.js` Config 默认值一致），`articles-agentic.js` 导入并再导出保持既有导入路径可用。

- **`tally` 去重语义收窄（`index.js`）**。0.13.0 把「按名字去重」改成无条件执行（本意是修重跑重复计数），但它顺带改变了校对阶段以外的所有 `tally` 调用语义（属于 scope creep）。收窄为两个独立开关：`replace=true`（校对阶段，同名覆盖）与 `mergeByName=true`（文章/观察/合成的重跑路径）；正常首次 tally 不合并。调用点按语义各自传参。

- **`plan` 不再携带全量源码（`index.js`）**。`semanticPlan` 返回的 `plan.graph.components` 原先把每个组件的 `sourceCode` 一起带上，而 `plan` 会随 job 整体写进 `JOBS_FILE`——本仓 341 个组件约 347KB 纯冗余（判变更只用 `bodyHash`/签名/依赖，源码没有任何消费者）。已移除；`extractCurrentGraph` 的现场图不受影响。

- **`cordis.patch.yml` 补配置示例**：`config: {}` 保留（含义是全部用 Config schema 默认值），补上被注释的完整字段示例（`batchProvider`/`batchModel`/`maxConcurrency`/`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`）并注明「留空即用 schema 默认值」。

- **文档一致性**：README 的工具表把 `edit_article` 误写成 `insert/replace/str_replace/delete`（实际只有 `view`/`str_replace`/`insert` 三种命令）已改正；CHANGELOG 0.13.0 里各模块行数（`symbols.js` 701→884、`cluster.js` 452→467、`agentic.js` 388→401、`articles-agentic.js` 131→292、`graph-diff.js` 497→578、`incremental.js` 169→206）按当前实际核对更新；`client.js` 一处缩进错位已修。

- **清理**：`index.js` 删掉未使用的 `isDiffEmpty`/`serializeDiff`/`changedIds` 导入；`semanticPlan` 的 `extractRepoGraph` 调用去掉未使用的 `rootDir` 参数；`lib/agentic-host.js` 里 `content.map((b) => ... ? b : b)` 这种恒等映射（Middle Man）改为直接传 `content`。

- 测试：`test-symbols` 19→24、`test-cluster` 28→30、`test-articles-agentic` 7→16、`test-incremental` 15→20、`test-semantic-plan` 10→11。全套回归：`test-agentic` 39、`test-agentic-host` 15、`test-agentic-fallback` 10、`test-batch` 128、`test-graphdiff` 全过、`test-incremental-e2e` 8、`test-orchestration` 编排冒烟、`test-cwd-paths`/`test-sessions`/`test-wiki-entry`/`test-worktree` 全过。

- 版本 0.13.1 → 0.13.2（patch：修一条真缺陷 + 诚实性与一致性整改，无新增配置项）。

## 0.13.1 — 2026-10-27

### 修复：`generate_sub_module` 在生产链路上是空转的

- 背景（自查发现）：0.13.0 宣传「`generate_sub_module`（委派子模块成文）」，`lib/agentic.js` 也确实实现了该工具的调度与 `onSubModule` 回调，但 `index.js` 的 `startAgenticRun` 调 `runAgenticArticles` 时**没有传 `onSubModule`**，`lib/articles-agentic.js` 也没把这个参数往下接。结果是模型调这个工具只得到一句「已记录子模块 X（本模式下不递归成文）」——目标里「派子模块」这条能力事实上没生效，是诚实性问题而非优化项。

- **递归派发接线（`lib/articles-agentic.js`）**：`runOneArticle` 现在自带 `dispatchSub`，模型调 `generate_sub_module` 时就地递归跑一次 `runOneArticle` 写子模块文章：
  - 落盘路径 `<wiki>/modules/<父模块>/<子模块>.md`，父文章在 `<wiki>/modules/<父模块>.md`，父子分开写、互不覆盖；
  - `subDepth`（默认 2）封顶递归深度，防止模型无限往下拆；`_depth`/`_takenNames` 为内部递归参数；
  - 子模块**全局重名保护**（上游 issue #76/#113 的教训）：重名先加父模块名前缀重试，仍重则跳过并在工具结果里说明；
  - 子模块失败只记账、不拖垮父文章：工具返回里会告诉模型「把它当普通章节描述」，父文章照常算成功；
  - 返回值新增 `subModules: [{name, path, ok, stopReason}]`，`runAgenticArticles` 汇总进结果并写 job note（「X 派生出 N 个子模块文章：…」），面板可见。
  - `streamFn` 改为可注入（`streamFn` 参数优先，缺省才走宿主 `llm`），这样递归子任务在离线测试里也能用假模型驱动。

- **提示词（`lib/agentic.js`）**：`buildOpeningPrompt` 只在 `generate_sub_module` 真的出现在工具表里时才追加「拆分（可选，只在确实必要时）」一节，并写明滥用代价（拆太碎让读者在文章间跳转）与小模块阈值（<3 个组件自己写完）。工具不存在时不出现这段话，避免模型被提示去调一个不存在的工具。

- **测试（`test-articles-agentic.mjs`，7 条）**：写出文章并落盘、`generate_sub_module` 真的递归写出子文章（断言子文章路径与内容、父文章里的链接）、重名不互相覆盖、`subDepth=0` 时派发被禁用、子模块失败被记账而父文章仍成功、`runAgenticArticles` 汇总 `subModules` 并记 note、单任务抛错不影响其它任务。全部注入假 `streamFn`、走真实临时目录，离线可跑。

- 全套回归：`test-agentic` 39、`test-agentic-host` 15、`test-agentic-fallback` 10、`test-articles-agentic` 7、`test-cluster` 28、`test-symbols` 19、`test-incremental` 15、`test-incremental-e2e` 8、`test-semantic-plan` 10、`test-graphdiff` 全过、`test-batch` 128、`test-orchestration` 编排冒烟、`test-cwd-paths`/`test-sessions`/`test-wiki-entry`/`test-worktree` 全过。

- 版本 0.13.0 → 0.13.1（patch：修一条已宣称但不生效的链路）。

## 0.13.0 — 2026-10-27

### 新增：吸收 FSoft-AI4Code/CodeWiki 的三层能力（AST 聚类 / agentic 写作 / 符号级增量）

- 背景（用户需求）：用户看到 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（ACL 2026，MIT）比底层的 [mraza007/codewiki](https://github.com/mraza007/codewiki) 活跃得多，问能否换掉。核查后的结论是**不该换栈、该吸收**：`mraza007/codewiki` 是 Rust CLI 骨架，提供 `status`/`init`/`index`/`meta update` 这套文件级接口，插件与它 1:1 相符；而它**不含**「模块怎么划分」与「文章怎么写」这两件真正决定 wiki 质量的事——插件原先补的是最省事的两刀（顶层目录分组 + 源码整包内联一次成文）。FSoft 那套恰好就是在这两处做工程化，但它本身没有 `status`/`index`/`meta`，换掉会把插件的三态判定与增量链路一起丢掉，且要引入 Python 运行时（实测装下来 668MB）。用户 2026-10-26 选定「路线三：吸收优势、不换栈」，语言经三方案实测后定为 Node + tree-sitter WASM（不引 Python/Rust 运行时）。

- **符号提取（`lib/symbols.js`，884 行）**：表驱动 `LANG_RULES` 替代上游按语言逐个 `analyzer`（约 800 行/语言）。用 `web-tree-sitter` + `tree-sitter-wasms` 的 36 个 WASM 语法，覆盖 16 种语言（js/ts/py/rs/go/java/c/cpp/c#/rb/php/kotlin/scala/dart/bash/lua），产出 `Map<id, {name, kind, parameters, baseClasses, dependsOn, bodyHash, sourceCode, docstring}>`；`resolveImportEdges` 建跨文件依赖边（相对路径、包名、`__init__.py`、Go module 路径、Rust `crate::` 都有归一）。某语言无 WASM 语法时退回正则级符号提取，不影响其它语言。本仓库自检：135 个组件、0 解析失败。

- **模块划分（`lib/cluster.js`，467 行）**：移植上游 `cluster_modules.py` 的两阶段聚类——先按组件职责聚类，再对超大模块递归下钻（`CLUSTER_MODULE_PROMPT` 分支），最后 super-group 合并。`heuristicCluster` 兜底：**单顶层目录（极常见的 `src/` 布局）时自动下探到第二层**，否则整仓会被塞进一个模块。模型请求失败或没有模型时退回 `localPlan` 顶层目录分组，并在 job note 里写明降级原因。

- **文章写作（`lib/agentic.js` 401 + `lib/agentic-host.js` 101 + `lib/articles-agentic.js` 292）**：上游 `run_module_agent` 的工具循环。工具 `read_code`（带行号前缀、支持行范围）、`list_files`（递归深度）、`edit_article`（view / str_replace / insert，空文章用 insert 从第 0 行搭骨架）、`generate_sub_module`（委派子模块成文）。好处是不再把源码整包塞进 prompt，因此**没有「超预算 → 拆观察批 → 合成」那一整套**，大文件也不会退化成观察批。`agentic-host.js` 负责裸消息 ↔ 宿主 `llm.stream` 的 Message/chunk 协议适配（`makeHostStream`/`makeFsWorkspace`/`toRequestMessages`），`articles-agentic.js` 接 job 生命周期（并发池、落盘、锚点修正）。单篇空文章算失败，不会用空文件覆盖旧文。

- **符号级增量（`lib/graph-diff.js` 578 + `lib/incremental.js` 206）**：逐位移植上游 `updater/graph_diff.py`——组件级 `bodyHash` + 签名比对，区分 `interface` / `added` / `deleted` / `renamed` / `body` / `edge` 六类变更，其中 `renamed` 用「删除+新增近似」配对。`incremental.js` 负责快照存取（`.codewiki/temp/symbol-graph.json`，随 wiki 入库）、文件级 → 组件级折算、按文章 frontmatter 的 `source_files` 过滤出「哪些文章真的要重写」。**收益**：纯注释、空白、格式化、函数体局部改动不再触发全文重写。快照缺失/版本不符/提取失败一律退回文件级 mtime/hash 判定。

- **接入（`index.js`）**：新增 `planMode` / `agenticArticles` / `agenticMaxSteps` / `symbolIncremental` 四个配置，**默认全开**；三者分别设成 `dirs`/`false`/`false` 即恢复 0.12.x 旧行为。`buildPlan` 走 `semanticPlan`（新导出）并由 `extractCurrentGraph` 提供符号图；`tickArticles` 增加 agentic 通道分支，与 `startBatchChatRun` 并列的第二条执行器（结果同样进 `batchResults` 由 `settleJob` 收割），宿主重启后按 `t.tasks[*].agentic === true` 重跑而不再找 `batchPrompt`。

- **补齐退回链路（本次自查发现注释写了、代码没写）**：`index.js` 原注释称「失败率过半且旧通道可用时退回单轮通道重跑一次（见下）」，但「见下」处并不存在该实现。新增导出 `shouldFallBackFromAgentic(results)`（**严格过半**才算系统性失败，恰好一半不退）+ 内部 `shouldFallBackHere`（另守 `job.agenticRetried`，**只退一次**，否则退回后仍失败会每 tick 重新提交成死循环）。退回时**只重排失败篇**，已写成功的文章不再重写（重复写同一路径既费 token，又会覆盖掉 agentic 现场读代码写出的更好版本）。

- **修复 `tally` 的重复计数**：原逻辑只在 `replace=true`（校对阶段）时按名字查旧条目，其它阶段一律 `push`。这对新增的重跑路径是错的——agentic 失败退回单轮重跑、宿主重启整批重跑都会第二次收到同一个 `name`，导致 `writtenCount` 重复累加、`job.articles` 里留两条同名记录（面板显示成两篇）。改为**始终按名字去重**（文章名就是落盘路径，天然唯一）：曾在成功的条目不因后续失败被抹掉，由失败转成功时才把计数从 `failedCount` 挪到 `writtenCount`。

- **依赖落位（`vendor/tree-sitter/`）**：`web-tree-sitter` + `tree-sitter-wasms` 装在插件根的独立 npm 子根，**不装进插件根 `node_modules`**——后者是宿主注入的，在那里 `npm i` 会把宿主包标记 retire 并破坏运行环境（实测）。体积 56MB（对比 Python 方案 668MB）。`node_modules/` 按 `.gitignore` 规则不入库，新机器按需 `cd vendor/tree-sitter && npm i`；没装时插件照常启动，只是没有 AST 能力、三层全部自动降级。

- **设置页（`client.js`）**：新增「编译流程（吸收自 FSoft CodeWiki）」一节，含 `planMode` 下拉（auto/dirs）与 `agenticArticles` / `symbolIncremental` 开关、`agenticMaxSteps` 数字输入（1–100，硬顶 100）；中英 i18n 词条齐备。

- **测试**：新增 6 个测试文件、共 121 条断言——`test-symbols.mjs`（19）、`test-cluster.mjs`（28）、`test-agentic.mjs`（39）、`test-agentic-host.mjs`（15）、`test-agentic-fallback.mjs`（10，覆盖退回判定与可装填性）、`test-semantic-plan.mjs`（10，AST→聚类→模块清单端到端）；另有 `test-graphdiff.mjs`（78 条与 Python 原版**逐位对拍**全过）与 `test-incremental.mjs`（15）+ `test-incremental-e2e.mjs`（8，含真实临时仓库的快照落盘与四类改动场景）。`test-orchestration.mjs` 的配置基线显式钉住 `LEGACY_CHANNEL = { planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`——该文件断言的是旧通道的请求次数与装填时序，不钉住会因「通道换了」而不是「功能坏了」失败；新通道由上面几个文件守护。全套回归：新通道 9 个文件全绿、`test-batch.mjs` 128 条全过、`test-orchestration.mjs` 编排冒烟全过、其余既有测试（cwd-paths / sessions / wiki-entry / worktree）全过。

- 版本 0.12.2 → 0.13.0（minor：新增能力与配置，默认行为改变但可一键回退）。

## 0.12.2 — 2026-10-26

### 新增：编译并发按「大档 / 默认档」分开设置

- 背景（用户需求）：「编译并发的设置，大档和默认档位分开设置」。0.12.1 及以前只有一个 `maxConcurrency`，普通档任务（`batchModel`，免费 hy3）与大档任务（`bigModel`，`volces-ark/glm-5.3-flash`）在**同一个 worker 池**里抢同一个名额：一批请求里只要有 2 个大档任务在飞，默认档就被完全堵住；反过来把并发调大让默认档跑满，又会把付费长上下文的大档一起放出去。两档的额度、单价、上游限流特性本就无关，共用一个数字无法同时满足。

- 分池执行器（`index.js`，`runRealtimeTasks`）：把原来的单一 cursor/worker 组拆成两个**独立池**——`bigTier === true` 的任务进大档池（`bigConcurrency`），其余进默认档池（`concurrency`）；两个池各自维护 cursor 与 worker 数量，用 `Promise.all` 同时推进，互不阻塞。判定只看任务装填时打的 `bigTier` 标记，**不按 provider 猜**——用户完全可能把默认档也配成同一个 provider。`bigConcurrency` 为 `0`/未传时回落到 `concurrency`，与 0.12.1 的单一池行为完全等价（向后兼容）。

- 新配置项（`index.js`）：`bigConcurrency`（默认 `0`），`liveConfig` 里钳到 `1–8`（`CONCURRENCY_HARD_CAP`），`0`/非数字保持 `0` 表示「跟随默认档」。`maxConcurrency` 的描述同步收窄为「默认档并发上限」。

- 补齐两处**漏打 `bigTier` 标记**的大档任务（分池能生效的前提）：横切单批直出（`index.js` 的 `submitBatchFor` 前，原来只设 `t.provider`/`t.model`/`t.reasoningEffort`）与批量校对的 `markBigTask`。漏了标记的后果不只是「没进大档池」——它会以默认档身份占一个默认档名额，同时用大档模型发请求，池子语义与统计全错。`job.tasks` 持久化也补上 `bigTier: true`：宿主重启按 prompt 快照重跑时，否则所有请求都会掉进默认档池。

- 启动日志（`index.js`）：有大档任务时并发文案写全两档（`并发 2 + 大档 3`），大档跟随默认档时显示为 `并发 2 + 大档 2`，不再只报一个数字。

- 设置页（`client.js`）：`maxConcurrency` 标签改为「默认档并发上限」，新增「大档并发上限」数字输入（`min: 0`、`max: 8`、`placeholder: 0`，空输入归一为 `0`）。保存校验对 `bigConcurrency` 单独把关：`0` 是合法语义不报错，负值/小数/超硬顶一律拦下并提示 `invalidConcurrency`。新增 `bigConcurrency` 的中英 i18n 词条（标签 + 说明）。

- 测试（`test-batch.mjs`）：新增「大档与默认档并发分池」段 5 条，用 30ms 延迟的 mock llm 统计在飞峰值——`concurrency=2 / bigConcurrency=1` 下 7 个任务（4 默认 + 3 大档）全部完成、默认档峰值恰为 2、大档峰值恰为 1、总峰值 3（证明两池同时推进）；另一组只给大档任务、不传 `bigConcurrency`，峰值 2（证明「跟随默认档」语义）。`test-batch.mjs` 128 条全过。

- 文档：`README.md` 的并发条目拆成 `maxConcurrency`（默认档）与 `bigConcurrency`（大档）两条并写明「总在飞为两者之和」的代价；`cordis.patch.yml` 顶部配置注释同步拆行。

- 版本 0.12.1 → 0.12.2。

## 未发布 — 2026-10-26

### 文档：hy3 子智能体并发的实测结果与配置根因

- 新增 `docs/hy3-concurrency-handoff.md` 第七章「实测结果」，记录方案 B（给
  `subagent-auto-router.config.allowedModels` 补 `workbuddy/hy3`）生效后
  在同一会话内跑出的 8 路并发数据：**8/8 成功、0 限流**，总墙钟 72.6 s，
  串行估算 361.5 s，**并行加速比 5.0×**；单任务跨度 26.8–62.8 s，
  输入稳定 ~66 k tok，`agent_inspect` 身份行 8 路全为 `provider=workbuddy/hy3`。
  同时修正第一章「选方案 A」的过时前提（B 已实施并在本会话生效）。

- 补充根因说明：后台 `delegate(persist="durable")` 为 continuable 模式，
  **不下发 `structured_output` schema**（该能力只在同步模式或 workflow
  `agent(opts.schema)` 时挂载），因此要求子智能体「必须调 structured_output」
  不可行，回报走 `send_message` 自包含文本即可——属预期行为而非故障。

## 0.12.1 — 2026-10-26

### 修复：worktree / 空壳目录彻底不出现在面板与调度里

- 背景（用户需求）：「全部执行，确保 worktree 目录不会出现在任务列表中」。0.12.0 只拦住了**提交**这条路径，面板仍会显示这些目录的**历史任务**：用户截图里 `Wxxy-CampusLogin` 出现在「总览」两条相邻条目中——一条是真仓库（273 篇，增量已完成），另一条 `Wxxy-CampusLogin/adapter-switch-login-check-20261025`（未编译，排队中·自动）。后者是 worktree 删除后留下的空壳：`git rev-parse` 报 `fatal: not a git repository`（所以 `detectLinkedWorktree` 抓不到），目录里只剩 `.codewiki/_meta.yaml` 一个文件加空的 `node_modules` 骨架，`scanRepoFiles` 返回 `[]`，于是每轮自动调度都提交、每次都在本地规划阶段 fail `仓库没有可编译的源码文件`，在 `%TEMP%/dsh-codewiki-jobs.json` 里攒出了 14 条任务（13 failed + 1 queued）。

- 统一判定 `isDeadCompileTarget(cwd)`（index.js）：`isWorktreeCwd(cwd)` 或［目录存在且 `!hasCompilableSources(cwd)`］。**目录已不存在时不算 dead**——那是「历史任务的目录后来被删了」，历史记录仍有查看价值，不因 `statSync` 失败就抹掉用户数据（移动硬盘/网络盘临时不可访问同理）。面板任务列表、仓库总览、启动清理三处共用这一个判据，避免三套条件各自漂移。

- 三个带缓存的判定（index.js）：`isWorktreeCwd(cwd)`（60s 缓存，包 `detectLinkedWorktree` 返回布尔）、`hasCompilableSources(cwd)`（10min 缓存，`scanRepoFiles(dir).length > 0`）、`clearSourceProbeCache(cwd)`（手动提交前清缓存，刚 clone / 刚 checkout 不被 10 分钟前的空判定挡住）。加缓存的原因：`/api/codewiki/jobs` 是 2s 轮询端点，逐任务 `spawnSync git` 会把宿主事件循环拖住（git 冷启动数十毫秒 × N 任务 × 每 2 秒），大仓库的文件树遍历也不该每分钟重跑。

- 空壳目录闸门（index.js，`svc.submit` 与 `codewiki_generate` 双处）：`auto` 返回 `{skipped:'no-source'}` / `state:'no-source'` 静默跳过，手动抛 `该目录没有可编译的源码文件（空目录或只剩 .codewiki / node_modules 等黑名单目录），不编译：<cwd>`。**闸门放在跑 `cw status` 之前**——空壳目录里的 `_meta.yaml` 往往本身也残缺（主仓库被删后只剩骨架），先让 `cw status` 跑只会抛 `Failed to parse _meta.yaml: missing field project` 这种对用户毫无意义的解析错。

- 启动清理（index.js，`createJobService`）：遍历 jobs，`isDeadCompileTarget` 命中的 cwd 全部历史任务从 `JOBS_FILE` 移除并对每个 `forgetRepo(dir)`（新增导出，从已知仓库登记里摘掉，只改插件自己的 `%TEMP%/dsh-codewiki-repos.json`，不碰用户磁盘目录）。只在启动时跑一次。

- 面板过滤（index.js）：`/api/codewiki/jobs` 的 `list = list.filter((j) => !isDeadCompileTarget(j.cwd))`；`/api/codewiki/repos` 的 `putCwd()` 开头 `if (isDeadCompileTarget(dir)) return`；`autoScan` 里 `detectLinkedWorktree(cwd)` 换成带缓存的 `isWorktreeCwd(cwd)`，其后新增 `if (!hasCompilableSources(cwd)) continue`（不产生 job、不进 `queueAhead` 的「在等谁」名单）。

- 测试：`test-worktree.mjs` 从 8 条扩到 22 条（新增 `isWorktreeCwd` 布尔封装与缓存一致性、`hasCompilableSources` 有源码/只剩 .codewiki/不存在路径、`isDeadCompileTarget` 主工作区/worktree/空壳/目录不存在/空值五态）全过；`test-orchestration.mjs` 新增「空壳目录」段 7 条（提交报错、auto 不提交、jobs 端点过滤掉空壳任务且保留正常任务、仓库总览不含空壳目录）全过，其余 `test-batch`（123）、`test-cwd-paths`、`test-sessions`、`test-wiki-entry` 全过。修正一处测试自身的问题：面板过滤段的「正常任务」cwd 原用 tmp 里的 fixture，会被 0.4.6 的 Temp 残留清理先一步移走，改用仓库自身路径。

- 已知边界：`isDeadCompileTarget` 对**已删除的目录**返回 `false`，所以「目录已被用户删掉」的历史任务仍留在面板（有意为之，见上）；空壳判定依赖 `scanRepoFiles` 的 2000 文件上限与黑名单目录，全部源码都落在 `node_modules` / `.next` / `dist` 这类黑名单里的极端仓库会被误判为空壳——正常仓库不受影响。

- 版本 0.12.0 → 0.12.1。

## 0.12.0 — 2026-10-26

### 新增：全局「会话」Tab + worktree 拒绝编译 + 会话记录定时清理确认

- 背景（用户需求）：①「增加可以查看目前正在进行的会话内容，就像给 codewiki 专门开的会话，保存一天时间只在 codewiki 界面查看。这个好似没有实现」——0.11.0 的记录能力只挂在**每个任务行**的「会话」按钮上，不点进任务就看不到，跨任务也汇总不了；②「不要给 worktree 中的文件编译 code wiki，等它合并到仓库中再统一编译」——隔离工作区与主仓库各编一遍会让产物互相覆盖、提交时机混乱。
- 全局会话 Tab（index.js + client.js）：`listAllSessionRecords({limit, jobIds})` 跨所有任务聚合记录元数据（只读轻量 meta，全文仍按 `(jobId, n)` 单条拉），按 `startedAt` 倒序、limit 兜底 200。`GET /api/codewiki/sessions`（不带 `jobId`）改为全局聚合，并回填每个任务的 `cwd`——面板行里能直接看出「哪个任务 · 哪个仓库」在跟模型说什么；带 `jobId` 时行为不变（向后兼容）。面板顶部新增「会话」Tab，直接渲染 `SessionView job={null}`；该视图与原单任务视图共用组件：`global=!job` 时走聚合接口、行内追加任务短 id 与仓库名、选中项由 `n` 改为 `{jobId, n}` 以支持跨任务拉全文。5s 轮询与 running 闪烁不变，仍保留 24h。
- worktree 闸门（index.js，`detectLinkedWorktree`）：判据只用 git 自己——`git rev-parse --git-dir --git-common-dir` 两者 resolve 后不同即 linked worktree（主工作区两者都是 `.git`；submodule 也相同，不误判；非 git 仓库放行）。三处拦截：`svc.submit`（所有入口的公共汇合点，`auto` 时返回 `{skipped:'worktree', reason}` 不抛错）、`codewiki_generate` 工具（在跑 `cw status` **之前**就拦，报错文案含真实 `gitDir` 并说明「请等合并回主仓库后统一编译」；`auto` 直调时降级为 `state:'worktree'` + note 返回，`wikiPath` 给空串以满足 output schema）、`autoScan`（历史任务里的 worktree 路径静默跳过，不污染 note）。
- 清理确认：`pruneSessionRecords()` 在 `tick()` 内每 10 分钟静默跑一轮（`SESSION_TTL_MS=24h`），过期记录与随之为空的 job 目录一并移除。
- 测试：新建 `test-worktree.mjs`（真实 `git init` + `git worktree add` 造环境，8 条断言：主工作区放行 / linked worktree 命中 / gitDir 指 `.git/worktrees/<name>` / commonDir 指主仓库 `.git` / 不存在路径不误报 / worktree 子目录命中 / 非 git 目录放行 / 空输入放行）全过；`test-sessions.mjs` 加全局聚合段（跨任务聚合、startedAt 排序、每条带 jobId、limit、jobIds 过滤、无匹配为空）全过；`test-orchestration.mjs` 加 worktree 闸门段（worktree 目录提交报错、文案核对、主工作区照常提交到 done、auto 调度扫到 worktree 记 note 不提交）并修正会话单任务断言，全过；`test-batch.mjs` 123/123。
- 版本 0.11.2 → 0.12.0。

## 0.11.2 — 2026-10-25

### 变更：大档思考档位在模型目录未声明时也可手动调节

- 背景（用户需求）：trae/mimo-v2.6-flash 等模型在宿主模型目录中不声明 reasoning efforts（`/api/codewiki/model-efforts` 返回空数组），面板设置页遇到这种情况就把大档「思考程度」锁死为「模型默认」无法调节。
- 面板（client.js）：目录未声明 efforts 时不再渲染死下拉，改为通用档位下拉（模型默认 + off/low/medium/high/xhigh/max，常量 `GENERIC_EFFORTS`），配文案说明「若模型不支持所选值，请求会自动回落模型默认档（不会失败）」——安全性由 0.11.1 的 llmChat 剥档重试兜底保证。已配置但不在通用列表的残留值保留为自定义选项。
- 验证：`node --check client.js` 通过；`test-batch.mjs` 123/123。版本 0.11.1 → 0.11.2。

## 0.11.1 — 2026-10-25

### 修复：大档任务思考档位回落错误导致整批失败（job-mvnxh0am-0 根因之一）

- 现象：codewiki 仓库自编译任务 19 篇全失败。8 个大档请求（trae/mimo-v2.6-flash）全部 `UNSUPPORTED_REASONING_EFFORT: does not support reasoning effort "off"`；其余 11 个是 workbuddy 上游 502（账号池 3 个账号全不可用，外部服务问题）。
- 根因（index.js `runRealtimeTasks`）：`markBig` 给大档任务 `delete t.reasoningEffort`（大档未配 effort → 用模型默认档），但并发池 `reasoningEffort: t.reasoningEffort || reasoningEffort` 把它回落到普通档配置的 `off` 下发——大档模型不支持 off，请求全灭。
- 修复一：任务自带 provider+model（大档任务）时 effort 完全以任务为准（空=模型默认档），不回落普通档配置。
- 修复二（兜底，index.js `llmChat`）：流式 finish 为 error 且 code=`UNSUPPORTED_REASONING_EFFORT` 且本次带了 effort 时，剥掉 effort 用模型默认档重试一次——任何模型/配置组合不再因此整篇失败。
- 测试：test-batch 断言按新语义更新（「大档任务未指定档位时不回落普通档」），123/123 过；`test-orchestration.mjs` 冒烟全过。版本 0.11.0 → 0.11.1。

## 0.11.0 — 2026-10-25

### 新增：编译会话透明化（面板可看 LLM 会话内容，保留 24h）+ 并行项目推进 + 排队可见性

- 背景（用户需求）：①编译任务排队长（实测单任务排队 2h05m：serialProjects 串行闸门 + 当天 32 个任务逐个排队），面板「已用时」把排队计入且看不到「在等谁」，严重误导；②用户要求「增加可以查看目前正在进行的会话内容，就像给 codewiki 专门开的会话，保存一天时间只在 codewiki 界面查看」。
- 并行调度（index.js）：新增配置 `parallelProjects`（z.number().default(2)，1–4）；派生 `parallelLimit`——`serialProjects=true` 时恒 1（行为与旧版完全一致），否则 clamp(round(parallelProjects),1..4)。tick 闸门由单选 activeId 改为 `activeIds` 集合：忙碌项优先入集，再按提交顺序唤醒最早 queued 直到上限；submit 的排队判定改为 `busyOthers.length >= limit`。关闭单项目串行后多仓库同时编译，不再互相排队。
- 排队可见性（index.js）：jobs 端点为每个 queued job 注入 `queueAhead`（正在跑的 + 排在前面 queued 的仓库 basename 数组）与 `queueAheadCount`。
- 会话记录（index.js，新模块）：`SESSIONS_DIR=<tmp>/dsh-codewiki-sessions/<jobId>/`，每请求双文件 `nnn.meta.json`（轻元数据）+ `nnn.full.json`（prompt/output 全文）；`SESSION_TTL_MS=24h`、流式 3s 节流落盘。导出 `listSessionRecords(jobId)` / `readSessionRecord(jobId,n)` / `pruneSessionRecords(now,ttl)` / `SESSIONS_DIR`；私有 `beginSessionRecord(job,task)` 返回 `{onDelta,onDone,onError}`——`onDelta` 尽力从流 chunk 提取增量文本，完成时以全文覆盖。`llmChat` 加可选 `onDelta` 回调（逐 chunk try/catch），`runRealtimeTasks` 加可选 `onRequestStart`，`startBatchChatRun` 接线记录每个请求。tick 每 10 分钟静默 prune 一次。新端点 `GET /api/codewiki/sessions?jobId=`（倒序列表）与 `GET /api/codewiki/sessions/item?jobId=&n=`（全文，404=过期），仅回环可达。
- 面板（client.js）：①任务卡「已用时」拆「排队 X · 执行 Y」（queued 态只显排队，排队时长取 stageTimings.queued ?? 实时差）；②queued 且 queueAhead 非空时渲染「在等：a → b」行；③每张任务卡新增「会话」按钮 → SessionView：列表 5s 轮询（running 项闪烁指示），点击拉单条全文（prompt 折叠 + output 正文）；④设置页新增 `parallelProjects` 数字输入（serialProjects=true 时禁用并提示）。样式追加 sess/queueahead 系列 + `@keyframes dscw-pulse`。
- 测试：新建 `test-sessions.mjs`（列表倒序/全文读取/TTL prune/幂等/空目录移除）全过；`test-orchestration.mjs` 串行段加 queueAhead 断言（实测 `["cw-orch-…"]` ✓）、新增「并行项目上限」段（serialProjects:false + parallelProjects:3，A/B 两仓库同时提交，断言 B 不 queued、双双 done）✓。`test-batch.mjs` 123/123 ✓。
- 版本 0.10.11 → 0.11.0。

## 0.10.11 — 2026-10-25

### 变更：编译收尾新增独立 commit 阶段——产物提交改走「主题分支 → 合并回原分支」

- 背景（用户需求）：0.10.9 的 autoCommit 是在 index 收尾后顺带执行、直接提交到当前分支，不是流程里的显式一步，产物提交也永远长在用户的当前分支上。用户要求「增加流程，最后一步提交分支合并」：把提交升级为阶段机里的独立阶段，并以主题分支合并的方式落库。
- 阶段机（index.js）：`STAGE_HANDLER` 新增 `commit: tickCommit`，阶段顺序变为 queued → articles → crosscut → compose → review → index → commit → done。`tickIndex` 末尾在有产物且开关开启时 `setStage('commit')` 提前返回，不再就地提交；`tickCommit` 执行提交后才置 done/finishedAt 并唤醒会话——终态因此最多晚一个 tick（默认 TICK_MS 10s，测试 300ms），换面板上可见的「提交产物中」一步。中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等。
- 提交方式（index.js `autoCommitWiki` 重写）：先建主题分支 `codewiki/wiki-<jobId>`，在其上 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（pathspec 限定两个路径的老规矩不变），再切回原分支 `git merge --no-edit` 合并（能 ff 则 ff），成功后 `git branch -d` 删主题分支（`-d` 只删已合并分支，绝不强删）。
- 降级与安全：detached HEAD（无「原分支」可回）或建主题分支失败 → 降级为直接提交（`mode:'direct'` + `fallback` 原因，与 0.10.9 行为一致）；进入主题分支后任何失败先切回原分支，绝不把用户留在插件建出的分支上；合并冲突/失败 → `git merge --abort`、保留主题分支，返回 `committed:false` 与说明（产物不丢，等手动合并），绝不强合。0.10.9 的全部前置安全检查（非 git 仓库、无 HEAD、merge/rebase 中、未解决冲突、被 .gitignore 忽略、缺 user.name、无改动 noChanges）原样保留且在分支切换之前执行。
- 面板（client.js）：`ACTIVE_STAGES` 加 `commit`（步骤条显示「提交产物中」/「Committing」），进度权重改为 articles 0.63 / commit 0.02（总和不变）；任务卡自动提交成功行追加主题分支名；`autoCommitHint` 双语说明改为分支合并式语义。
- schema/文案（index.js）：`codewiki_progress` 的 job.autoCommit 输出增加 `mode`/`branch`/`fallback` 字段；`autoCommit` 配置描述与 `codewiki_generate`/`codewiki_update` 工具描述、系统提示 section 同步为「主题分支提交后合并回原分支」。
- 测试（test-orchestration.mjs）：正常提交断言升级（mode==='branch'、主题分支已删除）；新增 detached HEAD 降级直接提交用例、主题分支名被占用降级用例（预占分支不被误删）；端到端补断言「走过独立 commit 阶段（stageTimings 含 commit）」与「mode==='branch'」。合并 add/add 冲突路径（编译期间用户在原分支推进）同步流程内构造不出来，为防御性代码、单测不覆盖（用例内注释说明）。
- 验证：`node test-orchestration.mjs` → `PASS：编排冒烟全部通过`（exit 0；无 ✗，端到端阶段计时含 articles/crosscut/review/index/commit）。
- 版本 0.10.10 → 0.10.11。

## 0.10.10 — 2026-10-24

### 修复：两轴 code-review 的全部发现（自动提交语义、边界与测试竞态）

- 背景：0.10.9 把「编译产物提交」从会话模型收回插件侧后，做了双轴评审（Standards：是否守本仓成文约定；Spec：是否忠实实现「会话模型不必等编译、产物由插件自己提交」）。评审发现三类问题：①三态语义漏了「产物无改动」——插件其实没失败，却被唤醒通道和系统提示各催一次提交；②文档/注释与代码不一致（`git add -A` 与「只 add 两个路径、绝不 -A」的自述矛盾）；③测试存在两处竞态，其中一处是历史遗留的 tmp 文件污染。
- 修复一（index.js `autoCommitState`，新增导出）：`committed` / `no-changes` / `pending` 三态的唯一判定。`wakeCompileSession`（实时 steer）与 `commitHintText`（系统提示 section）原先各写一遍判断，只看 `committed===true`，于是 `noChanges` 被当成失败：会话被唤醒一次、系统提示再注入一次「产物待提交」，让会话模型去提交一个不存在的东西——正是本次要消灭的「无谓等待/无谓动作」。现在两条通道共用同一函数，`no-changes` 一律静默；旧 job（无 `autoCommit` 字段）仍按 `pending`，与升级前行为一致。
- 修复二（index.js `autoCommitWiki`）：`git add -A -- .codewiki CodeWiki.md` 改为 `git add -- .codewiki CodeWiki.md`。`-A` 与 pathspec 同用时行为虽等价，但与本函数注释、README、CHANGELOG 反复强调的「只 add 这两个路径，绝不 `-A`」直接冲突——读代码的人会以为哪儿写错了，或以为将来去掉 pathspec 也安全。改动由 `WIKI_PATHS`（index.js:36）唯一定义，`git log`/`check-ignore`/`add` 三处共用。
- 修复三（错误上报）：`autoCommit` 被拒时不再只写 `committed:false`——`git add`/`git commit` 自身失败（含 `index.lock` 被并发 git 占用的常见情形）现在返回具体 stderr 摘录进 `reason`，降级提醒里能看到真实原因，而不是笼统的「产物尚未提交」。
- 修复四（client.js 面板）：任务卡显示自动提交三态——成功显示短 sha、`noChanges` 显示「产物无改动，未提交」、失败显示「产物未自动提交（原因）」。此前 `autoCommit` 只进 `jobSummary` 不进 UI，用户在面板上看不到插件到底提交了没有。
- 修复五（测试竞态 A，`test-orchestration.mjs` 并发提交块）：旧块用「模型通道失败」当 mock，任务在几百毫秒内进入 failed 终态，`Promise.all` 的第二次 `execute` 走到 `submit` 时已经查不到活动任务，于是新建第二个 job，偶发报「并发提交共享同一 job」失败——与占位逻辑无关，纯测试竞态（复现率约 1/4）。改为 `makeBatchMock({ stall: true })`：任务挂起在 articles 不自行终态，并在前后各用 `/api/codewiki/control` 取消收尾。连跑 5 次全部通过（改前 4 次里失败 1 次）。
- 修复六（测试竞态 B，tmp 文件污染）：测试的 jobs 文件只按 pid 命名（`dsh-codewiki-jobs-test-<pid>.json`），Windows pid 复用后会把历史运行留下的同名文件原样读入，其中的 `job-tmp-active`（`cw-orch-alive`，articles 阶段）被单项目串行逻辑判为「已有项目在编译」，后续所有提交变成 `queued`，表现为「偶发 20 项失败」（实测复现过）。现在文件名追加随机 token，收尾删除本文件；tmp 下 74 个历史残留文件即为证据。
- 测试补充：`autoCommitState` 三态单测（含 `committed` 优先于 `noChanges`、空 job 不抛）、`wakeCompileSession` 在 `noChanges` 时零唤醒、`commitHintText` 在 `committed`/`noChanges` 时静默、`pending` 时提醒且带失败原因。
- 文档：README/CodeWiki.md 同步三态语义、pathspec 表述与失败原因上报。
- 验证：`node test-orchestration.mjs` 连跑 5 次全通过（0 失败）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths.mjs` / `test-wiki-entry.mjs` 全部通过；`test-wiki-anchors.mjs` 6918 过 / 335 败（失败全为 wiki 文章里的历史行号漂移，且本次代码改动导致行号整体下移，由随后的 codewiki 编译与 `fixAnchors` 校正）。
- 版本 0.10.9 → 0.10.10。

## 0.10.9 — 2026-10-24

### 修复：编译产物由插件自己提交，会话模型不再等待编译完成（设计缺陷根治）

- 背景（用户报障）：`codewiki_generate` 提交后，会话模型习惯性地「等编译完成 → 自己跑 git 提交」，而编译是宿主后台任务、动辄几分钟——会话模型就在那儿空转/轮询，一轮对话被编译拖住。根因不是文案不够清楚，而是**提交这件事被外包给了会话模型**：产物落盘在后台，提交却要前台做，前台自然要等后台。
- 修法一（index.js 新增 `autoCommitWiki`）：编译终态（done 且有文章写成功）由插件自己 `git add .codewiki CodeWiki.md` + `git commit --no-verify -m "docs(wiki): … <jobId> <N> 篇"`。责任从会话模型收回到插件侧，会话调用完工具就可以继续干活，编译完成后没有任何一步需要它参与。结果写入 `job.autoCommit`（`committed/sha/message/noChanges/reason`），面板与 `codewiki_progress` 直接显示。
- 修法二（安全边界，任一不满足即**拒绝并降级**、绝不做半个提交）：非 git 仓库、无 HEAD、`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 存在（不把 wiki 夹进别人的合并提交）、`git ls-files -u` 有未解决冲突、`.codewiki/` 或未 tracked 的 `CodeWiki.md` 被 `git check-ignore` 忽略（否则 `git add` 会静默什么都不做、误报「无改动」丢产物）、缺 `user.name`/`user.email`、add/commit 失败。只 add 这两个路径（绝不 `-A`）、不 amend/push/改写历史、不跑仓库钩子、不触碰工作区其它改动。
- 修法三（`wakeCompileSession`）：旧行为编译 done 也 steer 会话、要求会话模型提交，这正是「会话模型停下来等编译」的机械根源。现在 `autoCommit.committed === true` 时**直接 return，完全不打扰会话**；只有 failed、或成功但自动提交被拒时才 steer 一次，且文案改为「请处理失败原因」而非「请提交」。面板/自动调度提交与冷会话仍静默跳过。
- 修法四（工具返回文案 `codewiki_generate`/`codewiki_update` 与系统提示 section）：把「调用后继续下一项、提交由插件自动完成」写进工具返回值顶层 `notes` 与 description，明确「**本步不必等待编译、不必调用 `codewiki_progress` 轮询、不必自己 git 提交**」；`commitHintText` 从「请提交改动」改为只在自动提交失败时出现的「产物待提交（附原因）」，并写明不要为此中断任务。
- 设置项：新增 `autoCommit`（默认 true）。关掉即退回旧行为（插件只提醒、由会话模型提交）。
- 面板（client.js）：编译设置节加「产物自动提交」开关与说明；任务详情显示自动提交结果（成功显示短 sha，失败显示原因）。
- 测试（test-orchestration.mjs）：新增自动提交断言组——正常提交（只含两个路径、信息前缀 `docs(wiki):`）、无改动 `noChanges` 不空提交、非 git 仓库/合并中/冲突/被 ignore/缺身份各拒绝分支、`autoCommit=false` 不提交、唤醒在自动提交成功时不 steer。
- 文档：README/CodeWiki.md 同步自动提交边界与会话侧新姿势。
- 验证：`node test-orchestration.mjs` 全部通过；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths.mjs` / `test-wiki-anchors.mjs` 全部通过。
- 版本 0.10.8 → 0.10.9。

## 0.10.8 — 2026-10-24

### 变更：编译流水线全面适配 hy3 192k 上下文——放弃 32k 时代定制的拆批策略，改「大档单请求优先」

- 背景：110k/128k 分块与「观察→合成」拆批是 32k 上下文 qwen3.7flash 时代的遗产。hy3 192k + 大档 420k（volces-ark/glm-5.3-flash 512k）装得下绝大多数模块，为比价而拆批纯属浪费请求与轮次。用户拍板：①观察→合成链保留，但仅超 420k（大档预算）才启用；②会话通道保留不动；③校对改批量。
- 写文章（index.js `prepareArticleTasks` 重写）：装填直接按大档预算（未配大档=128k 硬上限）整模块单请求——110k–420k 区间输入升大档一次写完；仅当模块源码总量超 420k（或有单文件在装填中被跳过）才按 110k 逐文件拆观察批（原「110k 即拆」与 batches.length===1 特例删除）；单文件连大档都装不下的整任务转会话通道（唯一兜底）。
- 横切（`tickCrosscut`）：总量 ≤ 大档预算即单批直出（超 110k 时任务标大档模型，note「（大档装填）」）；超 420k 才走原有观察拆分 → compose 合成。
- 批量校对（`tickReview` 重写 + 新增 `batchProofreadBatchPrompt`/`settleProofread`）：逐篇准备（文章 + 按「预算−文章 token」装填源码，110k 装不下升大档重装）后按 110k 贪心合并成批量校对请求，请求数从 ≈文章数降到 ≈总输入/110k；模型输出按 `@@@article: 名`/`@@@end` 标记分节拆回逐篇，`writeValidated` 校验通过才覆写，缺席/非法文章保留原文（校对失败不推翻已写成功的文章）；单篇源码连大档都装不下转会话通道兜底；`submitBatchFor` 持久化快照补记 `proofreadItems`（宿主重启重跑与 settle 拆回都依赖）。
- 修复（评审遗留）：① client.js `lastTimedStage` 过滤 `ACTIVE_STAGES`——旧任务残留 `stageTimings.plan` 键不再导致失败/取消时步骤条全熄不标红；② `localPlan` slugify 保留 CJK（`\p{Script=Han}`），多个中文顶层目录不再合并成单模块 'module'；③ `bigTokenBudget` 设置描述同步新语义。
- 文档：README/CodeWiki.md 同步五环节阶段机、大档 420k 语义、批量校对、repos 缓存签名失效（补 0.10.7 遗留的文档失同步）。
- 测试（test-orchestration.mjs / test-batch.mjs）：mock 审校员支持批量标记格式；分割 fixture 改 15×100KB/模块（合计 ≈439k>420k 才触发拆分，256KB 扫描上限内）；test-batch 断言按新装填语义校准。
- 验证：`node test-orchestration.mjs` 全部通过；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` / `test-wiki-anchors`（断言部分）全部通过。
- 版本 0.10.7 → 0.10.8。

## 0.10.7 — 2026-10-24

### 变更：删除编译流水线规划（plan）阶段——提交后直接进 articles

- 背景：单独的规划阶段为模块划分花一次独立模型请求（勘探员批：扫源码→应答模块清单 JSON）。现在编译模型上下文足够大，模块划分不值得一次独立请求；且规划应答非 JSON 时还要走降级路径。
- 修法（index.js）：① 删 `tickPlan`（规划阶段处理）、`batchPlannerPrompt`（「你是代码结构勘探员」勘探员批 prompt）、`parsePlan`（规划 JSON 收割）三段；② `STAGE_HANDLER` 去 plan 行，queued 唤醒恒进 articles，提交（submit）恒 `setStage('articles')`；③ `tickArticles` 组装分支：full 编译无 `job.plan` 时就地 `localPlan(scanRepoFiles(cwd))`（按顶层目录分组，原降级路径升为唯一规划路径），notes 记「规划：N 个模块（本地顶层目录分组，规划阶段已移除）」；④ 兼容旧磁盘任务：stage='plan' 的存量任务（宿主升级瞬间恢复）清掉规划批次引用与旧勘探员任务清单，迁移到 articles 按 localPlan 重建，notes 记「旧版规划阶段任务迁移到 articles」；⑤ 横切阶段对 concepts 空数组已兼容（只产 `_architecture`/`_patterns`）。
- 面板（client.js）：阶段条去 plan（`ACTIVE_STAGES`/`STAGE_WEIGHTS`——plan 的 0.05 权重并入 articles 得 0.65，总进度分母不变）、删 stagePlan/stepPlan 中英文标签、编译设置文案去「规划」。
- 测试（test-orchestration.mjs）：规划块重写为本地规划断言（零勘探员请求、localPlan 入库、concepts 空、notes 记录），删「规划应答非 JSON 降级」场景；fixture 仓库从单层 `src/` 改为顶层 `core/`、`util/` 两目录（localPlan 顶层目录分组直接决定模块名）；恢复块场景 B 改为旧 plan 快照迁移断言（勘探员快照作废、迁移后按 localPlan 重建）；横切/串行/面板各块的 plan 阶段断言改 articles；`writtenCount` 基线 5→4（无概念文章）、stale 精确更新 3→2 篇。
- 验证：`node test-orchestration.mjs` 188 通过 / 0 失败（含本地规划、旧任务迁移、分割、串行、面板、schema 校验全块）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` 全部通过。
- 版本 0.10.6 → 0.10.7。

## 0.10.6 — 2026-10-24

### 修复：面板藏掉占串行闸门的工作区外编译任务（「到底哪个在编译」盲区）

- 症状：面板上多个任务排队（note「已有项目在编译（perf-dock-glass-primitives-20261024）」），但面板历史里找不到这个正在编译的项目——用户看不到谁占着串行闸门、也无法从面板取消它。实际占用者是 `E:\...\worktrae\Wxxy-CampusLogin\perf-dock-glass-primitives-20261024` 的 worktree 编译任务（jobs 磁盘状态 30 条，面板 API 只回 29 条，缺的正是它）。
- 根因：`/api/codewiki/jobs` 与 `/api/codewiki/repos` 的 workspaceOnly 过滤（默认开）把 cwd 不在宿主工作区清单里的任务一概藏掉——worktree 目录天然不在清单内。编译服务（tick 闸门）用完整任务表不受此过滤，于是出现「面板不可见的项目占住闸门、其余项目全部排队」的盲区。
- 修法（index.js）：① jobs 端点过滤改为 `!JOB_TERMINAL.has(j.stage) || isExcluded(j.cwd, wsPaths)`——**非终态（queued/编译中）任务始终显示**，只有终态任务按工作区过滤降噪；② repos 总览的 `putCwd` 同样放行非终态任务的工作区；③ repos 30s 缓存签名加入当前非终态任务的工作区路径——编译中仓库进出总览立即反映，不吃陈旧缓存。
- 验证：`node test-orchestration.mjs` 编排冒烟全部通过（0.4.9 块新增断言：stall 占住的工作区外 full 编译任务在 jobs 端点与 repos 总览均可见、取消终态后恢复被过滤）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` 全部通过。
- 版本 0.10.5 → 0.10.6。

## 0.10.5 — 2026-10-24

### 修复：codewiki_progress 工具输出校验失败（progress 为 null 时整个调用报错）

- 症状：调用 `codewiki_progress` 报 `tool "codewiki_progress" returned invalid output: "value.jobs[27].progress" must be a number`，进度查询完全不可用；任务列表里只要有一个无 taskList 的任务（如「已是最新、无需编译」的任务 `taskList: 0`）就必现。
- 根因：`progressView`（index.js:2380）在任务无 taskList 时输出 `progress: null`（render 分支 `j.progress === null ? '' : …` 证明 null 是设计内取值），但输出 schema 把 `progress` 声明为 `{ type: 'number' }` 不允许 null，宿主对工具输出做 schema 校验时整个结果被拒。同 schema 里 `tps`/`error`/`finishedAt`/`batchProgress` 四个可空字段都写了 `oneOf: [type, null]`，唯独 `progress` 漏了。
- 修法（index.js）：`progress` schema 改为 `oneOf: [{ type: 'number' }, { type: 'null' }]`，与其他可空字段写法一致。
- 验证：`node test-orchestration.mjs` 编排冒烟全部通过（其断言本就覆盖 `progress === null` 合法取值）；`node test-batch.mjs` 123 通过 / 0 失败；`test-cwd-paths` / `test-wiki-entry` 全部通过。`test-wiki-anchors` 27 处锚点漂移为既有状态（文章行号基线未跟上源码），与本次一行替换（不增删行）无关，由 0.10.5 增量编译修正。
- 附注：编译任务本身的会话通道报错「超批量预算需走会话通道，但发起会话不可用」为 0.9.0 设计内降级（面板/自动调度提交无发起会话，无法派子智能体），从会话内重新提交即可，非本次修复范围。
- 注意：插件以 `file://` 挂载，改源码后宿主不热重载，需重启 DeepSeek Harness 生效。
- 版本 0.10.4 → 0.10.5。

## 0.10.4 — 2026-10-23

### 修复：设置页「思考程度」永远读不到档位（调错了宿主方法名）

- 症状：插件页「编译模型 → 思考程度」一直显示「读取思考档位失败（llm 服务未注入或缺少 resolveModel，无法读取思考档位）」，下拉无法选择任何档位。运行中宿主实测复现：`GET /api/codewiki/model-efforts?provider=workbuddy&model=hy3` 返回该错误串。
- 根因：`resolveModelEfforts` 调 `llm.resolveModel(provider, model)`。但宿主提供的 `LlmService` 暴露的方法是 **`resolveModelInfo(provider, model, signal)`**；`resolveModel` 只存在于 adapter 注册表接口（`LlmAdapterRegistry`，`packages/llm/llm/lib/types/index.d.ts:180` vs `:377`）。插件持有的是 `LlmService`，所以这次调用恒失败——配置链路本身没问题，是方法名写错。
- 修法（index.js）：新增 `resolveModelInfoOf(llm)`，优先 `resolveModelInfo`、缺失时回落 `resolveModel`（兼容旧宿主与测试桩）；错误文案同步改为「缺少 resolveModelInfo」。返回结构保持 `{ok, provider, model, efforts, defaultEffort, context}` 不变，设置页无需改动。
- 验证：假 llm（只实现 `resolveModelInfo`）→ 正确读出 hy3 的 `off/low/high` + `defaultEffort: high`；未知路由 → `ok:false` 不崩；`llm=null` → 明确提示未注入；旧 adapter 形态仍可用。

### 新增：大档模型（超长输入不再交会话模型）

- 需求：超过 128k 的内容也不再交给发起会话的主模型/子智能体，插件内自己跑完。
- 新配置四项：`bigProvider`（默认 `volces-ark` 火山方舟）、`bigModel`（默认 `glm-5.3-flash`，512k 上下文、maxTokens 128000、思考档 low/high/max）、`bigReasoningEffort`（默认空 = 模型默认 high）、`bigTokenBudget`（默认 420000，下限被 `BATCH_TOKEN_BUDGET` 110k 兜住）。
- 分派（index.js `prepareArticleTasks`）：新增 `bigProvider/bigModel/bigReasoningEffort/bigBudget` 参数。普通档装不下（单文件超 110k、或整条 prompt 超预算）时，先按大档预算重新装填；装得下就把任务标 `bigTier` 并带上自己的 `provider/model/reasoningEffort` 进 prepared，在插件内一次写完。**只有大档也装不下，才落到会话通道**；`bigProvider` 留空 = 关闭大档，退回 0.10.3 的旧行为（超 128k 走会话通道）。
- 执行（`runRealtimeTasks`）：改成按每个任务自带的 `provider/model/reasoningEffort` 分派，缺省回落参数里的普通档——同一并发池里可以混合两档模型，并发仍受 `maxConcurrency`（2）约束。
- 持久化（`submitBatchFor`）：`bigTier` 任务的 `provider/model/reasoningEffort` 一并写进 `job.tasks`，宿主重启接管后按同档重派，不会掉回装不下的普通档。阶段 note 会显示 `普通档 + 大档（N 个）`。
- 设置页（client.js）：抽出 `modelTrio({pKey,mKey,eKey,state,...})` 复用「提供商/模型/思考程度」三行渲染与目录联动（换提供商清空模型与旧档位），普通档与大档共用；新增「大档模型（超长输入）」分区与「大档输入预算」输入框。`bigProvider` 留空时下拉首项为「（未启用大档）」。中英词条 18 个新 key 全部齐备。

### 测试

- test-batch.mjs 新增两块共 14 项：大档接管（800KB/≈234k token 单文件不再进 `sessionTasks`、带 `bigTier` 与自身 provider/model/档位）、大档关闭退回会话通道、普通任务不被误标；以及混合池分派（大档任务覆盖 provider/model、未指定档位回落参数档位）。
- 结果：`node test-batch.mjs` **123 通过 / 0 失败**；`node test-orchestration.mjs` **编排冒烟全部通过**；`node --check index.js` / `client.js` 均 OK。

### 注意

- 插件以 `file://` 路径挂载（`~/.dsh/profiles/desktop/cordis.patch.yml`），改源码后**宿主不会热重载**，需重启 DeepSeek Harness 才生效。
- 版本 0.10.3 → 0.10.4。

## 0.10.3 — 2026-10-23

### 修复：单文件 110k–128k 的文章被误判「装不下」而白送会话通道

- 背景：0.10.0 把 `BATCH_TOKEN_BUDGET` 提到 110k、0.10.2 把 `BATCH_TOKEN_HARD_LIMIT` 收到 128k 后，实际编译一次 stale 更新时**15–16 篇全部转会话通道**，与「全流程回插件内、会话通道只在超 128k 时兜底」的设计相反。实测复现：这些文章的单文件装填本身只有 44k–108k token，远在 128k 大档之内。
- 根因（`index.js:562` 附近的古老分支）：`prepareArticleTasks` 在「总量超 110k」后按文件切批，随后只有 `batches.length > 1` 才走观察批分割，`batches.length === 1`（单文件占满全部体积、分不出多批）直接落到函数末尾的 `forceSession = true`。而 `batches.length === 1` 恰恰是「一个源文件在 110k–128k 之间」的常见情形——不是装不下，只是超过主预算。
- 修法（index.js）：在观察批分支前插入「大档单请求」出口——`!hasOversizeSingle && batches.length === 1` 时，用 `BATCH_TOKEN_HARD_LIMIT` 装填重建整条 prompt，`estimateTokens(bigPrompt) <= BATCH_TOKEN_HARD_LIMIT` 就作为普通 prepared 任务在插件内一次写完（清掉 `splitFor`/`composePlan` 残留、照常分配 customId）；只有整条 prompt 仍超 128k 才继续落到 `forceSession`。这样「超 110k」不再等于「转会话通道」，判定口径统一为「装不进 128k 大档才是装不下」。
- 效果（本仓库 15 篇 Stale 文章实测）：修复前 15 篇全部 `sessionTasks`，修复后 `prepared=21（含 7 个观察批）、sessionTasks=0`——一次 stale 更新零子智能体。
- 测试（test-batch.mjs）：原「单文件超 110k 且分不出多批 → 会话通道」断言按新语义改写为「→ 插件内大档单请求」，并新增「不拆观察批」断言；`huge.ts`（800KB）那条保留，措辞改为「连 128k 大档都装不下 → 会话通道（唯一兜底）」。109 项全过。
- 版本 0.10.2 → 0.10.3。

## 0.10.2 — 2026-10-23

### 修复：大档装填上限 150k 越界（150k 输入 + 64k 输出 > hy3 的 192k 窗口）

- 背景（用户确认的取舍）：192k 是 hy3 的**输入+输出共享**窗口（`cordis.patch.yml` 里 `hy3` 声明 `contextWindow: 192000` / `maxTokens: 64000`），而 0.10.0 把 `BATCH_TOKEN_HARD_LIMIT` 设成 150000，最坏情况 150k 输入 + 64k 输出 = 214k 已超出窗口，上游会直接拒答。用户选择「维持 110k 主预算，只修硬上限」——不扩大单请求容量，只把越界那档收进合法区间。
- 实现（index.js）：`BATCH_TOKEN_HARD_LIMIT` 150000 → **128000**（192000 − 64000，输入侧可用的真实上限），注释写明推导过程与旧值越界的事实。`BATCH_TOKEN_BUDGET` 维持 110000 不动。
- 语义澄清（同批注释）：该常量现在只作**会话通道任务 prompt 的装填上限**（`prepareArticleTasks` 里单文件超观察预算后按大档重装、`compose` 阶段按 `HARD_LIMIT - articleTokens` 装源文件）；`index.js:964` 的兜底通道说明由「单文件 ≤150k」改为「≤128k」。
- 文案（client.js 中英双份）：`sessionTierHint` 的「连 150k 都装不下」→「连 128k 都装不下」。
- 文档：README 的 `sessionTier` 段、`CodeWiki.md` 架构图的超预算说明同步为 128k。
- 测试：test-batch.mjs 三处断言与措辞对齐新档位——「单文件超 28k 预算」（早已过时的旧数字）改为「超 110k 预算」，「200k 大档」改为「128k 大档」；新增一条 `estimateTokens(hugePrep.sessionTasks[0].batchPrompt) > 128000`，锁住「连大档都装不下时仍按原始全长装填、交会话模型处理」这一行为。108 项全过，编排冒烟全过。
- 版本 0.10.1 → 0.10.2。

## 0.10.1 — 2026-10-23

### 变更：删除内置百炼直连通道，插件只走模型设置里的编译模型

- 背景（用户需求）："删除批量通道，全面放弃批量通道，全部改用模型配置中的数据"（经确认，范围为内置百炼直连通道 `bailianChat`）。0.10.0 之后仍保留一条"provider 留空即回落到插件自带百炼兼容通道"的老路，凭证靠 `batchApiKey` 或模型设置「阿里百炼云」渠道注入——这条路径与本插件"不改动密钥、配置全在模型设置里"的定位冲突，且默认模型早已是 `workbuddy/hy3`，实际无消费者。
- 实现 ①（index.js 删除直连）：移除 `bailianChat()`（原 index.js:295-313）与 `BAILIAN_BASE` 常量；`llmChat` 头注释改为「唯一通道」。`runRealtimeTasks` 签名去掉 `apiKey`/`thinkingBudget`，改为 `(tasks, { model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider })`，内部固定 `chat = (args) => llmChat({ ...args, llm, provider, reasoningEffort })`。
- 实现 ②（index.js 删除凭证解析链）：删除 `hostCtxRef`、导出函数 `resolveBatchApiKey`（原 index.js:524-552，含 credentials 注入与 3s Promise.race）、内部 `apiKeyOf(job)`；`apply()` 里 `hostCtxRef = ctx` 一并删除。`startBatchChatRun` 去掉 creds 分支，直接以 `provider: c.batchProvider` + `llm: llmRef` 起跑；note 文案恒为 `${batchProvider}/${batchModel}`。
- 实现 ③（提交前置校验硬化）：`submit()` 改为强制三项——`batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失即抛错并落 job `failed`（错误文案指向设置项，不静默跑空、不降级子代理）。`job.credentialSource` 恒为 `llm(<provider>/<model>)`；`job.apiKey` 字段彻底移除，`saveJobs` 不再做 apiKey 剥离（`{ apiKey, ...rest }` 的 map 删除）。
- 实现 ④（Config/liveConfig）：删除 `batchApiKey`、`batchThinkingBudget` 两字段及其 `[0,32768]` 钳制；`batchProvider` 描述改为「必须是 DSH 模型设置里已注册的 provider id……留空将无法提交任务」。
- 实现 ⑤（client.js 设置页）：删掉 `batchThinkingBudget`/`batchThinkingBudgetHint`/`batchProviderBuiltin`/`invalidBatchThinking` 四组词条（中英）、整段「思考预算」输入、provider 下拉的空值项（不再有"内置百炼通道"可选）；provider 手填 placeholder `aliyun-bailian` → `workbuddy`；切换 provider 时清空 `batchReasoningEffort`；无 provider 时的思考档位提示改走 `batchReasoningEffortNone`。保存键白名单 16 → 14 项。
- 实现 ⑥（文档）：README 把 `batchProvider`/`batchModel` 两条合并为「0.10.1 起为唯一通道」并注明删除直连、`batchProvider` 留空即提交失败，删掉 `batchApiKey`/`batchThinkingBudget` 两条；`cordis.patch.yml` 注释同步。`codewiki_generate` 工具描述末条改为「凭证由模型设置里该 provider（默认 workbuddy）的配置解析，插件不保存也不传递任何密钥」。
- 测试：test-batch.mjs 的「凭证解析链」7 断言整块替换为「不再导出 `resolveBatchApiKey`」的反向断言，并新增 `makeLlm`/`promptOf` 夹具按 `llm.stream` 协议应答，覆盖 provider/model/reasoningEffort 原样下发、temperature=0、未配思考档位时不下发 `reasoningEffort`、取消与失败记账，107 项全过。test-orchestration.mjs 把 `makeBatchMock` 从 fetch mock（打 `dashscope.aliyuncs.com`）整体改为假 `llm` 服务（`activeLlm` 转发、`llmCalls` 记录、支持 stall/bigArticle/bigSources/planReply），所有 `apply(ctx, {})` 改为 `batchCfg()`；「阶段实时阈值」块改名为「唯一通道：宿主 llm 服务」并断言零直连；「无凭证诚实报错」块改为「编译模型/provider 缺失」块并追加 job `failed` 留痕断言；编排冒烟全过。test-cwd-paths / test-wiki-entry 全过。
- 版本 0.10.0 → 0.10.1。

## 0.10.0 — 2026-10-23

### 功能：全面改用免费 hy3 主模型，全流程回到插件内，单项目串行，设置页思考程度从模型目录读取

- 背景（用户需求）：放弃 qwen3.7-flash，改用免费的 `workbuddy/hy3` 作主模型（192k 上下文，足够应付大部分篇目），因此「超预算就委托发起会话的主模型 / 转会话通道」这条主路径不再需要；同时要求 hy3 并发为 2、同一时刻只允许一个项目在编译，以及插件页的思考程度改为直接从模型列表读取。两处架构级歧义经用户确认：①超 192k 的单个源文件仍保留会话通道作**最后兜底**（`sessionTier` 配置保留）；②多项目同时提交时后者**排队等待**而不是被拒。
- 实现 ①（index.js 默认模型与预算重算）：新增 `DEFAULT_BATCH_PROVIDER='workbuddy'` / `DEFAULT_BATCH_MODEL='hy3'` 常量，`Config.batchProvider`/`batchModel` 默认值改为它们（`liveConfig` 的空值回落同步）。`BATCH_TOKEN_BUDGET` 28000 → **110000**（hy3 上下文 192k、单请求输出上限 64k，输入侧留 128k 再扣输出与估算余量）；`BATCH_TOKEN_HARD_LIMIT` 200000 → **150000**（超此才转会话通道兜底）。`estimateTokens` 与各装填点注释同步改写，不再提 32k 低价档。
- 实现 ②（删除主模型规划）：移除 `createJobService` 内的 `runMainModelPlan`（原逻辑：向发起会话的 `agentsRef.get(job.sessionId)` 取 `requestHeader().config` 或 `agent.options` 的路由，再用 `llm.stream()` 跑规划，失败降级批量）。规划阶段不再出现「规划走主模型（…）」note，全部走插件内并发池——hy3 的 192k 装得下文件清单。`tickPlan` 里调用它的分支一并删除，只留批量规划任务。
- 实现 ③（思考程度 → 模型目录）：新增导出纯函数 `resolveModelEfforts(llm, provider, model)`——走宿主 `llm.resolveModel()`，返回 `{ok, provider, model, efforts:[{id,name,description}], defaultEffort, context}`；`listModels` 不携带 reasoning 信息，所以必须单独解析。新增端点 `GET /api/codewiki/model-efforts?provider=&model=`（回环限定、60s 进程内缓存、缺参 400、`ok:false` 不抛 500）。`llmChat` 新增 `reasoningEffort` 入参，仅在非空时写入 `llm.stream({ ...reasoningEffort })`；`runRealtimeTasks` 与 `startBatchChatRun` 透传 `liveConfig().batchReasoningEffort`。Config 新增 `batchReasoningEffort`（默认空 = 模型默认档）。
- 实现 ④（单项目串行）：Config 新增 `serialProjects`（默认 true）。`submit` 时若已有别的项目在推进（`jobs` 里非终态、非 queued、非 submitting 且不是自己），本任务直接进 `queued`，首个阶段与 stale 预置任务先存 `pendingStage`/`pendingTasks`，并 note「已有项目在编译（X），本任务排队等待（单项目串行）」。`tick` 每轮先算 `activeId`（已有在跑的就是它，否则取最早 `queued`），排到自己的 job 才把 `pendingStage` 落地并 note「排队结束，开始编译」；其余项目本轮跳过（不推进、不失败），取消不受闸门限制——排队期间零请求。
- 实现 ⑤（并发默认 2）：`Config.maxConcurrency` 默认值 `CONCURRENCY_HARD_CAP`(8) → `DEFAULT_CONCURRENCY`(2)，`liveConfig` 的回落同样改为 2（硬顶仍是 8）。
- 实现 ⑥（client.js 设置页）：新增「单项目串行」Switch（中英案齐备，保存键列表加入 `serialProjects`）；「编译模型」区新增「思考程度」下拉——选中 provider/model 后拉 `/api/codewiki/model-efforts` 渲染该模型真实档位（含「模型默认（<defaultEffort>）」空值项），加载中/无档位/读取失败三种提示齐备；删掉前端写死的 `qwen3.7-flash` 默认值与 placeholder；用量行「超 32k 档（3 倍价）」改为「超单请求预算（按大档装填）」；面板阶段条把 `queued` 放最前（点亮第 0 个点表示排队）。
- 实现 ⑦（文案对齐）：`codewiki_generate` 工具描述、提交成功 note、校对阶段注释、`cordis.patch.yml` 设置清单、README 设置段与工具表、`CodeWiki.md` 的 Overview/Key Components/Architecture/Data Flow/Connections 全部改写为 hy3 + 插件内 + 串行口径（删掉已不存在的 `defaultProvider`/`defaultModel`/`defaultReasoningEffort` 描述）。
- 测试：test-batch.mjs 新增 `resolveModelEfforts` + `/api/codewiki/model-efforts` 端点 11 项断言（档位解析/默认档/描述/context 透出、未知模型 ok:false、llm 未注入诚实报错、无档位模型空列表、端点注册/200/缺参 400/非回环 403），107 → 118 项全过。test-orchestration.mjs 新增「单项目串行」11 项断言（A 进 plan 占住推进权、B 提交即 queued、note 文案、pendingStage 预置、排队期间零请求、取消 A 后 B 自动轮到并 done、排队结束 note、A 终态 cancelled）全过；test-cwd-paths / test-wiki-entry 全过。test-wiki-anchors 的 287 处失败为编译前 wiki 文章行号漂移（预期，收尾由 codewiki_generate 重编修正）。
- 文档：README 工具表与设置段、CodeWiki.md 同步；版本 0.9.2 → 0.10.0。

## 0.9.2 — 2026-10-23

### 修复：自建 codewiki 档位在写 CodeWiki 时从未被调用（用户反馈：创建了 codewiki 档位，写 wiki 时模型仍走 default 档）

- 排查结论（分两层，均经实测）：①**编译主链不问档位**——规划/写文章/横切/校对全部走 `runRealtimeTasks`，模型由 `batchProvider`/`batchModel` 直接决定，与子智能体档位是两套独立机制，所以 28k 以内的篇目根本不会经过档位；②**唯一经过 `delegate` 的环节是超预算转会话通道**（`dispatchSessionTasks` 的 steer），而它的文本只写「请调用子智能体（delegate/subagent）」，不给 `tier`——会话模型于是走上层决策模型的自动选路。用 `ask_route` 实测「写 CodeWiki 模块文章」两次都判 `default`（置信 0.88 / 0.99，阈值 0.6），自建档位永远轮不到。
- 实现 ①（index.js 新增配置 `sessionTier`）：`.volatile()` 字符串，留空 = 保持旧行为（自动选路）；非空 = steer 文本要求 `delegate` 显式传该 `tier`。`liveConfig` 同步解包。
- 实现 ②（index.js 抽出纯函数 `buildSessionSteerText({job, snapshots, tier, resend})`）：把原本散在 `dispatchSessionTasks` 与 `resendSessionSteer` 里重复的两段 steer 文案合并为一处（含 review 阶段的校对措辞、重发措辞、任务文件与目标路径清单），`tier` 非空时插入「派单要求：调用 delegate 时必须显式传 tier: "<id>"（不要依赖自动选路），mode 用 spec」。两处调用点改为调用它，删掉各自的字符串拼接——顺带消除了两条文案路径再次分叉的风险。
- 实现 ③（`dispatchSessionTasks` 的 note）：转会话通道时写明「档位钉死 <id>」或「档位自动选路」，面板上能直接看出这次用的是哪种。
- 实现 ④（client.js）：设置页「编译模型」区新增「会话通道档位」文本输入（中英文案齐备），保存键列表加入 `sessionTier`。
- 测试（test-batch.mjs）：新增 8 项 `buildSessionSteerText` 断言——未填档位不提 tier、填了要求显式传、含「不要依赖自动选路」、任务文件与目标路径都写进文本、无未替换的模板占位符、review 阶段按校对措辞且同样钉死、重发文案带「重新派发」、重发且未填档位不提 tier。98 → 107 项全过；test-orchestration / test-cwd-paths / test-wiki-entry / test-wiki-anchors 全过。
- 配置：本机 profile 的 `codewiki` 插件配置补 `sessionTier: codeiwiki`，并把路由插件 `default` 档描述里的「文档测试」改为「测试执行与排错」、`codeiwiki` 档描述从 7 字扩为可判定的职责说明（减少自动选路时的语义抢占）。
- 文档：README 设置段补 `sessionTier` 与其存在理由；版本 0.9.2。

## 0.9.1 — 2026-10-22

### 功能：设置页编译模型改为可选配置文件中的提供商与模型（用户需求：使用本地部署的 9b 模型能胜任工作吗）

- 背景：0.9.0 及之前编译模型的调用链写死百炼兼容端点（`BAILIAN_BASE`），设置页只有一个「模型名」文本输入，模型只能从百炼目录里挑。用户问「本地部署的 9B 模型能不能胜任」，结论是「能，但当时插件没有入口把它接进来」。本次把编译模型的来源改成宿主模型设置（llm 服务）里已注册的 provider + model，本地 OpenAI 兼容端点因此可用。
- 实现 ①（index.js 新增导出纯函数 `listModelCatalog(llm)`）：枚举 `llm.listProviders()`（兼容 `id`/`provider`、`displayName`/`name` 两种字段写法，跳过空 id），逐个 `llm.listModels(id)` 映射为 `{id,name}`；单个 provider 探测失败（缺凭证/端点不通）不影响其它条目——该条目保留、models 为空、附 `error`。llm 服务未注入时返回 `{ok:false, providers:[]}`，设置页据此降级为手填。
- 实现 ②（index.js 新端点 `GET /api/codewiki/models`）：回环限定（`guard`），30 秒进程内缓存，返回目录；llm 服务缺失时 200 + `ok:false` 而非 500，让前端有可读原因。
- 实现 ③（index.js 调用链分流）：`batchProvider` 非空时不再拼百炼 URL，改走宿主 llm 服务的 `llm.stream()`（`runRealtimeTasks` 的 `chat` 参数改为二选一：`llmChat` 走宿主、`bailianChat` 走百炼；请求携带 `{provider, model}` 路由，用 `BlockAssembler` 收集 text 块与 usage，finish 为 `error`/`aborted` 时抛错交给并发池按单任务失败记账），凭证与思考程度交给该 provider 自身配置——宿主侧思考程度是 `reasoningEffort` 枚举档位而非 token 数，故该通道不下发 `batchThinkingBudget`；为空时完全保持 0.9.0 的百炼直连行为（含 `batchApiKey` 覆盖与 `batchThinkingBudget` 映射 `enable_thinking`）。两条通道共用同一个「拆包 → 校验 frontmatter → 落盘」出口，下游流水线零改动。
- 实现 ④（client.js 设置页）：`batchModel` 文本框改为两级下拉——provider 下拉（首项「内置百炼通道（默认）」= 空值）+ model 下拉（随所选 provider 的目录刷新，选 provider 时自动带出该 provider 首个模型）。已配置但目录里没有的 provider/model 仍作为选项保留，避免静默丢失配置；目录拉取失败或该 provider 无可枚举模型时回退为文本输入并给出原因。中英文案齐备。
- 测试（test-batch.mjs）：新增 `listModelCatalog` 6 项断言（跳过空 id、displayName 展示名、listModels 映射、`provider`/`name` 字段兼容、单 provider 失败隔离、llm 未注入降级）与 `/api/codewiki/models` 端点 4 项断言（端点注册、回环 200 + 目录内容、非回环 403）；94 → 98 项全过。test-cwd-paths / test-orchestration / test-wiki-entry 全过。
- 文档：README 设置段重写（provider/model 两级语义、两条通道的凭证与思考预算归属）；版本 0.9.1。

## 0.9.0 — 2026-10-21

### 功能：超 32k 文章转「会话通道」（用户需求：超过 32k 的文章通过消息传给会话模型，由会话模型调用子智能体完成）

- 背景：0.8.x 对超批量预算文章有两条昂贵/不可靠路径——单文件超 28k 先升 200k 大档（32k–256k 档按 3 倍价）、连大档都装不下走 `runRealtimeTasks` 同模型同步兜底（长请求阻塞 tick、失败面大）；校对阶段另有「连 200k 大档都装不下就跳过校对」的静默降级。用户要求统一改为：超 32k 的文章通过消息传给发起会话的会话模型，由它调用子智能体完成。触发范围与失败语义经用户确认：升大档、超大兜底、校对跳过三条路径全改走会话通道；发起会话不可用（面板/自动调度提交、会话已关）直接整体失败；会话通道任务超时未产出按失败处理，不降级百炼。
- 实现 ①（index.js `prepareArticleTasks`）：返回值 `{ prepared, oversized }` → `{ prepared, sessionTasks }`。28k 装得下照旧进 prepared；分割判定（prompt 超预算或有文件被 skip）里逐文件检测——单文件连观察批预算都装不下（`hasOversizeSingle`）或分不出多批时不再落回大档提交，而是按 200k 大档装填出 `batchPrompt` 后进 `sessionTasks`；连 200k 都装不下（`tooBig`）同样进 `sessionTasks`。多文件可拆的情形仍走观察→合成批，行为不变。
- 实现 ②（新常量/纯函数）：`SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调，下限 5 分钟）、`SESSION_TASK_DIR`（`os.tmpdir()/dsh-codewiki-session-tasks/`，与 JOBS_FILE 同目录）；导出纯函数 `classifySessionTask(task, nowMs)` 三态——`timeout`（派发超过时限，超时判定优先）、`harvest`（目标文件 mtime ≥ 派发时间且以 frontmatter 开头）、`wait`（未产出/旧文未更新/写一半）。
- 实现 ③（`createJobService` 新增三函数）：`dispatchSessionTasks`——校验 `job.sessionId` 与 `agentsRef.get` 的 steer 可用性（不可用直接 `fail` 明示「请从会话内重新提交编译」），逐任务把 batchPrompt 写任务文件、建文章目录、记快照 `{name, articlePath, promptFile, dispatchedAt}` 存入 `job.sessionTasks`（随 job 持久化），再 `agent.steer(createUserMessage)` 一条短消息（含任务文件路径与目标文章路径、子智能体写作要求）；`progressSessionTasks`——每 tick 对等待中的任务分类：timeout 记 `{ok:false, stopReason:'timeout'}` 并 note，harvest 读文件经 `writeValidated` 闸门（frontmatter 校验 + fixAnchors 校正）落盘入账，wait 留待下轮；`resendSessionSteer`——宿主重启接管（tick 的 owner 接管分支）后重发一次 steer，不重置 dispatchedAt，幂等。
- 实现 ④（`tickArticles` 重构）：batchRef 分支收割后不再直接 setStage，落到统一收尾（等会话通道收割完再推进）；`!job.sessionTasks?.length` 时才组装任务——`prepareArticleTasks` 出的 sessionTasks 先 dispatch（失败已记账则 return），prepared 非空则照旧 `submitBatchFor`；统一收尾：`progressSessionTasks` 未终态 return，终态后 `job.sessionTasks = null`，`writtenCount===0` fail（原文案不变），否则 `setStage(crosscut/review)`。观察批全部失败且无在途会话任务时保持旧行为（直接推进）。
- 实现 ⑤（`tickReview` 校对阶段同样接入）：原先「首个源文件连 200k 大档预算都装不下 → 跳过校对批次」改为转会话通道——`batchProofreadPrompt` 装填后进 `sessionTasks`（`job.stage === 'review'` 时 dispatch 文案为「超预算校对任务」、任务文件即校对指令、收割结果按 `replace` 覆盖同名文章条目，校对失败不推翻已写成功的原文）。校对批与会话任务可并行：batchRef 分支收割后若仍有在途会话任务则继续收割，未终态 return；无在校任务才进 index。`resendSessionSteer` 文案按阶段区分。`runRealtimeTasks` 函数本身保留（`startBatchChatRun` 仍是批量执行器，校对/横切/合成照旧）。
- 删除：`tickArticles` 里的超大兜底段（`runRealtimeTasks` 同步调用 + `rt*` customId + 转超大兜底 note）。`runRealtimeTasks` 函数本身保留（`startBatchChatRun` 仍是批量执行器，校对/横切/合成照旧）。
- 测试（test-batch.mjs）：`prep.oversized` → `prep.sessionTasks`；300KB 单文件断言进 sessionTasks（prompt 内联完整源码）、800KB 断言进 sessionTasks；多文件 4×90KB 断言仍拆观察批；新增 `classifySessionTask` 6 项断言（超时优先于已产出、harvest、无 frontmatter wait、旧文未更新 wait）。64→82 项全过；test-orchestration / test-cwd-paths / test-wiki-entry 全过。
- 文档：README.md 工具表、CodeWiki.md（Overview / Key Components / Architecture / Known Issues）同步；版本 0.9.0。

## 0.8.8 — 2026-10-19

### 修复：行号锚点确定性自动修正（第四层兜底，接 0.8.7）

- 背景：0.8.7 的三层修复（源码行号前缀 + prompt 条款 + stale 禁沿用）证实对弱模型（qwen3.7-flash）不充分——重编译后仍出现新幻觉锚点（client.js NS 实 17 写 20、STAGE_WEIGHTS 实 684 写 468）与未刷新的旧锚点（index.js prepareArticleTasks 441-497 因 +9 偏移过期）。用户选定「确定性自动修正」方案。
- 实现：新增 `fixAnchors(content, cwd)`（index.js，numberLines 旁）——文章落盘前把「file:NN(-MM)」锚点对照 source_files 源码做机械校正，语义与 test-wiki-anchors.mjs 一致：锚点起点行应包含同行反引号符号（或其末段）；不包含时在源文件全文找符号——恰好一处 → 修正；多处 → 取唯一的声明形态行（`^[ \t]*(?:export )?(?:async )?(?:function|class) SYMBOL` 或 `(?:const|let) SYMBOL =`，缩进容忍；`const gamma = beta()` 这类「别的符号的声明」不算）；点分符号（如 `Config.articleLanguage`）歧义时退试首段——首段才是可声明的部分；仍歧义/找不到 → 不动并记 unresolved。区间锚点起点对齐符号行、区间尾越界钳到文件尾（修正起点是净改善）。文件解析：source_files 精确路径 → basename 唯一匹配 → 歧义不碰；source_files 之外的引用一律不动。CRLF 文章行尾保真。readSourceFiles 拆出 `parseSourceFiles(fm)` 共用。
- 集成：两个写盘出口统一过修正——`applyTaskResult`（普通文章直写，源码根取 `task.cwd`）与 `writeValidated`（keepInMemory 落盘闸门——校对/合成/横切结果，取 `job.cwd`）。修正与存疑均记 notes（「自动修正 N 处行号锚点」/「行号锚点存疑（未改）」）。full/stale 文章任务构建与 submitBatchFor 持久化快照补 `cwd` 字段。
- 测试：test-batch.mjs 新增 fixAnchors 13 项断言（唯一修正/已正确不动/未找到/多声明歧义/声明形态命中/区间对齐与钳制/basename 唯一与歧义/清单外不碰/CRLF 保真/无 frontmatter 原样），64→77 全过。
- 真实验证：对本仓库真实文章 documentation-and-config.md 跑 fixAnchors——8 处修正全部命中真实行号（Config 37、prepareArticleTasks 538-594、updateToolDefinition 2113、progressToolDefinition 2184-2280，grep 实证），含 0.8.7 遗留的 3 个 client.js 幻觉锚点（NS 20→17、ACTIVE_STAGES 29→25、STAGE_WEIGHTS 468→684）；4 处复合引用行（反引号为「SYMBOL = value」形态，提不出纯标识符）保守未改。job-mveup23z-a 重编译后对全量文章机械运行 fixAnchors：锚点校验 165 过/46 败 → 186 过/21 败（净修 21 处，cw-binary-source-lost.md 8 处全修）；剩余失败均为预期保守行为——点分符号/复合引用的校验语义局限（锚点实际正确）、真歧义、source_files 清单外锚点。注：编译服务是长驻进程，本次编译时内存仍为旧版代码，fixAnchors 未在服务写盘时生效，产物由会话侧机械运行补正；服务重启后下次编译自动生效。
- 版本 0.8.8。

## 0.8.7 — 2026-10-19

### 修复：wiki 文章行号系统性幻觉（用户报告：build.rs 锚点偏移）

- 现象：Wxxy-CampusLogin 产物把 38 行的 `tauri-app/src-tauri/build.rs` 各锚点写偏（fn main 4→3、conf_path 12→17、总行数 38→39 等），同一错误经 4 次 stale 重写原样固化。诊断三层：① collectSources 内联源码无行号标注，弱模型（qwen3.7-flash）自己数行——首尾可数对、中段必错、尾换行多算；② 校对 prompt「上源码逐个核对」但未指明行号依据，拦不住；③ stale 重写沿用旧文行号，错误延续。
- 修复 ①：新增 `numberLines()`（index.js:343），collectSources 内联的每行源码加 grep 风格「N| 」前缀，模型引用行号有据可依。尾换行只去一个（多去会挤掉真实空行）；CRLF 行尾 `\r` 剥离（校对比对噪音）。token 预算经 estimateTokens 自动计入，装填逻辑不变。
- 修复 ②：校对 prompt 核对项改为「行号以源码『行号| 』前缀为准，禁止自行数行」；articleFormatSection 共享条款同步（405/708 两个调用方都有前缀源码或前缀观察输入）。
- 修复 ③：batchArticlePrompt / batchArticleComposePrompt 的 prevArticle 注入段加「旧文行号可能已过期，一律不得沿用」；观察员 prompt 的行号产出条款同样绑定前缀。
- 测试：test-batch.mjs 新增 numberLines 断言（单/双尾换行、CRLF、空文件）+ collectSources 前缀断言（59→64 项）；用真实 build.rs 逐行比对 38/38 行 0 mismatch、6 个用户锚点全部命中——源码层前缀正确性已证实。
- 重编译验证（job-mvesr9e4-7，修复后的流水线跑本仓库）：观察/合成/校对链看到带前缀源码后仍产生新锚点错误（重写文章新增 client.js 锚点错位：NS 实为 17 写成 20、STAGE_WEIGHTS 实为 684 写成 468），且未修正沿用的旧 index.js 锚点——test-wiki-anchors 121 过/37 败 → 168 过/44 败。结论：prompt 层对 qwen3.7-flash 不充分，行号正确性需机械校验兜底（后续方向）。
- 版本 0.8.7。

## 0.8.6 — 2026-10-18

### 修复：规划阶段没有真正继承当前对话模型（用户需求）

- 现象：用户要求「修改规划调用模型，直接继承当前对话的模型进行」。代码看似早已这么做（0.8.3 的 `runMainModelPlan`），但实际每次全量编译都降级百炼 —— `%TEMP%/dsh-codewiki-jobs.json` 里两条 full 任务的 notes 首条均为 `主模型规划异常 —— cannot get property "llm" without inject`。
- 根因：`runMainModelPlan` 里 `let llm = hostCtxRef?.llm` 在真实 cordis 下**访问即抛**（未 inject 的服务属性不允许读，`typeof` 守卫拦不住），异常被函数外层 catch 吞成一条 note → 规划恒走批量 qwen3.7-flash。原 inject 兜底也走不到（异常先抛）。
- 修复 ①：新增模块级 `llmRef`，`apply()` 里 `ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })`，与 `agentsRef` 同款；`runMainModelPlan` 只读 `llmRef`，删掉 `hostCtxRef?.llm` 属性访问与那段走不通的 inject 兜底。服务未注入时明确 note「主模型规划不可用（llm 服务未注入）」再降级。
- 修复 ②（更贴近「当前对话模型」）：路由解析改为「会话已路由 `session.requestHeader()?.config` → 未路由退回 `agent.options.{provider,model}`」，与 compaction 的 `latest ?? agentTarget` 同序，不再因会话尚未路由而静默降级。
- 测试：test-orchestration.mjs 新增场景 1b —— mock ctx 上把 `llm` 定义成抛错 getter（复刻真宿主故障），断言规划仍走主模型、路由取自 `agent.options`、notes 无「主模型规划异常」、计划正常入库。
- 回归：node --check ✓；test-orchestration / test-batch / test-wiki-entry / test-cwd-paths 全 EXIT=0。
- 版本 0.8.6。

## 0.8.5 — 2026-10-18

### 适配 DSH 0.2.1-rc.2：wake/plan source 形态 + engines.dsh 声明

- 背景：宿主升级 0.2.0-rc.2 → 0.2.1-rc.2（hostProtocolVersion 4，asar 内 dsh commit 59e68c58）。
- source 形态（1e6fbe5，随本版一并测试收口）：index.js 两处 createUserMessage 的 source 从 `{kind:'plugin',plugin:'codewiki'}` 改为 `{kind:'plugin:codewiki'}`（wakeCompileSession 的 agent.steer 与 runMainModelPlan 的 llm.stream messages）。asar 核实：user/message 校验仅要求 source.kind 非空字符串（dsh agent-loop.js:1205），PLUGIN_RECORD_TYPE 正则只管插件记录事件类型名，不约束 source.kind；`plugin:codewiki` 两边皆合法。
- 补 `"engines": {"dsh": ">=0.2.0-rc.0"}`（package.json）：0.2.1-rc.1 起第三方插件兼容性优先按 engines.dsh 判定（dsh-app-boot plugin-compatibility.js：engines.dsh 为 semver 范围、includePrerelease:true、声明后单独决定兼容性并忽略 dsh-* peerDependencies；未声明沿用旧规则）。实测 `0.2.1-rc.2` 与 `0.2.0-rc.2` 均满足该范围。
- 测试：test-orchestration.mjs:343、:494 断言改新形态 `source?.kind === 'plugin:codewiki'`；test-batch/orchestration/wiki-entry/cwd-paths 全 EXIT=0；test-wiki-anchors 36 败为 .codewiki 行号锚过期，由本次 codewiki_generate 重编译刷新。
- 宿主面实测存活（本会话即 0.2.1-rc.2 宿主）：cw/codewiki_generate/codewiki_update/codewiki_progress 4 工具注册生效；/api/codewiki/jobs、/repos 200（webServer exact + loopback guard + workspaceRegistry 生效）；【CodeWiki 维护】systemPrompt.section 注入正常。浏览器半侧面板待用户目验。
- 版本 0.8.5。

## 0.8.4 — 2026-10-15

### 文章阶段超预算分割：观察批 map + 合成请求 reduce（避开 32k 三倍价，用户需求）

- 背景：文章阶段一个模块的源码总量超 28k token 预算时，原先整体升 200k 大档继续装填（实测单阶段 9 个请求超 32k 档、按 3 倍价计费，441.9k 输入）；且 collectSources 把装不下的文件静默 skip（「不得涉及它们」），超预算内容直接丢失。用户要求：超预算必须拆分成多个 ≤28k 请求，而不是升大档。
- 新增 `batchArticleObservePrompt(language,moduleName,sourcesText,batchIndex,batchTotal)`（index.js）：分批观察 prompt，要求保留全部函数/类/导出名、常量默认值、行号、调用关系、文件清单；禁 frontmatter。
- 新增 `batchArticleComposePrompt({language,mission,moduleName,observationsText,prevArticle})`：观察包 → 完整文章，沿用观察中的「文件:行号」，汇总 source_files，articleFormatSection() 收尾。
- `prepareArticleTasks`（index.js:441-497）分割判定：collectSources 28k 装填后 prompt 估算 >BATCH_TOKEN_BUDGET **或存在装不下的溢出文件**（overflowFiles，堵静默 skip）→ 逐单文件重新分批，batches.length>1 → 每批一个观察任务 `{customId:'split{n}o{i}', name:'<article>#obs{i}', keepInMemory:true, splitFor, composePlan:{mission,articlePath,prevArticlePath,batchCount,files}}`；单文件占满分不出多批时落回 BATCH_TOKEN_HARD_LIMIT 大档（原行为）。
- `tickArticles` 收割侧两段状态机：results 含 `#obs` → 按 articleName 分组（composedArticles Set 去重，每篇一条合成任务）→ 从持久化任务快照重建合成任务（customId `o\d+$`→`c`）→ submitBatchFor 合成轮 → 下一轮收割写盘；观察全失败该篇缺席并 note；部分失败合成基于剩余观察。
- `submitBatchFor` 持久化 job.tasks 补带 `splitFor/composePlan`（宿主重启后收割重建合成所需的元数据，原快照会丢）。
- 测试：test-batch.mjs §3 改分割语义断言 + 新 3b 节（4×90KB fixture：obs 任务 ≥2、batchPrompt token ≤28000、splitFor/composePlan 绑定）；test-orchestration.mjs 新 e2e 块（bigSources 仓库：4 观察批 → 2 合成 → modules/*.md 落盘 → PROOFED 校对回写 → 零 3 倍价 notes）；makeBatchMock 加 bigSources 参数与「文章观察员」应答分支。
- 回归：test-batch/orchestration/wiki-entry/cwd-paths 全 EXIT=0；test-wiki-anchors 失败均为 .codewiki 锚过期，由重编译刷新。
- 版本 0.8.4。

## 0.8.3 — 2026-10-15

### 规划阶段改走主模型（避开百炼 32k 三倍价，用户需求）

- 背景：规划阶段把全仓文件清单塞进一个百炼请求，仓库一大就超 32k 低价档（实测 41.8k 单请求按 3 倍价计费），且规划串行拖慢整体编译。用户要求改由发起会话的主模型执行规划。
- 新增 `runMainModelPlan(job, prompt)`（index.js）：取发起会话 agent（`agentsRef.get(job.sessionId)`）→ `agent.session.requestHeader()?.config` 拿主模型 {provider, model} → `ctx.llm.stream()`（hostCtxRef 属性 + inject(['llm']) 双取法，兼容 mock ctx 与真实 cordis）+ `BlockAssembler` 收文本，`createUserMessage` 带 `source:{kind:'plugin',plugin:'codewiki'}`；temperature 0；AbortController 入 batchAborters（取消编译可中断规划）；usage 按实测 outputTokens + estimateTokens(input) 记账（requests:1, realtime:true）。
- tickPlan 改造：先主模型规划 → parsePlan 成功入库并 note「规划（主模型）」；主模型不可用（无 sessionId/路由/llm）或未产出可用 JSON → 降级百炼批量规划（原 submitBatchFor 路径与 batchRef 收割逻辑零改动）。
- 测试（test-orchestration.mjs 新块 3 场景）：①agent 带路由 → ctx.llm 恰 1 次、百炼零规划请求、计划入库（fixture-mm）、overTier2 不计；②主模型回非 JSON → 降级百炼、done；③无 sessionId → 不碰 llm、批量照旧。makeCtx 增 llm 注入选项。踩坑：fake 流 block-end 必须携带与 delta 一致的完整 block（BlockAssembler closed-block-wins 语义），空 block 导致文本为空误走回退。
- 回归：test-orchestration/batch/wiki-entry/cwd-paths 全 EXIT=0；test-wiki-anchors 失败均为 .codewiki 文章行号锚过期（新增代码使行号后移），由本次 codewiki_generate 重编译刷新。
- 版本 0.8.3。

## 0.8.2 — 2026-10-15

### 修复：4 个 cw 工具在新宿主全部消失（根因：progress schema type 数组）

- 现象：宿主更新后 cw/codewiki_generate/codewiki_update/codewiki_progress 4 个工具全部消失，但面板端点（GET /api/codewiki/jobs）正常——工具注册回调整体未生效。
- 根因（最小复现坐实）：0.7.0 修复 progress 输出 schema 的 nullable 字段时用了 `type: ['object','null']` 数组形态（4 处：batchProgress/tps/error/finishedAt）；新宿主 ToolRuntime.register 强制 JSON Schema 子集（assertSupportedJsonSchema，type 必须单字符串——"type arrays are not supported"）。注册循环第 4 个定义（progress）抛错 → apply 回调失败 → cordis 把该 fiber 判 FAILED 并**回滚其全部 effect**（含已成功注册的前 3 个工具）→ 4 个全没，宿主吞错（exit=0 静默无日志）。纯 cordis 复现脚本验证：抛错后 registered=(none)，与真实宿主观察完全一致。
- 修复 ①：4 处 type 数组改子集合法的 nullable 表达 `{ oneOf: [{type:'object'},{type:'null'}] }` 等价形态（oneOf 恰两支、不与 type 并存，均在新子集白名单内）。
- 修复 ②（防御）：工具注册循环加 per-definition try/catch——未来任一工具 schema 违规只丢该工具并 console.error，不再炸回调回滚全部。
- 回归验证：node --check ✓；静态断言 index.js 无 `type: [` 残留 ✓；端到端模拟宿主校验 4 工具全部注册 ✓；单工具失败隔离（progress 模拟抛错，其余 3 个存活）✓；test-batch.mjs 51/0 ✓；test-orchestration.mjs 全 PASS ✓。
- 版本 0.8.2。

## 0.8.1 — 2026-10-14

### 工具拒绝编译时报错同时返回命中的排除项（用户需求）

- 背景：用户要求「调用工具时，同时要返回排除项告诉模型此工作区被排除了」。原报错只说「该目录在 CodeWiki 排除清单中」，排除清单有多条时模型无法定位是哪条规则拒绝的。
- `codewiki_generate` / `codewiki_update`（及编排服务 submit 路径）对被排除目录的报错改为同时带命中的排除项原文：`该目录在 CodeWiki 排除清单中，不编译：…（命中排除项：<清单条目>；在插件设置或面板「设置」页编辑排除清单）`。
- 实现新增 `excludedItem(cwd, list)`（返回命中的清单条目原文），`isExcluded` 改为 `excludedItem(...) !== null` 的布尔包装（面板 repos 总览 excluded 字段布尔语义不变，全部调用点行为不变）。
- 版本 0.8.1；test-orchestration.mjs 排除清单断言补「报错含命中排除项」（compile 400 / 直调 / 子目录三处，子目录场景校验排除项为父目录条目）。

## 0.8.0 — 2026-10-14

### 编译终态实时唤醒发起会话（用户需求：借用子智能体发送消息机制）

- 背景：0.7.0 的提交提醒靠系统提示 section 拉取（会话因别的原因醒来才看得到）。调研确认 DSH 唯一的续步队列就是 Agent inbox（subagent/continuation.ts:7-11），子代理 send_message 对父会话最终也是 `agent.steer()`；插件经 `ctx.inject(['agents'])` 拿同一注册表即可纯插件侧实时唤醒，harness 零改动。先例：dsh-turn-verify-guard 插件同机制在线运行。
- 新增 `wakeCompileSession(job, outcome, agents?)`（index.js，export 供测试）：编译终态对发起会话 `steer(createUserMessage({...source:{kind:'plugin',plugin:'codewiki'}}))`——done（writtenCount>0）发「【CodeWiki 编译完成·请提交改动】」、failed 发「【CodeWiki 编译失败】」；sessionId 缺失（面板/自动调度提交）、会话不在注册表（冷会话）、steer 异常一律静默跳过（系统提示 section 拉取兜底仍在）。
- 会话来源：generate execute 记 `exec.agent?.id`（工具执行上下文自带发起 agent，tools/src/index.ts:338）→ submit 存 `job.sessionId`；同仓库重复调用（幂等路径）最新会话拿唤醒权。createJobService 增 onSettled 回调参数（apply 传 wakeCompileSession）：tickIndex done 且 writtenCount>0、fail 且非提交期（提交期失败随工具调用同步返回，不重复唤醒）时触发。
- 依赖：node_modules 目录联接引 `@deepseek-ai/dsh-llm`（及 dsh-typert-protocol/util-crypto/util-values/brand/timeout/cordis/cosmokit 等宿主包，junction 模式同 dsh-turn-verify-guard；node_modules/ 不入 git）。
- 修复 0.6.0 回归：submitComposeBatch 仍按 Promise 链式调 `submitBatchFor(...).then(...)`，而 submitBatchFor 自 0.6.0 起是同步函数（返回 undefined）——横切精准拆分分支（模块文章总量超预算）提交合成批时抛 `Cannot read properties of undefined (reading 'then')` 致任务 failed。改 try/catch 同步调用。
- 测试基建突破：会话沙箱拦 node 子进程 Temp 写入（mkdtemp EPERM）——TEMP/TMP 重定向到仓库内 .tmp-test 后 test-orchestration.mjs 首次完整跑通（编排冒烟全 PASS，test-batch 51/0）；测试残留目录已清理。顺带修正 0.7.0 测试缺陷：wrapper 断言改临时替换 gen.execute（原 fakeGen 未注入）、commitHintText 60s 缓存跨断言污染改独立 fixture 仓库、同秒提交/编译竞态 sleep 隔开；新增 wakeCompileSession 单测（done/failed 文案、source 标记、无 sessionId/冷会话/registry 抛/steer 抛/缺省 agentsRef 全静默）与端到端断言（sess-e2e 提交 → 终态 steer 捕获）。
- 版本 0.8.0；README 工具表与 updateReminder 说明同步；test-orchestration.mjs 增补 wakeCompileSession 断言（done/failed 文案、无 sessionId 不唤醒、冷会话不唤醒）。

## 0.7.0 — 2026-10-14

### 新增 codewiki_update 日常维护工具 + 编译完成提交提醒（用户需求）

- 背景：用户要求「新增工具，让模型可以提交更新请求，告诉模型已经开始更新，继续下一项，同时更新完成后向主模型返回消息，让模型去提交改动」。
- 新工具 `codewiki_update`（index.js，updateToolDefinition）：固定 scope=auto 的提交制更新请求，execute 复用 generateToolDefinition 的 execute（{...args, scope:'auto'} 透传，幂等/短路/逐篇/全量路径全继承），仅追加引导 note「更新已在后台进行：继续下一项工作，不要等待……完成后系统提示会出现提交提醒」；错误消息里的 codewiki_generate 字样改写为 codewiki_update。参数仅 cwd/language（scope=full/stale 仍走 codewiki_generate）。apply() 注册为第四个工具。
- 编译完成提交提醒（commitHintText，export 供测试）：update-reminder 系统 prompt section 兼职——最近一次成功编译（stage=done 且 writtenCount>0）的 finishedAt 晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交（`git log -1 --format=%ct -- .codewiki CodeWiki.md`）→ 注入「【CodeWiki 编译完成·请提交改动】」提醒（只 add 这两个路径、docs(wiki) 前缀、禁 git add -A；模型自己提交，插件不代跑 git）。零持久状态：时间戳派生自 jobs 文件与 git log，提交后时间戳反超自动静默；非 git 仓库/无 .codewiki 提交史（log 空）/读 jobs 失败一律不提醒；60s TTL 缓存（text 回调每次组装求值）。受 updateReminder 开关与「仓库根存在 CodeWiki.md」门控约束。
- 版本 0.7.0；README 工具表补 codewiki_update 行、updateReminder 说明同步；test-orchestration.mjs 增补 wrapper 与 commitHintText 断言。
- 验证：node --check index.js 过。test-orchestration.mjs 因会话沙箱拦截 node 子进程文件写入（mkdtemp EPERM，同 0.6.0 记录）未能在会话内运行，需用户在正常 shell 验证。

## 0.6.0 — 2026-10-13

### 删除百炼批量推理通道：编译全部改走普通入口（用户决策）

- 背景：用户配置早已用 batchMinTokens 99999999 把全部阶段钉死实时（0.5.0.5 曾撤下又被架空的批量通道形同虚设），且批量 5 折需排队（分钟~小时级）。决策：删除 batch.dashscope.aliyuncs.com 专用链路，全部模型环节统一走百炼普通入口 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`；代价是放弃 5 折（用户已接受，实际早已全价实时）。
- index.js：删 BATCH_CHAT_BASE/BATCH_CHAT_TIMEOUT_MS、bailianChat 的 batch 参数与 1h 超时/重试包装、linkedSignal（唯一调用方是批量超时）、submitOrRun 阈值分流整函数与 localResults 就地实时路径（无进度无取消且阻塞 tick，弃用）；6 个提交点统一 `submitBatchFor`；startBatchChatRun/submitBatchFor/settleJob 文案与记账改「阶段执行器」措辞（addUsage `batch:true`→`realtime:true`，batchId 前缀 `batchchat-`→`stage-`）；Config schema 删 batchMinTokens（liveConfig 同步），batchModel/batchThinkingBudget/maxConcurrency 描述改普通入口措辞；工具描述/notes/错误消息去批量措辞。
- 保留骨架（有意不删）：后台执行器 startBatchChatRun/settleJob 与 batchRuns/batchResults/batchAborters 三 Map、job 持久字段 batchRef/batchProgress/batchSubmittedAt/batchPrompt、宿主重启按 prompt 快照重跑、取消中断在飞请求、面板进度展示——0.5.0 起「批量对话」实际只是这套后台并发池执行器的旧名，全部行为不变，仅端点从批量换普通。
- client.js：设置页删「批量编译（百炼）」节（secBatch 标题/batchApiKey 输入/batchMinTokens 输入与校验）；batchModel/batchThinkingBudget 保留为「编译模型（百炼）」节（secCompile，新增 zh/en 词条）；batchRunLabel '批量执行中'→'执行中'；keys 数组删 batchMinTokens（batchApiKey 保留以同步存量值，UI 不再渲染）。面板 batchLabel「批次」/双通道用量拼接保留（batchRequests 恒 0 自然退化，骨架不动）。
- 测试：test-batch.mjs 第 4 节重写为普通端点断言（URL、请求体、思考参数、tps、signal 中止），删超时/重试节；test-orchestration.mjs 删 BATCH_URL 双通道 mock 与 batchMinTokens 混合节，改「全程走百炼普通端点（零专用批量端点）」断言，重启重跑场景 A 前缀改 stage-（场景 B 保留 local 旧格式验证兼容）。
- 验证：node --check index.js/client.js/test-batch.mjs/test-orchestration.mjs 全过；test-batch.mjs 51/0 PASS。test-orchestration.mjs 因会话沙箱拦截 node 子进程文件写入（mkdtemp EPERM，PowerShell/bash 下同样）未能在会话内跑通，需用户在正常 shell 验证。
- 迁移说明：用户 live 配置残留的 batchMinTokens 值在 schema 删除后无害（未知键忽略）；设置页不再渲染 batchApiKey 输入，存量值仍生效（凭证优先级不变：显式 batchApiKey > 模型设置「阿里百炼云」渠道）。

## 0.5.0.6 — 2026-10-12

### 新增 codewiki_progress 只读查进度工具（后台编译语义对模型显式化）

- 背景：codewiki_generate 虽是提交制（调用即返回、宿主服务后台推进），但工具描述与 reminder 都把「进度」指向侧边栏面板/HTTP 端点——模型在会话内无从得知编译到哪了，容易提交后空等或反复重提交。用户要求「增加工具让模型查询进度、无需考虑编译是否完成」。
- 改动：新增第三个工具 `codewiki_progress`（index.js:1815-1911，samePath/progressView/progressToolDefinition）：只读、立即返回；可选 `cwd` 或 `jobId` 过滤（samePath 做路径归一化，都不传列全部）；数据 = jobSummary 同源 + progressView 计算 taskList 完成百分比；render 输出 stage=xx NN% + ✓/✗/· 任务明细 + 错误 + 最近 3 条 notes。apply() 注册三工具。
- 后台语义写进两处模型可见面：generateToolDefinition description 的「进度」行改为「提交后继续手头工作，不要等待或反复轮询；需要进度时用 codewiki_progress」；reminderText 新增一行「codewiki_generate 是后台编译……不要等待编译完成，提交后继续其他工作，需要进度时用 codewiki_progress 查询」。README 工具表补 codewiki_progress 行、updateReminder 说明同步。
- 测试：test-orchestration.mjs 新增 11 项断言（注册、cwd 归一化过滤、终态 progress=100、taskList 全 done、usage 块、jobId 单条/无匹配空、其他仓库空、render 含 stage/✓、进行中 job stage=plan progress=0、完成后 100）全过。
- 验证：node --check index.js/test-orchestration.mjs/client.js 全过；test-orchestration.mjs PASS（143/0）。test-wiki-anchors.mjs 130 过/32 败——失败均为既有行号漂移（index.js 2121→2225 行），属 0.5.0.5 已记录的同款系统性幻觉锚点问题，待收尾重编译后由守卫下一轮勘定。
- 附带确认（用户第三问）：.codewiki/ 推送 GitHub 无需适配 git 命令——cw 的 git 交互全在 Rust 层（meta.rs:43 current_commit、main.rs:146 cmd_status 的 git diff、main.rs:217-223 cmd_meta_update），插件层只调 cw CLI；仓库推送由宿主会话 git 工作流负责（.codewiki/ 与代码同提交），插件无托管仓库、无 push 逻辑。

## 0.5.0.5 — 2026-10-11

### 百炼批量通道从 Batch File 切换为 Batch Chat（省钱需求落地）

- 背景：0.5.0.4 时代批量走百炼异步 Batch File（JSONL 上传 → `/batches` 排队 → 轮询结算），但 batchMinTokens 99999999 把所有阶段钉死实时全价架空批量；用户明确「省钱」指让插件 qwen3.7-flash 批量编译省费用，而非会话模型。百炼 Batch Chat（同步端点 batch.dashscope.aliyuncs.com，实时价 5 折，服务端最长保持 1h、超时未调度不计费）免除上传/排队/轮询全链。
- 改动：合并 feat/batch-chat（f662483）进 main 并接线——删 buildBatchJsonl/parseBatchResults/bailianRequest/BATCH_TERMINAL/settleBatch/batchStateFile/submitBatch/resume 孤儿续查整条 JSONL 链（index.js 净删 ~175 行）；BATCH_CHAT_BASE/BATCH_CHAT_TIMEOUT_MS(1h) 常量；bailianChat(+batch,signal) batch=true 换端点、超时重试 1 次；runRealtimeTasks 共享并发池兼做两通道执行器；settleJob 重写（localResults/batchResults 收割 + 宿主重启按 job.tasks 的 batchPrompt 快照重跑当前阶段，幂等覆盖）；startBatchChatRun 的 onTaskDone 补 addUsage(outputTok)（批量输出 token 实测入账，对齐实时路径先例）；submitBatchFor 补 job.batchSubmittedAt（面板计时起点）与 32k 档 3 倍价明示 note。
- 同步配置：~/.dsh/profiles/desktop/cordis.patch.yml codewiki 块 batchMinTokens 99999999 → 30000（文章/审校阶段估算 ~210k tok 均走批量 5 折；99999999 是 0.4.11.2 有意的「强制全实时」用法，已按需撤下）。
- 验证：test-batch 55/0（分支版重写，测 Batch Chat 执行器/mock fetch）、test-orchestration PASS、test-cwd-paths PASS、test-wiki-entry 全过、node --check 过；锚点守卫轮 4：迁移致行号漂移+已删符号 → 17 处手改修正（concepts 实现地图 9 + 两篇 learning 8，基线 2121 行 index.js），守卫扩至 185 断言全过。

## 0.5.0.4 — 2026-10-11

### 收尾提醒封死「手工流程」逃生通道（模型手改 wiki 不被记录的根因修复）

- 根因：插件注入的系统提示 reminder（index.js reminderText）写着「运行 codewiki_generate，**或手工流程** cw status → 更新命中文章 → cw index → cw meta update」，并要求「修 bug 补 learnings/」——模型读到合法逃生通道就走手改路径；插件无任何 watcher 感知手改，面板无任务、派生索引不刷新，正是「模型不调用工具编译、不被插件记录」的来源。
- 修复：reminderText 改为「收尾必须调用 codewiki_generate（scope=auto），learnings/decisions 补文章与索引刷新由流水线完成，不要手工编写/修改 .codewiki/ 下的文章（手改不进流水线、不被面板记录、会被下次编译覆盖）」，验收句改为「收尾未调用 codewiki_generate 视为任务未完成」；README updateReminder 说明与 ~/.dsh/skills/codewiki/SKILL.md（description、stale 分支、收尾清单）同步收口，并顺手把 SKILL.md 第 12 行过时的重装源码路径更新为 vendor/codewiki fork。
- 依据：流水线写文章阶段本就产出 learnings/decisions（vendor/codewiki/src/setup.rs:45-46 上游 prompt），手工补文非必需。
- 验证：test-orchestration（系统提示提醒断言组）+ test-wiki-entry + test-batch（75/0）+ test-cwd-paths + test-wiki-anchors（163/0）全部通过。
- 锚点第三轮复发（同日）：修复后收尾狗粮调用 codewiki_generate 重编译 5 篇文章，批量通道再注入 17 个幻觉锚点——0.5.0.3 守卫当场全数拦截（146 过/17 败）。逐个 grep/awk 勘定真实行号修正（concepts 实现地图 12 处 + 两篇 learning 5 处，index.js/client.js 行号基线 7a61424），守卫扩至 180 断言全过。幻觉为系统性（第二轮 10 个、第三轮 17 个），守卫测试是最后防线；流水线锚点可靠性问题留待上游（vendor/codewiki 校对阶段拦不住行号幻觉）。

## 0.5.0.3 — 2026-10-10

### wiki 行号锚点自动校验（审核教训制度化）

- 新增 test-wiki-anchors.mjs：扫描 .codewiki/**/*.md 的全部 `index.js:` / `client.js:` 锚点，做三重断言——基础（行号在源文件范围内且指向非空行）、符号绑定（同行反引号标识符必须出现在锚点行源码中，如 `createJobService` (`index.js:1042`)）、区间（起止有序且在范围内）。当前 160 断言全过；注入幻觉锚点的负向测试被正确拦截（含真实幻觉形式 `createJobService` 606）。
- 背景：流水线产物曾系统性幻觉行号（偏移 34~760 行，校对阶段拦不住，见 .codewiki/learnings/cw-binary-source-lost.md 审核补记）；本测试把「锚点必须对照真实源码核对」固化为可回归的守卫。
- FORK.md 补「构建噪音」节：cargo 的 dead_code 警告（WikiMeta.tags 未读，上游固有）记录为已知可忽略——不为消警告重编译验证过的二进制。

## 0.5.0.2 — 2026-10-10

### cw 真源码本地重建（vendor/codewiki 成为可维护 fork）+ 反斜杠 Rust 层根治

- 取证收敛：上游 main（64323823）与 vendor 快照逐字节一致；现役二进制的「仓库内 .codewiki」架构魔改面收敛到 config.rs 单点 `wiki_path()`（`repo_path.join(".codewiki")`）——init/status/meta/index/path 全部随之仓库内化，`cw projects` 保留中心枚举（与现役行为一致）。
- vendor/codewiki 重构为本地 fork：config.rs 重施魔改 + main.rs 新增 `rel_path_string()`（`/` 分隔渲染文章相对路径）替换两处 `Path::display()`——Windows 反斜杠污染 stale 清单与 `_index.md` 链接的问题在 Rust 层根治（0.5.0.1 的插件层收口保留为纵深防御）。fork 基线、构建安装、警告与行为规格文档化在 vendor/codewiki/FORK.md。
- 对比验证：探测仓库上 init/path/status（未编译态）/meta update/index/projects 与旧二进制逐字节一致；`_index.md` 与 stale 清单唯一差异 `\`→`/`（预期）；插件测试 23 断言 + 编排 117 项全过；本仓库 `cw index` 原生输出与插件规范化后的 `_index.md` 逐字节一致。
- 安装：新二进制（md5 952b0282523ad016c13688cc594afdd8）同步 bin/cw.exe 与 ~/.cargo/bin/cw.exe；丢失源码的最后产物备份为 bin/cw.exe.bak-20261010（md5 835702…，已 gitignore）。

## 0.5.0.1 — 2026-10-10

### 编译收尾自动补建 CodeWiki.md 入口（守护门控不变量闭合）

- 修复 139052c 遗留的不变量缺口：更新提醒门控收紧到 `<repo>/CodeWiki.md` 入口文件，但流水线全链路（插件 + cw CLI）从未创建它——「编译过但无入口」的仓库（如 Wxxy-CampusLogin / CampusHub，均有真实 .codewiki/ 而无入口）永远收不到收尾编译提醒，模型收尾时没有任何指向 codewiki_generate 的强信号，导致模型不调用工具编译。
- index 阶段（writtenCount>0）在 cw index / meta update 之后自动检查：仓库根缺 CodeWiki.md 则生成中/英双语入口（含 .codewiki 绝对路径、_index/_architecture/modules/concepts 指引、codewiki_generate 收尾要求与「人工改写不覆盖」声明）；已有入口绝不覆盖；生成失败只记 note 不影响任务。老仓库重编译一次即自愈。
- codewiki-nudge hook（~/.dsh/hooks/codewiki-nudge.js，仓库外全局钩子）文案补上工具名：从只列手工流程改为「收尾运行 codewiki_generate（scope=auto）更新受影响文章并随代码提交（手工流程则 cw index + cw meta update）」。
- vendor/codewiki/skills/codewiki-session.md:30 承诺的 "entry file at `<repo>/CodeWiki.md`" 至此才真正兑现。
- 测试：新增 test-wiki-entry.mjs（13 断言：生成内容/.codewiki 绝对路径/双语/已有入口不覆盖/幂等/空 cwd）；test-orchestration.mjs 117 项全过，真实编译任务 notes 出现「仓库根缺 CodeWiki.md 入口，已自动生成」实证集成生效。
- Windows 路径规范化收口：cw（Rust `Path::display()`）在 Windows 输出 `\` 分隔的文章相对路径，污染 stale 清单与 _index.md 的 `[[...]]` 链接。根治本应修 Rust 上游，但现役 cw 二进制源码（Temp/cw-src，cargo path 安装）已被清理，vendor/codewiki 是旧架构过期快照（wiki 在 `~/.codewiki/<project>`，其编译产物报 "No wiki found"，**勿从它构建安装**）。故在插件层收口：`normalizeArticlePath`/`parseStatus`（stale 与 changed 路径进插件即规范化）+ `normalizeIndexLinks`（tickIndex 在 cw index 成功后修正 _index.md 链接头，幂等、不碰正文）。test-wiki-entry.mjs 扩至 23 断言。

## 0.5.0 — 2026-10-07

### 面板信息密度改版（阶段步骤条 + 双通道吞吐 + 用量统计）

- 六阶段步骤条：任务卡以 规划→文章→横切→合成→校对→索引 六节点呈现流水线位置——已完成绿点（悬停显示各阶段耗时）、当前阶段实心点带实时计时、失败/取消在最后计时段标红/黄。服务端 `setStage` 统一收口全部阶段切换点并累计 `job.stageTimings`，`jobSummary` 新增 `stageStartedAt/stageTimings`。
- 双通道吞吐徽标：实时通道显示 tok/s + 30 点微趋势 spark（面板侧 2s 轮询滚动采样）；批量通道显示完成速率（篇/分，EWMA 平滑）与预计剩余时间（batchProgress 差分），批次尚无完成样本时显示「批量执行中 + 已排队时长」——修复实时 tps 在批量期间恒为空的断供：批量阶段改用吞吐口径，从提交即有反馈（`jobSummary` 新增 `batchSubmittedAt`）。
- 用量行：输入（提交时估算）/ 输出（响应实测）token 与请求数（批量/实时分通道计数），超 32k 档请求数红字提示 3 倍价。`parseBatchResults` 提取结果行 `usage.output_tokens`（兼容 `completion_tokens`），收尾按批次 id 防双计入账（`jobSummary` 新增 `usage`）。
- 总进度条改为六阶段加权推进（articles 0.6、review 0.15 等，阶段内按 taskList 完成数折算），不再随批次/阶段切换跨阶段回跳；封顶 99%，done 才 100%。
- 活动流：notes 多于 1 条时折叠展开全部（此前只显示最后 1 条且截 3 行）；`job.error` 首次渲染——此前服务端一直返回但面板从未显示，失败只剩一个词无从排查。
- 总览卡：仓库行显示 wiki 篇数（递归统计 `.codewiki/` 下 .md，`articleCount`）与上次编译相对时间；调度卡显示下次扫描时刻（≈ 倒计时）与上次扫描统计（扫 N 库 · 提交 M，`lastScanRepos/lastScanSubmitted`）。
- 历史卡显示总耗时；wiki 路径行加「复制路径」按钮；面板标题栏显示进行中任务计数（宿主 panellist 图标不支持角标，落位在面板头）。
- 测试：test-batch 补 `outputTokens` 提取断言（75 项）；test-orchestration 补 stageTimings/usage/batchSubmittedAt/articleCount/调度统计断言，并补齐 139052c 守护收紧后缺失的提醒用例（`.codewiki` 存在但根无 CodeWiki.md → 不注入）——该缺口是上一提交遗留的既有失败，本版修正。

## 0.4.11.2 — 2026-10-07

### 阶段实时阈值上限放宽（大仓库强制实时）

- 面板校验上限 1,000,000 → 99,999,999：大仓库（单一大源文件被多篇文章的 sources 重复引用）单阶段总输入可超百万 token，旧上限挡住了「设 999999 强制全实时」的用法——dsh-hindsight-on-demand 16 任务总估算超上限被拦回批量通道。
- zh/en 阈值提示补充：大仓库想强制全部实时，可设 99999999。

## 0.4.11.1 — 2026-10-07

### 孤儿任务接管（宿主重启僵尸任务修复）

- 修复宿主重启后旧任务永久搁置：tick 对 `owner !== instanceId` 的任务一律跳过（多实例隔离设计），但宿主重启后 instanceId 重新生成，重启前提交的任务从此无人推进——批次不轮询、进度不动、取消也失效，面板却仍显示「写文章中」。改为停更心跳接管：owner 不匹配但 `updatedAt` 停更超过 5 分钟（`DSH_CODEWIKI_ORPHAN_TAKEOVER_MS` 可调）视为孤儿，本实例接管推进并写 note 留痕；对方实例活着时每轮 tick 都会 touch（批次轮询前进），不会误抢。
- 任务卡「已写」篇数带分母：批次进行中显示「已写 0/16 篇」（分母 = 任务明细长度），不再只剩光秃秃的「已写 0 篇」。

## 0.4.11 — 2026-10-07

### 任务进度条与逐任务明细

- 批量任务中间进度透出：`settleBatch` 轮询到非终态时把百炼批次的 `request_counts`（total/completed/failed，OpenAI batch 兼容字段）经 `onProgress` 回调写进 `job.batchProgress`，任务卡与总览行实时显示「批次 n/m」进度条——此前批次提交后只能干等终态，中间毫无反馈；批次收尾后中间进度作废清空。
- `jobSummary` 新增 `taskList`：已结算条目（done/failed）在前、当前批次待办（pending）在后，进度条分母即其长度——任务卡（活动任务）逐行列出每个文章任务的状态（✓/✗/·），每篇文章各自进度一目了然。
- 总览页仓库行的 lastJob 对活动任务附带 `taskList/batchProgress/tps`：不切到任务页也能看到该工作区当前任务的进度条、批次进度与 tps。
- 修复总览行 meta 文案拼贴（「变更文件 12stale」）：两个相邻文本子节点被 React 拼在一起，改为单字符串拼接；lastJob.kind 顺带本地化（full/stale/resume → kindLabel）。

## 0.4.10 — 2026-10-06

### 端点加固与诊断（真宿主 HTTP 400 排查产物）

- `workspaceRegistry.list()` 抛错（宿主注册表内部不一致，如 order references missing workspace）时工作区过滤自动降级停用：jobs/repos 端点保持 200 可用，不再把面板整个拖成 HTTP 400——过滤是体验优化，不允许破坏基础功能。
- jobs/repos 端点包诊断 try/catch：handler 异常时响应 500 + `{error, stack}` JSON。此前宿主 webserver 对 handler reject 只回 400 空 body，异常无从排查。
- 仓库清单持久化文件支持 `DSH_CODEWIKI_REPOS_FILE` 环境变量隔离（0.4.7 的测试隔离只覆盖了 JOBS_FILE，测试与真实宿主共享 repos.json 导致 fixture 污染真宿主总览）。
- 修复 codewiki_generate 输出校验失败（`"value.jobId" must be a string`）：clean 短路等不提交路径的返回值带 `jobId: null / stage: null` 占位，宿主按 output schema 校验时 null 不是 string——改为仅在提交/幂等/续查路径赋值，不提交路径不含这两个键；编排测试新增与宿主同构的 output schema 校验断言（提交路径 + clean 短路双覆盖）。
- 修复总览/任务页 `cannot get property "list" without inject`：cordis `ctx.inject(['svc'], cb)` 的回调参数是注入了服务的 ctx 切片（服务在切片同名属性上），此前把切片当 WorkspaceRegistry 实例存下，`wr.list` 属性访问触发 cordis 严格 getter 抛错——改为 `rc?.workspaceRegistry ?? rc` 取实例并校验 list 方法，拿不到降级不过滤；测试 makeCtx 的 inject mock 同步改为切片语义（宿主同构），0.4.9/0.4.10 断言全链路重验。

## 0.4.9 — 2026-10-06

### 工作区任务过滤（hindsight 同机制）

- 任务页只显示属于已添加 dsh 工作区的任务：服务端经 `ctx.inject(['workspaceRegistry'])` 读取宿主工作区注册表（侧边栏「添加工作区」的持久化列表），任务 cwd 等于某工作区或位于其子目录内才显示（语义同 hindsight withinPath）——Temp 沙箱与任意路径任务不再出现在面板。
- 新设置「只显示工作区任务」（workspaceOnly，默认开）；宿主未注册任何工作区或老宿主无该服务时自动不过滤（降级安全）。
- 总览页（仓库列表）同样过滤：knownRepos/job 历史里的 Temp 沙箱与任意路径目录不再出现；repos 缓存键含工作区清单签名，开关或清单变化立即生效。设置开关关闭后恢复全显。

## 0.4.8 — 2026-10-06

### 仓库发现与一键排除

- 已知仓库清单（knownRepos）：提交过一次编译的工作区永久登记到独立持久化清单（与任务记录同目录），任务历史被截断或清理后，总览页仍能发现并展示这些工作区——hindsight recentWorkspaces 同思路。旧任务历史在服务启动时一次性灌入清单。
- 总览页每个仓库行新增「排除 / 取消排除」按钮：直接改插件配置 excludePaths（与设置卡保存同一条 configForms 链路，持久化并热生效），不再需要手动填路径清单；排除后自动刷新总览状态。
- control 新增 refresh 动作：让仓库总览的 30s 缓存立即失效（排除操作后自动调用）。
- 总览扫描源合并任务历史与 knownRepos 清单（路径规范化去重，任务历史形态优先）。

## 0.4.7 — 2026-10-06

### 排除清单 + 自动更新 + 仓库总览与标签页

- 排除清单（excludePaths）：换行/分号/逗号分隔的绝对路径列表，命中的目录（含子目录）不编译 CodeWiki——工具调用与自动扫描都会拒绝并提示；面板「设置」页可编辑。
- 自动更新（autoUpdate，默认关）：开启后服务每分钟自检，距上次扫描超过扫描间隔（autoUpdateMin，默认 30 分钟，最小 5）时对所有历史工作区逐仓 scope=auto 增量编译（被排除目录跳过），单仓失败记入调度信息不中断。
- 面板改三标签页（总览/任务/设置）：「总览」页轮询 /api/codewiki/repos 展示所有编译过的工作区——每仓 wiki 状态（最新/有变更/未编译/未初始化/出错/已排除）、过期文章数与变更文件数、最近一次任务摘要，有变更的仓库可直接点「更新」立即编译；顶部调度卡显示自动更新开关状态、扫描间隔、上次扫描时间与最近错误。
- 新端点：GET /api/codewiki/repos（30s 缓存，逐仓 cw status 判态）；control 动作新增 compile（指定 cwd 立即编译，供总览页按钮与外部自动化调用）。
- jobSummary 增加 auto 字段区分自动扫描触发的任务。

## 0.4.6 — 2026-10-06

### 面板收敛 + 实时 tps + Temp 残留自动清理

- 面板默认只显示一张焦点卡片（活动任务优先，无活动则最近更新的任务），其余任务收进「历史任务 (N)」折叠区，展开后保留按工作区分组视图。
- 焦点卡片显示实时 tps：实时通道每任务上报输出 token 数与耗时，取最近 20 个样本聚合（总 token / 总毫秒）；批量阶段无样本不显示。
- 服务启动自动清理系统临时目录（Temp）下已终态（完成/失败/取消）的调试残留任务，活动任务与工作区任务保留——不再需要手工取消清理。
- 健壮性：note() 对磁盘残留的缺字段 job 防御性补齐 notes，畸形任务不再崩掉服务 tick。

## 0.4.5 — 2026-10-06

### 阶段实时阈值（混合通道）

- 新增设置「阶段实时阈值」（batchMinTokens，默认 30000，0=全走批量）：服务在提交每个阶段前估算全部任务输入 token，低于阈值时改走百炼实时对话接口（/chat/completions）按 maxConcurrency 并发执行——免批量排队等待，小阶段（规划、少量续查/增量）明显提速；达到阈值仍提交批量任务（实时价 5 折），单阶段决策并在任务 notes 留痕。
- 实时结果与批量结果同构收割：keepInMemory 任务（横切）内容经 frontmatter 校验落盘；断点/取消/续查语义不变。
- 面板设置卡新增阈值输入框（0–1000000 整数校验，实时生效）。

## 0.4.4 — 2026-10-06

### 侧边栏面板完善（真实环境反馈）

- 面板可滚动：根容器 `height:100%; overflow-y:auto`，任务多时不再溢出裁切。
- 任务按工作区（cwd）分组显示，组头显示仓库名（悬停见完整路径），组内最新在前。
- 进行中卡片强化：brand 色高亮边框 + 阶段徽章呼吸动画 + 实时已耗时（mm:ss）+ 文章进度 `已写 X/Y 篇`（取 articles 数组 ok 计数/总数）。
- 设置参数移入面板：面板头部「设置」按钮展开插件设置表单（复用 CodewikiCard，configForms 热生效），插件页卡片保留。
- 百炼 API Key 密码遮蔽：输入框 `type="password"`，不再明文显示。

## 0.4.3 — 2026-10-06

### 审查修复：取消可靠性、多实例安全、断点保真

审查（bb72b2c..675d51f）发现的问题全部修复：

- **取消标记跨实例丢失（根因修复）**——`codewiki_generate` 工具的 execute 闭包原引用模块级 `jobServiceRef`（每次 apply 覆盖），多插件实例并存时（插件重载/测试重复 apply）提交与取消/面板端点会打到不同 service 实例：A 实例 cancel 落盘的 cancelRequested 在几 ms 内被 B 实例 tick 的内存副本整写覆盖，取消永远不生效。修复：service 作为参数注入工具定义，execute 闭包绑定自己 apply 创建的实例；模块级引用删除。
- **生命周期**——`ctx.effect(() => () => service.stop())`（此前写成 `() => service.stop()` 会在启动时当场停掉服务）。
- **多实例写盘安全**——job 带 `owner`（创建实例 id），tick 只推进自家 job；flush 脏标记（无变更不整写）+ `mergeFromDisk` 磁盘吸收（同 id 磁盘更新且非本实例现场才替换）；tick 进程级 `JOBS_FILE.lock` 串行；每轮 tick 开头从磁盘跨实例拾取 cancelRequested；cancel/list 先 mergeFromDisk。
- **凭证窗口重复提交**——submit 占位先行（stage=submitting、无凭证即落盘），resolveBatchApiKey 失败则 fail+落盘后抛错；tick 跳过 submitting。
- **断点保真**——批次断点文件记录 `stage`/`crosscutSplit`/任务清单，resume 按原阶段恢复（0.3.x 旧断点无 stage 回退 articles）。
- **jobs 端点**——jobSummary 补 `cancelRequested` 字段（面板取消按钮状态）。
- **横切/校对批次异常信息**——非终态时读 errors 数组（此前只读 error.message，错误被吞）。
- **localReview 文件丢失回退**——降级时 writtenCount-- 不再虚报已写篇数。
- **tickCompose 无断点**——上次进程中断于提交后落盘前时写 note 留痕再跳过。
- **面板**——effect 返回 disposer（slots 注入可卸载）、style 防重复插入、轮询防重入+卸载守卫、加载态词典 loadingLabel（此前显示「已保存」）。
- 文案：cw 工具描述改「后台批量流水线服务」；服务注释同步 0.4.x 行为。

测试：test-orchestration 新增「断点 stage 字段」「并发提交占位与 flush 磁盘合并」块，取消块断言补齐（终态 cancelled + 断点保留 note）；test-batch 74 通过；test-cwd-paths 通过。

## 0.4.2 — 2026-10-06

### 超大任务升 256k 档（3 倍价）继续走批量

- 单文件超 28k 预算的任务不再直接实时兑底/跳过校对：先升 `BATCH_TOKEN_HARD_LIMIT`（200k，256k 档内留余量）重装继续走批量——百炼按请求实际输入 token 自动分档计价，无需 API 参数，批量仍 5 折（$0.05/M，仍比实时兑底便宜一半）。单文件连 200k 大档都装不下才回退实时兑底（文章任务）/跳过校对。
- 校对动态预算同理：剩余预算装不下先升大档重装，长文章不再整篇跳过校对。
- 提交时统计输入超 32k 档的请求数写入 notes（「N 个请求输入超 32k 档，按 3 倍价计费」），费用可预期。
- 测试：test-batch 大文件断言更新（86k→升大档批量、新增 234k→实时兑底）；编排测试 bigArticle 提到 3 万字并断言 3 倍价明示。

## 0.4.1 — 2026-10-06

### 横切精准拆分（map-reduce）+ 校对动态预算

- **横切 map-reduce**（用户请求：不要把所有代码堆进一个任务，精准拆小靠并发提速）：模块文章原始总量超 `BATCH_TOKEN_BUDGET`（28k）时，横切不再把截头 pack 塞进单任务，而是每篇模块文章一个「架构观察」任务（`obs0..n`，输入=单篇全文，并发跑批量），settle 后拼观察 pack 提交合成批（arch/patterns/concepts 输入=观察，体积小、永不超限）；阶段机新增 `compose`（面板文案「合成中/Composing」）。总量装得下（小仓库）保持单批直出，零拆分开销。新增 `batchObservePrompt`；观察批不走 tally（不写盘不计数），`crosscutTasks` 抽出供单批/合成批共用。拆分判定必须用原始总量——`packArticles` 只截后续文章头部，pack 体积永远装得下。
- **校对动态预算**：源码装填改用「`BATCH_TOKEN_BUDGET` − 文章 token」的剩余预算（装不下首个源文件才跳过校对）——原实现先按整预算装满再判总和，文章一长整篇跳过校对。
- 测试：`test-orchestration.mjs` mock 暴露 uploaded、新增 obs 应答与 bigArticle 选项；新增「大 wiki 横切精准拆分」块（每篇 2 万汉字 ×2 触发拆分：断言观察输入单篇、合成批不含原文、横切照常落盘、校对动态预算回写）。

## 0.4.0 — 2026-10-06

### 服务化全批量流水线：零子代理 + 侧边栏面板 + 32k 分块并行

- **编译不再依赖子代理，改为宿主常驻服务驱动**（用户请求：生成 codewiki 不靠子代理，模型调用工具后自动开始生成）：`codewiki_generate` 改为纯提交制——normalizeCwd、cw status 判态、规划/文章/横切/校对任务预构建后交给 `createJobService` 即返回 `{submitted, jobId, stage}`；服务 tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调）推进阶段机 plan→articles→crosscut→review→index，收尾 `cw index`+`meta update`。job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（saveJobs 只剥 apiKey，cancelRequested 跨 tick 存活）；多实例并发以脏标记防互相覆盖（persist 置脏、tick 末 flush，submit/cancel 先落盘再异步 tick）。工具路径零 LLM 调用、零子代理派发；测试 `test-orchestration.mjs` 全文重写为提交制 + mock 百炼批量 API + 轮询 jobs.json 等终态。
- **五个环节全部走百炼批量推理**（原 0.3.0 只写文章环节）：规划、横切文章、审校均新增批量任务模板（JSONL 单轮生成；横切/校对产物 keepInMemory，由服务落盘/回写）；仅超预算单文件（>BATCH_TOKEN_BUDGET 或源码过大）回退实时兑底 `runRealtimeTasks`（并发池硬顶 8，结果与批量同构）。
- **32k 输入分块吃满低价档**（qwen3.7-flash 输入 ≤32k 档 $0.03/M、批量再 5 折）：`BATCH_LINE_BUDGET 800KB → BATCH_TOKEN_BUDGET 28000`（estimateTokens：CJK≈1/字、ASCII≈3.5 字符/token，留 4k 余量）；`collectSources`/`prepareArticleTasks` 按 token 预算装填，模块/概念源码超预算自动拆多任务，断点/收尾语义不变。
- **hindsight 式侧边栏面板**（用户请求：和 dsh-hindsight-on-demand 一样的插件显示）：client.js 重写——`main` + `sidebar.panellist` 双 slot（key/id='codewiki'，order 52），2s 轮询 `GET /api/codewiki/jobs`，任务卡显示仓库名/类型（全量/增量/续查）/阶段（中文）/已写篇数/最近 notes/wiki 路径，活动任务可取消（`POST /api/codewiki/control {action:'cancel'}`，断点保留可续查）；端点仅回环放行、payload 不含 apiKey。设置卡删除子代理机器（编译模型级联/模型目录轮询/batchEnabled/batchAsync/batchWaitMinutes 全删——批量已是唯一路径），仅留 enabled/updateReminder/maxConcurrency（实时兑底）/articleLanguage/binaryPath/batchApiKey/batchModel/batchThinkingBudget。
- **提交制入口语义**：missing/stale 态判给服务端做（cw status 变慢不再是主模型等待）；取消幂等；孤儿断点（0.3.x 遗留 checkpoint）发现即并入 resume job 自动收尾；无凭证诚实报错「未找到百炼 API Key」不再回退子代理。
- fix：`writeValidated` 对 keepInMemory 任务直接写盘（原委托 applyTaskResult 导致横切/校对产物全部丢失）；`touch` 标脏（取消终态原先进不了 jobs.json）。
- test：test-batch.mjs 重写（73 断言：token 预算/分块/断点/实时兑底/keepInMemory）；test-orchestration.mjs 重写（提交制全流程/stale 直达 articles/孤儿续查/端点+取消+403+404/无凭证/严格 cordis 不碰未 inject 服务）；test-cwd-paths.mjs 不变全 PASS。

## 0.3.2 — 2026-10-04

### 批量推理异步化：提交即返回，宿主后台链自动收尾

- 动机：批量推理就地等待（默认 20 分钟，批次最长 24h）会把主模型挂起干等；用户要求「使用两层子代理……主模型无需一直等待」。落地为两层：主模型提交批次后立即返回；宿主内后台收尾链（代码实现，零 LLM 成本）等待批次、落盘、派发横切/审校子代理、刷新索引。横切/审校子代理模型走插件默认路由（设置 defaultModel 可换 `qwen3.7-flash`）。
- 新设置 `batchAsync`（默认 true，volatile）：关闭则回退旧的就地等待行为。
- 位置：`runBatchTasks` 增 `background` 模式（提交即返回 `{submitted, prepared}`）；execute 内 `backgroundFinalize` 闭包——不绑 exec.signal（主调用返回后等待继续），轮询 10s→60s（上限 24h）→ `settleBatch` 落盘 → 派发「横切文章（批量后台）」「审校（批量后台）」子代理 → cw index/meta update，结果以 `[dsh-codewiki]` 前缀写 console；断点机制不变（宿主关闭则下次调用自动续查）。异步模式下续查遇批次未终态不再抛错，直接返回并说明后台跟进中。
- 测试：test-batch.mjs 增 background 节（提交后不再轮询、prepared 带 customId/batchPrompt、断点写入）；test-orchestration.mjs 增异步集成节（主调用立即返回 0 篇、1.5s 后后台链落盘并派发横切/审校、断点清理），原就地集成节显式 `batchAsync:false` 保留覆盖。

## 0.3.1 — 2026-10-04


- feat：**批量推理凭证自动取模型设置「阿里百炼云」渠道**（用户请求：直接使用模型设置中的阿里百炼云）：`batchApiKey` 留空时经宿主凭据库解析——`ctx.inject(['credentials'])` → `resolve('ALIYUN_BAILIAN_API_KEY')`（`resolveBatchApiKey`，index.js:421），与模型适配器同一份凭证（继承 env > 凭据库 > .env）；显式填写 `batchApiKey` 则覆盖。取不到凭证仍回退智能体子代理。宿主上下文在 `apply` 时捕获；解析链 3s 超时防服务缺失挂起。
- test：`test-batch.mjs` 增 `resolveBatchApiKey` 解析链 7 断言（显式优先/无上下文/数组形态/条目缺失/inject 抛错）；`test-orchestration.mjs` 批量集成节改走凭据库路径（`batchApiKey` 留空 + mock credentials 服务），新增 notes「凭证来源 credentials(file)」断言。三套测试全 PASS。

## 0.3.0 — 2026-10-04

- feat：**写文章环节可改走阿里云百炼批量推理（Batch File，实时价 50%）**（用户请求：用批量推理给 code wiki 编译降本）：
  - 只把「写文章」环节（成本大头、单轮文本生成）转批量：插件内联源码 → JSONL 上传百炼 → 轮询批次 → 插件落盘；规划/横切/审校仍走智能体子代理（多轮工具调用，批量通道不适用）。默认关闭；`batchApiKey` 留空自动回退智能体子代理，默认行为零变化。
  - 新设置（全部 volatile 热生效）：`batchEnabled`（默认 false）/ `batchApiKey`（DashScope Key）/ `batchModel`（默认 `qwen3.7-flash`；仅华北2 支持，须用别名——快照版不支持批量）/ `batchThinkingBudget`（默认 0=关思考，省输出 Token；1–32768=开思考并限预算）/ `batchWaitMinutes`（默认 20，就地轮询等待）。
  - 思考参数按百炼官方 JSONL 规范放 `body` 顶层与 `model` 同级（`enable_thinking`/`thinking_budget`，extra_body 无效）；单行预算 800KB（百炼上限 1MB），整文件粒度装填、超限任务回退智能体子代理而非丢弃。
  - 断点续跑：批次未收尾时断点存 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`——超时/中止保留，下次 `codewiki_generate` 调用先续查收尾（含 cw index/meta update）再谈新任务，24h 窗口内不丢工作。
  - 结果对账：结果文件行（status_code）+ 错误文件行（message）合并为逐篇成败与原因；仅成功文章落盘，失败记账不中断。
  - 位置：index.js 批量推理模块（`collectSources`/`buildBatchJsonl`/`parseBatchResults`/`settleBatch`/`runBatchTasks`，导出供测试）；`generateToolDefinition` 两条写文章路径（stale 逐篇、全量模块）改走统一出口 `runArticleTasks`（批量或智能体分批）。
- feat：**写文章并发上限放宽到 8**（用户请求）：`CONCURRENCY_HARD_CAP` 2→8，默认值随硬顶=8；schema/设置页校验与提示、CodeWiki.md 同步。原红线 2 为早期保守值，写文章子代理是独立短任务，8 并发配合批量/子代理路由无相互干扰。
- test：新增 `test-batch.mjs`（35 断言）：buildBatchJsonl 思考参数位置与取值、parseBatchResults 结果/错误/坏行、collectSources 装填与预算边界、mock fetch 全流程（提交→轮询→收尾→落盘→删断点）、超预算 oversized 回退、超时保留断点、断点续查收尾。`test-orchestration.mjs`（默认智能体路径回归）与 `test-cwd-paths.mjs` 全 PASS。

## 0.2.8 — 2026-10-03

- feat：**写文章子代理活动行 label 带模型前缀**（用户实测报告「活动行看不出子代理用什么模型」）：
  - `launchAgent` 统一给 label 加 `[<model>] ` 前缀（如 `[qwen3.8-flash] codewiki:更新 xxx`）：显式 route（调用参数或插件默认）直接用其 model；继承会话模型时经 `parentRouteOf`（鸭子类型：`agent.session.requestHeader()?.config` 优先 → `agent.options` 兜底，异常返回 undefined）解析真实模型名，解析不出则不加前缀（不编造）。model-only 前缀是因为活动行标题截断早（约 28 字符），provider/model 全称会把文章名挤没；provider 差异靠结果 notes 已有的全称汇总兜底。
  - 位置在 `launchAgent` 汇聚点（6 个调用点零改动）；记账/notes 仍用原始 label，仅活动行显示前缀。
- test：mock 子代理按 label 路由改子串匹配（startsWith → includes + split，label 现可带前缀）；新增断言「全量路径全部 spawn 的活动行 label 带模型前缀」。

## 0.2.7 — 2026-10-03

- fix：**插件整体未装载（两个工具全部消失）**——0.2.5 引入的回归，用户实测报告「没有安装上」：
  - 根因：`installUpdateReminder` 里 `ctx.agents?.list()` 直接访问插件 ctx 上的 `agents` 服务属性。真实 cordis 对未声明 inject 的服务属性，**访问本身即抛**（`Error: cannot get property "agents" without inject`，`typeof` 守卫无效），`apply` 同步崩溃 → fiber FAILED → cordis 回滚该 fiber 全部效果 → `cw` 与 `codewiki_generate` 从未注册。0.2.5 之前无此代码故正常；mock 测试里 `.agents` 是普通对象，测不出 cordis 严格语义。
  - 修复：存量代理改经 `ctx.inject(['agents'], cb)` 枚举（服务缺失静默跳过；参照 `packages/context/file-reference-local/src/index.ts:45` `static inject = ['agents']`），新会话仍走 `agent/created`。
  - 定位手段：用 CLI 自家 `runProfile` 做隔离子进程真启动（overlay 补丁禁用 webserver/billion-context 避免端口冲突），启动审计显示 codewiki `fiberState: 3（FAILED）`；修复后同法重跑，失败清单中 codewiki 消失＝激活成功。
- test：`test-orchestration.mjs` 新增 3 项「严格 cordis 语义」断言（未 inject 的服务属性以 getter 抛错模拟真实 cordis；apply 不抛错、两工具仍注册、agent/created 已布线）——先 RED（报错与守护进程逐字一致）后 GREEN；`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.6 — 2026-10-03

- feat：**设置页支持选择子代理思考程度**（用户请求）：
  - 新设置 `defaultReasoningEffort`（默认空=跟随所选模型默认，volatile 热生效）；`codewiki_generate` 新增调用参数 `reasoningEffort`（优先于插件默认，与 provider/model 同级）。effort 是 adapter 自有的不透明值（deepseek 适配器为 off/low/high/max），插件不硬编码枚举。
  - 路由流：`launchAgent` 的 `agentOptions` 改为只从 route 里真实存在的字段构建——provider+model 成对才设、reasoningEffort 有值才设。修复隐患：effort-only route（provider/model 留空继承会话模型、只调 effort）时旧代码会写出 `{provider:undefined,model:undefined}` 覆盖继承的父路由。
  - 设置页（client.js）「编译模型」区新增「思考程度」：下拉选项来自 `modelCatalog()` 对当前 provider+model 广播的 `reasoning.efforts`（含名称），随 provider/model 级联；目录无该模型或无档位时退文本输入（可手输 adapter 自有值）；当前值不在档位里时保留显示。zh/en 双语提示同步。
  - notes 现在会注明思考程度：`子代理模型：p/m（插件默认配置，思考程度 low）`。
- test：`test-orchestration.mjs` 新增 2 项断言（全量路径全部 spawn 携带 `defaultReasoningEffort=low`；stale 调用参数 `reasoningEffort=max` 覆盖插件默认）——先 RED 后实现全 PASS；顺带暴露并修复 liveConfig 白名单漏掉新键的问题。`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.5 — 2026-10-03

- feat：**wiki 维护提醒注入会话系统提示**（用户请求：提醒模型在改动完成后更新 codewiki）：
  - `apply` 新增 `installUpdateReminder`：`agent/created` 时在 agent 作用域注册系统提示 section `codewiki:update-reminder`（order = TOOL_REPORT+1，工具报告之后）。text 回调每次组装求值——`updateReminder=false`、会话无仓库或仓库无 `.codewiki/` 时返回空字符串（renderPrompt 丢弃空 section，零噪音），否则注入 4 行收尾提醒：`codewiki_generate`（scope=auto）或手工 `cw status`→更新→`cw index`→`cw meta update`、修 bug 补 `learnings/`、决策补 `decisions/`、wiki 与代码同提交。
  - 新设置 `updateReminder`（默认开，volatile 热生效）；设置页（client.js zh/en）运行区新增开关；profile patch 注释同步。
  - 注入按 agent 作用域安装，section 随 agent 处置自动销毁；已知子代理会话不受影响（提醒只装在宿主会话 agent 上，由 agent/created 事件对象形状决定）。
- test：`test-orchestration.mjs` 新增 5 项断言（agent/created 注册 section、section 名、有 `.codewiki` 时文本非空含 codewiki、无 `.codewiki` 时空文本、`updateReminder=false` 时空文本）——先 RED 后实现，全 PASS；`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.4 — 2026-10-03

- fix：**子代理模型路由在两条编排路径上被静默丢弃**（用户实测报告：指定/默认模型被「路由冲突」覆盖成继承模型；实际与路由插件无关）：
  - 根因：`launchAgent` 从 task 解构 `route` 再设置 `payload.agentOptions`，但 6 处 task 构造中有 2 处漏传 `route`——① stale/auto 逐篇更新（`codewiki:更新 …`）② 全量编译的模块文章（`codewiki:模块 …`）。task.route=undefined → `if (route)` 不触发 → 子代理继承父会话模型（含 reasoningEffort）。规划/降级/横切/审校 4 处显式传参未受影响；notes 的「子代理模型：…（插件默认配置）」独立于 task 计算，照样显示——声称与实际不符。
  - 修复：两处 task 构造补上 `route,`；全量与逐篇两条路径的所有 spawn 调用现在都携带 agentOptions。
  - 排查记录：核心链路（subagents.start → spawn provider → resolveChildAgentOptions → agent-loop prepareRequest）checkout 与运行时（app.asar 解包比对）逐字一致且全部正确；子会话 `request/header` 的 effort 被保留、0 次指定路由尝试，是把嫌疑收敛回插件编排层的关键证据。
- test：`test-orchestration.mjs` 补 3 项断言（规划 agent 之外）：模块文章 agent 携带 agentOptions、全量路径全部 spawn 调用携带 agentOptions、逐篇更新 agent 携带 agentOptions。修复前 RED（精确复现 3 项缺失），修复后全 PASS；`test-cwd-paths.mjs` 回归 ALL PASS。

## 0.2.3 — 2026-10-03

- fix：三个路径/描述缺陷（用户实测报告，Wxxy-CampusLogin 仓库复现）：
  - **MSYS 路径被误判不存在**：win32 上 `/e/...` 形式 Node fs 不认，`existsSync` 失败直接抛「cwd 不存在」。新增 `normalizeCwd`（仅 win32 把 `/x/...` → `X:/...`，POSIX 原样），cw 与 codewiki_generate 两工具 cwd 校验统一接入。
  - **Windows 路径校验通过但结果错**：`resolveBinary` 原先捆绑二进制优先，`bin/cw.exe` 是旧布局（`~/.codewiki`）版本，导致 bash 原生 `cw status` 正常而包装层报 "No wiki found"。改为 binaryPath → PATH 探测（win32 `where` / POSIX `which`）→ 捆绑兜底；捆绑副本同步刷新为当前源码构建（sha256 953adcb5…，与 `~/.cargo/bin/cw.exe` 一致）。
  - **工具描述与实现不符**：描述/wikiPathFor 兜底从 `~/.codewiki/<project>/` 全部对齐上游 `wiki_path()` 的 `<repo>/.codewiki/`（随仓库提交共享）；`projects` 子命令说明改为「只列出 ~/.codewiki 旧位置的项目，一般用不到」。
- test：新增 `test-cwd-paths.mjs`（import 真实 index.js，mock ctx 注册捕获，MSYS / Windows / 不存在路径三态实测）——MSYS 归一化后 `cw path` 返回 `<repo>/.codewiki`、Windows 路径 `cw status` 返回真实三态、非法路径干净报错，ALL PASS。
- 文档：README / CodeWiki.md / client.js（zh+en）/ cordis.patch.yml 同步仓库内 wiki 位置与 PATH 优先顺序。

## 0.2.2 — 2026-10-02

- fix：审查修复 8 项（test-orchestration.mjs 先行 RED：clean + scope=full 强制全量被短路）：
  - `scope=full` 在 clean 态不再被「无需编译」短路，强制全量重编与文档一致；
  - `cw status` 非零退出且无输出时直接抛错（此前二进制缺失/崩溃会被兜底成 stale 空清单白走全量）；
  - 横切文章失败计入 `failedCount`（与 stale / 降级路径口径一致）；
  - `runCw` 响应 `exec.signal`（abort 即 SIGKILL 子进程），cw / codewiki_generate 的全部子进程调用接入；
  - `cw index` / `cw meta update` 失败时 notes 追加「编译基线可能未刷新，可重试」告警；
  - 移除 execute 末尾不可达死代码；
  - 设置页：保存条在 dirty 时不显示「放弃更改」文案 Tag（按钮 disabled 态已表达）；
  - 文档同步：README / CodeWiki 中子代理派发写法与 0.2.1 实现一致（直用注入服务）。
- test：新增「clean + scope=full 强制全量」编排用例；修复前 RED，修复后全 PASS。

## 0.2.1 — 2026-10-02

- fix：子代理服务两处接线断裂，codewiki_generate 一进编译路径即抛错，0.1.0 起从未真正可用（当时验证只做了 node --check 与 CLI 冒烟，没跑过编排路径）：
  - `generateToolDefinition(cfg)` 没接住 `apply()` 传入的 `subagents`（index.js:685 → 432），execute 内 6 处引用即抛 `ReferenceError: subagents is not defined`；
  - `launchAgent(rc, …)` 实际收到的是子代理服务本身，却按 `rc.subagents.start` 取用（index.js:118），前一处修完后又抛 `TypeError: Cannot read properties of undefined (reading 'start')`。
  - 两处均改为直接使用传入的 `subagents` 服务。
- test：新增 `test-orchestration.mjs` 编排行为冒烟（mock 子代理服务 + 真实 cw CLI）：覆盖全量编译（规划→分批写文章→横切→审校→index/meta update）与 stale 逐篇更新两条路径。修复前 RED（精确复现 ReferenceError@598），修复后 PASS。

## 0.2.0 — 2026-10-01

- 新增插件页设置 UI（`client.js`，浏览器半侧）：插件管理页 Official 组出现 **CodeWiki** 条目（`plugins.item`，id `codewiki`，order 30），点进详情页可设置：
  - **编译模型**：provider/model 级联下拉（目录来自 `ctx.remote.session.modelCatalog()`，4s×3 退避重试 + `llm/adapters-updated` / `connection/reset` 刷新；目录不可用退化为文本输入）。
  - **运行**：启用开关、写文章并发上限（1–2 校验）、文章语言、cw 可执行路径。
  - 保存经 `configForms.mutate` 单层 op（revision CAS），脏检测 + 放弃更改 + 冲突提示；与 patch 文件手改等价，均热生效。
- `package.json`：加 `exports["./client"]` + `dsh.client.platform: "web"`——宿主 client 扫描器沿 file:/// 挂载条目发现本包（无需 profile link）；「非 client 包」判定按条目缓存，**生效需重启 dsh**。
- 注册形状对齐已装插件实证：`locale.bind/register`（词典值全字符串）、`slots.inject('plugins.item', …)` 包 `configForms.whileServed([NS], …)`、React `el()` + dsh-client-ui-primitives（Switch/Button/Input/Pill/StateDot/Tag）。
- 静态验证：`node --check client.js` / `index.js` 通过；`package.json` 解析校验通过（exports + dsh.client 齐全）。设置页 UI 需重启后在插件页实测。

## 0.1.1 — 2026-10-01

- 移除 `codewiki` 技能（skills/codewiki.md 与 skillProvider 注册一并删除）：保留纯工具面（`cw` + `codewiki_generate`），wiki 编译一律走工具。
- `defaultProvider`/`defaultModel` 默认值从空改为 `aliyun-bailian`/`qwen3.8-flash`（即路由插件 wiki 档）：不传参时子代理固定走便宜模型；显式置空两项才继承会话模型。

## 0.1.0 — 2026-10-01

首次发布。

- 工具 `cw`：CodeWiki CLI 薄封装（子命令白名单：init/status/index/meta/path/projects/setup/uninstall；120s 超时）。
- 工具 `codewiki_generate`：智能体编排编译（规划 → 分批写文章 ≤2 并发 → 横切 → 审校 → index + meta update），支持 provider+model 指定子代理模型、scope auto/full/stale、规划失败降级单 agent、部分失败不刷新基线。
- 技能 `codewiki`：上游 codewiki-session.md 的 DSH 适配版。
- vendor 上游 codewiki（mraza007/codewiki @ HEAD，MIT），cargo release 编译出 `bin/cw.exe`。
- 挂载：profile cordis.patch.yml file:/// 直挂（id `codewiki`）；`@deepseek-ai/schemastery` 本地 junction → harness vendor。

验证记录（2026-10-01）：

- `node --check index.js` 通过；`import(index.js)` 通过（name/apply/Config 导出齐全）。
- CLI 冒烟（/tmp/cw-smoke 临时 git 仓库）：`cw init` / `path` / `projects` / `status` 三态（No wiki found → has not been compiled → up to date）/ `index`（2 articles）/ `meta update` / 提交后 stale 判定（`Changed since last compile` + `M src/app.py` + `Stale articles: ! modules\app.md`）全部符合预期；注意 stale 文章路径是反斜杠，插件侧已归一。
- 挂载生效需重启 dsh（CWD 配置热读取，但插件注册本身不热加载）。
