#!/usr/bin/env python3
"""FSoft 原生引擎的 JSON-lines 薄入口（阶段 2）。

**这不是算法实现。** 依赖图、聚类、文章写作、增量 diff 全部由 FSoft 自己做
（``CLIDocumentationGenerator``）。本文件只负责四件事：

1. 把 stdin 的一行 JSON 变成一次 FSoft 调用（doctor / generate / update / cancel）；
2. 把 FSoft 的五段进度翻译成引擎八段契约（stage_map.py），以 JSON 行推给 Node；
3. 把成功/失败/取消翻译成 ``EngineResult``（lib/engine/contract.js 的同一份语义）；
4. 守住两条红线：**不读本机凭证库**、**不让 FSoft 的打印污染协议流**。

## 为什么 stdout 一开始就被接管

FSoft 大量使用 ``print`` / ``click.secho`` / ``print_banner`` 往 stdout 写人类文案
（``codewiki/cli/utils/branding.py``、``codewiki/cli/commands/generate.py:544``）。
而 click 会**缓存** text stdout 包装器（click 8.5 的 ``_default_text_stdout`` 里带
cache），所以「事后替换 sys.stdout」并不能拦住已经缓存的引用。

因此本入口在**导入任何 codewiki 模块之前**就把 ``sys.stdout`` 换成一个只允许协议
写出的守卫对象：普通 ``write`` 全部改道 stderr（变成日志），协议行走保存下来的
真实 stdout 句柄。这样即使 FSoft 内部某处打印，也污染不到协议流。

## 为什么不用 ConfigManager

``ConfigManager`` 会去读 ``~/.codewiki/config.json`` 或系统 keyring
（``codewiki/cli/config_manager.py:34-70``）。迁移后模型通道由 Node 侧的
loopback 桥注入（lib/engine/llm-bridge.js），密钥只存在于**进程环境变量**里，
不需要、也不允许落盘。所以这里直接构造 config dict 交给 adapter，
绕开 ConfigManager 的整套凭证解析。

## 退出码

进程退出码只表达**进程层**结果，语义以最后那条 ``result`` 行为准
（与 lib/engine/client.js 的约定一致）。协议破坏用 0 退出 + failed result 表达，
让 Node 侧能拿到结构化的失败原因而不是一句「exit 1」。
"""

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

# ── 协议流守卫：必须在 import codewiki 之前装好 ──────────────────────────────

_REAL_STDOUT = sys.stdout
# 心跳线程与主线程并发写协议行，必须整行串行（见 emit 的说明）。
_EMIT_LOCK = threading.Lock()

