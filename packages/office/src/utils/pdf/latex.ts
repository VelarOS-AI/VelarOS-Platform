/** LaTeX 编译原语：默认源码路径、编译器候选顺序、各编译器的命令行。 */

import { extname } from 'node:path'

import type { OfficeEnvironmentCommandAvailability, OfficeNativeCommand } from '../../types/office.js'
import type { LatexCompiler } from '../../types/pdf.js'
import { OfficeTuning } from '../tuning.js'

/** 未显式指定 sourcePath 时，默认把输出 PDF 同名路径改成 .tex。 */
export function getDefaultLatexSourcePath(outputPath: string): string {
  const extension = extname(outputPath)
  return extension ? `${outputPath.slice(0, -extension.length)}.tex` : `${outputPath}.tex`
}

/** auto 模式按偏好顺序尝试：tectonic 更独立，latexmk 更完整，然后落到 xelatex/pdflatex。 */
export function resolveLatexCompilerCandidates(compiler?: LatexCompiler): string[] {
  switch (compiler ?? 'auto') {
    case 'tectonic':
      return ['tectonic']
    case 'latexmk':
      return ['latexmk']
    case 'xelatex':
      return ['xelatex']
    case 'pdflatex':
      return ['pdflatex']
    case 'auto':
      return ['tectonic', 'latexmk', 'xelatex', 'pdflatex']
  }
}

/** 按不同编译器生成命令行；xelatex/pdflatex 需要多轮运行来解析引用和目录。 */
export function buildLatexCompileCommands(input: {
  compiler: OfficeEnvironmentCommandAvailability
  sourceFileName: string
  tempDir: string
  runs?: number
}): OfficeNativeCommand[] {
  const file = input.compiler.path || input.compiler.name
  const source = input.sourceFileName
  const output = input.tempDir

  switch (input.compiler.name) {
    case 'tectonic':
      return [
        { file, args: [
          '--keep-logs',
          '--keep-intermediates',
          '--outdir',
          output,
          source,
        ] },
      ]
    case 'latexmk':
      return [
        { file, args: [
          '-pdf',
          '-interaction=nonstopmode',
          '-halt-on-error',
          `-outdir=${output}`,
          source,
        ] },
      ]
    case 'xelatex':
    case 'pdflatex': {
      const runCount = input.runs ?? OfficeTuning.pdf.latexRuns
      const command: OfficeNativeCommand = { file, args: [
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${output}`,
        source,
      ] }
      return Array.from({ length: runCount }, () => command)
    }
    default:
      return [
        { file, args: [
          '-interaction=nonstopmode',
          '-halt-on-error',
          `-output-directory=${output}`,
          source,
        ] },
      ]
  }
}
