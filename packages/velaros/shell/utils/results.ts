/**
 * 回执整形：宿主交回的完整回执与任务条目，整成模型看的样子——只留它用得上的那几项。
 */

import { isEmpty, isNotUndefined } from '@velaros-ai/core'

import type {
  ShellBackgroundTaskRecord,
  ShellCommandResult,
  ShellEnvironment,
  ShellEnvironmentRefreshResult,
  ShellRunResult,
  ShellTask,
} from '../types/shell-command.js'

/** 宿主的完整回执里模型用得上的那几项：命令、目录、成败、退出码与信号、超时与取消、耗时、全部输出。 */
export function runResult(result: ShellCommandResult): ShellRunResult {
  const value: ShellRunResult = {
    command: result.command,
    cwd: result.cwd,
    success: result.success,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
  }
  if (result.confinement) value.confinement = result.confinement
  return value
}

/** 宿主任务表里的一条整成模型看的样子：去掉进程号、日志路径、终止命令这些宿主自己用的，输出改叫 output。 */
export function taskOf(record: ShellBackgroundTaskRecord): ShellTask {
  const task: ShellTask = {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    status: record.status,
    ports: record.ports,
    autoStarted: record.autoStarted,
    startedAt: record.startedAt,
    output: record.recentOutput ?? '',
  }
  if (isNotUndefined(record.exitCode)) task.exitCode = record.exitCode
  if (isNotUndefined(record.signal)) task.signal = record.signal
  if (isNotUndefined(record.finishedAt)) task.finishedAt = record.finishedAt
  if (record.console) task.console = record.console
  return task
}

/** 刷新之后的 shell 环境整成模型看的样子：默认 shell 的路径、本机可用的全部 shell，没完全成功或缺推荐 shell 时一句说明。 */
export function environmentOf(result: ShellEnvironmentRefreshResult): ShellEnvironment {
  const shells = (result.shells ?? (result.runtime ? [result.runtime] : [])).map((descriptor) => ({
    kind: descriptor.kind,
    path: descriptor.shellPath,
    version: descriptor.version,
    ready: descriptor.readiness === 'ready',
  }))
  const environment: ShellEnvironment = { shell: result.shell, shells }
  const notes = [result.reason, result.runtime?.recommendation?.message].filter(
    (note): note is string => Boolean(note)
  )
  if (!isEmpty(notes)) environment.note = notes.join('；')
  return environment
}
