// Kernel 守护进程的可运行形态：被 launcher spawn 的那个进程要做的事，全在这一个类里。
//
// 装载路径：ModStore（VELAROS_KERNEL_SYSTEM_PACKS + 用户索引）。
//
// bundled 是编译期的（宪章 §15.2）：内核自己一个 bundled pack 都不带，具体能力的 bundled
// pack 由宿主的构建图注入（`bootKernelDaemon({ bundledPacks })`，见 utils/serve/mod-packs.ts）。
//
// 外部产品通过 @velaros-ai/kernel/client：connect → openCapabilitySession → session.call。
import { isEmpty, isNotUndefined, Log } from '@velaros-ai/core'

import { KernelVersionAxes } from '../../contract/constants'
import type { KernelModuleImporter } from '../../contract/requires'
import { parseKernelSystemModPacks } from '../../utils/serve/mod-index'

import {
  type BootedKernelDaemonApi,
  bootKernelDaemon,
} from './KernelDaemonAssembly'
import { installModPackFromDirectory, loadModIndexIntoStore } from './KernelModLoader'
import {
  createDefaultKernelModStorePaths,
  KernelModStore,
} from './KernelModStore'

const log = Log.tag('KernelServe')

/** 可执行文件交进来的进程环境（读的是 KernelEnvironmentVariables 登记过的那几个名字）。 */
export interface KernelDaemonProcessEnvironment {
  /** 变量名 → 值；没设过的名字读出来是 undefined。 */
  readonly [name: string]: string | undefined
}

/** 守护进程可执行文件的唯一能力：按进程环境装配并启动一个 Kernel，然后一直跑着。 */
export interface KernelDaemonProcessApi {
  /** 读环境变量、装 ModStore、起守护进程、装信号处理；返回已启动的装配件。装配失败照抛。 */
  run(input: {
    readonly environment: KernelDaemonProcessEnvironment
    readonly importModule?: KernelModuleImporter
  }): Promise<BootedKernelDaemonApi>
}

/** 守护进程可执行文件背后的那一件事。 */
export class KernelDaemonProcess implements KernelDaemonProcessApi {
  public async run(input: {
    readonly environment: KernelDaemonProcessEnvironment
    readonly importModule?: KernelModuleImporter
  }): Promise<BootedKernelDaemonApi> {
    const { environment } = input
    const kernelVersion = environment.VELAROS_KERNEL_VERSION ?? KernelVersionAxes.kernel

    // 建 ModStore：先读用户索引，再按环境变量登记系统 pack、安装目录 pack。
    const userModsRoot = environment.VELAROS_KERNEL_USER_MODS?.trim()
    const paths = createDefaultKernelModStorePaths(
      isNotUndefined(userModsRoot) && !isEmpty(userModsRoot) ? userModsRoot : undefined,
    )
    const store = new KernelModStore(paths)
    await loadModIndexIntoStore(store)

    const systemPacksJson = environment.VELAROS_KERNEL_SYSTEM_PACKS?.trim()
    if (isNotUndefined(systemPacksJson) && !isEmpty(systemPacksJson)) {
      store.registerSystem(parseKernelSystemModPacks(systemPacksJson))
    }

    const installPack = environment.VELAROS_KERNEL_INSTALL_PACK?.trim()
    if (isNotUndefined(installPack) && !isEmpty(installPack)) {
      await installModPackFromDirectory(store, installPack)
    }

    const booted = await bootKernelDaemon({
      importModule: input.importModule,
      kernelVersion,
      modStorePaths: paths,
      modPacks: store.list(),
    })
    booted.installShutdownHandlers()

    // 启动日志：失败原因已由 ModLoader 记录，这里仍列出失败 pack，免得降级的 Kernel 看起来完全健康。
    const descriptor = booted.daemon.getDescriptor()
    const failures = booted.modLoadFailures
    log.info('Kernel 已开始监听', {
      failedPackCount: failures.length,
      failedPackIds: failures.map((failure) => failure.id),
      moduleCount: booted.service.handshake().modules.length,
      pid: descriptor.pid,
      protocolVersion: descriptor.protocolVersion,
      version: kernelVersion,
    })
    return booted
  }
}

/** 守护进程可执行文件用的单例；`bin/velaros-kernel-daemon.mjs` 只调它的 `run`。 */
export const kernelDaemonProcess: KernelDaemonProcessApi = new KernelDaemonProcess()
