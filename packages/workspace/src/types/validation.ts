import type { Diagnostic } from "./common.js";
import type { CommandToolRequirement } from "./provider.js";

/** 面向事务、显式路径、指定检查项和后置条件的校验请求。 */
export interface ValidateInput {
  transactionId?: string;
  paths?: string[];
  checks?: string[];
  postconditions?: Postcondition[];
}

export interface ValidationCheckResult {
  id: string;
  ok: boolean;
  /** 单个检查项的诊断信息；需要时会汇总到整体结果。 */
  diagnostics?: Diagnostic[];
  metadata?: any;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  checks: ValidationCheckResult[];
  toolRequirements?: CommandToolRequirement[];
}

export interface Postcondition {
  /** 事务准备完成后要检查的声明式不变量。 */
  type:
    | "must_contain"
    | "must_not_contain"
    | "must_keep_symbol"
    | "must_modify_symbol"
    | "must_not_modify_symbol"
    | "changed_files_allowlist"
    | "max_changed_lines"
    | "schema_valid"
    | "layout_preserved"
    | "formula_preserved"
    | "custom";
  value: any;
}

export interface WorkspaceValidator {
  id: string;
  /** 快速过滤器，让 registry 跳过与本次请求无关的 validator。 */
  canValidate(input: ValidateInput): boolean;
  validate(input: ValidateInput, ctx: any): Promise<ValidationResult> | ValidationResult;
}
