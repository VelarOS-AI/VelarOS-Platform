import * as ts from 'typescript'

import { isEmpty, toOptional } from '@velaros-ai/core'

export interface ContextCodePruningRange {
  startLine: number
  endLine: number
  reasons: string[]
}

export type ContextCodePruningStrategy =
  | 'deterministic-line-selection'
  | 'typescript-ast-boundary'

export interface ContextCodePruningTrace {
  kind: 'task-aware-code-pruning'
  strategy: ContextCodePruningStrategy
  blockId: string
  toolCallId?: string
  toolName?: string
  language: Nullable<string>
  filePaths: string[]
  originalLines: number
  selectedLines: number
  prunedLines: number
  selectedLineNumbers: number[]
  selectedRanges: ContextCodePruningRange[]
  prunedPreview: string
  reasons: string[]
  rubricScores: ContextCodePruningRubricScores
  editGuard: {
    requiresRecallBeforeEdit: boolean
    reason: string
  }
  confidence: 'high' | 'medium'
  previewTruncated: boolean
  parseDiagnostics?: number
  recall?: {
    tool: 'recall_context'
    args: {
      ref: string
      refKind: 'tool-payload'
      reason: string
      maxChars: number
    }
  }
}

export interface ContextCodePruningRubricScores {
  semanticTaskRelevance: number
  structuralDependency: number
  diagnosticRelevance: number
  editRisk: number
  publicApiRisk: number
  testRelevance: number
}

export interface ContextCodeSnippetPrunerInput {
  blockId: string
  query: string
  text: string
  toolCallId?: LooseOptional<string>
  toolName?: LooseOptional<string>
}

