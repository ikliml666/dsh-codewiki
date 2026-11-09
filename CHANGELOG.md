# Changelog

## 0.19.1 — 2026-11-09

### 修复启动崩溃：`pruneSessionRecords is not defined`

0.19.0 删会话视图时删掉了 `pruneSessionRecords` 的定义，但 `tick` 里的调用漏了。
每轮 tick（每 10 分钟一次清理分支）走到那里就抛 `ReferenceError`，宿主把它当成致命
加载失败（`dsh: fatal load failure`），整个插件不可用。

这个错误本该在删除那一轮就被拦住，但当时的完整性检查只查了「被删的符号是否还有人用」，
没查「剩下的代码是否还在调用已删的符号」——方向反了。

同时清掉同批遗留的死代码（都是删除会话视图后没人引用的）：

```
client.js  [data-dscw-p-sessrow] 相关 CSS 11 条
           STAGE_ORDER / STAGE_LABEL_OF / splitPrompt / MD_LABELS
           会话视图的注释块
           tabSessions（中英文两条文案）
index.js   tick 里的 pruneSessionRecords 调用与 lastPruneAt 状态
```

`STAGE_LABEL_OF`、`splitPrompt`、`MD_LABELS` 都是「定义后无人使用」，`MD_LABELS` 尤其
容易误判——它看着像 MarkdownText 的必需参数，但渲染组件早已随会话视图一起删了。

验证：

```
定向检查：17 个已删除符号（pruneSessionRecords / SESSIONS_DIR / writeSessionMeta /
          listSessionRecords / readSessionRecordDetail / beginSessionRecord /
          estimateTokens / sessionNameOf / messagesToPrompt / MAX_SESSION_PROMPT_CHARS 等）
          在 index.js / client.js / lib 全仓零残留
语法：index.js、client.js、三个 Python 模块全部通过
冒烟：index.js 可加载、Config 核心项仍在、压缩与熔断模块可导入、apply 不抛
回归：Node 5 套（i18n 静态/动态键、冒烟、熔断、行提示）、
      Python 7 套（熔断 19、端到端 16、entry 15、补丁顺序 7、桥引擎 9、压缩单元 18、压缩端到端 6）全绿
```

顺带删掉两个过时测试：`.dbg-loop-grouping.mjs`（测的是随会话视图一起删掉的 `loopGroups`）、
`.dbg-i18n-dyn.mjs` 里针对 `sessRole*` 的清单项。

## 0.19.0 — 2026-11-09

### 历史压缩：把已读文件的全文从后续每轮请求里摘掉（实测省 37%）

单次增量编译（job-mw8s9um1-4，串行 moduleConcurrency=1）实测：110 次模型请求共
**1,039 万输入 token**，其中 **65.7% 是工具返回的整篇文件内容**。模型在第 2–7 次请求里
把 16 篇文档整篇读进历史，之后每一条请求都把全部 16 篇完整重发一遍，一直背到第 110 次。

**这不是并发导致，也不是故障**，是上游设计与框架默认行为的叠加：

- 上游 prompt 的 `WRITE_SET` 只给 14 个页面路径、不给内容 → 模型必须自己读（合理，它要精准改）
- pydantic-ai 的 agentic 循环默认保留完整历史 → 读过的一直在
- 两者相遇：16 篇整篇读，在历史里累计出现 1047 次，重复倍数 65.4×

**裁什么**：只裁整篇读（`view` 不带 `view_range` 的返回）。行段读（带 `view_range`）是模型的
精准定位手段——真机 46 次行段读 vs 24 次整篇读，前者才是它实际依赖的。实测 16 篇被整篇
读入的文档里，**10 篇读入后再未被任何 `view_range` 访问**，纯占历史。

**判据用行数不用字符数**：真机整篇读 100–409 行，行段读 ≤71 行，阈值取 80 行干净分开。
最初用 4000 字符做阈值，200 行的中文页面只有 2900 字符被漏判——语言不同字符密度差 4 倍，
字符数不是可靠判据。

**方案来自三个成熟项目的实证**：

- **SWE-agent** `LastNObservations`（论文默认 n=5）：保留最近 n 个 observation，其余替换成
  `Old environment output: (n lines omitted)`。与本项目场景最贴近（同为「读文件→改→再读」循环）。
- **Claude Code** 第一级压缩：清旧工具结果、只留最近 5 个，占位符带行数。它的第二级用
  `cache_edits` 保住 prompt cache，依赖 Anthropic 私有 API，本项目不走。
- **OpenHands** `keep_first`：保护开头 system 与任务定义永不压缩。

**缓存顾虑在本项目不成立**：SWE-agent 源码明确警告裁剪会破坏 prompt cache（历史每轮变 →
缓存全失效）。本项目实测不适用——上游加的 `cache_control` 标记在桥的 `contentToBlocks`
（`lib/engine/openai-bridge.js:35-48`）里只取 `type === 'text'`，标记被丢弃；110 次请求零缓存
命中（`cachedTokens` 全空）。裁剪没有缓存代价。

**实现**：新增 `lib/engine/python/history_compaction.py`（纯函数、可单测），在
`channel_breaker.py` 的 `GuardedModel.request` 出口接线——这是模型调用出口，所有叶子、
所有通道都经过它，不改引擎源码（`.probe-fsoft/` 是 gitignore 的探针环境）。压缩只作用于
本次请求的消息列表，不改 agent 持有的 `message_history`（否则「压缩」会变成「永久丢失」）。

配置项 `historyCompactionKeep`：默认 3，-1 = 关闭，0–20 合法。保护开头两个 ModelRequest
（system 提示词 + `WRITE_SET`/`CHANGE_REPORT` 任务定义）。

实测收益（真实记录 + cl100k tokenizer 离线模拟）：

```
基线（全保留）        10,395,521 token
保留最近 3 次整篇读     6,447,581 token   省 38.0%
保留最近 2 次           5,461,849 token   省 47.5%
保留最近 1 次           4,463,924 token   省 57.1%
```

验证：

```
.dbg-compaction-unit.py   18 passed   判据/保护前缀/保留策略/占位符格式/不污染原始历史/边界
.dbg-compaction-e2e.py     6 passed   走真实 GuardedModel 链路：上游收到的内容确实变少
反向验证：拆掉 GuardedModel 里的压缩接线 → 3 条 FAIL（内容 17634→17634、0 占位符）
         还原后 6 passed
真机判据校验：16 篇整篇读（100–409 行）全部识别，71 行行段读正确排除
全量回归：Python 19+16+15+7+9+5+18+6、Node 4+4+2 全绿
```

**未验证**：真实编译下裁剪后的文章质量。离线模拟证明 token 省下来了，但「模型拿到占位符
后会不会回读、写出的文章会不会退化」需要同输入跑两遍对比（裁 vs 不裁）。这是下一步。

## 0.18.5 — 2026-11-09

### 审核补丁：衰减计数、专属熔断类别、账本缺失防护（commit 2fcc617f / 5296ea7e / 57a63d7d）

0.18.5 合并后做了一轮深挖审核，又堵上三个在真机并行场景下才会暴露的缺口。

**一、空产出计数从「有产出即清零」改成衰减**（`2fcc617f`）。计数器是全局的，清零语义下
只要还有一个叶子在正常写，故障叶子的空产出就永远攒不到阈值——实测 A 连空 6 次、
B 正常 6 次交替时 max_streak 只有 2，熔断从未触发，而 `moduleConcurrency>1` 正是这种
形态。改成空产出 +1、有产出 -1（下限 0），桥与引擎两侧同步改，避免同一阈值两套语义。
效果：全局故障立即熔断（行为不变）；故障占比过半时持续上涨直到熔断，偶发好结果不再
能无限掩护；1:1 交替持平不涨（通道确实还有一半在用，不该整轮停）；持续有产出归零，
真恢复不误伤。

**二、熔断终态用专属类别 `model-channel-tripped`，并补回本轮增量结局**（`5296ea7e`）。
此前 `_salvage` 的 blocker 一律是通用的「编译在 X 阶段中断」，与引擎崩溃同形；崩溃要查
引擎、熔断要查模型可用性与额度，混同会让人修错地方。同时 `_update_outcome_of_safe()`
恒返回 None，把「本轮走的是增量还是回退」这一事实丢掉了，现在传 adapter 时读真实值。
新类别登记进 `contract.js` 的 `BLOCKER_KINDS`——不登记会被 `normalizeBlocker` 静默降级成
`engine-error`，这正是 `engine-timeout` 当初踩过的坑。

