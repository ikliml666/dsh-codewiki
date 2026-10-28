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
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

# ── 协议流守卫：必须在 import codewiki 之前装好 ──────────────────────────────

_REAL_STDOUT = sys.stdout

# Windows 下 Python 的 stdout 默认按 locale 编码（cp936），而 Node 侧一律按 UTF-8
# 解码协议行。不先改编码，中文错误信息过管道就是乱码——排障时完全不可读。
for _stream in (_REAL_STDOUT, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — 非 TextIOWrapper（被重定向）时忽略即可
        pass


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
ACTIONS = ("doctor", "generate", "update", "cancel")

# 模型通道的环境变量名。Node 侧桥注入，密钥只活在进程环境里。
ENV_BASE_URL = "CODEWIKI_BASE_URL"
ENV_API_KEY = "CODEWIKI_API_KEY"
ENV_MAIN_MODEL = "CODEWIKI_MAIN_MODEL"
ENV_CLUSTER_MODEL = "CODEWIKI_CLUSTER_MODEL"


def emit(obj):
    """写一行协议 JSON 到真 stdout。所有协议消息都必须经这里。"""
    line = json.dumps(obj, ensure_ascii=False)
    _REAL_STDOUT.write(line + "\n")
    _REAL_STDOUT.flush()


def emit_hello():
    emit({"type": "hello", "protocolVersion": PROTOCOL_VERSION, "engine": "fsoft-native"})


def emit_progress(request_id, stage, percent, message="", written=0, failed=0, total=0):
    emit(
        {
            "type": "progress",
            "requestId": request_id,
            "contractVersion": 1,
            "stage": stage,
            "percent": percent,
            "message": message,
            "writtenCount": written,
            "failedCount": failed,
            "totalCount": total,
        }
    )


def emit_result(request_id, result):
    emit({"type": "result", "requestId": request_id, "result": result})


def failure(code, message, stage=None, request_id=""):
    """构造一个 failed 终态。message 只放给人看的说明，绝不拼凭证内容。"""
    return {
        "contractVersion": 1,
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
        return failure("engine-missing", "无法导入 codewiki：解释器里没有安装 FSoft 引擎", "env", request_id)
    ok, check_out = _pip_check()
    emit_progress(request_id, "env", 100, "依赖检查完成" if ok else "依赖未闭合")
    if not ok:
        result = failure("engine-deps", check_out, "env", request_id)
        result["engine"] = {
            "version": version,
            "commit": "",
            "python": py,
            "deps": {"ok": False, "summary": check_out},
        }
        return result
    return {
        "contractVersion": 1,
        "outcome": "done",
        "stage": "env",
        "blockers": [],
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


def bridge_progress(adapter, request_id, on_stage=None):
    """替换 adapter.progress_tracker 的三个阶段方法，把事件转成协议行。

    为什么用替换而不是继承：FSoft 在 ``CLIDocumentationGenerator.__init__`` 里
    直接 ``ProgressTracker(total_stages=5)`` 构造（doc_generator.py:63），
    没有注入点。而这里要的只是**旁路观察**，不改 FSoft 的任何行为——
    替换三个方法比 fork 一份 tracker 类更不容易随上游漂移。

    ``on_stage`` 收到每一个到达的引擎阶段；调用方用它记录「最后一个真实到达
    的阶段」，这样 done 结果里的 stage 是实测值而不是写死的常量。
    """
    from stage_map import map_stage, percent_of

    tracker = adapter.progress_tracker
    orig_start, orig_update, orig_complete = (
        tracker.start_stage,
        tracker.update_stage,
        tracker.complete_stage,
    )

    def note(stage):
        if on_stage:
            on_stage(map_stage(stage))

    def start_stage(stage, description=None):
        orig_start(stage, description)
        emit_progress(request_id, map_stage(stage), percent_of(stage, 0.0), description or "")
        note(stage)

    def update_stage(progress, message=None):
        orig_update(progress, message)
        emit_progress(
            request_id,
            map_stage(tracker.current_stage),
            percent_of(tracker.current_stage, tracker.stage_progress),
            message or "",
        )
        note(tracker.current_stage)

    def complete_stage(message=None):
        orig_complete(message)
        emit_progress(
            request_id,
            map_stage(tracker.current_stage),
            percent_of(tracker.current_stage, 1.0),
            message or "",
        )
        note(tracker.current_stage)

    tracker.start_stage = start_stage
    tracker.update_stage = update_stage
    tracker.complete_stage = complete_stage


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

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    config = dict(cfg)
    config["update"] = bool(is_update)
    config["max_tokens"] = 32768
    config["max_token_per_module"] = 36369
    config["max_token_per_leaf_module"] = 16000
    config["max_depth"] = 2
    config["request_limit"] = 100
    config["agent_retries"] = 3
    config["use_gitignore"] = True
    config["prompt_caching"] = True

    commit_id = _git_commit(repo_path) or None
    # 「最后一个真实到达的阶段」由进度回调记录。done 结果里的 stage 必须是实测值，
    # 不能写死——否则面板会永远说「停在校验」，而实际可能连聚类都没跑到。
    reached = {"stage": "env"}

    try:
        from codewiki.cli.adapters.doc_generator import CLIDocumentationGenerator

        adapter = CLIDocumentationGenerator(
            repo_path=repo_path,
            output_dir=docs_dir,
            config=config,
            verbose=False,
            generate_html=False,
            commit_id=commit_id,
        )
        bridge_progress(adapter, request_id, on_stage=lambda s: reached.__setitem__("stage", s))
        job = adapter.generate()
    except SystemExit as exc:
        # FSoft 在「无变更」等路径会 sys.exit(0)（generate.py:640 附近）。
        # 这不是失败：增量更新时「没有要改的」正是正常终态。
        code = exc.code if isinstance(exc.code, int) else 0
        if code == 0:
            return _done_result(request_id, docs_dir, repo_path, started, written=_count_docs(docs_dir), stage=reached["stage"])
        return failure("engine-crashed", f"引擎以退出码 {code} 结束", reached["stage"], request_id)
    except Exception as exc:  # noqa: BLE001 — 必须把所有异常翻成契约终态
        return _classify_exception(exc, request_id, docs_dir, repo_path, started, stage=reached["stage"])

    written = _count_docs(docs_dir)
    missing = []
    try:
        missing = adapter.validate_generated_docs(str(docs_dir)) or []
    except Exception:
        missing = []

    if missing:
        result = _done_result(request_id, docs_dir, repo_path, started, written=written, stage=reached["stage"])
        result["outcome"] = "partial"
        result["blockers"] = [
            {"kind": "article-missing", "detail": f"计划内文章缺失：{name}.md", "target": f"{name}.md"}
            for name in missing
        ]
        result["failedCount"] = len(missing)
        return result

    result = _done_result(request_id, docs_dir, repo_path, started, written=written, stage=reached["stage"])
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


def _done_result(request_id, docs_dir, repo_path, started, written=0, stage="articles"):
    return {
        "contractVersion": 1,
        "outcome": "done",
        "stage": stage,
        "blockers": [],
        "error": None,
        "writtenCount": written,
        "failedCount": 0,
        "keptCount": 0,
        "removedCount": 0,
        "unmappedCount": 0,
        "usage": {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0},
        "engine": {"version": _engine_version(), "commit": _git_commit(repo_path), "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"},
        "artifacts": {
            "docsDir": str(docs_dir),
            "rawTreeDir": str(Path(docs_dir) / "module_tree.json"),
            "updateRecord": str(Path(docs_dir) / "update_record.json"),
        },
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

    # 模型/上游失败：APIError 及其子类
    if name.endswith("APIError") or name in ("APIError", "ConfigurationError"):
        return failure("engine-model", text, stage, request_id)
    if name in ("RepositoryError",):
        return failure("engine-missing", text, "graph", request_id)
    if name in ("KeyboardInterrupt",):
        return _cancelled_result(request_id, _count_docs(docs_dir), stage=stage)
    return failure("engine-crashed", f"{name}: {text}\n{traceback.format_exc()[-1200:]}", stage, request_id)


def _cancelled_result(request_id, written=0, stage="articles"):
    return {
        "contractVersion": 1,
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
    payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}

    if action not in ACTIONS:
        return request_id, failure("engine-protocol", f"未登记的 action：{action!r}（允许 {', '.join(ACTIONS)}）")

    if action == "doctor":
        return request_id, action_doctor(request_id, payload)
    if action == "cancel":
        # 取消由 Node 侧直接杀进程树（lib/engine/process-tree.js）。
        # 入口这一侧的 cancel 只用于「请求已受理但还没开始跑」的场景，
        # 所以立刻回 cancelled 终态，不做任何实际工作。
        return request_id, _cancelled_result(request_id)
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
