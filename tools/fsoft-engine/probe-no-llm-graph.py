"""阶段 1A 验收探针：无 LLM 的原生依赖图（handle_analyze_repo）在中文/空格路径下跑通。

这是**引擎侧**的验收，不碰 DSH 插件、不需要任何模型或凭证：FSoft 的
`handle_analyze_repo` 走 tree-sitter 静态分析，是整条迁移里唯一完全无模型的一环，
所以它先跑通，才能在阶段 1B/1C 里把「模型链路」和「图/artifact 链路」的故障分开定位。

用法（参数化，可在任意 FSoft 源码树/fixture 上重跑）：

    python probe-no-llm-graph.py --fsoft-src <FSoft 仓库根，含 codewiki/ 包> \
                                 --fixture <被测小仓库> --out <工作目录>

判据（全部必须为真）：
  R1 handle_analyze_repo 返回非 error JSON，含 session_id / files
  R2 组件数 > 0，叶子节点数 > 0，语言集合含 python 与 typescript
  R3 依赖图里存在 core.engine -> web.handler 方向的边（web 依赖 core）
  R4 workspace 里的 component_index.json / leaf_nodes.json / summary.json 真实存在且可解析
  R5 artifact 采集到 scripts/run.py（artifact 节点存在）

输出一份 JSON 结果到 stdout，并以退出码表达通过/失败（0=全过，2=判据未过，3=异常）。
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_FIXTURE = HERE / "fixtures" / "中文 空格 fixture"


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--fsoft-src",
        required=True,
        help="FSoft 源码根目录（其下应有 codewiki/ 包；也接受直接指向 codewiki/ 的父目录）",
    )
    p.add_argument("--fixture", default=str(DEFAULT_FIXTURE), help="被测小仓库路径（默认用仓库内 fixture）")
    p.add_argument("--out", default=str(HERE / "out-1a"), help="工作/输出目录（会被创建）")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    src_root = Path(args.fsoft_src).resolve()
    fixture = Path(args.fixture).resolve()
    out = Path(args.out).resolve()

    if not (src_root / "codewiki").is_dir():
        print(json.dumps({"ok": False, "error": f"--fsoft-src 下没有 codewiki/ 包：{src_root}"}, ensure_ascii=False))
        return 3
    if not fixture.is_dir():
        print(json.dumps({"ok": False, "error": f"--fixture 不存在：{fixture}"}, ensure_ascii=False))
        return 3

    sys.path.insert(0, str(src_root))
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"checks": {}, "ok": False, "fsoft_src": str(src_root), "fixture": str(fixture)}
    try:
        from codewiki.mcp.session import SessionStore
        from codewiki.mcp.tools.analysis import handle_analyze_repo

        store = SessionStore()
        raw = handle_analyze_repo(
            {
                "repo_path": str(fixture),
                "output_dir": str(out),
                "use_gitignore": False,
            },
            store,
        )
        payload = json.loads(raw)
        result["payload_keys"] = sorted(payload.keys())
        result["raw_len"] = len(raw)

        # R1
        r1 = "error" not in payload and bool(payload.get("session_id")) and bool(payload.get("files"))
        result["checks"]["R1_analyze_returned"] = r1
        if not r1:
            result["payload_head"] = raw[:2000]
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 2

        stats = payload.get("stats") or {}
        result["stats"] = stats

        # R2
        langs = {str(k).lower() for k in (stats.get("languages") or {})}
        r2 = (
            int(stats.get("total_components") or 0) > 0
            and int(stats.get("total_leaf_nodes") or 0) > 0
            and any("python" in l for l in langs)
            and any("typescript" in l for l in langs)
        )
        result["checks"]["R2_nodes_and_languages"] = r2

        # R4 workspace 文件
        files = payload.get("files") or {}
        r4 = True
        seen = {}
        for key in ("component_index", "leaf_nodes", "summary"):
            p = Path(files.get(key, ""))
            exists = p.is_file()
            parsed = None
            if exists:
                try:
                    parsed = json.loads(p.read_text(encoding="utf-8"))
                except Exception as e:  # noqa: BLE001
                    exists = False
                    seen[key + "_error"] = str(e)
            seen[key] = {
                "path": str(p),
                "exists": exists,
                "items": (len(parsed) if isinstance(parsed, list) else len(parsed or {})),
            }
            r4 = r4 and exists
        result["workspace_files"] = seen
        result["checks"]["R4_workspace_files"] = r4

        # R3 依赖边：直接调 builder 拿 components（含 dependsOn / edges）
        from codewiki.src.be.dependency_analyzer import DependencyGraphBuilder
        from codewiki.src.config import Config

        cfg = Config(
            repo_path=str(fixture),
            output_dir=str(out / "temp"),
            dependency_graph_dir=str(out / "temp" / "dependency_graphs"),
            docs_dir=str(out),
            max_depth=2,
            llm_base_url="not-needed",
            llm_api_key="not-needed",
            main_model="unused",
            cluster_model="unused",
            use_gitignore=False,
        )
        components, leaf_nodes = DependencyGraphBuilder(cfg).build_dependency_graph()

        edge_report = []
        has_edge = False
        for cid, node in components.items():
            deps = getattr(node, "dependsOn", None)
            if deps is None:
                deps = getattr(node, "depends_on", None)
            deps = list(deps or [])
            if deps:
                edge_report.append({"id": cid, "dependsOn": deps})
            joined = " ".join(str(d) for d in deps)
            if "engine" in joined and "handler" in cid:
                has_edge = True
        result["edge_sample"] = edge_report[:20]
        result["edge_count"] = len(edge_report)
        # 允许经 builder 的边表；退一步用 handler 组件是否声明了 core 依赖
        if not has_edge:
            for cid in components:
                if "handler" in cid and any(
                    "engine" in str(d) for d in (getattr(components[cid], "dependsOn", None) or [])
                ):
                    has_edge = True
        result["checks"]["R3_dependency_edge"] = has_edge

        # R5 artifact
        artifact_ids = [cid for cid in components if "run.py" in cid]
        result["artifact_ids"] = artifact_ids[:10]
        result["checks"]["R5_artifact_node"] = bool(artifact_ids)

        result["ok"] = all(result["checks"].values())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 2
    except Exception:
        result["exception"] = traceback.format_exc()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
