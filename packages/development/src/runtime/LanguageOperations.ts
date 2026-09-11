import { isEmpty, isFunction, isNonBlankString, optionalWhen, unique } from '@velaros-ai/core'

import {
  analyzeImpactWithService,
  DefaultLimit,
  mergeTruncated,
  selectLanguageServices,
  summarizeServices,
} from './LanguageNavigation'
import {
  compareDiagnostics,
  type FindImportersInput,
  type FindImportsInput,
  type FindReferencesInput,
  type FindSymbolsInput,
  type LanguageDiagnosticRecord,
  type LanguageDiagnosticsInput,
  type LanguageExportRecord,
  type LanguageToolContext,
  type ListExportsInput,
} from './LanguageService'

function runInProjectDirectory<T>(
  context: Pick<LanguageToolContext, 'project'>,
  cwd: LooseOptional<string>,
  action: () => Promise<T>
): Promise<T> {
  return cwd ? context.project.runInDirectory(cwd, action) : action()
}

async function findSymbols(
  input: FindSymbolsInput & {
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findSymbols(ctx, input)))
    const symbols = results.flatMap((result) => result.symbols)
    symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return {
      services: summarizeServices(services),
      symbols: symbols.slice(0, input.limit ?? DefaultLimit),
      symbolCount: results.reduce((sum, result) => sum + result.symbolCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      scannedSymbols: results.reduce((sum, result) => sum + result.scannedSymbols, 0),
      truncated: symbols.length > (input.limit ?? DefaultLimit) || mergeTruncated(results),
    }
  })
}

async function listExports(
  input: ListExportsInput & {
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.listExports(ctx, input)))
    const exports: LanguageExportRecord[] = results.flatMap((result) => result.exports)
    exports.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return {
      services: summarizeServices(services),
      exports: exports.slice(0, input.limit ?? DefaultLimit),
      exportCount: results.reduce((sum, result) => sum + result.exportCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: exports.length > (input.limit ?? DefaultLimit) || mergeTruncated(results),
    }
  })
}

async function findImports(
  input: FindImportsInput & {
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findImports(ctx, input)))
    const imports = results.flatMap((result) => result.imports)
    imports.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return {
      services: summarizeServices(services),
      imports: imports.slice(0, input.limit ?? DefaultLimit),
      importCount: results.reduce((sum, result) => sum + result.importCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: imports.length > (input.limit ?? DefaultLimit) || mergeTruncated(results),
    }
  })
}

async function findReferences(
  input: FindReferencesInput & {
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findReferences(ctx, input)))
    const references = results.flatMap((result) => result.references)
    references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return {
      services: summarizeServices(services),
      references: references.slice(0, input.limit ?? DefaultLimit),
      referenceCount: results.reduce((sum, result) => sum + result.referenceCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: references.length > (input.limit ?? DefaultLimit) || mergeTruncated(results),
    }
  })
}

async function findImporters(
  input: FindImportersInput & {
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  if (!input.targetPath && !input.specifier)
    return { error: 'targetPath 和 specifier 至少需要提供一个。' }
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const results = await Promise.all(services.map((service) => service.findImporters(ctx, input)))
    const importers = results.flatMap((result) => result.importers)
    importers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return {
      services: summarizeServices(services),
      importers: importers.slice(0, input.limit ?? DefaultLimit),
      importerCount: results.reduce((sum, result) => sum + result.importerCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: importers.length > (input.limit ?? DefaultLimit) || mergeTruncated(results),
    }
  })
}

async function analyzeSymbolImpact(
  input: {
    symbol: string
    path?: string
    declarationPath?: string
    kinds?: string[]
    limit?: number
    extensions?: string[]
    maxDepth?: number
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const impacts = await Promise.all(
      services.map((service) => analyzeImpactWithService(service, input, ctx))
    )
    return {
      services: summarizeServices(services),
      symbol: input.symbol,
      languages: impacts,
      definitions: impacts.flatMap((impact) => impact.definitions),
      definitionCount: impacts.reduce((sum, impact) => sum + impact.definitionCount, 0),
      references: impacts
        .flatMap((impact) => impact.references)
        .slice(0, input.limit ?? DefaultLimit),
      referenceCount: impacts.reduce((sum, impact) => sum + impact.referenceCount, 0),
      importers: impacts
        .flatMap((impact) => impact.importers)
        .slice(0, input.limit ?? DefaultLimit),
      importerCount: impacts.reduce((sum, impact) => sum + impact.importerCount, 0),
      relatedTestPaths: [...new Set(impacts.flatMap((impact) => impact.relatedTestPaths))],
      truncated: impacts.some((impact) => impact.truncated),
    }
  })
}

/** 多个语言服务的降级原因/说明合并成一段；全部缺席时字段省略。 */
function joinDiagnosticReasons(
  reasons: ReadonlyArray<LooseOptional<string>>
): LooseOptional<string> {
  const present = unique(reasons.filter(isNonBlankString))
  return optionalWhen(!isEmpty(present), present.join('\n'))
}

async function languageDiagnostics(
  input: LanguageDiagnosticsInput & {
    language?: string
    cwd?: string
  },
  ctx: LanguageToolContext
) {
  return runInProjectDirectory(ctx, input.cwd, async () => {
    const services = selectLanguageServices(input)
    const supportedServices = services.filter((service) => isFunction(service.getDiagnostics))
    const unsupportedServices = services
      .filter((service) => !isFunction(service.getDiagnostics))
      .map((service) => ({ id: service.id, label: service.label }))
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

    return {
      services: summarizeServices(supportedServices),
      unsupportedServices,
      diagnostics: diagnostics.slice(0, input.limit ?? DefaultLimit),
      diagnosticCount: results.reduce((sum, result) => sum + result.diagnosticCount, 0),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      truncated: diagnostics.length > (input.limit ?? DefaultLimit) || mergeTruncated(results),
      degraded: joinDiagnosticReasons(results.map((result) => result.degraded)),
      note: joinDiagnosticReasons([noServiceNote, ...results.map((result) => result.note)]),
    }
  })
}

const developmentLanguageOperations = {
  analyze_symbol_impact: analyzeSymbolImpact,
  find_importers: findImporters,
  find_imports: findImports,
  find_references: findReferences,
  find_symbols: findSymbols,
  language_diagnostics: languageDiagnostics,
  list_exports: listExports,
}
export { developmentLanguageOperations }
