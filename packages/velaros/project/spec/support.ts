/**
 * 验收测试与实现测试共用的替身，两个都装着真内核：
 * - `createProjectHarness`：两件工具的假空间。两件工具只经根入口拿（projectFileOperations、projectCodeOperations、createProjectKernel），
 *   两件工具不问人，所以这个空间里没有审批端口，也没有授权口子。
 * - `createProjectPortsHarness`：一个假宿主（`ProjectHostPort`），三件共用能力（`velaros:shell`、`velaros:sandbox`、`velaros:images`）的操作
 *   配上 `projectCapabilityPorts` 现装的项目端口——产品装项目空间时就是这样接的。审批（只有危险命令会问）与交给宿主的命令都记下来。
 * 调用都走代码面的能力端口（createCapabilityPort），和模型的程序是同一条路：失败时程序只看得见 code 与 message。
 */

import { AppError } from '@velaros-ai/core/error'
import type { ApprovalPort } from '@velaros-ai/kernel'
import type { CapabilityOperationContext, CodeAttachment } from '@velaros-ai/script'
import { createCapabilityPort } from '@velaros-ai/script'
import type { ImageAttachment, ImageOperationContext } from '@velaros-ai/velaros/images'
import { imageOperations } from '@velaros-ai/velaros/images'
import type {
  RehearsalSandboxHostPort,
  SandboxDiff,
  SandboxOperationContext,
  SandboxRecord,
} from '@velaros-ai/velaros/sandbox'
import { sandboxOperations } from '@velaros-ai/velaros/sandbox'
import type {
  ShellCommandResult,
  ShellOperationContext,
  ShellRunCommandOptions,
} from '@velaros-ai/velaros/shell'
import { shellOperations } from '@velaros-ai/velaros/shell'

import {
  type CodeAnalysisInput,
  type CodeQueryInput,
  createProjectKernel,
  type CreateProjectKernelOptions,
  projectCapabilityPorts,
  type ProjectChangeInput,
  projectCodeOperations,
  type ProjectEditInput,
  projectFileOperations,
  type ProjectHostPort,
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
  const kernel = await createProjectKernel({
    root,
    corePolicy: options.corePolicy,
    providers: options.providers,
  })
  const project: ProjectSpacePort = {
    getRootPath: () => root,
    kernel: async () => kernel,
    queryCode: async () => ({}),
  }
  const context: ProjectOperationContext = {
    abortSignal: new AbortController().signal,
    project,
    sessionId: 'project-acceptance',
  }
  // 空间装配时给两件工具的就是这张表：每次调用交同一份上下文。
  const operations = {
    project: {
      read: (input: unknown) => projectFileOperations.read(input as ProjectReadInput, context),
      list: (input: unknown) => projectFileOperations.list(input as ProjectListInput, context),
      search: (input: unknown) =>
        projectFileOperations.search(input as ProjectSearchInput, context),
      edit: (input: unknown) => projectFileOperations.edit(input as ProjectEditInput, context),
      inspect: (input: unknown) =>
        projectFileOperations.inspect(input as ProjectChangeInput, context),
      undo: (input: unknown) => projectFileOperations.undo(input as ProjectChangeInput, context),
    },
    code: {
      query: (input: unknown) => projectCodeOperations.query(input as CodeQueryInput, context),
      analyze: (input: unknown) =>
        projectCodeOperations.analyze(input as CodeAnalysisInput, context),
    },
  }
  const port = createCapabilityPort(operations)
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。 */
  const call = async (namespace: string, operation: string, input: unknown = {}): Promise<any> => {
    const outcome = await port.invoke({ namespace, operation, input })
    if (outcome.error)
      throw Object.assign(new Error(outcome.error.message), {
        code: outcome.error.code,
      }) as ProgramFailure
    return outcome.value
  }
  /** 读一个文件的指定行，交回那一个窗口（连续的正文与第一行的行号）。 */
  const read = async (path: string, range?: number | [number, number]): Promise<any> => {
    const file: Record<string, unknown> = { path }
    if (range !== undefined) file.range = range
    return (await call('project', 'read', { files: [file] })).files[0]
  }
  return { kernel, operations, context, call, read }
}

/** 等一次调用失败，交回程序看得到的那两样。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as Partial<ProgramFailure>
    return { code: String(failure.code ?? 'UNKNOWN'), message: String(failure.message ?? error) }
  }
  throw new Error('应当失败，却成功了')
}

// ── 共用能力的项目端口 ──────────────────────────────────────────

/** 一次确认：审批端口收到的文案与选项。 */
export interface RecordedConfirmation {
  message: string
  options?: Parameters<ApprovalPort['awaitConfirmation']>[2]
}

