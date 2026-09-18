/**
 * 测试用的项目空间：真内核 + 真装配表 + 真能力端口，一次调用就是模型程序里的一次调用。
 * 空间的五个命名空间（project、code、shell、sandbox、images）都从这里驱动，测试不再自己拼工具入参。
 * 入参与返回值都过一遍 JSON：程序在隔离进程里，跨进程的只有 JSON 能表达的东西。
 */

import { randomUUID } from 'node:crypto'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { type CodeAttachment, createCapabilityPort } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'
import type { ImageAttachment } from '@velaros-ai/velar/images'

import type { CreateProjectKernelOptions, ProjectCallContext, ProjectHostPort, ProjectSandboxPort } from '../../src/contract/requires'
import { createProjectKernel } from '../../src/impl/kernel/LocalProjectKernel'
import { createProjectSpace } from '../../src/impl/ProjectSpace'
import type { ProjectCodeQuery } from '../../src/types/project'

/** 一次确认：审批端口收到的文案与选项，以及它是经哪个口子问的。 */
export interface RecordedConfirmation {
  message: string
  options?: Parameters<ApprovalPort['awaitConfirmation']>[2]
  /** awaitConfirmation 被拒就抛；awaitConfirmationDecision 返回结构化决定（内核的审批桥走它）。 */
  via: 'confirmation' | 'decision'
}

/** 建一个项目空间的测试夹具：内核按 root 建，宿主端口的每一件都可以按用例换掉。 */
export async function projectSpaceFixture(options: {
  root: string
  plugins?: CreateProjectKernelOptions['plugins']
  corePolicy?: CreateProjectKernelOptions['corePolicy']
  providers?: CreateProjectKernelOptions['providers']
  /** 项目修改授权：缺省一律放行。 */
  prepareMutation?: ProjectHostPort['prepareMutation']
  /** 跑命令：缺省报「这个用例没接命令」。 */
  runCommand?: ProjectHostPort['runCommand']
  /** 代码查询：缺省返回空对象。 */
  queryCode?: (input: ProjectCodeQuery) => unknown
  /** 演练沙箱端口：不给就是宿主没接沙箱。 */
  sandbox?: ProjectSandboxPort
  /** 裁图缩图：不给就是宿主没有图像处理能力。 */
  resizeImage?: ProjectHostPort['resizeImage']
  /** 宿主自己的看图通道：不给就走代码面的图片通道（端口回执里的 attachments）。 */
  attachImage?: (image: ImageAttachment) => void
  /** 审批：缺省一律点头；每次确认的文案与选项都记下来。 */
  approve?: boolean
  /** 会话号：缺省每个夹具一个新会话，引用不在用例之间串。 */
  sessionId?: string
}) {
  const kernel = await createProjectKernel({ root: options.root, plugins: options.plugins ?? [], corePolicy: options.corePolicy, providers: options.providers })
  const confirmations: RecordedConfirmation[] = []
  const mutations: Array<{ operation: string; cwd?: string; paths?: string[] }> = []
  const queries: ProjectCodeQuery[] = []
  const attachments: CodeAttachment[] = []
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
  const host: ProjectHostPort = {
    getRootPath: () => options.root,
    kernel: async () => kernel,
    prepareMutation: async (input) => {
      mutations.push({ operation: input.operation, cwd: input.cwd, paths: input.paths })
      return options.prepareMutation ? options.prepareMutation(input) : { approved: true, message: '已授权' }
    },
    runCommand: options.runCommand ?? (async () => { throw new AppError('PLATFORM', '这个用例没接命令执行') }),
    listBackgroundTasks: async () => [],
    refreshShellEnvironment: async () => ({ shell: '/bin/sh', variableCount: 0, refreshedAt: 0 }),
    queryCode: async (input) => {
      queries.push(input)
      return options.queryCode ? options.queryCode(input) : {}
    },
  }
  if (options.sandbox) host.sandbox = options.sandbox
  if (options.resizeImage) host.resizeImage = options.resizeImage
  const context: ProjectCallContext = { abortSignal: new AbortController().signal, project: host, approval, sessionId: options.sessionId ?? `test-${randomUUID()}` }
  if (options.attachImage) context.attachImage = options.attachImage
  const port = createCapabilityPort(createProjectSpace({ resolveCall: () => context }).operations)

  /** 像模型的程序那样调一次能力：成功给返回值，失败抛带 code 的错误（代码面交给程序的就是这两样）。 */
  const call = async <T = any>(namespace: string, operation: string, input: unknown = {}): Promise<T> => {
    const outcome = await port.invoke({ namespace, operation, input: throughJson(input) })
    attachments.push(...(outcome.attachments ?? []))
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return throughJson(outcome.value) as T
  }
  return { kernel, host, context, port, call, confirmations, mutations, queries, attachments }
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
