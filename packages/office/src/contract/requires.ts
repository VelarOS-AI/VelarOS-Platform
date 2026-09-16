/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 工具上下文 `OfficeToolContext`：必须。宿主每次调工具时给，里面是宿主端口 `OfficeHostApi`。
 * - 上下文解析器 `OfficeToolContextResolver`：挂进内核且要按名调用工具时必须，放在 `CreateOfficeKernelModuleOptions` 里给。
 * - 资源端口 `OfficeResourcePort`：可选。宿主自己的插件登记表经它把额外资源根与停用开关交进来。
 * - 环境变量：可选，全部登记在 `contract/constants.ts` 的 `OfficeEnvironmentVariables`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type {
  ScopeRef,
} from '@velaros-ai/kernel/contracts'

import type {
  MarkItDownLaunchSpec,
  OfficeCommandOptions,
  OfficeEnvironmentInspection,
  OfficeMutationDecision,
  OfficeMutationRequest,
  OfficeNativeCommand,
  OfficeSystemCommandResult,
} from '../types/office.js'

/**
 * 宿主端口：工具在运行时能向宿主要什么，工具里写作 `ctx.office`。全仓唯一权威。
 *
 * 扁平一层，只放工具真会调的方法——门禁按工具文件和它委托的执行类逐方法核对，宿主按权限授予成员时
 * 也能精确到方法。宿主自己界面要的能力（安装建议卡、替代方案、自动批准通知）不进这里，由宿主在自己的
 * 结果中间件里挂：本包只把 `OfficeErrorCodes.converterMissing` 与缺哪个命令、为什么要它交出去。
 */
export interface OfficeHostApi {
  /** 当前可写的工作区根；产物只能落在它里面。没有任何可用根时抛错，工具据此判自己不可用。 */
  getRootPath: () => string
  /** 写盘之前向宿主申请一次写入授权；被拒时工具什么都不写，返回跳过结果。 */
  prepareMutation: (input: OfficeMutationRequest) => Promise<OfficeMutationDecision>
  /** 探测这几个命令在本机是否可用、路径在哪。 */
  inspectEnvironment: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
  /** 执行一条外部命令；只收原生 argv，本包不拼 shell 串。 */
  runCommand: (
    command: OfficeNativeCommand,
    options: OfficeCommandOptions
  ) => Promise<OfficeSystemCommandResult>
  /**
   * 按宿主自己的插件状态回答 MarkItDown 装没装、在哪。
   * 宿主没实现时本包回落到只按平台约定推导资源根的缺省定位器，用户的停用开关就到不了本包。
   */
  locateMarkItDown?: () => Nullable<MarkItDownLaunchSpec>
}

/** 每次工具调用拿到的上下文。 */
export interface OfficeToolContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，工具和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 宿主端口：工具经它向宿主要工作区与系统能力。 */
  office: OfficeHostApi
}

/** 内核按工具名调用时，宿主用它把作用域换成一份 office 工具上下文。 */
export type OfficeToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => OfficeToolContext | Promise<OfficeToolContext>

/** 创建 office 内核模块的选项。 */
export interface CreateOfficeKernelModuleOptions {
  /** 宿主自己的、绑定了作用域的 office 上下文解析器；不给就只登记工具目录，不支持按名调用。 */
  resolveContext?: OfficeToolContextResolver
}

/** 可选资源端口：宿主的插件登记表经它告诉本包额外去哪找资源、哪个资源被用户停用了。 */
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
