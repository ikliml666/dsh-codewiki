# @local/dsh-codewiki

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：仓库内代码 wiki（`<repo>/.codewiki/`，随仓库提交共享）+ 智能体编排编译，支持为编译子代理指定模型。

**0.16.0 起默认通道是 FSoft 原生引擎**（`nativeEngine` 默认 `true`）：直接把上游 FSoft CodeWiki 的 Python 引擎当子进程驱动，由它做符号图、模块树、增量裁决与文章写作，插件这一侧只负责环境探测、模型桥、质量闸与落地事务。**这条通道需要本机有 Python 3.10+ 与闭合的依赖环境**（`tools/fsoft-engine/setup-env.sh`）。环境不闭合时以 `engine-deps` 明确失败，不会悄悄改走 Node 通道冒充成功。

**0.13.0 曾经在 Node 侧重写过一遍 FSoft 的三层能力**（AST 符号提取 `lib/symbols.js`、LLM 语义聚类 `lib/cluster.js`、符号级增量 `lib/graph-diff.js` + `lib/incremental.js` + `lib/update-planner.js`）。**这五个模块已在 0.16.0 阶段 7 受控退役中删除**——同一套算法维护两份没有意义。它们守护的行为现在由原生引擎在 Python 侧承担；`nativeEngine:false` 的兼容通道只保留按顶层目录分组 + 文件级 `source_files` 归属判定这两项最小能力。

**0.14.0 起补上「增量不丢、结果诚实、坏文章不入库」三层质量保证**（对应上游的 updater/ownership/完整性终态/write-set 与文章质量门）：变更采集覆盖工作区（未提交/已暂存/未跟踪/删除/改名），增量规划带反向依赖闭包与新文件 ownership，终态新增 `partial` 且只有完整成功才推进基线，所有写盘点统一走文章契约闸门。详见下文「增量与质量保证（0.14.0）」。

**0.15.0 引入、0.16.0 转正的原生引擎通道**（`nativeEngine`，**0.16.0 起默认开启**）：装法见「原生引擎通道」。`nativeEngine:false` 仍然可用，是一条**兼容通道**（插件内 Node 流水线），只服务「本机装不了 Python 依赖」这一种场景，**不再接收新能力**；两条通道互不回退。

## 提供

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 提交制编译：cw status 判态 → 提交后台 job 立即返回 → 宿主常驻服务按 规划 → 写文章 → 横切 → 审校 → 索引 推进（侧边栏 CodeWiki 面板可见；0.13.0 起规划阶段默认走 AST 符号聚类，写作默认走 agentic 工具循环），全部模型环节在插件内完成（默认 `workbuddy`/`hy3`，192k 上下文，单请求输入预算 110k；110k–420k 输入自动升大档单请求，0.10.8），常规路径不派子代理、不委托发起会话的主模型（0.10.0）；只有单模块源码连 420k 大档都装不下时才走观察→合成或会话通道兜底 |
| `codewiki_update` | 工具 | 日常维护入口（0.7.0 起）：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「本步收尾、继续下一项」，不要等待、不要轮询；编译产物由插件自动提交入库（0.10.9，`autoCommit`），**成功时不再唤醒会话**，只有自动提交失败才发一条一次性「产物待提交」降级提醒 |
| `codewiki_progress` | 工具 | 只读查编译进度：提交后随时查 stage/百分比/已写/失败篇数/失败原因，立即返回不等待（数据与侧边栏面板同源）。可选按 `cwd` 或 `jobId` 过滤，都不传列全部任务。0.14.0 起终态有四种：`done`（完整成功）/`partial`（部分完成，附 `blockers` 说明原因）/`failed`/`cancelled` |
| CodeWiki 设置页 | 插件页 UI | 插件管理页 Official 组出现 CodeWiki 条目（id `codewiki`），点进详情页可改编译模型（provider/model 级联下拉，目录来自 modelCatalog）与运行选项；`view=summary` 一行简介，`view=page` 完整表单 + 保存条 |

`codewiki_generate` 关键行为：

