import type { ExclusiveSqliteLockApi } from '@velaros-ai/core/utils/ExclusiveSqliteLock'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'
import type { NodeCodeRunnerOptions, NodeRuntimePackage } from '@velaros-ai/script'
import type { ShellHostPort } from '@velaros-ai/velaros/execution'

import type { PluginSkillSource, SkillMutation } from '../types/skills.js'

import type { SkillEnvironmentLease, SkillRegistryApi } from './provides.js'

/** 包管理器由宿主选择，安装在独立暂存目录并返回完整锁文件。 */
export interface SkillDependencyInstaller {
  /** 安装完整生产依赖并写入锁文件；生命周期脚本只在明确授权时执行。 */
  install(directory: string, allowScripts: boolean, signal: AbortSignal): Promise<void>
}

/** 平台只管理 Skill 生命周期，进程与跨进程互斥由宿主提供。 */
export interface SkillRegistryOptions {
  /** 应用用户数据下的绝对安装目录。 */
  readonly directory: string
  /** 实际执行 Agent 程序的 Node 版本。 */
  readonly nodeVersion: string
  /** 宿主提供的标准依赖安装器。 */
  readonly installer: SkillDependencyInstaller
  /** 独立 SQLite 连接承担跨进程发布互斥。 */
  readonly lock: ExclusiveSqliteLockApi
  /** 随产品发布、已经校验过的基础 npm 包。 */
  readonly packages?: readonly NodeRuntimePackage[]
  /** 宿主提供的只读内置 Skill 包目录，身份不由安装清单决定。 */
  readonly builtins?: readonly string[]
  /** 插件作为整体安装；内部 Skill 由宿主实时提供，独立 Skill 安装器不能覆盖它们。 */
  readonly plugins?: {
    /** 只返回已安装并启用的插件内部 Skill。 */
    list(): Promise<readonly PluginSkillSource[]>
    /** 插件安装、启停和移除后通知目录失效。 */
    subscribe(listener: () => void): () => void
  }
}

/** npm CLI 运行在应用自带 Node 上，安装权限和进程回收由宿主负责。 */
export interface NpmSkillInstallerOptions {
  /** 产品提供的标准 Node 可执行文件。 */
  readonly executable: string
  /** 随产品分发的 npm-cli.js 绝对路径。 */
  readonly npmCli: string
  /** 应用私有 npm 缓存，位于安装宿主允许写入的根内。 */
  readonly cacheDirectory: string
  /** 安装目录允许写入且可访问包仓库的执行端口。 */
  readonly host: ShellHostPort
}

/** 已选环境中的宿主能力只通过 Kernel 模块公开。 */
export interface SkillCapabilityModuleOptions {
  /** 每次调用重新查询当前授权。 */
  readonly registry: SkillRegistryApi
  /** 当前会话持有的安装代次和依赖集合。 */
  readonly lease: SkillEnvironmentLease
  /** 第三方代码使用同一受控 Node 执行口。 */
  readonly node: NodeCodeRunnerOptions
  /** 宿主已绑定资源的能力；只装配租约授予的模块。 */
  readonly hostModules?: Readonly<Record<string, OperationModuleDefinition>>
}

/** 模型管理模块的调用上下文；每轮固定租约，权限决策由宿主注入。 */
export interface SkillsOperationContext {
  /** 本次调用的取消信号。 */
  readonly abortSignal: AbortSignal
  /** 本机安装库的唯一服务。 */
  readonly registry: SkillRegistryApi
  /** 当前会话已选择的环境租约。 */
  readonly lease: SkillEnvironmentLease
  /** 相对来源路径的解析根。 */
  readonly cwd: string
  /** 沙箱开启时，来源目录和真实符号链接必须在工作区内。 */
  readonly sourceScope: 'workspace' | 'unrestricted'
  /** 写入前交给宿主确认；拒绝时抛错，安装脚本不能自行放宽此策略。 */
  authorize(mutation: SkillMutation, signal: AbortSignal): Promise<void>
  /** 确认和校验失败记为 none；依赖脚本执行期间记为 unknown，成功发布记为 committed。 */
  recordEffect(effect: 'none' | 'committed' | 'unknown'): void
}
