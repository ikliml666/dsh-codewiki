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
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - lib/engine/quality-gate.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
tags: [agentic-writing, engine-bridge, incremental-update, quality-gate]
---

## Overview

`lib/` 是 CodeWiki 插件的全部核心库代码，共 23 个文件，分为四个子系统：

1. **Agentic 文章写作通道**（`lib/agentic.js` + `lib/agentic-host.js` + `lib/articles-agentic.js`）：模型不是“把所有源码塞进一次 prompt 求一篇文章”，而是拿到一个可反复读代码、可对文章做精确编辑、可把大模块拆给子任务的工作台（`lib/agentic.js:7-9`）。工具循环写成纯逻辑 + 注入 `streamFn`/工具实现，不绑死 pydantic-ai 也不绑死宿主 llm 服务，测试可完全离线（`lib/agentic.js:12-15`）。
2. **FSoft 原生引擎桥接**（`lib/engine/*`，12 个文件）：把 FSoft-AI4Code/CodeWiki 的 Python 引擎作为外部进程接入。迁移后 Node 不再自己算依赖图/聚类/增量，一切都来自 Python 引擎的一次返回，所以第一件事是把跨进程契约（`EngineResult`/`EngineProgress`/`EngineError`）钉死（`lib/engine/contract.js:1-18`）。
3. **符号级增量**（`lib/symbols.js` + `lib/graph-diff.js` + `lib/incremental.js` + `lib/update-planner.js` + `lib/update-record.js` + `lib/change-set.js`）：判断“这次改动到底要不要重写某篇文章”。上游 updater 用组件级 hash + 签名比对把“只改了注释”这类变更过滤掉（`lib/incremental.js:3-6`）。
4. **共享闸门**（`lib/article-contract.js` + `lib/cluster.js`）：文章契约检查与 LLM 模块聚类，被两条写作通道共用。

几乎所有模块都遵循同一写法：**纯函数 + 依赖注入**（`execFile`/`fs`/`streamFn`/`probe`/`runCw` 都可注入），使每层都能离线单测；每个模块头部注释都记录了它要修的真实缺陷（如 0.14.0 的“1 篇成功 + 19 篇失败也报 done”）。

## Key Components

### 文件清单

| 文件 | 职责 |
|---|---|
| `lib/agentic.js` | agentic 写作纯逻辑：工具 Schema、工具实现、循环本体、参数抢救、开场提示词 |
| `lib/agentic-host.js` | 工具循环 ↔ 宿主 llm 服务的适配层（消息形态、chunk 收块） |
| `lib/articles-agentic.js` | agentic 执行器：单篇落盘、子模块递归、并发池、大档打标 |
| `lib/article-contract.js` | 文章契约闸门：frontmatter/章节/围栏/死链/写集 |
| `lib/change-set.js` | 一次编译的变更采集：committed/staged/unstaged/untracked 四路合一 |
| `lib/cluster.js` | LLM 驱动的模块聚类（顶层聚类 → 下钻 → 超级分组） |
| `lib/engine/contract.js` | 引擎跨进程契约（阶段/终态/阻塞/错误码枚举与校验） |
| `lib/engine/client.js` | Node↔Python 薄适配：受管子进程 + JSON-lines 协议 |
| `lib/engine/llm-bridge.js` | 宿主模型 loopback HTTP 桥（凭证不外泄） |
| `lib/engine/openai-bridge.js` | OpenAI-compatible ↔ DSH LLM 纯转换层（无 I/O） |
| `lib/engine/manifest.js` | 引擎清单/doctor：版本+Python 指纹、lock 比对 |
| `lib/engine/mapping.js` | FSoft docs 树 → `.codewiki/` 写集的格式翻译 |
| `lib/engine/output.js` | 引擎产物读取与自洽性校验 |
| `lib/engine/quality-gate.js` | 采用裁决：defect / degradation / stale 三分类 |
| `lib/engine/apply-plan.js` | 落地器：写盘 → `cw index` → 基线 → 自动提交，失败按不变量回滚 |
| `lib/engine/process-tree.js` | 受管子进程树的跨平台终止 |
| `lib/engine/python/entry.py` | FSoft 引擎的 JSON-lines 薄入口 |
| `lib/engine/python/stage_map.py` | FSoft 五段进度 → 引擎八段契约映射 |
| `lib/graph-diff.js` | 符号级增量 diff（difflib 逐位移植） |
| `lib/symbols.js` | web-tree-sitter AST 符号提取 + 正则降级 |
| `lib/incremental.js` | 图快照存取与“要不要重写”判定 |
| `lib/update-planner.js` | 增量计划器：write/keep/delete/review + module-map |
| `lib/update-record.js` | 更新记录：终态判定与可机读 JSON |

### lib/agentic.js —— 工具循环纯逻辑

