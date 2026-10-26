// dsh-codewiki — 把 mraza007/codewiki（Rust CLI `cw`）接入 DeepSeek Harness。
// 提供两个工具：
//   cw                — 薄封装 CodeWiki CLI（init/status/index/meta/path/projects/setup/uninstall）
//   codewiki_generate — 服务化编译：判态后把编译任务提交给宿主常驻服务（侧边栏 CodeWiki 面板可见），
//                       服务按 写文章 → 横切 → 审校 → 索引 推进，全部环节在插件内完成
//                       （默认模型 workbuddy/hy3，192k 上下文，单请求输入预算 110k），零子代理。
//   codewiki_progress — 只读查编译进度：提交后随时查 stage/百分比/篇数/失败原因，立即返回不等待。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { extractRepoGraph, resolveImportEdges } from './lib/symbols.js'
import { clusterComponents, toPlanModules } from './lib/cluster.js'
import { diffGraphs, isDiffEmpty, serializeDiff, changedIds } from './lib/graph-diff.js'
import {
  slimGraph, graphFromSnapshot, loadSnapshot, saveSnapshot,
  filterStaleTasks, describeChange, sameSnapshotContent,
} from './lib/incremental.js'
import { runAgenticArticles } from './lib/articles-agentic.js'
import { buildOpeningPrompt, TOOL_SCHEMAS } from './lib/agentic.js'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-codewiki'
export const name = PLUGIN_NAME
const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']
// 编译请求（同步 chat/completions）并发上限
const CONCURRENCY_HARD_CAP = 8
// 默认并发：hy3 免费且 192k 上下文，2 路并发足够且不触发上游限流
const DEFAULT_CONCURRENCY = 2
// 默认编译模型：workbuddy/hy3（免费、192k 上下文，宿主 llm 服务通道）
const DEFAULT_BATCH_PROVIDER = 'workbuddy'
const DEFAULT_BATCH_MODEL = 'hy3'
// 大档模型：单批输入超过普通预算 110k 时改用它（512k 上下文的 glm-5.3-flash）。
// 目的：超过 128k 的内容也不交会话模型，仍在插件内跑完。
const DEFAULT_BIG_PROVIDER = 'volces-ark'
const DEFAULT_BIG_MODEL = 'glm-5.3-flash'
// 大档单请求输入预算：模型 512k 上下文，留出输出与系统提示余量后取 420k
const DEFAULT_BIG_TOKEN_BUDGET = 420000
// 编译产物路径：自动提交、忽略检测、待提交提醒共用的唯一定义。永远只认这两个 pathspec，
// 不扩成 -A / 整个工作树（否则会把用户手上的其它改动卷进自动提交）。
const WIKI_PATHS = ['.codewiki', 'CodeWiki.md']

// Windows/Git-Bash 兼容：MSYS 盘符路径（/e/...）Node 的 fs 不认，归一化为 E:/...。
// 仅 win32 转换——POSIX 上 /e/... 可能是真实绝对路径，原样保留；识别不了的写法也原样交给 existsSync 报错。
function normalizeCwd(input) {
  const p = String(input ?? '').trim()
  if (process.platform !== 'win32') return p
  const m = p.match(/^\/([A-Za-z])\/(.*)$/)
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('停用后两个工具立即报错'),
  binaryPath: z.string().default('').volatile().description('cw 可执行文件路径；留空优先用 PATH 里的 cw（与 codewiki 源码同步），找不到再用插件自带 bin/cw(.exe)'),
  batchProvider: z.string().default(DEFAULT_BATCH_PROVIDER).volatile().description('编译模型提供商（必须是 DSH 模型设置里已注册的 provider id）：batchModel 填该 provider 的模型 id。留空将无法提交任务'),
  batchModel: z.string().default(DEFAULT_BATCH_MODEL).volatile().description('编译模型（全部模型环节共用）：该 provider 下的模型 id'),
  batchReasoningEffort: z.string().default('').volatile().description('思考程度（该模型的 reasoning effort 档位 id）：留空=用模型的默认档；可选值由模型目录实时读取（/api/codewiki/model-efforts）'),
  bigProvider: z.string().default(DEFAULT_BIG_PROVIDER).volatile().description('大档模型提供商（单批输入超过大档阈值时改用的模型，通常是长上下文更便宜的档）：留空=不启用大档，退回会话通道兜底'),
  bigModel: z.string().default(DEFAULT_BIG_MODEL).volatile().description('大档模型 id（该 provider 下）。默认火山方舟 glm-5.3-flash（512k 上下文）'),
  bigReasoningEffort: z.string().default('').volatile().description('大档模型思考程度：留空=用模型默认档；可选值由模型目录实时读取'),
  bigTokenBudget: z.number().default(DEFAULT_BIG_TOKEN_BUDGET).volatile().description('大档单请求输入预算（token）：输入超 110k 普通预算的请求改用大档；模块源码总量超此值才拆观察→合成批，单文件超此值转会话通道兜底'),
  sessionTier: z.string().default('').volatile().description('会话通道档位 id（仅当大档都装不下且 bigProvider 留空时兜底使用，dsh-subagent-auto-router 里的档位如 codewiki）：留空=让会话模型自动选路；填了则 steer 文本要求 delegate 显式传该 tier'),
  maxConcurrency: z.number().default(DEFAULT_CONCURRENCY).volatile().description('默认档并发上限（1–8），硬顶 8；默认 2（hy3 免费档）'),
  bigConcurrency: z.number().default(0).volatile().description('大档并发上限（1–8），硬顶 8：留空或 0 = 跟随默认档并发。大档与默认档各自独立限流、同时推进，总在飞 = 两者之和'),
  serialProjects: z.boolean().default(true).volatile().description('单项目串行：同一时刻只推进一个仓库的编译任务，其余排队（queued），当前任务收尾后自动轮到下一个。关闭后按 parallelProjects 并行推进多个仓库'),
  parallelProjects: z.number().default(2).volatile().description('并行推进的仓库编译任务上限（1–4）：关闭单项目串行后生效。默认 2——多仓库同时编译不再互相排队；额度紧张或限流时调回 1 或开启串行'),
  articleLanguage: z.string().default('中文').volatile().description('wiki 文章书写语言'),
  planMode: z.string().default('auto').volatile().description('模块划分方式：auto=AST 符号提取 + LLM 语义聚类（吸收自 FSoft CodeWiki，失败自动降级为目录分组）；dirs=只按顶层目录分组（旧行为）'),
  agenticArticles: z.boolean().default(true).volatile().description('文章写作走 agentic 工具循环（模型自己 read_code/list_files 读源码、edit_article 增量写，不再把源码整包内联进 prompt）：关闭则走单轮整包装填的旧通道'),
  agenticMaxSteps: z.number().default(30).volatile().description('agentic 写作单篇最大步数（工具调用轮次），硬顶 100；步数越多越细致也越慢'),
  symbolIncremental: z.boolean().default(true).volatile().description('stale 增量编译按 AST 符号级判定变更（只重写签名/正文/接口真变了的模块，吸收自 FSoft CodeWiki）：关闭则按文件级 mtime/hash 判定'),
  updateReminder: z.boolean().default(true).volatile().description('会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，收尾时提醒更新 wiki）'),
  autoCommit: z.boolean().default(true).volatile().description('编译完成后由插件自己在主题分支上提交产物再合并回原分支（只 add .codewiki/ 与 CodeWiki.md，建议 docs(wiki) 前缀；不动其它改动）：会话模型因此无需等待编译完成、也无需提交；非 git 仓库或提交失败时降级为提醒会话模型提交'),
  excludePaths: z.string().default('').volatile().description('排除清单：这些目录（含子目录）不编译 CodeWiki。换行/分号/逗号分隔绝对路径'),
  autoUpdate: z.boolean().default(false).volatile().description('自动更新：定时扫描已编译过的工作区，检测到变更自动提交增量编译（scope=auto）'),
  autoUpdateMin: z.number().default(30).volatile().description('自动更新扫描间隔（分钟），最小 5'),
  workspaceOnly: z.boolean().default(true).volatile().description('任务页只显示属于已添加 dsh 工作区（宿主工作区列表）的任务'),
})

function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}

function liveConfig(config) {
  const c = config ?? {}
  const concurrency = Number(val(c.maxConcurrency))
  const bigConcurrency = Number(val(c.bigConcurrency))
  return {
    enabled: val(c.enabled) ?? true,
    binaryPath: String(val(c.binaryPath) ?? '').trim(),
    batchProvider: String(val(c.batchProvider) ?? '').trim(),
    batchModel: String(val(c.batchModel) ?? '').trim() || DEFAULT_BATCH_MODEL,
    batchReasoningEffort: String(val(c.batchReasoningEffort) ?? '').trim(),
    bigProvider: String(val(c.bigProvider) ?? '').trim(),
    bigModel: String(val(c.bigModel) ?? '').trim() || DEFAULT_BIG_MODEL,
    bigReasoningEffort: String(val(c.bigReasoningEffort) ?? '').trim(),
    bigTokenBudget: Math.max(BATCH_TOKEN_BUDGET, Number(val(c.bigTokenBudget)) || DEFAULT_BIG_TOKEN_BUDGET),
    sessionTier: String(val(c.sessionTier) ?? '').trim(),
    maxConcurrency: Number.isFinite(concurrency) && concurrency >= 1
      ? Math.min(concurrency, CONCURRENCY_HARD_CAP)
      : DEFAULT_CONCURRENCY,
    // 大档并发：0/未填 = 跟随默认档（与 0.12.1 前的单一池行为等价）
    bigConcurrency: Number.isFinite(bigConcurrency) && bigConcurrency >= 1
      ? Math.min(bigConcurrency, CONCURRENCY_HARD_CAP)
      : 0,
    serialProjects: val(c.serialProjects) !== false,
    parallelLimit: (() => {
      const raw = Number(val(c.parallelProjects))
      if (val(c.serialProjects) !== false) return 1
      return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 4) : 2
    })(),
    articleLanguage: String(val(c.articleLanguage) ?? '').trim() || '中文',
    planMode: ['auto', 'dirs'].includes(String(val(c.planMode) ?? '').trim()) ? String(val(c.planMode)).trim() : 'auto',
    agenticArticles: val(c.agenticArticles) !== false,
    agenticMaxSteps: (() => {
      const n = Number(val(c.agenticMaxSteps))
      return Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 100) : 30
    })(),
    symbolIncremental: val(c.symbolIncremental) !== false,
    excludePaths: String(val(c.excludePaths) ?? ''),
    autoUpdate: val(c.autoUpdate) === true,
    autoUpdateMin: Math.max(5, Number(val(c.autoUpdateMin)) || 30),
    autoCommit: val(c.autoCommit) !== false,
    workspaceOnly: val(c.workspaceOnly) !== false,
  }
}

// ---------------------------------------------------------------------------
// cw 进程
// ---------------------------------------------------------------------------

function resolveBinary(cfg) {
  if (cfg.binaryPath) return cfg.binaryPath
  // PATH 优先：用户安装的 cw 与其 codewiki 源码同步演进；捆绑副本只在 PATH 找不到时兜底，
  // 避免捆绑二进制落后于源码时出现「bash 原生正常、包装层 No wiki found」的分叉。
  if (process.platform === 'win32') {
    try {
      const probe = spawnSync('where', ['cw'], { encoding: 'utf8', windowsHide: true })
      const first = String(probe.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      if (probe.status === 0 && first && fs.existsSync(first)) return first
    } catch { /* 探测失败落到捆绑副本 */ }
  } else {
    try {
      const probe = spawnSync('which', ['cw'], { encoding: 'utf8' })
      const first = String(probe.stdout ?? '').trim().split(/\r?\n/)[0]
      if (probe.status === 0 && first) return first
    } catch { /* 探测失败落到捆绑副本 */ }
  }
  const local = path.join(pluginDir, 'bin', process.platform === 'win32' ? 'cw.exe' : 'cw')
  if (fs.existsSync(local)) return local
  return 'cw'
}

function runCw(binary, cwd, args, timeoutMs = 120000, signal) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, timeoutMs)
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: -1, stdout, stderr: String(err?.message ?? err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

// cw（本地 fork，源码 vendor/codewiki，行为基线上游 main 64323823）的三态输出
//   + 逐行清单：
//   'No wiki found. Run `cw init` first.' / 'Wiki has not been compiled yet.'
//   'Wiki is up to date.' / 'Changed since last compile (<hash>):' + '  M <file>'
//   'Stale articles:' + '  ! <article>'
// cw 0.5.0.2 起 Rust 层已用 rel_path_string 输出 `/` 分隔路径；本层规范化
// 保留为纵深防御（旧二进制或上游原版在 Windows 仍输出 `\`）。
// 历史：0.5.0.1 时真源码丢失（Temp/cw-src 被清理、vendor 是过期快照），
// 曾只能在插件层收口；0.5.0.2 重建 fork 后根治下沉到 Rust，见
// vendor/codewiki/FORK.md 与 .codewiki/learnings/cw-binary-source-lost.md。
export function normalizeArticlePath(p) { return String(p ?? '').replace(/\\/g, '/') }

// cw index 直接写盘 _index.md：把 [[link|title]] 链接内的 `\` 规范化为 `/`。
// 只动链接头（`[[` 到 `|` 之间），不碰标题与正文；文件不存在时静默跳过。
export function normalizeIndexLinks(cwd) {
  const p = path.join(cwd, '.codewiki', '_index.md')
  let text
  try { text = fs.readFileSync(p, 'utf8') } catch { return false }
  const fixed = text.replace(/\[\[([^\]|\n]*?)\|/g, (m, link) => `[[${link.replace(/\\/g, '/')}|`)
  if (fixed === text) return false
  fs.writeFileSync(p, fixed)
  return true
}

export function parseStatus(stdout) {
  const s = stdout ?? ''
  if (s.includes('No wiki found')) return { state: 'missing', changedFiles: [], staleArticles: [] }
  if (s.includes('has not been compiled yet')) return { state: 'uncompiled', changedFiles: [], staleArticles: [] }
  if (s.includes('Wiki is up to date')) return { state: 'clean', changedFiles: [], staleArticles: [] }
  const changedFiles = []
  const staleArticles = []
  for (const m of s.matchAll(/^\s+[M!]\s+(.+)$/gm)) {
    const line = m[1].trim()
    if (m[0].trimStart().startsWith('M')) changedFiles.push(normalizeArticlePath(line))
    else staleArticles.push(normalizeArticlePath(line))
  }
  return { state: 'stale', changedFiles, staleArticles }
}

// wiki 篇数：递归统计 <repo>/.codewiki/ 下的 .md 文章（含 _index），总览卡展示用
function countWikiArticles(wikiPath) {
  try {
    let n = 0
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name))
        else if (e.name.endsWith('.md')) n++
      }
    }
    walk(wikiPath)
    return n
  } catch { return null }
}

// CodeWiki.md 入口：编译收尾时若仓库根缺失则自动生成。139052c 把收尾提醒门控收紧到入口文件，
// 但流水线此前从未创建它——「编译过但无入口」的仓库永远收不到收尾提醒（不变量缺口）。
// 已有入口（人工/模型速查手册）绝不覆盖；生成失败只影响入口存在性，不应让编译任务失败。
export function ensureWikiEntry(cwd, language = '中文') {
  if (!cwd) return false
  const entryPath = path.join(cwd, 'CodeWiki.md')
  if (fs.existsSync(entryPath)) return false
  const wiki = path.join(cwd, '.codewiki')
  if (/中文|zh/i.test(String(language))) {
    fs.writeFileSync(entryPath, [
      '# CodeWiki',
      '',
      '本仓库的活 wiki 由 dsh-codewiki 编译流水线自动维护（`codewiki_generate` 工具 / 编译面板）。',
      '',
      `- 入口与全部文章位于仓库根 \`${wiki}\`（在仓库根之外读写它们时一律用绝对路径）`,
      '- 索引 .codewiki/_index.md · 架构总览 .codewiki/_architecture.md · 模块文章 .codewiki/modules/ · 概念 .codewiki/concepts/',
      '- 涉及代码改动的任务收尾必须运行 codewiki_generate（scope=auto）更新受影响文章；.codewiki/ 改动与代码一起提交',
      '',
      '> 本文件由编译流水线在缺失时自动生成；若改写为人工速查手册，流水线不会覆盖。',
      '',
    ].join('\n'), 'utf8')
  } else {
    fs.writeFileSync(entryPath, [
      '# CodeWiki',
      '',
      'The living wiki of this repo is maintained by the dsh-codewiki pipeline (`codewiki_generate` tool / the CodeWiki panel).',
      '',
      `- Entry and all articles live at \`${wiki}\` (use absolute paths outside the repo root)`,
      '- Index: .codewiki/_index.md · Architecture: .codewiki/_architecture.md · Modules: .codewiki/modules/ · Concepts: .codewiki/concepts/',
      '- After code changes, run codewiki_generate (scope=auto) at wrap-up; commit .codewiki/ together with the code',
      '',
      '> Auto-generated by the pipeline when missing; a hand-written entry is never overwritten.',
      '',
    ].join('\n'), 'utf8')
  }
  return true
}

// 排除清单：换行/分号/逗号分隔的绝对路径；cwd 等于某项或位于其子树内即被排除（Windows 大小写不敏感）。
// excludedItem 返回命中的排除项原文（工具报错据此告诉模型是哪条排除项拒绝了此工作区）；
// isExcluded 保持布尔语义（面板 repos 总览 excluded 字段依赖布尔）。
function excludedItem(cwd, list) {
  const items = String(list ?? '').split(/[\n;，,]+/).map((s) => s.trim()).filter(Boolean)
  if (!items.length || !cwd) return null
  const n = path.normalize(cwd).toLowerCase().replace(/[\\/]+$/, '')
  const hit = items.find((item) => {
    const m = path.normalize(item).toLowerCase().replace(/[\\/]+$/, '')
    return n === m || n.startsWith(m + '\\') || n.startsWith(m + '/')
  })
  return hit ?? null
}
function isExcluded(cwd, list) {
  return excludedItem(cwd, list) !== null
}

// ---------------------------------------------------------------------------
// linked git worktree 检测（1.2.0）：不给 worktree 里的文件编译 wiki，等它合并回主仓库
// 后再统一编译——否则同一份代码在隔离工作区与主仓库各编一遍，产物互相覆盖、提交时机也乱。
//
// 判据只用 git 自己（可靠、与目录命名无关）：linked worktree 中
//   `git rev-parse --git-dir`        → <主仓库>/.git/worktrees/<name>
//   `git rev-parse --git-common-dir` → <主仓库>/.git
// 两者 resolve 后不同；主工作区里两者都是 .git，相同。submodule 两者也相同（不误判）。
// 非 git 仓库（rev-parse 失败）→ 不算 worktree，照常放行。
// 返回 null 或 { gitDir, commonDir }（供报错文案带上真实路径）。
// ---------------------------------------------------------------------------
export function detectLinkedWorktree(cwd) {
  if (!cwd) return null
  let r
  try {
    r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], {
      cwd, encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
  } catch { return null }
  if (!r || r.status !== 0) return null
  const [gitDirRaw, commonDirRaw] = String(r.stdout ?? '').trim().split(/\r?\n/)
  if (!gitDirRaw || !commonDirRaw) return null
  const gitDir = path.resolve(cwd, gitDirRaw)
  const commonDir = path.resolve(cwd, commonDirRaw)
  const norm = (p) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
  if (norm(gitDir) === norm(commonDir)) return null
  return { gitDir, commonDir }
}

// worktree 判定的带缓存版本：/api/codewiki/jobs 是 2s 轮询端点，逐任务 spawnSync git
// 会把宿主事件循环拖住（每次 git 冷启动数十毫秒 × N 任务 × 每 2 秒）。缓存 60s：
// 新建/删除 worktree 在面板上最多延迟一分钟才反映，可以接受。
const WORKTREE_CACHE_TTL_MS = 60000
const worktreeCache = new Map() // normKey → { wt, at }
const normPathKey = (p) => path.normalize(String(p ?? '')).replace(/[\\/]+$/, '').toLowerCase()
export function isWorktreeCwd(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return false
  const key = normPathKey(dir)
  const hit = worktreeCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < WORKTREE_CACHE_TTL_MS) return hit.wt
  let wt = false
  try { wt = detectLinkedWorktree(dir) !== null } catch { wt = false }
  worktreeCache.set(key, { wt, at: now })
  return wt
}

// 目录是否还有可编译的源码：扫不出任何源文件（空目录、只剩 .codewiki 骨架、全是黑名单
// 目录如 node_modules 的残留）就没必要提交编译——本地规划阶段的 `仓库没有可编译的源码文件`
// 失败会每分钟由自动调度重试一次，留下满屏同样的失败任务。
// 带 10 分钟缓存：autoScan 每轮对每个历史仓库调用，大仓库文件树遍历不该每分钟重跑。
const SOURCE_PROBE_TTL_MS = 10 * 60 * 1000
const sourceProbeCache = new Map() // normKey → { has, at }
export function hasCompilableSources(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return false
  let st
  try { st = fs.statSync(dir) } catch { return false } // 目录都没了，当然没源码
  if (!st.isDirectory()) return false
  const key = normPathKey(dir)
  const now = Date.now()
  const hit = sourceProbeCache.get(key)
  if (hit && now - hit.at < SOURCE_PROBE_TTL_MS) return hit.has
  let has = false
  try { has = scanRepoFiles(dir).length > 0 } catch { has = false }
  sourceProbeCache.set(key, { has, at: now })
  return has
}
// 手动编译/目录内容变化后清掉探测缓存，别让 10 分钟前的空判定挡住真实提交
export function clearSourceProbeCache(cwd) {
  if (!cwd) return sourceProbeCache.clear()
  sourceProbeCache.delete(normPathKey(String(cwd)))
}

// 「这个目录根本不是有效的编译对象」的统一判定（面板任务列表 / 仓库总览共用）：
//   · linked worktree            → 编译它只会和主仓库产物打架（1.2.0 起 submit 直接拒绝）
//   · 目录在、但扫不出可编译源码  → 空壳/只剩 node_modules 的残留，编译必然失败（1.2.1 起拒绝）
// 目录已不存在时不算 dead：那是「历史任务的目录后来被删了」，历史记录仍有查看价值，
// 不能因为 statSync 失败就把用户的历史数据从面板上抹掉。
export function isDeadCompileTarget(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return false
  if (isWorktreeCwd(dir)) return true
  let exists = false
  try { exists = fs.statSync(dir).isDirectory() } catch { exists = false }
  if (!exists) return false
  return !hasCompilableSources(dir)
}

// ---------------------------------------------------------------------------
// Token 预算与输入装填
// ---------------------------------------------------------------------------

// 粗算 token 数：CJK 字符 ≈ 1 token/字，其余（ASCII 代码为主）≈ 3.5 字符/token。
// 只为把单请求输入装进模型上下文（hy3 默认 192k，见 BATCH_TOKEN_BUDGET），不需要精确分词器。
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return cjk + Math.ceil((s.length - cjk) / 3.5)
}

// 宿主 llm 服务通道：唯一通道。走 DSH 模型设置里已注册的 provider/model（含本地 OpenAI
// 兼容端点，如 ollama/lmstudio/vllm），凭证由宿主按该 provider 的配置解析——插件不碰密钥、
// 不再自带任何直连通道（0.10.1 起删除内置百炼兼容入口）。
// reasoningEffort 是宿主 llm 的枚举档位（off/low/medium/high/xhigh/max），由模型目录
// （resolveModel().reasoning.efforts）给出可选值；留空=用该模型默认档。
// 失败统一抛错，由并发池按单任务失败记账。
// onDelta（可选）：每收到一个流式 chunk 就回调一次（传原始 chunk）——会话记录器用它
// 做「正在进行」的实时增量落盘；提取不到文本时静默，完成时全文覆盖。
async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta }) {
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin:codewiki' } })],
    temperature: 0,
    signal,
  })) {
    assembler.push(chunk)
    if (onDelta) { try { onDelta(chunk) } catch { /* 记录失败不影响编译 */ } }
  }
  const finish = assembler.finish
  if ((finish?.kind === 'error' || finish?.kind === 'aborted') && reasoningEffort
    && String(finish.failure?.code ?? '') === 'UNSUPPORTED_REASONING_EFFORT') {
    // 该模型不支持配置的思考档位：剥掉 effort 用模型默认档重试一次，不让整篇编译失败
    return llmChat({ llm, provider, model, reasoningEffort: undefined, prompt, signal, onDelta })
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(`llm 通道失败（${finish.kind}，${String(finish.failure?.code ?? 'unknown')}）：${String(finish.failure?.message ?? '')}`)
  }
  const content = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
  if (!content) throw new Error('llm 通道响应缺少 content')
  return { content, outputTokens: Number(assembler.usage?.outputTokens) || 0 }
}

// 任务结果统一出口：keepInMemory 任务（校对）把 content 带回内存由服务侧消费，
// 文章任务直接落盘。普通任务与超大任务兜底共用。
function applyTaskResult(task, content, notes) {
  if (task.keepInMemory) return { name: task.name, ok: true, stopReason: 'completed', content }
  try {
    fs.mkdirSync(path.dirname(task.articlePath), { recursive: true })
    const fx = fixAnchors(content, task.cwd ?? null)
    if (fx.fixed > 0) notes.push(`文章 ${task.name} 自动修正 ${fx.fixed} 处行号锚点`)
    if (fx.unresolved.length) notes.push(`文章 ${task.name} 行号锚点存疑（未改）：${fx.unresolved.slice(0, 3).join('；')}${fx.unresolved.length > 3 ? ' 等' : ''}`)
    fs.writeFileSync(task.articlePath, fx.text, 'utf8')
    return { name: task.name, ok: true, stopReason: 'completed' }
  } catch (err) {
    notes.push(`文章 ${task.name} 落盘失败 —— ${String(err?.message ?? err)}`)
    return { name: task.name, ok: false, stopReason: 'error' }
  }
}

