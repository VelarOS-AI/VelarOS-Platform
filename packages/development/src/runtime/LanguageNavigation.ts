import type { ProjectToolContext } from '@velaros-ai/project/agent'
import { isEmpty } from '@velaros-ai/core'

import { jsTsLanguageService } from './JsTsNavigation'
import {
  type LanguageImportRecord,
  type LanguageNavigationService,
  type LanguageReferenceRecord,
  languageServiceRegistry,
  type LanguageSymbolRecord,
  type LanguageToolsPlugin,
} from './LanguageService'
import { DefaultNavigationLimit as DefaultLimit } from './LanguageService'
import { pythonLanguageService } from './PythonNavigation'

export { DefaultLimit }

export const builtinLanguageToolsPlugin: LanguageToolsPlugin = {
  id: 'builtin-language-services',
  label: 'Built-in language services',
  services: [jsTsLanguageService, pythonLanguageService],
}

languageServiceRegistry.install(builtinLanguageToolsPlugin)

import {
  normalizeExtension,
  normalizeSourcePath as normalizePath,
  sourceFileExtension as pathExtension,
} from './LanguageService'

export { normalizeExtension, normalizePath, pathExtension }

export function serviceMatchesExtensions(
  service: LanguageNavigationService,
  extensions?: string[]
): boolean {
  if (!extensions || isEmpty(extensions)) return true
  const requested = new Set(extensions.map(normalizeExtension))
  return service.extensions.some((extension) => requested.has(normalizeExtension(extension)))
}

export function selectLanguageServices(input: {
  language?: string
  path?: string
  targetPath?: string
  extensions?: string[]
}): LanguageNavigationService[] {
  const services = languageServiceRegistry.listServices()
  if (input.language) {
    const service = languageServiceRegistry.getService(input.language)
    return service ? [service] : []
  }

  const concretePath = input.targetPath ?? input.path
  const extension = concretePath ? pathExtension(concretePath) : ''
  if (extension) {
    const matched = services.filter((service) =>
      service.extensions.map(normalizeExtension).includes(extension)
    )
    if (!isEmpty(matched)) return matched
  }

  return services.filter((service) => serviceMatchesExtensions(service, input.extensions))
}

export function summarizeServices(
  services: LanguageNavigationService[]
): Array<{ id: string; label: string }> {
  return services.map((service) => ({ id: service.id, label: service.label }))
}

export function mergeTruncated(
  results: Array<{ truncated?: boolean; fileListTruncated?: boolean }>
): boolean {
  return results.some((result) => result.truncated || result.fileListTruncated)
}

export async function analyzeImpactWithService(
  service: LanguageNavigationService,
  input: {
    symbol: string
    path?: string
    declarationPath?: string
    kinds?: string[]
    limit?: number
    extensions?: string[]
    maxDepth?: number
  },
  ctx: ProjectToolContext
): Promise<{
  language: string
  definitions: LanguageSymbolRecord[]
  definitionCount: number
  references: LanguageReferenceRecord[]
  referenceCount: number
  importers: LanguageImportRecord[]
  importerCount: number
  relatedTestPaths: string[]
  truncated: boolean
}> {
  const limit = input.limit ?? DefaultLimit
  const definitions = await service.findSymbols(ctx, {
    query: input.symbol,
    path: input.declarationPath ?? input.path,
    kinds: input.kinds,
    extensions: input.extensions,
    maxDepth: input.maxDepth,
    exportedOnly: false,
    exact: true,
    limit,
  })
  const references = await service.findReferences(ctx, {
    symbol: input.symbol,
    path: input.path,
    extensions: input.extensions,
    exactWord: true,
    limit,
  })
  const targetPaths = [
    ...new Set(
      [input.declarationPath, ...definitions.symbols.map((symbol) => symbol.path)].filter(
        Boolean
      ) as string[]
    ),
  ]
  const importerRecords: LanguageImportRecord[] = []
  for (const targetPath of targetPaths.slice(0, 10)) {
    const importers = await service.findImporters(ctx, {
      targetPath,
      path: input.path,
      includeReExports: true,
      extensions: input.extensions,
      maxDepth: input.maxDepth,
      limit,
    })
    importerRecords.push(...importers.importers)
  }
  const seenImporters = new Set<string>()
  const importers = importerRecords.filter((record) => {
    const key = `${record.language}:${record.path}:${record.line}:${record.specifier}`
    if (seenImporters.has(key)) return false
    seenImporters.add(key)
    return true
  })
  const relatedTestPaths = [
    ...new Set(
      [
        ...references.references.map((reference) => reference.path),
        ...importers.map((record) => record.path),
      ].filter(
        (path) =>
          /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
          /\.(?:test|spec)\.py$/i.test(path) ||
          /(?:^|\/)__tests__\//.test(path) ||
          /(?:^|\/)tests?\//.test(path)
      )
    ),
  ].slice(0, 50)

  return {
    language: service.id,
    definitions: definitions.symbols,
    definitionCount: definitions.symbolCount,
    references: references.references,
    referenceCount: references.referenceCount,
    importers: importers.slice(0, limit),
    importerCount: importers.length,
    relatedTestPaths,
    truncated:
      definitions.truncated ||
      references.truncated ||
      definitions.fileListTruncated ||
      importers.length > limit,
  }
}