**三、熔断出口账本为 None 时不再二次异常**（`57a63d7d`）。`_usage_of_ledger` 直接读
`adapter._usage_ledger.summary()`，但账本在 `__init__` 里是 None（`doc_generator.py:75`），
只在 `:219` 才被赋真值。后端初始化阶段就熔断时，这里会抛 `AttributeError`——位于
`except ChannelBreakerTripped` 块内的二次异常，直接撕掉终态。账本为 None 时返回全 0：
后端都没跑起来，本轮确实一个模型请求都没发出去。

验证（每项都做了反向验证，证明测试红得起来）：
```
衰减语义：计数器六形态逐一验证 + 并行四场景（局部故障/全局故障/真恢复/偶发）；
          桥改回清零语义 → 故障占优用例 FAIL，还原后 4 passed
专属类别：kind 改回默认 article-failed → 断言 FAIL，还原后 16 passed
账本防护：删掉 None 防护 → AttributeError 从熔断处理块里抛出；还原后正常产出终态
```

**真机观察**：`job-mw8qqyk5-1`（本仓库增量编译）在审核期间跑完，partial、41 篇写成、
1 篇失败（`UsageLimitExceeded: request_limit of 100`，单模块预算，与熔断无关）。全过程
几十次模型请求零空产出，熔断未误触发，正常路径不受影响。

### 根治重复失败／一直重写：熔断升级为「整轮停」，拆掉同源 fallback

0.18.4 在桥侧加了「连续 3 次空产出回 503」的熔断，但它挡住的只是桥这一个入口：引擎把 503
当作可重试的上游错误，在每个叶子上继续烧；`FallbackModel` 又把 `UnexpectedModelBehavior`
当成回退信号，切到**同一个模型同一条桥同一个上游**再烧一遍。这一轮把熔断从「桥拒绝」改成
「整轮终止」，并拆掉那个假容错。

真机证词（`%TEMP%/dsh-codewiki-sessions/job-mw80h05t-2/`，185 条会话共 11,566,117 输入 tok）：

```
#107–#158   同一叶子连续 52 次请求，inputTokens 恒 = 74,817
#159–#185   27 次三空响应，input 尺寸在 13k/10k/32k/18k/14k/11k 间切换
            → 不同叶子各自重试 3–4 次
```

**一、熔断的抛点从「桥入口」前移到「模型调用出口」，且跨叶子共享预算。**
新增 `lib/engine/python/channel_breaker.py`（运行时补丁，不改 venv 里的第三方源码），在
`Model.request` 出口数连续空产出：连续 N 次即抛 `ChannelBreakerTripped`。

- 选 `Model.request` 而不是 agent 循环：pydantic 的 `max_output_retries` 是 **per-run** 的
  （`_agent_graph.py:452-473`），同一上游故障会让每个叶子各烧满一份；进程内所有
  `PydanticAIBackend` 共用同一个 breaker 才谈得上「共享预算」。
- 停在**第 N 次**而不是等 pydantic 重试到上限（N+1 次）再失败，止血更早。
- 熔断后每个后续调用在入口即抛，一个 token 都不发上游。

**二、`ChannelBreakerTripped` 必须是 `BaseException`，并且必须显式收口。**
引擎里到处是 `except Exception`（`updater/orchestrator.py:425-427`、
`leaf_agent.py:140-145`、`full_parallel_runtime.py` 的 `_run_module`、
`fsoft_runtime.py:220-222`），普通异常会被吞成「这页无需改动」，整轮照样报 done。只有非
Exception 才能穿过它们——代价是 `action_generate` 的 `except Exception` 也接不住它，
所以必须在 `job = adapter.generate()` 紧邻外侧加 `except ChannelBreakerTripped`，在
`except SystemExit` 之前，显式翻成契约终态：

- 已写文章 >0 → `partial`（沿用 `_salvage` 语义，不丢已写产物）
- 一篇没写 → `failed`，`error.code = engine-model`
- 用量从 `adapter._usage_ledger` 补：`generate()` 的 `_finish_usage` 在
  `except Exception` 分支里（`doc_generator.py:200-207`），BaseException 走不到它，
  不补的话这轮真实花费会在终态里显示为 0

**三、桥的熔断响应从 503 改 400。** 依据（`.probe-fsoft/venv` 里实测）：

| 状态码 | openai SDK 重试（`_base_client.py:843-863`） | pydantic 归类 | `fallback_on` 命中 |
| --- | --- | --- | --- |
| 503 | 是（`>=500`） | `ModelUnavailableError` | 是 → 同源再烧一遍 |
| 400 | 否（不在 408/409/429/>=500 集合） | `category=None` → 裸 `ModelHTTPError` | 是（仍是 `ModelAPIError` 子类） |

400 单独还不够（仍是 `ModelAPIError`），所以配合第四条的「不包 FallbackModel」，两者一起
才让熔断真正止住。引擎侧读到 `provider_error_code == 'empty_response_breaker'` 时把桥的
拒绝升级成进程级熔断（`channel_breaker.GuardedModel.request`），避免「桥已拒、引擎还逐叶子撞」。

**四、同源 fallback 直接不包。** patch `codewiki.src.be.llm_services.create_fallback_models`：
`fallback_model == main_model`（`entry.py` 的 `_model_config` 恒如此）时返回
`GuardedModel(UsageModel(main))`，不再包 `FallbackModel`。非同源时直接抛 `RuntimeError`
而不是回退到旧行为——本插件只有一条上游，非同源 fallback 的熔断语义未定义，写成崩溃比写成
一条永不执行的分支诚实。

patch 必须遍历 `sys.modules` 替换所有 `create_fallback_models` 绑定：上游两处调用点都是
`from ... import`（`pydantic_ai_backend.py:30`、`generate_sub_module_documentations.py:10`），
导入时已复制引用，只改定义处不起作用。

**五、阈值经 `native-run` 同时下发给桥与引擎。** 此前 `emptyStreakLimit` 只传给桥，
引擎侧收不到就等于没有跨叶子预算。现在 `runNativeJob` 的 `emptyStreakLimit` 参数同时进
`startLlmBridge({...})` 与引擎 `payload`（`entry.py` 读 `payload["emptyStreakLimit"]`）。

未做：**doc_guard 的熔断跳过**（原计划的第四项）。熔断抛点在 `Model.request`，
`run_until_doc_written` 的下一次 `agent.run` 根本执行不到——那条分支不可达，写出来是死代码。

验证（`.dbg-*`/`.tmp-*` 临时脚本，已被 .gitignore 覆盖，不随仓库分发）：

```
.dbg-empty-breaker.mjs          3 passed  熔断后回 400（不再是 503）；中途恢复清零；阈值 0 = 关闭
.dbg-wire-e2e.mjs               4 passed  emptyStreakLimit 同时进桥参数与引擎 payload；0 原样；缺省 3
.dbg-config-wire.mjs            2 passed  Config 暴露该键；归一化保留合法值、非法值退回 3
.tmp-check-breaker.py          19 passed  包装层行为：同源 fallback 不再存在；空产出 3 次即熔断
                                          （上游只被调 3 次而非 4/6 次）；limit=5 时叶子 1 烧 4 次、
                                          叶子 2 补到第 5 次才熔断（旧行为是 8 次且全失败）；偶发 1 次
                                          空产出后恢复不误停；BaseException 穿过 except Exception
.tmp-check-bridge-engine.py     9 passed  真桥 + 真 pydantic-ai 走 HTTP：引擎侧先熔断时桥只被打 3 次、
                                          之后 rejectedAfterBreak=0；桥侧先熔断（桥 2/引擎 5）时引擎把
                                          400 升级为整轮熔断、桥只转发 2 次、挡下 1 次
.tmp-check-entry.py            15 passed  _salvage 带 usage 进 partial/failed；_usage_of_ledger 读数正确；
                                          ChannelBreakerTripped 不被 except Exception 捕获
.tmp-check-patch-order.py       7 passed  复刻 entry.py 的导入顺序：install 时 pydantic_ai_backend
                                          与 generate_sub_module_documentations 都还没进 sys.modules，
                                          之后导入读到的就是新 factory；真 PydanticAIBackend 建出的
                                          _fallback_models 是 GuardedModel、内层仍是 UsageModel
.tmp-check-e2e-trip.py         15 passed  action_generate 真的收得住熔断：无产物 → failed + 账本用量
                                          224,451 tok + 错误码 engine-model（不是 engine-crashed）；
                                          已写 3 篇 → partial + 同一份用量；真实子进程跑 generate
                                          动作时正常退出、只发出一条 result 帧（协议流没被撕）
.tmp-check-async-prop.py        5 passed  引擎的两条并发结构都能让 BaseException 穿出去：
                                          gather 立刻传播且不等 2 秒的兄弟任务；复刻
                                          full_parallel_runtime._run_module 的
                                          `async with semaphore` + `except Exception` 后仍到达顶层；
                                          asyncio.to_thread（增量隔离路径）里的熔断同样传回事件循环
```

