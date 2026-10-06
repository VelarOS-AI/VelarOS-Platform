/**
 * 编译器那一侧的活：模型交的程序查语法、import 与标准输出的确定类型矛盾，手滑写成 TypeScript 时剥类型；
 * 我们自己写的代码模版另外照声明做完整类型检查（模型交的程序不走那一条）。
 * 全是纯函数，所以不放在类里；`CodeProgramChecker` 只负责按什么顺序用它们。
 */
import ts from 'typescript'

import { isEmpty, isNotNull, isNull, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceDiagnosticCodes } from '../contract/constants.js'
import type { CodeProgramDiagnostic, ScriptModuleExportsSlice } from '../types/script.js'

import { renderDiagnosticFrame } from './diagnostics.js'
import { readModuleReferences } from './module-form.js'
import { programForCheck, readCapabilityNamespace } from './program.js'
import { isRelativeSpecifier, resolveLibraryImport } from './refs.js'
import { CodeSurfaceTuning } from './tuning.js'

/** 生成出来的能力声明在内存文件系统里的名字。 */
export const DeclarationFileName = '/velaros.d.ts'

/** 检查时脚本库的根目录：库里的 `lib/x.js` 就是 `/scripts/lib/x.js`。 */
export const LibraryRoot = '/scripts'

/** 直接跑的代码在库根上用的文件名：以点开头，库里的脚本不许这样起名，所以撞不上。 */
export const AnonymousProgramFile = '.program.js'

/** 手滑写成 TypeScript 时剥类型用的那份文件名；换个后缀编译器才会按 TS 解析。 */
export const TypeScriptProgramFileName = '/program.ts'

/** 程序按哪一版 JavaScript 解析。 */
const ProgramTarget = ts.ScriptTarget.ES2022

/**
 * 把恒常可用的程序数据模块与这一轮授权的几个命名空间拼成一份声明。
 *
 * **只拼授权的**——不授权的模块不在这份声明里，`import` 它就落不到；
 * 也正因为如此，检查器绝不能图省事加载全量。
 */
export function joinGrantedDeclarations(
  program: string,
  granted: ReadonlyArray<{ declarations: string }>
): string {
  return [program, ...granted.map((module) => module.declarations)].join('\n\n')
}

/** 检查时交上来的这份程序叫什么：库里的脚本在库里它自己的位置，直接跑的代码在库根上；按 TypeScript 解析时换成 .ts。 */
export function checkedProgramFile(path: Optional<string>, typescript: boolean): string {
  const file = `${LibraryRoot}/${path ?? AnonymousProgramFile}`
  return typescript ? file.replace(/\.js$/u, '.ts') : file
}

/**
 * 声明里提供了哪些模块、各自导出哪些名字（`declare module 'velaros:project' { export function read… }`）。
 * names 用来核对 import 的名字：声明里出现过的都算，类型也算——import 一个类型名跑起来只是 undefined，不值得拦；
 * listed 是说给模型听的那份，只列值（函数、常量、转出的命名空间）。含 `export * from` 的模块说不全自己有什么，open 为真、不核对名字。
 */
export function declaredModules(
  declarations: string
): Map<string, { names: Set<string>; listed: string[]; open: boolean }> {
  const file = ts.createSourceFile(
    DeclarationFileName,
    declarations,
    ProgramTarget,
    false,
    ts.ScriptKind.TS
  )
  const modules = new Map<string, { names: Set<string>; listed: string[]; open: boolean }>()
  for (const statement of file.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue
    const module = { names: new Set<string>(), listed: [] as string[], open: false }
    const add = (name: string, value: boolean): void => {
      if (value && name !== 'default' && !module.names.has(name)) module.listed.push(name)
      module.names.add(name)
    }
    const body = statement.body && ts.isModuleBlock(statement.body) ? statement.body.statements : []
    for (const member of body) {
      if (ts.isExportDeclaration(member)) {
        const clause = member.exportClause
        if (!clause) module.open = true
        else if (ts.isNamespaceExport(clause)) add(clause.name.text, true)
        else for (const element of clause.elements) add(element.name.text, true)
        continue
      }
      if (ts.isExportAssignment(member)) {
        add('default', true)
        continue
      }
      const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []
      const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      const value = !ts.isInterfaceDeclaration(member) && !ts.isTypeAliasDeclaration(member)
      for (const name of declaredNamesOf(member)) add(isDefault ? 'default' : name, value)
    }
    modules.set(statement.name.text, module)
  }
  return modules
}

