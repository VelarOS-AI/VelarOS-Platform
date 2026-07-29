import { isUndefined } from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";

import type {
  CommandRunInput,
  CommandToolRequirement,
} from "../types/provider.js";

interface MissingCommandDetectionInput {
  command: string;
  sourceCommand?: string;
  exitCode?: LooseOptional<number>;
  stderr?: string;
  error?: any;
}

function createMissingCommandRequirement(input: {
  command: string;
  sourceCommand?: string;
  reason?: string;
}): CommandToolRequirement {
  return {
    kind: "missing-command",
    command: input.command,
    sourceCommand: input.sourceCommand,
    reason: input.reason ?? `${input.command} 不在 PATH 中，当前环境无法调用该命令。`,
  };
}

function detectMissingCommandRequirement(
  input: MissingCommandDetectionInput,
): Nullable<CommandToolRequirement> {
  const stderr = input.stderr ?? "";
  const message = AppError.getMessage(input.error ?? "");
  const text = [stderr, message].filter(Boolean).join("\n");
  const code = isErrorWithCode(input.error) ? input.error.code : null;
  const missingByExit = input.exitCode === 127;
  const missingByCode = code === "ENOENT";
  const missingByText = /command not found|not found|not recognized|enoent/i.test(text);

  if (!missingByExit && !missingByCode && !missingByText) return null;

  const command =
    extractCommandFromText(text) ??
    input.command.trim();
  if (!command) return null;

  return createMissingCommandRequirement({
    command,
    sourceCommand: input.sourceCommand ?? input.command,
  });
}

function detectCommandRunToolRequirements(input: {
  run: CommandRunInput;
  exitCode?: LooseOptional<number>;
  stderr?: string;
  error?: any;
}): CommandToolRequirement[] | undefined {
  const missing = detectMissingCommandRequirement({
    command: input.run.command,
    sourceCommand: formatCommandRunInput(input.run),
    exitCode: input.exitCode,
    stderr: input.stderr,
    error: input.error,
  });
  return missing ? [missing] : undefined;
}

function formatCommandRunInput(input: CommandRunInput): string {
  return [input.command, ...(input.args ?? [])].join(" ");
}

function extractCommandFromText(text: string): Nullable<string> {
  const patterns = [
    /command not found:\s*([^\s]+)/i,
    /([^\s:]+):\s*command not found/i,
    /([^\s:]+):\s*not found/i,
    /'([^']+)'\s+is not recognized/i,
    /spawn\s+([^\s]+)\s+ENOENT/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const command = match?.[1]?.trim();
    if (command) return command;
  }

  return null;
}

function isErrorWithCode(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && !isUndefined((error as Error & { code?: unknown }).code);
}

export {
  createMissingCommandRequirement,
  detectCommandRunToolRequirements,
  detectMissingCommandRequirement,
  formatCommandRunInput,
};