// 并发池：唯一执行器。按 maxConcurrency 同时在飞地消费任务队列，全部走宿主 llm 服务
// （唯一的模型通道，凭证由宿主按 provider 解析）。signal 用于取消时中断在飞请求。
// onTaskDone 每任务上报 {outputTokens, durationMs} 供 tps 采样。
// 每个任务可带自己的 model/provider/reasoningEffort（大档任务用），缺省回落到参数里的
// 普通档模型——一期请求先按任务装填时的模型分派，不在运行期再改。
// 大档与默认档并发上限分开（0.12.2）：t.bigTier === true 的任务进大档池（bigConcurrency），
// 其余进默认档池（concurrency）。两个池各自独立计数、同时推进——大档模型常是付费长上下文档，
// 与免费默认档的配额互不相干，共用一个上限会让「大档只多几个请求」把默认档全部堵住。
// bigConcurrency 为 0 / 未传时回落到 concurrency（与 0.12.1 行为一致）。
// 返回 Map(customId → 结果)（{ok, stopReason, content?}）。
// onRequestStart(task)（可选）：每个请求发起前回调，返回 null 或
// { onDelta(chunk), onDone(content, outputTokens), onError(err) }——会话记录器挂钩，
// 让面板能看到「目前正在进行的会话内容」。
export async function runRealtimeTasks(tasks, { model, reasoningEffort, concurrency, bigConcurrency = 0, notes, onTaskDone, signal, llm, provider, onRequestStart }) {
  const results = new Map()
  // 分池：大档任务与默认档任务各自独立限流。判定只看任务装填时打的 bigTier 标记
  // （文章装填 markBig、横切/校对的大档标记都写它），不按 provider 猜——用户完全可能
  // 把默认档也配成同一个 provider。
  const bigTasks = []
  const normalTasks = []
  for (const t of tasks) {
    if (t.bigTier === true) bigTasks.push(t)
    else normalTasks.push(t)
  }
  const pools = []
  if (normalTasks.length) {
    pools.push({ tasks: normalTasks, limit: Math.max(1, Math.min(concurrency, normalTasks.length)) })
  }
  if (bigTasks.length) {
    const bigLimit = Number.isFinite(Number(bigConcurrency)) && Number(bigConcurrency) >= 1
      ? Number(bigConcurrency)
      : concurrency
    pools.push({ tasks: bigTasks, limit: Math.max(1, Math.min(bigLimit, bigTasks.length)) })
  }
  const runPool = async (pool) => {
    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return
        const i = cursor++
        if (i >= pool.tasks.length) return
        const t = pool.tasks[i]
        const rec = onRequestStart ? onRequestStart(t) : null
        try {
          const startedAt = Date.now()
          const { content, outputTokens } = await llmChat({
            llm,
            provider: t.provider || provider,
            model: t.model || model,
            // 任务自带 provider+model（大档任务）时 effort 完全以任务为准（空=模型默认档），
            // 不回落普通档配置——普通档的 effort（如 off）可能不被大档模型支持
            reasoningEffort: (t.provider && t.model)
              ? (t.reasoningEffort || undefined)
              : (t.reasoningEffort || reasoningEffort),
            prompt: t.batchPrompt,
            signal,
            onDelta: rec?.onDelta,
          })
          if (onTaskDone && outputTokens > 0) onTaskDone({ outputTokens, durationMs: Date.now() - startedAt })
          results.set(t.customId, applyTaskResult(t, content, notes))
          rec?.onDone?.(content, outputTokens)
        } catch (err) {
          notes.push(`${t.name} 请求失败 —— ${String(err?.message ?? err)}`)
          results.set(t.customId, { name: t.name, ok: false, stopReason: 'error' })
          rec?.onError?.(err)
        }
      }
    }
    await Promise.all(Array.from({ length: pool.limit }, worker))
  }
  await Promise.all(pools.map(runPool))
  return results
}

// ---------------------------------------------------------------------------
// 模型执行（唯一通道：宿主 llm 服务）
// 全部环节（写文章/横切/校对）都是单轮文本生成，统一走同一个后台并发池，
// 模型/提供商/思考档位全部取自插件设置里选中的「模型设置」条目，
// 凭证由宿主按该 provider 解析——插件不再有任何自带直连通道。
// 输入按 token 预算（BATCH_TOKEN_BUDGET，默认 110k）装填；装不下的单文件升
// BATCH_TOKEN_HARD_LIMIT 大档。请求随连接生死，宿主重启按 prompt 快照重跑。
// ---------------------------------------------------------------------------

// 单个请求的输入 token 预算：默认模型 hy3 上下文 192k、单请求输出上限 64k，
// 输入侧留 128k；再扣输出与估算误差余量，取 110k。
const BATCH_TOKEN_BUDGET = 110000
// 超预算兜底装填上限：单文件/单任务装不进 110k 时按该大档再装一次；
// 仍装不下才落到会话通道（最后的兜底，见 dispatchSessionTasks）。
// 上限由 hy3 的真实窗口反推：contextWindow 192k 是输入+输出共享的，单请求输出上限
// maxTokens 64k，故输入必须 ≤128k（旧值 150k 输入 + 64k 输出 = 214k，已越界）。
const BATCH_TOKEN_HARD_LIMIT = 128000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// 源码行号前缀：每行加「N| 」grep 风格标注，让模型引用行号时以前缀为准而不是自己数行
// （弱模型自己数行首尾常对、中段系统性错位）。尾部至多去一个换行——多去会把真实空行
// 挤掉导致总行数偏小；split('\n') 后空文件得到 ['']，输出「1| 」可接受。
export function numberLines(content) {
  return content.replace(/\r?\n$/, '').split('\n').map((line, i) => `${i + 1}| ${line.replace(/\r$/, '')}`).join('\n')
}

