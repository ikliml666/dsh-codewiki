// dsh-codewiki — 把 mraza007/codewiki（Rust CLI `cw`）接入 DeepSeek Harness。
// 提供两个工具：
//   cw                — 薄封装 CodeWiki CLI（init/status/index/meta/path/projects/setup/uninstall）
//   codewiki_generate — 智能体编排：按上游 codewiki-session 流程编译/刷新 wiki，
//                       可显式指定子代理模型（provider+model 成对出现才生效，否则用插件默认，再退会话模型）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-codewiki'
export const name = PLUGIN_NAME
const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']
const CONCURRENCY_HARD_CAP = 2 // 红线 2：子代理并发上限

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('停用后两个工具立即报错'),
  binaryPath: z.string().default('').volatile().description('cw 可执行文件路径；留空优先用插件自带 bin/cw(.exe)，再退回 PATH 里的 cw'),
  defaultProvider: z.string().default('aliyun-bailian').volatile().description('codewiki_generate 子代理默认 provider；与默认 model 成对出现才生效；置空则继承会话模型'),
  defaultModel: z.string().default('qwen3.8-flash').volatile().description('codewiki_generate 子代理默认 model；默认钉在路由插件 wiki 档的便宜模型'),
  maxConcurrency: z.number().default(CONCURRENCY_HARD_CAP).volatile().description('写文章子代理并发上限，硬顶 2'),
  articleLanguage: z.string().default('中文').volatile().description('wiki 文章书写语言'),
})

function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}

function liveConfig(config) {
  const c = config ?? {}
  const concurrency = Number(val(c.maxConcurrency))
  return {
    enabled: val(c.enabled) ?? true,
    binaryPath: String(val(c.binaryPath) ?? '').trim(),
    defaultProvider: String(val(c.defaultProvider) ?? '').trim(),
    defaultModel: String(val(c.defaultModel) ?? '').trim(),
    maxConcurrency: Number.isFinite(concurrency) && concurrency >= 1
      ? Math.min(concurrency, CONCURRENCY_HARD_CAP)
      : CONCURRENCY_HARD_CAP,
    articleLanguage: String(val(c.articleLanguage) ?? '').trim() || '中文',
  }
}

// ---------------------------------------------------------------------------
// cw 进程
// ---------------------------------------------------------------------------

function resolveBinary(cfg) {
  if (cfg.binaryPath) return cfg.binaryPath
  const local = path.join(pluginDir, 'bin', process.platform === 'win32' ? 'cw.exe' : 'cw')
  if (fs.existsSync(local)) return local
  return 'cw'
}

