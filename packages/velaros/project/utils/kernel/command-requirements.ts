/**
 * 缺失命令的判定：子进程报「找不到命令」时，把它认成一条缺失命令的要求（kind 为 missing-command），
 * 让 ripgrep 搜索、命令型校验器这类调用方回退到别的路径，而不是把退出码当成普通失败。
 */
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'

import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CommandRunInput, CommandToolRequirement, MissingCommandDetectionInput } from '../../types/provider.js'

/** 生成一条「命令不在 PATH 里」的要求；没给原因时用缺省说明。 */
export function createMissingCommandRequirement(input: {
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

/** 按退出码 127、ENOENT 或输出里「command not found」一类字样判断是不是命令缺失；不是缺失返回 null。 */
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

/** 一次命令执行的结果里有没有缺失命令：有就返回只含这一条要求的数组，没有返回 undefined。 */
export function detectCommandRunToolRequirements(input: {
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

/** 把命令和参数拼成一行，写进要求的 sourceCommand。 */
export function formatCommandRunInput(input: CommandRunInput): string {
  return [input.command, ...(input.args ?? [])].join(" ");
}

/** 从 shell、spawn 的报错文字里抠出缺失的命令名；认不出返回 null。 */
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

/** 是不是带 code 字段的 Error（spawn 失败时 code 是 ENOENT 这类）。 */
function isErrorWithCode(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && !isUndefined((error as Error & { code?: unknown }).code);
}

/**
 * Windows 上查命令找不找得到：带路径的按 cwd 解析，不带的按 PATH 与 PATHEXT 逐个找。
 * 本地化的 cmd.exe 找不到程序时只报退出码 1 和翻译过的文字，靠它判断才不依赖系统语言。
 */
export function isWindowsCommandAvailable(command: string, cwd: LooseOptional<string>, env: NodeJS.ProcessEnv): boolean {
  const candidates = extname(command)
    ? [command]
    : [command, ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => `${command}${extension.toLowerCase()}`)];
  const roots = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [cwd ?? process.cwd()]
    : (env.PATH ?? "").split(delimiter).filter(Boolean);
  return roots.some((root) => candidates.some((candidate) => existsSync(resolve(root, candidate))));
}
