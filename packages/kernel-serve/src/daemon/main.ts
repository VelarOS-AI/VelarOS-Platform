#!/usr/bin/env node
// Kernel 进程入口:被 launcher spawn,负责装配 ModStore/host/service/daemon。
//
// 装载路径（优先级）:
// 1. VELAROS_KERNEL_MODULES — JSON 清单（动态 import）
// 2. ModStore：编译期 bundled packs + VELAROS_KERNEL_SYSTEM_PACKS + 用户索引
//
// bundled 是编译期的（宪章 §15.2）：本进程编进来的只有 sidecar 目录桩，具体能力的 bundled
// pack 由宿主的构建图注入（`bootKernelDaemon({ modPacks })`，见 daemon/bundled-packs.ts）。
//
// 外部产品一律通过 kernel-client：connect → openCapabilitySession → session.call。
import {
  bootKernelDaemon,
  createDefaultKernelModStorePaths,
  installKernelShutdownHandlers,
  installModPackFromDirectory,
  KernelModStore,
  loadKernelModulesFromManifest,
  loadModIndexIntoStore,
  registerBundledPacks,
  registerSystemModPacks,
} from './daemon'

const KernelVersion = process.env.VELAROS_KERNEL_VERSION ?? '0.3.0'
const modulesManifest = process.env.VELAROS_KERNEL_MODULES?.trim()
const userModsRoot = process.env.VELAROS_KERNEL_USER_MODS?.trim()
const installPack = process.env.VELAROS_KERNEL_INSTALL_PACK?.trim()
const systemPacksJson = process.env.VELAROS_KERNEL_SYSTEM_PACKS?.trim()

const modStorePaths = createDefaultKernelModStorePaths(
  userModsRoot !== undefined && userModsRoot.length > 0
    ? userModsRoot
    : undefined,
)
const modStore = new KernelModStore(modStorePaths)
await loadModIndexIntoStore(modStore)
registerBundledPacks(modStore)

if (systemPacksJson !== undefined && systemPacksJson.length > 0) {
  const parsed = JSON.parse(systemPacksJson) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('VELAROS_KERNEL_SYSTEM_PACKS must be a JSON array')
  }
  registerSystemModPacks(
    modStore,
    parsed as Parameters<typeof registerSystemModPacks>[1],
  )
}

if (installPack !== undefined && installPack.length > 0) {
  await installModPackFromDirectory(modStore, installPack)
}

if (modulesManifest !== undefined && modulesManifest.length > 0) {
  const modules = await loadKernelModulesFromManifest(modulesManifest)
  const booted = await bootKernelDaemon({
    kernelVersion: KernelVersion,
    modStorePaths,
    modules,
  })
  installKernelShutdownHandlers(booted)
  logBoot(booted, KernelVersion)
} else {
  const booted = await bootKernelDaemon({
    kernelVersion: KernelVersion,
    modStorePaths,
    modPacks: modStore.list(),
  })
  installKernelShutdownHandlers(booted)
  logBoot(booted, KernelVersion)
}

function logBoot(
  booted: Awaited<ReturnType<typeof bootKernelDaemon>>,
  version: string,
): void {
  const descriptor = booted.daemon.getDescriptor()
  const moduleCount = booted.service.handshake().modules.length
  // Failed packs already logged their own reason in ModLoader; the boot line
  // carries the roll-call so a degraded Kernel never looks like a healthy one.
  const failures = booted.modLoadFailures
  const failureText = failures.length === 0
    ? ''
    : `, failed packs ${failures.length} [${failures.map((failure) => failure.id).join(', ')}]`
  console.info(
    `velaros-kernel ${version} listening (protocol v${descriptor.protocolVersion}, pid ${descriptor.pid}, modules ${moduleCount}${failureText}).`,
  )
}
