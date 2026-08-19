import { mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  type ComputerRuntimePort,
  ComputerSidecarManager,
  createComputerKernelModule,
  resolveComputerHelper,
} from '@velaros-ai/computer/runtime'
import { isPresent, Log, stringifyPretty, toOptional } from '@velaros-ai/core'
import { KernelClient } from '@velaros-ai/kernel/client'
import type { KernelRpcEndpoint } from '@velaros-ai/kernel/client/contracts'
import {
  type BootedKernelDaemon,
  bootKernelDaemon,
  createDefaultKernelModStorePaths,
  InProcessKernelTransport,
} from '@velaros-ai/kernel/serve'
import { installProjectApprovalProvider } from '@velaros-ai/project/composition'
import { createProjectKernelModule } from '@velaros-ai/project/kernel'
import {
  createProjectKernel,
} from '@velaros-ai/project/runtime'
import {
  createLocalSystemKernel,
  createSystemKernelModule,
} from '@velaros-ai/system'

import {
  createVelarHostProjectToolContext,
  createVelarHostSystemToolContext,
} from './capability-contexts'
import {
  installVelarHostComputer,
  type InstallVelarHostComputerResult,
  velarHostComputerResourceRoot,
} from './computer-installer'
import { VelarHostConfigStore } from './config'
import { createVelarHostPaths, type VelarHostPaths } from './data-root'
import {
  VelarHostExtensionBridge,
  type VelarHostExtensionBridgeStatus,
} from './extension-bridge'
import {
  VelarHostManagementServer,
  type VelarHostManagementStatus,
} from './management-ipc'
import { VelarHostPermissionBroker } from './permission-policy'
import {
  VelarHostRemoteNode,
  type VelarHostRemoteNodeStatus,
} from './remote-node'
import { VelarHostToolGateway } from './tool-gateway'

export const VelarHostVersion = '0.2.1'
export const VelarHostKernelVersion = '0.3.2'
const HostLog = Log.tag('VelarHost')

export interface StartVelarHostOptions {
  readonly dataRoot?: string
  readonly projectRoot?: string
  readonly portStart?: number
  readonly portEnd?: number
  readonly pairingCode?: string
  /** Test/product seam; default is the packaged Computer sidecar runtime. */
  readonly computerRuntime?: ComputerRuntimePort
  /** Test/embedder seam; default installs an isolated runtime under the Host data root. */
  readonly computerInstaller?: () => Promise<InstallVelarHostComputerResult>
  readonly now?: () => number
}

export interface VelarHostPublicStatus {
  readonly schemaVersion: 3
  readonly version: string
  readonly pid: number
  readonly startedAt: number
  readonly dataRoot: string
  readonly projectRoot: string
  readonly kernel: {
    readonly protocolVersion: number
    readonly kernelVersion: string
    readonly endpoint: KernelRpcEndpoint
    readonly moduleIds: readonly string[]
  }
  readonly extension: VelarHostExtensionBridgeStatus
  readonly management: VelarHostManagementStatus
  /** 公共状态文件里只有远程节点的可观测事实；配对码与密钥材料永不落入本文件。 */
  readonly remoteNode: VelarHostRemoteNodeStatus
}

export interface VelarHostRuntime {
  readonly paths: VelarHostPaths
  readonly config: VelarHostConfigStore
  readonly computer: ComputerRuntimePort
  readonly managementServer: VelarHostManagementServer
  readonly status: VelarHostPublicStatus
  readonly extensionBridge: VelarHostExtensionBridge
  readonly remoteNode: VelarHostRemoteNode
  stop(): Promise<void>
}

