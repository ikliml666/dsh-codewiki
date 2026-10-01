# CodeWiki — @local/dsh-codewiki

> 本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约）。重启 dsh 后可用 `codewiki_generate` 对本仓库做全量编译，把本文细化成 `~/.codewiki/` 文章。

## Overview

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`）接入 DeepSeek Harness：提供 `cw`（CLI 封装）与 `codewiki_generate`（智能体编排编译）两个工具 + `codewiki` 技能，wiki 落在 `~/.codewiki/<project>/`，支持为编译子代理指定模型。

## Key Components

- `index.js` — 插件全部逻辑（单文件，Node ESM）
  - `Config`（index.js:22）— schemastery 设置：enabled / binaryPath / defaultProvider+defaultModel / maxConcurrency / articleLanguage，全部 `.volatile()`，execute 时 `val()` 解包热读取
  - `runCw`（index.js:87）— spawn cw 子进程，stdout/stderr/exitCode/超时（120s）
  - `parseStatus`（index.js:110）— 上游三态输出解析：missing / uncompiled / clean / stale（`  M <file>` 变更行 + `  ! <article>` 过期文章行；Windows 反斜杠路径）
  - `launchAgent` / `safeLaunch`（index.js:138）— `rc.subagents.start('spawn', payload)`，`agentOptions={provider,model}` 指定模型，`stopReason != completed` 记失败，`run.dispose()` 幂等收尾
  - `runBatched`（index.js:170）— 按 maxConcurrency（硬顶 2）分批并发派写文章子代理
  - `generateToolDefinition`（index.js:437）— 编排主流程：status 判态 → clean 直接报告 / stale 逐篇更新（读 frontmatter source_files）→ 全量：规划 agent 出模块 JSON（`parsePlan` 容错解析，失败降级单 agent）→ 横切文章 → 审校 agent → `cw index` + `cw meta update`（仅当有文章写成功，失败不刷新基线可重试）
  - `skillProvider`（index.js:694）— bundled 技能注册，meta 形状对齐 genui（rank 600 / invocation / resourceBase / locator），content 为 skills/codewiki.md 剥离 frontmatter 后正文
  - `apply`（index.js:726）— `ctx.inject(['tools','subagents','skills'])` 一次注入，注册两工具 + 技能 provider
- `vendor/codewiki/` — 上游源码（去 .git）；`bin/cw.exe` — cargo release 产物（git 跟踪）
- `skills/codewiki.md` — 上游 codewiki-session.md 的 DSH 适配版（三态判定 / 读文章 / learnings+decisions / 质量红线 / 并发与分支纪律）
- `cordis.patch.yml` — bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂（id `codewiki`）

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
  写文章子代理 ×N（runBatched，并发≤2，可指定模型）
        │
        ▼
  横切 agent（_architecture/_patterns/concepts）→ 审校 agent
        │
        ▼
  cw index + cw meta update（有成功文章才刷新基线）
```

## Data Flow

配置流：profile patch `config:` → cordis 注入 apply(ctx, config) → liveConfig 每次调用解包（volatile 热生效）。模型流：调用参数 provider+model > 插件默认（对齐路由插件 wiki 档 aliyun-bailian/qwen3.8-flash）> 继承会话模型。

## Connections

- [[dsh-subagent-auto-router]] — wiki 档路由与本插件默认模型对齐；子代理经同一 `subagents` 服务派发
- [[codewiki-upstream]] — vendor/codewiki（MIT）；布局 `~/.codewiki/<project>/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`

## Known Issues

- 插件注册不热加载：改 index.js / profile patch 后需重启 dsh（config 值本身热读）。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `/e/software/deepseek-harness/vendor/schemastery`）；换机器需重建（`node -e "fs.symlinkSync(target,path,'junction')"`）。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`~/.codewiki/<basename>`）。
- 上游 stale 文章路径输出为反斜杠（`modules\app.md`），插件消费侧已归一为 `/`。