| 成员 | 行号 | 说明 |
|---|---|---|
| `TOOL_SCHEMAS` | 27-87 | 四个工具的 JSON Schema：`read_code`（29-42，要求行号引用以返回前缀为准）、`list_files`（43-53）、`edit_article`（54-71，view/str_replace/insert 三命令）、`generate_sub_module`（72-86） |
| `MAX_READ_LINES` | 93 | 单次 `read_code` 行数上限 2000 |
| `MAX_READ_CHARS` | 96 | 字符上限 40000（≈11k token）；只限行数挡不住压缩产物——实测单行 20 万字符的文件一次回吐 5.7 万 token（94-95 注释） |
| `IGNORED_DIRS` | 98 | `list_files` 一律不列 `node_modules`/`.git`/`dist` 等，模型看到就会当源码去读（97 注释） |
| `numberLines(text)` | 101-106 | 加「行号| 」前缀，与插件其余环节格式一致 |
| `makeReadCodeTool(workspace, opts)` | 115-177 | `read_code` 实现：**重复读抑制**——同一 `(path, 起始行, 结束行)` 再读只回「你已在第 N 步读过这段」（129-135）；去重发生在读盘之前（123 注释）；原始 key 与“夹取后等价 key”都记上（149-152）；行数截断（156-159）与字符截断（163-167）分别记账 |
| `makeListFilesTool(workspace)` | 179-197 | `list_files` 实现：depth 夹取 1..4（183）、过滤 `IGNORED_DIRS`（191）、隐藏目录数写进返回文本（194） |
| `makeArticleEditor(initial)` | 200-263 | `edit_article` 实现，状态就在闭包里（199 注释）：`view`（204-207，空文返回「文章当前为空」）、`str_replace`（208-229，匹配前把两侧行尾统一成 `\n` 再按原文 CRLF 风格写回，216-228；old_str 必须唯一，多处命中报错 223-226）、`insert`（231-255，负行号报错而非静默吞成插到最前 233-237；空文章 `split` 出 `['']` 当零行处理 244-245）；`article` 有 getter/setter（260-261） |
| `safeRelPath(rel)` | 266-273 | 拒绝绝对路径/盘符/`..` 上跳，`path.posix.normalize` 归一 |
| `buildToolset(...)` | 279-315 | 工具调度表；`getStep` 让 `read_code` 报真实步号（281）；`generate_sub_module` 在不可派发时**说实话**：`subModuleBlocked === 'max-depth'` 与“模式不支持”分别给可行动的指示，绝不回「已派发」制造死链（290-305） |
| `DEFAULT_MAX_STEPS` | 325 | =30，步数上限**唯一定义点**；此前两处各写一个常量（24/30）导致同一配置两种行为（321-324 注释） |
| `runAgenticArticle(opts)` | 331-432 | 循环本体：契约 `{mission, workspace, streamFn, tools?, maxSteps}` → `{article, steps, usedTools, stopReason}`（17-19）；步号刷新（350/368）；只声明实际可用的工具（353-354）；assistant blocks 原样进历史否则对不上 callId（382-383）；无工具调用 = 写完，editor 还空但正文有货时收下正文（389-395）；工具结果作为 tool-result 消息回灌（397-421） |
| `stripJsonFence(s)` | 439-444 | 剥 \`\`\`json 围栏；不剥的后果是参数退化成 `{}`、模型反复重试同一错（434-438 注释） |
| `sliceBalancedObject(s)` | 447-473 | 截取首个括号平衡的 `{...}`，跳过字符串字面量里的括号（446） |
| `parseToolArgs(raw, steps, step, toolName)` | 476-500 | 「原样 → 剥围栏 → 截取平衡对象」三级递进；模型只吐字符串/数字也算坏参数（492-493）；失败记 warning 返回 `{}`，不中断循环（475 注释） |
| `buildOpeningPrompt(...)` | 506-541 | 开场提示词：工作方式 6 步（518-524）、拆分规则（525-533，<3 组件一律自己写完）、硬要求（535-539：不许编造文件/函数/行号；不许用围栏包整篇） |

### lib/agentic-host.js —— 宿主适配层

| 成员 | 行号 | 说明 |
|---|---|---|
| `SOURCE` | 15 | `{ kind: 'plugin:codewiki' }`，所有构造消息的 source |
| `IDENTITY` | 26 | WeakMap 缓存裸消息 → 正式消息。宿主对 MessageId 的要求是 "Stable identity preserved across every representation boundary"（`message.d.ts:126`，见 19-25 注释）；循环每轮重丢同一份 messages，不缓存则同一条消息每步换新 UUID |
| `stableKeyFor(role, r, index)` | 29-31 | tool 一拆多时的缓存键（带 `toolCallId`） |
| `toRequestMessages(messages, opts)` | 34-79 | 裸消息 → 宿主 `RequestMessage[]`：user/assistant 走缓存（39-57）；已有 id 的 assistant 直接透传避免重复造身份（47-48）；一条 tool 消息装多条结果 → 每条结果一条消息（58-75，循环里“一轮多个调用”的展开点） |
| `makeHostStream({llm, provider, model, ...})` | 83-108 | 构造 `streamFn`：`llm.stream` → `BlockAssembler` 收 blocks（86-99）；`finish.kind === 'error'/'aborted'` 抛错（100-103）；temperature 固定 0（94）；`onDelta`/`onFinish` 回调失败不影响写作（98/105） |
| `makeFsWorkspace(fs, path, cwd)` | 111-135 | agentic 工具只认 `readFile`/`listDir`（110）；`absOf`（114-118）先挡相对路径越界，符号链接逃逸由 `safeRelPath` 再兜一层（113 注释）；`listDir` 返回 `{path, dir}` 并拼好相对路径（125-133） |

### lib/articles-agentic.js —— 执行器与并发池

| 成员 | 行号 | 说明 |
|---|---|---|
| `DEFAULT_MAX_STEPS` 再导出 | 21 | 唯一定义点在 `lib/agentic.js`，这里再导出保持既有导入路径（19-20 注释） |
| `runOneArticle(task, opts)` | 33-179 | 单篇跑一次 agentic 循环并落盘：旧文作初始内容交给 editor 增量改（58-62）；`makeFsWorkspace` + `makeHostStream` 可注入假模型离线测试（63-69）；子模块名全局唯一（71-73，上游 issue #76/#113 教训：重名会互相覆盖）；父 slug 取文章文件名（76-77）；`dispatchSub`（83-128）深度封顶 `subDepth`（默认 2），递归时 `onSubModule` 传 null 让子层按自己的 `_depth` 重建判定（113-117），子模块写集**只有它自己那条路径**（110-112）；空文章判失败不能覆盖旧文（146-149）；写集闸门越界记 `stopReason:'write-set'` 不落盘（151-167）；`fixAnchors` 失败不影响落盘（168-174） |
| `sourceTokensOf(task, cwd, opts)` | 185-203 | 模块源文本近似 token 数（CJK 按 1、其余 3.5 字符/token，181-183），读不到的文件按 0 计不阻断（184） |
| `resolveTaskRoute(task, defaults)` | 208-222 | 任务自带 provider+model 时完全以任务为准，effort 不回落默认档（206-207 注释：默认档 effort 如 off 可能不被大档模型支持） |
| `runAgenticArticles(tasks, opts)` | 231-312 | 并发池，返回 `Map(customId → 结果)`（224/240）；**双池**：`bigTier` 大档走 `bigConcurrency` 独立限流，两池同时推进（226-229/244-255）；`outputTokens` 按 usage 收取（277-278）；子模块派发写进 notes（280-283）；越界写入/未产出正文分别记账（292-298） |
| `markBigAgenticTasks(tasks, opts)` | 320-333 | 按体量打大档标记；agentic 通道不装填源码，用“模块源文本量超 budget”作等价判据（314-318）；未配置 bigTier 时原样返回（322-323） |

### lib/article-contract.js —— 文章契约闸门

| 成员 | 行号 | 说明 |
|---|---|---|
| `ARTICLE_CONTRACT_VERSION` | 16 | =1 |
| `TYPE_BY_DIR` | 19-26 | 目录 → 允许 type（不匹配时 `cw index` 分类会错乱，18 注释） |
| `ROOT_TYPES` | 28-32 | `_architecture.md` / `_index.md` / `_patterns.md` |
| `REQUIRED_SECTIONS` | 36-45 | 所有类型都要 Overview；module/architecture 必须有 Key Components |
| `REQUIRED_FIELDS` | 46 | `title/type/source_files`；tags 是必填字段但允许空列表（258-262） |
| `SEVERITY` | 56-73 | **闸门行为**的分界：error = 结构已破坏必须拒写；warning = 放行但终态降 partial 并阻止基线前移（48-55 注释）；`missing-section` 与 `empty-section` 必须分开（54-55） |
| `parseFrontmatter(content)` | 77-90 | 只认文首第一个 `---` 块，去 BOM（79） |
| `parseYamlLite(raw)` | 94-118 | 极简 YAML：`key: value` 与 `- item` 列表、行内 `[a, b]`（111-114）；不引依赖（92-93） |
| `unquote(s)` | 120-135 | 双引号标量先试 `JSON.parse`（YAML 1.2 是 JSON 超集），失败回退切引号（122-128）；单引号 `''` 是转义后的单引号（130-133） |
| `extractSections(body)` | 138-158 | `## 标题` 章节，围栏内的 `##` 不算（145-147） |
| `fencesBalanced(body)` | 161-164 | 围栏是否成对 |
| `collectWikiLinks(body)` | 167-176 | `[[wiki]]` 与相对 `.md` 链接（排除外链协议头 173） |
| `hasDuplicateFrontmatter(body)` | 179-193 | 正文 40 行内出现第二个 `---` 且含 title/type/source_files 字段即重复贴头（184-187） |
| `inspectArticle(content, opts)` | 213-335 | 主入口，纯函数可单测（11）：必填字段（249-257）+ tags 存在性（259-262）、type 与目录匹配（264-273）、source_files 格式/证据子集/存在性（275-292）、重复贴头（297）、围栏（298-299）、重复/必需/空章节（301-320）、死链（322-332）；`requiredSections`（224，原生引擎通道传 `[]` 只查结构，217-223 注释）与 `allowEmptySourceFiles`（231，whole-repository 通道空 source_files 是诚实记录，226-230 注释）两个覆盖开关 |
| `issueSummary(issues)` | 338-343 | 压成一行人类可读文案 |
| `hasBlockingIssue(issues)` | 346-348 | 只有 error 级才拦落盘（345） |
| `makeWriteSet(paths)` / `normalizeWritePath(p)` | 352-361 | null = 不检查；Set = 白名单 |
| `isWritable(target, writeSet, opts)` | 365-377 | 相对路径以 cwd 解析后比对，防 `../` 越界写到别的仓库（363-364） |

### lib/change-set.js —— 变更采集

| 成员 | 行号 | 说明 |
|---|---|---|
| `CHANGE_SET_VERSION` | 19 | =1 |
| `WIKI_PRODUCT_PREFIX` / `isWikiProduct(relPath)` | 24-29 | `.codewiki/` 自身产物不算源码变更，否则增量永远 dirty（21-23 注释） |
| `normChangePath(p)` | 33-40 | Windows 反斜杠 → POSIX；越界路径直接丢弃（32） |
| `parseNameStatus(out)` | 52-71 | `git diff --name-status` 解析：R/C 两列路径（59-64）、D 记删除、其余记修改 |
| `collectChangeSet(cwd, baseCommit, opts)` | 102-205 | 四路采集（11-13）：① HEAD 有效性，区分“非 git 目录”与"git 命令出错"（110-125）；② 基线可达性，被 rebase/GC 掉必须退全量（127-137）；③ committed/staged/unstaged/untracked，`-M` 开改名检测否则改名被拆成删+加（139-160）；④ 分类去重，`all` 含改名两端（162-177），同一路径删了又重建不算删除（179-181）。**ok=false 一定带 state 与 reason 且 fallback='full'**——不许把"采不到"当"没变化"（100-101） |

### lib/cluster.js —— LLM 模块聚类