// ---------------------------------------------------------------------------
// 行号锚点自动修正（第四层兜底）：文章落盘前把「file:NN(-MM)」锚点对照源码确定性校正。
// 语义与 test-wiki-anchors.mjs 的符号绑定一致：锚点起点行应包含该行反引号内符号（或其
// 末段）；不包含时在源文件全文找符号出现行——恰好一处 → 修正；多处 → 取唯一的行首声明
// 形态（function/class/const/let），仍歧义则不动；找不到 → 不动。全部修正只改行号数字，
// 绝不动文章其他内容；source_files 之外的文件引用一律不碰。符号提取规则复制自
// test-wiki-anchors.mjs symbolsOnLine（两处同源，改一处须同步另一处）。
export function fixAnchors(content, cwd) {
  const unresolved = []
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch || !cwd) return { text: content, fixed: 0, unresolved }
  const srcs = parseSourceFiles(fmMatch[1])
  if (!srcs.length) return { text: content, fixed: 0, unresolved }
  const resolveFile = (f) => {
    if (srcs.includes(f)) return f
    const cands = srcs.filter((r) => r.split('/').pop() === f)
    return cands.length === 1 ? cands[0] : null
  }
  const cache = new Map()
  const loadSource = (rel) => {
    if (!cache.has(rel)) {
      try {
        cache.set(rel, fs.readFileSync(path.join(cwd, rel), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/))
      } catch { cache.set(rel, null) }
    }
    return cache.get(rel)
  }
  const symbolsOnLine = (line) => {
    const out = []
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const sym = m[1].trim().replace(/\(.*\)$/, '').trim()
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(sym)) continue
      if (sym.length < 3 || sym.split('.').pop().length < 3) continue
      out.push(sym)
    }
    return out
  }
  const hasSym = (srcLine, s) => srcLine.includes(s) || srcLine.includes(s.split('.').pop())
  const bodyStart = fmMatch[0].split(/\r?\n/).length // 正文首行（1-based 行号 ≤ bodyStart 是 frontmatter）
  const crlf = /\r\n/.test(content)
  const lines = content.split(/\r?\n/)
  let fixed = 0
  const anchorRe = /([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g
  const text = lines.map((line, idx) => {
    if (idx + 1 <= bodyStart) return line
    const syms = symbolsOnLine(line)
    if (!syms.length) return line
    return line.replace(anchorRe, (whole, f, n1, n2) => {
      const rel = resolveFile(f)
      if (!rel) return whole
      const src = loadSource(rel)
      if (!src) return whole
      const start = Number(n1)
      const at = `${rel}:${start}${n2 ? `-${n2}` : ''}`
      if (src[start - 1] && syms.some((s) => hasSym(src[start - 1], s))) return whole // 已正确
      let R = null
      let ambiguous = false
      for (const s0 of syms) {
        // 点分符号（如 Config.articleLanguage）歧义时退试首段——首段才是可声明的部分
        const cands = s0.includes('.') ? [s0, s0.split('.')[0]] : [s0]
        for (const s of cands) {
        const hits = []
        src.forEach((l, i) => { if (hasSym(l, s)) hits.push(i + 1) })
        if (hits.length === 1) { R = hits[0]; break }
        if (hits.length > 1) {
          // 声明形态：符号是本行声明的目标（const gamma = beta() 这种「别的符号的声明」不算——
          // function/class 直接跟符号；const/let 要求符号后跟 =，排除赋值右侧引用）
          const tail = s.split('.').pop().replace(/[$]/g, '\\$')
          const defRe = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function|class)\\s+${tail}\\b|^[ \\t]*(?:export\\s+)?(?:const|let)\\s+${tail}\\s*=`)
          const defs = hits.filter((n) => defRe.test(src[n - 1]))
          if (defs.length === 1) { R = defs[0]; break }
          ambiguous = true // 试下一个候选
        }
        }
        if (R !== null) break
      }
      if (R === null) {
        unresolved.push(`${at} ${ambiguous ? '符号歧义' : '符号未找到'}未改`)
        return whole
      }
      if (n2) {
        const end2 = Number(n2)
        fixed += 1
        return `${f}:${R}-${Math.min(R + (end2 - start), src.length)}` // 区间尾越界钳到文件尾（修正起点是净改善）
      }
      fixed += 1
      return `${f}:${R}`
    })
  }).join(crlf ? '\r\n' : '\n') // 混合行尾按整文主风格规范化
  return { text, fixed, unresolved }
}

// 把源文件内联成 markdown 文本；按 token 预算整文件装填（不做半文件截断——半截代码误导行号）。
// 返回 { text, skipped, oversized }：skipped 是预算装不下的文件清单，oversized=true 表示
// 连第一个文件都装不下（text 原样带这一个文件，任务整体转超预算兜底）。
export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET) {
  const parts = []
  const skipped = []
  let used = 0
  let first = true
  for (const rel of files) {
    const abs = path.join(cwd, rel)
    let content = null
    try { content = fs.readFileSync(abs, 'utf8') } catch { /* 缺文件在文内标注 */ }
    const body = content === null
      ? `### ${rel}\n\n（文件不存在或读取失败）\n`
      : `### ${rel}\n\n\`\`\`\n${numberLines(content)}\n\`\`\`\n`
    const size = estimateTokens(body)
    if (used + size > budget) {
      if (first) return { text: body, skipped: [], oversized: true }
      skipped.push(rel)
      continue
    }
    parts.push(body)
    used += size
    first = false
  }
  let text = parts.join('\n')
  if (skipped.length) {
    text += `\n（以下文件因单请求输入预算未内联，行号相关描述不得涉及它们：${skipped.join('、')}）\n`
  }
  return { text, skipped, oversized: false }
}

// 批量模式单轮文章 prompt：与智能体版共享格式条款（articleFormatSection），
// 区别是源码内联、文章由插件落盘，因此要求「只输出文章本身」。
function batchArticlePrompt({ language, mission, sourcesText, prevArticle }) {
  const parts = [
    `你是 CodeWiki 文章作者。文章全文用${language}书写。`,
    '',
    `任务：${mission}`,
    '',
    '以下是你需要的全部源码（路径相对仓库根；每行以「行号| 」前缀标注行号，引用行号一律以前缀为准）：',
    '',
    sourcesText,
  ]
  if (prevArticle) {
    parts.push(
      '',
      '这篇文章的当前内容（基于旧版代码，供保留章节结构与 title/type/tags；其中引用的行号可能已过期，一律不得沿用，行号必须按源码「行号| 」前缀重新标注）：',
      '',
      prevArticle,
    )
  }
  parts.push(
    '',
    '直接输出完整文章：以 --- frontmatter 开始（title/type/source_files/tags），',
    'source_files 列出上文中你实际引用的源文件（POSIX 风格相对路径，含上文的测试文件）。',
    '只输出文章本身——禁止用 markdown 代码围栏整体包裹、禁止任何解释文字。',
    '',
    articleFormatSection(),
  )
  return parts.join('\n')
}

// 把通用任务（sources+mission+可选 prevArticle）装配成批量请求：内联源码、拼 prompt、
// 分配 customId。
// 分割（观察→合成，复用横切先例）：模块源码总量超单请求预算时按文件装填拆成多个小
// 观察批（_split/ 任务，keepInMemory），收割后拼观察包提交一个合成请求写完整文章。
// 存在单文件连观察批预算都装不下时，该任务走「大档通道」——改用 bigProvider/bigModel
// （默认 volces-ark/glm-5.3-flash，512k 上下文）在插件内直接写完，不再交会话模型。
// 只有大档也装不下（即 bigTokenBudget 都超）时，才落到会话通道兜底（见 dispatchSessionTasks），
// 且仅当 bigProvider 留空才允许这条兜底路径。
// 返回 { prepared, sessionTasks }：prepared 含普通任务、_split/ 观察任务与大档任务，
// 任务上的 model/provider/reasoningEffort 指该任务用哪个模型跑；
// sessionTasks 带 batchPrompt（大档装填，派发时写入任务文件供子智能体读取）。
export function prepareArticleTasks(tasks, { cwd, language, bigProvider = '', bigModel = '', bigReasoningEffort = '', bigBudget = DEFAULT_BIG_TOKEN_BUDGET } = {}) {
  const prepared = []
  const sessionTasks = []
  // 大档可用：配置了 bigProvider 才算启用；启用后普通档装不下的任务改走大档，不再交会话模型
  const bigTier = String(bigProvider ?? '').trim()
    ? {
        provider: String(bigProvider).trim(),
        model: String(bigModel ?? '').trim() || DEFAULT_BIG_MODEL,
        ...(String(bigReasoningEffort ?? '').trim() ? { reasoningEffort: String(bigReasoningEffort).trim() } : {}),
        budget: Math.max(BATCH_TOKEN_BUDGET, Number(bigBudget) || DEFAULT_BIG_TOKEN_BUDGET),
      }
    : null
  const markBig = (t) => {
    if (!bigTier) return false
    t.provider = bigTier.provider
    t.model = bigTier.model
    if (bigTier.reasoningEffort) t.reasoningEffort = bigTier.reasoningEffort
    else delete t.reasoningEffort
    t.bigTier = true
    return true
  }
  for (const t of tasks) {
    // 装填直接按单文件上限（大档开启=大档预算，否则 128k 硬上限）。hy3 适配（0.10.8）：
    // 超 110k 普通预算的模块先整任务按大档（或硬上限）单请求一次写完，观察→合成分割
    // 只保留给连大档都装不下的超大模块——不再为 32k 时代的比价而拆批。
    const singleLimit = bigTier ? bigTier.budget : BATCH_TOKEN_HARD_LIMIT
    let { text, oversized: tooBig, skipped } = collectSources(cwd, t.sources, singleLimit)
    const prevArticle = t.prevArticlePath
      ? (() => { try { return fs.readFileSync(t.prevArticlePath, 'utf8') } catch { return '' } })()
      : ''
    const promptOf = (sourcesText) => batchArticlePrompt({ language, mission: t.mission, sourcesText, prevArticle })
    const emitSingle = (sourcesText) => {
      t.batchPrompt = promptOf(sourcesText)
      delete t.splitFor; delete t.composePlan
      if (estimateTokens(t.batchPrompt) > BATCH_TOKEN_BUDGET) markBig(t)
      t.customId = t.customId ?? `t${prepared.length}`
      prepared.push(t)
    }
    const emitSession = (sourcesText) => {
      t.batchPrompt = promptOf(sourcesText)
      delete t.splitFor; delete t.composePlan // 复用任务对象时清残留分割字段
      sessionTasks.push(t)
    }
    if (tooBig) { emitSession(text); continue } // 单文件连大档都装不下：唯一兜底=会话通道
    const pt = skipped.length ? Infinity : estimateTokens(promptOf(text))
    // 整任务一个请求装得下（预算内走普通档，110k–singleLimit 走大档/硬上限）：主路径
    if (!skipped.length && pt <= singleLimit) { emitSingle(text); continue }
    // 装不下（有文件被跳过或总量超单请求上限）：按普通预算逐文件装填拆成多个观察批
    // （keepInMemory），收割后拼观察包提交一个合成请求写完整文章。
    const batches = []
    let hasOversizeSingle = false
    for (const rel of t.sources) {
      const one = collectSources(cwd, [rel], singleLimit)
      if (one.oversized) { hasOversizeSingle = true; break } // 单文件连大档都超：整任务转兜底
      const last = batches[batches.length - 1]
      if (last && estimateTokens(last.text + '\n' + one.text) <= BATCH_TOKEN_BUDGET) {
        last.text += '\n' + one.text
        last.files.push(rel)
      } else {
        batches.push({ text: one.text, files: [rel] })
      }
    }
    if (hasOversizeSingle) { emitSession(text); continue }
    if (batches.length > 1) {
      const base = `split${prepared.length}`
      batches.forEach((b, i) => {
        prepared.push({
          customId: `${base}o${i}`,
          name: `${t.name}#obs${i}`,
          keepInMemory: true,
          batchPrompt: batchArticleObservePrompt(language, t.name, b.text, i, batches.length),
          splitFor: t.name,
          composePlan: {
            mission: t.mission, articlePath: t.articlePath,
            prevArticlePath: t.prevArticlePath ?? null,
            batchCount: batches.length, files: b.files,
          },
        })
      })
      continue
    }
    // 拆完只剩一批（装填边界：整包超限但逐文件重排后单批装下）：按普通预算单请求写完
    emitSingle(batches[0]?.text ?? text)
  }
  return { prepared, sessionTasks }
}

// ---------------------------------------------------------------------------
// prompt 模板（条款取自上游 skills/codewiki-session.md）
// ---------------------------------------------------------------------------

function articleFormatSection() {
  return [
    '文章格式（严格遵守）：',
    '```',
    '---',
    'title: <模块名>',
    'type: module',
    'source_files:',
    '  - path/to/file1',
    '  - path/to/test_file',
    'tags: [相关, 标签]',
    '---',
    '',
    '## Overview',
    '## Key Components',
    '## Architecture',
    '## Data Flow',
    '## Connections',
    '## Known Issues',
    '```',
    '- Key Components：列出该模块全部公开函数/类/常量及其行号与用途；每个 struct/model 的全部字段（含时间戳、自动生成字段）；全部方法（含属性方法、__str__、save() 等）',
    '- 行号以源码「行号| 」前缀为准（如 12| let conf_path = ... 即第 12 行），禁止自行数行或猜测；行号区间覆盖完整函数/代码块，不得截断',
    '- source_files 必须列出你为写本文读过的每一个文件（含测试文件），路径相对仓库根，POSIX 风格',
    '- 功能被禁用/注释时写明具体位置（哪个文件哪一行），不许只写 "disabled"',
    '- Architecture：组件 ≥3 或流程非平凡时，画 UTF-8 box-drawing 框图（┌ ┐ └ ┘ ─ │ ► ◄ ▼）放进 ```text 围栏，≤20 行，框内标注组件名与文件/类，箭头标注关系',
    '- Markdown 规范：## 顶级、### 子级不跳级；行内代码用反引号；多行代码用带语言标签的围栏；结构化对比用 markdown 表；标题/代码块/列表前后留空行',
    '- Connections 用 Obsidian [[backlinks]]（[[other-module]]）连接相关模块',
    '- 写给对这个代码库零上下文的未来 agent：具体到文件名、函数名、类型、行号；宁可多细节，不许概括省略',
  ].join('\n')
}

// 本地规划：按顶层目录分组生成模块清单（0.10.7 起是唯一规划路径——模型勘探的单独
// 规划阶段已删，编译模型上下文足够大，模块划分不再值得一次独立请求）。
// 宁可粗也不中断整条流水线。
// agentic 通道退回判定（模块级导出便于单测）：本批 agentic 结果里失败过半才算「系统性失败」。
// 一两篇失败是模型偶发（步数用尽 / 空文章），整批重跑的代价大于收益；单篇失败已由 tally 记账。
// 调用方另需守 job.agenticRetried —— 只退一次，否则退回后仍失败会每 tick 重新提交成死循环。
export function shouldFallBackFromAgentic(results) {
  const relevant = Array.isArray(results) ? results : []
  if (!relevant.length) return false
  const failed = relevant.filter((r) => !r.ok).length
  return failed * 2 > relevant.length
}

export function localPlan(files) {
  const groups = new Map()
  for (const f of files) {
    const top = f.path.split('/')[0]
    const name = slugify(top === f.path ? 'root' : top)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(f.path)
  }
  return {
    project: '（本地规划：按顶层目录分组）',
    modules: [...groups.entries()].map(([name, fs_]) => ({ name, summary: `${name} 目录下的源码`, files: fs_ })),
    concepts: [],
  }
}

// 语义规划（吸收自 FSoft-AI4Code/CodeWiki 的 module analysis + cluster_modules）：
//   1. tree-sitter AST 提取全仓库符号（函数/类/方法/import）与依赖图；
//   2. 把组件清单交给模型做语义聚类（不是按目录切），得到按职责划分的模块树；
//   3. 超大模块递归下钻，顶层过多时超级分组。
// 与原 localPlan 的区别：模块边界来自「代码实际调用/导入关系 + 模型对职责的判断」，
// 而不是目录名——同一目录里两套互不相干的东西会被拆开，跨目录的同一功能会被并到一起。
// 任何环节失败都返回 fallback=true，由调用方退回 localPlan（宁可粗也不中断流水线）。
export async function semanticPlan(files, { cwd, llm, provider, model, reasoningEffort, signal, notes = [] } = {}) {
  const startedAt = Date.now()
  // scanRepoFiles 只给 {path, bytes}，不读正文；extractRepoGraph 要 f.content。
  // 先统一读一遍正文（提取与建边共用，不读两遍）。
  const textByFile = new Map()
  const filesWithText = []
  for (const f of files) {
    const rel = typeof f === 'string' ? f : f.path
    let text = typeof f === 'object' && typeof f.content === 'string' ? f.content : null
    if (text === null) {
      try { text = fs.readFileSync(path.resolve(cwd ?? '.', rel), 'utf8') } catch { text = '' }
    }
    textByFile.set(rel, text)
    filesWithText.push({ path: rel, content: text })
  }

  // 组件提取不需要模型，先跑；解析不了的文件（无对应语法）跳过并记账
  let graph, byFile
  try {
    const ex = await extractRepoGraph(filesWithText, { cwd, rootDir: cwd })
    if (!ex.ready) {
      notes.push(`符号提取不可用（${ex.extractor?.initError ?? 'tree-sitter 未就绪'}），退回目录分组`)
      return { plan: null, fallback: true, reason: 'extractor-unavailable' }
    }
    graph = ex.graph
    byFile = ex.byFile
  } catch (err) {
    notes.push(`符号提取失败，退回目录分组 —— ${String(err?.message ?? err).slice(0, 200)}`)
    return { plan: null, fallback: true, reason: 'extract-failed' }
  }
  const components = [...graph.values()]
  if (!components.length) {
    notes.push('符号提取未得到任何组件（仓库无受支持语言的源码），退回目录分组')
    return { plan: null, fallback: true, reason: 'no-components' }
  }
  let edges = []
  try { edges = resolveImportEdges(graph, byFile, textByFile) } catch { /* 依赖边失败不影响聚类 */ }

  const llmCall = llm && (provider || model)
    ? async (prompt) => {
      const { content } = await llmChat({ llm, provider, model, reasoningEffort, prompt, signal })
      return content
    }
    : null

  let result
  try {
    result = await clusterComponents({ components, llmCall, signal })
  } catch (err) {
    notes.push(`语义聚类失败，退回目录分组 —— ${String(err?.message ?? err).slice(0, 200)}`)
    return { plan: null, fallback: true, reason: 'cluster-failed' }
  }
  for (const w of result.warnings ?? []) notes.push(`规划：${w}`)

  // 没有模型参与时聚类只是目录启发式——与 localPlan 等价，如实标注
  const plan = {
    project: result.stats?.llm
      ? '（语义规划：AST 符号聚类）'
      : '（语义规划不可用，已降级为目录聚类）',
    modules: toPlanModules(result),
    concepts: result.concepts ?? [],
    // 模块树与符号图随 plan 持久化：stale 增量要用组件粒度判定「哪些真的变了」
    tree: result.tree ?? null,
    graph: {
      components: components.map((c) => ({
        id: c.id, name: c.name, kind: c.kind, relativePath: c.relativePath,
        parameters: c.parameters ?? [],
        baseClasses: c.baseClasses ?? [],
        dependsOn: c.dependsOn ?? [],
        sourceCode: c.sourceCode ?? '',
        docstring: c.docstring ?? '',
      })),
      edges,
    },
    stats: { ...result.stats, durationMs: Date.now() - startedAt, components: components.length },
  }
  if (!plan.modules.length) {
    notes.push('语义聚类没有产出任何模块，退回目录分组')
    return { plan: null, fallback: true, reason: 'empty-plan' }
  }
  return { plan, fallback: false, result }
}

// 横切输入装配：整篇装填成功文章；装不下的装头部（frontmatter + Overview 段）并标注截断。
// articles: [{name, text}]；预算按 token 计（与批量单请求同预算）。
export function packArticles(articles, budget = BATCH_TOKEN_BUDGET) {
  const parts = []
  let used = 0
  for (const a of articles) {
    let text = a.text
    const size = estimateTokens(text)
    if (used + size > budget && parts.length) {
      const head = text.slice(0, Math.max(0, text.indexOf('## Key Components')))
      const headSize = estimateTokens(head)
      if (used + headSize <= budget) {
        parts.push(`#### ${a.name}（超预算，仅头部）\n\n${head}`)
        used += headSize
      }
      continue
    }
    parts.push(`#### ${a.name}\n\n${text}`)
    used += size
  }
  return parts.join('\n\n')
}

function crosscutIntro(language, what, requirements) {
  return [
    `你是 CodeWiki 横切文章作者。文章全文用${language}书写。`,
    '',
    `任务：${what}`,
    '',
    requirements,
    '',
    '直接输出完整文章：以 --- frontmatter 开始（title/type/source_files/tags）。',
    '只输出文章本身——禁止用 markdown 代码围栏整体包裹、禁止任何解释文字。',
    'source_files 列出你实际依据的下文模块文章 frontmatter 里出现的源文件（POSIX 相对路径）。',
  ].join('\n')
}

function batchArchitecturePrompt(language, articlesText) {
  return crosscutIntro(
    language,
    `基于下文全部模块文章，写系统总览 _architecture.md。必须含三张 UTF-8 box-drawing 图（┌ ┐ └ ┘ ─ │ ► ◄ ▼）放进 \`\`\`text 围栏：System Overview 总框图、Request/Data Flow 数据流、Dependency Graph 依赖方向，说明各模块职责与相互连接。frontmatter type: architecture。章节：## Overview / ## System Overview / ## Data Flow / ## Dependency Graph / ## Module Roles。`,
    '行号可以引用模块文章中的行号；Markdown 规范；写给零上下文的未来 agent。',
  ) + `\n\n以下全部模块文章：\n\n${articlesText}`
}

function batchPatternsPrompt(language, articlesText) {
  return crosscutIntro(
    language,
    '基于下文全部模块文章，总结仓库反复出现的模式 _patterns.md（命名约定、错误处理风格、构建/测试流程、目录约定等，每模式一节并给出处）。frontmatter type: pattern。章节：## Overview / ## Patterns。',
    '每个模式必须引用具体模块文章中出现的文件/函数名作为证据。',
  ) + `\n\n以下全部模块文章：\n\n${articlesText}`
}

function batchConceptPrompt(language, concept, articlesText) {
  return crosscutIntro(
    language,
    `基于下文模块文章，写跨模块概念「${concept}」一篇专文。讲清该概念涉及哪些模块、数据/控制如何在它们之间流动、实现位置（文件:行号）。frontmatter type: concept，title 用该概念名。章节：## Overview / ## Involved Modules / ## Flow / ## Implementation Map。`,
    '只依据下文模块文章，不得发明未出现的文件。',
  ) + `\n\n以下全部模块文章：\n\n${articlesText}`
}

// 模块观察 prompt（横切 map 阶段）：每篇模块文章一个小任务，输出紧凑观察。
// 输出刻意不带 frontmatter——观察批不走 tally 落盘，只在合成批拼包。
function batchObservePrompt(language, moduleName, articleText) {
  return [
    `你是 CodeWiki 架构观察员。观察全文用${language}书写。`,
    '',
    `任务：通读下文模块「${moduleName}」的完整文章，输出该模块的架构观察（紧凑 markdown）。必含：`,
    '1. 模块职责（一句话）；',
    '2. 对外接口/入口：函数、类、路由名 + 文中行号；',
    '3. 依赖方向：依赖哪些模块、被谁依赖（从文中引用推断）；',
    '4. 值得进入系统总览的模式、约定或风险；',
    '5. `source_files:` 原样列出文章 frontmatter 里的源文件（POSIX 相对路径）。',
    '',
    '只输出观察正文——禁止 frontmatter、禁止用代码围栏整体包裹。',
    '',
    `### ${moduleName}`,
    '',
    articleText,
  ].join('\n')
}

// 文章分割观察 prompt（模块源码超单请求预算时）：一批源码 → 该批源码的紧凑技术观察。
// 与横切观察不同，这里观察对象是源码而非文章，输出要保留写文章所需的全部细节。
function batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal) {
  return [
    `你是 CodeWiki 文章观察员。观察全文用${language}书写。`,
    '',
    `任务：模块「${moduleName}」的源码量大，已按文件分成 ${batchTotal} 批（本批为第 ${batchIndex + 1} 批）。`,
    '通读下文本批源码，输出紧凑而完整的技术观察（markdown），供后续不看源码直接写整篇模块文章。必含：',
    '1. 本批每个文件的职责与关键实现（保留全部函数/类/导出名、重要常量与默认值、关键行号——行号以源码「行号| 」前缀为准，禁止自行数行）；',
    '2. 文件间调用关系与数据流（谁调用谁、入参/返回值形状）；',
    '3. 错误处理、边界条件与非显然行为；',
    '4. 本批文件清单（POSIX 相对路径）。',
    '',
    '要求：宁全勿简——被你省略的细节合成阶段将永远缺失；但禁止贴大段源码，引用「文件:行号」（行号以源码「行号| 」前缀为准）即可。',
    '只输出观察正文——禁止 frontmatter、禁止用代码围栏整体包裹。',
    '',
    sourcesText,
  ].join('\n')
}

// 文章分割合成 prompt：全部批次观察（+可选旧文）→ 完整模块文章。
// 输入体积 = 各批观察之和，远小于原始源码，天然不超单请求预算。
function batchArticleComposePrompt({ language, mission, moduleName, observationsText, prevArticle }) {
  const parts = [
    `你是 CodeWiki 文章作者。文章全文用${language}书写。`,
    '',
    `任务：${mission}`,
    '',
    `模块「${moduleName}」源码量大，已由多个观察员分批通读并产出观察。以下观察覆盖该模块全部源码：`,
    '',
    observationsText,
  ]
  if (prevArticle) {
    parts.push(
      '',
      '这篇文章的当前内容（基于旧版代码，供保留章节结构与 title/type/tags；其中引用的行号可能已过期，一律不得沿用，行号必须按源码「行号| 」前缀重新标注）：',
      '',
      prevArticle,
    )
  }
  parts.push(
    '',
    '只依据上述观察写完整文章；观察中引用的「文件:行号」直接沿用，不得发明未出现的文件或符号。',
    '直接输出完整文章：以 --- frontmatter 开始（title/type/source_files/tags），',
    'source_files 汇总各批观察列出的全部源文件（POSIX 风格相对路径）。',
    '只输出文章本身——禁止用 markdown 代码围栏整体包裹、禁止任何解释文字。',
    '',
    articleFormatSection(),
  )
  return parts.join('\n')
}

// 批量校对 prompt：输入=文章全文+source_files 源码，输出=修正后整文（服务侧校验后才落盘）。
// 行号抽查这类机械核对由模型一次完成，不再需要多轮工具的审校智能体。
function batchProofreadPrompt({ language, articleText, sourcesText }) {
  return [
    `你是 CodeWiki 审校员。文章全文用${language}书写。`,
    '',
    '任务：核对下文 wiki 文章与源码的一致性，输出修正后的完整文章。',
    '核对项：',
    '1. frontmatter 必有 title/type/source_files/tags，source_files 与正文实际引用一致',
    '2. 抽查文中全部函数/类名与行号（上源码逐个核对；行号以源码「行号| 」前缀为准，禁止自行数行）：名字错改名字、行号错改行号、归属错改归属',
    '3. 重大源码文件被引用但未列入 source_files 的，补进 frontmatter',
    '4. 与源码不符的描述段落直接改写',
    '',
    '只输出修正后的完整文章（以 --- frontmatter 开始）——禁止围栏整体包裹、禁止解释文字。',
    '文章与源码一致时也输出全文原样（不做无谓改写）。',
    '',
    '==== 待校对文章 ====', '',
    articleText, '',
    '==== source_files 对应源码 ====', '',
    sourcesText,
  ].join('\n')
}

// 批量校对 prompt（hy3 适配 0.10.8）：多篇文章+各自源码合并为一个请求，输出按固定
// 标记分节，服务侧（settleProofread）拆回逐篇、writeValidated 校验后才落盘。
function batchProofreadBatchPrompt(language, items) {
  const parts = [
    `你是 CodeWiki 审校员。文章全文用${language}书写。`,
    '',
    `任务：核对下文 ${items.length} 篇 wiki 文章与各自源码的一致性，逐篇输出修正后的完整文章。`,
    '核对项（每篇各自核对）：',
    '1. frontmatter 必有 title/type/source_files/tags，source_files 与正文实际引用一致',
    '2. 抽查文中全部函数/类名与行号（上源码逐个核对；行号以源码「行号| 」前缀为准，禁止自行数行）：名字错改名字、行号错改行号、归属错改归属',
    '3. 重大源码文件被引用但未列入 source_files 的，补进 frontmatter',
    '4. 与源码不符的描述段落直接改写',
    '',
    '输出格式（严格遵守）：按输入顺序逐篇输出，每篇三段——一行「@@@article: 文章名」（文章名逐字照抄该篇输入开头标记），换行后是修正后的完整文章（以 --- frontmatter 开始），再一行「@@@end」。',
    '文章与源码一致时该篇也输出全文原样（不做无谓改写）；禁止在标记与文章之外输出任何解释文字。',
  ]
  for (const it of items) {
    parts.push(
      '',
      `@@@article: ${it.name}`,
      '',
      it.articleText,
      '',
      '==== 该篇 source_files 对应源码 ====',
      '',
      it.sourcesText,
    )
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// 工具 1：cw CLI 封装
// ---------------------------------------------------------------------------

function cwToolDefinition(cfg) {
  return {
    name: 'cw',
    description: [
      '运行 CodeWiki CLI（cw）查询/维护当前仓库的代码 wiki。wiki 落在仓库内 <repo>/.codewiki/（随仓库提交）。',
      '常用调用：args=["status"] 查新态（三态判定）；["init"] 初始化；["index"] 重建索引；["meta","update"] 记录编译基线 commit；["path"] 打印本仓库 wiki 目录（<repo>/.codewiki）；["projects"] 只列出 ~/.codewiki 旧位置的项目（现在 wiki 在各仓库内，一般用不到）。',
      '写文章、编译 wiki 请用 codewiki_generate（后台批量流水线服务），不要用本工具手写文章。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库根或子目录；Windows 支持 C:/... 与 Git-Bash /c/... 形式）' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'cw 子命令与参数，如 ["status"]、["init"]、["meta","update"]',
        },
      },
      required: ['cwd', 'args'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          command: { type: 'string' },
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        required: ['cwd', 'command', 'exitCode', 'stdout', 'stderr'],
      },
      render(args, value) {
        const head = `cw ${value.command}（exit ${value.exitCode}${value.timedOut ? '，超时' : ''}）`
        const body = [value.stdout, value.stderr].filter(Boolean).join('\n').trim()
        return [{ type: 'text', text: body ? `${head}\n${body}` : head }]
      },
    },
    execute: async (args, exec) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('cw：插件已在设置中停用（codewiki → enabled）')
      const cwd = normalizeCwd(args.cwd)
      if (!cwd || !fs.existsSync(cwd)) throw new Error(`cw：cwd 不存在：${args.cwd ?? ''}`)
      const argv = (Array.isArray(args.args) ? args.args : []).map(String).filter((s) => s.length > 0)
      if (!argv.length) throw new Error('cw：args 不能为空，例如 ["status"]')
      if (!CW_SUBCOMMANDS.includes(argv[0])) {
        throw new Error(`cw：未知子命令 "${argv[0]}"，允许：${CW_SUBCOMMANDS.join(' / ')}`)
      }
      const binary = resolveBinary(c)
      const r = await runCw(binary, cwd, argv, 120000, exec?.signal)
      if (r.timedOut) throw new Error(`cw：执行超时（120s）—— ${argv.join(' ')}`)
      return {
        cwd,
        command: argv.join(' '),
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: false,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具 2：codewiki_generate 编排
// ---------------------------------------------------------------------------

// 保留 CJK 字符（中文顶层目录名直接作模块 slug，避免多个中文目录全部塌缩成 'module'
// 合并成单模块）；lowercase 只影响 ASCII，其他脚本字符清理后为空则回落 'module'
function slugify(name) {
  return String(name).toLowerCase().replace(/[^\p{Script=Han}a-z0-9\-_]+/gu, '-').replace(/^-+|-+$/g, '') || 'module'
}

// 读文章 frontmatter 的 source_files（缩进列表或行内数组），供 stale 流程取文件清单。
// 从 frontmatter 文本解析 source_files 清单（inline [a,b] 与 block - a 两式），返回相对路径数组
function parseSourceFiles(fm) {
  const inline = fm.match(/^source_files:\s*\[([^\]]*)\]/m)
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  const block = fm.match(/^source_files:\s*$(?:\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+))/m)
  if (block) {
    return block[1].split(/\r?\n/)
      .map((l) => l.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  return []
}

function readSourceFiles(articlePath) {
  try {
    const raw = fs.readFileSync(articlePath, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    return m ? parseSourceFiles(m[1]) : []
  } catch {
    return []
  }
}

// 当前 HEAD 短 sha（快照里记一下「这份图对应哪个提交」）；非 git 仓库返回 null。
export function currentCommit(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true })
    return r.status === 0 ? String(r.stdout ?? '').trim() || null : null
  } catch {
    return null
  }
}

async function wikiPathFor(cwd, binary, signal) {
  const r = await runCw(binary, cwd, ['path'], 30000, signal)
  const p = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (r.exitCode === 0 && p) return p
  return path.join(cwd, '.codewiki') // 与 wiki_path() 一致：wiki 在仓库内
}

// ---------------------------------------------------------------------------
// 编排服务：全批量流水线（零子代理）
// codewiki_generate 只判态与提交；服务以 10s tick 推进各 job 的阶段机：
//   full   = articles → crosscut →（超预算拆分时 compose）→ review → index（0.10.7 删规划阶段）
//   stale  = articles（任务在提交时预构建）→ review → index
// 全部模型调用都是单轮文本生成，统一走插件内后台并发池（默认 workbuddy/hy3）；单文件超
// 单请求预算先按大档重装继续，仍装不下则该任务转兜底通道（见下）。横切/校对结果
// keepInMemory，服务侧校验 frontmatter 后才落盘，坏输出不写 wiki。
// 兜底通道：只有单个源文件大到连 BATCH_TOKEN_HARD_LIMIT 都装不下时才启用——把完整写作
// 指令写入任务文件，steer 发起会话模型派子智能体完成；本服务轮询目标文件收割入账。
// 正常情况（单文件 ≤128k）全程在插件内完成，不惊动发起会话。
// ---------------------------------------------------------------------------

// 测试可设 DSH_CODEWIKI_JOBS_FILE 隔离到独立路径——默认路径与真实宿主实例共享，
// 宿主周期 flush 会用其内存副本整写同一文件，测试期间互相洗掉对方的内存字段（tps 采样 flaky 的根因）
const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')
const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)
// 会话通道（0.9.0）：超批量预算的文章交发起会话模型派子智能体完成。
// 超时默认 30 分钟（等子智能体产出，比批量请求长得多），可用
// DSH_CODEWIKI_SESSION_TIMEOUT_MS 覆盖；任务文件与 job 记录同目录，宿主重启后仍可收割。
const SESSION_TASK_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.DSH_CODEWIKI_SESSION_TIMEOUT_MS) || 30 * 60 * 1000)
const SESSION_TASK_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')

// ---------------------------------------------------------------------------
// 会话内容记录（面板「会话」视图的数据底座）：把并发池每个 LLM 请求的 prompt 与
// 流式输出落盘，面板可实时看到「目前正在进行的会话内容」，像给 codewiki 专门开的会话。
// 目录 <tmp>/dsh-codewiki-sessions/<jobId>/：nnn.meta.json（轻量元数据，列表用）+
// nnn.full.json（prompt/output 全文，查看时才读）。保留一天（TTL），tick 定期清理。
// 大文件节流写：流式增量每 3s 至多落盘一次，完成时全文覆盖。仅本地临时目录、仅回环面板
// 可读，不进 git、不随 job 持久化（job 只存 sessionSeq 计数）。
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const SESSIONS_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-sessions')
const SESSION_FLUSH_MS = 3000

function sessionDirFor(jobId) {
  return path.join(SESSIONS_DIR, String(jobId).replace(/[^\w-]/g, '_'))
}
function writeSessionMeta(jobId, meta) {
  try {
    const dir = sessionDirFor(jobId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${String(meta.n).padStart(3, '0')}.meta.json`), JSON.stringify(meta), 'utf8')
  } catch { /* tmp 不可写则放弃记录，不影响编译 */ }
}
function writeSessionFull(jobId, n, full) {
  try {
    const dir = sessionDirFor(jobId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${String(n).padStart(3, '0')}.full.json`), JSON.stringify(full), 'utf8')
  } catch { /* 同上 */ }
}
// 列表：只读 meta 文件（轻量），按 n 倒序（最新在前）
export function listSessionRecords(jobId) {
  const dir = sessionDirFor(jobId)
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => readJsonFile(path.join(dir, f)))
    .filter(Boolean)
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0))
}
export function readSessionRecord(jobId, n) {
  return readJsonFile(path.join(sessionDirFor(jobId), `${String(n).padStart(3, '0')}.full.json`))
}
// 全局会话列表（1.2.0）：跨所有任务聚合请求记录，按 startedAt 倒序，前面带 jobId。
// 用途是面板顶部那个「会话」Tab——不进任何任务行就能看到「codewiki 现在在跟模型说什么」。
// 只读 meta 文件（轻量），full 全文仍按 (jobId, n) 单条拉取。limit 兜底防目录过大。
export function listAllSessionRecords({ limit = 200, jobIds = null } = {}) {
  let dirs
  try { dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    // 目录名是 jobId 的 sanitize 形式；jobId 本身只含 [\w-]，通常恒等
    if (jobIds && !jobIds.has(d.name)) continue
    const dir = path.join(SESSIONS_DIR, d.name)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const f of names) {
      if (!f.endsWith('.meta.json')) continue
      const meta = readJsonFile(path.join(dir, f))
      if (meta) out.push({ ...meta, jobId: d.name })
    }
  }
  // 排序键：startedAt 优先，缺失时退到 n（同一 job 内 n 递增）
  out.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) || (b.n ?? 0) - (a.n ?? 0))
  return out.slice(0, Math.max(1, limit))
}
// 过期清理：删超 TTL 的记录文件与随之为空的 job 目录。返回删除数（供 note/测试）。
export function pruneSessionRecords(nowMs = Date.now(), ttlMs = SESSION_TTL_MS) {
  let removed = 0
  let jobDirs
  try { jobDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) } catch { return 0 }
  for (const d of jobDirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(SESSIONS_DIR, d.name)
    let files
    try { files = fs.readdirSync(dir) } catch { continue }
    let left = 0
    for (const f of files) {
      const p = path.join(dir, f)
      try {
        const st = fs.statSync(p)
        if (nowMs - st.mtimeMs > ttlMs) { fs.rmSync(p); removed += 1 } else left += 1
      } catch { /* 单文件失败不拖累整轮 */ }
    }
    if (!left) { try { fs.rmdirSync(dir) } catch { /* 非空/占用则留着 */ } }
  }
  return removed
}
// 从流式 chunk 尽力提取文本增量：不同 provider 的 chunk 形态不一（{text} / {delta:{text}} /
// {content} 等），提取不到就返回空串——完成时全文覆盖兜底，实时性损失可接受。
function textDeltaOf(chunk) {
  if (typeof chunk === 'string') return chunk
  if (!chunk || typeof chunk !== 'object') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta?.text === 'string') return chunk.delta.text
  if (typeof chunk.content === 'string') return chunk.content
  return ''
}
// 开始记录一个请求：写 meta（status:running）+ full（prompt 全文），返回句柄给并发池回调
function beginSessionRecord(job, task) {
  const n = (job.sessionSeq ?? 0) + 1
  job.sessionSeq = n
  const startedAt = new Date().toISOString()
  const meta = {
    n, jobId: job.id, name: task.name, model: task.model || null, provider: task.provider || null,
    startedAt, finishedAt: null, status: 'running',
    inputTokens: estimateTokens(task.batchPrompt), outputChars: 0, outputTokens: 0,
  }
  const full = { n, jobId: job.id, name: task.name, startedAt, prompt: task.batchPrompt ?? '', output: '' }
  writeSessionMeta(job.id, meta)
  writeSessionFull(job.id, n, full)
  let out = ''
  let lastFlush = 0
  return {
    onDelta(chunk) {
      const d = textDeltaOf(chunk)
      if (!d) return
      out += d
      meta.outputChars = out.length
      const now = Date.now()
      if (now - lastFlush >= SESSION_FLUSH_MS) {
        lastFlush = now
        writeSessionFull(job.id, n, { ...full, output: out })
      }
    },
    onDone(content, outputTokens) {
      meta.status = 'done'
      meta.finishedAt = new Date().toISOString()
      meta.outputChars = (content ?? '').length
      meta.outputTokens = outputTokens ?? 0
      writeSessionMeta(job.id, meta)
      writeSessionFull(job.id, n, { ...full, output: content ?? '', finishedAt: meta.finishedAt })
    },
    onError(err) {
      meta.status = 'error'
      meta.finishedAt = new Date().toISOString()
      meta.error = String(err?.message ?? err).slice(0, 300)
      writeSessionMeta(job.id, meta)
      writeSessionFull(job.id, n, { ...full, output: out, error: meta.error, finishedAt: meta.finishedAt })
    },
  }
}

// 会话通道任务收割判定（纯函数，测试直接断言三态）：
// 'timeout' 派发后超时未产出（按失败处理，不降级到插件内通道）；'harvest' 目标文件已产出，
// 且 mtime ≥ 派发时间、以 frontmatter 开头（子智能体写完整了）；'wait' 尚未产出
// （无文件/文件旧未更新/正在写一半）。
export function classifySessionTask(task, nowMs = Date.now()) {
  if (nowMs - Date.parse(task.dispatchedAt) > SESSION_TASK_TIMEOUT_MS) return 'timeout'
  let st, content
  try {
    st = fs.statSync(task.articlePath)
    content = fs.readFileSync(task.articlePath, 'utf8')
  } catch { return 'wait' }
  if (st.mtimeMs < Date.parse(task.dispatchedAt)) return 'wait'
  if (!content.trimStart().startsWith('---')) return 'wait'
  return 'harvest'
}

// 会话通道 steer 文本（0.9.2，纯函数，测试直接断言）：sessionTier 非空时把档位钉死。
// 背景：codewiki 的编译主链不走子智能体档位路由（模型由 batchProvider/batchModel 决定），
// 只有「超预算转会话通道」这一段经过 delegate。原来 steer 文本不给 tier，会话模型就按
// 决策模型自动选路——「写 CodeWiki 模块文章」实测被判给 default（置信 0.88–0.99），
// 用户自建的 codewiki 档永远轮不到。填 sessionTier 后本函数在文本里要求显式传 tier。
export function buildSessionSteerText({ job, snapshots, tier = '', resend = false }) {
  const proofread = job.stage === 'review'
  const tierLine = tier
    ? [`派单要求：调用 delegate 时必须显式传 tier: "${tier}"（不要依赖自动选路），mode 用 spec${resend ? '' : '，并按档位要求保持思考程度'}。`]
    : []
  const lines = snapshots.map((s, i) => `${i + 1}. 模块 ${s.name}：任务文件 ${s.promptFile}，文章直接写到 ${s.articlePath}`)
  const kind = proofread ? '校对' : '文章'
  const head = resend
    ? `【CodeWiki 超预算${kind}任务·重新派发】（宿主重启接管任务 ${job.id}，此前未产出）请调用子智能体（delegate/subagent）逐篇完成：`
    : `【CodeWiki 超预算${kind}任务】任务 ${job.id}（${job.cwd}）有 ${snapshots.length} 篇${proofread ? '文章' : '模块文章'}超出批量通道预算，请调用子智能体（delegate/subagent）逐篇完成：`
  const requirement = proofread
    ? (resend
        ? '子智能体要求：读取任务文件（完整校对指令，含旧文章全文与全部源码），写出校对后的完整文章（以 --- frontmatter 开头）后覆写对应目标路径（UTF-8）。编译服务轮询收尾，超时未产出按失败处理。'
        : '子智能体要求：任务文件是完整校对指令（含旧文章全文与全部源码，源码以「行号| 」前缀标注）；读出校对后的完整文章（以 --- frontmatter 开头）后用文件工具直接覆写对应目标路径（UTF-8）。编译服务会轮询目标文件收割，超时未产出按失败处理。')
    : (resend
        ? '子智能体要求：读取任务文件（完整写作指令，含源码与格式要求），写出完整文章（以 --- frontmatter 开头）后直接写入对应目标路径（UTF-8）。编译服务轮询收尾，超时未产出按失败处理。'
        : '子智能体要求：任务文件是完整写作指令（含全部源码与文章格式要求，源码以「行号| 」前缀标注）；文件较大时用 read 的 offset/limit 分段读取。读出完整文章（以 --- frontmatter 开头）后用文件工具直接写入对应目标路径（UTF-8，覆盖旧文），无需另写标记文件。编译服务会轮询目标文件收割，超时未产出按失败处理。')
  return [head, ...lines, '', ...tierLine, requirement].join('\n')
}
// 孤儿接管阈值：另一实例的 job 停更超过该时长视为宿主重启遗留，本实例接管推进
const ORPHAN_TAKEOVER_MS = Math.max(60000, Number(process.env.DSH_CODEWIKI_ORPHAN_TAKEOVER_MS) || 5 * 60 * 1000)
const MAX_JOBS_KEPT = 30

