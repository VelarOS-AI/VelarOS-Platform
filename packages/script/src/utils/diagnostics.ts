import ts from 'typescript'

import { isEmpty, isUndefined, truncate } from '@velaros-ai/core'

import { CodeSurfaceTuning } from './tuning.js'

/** 为检查器的结构化诊断生成有界源码行与列定位。 */
export function renderDiagnosticFrame(source: string, line: number, column: number): string {
  const original = source.split('\n')[line - 1] ?? ''
  const text =
    original.length > CodeSurfaceTuning.frameLineChars
      ? `${original.slice(0, CodeSurfaceTuning.frameLineChars)}…`
      : original
  const gutter = String(line)
  const caret = Math.max(0, Math.min(column - 1, text.length))
  return `${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${' '.repeat(caret)}^`
}

/**
 * 名字写错时补一句实际有什么：类型的成员、模块的导出；联合类型按分支列，值还是 Promise 时提醒先 await。
 *
 * TS 只在名字相近时给 `Did you mean`，猜得离谱时只说「没有」。实测模型为 `page.modules`、`m.description`
 * 这样的猜测连着被拦了三轮：每轮都只知道哪里错，不知道该写什么。
 * 字符串、数组、标准库里的类型不列：模型本来就认得，列出来只占预算。
 */
export function describeAvailableNames(
  diagnostic: ts.Diagnostic,
  program: ts.Program
): Optional<string> {
  const file = diagnostic.file
  if (!file || isUndefined(diagnostic.start) || !isUnknownNameDiagnostic(diagnostic.code))
    return undefined
  const name = findNodeAt(file, diagnostic.start)
  if (!ts.isIdentifier(name)) return undefined
  const checker = program.getTypeChecker()
  if (ts.isImportSpecifier(name.parent)) return describeModuleExports(name.parent, checker)
  const owner = ownerTypeOf(name, checker)
  if (isUndefined(owner)) return undefined
  const branches = (owner.isUnion() ? owner.types : [owner]).filter(
    (type) => !(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))
  )
  // 写对象字面量时没有「先判断是哪一种」这回事，只有读值时才要先收窄
  const reading = !ts.isObjectLiteralElementLike(name.parent)
  if (branches.length > 1) return describeBranches(name.text, branches, reading, checker)
  const [only] = branches
  if (isUndefined(only)) return undefined
  if (only.getSymbol()?.getName() === 'Promise' && isDeclaredInDefaultLibrary(only, program))
    return '这个值还是 Promise：先 await 再取字段。'
  if (isWellKnownType(only, checker, program)) return undefined
  return describeMembers(only, name, checker)
}

/**
 * 把「实际有什么」接在 TS 的原话后面，整条守住单条诊断的预算。超了先截 TS 的原话、补的这句保全：
 * 展开的类型文字最不要紧，实际有什么才是模型下一轮要用的。
 */
export function appendAvailableNames(message: string, names: Optional<string>): string {
  if (isUndefined(names)) return message
  const room = Math.max(0, CodeSurfaceTuning.diagnosticMessageChars - names.length - 2)
  return `${truncate(message, room)} ${names}`
}

/**
 * 「名字写错」这一族诊断：属性不存在（2339；名字相近时是带 Did you mean 的 2551）、
 * 对象字面量里写了类型没有的字段（2353、2561）、模块没有这个导出（2305；带 Did you mean 的 2724——
 * 它可能指向一个只是类型的名字，脚本 import 了也用不上，所以照样列出值导出）。
 */
function isUnknownNameDiagnostic(code: number): boolean {
  return [2339, 2551, 2353, 2561, 2305, 2724].includes(code)
}

/** 诊断位置上最里层的节点。 */
function findNodeAt(file: ts.SourceFile, position: number): ts.Node {
  const visit = (node: ts.Node): ts.Node =>
    ts.forEachChild(node, (child) =>
      child.getStart(file) <= position && position < child.getEnd() ? visit(child) : undefined
    ) ?? node
  return visit(file)
}

/** 写错的名字挂在哪个类型上：点号左边的值、被解构的值、对象字面量要满足的类型。 */
function ownerTypeOf(name: ts.Identifier, checker: ts.TypeChecker): Optional<ts.Type> {
  const parent = name.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === name)
    return checker.getTypeAtLocation(parent.expression)
  if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent))
    return checker.getTypeAtLocation(parent.parent)
  if (ts.isObjectLiteralElementLike(parent) && ts.isObjectLiteralExpression(parent.parent))
    return checker.getContextualType(parent.parent)
  return undefined
}

/** 模型本来就认得的类型：原始值、数组与元组、标准库里声明的。 */
function isWellKnownType(type: ts.Type, checker: ts.TypeChecker, program: ts.Program): boolean {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike
  if (type.flags & primitive) return true
  return (
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    isDeclaredInDefaultLibrary(type, program)
  )
}

