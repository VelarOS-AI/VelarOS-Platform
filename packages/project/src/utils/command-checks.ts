// 域：外部命令检查（prettier、eslint、tsc）当校验器或修复器跑时共用的规则数据与小工具。
// 命令都经宿主注入的命令提供者执行；超时在 ProjectTuning.plugins。
import type { ProjectFixContext } from '../types/fix.js'
import type { CommandValidatorOptions } from '../types/plugins.js'
import type { CommandRunResult } from '../types/provider.js'

import { ProjectTuning } from './tuning.js'

/** prettier 检查与格式化覆盖的扩展名。 */
export const PrettierExtensions: readonly string[] = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.json', '.md'])

/** eslint 检查与自动修复覆盖的扩展名。 */
export const EslintExtensions: readonly string[] = Object.freeze(['.js', '.jsx', '.ts', '.tsx'])

/** tsc 类型检查覆盖的扩展名。 */
export const TscExtensions: readonly string[] = Object.freeze(['.ts', '.tsx'])

/** prettier 当命令校验器时的参数：new CommandValidator(prettierCheck()) 就是一个 prettier 校验器；args 替换默认的 prettier --check .。 */
export function prettierCheck(args: string[] = ['prettier', '--check', '.']): CommandValidatorOptions {
  return { id: 'external.prettier', command: 'npx', args, fileExtensions: [...PrettierExtensions], timeoutMs: ProjectTuning.plugins.prettierTimeoutMs }
}

/** eslint 当命令校验器时的参数；args 替换默认的 eslint .。 */
export function eslintCheck(args: string[] = ['eslint', '.']): CommandValidatorOptions {
  return { id: 'external.eslint', command: 'npx', args, fileExtensions: [...EslintExtensions], timeoutMs: ProjectTuning.plugins.eslintTimeoutMs }
}

/** tsc 类型检查当命令校验器时的参数；args 替换默认的 tsc --noEmit。 */
export function tscCheck(args: string[] = ['tsc', '--noEmit']): CommandValidatorOptions {
  return { id: 'external.tsc', command: 'npx', args, fileExtensions: [...TscExtensions], timeoutMs: ProjectTuning.plugins.tscTimeoutMs }
}

/** 路径是不是以其中一个扩展名结尾。 */
export function pathMatchesExtensions(pathValue: string, extensions: readonly string[]): boolean {
  return extensions.some((ext) => pathValue.endsWith(ext))
}

/** 在项目根上跑一条修复命令，文件正文从 stdin 喂进去。 */
export async function runFixCommand(
  ctx: ProjectFixContext,
  input: {
    command: string
    args: string[]
    stdin: string
    timeoutMs?: number
  },
): Promise<CommandRunResult> {
  return ctx.providers.command.run({
    command: input.command,
    args: input.args,
    cwd: ctx.root,
    timeoutMs: input.timeoutMs,
    stdin: input.stdin,
  })
}
