// 域：JS/TS import 增删的唯一实现。定位全部走 TypeScript AST——多行 import、别名、行内 type、
// 同行注释都不会让它失手；核心 jsts 策略与 TypeScript 插件策略都只调这里。
// 产出是对原文的单次拼接，调用方据此生成补丁，并用 [start, end) 做批处理冲突检测。
import * as ts from 'typescript'

import { isEmpty, isFalse, isPresent, isTrue } from '@velaros-ai/core'

import { parseJsTs } from '../adapters/jsts-ast.js'
import { ProjectError } from '../errors.js'
import type { AddImportOperation, RemoveImportOperation } from '../types/edit.js'

/** 用 text 替换原文的 [start, end)。 */
export interface SourceSplice {
  start: number
  end: number
  text: string
}

/** named 列表里的一项：`a`、`a as b`、`type a`；imported/local 用于判重，text 原样写回源码。 */
interface NamedSpec {
  imported: string
  local: string
  typeOnly: boolean
  text: string
}

interface ImportStyle {
  quote: string
  semicolon: string
}

type ImportBinding =
  | { kind: 'default'; clause: ts.ImportClause }
  | { kind: 'namespace'; clause: ts.ImportClause }
  | { kind: 'named'; clause: ts.ImportClause; element: ts.ImportSpecifier }

const NamedSpecPattern = /^(type\s+)?([\w$]+|"[^"]*"|'[^']*')(?:\s+as\s+([\w$]+))?$/

/** 只作用于下一行的指令注释：它压制的就是紧随其后的那条语句。 */
const NextLineDirectivePattern = /^\/(?:\/|\*)+\s*(?:@ts-ignore|@ts-expect-error|eslint-disable-next-line|prettier-ignore)\b/

/** 只在文件开头注释里生效的 pragma：三斜线指令、@ts-nocheck / @ts-check、@jsx 系列、@flow、整文件 eslint-disable。 */
const FilePragmaPattern = /^\/\/\/\s*<|@(?:ts-nocheck|ts-check|jsx\w*|flow)\b|eslint-disable(?![-\w])/

/** 注释之后紧跟一个空行：它与后面的代码分离，属于文件头而不是首条语句的文档。 */
const DetachedCommentPattern = /^[\t ]*\r?\n[\t ]*\r?\n/

/**
 * 规划 add_import。返回 null 表示目标状态已满足（去重命中），调用方应产出 noop 补丁而不是空结果——
 * 空结果会让该操作从事务里凭空消失，易被误读为成功执行。
 */
