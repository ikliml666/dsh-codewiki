---
title: cw-binary-source-lost
type: learning
source_files:
  - index.js
tags: [vendor, rust, cw-cli, path-separator, windows, lesson]
---

## 症状

codewiki_generate 全量编译后，`.codewiki/_index.md` 里子目录文章的 wiki 链接是反斜杠：`[[learnings\update-reminder-entry-gap|…]]`——Windows 下 Rust `Path::display()` 输出 `\` 分隔符（vendor/codewiki/src/main.rs:243 `rel.display().to_string()`）。stale 检测输出的文章路径（`! <article>`）同样带 `\`。

## 排查链（重要：vendor 快照 ≠ 现役二进制的源码）

1. 最初计划改 vendor/codewiki（Rust 源码）根治，已定位两处（main.rs:190 stale 路径、main.rs:243 链接）并写出 `rel_path_string` 修复。
2. cargo build 成功，但产物跑 `cw index` 报 **"No wiki found"**——vendor 源码的 config.rs:37-41 把 wiki 放 `~/.codewiki/<project>/`（旧架构）；现役二进制认识**仓库内 `.codewiki/`**。
3. 实证：PATH 的 `~/.cargo/bin/cw.exe` 与插件 `bin/cw.exe` md5 相同（835702929c4ec44149ad97ae25192955）；`~/.cargo/.crates2.json` 显示安装来源 `path+file:///C:/Users/ik/AppData/Local/Temp/cw-src`——**Temp 已被清理，真源码丢失**。vendor/codewiki 是早期 vendored 的上游开源快照（README 指向 mraza007/codewiki），从未跟上仓库内架构的魔改。
4. vendor 上的修复已回滚（git checkout）——留着一个编译不出可用二进制的「修复」会误导后来者从 vendor 构建安装、造成架构倒退（全局 wiki）。vendor/codewiki/target 编译产物已清理。

## 落地修复（插件层收口，0.5.0.1）

在 index.js 实现「路径进插件即规范化」：

- `normalizeArticlePath(p)`：`\` → `/`。
- `parseStatus`（export）：changedFiles/staleArticles 逐项规范化——stale 路径将流入预构建任务回写文章，规范化后跨平台安全。
- `normalizeIndexLinks(cwd)`（export）：cw index 落盘后把 `_index.md` 中 `[[link|` 链接头内的 `\` 规范化为 `/`；幂等（无改动返回 false）、文件缺失静默跳过、**不碰正文**（_meta.yaml 的 Windows 绝对路径与正文示例不受影响）。tickIndex 在 cw index exit 0 后调用，有改动记 note。

本仓库现有 _index.md 已用该函数实际修复（`[[learnings/update-reminder-entry-gap|…]]`）。

## 上游验证（2026-10-10，用户发来 github.com/mraza007/codewiki 后核实）

- 上游 main：Cargo.toml `version = "0.1.0"`；config.rs `wiki_home() = ~/.codewiki`、`wiki_path = ~/.codewiki/<project>`（project_name 从 git remote origin 派生，回退目录名）；README 设计原则 "Central location. All wikis live at ~/.codewiki/. Survives repo deletion."。**上游从未有过仓库内 .codewiki 架构**——从上游重装不可能找回现役二进制的行为。
- 现役二进制实证：`cw path` 恒返回 `cwd/.codewiki`（非 git 目录也是）；命令集与帮助文本（"Manage LLM-compiled code wikis"）与上游逐字一致 → 魔改集中在路径语义 + projects 枚举，但二进制内嵌 `codewikiLocal` 等未知标识说明魔改全貌不可考。
- `~/.codewiki/deepseek-harness/` 是 10-01 `cw init` 留下的中心架构脚手架（_meta.yaml+空目录，无文章 → `cw projects` 显示 `[not compiled]`）；现役 `projects` 仍枚举中心目录（兼容保留），与插件流水线无关。
- 若未来要重建真源码：clone 上游 v0.1.0 → 重新实施路径魔改（config.rs + 涉及 status/index/meta 输出的部分）→ 风险点是插件 parseStatus 依赖的三态输出字符串必须逐字一致，需先 strings 对比现役二进制。在那之前插件层收口（本篇）继续有效。

## 教训

1. **cargo path 安装的源码放 Temp = 定时丢失**。装完应把源码落盘到稳定位置（如 vendor/ 同步更新或独立仓库），.crates2.json 是事后追查安装来源的唯一线索。
2. **vendor 快照必须与现役二进制同源**，否则「改 vendor 上游」是看似根治的陷阱——编译成功≠构建出的是现役二进制；动手前先验证 vendor 产物与现役二进制的行为差异（本例一行 `cw index` 就暴露了）。
3. 无法改上游时，在自己可控的边界收口（消费点规范化）并如实记录原因，比留下误导性的半成品修复更诚实。

## Connections

- [[core-logic]]：normalizeArticlePath / parseStatus / normalizeIndexLinks / tickIndex 所在模块。
- [[testing-suite]]：test-wiki-entry.mjs 23 断言（含规范化组）。
