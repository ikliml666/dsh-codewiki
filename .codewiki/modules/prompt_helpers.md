---
title: prompt_helpers
type: module
source_files:
  - lib/agentic.js
  - test-agentic.mjs
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
tags: [agentic, prompt-composition, observation, markdown-generation, tool-loop]
---

## Overview

`prompt_helpers` 是 agentic 文章写作通道里的**纯逻辑辅助层**，全部实现集中在 `lib/agentic.js`。它对应上游 FSoft-AI4Code/CodeWiki 的 `src/be/agent_tools/`（read_code / str_replace_editor / generate_sub_module_documentations）与 `documentation_generator.py` 里的 pydantic-ai 工具循环（`run_module_agent`），但在本仓库里被重写成「不绑死 pydantic-ai、不绑死宿主 llm 服务」的纯函数集合（见 `lib/agentic.js:5-13` 文件头注释）。

本模块承担三块职责，正好对应任务主题：

1. **Prompt composition（提示词组合）**：`TOOL_SCHEMAS`（`lib/agentic.js:27-87`）定义四个工具的描述/参数；`buildOpeningPrompt`（`lib/agentic.js:506-541`）把任务 mission、工具清单、工作方式六步、硬要求与可选 articleFormat 拼成开场提示词。模型「不要凭记忆写作」「引用位置用行号」等硬性工作约定都从这里下发。
2. **Observation（观察/读码）**：`numberLines`（`lib/agentic.js:101-106`）给源码加「`行号| `」前缀；`makeReadCodeTool`（`lib/agentic.js:115-177`）与 `makeListFilesTool`（`lib/agentic.js:179-197`）是模型「看仓库」的两个工具，带重复读抑制、行/字符上限、忽略目录与越界防护；`safeRelPath`（`lib/agentic.js:266-273`）做路径越界兜底。
3. **Article markdown generation（文章 markdown 生成）**：`makeArticleEditor`（`lib/agentic.js:200-263`）是文章状态机，支持 `view`/`str_replace`/`insert` 三种命令并做 CRLF 归一；`buildToolset`（`lib/agentic.js:279-315`）把四个工具聚成工具集；`runAgenticArticle`（`lib/agentic.js:331-432`）是消费 streamFn 的步循环；`parseToolArgs`（`lib/agentic.js:476-500`）做坏 JSON 容错解析。

模块不依赖任何宿主 llm 服务，因此测试可完全离线：用假的 `streamFn` 与假 `workspace` 即可跑通整条循环（见 `test-agentic.mjs:1-73`）。

## Key Components

所有行号以 `lib/agentic.js` 的「行号| 」前缀为准。`lib/agentic.js` 全部导出：`TOOL_SCHEMAS`、`MAX_READ_LINES`、`MAX_READ_CHARS`、`IGNORED_DIRS`、`numberLines`、`makeReadCodeTool`、`makeListFilesTool`、`makeArticleEditor`、`safeRelPath`、`buildToolset`、`DEFAULT_MAX_STEPS`、`runAgenticArticle`、`stripJsonFence`、`sliceBalancedObject`、`parseToolArgs`、`buildOpeningPrompt`。

### 提示词组合（Prompt composition）

- `TOOL_SCHEMAS`（27-87）：四个工具的 JSON-Schema 形态（对应宿主 `ToolSchema` 数组），导出供 `buildOpeningPrompt` 列清单、供 `runAgenticArticle` 过滤后声明给模型（`lib/agentic.js:331`）。依次是：
  - `read_code`（29-42）：参数 `path`（required）、`start_line?`、`end_line?`。其 `description`（30-32）会成为开场提示词里「引用代码位置时必须用这个行号，禁止自行推算」的工作约定。
  - `list_files`（44-53）：参数 `path?`、`depth?`。
  - `edit_article`（55-71）：参数 `command`（enum `view`/`str_replace`/`insert`，required）、`old_str?`、`new_str?`、`line?`、`text?`。其 `description`（56-59）定义「文章一开始为空，insert 从第 0 行开始搭骨架，再 str_replace 逐段填实」。
  - `generate_sub_module`（73-87）：参数 `module_name?`、`components[]?`、`description?`；`required: ['module_name', 'description']`。