export function planAddImport(path: string, content: string, operation: AddImportOperation): Nullable<SourceSplice> {
  const { sourceFile } = parseJsTs(path, content)
  const imports = topLevelImports(sourceFile)
  const dedupe = !isFalse(operation.dedupe)

  if (isPresent(operation.importStatement)) {
    const requested = parseImportStatement(path, operation.importStatement)
    const identity = importIdentity(requested.declaration)
    if (dedupe && imports.some((declaration) => importIdentity(declaration) === identity)) return null
    return insertStatement(sourceFile, imports, requested.text)
  }

  const module = requireModule(operation.module, 'add_import')
  const style = importStyle(imports)
  const named = [...new Set(operation.named ?? [])].map(parseNamedSpec)
  const sameModule = imports.filter((declaration) => moduleOf(declaration) === module)
  const clauses = sameModule.map((declaration) => declaration.importClause).filter(isPresent)

  if (isTrue(operation.sideEffectOnly)) {
    // type-only import 会被编译擦除，不能代替副作用 import。
    if (dedupe && sameModule.some((declaration) => !declaration.importClause?.isTypeOnly)) return null
    return insertStatement(sourceFile, imports, renderImport(module, {}, style))
  }
  if (isPresent(operation.namespaceImport)) {
    const alias = operation.namespaceImport
    const holder = dedupe ? preferValueClause(clauses.filter((clause) => namespaceNameOf(clause) === alias)) : undefined
    if (!holder) return insertStatement(sourceFile, imports, renderImport(module, { namespaceImport: alias }, style))
    return holder.isTypeOnly ? combineSplices(content, promoteClause(sourceFile, holder, [])) : null
  }
  if (!isPresent(operation.defaultImport) && isEmpty(named)) {
    throw new ProjectError('INVALID_INPUT', 'add_import 的 module 形式需要 sideEffectOnly、named、defaultImport 或 namespaceImport 之一')
  }
  if (!dedupe) return insertStatement(sourceFile, imports, renderImport(module, { defaultImport: operation.defaultImport, named }, style))

  // 去重只认值绑定：type-only 绑定会被编译擦除，满足不了值 import。已有同名 type-only 绑定时就地升级为值绑定，
  // 另加一条同名 import 会与它重复声明同一个本地名。
  const splices: SourceSplice[] = []
  const defaultHolder = preferValueClause(
    clauses.filter((clause) => isPresent(clause.name) && clause.name.text === operation.defaultImport)
  )
  if (defaultHolder?.isTypeOnly) splices.push(...promoteClause(sourceFile, defaultHolder, []))
  const defaultImport = defaultHolder ? undefined : operation.defaultImport

  const missing: NamedSpec[] = []
  const promoted = new Map<ts.ImportClause, ts.ImportSpecifier[]>()
  for (const spec of named) {
    const key = namedKey(spec.imported, spec.local)
    const holders = clauses.flatMap((clause) =>
      namedElementsOf(clause).filter((element) => elementKey(element) === key).map((element) => ({ clause, element }))
    )
    const [holder] = holders
    if (!holder) {
      missing.push(spec)
      continue
    }
    // 请求本身就是 `type X`，或已有值绑定：目标状态已满足。
    if (spec.typeOnly || holders.some((candidate) => !isTypeOnlyElement(candidate.clause, candidate.element))) continue
    if (holder.element.isTypeOnly) splices.push(dropTypeModifier(sourceFile, holder.element))
    else promoted.set(holder.clause, [...(promoted.get(holder.clause) ?? []), holder.element])
  }
  for (const [clause, elements] of promoted) splices.push(...promoteClause(sourceFile, clause, elements))

  if (isPresent(defaultImport) || !isEmpty(missing)) {
    // 同模块已有可吸收的 import 时就地合并（优先已有 `{ … }` 的那条），否则追加一条只含缺失绑定的新语句。
    const hosts = clauses.filter((clause) => canAbsorb(clause, isPresent(defaultImport)))
    const host = hosts.find((clause) => isPresent(clause.namedBindings)) ?? hosts[0]
    splices.push(
      ...(host
        ? mergeIntoClause(sourceFile, host, defaultImport, missing)
        : [insertStatement(sourceFile, imports, renderImport(module, { defaultImport, named: missing }, style))])
    )
  }
  return isEmpty(splices) ? null : combineSplices(content, splices)
}

/**
 * 规划 remove_import：importStatement 精确删整句；只给模块删整条；模块 + name 只删该 binding，
 * 最后一个 named binding 删完且没有 default 时删整条，有 default 时保留 default。
 * 同一模块的多条声明无法唯一确定时报 AMBIGUOUS_TARGET，而不是挑第一条猜。
 */