- `scope=auto`（默认）：无 wiki / 未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告。
- 全部模型环节（写文章/横切/审校）在插件内跑，共用 `batchProvider`/`batchModel` 一个模型；不再委托发起会话的主模型。
- 单篇文章失败只记账不中断；**只要有任何必需文章没写成、有未映射变更、或质量闸门拦下文章，终态就是 `partial` 而不是 `done`**，此时不刷新编译基线（`meta update` 不执行，可安全重试）；只有「所有变更都已被解释 + 所有必需文章都成功 + 索引与质量检查全过」才 `done` 并推进基线。
- 请求并发分两档独立限流：默认档 `maxConcurrency` 默认 2（硬顶 8），大档 `bigConcurrency` 默认跟随默认档（`0`）；两池同时推进，总在飞为两者之和。
- `serialProjects` 默认开：同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued` 排队，前一个收尾后自动轮到。
- `scope=full`：跳过 clean 短路，即使 wiki 最新也强制全量重编。

## 增量与质量保证（0.14.0）

这一层是「修复已审计确认的三类缺陷」的直接产物，全部在本插件内用 Node 实现，不引入 Python。

### 变更采集：不再只看提交

旧实现的过期判定只跑 `git diff <last_compiled_commit>..HEAD`，**工作区里没提交的改动完全不参与**——改完源码没 commit 就编译，wiki 会报「最新」并把这些改动永久漏掉。

现在 `lib/change-set.js` 的 `collectChangeSet(cwd, baseCommit)` 一次采集四路：`git diff <base>..<HEAD>`（已提交）、`git diff --cached HEAD`（已暂存）、`git diff`（未暂存）、`git ls-files --others --exclude-standard`（未跟踪），并识别 `D` 删除与 `R` 改名。规范化成仓库相对 POSIX 路径，`.codewiki/` 自身产物不计入源码变更（但 `README.md`/`CHANGELOG.md`/`CodeWiki.md` 这些被文章引用的文档仍是合法 source）。

取不到基线（非 git 仓库、基线 commit 不可达、git 出错）时**明确退回全量**并记原因，不会假装「干净」。

### 增量判定：符号级在原生引擎，文件级在兼容通道

原生通道的符号级/依赖级增量由上游 `updater/graph_diff.py` 完成，能力边界见「编译流水线：吸收自 FSoft CodeWiki」。**0.16.0 阶段 7 起本仓不再维护 Node 侧的增量 planner**（`lib/update-planner.js`、`lib/graph-diff.js`、`lib/incremental.js`、`lib/symbols.js` 均已删除）。

`nativeEngine:false` 的兼容通道只剩下**文件级归属判定**（`index.js` 内的 `attributeChanges`）：

- 变更集里每个源码路径，只要被某篇既有文章的 `source_files` 认领（或它是一次 `git mv` 改名的源路径），就算「已消化」。
- 需要重写的文章 = 「`source_files` 命中变更的文章」∪「`cw status` 报出的过期文章」。
- 有变更没有任何文章认领时**不推进基线**，并在 `blockers` 里列出来，下次编译还会重新看见它们——不会把没读懂的变化永久基线化。
- 没有符号图、没有 `module-map.json`、没有反向依赖闭包：改一个被 10 篇引用的函数，兼容通道只会重写直接认领它的那一篇。**这是退役带来的已知能力损失**，需要符号级增量请用原生通道。

### 终态诚实：`partial` 不是 `done`

`done` 现在只表示「完整成功」。以下任一情况终态为 `partial`（附 `blockers` 逐条原因），并且**不执行 `meta update`**，下次编译还会重新处理这些变化：

- 计划内必需的文章缺失或写作失败（旧实现只看 `writtenCount === 0`，1 篇成功 + 19 篇失败照样 `done` + 推进基线）；
- 有变更没被任何文章解释（未映射）；
- 文章质量闸门拦下文章；
- 存量文章体检发现坏文章。

每次编译都写 `.codewiki/temp/update-record.json`：基线/HEAD、每篇 action + 原因、变更统计、未映射变更、质量问题、最终结果。job 只存摘要与该记录路径，不把整张图塞进 jobs 文件。

### 文章契约闸门

`lib/article-contract.js` 的 `inspectArticle()` 是纯函数，接在**所有写盘点**上（单轮通道、校对回写、agentic 通道），不再只查 frontmatter 开合：

- frontmatter 必须唯一且闭合，`title`/`type`/`source_files`/`tags` 齐全，`type` 与所在目录一致；
- 正文不能再次出现 frontmatter，代码围栏必须闭合，不允许重复章节/重复正文块；
- 必需章节不能是空标题；
- `source_files` 必须是仓库内真实存在、且来自本次实际读取证据的文件；
- 内部 wiki 链接必须指向存在的文章。

`error` 级问题一律不落盘（记 note 并计入终态阻塞）；`warning` 级（缺非必需章节）放行但记账。agentic 通道另有 **write-set 闸门**：父任务只能写自己那一篇、子模块只能写调度器分配的那条路径，越界返回 `stopReason='write-set'` 且不落盘。


## 原生引擎通道（0.15.0，可选，默认关闭）

上面那一整套是 Node 重写版。0.15.0 另加一条**直接驱动上游 Python 引擎**的通道：把
[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 装进一个独立 venv，
用它的 `backend` 抽象跑依赖图 / 模块树 / 增量裁决 / 文章写作，插件只做四件事：

| 环节 | 本插件负责 | 上游负责 |
|------|-----------|---------|
| 环境 | `doctor` 探针：python 版本 + `codewiki` 可导入 + `pip check` 闭合；指纹（含上游锁 commit）落 `.codewiki/engine-lock.json`，drift 直接 `engine-deps` 失败（**不自动 pip install**） | 版本自报（真实验收用 `codewiki.__version__ = 2.0.0`，上游锁 commit `03d0a294ad58f3c878bd8aeb0ef5e95a2ff8c3ca` 的源码树） |
| 模型 | `lib/engine/llm-bridge.js` 在 `127.0.0.1` 上起一个 OpenAI 兼容端点，把宿主的 `ctx.llm.stream` 转成上游要的 `/v1/chat/completions`；上游只拿到 loopback URL + 占位 key | 用它自己的 prompt 与工具循环调模型 |
| 质量 | `lib/engine/quality-gate.js` 逐篇体检（source_files 存在性、空证据、死链、frontmatter）+ 基线判定；终态四态 `done`/`partial`/`failed`/`cancelled` | 产出 docs 目录（`module_tree.json` / `metadata.json` / `*.md` / `update_record.json`） |
| 落地 | `lib/engine/apply-plan.js`：写集封闭（只 `.codewiki/` 与根 `CodeWiki.md`）、pre-image 回滚、`cw index`、`cw meta update`、分支式自动提交、提交范围反查 | 不碰仓库 |

### 运行要求（这是与 Node 通道最大的差别）

1. **Python 3.10+ 独立 venv**，且 `python -m pip check` 必须零破损。上游的依赖集
   （`openai` / `pydantic-ai-slim` / `pydantic` 的约束互相打架）正常解析必然
   `ResolutionImpossible`，只能用锁定的 constraints 装——见
   `tools/fsoft-engine/setup-env.sh` 与同目录的 `constraints.txt`（故意 `--no-deps -c`）。
2. `nativeEnginePython` 指向那个 venv 的解释器（**绝对路径**；留空则读环境变量
   `DSH_CODEWIKI_PYTHON`，再退到 `python`）。插件**不做**「找一个能用的解释器」的
   启发式——猜错会把「环境不闭合」伪装成「引擎坏了」。
3. Windows 上非 ASCII 仓库路径必须能正确进出子进程（0.15.0 修过两处：入口 stdin 按
   locale 解码、上游内部 `text=True` 子进程按 gbk 解码 UTF-8 路径会拿到 `stdout=None`）。

### 设置

| 键 | 默认 | 说明 |
|----|------|------|
| `nativeEngine` | `true` | 编译通道。`true`（默认，0.16.0 起）= 原生引擎裁决全流程；`false` = 兼容通道（插件内 Node 流水线，仅按顶层目录分组 + 文件级归属判定） |
| `nativeEnginePython` | 空 | venv 解释器绝对路径；空 → `DSH_CODEWIKI_PYTHON` → `python` |
| `nativeEngineEntry` | `lib/engine/python/entry.py` | 入口脚本，一般不用改 |
| `nativeEngineTimeoutMs` | `2700000`（45 分钟） | 单次引擎调用上限，超时按 `failed` 记并杀进程树 |

模型侧不新增设置：复用 `batchProvider` / `batchModel`（聚类与写文章都用它），经上面的
llm bridge 转发。

### 真实验收记录（0.15.0）

用真实 venv（Python 3.12.10、`codewiki 2.0.0`、`pip check` 零破损）+ 真实 `workbuddy`
凭证（经 llm bridge）跑完整生产链路（`codewiki_generate` 工具 → JobService →
`runNativeJob`），fixture 是仓库内 `tools/fsoft-engine/fixtures/中文 空格 fixture` 的
临时 git 副本。八个场景的实际结果：

| 场景 | 结果 |
|------|------|
| 全量编译（8 场景中的 6.1） | **done**，241s，written 13，提交范围校验 `ok:true`，工作区干净 |
| 已提交改动的 stale 增量 | **done**，10.7s（约为全量的 4%），written 9 |
| 工作区有未提交改动 | **partial**（正确）：把四路改动合成临时 commit 交给引擎（`workspaceSnapshot`，不挂 ref），产物与内容对齐；`uncommitted-input` 记账、基线不推进、文章照写 |
| 重命名文件（`git mv` + 类改名） | **done**，增量识别 3 条变化，新增/重写模块页 |
| 删除模块 | **done**，孤儿页在同一提交里被清理（见下） |
| 取消（面板 `/api/codewiki/control`） | **cancelled**，基线不推进，HEAD 不变 |
| 引擎路径不存在 | **failed**（stage=env），错误原样带出 |
| 无变化轮（连跑两轮） | **done 且零副作用**：`written 0`、`commit.noChanges:true`、HEAD 不变、工作区空 |

### 真实验收中修掉的缺陷（都是假引擎测不出来的）

1. **非 ASCII 路径被误判越界**：`git show/diff --name-only` 默认 `core.quotepath=true`，
   中文路径输出成八进制转义串，提交范围校验按字面量判 `.codewiki/` 前缀失败 → 每次编译
   都被拉成 `partial`。修法 `lib/git-paths.js`：所有读路径的 git 调用加
   `-c core.quotepath=false`，并解码历史/外部传入的转义串。
2. **引擎锁不在提交里**：`writeLock` 在 apply 之后写盘，锁永远落在提交外，下一轮变成
   未跟踪脏文件（无变化轮也会因此产生提交）。改成与产物同批进写集（同一 pre-image、
   同一回滚、同一提交）。
3. **更新记录不在提交里**：原生通道的 apply 内部已提交，`saveRecord` 必然晚于提交 →
   每轮留 `?? .codewiki/temp/update-record.json`。原生通道改为写到仓库外
   （`$TMPDIR/dsh-codewiki-native-records/<jobId>/`），面板仍能读到路径。
4. **协议字段位置不一致**：插件按平铺发 `{requestId, action, ...payload}`，入口只读
   `msg.payload` → `docsDir` 丢失，引擎回退写进仓库 `.codewiki`，增量轮把受管状态水合成
   `_native-state/docs/_native-state/docs/...` 逐轮自嵌套。入口改为两种形状都认。
5. **入口 stdin 按 locale 解码**：客户端按 UTF-8 写请求行，Windows Python stdin 默认
   cp936 → 中文路径必坏（`仓库路径不存在：...涓?鏂?...`）。入口把 stdin 也钉成 UTF-8。
6. **上游内部子进程按 locale 解码**：`text=True` 下 gbk 解 UTF-8 路径会让 reader 线程
   抛 `UnicodeDecodeError`、`stdout` 变 `None`，上游 `repo_analyzer.py:65` 直接
   `AttributeError`。入口在 import 后给 `Popen.__init__` 补 UTF-8 编码兜底。
7. **无变化轮仍产生提交**：上游把 `.codewiki/_meta.yaml` 当源码组件分析，图 diff 永远
   非空 → 永远 `incremental`，每轮一笔纯记账提交。入口给依赖分析传
   `agent_instructions.exclude_patterns = ['.codewiki', 'CodeWiki.md']`（实测扫描面 24 个
   文件 → 4 个，wiki 产物命中 0）。
8. **删除模块后孤儿页残留**：gate 只体检**本次产物**，而删除时上游可能回
   `full_fallback` + `pages_removed: []`，不告诉我们哪篇该消失 → 描述已删代码的页永久
   留在库里、还挂在 `_index.md` 上。新增 `findOrphanPages()`（source_files 非空且**全部**
   失效才判孤儿，空 source_files 与部分失效一律不删）+ `applyNativeOutput({deleteFiles})`
   走落地事务（同 pre-image、同回滚、同提交）。

### 已知限制（如实记录）

- 真实模型侧用 `workbuddy/glm-5.3` 完成验收：`workbuddy/hy3` 当期返回
  `429 quota_exceeded`（“您的使用量已超出频率限制，将在 2026-10-29 14:23:38 UTC+8 重置”）。
  这是上游配额，不是适配层问题。**规格的 hy3 硬门禁因此没有通过**：换额度可用后必须把
  `batchModel` 改回 `hy3` 重跑八场景，才算闭环；在那之前这里是「替代验证」而非「符合规格」。
- `node test-wiki-anchors.mjs --strict` 实测 **3354 过 / 59 败 / 32 待重编译**（默认档
  3354 过 / 5 败 / 86 待重编译）。59 条失败里 34 条「指向空行」（`test-engine-apply-plan.mjs`
  26 条、`index.js` 8 条、`README.md` 6 条）、20 条「符号未绑定」（`idleRound`/
  `symbolIncremental`/`runEngine`/`normalizeIndexLinks` 等不在所引区间内）、4 条
  「符号不存在」、1 条「起始行越界」。**主体是 `.codewiki/` 文章滞后于本轮代码**，
  不是校验器缺陷；按纪律不手改文章，留待一次真实全量重编译覆盖。
- **阶段 7 受控退役已执行**（0.16.0）：`nativeEngine` 默认 `true`；`lib/symbols.js`、
  `lib/cluster.js`、`lib/graph-diff.js`、`lib/incremental.js`、`lib/update-planner.js`
  与对应 7 套测试已删除。已知能力损失：兼容通道失去符号级增量与语义聚类（都只剩最小
  文件级/目录级判定），`planMode` 与 `symbolIncremental` 两个开关**保留但已无实际效果**
  （仅为兼容既有 `settings.json` 而存在）。
- `doctor` 的 `engine.deps.ok` 在真机上恒为 `false`（该字段不带 `pip check` 明细，指纹
  也刻意不含它）；判定以 `engineLock.status === 'match'` 为准。
- 上游 rung3 增量语义：**单模块内的方法级新增**通常不触发重写（component id 不在
  tracked 集 → `untracked` → 不进 ownership）。要验增量真的改了文章，得用结构性变化
  （新增/删除/重命名文件或模块）。
- `.codewiki/modules/` 的孤儿页清理只在**本轮真的落地**时执行；无变化轮不扫不删。

### 阶段 7 受控退役（0.16.0 已执行）

0.15.0 曾决定「两条通道都保留、`nativeEngine` 默认 `false`」，理由是要留住回退路径并且
符号级增量只有 Node 侧实现。**0.16.0 推翻了这个决定**，用户明确指示「可以删除」，于是：

**切了默认值。** `nativeEngine` 默认 `true`，`codewiki_generate` / 面板 / Web API 的
编译默认全交给原生引擎。

**删了被替代的实现。** 同一套算法（符号提取、聚类、图 diff、增量裁决、更新规划）在
Node 侧维护一份、Python 侧再由上游维护一份，等于每次算法演进都要改两处、验证两遍。

| 删除的模块 | 被谁替代 |
| --- | --- |
| `lib/symbols.js`（AST 符号提取，884 行） | 原生引擎 Python 侧的符号图 |
| `lib/cluster.js`（LLM 语义聚类，467 行） | 原生引擎的模块树构建 |
| `lib/graph-diff.js`（符号级 diff，578 行） | 上游 `updater/graph_diff.py` |
| `lib/incremental.js`（快照与增量折算，206 行） | 原生引擎的增量裁决 |
| `lib/update-planner.js`（更新规划，492 行） | 原生引擎的 ownership/stale scan |

连带删除 7 套测试（`test-symbols` / `test-cluster` / `test-graphdiff` / `test-incremental`
/ `test-incremental-e2e` / `test-update-planner` / `test-semantic-plan`）。

**保留了什么。** `lib/agentic.js` / `lib/agentic-host.js` / `lib/articles-agentic.js`
（agentic 写作通道，兼容通道仍在用）、`lib/article-contract.js`（文章契约，两条通道共用）、
`lib/change-set.js`（四路变更采集，两条通道共用）、`lib/update-record.js`（更新记录）、
`lib/git-paths.js`、`lib/engine/`（原生引擎适配层，全部保留）。

**代价，如实记录。** `nativeEngine:false` 从「功能对等的第二套实现」降级为「最小兼容
通道」：只按顶层目录分组、只做文件级归属判定，没有反向依赖闭包、没有纯注释跳过、没有
新文件 ownership 路由。本机装不了 Python 依赖时它还能出文章，但质量与省时都不如原生通道。

## 编译流水线：吸收自 FSoft CodeWiki（0.13.0）

[mraza007/codewiki](https://github.com/mraza007/codewiki) 提供的是 Rust CLI 骨架（`status`/`init`/`index`/`meta update` + 文件级状态判定），**不含**「怎么划分模块」与「文章怎么写」这两件真正决定 wiki 质量的事。插件原先自己补的是最省事的两刀：模块清单按顶层目录分组（`localPlan`），每篇把源码整包内联进一个 prompt 写一次。[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（ACL 2026，MIT）在这两处都做了工程化实现，0.13.0 把它的三层能力移植进来（Python 原版留在 `vendor/` 之外，不引入运行时）：

| 层 | 上游做法 | 本插件实现 | 不可用时 |
|----|----------|-----------|----------|
| 符号提取 | `tree-sitter` 原生绑定，逐语言 analyzer 提取函数/类/方法 + 调用关系（约 800 行/语言） | ~~`lib/symbols.js`~~（**0.16.0 已删**，由原生引擎直接承担）：**表驱动** `LANG_RULES`，web-tree-sitter + WASM 语法，16 种语言（js/ts/py/rs/go/java/c/cpp/c#/rb/php/kotlin/scala/dart/bash/lua），产出 `Map<id, {name,kind,parameters,baseClasses,dependsOn,bodyHash,sourceCode}>` | 该语言退回正则级符号（`REGEX_RULES` + `regexExtract`，16 种语言表驱动，命中数记 `stats.regex`），不影响其它语言 |
| 模块划分 | `cluster_modules.py`：LLM 两阶段聚类 + 递归下钻 + super-group 合并 | ~~`lib/cluster.js`~~（**0.16.0 已删**，由原生引擎直接承担）：同样的两阶段（先按组件职责聚类，再对超大模块递归下钻）+ `heuristicCluster` 兜底（单顶层目录时自动下探到第二层） | 模型请求失败 → 直接退回 `localPlan` 顶层目录分组，并记 note |
| 写文章 | module agent 工具循环：模型自己 `read_code`/`list_files`/`edit_article`/`generate_sub_module`，多轮增量写作 | `lib/agentic.js`（纯逻辑循环）+ `lib/agentic-host.js`（接宿主 llm）+ `lib/articles-agentic.js`（接 job 生命周期）：工具 `read_code`/`list_files`/`edit_article`（`view`/`str_replace`/`insert` 三种命令）/`generate_sub_module`（递归派生子模块成文），单篇步数上限 `agenticMaxSteps`；0.14.0 起带 write-set 闸门（父文只准写自己那篇、子模块只准写调度器分配的路径） | 单篇失败只记账；失败率过半时自动退回单轮整包装填通道重跑 |
| 增量判定 | `updater/graph_diff.py`：组件级 hash + 签名比对，区分 interface/added/deleted/renamed/body/edge；updater 另有 ownership/stale scan/update record | 原生通道直接用上游实现。Node 侧的 ~~`lib/graph-diff.js`~~ + ~~`lib/incremental.js`~~ + ~~`lib/update-planner.js`~~ **已于 0.16.0 删除**；仍保留 `lib/change-set.js`（四路变更采集）与 `lib/update-record.js`（可机读更新记录），兼容通道用它们做文件级归属判定 | 兼容通道（`nativeEngine:false`）退回文件级判定，无符号级能力 |

三个开关（设置页「编译流程（吸收自 FSoft CodeWiki）」一节，也可在 `cordis.patch.yml`/profile patch 里改）：`planMode`（`auto`/`dirs`）、`agenticArticles`（+ `agenticMaxSteps`）、`symbolIncremental`。**0.16.0 起 `planMode` 与 `symbolIncremental` 已失去实际效果**（对应实现在阶段 7 删除，字段仅为兼容既有 `settings.json` 保留）；`agenticArticles` 仍对兼容通道生效。

子模块成文（0.13.1 起真的生效）：模型写作时若发现模块内有一整块子能力值得单独成文（通常 ≥3 个组件、有自己的职责边界），可调 `generate_sub_module` 把它派出去，插件递归跑一次写作并落到 `<wiki>/modules/<父模块>/<子模块>.md`，父文章里只留概述与链接。递归深度默认封顶 2 层（`subDepth`），子模块名全局去重（重名加父前缀，仍重则跳过），子模块失败只记账、不影响父文章。

AST 能力曾依赖 `vendor/tree-sitter/`（`web-tree-sitter` + `tree-sitter-wasms`，56MB）。**0.16.0 阶段 7 起插件内不再有 AST 消费者**（`lib/symbols.js` 已删），该目录下只剩历史记录，不再需要 `npm i`；原生通道用 Python 侧的 tree-sitter。

## 设置（插件行 config，命名空间 `codewiki`）

上述设置同样可在 **插件页 → CodeWiki 详情页**（`client.js`，v0.2.0 起）里修改：保存走 `configForms.mutate`（单层 op），与 patch 文件里手改等价、同样热生效。0.9.1 起「编译模型」是 provider/model 两级下拉：目录来自插件自己的 `/api/codewiki/models`（同源宿主 `llm.listProviders` + 各 provider 的 `listModels`，即模型设置页里已注册的提供商），不读插件配置；目录不可用时退化为文本输入，仍可填任意 provider/model。0.10.0 起「思考程度」也改为从模型目录读取——选中 provider/model 后拉 `/api/codewiki/model-efforts`（宿主 `resolveModel().reasoning.efforts`）渲染下拉，不再手填裸字符串。


- `batchProvider` / `batchModel`（0.10.0，0.10.1 起为唯一通道）：编译模型（规划/写文章/横切/审校全部环节共用），默认 `workbuddy` / `hy3`（免费、192k 上下文），走宿主 llm 服务。`batchModel` 填该 provider 的模型 id——本地 OpenAI 兼容端点（如本地 9B）只要在模型设置里注册过，就能在这里选到并参与编译。**0.10.1 删除了内置百炼直连通道**：`batchProvider` 必须指向模型设置里已注册的提供商，留空直接提交失败（不再有自带直连兜底，插件也不保存任何 API Key）。
- `batchReasoningEffort`（0.10.0）：该模型的思考程度档位 id。**可选值不手填**，设置页从模型目录实时读取（`GET /api/codewiki/model-efforts?provider=&model=` → 宿主 `resolveModel().reasoning.efforts`）；留空 = 用该模型的默认档。
- `bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`（0.10.4，0.10.8 全面启用）：大档模型——输入超 110k 普通预算的请求（写文章/横切/批量校对）改用该档在插件内一次写完。默认 `volces-ark` / `glm-5.3-flash`（512k 上下文），预算 420k token。`bigProvider` 留空=不启用大档。0.10.8 起大档同时是观察→合成分割的门槛：模块源码总量超 420k 才拆观察批。
- `sessionTier`（0.9.2）：**仅超大输入兜底**时才用。0.10.8 起装填上限=大档预算（`bigTokenBudget`，默认 420k）：文章源码总量在 110k–420k 区间直接大档单请求写完；超 420k 才拆观察→合成批；只有连大档都装不下的单文件才转会话通道，此时派给哪个子智能体档位（`dsh-subagent-auto-router` 里的档位 id，如 `codeiwiki`）。留空 = 让会话模型自动选路；填了则 steer 文本要求 `delegate` 显式传 `tier`。

- `nativeEngine` / `nativeEnginePython` / `nativeEngineEntry` / `nativeEngineTimeoutMs`（0.15.0 引入，**0.16.0 起 `nativeEngine` 默认 `true`**）：原生引擎通道；需要本机 Python 3.10+ 与闭合依赖环境。详细要求见上文「原生引擎通道」。
- `binaryPath`：cw 可执行路径；留空优先用 PATH 里的 `cw`（与 codewiki 源码同步演进），找不到再用插件自带 `bin/cw.exe`。0.2.3 起此顺序（原先捆绑优先，会吃到过期的旧布局二进制）。
- `maxConcurrency`（0.12.2 起语义收窄为**默认档**）：默认档（`batchModel`，如免费 hy3）请求并发上限，默认 2（1–8，硬顶 8）。
- `bigConcurrency`（0.12.2）：大档（`bigModel`）请求并发上限（1–8，硬顶 8）；`0`/留空 = 跟随 `maxConcurrency`（等价 0.12.1 的单一池行为）。两档各自独立计数、**同时推进**——大档常是付费长上下文档、与免费默认档配额互不相干，共用一个上限会让「大档只多几个请求」把默认档全堵住；代价是总在飞请求数最高可达两者之和，上游限流时把其中一个调小。
- `serialProjects`（0.10.0）：单项目串行，默认开。开启后同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued`，前一个收尾后自动轮到——避免多项目同时编译抢占同一个免费额度。
- `articleLanguage`：文章语言，默认中文。
- `planMode`（0.13.0，**0.16.0 起已无实际效果**）：语义聚类的实现在阶段 7 删除，兼容通道一律按顶层目录分组（等价于 `dirs`）。字段保留仅为兼容既有 `settings.json`，改它不会改变行为。
- `agenticArticles`（0.13.0，默认开）：文章写作走 agentic 工具循环——模型在写作过程中自己 `read_code` 读指定文件的指定行、`list_files` 找文件、`edit_article` 增量改写，不再把整个模块源码内联进单个 prompt。好处：prompt 小（不再触发 110k/420k 装填分级）、可以多轮回看精修、大文件不必拆观察批。0.13.2 起该通道也走双池并发：模块源文本量超 `bigTokenBudget` 的任务打 `bigTier` 标记走大档（`bigProvider`/`bigModel`），其余走默认档。关闭则走单轮整包装填的旧通道。0.13.3 起 `read_code` 带重复读抑制：模型反复读同一段（真实运行里出现过同一文件读 13 次）时不再回吐正文，只提示「你已经在第 N 步读过这段」，去重判定发生在读盘之前；同一探针实测重复读 12 → 5 次、上下文 2144 → 1413KB、步数 45 → 17，`stopReason` 由 `max-steps` 变为 `finished`。0.13.4 起工具层补齐四个翻车点：`str_replace`/`insert` 按行尾归一化匹配（仓库 `core.autocrlf=true`，`.codewiki` 下 28/36 篇是 CRLF，跨行替换原先必然失败且模型会反复重试到步数耗尽）；子模块到嵌套上限时不再谎称「已记录」而是报错并要求写成普通小节（原先会产出指向不存在文件的死链、父任务仍记 `ok:true`）；`read_code` 加 40000 字符上限（原先单行超长文件一次可灌 5.7 万 token）；`list_files` 隐藏 `node_modules`/`.git` 等目录。
- `agenticMaxSteps`（0.13.0，默认 30，1–100）：单篇文章最多允许几轮「读源码 → 改文章」。到上限会强制收尾（写回当前文章并记 note）。
- `symbolIncremental`（0.13.0，**0.16.0 起已无实际效果**）：符号级增量的实现（`lib/graph-diff.js` + `lib/incremental.js`）在阶段 7 删除，兼容通道统一按 `source_files` 归属做文件级判定；符号级增量请用原生通道（由上游 `graph_diff.py` 承担）。字段保留仅为兼容既有 `settings.json`。
- `updateReminder`：会话系统提示注入 wiki 维护提醒，默认开。仅当会话仓库根存在 wiki 入口 `CodeWiki.md` 时出现（text 回调每次组装求值，实时判断；判定不看 `.codewiki/` 目录——只有空骨架目录时提醒会指向读不到的入口）；提醒内容：收尾必须调用 `codewiki_generate` 更新 wiki（learnings/decisions 补文章与索引刷新由流水线完成，不要手工编写/修改 `.codewiki/` 下的文章——手改不进流水线、不被面板记录，会被下次编译覆盖）；`codewiki_generate` 是后台编译，调用即返回、调用后本步收尾，不要等待/轮询；产物由插件自动提交（见下一条）。0.2.5 起。0.10.9 起同一 section 只兼职**降级**提醒：最近一次成功编译的完成时间晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交 → 注入「产物待提交」（并写明自动提交为何没成功），一次性、不催促（时间戳派生自 jobs 文件与 `git log`，插件提交后自动静默，零持久状态）。0.8.0 起编译终态另有实时唤醒：工具调用会话（exec.agent）在编译 failed、或 done 但自动提交失败时收到 steer 消息（与子代理 send_message 同机制），**自动提交成功或产物本就无改动时完全不打扰会话**，面板/自动调度提交与冷会话静默跳过。
- `autoCommit`（0.10.9，0.10.10 修正文档与三态）：编译产物自动提交，默认开。编译终态（done 且有文章写成功）后由插件自己 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（信息前缀 `docs(wiki):`，带任务 id 与篇数），把「等编译完成 → 会话模型代跑 git」这件事彻底收回插件侧——会话模型因此不必等待编译、不必轮询、不必提交。安全边界：改动由 pathspec 限定在这两个路径（不是 `-A`/`--all`/`.`，因此不会卷进工作区其它改动）、不 amend/push/改写历史、不跑仓库钩子；以下情形一律**拒绝并降级**为一次性「产物待提交」提醒（不会半个提交、不会静默丢产物）：非 git 仓库、仓库无 HEAD、merge/rebase/cherry-pick 进行中、目标路径存在未解决冲突、`.codewiki/`（或未 tracked 的 `CodeWiki.md`）被 `.gitignore` 忽略、缺 `user.name`/`user.email`、`git add`/`git commit` 失败（含 `index.lock` 被并发占用）。结果写入 job 的 `autoCommit`（`committed`/`sha`/`message`/`reason`/`noChanges`），`codewiki_progress` 输出与侧边栏任务卡直接显示；三条通道（唤醒、系统提示提醒、面板）统一按 `autoCommitState()` 判定三态：已提交 → 静默、产物无改动 → 静默不催、未提交 → 才提醒一次。
- `autoUpdate` / `autoUpdateMin`（0.4.0 引入，0.16.2 修正扫描来源）：自动更新默认关；开启后服务每 60s 心跳一次，距上次扫描超过扫描间隔（`autoUpdateMin`，默认 30 分钟，最小 5）时逐仓 `scope=auto` 判态提交（被排除目录、worktree、空壳目录静默跳过），单仓失败只记 `lastError` 不中断。**0.16.2 起扫描来源是「已知仓库清单 ∪ 任务历史」**（`REPOS_FILE`，`rememberRepo()` 在每次提交时写入）：只扫任务历史会让「编译过一次、后来没再手动编译」的仓库在 job 被 `MAX_JOBS_KEPT=30` 截断或 Temp 终态启动清理后永久退出自动扫描——面板仍显示过期，却永远等不到自动编译。心跳间隔可用环境变量 `DSH_CODEWIKI_AUTO_SCAN_MS` 覆盖（下限 100ms，仅用于测试；生产别设）。
- 所有设置 `volatile`，改完即生效（execute 时解包读取），无需重启。

