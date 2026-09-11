import { isEmpty } from '@velaros-ai/core'

import { isJsTsPath, jsTsSyntaxDiagnostics } from "../../adapters/jsts-ast.js";
import type { ProjectValidator,ValidateInput, ValidationResult } from "../../types/validation.js";

export function typescriptSyntaxValidator(): ProjectValidator {
  return {
    id: "velaros.typescript.syntax-validator",
    canValidate(input: ValidateInput) {
      return !input.checks || input.checks.includes("typescript.syntax") || input.checks.includes("parse") || input.checks.includes("syntax");
    },
    async validate(input: ValidateInput, ctx: any): Promise<ValidationResult> {
      const paths: string[] = input.paths ?? (input.transactionId ? ctx.getTransaction?.(input.transactionId)?.changedFiles ?? [] : []);
      const result: ValidationResult = { ok: true, diagnostics: [], checks: [] };
      for (const path of paths.filter(isJsTsPath)) {
        const content = await ctx.readFile(path);
        const diagnostics = jsTsSyntaxDiagnostics(path, content ?? "", "typescript.syntax");
        result.diagnostics.push(...diagnostics);
        result.checks.push({ id: `typescript.syntax:${path}`, ok: isEmpty(diagnostics), diagnostics });
      }
      result.ok = isEmpty(result.diagnostics);
      return result;
    },
  };
}
