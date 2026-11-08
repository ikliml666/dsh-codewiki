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
import { collectChangeSet } from './lib/change-set.js'
import { withQuotepathOff } from './lib/git-paths.js'
import {
  buildUpdateRecord, saveUpdateRecord,
  describeOutcome, TERMINAL, UPDATE_RECORD_REL,
} from './lib/update-record.js'
// 阶段 4：原生引擎（FSoft Python）通道。整条裁决链在 native-run.js 里固定，
// 这里只负责「起进程 / 收进度 / 按结果判终态」——绝不在 tick 里重写裁决。
import { runNativeJob, DEFAULT_ENGINE_ENTRY, DEFAULT_ENGINE_TIMEOUT_MS } from './lib/engine/native-run.js'
import {
  createJobsStore, mergeJobLists, findActiveJob, reassignSession,
  snapshotNativeRun, planNativeReplay, heartbeat, adoptOrphan, lastSeenAt,
  planForeignJob, FOREIGN_ACTION,
} from './lib/job-store.js'
import { appendLog, readLogTail, logStats, logFileOf as logFileFor } from './lib/job-logs.js'
import { mergeUnconsumed, readState, NATIVE_STATE_DIR, STATE_REQUIRED_DOCS, graphFileName, stateDocsDir } from './lib/engine/native-state.js'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-codewiki'
export const name = PLUGIN_NAME
const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']
// 编译请求（同步 chat/completions）并发上限
const CONCURRENCY_HARD_CAP = 8
// 默认并发：2 路并发足够，且不触发上游限流（glm-5.3-flash 实测无压力）
const DEFAULT_CONCURRENCY = 2
// 编译模型没有默认值：provider/model 一律由用户在设置页选定。
// 早先默认 volces-ark/glm-5.3-flash，等于替用户拍板「用这个模型编译」——模型目录、
// 凭证、上下文窗口都随环境不同，猜错的表现是上游 200 + 空内容静默空跑（见 effortError 注释）。
// 留空的后果在提交任务时显式报错（见 submitJob 的唯一模型通道校验），不会静默失败。
// 大档单请求输入预算：模型 512k 上下文，留出输出与系统提示余量后取 420k
// 单模块写作的 LLM 请求上限（上游叫 request_limit）：上游默认 100，但 1b4af43 起
// 写作校验会为写不出页面的模块续发最多 2 次补写提醒，每次提醒各自吃一份预算；
// 真机上 change_set_management 模块撞满 100 次请求后抛错，已写好的 31 篇被记成 partial。
// 300 是「大模块一轮能写完」的经验上限，同时保留硬顶 1000 防止配置失误拖成一小时。
const DEFAULT_REQUEST_LIMIT = 100  // 上游写作 agent 的默认单模块请求预算
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
  batchProvider: z.string().default('').volatile().description('编译模型提供商（必须是 DSH 模型设置里已注册的 provider id）：batchModel 填该 provider 的模型 id。留空将无法提交任务'),
  batchModel: z.string().default('').volatile().description('编译模型（全部模型环节共用）：该 provider 下的模型 id。留空将无法提交任务'),
  batchReasoningEffort: z.string().default('').volatile().description('思考程度（该模型的 reasoning effort 档位 id）：留空=用模型的默认档；可选值由模型目录实时读取（/api/codewiki/model-efforts）'),
  effortByStage: z.dict(z.string()).default({}).volatile().description('按环节分别设思考档位：key 是阶段名（graph/cluster/articles/proofread/validate/index/baseline/commit），value 是该环节的 reasoning effort 档位。缺省用 batchReasoningEffort 兜底；留空的环节也走兜底'),
  maxConcurrency: z.number().default(DEFAULT_CONCURRENCY).volatile().description('默认档并发上限（1–8），硬顶 8；默认 2'),
  moduleConcurrency: z.number().default(0).volatile().description('原生引擎的模块生成并行度（1–8），硬顶 8：留空或 0 = 跟随默认档并发（真机实测 2× 时吞吐 2.9×）；填 1 = 上游原本的严格串行（一篇约 12 分钟）。同一拓扑层的模块并发写文档，父模块仍等全部子模块；调大能明显缩短编译墙钟，代价是同批 LLM 请求更密集'),
  requestLimit: z.number().default(DEFAULT_REQUEST_LIMIT).volatile().description('单个模块写作的 LLM 请求上限（1–1000，硬顶 1000）：上游写作 agent 用它做单次 run 的预算，写不完会续发补写提醒，每次提醒各自一份预算。默认 100（上游默认值）；调小能压住单模块成本，调大能减少大模块被预算中断的补写次数'),
  serialProjects: z.boolean().default(true).volatile().description('单项目串行：同一时刻只推进一个仓库的编译任务，其余排队（queued），当前任务收尾后自动轮到下一个。关闭后按 parallelProjects 并行推进多个仓库'),
  parallelProjects: z.number().default(2).volatile().description('并行推进的仓库编译任务上限（1–4）：关闭单项目串行后生效。默认 2——多仓库同时编译不再互相排队；额度紧张或限流时调回 1 或开启串行'),
  articleLanguage: z.string().default('中文').volatile().description('wiki 文章书写语言'),
  updateReminder: z.boolean().default(true).volatile().description('会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，收尾时提醒更新 wiki）'),
  autoCommit: z.boolean().default(true).volatile().description('编译完成后由插件自己在主题分支上提交产物再合并回原分支（只 add .codewiki/ 与 CodeWiki.md，建议 docs(wiki) 前缀；不动其它改动）：会话模型因此无需等待编译完成、也无需提交；非 git 仓库或提交失败时降级为提醒会话模型提交'),
  excludePaths: z.string().default('').volatile().description('排除清单：这些目录（含子目录）不编译 CodeWiki。换行/分号/逗号分隔绝对路径'),
  autoUpdate: z.boolean().default(false).volatile().description('自动更新：定时扫描已编译过的工作区，检测到变更自动提交增量编译（scope=auto）'),
  autoUpdateMin: z.number().default(30).volatile().description('自动更新扫描间隔（分钟），最小 5'),
  workspaceOnly: z.boolean().default(true).volatile().description('任务页只显示属于已添加 dsh 工作区（宿主工作区列表）的任务'),
  nativeEngine: z.boolean().default(true).volatile().description('编译开关：开启后走上游 FSoft Python 引擎的「环境→图→聚类→文章→校验→索引→基线→提交」流水线，终态由质量门+落地器严格裁决。引擎需要本机 Python 3.10+ 与闭合的依赖环境（tools/fsoft-engine/setup-env.sh），环境不闭合时以 engine-deps 明确失败'),
  nativeEnginePython: z.string().default('').volatile().description('原生引擎的 Python 解释器路径（装了 FSoft 引擎的 venv 里的 python）：留空依次用环境变量 DSH_CODEWIKI_PYTHON、PATH 里的 python'),
  nativeEngineEntry: z.string().default('').volatile().description('原生引擎入口脚本（默认插件自带 lib/engine/python/entry.py）'),
  nativeEngineTimeoutMs: z.number().default(0).volatile().description('原生引擎单次编译超时（毫秒）：0=用默认 180 分钟（真机全量实测约 174 分钟）；超时由进程树终止兜底，已写文章按 partial 抢救'),
  techdocs: z.boolean().default(false).volatile().description('TechDocs 站点导出（上游 a1b9f4a 的 PR #155）：每轮编译后额外产出一份 mkdocs 站点到 .codewiki/_techdocs/（mkdocs.yml + docs/），可直接交给 Backstage TechDocs 渲染。站点内容来自引擎原始产物，与 .codewiki/modules/ 里那批过了质量门、链接改写过的正式文章不同。默认关闭：它是给文档站点发布用的附加产物，会让每轮提交多出 37 个文件'),
  updateRung: z.string().default('').volatile().description('增量档位（上游 ablation rung）：3=组件级增量（默认，全部能力）；3b=同 3 但依赖跟两跳（k_hop=2，影响面更大）；2=只重写受影响的叶子页、不原地打补丁；1=纯规则失效、不开路由/增长重聚类/依赖扩散/陈旧扫描；0=放弃组件级增量、退化成按文件失效的全量重写（每轮都重写全部文章，最慢）。留空=上游默认 3'),
  updateTauNb: z.string().default('').volatile().description('增量阈值 tau_nb（0–1，路由判据）：一个叶子里聚集了多少比例的新增组件邻居才把图 diff 路由到该叶子。留空=上游默认 0.5'),
  updateTauGrow: z.string().default('').volatile().description('增量阈值 tau_grow（0–1）：新增组件占多少比例会触发整体重聚类。留空=上游默认 0.33'),
  updateTauFull: z.string().default('').volatile().description('增量阈值 tau_full（0–1）：活跃叶子占全部叶子的比例超过它就整仓重写而不是增量。留空=上游默认 0.5；调大=更倾向增量（更快但可能漏改），调小=更倾向重写（更准但更慢）'),
  updateTauTree: z.string().default('').volatile().description('增量阈值 tau_tree（0–1）：新建+删除+重聚类的叶子占比超过它就整仓重写。留空=上游默认 0.3'),
})