反向验证（拆掉补丁必须红）：

```
① channel_breaker 里把「连续到阈值即熔断」改成 if False：
   .tmp-check-breaker.py 13 passed / 6 failed——熔断不再触发、上游被调 4 次而不是 3 次、
   breaker 不置位、叶子 2 不熔断、BaseException 不再出现。还原后 19 passed。
② factory 里把同源 fallback 包回去（FallbackModel(main, fb)）：
   .tmp-check-patch-order.py 报 PydanticAIBackend._fallback_models = FallbackModel，FAIL。还原后 7 passed。
③ 删掉 GuardedModel 包装（等价 0.18.4）：.tmp-check-bridge-engine.py 下三个叶子各抛一次
   ModelHTTPError、桥被挡下 3 次、没有任何一次 ChannelBreakerTripped
   →「整轮停的信号不存在」与「逐叶子燃烧」两条断言 FAIL。
```

**未验证**：真实上游连续空返回下的整轮终止。真机故障窗口是一次性事件，本轮全部用构造的
「200 + usage-only」响应与真桥（`startLlmBridge` + 桩 `llm.stream`）覆盖，没有等第二次真实
故障。三个未在真机上跑过的点：①`ChannelBreakerTripped` 在**真实引擎**（含
`fsoft_runtime` 的隔离副本、`full_parallel_runtime` 的并行分支）里是否真的穿过所有
`except Exception`；②`_usage_of_ledger` 读到的账本数字与最终成交账单是否一致（账本由
`api_usage.py` 的 `UsageModel` 逐请求记，本身未改）；③断线时 `asyncio.run` 的取消传播是否会
先于我们的收口把任务带走。

## 0.18.4 — 2026-11-09

### 会话面板：已完成的行不再说「思考中」，用量改显实测 token，模型通道加空产出熔断

用户截图会话视图，看到大片 `✓ 原生请求 · deepseek-v4.1-flash`、`0k ch`、`思考中`、`仅工具调用`，
问「大多数请求都是失败的，没有结果输出，这会影响到使用额度以及效率吧」。

**先纠正一个误判：那些不是失败。** 全部 3143 条会话记录里 `status` 无一为 `error`，全是 `done`；
截图那轮任务（`job-mw81xjun-0`，42 篇）终态 `outcome: done`、失败 0。抽查三条「0 char」记录：
`output` 为空，`reasoning` 有 491 字推理，`tools` 里有 `str_replace_editor` 的完整参数——模型在
读页、在改页，正文由工具调用直接落盘，不经过对话正文。这是 agentic 写作的正常形态。

**但用户的直觉有一半是对的：额度确实在漏**，只是漏点与成败无关：

```
总请求 3143    输入 175,627,642 tok    输出 2,079,061 tok     （约 84 : 1）
正文为空的 2755 条（87.7%）里，2512 条有思考、2724 条有工具调用
真·空返回（无正文无思考无工具）30 条
```

三处独立缺陷，分别改掉：

**一、已完成的行挂现在进行时的「思考中」。** `emptyHint` 不看 `status`，`✓ done` 且正文为空
一律落到 `sessHintThinking`/`sessHintTools`，读起来像还在跑或卡住了。0.17.61 只修了 `running`
分支，`done` 分支没改。现在按状态分流：进行中说「思考中」，完成说「内容在思考里」；
工具同理（「仅工具调用」/「本轮在调工具」）。

同一个缺陷还有第二处：`data-empty` 判据是「无正文」，于是这些已完成、有思考的行被降了饱和度，
比同组其他行更灰，看着像出了问题。改成只有三空（无正文、无思考、无工具）才标记。

顺带修掉 `Math.round(73 / 1000)` 显示成 `0k ch`：不足千字按实际字节数显示。

**二、面板上的 `in 74k tok` 不是账单上的数。** `session meta` 的 `inputTokens` 是
`estimateTokens(prompt)` 的字符折算（中文 1 字 1 token、其余 3.5 字符 1 token），与上游用量
可以差出不少。桥本来就收到了 `usage` chunk，只是没往下传：

- `llm-bridge.js` 的 `usageSeen` 扩到四个字段（input / output / cacheRead / cacheWrite），
  两条 `onDone` 出口多传一个 `usage` 实参
- `beginSessionRecord` 的 `onDone(content, outputTokens, usage)` 用实测值覆盖估算，并写
  `inputTokensMeasured: true`。**计费量含缓存**：`TokenUsage.inputTokens` 是不含缓存的净输入，
  账单口径要加 `cacheRead + cacheWrite`（与 `openai-bridge.js:172-185` 同一换算）
- 面板把两者分开显示（`入 74k tok` / `入 74k tok（估算）`），估算值带 title 说明它是折算值。
  上游不回 `usage` 时（实测约 2%）保留估算、不标记实测，历史记录缺该字段一律按估算显示

**三、真正失败的那一轮：模型通道 27 次连续空返回，引擎却把每次失败记成「无需改动」。**
`job-mw80h05t-2`（dsh-git-worktree）在 00:26:36–00:30:55 拿到 27 次「HTTP 200 但只有
usage+finish 两个 chunk」，每次 3–31 秒；引擎按「输出重试 3 次」跑满后抛
`UnexpectedModelBehavior: Exceeded maximum output retries (3)`，8 个叶子写作失败，任务 partial，
空烧 629,386 input token（占该任务 5.4%）。

熔断加在桥的请求入口：连续这么多次「上游 200 却无正文、无工具调用」后，后续请求不再转发上游，
直接回 503，`stats` 记 `tripped`/`emptyStreakMax`/`rejectedAfterBreak`。**不终止引擎进程**——
已写的文章照常走质量门落地，终态如实标 partial，只是不再把额度烧在注定失败的调用上。
`native-run` 把熔断写进 notes，面板能看到「为什么这一轮后面的请求变少了」。

阈值默认 3，依据是真机游程分布：正常任务的最大连续空产出是 1 次（偶发一次后立刻恢复），
故障任务是 27 次，**两者之间没有过渡带**。配置项 `emptyStreakLimit`（0 = 关闭）同时进了设置页。

**四、顺手修掉两个一直存在的文案缺陷。** `t('requestLimitHint')` 与
`t('autoUpdateLabelHint')` 引用的键在字典里不存在（后者字典里叫 `autoUpdateHint`），
面板上直接显示键名本身。已补 `requestLimit`/`requestLimitHint`/`emptyStreakLimit*`/
`invalidRequestLimit`/`invalidEmptyStreakLimit` 并改掉拼错的那一处。

验证（测试文件不随仓库分发，故用 `.dbg-*.mjs` 临时脚本，已被 .gitignore 覆盖）：

```
.dbg-session-metrics.mjs  4 passed   桥交出 usage 四字段；实测覆盖估算且计费含缓存；无 usage 时保留估算
.dbg-empty-breaker.mjs    3 passed   达阈值停发上游且不再计费；中途恢复清零不误熔断；阈值 0 = 关闭
.dbg-extract-hint.mjs    11 passed   从 client.js 源码抽出 emptyHint/isEmptyish/charLabel 真实执行
.dbg-config-wire.mjs      2 passed   Config 暴露该键；0 原样保留、非法值退回 3
.dbg-wire-e2e.mjs         3 passed   runNativeJob 真的把 emptyStreakLimit 传进 startLlmBridge
.dbg-i18n-keys.mjs        键齐全     270 对键全匹配（含 t('xxx') 静态引用全集）
.dbg-i18n-dyn.mjs         键齐全     动态拼接键（${k}Hint、kind${X}、sessRole${X}、state${X}）全覆盖
```

反向验证（证明测试真的红得起来）：

```
把 emptyHint/isEmptyish/charLabel 改回旧逻辑 → 4 条 FAIL，还原后 11 passed
临时拆掉桥里的 stats.tripped 判断       → 熔断用例 FAIL，还原后 3 passed
```

**未验证**：真实上游连续空返回下的熔断行为。真机故障窗口是一次性事件，本轮只用手工构造的
「200 + usage-only」响应覆盖了这条路径，没有等第二次真实故障。熔断触发后的引擎侧反应
（503 会被 `_classify_exception` 翻成什么 blocker 文案）同样未在真实引擎上跑过。

## 0.18.3 — 2026-11-08

### 清理死代码：14 个符号 + 10 个空转的 default 导出

