"""FSoft 全量文档生成的受控并行。

上游 `DocumentationGenerator._generate_modules_in_order` 是严格串行的：
`for module_path, module_name in processing_order: await ...`，单篇约 12 分钟。
这里只替换这一个方法，把同一父节点下的兄弟模块并发执行，并保证：

  1. 父模块必须等它所有子模块结束（拓扑顺序不能被并行破坏）；
  2. 并行分支各自往 module_tree 里加的子模块都要合并回主树，不能互相覆盖；
  3. 单个模块失败不拖垮同批其它模块，失败清单仍然上抛（上游 1b4af43 起
     有模块失败就 raise，这条判据不能被并行化吃掉）；
  4. 每个模块开始前从**磁盘**重读 module_tree（子模块可能是兄弟分支刚写进去的），
     用磁盘状态而不是内存快照决定它是否还有子节点、components 是什么。

做法：按初始树递归调度。父节点的孩子先全部 await（受信号量限流），
再生成父页。这样不需要 AgentSlots 那种“父等待时让出槽位”的机制——
父节点此时根本没占槽位，不会自锁。

上游源码锚点变化时安装直接失败，不静默退回串行。
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from codewiki.src.be.documentation_generator import DocumentationGenerator
from codewiki.src.utils import file_manager

logger = logging.getLogger(__name__)

ADAPTER_VERSION = 1

# 模块级并发度：由 entry.py 在构造 generator 之前设置；1 表示上游原始串行。
_CONCURRENCY = 1
_CONCURRENCY_LOCK = threading.Lock()

_ORIGINAL_RUN = DocumentationGenerator._generate_modules_in_order
_INSTALLED = False

# module_tree.json 的并发读写保护：并行分支各自保存自己的子模块，必须
# read-merge-write，否则后写的分支会把先写的子模块覆盖掉。
_TREE_LOCK = threading.RLock()


def configure_full_runtime(concurrency: int) -> None:
    """设置模块级并发度（1 = 上游串行）。"""
    global _CONCURRENCY
    with _CONCURRENCY_LOCK:
        _CONCURRENCY = max(1, int(concurrency or 1))


def current_concurrency() -> int:
    with _CONCURRENCY_LOCK:
        return _CONCURRENCY


def _merge_tree(base: dict[str, Any], incoming: dict[str, Any], path: str = "") -> dict[str, Any]:
    """把 incoming 合并进 base：只补缺，冲突显式报错。

    模块路径是全局唯一的；同一个路径出现两份不同的组件归属，说明两个分支
    对同一模块给出了不一致的定义，静默取一个会丢内容且无法回溯。
    """
    for name, node in (incoming or {}).items():
        here = f"{path}/{name}" if path else name
        if name not in base:
            base[name] = copy.deepcopy(node)
            continue
        old = base[name]
        if not isinstance(old, dict) or not isinstance(node, dict):
            raise RuntimeError(f"module_tree 冲突：{here} 不是对象")
        old_components = old.get("components") or []
        new_components = node.get("components") or []
        if old_components and new_components and list(old_components) != list(new_components):
            raise RuntimeError(
                f"module_tree 冲突：{here} 在两个并行分支里组件归属不一致"
            )
        if new_components and not old_components:
            old["components"] = list(new_components)
        old_children = old.get("children") or {}
        new_children = node.get("children") or {}
        if new_children:
            merged_children = _merge_tree(
                copy.deepcopy(old_children) if not isinstance(old_children, dict) else old_children,
                new_children,
                here,
            )
            old["children"] = merged_children
        for key, value in node.items():
            if key in ("components", "children"):
                continue
            if key not in old:
                old[key] = copy.deepcopy(value)
    return base


class _SharedTreeIO:
    """串行化 module_tree.json 的读改写，并把并行分支的增量合并回主树。"""

    def __init__(self, original: Any) -> None:
        self._original = original

    def save_json(self, data: Any, filepath: str) -> None:
        if os.path.basename(str(filepath)) != "module_tree.json":
            return self._original.save_json(data, filepath)
        with _TREE_LOCK:
            existing = self._original.load_json(filepath)
            merged = _merge_tree(
                existing if isinstance(existing, dict) else {},
                data if isinstance(data, dict) else {},
            )
            self._original.save_json(merged, filepath)

    def load_json(self, filepath: str):
        if os.path.basename(str(filepath)) != "module_tree.json":
            return self._original.load_json(filepath)
        with _TREE_LOCK:
            return self._original.load_json(filepath)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._original, name)


def _node_at(tree: dict[str, Any], module_path: list[str]) -> dict[str, Any] | None:
    node: Any = tree
    for part in module_path:
        if not isinstance(node, dict):
            return None
        node = node.get(part)
        if node is None:
            return None
        if part != module_path[-1]:
            node = node.get("children", {})
    return node if isinstance(node, dict) else None


async def _run_module(
    gen: DocumentationGenerator,
    components: dict[str, Any],
    module_path: list[str],
    module_name: str,
    working_dir: str,
    module_tree_path: str,
    semaphore: asyncio.Semaphore,
    failures: list[str],
) -> None:
    key = "/".join(module_path)
    # 必须在进入信号量之后、真正开始前重读磁盘：兄弟分支可能刚写入了新的子模块
    # 或改了树形状，用旧快照会走错分支（把有子模块的父模块当叶子写）。
    async with semaphore:
        try:
            tree = file_manager.load_json(module_tree_path) or {}
            node = _node_at(tree, module_path)
            if node is None:
                failures.append(f"{key}: 模块在 module_tree 中已不存在")
                return
            if DocumentationGenerator.is_leaf_module(node):
                logger.info(f"📄 Processing leaf module: {key}")
                await gen.backend.run_module_agent(
                    module_name=module_name,
                    components=components,
                    core_component_ids=node.get("components") or [],
                    module_path=module_path,
                    working_dir=working_dir,
                )
            else:
                logger.info(f"📁 Processing parent module: {key}")
                await gen.generate_parent_module_docs(module_path, working_dir)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — 一个模块失败不能中断整批
            failures.append(f"{key}: {exc}")
            logger.error(f"Failed to process module {key}: {exc!s}")


async def _walk(
    gen: DocumentationGenerator,
    components: dict[str, Any],
    module_path: list[str],
    module_name: str,
    working_dir: str,
    module_tree_path: str,
    tree: dict[str, Any],
    semaphore: asyncio.Semaphore,
    failures: list[str],
) -> None:
    node = tree.get(module_name) or {}
    children = node.get("children") or {}
    if isinstance(children, dict) and children:
        await asyncio.gather(*(
            _walk(
                gen, components, module_path + [child_name], child_name,
                working_dir, module_tree_path, children, semaphore, failures,
            )
            for child_name in children.keys()
        ))
    await _run_module(
        gen, components, module_path, module_name,
        working_dir, module_tree_path, semaphore, failures,
    )


async def _run_parallel(
    gen: DocumentationGenerator,
    components: dict[str, Any],
    leaf_nodes: list[str],
    working_dir: str,
    module_tree_path: str,
    module_tree: dict[str, Any],
) -> str:
    failures: list[str] = []
    if module_tree:
        concurrency = max(1, current_concurrency())
        semaphore = asyncio.Semaphore(concurrency)
        await asyncio.gather(*(
            _walk(
                gen, components, [name], name, working_dir, module_tree_path,
                module_tree, semaphore, failures,
            )
            for name in module_tree.keys()
        ))
        # 根总览：所有顶层模块写完后统一生成（与上游顺序一致）
        logger.info("📚 Generating repository overview")
        try:
            await gen.generate_parent_module_docs([], working_dir, components=components)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            failures.append(f"overview: {exc}")
            logger.error(f"Failed to generate repo overview: {exc!s}")
    else:
        # 与上游完全一致的整仓分支：小仓库直接当一个模块写。
        repo_name = os.path.basename(os.path.normpath(gen.config.repo_path))
        repo_overview_path = os.path.join(working_dir, f"{repo_name}.md")
        overview_path = os.path.join(working_dir, "overview.md")
        from codewiki.src.be.overview_support import preserve_incomplete_overviews
        from codewiki.src.be.module_scope import complete_file_candidates

        with preserve_incomplete_overviews([repo_overview_path, overview_path]):
            final_tree = await gen.backend.run_module_agent(
                module_name=repo_name,
                components=components,
                core_component_ids=complete_file_candidates(leaf_nodes, components),
                module_path=[],
                working_dir=working_dir,
            )
            from codewiki.src.be.module_scope import validate_module_file_coverage

            validate_module_file_coverage(final_tree, components)
            file_manager.save_json(final_tree, module_tree_path)
            if os.path.exists(repo_overview_path):
                os.replace(repo_overview_path, overview_path)

    # 收尾三件事必须保留：覆盖校验、页面归位、失败上抛。
    from codewiki.src.be.module_scope import validate_module_file_coverage

    validate_module_file_coverage(file_manager.load_json(module_tree_path), components)
    from codewiki.src.be.documentation_generator import organize_docs, config_layout

    organize_docs(working_dir, config_layout(gen.config))
    if failures:
        raise RuntimeError("Documentation failed for modules: " + "; ".join(failures))
    return working_dir


_IO_INSTALLED = False


def _install_shared_tree_io() -> None:
    """在 FileManager 类上串行化 module_tree.json 的读改写（全进程一次）。"""
    global _IO_INSTALLED
    if _IO_INSTALLED:
        return
    original_save = file_manager.__class__.save_json
    original_load = file_manager.__class__.load_json

    def save_json(data, filepath):
        if os.path.basename(str(filepath)) != "module_tree.json":
            return original_save(data, filepath)
        with _TREE_LOCK:
            existing = original_load(filepath)
            merged = _merge_tree(
                existing if isinstance(existing, dict) else {},
                data if isinstance(data, dict) else {},
            )
            return original_save(merged, filepath)

    def load_json(filepath):
        if os.path.basename(str(filepath)) != "module_tree.json":
            return original_load(filepath)
        with _TREE_LOCK:
            return original_load(filepath)

    file_manager.__class__.save_json = staticmethod(save_json)
    file_manager.__class__.load_json = staticmethod(load_json)
    _IO_INSTALLED = True


def install_full_runtime(concurrency: int | None = None) -> None:
    """把 `_generate_modules_in_order` 换成并行版本（幂等）。"""
    global _INSTALLED
    if concurrency is not None:
        configure_full_runtime(concurrency)
    if _INSTALLED:
        return
    if DocumentationGenerator._generate_modules_in_order is not _ORIGINAL_RUN:
        raise RuntimeError(
            "FSoft DocumentationGenerator._generate_modules_in_order 已被其它适配器替换，拒绝重复安装"
        )
    # 并行分支各自 `from codewiki.src.utils import file_manager` 时拿到的是同一个类对象，
    # 因此必须在**类方法**上串行化读写；只替换 documentation_generator 模块里的名字，
    # 真实后端（pydantic_ai_backend / caw_backend）仍会用自己 import 的那份，
    # 两条分支的 read-modify-write 会互相覆盖，后写者的子模块直接丢失。
    _install_shared_tree_io()

    async def _generate_modules_in_order(
        self,
        components,
        leaf_nodes,
        working_dir,
        module_tree_path,
        module_tree,
        processing_order=None,
    ):
        # processing_order 由上游按顶层顺序给出；并行实现自己按树递归，
        # 但接受该参数以保持签名兼容（上游调用点仍然会传）。
        del processing_order
        return await _run_parallel(
            self, components, leaf_nodes, working_dir, module_tree_path, module_tree
        )

    DocumentationGenerator._generate_modules_in_order = _generate_modules_in_order
    _INSTALLED = True
    logger.info("dsh: 全量模块并行已安装（concurrency=%s）", current_concurrency())
