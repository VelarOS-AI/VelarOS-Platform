import { describe, expect, test } from 'bun:test'

import { captureService } from '../spec/support'
import type { SystemBackgroundTaskQueryOptions, SystemBackgroundTaskRecord, SystemOpenPortInfo, SystemOpenPortQueryOptions, SystemProcessInfo, SystemProcessQueryOptions } from '../src/exports/contracts'
import {
  createSystemKernelModule,
  type SystemCapabilityService,
  type SystemToolContext,
} from '../src/exports/index'
import { LocalSystemKernel } from '../src/impl/LocalSystemKernel.js'
import { collectPortPids, parseOpenPortEntries, parseProcessRows, selectBackgroundTasks, selectOpenPorts, selectSystemProcesses } from '../src/utils/system-info.js'

/** 60 条进程、60 个端口、60 个后台任务，只有 pid 1056～1059 命中过滤词；过滤词大小写各异、前后带空格。 */
function largeCollections() {
  const processRows = Array.from({ length: 60 }, (_, index) => {
    const name = index === 56 ? 'TargetMarker' : 'node'
    const command = index >= 57
      ? `node ${'x'.repeat(900)} --TaRgEtMaRkEr=${index}`
      : `node unrelated-${index}`
    return `${1000 + index} 1 tester Sun Sep 6 12:00:00 2026 S 1.0 1024 ${name} ${command}`
  }).join('\n')
  const portRows = Array.from({ length: 60 }, (_, index) =>
    `p${1000 + index}\ncnode\nn127.0.0.1:${4000 + index}\nTST=LISTEN`).join('\n')
  const tasks: SystemBackgroundTaskRecord[] = Array.from({ length: 60 }, (_, index) => ({
    id: `task-${index}`,
    runId: `run-${index}`,
    sessionId: null,
    command: index >= 56 ? `bun ${'x'.repeat(900)} TaRgEtMaRkEr-${index}` : `bun unrelated-${index}`,
    cwd: '/tmp',
    pid: 1000 + index,
    logPath: null,
    ports: [],
    reason: null,
    terminateCommand: null,
    forceTerminateCommand: null,
    fallbackTerminateCommand: null,
    requested: true,
    autoStarted: false,
    startedAt: 1,
    updatedAt: 1,
    status: 'running',
    recentOutput: null,
  }))
  const processes = (options: SystemProcessQueryOptions): SystemProcessInfo[] => selectSystemProcesses(parseProcessRows(processRows, 'darwin'), options)
  const ports = (options: SystemOpenPortQueryOptions): SystemOpenPortInfo[] => {
    const entries = parseOpenPortEntries(portRows, 'darwin')
    const pids = collectPortPids(entries)
    const owners = processes({ pids, limit: pids.length })
    return selectOpenPorts(entries, new Map(owners.map((owner) => [owner.pid, owner])), options)
  }
  const backgroundTasks = (options: SystemBackgroundTaskQueryOptions): SystemBackgroundTaskRecord[] => selectBackgroundTasks(tasks, options)
  return { processes, ports, backgroundTasks }
}

