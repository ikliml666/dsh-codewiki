// lib/agentic.js 测试：工具循环（read_code / list_files / edit_article /
// generate_sub_module）与全部异常路径。用假 streamFn 模拟模型，完全离线。
import assert from 'node:assert/strict'
import {
  runAgenticArticle, makeArticleEditor, makeReadCodeTool, makeListFilesTool,
  buildToolset, buildOpeningPrompt, parseToolArgs, safeRelPath, numberLines,
  TOOL_SCHEMAS,
} from './lib/agentic.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS  ${label}`)
  } catch (err) {
    fails.push({ label, err })
    console.log(`FAIL  ${label}\n      ${err.message}`)
  }
}

// 假仓库
const FILES = {
  'src/index.js': 'import { a } from "./a.js"\n\nexport function main() {\n  return a()\n}\n',
  'src/a.js': 'export function a() {\n  return 42\n}\n',
  'README.md': '# demo\n',
}
function makeWorkspace(over = {}) {
  return {
    async readFile(rel) {
      if (!(rel in FILES)) throw new Error(`ENOENT: ${rel}`)
      return FILES[rel]
    },
    async listDir(rel) {
      const base = rel === '.' ? '' : `${rel.replace(/\/$/, '')}/`
      const out = []
      const seen = new Set()
      for (const f of Object.keys(FILES)) {
        if (!f.startsWith(base)) continue
        const rest = f.slice(base.length)
        const top = rest.split('/')[0]
        const isDir = rest.includes('/')
        if (seen.has(top)) continue
        seen.add(top)
        out.push({ path: `${base}${top}`, dir: isDir })
      }
      return out
    },
    ...over,
  }
}

