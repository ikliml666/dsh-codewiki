// 阶段 5：原生引擎的**跨轮受管状态**（统一增量的持久化底座）。
//
// 为什么必须有这一层：FSoft 的组件级增量（rung 3）不是「再跑一遍全量、然后挑几篇改」，
// 它要读上一轮留下的四样东西才能算出「改了什么」：
//
//   1. `module_tree.json`      —— 上一轮的模块树（`_update_options()` 里 `exists()` 为假
//                                 就直接返回 None，整个增量退化成全量）；
//   2. `temp/dependency_graphs/<repo>_dependency_graph.json`
//                              —— 上一轮的依赖图（`snapshot_old_graph()` 把它复制成
//                                 `*.prev.json` 再交给 updater 做图 diff）；
//   3. `metadata.json`         —— 上一轮生成信息（`generation_info.commit_id` 是 updater
//                                 的 old_commit，也是质量门的 artifactCommit）；
//   4. 上一轮的文章            —— updater 是**原地 patch**，页面不在就要走 missing_page
//                                 重建，等于白退全量。
//
// 这些文件都在引擎的 docs 输出目录里，而那个目录是临时目录（每轮一个新 job id），
// 轮与轮之间本来什么都不留。所以「增量」若不持久化它们，第二轮的 `_update_options()`
// 必然返回 None —— 那正是「每轮都在全量、又慢又贵，却一路绿到底」的根源。
//
// ## 状态目录为什么以 `_` 开头
//
// `cw index`（vendor/codewiki/src/main.rs:236-256）会 `WalkDir` 递归整个 `.codewiki/`，
// 收录所有 `.md` 且**只**跳过仓库相对路径以 `_` 开头的项。把状态放在
// `.codewiki/temp/native-state/`（首段是 `temp`，不以 `_` 开头）会让持久化的原始文章
// 被 cw index 收成**第二份**文章 —— 同一页在索引里出现两条链接。
// 所以状态目录必须是 `.codewiki/_native-state/`：整棵子树首段就是 `_native-state`，
// cw index 自然跳过，而落地器的「索引必须收录本次写的 .md」校验也带同样的过滤
// （apply-plan.js 的 findArticlesMissingFromIndex 里 `seg.startsWith('_')`）。
//
// ## 三条不变量
//
//   1. 只有「完整成功」才允许把本轮采集到的状态写成下一轮的基线（consume）；
//      partial/failed/cancelled 一律不推进（否则未消化的变化会被当成已消化）。
//   2. 状态不完整（缺图 / 缺 module_tree / 版本不符 / 基线不可达）→ 显式 full，
//      并在 state.json 里留下 `fallbackReason`；绝不假装 clean。
//   3. 水合是**复制**而不是移动：源状态目录在仓库里（受 git 管理），docsDir 在
//      临时目录（引擎的写盘目标）。任何一侧被写坏都不影响另一侧。
//
// 状态文件与文章走**同一个** pre-image、同一次回滚、同一个自动提交（apply-plan.js 的
// extraFiles），因此「图/模块树/metadata/update_record 与文章同事务」不是约定，是结构。

import fs from 'node:fs'
import path from 'node:path'
import { toPosix as posix } from '../git-paths.js'

export const NATIVE_STATE_VERSION = 1
// 受管状态目录（相对仓库根，POSIX）。首段以 `_` 开头 —— 理由见文件头。
export const NATIVE_STATE_DIR = '.codewiki/_native-state'
export const NATIVE_STATE_FILE = 'state.json'

// 引擎做组件级增量时**硬依赖**的文档（缺任何一个都只能退全量）。
// 这份清单来自实测：`.probe-fsoft/wiki_out_1c/docs` 里就是这些文件，其余都是文章。
export const STATE_REQUIRED_DOCS = Object.freeze(['module_tree.json', 'metadata.json'])

