// TechDocs 站点回读：把上游 PR #155（a1b9f4a）生成的 mkdocs 站点搬进插件写集。
//
// 上游那一步是 `Path.write_text` 直接写盘（codewiki/cli/techdocs_generator.py:406），
// 不经过落地器。让它往 `.codewiki/` 里写就等于开出第二条写盘通道：partial/failed 轮
// 会留下一份半成品站点，而它与文章不在同一份 pre-image 里，回滚也收不走。
// 所以目标目录由 entry.py 指到仓库外的临时位置，这里把它读成写集项，
// 再交给 apply-plan 的 extraFiles —— 与文章共用一次回滚、一个提交。
//
// 落在 `.codewiki/_techdocs/` 的原因和受管状态一样：`cw index` 会 WalkDir 递归
// 整个 `.codewiki/`，只跳过相对路径以 `_` 开头的项（vendor/codewiki/src/main.rs:244）。
// `_techdocs` 首段是 `_`，站点的 .md 因此不进索引，也不会被
// findArticlesMissingFromIndex 判成「写集里的 .md 没被收录」。
//
// 站点是**引擎原始产物**的可浏览版本（来自 docsDir，即 `_native-state/docs` 同源），
// 不是 `.codewiki/modules/` 里那批加工后的模块页——后者过了质量门、链接改成了 wiki
// 小写 slug，不是 mkdocs 站的形态。两者各有用途，不要指望它们逐字相同。

import fs from 'node:fs'
import path from 'node:path'

// 站点目录（相对仓库根，POSIX）。首段以 `_` 开头，理由见文件头。
export const TECHDOCS_DIR = '.codewiki/_techdocs'

/** 递归收集目录下的文件（相对 dir 的 POSIX 路径）。目录不存在时返回 []。 */
function walkFiles(dir) {
  const out = []
  const walk = (cur, prefix) => {
    for (const it of fs.readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${it.name}` : it.name
      const abs = path.join(cur, it.name)
      if (it.isDirectory()) { walk(abs, rel); continue }
      if (it.isFile()) out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * 把仓库外的 TechDocs 站点目录读成写集项。
 *
 * 只收 utf8 文本：上游会连带复制 docs 里的图片（ASSET_EXTENSIONS），而落地器的
 * extraFiles 要求 content 是字符串，塞二进制等于写坏文件。图片因此被跳过并记进
 * skipped —— 本插件的引擎产物实测不含图片（引擎只写 .md/.json），这条分支只在
 * 上游将来往 docs 里放素材时才会命中，届时需要另开二进制通道而不是硬塞。
 *
 * @param {object} o
 * @param {string} o.siteDir         站点根（仓库外，含 mkdocs.yml 与 docs/）
 * @param {string} [o.destDir]       落到仓库里的目录（相对仓库根）
 * @returns {{files:Array<{rel:string, content:string}>, captured:string[], skipped:string[]}}
 */
export function captureSite({ siteDir, destDir = TECHDOCS_DIR } = {}) {
  const src = path.resolve(String(siteDir ?? ''))
  const files = []
  const captured = []
  const skipped = []
  if (!fs.existsSync(src)) return { files, captured, skipped: ['（站点目录不存在）'] }
  for (const rel of walkFiles(src)) {
    const from = path.join(src, ...rel.split('/'))
    let content
    try {
      content = fs.readFileSync(from, 'utf8')
    } catch (err) {
      skipped.push(`${rel}（${err?.code ?? err?.message ?? err}）`)
      continue
    }
    // U+FFFD 意味着原始字节不是合法 utf8（图片、字体、压缩资源）：写回去就是坏文件。
    if (content.includes('\uFFFD')) {
      skipped.push(`${rel}（非 utf8 文本，不纳入站点写集）`)
      continue
    }
    files.push({ rel: `${destDir}/${rel}`, content })
    captured.push(rel)
  }
  return { files, captured, skipped }
}

export default { TECHDOCS_DIR, captureSite }
