// dsh-codewiki — 把 mraza007/codewiki（Rust CLI `cw`）接入 DeepSeek Harness。
// 提供两个工具：
//   cw                — 薄封装 CodeWiki CLI（init/status/index/meta/path/projects/setup/uninstall）
//   codewiki_generate — 服务化编译：判态后把编译任务提交给宿主常驻服务（侧边栏 CodeWiki 面板可见），
//                       服务按 写文章 → 横切 → 审校 → 索引 推进，全部环节在插件内完成
//                       （默认模型 volces-ark/glm-5.3-flash，512k 上下文，单请求输入预算 110k），零子代理。
//   codewiki_progress — 只读查编译进度：提交后随时查 stage/百分比/篇数/失败原因，立即返回不等待。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { runAgenticArticles, markBigAgenticTasks, sourceTokensOf } from './lib/articles-agentic.js'
import { buildOpeningPrompt, TOOL_SCHEMAS, DEFAULT_MAX_STEPS } from './lib/agentic.js'
import { collectChangeSet } from './lib/change-set.js'
import { withQuotepathOff } from './lib/git-paths.js'
import {
  judgeOutcome, buildUpdateRecord, saveUpdateRecord, loadUpdateRecord,
  describeOutcome, isTerminalStage, TERMINAL, UPDATE_RECORD_REL,
} from './lib/update-record.js'
import { inspectArticle, hasBlockingIssue, issueSummary } from './lib/article-contract.js'
// 阶段 4：原生引擎（FSoft Python）通道。整条裁决链在 native-run.js 里固定，
// 这里只负责「起进程 / 收进度 / 按结果判终态」——绝不在 tick 里重写裁决。
import { runNativeJob, DEFAULT_ENGINE_ENTRY, DEFAULT_ENGINE_TIMEOUT_MS } from './lib/engine/native-run.js'
import {
  createJobsStore, mergeJobLists, findActiveJob, reassignSession,
  snapshotNativeRun, planNativeReplay, heartbeat, adoptOrphan, lastSeenAt,
  planForeignJob, FOREIGN_ACTION,
} from './lib/job-store.js'
import { appendLog, readLogTail, logStats, logFileOf as logFileFor } from './lib/job-logs.js'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-codewiki'
export const name = PLUGIN_NAME
const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']
// 编译请求（同步 chat/completions）并发上限
const CONCURRENCY_HARD_CAP = 8
// 默认并发：2 路并发足够，且不触发上游限流（glm-5.3-flash 实测无压力）
const DEFAULT_CONCURRENCY = 2
// 默认编译模型：volces-ark/glm-5.3-flash（512k 上下文，宿主 llm 服务通道）
// 0.16.13 起不再默认 workbuddy/hy3：hy3 的 192k 窗口装不下本仓库的模块源码，
// 且上游空内容/截断频率明显更高（真机 job-mvu2lmd1-a 即因 hy3 返回空内容整轮失败）。
const DEFAULT_BATCH_PROVIDER = 'volces-ark'
const DEFAULT_BATCH_MODEL = 'glm-5.3-flash'
// 大档模型：单批输入超过普通预算 110k 时改用它（512k 上下文的 glm-5.3-flash）。
// 目的：超过 128k 的内容也不交会话模型，仍在插件内跑完。
const DEFAULT_BIG_PROVIDER = 'volces-ark'
const DEFAULT_BIG_MODEL = 'glm-5.3-flash'
// 大档单请求输入预算：模型 512k 上下文，留出输出与系统提示余量后取 420k
const DEFAULT_BIG_TOKEN_BUDGET = 420000
// 单模块写作的 LLM 请求上限（上游叫 request_limit）：上游默认 100，但 1b4af43 起
// 写作校验会为写不出页面的模块续发最多 2 次补写提醒，每次提醒各自吃一份预算；
// 真机上 change_set_management 模块撞满 100 次请求后抛错，已写好的 31 篇被记成 partial。
// 300 是「大模块一轮能写完」的经验上限，同时保留硬顶 1000 防止配置失误拖成一小时。
const DEFAULT_REQUEST_LIMIT = 100  // 0.17.12 回退到上游默认值（用户要求先全部改为上游逻辑验证）
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
  bigEnabled: z.boolean().default(true).volatile().description('大档模型（超长输入）开关：关闭后超过普通预算的请求不再换大上下文模型，直接按大档预算兜底或退回会话通道；大档的模型与预算配置保留，重新开启无需重填'),
  bigProvider: z.string().default(DEFAULT_BIG_PROVIDER).volatile().description('大档模型提供商（单批输入超过大档阈值时改用的模型，通常是长上下文更便宜的档）：bigEnabled 关闭时不生效，退回会话通道兜底'),
  bigModel: z.string().default(DEFAULT_BIG_MODEL).volatile().description('大档模型 id（该 provider 下）。默认火山方舟 glm-5.3-flash（512k 上下文）'),
  bigReasoningEffort: z.string().default('').volatile().description('大档模型思考程度：留空=用模型默认档；可选值由模型目录实时读取'),
  bigTokenBudget: z.number().default(DEFAULT_BIG_TOKEN_BUDGET).volatile().description('大档单请求输入预算（token）：输入超 110k 普通预算的请求改用大档；模块源码总量超此值才拆观察→合成批，单文件超此值转会话通道兜底'),
  sessionTier: z.string().default('').volatile().description('会话通道档位 id（仅当大档都装不下且大档已关闭时兜底使用，dsh-subagent-auto-router 里的档位如 codewiki）：留空=让会话模型自动选路；填了则 steer 文本要求 delegate 显式传该 tier'),
  maxConcurrency: z.number().default(DEFAULT_CONCURRENCY).volatile().description('默认档并发上限（1–8），硬顶 8；默认 2'),
  moduleConcurrency: z.number().default(0).volatile().description('原生引擎的模块生成并行度（1–8），硬顶 8：留空或 0 = 跟随默认档并发（与 bigConcurrency 同一约定，真机实测 2× 时吞吐 2.9×）；填 1 = 上游原本的严格串行（一篇约 12 分钟）。同一拓扑层的模块并发写文档，父模块仍等全部子模块；调大能明显缩短编译墙钟，代价是同批 LLM 请求更密集'),
  requestLimit: z.number().default(DEFAULT_REQUEST_LIMIT).volatile().description('单个模块写作的 LLM 请求上限（1–1000，硬顶 1000）：上游写作 agent 用它做单次 run 的预算，写不完会续发补写提醒，每次提醒各自一份预算。默认 300；上游默认 100 时大模块会撞上限中断整轮编译（真机 change_set_management 撞 100 抛错，已写 31 篇被记成 partial）'),
  bigConcurrency: z.number().default(0).volatile().description('大档并发上限（1–8），硬顶 8：留空或 0 = 跟随默认档并发。大档与默认档各自独立限流、同时推进，总在飞 = 两者之和'),
  serialProjects: z.boolean().default(true).volatile().description('单项目串行：同一时刻只推进一个仓库的编译任务，其余排队（queued），当前任务收尾后自动轮到下一个。关闭后按 parallelProjects 并行推进多个仓库'),
  parallelProjects: z.number().default(2).volatile().description('并行推进的仓库编译任务上限（1–4）：关闭单项目串行后生效。默认 2——多仓库同时编译不再互相排队；额度紧张或限流时调回 1 或开启串行'),
  articleLanguage: z.string().default('中文').volatile().description('wiki 文章书写语言'),
  updateReminder: z.boolean().default(true).volatile().description('会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，收尾时提醒更新 wiki）'),
  autoCommit: z.boolean().default(true).volatile().description('编译完成后由插件自己在主题分支上提交产物再合并回原分支（只 add .codewiki/ 与 CodeWiki.md，建议 docs(wiki) 前缀；不动其它改动）：会话模型因此无需等待编译完成、也无需提交；非 git 仓库或提交失败时降级为提醒会话模型提交'),
  excludePaths: z.string().default('').volatile().description('排除清单：这些目录（含子目录）不编译 CodeWiki。换行/分号/逗号分隔绝对路径'),
  autoUpdate: z.boolean().default(false).volatile().description('自动更新：定时扫描已编译过的工作区，检测到变更自动提交增量编译（scope=auto）'),
  autoUpdateMin: z.number().default(30).volatile().description('自动更新扫描间隔（分钟），最小 5'),
  workspaceOnly: z.boolean().default(true).volatile().description('任务页只显示属于已添加 dsh 工作区（宿主工作区列表）的任务'),
  nativeEngine: z.boolean().default(true).volatile().description('编译通道（0.16.0 起默认开启）：原生引擎通道（上游 FSoft Python 引擎）走「环境→图→聚类→文章→校验→索引→基线→提交」原生流水线，终态由质量门+落地器严格裁决；关闭=退回内置 Node 流水线（0.16.0 起降级为兼容通道，不再接收新能力）。原生通道需要本机 Python 3.10+ 与闭合的依赖环境（tools/fsoft-engine/setup-env.sh），环境不闭合时以 engine-deps 明确失败，不会悄悄改用 Node 通道'),
  nativeEnginePython: z.string().default('').volatile().description('原生引擎的 Python 解释器路径（装了 FSoft 引擎的 venv 里的 python）：留空依次用环境变量 DSH_CODEWIKI_PYTHON、PATH 里的 python'),
  nativeEngineEntry: z.string().default('').volatile().description('原生引擎入口脚本（默认插件自带 lib/engine/python/entry.py）'),
  nativeEngineTimeoutMs: z.number().default(0).volatile().description('原生引擎单次编译超时（毫秒）：0=用默认 180 分钟（真机全量实测约 174 分钟）；超时由进程树终止兜底，已写文章按 partial 抢救'),
})

function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}

// 配置 → 内部运行参数。大档开关在这里一次性收口：下游有五六处按「bigProvider 非空」
// 决定要不要换大上下文模型，逐个判断迟早漏一处，所以关闭时直接清空 provider。
// 模型 id 与预算保留——重新开启时不必重填。
export function liveConfig(config) {
  const c = config ?? {}
  const concurrency = Number(val(c.maxConcurrency))
  const bigConcurrency = Number(val(c.bigConcurrency))
  const bigEnabled = val(c.bigEnabled) !== false
  return {
    enabled: val(c.enabled) ?? true,
    binaryPath: String(val(c.binaryPath) ?? '').trim(),
    batchProvider: String(val(c.batchProvider) ?? '').trim(),
    batchModel: String(val(c.batchModel) ?? '').trim() || DEFAULT_BATCH_MODEL,
    batchReasoningEffort: String(val(c.batchReasoningEffort) ?? '').trim(),
    bigEnabled,
    bigProvider: bigEnabled ? String(val(c.bigProvider) ?? '').trim() : '',
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
    // 原生引擎的模块生成并行度：与 maxConcurrency（LLM 请求并发）是两个独立的设置项，
    // 不能混用同一个值——但 0/未填 时按 bigConcurrency 的既有约定跟随默认档并发。
    moduleConcurrency: (() => {
      const raw = Number(val(c.moduleConcurrency))
      return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), CONCURRENCY_HARD_CAP) : 0
    })(),
    // 单模块请求上限：非正值一律退回默认（0 会让 agent 循环一开就撞上限，整轮断在
    // articles 阶段）；硬顶 1000 防止配置失误把一轮编译拖成几小时。
    requestLimit: (() => {
      const raw = Number(val(c.requestLimit))
      return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 1000) : DEFAULT_REQUEST_LIMIT
    })(),
    serialProjects: val(c.serialProjects) !== false,
    parallelLimit: (() => {
      const raw = Number(val(c.parallelProjects))
      if (val(c.serialProjects) !== false) return 1
      return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 4) : 2
    })(),
    articleLanguage: String(val(c.articleLanguage) ?? '').trim() || '中文',
    excludePaths: String(val(c.excludePaths) ?? ''),
    autoUpdate: val(c.autoUpdate) === true,
    autoUpdateMin: Math.max(5, Number(val(c.autoUpdateMin)) || 30),
    autoCommit: val(c.autoCommit) !== false,
    workspaceOnly: val(c.workspaceOnly) !== false,
    // 原生通道（阶段 4）：必须经过 liveConfig 透出，否则 nativeChannelFor 永远读到
    // undefined——开关看起来打开了、实际一路走旧流水线，这种「静默不生效」比报错更难查。
    nativeEngine: val(c.nativeEngine) !== false,
    nativeEnginePython: String(val(c.nativeEnginePython) ?? '').trim(),
    nativeEngineEntry: String(val(c.nativeEngineEntry) ?? '').trim(),
    nativeEngineTimeoutMs: Number(val(c.nativeEngineTimeoutMs)) || 0,
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

// ---------------------------------------------------------------------------
// 原生引擎通道（0.16.0 起为默认通道）：上游 FSoft Python 引擎 + 薄适配层
//
// 语义（务必分清，否则会「以为换了通道其实没换」）：
//   nativeEngine          = 编译是否走原生通道（0.16.0 起默认 true；
//                           false 显式退回内置 Node 流水线，即兼容通道）
//   nativeEnginePython    = 引擎解释器（装了 FSoft 的 venv python）
// full 与 stale 增量都接管；具体走 generate 还是 update 由 native-run.js 依 change-set
// 与受管状态决议，这里只如实把 scope 传下去。环境不闭合以 engine-deps 明确失败，
// 绝不中途悄悄换成 Node 通道冒充成功。
// ---------------------------------------------------------------------------

// 原生通道是否用于本次任务。只有「开关打开 + full 编译 + 有解释器」才走；
// 任一条件不成立都返回 null，调用方据此走旧路径 —— 绝不在中途悄悄换通道。
/**
 * 原生通道是否接管本次任务（null = 走旧流水线）。
 *
 * 阶段 4 只放 full：增量还没接，stale 交给原生就会「假装增量、实际全量」。
 * 阶段 5 把 stale/auto 也放进来——但**决议权在 native-run.js**：它拿到 change-set
 * 与受管状态后自己决定 update 还是 full，上层只负责把 scope 如实传下去。
 * 这里不再按 kind 字面量猜「是不是全量」，否则 stale 永远进不来。
 *
 * @param {object} cfg liveConfig
 * @param {{kind?:string|null, scope?:string|null}} o
 * @returns {{python:string, entry:string, timeoutMs:number}|null}
 */
export function nativeChannelFor(cfg, { kind = null, scope = null } = {}) {
  const c = cfg ?? {}
  if (c.nativeEngine !== true) return null
  // 显式全量 / 未指明 scope：仍然接管。
  // stale / auto：接管，由 native-run 决定 update 还是 full。
  const effectiveScope = scope ?? (kind === 'stale' ? 'stale' : (kind === 'full' ? 'full' : 'auto'))
  const supported = effectiveScope === 'full' || effectiveScope === 'stale' || effectiveScope === 'auto'
  if (!supported) return null
  return {
    python: resolveNativePython(c),
    entry: String(c.nativeEngineEntry ?? '').trim() || DEFAULT_ENGINE_ENTRY,
    timeoutMs: Number(c.nativeEngineTimeoutMs) > 0 ? Number(c.nativeEngineTimeoutMs) : DEFAULT_ENGINE_TIMEOUT_MS,
    scope: effectiveScope,
  }
}

// 解释器解析顺序：配置 > 环境变量 > PATH 里的 python。不做「找一个能用的」启发式——
// 猜错解释器会让「环境不闭合」伪装成「引擎坏了」，用户看不出该修哪个。
export function resolveNativePython(cfg) {
  const fromCfg = String(cfg?.nativeEnginePython ?? '').trim()
  if (fromCfg) return fromCfg
  const fromEnv = String(process.env.DSH_CODEWIKI_PYTHON ?? '').trim()
  if (fromEnv) return fromEnv
  return 'python'
}

