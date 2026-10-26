// AST 级符号提取 —— 对应 FSoft-AI4Code/CodeWiki 的
// dependency_analyzer/analyzers/*（tree-sitter 逐语言提取函数/方法/类 + 调用关系）。
//
// 与上游的差异（有意为之）：
//   - 上游每个语言一个 800 行 Python 模块，逐语言硬编码；这里用一张表驱动，
//     把「符号节点类型 + 名称字段 + 参数字段 + 基类字段」声明化，加语言只加一行。
//   - 上游用原生 tree-sitter 绑定（需编译）；这里用 web-tree-sitter + WASM 语法，
//     装依赖仍是一条 npm install，不引入 Python/cargo。
//
// 组件 id 约定：`<相对路径>#<符号名>`；方法为 `#<类名>.<方法名>`。与上游
// `<相对路径>::<符号名>` 同构，只是分隔符不同（避免 Windows 盘符混淆）。
//
// 输出形状与 lib/graph-diff.js 的 Node 记录契约一致：
//   { id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// 依赖装在 vendor/tree-sitter 而非插件根 node_modules：
// 插件根的 node_modules 由宿主注入（@deepseek-ai/* 符号链接），在那里跑 npm install
// 会把宿主包标记 retire 并破坏运行环境。vendor 子树是独立 npm 根，互不干扰。
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_VENDOR_DIR = path.join(PKG_ROOT, 'vendor', 'tree-sitter')