# Windows 下 Python 的 **stdin/stdout** 默认按 locale 编码（cp936），而 Node 侧一律按
# UTF-8 收发协议行。不先改编码：
#   · stdout：中文错误信息过管道就是乱码，排障时完全不可读；
#   · stdin：中文路径的请求行被按 cp936 误解码，repoPath 变成「涓?鏂? 绌烘牸」这种
#     乱码串，入口随即报「仓库路径不存在」——而这份乱码只出现在非 ASCII 路径上，
#     ASCII 路径永远复现不出来。
# 注意 stdin 这一半不能靠外部 PYTHONUTF8/PYTHONIOENCODING 兜底：那种兜底只在
# nativeEnginePlan 派生的进程里成立，任何直接调入口的调用方（测试、诊断脚本、
# 别处的集成）都会踩到。入口自己把三条流都钉成 UTF-8，才算边界自洽。
# 写法上 stdout/stderr 用 replace（宁可读得到、不要因为一个坏字节中断协议行），
# stdin 用默认的 strict——请求行非法字节应当当场报错，而不是被替换成乱码路径
# 后继续往下走（静默变乱码正是上面那个 bug 的教训）。
for _stream in (_REAL_STDOUT, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — 非 TextIOWrapper（被重定向）时忽略即可
        pass
try:
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 — 同上
    pass

# 同一个 locale 陷阱还有第三条流水位：**子进程的 text 模式**。
# FSoft 内部（如 dependency_analyzer/analysis/repo_analyzer.py:51）用
# `subprocess.run(..., text=True)` 读 `git rev-parse --show-toplevel`，text=True 在
# Windows 上按 locale（gbk）解码 stdout；仓库路径含中文时 git 回的是 UTF-8 字节，
# reader 线程抛 UnicodeDecodeError → `result.stdout` 变成 None → 上游
# `Path(None.strip())` 直接 AttributeError，整轮编译以「引擎内部错误」失败。
# 里层的 FSoft 代码我们不改（vendor 锁版本），所以在这里给它的子进程兜底：
# 用 ``io.text_encoding`` 决定什么编码（frozen 后无法只改局部），改用最外层可控的
# ``PYTHONUTF8`` 语义——直接设环境变量管不到已启动进程，因此改为给 ``subprocess``
# 的 Popen 打一个默认编码补丁：调用方没显式给 encoding 的 text 调用一律走 UTF-8。
_real_popen_init = subprocess.Popen.__init__


def _popen_init_utf8(self, *args, **kwargs):
    # 只补 text 模式（tt/text=True 且未显式指定 encoding/errors）——二进制调用
    # 保持原样，否则会把 bytes 改成 str，反而破坏别人。
    text_mode = kwargs.get("text") is True or kwargs.get("universal_newlines") is True
    if text_mode and not kwargs.get("encoding") and not kwargs.get("errors"):
        kwargs["encoding"] = "utf-8"
        kwargs["errors"] = "replace"
    return _real_popen_init(self, *args, **kwargs)


subprocess.Popen.__init__ = _popen_init_utf8


class _ProtocolOnly:
    """sys.stdout 的替身：只允许本入口的协议写出走真 stdout，其余一律改道 stderr。

    为什么连 ``flush`` 也要转：FSoft 的进度条会 flush，若 flush 打到真 stdout
    就会把半行日志挤进协议流中间。
    """

    def write(self, text):
        if text:
            try:
                sys.stderr.write(text)
            except Exception:
                pass
        return len(text or "")

    def flush(self):
        try:
            sys.stderr.flush()
        except Exception:
            pass

    def isatty(self):
        return False

    def fileno(self):
        # 有些库会拿 fileno 去判断是否终端；给它 stderr 的句柄，避免抛错。
        return sys.stderr.fileno()

    @property
    def encoding(self):
        return "utf-8"


sys.stdout = _ProtocolOnly()

PROTOCOL_VERSION = 1
# 引擎结果契约版本，必须与 lib/engine/contract.js 的 ENGINE_CONTRACT_VERSION 同步。
# 为什么单独抽常量：此前 5 处字面量 `1` 散在 emit_progress / failure / doctor /
# _done_result / _cancelled_result 里，升版本时漏改一处就会出现「同一进程报两个
# 契约版本」，client.js 的 validateEngineResult 只在测试里跑，真机上没人拦。
CONTRACT_VERSION = 2
ACTIONS = ("doctor", "generate", "update", "cancel")

# 进度帧里 writtenCount 的重新清点间隔（秒）。
#
# 为什么要节流：writtenCount 靠递归遍历 docsDir 算（_doc_fingerprints），而 FSoft 的
# 进度条一秒可能调好几次 update_stage。真机上 docs 有数百篇时，不节流的每次遍历会
# 把 45 分钟的编译预算啃掉一块。阶段切换/阶段完成走 force=True 必算（那是超时判
# partial 的关键帧），普通 update 按这个间隔算。
_WRITTEN_RECOUNT_SEC = 2.0

# 心跳间隔：长时间无进度帧的阶段（FSoft 阶段 3 就是典型）由桥接层定时补帧，
# 让 Node 侧能区分「慢」与「僵死」。取值必须显著小于 Node 侧的僵死判定阈值
# （lib/engine/client.js 的 silenceMs 默认 10 分钟），否则心跳自己会被判成卡死。
_HEARTBEAT_SEC = 60.0

# 模型通道的环境变量名。Node 侧桥注入，密钥只活在进程环境里。
ENV_BASE_URL = "CODEWIKI_BASE_URL"
ENV_API_KEY = "CODEWIKI_API_KEY"
ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"
ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"


def emit(obj):
    """写一行协议 JSON 到真 stdout。所有协议消息都必须经这里。

    心跳线程与主线程会并发写同一个流：协议行必须整行落盘，不能被另一次
    ``write`` 切进中间（半行 JSON 会让 Node 侧解析器丢帧，进度就此断掉）。
    GIL 只保证单次 ``write`` 调用本身不交错，而 stdin/stdout 是文本缓冲流，
    一次 write 可能被拆成多次底层写入，所以这里显式串行化。
    """
    line = json.dumps(obj, ensure_ascii=False)
    with _EMIT_LOCK:
        _REAL_STDOUT.write(line + "\n")
        _REAL_STDOUT.flush()


def emit_hello():
    emit({"type": "hello", "protocolVersion": PROTOCOL_VERSION, "engine": "fsoft-native"})


def emit_progress(request_id, stage, percent, message="", written=0, failed=0, total=0):
    emit(
        {
            "type": "progress",
            "requestId": request_id,
            "contractVersion": CONTRACT_VERSION,
            "stage": stage,
            "percent": percent,
            "message": message,
            "writtenCount": written,
            "failedCount": failed,
            "totalCount": total,
        }
    )


# ── 引擎细节探针：把「已写 3 篇」补成「正在写 lib/engine/client.js」 ─────────
#
# 为什么需要它：FSoft 以 verbose=False 运行时会把 `codewiki.src.be` 的 logger
# 压到 WARNING（.probe-fsoft/src/codewiki/cli/adapters/doc_generator.py:96-120），
# 于是逐模块日志（documentation_generator.py:293 的
# "📄 Processing leaf module: X"、:302 的 "📁 Processing parent module: X"）
# 全被吞掉。阶段 3 里桥接层于是只知道「已写 N 篇」，不知道「在写哪一篇」——真机
# 上一次编译能卡在单个模块上几十分钟，这个信息量不足以区分「在推进」与「死了」。
#
# 做法刻意保持旁路：不改 FSoft 源码（vendor 锁版本），只在自己进程里把那个
# logger 临时降到 INFO 并挂一个只读 handler，从日志文本里抽当前模块名。
# handler 里任何异常都被吞掉——观测失败绝不能弄崩编译。
_DETAIL = {"module": "", "phase": "", "at": 0.0}

# 逐模块日志的文本形态。emoji 前缀不参与匹配：cp936 控制台下非 ASCII 文本
# 直接 print 会抛 UnicodeEncodeError，所以正则只吃 ASCII 部分。
#
# 分两族：
# - 阶段 3（documentation_generator.py）：每个模块一条，直接给模块名。
# - 阶段 2（cluster_modules.py）：不逐模块打印，而是围绕当前处理的子树发
#   "Module clustering input for <label>: ..." 这类消息，label 就是子树名
#   （顶层时是 "repository"，见 cluster_modules.py:290）。
#   阶段 2 在真机上能跑十几分钟，只报「阶段 2，已写 0 篇」等于没有信息。
_DETAIL_PATTERNS = (
    (re.compile(r"Processing leaf module:\s*(\S.*?)\s*$"), "leaf"),
    (re.compile(r"Processing parent module:\s*(\S.*?)\s*$"), "parent"),
    (re.compile(r"Generating parent documentation for:\s*(\S.*?)\s*$"), "parent"),
    (re.compile(r"Generating repository overview"), "overview"),
    # 阶段 2：把正在聚类/跳过的子树当成「当前模块」。顺序要紧——越接近
    # 「现在正在做什么」的越靠前。
    (re.compile(r"Requesting LLM module clustering for (.+?) because"), "cluster"),
    (re.compile(r"Module clustering input for (.+?):"), "cluster"),
    (re.compile(r"Partitioned \d+ leaf nodes for (.+?) into"), "cluster"),
    (re.compile(r"LLM module clustering for (.+?) produced"), "cluster"),
    (re.compile(r"Skipping LLM module clustering for (.+?) because"), "cluster"),
    (re.compile(r"Skipping LLM clustering result for (.+?) because"), "cluster"),
    (re.compile(r"Requesting super-grouping of \d+ top-level modules"), "super-group"),
    (re.compile(r"Super-grouping consolidated \d+ top-level modules"), "super-group"),
)

# 模块名在面板上不能挤爆，超长截断。
_DETAIL_MAX_LEN = 80


class _DetailHandler(logging.Handler):
    """只读旁路 handler：从日志抽出当前模块名，绝不改变日志本身的行为。"""

    def emit(self, record):
        try:
            message = record.getMessage()
            for pattern, phase in _DETAIL_PATTERNS:
                match = pattern.search(message)
                if not match:
                    continue
                _DETAIL["phase"] = phase
                if phase == "overview":
                    # 「生成仓库总览」这一步没有模块名，但它是阶段 3 最后一个大块，
                    # 面板上必须能看见，否则这十几分钟又是一片空白。
                    _DETAIL["module"] = ""
                else:
                    _DETAIL["module"] = (match.group(1) if match.groups() else "").strip()
                _DETAIL["at"] = time.time()
                return
        except Exception:  # noqa: BLE001 — 观测失败绝不能弄崩编译
            return


def attach_detail_tap():
    """临时把 `codewiki.src.be` 降到 INFO 并挂只读 handler。

    返回一个句柄供 `release_detail_tap` 还原；拿不到 logger 时返回 None。

    为什么不直接把 level 一降了事：FSoft 自己在 `doc_generator.py:96-120` 挂了
    StreamHandler(sys.stderr)，verbose=False 时靠「logger level = WARNING」挡住
    INFO。一旦我们只降 logger level，这条 INFO 就会灌进 stderr，被
    `lib/engine/client.js` 当 stderr tail 收走，噪音暴涨。所以这里同时把已有
    handler 的 level 提到 WARNING，让 INFO 只走我们这个只读 handler。
    """
    try:
        logger_obj = logging.getLogger("codewiki.src.be")
        handler = _DetailHandler()
        handler.setLevel(logging.INFO)
        silenced = []
        for existing in logger_obj.handlers:
            # 只压那些会放行 INFO 的 handler；本来就是 WARNING 以上就别动。
            if existing.level <= logging.INFO:
                silenced.append((existing, existing.level))
                existing.setLevel(logging.WARNING)
        previous = logger_obj.level
        logger_obj.addHandler(handler)
        logger_obj.setLevel(logging.INFO)
        _DETAIL["module"] = ""
        _DETAIL["phase"] = ""
        return {
            "logger": logger_obj,
            "handler": handler,
            "level": previous,
            "silenced": silenced,
        }
    except Exception:  # noqa: BLE001
        return None


def release_detail_tap(tap):
    """摘掉 handler 并还原所有 level，避免污染后续请求。"""
    if not tap:
        return
    try:
        tap["logger"].removeHandler(tap["handler"])
        tap["logger"].setLevel(tap["level"])
        for existing, level in tap["silenced"]:
            existing.setLevel(level)
    except Exception:  # noqa: BLE001
        return
    finally:
        _DETAIL["module"] = ""
        _DETAIL["phase"] = ""


def detail_suffix():
    """当前正在处理的模块名，拼进进度帧 message；没有就返回空串。

    措辞按阶段分开：阶段 3 是真在写文章（「正在写 X」），阶段 2 是在聚类
    （「正在聚类 X」）。混用会让人以为阶段 2 已经在产出文章，反而更误导。
    """
    try:
        module = _DETAIL["module"]
        phase = _DETAIL["phase"]
        if not module:
            if phase == "overview":
                return "，正在生成仓库总览"
            if phase == "super-group":
                return "，正在做子系统归并"
            return ""
        if len(module) > _DETAIL_MAX_LEN:
            module = module[: _DETAIL_MAX_LEN - 3] + "..."
        if phase == "cluster":
            return f"，正在聚类 {module}"
        if phase == "super-group":
            return f"，正在归并 {module}"
        return f"，正在写 {module}"
    except Exception:  # noqa: BLE001
        return ""


def emit_result(request_id, result):
    emit({"type": "result", "requestId": request_id, "result": result})


def failure(code, message, stage=None, request_id=""):
    """构造一个 failed 终态。message 只放给人看的说明，绝不拼凭证内容。"""
    return {
        "contractVersion": CONTRACT_VERSION,
        "outcome": "failed",
        "stage": stage,
        "blockers": [],
        "error": {"code": code, "message": str(message)[:4000], "stage": stage},
        "writtenCount": 0,
        "failedCount": 0,
        "keptCount": 0,
        "removedCount": 0,
        "unmappedCount": 0,
        "usage": {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0},
        "engine": {"version": "", "commit": "", "python": ""},
        "artifacts": {"docsDir": "", "rawTreeDir": "", "updateRecord": ""},
        "startedAt": None,
        "finishedAt": None,
    }


# ── doctor：环境可信性 ───────────────────────────────────────────────────────


def _engine_version():
    try:
        import codewiki

        v = getattr(codewiki, "__version__", "") or ""
        if v:
            return str(v)
    except Exception:
        pass
    try:
        from importlib.metadata import version

        return version("codewiki")
    except Exception:
        return ""


def _pip_check(timeout=120):
    """跑一次 pip check，返回 (ok, 输出摘要)。

    这是 1A 那条门禁的运行时版本：装到一半的 venv 会让 FSoft 在**生成中途**
    才因为缺包崩掉，代价是一整轮模型调用白烧。所以先问清楚。
    """
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "check"],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as exc:  # noqa: BLE001 — 探测失败要如实上报而不是吞掉
        return False, f"pip check 无法执行：{exc}"
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    ok = proc.returncode == 0
    return ok, out[:2000]


