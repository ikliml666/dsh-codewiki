"""核心引擎：一个被 web 层依赖的 Python 模块（阶段 1A 依赖图 fixture）。"""

from __future__ import annotations


class Engine:
    """持有内部状态的最小引擎，供 web 层调用。"""

    def __init__(self, name: str) -> None:
        self.name = name
        self._calls = 0

    def run(self, payload: str) -> str:
        """执行一次任务并返回结果。"""
        self._calls += 1
        return f"{self.name}:{payload}"

    @property
    def calls(self) -> int:
        return self._calls


def build_engine(name: str = "default") -> Engine:
    """构造函数，web 层用它拿引擎。"""
    return Engine(name)
