/**
 * 模块形态的两件活：把 `import` 与租约挖出来，以及把模块改写成隔离里能跑的那段。
 *
 * 模型写的是真 ES 模块（`import` 拿能力、顶层 `await`、`export default` 交答案）。
 * 隔离里用 `new Function` 跑，那里没有模块系统，所以进去之前做一次**形状明确的改写**：
 * `import { read } from 'velar:files'` → `const { read } = __velar('velar:files')`，
 * `export default X` → `return X`。
 * 改写只动这两种语句、按 AST 定位再按文本切片替换，**行数一个不变**——否则抛错的行号就对不上模型写的那一行。
 */

import ts from 'typescript'

import { isNull, isTrue } from '@velaros-ai/core'

import type { CapabilityLease, ProgramImport } from '../types/code-surface.js'
import type { ProgramRewrite } from '../types/module-form.js'

import { ProgramFileName, ProgramModuleSpecifier, readCapabilityNamespace } from './program.js'

/** 租约的三档：意图，不是期限。不认的值当没写，宿主按缺省策略处理。 */
const LeaseValues = new Set<CapabilityLease>(['once', 'task', 'done'])

/** 取一条 import 上的租约意图；没写、或者写了个认不出的值，都返回 undefined（不为一个拼错的字废掉一轮）。 */
function readLease(node: ts.ImportDeclaration): Optional<CapabilityLease> {
  for (const element of node.attributes?.elements ?? []) {
    const name = ts.isIdentifier(element.name) || ts.isStringLiteral(element.name) ? element.name.text : ''
    if (name !== 'lease' || !ts.isStringLiteral(element.value)) continue
    const value = element.value.text as CapabilityLease
    if (LeaseValues.has(value)) return value
  }
  return undefined
}

/**
 * 挖出程序里 import 了哪些能力模块、各自的租约。
 *
 * 语法错的程序挖不出东西——那不要紧，它在 typecheck 那一关本来就过不去；
 * 这里只保证不抛。
 */
export function readProgramImports(source: string): ProgramImport[] {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  const imports: ProgramImport[] = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    // `velar:program` 恒常授权、不参与租约与回收，报给宿主只是噪声。
    if (statement.moduleSpecifier.text === ProgramModuleSpecifier) continue
    const namespace = readCapabilityNamespace(statement.moduleSpecifier.text)
    if (isNull(namespace)) continue
    const lease = readLease(statement)
    const entry: ProgramImport = { namespace, specifier: statement.moduleSpecifier.text }
    if (lease) entry.lease = lease
    imports.push(entry)
  }
  return imports
}

/** 把 import 的绑定写成解构：`{ read, write as w }` 或 `* as system` 或 `system`（默认导入当命名空间用）。 */
function bindingFor(clause: Optional<ts.ImportClause>, specifier: string): string {
  if (!clause) return `__velar(${JSON.stringify(specifier)})`
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) return `const ${bindings.name.text} = __velar(${JSON.stringify(specifier)})`
  const names: string[] = []
  if (clause.name) names.push(`default: ${clause.name.text}`)
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      names.push(element.propertyName ? `${element.propertyName.text}: ${element.name.text}` : element.name.text)
    }
  }
  return `const { ${names.join(', ')} } = __velar(${JSON.stringify(specifier)})`
}

/**
 * 把程序改写成隔离里能跑的函数体：隔离里没有模块系统。
 *
 * - `import { x } from 'velar:ns'` → `const { x } = __velar("velar:ns");`
 * - `export default X` → `__exports.default = X;`（**不是** return：ES 里 export default 不中断执行）
 * - `export const / let / var / function / class` → 去掉 `export`，末尾补一句登记
 * - `export { a, b as c }` → 删掉这句，末尾补登记
 * - 末尾统一交出：只有 default 就交 default；有具名导出就交 `{ default?, ...具名 }`，
 *   跟 `import * as m` 拿到的形状一样；什么都没导出就是 undefined。
 *
 * **行数一个不变**：改写都落在原来那一行里，补的登记接在最后一行后面——
 * 否则抛错的行号就对不上模型写的那一行。
 */
export function rewriteModuleForIsolate(source: string): string {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  const rewrites: ProgramRewrite[] = []
  const exported: Array<{ name: string; local: string }> = []
  const textOf = (node: ts.Node): string => source.slice(node.getStart(file), node.getEnd())

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      rewrites.push({ start: statement.getStart(file), end: statement.getEnd(), text: `${bindingFor(statement.importClause, statement.moduleSpecifier.text)};` })
      continue
    }
    if (ts.isExportAssignment(statement) && !isTrue(statement.isExportEquals)) {
      rewrites.push({ start: statement.getStart(file), end: statement.getEnd(), text: `__exports.default = ${textOf(statement.expression)};` })
      continue
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exported.push({ name: element.name.text, local: (element.propertyName ?? element.name).getText(file) })
      }
      rewrites.push({ start: statement.getStart(file), end: statement.getEnd(), text: '' })
      continue
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : []
    const exportKeyword = modifiers.find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exportKeyword) continue
    const defaultKeyword = modifiers.find((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    if (defaultKeyword) {
      // export default function / class：变成一个赋值表达式
      rewrites.push({ start: exportKeyword.getStart(file), end: defaultKeyword.getEnd(), text: '__exports.default =' })
      continue
    }
    // 其余的具名导出：把 export 换成等长空白，列号也不挪
    rewrites.push({ start: exportKeyword.getStart(file), end: exportKeyword.getEnd(), text: ' '.repeat(exportKeyword.getEnd() - exportKeyword.getStart(file)) })
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) exported.push({ name, local: name })
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      exported.push({ name: statement.name.text, local: statement.name.text })
    }
  }

  let output = source
  for (const rewrite of [...rewrites].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, rewrite.start) + rewrite.text + output.slice(rewrite.end)
  }
  const registrations = exported.map(({ name, local }) => `__exports[${JSON.stringify(name)}] = ${local};`).join(' ')
  // 开头那句接在第一行前面、结尾那句另起一行接在最后：两处都不改变模型写的那些行的行号。
  return `const __exports = {}; ${output}\n${registrations} return ((exports) => { const names = Object.keys(exports); return names.length === 0 ? undefined : names.length === 1 && names[0] === 'default' ? exports.default : exports })(__exports);`
}

/** 一个声明左边绑定出来的全部名字：`const { a, b: [c] } = …` 得到 a、c。 */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))
}
