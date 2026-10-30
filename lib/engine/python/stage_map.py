"""FSoft 五段进度 → 引擎八段契约的映射（纯函数，无副作用）。

为什么单独一个文件：这是 Node 与 Python 唯一共享的**枚举口径**。
契约里的 ``ENGINE_STAGES``（lib/engine/contract.js:21-30）是面板步骤条、
job.stage 与取消检查点的共同依据；FSoft 自己的 ``ProgressTracker`` 只有五段
（codewiki/cli/utils/progress.py:26-35）。两边一旦各自漂移，表现是
「面板显示在写作，实际已经在校验」——错得不响但很难查。

所以这里把映射固定成一张表，并由 test-engine-python-entry.mjs 反向断言
两边的集合完全一致：改一边不改另一边，测试立刻红。

注意 FSoft 只覆盖八段中的前四段：
    env      由 doctor 动作承担（不在生成流程里）
    index / baseline / commit  由 Node 侧后续执行（阶段 3-7）
因此进度上限刻意压在 90%，剩下的 10% 留给 Node 侧的收尾，
避免「引擎说 100% 但 wiki 还没索引/没提交」这种假完成。
"""

# 必须与 lib/engine/contract.js 的 ENGINE_STAGES 完全一致（测试双向对账）。
ENGINE_STAGES = [
    "env",
    "graph",
    "cluster",
    "articles",
    "validate",
    "index",
    "baseline",
    "commit",
]

# FSoft ProgressTracker.STAGE_NAMES / STAGE_WEIGHTS 的镜像。
# 权重与 FSoft 保持一致，否则整体进度条会在阶段交界处跳变。
FSOFT_STAGE_NAMES = {
    1: "Dependency Analysis",
    2: "Module Clustering",
    3: "Documentation Generation",
    4: "HTML Generation",
    5: "Finalization",
}
FSOFT_STAGE_WEIGHTS = {
    1: 0.40,
    2: 0.20,
    3: 0.30,
    4: 0.05,
    5: 0.05,
}

# 五段 → 四段（4/5 都落在 validate：HTML 我们不做，finalization 就是产物整理，
# 两者都属于「文章已写完、在收口」，报成 articles 会让面板一直显示在写作）。
FSOFT_TO_ENGINE = {
    1: "graph",
    2: "cluster",
    3: "articles",
    4: "validate",
    5: "validate",
}

# 未知阶段不抛错：进度上报是旁路，任何时刻都不该因为版本差异把编译打断。
# 归到 articles 是因为第 3 段是耗时最长、最需要让用户看见的阶段。
DEFAULT_ENGINE_STAGE = "articles"

# 引擎内部进度只占到 90%，见模块 docstring。
FSOFT_PROGRESS_CEILING = 90


def map_stage(fsoft_stage):
    """FSoft 阶段号 → 引擎契约阶段名。未知阶段归到 DEFAULT_ENGINE_STAGE。"""
    try:
        n = int(fsoft_stage)
    except (TypeError, ValueError):
        return DEFAULT_ENGINE_STAGE
    return FSOFT_TO_ENGINE.get(n, DEFAULT_ENGINE_STAGE)


def percent_of(fsoft_stage, stage_progress):
    """FSoft (阶段号, 阶段内进度 0..1) → 整体百分数 0..90。

    算法与 FSoft ``ProgressTracker.get_overall_progress`` 同构（已完成阶段权重
    之和 + 当前阶段权重×阶段内进度），只多乘一个 CEILING 并夹到 [0, 100]。
    自己再算一遍而不是调它的方法，是因为这里要在**不持有 tracker 实例**时
    也能算（测试与日志回放都要用），且必须夹紧非法输入。
    """
    try:
        n = int(fsoft_stage)
    except (TypeError, ValueError):
        return 0
    if n <= 0:
        return 0
    try:
        p = float(stage_progress)
    except (TypeError, ValueError):
        p = 0.0
    p = min(1.0, max(0.0, p))
    completed = sum(FSOFT_STAGE_WEIGHTS.get(s, 0.0) for s in range(1, n))
    current = FSOFT_STAGE_WEIGHTS.get(n, 0.0) * p
    value = round((completed + current) * FSOFT_PROGRESS_CEILING)
    return max(0, min(100, value))
