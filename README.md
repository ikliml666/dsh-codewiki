# @local/dsh-codewiki

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：仓库内代码 wiki（`<repo>/.codewiki/`，随仓库提交共享）+ 智能体编排编译，支持为编译子代理指定模型。

**0.13.0 起吸入了 [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（MIT，ACL 2026）的三层能力**：AST 符号提取 + LLM 语义聚类（`planMode=auto`）、agentic 工具循环写作（`agenticArticles`）、符号级增量判定（`symbolIncremental`）。全部用 Node + tree-sitter WASM 在本插件内实现，不引入 Python 运行时，任一环节不可用都自动降级回旧行为。详见下文「编译流水线：吸收自 FSoft CodeWiki」。

## 提供

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 提交制编译：cw status 判态 → 提交后台 job 立即返回 → 宿主常驻服务按 规划 → 写文章 → 横切 → 审校 → 索引 推进（侧边栏 CodeWiki 面板可见；0.13.0 起规划阶段默认走 AST 符号聚类，写作默认走 agentic 工具循环），全部模型环节在插件内完成（默认 `workbuddy`/`hy3`，192k 上下文，单请求输入预算 110k；110k–420k 输入自动升大档单请求，0.10.8），零子代理，不委托发起会话的主模型（0.10.0）；只有单模块源码连 420k 大档都装不下时才走观察→合成或会话通道兜底 |
| `codewiki_update` | 工具 | 日常维护入口（0.7.0 起）：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「本步收尾、继续下一项」，不要等待、不要轮询；编译产物由插件自动提交入库（0.10.9，`autoCommit`），**成功时不再唤醒会话**，只有自动提交失败才发一条一次性「产物待提交」降级提醒 |
| `codewiki_progress` | 工具 | 只读查编译进度：提交后随时查 stage/百分比/已写/失败篇数/失败原因，立即返回不等待（数据与侧边栏面板同源）。可选按 `cwd` 或 `jobId` 过滤，都不传列全部任务 |
| CodeWiki 设置页 | 插件页 UI | 插件管理页 Official 组出现 CodeWiki 条目（id `codewiki`），点进详情页可改编译模型（provider/model 级联下拉，目录来自 modelCatalog）与运行选项；`view=summary` 一行简介，`view=page` 完整表单 + 保存条 |

`codewiki_generate` 关键行为：

- `scope=auto`（默认）：无 wiki / 未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告。
- 全部模型环节（写文章/横切/审校）在插件内跑，共用 `batchProvider`/`batchModel` 一个模型；不再委托发起会话的主模型。
- 单篇文章失败只记账不中断；全部失败则不刷新编译基线（`meta update` 不执行，可安全重试）。
- 请求并发分两档独立限流：默认档 `maxConcurrency` 默认 2（硬顶 8），大档 `bigConcurrency` 默认跟随默认档（`0`）；两池同时推进，总在飞为两者之和。
- `serialProjects` 默认开：同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued` 排队，前一个收尾后自动轮到。
- `scope=full`：跳过 clean 短路，即使 wiki 最新也强制全量重编。

## 编译流水线：吸收自 FSoft CodeWiki（0.13.0）

[mraza007/codewiki](https://github.com/mraza007/codewiki) 提供的是 Rust CLI 骨架（`status`/`init`/`index`/`meta update` + 文件级状态判定），**不含**「怎么划分模块」与「文章怎么写」这两件真正决定 wiki 质量的事。插件原先自己补的是最省事的两刀：模块清单按顶层目录分组（`localPlan`），每篇把源码整包内联进一个 prompt 写一次。[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（ACL 2026，MIT）在这两处都做了工程化实现，0.13.0 把它的三层能力移植进来（Python 原版留在 `vendor/` 之外，不引入运行时）：

| 层 | 上游做法 | 本插件实现 | 不可用时 |
|----|----------|-----------|----------|
| 符号提取 | `tree-sitter` 原生绑定，逐语言 analyzer 提取函数/类/方法 + 调用关系（约 800 行/语言） | `lib/symbols.js`：**表驱动** `LANG_RULES`，web-tree-sitter + WASM 语法，16 种语言（js/ts/py/rs/go/java/c/cpp/c#/rb/php/kotlin/scala/dart/bash/lua），产出 `Map<id, {name,kind,parameters,baseClasses,dependsOn,bodyHash,sourceCode}>` | 该语言退回正则级符号（见 `lib/symbols.js` 的 fallback 分支），不影响其它语言 |
| 模块划分 | `cluster_modules.py`：LLM 两阶段聚类 + 递归下钻 + super-group 合并 | `lib/cluster.js`：同样的两阶段（先按组件职责聚类，再对超大模块递归下钻）+ `heuristicCluster` 兜底（单顶层目录时自动下探到第二层） | 模型请求失败 → 直接退回 `localPlan` 顶层目录分组，并记 note |
| 写文章 | module agent 工具循环：模型自己 `read_code`/`list_files`/`edit_article`，多轮增量写作 | `lib/agentic.js`（纯逻辑循环）+ `lib/agentic-host.js`（接宿主 llm）+ `lib/articles-agentic.js`（接 job 生命周期）：工具 `read_code`/`list_files`/`edit_article`（insert/replace/str_replace/delete），单篇步数上限 `agenticMaxSteps` | 单篇失败只记账；失败率过半时自动退回单轮整包装填通道重跑 |
| 增量判定 | `updater/graph_diff.py`：组件级 hash + 签名比对，区分 interface/added/deleted/renamed/body/edge | `lib/graph-diff.js`（逐位移植，含 78 条与 Python 原版的黄金对拍）+ `lib/incremental.js`（快照存取、文件级→组件级折算、按 frontmatter `source_files` 过滤文章） | 无快照/版本不符/提取失败 → 退回文件级 mtime/hash 判定，并记 note |

三个开关（设置页「编译流程（吸收自 FSoft CodeWiki）」一节，也可在 `cordis.patch.yml`/profile patch 里改）：`planMode`（`auto`/`dirs`）、`agenticArticles`（+ `agenticMaxSteps`）、`symbolIncremental`。**默认全开**；想要 0.12.x 的旧行为，把三者分别设成 `dirs`/`false`/`false`。

AST 能力依赖 `vendor/tree-sitter/`（`web-tree-sitter` + `tree-sitter-wasms`，56MB，独立于插件根 `node_modules`——后者是宿主注入的，在那装包会顶掉宿主依赖）。`vendor/tree-sitter/node_modules/` 按 `.gitignore` 的 `node_modules/` 规则不入库，新机器上按需 `cd vendor/tree-sitter && npm i`；没装时插件照常启动，只是没有 AST 能力、三层全部降级。

## 设置（插件行 config，命名空间 `codewiki`）

上述设置同样可在 **插件页 → CodeWiki 详情页**（`client.js`，v0.2.0 起）里修改：保存走 `configForms.mutate`（单层 op），与 patch 文件里手改等价、同样热生效。0.9.1 起「编译模型」是 provider/model 两级下拉：目录来自插件自己的 `/api/codewiki/models`（同源宿主 `llm.listProviders` + 各 provider 的 `listModels`，即模型设置页里已注册的提供商），不读插件配置；目录不可用时退化为文本输入，仍可填任意 provider/model。0.10.0 起「思考程度」也改为从模型目录读取——选中 provider/model 后拉 `/api/codewiki/model-efforts`（宿主 `resolveModel().reasoning.efforts`）渲染下拉，不再手填裸字符串。


- `batchProvider` / `batchModel`（0.10.0，0.10.1 起为唯一通道）：编译模型（规划/写文章/横切/审校全部环节共用），默认 `workbuddy` / `hy3`（免费、192k 上下文），走宿主 llm 服务。`batchModel` 填该 provider 的模型 id——本地 OpenAI 兼容端点（如本地 9B）只要在模型设置里注册过，就能在这里选到并参与编译。**0.10.1 删除了内置百炼直连通道**：`batchProvider` 必须指向模型设置里已注册的提供商，留空直接提交失败（不再有自带直连兜底，插件也不保存任何 API Key）。
- `batchReasoningEffort`（0.10.0）：该模型的思考程度档位 id。**可选值不手填**，设置页从模型目录实时读取（`GET /api/codewiki/model-efforts?provider=&model=` → 宿主 `resolveModel().reasoning.efforts`）；留空 = 用该模型的默认档。
- `bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`（0.10.4，0.10.8 全面启用）：大档模型——输入超 110k 普通预算的请求（写文章/横切/批量校对）改用该档在插件内一次写完。默认 `volces-ark` / `glm-5.3-flash`（512k 上下文），预算 420k token。`bigProvider` 留空=不启用大档。0.10.8 起大档同时是观察→合成分割的门槛：模块源码总量超 420k 才拆观察批。
- `sessionTier`（0.9.2）：**仅超大输入兜底**时才用。0.10.8 起装填上限=大档预算（`bigTokenBudget`，默认 420k）：文章源码总量在 110k–420k 区间直接大档单请求写完；超 420k 才拆观察→合成批；只有连大档都装不下的单文件才转会话通道，此时派给哪个子智能体档位（`dsh-subagent-auto-router` 里的档位 id，如 `codeiwiki`）。留空 = 让会话模型自动选路；填了则 steer 文本要求 `delegate` 显式传 `tier`。

- `binaryPath`：cw 可执行路径；留空优先用 PATH 里的 `cw`（与 codewiki 源码同步演进），找不到再用插件自带 `bin/cw.exe`。0.2.3 起此顺序（原先捆绑优先，会吃到过期的旧布局二进制）。
- `maxConcurrency`（0.12.2 起语义收窄为**默认档**）：默认档（`batchModel`，如免费 hy3）请求并发上限，默认 2（1–8，硬顶 8）。
- `bigConcurrency`（0.12.2）：大档（`bigModel`）请求并发上限（1–8，硬顶 8）；`0`/留空 = 跟随 `maxConcurrency`（等价 0.12.1 的单一池行为）。两档各自独立计数、**同时推进**——大档常是付费长上下文档、与免费默认档配额互不相干，共用一个上限会让「大档只多几个请求」把默认档全堵住；代价是总在飞请求数最高可达两者之和，上游限流时把其中一个调小。
- `serialProjects`（0.10.0）：单项目串行，默认开。开启后同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued`，前一个收尾后自动轮到——避免多项目同时编译抢占同一个免费额度。
- `articleLanguage`：文章语言，默认中文。
- `planMode`（0.13.0）：模块划分方式。`auto`（默认）= tree-sitter 提取全仓符号 → 模型按职责聚成层级模块树（单文件目录会细分、跨目录同一职能会合并）；`dirs` = 只按顶层目录分组（0.12.x 旧行为）。模型请求失败或 AST 不可用时自动退回 `dirs` 并在任务 note 里写明原因。
- `agenticArticles`（0.13.0，默认开）：文章写作走 agentic 工具循环——模型在写作过程中自己 `read_code` 读指定文件的指定行、`list_files` 找文件、`edit_article` 增量改写，不再把整个模块源码内联进单个 prompt。好处：prompt 小（不再触发 110k/420k 装填分级）、可以多轮回看精修、大文件不必拆观察批。关闭则走单轮整包装填的旧通道。
- `agenticMaxSteps`（0.13.0，默认 30，1–100）：单篇文章最多允许几轮「读源码 → 改文章」。到上限会强制收尾（写回当前文章并记 note）。
- `symbolIncremental`（0.13.0，默认开）：增量编译按 AST 符号级判定——只重写「函数签名/类结构/导出接口/导入边/函数体」真变了的模块；纯注释、空白、格式化改动直接跳过。快照存 `.codewiki/temp/symbol-graph.json`（随 wiki 入库，换机器/换会话仍有效）；快照缺失或版本不符时退回文件级 mtime/hash 判定。
- `updateReminder`：会话系统提示注入 wiki 维护提醒，默认开。仅当会话仓库根存在 wiki 入口 `CodeWiki.md` 时出现（text 回调每次组装求值，实时判断；判定不看 `.codewiki/` 目录——只有空骨架目录时提醒会指向读不到的入口）；提醒内容：收尾必须调用 `codewiki_generate` 更新 wiki（learnings/decisions 补文章与索引刷新由流水线完成，不要手工编写/修改 `.codewiki/` 下的文章——手改不进流水线、不被面板记录，会被下次编译覆盖）；`codewiki_generate` 是后台编译，调用即返回、调用后本步收尾，不要等待/轮询；产物由插件自动提交（见下一条）。0.2.5 起。0.10.9 起同一 section 只兼职**降级**提醒：最近一次成功编译的完成时间晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交 → 注入「产物待提交」（并写明自动提交为何没成功），一次性、不催促（时间戳派生自 jobs 文件与 `git log`，插件提交后自动静默，零持久状态）。0.8.0 起编译终态另有实时唤醒：工具调用会话（exec.agent）在编译 failed、或 done 但自动提交失败时收到 steer 消息（与子代理 send_message 同机制），**自动提交成功或产物本就无改动时完全不打扰会话**，面板/自动调度提交与冷会话静默跳过。
- `autoCommit`（0.10.9，0.10.10 修正文档与三态）：编译产物自动提交，默认开。编译终态（done 且有文章写成功）后由插件自己 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（信息前缀 `docs(wiki):`，带任务 id 与篇数），把「等编译完成 → 会话模型代跑 git」这件事彻底收回插件侧——会话模型因此不必等待编译、不必轮询、不必提交。安全边界：改动由 pathspec 限定在这两个路径（不是 `-A`/`--all`/`.`，因此不会卷进工作区其它改动）、不 amend/push/改写历史、不跑仓库钩子；以下情形一律**拒绝并降级**为一次性「产物待提交」提醒（不会半个提交、不会静默丢产物）：非 git 仓库、仓库无 HEAD、merge/rebase/cherry-pick 进行中、目标路径存在未解决冲突、`.codewiki/`（或未 tracked 的 `CodeWiki.md`）被 `.gitignore` 忽略、缺 `user.name`/`user.email`、`git add`/`git commit` 失败（含 `index.lock` 被并发占用）。结果写入 job 的 `autoCommit`（`committed`/`sha`/`message`/`reason`/`noChanges`），`codewiki_progress` 输出与侧边栏任务卡直接显示；三条通道（唤醒、系统提示提醒、面板）统一按 `autoCommitState()` 判定三态：已提交 → 静默、产物无改动 → 静默不催、未提交 → 才提醒一次。
- 所有设置 `volatile`，改完即生效（execute 时解包读取），无需重启。

## 安装（本地 file:/// 直挂）

本插件遵循「本地插件源码公约」，但用 router 式 file:/// 挂载，**不需要** profile package.json/`link:` 条目：

1. 源码放 `E:\ik\Documents\trae_projects\1\dsh plugin\dsh-codewiki`（本目录）。
2. `profiles/web/cordis.patch.yml` 顶层追加：

   ```yaml
   - insert:
       - id: codewiki
         name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js
         config: {}
   ```

3. 依赖解析：插件在 profile node_modules 之外，`@deepseek-ai/schemastery`（仅 Config 用）走插件本地 junction → `/e/software/deepseek-harness/vendor/schemastery`（已建，`node_modules/@deepseek-ai/schemastery`）。工具/子代理全走注入服务，零 dsh-* import。
4. 重启 dsh 生效。客户端半侧（设置页）由包声明驱动：`package.json` 里 `dsh.client.platform: "web"` + `exports["./client"]`，宿主 client 扫描器沿 file:/// 条目找到本包后自动把 `client.js` 送进浏览器——同样需要一次重启（「非 client 包」判定按条目缓存到重启为止）。

## 开发

```
vendor/codewiki/   上游源码（去除 .git）
bin/cw.exe         cargo build --release 产物（git 内跟踪，改了 vendor 记得重编）
client.js          插件页设置卡片（浏览器半侧；协议参照 ui-settings-agent-loop / router client.js）
```

验证：`node --check index.js client.js`；编排冒烟 `node test-orchestration.mjs`（mock 子代理 + 真实 cw CLI）；CLI 冒烟见 CHANGELOG 0.1.0；设置页需重启 dsh 后在插件页实测。
