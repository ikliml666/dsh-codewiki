"""补齐 module_tree 未收录文件的叶子归属。

上游 ``validate_module_file_coverage`` 要求「依赖图里出现的每个文件都被某个叶子
模块认领」，而 Step 2 的 ``repair_tree`` 只处理**本轮 diff.added** 的组件。于是
历史上某轮没有写进树里的文件（新增文件正好落在 full_fallback 轮、或当时组件不
属于叶子类型）永远不进树，之后每轮增量都会在校验处抛
``Invalid module file coverage: missing=[...]``，且不会自愈。

这里按上游自己的规则补挂：同文件 → 同目录 → 邻居多数 → 目录最近邻。补挂不改变
任何已写页面，只把缺失文件里的组件登记到最近的叶子上；校验本身仍由上游执行。
"""
from __future__ import annotations

import logging
import os
from typing import Any

from codewiki.src.be.dependency_analyzer.leaf_selection import (
    compute_valid_leaf_types,
    filter_leaf_nodes,
)
from codewiki.src.be.module_scope import component_files, module_file_owners
from codewiki.src.be.updater import tree as T
from codewiki.src.be.updater.options import UpdateOptions
from codewiki.src.be.updater.tree_repair import route_by_rules

logger = logging.getLogger(__name__)


def _dirname(rel: str) -> str:
    return os.path.dirname(rel.replace("\\", "/"))


def _shared_prefix(a: str, b: str) -> int:
    left = _dirname(a).split("/")
    right = _dirname(b).split("/")
    n = 0
    for x, y in zip(left, right):
        if x != y:
            break
        n += 1
    return n


def _leaf_files(tree: dict[str, Any], components: dict[str, Any]) -> dict[tuple[str, ...], set[str]]:
    """叶子路径 → 它认领的文件集合。"""
    out: dict[tuple[str, ...], set[str]] = {}
    for path, info in T.iter_nodes(tree):
        if info.get("children"):
            continue
        out[path] = component_files(list(info.get("components") or []), components)
    return out


def file_owner(tree: dict[str, Any], components: dict[str, Any], relative_path: str) -> str | None:
    """该文件被哪个叶子认领（斜杠分隔路径）；无人认领时返回 None。"""
    owners = module_file_owners(tree, components).get(relative_path) or []
    return owners[0] if owners else None


def _nearest_leaf(file_rel: str, leaves: dict[tuple[str, ...], set[str]]) -> tuple[str, ...]:
    def rank(path: tuple[str, ...]) -> tuple[int, int, str]:
        files = leaves[path]
        proximity = max((_shared_prefix(file_rel, f) for f in files), default=0)
        return (-proximity, len(files), "/".join(path))

    return min(leaves, key=rank)


def adopt_unowned_files(
    tree: dict[str, Any],
    components: dict[str, Any],
    opts: UpdateOptions | None = None,
) -> list[str]:
    """把依赖图里没有叶子归属的文件挂到最合适的已有叶子上，返回补挂的文件。

    空树是上游的整仓单页模式，此时没有叶子可挂，直接不动。
    """
    if not tree or not components:
        return []

    expected = component_files(list(components), components)
    owned = set(module_file_owners(tree, components))
    missing = sorted(expected - owned)
    if not missing:
        return []

    options = opts or UpdateOptions()
    valid_types = compute_valid_leaf_types(components)
    owner_map = T.owner_map(tree)
    leaves = _leaf_files(tree, components)
    if not leaves:
        return []

    adopted: list[str] = []
    for rel in missing:
        ids = [cid for cid in components if components[cid].relative_path == rel]
        leafable = filter_leaf_nodes(ids, components, valid_types)
        target = None
        for cid in leafable or ids:
            decision = route_by_rules(cid, components[cid], owner_map, components, options)
            if decision is not None and decision.leaf_path:
                target = decision.leaf_path
                break
        if target is None:
            target = _nearest_leaf(rel, leaves)
        for cid in ids:
            T.add_component(tree, target, cid)
            owner_map[cid] = target
        adopted.append(rel)
        logger.info("dsh: 文件 %s 的 %d 个组件补挂到叶子 %s", rel, len(ids), "/".join(target))

    return adopted