// 需要跨轮保留的 `temp/` 内文件（其余 temp 中间件不入库：它们每轮都会重算，
// 存进来只是让提交变大，且下次水合会把过期中间件当成有效输入）。
export const STATE_TEMP_FILES = Object.freeze([
  'temp/reference_index.json',
  'temp/artifact_index.json',
])
export const STATE_TEMP_DIRS = Object.freeze(['temp/dependency_graphs'])

const absOf = (root, rel) => path.join(root, ...posix(rel).split('/'))

/**
 * 把引擎产出的**整棵原始 docs 树**完整复制到独立目录留档（事实来源）。
 *
 * 为什么必须有这一步：引擎（FSoft）是把产物直接写进 docsDir 的，而 docsDir 是
 * 「本轮的临时工作区」——后续的 gate / 采集受管状态 / 落地器都在它上面动手
 * （裁剪过期状态、删孤儿页、按映射改写）。也就是说**原始产物被就地消费**，
 * 一旦落地器做了什么无法从 `.codewiki/` 反推的加工，就没有任何地方能回答
 * 「引擎到底给了什么」。设计文档 L20 要求「保留 FSoft 输出原始树作为事实来源」，
 * 指的就是这一份。
 *
 * 留档位置**绝不能在仓库内**：`.codewiki/` 下任何非 `_` 开头的目录都会被
 * `cw index` 递归收集成文章（见本文件头部），`.codewiki/temp/fsoft-raw/` 会把
 * 原始文章变成索引里的第二份副本 —— 那正是 S6 想要避免的「原始树干扰库」。
 * 所以调用方传进来的 destDir 必须是仓库外的临时目录。
 *
 * 失败语义：留档是**证据**不是产物，拷不动就不拷（返回 ok:false + error），
 * 由调用方记 note；绝不能因为它让一次编译失败。
 *
 * @param {object} o
 * @param {string} o.docsDir 引擎产物目录（绝对路径）
 * @param {string} o.destDir 留档目标目录（绝对路径；会在其上逐文件还原同样的相对布局）
 * @returns {{ok:boolean, dir:string, files:number, bytes:number, error?:string}}
 */
export function archiveDocsTree({ docsDir, destDir } = {}) {
  const src = docsDir ? path.resolve(String(docsDir)) : ''
  const dst = destDir ? path.resolve(String(destDir)) : ''
  if (!src || !dst) return { ok: false, dir: '', files: 0, bytes: 0, error: 'archiveDocsTree: 需要 docsDir 与 destDir' }
  // 目标与源互不嵌套（两个方向都要查）：嵌进去会把刚拷好的文件当源继续拷，
  // 反方向（源在目标内）会让下一次留档读到上一轮的旧副本。
  // 跨盘时 path.relative 返回绝对路径，用 isAbsolute 把它排除在「嵌套」之外。
  const nested = (a, b) => {
    const r = path.relative(a, b)
    return !r || (!r.startsWith('..') && !path.isAbsolute(r))
  }
  if (nested(src, dst) || nested(dst, src)) {
    return { ok: false, dir: '', files: 0, bytes: 0, error: `留档目录不能与产物目录重叠：${dst}` }
  }
  let names
  try { names = listFiles(src) } catch (err) {
    return { ok: false, dir: '', files: 0, bytes: 0, error: `读产物目录失败：${err?.message ?? err}` }
  }
  if (!names.length) return { ok: false, dir: '', files: 0, bytes: 0, error: '产物目录为空，无可留档内容' }
  let files = 0
  let bytes = 0
  const failed = []
  try { fs.mkdirSync(dst, { recursive: true }) } catch (err) {
    return { ok: false, dir: '', files: 0, bytes: 0, error: `建留档目录失败：${err?.message ?? err}` }
  }
  for (const docRel of names) {
    const from = path.join(src, ...docRel.split('/'))
    const to = path.join(dst, ...docRel.split('/'))
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      files += 1
      try { bytes += fs.statSync(to).size } catch { /* 统计失败不影响留档 */ }
    } catch (err) {
      failed.push(`${docRel}（${err?.code ?? err?.message ?? err}）`)
    }
  }
  if (!files) {
    return { ok: false, dir: '', files: 0, bytes: 0, error: `全部文件留档失败：${failed.slice(0, 3).join('、')}` }
  }
  return {
    ok: true, dir: posix(dst), files, bytes,
    ...(failed.length ? { error: `${failed.length} 个文件留档失败：${failed.slice(0, 3).join('、')}` } : {}),
  }
}

