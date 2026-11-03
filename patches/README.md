# 上游补丁

`.probe-fsoft/` 被 `.gitignore` 排除（它是上游
[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 的 clone + venv），
所以对上游源码的改动**不会随插件仓库一起提交**。这个目录保存那些改动的
diff，让它们可追踪、可复现。

## 并行不再靠改上游源码（0.17.12 起）

`.probe-fsoft/src` 现在**保持上游原样**（`1b4af43d…`，工作区干净）。全量与增量的并行都在
运行期适配器里实现，不往上游源码打补丁：

- `lib/engine/python/full_parallel_runtime.py`：替换 `DocumentationGenerator`
  的 `_generate_modules_in_order`（父等子、兄弟分支并行、`module_tree.json` 锁内合并、
  失败仍按上游契约上抛）。
- `lib/engine/python/fsoft_runtime.py`：替换增量 Step 5 的叶子循环（写集不相交才并行、
  真实写冲突串行重跑、越轮断点续跑）。

两者都由 `lib/engine/python/entry.py` 在构造 `CLIDocumentationGenerator` **之前**安装。
这么做的理由：上游 `documentation_generator.py` 在被覆盖的区域里持续演进（0.17.6 升级时
它新增了 `failures` 列表与「有模块失败就 raise」），而补丁用 `git apply --3way` 每次升级
都要人工解冲突，上一次就因为漏掉一行 `failures.append` 把上游的失败判据悄悄吃掉了。
适配器用源码锚点定位要替换的片段，锚点不存在就**显式失败**，不会静默退回串行。

## upstream-module-parallel.patch（0.16.14 – 0.17.11 的历史补丁，已停用）

- **基准 commit**：`1b4af43d6d20c8dbd758fe1d5f888cc6947ed11d`（2026-11-01，
  上游 `origin/main` 的「update tree-sitter version」）。0.17.6 起它与
  `lib/engine/manifest.js` 的 `UPSTREAM_COMMIT` 是**同一个 commit**：此前锁写的
  `03d0a294…` 在本机 clone 里根本不存在，属于「锁了但锁错」，已废止。
- **状态**：0.17.12 起不再应用。文件保留是因为它记录了一段真实历史（见下），
  并且新适配器的分层与合并策略就是从那版补丁里验证出来的。
- **涉及文件**（当时的）：
  - `codewiki/src/be/documentation_generator.py` — 模块循环改为按拓扑层并行
  - `codewiki/src/config.py` — 新增 `module_concurrency` 配置字段
  - `codewiki/cli/adapters/doc_generator.py` — 透传该配置

### 为什么当初需要它

上游 `_generate_modules_in_order` 是严格串行的
`for module_path, module_name in processing_order: await ...`。
单篇文档是 agentic 工具循环（约 15–20 次 LLM 请求，含 3–4 次长思考），
实测单篇约 12 分钟；16 节点的仓库串跑 180 分钟预算耗尽只写 18 篇
（真机 `job-mvuf1c5b-5`）。

### 为什么后来放弃它

补丁直接改上游源码，只有 `git apply --3way` 能进，而三方合并的冲突点恰好落在
「失败清单」这一行上——漏掉它，并行化就会把「有模块失败就 raise」吃成静默成功。
同样的语义用适配器表达时，`failures` 是我们自己写的循环变量，不存在「合并时漏一行」
这种失败模式。

### 如果仍要打（仅作历史复现）

```bash
cd .probe-fsoft/src
git checkout 1b4af43d6d20c8dbd758fe1d5f888cc6947ed11d   # 或其它基准
git apply --3way ../../patches/upstream-module-parallel.patch
```

两处冲突的收口方式：保留上游新增的 `failures = []`、删掉 `processed_modules`；
保留「只取分支子树合并回主树」的逻辑，并把 `asyncio.gather` 结果里的 `err` 追加成
`failures.append(f"{path}: {err}")`。

### 验证

```bash
node test-upstream-parallel.mjs   # 8 条：同层并行、并发 1 时严格串行、父等子、
                                 # 分支子树合并、真实读-睡-写竞态、单模块失败仍上抛
node test-fsoft-runtime.mjs       # 6 条：增量叶子并行、写冲突串行重跑、断点续跑
```

`moduleConcurrency` 默认 1（串行）。适配器在 `module_concurrency <= 1` 时仍按串行执行，
所以关掉并行不需要卸任何东西。