- `buildOpeningPrompt({ mission, systemPrompt = '', articleFormat = '', schemas = [] })`（506-541）：拼开场提示词纯函数。行为：
  - 列工具：`schemas.map(t => '- ' + t.name + '：' + t.description.split('\n')[0])`（507）。
  - 若 `schemas` 含 `generate_sub_module` 才追加「拆分（可选）」小节（508-533），否则不提子模块（避免给不支持递归的模型制造死链预期）。
  - 硬要求段（535-538）含「不许编造文件/函数/行号」「文章要用到真实行号」「不要用 markdown 围栏把整篇文章包起来」。
  - `articleFormat` 非空时在末尾追加格式条款（539）。
  - 测试见 `test-agentic.mjs:456-462`（断言含「任务：…」「不许编造文件、函数、行号」「read_code」「不要用 markdown 围栏把整篇文章包起来」）。

### 观察（Observation）

- `MAX_READ_LINES = 2000`（93）：`read_code` 单次返回行数上限（见 156-159）。只限行数挡不住压缩产物，故另有字符上限。
- `MAX_READ_CHARS = 40000`（96）：`read_code` 单次返回字符上限（见 164-167）。实测单行 20 万字符的文件一次吐 5.7 万 token，40000 字符 ≈ 11k token（见 94-96 注释）。
- `IGNORED_DIRS`（98）：`list_files` 一律不列出的目录清单 `['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor', '__pycache__', '.venv', 'venv']`，避免模型把依赖目录当源码探索、白烧步数。
- `numberLines(text)`（101-106）：给每行加 `行号| ` 前缀（`${i + 1}| ${line}`），模型据此引用行号。测试见 `test-agentic.mjs:76-78`（断言 `numberLines('a\nb') === '1| a\n2| b'`）。
- `makeReadCodeTool(workspace, { seen = new Map(), getStep = null })`（115-177）：`read_code` 实现（工厂函数，返回 `async (args) => {...}`）。
  - 去重发生在读盘之前（123-135）：同一 `(safe, start, end)` 再读只回「你已经在第 N 步读过这段」、不再回吐正文，并记 `seen`（127-135）。原始 key 与夹取后等价 key 都记（150-152）。
  - 越界：`safeRelPath(rel)` 返回 null 时拒绝（120-121）。
  - 行数截断（156-159，`slice.length > MAX_READ_LINES` 取前 2000）、字符截断（164-167，`body.length > MAX_READ_CHARS`）。
  - 行号前缀在 160 用 `${start + i}| ${l}` 拼。
  - 测试见 `test-agentic.mjs:89-129`（全文/行范围/不存在/缺 path/越界/行号越界）、`:501-540`（重复读抑制、换行范围、不同文件、不带 end_line）。
- `makeListFilesTool(workspace)`（179-197）：`list_files` 实现。`depth` 夹在 `[1,4]`（183）；`IGNORED_DIRS` 过滤（191-192，规则见 `ignored` 191 行）；空目录给「没有文件」说明（193-194）；末尾标注隐藏了几个目录（194）。
  - 测试见 `test-agentic.mjs:131-148`（根目录/子目录/空目录）、`:573-587`（隐藏 node_modules 与 .git）。
- `safeRelPath(rel)`（266-273）：路径越界防护。拒绝 `/` 开头、`C:/` 绝对路径、`../` 跳目录（267-272）。返回归一化后的 POSIX 相对路径，否则 `null`。测试见 `test-agentic.mjs:80-87`。

### 文章 markdown 生成（Article markdown generation）

