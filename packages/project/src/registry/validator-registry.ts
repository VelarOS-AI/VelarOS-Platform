import { isEmpty, isUndefined, optionalWhen } from '@velaros-ai/core'

import type {
  ProjectValidationContext,
  ProjectValidator,
  ValidateInput,
  ValidationResult,
} from '../types/validation.js'

function isSelectedValidator(validator: ProjectValidator, checks?: readonly string[]): boolean {
  if (!checks || isEmpty(checks)) return true
  return [validator.id, ...(validator.checkIds ?? [])].some((id) => checks.includes(id))
}

/** 管理 project validator，并把多个校验器结果合并为一次 validate 输出。 */
export class ValidatorRegistry {
  private validators: ProjectValidator[] = []
  private readonly cache = new WeakMap<ProjectValidator, Map<string, ValidationResult>>()

  /** 注册一个可参与 validate 流程的 validator。 */
  public register(validator: ProjectValidator): void {
    this.validators.push(validator)
  }

  /** 返回当前已注册的 validator id。 */
  public listIds(): string[] {
    return this.validators.map((v) => v.id)
  }

  /** 执行符合输入条件的 validator，并汇总诊断、检查项和工具需求。 */
  public async validate(
    input: ValidateInput,
    context: ProjectValidationContext
  ): Promise<ValidationResult> {
    const checks: ValidationResult['checks'] = []
    const diagnostics: ValidationResult['diagnostics'] = []
    const toolRequirements: NonNullable<ValidationResult['toolRequirements']> = []
    for (const validator of this.validators) {
      if (isSelectedValidator(validator, input.checks) && validator.canValidate(input)) {
        const reads = new Map<string, Promise<string | undefined>>()
        const view = !validator.cacheKey
          ? context
          : Object.freeze({
              ...context,
              readFile: (path: string) => {
                let content = reads.get(path)
                if (!content) {
                  content = context.readFile(path)
                  reads.set(path, content)
                }
                return content
              },
            })
        const dependencyKey = await validator.cacheKey?.(input, view)
        const cacheKey =
          isUndefined(dependencyKey) ? undefined : JSON.stringify([context.root, dependencyKey])
        let entries = this.cache.get(validator)
        if (!entries) {
          entries = new Map()
          this.cache.set(validator, entries)
        }
        const saved = isUndefined(cacheKey) ? undefined : entries.get(cacheKey)
        const result = saved ? structuredClone(saved) : await validator.validate(input, view)
        if (
          !saved &&
          !isUndefined(cacheKey) &&
          result.ok &&
          result.checks.every((check) => check.ok) &&
          !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error') &&
          JSON.stringify(result).length <= 256_000
        ) {
          entries.set(cacheKey, structuredClone(result))
          while (entries.size > 128) entries.delete(entries.keys().next().value!)
        }
        checks.push({
          id: validator.id,
          ok: result.ok && result.checks.every((check) => check.ok),
          diagnostics: result.diagnostics,
          metadata: optionalWhen(!isUndefined(cacheKey), { evidenceKey: dependencyKey, reused: !!saved }),
        })
        diagnostics.push(...result.diagnostics)
        if (result.toolRequirements && !isEmpty(result.toolRequirements)) {
          toolRequirements.push(...result.toolRequirements)
        }
      }
    }
    return {
      ok: checks.every((check) => check.ok) && diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      checks,
      toolRequirements: optionalWhen(toolRequirements.length, toolRequirements),
    }
  }
}