/** 一次交给宿主的命令：命令、选项（工作目录是项目端口解析好的）、是不是用户确认过的危险命令。 */
export interface HostRun {
  command: string
  options?: ShellRunCommandOptions
  allowDangerous?: boolean
}

/** 假宿主的开关：用户点不点确认、宿主怎么回命令、有没有演练沙箱与缩图口子、交图走哪条通道。 */
export interface ProjectPortsHarnessOptions {
  /** 用户点不点确认（只有危险命令会问）；缺省点头。 */
  approve?: boolean
  /** 宿主怎么回一条命令（交到这里的每一条都先记进 `runs`）；缺省交回成功的空回执。 */
  runCommand?: ProjectHostPort['runCommand']
  /** 宿主的演练沙箱：不给就是这台机器上没有沙箱。 */
  sandbox?: RehearsalSandboxHostPort
  /** 宿主的缩图口子：不给就是宿主没有图像处理能力。 */
  resizeImage?: ProjectHostPort['resizeImage']
  /** 宿主自己的交图通道：不给就走代码面的图片通道，图跟在回执旁边（记在 `attachments`）。 */
  attachImage?: (image: ImageAttachment) => void
  /** 会话号：后台任务按它登记与核对。 */
  sessionId?: string
}

/** 一条命令的回执：退出码 0，前台跑完；按用例改。 */
export function commandResult(
  command: string,
  cwd: string,
  overrides: Partial<ShellCommandResult> = {}
): ShellCommandResult {
  return {
    command,
    cwd,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    success: true,
    verification: { kind: 'unknown', status: 'passed', issues: [] },
    ...overrides,
  }
}

/** 跨进程之后的样子：undefined 的字段没了，只剩 JSON 能表达的值（程序在隔离进程里）。 */
function throughJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * 在 root 上建真内核与一个假宿主，把三件共用能力的操作配上 `projectCapabilityPorts` 现装的端口，接成代码面的能力端口。
 * 每次调用都按这一次的取消信号现装端口，和产品分发调用时一样。交回按「命名空间.操作」调用的 call、宿主本身（用例可以换掉它的方法）与记录。
 */
