# FSoft 原生引擎迁移：契约与映射（阶段 0 冻结文档）

> 本文件是迁移的**冻结契约**，任何实现必须服从它；改契约要改版本号并同步
> `lib/engine/contract.js` 与 `test-engine-contract.mjs`。
> 目标：把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」。

## 为什么迁移

现状（0.14.0）用 Node + tree-sitter WASM 在本插件内**重新实现**了上游
FSoft-AI4Code/CodeWiki 的三层能力（AST 符号、LLM 语义聚类、符号级增量）。代价是：

1. **两套编译器**：算法每改一次要追两遍，上游 PR 无法直接受益；
2. **算法保真度无法自证**：Node 版和 Python 版行为差异只能靠人读代码比对；
3. **质量门与增量语义各写一套**：0.14.0 修的三类缺陷正是「自己重实现」的典型后果。

迁移后职责切分（不重叠）：

| 归属 | 负责 |
| --- | --- |
| FSoft 原生引擎（Python，锁定上游 commit） | 依赖图、模块树、artifact 采集、文章写作、组件级增量（updater rung 3）、update_record |
| mraza `cw`（Rust CLI） | `init` / `status` / `index` / `meta update` / 索引与基线 |
| DSH 插件（Node） | 宿主模型通道、JobService、排队/取消/恢复、面板、自动提交、安全边界 |

**不长期维护两套编译器**：阶段 7 已执行完毕（0.16.0），Node 侧的 symbols/cluster/
graph-diff/incremental/update-planner 五个模块及其 7 套测试**已删除**，`nativeEngine`
默认为 `true`。`nativeEngine:false` 保留为最小兼容通道（顶层目录分组 + 文件级
`source_files` 归属判定），不再接收新能力。

## 版本化契约

契约常量见 `lib/engine/contract.js:23-96`，校验逻辑见 `lib/engine/contract.js:160-220`。

### EngineResult

一次 `generate` / `update` 的完整结果。`contractVersion` 固定为 `2`（0.16.7 起；
改契约必须同步升 `lib/engine/contract.js` 的 `ENGINE_CONTRACT_VERSION` 与 `test-engine-contract.mjs`）。

```jsonc
{
  "contractVersion": 2,
  "outcome": "done|partial|failed|cancelled",
  "stage": "env|graph|cluster|articles|validate|index|baseline|commit|null",
  "blockers": [{ "kind": "article-failed", "detail": "...", "target": "modules/a.md" }],
  "error": { "code": "engine-crashed", "message": "...", "stage": "articles", "retryable": false },
  "writtenCount": 0, "failedCount": 0, "keptCount": 0, "removedCount": 0, "unmappedCount": 0,
  "usage": { "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0 },
  "engine": { "version": "", "commit": "", "python": "" },
  "artifacts": { "docsDir": "", "rawTreeDir": "", "updateRecord": "" },
  "startedAt": null, "finishedAt": null
}
```

**硬不变量**（`engineResult()` 构造即校验，`validateEngineResult()` 反序列化再校验）：

| outcome | 必须 | 禁止 |
| --- | --- | --- |
| `done` | 无 blockers | **带 blockers 一律抛错**（done 表示完整成功） |
| `partial` | 至少一条 blockers | **没有 blockers 一律抛错**（否则等于把失败伪装成功） |
| `failed` | `error` 对象 | — |
| `cancelled` | — | — |

`blockers[].kind` 是机读枚举（`BLOCKER_KINDS`），新增只许追加、不许改名：
`article-failed` / `article-missing` / `unmapped-change` / `unmapped-page` /
`quality-gate` / `index-failed` / `baseline-failed` / `commit-failed` /
`engine-error` / `cancelled` / `incremental-fallback` / `engine-timeout`。

`engine-timeout` 是 0.16.7 补登记的：`client.js` 判「超时但有进度 → partial」时把它当
blocker 用，但枚举里没有它，`normalizeBlocker` 会静默降级成 `engine-error`，
于是「跑到一半被超时砍掉」与「引擎自己崩了」在终态和面板里长得一模一样。

`error.code` 决定重试语义（`ENGINE_ERROR_CODES`）：`engine-timeout`、`engine-model`、
`engine-unknown` 可重试；其余（`engine-missing`、`engine-deps`、`engine-crashed`、
`engine-protocol`、`engine-output`、`engine-cancelled`）视为确定性失败。
未登记的 code 归到 `engine-unknown`，原文留在 `rawCode` 里供排障。

