import nodePath from 'node:path'

import { pythonLanguage } from '@codemirror/lang-python'
import { isEmpty, isFalse, isPresent, toNullable } from '@velaros-ai/core'

import type {
  FindImportersInput,
  FindImportsInput,
  FindReferencesInput,
  FindSymbolsInput,
  LanguageExportResult,
  LanguageImporterResult,
  LanguageImportRecord,
  LanguageImportResult,
  LanguageNavigationService,
  LanguageReferenceRecord,
  LanguageReferenceResult,
  LanguageSymbolRecord,
  LanguageSymbolResult,
  LanguageToolContext,
  ListExportsInput,
} from './LanguageService'
// 语言服务共享文件发现、读取与扫描基础设施；本模块只实现 Python 语义。
import {
  collectSourceFiles,
  compactStatement,
  DefaultNavigationLimit,
  lineAt,
  normalizeSourcePath as normalizePath,
  readSourceFile,
  scanImporters,
  scanReferences,
  type SourceFileSelection as FileSelection,
} from './LanguageService'

const DefaultPythonExtensions = ['py', 'pyi'] as const

function collectPythonFiles(
  ctx: LanguageToolContext,
  input: FileSelection
): Promise<{ files: string[]; truncated: boolean }> {
  return collectSourceFiles(ctx, input, DefaultPythonExtensions)
}
const DefaultLimit = DefaultNavigationLimit

interface PythonSyntaxNode {
  name: string
  from: number
  to: number
  firstChild: Nullable<PythonSyntaxNode>
  nextSibling: Nullable<PythonSyntaxNode>
}

interface PythonImportGroup {
  specifier: string
  importedName: string
}

function toLineColumn(content: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, content.length))
  const prefix = content.slice(0, safeOffset)
  const lastNewline = prefix.lastIndexOf('\n')
  return {
    line: prefix.split('\n').length,
    column: lastNewline === -1 ? safeOffset + 1 : safeOffset - lastNewline,
  }
}

function parsePythonSource(content: string): PythonSyntaxNode {
  return pythonLanguage.parser.parse(content).topNode
}

