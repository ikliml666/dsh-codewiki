---
title: Execution_Runtime___Vendored_Engine 概览
description: 本模块是插件在编译执行期真正“动手”的那一层：一半是运行在独立子进程里的 Python 引擎适配层，另一半是随包分发的 Rust cw 命令行工具。它不实现任何文档理解算法——依赖图、模块聚类、文章写作与增量 diff 全部交给 vendored 的上游 FSoft 引擎；cw 只负责“文件系统 + git +…
---

# Execution_Runtime___Vendored_Engine 概览

!!! info "Generated documentation"
    This page was written by CodeWiki from the source code at commit [`65890014`](https://github.com/ikliml666/dsh-codewiki/commit/6589001428bc8eb6662303a05b6be49bacbd4061) on 2026-11-09 with `deepseek-v4.1-flash`. Check the code before relying on details.

本模块是插件在**编译执行期**真正“动手”的那一层：一半是运行在独立子进程里的 Python 引擎适配层，另一半是随包分发的 Rust `cw` 命令行工具。它不实现任何文档理解算法——依赖图、模块聚类、文章写作与增量 diff 全部交给 vendored 的上游 FSoft 引擎；`cw` 只负责“文件系统 + git + YAML”这一层确定性操作。本模块的职责是让这两者**安全、可观测、可裁决地**接入宿主 Node 侧：把一次编译变成可翻译的协议流，把产物变成可索引、可记账的库。

## 模块组成

| 子模块 | 语言 / 形态 | 职责 |
| --- | --- | --- |
| [engine-python-runtime：FSoft 原生引擎的 Python 侧运行时](Execution_Runtime___Vendored_Engine/engine-python-runtime.md) | Python 子进程（`lib/engine/python/`，5 个文件约 2 000 行） | 协议入口与 JSON-lines 进度桥、阶段映射、全量受控并行、增量叶子隔离并行与断点、未归属文件补挂 |
| [codewiki-vendor（仓库内 vendored `cw` CLI）](Execution_Runtime___Vendored_Engine/codewiki-vendor.md) | Rust crate（`[[bin]] name = "cw"`） | `.codewiki/` 初始化、`_index.md` 重建、`_meta.yaml` 基线推进、变更/stale 状态查询 |

两者的分工是硬边界而非实现偏好：**文章内容由 Python 侧写，索引与基线只能由 `cw` 写**。`.codewiki/_index.md` 只能由 `cw index` 生成，`last_compiled_commit` 只能由 `cw meta update` 推进。

## 架构

```mermaid
flowchart TB
    subgraph Host["宿主插件（Node 侧）"]
        NR["native-run.js / 裁决链"]
        CL["client.js<br/>子进程 + JSON-lines 协议"]
        AP["apply-plan.js<br/>落地器"]
        IDX["index.js<br/>cw 工具封装 / parseStatus"]
    end

    subgraph Target["Execution_Runtime___Vendored_Engine"]
        subgraph Py["engine-python-runtime（Python 子进程）"]
            EN["entry.py<br/>协议入口 / stdout 守卫"]
            SM["stage_map.py<br/>五段 → 九段"]
            FP["full_parallel_runtime.py<br/>全量受控并行"]
            FR["fsoft_runtime.py<br/>增量并行 + 断点"]
            TC["tree_coverage.py<br/>叶子归属补齐"]
        end
        subgraph Vendor["codewiki-vendor（Rust crate，bin = cw）"]
            CW["cw init / status / index<br/>meta update / path / projects"]
        end
        FS["FSoft 上游 Python 引擎（vendored，锁 commit）"]
    end

    NR --> CL
    CL -->|"stdin 一行 JSON"| EN
    EN -->|"stdout JSON-lines<br/>hello / progress / result"| CL
    EN --> SM
    EN --> FP
    EN --> FR
    FR --> TC
    FP -->|"替换 _generate_modules_in_order"| FS
    FR -->|"替换 IncrementalUpdater Step 5"| FS
    EN -->|"替换 ProgressTracker 方法"| FS
    AP -->|"init / index / meta update"| CW
    IDX -->|"status + 8 个子命令白名单"| CW
    AP --> DISK[".codewiki/ 与 CodeWiki.md"]
    CW --> DISK
```

四个设计取向决定了整个模块的形状：

1. **入口极薄**：算法留在上游，Python 侧只做协议、观测与契约翻译，避免长出“第二个编译器”。
2. **旁路观察、不打补丁**：进度与模块名靠替换方法 / 挂只读 handler 获得；上游升版时靠**源码锚点校验**显式失败，而不是静默降级成另一套语义。
3. **边界自洽**：UTF-8 三条流、`sys.stdout` 守卫、子进程 text 模式补丁全部在 `import codewiki` **之前**装好，因为上游会缓存 stdout 包装器。
4. **失败必须显式**：已写文章尽量降 `partial` 交付，但绝不把空产物伪装成“部分完成”；`cw index` 失败等于库坏了，整批回滚。

## 一次编译中两个写者的顺序

```mermaid
flowchart LR
    A["Python 侧生成文章到临时 docsDir"] --> B["落地器 applyNativeOutput"]
    B --> C{"_meta.yaml 存在?"}
    C -- 否 --> D["cw init 建库"]
    C -- 是 --> E["原子写入文章 / 入口 / 受管状态"]
    D --> E
    E --> F["cw index 重建 _index.md"]
    F --> G{"写集全部出现在索引里?"}
    G -- 否 --> H["回滚全部写入"]
    G -- 是 --> I["cw meta update 推进基线（仅 outcome=done）"]
    I --> J["自动提交 .codewiki 与 CodeWiki.md"]
```

这条链路解释了两处容易被忽略的契约：`cw` 的**退出码只表达文件操作成没成**（内容裁决在质量门），而**退出码 0 也不等于语义达成**（索引必须真的收录本轮写集，因此落地器自己比对写集与 `[[...]]` 链接）。同时 `cw meta update` 只写当前 HEAD，所以基线结构性落后于当轮产物提交——这也是 `parseStatus` 必须把 `.codewiki/` 自身产物从变更清单里摘出去的原因。

## 核心组件文档

| 关注点 | 页面 |
| --- | --- |
| Python 侧协议入口、进度桥、心跳、异常分类、并行与断点 | [engine-python-runtime：FSoft 原生引擎的 Python 侧运行时](Execution_Runtime___Vendored_Engine/engine-python-runtime.md) |
| `cw` 子命令面、`WikiMeta` / frontmatter、stdout 文本协议、fork 点与构建分发 | [codewiki-vendor（仓库内 vendored `cw` CLI）](Execution_Runtime___Vendored_Engine/codewiki-vendor.md) |
| Node 侧协议适配与超时 / 静默 / 取消裁决 | [engine-runner：原生引擎执行与裁决编排](Documentation_Generation_Engine/engine-core/engine-orchestration/engine-runner.md) |
| `EngineResult` 字段与不变量、质量门与文章契约 | [engine-contract-quality：引擎契约与质量裁决层](Documentation_Generation_Engine/engine-core/engine-contract-quality.md) |
| 环境指纹、引擎锁、状态水合与 `_native-state/` | [engine-state-manifest：引擎清单与跨轮受管状态](Documentation_Generation_Engine/engine-core/engine-state-manifest.md) |
| loopback 模型桥与占位 key（`CODEWIKI_*` 环境变量来源） | [引擎外部集成层（模型桥与 TechDocs 回读）](Documentation_Generation_Engine/engine-core/engine-integrations.md) |
| 落地器（唯一调用 `cw init` / `index` / `meta update` 的地方） | [apply-plan 落地器](Documentation_Generation_Engine/engine-core/engine-orchestration/apply-plan.md) |
| venv 构建与打包配置 | [FSoft 引擎工具链（fsoft-engine-tools）](Build___Development_Infrastructure/fsoft-engine-tools.md)、[构建与配置（build-configuration）](Build___Development_Infrastructure/build-configuration.md) |
| 任务判态、排队与 `cw` 工具封装 | [作业编排与状态管理（Job Orchestration & State Management）](Job_Orchestration___State_Management.md) |

## 跨子模块的运行约束

- **环境由外部提供**：Python 侧不自管 venv，解释器路径由设置项 `nativeEnginePython` 决定（不做“找一个能用的解释器”的启发式）；`doctor` 动作跑 `pip check` 并如实上报，与 `engine-lock.json` 指纹比对不通过时直接 failed，不跑引擎。
- **协议流不可污染**：`sys.stdout` 在导入上游前被替换为只放行协议写出的守卫，所有协议行经统一 `emit()` 加锁整行写出；观测代码（探针 handler、心跳）的任何异常都必须被吞掉。
- **阶段口径唯一**：`stage_map.py` 的九段枚举必须与 `contract.js` 的 `ENGINE_STAGES` 完全一致，进度上限刻意压在 90%，剩余 10% 留给 Node 侧 `index` / `baseline` / `commit`。
- **`_` 前缀是三方隐式契约**：`cw index` 跳过 `.codewiki/` 下首段以 `_` 开头的整棵子树，受管状态（`_native-state`）与站点（`_techdocs`）因此不进索引；改这条规则等于同时改三处。
- **vendor 目录不可被上游覆盖**：`codewiki-vendor` 相对上游只有两处 fork（wiki 内化到仓库内、相对路径统一 `/`），覆盖会退回中心制并让 `cw index` 报 `No wiki found`。

??? abstract "Documented components (29)"
    - [`_ProtocolOnly`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Centry.py) — `lib\engine\python\entry.py`
    - [`_popen_init_utf8`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Centry.py) — `lib\engine\python\entry.py`
    - [`main`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Centry.py) — `lib\engine\python\entry.py`
    - [`run_leaf_agents`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfsoft_runtime.py) — `lib\engine\python\fsoft_runtime.py`
    - [`_SharedTreeIO`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`articles_ceiling`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cstage_map.py) — `lib\engine\python\stage_map.py`
    - [`file_owner`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Ctree_coverage.py) — `lib\engine\python\tree_coverage.py`
    - [`project_name`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Cconfig.rs) — `vendor\codewiki\src\config.rs`
    - [`ArticleFrontmatter`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Cfrontmatter.rs) — `vendor\codewiki\src\frontmatter.rs`
    - [`Cli`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Cmain.rs) — `vendor\codewiki\src\main.rs`
    - [`capitalize`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Cmain.rs) — `vendor\codewiki\src\main.rs`
    - [`main`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Cmain.rs) — `vendor\codewiki\src\main.rs`
    - [`WikiMeta`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Cmeta.rs) — `vendor\codewiki\src\meta.rs`
    - [`claude_home`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/vendor%5Ccodewiki%5Csrc%5Csetup.rs) — `vendor\codewiki\src\setup.rs`
    - [`configure_full_runtime`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`current_concurrency`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`_merge_tree`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`write_tree_exclusive`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`_node_at`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`_run_module`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`_walk`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`_run_parallel`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`_install_shared_tree_io`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`install_full_runtime`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cfull_parallel_runtime.py) — `lib\engine\python\full_parallel_runtime.py`
    - [`is_incremental`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cstage_map.py) — `lib\engine\python\stage_map.py`
    - [`articles_percent`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cstage_map.py) — `lib\engine\python\stage_map.py`
    - [`map_stage`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cstage_map.py) — `lib\engine\python\stage_map.py`
    - [`percent_of`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cstage_map.py) — `lib\engine\python\stage_map.py`
    - [`ChannelBreaker`](https://github.com/ikliml666/dsh-codewiki/blob/6589001428bc8eb6662303a05b6be49bacbd4061/lib%5Cengine%5Cpython%5Cchannel_breaker.py) — `lib\engine\python\channel_breaker.py`

