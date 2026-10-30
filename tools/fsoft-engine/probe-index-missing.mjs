// 一次性探针：验证「cw index 退出 0 但文章没进索引」这条真实存在，并被落地器抓成 index-failed。
// 全在临时目录，不碰仓库。跑完即删。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyNativeOutput } from '../../lib/engine/apply-plan.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-missing-'))
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true })
git('init', '-q')
git('config', 'user.email', 'p@example.com')
git('config', 'user.name', 'p')
fs.writeFileSync(path.join(root, 'README.md'), '# r\n')
git('add', '--', 'README.md')
git('commit', '-q', '-m', 'init', '--no-verify')

const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-missing-docs-'))
fs.writeFileSync(path.join(docs, 'overview.md'), '---\ntitle: 项目\ntype: overview\n---\n\n# 项目\n\n入口。\n')
fs.mkdirSync(path.join(docs, 'modules'))
// 关键：title 裸值里带 ": "，serde_yaml 会把「引擎」解析成嵌套映射 → 整篇 frontmatter 解析失败
fs.writeFileSync(path.join(docs, 'modules', 'core.md'), '---\ntitle: 核心: 引擎\ntype: module\n---\n\n# 核心\n\n正文。\n')

const badContent = fs.readFileSync(path.join(docs, 'modules', 'core.md'), 'utf8')
const report = {
  version: 1, ok: true, outcome: 'done', writable: true, canAdvanceBaseline: true,
  entry: { source: 'overview.md', path: 'CodeWiki.md', ok: true },
  articles: [{ source: 'modules/core.md', wikiPath: '.codewiki/modules/core.md', action: 'write' }],
  rendered: [{ source: 'modules/core.md', wikiPath: '.codewiki/modules/core.md', type: 'module', content: badContent }],
  defects: [], degradations: [], stale: [], blockers: [],
}

const r = await applyNativeOutput({ repoRoot: root, report, docsDir: docs })
console.log('outcome =', r.outcome)
console.log('rolledBack =', r.rolledBack)
console.log('problems =', JSON.stringify(r.problems))
console.log('index =', JSON.stringify(r.index))
console.log('盘上还有文章吗 =', fs.existsSync(path.join(root, '.codewiki', 'modules', 'core.md')))
console.log('盘上还有入口吗 =', fs.existsSync(path.join(root, 'CodeWiki.md')))
console.log('盘上还有 _index.md 吗 =', fs.existsSync(path.join(root, '.codewiki', '_index.md')))
