"""FSoft 增量 Step 5 的受控并行与叶子级断点。

上游把所有叶子放在一个 docsDir 里串行执行。这里给每个叶子独立的工作副本，
并行完成模型调用，再按原顺序合并真实页面变化；同一页被多个叶子修改时，
后序叶子在已经合并的现场串行重跑。这样既保留串行语义，也不必把保守写集里
共同出现的 overview 当成全局串行锁。

只替换 IncrementalUpdater._run 的 Step 5。上游源码锚点变化时安装直接失败，
不会静默退回另一套算法。
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import json
import logging
import os
import shutil
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any

from codewiki.src.be.updater import pages as P
from codewiki.src.be.updater import tree as T
from codewiki.src.be.updater.change_report import active_set, order_active
from codewiki.src.be.updater.leaf_agent import LeafAgentRunner
from codewiki.src.be.updater.orchestrator import IncrementalUpdater, _WholeRepoReport
from codewiki.src.be.updater.record import UpdateRecord
from codewiki.src.be.updater.reference_index import inverse

logger = logging.getLogger(__name__)

ADAPTER_VERSION = 1
CHECKPOINT_FILENAME = "dsh_leaf_checkpoint.json"
_STEP5_START = "    # ---- Step 5: sequential leaf agents\n"
_STEP5_END = "    # ---- Step 6.1: generate any page still missing"
_RECORD_LISTS = (
    "calls",
    "verdicts",
    "pages_written",
    "pages_removed",
    "write_set_violations",
    "detector_notes",
    "errors",
)


def checkpoint_path(docs_dir: str | os.PathLike[str]) -> Path:
    return Path(docs_dir) / CHECKPOINT_FILENAME


def write_checkpoint(docs_dir: str | os.PathLike[str], signature: str, completed: dict[str, Any]) -> None:
    target = checkpoint_path(docs_dir)
    payload = {"version": ADAPTER_VERSION, "signature": signature, "completed": completed}
    tmp = target.with_name(target.name + f".{os.getpid()}.{time.time_ns()}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, sort_keys=True, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, target)


def clear_checkpoint(docs_dir: str | os.PathLike[str]) -> None:
    checkpoint_path(docs_dir).unlink(missing_ok=True)


def _canonical(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _canonical(value.model_dump(mode="json"))
    if isinstance(value, dict):
        return {str(k): _canonical(v) for k, v in sorted(value.items(), key=lambda item: str(item[0]))}
    if isinstance(value, (set, frozenset)):
        return sorted((_canonical(v) for v in value), key=lambda v: json.dumps(v, sort_keys=True, default=str))
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    return value


def _signature(updater: IncrementalUpdater, order: list[tuple[str, ...]], new_tree: dict[str, Any], new_graph: dict[str, Any]) -> str:
    options = updater.opts.to_dict()
    options.get("extra", {}).pop("resume", None)
    material = {
        "adapter": ADAPTER_VERSION,
        "revision": updater.record.revision,
        "options": options,
        "tree": new_tree,
        "graph": new_graph,
        "order": order,
    }
    encoded = json.dumps(_canonical(material), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _delta(record: UpdateRecord) -> dict[str, Any]:
    result = {name: copy.deepcopy(getattr(record, name)) for name in _RECORD_LISTS}
    result["write_sets"] = copy.deepcopy(record.write_sets)
    return result


def _merge_delta(record: UpdateRecord, delta: dict[str, Any]) -> None:
    for name in _RECORD_LISTS:
        getattr(record, name).extend(copy.deepcopy(delta.get(name, [])))
    record.write_sets.update(copy.deepcopy(delta.get("write_sets", {})))


def _load_completed(updater: IncrementalUpdater, signature: str) -> dict[str, Any]:
    if not updater.opts.extra.get("resume"):
        return {}
    path = checkpoint_path(updater.docs_dir)
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        saved = json.load(f)
    if saved.get("version") != ADAPTER_VERSION or saved.get("signature") != signature:
        logger.warning("增量断点签名已变化，丢弃旧断点：%s", path)
        return {}
    completed = saved["completed"]
    for key in sorted(completed, key=int):
        _merge_delta(updater.record, completed[key])
    logger.info("从增量断点恢复 %d 个已完成叶子", len(completed))
    return completed


def _page_changes(before: dict[str, str], workspace: str) -> set[str]:
    return P.changed_pages(before, P.page_hashes(workspace))


def _apply_page(docs_dir: str, workspace: str, stem: str) -> None:
    source = Path(P.page_path(workspace, stem))
    if not source.exists():
        P.remove_page(docs_dir, stem)
        return
    target = Path(P.page_path(docs_dir, stem))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


async def run_leaf_order(
    updater: IncrementalUpdater,
    order: list[tuple[str, ...]],
    reports: dict[tuple[str, Any], Any],
    new_tree: dict[str, Any],
    new_graph: dict[str, Any],
    leaf_nodes: list[str],
    ref_index: dict[str, Any] | None = None,
) -> None:
    """执行已排序的叶子；这是适配器与测试共用的公开 seam。"""
    rec = updater.record
    dep = T.leaf_dependents(new_tree, new_graph)
    inv = inverse(ref_index or {})
    rec.active = [
        {"leaf": "/".join(p), "page": reports[p].page, "mode": reports[p].mode, "order": i}
        for i, p in enumerate(order)
    ]
    signature = _signature(updater, order, new_tree, new_graph)
    completed = _load_completed(updater, signature)
    baseline = P.page_hashes(updater.docs_dir)
    limit = max(1, min(int(updater.opts.extra.get("moduleConcurrency", 1)), 8))

    tasks = []
    for index, path in enumerate(order):
        report = reports[path]
        roles = updater._write_roles(report, new_tree, dep, inv)
        info = T.node_at(new_tree, path) or {}
        component_ids = [c for c in T.components_of(info) if c in new_graph]
        if updater.whole_repo:
            component_ids = [c for c in leaf_nodes if c in new_graph]
        report.leaf_path = tuple(path)
        tasks.append((index, path, report, roles, component_ids))

    async def isolated(task):
        index, path, report, roles, component_ids = task
        workspace = os.path.join(workspaces, str(index))
        shutil.copytree(
            updater.docs_dir,
            workspace,
            ignore=shutil.ignore_patterns(CHECKPOINT_FILENAME, CHECKPOINT_FILENAME + ".*"),
        )
        config = copy.copy(updater.config)
        config.docs_dir = workspace
        task_record = UpdateRecord(options=rec.options, revision=rec.revision)
        task_tree = copy.deepcopy(new_tree)
        runner = LeafAgentRunner(
            config, updater.backend, workspace, new_graph, task_tree,
            getattr(updater, "_dsh_graph_diff", None), updater.opts, task_record,
        )
        target = _WholeRepoReport(report, P.OVERVIEW_STEM) if updater.whole_repo else report
        logger.info("Updating leaf %s (mode=%s, write set=%s)", "/".join(path), report.mode, sorted(roles))
        try:
            await runner.run(target, roles, component_ids)
        except Exception as exc:
            task_record.errors.append(f"leaf {'/'.join(path)}: {type(exc).__name__}: {exc}")
            logger.error("Leaf %s failed: %s", "/".join(path), exc)
        changes = _page_changes(baseline, workspace)
        return task, workspace, task_record, changes, task_tree != new_tree

    workspaces = tempfile.mkdtemp(prefix="dsh-codewiki-leaves-", dir=os.path.dirname(updater.docs_dir))
    try:
        for start in range(0, len(tasks), limit):
            batch = tasks[start:start + limit]
            pending = [t for t in batch if str(t[0]) not in completed]
            outcomes = await asyncio.gather(*(isolated(t) for t in pending)) if pending else []
            by_index = {t[0]: outcome for t, outcome in zip(pending, outcomes)}
            claimed: set[str] = set()
            for task in batch:
                index, path, report, roles, component_ids = task
                key = str(index)
                if key in completed:
                    claimed.update(completed[key].get("pages_written", []))
                    claimed.update(completed[key].get("pages_removed", []))
                    continue
                _, workspace, task_record, changes, tree_changed = by_index[index]
                conflict = bool(changes & claimed) or tree_changed
                if conflict:
                    # 丢弃隔离分支的页面结果；模型调用仍计入本轮账本。
                    discarded = {name: [] for name in _RECORD_LISTS}
                    discarded["calls"] = copy.deepcopy(task_record.calls)
                    discarded["detector_notes"] = copy.deepcopy(task_record.detector_notes) + [
                        f"[{report.page}] isolated attempt discarded: page conflict or module-tree mutation; rerunning serially"
                    ]
                    discarded["write_sets"] = {}
                    _merge_delta(rec, discarded)
                    before = {name: len(getattr(rec, name)) for name in _RECORD_LISTS}
                    runner = LeafAgentRunner(
                        updater.config, updater.backend, updater.docs_dir, new_graph, new_tree,
                        getattr(updater, "_dsh_graph_diff", None), updater.opts, rec,
                    )
                    target = _WholeRepoReport(report, P.OVERVIEW_STEM) if updater.whole_repo else report
                    try:
                        await runner.run(target, roles, component_ids)
                    except Exception as exc:
                        rec.errors.append(f"leaf {'/'.join(path)}: {type(exc).__name__}: {exc}")
                        logger.error("Leaf %s failed: %s", "/".join(path), exc)
                    serial = {name: copy.deepcopy(getattr(rec, name)[before[name]:]) for name in _RECORD_LISTS}
                    serial["write_sets"] = {report.page: copy.deepcopy(rec.write_sets[report.page])}
                    for name in _RECORD_LISTS:
                        discarded[name].extend(serial[name])
                    discarded["write_sets"].update(serial["write_sets"])
                    completed[key] = discarded
                else:
                    for stem in sorted(changes):
                        _apply_page(updater.docs_dir, workspace, stem)
                    _merge_delta(rec, _delta(task_record))
                    completed[key] = _delta(task_record)
                claimed.update(changes)
                write_checkpoint(updater.docs_dir, signature, completed)
        clear_checkpoint(updater.docs_dir)
    finally:
        shutil.rmtree(workspaces, ignore_errors=True)


async def run_leaf_agents(updater, reports, new_tree, new_graph, leaf_nodes, ref_index) -> None:
    active = active_set(reports)
    order = order_active(active, new_tree, new_graph)
    if updater.whole_repo and len(order) > 1:
        overview_path = (P.OVERVIEW_STEM,)
        order = [overview_path if overview_path in reports else order[0]]
        updater.record.detector_notes.append(
            f"whole-repository mode: {len(active)} active units collapsed into one overview run"
        )
    await run_leaf_order(updater, order, reports, new_tree, new_graph, leaf_nodes, ref_index)


def install_incremental_runtime() -> None:
    """只替换上游 Step 5；其余增量主流程仍执行上游原文。"""
    current = IncrementalUpdater._run
    if getattr(current, "__dsh_runtime__", False):
        return
    source = textwrap.dedent(inspect.getsource(current))
    start = source.find(_STEP5_START)
    end = source.find(_STEP5_END, start + len(_STEP5_START))
    if start < 0 or end < 0:
        raise RuntimeError("FSoft IncrementalUpdater Step 5 源码锚点不匹配，拒绝安装运行时适配")
    replacement = (
        "    # ---- Step 5: isolated parallel leaf agents with resume\n"
        "    self._dsh_graph_diff = diff\n"
        "    await _dsh_run_leaf_agents(self, reports, new_tree, new_graph, leaf_nodes, ref_index)\n\n"
    )
    transformed = source[:start] + replacement + source[end:]
    namespace = dict(vars(__import__(IncrementalUpdater.__module__, fromlist=["*"])))
    namespace["_dsh_run_leaf_agents"] = run_leaf_agents
    exec(compile(transformed, inspect.getsourcefile(current) or "<fsoft-runtime>", "exec"), namespace)
    replacement_fn = namespace["_run"]
    replacement_fn.__dsh_runtime__ = True
    IncrementalUpdater._run = replacement_fn
