// 验证 0.2.3 路径修复：直接调模块里的 cw 工具 execute，覆盖三种 cwd 形态。
// 用法：node test-cwd-paths.mjs <真实仓库路径的 Windows 形式（不带盘符冒号也行）>
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from './index.js'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const repoWin = process.argv[2] ?? 'E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin'
// 从 Windows 形式推导 MSYS 形式（E:/x → /e/x）
const msys = '/' + repoWin.replace(/^([A-Za-z]):\//, (_, d) => d.toLowerCase() + '/')

const registered = {}
const ctx = {
  inject(_names, fn) {
    fn({ tools: { register(d) { registered[d.name] = d } }, subagents: {} })
  },
  effect() {},
}

await plugin.apply(ctx, {})

const cw = registered.cw
if (!cw) { console.error('FAIL: cw tool not registered'); process.exit(1) }

// --- 1) resolveBinary：无显式配置时应选 PATH 里的 cw（与源码同步），而非捆绑副本 ---
const cfgProbe = { enabled: true, binaryPath: '', defaultProvider: '', defaultModel: '', maxConcurrency: 2, articleLanguage: '中文' }
// resolveBinary 未导出——通过 execute 结果间接验证：MSYS 路径能跑通即证明归一化 + PATH 探测生效。
// 直接验证捆绑副本已与 cargo 构建一致由外部 sha256 完成这里不重复。

// --- 2) MSYS 路径（问题 1 的复现场景）---
const execStub = { signal: undefined }
let r
try {
  r = await cw.execute({ cwd: msys, args: ['path'] }, execStub)
  console.log(`MSYS cwd=${msys}`)
  console.log(`  exit=${r.exitCode} stdout=${r.stdout.trim()}`)
} catch (e) {
  console.error(`FAIL: MSYS path rejected: ${e.message}`)
  process.exit(1)
}
if (r.exitCode !== 0 || !/\.codewiki$/i.test(r.stdout.trim())) {
  console.error('FAIL: cw path did not return repo-local .codewiki')
  process.exit(1)
}
console.log('PASS: MSYS path normalized and executed (cw path → <repo>/.codewiki)')

// --- 3) Windows 路径 + status 三态（问题 2 的复现场景）---
const r2 = await cw.execute({ cwd: repoWin, args: ['status'] }, execStub)
const first = r2.stdout.trim().split('\n')[0]
console.log(`Windows cwd=${repoWin}`)
console.log(`  exit=${r2.exitCode} head=${first}`)
if (r2.exitCode !== 0) { console.error('FAIL: cw status nonzero'); process.exit(1) }
if (/No wiki found/.test(r2.stdout)) {
  console.error('FAIL: still "No wiki found" — resolveBinary likely picked a stale bundled binary')
  process.exit(1)
}
console.log('PASS: cw status on Windows path returns real tri-state (not "No wiki found")')

// --- 4) wikiPathFor 兜底路径：无法直接调（未导出），契约由 cw path 成功路径覆盖；兜底改为 <cwd>/.codewiki 在源码中可查 ---

// --- 5) 不存在的路径仍要干净报错 ---
try {
  await cw.execute({ cwd: '/q/nonexistent-repo-xyz', args: ['status'] }, execStub)
  console.error('FAIL: nonexistent path did not throw')
  process.exit(1)
} catch (e) {
  if (!/cwd 不存在/.test(e.message)) { console.error(`FAIL: unexpected error: ${e.message}`); process.exit(1) }
  console.log(`PASS: nonexistent path errors cleanly: ${e.message}`)
}

console.log('ALL PASS')
