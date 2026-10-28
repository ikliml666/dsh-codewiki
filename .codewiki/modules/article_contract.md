---
title: article_contract
type: module
source_files:
  - lib/article-contract.js
  - test-article-contract.mjs
  - index.js
  - lib/articles-agentic.js
tags: [article, contract, validation, write-set, gate]
---

## Overview

`lib/article-contract.js` 是 wiki 文章的**格式解析、结构校验与写集（write-set）闸门**模块。它把所有「一篇 wiki 文章要满足的最低结构」集中到一个纯函数包里，让真正落盘的地方（`index.js` 的并发池与 agentic 执行器）统一调用，而不是像旧实现那样各查一段。

背景缺陷（见文件头注释 `lib/article-contract.js:1-12`）：旧闸门 `validateArticleEnvelope`（`index.js:1082`）只查「frontmatter 有没有开头、有没有闭合」，于是下面这些坏文章都能入库并被 `cw index` 收进索引：

- `concepts/wiki-generation-flow.md` 从第 64 行起又贴了一份 frontmatter 与整段正文；
- 必需章节（如 `## Key Components`）存在但正文是空的（只有标题）；
- `source_files` 列着不存在的文件、或列了目录、或列了早已删除的临时文件（`.tmp-test-*.log` / `.probe3.txt`）；
- 正文里的 `[[链接]]` 指向早已删掉的文章；
- 代码围栏没闭合，后面整篇都被当成代码块。

本模块因此把判据分成两级（`SEVERITY`，`lib/article-contract.js:56-73`）：

- **error（structure broken）**：结构已破坏，落盘即污染 wiki，必须拒写（重复 frontmatter、围栏未闭合、source_files 不存在/越界/非证据、死链、缺必填字段、正文为空、必需章节空着）。
- **warning（content not up to par but structure intact）**：内容不达标但结构完整（缺必需章节、非必需章节空着）。不拒写——旧通道的整包装填产出天然是「一段正文」，硬拒会把存量文章全判死——但会让本次编译终态降为 `partial` 并阻止基线前移（「装绿」是不允许的）。

模块本身是**纯函数（不碰文件系统）**（`lib/article-contract.js:11`），因此可以单测（见 `test-article-contract.mjs`）；真正的文件系统判定通过调用方注入的 `fsImpl` 适配完成。判据按「文章类型 → 必需章节」配置（`lib/article-contract.js:34-45`），避免对 `learning` / `pattern` 类文章过度要求。

## Key Components

## Architecture

## Data Flow

## Connections

## Known Issues
