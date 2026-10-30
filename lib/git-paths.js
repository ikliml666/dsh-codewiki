// git 的路径输出与「同一件事」有两层落差，本模块只负责把它铲平。
//
// 落差一：`core.quotepath`（默认 true）。非 ASCII 路径在 `--name-only` /
// `--name-status` 的输出里会被写成 `"a/\344\270\255.md"`——八进制字节转义 + 双引号
// 包裹。也就是说 git 已经把**字节**写成 ASCII 安全形式了，任何按字面量比较路径
// 的代码（白名单、`startsWith('.codewiki/')`）都会当场失配。
//
// 落差二：转义是按**字节**做的，所以「解开转义」不能逐字符还原，必须把字节重新
// 拼成 Buffer 再按 UTF-8 解码——一个中文字符是三个 `\NNN`。
//
// 两层都铲平，且两边都能独立成立：
//   · `GIT_QUOTEPATH_OFF` 让新发起的 git 调用**不再转义**（首选，省一次解码）；
//   · `decodeGitPath` 兜住「已经被转义」的输入（旧记录、外部传入的清单、调用方
//     自己的 git 调用没带参数），幂等——非转义串原样返回。
//
// 为什么两件都要：只加参数挡不住已经写进历史记录的清单；只解码则每次都要多绕一层，
// 且 `--name-status` 的 `R100` 行按 tab 切分时引号包裹的路径仍可能带内嵌转义。

/** 让 `git` 不做八进制转义的前置参数（必须紧跟 `git` 之后、子命令之前）。 */
export const GIT_QUOTEPATH_OFF = ['-c', 'core.quotepath=false']

/**
 * 路径归一到 POSIX 分隔符（**唯一实现**）。
 *
 * 为什么收口在这里而不是各模块各写一份：`String(p ?? '').replace(/\\/g, '/')` 曾在
 * apply-plan / manifest / mapping / native-state / output / quality-gate 六个模块里
 * 各抄一份，于是「Windows 反斜杠要不要归一」这件事有六个可能各自跑偏的地方——
 * 其中任何一处漏改，同一条路径在两份报告里就不相等，比较报告的人只会看到
 * 「文件名看起来一样却判不等」。归一语义只有一种，就该只有一处实现。
 *
 * 只换分隔符：不 trim、不去 `./`、不做 `path.posix.normalize`（那会改变 `.`/`..`
 * 的语义，而「上跳」是安全判据，必须由调用方显式判定后再动）。
 */
export function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/** 给一份 git 参数表前置 quotepath 关闭（已是关闭状态则不重复加）。 */
export function withQuotepathOff(args) {
  const list = Array.isArray(args) ? args : []
  if (list[0] === '-c' && list[1] === 'core.quotepath=false') return list
  return [...GIT_QUOTEPATH_OFF, ...list]
}

const SIMPLE_ESCAPES = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c,
}

/**
 * 解开 git 的路径转义。非「双引号包裹的转义串」原样返回（幂等）。
 * 解不开的一律保守地原样返回——宁可让上层看见一个陌生的字面量，也不要吐出半个路径。
 */
export function decodeGitPath(p) {
  const s = String(p ?? '')
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s
  const inner = s.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '\\') {
      const next = inner[i + 1]
      if (next !== undefined && next >= '0' && next <= '7') {
        const oct = inner.slice(i + 1, i + 4)
        if (/^[0-7]{3}$/.test(oct)) {
          bytes.push(parseInt(oct, 8))
          i += 3
          continue
        }
      }
      if (next !== undefined && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)) {
        bytes.push(SIMPLE_ESCAPES[next])
        i += 1
        continue
      }
      // 不认识的转义：保留反斜杠本体，不猜
      bytes.push(0x5c)
      continue
    }
    const cp = ch.codePointAt(0)
    if (cp < 0x80) {
      bytes.push(cp)
    } else {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
    }
    if (cp > 0xffff) i += 1 // 代理对：跳过低半区
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 一份路径清单的整体解码（保持顺序、丢弃空行）。 */
export function decodeGitPaths(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => decodeGitPath(String(p ?? '')))
    .filter((p) => p !== '')
}

export default { GIT_QUOTEPATH_OFF, withQuotepathOff, toPosix, decodeGitPath, decodeGitPaths }
