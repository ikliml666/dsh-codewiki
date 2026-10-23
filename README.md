# @local/dsh-codewiki

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：仓库内代码 wiki（`<repo>/.codewiki/`，随仓库提交共享）+ 智能体编排编译，支持为编译子代理指定模型。

## 提供

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 提交制编译：cw status 判态 → 提交后台 job 立即返回 → 宿主常驻服务按 规划 → 写文章 → 横切 → 审校 → 索引 推进（侧边栏 CodeWiki 面板可见），全部模型环节在插件内完成（默认 `workbuddy`/`hy3`，192k 上下文，单请求输入预算 110k），零子代理，不委托发起会话的主模型（0.10.0）；只有单个源文件大到连 150k 都装不下时才转会话通道兜底 |
| `codewiki_update` | 工具 | 日常维护入口（0.7.0 起）：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「继续下一项、不要等待」；编译完成后实时唤醒发起会话（0.8.0 起 steer 直达，与子代理消息同机制）并注入「编译完成·请提交改动」提醒，把提交动作交回模型（插件不代跑 git） |
| `codewiki_progress` | 工具 | 只读查编译进度：提交后随时查 stage/百分比/已写/失败篇数/失败原因，立即返回不等待（数据与侧边栏面板同源）。可选按 `cwd` 或 `jobId` 过滤，都不传列全部任务 |
| CodeWiki 设置页 | 插件页 UI | 插件管理页 Official 组出现 CodeWiki 条目（id `codewiki`），点进详情页可改编译模型（provider/model 级联下拉，目录来自 modelCatalog）与运行选项；`view=summary` 一行简介，`view=page` 完整表单 + 保存条 |

`codewiki_generate` 关键行为：

- `scope=auto`（默认）：无 wiki / 未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告。
- 全部模型环节（规划/写文章/横切/审校）在插件内跑，共用 `batchProvider`/`batchModel` 一个模型；不再委托发起会话的主模型。
- 单篇文章失败只记账不中断；全部失败则不刷新编译基线（`meta update` 不执行，可安全重试）。
- 请求并发 `maxConcurrency` 默认 2（硬顶 8）。
- `serialProjects` 默认开：同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued` 排队，前一个收尾后自动轮到。
- `scope=full`：跳过 clean 短路，即使 wiki 最新也强制全量重编。

## 设置（插件行 config，命名空间 `codewiki`）

上述设置同样可在 **插件页 → CodeWiki 详情页**（`client.js`，v0.2.0 起）里修改：保存走 `configForms.mutate`（单层 op），与 patch 文件里手改等价、同样热生效。0.9.1 起「编译模型」是 provider/model 两级下拉：目录来自插件自己的 `/api/codewiki/models`（同源宿主 `llm.listProviders` + 各 provider 的 `listModels`，即模型设置页里已注册的提供商），不读插件配置；目录不可用时退化为文本输入，仍可填任意 provider/model。0.10.0 起「思考程度」也改为从模型目录读取——选中 provider/model 后拉 `/api/codewiki/model-efforts`（宿主 `resolveModel().reasoning.efforts`）渲染下拉，不再手填裸字符串。


- `batchProvider` / `batchModel`（0.10.0，0.10.1 起为唯一通道）：编译模型（规划/写文章/横切/审校全部环节共用），默认 `workbuddy` / `hy3`（免费、192k 上下文），走宿主 llm 服务。`batchModel` 填该 provider 的模型 id——本地 OpenAI 兼容端点（如本地 9B）只要在模型设置里注册过，就能在这里选到并参与编译。**0.10.1 删除了内置百炼直连通道**：`batchProvider` 必须指向模型设置里已注册的提供商，留空直接提交失败（不再有自带直连兜底，插件也不保存任何 API Key）。
- `batchReasoningEffort`（0.10.0）：该模型的思考程度档位 id。**可选值不手填**，设置页从模型目录实时读取（`GET /api/codewiki/model-efforts?provider=&model=` → 宿主 `resolveModel().reasoning.efforts`）；留空 = 用该模型的默认档。
- `sessionTier`（0.9.2）：**仅超大单文件兜底**时才用。超 110k 单请求预算的文章先按 150k 大档重装（仍在插件内），连 150k 都装不下才转会话通道，此时派给哪个子智能体档位（`dsh-subagent-auto-router` 里的档位 id，如 `codeiwiki`）。留空 = 让会话模型自动选路；填了则 steer 文本要求 `delegate` 显式传 `tier`。

- `binaryPath`：cw 可执行路径；留空优先用 PATH 里的 `cw`（与 codewiki 源码同步演进），找不到再用插件自带 `bin/cw.exe`。0.2.3 起此顺序（原先捆绑优先，会吃到过期的旧布局二进制）。
- `maxConcurrency`：编译请求并发上限，默认 2（1–8，硬顶 8）。
- `serialProjects`（0.10.0）：单项目串行，默认开。开启后同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued`，前一个收尾后自动轮到——避免多项目同时编译抢占同一个免费额度。
- `articleLanguage`：文章语言，默认中文。
- `updateReminder`：会话系统提示注入 wiki 维护提醒，默认开。仅当会话仓库存在 `.codewiki/` 时出现（text 回调每次组装求值，实时判断）；提醒内容：收尾必须调用 `codewiki_generate` 更新 wiki（learnings/decisions 补文章与索引刷新由流水线完成，不要手工编写/修改 `.codewiki/` 下的文章——手改不进流水线、不被面板记录，会被下次编译覆盖）；`codewiki_generate` 是后台编译，调用即返回、提交后继续其他工作，需要进度时用 `codewiki_progress` 查；wiki 与代码同提交。0.2.5 起。0.7.0 起同一 section 兼职编译完成提醒：最近一次成功编译的完成时间晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交 → 注入「编译完成·请提交改动」（时间戳派生自 jobs 文件与 `git log`，提交后自动静默，零持久状态）。0.8.0 起编译终态另有实时唤醒：工具调用会话（exec.agent）在编译 done/failed 时收到 steer 消息（与子代理 send_message 同机制），面板/自动调度提交与冷会话静默跳过。
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