/**
 * 依赖图文件名（对齐 graph_store.sanitize_repo_name / graph_file_path）。
 *
 * 为什么必须逐字符对齐：引擎只会读 `<sanitize(仓库名)>_dependency_graph.json`。
 * Python 的 `sanitize_repo_name` 用的是 `c.isalnum()`——那是 **Unicode** 字母数字，
 * 中文/日文字符会原样保留（实测 `.probe-fsoft/wiki_out_1a/temp/dependency_graphs/`
 * 里就是 `中文_空格_fixture_dependency_graph.json`）。所以这里必须用 `\p{L}`/`\p{N}`
 * 而不是 `[A-Za-z0-9]`：后者会把中文仓库名的图判成「缺失」，于是每轮都白退全量。
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function graphFileName(repoRoot) {
  const base = path.basename(path.resolve(String(repoRoot ?? '.')))
  const safe = base.replace(/[^\p{L}\p{N}]/gu, '_')
  return `${safe}_dependency_graph.json`
}

/** 状态目录里保存的 docs 副本根（`<stateDir>/docs`）。 */
export function stateDocsDir(stateDir) {
  return path.join(stateDir, 'docs')
}

/**
 * 一份 docs 文件要不要进受管状态。
 *
 * 判据是「它是不是下一轮增量需要读的输入」，不是「它在 docs 里」：
 *   · 所有 `.md`（文章：updater 原地 patch 的目标）
 *   · 顶层 `.json`（module_tree / first_module_tree / metadata / update_record）
 *   · `temp/` 下白名单（reference_index、artifact_index、dependency_graphs）
 *   · 其他子目录里的文件（hierarchical layout 可能把状态放进子目录）
 * 排除 `temp/` 其余中间件。
 *
 * @param {string} rel 相对 docsDir 的 POSIX 路径
 * @returns {boolean}
 */
export function isStateDocPath(rel) {
  const p = posix(rel).replace(/^\/+/, '')
  if (!p) return false
  if (p === 'dsh_leaf_checkpoint.json' || p.startsWith('dsh_leaf_checkpoint.json.')) return false
  if (p.endsWith('.md')) return true
  if (p.startsWith('temp/')) {
    if (STATE_TEMP_FILES.includes(p)) return true
    return STATE_TEMP_DIRS.some((d) => p.startsWith(`${d}/`))
  }
  return true
}

/**
 * 状态文件的仓库相对路径清单（供审计与「哪些路径属于受管状态」的判据）。
 *
 * @param {string} stateDir 仓库相对的受管状态目录（默认 NATIVE_STATE_DIR）
 * @returns {{rel:string, docRel:string}[]}
 */
export function stateDocFiles(stateDir = NATIVE_STATE_DIR) {
  const out = []
  for (const rel of STATE_REQUIRED_DOCS) out.push({ rel: `${stateDir}/docs/${rel}`, docRel: rel })
  for (const dir of STATE_TEMP_DIRS) out.push({ rel: `${stateDir}/docs/${dir}`, docRel: dir })
  return out
}

/**
 * 读 state.json（受管凭据）。
 *
 * 反序列化边界上的对象**必须被检查**而不是被信任：磁盘残留、旧版本、
 * 手改过的 JSON 都走这里。坏掉时返回 ok=false + reason，调用方据此退全量。
 *
 * @param {string} stateDir 仓库相对的受管状态目录
 * @param {string} repoRoot
 * @returns {{ok:boolean, state:object|null, reason:string}}
 */