/** 多导出共享类型闭包与模块共同规则。 */
export function sliceModuleExports(
  declarations: string,
  specifier: string,
  names: readonly string[]
): ScriptModuleExportsSlice {
  const file = ts.createSourceFile(
    DeclarationFileName,
    declarations,
    ProgramTarget,
    true,
    ts.ScriptKind.TS
  )
  const module = file.statements.find(
    (statement): statement is ts.ModuleDeclaration =>
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteral(statement.name) &&
      statement.name.text === specifier
  )
  const body = module?.body && ts.isModuleBlock(module.body) ? module.body.statements : []
  const exports = declaredModules(declarations).get(specifier)?.listed ?? []
  const byName = new Map<string, ts.Statement[]>()
  for (const statement of body)
    for (const declared of declaredNamesOf(statement))
      byName.set(declared, [...(byName.get(declared) ?? []), statement])
  const requested = [...new Set(names)]
  const missing = requested.filter((name) => !byName.has(name))
  if (!module || isEmpty(requested) || !isEmpty(missing))
    return { declarations: null, exports, missing }

  const moduleDocs = file.text.slice(module.getFullStart(), module.getStart(file)).trim()

  const picked = new Set<ts.Statement>()
  const pending = [...requested]
  for (let next = pending.pop(); !isUndefined(next); next = pending.pop())
    for (const statement of byName.get(next) ?? []) {
      if (picked.has(statement)) continue
      picked.add(statement)
      pending.push(...referencedTypeNames(statement))
    }
  const text = body
    .filter((statement) => picked.has(statement))
    .map((statement) => statement.getFullText(file).replace(/^\n+/u, ''))
    .join('\n')
  const prefix = moduleDocs ? `${moduleDocs}\n` : ''
  return {
    declarations: `${prefix}declare module '${specifier}' {\n${text}\n}`,
    exports,
    missing,
  }
}