| 成员 | 行号 | 说明 |
|---|---|---|
| `formatComponents(components)` | 28-46 | 按文件分组，只给“名字 + 类型 + 一行签名”（41，聚类看结构关系不需要函数体） |
| `ARTIFACT_RE` / `artifactTag(file)` | 48-51 | 配置文件标 `(artifact: config)`，提示词要求归入专门 build/config 模块（70） |
| `clusterPrompt` / `subClusterPrompt` / `superGroupPrompt` | 57-81 / 84-103 / 106-129 | 三段式提示词（对应上游 CLUSTER_REPO_PROMPT 等，1-3）；明确组件 id 形态 `path#name` 必须原样返回（61）；下钻允许“确实不可再分就返回一个子模块不要硬拆”（94） |
| `parseJsonLoose(text)` | 135-153 | 剥围栏 → 直接 parse → 取首尾大括号 → 去尾逗号，四级抢救 |
| `parseClusterResponse(text, validIds, warnings)` | 156-195 | id 校验与去重（174-179）；返回 `missing` 供 `fillMissing` 补齐（193-194） |
| `normalizeModuleName(name)` | 198-206 | 统一成文件名友好形式（会进 `<name>.md`，197） |
| `heuristicCluster(components)` | 219-244 | 本地降级路径：按目录分组；单顶层目录（常见 `src/` 布局）下探一层（232-237）；“不是最优，但永不断链”（216） |
| `fillMissing(modules, components, missingIds)` | 247-268 | 漏掉的组件按目录补回最相近模块，实在没有建 misc（259-266） |
| `moduleFiles(componentIds, byId)` | 274-281 | 组件 → 模块源文件清单（frontmatter `source_files` 用，270-272） |
| `DEFAULT_MAX_DEPTH=2` / `DEFAULT_SPLIT_THRESHOLD=60` / `DEFAULT_TOP_FANOUT=14` | 287-289 | 下钻层数 / 组件数阈值 / 超级分组触发阈值 |
| `clusterComponents(opts)` | 291-389 | 主入口：顶层聚类（310-325）→ 超大模块下钻（327-344，父模块保留为目录节点 337）→ 超级分组（346-356）→ finalize（359-376，父模块 `aggregateFiles` 371-373）→ 只留叶子成文（378-386）；`llmCall` 不传则纯本地启发式（20） |
| `subdivide(...)` | 396-422 | 递归下钻：递归条件是“还有余量 + 该子模块确实超大”，子模块数 >1 保证不会无限递归（406-408）；早期实现只钻一层的缺陷已在 394-395 注释记录 |
| `parseSuperGroups(text, modules, warnings)` | 425-456 | 没被任何子系统收走的模块留顶层，不能凭空消失（453-455） |
| `toPlanModules(result)` | 460-467 | 转成插件 articles 阶段任务形状 `{name, summary, files, parent?}` |

### lib/engine/contract.js —— 引擎跨进程契约

| 成员 | 行号 | 说明 |
|---|---|---|
| `ENGINE_CONTRACT_VERSION` | 20 | =1 |
| `ENGINE_STAGES` | 24-33 | 八段：env/graph/cluster/articles/validate/index/baseline/commit；顺序即推进顺序，面板步骤条与取消检查点都按它对齐（22-23） |
| `TERMINAL_OUTCOMES` | 35 | `done/partial/failed/cancelled` |
| `BLOCKER_KINDS` | 42-53 | 十类阻塞（article-failed…cancelled）；新增只允许追加（40-41） |
| `ENGINE_ERROR_CODES` | 57-67 | 九个错误码；`RETRYABLE_CODES`（71）= timeout/model/unknown，其余重试只是浪费（70） |
| `engineResult(input)` | 97-147 | 构造结果，非法输入抛错（96）：done 带 blockers 抛（103-105）、partial 无 blockers 抛（106-108）、failed 缺 error 抛（109-111）；`engine.deps` 成功时也要带证据（132-136）；`artifacts` 记 docsDir/rawTreeDir/updateRecord（139-143） |
| `engineProgress(input)` | 150-168 | 进度快照，字段只增不减（149）；percent 夹取 0..100（155-156） |
| `engineError(input)` | 171-182 | code 决定重试语义；未登记 code 归 `engine-unknown` 并保留 rawCode（179-180） |
| `validateEngineResult(value)` | 186-220 | 反序列化边界校验（磁盘残留/旧版本），不抛、返回逐条 errors（184-185） |
| `describeEngineResult(result)` | 223-240 | 四态文案，与 `lib/update-record.js` 的 `describeOutcome` 同口径（222） |

### lib/engine/client.js —— 协议客户端

| 成员 | 行号 | 说明 |
|---|---|---|
| `ENGINE_PROTOCOL_VERSION` | 27 | =1，独立于结果契约版本（26） |
| `DEFAULT_MAX_LINE_BYTES` | 29 | 4MB 单行上限，防引擎失控吐超长行吃内存（37） |
| `createProtocolReader(options)` | 39-186 | 增量 JSON-lines 读取器，纯逻辑可逐字节喂（33）：协议不变量见 13-20——非 JSON 行记 `not-json` 但不丢已收结果（61-65）；requestId 是唯一关联键、缺失也算不匹配（82-86）；取消后迟到的 result 记 `late-result` 丢弃（104-109，取消是终态不能被洗白）；重复 result 先到赢（110-113）；`markCancelled()`（163-166）；`end()` 把残留半行当违规（168-184） |
| `runEngine(options)` | 223-422 | 跑一次引擎动作：spawn 计划规范（189-199）；POSIX `detached` 独立进程组、Windows 走 taskkill /T（287-295）；写一行请求 JSON 后关 stdin（323-329）；超时杀进程树（346-350/368-374）；abort 后 `markCancelled` 并用已确认进度构造 cancelled 终态（376-391）；退出后等 stdout end（393-399）；**没有 result = 协议破坏，退出码 0 也救不了**，stderr 尾部必须进 message（401-414）；语义 done + 退出码非 0 保留 done 并记 `nonzero-exit`（416-419） |

### lib/engine/llm-bridge.js + openai-bridge.js —— 模型 loopback 桥