const CodeFilePathPattern =
  /(?:^|[\s(["'`])((?:\.{1,2}\/|\/)?[\w@~./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|cs|rb|php|css|scss|sass|less|html|vue|svelte|json|yaml|yml|toml|mdx?))(?::\d+)?/gmu

const CodeFencePattern = /```([a-zA-Z0-9_+-]+)?\n([\s\S]*?)```/u
const StandaloneCodeFilePathPattern =
  /^(?:\.{1,2}\/|\/)?[\w@~./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|cs|rb|php|css|scss|sass|less|html|vue|svelte|json|yaml|yml|toml|mdx?)(?::\d+)?$/u

const CodeKeywordPattern =
  /\b(import|export|class|interface|type|enum|function|const|let|var|return|throw|catch|try|async|await|if|else|switch|case|for|while)\b/u

const StructuralLinePattern =
  /^\s*(?:import|export|class|interface|type|enum|function|const|let|var|public|private|protected|async\s+function)\b/u

const SafetyLinePattern =
  /\b(error|failed|failure|exception|throw|catch|stderr|exit code|timeout|denied|assert|expect|describe|test|it)\b/iu

const MaxPreviewLines = 96

interface CodeSelectionResult {
  strategy: ContextCodePruningStrategy
  selected: Map<number, Set<string>>
  confidence: ContextCodePruningTrace['confidence']
  parseDiagnostics?: number
}

interface ParseReadyCode {
  text: string
  lineOffset: number
  headerLineNumbers: number[]
}

interface TypeScriptDeclaration {
  index: number
  names: string[]
  startLine: number
  endLine: number
  text: string
  identifiers: Set<string>
}

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  parseDiagnostics?: readonly ts.Diagnostic[]
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/gu, '\n')
}

function extractCodeFence(text: string): { language: Nullable<string>; text: string } {
  const match = CodeFencePattern.exec(text)
  if (!match) return { language: null, text }

  return {
    language: match[1]?.trim() || null,
    text: match[2] ?? text,
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function extractFilePaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(CodeFilePathPattern)) {
    const path = match[1]?.trim()
    if (path) paths.push(path)
  }

  return unique(paths)
}

function resolveLanguage(language: Nullable<string>, filePaths: readonly string[]): Nullable<string> {
  if (language) return language.toLowerCase()

  const path = filePaths[0]
  const extension = path?.split('.').at(-1)?.toLowerCase()
  if (!extension) return null

  const aliases: Record<string, string> = {
    cjs: 'javascript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascriptreact',
    mjs: 'javascript',
    mts: 'typescript',
    ts: 'typescript',
    tsx: 'typescriptreact',
  }

  return aliases[extension] ?? extension
}

function isTypeScriptLikeLanguage(language: Nullable<string>): boolean {
  return (
    language === 'typescript' ||
    language === 'typescriptreact' ||
    language === 'javascript' ||
    language === 'javascriptreact' ||
    language === 'ts' ||
    language === 'tsx' ||
    language === 'js' ||
    language === 'jsx'
  )
}

function scriptKindForLanguage(language: Nullable<string>): ts.ScriptKind {
  switch (language) {
    case 'javascript':
    case 'js':
      return ts.ScriptKind.JS
    case 'javascriptreact':
    case 'jsx':
      return ts.ScriptKind.JSX
    case 'typescriptreact':
    case 'tsx':
      return ts.ScriptKind.TSX
    default:
      return ts.ScriptKind.TS
  }
}

function prepareParseText(text: string): ParseReadyCode {
  const lines = text.split('\n')
  const firstLine = lines[0]?.trim() ?? ''
  if (!StandaloneCodeFilePathPattern.test(firstLine)) return {
      text,
      lineOffset: 0,
      headerLineNumbers: [],
    }

  return {
    text: lines.slice(1).join('\n'),
    lineOffset: 1,
    headerLineNumbers: [1],
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{L}\p{N}_./:-]{3,}/gu) ?? []
}

function queryTerms(query: string): string[] {
  return unique(
    tokenize(query)
      .flatMap((token) => token.split(/[./:-]/u).concat(token))
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  )
}

function isLikelyCode(text: string, filePaths: readonly string[]): boolean {
  if (!isEmpty(filePaths)) return true
  if (CodeFencePattern.test(text)) return true

  const lines = normalizeLineEndings(text).split('\n')
  const codeLikeLines = lines.filter((line) => {
    const trimmed = line.trim()
    return (
      CodeKeywordPattern.test(trimmed) ||
      /[{}();=]/u.test(trimmed) ||
      /^\s*(\/\/|#|\*)/u.test(line)
    )
  }).length

  return lines.length >= 8 && codeLikeLines >= Math.max(4, Math.ceil(lines.length * 0.2))
}

function addLine(
  selected: Map<number, Set<string>>,
  lineNumber: number,
  reason: string,
  lineCount: number
): void {
  if (lineNumber < 1 || lineNumber > lineCount) return

  const reasons = selected.get(lineNumber) ?? new Set<string>()
  reasons.add(reason)
  selected.set(lineNumber, reasons)
}

function addWindow(
  selected: Map<number, Set<string>>,
  lineNumber: number,
  reason: string,
  lineCount: number,
  radius = 1
): void {
  for (let next = lineNumber - radius; next <= lineNumber + radius; next += 1) {
    addLine(selected, next, reason, lineCount)
  }
}

function addRange(
  selected: Map<number, Set<string>>,
  startLine: number,
  endLine: number,
  reason: string,
  lineCount: number
): void {
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    addLine(selected, lineNumber, reason, lineCount)
  }
}

function lineMatchesAnyTerm(line: string, terms: readonly string[]): boolean {
  const lower = line.toLowerCase()
  return terms.some((term) => lower.includes(term))
}

function buildRanges(selected: Map<number, Set<string>>): ContextCodePruningRange[] {
  const sorted = [...selected.keys()].sort((left, right) => left - right)
  const ranges: ContextCodePruningRange[] = []

  for (const lineNumber of sorted) {
    const last = ranges.at(-1)
    const reasons = [...(selected.get(lineNumber) ?? new Set<string>())].sort()
    if (last && last.endLine === lineNumber - 1) {
      last.endLine = lineNumber
      last.reasons = unique([...last.reasons, ...reasons]).sort()
      continue
    }

    ranges.push({
      startLine: lineNumber,
      endLine: lineNumber,
      reasons,
    })
  }

  return ranges
}

function buildPreview(lines: readonly string[], selectedLineNumbers: readonly number[]): string {
  return selectedLineNumbers
    .slice(0, MaxPreviewLines)
    .map((lineNumber) => `${lineNumber}: ${lines[lineNumber - 1] ?? ''}`)
    .join('\n')
}

function roundRubric(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000))
}

