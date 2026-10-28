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

**不长期维护两套编译器**：迁移完成后删除 Node 侧的 cluster/graph-diff/incremental/
update-planner 路径（阶段 7），旧实现只作为回退保留到真实验收通过为止。

## 版本化契约

契约常量见 `lib/engine/contract.js:23-96`，校验逻辑见 `lib/engine/contract.js:160-220`。

### EngineResult

一次 `generate` / `update` 的完整结果。`contractVersion` 固定为 `1`。

```jsonc
{
  "contractVersion": 1,
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
`engine-error` / `cancelled`。

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
| `doctor` | `{cwd}` | `{ok, engine:{version,commit,python}, checks:[{name,ok,detail}]}` | 校验解释器、venv、依赖锁定、`pip check`、入口可导入 |
| `generate` | `{cwd, scope, language, model:{baseUrl,model,apiKey}}` | `EngineResult` | 全量；`scope=full` 强制重编 |
| `update` | `{cwd, scope, compareTo?}` | `EngineResult` | 增量；`--update` + `--compare-to` |
| `cancel` | `{requestId}` | `{cancelled:boolean}` | 终止受管子进程树（不是只 kill 父进程） |

协议约束：

- stdout **只**允许 JSON-lines（每行一个 `{type:'progress'|'result'|'error', ...}`），
  引擎自身的日志一律走 stderr，二者绝不混流；
- 每条消息带 `requestId`，Node 侧按 id 关联；乱序/未知 id 记 `engine-protocol`；
- 退出码只表达进程层结果（0 正常结束、非 0 崩溃），**语义结果只看 `result` 消息**——
  这样「进程正常退出但引擎报 failed」不会被误读成成功。

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
- `.codewiki/_meta.yaml` 的 `last_compiled_commit` 只在 `EngineResult.outcome === 'done'`
  时才允许推进（partial/failed/cancelled 一律不动），与 0.14.0 的基线不变量一致；
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

三段门禁已在本机实测通过。环境与 fixture 都在插件仓库**之外**（`.probe-fsoft`），
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
| 工作区变更 | 改名 `normalize` → `normalizeTask` 但**不提交** | — | FSoft 只认 committed diff，此路不通（见下） |

未变页面保留：`core_engine` 页 mtime 未动，说明增量没有重写无关文章。

**工作区变更这条是 FSoft 的真实限制，不是薄桥缺陷**：`generate.py` 只从
`<old_commit>..<new_commit>` 取 diff，未提交改动不进 `update_record`。插件侧的
`lib/change-set.js`（0.14.0 已实现）本来就能采四路变更，所以阶段 5 的做法是
**由 Node 侧把工作区变更合成一个临时 change-set 交给引擎**，而不是让 FSoft 去读工作区。

取消与异常退出：`lib/engine/process-tree.js` 的 `terminateProcessTree` 在真实模型
调用中途（桥请求计数 196→197 的那一瞬）用 `taskkill /T /F` 终止整棵进程树，
204 ms 返回 `{ok:true, rootAlive:false}`，子进程退出码 1，残留 `codewiki` 进程 0 个。
异常退出路径用 `--request-limit 1` 强制触发：引擎抛
`APIError: Documentation generation failed: The next request would exceed the
request_limit of 1`，CLI 退出码 4——**语义失败与进程退出码分离**，Node 侧只看
`result` 消息不会被误导。
