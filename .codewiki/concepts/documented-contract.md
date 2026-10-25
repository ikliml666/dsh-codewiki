---
title: documented-contract
type: concept
source_files:
  - test-orchestration.mjs
  - .tmp-test-orchestration.log
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - index.js
  - client.js
  - package.json
tags: [文档契约, 跨模块, codewiki, frontmatter, 文章格式, 测试验证]
---

## Overview

`documented-contract` 指 dsh-codewiki 插件（当前版本 0.10.10，package.json:6）中由文档显式规定、并被代码与测试共同遵守的结构化约定。核心包含四层契约：(1) **入口契约**——仓库根 `CodeWiki.md` 声明为项目 wiki 入口（CodeWiki.md:3），`codewiki_generate` 以其为起点细化出 `.codewiki/` 文章群，`ensureWikiEntry`(index.js:214-247) 在编译收尾时对缺失入口自动生成模板且绝不覆盖已有入口；(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`）开头并含固定六章节，由 `articleFormatSection`(index.js:651-680) 规定模板，`writeValidated`(index.js:1382-1398) 强制 frontmatter 闸门，`fixAnchors`(index.js:401-484) 依据 frontmatter `source_files` 校正行号锚点；(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（index.js:214-364），阶段机 articles→crosscut→compose→review→index 已无规划阶段（`STAGE_HANDLER` index.js:2044-2050，0.10.7 删除），编译产物由插件自己 `autoCommitWiki`(index.js:2926-2968) 提交（pathspec 限定 `WIKI_PATHS` 两路径，index.js:36），其 committed/no-changes/pending 三态由 0.10.10 新增的 `autoCommitState`(index.js:1214-1219) 唯一判定——已提交或产物无改动时 `wakeCompileSession`(index.js:1221-1236) 完全不打扰会话；(4) **工具输出 schema 契约**——四个工具的输出经宿主 JSON Schema 校验，可空字段一律 `oneOf` 形态。测试侧 `articleMd`(test-orchestration.mjs:33-34) 合成契约文章、`autoCommitState` 三态断言组（test-orchestration.mjs:479-489）与输出 schema 校验块（test-orchestration.mjs:34-72）验证契约不被破坏，让文档自身成为可机器消费的索引。

## Key Components

### index.js 契约执行侧符号

- `articleFormatSection`(index.js:651-680)：定义文章模板，硬编码 frontmatter 键（title/type/source_files/tags，index.js:651-656）与章节顺序 `## Overview`…`## Known Issues`（index.js:651-656）；行号引用条款「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:651）、source_files 完整性条款「必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:651）、Architecture 框图条款（index.js:651）、Connections 用 `[[backlinks]]`（index.js:651）与「写给零上下文的未来 agent」（index.js:651）。
- `writeValidated`(index.js:1382-1398)：keepInMemory 任务（横切/校对/合成）的唯一落盘闸门，要求内容以 `---` frontmatter 开头否则记 invalid 丢弃、原文件保留（index.js:1382-1385）；写盘前过 `fixAnchors`(index.js:1389)。
- `applyTaskResult`(index.js:311-324)：普通文章任务直写出口，同样先 `fixAnchors`(index.js:315-317) 再落盘；keepInMemory 只回内存不落盘（index.js:311）。
- `fixAnchors`(index.js:401-484)：落盘前把「file:NN(-MM)」锚点对照 source_files 源码确定性校正，仅对 frontmatter `source_files` 内文件引用生效（index.js:401-409，basename 唯一匹配 408-410）；多处出现时只认唯一声明形态（function/class/const/let 正则 index.js:401），歧义或找不到→不改并记 unresolved（index.js:401-403）；区间尾越界钳到文件尾（index.js:401-404）；混合行尾按整文主风格规范化（index.js:401、index.js:401）。
- `parseSourceFiles`(index.js:969-981)：解析 frontmatter 的 `source_files`，支持 inline `[a,b]`（index.js:970-973）与 block `- a`（index.js:974-980）两式；`readSourceFiles`(index.js:983-991) 供 stale 流程取文件清单（index.js:2328 调用）。
- `numberLines`(index.js:390-392)：源码内联时每行加「N| 」grep 风格前缀——行号契约的数据基础（`collectSources` index.js:500 使用）。
- `ensureWikiEntry`(index.js:214-247)：编译收尾保证入口存在，已有入口绝不覆盖（index.js:214），缺失时按语言生成中/英模板（index.js:214-240）；由 `tickIndex` 在 writtenCount>0 时调用（index.js:214-218）。
- `installUpdateReminder`(index.js:3014-3046)：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:3014，order=TOOL_REPORT+1 index.js:3014），text 回调实时求值——门控只看仓库根是否有 `CodeWiki.md`（index.js:3014），不看 `.codewiki/` 目录；`updateReminder=false` 返回空串（index.js:3014）；门控通过后拼入 `commitHintText`(index.js:3030) 的产物待提交提醒。
- `reminderText`(index.js:3003-3012)：维护提醒正文——收尾必须调 `codewiki_generate`、不要手改 `.codewiki/` 文章、不要等待/轮询、产物由插件自动提交无需跑 git（index.js:3007）；只有收到「产物待提交」提醒时才需要代为提交一次（index.js:3003）。
- `commitHintText`(index.js:2970-3001)：只在插件自动提交失败（三态为 pending）时注入一次性「产物待提交」提醒——0.10.10 起条件收敛为 `autoCommitState(latest) === 'pending'`（index.js:2970），已提交（committed）与产物无改动（no-changes）一律静默；时间戳比较仍要求编译完成晚于 `.codewiki`+`CodeWiki.md` 最后一次 git 提交（index.js:2970-2975），文案带 autoCommit 失败原因（index.js:2970-2972）并写明「不要为了本提醒中断当前任务、不要轮询」（index.js:2970）；60s TTL 缓存按 cwd 键（index.js:2970、index.js:2970-2971）。
- `autoCommitWiki`(index.js:2926-2968)：编译产物自动提交边界（0.10.9 引入，0.10.10 修正）。只 add `WIKI_PATHS`（`.codewiki` 与 `CodeWiki.md`，index.js:36、index.js:2930）两路径——`git add -- .codewiki CodeWiki.md` 的 pathspec 形式，不是 `-A`/`--all`/`.`（index.js:2926）；提交信息前缀 `docs(wiki):` 带任务 id 与篇数（index.js:2926-2927）、`--no-verify` 不跑仓库钩子（index.js:2926）；安全边界逐条拒绝并降级：非 git 仓库（index.js:2933）、无 HEAD（index.js:2934）、merge/rebase/cherry-pick 进行中（index.js:2926-2928）、未解决冲突（index.js:2939）、目标路径被 .gitignore 忽略（index.js:2926-2929）、缺 user.name/user.email（index.js:2926-2928）、add/commit 失败——0.10.10 起返回具体 stderr 摘录进 `reason`（index.js:2953、index.js:2962）；无改动返回 `noChanges` 不产空提交（index.js:2947）。返回 `{committed, sha?, message?, noChanges?, reason?}`（index.js:2947、index.js:2926）由 `tickIndex` 写入 `job.autoCommit`（index.js:2034-2040）。
- `autoCommitState`(index.js:1214-1219，0.10.10 新增导出纯函数)：自动提交三态的唯一判定——`committed=true` → `'committed'`、`noChanges=true` → `'no-changes'`、其余（含旧 job 无该字段）→ `'pending'`（index.js:1216-1218）；`committed` 优先于 `noChanges`（index.js:1216 先判）。**存在理由**：`wakeCompileSession`（实时 steer）与 `commitHintText`（系统提示 section）是两条独立通道，各写一遍判断时「产物无改动」会被当成失败、两条通道各打扰会话一次（CHANGELOG.md:8）。
- `wakeCompileSession`(index.js:1221-1236)：编译终态 steer 唤醒。0.10.10 起早退条件为 `outcome !== 'failed' && autoCommitState(job) !== 'pending'`（index.js:1221）——自动提交成功、或产物本就无改动，都完全不打扰会话；无 sessionId/冷会话/registry.get 抛错/steer 抛错一律静默（index.js:1221-1224、index.js:1221-1223）；steer 消息 `source: {kind:'plugin:codewiki'}`（index.js:1221）；降级文案含「产物待提交」标题、任务 id、失败原因与 `docs(wiki)` 指引（index.js:1232）。
- prompt 模板构造器：`batchArticlePrompt`(index.js:520-547) 在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；行号一律不得沿用」（index.js:520）并收尾注入 `articleFormatSection()`（index.js:544）；合成版 `batchArticleComposePrompt`(index.js:804-832) 同款条款（index.js:520、index.js:829）；`batchArchitecturePrompt`(index.js:737-743)、`batchPatternsPrompt`(index.js:745-751)、`batchConceptPrompt`(index.js:753-759)、`batchObservePrompt`(index.js:763-780)、`batchArticleObservePrompt`(index.js:784-800)、`batchProofreadPrompt`(index.js:836-855) 同守格式与行号条款；`batchProofreadBatchPrompt`(index.js:859-886) 规定 0.10.8 批量校对的输出契约——逐篇按「@@@article: 名 /
