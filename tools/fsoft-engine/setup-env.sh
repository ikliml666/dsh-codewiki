#!/usr/bin/env bash
# 阶段 1A：在**独立**目录里造一个可信的 FSoft 原生引擎运行环境。
#
# 为什么要有这个脚本：FSoft 的依赖树里 openai / pydantic-ai-slim / pydantic 的
# 版本约束互相打架，用 `pip install -r freeze.txt` 走**正常解析**必然
# ResolutionImpossible（实测报错：Cannot install ... pydantic-ai-slim==2.61.0 and
# pydantic-ai-slim[anthropic,cli,evals,google,logfire,mcp,openai,web]==2.61.0
# because these package versions have conflicting dependencies）。
# 冻结清单本身是一个**已解析完成的完整环境快照**，所以这里不重解析，直接按快照落盘：
#   1. `--no-deps` 全量安装冻结清单（等价于精确复制已验证的环境组合）；
#   2. `pip check` 反向验证依赖闭合（--no-deps 装出来的环境靠这步兜底）；
#   3. import 冒烟，任何一步非零立刻退出。
# 加约束文件是防止清单里某些未钉死的间接依赖被 pip 升级跑偏。
#
# 用法：bash tools/fsoft-engine/setup-env.sh <目标目录> <FSoft 源码根> [python 可执行文件]
#   例：bash tools/fsoft-engine/setup-env.sh ../.probe-fsoft/venv ../.probe-fsoft/src
#
# 注意：本脚本只在插件仓库**之外**建环境，不把 venv 提进 git，也不碰 DSH 进程的 Python。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?用法: setup-env.sh <目标目录> <FSoft 源码根> [python]}"
FSOFT_SRC="${2:?用法: setup-env.sh <目标目录> <FSoft 源码根> [python]}"
PY="${3:-python}"

if [ ! -d "$FSOFT_SRC/codewiki" ]; then
  echo "[1A] FSoft 源码根下没有 codewiki/ 包：$FSOFT_SRC" >&2
  exit 1
fi

LOCKED="$HERE/locked-requirements.txt"
CONSTRAINTS="$HERE/constraints.txt"

if [ ! -f "$LOCKED" ]; then
  echo "[1A] 缺少 $LOCKED" >&2
  exit 1
fi

echo "[1A] python: $PY"
"$PY" -c 'import sys; print("[1A] version:", sys.version)'

if [ ! -d "$TARGET" ]; then
  echo "[1A] 创建 venv: $TARGET"
  "$PY" -m venv "$TARGET"
fi

if [ -x "$TARGET/bin/python" ]; then
  VPY="$TARGET/bin/python"
else
  VPY="$TARGET/Scripts/python.exe"
fi
echo "[1A] venv python: $VPY"

# --- 1. 按冻结快照落盘（不重解析，避免必然的 ResolutionImpossible） ---
echo "[1A] step1: --no-deps 安装冻结快照"
"$VPY" -m pip install --disable-pip-version-check -q --no-deps   -c "$CONSTRAINTS" -r "$LOCKED"

# --- 2. 引擎本体以 editable 装进环境 ---
# 冻结快照（pip freeze）里不会出现 codewiki 自己：它是 editable 安装，
# 在 freeze 中只体现为依赖清单。所以必须显式装一次源码。
echo "[1A] step2: editable 安装 FSoft 引擎本体 <- $FSOFT_SRC"
"$VPY" -m pip install --disable-pip-version-check -q --no-deps -e "$FSOFT_SRC"

# --- 3. 验收：依赖闭合 + 可导入 ---
echo "[1A] step3: pip check"
"$VPY" -m pip check

echo "[1A] step4: import 冒烟"
"$VPY" - <<'PY'
import importlib
mods = ["codewiki", "openai", "pydantic", "tree_sitter", "litellm", "tiktoken"]
for m in mods:
    importlib.import_module(m)
    print("[1A] import ok:", m)
PY

echo "[1A] 完成：环境在 $TARGET"
