/**
 * 系统空间：`SystemSpace`，接口 `SystemSpaceApi` 在本文件的类上方，由 `createSystemSpace` 创建。
 *
 * 一个空间就是一张装配表：给哪几件能力、每件能力用哪个端口。能力本身不在这里——`velar:files`（本机文件）、`velar:shell`、
 * `velar:sandbox`、`velar:images` 各有各的包，一件能力只有一份实现；这里只写系统空间的端口：
 * 路径可以是本机任意位置、`~` 展开到家目录，凭证文件与系统敏感路径先问用户，写是逐个原子替换（撤回新建时是核对后删掉），
 * 命令在本机任意目录跑，沙箱可以镜像任意目录，看图能看本机任意位置的图。这个文件里没有一个字是给模型看的。
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CapabilityOperationContext, CapabilityOperationTable } from '@velaros-ai/code-surface/contracts'
import { AppError, isNotNull, isNull } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import type { FileOperationContext, FileSpacePort } from '@velaros-ai/velar/files'
import { fileOperations } from '@velaros-ai/velar/files'
import type { ImageOperationContext, ImageSpacePort } from '@velaros-ai/velar/images'
import { imageOperations } from '@velaros-ai/velar/images'
import type { SandboxOperationContext, SandboxSurfacePort } from '@velaros-ai/velar/sandbox'
import { sandboxOperations } from '@velaros-ai/velar/sandbox'
import type { ShellOperationContext, ShellSpacePort } from '@velaros-ai/velar/shell'
import { shellOperations } from '@velaros-ai/velar/shell'

import type { SystemCallContext, SystemSpaceHost } from '../contract/requires.js'
import { credentialConfirmation, isCredentialPath, isSensitiveSystemMutationPath, sensitiveMutationConfirmation } from '../utils/file-safety.js'
import { removeSystemFile, writeSystemFileAtomically } from '../utils/fs.js'
import { resizeImageWithSips } from '../utils/image.js'

/** 系统空间：代码面的一张操作表，四件能力配上系统空间的端口。 */
export interface SystemSpaceApi {
  /**
   * 操作表：`files`、`shell`、`sandbox`、`images` 四个命名空间，交给 `createCapabilityPort` 接成能力端口。
   * 每次调用都向宿主要一次调用上下文：审批通道、取消信号、会话是**这一次调用**的，不能缓存——
   * 缓存一份就等于把上一次调用的审批通道借给下一次用。
   */
  readonly operations: CapabilityOperationTable
}

class SystemSpace implements SystemSpaceApi {
  private static readonly SandboxClosingNote = '删除和覆盖无法撤销；落回前会核对这些文件自建沙箱以来没被别人改过，改过就整批不落。'

  private readonly filePort: FileSpacePort
  private readonly shellPort: ShellSpacePort
  private readonly sandboxPort: SandboxSurfacePort
  private readonly imagePort: ImageSpacePort

  public constructor(
    private readonly host: SystemSpaceHost,
    private readonly resolveCall: (signal: Optional<AbortSignal>) => SystemCallContext | Promise<SystemCallContext>,
  ) {
    this.filePort = this.createFilePort()
    this.shellPort = this.createShellPort()
    this.sandboxPort = this.createSandboxPort()
    this.imagePort = this.createImagePort()
  }

  public get operations(): CapabilityOperationTable {
    const files = async (context: CapabilityOperationContext): Promise<FileOperationContext> => {
      const call = await this.call(context)
      return { abortSignal: call.abortSignal, approval: call.approval, files: this.filePort }
    }
    const images = async (context: CapabilityOperationContext): Promise<ImageOperationContext> => {
      const call = await this.call(context)
      // 图不进返回值：交给代码面的图片通道，程序跑完之后跟在结果后面给模型看。宿主另给了通道就用宿主的。
      return { abortSignal: call.abortSignal, images: this.imagePort, attachImage: call.attachImage ?? ((image) => context.attach({ type: 'image-data', ...image })) }
    }
    const shell = async (context: CapabilityOperationContext): Promise<ShellOperationContext> => {
      const call = await this.call(context)
      const shellContext: ShellOperationContext = { abortSignal: call.abortSignal, approval: call.approval, shell: this.shellPort }
      if (call.sessionId) shellContext.sessionId = call.sessionId
      return shellContext
    }
    const sandbox = async (context: CapabilityOperationContext): Promise<SandboxOperationContext> => {
      const call = await this.call(context)
      return { abortSignal: call.abortSignal, approval: call.approval, sandbox: this.sandboxPort }
    }
    return {
      files: {
        read: async (input, context) => fileOperations.read(input, await files(context)),
        edit: async (input, context) => fileOperations.edit(input, await files(context)),
        undo: async (input, context) => fileOperations.undo(input, await files(context)),
      },
      shell: {
        run: async (input, context) => shellOperations.run(input, await shell(context)),
        listTasks: async (input, context) => shellOperations.listTasks(input, await shell(context)),
        refreshEnvironment: async (_input, context) => shellOperations.refreshEnvironment(await shell(context)),
      },
      sandbox: {
        create: async (input, context) => sandboxOperations.create(input, await sandbox(context)),
        run: async (input, context) => sandboxOperations.run(input, await sandbox(context)),
        diff: async (input, context) => sandboxOperations.diff(input, await sandbox(context)),
        apply: async (input, context) => sandboxOperations.apply(input, await sandbox(context)),
        discard: async (input, context) => sandboxOperations.discard(input, await sandbox(context)),
      },
      images: {
        view: async (input, context) => imageOperations.view(input, await images(context)),
      },
    }
  }

