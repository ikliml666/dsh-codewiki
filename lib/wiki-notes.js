// learnings / decisions 的写入路径（0.17.43）。
//
// 背景：这两个目录是 mraza007/codewiki 的技能约定——`vendor/codewiki/skills/codewiki-session.md`
// 的「After Every Completed Task」要求：修完 bug 写 `learnings/<slug>.md`、定了设计写
// `decisions/<slug>.md`。本插件的原生通道只产 `modules/` 与入口 `CodeWiki.md`，从不写
// 这两类页，于是提醒里那句「learnings/、decisions/ 补文章由流水线完成」长期是假承诺：
// 0.17.39 先把承诺删掉，这里把它补成真实现——由模型显式调 `codewiki_note` 记录。
//
// 本模块只做三件事：拼一篇合规的文章、给出落盘路径、用同一套契约自检。不写盘、不跑
// cw、不碰其它页，便于单测；IO 与索引刷新在 index.js 里。
//
// 为什么这里比 `NATIVE_ARTICLE_OPTS` 严（要求 `## Overview` 非空）：那两个选项是为
// 「引擎刚渲染出来的页」定的——正文由上游 prompt 决定，用本仓库的章节名去判等于给
// 我们被禁止手改的正文判死刑。learning/decision 恰恰相反，是本仓库自己写的页，章节
// 结构由本工具规定；比体检严不会造成「门说 defects=0、存量体检说这篇坏了」的矛盾
// （体检只会更松）。

import fs from 'node:fs'
import path from 'node:path'

import { inspectArticle } from './article-contract.js'

// kind → 目录。与 article-contract.js 的 TYPE_BY_DIR 必须一致，否则 cw index 的分类
// 会和目录对不上（type-mismatch）。两处各写一遍时已经漂过一次，所以这里显式引用同一张表。
export const NOTE_KINDS = Object.freeze({
  learning: 'learnings',
  decision: 'decisions',
})

// 页名规则与 modules 的 slugify 同源（保留 CJK、下划线，其余压成连字符）：
// 中文标题直接作文件名在 Windows 上可用，但会让 [[链接]] 与 cw 的相对路径都变难读，
// 所以这里一律转 slug，标题原文进 frontmatter 的 title。
export function noteSlug(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9\-_]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

function yamlScalar(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim()
}

// 拼出完整文章。tags 与 source_files 一定写出（契约要求字段存在，空列表也是合法形态）。
export function buildNote({ kind, title, slug, sourceFiles = [], tags = [], body = '' }) {
  const dir = NOTE_KINDS[kind]
  if (!dir) throw new Error(`kind 只能是 ${Object.keys(NOTE_KINDS).join(' / ')}，收到 ${kind}`)
  const name = noteSlug(slug || title)
  if (!name) throw new Error('slug 与 title 都为空，无法确定文件名')
  const rel = `${dir}/${name}.md`
  const lines = ['---', `title: ${yamlScalar(title || name)}`, `type: ${kind}`]
  const srcs = (sourceFiles ?? []).map((s) => yamlScalar(s)).filter(Boolean)
  lines.push(srcs.length ? `source_files:\n${srcs.map((s) => `  - ${s}`).join('\n')}` : 'source_files: []')
  const tagList = (tags ?? []).map((t) => yamlScalar(t)).filter(Boolean)
  lines.push(`tags: [${tagList.join(', ')}]`, '---', '', String(body ?? '').replace(/^\s+/, ''))
  return { rel, text: `${lines.join('\n')}\n` }
}

// 现有 wiki 页（相对 `.codewiki/` 的 POSIX 路径），用于内部链接解析。
export function listWikiPages(wikiDir) {
  const out = []
  const walk = (abs, prefix) => {
    let ents
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const rel = `${prefix}${e.name}`
      if (e.isDirectory()) walk(path.join(abs, e.name), `${rel}/`)
      else if (e.name.endsWith('.md')) out.push(rel)
    }
  }
  walk(String(wikiDir), '')
  return out
}

// 与落盘闸门同一套判据（article-contract 的 inspectArticle）：语法、必填字段、
// type 与目录匹配、source_files 存在性、重复 frontmatter、围栏闭合、必需章节、
// 内部链接可解析。只看 error 级——warning（缺非必需章节）不拦。
export function checkNote({ text, rel, repoRoot, wikiDir }) {
  const allowedLinks = [...new Set([...listWikiPages(wikiDir), rel, rel.replace(/\.md$/, '')])]
  const issues = inspectArticle(text, {
    cwd: repoRoot,
    articlePath: rel,
    allowedLinks,
    // 空 source_files 对这两类页是合法形态（「选了 A 不选 B」不必然指向某个文件），
    // 而且存量体检（article-contract 的 NATIVE_ARTICLE_OPTS）本来就放行——这里若拒，
    // 就会出现「写的时候拒、下一轮体检放行」的自相矛盾。章节结构仍按 REQUIRED_SECTIONS 判。
    allowEmptySourceFiles: true,
    fsImpl: {
      exists: (p) => { try { return fs.existsSync(p) } catch { return false } },
      isDirectory: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
    },
  })
  return issues.filter((i) => (i.severity ?? 'error') === 'error')
}
