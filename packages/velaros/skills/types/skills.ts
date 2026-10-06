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
}

/** 安装后固定的包信息。 */
export interface SkillManifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly node?: string
  readonly contribution: SkillContribution
}

/** 安装收据与用户选择；generation 标识不可变的实际文件集合。 */
export interface SkillRecord {
  readonly manifest: SkillManifest
  readonly generation: string
  readonly directory: string
  readonly enabled: boolean
  readonly grants: readonly string[]
  readonly installedAt: string
}

/** 安装请求来自宿主；依赖脚本的授权与宿主能力授权分别声明。 */
export interface SkillInstallRequest {
  readonly directory: string
  readonly enabled?: boolean
  readonly grants?: readonly string[]
  readonly allowDependencyScripts?: boolean
}

/** 同一目录下的持久安装索引。 */
export interface SkillIndex {
  readonly version: 1
  readonly revision: number
  readonly skills: readonly SkillRecord[]
}

/** 记录每个文件的内容摘要；恢复时不执行包源码。 */
export interface SkillReceipt {
  readonly manifest: SkillManifest
  readonly files: Readonly<Record<string, string>>
}
