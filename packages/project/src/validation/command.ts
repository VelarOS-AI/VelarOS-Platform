import { isArray,isEmpty, isPlainObject, isString } from "@velaros-ai/core";

import type { FixInput, FixResult, ProjectFixContext, ProjectFixer } from "../types/fix.js";
import type {
  ProjectValidationContext,
  ProjectValidator,
  ValidateInput,
  ValidationResult,
} from "../types/validation.js";

export interface CommandValidatorOptions {
  id: string;
  command: string;
  args?: string[];
  fileExtensions?: string[];
  timeoutMs?: number;
  cwd?: string;
  when?: (input: ValidateInput) => boolean;
}

async function runCommand(options: CommandValidatorOptions, context: ProjectValidationContext) {
  return context.providers.command.run({
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd ?? context.root,
    timeoutMs: options.timeoutMs,
  });
}

async function runFixCommand(
  ctx: ProjectFixContext,
  input: {
    command: string;
    args: string[];
    stdin: string;
    timeoutMs?: number;
  },
) {
  return ctx.providers.command.run({
    command: input.command,
    args: input.args,
    cwd: ctx.root,
    timeoutMs: input.timeoutMs,
    stdin: input.stdin,
  });
}

function pathMatchesExtensions(pathValue: string, extensions: string[]): boolean {
  return extensions.some((ext) => pathValue.endsWith(ext));
}

function emptyFixResult(input: FixInput): FixResult {
  return {
    ok: true,
    changed: false,
    transactionId: input.transactionId,
    changedFiles: [],
    fixes: [],
    diagnostics: [],
  };
}

export function commandValidator(options: CommandValidatorOptions): ProjectValidator {
  return {
    id: options.id,
    canValidate(input) {
      if (options.when && !options.when(input)) return false;
      if (!options.fileExtensions || isEmpty(options.fileExtensions)) return true;
      const paths = input.paths ?? [];
      return paths.some((p) => options.fileExtensions!.some((ext) => p.endsWith(ext)));
    },
    async validate(input: ValidateInput, context): Promise<ValidationResult> {
      const result = await runCommand(options, context);
      const ok = result.exitCode === 0;
      const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const diagnostic = ok ? [] : [{ severity: "error" as const, message: message || `${options.command} 执行失败，退出码 ${result.exitCode}`, source: options.id }];
      return {
        ok,
        diagnostics: diagnostic,
        checks: [{ id: options.id, ok, diagnostics: diagnostic }],
        toolRequirements: result.toolRequirements,
      };
    },
  };
}

export function prettierValidator(args = ["prettier", "--check", "."]): ProjectValidator {
  return commandValidator({ id: "external.prettier", command: "npx", args, fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".json", ".md"], timeoutMs: 60_000 });
}

export function eslintValidator(args = ["eslint", "."]): ProjectValidator {
  return commandValidator({ id: "external.eslint", command: "npx", args, fileExtensions: [".js", ".jsx", ".ts", ".tsx"], timeoutMs: 60_000 });
}

export function tscValidator(args = ["tsc", "--noEmit"]): ProjectValidator {
  return commandValidator({ id: "external.tsc", command: "npx", args, fileExtensions: [".ts", ".tsx"], timeoutMs: 120_000 });
}

export function prettierFixer(args = ["prettier"]): ProjectFixer {
  const fileExtensions = [".js", ".jsx", ".ts", ".tsx", ".json", ".md"];
  const baseArgs = args.filter((arg) => arg !== "--check" && arg !== "--write" && arg !== ".");
  return {
    id: "external.prettier",
    canFix(input) {
      return !input.checks || isEmpty(input.checks) || input.checks.includes("external.prettier")
    },
    async fix(input, ctx): Promise<FixResult> {
      const paths = input.paths?.filter((pathValue) => pathMatchesExtensions(pathValue, fileExtensions)) ?? [];
      const result = emptyFixResult(input);
      for (const pathValue of paths) {
        const content = await ctx.readFile(pathValue);
        if (!isString(content)) continue;
        const commandResult = await runFixCommand(ctx, {
          command: "npx",
          args: [...(!isEmpty(baseArgs) ? baseArgs : ["prettier"]), "--stdin-filepath", pathValue],
          stdin: content,
          timeoutMs: 60_000,
        });
        if (commandResult.toolRequirements && !isEmpty(commandResult.toolRequirements)) {
          result.toolRequirements = [...(result.toolRequirements ?? []), ...commandResult.toolRequirements];
        }
        if (commandResult.exitCode !== 0) {
          result.ok = false;
          result.diagnostics.push({
            severity: "error",
            path: pathValue,
            source: "external.prettier.fix",
            message: [commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n").trim() || "prettier 自动修复失败",
          });
          continue;
        }
        if (commandResult.stdout !== content) {
          result.changed = true;
          result.changedFiles.push(pathValue);
          result.fixes.push({ path: pathValue, content: commandResult.stdout, source: "external.prettier" });
        }
      }
      result.changedFiles = [...new Set(result.changedFiles)];
      return result;
    },
  };
}

export function eslintFixer(args = ["eslint"]): ProjectFixer {
  const fileExtensions = [".js", ".jsx", ".ts", ".tsx"];
  const baseArgs = args.filter((arg) => arg !== "." && arg !== "--fix" && arg !== "--fix-dry-run");
  return {
    id: "external.eslint",
    canFix(input) {
      return !input.checks || isEmpty(input.checks) || input.checks.includes("external.eslint")
    },
    async fix(input, ctx): Promise<FixResult> {
      const paths = input.paths?.filter((pathValue) => pathMatchesExtensions(pathValue, fileExtensions)) ?? [];
      const result = emptyFixResult(input);
      for (const pathValue of paths) {
        const content = await ctx.readFile(pathValue);
        if (!isString(content)) continue;
        const commandResult = await runFixCommand(ctx, {
          command: "npx",
          args: [
            ...(!isEmpty(baseArgs) ? baseArgs : ["eslint"]),
            "--fix-dry-run",
            "--format",
            "json",
            "--stdin",
            "--stdin-filename",
            pathValue,
          ],
          stdin: content,
          timeoutMs: 60_000,
        });
        if (commandResult.toolRequirements && !isEmpty(commandResult.toolRequirements)) {
          result.toolRequirements = [...(result.toolRequirements ?? []), ...commandResult.toolRequirements];
        }
        const output = [commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n").trim();
        let parsed: any;
        try {
          parsed = commandResult.stdout ? JSON.parse(commandResult.stdout) : [];
        } catch {
          // arch-guard:silent-catch-ok command stdout 非 JSON 时按空结果继续校验。
          parsed = null;
        }
        const first = isArray(parsed) && isPlainObject(parsed[0]) ? parsed[0] : null;
        const fixed = first && isString(first.output) ? first.output : null;
        if (fixed && fixed !== content) {
          result.changed = true;
          result.changedFiles.push(pathValue);
          result.fixes.push({ path: pathValue, content: fixed, source: "external.eslint" });
        }
        if (commandResult.exitCode !== 0 && !fixed) {
          result.ok = false;
          result.diagnostics.push({
            severity: "error",
            path: pathValue,
            source: "external.eslint.fix",
            message: output || "eslint 自动修复失败",
          });
        }
      }
      result.changedFiles = [...new Set(result.changedFiles)];
      return result;
    },
  };
}