## 安装（本地 file:/// 直挂）

本插件遵循「本地插件源码公约」，但用 router 式 file:/// 挂载，**不需要** profile package.json/`link:` 条目：

1. 源码放 `E:\ik\Documents\trae_projects\1\dsh plugin\dsh-codewiki`（本目录）。
2. `profiles/web/cordis.patch.yml` 顶层追加：

   ```yaml
   - insert:
       - id: codewiki
         name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js
         config: {}
   ```

3. 依赖解析：插件在 profile node_modules 之外，`@deepseek-ai/schemastery`（仅 Config 用）走插件本地 junction → `/e/software/deepseek-harness/vendor/schemastery`（已建，`node_modules/@deepseek-ai/schemastery`）。工具/子代理全走注入服务，零 dsh-* import。
4. 重启 dsh 生效。客户端半侧（设置页）由包声明驱动：`package.json` 里 `dsh.client.platform: "web"` + `exports["./client"]`，宿主 client 扫描器沿 file:/// 条目找到本包后自动把 `client.js` 送进浏览器——同样需要一次重启（「非 client 包」判定按条目缓存到重启为止）。

## 开发

```
vendor/codewiki/   上游源码（去除 .git）
bin/cw.exe         cargo build --release 产物（git 内跟踪，改了 vendor 记得重编）
client.js          插件页设置卡片（浏览器半侧；协议参照 ui-settings-agent-loop / router client.js）
```

