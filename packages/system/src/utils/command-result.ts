/**
 * 命令结果：把一次执行整理成对外的结果、摘出失败输出、补上输出窗口说明与召回完整输出的续接。
 */

import { isNull } from '@velaros-ai/core'

import type { SystemCommandOutputCapture, SystemCommandResult, SystemProcessConfinementEvidence, SystemProcessOwnership, SystemShellDescriptor } from '../types/system.js'

import { takeUnicodeSafeTail } from './text.js'
import { SystemTuning } from './tuning.js'

/** 从内部日志路径取出召回用的查询词：只取文件名，最长 240 个字符。 */
function commandLogQuery(logPath: string): string {
  return (logPath.split(/[\\/]/u).at(-1) ?? logPath).slice(0, 240)
}

/** 给命令结果补上输出窗口说明；输出被截断或命令转入后台时，再补上召回完整输出的续接指令。 */
export function exposeCommandOutputWindow(result: SystemCommandResult): SystemCommandResult {
  const managedLogPath = result.logPath ?? result.backgroundProcess?.logPath
  const continuationQuery = managedLogPath ? commandLogQuery(managedLogPath) : undefined
  return {
    ...result,
    outputWindow: {
      retained: 'tail',
      complete: !result.truncated && !result.backgroundProcess,
      endPreserved: true,
    },
    outputContinuation:
      continuationQuery && (result.truncated || result.backgroundProcess)
        ? {
            kind: 'session-terminal-log' as const,
            query: continuationQuery,
            tool: 'context:recall' as const,
            args: { query: continuationQuery, kind: 'terminal' as const },
          }
        : result.outputContinuation,
  }
}

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
    backgroundProcess?: SystemCommandResult['backgroundProcess']
    cleanupIncomplete?: boolean
    truncated?: boolean
    capture?: SystemCommandOutputCapture
    shell?: SystemShellDescriptor
    ownership?: SystemProcessOwnership
    confinement: SystemProcessConfinementEvidence
  }
): SystemCommandResult {
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