### EngineProgress

推进中的阶段快照，tick 与面板共用同一份：`stage` 必须在 `ENGINE_STAGES` 内
（`env → graph → cluster → articles → validate → index → baseline → commit`），
`percent` 夹到 0–100，计数缺失按 0 解释（旧 job 兼容）。

### EngineError

可机读失败事实：`code` 决定重试语义，`message` 只给人看（截断 4000 字符），
`stage` 标明停在哪一步。

## 接口面（doctor / generate / update / cancel）

跨进程只有四个动作，全部走「Node 子进程 + JSON-lines stdout 协议 + 日志走 stderr」：

| 动作 | 入参 | 出参 | 说明 |
| --- | --- | --- | --- |
| `doctor` | `{}` | `{ok, engine:{version,commit,python}, checks:[{name,ok,detail}]}` | 校验解释器、venv、依赖锁定、`pip check`、入口可导入 |
| `generate` | `{repoPath, docsDir, commitId?, language?, updateOptions?, model:{baseUrl,model,apiKey}}` | `EngineResult` | 全量；缺 `docsDir` 会回退写进 `<repoPath>/.codewiki`（**不允许**，见下） |
| `update` | `{repoPath, docsDir, commitId?, updateOptions?}` | `EngineResult` | 增量；`updateOptions.rung` 默认 `'3'` |
| `cancel` | `{requestId}` | `{cancelled:boolean}` | 终止受管子进程树（不是只 kill 父进程） |

**字段是平铺在请求行顶层的**（`lib/engine/client.js` 写 `JSON.stringify({requestId, action, ...payload})`）。
入口（`lib/engine/python/entry.py`）同时接受 `{payload:{...}}` 嵌套形状与平铺形状，**平铺优先**；
这条兼容是 0.15.0 真实验收逼出来的（详见「阶段 6 验收证据」第 4 条）。

协议约束：

- stdout **只**允许 JSON-lines（每行一个 `{type:'progress'|'result'|'error', ...}`），
  引擎自身的日志一律走 stderr，二者绝不混流；
- 每条消息带 `requestId`，Node 侧按 id 关联；乱序/未知 id 记 `engine-protocol`；
- 退出码只表达进程层结果（0 正常结束、非 0 崩溃），**语义结果只看 `result` 消息**——
  这样「进程正常退出但引擎报 failed」不会被误读成成功。
- 两侧编解码一律 UTF-8：入口把 stdin/stdout/stderr 都 reconfigure 成 UTF-8（stdin 用
  strict、输出用 replace），并给 `subprocess.Popen.__init__` 补 `text=True` 时的编码兜底，
  否则 Windows 下非 ASCII 仓库路径会以 locale(cp936/gbk) 解错。

## 产物映射

实现在 `lib/engine/mapping.js`，测试在 `test-engine-contract.mjs`（18 条）。

| FSoft 产物 | 落到 | 类型 |
| --- | --- | --- |
| `overview.md` | `CodeWiki.md`（入口） | 不是文章 |
| `{Module_Name}.md` | `.codewiki/modules/<kebab-slug>.md` | `type: module` |
| `module_tree.json` | 不落盘，只作 `source_files` 证据 | — |
| `metadata.json` | `.codewiki/_meta.yaml`（`last_compiled_commit`/layout/language） | — |
| `update_record.json` | `.codewiki/temp/update-record.json`（原样搬运） | — |
| artifact 页 | 同上模块页，`pageKind: artifact` | 不冒充业务模块 |
| 父模块页（有 children） | 同上模块页，`pageKind: parent` | 不平铺成叶页 |

四条硬规则（对应测试）：

1. **不臆造 `source_files`**。只认真实证据：`componentFiles` 映射，或组件 id
   `path::Symbol` 的 `::` 前部分。纯符号名且无映射 → 空数组 + warning。
   理由：`source_files` 是增量 ownership 的唯一依据，编造它会让未消化的变化被静默基线化。
2. **不静默丢弃**。任何未映射的页进 `unmapped` 并带原因（非 markdown、页名不在模块树、
   无法规范化、文件名冲突）。滑掉的页等于 wiki 少一篇而没人知道。