// 引擎子进程描述。模型通道用**占位 key**（桥每次随机生成，只活在进程环境里），
// 真实凭证从不进入子进程环境，也从不进日志。
// 注意：模型名必须由调用方显式传入。llm-bridge 的返回对象只有
// {url, placeholderKey, port, stats, close}——它**不含** model 字段（桥只负责转发，
// 不知道也不该知道模型选择）。曾经写成 `bridge.model`，实测得到 undefined → 
// CODEWIKI_MAIN_MODEL 变成空串 → entry.py 的 _model_config 判「缺少模型通道」→
// 每次原生编译都在 cluster 阶段以 engine-model 失败，且失败原因看起来像环境没配好。
export function nativeEnginePlan(channel, { requestId = '', bridge = null, model = '', clusterModel = '' } = {}) {
  const env = {
    // Python 输出必须是 UTF-8：Windows 默认 cp936 会把中文文章写成乱码
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    // 引擎绝不该自己去翻本机凭证库/配置：显式关掉 keyring，缺 key 时如实报 engine-model
    CODEWIKI_NO_KEYRING: '1',
  }
  if (bridge) {
    const mainModel = String(model || bridge.model || '').trim()
    env.CODEWIKI_BASE_URL = bridge.url
    env.CODEWIKI_API_KEY = bridge.placeholderKey
    env.CODEWIKI_MAIN_MODEL = mainModel
    env.CODEWIKI_CLUSTER_MODEL = String(clusterModel || bridge.clusterModel || mainModel).trim()
  }
  return { command: channel.python, args: [channel.entry], env }
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

// 清理「成为孤儿」的模块文章。
//
// 背景（真实缺陷）：模块划分会随聚类结果变化——上一次编译产出 modules/plugin-core.md，
// 下一次同样的代码被切成 modules/core-and-config.md + modules/core-application.md，
// 旧的两篇就再也没人重写、也没人删除。它们留在 .codewiki/modules/ 下成为死文章：
// 被 _index.md 遗漏、内容永久过期，还会让 test-wiki-anchors 一直拿过期的行号去校验
// 已经挪位的源码（实测 251 处失败里有 169 处来自这类孤儿）。
//
// 安全边界（宁可留着也不能误删）：
//   1. 只在**全量编译**（kind=full 且本次 modules 清单完整）时动手。增量编译只重写
//      变化模块，拿它的清单当全集会把「本次没变的模块」全删掉。
//   2. 只删 .codewiki/modules/*.md —— concepts/、learnings/、decisions/、_architecture.md
//      等横切产物不归模块规划管，一律不碰。
//   3. 只删「本次 modules 清单里没有、且不在本次 job.articles 里」的文件；本次写过但
//      失败的也保留（失败可能是暂时的，不该顺手删证据）。
//   4. 删除失败只记账不中断：写入 job.plan.prunedFailed 并 note，不抛错（一处删不掉
//      不该让整轮编译失败），但也不能像旧实现那样 catch 空块静默吞掉——删不掉的孤儿
//      会一直留在 modules/ 下，事后无从追溯。
export function pruneOrphanModules(job) {
  const removed = []
  const failed = []
  if (job?.kind !== 'full') return { removed, failed, skipped: '非全量编译，跳过孤儿清理' }
  const modules = job.plan?.modules
  if (!Array.isArray(modules) || !modules.length) return { removed, failed, skipped: '无完整模块清单，跳过孤儿清理' }
  const dir = path.join(job.wikiPath, 'modules')
  if (!fs.existsSync(dir)) return { removed, failed }
  // 本次规划出的模块文章名（与组装任务的 slugify 规则保持一致）
  const planned = new Set(modules.map((m) => `${slugify(m.name)}.md`))
  // 本次 job 写过的（含失败）也保留：失败不该顺手删证据
  const touched = new Set((job.articles ?? []).map((a) => path.basename(String(a.name ?? ''))))
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return { removed, failed } }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    if (planned.has(name) || touched.has(name)) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch (err) {
      failed.push(`${name}（${String(err?.code ?? err?.message ?? err)}）`)
    }
  }
  return { removed, failed }
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
// 路径身份 key：去尾分隔符 + 归一化；只在 win32 折叠大小写。
// 旧实现无条件 toLowerCase，在 Linux/macOS 上会把 /home/u/Foo 与 /home/u/foo 两个
// 不同仓库认成同一个——幂等判定会把其中一条任务的提交吞掉，仓库清单也会少登记一个。
const normPathKey = (p) => {
  const n = path.normalize(String(p ?? '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}
// 仓库总览该显示哪个任务：活动中的优先，其次按更新时间取最新。
//
// 旧实现是「先到者胜」（`if (!lastByCwd.get(k)) set(...)`），而 service.list() 按提交顺序
// 返回，于是同仓有多个任务时永远显示最旧的那个。真机 2026-11-02 就出现过：五个仓库明明
// 刚被自动调度拉起来在跑，面板总览却齐刷刷标着「失败」（三小时前那批 env 阶段失败的旧任务）。
// 「上次编译」这个位置要回答的是「这个仓库现在怎么样了」，所以活动任务优先，其次最新。
export function pickOverviewJob(jobs) {
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.id)
  if (!list.length) return null
  const active = list.filter((j) => !TERMINAL.has(j.stage))
  const pool = active.length ? active : list
  const stamp = (j) => String(j.updatedAt ?? j.finishedAt ?? j.createdAt ?? '')
  return pool.reduce((best, j) => (stamp(j) > stamp(best) ? j : best))
}
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
// 带缓存：autoScan 每轮对每个历史仓库调用，大仓库文件树遍历不该每分钟重跑。
// 「有源码」是稳定事实，缓存 10 分钟；「无源码」不是——它可能只是刚 checkout 完的空窗、
// 编译中途的清理、换分支的瞬间。旧实现把 false 也缓存 10 分钟，且清缓存只发生在手动路径，
// 自动调度一旦某轮误判成空壳，就会连续 10 分钟静默跳过该仓库（用户补回源码也照样不编译）。
const SOURCE_PROBE_TTL_MS = 10 * 60 * 1000
const SOURCE_PROBE_EMPTY_TTL_MS = Math.max(0, Number(process.env.DSH_CODEWIKI_SOURCE_PROBE_EMPTY_TTL_MS) || 60 * 1000)
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
  if (hit) {
    const ttl = hit.has ? SOURCE_PROBE_TTL_MS : SOURCE_PROBE_EMPTY_TTL_MS
    if (now - hit.at < ttl) return hit.has
  }
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
// 只为把单请求输入装进模型上下文（见 BATCH_TOKEN_BUDGET），不需要精确分词器。
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

// 文章在 wiki 内的相对路径（modules/core.md 形态）：契约闸门要靠它推断文章类型
// （type 与目录不匹配会让 cw index 分类错乱）。传进来的可能是绝对路径。
function wikiRelOf(articlePath) {
  const norm = String(articlePath ?? '').replace(/\\/g, '/')
  for (const dir of ['modules', 'concepts', 'learnings', 'decisions', 'patterns', 'queries']) {
    const i = norm.lastIndexOf(`/${dir}/`)
    if (i >= 0) return norm.slice(i + 1)
  }
  return norm.slice(norm.lastIndexOf('/') + 1)
}

// 统一文章契约闸门（吸收自 FSoft 的文章质量门）：所有写盘点都过这里，不再各查一段。
// 拒写判据只看 error 级——结构已破坏（重复 frontmatter/正文、围栏未闭合、source_files
// 不存在或不是本次读取的证据、死链、正文空、必需章节空着）；warning 级（缺章节）放行
// 但记账，由终态判定把本次编译降为 partial，不推进基线。
// 返回 { blocking:[], warnings:[] }。
function contractCheck(content, { articlePath, cwd, sources, allowedLinks }) {
  const issues = inspectArticle(content, {
    cwd: cwd ?? null,
    articlePath: wikiRelOf(articlePath),
    readableSources: Array.isArray(sources) && sources.length ? sources : null,
    allowedLinks: Array.isArray(allowedLinks) ? allowedLinks : null,
    fsImpl: { exists: (p) => { try { return fs.existsSync(p) } catch { return false } } },
  })
  return {
    issues,
    blocking: issues.filter((i) => (i.severity ?? 'error') === 'error'),
    warnings: issues.filter((i) => (i.severity ?? 'error') !== 'error'),
  }
}

// 允许的内部链接目标：现存 wiki 文章 + 本轮计划产出的文章，取相对路径与裸名两种形态
// （交叉链接习惯写 `[[模块名|标题]]`，裸名必须能解析到 modules/模块名.md）。
function allowedLinkTargets(job) {
  const out = new Set()
  const add = (rel) => {
    const r = String(rel ?? '').replace(/\\/g, '/')
    if (!r) return
    out.add(r)
    const bare = r.replace(/\.md$/, '')
    out.add(bare)
    out.add(path.posix.basename(bare))
  }
  const walk = (dir, prefix) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`)
      else if (e.name.endsWith('.md')) add(`${prefix}${e.name}`)
    }
  }
  if (job.wikiPath) walk(job.wikiPath, '')
  for (const n of job.expectedNames ?? []) add(n)
  for (const a of job.articles ?? []) if (a.name) add(a.name)
  return [...out]
}

// 任务结果统一出口：keepInMemory 任务（校对）把 content 带回内存由服务侧消费，
// 文章任务直接落盘。普通任务与超大任务兜底共用。
function applyTaskResult(task, content, notes) {
  if (task.keepInMemory) return { name: task.name, ok: true, stopReason: 'completed', content }
  // 统一契约闸门（0.14.0）：坏文章不落盘。旧实现只查 frontmatter 开合，重复 frontmatter、
  // 空章节、指向不存在文件的 source_files 全都能写进 wiki，随后被 cw index 收进索引。
  const chk = contractCheck(content, {
    articlePath: task.articlePath, cwd: task.cwd ?? null, sources: task.sources,
    allowedLinks: task.allowedLinks,
  })
  if (chk.blocking.length) {
    notes.push(`文章 ${task.name} 未过契约闸门，不落盘 —— ${chk.blocking.slice(0, 3).map((i) => i.detail).join('；')}`)
    return { name: task.name, ok: false, stopReason: 'contract', contractIssues: chk.issues }
  }
  try {
    fs.mkdirSync(path.dirname(task.articlePath), { recursive: true })
    const fx = fixAnchors(content, task.cwd ?? null)
    if (fx.fixed > 0) notes.push(`文章 ${task.name} 自动修正 ${fx.fixed} 处行号锚点`)
    if (fx.unresolved.length) notes.push(`文章 ${task.name} 行号锚点存疑（未改）：${fx.unresolved.slice(0, 3).join('；')}${fx.unresolved.length > 3 ? ' 等' : ''}`)
    fs.writeFileSync(task.articlePath, fx.text, 'utf8')
    return { name: task.name, ok: true, stopReason: 'completed', contractIssues: chk.issues }
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

// 单个请求的输入 token 预算：默认模型 glm-5.3-flash 上下文 512k，单请求输出上限 64k，
// 输入侧留 128k 为兼容档（hy3 时代的窗口）；再扣输出与估算误差余量，取 110k。
const BATCH_TOKEN_BUDGET = 110000
// 超预算兜底装填上限：单文件/单任务装不进 110k 时按该大档再装一次；
// 仍装不下才落到会话通道（最后的兜底，见 dispatchSessionTasks）。
// 上限取 128k：即使回归到 192k 窗口的模型（输入+输出共享），
// 128k 输入 + 64k 输出仍在界内（旧值 150k 输入 + 64k 输出 = 214k，已越界）。
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
// CHANGELOG.md 是**追加式流水账**：每次发版在顶部插入一节，于是所有指向它的行号
// 都必然单向漂移（0.13.2 那节今天在第 58 行，下个版本发布后就在第 80 行）。
// 符号定位对这类锚点完全无效——CHANGELOG 里没有可声明的符号，而 fixAnchors 的符号分支
// 遇到「行内无反引号符号」直接 return line，连尝试都不做。但这批锚点几乎都写了版本号
// （`0.13.0（CHANGELOG.md:109）`），而版本标题 `## 0.13.0` 是**稳定锚**。
// 重定位规则：同一版本 V 被引用的所有失效锚点里，取最小行号 Hmin 当作「写作时该节首的
// 估计」，新行号 = 当前节首 S + (n - Hmin)。**必须保留这个相对偏移**——若一律改写成
// 节首 S，`CHANGELOG.md:8` 与 `CHANGELOG.md:10` 会双双变成 `S`（拉平，正是 0.13.5
// 修过的数据破坏）。无版本号的 CHANGELOG 锚点无从定位，只记 unresolved 不动。
export function changelogSections(clLines) {
  const secs = []
  clLines.forEach((l, i) => {
    const m = l.match(/^##\s+(\d+\.\d+(?:\.\d+)*)/)
    if (m) secs.push({ ver: m[1], start: i + 1, end: clLines.length })
  })
  for (let i = 0; i < secs.length - 1; i++) secs[i].end = secs[i + 1].start - 1
  return secs
}

export function fixChangelogAnchors(content, cwd) {
  const unresolved = []
  const anchorRe = /CHANGELOG\.md[:：](\d+)(?:-(\d+))?/g
  if (!cwd || !content.includes('CHANGELOG.md')) return { text: content, fixed: 0, unresolved }
  let clLines
  try { clLines = fs.readFileSync(path.join(cwd, 'CHANGELOG.md'), 'utf8').split(/\r?\n/) } catch {
    return { text: content, fixed: 0, unresolved }
  }
  const secs = changelogSections(clLines)
  if (!secs.length) return { text: content, fixed: 0, unresolved }
  const secOf = (v) => secs.find((s) => s.ver === v)
  // 「已正确」判定不能只看「行号存在且非空」：CHANGELOG 每次发版顶部插新节，
  // 于是 `CHANGELOG.md:109` 这类旧锚点今天必然仍在文件范围内、落在**别的版本节**里，
  // 且大多非空——只按范围判会把它们全判为正确，重定位永远不触发（实测 34 条里
  // 只有 6 条被认出失效，其余 28 条都被这种「技术有效」蒙过）。
  // 正确语义：带版本号的锚点必须落在**该版本对应的节内**；不带版本号的才退回范围判定。
  const isValid = (n, end, ver) => {
    const sec = ver ? secOf(ver) : null
    if (sec) {
      return n >= sec.start && n <= sec.end && (clLines[n - 1] ?? '').trim().length > 0 &&
        (end === null || (end >= n && end <= sec.end))
    }
    return n >= 1 && n <= clLines.length && (clLines[n - 1] ?? '').trim().length > 0 &&
      (end === null || (end >= n && end <= clLines.length))
  }

  // 版本号归属：取锚点**左侧最近的版本号**（中文习惯「0.13.0 …（CHANGELOG.md:58）」）。
  //
  // 这条判据必须与 test-wiki-anchors.mjs 的 CHANGELOG 语义校验**完全同源**，
  // 否则修正器与校验器各用一套归属规则，就会出现「修正器认为已对、校验器判错」
  // 的死循环。曾试过两种偏离，都失败：
  // ① 只认「同一括号内」的版本号——实测大量长段落里版本号在括号外
  //    （「0.13.0 吸收……四个配置（index.js:79-82，默认全开，CHANGELOG.md:58）」），
  //    括号内无版本号 → 判为「归属不明」跳过 → 44 条永远修不掉；
  // ② 括号内优先、否则退回整行——归属会随锚点数字变化而翻转，来回振荡。
  // 真正导致振荡的是 reloc 的 Map key 用锚点文本（同行重复文本互相覆盖，见下），
  // 改用行内序号后，这个朴素判据就稳定收敛了（实测 2 轮收敛）。
  const verOf = (line, at) => {
    let ver = null
    for (const m of line.matchAll(/\b(\d+\.\d+(?:\.\d+)*)\b/g)) {
      if (!secOf(m[1]) || m.index >= at) continue
      ver = m[1]
    }
    return ver
  }

  // 第一遍：收**本行全部**带版本号的锚点（不只是失效的）——基准必须由整行决定，
  // 否则修好一部分后基准跟着变，第二次运行又会算出不同的偏移（实测不幂等：第二次
  // 仍有 11 处被改写）。失效项与有效项一起参与行内 Hmin 计算，改写时跳过已有效的。
  // ord = 该行内第几个 CHANGELOG 锚点（0 起）。用文本当 key 会出问题：实测同一行里常
  // 出现两个**文本完全相同**的 `CHANGELOG.md:256`（分别属于 0.10.9 与 0.10.11 两个版本
  // 子句），Map key 重复 → 后一个覆盖前一个 → 本该保持的有效锚点也被改成别人的行号，
  // 下一轮又判失效改回来，无限振荡。行内序号是唯一能区分它们的坐标。
  const items = []
  content.split(/\r?\n/).forEach((line, i) => {
    let ord = 0
    for (const a of line.matchAll(anchorRe)) {
      const n = Number(a[1]), end = a[2] ? Number(a[2]) : null
      const ver = verOf(line, a.index)
      items.push({ idx: i, ord: ord++, n, end, ver, whole: a[0], valid: isValid(n, end, ver) })
    }
  })
  if (!items.some((it) => !it.valid)) return { text: content, fixed: 0, unresolved }

  // Hmin 必须**按行内聚合**，不能全仓按版本取最小。跨行取最小会引入假偏移：
  // 同一篇里 `:42` 引用 0.10.11 的 3-15、`:24` 又引用 0.10.11 的 8，全局 Hmin=3
  // 于是 8 被算成「节首+5」，而 261（原本就是历史错锚点）会被算成「节首+258」直接越界。
  // 只有**同一行内**的并列引用才有确定可推的相对关系（同一句话描述同一节的几处），
  // 跨行各自独立引用时唯一安全的落点就是节首。
  //
  // 幂等的关键：基准必须由**该行该版本的全部锚点**（有效 + 失效）决定，不能只统计失效项。
  // 只统计失效项会振荡——实测 `?:58→113`、下一轮 `113→58` 无限来回：第一轮把 58 改成 113，
  // 于是 113 变成「有效」退出统计集，基准随之从 58 变 113，又把它算回 58。
  // 用全集算基准则位移量恒定：整组同移 delta 后基准同步前移，第二轮算出 delta=0，自然收敛。
  const rowHmin = new Map()
  for (const it of items) {
    if (!it.ver) continue
    const k = `${it.idx}|${it.ver}`
    rowHmin.set(k, Math.min(rowHmin.get(k) ?? Infinity, it.n))
  }
  const reloc = new Map()
  for (const it of items) {
    if (it.valid) continue // 已在该版本节内的不动
    const sec = it.ver ? secOf(it.ver) : null
    if (!sec) { unresolved.push(`CHANGELOG.md:${it.n} 版本归属不明未改`); continue }
    const key = `${it.idx}|${it.ver}`
    const base = rowHmin.get(key) ?? it.n
    const nn = sec.start + (it.n - base)
    const span = it.end === null ? 0 : Math.abs(it.end - it.n)
    const ne = Math.min(nn + span, sec.end)
    if (nn < sec.start || nn > sec.end || !(clLines[nn - 1] ?? '').trim() || ne > sec.end) {
      unresolved.push(`CHANGELOG.md:${it.n} 版本 ${it.ver} 重定位越界未改`)
      continue
    }
    reloc.set(`${it.idx}|${it.ord}`, { nn, ne: span ? ne : null })
  }
  if (!reloc.size) return { text: content, fixed: 0, unresolved }

  const crlf = /\r\n/.test(content)
  let fixed = 0
  const text = content.split(/\r?\n/).map((line, i) => {
    let cursor = 0
    const out = []
    let ord = 0
    for (const a of line.matchAll(anchorRe)) {
      const r = reloc.get(`${i}|${ord++}`)
      out.push(line.slice(cursor, a.index))
      cursor = a.index + a[0].length
      if (!r) { out.push(a[0]); continue }
      fixed += 1
      out.push(`CHANGELOG.md:${r.nn}${r.ne ? `-${r.ne}` : ''}`)
    }
    out.push(line.slice(cursor))
    return out.length > 1 ? out.join('') : line
  }).join(crlf ? '\r\n' : '\n')
  return { text, fixed, unresolved }
}

// 修复 frontmatter 未闭合（闭合 `---` 被写成空行、或在生成时被吃掉）。
//
// 三条判据同时满足才动手，避免误伤普通文章：
// ① 首行恰好是 `---`；② 紧随其后至少一行**无缩进**的 `key: value` 元数据
// （`title:` / `type:` / `source_files:` / `tags:` 这类）；③ 元数据块之后紧跟
// 一个空行（原闭合符应出现的位置）。命中就把那个空行改写成 `---`。
// 正文里的 `---` 分隔线、以及通篇没有元数据的普通 md 都不满足 ② 或 ③。
export function repairUnclosedFrontmatter(content) {
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return null
  const metaRe = /^[A-Za-z_][\w-]*:/
  let meta = 0
  let i = 1
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (metaRe.test(l)) { meta += 1; continue }
    // 缩进续行（`  - index.js`、多行数组）属于上一行元数据
    if (meta > 0 && /^[ \t]+\S/.test(l)) continue
    break
  }
  if (meta === 0) return null
  if (i >= lines.length || lines[i].trim() !== '') return null
  lines[i] = '---'
  return {
    text: lines.join(/\r\n/.test(content) ? '\r\n' : '\n'),
    note: `frontmatter 未闭合已补全（第 ${i + 1} 行）`,
  }
}

export function fixAnchors(content, cwd) {
  const unresolved = []
  // frontmatter 未闭合的文章必须在这里就识别出来：`^---\r?\n([\s\S]*?)\r?\n---`
  // 匹配不上时整篇所有锚点都会被静默跳过（下面第一行就 return），而文章照常落盘、
  // 编译照常「成功」——失败完全不可见。实测 `.codewiki/learnings/update-reminder-entry-gap.md`
  // 的闭合 `---` 被写成空行，就这样积了 19 处失效锚点且每轮编译都过。
  // 修复：首个 `---` 之后若在正文开始前存在一段连续 `key: value` 形态的元数据行、
  // 紧接一个空行，就把那个空行改写成 `---`。只在「像 frontmatter 但没闭合」时动手，
  // 普通文章（含正文里的 `---` 分隔线）不受影响。
  let fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) {
    const repaired = repairUnclosedFrontmatter(content)
    if (repaired) {
      content = repaired.text
      fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      unresolved.push(`${repaired.note}`)
    }
  }
  if (!fmMatch || !cwd) return { text: content, fixed: 0, unresolved }
  // CHANGELOG 锚点先单独修：它是流水账，只能按「版本节首 + 相对偏移」重定位，
  // 符号归属那套在这里无解（CHANGELOG 里没有可声明的符号）。也因为它可能在
  // source_files 之外，所以不依赖 srcs 判断。
  const clRes = fixChangelogAnchors(content, cwd)
  content = clRes.text
  unresolved.push(...clRes.unresolved)
  let fixed = clRes.fixed
  const srcs = parseSourceFiles(fmMatch[1])
  if (!srcs.length) return { text: content, fixed, unresolved }
  const resolveFile = (f) => {
    if (srcs.includes(f)) return f
    // source_files 里写的是**模块相对路径**（article 生成时按模块目录拼的
    // `modules/test-suite/index.js`），而文章正文引用的是**仓库根**路径
    // （`index.js:941-954`）。两者 basename 相同 → 按 basename 匹配会把根锚点
    // 映射到不存在的 `modules/test-suite/index.js` → loadSource 返回 null →
    // 整行静默跳过，锚点永远修不掉（实测 test-suite.md 34 行 `localPlan` 与
    // unreminder-entry-gap.md 19 处锚点都这样堆积）。仓库根真实存在的同路径
    // 优先：文档锚点的语义永远是「仓库里的这个文件」，虚拟映射只是文章元数据。
    try {
      if (fs.existsSync(path.join(cwd, f))) return f
    } catch { /* 探测失败按「无此文件」处理 */ }
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
  // 返回 [{sym, at}]：带上反引号符号在行内的字符位置，供锚点就近绑定用。
  // 文件名不算符号（与 test-wiki-anchors.mjs 的 symbolsOnLine 同源）：`package.json`
  // （`package.json:1-28`）这类写法里反引号包的是文件路径，拿它去源文件里搜必然搜不到。
  const FILE_LIKE = /\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|yml|yaml|txt|log|toml|lock|cfg|ini)$/i
  const symbolsWithPos = (line) => {
    const out = []
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const sym = m[1].trim().replace(/\(.*\)$/, '').trim()
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(sym)) continue
      if (sym.length < 3 || sym.split('.').pop().length < 3) continue
      if (FILE_LIKE.test(sym)) continue
      out.push({ sym, at: m.index + 1 + m[1].indexOf(m[1].trim()) })
    }
    return out
  }
  const symbolsOnLine = (line) => symbolsWithPos(line).map((s) => s.sym)
  const hasSym = (srcLine, s) => srcLine.includes(s) || srcLine.includes(s.split('.').pop())
  const bodyStart = fmMatch[0].split(/\r?\n/).length // 正文首行（1-based 行号 ≤ bodyStart 是 frontmatter）
  const crlf = /\r\n/.test(content)
  const lines = content.split(/\r?\n/)
  const anchorRe = /([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g
  const text = lines.map((line, idx) => {
    if (idx + 1 <= bodyStart) return line
    const syms = symbolsWithPos(line)
    if (!syms.length) return line
    const anchors = [...line.matchAll(anchorRe)]
    if (!anchors.length) return line
    // 多锚点行也修，但每个锚点只认**它自己之前**的就近符号（见下方 order 的注释）。
    // 曾用「多锚点行一律跳过」来止血振荡，那是错的：行号漂移恰恰最常发生在这些
    // 并列引用了大量符号的长行上（_patterns.md 一行十几次 index.js:N），跳过等于
    // 让它们永远失效。振荡的真因是「锚点之后的符号也能被选中」，已在那里修掉。
    // 逐锚点定位：一行里有 N 个锚点时必须各自绑定「离它最近的可解析符号」。
    // 旧实现从 syms[0] 起找第一个能解析的符号，命中后把**整行所有锚点**都改成那一个行号，
    // 于是 `A (index.js:11)、B (index.js:22)` 这种并列描述被拉平成 `A (index.js:11)、B (index.js:11)`
    // （本仓 _patterns.md 曾出现同一行 15 处 index.js:49）。宁可不动也不能拉平——
    // 拉平的锚点看起来「都指向非空代码行」，能把校验骗过去，却是更坏的数据。
    const used = new Set()
    const out = []
    let cursor = 0
    for (const a of anchors) {
      const whole = a[0]
      const f = a[1]
      const n1 = a[2]
      const n2 = a[3]
      const atPos = a.index
      out.push(line.slice(cursor, atPos))
      cursor = atPos + whole.length
      const rel = resolveFile(f)
      if (!rel) { out.push(whole); continue }
      // CHANGELOG 锚点已由 fixChangelogAnchors 按版本节重定位过，这里绝不能再交给符号
      // 归属逻辑处理——CHANGELOG 里没有可声明的符号，落进来只可能被误改或重复计数。
      if (rel === 'CHANGELOG.md') { out.push(whole); continue }
      const src = loadSource(rel)
      if (!src) { out.push(whole); continue }
      const start = Number(n1)
      const at = `${rel}:${start}${n2 ? `-${n2}` : ''}`
      // 符号在源文件里的唯一归属行。返回 {line} 唯一归属 / {ambiguous:true} 多处出现
      // 且无唯一声明行 / {} 未出现。归属规则：「只出现一次」即以该行为准；出现多次时
      // 只认唯一的声明形态（function/class 直接跟符号；const/let 要求符号后跟 =，
      // 排除 `const gamma = beta()` 这种「别的符号的声明」）。
      // 「已正确」判定与「修正」共用同一个归属函数，两者否则会各说各话——见下面的注释。
      const locate = (s) => {
        const hits = []
        src.forEach((l, i) => { if (hasSym(l, s)) hits.push(i + 1) })
        if (hits.length === 0) return {}
        if (hits.length === 1) return { line: hits[0] }
        const tail = s.split('.').pop().replace(/[$]/g, '\\$')
        const defRe = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function|class)\\s+${tail}\\b|^[ \\t]*(?:export\\s+)?(?:const|let)\\s+${tail}\\s*=`)
        const defs = hits.filter((n) => defRe.test(src[n - 1]))
        if (defs.length === 1) return { line: defs[0] }
        // 跨文件符号（本仓 lib/*.js 或第三方）在本文件里没有声明行，只有 import/require
        // 与使用处。此时文档锚点指的必然是**使用处**，import 行不是它要引用的实现位置。
        // 排除 import/require 行后若只剩唯一一处就取它——`clusterComponents` 在
        // `index.js` 只有 import（17）与调用（1226）两处，不排除则永远 ambiguous、
        // 锚点永远修不掉（实测 `_architecture.md:74` 稳定报「符号歧义未改」）。
        const importRe = /^[ \t]*(?:import\b|(?:const|let|var)\s[^=]*=\s*require\s*\()/
        const uses = hits.filter((n) => !importRe.test(src[n - 1]))
        if (uses.length === 1) return { line: uses[0] }
        return { ambiguous: true }
      }
      // 按与锚点的字符距离由近到远排序；已被前面的锚点占用的符号跳过。
      //
      // 但只在**锚点之前**的符号里选：中文行文的锚注写在「符号（锚点）」的括号里，
      // 锚点**之后**出现的符号属于后文，不可能拥有这个锚点。曾经不设此约束，纯按
      // 字符距离排，实测 `- \`articleMd(...)\`（test-orchestration.mjs:33-35）：…用
      // \`makeBatchMock\` 生成…` 这行里，后文的 makeBatchMock（距 39）比主符号
      // articleMd（距 40）只近 1 个字符就被选中，锚点被改到 145-147；下一轮行内
      // 文本已变、距离关系翻转，又改回 33-35——无限来回、永不收敛（实测 5 轮不收敛）。
      // 锚点之前没有符号时（「（index.js:11）见 \`foo\`」这类倒装写法）退回全部候选，
      // 保持旧行为不变。
      const free = syms.filter((s) => !used.has(`${rel}|${s.sym}`))
      const leading = free.filter((s) => s.at < atPos)
      const order = (leading.length ? leading : free)
        .sort((p, q) => Math.abs(p.at - atPos) - Math.abs(q.at - atPos))
      // 「已正确」快路径：锚点起始行提到了「离它最近、尚未被占用」的符号即认可。
      // 防拉平靠的是 used 占用 + 就近排序，**不是**「符号在全文有唯一声明行」——
      // 旧实现对多锚点行要求 `locate(sym).line === start`，而 locate 在符号多处出现
      // 时返回 ambiguous（大量符号在文件里被引用多次），于是**本来正确的锚点被判为错**、
      // 再被拿去改成别的行：实测因此引入 35 行真回归（例 `client.js:489` 与
      // `client.js:495` 各自正确且指向不同行，修后都变成 495）。单锚点行一直用宽松
      // 判定、从无此问题；多锚点行同样宽松即安全，因为每个符号只允许被一个锚点认领。
      const nearest = order[0]
      // 区间锚点的语义是「这段代码」（`index.js:1018-1045` 指整块），不是首行：
      // 符号只要出现在区间内任何一行就算对上。校验器 test-wiki-anchors.mjs 正是这么
      // 判的（`span.includes(sym) || span.includes(tail)` 在整段上搜）。修正器若不认，
      // 就会把**校验器认可的正确锚点**判成错、再拿去重定位，实测 `_patterns.md:73`
      // 的 `plan`（区间内多次出现但全文 42 处、无唯一声明行 → locate 返回 ambiguous）
      // 每轮被记成「符号歧义未改」，永远留着不动而校验器一直报错。
      if (n2) {
        const end2 = Number(n2)
        const span = src.slice(start - 1, Math.min(end2, src.length)).join('\n')
        const hit = order.find((s) => span.includes(s.sym) || span.includes(s.sym.split('.').pop()))
        // 终点越界（`a.js:1-99` 而文件只有 5 行）不能走「已正确」快路径：上面判断区间时
        // 用 Math.min 把终点截到文件尾，于是符号「必然」落在区间内、锚点被原样放行，
        // 而校验器 test-wiki-anchors.mjs 会一直报「区间终点在行数范围内」失败——这个锚点
        // 就永远修不掉了。交给下面的重定位分支，它会按跨度把尾行钳到 src.length。
        if (hit && start >= 1 && end2 <= src.length) {
          used.add(`${rel}|${hit.sym}`)
          out.push(whole)
          continue
        }
      }
      if (src[start - 1] && nearest && hasSym(src[start - 1], nearest.sym)) {
        used.add(`${rel}|${nearest.sym}`)
        out.push(whole)
        continue
      }
      let R = null
      let picked = null
      let ambiguous = false
      for (const cand of order) {
        // 点分符号（如 Config.articleLanguage）歧义时退试首段——首段才是可声明的部分
        const variants = cand.sym.includes('.') ? [cand.sym, cand.sym.split('.')[0]] : [cand.sym]
        for (const s of variants) {
          const loc = locate(s)
          if (loc.line !== undefined) { R = loc.line; picked = cand.sym; break }
          if (loc.ambiguous) ambiguous = true // 试下一个候选
        }
        if (R !== null) break
      }
      if (R === null) {
        unresolved.push(`${at} ${ambiguous ? '符号歧义' : '符号未找到'}未改`)
        out.push(whole)
        continue
      }
      used.add(`${rel}|${picked}`)
      if (n2) {
        const end2 = Number(n2)
        // 原文区间可能本身就是倒序（如 `index.js:902-901`，作者手误或前后行号写反）。
        // 旧实现用 `R + (end2 - start)` 平移尾行，倒序时算出 R-1 → 产出 `902-901` 这种
        // 起点大于终点的区间，校验必然报「区间起止有序」失败，且每轮编译都修不掉。
        // 这里把倒序区间按「原文长度」翻正：先求区间跨度的绝对值，再保证终点 >= 起点。
        const span = Math.abs(end2 - start)
        const tail = Math.min(R + span, src.length)
        fixed += 1
        out.push(`${f}:${R}-${Math.max(R, tail)}`) // 区间尾越界钳到文件尾（修正起点是净改善）
      } else {
        fixed += 1
        out.push(`${f}:${R}`)
      }
    }
    out.push(line.slice(cursor))
    return out.join('')
  }).join(crlf ? '\r\n' : '\n') // 混合行尾按整文主风格规范化
  return { text, fixed, unresolved }
}

// 文章信封校验：模型输出必须是一段 frontmatter（开头 --- 与结束 --- 成对）加正文。
// 返回 null 表示合格，否则返回给 note 用的原因短语。
// 只查开头不查闭合会放过半截 frontmatter 的文章：它们能落盘，但 fixAnchors 的
// /^---\n([\s\S]*?)\n---/ 匹配不上，于是**整篇的行号锚点一次都不会被校正**——实测
// .codewiki/learnings/update-reminder-entry-gap.md 就这样积了 19 处失效锚点，而且
// 每次编译都「成功」，失败完全不可见。抽成导出函数是为了让它可被单测直接钉住
// （此前这段只藏在 writeValidated 里，只能靠整轮 orchestration 间接覆盖）。
export function validateArticleEnvelope(content) {
  if (typeof content !== 'string' || !content.trimStart().startsWith('---')) return '模型输出缺 frontmatter'
  // 结束标记必须**独占一行**：`---(?:\r?\n|$)` 而不是裸 `---`。否则正文里
  // 「--- 出现在某一行的行首」（分隔线带说明、列表项下的横线）会被当成 frontmatter
  // 闭合，把真正缺失的结束 --- 放过去——那正是这条闸门要挡的那类静默失效。
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content.trimStart())) return 'frontmatter 未闭合（缺结束 ---）'
  return null
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

// 本地规划：按顶层目录分组生成模块清单（0.10.7 起是唯一规划路径——模型勘探的单独
// 规划阶段已删，编译模型上下文足够大，模块划分不再值得一次独立请求）。
// 宁可粗也不中断整条流水线。
// 0.16.0 阶段 7 受控退役：原生引擎（默认通道）自带 AST 符号提取 + 语义聚类，
// localPlan 只服务 nativeEngine=false 的兼容通道。
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

// 文章格式条款：agentic 通道（读代码 → edit_article）与横切 prompt 共用。
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

// 编译基线（cw 写在 .codewiki/_meta.yaml:last_compiled_commit）。
// 变更采集以它为 base：baseline..HEAD 的已提交变更 + 工作区未提交变更合起来才是
// 「自上次编译以来代码发生了什么」。读不到就返回 null，由 collectChangeSet 明确
// 退回 full（不假装 clean）。
function readCompiledBaseline(wikiPath) {
  try {
    const raw = fs.readFileSync(path.join(wikiPath, '_meta.yaml'), 'utf8')
    const m = raw.match(/^last_compiled_commit:\s*(\S+)\s*$/m)
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null
  } catch {
    return null
  }
}

// wiki 现存文章清单（增量规划的 ownership 输入）：name 是 wiki 内相对路径，
// sources 是 frontmatter 的 source_files。读不出来的文章照样列出（sources=[]），
// 由 planner 判成 review——「缺 source_files 无法判定归属」必须显式暴露，不能静默略过。
// 根级文章（_architecture.md / _patterns.md 等）同样带 frontmatter 与 source_files，
// 漏掉它们会让这些文章的源码变更变成「无人认领」（实际踩过：_architecture.md 声明
// core/core.py，只扫子目录时增量规划只写了 1 篇而不是 2 篇）。
// _index.md 是导航清单（无 frontmatter），不是文章，跳过。
const ARTICLE_DIRS = ['modules', 'concepts', 'learnings', 'decisions', 'patterns']
const ROOT_ARTICLE_SKIP = new Set(['_index.md', 'CodeWiki.md'])
function collectWikiArticles(wikiPath) {
  const out = []
  const readArticle = (rel, full) => {
    let content = ''
    try { content = fs.readFileSync(full, 'utf8') } catch { content = '' }
    out.push({ name: rel, articlePath: full, sources: readSourceFiles(full), content })
  }
  // 根级文章先收（_architecture.md 这类横切文章的 source_files 覆盖面最广）
  let rootEnts = []
  try { rootEnts = fs.readdirSync(wikiPath, { withFileTypes: true }) } catch { rootEnts = [] }
  for (const e of rootEnts.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith('.md') || ROOT_ARTICLE_SKIP.has(e.name)) continue
    const full = path.join(wikiPath, e.name)
    let head = ''
    try { head = fs.readFileSync(full, 'utf8').slice(0, 4) } catch { continue }
    if (head.trimStart().startsWith('---')) readArticle(e.name, full)
  }
  const walk = (dir, prefix) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), `${prefix}${e.name}/`); continue }
      if (!e.name.endsWith('.md')) continue
      readArticle(`${prefix}${e.name}`, path.join(dir, e.name))
    }
  }
  for (const d of ARTICLE_DIRS) walk(path.join(wikiPath, d), `${d}/`)
  return out
}