| 成员 | 行号 | 说明 |
|---|---|---|
| `bearerOf(req)` | llm-bridge.js:38-43 | 取 bearer **只用于校验占位 key**，取完即弃（36-37） |
| `startLlmBridge({llm, provider, model, ...})` | llm-bridge.js:90-241 | 凭证边界（6-17）：桥不读凭证、不收真实 api_key、不转发 Authorization；占位 key 每次启动随机生成 `dsh-bridge-<64hex>`（96）；所有 `/v1` 请求必须带占位 key（117-126，错误体不回显收到的 key 123）；流式边收边转（171-188，`[DONE]` 留给收尾统一发 185）；客户端断连 → 中止上游调用（162-167）；流已开始后失败用终止帧表达（193-199） |
| `PLACEHOLDER_KEY_PATTERN` / `isPlaceholderKey` | openai-bridge.js:29-33 | `/^dsh-bridge-[a-z0-9-]+$/` |
| `contentToBlocks` / `toolsToSchemas` | openai-bridge.js:38-51 / 53-66 | content 摊平（image_url 显式跳过 46）；`tools[].function` → ToolSchema，缺这步 agentic 工具循环退化成空谈（15） |
| `messageToDsh(msg, route)` | openai-bridge.js:76-122 | assistant 的 `tool_calls` → tool-call 块，**arguments 保持原始 JSON 字符串**（96-98，提前 parse 会破坏增量拼接）；assistant 必须带 `source.kind='model'`（71-75，宿主 `LlmRuntime.forAdapter()` 无条件读 `source.replayState`，缺 source 整轮调用被判 error）；不伪造 replayState（75） |
| `toLlmRequest({...})` | openai-bridge.js:128-161 | 请求体 → GenerateOptions：system 抽槽（134-146）；返回值永远没有 apiKey 字段（27） |
| `finishReasonToOpenAI` / `usageToOpenAI` | openai-bridge.js:164-173 / 176-188 | TokenUsage 是互斥计数，`prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 details（175-181） |
| `foldChunks(chunks)` | openai-bridge.js:192-233 | tool-call-delta 按 index 拼接（202-210）；**只产出带 name 的调用**（222-226，无 name 引擎无法执行）；reasoning-delta 不进正文（217） |
| `chunksToCompletion({id, model, chunks})` | openai-bridge.js:236-256 | 非流式响应体；纯工具调用时 `content: null` 不是空串（247-249） |
| `chunksToSse({id, model, chunks})` | openai-bridge.js:265-317 | SSE 帧数组；流没给 finish 也补终帧，否则引擎的流读取会挂住（310-314）；sawToolCall 时 finish_reason 强制 `tool_calls`（304/312） |

### lib/engine/manifest.js —— 引擎清单/doctor

| 成员 | 行号 | 说明 |
|---|---|---|
| `MANIFEST_VERSION` / `ENGINE_LOCK_REL` | 19-20 | =1；`.codewiki/engine-lock.json` |
| `probeEnvironment({probe, engineRoot})` | 34-45 | 注入 `probe` 保持纯，进程管理留在 client.js（27-30） |
| `fingerprintOf(facts)` | 50-56 | sha256 前 16 位，只吃“决定产物内容”的 version+python；pip check 不参与——它是“能不能跑”的闸门不是“产物是什么”的输入（47-49） |
| `readLock({repoRoot})` | 61-75 | 不存在/坏都返回 null（首次运行本来没有，58） |
| `compareLock({current, lock})` | 86-111 | 四态：`absent`/`match`/`drift`/`unhealthy`（79-85）；两项都一致但指纹不一致 = 指纹算法变了（100-103） |
| `writeLock({repoRoot, current})` | 117-135 | 原子写（tmp + rename，113） |
| `doctor({probe, repoRoot, engineRoot})` | 141-170 | 一次判“在不在、闭不闭合、漂没漂”；**不抛**（139），probe 失败 → `status:'probe-failed'`（144-152）；只读诊断，不装依赖不修环境（11-13） |

### lib/engine/mapping.js —— 产物映射

| 成员 | 行号 | 说明 |
|---|---|---|
| `WIKI_ENTRY` / `WIKI_DIR` / `WIKI_META_REL` / `WIKI_UPDATE_RECORD_REL` / `WIKI_MODULES_REL` | 30-34 | `CodeWiki.md` / `.codewiki` / `.codewiki/_meta.yaml` / `.codewiki/temp/update-record.json` / `.codewiki/modules` |
| `moduleSlug(name)` | 38-44 | kebab-case，与 cw 既有文章命名一致（36-37） |
| `sourceFilesOf(components, componentFiles)` | 62-72 | 只认组件→文件证据；组件 id 形如 `src/a.py::Class.method` 取 `::` 前文件部分；无证据不计入（宁缺勿造，60-61） |
| `indexModuleTree(moduleTree)` | 76-96 | 页面 → 模块树节点（含 artifact/parent 判定） |
| `mapFsoftOutput({...})` | 115-268 | 纯函数映射，四条硬规则（16-26）：**不臆造 source_files**、**不静默丢弃**（未映射页进 `unmapped` 带原因）、**不覆盖**（slug 冲突两页都进 unmapped，199-211）、**不改技术内容**；whole-repository 模式 `module_tree.json` 就是 `{}`（`documentation_generator.py:241`，153-158 注释），此时页照写、source_files 留空 + `attribution:'unattributed'`（176-187）；模块树里有但没产出的模块记 warning（234-242） |

### lib/engine/output.js —— 产物解析与校验

| 成员 | 行号 | 说明 |
|---|---|---|
| `OUTPUT_PROBLEM_KINDS` | 22-34 | 11 类问题（missing-docs-dir…dead-link），稳定可机读、按 kind 分派不靠 message 文本（21） |
| `listMarkdownPages(rootDir, rel)` | 44-62 | **递归**收 md 页：hierarchical 布局把子模块页放子目录（`doc_layout.py:module_doc_relpath`，113-115 注释）；跳过 `temp/` 与隐藏目录（43/55） |
| `readJsonIfExists(file, problems, kind, opts)` | 64-82 | 可选文件缺失不算问题，但**存在但坏了永远要报**（77-79） |
| `collectOutput({docsDir})` | 91-124 | 读成结构化事实，坏文件变 problem 不抛异常（85）；四个 JSON（metadata/moduleTree 必需，firstModuleTree/updateRecord 可选 120-122） |
| `bodyLength(text)` | 127-137 | 剥标题行后正文字符数，判“这页其实只有个标题”（126） |
| `relativeLinks(text)` | 140-152 | 相对链接目标（跳过外链/锚点/协议头） |
| `buildWritePlan({...})` | 162-173 | 读 docs → 交给 mapping.js，不重复实现任何规则（6） |
| `validateOutput({...})` | 184-282 | 自洽校验**不抛也不修**（176）：入口缺失（197）、空模块树 = 证据整体缺失要上报（199-207）、每页正文非空（209-224）、未映射页（228）、树有页无（230-233）、source_files 存在性（235-248）、docs 内死链（250-265）；`collected` 原样带出避免两次读目录判据漂移（271-274） |

### lib/engine/quality-gate.js —— 采用裁决

| 成员 | 行号 | 说明 |
|---|---|---|
| `GATE_VERSION` | 42 | =1 |
| `GATE_DEFECT_KINDS` | 45-59 | 13 类产品缺陷（缺入口/缺页/空正文/死链/commit-mismatch/uncommitted-input…） |
| `GATE_DEGRADATION_KINDS` | 61-66 | 4 类能力降级（empty-module-tree/no-source-evidence…）：页是真的，只是增量归属不可信 |
| `GATE_STALE_KINDS` | 68-72 | 3 类 wiki 陈旧：不是本次产物的错（28-30） |
| `NATIVE_REQUIRED_SECTIONS` | 86 | `[]`：不沿用 agentic 通道的 Overview/Key Components 去判 FSoft 正文，否则每条都是不可修复 warning、闸门退化成噪声（78-85） |
| `readCommittedBaseline({repoRoot, relPath})` | 117-151 | 读**已提交**基线 `git show HEAD:.codewiki/_meta.yaml`（126）：工作区 `_meta.yaml` 可能是“已写入未提交”窗口内容，当基线等于把未提交状态宣布成已消化（111-116）；工作区有、HEAD 没有 → `source:'worktree-only'` 不可作基线（140-148） |
| `uncommittedSourceChanges({repoRoot})` | 158-174 | 非 wiki 的未提交改动（`.codewiki/` 与 `CodeWiki.md` 不算，153-156） |
| `assessBaseline({...})` | 188-244 | defect：commit-mismatch/missing-metadata/uncommitted-input（200-224）；stale：absent/uncommitted/behind-head（227-238）；**只有 baseline-uncommitted 这条陈旧阻止推进**（240-243） |
| `yamlScalar(value)` | 269-288 | YAML 标量安全序列化：`title: 核心: 引擎` 这类值会让 serde_yaml 解析成嵌套映射、整篇判坏头（253-259）；`JSON.stringify` 就是正确转义（YAML 1.2 是 JSON 超集，260-263）；反斜杠一律引号化（277-281） |
| `titleOf(bodyText, fallback)` | 291-297 | H1 → frontmatter title |
| `renderArticle({article, body})` | 316-340 | 合成 frontmatter + FSoft 原文：**正文一字不动**（301-306）；frontmatter 只填有证据的字段（307-309）；`fsoft_page` 可回溯到原始树文件（310-313/333）；结束标记后**不插空行**，否则“正文 = 原文但多一个换行”，逐字比对永远对不上（334-338） |
| `checkRendered({...})` | 346-373 | `inspectArticle` + 剥掉自合成 frontmatter 后再判空正文（361-368，不剥会把 8 行 frontmatter 当正文，空壳页永远判不出）；不重复判 source 存在性避免翻倍上报（352-355） |
| `gateNativeOutput({...})` | 390-568 | 主入口（纯组合）：自洽分流（414-437，未登记类别不许静默吞 436）→ 入口检查（439-462）→ 逐篇渲染+契约（464-515）→ 空 source_files 降级（496-501）→ 基线（517-523）→ 终态合成**三类皆空才 done**（525-536） |
| `toContractBlockers(report)` | 589-596 | blockers → 契约 `BLOCKER_KINDS`，对不上一律归 `quality-gate`（571） |
| `toQualityIssues(report)` | 610-624 | → `judgeOutcome` 的输入。为什么必须有：`judgeOutcome` 只按“计划内文章写成了没有”判 done，空 source_files 的页会被当成功并推进基线（598-605） |

### lib/engine/apply-plan.js —— 落地器

| 成员 | 行号 | 说明 |
|---|---|---|
| `APPLY_VERSION` / `APPLY_WRITE_ROOTS` / `APPLY_STAGES` | 43-49 | =1；写集白名单 `['.codewiki', 'CodeWiki.md']`；四阶段 write/index/baseline/commit |
| `APPLY_PROBLEM_KINDS` / `APPLY_RESULT_KINDS` | 52-59 / 62-73 | 写集校验 6 类 / 落地结果 8 类（含 `gate-partial`：partial 但 writable=true 照写，**不许洗成 done**，70-73） |
| `checkWriteTargets(items)` | 86-131 | 纯函数写集校验：**坏路径整批拒写而不是逐条跳过**（76-82，残缺写集落盘后缺的那几篇没人知道）；`duplicate-target` 只在内容不同时报（119-126） |
| `capturePre` / `restorePre` | 138-153 / 155-176 | pre-image 快照含 `_index.md` 与 `_meta.yaml`（133-136，它们才是“库是否干净”的判据）；逆序恢复（159），pre-image 不存在 = 本次新建的回滚就该删（166-169） |
| `verifyCommitScope(repoRoot, sha, opts)` | 224-237 | `git show --name-only` 反查实际提交内容，把安全边界变成可断言的事实（215-218） |
| `commitWikiArtifacts(cwd, opts)` | 250-295 | 内置提交器（不 import index.js 的原因见 24-28：单测会连锁拉起宿主服务），安全边界逐条照抄 `autoCommitWiki`：merge/rebase/cherry-pick 进行中拒（263-267）、未解决冲突拒（267）、`.gitignore` 检查（268-272）、无 user.name/email 拒（276-278）、`--no-verify` 不跑钩子（288-289） |
| `toApplyBlockers(problems)` | 309-320 | → 契约 BLOCKER_KINDS；写错的 kind 直接抛（312-313，会让面板与终态判定同时失明） |
| `findArticlesMissingFromIndex(repoRoot, written)` | 338-359 | `cw index` 退出码只表示“索引文件写成功”，frontmatter 解析失败的文章被**静默 continue**（`vendor/codewiki/src/main.rs:236-256`，325-333 注释）；按索引里的路径比对（330-331），`_` 开头文件跳过（332） |
| `normalizeIndexLinksIn(repoRoot)` | 376-390 | Windows 上 `cw index` 可能写出 `[[modules\a|x]]`；与 index.js 版本的唯一差别是 ENOENT 之外的读写错误**抛出**（368-372） |
| `applyNativeOutput({...})` | 414-725 | 主入口，三条硬不变量（10-22）：① 写集封闭（466-523，gate 说 writable=false 一个字不写 467-470；gate partial 照写但记 `gate-partial` 471-477）；② 索引/基线失败即回滚——缺 `_meta.yaml` 时先 `cw init`（554-577，`index.js:4021` 同语义；有目录没 meta 是人工破坏的半截状态不猜 559-565）；`cw index` 失败回滚（591-608）、链接规范化失败同等处置（609-628）、**索引缺页回滚**（630-649，实测 `title: 核心: 引擎` 让 serde_yaml 解析失败而 exitCode 0）；基线失败连文章一起回滚（651-680，留下“文章比基线新”会让下一轮重复消费 651-654）；③ **提交失败不回滚**（682-707，提交失败时文章是好的）；终态兜底：未提交状态下不许出现干净 done（709-714） |

### lib/engine/process-tree.js

| 成员 | 行号 | 说明 |
|---|---|---|
| `isAlive(pid)` | 41-49 | `kill(pid, 0)` 存在性探测：ESRCH 已退出，EPERM 算活（34-40） |
| `terminateProcessTree(pid, options)` | 61-103 | Windows `taskkill /T /F`（72-80，/T 整棵树 /F 强制）；POSIX 先 SIGTERM 进程组（负 pid）宽限 `graceMs` 再 SIGKILL（82-102）；子进程非 detached 时退化只打自己（86-89）；返回 `ok=false` 表示根进程仍活，调用方应报错而不是假装取消成功（57-59） |

### lib/engine/python/entry.py —— Python 薄入口

| 成员 | 行号 | 说明 |
|---|---|---|
| `_ProtocolOnly` | 59-92 | stdout 守卫：**必须在 import codewiki 之前装**（19-21），click 缓存 text stdout 包装器，事后替换 `sys.stdout` 拦不住（14-17）；普通 write 全部改道 stderr（66-72），连 flush 也转（74-78），`fileno` 给 stderr 句柄（83-85） |
| UTF-8 reconfigure | 50-56 | Windows 下 Python stdout 默认 cp936，Node 侧按 UTF-8 解码，不改中文错误信息过管道就是乱码 |
| `PROTOCOL_VERSION` / `ACTIONS` | 94-95 | =1；doctor/generate/update/cancel |
| 环境变量 | 98-101 | `CODEWIKI_BASE_URL` / `CODEWIKI_API_KEY` / `CODEWIKI_MAIN_MODEL` / `CODEWIKI_CLUSTER_MODEL`；密钥只活在进程环境，**不落盘**（25-29 不用 ConfigManager 的原因） |
| `emit(obj)` | 104-108 | 协议行走保存下来的 `_REAL_STDOUT`（48） |
| `failure(code, message, ...)` | 135-153 | failed 终态模板；message 绝不拼凭证内容（136） |
| `_engine_version()` / `_pip_check(timeout)` | 159-173 / 176-195 | 版本探测；pip check 是 1A 门禁的运行时版本——装到一半的 venv 会在生成中途才崩（178-181） |
| `action_doctor(request_id, payload)` | 198-237 | 导入失败 → `engine-missing`（204）；依赖不闭合 → `engine-deps` 带摘要（208-215）；成功也带 deps 证据（228-233） |
| `_model_config()` | 243-275 | 环境变量缺任何一项都返回原因，错误信息刻意不打印值（247-248）；`fallback_model` 必须显式给：缺省 None 会让 FSoft `create_fallback_models` 在 `model_name.lower()` 上抛 AttributeError（263-267） |
| `bridge_progress(adapter, request_id, on_stage)` | 281-332 | **替换**（非继承）ProgressTracker 三方法旁路观察（284-290，FSoft 直接构造无注入点）；`on_stage` 记录最后真实到达的阶段，done 里的 stage 是实测值不是写死的（289-291） |
| `_count_docs(docs_dir)` | 338-363 | **递归**清点产物页数（339-344，只 glob 根层会漏整棵子树——“1 篇成功 + 19 篇失败也报 done”的误判来源之一）；`temp/` 与点目录排除（354-357） |
| `action_generate(request_id, payload, is_update)` | 384-472 | 准备 config → 跑 `CLIDocumentationGenerator` → 异常翻成契约终态（385-388）；FSoft `sys.exit(0)`（无变更）不是失败（432-438，`generate.py:640` 附近）；`validate_generated_docs` 缺页 → partial + `article-missing` blockers（449-457）；用量从 `job.statistics.usage_totals` 读（460-471） |
| `_done_result(...)` | 475-496 | done 模板，artifacts 记 docsDir/rawTreeDir/updateRecord（489-493） |
| `_classify_exception(exc, ...)` | 499-526 | 按**异常类型**分类（文本随版本变，500-503）：`IncompleteGenerationError` → partial（508-517）；`*APIError/ConfigurationError` → `engine-model`（520-521）；`KeyboardInterrupt` → cancelled（524-525）；其余 → `engine-crashed` 带栈尾（526） |
| `_cancelled_result(...)` | 529-546 | cancelled 模板 |
| `handle_request(msg)` / `main()` | 552-574 / 577-590 | cancel 立即回 cancelled（567-571，实际杀树由 Node 侧做）；退出码只表进程层，语义以 result 行为准（31-35） |
| KeyboardInterrupt 兜底 | 593-603 | 被杀树时仍尽量回一条 cancelled |

### lib/engine/python/stage_map.py —— 阶段映射

| 成员 | 行号 | 说明 |
|---|---|---|
| `ENGINE_STAGES` | 20-29 | 必须与 `contract.js` 完全一致，由 `test-engine-python-entry.mjs` 双向对账（19/8-10） |
| `FSOFT_STAGE_NAMES` / `FSOFT_STAGE_WEIGHTS` | 33-39 / 40-46 | FSoft ProgressTracker 的镜像，权重不一致会在阶段交界跳变（31-32） |
| `FSOFT_TO_ENGINE` | 50-56 | 五段 → 四段（4/5 都落 validate：报成 articles 会让面板一直显示在写作，48-49） |
| `DEFAULT_ENGINE_STAGE` | 60 | 未知阶段归 articles 不抛错——进度是旁路，不该因版本差异打断编译（58-59） |
| `FSOFT_PROGRESS_CEILING` | 63 | =90；剩 10% 留给 Node 侧 index/baseline/commit 收尾，避免“引擎说 100% 但 wiki 还没提交”的假完成（12-16） |
| `map_stage(fsoft_stage)` | 66-72 | 阶段号 → 契约阶段名 |
| `percent_of(fsoft_stage, stage_progress)` | 75-97 | 与 FSoft `get_overall_progress` 同构：已完成权重和 + 当前权重×进度，×90 夹 0..100；不持有 tracker 实例也能算（79-83） |

### lib/graph-diff.js —— 符号级 diff

| 成员 | 行号 | 说明 |
|---|---|---|
| `CLASS_ADDED/DELETED/IFACE/BODY/EDGE/RENAMED` | 14-19 | 六类变更常量 |
| `TOKEN` | 26 | Unicode 感知分词：JS 的 `\w` 只有 ASCII，会让中文按字切碎、相似度整体偏高（24-25） |
| `normalizeBody(text)` | 28-30 | trim + 空白归一 |
| `stripComments(text)` | 69-100 | 剥注释与排版：区分“只改注释”与“代码实质变化”；字符串里的 `//` 会被误判为注释，是可接受近似（65-68）；`--`/`;`/`%` 只对行首生效（32-34/39） |
| `stripTrailingComment(line)` | 43-62 | 跟踪引号与转义，`"http://x"` 不会被当注释（42）；`#` 只在行首或空白后算注释（55-56） |
| `codeHash(node)` | 108-111 | 不含注释与 docstring 的 sha1；docstring 是“有意义的文档”，由调用方单独比较（101-107） |
| `documentedSource(node)` | 114-119 | 源码 + docstring（Rust 的 `///` 在节点外，112-113） |
| `bodyHash(node)` | 121-126 | 快照回读节点走固化哈希，不把源码读回来重算（122-124） |
| `signature(node)` / `signatureChanged(a, b)` | 128-134 / 136-145 | name/parameters/baseClasses 三元组比对 |
| `sequenceRatio(aArr, bArr)` | 229-236 | difflib.SequenceMatcher.ratio **逐位移植**（autojunk=False），不对齐就无法与上游对拍（150-154） |
| `bodySimilarity(a, b)` | 239-245 | token 序列 ratio |
| `approxTokens` / `truncateToTokens` | 247-257 | 4 字符/token；截断保留头尾各半 + `DIFF_TRUNCATED_MARKER`（21） |
| `unifiedDiff(...)` / `unifiedBodyDiff(...)` | 327-355 / 358-362 | difflib.unified_diff 移植（260 注释）；上游语义：整文件相对路径作 label、上下文 2 行（357） |
| `DEFAULT_TAU_REN=0.8` / `DEFAULT_MAX_DIFF_TOKENS=2000` | 368-369 | 改名相似度阈值 / diff token 上限 |
| `pairRenames(deleted, added, ...)` | 371-407 | 按 body 相似度贪心最佳匹配；长度比预过滤（388-391）；同 kind 才配对（374-377） |
| `emptyGraphDiff` / `graphDiffCounts` / `changedIds` / `isDiffEmpty` | 413-444 | 空 diff / 计数 / 全部受影响 id（含 renamed 新 id） |
| `diffGraphs(oldGraph, newGraph, opts)` | 447-564 | 主入口：added/deleted（454-455）→ 同 id 三分类（签名变=interface 468-470、实现变=body 471-473、仅依赖变=edge 474-476）→ 改名配对（499-524，改名后签名变也记 interface 523）→ 每条 records 带 `edgesAdded/edgesRemoved` 与截断后的 `diff`（495/521/541/559） |
| `serializeDiff(d)` | 567-578 | Set/Map → 排序数组，供落盘与对拍 |

