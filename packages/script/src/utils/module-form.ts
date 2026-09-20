/**
 * 模块形态的几件活：读取 `import` 依赖，以及把模块改写成隔离里能跑的那段。
 *
 * 模型写的是真 ES 模块（`import` 拿能力与库里的脚本、顶层 `await`、用 `export` 交出要看的东西）。
 * 隔离里用 `new Function` 跑，那里没有模块系统，所以进去之前做一次**形状明确的改写**：
 * `import { read } from 'velaros:files'` → `const { read } = __velaros('velaros:files')`，
 * `import { parse } from './lib/x.js'` → `const { parse } = await __import('lib/x.js')`，
 * `export default X` → `__exports.default = X`。
 * 改写按 AST 定位再按文本切片替换，**行数一个不变**——否则抛错的行号就对不上模型写的那一行。
 */

import ts from 'typescript'

import { isNull, isTrue } from '@velaros-ai/core'

import type { ProgramRewrite } from '../types/module-form.js'

import { ProgramFileName } from './program.js'
import { isRelativeSpecifier, resolveLibraryImport } from './refs.js'

/**
 * 程序有没有具名导出（`export const x`、`export function f`、`export { a }`，不算 `export default`）。
 * 有的话交回来的是 `{ default?, 名字: 值… }`，回执按名字分开给模型看；语法错的程序当没有。
 */
export function hasNamedExports(source: string): boolean {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  return file.statements.some((statement) => {
    if (ts.isExportDeclaration(statement)) return Boolean(statement.exportClause) || Boolean(statement.moduleSpecifier)
    if (ts.isExportAssignment(statement)) return false
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : []
    return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  })
}

/**
 * 程序里静态 import 与 re-export 的全部模块名，按出现的顺序、不重复：能力模块（`velaros:files`）与库里的脚本（`./lib/x.js`）都在里面。
 * 语法错的程序挖出多少算多少，不抛。
 */
export function readModuleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  const specifiers: string[] = []
  for (const statement of file.statements) {
    const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined
    if (specifier && ts.isStringLiteral(specifier) && !specifiers.includes(specifier.text)) specifiers.push(specifier.text)
  }
  return specifiers
}

/** 取一个模块的那段表达式：能力模块同步取桩，库里的脚本要等它跑完（它自己也可能有顶层 await）。 */
function loadExpression(specifier: string, importer: Optional<string>): string {
  if (!isRelativeSpecifier(specifier)) return `__velaros(${JSON.stringify(specifier)})`
  return `(await __import(${JSON.stringify(resolveLibraryImport(importer, specifier) ?? specifier)}))`
}

/** 换上去的文本补足换行，和原文行数一样：原文跨了几行，换完还占几行，后面每一行的行号都不挪。 */
function keepLineCount(original: string, replacement: string): string {
  const missing = original.split('\n').length - replacement.split('\n').length
  return missing > 0 ? `${replacement}${'\n'.repeat(missing)}` : replacement
}

/** 把 import 的绑定写成解构：`{ read, write as w }` 或 `* as system` 或 `x`（默认导入取 default）；没有绑定时只取一下模块（副作用 import）。 */
function bindingFor(clause: Optional<ts.ImportClause>, load: string): string {
  if (!clause) return load
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) return `const ${bindings.name.text} = ${load}`
  const names: string[] = []
  if (clause.name) names.push(`default: ${clause.name.text}`)
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      names.push(element.propertyName ? `${element.propertyName.text}: ${element.name.text}` : element.name.text)
    }
  }
  return `const { ${names.join(', ')} } = ${load}`
}

/**
 * 把程序改写成隔离里能跑的函数体：隔离里没有模块系统。
 *
 * - `import { x } from 'velaros:ns'` → `const { x } = __velaros("velaros:ns");`
 * - `import { x } from './lib/a.js'` → `const { x } = (await __import("lib/a.js"));`：路径从 importer 所在的目录算（直接跑的代码从库根算）
 * - `export default X` → `__exports.default = X;`（**不是** return：ES 里 export default 不中断执行）
 * - `export const / let / var / function / class` → 去掉 `export`，末尾补一句登记
 * - `export { a, b as c }` → 删掉这句，末尾补登记；`export { a } from '…'`、`export * from '…'`、`export * as n from '…'` 就地取出来，末尾补登记
 * - 末尾交出：库里的脚本（library 为真）总是交整个导出对象，给 import 它的人取；直接跑的程序只有 default 就交 default，
 *   有具名导出就交 `{ default?, ...具名 }`，跟 `import * as m` 拿到的形状一样；什么都没导出就是 undefined。
 *
 * **行数一个不变**：改写都落在原来那几行里（跨行的语句换完补足换行），补的登记接在最后一行后面——
 * 否则抛错的行号就对不上模型写的那一行。
 */
export function rewriteModuleForIsolate(source: string, options: { importer?: string; library?: boolean } = {}): string {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  const rewrites: ProgramRewrite[] = []
  const exported: Array<{ name: string; local: string }> = []
  const spreads: string[] = []
  const textOf = (node: ts.Node): string => source.slice(node.getStart(file), node.getEnd())
  const replace = (node: ts.Node, text: string): void => {
    rewrites.push({ start: node.getStart(file), end: node.getEnd(), text: keepLineCount(textOf(node), text) })
  }

  for (const [index, statement] of file.statements.entries()) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      replace(statement, `${bindingFor(statement.importClause, loadExpression(statement.moduleSpecifier.text, options.importer))};`)
      continue
    }
    if (ts.isExportAssignment(statement) && !isTrue(statement.isExportEquals)) {
      replace(statement, `__exports.default = ${textOf(statement.expression)};`)
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      // 从别的模块转出去的：就地取出来放进一个局部名字，末尾和别的具名导出一起登记。
      const holder = `__reexport${index}`
      replace(statement, `const ${holder} = ${loadExpression(statement.moduleSpecifier.text, options.importer)};`)
      const clause = statement.exportClause
      if (!clause) spreads.push(holder)
      else if (ts.isNamespaceExport(clause)) exported.push({ name: clause.name.text, local: holder })
      else for (const element of clause.elements) exported.push({ name: element.name.text, local: `${holder}[${JSON.stringify((element.propertyName ?? element.name).text)}]` })
      continue
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exported.push({ name: element.name.text, local: (element.propertyName ?? element.name).getText(file) })
      }
      replace(statement, '')
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
  // `export *` 不转 default，和 ES 模块一样。
  const spread = spreads.map((holder) => `for (const [name, value] of Object.entries(${holder})) if (name !== 'default') __exports[name] = value;`)
  const registrations = [...spread, ...exported.map(({ name, local }) => `__exports[${JSON.stringify(name)}] = ${local};`)].join(' ')
  const handOver = isTrue(options.library)
    ? 'return __exports;'
    : "return ((exports) => { const names = Object.keys(exports); return names.length === 0 ? undefined : names.length === 1 && names[0] === 'default' ? exports.default : exports })(__exports);"
  // 开头那句接在第一行前面、结尾那句另起一行接在最后：两处都不改变模型写的那些行的行号。
  return `const __exports = {}; ${output}\n${registrations} ${handOver}`
}

/** 一个声明左边绑定出来的全部名字：`const { a, b: [c] } = …` 得到 a、c。 */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))
}