全仓扫了一遍「定义后无人引用」的符号（JS 按导出/顶层声明统计跨文件引用，Python 按顶层
def/class 统计全包引用），删掉 14 个完全没人用的符号，以及 10 个模块里无人 import 的
`export default` 块。净减 213 行，未新增任何行（两处 +1 行是 import 列表重排）。

完全无人引用的（跨文件 + 本文件都是零引用）：

```
lib/article-contract.js  ARTICLE_CONTRACT_VERSION / issueSummary / hasBlockingIssue
                         makeWriteSet / isWritable / normalizeWritePath   ← agentic 写集闸门，通道已下线
lib/engine/contract.js   CONSUMING_UPDATE_OUTCOMES / describeEngineResult
lib/engine/openai-bridge.js  isPlaceholderKey
lib/job-logs.js          removeLog
lib/update-record.js     loadUpdateRecord
index.js                 addUsage                                        ← 旧批通道的用量累加器
lib/engine/python/full_parallel_runtime.py  _SharedTreeIO               ← 被 _install_shared_tree_io 的闭包取代
lib/engine/python/stage_map.py              articles_ceiling
```

其中三处是「旧通道下线后的遗留」：`makeWriteSet`/`isWritable` 服务的是 agentic 工具的
`allowedWritePaths`（该通道 0.17.49 起不再产），`addUsage` 服务的是已删除的批通道用量统计，
`_SharedTreeIO` 是被 `_install_shared_tree_io()` 里的同名闭包取代的旧类——它一旦被实例化就会
绕过 `_ORIG_LOAD`/`_ORIG_SAVE` 的空值检查，留着比删掉更危险。

`loadUpdateRecord` 删掉后 `UPDATE_RECORD_VERSION` 仍被写入侧使用（`buildUpdateRecord` 落
`version: 1`），所以只降级了读侧，版本号本身保留。

10 个模块的 `export default { ... }` 块无人 import（全部用命名导出），删除；块内每个符号
在文件内仍被使用，删除后没有产生新的死代码。

验证：

- 全部 lib 模块 + `index.js` 逐个动态 import 成功（40 个导出不变）
- `node --check` 覆盖 30 个 JS 文件，`ast.parse` 覆盖 5 个 Python 文件
- 真实调用：`collectChangeSet` / `judgeOutcome` / `buildUpdateRecord` / `engineResult` +
  `validateEngineResult`（含非法 outcome 被拒）/ `inspectArticle` 四类判定（空文、合规、
  重复 frontmatter、围栏未闭合）行为不变
- `stage_map` 运行时：`map_stage(1)=graph`、`percent_of(2,0.5)=45`、`articles_percent(3,10)=62`
- `bin/cw.exe status` 正常输出变更清单

**未验证**：一次真实编译全流程（需 Python venv，约 174 分钟）。

## 0.18.2 — 2026-11-08

### 设置页补上 TechDocs 开关

`techdocs` 在 0.17.62 就进了 Config，但面板一直没渲染它、也没进 `SAVE_KEYS`。后果是它只能在
profile 的 `cordis.patch.yml` 里手写，而设置页看着像「这个功能没有开关」——用户在页面上找不到
它，`SAVE_KEYS` 里也没有这个键，即使手工渲染了也存不下去。

补法是把它接到「产物与提醒」段（`updateReminder` / `autoCommit` / `workspaceOnly` 之后），
文案说明它每轮会多导出约 37 个文件、并且不进 cw 索引——这个量级应该让人在打开前就知道。

```
Config 字段: 28 | SAVE_KEYS: 28
SAVE_KEYS 里但 Config 没有（会静默丢值）: 无
Config 有但 SAVE_KEYS 没有（面板改不了）: 无
```

`SAVE_KEYS` 是自动保存的字段表（`client.js:1229` 逐键比对 draft 与 base 生成 `form.mutate` 的
set 操作），所以键进表才会真正落盘。

**未验证**：浏览器里点一次开关看它落盘（需要重启宿主加载新 client bundle）。

## 0.18.1 — 2026-11-07

### 会话列表：终态记录不再摸磁盘，轮询从 40ms 降到 5ms

会话页每 5s 轮询一次全局端点，而全库 meta 有两千多条。拆开看单次 `listAllSessionRecords(200)` 的成本：

```
readdir 20 个任务目录   1.9ms
statSync 2096 个 meta  38.7ms   ← 只为判断「有没有变」
readFile 2096 个       56.5ms   ← 冷启动时每条都要读一次
JSON.parse 2096 个      1.5ms
```

原来的缓存按 `mtime:size` 判定，所以每次轮询仍然要把两千多个文件全部 stat 一遍——**热轮询 40ms 里 38ms 是白花的**。

**终态记录写完之后再不会被写。** 实测 2068 条终态记录的 mtime 与 `finishedAt` 偏差全部为 0，代码里也只有 `onDone` / `onError` 各写一次。所以拆成两个缓存：

- `sessionMetaFrozen`：读到终态（status 不是 running）就永久有效，之后不再碰磁盘。
- `sessionMetaLive`：只有仍在跑的记录需要确认更新。它每次追加只会变大，比序列化长度就够，不用 mtime，也不用真的 stat 出字节数——写入路径本来就要 `JSON.stringify` 一次，直接复用那份字符串的长度。

另外每个任务目录只解析最新的 `limit` 条：结果按时间取前 limit，单个任务最多贡献 limit 条，更早的不可能进结果。零填充文件名倒序即倒序 n，所以排序文件名再切片即可，不必 parse 全部。

验证（18 个任务、2050 条记录，同一份数据两版对比，各跑 3 次）：

```
            冷启动(limit=200)   热轮询(200)   热轮询(80)
0.18.0        709 / 757 / 761ms   39-41ms     36-41ms
0.18.1        400 / 450 / 479ms    4.7-5.0ms   3.4-3.9ms
```

热轮询快 **8×**，冷启动快 **1.6×**；两版返回的 200 条记录逐条一致。

真实 HTTP 端点（真 server、真 fetch）：冷 781ms → 热 14ms；运行中的记录从 out=7 改成 4321 后，下一次轮询如实看到 4321（缓存没把活记录冻住）；单任务 limit=80 / total=690 不变。

冒烟：`test-client-panel.mjs` 24 passed、`test-sessions.mjs` 全部通过（新增 6 条：跨目录预裁剪不漏记录、运行中记录变大能看到新值、运行中转终态立刻反映）。反向验证——把运行中的记录也当终态冻结，三条断言立即 FAIL（含「startedAt 最新的排最前」），说明这层缓存确实有牙。

## 0.18.0 — 2026-11-07

### 清除历史包袱：删除 Node 兼容通道，清理全部演进记录

用户要求：「全面清除过去的技术，清除过去的设计以及改动记录，这些东西留着会影响项目
开发以及判断。」四类全清，git 提交历史不动。

**删除 Node 兼容通道（`nativeEngine: false` 那条路）。** 它已经不接收新能力，却仍在
`index.js` 里占着一整套并行实现：五个阶段 handler（`tickArticles` / `tickCrosscut` /
`tickReview` / `tickIndex` / `tickCommit`）、`STAGE_HANDLER` 分派表、批次执行器
（`startBatchChatRun` / `startAgenticRun` / `submitBatchFor` / `settleJob`）、会话通道
（`dispatchSessionTasks` / `progressSessionTasks` / `resendSessionSteer`）、本地规划
（`localPlan`）、本地校对（`localReview` / `settleProofread`）、文章落盘闸门
（`writeValidated` / `tally`）、以及三个专属模块 `lib/agentic.js`（541 行）、
`lib/articles-agentic.js`（333 行）、`lib/agentic-host.js`（135 行）。

`index.js` 5404 → 3571 行，删除 1833 行；`client.js` 3002 → 2913 行。

连带删除的配置项（它们只对这个通道生效）：`bigEnabled` / `bigProvider` / `bigModel` /
`bigReasoningEffort` / `bigTokenBudget` / `bigConcurrency`，以及 Config 里从未接线过的
`planMode` / `symbolIncremental` / `agenticArticles` / `agenticMaxSteps` / `sessionTier`。
Config 从 39 项降到 28 项。

连带删除的死代码（静态扫描确认零引用）：`localPlan`、`packArticles`、`collectSources`、
`runRealtimeTasks`、`applyTaskResult`、`contractCheck`、`allowedLinkTargets`、
`auditExistingArticles`、`makeLinkExists`、`currentCommit`、`classifySessionTask`、
`buildSessionSteerText`、`writeValidated`、`tally`、`settleProofread`、`pruneOrphanModules`、
`ensureWikiEntry`、`normalizeIndexLinks`、`bigTierOf`、五个 `batch*Prompt` 构造函数、
`fixAnchors` 及其配套的 `fixChangelogAnchors` / `changelogSections` /
`repairUnclosedFrontmatter` / `wikiRelOf` / `CONTRACT_FS` / `numberLines` / `slugify`。

