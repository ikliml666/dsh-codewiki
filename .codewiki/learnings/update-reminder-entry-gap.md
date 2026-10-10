---
title: update-reminder-entry-gap
type: learning
source_files:
  - index.js
  - test-wiki-entry.mjs
tags: [reminder, gating, invariant, bugfix, hook]
---

## 症状

模型收尾时从不调用 `codewiki_generate` 编译 wiki——「CodeWiki 维护」提醒在已有 `.codewiki/` 的仓库（Wxxy-CampusLogin / CampusHub，当天刚编译过）从未注入；PreToolUse nudge hook 有提示，但文案只列手工 cw 流程、不含工具名。

## 根因

139052c（2026-10-07）把 SessionStart 提醒门控收紧到 `<repo>/CodeWiki.md` 入口文件存在（index.js:2082 `if (!cwd || !fs.existsSync(path.join(cwd, 'CodeWiki.md'))) return ''`），但全链路没有任何代码创建该入口：流水线文章写 `.codewiki/`，index 阶段只跑 `cw index` + `cw meta update`；vendor/codewiki（Rust cw CLI）0 处提及 CodeWiki.md。该 commit message 声称入口 "the plugin itself owns"——假设了未实现的不变量。于是「编译过但无入口」的仓库永远收不到提醒。

## 修复（0.5.0.1，f6d8145）

- `ensureWikiEntry`（index.js，export，签名 `(cwd, language='中文')`）：仓库根缺 CodeWiki.md 时生成中/英双语入口（含 `.codewiki` 绝对路径、_index/_architecture/modules/concepts 指引、`codewiki_generate` 收尾要求、「人工改写不覆盖」声明）；已有入口绝不覆盖。
- `tickIndex`：writtenCount>0 且 cw index/meta update 之后调用，失败只记 note 不影响任务。老仓库重编译一次即自愈。
- `~/.dsh/hooks/codewiki-nudge.js`（PreToolUse edit|write）文案补上 `codewiki_generate` 工具名。

## 教训

1. 收紧门控时，先确认新条件的「创建者」在链路里真实存在——门控不变量需要有人兑现（gate ⇒ ensure creator）。
2. commit message 声称的所有权要对着代码验证；技能文案承诺（vendor/codewiki/skills/codewiki-session.md:30 "entry file at `<repo>/CodeWiki.md`"）与实现脱节数周无人察觉。
3. 提醒链路要有端到端断言：test-orchestration.mjs 早有提醒用例，但只测「有入口注入 / 无入口不注入」，没测「编译后入口会出现」——本次在真实编译任务 notes 里实证「仓库根缺 CodeWiki.md 入口，已自动生成」才闭合。

## Connections

- [[core-logic]]：ensureWikiEntry 与 tickIndex 所在模块。
- [[testing-suite]]：test-wiki-entry.mjs 13 断言与编排冒烟。
