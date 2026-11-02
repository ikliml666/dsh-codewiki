# 上游补丁

`.probe-fsoft/` 被 `.gitignore` 排除（它是上游
[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 的 clone + venv），
所以对上游源码的改动**不会随插件仓库一起提交**。这个目录保存那些改动的
diff，让它们可追踪、可复现。

## upstream-module-parallel.patch

- **基准 commit**：`1b4af43d6d20c8dbd758fe1d5f888cc6947ed11d`（2026-11-01，
  上游 `origin/main` 的「update tree-sitter version」）。0.17.6 起它与
  `lib/engine/manifest.js` 的 `UPSTREAM_COMMIT` 是**同一个 commit**：此前锁写的
  `03d0a294…` 在本机 clone 里根本不存在，属于「锁了但锁错」，已废止。
  打补丁前先 `git -C .probe-fsoft/src log -1` 核对 HEAD，不一致就按下面的
  「升级上游」重新导出，别硬套。
- **引入版本**：插件 0.16.14
- **涉及文件**：
  - `codewiki/src/be/documentation_generator.py` — 模块循环改为按拓扑层并行
  - `codewiki/src/config.py` — 新增 `module_concurrency` 配置字段
  - `codewiki/cli/adapters/doc_generator.py` — 透传该配置

### 为什么需要它

上游 `_generate_modules_in_order` 是严格串行的
`for module_path, module_name in processing_order: await ...`。
单篇文档是 agentic 工具循环（约 15–20 次 LLM 请求，含 3–4 次长思考），
实测单篇约 12 分钟；16 节点的仓库串跑 180 分钟预算耗尽只写 18 篇
（真机 `job-mvuf1c5b-5`）。

### 应用方式

```bash
cd .probe-fsoft/src
git checkout 1b4af43d6d20c8dbd758fe1d5f888cc6947ed11d   # 或其它基准
git apply --3way ../../patches/upstream-module-parallel.patch
```

`--3way` 是必需的：上游 `documentation_generator.py` 在本补丁覆盖的区域里
持续演进（0.17.6 升级时它新增了 `failures` 列表与「有模块失败就 raise」），
纯 `git apply` 会整块拒绝。三方合并的冲突只有两处，按下面收口：

- 保留上游新增的 `failures = []`，删掉本补丁不再需要的 `processed_modules`；
- 保留本补丁的「只取分支子树合并回主树」逻辑，并把 `asyncio.gather` 结果里的
  `err` 追加成 `failures.append(f"{path}: {err}")` —— 并行分支的失败必须进上游
  的失败清单，否则并行化会把上游「模块失败即报错」的判据悄悄吃掉。

### 升级上游时

`git apply` 若冲突，按 `docs/fsoft-native-engine.md` 的升级流程处理，
并重新导出本补丁：

```bash
cd .probe-fsoft/src && git diff > ../../patches/upstream-module-parallel.patch
```

### 验证

```bash
node test-upstream-parallel.mjs   # 6 条，含并发度 1 的向后兼容与反向验证
```

默认 `module_concurrency = 1`（串行），未打补丁的上游只是少了并行能力，
不会报错——`entry.py` 下发的配置项会被静默忽略。
