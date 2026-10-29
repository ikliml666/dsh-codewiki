---
title: lib
type: module
source_files:
  - lib/agentic-host.js
  - lib/agentic.js
  - lib/article-contract.js
  - lib/articles-agentic.js
  - lib/change-set.js
  - lib/cluster.js
  - lib/engine/apply-plan.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - lib/engine/quality-gate.js
  - lib/git-paths.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
tags: [lib, agentic, 增量编译, 原生引擎, 符号图, 质量门]
---

## Overview

`lib/` 是 CodeWiki 插件的纯逻辑核心库，包含 26 个文件，分两大块：

1. **插件自有管线**（lib 根目录）：符号提取（`symbols.js`）→ 符号级 diff（`graph-diff.js`）→ 增量判定（`incremental.js`）→ 更新计划（`update-planner.js`）→ 终态记账（`update-record.js`）；LLM 模块聚类（`cluster.js`）；agentic 文章写作（`agentic.js` 纯逻辑 + `agentic-host.js` 宿主适配 + `articles-agentic.js` 执行器）；文章契约闸门（`article-contract.js`）；四路变更采集（`change-set.js`）；git 路径解码（`git-paths.js`）。
2. **FSoft 原生引擎适配**（lib/engine/）：跨进程契约（`contract.js`）、JSON-lines 客户端（`client.js`）、引擎清单/锁（`manifest.js`）、loopback 模型桥（`llm-bridge.js` + `openai-bridge.js`）、产物映射与校验（`mapping.js` / `output.js`）、采用门（`quality-gate.js`）、落地器（`apply-plan.js`）、跨轮受管状态（`native-state.js`）、编排（`native-run.js`）、进程树终止（`process-tree.js`），以及唯一的 Python 代码 `python/entry.py`（+ `stage_map.py`）。

设计原则贯穿全库：

- **纯函数 + 依赖注入**：agentic 循环注入 `streamFn`/`workspace`（`lib/agentic.js:12-15`）、change-set 注入 `execFile`（`lib/change-set.js:15`）、引擎通道全部依赖注入（`lib/engine/native-run.js:19-20`），测试可完全离线。
- **机读契约词表**：所有问题类别（`BLOCKER_KINDS`、`SEVERITY`、`GATE_DEFECT_KINDS` 等）都是稳定枚举，新增只许追加。
- **诚实终态**：done 不许带 blockers、partial 必须带 blockers（`lib/engine/contract.js:122-127`）；基线只有完整成功才推进；「采不到变更」绝不当成「没变化」（`lib/change-set.js:106-107`）。

外部依赖仅两个：`@deepseek-ai/dsh-llm`（`lib/agentic-host.js:11-13`）与装在 `vendor/tree-sitter` 的 web-tree-sitter WASM 语法包（`lib/symbols.js`，不放插件根 node_modules 是因为那里由宿主注入、不能跑 npm install）。

## Key Components

### lib/agentic-host.js — agentic 循环 ↔ 宿主 LLM 适配层

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `SOURCE` | 15 | 插件消息统一标记 `{ kind: 'plugin:codewiki' }` |
| `IDENTITY` | 26 | `WeakMap`：裸消息 → 正式 Message 的身份缓存。工具循环每轮重投同一份 messages，不缓存则同一条消息每步换新 UUID，违反宿主 MessageId "Stable identity" 契约（注释 19-25） |
| `stableKeyFor(role, r, index)` | 29-31 | tool 消息一拆多时的缓存键 `${role}#${index}#${toolCallId}` |
| `toRequestMessages(messages, {provider, model})` | 34-79 | 裸 `{role, content}` → 宿主正式 RequestMessage[]。user/assistant 走缓存（39-57）；assistant 已有 `id` 的直接透传（47-48）；一条 tool 消息装多条结果展开成多条 ToolResultMessage（58-76），结果级缓存存 `Map`（62-63） |
| `makeHostStream({llm, provider, model, reasoningEffort, onDelta, onFinish})` | 83-108 | 造 `streamFn({messages, tools, signal}) → {blocks, finish, usage}`：`BlockAssembler` 收 chunk（86-99）；finish 为 error/aborted 抛错（101-103）；temperature 固定 0（94）；tools 缺 parameters 时补空 object schema（93） |
| `makeFsWorkspace(fs, path, cwd)` | 111-135 | 把工具认的 `{readFile, listDir}` 抽象接到真实 fs；`absOf`（114-118）拒 cwd 外路径（注释 113：符号链接由 `safeRelPath` 先兜一层，这里再兜真实路径） |

### lib/agentic.js — agentic 文章写作（纯逻辑）

