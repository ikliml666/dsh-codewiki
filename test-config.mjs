// test-config.mjs — 设置项契约（0.17.5）：旧设置的退役与大档开关的生效语义。
//
// 这里钉两件容易悄悄回归的事：
//   1. 已退役的旧设置不能重新出现在 Config 里——它们在面板上不再有消费方，
//      留着只会让「设置看起来生效、实际没人读」；
//   2. 大档开关关闭时必须真正关闭大档通道。判断入口统一在 liveConfig：
//      下游有五处按 `bigProvider 非空` 决定要不要换大上下文模型，逐个判断迟早漏一处，
//      所以在配置转内部值时一次性清空，下游保持原样即可。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `cw-cfg-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`)
const { Config, liveConfig } = await import('./index.js')

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.error(`  ✗ ${msg}`) } }

const defaults = Config({})

// ── 已退役设置 ──────────────────────────────────────────────────────────────
for (const key of ['planMode', 'symbolIncremental', 'agenticArticles', 'agenticMaxSteps']) {
  check(!(key in defaults), `旧设置 ${key} 已从 Config 移除`)
}
{
  const live = liveConfig(defaults)
  for (const key of ['planMode', 'symbolIncremental', 'agenticArticles', 'agenticMaxSteps']) {
    check(!(key in live), `liveConfig 不再透出 ${key}`)
  }
}

// ── 单模块请求上限（0.17.8）────────────────────────────────────────────────
// 上游 1b4af43 的 doc_guard 会给单个模块最多 2 次补写提醒，每次都是独立的
// agent.run(usage_limits=UsageLimits(request_limit=N))。原先硬编码 100，大模块
// 在真机上撞上限抛 DocumentationWriteError，整轮从 done 掉成 partial——语义对，
// 但预算明显不够。这里钉住默认值与夹取规则，别让它再悄悄回到偏小值。
check(liveConfig(defaults).requestLimit === 100, '单模块请求上限默认 100（0.17.12 回退到上游默认值，验证本地修改是否是 partial 根因）')
{
  check(liveConfig(Config({ requestLimit: 500 })).requestLimit === 500, '显式配置的请求上限原样透出')
  check(liveConfig(Config({ requestLimit: 1 })).requestLimit === 1, '下限 1 允许（等价于不写文章的极端预算）')
  check(liveConfig(Config({ requestLimit: 5000 })).requestLimit === 1000, '超过硬顶 1000 时夹到 1000')
  check(liveConfig(Config({ requestLimit: 0 })).requestLimit === 100, '0 / 非正值退回默认 100，不把 agent 循环卡死在 0')
}
// ── 大档开关 ────────────────────────────────────────────────────────────────
// schemastery 返回带 get() 的包装对象，取值一律走 liveConfig（运行期也是它）
check(liveConfig(defaults).bigEnabled === true, '大档默认开启（沿用既有行为，升级后不改变编译结果）')

{
  const live = liveConfig(Config({
    bigEnabled: false,
    bigProvider: 'volces-ark',
    bigModel: 'glm-5.3-flash',
    bigReasoningEffort: 'high',
    bigTokenBudget: 420000,
  }))
  check(live.bigEnabled === false, '关闭时 liveConfig.bigEnabled 为 false')
  check(live.bigProvider === '', `关闭时 bigProvider 被清空（实际 ${JSON.stringify(live.bigProvider)}）`)
  check(live.bigModel === 'glm-5.3-flash', '关闭时保留模型 id，重新开启不用重填')
  check(live.bigTokenBudget === 420000, '关闭时保留预算，重新开启不用重填')
}

{
  const live = liveConfig(Config({ bigEnabled: true, bigProvider: 'volces-ark', bigModel: 'glm-5.3-flash' }))
  check(live.bigEnabled === true && live.bigProvider === 'volces-ark', '开启时 provider 原样透出')
}

{
  // 未显式配置 bigEnabled（老 settings.json）时按开启处理，不改变既有编译行为
  const live = liveConfig({ bigProvider: 'volces-ark' })
  check(live.bigEnabled === true && live.bigProvider === 'volces-ark', '缺省 bigEnabled 视为开启')
}

// ── 大档关闭后下游确实不再选大档 ────────────────────────────────────────────
{
  const { markBigAgenticTasks } = await import('./lib/articles-agentic.js')
  const tasks = [{ name: 'huge.md', sources: ['a.js'] }, { name: 'small.md', sources: ['b.js'] }]
  const closed = liveConfig(Config({ bigEnabled: false, bigProvider: 'volces-ark', bigModel: 'glm-5.3-flash', bigTokenBudget: 10 }))
  const markedClosed = markBigAgenticTasks(tasks, {
    bigTier: {
      provider: closed.bigProvider,
      model: closed.bigModel,
      reasoningEffort: closed.bigReasoningEffort,
      budget: closed.bigTokenBudget,
    },
    sizeOf: () => 200000, // 高于普通预算 110k，确保「关闭」与否都会触发判据
  })
  check(markedClosed.every((t) => !t.bigTier), '大档关闭后没有任务被标记为大档')

  const opened = liveConfig(Config({ bigEnabled: true, bigProvider: 'volces-ark', bigModel: 'glm-5.3-flash', bigTokenBudget: 10 }))
  const markedOpen = markBigAgenticTasks(tasks, {
    bigTier: {
      provider: opened.bigProvider,
      model: opened.bigModel,
      reasoningEffort: opened.bigReasoningEffort,
      budget: opened.bigTokenBudget,
    },
    sizeOf: () => 200000, // 高于普通预算 110k，确保「关闭」与否都会触发判据
  })
  check(markedOpen.every((t) => t.bigTier && t.provider === 'volces-ark'), '大档开启后超预算任务仍走大档')
}

fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
console.log(failures ? `FAIL：${failures} 项失败` : 'PASS：设置项契约全部通过')
process.exit(failures ? 1 : 0)
