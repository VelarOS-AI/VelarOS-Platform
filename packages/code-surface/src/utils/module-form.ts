/**
 * 模块形态的两件活：把 `import` 与租约挖出来，以及把模块改写成隔离里能跑的那段。
 *
 * 模型写的是真 ES 模块（`import` 拿能力、顶层 `await`、`export default` 交答案）。
 * 隔离里用 `new Function` 跑，那里没有模块系统，所以进去之前做一次**形状明确的改写**：
 * `import { read } from 'velar:system'` → `const { read } = __velar('velar:system')`，
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
 * 把模块改写成隔离里能跑的函数体。
 *
 * **行数必须一个不变**：改写后的每条语句仍占原来那一行，抛错时栈里的行号才对得上模型写的那一行。
 * 所以只做同行替换，不插入也不删除换行。
 */
export function rewriteModuleForIsolate(source: string): string {
  const file = ts.createSourceFile(ProgramFileName, source, ts.ScriptTarget.ES2022, true)
  const rewrites: ProgramRewrite[] = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      rewrites.push({
        start: statement.getStart(file),
        end: statement.getEnd(),
        text: `${bindingFor(statement.importClause, statement.moduleSpecifier.text)};`,
      })
      continue
    }
    if (ts.isExportAssignment(statement) && !isTrue(statement.isExportEquals)) {
      rewrites.push({
        start: statement.getStart(file),
        end: statement.getEnd(),
        text: `return ${source.slice(statement.expression.getStart(file), statement.expression.getEnd())};`,
      })
    }
  }

  let output = source
  for (const rewrite of [...rewrites].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, rewrite.start) + rewrite.text + output.slice(rewrite.end)
  }
  return output
}