// 存量文章体检（吸收自 FSoft 的文章质量门 + 本仓审计结论）：cw index 会把 .codewiki/
// 下所有 .md 收进索引，包括历史遗留的坏文章——重复 frontmatter、必需章节空着、
// source_files 指向早已删除的临时文件。这些文章不是本次编译写出来的，但它们在库里
// 就是「坏文章已入库」，只体检新写的文章等于假装存量干净。
// 返回 [{name, issue}]，交给 judgeOutcome 当 quality 阻塞（终态降 partial、基线不推进）。
// 只查 error 级结构破坏；warning 级（缺非必需章节）不列，避免历史文章把所有编译都拖成 partial。
function auditExistingArticles(wikiPath, cwd) {
  const out = []
  for (const a of collectWikiArticles(wikiPath)) {
    let chk
    try {
      chk = contractCheck(a.content, { articlePath: a.articlePath, cwd: cwd ?? null, sources: null })
    } catch { continue }
    if (!chk.blocking.length) continue
    out.push({ name: a.name, issue: `存量文章未过契约：${chk.blocking.slice(0, 2).map((i) => i.detail).join('；')}` })
  }
  return out
}

// 内部链接目标是否存在（stale scan 用）：`[[name]]` 与 `[x](rel.md)` 都要能解析到
// 现存文章或本轮计划产出的文章。裸名先按 modules/ 猜，再按全库裸名匹配。
function makeLinkExists(wikiPath, extraNames = []) {
  const known = new Set()
  const add = (rel) => {
    const r = String(rel ?? '').replace(/\\/g, '/')
    if (!r) return
    known.add(r)
    const bare = r.replace(/\.md$/, '')
    known.add(bare)
    known.add(path.posix.basename(bare))
  }
  for (const a of collectWikiArticles(wikiPath)) add(a.name)
  for (const n of extraNames) add(n)
  return (target) => {
    const t = String(target ?? '').replace(/\\/g, '/').replace(/\.md$/, '')
    if (!t) return false
    if (known.has(t)) return true
    const bare = path.posix.basename(t)
    return known.has(bare) || known.has(`modules/${bare}`)
  }
}