`tick()` 的通道分派简化为单一通道：`job.channel` 仍记账，但不再有 `STAGE_HANDLER`
回落。原生引擎不可用时明确报错，不再有「悄悄换通道」的可能。

**清理历史性注释。** 删掉所有「0.x.y 起」「曾经」「旧的」「已退役」「兼容通道」类表述
以及引用了已不存在代码的注释块。这类文字会影响后续判断——例如「关闭 nativeEngine
退回 Node 流水线」在通道删除后就是假话，仍在 Config 的 description 里。

**文档瘦身。** `CHANGELOG.md` 4228 → 389 行（保留最近 10 个版本，更早见 git log）。
`docs/fsoft-native-engine.md` 432 → 290 行：删掉阶段 0/1A/1B/1C/6 的历史验收记录与
阶段门禁表，改为「关键机制」（工作区快照、取消与超时、真机上才能暴露的约束表）；
删掉实际已不存在的 `test-engine-contract.mjs` 等测试文件引用。`README.md`、
`cordis.patch.yml` 同步去掉已删功能与不存在的配置项。

**验证**（全部为当轮命令输出）：

```
$ node --check index.js && node --check client.js   → 均通过
$ for f in lib/*.js lib/engine/*.js; do node --check $f; done   → 全部通过
$ node /tmp/dead2.js   → 顶层定义 113 个，真死代码 1 个（Config，导出，正常）
$ node /tmp/apply2.mjs
  注册工具: [ 'cw', 'codewiki_generate', 'codewiki_update', 'codewiki_progress' ]
  注册路由: /api/codewiki/{jobs,repos,sessions,sessions/item,logs,models,model-efforts,control}
$ node /tmp/smoke2.mjs
  Config 字段数: 28
  已删字段仍存在: []
  保留字段: [nativeEngine, nativeEnginePython, techdocs, maxConcurrency, moduleConcurrency, requestLimit, updateRung]
```

**未验证**：真实编译一轮（需要重启宿主加载新代码；旧进程内存里仍是删除前的实现）。

## 0.17.64 — 2026-11-07

### 命中排除清单时不再向会话解释

用户原话：「我就是要排除这个仓库，但是我希望在会话中不要说这个仓库被排除，因为我就是
把他排除了，不想这个仓库编译。」

这次改动**推翻了 0.9.1 的相反要求**（那时要「返回排除项，告诉模型此工作区被排除了」）。
当时的理由是不说清会让模型不知道发生了什么；实际用下来反过来了：模型看到「被排除」会去
追问用户为什么、建议到设置页把目录移出清单，而用户本来就是要它不编译——每一句解释都在
让模型复述一件用户早就决定的事。

所以命中排除清单时 `notes` 置空，两个工具的 render 直接返回一句中性话就收尾：

```
codewiki：本仓库无需处理，继续手头工作。
```

`state: 'excluded'` 仍然返回给调用方（面板、内部判据要用），只是不再进 render 文本、
也不再附带原因与「去设置页改配置」的引导。`submit()` 里的同类抛错保留——那是内部接口，
工具入口已经提前拦下，模型看不到它。

### 验证

```
# 隔离作业文件（DSH_CODEWIKI_JOBS_FILE 必须在 import 之前设置）后直调两个工具
--- codewiki_generate
  state: excluded | submitted: false | notes: []
  render: "codewiki：本仓库无需处理，继续手头工作。"
  泄露词: 无
--- codewiki_update
  state: excluded | submitted: false | notes: []
  render: "codewiki：本仓库无需处理，继续手头工作。"
  泄露词: 无
```

泄露词表 = `排除` / `excluded` / `清单` / `建 wiki`，两者均为空。

## 0.17.63 — 2026-11-06

### 编译终态不再给会话发消息

用户要求「取消 codewiki 编译失败把消息发给模型的这个功能」。确认范围后按「全部取消」
执行：成功、部分完成、失败、产物待提交，四种终态一律不再 steer 任何消息。

原来的 `wakeCompileSession(job, outcome, agents)` 有两个出口——失败发「【CodeWiki 编译
失败】任务 …」，`done` 但自动提交没成功发「【CodeWiki 产物待提交】…」。整条路径连同
`createJobService` 的 `onSettled` 回调参数、`fail()` 的 `notify` 选项一起删掉了：留着
一个永远传不到的回调只会让下一个人以为终态还有出口。`fail(job, msg, {notify:false})`
的唯一调用点（原实例停更作废排队项）也随之退回两参数。

保留的部分是**会话通道**，它跟终态通知是两件事：超批量预算的文章要 steer 给发起会话、
由会话模型派子智能体写作（`dispatchSessionTasks` / `resendSessionSteer`）。`agentsRef`、
`createUserMessage`、`reassignSession` 因此都还在，只是注释里「唤醒」的措辞改成了
「会话通道」——否则读代码的人会以为唤醒机制还在。

终态现在只从三处体现：面板任务列表、`codewiki_progress` 工具的返回、以及系统提示里
那条 `codewiki:update-reminder` section（自动提交失败时它仍会注入一次性的「产物待提交」
提醒——那是拉取式的，不会主动打断会话）。

### 验证

```
node --check index.js lib/job-store.js                     SYNTAX_OK
grep -rn "wakeCompileSession" --include=*.js .             无输出（已彻底移除）

# 模块导出面：唤醒函数消失，其余导出不变（57 个）
has wakeCompileSession: false   has autoCommitState: true   has commitHintText: true

# apply() 起来后不产生任何 steer（fake agents 服务记录每次 steer）
apply 完成，steered 条数: 0

# 端到端触发失败：用不存在的引擎解释器提交一次编译，等 tick 走到终态
submit 返回: {"submitted":false}
steered 条数（8 秒后）: 0

# 拉取式提醒没被误删：造一条 done + 写入 3 篇 + autoCommit 未成功的 job 记录
commitHintText(repo) → 1 条，文本为「【CodeWiki 产物待提交·一次性】…写入 3 篇文章…」
```

## 0.17.62 — 2026-11-06

### 同步上游 a1b9f4a，把 PR #155 的 TechDocs 导出接成开关

上游从 `1b4af43` 走到 `a1b9f4a` 只有两个提交，全是 PR #155「export Backstage TechDocs
projects」（13 文件 / +982 行）。**没有触及本插件依赖的任何内部模块**：`updater.py`、
`agent_orchestrator.py`、`generate_sub_module_documentations.py`、`call_graph_analyzer`
一行未动，两处运行时适配器的源码锚点（`IncrementalUpdater._run` 的 Step 5 段、
`DocumentationGenerator._generate_modules_in_order`）在新版本上仍然命中。

新能力本身是纯文件转换，不调模型：读一份引擎产物目录，产出 `mkdocs.yml` + `docs/`，
每页加 front matter、来源横幅（commit/日期/模型）与可折叠组件清单，交给 Backstage
TechDocs 渲染。接成配置项 `techdocs`，默认关。

**为什么默认关**：它是给文档站点发布用的附加产物，每轮提交会多出 37 个文件；编译本身
不需要它。

**为什么站点目录必须建在仓库外**：上游这一步是直接写盘的。让它往 `.codewiki/` 里写，
就绕过了落地器的写集封闭与回滚——`partial`/`failed` 的一轮会留下一份半截站点，而落地
器不知道它存在，既不会算进写集也不会回滚它。现在 `index.js` 在 `os.tmpdir()` 下建临时
站点，`entry.py` 把它传给 adapter，跑完由 `lib/engine/techdocs.js` 的 `captureSite()`
读成 `{rel, content}` 写集，在 `native-run.js` 段 3.8 并进本轮 `stateFiles`，与文章
**同一个事务**落进 `.codewiki/_techdocs/`。

**为什么只有真的读到站点才裁剪它**：`pruneRoots` 里 `_techdocs` 是有条件的
（`siteCapture.captured.length ? [TECHDOCS_DIR] : []`）。写死进去的话，某一次导出失败
（上游那条路径只 `click.secho` 警告、不失败整轮）就会让裁剪把上一轮整站删光，而这一轮
什么也没写——静默丢产物。

**站点里没有图片**：落地器的 extraFiles 通道要求 `content` 是字符串
（`apply-plan.js:1148`），二进制走不了。`captureSite()` 把非 UTF-8 文件记进 `skipped`。

