# CodeWiki — @local/dsh-codewiki

> 本文件是插件自身的项目 wiki 入口：全套文章在仓库根 `.codewiki/`（索引 `_index.md`，模块与架构文章 `modules/`）。本文件被人工维护，编译流水线不会覆盖它。

## Overview

`@local/dsh-codewiki` 是 DeepSeek Harness（dsh）的插件：为代码仓库自动编译并维护全仓 wiki，产物落在目标仓库内的 `.codewiki/`（随仓库提交共享）。它把原本同步、长耗时的编译改造为「提交即返回、后台推进、可观测、可取消」的作业系统。

设计基座是两套上游，职责按「谁更擅长」切开，边界写在 `docs/fsoft-native-engine.md`（契约版本 3）：

| 归属 | 负责 |
| --- | --- |
| FSoft 原生引擎（Python，锁 commit `1b4af43d`，自报 codewiki 2.0.0） | 依赖图、模块树、artifact 采集、文章写作、组件级增量（updater rung 3）、update_record |
| mraza `cw`（Rust CLI，`vendor/codewiki`，`bin/cw.exe`） | `init` / `status` / `index` / `meta update` / `path`（以及暴露给模型的 `projects`/`setup`/`uninstall`） |
| DSH 插件（Node） | 宿主模型通道、JobService、排队/取消/恢复、侧边栏面板、自动提交、质量门与安全边界 |

**默认走原生通道**（`nativeEngine: true`）。`nativeEngine: false` 保留为最小兼容通道（顶层目录分组 + 文件级 `source_files` 归属），不再接收新能力。

## Key Components

- `index.js` — 插件宿主半侧（单文件，Node ESM）
  - `Config` — schemastery 设置，全部 `.volatile()` 热读。分组：运行（`enabled`/`binaryPath`/`maxConcurrency`/`serialProjects`/`parallelProjects`/`excludePaths`/`autoUpdate`）、编译模型（`batchProvider`/`batchModel`/`batchReasoningEffort`，**留空即提交失败**，插件不保存任何密钥）、大档（`big*`，**仅 Node 兼容通道生效**）、原生引擎（`nativeEngine`/`nativeEnginePython`/`nativeEngineEntry`/`nativeEngineTimeoutMs`/`moduleConcurrency`/`requestLimit`/`articleLanguage`）
  - `submit` — 唯一提交入口：排除清单闸门 → worktree 闸门 → `cw status` 判三态 → 选通道（`nativeChannelFor`）→ 落 job
  - `parseStatus` — 三态判定（`missing`/`uncompiled`/`clean`/`stale`）。`cw status` 只看已提交历史，因此基线落在产物提交之前时，`git diff 基线..HEAD` 恒把整批 `.codewiki/` 算成变更；`parseStatus` 用 `isWiki` 把 wiki 自身产物与源码变更分开算，只剩产物时判 `clean`
  - `ensureWikiEntry` — 仓库根缺少 `CodeWiki.md` 时按语言生成一份最小入口；已存在则永不覆盖
  - `reminderText` / `installUpdateReminder` — 会话系统提示注入维护提醒（仅当仓库根存在 `CodeWiki.md`）
  - `autoCommitWiki` — 编译终态由插件自己 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（`docs(wiki): …`）。安全边界：非 git / 无 HEAD / 合并或变基中 / 未解决冲突 / 产物被 ignore / 缺 `user.name` 一律拒绝并降级，绝不做半个提交
  - 旧 Node 通道（`tickCrosscut` 等）— 仅在 `nativeEngine: false` 时使用，原生通道绝不落进 `STAGE_HANDLER`
