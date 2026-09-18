/**
 * 把诊断编成回灌给模型的那段文字。
 *
 * **必须带代码帧。** 模型吐出来的程序是一段裸文本，它自己看不见行号；只回「(2,29) TS2551」等于
 * 让它靠数行定位，而数行是模型最不准的事之一。把那一行连同一个插字符摆出来，它一眼就知道改哪儿。
 */

import { isUndefined } from '@velaros-ai/core'

import type { CodeProgramDiagnostic } from '../types/code-surface.js'

import { CodeSurfaceTuning } from './tuning.js'

/** 一条诊断的代码帧：行号、原文那一行、下面一个指向出错列的插字符。 */
function renderFrame(sourceLines: readonly string[], diagnostic: CodeProgramDiagnostic): string[] {
  const line = sourceLines[diagnostic.line - 1]
  if (isUndefined(line)) return []
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
 * 编成给模型看的整段诊断：每条一行位置与说明，下面是代码帧。出在库里别的脚本上的，位置前面写上那个脚本的路径，
 * 代码帧取自那个脚本（modules 里给的那一份）。怎么改（在哪一步上用 edits）由调用方接在后面，它知道步骤号。
 */
export function renderDiagnostics(
  source: string,
  diagnostics: readonly CodeProgramDiagnostic[],
  modules: Readonly<Record<string, string>> = {},
): string {
  const linesOf = (file: Optional<string>): readonly string[] => (isUndefined(file) ? source : modules[file] ?? '').split('\n')
  const body = diagnostics.flatMap((diagnostic) => [
    `${isUndefined(diagnostic.file) ? '' : `${diagnostic.file} `}(${diagnostic.line},${diagnostic.column}) TS${diagnostic.code}: ${diagnostic.message}`,
    ...renderFrame(linesOf(diagnostic.file), diagnostic),
  ])
  return ['typecheck 没过，代码一行都没有执行：', ...body].join('\n')
}
