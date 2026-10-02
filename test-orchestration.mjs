// test-orchestration.mjs — dsh-codewiki 编排行为冒烟：
// mock 子代理服务 + 真实 cw CLI，验证 codewiki_generate 全量编译与 stale 逐篇更新两条路径
// （这两条路径都会触碰 subagents 接线——0.2.1 之前接线断裂，一进编译就 ReferenceError）。
// 运行：node test-orchestration.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { name, apply } = await import('./index.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

function articleMd(title, source, type = 'module') {
  return `---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\nTest article body.\n`
}

// mock 子代理服务：按 label 路由，写文章任务真实落盘（模拟子代理用自己的写文件工具）
function makeMockSubagents() {
  const calls = []
  const state = { wikiPath: '' }
  return {
    calls,
    async start(_kind, payload) {
      calls.push(payload)
      const label = payload.label ?? ''
      const text = (payload.prompt ?? []).map((b) => b?.text ?? '').join('')
      let reply = ''
      if (label.includes('模块规划')) {
        reply = '```json\n' + JSON.stringify({
          project: 'fixture',
          modules: [
            { name: 'core', summary: '核心', files: ['src/core.py'] },
            { name: 'util', summary: '工具', files: ['src/util.py'] },
          ],
          concepts: [{ name: 'config-load', files: ['src/core.py'] }],
        }) + '\n```'
      } else if (label.startsWith('codewiki:更新 ')) {
        const rel = label.replace('codewiki:更新 ', '')
        const file = path.join(state.wikiPath, rel.replace(/\\/g, '/'))
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n<!-- updated by test -->\n')
        reply = `WROTE ${file}`
      } else if (label.startsWith('codewiki:模块 ')) {
        const m = text.match(/把文章写入：(\S+?\.md)/)
        if (!m) throw new Error('mock: 模块 prompt 里找不到写入路径')
        const file = m[1]
        state.wikiPath = path.dirname(path.dirname(file))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const modName = label.replace('codewiki:模块 ', '')
        fs.writeFileSync(file, articleMd(modName, `src/${modName}.py`))
        reply = `WROTE ${file}`
      } else if (label.includes('横切')) {
        const w = state.wikiPath
        fs.mkdirSync(path.join(w, 'concepts'), { recursive: true })
        fs.writeFileSync(path.join(w, '_architecture.md'), articleMd('Architecture', 'src/core.py', 'architecture'))
        fs.writeFileSync(path.join(w, '_patterns.md'), articleMd('Patterns', 'src/util.py', 'pattern'))
        fs.writeFileSync(path.join(w, 'concepts', 'config-load.md'), articleMd('config-load', 'src/core.py', 'concept'))
        reply = `WROTE ${path.join(w, '_architecture.md')}`
      } else if (label.includes('审校')) {
        reply = 'VERIFIED（修复 0 处）'
      } else {
        throw new Error(`mock: 未识别的任务 label：${label}`)
      }
      return {
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: reply }] }),
        dispose: async () => {},
      }
    },
  }
}

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-orch-'))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'core.py'), 'def run():\n    return "core"\n')
  fs.writeFileSync(path.join(dir, 'src', 'util.py'), 'def fmt():\n    return "util"\n')
  const git = (...a) => execFileSync('git', a, { cwd: dir })
  git('init')
  git('add', '.')
  git('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'init')
  return dir
}

// ---- 注册捕获 ----
const mockSubagents = makeMockSubagents()
const registered = new Map()
const rc = {
  tools: { register(def) { registered.set(def.name, def); return () => {} } },
  subagents: mockSubagents,
}
apply({ inject: (deps, fn) => fn(rc) }, { defaultProvider: 'mock-prov', defaultModel: 'mock-model' })

console.log('== 注册 ==')
check(name === 'dsh-codewiki', `插件名 ${name}`)
check(registered.get('cw') && registered.get('codewiki_generate'), 'cw 与 codewiki_generate 两个工具均已注册')

const gen = registered.get('codewiki_generate')
const cw = registered.get('cw')
const repo = makeFixtureRepo()

