/** 准确语法树只负责定位；保留原始文本，不经 AST 重打印。 */
import * as ts from 'typescript'

import { isEmpty } from '@velaros-ai/core'

import type { ProjectStructureSpan } from '../../types/selection.js'
import type { JsTsParsedSource, PythonSyntaxNode } from '../../types/syntax.js'
import { ProjectError } from '../errors.js'
import { parseJsTsSource } from '../language/jsts-syntax.js'
import { childrenOf, nodeText, parsePythonSource } from '../language/python-syntax.js'

/** 声明独占一行时收进缩进和行尾换行；同行其他代码仍留在目标外。 */
function blockSpan(content: string, start: number, end: number): { start: number; end: number } {
  let first = start
  let last = end
  const lineStart = content.lastIndexOf('\n', start - 1) + 1
  if (/^[\t ]*$/u.test(content.slice(lineStart, start))) first = lineStart
  // Python 节点已包含末行换行；不能再把下一行的空白分隔符收入结构块。
  if (content[end - 1] !== '\n') {
    const newline = content.indexOf('\n', end)
    const lineEnd = newline < 0 ? content.length : newline
    if (/^[\t \r]*$/u.test(content.slice(end, lineEnd))) last = newline < 0 ? lineEnd : newline + 1
  }
  return { start: first, end: last }
}

/** JS/TS 的完整限定声明名；嵌套函数和重载各保留自己的边界。 */
function jsTsStructures(path: string, content: string): ProjectStructureSpan[] {
  const root = parseJsTsSource(path, content) as JsTsParsedSource
  if (!isEmpty(root.parseDiagnostics))
    throw new ProjectError(
      'NOT_SUPPORTED',
      '源码有语法错误，不能绑定结构边界；请先用 match 或 read 的文本目标修复。'
    )
  const result: ProjectStructureSpan[] = []
  const visit = (node: ts.Node, parents: string[]): void => {
    let name: string | undefined
    let selected = node
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyDeclaration(node)
    )
      name = node.name?.getText(root)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text
      if (
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.declarations.length === 1 &&
        ts.isVariableStatement(node.parent.parent)
      )
        selected = node.parent.parent
    }
    if (name)
      result.push({
        name: [...parents, name].join('.'),
        ...blockSpan(content, selected.getStart(root, true), selected.end),
      })
    ts.forEachChild(node, (child) => visit(child, name ? [...parents, name] : parents))
  }
  visit(root, [])
  return result
}

/** Python 的函数、类、嵌套函数和带装饰器声明；解析错误不授予结构目标。 */
function pythonStructures(content: string): ProjectStructureSpan[] {
  const root = parsePythonSource(content)
  const result: ProjectStructureSpan[] = []
  const visit = (node: PythonSyntaxNode, parents: string[], decorated?: PythonSyntaxNode): void => {
    if (node.name === '⚠')
      throw new ProjectError(
        'NOT_SUPPORTED',
        'Python 源码有语法错误，不能绑定结构边界；请用 match 或 read 的文本目标修复。'
      )
    if (node.name === 'DecoratedStatement') {
      for (const child of childrenOf(node)) visit(child, parents, node)
      return
    }
    const declaration = node.name === 'FunctionDefinition' || node.name === 'ClassDefinition'
    const nameNode = declaration
      ? childrenOf(node).find((child) => child.name === 'VariableName')
      : undefined
    const name = nameNode ? nodeText(content, nameNode) : undefined
    if (name)
      result.push({
        name: [...parents, name].join('.'),
        ...blockSpan(content, decorated?.from ?? node.from, decorated?.to ?? node.to),
      })
    for (const child of childrenOf(node)) visit(child, name ? [...parents, name] : parents)
  }
  visit(root, [])
  return result
}

/** 只使用已存在、坐标为 UTF-16 的内置解析器；其他语言明确转向文本选区。 */
export function projectStructureSpans(path: string, content: string): ProjectStructureSpan[] {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(path)) return jsTsStructures(path, content)
  if (/\.pyi?$/iu.test(path)) return pythonStructures(content)
  throw new ProjectError(
    'NOT_SUPPORTED',
    '这个文件没有可靠结构定位后端；请用 match 或 read 返回的文本目标。'
  )
}