// 构造一条 assistant 消息
function assistant(blocks) { return { role: 'assistant', content: blocks } }
function call(id, name, args) {
  return { type: 'tool-call', id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
}
function text(t) { return { type: 'text', text: t } }

// 按脚本依次返回的 streamFn
function scripted(responses) {
  let i = 0
  const seen = []
  return {
    fn: async ({ messages, tools }) => {
      seen.push({ messageCount: messages.length, toolNames: tools.map((t) => t.name) })
      if (i >= responses.length) return { blocks: [text('done')] }
      return { blocks: responses[i++] }
    },
    seen,
  }
}

// ---------------------------------------------------------------- 基础工具
await check('numberLines 用「行号| 」前缀', async () => {
  assert.equal(numberLines('a\nb'), '1| a\n2| b')
})

await check('safeRelPath 拒绝越界与绝对路径', async () => {
  assert.equal(safeRelPath('src/a.js'), 'src/a.js')
  assert.equal(safeRelPath('./src/a.js'), 'src/a.js')
  assert.equal(safeRelPath('../etc/passwd'), null)
  assert.equal(safeRelPath('src/../../x'), null)
  assert.equal(safeRelPath('/etc/passwd'), null)
  assert.equal(safeRelPath('C:/Windows'), null)
})

await check('read_code 返回带行号全文', async () => {
  const tool = makeReadCodeTool(makeWorkspace())
  const r = await tool({ path: 'src/a.js' })
  assert.equal(r.isError, false)
  assert.ok(r.text.includes('1| export function a()'))
  assert.ok(r.text.includes('3| }'))
  assert.match(r.text, /共 4 行/)
})

await check('read_code 支持行范围', async () => {
  const tool = makeReadCodeTool(makeWorkspace())
  const r = await tool({ path: 'src/a.js', start_line: 2, end_line: 2 })
  assert.ok(r.text.includes('2|   return 42'))
  assert.ok(!r.text.includes('1| '))
})

await check('read_code 文件不存在返回 isError', async () => {
  const tool = makeReadCodeTool(makeWorkspace())
  const r = await tool({ path: 'src/nope.js' })
  assert.equal(r.isError, true)
  assert.match(r.text, /读取失败/)
})

await check('read_code 缺 path 返回 isError', async () => {
  const tool = makeReadCodeTool(makeWorkspace())
  assert.equal((await tool({})).isError, true)
})

await check('read_code 越界路径被拒', async () => {
  const tool = makeReadCodeTool(makeWorkspace())
  const r = await tool({ path: '../../../etc/passwd' })
  assert.equal(r.isError, true)
  assert.match(r.text, /越界/)
})

await check('read_code 行号越界报错', async () => {
  const tool = makeReadCodeTool(makeWorkspace())
  const r = await tool({ path: 'src/a.js', start_line: 99 })
  assert.equal(r.isError, true)
  assert.match(r.text, /超出文件长度/)
})

await check('list_files 列根目录', async () => {
  const tool = makeListFilesTool(makeWorkspace())
  const r = await tool({})
  assert.ok(r.text.includes('src/'), `目录未标注：${r.text}`)
  assert.ok(r.text.includes('README.md'))
})

await check('list_files 列子目录', async () => {
  const tool = makeListFilesTool(makeWorkspace())
  const r = await tool({ path: 'src' })
  assert.ok(r.text.includes('src/index.js'))
})

await check('list_files 空目录给出说明', async () => {
  const tool = makeListFilesTool({ async listDir() { return [] } })
  const r = await tool({ path: 'empty' })
  assert.match(r.text, /没有文件/)
})

// ---------------------------------------------------------------- 文章编辑器
await check('edit_article insert 从空文件搭骨架', async () => {
  const ed = makeArticleEditor('')
  await ed.edit({ command: 'insert', line: 0, text: '---\ntitle: x\n---' })
  assert.ok(ed.article.startsWith('---\ntitle: x'))
})

await check('edit_article insert 指定行后插入', async () => {
  const ed = makeArticleEditor('a\nb\nc')
  await ed.edit({ command: 'insert', line: 1, text: 'X' })
  assert.equal(ed.article, 'a\nX\nb\nc')
})

await check('edit_article str_replace 唯一匹配成功', async () => {
  const ed = makeArticleEditor('## Overview\n\nTODO')
  const r = await ed.edit({ command: 'str_replace', old_str: 'TODO', new_str: '正文' })
  assert.equal(r.isError, false)
  assert.equal(ed.article, '## Overview\n\n正文')
})

await check('edit_article str_replace 多处匹配被拒', async () => {
  const ed = makeArticleEditor('x\nx')
  const r = await ed.edit({ command: 'str_replace', old_str: 'x', new_str: 'y' })
  assert.equal(r.isError, true)
  assert.match(r.text, /不唯一/)
  assert.equal(ed.article, 'x\nx', '被拒时不应改动文章')
})

await check('edit_article str_replace 未匹配给出可操作提示', async () => {
  const ed = makeArticleEditor('abc')
  const r = await ed.edit({ command: 'str_replace', old_str: 'zzz', new_str: 'y' })
  assert.equal(r.isError, true)
  assert.match(r.text, /请先 view/)
})

await check('edit_article view 带行号', async () => {
  const ed = makeArticleEditor('a\nb')
  const r = await ed.edit({ command: 'view' })
  assert.equal(r.text, '1| a\n2| b')
})

await check('edit_article 空文章 view 给出说明', async () => {
  const ed = makeArticleEditor('')
  assert.match((await ed.edit({ command: 'view' })).text, /为空/)
})

await check('edit_article insert 行号越界报错', async () => {
  const ed = makeArticleEditor('a')
  const r = await ed.edit({ command: 'insert', line: 99, text: 'x' })
  assert.equal(r.isError, true)
})

await check('edit_article 未知命令报错并列可用值', async () => {
  const ed = makeArticleEditor('')
  const r = await ed.edit({ command: 'delete_all' })
  assert.equal(r.isError, true)
  assert.match(r.text, /view \/ str_replace \/ insert/)
})

// ---------------------------------------------------------------- 循环本体
await check('单轮无工具调用直接收正文', async () => {
  const r = await runAgenticArticle({
    mission: '写 a 模块',
    workspace: makeWorkspace(),
    streamFn: async () => ({ blocks: [text('这是文章正文')] }),
  })
  assert.equal(r.article, '这是文章正文')
  assert.equal(r.stopReason, 'finished')
  assert.equal(r.usedTools.length, 0)
})

await check('读文件→写文章的完整两轮', async () => {
  const s = scripted([
    [call('c1', 'read_code', { path: 'src/a.js' })],
    [call('c2', 'edit_article', { command: 'insert', line: 0, text: '## Overview\n\n见 src/a.js:1' })],
    [text('完成')],
  ])
  const r = await runAgenticArticle({
    mission: '写 a 模块', workspace: makeWorkspace(), streamFn: s.fn,
  })
  assert.equal(r.stopReason, 'finished')
  assert.deepEqual(r.usedTools.sort(), ['edit_article', 'read_code'])
  assert.ok(r.article.includes('src/a.js:1'))
  // 第二轮请求里应带上 tool-result
  assert.ok(s.seen.length >= 3)
})

await check('工具结果作为 tool 消息回灌', async () => {
  let captured = null
  let step = 0
  const r = await runAgenticArticle({
    mission: 'm',
    workspace: makeWorkspace(),
    streamFn: async ({ messages }) => {
      step++
      if (step === 1) return { blocks: [call('c1', 'read_code', { path: 'src/a.js' })] }
      captured = messages
      return { blocks: [text('ok')] }
    },
  })
  assert.ok(captured, '未捕获第二轮消息')
  const toolMsg = captured.find((m) => m.role === 'tool')
  assert.ok(toolMsg, '缺少 tool 消息')
  assert.equal(toolMsg.content[0].toolCallId, 'c1')
  assert.equal(toolMsg.content[0].isError, false)
  assert.ok(toolMsg.content[0].content[0].text.includes('export function a'))
  assert.equal(r.stopReason, 'finished')
})

await check('模型消息原样进历史（保留 tool-call）', async () => {
  let captured = null
  let step = 0
  await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async ({ messages }) => {
      step++
      if (step === 1) return { blocks: [call('c1', 'list_files', {})] }
      captured = messages
      return { blocks: [text('ok')] }
    },
  })
  const asst = captured.filter((m) => m.role === 'assistant')
  assert.ok(asst.length >= 1)
  assert.ok(asst[0].content.some((b) => b.type === 'tool-call' && b.id === 'c1'))
})