// 注：0.16.0 阶段 7 起本仓不再有增量 planner，job.updatePlan 恒为 null；终态判定改由 judgeOutcome 的 expectedNames 通道承担（见 lib/update-record.js）。
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
//   full   = articles → crosscut → review → index（0.10.7 删规划阶段，0.17.5 删合成阶段）
//   stale  = articles（任务在提交时预构建）→ review → index
// 全部模型调用都是单轮文本生成，统一走插件内后台并发池（默认 volces-ark/glm-5.3-flash）；单文件超
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
// 原生通道的「更新记录」记账目录（仓库外）：落地器已在内部提交，记录只能在结果出来后
// 才写得成，写进 .codewiki/ 就成了提交之后的未跟踪文件（每轮都脏工作区）。
const NATIVE_RECORD_DIR = path.join(os.tmpdir(), 'dsh-codewiki-native-records')
const nativeRecordDir = () => process.env.DSH_CODEWIKI_NATIVE_RECORD_DIR || NATIVE_RECORD_DIR
// 引擎原始 docs 树的留档根（仓库外）：引擎产物接着会被映射、改写、裁剪，被消费掉的
// 那棵树就再也回不来了。设计文档 L20 要求「保留 FSoft 输出原始树作为事实来源」，
// 所以在消费之前拷一份到这里，按 jobId 分目录。它是**证据**不是产物：不进 .codewiki/
// （否则 cw index 会把它收成第二套文章）、不进仓库（否则污染 git 状态）。
// 同一 job 重跑会覆盖同名目录（幂等）；目录生命周期由操作系统的临时目录清理兜底。
const NATIVE_RAW_TREE_DIR = path.join(os.tmpdir(), 'dsh-codewiki-native-raw')
const nativeRawTreeDir = () => process.env.DSH_CODEWIKI_NATIVE_RAW_TREE_DIR || NATIVE_RAW_TREE_DIR

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
// 进行中任务（0.17.5）：会话页原本只读「LLM 请求记录」，而记录只在真的发出请求后才存在——
// 正在跑依赖图/聚类/落盘、或本轮无需写文章（增量直接命中）的任务在会话页完全不可见：
// 面板任务页显示它在动，会话页却只有一堆旧记录。这里把仍在跑的任务本身也列出来，
// requests 给出「已发几个请求」（0 表示此刻还没发），前端据此区分「进行中」与「尚未发请求」。
// 纯函数、jobs 由调用方传入：与端点解耦，才能直接钉住排序与字段契约。
export function activeSessionJobs(jobs, { requestCount = () => 0, isTerminal = (stage) => TERMINAL.has(stage) } = {}) {
  const out = []
  for (const j of jobs ?? []) {
    if (!j?.id || isTerminal(j.stage)) continue
    out.push({
      jobId: j.id,
      cwd: j.cwd ?? '',
      stage: j.stage,
      nativeStage: j.nativeStage ?? null,
      nativePercent: j.nativePercent ?? null,
      kind: j.kind ?? null,
      auto: j.auto === true,
      startedAt: j.createdAt ?? j.stageStartedAt ?? null,
      writtenCount: j.writtenCount ?? 0,
      batchProgress: j.batchProgress ?? null,
      requests: requestCount(j.id) ?? 0,
    })
  }
  // 最新开始的排最前：面板首屏就是「现在在跑什么」
  out.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
  return out
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
// 开始记录一个请求：写 meta（status:running）+ full（prompt 全文），返回句柄给并发池回调。
// 导出供测试直接驱动（与 estimateTokens / classifySessionTask 同一理由：并发池与桥两条
// 调用路径都要喂它同一套字段，只有能直连测，才能锁住「桥传的 task 与这里读的字段一致」）。
export function beginSessionRecord(job, task) {
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
//
// 落点必须**跟随 JOBS_FILE 的名字**，不能只跟随它的目录：各测试套件都把 JOBS_FILE 指向
// `dsh-codewiki-jobs-test-<pid>-<token>.json` 做隔离，而 dirname 仍是系统临时目录——只按
// 目录推导时，测试写出的清单与真实宿主的 `dsh-codewiki-repos.json` 是同一个文件，跑一次
// 测试就会把 fixture 路径（如 %TEMP%/cw-orch-xxxxxx）塞进宿主的已知仓库清单，自动调度随后
// 每轮都会去扫那些早已删除的目录（0.16.6 修复，真机见过宿主清单里躺着已删的 cw-orch-*）。
// 命名规则：把 JOBS_FILE 基名里的 `-jobs` 段换成 `-repos`，默认形态
// `dsh-codewiki-jobs.json` 仍推导出 `dsh-codewiki-repos.json`（保持旧清单兼容）；
// 显式 DSH_CODEWIKI_REPOS_FILE 永远最优先。
export function reposFileFor(jobsFile, explicit = null) {
  if (explicit) return explicit
  const dir = path.dirname(jobsFile)
  const base = path.basename(jobsFile)
  const renamed = base.includes('-jobs') ? base.replace('-jobs', '-repos') : `${base}.repos`
  return path.join(dir, renamed)
}
export const REPOS_FILE = reposFileFor(JOBS_FILE, process.env.DSH_CODEWIKI_REPOS_FILE || null)
function loadKnownRepos() {
  try { return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'))?.repos ?? [] } catch { return [] }
}
function rememberRepo(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return
  const list = loadKnownRepos()
  if (list.some((p) => normPathKey(p) === normPathKey(dir))) return
  list.push(dir)
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: list }, null, 2), 'utf8') } catch { /* 不可写则放弃 */ }
}
// 反登记（1.2.1）：worktree 目录与彻底空掉的目录不该占着仓库总览——一次性从已知仓库清单里摘掉。
// 只改 REPOS_FILE（插件自己的登记），不碰用户磁盘上的任何目录。
export function forgetRepo(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return false
  const key = normPathKey(dir)
  const list = loadKnownRepos()
  const kept = list.filter((p) => normPathKey(p) !== key)
  if (kept.length === list.length) return false
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: kept }, null, 2), 'utf8') } catch { return false }
  return true
}
// 终态集合（0.14.0 起新增 partial）：partial 表示「部分完成」——写成的文章可以入库，
// 但计划内必需文章没全成功、或有变更没归属、或质量闸门没过，因此**不得推进编译基线**。
// 旧实现只有 done/failed/cancelled，且只要 writtenCount>0 就 done，1 篇成功 + 19 篇失败
// 也报「已完成」，基线照推——未消化的变化从此永远不被再看一眼。
const JOB_TERMINAL = TERMINAL

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
// 0.16.0 阶段 7 受控退役：lib/symbols.js 已删，本函数随之删除。符号级增量能力
// 由原生引擎（默认通道）在 Python 侧完成，兼容通道退回文件级判定。

const jobsStore = createJobsStore({ file: JOBS_FILE, maxKept: MAX_JOBS_KEPT, instanceTag: 'global' })

function loadJobs() {
  const snap = jobsStore.load()
  if (snap.state === 'ok' || snap.state === 'missing') return snap.jobs
  throw new Error(`CodeWiki 任务现场不可读：${snap.error ?? snap.state}；为避免重复编译，已拒绝把损坏现场当作空任务`)
}

