// LLM 驱动的模块聚类 —— 对应 FSoft-AI4Code/CodeWiki 的
//   src/be/cluster_modules.py + prompt_template.py 的 CLUSTER_REPO_PROMPT /
//   CLUSTER_MODULE_PROMPT / SUPER_GROUP_PROMPT 三段式。
//
// 上游流程：
//   1. cluster_modules()：把所有叶子组件交给 LLM，分成「叶子模块」；
//   2. 对每个叶子模块递归下钻（走 module_tree 分支的 prompt），产出子模块；
//   3. super_group_modules()：把层级过浅的平铺模块重新聚成「架构子系统」。
//
// 本模块的差异：
//   - 上游用 Python dict 层层递归 + 落盘 module_tree.json；这里用纯函数 + 显式层级，
//     便于测试（注入 completer 就不碰网络）。
//   - 上游把「要不要下钻」交给 LLM 回复里的嵌套结构；这里用显式阈值（组件数 /
//     是否已有子目录）决定下钻，减少请求数——大仓库上一次全量聚类几十次请求不可接受。
//   - 组件 id 用 `path#name`（本插件的 symbols.js 约定），提示词里说明清楚。
//
// 契约：
//   clusterComponents({ components, tree?, llmCall, ... }) ->
//     { modules: [{ name, summary, files, components, children?, parent? }], concepts: [], stats }
//   llmCall 形如 async (prompt) => string；不传则纯本地启发式（无网络可跑、可测）。

import path from 'node:path'

// ---------------------------------------------------------------------------
// 组件的提示词表示：按文件分组，比一长串平铺 id 更省 token，也更利于模型看出归属
// ---------------------------------------------------------------------------

export function formatComponents(components) {
  const byFile = new Map()
  for (const c of components) {
    const file = c.relativePath
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(c)
  }
  const lines = []
  for (const file of [...byFile.keys()].sort()) {
    const nodes = byFile.get(file)
    lines.push(`# ${file}${artifactTag(file)}`)
    for (const n of nodes) {
      // 只给「名字 + 类型 + 一行签名」，不给全文：聚类看结构关系，不需要函数体
      const sig = n.parameters?.length ? `(${n.parameters.slice(0, 6).join(', ')}${n.parameters.length > 6 ? ', …' : ''})` : ''
      lines.push(`\t${n.id}\t${n.kind}\t${n.name}${sig}`)
    }
  }
  return lines.join('\n')
}

const ARTIFACT_RE = /(^|\/)(package\.json|tsconfig[^/]*\.json|Cargo\.toml|pyproject\.toml|setup\.py|go\.mod|Makefile|Dockerfile[^/]*|\.[\w.-]+rc|[\w.-]+\.ya?ml|[\w.-]+\.toml|[\w.-]+\.json)$/i
function artifactTag(file) {
  return ARTIFACT_RE.test(file) ? ' (artifact: config)' : ''
}

// ---------------------------------------------------------------------------
// 提示词：结构与上游 CLUSTER_REPO_PROMPT 一致，但明确 id 形态与输出必须可解析
// ---------------------------------------------------------------------------

export function clusterPrompt(componentText, totalComponents) {
  return `你在为一个代码仓库划分模块，供后续逐模块撰写架构文档。

下面是仓库的全部核心组件（按文件分组）。每行格式：组件ID <TAB> 类型 <TAB> 名称(参数)。
组件ID 形如 \`<相对路径>#<符号名>\`，**必须原样返回，不要截断、不要改写分隔符**。

<POTENTIAL_CORE_COMPONENTS>
${componentText}
</POTENTIAL_CORE_COMPONENTS>

请把这些组件分组成若干模块，使每个模块内的组件紧密相关、合起来构成一个有明确职责的单元。
要求：
- 每个组件必须且只能出现在一个模块里，不得遗漏（共 ${totalComponents} 个组件）。
- 标了 (artifact: config) 的文件描述构建/打包/配置/测试方式，它们同样重要：归入专门的 build/config 模块，或附到它所配置的模块。
- 模块之间规模尽量均衡；单个模块建议 5–40 个组件。职责确实单一的小文件可与同目录相关文件合并。
- 模块名用简短英文小写下划线名（如 \`auth\`、\`wiki_compile\`、\`panel_ui\`），不要用目录名直译，要体现职责。
- path 填该模块主要所在的目录（仓库相对路径，POSIX 风格）。

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 围栏：
{
  "modules": [
    { "name": "模块名", "path": "主要目录", "summary": "一句话职责", "components": ["组件ID", "..."] }
  ]
}`
}