3. **不覆盖**。slug 冲突（`A_B.md` 与 `A-B.md` 都 → `a-b.md`）时两页都进 `unmapped`，
   不许后到的赢。
4. **不改技术内容**。映射只搬路径与类型，正文一字不动；FSoft 原始树保留为事实来源。

## 与 cw 的边界

`cw` 仍是索引与基线的唯一写者（`cw index` / `cw meta update`）。迁移**不**把 cw 换掉，
只把「算图/聚类/写文/增量判定」交给 FSoft。因此：

- `.codewiki/_index.md` 永远由 `cw index` 生成，插件不手写；
- `.codewiki/_meta.yaml` 的 `last_compiled_commit` 只在「这一轮把变化全部消化完」时推进：
  `done` 才推进；`partial`/`failed`/`cancelled` 一律不动（写成的文章照常入库，
  「变化已消化」这个事实不成立）。
  0.16.1 曾改为「`partial` 且 `rawTreeFiles > 0` 也推进」，目的是打破「超时被砍但已写 28 篇 →
  基线不动 → 下一轮从同一批变化重来 → 又超时」的死循环；但那条路径把「没消化完」记成
  已消化，与落地器的「`partial` 不推基线」自相矛盾（门说可推、落地器照写、终态报 partial）。
  0.17.0 改回单一判据，死循环的真正解法落在质量门的 `isEmptyBaseline()`：本轮刚
  `cw init` 出来的空骨架（无编译提交、来源是 `worktree-only` 或 `git-head`）判
  `baseline-absent` 直接放行，首次编译因此能走成 `done` 并正常推进基线。
  判据实现见 `lib/engine/quality-gate.js` 的 `baselineEligible` 与本文件「落地器」一节，
  两者必须一致；
- 自动提交仍只 `git add -- .codewiki CodeWiki.md`，pathspec 边界不变。

## 阶段门禁

| 阶段 | 门禁 | 未过的后果 |
| --- | --- | --- |
| 0 | 契约与映射测试全绿；分支建立 | 不进入任何实现 |
| 1A | 独立 venv `pip check` 零问题；CLI import/help 成功；中文/空格路径下无模型依赖图跑通 | 不接桥 |
| 1B | 宿主模型经 loopback 桥真实跑通 tool calls / 流式 / 结构化输出 / 取消 | **停生产迁移并报告**，不擅自换付费通道 |
| 1C | 小多语言 fixture 真实全量 + 五类增量（注释/接口/新文件/删除改名/工作区变更） | 不接生产 |
| 2–7 | 见总计划 | — |

1A/1B/1C 未全过，**绝不接生产、绝不删旧核心**。

## 阶段 1A/1B/1C 验收证据（2026-10-28）

1A、1B 已复核通过；1C 的原生 committed-diff 四类场景通过，但未提交工作区场景仍是明确缺口，须由阶段 5 补齐，不能视为完整通过。环境与 fixture 都在插件仓库**之外**（`.probe-fsoft`），
仓库里只留可复现的构建脚本、锁定清单与 fixture 源码。

### 1A：锁定环境

`tools/fsoft-engine/setup-env.sh` 从零建 venv 并跑完四步，`pip check` 输出
`No broken requirements found.`，六个 import（`codewiki`/`openai`/`pydantic`/
`tree_sitter`/`litellm`/`tiktoken`）全 ok。

安装方式**故意不用正常解析**：FSoft 的 `openai` / `pydantic-ai-slim` / `pydantic`
约束互相打架，`pip install -r freeze.txt` 走正常解析必然 `ResolutionImpossible`
（实测报错 `Cannot install -r freeze.now.txt (line 65), openai==2.54.0 and
pydantic-ai-slim==2.61.0 ... because these package versions have conflicting
dependencies`）。冻结清单本身就是**已解析完成的快照**，所以按 `--no-deps` 落盘 +
`-c constraints.txt` 防间接依赖跑偏，再用 `pip check` 反向验证闭合。

无模型依赖图探针 `tools/fsoft-engine/probe-no-llm-graph.py` 在
`tools/fsoft-engine/fixtures/中文 空格 fixture`（路径含中文与空格）上跑
`handle_analyze_repo`，返回 `ok: true`，统计 15 个组件 / 6 个叶子节点
（python 9 + typescript 4 + null 2），结果固化在
`tools/fsoft-engine/probe-no-llm-graph.result.json`。

