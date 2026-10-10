# cw fork（仓库内架构 + Windows 路径修复）

本目录是 [mraza007/codewiki](https://github.com/mraza007/codewiki) 的**本地 fork**，为 dsh-codewiki 插件提供 `cw` CLI 的可维护真源码。

- **基线**：上游 main `64323823b6767d74af732f742c67ed75371c4f0d`（2026-04-06），已验证与 2026-10-10 的上游 main 逐字节一致（src/ + Cargo.toml diff 为空）。
- **历史**：插件的现役二进制曾在 Temp/cw-src 魔改编译后源码丢失（见 `.codewiki/learnings/cw-binary-source-lost.md`）；2026-10-10 以本目录为基线在本地重施魔改并重建二进制，此后源码永久保存在本目录（随插件仓库提交）。

## 魔改点（相对上游的全部差异）

1. **`src/config.rs` — `wiki_path()` 仓库内化**（重建丢失的魔改，单点改动）：
   - 上游：wiki 在 `~/.codewiki/<project>/`（中心制）。
   - 本 fork：wiki 在 `<repo>/.codewiki/`（随仓库版本管理）。init/status/meta/index/path 全部经 `wiki_path()`，一处改动全部生效；`project_name`/`wiki_home` 保留（init 的 meta.project 与 `cw projects` 仍枚举中心目录，行为与丢失的现役二进制一致）。
2. **`src/main.rs` — `rel_path_string()`**（新增根治）：
   - 上游用 `Path::display()` 渲染文章相对路径，Windows 下输出 `\` 分隔符，污染 stale 清单与 `_index.md` 的 `[[...]]` 链接。
   - 本 fork 统一渲染 `/`。插件侧 `normalizeIndexLinks`（index.js）保留为纵深防御。

## 构建 & 安装

```bash
cd vendor/codewiki
cargo build --release
cp target/release/cw.exe ../../bin/cw.exe      # 插件自带二进制
cp target/release/cw.exe ~/.cargo/bin/cw.exe   # PATH 里的全局二进制
```

注意：`cargo install --path .` 会先联网更新 registry（本机曾因 SSL 吊销检查离线失败），直接复制编译产物即可。

## ⚠️ 警告

- **不要用上游原版覆盖本目录**——会把架构倒退回中心制（编译产物跑 `cw index` 会报 `No wiki found`）。
- 不要把源码放到 Temp 等易清理目录（前车之鉴）。
- 改动本目录源码后，必须重编译并同步更新两处二进制，再跑插件测试（test-wiki-entry.mjs + test-orchestration.mjs）回归。

## 行为规格（与上游的可观测差异）

| 命令 | 上游 | 本 fork |
|---|---|---|
| `cw path` | `~/.codewiki/<project>` | `<repo>/.codewiki` |
| `cw init` | 建中心 wiki | 建 `<repo>/.codewiki/`（5 个子目录 + _meta.yaml） |
| `cw status` | 三态（No wiki / not compiled / up to date / changed+stale），只看已提交变更（`git diff <last>..HEAD`） | 同左，路径 `<repo>/.codewiki`；stale 文章路径 `/` 分隔 |
| `cw index` | 重建 `_index.md`（frontmatter 分组） | 同左，链接 `/` 分隔 |
| `cw meta update` | 记录 last_compiled_commit/at | 同左 |
| `cw projects` | 枚举中心 `~/.codewiki/*` | 同左（不变；仓库内 wiki 不列出） |

## 验证记录（2026-10-10）

- 旧二进制备份：`bin/cw.exe.bak-20261010`（md5 `835702929c4ec44149ad97ae25192955`，即丢失源码的最后产物）。
- 新二进制 md5 `952b0282523ad016c13688cc594afdd8`。
- 对比验证：探测仓库上 init/path/status（未编译态）/meta update/index/projects 逐字节一致；`_index.md` 与 stale 清单唯一差异为 `\`→`/`（预期修复）；真实仓库（dsh-codewiki）验证 stale 检测与全链路正常，插件测试 23 断言 + 编排 117 项全过，`cw index` 原生输出与插件规范化后的 `_index.md` 逐字节一致。
- 补测分支（新旧输出一致）：重复 `cw init`（Wiki already exists）、last_compiled_commit 不在历史（"no longer in history." + "Full recompile recommended."）。

## 已知有意差异（相对丢失的现役二进制）

- **内嵌 skill 模板文本**：本 fork 构建时嵌入 `skills/codewiki-session.md` 的 0.5.0.x 现代化文案（codewiki_generate 优先、CodeWiki 面板、`<repo>/CodeWiki.md` 入口承诺）；丢失版二进制嵌入的是子代理时代旧文案（launch background Agent / Use subagents / `~/.codewiki/` 中心制指引）。两二进制 strings 对比 139 行差异主要来源即此（其余为 chrono 0.4.44/0.4.45 panic 路径等编译杂音，无行为影响）。`cw setup claude-code` 写出的文本对应各自内嵌版本——插件不依赖该路径（dsh 插件始终用自己的 `skills/codewiki-session.md`）。
