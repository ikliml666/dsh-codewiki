// test-wiki-entry.mjs — CodeWiki.md 入口自动生成单元测试（ensureWikiEntry）：
// 缺失时生成（含 .codewiki 绝对路径、codewiki_generate 收尾指引、中英双语）、
// 已有入口绝不覆盖、空 cwd 安全返回。
// 另含 Windows 路径规范化（normalizeArticlePath / parseStatus / normalizeIndexLinks）：
// cw 在 Windows 输出的 `\` 分隔路径污染 stale 清单与 _index.md 链接，插件层统一收口。
// 运行：node test-wiki-entry.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus } from './index.js'

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codewiki-entry-'))
const repo = (name) => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 1. 缺失 → 生成中文入口
const repo1 = repo('repo1')
check(ensureWikiEntry(repo1, '中文') === true, '缺失入口时返回 true 并生成文件')
const text1 = fs.readFileSync(path.join(repo1, 'CodeWiki.md'), 'utf8')
check(text1.includes(path.join(repo1, '.codewiki')), '正文含 .codewiki 绝对路径')
check(text1.includes('codewiki_generate'), '正文含收尾工具名 codewiki_generate')
check(text1.includes('.codewiki/_architecture.md'), '正文含架构总览指引')
check(text1.includes('不会覆盖'), '正文声明不覆盖人工入口')

// 2. 已有入口 → 绝不覆盖
const repo2 = repo('repo2')
const custom = '# My custom entry\n手写速查。\n'
fs.writeFileSync(path.join(repo2, 'CodeWiki.md'), custom, 'utf8')
check(ensureWikiEntry(repo2, '中文') === false, '已有入口时返回 false')
check(fs.readFileSync(path.join(repo2, 'CodeWiki.md'), 'utf8') === custom, '已有入口内容未被覆盖')

// 3. 英文语言 → 英文文案
const repo3 = repo('repo3')
check(ensureWikiEntry(repo3, 'English') === true, '英文语言仍生成')
const text3 = fs.readFileSync(path.join(repo3, 'CodeWiki.md'), 'utf8')
check(!text3.includes('活 wiki') && text3.includes('living wiki'), '英文语言用英文文案')
check(text3.includes('codewiki_generate'), '英文文案同样含收尾工具名')

// 4. 空 cwd → 安全返回 false 不抛错
check(ensureWikiEntry('', '中文') === false, '空 cwd 返回 false 不抛错')

// 5. 重复调用幂等：第二次调用因文件已存在返回 false 且内容不变
const before = fs.readFileSync(path.join(repo1, 'CodeWiki.md'), 'utf8')
check(ensureWikiEntry(repo1, '中文') === false, '重复调用幂等（第二次返回 false）')
check(fs.readFileSync(path.join(repo1, 'CodeWiki.md'), 'utf8') === before, '重复调用不改变内容')

// 6. Windows 路径规范化
check(normalizeArticlePath('learnings\\update-gap.md') === 'learnings/update-gap.md', 'normalizeArticlePath：\\ → /')
check(normalizeArticlePath('modules/core.md') === 'modules/core.md', 'normalizeArticlePath：正斜杠路径原样保留')
check(normalizeArticlePath(undefined) === '', 'normalizeArticlePath：undefined 安全返回空串')
const st = parseStatus('Changed since last compile (abc1234):\n  M index.js\n  M .codewiki/_index.md\nStale articles:\n  ! modules\\core.md\n  ! concepts\\cfg.md\n')
check(st.state === 'stale' && st.changedFiles.join(',') === 'index.js,.codewiki/_index.md', 'parseStatus：changedFiles 保留并规范化')
check(st.staleArticles.join(',') === 'modules/core.md,concepts/cfg.md', 'parseStatus：staleArticles 的 \\ 已规范化为 /')
const repo6 = repo('repo6')
fs.mkdirSync(path.join(repo6, '.codewiki'), { recursive: true })
const idxText = '# Wiki Index\n\n## Module\n\n- [[modules\\core|core]]\n- [[concepts\\cfg|cfg]]\n\n正文里 `E:\\ik\\repo` 的反斜杠不该被改。\n'
fs.writeFileSync(path.join(repo6, '.codewiki', '_index.md'), idxText, 'utf8')
check(normalizeIndexLinks(repo6) === true, 'normalizeIndexLinks：有改动返回 true')
const idxFixed = fs.readFileSync(path.join(repo6, '.codewiki', '_index.md'), 'utf8')
check(idxFixed.includes('[[modules/core|core]]') && idxFixed.includes('[[concepts/cfg|cfg]]'), 'normalizeIndexLinks：链接头 \\ → /')
check(idxFixed.includes('E:\\ik\\repo'), 'normalizeIndexLinks：正文反斜杠不受影响')
check(normalizeIndexLinks(repo6) === false, 'normalizeIndexLinks：已规范再次调用返回 false（幂等）')
check(normalizeIndexLinks(repo('repo-empty')) === false, 'normalizeIndexLinks：无 _index.md 静默返回 false')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\n全部断言通过')
process.exit(failures ? 1 : 0)
