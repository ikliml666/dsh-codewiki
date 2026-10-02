# Changelog

## 0.2.3 — 2026-10-03

- fix：三个路径/描述缺陷（用户实测报告，Wxxy-CampusLogin 仓库复现）：
  - **MSYS 路径被误判不存在**：win32 上 `/e/...` 形式 Node fs 不认，`existsSync` 失败直接抛「cwd 不存在」。新增 `normalizeCwd`（仅 win32 把 `/x/...` → `X:/...`，POSIX 原样），cw 与 codewiki_generate 两工具 cwd 校验统一接入。
  - **Windows 路径校验通过但结果错**：`resolveBinary` 原先捆绑二进制优先，`bin/cw.exe` 是旧布局（`~/.codewiki`）版本，导致 bash 原生 `cw status` 正常而包装层报 "No wiki found"。改为 binaryPath → PATH 探测（win32 `where` / POSIX `which`）→ 捆绑兜底；捆绑副本同步刷新为当前源码构建（sha256 953adcb5…，与 `~/.cargo/bin/cw.exe` 一致）。
  - **工具描述与实现不符**：描述/wikiPathFor 兜底从 `~/.codewiki/<project>/` 全部对齐上游 `wiki_path()` 的 `<repo>/.codewiki/`（随仓库提交共享）；`projects` 子命令说明改为「只列出 ~/.codewiki 旧位置的项目，一般用不到」。
- test：新增 `test-cwd-paths.mjs`（import 真实 index.js，mock ctx 注册捕获，MSYS / Windows / 不存在路径三态实测）——MSYS 归一化后 `cw path` 返回 `<repo>/.codewiki`、Windows 路径 `cw status` 返回真实三态、非法路径干净报错，ALL PASS。
- 文档：README / CodeWiki.md / client.js（zh+en）/ cordis.patch.yml 同步仓库内 wiki 位置与 PATH 优先顺序。

## 0.2.2 — 2026-10-02

- fix：审查修复 8 项（test-orchestration.mjs 先行 RED：clean + scope=full 强制全量被短路）：
  - `scope=full` 在 clean 态不再被「无需编译」短路，强制全量重编与文档一致；
  - `cw status` 非零退出且无输出时直接抛错（此前二进制缺失/崩溃会被兜底成 stale 空清单白走全量）；
  - 横切文章失败计入 `failedCount`（与 stale / 降级路径口径一致）；
  - `runCw` 响应 `exec.signal`（abort 即 SIGKILL 子进程），cw / codewiki_generate 的全部子进程调用接入；
  - `cw index` / `cw meta update` 失败时 notes 追加「编译基线可能未刷新，可重试」告警；
  - 移除 execute 末尾不可达死代码；
  - 设置页：保存条在 dirty 时不显示「放弃更改」文案 Tag（按钮 disabled 态已表达）；
  - 文档同步：README / CodeWiki 中子代理派发写法与 0.2.1 实现一致（直用注入服务）。
- test：新增「clean + scope=full 强制全量」编排用例；修复前 RED，修复后全 PASS。

## 0.2.1 — 2026-10-02

- fix：子代理服务两处接线断裂，codewiki_generate 一进编译路径即抛错，0.1.0 起从未真正可用（当时验证只做了 node --check 与 CLI 冒烟，没跑过编排路径）：
  - `generateToolDefinition(cfg)` 没接住 `apply()` 传入的 `subagents`（index.js:685 → 432），execute 内 6 处引用即抛 `ReferenceError: subagents is not defined`；
  - `launchAgent(rc, …)` 实际收到的是子代理服务本身，却按 `rc.subagents.start` 取用（index.js:118），前一处修完后又抛 `TypeError: Cannot read properties of undefined (reading 'start')`。
  - 两处均改为直接使用传入的 `subagents` 服务。
- test：新增 `test-orchestration.mjs` 编排行为冒烟（mock 子代理服务 + 真实 cw CLI）：覆盖全量编译（规划→分批写文章→横切→审校→index/meta update）与 stale 逐篇更新两条路径。修复前 RED（精确复现 ReferenceError@598），修复后 PASS。

## 0.2.0 — 2026-10-01

- 新增插件页设置 UI（`client.js`，浏览器半侧）：插件管理页 Official 组出现 **CodeWiki** 条目（`plugins.item`，id `codewiki`，order 30），点进详情页可设置：
  - **编译模型**：provider/model 级联下拉（目录来自 `ctx.remote.session.modelCatalog()`，4s×3 退避重试 + `llm/adapters-updated` / `connection/reset` 刷新；目录不可用退化为文本输入）。
  - **运行**：启用开关、写文章并发上限（1–2 校验）、文章语言、cw 可执行路径。
  - 保存经 `configForms.mutate` 单层 op（revision CAS），脏检测 + 放弃更改 + 冲突提示；与 patch 文件手改等价，均热生效。
- `package.json`：加 `exports["./client"]` + `dsh.client.platform: "web"`——宿主 client 扫描器沿 file:/// 挂载条目发现本包（无需 profile link）；「非 client 包」判定按条目缓存，**生效需重启 dsh**。
- 注册形状对齐已装插件实证：`locale.bind/register`（词典值全字符串）、`slots.inject('plugins.item', …)` 包 `configForms.whileServed([NS], …)`、React `el()` + dsh-client-ui-primitives（Switch/Button/Input/Pill/StateDot/Tag）。
- 静态验证：`node --check client.js` / `index.js` 通过；`package.json` 解析校验通过（exports + dsh.client 齐全）。设置页 UI 需重启后在插件页实测。

## 0.1.1 — 2026-10-01

- 移除 `codewiki` 技能（skills/codewiki.md 与 skillProvider 注册一并删除）：保留纯工具面（`cw` + `codewiki_generate`），wiki 编译一律走工具。
- `defaultProvider`/`defaultModel` 默认值从空改为 `aliyun-bailian`/`qwen3.8-flash`（即路由插件 wiki 档）：不传参时子代理固定走便宜模型；显式置空两项才继承会话模型。

## 0.1.0 — 2026-10-01

首次发布。

- 工具 `cw`：CodeWiki CLI 薄封装（子命令白名单：init/status/index/meta/path/projects/setup/uninstall；120s 超时）。
- 工具 `codewiki_generate`：智能体编排编译（规划 → 分批写文章 ≤2 并发 → 横切 → 审校 → index + meta update），支持 provider+model 指定子代理模型、scope auto/full/stale、规划失败降级单 agent、部分失败不刷新基线。
- 技能 `codewiki`：上游 codewiki-session.md 的 DSH 适配版。
- vendor 上游 codewiki（mraza007/codewiki @ HEAD，MIT），cargo release 编译出 `bin/cw.exe`。
- 挂载：profile cordis.patch.yml file:/// 直挂（id `codewiki`）；`@deepseek-ai/schemastery` 本地 junction → harness vendor。

验证记录（2026-10-01）：

- `node --check index.js` 通过；`import(index.js)` 通过（name/apply/Config 导出齐全）。
- CLI 冒烟（/tmp/cw-smoke 临时 git 仓库）：`cw init` / `path` / `projects` / `status` 三态（No wiki found → has not been compiled → up to date）/ `index`（2 articles）/ `meta update` / 提交后 stale 判定（`Changed since last compile` + `M src/app.py` + `Stale articles: ! modules\app.md`）全部符合预期；注意 stale 文章路径是反斜杠，插件侧已归一。
- 挂载生效需重启 dsh（CWD 配置热读取，但插件注册本身不热加载）。
