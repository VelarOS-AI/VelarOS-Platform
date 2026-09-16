import type { KernelModPackRecord } from '../../impl/serve/KernelModStore'
import { type KernelModStore, registerSystemModPacks } from '../../impl/serve/KernelModStore'
import type { KernelModuleDefinition } from '../../types/abi-module'

/**
 * 编译期 bundled pack:模块实例随构建图进来,装载零 IO。
 *
 * 宪章 §15.2 层间铁律「`bundled` = 编译期依赖(不是运行时下载物)」+「`importSibling` 退役」:
 * bundled pack 不再是「一个 .mjs 入口文件 + 运行时按磁盘布局算路径 import」,而是一个
 * **数组常量**——谁编进来谁负责,构建图解析不了就是构建期红,运行时没有这一类失败面。
 *
 * 依赖方向(§15.2 ⑤→④→③→②)决定了**谁能编进来**:
 *  - 本包是第 ② 层的 serve 配件,不认识任何具体能力包(workspace / computer-runtime /
 *    Project / System …),所以内核自己一个 bundled pack 都不带;
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

/** 把一批编译期模块折成 ModStore 记录。 */
export function toBundledPackRecords(
  packs: readonly KernelBundledPack[],
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
 * 把宿主交来的 bundled pack 登记进 store。
 *
 * 刻意不传 `enabled`:随包默认是「开」,但用户经 `mods.setEnabled` 停用过的 pack(持久化在
 * mod index 里、本调用之前已载入 store)必须跨重启保持关闭。返回登记后的现值。
 */
export function registerBundledPacks(
  store: KernelModStore,
  packs: readonly KernelBundledPack[],
): readonly KernelModPackRecord[] {
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
