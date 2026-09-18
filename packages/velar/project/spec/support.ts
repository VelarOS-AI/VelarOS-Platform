/**
 * 验收测试的替身：一个装着真内核的假空间。两件工具只经根入口拿（projectFileOperations、projectCodeOperations、createProjectKernel），
 * 调用走代码面的能力端口（createCapabilityPort），和模型的程序调 `velar:project` 是同一条路：失败时程序只看得见 code 与 message。
 * 两件工具不问人，所以替身空间里没有审批端口，也没有授权口子。空间怎么把它们与共用能力装在一起，在 `@velaros-ai/project` 的验收里测。
 */

import { createCapabilityPort } from '@velaros-ai/code-surface'

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

/** 替身空间的开关：内核的策略与 provider。 */
export interface ProjectHarnessOptions {
  corePolicy?: CreateProjectKernelOptions['corePolicy']
  providers?: ProjectProviders
}

/** 程序看得到的一次失败：错误码与说明。 */
export interface ProgramFailure extends Error {
  code: string
}

/** 在 root 上建一个真内核和替身空间，返回按「命名空间.操作」调用的 call 与记录。 */
export async function createProjectHarness(root: string, options: ProjectHarnessOptions = {}) {
  const kernel = await createProjectKernel({ root, corePolicy: options.corePolicy, providers: options.providers })
  const project: ProjectSpacePort = {
    getRootPath: () => root,
    kernel: async () => kernel,
    queryCode: async () => ({}),
  }
  const context: ProjectOperationContext = { abortSignal: new AbortController().signal, project, sessionId: 'project-acceptance' }
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
  return { kernel, operations, context, call, read }
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