/** 一段声明里引用到的类型名：类型引用、extends / implements 的基类型、typeof 的对象（限定名取最左边那段）。 */
function referencedTypeNames(node: ts.Node): string[] {
  const names: string[] = []
  const leftmost = (entity: ts.EntityName | ts.Expression): Optional<string> =>
    ts.isIdentifier(entity)
      ? entity.text
      : ts.isQualifiedName(entity)
        ? leftmost(entity.left)
        : ts.isPropertyAccessExpression(entity)
          ? leftmost(entity.expression)
          : undefined
  const visit = (child: ts.Node): void => {
    const entity = ts.isTypeReferenceNode(child)
      ? child.typeName
      : ts.isExpressionWithTypeArguments(child)
        ? child.expression
        : ts.isTypeQueryNode(child)
          ? child.exprName
          : undefined
    const referenced = entity ? leftmost(entity) : undefined
    if (referenced) names.push(referenced)
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return names
}

/**
 * 只查语法：交上来的这份与它 import 到的库里的脚本各解析一遍，再核对每个 import 都落得到。
 * 不查类型——字段名写错、入参形状不对，留给运行时当场报（能力的入参照样按 schema 校验）。
 * 行号就是模型写的那一行；出在库里别的脚本上的带着那个脚本的路径。
 */
export function diagnoseSyntax(
  input: {
    source: string
    declarations: string
    path?: string
    modules?: Readonly<Record<string, string>>
  },
  typescript: boolean
): CodeProgramDiagnostic[] {
  const { mainFile, files, problems } = readProgramFiles(input, typescript)
  const byName = new Map(files.map((file) => [file.fileName, file]))
  const host: ts.CompilerHost = {
    getSourceFile: (name) => byName.get(name),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => byName.has(name),
    readFile: (name) => byName.get(name)?.text,
  }
  // 只要语法诊断：不读标准库、不解析 import（上面已经按隔离里的规矩自己落过了），建程序只是为了拿到「这个语法只能在 TypeScript 里用」那一族
  const program = ts.createProgram(
    [...byName.keys()],
    { allowJs: true, noLib: true, noResolve: true, noEmit: true, target: ProgramTarget },
    host
  )
  return [
    ...files.flatMap((file) =>
      program.getSyntacticDiagnostics(file).map((diagnostic) => toDiagnostic(diagnostic, mainFile))
    ),
    ...problems.map(({ file, node, code, message }) =>
      located(file, node.getStart(file), code, message, mainFile)
    ),
  ]
}

/** 程序（连同它 import 到的库里的脚本）import 了哪些这一轮没有的能力模块：只回命名空间，按出现的顺序、不重复。 */
export function missingCapabilityModules(input: {
  source: string
  declarations: string
  path?: string
  modules?: Readonly<Record<string, string>>
}): string[] {
  return readProgramFiles(input, false).missing
}

/** TS8xxx 是「这个语法只能在 TypeScript 文件里用」那一族；只有整份诊断都落在这一族里才算手滑。 */
export function isTypeScriptOnlySyntax(code: number): boolean {
  return code >= 8000 && code < 8100
}

/**
 * 剥掉类型，交出能直接跑的 JavaScript。只走手滑这一条路。
 *
 * 常规路径不转译，所以行号天然对齐；这条路上编译器会重排版，行号对不上，
 * 因此运行期抛错时干脆不报位置——报一个错的位置比不报更坏。
 */
export function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ProgramTarget,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
    fileName: TypeScriptProgramFileName,
  }).outputText
}

/**
 * 代码模版的检查选项：模版是我们写的、会原样教给模型，所以照声明做完整类型检查。
 * 严格度与产品代码同档；`catch (e)` 在 JS 里没法写 `as Error`，自己的小函数不带类型也是常态，这两条放开。
 * 不让模版看见 @types/*：它只该用我们给的声明。
 */
const TemplateCheckOptions: ts.CompilerOptions = Object.freeze({
  target: ProgramTarget,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: true,
  checkJs: true,
  useUnknownInCatchVariables: false,
  noImplicitAny: false,
  types: [],
})

/** 照声明给一份代码模版做完整类型检查；模型交的程序不走这里。 */
export function typecheckTemplate(input: {
  source: string
  declarations: string
}): CodeProgramDiagnostic[] {
  const fileName = checkedProgramFile(undefined, false)
  const files = new Map([
    [DeclarationFileName, input.declarations],
    [fileName, input.source],
  ])
  const defaultHost = ts.createCompilerHost(TemplateCheckOptions, true)
  const program = ts.createProgram([DeclarationFileName, fileName], TemplateCheckOptions, {
    ...defaultHost,
    fileExists: (name) => files.has(name) || defaultHost.fileExists(name),
    readFile: (name) => files.get(name) ?? defaultHost.readFile(name),
    getSourceFile: (name, languageVersion, onError) => {
      const text = files.get(name)
      if (isUndefined(text)) return defaultHost.getSourceFile(name, languageVersion, onError)
      return ts.createSourceFile(name, text, languageVersion, true)
    },
    writeFile: () => {},
  })
  // 只留模版自己的诊断——声明是我们生成的，它有问题该在生成那一侧炸
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((diagnostic) => diagnostic.file?.fileName === fileName)
    .map((diagnostic) => toDiagnostic(diagnostic, fileName))
}

