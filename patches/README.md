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

`moduleConcurrency` 默认 1（串行）。适配器在 `module_concurrency <= 1` 时仍按串行执行，
所以关掉并行不需要卸任何东西。

## 一个已删除的历史补丁（0.16.14 – 0.17.11）

那段时期用 `patches/upstream-module-parallel.patch` 直接改上游源码做模块并行，0.17.12
起被上面的适配器取代，补丁文件已删除。保留这条记录的用处是记住它的教训：

上游 `_generate_modules_in_order` 是严格串行的
`for module_path, module_name in processing_order: await ...`。
单篇文档是 agentic 工具循环（约 15–20 次 LLM 请求，含 3–4 次长思考），
实测单篇约 12 分钟；16 节点的仓库串跑 180 分钟预算耗尽只写 18 篇
（真机 `job-mvuf1c5b-5`）。

为什么放弃补丁：它只有 `git apply --3way` 能进，而三方合并的冲突点恰好落在
「失败清单」这一行上——漏掉它，并行化就会把「有模块失败就 raise」吃成静默成功。
同样的语义用适配器表达时，`failures` 是我们自己写的循环变量，不存在「合并时漏一行」
这种失败模式。