`.codewiki/_techdocs/` 以 `_` 开头，因此与 `_native-state/` 完全一致的待遇：`cw index`
跳过整棵子树，孤儿页与索引收录校验不管它，`lib/change-set.js` 的 `isWikiProduct` 不会
把站点改动算成源码变化。它随编译一起提交，不进 wiki 索引。

### 顺带重写 7 个受管仓库的引擎锁

`UPSTREAM_COMMIT` 一变，所有既有仓库的 `.codewiki/engine-lock.json` 就与当前环境不符，
`compareLock` 报 `drift`，而 `native-run.js:305` 对 `drift` 是直接
`settle({outcome:'failed', stage:'env'})`——下一轮会在环境校验就失败。这次用
`buildLockBody` 生成与引擎自己落锁完全一致的正文，把 7 个仓库的锁重写到 a1b9f4a
（指纹 `815347593ef61e2a` → `deb591f66b067016`）。`version`/`pythonVersion`/`pipCheckOk`
沿用旧锁里的真实值：本次只有上游源码 commit 变了，venv 与解释器都没动。

### 验证

```
# 引擎升级后的接口兼容与锚点
CLIDocumentationGenerator.__init__ 参数 = [self, repo_path, output_dir, config,
  verbose, generate_html, commit_id, techdocs_dir]        has techdocs_dir: True
install_full_runtime(1) / install_incremental_runtime()   均成功，Step5 replaced: True
pip check                                    No broken requirements found.

# 真引擎算图（不花模型费）
probe-no-llm-graph.py --fsoft-src .probe-fsoft/src
  → "ok": true，R1–R5 五条判据全 true，total_components=15，edge_count=8

# 上游 techdocs 在本仓库真产物上实跑
codewiki.cli.main techdocs .codewiki/_native-state/docs <tmp>
  → ✓ Wrote 36 TechDocs pages，mkdocs.yml nav 38 行

# entry.py 接线
注入假 generator 后调 action_generate：techdocs_dir 已传入（绝对路径）
  C:\...\entry-td-site，generate_html=False

# runNativeJob 端到端（假引擎产物 + 假站点）
notes: "TechDocs 站点已导出 3 个文件到 .codewiki/_techdocs/"
artifacts.techdocsDir = '.codewiki/_techdocs'，techdocsFiles: 3
落盘 4 个文件（含 docs/.codewiki-techdocs marker）全部存在
_index.md 不收录 _techdocs（正确），git status --porcelain 为 clean（与文章同批提交）
captureSite 单独跑真站点：captured 38、skipped 0，隐藏文件确实收录
  二进制站点文件（PNG 头 + 非法 utf8）被跳过并记进 skipped，不冒充成写集项

# 上游 adapter 真导出分支（真 CLIDocumentationGenerator + 真 generate_techdocs，不碰模型）
_run_techdocs_generation() → site file count: 38，mkdocs.yml: True，
  marker: True，page count: 36

# 7 个受管仓库的锁重写后逐个跑生产路径 doctor
match  dsh-codewiki / dsh-git-worktree / dsh-presets-Switch / dsh-subagent-auto-router
match  Wxxy-CampusHub / Wxxy-CampusLogin / dsh-hindsight-on-demand
   （全部 status: match，无 diffs）
```

**未验证**：真引擎 + 真模型的完整一轮（宿主进程启动于本次改动之前，插件仍是旧代码，
`techdocs` 开关尚未生效）。这一环要重启宿主后跑一次真实编译才能确认。

## 0.17.61 — 2026-11-06

### 会话行：正在生成时标「生成中」，不再误报「无内容」

用户截图三条 `原生请求 · doubao-seed-2.1-lite` 都是「无内容」，问「这没有问题吗」。查证分两层。

**那三条是旧版本写的记录，内容确实丢了。** `job-mw4re442-f` 的 #11/#12/#13（17:25:51 / 17:25:56 / 17:26:00）meta 里连 `stage`、`reasoningChars`、`toolCalls` 三个字段都不存在——它们是 0.17.60 上线前写的。对应的 `full.json` 里 `promptLen` 分别 183977 / 184131 / 185137 字符，`outputLen` 全是 0。桥日志显示这三条请求的 chunk 构成：

```
#11  reasoning-delta 369, text-delta 43, tool-call-delta 15
#12  reasoning-delta  30, text-delta  0, tool-call-delta 28
#13  reasoning-delta   0, text-delta  0, tool-call-delta 28
```

内容都在思考与工具调用里，旧的 `textDeltaOf` 只认正文，整段丢掉了。这正是 0.17.60 修的那个 bug，历史记录无法回填。

**0.17.60 上线后的新记录是完整的。** `job-mw4s9yyc-2` 的 #1 是改动后第一条：`stage=articles`、`outputChars=89`、`reasoningChars=4191`、`toolCalls=1`、`outputTokens=3818`；详情端点返回思考全文（4191 字符）与 `str_replace_editor` 的完整参数（`{"working_dir":"docs","command":"view","path":"overview.md"}`）。

**但这轮还暴露一个真瑕疵：请求正在跑、增量还没到时，三者都是 0，行上也会标「无内容」。** 那个状态是「即将长出来」，不是「没有」。`emptyHint` 原来只在 `outputChars` 为 0 后依次看思考与工具，最后无条件落到 `sessHintEmpty`；现在在兜底前加一层：状态为 running 时显示 `sessLive`（生成中）。同一行的 `data-empty`（给行名降饱和度的标记）也同步排除 running，否则「生成中」的行名会比同组其他行更灰，看着像失败。

验证：

```
test-client-panel.mjs  24 passed, 0 failed
  （新增「正在生成且尚无增量时行上标生成中，不误报无内容」）
反向验证：临时删掉 running 分支 → 该用例 FAIL「生成中的空记录被报成了无内容」，
          还原后 24 passed
```

真机对账（`%TEMP%/dsh-codewiki-sessions`，603 条记录）：601 条是旧格式（其中 379 条无正文），2 条新格式且字段齐全。

## 0.17.60 — 2026-11-06

### 会话页：按流程分类、正文 Markdown 预览、修掉「打开没有内容」

用户第二轮反馈四件事：「还是不美观」「每个工作区的会话要按流程分类」「打开一些会话发现没有输出内容，这没有问题吧」「会话内部按 md 预览显示」。第三条不是观感问题——查下来是真 bug。

**一、「没有输出内容」是记录环节把内容丢了，不是模型没说话。**

真机上统计 101 条会话记录：48 条有正文，53 条 `outputChars=0` 但 `outputTokens>0`（#4 tok192、#5 tok284、#7 tok156、#8 tok371…）。token 确实产生了，正文却是空。翻桥日志 `/tmp/dsh-codewiki-logs/*.ndjson` 里的 chunk 构成：

```
{"block-start":3,"reasoning-delta":1094,"block-end":3,"text-delta":17,"tool-call-delta":11,"usage":1,"finish":1}
```

模型这一轮几乎没写正文，token 全在 `reasoning-delta`（思考）与 `tool-call-delta`（工具调用）里。而 `textDeltaOf(chunk)` 只认 `chunk.text` / `chunk.delta.text` / `chunk.content`——DSH 的 chunk 类型是 `{type:'reasoning-delta', text}` 与 `{type:'tool-call-delta', id, argumentsDelta}`（`@deepseek-ai/dsh-llm/lib/types/types.d.ts:463-472`），两种都不匹配，于是整段被当成「非文本 chunk」直接 `return`。

改成 `sessionDeltaOf(chunk)` 按 `type` 分流成 `{text}` / `{reasoning}` / `{tool}`；`beginSessionRecord` 分别累积正文、思考与工具（工具按 `id` 合并分片，`argumentsDelta` 是逐片流下来的，不合并会把一次调用记成几十条半截 JSON）。meta 新增 `reasoningChars` / `toolCalls`，full 新增 `reasoning` / `tools`。终态仍以 `onDone` 给的全文为准，只有它为空时才保留流式结果。

体感变化：那 53 条「空的」请求，点开能看到模型当时想的是什么、调了哪些工具、参数是什么。列表行上也会直接标注原因（「内容在思考里」/「这轮在调工具」），不必点开才发现是空的。

**二、按流程分类：阶段信息此前根本没进会话记录。**

会话 meta 里没有 stage 字段——95 条记录的 `name` 全是「原生请求 · doubao-seed-2.1-lite」，列表上完全分不清哪条是解析代码图、哪条是在写文章。阶段信息在引擎里是有的（`llm-bridge.js` 的 `currentStage`，由 `native-run.js:702` 的 `onProgress` 通过 `bridge.setStage(p.stage)` 同步），但 `onRequestStart` 的 task 只带了 `name/model/provider/batchPrompt`，没传 stage。

