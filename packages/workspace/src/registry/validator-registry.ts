import { isEmpty, optionalWhen } from '@velaros-ai/core'

import type { ValidateInput, ValidationResult, WorkspaceValidator } from "../types/validation.js";

/** 管理 workspace validator，并把多个校验器结果合并为一次 validate 输出。 */
export class ValidatorRegistry {
  private validators: WorkspaceValidator[] = [];

  /** 注册一个可参与 validate 流程的 validator。 */
  public register(validator: WorkspaceValidator): void {
    this.validators.push(validator);
  }

  /** 返回当前已注册的 validator id。 */
  public listIds(): string[] {
    return this.validators.map((v) => v.id);
  }

  /** 执行符合输入条件的 validator，并汇总诊断、检查项和工具需求。 */
  public async validate(input: ValidateInput, ctx: any): Promise<ValidationResult> {
    const checks: ValidationResult["checks"] = [];
    const diagnostics: ValidationResult["diagnostics"] = [];
    const toolRequirements: NonNullable<ValidationResult["toolRequirements"]> = [];
    for (const validator of this.validators) {
      if (
        (!input.checks || isEmpty(input.checks) || input.checks.includes(validator.id)) &&
        validator.canValidate(input)
      ) {
        const result = await validator.validate(input, ctx);
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
