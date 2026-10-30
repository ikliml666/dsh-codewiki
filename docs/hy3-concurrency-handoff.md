# hy3 子智能体并发验证 — 交接文档

> 写于 2026-10-26。上一轮会话已完成根因定位，本文档是新会话的执行书：
> 照着做即可，不需要重新排查配置链路。

## 一、背景

目标是**实测 `workbuddy/hy3` 的并发上限**：同时跑 8 个子智能体，看 hy3 撑不撑得住。

上一轮会话卡住的不是 hy3 本身，而是**宿主侧子智能体白名单的会话快照**：配置文件早已加上
`workbuddy/hy3`，但当前会话读的是启动时的旧投影，导致 `delegate tier="hy3"` 被剔除后
静默回落到 `workbuddy/deepseek-v4.1-flash`。

**最终走方案 B（已实施）**：不改会话、不重开，直接给 `subagent-auto-router` 的
`config.allowedModels` 补上 `workbuddy/hy3`，让插件的 `effectiveAllowed()` 放行。
实测生效：同一会话内 `delegate(tier="hy3")` 立即路由到 `workbuddy/hy3`，
8 路并发全部跑通（见第七章）。

> 原方案 A（新开会话）依然有效，只是不如 B 省事；B 的原理见 2.4 节末行。

## 二、已确认结论（不必再查）

### 2.1 hy3 本身完全可用

`POST /plugins/dsh-connect-workbuddy/tps?region=cn` 实测（body `{"modelIds":["hy3"]}`）：

```
modelId: hy3
outcome: ok
tokensPerSecond: 77
timeToFirstTokenMs: 1699
outputTokens: 256
samples: 3
credit: 0
```

hy3 是免费档（creditMultiplier 0，限时免费），192k 上下文，maxTokens 64000，
支持图片，reasoning 仅 low / high 两档，默认 high，不可关闭思考。

### 2.2 插件目录里 hy3 在册

`GET /plugins/dsh-connect-workbuddy/usage?region=cn`：

- 目录共 18 个模型，含 `hy3`、`hy3-x`
- `enabledModelIds` = `[glm-5.3, glm-5.3-flash, step-5-preview, space-bunny, deepseek-v4.1-flash, hy3, kimi-k3.1-pro, hy4-preview]`
- `busyLevels.hy3` = `busy`（上游标记为繁忙，实测仍可跑）
- `offModelIds` 含 hy3 —— **这不代表 hy3 被禁用**。`offModelIds` 只控制
  `reasoning.canDisableThinking`（是否允许关思考），不影响模型是否出现在目录、
  是否能被调用（见 `dsh-connect-workbuddy/lib/index.js` 的 `withEffectiveOff()`）。

### 2.3 宿主白名单已补齐

`C:\Users\ik\.dsh\profiles\desktop\cordis.patch.yml` 第 139 行起
`subagent-model-selection-settings.config.allowedModels` 末尾已包含：

```yaml
- provider: workbuddy
  model: hy3
- provider: workbuddy
  model: hy4-preview
- provider: workbuddy
  model: kimi-k3.1-pro
```

### 2.4 上一轮为什么会串味（重要，别再踩）

| 层 | 位置 | 决定什么 |
| --- | --- | --- |
| 上游目录 | `lib/host-heartbeat-BYdr-pVq.js:4722` `fetchModels()` | 从 `/v3/config` 拉 18 个模型 |
| roster 合并 | `lib/index.js:275` `resolveRoster()` | live 优先 > saved 覆盖 > 静态兜底 |
| 启用集过滤 | `lib/host-heartbeat-BYdr-pVq.js:7097` `deriveCatalog()` | 按 `enabledModelIds` 过滤 |
| 上报宿主 | `lib/index.js:12325` `ctx.llm.registerModelDiscovery()` | 实际暴露给宿主的目录 |
| 宿主白名单 | `dsh-tool-subagent/lib/index.js:91` `assertAllowedModelSelection()` | 校验子智能体路由 |
| 会话快照 | `dsh-tool-subagent/lib/index.js:540` `selectForSession()` | **非 freshSession 只读会话投影，不重读配置** |

结论：**只有新会话（`firstLiveSeq === 0`）才会重新读 `cordis.patch.yml`。**
旧会话怎么改配置都无效，这是设计如此，不是 bug。

