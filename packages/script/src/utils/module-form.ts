/** 静态读取模块依赖与导出形态；执行和链接由 QuickJS 原生模块系统负责。 */

import { posix } from 'node:path'

import ts from 'typescript'

import { isUndefined } from '@velaros-ai/core'

import type { CodeProgramRequest } from '../types/script.js'

import { ProgramFileName } from './program.js'
import { isRelativeSpecifier, resolveLibraryImport } from './refs.js'

/**
 * 当前 QuickJS 的 `export * as` 会暴露可写命名空间绑定；按 AST 转为经过独立桥模块的原生重导出。
 * 用户词法域不增加局部变量，direct eval 也观察不到桥内绑定；链接、live binding、循环与求值仍交给引擎。
 */
export function normalizeNamespaceReexports(
  source: string,
  path: string,
  modules: Readonly<Record<string, string>>
): { source: string; modules: Record<string, string> } {
  const normalized = { ...modules }
  const occupied = new Set([path, ...Object.keys(modules)])
  let serial = 0
  const rewrite = (body: string, importer: string): string => {
    const file = ts.createSourceFile(importer, body, ts.ScriptTarget.ES2022, true)
    let result = body
    for (const node of [...file.statements].reverse()) {
      if (
        !ts.isExportDeclaration(node) ||
        !node.exportClause ||
        !ts.isNamespaceExport(node.exportClause) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        continue
      const specifier = node.moduleSpecifier.text
      const target = isRelativeSpecifier(specifier)
        ? resolveLibraryImport(importer, specifier)
        : specifier
      // 可达模块已通过预检；不可达源码里的非法路径保留原样，不把它改成新的可访问路径。
      if (!target) continue
      let bridge: string
      do bridge = `_velaros_namespace_${serial++}.js`
      while (occupied.has(bridge))
      occupied.add(bridge)
      const bridgeTarget = isRelativeSpecifier(specifier) ? `./${target}` : target
      const attributes = node.attributes ? ` ${node.attributes.getText(file)}` : ''
      normalized[bridge] =
        `import * as value from ${JSON.stringify(bridgeTarget)}${attributes}; export { value as default };`
      const relative = posix.relative(posix.dirname(importer), bridge)
      const reference = isRelativeSpecifier(relative) ? relative : `./${relative}`
      const replacement = `export { default as ${node.exportClause.name.getText(file)} } from ${JSON.stringify(reference)};`
      result =
        result.slice(0, node.getStart(file)) +
        replacement +
        '\n'.repeat(node.getText(file).split('\n').length - 1) +
        result.slice(node.end)
    }
    return result
  }
  for (const [modulePath, text] of Object.entries(modules))
    normalized[modulePath] = rewrite(text, modulePath)
  return { source: rewrite(source, path), modules: normalized }
}

/**
 * 程序有没有具名导出（`export const x`、`export function f`、`export { a }`，不算 `export default`）。
 * 有的话交回来的是 `{ default?, 名字: 值… }`，回执按名字分开给模型看；语法错的程序当没有。
 */
export function hasNamedExports(source: string): boolean {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  return file.statements.some((statement) => {
    if (ts.isExportDeclaration(statement))
      return Boolean(statement.exportClause) || Boolean(statement.moduleSpecifier)
    if (ts.isExportAssignment(statement)) return false
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
    return (
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    )
  })
}

/**
 * 程序里静态 import、re-export 与字面量 import() 的模块名，按出现的顺序、不重复。
 * 只收集依赖，不提升动态 import 的求值时机；计算出的目标仍由运行时授权表核对。
 * 语法错的程序挖出多少算多少，不抛。
 */
export function readModuleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  const specifiers: string[] = []
  for (const { specifier } of readModuleReferences(file))
    if (!specifiers.includes(specifier.text)) specifiers.push(specifier.text)
  return specifiers
}

/** 和检查器一样沿入口与相对 import 遍历可达源码；不把未导入的附属源码当作依赖。 */
export function readProgramModuleSpecifiers(program: CodeProgramRequest): string[] {
  const found = new Set<string>()
  const seen = new Set<string>()
  const pending: Array<{ path?: string; source: string }> = [
    { path: program.path, source: program.source },
  ]
  if (program.path) seen.add(program.path)
  for (let next = pending.shift(); next; next = pending.shift()) {
    for (const specifier of readModuleSpecifiers(next.source)) {
      if (!isRelativeSpecifier(specifier)) {
        found.add(specifier)
        continue
      }
      const target = resolveLibraryImport(next.path, specifier)
      if (!target || seen.has(target)) continue
      seen.add(target)
      const source = target === program.path ? program.source : program.modules?.[target]
      if (!isUndefined(source)) pending.push({ path: target, source })
    }
  }
  return [...found]
}

/** 按 AST 位置读取可预检的模块引用，包含嵌套函数与未执行分支里的字面量动态导入。 */
export function readModuleReferences(file: ts.SourceFile): Array<{
  node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression
  specifier: ts.StringLiteralLike
}> {
  const references: ReturnType<typeof readModuleReferences> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
        references.push({ node, specifier: node.moduleSpecifier })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      let argument = node.arguments[0]
      while (argument && ts.isParenthesizedExpression(argument)) argument = argument.expression
      if (argument && ts.isStringLiteralLike(argument))
        references.push({ node, specifier: argument })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return references
}
