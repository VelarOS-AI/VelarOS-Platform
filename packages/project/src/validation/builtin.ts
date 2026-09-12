import { isEmpty,isPresent } from "@velaros-ai/core";

import type {
  ProjectValidator,
  ValidateInput,
  ValidationResult,
} from "../types/validation.js";
import { matchesAny } from "../utils/glob.js";

export function scopeValidator(): ProjectValidator {
  return {
    id: "core.scope",
    canValidate() {
      return true;
    },
    validate(input: ValidateInput, context): ValidationResult {
      const diagnostics: ValidationResult["diagnostics"] = [];
      const tx = input.transactionId ? context.getTransaction(input.transactionId) : undefined;
      if (tx) {
        if (tx.changedFiles.length > context.policy.maxChangedFilesPerTransaction) {
          diagnostics.push({ severity: "error", message: `变更文件过多：${tx.changedFiles.length}`, source: "core.scope" });
        }
        if (tx.changedLines > context.policy.maxChangedLinesPerTransaction) {
          diagnostics.push({ severity: "error", message: `变更行数过多：${tx.changedLines}`, source: "core.scope" });
        }
        for (const file of tx.changedFiles) {
          if (matchesAny(file, context.policy.protectedFiles)) {
            diagnostics.push({ severity: "error", message: `受保护文件被修改：${file}`, path: file, source: "core.scope" });
          }
        }
      }
      return { ok: isEmpty(diagnostics), diagnostics, checks: [{ id: "core.scope", ok: isEmpty(diagnostics), diagnostics }] };
    },
  };
}

export function postconditionValidator(): ProjectValidator {
  return {
    id: "core.postcondition",
    canValidate(input) {
      return !!input.postconditions && !isEmpty(input.postconditions);
    },
    async validate(input: ValidateInput, context): Promise<ValidationResult> {
      const diagnostics: ValidationResult["diagnostics"] = [];
      const tx = input.transactionId ? context.getTransaction(input.transactionId) : undefined;
      for (const post of input.postconditions ?? []) {
        if (post.type === "changed_files_allowlist" && tx) {
          const allow = post.value as string[];
          for (const file of tx.changedFiles) {
            if (!allow.includes(file)) diagnostics.push({ severity: "error", message: `变更文件不在允许列表中：${file}`, path: file, source: "core.postcondition" });
          }
        }
        if (post.type === "max_changed_lines" && tx) {
          const max = Number(post.value);
          if (tx.changedLines > max) diagnostics.push({ severity: "error", message: `变更行数 ${tx.changedLines} 超过上限 ${max}`, source: "core.postcondition" });
        }
        if ((post.type === "must_contain" || post.type === "must_not_contain") && tx) {
          const needle = String(post.value);
          for (const file of tx.changedFiles) {
            const content = await context.readFile(file);
            if (!isPresent(content)) continue;
            if (post.type === "must_contain" && !content.includes(needle)) diagnostics.push({ severity: "error", message: `文件必须包含：${needle}`, path: file, source: "core.postcondition" });
            if (post.type === "must_not_contain" && content.includes(needle)) diagnostics.push({ severity: "error", message: `文件不能包含：${needle}`, path: file, source: "core.postcondition" });
          }
        }
      }
      return { ok: isEmpty(diagnostics), diagnostics, checks: [{ id: "core.postcondition", ok: isEmpty(diagnostics), diagnostics }] };
    },
  };
}
