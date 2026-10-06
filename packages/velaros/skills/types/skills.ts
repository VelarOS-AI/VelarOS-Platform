/** @AgentView Skill 提供的外部能力；contract 是带效果声明的 TypeScript 声明文件。 */
export interface SkillCapability {
  readonly module: string
  readonly entry: string
  readonly contract: string
}

/** @AgentView package.json 的 agentSkill 字段，普通 npm 信息继续使用标准字段。 */
export interface SkillContribution {
  readonly instructions?: string
  readonly packages: readonly string[]
  readonly capabilities: readonly SkillCapability[]
}

/** @AgentView 静态校验后的包信息。 */
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
}

/** @AgentView 安装本地目录到本机库，默认关闭依赖脚本。 */
export interface SkillInstallRequest {
  /** 来源目录；模型调用时相对当前工作目录解析。 */
  readonly directory: string
  readonly allowDependencyScripts?: boolean
}

/** @AgentView 开发规范、管理说明或可写入目录的示例。 */
export interface SkillGuideInput {
  readonly topic?: 'authoring' | 'management' | 'example'
}

/** @AgentView 按需返回的文档；示例的 files 是包内相对路径到 UTF-8 内容。 */
export interface SkillGuide {
  readonly content: string
  readonly files: Readonly<Record<string, string>>
}

/** @AgentView 已安装 Skill 的发现信息。available 表示当前轮次可加载这个版本。 */
export interface SkillSummary {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly available: boolean
  readonly packages: readonly string[]
  readonly capabilities: readonly string[]
  readonly grants: readonly string[]
}

/** @AgentView 选择已安装的 Skill。 */
export interface SkillNameInput {
  readonly name: string
}

/** @AgentView 待校验的本地包目录，相对当前工作目录解析。 */
export interface SkillDirectoryInput {
  readonly directory: string
}

/** @AgentView 本轮环境中加载的说明和目录。额外资源用 Node 读取，packages 直接 import。 */
export interface SkillLoaded {
  readonly skill: SkillSummary
  readonly directory: string
  readonly instructions: Nullable<string>
}

/** 宿主在发布写入前确认的完整请求；不接受模型提供权限策略。 */
export type SkillMutation =
  | { readonly operation: 'install'; readonly request: SkillInstallRequest }
  | { readonly operation: 'remove'; readonly request: SkillNameInput }

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
