import {
  createCapabilityToken,
  defineKernelModule,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel/contracts/abi'

import type { KernelModPackRecord } from './mod-store'
import { type KernelModStore, registerSystemModPacks } from './mod-store'

/**
 * 编译期 bundled pack:模块实例随构建图进来,装载零 IO。
 *
 * 宪章 §15.2 层间铁律「`bundled` = 编译期依赖(不是运行时下载物)」+「`importSibling` 退役」:
 * bundled pack 不再是「一个 .mjs 入口文件 + 运行时按磁盘布局算路径 import」,而是一个
 * **数组常量**——谁编进来谁负责,构建图解析不了就是构建期红,运行时没有这一类失败面。
 *
 * 依赖方向(§15.2 ⑤→④→③→②)决定了**谁能编进来**:
 *  - 本包是第 ② 层的 serve 配件,不认识任何具体能力包(workspace / computer-runtime /
 *    Project / System …),所以本文件的 bundled 清单里只有**内核自己能构造**的 sidecar 目录桩;
 *  - 具体能力的 bundled pack 归**宿主**(第 ⑤ 层:Desktop / Workbench / VelarOS Terminal)的
 *    构建图:宿主静态 import 能力包的 `create*KernelModule()`,用 {@link createBundledModPack}
 *    折成记录,经 `bootKernelDaemon({ modPacks })` 注入。
 *
 * **为什么不让本包直接 import 能力包**:那会把 ②→④ 的反向依赖焊进内核,arch-guard 防线⑥
 * (「Kernel 不得依赖任何具体能力实现」)当场红,且每加一个随包能力就得改内核一次。
 */
export interface KernelBundledPack {
  readonly id: string
  readonly version: string
  readonly provides: readonly string[]
  /** 编译期就在手的模块定义;`specifier` 只是身份回显,永不被 import。 */
  readonly module: KernelModuleDefinition
}

/**
 * bundled pack 的 `specifier`:一个**身份 URI**,不是磁盘路径。
 *
 * wire 上的 `KernelModPackDescriptor.specifier` 对 installed pack 是可 import 的路径,对
 * bundled pack 是「它是谁」——用带 scheme 的形态把两者机械分开,避免有人拿它去 import。
 */
export function bundledPackSpecifier(moduleId: string): string {
  return `bundled:${moduleId}`
}

/** 把一个编译期模块折成 ModStore 记录(宿主注入 bundled 能力的唯一入口)。 */
export function createBundledModPack(input: {
  readonly id: string
  readonly module: KernelModuleDefinition
  readonly version?: string
  readonly provides?: readonly string[]
}): KernelBundledPack {
  return {
    id: input.id,
    version: input.version ?? input.module.manifest.version,
    provides: input.provides
      ?? input.module.manifest.provides.map((token) => token.id),
    module: input.module,
  }
}

/**
 * Sidecar 目录桩:能力目录在 Kernel,实现在产品 HostBridge 那一侧。
 *
 * 存在的理由是**目录可见性**——瘦客户端 handshake 前就得知道「这个 Kernel 上有 agent /
 * model / browser」;activate 恒抛错,真正的激活由 sidecar isolation adapter 接管。
 */
function sidecarPack(options: {
  readonly packId: string
  readonly moduleId: string
  readonly version: string
  readonly capabilityId: string
  readonly permissions?: readonly string[]
}): KernelBundledPack {
  const module = defineKernelModule({
    manifest: {
      id: options.moduleId,
      version: options.version,
      apiVersion: KernelModuleApiVersion,
      provides: [createCapabilityToken(options.capabilityId)],
      requires: [],
      optionalRequires: [],
      permissions: options.permissions ?? [],
      isolation: 'sidecar',
    },
    activate() {
      throw new Error(
        `Sidecar module "${options.moduleId}" must be activated by HostBridge adapter`,
      )
    },
  })
  return {
    id: options.packId,
    version: options.version,
    provides: [options.capabilityId],
    module,
  }
}

/** 随 Kernel 进程编译进来的 pack 清单(编译期常量,不做磁盘发现)。 */
export const BundledKernelPacks: readonly KernelBundledPack[] = [
  sidecarPack({
    packId: 'system.agent',
    moduleId: 'velaros.agent.sidecar',
    version: '0.3.2',
    capabilityId: 'velaros.agent',
    permissions: ['agent:execute'],
  }),
  sidecarPack({
    packId: 'system.model',
    moduleId: 'velaros.model.sidecar',
    version: '0.3.0',
    capabilityId: 'velaros.model',
  }),
  sidecarPack({
    packId: 'system.browser',
    moduleId: 'velaros.browser.sidecar',
    version: '0.3.0',
    capabilityId: 'velaros.browser',
    permissions: ['browser:control'],
  }),
]

export function toBundledPackRecords(
  packs: readonly KernelBundledPack[] = BundledKernelPacks,
): readonly KernelModPackRecord[] {
  return packs.map((pack) => ({
    id: pack.id,
    kind: 'system' as const,
    version: pack.version,
    specifier: bundledPackSpecifier(pack.module.manifest.id),
    enabled: true,
    provides: [...pack.provides],
    module: pack.module,
  }))
}

/**
 * 把 bundled pack 登记进 store(默认开,`VELAROS_KERNEL_AUTO_SYSTEM_PACKS=0` 关整批)。
 *
 * 刻意不传 `enabled`:随包默认是「开」,但用户经 `mods.setEnabled` 停用过的 pack(持久化在
 * mod index 里、本调用之前已载入 store)必须跨重启保持关闭。返回登记后的现值。
 */
export function registerBundledPacks(
  store: KernelModStore,
  packs: readonly KernelBundledPack[] = BundledKernelPacks,
): readonly KernelModPackRecord[] {
  const flag = process.env.VELAROS_KERNEL_AUTO_SYSTEM_PACKS?.trim()
  if (flag === '0' || flag === 'false') return []
  const records = toBundledPackRecords(packs)
  registerSystemModPacks(
    store,
    records.map((record) => ({
      id: record.id,
      version: record.version,
      specifier: record.specifier,
      provides: record.provides,
      module: record.module as KernelModuleDefinition,
    })),
  )
  return records.map((record) => store.get(record.id) ?? record)
}