### 1B：宿主模型桥

`lib/engine/llm-bridge.js` 起一个只绑 `127.0.0.1` 的 OpenAI-compatible HTTP 服务，
FSoft 只拿到 loopback URL、模型名与占位 key；真实凭证始终留在宿主 provider 内，
桥进程不读任何凭证文件。`lib/engine/openai-bridge.js` 负责把 OpenAI 请求体翻译成
宿主 `llm.stream()` 的 `GenerateOptions`，并把 `StreamChunk` 翻回 SSE。

真机实测（`workbuddy` / `deepseek-v4.1-flash`）：流式 230 个 chunk、首 chunk
1847 ms、总 3144 ms；非流式返回 usage（prompt 41 / completion 16 / total 57）。
工具调用往返也跑通——这是唯一能暴露 `replayState` bug 的场景：assistant 历史消息
缺 `source` 字段时宿主适配层直接丢弃，第二轮请求起模型就看不见自己上一轮的工具调用。

### 1C：原生端到端

fixture 同 1A（Python + TypeScript 双语言、路径含中文空格）。全量编译真实跑通后
逐类做增量：

| 增量 | 改动 | FSoft `diff.counts` | 结果 |
| --- | --- | --- | --- |
| 注释 | 仅改 docstring/注释 | 全 0 | `outcome: no_change`，0 次 LLM 调用（符合预期：注释不进图） |
| 公开接口 | `build_engine` 加 `verbose` 参数 | `interface: 1` | `outcome: incremental`，`pages_written: ['overview']` |
| 新文件 | 新增 `src/web/queue.ts`（`QueueItem` + `drain`） | `added: 2` | `outcome: incremental`，`pages_written: ['overview']` |
| 删除 + 改名 | `git rm handler.py`、`git mv queue.ts queue_v2.ts` | `deleted`/`renamed` | `stale_scan.fixed` 命中 `web_layer`，页面里旧符号名 0 次、新名 20 次 |
| 工作区变更 | 改名 `normalize` → `normalizeTask` 但**不提交** | — | 0.15.0 起由 Node 侧合成临时 commit 交给引擎（见下） |

未变页面保留：`core_engine` 页 mtime 未动，说明增量没有重写无关文章。

**工作区变更这条是 FSoft 的真实限制，不是薄桥缺陷**：`generate.py` 只从
`<old_commit>..<new_commit>` 取 diff，未提交改动不进 `update_record`。插件侧的
`lib/change-set.js`（0.14.0 已实现）本来就采四路变更，所以做法是
**由 Node 侧把工作区变更合成一棵真实的树（临时 commit）交给引擎**，
而不是让 FSoft 去读工作区。

实现（0.15.0，`lib/engine/workspace-snapshot.js` + `lib/engine/native-run.js` 的 1.9 段）：

1. 四路变化集里 `staged`/`unstaged`/`untracked` 任一路非空时，用**独立的临时 index**
   （`GIT_INDEX_FILE` 指向 `os.tmpdir()`，不碰用户 index）跑 `read-tree <parent>` →
   `add -A -- .` → `write-tree`，再用 `commit-tree` 造一个挂在 HEAD 上的 commit。
   **不写任何 ref**：`git for-each-ref --contains <sha>` 为空，`HEAD` 不变，工作区仍然脏，
   `git diff --cached` 仍然空——编译不会因快照在仓库里留下任何痕迹。
2. 本轮交给引擎的 `commitId` 改成这个快照 sha（无快照时仍用 HEAD），于是
   `metadata.json` 的 `generation_info.commit_id` 与实际产物内容**对齐**。下一轮拿它当
   `old_commit`，diff 起点就是「工作区那份内容」，未提交改动不会被当成已消化。
3. 质量门按 `consumedInputCommit` 认可产物对得上快照（不再误报 `commit-mismatch`），
   但 `uncommitted-input` 照旧判 defect：快照不挂 ref，把它记成已提交基线是不可逆的，
   终态仍 `partial`、基线不推进。
4. 造不出快照不算失败——退回用 HEAD 记账并记 note。快照是**对齐精度**的改进，不是
   编译成立的前提；把「git 太旧 / 对象只读」升级成编译失败是本末倒置。

