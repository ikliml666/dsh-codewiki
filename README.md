# dsh-codewiki

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-topic-blue)](https://github.com/topics/dsh-plugin)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的仓库级代码 wiki。** 它把一个仓库编译成 `<repo>/.codewiki/` 下一组互相链接的 Markdown 文章（模块、架构、关键流程），随代码一起提交、和团队共享；侧边栏面板里能看任务进度、翻引擎日志、改编译模型与并发。

它不是一个跑一次就完的文档生成器，而是一个可以反复跑的编译器：下一轮只重写接口真变了的模块，编译基线只有整轮干净成功才前移。

## English summary

A repository-level code-wiki compiler for DeepSeek Harness. It turns a repository into cross-linked Markdown articles under `<repo>/.codewiki/`, committed alongside the code, with a sidebar panel for job progress, engine logs and per-stage model settings. Incremental by design: only modules whose interfaces actually changed get rewritten, the baseline advances only on a fully clean run, and every page must pass an article contract gate before it reaches disk. MIT licensed.

## 它做什么

- **持久化、可增量的 wiki**：产物落在仓库里、跟着代码走，不是每次重新生成一份快照。基线（`.codewiki/_meta.yaml` 的 `last_compiled_commit`）记录「哪些变化已经消化」，下一轮只处理增量；没消化完的轮次不会把变化记成已消化。
- **终态诚实**：`done` / `partial` / `failed` / `cancelled` 四态。`partial` 会在面板与 `codewiki_progress` 上逐条写明是哪一项没满足，不拿「生成了文件」冒充成功。只有 `done` 推进基线。
- **坏文章不入库**：所有写盘产物先过文章契约闸门——frontmatter 完整性、必填字段、`source_files` 是否指向仓库里真实存在的文件、章节重复、死链。不合格的页不落盘、不推进基线。
- **自愈**：库里已有的坏文章会在每轮落地时被扫出来并尝试修复；修不掉的会阻塞基线推进（避免「假装干净」），但不会回滚本轮已写好的产物。

## 提供的工具

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 提交制编译：判态 → 提交后台任务立即返回 → 常驻服务按「准备 → 文章 → 校验 → 索引 → 提交」推进。全部模型环节在插件内完成，不派子代理、不占用发起会话的主模型 |
| `codewiki_update` | 工具 | 日常维护入口：固定 `scope=auto`，调用即返回，不需要等待或轮询 |
| `codewiki_progress` | 工具 | 只读查进度：stage / 百分比 / 已写 / 失败篇数 / 失败原因，立即返回。可按 `cwd` 或 `jobId` 过滤，都不传则列全部任务。另带 `baselineEligible`（质量门是否许可推进基线）与 `baselineAdvanced`（本轮基线事实上是否已前移） |
| CodeWiki 设置页 | 插件页 UI | 插件管理页里出现 CodeWiki 条目（id `codewiki`），可改编译模型（provider/model 级联下拉，目录来自已注册的模型提供商）与运行选项 |

`codewiki_generate` 的关键行为：

- `scope=auto`（默认）：没有 wiki / 未编译 → 全量；有变更 → 只更新过期文章；已最新 → 直接报告。
- `scope=full`：跳过 clean 短路，强制全量重编。
- 单篇文章失败只记账不中断；只要有任何必需文章没写成、有未映射变更、或质量闸门拦下文章，终态就是 `partial`。
- 请求并发分两档独立限流，两池同时推进；`serialProjects` 开启时同一时刻只推进一个仓库，其余进 `queued` 排队。
- 编译产物由插件自动提交（`autoCommit`）。编译终态（成功/部分/失败）都不会主动发消息唤醒会话：进度与失败原因在面板和 `codewiki_progress` 里看；只有自动提交失败时，系统提示里会出现一条一次性「产物待提交」提醒。

## 编译流水线

默认通道直接把上游 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 的 Python 引擎当子进程驱动，由它做依赖图 / 模块树 / 增量裁决 / 文章写作。插件这一侧只负责五件事：

| 环节 | 本插件负责 | 上游负责 |
|------|-----------|---------|
| 环境 | `doctor` 探针：python 版本 + `codewiki` 可导入 + `pip check` 闭合；指纹（含上游锁 commit）落 `.codewiki/engine-lock.json`，drift 直接 `engine-deps` 失败（**不自动 pip install**） | 版本自报 |
| 源码面 | 排除清单交给上游 `RepoAnalyzer`：wiki 产物（`.codewiki` / `CodeWiki.md`）+ 孤立 gitlink（提交进索引却没有 `.gitmodules` 登记的嵌套仓库，永远 checkout 不出内容）。正规 submodule 不排除 | 按 `agent_instructions.exclude_patterns` 建依赖树 |
| 模型 | 在 `127.0.0.1` 起一个 OpenAI 兼容端点，把宿主的 llm 服务转成上游要的 `/v1/chat/completions`；上游只拿到 loopback URL 与占位 key，插件不保存任何 API Key | 用它自己的 prompt 与工具循环调模型 |
| 质量 | 逐篇体检（`source_files` 存在性、空证据、死链、frontmatter、重复章节）+ 基线判定；终态四态 | 产出 docs 目录（`module_tree.json` / `metadata.json` / `*.md` / `update_record.json`） |
| 落地 | 写集封闭（只 `.codewiki/` 与根 `CodeWiki.md`）、pre-image 回滚、`cw index`、`cw meta update`、分支式自动提交、提交范围反查 | 不碰仓库 |

### 运行要求

1. **Python 3.10+ 独立 venv**，且 `python -m pip check` 必须零破损。上游依赖集（`openai` / `pydantic-ai-slim` / `pydantic`）正常解析必然 `ResolutionImpossible`，只能用锁定的 constraints 装——见 `tools/fsoft-engine/setup-env.sh` 与同目录的 `constraints.txt`（故意 `--no-deps -c`）。
2. `nativeEnginePython` 指向那个 venv 的解释器（**绝对路径**；留空则读环境变量 `DSH_CODEWIKI_PYTHON`，再退到 `python`）。插件不做「找一个能用的解释器」的启发式——猜错会把「环境不闭合」伪装成「引擎坏了」。
3. Windows 上非 ASCII 仓库路径必须能正确进出子进程（入口 stdin 钉 UTF-8，上游内部 `text=True` 的子进程也补了 UTF-8 兜底）。

## 质量保证

### 变更采集：不只看提交

过期判定不只跑 `git diff <last_compiled_commit>..HEAD`——那样改完源码没 commit 就编译，wiki 会报「最新」并把这些改动永久漏掉。`lib/change-set.js` 一次采集四路：已提交、已暂存、未暂存、未跟踪，并识别删除与改名。规范化成仓库相对 POSIX 路径，`.codewiki/` 自身产物不计入源码变更（但 `README.md` / `CHANGELOG.md` / `CodeWiki.md` 这些被文章引用的文档仍是合法 source）。

取不到基线（非 git 仓库、基线 commit 不可达、git 出错）时明确退回全量并记原因，不会假装「干净」。

### 增量判定

原生通道的符号级 / 依赖级增量由上游 `updater/graph_diff.py` 完成：组件级 hash + 签名比对，区分 interface / added / deleted / renamed / body / edge，另有 ownership 与 stale scan。

### 终态与基线

`done` 只表示完整成功。以下任一情况终态为 `partial`（附 `blockers` 逐条原因）：计划内必需的文章缺失或写作失败、有变更没被任何文章解释、文章质量闸门拦下文章、存量文章体检发现坏文章。

`partial` 一律不推进基线：写成的文章照常入库（下次不必重写），但「这一批变化已消化」这个事实不成立，下一轮从同一批变化继续。

每次编译写 `.codewiki/temp/update-record.json`：基线 / HEAD、每篇 action + 原因、变更统计、未映射变更、质量问题、最终结果。job 只存摘要与该记录路径，不把整张图塞进 jobs 文件。

### 文章契约闸门

`lib/article-contract.js` 的 `inspectArticle()` 是纯函数，接在所有写盘点上：

- frontmatter 必须唯一且闭合，`title` / `type` / `source_files` / `tags` 齐全，`type` 与所在目录一致；
- 正文不能再次出现 frontmatter，代码围栏必须闭合，不允许重复章节；
- 必需章节不能是空标题；
- `source_files` 必须是仓库内真实存在、且来自本次实际读取证据的文件；
- 内部 wiki 链接必须指向存在的文章。

`error` 级问题一律不落盘（记 note 并计入终态阻塞）；`warning` 级（缺非必需章节）放行但记账。

### 存量坏文章自愈

库里躺着的坏页不靠下一轮重写来发现——每轮落地前会扫全库契约，能就地修的修（补 frontmatter 闭合、补必填字段、去重章节、剔除指向已删文件的 `source_files`），明确是模型输出泄漏的才删除。修不掉的仍然阻塞基线推进，但不回滚本轮已写好的文章。

## 进度与日志

面板的任务卡把引擎阶段画成分段进度条，只画已执行的阶段，未执行的留成底色，不预先铺满颜色。写文章阶段按「已写篇数 / 本轮起始篇数」插值；「准备中」展开成 `env` / `graph` / `cluster` 三段，其中解析代码图按已解析文件数推进，而不是整段停在 0%。

引擎事件逐条追加到**仓库外**的 NDJSON（默认 `%TEMP%/dsh-codewiki-logs/<jobId>.ndjson`，可用 `DSH_CODEWIKI_LOG_DIR` 改目录、`DSH_CODEWIKI_LOG_MAX_BYTES` 改单文件上限，默认 2MB，超限保留后半段现场）。进度帧按「阶段|百分比|篇数」去重后入档，避免把桥请求失败、stderr、阶段切换这些真正有用的事件挤出去。查看方式三选一：面板任务卡里可展开的「引擎日志」块、`GET /api/codewiki/logs?jobId=&limit=`（默认 200 条，带字节数与错误行计数）、或直接翻那个文件。日志写不进去不会静默：`job.logError` 会说明，并在 notes 里提示后续只在内存里保留最近 40 条。

超时是两条独立判据：`nativeEngineTimeoutMs` 兜「跑太久」（超时杀进程树，已写出的文章按 `partial` 抢救，不会白跑）；环境变量 `DSH_CODEWIKI_ENGINE_SILENCE_MS` 兜「已经卡死」（多久没收到任何协议帧就判卡死）。另有一条宽限：引擎发完 `result` 后若卡着不退，2 秒后按已到的 `result` 收尾。

## 自动更新

`autoUpdate` 开启后服务每 60s 心跳一次，距上次扫描超过 `autoUpdateMin` 时逐仓 `scope=auto` 判态提交（被排除目录、worktree、空壳目录、不在已添加工作区清单里的仓库静默跳过），单仓失败只记 `lastError` 不中断。

提交前会先判一次空转：变更采集成功、受管状态齐备、`state.json` 的 `headCommit` 等于当前 cw 基线、且合并后的有效变更集为空时，本轮直接跳过不建任务（判据是乐观的——任何一项判不准就照常提交）。这样「仓库没有源码变化」不会起一轮跑三分钟的分析。

仓库清单与任务历史都落在临时目录，名字跟随 `JOBS_FILE`（`DSH_CODEWIKI_JOBS_FILE` / `DSH_CODEWIKI_REPOS_FILE` 可覆盖），测试与多实例互不污染。

## 安装

从 GitHub 装：

```sh
dsh plugin --profile <你的 profile> add github:ikliml666/dsh-codewiki
```

装完把 `@ikliml666/dsh-codewiki` 加进该 profile 的 `dsh.profile.bundles`，**重启 dsh**（bundle 层与 client 半边都只在进程启动时装载）。下面两种是本地源码形态的装法。

### 装法 A：bundle 依赖

插件行由插件自带的 `cordis.patch.yml` 自动合并进 profile，不需要在 profile 的 `cordis.patch.yml` 里再手写 codewiki 条目：

1. 在目标 profile（如 `%USERPROFILE%\.dsh\profiles\desktop`）的 `package.json` 里登记两处：

   ```jsonc
   {
     "dependencies": {
       "dsh-codewiki": "github:ikliml666/dsh-codewiki"
     },
     "dsh": {
       "profile": {
         "bundles": ["…", "@ikliml666/dsh-codewiki"]
       }
     }
   }
   ```

2. 在该 profile 目录跑一次 `pnpm install`。
3. 要改配置，在本 profile 的 `cordis.patch.yml` 里写**同 id 覆盖条目**（不是 insert）:

   ```yaml
   - id: codewiki
     config:
       batchModel: glm-5.3-flash
       maxConcurrency: 3
   ```

   覆盖条目的 `config` 是**整对象替换**：没写的键回落到插件 `Config` 默认值，不会与 bundle 层里的 `config: {}` 深合并。

`cordis.patch.yml` 里那条 insert 写的是裸包名 `"@ikliml666/dsh-codewiki"`。**name 必须是裸 npm 包名（不带 `/dsh` 子路径）**：client 半边的激活扫描只认裸包名行。

### 装法 B：`file:///` 直挂

不装依赖、不碰 profile 的 `package.json`，直接在 profile 的 `cordis.patch.yml` 顶层追加：

```yaml
- insert:
    - id: codewiki
      name: file:///E:/path/to/dsh-codewiki/index.js
      config: {}
```

URL 里的空格写 `%20`。这条直挂条目由用户自己维护，插件自带的 bundle 层在装法 B 下不要同时启用（`bundles` 里不要有本包），否则同 id 会出现两条 insert。两种装法保持 id 一致：`codewiki`。

### 依赖解析

运行时 import 只有三个 `@deepseek-ai` 包：`schemastery`（Config）、`dsh-llm`（模型桥）、`dsh-client-ui-primitives`（客户端半侧）。工具、子代理、`systemPrompt`、`webServer`、`agents`、`llm` 全部走注入服务，不 import 宿主实现包。

`engines`：`node >=24.9.0`、`dsh >=0.2.0-rc.0`。`engines.dsh` 刻意不写上界——写死上界会让插件在新宿主的 bundle 层被整条跳过。

客户端半侧由包声明驱动：`package.json` 里 `dsh.client.platform: "web"` + `exports["./client"]`，宿主扫描到后自动把 `client.js` 送进浏览器（同样需要一次重启）。

## 设置

全部设置在**插件页 → CodeWiki 详情页**里可改，保存走 `configForms.mutate`，与 patch 文件里手改等价、同样热生效。所有设置都是 `volatile`，改完即生效，无需重启。

**模型**

- `batchProvider` / `batchModel`：编译模型（规划 / 写文章 / 横切 / 审校全部环节共用），默认 `volces-ark` / `glm-5.3-flash`（512k 上下文）。`batchProvider` 必须指向模型设置里已注册的提供商，留空直接提交失败；插件不保存任何 API Key。
- `batchReasoningEffort`：该模型的思考程度档位 id。可选值从模型目录实时读取，留空 = 用该模型的默认档。
- `effortByStage`：按环节单独指定档位——`graph`（依赖图 / 模块聚类）、`articles`（文章写作）、`proofread`（语义校对）、`validate`（质量门）。留空的环节用 `batchReasoningEffort` 兜底。
- `requestLimit`：单个模块写作允许的 LLM 请求次数，默认 100。上游写作校验会给没写出页面的模块续发补写提醒，每次提醒都是一次独立调用、各吃一份预算；撞上限的模块以 `article-failed` 上报而不是被静默截断。

**通道与并发**

- `nativeEngine`：编译开关，默认 `true`。关闭后不编译。
- `nativeEnginePython` / `nativeEngineEntry` / `nativeEngineTimeoutMs`：venv 解释器绝对路径 / 入口脚本（一般不用改）/ 单次引擎调用上限（默认 180 分钟）。
- `maxConcurrency`：请求并发上限，默认 2（1–8，硬顶 8）。
- `serialProjects`：单项目串行，默认开。开启后同一时刻只推进一个仓库，其余进 `queued`。
- `binaryPath`：cw 可执行路径；留空优先用 PATH 里的 `cw`，找不到再用插件自带 `bin/cw.exe`。

**产物与提醒**

- `articleLanguage`：文章语言，默认中文。两条通道都生效。
- `autoCommit`：编译产物自动提交，默认开。终态 `done` 且有文章写成功时由插件自己 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（信息前缀 `docs(wiki):`）。安全边界：pathspec 限定这两个路径（不 `-A` / `--all` / `.`）、不 amend / push / 改写历史、不跑仓库钩子；非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中、目标路径有未解决冲突、被 `.gitignore` 忽略、缺 `user.name` / `user.email`、git 命令失败等情形一律拒绝并降级为一次性「产物待提交」提醒，不会半个提交、不会静默丢产物。
- `autoUpdate` / `autoUpdateMin`：自动更新，默认关；开启后按间隔逐仓判态提交，默认 30 分钟（最小 5）。
- `techdocs`：额外导出 Backstage TechDocs 站点，默认关。开启后每轮编译结束时以引擎产物为输入
  生成 `mkdocs.yml` + `docs/`，落到 `.codewiki/_techdocs/`（以 `_` 开头，与 `_native-state/`
  一样不进 `cw` 索引、不算源码变化），随本轮文章一起提交。纯文件转换、不调模型，所以不增加
  token 成本，代价是每轮多约 37 个文件。站点里没有图片：落地器的写集通道只接受文本。
- `updateReminder`：会话系统提示注入 wiki 维护提醒，默认开。仅当会话仓库根存在 `CodeWiki.md` 时出现；提醒收尾调用 `codewiki_generate`、不要手改 `.codewiki/` 下的文章、调用即返回不要轮询、产物由插件自动提交。另兼职**降级**提醒：最近一次成功编译的完成时间晚于产物的最后一次 git 提交时，注入一次「产物待提交」，插件提交后自动静默。

## 已知限制

- `doctor` 的 `engine.deps.ok` 在真机上恒为 `false`（该字段不带 `pip check` 明细，指纹也刻意不含它）；判定以 `engineLock.status === 'match'` 为准。
- 上游 rung3 增量语义：**单模块内的方法级新增**通常不触发重写（component id 不在 tracked 集 → `untracked` → 不进 ownership）。要验增量真的改了文章，得用结构性变化（新增 / 删除 / 重命名文件或模块）。
- `.codewiki/modules/` 的孤儿页清理只在**本轮真的落地**时执行；无变化轮不扫不删。

## 来源与许可

本项目站在两个上游项目之上，二者均为 MIT：

| 上游 | 在本项目里的形态 | 许可 |
|------|-----------------|------|
| [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) | 原生通道（默认）直接把它当子进程驱动，依赖图 / 模块树 / 增量裁决 / 文章写作由它的 Python 引擎完成。本仓库不分发它的源码，用户按 `tools/fsoft-engine/setup-env.sh` 自行准备 venv。 | MIT，Copyright (c) 2025 FSoft-AI4Code |
| [mraza007/codewiki](https://github.com/mraza007/codewiki) | Rust CLI `cw`，以源码形式 vendored 在 `vendor/codewiki/`（已去除 `.git`），并附带编译好的 `bin/cw.exe` 兜底。`vendor/codewiki/FORK.md` 记录了对上游的改动与同步方式。 | MIT，Copyright (c) 2026 Muhammad Raza |

本插件自身的代码同样以 MIT 发布，见 [LICENSE](./LICENSE)。

> **关于 vendored 的 `bin/cw.exe`**：这是从 `vendor/codewiki/` 源码编译出来的产物，随包携带以免用户在 Windows 上还得装 Rust 工具链。它不含任何第三方专有代码。

## 链接

- 官方 Harness 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 插件发现：GitHub 的 [`dsh-plugin` topic](https://github.com/topics/dsh-plugin)
- 问题与建议：<https://github.com/ikliml666/dsh-codewiki/issues>

## 开发

```
vendor/codewiki/   上游源码（去除 .git）
bin/cw.exe         cargo build --release 产物（git 内跟踪，改了 vendor 记得重编）
client.js          插件页设置卡片（浏览器半侧）
lib/engine/        原生引擎适配层
```

改完跑 `node --check index.js client.js`，设置页需重启 dsh 后在插件页实测。行为变更与验收记录写在 [CHANGELOG.md](./CHANGELOG.md)。