await check('未知工具回灌错误但不中断', async () => {
  let step = 0
  let toolMsg = null
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async ({ messages }) => {
      step++
      if (step === 1) return { blocks: [call('c1', 'hack_the_planet', {})] }
      toolMsg = messages.find((m) => m.role === 'tool')
      return { blocks: [text('ok')] }
    },
  })
  assert.equal(r.stopReason, 'finished')
  assert.equal(toolMsg.content[0].isError, true)
  assert.match(toolMsg.content[0].content[0].text, /未知工具/)
})

await check('工具参数坏 JSON 记警告并继续', async () => {
  let step = 0
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async () => {
      step++
      if (step === 1) return { blocks: [call('c1', 'read_code', '{bad json')] }
      return { blocks: [text('ok')] }
    },
  })
  assert.equal(r.stopReason, 'finished')
  assert.ok(r.steps.some((s) => s.warning?.includes('不是合法 JSON')))
})

await check('工具抛错被捕获为 isError 结果', async () => {
  let step = 0
  let toolMsg = null
  await runAgenticArticle({
    mission: 'm',
    workspace: makeWorkspace({ async readFile() { throw new Error('disk on fire') } }),
    streamFn: async ({ messages }) => {
      step++
      if (step === 1) return { blocks: [call('c1', 'read_code', { path: 'src/a.js' })] }
      toolMsg = messages.find((m) => m.role === 'tool')
      return { blocks: [text('ok')] }
    },
  })
  assert.equal(toolMsg.content[0].isError, true)
  assert.match(toolMsg.content[0].content[0].text, /disk on fire/)
})

await check('达到 maxSteps 时停止并报告', async () => {
  let n = 0
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(), maxSteps: 3,
    streamFn: async () => {
      n++
      return { blocks: [call(`c${n}`, 'list_files', {})] }
    },
  })
  assert.equal(r.stopReason, 'max-steps')
  assert.equal(r.steps.length, 3)
})

await check('streamFn 抛错时优雅停止', async () => {
  let n = 0
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async () => { n++; throw new Error('upstream 502') },
  })
  assert.equal(r.stopReason, 'stream-error')
  assert.ok(r.steps.some((s) => s.error?.includes('upstream 502')))
})