def action_doctor(request_id, payload):
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    emit_progress(request_id, "env", 5, "探测引擎版本与依赖")
    version = _engine_version()
    py = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if not version:
        result = failure("engine-missing", "无法导入 codewiki：解释器里没有安装 FSoft 引擎", "env", request_id)
        result["checks"] = [
            {"name": "import", "ok": False, "detail": "解释器里没有安装 FSoft 引擎"},
            {"name": "python", "ok": True, "detail": py},
        ]
        return result
    ok, check_out = _pip_check()
    emit_progress(request_id, "env", 100, "依赖检查完成" if ok else "依赖未闭合")
    if not ok:
        result = failure("engine-deps", check_out, "env", request_id)
        result["checks"] = [
            {"name": "import", "ok": True, "detail": f"codewiki {version} 可导入"},
            {"name": "python", "ok": True, "detail": py},
            {"name": "pip", "ok": False, "detail": check_out},
        ]
        result["engine"] = {
            "version": version,
            "commit": "",
            "python": py,
            "deps": {"ok": False, "summary": check_out},
        }
        return result
    return {
        "contractVersion": CONTRACT_VERSION,
        "outcome": "done",
        "stage": "env",
        "blockers": [],
        "checks": [
            {"name": "import", "ok": True, "detail": f"codewiki {version} 可导入"},
            {"name": "python", "ok": True, "detail": py},
            {"name": "pip", "ok": True, "detail": check_out or "No broken requirements found."},
        ],
        "error": None,
        "writtenCount": 0,
        "failedCount": 0,
        "keptCount": 0,
        "removedCount": 0,
        "unmappedCount": 0,
        "usage": {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0},
        "engine": {
            "version": version,
            "commit": "",
            "python": py,
            "deps": {"ok": True, "summary": check_out or "No broken requirements found."},
        },
        "artifacts": {"docsDir": "", "rawTreeDir": "", "updateRecord": ""},
        "startedAt": started,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


# ── 源码分析面 ──────────────────────────────────────────────────────────────

# 本插件自己的 wiki 产物：每轮编译都会改写它们，所以**不能**被当成源码。
WIKI_PRODUCT_PATTERNS = (".codewiki", "CodeWiki.md")


def dangling_gitlink_patterns(repo_path):
    """找出「被提交进索引、但没有 .gitmodules 登记」的嵌套仓库（孤立 gitlink）。

    为什么必须排除：这类条目在索引里是 mode 160000，指向**另一个仓库**的 commit。
    它不是本仓库的源码——连 `git checkout` 都不会恢复内容，克隆本仓库的人拿到的
    只是那条指针。但它又**是 tracked**，所以 `use_gitignore=True` 对它无效
    （gitignore 只管未跟踪文件），引擎会把那个嵌套仓库整个当成源码分析。

    实测代价（0.16.3 现场）：本仓库里 `.probe-fsoft/src` 是一次探针克隆误提交的
    gitlink，18MB / 186 个文件进了分析面。引擎为它建图、聚类、判定叶子节点，
    stderr 刷出成片 `Skipping invalid leaf node '.probe-fsoft/src/...' - not found
    in components`，最终在 45 分钟引擎超时上限上被进程树终止——整轮编译零产出。
    而本仓库真正的源码只有 7 个 .py。

    正规 submodule（.gitmodules 里有登记）**不排除**：那种内容是项目架构的一部分，
    改变它的既有语义不在本次缺陷范围内。这里只收「没有 .gitmodules 就永远 checkout
    不出来」的孤立指针。

    返回相对路径列表（如 ``['.probe-fsoft/src']``）；读不到索引时返回空列表——
    排除是优化，不是编译的前置条件，绝不能因为它失败而让整轮编译挂掉。
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_path), "ls-files", "--stage", "-z"],
            capture_output=True,
            text=True,
            timeout=30,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
        )
    except Exception:  # noqa: BLE001 — 非 git 仓库 / git 缺失 / 超时：不影响编译
        return []
    if proc.returncode != 0:
        return []

    gitlinks = []
    for entry in (proc.stdout or "").split("\0"):
        if not entry.startswith("160000 "):
            continue
        # 格式："160000 <sha> <stage>\t<path>"
        _, _, path = entry.partition("\t")
        path = path.strip()
        if path:
            gitlinks.append(path.replace("\\", "/"))
    if not gitlinks:
        return []

    registered = _gitmodules_paths(repo_path)
    return [p for p in gitlinks if p not in registered]


def _gitmodules_paths(repo_path):
    """`.gitmodules` 里登记的 submodule 路径集合（没有该文件就是空集）。"""
    try:
        text = (Path(repo_path) / ".gitmodules").read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — 没有 .gitmodules / 不可读都算「没有登记」
        return set()
    paths = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("path"):
            continue
        _, _, value = stripped.partition("=")
        value = value.strip().replace("\\", "/")
        if value:
            paths.add(value)
    return paths


def source_exclude_patterns(repo_path=None):
    """给 FSoft 依赖分析的排除清单：把非源码的东西挡在源码之外。

    返回新列表而不是共享模块级常量：调用方（RepoAnalyzer）会把 default 与 user
    两组模式合并进自己的字段，共享同一个 list 会让两处互相污染。

    ``repo_path`` 省略时只返回 wiki 产物模式（保持调用方兼容）；给了仓库路径就
    额外排除孤立 gitlink（见 ``dangling_gitlink_patterns``）。
    """
    patterns = list(WIKI_PRODUCT_PATTERNS)
    if repo_path is not None:
        patterns.extend(dangling_gitlink_patterns(repo_path))
    return patterns


# ── 模型通道 ────────────────────────────────────────────────────────────────


def _model_config():
    """从进程环境读模型通道。缺任何一项都返回 (None, 原因)。

    错误信息里刻意只说「环境变量」，不打印值——即使环境变量被误设成密钥，
    也不会因为这条错误信息被写进 job 日志。
    """
    base_url = (os.environ.get(ENV_BASE_URL) or "").strip()
    api_key = (os.environ.get(ENV_API_KEY) or "").strip()
    model = (os.environ.get(ENV_MAIN_MODEL) or "").strip()
    missing = [
        name
        for name, val in (
            (ENV_BASE_URL, base_url),
            (ENV_API_KEY, api_key),
            (ENV_MAIN_MODEL, model),
        )
        if not val
    ]
    if missing:
        return None, f"缺少模型通道（环境变量 {', '.join(missing)} 未设置）；本入口不会回退去读本机配置或凭证库"
    # fallback_model 必须显式给：adapter 用 `self.config.get("fallback_model")`
    # 透传（doc_generator.py:155），缺省 None 会让 FSoft 的
    # create_fallback_models 在 `model_name.lower()` 上抛 AttributeError
    # （llm_services.py:263-269）——实测必崩，且崩在 graph 阶段开头，
    # 表现为 engine-crashed 而不是可理解的模型错误。
    return {
        "base_url": base_url,
        "api_key": api_key,
        "main_model": model,
        "cluster_model": (os.environ.get(ENV_CLUSTER_MODEL) or model).strip(),
        "fallback_model": model,
        "provider": "openai-compatible",
    }, ""


# ── 进度桥接：把 FSoft 五段翻成八段契约 ─────────────────────────────────────


def bridge_progress(adapter, request_id, on_stage=None, docs_dir=None):
    """替换 adapter.progress_tracker 的三个阶段方法，把事件转成协议行。

    为什么用替换而不是继承：FSoft 在 ``CLIDocumentationGenerator.__init__`` 里
    直接 ``ProgressTracker(total_stages=5)`` 构造（doc_generator.py:63），
    没有注入点。而这里要的只是**旁路观察**，不改 FSoft 的任何行为——
    替换三个方法比 fork 一份 tracker 类更不容易随上游漂移。

    ``on_stage`` 收到每一个到达的引擎阶段；调用方用它记录「最后一个真实到达
    的阶段」，这样 done 结果里的 stage 是实测值而不是写死的常量。

    ``docs_dir`` 是必给的**进度事实来源**：``writtenCount`` 必须每帧都带真实
    已写篇数。理由（0.16.5 真机事故）：``client.js`` 判「超时但有进度 → partial」
    的唯一依据就是最后一条 progress 的 ``writtenCount``；此前这里压根不传
    written，进度帧恒为 0，于是「已写 20 篇后超时」被当成「一篇没写」判成
    failed —— 0.16.1 那次为打破死循环加的 partial 自救在真机上从未生效。
    计数用 ``_count_docs`` 递归真实清点，不去猜 FSoft 的内部计数器。

    上报的是**本轮真实改动篇数**（进场指纹表 vs 当前指纹表的差），不是 docs 目录的
    绝对篇数、也不是单纯篇数净差：增量轮进场时 docsDir 已被灌入上一轮的文章
    （Node 侧 hydrateDocsDir 在启动解释器之前就做完了），拿绝对篇数当 written 会让
    「一篇没写的一轮」也报出几十篇；而只看篇数净差又会把「原地重写 20 篇」的增量轮
    记成零进展。按路径比对 (size, mtime_ns) 两种都能算对。
    """
    from stage_map import (
        articles_percent,
        is_incremental,
        map_stage,
        percent_of,
    )

    tracker = adapter.progress_tracker
    orig_start, orig_update, orig_complete = (
        tracker.start_stage,
        tracker.update_stage,
        tracker.complete_stage,
    )
    baseline = _doc_fingerprints(docs_dir) if docs_dir else {}
    counted = {"n": 0, "at": 0.0}
    # 增量轮：FSoft 借用「模块聚类」的槽位（start_stage(2, "Incremental
    # Update")）跑整轮文章写作，阶段号会把它谎报成 cluster。这里记住
    # description 给的语义，后续帧一律按 articles 报。
    mode = {"incremental": False}

    def engine_stage(stage):
        return "articles" if mode["incremental"] else map_stage(stage)

    def note(stage):
        if on_stage:
            on_stage(engine_stage(stage))

    def expected_total(written):
        """本轮百分比的分母：本轮开始时 docs 里已有的 .md 篇数。

        为什么不数 module_tree.json：它只有叶子模块名（本仓库 16 项），而一轮
        真实改动覆盖 modules/ 与 crosscut/ 下的全部页（真机 28 篇），分子分母
        不同口径会让进度瞬间冲顶再卡住。baseline 快照与 written 同源（都是
        docs 目录里的 .md），量级一致。written 超过基线篇数（新建页）时以
        written 为准，保证百分比单调不倒退。
        """
        base = sum(1 for rel in baseline if rel.lower().endswith(".md"))
        return max(base, written)

    def frame_percent(stage, stage_progress, written):
        """进度帧的百分比。

        增量轮与阶段 3 都按「已写 / 预期」算，因为这两段的 stage_progress 恒为 0
        （FSoft 把该阶段的 update_stage 全门控在 verbose 里）。其余阶段照旧。
        """
        if mode["incremental"] or int(stage or 0) == 3:
            return articles_percent(written, expected_total(written))
        return percent_of(stage, stage_progress)

    def written_now(force=False):
        # 清点失败一律当 0：进度是观测值，不能因为它把编译搞崩。
        if not docs_dir:
            return 0
        # 节流：FSoft 的进度条一秒可能调好几次 update_stage，而每次对数百篇做递归
        # 遍历会把编译拖慢。阶段切换与阶段完成必须重算（那是 partial 判定的关键帧），
        # 普通 update 每 _WRITTEN_RECOUNT_SEC 才算一次。
        now = time.monotonic()
        if not force and counted["at"] > 0 and now - counted["at"] < _WRITTEN_RECOUNT_SEC:
            return counted["n"]
        fingerprints = _doc_fingerprints(docs_dir)
        changed = 0
        for rel, sig in fingerprints.items():
            if baseline.get(rel) != sig:
                changed += 1
        # 被删掉的文章也算本轮动过账
        for rel in baseline:
            if rel not in fingerprints:
                changed += 1
        counted["n"] = changed
        counted["at"] = now
        return changed

    def emit(stage, stage_progress, message, force=False):
        written = written_now(force)
        emit_progress(
            request_id,
            engine_stage(stage),
            frame_percent(stage, stage_progress, written),
            message,
            written=written,
            total=expected_total(written),
        )

    def with_detail(message):
        """把当前处理的模块名拼进 message。

        不改调用方传进来的语义（阶段描述照旧在前），只在有额外信息时补一段。
        FSoft 自己的 message 常常是空的（verbose=False 时 update_stage 压根不带
        描述），此时模块名就是唯一可读的进度信息。
        """
        extra = detail_suffix()
        if not extra:
            return message
        return f"{message}{extra}" if message else extra.lstrip("，")


    def start_stage(stage, description=None):
        orig_start(stage, description)
        if is_incremental(description):
            mode["incremental"] = True
        elif int(stage or 0) == 3:
            mode["incremental"] = False
        emit(stage, 0.0, with_detail(description or ""), force=True)
        note(stage)

    def update_stage(progress, message=None):
        orig_update(progress, message)
        emit(tracker.current_stage, tracker.stage_progress, with_detail(message or ""))
        note(tracker.current_stage)

    def complete_stage(message=None):
        orig_complete(message)
        # 阶段完成是超时判 partial 的关键帧，必须按当前真实产物重算，不吃节流缓存。
        emit(
            tracker.current_stage,
            1.0,
            with_detail(message or ""),
            force=True,
        )
        note(tracker.current_stage)
        # 增量轮跑完就回到常规槽位语义，别让后续阶段继续按 articles 算。
        if mode["incremental"]:
            mode["incremental"] = False

    tracker.start_stage = start_stage
    tracker.update_stage = update_stage
    tracker.complete_stage = complete_stage

    # ── 心跳：让「引擎还在跑」与「引擎卡死了」不再无法区分 ────────────────
    #
    # 为什么必须有（0.16.9 真机事故）：FSoft 阶段 3（Documentation Generation）
    # 里所有 update_stage 都写在 `if self.verbose:` 里面，而我们传的是
    # verbose=False——于是从 start_stage(3) 到 complete_stage() 之间**一帧进度都
    # 不发**。真机上这一整段可持续 40 分钟以上，Node 侧看不到任何 stdout，
    # 进度停在 `percent_of(3, 0.0)`=(0.40+0.20)*90=54%，job.updatedAt 冻结：
    # 面板上它跟「进程已经挂了」长得一模一样，而调度闸门（parallelLimit 默认 1）
    # 又被它占着，后续仓库永远轮不到——这就是「看不到过期自动编译」的真凶。
    #
    # 心跳只做两件事：按固定间隔重发**当前**阶段与**当前**真实篇数。它不推进
    # percent（不谎报进展），也不改任何 FSoft 行为；Node 侧据此可以区分
    # 「慢」（心跳在、篇数偶尔涨）与「僵死」（心跳在、篇数长期不涨）。
    #
    # 线程挂在 adapter.generate 上而不是调用方：generate 是唯一的同步入口，
    # 包起来之后 stop 一定在 try/finally 里执行，调用方一行都不用改，也不会
    # 出现「任务已结束、心跳还在污染 stdout」的泄漏。
    state = {"on": True}
    # 进度桥的既定契约只要求 adapter 有 progress_tracker（旁路观察，不改引擎行为）。
    # 心跳必须挂在 generate 上才能保证「任务结束即停表」，但没有 generate 的调用方
    # （只验阶段映射的探针、上游若换掉入口形态）不该因此报错——拿不到就只装桥，
    # 不装心跳：少一层观测，不能少一层功能。
    orig_generate = getattr(adapter, "generate", None)

    def _heartbeat():
        while state["on"]:
            time.sleep(_HEARTBEAT_SEC)
            if not state["on"]:
                return
            try:
                stage = tracker.current_stage
                # stage=0 表示 FSoft 还没进第一个阶段，此时没有可报告的阶段，
                # 硬发一帧只会让 map_stage 抛错（它按 1..5 映射）。
                if not stage:
                    continue
                written = written_now(True)
                emit(
                    stage,
                    tracker.stage_progress,
                    f"引擎仍在运行（已写 {written} 篇）{detail_suffix()}",
                    force=True,
                )
                note(stage)
            except Exception:  # noqa: BLE001 — 观测失败绝不能弄崩编译
                return

    def generate_with_heartbeat():
        thread = threading.Thread(target=_heartbeat, name="codewiki-heartbeat", daemon=True)
        state["on"] = True
        # 细节探针的存活期严格等于一次编译：挂在 generate 上，finally 里摘掉，
        # 保证不给后续请求留下被降级过的 logger。
        tap = attach_detail_tap()
        thread.start()
        try:
            return orig_generate()
        finally:
            state["on"] = False
            release_detail_tap(tap)

    if orig_generate is not None:
        adapter.generate = generate_with_heartbeat


def _doc_fingerprints(docs_dir):
    """产物指纹表：`{相对路径: (size, mtime_ns)}`。

    为什么不只数篇数（0.16.5 真机事故）：增量轮**通常不改篇数**——它重写的是
    已有文章（同一批路径、内容变了）。只比篇数净差会把这类轮次记成「零进展」，
    于是超时后的 partial 自救又不生效，而真正的零进展轮反而可能蒙混过关。
    比 (size, mtime_ns) 能同时抓住「新增一篇」「改写一篇」「删掉一篇」，成本只是
    一次目录遍历，且不需要读文件内容。mtime 在这里是可信的：整个 docsDir 是本轮
    引擎刚写出来的临时目录，不存在跨文件系统的 mtime 精度问题。
    """
    out = {}
    try:
        root = Path(docs_dir)
        for p in root.rglob("*.md"):
            rel = p.relative_to(root)
            parts = rel.parts
            if any(part.startswith(".") for part in parts[:-1]):
                continue
            if parts and parts[0] == "temp":
                continue
            if not p.is_file():
                continue
            st = p.stat()
            out[rel.as_posix()] = (st.st_size, st.st_mtime_ns)
    except Exception:
        return out
    return out


# ── generate / update ──────────────────────────────────────────────────────


def _count_docs(docs_dir):
    """清点产物页数。

    必须**递归**：hierarchical 布局把页写在子目录里（`doc_layout.py:module_doc_relpath`
    是 `posixpath.join(*module_path[:-1], f"{module_path[-1]}.md")`），只 glob 根层会把
    整棵子树漏掉——于是 `written` 少计而终态看着像成功，这正是「1 篇成功 + 19 篇失败
    也报 done」那类误判的来源之一。

    `temp/` 与点开头目录要排除：`temp/update-record.json` 等是记账文件，不是文章。
    """
    try:
        root = Path(docs_dir)
        count = 0
        for p in root.rglob("*.md"):
            rel = p.relative_to(root)
            parts = rel.parts
            if any(part.startswith(".") for part in parts[:-1]):
                continue
            if parts and parts[0] == "temp":
                continue
            if not p.is_file():
                continue
            count += 1
        return count
    except Exception:
        return 0


def _git_commit(repo_path):
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=15,
            encoding="utf-8",
            errors="replace",
        )
        if proc.returncode == 0:
            return (proc.stdout or "").strip()
    except Exception:
        pass
    return ""


def action_generate(request_id, payload, is_update=False):
    """跑一次 FSoft 生成/增量更新。

    这里**不判断**改了什么、该写哪些文章——那是 FSoft 的 diff 与 agentic 循环。
    本函数只做：准备 config → 跑 adapter → 把异常翻成契约终态。
    """
    repo_path = Path(str(payload.get("repoPath") or os.getcwd())).resolve()
    docs_dir = Path(str(payload.get("docsDir") or (repo_path / ".codewiki"))).resolve()

    if not repo_path.is_dir():
        return failure("engine-missing", f"仓库路径不存在：{repo_path}", "env", request_id)

    cfg, why = _model_config()
    if cfg is None:
        return failure("engine-model", why, "cluster", request_id)

    emit_progress(request_id, "env", 100, "环境与模型通道就绪")

    # 文章书写语言必须在组装 config **之前**取出来：下面 config["agent_instructions"]
    # 要把 language 展开进去，先读后写否则就是 UnboundLocalError（真机 P1 修复时踩过）。
    language = str(payload.get("language") or "").strip()
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    config = dict(cfg)
    config["update"] = bool(is_update)
    config["max_tokens"] = 32768
    config["max_token_per_module"] = 36369
    config["max_token_per_leaf_module"] = 16000
    config["max_depth"] = 2
    # 单模块写作的 LLM 请求上限（上游叫 request_limit）。
    #
    # 上游默认 100，但 1b4af43 起 `doc_guard.run_until_doc_written` 会在模块没写出
    # 页面时续发最多 2 次提醒，每次提醒都是一次独立 `agent.run(usage_limits=...)`，
    # 各自吃满一份预算。于是大模块（真机 change_set_management）在 100 次请求处撞
    # 上限，pydantic-ai 抛「The next request would exceed the request_limit of 100」，
    # 经 _classify_exception 翻成 article-missing，整轮从 done 掉成 partial——语义是
    # 对的（失败必须显式），但预算是错的：同一轮已写好的 31 篇白写。
    #
    # 由插件设置 requestLimit 下发（默认 300，硬顶 1000）；未下发时用 300 而不是
    # 上游的 100，避免「插件没传就退回旧坑」。非正值一律忽略：0 会让 agent 循环一开
    # 就撞上限。
    try:
        request_limit = int(payload.get("requestLimit") or 0)
    except (TypeError, ValueError):
        request_limit = 0
    config["request_limit"] = max(1, min(request_limit, 1000)) if request_limit > 0 else 300
    config["agent_retries"] = 3
    # 同层模块并行度（0.16.14）。默认 1 = 上游原始的严格串行。
    #
    # 为什么需要并行：上游 `_generate_modules_in_order` 是
    # `for module_path, module_name in processing_order: await ...` 的串行循环，
    # 一篇文档约 12 分钟（15–20 次 LLM 请求，含 3–4 次 3–5 分钟长思考），
    # 本仓库 16 节点串跑 180 分钟预算耗尽只写出 18 篇（真机 job-mvuf1c5b-5）。
    # 并行按拓扑层分批：同层模块互不依赖可并发，父模块仍等子模块写完。
    try:
        module_concurrency = int(payload.get("moduleConcurrency") or 1)
    except (TypeError, ValueError):
        module_concurrency = 1
    config["module_concurrency"] = max(1, min(module_concurrency, 8))
    config["use_gitignore"] = True
    config["prompt_caching"] = True
    # 阶段 6.8：把**我们自己的 wiki 产物**排除出源码分析面。
    #
    # 为什么必须排：引擎按「旧图 vs 新图」判增量。`.codewiki/` 与 `CodeWiki.md`
    # 是我们每轮都会改写的产物，不排掉它们就永远有「变化」——实测真实引擎在
    # 源码零改动的一轮里自报 outcome=incremental，图 diff 恒有 body:1 命中
    # `.codewiki/_meta.yaml::_meta.yaml`，于是每轮都产出一笔纯记账提交
    # （「无变化路径不重写/不提交」在真机上不成立），还白花一次 routing 的
    # 模型调用（约 528 prompt tokens / 3.5s）。
    #
    # 排除只作用于**依赖分析的文件树**（RepoAnalyzer 的 user_exclude_patterns），
    # 不影响：git 变化集采集（我们自己做）、`cw index`/基线（cw 自己按 .codewiki
    # 路径读写）、以及 docsDir 的输出。所以账本语义不变，只是不再把账本当源码。
    # 孤立 gitlink（被提交但 checkout 不出来的嵌套仓库）必须一起排：它是 tracked
    # 的，use_gitignore 拦不住它，实测会把整轮预算耗在一个 18MB 的无关子仓库上。
    config["agent_instructions"] = {
        "exclude_patterns": source_exclude_patterns(repo_path),
        # 文章书写语言：上游从 agent_instructions.language 读（config.py 的
        # `language` property），再经 normalize_language 归一（"ja" -> "Japanese"、
        # 未知文本原样透传、English 归 None 即上游默认英文）。
        #
        # 为什么必须显式传：插件设置 articleLanguage 默认「中文」，但原生通道此前
        # 整条链路都没把它带下来——nativeEnginePlan 不接、startNativeRun 不传、
        # 这里也不设，于是引擎静默按英文写，README 承诺的「文章语言，默认中文」
        # 在默认通道上完全落空。空值不写入，保持上游默认行为。
        **({"language": language} if language else {}),
    }
    # 阶段 5：增量参数由调用方显式给出（不在引擎里猜）。
    #   updateOptions.rung 决定走哪条增量算法（3=组件级方法，0=旧的按文件失效）。
    # 缺省时保持 FSoft 自己的默认行为（rung 3 + metadata.json 的 commit_id）。
    update_options = payload.get("updateOptions")
    if isinstance(update_options, dict) and update_options:
        config["update_options"] = dict(update_options)
    # 本轮「已消费到哪个 commit」由调用方给出（= cw 基线）。它被写进 adapter 的
    # commit_id，最终落进 metadata.json 的 generation_info.commit_id，也就是**下一轮**
    # 增量看到的 old_commit。不传时退回 HEAD（旧行为）。
    #
    # 为什么不用 `_detect_changed_files` 的 compare_to：那条是 CLI generate 的
    # 按文件失效路径（rung 0）。组件级增量（rung 3）比较的是**依赖图**（旧图 vs 新图），
    # 旧图由调用方持久化并水合进 docsDir，与 commit 号无关。所以这里只负责记账。
    commit_id = str(payload.get("commitId") or "").strip() or (_git_commit(repo_path) or None)
    # 「最后一个真实到达的阶段」由进度回调记录。done 结果里的 stage 必须是实测值，
    # 不能写死——否则面板会永远说「停在校验」，而实际可能连聚类都没跑到。
    reached = {"stage": "env"}

    try:
        from codewiki.cli.adapters.doc_generator import CLIDocumentationGenerator

        if is_update:
            from fsoft_runtime import install_incremental_runtime
            install_incremental_runtime()

        adapter = CLIDocumentationGenerator(
            repo_path=repo_path,
            output_dir=docs_dir,
            config=config,
            verbose=False,
            generate_html=False,
            commit_id=commit_id,
        )
        bridge_progress(
            adapter,
            request_id,
            on_stage=lambda s: reached.__setitem__("stage", s),
            docs_dir=docs_dir,
        )
        job = adapter.generate()
    except SystemExit as exc:
        # FSoft 在「无变更」等路径会 sys.exit(0)（generate.py:640 附近）。
        # 这不是失败：增量更新时「没有要改的」正是正常终态。
        code = exc.code if isinstance(exc.code, int) else 0
        if code == 0:
            return _done_result(
                request_id, docs_dir, repo_path, started,
                written=_count_docs(docs_dir), stage=reached["stage"],
                update_outcome=_update_outcome_of(adapter), counts=_counts_of(adapter),
            )
        return failure("engine-crashed", f"引擎以退出码 {code} 结束", reached["stage"], request_id)
    except Exception as exc:  # noqa: BLE001 — 必须把所有异常翻成契约终态
        return _classify_exception(exc, request_id, docs_dir, repo_path, started, stage=reached["stage"])

    written = _count_docs(docs_dir)
    missing = []
    try:
        missing = adapter.validate_generated_docs(str(docs_dir)) or []
    except Exception:
        missing = []

    # 阶段 5：本轮到底走了哪条路，必须由**引擎自己的记录**回答，不能让调用方猜。
    #   incremental       —— 组件级增量成立（图 diff 非空，只改了该改的页）
    #   no_change         —— 图 diff 为空：代码没变，文档已是最新（不重写任何页）
    #   full_fallback     —— 想增量但阈值/可比性触发回退，已整份重建
    #   detector_failure  —— 连旧状态都读不到，回退全量（我们水合过却读不到 = 我们的错）
    # 这个字段是「基线能不能推进」与「增量是否真的生效」的唯一证据。
    update_outcome = _update_outcome_of(adapter)

    if missing:
        result = _done_result(request_id, docs_dir, repo_path, started, written=written, stage=reached["stage"], update_outcome=update_outcome, counts=_counts_of(adapter))
        result["outcome"] = "partial"
        result["blockers"] = [
            {"kind": "article-missing", "detail": f"计划内文章缺失：{name}.md", "target": f"{name}.md"}
            for name in missing
        ]
        result["failedCount"] = len(missing)
        return result

    result = _done_result(request_id, docs_dir, repo_path, started, written=written, stage=reached["stage"], update_outcome=update_outcome, counts=_counts_of(adapter))
    # 用量：FSoft 自己记在 job.statistics 上（doc_generator.py:559-580）
    try:
        stats = getattr(job, "statistics", None)
        totals = getattr(stats, "usage_totals", None) or {}
        result["usage"] = {
            "inputTokens": int(totals.get("input_tokens", 0) or 0),
            "outputTokens": int(totals.get("output_tokens", 0) or 0),
            "cachedTokens": int(totals.get("cache_read_tokens", 0) or 0),
            "requests": int(totals.get("requests", 0) or 0),
        }
    except Exception:
        pass
    return result


def _update_outcome_of(adapter):
    """本轮增量结局（引擎自己的 update_record 说的）。

    为什么要有这个取值函数：`_last_update_record` 只在**真的进了增量分支**时才有值。
    拿不到值不等于「没增量」——它可能是「这次跑的是全量 generate」。所以返回 None
    而不是编一个 'full'：上层据此区分「引擎没说」（显式 full 请求）与「引擎说回退了」
    （想要增量但 full_fallback），两者对基线的处置不同。
    """
    try:
        record = getattr(adapter, "_last_update_record", None)
        if record is None:
            return None
        return str(getattr(record, "outcome", "") or "") or None
    except Exception:
        return None


def _counts_of(adapter):
    """本轮增量的真实计数：保留 / 删除 / 未映射（引擎自己记账的）。

    为什么这些数不能恒 0：契约（docs/fsoft-native-engine.md:44）把
    keptCount / removedCount / unmappedCount 列为 EngineResult 的必填事实，
    上层与面板据此判断「这轮到底改了什么」。此前三处硬编码 0，等于把
    「本轮一行没改」和「本轮改了 30 页但都被判 no-op」记成同一件事。

    取值来源（都是引擎 `UpdateRecord` 的原生字段，不自己猜）：
      · keptCount    —— verdicts 里 verdict == 'no-op' 的页数（本轮评估过、
                        判定无需改动，页留在盘上）
      · removedCount —— pages_removed 去重后的页数（本轮判定应删除的页）
      · unmappedCount—— repair.orphans 的长度（有变化但没有任何叶节点负责
                        的组件数，对应质量门的 unmapped-change）
    拿不到 record（全量 generate 路径）时返回全 0：那一轮本来就没有增量记账。
    """
    out = {"keptCount": 0, "removedCount": 0, "unmappedCount": 0}
    try:
        record = getattr(adapter, "_last_update_record", None)
        if record is None:
            return out
        verdicts = getattr(record, "verdicts", None) or []
        out["keptCount"] = sum(
            1 for v in verdicts if str((v or {}).get("verdict", "")) == "no-op"
        )
        out["removedCount"] = len(set(getattr(record, "pages_removed", None) or []))
        repair = getattr(record, "repair", None) or {}
        if isinstance(repair, dict):
            out["unmappedCount"] = len(repair.get("orphans") or [])
    except Exception:
        return {"keptCount": 0, "removedCount": 0, "unmappedCount": 0}
    return out


def _state_files(docs_dir):
    """列出引擎在 docsDir 里**真实产出**的跨轮状态文件（相对 docsDir，POSIX）。

    只报磁盘上存在的文件，不按白名单编造：
      · 顶层 *.json —— module_tree / first_module_tree / metadata / update_record
      · temp/dependency_graphs/ 下的全部（旧图靠它，`snapshot_old_graph` 会复制成 .prev.json）
      · temp/reference_index.json、temp/artifact_index.json —— updater 的失效索引
    文章（*.md）不列：它们本来就在 docsDir 里，上层按扩展名自己采集，列出来只会重复。
    """
    out = []
    try:
        root = Path(docs_dir)
        if not root.is_dir():
            return out
        for item in sorted(root.glob("*.json")):
            if item.is_file():
                out.append(item.name)
        temp = root / "temp"
        if temp.is_dir():
            for name in ("reference_index.json", "artifact_index.json"):
                if (temp / name).is_file():
                    out.append(f"temp/{name}")
            graphs = temp / "dependency_graphs"
            if graphs.is_dir():
                for item in sorted(graphs.iterdir()):
                    if item.is_file():
                        out.append(f"temp/dependency_graphs/{item.name}")
    except Exception:
        return out
    return out


def _done_result(request_id, docs_dir, repo_path, started, written=0, stage="articles", update_outcome=None, counts=None):
    out = {"keptCount": 0, "removedCount": 0, "unmappedCount": 0}
    if isinstance(counts, dict):
        for key in out:
            try:
                out[key] = max(0, int(counts.get(key, 0) or 0))
            except (TypeError, ValueError):
                out[key] = 0
    return {
        "contractVersion": CONTRACT_VERSION,
        "outcome": "done",
        "stage": stage,
        "blockers": [],
        "error": None,
        "writtenCount": written,
        "failedCount": 0,
        "keptCount": out["keptCount"],
        "removedCount": out["removedCount"],
        "unmappedCount": out["unmappedCount"],
        "usage": {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0},
        "engine": {"version": _engine_version(), "commit": _git_commit(repo_path), "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"},
        "artifacts": {
            "docsDir": str(docs_dir),
            "rawTreeDir": str(Path(docs_dir) / "module_tree.json"),
            "updateRecord": str(Path(docs_dir) / "update_record.json"),
            # 引擎**实际产出**的跨轮状态文件（相对 docsDir 的 POSIX 路径）。
            # 为什么由这里给而不是让上层按白名单猜：白名单写错就会把「引擎其实没产出
            # 依赖图」误记成「已持久化」，下一轮增量拿着空图跑，图 diff 恒为空，
            # 于是永远 no_change、文章与源码脱节。这里只报磁盘上真实存在的文件，
            # 上层拿它交叉校验自己的采集结果，对不上就记 missing（可见）。
            "stateFiles": _state_files(docs_dir),
        },
        # 引擎自报的增量结局（incremental/no_change/full_fallback/detector_failure/null）。
        # 与 artifacts 并列而不是塞进 artifacts：artifacts 描述「产物在哪」，
        # 这个字段描述「这次编译是什么性质」，上层据此决定基线能不能推进。
        "updateOutcome": update_outcome,
        "startedAt": started,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _classify_exception(exc, request_id, docs_dir, repo_path, started, stage="articles"):
    """把 FSoft 的异常分类成契约错误码。

    分类依据是异常**类型**而不是消息文本：文本随版本变，类型相对稳定。
    """
    name = type(exc).__name__
    text = str(exc)[:1500]

    # 缺页：FSoft 明确有这两个异常类（doc_generator.py:483 附近抛出）
    if name in ("IncompleteGenerationError", "IncompleteDocumentationError"):
        missing = getattr(exc, "missing_modules", None) or []
        result = _done_result(request_id, docs_dir, repo_path, started, written=_count_docs(docs_dir), stage=stage)
        result["outcome"] = "partial"
        result["blockers"] = [
            {"kind": "article-missing", "detail": f"计划内文章缺失：{m}.md", "target": f"{m}.md"}
            for m in missing
        ] or [{"kind": "article-failed", "detail": text}]
        result["failedCount"] = max(1, len(missing))
        return result

    # 上游 1b4af43 起：`_generate_modules_in_order` 在**有模块失败时**抛
    # `RuntimeError("Documentation failed for modules: <path>: <err>; ...")`。
    # 过去它只 logger.error 后 continue，终态看起来是成功——上游把静默失败改成显式
    # 失败是好事，但语义上它仍然是「计划内文章没写成」，不是「进程崩了」：
    # 已写的页面照样要交付（partial），blockers 还要点名缺哪些模块，面板才知道该重跑谁。
    if name == "RuntimeError" and text.startswith("Documentation failed for modules:"):
        failed_modules = [
            part.strip().split(": ", 1)[0]
            for part in text.split(":", 1)[1].strip().split("; ")
            if part.strip()
        ]
        result = _done_result(request_id, docs_dir, repo_path, started, written=_count_docs(docs_dir), stage=stage)
        result["outcome"] = "partial"
        result["blockers"] = [
            {"kind": "article-missing", "detail": f"模块写作失败：{m}", "target": f"{m}.md"}
            for m in failed_modules
        ] or [{"kind": "article-failed", "detail": text}]
        result["failedCount"] = max(1, len(failed_modules))
        return result

    # 模型/上游失败：APIError 及其子类
    if name.endswith("APIError") or name in ("APIError", "ConfigurationError"):
        return _salvage(request_id, docs_dir, repo_path, started, stage, "engine-model", text)
    if name in ("RepositoryError",):
        # 连仓库都没读出来，docsDir 里不可能有本轮成果，直接判失败。
        return failure("engine-missing", text, "graph", request_id)
    if name in ("KeyboardInterrupt",):
        return _cancelled_result(request_id, _count_docs(docs_dir), stage=stage)
    return _salvage(
        request_id, docs_dir, repo_path, started, stage, "engine-crashed",
        f"{name}: {text}\n{traceback.format_exc()[-1200:]}",
    )


def _salvage(request_id, docs_dir, repo_path, started, stage, code, message):
    """崩溃/模型失败时，若已经写出文章，就降 partial 交付，而不是整轮判 failed。

    **为什么必须这么做**：原生引擎的一条任务动辄跑几十上百分钟（真机全量实测约
    174 分钟），失败点通常在阶段 3「逐模块写文章」的中途。整轮判 failed 的代价
    不只是「这次白跑」——native-run.js 对 failed 是直接 settle 短路，不做原始树
    留档、不采集受管状态，于是下一轮增量因为没有持久化状态又退回全量，再跑一遍
    同样的时间、再撞同样的墙。把已写的部分降成 partial 交付，才可能打破这个循环。

    **为什么不是无条件 partial**：一篇都没写出来时仍然是 failed——用空产物冒充
    「部分完成」会让基线与面板失真（见 _done_result 与 canAdvanceBaseline 的注记）。
    """
    written = _count_docs(docs_dir)
    if written <= 0:
        return failure(code, message, stage, request_id)
    result = _done_result(
        request_id, docs_dir, repo_path, started,
        written=written, stage=stage, update_outcome=_update_outcome_of_safe(),
    )
    result["outcome"] = "partial"
    result["error"] = {"code": code, "message": str(message)[:4000], "stage": stage}
    result["blockers"] = [
        {"kind": "article-failed", "detail": f"编译在 {stage} 阶段中断（已写 {written} 篇）：{str(message)[:300]}"}
    ]
    result["failedCount"] = 1
    return result


def _update_outcome_of_safe():
    """_salvage 里没有 adapter 句柄，取不到本轮增量结局就交 None。

    为什么不猜：updateOutcome 是「基线能不能推进」的唯一证据（见 _done_result
    的注记），猜错会让 full_fallback 被当成普通 done，基线悄悄前移。
    None 表示「引擎没报」，上层按未知处理。
    """
    return None


def _cancelled_result(request_id, written=0, stage="articles"):
    return {
        "contractVersion": CONTRACT_VERSION,
        "outcome": "cancelled",
        "stage": stage,
        "blockers": [{"kind": "cancelled", "detail": "用户取消了这次编译"}],
        "error": None,
        "writtenCount": written,
        "failedCount": 0,
        "keptCount": 0,
        "removedCount": 0,
        "unmappedCount": 0,
        "usage": {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0},
        "engine": {"version": _engine_version(), "commit": "", "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"},
        "artifacts": {"docsDir": "", "rawTreeDir": "", "updateRecord": ""},
        "startedAt": None,
        "finishedAt": None,
    }


# ── 主循环 ──────────────────────────────────────────────────────────────────


def handle_request(msg):
    """处理一条请求，返回 (requestId, result)。任何路径都必须返回 result。"""
    if not isinstance(msg, dict):
        return "", failure("engine-protocol", "请求行必须是 JSON 对象")
    request_id = str(msg.get("requestId") or "")
    if not request_id:
        return "", failure("engine-protocol", "请求缺 requestId")
    action = str(msg.get("action") or "")
    # 入参位置：契约（docs/fsoft-native-engine.md「接口面」表）与 client.js 都按
    # `{requestId, action, ...payload}` **平铺**发送。这里曾经只读 `msg["payload"]`，
    # 于是真引擎的 repoPath/docsDir/commitId/updateOptions 全部读不到：
    #   · docsDir 丢失 → 回退写进 repo/.codewiki，增量轮把水合过的状态目录再写回去，
    #     长出 `_native-state/docs/_native-state/docs/...` 自嵌套，产生重复页与死链；
    #   · commitId 丢失 → 退化成「用 HEAD」，把调用方的记账语义悄悄换掉。
    # 假引擎（test-fixtures/fake-native-engine.mjs）按平铺读，所以这处不一致在假引擎
    # 测试里永远看不出来。两种形状都认：顶层平铺优先，其次才是显式 payload 对象
    # （保留给仍在用嵌套形状的外部调用方）。
    nested = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
    flat = {k: v for k, v in msg.items() if k not in ("requestId", "action", "payload")}
    payload = {**nested, **flat}

    if action not in ACTIONS:
        return request_id, failure("engine-protocol", f"未登记的 action：{action!r}（允许 {', '.join(ACTIONS)}）")

    if action == "doctor":
        return request_id, action_doctor(request_id, payload)
    if action == "cancel":
        # 取消由 Node 侧直接杀进程树（lib/engine/process-tree.js）。
        # 入口这一侧的 cancel 只用于「请求已受理但还没开始跑」的场景，
        # 所以立刻应答，不做任何实际工作。
        #
        # 出参按契约（docs/fsoft-native-engine.md「接口面」表）是
        # `{cancelled: boolean}`，**不是**一份 EngineResult：cancel 是控制面动作，
        # 不是一次编译的结果，回 EngineResult 会让下游把它当成「这轮编译结束了」。
        return request_id, {"cancelled": True}
    if action == "update":
        return request_id, action_generate(request_id, payload, is_update=True)
    return request_id, action_generate(request_id, payload, is_update=False)


def main():
    emit_hello()
    raw = sys.stdin.readline()
    if not raw or not raw.strip():
        emit_result("", failure("engine-protocol", "没有收到请求行"))
        return 0
    try:
        msg = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 — 非法 JSON 也要回可机读失败
        emit_result("", failure("engine-protocol", f"请求行不是合法 JSON：{exc}"))
        return 0
    request_id, result = handle_request(msg)
    emit_result(request_id, result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # 被外层杀进程树时可能落到这里；仍要尽量回一条 cancelled，让 Node 侧
        # 拿得到语义终态而不是只看到 exit code。
        try:
            emit_result("", _cancelled_result(""))
        except Exception:
            pass
        sys.exit(0)