对应上游 FSoft 的 read_code_components.py / str_replace_editor.py / generate_sub_module_documentations.py 与 pydantic-ai 工具循环（注释 1-15）。价值主张：给模型一个可反复读码、可精确编辑、可派发子任务的工作台，硬事实现场核对而不是一次性塞 prompt（7-9）。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `TOOL_SCHEMAS` | 27-87 | 四个 JSON Schema：`read_code`（28-42）/ `list_files`（43-53）/ `edit_article`（54-71，view/str_replace/insert）/ `generate_sub_module`（72-86） |
| `MAX_READ_LINES` | 93 | 单次 read_code 行数上限 2000 |
| `MAX_READ_CHARS` | 94-96 | 字符上限 40000（只限行数挡不住压缩产物：单行 20 万字符实测回吐 5.7 万 token） |
| `IGNORED_DIRS` | 97-98 | node_modules/.git/dist/build/.next/target/vendor/__pycache__/.venv/venv 一律不列 |
| `numberLines(text)` | 101-106 | 产出「行号\| 」前缀格式，模型据此引用行号 |
| `makeReadCodeTool(workspace, {seen, getStep})` | 115-177 | 读码 + 去重记账：同一 `(path, 起始行, 结束行)` 再读只回「你已在第 N 步读过」（129-135）；去重发生在读盘前省 IO（123）；原始 key 与夹取后等价 key 双记账（149-152）；行数（156-159）与字符（163-167）双重截断并附提示 |
| `makeListFilesTool(workspace)` | 179-197 | depth 夹取 1-4（183）、IGNORED_DIRS 过滤（190-194）、隐藏计数注记（194） |
| `makeArticleEditor(initial)` | 200-263 | 闭包态文章编辑器。`edit` 支持 view（204-207）/ str_replace（208-229）/ insert（231-254）；str_replace 做行尾归一化——CRLF 仓库里模型按 `\n` 写 old_str 纯字面 indexOf 永不匹配，曾致模型换锚点重试到步数耗尽（212-215）；多处命中报错（223-226）；insert 负行号必须报错而非被 `Math.max` 吞成「插到最前」（233-237）；空文章当零行（244-245）。返回 `{edit, get article, set article}`（258-262） |
| `safeRelPath(rel)` | 266-273 | 拒绝对路径/盘符/`..` 上跳，posix.normalize |
| `buildToolset({...})` | 279-315 | 工具调度表。`generate_sub_module` 在 onSubModule 缺失时按 `subModuleBlocked` 区分 max-depth / unsupported 两种原因**说实话**（290-305）：此前无论什么原因都回「已派发」，模型据此写「详见 xxx.md」造成死链 |
| `DEFAULT_MAX_STEPS` | 325 | 单篇步数上限 = 30，唯一定义点（注释 321-324：此前两处各写 24/30，直调与生产链路行为不一致） |
| `runAgenticArticle(opts)` | 331-432 | 主循环。开场消息（356-361）→ 每步 `streamFn`（371-374）→ assistant blocks 原样进历史（382-383）→ 无 tool-call 即 finished 并兜底收取正文（389-395）→ 执行 calls 回灌 tool-result（398-421）。stopReason ∈ finished/max-steps/aborted/stream-error/empty-response |
| `stripJsonFence(s)` | 439-444 | 剥 \`\`\`json 围栏（不剥的后果：参数退化成 {}，工具空参执行、模型反复重试，434-438） |
| `sliceBalancedObject(s)` | 447-473 | 从任意位置截第一个括号平衡的 JSON 对象（跳过字符串字面量内括号） |
| `parseToolArgs(raw, steps, step, toolName)` | 476-500 | 原样 → 剥围栏 → 截平衡对象三级抢救；全失败记 warning 回 `{}`（498-499），模型只吐标量也按坏参数处理（492-493） |
| `buildOpeningPrompt({...})` | 506-541 | 开场提示词：工具清单、6 步工作方式（518-524）、拆分规则（仅当 generate_sub_module 可用，525-533）、硬要求（不许编造文件/函数/行号 535-538） |

### lib/article-contract.js — 文章契约闸门

背景缺陷（注释 1-12）：旧闸门只查「frontmatter 有没有开合」，重复贴头、空章节、source_files 列不存在文件、死链、围栏未闭合都能入库。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `ARTICLE_CONTRACT_VERSION` | 16 | 契约版本 = 1 |
| `TYPE_BY_DIR` | 19-26 | 目录 → 允许 type（modules/concepts/learnings/decisions/patterns/queries） |
| `ROOT_TYPES` | 28-32 | 根目录特殊文章：`_architecture.md`/`_index.md`/`_patterns.md` |
| `REQUIRED_SECTIONS` | 36-45 | module/architecture 需 Overview+Key Components；其余类型 Overview；index 无要求 |
| `REQUIRED_FIELDS` | 46 | title/type/source_files |
| `SEVERITY` | 56-73 | 问题分级是**闸门行为**分界：error 拒写、warning 放行但终态降 partial；`missing-section`=warning 与 `empty-section`=error 必须分开（54-55） |
| `parseFrontmatter(content)` | 77-90 | 只认文首第一个 `---` 块；返回 `{fields, body, endLine, closed, raw}` |
| `parseYamlLite(raw)` | 94-118 | 极简 YAML：`key: value` 与 `- item` 列表、`[a, b]` 行内数组；不引依赖 |
| `unquote(s)` | 120-135 | 双引号标量先 JSON.parse（YAML 1.2 是 JSON 超集，`"C:\\src"` 这类转义才能正确还原，122-128）；单引号 `''` 是 YAML 专有转义（130-133） |
| `extractSections(body)` | 138-158 | `## ` 章节（围栏内的不算，145-146），返回 `[{title, content, line}]` |
| `fencesBalanced(body)` | 161-164 | ``` 与 ~~~ 成对判定 |
| `collectWikiLinks(body)` | 167-176 | `[[链接]]` 与相对 `.md` 链接目标（排除 `http:` 等 URI scheme） |
| `hasDuplicateFrontmatter(body)` | 179-193 | 正文 40 行窗口内出现第二份含 title:/type: 的 frontmatter |
| `isRepoRelativeFile(p)` | 195-203 | source_files 条目格式判定（目录形态无扩展名即非法） |
| `inspectArticle(content, opts)` | 213-335 | 主入口，返回 issues[]。关键 opts：`readableSources`（source-not-evidence，282-288）、`allowedLinks`（dead-link，323-332）、`requiredSections`（原生引擎通道传 `[]` 只查结构，否则用本仓库章节名判它死刑且每条不可修复，217-224）、`allowEmptySourceFiles`（whole-repository 模式空 source_files 是诚实记录，226-231）、`fsImpl.exists`（missing-source，289-292）。tags 缺字段报 error 但允许空列表（258-262） |
| `issueSummary(issues)` | 338-343 | issues 压成一行人类文案 |
| `hasBlockingIssue(issues)` | 346-348 | 仅 error 级拦落盘 |
| `makeWriteSet(paths)` | 352-355 | agentic 写集编译（null = 不检查） |
| `normalizeWritePath(p)` | 357-361 | 反斜杠转 POSIX + normalize |
| `isWritable(target, writeSet, {cwd})` | 365-378 | 写集判定；相对路径按 cwd 解析后比对，防 `../` 越界 |

### lib/articles-agentic.js — agentic 执行器

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `DEFAULT_MAX_STEPS`（再导出） | 19-21 | 保持既有导入路径可用，避免再出现独立常量 |
| `runOneArticle(task, {...})` | 33-179 | 单篇跑循环并落盘。旧文作 editor 初始内容增量改（58-63）；写集 `allowedWritePaths === undefined` 保持旧行为、`null/[]` 视为「谁都不许写」（65-67）。子模块派发 `dispatchSub`（82-128）：slug 全局唯一防覆盖（71-74，上游 issue #76/#113 教训）、路径 `modules/<父 slug>/<子 slug>.md`（95-96）、子层写集只含它自己那条路径（110-112）、**onSubModule 传 null** 让子层按自身 `_depth` 重建深度判定（113-117，原样下传父层闭包会使 subDepth 封顶形同虚设）。落盘前 `isWritable` 闸门，越界返回 `stopReason:'write-set'` + `writeSetViolation`（151-167） |
| `sourceTokensOf(task, cwd, {...})` | 185-203 | 模块源文本近似 token（CJK 1 字符、其余 3.5 字符/token，与 index.js estimateTokens 同口径）；读不到按 0 计不阻断 |
| `resolveTaskRoute(task, {...})` | 208-222 | 大档任务自带 provider+model 时完全以任务为准；effort 以任务为准，不回落默认档（默认档 effort 如 off 可能不被大档模型支持，206-207） |
| `runAgenticArticles(tasks, {...})` | 231-312 | 并发池：`bigTier === true` 走大档池、其余默认池，两池独立限流（244-255）；worker 循环（257-308）；单任务失败只记账不影响其它（292-303）；`onTaskDone`/`onRequestStart` 钩子 |
| `markBigAgenticTasks(tasks, {bigTier, sizeOf})` | 320-333 | agentic 不装填源码，大档判据改为模块源文本量超 budget（316-318）；未配置 bigTier 原样返回 |

### lib/change-set.js — 变更采集

背景缺陷（注释 1-13）：cw status 只跑 `git diff <base>..HEAD`，未提交修改、暂存区、未跟踪新文件三类改动完全隐形，基线被假前移。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `CHANGE_SET_VERSION` | 20 | 版本 = 1 |
| `WIKI_PRODUCT_PREFIX` | 25 | `.codewiki/` 是 wiki 自身产物，不算源码变更（22-24） |
| `isWikiProduct(relPath)` | 27-30 | 产物路径判定 |
| `normChangePath(p)` | 34-41 | 反斜杠统一 POSIX；绝对路径/`..` 上跳一律丢弃 |
| `parseNameStatus(out)` | 58-77 | `git diff --name-status` 解析：R/C 两列 from→to（65-70）、D 记删除；每条过 `decodeGitPath`（54-57：quotepath 八进制转义会让 `.codewiki/` 前缀匹配失配） |
| `emptyChangeSet(baseCommit, overrides)` | 79-99 | 失败时的空 ChangeSet 骨架 |
| `collectChangeSet(cwd, baseCommit, opts)` | 108-210 | 主入口。无基线 → `missing-base`（110-112）；HEAD 失败区分 no-git / git-error（118-131）；基线被 rebase/GC 掉 → `unreachable-base` 退全量（133-143）；四路采集（committed/staged/unstaged/untracked，157-163）；all 含改名两端（167-181）；「删了又重建同名文件」从 deleted 剔除（184-186）；`sourceChanges` 过滤 wiki 产物（189）。**ok=false 时必带 state+reason+fallback='full'**（106-107） |

ChangeSet 字段（79-99）：`version, ok, state, fallback, reason, baseCommit, headCommit, committed[], staged[], unstaged[], untracked[], deleted[], renamed[{from,path,bucket}], all[], sourceChanges[], ignored[]`。

### lib/cluster.js — LLM 模块聚类

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `formatComponents(components)` | 28-46 | 组件按文件分组的提示词表示（名字+类型+签名，最多 6 参数 41） |
| `ARTIFACT_RE` / `artifactTag` | 48-51 | 构建配置文件标 `(artifact: config)` |
| `clusterPrompt(componentText, totalComponents)` | 57-81 | 全仓库聚类提示词（组件 id `path#name` 必须原样返回） |
| `subClusterPrompt(...)` | 84-103 | 大模块下钻提示词 |
| `superGroupPrompt(modules)` | 106-129 | 平铺模块归组为架构子系统提示词 |
| `parseJsonLoose(text)` | 135-153 | 剥围栏 → 直接 parse → 首 `{` 到尾 `}` → 去尾逗号 |
| `parseClusterResponse(text, validIds, warnings)` | 156-195 | id 校验/去重，返回 `{modules, missing}` |
| `normalizeModuleName(name)` | 198-206 | 模块名转文件名友好形式（进 `<name>.md`） |
| `guessPath(ids)` | 208-212 | 从首组件路径猜模块目录 |
| `heuristicCluster(components)` | 219-244 | 无 LLM 降级：按顶层目录分组；单顶层目录（src/ 布局）下探一层（232-237） |
| `fillMissing(modules, components, missingIds)` | 247-268 | LLM 漏掉的组件按目录归位，无主则建 `misc` |
| `moduleFiles(componentIds, byId)` | 274-281 | 组件 → source_files 文件清单 |
| `DEFAULT_MAX_DEPTH / DEFAULT_SPLIT_THRESHOLD / DEFAULT_TOP_FANOUT` | 287-289 | 2 / 60 / 14 |
| `clusterComponents(opts)` | 291-389 | 主入口：顶层聚类（LLM 失败降级 heuristicCluster，310-324）→ 超大模块逐层下钻（331-344）→ 顶层超 fanout 做超级分组（346-356）→ `finalize` 补 files/children/aggregateFiles（359-375）→ 只有叶子成文（378-386）。返回 `{modules, tree, concepts, warnings, stats, byId}` |
| `subdivide(...)` | 396-422 | 递归下钻：kids.length ≤ 1 且名字未变视为不可再分（403-404）；子模块仍超阈值且未到 maxDepth 才继续（408-415） |
| `parseSuperGroups(text, modules, warnings)` | 425-456 | 没被任何子系统收走的模块留在顶层不凭空消失（453-455） |
| `toPlanModules(result)` | 460-467 | 结果转 index.js 的 job.plan.modules 形状 |

