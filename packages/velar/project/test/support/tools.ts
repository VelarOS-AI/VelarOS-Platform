/**
 * 测试用的项目工具：真内核 + `velar:project`、`velar:code` 两件工具的操作表 + 真能力端口，一次调用就是模型程序里的一次调用。
 * 空间怎么装配（共用的命令、沙箱、看图配上项目端口）不在这里测，那是 `@velaros-ai/project` 的事；这里只驱动两件工具。
 * 入参与返回值都过一遍 JSON：程序在隔离进程里，跨进程的只有 JSON 能表达的东西。
 */

import { randomUUID } from 'node:crypto'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'

import type { CreateProjectKernelOptions, ProjectOperationContext, ProjectSpacePort } from '../../contract/requires'
import { createProjectKernel } from '../../impl/kernel/LocalProjectKernel'
import { projectCodeOperations } from '../../impl/operations/ProjectCodeOperations'
import { projectFileOperations } from '../../impl/operations/ProjectFileOperations'
import type { CodeAnalysisInput, CodeQueryInput } from '../../types/code'
import type { ProjectChangeInput, ProjectEditInput, ProjectListInput, ProjectReadInput, ProjectSearchInput } from '../../types/files'
import type { ProjectCodeQuery } from '../../types/project'

/** 一次确认：审批端口收到的文案与选项，以及它是经哪个口子问的。 */
export interface RecordedConfirmation {
  message: string
  options?: Parameters<ApprovalPort['awaitConfirmation']>[2]
  /** awaitConfirmation 被拒就抛；awaitConfirmationDecision 返回结构化决定（内核的审批桥走它）。 */
  via: 'confirmation' | 'decision'
}

/** 建两件项目工具的测试夹具：内核按 root 建，空间端口的每一件都可以按用例换掉。 */
export async function projectToolFixture(options: {
  root: string
  plugins?: CreateProjectKernelOptions['plugins']
  corePolicy?: CreateProjectKernelOptions['corePolicy']
  providers?: CreateProjectKernelOptions['providers']
  /** 项目修改授权：缺省一律放行。 */
  prepareMutation?: ProjectSpacePort['prepareMutation']
  /** 代码查询：缺省返回空对象。 */
  queryCode?: (input: ProjectCodeQuery) => unknown
  /** 审批：缺省一律点头；每次确认的文案与选项都记下来。 */
  approve?: boolean
  /** 会话号：缺省每个夹具一个新会话，引用不在用例之间串。 */
  sessionId?: string
}) {
  const kernel = await createProjectKernel({ root: options.root, plugins: options.plugins ?? [], corePolicy: options.corePolicy, providers: options.providers })
  const confirmations: RecordedConfirmation[] = []
  const mutations: Array<{ operation: string; cwd?: string; paths?: string[] }> = []
  const queries: ProjectCodeQuery[] = []
  const approval: ApprovalPort = {
    awaitConfirmation: async (message, _signal, confirmation) => {
      confirmations.push({ message, options: confirmation, via: 'confirmation' })
      if (options.approve === false) throw new AppError('PERMISSION', '用户拒绝了这次操作。')
    },
    awaitConfirmationDecision: async (message, _signal, confirmation) => {
      confirmations.push({ message, options: confirmation, via: 'decision' })
      return { approved: options.approve !== false, message: options.approve === false ? '用户拒绝了这次操作。' : null, autoApproved: false }
    },
  }
  const host: ProjectSpacePort = {
    getRootPath: () => options.root,
    kernel: async () => kernel,
    prepareMutation: async (input) => {
      mutations.push({ operation: input.operation, cwd: input.cwd, paths: input.paths })
      return options.prepareMutation ? options.prepareMutation(input) : { approved: true, message: '已授权' }
    },
    queryCode: async (input) => {
      queries.push(input)
      return options.queryCode ? options.queryCode(input) : {}
    },
  }
  const context: ProjectOperationContext = { abortSignal: new AbortController().signal, project: host, approval, sessionId: options.sessionId ?? `test-${randomUUID()}` }
  // 空间装配时给两件工具的就是这张表：每次调用交同一份上下文。
  const port = createCapabilityPort({
    project: {
      read: (input) => projectFileOperations.read(input as ProjectReadInput, context),
      list: (input) => projectFileOperations.list(input as ProjectListInput, context),
      search: (input) => projectFileOperations.search(input as ProjectSearchInput, context),
      edit: (input) => projectFileOperations.edit(input as ProjectEditInput, context),
      inspect: (input) => projectFileOperations.inspect(input as ProjectChangeInput, context),
      undo: (input) => projectFileOperations.undo(input as ProjectChangeInput, context),
    },
    code: {
      query: (input) => projectCodeOperations.query(input as CodeQueryInput, context),
      analyze: (input) => projectCodeOperations.analyze(input as CodeAnalysisInput, context),
    },
  })

  /** 像模型的程序那样调一次能力：成功给返回值，失败抛带 code 的错误（代码面交给程序的就是这两样）。 */
  const call = async <T = any>(namespace: string, operation: string, input: unknown = {}): Promise<T> => {
    const outcome = await port.invoke({ namespace, operation, input: throughJson(input) })
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return throughJson(outcome.value) as T
  }
  return { kernel, host, context, port, call, confirmations, mutations, queries }
}

/** 跨进程之后的样子：undefined 的字段没了，只剩 JSON 能表达的值。 */
function throughJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 等一次调用失败，交出码与说明。 */
export async function failureOf(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return { code: failure.code ?? 'UNKNOWN', message: failure.message ?? String(error) }
  }
  throw new Error('应当失败，却成功了')
}