  /** 向宿主要这一次调用的上下文。 */
  private call(context: CapabilityOperationContext): Promise<SystemCallContext> {
    return Promise.resolve(this.resolveCall(context.signal))
  }

  /** `velar:files` 的系统空间端口：路径是本机任意位置，凭证文件与系统敏感路径先问用户，写是一个一个原子替换，撤回新建时核对后删掉。 */
  private createFilePort(): FileSpacePort {
    return {
      locate: async (path) => {
        const resolved = this.host.resolvePath(path)
        const target = await resolveRealPath(resolved)
        return { path: resolved, target, linked: target !== resolved }
      },
      reviewRead: async (target) => [credentialConfirmation(target, 'read')].filter(isNotNull),
      reviewWrite: async (target) => [await sensitiveMutationConfirmation(target), credentialConfirmation(target, 'write')].filter(isNotNull),
      commit: async (writes) => {
        const applied: string[] = []
        for (const write of writes) {
          try {
            if (isNull(write.bytes)) await removeSystemFile(write.target, write.expected)
            else {
              await mkdir(dirname(write.target), { recursive: true })
              await writeSystemFileAtomically(write.target, write.bytes, write.expected)
            }
            applied.push(write.target)
          } catch (error) {
            const failure = AppError.from(error)
            throw new AppError(failure.code, failure.message, error, { applied })
          }
        }
      },
    }
  }

  /**
   * `velar:images` 的系统空间端口：本机任意位置的图，`~` 展开到家目录，读它解开符号链接之后的那个文件。
   * macOS 上用系统自带的 sips 缩图裁图；别的平台不给这个口子，view 遇到超限的图会明说。
   */
  private createImagePort(): ImageSpacePort {
    const port: ImageSpacePort = {
      locate: async (path) => {
        const resolved = this.host.resolvePath(path)
        return { target: await resolveRealPath(resolved), shown: resolved }
      },
    }
    if (process.platform === 'darwin') port.resizeImage = resizeImageWithSips
    return port
  }

  /** `velar:shell` 的系统空间端口：命令在本机任意目录跑，确认文案说在哪个目录（没给就是系统运行环境）。 */
  private createShellPort(): ShellSpacePort {
    return {
      resolveCwd: async (cwd) => this.host.resolvePath(cwd),
      commandPolicy: (cwd) => ({ scopeLabel: cwd ?? '系统运行环境', riskScope: 'system-command:dangerous' }),
      runCommand: (command, options, allowDangerous, abortSignal) => this.host.runCommand(command, options, allowDangerous, abortSignal),
      listBackgroundTasks: (options) => this.host.listBackgroundTasks(options),
      refreshShellEnvironment: () => this.host.refreshShellEnvironment(),
    }
  }

  /** `velar:sandbox` 的系统空间端口：镜像任意目录；镜像里的命令交给宿主，cwd 落在镜像根里，宿主就钉死约束。 */
  private createSandboxPort(): SandboxSurfacePort {
    return {
      createSandbox: (options) => this.host.createSandbox(options),
      diffSandbox: (options) => this.host.diffSandbox(options),
      applySandbox: (options) => this.host.applySandbox(options),
      discardSandbox: (sandboxId) => this.host.discardSandbox(sandboxId),
      resolveSource: async (source) => this.host.resolvePath(source),
      runInSandbox: async (options, abortSignal) => {
        const record = this.host.listSandboxes().find((candidate) => candidate.id === options.sandboxId)
        if (!record) throw new AppError('NOT_FOUND', `没有 ${options.sandboxId} 这个沙箱：它可能已经丢弃了；重新 create 一个`)
        const result = await this.host.runCommand(options.command, { cwd: record.root, timeoutMs: options.timeoutMs, maxOutputChars: options.maxOutputChars }, false, abortSignal)
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, timedOut: result.timedOut, truncated: result.truncated, success: result.success }
      },
      applyPolicy: (source) => ({
        targetLabel: source,
        closingNote: SystemSpace.SandboxClosingNote,
        riskScope: 'system-sandbox:apply',
        isSensitive: (path) => isSensitiveSystemMutationPath(join(source, path)) || isCredentialPath(join(source, path)),
      }),
    }
  }
}

/**
 * 装一个系统空间。`host` 是本机能力（本地内核），装的时候给一次；`resolveCall` 每次调用都会被叫一次，
 * 给出这一次调用的审批通道、取消信号与会话。
 */
export function createSystemSpace(input: {
  host: SystemSpaceHost
  resolveCall: (signal: Optional<AbortSignal>) => SystemCallContext | Promise<SystemCallContext>
}): SystemSpaceApi {
  return new SystemSpace(input.host, input.resolveCall)
}