function runCw(binary, cwd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr: String(err?.message ?? err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

// 上游 main.rs 的三态输出 + 逐行清单：
//   'No wiki found. Run `cw init` first.' / 'Wiki has not been compiled yet.'
//   'Wiki is up to date.' / 'Changed since last compile (<hash>):' + '  M <file>'
//   'Stale articles:' + '  ! <article>'
function parseStatus(stdout) {
  const s = stdout ?? ''
  if (s.includes('No wiki found')) return { state: 'missing', changedFiles: [], staleArticles: [] }
  if (s.includes('has not been compiled yet')) return { state: 'uncompiled', changedFiles: [], staleArticles: [] }
  if (s.includes('Wiki is up to date')) return { state: 'clean', changedFiles: [], staleArticles: [] }
  const changedFiles = []
  const staleArticles = []
  for (const m of s.matchAll(/^\s+[M!]\s+(.+)$/gm)) {
    const line = m[1].trim()
    if (m[0].trimStart().startsWith('M')) changedFiles.push(line)
    else staleArticles.push(line)
  }
  return { state: 'stale', changedFiles, staleArticles }
}

// ---------------------------------------------------------------------------
// 子代理
// ---------------------------------------------------------------------------

function textOfOutput(output) {
  return (Array.isArray(output) ? output : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

async function launchAgent(subagents, exec, { label, prompt, route }) {
  const payload = { label, prompt: [{ type: 'text', text: prompt }], parent: exec.agent, signal: exec.signal }
  if (route) payload.agentOptions = { provider: route.provider, model: route.model }
  const run = await subagents.start('spawn', payload)
  try {
    const result = await run.result
    return {
      ok: result?.stopReason === 'completed',
      stopReason: result?.stopReason ?? 'unknown',
      text: textOfOutput(result?.output),
      diagnostic: result?.diagnostic,
    }
  } finally {
    try { await run.dispose() } catch { /* dispose 幂等 */ }
  }
}

// 启动/运行失败一律折算成失败记录，不向上抛（编排器逐项记账）。
async function safeLaunch(subagents, exec, task) {
  try {
    return await launchAgent(subagents, exec, task)
  } catch (err) {
    return { ok: false, stopReason: 'error', text: '', diagnostic: String(err?.message ?? err) }
  }
}

// 按 maxConcurrency 分批并发；单个失败只记账不中断（stopReason != completed 亦然）。
async function runBatched(subagents, exec, tasks, concurrency) {
  const results = []
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency)
    const settled = await Promise.all(batch.map((t) =>
      safeLaunch(subagents, exec, t).then((r) => ({ ...r, label: t.label, name: t.name }))
    ))
    results.push(...settled)
  }
  return results
}

function failureMessage(r) {
  let msg = `子代理异常结束（stopReason: ${r.stopReason}）`
  if (r.diagnostic) msg += `：${r.diagnostic}`
  if (r.text) msg += `\n部分输出：${r.text.slice(0, 500)}`
  return msg
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
    '- 行号必须实读源码验证，禁止猜测；行号区间覆盖完整函数/代码块，不得截断',
    '- source_files 必须列出你为写本文读过的每一个文件（含测试文件），路径相对仓库根，POSIX 风格',
    '- 功能被禁用/注释时写明具体位置（哪个文件哪一行），不许只写 "disabled"',
    '- Architecture：组件 ≥3 或流程非平凡时，画 UTF-8 box-drawing 框图（┌ ┐ └ ┘ ─ │ ► ◄ ▼）放进 ```text 围栏，≤20 行，框内标注组件名与文件/类，箭头标注关系',
    '- Markdown 规范：## 顶级、### 子级不跳级；行内代码用反引号；多行代码用带语言标签的围栏；结构化对比用 markdown 表；标题/代码块/列表前后留空行',
    '- Connections 用 Obsidian [[backlinks]]（[[other-module]]）连接相关模块',
    '- 写给对这个代码库零上下文的未来 agent：具体到文件名、函数名、类型、行号；宁可多细节，不许概括省略',
  ].join('\n')
}

function plannerPrompt(cwd) {
  return [
    `你是代码结构勘探员。目标仓库：${cwd}。`,
    '通读仓库结构（用你的文件列表/读文件工具），识别全部源码文件（尊重 .gitignore，跳过第三方依赖、vendor、构建产物），按逻辑模块分组，并识别跨模块概念。',
    '只输出一个 JSON 对象——禁止 markdown 围栏、禁止任何解释文字：',
    '{',
    '  "project": "<一句话项目定位>",',
    '  "modules": [ {"name": "kebab-case-name", "summary": "2-3 句话", "files": ["相对路径", "..."]} ],',
    '  "concepts": [ {"name": "kebab-case-name", "files": ["相对路径"]} ]',
    '}',
    '要求：',
    '- modules 的 files 并集必须覆盖仓库全部源码文件；每个文件恰好归入一个模块',
    '- concepts 只收真正跨模块的模式（错误处理、数据流、认证、配置加载等），没有就给空数组',
    '- files 用相对仓库根的 POSIX 风格路径（/ 分隔）',
    '- name 用小写 kebab-case，作为文章文件名',
  ].join('\n')
}

function moduleArticlePrompt(cwd, wikiPath, mod, language) {
  const files = mod.files.map((f) => `- ${f}`).join('\n')
  const slug = slugify(mod.name)
  return [
    `你是 CodeWiki 文章作者。仓库：${cwd}。文章全文用${language}书写。`,
    '',
    '任务：先用你的读文件工具逐个通读下列文件的完整内容，再写一篇该模块的 wiki 文章，',
    `用你的写文件工具把文章写入：${path.join(wikiPath, 'modules', `${slug}.md`)}（目录不存在先创建；文件已存在则整体重写覆盖）。`,
    '',
    '模块：' + mod.name + (mod.summary ? ` —— ${mod.summary}` : ''),
    '文件清单：',
    files,
    '',
    articleFormatSection(),
    '',
    '完成后只回复一行：WROTE <文章绝对路径>；只有无法完成时才回复 FAILED <原因>。',
  ].join('\n')
}

function crosscutPrompt(cwd, wikiPath, plan, language) {
  const concepts = plan.concepts.length
    ? plan.concepts.map((c) => `- ${c.name}`).join('\n')
    : '- （规划未识别出跨模块概念；若你发现明显的横切模式可自行补充）'
  return [
    `你是 CodeWiki 横切文章作者。仓库：${cwd}，wiki 目录：${wikiPath}。文章全文用${language}书写。`,
    '',
    '先读 ' + wikiPath + '/modules/ 下已生成的全部模块文章与仓库源码，建立全貌，然后依次写入：',
    `1. ${path.join(wikiPath, '_architecture.md')} — 系统总览：必须含三张 UTF-8 box-drawing 图（System Overview 总框图、Request/Data Flow 数据流、Dependency Graph 依赖方向），说明各模块职责与相互连接；frontmatter type: architecture`,
    `2. ${path.join(wikiPath, '_patterns.md')} — 仓库反复出现的模式（命名约定、错误处理风格、构建流程等）；frontmatter type: pattern`,
    '3. 每个概念一篇 ' + path.join(wikiPath, 'concepts') + '/<name>.md；frontmatter type: concept',
    '',
    '概念清单：',
    concepts,
    '',
    'frontmatter 通用规范：title/type/source_files（列出你实际读过的文件）/tags。',
    '行号必须实读源码验证；Markdown 规范；图一律 ```text 围栏；写给零上下文的未来 agent。',
    '完成后逐行回复：WROTE <文件绝对路径>。',
  ].join('\n')
}

function verifyPrompt(cwd, wikiPath) {
  return [
    `你是 CodeWiki 审校员。仓库：${cwd}，wiki 目录：${wikiPath}。`,
    '逐篇读取 wiki 下全部 .md 文件（modules/、concepts/、_architecture.md、_patterns.md 等），对每篇：',
    '1. frontmatter source_files 列出的每个文件必须真实存在于仓库（用你的文件工具核对）',
    '2. 抽查 3 个函数/类名及其行号，回到源码逐个核对（行号、名字、归属模块）',
    '3. 检查是否有重大源码文件未被任何文章的 source_files 覆盖',
    '4. frontmatter 缺 title/type/source_files 的直接补齐',
    '5. 文内行号与代码不符的段落直接改写修正',
    '发现的问题必须直接修复（改写文章），不要只报告。',
    '',
    '完成后回复：VERIFIED（修复 N 处，逐条列出）或 ISSUES（无法自行修复的问题清单）。',
  ].join('\n')
}

function fallbackCompilePrompt(cwd, wikiPath, language) {
  return [
    `你是 CodeWiki 全量编译员。仓库：${cwd}，wiki 目录：${wikiPath}。文章全文用${language}书写。`,
    '依次完成（中途不得省略任何一步）：',
    '1. 勘探：列出仓库全部源码文件（尊重 .gitignore，跳过 vendor/构建产物），按逻辑模块分组，识别跨模块概念',
    `2. 每个模块一篇 ${path.join(wikiPath, 'modules')}/<name>.md（name 用小写 kebab-case）`,
    `3. 横切：${path.join(wikiPath, '_architecture.md')}（type: architecture，三张图）、${path.join(wikiPath, '_patterns.md')}（type: pattern）、concepts/<name>.md（type: concept）`,
    `4. 自查：全部 source_files 真实存在、抽 3 个行号核对、无重大文件遗漏`,
    '',
    articleFormatSection(),
    '',
    '完成后逐行回复：WROTE <文件绝对路径>。',
  ].join('\n')
}

function staleArticlePrompt(cwd, articlePath, sourceFiles, language) {
  const files = sourceFiles.map((f) => `- ${f}`).join('\n')
  return [
    `你是 CodeWiki 文章维护员。仓库：${cwd}。文章全文用${language}书写。`,
    '',
    `该文章相对上次编译已过期：${articlePath}`,
    '先用你的读文件工具读这篇文章，再重新通读它 frontmatter source_files 里列出的全部源文件（当前代码可能已变化）：',
    files,
    '',
    '然后更新这篇文章，使其与当前代码完全一致：',
    '- 行号、函数/类清单、字段、数据流按当前代码改写；行号必须实读验证',
    '- source_files 按你实际读过的文件刷新（含测试文件）',
    '- 保留文章原有章节结构（Overview/Key Components/Architecture/Data Flow/Connections/Known Issues）与 frontmatter 的 title/type/tags',
    '- 用写文件工具整体覆盖写回原路径',
    '',
    '完成后只回复一行：WROTE <文章绝对路径>；只有无法完成时才回复 FAILED <原因>。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 工具 1：cw CLI 封装
// ---------------------------------------------------------------------------

function cwToolDefinition(cfg) {
  return {
    name: 'cw',
    description: [
      '运行 CodeWiki CLI（cw）查询/维护当前仓库的代码 wiki。wiki 落在 ~/.codewiki/<project>/。',
      '常用调用：args=["status"] 查新态（三态判定）；["init"] 初始化；["index"] 重建索引；["meta","update"] 记录编译基线 commit；["path"] 打印本仓库 wiki 目录；["projects"] 列出全部 wiki。',
      '写文章、编译 wiki 请用 codewiki_generate（智能体编排），不要用本工具手写文章。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库根或子目录）' },
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
    execute: async (args) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('cw：插件已在设置中停用（codewiki → enabled）')
      const cwd = String(args.cwd ?? '').trim()
      if (!cwd || !fs.existsSync(cwd)) throw new Error(`cw：cwd 不存在：${cwd}`)
      const argv = (Array.isArray(args.args) ? args.args : []).map(String).filter((s) => s.length > 0)
      if (!argv.length) throw new Error('cw：args 不能为空，例如 ["status"]')
      if (!CW_SUBCOMMANDS.includes(argv[0])) {
        throw new Error(`cw：未知子命令 "${argv[0]}"，允许：${CW_SUBCOMMANDS.join(' / ')}`)
      }
      const binary = resolveBinary(c)
      const r = await runCw(binary, cwd, argv)
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

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9\-_]+/g, '-').replace(/^-+|-+$/g, '') || 'module'
}

function parsePlan(text) {
  if (!text) return null
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const plan = JSON.parse(t.slice(s, e + 1))
    if (!Array.isArray(plan.modules)) return null
    plan.modules = plan.modules.filter((m) => m && typeof m.name === 'string' && Array.isArray(m.files) && m.files.length > 0)
    if (!plan.modules.length) return null
    if (!Array.isArray(plan.concepts)) plan.concepts = []
    plan.concepts = plan.concepts.filter((c) => c && typeof c.name === 'string')
    if (typeof plan.project !== 'string') plan.project = ''
    return plan
  } catch {
    return null
  }
}

// 读文章 frontmatter 的 source_files（缩进列表或行内数组），供 stale 流程取文件清单。
function readSourceFiles(articlePath) {
  try {
    const raw = fs.readFileSync(articlePath, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return []
    const fm = m[1]
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
  } catch {
    return []
  }
}

async function wikiPathFor(cwd, binary) {
  const r = await runCw(binary, cwd, ['path'], 30000)
  const p = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (r.exitCode === 0 && p) return p
  return path.join(os.homedir(), '.codewiki', path.basename(path.resolve(cwd)))
}

function generateToolDefinition(cfg, subagents) {
  return {
    name: 'codewiki_generate',
    description: [
      '编译/刷新指定仓库的 CodeWiki（智能体编排版）。流程：cw status 判态 → 规划 agent 出模块计划 → 按并发上限分批派写文章子代理 → 横切文章（_architecture/_patterns/concepts）→ 审校 agent → cw index + meta update。',
      'scope=auto（默认）：无 wiki 或未编译走全量；有变更走逐篇更新；最新则直接报告。scope=full：强制全量。scope=stale：只刷新过期文章。',
      'provider+model 成对出现时子代理用指定模型；缺省用插件默认（aliyun-bailian/qwen3.8-flash，即路由插件 wiki 档）；两项默认都显式置空才继承会话模型。',
      '全量编译小仓库也要几分钟（多个子代理接力），适合后台调用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库）' },
        scope: { type: 'string', enum: ['auto', 'full', 'stale'], description: '编译范围，默认 auto' },
        provider: { type: 'string', description: '子代理 provider（须与 model 成对）' },
        model: { type: 'string', description: '子代理 model（须与 provider 成对）' },
        maxConcurrency: { type: 'number', description: '写文章并发上限（1-2，默认 2）' },
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
          articles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                stopReason: { type: 'string' },
              },
              required: ['name', 'ok', 'stopReason'],
            },
          },
          writtenCount: { type: 'number' },
          failedCount: { type: 'number' },
          verified: { type: 'boolean' },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['cwd', 'scope', 'state', 'articles', 'writtenCount', 'failedCount', 'notes'],
      },
      render(args, value) {
        const lines = [`codewiki_generate（${value.scope}，${value.cwd}）`]
        if (value.wikiPath) lines.push(`wiki：${value.wikiPath}`)
        if (value.articles.length) {
          lines.push('文章：')
          for (const a of value.articles) lines.push(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : `（${a.stopReason}）`}`)
        }
        lines.push(`完成 ${value.writtenCount} 篇，失败 ${value.failedCount} 篇${value.verified === true ? '，已审校' : ''}`)
        for (const n of value.notes) lines.push(`· ${n}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('codewiki_generate：插件已在设置中停用（codewiki → enabled）')
      if (!exec?.agent) throw new Error('codewiki_generate 必须在主代理会话中调用（缺少 calling agent）')
      const cwd = String(args.cwd ?? '').trim()
      if (!cwd || !fs.existsSync(cwd)) throw new Error(`codewiki_generate：cwd 不存在：${cwd}`)
      const scope = ['auto', 'full', 'stale'].includes(args.scope) ? args.scope : 'auto'
      const language = String(args.language ?? '').trim() || c.articleLanguage
      const concurrency = Number.isFinite(Number(args.maxConcurrency)) && Number(args.maxConcurrency) >= 1
        ? Math.min(Math.floor(Number(args.maxConcurrency)), CONCURRENCY_HARD_CAP)
        : c.maxConcurrency
      const route = (args.provider && args.model)
        ? { provider: String(args.provider), model: String(args.model) }
        : (c.defaultProvider && c.defaultModel ? { provider: c.defaultProvider, model: c.defaultModel } : undefined)
      const notes = []
      if (args.provider && args.model) notes.push(`子代理模型：${route.provider}/${route.model}（调用参数）`)
      else if (route) notes.push(`子代理模型：${route.provider}/${route.model}（插件默认配置）`)
      else notes.push('子代理模型：继承会话模型')

      const binary = resolveBinary(c)
      const statusRes = await runCw(binary, cwd, ['status'])
      if (statusRes.timedOut) throw new Error('codewiki_generate：cw status 超时')
      const status = parseStatus(statusRes.stdout)
      const wikiPath = await wikiPathFor(cwd, binary)

      // scope 修正：stale 遇到没有 wiki 的仓库自动升全量，否则无从谈起
      let effectiveScope = scope
      if (scope === 'stale' && (status.state === 'missing' || status.state === 'uncompiled')) {
        effectiveScope = 'full'
        notes.push('scope=stale 但尚无 wiki，自动升为全量编译')
      }
      const needsFullCompile = effectiveScope === 'full' || status.state === 'missing' || status.state === 'uncompiled'

      const result = {
        cwd,
        scope: effectiveScope,
        wikiPath,
        state: status.state,
        articles: [],
        writtenCount: 0,
        failedCount: 0,
        verified: false,
        notes,
      }

      // ---- clean：直接报告 ----
      if (status.state === 'clean') {
        notes.push('Wiki is up to date —— 无需编译')
        return result
      }

      // ---- stale / auto 逐篇更新 ----
      if (!needsFullCompile && status.state === 'stale' && status.staleArticles.length) {
        const tasks = status.staleArticles.map((articleRel) => {
          const articlePath = path.join(wikiPath, articleRel.replace(/\\/g, '/'))
          const sourceFiles = readSourceFiles(articlePath)
          if (!sourceFiles.length) {
            notes.push(`文章 ${articleRel} 无 source_files frontmatter，跳过（请手工处理或用 scope=full）`)
            return null
          }
          return {
            label: `codewiki:更新 ${articleRel}`,
            name: articleRel,
            prompt: staleArticlePrompt(cwd, articlePath, sourceFiles, language),
          }
        }).filter(Boolean)
        const results = await runBatched(subagents, exec, tasks, concurrency)
        for (const r of results) {
          result.articles.push({ name: r.name, ok: r.ok, stopReason: r.stopReason })
          if (r.ok) result.writtenCount += 1
          else result.failedCount += 1
        }
        if (result.writtenCount > 0) {
          const idx = await runCw(binary, cwd, ['index'])
          const meta = await runCw(binary, cwd, ['meta', 'update'])
          notes.push(`cw index exit ${idx.exitCode}，cw meta update exit ${meta.exitCode}`)
        }
        for (const r of results) {
          if (!r.ok) notes.push(`失败：${r.name} —— ${failureMessage(r)}`)
        }
        return result
      }

      // ---- stale 但解析不出过期文章 ----
      if (!needsFullCompile && status.state === 'stale' && !status.staleArticles.length) {
        if (status.changedFiles.length) {
          const meta = await runCw(binary, cwd, ['meta', 'update'])
          notes.push(`有 ${status.changedFiles.length} 个文件变更但未命中任何文章的 source_files，已刷新编译基线（meta update exit ${meta.exitCode}）`)
          return result
        }
        notes.push('cw status 输出无法解析，改走全量编译')
      }

      // ---- 全量编译（scope=full，或 auto 命中 missing/uncompiled/无法解析）----
      if (needsFullCompile || status.state === 'stale') {
        if (status.state === 'missing') {
          const init = await runCw(binary, cwd, ['init'])
          if (init.exitCode !== 0) {
            throw new Error(`codewiki_generate：cw init 失败（exit ${init.exitCode}）—— ${(init.stderr || init.stdout || '').trim()}`)
          }
          notes.push('cw init 完成')
        }

        // 规划：一个勘探 agent 出模块 JSON 计划；失败降级单 agent 全量
        let plan = null
        const planned = await safeLaunch(subagents, exec, {
          label: 'codewiki:模块规划',
          prompt: plannerPrompt(cwd),
          route,
        })
        if (planned.ok) plan = parsePlan(planned.text)
        if (!plan) {
          notes.push(`模块规划${planned.ok ? '未产出可用 JSON' : `失败（${failureMessage(planned)}）`}，降级单 agent 全量编译`)
        }

        if (!plan) {
          const r = await safeLaunch(subagents, exec, {
            label: 'codewiki:全量编译（降级单 agent）',
            prompt: fallbackCompilePrompt(cwd, wikiPath, language),
            route,
          })
          result.articles.push({ name: '_all（单 agent 全量）', ok: r.ok, stopReason: r.stopReason })
          if (r.ok) result.writtenCount += 1
          else {
            result.failedCount += 1
            notes.push(`全量编译失败 —— ${failureMessage(r)}`)
          }
        } else {
          notes.push(`规划：${plan.modules.length} 个模块、${plan.concepts.length} 个概念${plan.project ? `（${plan.project}）` : ''}`)
          const moduleTasks = plan.modules.map((mod) => ({
            label: `codewiki:模块 ${mod.name}`,
            name: `modules/${slugify(mod.name)}.md`,
            prompt: moduleArticlePrompt(cwd, wikiPath, mod, language),
          }))
          const moduleResults = await runBatched(subagents, exec, moduleTasks, concurrency)
          for (const r of moduleResults) {
            result.articles.push({ name: r.name, ok: r.ok, stopReason: r.stopReason })
            if (r.ok) result.writtenCount += 1
            else result.failedCount += 1
          }
          const okModules = moduleResults.filter((r) => r.ok).length
          if (okModules === 0) {
            notes.push('全部模块文章失败，跳过横切与审校（不刷新编译基线）')
          } else {
            if (okModules < moduleTasks.length) {
              notes.push(`${moduleTasks.length - okModules} 个模块文章失败，横切文章按成功模块撰写`)
            }
            const cross = await safeLaunch(subagents, exec, {
              label: 'codewiki:横切文章',
              prompt: crosscutPrompt(cwd, wikiPath, plan, language),
              route,
            })
            result.articles.push({ name: '_architecture + _patterns + concepts', ok: cross.ok, stopReason: cross.stopReason })
            if (cross.ok) result.writtenCount += 1
            else notes.push(`横切文章失败 —— ${failureMessage(cross)}`)

            const verify = await safeLaunch(subagents, exec, {
              label: 'codewiki:审校',
              prompt: verifyPrompt(cwd, wikiPath),
              route,
            })
            result.verified = verify.ok
            if (verify.ok && verify.text) notes.push(`审校：${verify.text.trim().slice(0, 800)}`)
            else if (!verify.ok) notes.push(`审校失败（不阻塞收尾）—— ${failureMessage(verify)}`)
          }
        }

        if (result.writtenCount > 0) {
          const idx = await runCw(binary, cwd, ['index'])
          const meta = await runCw(binary, cwd, ['meta', 'update'])
          notes.push(`cw index exit ${idx.exitCode}，cw meta update exit ${meta.exitCode}`)
        } else {
          notes.push('没有文章写成功，跳过 index/meta update（wiki 基线不变，可重试）')
        }
        return result
      }

      notes.push('Wiki is up to date —— 无需编译')
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  ctx.inject?.(['tools', 'subagents'], (rc) => {
    const tools = rc?.tools ?? rc
    if (!tools?.register) return
    const subagents = rc?.subagents ?? rc
    for (const definition of [cwToolDefinition(config), generateToolDefinition(config, subagents)]) {
      const disposer = tools.register(definition)
      if (typeof disposer === 'function') {
        if (typeof ctx.effect === 'function') ctx.effect(() => disposer)
        else ctx.on?.('dispose', () => { try { disposer() } catch { /* 忽略 */ } })
      }
    }
  })
}