function childrenOf(node: PythonSyntaxNode): PythonSyntaxNode[] {
  const children: PythonSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

function findChild(node: PythonSyntaxNode, name: string): Nullable<PythonSyntaxNode> {
  return toNullable(childrenOf(node).find((child) => child.name === name))
}

function collectDescendants(node: PythonSyntaxNode, name: string): PythonSyntaxNode[] {
  const matches: PythonSyntaxNode[] = []
  const visit = (current: PythonSyntaxNode): void => {
    if (current.name === name) matches.push(current)
    for (const child of childrenOf(current)) visit(child)
  }
  visit(node)
  return matches
}

function nodeText(content: string, node: PythonSyntaxNode): string {
  return content.slice(node.from, node.to)
}

function nodePosition(content: string, node: PythonSyntaxNode): { line: number; column: number } {
  return toLineColumn(content, node.from)
}

function pythonStringLiteralValue(raw: string): Nullable<string> {
  const trimmed = raw.trim().replace(/^[rRuUbBfF]+/, '')
  for (const quote of ['"""', "'''", '"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote)) return trimmed.slice(quote.length, -quote.length)
  }
  return null
}

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

function parsePythonSymbols(path: string, content: string): LanguageSymbolRecord[] {
  const allNames = parseAllNames(content)
  const symbols: LanguageSymbolRecord[] = []
  const root = parsePythonSource(content)

  const push = (node: PythonSyntaxNode, name: string, kind: string, container?: string): void => {
    const position = nodePosition(content, node)
    symbols.push({
      path,
      language: pythonLanguageService.id,
      name,
      kind,
      container,
      line: position.line,
      column: position.column,
      exported: allNames ? allNames.has(name) : !container && !name.startsWith('_'),
    })
  }

  const handleFunction = (node: PythonSyntaxNode, container?: string): void => {
    const nameNode = findChild(node, 'VariableName')
    if (!nameNode) return
    const name = nodeText(content, nameNode)
    push(node, name, container ? 'method' : 'function', container)
  }

  const handleClass = (node: PythonSyntaxNode): void => {
    const nameNode = findChild(node, 'VariableName')
    if (!nameNode) return
    const name = nodeText(content, nameNode)
    push(node, name, 'class')

    const body = findChild(node, 'Body')
    if (!body) return
    for (const child of childrenOf(body)) {
      if (child.name === 'FunctionDefinition') {
        handleFunction(child, name)
      }
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
      push(node, name, 'variable')
    }
  }

  return symbols
}

function importTokenText(content: string, token: PythonSyntaxNode): string {
  return nodeText(content, token).trim()
}

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

function compactImportSpecifier(content: string, tokens: PythonSyntaxNode[]): string {
  return tokens
    .map((token) => importTokenText(content, token))
    .join('')
    .replace(/\s+/g, '')
}

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

function parsePythonImports(path: string, content: string): LanguageImportRecord[] {
  const imports: LanguageImportRecord[] = []
  const root = parsePythonSource(content)

  const pushFromNode = (
    node: PythonSyntaxNode,
    kind: LanguageImportRecord['kind'],
    specifier: string,
    importedNames: string[]
  ): void => {
    const position = nodePosition(content, node)
    imports.push({
      path,
      language: pythonLanguageService.id,
      line: position.line,
      column: position.column,
      kind,
      specifier,
      isRelative: specifier.startsWith('.'),
      isTypeOnly: false,
      importedNames,
      raw: compactStatement(nodeText(content, node)),
    })
  }

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
      pushFromNode(node, 'from-import', specifier, importedNames)
      return
    }

    if (firstToken === 'import') {
      for (const group of splitImportGroups(content, children.slice(1))) {
        const parsed = importGroupFromTokens(content, group)
        if (!parsed) continue
        pushFromNode(node, 'import', parsed.specifier, [parsed.importedName])
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

  return imports
}

async function findSymbols(
  ctx: LanguageToolContext,
  input: FindSymbolsInput
): Promise<LanguageSymbolResult> {
  const limit = input.limit ?? DefaultLimit
  const selection = await collectPythonFiles(ctx, {
    path: input.path,
    extensions: input.extensions,
    maxDepth: input.maxDepth,
    maxFiles: Math.min(5000, Math.max(limit * 25, 500)),
  })
  const query = input.query?.trim()
  const kinds = new Set(input.kinds?.map((kind) => kind.toLowerCase()))
  const symbols: LanguageSymbolRecord[] = []
  let scannedSymbols = 0

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    for (const symbol of parsePythonSymbols(file, content)) {
      scannedSymbols += 1
      if (input.exportedOnly && !symbol.exported) continue
      if (kinds.size && !kinds.has(symbol.kind.toLowerCase())) continue
      if (query) {
        const haystack = [symbol.name, symbol.container, symbol.path].filter(Boolean).join(' ')
        const matched = input.exact
          ? symbol.name === query || `${symbol.container ?? ''}.${symbol.name}` === query
          : haystack.toLowerCase().includes(query.toLowerCase())
        if (!matched) continue
      }
      symbols.push(symbol)
    }
  }

  symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return {
    symbols: symbols.slice(0, limit),
    symbolCount: symbols.length,
    scannedFiles: selection.files.length,
    scannedSymbols,
    fileListTruncated: selection.truncated,
    truncated: symbols.length > limit,
  }
}

async function listExports(
  ctx: LanguageToolContext,
  input: ListExportsInput
): Promise<LanguageExportResult> {
  const symbols = await findSymbols(ctx, {
    ...input,
    exportedOnly: true,
    limit: input.limit ?? DefaultLimit,
  })
  const exports = symbols.symbols
    .filter(
      (symbol) => !input.query || symbol.name.toLowerCase().includes(input.query.toLowerCase())
    )
    .map((symbol) => ({
      path: symbol.path,
      language: pythonLanguageService.id,
      line: symbol.line,
      column: symbol.column,
      name: symbol.name,
      kind: symbol.kind,
      reExport: false,
    }))
  return {
    exports,
    exportCount: symbols.symbolCount,
    scannedFiles: symbols.scannedFiles,
    fileListTruncated: symbols.fileListTruncated,
    truncated: symbols.truncated,
  }
}

async function findImports(
  ctx: LanguageToolContext,
  input: FindImportsInput
): Promise<LanguageImportResult> {
  const limit = input.limit ?? DefaultLimit
  const selection = await collectPythonFiles(ctx, {
    path: input.path,
    extensions: input.extensions,
    maxDepth: input.maxDepth,
    maxFiles: Math.min(5000, Math.max(limit * 40, 500)),
  })
  const records: LanguageImportRecord[] = []

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    for (const record of parsePythonImports(file, content)) {
      if (input.kind && record.kind !== input.kind) continue
      if (isFalse(input.includeExternal) && !record.isRelative) continue
      if (input.specifier && record.specifier !== input.specifier) continue
      records.push(record)
    }
  }

  records.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return {
    imports: records.slice(0, limit),
    importCount: records.length,
    scannedFiles: selection.files.length,
    fileListTruncated: selection.truncated,
    truncated: records.length > limit,
  }
}

function stripPythonExtension(path: string): string {
  return normalizePath(path).replace(/(?:\.pyi?|\/__init__\.pyi?)$/i, '')
}

function pythonBaseCandidates(importerPath: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) {
    const base = specifier.replace(/\./g, '/')
    return [base, `${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`]
  }

  const dots = specifier.match(/^\.+/)?.[0].length ?? 0
  const rest = specifier.slice(dots).replace(/\./g, '/')
  let baseDir = nodePath.posix.dirname(importerPath)
  for (let i = 1; i < dots; i += 1) {
    baseDir = nodePath.posix.dirname(baseDir)
  }
  const base = rest ? normalizePath(nodePath.posix.join(baseDir, rest)) : normalizePath(baseDir)
  return [base, `${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`]
}

