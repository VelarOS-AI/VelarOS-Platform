import { isFalse, isPresent, toNullable } from '@velaros-ai/core'

import { LanguageServiceIds } from '../contract/constants.js'
import type { LanguageToolContext } from '../contract/requires.js'
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
  ListExportsInput,
  SourceFileSelectionResult,
} from '../types/language.js'
import type { PythonSyntaxNode } from '../types/syntax.js'
import { symbolMatchesQuery } from '../utils/jsts-syntax.js'
import {
  childrenOf,
  compactStatementOfNode,
  nodePosition,
  nodeText,
  parsePythonImports,
  parsePythonSource,
  parsePythonSymbols,
  pythonImportMatchesTarget,
  pythonImportTargetCandidates,
} from '../utils/python-syntax.js'
import {
  collectSourceFiles,
  fileBudgetFor,
  limitOf,
  lineAt,
  readSourceFile,
  scanImporters,
  scanReferences,
} from '../utils/source-files.js'
import { DevelopmentTuning } from '../utils/tuning.js'

/** 内置的 Python 语言服务：基于 `@codemirror/lang-python` 的语法导航，没有类型诊断。 */
export interface PythonLanguageServiceApi extends LanguageNavigationService {
  /** Python 没有类型检查后端，本服务不实现诊断；调用方据此说明「没做诊断」。 */
  getDiagnostics?: undefined
}

/**
 * Python 的语言语义：符号、导入、引用都走 Lezer 语法树，导出按 `__all__` 或下划线约定判定。
 *
 * 文件发现、读取与扫描外壳与 JavaScript / TypeScript 共用，这里只实现 Python 那一半。
 */
class PythonLanguageService implements PythonLanguageServiceApi {
  public readonly id: string = LanguageServiceIds.python
  public readonly label = 'Python'
  public readonly extensions: readonly string[] = ['py', 'pyi']

  public async findSymbols(
    ctx: LanguageToolContext,
    input: FindSymbolsInput
  ): Promise<LanguageSymbolResult> {
    const limit = limitOf(input.limit)
    const selection = await this.selectFiles(ctx, input, DevelopmentTuning.fileBudget.symbolsPerResult)
    const query = input.query?.trim()
    const kinds = new Set(input.kinds?.map((kind) => kind.toLowerCase()))
    const symbols: LanguageSymbolRecord[] = []
    let scannedSymbols = 0

    for (const file of selection.files) {
      const content = await readSourceFile(ctx, file)
      if (!isPresent(content)) continue
      const fileSymbols: LanguageSymbolRecord[] = []
      parsePythonSymbols(content, (node, name, kind, exported, container) => {
        const position = nodePosition(content, node)
        fileSymbols.push({
          path: file,
          language: this.id,
          name,
          kind,
          container,
          line: position.line,
          column: position.column,
          exported,
        })
      })
      for (const symbol of fileSymbols) {
        scannedSymbols += 1
        if (input.exportedOnly && !symbol.exported) continue
        if (kinds.size && !kinds.has(symbol.kind.toLowerCase())) continue
        if (query && !symbolMatchesQuery(symbol, query, input.exact)) continue
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

  public async listExports(
    ctx: LanguageToolContext,
    input: ListExportsInput
  ): Promise<LanguageExportResult> {
    const symbols = await this.findSymbols(ctx, {
      ...input,
      exportedOnly: true,
      limit: limitOf(input.limit),
    })
    const exports = symbols.symbols
      .filter(
        (symbol) => !input.query || symbol.name.toLowerCase().includes(input.query.toLowerCase())
      )
      .map((symbol) => ({
        path: symbol.path,
        language: this.id,
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

  public async findImports(
    ctx: LanguageToolContext,
    input: FindImportsInput
  ): Promise<LanguageImportResult> {
    const limit = limitOf(input.limit)
    const selection = await this.selectFiles(ctx, input, DevelopmentTuning.fileBudget.importsPerResult)
    const records: LanguageImportRecord[] = []

    for (const file of selection.files) {
      const content = await readSourceFile(ctx, file)
      if (!isPresent(content)) continue
      for (const record of this.importsOf(file, content)) {
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

  public async findImporters(
    ctx: LanguageToolContext,
    input: FindImportersInput
  ): Promise<LanguageImporterResult> {
    return scanImporters(ctx, input, this.extensions, (file, content, fileSet) => {
      const matches: LanguageImportRecord[] = []
      for (const record of this.importsOf(file, content)) {
        if (!pythonImportMatchesTarget(record, input, fileSet)) continue
        const resolvedPath = toNullable(
          pythonImportTargetCandidates(record).find((candidate) => fileSet.has(candidate))
        )
        matches.push({ ...record, resolvedPath })
      }
      return matches
    })
  }

  public async findReferences(
    ctx: LanguageToolContext,
    input: FindReferencesInput
  ): Promise<LanguageReferenceResult> {
    return scanReferences(ctx, input, this.extensions, (file, content, isMatch, remaining) => {
      const matches: LanguageReferenceRecord[] = []
      const root = parsePythonSource(content)
      const visit = (node: PythonSyntaxNode): void => {
        if (matches.length >= remaining) return
        if (node.name === 'VariableName' && isMatch(nodeText(content, node))) {
          const position = nodePosition(content, node)
          matches.push({
            path: file,
            language: this.id,
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

  /** 解析一个文件里的引入语句，并贴上本服务的语言 id。 */
  private importsOf(file: string, content: string): LanguageImportRecord[] {
    const records: LanguageImportRecord[] = []
    parsePythonImports(content, (node, kind, specifier, importedNames) => {
      const position = nodePosition(content, node)
      records.push({
        path: file,
        language: this.id,
        line: position.line,
        column: position.column,
        kind,
        specifier,
        isRelative: specifier.startsWith('.'),
        isTypeOnly: false,
        importedNames,
        raw: compactStatementOfNode(content, node),
      })
    })
    return records
  }

  /** 按这次动作的结果条数换算扫描面，再交给共享的选文件外壳。 */
  private selectFiles(
    ctx: LanguageToolContext,
    input: { path?: string; extensions?: string[]; maxDepth?: number; limit?: number },
    filesPerResult: number
  ): Promise<SourceFileSelectionResult> {
    return collectSourceFiles(
      ctx,
      {
        path: input.path,
        extensions: input.extensions,
        maxDepth: input.maxDepth,
        maxFiles: fileBudgetFor(limitOf(input.limit), filesPerResult),
      },
      this.extensions
    )
  }
}

/** 进程内唯一的一份；由语言服务注册表持有。 */
export const pythonLanguageService: PythonLanguageServiceApi = new PythonLanguageService()