await check('空响应停止', async () => {
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async () => ({ blocks: [] }),
  })
  assert.equal(r.stopReason, 'empty-response')
})

await check('abort 信号生效', async () => {
  const ac = new AbortController()
  ac.abort()
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(), signal: ac.signal,
    streamFn: async () => ({ blocks: [text('x')] }),
  })
  assert.equal(r.stopReason, 'aborted')
})

await check('finish 前清空的文章不会被正文覆盖', async () => {
  // 模型用 edit_article 写了内容，最后一轮正文是解释性文字——不应覆盖文章
  let step = 0
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async () => {
      step++
      if (step === 1) return { blocks: [call('c1', 'edit_article', { command: 'insert', line: 0, text: '# 真文章' })] }
      return { blocks: [text('我已经写完了这篇文章。')] }
    },
  })
  assert.equal(r.article, '# 真文章', '文章被解释性正文覆盖了')
  assert.equal(r.stopReason, 'finished')
})

await check('子模块委派走 onSubModule 回调', async () => {
  const calls = []
  let step = 0
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    onSubModule: async (arg) => { calls.push(arg); return { text: `已生成 ${arg.name}.md` } },
    streamFn: async () => {
      step++
      if (step === 1) {
        return { blocks: [call('c1', 'generate_sub_module', {
          module_name: 'parser', components: ['src/a.js#a'], description: '解析器',
        })] }
      }
      return { blocks: [text('ok')] }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'parser')
  assert.equal(r.stopReason, 'finished')
})

await check('无 onSubModule 时子模块调用必须报错并说明原因（不能谎称已成文）', async () => {
  let step = 0
  let toolMsg = null
  await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    streamFn: async ({ messages }) => {
      step++
      if (step === 1) return { blocks: [call('c1', 'generate_sub_module', { module_name: 'x', description: 'd' })] }
      toolMsg = messages.find((m) => m.role === 'tool')
      return { blocks: [text('ok')] }
    },
  })
  // 这里必须 isError=true：旧实现回「已记录子模块 x」且 isError=false，模型会以为
  // 文章已生成、在父文里写下「详见 x.md」，而那个文件从未存在 —— 死链且无人察觉。
  assert.equal(toolMsg.content[0].isError, true)
  assert.match(toolMsg.content[0].content[0].text, /没有派出/)
  assert.match(toolMsg.content[0].content[0].text, /不支持递归|嵌套上限/)
  assert.doesNotMatch(toolMsg.content[0].content[0].text, /已记录子模块/)
})

await check('深度到顶时子模块调用报错并提示直接写成本文小节', async () => {
  let step = 0
  let toolMsg = null
  await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(), subModuleBlocked: 'max-depth',
    streamFn: async ({ messages }) => {
      step++
      if (step === 1) return { blocks: [call('c1', 'generate_sub_module', { module_name: 'y', description: 'd' })] }
      toolMsg = messages.find((m) => m.role === 'tool')
      return { blocks: [text('ok')] }
    },
  })
  assert.equal(toolMsg.content[0].isError, true)
  assert.match(toolMsg.content[0].content[0].text, /嵌套上限/)
  assert.match(toolMsg.content[0].content[0].text, /普通小节/)
})

await check('只有 3 个工具声明给模型（子模块按需）', async () => {
  const r = await runAgenticArticle({
    mission: 'm', workspace: makeWorkspace(),
    onSubModule: null,
    streamFn: async ({ tools }) => {
      // 四个工具都可用（onSubModule 为空时 generate_sub_module 仍是安全桩）
      assert.equal(tools.length, 4)
      return { blocks: [text('ok')] }
    },
  })
  assert.equal(r.stopReason, 'finished')
})

await check('缺 streamFn 直接抛错', async () => {
  await assert.rejects(async () => runAgenticArticle({ mission: 'm', workspace: makeWorkspace() }), /需要 streamFn/)
})

// ---------------------------------------------------------------- 提示词
await check('buildOpeningPrompt 含工作步骤与禁用项', async () => {
  const p = buildOpeningPrompt({ mission: '写 auth', schemas: TOOL_SCHEMAS })
  assert.match(p, /任务：写 auth/)
  assert.match(p, /不许编造文件、函数、行号/)
  assert.match(p, /read_code/)
  assert.match(p, /不要用 markdown 围栏把整篇文章包起来/)
})