/** 类型只声明在标准库里（Promise、Map、Date 这类）。 */
function isDeclaredInDefaultLibrary(type: ts.Type, program: ts.Program): boolean {
  const declarations = type.getSymbol()?.getDeclarations() ?? []
  return (
    !isEmpty(declarations) &&
    declarations.every((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    )
  )
}

/** 一个类型的全部成员：方法写成 `名字()`，其余写 `名字: 类型`，可选的带 `?`。 */
function describeMembers(type: ts.Type, at: ts.Node, checker: ts.TypeChecker): Optional<string> {
  const members = checker.getPropertiesOfType(type)
  if (isEmpty(members)) return undefined
  // 匿名对象类型的符号名是 `__type`、`__object` 这类，说不出名字就不说
  const named = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName()
  const head = isUndefined(named) || named.startsWith('__') ? '可用的成员：' : `${named} 的成员：`
  return fitNames(
    head,
    members.map((member) => describeMember(member, at, checker))
  )
}

/** 一个成员：能调用的只给名字加括号，参数看声明；别的给声明里写的那个类型。 */
function describeMember(member: ts.Symbol, at: ts.Node, checker: ts.TypeChecker): string {
  const type = checker.getTypeOfSymbolAtLocation(member, at)
  if (!isEmpty(type.getCallSignatures()) && isEmpty(checker.getPropertiesOfType(type)))
    return `${member.getName()}()`
  const optional = member.flags & ts.SymbolFlags.Optional ? '?' : ''
  const text = declaredTypeText(member) ?? checker.typeToString(type)
  return `${member.getName()}${optional}: ${truncate(text, CodeSurfaceTuning.memberTypeChars)}`
}

/**
 * 声明里写的类型原文，空白压成一个空格。生成的声明就是模型读到的那份，照它写最不会对不上；
 * 可选成员也不必再带一个 `| undefined`。程序里自己拼的对象没写类型，交给调用方推。
 */
function declaredTypeText(member: ts.Symbol): Optional<string> {
  const declaration = member.valueDeclaration ?? member.declarations?.[0]
  if (
    declaration &&
    (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
    declaration.type
  )
    return declaration.type.getText().replace(/\s+/gu, ' ')
  return undefined
}

/** 模块的值导出：函数写成 `名字()`。 */
function describeModuleExports(
  specifier: ts.ImportSpecifier,
  checker: ts.TypeChecker
): Optional<string> {
  const declaration = specifier.parent.parent.parent
  if (!ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier))
    return undefined
  const module = checker.getSymbolAtLocation(declaration.moduleSpecifier)
  if (isUndefined(module)) return undefined
  const exported = checker
    .getExportsOfModule(module)
    .filter((symbol) => symbol.flags & ts.SymbolFlags.Value)
  if (isEmpty(exported)) return undefined
  return fitNames(
    `${declaration.moduleSpecifier.text} 的导出：`,
    exported.map((symbol) =>
      isEmpty(checker.getTypeOfSymbolAtLocation(symbol, declaration).getCallSignatures())
        ? symbol.getName()
        : `${symbol.getName()}()`
    )
  )
}

/**
 * 联合类型按分支列各自的成员名。读值时名字只在一部分分支上，先说怎么收窄——这句放最前面，
 * 分支列得太长被截掉的也只是后面的名字。
 */
function describeBranches(
  name: string,
  branches: readonly ts.Type[],
  reading: boolean,
  checker: ts.TypeChecker
): string {
  const shown = branches.slice(0, CodeSurfaceTuning.memberHintBranches).map((branch) => {
    const members = checker.getPropertiesOfType(branch).map((member) => member.getName())
    const label = truncate(checker.typeToString(branch), CodeSurfaceTuning.memberTypeChars)
    return `${label} 有 ${isEmpty(members) ? '（没有字段）' : members.join('、')}`
  })
  const more = branches.length > shown.length ? `；另有 ${branches.length - shown.length} 种` : ''
  const narrowing =
    reading && branches.some((branch) => !isUndefined(branch.getProperty(name)))
      ? `先用 '${name}' in 值 判断是哪一种。`
      : ''
  return truncate(
    `${narrowing}各分支：${shown.join('；')}${more}`,
    CodeSurfaceTuning.memberHintChars
  )
}

/** 名字一个个往后接，接不下就停下说一共几个（这句也算在预算里）：宁可少列，不交半个名字。 */
function fitNames(head: string, names: readonly string[]): string {
  const rest = `…共 ${names.length} 个`
  let text = head
  for (const [index, name] of names.entries()) {
    const next = index === 0 ? `${text}${name}` : `${text}、${name}`
    const needed = index === names.length - 1 ? next.length : next.length + rest.length
    if (needed > CodeSurfaceTuning.memberHintChars) return `${text}${rest}`
    text = next
  }
  return text
}
