# FSoft 原生引擎：契约与映射

> 本文件是编译链路的**冻结契约**，任何实现必须服从它；改契约要改版本号并同步
> `lib/engine/contract.js`。

## 架构

编译只有一条通道：上游 FSoft-AI4Code/CodeWiki 的 Python 引擎，外面包一层薄适配。
职责切分（不重叠）：

| 归属 | 负责 |
| --- | --- |
| FSoft 引擎（Python，锁定上游 commit） | 依赖图、模块树、artifact 采集、文章写作、组件级增量（updater rung 3）、update_record |
| mraza `cw`（Rust CLI） | `init` / `status` / `index` / `meta update` / 索引与基线 |
| DSH 插件（Node） | 宿主模型通道、JobService、排队/取消/恢复、面板、自动提交、安全边界 |

`nativeEngine` 是编译开关，默认 `true`；关掉后不编译——没有替代实现。

## 版本化契约

契约常量见 `lib/engine/contract.js:23-96`，校验逻辑见 `lib/engine/contract.js:160-220`。

### EngineResult

一次 `generate` / `update` 的完整结果。`contractVersion` 固定为 `3`
（改契约必须同步升 `lib/engine/contract.js` 的 `ENGINE_CONTRACT_VERSION` 与
`lib/engine/python/entry.py` 的 `CONTRACT_VERSION`）。

