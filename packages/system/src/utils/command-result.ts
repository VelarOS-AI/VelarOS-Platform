/**
 * 命令结果：把一次执行整理成对外的回执、摘出失败输出。
 */

import { isNull } from '@velaros-ai/core'
import type { ShellCommandOutputCapture, ShellCommandResult, ShellDescriptor, ShellProcessConfinementEvidence, ShellProcessOwnership } from '@velaros-ai/shell-command/contracts'

import { takeUnicodeSafeTail } from './text.js'
import { SystemTuning } from './tuning.js'

/** 从失败命令的 stdout 与 stderr 各取末尾一段，作为验证摘要里的问题描述。 */
export function summarizeFailureOutput(stdout: string, stderr: string): string[] {
  return (['stdout', 'stderr'] as const).flatMap((stream) => {
    const output = (stream === 'stdout' ? stdout : stderr).trim()
    if (!output) return []
    const prefix = `${stream}:\n`
    return [`${prefix}${takeUnicodeSafeTail(output, SystemTuning.command.verificationIssueChars - prefix.length)}`]
  })
}

/**
 * 把一次执行的原始结果整理成对外的命令结果：退出码为 0（后台模式下进程成功拉起）且没有超时、取消、清理未完成才算成功；
 * 补上耗时和验证摘要，失败时把 stdout 与 stderr 的末尾摘进 issues。
 */
export function buildSystemCommandResult(
  command: string,
  cwd: string,
  startedAt: number,
  result: {
    exitCode: Nullable<number>
    signal: Nullable<string>
    stdout: string
    stderr: string
    timedOut: boolean
    aborted: boolean
    backgroundProcess?: ShellCommandResult['backgroundProcess']
    cleanupIncomplete?: boolean
    truncated?: boolean
    capture?: ShellCommandOutputCapture
    shell?: ShellDescriptor
    ownership?: ShellProcessOwnership
    confinement: ShellProcessConfinementEvidence
  }
): ShellCommandResult {
  const success = (result.exitCode === 0 || (!!result.backgroundProcess && isNull(result.exitCode)))
    && !result.timedOut && !result.aborted && !result.cleanupIncomplete
  return {
    command,
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
    timedOut: result.timedOut,
    aborted: result.aborted,
    cleanupIncomplete: result.cleanupIncomplete,
    ownership: result.ownership,
    truncated: !!result.truncated,
    capture: result.capture,
    shell: result.shell,
    success,
    confinement: result.confinement,
    backgroundProcess: result.backgroundProcess,
    verification: {
      kind: 'unknown',
      status: result.aborted
        ? 'aborted'
        : result.timedOut
          ? 'timed-out'
          : success
            ? 'passed'
            : 'failed',
      issues: success ? [] : summarizeFailureOutput(result.stdout, result.stderr),
    },
  }
}
