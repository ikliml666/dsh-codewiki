#!/usr/bin/env python3
"""Python 入口脚本（artifact 类），验证 artifact 节点是否被采集。"""

from __future__ import annotations

import sys

from src.web.handler import Handler


def main(argv: list[str]) -> int:
    handler = Handler()
    print(handler.handle(" ".join(argv[1:]) or "ping"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