function ratio(count: number, total: number): number {
  if (total <= 0) return 0
  return count / total
}

function buildRubricScores(input: {
  query: string
  lines: readonly string[]
  selectedLineNumbers: readonly number[]
  selectedRanges: readonly ContextCodePruningRange[]
  filePaths: readonly string[]
}): ContextCodePruningRubricScores {
  const selectedLines = input.selectedLineNumbers.map((lineNumber) => input.lines[lineNumber - 1] ?? '')
  const selectedText = selectedLines.join('\n')
  const allReasons = new Set(input.selectedRanges.flatMap((range) => range.reasons))
  const queryLooksLikeEdit = /\b(fix|edit|change|modify|replace|implement|refactor|修复|修改|实现)\b/iu.test(input.query)
  const publicApiLines = selectedLines.filter((line) => /^\s*export\s+/u.test(line) || /\b(public|interface|type|class)\b/u.test(line)).length
  const testLines = selectedLines.filter((line) => /\b(test|it|describe|expect|assert)\b/u.test(line)).length

  return {
    semanticTaskRelevance: roundRubric(
      ratio(
        input.selectedRanges.filter((range) => range.reasons.includes('task-term-match')).length,
        Math.max(1, input.selectedRanges.length)
      )
    ),
    structuralDependency: roundRubric(
      [
        'typescript-declaration-boundary',
        'local-symbol-dependency',
        'import-context',
        'structural-anchor',
      ].filter((reason) => allReasons.has(reason)).length / 4
    ),
    diagnosticRelevance: roundRubric(SafetyLinePattern.test(selectedText) ? 1 : 0),
    editRisk: roundRubric((queryLooksLikeEdit ? 0.5 : 0.15) + (isEmpty(input.filePaths) ? 0 : 0.25) + (publicApiLines > 0 ? 0.2 : 0)),
    publicApiRisk: roundRubric(ratio(publicApiLines, Math.max(1, selectedLines.length))),
    testRelevance: roundRubric(testLines > 0 || /\b(test|spec|验证|测试)\b/iu.test(input.query) ? Math.max(0.35, ratio(testLines, Math.max(1, selectedLines.length))) : 0),
  }
}

function collectBindingNames(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    names.push(name.text)
    return
  }

  name.elements.forEach((element) => {
    if (ts.isOmittedExpression(element)) return
    collectBindingNames(element.name, names)
  })
}

function declarationNames(node: ts.Statement): string[] {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) return [node.name.text]

  if (!ts.isVariableStatement(node)) return []

  const names: string[] = []
  node.declarationList.declarations.forEach((declaration) => {
    collectBindingNames(declaration.name, names)
  })

  return names
}

function isSemanticDeclaration(node: ts.Statement): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node)
  )
}

function lineRangeForNode(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  lineOffset: number
): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())

  return {
    startLine: start.line + 1 + lineOffset,
    endLine: end.line + 1 + lineOffset,
  }
}

function collectIdentifiers(node: ts.Node, identifiers: Set<string>): void {
  if (ts.isIdentifier(node)) identifiers.add(node.text)
  node.forEachChild((child) => collectIdentifiers(child, identifiers))
}

function statementText(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n')
}