export function readState(stateDir, repoRoot) {
  const abs = absOf(repoRoot, `${stateDir}/${NATIVE_STATE_FILE}`)
  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, code: 'absent', state: null, reason: '还没有持久化状态（首次增量）' }
    return { ok: false, code: 'unreadable', state: null, reason: `state.json 不可读：${err?.code ?? err?.message ?? err}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, code: 'corrupt', state: null, reason: `state.json 不是合法 JSON：${String(err?.message ?? err).slice(0, 160)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'corrupt', state: null, reason: 'state.json 不是对象' }
  }
  if (Number(parsed.stateVersion) !== NATIVE_STATE_VERSION) {
    return {
      ok: false,
      code: 'version',
      state: null,
      reason: `state.json 版本不兼容（磁盘 ${parsed.stateVersion ?? '缺'}，本层 ${NATIVE_STATE_VERSION}）`,
    }
  }
  return { ok: true, code: 'ok', state: parsed, reason: '' }
}

/** 读 state.json 的原始文本（用于「内容未变就不重写」的字节比较）。 */
export function readStateText(stateDir, repoRoot) {
  try {
    return fs.readFileSync(absOf(repoRoot, `${stateDir}/${NATIVE_STATE_FILE}`), 'utf8')
  } catch {
    return null
  }
}

/**
 * 判断「能不能走真实增量」。
 *
 * 每个不可增量的原因都要**说出来**（进 fallbackReason），因为「悄悄退全量」
 * 会让用户以为增量生效了、实际每轮都在全量重编（又慢又贵）。
 *
 * @param {object} o
 * @param {string} o.stateDir
 * @param {string} o.repoRoot
 * @param {string} [o.baseCommit]       本轮基线（change-set 算出来的）
 * @param {string} [o.engineVersion]    引擎版本（与状态里记录的比较）
 * @param {string} [o.headCommit]
 * @returns {{eligible:boolean, reason:string, state:object|null, missing:string[]}}
 */
export function isUpdateEligible({ stateDir = NATIVE_STATE_DIR, repoRoot, baseCommit = '', engineVersion = '', headCommit = '' } = {}) {
  const root = path.resolve(String(repoRoot ?? '.'))
  const read = readState(stateDir, root)
  if (!read.ok) return { eligible: false, reason: read.reason, state: null, missing: [] }

  const docs = stateDocsDir(absOf(root, stateDir))
  const missing = []
  // 1) 引擎增量硬依赖：module_tree.json 不在 → `_update_options()` 直接 None → 全量。
  for (const rel of STATE_REQUIRED_DOCS) {
    if (!fs.existsSync(path.join(docs, ...rel.split('/')))) missing.push(rel)
  }
  // 2) 依赖图：按当前仓库名找（引擎只读这个名字）。
  const graphRel = `temp/dependency_graphs/${graphFileName(root)}`
  if (!fs.existsSync(path.join(docs, ...graphRel.split('/')))) missing.push(graphRel)
  if (missing.length) {
    return {
      eligible: false,
      reason: `持久化状态缺 ${missing.join('、')}（引擎无法做组件级增量，改走全量）`,
      state: read.state,
      missing,
    }
  }

  // 3) 版本兼容：引擎版本变了，旧图/旧树是另一个版本的产物，diff 不可信。
  const recordedEngine = String(read.state.engineVersion ?? '')
  if (recordedEngine && engineVersion && recordedEngine !== engineVersion) {
    return {
      eligible: false,
      reason: `引擎版本从 ${recordedEngine} 变成 ${engineVersion}，旧图不再可比（改走全量）`,
      state: read.state,
      missing: [],
    }
  }

  // 4) 基线一致性：上一轮记录的已消费范围必须与本次 cw 基线对得上，否则「相对谁增量」
  //    无从谈起。不一致**不是错误**（cw 基线可能被别的任务前移），但要记下来让人看得见。
  const recorded = read.state.consumedRange ?? {}
  const recordedBase = String(recorded.baseCommit ?? '')
  if (recordedBase && baseCommit && recordedBase !== baseCommit) {
    return {
      eligible: true,
      reason: `持久化基线 ${recordedBase.slice(0, 7)} 与本次 cw 基线 ${baseCommit.slice(0, 7)} 不同（以 cw 基线为准，未消费变化仍会并入）`,
      state: read.state,
      missing: [],
    }
  }
  return { eligible: true, reason: '', state: read.state, missing: [] }
}