// 各语言语法：扩展名 -> { wasm 名, 符号规则 }
// 规则字段：
//   container: 容器节点类型（类/结构体等，内部成员归属该类）
//   containerName / containerBases: 容器名称/基类字段名
//   containerKind: 容器记作什么 kind
//   fn: 函数节点类型数组        fnName / fnParams: 名称/参数字段
//   fnKind: 顶层函数 kind（容器内成员用 methodKind）
//   imports: import 节点类型数组（用于依赖边）
//   doc: 取 docstring 的方式
export const LANG_RULES = {
  javascript: {
    wasm: 'tree-sitter-javascript',
    exts: ['.js', '.mjs', '.cjs', '.jsx'],
    container: ['class_declaration', 'class'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_statement'],
    arrow: ['lexical_declaration', 'variable_declaration'],
  },
  typescript: {
    wasm: 'tree-sitter-typescript',
    exts: ['.ts', '.tsx', '.mts', '.cts'],
    container: ['class_declaration', 'abstract_class_declaration', 'interface_declaration'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_declaration', 'method_definition', 'method_signature', 'abstract_method_signature'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_statement'],
    arrow: ['lexical_declaration', 'variable_declaration'],
  },
  python: {
    wasm: 'tree-sitter-python',
    exts: ['.py'],
    container: ['class_definition'],
    containerName: 'name',
    containerBases: 'superclasses',
    containerKind: 'class',
    fn: ['function_definition'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_statement', 'import_from_statement'],
    doc: 'first_string_in_body',
  },
  rust: {
    wasm: 'tree-sitter-rust',
    exts: ['.rs'],
    container: ['impl_item', 'trait_item', 'struct_item', 'enum_item'],
    containerName: 'type',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_item'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['use_declaration'],
    doc: 'preceding_line_comment',
  },
  go: {
    wasm: 'tree-sitter-go',
    exts: ['.go'],
    // type_declaration 本身没有 name 字段，真正的具名节点是它下面的 type_spec
    container: ['type_spec'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_declaration', 'method_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_declaration'],
    // Go 的方法接收者在 receiver 字段里，方法名要拼成 <类型>.<方法>
    receiverField: 'receiver',
  },
  java: {
    wasm: 'tree-sitter-java',
    exts: ['.java'],
    container: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
    containerName: 'name',
    containerBases: 'superclass',
    containerKind: 'class',
    fn: ['method_declaration', 'constructor_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_declaration'],
  },
  c: {
    wasm: 'tree-sitter-c',
    exts: ['.c', '.h'],
    container: ['struct_specifier', 'union_specifier', 'enum_specifier'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_definition'],
    fnName: 'declarator',
    fnParams: 'parameters',
    // C/C++：函数名与参数挂在 function_declarator 里，不在 function_definition 直接字段上
    fnDeclarator: true,
    fnKind: 'function',
    methodKind: 'method',
    imports: ['preproc_include'],
  },
  cpp: {
    wasm: 'tree-sitter-cpp',
    exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    container: ['class_specifier', 'struct_specifier', 'namespace_definition'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_definition'],
    fnName: 'declarator',
    fnParams: 'parameters',
    fnDeclarator: true,
    fnKind: 'function',
    methodKind: 'method',
    imports: ['preproc_include', 'using_declaration'],
  },
  csharp: {
    wasm: 'tree-sitter-c_sharp',
    exts: ['.cs'],
    container: ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['method_declaration', 'constructor_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['using_directive'],
  },
  ruby: {
    wasm: 'tree-sitter-ruby',
    exts: ['.rb'],
    container: ['class', 'module'],
    containerName: 'name',
    containerBases: 'superclass',
    containerKind: 'class',
    fn: ['method', 'singleton_method'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: [],
  },
  php: {
    wasm: 'tree-sitter-php',
    exts: ['.php'],
    container: ['class_declaration', 'interface_declaration', 'trait_declaration'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_definition', 'method_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['namespace_use_declaration'],
  },
  kotlin: {
    wasm: 'tree-sitter-kotlin',
    exts: ['.kt', '.kts'],
    container: ['class_declaration', 'object_declaration', 'interface_declaration'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_header'],
  },
  scala: {
    wasm: 'tree-sitter-scala',
    exts: ['.scala'],
    container: ['class_definition', 'object_definition', 'trait_definition'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_definition'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['import_declaration'],
  },
  dart: {
    wasm: 'tree-sitter-dart',
    exts: ['.dart'],
    container: ['class_definition', 'mixin_declaration'],
    containerName: 'name',
    containerBases: null,
    containerKind: 'class',
    fn: ['function_signature', 'method_signature'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: ['library_import'],
  },
  bash: {
    wasm: 'tree-sitter-bash',
    exts: ['.sh', '.bash'],
    container: [],
    containerName: null,
    containerBases: null,
    containerKind: 'class',
    fn: ['function_definition'],
    fnName: 'name',
    fnParams: null,
    fnKind: 'function',
    methodKind: 'method',
    imports: [],
  },
  lua: {
    wasm: 'tree-sitter-lua',
    exts: ['.lua'],
    container: [],
    containerName: null,
    containerBases: null,
    containerKind: 'class',
    fn: ['function_declaration'],
    fnName: 'name',
    fnParams: 'parameters',
    fnKind: 'function',
    methodKind: 'method',
    imports: [],
  },
}

export const SUPPORTED_EXTS = new Map()
for (const [lang, rule] of Object.entries(LANG_RULES)) {
  for (const ext of rule.exts) if (!SUPPORTED_EXTS.has(ext)) SUPPORTED_EXTS.set(ext, lang)
}

// tree-sitter 的 wasm 文件名与语言 id 不完全一致，单独映射
const WASM_FILE_OVERRIDE = { csharp: 'tree-sitter-c_sharp' }

function wasmFileFor(lang) {
  return WASM_FILE_OVERRIDE[lang] ?? LANG_RULES[lang].wasm
}

// ---------------------------------------------------------------------------
// 解析器池：语法只加载一次（每次 init 都要 20-50ms，按文件加载会拖垮大仓库）
// ---------------------------------------------------------------------------

export class SymbolExtractor {
  constructor(opts = {}) {
    this.vendorDir = opts.vendorDir ?? DEFAULT_VENDOR_DIR
    this.wasmDir = opts.wasmDir ?? null
    this.parsers = new Map() // lang -> { parser, language }
    this.ParserCtor = null
    this.LanguageCtor = null
    this.initError = null
    this.stats = { files: 0, parsed: 0, failed: 0, languages: {} }
  }

  // 从 vendor 树里按绝对路径导入：插件根 node_modules 没有这些包，裸说明符解析不到
  vendorImport(sub) {
    const entry = path.join(this.vendorDir, 'node_modules', sub)
    if (!fs.existsSync(entry)) return null
    // 目录要落到 package.json 的 main/exports，用 createRequire 让 Node 自己解析
    try {
      const req = createRequire(path.join(this.vendorDir, 'package.json'))
      const resolved = req.resolve(sub)
      return import(pathToFileURL(resolved).href)
    } catch {
      return null
    }
  }

  // 惰性导入 web-tree-sitter：依赖没装时插件照常启动，只是没有 AST 能力
  async init() {
    if (this.ParserCtor) return true
    if (this.initError) return false
    try {
      const mod = await this.vendorImport('web-tree-sitter')
      if (!mod) {
        this.initError = `未找到 web-tree-sitter（期望 ${path.join(this.vendorDir, 'node_modules')}）`
        return false
      }
      this.ParserCtor = mod.Parser ?? mod.default?.Parser
      this.LanguageCtor = mod.Language ?? mod.default?.Language
      if (!this.ParserCtor || !this.LanguageCtor) {
        this.initError = 'web-tree-sitter 导出缺少 Parser/Language'
        return false
      }
      await this.ParserCtor.init()
      return true
    } catch (err) {
      this.initError = String(err?.message ?? err)
      return false
    }
  }

  async getParser(lang) {
    if (this.parsers.has(lang)) return this.parsers.get(lang)
    if (!(await this.init())) return null
    const rule = LANG_RULES[lang]
    if (!rule) return null
    const dir = this.wasmDir ?? await this.resolveWasmDir()
    if (!dir) return null
    const file = path.join(dir, `${wasmFileFor(lang)}.wasm`)
    if (!fs.existsSync(file)) return null
    try {
      const language = await this.LanguageCtor.load(file)
      const parser = new this.ParserCtor()
      parser.setLanguage(language)
      this.parsers.set(lang, parser)
      return parser
    } catch (err) {
      // 语法与运行时 ABI 不匹配时静默降级，不中断整个编译
      this.parsers.set(lang, null)
      this.initError = this.initError ?? `语法加载失败 ${file}: ${String(err?.message ?? err)}`
      return null
    }
  }

  async resolveWasmDir() {
    this.wasmDir = path.join(this.vendorDir, 'node_modules', 'tree-sitter-wasms', 'out')
    return fs.existsSync(this.wasmDir) ? this.wasmDir : null
  }

  // 解析单个文件 -> 符号记录数组
  async extractFile(relPath, content) {
    const ext = path.extname(relPath).toLowerCase()
    const lang = SUPPORTED_EXTS.get(ext)
    if (!lang) return []
    const parser = await this.getParser(lang)
    if (!parser) return []
    let tree
    try {
      tree = parser.parse(content)
    } catch {
      this.stats.failed += 1
      return []
    }
    this.stats.parsed += 1
    this.stats.languages[lang] = (this.stats.languages[lang] ?? 0) + 1
    const rule = LANG_RULES[lang]
    const out = []
    try {
      this.walk(tree.rootNode, rule, relPath, content, out, null)
    } catch {
      this.stats.failed += 1
    }
    return out
  }

  // 递归收集：容器（类）连同其成员方法一起成为组件；顶层函数单独成为组件
  walk(node, rule, relPath, content, out, container) {
    const typeOf = node.type
    const isContainer = rule.container.includes(typeOf)
    const isFn = rule.fn.includes(typeOf)

    if (isContainer) {
      const name = this.fieldText(node, rule.containerName) ?? `<anon@${node.startPosition.row + 1}>`
      const bases = rule.containerBases
        ? this.parseBases(this.fieldText(node, rule.containerBases), node, rule)
        : []
      const id = this.componentId(relPath, name, null)
      out.push({
        id,
        name,
        kind: rule.containerKind,
        relativePath: relPath,
        sourceCode: this.sliceSource(node, content),
        docstring: this.extractDoc(node, rule, content),
        parameters: [],
        baseClasses: bases,
        dependsOn: [],
      })
      // 容器内部继续走，成员方法归属这个类
      for (const child of node.namedChildren) {
        this.walk(child, rule, relPath, content, out, { name, id })
      }
      return
    }

    if (isFn) {
      // Rust 的 impl 块：fn 在 impl_item 内，但 impl 本身也是 container，已被上面接住
      let rawName = this.fieldText(node, rule.fnName)
      let paramsText = this.fieldText(node, rule.fnParams)
      // C/C++：名称与参数在 function_declarator 子节点上，向下取一层
      if (rule.fnDeclarator) {
        const decl = this.findDeclarator(node)
        if (decl) {
          const inner = this.fieldText(decl, 'declarator')
          rawName = inner ? this.stripCallSuffix(inner) : this.stripCallSuffix(decl.namedChildren?.[0]?.text ?? '')
          paramsText = this.fieldText(decl, 'parameters')
        }
      }
      // Go：方法名要带上接收者类型，脱离文件也能看出归属
      let recv = null
      if (rule.receiverField) {
        const r = this.fieldText(node, rule.receiverField)
        // `(s *Server)` -> 取最后一个词再剥掉指针星号 -> Server
        if (r) {
          const last = r.replace(/^\(/, '').replace(/\)$/, '').trim().split(/\s+/).pop() ?? ''
          recv = last.replace(/^[*&]+/, '').trim() || null
        }
      }
      const name = rawName ?? `<anon@${node.startPosition.row + 1}>`
      const owner = container ?? (recv ? { name: recv, id: null } : null)
      const isMethod = owner && rule.methodKind === 'method'
      const fullName = isMethod ? `${owner.name}.${name}` : name
      const id = this.componentId(relPath, fullName, null)
      out.push({
        id,
        name: fullName,
        kind: isMethod ? rule.methodKind : rule.fnKind,
        relativePath: relPath,
        sourceCode: this.sliceSource(node, content),
        docstring: this.extractDoc(node, rule, content),
        parameters: this.parseParams(paramsText),
        baseClasses: [],
        dependsOn: [],
      })
      return
    }

    // 箭头函数赋值：const foo = (a) => {...}
    if (rule.arrow && rule.arrow.includes(typeOf)) {
      for (const decl of node.namedChildren) {
        const fnNode = this.findArrow(decl)
        if (!fnNode) continue
        const nameNode = decl.namedChildren?.[0]
        const name = nameNode?.text
        if (!name) continue
        const id = this.componentId(relPath, name, null)
        out.push({
          id,
          name,
          kind: 'function',
          relativePath: relPath,
          sourceCode: this.sliceSource(fnNode, content),
          docstring: '',
          parameters: this.parseParams(this.fieldText(fnNode, 'parameters')),
          baseClasses: [],
          dependsOn: [],
        })
      }
      return
    }

    for (const child of node.namedChildren) {
      this.walk(child, rule, relPath, content, out, container)
    }
  }

  findArrow(decl) {
    // variable_declarator -> arrow_function / function
    const stack = [...(decl.namedChildren ?? [])]
    while (stack.length) {
      const n = stack.shift()
      if (!n) continue
      if (n.type === 'arrow_function' || n.type === 'function') return n
      stack.push(...(n.namedChildren ?? []))
    }
    return null
  }

  // C/C++：function_definition -> function_declarator（可能被 pointer_declarator 包一层）
  findDeclarator(node) {
    const stack = [...(node.namedChildren ?? [])]
    while (stack.length) {
      const n = stack.shift()
      if (!n) continue
      if (n.type === 'function_declarator') return n
      stack.push(...(n.namedChildren ?? []))
    }
    return null
  }

  // declarator 的文本可能是 `add(int a)` 或 `(*fn)(int a)`，只取函数名部分
  stripCallSuffix(text) {
    const t = String(text ?? '')
    const cut = t.indexOf('(')
    const head = cut >= 0 ? t.slice(0, cut) : t
    return head.replace(/^[*&\s]+/, '').replace(/^\s*\*\s*/, '').trim()
  }

  fieldText(node, field) {
    if (!field) return null
    try {
      const c = node.childForFieldName?.(field)
      return c ? c.text : null
    } catch {
      return null
    }
  }

  parseParams(text) {
    if (!text) return []
    const inner = String(text).replace(/^\s*[([]/, '').replace(/[)\]]\s*$/, '').trim()
    if (!inner) return []
    // 按顶层逗号切分（跳过嵌套括号/尖括号/泛型里的逗号）
    const parts = []
    let depth = 0
    let cur = ''
    for (const ch of inner) {
      if ('([{<'.includes(ch)) depth++
      else if (')]}>'.includes(ch)) depth--
      if (ch === ',' && depth === 0) {
        parts.push(cur)
        cur = ''
      } else cur += ch
    }
    if (cur.trim()) parts.push(cur)
    return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
      // 去掉默认值与类型标注，只留参数名
      const noDefault = p.split('=')[0].trim()
      const noType = noDefault.split(':')[0].trim()
      return noType.replace(/^\.{3}/, '').replace(/^\*+/, '').replace(/^\$/, '').trim()
    }).filter(Boolean)
  }

  parseBases(text, node, rule) {
    if (!text) return []
    const inner = String(text).replace(/^\s*[(:]/, '').replace(/[)]\s*$/, '').trim()
    if (!inner) return []
    return inner.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('(')[0].trim())
  }

  // 源码切片：按节点字节范围取原文（多字节安全）
  sliceSource(node, content) {
    try {
      return content.slice(node.startIndex, node.endIndex)
    } catch {
      return ''
    }
  }

  extractDoc(node, rule, content) {
    if (rule.doc === 'first_string_in_body') {
      const body = node.childForFieldName?.('body')
      const first = body?.namedChildren?.find((c) => c.type === 'expression_statement')
      const str = first?.namedChildren?.[0]
      if (str && /^['"]/.test(str.text)) return str.text.replace(/^['"]+|['"]+$/g, '').trim()
      return ''
    }
    if (rule.doc === 'preceding_line_comment') {
      // Rust：/// 在函数节点之前，不属于节点本身
      const prev = node.previousSibling
      if (prev && (prev.type === 'line_comment' || prev.type === 'block_comment')) return prev.text
      return ''
    }
    return ''
  }

  componentId(relPath, name, _cls) {
    return `${relPath}#${name}`
  }
}

// ---------------------------------------------------------------------------
// 批量提取：给定仓库文件清单，产出 { graph: Map<id, node>, byFile: Map }
// ---------------------------------------------------------------------------

export async function extractRepoGraph(files, opts = {}) {
  const extractor = opts.extractor ?? new SymbolExtractor(opts)
  const ready = await extractor.init()
  const graph = new Map()
  const byFile = new Map()
  const skipped = []

  for (const f of files) {
    const rel = typeof f === 'string' ? f : f.path
    const recs = await extractor.extractFile(rel, (typeof f === 'object' && f.content) || '')
    if (!recs.length) {
      skipped.push(rel)
      continue
    }
    byFile.set(rel, recs.map((r) => r.id))
    for (const r of recs) graph.set(r.id, r)
    extractor.stats.files += 1
  }

  return { graph, byFile, skipped, extractor, ready, stats: extractor.stats }
}

// 依赖边：把各文件的 import 语句解析成「本仓库内的相对路径」，再连到对应文件的组件。
// 上游把调用关系也建成边；这里先做文件级 import 边（够用于模块聚类与 edge 变更判定），
// 调用级边留待需要时扩充。
export function resolveImportEdges(graph, byFile, files) {
  const known = new Set(byFile.keys())
  const edges = []
  const seen = new Set()
  for (const [file, ids] of byFile) {
    const text = files.get?.(file)
    if (!text) continue
    for (const spec of extractImportSpecs(file, text)) {
      const target = resolveSpec(file, spec, known)
      if (!target) continue
      const key = `${file}->${target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: file, to: target, spec })
      // 把边落到组件层：from 文件所有组件的 dependsOn 追加 to 文件的组件 id
      const toIds = byFile.get(target) ?? []
      for (const id of ids) {
        const node = graph.get(id)
        if (node) node.dependsOn = [...new Set([...(node.dependsOn ?? []), ...toIds])]
      }
    }
  }
  return edges
}

const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^;\n]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|from\s+([.\w]+)\s+import|#include\s+["<]([^">]+)[">]|use\s+([\w:]+)|require\(\s*['"]([^'"]+)['"]\s*\)|(?:import|require)\b[^\n]*?['"]([^'"]+)['"])/g

export function extractImportSpecs(_file, text) {
  const specs = []
  const src = String(text ?? '')
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7]
    if (spec) specs.push(spec)
  }
  // const x = require('./d') 这种无扩展名写法也收
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return [...new Set(specs)]
}

export function resolveSpec(fromFile, spec, known) {
  if (!spec) return null
  const dir = path.posix.dirname(fromFile)
  // 相对路径
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(dir, spec))
    for (const cand of [
      base, `${base}.js`, `${base}.mjs`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`,
      `${base}.py`, `${base}.rs`, `${base}.go`, `${base}.java`,
      path.posix.join(base, 'index.js'), path.posix.join(base, 'index.ts'),
      path.posix.join(base, '__init__.py'), path.posix.join(base, 'mod.rs'),
    ]) {
      if (known.has(cand)) return cand
    }
    return null
  }
  // Python 点号模块：a.b.c -> a/b/c.py
  if (/^[A-Za-z_][\w.]*$/.test(spec)) {
    const asPath = spec.replace(/\./g, '/')
    for (const cand of [`${asPath}.py`, `${asPath}/__init__.py`, `${asPath}.js`, `${asPath}.ts`]) {
      if (known.has(cand)) return cand
    }
    // 只匹配后缀（包路径可能不完整）
    const tail = `/${asPath.split('/').pop()}`
    for (const k of known) if (k.endsWith(`${tail}.py`)) return k
    return null
  }
  // Rust use crate::a::b / C/C++ 头文件
  const tailName = spec.split(/::|\//).pop()
  if (!tailName) return null
  for (const k of known) {
    const base = path.posix.basename(k).replace(/\.[^.]+$/, '')
    if (base === tailName) return k
  }
  return null
}
