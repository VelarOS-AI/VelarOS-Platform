/**
 * 把诊断编成回灌给模型的那段文字。
 *
 * **必须带代码帧。** 模型吐出来的程序是一段裸文本，它自己看不见行号；只回「(2,29) TS2551」等于
 * 让它靠数行定位，而数行是模型最不准的事之一。把那一行连同一个插字符摆出来，它一眼就知道改哪儿。
 */

import type { CodeProgramDiagnostic } from '../types/code-surface.js'

import { CodeSurfaceTuning } from './tuning.js'

/** 一条诊断的代码帧：行号、原文那一行、下面一个指向出错列的插字符。 */
function renderFrame(sourceLines: readonly string[], diagnostic: CodeProgramDiagnostic): string[] {
  const line = sourceLines[diagnostic.line - 1]
  if (line === undefined) return []
  const gutter = String(diagnostic.line)
  const clipped =
    line.length > CodeSurfaceTuning.frameLineChars
      ? `${line.slice(0, CodeSurfaceTuning.frameLineChars)}…`
      : line
  const caretColumn = Math.min(diagnostic.column, clipped.length + 1)
  return [
    `  ${gutter} | ${clipped}`,
    `  ${' '.repeat(gutter.length)} | ${' '.repeat(Math.max(0, caretColumn - 1))}^`,
  ]
}

/**
 * 编成给模型看的整段诊断。
 *
 * 末尾那句是改法指引：**优先按 `match` 改**，不用数行号——模型看不见自己代码的行号，
 * 让它数行是在让它做最不擅长的事。
 */
export function renderDiagnostics(source: string, diagnostics: readonly CodeProgramDiagnostic[]): string {
  const sourceLines = source.split('\n')
  const body = diagnostics.flatMap((diagnostic) => [
    `(${diagnostic.line},${diagnostic.column}) TS${diagnostic.code}: ${diagnostic.message}`,
    ...renderFrame(sourceLines, diagnostic),
  ])
  return [
    'typecheck 没过，程序一行都没有执行：',
    ...body,
    '改的时候不用重发整份程序：传 edits，oldText 写上面框出来的那段原文（一字不差、在程序里唯一），newText 写新的。',
  ].join('\n')
}