/** 只拒绝标准 output 已能证明的值/展示类型矛盾；未知值和普通能力参数仍由运行时校验。 */
export function diagnoseOutputTypes(
  input: {
    source: string
    declarations: string
    path?: string
    modules?: Readonly<Record<string, string>>
  },
  typescript: boolean
): CodeProgramDiagnostic[] {
  const parsed = readProgramFiles(input, typescript)
  // 没有标准模块导入时无需创建类型分析程序；自定义同名函数不属于此合同。
  if (
    !parsed.files.some((file) =>
      readModuleReferences(file).some(({ specifier }) => specifier.text === 'velaros')
    )
  )
    return []
  const files = new Map([
    [DeclarationFileName, input.declarations],
    ...parsed.files.map((file) => [file.fileName, file.text] as const),
  ])
  const options = { ...TemplateCheckOptions, noLib: true }
  // 模型源码的 reference 也只能落到本次虚拟文件；不继承默认宿主的磁盘读取与路径查询。
  const host: ts.CompilerHost = {
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    directoryExists: (name) =>
      [...files.keys()].some((file) => file.startsWith(name.endsWith('/') ? name : `${name}/`)),
    getSourceFile: (name, version) => {
      const text = files.get(name)
      return isUndefined(text)
        ? undefined
        : ts.createSourceFile(name, text, version, true, typescript ? ts.ScriptKind.TS : undefined)
    },
    getDefaultLibFileName: () => '/lib.d.ts',
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    writeFile: () => {},
  }
  const program = ts.createProgram([...files.keys()], options, host)
  const checker = program.getTypeChecker()
  const diagnostics: CodeProgramDiagnostic[] = []
  for (const name of files.keys()) {
    if (name === DeclarationFileName) continue
    const file = program.getSourceFile(name)!
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length >= 2 &&
        standardOutputBinding(node.expression, checker)
      ) {
        const options = node.arguments[1]!
        const kinds = outputDisplayKinds(options, checker)
        const requiresString =
          !isEmpty(kinds) && kinds.every((kind) => kind === 'text' || kind === 'code')
        const requiresList = !isEmpty(kinds) && kinds.every((kind) => kind === 'list')
        const value = node.arguments[0]!
        const values = outputExpressionLeaves(value, checker)
        const impossible =
          values &&
          values.every((leaf) =>
            requiresString
              ? !ts.isStringLiteralLike(leaf) && !ts.isTemplateExpression(leaf)
              : !ts.isArrayLiteralExpression(leaf)
          )
        if ((requiresString || requiresList) && impossible) {
          diagnostics.push(
            toDiagnostic(
              {
                category: ts.DiagnosticCategory.Error,
                code: 2345,
                file,
                start: value.getStart(file),
                length: value.getWidth(file),
                messageText: `输出值与声明类型不匹配：${requiresString ? 'text/code 要求字符串' : 'list 要求数组'}；对象或混合结果省略 type，或使用 type="json"。`,
              },
              parsed.mainFile
            )
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return diagnostics
}

/** 追踪真实导入及不可重赋值的别名，避免把局部同名函数当成标准 output。 */
function standardOutputBinding(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>()
): boolean {
  if (ts.isParenthesizedExpression(expression))
    return standardOutputBinding(expression.expression, checker, seen)
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'output') {
    const member = standardModuleOutput(expression.expression, checker)
    return !!member && standardOutputSymbol(member, checker, seen)
  }
  if (ts.isElementAccessExpression(expression)) {
    const key = expression.argumentExpression
    const member =
      ts.isStringLiteralLike(key) && key.text === 'output'
        ? standardModuleOutput(expression.expression, checker)
        : undefined
    return !!member && standardOutputSymbol(member, checker, seen)
  }
  const symbol = checker.getSymbolAtLocation(expression)
  return !!symbol && standardOutputSymbol(symbol, checker, seen)
}

/** 只认真实模块命名空间，避免把可变对象的同名属性误认成标准导出。 */
function standardModuleOutput(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>()
): Optional<ts.Symbol> {
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression))
    return standardModuleOutput(expression.expression, checker, seen)
  if (
    ts.isCallExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const specifier = expression.arguments[0]
    const module =
      specifier && ts.isStringLiteralLike(specifier) && specifier.text === 'velaros'
        ? checker.getSymbolAtLocation(specifier)
        : undefined
    return module
      ? checker.getExportsOfModule(module).find((symbol) => symbol.name === 'output')
      : undefined
  }
  if (!ts.isIdentifier(expression)) return undefined
  const symbol = checker.getSymbolAtLocation(expression)
  if (!symbol || seen.has(symbol) || seen.size >= CodeSurfaceTuning.outputProofNodes)
    return undefined
  seen.add(symbol)
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isNamespaceImport(declaration)) {
      const module = checker.getAliasedSymbol(symbol)
      return checker.getExportsOfModule(module).find((member) => member.name === 'output')
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    )
      return standardModuleOutput(declaration.initializer, checker, seen)
  }
  return undefined
}

