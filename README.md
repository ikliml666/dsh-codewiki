# dsh-codewiki

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-topic-blue)](https://github.com/topics/dsh-plugin)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的仓库级代码 wiki。** 一条命令把整个仓库编译成 `<repo>/.codewiki/` 下的一组互相链接的 Markdown 文章（模块、架构、关键流程），随仓库一起提交、和团队共享；侧边栏面板里能看任务进度、翻引擎日志、改编译模型与并发。

它做三件别的地方不好做的事：

- **不是一次性文档生成器，而是可增量的编译器**：下一轮只重写接口真变了的模块，基线（`last_compiled_commit`）只有整轮干净成功才推进，没消化完的轮次不会把变化记成已消化。
- **终态诚实**：`done` / `partial` / `failed` / `cancelled` 四态，`partial` 会在面板上写明是哪一条没满足，不会拿「生成了文件」冒充成功。
- **坏文章不入库**：所有写盘产物先过文章契约闸门（frontmatter 完整性、必填字段、`source_files` 是否指向真实文件、章节重复、死链），不合格的页不落盘、不推进基线。

> 默认通道驱动上游 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 的 Python 引擎（**需要本机有 Python 3.10+ 与闭合依赖环境**）；装不了 Python 依赖时可用内置 Node 兼容通道，但它只保留最小能力、不再接收新特性。

## English summary

A repository-level code-wiki compiler for DeepSeek Harness. It turns a whole repository into a set of cross-linked Markdown articles under `<repo>/.codewiki/`, committed alongside the code, with a sidebar panel for job progress, engine logs, and per-stage model settings. Incremental by design: only modules whose interfaces actually changed get rewritten, the baseline advances only on a fully clean run, and every page must pass an article contract gate before it reaches disk. The default channel drives the upstream FSoft-AI4Code/CodeWiki Python engine and requires a local Python 3.10+ venv with closed dependencies; a minimal built-in Node channel remains for environments where that is not possible. MIT licensed.

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：仓库内代码 wiki（`<repo>/.codewiki/`，随仓库提交共享）+ 智能体编排编译，支持为编译子代理指定模型。

**0.16.0 起默认通道是 FSoft 原生引擎**（`nativeEngine` 默认 `true`）：直接把上游 FSoft CodeWiki 的 Python 引擎当子进程驱动，由它做符号图、模块树、增量裁决与文章写作，插件这一侧只负责环境探测、模型桥、质量闸与落地事务。**这条通道需要本机有 Python 3.10+ 与闭合的依赖环境**（`tools/fsoft-engine/setup-env.sh`）。环境不闭合时以 `engine-deps` 明确失败，不会悄悄改走 Node 通道冒充成功。

**0.13.0 曾经在 Node 侧重写过一遍 FSoft 的三层能力**（AST 符号提取 `lib/symbols.js`、LLM 语义聚类 `lib/cluster.js`、符号级增量 `lib/graph-diff.js` + `lib/incremental.js` + `lib/update-planner.js`）。**这五个模块已在 0.16.0 阶段 7 受控退役中删除**——同一套算法维护两份没有意义。它们守护的行为现在由原生引擎在 Python 侧承担；`nativeEngine:false` 的兼容通道只保留按顶层目录分组 + 文件级 `source_files` 归属判定这两项最小能力。

**0.14.0 起补上「增量不丢、结果诚实、坏文章不入库」三层质量保证**（对应上游的 updater/ownership/完整性终态/write-set 与文章质量门）：变更采集覆盖工作区（未提交/已暂存/未跟踪/删除/改名），增量规划带反向依赖闭包与新文件 ownership，终态新增 `partial` 且只有完整成功才推进基线，所有写盘点统一走文章契约闸门。详见下文「增量与质量保证（0.14.0）」。

**0.17.0 起编译基线只有一个判据：`done`**（`baselineEligible`）。0.16.1 曾让「有产物的 `partial`」也推进基线来打破死循环，但那等于把「没消化完」记成已消化，与落地器的「`partial` 不推基线」直接冲突；真正的死循环来源是**首次编译**把本轮刚 `cw init` 出来的空骨架判成「未入库基线」，于是正常首编也只能 `partial`。现在空骨架（`worktree-only`/`git-head` 且无编译提交）判 `baseline-absent` 直接放行，首编能走成 `done`；`partial` 一律不推基线。同一版还补齐了**原生任务跨重启接管**、JobService 的原子持久化与跨实例幂等（详见「任务生命周期（0.17.0）」）。

**0.17.1 起原生引擎的过程可观测**：真实编译一轮写文章可能跑一个多小时（本仓库实测 99.6 分钟，`stageTimings.articles` 占 99.9%），而此前面板会把这段显示成「36%、聚合类模块」僵着不动、结束后也查不到日志。现在写文章阶段的百分比按「已写篇数 / 本轮起始 `.md` 篇数」推进、增量轮不再被错标成 `cluster`、引擎自报的 token 用量落进 `job.usage`、引擎事件逐条写进仓库外的 NDJSON 并可从面板与 `GET /api/codewiki/logs` 翻查。详见「引擎日志与进度可观测性（0.17.1）」。

**0.17.2 起原生编译支持隔离并行与跨重启断点续跑**：增量轮中互不写同一篇文章的叶子模块并行执行，真实写冲突按原顺序重跑，不把猜测的依赖关系当冲突。宿主异常退出后，新实例保留引擎现场；增量轮按叶子检查点只跑未完成项，全量轮复用已生成文章。代码变化导致签名漂移时检查点作废，依赖图、质量闸、状态采集与落地事务仍完整重跑。

**0.17.12 起全量轮也并行，并且缺页会被补上**：全量阶段按模块树并行跑代理（父页等子页、兄弟分支互不阻塞，`module_tree.json` 的写入走锁内合并，同路径 components 不一致直接报错），`moduleConcurrency` 现在是真正生效的旋钮。同时对齐上游的层级页路径口径：模块树里没有对应页的模块会触发**修复性全量**（复用已有页、只补缺的），而不是每轮照判 `article-missing` 恒 partial；质量门判据没有任何放宽。

**0.15.0 引入、0.16.0 转正的原生引擎通道**（`nativeEngine`，**0.16.0 起默认开启**）：装法见「原生引擎通道」。`nativeEngine:false` 仍然可用，是一条**兼容通道**（插件内 Node 流水线），只服务「本机装不了 Python 依赖」这一种场景，**不再接收新能力**；两条通道互不回退。

## 提供

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 提交制编译：cw status 判态 → 提交后台 job 立即返回 → 宿主常驻服务按 准备 → 文章 → 校验 → 索引 → 提交 推进（侧边栏 CodeWiki 面板可见；0.17.41 起语义校对不再单列一步，它是质量门死链检查的修复动作，归在「校验」里；0.13.0 起规划阶段默认走 AST 符号聚类，写作默认走 agentic 工具循环），全部模型环节在插件内完成（0.16.13 起默认 `volces-ark`/`glm-5.3-flash`，512k 上下文，单请求输入预算 110k；110k–420k 输入自动升大档单请求，0.10.8），常规路径不派子代理、不委托发起会话的主模型（0.10.0）；0.17.5 起写作只剩 agentic 工具循环一条通道（按需 `read_code` 读源码，不再整包内联），单篇体积不再触发观察→合成分割 |
| `codewiki_update` | 工具 | 日常维护入口（0.7.0 起）：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「本步收尾、继续下一项」，不要等待、不要轮询；编译产物由插件自动提交入库（0.10.9，`autoCommit`），**成功时不再唤醒会话**，只有自动提交失败才发一条一次性「产物待提交」降级提醒 |
| `codewiki_progress` | 工具 | 只读查编译进度：提交后随时查 stage/百分比/已写/失败篇数/失败原因，立即返回不等待（数据与侧边栏面板同源）。可选按 `cwd` 或 `jobId` 过滤，都不传列全部任务。0.14.0 起终态有四种：`done`（完整成功）/`partial`（部分完成，附 `blockers` 说明原因）/`failed`/`cancelled`。0.17.0 起另带 `baselineEligible`（质量门是否许可推进基线）与 `baselineAdvanced`（本轮基线**事实上**是否已前移）——提交失败时会看到 `baselineAdvanced:true` 而 `deliveryComplete:false`，两者口径不同 |
| CodeWiki 设置页 | 插件页 UI | 插件管理页 Official 组出现 CodeWiki 条目（id `codewiki`），点进详情页可改编译模型（provider/model 级联下拉，目录来自 modelCatalog）与运行选项；`view=summary` 一行简介，`view=page` 完整表单 + 保存条 |
| `codewiki_note` | 工具 | **0.17.49 起已下线**。0.17.43–0.17.48 存在过：把一次真修完的 bug 记成 `.codewiki/learnings/<slug>.md`、把已定的设计取舍记成 `.codewiki/decisions/<slug>.md`，都由模型在收尾时手写。下线原因：这两类页是唯一不受编译流水线管辖的内容，行号锚点会随源码漂移而失效（真机上两篇页积了 22 处失效锚点），而原生通道从来只产 `modules/` 与入口 `CodeWiki.md`。现在 wiki 内容全部由流水线产出，`learnings/`、`decisions/` 两个目录连同写入口一并移除 |

`codewiki_generate` 关键行为：

- `scope=auto`（默认）：无 wiki / 未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告。
- 全部模型环节（写文章/语义校对）在插件内跑，共用 `batchProvider`/`batchModel` 一个模型；不再委托发起会话的主模型。
- 单篇文章失败只记账不中断；**只要有任何必需文章没写成、有未映射变更、或质量闸门拦下文章，终态就是 `partial` 而不是 `done`**。基线推进的判据是**完整性**：`done` 才推进；`partial`/`failed`/`cancelled` 一律不动基线，未消化的变化下一轮还会被看见（0.16.1–0.16.16 曾按「`partial` 且有原始树留档就推进」实现，那是拿「有产物」冒充「消化完」；0.17.0 已改回单一判据，并用「空骨架不算未入库基线」解决首次编译原先必然 `partial` 的死循环）。
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

`done` 现在只表示「完整成功」。以下任一情况终态为 `partial`（附 `blockers` 逐条原因）。`partial` 一律不推进基线：写成的文章照常入库（下次不必重写），但「这一批变化已消化」这个事实不成立，下一轮从同一批变化继续 —— 这才是完整性终态的意义：

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


## 原生引擎通道（0.15.0 引入，0.16.0 起默认开启）

上面那一整套是 Node 重写版。0.15.0 另加一条**直接驱动上游 Python 引擎**的通道：把
[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 装进一个独立 venv，
用它的 `backend` 抽象跑依赖图 / 模块树 / 增量裁决 / 文章写作，插件只做四件事：

| 环节 | 本插件负责 | 上游负责 |
|------|-----------|---------|
| 环境 | `doctor` 探针：python 版本 + `codewiki` 可导入 + `pip check` 闭合；指纹（含上游锁 commit）落 `.codewiki/engine-lock.json`，drift 直接 `engine-deps` 失败（**不自动 pip install**） | 版本自报（真实验收用 `codewiki.__version__ = 2.0.0`，上游锁 commit `1b4af43d6d20c8dbd758fe1d5f888cc6947ed11d` 的源码树） |
| 源码面 | 排除清单交给上游 `RepoAnalyzer`：wiki 产物（`.codewiki`/`CodeWiki.md`）+ **孤立 gitlink**（0.16.4 起）。后者是被提交进索引（mode `160000`）却没有 `.gitmodules` 登记的嵌套仓库：它 tracked，所以 `use_gitignore=True` 拦不住；又永远 `checkout` 不出内容。实测一个 18MB 探针克隆因此被整个当源码分析，引擎撞 45 分钟超时被强杀、零产出。正规 submodule 不排除 | 按 `agent_instructions.exclude_patterns` 建依赖树 |
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
| `nativeEngineTimeoutMs` | `0`（= 用默认 180 分钟） | 单次引擎调用上限；超时杀进程树，**已写出的文章按 partial 抢救**（不会白跑）。默认值按真机全量实测（约 174 分钟）给，不是按小 fixture 估的 |
| —（无设置项，环境变量 `DSH_CODEWIKI_ENGINE_SILENCE_MS`） | 10 分钟 | 多久没收到任何协议帧就判引擎卡死并杀进程树，口径同上（已写文章 partial、零进展 failed）。只兜「跑太久」兜不住「已经卡死」，所以与上面的超时是两个独立判据；必须显著大于引擎 60 秒心跳。另：引擎发完 `result` 后若卡着不退，2 秒宽限后按已到的 `result` 收尾，不会被这两条改判 |

模型侧不新增设置：复用 `batchProvider` / `batchModel`（聚类与写文章都用它），经上面的
llm bridge 转发。

### 引擎日志与进度可观测性（0.17.1）

原生通道有三个「引擎在跑但你看不出来」的坑，0.17.1 一并补掉：

| 现象 | 根因 | 现在的行为 |
|------|------|-----------|
| 写文章阶段百分比长时间不动 | 上游在阶段 3（Documentation Generation）内的所有 `update_stage` 都在 `if self.verbose:` 里，入口传 `verbose=False`，于是从 `start_stage(3)` 到 `complete_stage()` 之间一帧进度都没有 | `stage_map.articles_percent` 在 `articles` 槽位内按「已写篇数 / 本轮起始 `.md` 篇数」插值，心跳帧带真实篇数；篇数口径与 `written_now` 的 baseline 快照同源，不拿模块名数当分母 |
| 增量轮被报成「聚合类模块」 | 增量分支复用 `start_stage(2, "Incremental Update")` 的槽位，按阶段号会映射成 `cluster` | `stage_map.is_incremental` 按 description 里的 `incremental update` 识别，整轮报 `articles` |
| 用量恒为 0 | 引擎已把 `usage_ledger` 汇总进 `result.usage`，`native-run.js` 也一路带到 `EngineResult.usage`，但收割段没写进 `job.usage` | 按旧通道字段形状落账（`inputTok`/`outputTok`/`requests`），并写进 `nativeResult.usage` |
| 「准备中」整段 0% 不动（0.17.56） | 同一族原因：阶段 1（Dependency Analysis）的 `update_stage` 也在 `verbose` 门控里，`percent_of(1, 0.0)` = 0%，直到阶段跑完才跳到 36%（实测 3 分 26 秒零帧） | `entry.py` 的 detail tap 从 `call_graph_analyzer.py:118` 的 `[12/36] path (…s elapsed)` 抽出已解析数，`frame_percent` 用它算阶段 1 的真实比例；心跳从 60s 收到 10s。面板把 `prepare` 一格拆成 `env`/`graph`/`cluster` 三段，段宽按 `nativeStageTimings` 的真实耗时 |

### 没变化就不提交任务（0.17.57）

AutoScan 每小时对每个已知工作区跑一次 `scope=auto`。历史上它**无条件提交任务**——因为 `cw status` 只看 committed，看不见工作区未提交变化与受管状态，原生通道必须自己再看一遍。代价是：仓库明明没有源码变化，也会起一轮任务，跑 3 分钟以上依赖分析后才在决议里得到「变化 0 项」。

两个缺陷叠在一起：

1. `state.json` 的 `unconsumed` 会把**死路径**永久携带。旧规则「只有出现在 `committed` 里才算消化」对「文件已删、又从未提交过」的路径永远不成立，于是它被无限携带、`effectiveChanges` 永远非空。真机上 `dsh-subagent-auto-router` 积了 37 条 `.dsh-ops/panel/*.json`、`dsh-git-worktree` 积了 6 条 `.diag-tmp/*`。现在不在本轮 git 任何一路里的旧账会被判为死条目并丢弃（`.gitignore` 忽略的同样丢弃——那是「不是仓库内容」的声明；被 git 看见的未跟踪文件仍继续携带）。
2. 提交前没有空转闸门。现在 `idleNativeReason`（`index.js`）在提交前判一次「这一轮有没有可做的事」，判据乐观（任何一项判不准就照常提交）：

| 判据 | 判不准时 |
|------|---------|
| 变更采集成功 | 不跳（不知道有没有变化） |
| 受管状态齐备（`module_tree.json` / `metadata.json` / 依赖图） | 不跳（引擎会转全量） |
| `state.json` 的 `headCommit` = 当前 cw 基线 | 不跳（有别的任务前移过基线） |
| `effectiveChanges` 为空 | 不跳 |

判为跳过时 `notes` 会说「工作区与已提交范围都没有源码变化，受管状态齐备且已覆盖基线 xxx——跳过本轮，不提交任务」，AutoScan 的计数落在 `noop`（不是 `submitted`）。

日志：`lib/job-logs.js` 把引擎事件逐条追加到**仓库外**的 NDJSON（默认
`%TEMP%/dsh-codewiki-logs/<jobId>.ndjson`，可用 `DSH_CODEWIKI_LOG_DIR` 改目录、
`DSH_CODEWIKI_LOG_MAX_BYTES` 改单文件上限，默认 2MB，超限保留后半段现场）。进度帧按
「阶段|百分比|篇数」去重后入档——引擎每秒可能发好几帧，全量落盘只会把桥请求失败、
stderr、阶段切换这些真正有用的事件挤出去。查看方式三选一：面板任务卡里可展开的
「引擎日志」块、`GET /api/codewiki/logs?jobId=&limit=`（默认 200 条，带字节数与错误行
计数）、或直接翻那个文件。日志写不进去不再静默：`job.logError` 会说明，并在 notes 里
提示「后续只在内存里保留最近 40 条」。

### 真实验收记录（0.15.0）

用真实 venv（Python 3.12.10、`codewiki 2.0.0`、`pip check` 零破损）+ 真实 `workbuddy`
凭证（经 llm bridge）跑完整生产链路（`codewiki_generate` 工具 → JobService →
`runNativeJob`），fixture 是仓库内 `tools/fsoft-engine/fixtures/中文 空格 fixture` 的
临时 git 副本。八个场景的实际结果：

| 场景 | 结果 |
|------|------|
| 全量编译（8 场景中的 6.1） | **done**，241s，written 13，提交范围校验 `ok:true`，工作区干净 |
| 已提交改动的 stale 增量 | **done**，10.7s（约为全量的 4%），written 9 |
| 工作区有未提交改动 | **partial**（正确）：把四路改动合成临时 commit 交给引擎（`workspaceSnapshot`，不挂 ref），产物与内容对齐；`uncommitted-input` 记账、基线不推进、文章照写（快照不挂 ref，把它记成已提交基线是不可逆的） |
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
- 锚点校验（`test-wiki-anchors.mjs --strict`，0.17.49 起该测试文件不再随仓库分发）实测 **2 过 / 0 败**（默认档同值）。
  0.17.39 之前是 3354 过 / 59 败 / 32 待重编译——那 59 条**全部**落在旧 Node 通道遗留的
  横切产物（`_architecture.md` / `_patterns.md` / `concepts/`）与两篇 `learnings/` 上，
  前者已整体下线，后者 0.17.49 随手工维护通道一并删除。剩下的 2 条都指向
  `vendor/codewiki/src/main.rs:236-256`：锚点正则长期不认 `.rs`/`.py`，这两条一直漏检。
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


- `batchProvider` / `batchModel`（0.10.0，0.10.1 起为唯一通道）：编译模型（规划/写文章/横切/审校全部环节共用），默认 `volces-ark` / `glm-5.3-flash`（512k 上下文；0.16.13 起默认值从 `workbuddy`/`hy3` 换过来，hy3 的 192k 窗口装不下本仓库的模块源码），走宿主 llm 服务。`batchModel` 填该 provider 的模型 id——本地 OpenAI 兼容端点（如本地 9B）只要在模型设置里注册过，就能在这里选到并参与编译。**0.10.1 删除了内置百炼直连通道**：`batchProvider` 必须指向模型设置里已注册的提供商，留空直接提交失败（不再有自带直连兜底，插件也不保存任何 API Key）。
- `batchReasoningEffort`（0.10.0）：该模型的思考程度档位 id。**可选值不手填**，设置页从模型目录实时读取（`GET /api/codewiki/model-efforts?provider=&model=` → 宿主 `resolveModel().reasoning.efforts`）；留空 = 用该模型的默认档。
- `bigEnabled`（0.17.5，默认开）：大档模型的**总开关**。关闭时大档不生效——`liveConfig` 直接把 `bigProvider` 置空，所有按「大档是否配置」判定的下游路径（文章写作双池、横切/校对大档装填、`markBigAgenticTasks`）一并退回默认档；同时设置页折叠整组大档字段。`bigModel` / `bigReasoningEffort` / `bigTokenBudget` / `bigConcurrency` 的取值保留，重新打开即恢复，不需要重填。
- `bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`（0.10.4，0.10.8 全面启用）：大档模型——模块源文本量超 `bigTokenBudget` 的写作任务、输入超 110k 普通预算的横切与批量校对请求，改用该档在插件内一次写完。默认 `volces-ark` / `glm-5.3-flash`（512k 上下文），预算 420k token。是否启用只看 `bigEnabled`，不再用「`bigProvider` 留空」这种隐式约定。
- `requestLimit`（0.17.8 引入，**0.17.12 起默认回到上游的 100**，1–1000）：单个模块写作允许的 LLM 请求次数。上游 1b4af43 起，写作校验会给没写出页面的模块续发最多 2 次补写提醒，**每次提醒都是一次独立的 `agent.run`，各自吃满一份预算**。0.17.8 曾按一次实测把默认提到 300，但那是「先全部改回上游逻辑验证」之前的临时值；现在默认 100 与上游一致，撞上限的模块会以 `article-failed` 上报而不是被静默截断。调小能压住单模块成本，调大能减少大模块被预算中断的补写次数。
- `sessionTier`（0.9.2）：**仅校对阶段的超大输入兜底**时才用。0.17.5 起写作走 agentic 工具循环、横切单批直出，都不再有会话通道；只剩「单篇文章源码连 `bigTokenBudget` 大档都装不下」的校对任务会转给发起会话的模型处理，此时派给哪个子智能体档位（`dsh-subagent-auto-router` 里的档位 id，如 `codeiwiki`）。留空 = 让会话模型自动选路；填了则 steer 文本要求 `delegate` 显式传 `tier`。

- `nativeEngine` / `nativeEnginePython` / `nativeEngineEntry` / `nativeEngineTimeoutMs`（0.15.0 引入，**0.16.0 起 `nativeEngine` 默认 `true`**）：原生引擎通道；需要本机 Python 3.10+ 与闭合依赖环境。详细要求见上文「原生引擎通道」。**0.16.5 起默认超时从 45 分钟改为 180 分钟**：45 分钟是早期按小 fixture（约 1 分钟）估的，真机全量实测约 174 分钟（`job-mvt1mrvu-6`：articles 66.0min + crosscut 10.0min + review 68.9min），预算低于物理耗时意味着每次都在阶段 3 刚开头被砍、一篇都写不出来，重试多少次都一样。
- `binaryPath`：cw 可执行路径；留空优先用 PATH 里的 `cw`（与 codewiki 源码同步演进），找不到再用插件自带 `bin/cw.exe`。0.2.3 起此顺序（原先捆绑优先，会吃到过期的旧布局二进制）。
- `maxConcurrency`（0.12.2 起语义收窄为**默认档**）：默认档（`batchModel`）请求并发上限，默认 2（1–8，硬顶 8）。
- `bigConcurrency`（0.12.2）：大档（`bigModel`）请求并发上限（1–8，硬顶 8）；`0`/留空 = 跟随 `maxConcurrency`（等价 0.12.1 的单一池行为）。两档各自独立计数、**同时推进**——大档常是付费长上下文档、与免费默认档配额互不相干，共用一个上限会让「大档只多几个请求」把默认档全堵住；代价是总在飞请求数最高可达两者之和，上游限流时把其中一个调小。
- `serialProjects`（0.10.0）：单项目串行，默认开。开启后同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued`，前一个收尾后自动轮到——避免多项目同时编译抢占同一个免费额度。
- `articleLanguage`：文章语言，默认中文。**两条通道都生效**：兼容通道写进提示词，原生通道经 `runNativeJob` 的 `language` 字段传进引擎 payload、落在 `agent_instructions.language`（上游 `config.py` 的 `language` property 读它）。0.16.7 之前原生通道整条链路都没接这个字段，引擎静默按英文写。
- `updateReminder`：会话系统提示注入 wiki 维护提醒，默认开。仅当会话仓库根存在 wiki 入口 `CodeWiki.md` 时出现（text 回调每次组装求值，实时判断；判定不看 `.codewiki/` 目录——只有空骨架目录时提醒会指向读不到的入口）；提醒内容：收尾必须调用 `codewiki_generate` 更新 wiki（模块文章、入口 `CodeWiki.md` 与索引刷新由流水线完成，不要手工编写/修改 `.codewiki/` 下的文章——手改不进流水线、不被面板记录，会被下次编译覆盖）；`codewiki_note` 与它写的手工页 0.17.49 已下线，提醒里对应的例外条款一并删除，没有替代通道；`codewiki_generate` 是后台编译，调用即返回、调用后本步收尾，不要等待/轮询；产物由插件自动提交（见下一条）。0.2.5 起。0.10.9 起同一 section 只兼职**降级**提醒：最近一次成功编译的完成时间晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交 → 注入「产物待提交」（并写明自动提交为何没成功），一次性、不催促（时间戳派生自 jobs 文件与 `git log`，插件提交后自动静默，零持久状态）。0.8.0 起编译终态另有实时唤醒：工具调用会话（exec.agent）在编译 failed、或 done 但自动提交失败时收到 steer 消息（与子代理 send_message 同机制），**自动提交成功或产物本就无改动时完全不打扰会话**，面板/自动调度提交与冷会话静默跳过。
- `autoCommit`（0.10.9，0.10.10 修正文档与三态）：编译产物自动提交，默认开。编译终态（done 且有文章写成功）后由插件自己 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（信息前缀 `docs(wiki):`，带任务 id 与篇数），把「等编译完成 → 会话模型代跑 git」这件事彻底收回插件侧——会话模型因此不必等待编译、不必轮询、不必提交。安全边界：改动由 pathspec 限定在这两个路径（不是 `-A`/`--all`/`.`，因此不会卷进工作区其它改动）、不 amend/push/改写历史、不跑仓库钩子；以下情形一律**拒绝并降级**为一次性「产物待提交」提醒（不会半个提交、不会静默丢产物）：非 git 仓库、仓库无 HEAD、merge/rebase/cherry-pick 进行中、目标路径存在未解决冲突、`.codewiki/`（或未 tracked 的 `CodeWiki.md`）被 `.gitignore` 忽略、缺 `user.name`/`user.email`、`git add`/`git commit` 失败（含 `index.lock` 被并发占用）。结果写入 job 的 `autoCommit`（`committed`/`sha`/`message`/`reason`/`noChanges`），`codewiki_progress` 输出与侧边栏任务卡直接显示；三条通道（唤醒、系统提示提醒、面板）统一按 `autoCommitState()` 判定三态：已提交 → 静默、产物无改动 → 静默不催、未提交 → 才提醒一次。
- `autoUpdate` / `autoUpdateMin`（0.4.0 引入，0.16.2 修正扫描来源，0.16.3 遵守 `workspaceOnly`）：自动更新默认关；开启后服务每 60s 心跳一次，距上次扫描超过扫描间隔（`autoUpdateMin`，默认 30 分钟，最小 5）时逐仓 `scope=auto` 判态提交（被排除目录、worktree、空壳目录静默跳过），单仓失败只记 `lastError` 不中断。**0.16.2 起扫描来源是「已知仓库清单 ∪ 任务历史」**（`REPOS_FILE`，`rememberRepo()` 在每次提交时写入）：只扫任务历史会让「编译过一次、后来没再手动编译」的仓库在 job 被 `MAX_JOBS_KEPT=30` 截断或 Temp 终态启动清理后永久退出自动扫描——面板仍显示过期，却永远等不到自动编译。**0.16.3 起自动调度与面板一样遵守 `workspaceOnly`**：不在已添加 dsh 工作区清单里的仓库（如已移出工作区的目录）不再被后台定时编译——旧实现只让面板过滤遵守它，会产物悄悄写进别人的 `.codewiki/` 而面板上根本看不到那条任务；被跳过的仓数在面板上以「工作区外跳过 N」显示（`scheduler.lastScanSkipped`）。心跳间隔可用环境变量 `DSH_CODEWIKI_AUTO_SCAN_MS` 覆盖（下限 100ms，仅用于测试；生产别设）；空壳判定缓存可用 `DSH_CODEWIKI_SOURCE_PROBE_EMPTY_TTL_MS` 覆盖「无源码」结论的 TTL（默认 60s，命中源码时仍缓存 10 分钟）。**0.16.6 起仓库清单的落点跟随 `JOBS_FILE` 名字**（`reposFileFor()`）：`dsh-codewiki-jobs.json` → `dsh-codewiki-repos.json`，`dsh-codewiki-jobs-test-<pid>-<token>.json` → `dsh-codewiki-repos-test-<pid>-<token>.json`；显式 `DSH_CODEWIKI_REPOS_FILE` 仍最优先。旧实现只按**目录**推导，导致任何改了 `DSH_CODEWIKI_JOBS_FILE` 的测试都写到真实宿主的清单文件里——真机上该文件曾被塞进 `%TEMP%/cw-orch-xxxxxx` 这类早已删除的 fixture 目录，每次自动扫描都要为它们空跑一轮探测。
- 所有设置 `volatile`，改完即生效（execute 时解包读取），无需重启。

## 安装

两种装法，按用途选一种。**装完都要重启 dsh**（bundle 层与 client 半边都只在进程启动时装载）。

从 GitHub 装（社区用户最省事的一条）：

```sh
dsh plugin --profile <你的 profile> add @ikliml666/dsh-codewiki
# 或直接从仓库装（尚未发布到 npm 时用这条）
dsh plugin --profile <你的 profile> add github:ikliml666/dsh-codewiki
```

装完把 `@ikliml666/dsh-codewiki` 加进该 profile 的 `dsh.profile.bundles`，重启 dsh。下面的装法 A / B 是本地源码开发的两种形态。

### 装法 A：bundle 依赖（推荐）

插件行由插件自带的 `cordis.patch.yml` 自动合并进 profile，**不需要**在 profile 的 `cordis.patch.yml` 里再手写 codewiki 条目：

1. 源码放 `E:\ik\Documents\trae_projects\1\dsh plugin\dsh-codewiki`（本目录）。
2. 在目标 profile（如 `%USERPROFILE%\.dsh\profiles\desktop`）的 `package.json` 里登记两处：

   ```jsonc
   {
     "dependencies": {
       "dsh-codewiki": "github:ikliml666/dsh-codewiki"
     },
     "dsh": {
       "profile": {
         "bundles": ["…", "dsh-codewiki"]
       }
     }
   }
   ```

3. 在该 profile 目录跑一次 `pnpm install`，让 `node_modules/dsh-codewiki` 真的指向源码目录。
4. 要改配置，在本 profile 的 `cordis.patch.yml` 里写**同 id 覆盖条目**（不是 insert）：

   ```yaml
   - id: codewiki
     config:
       batchModel: doubao-seed-2.1-lite
       maxConcurrency: 3
   ```

   覆盖条目的 `config` 是**整对象替换**：上面没写的键回落到 `index.js` 的 `Config` 默认值，不会与 bundle 层里的 `config: {}` 深合并。因此只想改一项时，也要把其余改过的项一并写上（或干脆都靠默认值）。

装法 A 下 `cordis.patch.yml` 里那条 insert 写的是本包包名 `"@ikliml666/dsh-codewiki"`。**name 必须是裸 npm 包名（不带 `/dsh` 子路径）**：client 半边的激活扫描（`client-modules locatePkgJson` → `exactPackageSpecifier`）只认裸包名行。

### 装法 B：`file:///` 直挂（改插件源码时用）

不装依赖、不碰 profile 的 `package.json`，直接在 profile 的 `cordis.patch.yml` 顶层追加：

```yaml
- insert:
    - id: codewiki
      name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js
      config: {}
```

URL 里的空格写 `%20`。这条直挂条目由用户自己维护，插件自带的 bundle 层在装法 B 下不要同时启用（`bundles` 里不要有本包），否则同 id 会出现两条 insert。两种装法保持 id 一致：`codewiki`。

### 依赖解析（两种装法都一样）

`@deepseek-ai/schemastery`（仅 `Config` 用）走插件**自己**的 `node_modules/@deepseek-ai/schemastery` junction → `E:\software\deepseek-harness\vendor\schemastery`。link 装法下 Node 从源码真实路径解析，仍然走这个 junction，不借 profile 的 `node_modules`。

运行时 import 只有三个 `@deepseek-ai` 包：`schemastery`（Config）、`dsh-llm`（`createUserMessage` / `BlockAssembler`，原生通道的模型桥）、`dsh-client-ui-primitives`（客户端半侧的 `Switch`/`Button`/`Input`/`Tag`）。工具、子代理、`systemPrompt`、`webServer`、`agents`、`llm` 全部走注入服务，不 import `dsh-tools` / `dsh-agent` / `dsh-app-boot` 这类宿主实现包。

`engines`：`node >=24.9.0`（DSH 0.2.2-rc.1 起不再支持 Node 22）、`dsh >=0.2.0-rc.0`。`engines.dsh` 刻意不写上界——写死上界（如 `<0.2.2-0`）会让插件在新宿主的 bundle 层被整条跳过，而 `>=0.2.0-rc.0` 在 0.2.1-rc.5 与 0.2.2-rc.1 上都通过（`includePrerelease: true` 的 semver 实测）。

客户端半侧（设置页）由包声明驱动：`package.json` 里 `dsh.client.platform: "web"` + `exports["./client"]`，宿主 client 扫描器找到本包后自动把 `client.js` 送进浏览器——同样需要一次重启（「非 client 包」判定按条目缓存到重启为止）。

## 来源与许可（Credits and third-party licenses）

本项目站在两个上游项目之上，二者均为 MIT：

| 上游 | 在本项目里的形态 | 许可 |
|------|-----------------|------|
| [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) | 原生通道（默认）直接把它当子进程驱动，`codegraph` 阶段由它的 Python 引擎完成。本仓库不分发它的源码，用户按 `tools/fsoft-engine/setup-env.sh` 自行准备 venv。 | MIT，Copyright (c) 2025 FSoft-AI4Code |
| [mraza007/codewiki](https://github.com/mraza007/codewiki) | Rust CLI `cw`，以源码形式 vendored 在 `vendor/codewiki/`（已去除 `.git`），并附带编译好的 `bin/cw.exe` 兜底。`vendor/codewiki/FORK.md` 记录了对上游的改动与同步方式。 | MIT，Copyright (c) 2026 Muhammad Raza |

本插件自身的代码同样以 MIT 发布，见 [LICENSE](./LICENSE)。

> **关于 vendored 的 `bin/cw.exe`**：这是从 `vendor/codewiki/` 源码编译出来的产物，随包携带以免用户在 Windows 上还得装 Rust 工具链。它不含任何第三方专有代码。

## 链接

- 官方 Harness 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 插件发现：GitHub 的 [`dsh-plugin` topic](https://github.com/topics/dsh-plugin)
- 问题与建议：<https://github.com/ikliml666/dsh-codewiki/issues>


## 开发

```
vendor/codewiki/   上游源码（去除 .git）
bin/cw.exe         cargo build --release 产物（git 内跟踪，改了 vendor 记得重编）
client.js          插件页设置卡片（浏览器半侧；协议参照 ui-settings-agent-loop / router client.js）
```

验证：`node --check index.js client.js`；设置页需重启 dsh 后在插件页实测。

测试文件不随包发布（已在 `.npmignore` 排除），也不再随仓库分发；改动后请自行按 CHANGELOG
里的验收记录复现（每条修复都留了实测命令与数字）。