### lib/symbols.js —— AST 符号提取

| 成员 | 行号 | 说明 |
|---|---|---|
| `DEFAULT_VENDOR_DIR` | 25 | `vendor/tree-sitter`：独立 npm 根，避免在宿主注入的 node_modules 里跑 npm install 破坏运行环境（21-23） |
| `LANG_RULES` | 36-271 | 16 种语言的声明式规则（container/fn/imports/doc/receiverField 等），加语言只加一行（4-6）；Go 方法接收者拼 `<类型>.<方法>`（110-112）；C/C++ 名称参数挂在 `function_declarator`（137-139） |
| `SUPPORTED_EXTS` | 273-276 | 扩展名 → 语言 Map |
| `REGEX_RULES` | 302-368 | 正则降级规则：WASM 不可用时的“有损但不丢”兜底，早期直接 `return []` 导致整块语言静默消失（286-297） |
| `REGEX_MAX_LINES` | 371 | 正则路径最多扫 4000 行 |
| `regexExtract(relPath, content, lang)` | 374-440 | 按行扫（跳过块注释 383-394，类优先于函数 408-409）；源码范围 = 定义行到下一定义行（末符号最多 60 行，420-421）；输出与 AST 同形状 |
| `parseParamList(text)` | 443-466 | 顶层逗号切分（跳过嵌套括号/泛型 447-458），去默认值/类型标注/展开符 |
| `SymbolExtractor` | 472-779 | 解析器池（语法只加载一次，468-470）：`vendorImport`（484-495，从 vendor 树按绝对路径解析）；`init()`（498-519，惰性导入，依赖没装插件照常启动）；`getParser(lang)`（521-542，语法与运行时 ABI 不匹配静默降级 536-540）；`extractFile`（551-594，AST 失败**和**“解析成功但零符号”都退正则并记 `stats.regex` 556-563/581-592）；`walk`（597-695，容器连同成员方法成组件、Go receiver 640-648、C/C++ declarator 下探 630-638、箭头函数赋值 668-689）；辅助方法 `findArrow`(697-707)/`findDeclarator`(710-719)/`stripCallSuffix`(722-727)/`fieldText`(729-737)/`parseParams`(739-741)/`parseBases`(743-748)/`sliceSource`(751-757，按字节区间多字节安全)/`extractDoc`(759-774，Python 首字符串/Rust 前置行注释)/`componentId`(776-778) |
| `extractRepoGraph(files, opts)` | 785-805 | 批量 → `{graph, byFile, skipped, extractor, ready, stats}` |
| `resolveImportEdges(graph, byFile, files)` | 810-833 | import → 仓库内相对路径 → 落到组件 `dependsOn`（807-809：先做文件级边，调用级留待扩充） |
| `IMPORT_RE` / `extractImportSpecs` | 835 / 837-847 | 七种 import 形态 + `require()` |
| `resolveSpec(fromFile, spec, known)` | 849-884 | 相对路径补扩展名与 index（853-864）；Python 点号模块（866-875）；Rust use / C 头文件按 basename 匹配（877-883） |