// 下钻提示词：给一个已聚好的模块，要求拆成更小的子模块
export function subClusterPrompt(moduleName, componentText, totalComponents) {
  return `模块「${moduleName}」目前的组件如下（按文件分组，每行：组件ID <TAB> 类型 <TAB> 名称）。
这是仓库里一个较大的模块，需要拆成更小的子模块以便分开成文。

<POTENTIAL_CORE_COMPONENTS>
${componentText}
</POTENTIAL_CORE_COMPONENTS>

要求：
- 每个组件必须且只能出现在一个子模块里，不得遗漏（共 ${totalComponents} 个组件）。
- 若这些组件确实同属一个不可再分的职责，就返回一个子模块（保持原名），不要硬拆。
- 子模块名用简短英文小写下划线名，体现该子模块在这一层里的角色。

只输出一个 JSON 对象，不要解释、不要围栏：
{
  "modules": [
    { "name": "子模块名", "path": "目录", "summary": "一句话职责", "components": ["组件ID", "..."] }
  ]
}`
}

// 超级分组：把等价层级的模块按架构角色归成子系统（上游 SUPER_GROUP_PROMPT）
export function superGroupPrompt(modules) {
  const listing = modules.map((m) => `- ${m.name} (path: ${m.path}, ${m.components?.length ?? 0} 组件): ${m.summary ?? ''}`).join('\n')
  return `下面是一个仓库的顶层模块清单。这些模块是平铺的：有概念关联的模块和无关的模块挨在一起。
请把它们归组成更高层的**架构子系统**，让仓库读起来像一套架构，而不是一串目录。

<MODULES>
${listing}
</MODULES>

要求：
- 每个子系统是一组共同承担同一架构职责的模块（例如：编译流水线、界面层、共享基础设施）。
- 用架构角色命名子系统，不要用目录名。
- 子系统数量必须显著少于模块数量，不要把清单原样返回。
- 子系统应包含多个模块；只有当一个模块确实与其他任何模块都不共享职责时才单独成组。
- 每个模块必须且只能归属一个子系统。
- 模块名原样返回，不要改名或截断。

只输出一个 JSON 对象，不要解释、不要围栏：
{
  "subsystems": [
    { "name": "子系统名", "modules": ["模块名", "..."] }
  ]
}`
}

// ---------------------------------------------------------------------------
// 解析：模型可能带前后废话、markdown 围栏、或写成 ```json；一律尽力抢救
// ---------------------------------------------------------------------------

export function parseJsonLoose(text) {
  if (!text) return null
  let s = String(text).trim()
  // 剥 markdown 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // 直接试
  try { return JSON.parse(s) } catch { /* 继续 */ }
  // 取第一个 { 到最后一个 } 之间
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const body = s.slice(start, end + 1)
    try { return JSON.parse(body) } catch { /* 继续 */ }
    // 去掉尾部多余逗号再试
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')) } catch { /* 继续 */ }
  }
  return null
}

