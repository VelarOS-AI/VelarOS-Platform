/**
 * prettier 修复器：`PrettierFixer`，实现注入面的 `ProjectFixer`（contract/requires.ts）。
 * 把事务里每个适用文件的暂存正文经 stdin 交给 prettier 格式化，拿回的正文作为修复；命令失败时给出诊断，不改这个文件。
 */

import { isEmpty, isString } from '@velaros-ai/core'

import type { ProjectFixer } from '../../contract/requires.js'
import type { FixInput, FixResult, ProjectFixContext } from '../../types/fix.js'
import { emptyFixResult } from '../../utils/checks.js'
import { pathMatchesExtensions, PrettierExtensions, runFixCommand } from '../../utils/command-checks.js'
import { ProjectTuning } from '../../utils/tuning.js'

export class PrettierFixer implements ProjectFixer {
  public readonly id = 'external.prettier'
  /** 用户给的 prettier 参数去掉 --check、--write、. 之后剩下的部分；按文件经 stdin 格式化时不能带它们。 */
  private readonly baseArgs: string[]

  public constructor(args: string[] = ['prettier']) {
    this.baseArgs = args.filter((arg) => arg !== '--check' && arg !== '--write' && arg !== '.')
  }

  public canFix(input: FixInput): boolean {
    return !input.checks || isEmpty(input.checks) || input.checks.includes(this.id)
  }

  public async fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> {
    const paths = input.paths?.filter((pathValue) => pathMatchesExtensions(pathValue, PrettierExtensions)) ?? []
    const result = emptyFixResult(input.transactionId)
    for (const pathValue of paths) {
      const content = await ctx.readFile(pathValue)
      if (!isString(content)) continue
      const commandResult = await runFixCommand(ctx, {
        command: 'npx',
        args: [...(!isEmpty(this.baseArgs) ? this.baseArgs : ['prettier']), '--stdin-filepath', pathValue],
        stdin: content,
        timeoutMs: ProjectTuning.plugins.prettierTimeoutMs,
      })
      if (commandResult.toolRequirements && !isEmpty(commandResult.toolRequirements)) {
        result.toolRequirements = [...(result.toolRequirements ?? []), ...commandResult.toolRequirements]
      }
      if (commandResult.exitCode !== 0) {
        result.ok = false
        result.diagnostics.push({
          severity: 'error',
          path: pathValue,
          source: `${this.id}.fix`,
          message: [commandResult.stdout, commandResult.stderr].filter(Boolean).join('\n').trim() || 'prettier 自动修复失败',
        })
        continue
      }
      if (commandResult.stdout !== content) {
        result.changed = true
        result.changedFiles.push(pathValue)
        result.fixes.push({ path: pathValue, content: commandResult.stdout, source: this.id })
      }
    }
    result.changedFiles = [...new Set(result.changedFiles)]
    return result
  }
}
