// 一次性探针：用**真 cw** 跑一次 applyNativeOutput（真 git 仓库、真 index/meta、真提交）。
// 不碰仓库本身，全部在临时目录里。跑完即删。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyNativeOutput, verifyCommitScope } from '../../lib/engine/apply-plan.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-real-cw-'))
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true })
git('init', '-q')
git('config', 'user.email', 'probe@example.com')
git('config', 'user.name', 'probe')
fs.writeFileSync(path.join(root, 'README.md'), '# r\n')
git('add', '--', 'README.md')
git('commit', '-q', '-m', 'init', '--no-verify')
const head = git('rev-parse', 'HEAD').stdout.trim()

// docs：一份带 frontmatter 的入口 + 两篇文章（含中文标题与冒号，测 YAML 安全性）
const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-real-docs-'))
fs.mkdirSync(path.join(docs, 'modules'), { recursive: true })
fs.writeFileSync(path.join(docs, 'overview.md'), '---\ntitle: 项目概览\ntype: overview\n---\n\n# 项目概览\n\n入口正文，含 [[modules:core|核心]] 链接。\n')
fs.writeFileSync(path.join(docs, 'modules', 'core.md'), '---\ntitle: "核心: 引擎"\nmodule_path: ["core"]\n---\n\n# 核心\n\n## 概览\n\n核心正文。\n')
fs.writeFileSync(path.join(docs, 'metadata.json'), JSON.stringify({ generation_info: { layout: 'hierarchical', commit_id: head } }))
fs.writeFileSync(path.join(docs, 'module_tree.json'), JSON.stringify({ core: {} }))

const report = {
  version: 1, ok: true, outcome: 'done', writable: true, canAdvanceBaseline: true,
  entry: { source: 'overview.md', path: 'CodeWiki.md', ok: true },
  articles: [
    { source: 'modules/core.md', wikiPath: '.codewiki/modules/core.md', action: 'write' },
  ],
  rendered: [
    { source: 'modules/core.md', wikiPath: '.codewiki/modules/core.md', type: 'module', content: fs.readFileSync(path.join(docs, 'modules', 'core.md'), 'utf8') },
  ],
  defects: [], degradations: [], stale: [], blockers: [],
}

const r = await applyNativeOutput({ repoRoot: root, report, docsDir: docs })
console.log(JSON.stringify({
  outcome: r.outcome,
  applied: r.applied,
  written: r.written,
  index: r.index,
  baseline: r.baseline,
  commit: r.commit,
  problems: r.problems,
  notes: r.notes,
}, null, 2))

// 真产物核对：_index.md 里有没有反斜杠残留、_meta.yaml 有没有写基线
const idxPath = path.join(root, '.codewiki', '_index.md')
const metaPath = path.join(root, '.codewiki', '_meta.yaml')
console.log('\n--- _index.md ---\n' + (fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf8') : '(不存在)'))
console.log('--- _meta.yaml ---\n' + (fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '(不存在)'))
const show = spawnSync('git', ['show', '--name-only', '--pretty=format:'], { cwd: root, encoding: 'utf8' })
console.log('--- 提交内容 ---\n' + show.stdout)
console.log('--- 提交范围核验 ---\n' + JSON.stringify(verifyCommitScope(root, 'HEAD')))
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(docs, { recursive: true, force: true })