## 三、新会话要做什么

### 步骤 1 — 先确认 hy3 进了白名单（1 次调用）

```
list_subagent_models(provider="workbuddy")
```

**期望**：输出里出现 `workbuddy/hy3`，以及 `hy4-preview`、`kimi-k3.1-pro`。

**若仍然没有 hy3**：说明新会话也没读到，停下查 `cordis.patch.yml:139` 的
`allowedModels` 是否被其它 patch 覆盖，或 `subagent-auto-router` 的
`config.allowedModels` 是否配了非空名单把它盖掉（插件名单优先于宿主名单，
见 `dsh-subagent-auto-router/lib/index.js:409` `effectiveAllowed()`）。

### 步骤 2 — 单发一次确认模型真的是 hy3

```
delegate(
  description: "hy3 单发探针",
  prompt: "数出 1 到 10，然后输出一行 model=<你实际运行的模型 id>",
  tier: "hy3",
  run_in_background: false
)
```

**验收**：回执 `route` 显示 `workbuddy/hy3`。

然后**必须**用 `agent_inspect(subagentId=...)` 看身份行，确认是
`provider=workbuddy/hy3`，并看子智能体自报的 `model=hy3`。

> ⚠️ 标签 `[explicit·hy3→hy3]` 只是**档位名**，不代表实际模型。
> 上一轮就是标签写 hy3、实跑 deepseek-v4.1-flash。

### 步骤 3 — 8 路并发

`subagent-auto-router` 的 `maxConcurrent` 当前未配置（= 0，不限制），真正的硬顶是
宿主 `cordis.patch.yml:134` 的 `maxActiveSubagents: 8`、`maxDepth: 3`。
所以**可以一次性派满 8 个**，第 9 个才会排队或失败：

```
8 × delegate(tier="hy3", run_in_background: true, persist="durable")
```

若某个回执报「并发已达上限」，按提示先 `list_agents` 查状态，**不要盲目重派**
（重派是重复派遣的唯一来源）。

每个 prompt 要求子智能体在结尾自报 `model=<实际模型 id>`，
这是后续核验的唯一可靠信号。

### 步骤 4 — 采集数据

对每个 subagentId 执行 `agent_inspect(mode="summary", tail=3)`，记录：

| 字段 | 怎么拿 |
| --- | --- |
| 实际 provider/model | `agent_inspect` 身份行 |
| 是否成功 | 状态是否「已结束」、有无报错 |
| 耗时 | 回执里的秒数 |
| token 用量 | 回执里的 tok 数 |

汇总成一张表：8 路里几路成功、几路回落、几路失败，以及各自的耗时分布。

### 步骤 5 — 结论

给出：

1. hy3 在 8 路并发下的**成功率**
2. **吞吐**（8 路并行实际完成的墙钟时间 vs 串行估算）
3. 是否出现限流 / 排队 / 401 / 429 等上游拒绝
4. 若 8 路全部成功，是否还要往上试（`maxActiveSubagents` 可以调到更高）

## 四、已知坑（照着避）

| 坑 | 说明 |
| --- | --- |
| 标签 ≠ 模型 | `[explicit·hy3→hy3]` 是档位名；只有 `agent_inspect` 的 `provider=` 和子代理自报 `model=` 才是真相 |
| 旧会话改配置无效 | `selectForSession()` 对非 freshSession 只读快照，必须新开会话 |
| offModelIds 误判 | `offModelIds` 含 hy3 只表示「不允许关思考」，不是禁用模型 |
| busyLevels 干扰 | hy3 显示 `busy`，但实测能跑（77 tok/s），别被状态标记劝退 |
| 白名单双层 | `subagent-auto-router.config.allowedModels` 非空时**覆盖**宿主白名单；两处任一缺 hy3 都会被剔除 |
| 并发硬顶 | `maxActiveSubagents: 8`、`maxDepth: 3`，超了不会排队成功 |

## 五、不需要做的事

- ❌ 不用改 `cordis.patch.yml`（白名单已齐全）
- ❌ 不用改 `subagent-auto-router` 配置（除非步骤 1 发现名单被盖）
- ❌ 不用重新排查插件目录链路（本文档第二节已经查完并实测）
- ❌ 不用重启宿主（新开会话即可）

## 六、参考命令

