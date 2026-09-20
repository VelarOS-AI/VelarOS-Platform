import { isEmpty, isFunction, isTrue, optionalWhen } from '@velaros-ai/core'
import type { ProjectCodeLanguageQuery } from '@velaros-ai/velaros/project/contracts'

import { CodeQuerySources } from '../contract/constants.js'
import type { LanguageToolContext } from '../contract/requires.js'
import type {
  AnalyzeSymbolImpactInput,
  FindImportersInput,
  FindImportsInput,
  FindReferencesInput,
  FindSymbolsInput,
  LanguageDiagnosticRecord,
  LanguageDiagnosticsInput,
  LanguageExportRecord,
  ListExportsInput,
} from '../types/language.js'
import { compareDiagnostics } from '../utils/diagnostics.js'
import {
  analyzeImpactWithService,
  joinLanguageNotes,
  mergeTruncated,
  summarizeServices,
  withCodeQuerySource,
} from '../utils/language-queries.js'
import { limitOf } from '../utils/source-files.js'

import { languageServiceRegistry } from './LanguageServiceRegistry.js'

/**
 * 语言查询的唯一入口：把 project 的 `ProjectCodeLanguageQuery` 分派到选中的语言服务，再把多份结果合成一份。
 *
 * 实例是 `languageQueries`。只借 `LanguageToolContext` 里的读源码端口，不需要审批、执行或修改能力——
 * 只给得起读端口的宿主（Termel）也能直接用它。
 */
export interface LanguageQueriesApi {
  /**
   * 跑一次语言查询。
   *
   * 先检查中止信号与 `language` 是否认得（认不出抛 `VALIDATION`），再按动作分派；
   * 返回的对象一定带 `source: 'language-service'`，其余字段随动作而定。
   * 选中多个语言服务时并行问、结果合并，计数相加、截断取并。
   */
  run(input: ProjectCodeLanguageQuery, context: LanguageToolContext): Promise<unknown>
}

/** 语言查询的分派与结果合并，见接口说明。 */
class LanguageQueries implements LanguageQueriesApi {
  private readonly registry = languageServiceRegistry

  public async run(input: ProjectCodeLanguageQuery, context: LanguageToolContext): Promise<unknown> {
    context.abortSignal.throwIfAborted()
    this.registry.assertKnownLanguage(input.language)
    return withCodeQuerySource(CodeQuerySources.languageService, await this.dispatch(input, context))
  }

  /** 按 action 分派；`action` 本身不是查询参数，剥掉再交给各动作。 */
  private async dispatch(
    input: ProjectCodeLanguageQuery,
    context: LanguageToolContext
  ): Promise<unknown> {
    switch (input.action) {
      case 'find_symbols': {
        const { action: _action, ...args } = input
        return this.findSymbols(args, context)
      }
      case 'list_exports': {
        const { action: _action, ...args } = input
        return this.listExports(args, context)
      }
      case 'find_imports': {
        const { action: _action, ...args } = input
        return this.findImports(args, context)
      }
      case 'find_importers': {
        const { action: _action, ...args } = input
        return this.findImporters(args, context)
      }
      case 'find_references': {
        const { action: _action, ...args } = input
        return this.findReferences(args, context)
      }
      case 'language_diagnostics': {
        const { action: _action, ...args } = input
        return this.languageDiagnostics(args, context)
      }
      case 'analyze_symbol_impact': {
        const { action: _action, ...args } = input
        return this.analyzeSymbolImpact(args, context)
      }
    }
  }

