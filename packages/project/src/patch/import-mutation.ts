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

  if (isTrue(operation.sideEffectOnly)) {
    // type-only import 会被编译擦除，不能代替副作用 import。
    if (dedupe && sameModule.some((declaration) => !declaration.importClause?.isTypeOnly)) return null
    return insertStatement(sourceFile, imports, renderImport(module, {}, style))
  }
  if (isPresent(operation.namespaceImport)) {
    const alias = operation.namespaceImport
    if (dedupe && sameModule.some((declaration) => namespaceNameOf(declaration) === alias)) return null
    return insertStatement(sourceFile, imports, renderImport(module, { namespaceImport: alias }, style))
  }
  if (!isPresent(operation.defaultImport) && isEmpty(named)) {
    throw new ProjectError('INVALID_INPUT', 'add_import 的 module 形式需要 sideEffectOnly、named、defaultImport 或 namespaceImport 之一')
  }
  if (!dedupe) return insertStatement(sourceFile, imports, renderImport(module, { defaultImport: operation.defaultImport, named }, style))

  const defaultImport = sameModule.some((declaration) => declaration.importClause?.name?.text === operation.defaultImport)
    ? undefined
    : operation.defaultImport
  const present = new Set(sameModule.flatMap(namedKeysOf))
  const missing = named.filter((spec) => !present.has(namedKey(spec.imported, spec.local)))
  if (!isPresent(defaultImport) && isEmpty(missing)) return null

  // 同模块已有可吸收的 import 时就地合并（优先已有 `{ … }` 的那条），否则追加一条只含缺失绑定的新语句。
  const hosts = sameModule
    .map((declaration) => declaration.importClause)
    .filter((clause): clause is ts.ImportClause => isPresent(clause) && canAbsorb(clause, isPresent(defaultImport)))
  const host = hosts.find((clause) => isPresent(clause.namedBindings)) ?? hosts[0]
  if (host) return mergeIntoClause(sourceFile, host, defaultImport, missing)
  return insertStatement(sourceFile, imports, renderImport(module, { defaultImport, named: missing }, style))
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
    namespaceNameOf(declaration) ?? '',
    named,
    declaration.attributes?.getText().replace(/\s+/g, '') ?? '',
  ])
}

function parseNamedSpec(text: string): NamedSpec {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const match = NamedSpecPattern.exec(normalized)
  if (!match) throw new ProjectError('INVALID_INPUT', `不是合法的 import 绑定：${text}`)
  const imported = match[2].replace(/^["']|["']$/g, '')
  return { imported, local: match[3] ?? imported, text: normalized }
}

function namedKey(imported: string, local: string): string {
  return `${imported} as ${local}`
}

function elementKey(element: ts.ImportSpecifier): string {
  return namedKey((element.propertyName ?? element.name).text, element.name.text)
}

function namedKeysOf(declaration: ts.ImportDeclaration): string[] {
  const bindings = declaration.importClause?.namedBindings
  return bindings && ts.isNamedImports(bindings) ? bindings.elements.map(elementKey) : []
}

function namespaceNameOf(declaration: ts.ImportDeclaration): Optional<string> {
  const bindings = declaration.importClause?.namedBindings
  return bindings && ts.isNamespaceImport(bindings) ? bindings.name.text : undefined
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
): SourceSplice {
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
      bindings && ts.isNamedImports(bindings)
        ? insertIntoNamedImports(sourceFile, bindings, missing)
        : { start: clause.end, end: clause.end, text: `, { ${missing.map((spec) => spec.text).join(', ')} }` }
    )
  }
  return combineSplices(sourceFile.text, splices)
}

/**
 * 往 `{ … }` 里追加绑定。`}` 独占一行的多行 import 按最后一项的缩进逐行插在 `}` 之前，尾逗号风格跟随原列表，
 * 最后一项的行尾注释仍留在它自己身后；其余情况在最后一项后单行追加。
 */
function insertIntoNamedImports(sourceFile: ts.SourceFile, named: ts.NamedImports, missing: NamedSpec[]): SourceSplice {
  const texts = missing.map((spec) => spec.text)
  const last = named.elements.at(-1)
  if (!last) return { start: named.getStart(sourceFile), end: named.end, text: `{ ${texts.join(', ')} }` }
  const content = sourceFile.text
  const closeBrace = named.end - 1
  const closeLineStart = lineStartOf(content, closeBrace)
  if (!/^[\t ]*$/.test(content.slice(closeLineStart, closeBrace))) return { start: last.end, end: last.end, text: `, ${texts.join(', ')}` }

  const lastStart = last.getStart(sourceFile)
  const leading = content.slice(lineStartOf(content, lastStart), lastStart)
  const indent = /^[\t ]*$/.test(leading) ? leading : '  '
  const trailingComma = named.elements.hasTrailingComma
  const eol = eolOf(content)
  const lines = texts.map((text, index) => `${indent}${text}${trailingComma || index < texts.length - 1 ? ',' : ''}${eol}`)
  const splices = [{ start: closeLineStart, end: closeLineStart, text: lines.join('') }]
  if (!trailingComma) splices.push({ start: last.end, end: last.end, text: ',' })
  return combineSplices(content, splices)
}

function lineStartOf(content: string, position: number): number {
  return content.lastIndexOf('\n', position - 1) + 1
}

/** 把同一语句内互不重叠的多处改动合成一次拼接。 */
function combineSplices(content: string, splices: SourceSplice[]): SourceSplice {
  const ordered = [...splices].sort((a, b) => a.start - b.start)
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

/** 删整条声明，连同同行的尾随注释、行尾空白与一个换行，不留空行也不留孤儿注释。 */
function removeStatement(sourceFile: ts.SourceFile, declaration: ts.ImportDeclaration): SourceSplice {
  const content = sourceFile.text
  let end = ts.getTrailingCommentRanges(content, declaration.end)?.at(-1)?.end ?? declaration.end
  while (content[end] === ' ' || content[end] === '\t') end += 1
  if (content.startsWith('\r\n', end)) end += 2
  else if (content[end] === '\n') end += 1
  return { start: declaration.getStart(sourceFile), end, text: '' }
}

/** 新语句插在最后一个 import 所在行之后；没有 import 时插在 shebang 与指令序言（'use strict' 等）之后。 */
function insertStatement(sourceFile: ts.SourceFile, imports: ts.ImportDeclaration[], statement: string): SourceSplice {
  const content = sourceFile.text
  const eol = eolOf(content)
  const anchor = imports.at(-1)?.end ?? prologueEnd(sourceFile)
  if (!isPresent(anchor)) return { start: 0, end: 0, text: `${statement}${eol}` }
  const lineBreak = content.indexOf('\n', anchor)
  const at = lineBreak === -1 ? content.length : content[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak
  return { start: at, end: at, text: `${eol}${statement}` }
}

function prologueEnd(sourceFile: ts.SourceFile): Optional<number> {
  let anchor = sourceFile.text.startsWith('#!') ? 0 : undefined
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
