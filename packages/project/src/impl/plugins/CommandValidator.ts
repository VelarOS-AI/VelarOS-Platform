/**
 * 外部命令校验器：`CommandValidator`，实现注入面的 `ProjectValidator`（contract/requires.ts）。
 * 在项目根（或给定的 cwd）跑一条命令，退出码为 0 算通过，否则把 stdout、stderr 合成一条诊断；命令经宿主注入的命令提供者执行。
 * prettier、eslint、tsc 的现成参数见 utils/command-checks.ts。
 */

import { isEmpty } from '@velaros-ai/core'

import type { ProjectValidator } from '../../contract/requires.js'
import type { CommandValidatorOptions } from '../../types/plugins.js'
import type { ProjectValidationContext, ValidateInput, ValidationResult } from '../../types/validation.js'
import { pathMatchesExtensions } from '../../utils/command-checks.js'

export class CommandValidator implements ProjectValidator {
  public readonly id: string

  public constructor(private readonly options: CommandValidatorOptions) {
    this.id = options.id
  }

  public canValidate(input: ValidateInput): boolean {
    if (this.options.when && !this.options.when(input)) return false
    const extensions = this.options.fileExtensions
    if (!extensions || isEmpty(extensions)) return true
    const paths = input.paths ?? []
    return paths.some((path) => pathMatchesExtensions(path, extensions))
  }

  public async validate(_input: ValidateInput, context: ProjectValidationContext): Promise<ValidationResult> {
    const result = await context.providers.command.run({
      command: this.options.command,
      args: this.options.args ?? [],
      cwd: this.options.cwd ?? context.root,
      timeoutMs: this.options.timeoutMs,
    })
    const ok = result.exitCode === 0
    const message = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    const diagnostic = ok ? [] : [{ severity: 'error' as const, message: message || `${this.options.command} 执行失败，退出码 ${result.exitCode}`, source: this.id }]
    return {
      ok,
      diagnostics: diagnostic,
      checks: [{ id: this.id, ok, diagnostics: diagnostic }],
      toolRequirements: result.toolRequirements,
    }
  }
}
