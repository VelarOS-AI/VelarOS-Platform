import { isEmpty } from '@velaros-ai/core'

import { isJsTsPath, jsTsSyntaxDiagnostics } from "../../adapters/jsts-ast.js";
import type {
  ProjectValidator,
  ValidateInput,
  ValidationResult,
} from "../../types/validation.js";

export function typescriptSyntaxValidator(): ProjectValidator {
  return {
    id: "velaros.typescript.syntax-validator",
    checkIds: ["typescript.syntax", "parse", "syntax"],
    canValidate(input: ValidateInput) {
      return !input.checks || isEmpty(input.checks) || input.checks.some((check) =>
        check === "velaros.typescript.syntax-validator"
        || check === "typescript.syntax"
        || check === "parse"
        || check === "syntax"
      );
    },
    async validate(input: ValidateInput, context): Promise<ValidationResult> {
      const paths = input.paths
        ?? (input.transactionId
          ? context.getTransaction(input.transactionId)?.changedFiles ?? []
          : []);
      const result: ValidationResult = { ok: true, diagnostics: [], checks: [] };
      for (const path of paths.filter(isJsTsPath)) {
        const content = await context.readFile(path);
        const diagnostics = jsTsSyntaxDiagnostics(path, content ?? "", "typescript.syntax");
        result.diagnostics.push(...diagnostics);
        result.checks.push({ id: `typescript.syntax:${path}`, ok: isEmpty(diagnostics), diagnostics });
      }
      result.ok = isEmpty(result.diagnostics);
      return result;
    },
  };
}