### lib/incremental.js —— 快照与判定

| 成员 | 行号 | 说明 |
|---|---|---|
| `SNAPSHOT_VERSION` / `SNAPSHOT_REL` | 19-22 | =1；`temp/symbol-graph.json`（随 wiki 入库，换机器不退化成全量，20-21） |
| `SLIM_FIELDS` | 26 | 判定所需最小字段；**sourceCode 一律不存**（.codewiki 会进仓库），bodyHash/codeHash 直接固化（23-25） |
| `slimComponent(node)` | 28-34 | 节点瘦身 |
| `slimGraph(graph, opts)` | 37-48 | 现场节点算一次哈希固化，之后回读不需要源码（39-45） |
| `sameSnapshotContent(a, b)` | 53-66 | 忽略 generatedAt/commit 比实质内容；代码没变不覆盖，否则 autoCommit 会为“只改了一个时间戳”生成空转提交（50-52） |
| `graphFromSnapshot(snap)` | 69-88 | 快照 → Map（graph-diff 直接输入，`sourceCode:''`） |
| `loadSnapshot` / `saveSnapshot` | 94-104 / 106-115 | 版本不符当没有：宁可重写也不误判（98） |
| `normRel(p)` | 118-120 | 快照存 POSIX，frontmatter 可能是 `\` 或 `./` 开头（117） |
| `componentsByFile(graph)` | 123-132 | 文件 → 组件 id 清单 |
| `filterStaleTasks(tasks, oldGraph, newGraph, opts)` | 140-194 | 核心判定（纯函数）：**纯注释降级**——bodyHash 变但 codeHash 没变且 docstring 未变的 body 类组件视为“描述不变”（144-170，只降级 body 类，interface/added/deleted/renamed 一律不放行 152-153；在判定层做是因为 `diffGraphs` 与上游逐位对齐有 golden 对拍不能动 148-150）；无可解析符号的文章保守 keep + `symbolFallback`（179-184，宁多写不留过期）；只命中纯注释时记原因（188-190） |
| `describeChange(counts)` | 197-206 | “接口变 2、新增 1…” 摘要 |

### lib/update-planner.js —— 增量计划器

| 成员 | 行号 | 说明 |
|---|---|---|
| `UPDATE_PLAN_VERSION` / `MODULE_MAP_VERSION` / `MODULE_MAP_REL` | 23-27 | =1 / =1 / `temp/module-map.json` |
| `isSourcePath(p)` | 33-36 | 只看扩展名；非源码文件无归属只记 warning，否则一篇随手笔记就让增量永远退回 full（31-32） |
| `realChangedIds(diff, oldGraph, newGraph, opts)` | 57-81 | 与 incremental.js 同一套纯注释降级判据（复用 `codeHash` 不另造规则，55）；同时给出 `structural`（interface/added/deleted/renamed/edge） |
| `dependentsOf(graph, ids)` | 85-101 | 反向边：`dependsOn` 可能是组件 id 也可能是文件路径，两种都认（83-84） |
| `scanStaleArticle(article, opts)` | 106-145 | 未重写页的 stale scan：正文引用已删/改名符号（按名字或 id 尾巴匹配 112-124）→ `needsRewrite`；死链只要求 review（139-144，目标可能只是被改名成等价标题） |
| `planUpdate({...})` | 156-436 | 主入口（纯函数），修复旧实现三个缺陷（4-11：反向依赖看不见/新文件无归属/未重写页不做 stale scan）：文件级降级仍处理删除改名新文件（178-179）；**反向依赖闭包**只对 structural 做（204-219）；缺 source_files → review + `needsFull`（250-258）；stale scan 命中 → write/review（319-344）；无归属源码按目录前缀保守路由给最相近文章（358-380），路由不了进 `unmappedChanges` 且 **needsFull**（381-392）；非源码文件只记 warning（419-424，混进来会让正常增量永远 partial）；**必需文章只算 write**（398-403，keep 算进去会把完整成功误判成 partial）；图里没有任何依赖边时如实警告（393-397） |
| `buildModuleMap({...})` | 442-468 | 文章 → 源码/组件/模块关系快照；模块归属优先取 plan（457-460） |
| `migrateModuleMap({articles})` | 472-481 | 旧 wiki 无 module-map 时从 frontmatter 保守迁移，只记 sources（470-471） |
| `sameModuleMap(a, b)` | 484-492 | 忽略 generatedAt 比实质，避免空转提交 |

### lib/update-record.js —— 更新记录

| 成员 | 行号 | 说明 |
|---|---|---|
| `UPDATE_RECORD_VERSION` / `UPDATE_RECORD_REL` | 17-18 | =1；`temp/update-record.json` |
| `TERMINAL` / `isTerminalStage(stage)` | 24-28 | done/partial/failed/cancelled；partial 语义：已成功的文章可入库但“全部已消化”不成立，基线不得前移（20-23） |
| `judgeOutcome({plan, results, options})` | 37-128 | 终态判定：取消短路（46-55）；缺页与失败分开记（56-75）；逐篇失败（77-78）；**unmapped 只算源码变更**——README/CodeWiki.md 没被引用是常态（80-91）；missing-sources（92-97）、质量闸门（99-102）、索引完整性（104-105）、调用方补充硬阻塞（107-110）；**0 篇成功且有失败/缺页/阻塞 = failed，否则 partial**（113-118）；`canAdvanceBaseline` 只在 done（122-125） |
| `buildUpdateRecord({...})` | 131-211 | 组装版本化记录（可序列化；job 只存路径与摘要，130）；plan.actions 每个 action 必带 reason（180） |
| `recordPath` / `saveUpdateRecord` / `loadUpdateRecord` | 213-215 / 217-227 / 229-238 | 落盘/读回；版本不符返回 null（233） |
| `describeOutcome(outcome, blockers)` | 241-253 | done/partial/failed 三态一眼能分（240） |

## Architecture

```text
              ┌──────────────── 编译调度（index.js）────────────────┐
              ▼                                                    ▼