取消与异常退出：`lib/engine/process-tree.js` 的 `terminateProcessTree` 在真实模型
调用中途（桥请求计数 196→197 的那一瞬）用 `taskkill /T /F` 终止整棵进程树，
204 ms 返回 `{ok:true, rootAlive:false}`，子进程退出码 1，残留 `codewiki` 进程 0 个。
异常退出路径用 `--request-limit 1` 强制触发：引擎抛
`APIError: Documentation generation failed: The next request would exceed the
request_limit of 1`，CLI 退出码 4——**语义失败与进程退出码分离**，Node 侧只看
`result` 消息不会被误导。

## 阶段 6 验收证据（2026-10-29，真实引擎 + 真实模型 + 生产链路）

**这次不是探针，是生产链路**：`codewiki_generate` 工具 → JobService →
`lib/engine/native-run.js`，用真实 venv（Python 3.12.10、`codewiki 2.0.0`、
`pip check` 零破损、源码锁上游 commit `03d0a294…`，该 commit 在 0.17.6 升级时已被
`1b4af43d…` 取代，此处保留的是**当时**的现场）
与真实 `workbuddy/glm-5.3`（经 `lib/engine/llm-bridge.js` 转发真凭证）。fixture 是
`tools/fsoft-engine/fixtures/中文 空格 fixture` 的临时 git 副本（路径含中文与空格）。

| 场景 | 终态 | 关键数字 |
| --- | --- | --- |
| 全量 | `done` | 241s、written 13、`commit.scope.ok=true`、`git status` 空 |
| 已提交改动的 stale 增量 | `done` | 10.7s、written 9、无 `_native-state` 自嵌套 |
| 工作区未提交 | `partial` | `uncommitted-input` 记账、基线不推进、文章照写 |
| 重命名（`git mv` + 类改名） | `done` | 3 条变化、新增并重写模块页 |
| 删除模块 | `done` | 孤儿页同提交清理（4 篇 → 2 篇） |
| 取消 | `cancelled` | 基线不推进、HEAD 不变 |
| 解释器不存在 | `failed` | stage=env、原始 ENOENT 带出 |
| 无变化轮（连跑两轮） | `done` 零副作用 | `written 0`、`noChanges`、HEAD 不变 |

**真机才暴露的 8 个缺陷（已全部修掉，假引擎测不出）**：

1. 非 ASCII 路径被 `core.quotepath` 转义误判越界 → 新增 `lib/git-paths.js`，
   读路径的 git 调用统一 `-c core.quotepath=false` 并解码历史转义串。
2. 引擎锁在自动提交之后写盘 → 落不进提交、留成脏文件。改为进 apply 写集（同 pre-image/回滚/提交）。
3. 原生通道的 `saveRecord` 晚于内部提交 → 每轮留 `?? .codewiki/temp/update-record.json`。
   原生通道改为写仓库外 `os.tmpdir()/dsh-codewiki-native-records/<jobId>/`。
4. 协议字段位置不一致（客户端平铺、入口只读 `msg.payload`）→ `docsDir` 丢失，
   引擎回退写 `.codewiki`，增量轮把受管状态水合成 `_native-state/docs/_native-state/docs/…`
   逐轮自嵌套（gate `unmapped:8 defects:14`）。入口改为两种形状都认、平铺优先。
5. 入口 stdin 按 locale 解码 → 中文路径读成 `涓?鏂? 绌烘牸` 后报「仓库路径不存在」。
6. 上游内部 `text=True` 子进程用 gbk 解 UTF-8 → reader 线程 `UnicodeDecodeError`、
   `stdout` 变 `None`，`repo_analyzer.py:65` 抛 `AttributeError`。入口给
   `Popen.__init__` 补 UTF-8 兜底。
7. 上游把 `.codewiki/_meta.yaml` 当源码组件 → 图 diff 永远非空、永远 `incremental`，
   每轮一笔纯记账提交（+ ~528 prompt tokens routing）。入口传
   `agent_instructions.exclude_patterns=['.codewiki','CodeWiki.md']`（扫描面 24 → 4 文件）。
8. 删除模块后孤儿页残留（gate 只体检本次产物，上游可能回 `full_fallback` 且
   `pages_removed: []`）→ 新增 `findOrphanPages()` + `applyNativeOutput({deleteFiles})`，
   删除走落地事务。

**未达成项（如实记录）**：

