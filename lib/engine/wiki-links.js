// wiki 正文里的跨页链接：一份扫描规则，三处消费方共用。
//
// 为什么必须共用：同一件事（「这段正文里有哪些 .md 链接」）原来在三处各写一个正则，
// 并且在演进中分叉了 —— article-contract.js 只捕获目标、proofread.js 捕获目标、
// quality-gate.js 还要捕获链接文字与锚点以便原位替换。分叉的直接后果是
// `[^)\s]+?\.md` 与 `[^)\s]+\.md` 谁对谁错没人说得清：贪婪版会把 `x.md.y.md`
// 整段当目标，惰性版取第一个 `.md`。判据不一致意味着「门判它是死链、改写器却认不出
// 这条链接」，两边的结论对不上。
//
// 约定：目标是**第一个** `.md` 结尾的那一段（惰性），锚点 `#...` 单独捕获，
// 外部协议（`http:`、`mailto:` 等）由调用方按需跳过（它们的判定取决于用途）。

// 完整形态 `[文字](目标.md)` 或 `[文字](目标.md#锚点)`。
// 文字部分不含 `]` 与换行；目标不含空白与 `)`。
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/g

/**
 * 扫出正文里的全部跨页链接。
 *
 * @param {string} text 正文。调用方若需忽略代码块与行内代码（`stripCode` 之后的等长文本），
 *                      应自己先剥——本函数只管语法，不管语境。
 * @returns {{ index: number, whole: string, label: string, target: string, anchor: string }[]}
 *          `index`/`whole` 用于在**原文**里原位替换（stripCode 保证长度不变时偏移一致）。
 */
export function scanPageLinks(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(LINK_RE)) {
    out.push({
      index: m.index,
      whole: m[0],
      label: m[1],
      target: m[2],
      anchor: m[3] ?? '',
    })
  }
  return out
}

/** 是否为外部协议链接（`https:`、`mailto:` 之类），这类不参与页面内解析。 */
export function isExternalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(target ?? ''))
}