```jsonc
{
  "contractVersion": 3,
  "outcome": "done|partial|failed|cancelled",
  "stage": "env|graph|cluster|articles|proofread|validate|index|baseline|commit|null",
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

`engine-timeout` 必须留在枚举里：`client.js` 判「超时但有进度 → partial」时把它当
blocker 用，枚举里没有它时 `normalizeBlocker` 会静默降级成 `engine-error`，
于是「跑到一半被超时砍掉」与「引擎自己崩了」在终态和面板里长得一模一样。

`error.code` 决定重试语义（`ENGINE_ERROR_CODES`）：`engine-timeout`、`engine-model`、
`engine-unknown` 可重试；其余（`engine-missing`、`engine-deps`、`engine-crashed`、
`engine-protocol`、`engine-output`、`engine-cancelled`）视为确定性失败。
未登记的 code 归到 `engine-unknown`，原文留在 `rawCode` 里供排障。

### EngineProgress

推进中的阶段快照，tick 与面板共用同一份：`stage` 必须在 `ENGINE_STAGES` 内
（`env → graph → cluster → articles → proofread → validate → index → baseline → commit`），
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
入口（`lib/engine/python/entry.py`）同时接受 `{payload:{...}}` 嵌套形状与平铺形状，**平铺优先**。
两种形状都认是硬要求：只认嵌套会让 `docsDir` 丢失，引擎回退写 `.codewiki`，
增量轮把受管状态水合成 `_native-state/docs/_native-state/docs/…` 逐轮自嵌套。

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

实现在 `lib/engine/mapping.js`。

| FSoft 产物 | 落到 | 类型 |
| --- | --- | --- |
| `overview.md` | `CodeWiki.md`（入口） | 不是文章 |
| `{Module_Name}.md` | `.codewiki/modules/<kebab-slug>.md` | `type: module` |
| `module_tree.json` | 不落盘，只作 `source_files` 证据 | — |
| `metadata.json` | `.codewiki/_meta.yaml`（`last_compiled_commit`/layout/language） | — |
| `update_record.json` | `.codewiki/temp/update-record.json`（原样搬运） | — |
| artifact 页 | 同上模块页，`pageKind: artifact` | 不冒充业务模块 |
| 父模块页（有 children） | 同上模块页，`pageKind: parent` | 不平铺成叶页 |
| TechDocs 站点（`techdocs=true` 时） | `.codewiki/_techdocs/` | 不是文章 |

四条硬规则：

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
  单一判据不能放宽：「`partial` 且写了文章也推进」会把「没消化完」记成已消化，与落地器
  的「`partial` 不推基线」自相矛盾（门说可推、落地器照写、终态报 partial）。
  「超时被砍 → 基线不动 → 下一轮重来 → 又超时」的死循环由质量门的 `isEmptyBaseline()`
  解决：本轮刚 `cw init` 出来的空骨架（无编译提交、来源是 `worktree-only` 或 `git-head`）
  判 `baseline-absent` 直接放行，首次编译因此能走成 `done` 并正常推进基线。
  判据实现见 `lib/engine/quality-gate.js` 的 `baselineEligible`，两者必须一致；
- 自动提交仍只 `git add -- .codewiki CodeWiki.md`，pathspec 边界不变。

## TechDocs 导出

上游 PR #155 把「把写好的文档导出成 Backstage TechDocs 站点」做成了引擎能力：
`codewiki/cli/techdocs_generator.py` 读一份引擎产物目录，产出 `mkdocs.yml` + `docs/`，
每页加 front matter、来源横幅（commit/日期/模型）与可折叠组件清单。**纯文件转换，不调模型**，
所以接在引擎之后跑不增加 token 成本。

插件侧开关是 `techdocs`（默认 `false`）。打开后：

1. `index.js` 在仓库外建临时站点目录 `os.tmpdir()/dsh-codewiki-techdocs-<jobId>`，随
   payload 的 `techdocsDir` 下发；
2. `entry.py` 把它转成 `CLIDocumentationGenerator(techdocs_dir=…)`，上游在
   `_run_backend_generation()` 之后、`_finalize_job()` 之前导出；
3. `lib/engine/techdocs.js` 的 `captureSite()` 把站点读成 `{rel, content}` 写集，
   `native-run.js` 段 3.8 把它们并进本轮 `stateFiles`，由落地器与文章**同一个事务**
   写进 `.codewiki/_techdocs/`。

三条设计约束：

- **站点目录必须在仓库外**。让上游直接写 `.codewiki/_techdocs/` 会绕过落地器的写集封闭
  与回滚：一次失败的编译会留下半截站点，而落地器不知道它存在也不会回滚它。
- **二进制走不了写集**。落地器的 extraFiles 通道要求 `content` 是字符串
  （`apply-plan.js:1148`），所以 png/jpg 等图片不进站点，`captureSite()` 把它们记进
  `skipped`。当前上游只复制页面与图片，实际影响 = 文章里引用的图片在站点里缺图。
- **只有真的读到站点才把 `_techdocs` 加进裁剪根**（`pruneRoots`）。否则一次导出失败，
  裁剪会把上一轮整站删光，而这一轮什么也没写。

`.codewiki/_techdocs/` 以 `_` 开头，因此与 `_native-state/` 一样：`cw index` 跳过整棵子树
（`vendor/codewiki/src/main.rs:244` 只判仓库相对路径首段）、孤儿页与索引收录校验都不管它、
`lib/change-set.js` 的 `isWikiProduct` 也不会把站点改动算成源码变化。它随编译一起提交，
不进 wiki 索引。

## 关键机制

### 工作区快照

FSoft 的 `generate.py` 只从 `<old_commit>..<new_commit>` 取 diff，未提交改动不进
`update_record`。插件侧 `lib/change-set.js` 采四路变更（committed/staged/unstaged/untracked），
由 Node 把工作区变更合成一棵真实的树（临时 commit）交给引擎，而不是让 FSoft 去读工作区。

实现见 `lib/engine/workspace-snapshot.js` 与 `lib/engine/native-run.js` 的 1.9 段：

1. `staged`/`unstaged`/`untracked` 任一路非空时，用**独立的临时 index**
   （`GIT_INDEX_FILE` 指向 `os.tmpdir()`，不碰用户 index）跑 `read-tree <parent>` →
   `add -A -- .` → `write-tree`，再用 `commit-tree` 造一个挂在 HEAD 上的 commit。
   **不写任何 ref**：`HEAD` 不变，工作区仍然脏，`git diff --cached` 仍然空。
2. 本轮交给引擎的 `commitId` 改成这个快照 sha（无快照时仍用 HEAD），`metadata.json` 的
   `generation_info.commit_id` 与实际产物内容对齐。下一轮拿它当 `old_commit`，
   未提交改动不会被当成已消化。
3. 质量门按 `consumedInputCommit` 认可产物对得上快照，但 `uncommitted-input` 照旧判
   defect：快照不挂 ref，把它记成已提交基线不可逆，终态仍 `partial`、基线不推进。
4. 造不出快照不算失败——退回用 HEAD 记账并记 note。快照是对齐精度的改进，不是编译成立的前提。

### 取消与超时

`lib/engine/process-tree.js` 的 `terminateProcessTree` 用 `taskkill /T /F` 终止整棵进程树
（不是只 kill 父进程），并核对 `rootAlive` 与残留进程数。引擎的**语义失败与进程退出码分离**：
引擎抛 `APIError: ... exceed the request_limit` 时 CLI 退出码非 0，但 Node 侧只看 `result`
消息，不会被误导。

### 真机上才能暴露的约束

这些是踩过之后固化成代码的，不是推测：

| 约束 | 落点 |
| --- | --- |
| 非 ASCII 路径被 `core.quotepath` 转义误判越界 | `lib/git-paths.js` 统一 `-c core.quotepath=false` 并解码历史转义串 |
| 引擎锁必须在自动提交之前进写集 | 否则落不进提交、留成脏文件 |
| 原生通道的更新记录写到仓库外 | `os.tmpdir()/dsh-codewiki-native-records/<jobId>/`，否则每轮留 `?? .codewiki/temp/update-record.json` |
| 协议字段平铺与嵌套都要认 | 见「接口面」；只认嵌套会让 `docsDir` 丢失 |
| 入口 stdin/stdout 必须 UTF-8 | 否则中文路径读成乱码、`text=True` 子进程用 gbk 解 UTF-8 报 `UnicodeDecodeError` |
| `.codewiki/_meta.yaml` 必须排除出源码面 | 否则图 diff 永远非空、永远 `incremental`，每轮一笔纯记账提交 |
| 删除模块后要扫孤儿页 | 上游可能回 `full_fallback` 且 `pages_removed: []`，靠 `findOrphanPages()` 补 |


## 上游同步

上游仓库 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)，
**锁定 commit `a1b9f4acac4d3e1925c9d49e258b618741410540`**（2026-11-05，
`Merge pull request #155 from FSoft-AI4Code/feat/techdocs-output`），
该源码树自报 `codewiki.__version__ = 2.0.0`。

