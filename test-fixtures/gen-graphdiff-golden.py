#!/usr/bin/env python
"""生成对拍基准：调用 Python 原生 difflib + FSoft 原版函数，输出 JSON。

用途：验证 lib/graph-diff.js 的移植与上游逐位一致。difflib.SequenceMatcher 的
匹配块算法有大量边界情形（空序列、重复 token、autojunk），靠肉眼核对不可信，
必须用 Python 原版喂同一批输入产出期望值，再让 Node 侧比对。
"""
import difflib
import hashlib
import json
import random
import re
import sys

_WS = re.compile(r"\s+")
_TOKEN = re.compile(r"\w+|[^\w\s]")


def normalize_body(text):
    return _WS.sub(" ", (text or "").strip())


def documented_source(code, docstring=""):
    doc = (docstring or "").strip()
    if doc and doc not in (code or ""):
        return f"{doc}\n{code or ''}"
    return code or ""


def body_hash(code, docstring=""):
    return hashlib.sha1(normalize_body(documented_source(code, docstring)).encode("utf-8")).hexdigest()


def _tokens(text):
    return _TOKEN.findall(text or "")


def body_similarity(a, b):
    ta, tb = _tokens(a), _tokens(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()


def unified_body_diff(old_lines, new_lines, label, n=2):
    d = difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{label}", tofile=f"b/{label}", n=n)
    return "".join(d)


def main():
    rng = random.Random(20261027)
    cases = []

    # 1) 相似度用例：覆盖空、完全相同、部分相同、全不同、重复 token
    sim_inputs = [
        ("", ""),
        ("abc", ""),
        ("", "abc"),
        ("alpha beta gamma", "alpha beta gamma"),
        ("alpha beta gamma", "alpha beta delta"),
        ("a b c d e f", "a b c x y f"),
        ("x", "x"),
        ("for (let i = 0; i < n; i++) { sum += i }", "for (let i = 0; i < n; i++) { sum += i * 2 }"),
        ("dup dup dup dup", "dup dup"),
        ("function a(){return 1}", "function b(){return 2}"),
        ("{}[]()", "{}[]("),
        ("\u4e2d\u6587\u6ce8\u91ca abc", "\u4e2d\u6587\u6ce8\u91ca abd"),
        ("x = 1\n  y  =   2", "x = 1\ny = 2"),
    ]
    for _ in range(30):
        n = rng.randint(1, 25)
        alphabet = ["a", "b", "c", "d", "(", ")", "+", "1", "2"]
        s1 = " ".join(rng.choice(alphabet) for _ in range(n))
        m = rng.randint(1, 25)
        s2 = " ".join(rng.choice(alphabet) for _ in range(m))
        sim_inputs.append((s1, s2))

    for a, b in sim_inputs:
        cases.append({
            "kind": "similarity",
            "a": a,
            "b": b,
            "expected": body_similarity(a, b),
        })

    # 2) hash 用例
    hash_inputs = [
        ("", ""),
        ("  a  b  ", ""),
        ("code()", "/** doc */"),
        ("code()", "code()"),
        ("\u4e2d\u6587", "\u8bf4\u660e"),
        ("line1\nline2", "doc"),
    ]
    for code, doc in hash_inputs:
        cases.append({
            "kind": "hash",
            "code": code,
            "docstring": doc,
            "expected": body_hash(code, doc),
        })

    # 3) unified diff 用例（含无末尾换行、纯新增、纯删除、多 hunk）
    diff_inputs = [
        ("", "", "m"),
        ("a\nb\nc", "a\nb\nc", "m"),
        ("a\nb\nc", "a\nx\nc", "m"),
        ("a\nb\nc", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk", "m"),
        ("1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "1\n2\nX\n4\n5\n6\n7\n8\nY\n10", "m"),
        ("only\n", "", "m"),
        ("", "brand\nnew\n", "m"),
        ("no-trailing-newline", "no-trailing-newline-changed", "m"),
        ("a\nb", "a\nb\n", "m"),
    ]
    for old_s, new_s, label in diff_inputs:
        old_lines = old_s.splitlines(keepends=True) if old_s else []
        new_lines = new_s.splitlines(keepends=True) if new_s else []
        cases.append({
            "kind": "unified",
            "oldText": old_s,
            "newText": new_s,
            "label": label,
            "expected": unified_body_diff(old_lines, new_lines, label),
        })

    # 4) 随机 diff 用例
    for _ in range(20):
        n1 = rng.randint(0, 12)
        n2 = rng.randint(0, 12)
        lines1 = [f"L{rng.randint(0,5)}\n" for _ in range(n1)]
        lines2 = [f"L{rng.randint(0,5)}\n" for _ in range(n2)]
        s1 = "".join(lines1)
        s2 = "".join(lines2)
        cases.append({
            "kind": "unified",
            "oldText": s1,
            "newText": s2,
            "label": "r",
            "expected": unified_body_diff(lines1, lines2, "r"),
        })

    json.dump(cases, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