验证：`node --check index.js client.js`；编排冒烟 `node test-orchestration.mjs`（mock 子代理 + 真实 cw CLI）；CLI 冒烟见 CHANGELOG 0.1.0；设置页需重启 dsh 后在插件页实测。

全量测试（28 个文件，都直接 `node <file>`，无框架；0.16.0 阶段 7 后逐个实跑，27 套全绿）：

```
test-agentic.mjs / test-agentic-host.mjs / test-agentic-fallback.mjs / test-articles-agentic.mjs
test-article-contract.mjs / test-change-set.mjs / test-update-record.mjs / test-batch.mjs
test-prune-orphans.mjs / test-orchestration.mjs / test-sessions.mjs / test-worktree.mjs
test-cwd-paths.mjs / test-wiki-entry.mjs / test-wiki-anchors.mjs

# 原生引擎通道（0.15.0）
test-engine-contract.mjs / test-engine-client.mjs / test-engine-manifest.mjs
test-engine-python-entry.mjs / test-engine-output.mjs / test-engine-output-real.mjs
test-engine-quality-gate.mjs / test-engine-apply-plan.mjs / test-engine-bridge.mjs
test-engine-llm-bridge.mjs / test-engine-native-job.mjs
test-engine-native-incremental.mjs / test-engine-process-tree.mjs
```