选择这个 commit 的理由：它带 TechDocs 导出（`cli/techdocs_generator.py` 与
`cli/commands/techdocs.py`），且**没有触及本插件依赖的任何内部模块**——
`updater.py`、`agent_orchestrator.py`、`generate_sub_module_documentations.py`、
`call_graph_analyzer` 一行未动，运行时适配器的两处源码锚点（`IncrementalUpdater._run`
的 Step 5 段、`DocumentationGenerator._generate_modules_in_order`）仍然命中。

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
4. **入口面对上游 API 的假设集中在 `lib/engine/python/entry.py` 与 `stage_map.py`
   两个文件**，升级时先看这两处。可执行的复核手段：
   - `pip check` 必须零破损；
   - 起一个 venv 里的 Python，import `CLIDocumentationGenerator` 并打印
     `inspect.signature(__init__)`，确认入口传的每个关键字参数都还在；
   - 跑 `install_full_runtime(1)` / `install_incremental_runtime()`，两处源码锚点不命中
     会直接抛「源码锚点不匹配，拒绝安装运行时适配」；
   - 跑 no-LLM 依赖图探针（不花模型费，只验引擎能算图）：
     `PYTHONIOENCODING=utf-8 <venv>/Scripts/python.exe tools/fsoft-engine/probe-no-llm-graph.py --fsoft-src .probe-fsoft/src`，
     输出 `"ok": true` 且 R1–R5 五条判据全 `true` 才算过。
5. 跑真实编译：全量 → committed stale → 未提交 → 重命名 → 删除 → 取消 → 失败 →
   无变化轮。至少要有全量 + committed stale + 无变化轮三条的真机输出，否则不算验证过。
6. 更新本文件的锁 commit 与 `CHANGELOG.md` 的对应条目，最后
   `codewiki_generate(scope=auto)` 重建 wiki。

### 升级时最容易被上游悄悄改掉的四处

| 上游位置（锁版本行号） | 我们依赖的语义 | 破了会怎样 |
| --- | --- | --- |
| `codewiki/src/config.py:121/133/147` | `use_gitignore`、`artifact_exclude`、`exclude_patterns`（读 `agent_instructions`） | 排除清单失效 → 无变化轮重新开始产提交 |
| `codewiki/cli/adapters/doc_generator.py:163` | `agent_instructions` 被透传进 `BackendConfig.from_cli` | 同上 |
| `codewiki/src/be/dependency_analyzer/analysis/repo_analyzer.py:178-200` | `user_exclude_patterns` 合并、`_matches_any` 支持目录整段匹配 | 排除写成 `.codewiki` 但只按文件名匹配，挡不住子树 |
| `codewiki/cli/adapters/doc_generator.py:430-470` | `_last_update_record` 的 `outcome`（`incremental`/`no_change`/`full_fallback`）与 `pages_written`/`pages_removed` | 增量决议与孤儿页判定全部失准 |

### 回滚

编译不涉及数据结构迁移，回滚只有一件事：把引擎锁与受管状态一起清掉再重编。

```
git rm -r .codewiki/_native-state .codewiki/_techdocs .codewiki/engine-lock.json
```

清掉后下一次编译按首次编译处理（`.codewiki/modules/` 与 `CodeWiki.md` 不受影响）。

若已升级过上游且新版本行为异常，按上表把 venv 重建回锁 commit 的依赖快照：
`.codewiki/engine-lock.json` 会记录 `fingerprint`/`version`/`pythonVersion`，
指纹不匹配时 `doctor` 直接报 `engine-deps` 而**不会自动 pip install**。