### lib/engine/contract.js — 跨进程契约

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `ENGINE_CONTRACT_VERSION` | 20 | 契约版本 = 1 |
| `ENGINE_STAGES` | 24-33 | 八段枚举 env/graph/cluster/articles/validate/index/baseline/commit（顺序即推进顺序，面板步骤条与取消检查点共用） |
| `TERMINAL_OUTCOMES` | 35 | done/partial/failed/cancelled |
| `UPDATE_OUTCOMES` | 45-50 | incremental / no_change / full_fallback / detector_failure（引擎自报增量结局） |
| `CONSUMING_UPDATE_OUTCOMES` | 53 | 只有 incremental/no_change 算「增量真的成立」 |
| `BLOCKER_KINDS` | 57-72 | 11 种阻塞类别（article-failed/article-missing/unmapped-change/unmapped-page/quality-gate/index-failed/baseline-failed/commit-failed/engine-error/cancelled/incremental-fallback） |
| `ENGINE_ERROR_CODES` | 76-86 | 9 种错误码 |
| `RETRYABLE_CODES` | 90 | engine-timeout / engine-model / engine-unknown 可重试，其余确定性失败 |
| `engineResult(input)` | 116-180 | **构造即校验**：done 带 blockers 抛错（122-124）、partial 无 blockers 抛错（125-127）、failed 缺 error 抛错（128-131）、updateOutcome 未登记抛错（133-141） |
| `engineProgress(input)` | 183-201 | 推进快照；stage 必须在枚举内（184-187），percent 夹 0-100 |
| `engineError(input)` | 204-215 | 未登记 code 归 engine-unknown 并保留 rawCode（205-213） |
| `validateEngineResult(value)` | 219-260 | 反序列化边界校验（磁盘残留/旧版本），不抛返回逐条 errors |
| `describeEngineResult(result)` | 263-280 | 四态人类文案 |

**EngineResult 字段**（143-179）：`contractVersion, outcome, stage, blockers[{kind, detail, target?, source?}], error, writtenCount, failedCount, keptCount, removedCount, unmappedCount, updateOutcome, usage{inputTokens, outputTokens, cachedTokens, requests}, engine{version, commit, python, deps{ok, summary}}, artifacts{docsDir, rawTreeDir, updateRecord}, startedAt, finishedAt`。

### lib/engine/client.js — Node ↔ Python 薄适配

协议不变量（13-20）：stdout 只许 JSON-lines；requestId 是唯一关联键；没有 result = 协议破坏（退出码 0 也救不了）；退出码只表达进程层结果；取消后迟到 result 记 late-result 丢弃；重复 result 先到的赢。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `ENGINE_PROTOCOL_VERSION` | 27 | 协议版本 = 1（独立于结果契约版本） |
| `DEFAULT_MAX_LINE_BYTES` | 29 | 单行上限 4MB |
| `DEFAULT_STDERR_TAIL` | 30 | stderr 尾部保留 4000 字符 |
| `createProtocolReader(options)` | 39-186 | 字节级增量 JSON-lines 读取器：`push(chunk)`（133-156）按字节缓冲，多字节 UTF-8 跨 chunk 不切坏；单行超限丢弃（143-146、151-154）；`handleLine`（56-126）按消息类型分派，违规只记不丢已收结果；`markCancelled()`（164-166）声明取消态；`end()`（169-184）把残留半行记违规并返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}` |
| `spawnPlan(engine, cwd, env)` | 189-199 | 引擎命令描述 → spawn 参数 |
| `runEngine(options)` | 223-422 | 主流程：spawn（POSIX `detached` 独立进程组，288-295）→ 写一行请求 JSON 关 stdin（324-329）→ `Promise.race([exited, timeout, abort, spawnError])`（359）→ 超时杀进程树并 fail engine-timeout（368-374）→ 取消 → markCancelled + 杀树 + 终态 cancelled（376-391）→ 无 result 判 engine-crashed/engine-protocol，**stderr 尾部必须进 message**（403-414）→ 语义 done 但退出码非 0 记 nonzero-exit 违规（416-419） |

### lib/engine/llm-bridge.js + openai-bridge.js — loopback 模型桥

凭证边界（llm-bridge.js:6-17）：桥不读凭证、不接收真 api_key、不转发 Authorization；绑定 127.0.0.1 + 随机端口 + 占位 key 校验三者缺一等于把宿主凭证开放给本机任意进程。日志只记 method/path/状态/耗时，绝不记 Authorization。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `bearerOf(req)` | llm-bridge.js 38-43 | 只用于校验占位 key，取完即弃 |
| `startLlmBridge({llm, provider, model, reasoningEffort, timeoutMs, onLog})` | llm-bridge.js 90-241 | 占位 key 每次启动随机生成（96）；路由 `/healthz`（112-115）、`/v1/models`（128-131）、`POST /v1/chat/completions`（133-218）；key 不匹配 401 且**不回显收到的 key**（120-125）；流式边收边转 SSE 帧（171-188），`[DONE]` 留给收尾（184-186）；客户端断连/超时 abort 上游（162-167）；流已开始后失败用终止帧表达（193-199）。返回 `{url, placeholderKey, port, stats(), close()}` |
| `PLACEHOLDER_KEY_PATTERN` / `isPlaceholderKey` | openai-bridge.js 29-33 | `/^dsh-bridge-[a-z0-9-]+$/` |
| `toLlmRequest({provider, model, reasoningEffort, body})` | openai-bridge.js 128-161 | OpenAI 请求体 → DSH GenerateOptions：system/developer 抽槽（134-146）；assistant 消息**必须**带 `source.kind='model'`——宿主 `LlmRuntime.forAdapter()` 无条件读 `message.source.replayState`，缺 source 直接抛（71-75 注释）；tool_calls 的 arguments 保持原始 JSON 字符串（97-99，提前 parse 破坏增量拼接）；tools[].function → ToolSchema（53-66） |
| `finishReasonToOpenAI(reason)` | openai-bridge.js 164-173 | DSH → OpenAI finish_reason 映射 |
| `usageToOpenAI(usage)` | openai-bridge.js 176-188 | TokenUsage 互斥计数 → OpenAI 语义：`prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 details |
| `chunksToCompletion({id, model, chunks})` | openai-bridge.js 236-256 | chunk 流 → 非流式响应（经 `foldChunks` 192-233 按 index 拼接 tool-call delta、只保留带 name 的调用 222-231）；纯工具调用时 content=null 不是空串（248-249） |
| `chunksToSse({id, model, chunks})` | openai-bridge.js 265-317 | chunk 流 → SSE 帧数组；无 finish 也要补终帧否则引擎流读取挂住（311-314）；流式 finish_reason 与 tool-call 联动（302-306） |
| `sseFrame(payload)` | openai-bridge.js 259-262 | 单帧 `data: ...\n\n` |

### lib/engine/manifest.js — 引擎清单与锁

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `MANIFEST_VERSION` / `ENGINE_LOCK_REL` | 19-20 | 版本 1；`.codewiki/engine-lock.json` |
| `probeEnvironment({probe, engineRoot})` | 34-45 | 探测引擎版本/Python 版本/pip check 并算指纹（probe 注入保持纯函数，27-31） |
| `fingerprintOf(facts)` | 50-56 | 指纹只吃 version + pythonVersion；pip check 不进指纹（依赖闭合是「能不能跑」的闸门，不是「产物会是什么」的输入，47-49） |
| `readLock({repoRoot})` | 61-75 | 读落盘 lock；不存在/坏了返回 null |
| `compareLock({current, lock})` | 86-111 | 四态：absent / match / drift / unhealthy + 逐字段 diffs；指纹一致但 pip check 失败 = unhealthy |
| `buildLockBody(current)` | 125-136 | 构造 lock 正文**不写盘**——落锁时机必须与产物同批进 apply 写集（117-124：直接写盘会落在提交之外，下一轮当未提交改动再提交一次） |
| `writeLock({repoRoot, current})` | 142-150 | 原子写（tmp+rename）；仅独立运行时使用，生产路径用 buildLockBody（见 native-run.js:606-628） |
| `doctor({probe, repoRoot, engineRoot})` | 156-185 | 一次调用判「引擎在不在/环境闭不闭合/有无漂移」；probe 抛错变 probe-failed 不抛异常 |

### lib/engine/mapping.js — FSoft 产物 → cw 写集映射

四条硬规则（16-26）：不臆造 source_files / 不静默丢弃 / slug 冲突不覆盖 / 不改技术内容。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `WIKI_ENTRY` / `WIKI_DIR` / `WIKI_META_REL` / `WIKI_UPDATE_RECORD_REL` / `WIKI_MODULES_REL` | 30-34 | `CodeWiki.md` / `.codewiki` / `.codewiki/_meta.yaml` / `.codewiki/temp/update-record.json` / `.codewiki/modules` |
| `moduleSlug(name)` | 38-44 | 模块名 → kebab-case 文件名 |
| `sourceFilesOf(components, componentFiles)` | 62-72 | source_files 只认组件→文件证据；组件 id `path::Symbol` 取 `::` 前文件部分；无证据不计入（60-61 宁缺勿造） |
| `indexModuleTree(moduleTree)` | 76-96 | `{name: {path, components, children}}` 扁平化索引 |
| `mapFsoftOutput({pages, moduleTree, componentFiles, metadata, updateRecord, overviewName})` | 115-268 | 主入口：overview → 入口页（重复进 unmapped 137-143）；非 md 进 unmapped（148-150）；**whole-repository 模式 module_tree={} 时**：页是真产物进写集但 `attribution='unattributed'`、source_files 空 + warning（153-187）；页名在树中不存在 → unmapped（189-192）；slug 冲突两页都进 unmapped、先占位页也撤下（199-211）；树有模块但无页 → warning（234-242）。article 记录字段（222-231）：`source, wikiPath, type, pageKind(leaf/parent/artifact), moduleName, sourceFiles, attribution, warnings[]` |