function extractTypeScriptDeclarations(input: {
  sourceFile: ts.SourceFile
  originalLines: readonly string[]
  lineOffset: number
}): TypeScriptDeclaration[] {
  const declarations: TypeScriptDeclaration[] = []

  input.sourceFile.statements.forEach((statement) => {
    if (!isSemanticDeclaration(statement)) return

    const names = declarationNames(statement)
    if (isEmpty(names)) return

    const range = lineRangeForNode(input.sourceFile, statement, input.lineOffset)
    const identifiers = new Set<string>()
    collectIdentifiers(statement, identifiers)

    declarations.push({
      index: declarations.length,
      names,
      startLine: range.startLine,
      endLine: range.endLine,
      text: statementText(input.originalLines, range.startLine, range.endLine),
      identifiers,
    })
  })

  return declarations
}

function declarationSelectionReasons(
  declaration: TypeScriptDeclaration,
  terms: readonly string[]
): string[] {
  const reasons = ['typescript-declaration-boundary']
  if (
    declaration.names.some((name) => lineMatchesAnyTerm(name, terms)) ||
    lineMatchesAnyTerm(declaration.text, terms)
  ) {
    reasons.push('task-term-match')
  }

  if (SafetyLinePattern.test(declaration.text)) {
    reasons.push('safety-or-failure-context')
  }

  return reasons.length > 1 ? reasons : []
}

function selectTypeScriptAstLines(input: {
  text: string
  filePaths: readonly string[]
  language: Nullable<string>
  terms: readonly string[]
}): Nullable<CodeSelectionResult> {
  if (!isTypeScriptLikeLanguage(input.language)) return null

  const parseReady = prepareParseText(input.text)
  const sourceFile = ts.createSourceFile(
    input.filePaths[0] ?? 'context-snippet.ts',
    parseReady.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForLanguage(input.language)
  )
  const originalLines = input.text.split('\n')
  const declarations = extractTypeScriptDeclarations({
    sourceFile,
    originalLines,
    lineOffset: parseReady.lineOffset,
  })
  if (isEmpty(declarations)) return null

  const selectedDeclarationIndexes = new Map<number, Set<string>>()
  declarations.forEach((declaration) => {
    const reasons = declarationSelectionReasons(declaration, input.terms)
    if (isEmpty(reasons)) return

    selectedDeclarationIndexes.set(declaration.index, new Set(reasons))
  })
  if (selectedDeclarationIndexes.size === 0) return null

  const declarationsByName = new Map<string, TypeScriptDeclaration[]>()
  declarations.forEach((declaration) => {
    declaration.names.forEach((name) => {
      const key = name.toLowerCase()
      declarationsByName.set(key, [...(declarationsByName.get(key) ?? []), declaration])
    })
  })

  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false
    const usedIdentifiers = new Set<string>()
    selectedDeclarationIndexes.forEach((_reasons, index) => {
      declarations[index]?.identifiers.forEach((identifier) => usedIdentifiers.add(identifier.toLowerCase()))
    })

    usedIdentifiers.forEach((identifier) => {
      declarationsByName.get(identifier)?.forEach((declaration) => {
        if (selectedDeclarationIndexes.has(declaration.index)) return

        selectedDeclarationIndexes.set(
          declaration.index,
          new Set(['typescript-declaration-boundary', 'local-symbol-dependency'])
        )
        changed = true
      })
    })

    if (!changed) break
  }

  const selected = new Map<number, Set<string>>()
  parseReady.headerLineNumbers.forEach((lineNumber) => {
    addLine(selected, lineNumber, 'file-path-context', originalLines.length)
  })

  sourceFile.statements.forEach((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)) return

    const range = lineRangeForNode(sourceFile, statement, parseReady.lineOffset)
    addRange(selected, range.startLine, range.endLine, 'import-context', originalLines.length)
  })

  selectedDeclarationIndexes.forEach((reasons, index) => {
    const declaration = declarations[index]
    if (!declaration) return

    reasons.forEach((reason) => {
      addRange(
        selected,
        declaration.startLine,
        declaration.endLine,
        reason,
        originalLines.length
      )
    })
  })

  return {
    strategy: 'typescript-ast-boundary',
    selected,
    confidence: 'high',
    parseDiagnostics: (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics?.length ?? 0,
  }
}