/** 符号必须落到标准模块的 output 声明；const 解构只接受已证实的标准模块命名空间。 */
function standardOutputSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>
): boolean {
  if (seen.has(symbol) || seen.size >= CodeSurfaceTuning.outputProofNodes) return false
  seen.add(symbol)
  if (symbol.flags & ts.SymbolFlags.Alias)
    return standardOutputSymbol(checker.getAliasedSymbol(symbol), checker, seen)
  for (const declaration of symbol.declarations ?? []) {
    if (declaration.getSourceFile().fileName === DeclarationFileName && symbol.name === 'output') {
      for (let parent: ts.Node | undefined = declaration.parent; parent; parent = parent.parent)
        if (
          ts.isModuleDeclaration(parent) &&
          ts.isStringLiteral(parent.name) &&
          parent.name.text === 'velaros'
        )
          return true
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    )
      if (standardOutputBinding(declaration.initializer, checker, seen)) return true
    if (
      ts.isBindingElement(declaration) &&
      !declaration.dotDotDotToken &&
      !declaration.initializer &&
      ts.isObjectBindingPattern(declaration.parent)
    ) {
      const property = declaration.propertyName ?? declaration.name
      const variable = declaration.parent.parent
      if (
        (ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
        property.text === 'output' &&
        ts.isVariableDeclaration(variable) &&
        variable.initializer &&
        ts.isVariableDeclarationList(variable.parent) &&
        variable.parent.flags & ts.NodeFlags.Const
      ) {
        const member = standardModuleOutput(variable.initializer, checker)
        if (member && standardOutputSymbol(member, checker, seen)) return true
      }
    }
  }
  return false
}

/** 只读调用现场的普通属性；可变 options、getter、spread 与动态键仍由运行时核对。 */
function outputDisplayKinds(expression: ts.Expression, checker: ts.TypeChecker): string[] {
  if (ts.isParenthesizedExpression(expression))
    return outputDisplayKinds(expression.expression, checker)
  if (!ts.isObjectLiteralExpression(expression)) return []
  let value: Optional<ts.Expression>
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) return []
    if (
      property.name.getText() !== 'type' &&
      (!ts.isStringLiteral(property.name) || property.name.text !== 'type')
    )
      continue
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return []
    value = ts.isPropertyAssignment(property) ? property.initializer : property.name
  }
  if (!value) return []
  const leaves = outputExpressionLeaves(value, checker)
  return leaves?.every(ts.isStringLiteralLike) ? leaves.map((leaf) => leaf.text) : []
}