// 已知仓库清单：独立于 job 历史的持久化工作区登记。job 记录会被 MAX_JOBS_KEPT 截断、
// Temp 沙箱任务会被启动清理移除，仓库总览若只扫 job 历史就会漏掉编译过的工作区
// ——提交过一次就永久登记（hindsight recentWorkspaces 同思路），与 JOBS_FILE 同目录同生命周期。
const REPOS_FILE = process.env.DSH_CODEWIKI_REPOS_FILE || path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')
function loadKnownRepos() {
  try { return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'))?.repos ?? [] } catch { return [] }
}
function rememberRepo(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return
  const key = (p) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
  const list = loadKnownRepos()
  if (list.some((p) => key(p) === key(dir))) return
  list.push(dir)
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: list }, null, 2), 'utf8') } catch { /* 不可写则放弃 */ }
}
// 反登记（1.2.1）：worktree 目录与彻底空掉的目录不该占着仓库总览——一次性从已知仓库清单里摘掉。
// 只改 REPOS_FILE（插件自己的登记），不碰用户磁盘上的任何目录。
export function forgetRepo(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return false
  const key = (p) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
  const list = loadKnownRepos()
  const kept = list.filter((p) => key(p) !== key(dir))
  if (kept.length === list.length) return false
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: kept }, null, 2), 'utf8') } catch { return false }
  return true
}
const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])

// 仓库源码扫描（本地规划输入）：黑名单目录 + 二进制后缀 + 单文件 256KB + 总数 2000
const SCAN_SKIP_DIRS = new Set([
  '.git', '.codewiki', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'bin', 'obj',
  '.gradle', 'Pods', 'coverage', '.nyc_output', 'tmp', 'logs',
])
const SCAN_SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip', '.gz',
  '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj',
  '.a', '.lib', '.class', '.jar', '.pyc', '.pyo', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.db', '.sqlite', '.wasm', '.node', '.map',
])
const SCAN_MAX_FILE_BYTES = 256 * 1024
const SCAN_MAX_FILES = 2000

export function scanRepoFiles(cwd) {
  const out = []
  const walk = (dir, rel) => {
    if (out.length >= SCAN_MAX_FILES) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= SCAN_MAX_FILES) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(path.join(dir, e.name), r)
      } else if (e.isFile()) {
        if (SCAN_SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue
        let st
        try { st = fs.statSync(path.join(dir, e.name)) } catch { continue }
        if (st.size === 0 || st.size > SCAN_MAX_FILE_BYTES) continue
        out.push({ path: r, bytes: st.size })
      }
    }
  }
  walk(cwd, '')
  return out
}

// 当前代码的符号图（stale 增量与 index 快照共用）。返回 { graph, byFile, ready, reason }；
// 任何失败都返回 graph=null，由调用方退回文件级判定——符号级永远只是「更准的一档」，
// 不是必需品。
export async function extractCurrentGraph(cwd) {
  const files = scanRepoFiles(cwd)
  if (!files.length) return { graph: null, byFile: null, ready: false, reason: 'no-files' }
  const inputs = []
  for (const f of files) {
    let content = ''
    try { content = fs.readFileSync(path.resolve(cwd, f.path), 'utf8') } catch { continue }
    inputs.push({ path: f.path, content })
  }
  try {
    const ex = await extractRepoGraph(inputs, { cwd })
    if (!ex.ready) return { graph: null, byFile: null, ready: false, reason: ex.extractor?.initError ?? 'tree-sitter 未就绪' }
    if (!ex.graph.size) return { graph: null, byFile: null, ready: false, reason: 'no-components' }
    return { graph: ex.graph, byFile: ex.byFile, ready: true, skipped: ex.skipped }
  } catch (err) {
    return { graph: null, byFile: null, ready: false, reason: String(err?.message ?? err).slice(0, 200) }
  }
}

function loadJobs() {
  const j = readJsonFile(JOBS_FILE)
  return Array.isArray(j?.jobs) ? j.jobs : []
}

const JOBS_LOCK_FILE = `${JOBS_FILE}.lock`
// 跨进程推进锁：两个宿主窗口各跑一个服务实例，同时推进同一 job 会双提交批量。
// 崩溃残留锁 60s 过期强删——tick 间隔 10s，60s 足够宽限。
function acquireTickLock() {
  try {
    fs.writeFileSync(JOBS_LOCK_FILE, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    try {
      if (Date.now() - fs.statSync(JOBS_LOCK_FILE).mtimeMs > 60000) {
        fs.unlinkSync(JOBS_LOCK_FILE)
        fs.writeFileSync(JOBS_LOCK_FILE, String(process.pid), { flag: 'wx' })
        return true
      }
    } catch { /* 锁刚被别的实例释放：本轮让路 */ }
    return false
  }
}
function releaseTickLock() { try { fs.unlinkSync(JOBS_LOCK_FILE) } catch { /* 已被清理 */ } }

function saveJobs(jobs) {
  // 只留最近 30 个；cancelRequested 必须落盘（取消标记靠它跨 tick 存活）。
  // 0.10.1 起插件不存任何密钥，job 里也不再出现 apiKey 字段。
  const kept = jobs.slice(-MAX_JOBS_KEPT)
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: kept }, null, 2), 'utf8') } catch { /* tmp 不可写则放弃持久化 */ }
}

function jobSummary(job) {
  // tps：最近任务样本的聚合（总输出 token / 总生成毫秒），尚无完成任务时为 null
  const samples = job.tpsSamples ?? []
  const tok = samples.reduce((a, x) => a + (x.outputTokens ?? 0), 0)
  const ms = samples.reduce((a, x) => a + (x.durationMs ?? 0), 0)
  return {
    id: job.id,
    cwd: job.cwd,
    kind: job.kind,
    scope: job.scope,
    auto: job.auto === true,
    stage: job.stage,
    batchId: job.batchRef?.batchId ?? null,
    writtenCount: job.writtenCount,
    failedCount: job.failedCount,
    cancelRequested: job.cancelRequested === true,
    articles: (job.articles ?? []).map((a) => ({ name: a.name, ok: a.ok })),
    // 全程任务明细：已结算（done/failed）在前，当前批次待办（pending）在后；进度条分母即其长度
    taskList: [
      ...(job.articles ?? []).map((a) => ({ name: a.name, state: a.ok ? 'done' : 'failed' })),
      ...(() => { const settled = new Set((job.articles ?? []).map((a) => a.name)); return (job.tasks ?? []).filter((t) => !settled.has(t.name)).map((t) => ({ name: t.name, state: 'pending' })) })(),
    ],
    batchProgress: job.batchProgress ?? null,
    batchSubmittedAt: job.batchSubmittedAt ?? null,
    stageStartedAt: job.stageStartedAt ?? null,
    stageTimings: job.stageTimings ?? null,
    usage: job.usage ?? null,
    notes: (job.notes ?? []).slice(-8),
    // 插件自动提交结果（0.10.9）：面板与 codewiki_progress 共用同一份 jobSummary，
    // 缺了这个字段两处都拿不到，只能从 notes 里猜。
    autoCommit: job.autoCommit ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    tps: ms > 0 ? Math.round((tok / ms) * 10000) / 10 : null,
  }
}

// ---------------------------------------------------------------------------
// 编译终态实时唤醒：对发起会话 steer 一条消息（与子代理 send_message 同机制，纯插件侧
// 现有 API，零 IPC）。agentsRef 由 apply() 经 ctx.inject(['agents']) 赋值；无 agent 上下文
// （面板/自动调度提交）与冷会话（会话已关）一律静默跳过——系统提示 section 拉取仍兜底。
// ---------------------------------------------------------------------------
let agentsRef = null

// llm 服务引用：cordis 严格语义下直接访问 ctx.llm 会抛「cannot get property "llm"
// without inject」（0.8.5 前的 typeof 守卫拦不住）。插件内全部模型环节都靠它，
// 与 agentsRef 同款：apply 时经 ctx.inject(['llm']) 在注入时取服务。
let llmRef = null

// 编译产物的入库状态：自动提交的成功/无改动/失败三态由一处判定，唤醒与提醒两条通道
// 共用同一结论——否则同一次「无需提交」会被两条通道各打扰一次。
//   'committed'  → 产物已入库，完全静默
//   'no-changes' → 没有未提交的产物（重编译无变化/提前提交过），同样静默
//   'pending'    → 插件没能提交，需要会话模型代为提交一次（唯一该打扰的情形）
// 旧 job（无 autoCommit 字段）按 pending 处理，与 0.10.9 之前的行为一致。
export function autoCommitState(job) {
  const ac = job?.autoCommit
  if (ac?.committed === true) return 'committed'
  if (ac?.noChanges === true) return 'no-changes'
  return 'pending'
}

export function wakeCompileSession(job, outcome, agents = agentsRef) {
  // 0.10.9：成功且插件已提交（或根本无改动）→ 完全不打扰会话。会话模型提交完工具就继续干活了，
  // 不再被「请提交改动」的唤醒拉回来做一件插件自己已经做完的事（旧行为的核心缺陷）。
  // 注：'no-changes' 也必须静默——它是「无需提交」，催它提交只会得到一条自相矛盾的消息。
  if (outcome !== 'failed' && autoCommitState(job) !== 'pending') return
  if (!job?.sessionId || !agents || typeof agents.get !== 'function') return
  let agent
  try { agent = agents.get(job.sessionId) } catch { return }
  if (!agent || typeof agent.steer !== 'function') return
  const text = outcome === 'failed'
    ? `【CodeWiki 编译失败】任务 ${job.id}（${job.cwd}）失败：${job.error ?? '未知原因'}——可用 codewiki_progress 查详情，处理后重新提交。`
    : `【CodeWiki 产物待提交】任务 ${job.id} 已完成（写入 ${job.writtenCount} 篇文章），但插件自动提交未成功：${job.autoCommit?.reason ?? '未开启 autoCommit'}。需要入库就随手提交一次（只 add .codewiki/ 与 CodeWiki.md，建议 docs(wiki) 前缀）；不需要就忽略本消息，不要为此中断或轮询。`
  try {
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:codewiki' } }))
  } catch { /* 唤醒失败不影响编译任务本身 */ }
}

