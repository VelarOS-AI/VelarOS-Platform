/**
 * eslint 修复器：`EslintFixer`，实现注入面的 `ProjectFixer`（contract/requires.ts）。
 * 把事务里每个适用文件的暂存正文经 stdin 交给 eslint --fix-dry-run，从 JSON 报告里取修好的正文作为修复；
 * 没有可用的修复且命令失败时给出诊断。
 */

import { isArray, isEmpty, isPlainObject, isString } from '@velaros-ai/core'

import type { ProjectFixer } from '../../contract/requires.js'
import type { FixInput, FixResult, ProjectFixContext } from '../../types/fix.js'
import { emptyFixResult, EslintExtensions, pathMatchesExtensions, runFixCommand } from '../../utils/command-checks.js'
import { ProjectTuning } from '../../utils/tuning.js'

export class EslintFixer implements ProjectFixer {
  public readonly id = 'external.eslint'
  /** 用户给的 eslint 参数去掉 .、--fix、--fix-dry-run 之后剩下的部分；按文件经 stdin 修复时由这里补上需要的参数。 */
  private readonly baseArgs: string[]

  public constructor(args: string[] = ['eslint']) {
    this.baseArgs = args.filter((arg) => arg !== '.' && arg !== '--fix' && arg !== '--fix-dry-run')
  }

  public canFix(input: FixInput): boolean {
    return !input.checks || isEmpty(input.checks) || input.checks.includes(this.id)
  }

  public async fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> {
    const paths = input.paths?.filter((pathValue) => pathMatchesExtensions(pathValue, EslintExtensions)) ?? []
    const result = emptyFixResult(input)
    for (const pathValue of paths) {
      const content = await ctx.readFile(pathValue)
      if (!isString(content)) continue
      const commandResult = await runFixCommand(ctx, {
        command: 'npx',
        args: [
          ...(!isEmpty(this.baseArgs) ? this.baseArgs : ['eslint']),
          '--fix-dry-run',
          '--format',
          'json',
          '--stdin',
          '--stdin-filename',
          pathValue,
        ],
        stdin: content,
        timeoutMs: ProjectTuning.plugins.eslintTimeoutMs,
      })
      if (commandResult.toolRequirements && !isEmpty(commandResult.toolRequirements)) {
        result.toolRequirements = [...(result.toolRequirements ?? []), ...commandResult.toolRequirements]
      }
      const output = [commandResult.stdout, commandResult.stderr].filter(Boolean).join('\n').trim()
      let parsed: any
      try {
        parsed = commandResult.stdout ? JSON.parse(commandResult.stdout) : []
      } catch {
        // arch-guard:silent-catch-ok command stdout 非 JSON 时按空结果继续校验。
        parsed = null
      }
      const first = isArray(parsed) && isPlainObject(parsed[0]) ? parsed[0] : null
      const fixed = first && isString(first.output) ? first.output : null
      if (fixed && fixed !== content) {
        result.changed = true
        result.changedFiles.push(pathValue)
        result.fixes.push({ path: pathValue, content: fixed, source: this.id })
      }
      if (commandResult.exitCode !== 0 && !fixed) {
        result.ok = false
        result.diagnostics.push({
          severity: 'error',
          path: pathValue,
          source: `${this.id}.fix`,
          message: output || 'eslint 自动修复失败',
        })
      }
    }
    result.changedFiles = [...new Set(result.changedFiles)]
    return result
  }
}