- **hy3 硬门禁未通过**。阶段 1B 第 4 条要求实测 `workbuddy/hy3`；当期 hy3 返回
  `429 quota_exceeded`（“您的使用量已超出频率限制，将在 2026-10-29 14:23:38 UTC+8
  重置”），故八场景真实验收用 `workbuddy/glm-5.3`。这是**上游配额**不是适配层问题，
  但规格的硬门禁确实没满足——额度恢复后把 `batchModel` 改回 `hy3` 重跑八场景
  才算闭环。
- **strict 锚点未全绿**。`node test-wiki-anchors.mjs --strict` 实测
  **3354 过 / 59 败 / 32 待重编译**（默认档 3354 过 / 5 败 / 86 待重编译）。59 条
  失败构成：34 条「指向空行」（锚点行落在空行或区间内无代码，`test-engine-apply-plan.mjs`
  占 26 条、`index.js` 8 条、`README.md` 6 条）、20 条「符号未绑定」（`idleRound`/
  `symbolIncremental`/`runEngine`/`normalizeIndexLinks`/`normalizeArticlePath`/
  `resolveBinary`/`numberLines` 等不在所引区间内）、4 条「符号不存在」（该符号在
  目标文件里 0 次出现）、1 条「起始行越界」（`test-wiki-anchors.mjs:778` 超出该文件
  当前 404 行）。**绝大多数是 `.codewiki/` 文章滞后于本轮代码**，属文档滞后而非
  校验器缺陷：按纪律不手改文章，留待一次真实全量重编译覆盖（重编译后基线前移，
  这些会自动升级为硬断言）。
- **阶段 7 受控退役已执行（0.16.0）**，用户明确指示「可以删除」。切换与删除内容：
  - `nativeEngine` 默认值 `false` → `true`（`index.js` Config 与 `liveConfig`、
    `client.js` 提示文案、README/docs/CHANGELOG 同步）。
  - 删除 `lib/symbols.js`（884 行）、`lib/cluster.js`（467 行）、`lib/graph-diff.js`
    （578 行）、`lib/incremental.js`（206 行）、`lib/update-planner.js`（492 行）；
    连带删除 `test-symbols.mjs`、`test-cluster.mjs`、`test-graphdiff.mjs`、
    `test-incremental.mjs`、`test-incremental-e2e.mjs`、`test-update-planner.mjs`、
    `test-semantic-plan.mjs`。
  - `index.js` 侧清理：删 `semanticPlan()`、`extractCurrentGraph()`、`slimPlanForJob()`、
    `loadModuleMap()`、`saveModuleMap()`、`tickIndex` 里的符号快照写入、以及两处
    增量规划分支（`runStaleUpdate` 与「stale 但解析不出过期文章」）里的
    `loadSnapshot`/`planUpdate`/`updatePlan` 路径；新增 `attributeChanges(changeSet,
    articles)` 做文件级归属判定（`{unmapped, touched}`）。
  - `job.updatePlan` 字段保留但恒为 `null`（兼容已落盘旧 jobs 与面板读法），
    终态判定由 `judgeOutcome` 的 `expectedNames` 通道承担。
  - `planMode`、`symbolIncremental` 两个配置项**保留但已无实际效果**，仅为兼容既有
    `settings.json`；`client.js` 里的表单提示已改写为「已退役」。
  - 已知能力损失：兼容通道没有反向依赖闭包、没有纯注释跳过、没有新文件 ownership
    路由——改一个被多篇引用的函数只重写直接认领它的那一篇。这是退役的对价。

## 上游同步

上游仓库 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)，
**锁定 commit `1b4af43d6d20c8dbd758fe1d5f888cc6947ed11d`**（2026-11-01，
`update tree-sitter version`），该源码树自报 `codewiki.__version__ = 2.0.0`。

0.17.6 之前锁的 `03d0a294…`（2026-10-22，PR #142）是**错锁**：那个对象在本机
clone 里根本不存在（`git cat-file` 报 `could not get object info`），
`compareLock()` 因此一直在比对两个不同的源码树。0.17.6 把锁改成实际运行的
commit，并顺带同步了上游 15 个提交（`364b67a` → `1b4af43`，
56 文件 / +3449 −358）。

