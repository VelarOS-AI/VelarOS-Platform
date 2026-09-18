// 域：JS/TS 语言层的唯一事实源。符号范围、mode:'body' 的 body 区间与语法诊断都出自同一棵
// TypeScript AST；核心 adapter、核心 patch 策略与 TypeScript 插件共用，保证「定位到的范围」
// 与「校验时认定的语法」同源——任何按正则或括号计数推断出的范围都可能静默改坏代码。
import * as ts from 'typescript'

import { isEmpty, isPresent, isUndefined } from '@velaros-ai/core'

import type { Diagnostic } from '../types/common.js'
import type { JsTsAccessor, JsTsRange, JsTsSymbol, JsTsSymbolKind, JsTsSymbolQuery, OverloadableDeclaration, ParsedJsTs } from '../types/jsts.js'

import { sha256 } from './hash.js'
import { ext } from './path.js'
import { ProjectTuning } from './tuning.js'

const JsTsExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'])

/** 不限定种类的 kind 取值：调用方与代码智能 target 用它们表达「任意符号」。 */
const WildcardKinds = new Set(['any', 'unknown', 'symbol'])

/** 查询里区分成对访问器的 kind 写法：访问器自身的 kind 仍是 method，get / set 记在 metadata.accessor。 */
const AccessorQueryKinds = new Map<string, JsTsAccessor>([
  ['getter', 'get'],
  ['setter', 'set'],
])

// 解析结果按 (path, 内容哈希) 内容寻址缓存：resolve→prepare→validate 常对同一文件反复解析。
// 内容寻址保证不会返回陈旧 AST；LRU 上限避免长会话常驻内存无界增长。结果只读消费。
const parseCache = new Map<string, ParsedJsTs>()

/** 按扩展名判断是不是 JS/TS 源文件。 */
export function isJsTsPath(path: string): boolean {
  return JsTsExtensions.has(ext(path))
}

