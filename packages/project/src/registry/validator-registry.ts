import { isEmpty, optionalWhen } from '@velaros-ai/core'

import type {
  ProjectValidationContext,
  ProjectValidator,
  ValidateInput,
  ValidationResult,
} from "../types/validation.js";

function isSelectedValidator(validator: ProjectValidator, checks?: readonly string[]): boolean {
  if (!checks || isEmpty(checks)) return true;
  return [validator.id, ...(validator.checkIds ?? [])].some((id) => checks.includes(id));
}

/** 管理 project validator，并把多个校验器结果合并为一次 validate 输出。 */
export class ValidatorRegistry {
  private validators: ProjectValidator[] = [];

  /** 注册一个可参与 validate 流程的 validator。 */
  public register(validator: ProjectValidator): void {
    this.validators.push(validator);
  }

  /** 返回当前已注册的 validator id。 */
  public listIds(): string[] {
    return this.validators.map((v) => v.id);
  }

  /** 执行符合输入条件的 validator，并汇总诊断、检查项和工具需求。 */
  public async validate(
    input: ValidateInput,
    context: ProjectValidationContext,
  ): Promise<ValidationResult> {
    const checks: ValidationResult["checks"] = [];
    const diagnostics: ValidationResult["diagnostics"] = [];
    const toolRequirements: NonNullable<ValidationResult["toolRequirements"]> = [];
    for (const validator of this.validators) {
      if (isSelectedValidator(validator, input.checks) && validator.canValidate(input)) {
        const result = await validator.validate(input, context);
        checks.push({ id: validator.id, ok: result.ok, diagnostics: result.diagnostics });
        diagnostics.push(...result.diagnostics);
        if (result.toolRequirements && !isEmpty(result.toolRequirements)) {
          toolRequirements.push(...result.toolRequirements);
        }
      }
    }
    return {
      ok: diagnostics.every((d) => d.severity !== "error"),
      diagnostics,
      checks,
      toolRequirements: optionalWhen(toolRequirements.length, toolRequirements),
    };
  }
}