function selectFallbackLines(input: {
  lines: readonly string[]
  terms: readonly string[]
  filePaths: readonly string[]
  query: string
}): Nullable<CodeSelectionResult> {
  const selected = new Map<number, Set<string>>()

  input.lines.forEach((line, index) => {
    const lineNumber = index + 1
    if (StructuralLinePattern.test(line)) {
      addLine(selected, lineNumber, 'structural-anchor', input.lines.length)
    }

    if (SafetyLinePattern.test(line)) {
      addWindow(selected, lineNumber, 'safety-or-failure-context', input.lines.length)
    }

    if (lineMatchesAnyTerm(line, input.terms)) {
      addWindow(selected, lineNumber, 'task-term-match', input.lines.length)
    }
  })

  input.filePaths.forEach((path) => {
    const pathLower = path.toLowerCase()
    if (!input.query.toLowerCase().includes(pathLower)) return

    input.lines.forEach((line, index) => {
      if (line.toLowerCase().includes(pathLower)) {
        addLine(selected, index + 1, 'explicit-file-path-match', input.lines.length)
      }
    })
  })

  if (selected.size === 0) return null

  return {
    strategy: 'deterministic-line-selection',
    selected,
    confidence: 'medium',
  }
}

function buildRecall(toolCallId?: LooseOptional<string>): ContextCodePruningTrace['recall'] {
  if (!toolCallId) return undefined

  return {
    tool: 'recall_context',
    args: {
      ref: toolCallId,
      refKind: 'tool-payload',
      reason: 'need full code context before editing',
      maxChars: 12_000,
    },
  }
}

export class ContextCodeSnippetPruner {
  public analyze(input: ContextCodeSnippetPrunerInput): Nullable<ContextCodePruningTrace> {
    const rawText = normalizeLineEndings(input.text).trim()
    if (!rawText) return null

    const fenced = extractCodeFence(rawText)
    const text = normalizeLineEndings(fenced.text).trim()
    const filePaths = extractFilePaths(rawText)
    const language = resolveLanguage(fenced.language, filePaths)
    if (!isLikelyCode(text, filePaths)) return null

    const lines = text.split('\n')
    if (lines.length < 8) return null

    const terms = queryTerms(input.query)
    const selection =
      selectTypeScriptAstLines({
        text,
        filePaths,
        language,
        terms,
      }) ??
      selectFallbackLines({
        lines,
        terms,
        filePaths,
        query: input.query,
      })
    if (!selection) return null

    const selectedLineNumbers = [...selection.selected.keys()].sort((left, right) => left - right)
    const selectedRanges = buildRanges(selection.selected)

    return {
      kind: 'task-aware-code-pruning',
      strategy: selection.strategy,
      blockId: input.blockId,
      toolCallId: toOptional(input.toolCallId),
      toolName: toOptional(input.toolName),
      language,
      filePaths,
      originalLines: lines.length,
      selectedLines: selectedLineNumbers.length,
      prunedLines: Math.max(0, lines.length - selectedLineNumbers.length),
      selectedLineNumbers,
      selectedRanges,
      prunedPreview: buildPreview(lines, selectedLineNumbers),
      previewTruncated: selectedLineNumbers.length > MaxPreviewLines,
      reasons: unique(selectedRanges.flatMap((range) => range.reasons)).sort(),
      rubricScores: buildRubricScores({
        query: input.query,
        lines,
        selectedLineNumbers,
        selectedRanges,
        filePaths,
      }),
      editGuard: {
        requiresRecallBeforeEdit: true,
        reason: 'full source must be recalled before applying mutations based on pruned code',
      },
      confidence: selection.confidence,
      parseDiagnostics: toOptional(selection.parseDiagnostics),
      recall: buildRecall(input.toolCallId),
    }
  }
}