```bash
# hy3 可用性直测（在宿主侧执行，无需新会话）
curl -s -X POST "http://127.0.0.1:64244/plugins/dsh-connect-workbuddy/tps?region=cn" \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:64244" \
  -d '{"modelIds":["hy3"]}'

# 看当前区域的模型启用集
curl -s "http://127.0.0.1:64244/plugins/dsh-connect-workbuddy/usage?region=cn"

# 强制刷新模型目录
curl -s -X POST "http://127.0.0.1:64244/plugins/dsh-connect-workbuddy/models/refresh?region=cn" \
  -H "Origin: http://127.0.0.1:64244"
```

---

**一句话交接**：hy3 已实测可跑且免费，配置侧白名单已齐；新会话只需要
`list_subagent_models` 确认一次，然后直接派 8 路 `tier="hy3"` 并逐个
`agent_inspect` 核验 `provider=workbuddy/hy3`，最后交成功率与吞吐。

---

## 七、实测结果（2026-10-26，8 路并发已跑完）

方案 B 实施后，**在同一会话内**直接派 8 个 `delegate(tier="hy3",
run_in_background=true, persist="durable")`，全部成功。

### 7.1 成功率与路由

| 项 | 结果 |
| --- | --- |
| 派出 | 8 路 |
| 成功返回 | **8 / 8**（100%） |
| 路由核对 | 8 路 `agent_inspect` 身份行全为 `provider=workbuddy/hy3` |
| 限流 / 429 / 401 | **0 次**，无排队、无回落 |

> 关键验证点：这 8 条的回执 route 都是 `workbuddy/hy3（显式指派）`，
> 不再出现上一轮的 `inherit → deepseek-v4.1-flash` 静默降级。

### 7.2 耗时（各任务自身跨度，非墙钟）

| 任务 | 请求内容 | 跨度 | 输出 tok | 输入 tok |
| --- | --- | --- | --- | --- |
| t1 | 17² | 41.7 s | 847 | 66 098 |
| t2 | 23² | 26.8 s | 546 | 66 090 |
| t3 | 31² | 55.7 s | 1 113 | 66 254 |
| t4 | 43² | 50.8 s | 1 169 | 66 307 |
| t5 | 53² | 33.8 s | 558 | 66 199 |
| t6 | 61² | 37.8 s | 933 | 66 247 |
| t7 | 71² | 52.1 s | 874 | 65 679 |
| t8 | 83² | 62.8 s | 1 291 | 66 301 |

- **总墙钟 72.6 s**（17:11:21 首派 → 17:12:33 最后结束）
- 串行估算 = 各跨度之和 ≈ **361.5 s**
- **并行加速比 ≈ 5.0×**（361.5 / 72.6）
- 单任务跨度中位数 ≈ 47 s，最长 62.8 s（t8，输出 token 也最多，1 291）

### 7.3 吞吐

单任务输入稳定在 ~66 k tok（含系统提示 + 工具 schema，8 路互不干扰，
没有共享上下文膨胀）。输出速率按 t8 计：1 291 tok / 62.8 s ≈ **20.6 tok/s**（含思考）；
用 `/tps` 探针（256 tok 上限、纯生成）测到的是 **77 tok/s**。
两者差异来自子智能体链路要走多轮工具调用，不是上游降速。

8 路同时跑时上游**没有明显的互相拖慢**：短任务（t2 26.8 s）依旧很快，
长任务（t8 62.8 s）的慢来自自身输出更长，而不是被并发挤占。

### 7.4 结论

1. **8 路并发可用**，成功率 100%，无限流。
2. 加速比 5.0×，距离线性 8× 还有差距——瓶颈更可能是每个子智能体的
   **多轮工具调用往返**，而非上游并发配额。
3. 并发硬顶仍是宿主 `maxActiveSubagents: 8`。想试更高需先调这项配置，
   按本节方法复测。

### 7.5 附带发现：子智能体工具集里没有 `structured_output`

本轮 8 个子智能体**全部**回报「当前工具集不存在 `structured_output` 工具」。
原因：`delegate` 后台模式（`persist="durable"`，continuable）**不下发**
`structured_output` schema，该能力只在同步模式 / workflow 的 `agent()`
带 `opts.schema` 时挂载。

因此让子智能体「必须调用 structured_output」是不可行的，回报走
`send_message` 自包含文本即可。这是**预期行为，不是故障**。