/** 按扩展名选 TypeScript 的解析方式（TS、TSX、JS、JSX）。 */
function scriptKindForPath(path: string): ts.ScriptKind {
  switch (ext(path)) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

/** 解析 JS/TS 源码，得到 AST、可寻址的符号与纯语法诊断；按（路径、内容哈希）走 LRU 缓存。 */
export function parseJsTs(path: string, content: string): ParsedJsTs {
  const cacheKey = `${path}\u0000${sha256(content)}`
  const cached = parseCache.get(cacheKey)
  if (cached) {
    // LRU：命中后挪到队尾，最近使用的最后被淘汰。
    parseCache.delete(cacheKey)
    parseCache.set(cacheKey, cached)
    return cached
  }
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
  const parsed: ParsedJsTs = {
    sourceFile,
    symbols: collectSymbols(sourceFile),
    // parseDiagnostics 是 TypeScript 未公开声明的字段，但它正是不建 Program 时唯一的纯语法诊断来源。
    diagnostics: (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [],
  }
  parseCache.set(cacheKey, parsed)
  while (parseCache.size > ProjectTuning.jsTs.cachedParses) {
    const oldest = parseCache.keys().next().value
    if (isUndefined(oldest)) break
    parseCache.delete(oldest)
  }
  return parsed
}

/**
 * 按 name / kind / container 选符号。kind 缺省或为 any / unknown / symbol 时不限种类；getter / setter
 * 只命中对应的访问器，用来拆开同名同容器的 get / set 对。kind 为 function 却没有同名函数时兼容命中
 * 同名方法——调用方常把方法也叫作 function，但只要存在真正的同名函数就不掺入方法，避免凭空制造歧义。
 */
export function selectJsTsSymbols(symbols: readonly JsTsSymbol[], query: JsTsSymbolQuery): JsTsSymbol[] {
  const named = symbols.filter(
    (symbol) =>
      (!query.name || symbol.name === query.name) && (!query.container || symbol.container === query.container)
  )
  if (!query.kind || WildcardKinds.has(query.kind)) return named
  const accessor = AccessorQueryKinds.get(query.kind)
  const exact = named.filter((symbol) =>
    isPresent(accessor) ? symbol.metadata.accessor === accessor : symbol.kind === query.kind
  )
  if (!isEmpty(exact) || query.kind !== 'function') return exact
  return named.filter((symbol) => symbol.kind === 'method')
}

/** 解析源码后按 name / kind / container 选符号。 */
export function findJsTsSymbols(content: string, path: string, query: JsTsSymbolQuery = {}): JsTsSymbol[] {
  return selectJsTsSymbols(parseJsTs(path, content).symbols, query)
}

/** 语法诊断：每条都带 1 起的行列、TS 诊断码与出错行摘录，调用方不必再回读文件才能定位。 */
export function jsTsSyntaxDiagnostics(path: string, content: string, source: string): Diagnostic[] {
  const { sourceFile, diagnostics } = parseJsTs(path, content)
  return diagnostics.map((diagnostic, index) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    return {
      severity: 'error' as const,
      message: `JS/TS 语法错误（${path}:${line + 1}:${character + 1}，TS${diagnostic.code}）：${text}`,
      path,
      line: line + 1,
      column: character + 1,
      source,
      data: {
        code: diagnostic.code,
        excerpt: lineExcerpt(sourceFile, line, character),
        sourceContext: index < ProjectTuning.jsTs.syntaxPreviewDiagnostics ? syntaxSourceContext(sourceFile, line, character) : undefined,
      },
    }
  })
}

/** 从实际解析内容提取有界预览；行号标签不混入可编辑正文。 */
function syntaxSourceContext(sourceFile: ts.SourceFile, line: number, character: number) {
  const lines: Array<[number, string]> = []
  const lastLine = Math.min(sourceFile.getLineStarts().length - 1, line + 2)
  for (let current = Math.max(0, line - 2); current <= lastLine; current++)
    lines.push([current + 1, lineExcerpt(sourceFile, current, current === line ? character : 0)])
  return { lines, preview: true }
}

/** 取出一行源码的摘录；超长行只截取出错列附近的窗口，两端用省略号标出被截断。 */
function lineExcerpt(sourceFile: ts.SourceFile, line: number, character: number): string {
  const limit = ProjectTuning.jsTs.syntaxExcerptChars
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
  const text = sourceFile.text.slice(lineStart, sourceFile.getLineEndOfPosition(lineStart)).trimEnd()
  if (text.length <= limit) return text
  // 超长行（压缩代码、长字符串）以错误列为中心截窗，两端用省略号标出被截断。
  let from = Math.max(0, Math.min(character - limit / 2, text.length - limit))
  let to = from + limit
  if (from > 0 && /[\uDC00-\uDFFF]/u.test(text[from])) from -= 1
  if (to < text.length && /[\uDC00-\uDFFF]/u.test(text[to])) to -= 1
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/**
 * 收集可寻址的声明：顶层与 namespace 内的全部声明、类成员、以及任意深度的函数类声明
 * （函数体里的局部 helper 也能被 replace_symbol 命中）。函数体内的普通局部变量不收，
 * 它们不是编辑目标，只会给同名选择制造歧义。container 取最近的具名外层声明。
 */
function collectSymbols(sourceFile: ts.SourceFile): JsTsSymbol[] {
  const symbols: JsTsSymbol[] = []

  function push(
    kind: JsTsSymbolKind,
    name: string,
    node: ts.Node,
    container: Optional<string>,
    options: {
      start?: number
      exported?: boolean
      bodyRange?: JsTsRange
      statementRange?: JsTsRange
      accessor?: JsTsAccessor
    } = {}
  ): string {
    const start = options.start ?? node.getStart(sourceFile)
    const end = node.getEnd()
    const exported = !!options.exported
    symbols.push({
      kind,
      name,
      container,
      exported,
      range: rangeOf(sourceFile, start, end),
      bodyRange: options.bodyRange,
      statementRange: options.statementRange,
      signatureHash: sha256(sourceFile.text.slice(start, Math.min(end, start + 500))),
      metadata: isPresent(options.accessor) ? { exported, accessor: options.accessor } : { exported },
    })
    return name
  }

  function declare(node: ts.Node, container: Optional<string>): Optional<string> {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? defaultExportName(node)
      if (!name || isOverloadSignature(node)) return undefined
      return push('function', name, node, container, {
        start: overloadGroupStart(node, sourceFile),
        exported: hasExportModifier(node),
        bodyRange: functionBodyRange(sourceFile, node.body),
      })
    }
    // 类、interface、enum 的 body 是自身那对花括号之间；type 只有整个类型就是 `{ … }` 时才有 body，
    // 联合、交叉等类型没有唯一的一对括号可言。
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? defaultExportName(node)
      if (!name) return undefined
      return push('class', name, node, container, {
        exported: hasExportModifier(node),
        bodyRange: bracedContentRange(sourceFile, node),
      })
    }
    if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node))
      return push(ts.isInterfaceDeclaration(node) ? 'interface' : 'enum', node.name.text, node, container, {
        exported: hasExportModifier(node),
        bodyRange: bracedContentRange(sourceFile, node),
      })
    if (ts.isTypeAliasDeclaration(node))
      return push('type', node.name.text, node, container, {
        exported: hasExportModifier(node),
        bodyRange: ts.isTypeLiteralNode(node.type) ? bracedContentRange(sourceFile, node.type) : undefined,
      })
    if (ts.isModuleDeclaration(node)) {
      const body = namespaceBlock(node)
      return push('namespace', node.name.text, node, container, {
        exported: hasExportModifier(node),
        bodyRange: body ? bracedContentRange(sourceFile, body) : undefined,
      })
    }
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      push('import', ts.isStringLiteral(specifier) ? specifier.text : specifier.getText(sourceFile), node, container)
      return undefined
    }
    if (ts.isVariableDeclaration(node)) return declareVariable(node, container)
    if (ts.isClassLike(node.parent)) return declareClassMember(node, container)
    return undefined
  }

  function declareVariable(node: ts.VariableDeclaration, container: Optional<string>): Optional<string> {
    const list = node.parent
    const statement = list.parent
    // catch 参数、for 循环变量等不在 VariableStatement 里的声明不是可编辑的独立符号。
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement) || !ts.isIdentifier(node.name)) return undefined
    const initializer = node.initializer
    const callable = isPresent(initializer) && isFunctionExpressionLike(initializer)
    const classExpression = isPresent(initializer) && ts.isClassExpression(initializer)
    const kind: JsTsSymbolKind = callable ? 'function' : classExpression ? 'class' : 'variable'
    if (kind === 'variable' && !isDeclarationScope(statement.parent)) return undefined
    // 单声明取整条语句（含 export/const/分号）；`const a = …, b = …` 各取自身声明，
    // 改其中一个绑定不会连带替换同一语句里的兄弟绑定。
    const multiple = list.declarations.length > 1
    return push(kind, node.name.text, multiple ? node : statement, container, {
      exported: hasExportModifier(statement),
      statementRange: multiple ? rangeOf(sourceFile, statement.getStart(sourceFile), statement.getEnd()) : undefined,
      bodyRange: callable
        ? functionBodyRange(sourceFile, initializer.body)
        : classExpression
          ? bracedContentRange(sourceFile, initializer)
          : undefined,
    })
  }

  function declareClassMember(node: ts.Node, className: Optional<string>): Optional<string> {
    if (ts.isConstructorDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : memberName(node.name, sourceFile)
      if (!name || isOverloadSignature(node)) return undefined
      return push('method', name, node, className, {
        start: overloadGroupStart(node, sourceFile),
        bodyRange: functionBodyRange(sourceFile, node.body),
      })
    }
    // 访问器是 method；成对的 get / set 同名同容器，靠 metadata.accessor（查询写 getter / setter）区分。
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const name = memberName(node.name, sourceFile)
      if (!name) return undefined
      return push('method', name, node, className, {
        bodyRange: functionBodyRange(sourceFile, node.body),
        accessor: ts.isGetAccessorDeclaration(node) ? 'get' : 'set',
      })
    }
    // 箭头函数 / 函数表达式属性（`handle = async () => {}`）按方法对待：它们就是类的行为成员。
    if (ts.isPropertyDeclaration(node) && isPresent(node.initializer) && isFunctionExpressionLike(node.initializer)) {
      const name = memberName(node.name, sourceFile)
      return name
        ? push('method', name, node, className, { bodyRange: functionBodyRange(sourceFile, node.initializer.body) })
        : undefined
    }
    return undefined
  }

  function visit(node: ts.Node, container: Optional<string>): void {
    const declared = declare(node, container)
    ts.forEachChild(node, (child) => visit(child, declared ?? container))
  }

  ts.forEachChild(sourceFile, (child) => visit(child, undefined))
  return symbols.sort((a, b) => a.range.startOffset - b.range.startOffset)
}

