---
name: codewiki
description: 维护当前代码库的活 wiki：cw status 三态判定 → 读 ~/.codewiki/ 文章辅助编码 → 收尾写 learnings/decisions 并 cw index + meta update。编码会话开始与收尾时使用。
---

# CodeWiki Session（DSH 适配版）

基于 [mraza007/codewiki](https://github.com/mraza007/codewiki)。本机由 `dsh-codewiki` 插件提供：

- 工具 **`cw`**：直接跑 CodeWiki CLI（status / init / index / meta update / path / projects / setup / uninstall）。不要走 shell。
- 工具 **`codewiki_generate`**：智能体编排编译（规划 → 分批子代理写文章 → 横切 → 审校 → index + meta update），可用 provider+model 指定子代理模型。
- wiki 落在 `~/.codewiki/<project>/`（中心化，仓库内不留文件）。

## 会话开始

1. `cw status`（cwd = 当前仓库）判态。

2. **无 wiki**（missing）→ `cw init` → `codewiki_generate`（全量编译）。
3. **未编译**（uncompiled）→ `codewiki_generate`（全量编译）。
4. **有过期文章**（stale）→ `codewiki_generate` scope=stale（或 auto，等价）。
5. **最新**（clean）→ 跳过，直接做用户的任务。

全量编译耗时数分钟且派多个子代理：放后台跑，继续手头任务；注意并发上限 2（`codewiki_generate` 已内置分批）。

## 编码中

- 动某模块前先读它的文章（`cw path` 拿 wiki 目录，读 `modules/<name>.md`、`_architecture.md`），比从零读源码快。
- 文章行号/清单若与代码冲突，以代码为准，并在收尾时修正文章。

## 每完成一个任务（不等会话结束）

1. **更新受影响文章**：改了 `src/foo.rs` 且 `modules/foo.md` 描述它 → 立即更新该文章（此刻上下文最全）。
2. **修了 bug** → 写 `learnings/<slug>.md`：
   ```
   ---
   title: <一句话>
   type: learning
   source_files: [受影响文件]
   tags: [相关, 标签]
   ---
   现象、根因、修法。
   ```
3. **做了设计决策** → 写 `decisions/<slug>.md`：
   ```
   ---
   title: <决策>
   type: decision
   tags: [相关, 标签]
   ---
   决定、理由、考虑过的替代方案。
   ```
4. `cw meta update` 记录基线 commit。这是任务收尾的一部分，不是额外步骤。

## 会话结束

`cw index` 重建总索引。其余每步都已即时处理。

## 文章质量红线（写/改文章时遵守）

- Key Components 列全部公开函数/类/常量及行号；每个 struct/model 全部字段；全部方法（含属性方法）。
- 行号必须实读源码验证，禁止猜测；区间覆盖完整函数体。
- source_files 列出实际读过的每个文件（含测试文件），POSIX 相对路径。
- 功能被禁用时写明具体位置（文件+行号），不许只写 "disabled"。
- 架构图用 UTF-8 box-drawing 字符放 ```text 围栏，≤20 行，框标组件名+文件/类，箭头标关系。
- Markdown 规范：## / ### 不跳级；代码围栏带语言标签；结构化对比用表格。
- 写给零上下文的未来 agent：具体到文件名、函数名、类型、行号；宁可多细节，不许概括省略。
- `_index.md` 必须列全 wiki 内所有 .md（`cw index` 自动保证）。

## DSH 纪律

- 子代理并发上限 2；派单前确认仓库在主题分支（subagent 不受 branch-guard 保护）。
- 指定便宜模型跑编译：`codewiki_generate` 传 provider+model（建议路由插件的 wiki 档），或插件设置里配默认。
- 宣称编译完成前核对：`cw status` 回到 "Wiki is up to date."。
