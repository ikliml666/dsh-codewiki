"""模型通道空产出熔断（插件侧运行时补丁，不改第三方源码）。

## 要解决的问题

上游模型返回 200、却只给 usage + finish（无正文、无工具调用）时，pydantic-ai 会把它
当成「这一轮模型没说话」并按 ``max_output_retries``（默认 3）原地重试，每次重试都带
全量 message_history。真机 job-mw80h05t-2 的 #107–#158 是同一叶子连续 52 次请求、
inputTokens 恒为 74,817；#159–#185 是 27 次三空响应分散在多个叶子上。

两个放大器让这件事变成额度黑洞：

1. ``max_output_retries`` 是 **per-run** 的。同一上游故障轮到每个叶子，各烧满一份
   重试预算（3 次请求 + 每次 7 万输入 token），跨叶子不共享。
2. 引擎里到处是 ``except Exception``：``updater/orchestrator.py:425-427``、
   上游 ``leaf_agent.py:140-145``、``full_parallel_runtime.py`` 的 ``_run_module``、
   ``fsoft_runtime.py:220-222`` 的 ``isolated``。一个叶子失败只记一条 error 就继续下一个，
   于是同一故障被逐叶子重新烧一遍；``orchestrator.py:432-438`` 的 Step 6.1 还会对缺页
   再跑一遍 generate。

## 做法

在**所有 agent 调用的公共出口**——``Model.request``——数空产出：连续 N 次即置熔断位并
当场抛 :class:`ChannelBreakerTripped`。选这个位置而不是桥或 agent 循环，理由是：

* 计数在这里才跨叶子共享（进程内所有 ``PydanticAIBackend`` 共用同一个 breaker）；
* 停在**第 N 次**，而不是等 pydantic 重试到上限（N+1 次）再失败——止血更早；
* 熔断后每个后续调用在入口即抛，一分钱不花。

``ChannelBreakerTripped`` 必须是 ``BaseException`` 子类而不是 ``Exception``：上面那些
``except Exception`` 会把普通异常吞成「这页无需改动」，整轮照样报 done。只有非 Exception
才能穿过它们到达 ``entry.py`` 的 ``action_generate``，由那里翻成契约终态。

## 为什么 pydantic 的 import 全在 install() 里

本模块被 ``entry.py`` **顶层**导入（它的 except 子句需要一个稳定的异常类型），而
``entry.py`` 的 doctor 动作专门用来诊断「依赖缺失/损坏」的环境。顶层拉 pydantic-ai
会让「pydantic 装坏了」变成入口自己 ImportError 崩溃、Node 侧只能拿到 engine-crashed，
正好废掉 doctor 存在的意义。
"""

from __future__ import annotations

import sys

# 桥在熔断时回的 error.code（lib/engine/llm-bridge.js 的同一个契约）。
# HTTP 状态选 400 而不是 503：openai SDK 的 ``_should_retry`` 只对 408/409/429/>=500
# 返回 True（_base_client.py:843-863），400 是它唯一不重试的 4xx。503 落进 >=500 会被
# SDK 重试，又被 pydantic 归成 ModelUnavailableError 命中 fallback_on —— 三重放大。
BRIDGE_TRIP_CODE = "empty_response_breaker"

# 产出型 part 的 part_kind。用字符串而不是 isinstance：part 类在 pydantic-ai 各版本间
# 会改名/搬家（``NativeToolCallPart`` 就换过层），part_kind 是跨版本稳定的协议字段。
_PRODUCING_KINDS = frozenset({"text", "tool-call", "builtin-tool-call"})


class ChannelBreakerTripped(BaseException):
    """整轮终止信号：模型通道连续空产出已达阈值。

    继承 ``BaseException`` 是刻意的，见模块 docstring：引擎里把所有失败吞成 no-op 的
    位置写的都是 ``except Exception``。
    """


def _produced(response) -> bool:
    """这一轮模型是否真的产出了东西（正文或工具调用）。

    只吃 reasoning 的响应算空：它既不能让引擎写文章，也已经计过费，正是要熔断的那种。
    """
    for part in response.parts:
        if part.part_kind in _PRODUCING_KINDS:
            # 空字符串的 TextPart 不携带任何文本，pydantic 自己也把它判成「无输出」。
            if part.part_kind == "text" and not part.content:
                continue
            return True
    return False


class ChannelBreaker:
    """进程级空产出压力计数。空产出 +1，有产出 -1（下限 0），到阈值即熔断。

    为什么不是「有产出即清零」：并行写作时（moduleConcurrency>1）一个叶子坏掉、
    其他叶子还在正常写，健康流量会不断把故障叶子的空产出计数冲回 0，熔断永远不
    触发——实测 A 连空 6 次、B 正常 6 次交替时 max_streak 只有 2。衰减语义下，
    空产出与正常产出 1:1 交替时计数原地踏步，故障占比过半就持续上涨直到熔断；
    而通道真的恢复（持续有产出）时计数照样归零，不会把已经好转的上游误判成故障。
    """

    def __init__(self, limit: int):
        self.limit = limit
        self.streak = 0
        self.max_streak = 0
        self.tripped = False
        self.empty_total = 0
        self.call_total = 0

    def trip(self, reason: str):
        """置熔断位并抛 :class:`ChannelBreakerTripped`。桥侧先熔断时也走这里。"""
        self.tripped = True
        raise ChannelBreakerTripped(reason)

    def note(self, produced: bool) -> None:
        """记一次调用结果。熔断那一刻抛 :class:`ChannelBreakerTripped`。"""
        if self.tripped:
            raise ChannelBreakerTripped(
                f"模型通道已熔断（空产出压力峰值 {self.max_streak}），本轮不再向上游发请求"
            )
        self.call_total += 1
        if produced:
            self.streak = max(0, self.streak - 1)
            return
        self.empty_total += 1
        self.streak += 1
        if self.streak > self.max_streak:
            self.max_streak = self.streak
        if self.limit > 0 and self.streak >= self.limit:
            self.trip(
                f"模型通道空产出压力达 {self.streak}（累计 {self.empty_total}/{self.call_total} 次调用无正文、无工具调用），"
                f"已中止本轮：后续请求不再转发上游，已写文章照常落盘"
            )