/** 仅凭表达式构造证明值的形状；const 可固定值身份，却不能固定其属性、数组元素或函数返回。 */
function outputExpressionLeaves(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  cache = new Map<ts.Expression, Optional<ts.Expression[]>>()
): Optional<ts.Expression[]> {
  // 共享 const 分支只分析一次；预置未知值同时阻断循环引用，不按路径指数复制叶子。
  if (cache.has(expression)) return cache.get(expression)
  if (cache.size >= CodeSurfaceTuning.outputProofNodes) return undefined
  cache.set(expression, undefined)
  const read = (): Optional<ts.Expression[]> => {
    if (ts.isParenthesizedExpression(expression))
      return outputExpressionLeaves(expression.expression, checker, cache)
    if (ts.isConditionalExpression(expression)) {
      const yes = outputExpressionLeaves(expression.whenTrue, checker, cache)
      const no = outputExpressionLeaves(expression.whenFalse, checker, cache)
      return yes && no ? [...new Set([...yes, ...no])] : undefined
    }
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression)
      if (!symbol) return undefined
      const declaration = symbol.valueDeclaration
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        !declaration.type &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const
      )
        return outputExpressionLeaves(declaration.initializer, checker, cache)
      return undefined
    }
    if (
      ts.isObjectLiteralExpression(expression) ||
      ts.isArrayLiteralExpression(expression) ||
      ts.isStringLiteralLike(expression) ||
      ts.isTemplateExpression(expression) ||
      ts.isNumericLiteral(expression) ||
      ts.isBigIntLiteral(expression) ||
      ts.isRegularExpressionLiteral(expression) ||
      ts.isArrowFunction(expression) ||
      ts.isFunctionExpression(expression) ||
      ts.isClassExpression(expression) ||
      [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
        expression.kind
      )
    )
      return [expression]
    return undefined
  }
  const leaves = read()
  cache.set(expression, leaves)
  return leaves
}

/**
 * 程序连同它 import 到的库里的脚本，各解析一遍；顺手核对每个 import，和 ES 模块链接时一样在执行之前报：
 * 能力模块要在这一轮的声明里、要的名字它得有；相对路径按隔离里的同一套规矩落到库里一份存在的脚本上。
 * 预检静态 import、re-export 与字面量 import()；Node 保留动态求值时机。missing 是落不到的能力模块的命名空间。
 */
function readProgramFiles(
  input: {
    source: string
    declarations: string
    path?: string
    modules?: Readonly<Record<string, string>>
  },
  typescript: boolean
): {
  mainFile: string
  files: ts.SourceFile[]
  problems: Array<{ file: ts.SourceFile; node: ts.Node; code: number; message: string }>
  missing: string[]
} {
  const declared = declaredModules(input.declarations)
  const modules = input.modules ?? {}
  const mainFile = checkedProgramFile(input.path, typescript)
  const files: ts.SourceFile[] = []
  const problems: Array<{ file: ts.SourceFile; node: ts.Node; code: number; message: string }> = []
  const missing: string[] = []
  const unresolved = (file: ts.SourceFile, node: ts.Node, message: string): void => {
    problems.push({ file, node, code: CodeSurfaceDiagnosticCodes.unresolvedModule, message })
  }
  const seen = new Set(isUndefined(input.path) ? [] : [input.path])
  const pending = [{ path: input.path, file: parseScript(mainFile, programForCheck(input.source)) }]
  for (let next = pending.shift(); next; next = pending.shift()) {
    const { path, file } = next
    files.push(file)
    for (const { node: statement, specifier } of readModuleReferences(file)) {
      if (!isRelativeSpecifier(specifier.text)) {
        const module = declared.get(specifier.text)
        if (module) {
          const names = ts.isCallExpression(statement) ? [] : importedNames(statement)
          for (const [node, name] of names)
            if (!module.open && !module.names.has(name))
              problems.push({
                file,
                node,
                code: CodeSurfaceDiagnosticCodes.missingExport,
                message: missingExportMessage(specifier.text, name, module.listed),
              })
          continue
        }
        unresolved(file, specifier, unresolvedMessage(specifier.text, null))
        const namespace = readCapabilityNamespace(specifier.text)
        if (isNotNull(namespace) && !missing.includes(namespace)) missing.push(namespace)
        continue
      }
      const target = resolveLibraryImport(path, specifier.text)
      if (isNull(target) || (target !== input.path && !Object.hasOwn(modules, target))) {
        unresolved(file, specifier, unresolvedMessage(specifier.text, target))
        continue
      }
      if (seen.has(target)) continue
      seen.add(target)
      pending.push({
        path: target,
        file: parseScript(`${LibraryRoot}/${target}`, modules[target] ?? ''),
      })
    }
  }
  return { mainFile, files, problems, missing }
}