function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}

// 上游增量档位（ablation rung）：0/1/2/3/3b。空串 = 不传给引擎，用上游默认值。
// 档位语义写在 Config 的 description 里，与上下游保持一致。
const VALID_UPDATE_RUNGS = ['0', '1', '2', '3', '3b']

// 阈值一律按「留空 = 用上游默认」处理，所以空串/NaN/越界都返回 undefined，
// 交给 native-run 决定要不要写进 updateOptions。
// 为什么不在这里兜底成默认值：上游改默认时插件会跟着漂移，而档位语义本来就是上游的。
function ratioOf(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined
  return n
}

// 增量参数。只有增量轮（RESOLUTION.UPDATE）才会被 native-run 下发，
// 但档位本身要能被全量轮读到：rung=0 的含义是「放弃组件级增量」，
// 那就不该再被评为 UPDATE —— 详见 nativeChannelFor 之后的 resolution 决议。
export function updateOptionsOf(cfg) {
  const rung = String(cfg?.updateRung ?? '').trim()
  if (rung && !VALID_UPDATE_RUNGS.includes(rung)) {
    throw new Error(`updateRung=${rung} 不合法，可选值：${VALID_UPDATE_RUNGS.join(' / ')}`)
  }
  const opts = {}
  if (rung) opts.rung = rung
  const ratios = {
    tau_nb: ratioOf(cfg?.updateTauNb),
    tau_grow: ratioOf(cfg?.updateTauGrow),
    tau_full: ratioOf(cfg?.updateTauFull),
    tau_tree: ratioOf(cfg?.updateTauTree),
  }
  for (const [k, v] of Object.entries(ratios)) if (v !== undefined) opts[k] = v
  return opts
}