function pythonImportTargetCandidates(record: LanguageImportRecord): string[] {
  const baseCandidates = pythonBaseCandidates(record.path, record.specifier)
  const nestedCandidates =
    record.kind === 'from-import'
      ? record.importedNames.flatMap((name) =>
          baseCandidates.flatMap((base) => [
            normalizePath(nodePath.posix.join(stripPythonExtension(base), `${name}.py`)),
            normalizePath(nodePath.posix.join(stripPythonExtension(base), name, '__init__.py')),
          ])
        )
      : []
  return [...new Set([...baseCandidates, ...nestedCandidates].map(normalizePath))]
}

function importMatchesTarget(
  record: LanguageImportRecord,
  input: { specifier?: string; targetPath?: string },
  fileSet: Set<string>
): boolean {
  if (input.specifier && record.specifier === input.specifier) return true
  if (!input.targetPath) return false

  const target = normalizePath(input.targetPath)
  return pythonImportTargetCandidates(record).some(
    (candidate) =>
      fileSet.has(candidate) &&
      (candidate === target || stripPythonExtension(candidate) === stripPythonExtension(target))
  )
}

async function findImporters(
  ctx: LanguageToolContext,
  input: FindImportersInput
): Promise<LanguageImporterResult> {
  return scanImporters(ctx, input, DefaultPythonExtensions, (file, content, fileSet) => {
    const matches: LanguageImportRecord[] = []
    for (const record of parsePythonImports(file, content)) {
      if (!importMatchesTarget(record, input, fileSet)) continue
      const resolvedPath = toNullable(
        pythonImportTargetCandidates(record).find((candidate) => fileSet.has(candidate))
      )
      matches.push({ ...record, resolvedPath })
    }
    return matches
  })
}

async function findReferences(
  ctx: LanguageToolContext,
  input: FindReferencesInput
): Promise<LanguageReferenceResult> {
  return scanReferences(ctx, input, DefaultPythonExtensions, (file, content, isMatch, remaining) => {
    const matches: LanguageReferenceRecord[] = []
    const root = parsePythonSource(content)
    const visit = (node: PythonSyntaxNode): void => {
      if (matches.length >= remaining) return
      if (node.name === 'VariableName' && isMatch(nodeText(content, node))) {
        const position = nodePosition(content, node)
        matches.push({
          path: file,
          language: pythonLanguageService.id,
          line: position.line,
          column: position.column,
          excerpt: lineAt(content, position.line).trim(),
        })
      }
      for (const child of childrenOf(node)) visit(child)
    }
    visit(root)
    return matches
  })
}

export const pythonLanguageService: LanguageNavigationService = {
  id: 'python',
  label: 'Python',
  extensions: DefaultPythonExtensions,
  findSymbols,
  listExports,
  findImports,
  findReferences,
  findImporters,
}
