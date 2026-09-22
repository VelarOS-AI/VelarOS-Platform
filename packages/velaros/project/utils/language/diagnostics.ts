import nodePath from 'node:path'

import * as ts from 'typescript'

import { isNumber, isPresent, numberOrNull, toOptional } from '@velaros-ai/core'

import type { LanguageDiagnosticRecord, LanguageDiagnosticsResult } from '../../types/language.js'

import { isPathTextInsideRoot, normalizeSeparators } from './project-paths.js'
import { safeReadFile } from './typescript-config.js'

/** 错误排在警告与提示之前：结果按 limit 截断时，大量提示不会把真错误挤出返回窗口。 */
export function compareDiagnostics(
  left: LanguageDiagnosticRecord,
  right: LanguageDiagnosticRecord
): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column
  )
}

/** 严重程度的排序权重：错误在前，提示在后。 */
function severityRank(severity: LanguageDiagnosticRecord['severity']): number {
  switch (severity) {
    case 'error':
      return 0
    case 'warning':
      return 1
    default:
      return 2
  }
}

/** TypeScript 的诊断分类换算成本包的三档严重程度。 */
function diagnosticSeverity(category: ts.DiagnosticCategory): LanguageDiagnosticRecord['severity'] {
  if (category === ts.DiagnosticCategory.Error) return 'error'
  if (category === ts.DiagnosticCategory.Warning) return 'warning'
  return 'info'
}

/**
 * 行列直接问诊断自带的 `SourceFile` 要。
 *
 * 原先为了算行列**每条诊断新建一个 `SourceFile`**——而 `diagnostic.file` 本来就是 TS 程序解析好的
 * 那一个。一个文件几百条诊断就是几百次整文件解析，跟目录诊断的耗时预算抢时间。
 */
function rangeFromTypeScriptDiagnostic(
  sourceFile: ts.SourceFile,
  start: number,
  length: number
): Pick<LanguageDiagnosticRecord, 'line' | 'column' | 'endLine' | 'endColumn'> {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(start + length)
  return {
    line: startPosition.line + 1,
    column: startPosition.character + 1,
    endLine: endPosition.line + 1,
    endColumn: endPosition.character + 1,
  }
}

/** 把一条 TypeScript 诊断换算成本包的记录；越出项目或读不到正文的一律丢掉。 */
export function mapTypeScriptDiagnostic(
  rootPath: string,
  language: string,
  files: ReadonlyMap<string, string>,
  diagnostic: ts.Diagnostic
): Nullable<LanguageDiagnosticRecord> {
  if (!diagnostic.file || !isNumber(diagnostic.start)) return null
  const absolutePath = diagnostic.file.fileName
  if (!isPathTextInsideRoot(rootPath, absolutePath)) return null

  const content = files.get(absolutePath) ?? safeReadFile(absolutePath)
  if (!isPresent(content)) return null

  return {
    path: normalizeSeparators(nodePath.relative(rootPath, absolutePath)),
    language,
    severity: diagnosticSeverity(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    source: 'typescript',
    code: toOptional(numberOrNull(diagnostic.code)),
    ...rangeFromTypeScriptDiagnostic(diagnostic.file, diagnostic.start, diagnostic.length ?? 1),
  }
}

/** 一个文件都没诊断时的空结果：必须带上原因，空列表不能看起来像全部通过。 */
export function emptyDiagnostics(note: string): LanguageDiagnosticsResult {
  return { diagnostics: [], diagnosticCount: 0, scannedFiles: 0, truncated: false, note }
}

/** extensions 里一个 JavaScript / TypeScript 扩展名都没有时的说明。 */
export function noJsTsExtensionNote(extensions: readonly string[]): string {
  return (
    `extensions 里没有 JavaScript/TypeScript 扩展名（${extensions.join('/')}），` +
    '未做诊断。这不代表代码没有错误。'
  )
}

/** 调用方传了本服务不诊断的扩展名时的说明。 */
export function ignoredExtensionsNote(extensions: readonly string[]): string {
  return `JavaScript/TypeScript 诊断不处理扩展名 ${extensions.join('/')}，这些文件未做诊断。`
}

/** 目录下一个可诊断源文件都没找到时的说明。 */
export function noSourceFileNote(input: {
  path: string
  maxDepth: number
  extensions: readonly string[]
  skippedDirectories: readonly string[]
  extensionNote?: LooseOptional<string>
}): string {
  return (
    `${input.extensionNote ?? ''}未找到可诊断的源文件：${input.path} 下 ${input.maxDepth} 层以内` +
    `没有扩展名为 ${input.extensions.join('/')} 的文件（已跳过 .gitignore 忽略的文件与 ` +
    `${input.skippedDirectories.join('/')} 目录）。这不代表代码没有错误。`
  )
}