// 配置 → 内部运行参数。
export function liveConfig(config) {
  const c = config ?? {}
  const concurrency = Number(val(c.maxConcurrency))
  return {
    enabled: val(c.enabled) ?? true,
    binaryPath: String(val(c.binaryPath) ?? '').trim(),
    batchProvider: String(val(c.batchProvider) ?? '').trim(),
    batchModel: String(val(c.batchModel) ?? '').trim(),
    batchReasoningEffort: String(val(c.batchReasoningEffort) ?? '').trim(),
    // 按环节分别设思考档位：key 是 ENGINE_STAGES 里的阶段名（graph/cluster/articles/...），
    // value 是该环节的 reasoning effort 档位。缺省（空对象或该环节没配）用 batchReasoningEffort 兜底。
    effortByStage: (() => {
      const raw = val(c.effortByStage)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const out = {}
      for (const [k, v] of Object.entries(raw)) {
        const s = String(v ?? '').trim()
        if (s) out[String(k).trim()] = s
      }
      return out
    })(),
    maxConcurrency: Number.isFinite(concurrency) && concurrency >= 1
      ? Math.min(concurrency, CONCURRENCY_HARD_CAP)
      : DEFAULT_CONCURRENCY,
    // 原生引擎的模块生成并行度：与 maxConcurrency（LLM 请求并发）是两个独立的设置项，
    // 不能混用同一个值——0/未填 时跟随默认档并发。
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
    // TechDocs 站点导出：缺省关闭（附加产物，不是每轮都需要）
    techdocs: val(c.techdocs) === true,
    // 增量档位与阈值：原样透出（空串=用上游默认）。合法性在提交时由
    // updateOptionsOf 显式校验——配置边界只校验一次，下游不再逐层判空。
    updateRung: String(val(c.updateRung) ?? '').trim(),
    updateTauNb: String(val(c.updateTauNb) ?? '').trim(),
    updateTauGrow: String(val(c.updateTauGrow) ?? '').trim(),
    updateTauFull: String(val(c.updateTauFull) ?? '').trim(),
    updateTauTree: String(val(c.updateTauTree) ?? '').trim(),
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
// 原生引擎通道：上游 FSoft Python 引擎 + 薄适配层
//
// 语义（务必分清，否则会「以为换了通道其实没换」）：
//   nativeEngine          = 编译开关（关掉后不编译，没有替代通道）
//   nativeEnginePython    = 引擎解释器（装了 FSoft 的 venv python）
// full 与 stale 增量都接管；具体走 generate 还是 update 由 native-run.js 依 change-set
// 与受管状态决议，这里只如实把 scope 传下去。环境不闭合以 engine-deps 明确失败，
// 绝不中途换用其它实现冒充成功。
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
// 不知道也不该知道模型选择）。不能用 `bridge.model`：它恒为 undefined → 
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
// vendor/codewiki/FORK.md。
export function normalizeArticlePath(p) { return String(p ?? '').replace(/\\/g, '/') }


export function parseStatus(stdout) {
  const s = stdout ?? ''
  if (s.includes('No wiki found')) return { state: 'missing', changedFiles: [], staleArticles: [], wikiChanges: [] }
  if (s.includes('has not been compiled yet')) return { state: 'uncompiled', changedFiles: [], staleArticles: [], wikiChanges: [] }
  if (s.includes('Wiki is up to date')) return { state: 'clean', changedFiles: [], staleArticles: [], wikiChanges: [] }
  const changedFiles = []
  const staleArticles = []
  for (const m of s.matchAll(/^\s+[M!]\s+(.+)$/gm)) {
    const line = m[1].trim()
    if (m[0].trimStart().startsWith('M')) changedFiles.push(normalizeArticlePath(line))
    else staleArticles.push(normalizeArticlePath(line))
  }
  // wiki 产物目录要从变更清单里摘出去：编译基线落在产物提交**之前**（提交内容里写着
  // last_compiled_commit，无法自指），于是 `git diff 基线..HEAD` 永远会把整批 .codewiki/
  // 算成变更。不过滤的话，编译刚跑完工作区明明是干净的，面板上还是「有变更」。
  // 判据与 lib/change-set.js 的 isWikiProduct 一致：只看 .codewiki/。
  const isWiki = (p) => p === '.codewiki' || p.startsWith('.codewiki/')
  const wikiChanges = changedFiles.filter(isWiki)
  const sourceChanges = changedFiles.filter((p) => !isWiki(p))
  // 剩下的只有产物时，对「源码有没有变」而言就是最新——不留在 stale 状态里。
  const state = sourceChanges.length || staleArticles.length ? 'stale' : 'clean'
  return { state, changedFiles: sourceChanges, staleArticles, wikiChanges }
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


// 统一文章契约闸门（吸收自 FSoft 的文章质量门）：所有写盘点都过这里，不再各查一段。
// 拒写判据只看 error 级——结构已破坏（重复 frontmatter/正文、围栏未闭合、source_files
// 不存在或不是本次读取的证据、死链、正文空、必需章节空着）；warning 级（缺章节）放行
// 但记账，由终态判定把本次编译降为 partial，不推进基线。
// 返回 { blocking:[], warnings:[] }。





// ---------------------------------------------------------------------------
// 模型执行（唯一通道：宿主 llm 服务）
// 语义校对等单轮调用走这里，模型/提供商/思考档位全部取自插件设置里选中的
// 「模型设置」条目，凭证由宿主按该 provider 解析。
// ---------------------------------------------------------------------------


function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
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
// 判「这一轮没有任何可做的事」：工作区与已提交范围里都没有源码变化，受管状态齐备，
// 且受管状态记录的消费范围已经覆盖当前 cw 基线。
//
// 为什么需要这道判定：原生通道要接住 clean（cw status 只看 committed，看不见工作区变化），
// 结果 AutoScan 每小时把每个仓库都提交成一条任务，真跑起来仍要 3 分钟以上的依赖分析，
// 之后才发现「变化 0 项」。真机上 11-06 那一小时就有 4 个仓库各跑了两轮纯空转。
//
// 判据必须乐观（宁可漏跳也不许丢变化），任何一项判不准都返回 null（=照常提交）：
//   · 变更采集失败 → 不知道有没有变化，不跳；
//   · 受管状态缺件 → 引擎会转全量，不跳；
//   · 记录的 headCommit ≠ 当前 cw 基线 → 有别的任务前移过基线，范围对不上，不跳。
//
// 导出是给 test-batch.mjs 直接测的：它只是「读磁盘 + 比集合」的纯判定，不需要跑完整
// generate 链路就能把「该跳 / 不该跳」两个方向都钉住。
export function idleNativeReason({ cwd, wikiPath }) {
  const baseline = readCompiledBaseline(wikiPath)
  if (!baseline) return null
  const cs = collectChangeSet(cwd, baseline)
  if (!cs.ok) return null
  const st = readState(NATIVE_STATE_DIR, cwd)
  if (!st.ok) return null
  const state = st.state
  // 用 headCommit 而不是 baseCommit 对基线：cw meta update 写在基线阶段，取的是那
  // 一刻的 HEAD，也就是本轮跑完时的 headCommit；baseCommit 是本轮开始时的旧基线，
  // 天然落后（这是「基线永远落后一个产物提交」的另一面）。
  // 两者相等只能说明「受管状态与 cw 基线出自同一轮」，有没有新变化仍由下面的
  // effectiveChanges 判——之后 HEAD 前进了的话，changeSet 里就有 committed 变化。
  const recordedHead = String(state?.consumedRange?.headCommit ?? '')
  if (recordedHead !== baseline) return null
  const docs = stateDocsDir(path.join(cwd, NATIVE_STATE_DIR))
  for (const rel of STATE_REQUIRED_DOCS) {
    if (!fs.existsSync(path.join(docs, ...rel.split('/')))) return null
  }
  if (!fs.existsSync(path.join(docs, 'temp/dependency_graphs', graphFileName(cwd)))) return null
  const merged = mergeUnconsumed({ changeSet: cs, prevUnconsumed: Array.isArray(state?.unconsumed) ? state.unconsumed : [] })
  if (merged.effectiveChanges.length) return null
  return `工作区与已提交范围都没有源码变化，受管状态齐备且已覆盖基线 ${baseline.slice(0, 7)}——跳过本轮，不提交任务`
}

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
// learnings/decisions 已无产出，列进来是为了照看别的仓库里的历史残留页。
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




async function wikiPathFor(cwd, binary, signal) {
  const r = await runCw(binary, cwd, ['path'], 30000, signal)
  const p = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (r.exitCode === 0 && p) return p
  return path.join(cwd, '.codewiki') // 与 wiki_path() 一致：wiki 在仓库内
}

// ---------------------------------------------------------------------------
// 编排服务：任务机
// codewiki_generate 只判态与提交；服务以 10s tick 推进任务，编译本身交给原生引擎
// （lib/engine/native-run.js 的裁决链），终态由质量门与落地器判决。
// ---------------------------------------------------------------------------

// 测试可设 DSH_CODEWIKI_JOBS_FILE 隔离到独立路径——默认路径与真实宿主实例共享，
// 宿主周期 flush 会用其内存副本整写同一文件，测试期间互相洗掉对方的内存字段（tps 采样 flaky 的根因）
const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')
const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)
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
  const p = path.join(sessionDirFor(jobId), `${String(meta.n).padStart(3, '0')}.meta.json`)
  const text = JSON.stringify(meta)
  try {
    fs.mkdirSync(sessionDirFor(jobId), { recursive: true })
    fs.writeFileSync(p, text, 'utf8')
  } catch { /* tmp 不可写则放弃记录，不影响编译 */ return }
  // 刚写完又读时不该再摸一次磁盘，也不该让长度比对看到半截状态。
  rememberSessionMeta(p, meta, text.length)
}
function writeSessionFull(jobId, n, full) {
  try {
    const dir = sessionDirFor(jobId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${String(n).padStart(3, '0')}.full.json`), JSON.stringify(full), 'utf8')
  } catch { /* 同上 */ }
}
// 会话列表每 5s 轮询一次，而全库 meta 有两千多条：真机实测读全部（readdir + stat + read + parse）
// 冷 125ms、热 46ms，其中 stat 38ms、read 56ms —— 轮询成本几乎全在这两处。
//
// 关键事实：终态 meta（status 不是 running）写完之后再不会被写——实测 2068 条终态记录的 mtime
// 与 finishedAt 偏差全部为 0，写入路径也只有 onDone/onError 各一次。所以一旦读到终态，它永久有效；
// 只有仍在跑的记录需要确认有没有更新，而它每次追加只会变大，比 size 就够，不用 mtime。
const sessionMetaFrozen = new Map() // 绝对路径 -> 终态 meta，读到就不再碰磁盘
const sessionMetaLive = new Map() // 绝对路径 -> { size, meta }，仅运行中的记录
function readSessionMetaCached(p) {
  const frozen = sessionMetaFrozen.get(p)
  if (frozen) return frozen
  const cur = sessionMetaLive.get(p)
  let meta
  if (cur) {
    let st
    try { st = fs.statSync(p) } catch { return null }
    if (st.size === cur.size) return cur.meta
    meta = readJsonFile(p)
  } else {
    meta = readJsonFile(p)
  }
  if (!meta) return null
  rememberSessionMeta(p, meta, JSON.stringify(meta).length)
  return meta
}
// 运行中的记录按序列化长度判变化：它只会被追加内容，长度必然变大。
function rememberSessionMeta(p, meta, size) {
  sessionMetaLive.delete(p)
  sessionMetaFrozen.delete(p)
  if (meta.status !== 'running') sessionMetaFrozen.set(p, meta)
  else sessionMetaLive.set(p, { size, meta })
}
// 列表：只读 meta 文件（轻量），按 n 倒序（最新在前）
// limit：只解析最新的 N 条。文件名是零填充的 ${n}.meta.json，倒序文件名序即倒序 n，
// 所以可以先排序再只 parse 前 N 个——446 条的旧任务是常态，全量解析只为截前 80 条是白费。
export function listSessionRecords(jobId, limit = 0) {
  const dir = sessionDirFor(jobId)
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const metas = names.filter((f) => f.endsWith('.meta.json')).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
  const picked = limit > 0 ? metas.slice(0, limit) : metas
  return picked
    .map((f) => readSessionMetaCached(path.join(dir, f)))
    .filter(Boolean)
}
export function readSessionRecord(jobId, n) {
  return readJsonFile(path.join(sessionDirFor(jobId), `${String(n).padStart(3, '0')}.full.json`))
}
// 会话详情：面板一次要显示 prompt / 输出 / 思考 / 工具调用，还要知道这一条属于哪个阶段。
// full 里有内容但没有阶段与统计（它们只在 meta 里），所以详情要把两个文件合起来返回——
// 让前端自己再去拉一次 meta 等于把「这条是干嘛的」留成空白。
export function readSessionRecordDetail(jobId, n) {
  const full = readSessionRecord(jobId, n)
  if (!full) return null
  const meta = readSessionMetaCached(path.join(sessionDirFor(jobId), `${String(n).padStart(3, '0')}.meta.json`))
  // 正在生成的 full 还没落思考与工具快照（它们随 3s 节流写），meta 上的计数是内存里最新的
  return {
    ...meta,
    ...full,
    stage: full.stage ?? meta?.stage ?? null,
    status: meta?.status ?? (full.finishedAt ? 'done' : 'running'),
    outputChars: meta?.outputChars ?? String(full.output ?? '').length,
    reasoningChars: meta?.reasoningChars ?? String(full.reasoning ?? '').length,
    toolCalls: meta?.toolCalls ?? (Array.isArray(full.tools) ? full.tools.length : 0),
    inputTokens: meta?.inputTokens ?? null,
    outputTokens: meta?.outputTokens ?? full.outputTokens ?? 0,
    model: meta?.model ?? null,
    provider: meta?.provider ?? null,
    finishedAt: meta?.finishedAt ?? full.finishedAt ?? null,
    error: full.error ?? meta?.error ?? null,
  }
}
// 只要条数：会话端点给每个在跑的任务算「已发几个请求」，此前走 listSessionRecords 读全部
// meta 再取 .length —— 1718 个 meta 单次 70ms，而全局端点每个活跃任务都要算一次。
// 只数文件名 2.4ms，同一个数量级的结果。
export function countSessionRecords(jobId) {
  try { return fs.readdirSync(sessionDirFor(jobId)).filter((f) => f.endsWith('.meta.json')).length } catch { return 0 }
}
// 全局条数：面板要显示「共 N 条」并据此决定还能不能再加载，同样只数文件名。
export function countAllSessionRecords() {
  let dirs
  try { dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) } catch { return 0 }
  let total = 0
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    total += countSessionRecords(d.name)
  }
  return total
}
// 全局会话列表（1.2.0）：跨所有任务聚合请求记录，按 startedAt 倒序，前面带 jobId。
// 用途是面板顶部那个「会话」Tab——不进任何任务行就能看到「codewiki 现在在跟模型说什么」。
// 只读 meta 文件（轻量），full 全文仍按 (jobId, n) 单条拉取。limit 兜底防目录过大。
export function listAllSessionRecords({ limit = 200, jobIds = null } = {}) {
  let dirs
  try { dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) } catch { return [] }
  const out = []
  const cap = Math.max(1, limit)
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    // 目录名是 jobId 的 sanitize 形式；jobId 本身只含 [\w-]，通常恒等
    if (jobIds && !jobIds.has(d.name)) continue
    const dir = path.join(SESSIONS_DIR, d.name)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    // 每个目录只需保留最新 cap 条：结果按时间取前 cap，单个任务最多贡献 cap 条，
    // 更早的不可能进前 cap。文件名零填充，倒序文件名即倒序 n。
    const metas = names.filter((f) => f.endsWith('.meta.json')).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
    for (const f of metas.slice(0, cap)) {
      const meta = readSessionMetaCached(path.join(dir, f))
      if (meta) out.push({ ...meta, jobId: d.name })
    }
  }
  // 排序键：startedAt 优先，缺失时退到 n（同一 job 内 n 递增）。
  // 这里刻意不用 localeCompare：两千条记录上它是 8ms 对 0.4ms，而两者的键是 ISO 时间串，
  // 只含数字与 T/Z/./: ——词法序即时间序，不需要语言环境比较的开销。
  out.sort((a, b) => {
    const x = String(b.startedAt ?? '')
    const y = String(a.startedAt ?? '')
    return x === y ? (b.n ?? 0) - (a.n ?? 0) : x < y ? -1 : 1
  })
  return out.slice(0, Math.max(1, limit))
}
// 进行中任务：会话页不能只读「LLM 请求记录」——记录只在真的发出请求后才存在，
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
  out.sort((a, b) => {
    const x = String(b.startedAt ?? '')
    const y = String(a.startedAt ?? '')
    return x === y ? 0 : x < y ? -1 : 1
  })
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
        if (nowMs - st.mtimeMs > ttlMs) {
          fs.rmSync(p)
          removed += 1
          sessionMetaFrozen.delete(p)
          sessionMetaLive.delete(p)
        } else left += 1
      } catch { /* 单文件失败不拖累整轮 */ }
    }
    if (!left) { try { fs.rmdirSync(dir) } catch { /* 非空/占用则留着 */ } }
  }
  return removed
}
// 把流式 chunk 归成三类增量：正文、思考、工具调用。
// 必须按 type 分流，不能只认 {text}：DSH 的 chunk 是 {type:'reasoning-delta', text} 与
// {type:'tool-call-delta', id, name, argumentsDelta}，打开思考档时正文可能一个 token 都没有。
// 旧实现只取 text/delta.text/content，于是「模型想了上千条 reasoning-delta」被记成空输出——
// 面板里那些「打开没有内容」的请求，其实是记录环节把内容丢了，不是模型没干活。
function sessionDeltaOf(chunk) {
  if (typeof chunk === 'string') return chunk ? { text: chunk } : null
  if (!chunk || typeof chunk !== 'object') return null
  const type = String(chunk.type ?? '')
  const text = typeof chunk.text === 'string'
    ? chunk.text
    : typeof chunk.delta?.text === 'string'
      ? chunk.delta.text
      : typeof chunk.content === 'string'
        ? chunk.content
        : ''
  if (type === 'reasoning-delta') return text ? { reasoning: text } : null
  if (type === 'tool-call-delta') {
    const name = chunk.name ?? chunk.toolName ?? null
    const args = chunk.argumentsDelta ?? chunk.arguments ?? ''
    if (!name && !args) return null
    return { tool: { id: chunk.id ?? chunk.toolCallId ?? null, name, args } }
  }
  return text ? { text } : null
}
// 开始记录一个请求：写 meta（status:running）+ full（prompt 全文），返回句柄给并发池回调。
// task.stage 是发起时的引擎阶段（native 通道由桥的 setStage 同步，batch/agentic 通道由调用点
// 显式给出）——会话记录本身没有阶段字段，而面板要按「流程走到哪一步」给请求分类，只能在这里落下来。
// 历史记录没有 stage，面板按「未标注」归组，不回填、不猜。
export function beginSessionRecord(job, task) {
  const n = (job.sessionSeq ?? 0) + 1
  job.sessionSeq = n
  const startedAt = new Date().toISOString()
  // 思考档打开时正文可能为空：光看 outputChars 会把「想了 1000 段」的请求显示成空。
  // 三个计数分开记，面板才能如实说明「这条请求的内容在思考里」。
  const meta = {
    n, jobId: job.id, name: task.name, model: task.model || null, provider: task.provider || null,
    stage: task.stage || null,
    startedAt, finishedAt: null, status: 'running',
    inputTokens: estimateTokens(task.batchPrompt),
    outputChars: 0, reasoningChars: 0, toolCalls: 0, outputTokens: 0,
  }
  const full = { n, jobId: job.id, name: task.name, stage: meta.stage, startedAt, prompt: task.batchPrompt ?? '', output: '', reasoning: '', tools: [] }
  writeSessionMeta(job.id, meta)
  writeSessionFull(job.id, n, full)
  let out = ''
  let think = ''
  // tool-call-delta 是按分片流下来的（argumentsDelta 逐个拼），必须按 id 合并成整条，
  // 否则一次调用会被记成几十条半截 JSON。
  const tools = new Map()
  let toolSeq = 0
  let lastFlush = 0
  return {
    onDelta(chunk) {
      const d = sessionDeltaOf(chunk)
      if (!d) return
      if (d.text) out += d.text
      if (d.reasoning) think += d.reasoning
      if (d.tool) {
        const id = d.tool.id ?? `#${toolSeq}`
        if (!d.tool.id) toolSeq += 1
        const cur = tools.get(id) ?? { id: d.tool.id ?? null, name: d.tool.name ?? null, args: '' }
        if (d.tool.name && !cur.name) cur.name = d.tool.name
        cur.args += d.tool.args ?? ''
        tools.set(id, cur)
      }
      meta.outputChars = out.length
      meta.reasoningChars = think.length
      meta.toolCalls = tools.size
      const now = Date.now()
      if (now - lastFlush >= SESSION_FLUSH_MS) {
        lastFlush = now
        writeSessionFull(job.id, n, { ...full, output: out, reasoning: think, tools: [...tools.values()] })
      }
    },
    onDone(content, outputTokens) {
      meta.status = 'done'
      meta.finishedAt = new Date().toISOString()
      // 完成时的全文是权威值；流式没抽到正文（只吐了思考）时保留思考，不把它当空。
      if (typeof content === 'string' && content) out = content
      meta.outputChars = out.length
      meta.reasoningChars = think.length
      meta.toolCalls = tools.size
      meta.outputTokens = outputTokens ?? 0
      writeSessionMeta(job.id, meta)
      writeSessionFull(job.id, n, {
        ...full, output: out, reasoning: think, tools: [...tools.values()],
        finishedAt: meta.finishedAt, outputTokens: meta.outputTokens,
      })
    },
    onError(err) {
      meta.status = 'error'
      meta.finishedAt = new Date().toISOString()
      meta.error = String(err?.message ?? err).slice(0, 300)
      meta.outputChars = out.length
      meta.reasoningChars = think.length
      meta.toolCalls = tools.size
      writeSessionMeta(job.id, meta)
      writeSessionFull(job.id, n, {
        ...full, output: out, reasoning: think, tools: [...tools.values()],
        error: meta.error, finishedAt: meta.finishedAt,
      })
    },
  }
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
// 每轮都会去扫那些早已删除的目录（真机见过宿主清单里躺着已删的 cw-orch-*）。
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
// 终态集合：partial 表示「部分完成」——写成的文章可以入库，
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

const jobsStore = createJobsStore({ file: JOBS_FILE, maxKept: MAX_JOBS_KEPT, instanceTag: 'global' })

function loadJobs() {
  const snap = jobsStore.load()
  if (snap.state === 'ok' || snap.state === 'missing') return snap.jobs
  throw new Error(`CodeWiki 任务现场不可读：${snap.error ?? snap.state}；为避免重复编译，已拒绝把损坏现场当作空任务`)
}

function saveJobs(jobs) {
  jobsStore.save(jobs)
}

// nativeResult 只留两个裁决结论：面板读 gate.outcome / apply.outcome（client.js jobCard），
// 其余明细（gate.articles 57 项、incremental 现场）在 job 内存与引擎里都在，不靠这份轮询推送。
function nativeResultBrief(nr) {
  if (!nr || typeof nr !== 'object') return null
  return {
    outcome: nr.outcome ?? null,
    stage: nr.stage ?? null,
    gate: nr.gate ? { outcome: nr.gate.outcome ?? null } : null,
    apply: nr.apply ? { outcome: nr.apply.outcome ?? null } : null,
  }
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
    // 插件自动提交结果：面板与 codewiki_progress 共用同一份 jobSummary，
    // 缺了这个字段两处都拿不到，只能从 notes 里猜。
    autoCommit: job.autoCommit ?? null,
    // 原生通道（阶段 4）：channel 决定这条任务是「谁在跑」，nativeStage 是引擎自己
    // 报的真实阶段（八段契约），与面板步骤条的粗粒度 stage 不是一回事，两个都要给。
    channel: job.channel ?? 'legacy',
    nativeStage: job.nativeStage ?? null,
    // 引擎八段的真实耗时（ms）。面板的 stageTimings 只有粗粒度五段，
    // prepare 一格吞了 env/graph/cluster 三段，拆不开就看不到「时间花在哪」。
    nativeStageTimings: job.nativeStageTimings ?? null,
    nativePercent: job.nativePercent ?? null,
    nativeMessage: job.nativeMessage ?? null,
    nativeTotal: job.nativeTotal ?? null,
    // 原生通道结果（已裁剪）：这份结构里 gate.articles（57 项、11KB）与
    // incremental.hydrated/stateCaptured（各 66 项、3.2KB）占了整个 payload 的大半，
    // 而面板只用 gate.outcome 与 apply.outcome 两个短字符串。2s 轮询下等于每秒
    // 重复推送十几倍无用数据，30 个任务时接口 600KB/285ms。裁剪在组装处，不改引擎侧。
    nativeResult: nativeResultBrief(job.nativeResult),
    // 引擎事件日志：内存里最近 40 条给面板即时看；完整 NDJSON 在仓库外的
    // 临时目录（见 lib/job-logs.js），端点 /api/codewiki/logs 按需翻全量。
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

// llm 服务引用：cordis 严格语义下直接访问 ctx.llm 会抛「cannot get property "llm"
// without inject」（0.8.5 前的 typeof 守卫拦不住）。插件内全部模型环节都靠它，
// apply 时经 ctx.inject(['llm']) 在注入时取服务。
let llmRef = null

// 编译产物的入库状态：自动提交的成功/无改动/失败三态由一处判定，commitHintText 与
// 系统提示 section 共用同一结论——否则同一次「无需提交」会被两条通道各提醒一次。
//   'committed'  → 产物已入库，不提
//   'no-changes' → 没有未提交的产物（重编译无变化/提前提交过），不提
//   'pending'    → 插件没能提交，需要会话模型代为提交一次（唯一该提的情形）
// 没有 autoCommit 字段的 job 按 pending 处理。
export function autoCommitState(job) {
  const ac = job?.autoCommit
  if (ac?.committed === true) return 'committed'
  if (ac?.noChanges === true) return 'no-changes'
  return 'pending'
}

function createJobService(config) {
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
  // 编译对象残留清理：worktree 目录与「没有可编译源码」的空壳目录上的历史任务
  // 是噪音——同一个空壳目录能攒出十几条一模一样的「仓库没有可编译的源码文件」
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

  function fail(job, msg) {
    setStage(job, 'failed')
    job.error = msg
    job.outcome = 'failed'
    job.canAdvanceBaseline = false
    job.blockers = [...(job.blockers ?? []), { kind: 'failed', detail: String(msg).slice(0, 300) }]
    job.finishedAt = new Date().toISOString()
    note(job, `任务失败：${msg}`)
    touch(job)
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




  // ── 原生引擎通道的执行器 ──────────────────────────────────────────────
  // runNativeJob 是一条长任务（一次 generate 全跑完），不能塞进 tick 的一步里——
  // tick 是 10s 节拍，跑不完就返回会让下一次 tick 重复提交。
  // 所以「启动 → 等结果 → 收割」三段分开，结果为 null 表示已 fail（由执行器自己判）。
  const nativeRuns = new Map()     // jobId → Promise
  const nativeResults = new Map()  // jobId → EngineResult | null
  const nativeAborters = new Map() // jobId → AbortController

  // 原生八段 → 面板现有阶段。面板步骤条按 ACTIVE_STAGES 渲染，改它会牵动一大堆
  // 布局与文案；真实引擎阶段另存 job.nativeStage，让面板既能显示「在第几步」，
  // 又能显示「引擎自己走到哪」。映射原则：引擎里发生在写作之前的三段（探测环境、
  // 解析代码图、聚类模块）合成步骤条的「准备」——它们对用户是同一件事：还在摸清仓库。
  // validate 有自己的格子（校验），不再借用 review（那现在是校对真正发生的位置）。
  // proofread → validate：校对是质量门死链检查的修复动作（检测→改正文→复检），
  // 与质量门同属「校验产物」这件事。分成两格会让面板出现两个都叫检查的步骤。
  // 细分阶段名仍由 nativeStage 单独携带，活动流里照样能看到「语义校对」。
  const NATIVE_STAGE_TO_PANEL = {
    env: 'prepare', graph: 'prepare', cluster: 'prepare', articles: 'articles',
    proofread: 'validate', validate: 'validate', index: 'index', baseline: 'index', commit: 'commit',
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
  // 失败一律进 nativeResults=null 并由这里 fail()：
  // 收割方只看「有没有结果」，不用自己猜执行器死活。
  function startNativeRun(job, channel) {
    const ac = new AbortController()
    nativeAborters.set(job.id, ac)
    const c = liveConfig(config)
    // 引擎原始产物目录必须放在**仓库外**（临时目录）。
    // 不能放在 .codewiki/temp/native-docs，实测会在首次编译时整批失败：落地器
    // apply-plan.js:542-565 用「.codewiki 目录是否存在」判断要不要跑 cw init，
    // 而引擎写产物这一步已经先把 .codewiki/ 建出来了，于是被判成
    // 「.codewiki/ 存在但缺 _meta.yaml（人工删改过？）」→ wiki-missing → failed。
    // 放临时目录还顺带避免产物被当成仓库页、避免残留污染 git 状态。
    const docsDir = path.join(os.tmpdir(), `dsh-codewiki-native-${job.id}`)
    // TechDocs 站点也走仓库外临时目录：上游导出直接写盘，写进仓库就绕过了落地器。
    // 读回与落盘由 native-run 的 3.8 段负责，这里只给路径。
    const techdocsDir = c.techdocs ? path.join(os.tmpdir(), `dsh-codewiki-techdocs-${job.id}`) : null
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
        // 同层模块并行度：独立设置项，0/未填 跟随默认档并发，
        // 填 1 = 上游原本的严格串行。不复用同一个配置键，两者语义不同。
        moduleConcurrency: c.moduleConcurrency || c.maxConcurrency,
        // 单模块写作请求上限：上游写作 agent 的硬预算，不传就等于用引擎默认 100，
        // 大模块会撞满抛错把整轮判成 partial。
        requestLimit: c.requestLimit,
        // 原始树留档根（仓库外）：引擎产物在被映射/改写/裁剪之前先拷一份，
        // 失败只记 note 不影响终态——它是事实来源，不是交付物。
        rawTreeRoot: nativeRawTreeDir(),
        // TechDocs 站点输出目录（仓库外，null = 不导出）：内容由 native-run 读成写集。
        techdocsDir,
        deps: {
          config: {
            ...c,
            engineRoot: '',
          },
          // 增量档位与阈值：留空的键不出现，引擎用自己的默认值。
          // 只有增量轮会被 native-run 下发；rung=0 的「放弃增量」语义在那边处理。
          updateOptions: updateOptionsOf(c),
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
          // 桥在 onProgress 里同步过阶段，这里兜到 job.nativeStage：阶段刚切换、桥还没来得及
          // 收到 setStage 时，task.stage 会是空串，而 job.nativeStage 由同一份进度直接赋值。
          onRequestStart: (task) => beginSessionRecord(job, { ...task, stage: task.stage || job.nativeStage || null }),
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
            // 这里**故意不传 ac.signal**：落地事务（写盘→index→基线→提交）不可中断，
            // 取消只终止引擎阶段。曾传了 signal，于是取消会 kill 掉正在跑的 `cw meta update`
            // 触发回滚，把「已落盘的文章」连同基线一起撤掉，而终态只报一句「已取消」——
            // 一次取消就吞掉一整轮编译成果。事务自身有 120s 超时兜底。
            runCw: (binary, cwd, args, timeoutMs) => runCw(binary, cwd, args, timeoutMs),
            commit: (root, opts) => autoCommitWiki(root, opts),
          },
        },
        onProgress: (p) => {
          // 引擎进度只映射到面板阶段 + 计数，不改终态语义（终态只由 runNativeJob 裁决）。
          // 引擎八段里 env/graph/cluster 都被压成面板的 prepare 一格，stageTimings
          // 只会有 prepare 一个键——任务跑完后「这三段各花多久」就永久丢失了。
          // 单记一份按引擎阶段的耗时，终态的分段带才有东西可拆。
          if (job.nativeStage && job.nativeStage !== p.stage && job.nativeStageAt) {
            const ms = Date.now() - Date.parse(job.nativeStageAt)
            if (Number.isFinite(ms) && ms > 0) {
              job.nativeStageTimings = { ...(job.nativeStageTimings ?? {}), [job.nativeStage]: (job.nativeStageTimings?.[job.nativeStage] ?? 0) + ms }
            }
          }
          if (job.nativeStage !== p.stage) job.nativeStageAt = new Date().toISOString()
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
        // 站点同理：内容已被读成写集落进 `.codewiki/_techdocs/`，临时目录不再需要。
        if (techdocsDir) {
          try { fs.rmSync(techdocsDir, { recursive: true, force: true }) } catch { /* 清不掉不影响终态 */ }
        }
        touch(job)
      })
    nativeRuns.set(job.id, run)
    return run
  }

  // 原生阶段的任务推进：起一次（stage=articles 且没有在跑的），后续 tick 只等待。
  // 返回 true 表示本轮「有动作，别继续往下走」。
  async function tickNative(job, channel) {
    // 结果已就绪 → 收割（执行器只调一次，收割方删记录）
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
        // 不在这里提交：commit 已在落地器里完成（提交失败会进 blockers，终态不会是
        // done）。再提交一次只会重复提交同一批产物。
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
            // 用户下次提交会正常排进队列。
            note(job, `原实例 ${job.owner} 停更，${plan.reason}，本实例作废该任务`)
            fail(job, plan.reason)
            continue
          }
          const idleMs = Date.now() - lastSeenAt(job)
          note(job, `原实例 ${job.owner} 停更 ${Math.round(idleMs / 60000)} 分钟，本实例接管推进`)
          adoptOrphan(job, { instanceId })
          touch(job)
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
          if (job.channel === 'native' && nativeRuns.has(job.id)) {
            // 原生执行器还在跑：abort 会终止引擎进程树，但落地器不接 signal —— apply 一旦
            // 开始就会跑完。此刻直接判 cancelled 会把「已落盘、已提交、基线已推进」的
            // 事实改写成「产物未落地，基线未推进」，下一轮再从旧基线重复消费一批变化。
            // 取消仍然生效（引擎被杀），但终态交给执行器的真实结果。
            const nac0 = nativeAborters.get(job.id)
            if (nac0) nac0.abort()
            if (job.cancelNoted !== true) {
              job.cancelNoted = true
              note(job, '已取消：原生引擎进程树已终止，未进入落地阶段')
            }
            touch(job)
            continue
          }
          setStage(job, 'cancelled')
          job.finishedAt = new Date().toISOString()
          // 取消是终态，但不是「成功」：基线绝不能因为一个半成品任务前移。
          // setStage 只改 stage，不会碰 outcome/canAdvanceBaseline——留空会让人
          // 从 job 文件里读到「cancelled 且 canAdvanceBaseline 还是上一次的 true」。
          job.outcome = 'cancelled'
          job.canAdvanceBaseline = false
          // abort 会终止受管的 Python 进程树（client.js terminateProcessTree），
          // 结果作废、不再 gate/apply。取消是终态，后续到达的 done 也不会覆盖。
          const nac = nativeAborters.get(job.id)
          if (nac) nac.abort()
          nativeResults.delete(job.id)
          note(job, '已取消：原生引擎进程树已终止，未进入落地阶段')
          touch(job)
          continue
        }
        // 排队中的项目：只有轮到它（activeIds）时才进入真正的首个阶段
        if (job.stage === 'queued') {
          if (!activeIds.has(job.id)) continue
          const next = 'articles'
          job.pendingStage = null
          note(job, `排队结束，开始编译（${next}）`)
          setStage(job, next)
          if (job.kind === 'stale') job.tasks = job.pendingTasks ?? job.tasks ?? []
          job.pendingTasks = null
        }
        // 项目闸门：非本轮推进项目跳过（不推进、不失败，等轮次）
        if (activeIds.size && !activeIds.has(job.id)) continue
        // ── 原生引擎通道 ───────────────────────────────────────────────
        // 编译只有这一条通道。job.channel 只是「谁在跑」的记账，stage 是引擎走到第几步。
        const lc = liveConfig(config)
        if (job.stage === 'articles' && !job.channel) {
          const want = nativeChannelFor(lc, { kind: job.kind, scope: job.scope })
          if (!want) {
            fail(job, '原生引擎通道不可用（nativeEngine 已关闭或 scope 不受支持）；编译只走原生通道，请开启后重新提交')
            persist()
            continue
          }
          job.channel = 'native'
          job.nativeChannel = want
          note(job, `编译通道：原生引擎（入口 ${path.basename(want.entry)}，解释器 ${want.python}）`)
          persist()
        }
        const ch = job.nativeChannel ?? nativeChannelFor(lc, { kind: job.kind, scope: job.scope })
        if (!ch) {
          fail(job, '原生通道缺少引擎快照（job 文件里没有 nativeChannel），无法续跑；请重新提交编译')
          persist()
          continue
        }
        job.channel = 'native'
        try {
          await tickNative(job, ch)
        } catch (err) {
          fail(job, `原生阶段异常 —— ${String(err?.message ?? err)}`)
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
      sessionId: sessionId ?? null, // 发起会话记账（面板/自动调度为 null）
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
      // 已落盘的旧 jobs 里可能有这个字段，读侧按缺省处理，值恒为 null。
      updatePlan: null,
      qualityIssues: [],
      usage: { inputTok: 0, outputTok: 0, requests: 0, batchRequests: 0, realtimeRequests: 0, overTier2: 0 },
      stageTimings: {},
      nativeStageTimings: {},
      nativeStageAt: null,
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
      // 增量档位只在这一处校验：非法值不该等到引擎子进程起来才以 engine-protocol 报错，
      // 那时一轮预算已经开始花了。updateOptionsOf 在这里抛，job 直接进 failed。
      updateOptionsOf(c)
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
        // 排除清单命中：一个字都不用说。用户自己排除了这个仓库，他要的就是「别编译它」；
        // 把原因写进会话只会让模型追问、建议改设置，或者向用户复述一件用户早就决定的事。
        if (value.state === 'excluded') return [{ type: 'text', text: 'codewiki：本仓库无需处理，继续手头工作。' }]
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
      // 排除清单是用户在面板上的表态，**不是错误、也不需要被转述**：模型看到「被排除」
      // 会去追问用户为什么、建议改设置，而用户本来就是要它不编译。所以这里给一个不带
      // 原因的中性终态（notes 为空，state 只给内部用，render 不显示它），模型照常收尾。
      if (exHit) {
        return {
          cwd,
          scope: ['auto', 'full', 'stale'].includes(args.scope) ? args.scope : 'auto',
          wikiPath: '',
          state: 'excluded',
          submitted: false,
          notes: [],
        }
      }
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
      const sessionId = exec?.agent?.id ?? null // 发起会话记账（面板/自动调度无 agent 上下文=null）

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
        if (sessionId) active.sessionId = sessionId // 记为最近一次关心该仓库的会话
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

      // 首次编译闸门：仓库里原本没有 CodeWiki 时，要不要建它是一个需要用户
      // 表态的决定——一次全量编译会在这个仓库里落下十几到几十篇文档，并自动提交一次。
      // 模型顺手调一次 codewiki_generate 就替用户做了这个决定，这不是它该做的事。
      // 判据用**用户原始 scope**而不是 effectiveScope：stale 遇到无 wiki 的仓库会在上面
      // 被自动升成全量，看 effectiveScope 等于「凡是以 stale 调进来的都放行」，闸门形同虚设。
      // 放行只有两种情形：scope=full（调用方显式要求全量重编）与 confirmed（面板按钮，
      // 用户本人按下的就是确认）。自动调度不在此列——它在扫描阶段就把这类仓库放进
      // pendingConfirm，根本走不到这里。
      if ((status.state === 'missing' || status.state === 'uncompiled') && scope !== 'full' && args.confirmed !== true) {
        notes.push(`此仓库尚无 CodeWiki（cw status：${status.state === 'missing' ? '没有 .codewiki 目录' : '.codewiki 存在但从未编译'}）`)
        notes.push('首次编译会在仓库里生成整套文档并自动提交一次，需要用户点头，不能由工具代劳')
        notes.push('先问用户「要为这个仓库建 CodeWiki 吗」；得到同意后再调用，并显式传 scope="full"')
        notes.push('如果用户已经在侧边栏 CodeWiki 面板点过编译按钮，那条路径自带确认，不会再走到这里')
        return result
      }

      // 原生通道接管 stale/auto：不跑旧 planner 的 needsFull/unmapped 判定。
      // 旧 planner 见到「删除/改名导致文章归属缺失」一律推成全量，而原生引擎的组件级
      // 增量本来就能处理删除与改名——让旧判定插在中间，等于把阶段 5 的增量能力废掉。
      // 决议权归 runNativeJob：它读受管状态与四路 change-set，自己判 update / full / no_change。
      // 注意 clean 也必须走这里：cw status 只看 committed，工作区未提交变化与「受管状态缺失」
      // 它一概看不见，直接短路会让这些变化永远进不了引擎（丢变化）。
      const nativeCh = nativeChannelFor(liveConfig(cfg), { kind: 'stale', scope: effectiveScope })
      if (nativeCh && effectiveScope !== 'full' && status.state !== 'missing' && status.state !== 'uncompiled') {
        const idle = idleNativeReason({ cwd, wikiPath })
        if (idle) {
          notes.push(idle)
          return result
        }
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

      // 文件级归属判定：变更集里的每个源码路径，只要被某篇已存在文章的 source_files
      // 认领（或它是一次改名的源路径），就算「已消化」。返回未归属清单，调用方据此
      // 拒绝推进基线。符号级/依赖级判定由原生引擎在 Python 侧完成。
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
          // cw status 说有文件变更却没命中任何文章。直接 meta update 会把没读懂的
          // 变化永久丢弃；这里用文件级归属判定：只有每个变更都被某篇文章的
          // source_files 认领，才允许推进基线，否则拒绝并报告未归属清单。
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
// 模型「本步收尾、继续下一项、不要等待/轮询」。编译产物由插件在落地器里顺带
// autoCommit，因此成功后既不催模型提交、也不唤醒会话；只有自动提交
// 失败时才由 commitHintText 在系统提示 section 里给一条「产物待提交」提醒。
// ---------------------------------------------------------------------------

function updateToolDefinition(cfg, generateDef) {
  return {
    name: 'codewiki_update',
    description: [
      '提交 CodeWiki 更新请求（日常维护入口，scope=auto 语义）：无 wiki 走全量编译，有变更走逐篇更新，已是最新则直接报告。调用即提交、立即返回——调用后本步收尾、继续下一项工作；不要等待、不要轮询、不要为看进度反复调 codewiki_progress。',
      '编译产物由插件自己提交（autoCommit 默认开：主题分支 codewiki/wiki-<任务id> 提交后合并回原分支，只 add .codewiki/ 与 CodeWiki.md，不动你的其它改动），所以正常情况下你不需要为 wiki 跑任何 git 命令。编译终态不会主动发消息唤醒会话：失败与否在 codewiki_progress 与面板里看；只有插件自动提交没成功时，系统提示里会出现一条「CodeWiki 产物待提交」提醒，届时随手提交一次即可。与 codewiki_generate 的关系：本工具是固定 scope=auto 的快捷入口，需要 scope=full/stale 时仍用 codewiki_generate。',
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
        // 同 codewiki_generate：命中排除清单时不解释、不显示 state。
        if (value.state === 'excluded') return [{ type: 'text', text: 'codewiki：本仓库无需处理，继续手头工作。' }]
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
      '可选按 cwd（仓库路径）或 jobId 过滤；都不传则列出全部任务。输出含 stage（进行中：queued / prepare / articles / crosscut / review / validate / index / commit；终态：done / partial / failed / cancelled）、outcome（done=完整成功、partial=部分完成且有未消化变化、failed=无成果）、blockers（未消化的具体原因）、canAdvanceBaseline（是否已推进编译基线）、完成百分比、已写/失败篇数、任务明细、批量进度、阶段耗时、token 用量、notes 与错误。',
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
                nativeStageTimings: { oneOf: [{ type: 'object' }, { type: 'null' }], description: '引擎八段的真实耗时（ms），键为 env/graph/cluster/articles/proofread/validate/index/baseline/commit。与 stageTimings 的区别：后者是面板粗粒度五段，prepare 一格吞了 env/graph/cluster' },
                usage: { type: 'object' },
                nativeStage: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '引擎自报的九段契约阶段（env/graph/cluster/articles/proofread/validate/index/baseline/commit），与面板粗粒度 stage 不是一回事。proofread 段只在「有失效跨页链接的页」存在时才出现' },
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
  // 调度器可能没装（测试 ctx、或调度不可用但仍要看面板）：这里一次性定成空对象，
  // 后面各处直接读字段。读不到是 undefined，与可选链结果一致，但不必层层 `?.`。
  const { config, compile } = extra
  const schedState = extra.schedState ?? {}
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
          // 任务列表——这类任务本身就不该存在（submit 闸门已拦），残留条目只会在面板上
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
              lastScan: schedState.lastScan ? new Date(schedState.lastScan).toISOString() : null,
              scanning: schedState.scanning === true,
              lastError: schedState.lastError ?? null,
              lastScanRepos: schedState.lastScanRepos ?? null,
              lastScanSubmitted: schedState.lastScanSubmitted ?? null,
              // 分工口径：本轮扫到但已有活动任务（幂等命中）、以及判态干净/无变更可做的仓数。
              // 只暴露 submitted 时，「扫到 N 仓、提交 0」无法区分「正在编译」与「无事可做」。
              lastScanBusy: schedState.lastScanBusy ?? null,
              lastScanNoop: schedState.lastScanNoop ?? null,
              // 因 workspaceOnly 被跳过（不在已添加工作区里）的仓数：否则「清单里有 N 个仓库、
              // 扫到 M 个」的缺口在面板上无法解释，用户会以为调度器丢了仓库。
              lastScanSkipped: schedState.lastScanSkipped ?? null,
            },
          }
          reposCacheAt = Date.now()
        }
        // 待确认状态与 needsConfirm 不进 30s 缓存：它随调度心跳实时变化，缓存会让用户
        // 在「已登记待确认」后 30 秒内看不到确认按钮（面板每 2s 拉一次）。这两项每次求值。
        const livePending = (schedState.pendingConfirm ?? []).map((p) => p.cwd)
        const livePendingKeys = new Set(livePending.map(normPathKey))
        writeJson(res, 200, {
          ...reposCache,
          repos: (reposCache.repos ?? []).map((r) => ({ ...r, needsConfirm: livePendingKeys.has(normPathKey(r.cwd)) })),
          scheduler: { ...reposCache.scheduler, lastScanPending: schedState.lastScanPending ?? null, pendingConfirm: livePending },
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
            const active = activeSessionJobs(job ? [job] : [], { requestCount: countSessionRecords })
            // 单任务也曾一次返回全部（单个任务 446 条、合计 271MB 记录），列表一次性铺满
            // 446 行既慢又没人从头读到尾。分页：只给最新的 limit 条，前端按需加 limit。
            const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 80))
            writeJson(res, 200, {
              sessions: listSessionRecords(jobId, limit),
              total: countSessionRecords(jobId),
              limit,
              active,
            })
            return
          }
          // 全局聚合：带上 cwd（面板行里显示是哪个仓库在编译），只给最近 limit 条
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
          const all = service.list()
          const byId = new Map()
          for (const j of all) byId.set(j.id, j.cwd ?? '')
          const sessions = listAllSessionRecords({ limit }).map((s) => ({
            ...s, cwd: byId.get(s.jobId) ?? '',
          }))
          // 数请求条数走 countSessionRecords：每个活跃任务只数文件名，不再读一遍它的全部 meta
          const active = activeSessionJobs(all, { requestCount: countSessionRecords })
          writeJson(res, 200, { sessions, total: countAllSessionRecords(), limit, active })
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
          const rec = readSessionRecordDetail(jobId, n)
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
        // 首次编译确认：从待确认清单里摘掉并立即提交，语义等于用户手动点编译。
        // 手动路径本来就不需要确认（用户按下按钮就是确认），所以这里不再二次校验。
        if (body?.action === 'confirm' && body?.cwd) {
          if (typeof compile !== 'function') { writeJson(res, 501, { error: '编译入口未初始化' }); return }
          const dir = String(body.cwd)
          // 与 needsConfirm 的比对必须用同一个键函数：手写「总是折叠大小写」的版本，
          // 在大小写敏感的平台会把两个不同目录当成同一个，误删掉不相干仓库的待确认。
          const key = normPathKey(dir)
          if (Array.isArray(schedState.pendingConfirm)) {
            schedState.pendingConfirm = schedState.pendingConfirm.filter((p) => normPathKey(p.cwd) !== key)
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
// 编译完成后的提交提醒（只在插件自动提交失败时出现）：最近一次成功编译
// （stage=done 且有文章写成功）的完成时间晚于 .codewiki/（与 CodeWiki.md）最后一次
// git 提交时间 → 该次编译产物尚未入库，系统提示注入「产物待提交」（一次性，非催促）。
// 自动提交成功时时间戳反超，提醒自动静默；零状态派生（jobs 文件 + git log 时间戳），
// 非 git 仓库/读 jobs 失败一律不提醒。60s TTL 缓存：text 回调每次组装系统提示都求值。
const commitHintCache = new Map() // cwd -> { at, text }

// ---------------------------------------------------------------------------
// 编译产物自动提交（分支合并式）：把「等编译完成 →
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
    // 分支合并式：主题分支上提交 → 合并回原分支 → 删主题分支。
    // detached HEAD 没有「原分支」可回 → 降级为直接提交。
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
    // （autoCommitState 是这条提醒与系统提示 section 的唯一判据。）
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
    '- 调用 codewiki_generate 工具（scope=auto 即可）更新受影响文章——模块文章、入口 CodeWiki.md 与索引刷新均由流水线完成；不要手工编写或修改 .codewiki/ 下的文章（手改不进流水线、不被面板记录，还会被下次编译覆盖）；',
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
  if (typeof ctx.inject === 'function') ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })
  // 自动调度也要读宿主工作区注册表：workspaceOnly（默认开）的语义是「只处理已添加的
  // dsh 工作区」，如果只有面板过滤遵守它，被移出工作区的仓库仍会被后台定时编译并写入
  // 产物——面板上看不见它在编译，用户也无从取消。
  let schedWorkspaceRegistry = null
  if (typeof ctx.inject === 'function') ctx.inject(['workspaceRegistry'], (rc) => { schedWorkspaceRegistry = rc?.workspaceRegistry ?? rc })
  const service = createJobService(config)
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
  // pendingConfirm：自动调度**不得**替用户决定「这个仓库要不要有 wiki」。
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
        // 首次编译必须用户确认：从没有过任何编译任务、磁盘上也没有 wiki 的仓库
        // 只登记，不提交。判据取两者的**交集**，两个单独都不够：
        //   · 只看任务历史：历史被 MAX_JOBS_KEPT 截断或手动清理后，编译过 wiki 的仓库会被
        //     当成首次，用户每次清历史都要重新点一遍确认；
        //   · 只看 status：wiki 目录被删掉的仓库报 missing，但它编译过，用户已经表过态。
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
          }        }
        try {
          // confirmed：走到这里的仓库已经过一次确认——要么有编译历史（用户早就为它建过 wiki），
          // 要么它不在「没历史 + 没 wiki」的交集里。真正需要确认的那批在上面的分支里已被
          // pendingConfirm 拦下，不会到这里。
          const r = await generateDef.execute({ cwd, scope: 'auto', auto: true, confirmed: true }, {})
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
  // 面板的编译入口只由用户按按钮触发——按下就是确认。带 confirmed 进去，
  // 否则「仓库里还没有 CodeWiki」的首次编译会被自己的确认闸门拦住。
  installWebServer(ctx, service, { config, schedState, compile: (args, exec) => generateDef.execute({ ...args, confirmed: true }, exec) })
  installUpdateReminder(ctx, config)
}
