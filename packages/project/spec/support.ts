/**
 * 验收测试的替身：一个装着真内核的假宿主。项目空间只经根入口拿（createProjectSpace），内核经 `@velaros-ai/velar/project` 的根入口拿（createProjectKernel），
 * 调用走代码面的能力端口（createCapabilityPort），和模型的程序调 `velar:project` 是同一条路：失败时程序只看得见 code 与 message。
 * 审批、修改授权、跑命令都记下来给断言用。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'
import type { ImageAttachment } from '@velaros-ai/velar/images'
import { createProjectKernel, type CreateProjectKernelOptions, type ProjectProviders } from '@velaros-ai/velar/project'
import type { ShellCommandResult } from '@velaros-ai/velar/shell/contracts'

import { createProjectSpace, type ProjectCallContext, type ProjectHostPort, type ProjectSandboxPort } from '../src/index'

/** 替身宿主的开关：用户点不点确认、宿主给不给项目修改授权、内核的策略与 provider、演练沙箱。 */
export interface ProjectHarnessOptions {
  approve?: boolean
  authorizeMutation?: boolean
  corePolicy?: CreateProjectKernelOptions['corePolicy']
  providers?: ProjectProviders
  /** 宿主的演练沙箱端口；不给时项目空间里的 sandbox 用不了。 */
  sandbox?: ProjectSandboxPort
}

/** 一次确认请求：文案与选项。 */
export interface RecordedConfirmation {
  message: string
  options?: Record<string, unknown>
}

/** 程序看得到的一次失败：错误码与说明。 */
export interface ProgramFailure extends Error {
  code: string
}

/** 在 root 上建一个真内核和替身宿主，返回按「命名空间.操作」调用的 call 与记录。 */
export async function createProjectHarness(root: string, options: ProjectHarnessOptions = {}) {
  const kernel = await createProjectKernel({ root, corePolicy: options.corePolicy, providers: options.providers })
  const confirmations: RecordedConfirmation[] = []
  const mutations: string[] = []
  /** 每次修改授权带来的、这次会写的文件（相对项目根）；断言确认卡片列得出要改哪些文件。 */
  const authorizedPaths: string[][] = []
  const commands: string[] = []
  const attached: ImageAttachment[] = []
  const approved = options.approve !== false
  const approval: ApprovalPort = {
    awaitConfirmationDecision: async (message, _signal, confirmation) => {
      confirmations.push({ message, options: confirmation as Record<string, unknown> | undefined })
      return { approved, message: approved ? null : '用户拒绝了', autoApproved: false }
    },
    awaitConfirmation: async (message, _signal, confirmation) => {
      confirmations.push({ message, options: confirmation as Record<string, unknown> | undefined })
      if (!approved) throw new AppError('PERMISSION', '用户拒绝了')
    },
  }
  const project: ProjectHostPort = {
    getRootPath: () => root,
    kernel: async () => kernel,
    prepareMutation: async ({ operation, paths }) => {
      mutations.push(operation)
      authorizedPaths.push(paths ?? [])
      const authorized = options.authorizeMutation !== false
      return { approved: authorized, message: authorized ? '已授权' : '宿主没有授权修改这个项目' }
    },
    runCommand: async (command) => {
      commands.push(command)
      const result: ShellCommandResult = { command, cwd: root, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, aborted: false, truncated: false, success: true, verification: { kind: 'unknown', status: 'passed', issues: [] } }
      return result
    },
    listBackgroundTasks: async () => [],
    refreshShellEnvironment: async () => ({ shell: '/bin/sh', variableCount: 0, refreshedAt: 0 }),
    terminateBackgroundTask: async () => ({ terminated: false, statusAfter: 'unknown', message: '这个用例没接后台任务' }),
    queryCode: async () => ({}),
  }
  if (options.sandbox) project.sandbox = options.sandbox
  const context: ProjectCallContext = {
    abortSignal: new AbortController().signal,
    project,
    approval,
    sessionId: 'project-acceptance',
    attachImage: (image) => { attached.push(image) },
  }
  const space = createProjectSpace({ resolveCall: () => context })
  const port = createCapabilityPort(space.operations)
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。 */
  const call = async (namespace: string, operation: string, input: unknown = {}): Promise<any> => {
    const outcome = await port.invoke({ namespace, operation, input })
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code }) as ProgramFailure
    return outcome.value
  }
  /** 读一个文件的指定行，交回那一个窗口（带 fileRef）。 */
  const read = async (path: string, range?: number | [number, number]): Promise<any> => {
    const file: Record<string, unknown> = { path }
    if (range !== undefined) file.range = range
    return (await call('project', 'read', { files: [file] })).files[0]
  }
  return { kernel, space, context, call, read, confirmations, mutations, authorizedPaths, commands, attached }
}

/** 等一次调用失败，交回程序看得到的那两样。 */
export async function failureOf(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as Partial<ProgramFailure>
    return { code: String(failure.code ?? 'UNKNOWN'), message: String(failure.message ?? error) }
  }
  throw new Error('应当失败，却成功了')
}

/** 一张最小的 PNG 头：签名加 IHDR 里的宽高，够认格式、读尺寸（在上限以内，原样交出、不解码像素）。 */
export function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}