测试用假引擎（`test-fixtures/fake-native-engine.mjs`）走真实子进程协议，所以能覆盖协议
契约、终态裁决、落地不变量与受管状态；但它**读的是平铺字段、自报 `no_change`**，因此
上面第 4、7 条那类「只有真实引擎才暴露」的缺陷它一条都测不出来——真实验收必须跑真引擎。

`test-wiki-anchors.mjs` 校验 `.codewiki/` 里所有 `file:行号` 锚点是否指向真实代码，分两档：

- **默认档**：结构事实（行号越界、区间倒序）永远硬断言；**符号绑定**按新鲜度分档——源文件自编译基线（`.codewiki/_meta.yaml` 的 `last_compiled_commit`）以来没变则硬断言，变了则记为「待重编译」不计失败（文档这时候本来就该滞后，跑一次 `codewiki_generate` 基线前移后自动升级为硬断言）。
- **`--strict` 档**：符号绑定一律硬断言，用于发版前自查。0.15.0 实测：默认档
  `2196 过 / 8 败 / 55 待重编译`，`--strict` 下失败数显著更多——全部是**文档滞后**
  （`README.md` 行号漂移、`.codewiki/modules/lib.md:518` 引用了 `client.js:223` 的
  `runEngine`，而该符号在 client.js 里根本不存在），不是代码错误。这些必须由一次真实
  全量重编译重写，**不手工改文章绕过**。

