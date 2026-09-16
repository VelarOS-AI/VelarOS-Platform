// Kernel 守护进程的可运行形态：被 launcher spawn 的那个进程要做的事，全在这一个类里。
//
// 装载路径：ModStore（VELAROS_KERNEL_SYSTEM_PACKS + 用户索引）。
//
// bundled 是编译期的（宪章 §15.2）：内核自己一个 bundled pack 都不带，具体能力的 bundled
// pack 由宿主的构建图注入（`bootKernelDaemon({ modPacks })`，见 utils/serve/mod-packs.ts）。
//
// 外部产品通过 @velaros-ai/kernel/client：connect → openCapabilitySession → session.call。
import { isArray, isEmpty, isNotUndefined, Log } from '@velaros-ai/core'

import { KernelVersion as DefaultKernelVersion } from '../../contract/constants'

import {
  type BootedKernelDaemon,
  bootKernelDaemon,
  installKernelShutdownHandlers,
} from './KernelDaemonAssembly'
import { installModPackFromDirectory, loadModIndexIntoStore } from './KernelModLoader'
import {
  createDefaultKernelModStorePaths,
  KernelModStore,
  registerSystemModPacks,
} from './KernelModStore'

const log = Log.tag('KernelServe')

/** 可执行文件交进来的进程环境（读的是 KernelEnvironmentVariables 登记过的那几个名字）。 */
export interface KernelDaemonProcessEnvironment {
  readonly [name: string]: string | undefined
}

/** 守护进程可执行文件的唯一能力：按进程环境装配并启动一个 Kernel，然后一直跑着。 */
export interface KernelDaemonProcessApi {
  /** 读环境变量、装 ModStore、起守护进程、装信号处理；返回已启动的装配件。 */
  run(input: {
    readonly environment: KernelDaemonProcessEnvironment
  }): Promise<BootedKernelDaemon>
}

export class KernelDaemonProcess implements KernelDaemonProcessApi {
  public async run(input: {
    readonly environment: KernelDaemonProcessEnvironment
  }): Promise<BootedKernelDaemon> {
    const { environment } = input
    const kernelVersion = environment.VELAROS_KERNEL_VERSION ?? DefaultKernelVersion
    const modStore = await this.prepareModStore(environment)
    const booted = await bootKernelDaemon({
      kernelVersion,
      modStorePaths: modStore.paths,
      modPacks: modStore.store.list(),
    })
    installKernelShutdownHandlers(booted)
    this.logBoot(booted, kernelVersion)
    return booted
  }

  /** 建 ModStore：读用户索引，再按环境变量登记系统 pack、安装目录 pack。 */
  private async prepareModStore(
    environment: KernelDaemonProcessEnvironment,
  ): Promise<{
    readonly store: KernelModStore
    readonly paths: ReturnType<typeof createDefaultKernelModStorePaths>
  }> {
    const userModsRoot = environment.VELAROS_KERNEL_USER_MODS?.trim()
    const paths = createDefaultKernelModStorePaths(
      isNotUndefined(userModsRoot) && !isEmpty(userModsRoot) ? userModsRoot : undefined,
    )
    const store = new KernelModStore(paths)
    await loadModIndexIntoStore(store)

    const systemPacksJson = environment.VELAROS_KERNEL_SYSTEM_PACKS?.trim()
    if (isNotUndefined(systemPacksJson) && !isEmpty(systemPacksJson)) {
      const parsed = JSON.parse(systemPacksJson) as unknown
      if (!isArray(parsed)) {
        throw new Error('VELAROS_KERNEL_SYSTEM_PACKS 必须是一个 JSON 数组')
      }
      registerSystemModPacks(
        store,
        parsed as Parameters<typeof registerSystemModPacks>[1],
      )
    }

    const installPack = environment.VELAROS_KERNEL_INSTALL_PACK?.trim()
    if (isNotUndefined(installPack) && !isEmpty(installPack)) {
      await installModPackFromDirectory(store, installPack)
    }
    return { store, paths }
  }

  /** 启动日志：失败原因已由 ModLoader 记录，这里仍列出失败 pack，免得降级的 Kernel 看起来完全健康。 */
  private logBoot(booted: BootedKernelDaemon, version: string): void {
    const descriptor = booted.daemon.getDescriptor()
    const failures = booted.modLoadFailures
    log.info('Kernel listening', {
      failedPackCount: failures.length,
      failedPackIds: failures.map((failure) => failure.id),
      moduleCount: booted.service.handshake().modules.length,
      pid: descriptor.pid,
      protocolVersion: descriptor.protocolVersion,
      version,
    })
  }
}

/** 守护进程可执行文件用的单例；`bin/velaros-kernel-daemon.mjs` 只调它的 `run`。 */
export const kernelDaemonProcess: KernelDaemonProcessApi = new KernelDaemonProcess()