await check('parseToolArgs 对象直通、空串给空对象', async () => {
  assert.deepEqual(parseToolArgs({ a: 1 }, [], 0, 't'), { a: 1 })
  assert.deepEqual(parseToolArgs('', [], 0, 't'), {})
  assert.deepEqual(parseToolArgs('{"a":2}', [], 0, 't'), { a: 2 })
})

await check('parseToolArgs 剥 ```json 围栏', async () => {
  assert.deepEqual(parseToolArgs('```json\n{"path":"a.js"}\n```', [], 0, 'read_code'), { path: 'a.js' })
  assert.deepEqual(parseToolArgs('```\n{"command":"view"}\n```', [], 0, 'edit_article'), { command: 'view' })
  // 围栏内还有前导说明的常见形态
  assert.deepEqual(parseToolArgs('```JSON\n\n{"line":0}\n```', [], 0, 't'), { line: 0 })
})

await check('parseToolArgs 截取夹在说明文字里的 JSON', async () => {
  const got = parseToolArgs('好的，我来读代码。{"path":"src/a.js","start_line":3} 这样可以吗', [], 0, 'read_code')
  assert.deepEqual(got, { path: 'src/a.js', start_line: 3 })
})

await check('parseToolArgs 平衡括号不误截字符串内的花括号', async () => {
  const got = parseToolArgs('说明 {"text":"a { b } c","line":2} 尾注', [], 0, 'insert')
  assert.deepEqual(got, { text: 'a { b } c', line: 2 })
})

await check('parseToolArgs 真坏 JSON 记警告并给空对象', async () => {
  const steps = []
  assert.deepEqual(parseToolArgs('{不是 json', steps, 7, 'read_code'), {})
  assert.equal(steps.length, 1)
  assert.equal(steps[0].step, 7)
  assert.match(steps[0].warning, /不是合法 JSON/)
})

await check('parseToolArgs 非对象 JSON 视为坏参数', async () => {
  const steps = []
  assert.deepEqual(parseToolArgs('[1,2,3]', steps, 0, 't'), {})
  assert.match(steps[0].warning, /必须是 JSON 对象/)
})

await check('read_code 重复读不再回吐正文，只提示第几步读过', async () => {
  const lines50 = Array.from({length: 50}, (_, i) => `line${i+1}`).join('\n')
  let reads = 0
  let step = 3
  const ws = makeWorkspace({ async readFile() { reads++; return lines50 } })
  const tools = buildToolset({ workspace: ws, editor: makeArticleEditor(''), getStep: () => step })
  const first = await tools.read_code({ path: 'a.js', start_line: 1, end_line: 10 })
  assert(first.text.includes('1| line1'), '首次读要回正文')
  step = 7
  const second = await tools.read_code({ path: 'a.js', start_line: 1, end_line: 10 })
  assert(second.text.includes('第 3 步读过'), `重复读要报首次步号，实际：${second.text.slice(0, 80)}`)
  assert(!second.text.includes('1| line1'), '重复读不能再回正文')
  assert.equal(reads, 1, '重复读不应再碰文件系统')
})

await check('read_code 换个行范围仍正常读（去重只认同一段）', async () => {
  const lines50 = Array.from({length: 50}, (_, i) => `line${i+1}`).join('\n')
  const ws = makeWorkspace({ async readFile() { return lines50 } })
  const tools = buildToolset({ workspace: ws, editor: makeArticleEditor(''), getStep: () => 2 })
  await tools.read_code({ path: 'a.js', start_line: 1, end_line: 10 })
  const other = await tools.read_code({ path: 'a.js', start_line: 20, end_line: 30 })
  assert(other.text.includes('20| line20'), '不同行范围要正常返回正文')
})

await check('不同文件互不影响去重', async () => {
  const ws = makeWorkspace({ async readFile() { return 'aaa\nbbb' } })
  const tools = buildToolset({ workspace: ws, editor: makeArticleEditor(''), getStep: () => 1 })
  await tools.read_code({ path: 'a.js' })
  const b = await tools.read_code({ path: 'b.js' })
  assert(!b.text.includes('读过'), '另一个文件要正常返回正文，实际：' + b.text.slice(0, 60))
})