  /** 找符号：多个语言服务的结果按路径与行号排好再截断。 */
  private async findSymbols(input: FindSymbolsInput, ctx: LanguageToolContext): Promise<PlainObject> {
    const services = this.registry.selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findSymbols(ctx, input)))
    const symbols = results.flatMap((result) => result.symbols)
    symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    const limit = limitOf(input.limit)
    return {
      services: summarizeServices(services),
      symbols: symbols.slice(0, limit),
      symbolCount: results.reduce((sum, result) => sum + result.symbolCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      scannedSymbols: results.reduce((sum, result) => sum + result.scannedSymbols, 0),
      truncated: symbols.length > limit || mergeTruncated(results),
    }
  }

  /** 列导出。 */
  private async listExports(input: ListExportsInput, ctx: LanguageToolContext): Promise<PlainObject> {
    const services = this.registry.selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.listExports(ctx, input)))
    const exports: LanguageExportRecord[] = results.flatMap((result) => result.exports)
    exports.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    const limit = limitOf(input.limit)
    return {
      services: summarizeServices(services),
      exports: exports.slice(0, limit),
      exportCount: results.reduce((sum, result) => sum + result.exportCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: exports.length > limit || mergeTruncated(results),
    }
  }

  /** 列引入。 */
  private async findImports(input: FindImportsInput, ctx: LanguageToolContext): Promise<PlainObject> {
    const services = this.registry.selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findImports(ctx, input)))
    const imports = results.flatMap((result) => result.imports)
    imports.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    const limit = limitOf(input.limit)
    return {
      services: summarizeServices(services),
      imports: imports.slice(0, limit),
      importCount: results.reduce((sum, result) => sum + result.importCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: imports.length > limit || mergeTruncated(results),
    }
  }

  /** 找引用：任一语言服务提前停扫，合计数就只是下限，说明一并转给调用方。 */
  private async findReferences(
    input: FindReferencesInput,
    ctx: LanguageToolContext
  ): Promise<PlainObject> {
    const services = this.registry.selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findReferences(ctx, input)))
    const references = results.flatMap((result) => result.references)
    references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    const limit = limitOf(input.limit)
    return {
      services: summarizeServices(services),
      references: references.slice(0, limit),
      referenceCount: results.reduce((sum, result) => sum + result.referenceCount, 0),
      referenceCountIsLowerBound: optionalWhen(
        results.some((result) => isTrue(result.referenceCountIsLowerBound)),
        true
      ),
      note: joinLanguageNotes(results.map((result) => result.note)),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: references.length > limit || mergeTruncated(results),
    }
  }

  /** 找引用方：`targetPath` 与 `specifier` 一个都不给就不是有效查询。 */
  private async findImporters(
    input: FindImportersInput,
    ctx: LanguageToolContext
  ): Promise<PlainObject> {
    if (!input.targetPath && !input.specifier)
      return { error: 'targetPath 和 specifier 至少需要提供一个。' }
    const services = this.registry.selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findImporters(ctx, input)))
    const importers = results.flatMap((result) => result.importers)
    importers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    const limit = limitOf(input.limit)
    return {
      services: summarizeServices(services),
      importers: importers.slice(0, limit),
      importerCount: results.reduce((sum, result) => sum + result.importerCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: importers.length > limit || mergeTruncated(results),
    }
  }

  /** 诊断：不支持诊断的语言服务单列出来，一个都不支持时明说「没做诊断」。 */
  private async languageDiagnostics(
    input: LanguageDiagnosticsInput,
    ctx: LanguageToolContext
  ): Promise<PlainObject> {
    const services = this.registry.selectLanguageServices(input)
    const supportedServices = services.filter((service) => isFunction(service.getDiagnostics))
    const unsupportedServices = summarizeServices(
      services.filter((service) => !isFunction(service.getDiagnostics))
    )
    const results = await Promise.all(
      supportedServices.map((service) => service.getDiagnostics!(ctx, input))
    )
    const diagnostics: LanguageDiagnosticRecord[] = results.flatMap((result) => result.diagnostics)
    diagnostics.sort(compareDiagnostics)
    const scope = input.extensions
      ? `${input.path}（extensions: ${input.extensions.join('/')}）`
      : input.path
    const noServiceNote = optionalWhen(
      isEmpty(supportedServices),
      `没有语言服务能诊断 ${scope}，未做诊断。这不代表代码没有错误。`
    )
    const limit = limitOf(input.limit)

    return {
      services: summarizeServices(supportedServices),
      unsupportedServices,
      diagnostics: diagnostics.slice(0, limit),
      diagnosticCount: results.reduce((sum, result) => sum + result.diagnosticCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: diagnostics.length > limit || mergeTruncated(results),
      degraded: joinLanguageNotes(results.map((result) => result.degraded)),
      note: joinLanguageNotes([noServiceNote, ...results.map((result) => result.note)]),
    }
  }

  /** 影响面分析：声明、引用、引用方与相关测试四问合成一答，逐个语言服务各给一份再汇总。 */
  private async analyzeSymbolImpact(
    input: AnalyzeSymbolImpactInput,
    ctx: LanguageToolContext
  ): Promise<PlainObject> {
    const services = this.registry.selectLanguageServices(input)
    const impacts = await Promise.all(
      services.map((service) => analyzeImpactWithService(service, input, ctx))
    )
    const limit = limitOf(input.limit)
    return {
      services: summarizeServices(services),
      symbol: input.symbol,
      languages: impacts,
      definitions: impacts.flatMap((impact) => impact.definitions),
      definitionCount: impacts.reduce((sum, impact) => sum + impact.definitionCount, 0),
      references: impacts.flatMap((impact) => impact.references).slice(0, limit),
      referenceCount: impacts.reduce((sum, impact) => sum + impact.referenceCount, 0),
      referenceCountIsLowerBound: optionalWhen(
        impacts.some((impact) => isTrue(impact.referenceCountIsLowerBound)),
        true
      ),
      referenceNote: joinLanguageNotes(impacts.map((impact) => impact.referenceNote)),
      importers: impacts.flatMap((impact) => impact.importers).slice(0, limit),
      importerCount: impacts.reduce((sum, impact) => sum + impact.importerCount, 0),
      relatedTestPaths: [...new Set(impacts.flatMap((impact) => impact.relatedTestPaths))],
      truncated: impacts.some((impact) => impact.truncated),
    }
  }
}

/** 进程内唯一的一份；只给得起读源码端口的宿主也能直接用它。 */
export const languageQueries: LanguageQueriesApi = new LanguageQueries()