- `makeArticleEditor(initial = '')`（200-263）：文章编辑工具，状态在闭包 `let article` 里（200-201）。返回对象（258-263）：
  - `edit`（202-257）：处理 `command`。
    - `view`（204-207）：空文章回「（文章当前为空）」，否则回 `numberLines(article)`。
    - `str_replace`（208-230）：`old_str` 缺失报错（211）；CRLF↔LF 行尾归一化后做 `indexOf` 唯一匹配（216-228），匹配中再查第二次出现（223-226），多处命中或非空 `old_str` 缺失都报错，命中后按原文风格写回（227-228）。
    - `insert`（231-255）：负数行号必须报错（235-237，不能静默插到最前）；`line=0` 插到最前、否则插到第 `line` 行之后（250-251）；空文章按零行处理（245）。
    - 未知 `command` 报错并列可用值（256）。
  - `get article`（260）/ `set article`（261）：读写闭包状态。
  - 测试见 `test-agentic.mjs:151-207`（insert/str_replace/view/越界/未知命令）、`:542-561`（CRLF 归一与保持行尾）、`:589-595`（负数行号报错）。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked = null })`（279-315）：把四个工具聚成 `{ read_code, list_files, edit_article, generate_sub_module }` 对象。
  - `read_code`/`list_files` 由 `makeReadCodeTool`/`makeListFilesTool` 构造并注入 workspace 与 `getStep`（282-283）。
  - `edit_article` 直接取 `editor.edit`（284）。
  - `generate_sub_module`（285-313）：`onSubModule` 为 null（当前模式不支持递归）时**必须说实话**——`subModuleBlocked === 'max-depth'` 报「已经到达子模块嵌套上限」（294-300），否则报「当前模式不支持递归成文」（301-305），二者都返回 `isError: true`，绝不谎称「已记录/已派发」（避免父文写「详见某文件」而该文件从未生成，见 290-306 注释）。否则调 `onSubModule({ name, components, description })`（308-312）。
  - 测试见 `test-agentic.mjs:380-449`（子模块委派/无 onSubModule 报错/深度到顶/工具数量）、`:597-600`（暴露四个工具）。
- `runAgenticArticle(opts)`（331-432）：步循环本体。
  - 入参解构（332-345）：`mission`、`streamFn`、`workspace`、`tools: extraTools`、`editor: existingEditor`、`onSubModule`、`subModuleBlocked`、`maxSteps`（默认 `DEFAULT_MAX_STEPS`）、`signal`、`initialMessages`、`systemPrompt`、`articleFormat`。
  - 缺 `streamFn` 直接抛 `Error('runAgenticArticle 需要 streamFn')`（347）。
  - 编辑器缺省用 `makeArticleEditor(opts.initialArticle ?? '')`（348）；`stepRef.current` 供 `read_code` 报步号（350、368）。
  - 只把实际可用的 schema 声明给模型（354，过滤掉 `tools[t.name]` 不是函数的项）。
  - for 循环（367-423）：每步调 `streamFn({ messages, tools: schemas, signal })`（373）；空 blocks → `empty-response`（380）；assistant 消息原样进历史（383）；无 `tool-call` 视为写完——若 `editor` 空而文本像文章则收下正文（391）、`finished`（393）。有调用则逐个 `parseToolArgs` 解析（401）→ `impl(args)`（408）→ 结果包成 `tool-result` 回灌（413-420）。
  - `stopReason` 取值：`max-steps`（365 初值）、`aborted`（369）、`stream-error`（377）、`empty-response`（380）、`finished`（393）。
  - 返回 `{ article, steps, usedTools, stopReason, messages }`（425-431）。
  - 测试见 `test-agentic.mjs:210-454`（无工具收正文/两轮/回灌/原样历史/未知工具/坏 JSON/抛错/maxSteps/空响应/abort/正文不覆盖文章/缺 streamFn）。
- `DEFAULT_MAX_STEPS = 30`（325）：单篇步数上限**唯一定义点**（见 `lib/agentic.js:321-325` 注释；`lib/articles-agentic.js` 从这里再导出）。
- `stripJsonFence(s)`（439-444）：剥 ```` ```[lang] ```` 围栏，返回内部文本。测试见 `test-agentic.mjs:470-475`。
- `sliceBalancedObject(s)`（447-473）：从任意位置截首个括号平衡的 JSON 对象，跳过字符串字面量里的括号（字符串内 `\` 跳一字符、引号切 `inStr`）。测试见 `test-agentic.mjs:477-485`。
- `parseToolArgs(raw, steps, step, toolName)`（476-500）：坏 JSON 容错解析。已是对象则直通（477）；字符串按「原样 → 剥围栏 `stripJsonFence` → 截平衡对象 `sliceBalancedObject`」三级递进（481-485）；`JSON.parse` 失败或非对象（数组/标量）记 `steps.warning` 并回 `{}`（487-499）。测试见 `test-agentic.mjs:464-499`。

## Architecture

本模块组件 ≥3 且「提示词组合 → 观察 → markdown 生成」贯穿一次循环，故画框图（箭头表示调用/数据流方向）：

```text
  runAgenticArticle (lib/agentic.js:331)  步循环，消费 streamFn 的 blocks
            │  buildOpeningPrompt 拼开场提示词 (:506)
            ▼
   ┌──────────────────────────────────┐
   │ TOOL_SCHEMAS (lib/agentic.js:27) │  4 个工具 JSON-Schema
   └───────────────┬──────────────────┘
                   │ 过滤后声明给模型 (:354)
       ┌───────────┼───────────────┬──────────────────┐
       ▼           ▼                ▼                  ▼
  read_code    list_files     edit_article     generate_sub_module
  (:115)       (:179)         (:200)           (:285, in buildToolset)
       │           │                │
       ▼           ▼                ▼
  numberLines  IGNORED_DIRS   makeArticleEditor
  (:101)       (:98)          article 闭包状态 (:258)
       │           │                │
       ▼           ▼                ▼
  workspace.readFile  workspace.listDir  editor.article
       │ safeRelPath 越界防护 (:266)
       ▼
  parseToolArgs (:476) ──► stripJsonFence (:439) / sliceBalancedObject (:447)
       │ 工具结果回灌为 tool-result (:413-420) ──► 下一轮 messages
