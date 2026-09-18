/**
 * 验收测试的替身：一个装着真内核的假空间。两件工具只经根入口拿（projectFileOperations、projectCodeOperations、createProjectKernel），
 * 调用走代码面的能力端口（createCapabilityPort），和模型的程序调 `velar:project` 是同一条路：失败时程序只看得见 code 与 message。
 * 审批与修改授权都记下来给断言用。空间怎么把它们与共用能力装在一起，在 `@velaros-ai/project` 的验收里测。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'

import {
  type CodeAnalysisInput,
  type CodeQueryInput,
  createProjectKernel,
  type CreateProjectKernelOptions,
  type ProjectChangeInput,
  projectCodeOperations,
  type ProjectEditInput,
  projectFileOperations,
  type ProjectListInput,
  type ProjectOperationContext,
  type ProjectProviders,
  type ProjectReadInput,
  type ProjectSearchInput,
  type ProjectSpacePort,
} from '../index'

/** 替身空间的开关：用户点不点确认、给不给项目修改授权、内核的策略与 provider。 */
export interface ProjectHarnessOptions {
  approve?: boolean
  authorizeMutation?: boolean
  corePolicy?: CreateProjectKernelOptions['corePolicy']
  providers?: ProjectProviders
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

/** 在 root 上建一个真内核和替身空间，返回按「命名空间.操作」调用的 call 与记录。 */
export async function createProjectHarness(root: string, options: ProjectHarnessOptions = {}) {
  const kernel = await createProjectKernel({ root, corePolicy: options.corePolicy, providers: options.providers })
  const confirmations: RecordedConfirmation[] = []
  const mutations: string[] = []
  /** 每次修改授权带来的、这次会写的文件（相对项目根）；断言确认卡片列得出要改哪些文件。 */
  const authorizedPaths: string[][] = []
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
  const project: ProjectSpacePort = {
    getRootPath: () => root,
    kernel: async () => kernel,
    prepareMutation: async ({ operation, paths }) => {
      mutations.push(operation)
      authorizedPaths.push(paths ?? [])
      const authorized = options.authorizeMutation !== false
      return { approved: authorized, message: authorized ? '已授权' : '宿主没有授权修改这个项目' }
    },
    queryCode: async () => ({}),
  }
  const context: ProjectOperationContext = { abortSignal: new AbortController().signal, project, approval, sessionId: 'project-acceptance' }
  // 空间装配时给两件工具的就是这张表：每次调用交同一份上下文。
  const operations = {
    project: {
      read: (input: unknown) => projectFileOperations.read(input as ProjectReadInput, context),
      list: (input: unknown) => projectFileOperations.list(input as ProjectListInput, context),
      search: (input: unknown) => projectFileOperations.search(input as ProjectSearchInput, context),
      edit: (input: unknown) => projectFileOperations.edit(input as ProjectEditInput, context),
      inspect: (input: unknown) => projectFileOperations.inspect(input as ProjectChangeInput, context),
      undo: (input: unknown) => projectFileOperations.undo(input as ProjectChangeInput, context),
    },
    code: {
      query: (input: unknown) => projectCodeOperations.query(input as CodeQueryInput, context),
      analyze: (input: unknown) => projectCodeOperations.analyze(input as CodeAnalysisInput, context),
    },
  }
  const port = createCapabilityPort(operations)
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
  return { kernel, operations, context, call, read, confirmations, mutations, authorizedPaths }
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