/** import 或 re-export 从模块里要了哪些名字，连同写在哪；默认导入要的是 default，`* as` 什么都不要。 */
function importedNames(
  statement: ts.ImportDeclaration | ts.ExportDeclaration
): Array<[ts.Node, string]> {
  if (ts.isExportDeclaration(statement))
    return statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => [
          element,
          (element.propertyName ?? element.name).text,
        ])
      : []
  const clause = statement.importClause
  const names: Array<[ts.Node, string]> = clause?.name ? [[clause.name, 'default']] : []
  if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
    for (const element of clause.namedBindings.elements)
      names.push([element, (element.propertyName ?? element.name).text])
  return names
}

/** 一条声明语句声明了哪些名字。 */
function declaredNamesOf(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
    )
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name &&
    ts.isIdentifier(statement.name)
  )
    return [statement.name.text]
  return []
}

/** 解析一份脚本；后缀是 .ts 时按 TypeScript 解析（手滑那条路）。 */
function parseScript(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ProgramTarget,
    true,
    fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
}

/** import 落不到时说给模型的那句：相对路径说落到了库里哪儿，别的说这一轮能 import 什么。 */
function unresolvedMessage(specifier: string, target: Nullable<string>): string {
  if (isRelativeSpecifier(specifier))
    return isNull(target)
      ? `找不到模块 '${specifier}'：库里的脚本路径要落在库根之内、以 .js 结尾。`
      : `找不到模块 '${specifier}'：库里没有 ${target}。`
  return isNull(readCapabilityNamespace(specifier))
    ? `找不到模块 '${specifier}'：脚本只能 import velaros 的能力模块和库里的脚本（./ 或 ../ 开头）。`
    : `找不到模块 '${specifier}'：这一轮没有这个能力模块。`
}

/** 模块在、名字不在时说给模型的那句：连同它实际导出了什么。 */
function missingExportMessage(specifier: string, name: string, listed: readonly string[]): string {
  if (name === 'default')
    return `'${specifier}' 没有默认导出：用 import { 名字 } from '${specifier}' 或 import * as 名字 from '${specifier}'。`
  return listed.length === 0
    ? `'${specifier}' 没有导出 ${name}。`
    : `'${specifier}' 没有导出 ${name}；它导出 ${listed.join('、')}。`
}

/**
 * 把一条 TS 诊断换算成模型面的形状。
 *
 * **程序不包装**（它本来就是个模块），所以编译器给的 0 基行号要加一才是模型写的那一行。
 */
function toDiagnostic(diagnostic: ts.Diagnostic, mainFile: string): CodeProgramDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  const file = diagnostic.file
  if (!file || isUndefined(diagnostic.start))
    return { line: 1, column: 1, code: diagnostic.code, message }
  return located(file, diagnostic.start, diagnostic.code, message, mainFile)
}

/** 落在某份脚本某个位置上的一条诊断：行列号从 1 起，带上那一行的代码帧；不在交上来的这份上时带上它在库里的路径。 */
function located(
  file: ts.SourceFile,
  start: number,
  code: number,
  message: string,
  mainFile: string
): CodeProgramDiagnostic {
  const { line, character } = file.getLineAndCharacterOfPosition(start)
  const shaped: CodeProgramDiagnostic = {
    line: line + 1,
    column: character + 1,
    code,
    message,
    frame: renderDiagnosticFrame(file.text, line + 1, character + 1),
  }
  if (file.fileName !== mainFile) shaped.file = file.fileName.slice(LibraryRoot.length + 1)
  return shaped
}