export function planRemoveImport(path: string, content: string, operation: RemoveImportOperation): SourceSplice {
  const { sourceFile } = parseJsTs(path, content)
  const imports = topLevelImports(sourceFile)
  const describe = (declaration: ts.ImportDeclaration) => declaration.getText(sourceFile)

  if (isPresent(operation.importStatement)) {
    const requested = parseImportStatement(path, operation.importStatement)
    const identity = importIdentity(requested.declaration)
    const matches = imports.filter((declaration) => importIdentity(declaration) === identity)
    return removeStatement(sourceFile, single(matches, `未找到 import 语句：${requested.text}`, describe))
  }

  const module = requireModule(operation.moduleSpecifier ?? operation.module, 'remove_import')
  const sameModule = imports.filter((declaration) => moduleOf(declaration) === module)
  const moduleMissing = `未找到模块 ${module} 的 import 语句`
  if (!isPresent(operation.name)) return removeStatement(sourceFile, single(sameModule, moduleMissing, describe))

  const name = parseNamedSpec(operation.name).imported
  const holders = sameModule.flatMap((declaration) => {
    const binding = bindingOf(declaration, name)
    return binding ? [{ declaration, binding }] : []
  })
  const holder = single(
    holders,
    isEmpty(sameModule) ? moduleMissing : `模块 ${module} 的 import 中没有绑定：${name}`,
    (candidate) => describe(candidate.declaration)
  )
  return removeBinding(sourceFile, holder.declaration, holder.binding)
}

function topLevelImports(sourceFile: ts.SourceFile): ts.ImportDeclaration[] {
  return sourceFile.statements.filter(ts.isImportDeclaration)
}

function moduleOf(declaration: ts.ImportDeclaration): string {
  const specifier = declaration.moduleSpecifier
  return ts.isStringLiteral(specifier) ? specifier.text : specifier.getText()
}

function requireModule(module: Optional<string>, operation: string): string {
  if (!isPresent(module)) throw new ProjectError('INVALID_INPUT', `${operation} 需要 importStatement、moduleSpecifier 或 module`)
  return module
}

/** 候选必须恰好一条：零条是 TARGET_NOT_FOUND，多条是 AMBIGUOUS_TARGET 并列出候选原文。 */
function single<T>(candidates: T[], notFound: string, describe: (candidate: T) => string): T {
  if (candidates.length === 1) return candidates[0]
  if (isEmpty(candidates)) throw new ProjectError('TARGET_NOT_FOUND', notFound)
  throw new ProjectError(
    'AMBIGUOUS_TARGET',
    `找到 ${candidates.length} 条匹配的 import 声明，无法唯一确定要改哪一条`,
    { candidates: candidates.map(describe) },
    '请改用 importStatement 指定完整的 import 语句。'
  )
}

/** 调用方给的完整语句必须恰好是一条语法正确的 import 声明，否则在边界处拒绝，而不是原样塞进文件。 */
function parseImportStatement(path: string, statement: string): { text: string; declaration: ts.ImportDeclaration } {
  const trimmed = statement.trim()
  const text = trimmed.endsWith(';') ? trimmed : `${trimmed};`
  const { sourceFile, diagnostics } = parseJsTs(path, text)
  const [declaration] = sourceFile.statements
  if (sourceFile.statements.length !== 1 || !ts.isImportDeclaration(declaration) || !isEmpty(diagnostics)) {
    throw new ProjectError('INVALID_INPUT', `importStatement 必须是一条完整的 import 声明：${statement}`)
  }
  return { text, declaration }
}

/** import 的语义身份：引号、空白、分号、绑定顺序都不影响相等，绑定集合或 type 修饰不同则不等。 */
function importIdentity(declaration: ts.ImportDeclaration): string {
  const clause = declaration.importClause
  const bindings = clause?.namedBindings
  const named = bindings && ts.isNamedImports(bindings)
    ? bindings.elements.map((element) => `${element.isTypeOnly ? 'type ' : ''}${elementKey(element)}`).sort()
    : []
  return JSON.stringify([
    moduleOf(declaration),
    !!clause?.isTypeOnly,
    clause?.name?.text ?? '',
    (clause && namespaceNameOf(clause)) ?? '',
    named,
    declaration.attributes?.getText().replace(/\s+/g, '') ?? '',
  ])
}

