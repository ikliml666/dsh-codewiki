"""Web 层：依赖 src/core/engine.py，用于验证依赖边是否被建出。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.engine import Engine, build_engine


class Handler:
    """把请求转交给引擎的薄壳。"""

    def __init__(self) -> None:
        self.engine: Engine = build_engine("web")

    def handle(self, payload: str) -> str:
        return self.engine.run(payload)
