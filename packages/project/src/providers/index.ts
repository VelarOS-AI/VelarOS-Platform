import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

import { execa } from "execa";

import { isEmpty,isString, isTrue } from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";

import type { PolicyDecision, PolicyProvider } from "../types/policy.js";
import type { CommandProvider, FileFilterProvider, SecretRedactionProvider } from "../types/provider.js";
import { matchesAny } from "../utils/glob.js";

import { createMissingCommandRequirement, detectCommandRunToolRequirements } from "./command-requirements.js";

function isWindowsCommandAvailable(command: string, cwd: LooseOptional<string>, env: NodeJS.ProcessEnv): boolean {
  const candidates = extname(command)
    ? [command]
    : [command, ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => `${command}${extension.toLowerCase()}`)];
  const roots = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [cwd ?? process.cwd()]
    : (env.PATH ?? "").split(delimiter).filter(Boolean);
  return roots.some((root) => candidates.some((candidate) => existsSync(resolve(root, candidate))));
}

export function createFileFilterProvider(options: { include?: Array<string | RegExp>; exclude?: Array<string | RegExp> } = {}): FileFilterProvider {
  return {
    shouldInclude({ path }) {
      const included = !options.include || isEmpty(options.include) || options.include.some((rule) => (rule instanceof RegExp ? rule.test(path) : matchesAny(path, [rule])));
      const excluded = !!options.exclude?.some((rule) => (rule instanceof RegExp ? rule.test(path) : matchesAny(path, [rule])));
      return included && !excluded;
    },
  };
}

export function createSecretRedactionProvider(): SecretRedactionProvider {
  const patterns = [
    /(sk-[a-zA-Z0-9_-]{12,})/g,
    /((?:api|secret|access|refresh|private)[_ -]?(?:key|token|secret)\s*[:=]\s*)([^\s"']+)/gi,
  ];
  return {
    redact({ content }) {
      let redacted = false;
      let next = content;
      for (const pattern of patterns) {
        next = next.replace(pattern, (...args: any[]) => {
          redacted = true;
          if (args.length > 3 && String(args[1]).match(/key|token|secret/i)) return `${args[1]}[REDACTED]`;
          return "[REDACTED]";
        });
      }
      return { content: next, redacted };
    },
  };
}

export function createAllowAllPolicyProvider(): PolicyProvider {
  return {
    decide(): PolicyDecision {
      return { allow: true };
    },
  };
}


export function createNodeCommandProvider(): CommandProvider {
  return {
    async run(input) {
      const startedAt = Date.now();
      try {
        // `reject: false` 让非零退出 / 超时不抛错，与历史"始终 resolve CommandResult"语义一致；
        // 真实的 spawn 失败（ENOENT 等）仍会抛错，由外层 catch 转成失败结果。
        const commandEnvironment = { ...process.env, ...(input.env ?? {}) };
        const result = await execa(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: commandEnvironment,
          input: input.stdin,
          timeout: input.timeoutMs ?? 30_000,
          maxBuffer: 1024 * 1024 * 8,
          reject: false,
        });
        const timedOut = isTrue(result.timedOut);
        // execa 在 reject=false 时会把 spawn ENOENT 作为 ExecaError 结果返回而不是抛出。
        // 必须在成功分支同样识别缺失命令，否则 exitCode 会退化成 1，被 ripgrep 搜索误判为
        // “正常无命中”，从而跳过 adapter fallback。
        const stderr = String(result.stderr ?? "");
        let toolRequirements = detectCommandRunToolRequirements({
          run: input,
          exitCode: result.exitCode,
          stderr,
          error: result.failed ? result : undefined,
        });
        // On localized Windows installations, cmd.exe reports a missing program
        // as exit 1 with translated text instead of ENOENT/127. Resolve PATH
        // directly so adapter fallback does not depend on the OS language.
        if (
          !toolRequirements &&
          process.platform === "win32" &&
          result.failed &&
          result.exitCode === 1 &&
          !isWindowsCommandAvailable(input.command, input.cwd, commandEnvironment)
        ) {
          toolRequirements = [createMissingCommandRequirement({
            command: input.command,
            sourceCommand: [input.command, ...(input.args ?? [])].join(" "),
          })];
        }
        const missingCommand = !!toolRequirements?.some((item) => item.kind === "missing-command");
        return {
          exitCode: missingCommand
            ? 127
            : result.exitCode ?? (timedOut ? 124 : result.failed ? 1 : 0),
          stdout: String(result.stdout ?? ""),
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          toolRequirements,
        };
      } catch (error) {
        // arch-guard:silent-catch-ok spawn 失败会被转成 CommandRunResult，由调用方根据 exitCode 处理。
        const errorRecord = error as { stdout?: unknown; stderr?: unknown; timedOut?: unknown };
        const timedOut = isTrue(errorRecord.timedOut);
        const stderr = isString(errorRecord.stderr)
          ? errorRecord.stderr
          : AppError.getMessage(error);
        const toolRequirements = detectCommandRunToolRequirements({ run: input, stderr, error });
        return {
          exitCode: timedOut ? 124 : toolRequirements ? 127 : 1,
          stdout: isString(errorRecord.stdout) ? errorRecord.stdout : "",
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          toolRequirements,
        };
      }
    },
  };
}

export {
  createMissingCommandRequirement,
  detectCommandRunToolRequirements,
  detectMissingCommandRequirement,
  formatCommandRunInput,
} from "./command-requirements.js";