// 从模型回复里取出模块数组；同时做 id 校验与去重
export function parseClusterResponse(text, validIds, warnings = []) {
  const obj = parseJsonLoose(text)
  if (!obj) {
    warnings.push('聚类回复不是合法 JSON')
    return null
  }
  const raw = Array.isArray(obj) ? obj : (obj.modules ?? obj.groups ?? null)
  if (!Array.isArray(raw)) {
    warnings.push('聚类回复缺少 modules 数组')
    return null
  }
  const known = new Set(validIds)
  const seen = new Set()
  const modules = []
  for (const m of raw) {
    const name = String(m?.name ?? m?.module_name ?? '').trim()
    const ids = Array.isArray(m?.components) ? m.components : []
    const kept = []
    for (const id of ids) {
      const s = String(id ?? '').trim()
      if (!known.has(s)) { warnings.push(`聚类返回了不存在的组件 id：${s.slice(0, 120)}`); continue }
      if (seen.has(s)) { warnings.push(`组件被重复分配（已丢弃后出现的）：${s.slice(0, 120)}`); continue }
      seen.add(s)
      kept.push(s)
    }
    if (!name || !kept.length) continue
    modules.push({
      name: normalizeModuleName(name),
      path: String(m?.path ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '') || guessPath(kept),
      summary: String(m?.summary ?? m?.description ?? '').trim(),
      components: kept,
    })
  }
  if (!modules.length) {
    warnings.push('聚类回复没有可用的模块')
    return null
  }
  const missing = validIds.filter((id) => !seen.has(id))
  return { modules, missing }
}

// 模块名统一成文件名友好的形式（会进 <name>.md，不能带路径分隔符与空格）
export function normalizeModuleName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fff-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase() || 'module'
}

function guessPath(ids) {
  const first = String(ids[0] ?? '')
  const file = first.split('#')[0]
  return path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)
}

// ---------------------------------------------------------------------------
// 本地启发式聚类（无 LLM 时的降级路径，也用于补齐 LLM 漏掉的组件）
// 按顶层目录分组，与插件 0.10.7 起的 localPlan 同策略——它不是最优，但永不断链。
// ---------------------------------------------------------------------------

export function heuristicCluster(components) {
  const groupBy = (depth) => {
    const groups = new Map()
    for (const c of components) {
      const parts = c.relativePath.split('/')
      // depth=1 取第一段；depth=2 取前两段（不足两段时退回第一段）
      const key = parts.length > depth ? parts.slice(0, depth).join('/') : (parts.length > 1 ? parts[0] : 'root')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(c.id)
    }
    return groups
  }
  let groups = groupBy(1)
  // 单顶层目录（极常见的 src/ 布局）下，只看第一段会把整个仓库塞进一个模块。
  // 下探一层多给几个模块；下探后仍只有一个组就用原分组。
  if (groups.size === 1) {
    const deeper = groupBy(2)
    if (deeper.size > 1) groups = deeper
  }
  return [...groups.entries()].map(([name, ids]) => ({
    name: normalizeModuleName(name),
    path: name === 'root' ? '' : name,
    summary: `${name === 'root' ? '仓库根' : name} 目录下的源码`,
    components: ids,
  }))
}

// 把 LLM 漏掉的组件按目录补回最相近的模块；实在没有就新建一个 misc
export function fillMissing(modules, components, missingIds) {
  if (!missingIds.length) return modules
  const byId = new Map(components.map((c) => [c.id, c]))
  const leftovers = []
  for (const id of missingIds) {
    const c = byId.get(id)
    if (!c) continue
    const dir = path.posix.dirname(c.relativePath)
    const hit = modules.find((m) => m.path && (dir === m.path || dir.startsWith(`${m.path}/`)))
    if (hit) hit.components.push(id)
    else leftovers.push(id)
  }
  if (leftovers.length) {
    modules.push({
      name: 'misc',
      path: guessPath(leftovers),
      summary: '未归入其他模块的零散组件',
      components: leftovers,
    })
  }
  return modules
}

// ---------------------------------------------------------------------------
// 文件归属：模块 -> 源文件清单（文章 frontmatter 的 source_files 用它）
// ---------------------------------------------------------------------------

