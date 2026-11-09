"""历史压缩：把 agentic 循环里早期的整篇文件读替换成占位符。

## 为什么需要它

真机实测（job-mw8s9um1-4，单次增量编译）：110 次模型请求共 1,039 万输入 token，
其中 65.7% 是工具返回的整篇文件内容。模型在 #2–#7 把 16 篇文档整篇读进历史，
之后每一条请求都把全部 16 篇重发一遍，一直背到第 110 次。

这不是故障，是上游设计与框架默认行为的叠加：
  · 上游 prompt 的 WRITE_SET 只给页面路径、不给内容 → 模型必须自己读
  · pydantic-ai 的 agentic 循环默认保留完整历史 → 读过的一直在

## 为什么这样裁（三个成熟项目的实证）

- **SWE-agent** 的 `LastNObservations`（论文默认 n=5）：保留最近 n 个 observation，
  其余替换成 `Old environment output: (n lines omitted)`。与本模块最贴近——同样是
  「读文件→改→再读」的循环。它的源码注释明确警告会破坏 prompt cache。
- **Claude Code** 的第一级压缩：清掉旧工具结果、只留最近 5 个，占位符带行数。
- **OpenHands** 的 `keep_first`：保护开头的 system 与任务定义，永不压缩。

取 SWE-agent 的策略 + Claude Code 的「占位符带行数」+ OpenHands 的「保护开头」。

## 缓存顾虑在本项目不成立

SWE-agent 警告裁剪会破坏 prompt cache（历史每轮都变 → 缓存全失效）。
本项目实测不适用：上游给消息加的 `cache_control` 标记在桥的 `contentToBlocks`
（lib/engine/openai-bridge.js:35-48）里只取 `type === 'text'`，标记被丢弃；
110 次请求零缓存命中（会话记录 `cachedTokens` 全为空）。裁剪没有缓存代价。

## 裁什么、不裁什么

只裁**整篇读**（`str_replace_editor` 的 `view` 不带 `view_range`，返回整篇 `cat -n`）。
行段读（带 `view_range`）是模型的精准定位手段，裁掉会让它失去工作依据——真机
46 次行段读 vs 24 次整篇读，前者才是它实际依赖的。

实测依据：16 篇被整篇读入的文档里，**10 篇读入后再未被任何 view_range 访问**，
它们纯粹占着历史；只有 6 篇后续被精查过。
"""

from __future__ import annotations

import re

from pydantic_ai.messages import ModelRequest, ModelResponse, ToolReturnPart

# 整篇读的返回形态（str_replace_editor 的 view 不带 view_range）。
# `cat -n` 输出形如 `     1\t# 标题`，行号右对齐 + 空格 + 制表符。
_FULL_READ = re.compile(r"Here's the result of running `cat -n` on ([^:\n]+):")
_LINE_NO = re.compile(r"^\s*(\d+)\t", re.MULTILINE)

# 判据是**行数**而不是字符数。真机上整篇读的页面 100–800 行，而字符数受语言影响极大：
# 中文行很短，200 行只有约 2900 字符；英文行能到 12000+。按字符数卡阈值会漏掉中文页面
# （实测教训：用 4000 字符做阈值，200 行的中文测试数据判成「不是整篇读」）。
# 行段读（带 view_range）通常在 100 行以内，按行数能干净分开。
_MIN_LINES = 80

# 开头的多少个 ModelRequest 不参与压缩。第 0 个是 system 提示词，第 1 个是任务定义
# （WRITE_SET / CHANGE_REPORT）——裁掉它们模型就不知道要改哪些页面了。
_PROTECTED_PREFIX = 2


def _line_count(text: str) -> int:
    """整篇读返回里的总行数，用于占位符里报告「省略了多少行」。"""
    return len(_LINE_NO.findall(text))


def _is_full_read(part: object) -> bool:
    if not isinstance(part, ToolReturnPart):
        return False
    content = part.content
    if not isinstance(content, str):
        return False
    if not _FULL_READ.search(content):
        return False
    return _line_count(content) >= _MIN_LINES


def _placeholder(part: ToolReturnPart) -> str:
    content = str(part.content)
    m = _FULL_READ.search(content)
    page = m.group(1).strip() if m else "?"
    lines = _line_count(content)
    return (
        f"Old environment output for {page}: ({lines} lines omitted). "
        f"Use str_replace_editor with command=view and view_range to re-read "
        f"the specific lines you need; do not view the whole file again."
    )


def compact_messages(
    messages: list[ModelRequest | ModelResponse],
    keep_recent: int,
) -> tuple[list[ModelRequest | ModelResponse], int]:
    """把早期的整篇读替换成占位符，保留最近 ``keep_recent`` 次。

    返回 (新消息列表, 被替换的块数)。``keep_recent`` 为 0 时全部替换。
    原始消息对象不被修改——pydantic-ai 的 message_history 在本次 run 之后还要
    继续用（下一次 run 会带完整历史），原地改会让「压缩」变成「永久丢失」。
    """
    if keep_recent < 0:
        raise ValueError(f"keep_recent 不能为负：{keep_recent}")

    # 先定位所有整篇读的 (消息索引, part 索引)，再按「从后往前保留」决定裁哪些
    positions: list[tuple[int, int]] = []
    for i, msg in enumerate(messages):
        if i < _PROTECTED_PREFIX:
            continue
        if not isinstance(msg, ModelRequest):
            continue
        for j, part in enumerate(msg.parts):
            if _is_full_read(part):
                positions.append((i, j))

    if not positions:
        return messages, 0

    keep_from = max(0, len(positions) - keep_recent)
    drop = set(positions[:keep_from])
    if not drop:
        return messages, 0

    out: list[ModelRequest | ModelResponse] = []
    for i, msg in enumerate(messages):
        if not isinstance(msg, ModelRequest) or not any(i == di for di, _ in drop):
            out.append(msg)
            continue
        new_parts = []
        for j, part in enumerate(msg.parts):
            if (i, j) in drop:
                # ToolReturnPart 是 dataclass，用 dataclasses.replace 保持其余字段
                new_parts.append(_replace_content(part, _placeholder(part)))
            else:
                new_parts.append(part)
        out.append(ModelRequest(parts=new_parts, timestamp=msg.timestamp,
                                instructions=msg.instructions, run_id=msg.run_id))
    return out, len(drop)


def _replace_content(part: ToolReturnPart, content: str) -> ToolReturnPart:
    import dataclasses

    return dataclasses.replace(part, content=content)
