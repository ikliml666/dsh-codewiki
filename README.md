# @local/dsh-codewiki

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：仓库内代码 wiki（`<repo>/.codewiki/`，随仓库提交共享）+ 智能体编排编译，支持为编译子代理指定模型。

## 提供

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 提交制编译：cw status 判态 → 提交后台 job 立即返回 → 宿主常驻服务按 规划 → 写文章 → 横切 → 审校 → 索引 推进（侧边栏 CodeWiki 面板可见），全部模型环节走百炼普通入口（任务输入压在 ≤32k token 低价档），零子代理 |
| `codewiki_update` | 工具 | 日常维护入口（0.7.0 起）：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「继续下一项、不要等待」；编译完成后系统提示注入「编译完成·请提交改动」提醒，把提交动作交回模型（插件不代跑 git） |
| `codewiki_progress` | 工具 | 只读查编译进度：提交后随时查 stage/百分比/已写/失败篇数/失败原因，立即返回不等待（数据与侧边栏面板同源）。可选按 `cwd` 或 `jobId` 过滤，都不传列全部任务 |
| CodeWiki 设置页 | 插件页 UI | 插件管理页 Official 组出现 CodeWiki 条目（id `codewiki`），点进详情页可改编译模型（provider/model 级联下拉，目录来自 modelCatalog）与运行选项；`view=summary` 一行简介，`view=page` 完整表单 + 保存条 |

`codewiki_generate` 关键行为：

- `scope=auto`（默认）：无 wiki / 未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告。
- `provider` + `model` 成对传入时子代理走指定模型；缺省用插件默认（`aliyun-bailian` / `qwen3.8-flash`，即路由插件 wiki 档）；两项默认都显式置空才继承会话模型。
- 规划 agent 失败自动降级单 agent 全量编译；单篇文章失败只记账不中断；全部失败则不刷新编译基线（`meta update` 不执行，可安全重试）。
- 写文章并发上限硬顶 2（红线 2），`maxConcurrency` 可调低。
- 子代理经注入的 `subagents` 服务派发（`subagents.start('spawn', payload)`），`agentOptions` 携带模型路由；`stopReason != completed` 记失败。
- `scope=full`：跳过 clean 短路，即使 wiki 最新也强制全量重编。

## 设置（插件行 config，命名空间 `codewiki`）

上述设置同样可在 **插件页 → CodeWiki 详情页**（`client.js`，v0.2.0 起）里修改：保存走 `configForms.mutate`（单层 op），与 patch 文件里手改等价、同样热生效。模型下拉来自 `ctx.remote.session.modelCatalog()`；目录不可用时退化为文本输入，仍可填任意 provider/model。

- `binaryPath`：cw 可执行路径；留空优先用 PATH 里的 `cw`（与 codewiki 源码同步演进），找不到再用插件自带 `bin/cw.exe`。0.2.3 起此顺序（原先捆绑优先，会吃到过期的旧布局二进制）。
- `defaultProvider` / `defaultModel`：编译子代理默认模型，已钉在路由插件的 **wiki 档**（`aliyun-bailian` / `qwen3.8-flash`），wiki 生成走便宜模型；要改跟随会话模型就把两项显式置空。
- `defaultReasoningEffort`：编译子代理默认思考程度（`reasoningEffort`，adapter 自有值，如 `off`/`low`/`high`/`max`）；留空跟随所选模型默认。0.2.6 起，设置页下拉来自模型目录对当前 provider+model 广播的档位，目录不可用时退文本输入；调用参数 `reasoningEffort` 优先于本配置。
- `maxConcurrency`：写文章并发上限，默认 2。
- `articleLanguage`：文章语言，默认中文。
- `updateReminder`：会话系统提示注入 wiki 维护提醒，默认开。仅当会话仓库存在 `.codewiki/` 时出现（text 回调每次组装求值，实时判断）；提醒内容：收尾必须调用 `codewiki_generate` 更新 wiki（learnings/decisions 补文章与索引刷新由流水线完成，不要手工编写/修改 `.codewiki/` 下的文章——手改不进流水线、不被面板记录，会被下次编译覆盖）；`codewiki_generate` 是后台编译，调用即返回、提交后继续其他工作，需要进度时用 `codewiki_progress` 查；wiki 与代码同提交。0.2.5 起。0.7.0 起同一 section 兼职编译完成提醒：最近一次成功编译的完成时间晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交 → 注入「编译完成·请提交改动」（时间戳派生自 jobs 文件与 `git log`，提交后自动静默，零持久状态）。
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
