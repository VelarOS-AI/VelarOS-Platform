import nodePath from 'node:path'

import { pythonLanguage } from '@codemirror/lang-python'

import { isEmpty, toNullable } from '@velaros-ai/core'

import type { LanguageImportRecord } from '../../types/language.js'
import type { PythonImportGroup, PythonSyntaxNode } from '../../types/syntax.js'

import { compactStatement, normalizeSourcePath } from './source-files.js'

/** 节点覆盖的原文压成一行，按摘录上限截断。 */
export function compactStatementOfNode(content: string, node: PythonSyntaxNode): string {
  return compactStatement(content.slice(node.from, node.to))
}

/** 偏移换算成行列，从 1 起。 */
export function toLineColumn(content: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, content.length))
  const prefix = content.slice(0, safeOffset)
  const lastNewline = prefix.lastIndexOf('\n')
  return {
    line: prefix.split('\n').length,
    column: lastNewline === -1 ? safeOffset + 1 : safeOffset - lastNewline,
  }
}

/** 把一份正文解析成 Python 语法树的根节点。 */
export function parsePythonSource(content: string): PythonSyntaxNode {
  return pythonLanguage.parser.parse(content).topNode
}

/** 一个节点的直接子节点。 */
export function childrenOf(node: PythonSyntaxNode): PythonSyntaxNode[] {
  const children: PythonSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

/** 第一个叫这个名字的直接子节点。 */
function findChild(node: PythonSyntaxNode, name: string): Nullable<PythonSyntaxNode> {
  return toNullable(childrenOf(node).find((child) => child.name === name))
}

/** 子树里所有叫这个名字的节点。 */
function collectDescendants(node: PythonSyntaxNode, name: string): PythonSyntaxNode[] {
  const matches: PythonSyntaxNode[] = []
  const visit = (current: PythonSyntaxNode): void => {
    if (current.name === name) matches.push(current)
    for (const child of childrenOf(current)) visit(child)
  }
  visit(node)
  return matches
}

/** 节点覆盖的原文。 */
export function nodeText(content: string, node: PythonSyntaxNode): string {
  return content.slice(node.from, node.to)
}

/** 节点起始处的行列，从 1 起。 */
export function nodePosition(
  content: string,
  node: PythonSyntaxNode
): { line: number; column: number } {
  return toLineColumn(content, node.from)
}

/** 剥掉前缀与引号，取 Python 字符串字面量的值；不是字面量给 null。 */
function pythonStringLiteralValue(raw: string): Nullable<string> {
  const trimmed = raw.trim().replace(/^[rRuUbBfF]+/u, '')
  for (const quote of ['"""', "'''", '"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote))
      return trimmed.slice(quote.length, -quote.length)
  }
  return null
}

/** 模块顶层 `__all__` 里列的名字；没写 `__all__` 就给 null（此时按下划线约定判导出）。 */
function parseAllNames(content: string): Nullable<Set<string>> {
  const root = parsePythonSource(content)
  const names: string[] = []

  for (const node of childrenOf(root)) {
    if (node.name !== 'AssignStatement') continue
    const target = findChild(node, 'VariableName')
    if (!target || nodeText(content, target) !== '__all__') continue
    for (const stringNode of collectDescendants(node, 'String')) {
      const value = pythonStringLiteralValue(nodeText(content, stringNode))
      if (value) names.push(value)
    }
  }

  return !isEmpty(names) ? new Set(names) : null
}

/** 解析一个文件里的顶层类、函数、方法与变量；导出与否按 `__all__`，没有就按下划线约定。 */
export function parsePythonSymbols(
  content: string,
  push: (
    node: PythonSyntaxNode,
    name: string,
    kind: string,
    exported: boolean,
    container?: string
  ) => void
): void {
  const allNames = parseAllNames(content)
  const root = parsePythonSource(content)
  const isExported = (name: string, container?: string): boolean =>
    allNames ? allNames.has(name) : !container && !name.startsWith('_')

  const handleFunction = (node: PythonSyntaxNode, container?: string): void => {
    const nameNode = findChild(node, 'VariableName')
    if (!nameNode) return
    const name = nodeText(content, nameNode)
    push(node, name, container ? 'method' : 'function', isExported(name, container), container)
  }

  const handleClass = (node: PythonSyntaxNode): void => {
    const nameNode = findChild(node, 'VariableName')
    if (!nameNode) return
    const name = nodeText(content, nameNode)
    push(node, name, 'class', isExported(name))

    const body = findChild(node, 'Body')
    if (!body) return
    for (const child of childrenOf(body)) {
      if (child.name === 'FunctionDefinition') handleFunction(child, name)
    }
  }

  for (const node of childrenOf(root)) {
    if (node.name === 'ClassDefinition') {
      handleClass(node)
    } else if (node.name === 'FunctionDefinition') {
      handleFunction(node)
    } else if (node.name === 'AssignStatement') {
      const target = findChild(node, 'VariableName')
      if (!target) continue
      const name = nodeText(content, target)
      if (name === '__all__') continue
      push(node, name, 'variable', isExported(name))
    }
  }
}

/** import 语句里一个词的原文（去空白）。 */
function importTokenText(content: string, token: PythonSyntaxNode): string {
  return nodeText(content, token).trim()
}

/** 按逗号把 import 词表切成一组一组，括号忽略。 */
function splitImportGroups(content: string, tokens: PythonSyntaxNode[]): PythonSyntaxNode[][] {
  const groups: PythonSyntaxNode[][] = []
  let current: PythonSyntaxNode[] = []
  for (const token of tokens) {
    const text = importTokenText(content, token)
    if (text === '(' || text === ')') continue
    if (text === ',') {
      if (!isEmpty(current)) groups.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (!isEmpty(current)) groups.push(current)
  return groups
}

/** 把一串词拼成紧凑的模块说明符。 */
function compactImportSpecifier(content: string, tokens: PythonSyntaxNode[]): string {
  return tokens
    .map((token) => importTokenText(content, token))
    .join('')
    .replace(/\s+/gu, '')
}

/** 一组词解析成「说明符 + 引进来的名字」；说明符为空就给 null。 */
function importGroupFromTokens(
  content: string,
  group: PythonSyntaxNode[]
): Nullable<PythonImportGroup> {
  const asIndex = group.findIndex((token) => importTokenText(content, token) === 'as')
  const specifierTokens = asIndex === -1 ? group : group.slice(0, asIndex)
  const aliasToken =
    asIndex === -1
      ? null
      : toNullable(group.slice(asIndex + 1).find((token) => token.name === 'VariableName'))
  const specifier = compactImportSpecifier(content, specifierTokens)
  if (!specifier) return null
  const lastName = toNullable(
    [...specifierTokens].reverse().find((token) => token.name === 'VariableName')
  )
  return {
    specifier,
    importedName: aliasToken
      ? nodeText(content, aliasToken)
      : lastName
        ? nodeText(content, lastName)
        : specifier,
  }
}

/** 解析一个文件里全部的 `import x` 与 `from m import x`。 */
export function parsePythonImports(
  content: string,
  push: (
    node: PythonSyntaxNode,
    kind: LanguageImportRecord['kind'],
    specifier: string,
    importedNames: string[]
  ) => void
): void {
  const root = parsePythonSource(content)

  const handleImport = (node: PythonSyntaxNode): void => {
    const children = childrenOf(node)
    const firstToken = children[0] ? importTokenText(content, children[0]) : ''
    const importIndex = children.findIndex((child) => importTokenText(content, child) === 'import')

    if (firstToken === 'from' && importIndex > 0) {
      const specifier = compactImportSpecifier(content, children.slice(1, importIndex))
      const importedNames = splitImportGroups(content, children.slice(importIndex + 1))
        .map((group) => importGroupFromTokens(content, group)?.importedName ?? '')
        .filter(Boolean)
      if (!specifier) return
      push(node, 'from-import', specifier, importedNames)
      return
    }

    if (firstToken === 'import') {
      for (const group of splitImportGroups(content, children.slice(1))) {
        const parsed = importGroupFromTokens(content, group)
        if (!parsed) continue
        push(node, 'import', parsed.specifier, [parsed.importedName])
      }
    }
  }

  const visit = (node: PythonSyntaxNode): void => {
    if (node.name === 'ImportStatement') {
      handleImport(node)
      return
    }
    for (const child of childrenOf(node)) visit(child)
  }

  visit(root)
}

/** 去掉 `.py` / `.pyi` 与 `__init__`，用来做「同一个模块的不同写法」比较。 */
function stripPythonExtension(path: string): string {
  return normalizeSourcePath(path).replace(/(?:\.pyi?|\/__init__\.pyi?)$/iu, '')
}

/** 一条说明符可能指向的模块文件写法（绝对与相对各按 Python 的点号规则展开）。 */
function pythonBaseCandidates(importerPath: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) {
    const base = specifier.replace(/\./gu, '/')
    return [base, `${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`]
  }

  const dots = specifier.match(/^\.+/u)?.[0].length ?? 0
  const rest = specifier.slice(dots).replace(/\./gu, '/')
  let baseDir = nodePath.posix.dirname(importerPath)
  for (let index = 1; index < dots; index += 1) {
    baseDir = nodePath.posix.dirname(baseDir)
  }
  const base = rest
    ? normalizeSourcePath(nodePath.posix.join(baseDir, rest))
    : normalizeSourcePath(baseDir)
  return [base, `${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`]
}

/** 一条引入语句可能指向的全部文件；`from m import x` 还要算上 `m/x.py` 这种子模块写法。 */
export function pythonImportTargetCandidates(record: LanguageImportRecord): string[] {
  const baseCandidates = pythonBaseCandidates(record.path, record.specifier)
  const nestedCandidates =
    record.kind === 'from-import'
      ? record.importedNames.flatMap((name) =>
          baseCandidates.flatMap((base) => [
            normalizeSourcePath(nodePath.posix.join(stripPythonExtension(base), `${name}.py`)),
            normalizeSourcePath(
              nodePath.posix.join(stripPythonExtension(base), name, '__init__.py')
            ),
          ])
        )
      : []
  return [...new Set([...baseCandidates, ...nestedCandidates].map(normalizeSourcePath))]
}

/** 这条引入语句是不是指向调用方要找的目标。 */
export function pythonImportMatchesTarget(
  record: LanguageImportRecord,
  input: { specifier?: string; targetPath?: string },
  fileSet: Set<string>
): boolean {
  if (input.specifier && record.specifier === input.specifier) return true
  if (!input.targetPath) return false

  const target = normalizeSourcePath(input.targetPath)
  return pythonImportTargetCandidates(record).some(
    (candidate) =>
      fileSet.has(candidate) &&
      (candidate === target || stripPythonExtension(candidate) === stripPythonExtension(target))
  )
}