function parseNamedSpec(text: string): NamedSpec {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const match = NamedSpecPattern.exec(normalized)
  if (!match) throw new ProjectError('INVALID_INPUT', `不是合法的 import 绑定：${text}`)
  const imported = match[2].replace(/^["']|["']$/g, '')
  return { imported, local: match[3] ?? imported, typeOnly: isPresent(match[1]), text: normalized }
}

function namedKey(imported: string, local: string): string {
  return `${imported} as ${local}`
}

function elementKey(element: ts.ImportSpecifier): string {
  return namedKey((element.propertyName ?? element.name).text, element.name.text)
}

function namedElementsOf(clause: ts.ImportClause): readonly ts.ImportSpecifier[] {
  const bindings = clause.namedBindings
  return bindings && ts.isNamedImports(bindings) ? bindings.elements : []
}

function namespaceNameOf(clause: ts.ImportClause): Optional<string> {
  const bindings = clause.namedBindings
  return bindings && ts.isNamespaceImport(bindings) ? bindings.name.text : undefined
}

/** 同一绑定出现在多条 clause 里时，已有的值绑定优先——它已满足请求，不必再升级另一条 type-only。 */
function preferValueClause(clauses: ts.ImportClause[]): Optional<ts.ImportClause> {
  return clauses.find((clause) => !clause.isTypeOnly) ?? clauses[0]
}

function isTypeOnlyElement(clause: ts.ImportClause, element: ts.ImportSpecifier): boolean {
  return clause.isTypeOnly || element.isTypeOnly
}

/** 行内 `type a` 升级为值绑定：只删 `type ` 修饰。 */
function dropTypeModifier(sourceFile: ts.SourceFile, element: ts.ImportSpecifier): SourceSplice {
  return { start: element.getStart(sourceFile), end: (element.propertyName ?? element.name).getStart(sourceFile), text: '' }
}

/**
 * 把 `import type …` 升级为值 import：删掉语句级 `type`（clause 文本就从它开始），其余没被请求的 named 绑定
 * 改写成行内 `type x`，它们仍保持仅类型，不会因为这次升级变成运行时 import。
 */
function promoteClause(sourceFile: ts.SourceFile, clause: ts.ImportClause, requested: readonly ts.ImportSpecifier[]): SourceSplice[] {
  const [keyword, firstBinding] = clause.getChildren(sourceFile)
  const splices = [{ start: keyword.getStart(sourceFile), end: firstBinding.getStart(sourceFile), text: '' }]
  for (const element of namedElementsOf(clause)) {
    if (requested.includes(element)) continue
    const at = element.getStart(sourceFile)
    splices.push({ start: at, end: at, text: 'type ' })
  }
  return splices
}

/** 能就地吸收新绑定的 clause：非 type-only、非 namespace 形式；要补 default 时自身还不能已有 default。 */
function canAbsorb(clause: ts.ImportClause, needsDefault: boolean): boolean {
  if (clause.isTypeOnly) return false
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return false
  return !needsDefault || !clause.name
}

function mergeIntoClause(
  sourceFile: ts.SourceFile,
  clause: ts.ImportClause,
  defaultImport: Optional<string>,
  missing: NamedSpec[]
): SourceSplice[] {
  const splices: SourceSplice[] = []
  // 能补 default 的 clause 自身没有 default，起点就是 `{`。
  if (isPresent(defaultImport)) {
    const at = clause.getStart(sourceFile)
    splices.push({ start: at, end: at, text: `${defaultImport}, ` })
  }
  if (!isEmpty(missing)) {
    const bindings = clause.namedBindings
    // 没有 `{ … }` 的 clause 只剩 default 一项，在它后面接上新的 named 列表。
    splices.push(
      ...(bindings && ts.isNamedImports(bindings)
        ? insertIntoNamedImports(sourceFile, bindings, missing)
        : [{ start: clause.end, end: clause.end, text: `, { ${missing.map((spec) => spec.text).join(', ')} }` }])
    )
  }
  return splices
}

/**
 * 往 `{ … }` 里追加绑定。`}` 独占一行的多行 import 按最后一项的缩进逐行插在 `}` 之前，尾逗号风格跟随原列表，
 * 最后一项的行尾注释仍留在它自己身后；其余情况在最后一项后单行追加。
 */
function insertIntoNamedImports(sourceFile: ts.SourceFile, named: ts.NamedImports, missing: NamedSpec[]): SourceSplice[] {
  const texts = missing.map((spec) => spec.text)
  const last = named.elements.at(-1)
  if (!last) return [{ start: named.getStart(sourceFile), end: named.end, text: `{ ${texts.join(', ')} }` }]
  const content = sourceFile.text
  const closeBrace = named.end - 1
  const closeLineStart = lineStartOf(content, closeBrace)
  if (!/^[\t ]*$/.test(content.slice(closeLineStart, closeBrace))) return [{ start: last.end, end: last.end, text: `, ${texts.join(', ')}` }]

  const lastStart = last.getStart(sourceFile)
  const leading = content.slice(lineStartOf(content, lastStart), lastStart)
  const indent = /^[\t ]*$/.test(leading) ? leading : '  '
  const trailingComma = named.elements.hasTrailingComma
  const eol = eolOf(content)
  const lines = texts.map((text, index) => `${indent}${text}${trailingComma || index < texts.length - 1 ? ',' : ''}${eol}`)
  const splices = [{ start: closeLineStart, end: closeLineStart, text: lines.join('') }]
  if (!trailingComma) splices.push({ start: last.end, end: last.end, text: ',' })
  return splices
}

function lineStartOf(content: string, position: number): number {
  return content.lastIndexOf('\n', position - 1) + 1
}

/** 把 import 区里互不重叠的多处改动合成一次拼接；同一起点的纯插入排在删除之前。 */
function combineSplices(content: string, splices: SourceSplice[]): SourceSplice {
  const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end)
  let text = ''
  let cursor = ordered[0].start
  for (const splice of ordered) {
    text += content.slice(cursor, splice.start) + splice.text
    cursor = splice.end
  }
  return { start: ordered[0].start, end: cursor, text }
}

function bindingOf(declaration: ts.ImportDeclaration, name: string): Optional<ImportBinding> {
  const clause = declaration.importClause
  if (!clause) return undefined
  const bindings = clause.namedBindings
  if (bindings && ts.isNamedImports(bindings)) {
    // 先按 imported 名匹配（`a as b` 用 a 命中），再退到本地名；行内 `type a` 同样适用。
    const element =
      bindings.elements.find((candidate) => (candidate.propertyName ?? candidate.name).text === name) ??
      bindings.elements.find((candidate) => candidate.name.text === name)
    if (element) return { kind: 'named', clause, element }
  }
  if (clause.name?.text === name) return { kind: 'default', clause }
  if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return { kind: 'namespace', clause }
  return undefined
}

function removeBinding(sourceFile: ts.SourceFile, declaration: ts.ImportDeclaration, binding: ImportBinding): SourceSplice {
  const { clause } = binding
  if (binding.kind === 'named') {
    const elements = binding.element.parent.elements
    const index = elements.indexOf(binding.element)
    // 连同分隔逗号一起删：非末项删到下一项起点，末项从前一项末尾删起（多行 import 同样成立）。
    if (index < elements.length - 1) return { start: binding.element.getStart(sourceFile), end: elements[index + 1].getStart(sourceFile), text: '' }
    if (index > 0) return { start: elements[index - 1].end, end: binding.element.end, text: '' }
  }
  // 删 default 而还有 `{ … }` / `* as ns` 时只删 `D, `。
  const namedBindings = clause.namedBindings
  if (binding.kind === 'default' && namedBindings) return { start: clause.getStart(sourceFile), end: namedBindings.getStart(sourceFile), text: '' }
  // 删掉的是唯一的 named / namespace 绑定而还有 default 时，只删 `, { … }` / `, * as ns`。
  if (binding.kind !== 'default' && clause.name) return { start: clause.name.end, end: clause.end, text: '' }
  return removeStatement(sourceFile, declaration)
}

/**
 * 删整条声明，连同同行的尾随注释、行尾空白与一个换行，不留空行也不留孤儿注释。紧贴在它上方的下一行指令注释
 * （@ts-ignore、eslint-disable-next-line 等）一并删除——留下来它就改去压制下一条语句。
 */
function removeStatement(sourceFile: ts.SourceFile, declaration: ts.ImportDeclaration): SourceSplice {
  const content = sourceFile.text
  let end = ts.getTrailingCommentRanges(content, declaration.end)?.at(-1)?.end ?? declaration.end
  while (content[end] === ' ' || content[end] === '\t') end += 1
  if (content.startsWith('\r\n', end)) end += 2
  else if (content[end] === '\n') end += 1

  let start = declaration.getStart(sourceFile)
  // 自下而上逐条吞并：每条指令与已吞部分之间只能隔一个换行，隔着空行或普通注释就停。
  for (const comment of [...(ts.getLeadingCommentRanges(content, declaration.pos) ?? [])].reverse()) {
    const adjacent = /^[\t ]*\r?\n[\t ]*$/.test(content.slice(comment.end, start))
    if (!adjacent || !NextLineDirectivePattern.test(content.slice(comment.pos, comment.end))) break
    start = comment.pos
  }
  return { start, end, text: '' }
}

/** 新语句插在最后一个 import 所在行之后；没有 import 时插在文件头之后。 */
function insertStatement(sourceFile: ts.SourceFile, imports: ts.ImportDeclaration[], statement: string): SourceSplice {
  const content = sourceFile.text
  const eol = eolOf(content)
  const anchor = imports.at(-1)?.end ?? headerEnd(sourceFile)
  if (!isPresent(anchor)) return { start: 0, end: 0, text: `${statement}${eol}` }
  const lineBreak = content.indexOf('\n', anchor)
  const at = lineBreak === -1 ? content.length : content[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak
  return { start: at, end: at, text: `${eol}${statement}` }
}

/**
 * 文件头的末尾：shebang、文件级 pragma 注释与指令序言（'use strict' 等）都得留在 import 之前——pragma 只在
 * 文件开头的注释里生效，被 import 挤到后面就静默失效。与后续代码隔着空行的注释（许可证头等）也算文件头；
 * 紧贴首条语句的普通注释是它的文档，留给它。
 */
function headerEnd(sourceFile: ts.SourceFile): Optional<number> {
  const content = sourceFile.text
  let anchor = content.startsWith('#!') ? 0 : undefined
  for (const comment of ts.getLeadingCommentRanges(content, 0) ?? []) {
    const text = content.slice(comment.pos, comment.end)
    if (FilePragmaPattern.test(text) || DetachedCommentPattern.test(content.slice(comment.end))) anchor = comment.end
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    anchor = statement.end
  }
  return anchor
}

/** 新语句沿用文件现有 import 的引号与分号风格；文件里还没有 import 时用双引号加分号。 */
function importStyle(imports: ts.ImportDeclaration[]): ImportStyle {
  const first = imports[0]
  const last = imports.at(-1)
  if (!first || !last) return { quote: '"', semicolon: ';' }
  return {
    quote: first.moduleSpecifier.getText().startsWith("'") ? "'" : '"',
    semicolon: last.getText().endsWith(';') ? ';' : '',
  }
}

function renderImport(
  module: string,
  bindings: { defaultImport?: string; namespaceImport?: string; named?: NamedSpec[] },
  style: ImportStyle
): string {
  const specifier = `${style.quote}${module}${style.quote}`
  const named = bindings.named ?? []
  const parts = [
    bindings.defaultImport,
    isPresent(bindings.namespaceImport) ? `* as ${bindings.namespaceImport}` : undefined,
    isEmpty(named) ? undefined : `{ ${named.map((spec) => spec.text).join(', ')} }`,
  ].filter(isPresent)
  return isEmpty(parts)
    ? `import ${specifier}${style.semicolon}`
    : `import ${parts.join(', ')} from ${specifier}${style.semicolon}`
}

function eolOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}