export async function createProjectPortsHarness(
  root: string,
  options: ProjectPortsHarnessOptions = {}
) {
  const kernel = await createProjectKernel({ root })
  const confirmations: RecordedConfirmation[] = []
  const runs: HostRun[] = []
  const attachments: CodeAttachment[] = []
  const approved = options.approve !== false
  const approval: ApprovalPort = {
    awaitConfirmation: async (message, _signal, confirmation) => {
      confirmations.push({ message, options: confirmation })
      if (!approved) throw new AppError('PERMISSION', '用户拒绝了这次操作。')
    },
    awaitConfirmationDecision: async (message, _signal, confirmation) => {
      confirmations.push({ message, options: confirmation })
      return { approved, message: approved ? null : '用户拒绝了这次操作。', autoApproved: false }
    },
  }
  const respond: ProjectHostPort['runCommand'] =
    options.runCommand ??
    (async (command, runOptions) => commandResult(command, runOptions?.cwd ?? root))
  const host: ProjectHostPort = {
    getRootPath: () => root,
    kernel: async () => kernel,
    queryCode: async () => ({}),
    runCommand: async (command, runOptions, allowDangerous, signal) => {
      runs.push({ command, options: runOptions, allowDangerous })
      return respond(command, runOptions, allowDangerous, signal)
    },
    listBackgroundTasks: async () => [],
    refreshShellEnvironment: async () => ({ shell: '/bin/sh', variableCount: 0, refreshedAt: 0 }),
    terminateBackgroundTask: async () => ({
      terminated: false,
      statusAfter: 'unknown',
      message: '这个用例没接后台任务',
    }),
  }
  if (options.sandbox) host.sandbox = options.sandbox
  if (options.resizeImage) host.resizeImage = options.resizeImage
  const sessionId = options.sessionId ?? 'project-ports'
  const signalOf = (call: CapabilityOperationContext): AbortSignal =>
    call.signal ?? new AbortController().signal
  const shell = (call: CapabilityOperationContext): ShellOperationContext => {
    const abortSignal = signalOf(call)
    return {
      abortSignal,
      approval,
      shell: projectCapabilityPorts.shell(host, abortSignal),
      sessionId,
    }
  }
  const sandbox = (call: CapabilityOperationContext): SandboxOperationContext => {
    const abortSignal = signalOf(call)
    return { abortSignal, approval, sandbox: projectCapabilityPorts.sandbox(host, abortSignal) }
  }
  const images = (call: CapabilityOperationContext): ImageOperationContext => ({
    abortSignal: signalOf(call),
    images: projectCapabilityPorts.images(host),
    // 图不进返回值：交给代码面的图片通道，程序跑完之后跟在结果后面给模型看。宿主另给了通道就用宿主的。
    attachImage: options.attachImage ?? ((image) => call.attach({ type: 'image-data', ...image })),
  })
  const port = createCapabilityPort({
    shell: {
      run: async (input, call) => shellOperations.run(input, shell(call)),
      listTasks: async (input, call) => shellOperations.listTasks(input, shell(call)),
      refreshEnvironment: async (_input, call) => shellOperations.refreshEnvironment(shell(call)),
      stop: async (input, call) => shellOperations.stop(input, shell(call)),
    },
    sandbox: {
      create: async (input, call) => sandboxOperations.create(input, sandbox(call)),
      run: async (input, call) => sandboxOperations.run(input, sandbox(call)),
      diff: async (input, call) => sandboxOperations.diff(input, sandbox(call)),
      apply: async (input, call) => sandboxOperations.apply(input, sandbox(call)),
      discard: async (input, call) => sandboxOperations.discard(input, sandbox(call)),
    },
    images: {
      view: async (input, call) => imageOperations.view(input, images(call)),
    },
  })
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）；图记进 attachments。 */
  const call = async <T = any>(
    namespace: string,
    operation: string,
    input: unknown = {}
  ): Promise<T> => {
    const outcome = await port.invoke({ namespace, operation, input: throughJson(input) })
    attachments.push(...(outcome.attachments ?? []))
    if (outcome.error)
      throw Object.assign(new Error(outcome.error.message), {
        code: outcome.error.code,
      }) as ProgramFailure
    return throughJson(outcome.value) as T
  }
  return { kernel, host, call, confirmations, runs, attachments, sessionId }
}

/**
 * 一个记下每次调用的假演练沙箱：镜像根在临时区，差量固定三列（`diff` 可以按用例改），镜像里跑命令交回 `stdout`（缺省 `ran`）。
 * `calls` 按顺序记下调到了宿主的哪个动作、带的什么参数。
 */
export function fakeSandboxHost(
  source: string,
  options: { diff?: Partial<SandboxDiff>; stdout?: string } = {}
) {
  const calls: Array<Record<string, unknown>> = []
  const record: SandboxRecord = {
    id: '20260915-183000-3fa2c1',
    root: '/tmp/velaros-sandbox/20260915-183000-3fa2c1/tree',
    source,
    createdAt: 1,
    network: false,
    ignored: 'link',
    fileCount: 3,
    bytes: 30,
    linkedDirectories: ['node_modules'],
    git: true,
  }
  const diff: SandboxDiff = {
    sandboxId: record.id,
    source,
    created: ['src/new.ts'],
    modified: ['src/a.ts'],
    deleted: ['old.txt'],
    gitChanged: false,
    textDiffs: [],
    omittedDiffs: 0,
    fingerprint: 'fp1',
    ...options.diff,
  }
  const host: RehearsalSandboxHostPort = {
    getSandboxRecord: async () => record,
    createSandbox: async (create) => {
      calls.push({ create })
      return {
        ...record,
        source: create?.source ?? source,
        network: !!create?.network,
        ignored: create?.ignored ?? 'link',
      }
    },
    runInSandbox: async (run) => {
      calls.push({ run })
      return {
        exitCode: 0,
        stdout: options.stdout ?? 'ran',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
        success: true,
      }
    },
    diffSandbox: async (diffOptions) => {
      calls.push({ diff: diffOptions })
      return diff
    },
    applySandbox: async (apply) => {
      calls.push({ apply })
      return {
        sandboxId: apply.sandboxId,
        created: diff.created,
        modified: diff.modified,
        deleted: diff.deleted,
        skippedGit: false,
      }
    },
    discardSandbox: async (sandboxId) => {
      calls.push({ discard: sandboxId })
      return { sandboxId, removed: true }
    },
  }
  return { host, calls, record }
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