三处补上：桥的 `onRequestStart` 带 `stage: currentStage`；native 通道用 `task.stage || job.nativeStage`；batch chat 与 agentic 通道用 `t.stage || job.stage || 'articles'`。历史记录没有阶段，面板统一归到「未标注」，不回填、不猜。

面板因此变成三层：工作区（仓库名 + 条数）→ 编译阶段（阶段名 + 条数 + 完成/失败/在跑）→ 单条请求。阶段按流程序排（排队→解析→聚类→写文章→校对→校验→索引→提交），不按时间——按时间排会让同一个阶段在列表里出现多次、来回跳。折叠态全在 `collapsed` map 里，默认全展开：进这一页就是想一眼看完，折叠是用户的额外动作而不是前提。

**三、正文改 Markdown 预览。**

原来 prompt 与输出都是 `<pre>{text}</pre>`，模型输出的 `## 标题`、列表、代码块全按原文摊着。改用宿主 primitives 里的 `MarkdownText`（`variant: 'compact'`，未完成的请求带 `streaming`——它走增量解析器，能看着输出逐段长出来），分类用 `SegmentedTabs`：输出 / 提示词 / 思考 / 工具，后两个只在真有内容时出现。提示词按 `[system]/[user]/[assistant]` 切块，每块带粘顶的角色标签。

**四、视觉：三层各有各的语法，不再一律描边。**

仓库层只有标题与条数，靠留白和一条底边分隔；阶段层左侧一条 1px 竖线把「同一步的请求」圈在一起（缩进用 padding，竖线才连续）；请求层只用状态点，不描边。详情区两块面板吃掉剩余高度自己滚，`pre` 的 300px 限高彻底删除。

验证：

```
test-client-panel.mjs  23 passed, 0 failed
  （新增：同一工作区内按编译阶段分组 / 输出为空但产出了思考时行上说明原因 /
    会话详情正文按 Markdown 渲染且四个页签齐全 / 全局视图默认全展开）
test-sessions.mjs      全部通过
  （新增：阶段落进 meta / 思考全文落盘 / 同一 id 的工具分片合并成一条 /
    onDone 正文覆盖流式累积）
真实 HTTP（起真 server，打三个会话端点）：
  全局列表行带 stage=graph、outputChars=0 且 reasoningChars=11
  单条端点返回思考全文与合并后的工具调用 read_file {"path":"a.ts"}
  jobs 端点 nativeResult 不再携带 gate.articles 全量清单
```

一处取舍：`readSessionRecordDetail` 合并 full 与 meta 时，思考与工具的**计数**取 meta（3s 节流期间 meta 是内存里最新的），**内容**取 full（节流快照）。正在生成的请求点开时，计数可能比正文多出最后几秒的部分——这个差在 3s 内自愈，比让面板显示过期计数更好。

## 0.17.59 — 2026-11-06

### 会话页重做：详情占满整屏、进行中任务可读、轮询不再白跑

用户反馈三件事叠在一起：「会话标签页会话一多加载就慢」「UI 过于简陋」「点进会话详情只显示半屏，下面一半不显示还要滚动」「无法查看正在进行的会话」。查下来是四个独立缺陷。

**一、详情只占半屏：双层滚动容器把内容压成自己的高度。**

`[data-dscw-p-page]` 自带 `height:100%; overflow-y:auto`。打开会话视图时 `SessionView` 又用同一属性做根节点，于是两个 `height:100%` 套在一起——内层的高度落在「高度不确定的父滚动容器」里，撑不出满高；而详情里唯一的输出块还带着 `pre { max-height: 300px }`。结果就是详情撑到内容高度就停，剩下半屏空白，想看全还得滚外层。

改成：面板根节点在会话页加 `data-dscw-p-fixed`（`overflow:hidden`），高度由 `sesswrap` → `sessdetail` 一路 `flex:1 1 auto; min-height:0` 分配下去；prompt 与输出各自是一块 `[data-dscw-p-sesspane]`，内部 `pre` 自己滚，300px 限高整条删掉。两块面板都能点标题折叠，展开时各占一半可用高度。

**二、进行中任务是裸文本：两个 data 属性没有任何样式规则。**

`[data-dscw-p-active]` / `[data-dscw-p-activerow]` 从 0.17.5 起就在 JSX 里用着，样式表里却一条匹配都没有。渲染出来是几行无边框、无色条的纯文字，和下面带状态色条的请求行完全不在一个视觉体系里，看着就像没画完。

补齐了这两条规则（边框 + 浅底 + pulse 圆点 + `[data-idle="true"]` 灰化），并让全局视图里点一行进行中任务等于「只看这个任务的请求」（`focus`），顶部给一条可清除的筛选条——原本要在一堆跨仓库的请求里自己找。

**三、轮询每 5s 重建整棵列表，滚动位置与焦点被打断。**

`SessionView` 的 `pull` 无条件 `setList/setActiveJobs`，即使 payload 一字未变也触发重渲染。改成先算指纹（total + 每个活跃任务的 stage/percent/requests + 每条记录的 status/outputChars），与上次相同就直接 return。内容没变时列表不重建，滚动位置与键盘焦点都保住。

**四、服务端三处白跑。**

| 位置 | 旧做法 | 新做法 |
| --- | --- | --- |
| 全局会话端点算「已发几个请求」 | 对每个活跃任务 `listSessionRecords(id).length`——读全部 meta 再取 length | `countSessionRecords`：只数 `.meta.json` 文件名 |
| 全局会话列表排序 | 每次轮询读完全部 meta 才能按 startedAt 排序 | meta 按 `mtime:size` 缓存，命中只花 stat；排序换掉 `localeCompare`（ISO 时间串词法序即时间序） |
| 单任务会话列表 | 一次返回全部（446 条的旧任务是常态） | `limit` 参数，默认 80，配 `total` 供前端「再加载」 |
| jobs 端点 payload | `nativeResult` 原样带出 `gate.articles`/`incremental.hydrated` 等，前端只用两个 outcome | `nativeResultBrief` 只留 `outcome/stage/gate.outcome/apply.outcome` |

验证（同形态造数：30 个任务 / 2224 条请求记录，新旧两版 `installWebServer` 装在同一份数据上跑真实 HTTP）：

```
GET /api/codewiki/jobs
  旧 11.3ms / 601.9KB    新 6.5ms / 254.7KB    体积降 58%
  nativeResult 字段：旧 344.7KB → 新 2.6KB
GET /api/codewiki/sessions（全局）
  旧 990.9ms / 63.8KB    新 52.1ms / 63.8KB
GET /api/codewiki/sessions?jobId=job-bench-00
  旧 283.5ms / 114.3KB   新 14.2ms / 20.8KB    体积降 82%
  旧 sessions=446（无 total/limit）→ 新 sessions=80 total=446 limit=80
```

`test-client-panel.mjs` 21 passed（新增「详情：两块可伸缩面板取代限高盒子」一条，断言两块 pane、默认都展开、旧 `sessbody` 已消失）；`test-sessions.mjs` 全部通过。

## 0.17.58 — 2026-11-06

### 进度条只画已执行的阶段，未执行的不再占位

用户看图反馈：进度条的颜色分布是「按固定比例预先排好」的——准备中那一格明明只跑到「解析代码图 2%」，右边却已经摆着聚类、文章、校验、索引、提交的浅色块，看着像五条空槽而不是「现在到哪了」。

根因在 `stageSegments` 的过滤条件：`stageWeight(job, r.stage, running) > 0`。进行中时 `stageWeight` 对**每个**非排队阶段都返回 `STAGE_WEIGHTS[stage]`（非零），于是四个还没轮到的阶段照样被画成 `data-state="todo"` 的浅色段。

改成只画「已跑完 / 正在跑 / 失败在这一步」的段；未执行阶段的权重留成一段透明 spacer（`data-dscw-p-seg-ahead`），让带子的总宽不随阶段推进而跳变，同时把 `[data-dscw-p-segbar]` 的底色补成与普通进度条轨道一致——未执行的地方就是轨道底色，不是阶段色。

图例同口径：未执行的阶段不列出（列出来只有一排 0%，没有信息量）。prepare 展开的三格里，只保留已完成与正在跑的子阶段。

验证：`test-client-panel.mjs` 20 passed（三条受影响断言按新口径改写：准备中 2 段而非 7 段、写文章阶段 2 段而非 5 段、未开始的 cluster 不进图例，并新增「未执行部分留成 spacer」断言）。

## 0.17.57 — 2026-11-06

### 没源码变化就不再提交任务：丢掉永久携带的死路径 + 提交前的空转闸门

用户问「怎么感觉每次重启应用后都会有更新任务，不是已经更新完了吗」。查下来是两个独立缺陷叠加，两个都修了。

