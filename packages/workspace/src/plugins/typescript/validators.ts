import { isEmpty } from '@velaros-ai/core'

import type { ValidateInput, ValidationResult, WorkspaceValidator } from "../../types/validation.js";

import { parseTs } from "./ast.js";

function empty(): ValidationResult {
  return { ok: true, diagnostics: [], checks: [] };
}

export function typescriptSyntaxValidator(): WorkspaceValidator {
  return {
    id: "velaros.typescript.syntax-validator",
    canValidate(input: ValidateInput) {
      return !input.checks || input.checks.includes("typescript.syntax") || input.checks.includes("parse") || input.checks.includes("syntax");
    },
    async validate(input: ValidateInput, ctx: any): Promise<ValidationResult> {
      const paths = input.paths ?? (input.transactionId ? ctx.getTransaction?.(input.transactionId)?.changedFiles ?? [] : []);
      const result = empty();
      for (const path of paths.filter((p: string) => /\.[cm]?[jt]sx?$/.test(p))) {
        const content = await ctx.readFile(path);
        const parsed = parseTs(path, content ?? "");
        const diagnostics = parsed.diagnostics.map((diagnostic) => ({
          severity: "error" as const,
          message: `TypeScript 语法错误：${String(diagnostic.messageText)}`,
          source: "typescript.syntax",
          data: { code: diagnostic.code },
        }));
        result.diagnostics.push(...diagnostics);
        result.checks.push({ id: `typescript.syntax:${path}`, ok: isEmpty(diagnostics), diagnostics });
      }
      result.ok = isEmpty(result.diagnostics);
      return result;
    },
  };
}
