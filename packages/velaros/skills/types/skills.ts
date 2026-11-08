/** Skill 提供的外部能力；contract 是带效果声明的 TypeScript 声明文件。 */
export interface SkillCapability {
  readonly module: string
  readonly entry: string
  readonly contract: string
}

/** package.json 的 agentSkill 字段，普通 npm 信息继续使用标准字段。 */
export interface SkillContribution {
  readonly instructions?: string
  readonly packages: readonly string[]
  readonly capabilities: readonly SkillCapability[]
  /** 由宿主绑定的能力或扩展身份；声明本身不授予权限。 */
  readonly hostCapabilities?: readonly string[]
  /** 扩展代码可以通过 velaros:host 调用的宿主模块；不直接公开为模型工具。 */
  readonly sdkCapabilities?: readonly string[]
}

/** 静态校验后的包信息。 */
export interface SkillManifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly node?: string
  readonly contribution: SkillContribution
}

/** 安装收据；generation 标识不可变的实际文件集合。 */
export interface SkillRecord {
  readonly manifest: SkillManifest
  readonly generation: string
  readonly directory: string
  readonly installedAt: string
  /** 随产品提供，只通过产品更新替换。 */
  readonly builtin?: boolean
}

/** 安装本地目录到本机库，默认关闭依赖脚本。 */
export interface SkillInstallRequest {
  /** 待安装的本地来源目录。 */
  readonly directory: string
  readonly allowDependencyScripts?: boolean
}

/** 同一目录下的持久安装索引。 */
export interface SkillIndex {
  readonly version: 2
  readonly revision: number
  readonly skills: readonly SkillRecord[]
}

/** 记录每个文件的内容摘要；恢复时不执行包源码。 */
export interface SkillReceipt {
  readonly manifest: SkillManifest
  readonly files: Readonly<Record<string, string>>
}

/** 一次会话选择的确切安装代次与能力；安装清单不承担加载状态。 */
export interface SkillSelection {
  readonly name: string
  readonly generation: string
  readonly grants: readonly string[]
}

/** 环境租约中的已选择包，授权只属于该次租约。 */
export interface SkillActivation extends SkillRecord {
  readonly grants: readonly string[]
}
