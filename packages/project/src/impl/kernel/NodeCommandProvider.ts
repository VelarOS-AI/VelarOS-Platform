/**
 * 本地子进程命令：`NodeCommandProvider`。宿主建内核时没给 providers.command，内核就用它跑 git、ripgrep、命令型校验器与修复器。
 * 实现的接口 `CommandProvider` 在注入面（contract/requires.ts）。
 */
import { execa } from "execa";

import { isString, isTrue } from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";

import type { CommandProvider } from '../../contract/requires.js'
import type { CommandRunInput, CommandRunResult } from '../../types/provider.js'
import { createMissingCommandRequirement, detectCommandRunToolRequirements, formatCommandRunInput, isWindowsCommandAvailable } from '../../utils/kernel/command-requirements.js'
import { ProjectTuning } from '../../utils/tuning.js'

/**
 * 在本机起子进程跑命令，结果总是正常返回：非零退出、超时、输出超过上限都如实写进结果；
 * 找不到命令时退出码记 127 并附一条缺失命令的要求，调用方（ripgrep 搜索、适配器）据此回退。
 */
export class NodeCommandProvider implements CommandProvider {
  public async run(input: CommandRunInput): Promise<CommandRunResult> {
    const startedAt = Date.now();
    try {
      // `reject: false` 让非零退出 / 超时不抛错，与历史"始终 resolve CommandResult"语义一致；
      // 真实的 spawn 失败（ENOENT 等）仍会抛错，由外层 catch 转成失败结果。
      const commandEnvironment = { ...process.env, ...(input.env ?? {}) };
      const result = await execa(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: commandEnvironment,
        input: input.stdin,
        timeout: input.timeoutMs ?? ProjectTuning.kernel.commandTimeoutMs,
        maxBuffer: ProjectTuning.kernel.commandOutputChars,
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
      // 本地化的 Windows 上，cmd.exe 找不到程序时报的是退出码 1 加翻译后的文字，而不是 ENOENT/127。
      // 这里直接查 PATH，让适配器回退不依赖系统语言。
      if (
        !toolRequirements &&
        process.platform === "win32" &&
        result.failed &&
        result.exitCode === 1 &&
        !isWindowsCommandAvailable(input.command, input.cwd, commandEnvironment)
      ) {
        toolRequirements = [createMissingCommandRequirement({
          command: input.command,
          sourceCommand: formatCommandRunInput(input),
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
        truncated: isTrue(result.isMaxBuffer),
        toolRequirements,
      };
    } catch (error) {
      // arch-guard:silent-catch-ok spawn 失败会被转成 CommandRunResult，由调用方根据 exitCode 处理。
      const errorRecord = error as { stdout?: unknown; stderr?: unknown; timedOut?: unknown; isMaxBuffer?: unknown };
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
        truncated: isTrue(errorRecord.isMaxBuffer),
        toolRequirements,
      };
    }
  }
}
