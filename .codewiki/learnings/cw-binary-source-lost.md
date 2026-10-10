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

## 源码重建（2026-10-10 同日完成——本篇的结局）

用户拍板「源码复制到本地一份保存在本地，在本地重构源码」，当天完成：

1. **取证收敛**：`git clone` 上游 main（64323823，2026-04-06）并与 vendor 快照 diff——**逐字节一致**，vendor 就是上游；`cw init` 探测确认现役二进制 init 也建仓库内 `.codewiki`；`meta.rs`/`frontmatter.rs` 与真实 `_meta.yaml`/文章 frontmatter 字段逐一吻合。
2. **魔改面收敛到单点**：上游全部命令经 `config::wiki_path()` 取 wiki 位置——把 `wiki_path` 改为 `repo_path.join(".codewiki")` 即可让 init/status/meta/index/path 全部仓库内化；`cw projects` 用独立的 `wiki_home()`（中心目录），与现役「projects 枚举中心、deepseek-harness 脚手架 `[not compiled]`」的行为吻合。此前看到的 `codewikiLocal` 字符串是 `.codewiki`+`Local…` 两个串的拼接假象。
3. **重施魔改 + 根治反斜杠**：vendor/codewiki/src/config.rs 单点改 `wiki_path`；main.rs 新增 `rel_path_string()`（`to_string_lossy().replace('\\', "/")`）替换两处 `Path::display()`（stale 清单 main.rs:190、_index.md 链接 main.rs:243）——最初想做的根治这次真正落地。
4. **对比验证**：探测仓库上 init/path/status（未编译态）/meta update/index/projects 与旧二进制逐字节一致；`_index.md` 与 stale 清单唯一差异 `\`→`/`（预期）；真实仓库 stale 检测正常（`! modules/auth.md` 正斜杠）。坑：`git diff <last>..HEAD` 只看**已提交**变更，探测脚本里未提交的改动测不出 stale；`cargo install --path` 因 SSL 吊销检查离线失败，直接复制编译产物安装。
5. **安装**：新二进制（md5 `952b0282523ad016c13688cc594afdd8`）同步到 `bin/cw.exe` 与 `~/.cargo/bin/cw.exe`；旧二进制备份 `bin/cw.exe.bak-20261010`（835702…，gitignore）。插件测试 23 断言 + 编排 117 项全过；本仓库 `cw index` 原生输出与插件规范化后的 `_index.md` 逐字节一致——`normalizeIndexLinks` 降级为纵深防御。
6. fork 基线/魔改/构建/警告文档化在 `vendor/codewiki/FORK.md`；**此后改 cw 行为直接改本目录源码，不再有「源码在哪」的问题**。

## Connections

- [[core-logic]]：normalizeArticlePath / parseStatus / normalizeIndexLinks / tickIndex 所在模块。
- [[testing-suite]]：test-wiki-entry.mjs 23 断言（含规范化组）。