```

要点：

- **提示词与工具同源**：`TOOL_SCHEMAS` 既是模型看到的工具声明，也驱动 `buildOpeningPrompt` 的工作约定（见 507、535-538）。
- **观察工具不触 llm**：`read_code`/`list_files` 只通过注入的 `workspace`（由上游 `lib/agentic-host.js` 的 `makeFsWorkspace` 提供）读盘/列目录，`safeRelPath` 与 `makeFsWorkspace.absOf` 构成双重越界防护。
- **文章状态在编辑器闭包里**：`makeArticleEditor` 返回的 `article` 是循环内唯一的文章真相，模型每次 `insert`/`str_replace` 都改这一份，最终 `runAgenticArticle` 通过 `editor.article` 取回（425-431）。
- **工具调用闭环**：模型发出的 `tool-call` 经 `parseToolArgs` 解析 → `impl` 执行 → 包成 `tool-result` 回灌进 `messages`，下一轮再喂给 `streamFn`（398-421）。

## Data Flow

以一次正常 agentic 写作为例（串联本模块内部与 `test-agentic.mjs` 的 `runAgenticArticle` 调用）：

1. **开场提示词**（506-541）：`runAgenticArticle` 构造首条 user 消息，正文为 `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（359）。`schemas` 来自 `TOOL_SCHEMAS` 过滤（354）。
2. **进入步循环**（367-423）：每步先刷 `stepRef.current`（368），调 `streamFn({ messages, tools: schemas, signal })`（373）。
3. **模型读码（observation）**：模型发 `read_code`/`list_files` `tool-call` → `parseToolArgs` 解析（401）→ `makeReadCodeTool`/`makeListFilesTool` 执行（155、179）。`read_code` 读盘前查 `seen` 去重（128-135）、`numberLines` 加前缀（160）、按 `MAX_READ_LINES`/`MAX_READ_CHARS` 截断（156-167）；`list_files` 过滤 `IGNORED_DIRS`（191-192）。结果包成 `tool-result` 回灌（413-420）。
4. **模型写文章（markdown generation）**：模型发 `edit_article` `tool-call` → `makeArticleEditor.edit`（202-257）改闭包 `article`（str_replace 做 CRLF 归一与唯一匹配，insert 拒绝负行号）。
5. **收尾**：模型不再发 `tool-call`（无调用）→ 若编辑器为空且给了正文则收下（391）、`finished`（393）。空 blocks 则 `empty-response`（380）。
6. **取回文章**：`runAgenticArticle` 返回 `{ article: editor.article, steps, usedTools, stopReason, messages }`（425-431）。上游 `lib/articles-agentic.js` 的 `runOneArticle`（178）再把它落盘。