function saveJobs(jobs) {
  jobsStore.save(jobs)
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
    // 完整性终态（吸收自 FSoft updater）：done 只表示「完整成功」，partial 表示
    // 「部分文章写成但仍有未消化/失败/质量问题的变化」，failed 表示没有任何成果可交付。
    // 面板与 codewiki_progress 共用本结构，缺了这三个字段用户只能从 stage 猜。
    outcome: job.outcome ?? null,
    blockers: (job.blockers ?? []).slice(0, 20),
    canAdvanceBaseline: job.canAdvanceBaseline === true,
    baselineEligible: job.baselineEligible === true,
    baselineAdvanced: job.baselineAdvanced === true,
    deliveryComplete: job.deliveryComplete === true,
    updateRecord: job.updateRecord ?? null,
    updatePlan: job.updatePlan ?? null,
    // 插件自动提交结果（0.10.9）：面板与 codewiki_progress 共用同一份 jobSummary，
    // 缺了这个字段两处都拿不到，只能从 notes 里猜。
    autoCommit: job.autoCommit ?? null,
    // 原生通道（阶段 4）：channel 决定这条任务是「谁在跑」，nativeStage 是引擎自己
    // 报的真实阶段（八段契约），与面板步骤条的粗粒度 stage 不是一回事，两个都要给。
    channel: job.channel ?? 'legacy',
    nativeStage: job.nativeStage ?? null,
    nativePercent: job.nativePercent ?? null,
    nativeMessage: job.nativeMessage ?? null,
    nativeTotal: job.nativeTotal ?? null,
    nativeResult: job.nativeResult ?? null,
    // 引擎事件日志（0.17.1）：内存里最近 40 条给面板即时看；完整 NDJSON 在仓库外的
    // 临时目录（见 lib/job-logs.js），端点 /api/codewiki/logs 按需翻全量。
    // 此前这两个字段都不进 jobSummary，面板与 codewiki_progress 都看不到任何引擎日志。
    nativeLogs: (job.nativeLogs ?? []).slice(-40),
    logFile: job.channel === 'native' ? logFileFor(job.id) : null,
    logError: job.logError ?? null,
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
  let stopped = false
  let seq = 0
  // 实例身份：tick 只推进本实例创建的 job（owner 缺失=0.4.2 残留，任何实例可接管续查）。
  // 否则另一实例的 tick 会用 loadJobs 旧快照重复推进同一 job——双提交批量。
  const instanceId = `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const store = createJobsStore({ file: JOBS_FILE, maxKept: MAX_JOBS_KEPT, instanceTag: instanceId })
  let tickLockToken = null
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
      ['done', 'partial', 'failed', 'cancelled'].includes(j.stage)
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
    // 已知仓库清单里那些「job 记录早已被截断、目录却已经变成空壳/worktree」的登记也要摘掉：
    // 上面只遍历了 jobs，掉出历史的那批永远不会被看到，于是 autoScan 每轮都对它们重跑
    // isWorktreeCwd / hasCompilableSources 再跳过，清单无界增长且面板上留着永远编译不出东西的行。
    // 一次算完再整写，避免逐条 forgetRepo 反复读写 REPOS_FILE。
    {
      const known = loadKnownRepos()
      const alive = known.filter((dir) => isDeadCompileTarget(dir) === false)
      if (alive.length !== known.length) {
        try { fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: alive }, null, 2), 'utf8') } catch { /* 不可写则放弃 */ }
      }
    }
  }
  // 磁盘吸收：另一实例新增的 job、或同 id 但磁盘更新且本实例没动过的 job，并回内存——
  // 防止 flush 用本实例的过期快照覆盖掉对方的活动 job。
  function mergeFromDisk() {
    const snap = store.loadForIdempotency()
    if (!snap.safe) throw new Error(`CodeWiki 任务现场不可读：${snap.error ?? snap.state}；已停止推进，避免重复执行`)
    const merged = mergeJobLists({ mine: jobs, disk: snap.jobs, dirtyIds })
    // 幽灵任务回收：owner 不是我、本实例也没动过的任务，磁盘上已不存在，说明它被
    // 拥有者删除（Temp 沙箱清理、MAX_JOBS_KEPT 截断）。只增不删会让这些任务永远留在
    // 本实例内存里占住项目闸门（提交被判 queued，直到没人能等的超时），面板也一直显示。
    const diskIds = new Set(snap.jobs.map((j) => j.id))
    const kept = merged.jobs.filter((j) => diskIds.has(j.id) || !j.owner || j.owner === instanceId || dirtyIds.has(j.id))
    const dropped = merged.jobs.length - kept.length
    if (!merged.changed && !dropped) return
    jobs.length = 0
    jobs.push(...kept)
  }
  const flush = () => {
    if (stopped) return
    if (!dirty) return
    const dirtyJobs = new Map(jobs.filter((j) => dirtyIds.has(j.id)).map((j) => [j.id, j]))
    mergeFromDisk()
    for (const [id, local] of dirtyJobs) {
      const at = jobs.findIndex((j) => j.id === id)
      if (at >= 0) jobs[at] = local
      else jobs.push(local)
    }
    dirty = false; dirtyIds.clear(); store.save(jobs)
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
    const disk = store.load().jobs
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

  function fail(job, msg, { notify = true } = {}) {
    const fromSubmit = job.stage === 'submitting' // 提交期失败：错误随工具调用同步返回，无需再唤醒
    setStage(job, 'failed')
    job.error = msg
    job.outcome = 'failed'
    job.canAdvanceBaseline = false
    job.blockers = [...(job.blockers ?? []), { kind: 'failed', detail: String(msg).slice(0, 300) }]
    job.finishedAt = new Date().toISOString()
    note(job, `任务失败：${msg}`)
    touch(job)
    if (notify && !fromSubmit) onSettled?.(job, 'failed') // sessionId 守卫在 wakeCompileSession 内
  }

  // 任务收尾：done / partial / failed 三态。
  //   done     完整成功：计划内必需文章全部写好、变更全部有归属、质量闸门全过。
  //   partial  部分完成：写成的文章可以入库，但完整性不成立——**不推进编译基线**，
  //            未消化的变化下次编译还会被看见（旧实现这里一律 done + meta update，
  //            于是 1 篇成功 19 篇失败也报「已完成」，剩下的变化从此再没人看）。
  //   failed   失败：没有可交付成果。
  function finishJob(job, outcome, blockers = []) {
    const stage = outcome === 'failed' ? 'failed' : (outcome === 'partial' ? 'partial' : 'done')
    job.outcome = stage
    job.blockers = blockers
    // 基线只代表「所有变化都已被消化」：任何 blocker 都意味着没消化完。
    job.deliveryComplete = stage === 'done' && blockers.length === 0
    job.canAdvanceBaseline = job.baselineAdvanced === true
    if (stage === 'failed' && blockers.length) {
      job.error = String(blockers[0]?.detail ?? blockers[0]?.kind ?? job.error ?? '失败').slice(0, 500)
    }
    setStage(job, stage)
    job.finishedAt = new Date().toISOString()
    note(job, `任务终态：${describeOutcome(stage, blockers)}`)
    touch(job)
    onSettled?.(job, stage)
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

  // 更新记录落盘（吸收自 FSoft updater 的 record）：一次编译做了什么、为什么、哪些变化
  // 没人管、最终是否完整，写成可机读 JSON 存 .codewiki/temp/update-record.json。
  // job 里只留摘要与路径（整张图塞进 jobs 文件会让 /tmp 里的任务文件无限膨胀）。
  //
  // `outDir` 例外通道（原生引擎用）：原生通道的提交发生在落地器内部，而这份记录要等
  // 落地结果出来才写得成——写到 .codewiki/ 就必然晚于提交，于是每轮编译之后工作区都
  // 留一个未跟踪的 `?? .codewiki/temp/update-record.json`（阶段 6 真实验收证据），
  // 无变化轮「零副作用」也就无从谈起。所以原生通道把记录写到仓库外的记账目录，
  // 路径随 job 出去，可复盘性不丢，工作区保持干净。
  function saveRecord(job, judged, { outDir = null } = {}) {
    try {
      const rec = buildUpdateRecord({
        jobId: job.id,
        scope: job.scope,
        changeSet: job.changeSet ?? null,
        plan: job.updatePlan ?? null,
        results: job.articles ?? [],
        outcome: judged,
        wikiPath: job.wikiPath,
        qualityIssues: job.qualityIssues ?? [],
        notes: job.notes ?? [],
        startedAt: job.createdAt,
      })
      const r = saveUpdateRecord(outDir ? path.join(outDir, job.id) : job.wikiPath, rec)
      job.updateRecord = r.ok
        ? {
          path: outDir ? r.path : UPDATE_RECORD_REL,
          outcome: rec.outcome,
          blockers: rec.blockers.length,
          canAdvanceBaseline: rec.canAdvanceBaseline,
        }
        : { path: null, outcome: rec.outcome, reason: r.reason }
      if (!r.ok) note(job, `更新记录写入失败 —— ${r.reason}`)
    } catch (err) {
      note(job, `更新记录生成异常（忽略）—— ${String(err?.message ?? err).slice(0, 200)}`)
    }
  }

  // keepInMemory 结果的落盘闸门：输出必须以 frontmatter 开头且闭合，坏输出不写 wiki。
  // keepInMemory 任务（横切/校对）在批量阶段不落盘，唯一写盘点落在这里——
  // 不能再走 applyTaskResult（它对 keepInMemory 只回内存不落盘）。
  function writeValidated(job, task, content) {
    const why = validateArticleEnvelope(content)
    if (why) {
      note(job, `${task.name}：${why}，不落盘（原文件保留）`)
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

  // 结果记账。两个开关各管一件事，互不重叠：
  //   replace=true（校对阶段）：同名条目一律覆盖——校对结果代表该文章的最终状态，
  //     校对失败不推翻已写成功的原文（rec.ok 会被 prev 的 ok 兜住）。
  //   mergeByName=true（文章/观察/合成的重跑路径）：同名条目合并而不是再 push 一条。
  //     正常首次 tally 时 job.articles 里还没有同名条目，所以这个开关只在**真的重跑**
  //     时起作用：· agentic 失败退回单轮重跑（shouldFallBackHere 分支）
  //             · 宿主重启后 settleJob 的「执行器丢失」整批重跑
  //     这两种情况不合并的话，writtenCount 会重复累加、job.articles 里留两条同名记录
  //     （面板显示成两篇），进度也就对不上了。
  function tally(job, results, tasks, { replace = false, mergeByName = false } = {}) {
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
      const prev = (replace || mergeByName)
        ? (job.articles.find((a) => a.name === rec.name) ?? null)
        : null
      if (prev) {
        const wasOk = prev.ok
        if (!rec.ok && wasOk) rec.ok = true // 曾经的成就不被后续失败抹掉
        const wasPath = prev.path
        Object.assign(prev, rec)
        if (!wasPath && rec.path) prev.path = rec.path
        // 失败 -> 成功：计入写成功、从失败里减掉
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

  // ── 原生引擎通道（阶段 4）的执行器 ──────────────────────────────────────
  // 与 batchRuns 同构：runNativeJob 是一条长任务（一次 generate 全跑完），
  // 不能塞进 tick 的一步里——tick 是 10s 节拍，跑不完就返回会让下一次 tick 重复提交。
  // 所以「启动 → 等结果 → 收割」三段分开，结果为 null 表示已 fail（由执行器自己判）。
  const nativeRuns = new Map()     // jobId → Promise
  const nativeResults = new Map()  // jobId → EngineResult | null
  const nativeAborters = new Map() // jobId → AbortController

  // 原生八段 → 面板现有阶段。面板步骤条按 ACTIVE_STAGES 渲染，改它会牵动一大堆
  // 布局与文案；真实引擎阶段另存 job.nativeStage，让面板既能显示「在第几步」，
  // 又能显示「引擎自己走到哪」。映射原则：引擎里发生在写作之前的三段（探测环境、
  // 解析代码图、聚类模块）合成步骤条的「准备」——它们对用户是同一件事：还在摸清仓库。
  // validate 有自己的格子（校验），不再借用 review（那现在是校对真正发生的位置）。
  const NATIVE_STAGE_TO_PANEL = {
    env: 'prepare', graph: 'prepare', cluster: 'prepare', articles: 'articles',
    proofread: 'review', validate: 'validate', index: 'index', baseline: 'index', commit: 'commit',
  }
  // 引擎事件日志：内存留最近 40 条给面板即时看，同时逐条追加到仓库外的 NDJSON
  // （lib/job-logs.js）。两条路都必须有——内存那份随任务记录截断/宿主重启消失，
  // 落盘那份才能回答「99 分钟里到底发生了什么」。
  const NATIVE_LOG_MEMORY = 40
  function recordNativeLog(job, entry) {
    const at = entry?.at || new Date().toISOString()
    const item = { at, ...entry }
    job.nativeLogs = [...(job.nativeLogs ?? []), item].slice(-NATIVE_LOG_MEMORY)
    if (appendLog(job.id, item)) {
      job.logError = null
    } else if (!job.logError) {
      // 落盘失败不能静默：日志是这个任务唯一的黑匣子，写不进去必须让用户看到。
      job.logError = '引擎日志写入失败（详见宿主临时目录权限）'
      note(job, `引擎日志写入失败 —— 后续事件只在内存里保留最近 ${NATIVE_LOG_MEMORY} 条`)
    }
  }

  // 原生通道单次编译：起一条长任务，结果为 EngineResult（含 gate/apply 现场）。
  // 失败一律进 nativeResults=null 并由这里 fail()，与 batchRuns 的约定一致：
  // 收割方（settleJob）只看「有没有结果」，不用自己猜执行器死活。
  function startNativeRun(job, channel) {
    const ac = new AbortController()
    nativeAborters.set(job.id, ac)
    const c = liveConfig(config)
    // 引擎原始产物目录必须放在**仓库外**（临时目录）。
    // 曾经放在 .codewiki/temp/native-docs，实测会在首次编译时整批失败：落地器
    // apply-plan.js:542-565 用「.codewiki 目录是否存在」判断要不要跑 cw init，
    // 而引擎写产物这一步已经先把 .codewiki/ 建出来了，于是被判成
    // 「.codewiki/ 存在但缺 _meta.yaml（人工删改过？）」→ wiki-missing → failed。
    // 放临时目录还顺带避免产物被当成仓库页、避免残留污染 git 状态。
    const docsDir = path.join(os.tmpdir(), `dsh-codewiki-native-${job.id}`)
    const run = Promise.resolve()
      .then(() => runNativeJob({
        repoRoot: job.cwd,
        scope: job.scope,
        kind: job.kind,
        requestId: `${job.id}-native`,
        signal: ac.signal,
        timeoutMs: channel.timeoutMs,
        docsDir,
        resume: job.nativeResumeDocsDir === docsDir,
        // 文章语言：job 提交时已按「入参 > 插件设置」解析好（submit 的 language），
        // 原生通道必须显式带下去，否则引擎按英文写、设置项形同虚设。
        language: job.language,
        // 同层模块并行度：独立设置项，0/未填 跟随默认档并发（与 bigConcurrency 同约定），
        // 填 1 = 上游原本的严格串行。不复用同一个配置键，两者语义不同。
        moduleConcurrency: c.moduleConcurrency || c.maxConcurrency,
        // 单模块写作请求上限：上游写作 agent 的硬预算，不传就等于用引擎默认 100，
        // 大模块会撞满抛错把整轮判成 partial。
        requestLimit: c.requestLimit,
        // 原始树留档根（仓库外）：引擎产物在被映射/改写/裁剪之前先拷一份，
        // 失败只记 note 不影响终态——它是事实来源，不是交付物。
        rawTreeRoot: nativeRawTreeDir(),
        deps: {
          config: {
            ...c,
            engineRoot: '',
          },
          llm: llmRef,
          // 语义校对的单轮通道：用与写作同一个编译模型，不再单独配一套。
          // 校对发生在质量门之前，只改「链到不存在页面」的链接，改完重新判门。
          chat: async (prompt, signal) => {
            const r = await llmChat({
              llm: llmRef,
              provider: c.batchProvider,
              model: c.batchModel,
              reasoningEffort: c.batchReasoningEffort,
              prompt,
              signal,
            })
            return r.content
          },
          // 会话记录钩子：原生通道的模型请求全部经 llm-bridge 打进来，不在这里接线
          // 面板「会话」视图就永远是空列表（batch/agentic 通道早已各自接好）。
          onRequestStart: (task) => beginSessionRecord(job, task),
          engineFor: ({ bridge }) => nativeEnginePlan(channel, {
            requestId: job.id,
            bridge,
            // 模型名来自编译模型配置（不是桥）：桥只转发，不含 model 字段。
            model: c.batchModel,
            clusterModel: c.batchModel,
          }),
          applyDeps: {
            jobId: job.id,
            // 落地器的 cw 与自动提交都复用主实现：阶段 3 的那份是「等阶段 4 注入」的
            // 临时件，两套提交语义并存迟早分叉。
            runCw: (binary, cwd, args, timeoutMs) => runCw(binary, cwd, args, timeoutMs, ac.signal),
            commit: (root, opts) => autoCommitWiki(root, opts),
          },
        },
        onProgress: (p) => {
          // 引擎进度只映射到面板阶段 + 计数，不改终态语义（终态只由 runNativeJob 裁决）。
          job.nativeStage = p.stage
          job.nativePercent = p.percent
          if (p.message) job.nativeMessage = String(p.message).slice(0, 200)
          const mapped = NATIVE_STAGE_TO_PANEL[p.stage]
          if (mapped && !JOB_TERMINAL.has(job.stage) && job.stage !== mapped) setStage(job, mapped)
          if (p.writtenCount) job.writtenCount = p.writtenCount
          if (p.failedCount) job.failedCount = p.failedCount
          if (p.totalCount) job.nativeTotal = p.totalCount
          // 进度帧也进日志，但要按「阶段/百分比/篇数」去重：引擎每秒可能发好几帧，
          // 全量落盘只会把真正的事件（桥请求失败、stderr、阶段切换）挤出去。
          const sig = `${p.stage}|${p.percent}|${p.writtenCount ?? 0}`
          if (job.nativeLogSig !== sig) {
            job.nativeLogSig = sig
            recordNativeLog(job, {
              kind: 'progress',
              phase: 'engine',
              detail: `${p.stage} ${p.percent}%${p.message ? ` — ${String(p.message).slice(0, 160)}` : ''}`,
              written: p.writtenCount ?? 0,
              total: p.totalCount ?? null,
            })
          }
          touch(job)
        },
        onLog: (e) => recordNativeLog(job, e),
      }))
      .then(
        (res) => nativeResults.set(job.id, res),
        (err) => {
          nativeResults.set(job.id, null)
          if (!JOB_TERMINAL.has(job.stage)) {
            const msg = `原生引擎执行失败 —— ${String(err?.message ?? err)}`
            note(job, msg)
            fail(job, msg)
          }
        },
      )
      .finally(() => {
        nativeRuns.delete(job.id); nativeAborters.delete(job.id)
        // 引擎原始产物是临时件（落地后就不再需要）：留着只会在系统临时目录里堆垃圾。
        // 注意：这里清的是 `docsDir`（被消费的工作副本），**不清** rawTreeRoot 下那份
        // 留档 —— 留档存在的意义正是「消费之后还能回看引擎原样」。
        try { fs.rmSync(docsDir, { recursive: true, force: true }) } catch { /* 清不掉不影响终态 */ }
        touch(job)
      })
    nativeRuns.set(job.id, run)
    return run
  }

  // 原生阶段的任务推进：起一次（stage=articles 且没有在跑的），后续 tick 只等待。
  // 返回 true 表示本轮「有动作，别继续往下走」。
  async function tickNative(job, channel) {
    // 结果已就绪 → 收割（与 batchResults 同一套约定：执行器只调一次，收割方删记录）
    if (nativeResults.has(job.id)) {
      const res = nativeResults.get(job.id)
      nativeResults.delete(job.id)
      job.nativeExecutionFinished = true
      if (!res) return true // 执行器已 fail（null = 整体失败），终态已写，不再动
      // 到这里说明原生结果已包含 gate/apply/commit 的真实结果；迟到的取消不能把
      // 已落盘的产物改写成 cancelled。真正的执行中取消由 tick 先 abort，结果才是 cancelled。
      job.writtenCount = Number(res.writtenCount ?? 0) || 0
      job.failedCount = Number(res.failedCount ?? 0) || 0
      job.blockers = res.blockers ?? []
      job.autoCommit = res.apply?.commit ?? null
      // 用量：引擎侧（FSoft usage_ledger）已经把真实 token 数报回来了，此前从不写进
      // job.usage，面板与 codewiki_progress 一直显示 0——用户看到「跑了一小时」却
      // 看不到「烧了多少 token」，等于把成本完全藏起来。这里按字段映射落账，
      // 并沿用旧通道的 usage 形状（inputTok/outputTok/requests）避免面板两套渲染。
      const nu = res.usage
      if (nu && (nu.inputTokens || nu.outputTokens || nu.requests)) {
        job.usage = {
          inputTok: Number(nu.inputTokens) || 0,
          outputTok: Number(nu.outputTokens) || 0,
          requests: Number(nu.requests) || 0,
          cachedTok: Number(nu.cachedTokens) || 0,
          // 原生通道没有批量/实时分层，全部记在实时侧，面板的括号说明才不会空着。
          batchRequests: 0,
          realtimeRequests: Number(nu.requests) || 0,
          overTier2: 0,
        }
      }
      job.baselineEligible = res.gate?.baselineEligible === true
      job.baselineAdvanced = res.apply?.baseline?.advanced === true
      // 引擎/裁决给出的错误原文必须落到 job.error：finishJob 只在 blockers 非空时
      // 拿 blockers[0].detail 兜底，而「引擎 crashed」「协议破坏」这类失败的真实原因
      // 在 res.error 里（如「引擎正常退出但没有 result 消息（协议破坏）」），
      // 不搬过来，面板与 codewiki_progress 就只剩一句「编译未成立」，等于要人去猜。
      if (res.error && !job.error) job.error = String(res.error.message ?? '').slice(0, 500) || null
      job.nativeResult = {
        outcome: res.outcome,
        stage: res.stage ?? null,
        engine: res.engine ?? null,
        gate: res.gate ?? null,
        apply: res.apply ?? null,
        engineLock: res.engineLock ?? null,
        // 产物位置要随结果出去：`rawTree` 是引擎原始 docs 树在被消费之前的留档
        // （设计文档 L20 的事实来源）。不搬出来的话，留档虽然写成了，却没有任何
        // 人能从 job 结果里找到它 —— 等于没留。
        artifacts: res.artifacts ?? null,
        // 增量现场必须随结果出去：决议（full/update）、变化集、水合清单、
        // 引擎自报的 updateOutcome、未消费凭据。面板与 codewiki_progress 靠它
        // 回答「这一轮到底走了增量还是退了全量、变化有没有被吃干净」；
        // 不搬过来的话，外层只能看到一个 outcome，增量语义又变成不可观测。
        incremental: res.incremental ?? null,
        usage: res.usage ?? null,
        notes: (res.notes ?? []).slice(-10),
      }
      if (Array.isArray(res.gate?.articles) && res.gate.articles.length) {
        // 文章明细取质量门的真实产物清单：面板的「已写/失败」是这里来的，
        // 不是从引擎自报的计数推——引擎说写了 20 篇、门说只有 17 篇合格，以门为准。
        // action='write' 才算真的落地；skip 表示这一页被门拦下了（记为未完成，
        // 与旧流水线的 ok:false 同义，让面板不再把被拦的页显示成成功）。
        job.articles = res.gate.articles.map((a) => ({
          name: path.basename(String(a.wikiPath ?? a.source ?? '')),
          ok: a.action === 'write',
        }))
      }
      const judged = {
        outcome: res.outcome,
        blockers: res.blockers ?? [],
        canAdvanceBaseline: res.canAdvanceBaseline === true,
      }
      job.judged = judged
      // 原生通道的记录写到仓库外（见 saveRecord 的 outDir 说明）：提交已经在落地器里
      // 完成，此刻再往 .codewiki/temp/ 写就是「提交之后产生未跟踪文件」。
      saveRecord(job, judged, { outDir: nativeRecordDir() })
      if (res.outcome === 'cancelled') {
        // 取消是终态：不走 finishJob（它只认 done/partial/failed，会把 cancelled 落成 done），
        // 也不覆盖任何已写好的终态。canAdvanceBaseline 恒 false——半成品基线绝不前移。
        job.outcome = 'cancelled'
        job.blockers = res.blockers ?? [{ kind: 'cancelled', detail: '原生引擎已取消' }]
        job.canAdvanceBaseline = false
        setStage(job, 'cancelled')
        job.finishedAt = new Date().toISOString()
        note(job, '任务终态：已取消（产物未落地，基线未推进）')
        touch(job)
      } else {
        // 不跑 tickCommit：原生通道的 commit 已在落地器里完成（提交失败会进 blockers，
        // 终态不会是 done）。再调一次旧 tickCommit 只会重复提交同一批产物。
        finishJob(job, res.outcome, res.blockers ?? [])
      }
      return true
    }
    if (nativeRuns.has(job.id)) return true // 在跑，等下轮
    if (job.nativeStarted === true) {
      if (job.cancelRequested) return false
      const replay = planNativeReplay(job)
      if (!replay.replayable) {
        fail(job, replay.reason)
        return true
      }
      job.nativeResumeDocsDir = replay.resumeDocsDir
      job.nativeSnapshot = { ...job.nativeSnapshot, attempt: replay.attempt }
      note(job, replay.resumeDocsDir ? `${replay.reason}；保留已完成叶子断点` : replay.reason)
    }
    job.nativeStarted = true
    if (job.nativeResumeDocsDir && !fs.existsSync(job.nativeResumeDocsDir)) job.nativeResumeDocsDir = null
    job.nativeSnapshot = snapshotNativeRun(job, {
      channel,
      attempt: job.nativeSnapshot?.attempt ?? 1,
      docsDir: path.join(os.tmpdir(), `dsh-codewiki-native-${job.id}`),
      moduleConcurrency: liveConfig(config).moduleConcurrency || liveConfig(config).maxConcurrency,
      rawTreeRoot: nativeRawTreeDir(),
    })
    touch(job)
    note(job, `原生通道启动（引擎 ${path.basename(channel.entry)}，解释器 ${channel.python}，第 ${job.nativeSnapshot.attempt} 次执行）`)
    startNativeRun(job, channel)
    return true
  }

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
        bigConcurrency: c.bigConcurrency, // 0 = 跟随默认档并发
        cwd: job.cwd,
        language: job.language,
        articleFormat: articleFormatSection(),
        maxSteps: DEFAULT_MAX_STEPS,
        fixAnchors,
        // agentic 通道的写集（吸收自 FSoft 的 write-set）：父任务只能写自己目标文章，
        // 子模块只能写调度器分配的路径。不传时旧行为不变（供既有调用方沿用）。
        allowedWritePaths: tasks.filter((t) => t.articlePath).map((t) => t.articlePath),
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

  // 规划（兼容通道专用）：0.16.0 阶段 7 起语义规划（AST 聚类）随 nativeEngine 默认
  // 开启而退役——原生引擎自己完成图提取与聚类。这条路径只在 nativeEngine=false 时
  // 被 tickArticles 用到，模块清单退回到顶层目录分组。
  async function buildPlan(job, files) {
    const plan = localPlan(files)
    note(job, `规划：${plan.modules.length} 个模块（按顶层目录分组，兼容通道 nativeEngine=false）`)
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
      // 观察→合成分割通道 0.17.5 已删除，任务不再带 splitFor/composePlan；
      // 旧 jobs 里可能残留这两个字段，读侧按缺省处理即可，不需要迁移。
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
      tally(job, results, tasks, { mergeByName: true })
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
      // 本阶段「应该产出什么」——完整性判定的分母。旧实现只在收尾看 writtenCount，
      // 于是「计划 20 篇、写成 1 篇」也算成功；这里把清单固化下来，缺页才判得出。
      if (tasks.length) job.expectedNames = tasks.map((t) => t.name)
      // agentic 写作通道（吸收自 FSoft CodeWiki 的 module agent）：模型自己读源码、增量写文章。
      // 它不需要「源码整包内联 → 超预算拆观察批 → 合成」这套装填，因此没有 sessionTasks。
      // 单篇失败只记账；失败率过半且旧通道可用时退回单轮通道重跑一次（见下）。
      if (tasks.length) {
        // 按模块源文本量给超大模块打大档标记（与单轮通道 markBig 同语义：吃不下就换大上下文模型），
        // 再交给双池执行器——大档任务走 bigProvider，其余走默认档，两池独立限流。
        // 大档关闭（liveConfig 已把 bigProvider 清空）时 markBigAgenticTasks 原样返回。
        const agenticTasks = markBigAgenticTasks(
          tasks.map((t, i) => ({ ...t, customId: t.customId ?? `a${i}` })),
          {
            bigTier: {
              provider: c0.bigProvider,
              model: c0.bigModel,
              reasoningEffort: c0.bigReasoningEffort,
              budget: c0.bigTokenBudget,
            },
            sizeOf: (t) => sourceTokensOf(t, job.cwd),
          },
        )
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
        note(job, `阶段已启动：${agenticTasks.length} 篇 agentic 写作（模型 ${c0.batchProvider}/${c0.batchModel}，并发 ${c0.maxConcurrency}，单篇≤${DEFAULT_MAX_STEPS} 步）`)
        touch(job)
        return
      }
      fail(job, '没有可写的文章任务')
      return
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
      tally(job, results, tasks, { mergeByName: true })
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
    // 单批直出：packArticles 保证装得下（超预算的文章只截头部并标注），不再有
    // 「拆观察批 → 合成」那条路（0.17.5 随单轮通道退役）。总量超普通预算就换大档。
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
    // 存量坏文章体检：wiki 里已有的结构破坏（重复 frontmatter/空章节/坏 source_files）
    // 本身就是「坏文章已入库」。把它们并入质量阻塞——本次编译即使全成功，只要库里
    // 还躺着坏文章，终态就是 partial 且基线不推进。这是有意的：假装干净 = 下次编译
    // 继续在脏库上判定「已消化」，坏文章永远没人管。
    try {
      const audited = auditExistingArticles(job.wikiPath, job.cwd)
      if (audited.length) {
        job.qualityIssues = [...(job.qualityIssues ?? []), ...audited]
        note(job, `存量文章体检：${audited.length} 篇未过契约（${audited.slice(0, 3).map((a) => a.name).join('、')}${audited.length > 3 ? ' 等' : ''}）`)
      }
    } catch (err) {
      note(job, `存量文章体检异常（忽略）—— ${String(err?.message ?? err).slice(0, 200)}`)
    }
    // 完整性判定（吸收自 FSoft updater 的 record/终态不变量）：索引与基线之前先问一句
    // 「这次编译是否把所有变化都消化了」。旧实现只数 writtenCount——1 篇成功 + 19 篇失败
    // 照样 done + meta update，未消化的变化从此永久失明。
    const judged = judgeOutcome({
      plan: job.updatePlan ?? null,
      results: job.articles ?? [],
      options: {
        expectedNames: job.expectedNames ?? [],
        qualityIssues: job.qualityIssues ?? [],
        extraBlockers: job.hardBlockers ?? [],
      },
    })
    job.judged = { outcome: judged.outcome, blockers: judged.blockers, canAdvanceBaseline: judged.canAdvanceBaseline }
    if (judged.outcome !== 'done') {
      const why = judged.blockers.slice(0, 3).map((b) => String(b.detail ?? b.kind)).join('；')
      note(job, `完整性未成立（${describeOutcome(judged.outcome, judged.blockers)}）—— ${why}`)
    }
    if (job.writtenCount > 0) {
      // 清理模块改名后的孤儿文章。必须放在 cw index 之前：cw index 扫描 modules/ 生成
      // _index.md，先删掉死文章，重建的索引才不会再收录它们。
      try {
        const pr = pruneOrphanModules(job)
        if (pr.removed.length) {
          note(job, `清理孤儿模块文章 ${pr.removed.length} 篇（模块划分已变，旧文件无人重写）—— ${pr.removed.slice(0, 5).join('、')}${pr.removed.length > 5 ? ' 等' : ''}`)
        } else if (pr.skipped && job.kind === 'full') {
          note(job, `孤儿清理跳过：${pr.skipped}`)
        }
        // 删不掉的孤儿必须留痕：它们会一直占着 modules/ 并被 cw index 收录，
        // 静默吞掉的话下次编译仍然「成功」，无从知道有篇死文章还在。
        if (pr.failed.length) {
          note(job, `孤儿模块文章 ${pr.failed.length} 篇删除失败（下次编译重试）—— ${pr.failed.slice(0, 5).join('、')}${pr.failed.length > 5 ? ' 等' : ''}`)
        }
      } catch (err) {
        note(job, `孤儿清理异常（忽略，不影响编译）—— ${String(err?.message ?? err).slice(0, 200)}`)
      }
      const binary = resolveBinary(liveConfig(config))
      // 基线推进闸门：只有「完整性成立」才允许 cw meta update。
      // partial/failed 时索引照建（面板/链接要能看），但基线**绝不前移**——
      // 前移就等于宣布「这些变化已被消化」，而未消化的部分下次编译将永久失明。
      let advance = job.judged?.canAdvanceBaseline === true
      try {
        // wiki 骨架必须先存在：`cw meta update` 要读 .codewiki/_meta.yaml，缺文件即 exit 1。
        // 提交路径（codewiki_generate）在 state=missing 时会先 cw init，但接管/重放的旧任务
        // 可能落在一个还没有库骨架的仓库上，此时走到这里必然整批 partial 且基线永远推不动。
        // 与原生落地器（lib/engine/apply-plan.js 的 3b）保持同一判据：目录不在就 cw init，
        // 目录在却缺 _meta.yaml（人工删改过的半截状态）不猜、不手写，直接记阻塞。
        const metaAbs = path.join(job.wikiPath ?? path.join(job.cwd, '.codewiki'), '_meta.yaml')
        if (!fs.existsSync(metaAbs)) {
          if (fs.existsSync(job.wikiPath ?? path.join(job.cwd, '.codewiki'))) {
            job.hardBlockers = [...(job.hardBlockers ?? []), { kind: 'wiki-missing', detail: 'wiki 目录存在但缺 _meta.yaml，拒绝自动初始化' }]
            note(job, 'wiki 目录存在但缺 _meta.yaml（人工删改过？），跳过基线推进；请跑 cw init 或删除该目录后重试')
            advance = false
          } else {
            const initRes = await runCw(binary, job.cwd, ['init'], 120000)
            if (initRes.exitCode === 0) {
              note(job, '仓库还没有 wiki，已先 cw init 建出库骨架（之后再 index/基线）')
            } else {
              job.hardBlockers = [...(job.hardBlockers ?? []), { kind: 'wiki-missing', detail: `cw init exit ${initRes.exitCode}` }]
              note(job, `cw init exit ${initRes.exitCode} —— ${String(initRes.stderr || initRes.stdout || '').trim().slice(0, 200)}`)
              advance = false
            }
          }
        }
        const idx = await runCw(binary, job.cwd, ['index'], 120000)
        note(job, `cw index exit ${idx.exitCode}`)
        if (idx.exitCode === 0 && normalizeIndexLinks(job.cwd)) note(job, '_index.md 链接路径已规范化（\\ → /）')
        if (idx.exitCode !== 0) {
          job.hardBlockers = [...(job.hardBlockers ?? []), { kind: 'index', detail: `cw index exit ${idx.exitCode}` }]
        }
        if (advance) {
          const meta = await runCw(binary, job.cwd, ['meta', 'update'], 120000)
          if (meta.exitCode === 0) {
            note(job, 'cw meta update exit 0（基线已推进）')
          } else {
            note(job, `cw meta update exit ${meta.exitCode}（基线未推进）—— ${String(meta.stderr || meta.stdout || '').trim().slice(0, 200)}`)
            job.hardBlockers = [...(job.hardBlockers ?? []), { kind: 'meta', detail: `cw meta update exit ${meta.exitCode}` }]
          }
        } else {
          note(job, '编译基线未推进（完整性未成立：未消化的变化下次编译仍会被看见）')
        }
      } catch (err) {
        note(job, `cw index/meta 执行异常 —— ${String(err?.message ?? err)}`)
        job.hardBlockers = [...(job.hardBlockers ?? []), { kind: 'index', detail: String(err?.message ?? err).slice(0, 200) }]
      }
      // index/meta 是终态裁决的一部分，不能先冻结 judged 再追加 blocker。
      const finalJudged = judgeOutcome({
        plan: job.updatePlan ?? null,
        results: job.articles ?? [],
        options: {
          expectedNames: job.expectedNames ?? [],
          qualityIssues: job.qualityIssues ?? [],
          extraBlockers: job.hardBlockers ?? [],
        },
      })
      job.judged = { outcome: finalJudged.outcome, blockers: finalJudged.blockers, canAdvanceBaseline: finalJudged.canAdvanceBaseline }
      job.baselineEligible = finalJudged.canAdvanceBaseline
      job.baselineAdvanced = advance && !(job.hardBlockers ?? []).some((b) => b.kind === 'meta')
      Object.assign(judged, { outcome: finalJudged.outcome, blockers: finalJudged.blockers, canAdvanceBaseline: finalJudged.canAdvanceBaseline })
      // 符号快照：0.16.0 阶段 7 受控退役，随 lib/symbols.js + lib/incremental.js 一并删除。
      // 原生引擎（默认通道）在 Python 侧自己维护受管状态与符号级增量，不需要 Node 侧快照。
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
    // partial 也允许入库（写成的文章有价值），但它的终态仍是 partial——不推进基线。
    saveRecord(job, judged)
    if (job.writtenCount > 0 && liveConfig(config).autoCommit) {
      setStage(job, 'commit')
      return // 提交在下个 tick 的 tickCommit 完成；完成后才置终态并唤醒会话
    }
    finishJob(job, judged.outcome, judged.blockers)
  }

  async function tickCommit(job) {
    // 提交产物（0.10.11 独立成阶段）：autoCommitWiki 走「主题分支提交 → 合并回原分支」。
    // 失败不改变任务终态，只记录原因供「产物待提交」提醒与面板展示；
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
    const judged = job.judged ?? { outcome: job.writtenCount > 0 ? 'done' : 'failed', blockers: job.blockers ?? [] }
    finishJob(job, judged.outcome, judged.blockers ?? [])
  }

  const STAGE_HANDLER = {
    articles: tickArticles,
    crosscut: tickCrosscut,
    review: tickReview,
    index: tickIndex,
    commit: tickCommit,
  }

  // 项目闸门占位判定：非终态 ≠ 有实例在推进。宿主重启/实例退出后，磁盘上会留下
  // owner 已消失、lastSeenAt 不再前进的任务；把它们算作占位会让后续提交一直排队，
  // 直到 ORPHAN_TAKEOVER_MS（默认 5 分钟）超时才被接管——表现为「重启后新任务卡在 queued」。
  // 停更超过接管阈值的任务不占位；真正的接管仍由 tick 的孤儿分支完成。
  function occupancyHeld(job) {
    if (!job.owner || job.owner === instanceId) return true
    const idleMs = Date.now() - lastSeenAt(job)
    return !(Number.isFinite(idleMs) && idleMs > ORPHAN_TAKEOVER_MS)
  }

  async function tick() {
    if (stopped) return
    if (ticking) return
    try { tickLockToken = store.acquireTickLock() } catch (err) {
      console.error(`[codewiki] ${String(err?.message ?? err)}`)
      return
    }
    if (!tickLockToken) return // 另一实例正在推进，本轮让路
    ticking = true
    try {
      // 会话记录过期清理（保留一天）：每 10 分钟一轮足够，不用每 tick 扫目录
      if (!tick.lastPruneAt || Date.now() - tick.lastPruneAt > 10 * 60 * 1000) {
        tick.lastPruneAt = Date.now()
        pruneSessionRecords()
      }
      mergeFromDisk()
      syncCancelFlags()
      for (const job of jobs) {
        if (!JOB_TERMINAL.has(job.stage) && heartbeat(job, { instanceId })) touch(job)
      }
      // 项目闸门（serialProjects 默认串行=上限1；关闭后按 parallelLimit 并行推进多仓库）。
      // 已经在推进的项目优先（不打断），活跃数不满上限时按提交顺序唤醒最早排队的；
      // 其余排队项目本轮不推进，等前面的到终态后自然轮到。取消仍不受闸门限制。
      const parallelLimit = Math.max(1, liveConfig(config).parallelLimit ?? 1)
      const activeIds = new Set()
      for (const j of jobs) {
        if (JOB_TERMINAL.has(j.stage)) continue
        if (j.stage !== 'queued' && j.stage !== 'submitting' && occupancyHeld(j)) activeIds.add(j.id)
      }
      for (const j of jobs) {
        if (activeIds.size >= parallelLimit) break
        if (j.stage === 'queued') activeIds.add(j.id)
      }
      for (const job of jobs) {
        if (JOB_TERMINAL.has(job.stage)) continue
        if (job.owner && job.owner !== instanceId) {
          // 别的实例拥有的任务：活着就跳过；停更则按阶段决定接手续跑还是作废。
          // 排队/提交阶段没有执行器可丢，旧实现一律 continue，于是宿主重启前提交的排队项
          // 会永久留在 queued——既占着闸门窗口，又让同仓幂等一直命中它，用户连重试都做不到。
          const plan = planForeignJob(job, { instanceId, now: Date.now(), orphanTakeoverMs: ORPHAN_TAKEOVER_MS })
          if (plan.action === FOREIGN_ACTION.LEAVE) continue
          if (plan.action === FOREIGN_ACTION.VOID) {
            // 作废是被取代，不是编译失败：原实例早已消失，这条排队项从未真正开始。
            // 不唤醒会话（不等同于「编译失败」），用户下次提交会正常排进队列。
            note(job, `原实例 ${job.owner} 停更，${plan.reason}，本实例作废该任务`)
            fail(job, plan.reason, { notify: false })
            continue
          }
          const idleMs = Date.now() - lastSeenAt(job)
          note(job, `原实例 ${job.owner} 停更 ${Math.round(idleMs / 60000)} 分钟，本实例接管推进`)
          adoptOrphan(job, { instanceId })
          touch(job)
          if (job.sessionTasks?.length) resendSessionSteer(job) // 在途会话通道任务：旧进程的 steer 可能已丢
        }
        if (job.stage === 'submitting') continue // 占位：submit 正在 await 凭证，阶段未定
        if (job.cancelRequested) {
          if (job.channel === 'native' && nativeResults.has(job.id)) {
            note(job, '取消到达时原生结果已落地，按真实结果收尾而不丢弃产物')
            await tickNative(job, job.nativeChannel)
            persist()
            continue
          }
          if (job.channel === 'native' && job.nativeExecutionFinished === true) {
            note(job, '取消到达前原生执行器已结束，交由结果收割核对落盘事实')
            await tickNative(job, job.nativeChannel)
            persist()
            continue
          }
          setStage(job, 'cancelled')
          job.finishedAt = new Date().toISOString()
          // 取消是终态，但不是「成功」：基线绝不能因为一个半成品任务前移。
          // setStage 只改 stage，不会碰 outcome/canAdvanceBaseline——留空会让人
          // 从 job 文件里读到「cancelled 且 canAdvanceBaseline 还是上一次的 true」。
          job.outcome = 'cancelled'
          job.canAdvanceBaseline = false
          // 无服务端批次可保留：中断在飞请求（未完成请求不计费），丢弃未收割结果
          const ac = batchAborters.get(job.id)
          if (ac) ac.abort()
          batchResults.delete(job.id)
          // 原生通道：abort 会终止受管的 Python 进程树（client.js terminateProcessTree），
          // 结果作废、不再 gate/apply。取消是终态，后续到达的 done 也不会覆盖。
          const nac = nativeAborters.get(job.id)
          if (nac) nac.abort()
          nativeResults.delete(job.id)
          if (job.batchRef) note(job, '已取消：在途请求已中断（未完成请求不计费）')
          if (job.channel === 'native') note(job, '已取消：原生引擎进程树已终止，未进入落地阶段')
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
          job.channel = 'legacy'
          job.batchRef = null
          job.tasks = []
          job.plan = null
          setStage(job, 'articles')
          note(job, '旧版规划阶段任务迁移到 articles（本地规划重建清单）')
          touch(job)
        }
        // ── 原生通道（阶段 4）──────────────────────────────────────────────
        // 通道一旦锁定就跟着 job 走：原生任务的 stage 只是「引擎走到第几步」的展示，
        // 若让它落进 STAGE_HANDLER，跑到 index/commit 时会去调旧流水线的同名 handler，
        // 同一批产物被两套实现各写一遍。所以 native 任务一律只走 tickNative。
        const lc = liveConfig(config)
        if (!job.channel) {
          const want = nativeChannelFor(lc, { kind: job.kind, scope: job.scope })
          if (want && job.stage === 'articles') {
            job.channel = 'native'
            job.nativeChannel = want
            note(job, `编译通道：原生引擎（入口 ${path.basename(want.entry)}，解释器 ${want.python}）`)
            persist()
          }
        }
        if (job.channel === 'native') {
          const ch = job.nativeChannel ?? nativeChannelFor(lc, { kind: job.kind, scope: job.scope })
          if (!ch) {
            fail(job, '原生通道缺少引擎快照（job 文件里没有 nativeChannel），无法续跑；请重新提交编译')
            persist()
            continue
          }
          try {
            await tickNative(job, ch)
          } catch (err) {
            fail(job, `原生阶段异常 —— ${String(err?.message ?? err)}`)
          }
          if (JOB_TERMINAL.has(job.stage)) persist()
          continue
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
      store.releaseTickLock(tickLockToken)
      tickLockToken = null
      ticking = false
    }
  }

  async function submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId, changeSet }) {
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
    // 幂等判定必须走归一化 key：同一仓库在不同入口的写法并不一致（工具入参可能带尾分隔符、
    // 盘符大小写不同；knownRepos 里存的是首次登记时的原样）。严格字符串相等会让同一仓库
    // 各开一条任务，单项目串行闸门与自动调度幂等的前提当场失效。
    const cwdKey = normPathKey(cwd)
    mergeFromDisk()
    const existing = findActiveJob(jobs, cwd)
    if (existing) {
      if (reassignSession(existing, sessionId)) {
        existing.owner = instanceId
        touch(existing)
        flush()
      }
      return { job: existing, existed: true }
    }
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
      // 增量可复盘证据（吸收自 FSoft updater 的 record）：变更集摘要与精简规划进 job，
      // 供终态判定（未映射变更/缺 source_files 阻断基线）与 update-record 复盘。
      changeSet: changeSet ? {
        version: changeSet.version,
        state: changeSet.state,
        baseCommit: changeSet.baseCommit,
        headCommit: changeSet.headCommit,
        committed: changeSet.committed,
        staged: changeSet.staged,
        unstaged: changeSet.unstaged,
        untracked: changeSet.untracked,
        deleted: changeSet.deleted,
        renamed: changeSet.renamed,
      } : null,
      // 增量 planner 已退役（0.16.0 阶段 7）：字段保留以兼容已落盘的旧 jobs 与面板读法，值恒为 null。
      updatePlan: null,
      qualityIssues: [],
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
      // 档位不在模型目录里时 provider 会 200 + 空内容静默空跑（见 effortError 注释）。
      // 读不到档位表（ok:false）说明无从判断，放行，不把探测失败升级成提交失败。
      const effortsOf = await resolveModelEfforts(llmRef, c.batchProvider, c.batchModel)
      if (effortsOf.ok) {
        const bad = effortError(effortsOf.efforts, c.batchReasoningEffort)
        if (bad) throw new Error(bad)
      }
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
    const busyOthers = jobs.filter((j) => j.id !== job.id && !JOB_TERMINAL.has(j.stage) && j.stage !== 'queued' && j.stage !== 'submitting' && occupancyHeld(j))
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
  const findActive = (cwd) => {
    mergeFromDisk()
    const key = normPathKey(cwd)
    return jobs.find((j) => normPathKey(j.cwd) === key && !JOB_TERMINAL.has(j.stage)) ?? null
  }

  function start() {
    if (timer) return
    stopped = false
    timer = setInterval(() => { void tick() }, TICK_MS)
    timer.unref?.()
  }
  // 停止后仍可能有飞行中的 tick（它正在 await 引擎/模型，clearInterval 拦不住）。这些 tick
  // 手里是本实例的旧内存现场，一旦让它 flush，就会把别的实例已经推进到终态的任务按旧阶段
  // 写回磁盘——任务被"复活"，还占着单项目串行闸门。所以停止即失效：tick 入口与 flush 都让路。
  function stop() {
    stopped = true
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
      '编译/刷新指定仓库的 CodeWiki（服务化全批量流水线，零子代理）。调用即提交：cw status 判态 → 提交后台编译任务（job）立即返回；宿主服务以 10s 节拍推进阶段机（原生引擎按依赖图→模块树→文章→校验推进），全部模型环节在插件内完成（默认 volces-ark/glm-5.3-flash，512k 上下文，单请求输入按 110k 预算分块装填），不委托发起会话的主模型。',
      'scope=auto（默认）：无 wiki 或未编译走全量；有变更走逐篇更新；最新则直接报告。scope=full：强制全量重编。scope=stale：只刷新过期文章。',
      '进度：调用即提交后本步就此结束——不要等待、不要轮询、不要为了确认编译好没有而反复调 codewiki_progress；去做你手头其他工作。编译完成的产物由插件自己提交入库（autoCommit：主题分支 codewiki/wiki-<任务id> 提交后合并回原分支，只含 .codewiki/ 与 CodeWiki.md），正常情况下你不需要为 wiki 跑任何 git 命令。需要事件级进度时才用 codewiki_progress（只读、立即返回），或在侧边栏 CodeWiki 面板 / GET /api/codewiki/jobs（回环地址）查看；POST /api/codewiki/control {action:"cancel",jobId} 取消。宿主重启或旧实例退出后，活动任务由新实例接管；原生引擎按持久化的非敏感执行快照重新运行，已落盘结果按事实收割。',
      '单项目串行（默认开）：同一时刻只推进一个仓库的编译任务，后提交的项目进 queued 排队，前一个收尾后自动轮到（进度里 stage=queued 即排队）。',
      '凭证由模型设置里该 provider（默认 volces-ark）的配置解析，插件不保存也不传递任何密钥；provider/model 留空或该模型不可用时报错而不是降级子代理。全量编译小仓库也要几分钟（多请求排队+生成），适合后台调用。',
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

      // 原生通道接管 stale/auto：不跑旧 planner 的 needsFull/unmapped 判定。
      // 旧 planner 见到「删除/改名导致文章归属缺失」一律推成全量，而原生引擎的组件级
      // 增量本来就能处理删除与改名——让旧判定插在中间，等于把阶段 5 的增量能力废掉。
      // 决议权归 runNativeJob：它读受管状态与四路 change-set，自己判 update / full / no_change。
      // 注意 clean 也必须走这里：cw status 只看 committed，工作区未提交变化与「受管状态缺失」
      // 它一概看不见，直接短路会让这些变化永远进不了引擎（丢变化）。
      const nativeCh = nativeChannelFor(liveConfig(cfg), { kind: 'stale', scope: effectiveScope })
      if (nativeCh && effectiveScope !== 'full' && status.state !== 'missing' && status.state !== 'uncompiled') {
        notes.push(status.state === 'clean'
          ? 'cw status 报 clean（只看 committed），原生通道仍需确认未提交变化与受管状态，交给原生引擎决议'
          : '原生通道接管增量（决议权归原生引擎：update / full / no_change）')
        const subN = await svc.submit({ kind: 'stale', cwd, wikiPath, scope: effectiveScope, language, auto, sessionId })
        if (subN.skipped) { notes.push(subN.reason); return result }
        const jobN = subN.job
        notes.push(`已提交原生增量任务 ${jobN.id}（scope ${effectiveScope}，由引擎自行决议）`)
        result.jobId = jobN.id
        result.stage = jobN.stage
        result.submitted = true
        return result
      }

      // clean：直接报告（scope=full 例外：强制全量重编）
      if (status.state === 'clean' && effectiveScope !== 'full') {
        notes.push('Wiki is up to date —— 无需编译')
        return result
      }

      // 文件级归属判定（0.16.0 阶段 7 受控退役后兼容通道唯一可用的判定）：
      // 变更集里的每个源码路径，只要被某篇已存在文章的 source_files 认领（或它是
      // 一次改名的源路径），就算「已消化」。返回未归属清单，调用方据此拒绝推进基线。
      // 旧 planner 的符号级/依赖级判定已随 lib/{symbols,graph-diff,incremental,update-planner}.js
      // 一并退役 —— 那套能力现在由原生引擎在 Python 侧完成。
      const attributeChanges = (changeSet, articles) => {
        const owned = new Set()
        for (const a of articles) {
          for (const s of a.sources ?? []) owned.add(String(s).replace(/\\/g, '/'))
        }
        const renamedFrom = new Set((changeSet.renamed ?? []).map((r) => String(r.from ?? '').replace(/\\/g, '/')))
        const changed = [...(changeSet.all ?? [])].map((p) => String(p).replace(/\\/g, '/'))
        const unmapped = changed.filter((p) => !owned.has(p) && !renamedFrom.has(p))
        const touched = new Set()
        for (const a of articles) {
          for (const s of a.sources ?? []) {
            const rel = String(s).replace(/\\/g, '/')
            if (changed.includes(rel)) touched.add(a.name)
          }
        }
        return { unmapped, touched }
      }

      // stale / auto 逐篇更新：任务在提交时预构建（服务直接进 articles 阶段）
      // 返回 {handled:true} 表示本分支已给出结论（提交任务/刷新基线/报告阻塞），
      // 返回 {needFull:true, reason} 表示增量判定要求退回全量编译。
      const runStaleUpdate = async () => {
        let tasks = []

        // 变更采集（吸收自 FSoft updater）：cw status 只看 `git diff <baseline>..HEAD`，
        // 未提交的工作区修改（staged/unstaged/untracked）与删除/改名全被漏掉——
        // 这是「增量漏检」的直接来源。这里用 change-set 把四路变更合起来，
        // 再交给 planner 统一判「哪篇要写、为什么、哪些变化没人认领」。
        const baseline = readCompiledBaseline(wikiPath)
        let changeSet = null
        if (baseline) {
          changeSet = collectChangeSet(cwd, baseline)
          if (!changeSet.ok) {
            return { needFull: true, reason: `变更采集不可用（${changeSet.reason}）` }
          }
          notes.push(`变更采集：committed ${changeSet.committed.length}、staged ${changeSet.staged.length}、unstaged ${changeSet.unstaged.length}、untracked ${changeSet.untracked.length}、deleted ${changeSet.deleted.length}、renamed ${changeSet.renamed.length}（base ${baseline.slice(0, 8)}）`)
        } else {
          notes.push('读不到编译基线（.codewiki/_meta.yaml），按文件级退化处理')
        }

        const articles = collectWikiArticles(wikiPath)
        const staleRel = new Set(status.staleArticles.map((a) => String(a).replace(/\\\\/g, '/')))
        let attribution = null
        if (changeSet?.ok && articles.length) {
          attribution = attributeChanges(changeSet, articles)
          notes.push(`增量判定（文件级）：${attribution.touched.size} 篇源码命中变更、${attribution.unmapped.length} 处变更无文章认领`)
          const byName = new Map(articles.map((a) => [a.name, a]))
          const want = new Set(attribution.touched)
          for (const s of staleRel) if (byName.has(s)) want.add(s)
          tasks = [...want].map((name) => {
            const art = byName.get(name)
            return {
              name,
              mission: `更新过期文章 ${name}：以当前代码为准重写其内容，保留章节结构与 title/type/tags（源码变更命中其 source_files）`,
              sources: art.sources,
              cwd,
              articlePath: art.articlePath,
              prevArticlePath: art.articlePath,
            }
          })
        } else if (status.staleArticles.length) {
          // 无基线/无文章（旧 wiki）：退回 cw status 给出的过期清单，文件级
          tasks = status.staleArticles.map((articleRel) => {
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
        }

        if (tasks.length) {
          const sub = await svc.submit({ kind: 'stale', cwd, wikiPath, scope: effectiveScope, language, prebuiltTasks: tasks, auto, sessionId, changeSet })
          if (sub.skipped) { notes.push(sub.reason); return { handled: true } } // worktree 闸门静默跳过
          const { job } = sub
          notes.push(`已提交 ${tasks.length} 篇过期文章更新任务 ${job.id}`)
          result.jobId = job.id
          result.stage = job.stage
          result.submitted = true
          return { handled: true }
        }
        // 文件级判定无需重写：代码确实变了但没有文章需要动。只有「所有源码变更都有
        // 文章认领」才算真的消化完，才刷新基线。
        const blockers = []
        if (attribution?.unmapped.length) {
          blockers.push(`${attribution.unmapped.length} 处源码变更没有任何文章认领：${attribution.unmapped.slice(0, 3).join('、')}`)
        }
        if (blockers.length) {
          notes.push(`未重写任何文章，但有 ${blockers.length} 项未解决 —— ${blockers.slice(0, 3).join('；')}，不刷新编译基线`)
          return { handled: true }
        }
        const meta = await runCw(binary, cwd, ['meta', 'update'], 120000, exec?.signal)
        notes.push(`文件级判定确认全部变更已归属、无需重写，已刷新编译基线（meta update exit ${meta.exitCode}）`)
        return { handled: true }
      }

      if (!needsFullCompile && status.state === 'stale' && status.staleArticles.length) {
        const r = await runStaleUpdate()
        if (r.needFull) notes.push(`增量规划要求全量重编：${r.reason}`)
        if (r.handled) return result
      }

      // stale 但解析不出过期文章
      if (!needsFullCompile && status.state === 'stale' && !status.staleArticles.length) {
        if (status.changedFiles.length) {
          // cw status 说有文件变更却没命中任何文章。旧实现直接 meta update 把基线前移，
          // 等于把没读懂的变化永久丢弃；0.16.0 用文件级归属判定：只有每个变更都被某篇
          // 文章的 source_files 认领，才允许推进基线，否则拒绝并报告未归属清单。
          const baseline = readCompiledBaseline(wikiPath)
          const articles = collectWikiArticles(wikiPath)
          if (baseline && articles.length) {
            const changeSet = collectChangeSet(cwd, baseline)
            if (changeSet.ok) {
              const { unmapped, touched } = attributeChanges(changeSet, articles)
              const byName = new Map(articles.map((a) => [a.name, a]))
              if (touched.size) {
                // 有文章认领了这些变更却没进 cw status 的过期清单：直接按归属补任务
                const tasks = [...touched].map((name) => {
                  const art = byName.get(name)
                  return {
                    name,
                    mission: `更新过期文章 ${name}：以当前代码为准重写其内容，保留章节结构与 title/type/tags（源码变更命中其 source_files）`,
                    sources: art.sources,
                    cwd,
                    articlePath: art.articlePath,
                    prevArticlePath: art.articlePath,
                  }
                })
                const sub = await svc.submit({ kind: 'stale', cwd, wikiPath, scope: effectiveScope, language, prebuiltTasks: tasks, auto, sessionId, changeSet })
                if (sub.skipped) { notes.push(sub.reason); return result }
                notes.push(`cw status 未列出但文件级判定 ${tasks.length} 篇需更新（${tasks.map((t) => t.name).join('、')}），已提交任务 ${sub.job.id}`)
                result.jobId = sub.job.id
                result.stage = sub.job.stage
                result.submitted = true
                return result
              }
              if (unmapped.length) {
                notes.push(`有 ${status.changedFiles.length} 个文件变更，但 ${unmapped.length} 处源码变更没有任何文章认领 —— ${unmapped.slice(0, 3).join('、')}，不刷新编译基线`)
                return result
              }
              const meta = await runCw(binary, cwd, ['meta', 'update'], 120000, exec?.signal)
              notes.push(`有 ${status.changedFiles.length} 个文件变更，文件级判定确认全部已归属且无需重写，已刷新编译基线（meta update exit ${meta.exitCode}）`)
              return result
            }
            notes.push(`变更采集不可用（${changeSet.reason}），不刷新编译基线`)
            return result
          }
          notes.push(`有 ${status.changedFiles.length} 个文件变更但未命中任何文章的 source_files，且无基线/文章可做归属判定，不刷新编译基线（建议 scope=full）`)
          return result
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
      '可选按 cwd（仓库路径）或 jobId 过滤；都不传则列出全部任务。输出含 stage（articles/crosscut/review/index/commit/done/partial/failed/cancelled）、outcome（done=完整成功、partial=部分完成且有未消化变化、failed=无成果）、blockers（未消化的具体原因）、canAdvanceBaseline（是否已推进编译基线）、完成百分比、已写/失败篇数、任务明细、批量进度、阶段耗时、token 用量、notes 与错误。',
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
                nativeStage: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '引擎自报的八段契约阶段（env/graph/cluster/articles/validate/index/baseline/commit），与面板粗粒度 stage 不是一回事' },
                nativePercent: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '引擎自报百分比；长阶段（写文章）按真实篇数插值，不再冻结' },
                nativeMessage: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '引擎当前正在做什么（含正在写的模块名）' },
                nativeLogs: { type: 'array', items: { type: 'object' }, description: '引擎事件日志最近若干条（完整 NDJSON 在 logFile，可用 /api/codewiki/logs 翻全量）' },
                logFile: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '引擎事件日志文件路径（仓库外临时目录）' },
                logError: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '日志落盘失败原因（非空表示日志只剩内存里最近若干条）' },
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
          if (j.nativeStage || j.nativeMessage) {
            lines.push(`  引擎：${j.nativeStage ?? '-'} ${j.nativePercent ?? '-'}%${j.nativeMessage ? ` — ${j.nativeMessage}` : ''}`)
          }
          if (j.logFile) lines.push(`  日志：${j.logError ? `落盘失败（${j.logError}），仅内存最近 ${(j.nativeLogs ?? []).length} 条` : j.logFile}`)
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

// 思考档位合法性：模型目录里的档位表是唯一事实来源。档位配错时 provider 不报错——
// 它回 200 加空内容，桥日志只剩一个 finish chunk、引擎记 "Tokens used: 0"，整轮任务
// 看起来跑完却一篇文章都没写。这种静默失败必须在提交入口拦住，而不是等每篇文章都
// 空跑一遍再靠 note 提示。
// 返回 null = 放行，返回文案 = 拦下。档位表缺失（模型未声明/探测失败）一律放行：
// 「不知道」不等于「不支持」，否则没暴露档位目录的 provider 会被一刀切拦死。
export function effortError(efforts, effort) {
  const want = String(effort ?? '').trim()
  if (!want) return null
  const ids = (Array.isArray(efforts) ? efforts : []).map((e) => String(e?.id ?? '').trim()).filter(Boolean)
  if (!ids.length) return null
  if (ids.includes(want)) return null
  return `思考档位「${want}」不在该模型支持的档位里（可用：${ids.join('/')}）——请在插件设置里改选一个，或留空用模型默认档`
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

// 工作区过滤清单（jobs/repos 展示与自动调度共用）：宿主注册表可用且 workspaceOnly 开启时
// 返回工作区路径清单，否则 null（不过滤，行为与 0.4.8 一致）。
// 语义：调用方用 isExcluded(cwd, paths) 判「在工作区内」——命中即属于某工作区或其子目录。
export function workspaceFilterPaths(registry, config) {
  if (!registry || typeof registry.list !== 'function') return null
  if (liveConfig(config ?? {}).workspaceOnly === false) return null
  let wsList
  try {
    wsList = registry.list() ?? []
  } catch (err) {
    // 宿主注册表内部不一致（如 order references missing workspace）时降级不过滤：
    // 过滤是体验优化，不能拖垮 jobs/repos 端点。
    console.warn('[codewiki] workspaceRegistry.list() 抛错，工作区过滤降级停用：', err?.message ?? err)
    return null
  }
  const wsPaths = wsList.map((w) => w?.path).filter((p) => typeof p === 'string' && p)
  return wsPaths.length ? wsPaths : null
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
  const wsFilterPaths = () => workspaceFilterPaths(workspaceRegistry, config ?? {})
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
          const jobsByCwd = new Map() // 展示用 cwd → 该仓全部候选任务
          const putCwd = (dir, job) => {
            if (!dir) return
            // 编译对象闸门（1.2.1）：worktree 目录与无可编译源码的空壳目录不进仓库总览——
            // 它们永远编译不出东西，出现在总览里只会诱导用户反复手动提交。
            if (isDeadCompileTarget(dir)) return
            const k = normKey(dir)
            const shown = seen.get(k) ?? dir
            seen.set(k, shown)
            if (!jobsByCwd.has(shown)) jobsByCwd.set(shown, [])
            if (job) jobsByCwd.get(shown).push(job)
          }
          // workspaceOnly（默认开）：总览只显示已添加工作区（含其子仓库）——knownRepos/job
          // 历史里的 Temp 沙箱与任意路径目录不再出现；无清单时不过滤。
          // 非终态任务的工作区例外放行（同 jobs 端点）：编译中的仓库必须可见。
          const wsPaths = wsFilterPaths()
          const inWs = (dir) => !wsPaths || isExcluded(dir, wsPaths)
          for (const j of service.list()) if (!JOB_TERMINAL.has(j.stage) || inWs(j.cwd)) putCwd(j.cwd, j)
          for (const dir of loadKnownRepos()) if (inWs(dir)) putCwd(dir, undefined)
          const repos = []
          for (const cwd of seen.values()) {
            const last = pickOverviewJob(jobsByCwd.get(cwd))
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
              // 分工口径：本轮扫到但已有活动任务（幂等命中）、以及判态干净/无变更可做的仓数。
              // 只暴露 submitted 时，「扫到 N 仓、提交 0」无法区分「正在编译」与「无事可做」。
              lastScanBusy: schedState?.lastScanBusy ?? null,
              lastScanNoop: schedState?.lastScanNoop ?? null,
              // 因 workspaceOnly 被跳过（不在已添加工作区里）的仓数：否则「清单里有 N 个仓库、
              // 扫到 M 个」的缺口在面板上无法解释，用户会以为调度器丢了仓库。
              lastScanSkipped: schedState?.lastScanSkipped ?? null,
            },
          }
          reposCacheAt = Date.now()
        }
        // 待确认状态与 needsConfirm 不进 30s 缓存：它随调度心跳实时变化，缓存会让用户
        // 在「已登记待确认」后 30 秒内看不到确认按钮（面板每 2s 拉一次）。这两项每次求值。
        const livePending = (schedState?.pendingConfirm ?? []).map((p) => p.cwd)
        const livePendingKeys = new Set(livePending.map(normPathKey))
        writeJson(res, 200, {
          ...reposCache,
          repos: (reposCache.repos ?? []).map((r) => ({ ...r, needsConfirm: livePendingKeys.has(normPathKey(r.cwd)) })),
          scheduler: { ...reposCache.scheduler, lastScanPending: schedState?.lastScanPending ?? null, pendingConfirm: livePending },
        })
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
          if (jobId) {
            // 单任务会话视图同样要能看出「任务在跑但还没有请求」
            const job = service.list().find((j) => j.id === jobId)
            const active = activeSessionJobs(job ? [job] : [], { requestCount: (id) => listSessionRecords(id).length })
            writeJson(res, 200, { sessions: listSessionRecords(jobId), active })
            return
          }
          // 全局聚合：带上 cwd（面板行里显示是哪个仓库在编译），只给最近 limit 条
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
          const byId = new Map()
          for (const j of service.list()) byId.set(j.id, j.cwd ?? '')
          const sessions = listAllSessionRecords({ limit }).map((s) => ({
            ...s, cwd: byId.get(s.jobId) ?? '',
          }))
          const active = activeSessionJobs(service.list(), { requestCount: (id) => listSessionRecords(id).length })
          writeJson(res, 200, { sessions, active })
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
    // 引擎事件日志：GET /api/codewiki/logs?jobId=&limit=
    // 内存里只留最近 40 条（jobSummary），完整 NDJSON 在仓库外，按需在这里翻。
    // 没有这个端点，用户/排查者只能去临时目录里手工找文件——真机上没人会这么做。
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/logs',
      handler: (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const jobId = String(url.searchParams.get('jobId') ?? '').trim()
          const limit = Number(url.searchParams.get('limit')) || 200
          if (!jobId) { writeJson(res, 400, { error: '缺少 jobId 查询参数' }); return }
          const job = service.list().find((j) => j.id === jobId)
          writeJson(res, 200, {
            jobId,
            stage: job?.stage ?? null,
            channel: job?.channel ?? null,
            logError: job?.logError ?? null,
            stats: logStats(jobId),
            entries: readLogTail(jobId, limit),
          })
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
        // 首次编译确认（0.17.27）：从待确认清单里摘掉并立即提交，语义等于用户手动点编译。
        // 手动路径本来就不需要确认（用户按下按钮就是确认），所以这里不再二次校验。
        if (body?.action === 'confirm' && body?.cwd) {
          if (typeof compile !== 'function') { writeJson(res, 501, { error: '编译入口未初始化' }); return }
          const dir = String(body.cwd)
          const key = path.normalize(dir).replace(/[\\/]+$/, '').toLowerCase()
          if (Array.isArray(schedState?.pendingConfirm)) {
            schedState.pendingConfirm = schedState.pendingConfirm.filter((p) => path.normalize(String(p.cwd ?? '')).replace(/[\\/]+$/, '').toLowerCase() !== key)
          }
          reposCache = null
          try {
            const r = await compile({ cwd: dir, scope: ['auto', 'full', 'stale'].includes(body?.scope) ? body.scope : 'auto' }, {})
            writeJson(res, 200, { ok: true, ...r })
          } catch (err) {
            writeJson(res, 400, { ok: false, error: String(err?.message ?? err) })
          }
          return
        }
        writeJson(res, 400, { error: '未知 action；支持 {"action":"cancel","jobId":"..."} / {"action":"compile","cwd":"..."} / {"action":"confirm","cwd":"..."} / {"action":"refresh"}' })
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
  // 统一关掉 core.quotepath：中文页名在默认设置下会被 git 输出成八进制转义串，
  // 本函数下面所有「读回路径清单」的地方都要能当真实路径用（见 lib/git-paths.js）。
  const run = (...args) => spawnSync('git', withQuotepathOff(args), opts)
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
      .filter((j) => ['done', 'partial'].includes(j.stage) && (j.writtenCount ?? 0) > 0 && j.finishedAt && samePath(j.cwd, cwd))
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
          `【CodeWiki 产物待提交·一次性】本仓库 wiki 编译${latest.stage === 'partial' ? '部分完成' : '已完成'}（任务 ${latest.id}，写入 ${latest.writtenCount} 篇文章），${why}：`,
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
  // 自动调度也要读宿主工作区注册表：workspaceOnly（默认开）的语义是「只处理已添加的
  // dsh 工作区」，如果只有面板过滤遵守它，被移出工作区的仓库仍会被后台定时编译并写入
  // 产物——面板上看不见它在编译，用户也无从取消（0.16.3 修复）。
  let schedWorkspaceRegistry = null
  if (typeof ctx.inject === 'function') ctx.inject(['workspaceRegistry'], (rc) => { schedWorkspaceRegistry = rc?.workspaceRegistry ?? rc })
  const service = createJobService(config, wakeCompileSession)
  service.start()
  // cordis effect：立即执行 body 并把返回值收集为 disposer——必须返回清理函数本身，
  // 写成 () => service.stop() 会在启动时当场停掉服务（返回 undefined 也无 disposer）
  if (typeof ctx.effect === 'function') ctx.effect(() => () => service.stop())
  const generateDef = generateToolDefinition(config, service)
  const updateDef = updateToolDefinition(config, generateDef)
  // 自动更新调度器：60s 心跳，到点对已知工作区逐个 scope=auto 判态提交。
  // 必须合并持久仓库清单与 job 历史：后者最多保留 MAX_JOBS_KEPT 条，且启动会清理
  // Temp 终态；只扫历史会让清单里仍然过期的仓库永久退出自动更新。
  // execute 幂等（活动仓库直接返回现有任务），单仓库失败只记 lastError 不打断扫描。
  // pendingConfirm（0.17.27）：自动调度**不得**替用户决定「这个仓库要不要有 wiki」。
  // 从没有过任何编译任务的仓库先登记在这里，等用户在面板上点「确认编译」；不想要就点
  // 「排除」，进 excludePaths 后再也不会被扫到。判断依据只用 job 历史，不去跑 `cw status`：
  // wiki 只可能由本插件的任务产生，没有任何任务历史 = 从没编译过，这是可证伪的判据。
  // 只在内存里：重启后重新扫一遍会重新登记，而用户点过确认的仓库已经有任务历史，
  // 不会再被登记——持久化反而会留下「确认过但任务被清理」的悬挂条目。
  const schedState = {
    lastScan: 0, scanning: false, lastError: null,
    lastScanRepos: null, lastScanSubmitted: null, lastScanBusy: null, lastScanNoop: null,
    lastScanSkipped: null, lastScanPending: null, pendingConfirm: [],
  }
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
    schedState.lastScanBusy = 0
    schedState.lastScanNoop = 0
    schedState.lastScanSkipped = 0
    schedState.lastScanPending = 0
    try {
      const known = loadKnownRepos()
      const jobList = service.list()
      const cwds = [...new Set([...known, ...jobList.map((j) => j.cwd)].filter(Boolean))]
      // 有过编译任务历史的仓库集合：不在这个集合里的仓库即「从没编译过 wiki」。
      const compiledKeys = new Set(jobList.map((j) => normPathKey(j.cwd)))
      // workspaceOnly（默认开）：只自动处理属于已添加 dsh 工作区（含子目录）的仓库。
      // 只让面板过滤遵守它，会出现「被移出工作区的仓库仍被后台定时编译、产物悄悄写进
      // 它的 .codewiki/，而面板上根本看不到这条任务」——用户既不知道它在编译也取消不了。
      // 已有活动任务不受影响（这里只决定「是否新提交」，不打断进行中的编译）。
      const wsPaths = workspaceFilterPaths(schedWorkspaceRegistry, config ?? {})
      for (const cwd of cwds) {
        if (wsPaths && !isExcluded(cwd, wsPaths)) { schedState.lastScanSkipped++; continue }
        if (isExcluded(cwd, c.excludePaths)) {
          // 已排除的仓库不再需要确认：等确认的条目留着会让面板显示一个用户刚拒绝的仓库
          schedState.pendingConfirm = schedState.pendingConfirm.filter((p) => normPathKey(p.cwd) !== normPathKey(cwd))
          continue
        }
        // worktree 目录静默跳过（1.2.0）：历史任务里可能留着 worktree 路径，不编译也不记错误
        if (isWorktreeCwd(cwd)) continue
        // 空壳目录静默跳过（1.2.1）：扫不出源码的目录永远编译不出东西，submit 闸门虽也会拦，
        // 但在这里先跳掉更省事——不产生 job、不进 queueAhead 的「在等谁」名单。
        if (!hasCompilableSources(cwd)) continue
        schedState.lastScanRepos++
        // 首次编译必须用户确认（0.17.27）：从没有过任何编译任务、磁盘上也没有 wiki 的仓库
        // 只登记，不提交。判据取两者的**交集**，两个单独都不够：
        //   · 只看任务历史：历史被 MAX_JOBS_KEPT 截断或手动清理后，编译过 wiki 的仓库会被
        //     当成首次，用户每次清历史都要重新点一遍确认；
        //   · 只看 status：wiki 目录被删掉的仓库报 missing，但它曾经编译过，用户已经表过态。
        // 只有「没历史 + 没 wiki」才真正是「这次要第一次为它生成 wiki」。有历史的仓库仍然
        // 走原路径，自动调度对它们的额外成本为零（不跑 cw status）。
        if (!compiledKeys.has(normPathKey(cwd))) {
          const binary = resolveBinary(c)
          let state = ''
          try {
            state = parseStatus((await runCw(binary, cwd, ['status'], 20000)).stdout).state
          } catch (err) {
            // 判不出来就不替用户做决定：本轮跳过这个仓库（不提交也不登记），
            // 下一轮重试。错误照旧记进 lastError，面板上看得见。
            schedState.lastError = `${new Date().toISOString()} ${cwd} 判态失败：${String(err?.message ?? err).slice(0, 160)}`
            continue
          }
          if (state === 'missing' || state === 'uncompiled') {
            schedState.lastScanPending++
            if (!schedState.pendingConfirm.some((p) => normPathKey(p.cwd) === normPathKey(cwd))) {
              schedState.pendingConfirm.push({ cwd, at: new Date().toISOString() })
            }
            continue
          }
        }
        try {
          const r = await generateDef.execute({ cwd, scope: 'auto', auto: true }, {})
          // 三个口径分开计：submitted=本轮真提交了编译；busy=已有活动任务（幂等命中，不是没扫到，
          // 也不该算作提交）；noop=判态干净/无变更可做。旧实现只认 submitted，面板上会出现
          // 「扫到 N 仓、提交 0」却看不出到底是在编译还是无事可做。
          if (r?.submitted === true) schedState.lastScanSubmitted++
          else if (r?.jobId) schedState.lastScanBusy++
          else schedState.lastScanNoop++
        } catch (err) {
          schedState.lastError = `${new Date().toISOString()} ${String(err?.message ?? err).slice(0, 200)}`
        }
      }
    } finally { scanning = false; schedState.scanning = false }
  }
  const scanTimer = setInterval(() => { void autoScan() }, Math.max(100, Number(process.env.DSH_CODEWIKI_AUTO_SCAN_MS) || 60000))
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
