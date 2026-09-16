import { isEmpty, isNonBlankString, isPlainObject, optionalWhen, unique } from '@velaros-ai/core'
import {
  ProjectCodeLanguageActions,
  type ProjectCodeLanguageQuery,
  type ProjectCodeQuery,
} from '@velaros-ai/project/contracts'

import type { CodeQuerySource } from '../contract/constants.js'
import type { LanguageToolContext } from '../contract/requires.js'
import type {
  AnalyzeSymbolImpactInput,
  LanguageImpactResult,
  LanguageImportRecord,
  LanguageNavigationService,
  LanguageServiceSummary,
} from '../types/language.js'

import { limitOf, normalizeExtension } from './source-files.js'
import { DevelopmentTuning } from './tuning.js'

/** 由内置语言服务回答的那一类动作，其余属于代码图谱。 */
const languageActions: ReadonlySet<string> = new Set(ProjectCodeLanguageActions)

/** 这次代码查询是不是由内置语言服务回答的那一类。 */
export function isProjectCodeLanguageQuery(
  input: ProjectCodeQuery
): input is ProjectCodeLanguageQuery {
  return languageActions.has(input.action)
}

/** 服务名称里的语言词：`JavaScript / TypeScript` → javascript、typescript。 */
export function languageLabelWords(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9+#]+/u)
    .filter(Boolean)
}

/** 这个语言服务认不认调用方给的扩展名；没给扩展名就都算认。 */
export function serviceMatchesExtensions(
  service: LanguageNavigationService,
  extensions?: string[]
): boolean {
  if (!extensions || isEmpty(extensions)) return true
  const requested = new Set(extensions.map(normalizeExtension))
  return service.extensions.some((extension) => requested.has(normalizeExtension(extension)))
}

/** 结果里点名这次答案是谁给的：内置语言服务，还是宿主的代码图谱。 */
export function withCodeQuerySource(source: CodeQuerySource, result: unknown): PlainObject {
  if (isPlainObject(result)) return { source, ...result }

  return { source, result }
}

/** 选中的语言服务在结果里的摘要：只给 id 与名字。 */
export function summarizeServices(
  services: readonly LanguageNavigationService[]
): LanguageServiceSummary[] {
  return services.map((service) => ({ id: service.id, label: service.label }))
}

/** 多个语言服务里只要有一处被截断，合并结果就算被截断。 */
export function mergeTruncated(
  results: ReadonlyArray<{ truncated?: boolean; fileListTruncated?: boolean }>
): boolean {
  return results.some((result) => result.truncated || result.fileListTruncated)
}

/** 多个语言服务的降级原因/说明合并成一段；全部缺席时字段省略。 */
export function joinLanguageNotes(
  reasons: ReadonlyArray<LooseOptional<string>>
): LooseOptional<string> {
  const present = unique(reasons.filter(isNonBlankString))
  return optionalWhen(!isEmpty(present), present.join('\n'))
}

/** 一个路径看起来是不是测试文件（`*.test.ts`、`*.spec.py`、`__tests__/`、`tests/`）。 */
function looksLikeTestPath(path: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(path) ||
    /\.(?:test|spec)\.py$/iu.test(path) ||
    /(?:^|\/)__tests__\//u.test(path) ||
    /(?:^|\/)tests?\//u.test(path)
  )
}

/**
 * 用一个语言服务做一次符号影响面分析：声明、引用、引用方与相关测试四问合成一答。
 *
 * 引用方沿声明文件逐个追查，所以声明数要封顶；相关测试从引用与引用方的路径里筛。
 */
export async function analyzeImpactWithService(
  service: LanguageNavigationService,
  input: AnalyzeSymbolImpactInput,
  ctx: LanguageToolContext
): Promise<LanguageImpactResult> {
  const limit = limitOf(input.limit)
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
        isNonBlankString
      )
    ),
  ]
  const importerRecords: LanguageImportRecord[] = []
  for (const targetPath of targetPaths.slice(0, DevelopmentTuning.impact.maxDeclarationTargets)) {
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
      ].filter(looksLikeTestPath)
    ),
  ].slice(0, DevelopmentTuning.impact.maxRelatedTestPaths)

  return {
    language: service.id,
    definitions: definitions.symbols,
    definitionCount: definitions.symbolCount,
    references: references.references,
    referenceCount: references.referenceCount,
    referenceCountIsLowerBound: references.referenceCountIsLowerBound,
    referenceNote: references.note,
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
