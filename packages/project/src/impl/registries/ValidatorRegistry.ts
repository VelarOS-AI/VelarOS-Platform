/**
 * 校验器登记表：`ValidatorRegistry`。接口 `ValidatorRegistryApi` 在本文件的类上方。
 */

import { isEmpty, isUndefined, optionalWhen } from '@velaros-ai/core'

import type { ProjectValidator } from '../../contract/requires.js'
import type { ProjectValidationContext, ValidateInput, ValidationResult } from '../../types/validation.js'
import { isSelectedValidator } from '../../utils/checks.js'
import { ProjectTuning } from '../../utils/tuning.js'

/**
 * 管理 project validator（插件经 registerValidator 登记），把多个校验器的结果合并成一次 validate 输出。
 * 声明了 cacheKey 的 validator，完全通过的结果按依赖指纹缓存复用（每个 validator 的条数与单份大小有上限，见 ProjectTuning.transactions）。
 * 实例由内核持有，一个内核一份。
 */
export interface ValidatorRegistryApi {
  /** 登记一个可参与 validate 流程的 validator；按登记顺序运行。 */
  register(validator: ProjectValidator): void
  /** 已登记的 validator 号，按登记顺序。 */
  listIds(): string[]
  /**
   * 依次运行被本次 checks 选中且 canValidate 为真的 validator，每个 validator 各记一项检查，汇总诊断与工具需求；
   * ok 要求每项检查通过且没有 error 级诊断。命中缓存的检查在 metadata 里标 reused。validator 抛出的错误原样抛出。
   */
  validate(input: ValidateInput, context: ProjectValidationContext): Promise<ValidationResult>
}

export class ValidatorRegistry implements ValidatorRegistryApi {
  private validators: ProjectValidator[] = []
  private readonly cache = new WeakMap<ProjectValidator, Map<string, ValidationResult>>()

  public register(validator: ProjectValidator): void {
    this.validators.push(validator)
  }

  public listIds(): string[] {
    return this.validators.map((v) => v.id)
  }

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
          JSON.stringify(result).length <= ProjectTuning.transactions.validationCacheResultChars
        ) {
          entries.set(cacheKey, structuredClone(result))
          while (entries.size > ProjectTuning.transactions.validationCacheEntries) entries.delete(entries.keys().next().value!)
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