function createJobService(config, onSettled) {
  const jobs = loadJobs()
  for (const j of jobs) rememberRepo(j.cwd) // 一次性种子：旧历史进已知仓库清单
  let timer = null
  let ticking = false
  let seq = 0
  // 实例身份：tick 只推进本实例创建的 job（owner 缺失=0.4.2 残留，任何实例可接管续查）。
  // 否则另一实例的 tick 会用 loadJobs 旧快照重复推进同一 job——双提交批量。
  const instanceId = `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // 脏标记：只有任务状态变更过才整写 JOBS_FILE。多实例并存时（插件重载/测试重复 apply），
  // 无事可做的旧实例不会用自己的过期快照覆盖新实例的活动 job。
  let dirty = false
  // 本实例改过的 job id：flush 合并时这些 job 的内存对象是唯一现场（可能比磁盘新），
  // 不允许被磁盘快照反向覆盖——否则 cancel/fail 与慢 tick 交错时会丢掉现场新增的 note/batchRef。
  const dirtyIds = new Set()
  const persist = () => { dirty = true }
  // Temp 沙箱残留清理：cwd 位于系统临时目录的终态任务（调试/测试期产物）启动即移除，
  // 活动任务保留（可能是真实编译）；面板端点直接受益，无需逐个手工取消。
  {
    const tmpBase = path.normalize(os.tmpdir()).toLowerCase()
    const kept = jobs.filter((j) => !(
      j.cwd && path.normalize(j.cwd).toLowerCase().startsWith(tmpBase) &&
      ['done', 'failed', 'cancelled'].includes(j.stage)
    ))
    if (kept.length !== jobs.length) {
      jobs.length = 0
      jobs.push(...kept)
      saveJobs(jobs) // 立即落盘：仅 persist 标脏的话，tick 的 mergeFromDisk 会把磁盘残留吸回内存
    }
  }
  // 编译对象残留清理（1.2.1）：worktree 目录与「没有可编译源码」的空壳目录上的历史任务
  // 是 0.12.0 之前的噪音——同一个空壳目录能攒出十几条一模一样的「仓库没有可编译的源码文件」
  // 失败记录，还占着面板任务列表。启动时一次性从作业历史里移除，并摘出已知仓库登记，
  // 仓库总览与任务列表同时干净。只在启动时做一次，判定缓存 10 分钟，不给启动路径加压。
  // 注意：这里删的是插件自己的作业记录（%TEMP%/dsh-codewiki-jobs.json），不碰用户磁盘上的目录。
  // 目录不存在时不动（移动硬盘/网络盘临时不可访问不该被当成空壳删掉历史）。
  {
    const gone = new Map() // normKey → cwd
    for (const j of jobs) {
      const dir = String(j.cwd ?? '')
      if (dir && isDeadCompileTarget(dir)) gone.set(normPathKey(dir), dir)
    }
    if (gone.size) {
      const kept = jobs.filter((j) => !gone.has(normPathKey(String(j.cwd ?? ''))))
      if (kept.length !== jobs.length) {
        jobs.length = 0
        jobs.push(...kept)
        saveJobs(jobs)
      }
      for (const dir of gone.values()) forgetRepo(dir)
    }
  }
  // 磁盘吸收：另一实例新增的 job、或同 id 但磁盘更新且本实例没动过的 job，并回内存——
  // 防止 flush 用本实例的过期快照覆盖掉对方的活动 job。
  function mergeFromDisk() {
    const disk = loadJobs()
    if (!disk.length) return
    const mine = new Map(jobs.map((j) => [j.id, j]))
    let changed = false
    for (const theirs of disk) {
      const m = mine.get(theirs.id)
      if (m) {
        if (!dirtyIds.has(theirs.id) && (theirs.updatedAt ?? '') > (m.updatedAt ?? '')) {
          mine.set(theirs.id, theirs)
          changed = true
        }
        continue
      }
      mine.set(theirs.id, theirs)
      changed = true
    }
    if (!changed) return
    const merged = [...mine.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    jobs.length = 0
    jobs.push(...merged)
  }
  const flush = () => {
    if (!dirty) return
    mergeFromDisk(); dirty = false; dirtyIds.clear(); saveJobs(jobs)
  }
  const note = (job, msg) => {
    ;(job.notes ??= []).push(msg) // 磁盘残留/手工构造的 job 可能缺 notes，防御性补齐
    if (job.notes.length > 50) job.notes = job.notes.slice(-50)
  }
  // touch = 状态变更的统一入口：必须标脏，否则 tick 末 flush 跳过、取消等纯内存
  // 变更（touch 后 continue，绕过终态 persist）永远进不了 JOBS_FILE
  const touch = (job) => {
    job.updatedAt = new Date().toISOString(); dirty = true; dirtyIds.add(job.id)
  }
  // 阶段切换统一入口：累计各阶段耗时并记录当前阶段起始时刻（面板步骤条/耗时展示用）。
  // 旧任务/测试构造的 job 无 stageStartedAt 时只切阶段不记时。
  const setStage = (job, stage) => {
    if (job.stage && job.stageStartedAt) {
      const ms = Date.now() - Date.parse(job.stageStartedAt)
      if (Number.isFinite(ms) && ms > 0) {
        job.stageTimings = { ...(job.stageTimings ?? {}), [job.stage]: (job.stageTimings?.[job.stage] ?? 0) + ms }
      }
    }
    job.stage = stage
    job.stageStartedAt = new Date().toISOString()
    touch(job)
  }
  // 用量累计：输入为提交时估算（estimateTokens），输出为响应回传 usage 实测。
  const addUsage = (job, { inputTok = 0, outputTok = 0, requests = 0, batch = false, realtime = false, overTier2 = 0 } = {}) => {
    job.usage ??= { inputTok: 0, outputTok: 0, requests: 0, batchRequests: 0, realtimeRequests: 0, overTier2: 0 }
    job.usage.inputTok += inputTok
    job.usage.outputTok += outputTok
    job.usage.requests += requests
    job.usage.batchRequests += batch ? requests : 0
    job.usage.realtimeRequests += realtime ? requests : 0
    job.usage.overTier2 += overTier2
    touch(job)
  }

  // 跨实例取消：另一实例 cancel 的 job 不在本实例内存现场（dirtyIds 之外才允许被磁盘覆盖，
  // 但本实例若正在推进它，内存对象永远不被磁盘覆盖）——每轮 tick 开头从磁盘拾取取消标记。
  function syncCancelFlags() {
    const disk = loadJobs()
    if (!disk.length) return
    for (const j of jobs) {
      if (JOB_TERMINAL.has(j.stage) || j.cancelRequested) continue
      const theirs = disk.find((d) => d.id === j.id)
      if (theirs?.cancelRequested === true) {
        j.cancelRequested = true
        dirty = true
      }
    }
  }

  function fail(job, msg) {
    const fromSubmit = job.stage === 'submitting' // 提交期失败：错误随工具调用同步返回，无需再唤醒
    setStage(job, 'failed')
    job.error = msg
    job.finishedAt = new Date().toISOString()
    note(job, `任务失败：${msg}`)
    touch(job)
    if (!fromSubmit) onSettled?.(job, 'failed') // sessionId 守卫在 wakeCompileSession 内
  }

  // 阶段收割统一入口：返回 null = 阶段还在跑，下轮 tick 再看。
  async function settleJob(job) {
    // 执行器（后台并发池）：结果进 batchResults 等收割；null = 执行器整体失败（已 fail）
    if (batchResults.has(job.id)) {
      const rs = batchResults.get(job.id)
      batchResults.delete(job.id)
      if (rs) { job.batchProgress = null; job.batchSubmittedAt = null } // 已收割，中间进度作废
      return rs ?? []
    }
    if (batchRuns.has(job.id)) return null // 执行器在跑
    // agentic 任务没有 batchPrompt 快照（源码是模型现场读的），重跑依据是任务本身
    // （mission + articlePath + sources）。宿主重启后按 agentic 通道整批重跑一次。
    const agenticTasks = (job.tasks ?? []).filter((t) => t.agentic === true && t.mission && t.articlePath)
    if (agenticTasks.length) {
      note(job, `执行器丢失（宿主重启），按 agentic 通道重跑阶段 ${job.stage}（${agenticTasks.length} 篇）`)
      job.batchProgress = { completed: 0, total: agenticTasks.length }
      startAgenticRun(job, agenticTasks.map((t, i) => ({ ...t, customId: t.customId ?? `a${i}` })))
      return null
    }
    // 执行器丢失（宿主重启）：请求随连接生死，无法续查——按 job.tasks
    // 持久化的 batchPrompt 快照重跑本阶段，是唯一恢复路径（幂等：文章重写覆盖）。
    const tasks = job.tasks ?? []
    const runnable = tasks.filter((t) => typeof t.batchPrompt === 'string' && t.batchPrompt.length)
    if (runnable.length && runnable.length === tasks.length) {
      note(job, `执行器丢失（宿主重启），自动重跑阶段 ${job.stage}（${tasks.length} 个请求）`)
      job.batchProgress = { completed: 0, total: tasks.length }
      startBatchChatRun(job, tasks)
      return null
    }
    fail(job, '请求因宿主重启丢失且无法重跑（任务缺少 prompt 快照），请重新提交')
    return null
  }

  // keepInMemory 结果的落盘闸门：输出必须以 frontmatter 开头，坏输出不写 wiki。
  // keepInMemory 任务（横切/校对）在批量阶段不落盘，唯一写盘点在这里——
  // 不能再走 applyTaskResult（它对 keepInMemory 只回内存不落盘）。
  function writeValidated(job, task, content) {
    if (typeof content !== 'string' || !content.trimStart().startsWith('---')) {
      note(job, `${task.name}：模型输出缺 frontmatter，不落盘（原文件保留）`)
      return { name: task.name, ok: false, stopReason: 'invalid' }
    }
    try {
      fs.mkdirSync(path.dirname(task.articlePath), { recursive: true })
      const fx = fixAnchors(content, job.cwd)
      if (fx.fixed > 0) note(job, `${task.name}：自动修正 ${fx.fixed} 处行号锚点`)
      if (fx.unresolved.length) note(job, `${task.name}：行号锚点存疑（未改）—— ${fx.unresolved.slice(0, 3).join('；')}${fx.unresolved.length > 3 ? ' 等' : ''}`)
      fs.writeFileSync(task.articlePath, fx.text, 'utf8')
      return { name: task.name, ok: true, stopReason: 'completed' }
    } catch (err) {
      note(job, `文章 ${task.name} 落盘失败 —— ${String(err?.message ?? err)}`)
      return { name: task.name, ok: false, stopReason: 'error' }
    }
  }

  // 结果记账；replace=true 时校对结果覆盖同名文章条目（校对失败不推翻已写成功的原文）
  function tally(job, results, tasks, { replace = false } = {}) {
    const byName = new Map((tasks ?? job.tasks ?? []).map((t) => [t.name, t]))
    for (const r of results) {
      const t = byName.get(r.name)
      let entry
      if (t?.keepInMemory && r.ok) {
        entry = writeValidated(job, t, r.content)
      } else {
        entry = { name: r.name, ok: r.ok === true, stopReason: r.stopReason }
      }
      const rec = { name: entry.name, ok: entry.ok, stopReason: entry.stopReason, path: t?.articlePath ?? null }
      // 按名字去重（不看 replace 参数）：文章名就是落盘路径，天然唯一。
      // 这条在「重跑同一篇」时必须成立——agentic 通道失败退回单轮重跑、宿主重启整批重跑，
      // 都会第二次收到同一个 name；按名字更新才不会把 writtenCount 重复累加、
      // 也不会在 job.articles 里留下两条同名记录（面板上会显示成两篇）。
      const prev = job.articles.find((a) => a.name === rec.name) ?? null
      if (prev) {
        const wasOk = prev.ok
        if (!rec.ok && wasOk) rec.ok = true // 曾经的成就不被后续失败抹掉
        const wasPath = prev.path
        Object.assign(prev, rec)
        if (!wasPath && rec.path) prev.path = rec.path
        if (!wasOk && prev.ok) {
          job.writtenCount += 1
          job.failedCount = Math.max(0, job.failedCount - 1)
        }
      } else {
        job.articles.push(rec)
        if (rec.ok) job.writtenCount += 1
        else job.failedCount += 1
      }
    }
  }

  // agentic 通道是否要退回单轮通道：只在「本批过半失败」且「本 job 还没退回过」时重跑。
  // 判定逻辑见模块级 shouldFallBackFromAgentic（导出以便单测）。
  function shouldFallBackHere(job, results, tasks) {
    if (job.agenticRetried) return false
    const list = Array.isArray(tasks) ? tasks : []
    const agenticList = list.filter((t) => t?.agentic === true)
    if (!agenticList.length) return false
    const isAgentic = (r) => agenticList.some((t) => t.name === r.name)
    return shouldFallBackFromAgentic(results.filter(isAgentic))
  }

  // 批量校对收割：一个结果覆盖多篇——按「@@@article: 名 / @@@end」标记拆回逐篇，
  // writeValidated 校验通过才覆写；缺席或非法的文章保留原文（校对失败不推翻已写成功的文章）
  function settleProofread(job, results, tasks) {
    const byName = new Map()
    for (const t of tasks ?? []) {
      for (const it of t.proofreadItems ?? []) byName.set(it.name, it)
    }
    const done = new Map() // name → ok
    for (const r of results) {
      if (!r.ok || !r.content) continue
      const re = /@@@article:[ \t]*(.+?)[ \t]*\r?\n([\s\S]*?)@@@end/g
      let m
      while ((m = re.exec(r.content)) !== null) {
        const name = m[1].trim()
        if (done.has(name) || !byName.has(name)) continue
        const it = byName.get(name)
        const entry = writeValidated(job, it, m[2].trim() + '\n')
        done.set(name, entry.ok)
        if (!entry.ok) note(job, `${name}：批量校对输出未通过校验，保留原文`)
      }
    }
    for (const t of tasks ?? []) {
      for (const it of t.proofreadItems ?? []) {
        if (!done.has(it.name)) note(job, `${it.name}：批量校对输出缺席，保留原文`)
      }
    }
  }

  // 阶段执行器：后台并发池，结果进 batchResults 由 settleJob 收割，
  // tick 不被长请求阻塞。batchRuns 是存活性标记，batchAborters 供取消中断在飞请求。
  // 唯一通道：宿主 llm 服务（模型设置里已注册的 provider/model，含本地 OpenAI 兼容端点），
  // 凭证由宿主按该 provider 解析，插件不碰密钥。
  const batchRuns = new Map()     // jobId → 执行器 Promise
  const batchResults = new Map()  // jobId → results[]（null = 执行器整体失败，已 fail）
  const batchAborters = new Map() // jobId → AbortController
  function startBatchChatRun(job, prepared) {
    const c = liveConfig(config)
    const ac = new AbortController()
    batchAborters.set(job.id, ac)
    let doneCount = 0
    const run = Promise.resolve()
      .then(() => runRealtimeTasks(prepared, {
        provider: c.batchProvider,
        llm: llmRef,
        model: c.batchModel,
        reasoningEffort: c.batchReasoningEffort || undefined,
        concurrency: c.maxConcurrency,
        bigConcurrency: c.bigConcurrency, // 0 = 跟随默认档并发
        notes: job.notes,
        signal: ac.signal,
        onRequestStart: (t) => beginSessionRecord(job, t), // 会话内容记录（面板「会话」视图）
        onTaskDone: (s) => {
          doneCount += 1
          job.batchProgress = { completed: doneCount, total: prepared.length }
          job.tpsSamples = [...(job.tpsSamples ?? []), s].slice(-20)
          addUsage(job, { outputTok: s.outputTokens ?? 0 }) // 输出 token 实测入账
          touch(job)
        },
      }))
      .then(
        (rs) => batchResults.set(job.id, [...rs.values()]),
        (err) => {
          batchResults.set(job.id, null)
          if (!JOB_TERMINAL.has(job.stage)) {
            const msg = `阶段执行失败 —— ${String(err?.message ?? err)}`
            note(job, msg)
            fail(job, msg)
          }
        },
      )
      .finally(() => {
        batchRuns.delete(job.id); batchAborters.delete(job.id)
        if (JOB_TERMINAL.has(job.stage)) batchResults.delete(job.id) // 取消/失败后不残留未收割结果
        touch(job)
      })
    batchRuns.set(job.id, run)
    return run
  }

  // agentic 写作执行器：与 startBatchChatRun 并列的第二条通道。
  // 结果同样进 batchResults，由 settleJob 统一收割；区别是任务里没有 batchPrompt——
  // settleJob 的「执行器丢失重跑」分支需要认 agentic 标记（见 settleJob）。
  function startAgenticRun(job, tasks) {
    const c = liveConfig(config)
    const ac = new AbortController()
    batchAborters.set(job.id, ac)
    let doneCount = 0
    const run = Promise.resolve()
      .then(() => runAgenticArticles(tasks, {
        llm: llmRef,
        provider: c.batchProvider,
        model: c.batchModel,
        reasoningEffort: c.batchReasoningEffort || '',
        concurrency: c.maxConcurrency,
        cwd: job.cwd,
        language: job.language,
        articleFormat: articleFormatSection(),
        maxSteps: c.agenticMaxSteps,
        fixAnchors,
        notes: job.notes,
        signal: ac.signal,
        onRequestStart: (t) => beginSessionRecord(job, t),
        onTaskDone: (s) => {
          doneCount += 1
          job.batchProgress = { completed: doneCount, total: tasks.length }
          job.tpsSamples = [...(job.tpsSamples ?? []), s].slice(-20)
          addUsage(job, { outputTok: s.outputTokens ?? 0 })
          touch(job)
        },
      }))
      .then(
        (rs) => batchResults.set(job.id, [...rs.values()]),
        (err) => {
          batchResults.set(job.id, null)
          if (!JOB_TERMINAL.has(job.stage)) {
            const msg = `agentic 阶段执行失败 —— ${String(err?.message ?? err)}`
            note(job, msg)
            fail(job, msg)
          }
        },
      )
      .finally(() => {
        batchRuns.delete(job.id); batchAborters.delete(job.id)
        if (JOB_TERMINAL.has(job.stage)) batchResults.delete(job.id)
        touch(job)
      })
    batchRuns.set(job.id, run)
    return run
  }

  // 规划：语义规划（AST 聚类）优先，失败退回目录分组。两条路径都写 job.plan，
  // 并记一条 note 说清本次用的是哪条——面板/日志里能直接看出规划质量。
  async function buildPlan(job, files) {
    const c = liveConfig(config)
    if (c.planMode === 'dirs') {
      const plan = localPlan(files)
      note(job, `规划：${plan.modules.length} 个模块（按顶层目录分组，planMode=dirs）`)
      return plan
    }
    const r = await semanticPlan(files, {
      cwd: job.cwd,
      llm: llmRef,
      provider: c.batchProvider,
      model: c.batchModel,
      reasoningEffort: c.batchReasoningEffort || undefined,
      notes: job.notes,
    })
    if (r.plan) {
      const st = r.plan.stats ?? {}
      note(job, `规划：${r.plan.modules.length} 个模块（AST 符号聚类：${st.components ?? '?'} 个组件、${st.requests ?? 0} 次模型请求、${st.fallbacks ?? 0} 次降级、${Math.round((st.durationMs ?? 0) / 1000)}s）`)
      return r.plan
    }
    const plan = localPlan(files)
    note(job, `规划：${plan.modules.length} 个模块（语义规划不可用 ${r.reason}，已退回顶层目录分组）`)
    return plan
  }

  function submitBatchFor(job, prepared) {
    const c = liveConfig(config)
    // 请求实际输入超单请求预算（BATCH_TOKEN_BUDGET）的走兜底装填，提交前明示
    const tier2 = prepared.filter((t) => estimateTokens(t.batchPrompt) > BATCH_TOKEN_BUDGET).length
    addUsage(job, { inputTok: prepared.reduce((n, t) => n + estimateTokens(t.batchPrompt), 0), requests: prepared.length, realtime: true, overTier2: tier2 })
    if (tier2) note(job, `${tier2} 个请求输入超单请求预算（${Math.round(BATCH_TOKEN_BUDGET / 1000)}k），按大档装填`)
    job.batchRef = { batchId: `stage-${job.id}` } // 无服务端批次 id，仅标记「阶段在途」
    job.batchSubmittedAt = new Date().toISOString() // 面板执行时长计时起点，收割时清空
    job.tasks = prepared.map((t) => ({
      customId: t.customId, name: t.name, articlePath: t.articlePath, keepInMemory: t.keepInMemory === true,
      cwd: t.cwd, // 锚点自动修正的源码根（writeValidated 用 job.cwd，普通文章直写用 t.cwd）
      batchPrompt: t.batchPrompt, // 宿主重启后重跑本阶段的唯一依据
      // 大档任务：记录它该用哪个模型跑，重启接管后按同档重派（否则会掉回普通档装不下）。
      // bigTier: true 必须一起持久化——它是并发分池的唯一依据，丢了会让重跑的请求
      // 全部挤进默认档池，把默认档配额吃光。
      ...(t.bigTier ? { bigTier: true, provider: t.provider, model: t.model, ...(t.reasoningEffort ? { reasoningEffort: t.reasoningEffort } : {}) } : {}),
      // 分割观察任务（#obs）的合成重建元数据：splitFor 指向所属文章 name，
      // composePlan 携带 mission/articlePath/prevArticlePath——收割时从持久化快照重建合成任务
      ...(t.splitFor ? { splitFor: t.splitFor, composePlan: t.composePlan } : {}),
      // 批量校对任务：逐篇回写清单（settleProofread 按标记拆回、宿主重启重跑都依赖）
      ...(t.proofreadItems ? { proofreadItems: t.proofreadItems } : {}),
    }))
    job.batchProgress = { completed: 0, total: prepared.length }
    startBatchChatRun(job, prepared)
    const bigCount = prepared.filter((t) => t.bigTier).length
    const modelText = bigCount
      ? `${c.batchProvider}/${c.batchModel} + 大档 ${c.bigProvider}/${c.bigModel}（${bigCount} 个）`
      : `${c.batchProvider}/${c.batchModel}`
    // 并发文案：有大档任务时把两档上限都写清楚（大档 0 = 跟随默认档）
    const concurrencyText = bigCount
      ? `${c.maxConcurrency} + 大档 ${c.bigConcurrency || c.maxConcurrency}`
      : `${c.maxConcurrency}`
    note(job, `阶段已启动：${prepared.length} 个请求（模型 ${modelText}，并发 ${concurrencyText}）`)
    touch(job)
  }

  // ---- 会话通道：超预算文章交发起会话模型派子智能体完成（0.9.0） ----
  // 把完整写作指令写入任务文件，steer 一条短消息给发起会话；会话模型调用子智能体
  // （delegate/subagent）读任务文件、把文章直接写到 articlePath。本服务每 tick 轮询目标
  // 文件收割（frontmatter 校验 + 行号锚点校正后入账），超时（默认 30 分钟）按失败处理
  // ——不降级到插件内通道回写（避免半成品覆盖）。派发快照随 job 持久化（sessionTasks），
  // 宿主重启接管后重发一次 steer。
  function dispatchSessionTasks(job, tasks) {
    let agent = null
    try { agent = job.sessionId && agentsRef?.get ? agentsRef.get(job.sessionId) : null } catch { /* 会话已关 */ }
    if (!agent || typeof agent.steer !== 'function') {
      fail(job, `${tasks.length} 个任务超批量预算需走会话通道（会话模型→子智能体），但发起会话不可用（面板/自动调度提交或会话已关闭）——请从会话内重新提交编译`)
      return null
    }
    const dispatchedAt = new Date().toISOString()
    const snapshots = []
    try {
      fs.mkdirSync(SESSION_TASK_DIR, { recursive: true })
      for (const t of tasks) {
        const safe = String(t.name).replace(/[^\w.-]+/g, '_')
        const promptFile = path.join(SESSION_TASK_DIR, `${job.id}--${safe}.prompt.txt`)
        fs.writeFileSync(promptFile, t.batchPrompt, 'utf8')
        fs.mkdirSync(path.dirname(t.articlePath), { recursive: true })
        snapshots.push({ name: t.name, articlePath: t.articlePath, promptFile, dispatchedAt })
      }
    } catch (err) {
      fail(job, `会话通道任务文件写入失败 —— ${String(err?.message ?? err)}`)
      return null
    }
    const minutes = Math.round(SESSION_TASK_TIMEOUT_MS / 60000)
    // 0.9.2：档位钉死（sessionTier 非空时文本里要求显式传 tier，见 buildSessionSteerText）
    const tier = String(liveConfig(config).sessionTier ?? '').trim()
    const text = buildSessionSteerText({ job, snapshots, tier })
    try {
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:codewiki' } }))
    } catch (err) {
      fail(job, `会话通道 steer 失败 —— ${String(err?.message ?? err)}`)
      return null
    }
    note(job, `${snapshots.length} 个超预算任务已转会话通道（会话模型→子智能体${tier ? `，档位钉死 ${tier}` : '，档位自动选路'}），等待产出（超时 ${minutes} 分钟）`)
    return snapshots
  }

  // 会话通道收割：'harvest' 的按 writeValidated 闸门落盘入账，'timeout' 记失败，
  // 'wait' 留待下轮。返回 true = 全部终态（阶段可推进）。
  function progressSessionTasks(job) {
    const results = []
    const left = []
    for (const t of job.sessionTasks) {
      const verdict = classifySessionTask(t)
      if (verdict === 'timeout') {
        results.push({ name: t.name, ok: false, stopReason: 'timeout' })
        note(job, `${t.name}：会话通道超时（${Math.round(SESSION_TASK_TIMEOUT_MS / 60000)} 分钟未见产出），该篇按失败处理`)
      } else if (verdict === 'harvest') {
        results.push(writeValidated(job, t, fs.readFileSync(t.articlePath, 'utf8')))
      } else {
        left.push(t)
      }
    }
    const before = job.sessionTasks
    job.sessionTasks = left
    // 校对阶段（review）的结果覆盖同名文章条目：校对失败不推翻已写成功的原文
    if (results.length) tally(job, results, before, { replace: job.stage === 'review' })
    return left.length === 0
  }

  // 宿主重启接管后重发一次 steer（旧进程的 steer 可能随会话丢失）；不重置 dispatchedAt，
  // 超时计时保持原起点；子智能体重写同一文件，幂等。
  function resendSessionSteer(job) {
    let agent = null
    try { agent = job.sessionId && agentsRef?.get ? agentsRef.get(job.sessionId) : null } catch { /* 会话已关 */ }
    if (!agent || typeof agent.steer !== 'function') {
      note(job, '会话通道任务接管后重发 steer 失败（发起会话不可用），等待超时按失败处理')
      return
    }
    const tier = String(liveConfig(config).sessionTier ?? '').trim()
    const text = buildSessionSteerText({ job, snapshots: job.sessionTasks, tier, resend: true })
    try {
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:codewiki' } }))
      note(job, '会话通道任务已重新派发（宿主重启接管）')
    } catch { /* 重发失败等超时 */ }
  }

  // ---- 阶段处理：每 tick 每 job 推进一步 ----

  // 规划阶段已删（0.10.7）：全量编译提交后直接进 articles，模块清单由 localPlan
  // 本地生成（顶层目录分组）——编译模型上下文足够大，不再值得为模块划分单独发
  // 一次模型请求；stale 用文章 frontmatter 的 source_files，本就不经过规划。

  async function tickArticles(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      const tasks = job.tasks
      job.batchRef = null
      job.tasks = []
      // 文章分割观察批收割：拼观察包，为每篇分割文章提交一个合成请求（keepInMemory，直写盘）
      const splitObs = results.filter((r) => r.name.includes('#obs'))
      if (splitObs.length) {
        const byArticle = new Map()
        for (const r of splitObs) {
          const articleName = r.name.slice(0, r.name.indexOf('#obs'))
          if (!byArticle.has(articleName)) byArticle.set(articleName, { batches: [], failed: 0 })
          const slot = byArticle.get(articleName)
          if (r.ok && r.content) slot.batches.push(r.content)
          else slot.failed += 1
        }
        const composeTasks = []
        const composedArticles = new Set() // 每篇文章只重建一条合成任务（多批共享）
        for (const r of tasks) {
          if (!r.name.includes('#obs') || !r.composePlan) continue
          const articleName = r.name.slice(0, r.name.indexOf('#obs'))
          if (composedArticles.has(articleName)) continue
          composedArticles.add(articleName)
          const slot = byArticle.get(articleName)
          if (!slot) continue
          if (slot.failed >= slot.batches.length || !slot.batches.length) {
            note(job, `模块文章 ${articleName} 观察全部失败，该篇缺席本轮编译`)
            continue
          }
          if (slot.failed) note(job, `${slot.failed} 个观察批失败，合成基于剩余观察进行`)
          const plan = r.composePlan
          const prevArticle = plan.prevArticlePath
            ? (() => { try { return fs.readFileSync(plan.prevArticlePath, 'utf8') } catch { return '' } })()
            : ''
          composeTasks.push({
            customId: `${r.customId.replace(/o\d+$/, '')}c`,
            name: articleName,
            keepInMemory: true,
            articlePath: plan.articlePath,
            batchPrompt: batchArticleComposePrompt({
              language: job.language,
              mission: plan.mission,
              moduleName: articleName,
              observationsText: slot.batches.map((b, i) => `#### 观察批 ${i + 1}\n\n${b}`).join('\n\n'),
              prevArticle,
            }),
          })
        }
        if (composeTasks.length) {
          try {
            await submitBatchFor(job, composeTasks)
            note(job, `收到 ${splitObs.length} 份观察，提交 ${composeTasks.length} 个文章合成请求`)
            return
          } catch (err) {
            fail(job, `文章合成批次提交失败 —— ${String(err?.message ?? err)}`)
            return
          }
        }
        // 观察全部失败：若有会话通道任务在途，等它收割后再统一收尾；否则照旧推进（不因观察失败 fail 整个 job）
        if (!job.sessionTasks?.length) {
          setStage(job, job.kind === 'full' ? 'crosscut' : 'review')
          return
        }
      } else if (shouldFallBackHere(job, results, tasks)) {
        // agentic 通道大面积失败：本批里失败的篇目退回单轮整包装填通道再跑一次。
        // 只重排失败篇——已经写成功的文章不再重写（重复写同一路径既费 token 又会
        // 覆盖掉 agentic 在场读代码后写出的更好版本）。
        const failedNames = new Set(results.filter((r) => !r.ok).map((r) => r.name))
        const okResults = results.filter((r) => r.ok)
        if (okResults.length) tally(job, okResults, tasks)
        const retryTasks = tasks
          .filter((t) => failedNames.has(t.name) && t.mission && t.articlePath)
          .map((t, i) => ({
            customId: `${t.customId ?? 'a'}r${i}`,
            name: t.name, mission: t.mission, sources: t.sources, cwd: t.cwd ?? job.cwd,
            articlePath: t.articlePath, prevArticlePath: t.prevArticlePath ?? null,
          }))
        const cF = liveConfig(config)
        const { prepared, sessionTasks } = prepareArticleTasks(retryTasks, {
          cwd: job.cwd, language: job.language,
          bigProvider: cF.bigProvider, bigModel: cF.bigModel,
          bigReasoningEffort: cF.bigReasoningEffort, bigBudget: cF.bigTokenBudget,
        })
        job.agenticRetried = true
        if (sessionTasks.length) {
          const snap = dispatchSessionTasks(job, sessionTasks)
          if (!snap) return
          job.sessionTasks = snap
        }
        if (prepared.length) {
          try {
            note(job, `agentic 写作失败 ${failedNames.size}/${results.length} 篇，已退回单轮通道重跑 ${prepared.length} 篇`)
            await submitBatchFor(job, prepared)
            return
          } catch (err) {
            fail(job, `文章批次提交失败 —— ${String(err?.message ?? err)}`)
            return
          }
        }
        if (!job.sessionTasks?.length) {
          note(job, `agentic 写作失败 ${failedNames.size} 篇，退回单轮通道也无可装填内容`)
        }
      } else {
        tally(job, results, tasks)
      }
    } else if (!job.sessionTasks?.length) {
      // 组装文章任务并提交：stale 用预构建任务；full 就地本地规划生成清单；resume 不经此处（batchRef 已设）
      let tasks
      if (job.kind === 'stale') tasks = job.tasks
      else {
        if (!job.plan) {
          const files = scanRepoFiles(job.cwd)
          if (!files.length) { fail(job, '仓库没有可编译的源码文件'); return }
          job.plan = await buildPlan(job, files)
        }
        const plan = job.plan
        if (!plan?.modules?.length) { fail(job, '仓库没有可编译的源码文件'); return }
        tasks = plan.modules.map((mod) => {
          const slug = slugify(mod.name)
          return {
            name: `modules/${slug}.md`,
            mission: `为模块「${mod.name}」撰写文章 modules/${slug}.md${mod.summary ? `：${mod.summary}` : ''}`,
            sources: mod.files,
            cwd: job.cwd,
            articlePath: path.join(job.wikiPath, 'modules', `${slug}.md`),
            prevArticlePath: path.join(job.wikiPath, 'modules', `${slug}.md`), // 已有旧文则作上下文
          }
        })
      }
      const c0 = liveConfig(config)
      // agentic 写作通道（吸收自 FSoft CodeWiki 的 module agent）：模型自己读源码、增量写文章。
      // 它不需要「源码整包内联 → 超预算拆观察批 → 合成」这套装填，因此没有 sessionTasks。
      // 单篇失败只记账；失败率过半且旧通道可用时退回单轮通道重跑一次（见下）。
      if (c0.agenticArticles && tasks.length) {
        const agenticTasks = tasks.map((t, i) => ({ ...t, customId: t.customId ?? `a${i}` }))
        job.tasks = agenticTasks.map((t) => ({
          customId: t.customId, name: t.name, articlePath: t.articlePath,
          mission: t.mission, sources: t.sources, cwd: t.cwd,
          prevArticlePath: t.prevArticlePath ?? null,
          agentic: true, // 宿主重启重跑时按 agentic 通道重跑，而不是找 batchPrompt
        }))
        job.batchRef = { batchId: `stage-${job.id}` }
        job.batchSubmittedAt = new Date().toISOString()
        job.batchProgress = { completed: 0, total: agenticTasks.length }
        startAgenticRun(job, agenticTasks)
        note(job, `阶段已启动：${agenticTasks.length} 篇 agentic 写作（模型 ${c0.batchProvider}/${c0.batchModel}，并发 ${c0.maxConcurrency}，单篇≤${c0.agenticMaxSteps} 步）`)
        touch(job)
        return
      }
      const { prepared, sessionTasks } = prepareArticleTasks(tasks, {
        cwd: job.cwd, language: job.language,
        bigProvider: c0.bigProvider, bigModel: c0.bigModel,
        bigReasoningEffort: c0.bigReasoningEffort, bigBudget: c0.bigTokenBudget,
      })
      if (sessionTasks.length) {
        const snap = dispatchSessionTasks(job, sessionTasks)
        if (!snap) return // 会话不可用/写文件失败：fail 已记账
        job.sessionTasks = snap
      }
      if (prepared.length) {
        try {
          await submitBatchFor(job, prepared)
        } catch (err) {
          fail(job, `文章批次提交失败 —— ${String(err?.message ?? err)}`)
        }
        return
      }
      if (!job.sessionTasks?.length) { fail(job, '没有可写的文章任务'); return }
    }
    // 会话通道收割：全部终态才推进（超时/失败已在 progressSessionTasks 记账）
    if (job.sessionTasks?.length) {
      if (!progressSessionTasks(job)) return
      job.sessionTasks = null
    }
    if (job.writtenCount === 0) { fail(job, '全部文章任务失败（wiki 基线不变，可重新提交）'); return }
    setStage(job, job.kind === 'full' ? 'crosscut' : 'review')
  }

  // 横切合成任务（单批直出与拆分合成共用）：输入 pack = 模块文章全文或模块观察拼接
  function crosscutTasks(job, pack) {
    const lang = job.language
    return [
      {
        customId: 'arch', name: '_architecture.md', keepInMemory: true,
        articlePath: path.join(job.wikiPath, '_architecture.md'),
        batchPrompt: batchArchitecturePrompt(lang, pack),
      },
      {
        customId: 'patterns', name: '_patterns.md', keepInMemory: true,
        articlePath: path.join(job.wikiPath, '_patterns.md'),
        batchPrompt: batchPatternsPrompt(lang, pack),
      },
      ...job.plan.concepts.map((c, i) => ({
        customId: `concept${i}`, name: `concepts/${slugify(c.name)}.md`, keepInMemory: true,
        articlePath: path.join(job.wikiPath, 'concepts', `${slugify(c.name)}.md`),
        batchPrompt: batchConceptPrompt(lang, c.name, pack),
      })),
    ]
  }

  async function tickCrosscut(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      const tasks = job.tasks
      job.batchRef = null
      job.tasks = []
      if (job.crosscutSplit) {
        // 观察批收尾：不走 tally（不写盘不计数），收观察文本拼合成批
        job.crosscutSplit = false
        const observations = []
        for (const r of results) {
          if (r.ok && r.content) observations.push({ name: r.name, text: r.content })
          else note(job, `${r.name}：模块观察失败，该模块缺席横切合成`)
        }
        if (!observations.length) {
          note(job, '全部模块观察失败，跳过横切')
          setStage(job, 'review')
          return
        }
        const pack = observations.map((o) => `#### ${o.name}\n\n${o.text}`).join('\n\n')
        note(job, `收到 ${observations.length} 份模块观察，提交横切合成批次`)
        setStage(job, 'compose')
        await submitComposeBatch(job, pack)
        return
      }
      tally(job, results, tasks)
      setStage(job, 'review')
      return
    }
    // 输入 = 成功模块文章全文（packArticles 装不下截头部并标注）
    const texts = []
    for (const a of job.articles) {
      if (!a.ok || !a.path) continue
      try { texts.push({ name: a.name, text: fs.readFileSync(a.path, 'utf8') }) } catch { /* 丢文件在横切输入缺席 */ }
    }
    if (!texts.length) { note(job, '没有成功模块文章可作横切输入，跳过横切'); setStage(job, 'review'); return }
    const lang = job.language
    // 拆分判定用原始总量——packArticles 只截后续文章头部，pack 体积永远装得下，不能作依据。
    // hy3 适配（0.10.8）：110k~大档预算之间单批直出（任务标大档），仅连大档都装不下才拆观察。
    const c0 = liveConfig(config)
    const bigTier = String(c0.bigProvider ?? '').trim()
      ? {
          provider: String(c0.bigProvider).trim(),
          model: String(c0.bigModel ?? '').trim() || DEFAULT_BIG_MODEL,
          ...(String(c0.bigReasoningEffort ?? '').trim() ? { reasoningEffort: String(c0.bigReasoningEffort).trim() } : {}),
          budget: Math.max(BATCH_TOKEN_BUDGET, Number(c0.bigTokenBudget) || DEFAULT_BIG_TOKEN_BUDGET),
        }
      : null
    const bigLimit = bigTier ? bigTier.budget : BATCH_TOKEN_HARD_LIMIT
    const totalTokens = texts.reduce((n, a) => n + estimateTokens(a.text), 0)
    if (totalTokens <= bigLimit) {
      // 总量装得进单请求（普通或大档）预算：单批直出，零拆分开销
      try {
        const tasks = crosscutTasks(job, packArticles(texts, bigLimit))
        if (bigTier && totalTokens > BATCH_TOKEN_BUDGET) {
          for (const t of tasks) {
            t.provider = bigTier.provider
            t.model = bigTier.model
            if (bigTier.reasoningEffort) t.reasoningEffort = bigTier.reasoningEffort
            t.bigTier = true // 分池依据：进大档并发池，不吃默认档配额
          }
        }
        await submitBatchFor(job, tasks)
        note(job, `横切批次已提交：_architecture/_patterns + ${job.plan.concepts.length} 个概念${bigTier && totalTokens > BATCH_TOKEN_BUDGET ? '（大档装填）' : ''}`)
      } catch (err) {
        fail(job, `横切批次提交失败 —— ${String(err?.message ?? err)}`)
      }
      return
    }
    // 精准拆分：每篇模块文章一个观察小任务（并发跑），合成批只吃观察（远小于原文，永不超限）
    const tasks = texts.map((a, i) => ({
      customId: `obs${i}`, name: `_obs/${a.name}`, keepInMemory: true,
      batchPrompt: batchObservePrompt(lang, a.name, a.text),
    }))
    job.crosscutSplit = true
    try {
      await submitBatchFor(job, tasks)
      note(job, `模块文章总量超单请求预算，横切拆为 ${tasks.length} 个观察任务并发执行，随后合成`)
    } catch (err) {
      job.crosscutSplit = false
      fail(job, `观察批次提交失败 —— ${String(err?.message ?? err)}`)
    }
  }

  // 合成批收尾：观察批已 settle，合成结果与单批路径同样走 tally 写盘
  async function tickCompose(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      tally(job, results, job.tasks)
      job.batchRef = null
      job.tasks = []
    } else {
      // 合成批断点丢失（stage 落盘与提交落盘之间进程中断）：留痕降级，不静默
      note(job, '合成批次未落盘（上次进程中断于提交后落盘前），跳过横切进校对')
    }
    setStage(job, 'review')
  }

  function submitComposeBatch(job, observationsText) {
    // 0.6.0 起 submitBatchFor 是同步函数（返回 undefined），不能再 .then 链——改为 try/catch
    try {
      submitBatchFor(job, crosscutTasks(job, observationsText))
      note(job, `横切合成批次已提交：_architecture/_patterns + ${job.plan.concepts.length} 个概念（输入=模块观察）`)
    } catch (err) {
      // 文章已写成功，合成提交失败降级跳过横切，不推翻整个任务
      setStage(job, 'review')
      note(job, `横切合成批次提交失败，跳过横切 —— ${String(err?.message ?? err)}`)
    }
  }

  // 本地核对：frontmatter 必填 + source_files 存在性（只记账，不删文）
  function localReview(job) {
    const problems = []
    for (const a of job.articles) {
      if (!a.ok || !a.path) continue
      let text = null
      try { text = fs.readFileSync(a.path, 'utf8') } catch { text = null }
      if (text === null) {
        problems.push(`${a.name}：文件丢失`)
        a.ok = false
        a.stopReason = 'missing'
        if (job.writtenCount > 0) job.writtenCount-- // 文件已不在，成功写盘计数回退
        continue
      }
      if (!text.trimStart().startsWith('---')) { problems.push(`${a.name}：缺 frontmatter`); a.skipProofread = true; continue }
      const srcs = readSourceFiles(a.path)
      const missing = srcs.filter((f) => !fs.existsSync(path.join(job.cwd, f)))
      if (missing.length) problems.push(`${a.name}：source_files 缺 ${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}`)
      a.skipProofread = srcs.length === 0
    }
    if (problems.length) note(job, `本地核对 ${problems.length} 处问题 —— ${problems.slice(0, 4).join('；')}${problems.length > 4 ? '…' : ''}`)
  }

  async function tickReview(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      settleProofread(job, results, job.tasks)
      job.batchRef = null
      job.tasks = []
      if (!job.sessionTasks?.length) { setStage(job, 'index'); return }
      // 校对批次已收割，会话通道的校对任务仍在途：落到下方收割
    } else if (!job.sessionTasks?.length) {
      localReview(job)
      // hy3 适配（0.10.8）：逐篇准备（文章+源码）后按普通预算贪心合并成批量校对请求，
      // 输出按 @@@article/@@@end 标记分节拆回逐篇落盘——请求数从≈文章数降到≈总输入/110k
      const c0 = liveConfig(config)
      const bigTier = String(c0.bigProvider ?? '').trim()
        ? {
            provider: String(c0.bigProvider).trim(),
            model: String(c0.bigModel ?? '').trim() || DEFAULT_BIG_MODEL,
            ...(String(c0.bigReasoningEffort ?? '').trim() ? { reasoningEffort: String(c0.bigReasoningEffort).trim() } : {}),
            budget: Math.max(BATCH_TOKEN_BUDGET, Number(c0.bigTokenBudget) || DEFAULT_BIG_TOKEN_BUDGET),
          }
        : null
      const bigLimit = bigTier ? bigTier.budget : BATCH_TOKEN_HARD_LIMIT
      const tasks = []
      const sessionTasks = []
      const items = []
      for (const a of job.articles) {
        if (!a.ok || !a.path || a.skipProofread) continue
        let articleText = null
        try { articleText = fs.readFileSync(a.path, 'utf8') } catch { continue }
        const articleTokens = estimateTokens(articleText)
        let srcs = collectSources(job.cwd, readSourceFiles(a.path), BATCH_TOKEN_BUDGET - articleTokens)
        if (srcs.oversized) srcs = collectSources(job.cwd, readSourceFiles(a.path), bigLimit - articleTokens)
        if (srcs.oversized) {
          // 连大档都装不下：转会话通道兜底，由发起会话模型调用子智能体校对并覆写文章
          sessionTasks.push({
            name: a.name, articlePath: a.path,
            batchPrompt: batchProofreadPrompt({ language: job.language, articleText, sourcesText: srcs.text }),
          })
          note(job, `${a.name}：源码超批量预算，校对转会话通道`)
          continue
        }
        items.push({ name: a.name, articlePath: a.path, articleText, sourcesText: srcs.text })
      }
      const HEADER_ALLOWANCE = 1000
      const markBigTask = (t) => {
        if (!bigTier) return
        t.provider = bigTier.provider
        t.model = bigTier.model
        if (bigTier.reasoningEffort) t.reasoningEffort = bigTier.reasoningEffort
        t.bigTier = true // 分池依据：进大档并发池
      }
      let i = 0
      const submitGroup = (group) => {
        if (!group.length) return
        const t = {
          customId: `proof${i++}`, name: `proof-batch-${i}`, keepInMemory: true,
          proofreadItems: group.map(({ name, articlePath }) => ({ name, articlePath })),
          batchPrompt: batchProofreadBatchPrompt(job.language, group),
        }
        if (estimateTokens(t.batchPrompt) > BATCH_TOKEN_BUDGET) markBigTask(t)
        tasks.push(t)
      }
      let group = []
      let used = 0
      for (const it of items) {
        const size = estimateTokens(it.articleText) + estimateTokens(it.sourcesText) + HEADER_ALLOWANCE
        if (used + size > BATCH_TOKEN_BUDGET && group.length) { submitGroup(group); group = []; used = 0 }
        group.push(it)
        used += size
        // 单篇即超普通预算：独立成组（装得下大档就标大档，否则转会话通道）
        if (size > BATCH_TOKEN_BUDGET) {
          const solo = batchProofreadBatchPrompt(job.language, [it])
          if (estimateTokens(solo) > bigLimit) {
            sessionTasks.push({
              name: it.name, articlePath: it.articlePath,
              batchPrompt: batchProofreadPrompt({ language: job.language, articleText: it.articleText, sourcesText: it.sourcesText }),
            })
            note(job, `${it.name}：源码超批量预算，校对转会话通道`)
            group = group.filter((g) => g !== it)
            used = 0
          } else { submitGroup(group); group = []; used = 0 }
        }
      }
      submitGroup(group)
      if (sessionTasks.length) {
        const snap = dispatchSessionTasks(job, sessionTasks)
        if (!snap) return // 发起会话不可用，已标失败
        job.sessionTasks = snap
      }
      if (tasks.length) {
        try {
          await submitBatchFor(job, tasks)
          note(job, `校对批次已提交：${items.length + sessionTasks.length} 篇合并为 ${tasks.length} 个请求${job.sessionTasks?.length ? `；另 ${job.sessionTasks.length} 篇走会话通道` : ''}`)
        } catch (err) {
          note(job, `校对批次提交失败（跳过校对）—— ${String(err?.message ?? err)}`)
          job.batchRef = null
          job.tasks = []
        }
        if (job.batchRef) return
      } else if (!job.sessionTasks?.length) {
        setStage(job, 'index')
        return
      }
    }
    // 会话通道校对收割：全部终态才进 index
    if (job.sessionTasks?.length) {
      if (!progressSessionTasks(job)) return
      job.sessionTasks = null
    }
    setStage(job, 'index')
  }

  async function tickIndex(job) {
    if (job.writtenCount > 0) {
      const binary = resolveBinary(liveConfig(config))
      try {
        const idx = await runCw(binary, job.cwd, ['index'], 120000)
        const meta = await runCw(binary, job.cwd, ['meta', 'update'], 120000)
        note(job, `cw index exit ${idx.exitCode}，cw meta update exit ${meta.exitCode}`)
        if (idx.exitCode !== 0 || meta.exitCode !== 0) note(job, '收尾命令存在失败，编译基线可能未刷新，可重试编译')
        if (idx.exitCode === 0 && normalizeIndexLinks(job.cwd)) note(job, '_index.md 链接路径已规范化（\\ → /）')
      } catch (err) {
        note(job, `cw index/meta 执行异常 —— ${String(err?.message ?? err)}`)
      }
      // 符号快照（吸收自 FSoft updater）：记下本次编译所依据的代码形态，
      // 下次 stale 用它做组件级比对。快照存 .codewiki/temp/，随产物一起入库，
      // 换会话/换机器仍能判。写失败不影响编译结果，只是下次退化成文件级判定。
      if (liveConfig(config).symbolIncremental) {
        try {
          const cur = await extractCurrentGraph(job.cwd)
          if (cur.ready) {
            const next = slimGraph(cur.graph, { commit: currentCommit(job.cwd) })
            // 内容没变就不覆盖：快照里有 generatedAt/commit，无脑重写会让 autoCommit
            // 每次编译都产出「只改了一个时间戳」的空转提交。
            const prev = loadSnapshot(job.wikiPath)
            if (prev && sameSnapshotContent(prev, next)) {
              note(job, `符号快照无变化（${cur.graph.size} 个组件），跳过写入`)
            } else {
              const r = saveSnapshot(job.wikiPath, next)
              if (r.ok) note(job, `符号快照已写入（${cur.graph.size} 个组件），下次增量按组件级判定`)
              else note(job, `符号快照写入失败（${r.reason}），下次增量将退回文件级`)
            }
          } else {
            note(job, `符号快照跳过：${cur.reason}`)
          }
        } catch (err) {
          note(job, `符号快照异常（忽略）—— ${String(err?.message ?? err).slice(0, 200)}`)
        }
      }
      try {
        if (ensureWikiEntry(job.cwd, job.language)) note(job, '仓库根缺 CodeWiki.md 入口，已自动生成（已有入口不覆盖）')
      } catch (err) {
        note(job, `CodeWiki.md 入口生成失败（忽略）—— ${String(err?.message ?? err)}`)
      }
    } else {
      note(job, '没有文章写成功，跳过 index/meta update（wiki 基线不变，可重新提交）')
    }
    // 编译产物由插件自己提交（0.10.9 直接提交；0.10.11 起独立 commit 阶段走分支合并式）：
    // 把「等编译完成 → 提交 .codewiki/」从会话模型手里收回来。只在有文章写成功且开关
    // 开启时进入 commit 阶段；提交失败不改变任务终态，只记录原因供「产物待提交」提醒与面板展示。
    if (job.writtenCount > 0 && liveConfig(config).autoCommit) {
      setStage(job, 'commit')
      return // 提交在下个 tick 的 tickCommit 完成；完成后才置终态并唤醒会话
    }
    setStage(job, 'done')
    job.finishedAt = new Date().toISOString()
    if (job.writtenCount > 0) onSettled?.(job, 'done') // 实时唤醒发起会话（无 sessionId 时内部静默）
  }

  async function tickCommit(job) {
    // 提交产物（0.10.11 独立成阶段）：autoCommitWiki 走「主题分支提交 → 合并回原分支」。
    // 失败不改变任务终态（仍是 done），只记录原因供「产物待提交」提醒与面板展示；
    // 中途死在 commit 阶段的任务重启后重跑本阶段——autoCommitWiki 对已入库产物报 noChanges，幂等。
    if (job.writtenCount > 0) {
      const r = autoCommitWiki(job.cwd, { jobId: job.id, writtenCount: job.writtenCount })
      job.autoCommit = r
      if (r.committed) note(job, r.mode === 'branch'
        ? `已自动提交编译产物（${r.sha}）：主题分支 ${r.branch} 提交后合并回原分支（只含 .codewiki/ 与 CodeWiki.md）`
        : `已自动提交编译产物（${r.sha}）：docs(wiki)（直接提交：${r.fallback ?? '未知原因'}）`)
      else if (r.noChanges) note(job, '产物无未提交改动，跳过自动提交')
      else note(job, `自动提交未执行 —— ${r.reason}；需要入库时按提示手动处理`)
    }
    setStage(job, 'done')
    job.finishedAt = new Date().toISOString()
    if (job.writtenCount > 0) onSettled?.(job, 'done') // 实时唤醒发起会话（无 sessionId 时内部静默）
  }

  const STAGE_HANDLER = {
    articles: tickArticles,
    crosscut: tickCrosscut,
    compose: tickCompose,
    review: tickReview,
    index: tickIndex,
    commit: tickCommit,
  }

  async function tick() {
    if (ticking) return
    if (!acquireTickLock()) return // 另一实例正在推进，本轮让路
    ticking = true
    try {
      // 会话记录过期清理（保留一天）：每 10 分钟一轮足够，不用每 tick 扫目录
      if (!tick.lastPruneAt || Date.now() - tick.lastPruneAt > 10 * 60 * 1000) {
        tick.lastPruneAt = Date.now()
        pruneSessionRecords()
      }
      syncCancelFlags()
      // 项目闸门（serialProjects 默认串行=上限1；关闭后按 parallelLimit 并行推进多仓库）。
      // 已经在推进的项目优先（不打断），活跃数不满上限时按提交顺序唤醒最早排队的；
      // 其余排队项目本轮不推进，等前面的到终态后自然轮到。取消仍不受闸门限制。
      const parallelLimit = Math.max(1, liveConfig(config).parallelLimit ?? 1)
      const activeIds = new Set()
      for (const j of jobs) {
        if (JOB_TERMINAL.has(j.stage)) continue
        if (j.stage !== 'queued' && j.stage !== 'submitting') activeIds.add(j.id)
      }
      for (const j of jobs) {
        if (activeIds.size >= parallelLimit) break
        if (j.stage === 'queued') activeIds.add(j.id)
      }
      for (const job of jobs) {
        if (JOB_TERMINAL.has(job.stage)) continue
        if (job.owner && job.owner !== instanceId) {
          // 另一实例的 job：它活着会随批次轮询 touch（updatedAt 每 tick 前进）；
          // 停更超时视为孤儿（宿主重启后 instanceId 变了，旧任务无人推进），接管。
          const idleMs = Date.now() - Date.parse(job.updatedAt || job.createdAt || new Date().toISOString())
          if (Number.isFinite(idleMs) && idleMs <= ORPHAN_TAKEOVER_MS) continue
          note(job, `原实例 ${job.owner} 停更 ${Math.round(idleMs / 60000)} 分钟，本实例接管推进`)
          job.owner = instanceId
          touch(job)
          if (job.sessionTasks?.length) resendSessionSteer(job) // 在途会话通道任务：旧进程的 steer 可能已丢
        }
        if (job.stage === 'submitting') continue // 占位：submit 正在 await 凭证，阶段未定
        if (job.cancelRequested) {
          setStage(job, 'cancelled')
          job.finishedAt = new Date().toISOString()
          // 无服务端批次可保留：中断在飞请求（未完成请求不计费），丢弃未收割结果
          const ac = batchAborters.get(job.id)
          if (ac) ac.abort()
          batchResults.delete(job.id)
          if (job.batchRef) note(job, '已取消：在途请求已中断（未完成请求不计费）')
          touch(job)
          continue
        }
        // 排队中的项目：只有轮到它（activeIds）时才进入真正的首个阶段
        if (job.stage === 'queued') {
          if (!activeIds.has(job.id)) continue
          // 0.10.7 删了 plan 阶段：唤醒恒进 articles（模块清单在 articles 开头就地
          // 本地生成）；旧磁盘任务残留的 pendingStage='plan' 一并落到 articles。
          const next = 'articles'
          job.pendingStage = null
          note(job, `排队结束，开始编译（${next}）`)
          setStage(job, next)
          if (job.kind === 'stale') job.tasks = job.pendingTasks ?? job.tasks ?? []
          job.pendingTasks = null
        }
        // 项目闸门：非本轮推进项目跳过（不推进、不失败，等轮次）
        if (activeIds.size && !activeIds.has(job.id)) continue
        // 0.10.7 前的旧任务卡在 plan 阶段：勘探员代码已删，旧任务快照不可重跑——
        // 清掉规划批次引用与旧任务清单，按 articles 正常组装（full 由 localPlan 本地重建清单）
        if (job.stage === 'plan') {
          job.batchRef = null
          job.tasks = []
          job.plan = null
          setStage(job, 'articles')
          note(job, '旧版规划阶段任务迁移到 articles（本地规划重建清单）')
          touch(job)
        }
        const handler = STAGE_HANDLER[job.stage]
        if (!handler) { fail(job, `未知阶段 ${job.stage}`); continue }
        try {
          await handler(job)
        } catch (err) {
          fail(job, `阶段 ${job.stage} 异常 —— ${String(err?.message ?? err)}`)
        }
        if (JOB_TERMINAL.has(job.stage)) persist()
      }
      flush()
    } finally {
      releaseTickLock()
      ticking = false
    }
  }

  async function submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId }) {
    const c0 = liveConfig(config)
    const exHit = excludedItem(cwd, c0.excludePaths)
    if (exHit) {
      throw new Error(`该目录在 CodeWiki 排除清单中，不编译：${cwd}（命中排除项：${exHit}；在插件设置或面板「设置」页编辑排除清单）`)
    }
    // worktree 闸门（1.2.0）：所有提交入口（工具 / 面板手动 / 自动调度）都过这里，
    // 因此只在这一处拦即可覆盖全部路径。auto 调度扫到 worktree 时静默跳过不报错污染 note。
    const wt = detectLinkedWorktree(cwd)
    if (wt) {
      const msg = `该目录是 git worktree（${wt.gitDir}），不给 worktree 编译 wiki——请等它合并回主仓库后统一编译：${cwd}`
      if (auto) return { skipped: 'worktree', reason: msg }
      throw new Error(msg)
    }
    // 空仓库闸门（1.2.1）：目录里扫不出任何可编译源文件（空壳、只剩 .codewiki 骨架、
    // 只剩 node_modules 的残留）就不提交——否则本地规划必然以「仓库没有可编译的源码文件」
    // 失败，而自动调度下一轮又把它扫回来，攒出一屏同样的失败任务。
    // 手动路径清一次探测缓存再判（刚 clone / 刚 checkout 完的目录不该被 10 分钟前的空判定挡住）。
    if (!auto) clearSourceProbeCache(cwd)
    if (!hasCompilableSources(cwd)) {
      const msg = `该目录没有可编译的源码文件（空目录或只剩 .codewiki / node_modules 等黑名单目录），不编译：${cwd}`
      if (auto) return { skipped: 'no-source', reason: msg }
      throw new Error(msg)
    }
    rememberRepo(cwd)
    const existing = jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage))
    if (existing) return { job: existing, existed: true }
    // 占位先行：先落一条 submitting 占位，期间的并发提交靠非终态 stage 挡重复
    const job = {
      id: `job-${Date.now().toString(36)}-${(seq++).toString(36)}`,
      cwd, wikiPath, scope, language, kind,
      owner: instanceId,
      stage: 'submitting',
      auto: auto === true,
      sessionId: sessionId ?? null, // 发起会话：编译终态 steer 唤醒（面板/自动调度为 null，不唤醒）
      plan: null,
      batchRef: null,
      tasks: [],
      articles: [],
      writtenCount: 0,
      failedCount: 0,
      usage: { inputTok: 0, outputTok: 0, requests: 0, batchRequests: 0, realtimeRequests: 0, overTier2: 0 },
      stageTimings: {},
      stageStartedAt: new Date().toISOString(),
      notes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    jobs.push(job)
    persist()
    // 唯一的模型通道校验：编译模型必须来自模型设置里已注册的 provider/model，
    // 凭证由宿主按该 provider 解析（插件不再有任何自带直连通道与 key）。
    try {
      const c = liveConfig(config)
      if (!c.batchProvider) throw new Error('编译模型提供商为空——在插件设置「编译模型」里选一个模型设置中已注册的提供商')
      if (!c.batchModel) throw new Error('编译模型为空——在插件设置选一个提供商下的模型')
      if (!llmRef || typeof llmRef.stream !== 'function') throw new Error(`编译模型走宿主 llm 服务（provider ${c.batchProvider}），但 llm 服务未注入——请重启宿主后重试`)
    } catch (err) {
      fail(job, String(err?.message ?? err))
      flush()
      throw err
    }
    job.credentialSource = `llm(${liveConfig(config).batchProvider}/${liveConfig(config).batchModel})`
    // 项目闸门（serialProjects 串行=上限1 / parallelProjects 并行上限）：忙碌项目数
    // （非 queued 的非终态任务，不含刚提交的自己）达到上限时，本任务进 queued 排队，
    // 等前面的到终态后由 tick 自动轮到。articles 与 stale 的预置任务先寄存在 pending*，
    // 轮到时再落地（排队期间不占机器）。
    const c1 = liveConfig(config)
    const limit = Math.max(1, c1.parallelLimit ?? 1)
    const busyOthers = jobs.filter((j) => j.id !== job.id && !JOB_TERMINAL.has(j.stage) && j.stage !== 'queued' && j.stage !== 'submitting')
    const busyOther = busyOthers.length >= limit ? busyOthers[limit - 1] : null
    if (busyOther) {
      job.pendingStage = 'articles'
      job.pendingTasks = kind === 'stale' ? (prebuiltTasks ?? []) : null
      const limitTxt = c1.serialProjects ? '单项目串行' : `并行上限 ${limit}`
      note(job, `编译通道已满（${limitTxt}，正在跑 ${path.basename(busyOther.cwd)} 等），本任务排队等待`)
      setStage(job, 'queued')
    } else {
      setStage(job, 'articles')
      if (kind === 'stale') job.tasks = prebuiltTasks ?? []
    }
    persist()
    flush() // 先落盘再推进：tick 中途崩溃也能从文件恢复
    void tick() // 立即推进一步，不等首个 tick 间隔
    return { job, existed: false }
  }

  function cancel(jobId) {
    mergeFromDisk() // 另一实例提交的 job 可能还没被本实例吸收过
    const job = jobs.find((j) => j.id === jobId)
    if (!job || JOB_TERMINAL.has(job.stage)) return false
    job.cancelRequested = true
    note(job, '收到取消请求，将在本轮收尾')
    touch(job)
    flush()
    return true
  }

  const list = () => { mergeFromDisk(); return jobs.map(jobSummary) }
  const findActive = (cwd) => jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage)) ?? null

  function start() {
    if (timer) return
    timer = setInterval(() => { void tick() }, TICK_MS)
    timer.unref?.()
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { submit, cancel, list, findActive, start, stop }
}