### lib/engine/output.js — 产物读取与自洽校验

| 符号 | 用途 |
| --- | --- |
| `OUTPUT_PROBLEM_KINDS` | 11 类：missing-docs-dir / missing-metadata / missing-module-tree / empty-module-tree / bad-json / entry-missing / empty-body / article-missing / unmapped-page / source-missing / dead-link |
| `listMarkdownPages(rootDir, rel)` | **递归**收 md（hierarchical 布局页在子目录）；跳过 temp/ 与隐藏目录 |
| `readJsonIfExists(file, problems, kind, {optional})` | 必需文件缺失/坏 JSON 都报；存在但坏了永远要报 |
| `collectOutput({docsDir})` | 读 docs 成结构化事实 `{docsDir, exists, pages[], json{metadata, moduleTree, firstModuleTree, updateRecord}, problems[]}` |
| `bodyLength(text)` | 剥首个标题后的正文字符数（判「只有标题的空壳页」） |
| `relativeLinks(text)` | 正文相对 md 链接（跳过外链/锚点/data URI） |
| `buildWritePlan({...})` | collectOutput + mapFsoftOutput 组合 |
| `validateOutput({...})` | 校验产物自洽：入口缺失、空 module_tree、逐页空正文、未映射页、模块树有但无页、source_files 存在性、docs 内死链。返回 `{ok, problems, mapped, collected, stats}` |
| `emptyStats()` | `{pages:0, articles:0, unmapped:0, problems:0}` |

### lib/engine/process-tree.js — 受管子进程树终止

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `isAlive(pid)` | 41-49 | `process.kill(pid, 0)` 存在性探测；EPERM 算活着（47） |
| `terminateProcessTree(pid, {graceMs, onLog})` | 61-103 | Windows `taskkill /T /F`（72-79，/T 递归整棵树）；POSIX SIGTERM 进程组（`kill(-pid)`，82-89）→ 宽限后 SIGKILL（94-99）。只杀不启动不做协议，任何取消语义 bug 都在此暴露（13-14） |
| `waitForDeath(pid, timeoutMs)` | 105-113 | 25ms 轮询 |

### lib/engine/python/entry.py — FSoft JSON-lines 薄入口

**不是算法实现**：依赖图/聚类/写作/增量全由 FSoft 做；本文件只做请求分发、进度翻译、终态翻译，并守两条红线：不读本机凭证库、不让 FSoft 打印污染协议流。

关键结构：

