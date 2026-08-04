#!/usr/bin/env node
// Kernel 进程入口:被 launcher spawn,负责装配 ModStore/host/service/daemon。
//
// 装载路径：ModStore（编译期 bundled packs + VELAROS_KERNEL_SYSTEM_PACKS + 用户索引）。
//
// bundled 是编译期的（宪章 §15.2）：本进程编进来的只有 sidecar 目录桩，具体能力的 bundled
// pack 由宿主的构建图注入（`bootKernelDaemon({ modPacks })`，见 daemon/bundled-packs.ts）。
//
// 外部产品通过 @velaros-ai/kernel/client：connect → openCapabilitySession → session.call。
import { isArray, isEmpty, isNotUndefined, Log } from '@velaros-ai/core'

import { KernelVersion as DefaultKernelVersion } from '../contracts/abi'

import {
  bootKernelDaemon,
  createDefaultKernelModStorePaths,
  installKernelShutdownHandlers,
  installModPackFromDirectory,
  KernelModStore,
  loadModIndexIntoStore,
  registerBundledPacks,
  registerSystemModPacks,
} from './daemon'

const log = Log.tag('KernelServe')

const KernelVersion = process.env.VELAROS_KERNEL_VERSION ?? DefaultKernelVersion
const userModsRoot = process.env.VELAROS_KERNEL_USER_MODS?.trim()
const installPack = process.env.VELAROS_KERNEL_INSTALL_PACK?.trim()
const systemPacksJson = process.env.VELAROS_KERNEL_SYSTEM_PACKS?.trim()

const modStorePaths = createDefaultKernelModStorePaths(
  isNotUndefined(userModsRoot) && !isEmpty(userModsRoot)
    ? userModsRoot
    : undefined,
)
const modStore = new KernelModStore(modStorePaths)
await loadModIndexIntoStore(modStore)
registerBundledPacks(modStore)

if (isNotUndefined(systemPacksJson) && !isEmpty(systemPacksJson)) {
  const parsed = JSON.parse(systemPacksJson) as unknown
  if (!isArray(parsed)) {
    throw new Error('VELAROS_KERNEL_SYSTEM_PACKS must be a JSON array')
  }
  registerSystemModPacks(
    modStore,
    parsed as Parameters<typeof registerSystemModPacks>[1],
  )
}

if (isNotUndefined(installPack) && !isEmpty(installPack)) {
  await installModPackFromDirectory(modStore, installPack)
}

const booted = await bootKernelDaemon({
  kernelVersion: KernelVersion,
  modStorePaths,
  modPacks: modStore.list(),
})
installKernelShutdownHandlers(booted)
logBoot(booted, KernelVersion)

function logBoot(
  booted: Awaited<ReturnType<typeof bootKernelDaemon>>,
  version: string,
): void {
  const descriptor = booted.daemon.getDescriptor()
  const moduleCount = booted.service.handshake().modules.length
  // 失败原因已由 ModLoader 记录；启动日志仍列出失败 pack，避免降级 Kernel 看起来完全健康。
  const failures = booted.modLoadFailures
  log.info('Kernel listening', {
    failedPackCount: failures.length,
    failedPackIds: failures.map((failure) => failure.id),
    moduleCount,
    pid: descriptor.pid,
    protocolVersion: descriptor.protocolVersion,
    version,
  })
}