┌───────────────────────────────┐  ┌───────────────────────────────────────────┐
│ agentic 写作通道              │  │ FSoft 原生引擎通道        │
│ cluster.js（LLM 聚类）        │  │ client.js ──JSON-lines──► entry.py        │
│   ▼                          │  │ llm-bridge.js ◄─ openai-bridge.js         │
│ articles-agentic.js（执行器）  │  │   ▲ 127.0.0.1+占位 key，转宿主 llm.stream │
│   ▼                          │  │ output.js+mapping.js（产物映射）          │
│ agentic-host.js（消息/流适配） │  │   ▼                                       │
│   ▼                          │  │ quality-gate.js（采用裁决）               │
│ agentic.js（工具循环）        │  │   ▼                                       │
└───────────────┬───────────────┘  │ apply-plan.js（写盘→索引→基线→提交）      │
                │                  └───────────────────┬───────────────────────┘
                ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ article-contract.js 契约闸门 │ change-set.js 四路 git 变更                │
│ symbols.js AST → graph-diff.js 符号diff → incremental.js 快照判定          │
│ update-planner.js 增量计划 → update-record.js 终态与记录                    │
└───────────────────────────────────────────────────────────────────────────┘
```

关键分层原则：

- **纯逻辑与 IO 分离**：`agentic.js`（消费裸消息只认 blocks）与 `agentic-host.js`（消费宿主 Message 形态）的分工见 `lib/agentic-host.js:1-9`；`contract.js` 只做纯数据校验（`lib/engine/contract.js:18`），进程管理在 `client.js`，纯转换在 `openai-bridge.js`（无 I/O 无网络无密钥，`lib/engine/openai-bridge.js:8`）。
- **依赖注入而不是 import**：`apply-plan.js` 不 import `index.js`（加载会连带拉起宿主服务），`runCw`/`commit`/`normalizeIndexLinks` 全部可注入（`lib/engine/apply-plan.js:24-28`）；但“可注入”不等于默认什么都不做——默认自带同语义提交器 `commitWikiArtifacts`（29-34）。
- **映射边界窄**：`mapping.js` 是“迁移里唯一一处格式翻译”，边界必须窄得能被完整读一遍（`lib/engine/mapping.js:3-4`）。

## Data Flow

### 流程 A：agentic 写作通道

1. 任务清单进入 `runAgenticArticles`（`lib/articles-agentic.js:231`），按 `bigTier` 分双池并发（244-255）；每个任务先 `resolveTaskRoute`（208）选模型档。
2. `runOneArticle`（33）构造 editor（旧文作初始内容，59-62）、workspace、写集（67）与 streamFn（69，默认 `makeHostStream`）。
3. `runAgenticArticle`（`lib/agentic.js:331`）每步：`streamFn({messages, tools, signal})`（373）→ `makeHostStream` 内部 `toRequestMessages`（`lib/agentic-host.js:34`）把裸消息换正式 Message → `llm.stream` chunk 流被 `BlockAssembler` 收成 blocks（87-99）。
4. blocks 里的 tool-call 经 `parseToolArgs`（476）抢救参数 → `buildToolset`（279）分派执行 → 结果作为 tool-result 消息回灌 `messages`（421）；工具实现通过 `makeFsWorkspace`（`lib/agentic-host.js:111`）读仓库。
5. 无工具调用 → `stopReason='finished'`（389-395）；文章经写集校验（`articles-agentic.js:83-99`）与 `fixAnchors`（169-174）后落盘（175-176）。模型调 `generate_sub_module` 时 `dispatchSub`（83-128）就地递归 `runOneArticle` 写 `modules/<父>/<子>.md`。

### 流程 B：FSoft 原生引擎通道

1. `runEngine`（`lib/engine/client.js:223`）spawn Python 子进程，写一行 `{requestId, action, payload}` JSON 进 stdin（323-329）。
2. `entry.py` 的 `main`（577）→ `handle_request`（552）→ `action_generate`（384）构造 config（模型通道来自环境变量，243-275）并跑 `CLIDocumentationGenerator`；`bridge_progress`（281）把 FSoft 五段进度经 `stage_map.py` 的 `map_stage`/`percent_of`（66/75）翻成八段契约 JSON 行推到 stdout。
3. `createProtocolReader`（client.js:39）逐行解析：`progress` → `engineProgress`、`result` → `engineResult`，违规全部记账；`runEngine` 把退出码与语义解耦（403-421）。
4. 产物落地：`collectOutput`（output.js:91）读 docs 树 → `mapFsoftOutput`（mapping.js:115）映射成写集 → `gateNativeOutput`（quality-gate.js:390）渲染 + 契约 + 基线裁决 → `applyNativeOutput`（apply-plan.js:414）按四阶段落地：`checkWriteTargets`（86）→ 写盘（579-589）→ `cw index` + 缺页反查（591-649）→ `cw meta update` 基线（651-680）→ 自动提交（682-707）。

### 流程 C：符号级增量

1. `collectChangeSet`（`lib/change-set.js:102`）收四路 git 变更（含未提交/未跟踪），`ok=false` 时调用方退全量。
2. `extractRepoGraph`（`lib/symbols.js:785`）从仓库文件建新组件图；旧图来自 `loadSnapshot`（`lib/incremental.js:94`）。
3. `planUpdate`（`lib/update-planner.js:156`）产出逐篇 action（write/keep/review）+ 原因 + `unmappedSourceChanges`；`needsFull` 时退全量。
4. write 任务走流程 A 执行；收尾 `judgeOutcome`（`lib/update-record.js:37`）判终态，`buildUpdateRecord`（131）落 `temp/update-record.json`，`saveSnapshot`（incremental.js:106）固化新图（内容没变不写，53-66）。

## Connections

- [[index]] —— 插件主入口：消费 `runAgenticArticles`/`planUpdate`/`judgeOutcome`/`applyNativeOutput`，并向 `apply-plan.js` 注入 `runCw` 与 `autoCommitWiki`（`lib/engine/apply-plan.js:27` 引 `index.js:4655`，`lib/engine/apply-plan.js:532` 引 `index.js:4021`）；`DEFAULT_MAX_STEPS` 的 Config 默认值也必须与 `lib/agentic.js:325` 一致（321-324 注释）。
- [[vendor]] —— `vendor/tree-sitter` 是 `SymbolExtractor` 的可选依赖根（`lib/symbols.js:472`，缺了只失去 AST 能力退正则）；`vendor/codewiki` 是 FSoft 引擎本体（`lib/engine/apply-plan.js:327` 引 `vendor/codewiki/src/main.rs:236-256` 的索引行为）。
- [[tests]] —— `test-engine-client.mjs` 钉死 client.js 的协议不变量（`lib/engine/client.js:13`）；`test-engine-python-entry.mjs` 反向断言 `stage_map.py` 与 `contract.js` 的阶段集合一致（`lib/engine/python/stage_map.py:8-10`）；`lib/agentic.js`/`article-contract.js` 的纯函数设计就是为这些测试服务的。

## Known Issues

以下均为源码注释中明确记录、且已在当前实现中防御或如实暴露的坑与限制：

- **模型反复读同一文件**：真实模型 + 45 步的探针里 `index.js` 被读 13 次、16 次读码只有 4 个不同文件、累计上下文 2.1MB，步数全耗在读码上（`lib/agentic.js:115-119`）。防御是 `makeReadCodeTool` 的工具侧记账（115-177）。
- **CRLF 锚点匹配失败**：`core.autocrlf=true` 环境下 `.codewiki` 28/36 篇是 CRLF，模型按 view 输出写 `old_str` 纯字面 `indexOf` 永远匹配不上，只会反复换锚点直到步数耗尽（`lib/agentic.js:212-215`）。`str_replace`/`insert` 匹配前归一化、命中后按原文风格写回（216-228/241-253）。
- **JSON 围栏参数**：围栏 JSON 一律解析失败会让工具拿空参数执行、模型反复重试同一错、整轮写不出文章（`lib/agentic.js:476-480`）。`parseToolArgs` 三级抢救（476-500）。
- **generate_sub_module 死链**：此前无论什么原因不可用都回「已派发」，模型据此在父文写「详见 xxx.md」而那个文件从未生成（`lib/agentic.js:290-293`）。现在区分 `max-depth` 与“模式不支持”两种原因给出可行动指示（294-305）；`articles-agentic.js:79-83` 同步把 `subModuleBlocked` 传下去。
- **步数上限双处定义**：曾两处各写一个常量（24/30），直调与生产链路行为不同（`lib/agentic.js:321-324`）。现在唯一定义点 + 再导出（`lib/articles-agentic.js:19-21`）。
- **旧契约闸门放行的坏文章**：正文里贴第二份 frontmatter、必需章节空着、source_files 列不存在的文件或目录、`[[链接]]` 死链、围栏未闭合（`lib/article-contract.js:213-219`）。`inspectArticle`（213-335）逐项判 error。
- **cw status 三类改动隐形**：未提交、已暂存未提交、未跟踪的新文件（`lib/change-set.js:102-108`），“改完就编译”会把未消化变化当已消化。`collectChangeSet` 四路合一（102-205）。
- **旧增量判定三个盲区**：反向依赖看不见、新文件无归属被静默丢、未重写页不做 stale scan（`lib/update-planner.js:4-11`）；以及 keep 被算进必需清单导致完整成功误判 partial（398-403）、CodeWiki.md 无归属误判 partial（419-424）。均已修复并留注释。
- **纯注释改动触发重写**：`bodyHash` 覆盖整段源码文本，上游 `normalize_body` 也只做空白归一（`lib/incremental.js:144-150`）。降级在判定层做，不动与上游逐位对齐、有 golden 对拍的 `diffGraphs`（148-150）。
- **WASM 语法不可用静默丢语言**：早期 `extractFile` 直接 `return []`，整块语言凭空消失、日志只见 skipped（`lib/symbols.js:286-297`）。现在正则降级 + `stats.regex` 记账（551-594）；正则路径本身“有损但不丢”（296），字符串里的 `//` 在 `stripComments` 中会被误剥是可接受近似（`lib/graph-diff.js:69-72`）。
- **cw index 缺页静默成功**：frontmatter 解析失败的文章被 continue、exitCode 依然 0；实测 `title: 核心: 引擎` 让 serde_yaml 把后半个当嵌套映射（`lib/engine/apply-plan.js:338-343` 与 `lib/engine/quality-gate.js:269-274`）。防御：`findArticlesMissingFromIndex`（338-359）+ `yamlScalar`（269-288）。
- **Windows 索引链接反斜杠**：`cw index` 可能写出 `[[modules\a|x]]`，同一篇文章两种写法等于索引不可信；规范化失败按索引失败整体回滚（`lib/engine/apply-plan.js:609-628`）。
- **孤儿进程烧 token**：只 kill 直接子进程，Python 派生的孙进程会变孤儿（`lib/engine/process-tree.js:61-64`）。`terminateProcessTree` 按平台整树终止（61-103）。
- **引擎日志污染协议流**：FSoft 大量 `print`/`click.secho`，click 缓存 stdout 包装器使事后替换无效（`lib/engine/python/entry.py:12-21`）。`_ProtocolOnly` 在 import codewiki 前接管（46-92）。
- **fallback_model 缺省必崩**：FSoft `create_fallback_models` 在 `model_name.lower()` 上抛 AttributeError，崩在 graph 阶段开头、表现为 engine-crashed（`lib/engine/python/entry.py:263-267`）。
- **进度假完成**：引擎若报 100% 而 wiki 还没索引/提交会误导（`lib/engine/python/stage_map.py:12-16`）；进度上限压 90%（63）。未知阶段不抛错（58-60）。
- **指纹语义**：pip check 不参与引擎指纹——它是“能不能跑”的闸门不是“产物是什么”的输入（`lib/engine/manifest.js:47-49`）；lock 四态 `absent/match/drift/unhealthy`（86-111）。
- **凭证边界**：桥等于“用宿主凭证换任意模型调用”的开关，绑定 127.0.0.1 + 随机端口 + 占位 key 三者缺一都等于把宿主凭证开放给本机任意进程（`lib/engine/llm-bridge.js:14-17`）；日志不含 Authorization（12）。
- **落地三不变量**：写集封闭（整批拒写）、索引/基线失败即回滚（脏库永不自愈，`lib/engine/apply-plan.js:17-19`）、提交失败不回滚（文章本身是好的，20-22）；未提交状态下不许出现干净 done（709-714）。
- **终态语义**：partial 必须带 blockers、done 不许带（`lib/engine/contract.js:103-108`）；0 篇成功且有失败/阻塞才是 failed（`lib/update-record.js:37-42`）；`canAdvanceBaseline` 只在 done（122-125），gate 侧的 `toQualityIssues` 保证 `judgeOutcome` 不会把空 source_files 的 partial 洗成 done（`lib/engine/quality-gate.js:598-605`）。