def install(empty_streak_limit) -> ChannelBreaker:
    """装上熔断，返回本轮 breaker。

    ``empty_streak_limit`` 由 Node 侧下发（与桥同一个配置项、同源同值），0 = 关闭熔断。
    没有缺省值可退：native-run 恒下发它（none 时也是 3），传不进来就是协议对不上，
    这里让 ``int(None)`` 当场抛，而不是悄悄用一个和桥不同的阈值。

    在任何 PydanticAIBackend 实例化**之前**调用：模型对象在
    ``PydanticAIBackend.__init__`` 里就由 ``create_fallback_models`` 建好
    （pydantic_ai_backend.py:67），晚于此刻的 patch 对已建对象无效。
    """
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.wrapper import WrapperModel

    from codewiki.src.be import llm_services
    from codewiki.src.be.api_usage import UsageModel
    from codewiki.src.be.llm_services import create_main_model

    limit = int(empty_streak_limit)

    # 进程内唯一的熔断器。多个 PydanticAIBackend 实例（写作 agent、子模块 agent）共用它，
    # 这正是「跨叶子共享空产出预算」的实现方式——pydantic 的 max_output_retries 是
    # per-run 的，跨叶子不共享，同一故障会让每个叶子各烧满一份。
    breaker = ChannelBreaker(limit)

    class GuardedModel(WrapperModel):
        """在模型调用出口做空产出熔断。

        包在 ``UsageModel`` 外层而不是替换它：逐请求记账（api_usage.py 的 UsageModel）
        必须照旧生效，本轮已花的 token 仍然进得了账本。

        只覆盖非流式路径：引擎全部走 ``agent.run()``，pydantic 只在有事件流消费者时才
        改走 ``request_stream``，而引擎没有任何 ``event_stream_handler`` / ``.iter()``。
        """

        def __init__(self, wrapped):
            super().__init__(wrapped)

        async def request(self, messages, model_settings, model_request_parameters):
            # 熔断后在入口就停：这一次请求一个 token 都不发给上游。
            if breaker.tripped:
                breaker.note(False)
            try:
                response = await self.wrapped.request(messages, model_settings, model_request_parameters)
            except ModelHTTPError as exc:
                # 桥先到阈值时由桥拒绝（它比引擎更早知道上游连续空返回）。把那条失败
                # 升级成本进程的熔断，否则引擎会把它当普通 APIError 逐叶子继续撞。
                if exc.provider_error_code == BRIDGE_TRIP_CODE:
                    breaker.trip(f"模型通道已熔断（桥侧判定）：{exc.message}")
                raise
            breaker.note(_produced(response))
            return response

    def factory(config):
        """替换 ``codewiki.src.be.llm_services.create_fallback_models``。

        **不再包 FallbackModel。** 上游的实现是
        ``FallbackModel(main, fallback, fallback_on=(ModelAPIError, UnexpectedModelBehavior))``，
        而本插件恒把 ``fallback_model`` 设成 ``main_model``（entry.py 的
        ``_model_config``）——主模型空响应重试到上限抛 ``UnexpectedModelBehavior``，
        命中 fallback_on，于是切到**同一个模型、同一条桥、同一个上游**再烧一遍。
        零容错意义，纯双倍成本。

        非同源 fallback 断言掉而不是随手支持：真有第二个模型时，它必须也被熔断层包住
        （否则熔断信息在 fallback 内部丢失），那是另一份设计。当前恒同源，写成崩溃
        比写成一条永远不执行的分支诚实。
        """
        if config.fallback_model != config.main_model:
            raise RuntimeError(
                f"fallback_model({config.fallback_model}) 与 main_model({config.main_model}) 不同："
                "本插件的模型通道只有一条上游，非同源 fallback 的熔断语义未定义，拒绝启动"
            )
        return GuardedModel(UsageModel(create_main_model(config), config.main_model))

    # 必须遍历 sys.modules 而不是只改 llm_services：``from X import f`` 在导入时就复制了
    # 引用，``pydantic_ai_backend.py:30`` 与
    # ``agent_tools/generate_sub_module_documentations.py:10`` 都这么导的——只改定义处，
    # 这两处调用点仍会走未熔断的旧函数。所有持有同一函数对象的模块一起换掉。
    original = llm_services.create_fallback_models
    patched = []
    for module in list(sys.modules.values()):
        if module is None:
            continue
        if getattr(module, "create_fallback_models", None) is original:
            setattr(module, "create_fallback_models", factory)
            patched.append(getattr(module, "__name__", "?"))
    if not patched:
        raise RuntimeError(
            "未找到 codewiki.src.be.llm_services.create_fallback_models 的任何绑定；"
            "引擎版本可能已改变模型工厂的导出方式，熔断补丁未生效，拒绝静默继续"
        )
    return breaker
