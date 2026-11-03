// test-reasoning-effort.mjs — 思考档位合法性（0.17.24）。
//
// 真机上踩到的坑：编译模型配成 trae/deepseek-v4.1-flash + reasoningEffort=off，
// 而该模型的档位表只有 low/high/xhigh。provider 不报错，直接回 200 + 空内容，
// 桥日志只剩一个 finish chunk、引擎记 "Tokens used: 0"，40 次调用全部空跑。
// 结果是任务看起来正常走完、实际一篇文章都没写。
//
// 所以档位合法性必须在提交入口校验一次（系统边界：用户配置 × 外部 provider 能力），
// 而不是等到每篇文章都空跑完再靠 note 提示。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `cw-effort-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`)
const { effortError } = await import('./index.js')

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.error(`  ✗ ${msg}`) } }

const TRAE = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Xhigh' },
]

check(effortError(TRAE, 'low') === null, '档位在表里时放行')
check(effortError(TRAE, 'off') !== null, '档位不在表里时报错')
check(String(effortError(TRAE, 'off')).includes('off'), '报错里点名配错的那个档位')
check(String(effortError(TRAE, 'off')).includes('low/high/xhigh'), '报错里列出该模型真实可用的档位')

// 「不知道」不等于「不支持」：留空、模型未声明档位、探测失败都放行，
// 否则没暴露档位目录的 provider 会被一刀切拦死。
check(effortError(TRAE, '') === null, '留空（用模型默认档）放行')
check(effortError(TRAE, null) === null, 'null 放行')
check(effortError(TRAE, '   ') === null, '纯空白视同留空')
check(effortError([], 'off') === null, '模型未声明任何档位时放行（无从判断）')
check(effortError(null, 'off') === null, '档位清单缺失时放行')
check(effortError(undefined, 'off') === null, '档位清单 undefined 时放行')

check(effortError([{ id: 'low' }], 'LOW') !== null, '档位 id 区分大小写，不猜用户意图')
check(effortError([{ id: '' }], 'off') === null, '清单里全是空 id 时视同未声明，放行')

fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
console.log(failures ? `FAIL：${failures} 项失败` : 'PASS：思考档位校验全部通过')
process.exit(failures ? 1 : 0)
