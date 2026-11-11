/** Feature 能力目录、按需加载和安装管理。默认引用只指定初始上下文，全部已安装能力均可发现和按需加载。说明、工具实现与 npm 依赖由同一能力版本管理。 */
declare module 'velaros:features' {
  /** 查询原生 Feature 格式、Codex Skill 导入和宿主 SDK 规范。
   */
  export function guide(): Promise<string>

  /** 列出全部能力的用途、安装状态与默认引用，正文按需 load。
   */
  export function list(): Promise<readonly FeatureSummary[]>

  /** 按身份加载已安装能力的完整 Skill 说明和资源目录，不要求预先引用。id 最多 214 个字符。新 npm 包从下一次程序执行生效。
   */
  export function load(input: FeatureIdInput): Promise<FeatureLoaded>

  /** 静态校验 Feature、Codex Skill 或 Markdown；path 最多 4096 个字符。不执行来源代码、不安装依赖。
   */
  export function validate(input: FeaturePathInput): Promise<FeatureDefinition>

  /** 安装或升级本机来源，path 最多 4096 个字符；发布前由宿主确认，依赖脚本默认关闭。
   */
  export function install(input: FeatureInstallInput): Promise<FeatureSummary>

  /** 卸载能力并撤销后续调用，id 最多 214 个字符；在途执行及后台任务持有的文件继续受租约保护。
   */
  export function remove(input: FeatureIdInput): Promise<void>

  /** 当前能力的安装状态；generation 固定实际安装版本，默认引用不改变可用范围。 */
  interface FeatureSummary extends FeatureDefinition {
    readonly selected?: boolean
    readonly availableVersion?: string
    readonly generation: string | null
    readonly installed: boolean
    readonly builtin: boolean
    readonly grants: readonly string[]
  }

  /** 根据稳定身份选择能力。 */
  interface FeatureIdInput {
    readonly id: string
  }

  /** 本轮能力加载结果，资源路径由宿主提供，额外文件按需读取。 */
  interface FeatureLoaded {
    readonly feature: FeatureSummary
    readonly directory: string
    readonly instructions: string | null
  }

  /** 导入本机 Feature、Codex Skill 目录或单个 Markdown 文件。 */
  interface FeaturePathInput {
    readonly path: string
  }

  /** 用户可安装、管理和选择的能力定义；Skill 正文和运行代码分别引用。 */
  interface FeatureDefinition {
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

  /** 安装或升级本机能力；依赖脚本缺省关闭。 */
  interface FeatureInstallInput extends FeaturePathInput {
    readonly allowDependencyScripts?: boolean
  }
}