异常流：`streamFn` 抛错 → 记 `steps` 并 `stopReason='stream-error'`（375-379）；工具抛错 → 捕成 `isError:true` 结果回灌（409-411，测试见 `test-agentic.mjs:307-322`）；参数坏 JSON → 记 `steps.warning` 回 `{}`（487-499，测试见 `test-agentic.mjs:293-305,487-499`）。

## Connections

- [[agentic_core]]：`lib/agentic.js` 即本模块，是 `agentic_core` 的纯逻辑核心层（另含 `lib/agentic-host.js` 宿主适配、`lib/articles-agentic.js` 执行器、以及 `lib/article-contract.js` 写集闸门）。本模块提供工具循环与四个工具实现，`agentic_core` 文章从更宽视角统筹四文件。
- [[agentic_host]]：`lib/agentic-host.js` 的 `makeFsWorkspace`（111-135）提供本模块 `read_code`/`list_files` 所需的 `workspace.readFile`/`listDir`（见 `lib/agentic.js:186,179`），`makeHostStream`（83-108）则把 `llm.stream` 收成 `runAgenticArticle` 消费的 `blocks`。
- [[articles-agentic]]：`lib/articles-agentic.js` 的 `runOneArticle`（33-179）是本模块的生产入口装配者——它构造编辑器、workspace、streamFn，再把 `onSubModule`/`subModuleBlocked` 连同 `editor` 一并交给 `runAgenticArticle`（130-142），最后用返回的文章落盘。
- [[article-contract]]：`lib/article-contract.js` 的 `makeWriteSet`/`isWritable` 被 `lib/articles-agentic.js` 的写集闸门复用，与本模块的越界读防护构成「读/写」两道边界。
- [[index]]：插件入口。`agenticMaxSteps` 默认值必须与本模块 `DEFAULT_MAX_STEPS`（30）一致（见 `lib/agentic.js:321-325`）。

## Known Issues

- **重复读抑制是 per-tool 实例的**：`makeReadCodeTool` 的 `seen` Map 由 `buildToolset` 创建并传进工厂（279-282）。若 `buildToolset` 被重建（例如注入新 workspace）去重状态会丢，已读文件会再次回吐正文。测试 `test-agentic.mjs:501-540` 只验证了首个实例内的去重。
- **`list_files` 的 `depth` 实际由 `makeListFilesTool` 夹在 `[1,4]` 后扔给 `workspace.listDir`，但 `makeFsWorkspace.listDir` 只列单层**（`lib/agentic-host.js`:`listDir` 签名为 `(rel)`，不递归）。递归/忽略目录逻辑全在 `lib/agentic.js` 侧，调用方传 `depth` 在 host 层是个 no-op（见 `[[agentic_host]]` 已知问题）。
- **`parseToolArgs` 坏 JSON 只记 warning 回 `{}`**：参数解析失败时工具拿空参数执行（`read_code` 报缺 path、`edit_article` 报缺 command），模型需从回灌结果里自己纠正（见 `lib/agentic.js:434-500` 与 `test-agentic.mjs:293-305`）。
- **`readFile` 底层用同步 `readFileSync`**：`makeFsWorkspace.readFile` 是同步实现，`makeReadCodeTool` 用 `await` 等它（见 `[[agentic_host]]` 已知问题）。超大单行文件仍会一次性读进内存、只被 `MAX_READ_CHARS` 截断。
- **`generate_sub_module` 在无 `onSubModule` 时返回 `isError:true`**：这是故意的「说实话」设计（290-306），但意味着当上游 `dispatchSub` 被深度封顶而置为 `null` 时，模型必须按提示把自己的子模块写成普通小节、不可留死链（测试 `test-agentic.mjs:401-436`）。
- **无显式禁用/注释掉的死代码**：通读 `lib/agentic.js` 全文，本模块所有导出均为活跃实现，无被注释屏蔽的功能分支。