export function moduleFiles(componentIds, byId) {
  const files = new Set()
  for (const id of componentIds) {
    const c = byId.get(id)
    if (c) files.add(c.relativePath)
  }
  return [...files].sort()
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 2
const DEFAULT_SPLIT_THRESHOLD = 60   // 组件数超过它就尝试下钻
const DEFAULT_TOP_FANOUT = 14        // 顶层模块超过它就做超级分组

export async function clusterComponents(opts) {
  const components = opts.components ?? []
  const llmCall = opts.llmCall ?? null
  const warnings = []
  const stats = { requests: 0, llm: !!llmCall, levels: 0, fallbacks: 0 }
  const byId = new Map(components.map((c) => [c.id, c]))
  const allIds = components.map((c) => c.id)

  if (!components.length) {
    return { modules: [], concepts: [], warnings: ['没有可聚类的组件'], stats }
  }

  const call = async (prompt) => {
    stats.requests += 1
    const out = await llmCall(prompt)
    return typeof out === 'string' ? out : String(out?.content ?? '')
  }

  // 第一层：全仓库聚类
  let topModules = null
  if (llmCall) {
    try {
      const text = await call(clusterPrompt(formatComponents(components), components.length))
      const parsed = parseClusterResponse(text, allIds, warnings)
      if (parsed) topModules = fillMissing(parsed.modules, components, parsed.missing)
      else stats.fallbacks += 1
    } catch (err) {
      warnings.push(`顶层聚类请求失败，降级为目录分组：${String(err?.message ?? err).slice(0, 200)}`)
      stats.fallbacks += 1
    }
  } else {
    stats.fallbacks += 1
  }
  if (!topModules) topModules = heuristicCluster(components)
  stats.levels = 1

  // 第二层起：对超大模块逐层下钻（上游的递归 cluster_modules）
  // maxDepth 是总层数上限：1 = 只做顶层聚类，2 = 允许一层子模块，3 = 允许孙模块。
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const splitThreshold = opts.splitThreshold ?? DEFAULT_SPLIT_THRESHOLD
  if (llmCall && maxDepth > 1) {
    const expanded = []
    for (const m of topModules) {
      if (m.components.length < splitThreshold) { expanded.push(m); continue }
      const kids = await subdivide(m, components, byId, call, warnings, stats, 2, maxDepth, splitThreshold)
      if (kids && kids.length > 1) {
        // 父模块保留为目录节点，子模块挂在下面（文章只写子模块，父节点用于导航）
        expanded.push({ ...m, children: kids })
      } else {
        expanded.push(m)
      }
    }
    topModules = expanded
  }

  // 第三层：顶层过多时做超级分组（上游 super_group_modules）
  const topFanout = opts.topFanout ?? DEFAULT_TOP_FANOUT
  if (llmCall && topModules.length > topFanout && opts.superGroup !== false) {
    try {
      const text = await call(superGroupPrompt(topModules))
      const grouped = parseSuperGroups(text, topModules, warnings)
      if (grouped) topModules = grouped
    } catch (err) {
      warnings.push(`超级分组失败，保留平铺模块：${String(err?.message ?? err).slice(0, 160)}`)
    }
  }

  // 补齐 source_files 与层级元信息
  const finalize = (m, parent) => {
    const files = moduleFiles(m.components, byId)
    const node = {
      name: m.name,
      path: m.path,
      summary: m.summary || `${m.name} 模块`,
      files,
      components: m.components,
      ...(parent ? { parent } : {}),
    }
    if (m.children?.length) {
      node.children = m.children.map((k) => finalize(k, m.name))
      // 父模块本身不单独成文：files 汇总给子模块用，避免重复写
      node.aggregateFiles = [...new Set(node.children.flatMap((k) => k.files))].sort()
    }
    return node
  }
  const tree = topModules.map((m) => finalize(m, null))

  // 成文清单：只有叶子模块写文章（父节点是导航容器）
  const articles = []
  const collect = (nodes) => {
    for (const n of nodes) {
      if (n.children?.length) collect(n.children)
      else articles.push(n)
    }
  }
  collect(tree)

  return { modules: articles, tree, concepts: [], warnings, stats, byId }
}

// 对单个大模块下钻一层
// 对单个超大模块下钻。depth 是当前层号（顶层模块 = 1），maxDepth 是层数上限。
// 递归条件：子模块仍然 >= splitThreshold 且还没到 maxDepth。
// 早期实现只对 topModules 做一次 for 循环、subdivide 内部不再递归，
// maxDepth 只被当成 `maxDepth > 1` 的布尔开关用，配 3 和配 2 行为完全一样。
async function subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold) {
  const subset = m.components.map((id) => byId.get(id)).filter(Boolean)
  try {
    const text = await call(subClusterPrompt(m.name, formatComponents(subset), subset.length))
    const parsed = parseClusterResponse(text, m.components, warnings)
    if (!parsed) { stats.fallbacks += 1; return null }
    const kids = fillMissing(parsed.modules, subset, parsed.missing)
    // 下钻后只有一个子模块且名字没变 -> 视为「不可再分」，保留原模块
    if (kids.length <= 1) return null
    stats.levels = Math.max(stats.levels, depth)
    // 继续往下钻：只有「还有余量 + 该子模块确实超大」才递归，
    // 且每个子模块的组件数必须严格小于父模块（kids.length > 1 已保证），不会无限递归
    if (depth >= maxDepth) return kids
    const deeper = []
    for (const kid of kids) {
      if (kid.components.length < splitThreshold) { deeper.push(kid); continue }
      const grand = await subdivide(kid, components, byId, call, warnings, stats, depth + 1, maxDepth, splitThreshold)
      if (grand && grand.length > 1) deeper.push({ ...kid, children: grand })
      else deeper.push(kid)
    }
    return deeper
  } catch (err) {
    warnings.push(`模块 ${m.name} 下钻失败：${String(err?.message ?? err).slice(0, 160)}`)
    stats.fallbacks += 1
    return null
  }
}