/** 递归收集目录下的文件（相对 dir 的 POSIX 路径）。目录不存在时返回 []。 */
function listFiles(dir) {
  const out = []
  const walk = (cur, prefix) => {
    let items
    try { items = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const rel = prefix ? `${prefix}/${it.name}` : it.name
      const abs = path.join(cur, it.name)
      if (it.isDirectory()) { walk(abs, rel); continue }
      if (it.isFile()) out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * 把受管状态**复制**进引擎的 docs 目录（跑引擎之前）。
 *
 * 复制而不是移动：源在仓库里受 git 管理，是下一轮的权威；目标在临时目录里，
 * 引擎会在上面就地改写。移动会让「这一轮失败」直接毁掉下一轮的输入。
 *
 * @param {object} o
 * @param {string} o.stateDir
 * @param {string} o.repoRoot
 * @param {string} o.docsDir
 * @returns {{hydrated:string[], retained:string[], skipped:string[]}}
 */
export function hydrateDocsDir({ stateDir = NATIVE_STATE_DIR, repoRoot, docsDir, overwrite = true } = {}) {
  const src = stateDocsDir(absOf(path.resolve(String(repoRoot ?? '.')), stateDir))
  const dst = path.resolve(String(docsDir ?? ''))
  const hydrated = []
  const retained = []
  const skipped = []
  if (!fs.existsSync(src)) return { hydrated, retained, skipped }
  for (const rel of listFiles(src)) {
    const from = path.join(src, ...rel.split('/'))
    const to = path.join(dst, ...rel.split('/'))
    try {
      if (!overwrite && fs.existsSync(to)) {
        if (rel.endsWith('.json')) {
          try { JSON.parse(fs.readFileSync(to, 'utf8')) } catch {
            fs.copyFileSync(from, to)
            hydrated.push(rel)
            continue
          }
        }
        retained.push(rel)
        continue
      }
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      hydrated.push(rel)
    } catch (err) {
      skipped.push(`${rel}（${err?.code ?? err?.message ?? err}）`)
    }
  }
  return { hydrated, retained, skipped }
}

/**
 * 把引擎 docs 目录里的状态**采集**成「下一轮的原始状态」写集。
 *
 * 返回的是 `{rel, content}` 列表（rel 相对**仓库根**），可以直接交给落地器当
 * extraFiles —— 这样状态文件与文章共用同一份 pre-image、同一次回滚、同一个提交。
 *
 * 文本按 utf8 读、utf8 写：这些都是 JSON/markdown，逐字节往返成立。
 * 二进制（若有）会被 utf8 解码破坏，所以先探一次——非文本直接跳过并记进 missing，
 * 而不是写进去一份坏数据。
 *
 * @param {object} o
 * @param {string} o.docsDir
 * @param {string} [o.stateDir]
 * @returns {{files:Array<{rel:string, content:string}>, captured:string[], missing:string[]}}
 */
export function captureDocsDir({ docsDir, stateDir = NATIVE_STATE_DIR } = {}) {
  const src = path.resolve(String(docsDir ?? ''))
  const files = []
  const captured = []
  const missing = []
  if (!fs.existsSync(src)) return { files, captured, missing: ['（docs 目录不存在）'] }
  for (const docRel of listFiles(src)) {
    if (!isStateDocPath(docRel)) continue
    const from = path.join(src, ...docRel.split('/'))
    let content
    try {
      content = fs.readFileSync(from, 'utf8')
    } catch (err) {
      missing.push(`${docRel}（${err?.code ?? err?.message ?? err}）`)
      continue
    }
    // U+FFFD 意味着原始字节不是合法 utf8：写回去就是坏文件。
    if (content.includes('\uFFFD')) {
      missing.push(`${docRel}（非 utf8 文本，不纳入受管状态）`)
      continue
    }
    files.push({ rel: `${stateDir}/docs/${docRel}`, content })
    captured.push(docRel)
  }
  // 硬依赖缺失要单独报出来：它们缺失时下一轮根本做不了增量，必须在结果里可见。
  for (const rel of STATE_REQUIRED_DOCS) {
    if (!captured.includes(rel)) missing.push(`${rel}（引擎没有产出，下一轮将无法增量）`)
  }
  const graphRel = `temp/dependency_graphs`
  if (!captured.some((r) => r.startsWith(`${graphRel}/`))) {
    missing.push(`${graphRel}/（引擎没有产出依赖图，下一轮将无法增量）`)
  }
  return { files, captured, missing }
}

/**
 * 组装 state.json 的内容（下一轮凭据）。
 *
 * 关键设计：本文件**不记录本轮结局**，只记录「本轮开始时的已消费范围」与
 * 「本轮看见了哪些变化」。原因是本轮结局（基线是否推进）的权威在 `.codewiki/_meta.yaml`，
 * 而 state.json 要在 apply 之前就落盘（与文章同一份 pre-image）。写成「本轮结局」
 * 就必须在 apply 之后再改一次文件 —— 那会造出第二个提交，且回滚语义分叉。
 *
 * 于是「未消费凭据」是这样成立的：
 *   · 本轮失败 → `_meta.yaml` 基线未前移（apply 回滚） → 下一轮 change-set 仍从旧基线
 *     算起，`pendingChanges` 里的变化会重新出现（不丢）；
 *   · 本轮成功 → `_meta.yaml` 基线前移 → 下一轮 change-set 起点随之更新；
 *     `pendingChanges` 只作为审计记录保留（「上一轮消化了这些」）。
 *
 * @param {object} o
 * @returns {object}
 */
export function buildStatePayload({
  repoRoot = '',
  consumedRange = null,
  pendingChanges = null,
  unconsumed = null,
  previous = null,
  engineVersion = '',
  scope = 'full',
  effectiveScope = 'full',
  updateOutcome = null,
  fallbackReason = '',
  notes = [],
  missingRepair,
  at = null,
} = {}) {
  const prev = previous && typeof previous === 'object' ? previous : {}
  const now = at ?? new Date().toISOString()
  const range = consumedRange && typeof consumedRange === 'object' ? consumedRange : (prev.consumedRange ?? null)
  const pending = pendingChanges && typeof pendingChanges === 'object' ? pendingChanges : (prev.pendingChanges ?? null)
  const asPaths = (v) => (Array.isArray(v) ? v : []).map((e) => posix(typeof e === 'string' ? e : e?.path)).filter(Boolean)
  return {
    stateVersion: NATIVE_STATE_VERSION,
    repoRoot: String(repoRoot ?? ''),
    // 本轮开始时「已消化到哪儿」：权威是 .codewiki/_meta.yaml:last_compiled_commit，
    // 这里留一份副本供审计与「基线不一致」诊断。
    consumedRange: range ? {
      baseCommit: String(range.baseCommit ?? ''),
      headCommit: String(range.headCommit ?? ''),
    } : null,
    // 本轮引擎真正看见的变化（四路合一）。本轮若未完整成功，它们就是「还没消化的账」。
    pendingChanges: pending ? {
      state: String(pending.state ?? ''),
      baseCommit: String(pending.baseCommit ?? ''),
      headCommit: String(pending.headCommit ?? ''),
      committed: asPaths(pending.committed).slice(0, 2000),
      staged: asPaths(pending.staged).slice(0, 500),
      unstaged: asPaths(pending.unstaged).slice(0, 500),
      untracked: asPaths(pending.untracked).slice(0, 500),
      deleted: asPaths(pending.deleted).slice(0, 500),
      renamed: (Array.isArray(pending.renamed) ? pending.renamed : [])
        .map((r) => `${posix(r?.from)} -> ${posix(r?.path)}`).slice(0, 500),
      reason: String(pending.reason ?? '').slice(0, 1000),
    } : null,
    // 「已读进产物、但还没进任何 commit」的路径。下一轮无条件并入变化集，
    // 直到它们真的出现在 `git diff base..HEAD` 里（= 消费成立）才移出。
    unconsumed: Array.isArray(unconsumed) ? unconsumed.slice(0, 2000) : (prev.unconsumed ?? []),
    engineVersion: String(engineVersion ?? prev.engineVersion ?? ''),
    // 本轮请求的 scope 与实际生效的 scope（显式记下 full 回退）
    scope: String(scope ?? 'full'),
    effectiveScope: String(effectiveScope ?? 'full'),
    updateOutcome: updateOutcome == null ? (prev.updateOutcome ?? null) : String(updateOutcome),
    fallbackReason: String(fallbackReason ?? ''),
    // 「因产物缺页而转过全量」的凭据。没有它，缺口补不上时会一轮又一轮地重跑
    // 全量（每轮几十分钟、结果还是 partial）。有了它，同一棵树上的同一批缺口
    // 只尝试一次全量修复，之后如实报 partial 并把原因写进 notes。
    // undefined = 沿用上一轮，null = 明确清除（缺口已补齐）。
    missingRepair: missingRepair === undefined
      ? (prev.missingRepair ?? null)
      : (missingRepair && typeof missingRepair === 'object' ? missingRepair : null),
    notes: Array.isArray(notes) ? notes.slice(-20) : [],
    updatedAt: now,
  }
}

/** 把 state.json 内容作为一条写集项返回（交给落地器）。 */
export function stateFileItem(payload, stateDir = NATIVE_STATE_DIR) {
  return {
    rel: `${stateDir}/${NATIVE_STATE_FILE}`,
    content: `${JSON.stringify(payload, null, 2)}\n`,
  }
}

/**
 * state.json 的「实质内容」指纹（去掉时间戳）。
 *
 * 为什么需要：`updatedAt` 每轮都变，若照写，无变化的一轮也会产生一次真实提交——
 * 那正是「无变化路径不错误重写/提交」要避免的。只有实质内容变了才写新的时间戳。
 *
 * @param {string|null} text state.json 文本（null = 不存在）
 * @returns {string} 稳定的指纹（解析失败时退回原文）
 */
export function stateFingerprint(text) {
  if (typeof text !== 'string') return ''
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return text
    const { updatedAt, notes, ...rest } = parsed
    return JSON.stringify(rest)
  } catch {
    return text
  }
}

/**
 * 跨轮「未消化变化」的合并（纯函数）。
 *
 * 为什么必须有它：FSoft 的组件级增量读的是**工作区实际文件**构建的新图，所以未提交
 * 的改动确实会被引擎看见并写进文章；但 cw 基线（`_meta.yaml:last_compiled_commit`）
 * 推进的是 HEAD。于是「文章已覆盖未提交改动，基线却停在 HEAD」——
 * 下一轮 change-set 从新 HEAD 算起，那些未提交改动就再也算不进变化集里了：
 * 文章与源码脱节，而系统一路绿到底。这是本阶段要消灭的第二类丢变化。
 *
 * 解法：把「已经读进产物、但还没进任何 commit」的路径记进 state.json 的
 * `unconsumed`，每轮并入变化集，直到它们真的出现在 `git diff base..HEAD` 里
 * 才移出。移出的那一刻就是「消费成立」。
 *
 * @param {object} o
 * @param {object} o.changeSet       本轮 collectChangeSet 的结果
 * @param {string[]} [o.prevUnconsumed] 上一轮留下的未消费路径
 * @returns {{unconsumed:string[], consumedNow:string[], dropped:string[], effectiveChanges:string[], carried:number}}
 */
export function mergeUnconsumed({ changeSet = null, prevUnconsumed = [] } = {}) {
  const cs = changeSet && typeof changeSet === 'object' ? changeSet : {}
  const normPath = (p) => posix(p).trim()
  const list = (v) => (Array.isArray(v) ? v : [])
  // 条目既可能是字符串路径，也可能是 {path, from} 对象（change-set 的 committed/renamed 形态）
  const pathOf = (e) => normPath(typeof e === 'string' ? e : e?.path)
  const fromOf = (e) => normPath(typeof e === 'string' ? '' : e?.from)

  // 四路里「还没进 commit」的部分：staged / unstaged / untracked 一律算未消费。
  // 注意 committed 里的路径本轮被看见时已经进了 commit，不需要再携带。
  const pendingNow = new Set()
  for (const e of list(cs.staged)) { const p = pathOf(e); if (p) pendingNow.add(p) }
  for (const e of list(cs.unstaged)) { const p = pathOf(e); if (p) pendingNow.add(p) }
  for (const e of list(cs.untracked)) { const p = pathOf(e); if (p) pendingNow.add(p) }

  // 上一轮携带的：只有「这一轮已经出现在 committed 里」才算被提交消化掉；
  // 其余继续携带（文件可能还在工作区、也可能删除了但删除未提交）。
  const committedNow = new Set()
  for (const e of list(cs.committed)) {
    const p = pathOf(e); if (p) committedNow.add(p)
    const f = fromOf(e); if (f) committedNow.add(f)
  }
  // 本轮 git 能看见的全部路径（含四路）。不在这个集合里的旧账是**死条目**：
  // 文件已被删掉、又从未提交过，于是它永远进不了 committed，按「只有 committed 才算
  // 消化」的规则会被永久携带下去。真机上 dsh-subagent-auto-router 积了 37 条
  // `.dsh-ops/panel/*.json`（目录早被清掉），dsh-git-worktree 积了 6 条 `.diag-tmp/*`，
  // 结果那两个仓库工作区明明干净，每轮仍判「有变化」跑完整一轮。
  //
  // 判据是「git 看不见」，所以被 .gitignore 忽略的文件也会被丢——这是有意的：
  // 用户把它们写进 .gitignore 就是声明「这不是仓库内容」，它们永远进不了 commit，
  // 携带它们等于保证 idleRound 永不成立（永久白跑），而丢掉不会少编译任何东西。
  const seenNow = new Set([...committedNow, ...pendingNow])
  for (const e of list(cs.deleted)) { const p = pathOf(e); if (p) seenNow.add(p) }
  for (const e of list(cs.renamed)) {
    const p = pathOf(e); if (p) seenNow.add(p)
    const f = fromOf(e); if (f) seenNow.add(f)
  }
  const consumedNow = []
  const stillUnconsumed = []
  const dropped = []
  for (const raw of list(prevUnconsumed)) {
    const p = pathOf(raw)
    if (!p) continue
    if (committedNow.has(p)) consumedNow.push(p)
    else if (seenNow.has(p)) stillUnconsumed.push(p)
    else dropped.push(p)
  }
  const unconsumed = [...new Set([...stillUnconsumed, ...pendingNow])].sort()

  // 变化集 = 本轮四路 ∪ 上一轮携带（去重、排序）。引擎与门都按它判断「消化了什么」。
  const effectiveChanges = [...new Set([...list(cs.sourceChanges).map(pathOf), ...unconsumed])]
    .filter(Boolean)
    .sort()
  return {
    unconsumed,
    consumedNow: consumedNow.sort(),
    dropped: dropped.sort(),
    effectiveChanges,
    carried: stillUnconsumed.length,
  }
}
