/**
 * 验收测试的替身：一个装着真内核的假宿主。工具只经根入口拿（projectTools、createProjectKernel、projectFileContext），
 * 模型看到的回执经 agent 的文件上下文协调器定稿（fileRef 在这一步生成），审批、修改授权、跑命令都记下来给断言用。
 */

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { fileContextFor } from '@velaros-ai/agent/tool-contract'

import { createProjectKernel, type CreateProjectKernelOptions, type ProjectCommandResult, projectFileContext, type ProjectProviders, type ProjectSandboxPort, type ProjectToolContext, projectTools } from '../src/exports/index'

/** 替身宿主的开关：用户点不点确认、宿主给不给项目修改授权、内核的策略与 provider。 */
export interface ProjectHarnessOptions {
  approve?: boolean
  authorizeMutation?: boolean
  corePolicy?: CreateProjectKernelOptions['corePolicy']
  providers?: ProjectProviders
  /** 宿主的演练沙箱端口；不给时 project:sandbox 不可用。 */
  sandbox?: ProjectSandboxPort
}

/** 一次确认请求：文案与选项。 */
export interface RecordedConfirmation {
  message: string
  options?: Record<string, unknown>
}

/** 在 root 上建一个真内核和替身宿主，返回按工具名调用的 call（回执已定稿）与记录。 */
export async function createProjectHarness(root: string, options: ProjectHarnessOptions = {}) {
  const kernel = await createProjectKernel({ root, corePolicy: options.corePolicy, providers: options.providers })
  const confirmations: RecordedConfirmation[] = []
  const mutations: string[] = []
  const commands: string[] = []
  const approved = options.approve !== false
  const context = {
    sessionId: 'project-acceptance',
    codingSession: {},
    contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    approval: {
      awaitConfirmationDecision: async (message: string, _signal?: AbortSignal, confirmation?: Record<string, unknown>) => {
        confirmations.push({ message, options: confirmation })
        return { approved, message: approved ? null : '用户拒绝了' }
      },
      awaitConfirmation: async (message: string, _signal?: AbortSignal, confirmation?: Record<string, unknown>) => {
        confirmations.push({ message, options: confirmation })
        if (!approved) throw new Error('用户拒绝了')
      },
    },
    project: {
      getRootPath: () => root,
      kernel: async () => kernel,
      runInDirectory: async <T>(_path: string, run: () => Promise<T>) => run(),
      runWithApproval: async <T>(run: () => Promise<T>) => run(),
      prepareMutation: async ({ operation }: { operation: string }) => {
        mutations.push(operation)
        const authorized = options.authorizeMutation !== false
        return { approved: authorized, rootPath: root, switched: false, alreadyAuthorized: authorized, rejectionMessage: authorized ? null : '宿主没有授权修改这个项目', message: authorized ? '已授权' : '未授权' }
      },
      sandbox: options.sandbox,
      queryCode: async () => ({}),
      runCommand: async (command: string): Promise<ProjectCommandResult> => {
        commands.push(command)
        return { command, cwd: root, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, aborted: false, truncated: false, success: true, verification: { kind: 'unknown', status: 'passed', issues: [] } }
      },
    },
  } as unknown as ProjectToolContext
  projectFileContext.register(context)
  const coordinator = fileContextFor(context)
  let callId = 0
  /** 按工具名调用：入参先过工具自己的 schema，回执经文件上下文协调器定稿。 */
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const tool = projectTools[name]
    if (!tool) throw new Error(`没有工具 ${name}`)
    const result = await tool.execute(tool.schema.parse(args), { ...context, toolCallId: `acceptance-${++callId}` })
    return coordinator ? coordinator.finalizeModelResult(result) : result
  }
  /** 读一个文件的指定行，返回定稿后的那一项（带 fileRef）。 */
  const read = async (path: string, range?: number | [number, number]): Promise<any> => {
    const args: Record<string, unknown> = { path }
    if (range !== undefined) args.range = range
    return (await call('project:read', args)).files[0]
  }
  return { kernel, context, call, read, confirmations, mutations, commands }
}
