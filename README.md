# @local/dsh-codewiki

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`，MIT）接入 DeepSeek Harness：中心化代码 wiki（`~/.codewiki/<project>/`）+ 智能体编排编译，支持为编译子代理指定模型。

## 提供

| 名称 | 类型 | 说明 |
|------|------|------|
| `cw` | 工具 | CLI 薄封装：`status` / `init` / `index` / `meta update` / `path` / `projects` / `setup` / `uninstall` |
| `codewiki_generate` | 工具 | 编排编译：cw status 判态 → 规划 agent 出模块 JSON 计划 → 按并发上限分批派写文章子代理 → 横切文章（`_architecture.md`/`_patterns.md`/`concepts/`）→ 审校 agent → `cw index` + `cw meta update` |
| `codewiki` | 技能 | 上游 codewiki-session 流程的 DSH 适配版（会话开始判态、编码中读文章、每任务收尾写 learnings/decisions） |

`codewiki_generate` 关键行为：

- `scope=auto`（默认）：无 wiki / 未编译 → 全量；有变更 → 逐篇更新过期文章；最新 → 直接报告。
- `provider` + `model` 成对传入时子代理走指定模型；否则用插件默认配置；再否则继承会话模型。
- 规划 agent 失败自动降级单 agent 全量编译；单篇文章失败只记账不中断；全部失败则不刷新编译基线（`meta update` 不执行，可安全重试）。
- 写文章并发上限硬顶 2（红线 2），`maxConcurrency` 可调低。
- 子代理经 `rc.subagents.start('spawn', payload)` 派发，`agentOptions` 携带模型路由；`stopReason != completed` 记失败。

## 设置（插件行 config，命名空间 `codewiki`）

- `binaryPath`：cw 可执行路径；留空用插件自带 `bin/cw.exe`（vendor 源码 + cargo release 编译），再退回 PATH 的 `cw`。
- `defaultProvider` / `defaultModel`：编译子代理默认模型。建议填路由插件的 **wiki 档**（`aliyun-bailian` / `qwen3.8-flash`），wiki 生成走便宜模型。
- `maxConcurrency`：写文章并发上限，默认 2。
- `articleLanguage`：文章语言，默认中文。
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

3. 依赖解析：插件在 profile node_modules 之外，`@deepseek-ai/schemastery`（仅 Config 用）走插件本地 junction → `/e/software/deepseek-harness/vendor/schemastery`（已建，`node_modules/@deepseek-ai/schemastery`）。工具/技能/子代理全走注入服务，零 dsh-* import。
4. 重启 dsh 生效。

## 开发

```
vendor/codewiki/   上游源码（去除 .git）
bin/cw.exe         cargo build --release 产物（git 内跟踪，改了 vendor 记得重编）
skills/codewiki.md 技能正文（frontmatter 由 provider 剥离）
```

验证：`node --check index.js`；CLI 冒烟见 CHANGELOG 0.1.0。