try {
  console.log('== cw 工具 ==')
  const st = await cw.execute({ cwd: repo, args: ['status'] })
  check(st.exitCode === 0 && /No wiki found/i.test(st.stdout), 'cw status 判定 missing 态')

  console.log('== codewiki_generate 全量编译 ==')
  const callsBeforeFull = mockSubagents.calls.length
  const r1 = await gen.execute({ cwd: repo }, { agent: 'test-agent' })
  console.log('  notes:', r1.notes.join(' | '))
  const planner = mockSubagents.calls[0]
  check(planner?.agentOptions?.provider === 'mock-prov' && planner?.agentOptions?.model === 'mock-model', '规划 agent 携带插件默认模型路由 agentOptions')
  const fullCalls = mockSubagents.calls.slice(callsBeforeFull)
  const moduleCalls = fullCalls.filter((p) => String(p.label ?? '').startsWith('codewiki:模块 '))
  check(moduleCalls.length >= 2 && moduleCalls.every((p) => p.agentOptions?.provider === 'mock-prov' && p.agentOptions?.model === 'mock-model'), `模块文章 agent（${moduleCalls.length} 个）携带插件默认模型路由 agentOptions`)
  check(fullCalls.every((p) => p.agentOptions?.provider === 'mock-prov' && p.agentOptions?.model === 'mock-model'), '全量路径全部 spawn 调用均携带 agentOptions')
  check(r1.writtenCount >= 3 && r1.failedCount === 0, `全量编译完成 ${r1.writtenCount} 篇、失败 ${r1.failedCount} 篇`)
  check(r1.verified === true, '审校 agent 已执行')
  check(fs.existsSync(path.join(r1.wikiPath, 'modules', 'core.md')), 'modules/core.md 落盘')
  check(fs.existsSync(path.join(r1.wikiPath, '_architecture.md')), '_architecture.md 落盘')
  check(r1.notes.some((n) => n.includes('cw index')), `收尾 index/meta update 已执行（${r1.notes.find((n) => n.includes('cw index'))}）`)

  console.log('== codewiki_generate clean + scope=full（强制全量） ==')
  const r1b = await gen.execute({ cwd: repo, scope: 'full' }, { agent: 'test-agent' })
  console.log('  notes:', r1b.notes.join(' | '))
  check(r1b.scope === 'full' && r1b.writtenCount >= 3, `clean 态 scope=full 强制全量重编（${r1b.writtenCount} 篇）`)
  check(!r1b.notes.some((n) => n.includes('无需编译')), 'scope=full 不被 clean 短路')

  console.log('== codewiki_generate stale 逐篇更新 ==')
  fs.writeFileSync(path.join(repo, 'src', 'core.py'), 'def run():\n    return "core-v2"\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'v2'], { cwd: repo })
  const callsBeforeStale = mockSubagents.calls.length
  const r2 = await gen.execute({ cwd: repo, scope: 'stale' }, { agent: 'test-agent' })
  console.log('  notes:', r2.notes.join(' | '))
  const staleCalls = mockSubagents.calls.slice(callsBeforeStale)
  check(staleCalls.length >= 1 && staleCalls.every((p) => String(p.label ?? '').startsWith('codewiki:更新 ') && p.agentOptions?.provider === 'mock-prov' && p.agentOptions?.model === 'mock-model'), `逐篇更新 agent（${staleCalls.length} 个）携带插件默认模型路由 agentOptions`)
  check(r2.writtenCount >= 1 && r2.failedCount === 0, `stale 更新完成 ${r2.writtenCount} 篇、失败 ${r2.failedCount} 篇`)
  check(fs.readFileSync(path.join(r1.wikiPath, 'modules', 'core.md'), 'utf8').includes('updated by test'), '过期文章已被重写')
} finally {
  fs.rmSync(repo, { recursive: true, force: true })
  try { fs.rmSync(path.join(os.homedir(), '.codewiki', path.basename(repo)), { recursive: true, force: true }) } catch { /* wikiPath 已删 */ }
}

console.log(failures ? `\nFAIL：${failures} 项未通过` : '\nPASS：编排冒烟全部通过')
process.exit(failures ? 1 : 0)
