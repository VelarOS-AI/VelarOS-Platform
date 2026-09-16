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

import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'

import type {
  OfficeEnvironmentInspection,
  OfficeNativeCommand,
  OfficeProjectAuthorizationDecision,
  OfficeProjectMutationAuthorizationInput,
  OfficeSystemCommandResult,
  OfficeSystemToolInstallSuggestion,
} from '../types/office.js'

/** 工作区端口：office 只声明自己消费的那几件事，宿主可以用它的项目能力实现，但本包不依赖那个包。 */
export interface OfficeProjectApi {
  /** 当前可写的工作区根；产物只能落在它里面。没有任何可用根时抛错，工具据此判自己不可用。 */
  getRootPath: () => string
  /** 在指定目录下执行一段操作再恢复；宿主实现会把这个目录当成新的执行根。 */
  runInDirectory: <T>(cwd: string, action: () => Promise<T>) => Promise<T>
  /** 写盘之前向宿主申请一次工作区修改授权；被拒时工具什么都不写，返回跳过结果。 */
  prepareMutation: (
    input: OfficeProjectMutationAuthorizationInput
  ) => Promise<OfficeProjectAuthorizationDecision>
}

/** 系统端口：探测本机有没有外部转换器，以及执行它们。 */
export interface OfficeSystemApi {
  /** 探测这几个命令在本机是否可用、路径在哪；不给命令名就只回答环境本身。 */
  inspectEnvironment: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
  /** 由宿主按平台与 scope 生成一张「缺这个命令，可以这样装」的建议卡；宿主不支持时返回 null。 */
  createSystemToolInstallSuggestion: (input: {
    command: string
    reason: string
    scope: 'project' | 'system'
  }) => Nullable<OfficeSystemToolInstallSuggestion>
  /** 执行一条外部命令：本包一律只给原生 argv（nativeCommand），第一个参数是同一条命令的可读描述。 */
  runCommand: (
    command: string,
    options?: {
      cwd?: string
      timeoutMs?: number
      maxOutputChars?: number
      nativeCommand?: OfficeNativeCommand
    },
    allowDangerous?: boolean
  ) => Promise<OfficeSystemCommandResult>
}

/** Office 工具唯一消费的宿主能力；工作区与系统两件事只以窄端口组合进来。 */
export interface OfficeHostApi {
  /** 当前有没有可用的工作区根；只用来决定安装建议卡挂在工作区还是系统层面。 */
  hasProjectRoot: () => boolean
  /** 工作区端口：根路径、临时切目录、写入授权。 */
  project: OfficeProjectApi
  /** 系统端口：环境探测、安装建议、执行外部命令。 */
  system: OfficeSystemApi
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
