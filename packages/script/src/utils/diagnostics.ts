import { CodeSurfaceTuning } from './tuning.js'

/** 为检查器的结构化诊断生成有界源码行与列定位。 */
export function renderDiagnosticFrame(source: string, line: number, column: number): string {
  const original = source.split('\n')[line - 1] ?? ''
  const text = original.length > CodeSurfaceTuning.frameLineChars ? `${original.slice(0, CodeSurfaceTuning.frameLineChars)}…` : original
  const gutter = String(line)
  const caret = Math.max(0, Math.min(column - 1, text.length))
  return `${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${' '.repeat(caret)}^`
}
