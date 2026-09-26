/**
 * 注入面：空间与宿主必须或可以塞进来的东西，每个注入点一个接口。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 调用上下文 `OfficeOperationContext`：必须。空间每次分发 `velaros:office` 的调用时给，里面是空间端口 `OfficeSpacePort`。
 * - 资源端口 `OfficeResourcePort`：可选。宿主自己的插件登记表经它把额外资源根与停用开关交进来。
 * - 环境变量：可选，全部登记在 `contract/constants.ts` 的 `OfficeEnvironmentVariables`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type {
  MarkItDownLaunchSpec,
  OfficeCommandOptions,
  OfficeEnvironmentInspection,
  OfficeNativeCommand,
  OfficeSystemCommandResult,
} from '../types/office.js'

/**
 * 空间端口：`velaros:office` 的操作在运行时能向空间要什么，写作 `ctx.office`。全仓唯一权威。
 *
 * 扁平一层，只放操作真会调的方法——门禁按操作文件和它委托的执行类逐方法核对。写盘不问人（ADR 0009）：
 * 产物落在哪个根由 `getRootPath` 定，出了根一律拒绝，这就是全部边界。缺转换器时装什么、怎么装由宿主界面回答，
 * 本单元只抛 `OfficeErrorCodes.converterMissing`，message 里写缺哪个命令、为什么要它。
 */
export interface OfficeSpacePort {
  /** 当前可写的工作区根；产物只能落在它里面。没有任何可用根时抛错。 */
  getRootPath: () => string
  /**
   * 把模型写的路径换成绝对路径（比如 `~` 展开到家目录、相对路径按系统工作区算）；不给就相对 `getRootPath` 解析。
   * 换出来的路径照旧要落在工作区根里。
   */
  resolvePath?: (path: string) => string
  /** 探测这几个命令在本机是否可用、路径在哪。 */
  inspectEnvironment: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
  /** 执行一条外部命令；只收原生 argv，本单元不拼 shell 串。 */
  runCommand: (
    command: OfficeNativeCommand,
    options: OfficeCommandOptions
  ) => Promise<OfficeSystemCommandResult>
  /**
   * 按宿主自己的插件状态回答 MarkItDown 装没装、在哪；返回 null 即不可用，操作直接拒绝。
   * 宿主没实现时本单元回落到只按平台约定推导资源根的缺省定位器，用户的停用开关就到不了本单元。
   */
  locateMarkItDown?: () => Nullable<MarkItDownLaunchSpec>
}

/** 每次调用拿到的上下文：取消信号与空间端口，可选的效果登记。 */
export interface OfficeOperationContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，操作和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 空间端口：操作经它向空间要工作区根与系统能力，写作 `ctx.office`。 */
  office: OfficeSpacePort
  /**
   * 可选：登记这次调用对外界的实际效果。preview 与 toMarkdown 声明为写，但只有给了 outputPath 才写文件；
   * 没给时本单元在这里登记 'none'。宿主不给这一项，运行时就按声明记成写入。
   */
  recordEffect?: (effect: 'none') => void
}

/** 可选资源端口：宿主的插件登记表经它告诉本单元额外去哪找资源、哪个资源被用户停用了。 */
export interface OfficeResourcePort {
  /** 除平台约定的共享资源根之外，还要搜哪些目录。 */
  extraResourceRoots: () => string[]
  /** 这个可选资源是不是被用户在设置里停用了。 */
  isDisabled: (id: 'markitdown') => boolean
}

/** 造一个 MarkItDown 定位器时可以覆盖的东西；都不给就按平台约定自己推导。 */
export interface MarkItDownLocatorOptions {
  /** 直接指定要搜的资源根；给了就只认它，不再推导默认根。 */
  resourceRoots?: string[]
  /** 宿主的资源端口：额外资源根与停用开关。 */
  resources?: OfficeResourcePort
}
