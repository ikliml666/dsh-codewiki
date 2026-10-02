# CodeWiki — @local/dsh-codewiki

> 本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约）。重启 dsh 后可用 `codewiki_generate` 对本仓库做全量编译，把本文细化成 `<repo>/.codewiki/` 文章。

## Overview

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`）接入 DeepSeek Harness：提供 `cw`（CLI 封装）与 `codewiki_generate`（智能体编排编译）两个纯工具，wiki 落在仓库内 `<repo>/.codewiki/`（随仓库提交共享；0.2.3 对齐上游 wiki_path()，并修复 MSYS/Windows 路径误判与捆绑二进制过期分叉）。0.1.1 起不注册任何技能；编译子代理默认钉在 `aliyun-bailian/qwen3.8-flash`（路由插件 wiki 档）。0.2.0 起带插件页设置 UI（client.js），编译模型与运行选项可在插件管理页点进 CodeWiki 条目修改。

## Key Components

- `index.js` — 插件全部逻辑（单文件，Node ESM）
  - `Config`（index.js:23）— schemastery 设置：enabled / binaryPath / defaultProvider+defaultModel（默认 `aliyun-bailian`+`qwen3.8-flash`）/ maxConcurrency / articleLanguage / updateReminder，全部 `.volatile()`，execute 时 `val()` 解包热读取
  - `installUpdateReminder`（index.js:717）— 0.2.5 起：`agent/created` 时在 agent 作用域注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调每次组装求值——`updateReminder=false` 或会话仓库无 `.codewiki/` 时返回空（renderPrompt 丢弃空 section），否则注入 wiki 维护提醒（收尾 `codewiki_generate`/手工 cw 流程、learnings/decisions、wiki 与代码同提交）；agent 处置时 section 随作用域销毁
  - `runCw`（index.js:62）— spawn cw 子进程，stdout/stderr/exitCode/超时（120s），响应 `exec.signal` abort（SIGKILL）
  - `parseStatus`（index.js:93）— 上游三态输出解析：missing / uncompiled / clean / stale（`  M <file>` 变更行 + `  ! <article>` 过期文章行；Windows 反斜杠路径）
  - `launchAgent`（index.js:119）/ `safeLaunch`（index.js:137）— 直用注入的 `subagents` 服务派发（`subagents.start('spawn', payload)`），route 存在时 `agentOptions={provider,model}`，`stopReason != completed` 记失败，`run.dispose()` 幂等收尾
  - `runBatched`（index.js:146）— 按 maxConcurrency（硬顶 2）分批并发派写文章子代理
  - `cwToolDefinition`（index.js:311）— cw CLI 封装工具（子命令白名单）
  - `generateToolDefinition`（index.js:436）— 编排主流程：status 判态（非零退出且无输出直接抛错）→ clean 直接报告（`scope=full` 不短路，强制全量）/ stale 逐篇更新（读 frontmatter source_files）→ 全量：规划 agent 出模块 JSON（`parsePlan` 容错解析，失败降级单 agent）→ 横切文章 → 审校 agent → `cw index` + `cw meta update`（仅当有文章写成功，失败不刷新基线可重试）
  - `apply`（index.js:689）— `ctx.inject(['tools','subagents'])` 一次注入，注册两工具
- `vendor/codewiki/` — 上游源码（去 .git）；`bin/cw.exe` — cargo release 产物（git 跟踪）
- `client.js` — 插件页设置卡片（浏览器半侧，0.2.0）
  - 注册：`__ModuleLoader__.load({id:'@local/dsh-codewiki'})` → `apply` 里 `configForms.get('codewiki')` + `whileServed` 包 `slots.inject('plugins.item', …)`（order 30）
  - `CodewikiCard`（client.js:129）— `view=summary` 一行简介（client.js:201）；`view=page` 完整表单：编译模型节（provider/model 级联下拉，`modelCatalog()` 失败退 Input）、运行节（enabled Switch / maxConcurrency 校验 1–2 / articleLanguage / binaryPath）、保存条（`form.mutate` 单层 op + revision CAS，client.js:233；脏检测/放弃/冲突提示）
  - 快照订阅：`form.getSnapshot()` + `form.subscribe`，仅 `revision` 变化才覆盖草稿（宿主保存回收读不冲掉本地编辑）
- `cordis.patch.yml` — bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂（id `codewiki`）
- `package.json` — `exports["./client"]` + `dsh.client.platform:"web"` 让宿主扫描器沿 file:/// 条目发现客户端模块（改 dsh.client 后需重启）

## Architecture

```text
模型调用 codewiki_generate(cwd, scope, provider?, model?)
        │
        ▼
  cw status 判态 ──clean──► 直接报告
        │ stale/missing/uncompiled
        ▼
  规划 agent（JSON 模块计划；失败降级单 agent 全量）
        │
        ▼
  写文章子代理 ×N（runBatched，并发≤2；默认 qwen3.8-flash）
        │
        ▼
  横切 agent（_architecture/_patterns/concepts）→ 审校 agent
        │
        ▼
  cw index + cw meta update（有成功文章才刷新基线）
```

## Data Flow

配置流：profile patch `config:` → cordis 注入 apply(ctx, config) → liveConfig 每次调用解包（volatile 热生效）。模型流：调用参数 provider+model > 插件默认（aliyun-bailian/qwen3.8-flash，0.1.1 起内建）> 两项默认显式置空才继承会话模型。

## Connections

- [[dsh-subagent-auto-router]] — wiki 档路由与本插件默认模型同档；子代理经同一 `subagents` 服务派发
- [[codewiki-upstream]] — vendor/codewiki（MIT）；布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`（随仓库提交共享）；上游技能正文仅存于 `vendor/codewiki/skills/`，插件不再注册技能

## Known Issues

- 插件注册不热加载：改 index.js / profile patch 后需重启 dsh（config 值本身热读）。client.js 同理：宿主「非 client 包」判定按 Loader 条目缓存，`dsh.client` 声明新增后需重启 dsh 才会把 client.js 送进浏览器。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `/e/software/deepseek-harness/vendor/schemastery`）；换机器需重建（`node -e "fs.symlinkSync(target,path,'junction')"`）。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，0.2.3 起与 wiki_path() 一致）。
- 上游 stale 文章路径输出为反斜杠（`modules\app.md`），插件消费侧已归一为 `/`。
- 设置页模型下拉依赖浏览器端 `modelCatalog()`；目录不可用时是文本输入兜底，不阻塞保存。