/** Starts one complete, UI-independent Velar Host process composition. */
export async function startVelarHost(
  options: StartVelarHostOptions = {},
): Promise<VelarHostRuntime> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const paths = createVelarHostPaths(options.dataRoot)
  const projectRoot = resolve(options.projectRoot?.trim() || process.cwd())
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 })
  await removeLegacyWebManagementState(paths.dataRoot)

  const config = await VelarHostConfigStore.open(paths.configPath)
  const computer = options.computerRuntime ?? new ComputerSidecarManager({
    resolveHelper: () => {
      const configuredRoots = config.snapshot().value.computer.resourceRoots
      return resolveComputerHelper({
        resourceRoots: [
          velarHostComputerResourceRoot(paths.dataRoot),
          ...configuredRoots,
        ],
      })
    },
  })
  const project = await createProjectKernel({ root: projectRoot })
  installProjectApprovalProvider(project)
  const system = createLocalSystemKernel({ cwd: projectRoot })
  let booted: BootedKernelDaemon | undefined
  let kernelClient: KernelClient | undefined
  let toolGateway: VelarHostToolGateway | undefined
  let extensionBridge: VelarHostExtensionBridge | undefined
  let remoteNode: VelarHostRemoteNode | undefined
  let managementServer: VelarHostManagementServer | undefined
  let status: VelarHostPublicStatus | undefined
  try {
    booted = await bootKernelDaemon({
      kernelVersion: VelarHostKernelVersion,
      paths: paths.kernel,
      modStorePaths: createDefaultKernelModStorePaths(paths.modsRoot),
      modules: [
        createProjectKernelModule({
          resolveContext: (_scope, signal) => createVelarHostProjectToolContext({
            projectRoot,
            kernel: project,
            system,
            config,
            signal,
          }),
        }),
        createSystemKernelModule({
          resolveContext: (_scope, signal) =>
            createVelarHostSystemToolContext(system, signal),
        }),
        createComputerKernelModule({
          runtime: computer,
          disposeInjectedRuntime: !isPresent(options.computerRuntime),
        }),
      ],
      permissionBroker: new VelarHostPermissionBroker(config),
    })
    kernelClient = new KernelClient(new InProcessKernelTransport(booted.service))
    toolGateway = new VelarHostToolGateway(kernelClient, config)
    await toolGateway.start()
    extensionBridge = new VelarHostExtensionBridge({
      credentialPath: paths.credentialPath,
      projectRoot,
      toolGateway,
      hostVersion: VelarHostVersion,
      portStart: toOptional(options.portStart),
      portEnd: toOptional(options.portEnd),
      pairingCode: toOptional(options.pairingCode),
      now,
    })
    const extension = await extensionBridge.start()
    const descriptor = booted.daemon.getDescriptor()
    const handshake = booted.service.handshake()
    remoteNode = new VelarHostRemoteNode({
      config,
      toolGateway,
      credentialPath: paths.remoteNodeCredentialPath,
      auditRoot: paths.auditRoot,
      dataRoot: paths.dataRoot,
      hostVersion: VelarHostVersion,
      modules: handshake.modules,
    })
    const remoteNodeStatus = await remoteNode.start()
    managementServer = new VelarHostManagementServer({
      endpoint: paths.managementEndpoint,
      config,
      computer,
      extensionBridge,
      remoteNode,
      installComputer: options.computerInstaller
        ?? (() => installVelarHostComputer({ dataRoot: paths.dataRoot })),
      getHostStatus: () => {
        if (!isPresent(status)) throw new Error('Velar Host is still starting')
        return status
      },
    })
    const management = await managementServer.start()
    status = {
      schemaVersion: 3,
      version: VelarHostVersion,
      pid: process.pid,
      startedAt,
      dataRoot: paths.dataRoot,
      projectRoot,
      kernel: {
        protocolVersion: descriptor.protocolVersion,
        kernelVersion: descriptor.kernelVersion,
        endpoint: descriptor.endpoint,
        moduleIds: handshake.modules.map((module) => module.id),
      },
      extension,
      management,
      remoteNode: remoteNodeStatus,
    }
    await writePublicStatus(paths.statusPath, status)
    let statusWrite = Promise.resolve()
    const applyStatus = (patch: Partial<VelarHostPublicStatus>): void => {
      const previous = status
      if (!isPresent(previous)) return
      const next = { ...previous, ...patch }
      status = next
      statusWrite = statusWrite.then(() => writePublicStatus(paths.statusPath, next))
    }
    const unsubscribeExtensionStatus = extensionBridge.subscribeStatus(
      (extensionStatus) => applyStatus({ extension: extensionStatus }),
    )
    const unsubscribeRemoteNodeStatus = remoteNode.subscribeStatus(
      (nodeStatus) => applyStatus({ remoteNode: nodeStatus }),
    )

    let stopped = false
    const runtime: VelarHostRuntime = {
      paths,
      config,
      computer,
      get status() {
        return status!
      },
      extensionBridge,
      remoteNode,
      managementServer,
      stop: async () => {
        if (stopped) return
        stopped = true
        unsubscribeExtensionStatus()
        unsubscribeRemoteNodeStatus()
        await settleCleanup('本地管理服务', () => managementServer?.stop())
        await settleCleanup('远程节点', () => remoteNode?.stop())
        await settleCleanup('插件桥', () => extensionBridge?.stop())
        await settleCleanup('工具网关', () => toolGateway?.dispose())
        await settleCleanup('Kernel 客户端', () => kernelClient?.dispose())
        await settleCleanup('Kernel daemon', () => booted?.stop())
        await settleCleanup('Host 状态写入', () => statusWrite)
        await unlink(paths.statusPath).catch((error) => {
          if (!isNodeError(error, 'ENOENT')) throw error
        })
      },
    }
    return runtime
  } catch (error) {
    await settleCleanup('启动失败后的本地管理服务', () => managementServer?.stop())
    await settleCleanup('启动失败后的远程节点', () => remoteNode?.stop())
    await settleCleanup('启动失败后的插件桥', () => extensionBridge?.stop())
    await settleCleanup('启动失败后的工具网关', () => toolGateway?.dispose())
    await settleCleanup('启动失败后的 Kernel 客户端', () => kernelClient?.dispose())
    await settleCleanup('启动失败后的 Kernel daemon', () => booted?.stop())
    throw error
  }
}

export function installVelarHostShutdownHandlers(runtime: VelarHostRuntime): () => void {
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void runtime.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, stop)
  return () => {
    for (const signal of signals) process.off(signal, stop)
  }
}

async function writePublicStatus(
  path: string,
  status: VelarHostPublicStatus,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${stringifyPretty(status)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
}

async function settleCleanup(
  label: string,
  operation: () => Promise<unknown> | void,
): Promise<void> {
  try {
    await operation()
  // arch-guard:silent-catch-ok 清理失败已记录，必须继续回收其余独立资源。
  } catch (error) {
    HostLog.warn(`${label}清理失败，继续回收其余 Host 资源。`, { error })
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

/** One-way migration: remove the retired HTTP control token without deleting unknown files. */
async function removeLegacyWebManagementState(dataRoot: string): Promise<void> {
  const directory = join(dataRoot, 'control')
  await unlink(join(directory, 'token')).catch((error) => {
    if (!isNodeError(error, 'ENOENT')) throw error
  })
  await rmdir(directory).catch((error) => {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error
  })
}