- `lib/engine/` — 原生通道的全部 Node 侧逻辑
  - `native-run.js` — 一次原生编译的编排：变化集四路（committed/staged/unstaged/untracked + 上轮未消费携带）→ 工作区快照 → 引擎子进程 → 质量门 → 语义校对 → 校验 → 落地器 → 基线 → 提交。阶段序列 `env → graph → cluster → articles → proofread → validate → index → baseline → commit`
  - `workspace-snapshot.js` — 用独立 `GIT_INDEX_FILE` 走 `read-tree → add -A → write-tree → commit-tree`，parent 指向 HEAD，**不写任何 ref**：它是一棵可寻址的树（产物照它写成），但本身不是历史提交
  - `quality-gate.js` — 五段检查（产物自洽 → 入口 → 逐篇渲染与契约 → 基线 → 终态合成）。硬不变量：`done` 无 blockers / `partial` 必须≥1 blockers / `failed` 必带 error；`baselineEligible = outcome === 'done'`（partial 一律不推进基线）
  - `apply-plan.js` — 原子落地：写集封闭在 `.codewiki/` 与根 `CodeWiki.md`，`claimPre` 快照 → 写盘 → `cw index` → `cw meta update`（基线）→ 自动提交；任一步失败整批回滚。另有孤儿页清理（`findOrphanPages` 判「`source_files` 全失效」，`findStaleModulePages` 判「页名已不在模块树」并兼容 0.16.0 之前 Node 通道的旧格式页）
  - `mapping.js` — 引擎产物 → wiki 文件的映射（overview→入口、模块页→`modules/<kebab>.md`、module_tree 只作证据不落盘）；`moduleSlug` 把所有非字母数字折成 `-`
  - `llm-bridge.js` / `openai-bridge.js` — 引擎的 OpenAI 请求经回环桥转回宿主 `llm.stream()`，使用占位 key；模型在桥启动时固定
  - `python/` — `entry.py`（JSON-lines 适配、阶段翻译、config 下发）、`stage_map.py`（FSoft 五段阶段 → 引擎九段，进度上限刻意压 90%）、`fsoft_runtime.py` / `full_parallel_runtime.py`（运行期替换上游串行循环，实现受控并行与断点续跑）、`tree_coverage.py`
- `client.js` — 浏览器半侧：插件设置卡片（`plugins.item`）+ 侧边栏面板（`main` / `sidebar.panellist`）。面板 2s 轮询、阶段步骤条、用量、活动流、取消
- `vendor/codewiki/` — mraza 上游源码（相对上游只有两处改动，见 `FORK.md`：`src/config.rs` 把 wiki 目录内化到仓库内、`src/main.rs` 统一路径分隔符）；`bin/cw.exe` 是 cargo release 产物（git 跟踪）
- `docs/fsoft-native-engine.md` — 冻结的引擎契约与上游升级流程
- `tools/fsoft-engine/` — venv 建设脚本、图 diff 对拍与无 LLM 探针

## Architecture

```text
模型/面板/自动调度 ──► codewiki_generate / POST /api/codewiki/control
                              │（纯提交，零 LLM 调用）
                              ▼
                       JobService.submit ──► {submitted, jobId, stage} 立即返回
                              │（宿主后台 tick）
                              ▼
  原生通道（默认）                              旧 Node 通道（nativeEngine:false）
  env：判定态 + 装载 Python venv/引擎            queued → articles → crosscut → review → index → commit
  graph：FSoft 依赖图（16+ 语言 analyzer）                    │
  cluster：模块树（含 artifact 节点）                          │
  articles：FSoft 写文章 ◄──回环桥──► 宿主 llm.stream()       │
  proofread：只对「有失效跨页链接」的页做语义校对              │
  validate：质量门（产物自洽 / 入口 / 契约 / 基线）            │
  index：落地器写盘 + cw index + 孤儿页清理                    │
  baseline：cw meta update（仅 done 且无存量坏页时）           │
  commit：git add -- .codewiki CodeWiki.md && commit docs(wiki)
                              │
                              ▼
                    .codewiki/{_index.md,_meta.yaml,modules/,learnings/}
```

一次原生编译的关键事实：

- **变化集不是只看提交**：`lib/change-set.js` 同时采集 committed / staged / unstaged / untracked 四路，再用工作区快照合成一个可寻址的树 SHA，作为「产物照着哪棵树写成」的证据（传给引擎当 `commit_id`，也传给质量门当 `consumedInputCommit`）。
- **脏工作区不是缺陷**：质量门的 `uncommitted-input` 只在「有未提交源码改动、但产物对不上任何快照」时才报。对得上快照时它被记成一条 notes（「本轮把 N 个未提交源码改动一并写进产物」）并放行，从而让终态可以到达 `done`、基线可以推进。这是 0.17.39 修掉的死锁：此前脏工作区使每一轮都落 `partial`、基线永不推进，`cw status` 恒 stale。
- **未消费的变化不会丢**：`_native-state/state.json` 的 `unconsumed` 跨轮携带，只有出现在下一轮 `committed` 里才算消化。
- **基线只在 `done` 时推进**：`partial`（引擎有失败叶子、状态不完整、门有 defect、存量坏页）一律否决。基线落在产物提交之前是结构性的（提交内容里要写着 `last_compiled_commit`），所以 `cw status` 对「只剩产物差异」的仓库判 `clean` 而不是 stale。
- **横切产物（`_architecture.md`/`_patterns.md`/`concepts/`）已下线**：它们由旧 Node 通道的 `tickCrosscut` 生成，原生通道从不写它们，2026-11-04 已整体删除。系统总览现在由引擎的 `overview` 页承担（每轮重写），模块级结构表达由模块页内的 mermaid 图承担。