- **stdout 守卫**：FSoft 大量 print/click.secho 且 click 缓存 stdout 包装器，事后替换无效；故在 import codewiki **之前** `sys.stdout = _ProtocolOnly()`——`_ProtocolOnly` 类普通 write 全改道 stderr，协议行走保存的 `_REAL_STDOUT`，连 flush 也转。
- **三流钉 UTF-8**：Windows 下 Python 默认 cp936，中文路径请求行会被误解码成乱码；stdout/stderr 用 replace、stdin 用 strict。
- `PROTOCOL_VERSION=1`、`ACTIONS=("doctor","generate","update","cancel")`、模型通道环境变量 `ENV_BASE_URL/ENV_API_KEY/ENV_MAIN_MODEL/ENV_CLUSTER_MODEL`。
- 协议输出：`emit` / `emit_hello` / `emit_progress` / `emit_result` / `failure(code, message, stage, request_id)`。
- `action_doctor(request_id, payload)`：`_engine_version` + `_pip_check(timeout=120)`（装到一半的 venv 会让 FSoft 生成中途崩，先问清楚）；依赖未闭合返回带 engine.deps 证据的 failed。
- `_model_config()`：只读进程环境，不碰 ConfigManager/凭证库；错误信息只说「环境变量」不打印值；`fallback_model` 必须显式给——缺省 None 会让 FSoft 在 `model_name.lower()` 上抛 AttributeError 且崩在 graph 阶段开头。
- `bridge_progress(adapter, request_id, on_stage)`：替换 ProgressTracker 的三个阶段方法做旁路观察（替换而非继承：FSoft 直接构造无注入点）。
- `_count_docs(docs_dir)`：递归清点产物页数（只 glob 根层会漏掉 hierarchical 子树——「1 篇成功 + 19 篇失败也报 done」的误判来源之一）；排除 temp/ 与隐藏目录。
- `action_generate(request_id, payload, is_update)`：config 构造；`updateOptions` 显式传入；`commitId` 记账（落进 metadata.json 的 generation_info.commit_id = 下一轮 old_commit）；`CLIDocumentationGenerator` 实例化并跑 `generate()`；`SystemExit` code 0 视为正常完成（FSoft 无变更路径会 sys.exit(0)）；缺页 → partial + article-missing blockers；usage 从 job.statistics.usage_totals 取。
- `_update_outcome_of(adapter)`：增量结局取自引擎 `_last_update_record`；拿不到返回 None 而非编造（区分「引擎没说」与「引擎说回退了」）。
- `_state_files(docs_dir)`：只报磁盘真实存在的跨轮状态文件（顶层 *.json、temp/reference_index.json、temp/artifact_index.json、temp/dependency_graphs/*），供上层交叉核对——白名单写错会把「引擎没产出依赖图」误记成已持久化。
- `_done_result(...)`（含 `artifacts.stateFiles` 与 `updateOutcome`）；`_classify_exception(exc, ...)`：按异常**类型**分类——IncompleteGenerationError → partial + article-missing、APIError → engine-model、RepositoryError → engine-missing、KeyboardInterrupt → cancelled、其余 engine-crashed；`_cancelled_result(...)`。
- `handle_request(msg)`：**平铺 payload 优先、嵌套 payload 兜底**（曾只读 `msg["payload"]`，真引擎的 repoPath/docsDir/commitId 全丢——docsDir 丢失 → 增量轮把状态目录写回自身，长出 `_native-state/docs/_native-state/docs/...` 自嵌套；假引擎按平铺读所以测试看不出来）。
- `main()`：hello → 读一行请求 → result；顶层 KeyboardInterrupt 也尽量回 cancelled。

### lib/engine/python/stage_map.py — 进度映射

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `ENGINE_STAGES` | 20-29 | 与 contract.js 双向对账（测试反向断言集合一致，9-11） |
| `FSOFT_STAGE_NAMES` / `FSOFT_STAGE_WEIGHTS` | 33-46 | FSoft ProgressTracker 五段镜像（权重保持一致否则进度条在阶段交界跳变） |
| `FSOFT_TO_ENGINE` | 50-56 | 五段 → 八段：1→graph、2→cluster、3→articles、4/5→validate（HTML 不做、finalization 是收口，48-49） |
| `DEFAULT_ENGINE_STAGE` | 60 | 未知阶段归 articles（第 3 段最耗时最需可见，58-59） |
| `FSOFT_PROGRESS_CEILING` | 63 | 引擎进度上限 90%——剩 10% 留给 Node 侧 index/baseline/commit，避免「引擎说 100% 但 wiki 还没提交」的假完成（12-16） |
| `map_stage(fsoft_stage)` | 66-72 | 阶段号 → 契约阶段名 |
| `percent_of(fsoft_stage, stage_progress)` | 75-97 | 与 FSoft get_overall_progress 同构的加权计算，夹 [0,100] |

### lib/engine/quality-gate.js — 采用门

三类问题必须分开：**defect** = 本次产物自身的问题；**degradation** = 产物可用但证据不足（页照写、基线不推进）；**stale** = wiki 状态陈旧（不是本次的错）。

| 符号 | 用途 |
| --- | --- |
| `GATE_VERSION` | 版本 = 1 |
| `GATE_DEFECT_KINDS` | 13 类（missing-docs-dir … uncommitted-input） |
| `GATE_DEGRADATION_KINDS` | empty-module-tree / no-source-evidence / missing-section / empty-section-optional |
| `GATE_STALE_KINDS` | baseline-behind-head / baseline-uncommitted / baseline-absent |
| `NATIVE_REQUIRED_SECTIONS` | `[]`——原生通道章节名由上游 prompt 决定（`## Introduction and Purpose` 等），用本仓库 Overview/Key Components 判它等于每条不可修复 warning、闸门退化成噪声 |
| `readCommittedBaseline({repoRoot})` | 读 `git show HEAD:.codewiki/_meta.yaml` 而非工作区文件——未提交基线不能当已消化；返回 `{ok, source, commit, worktreeCommit, dirty, reason}` |
| `uncommittedSourceChanges({repoRoot})` | git status porcelain 解析，排除 wiki 自身路径 |
| `assessBaseline({...})` | commit_id 必须是 40 位 sha 且 == HEAD；工作区有未提交源码 → uncommitted-input defect；stale 里只有 baseline-uncommitted 阻止推进 |
| `yamlScalar(value)` | YAML 标量安全序列化：只在确实不安全时 JSON.stringify 引号化（`: `、` #`、保留字 true/false/null、数字形、反斜杠、控制字符、首尾空格等）——serde_yaml 对 plain scalar 的解析陷阱 |
| `titleOf(bodyText, fallback)` | 正文 H1 → frontmatter title |
| `renderArticle({article, body})` | 合成 frontmatter + FSoft 原文**一字不动**；`fsoft_page` 记溯源；结束 `---` 后**不插空行**——保证「wiki 里这篇 = 引擎产出的那篇」可逐字复核 |
| `checkRendered({content, article, cwd, fsoftPage})` | inspectArticle（requiredSections=[]、allowEmptySourceFiles=true）+ 剥掉自己合成的 frontmatter 后再算 bodyLength（直接喂全文会把 8 行 frontmatter 当正文，空壳页判不出） |
| `gateNativeOutput({...})` | 主入口：validateOutput 分流（empty-module-tree 是 degradation 不是 defect）→ 入口检查 → 逐篇渲染 + 契约（空 source_files → no-source-evidence degradation）→ assessBaseline → **三类皆空才 done**。返回 GateReport |
| `toContractBlockers(report)` | gate blockers → contract BLOCKER_KINDS（TO_CONTRACT_KIND，对不上一律 quality-gate 宁粗勿漏） |
| `toQualityIssues(report)` | gate 结论 → judgeOutcome 的 qualityIssues——两条判定路径不能一个严一个松 |

**GateReport 字段**：`version, ok, outcome, writable, canAdvanceBaseline, entry, articles[{source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, action(write/skip), defects, degradations}], rendered[{source, wikiPath, type, content}], defects[], degradations[], stale[], blockers[], counts{pages, articles, writable, skipped, unmapped, defects, degradations, stale}, baseline{headCommit, artifactCommit, source}`。

### lib/engine/apply-plan.js — 落地器

三条硬不变量（10-22）：**写集封闭**（只准写 `.codewiki/` 与 `CodeWiki.md`，坏路径整批拒不逐条跳）；**索引/基线失败即回滚**；**提交失败不回滚**（文章本身是好的）。

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `APPLY_VERSION` / `APPLY_WRITE_ROOTS` / `APPLY_STAGES` | 44-50 | 版本 1；写集白名单 `['.codewiki', 'CodeWiki.md']`；落地阶段 write/index/baseline/commit |
| `APPLY_PROBLEM_KINDS` / `APPLY_RESULT_KINDS` | 53-74 | 写集校验 6 类 / 落地结果 8 类（含 gate-partial：不许把裁决 partial 洗成 done，71-74） |
| `checkWriteTargets(items)` | 87-132 | 空路径/绝对路径/`..` 上跳/白名单外/重复且内容不同/content 非字符串——整批拒写（80-84：残缺写集落盘后缺的那几篇没人知道，比整批拒危险） |
| `capturePre(repoRoot, rels)` / `restorePre(snapshot)` | 139-177 | pre-image 快照与回滚（逆序恢复 160；pre-image 不存在 = 本次新建，回滚即删除 167-171） |
| `writeAll(repoRoot, targets)` | 179-194 | 内容与磁盘逐字节相同的不重写——避免 mtime 抖动与「无改动轮」变假提交（184-187） |
| `verifyCommitScope(repoRoot, sha, {...})` | 234-247 | `git show --name-only` 反查提交内容是否只含 wiki 路径（pathspec 有了 ≠ 提交里真的只有，224-227） |
| `commitWikiArtifacts(cwd, {...})` | 260-308 | 内置提交器：merge/rebase/cherry-pick 进行中拒绝（275-278）；`.codewiki/` 被 .gitignore 忽略时拒绝（280-284）；无 HEAD 拒绝（274）；pathspec 限定两路径（293-295）；`--no-verify` 不跑仓库钩子（301-302）。安全边界逐条对齐 index.js 的 autoCommitWiki（248-255） |
| `toApplyBlockers(problems)` | 322-333 | → contract BLOCKER_KINDS（TO_CONTRACT_KIND 311-320；未登记 kind 直接抛错 326） |
| `findArticlesMissingFromIndex(repoRoot, written)` | 351-372 | **cw index 对 frontmatter 解析失败静默 continue 且 exit 0**（336-343、905-910：serde_yaml 把 `title: 核心: 引擎` 当嵌套映射 → 索引只剩占位文字但退出码 0）；按 `_index.md` 链接反查缺页 |
| `collectPruneTargets(repoRoot, pruneRoots, keepRels)` | 505-519 | 受管状态目录里「本次写集没有的」都删——留着会让下一轮水合复活旧页/旧图（493-498）；裁剪根必须落在白名单内（510-512） |
| `pruneEmptyDirs` / `normalizeIndexLinksIn` | 523-568 | 删空目录；`_index.md` 链接头 `\` → `/`（cw 在 Windows 写出 `[[modules\a|x]]` 会让 stale 判定与链接校验按不同字符串比较同一篇，542-544） |
| `applyNativeOutput({...})` | 602-1003 | 主流程：writable 检查（674-678）→ 收集写集（文章 + extraFiles + 入口页，688-731）→ checkWriteTargets 整批拒（733-740）→ dryRun（743-748）→ pre-image 含 `_index.md`/`_meta.yaml`/裁剪对象（757-793）→ 缺 `_meta.yaml` 先 `cw init`（795-818；有 .codewiki 却没 _meta.yaml = 人工破坏的半截库，拒绝自动初始化 801-806）→ 写盘 + 裁剪 + 清空目录（820-864）→ `cw index`（866-883）→ 链接规范化失败按索引失败回滚（884-903）→ **缺页反查**（905-924）→ `cw meta update` 基线（926-955，失败连文章一起回滚——「文章比基线新」会让下一轮重复消费，926-929）→ 自动提交（957-989，失败不回滚；未提交在任何分支下都不许 done，984-989） |

**ApplyResult 字段**（626-644）：`version, startedAt, repoRoot, applied, outcome, written[], pruned[], deleted[], entry, index, baseline, commit, rolledBack, problems[], blockers[], notes[], canAdvanceBaseline, finishedAt`（另有合并进来的 `ok, unchangedFiles, dryRun` 等）。

### lib/engine/native-state.js — 跨轮受管状态

为什么必须有：FSoft 组件级增量要读上一轮的 module_tree.json / 依赖图 / metadata.json / 旧文章四样东西，缺任何一样 `_update_options()` 返回 None → 每轮白退全量。

| 符号 | 用途 |
| --- | --- |
| `NATIVE_STATE_VERSION` / `NATIVE_STATE_DIR` / `NATIVE_STATE_FILE` | 版本 1；`.codewiki/_native-state/`（首段以 `_` 开头——`cw index` 只跳过 `_` 开头路径，否则持久化的原始文章会被收成第二份文章）；`state.json` |
| `STATE_REQUIRED_DOCS` | `['module_tree.json', 'metadata.json']`（引擎增量硬依赖） |
| `STATE_TEMP_FILES` / `STATE_TEMP_DIRS` | temp/ 白名单（reference_index、artifact_index、dependency_graphs） |
| `graphFileName(repoRoot)` | 依赖图文件名必须逐字符对齐 Python `sanitize_repo_name`——它用 Unicode `isalnum()`，故这里用 `\p{L}\p{N}` 而非 `[A-Za-z0-9]`（后者把中文仓库名的图判缺失 → 每轮白退全量） |
| `isStateDocPath(rel)` | 哪些 docs 文件进受管状态（所有 .md / 顶层 .json / temp 白名单 / 其他子目录） |
| `stateDocFiles(stateDir)` | 状态文件仓库相对路径清单（审计用） |
| `readState(stateDir, repoRoot)` | 反序列化边界必须被检查：absent/unreadable/corrupt/version 四类失败都显式带 reason |
| `readStateText` | 原始文本（字节比较用） |
| `isUpdateEligible({...})` | 能不能增量：硬依赖缺失 / 引擎版本变更 → eligible:false + reason（「悄悄退全量」会让用户以为增量生效）；基线不一致仍 eligible 但记 reason |
| `hydrateDocsDir({stateDir, repoRoot, docsDir})` | **复制**不是移动：源在仓库受 git 管理，目标在临时目录被引擎就地改写；移动会让本轮失败毁掉下一轮输入 |
| `captureDocsDir({docsDir, stateDir})` | 采集引擎产物 → `{rel, content}` 写集（非 utf8 检测 U+FFFD；硬依赖缺失单独报） |
| `buildStatePayload({...})` | 组装 state.json。**不记录本轮结局**——结局权威在 `_meta.yaml`，state.json 在 apply 前落盘，写结局就得 apply 后再改文件、造出第二个提交 |
| `stateFileItem(payload, stateDir)` | state.json 作为一条写集项 |
| `stateFingerprint(text)` | 去掉 updatedAt/notes 的实质指纹——防「无变化轮因时间戳变化产生空转提交」 |
| `mergeUnconsumed({changeSet, prevUnconsumed})` | 未提交改动的账：已读进产物但没进 commit 的路径（staged/unstaged/untracked）一直携带，直到出现在 `git diff base..HEAD` 才算消费成立；否则「文章已覆盖未提交改动、基线停在 HEAD」，下一轮这些改动再也算不进变化集 |

**state.json 字段**：`stateVersion, repoRoot, consumedRange{baseCommit, headCommit}, pendingChanges{state, baseCommit, headCommit, committed, staged, unstaged, untracked, deleted, renamed, reason}, unconsumed, engineVersion, scope, effectiveScope, updateOutcome, fallbackReason, notes, updatedAt`。

### lib/engine/native-run.js — 原生编译编排

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `DEFAULT_ENGINE_ENTRY` | 57-58 | `python/entry.py` 绝对路径 |
| `DEFAULT_UPDATE_OPTIONS` | 63-68 | `{ rung: '3' }`——显式组件级增量而非留空靠引擎内部默认（上游改默认就等于增量语义静默漂移） |
| `DEFAULT_ENGINE_TIMEOUT_MS` | 70-72 | 45 分钟 |
| `RANK` / `weakest(a, b)` | 74-76 | 终态强弱：合成只能取最弱，绝不允许被后续步骤提升 |
| `RESOLUTION` | 87 | full / update。**变化集为空不是跳过引擎的理由**——「有没有变」由引擎图 diff 说了算（重命名/跨文件重构能让路径集非空而图不变，80-86） |
| `applyBlockersOf(applyRes)` | 90-96 | apply blockers → 契约形状 |
| `runNativeJob({...})` | 111-815 | 主编排。统一出口 `settle`（141-175）：所有分支都过 `engineResult` 硬校验，`canAdvanceBaseline = outcome === 'done'`，增量现场证据 `incremental` 随终态出去。流程：① env：doctor + lock（184-277），probe-failed/drift/unhealthy 直接 failed 不跑引擎（230-269）；锁不在 doctor 阶段写——会让 `.codewiki/` 早于 `cw init` 存在、落地器判 wiki-missing 整批失败（270-277）。② 增量决议（284-380）：collectChangeSet + mergeUnconsumed + isUpdateEligible → update 则 hydrateDocsDir（水合不进独立 docsDir 会污染用户库，315-318）；决议现场进 `inc`（362-380）。③ 模型桥（382-408）；引擎 action update/generate **不可互换**（411-421）；桥在 finally 里关（455-458，先关桥引擎还在读流会拿 502）。④ gate（504-527）。⑤ 受管状态采集（529-604）：`idleRound` = update + no_change + 变化集空 + 无未消费账（537-547），无变化轮不重写状态不裁剪（否则每次状态查询制造一次纯记账提交）；引擎自报 stateFiles 与实际采集交叉核对（554-562）；stateFingerprint 相同沿用旧文本（593-596）；首落锁进写集（606-628）。⑥ apply（661-693，前置孤儿页扫描 630-659；`pruneRoots` 只在非 idleRound 给 `[<stateDir>/docs]`，677-681）。⑦ 终态合成（695-814）：`weakest(engine, gate, apply)`（712）；gate/apply blockers 一律进终态（713-720，曾只带注入 gate 的 blockers 等于老缺陷换位置复发）；增量降级/引擎自报回退 → incremental-fallback blocker（终态非 done 才加，726-735）；done 带 blockers 降 partial（736-741） |

### lib/git-paths.js — git 路径解码

| 符号 | 用途 |
| --- | --- |
| `GIT_QUOTEPATH_OFF` | `['-c', 'core.quotepath=false']`（必须紧跟 git 之后子命令之前） |
| `withQuotepathOff(args)` | 参数表前置 quotepath 关闭（幂等） |
| `decodeGitPath(p)` | 解开八进制转义：**按字节**重拼 Buffer 再 UTF-8 解码（一个中文字符是三个 `\NNN`）；非「双引号包裹转义串」幂等原样返回；不认识的转义保留反斜杠本体不猜 |
| `decodeGitPaths(list)` | 清单整体解码（保序、丢空行） |

### lib/graph-diff.js — 符号级增量 diff

移植自 FSoft codewiki/src/be/updater/graph_diff.py：最值钱的判定全是纯标准库算法，逐位移植保持纯 Node、零外部运行时、判定精度与上游一致。

| 符号 | 用途 |
| --- | --- |
| `CLASS_ADDED/DELETED/IFACE/BODY/EDGE/RENAMED` | 六种变更类 |
| `DIFF_TRUNCATED_MARKER` | diff 截断标记 |
| `TOKEN` | `\p{L}\p{N}` 还原 Python `\w` 的 Unicode 语义——JS 的 `\w` 会把中文按字切碎、相似度整体偏高 |
| `normalizeBody(text)` | trim + 空白归一 |
| `stripComments(text)` | 剥注释与装饰空白（区分「只改注释」与「实质变化」）；字符串内 `//` 误剥是可接受近似 |
| `stripTrailingComment(line)` | 引号外的行注释（跟踪三种引号与转义，`"http://x"` 不误判）；`#` 只在行首/空白后才算注释 |
| `codeHash(node)` | 代码本体哈希（剥注释）——**不含 docstring**：普通注释是噪音，docstring 是有意义文档 |
| `documentedSource(node)` | 源码 + docstring（Rust `///` 在节点外） |
| `bodyHash(node)` | 整段哈希；快照回读无源码时用固化哈希 |
| `signature(node)` / `signatureChanged(a, b)` | name + parameters + baseClasses |
| difflib 移植 | `buildB2J`/`findLongestMatch`/`getMatchingBlocks`（autojunk=False 逐位对齐）/ `sequenceRatio` |
| `bodySimilarity(a, b)` | token 序列 ratio |
| `approxTokens` / `truncateToTokens` | token 估算与首尾截断 |
| `unifiedDiff(...)` / `unifiedBodyDiff(oldNode, newNode, label)` | difflib.unified_diff 移植（splitKeepEnds/getOpcodes/getGroupedOpcodes/rangeUnified）；上游 unified_body_diff 上下文 2 行 |
| `DEFAULT_TAU_REN` / `DEFAULT_MAX_DIFF_TOKENS` | 0.8 / 2000 |
| `pairRenames(deleted, added, oldGraph, newGraph, tauRen)` | 改名配对：body 相似度贪心最佳匹配；长度比预过滤 `tauRen*0.9` 够不到阈值就跳过 |
| `emptyGraphDiff()` / `graphDiffCounts(d)` / `changedIds(d)` / `isDiffEmpty(d)` | diff 容器与统计 |
| `diffGraphs(oldGraph, newGraph, opts)` | 主入口：同名组件按 签名变→interface > 实现变→body > 仅依赖变→edge 分类，records 带 old/newSignature、edgesAdded/Removed、截断后的 unified diff；deleted+added 配对成 renamed；added/deleted 生成独立 records |
| `serializeDiff(d)` | Set/Map → 数组（落盘与对拍） |

### lib/incremental.js — 图快照与文件级判定

| 符号 | 用途 |
| --- | --- |
| `SNAPSHOT_VERSION` / `SNAPSHOT_REL` | 版本 1；`temp/symbol-graph.json`（随 wiki 入库，换机器不退化成全量） |
| `SLIM_FIELDS` | 快照瘦身字段——**不存 sourceCode**（.codewiki/ 会进仓库），bodyHash/codeHash 固化 |
| `slimComponent(node)` / `slimGraph(graph, {...})` | 现场节点算一次哈希固化进快照 |
| `sameSnapshotContent(a, b)` | 忽略 generatedAt/commit 的实质比较——代码没变不覆盖快照，否则 autoCommit 为「只改时间戳」生成空转提交 |
| `graphFromSnapshot(snap)` | 快照 → Map（graph-diff 直接输入） |
| `snapshotPath` / `loadSnapshot` / `saveSnapshot` | 版本不符当没有——宁可重写不误判 |
| `normRel(p)` | 路径归一（`temp/module-map.json` 等多处引用） |
| `componentsByFile(graph)` | 文件 → 组件 id 清单 |
| `filterStaleTasks(tasks, oldGraph, newGraph, opts)` | 核心判定（纯函数）：diff → realChanged；**纯注释降级**（bodyHash 变但 codeHash 未变且 docstring 未变 → cosmeticOnly，只降 body 类，interface/added/deleted/renamed 一律放行）；无符号可判的文章保守 keep；只命中 cosmetic 的 dropped 带原因 |
| `describeChange(counts)` | 「接口变 N、新增 N…」摘要 |

### lib/symbols.js — AST 级符号提取

| 符号 | 用途 |
| --- | --- |
| `DEFAULT_VENDOR_DIR` | `vendor/tree-sitter`（独立 npm 根） |
| `LANG_RULES` | 16 种语言的声明化规则表（javascript/typescript/python/rust/go/java/c/cpp/csharp/ruby/php/kotlin/scala/dart/bash/lua）——上游每语言一个 800 行 Python 模块，这里加语言只加一行。含容器/函数节点类型、名称/参数字段、imports、docstring 取法（python `first_string_in_body`、rust `preceding_line_comment`）、Go `receiverField` |
| `SUPPORTED_EXTS` | 扩展名 → 语言 Map |
| `WASM_FILE_OVERRIDE` / `wasmFileFor` | csharp 的 wasm 文件名是 `tree-sitter-c_sharp` |
| `REGEX_RULES` / `regexExtract(relPath, content, lang)` | 正则兜底：WASM 语法没装/ABI 不匹配时的「有损但不丢」路径（早期直接 return [] 导致整块语言静默消失，日志只见 skipped +N）；跳过块注释；类优先于函数；符号源码取「定义行到下一定义行」末符号最多 60 行；`REGEX_MAX_LINES = 4000` |
| `parseParamList(text)` | 顶层逗号切分（跳过嵌套括号/泛型）、去默认值与类型标注 |
| `SymbolExtractor` 类 | 解析器池（语法只加载一次）：`constructor`（parsers Map + stats）/ `vendorImport`（createRequire 从 vendor 树解析）/ `init`（惰性导入 web-tree-sitter，依赖没装插件照常启动）/ `getParser`（语法加载失败记 null 降级）/ `resolveWasmDir` / `extractFile`（AST 失败或**零符号**都退正则兜底并记 `stats.regex`）/ `walk`（容器+成员方法成组；C/C++ 函数名与参数在 function_declarator 子节点需下探；Go 方法名拼接收者类型；箭头函数赋值）/ `findArrow` / `findDeclarator` / `stripCallSuffix` / `fieldText` / `parseParams` / `parseBases` / `sliceSource`（按节点字节区间多字节安全）/ `extractDoc`（python docstring 与 rust `///`）/ `componentId`（`relPath#name`，方法为 `relPath#Class.method`） |
| `extractRepoGraph(files, opts)` | 批量提取 → `{graph, byFile, skipped, extractor, ready, stats}` |
| `resolveImportEdges(graph, byFile, files)` | import → 仓库内相对路径 → 落到组件 `dependsOn`（文件级边，调用级边留待扩充） |
| `IMPORT_RE` / `extractImportSpecs` / `resolveSpec` | 多语言 import 正则；spec 解析：相对路径尝试多扩展名与 index 文件、Python 点号模块 `a.b.c → a/b/c.py`、Rust `crate::` 与 C 头文件按 basename 匹配 |

组件记录形状（与 graph-diff 契约一致）：`{id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn}`。

### lib/update-planner.js — 增量计划器

背景缺陷：旧实现只回答「这篇要不要重写」——反向依赖看不见、新文件无归属、未重写页不做 stale scan。本模块升级为每篇显式 action（write/keep/delete/review）+ reason，无归属变更单独列出绝不静默丢弃。

| 符号 | 用途 |
| --- | --- |
| `UPDATE_PLAN_VERSION` / `MODULE_MAP_VERSION` / `MODULE_MAP_REL` | 版本 1；`temp/module-map.json` |
| `isSourcePath(p)` | 只看扩展名；非源码文件（笔记/文档）无归属只记 warning 不触发全量重编 |
| `commonDir(a, b)` | 最长公共目录（至少一级才算同模块） |
| `realChangedIds(diff, oldGraph, newGraph, {...})` | 与 incremental.js 同一套纯注释降级（复用 codeHash）；`structural` = interface/added/deleted/renamed/edge |
| `dependentsOf(graph, ids)` | 反向依赖索引；dependsOn 里的组件 id 与文件路径两种形态都认 |
| `scanStaleArticle(article, {...})` | 单篇 stale scan：正文引用已删/已改名符号（文章通常写名字非完整 id）；wiki 死链；引用已删/改名符号 → needsRewrite，死链只 review |
| `planUpdate({...})` | 主入口（纯函数）：structural 反向依赖闭包 → `impactByFile`（只对 structural 做——实现细节变了不该连带重写所有引用方）；逐篇判定链：文件删除/改名 → write；无符号可判 → 文件级降级；ownHit/depHit → write；stale scan → write/review/keep；无归属变更按公共目录最长前缀路由给最相关文章；`needsFull` 只算**源码**变更；图里没有任何 dependsOn 边时如实警告反向依赖不可用；**必需清单 = write 动作**（把 keep 算进必需曾让完整成功落 partial） |
| `buildModuleMap({...})` | 文章 → 源码/组件/模块关系（模块归属优先取 full plan，其次 source_files 公共目录） |
| `migrateModuleMap({...})` | 旧 wiki 无 module-map 时从 frontmatter 保守迁移（绝不因缺文件当无归属） |
| `sameModuleMap(a, b)` | 实质比较（忽略 generatedAt） |

**UpdatePlan 字段**：`version, fileLevel, changedComponents[], cosmeticComponents[], structuralComponents[], counts, actions[{name, articlePath, sources, changedComponents, impactedBy, reasons, action, reason, newFiles?, staleIssues?, needsFull?, fileLevel?}], summary{write, keep, delete, review}, unmappedChanges[], unmappedSourceChanges[], routedTo[{file, name}], missingSources[], missingRequired[], requiredNames[], warnings[], needsFull, fullReason, hasChanges`。

### lib/update-record.js — 更新记录

| 符号 | 用途 |
| --- | --- |
| `UPDATE_RECORD_VERSION` / `UPDATE_RECORD_REL` | 版本 1；`temp/update-record.json` |
| `TERMINAL` / `isTerminalStage(stage)` | done/partial/failed/cancelled 四态语义 |
| `judgeOutcome({plan, results, options})` | 终态判定：缺页与失败分开记（处置不同）；unmapped 只算源码——非源码文件无文章引用是常态，混进来会让正常增量永远 partial；qualityIssues / indexOk / extraBlockers；0 篇成功且有失败/缺页/阻塞才 failed，写过一部分就是 partial；`canAdvanceBaseline = outcome==='done' && blockers 空` |
| `buildUpdateRecord({...})` | ChangeSet + Plan + 逐篇结果收成版本化记录（job 里只存路径与摘要不塞整图） |
| `recordPath` / `saveUpdateRecord` / `loadUpdateRecord` | 路径与读写（版本不符返回 null） |
| `describeOutcome(outcome, blockers)` | 三态文案（与 describeEngineResult 同口径） |

**UpdateRecord 字段**：`version, jobId, scope, startedAt, finishedAt, baseCommit, headCommit, changeSet{state, ok, fallback, reason, counts{committed, staged, unstaged, untracked, deleted, renamed, ignored}, sourceChanges[], ignored[]}, plan{version, fileLevel, needsFull, fullReason, summary, counts, changedComponents[], cosmeticComponents[], structuralComponents[], actions[{name, action, reason, sources, changedComponents, impactedBy, newFiles, staleIssues}], unmappedChanges[], routedTo[], missingSources[], warnings[]}, results[{name, ok, stopReason, error}], qualityIssues[{name, issue}], outcome, blockers[], canAdvanceBaseline, writtenCount, failedCount, notes[], wikiPath`。

## Architecture

```text
┌──────────────── lib/ 纯逻辑库（插件自有通道） ────────────────┐
│ symbols.js ─组件图─► graph-diff.js ─diff─► incremental.js     │
│                             │               │                 │
│ change-set.js ─四路变更─┐   │               ▼                 │
│ git-paths.js ─路径解码─┘   ▼                                 │
│              update-planner.js ─计划─► update-record.js       │
│ cluster.js ─聚类─► articles-agentic.js ─► agentic.js          │
│                          ▲                    ▲               │
│   agentic-host.js ───────┘        article-contract.js（闸门）│
└──────────────────────────────┬───────────────────────────────┘
                               ▼ runNativeJob
┌──────────────── lib/engine/ 原生引擎通道 ────────────────────┐
│ manifest.js(doctor) ─► llm-bridge+openai-bridge(loopback 桥)  │
│ native-run.js ─► client.js ─JSON-lines─► python/entry.py      │
│      │                              (FSoft, stage_map.py)     │
│      ▼                                                        │
│ output.js+mapping.js ─► quality-gate.js ─裁决─► apply-plan.js │
│ native-state.js ──┘                │ cw index / meta / commit │
└──────────────────────────────► .codewiki/ + CodeWiki.md ◄─────┘
```

分层要点：

- **判定与执行分离**：符号提取、diff、计划、终态判定全是纯函数；IO 集中在各自的末尾。
- **两条执行通道**：插件自有 agentic 通道（模型自己读码写作）与 FSoft 原生通道（引擎整树产出后映射+落地）。`article-contract.js` 是两者共用的文章格式闸门（`quality-gate.js` 复用 `inspectArticle`）。
- **裁决链直线化**（native-run.js:76-79）：env → 引擎 → validate(gate) → index/baseline/commit(apply)，每一步的结论都不能被下一步洗白；终态取 `weakest(engine, gate, apply)`（native-run.js:712）。
- **依赖注入边界**：`apply-plan.js` 刻意不 import index.js（加载它会拉起宿主服务与 webServer，24-27），默认自带同语义提交器 `commitWikiArtifacts`（29-34），阶段 4 由 index.js 注入 `runCw`/`autoCommitWiki` 替换。

## Data Flow

### 通道 A：插件自有 agentic 编译

1. `collectChangeSet`（change-set.js:108）四路采集变更，`.codewiki/` 产物被排除进 `ignored`（change-set.js:189-190）。
2. `extractRepoGraph` 用 tree-sitter WASM 提取组件图；AST 不可用或零符号时退 `regexExtract`，import 语句解析成组件 `dependsOn` 边。
3. 增量判定：`loadSnapshot` 读旧图 → `filterStaleTasks` 或 `planUpdate` 产出 write/keep/review 计划；无归属源码变更 → `needsFull` 退全量。
4. `clusterComponents`（cluster.js:291）LLM 聚类出模块树（失败降级 `heuristicCluster`），只有叶子模块成文。
5. `runAgenticArticles`（articles-agentic.js:231）双池并发 → `runOneArticle` → `runAgenticArticle`（agentic.js:331）工具循环：`read_code`/`list_files` 读源码、`edit_article` 增量写文、`generate_sub_module` 派发子任务；streamFn 由 `makeHostStream`（agentic-host.js:83）适配宿主 `llm.stream`。
6. 落盘：写集闸门 `isWritable`（articles-agentic.js:155-167）→ `fixAnchors` → `writeFileSync`；契约由 `inspectArticle`（article-contract.js:213）在外层判。
7. `judgeOutcome` 判 done/partial/failed → `buildUpdateRecord` 落 `temp/update-record.json`。

### 通道 B：FSoft 原生编译（`runNativeJob`，native-run.js:111）

1. **env**：doctor（manifest.js:156）探测版本 + pip check + 与 engine-lock 比对；drift/unhealthy 直接 failed，不跑引擎（native-run.js:244-269）。
2. **增量决议**：`collectChangeSet` + `mergeUnconsumed` + `isUpdateEligible` → full 或 update；update 则 `hydrateDocsDir` 把上一轮状态**复制**进独立 docsDir。
3. **模型桥**：`startLlmBridge`（llm-bridge.js:90）起 `127.0.0.1:<随机端口>` 端点；entry.py 从环境变量读 `CODEWIKI_BASE_URL/API_KEY`，FSoft 的 OpenAI 客户端打向桥，桥转成宿主 `llm.stream`（真凭证全程只在宿主内）。
4. **引擎**：`runEngine`（client.js:223）spawn entry.py，写一行请求 JSON；entry.py 调 `CLIDocumentationGenerator`，进度经 stage_map.py 映射成八段协议行；引擎自报 `updateOutcome` 与 `stateFiles`。
5. **gate**：`gateNativeOutput` = 产物自洽 + 渲染（frontmatter 合成、正文一字不动）+ 契约 + 基线裁决，产出 defect/degradation/stale 三分类。
6. **apply**：`applyNativeOutput`（apply-plan.js:602）写盘 → `cw index`（含缺页反查回滚）→ `cw meta update` 基线 → `commitWikiArtifacts`；受管状态（`captureDocsDir` + state.json + 首落锁）作为 `extraFiles` 与文章**同事务**写/回滚/提交（native-run.js:529-628）。
7. **终态**：`weakest(engine, gate, apply)`；增量降级记 `incremental-fallback` blocker；partial/failed 一律不推进基线。

## Connections

- [[index]]：插件主入口，是 lib 全部导出的最终消费者——Config 的 `agenticMaxSteps` 必须与 `DEFAULT_MAX_STEPS`（agentic.js:325）一致（agentic.js:321-324 记录了曾两处各写 24/30 的缺陷）；原生通道由它注入 `runCw`/`autoCommitWiki`/`normalizeIndexLinks`（apply-plan.js:26-34、540-549）。
- [[tests]]：lib 的「纯逻辑 + 依赖注入」设计直接服务离线单测——cluster 注入 `llmCall`（cluster.js:20）、agentic 注入 `streamFn`/假 workspace（agentic.js:12-15）、change-set 注入 `execFile`（change-set.js:15）、client 用假引擎逐字节喂协议（client.js:13）、apply 注入 `deps.runCw/commit`（apply-plan.js:24-27）。
- 外部依赖：`@deepseek-ai/dsh-llm`（BlockAssembler 与三种 Message 构造器，agentic-host.js:11-13）；`vendor/tree-sitter` 下的 web-tree-sitter 与 `tree-sitter-wasms`（symbols.js）；上游实现对照 FSoft-AI4Code/CodeWiki（cluster.js:1-3、agentic.js:1-5）。

## Known Issues

- **模型重复读同一大文件**：实测 index.js 一次探针被读 13 次、累计上下文 2.1MB、步数全耗在读码（agentic.js:108-114）。修复：read_code 工具侧按 `(path, 起始行, 结束行)` 记账，重复读只回「你已在第 N 步读过」。
- **CRLF 让 str_replace 永不匹配**：真实仓库 `core.autocrlf=true`，模型按 view 输出写 `\n` old_str 而文章存 `\r\n`，模型反复换锚点直到步数耗尽（agentic.js:212-215）。修复：匹配前两侧行尾统一 `\n`，命中后按原文风格写回。
- **JSON 围栏包裹的工具参数**：一律解析失败 → 参数退化 `{}` → 工具空参执行 → 模型重试同一错（agentic.js:476-480）。修复：`parseToolArgs` 三级抢救（476-500）。
- **generate_sub_module 谎报成功**：无论什么原因不可用都回「已派发」，模型在父文写「详见 xxx.md」造成死链且父任务仍记 ok（agentic.js:290-294）。修复：区分 max-depth / unsupported 如实报错并指示「写成普通小节」。另：dispatchSub 闭包原样下传会使子层永远用父层深度判定、subDepth 封顶失效（articles-agentic.js:113-117）。
- **子模块重名互相覆盖**（上游 issue #76/#113）：同一次父任务共享已用名集合，重名加前缀、仍重则跳过（articles-agentic.js:71-74）。
- **旧契约闸门只查 frontmatter 开合**：重复贴头/空章节/死链/坏围栏全入库（article-contract.js:213-224）；`inspectArticle` 现按 16 类问题分级拦截。
- **cw index 缺页静默成功**：frontmatter 解析失败就 continue 且 exitCode 0（apply-plan.js:351-358、905-910）。修复：`findArticlesMissingFromIndex` 反查 `_index.md`，缺页按索引失败整体回滚。
- **git quotepath 转义**：非 ASCII 路径默认输出成 `"a/\344\270\255.md"`，按字面量比较的代码全部失配（git-paths.js）；apply 的提交范围校验必须 `withQuotepathOff`（apply-plan.js:211-218），否则中文模块名的合法产物会被判「混进 wiki 之外」整轮拉成 partial。
- **未提交改动对增量隐形**：cw status 只看 committed diff，改完就编译会把未消化的变化当已消化（change-set.js:1-13）；native 侧用 state.json 的 `unconsumed` 账本携带直到真的进 commit。
- **0.14.0「1 篇成功 + 19 篇失败也报 done」**：由此确立 contract.js 硬不变量（done 无 blockers / partial 必有 blockers，122-131）、apply 三不变量（apply-plan.js:10-22）、gate 三分类与终态取最弱（native-run.js:712）。
- **FSoft 打印污染协议流**：click 缓存 stdout 包装器，事后替换无效；必须在 import 前接管 `sys.stdout`。Windows cp936 编码让中文路径请求行变乱码；三流钉 UTF-8。
- **嵌套 payload 读取 bug**：entry.py 曾只读 `msg["payload"]`，真引擎按平铺发送导致 repoPath/docsDir/commitId 全丢，docsDir 自嵌套长出重复页；假引擎按平铺读所以测试看不出来——现两种形状都认。
- **engine-lock 落盘时机**：在 doctor 阶段直接写盘会让 `.codewiki/` 早于 `cw init` 存在，落地器判 wiki-missing 拒初始化、首次编译整批失败还回滚（native-run.js:270-277）；改为与产物同事务进写集（native-run.js:606-628、manifest.js:117-124）。
- **状态目录命名**：放在 `.codewiki/temp/native-state/` 会被 cw index 收成第二份文章（同页两条链接）；必须 `.codewiki/_native-state/`。
- **中文仓库名的依赖图被判缺失**：Python `sanitize_repo_name` 是 Unicode 感知，JS 侧用 `[A-Za-z0-9]` 会对不上文件名 → 每轮白退全量。
- **无变化轮空转提交**：state.json 的 `updatedAt` 与引擎 metadata 的 commit_id 每轮都变，照写就产生纯记账提交（native-run.js:537-547）；修复：`stateFingerprint` 相同沿用旧文本 + `idleRound` 三条件短路。
- **WASM 语法不可用时静默丢语言**：早期 AST 路径直接 `return []`，整块语言从模块划分消失；现退正则兜底并记 `stats.regex`。
- **反向依赖/新文件/stale 三类丢失**：util 变签名引用方不重写、新文件被静默丢、未重写页引用已删符号；planUpdate 以显式 action + reason + unmappedChanges 兜底。
- **模型桥关闭顺序**：先关桥会让还在读流的引擎拿 502；桥在 `finally` 中引擎退出后才关（native-run.js:455-458）。
- **消息身份漂移**：工具循环每轮重造 Message 会换新 UUID，违反宿主 MessageId 稳定身份契约（agentic-host.js:26-32）；`IDENTITY` WeakMap 缓存修复，循环结束自动释放。