/** 无 body 且紧跟同名同类声明的是重载签名：它并入实现所在的符号，不单独成符号。 */
function isOverloadSignature(node: OverloadableDeclaration): boolean {
  if (isPresent(node.body)) return false
  const siblings = siblingDeclarations(node)
  const next = siblings[siblings.indexOf(node) + 1]
  return isPresent(next) && isSameOverload(next, node)
}

/** 重载组的起点：向前吞并紧邻的同名无 body 签名，replace_symbol whole 连同签名一起替换。 */
function overloadGroupStart(node: OverloadableDeclaration, sourceFile: ts.SourceFile): number {
  const siblings = siblingDeclarations(node)
  let index = siblings.indexOf(node)
  while (index > 0) {
    const previous = siblings[index - 1]
    if (!isSameOverload(previous, node) || isPresent(previous.body)) break
    index -= 1
  }
  return siblings[index].getStart(sourceFile)
}

/** 兄弟声明是不是同一重载组的：种类相同、名字相同。 */
function isSameOverload(candidate: ts.Node, node: OverloadableDeclaration): candidate is OverloadableDeclaration {
  return candidate.kind === node.kind && overloadName(candidate as OverloadableDeclaration) === overloadName(node)
}

/** 重载组用来比对的名字；构造函数一律叫 constructor。 */
function overloadName(node: OverloadableDeclaration): Optional<string> {
  return ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText()
}