// ---------------------------------------------------------------------------
// 工具 2：codewiki_generate（提交制——判态与提交，编译由服务推进）
// ---------------------------------------------------------------------------

function generateToolDefinition(cfg, svc) {
  return {
    name: 'codewiki_generate',
    description: [
      '编译/刷新指定仓库的 CodeWiki（服务化全批量流水线，零子代理）。调用即提交：cw status 判态 → 提交后台编译任务（job）立即返回；宿主服务以 10s 节拍推进阶段机（模块文章→横切→校对→索引），全部模型环节在插件内完成（默认 workbuddy/hy3，免费 192k 上下文，单请求输入按 110k 预算分块装填），不委托发起会话的主模型。',
      'scope=auto（默认）：无 wiki 或未编译走全量；有变更走逐篇更新；最新则直接报告。scope=full：强制全量重编。scope=stale：只刷新过期文章。',
      '进度：调用即提交后本步就此结束——不要等待、不要轮询、不要为了确认编译好没有而反复调 codewiki_progress；去做你手头其他工作。编译完成的产物由插件自己提交入库（autoCommit：主题分支 codewiki/wiki-<任务id> 提交后合并回原分支，只含 .codewiki/ 与 CodeWiki.md），正常情况下你不需要为 wiki 跑任何 git 命令。需要事件级进度时才用 codewiki_progress（只读、立即返回），或在侧边栏 CodeWiki 面板 / GET /api/codewiki/jobs（回环地址）查看；POST /api/codewiki/control {action:"cancel",jobId} 取消。宿主重启后活动任务自动恢复推进（进行中的请求按 prompt 快照自动重跑当前阶段）。',
      '单项目串行（默认开）：同一时刻只推进一个仓库的编译任务，后提交的项目进 queued 排队，前一个收尾后自动轮到（进度里 stage=queued 即排队）。',
      '凭证由模型设置里该 provider（默认 workbuddy）的配置解析，插件不保存也不传递任何密钥；provider/model 留空或该模型不可用时报错而不是降级子代理。全量编译小仓库也要几分钟（多请求排队+生成），适合后台调用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库；Windows 支持 C:/... 与 Git-Bash /c/... 形式）' },
        scope: { type: 'string', enum: ['auto', 'full', 'stale'], description: '编译范围，默认 auto' },
        language: { type: 'string', description: '文章语言，默认取插件设置（中文）' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          scope: { type: 'string' },
          wikiPath: { type: 'string' },
          state: { type: 'string' },
          jobId: { type: 'string' },
          stage: { type: 'string' },
          submitted: { type: 'boolean' },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['cwd', 'scope', 'wikiPath', 'state', 'submitted', 'notes'],
      },
      render(args, value) {
        const lines = [`codewiki_generate（${value.scope}，${value.cwd}）`]
        if (value.wikiPath) lines.push(`wiki：${value.wikiPath}`)
        if (value.submitted) lines.push(`已提交后台任务 ${value.jobId}（stage ${value.stage}）——本步到此结束：去做手头其它工作，不要等待；编译产物由插件完成后自动提交入库。进度只在需要时用 codewiki_progress 或侧边栏 CodeWiki 面板查看`)
        else lines.push(`未提交任务（state ${value.state}）`)
        for (const n of value.notes) lines.push(`· ${n}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('codewiki_generate：插件已在设置中停用（codewiki → enabled）')
      if (!svc) throw new Error('codewiki_generate：编排服务未初始化')
      const cwd = normalizeCwd(args.cwd)
      if (!cwd || !fs.existsSync(cwd)) throw new Error(`codewiki_generate：cwd 不存在：${args.cwd ?? ''}`)
      const exHit = excludedItem(cwd, c.excludePaths)
      if (exHit) throw new Error(`该目录在 CodeWiki 排除清单中，不编译：${cwd}（命中排除项：${exHit}；在插件设置或面板「设置」页编辑排除清单）`)
      const auto0 = args.auto === true // 内部直调（自动调度/面板编译）打的标，工具 schema 不暴露
      // worktree 闸门（1.2.0）：在跑 cw status 之前就拦，报错直接给模型看（submit 里还有一道兜底）。
      // auto 调度（内部直调）不抛错——记一条 note 返回，扫描不因历史 worktree 任务中断。
      const wtHit = detectLinkedWorktree(cwd)
      if (wtHit) {
        const wtMsg = `该目录是 git worktree（${wtHit.gitDir}），不给 worktree 编译 wiki——请等它合并回主仓库后统一编译：${cwd}`
        if (!auto0) throw new Error(wtMsg)
        return {
          cwd, scope: ['auto', 'full', 'stale'].includes(args.scope) ? args.scope : 'auto',
          wikiPath: '', state: 'worktree', submitted: false, notes: [wtMsg], // wikiPath 空串：output schema 要求 string
        }
      }
      const scope = ['auto', 'full', 'stale'].includes(args.scope) ? args.scope : 'auto'
      // 空壳目录闸门（1.2.1）：同样在跑 cw status 之前就拦——残留目录里的 .codewiki/_meta.yaml
      // 往往本身也是残缺的（主仓库被删后只剩骨架），先让 cw status 跑起来只会抛
      // 「Failed to parse _meta.yaml: missing field `project`」这种对用户毫无意义的解析错。
      // 手动路径清一次探测缓存（刚 clone / 刚 checkout 不该被 10 分钟前的空判定挡住）。
      if (!auto0) clearSourceProbeCache(cwd)
      if (!hasCompilableSources(cwd)) {
        const shMsg = `该目录没有可编译的源码文件（空目录或只剩 .codewiki / node_modules 等黑名单目录），不编译：${cwd}`
        if (!auto0) throw new Error(shMsg)
        return {
          cwd, scope, wikiPath: '', state: 'no-source', submitted: false, notes: [shMsg],
        }
      }
      const auto = auto0
      const language = String(args.language ?? '').trim() || c.articleLanguage
      const notes = []
      const sessionId = exec?.agent?.id ?? null // 发起会话：编译终态时 steer 唤醒（面板/自动调度无 agent 上下文=不唤醒）

      const binary = resolveBinary(c)
      const statusRes = await runCw(binary, cwd, ['status'], 120000, exec?.signal)
      if (statusRes.timedOut) throw new Error('codewiki_generate：cw status 超时')
      if (statusRes.exitCode !== 0 && !(statusRes.stdout ?? '').trim()) {
        throw new Error(`codewiki_generate：cw status 失败（exit ${statusRes.exitCode}）—— ${(statusRes.stderr || statusRes.stdout || '').trim()}`)
      }
      const status = parseStatus(statusRes.stdout)
      const wikiPath = await wikiPathFor(cwd, binary, exec?.signal)
      // jobId/stage 仅在提交/幂等/续查路径赋值——不放 null 占位（宿主按 output schema 校验，null 不是 string）
      const result = { cwd, scope, wikiPath, state: status.state, submitted: false, notes }

      // 幂等：同仓库已有活动任务直接返回
      const active = svc.findActive(cwd)
      if (active) {
        if (sessionId) active.sessionId = sessionId // 最近一次关心该仓库的会话拿唤醒权
        notes.push(`该仓库已有进行中的编译任务 ${active.id}（stage ${active.stage}），本次调用直接返回现有任务`)
        result.jobId = active.id
        result.stage = active.stage
        result.scope = active.scope
        return result
      }

      // scope 修正：stale 遇到没有 wiki 的仓库自动升全量
      let effectiveScope = scope
      if (scope === 'stale' && (status.state === 'missing' || status.state === 'uncompiled')) {
        effectiveScope = 'full'
        notes.push('scope=stale 但尚无 wiki，自动升为全量编译')
      }
      const needsFullCompile = effectiveScope === 'full' || status.state === 'missing' || status.state === 'uncompiled'

      // clean：直接报告（scope=full 例外：强制全量重编）
      if (status.state === 'clean' && effectiveScope !== 'full') {
        notes.push('Wiki is up to date —— 无需编译')
        return result
      }

      // stale / auto 逐篇更新：任务在提交时预构建（服务直接进 articles 阶段）
      if (!needsFullCompile && status.state === 'stale' && status.staleArticles.length) {
        let tasks = status.staleArticles.map((articleRel) => {
          const articlePath = path.join(wikiPath, articleRel.replace(/\\/g, '/'))
          const sourceFiles = readSourceFiles(articlePath)
          if (!sourceFiles.length) {
            notes.push(`文章 ${articleRel} 无 source_files frontmatter，跳过（可手工处理或用 scope=full）`)
            return null
          }
          return {
            name: articleRel,
            mission: `更新过期文章 ${articleRel}：以当前代码为准重写其内容，保留章节结构与 title/type/tags`,
            sources: sourceFiles,
            cwd,
            articlePath,
            prevArticlePath: articlePath,
          }
        }).filter(Boolean)

        // 符号级过滤（吸收自 FSoft updater）：cw status 只到文件级，一次改动里
        // 大量是「注释/空白/局部实现」——模块接口与职责没变，文章重写是白花钱。
        // 拿上一次成功编译留下的符号快照与当前代码比组件级变更，只留真受影响的文章。
        // 拿不到快照（首次/换机器/版本不符）就原样往下走，等于文件级判定，不阻断。
        const cInf = liveConfig(cfg)
        if (cInf.symbolIncremental && tasks.length) {
          const snap = loadSnapshot(wikiPath)
          if (!snap) {
            notes.push(`符号级增量：无历史符号快照，本次按文件级判定（${tasks.length} 篇）；编译成功后会写入快照供下次比对`)
          } else {
            const cur = await extractCurrentGraph(cwd)
            if (!cur.ready) {
              notes.push(`符号级增量：当前代码符号提取不可用（${cur.reason}），退回文件级判定（${tasks.length} 篇）`)
            } else {
              const oldGraph = graphFromSnapshot(snap)
              const r = filterStaleTasks(tasks, oldGraph, cur.graph)
              if (r.dropped.length) {
                notes.push(`符号级增量：${describeChange(r.counts)}；判定 ${r.dropped.length}/${tasks.length} 篇无需重写（${r.dropped.map((t) => t.name).join('、')}）`)
                tasks = r.keep
              } else {
                notes.push(`符号级增量：${describeChange(r.counts)}；${tasks.length} 篇全部需要重写`)
              }
            }
          }
        }

        if (tasks.length) {
          const sub = await svc.submit({ kind: 'stale', cwd, wikiPath, scope: effectiveScope, language, prebuiltTasks: tasks, auto, sessionId })
          if (sub.skipped) { notes.push(sub.reason); return result } // worktree 闸门静默跳过
          const { job } = sub
          notes.push(`已提交 ${tasks.length} 篇过期文章更新任务 ${job.id}`)
          result.jobId = job.id
          result.stage = job.stage
          result.submitted = true
          return result
        }
        // 符号级判定把全部文章滤掉了：代码确实变了但只动了实现细节，
        // 架构描述仍然成立。刷新编译基线让 cw status 回到 clean，不提交空任务。
        if (status.staleArticles.length) {
          const meta = await runCw(binary, cwd, ['meta', 'update'], 120000, exec?.signal)
          notes.push(`符号级增量为全部 ${status.staleArticles.length} 篇判定了「无实质变更」，已刷新编译基线（meta update exit ${meta.exitCode}），未重写任何文章`)
          return result
        }
        notes.push('没有可更新的过期文章，改走全量编译')
      }

      // stale 但解析不出过期文章
      if (!needsFullCompile && status.state === 'stale' && !status.staleArticles.length) {
        if (status.changedFiles.length) {
          const meta = await runCw(binary, cwd, ['meta', 'update'], 120000, exec?.signal)
          notes.push(`有 ${status.changedFiles.length} 个文件变更但未命中任何文章的 source_files，已刷新编译基线（meta update exit ${meta.exitCode}）`)
          return result
        }
        notes.push('cw status 输出无法解析，改走全量编译')
      }

      // 全量编译（scope=full，或 auto 命中 missing/uncompiled/无法解析）
      if (status.state === 'missing') {
        const init = await runCw(binary, cwd, ['init'], 120000, exec?.signal)
        if (init.exitCode !== 0) {
          throw new Error(`codewiki_generate：cw init 失败（exit ${init.exitCode}）—— ${(init.stderr || init.stdout || '').trim()}`)
        }
        notes.push('cw init 完成')
      }

      const sub2 = await svc.submit({ kind: 'full', cwd, wikiPath, scope: effectiveScope, language, auto, sessionId })
      if (sub2.skipped) { notes.push(sub2.reason); return result } // worktree 闸门静默跳过
      const { job } = sub2
      notes.push(`已提交全量编译任务 ${job.id}（模块文章→横切→校对→索引，全部在插件内完成）`)
      result.jobId = job.id
      result.stage = job.stage
      result.submitted = true
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 工具 2b：codewiki_update（日常维护入口：提交更新请求即返回）
// 与 codewiki_generate 的差别只在语义与引导文案：固定 scope=auto，返回值明确告诉
// 模型「本步收尾、继续下一项、不要等待/轮询」。编译产物由插件在 tickIndex 顺带
// autoCommit（0.10.9），因此成功后既不催模型提交、也不唤醒会话；只有自动提交
// 失败时才由 commitHintText / wakeCompileSession 发一条「产物待提交」降级提醒。
// ---------------------------------------------------------------------------

function updateToolDefinition(cfg, generateDef) {
  return {
    name: 'codewiki_update',
    description: [
      '提交 CodeWiki 更新请求（日常维护入口，scope=auto 语义）：无 wiki 走全量编译，有变更走逐篇更新，已是最新则直接报告。调用即提交、立即返回——调用后本步收尾、继续下一项工作；不要等待、不要轮询、不要为看进度反复调 codewiki_progress。',
      '编译产物由插件自己提交（autoCommit 默认开：主题分支 codewiki/wiki-<任务id> 提交后合并回原分支，只 add .codewiki/ 与 CodeWiki.md，不动你的其它改动），所以正常情况下你不需要为 wiki 跑任何 git 命令，也不会被编译完成唤醒。只有插件自动提交没成功时，系统才会给一条「CodeWiki 产物待提交」提醒，届时随手提交一次即可。与 codewiki_generate 的关系：本工具是固定 scope=auto 的快捷入口，需要 scope=full/stale 时仍用 codewiki_generate。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库；Windows 支持 C:/... 与 Git-Bash /c/... 形式）' },
        language: { type: 'string', description: '文章语言，默认取插件设置（中文）' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          scope: { type: 'string' },
          wikiPath: { type: 'string' },
          state: { type: 'string' },
          jobId: { type: 'string' },
          stage: { type: 'string' },
          submitted: { type: 'boolean' },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['cwd', 'scope', 'wikiPath', 'state', 'submitted', 'notes'],
      },
      render(args, value) {
        const lines = [`codewiki_update（${value.cwd}）`]
        if (value.wikiPath) lines.push(`wiki：${value.wikiPath}`)
        if (value.submitted) lines.push(`更新已开始（任务 ${value.jobId}，stage ${value.stage}）——已提交后台编译，本步到此结束：继续下一项工作，不要等待，也不要去查进度；产物由插件自己提交入库`)
        else lines.push(`无需更新（state ${value.state}）——wiki 已是最新，继续手头工作即可`)
        for (const n of value.notes) lines.push(`· ${n}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      try {
        const result = await generateDef.execute({ ...args, scope: 'auto' }, exec)
        if (result.submitted === true) {
          result.notes.push('更新已在后台进行：本步收尾，继续下一项工作——不要等待、不要轮询进度；编译产物由插件完成后自动提交入库（autoCommit：主题分支提交后合并回原分支），无需你跑 git。仅当收到「CodeWiki 产物待提交」提醒时才需要代为提交一次')
        }
        return result
      } catch (err) {
        throw new Error(String(err?.message ?? err).replaceAll('codewiki_generate', 'codewiki_update'))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具 3：codewiki_progress（只读查进度——提交后轮询，不阻塞、不等待）
// 提交制下模型最常见的误用是「提交后空等/反复问编译好没有」；本工具把 jobSummary
// （与侧边栏面板同源）直接暴露成只读查询，一行看出 stage/百分比/篇数/失败原因。
// ---------------------------------------------------------------------------

function samePath(a, b) {
  const norm = (p) => path.normalize(String(p ?? '')).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function progressView(job) {
  const taskList = job.taskList ?? []
  const done = taskList.filter((t) => t.state === 'done').length
  return { ...job, progress: taskList.length ? Math.round((done / taskList.length) * 100) : null }
}

function progressToolDefinition(cfg, svc) {
  return {
    name: 'codewiki_progress',
    description: [
      '查询 CodeWiki 编译任务进度（只读，立即返回，不等待编译完成）。',
      'codewiki_generate 是提交制：调用即返回，编译由宿主后台服务推进——提交后直接继续手头工作，需要进度时再调用本工具（数据与侧边栏 CodeWiki 面板同源）。',
      '可选按 cwd（仓库路径）或 jobId 过滤；都不传则列出全部任务。输出含 stage（articles/crosscut/compose/review/index/done/failed/cancelled）、完成百分比、已写/失败篇数、任务明细、批量进度、阶段耗时、token 用量、notes 与错误。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '可选：只查该仓库（git 仓库根或子目录）的任务；省略则列出全部任务' },
        jobId: { type: 'string', description: '可选：只查指定任务 id（codewiki_generate 返回值里的 jobId）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                cwd: { type: 'string' },
                kind: { type: 'string' },
                scope: { type: 'string' },
                stage: { type: 'string' },
                progress: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                writtenCount: { type: 'number' },
                failedCount: { type: 'number' },
                cancelRequested: { type: 'boolean' },
                taskList: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, state: { type: 'string' } } } },
                batchProgress: { oneOf: [{ type: 'object' }, { type: 'null' }] },
                stageTimings: { type: 'object' },
                usage: { type: 'object' },
                tps: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                notes: { type: 'array', items: { type: 'string' } },
                autoCommit: {
                  oneOf: [{ type: 'null' }, {
                    type: 'object',
                    properties: {
                      committed: { type: 'boolean' },
                      sha: { type: 'string' },
                      message: { type: 'string' },
                      reason: { type: 'string' },
                      noChanges: { type: 'boolean' },
                      mode: { type: 'string', description: "提交方式：branch=主题分支提交后合并回原分支；direct=降级直接提交" },
                      branch: { type: 'string', description: '分支合并式提交使用的主题分支名' },
                      fallback: { type: 'string', description: 'direct 降级的原因' },
                    },
                  }],
                },
                error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
                finishedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
        required: ['jobs'],
      },
      render(args, value) {
        if (!value.jobs.length) return [{ type: 'text', text: 'codewiki_progress：没有匹配的编译任务' }]
        const lines = [`codewiki_progress：${value.jobs.length} 个任务`]
        for (const j of value.jobs) {
          const pct = j.progress === null ? '' : ` ${j.progress}%`
          const head = `${j.id} ${j.cwd}｜${j.kind}/${j.scope}｜stage=${j.stage}${pct}｜写 ${j.writtenCount} 篇/失败 ${j.failedCount}${j.cancelRequested ? '｜取消中' : ''}`
          lines.push(head)
          for (const t of (j.taskList ?? [])) {
            const mark = t.state === 'done' ? '✓' : t.state === 'failed' ? '✗' : '·'
            lines.push(`  ${mark} ${t.name}`)
          }
          if (j.autoCommit) {
            lines.push(j.autoCommit.committed
              ? `  产物已自动提交：${j.autoCommit.sha ?? ''}（无需你跑 git）`
              : j.autoCommit.noChanges
                ? '  产物无未提交改动（无需提交）'
                : `  产物未自动提交：${j.autoCommit.reason ?? '未知原因'}`)
          }
          if (j.error) lines.push(`  错误：${j.error}`)
          for (const n of (j.notes ?? []).slice(-3)) lines.push(`  · ${n}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('codewiki_progress：插件已在设置中停用（codewiki → enabled）')
      if (!svc) throw new Error('codewiki_progress：编排服务未初始化')
      let list = svc.list()
      const jobId = String(args.jobId ?? '').trim()
      if (jobId) {
        list = list.filter((j) => j.id === jobId)
      } else {
        const cwd = normalizeCwd(args.cwd)
        if (cwd) list = list.filter((j) => samePath(j.cwd, cwd))
      }
      return { jobs: list.map(progressView) }
    },
  }
}

// ---------------------------------------------------------------------------
// 本机面板后端：GET /api/codewiki/jobs、POST /api/codewiki/control（仅回环）
// ---------------------------------------------------------------------------

function isLoopbackRequest(req) {
  const addr = String(req?.socket?.remoteAddress ?? '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体超过 1MB'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

// 模型目录（设置页级联下拉的数据源）：宿主 llm 服务里已注册的 provider 及其模型。
// 与宿主模型设置同源，不读插件配置。provider 元数据字段名兼容 id/provider、
// displayName/name 两种写法（listProviders 返回 adapter 原样对象）。
// 单个 provider 的 listModels 抛错（缺凭证/端点不通）不影响其它 provider：
// 该条目保留、models 为空、附 error，设置页据此提示手填。
export async function listModelCatalog(llm) {
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, error: 'llm 服务未注入，无法枚举模型提供商；可在设置里手填 batchProvider/batchModel', providers: [] }
  }
  const providers = []
  for (const p of llm.listProviders() ?? []) {
    const id = String(p?.id ?? p?.provider ?? '')
    if (!id) continue
    const entry = { id, name: String(p?.displayName ?? p?.name ?? id), models: [] }
    try {
      if (typeof llm.listModels === 'function') {
        entry.models = (await llm.listModels(id) ?? [])
          .map((m) => ({ id: String(m?.id ?? ''), name: String(m?.name ?? m?.id ?? '') }))
          .filter((m) => m.id)
      }
    } catch (err) {
      entry.error = String(err?.message ?? err)
    }
    providers.push(entry)
  }
  return { ok: true, providers }
}

// 宿主 llm 服务暴露的是 resolveModelInfo(provider, model, signal)；
// resolveModel 只存在于 adapter 注册表接口（LlmAdapterRegistry），插件拿到的是
// LlmService，所以旧写法恒失败（设置页因此一直显示「读取思考档位失败」）。
// 两个都试，前者为准、后者兜底旧宿主/测试桩。
const resolveModelInfoOf = (llm) => {
  if (!llm) return null
  if (typeof llm.resolveModelInfo === 'function') return (p, m, s) => llm.resolveModelInfo(p, m, s)
  if (typeof llm.resolveModel === 'function') return (p, m, s) => llm.resolveModel(p, m, s)
  return null
}

// 单个 provider/model 的「思考程度」档位（设置页下拉的数据源）：走宿主 llm 的
// resolveModelInfo，它返回 adapter 声明的 reasoning.efforts 与 defaultEffort ——
// listModels 不带这两项，所以对齐思考程度必须单独解析。
// 失败（模型不在目录/探测失败）返回 ok:false + efforts:[]，设置页降级为手填或隐藏。
export async function resolveModelEfforts(llm, provider, model) {
  const resolveOne = resolveModelInfoOf(llm)
  if (!resolveOne) {
    return { ok: false, error: 'llm 服务未注入或缺少 resolveModelInfo，无法读取思考档位', efforts: [], defaultEffort: null }
  }
  try {
    const info = await resolveOne(provider, model)
    const efforts = (info?.reasoning?.efforts ?? []).map((e) => ({
      id: String(e?.id ?? ''),
      name: String(e?.name ?? e?.id ?? ''),
      description: e?.description ? String(e.description) : '',
    })).filter((e) => e.id)
    return {
      ok: true,
      provider, model,
      efforts,
      defaultEffort: info?.reasoning?.defaultEffort ? String(info.reasoning.defaultEffort) : null,
      context: Number(info?.context?.tokens ?? info?.context ?? 0) || null,
    }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), efforts: [], defaultEffort: null }
  }
}

export function installWebServer(ctx, service, extra = {}) {
  const { config, schedState, compile } = extra
  if (typeof ctx.inject !== 'function') return
  // 宿主工作区注册表（WorkspaceRegistry.list() 同步内存投影）：任务页过滤数据源。
  // 服务缺失（老宿主/测试 ctx）时保持 null——jobs 端点不过滤，行为与 0.4.8 一致。
  let workspaceRegistry = null
  // cordis inject 回调参数是「注入了所声明服务的 ctx 切片」，服务本体在切片同名属性上
  // （0.4.10 真宿主 `cannot get property "list" without inject` 的根因：切片被当成实例存下）。
  // 兼容旧 mock 直传实例的形态：切片无同名属性时回退参数本身，且必须带 list 方法。
  ctx.inject(['workspaceRegistry'], (rc) => {
    const wr = rc?.workspaceRegistry ?? rc
    workspaceRegistry = wr && typeof wr.list === 'function' ? wr : null
  })
  // 工作区过滤清单（jobs 与 repos 总览共用）：宿主注册表可用且开关开启时返回路径清单，否则 null。
  // cwd 等于某工作区或位于其子目录内（isExcluded 命中判定，语义同 hindsight withinPath）；
  // 宿主未注册任何工作区时返回 null——不过滤，行为与 0.4.8 一致。
  const wsFilterPaths = () => {
    const wr = workspaceRegistry
    if (!wr || typeof wr.list !== 'function') return null
    if (liveConfig(config ?? {}).workspaceOnly === false) return null
    let wsList
    try {
      wsList = wr.list() ?? []
    } catch (err) {
      // 宿主注册表内部不一致（如 order references missing workspace）时降级不过滤：
      // 过滤是体验优化，不能拖垮 jobs/repos 端点。
      console.warn('[codewiki] workspaceRegistry.list() 抛错，工作区过滤降级停用：', err?.message ?? err)
      return null
    }
    const wsPaths = wsList.map((w) => w?.path).filter((p) => typeof p === 'string' && p)
    return wsPaths.length ? wsPaths : null
  }
  // cordis：webServer 服务缺失时 inject 回调整体跳过（静默降级，面板查不到进度但不报错）
  ctx.inject(['webServer'], (rc) => {
    const ws = rc?.webServer ?? rc
    if (!ws || typeof ws.register !== 'function') return
    const guard = (req, res) => {
      if (isLoopbackRequest(req)) return true
      writeJson(res, 403, { error: 'loopback only' })
      return false
    }
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/jobs',
      handler: (req, res) => {
        if (!guard(req, res)) return
        try {
          let list = service.list()
          // workspaceOnly（默认开）：Temp 沙箱与任意路径的**终态**任务不出现在面板。
          // 非终态（queued/编译中）始终显示：单项目串行下闸门可能被一个不在工作区
          // 清单里的项目（如 worktree）占住，藏掉它用户既看不到谁在编译也无法取消。
          const wsPaths = wsFilterPaths()
          if (wsPaths) list = list.filter((j) => !JOB_TERMINAL.has(j.stage) || isExcluded(j.cwd, wsPaths))
          // 编译对象闸门（1.2.1）：worktree 目录与无可编译源码的空壳目录的任务一律不出现在
          // 任务列表——这类任务本身就不该存在（submit 闸门已拦），历史遗留条目只会在面板上
          // 占位并干扰「在等谁」的队列可见性判断。判定带 60s/10min 缓存，2s 轮询不会打爆 git。
          list = list.filter((j) => !isDeadCompileTarget(j.cwd))
          // 排队可见性：queued 任务标注「在等谁」——正在跑的项目 + 排在它前面的 queued
          //（按提交顺序，jobs 列表本身已按 createdAt 升序）。面板直接渲染，不再让用户猜。
          const running = list.filter((j) => !JOB_TERMINAL.has(j.stage) && j.stage !== 'queued' && j.stage !== 'submitting')
          const queued = list.filter((j) => j.stage === 'queued')
          if (queued.length) {
            list = list.map((j) => {
              if (j.stage !== 'queued') return j
              const ahead = [
                ...running.map((r) => path.basename(String(r.cwd ?? ''))),
                ...queued.filter((q) => q !== j && String(q.createdAt ?? '') <= String(j.createdAt ?? '')).map((q) => path.basename(String(q.cwd ?? ''))),
              ]
              return { ...j, queueAhead: ahead, queueAheadCount: ahead.length }
            })
          }
          writeJson(res, 200, { now: new Date().toISOString(), jobs: list })
        } catch (err) {
          // 宿主 webserver 对 handler reject 只回 400 空 body——把错误栈直接写进响应体便于排查
          writeJson(res, 500, { error: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 8) })
        }
      },
    })
    // 仓库总览：jobs 历史工作区的 wiki 状态（cw status 现算，30s 缓存——面板 2s 轮询不打爆 git）
    let reposCache = null
    let reposCacheAt = 0
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/repos',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
        const wsSig = (() => {
          // 缓存签名 = 工作区清单 + 当前非终态任务的工作区：编译中的仓库进出总览
          // （如 worktree 任务开始/收尾）必须立即反映，不吃 30s 陈旧缓存。
          const p = wsFilterPaths()
          const active = service.list().filter((j) => !JOB_TERMINAL.has(j.stage)).map((j) => path.normalize(String(j.cwd ?? ''))).sort()
          return [...(p ? [...p].sort() : []), ...active].join('|')
        })()
        if (!reposCache || reposCache.sig !== wsSig || Date.now() - reposCacheAt > 30000) {
          const c = liveConfig(config ?? {})
          const normKey = (p) => path.normalize(String(p ?? '')).replace(/[\\/]+$/, '').toLowerCase()
          const seen = new Map() // normKey → 展示用 cwd（job 历史形态优先，knownRepos 补缺）
          const lastByCwd = new Map()
          const putCwd = (dir, last) => {
            if (!dir) return
            // 编译对象闸门（1.2.1）：worktree 目录与无可编译源码的空壳目录不进仓库总览——
            // 它们永远编译不出东西，出现在总览里只会诱导用户反复手动提交。
            if (isDeadCompileTarget(dir)) return
            const k = normKey(dir)
            if (seen.has(k)) {
              if (last && !lastByCwd.get(seen.get(k))) lastByCwd.set(seen.get(k), last)
              return
            }
            seen.set(k, dir)
            lastByCwd.set(dir, last ?? null)
          }
          // workspaceOnly（默认开）：总览只显示已添加工作区（含其子仓库）——knownRepos/job
          // 历史里的 Temp 沙箱与任意路径目录不再出现；无清单时不过滤。
          // 非终态任务的工作区例外放行（同 jobs 端点）：编译中的仓库必须可见。
          const wsPaths = wsFilterPaths()
          const inWs = (dir) => !wsPaths || isExcluded(dir, wsPaths)
          for (const j of service.list()) if (!JOB_TERMINAL.has(j.stage) || inWs(j.cwd)) putCwd(j.cwd, j)
          for (const dir of loadKnownRepos()) if (inWs(dir)) putCwd(dir, null)
          const repos = []
          for (const cwd of seen.values()) {
            const last = lastByCwd.get(cwd)
            const base = {
              cwd,
              excluded: isExcluded(cwd, c.excludePaths),
              lastJob: last ? {
                id: last.id, kind: last.kind, stage: last.stage, auto: last.auto === true,
                finishedAt: last.finishedAt ?? null, writtenCount: last.writtenCount ?? 0,
                tps: last.tps ?? null, batchProgress: last.batchProgress ?? null,
                batchSubmittedAt: last.batchSubmittedAt ?? null,
                taskList: JOB_TERMINAL.has(last.stage) ? [] : (last.taskList ?? []),
              } : null,
            }
            try {
              const binary = resolveBinary(c)
              const st = await runCw(binary, cwd, ['status'], 20000)
              const status = parseStatus(st.stdout)
              const wp = await wikiPathFor(cwd, binary).catch(() => null)
              repos.push({
                ...base,
                state: status.state,
                staleArticles: status.staleArticles.length,
                changedFiles: status.changedFiles.length,
                wikiPath: wp,
                articleCount: wp ? countWikiArticles(wp) : null,
              })
            } catch (err) {
              repos.push({ ...base, state: 'error', error: String(err?.message ?? err) })
            }
          }
          reposCache = {
            sig: wsSig,
            repos,
            scheduler: {
              enabled: c.autoUpdate,
              intervalMin: c.autoUpdateMin,
              lastScan: schedState?.lastScan ? new Date(schedState.lastScan).toISOString() : null,
              scanning: schedState?.scanning === true,
              lastError: schedState?.lastError ?? null,
              lastScanRepos: schedState?.lastScanRepos ?? null,
              lastScanSubmitted: schedState?.lastScanSubmitted ?? null,
            },
          }
          reposCacheAt = Date.now()
        }
        writeJson(res, 200, reposCache)
        } catch (err) {
          writeJson(res, 500, { error: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 8) })
        }
      },
    })
    // 会话内容（1.1.0）：并发池每个 LLM 请求的 prompt/输出记录，保留一天，仅回环面板可读。
    //   GET /api/codewiki/sessions?jobId=      → { sessions: [meta] }（最新在前，单任务）
    //   GET /api/codewiki/sessions             → { sessions: [meta+jobId+cwd] }（1.2.0 全局 Tab：
    //                                            跨任务聚合，最新在前，limit 默认 200）
    //   GET /api/codewiki/sessions/item?jobId=&n= → 单条全文 { prompt, output, ... }
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/sessions',
      handler: (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const jobId = String(url.searchParams.get('jobId') ?? '').trim()
          if (jobId) { writeJson(res, 200, { sessions: listSessionRecords(jobId) }); return }
          // 全局聚合：带上 cwd（面板行里显示是哪个仓库在编译），只给最近 limit 条
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
          const byId = new Map()
          for (const j of service.list()) byId.set(j.id, j.cwd ?? '')
          const sessions = listAllSessionRecords({ limit }).map((s) => ({
            ...s, cwd: byId.get(s.jobId) ?? '',
          }))
          writeJson(res, 200, { sessions })
        } catch (err) {
          writeJson(res, 500, { error: String(err?.message ?? err) })
        }
      },
    })
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/sessions/item',
      handler: (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const jobId = String(url.searchParams.get('jobId') ?? '').trim()
          const n = Number(url.searchParams.get('n'))
          if (!jobId || !Number.isInteger(n) || n < 1) { writeJson(res, 400, { error: '缺少 jobId/n 查询参数' }); return }
          const rec = readSessionRecord(jobId, n)
          if (!rec) { writeJson(res, 404, { error: '会话记录不存在或已过期（保留 24h）' }); return }
          writeJson(res, 200, rec)
        } catch (err) {
          writeJson(res, 500, { error: String(err?.message ?? err) })
        }
      },
    })
    // 模型目录：设置页「编译模型」级联下拉的数据源。与宿主模型设置同源
    // （llm.listProviders + 各 provider 的 listModels），不读插件自己的配置。
    // 缺凭证/探测失败的 provider 保留在列表里但 models 为空，附 error 供设置页提示；
    // llm 服务未注入时整体报错，设置页降级为手填。
    let modelsCache = null
    let modelsCacheAt = 0
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/models',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          if (!modelsCache || Date.now() - modelsCacheAt > 30000) {
            modelsCache = await listModelCatalog(extra.llm ?? llmRef)
            modelsCacheAt = Date.now()
          }
          writeJson(res, 200, modelsCache)
        } catch (err) {
          writeJson(res, 500, { ok: false, error: String(err?.message ?? err), providers: [] })
        }
      },
    })
    // 思考程度档位：设置页选中 provider/model 后二次拉取，下拉项直接来自模型目录
    // （resolveModel 的 reasoning.efforts + defaultEffort），不再手填裸字符串。
    const effortsCache = new Map()
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/model-efforts',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const provider = String(url.searchParams.get('provider') ?? '').trim()
          const model = String(url.searchParams.get('model') ?? '').trim()
          if (!provider || !model) { writeJson(res, 400, { ok: false, error: '缺少 provider/model 查询参数', efforts: [] }); return }
          const key = `${provider}\u0000${model}`
          const hit = effortsCache.get(key)
          if (hit && Date.now() - hit.at < 60000) { writeJson(res, 200, hit.value); return }
          const value = await resolveModelEfforts(extra.llm ?? llmRef, provider, model)
          effortsCache.set(key, { at: Date.now(), value })
          writeJson(res, 200, value)
        } catch (err) {
          writeJson(res, 500, { ok: false, error: String(err?.message ?? err), efforts: [] })
        }
      },
    })
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/control',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
        let body
        try { body = await readBodyJson(req) } catch (err) { writeJson(res, 400, { error: String(err?.message ?? err) }); return }
        if (body?.action === 'cancel' && body?.jobId) {
          const ok = service.cancel(String(body.jobId))
          writeJson(res, ok ? 200 : 404, { ok })
          return
        }
        if (body?.action === 'refresh') {
          reposCache = null
          writeJson(res, 200, { ok: true })
          return
        }
        if (body?.action === 'compile' && body?.cwd) {
          if (typeof compile !== 'function') { writeJson(res, 501, { error: '编译入口未初始化' }); return }
          reposCache = null // 编译提交会改 wiki 状态，下次拉总览强制重算
          try {
            const r = await compile({ cwd: String(body.cwd), scope: ['auto', 'full', 'stale'].includes(body?.scope) ? body.scope : 'auto' }, {})
            writeJson(res, 200, { ok: true, ...r })
          } catch (err) {
            writeJson(res, 400, { ok: false, error: String(err?.message ?? err) })
          }
          return
        }
        writeJson(res, 400, { error: '未知 action；支持 {"action":"cancel","jobId":"..."} / {"action":"compile","cwd":"..."} / {"action":"refresh"}' })
      },
    })
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

// 会话系统提示里的 wiki 维护提醒：只在会话仓库根存在 wiki 入口 CodeWiki.md 时出现。
// 判定不看 .codewiki/ 目录——半途建出的空骨架（只有空子目录）会骗过目录存在性检查，
// 提醒却指向一个读不到的入口。无 CodeWiki.md = 无可维护的 wiki。text 回调每次组装时
// 求值——cwd、入口文件存在性、开关全部实时读取，关闭开关/项目切换/删掉 wiki 都无需重启。
// 编译完成后的提交提醒（0.10.9 起只在插件自动提交失败时出现）：最近一次成功编译
// （stage=done 且有文章写成功）的完成时间晚于 .codewiki/（与 CodeWiki.md）最后一次
// git 提交时间 → 该次编译产物尚未入库，系统提示注入「产物待提交」（一次性，非催促）。
// 自动提交成功时时间戳反超，提醒自动静默；零状态派生（jobs 文件 + git log 时间戳），
// 非 git 仓库/读 jobs 失败一律不提醒。60s TTL 缓存：text 回调每次组装系统提示都求值。
const commitHintCache = new Map() // cwd -> { at, text }

// ---------------------------------------------------------------------------
// 编译产物自动提交（0.10.9 直接提交，0.10.11 升级为分支合并式）：把「等编译完成 →
// 提交 .codewiki/」整个责任从会话模型手里收回到插件侧。有产物时先在主题分支
// codewiki/wiki-<jobId> 上提交 .codewiki/ 与 CodeWiki.md，再合并回原分支并删除主题
// 分支——会话模型因此无需等待编译、无需轮询、无需代跑 git。
//
// 安全边界（任何一条不满足就只降级为「提醒会话模型提交」，绝不做半个提交）：
//   · 只提交 WIKI_PATHS 这两个路径（`git add -- .codewiki CodeWiki.md` 的 pathspec 形式，
//     不是 -A / --all / . —— pathspec 已把改动限定在 wiki 产物内）
//   · merge/rebase/cherry-pick 进行中不动手；不 amend、不 push、不改写历史、不碰其它改动
//   · 目标路径存在未解决冲突、仓库无 HEAD、未配置 user.name/user.email、
//     路径被 .gitignore 忽略 → 一律返回 {committed:false, reason}
//   · 分支路径自身不可用（detached HEAD、建分支失败）→ 降级为直接提交（mode:'direct'）；
//     合并冲突/失败 → 中止合并、保留主题分支，绝不强合、绝不丢产物
// 返回值：{ committed, sha?, message?, noChanges?, reason?, mode?, branch?, fallback? }
// ---------------------------------------------------------------------------
export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {
  const opts = { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true }
  const run = (...args) => spawnSync('git', args, opts)
  const out = (r) => String(r?.stdout ?? '').trim()
  // 只对磁盘上存在的路径操作：CodeWiki.md 尚未生成时固定 pathspec 会让 `git add` 直接
  // fatal（而不是安静地只提交 .codewiki/）。tracked 文件被删除的场景编译流程不会产生，
  // 不为它扩展 pathspec。
  const paths = WIKI_PATHS.filter((p) => fs.existsSync(path.join(cwd, p)))
  if (!paths.length) return { committed: false, noChanges: true, reason: '没有可提交的产物（.codewiki/ 与 CodeWiki.md 均不存在）' }
  try {
    const inside = run('rev-parse', '--is-inside-work-tree')
    if (inside.status !== 0 || out(inside) !== 'true') return { committed: false, reason: '不是 git 仓库' }
    if (run('rev-parse', '--verify', '-q', 'HEAD').status !== 0) return { committed: false, reason: '仓库还没有首次提交（无 HEAD）' }
    // merge / rebase / cherry-pick 进行中：此时 commit 会把 wiki 产物夹进别人的合并提交
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (run('rev-parse', '--verify', '-q', marker).status === 0) return { committed: false, reason: `仓库正在合并/变基中（${marker}）` }
    }
    if (out(run('ls-files', '-u', '--', ...paths))) return { committed: false, reason: '目标路径存在未解决冲突' }
    // .codewiki/ 常被项目 .gitignore 忽略：必须显式认出来，否则会误报「无改动」并静默丢产物。
    // 只对「磁盘上存在且尚无任何 tracked 文件」的路径判定——已 tracked 的文件命中 ignore
    // 规则时 git 照样记录改动，不该被这里拦下。
    const ignored = paths.filter((p) => fs.existsSync(path.join(cwd, p))
      && !out(run('ls-files', '--', p))
      && run('check-ignore', '-q', '--', p).status === 0)
    if (ignored.length) return { committed: false, reason: `${ignored.join('、')} 被 .gitignore 忽略，无法自动提交` }
    if (!out(run('status', '--porcelain', '--', ...paths))) return { committed: false, noChanges: true, reason: '产物无未提交改动' }
    if (!out(run('config', 'user.email')) || !out(run('config', 'user.name'))) {
      return { committed: false, reason: '仓库未配置 git user.name/user.email' }
    }
    const tail = [jobId ? `任务 ${jobId}` : '', writtenCount ? `${writtenCount} 篇文章` : ''].filter(Boolean).join('，')
    const message = `docs(wiki): 更新 CodeWiki 编译产物${tail ? `（${tail}）` : ''}`
    const commitOn = () => {
      // pathspec 形式：改动被限定在这两个路径内，与 -A 无关（注释与文档都按此描述）
      const add = run('add', '--', ...paths)
      if (add.status !== 0) return { committed: false, reason: `git add 失败：${(add.stderr || add.stdout || '').trim().slice(0, 200)}` }
      // add 后仍无暂存内容：路径被 .gitignore 忽略（.codewiki 常被忽略）
      if (!out(run('diff', '--cached', '--name-only', '--', ...paths))) {
        return { committed: false, reason: '目标路径被 .gitignore 忽略，无内容可提交' }
      }
      // --no-verify：不跑仓库钩子——自动提交不该被 husky/lint-staged 卡住或改写
      const commit = run('commit', '--no-verify', '-m', message, '--', ...paths)
      if (commit.status !== 0) return { committed: false, reason: `git commit 失败：${(commit.stderr || commit.stdout || '').trim().slice(0, 200)}` }
      return { committed: true, sha: out(run('rev-parse', '--short', 'HEAD')), message }
    }
    // 分支合并式（0.10.11）：主题分支上提交 → 合并回原分支 → 删主题分支。
    // detached HEAD 没有「原分支」可回 → 降级为直接提交（与 0.10.9 行为一致）。
    const cur = out(run('branch', '--show-current'))
    if (!cur) {
      const d = commitOn()
      return d.committed ? { ...d, mode: 'direct', fallback: 'detached HEAD，无原分支可合并回' } : d
    }
    const topic = `codewiki/wiki-${jobId || Date.now().toString(36)}`
    if (run('switch', '-c', topic).status !== 0) {
      const d = commitOn()
      return d.committed ? { ...d, mode: 'direct', fallback: '建主题分支失败，降级为直接提交' } : d
    }
    // 进入主题分支后任何失败都必须先切回原分支——绝不把用户留在插件建出的分支上
    let r
    try {
      r = commitOn()
    } finally {
      if (out(run('branch', '--show-current')) === topic) run('switch', cur)
    }
    if (!r.committed) return { ...r, mode: 'branch', branch: topic }
    // 合并回原分支：能 ff 则 ff；diverged 时普通合并；失败一律中止合并、保留主题分支。
    // 同步流程内原分支在切出后不再前进，merge 恒为 ff——diverged/冲突只会来自编译期间
    // 用户在原分支的真实推进，单测构造不出来，此路径是防御性的。
    const merge = run('merge', '--no-edit', topic)
    if (merge.status !== 0) {
      run('merge', '--abort') // 冲突场景恢复合并前状态；非冲突失败时 abort 报错也无害
      const kept = run('rev-parse', '--verify', '-q', `refs/heads/${topic}`).status === 0
      return {
        committed: false, mode: 'branch', branch: topic,
        reason: `产物已提交到主题分支 ${topic}，合并回 ${cur} 失败，已中止合并${kept ? '，主题分支已保留——请手动合并后删除' : ''}：${(merge.stderr || merge.stdout || '').trim().slice(0, 160)}`,
      }
    }
    // -d 只删已合并分支：合并失败的场景根本走不到这里，绝不强删
    run('branch', '-d', topic)
    return { committed: true, sha: out(run('rev-parse', '--short', 'HEAD')), message, mode: 'branch', branch: topic }
  } catch (err) {
    return { committed: false, reason: `自动提交异常：${String(err?.message ?? err).slice(0, 200)}` }
  }
}

export function commitHintText(cwd, jobs = loadJobs()) {
  const key = path.normalize(String(cwd ?? ''))
  const hit = commitHintCache.get(key)
  if (hit && Date.now() - hit.at < 60000) return hit.text
  let text = ''
  try {
    const latest = jobs
      .filter((j) => j.stage === 'done' && (j.writtenCount ?? 0) > 0 && j.finishedAt && samePath(j.cwd, cwd))
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0]
    // 自动提交已成功或产物本就无改动 → 不必再查 git：该任务不需要任何提交动作。
    // （与 wakeCompileSession 共用 autoCommitState，两条通道对同一次编译给出同一结论。）
    if (latest && autoCommitState(latest) === 'pending') {
      const g = spawnSync('git', ['-C', cwd, 'log', '-1', '--format=%ct', '--', ...WIKI_PATHS], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const commitSec = Number.parseInt(String(g.stdout ?? '').trim(), 10)
      const jobSec = Math.floor(Date.parse(latest.finishedAt) / 1000)
      // 只有「插件自动提交没成功」才提醒；插件已提交时 commitSec ≥ jobSec 也静默
      // （人工随后提交的情形），会话模型无需为此等待或代跑 git。
      if (Number.isFinite(jobSec) && (!Number.isFinite(commitSec) || jobSec > commitSec)) {
        const why = latest.autoCommit?.reason
          ? `插件自动提交未执行（${latest.autoCommit.reason}）`
          : '编译产物尚未提交 git'
        text = [
          `【CodeWiki 产物待提交·一次性】本仓库 wiki 编译已完成（任务 ${latest.id}，写入 ${latest.writtenCount} 篇文章），${why}：`,
          '- 若确需入库，只 add .codewiki/ 与 CodeWiki.md 后提交（建议 docs(wiki) 前缀；不要 git add -A），随手一次即可；',
          '- 不需要提交就忽略本提醒——不要为了本提醒中断当前任务、不要轮询编译进度。',
        ].join('\n')
      }
    }
  } catch { /* 非 git 仓库 / jobs 读取失败 → 不提醒 */ }
  commitHintCache.set(key, { at: Date.now(), text })
  return text
}

function reminderText(cwd) {
  return [
    '【CodeWiki 维护】本仓库存在 wiki（入口 CodeWiki.md），涉及代码改动的任务收尾时必须：',
    '- 调用 codewiki_generate 工具（scope=auto 即可）更新受影响文章——learnings/、decisions/ 补文章与索引刷新均由流水线完成；不要手工编写或修改 .codewiki/ 下的文章（手改不进流水线、不被面板记录，还会被下次编译覆盖）；',
    '- codewiki_generate 是后台编译：调用即返回提交回执，编译由宿主服务推进——调用后本步就此结束，不要等待、不要轮询、不要为了看进度而反复调 codewiki_progress；继续你的其他工作，编译完成的产物由插件自己提交入库（autoCommit 默认开：主题分支提交后合并回原分支），无需你跑 git；',
    `- wiki 入口 CodeWiki.md 与 .codewiki/ 全部内容都在仓库根 ${cwd}，在本目录之外读写它们时一律用绝对路径；`,
    '- 若收到「产物待提交」提醒，说明插件自动提交没成功（非 git 仓库/被忽略/冲突等），此时才需要你代为提交一次；没有该提醒就不要动 .codewiki/ 的 git 状态（插件已提交或产物无改动时不会有提醒）；',
    '- 收尾未调用 codewiki_generate 视为任务未完成。',
  ].join('\n')
}

function installUpdateReminder(ctx, config) {
  if (typeof ctx.on !== 'function') return
  const seen = new WeakSet()
  const install = (agent) => {
    if (!agent || seen.has(agent)) return
    seen.add(agent)
    agent.ctx?.inject?.(['systemPrompt'], (rc2) => {
      const sp = rc2?.systemPrompt ?? rc2
      if (typeof sp?.section !== 'function') return
      sp.section({
        name: 'codewiki:update-reminder',
        order: (typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('TOOL_REPORT') : 2900) + 1,
        text: () => {
          if (val(config?.updateReminder) === false) return ''
          const cwd = String(agent.session?.header?.cwd ?? '')
          if (!cwd || !fs.existsSync(path.join(cwd, 'CodeWiki.md'))) return ''
          const hint = commitHintText(cwd)
          return hint ? `${reminderText(cwd)}\n\n${hint}` : reminderText(cwd)
        },
      })
    })
  }
  // cordis：插件 ctx 上未声明 inject 的服务属性，访问本身即抛（typeof 守卫无效）；
  // 存量代理改经 inject(['agents']) 获取，服务缺失时静默跳过，新会话仍走 agent/created。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (rc3) => {
      const agents = rc3?.agents ?? rc3
      if (typeof agents?.list !== 'function') return
      for (const agent of agents.list()) install(agent)
    })
  }
  ctx.on('agent/created', async ({ agent } = {}) => { install(agent) })
}

export function apply(ctx, config) {
  if (typeof ctx.inject === 'function') ctx.inject(['agents'], (rc) => { agentsRef = rc?.agents ?? rc })
  if (typeof ctx.inject === 'function') ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })
  const service = createJobService(config, wakeCompileSession)
  service.start()
  // cordis effect：立即执行 body 并把返回值收集为 disposer——必须返回清理函数本身，
  // 写成 () => service.stop() 会在启动时当场停掉服务（返回 undefined 也无 disposer）
  if (typeof ctx.effect === 'function') ctx.effect(() => () => service.stop())
  const generateDef = generateToolDefinition(config, service)
  const updateDef = updateToolDefinition(config, generateDef)
  // 自动更新调度器：60s 心跳，到点对历史工作区逐个 scope=auto 判态提交。
  // execute 幂等（活动仓库直接返回现有任务），单仓库失败只记 lastError 不打断扫描。
  const schedState = { lastScan: 0, scanning: false, lastError: null, lastScanRepos: null, lastScanSubmitted: null }
  let scanning = false
  const autoScan = async () => {
    const c = liveConfig(config)
    if (!c.autoUpdate || scanning) return
    if (Date.now() - schedState.lastScan < c.autoUpdateMin * 60000) return
    scanning = true
    schedState.scanning = true
    schedState.lastScan = Date.now()
    schedState.lastScanRepos = 0
    schedState.lastScanSubmitted = 0
    try {
      const cwds = [...new Set(service.list().map((j) => j.cwd).filter(Boolean))]
      for (const cwd of cwds) {
        if (isExcluded(cwd, c.excludePaths)) continue
        // worktree 目录静默跳过（1.2.0）：历史任务里可能留着 worktree 路径，不编译也不记错误
        if (isWorktreeCwd(cwd)) continue
        // 空壳目录静默跳过（1.2.1）：扫不出源码的目录永远编译不出东西，submit 闸门虽也会拦，
        // 但在这里先跳掉更省事——不产生 job、不进 queueAhead 的「在等谁」名单。
        if (!hasCompilableSources(cwd)) continue
        schedState.lastScanRepos++
        try {
          const r = await generateDef.execute({ cwd, scope: 'auto', auto: true }, {})
          if (r?.submitted === true) schedState.lastScanSubmitted++
        } catch (err) {
          schedState.lastError = `${new Date().toISOString()} ${String(err?.message ?? err).slice(0, 200)}`
        }
      }
    } finally { scanning = false; schedState.scanning = false }
  }
  const scanTimer = setInterval(() => { void autoScan() }, 60000)
  scanTimer.unref?.()
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(scanTimer))
  ctx.inject?.(['tools'], (rc) => {
    const tools = rc?.tools ?? rc
    if (!tools?.register) return
    for (const definition of [cwToolDefinition(config), generateDef, updateDef, progressToolDefinition(config, service)]) {
      // 单工具 schema 违规只丢该工具：宿主 register 校验（assertSupportedJsonSchema）抛错时
      // 不能让它炸掉回调——cordis 会把 apply 回调失败视为 fiber FAILED 并回滚已注册的全部工具
      try {
        const disposer = tools.register(definition)
        if (typeof disposer === 'function') {
          if (typeof ctx.effect === 'function') ctx.effect(() => disposer)
          else ctx.on?.('dispose', () => { try { disposer() } catch { /* 忽略 */ } })
        }
      } catch (err) {
        console.error(`[codewiki] 工具 ${definition.name} 注册失败（该工具不可用）：`, err?.message ?? err)
      }
    }
  })
  installWebServer(ctx, service, { config, schedState, compile: (args, exec) => generateDef.execute(args, exec) })
  installUpdateReminder(ctx, config)
}