describe('System Kernel module', () => {

  test('gives noninteractive commands stdin EOF without waiting for the command timeout', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const result = await kernel.runCommand('fixture', { nativeCommand: { file: process.execPath, args: ['-e', `
      process.stdin.on('end', () => process.stdout.write('stdin-ended'));
      process.stdin.resume();
    `] }, timeoutMs: 2_000 })

    expect(result.stdout).toBe('stdin-ended')
    expect(result.exitCode).toBe(0)
    expect(result.success).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.verification).toEqual({ kind: 'unknown', status: 'passed', issues: [] })
  })

  test('does not report stdout or stderr from a successful command as verification issues', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const result = await kernel.runCommand('fixture', {
      nativeCommand: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('build complete'); process.stderr.write('warning banner')"],
      },
      timeoutMs: 3_000,
    })

    expect(result.success).toBe(true)
    expect(result.verification).toEqual({ kind: 'unknown', status: 'passed', issues: [] })
  })

  test.each([
    ['stdout', 'TypeScript error TS2322: number is not assignable to string'],
    ['stderr', 'fatal: stderr-only failure'],
  ] as const)('summarizes a failed command whose error is written only to %s', async (stream, message) => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const result = await kernel.runCommand('fixture', {
      nativeCommand: {
        file: process.execPath,
        args: ['-e', `process.${stream}.write(${JSON.stringify(message)}); process.exitCode = 2`],
      },
      timeoutMs: 3_000,
    })

    expect(result.success).toBe(false)
    expect(result.verification.status).toBe('failed')
    expect(result.verification.issues).toEqual([`${stream}:\n${message}`])
  })

  test('keeps stdout and stderr separately identifiable when both streams report a failure', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const result = await kernel.runCommand('fixture', {
      nativeCommand: {
        file: process.execPath,
        args: ['-e', `
          process.stderr.write('compiler startup banner');
          process.stdout.write('src/index.ts(4,2): error TS2322');
          process.exitCode = 2;
        `],
      },
      timeoutMs: 3_000,
    })

    expect(result.verification.issues).toEqual([
      'stdout:\nsrc/index.ts(4,2): error TS2322',
      'stderr:\ncompiler startup banner',
    ])
  })

  test('summarizes output emitted before a timeout or cancellation without reporting success', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const timedOut = await kernel.runCommand('fixture', {
      nativeCommand: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('timeout location'); setInterval(() => {}, 1_000)"],
      },
      timeoutMs: 1_000,
    })
    const controller = new AbortController()
    const cancelledPromise = kernel.runCommand('fixture', {
      nativeCommand: {
        file: process.execPath,
        args: ['-e', "process.stderr.write('cancel location'); setInterval(() => {}, 1_000)"],
      },
      timeoutMs: 3_000,
    }, false, controller.signal)
    setTimeout(() => controller.abort(), 1_000)
    const cancelled = await cancelledPromise

    expect(timedOut.success).toBe(false)
    expect(timedOut.verification).toEqual({
      kind: 'unknown', status: 'timed-out', issues: ['stdout:\ntimeout location'],
    })
    expect(cancelled.success).toBe(false)
    expect(cancelled.verification).toEqual({
      kind: 'unknown', status: 'aborted', issues: ['stderr:\ncancel location'],
    })
  })

  test('bounds long failure summaries to the output tail without splitting Unicode characters', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const marker = 'src/末尾.ts(9,1): error 🙂'
    // The 1,000-character issue limit (including "stdout:\n") would start on the low
    // surrogate of this emoji unless the tail boundary advances past the whole pair.
    const output = `start-xxxx🙂${'y'.repeat(991 - marker.length)}${marker}`
    const result = await kernel.runCommand('fixture', {
      nativeCommand: {
        file: process.execPath,
        args: ['-e', `
          process.stdout.write(${JSON.stringify(output)});
          process.stderr.write('z'.repeat(2_000) + 'stderr-tail');
          process.exitCode = 1;
        `],
      },
      timeoutMs: 3_000,
    })

    const [stdoutIssue, stderrIssue] = result.verification.issues
    expect(stdoutIssue).toBe(`stdout:\n${'y'.repeat(991 - marker.length)}${marker}`)
    expect(stdoutIssue!.length).toBe(999)
    expect(stdoutIssue).not.toContain('start-xxxx')
    expect(stdoutIssue).not.toContain('\ufffd')
    expect(Buffer.from(stdoutIssue!, 'utf8').toString('utf8')).toBe(stdoutIssue)
    expect(stderrIssue).toEndWith('stderr-tail')
    expect(stderrIssue!.length).toBe(1_000)
  })

  test('does not spawn a command cancelled during asynchronous preparation', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    const controller = new AbortController()
    const internals = kernel as unknown as { commands: { prepare: () => Promise<unknown> } }
    internals.commands.prepare = async () => {
      controller.abort()
      return { spec: { file: 'must-not-run', args: [] }, env: {}, evidence: {}, ownership: {} }
    }
    await expect(kernel.runCommand('unused', {}, false, controller.signal)).rejects.toThrow()
  })

  test('rejects background spawn failures and records a real background exit code', async () => {
    const kernel = new LocalSystemKernel({ cwd: process.cwd() })
    await expect(kernel.runCommand('unused', {
      nativeCommand: { file: process.execPath, args: ['-e', 'process.exit(7)'] },
      cwd: '/velaros-test-directory-that-does-not-exist', background: true,
    })).rejects.toThrow()
    const started = await kernel.runCommand('unused', {
      nativeCommand: { file: process.execPath, args: ['-e', 'process.exit(7)'] }, background: true,
    })
    const executions = (kernel as unknown as {
      commands: { executions: Map<string, { completion: Promise<unknown> }> }
    }).commands.executions
    await executions.get(started.backgroundProcess!.taskId)!.completion
    const [task] = await kernel.listBackgroundTasks({ taskId: started.backgroundProcess!.taskId })
    expect(task!.status).toBe('exited')
    expect(task!.exitCode).toBe(7)
    await kernel.dispose()
  })

  test('queries a managed system task by the exact id returned from system:run', async () => {
    let service: SystemCapabilityService | undefined
    let receivedOptions: Record<string, unknown> | undefined
    const module = createSystemKernelModule({
      resolveContext: (_scope, signal) =>
        ({
          abortSignal: signal,
          system: {
            listBackgroundTasks: async (options: Record<string, unknown>) => {
              receivedOptions = options
              return []
            },
          },
        }) as unknown as SystemToolContext,
    })
    await module.activate(captureService((_tokenId, registered) => {
      service = registered as SystemCapabilityService
    }))

    const result = await service?.invoke(
      'system:list-tasks',
      undefined,
      { taskId: 'task-background-123' },
      new AbortController().signal,
    )

    expect(receivedOptions).toEqual({
      limit: undefined,
      onlyRunning: undefined,
      taskId: 'task-background-123',
    })
    expect(result).toEqual({ count: 0, tasks: [] })
  })

  test.each(['processes', 'ports', 'backgroundTasks'] as const)(
    'filters the full %s collection before its result limit',
    (collection) => {
      const select = largeCollections()[collection] as (options: { filter?: string; limit?: number }) => Array<{ pid: Nullable<number> }>
      expect(select({})).toHaveLength(50)
      const allMatches = select({ filter: ' targetmarker ' })
      expect(allMatches).toHaveLength(4)
      expect(allMatches.map((item) => item.pid)).toEqual([1056, 1057, 1058, 1059])
      const limited = select({ filter: ' TaRgEtMaRkEr ', limit: 2 })
      expect(limited.map((item) => item.pid)).toEqual([1056, 1057])
    },
  )

})
