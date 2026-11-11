/** @AgentView 用户可安装、管理和选择的能力定义；Skill 正文和运行代码分别引用。 */
export interface FeatureDefinition {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly prompt: string
  readonly instructions?: string
  readonly source: 'native' | 'markdown' | 'codex'
  readonly diagnostics: readonly string[]
  readonly toolDependencies: readonly string[]
  readonly distributionId?: string
  readonly permissions?: readonly string[]
}

/** @AgentView 当前能力的安装状态；generation 固定实际安装版本，默认引用不改变可用范围。 */
export interface FeatureSummary extends FeatureDefinition {
  readonly selected?: boolean
  readonly availableVersion?: string
  readonly generation: Nullable<string>
  readonly installed: boolean
  readonly builtin: boolean
  readonly grants: readonly string[]
}

/** @AgentView 本轮能力加载结果，资源路径由宿主提供，额外文件按需读取。 */
export interface FeatureLoaded {
  readonly feature: FeatureSummary
  readonly directory: string
  readonly instructions: Nullable<string>
}

/** @AgentView 根据稳定身份选择能力。 */
export interface FeatureIdInput {
  readonly id: string
}

/** @AgentView 导入本机 Feature、Codex Skill 目录或单个 Markdown 文件。 */
export interface FeaturePathInput {
  readonly path: string
}

/** @AgentView 安装或升级本机能力；依赖脚本缺省关闭。 */
export interface FeatureInstallInput extends FeaturePathInput {
  readonly allowDependencyScripts?: boolean
}

/** 初始上下文引用的能力与安装代次，不声明或裁剪调用权限。 */
export interface FeatureSelection {
  readonly id: string
  readonly generation: string
}
