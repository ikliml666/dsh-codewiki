// test-wiki-entry.mjs — CodeWiki.md 入口自动生成单元测试（ensureWikiEntry）：
// 缺失时生成（含 .codewiki 绝对路径、codewiki_generate 收尾指引、中英双语）、
// 已有入口绝不覆盖、空 cwd 安全返回。
// 运行：node test-wiki-entry.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureWikiEntry } from './index.js'

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

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\n全部断言通过')
process.exit(failures ? 1 : 0)
