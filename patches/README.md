# 上游补丁

`.probe-fsoft/` 被 `.gitignore` 排除（它是上游
[FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) 的 clone + venv），
所以对上游源码的改动**不会随插件仓库一起提交**。这个目录保存那些改动的
diff，让它们可追踪、可复现。

## upstream-module-parallel.patch

- **基准 commit**：`364b67a166bc113f69a50382cb277c55e3f79cee`
  （本机 `.probe-fsoft/src` 的 HEAD；**注意它与 `lib/engine/manifest.js` 的
  `UPSTREAM_COMMIT`（`03d0a294…`）并不相同** —— 本地 clone 是浅克隆，比锁的
  commit 新两个 PR。打补丁前先 `git -C .probe-fsoft/src log -1` 核对 HEAD，
  不一致就按下面的「升级上游」重新导出，别硬套。）
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
git checkout 364b67a166bc113f69a50382cb277c55e3f79cee   # 或其它基准
git apply ../../patches/upstream-module-parallel.patch
```

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