**这个 commit 是机器可读的锁定，不只是一行文档**：`lib/engine/manifest.js` 导出
`UPSTREAM_COMMIT` 常量，`probeEnvironment()` 把它带进环境 facts，`fingerprintOf()`
把 `upstream:<40 位 sha>` 一起哈希，`buildLockBody()` 写进
`.codewiki/engine-lock.json` 的 `upstreamCommit` 字段，`compareLock()` 逐字段比对。
理由：`codewiki 2.0.0` 这个版本号写在 pyproject 里，换 commit 不会变——只看版本会让
「换了引擎源码」静默 match 到旧锁。升级上游 = 改这一个常量 + 重建 venv + 跑契约测试，
指纹与锁会自己漂移，`doctor()` 报 `engine-deps` 直到重新落锁。声明不合法（非 40 位）
时 `doctor()` 的 advice 会明确写「本轮不构成有效锁定」。

### 升级步骤

1. 在 `.probe-fsoft/src` 里 `git fetch && git checkout <新 commit>`，记下
   `git rev-parse HEAD` 与 `git log -1 --format=%ci`。
2. 重解依赖：正常解析必然 `ResolutionImpossible`（`openai` / `pydantic-ai-slim` /
   `pydantic` 约束互相打架），必须用 `python make_locked_requirements.py` 重新生成
   `locked-requirements.txt`，再 `pip install --no-deps -r locked-requirements.txt
   -c constraints.txt`，最后 `pip check` 必须零破损。
3. 跑 `tools/fsoft-engine/setup-env.sh` 从零重建 venv 复核（脚本就是这条流程的固化）。
4. 跑契约与入口测试：`node test-engine-contract.mjs`、`node test-engine-client.mjs`、
   `node test-engine-manifest.mjs`、`node test-engine-python-entry.mjs`、
   `node test-engine-output.mjs`、`node test-engine-quality-gate.mjs`、
   `node test-engine-apply-plan.mjs`。**入口面对上游 API 的假设集中在
   `lib/engine/python/entry.py` 与 `stage_map.py` 两个文件**，升级时先看这两处。
5. 跑真实编译：README「原生引擎通道」里的八场景（全量 → committed stale → 未提交 →
   重命名 → 删除 → 取消 → 失败 → 无变化轮）。至少要有全量 + committed stale + 无变化轮
   三条的真机输出，否则不算验证过。
6. 更新 `docs/fsoft-native-engine.md` 的锁 commit、`README.md` 的验收记录、
   `CHANGELOG.md` 的对应条目，最后 `codewiki_generate(scope=auto)` 重建 wiki。

### 升级时最容易被上游悄悄改掉的四处

| 上游位置（锁版本行号） | 我们依赖的语义 | 破了会怎样 |
| --- | --- | --- |
| `codewiki/src/config.py:121/133/147` | `use_gitignore`、`artifact_exclude`、`exclude_patterns`（读 `agent_instructions`） | 排除清单失效 → 无变化轮重新开始产提交 |
| `codewiki/cli/adapters/doc_generator.py:163` | `agent_instructions` 被透传进 `BackendConfig.from_cli` | 同上 |
| `codewiki/src/be/dependency_analyzer/analysis/repo_analyzer.py:178-200` | `user_exclude_patterns` 合并、`_matches_any` 支持目录整段匹配 | 排除写成 `.codewiki` 但只按文件名匹配，挡不住子树 |
| `codewiki/cli/adapters/doc_generator.py:430-470` | `_last_update_record` 的 `outcome`（`incremental`/`no_change`/`full_fallback`）与 `pages_written`/`pages_removed` | 增量决议与孤儿页判定全部失准 |

### 回滚

原生通道是**运行期开关**，不涉及数据结构迁移，所以回滚只有一步：
把 `nativeEngine` 设为 `false`（或删掉该配置项）即回到 0.14.0 的 Node 流水线。
`.codewiki/_native-state/` 是原生通道的受管状态目录，Node 通道不读它；如要彻底清理，
`git rm -r .codewiki/_native-state .codewiki/engine-lock.json` 后提交即可
（`.codewiki/modules/` 与 `CodeWiki.md` 不受影响，它们两条通道共用）。

若已升级过上游且新版本行为异常，按上表把 venv 重建回锁 commit 的依赖快照：
`.codewiki/engine-lock.json` 会记录 `fingerprint`/`version`/`pythonVersion`，
指纹不匹配时 `doctor` 直接报 `engine-deps` 而**不会自动 pip install**。