// 超级分组结果 -> 带子模块的顶层列表
export function parseSuperGroups(text, modules, warnings = []) {
  const obj = parseJsonLoose(text)
  if (!obj) { warnings.push('超级分组回复不是合法 JSON'); return null }
  const raw = Array.isArray(obj) ? obj : (obj.subsystems ?? obj.groups ?? null)
  if (!Array.isArray(raw)) { warnings.push('超级分组回复缺少 subsystems'); return null }
  const byName = new Map(modules.map((m) => [m.name, m]))
  const used = new Set()
  const out = []
  for (const g of raw) {
    const names = Array.isArray(g?.modules) ? g.modules.map((n) => String(n).trim()) : []
    const picked = []
    for (const n of names) {
      const m = byName.get(n)
      if (!m) { warnings.push(`超级分组引用了不存在的模块：${n}`); continue }
      if (used.has(n)) continue
      used.add(n)
      picked.push(m)
    }
    if (!picked.length) continue
    out.push({
      name: normalizeModuleName(g?.name ?? 'subsystem'),
      path: '',
      summary: String(g?.summary ?? '').trim() || '架构子系统',
      // 父节点自身不写文章，组件留空；子模块保持原样
      components: [],
      children: picked,
    })
  }
  // 没被任何子系统收走的模块直接留在顶层，不能凭空消失
  const rest = modules.filter((m) => !used.has(m.name))
  return [...out, ...rest]
}

// 把 clusterComponents 的结果转成插件 articles 阶段吃的任务清单形状
// （与 index.js 的 job.plan.modules 一致：{ name, summary, files }）
export function toPlanModules(result) {
  return result.modules.map((m) => ({
    name: m.name,
    summary: m.summary,
    files: m.files,
    ...(m.parent ? { parent: m.parent } : {}),
  }))
}