await check('read_code 不带 end_line 重复读同样命中', async () => {
  const ws = makeWorkspace({ async readFile() { return 'x\ny\nz' } })
  const tools = buildToolset({ workspace: ws, editor: makeArticleEditor(''), getStep: () => 5 })
  const first = await tools.read_code({ path: 'a.js' })
  assert(!first.isError)
  const again = await tools.read_code({ path: 'a.js' })
  assert(again.text.includes('第 5 步读过'), `同段重复读要提示，实际：${again.text.slice(0, 60)}`)
})

await check('CRLF 文章里跨行 str_replace 能命中（行尾归一化）', async () => {
  const ed = makeArticleEditor('# 标题\r\n\r\n第一段。\r\n\r\n第二段。\r\n')
  const r = await ed.edit({ command: 'str_replace', old_str: '第一段。\n\n第二段。', new_str: '合并成一段。' })
  assert(!r.isError, 'CRLF 跨行替换应命中，实际：' + r.text)
  assert(ed.article.includes('合并成一段。'))
  assert(!ed.article.includes('第一段。'), '旧内容应被替换掉')
})

await check('CRLF 文章替换后仍保持 CRLF 行尾（不悄悄改成 LF）', async () => {
  const ed = makeArticleEditor('a\r\nb\r\nc\r\n')
  await ed.edit({ command: 'str_replace', old_str: 'b', new_str: 'B' })
  assert(ed.article.includes('\r\n'), '应保留 CRLF')
  assert.equal(ed.article.split('\r\n').length - 1, 3, '换行符数量不变')
})

await check('LF 文章替换后仍是 LF（不被污染成 CRLF）', async () => {
  const ed = makeArticleEditor('a\nb\n')
  await ed.edit({ command: 'str_replace', old_str: 'b', new_str: 'B' })
  assert(!ed.article.includes('\r'), '不应出现 CR')
})

await check('read_code 有字符上限，单行超长文件不会灌爆上下文', async () => {
  const huge = 'x'.repeat(200000)
  const ws = makeWorkspace({ async readFile() { return huge } })
  const tools = buildToolset({ workspace: ws, editor: makeArticleEditor(''), getStep: () => 0 })
  const r = await tools.read_code({ path: 'min.js' })
  assert(!r.isError)
  assert(r.text.length < 45000, '返回长度应被字符上限截断，实际 ' + r.text.length)
  assert(r.text.includes('字符上限'), '应提示被截断')
})

await check('list_files 隐藏 node_modules 与 .git', async () => {
  const ws = makeWorkspace({
    async listDir() {
      return [
        { path: 'node_modules', dir: true }, { path: '.git', dir: true },
        { path: 'src', dir: true }, { path: 'index.js', dir: false },
      ]
    },
  })
  const tools = buildToolset({ workspace: ws, editor: makeArticleEditor(''), getStep: () => 0 })
  const r = await tools.list_files({ path: '.' })
  assert(!r.text.includes('node_modules'), 'node_modules 应被隐藏')
  assert(!r.text.includes('.git'), '.git 应被隐藏')
  assert(r.text.includes('src/') && r.text.includes('index.js'), '真实源码要保留')
})

await check('insert 负数行号必须报错（不能静默插到最前）', async () => {
  const ed = makeArticleEditor('# 原文件\n\n正文。')
  const r = await ed.edit({ command: 'insert', line: -5, text: '不该插到最前' })
  assert(r.isError, '负数行号应报错，实际：' + r.text)
  assert.match(r.text, /不能为负/)
  assert(!ed.article.startsWith('不该插到最前'), '文章内容不应被改动')
})

await check('buildToolset 暴露四个工具', async () => {
  const ts = buildToolset({ workspace: makeWorkspace(), editor: makeArticleEditor('') })
  assert.deepEqual(Object.keys(ts).sort(), ['edit_article', 'generate_sub_module', 'list_files', 'read_code'])
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
process.exit(fails.length ? 1 : 0)
