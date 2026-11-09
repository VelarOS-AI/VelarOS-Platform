import type { ExclusiveSqliteLockApi } from '@velaros-ai/core/utils/ExclusiveSqliteLock'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'
import type { NodeCodeRunnerOptions, NodeRuntimePackage } from '@velaros-ai/script'
import type { ShellHostPort } from '@velaros-ai/velaros/execution'

import type { SkillSelection } from '../types/skills.js'

import type { SkillEnvironmentLease, SkillRegistryApi, SkillSessionApi } from './provides.js'

/** 宿主允许模型按需加载本机已安装的 Skill；显式选择只决定预加载项。 */
export interface SkillSessionOptions {
  /** 本机安装库，加载时重新核对固定代次。 */
  readonly registry: Pick<SkillRegistryApi, 'list' | 'acquire'>
  /** 工作区默认项与显式选择；其余安装项保留按需加载资格。 */
  readonly selection?: readonly SkillSelection[]
}

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
  readonly registry: Pick<SkillRegistryApi, 'assertGranted'>
  /** 当前会话持有的安装代次和依赖集合。 */
  readonly lease: SkillEnvironmentLease
  /** 按需模式的发现目录和加载所有者；不提供时沿用固定授权租约。 */
  readonly session?: SkillSessionApi
  /** 第三方代码使用同一受控 Node 执行口。 */
  readonly node: NodeCodeRunnerOptions
  /** 宿主已绑定资源的能力；只装配租约授予的模块。 */
  readonly hostModules?: Readonly<Record<string, OperationModuleDefinition>>
}