**根因一：`state.json` 的 `unconsumed` 会把死路径永久携带。**

`mergeUnconsumed`（`lib/engine/native-state.js:545`）的旧规则是「上一轮携带的路径只有出现在本轮 `committed` 里才算消化」。于是「文件已被删掉、又从未提交过」的路径永远进不了 `committed`，被无限携带，`effectiveChanges` 永远非空，`idleRound` 永不成立——工作区明明干净，每轮仍跑完整的依赖分析。

真机实测（修复前）：

| 仓库 | `unconsumed` | 其中磁盘上已不存在 |
| --- | --- | --- |
| `dsh-subagent-auto-router` | 37 | 37（全是 `.dsh-ops/panel/*.json`） |
| `dsh-git-worktree` | 7 | 6（全是 `.diag-tmp/*`） |
| `dsh-presets-Switch` | 0 | 0 |

修法：`mergeUnconsumed` 增加第三类判定——不在本轮 git 任何一路（committed / staged / unstaged / untracked / deleted / renamed）里的旧账判为**死条目**，`dropped` 出账并在 notes 里点名。被 `.gitignore` 忽略的文件同样丢弃：用户写进 `.gitignore` 就是声明「这不是仓库内容」，它永远进不了 commit，携带它等于保证空转，而丢掉不会少编译任何东西。被 git 看见的未跟踪文件仍然继续携带。

修复后用同一批真实仓库复验：`dsh-git-worktree` 丢 7 条、`dsh-subagent-auto-router` 丢 37 条，两仓库的 `effectiveChanges` 从「恒非空」降到 **0**。

**根因二：AutoScan 无条件提交任务。**

`codewiki_generate` 的原生通道分支（`index.js:4029`）必须接住 `cw status` 报 clean 的情况——`cw status` 只看 committed，看不见工作区变化与受管状态。代价是 AutoScan 每小时把每个仓库都提交成一条任务，真跑起来要 3 分钟以上依赖分析，之后才发现「变化 0 项」。

修法：新增 `idleNativeReason({ cwd, wikiPath })`（`index.js:1616`），在提交任务前判一次「这一轮没有任何可做的事」。判据乐观——任何一项判不准都返回 `null`（照常提交），宁可漏跳也不许丢变化：

- 变更采集失败 → 不跳（不知道有没有变化）；
- 受管状态缺件（`module_tree.json` / `metadata.json` / 依赖图）→ 不跳（引擎会转全量）；
- `state.json` 记录的 `headCommit` ≠ 当前 cw 基线 → 不跳（有别的任务前移过基线，范围对不上）；
- `effectiveChanges` 非空 → 不跳。

用 `headCommit` 而不是 `baseCommit` 对基线：`cw meta update` 写在基线阶段、取的是那一刻的 HEAD，也就是本轮跑完时的 `headCommit`；`baseCommit` 是本轮开始时的旧基线，天然落后。

**验证（当轮实测）**

- `test-engine-native-incremental.mjs`：用例 19 新增 8 条断言（死条目丢弃 / 活口保留 / gitignore 同样丢弃 / 未跟踪新文件仍进变化集 / state.json 不再写回死条目 / notes 点名）→ **172/172 通过**。
- `test-batch.mjs`：新增 6 条断言直接测 `idleNativeReason`（干净→跳、有未提交改动→不跳、改动撤回→重新可跳、旧账有活口→不跳、状态缺件→不跳、headCommit 对不上→不跳）→ **123 通过**。
- `test-engine-native-job.mjs` 142/142、`test-job-reliability.mjs` 125/125、`test-engine-apply-plan.mjs` 62、`test-article-contract.mjs` 33、`test-config.mjs`、`test-worktree.mjs`、`test-wiki-entry.mjs` 全通过。
- 真实仓库复验：`dsh-git-worktree` / `dsh-subagent-auto-router` / `dsh-presets-Switch` / `Wxxy-CampusHub` 四个仓库的 `idleNativeReason` 全部判为「跳过本轮」，`dsh-codewiki` 因工作区有 27 项真实改动判为不跳。

## 0.17.56 — 2026-11-06

### 「准备中」不再是一格黑箱：按引擎子阶段展开，并按已解析文件数推进

面板的 `prepare` 一格吞了引擎三段：`env`（探测环境）、`graph`（解析代码图）、`cluster`（模块聚类）。真机上这三段耗时差两个数量级——`env` 三秒，`graph` 三到四分钟，`cluster` 十几分钟——而进度条整段**一动不动**。

不动的原因在上游：FSoft 把阶段内的 `update_stage` 全写在 `if self.verbose:` 里（`.probe-fsoft/src/codewiki/cli/adapters/doc_generator.py:207/225/234`），`entry.py:1015` 传的是 `verbose=False`，于是 `stage_progress` 恒为 0，`percent_of(1, 0.0)` = 0%。直到阶段跑完 `complete_stage()` 才一跳跳到 36%。实测 `job-mw4d5snr-7`：`02:36:58 graph 0%` → `02:40:24 graph 36%`，中间 3 分 26 秒零帧。

两处改动：

1. **引擎侧（`lib/engine/python/entry.py`）**：`_DetailHandler` 新增 `parse` / `parse-start` 两条正则，从上游 `call_graph_analyzer.py:118` 的 `[12/36] lib/engine/client.js (4.2s elapsed, ~8.1s remaining)` 里抽出已解析数与总数；`frame_percent` 在阶段 1 用 `percent_of(1, done/total)` 算真实比例；进度帧的 message 补「已解析 12/36 个源文件」。心跳从 60s 收到 10s——FSoft 每解析约十分之一文件才打一条日志，60s 一帧意味着整段只闪 3 次。心跳仍不推进 `percent` 之外的东西，也不改任何 FSoft 行为；`nativeLogSig` 去重让重复帧不进日志。

2. **面板侧（`client.js`）**：`prepareRows()` 在「当前正处在 prepare」时把一格拆成 `env`/`graph`/`cluster` 三段，段宽按 `nativeStageTimings`（新字段）的真实耗时、未跑到的按预估权重补齐；色相从 `prepare` 的 196 向两侧各偏 12°。引擎自报 percent 是整轮口径，三段的区间并不相同（`env` 0-100、`graph` 0-36、`cluster` 36-54，来自 `stage_map.py` 的 `FSOFT_STAGE_WEIGHTS` × `CEILING`），所以按 `ENGINE_PCT` 表归一化，否则 `graph` 跑完只显示 36%。

顺带修两处：

- `stageFraction` 对 `prepare` 段也按 0..54 归一化。此前直接用引擎整体 percent / 100，准备跑完时这一段只填到 8.6%，总进度偏小一半。
- 分段带的触发条件从 `pct > 0` 改成 `hasLiveSegments(job)`。刚进 `graph` 时归一化后就是 0%，旧的判据会退回一条空的纯色条——恰恰把用户要看的「解析到第几个文件」藏起来。

`index.js` 新增 `job.nativeStageTimings`（按引擎阶段累加的真实耗时）与 `nativeStageAt`，并在 `jobSummary` 与 `codewiki_progress` 的 schema 里暴露。`stageTimings` 仍是面板粗粒度五段的口径，两者不混用。

验证：`test-engine-python-entry.mjs` 24 passed（新增解析进度断言）、`test-client-panel.mjs` 20 passed（新增「准备中按引擎子阶段展开三段」「离开准备段后不再展开」，含反向验证）、`test-engine-native-job.mjs` 142/142、`test-engine-apply-plan.mjs` 62、`test-batch.mjs` 117、`test-config.mjs`、`test-wiki-entry.mjs` 全过。

## 0.17.55 — 2026-11-06

### 删掉进度条右侧的迷你趋势线

0.17.35 起进度条右端有一条 48×14 的 SVG 折线，画的是最近 24 次轮询的 `overallPct`。本意是「数字告诉你在哪，斜率告诉你还动不动」，实际不成立：分段带已经把阶段、完成度、耗时全画出来了，多一条折线既重复又不解释任何东西；它的颜色用 `--dsw-alias-brand-primary`，这个变量在本机主题里映射到 `--dsw-static-neutral-bluish-1000` = `#0f1115`，画出来是一条黑线，看着像进度条末尾的残影。

删除范围：渲染块（`trendOf(job.id).length > 1 ? … el(Spark, …)`）、采样块（每轮 `pctTrendRef` 写入）、`pctTrendRef` / `trendOf` 定义、`[data-dscw-p-trend]` CSS、中英 `trendHint` 两条文案。`Spark` 组件保留——吞吐徽标（tok/s）还在用它。

---

更早版本（0.17.54 及以前）见 git log。