## Data Flow

- **配置流**：profile patch `config:` → cordis 注入 `apply(ctx, config)` → `liveConfig` 每次调用解包（volatile 热生效）。
- **凭证流**：插件不保存也不传递任何密钥。引擎子进程只拿到占位 key 与回环地址，真实凭证由宿主按所选 provider 解析。`CODEWIKI_MAIN_MODEL` / `CODEWIKI_CLUSTER_MODEL` 只区分主/聚类两个角色，不能在请求级切档。
- **任务流**：`submit` 判态 → 落 job（`job-store`）→ tick 推进 → 原生通道 spawn Python 子进程（JSON-lines over stdio：`doctor`/`generate`/`update`/`cancel`）→ 落地 → 自动提交。job 状态持久化到 `os.tmpdir()`，多实例下按 owner 隔离。
- **面板流**：浏览器 2s 轮询 `GET /api/codewiki/jobs`（回环 only），取消走 `POST /api/codewiki/control`。
- **索引/基线流**：唯一写者是 `cw`。`_index.md` 由 `cw index` 生成，`last_compiled_commit` 只在 `done` 时由 `cw meta update` 推进。

## Connections

- [[codewiki-upstream]] — `vendor/codewiki`（MIT），基线 commit `64323823`。上游技能正文只存在于 `vendor/codewiki/skills/`，插件不注册技能；`cw` 工具暴露子命令白名单，`setup`/`uninstall` 的语义是给 Claude Code / Codex / qmd 装 hook，与 dsh 无关
- 宿主模型目录（`llm.listProviders` / `llm.listModels` / `llm.resolveModel`）— 设置页的 provider/model 级联与思考档位都从这里读，单 provider 失败不拖累整份目录
- FSoft 上游（`.probe-fsoft/src`，冻结快照）— `entry.py` 通过 editable 安装调用；并行能力在运行期注入，不再打 patch（`patches/upstream-module-parallel.patch` 已是历史归档）

## Known Issues

- **插件与客户端都不热加载**：改 `index.js` 或 profile patch 后需重启 dsh；`client.js` 的 `dsh.client` 声明变了也要重启才会送进浏览器。只有 `config` 的值是热读的。
- **上游升级要按 `docs/fsoft-native-engine.md` 的六步走**：四处最容易悄悄改掉的位置（`config.py` 的 exclude/artifact 开关、`doc_generator.py` 的 config 读取、`repo_analyzer.py` 的排除、`doc_generator.py` 的 `_last_update_record` 字段）都要复核，否则增量判定会静默失效。
- **增量档位不可配**：`DEFAULT_UPDATE_OPTIONS` 恒为 `rung: '3'`，上游 `UpdateOptions` 的阈值（`tau_ren`/`tau_nb`/`tau_grow`/`k_hop`/`tau_full`/`tau_tree`/`use_routing_agent`/`use_stale_scan` 等）没有暴露到设置页。rung 3 单模块内的方法级新增不触发重写，属上游行为。
- **`bigEnabled` 一系只服务 Node 兼容通道**：原生通道的输入预算由 FSoft 引擎按模块切分，不经插件的大档。设置页已按此标注。
- **artifact 页从未真正命中**：artifact 分析与依赖图节点是通的（本仓实测 3 个 artifact 节点、`artifact_index.json` 3083 tokens），但文件太少，`ensure_artifact_module` 的占比阈值未触发建独立模块，因此 `pageKind: 'artifact'` 这条映射分支在本仓库没有实证样本。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `vendor/schemastery`）；换机器需重建。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`）。
- `cw meta update` 只写当前 HEAD，不接受指定 sha；因此基线永远指向「上一次 done 的那轮的 HEAD」，不可能指向当轮提交。
