/** 外部命令原语：命令的可读描述、MarkItDown 命令行、LibreOffice 的候选命令名。 */

import type { MarkItDownLaunchSpec, OfficeNativeCommand } from '../types/office.js'

/**
 * 把原生命令渲染成给人和模型看的一行描述。
 *
 * 每段都按 JSON 字面量转义：命令与参数只经 argv 交给宿主，描述串纯粹用于展示和审批，
 * 不会被谁再当成 shell 语法解析；引号、`$(…)`、反引号在这里都只是字面文本。
 */
export function describeOfficeNativeCommand(command: OfficeNativeCommand): string {
  return [command.file, ...command.args].map((value) => JSON.stringify(value)).join(' ')
}

/** 组装 MarkItDown 的原生命令；给了输出路径就让它直接写文件。 */
export function buildMarkItDownCommand(input: {
  launch: MarkItDownLaunchSpec
  inputPath: string
  outputPath?: string
}): OfficeNativeCommand {
  return { file: input.launch.command, args: [input.inputPath, ...(input.outputPath ? ['-o', input.outputPath] : [])] }
}

/** LibreOffice 的候选命令名，按优先级排列；最后一个是 macOS 上 App 包里的可执行文件。 */
export function libreOfficeCommandCandidates(): string[] {
  return ['soffice', 'libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
}