/** 和声明同处一层的兄弟节点：类成员、文件或块里的语句。 */
function siblingDeclarations(node: ts.Node): readonly ts.Node[] {
  const parent = node.parent
  if (ts.isClassLike(parent)) return parent.members
  if (ts.isSourceFile(parent) || ts.isModuleBlock(parent) || ts.isBlock(parent)) return parent.statements
  return [node]
}

/** 节点是不是会收普通变量的作用域：文件顶层或 namespace 块。 */
function isDeclarationScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isModuleBlock(node)
}

/** 表达式是不是箭头函数或 function 表达式。 */
function isFunctionExpressionLike(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

/** 匿名的 export default 函数或类记作 default。 */
function defaultExportName(node: ts.FunctionDeclaration | ts.ClassDeclaration): Optional<string> {
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ? 'default'
    : undefined
}

/** 类成员的名字：标识符、私有名、字符串与数字字面量取文本，计算属性名取表达式原文。 */
function memberName(name: ts.PropertyName, sourceFile: ts.SourceFile): Optional<string> {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text
  if (ts.isComputedPropertyName(name)) return name.expression.getText(sourceFile)
  return undefined
}

/** 声明带不带 export 修饰。 */
function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

/** 函数 body：块体取花括号之间，表达式体（箭头函数）取表达式本身；重载签名与抽象方法没有 body。 */
function functionBodyRange(sourceFile: ts.SourceFile, body: Optional<ts.ConciseBody>): Optional<JsTsRange> {
  if (!body) return undefined
  return ts.isBlock(body) ? bracedContentRange(sourceFile, body) : rangeOf(sourceFile, body.getStart(sourceFile), body.getEnd())
}

/**
 * 花括号界定的体取两括号之间的全部文本。括号取自节点自己的直接子 token，签名里的对象类型、heritage 的
 * 类型实参都在更深的子树里，不会被误认；缺右括号的残缺声明没有 body。
 */
function bracedContentRange(sourceFile: ts.SourceFile, node: ts.Node): Optional<JsTsRange> {
  const children = node.getChildren(sourceFile)
  const open = children.find((child) => child.kind === ts.SyntaxKind.OpenBraceToken)
  const close = children.at(-1)
  if (!open || close?.kind !== ts.SyntaxKind.CloseBraceToken) return undefined
  return rangeOf(sourceFile, open.getEnd(), close.getStart(sourceFile))
}

/** `namespace A.B { … }` 的外层声明与内层共用同一个块；`declare module 'x';` 这类无块声明没有 body。 */
function namespaceBlock(node: ts.ModuleDeclaration): Optional<ts.ModuleBlock> {
  let body = node.body
  while (isPresent(body) && ts.isModuleDeclaration(body)) body = body.body
  return isPresent(body) && ts.isModuleBlock(body) ? body : undefined
}

/** 由 AST 偏移算出行列（都从 1 起）与偏移齐全的范围。 */
function rangeOf(sourceFile: ts.SourceFile, start: number, end: number): JsTsRange {
  const from = sourceFile.getLineAndCharacterOfPosition(start)
  const to = sourceFile.getLineAndCharacterOfPosition(end)
  return {
    startLine: from.line + 1,
    endLine: to.line + 1,
    startColumn: from.character + 1,
    endColumn: to.character + 1,
    startOffset: start,
    endOffset: end,
  }
}
