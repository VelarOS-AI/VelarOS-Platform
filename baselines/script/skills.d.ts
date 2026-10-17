/** Skill 开发、管理与按需加载。guide 查询内置开发规范和示例；list 查询安装状态；load 读取本轮可用 Skill。
 * 标准 npm 直接 import。按需会话允许自行加载已安装 Skill，无须用户勾选；load 后从下一次程序执行使用新增 npm 包。卸载和升级立即阻止旧代次后续的能力调用。
 */
declare module 'velaros:skills' {
  /** 查询内置文档，默认 authoring；management 说明生命周期，example 返回可用的示例文件。
   */
  export function guide(input?: SkillGuideInput): Promise<SkillGuide>

  /** 列出已安装 Skill，包含本轮可加载状态。正文按需 load。
   */
  export function list(): Promise<SkillSummary[]>

  /** 按名称加载本轮可用 Skill 的完整说明和资源目录。额外资源用 Node 读取。
   */
  export function load(input: SkillNameInput): Promise<SkillLoaded>

  /** 静态校验源目录、清单、Node 兼容性与能力声明，不执行包代码或下载依赖。安装验证依赖，会话加载验证组合冲突。
   */
  export function validate(input: SkillDirectoryInput): Promise<SkillManifest>

  /** 从本地目录安装或升级，发布前经宿主确认。默认禁用依赖脚本。安装完成后由会话选择加载。
   */
  export function install(input: SkillInstallRequest): Promise<SkillSummary>

  /** 卸载已安装 Skill，发布前经宿主确认。仍被执行或后台任务使用的文件保留到租约释放。
   */
  export function remove(input: SkillNameInput): Promise<void>

  /** 开发规范、管理说明或可写入目录的示例。 */
  interface SkillGuideInput {
    readonly topic?: 'authoring' | 'management' | 'example'
  }

  /** 按需返回的文档；示例的 files 是包内相对路径到 UTF-8 内容。 */
  interface SkillGuide {
    readonly content: string
    readonly files: Readonly<Record<string, string>>
  }

  /** 已安装 Skill 的发现信息。available 表示当前轮次可加载这个版本。 */
  interface SkillSummary {
    /** 所属插件，安装和启停由插件统一管理。 */
    readonly plugin?: string
    /** 随产品提供，版本由产品更新管理。 */
    readonly builtin?: boolean
    readonly name: string
    readonly version: string
    readonly description: string
    readonly available: boolean
    readonly packages: readonly string[]
    readonly capabilities: readonly string[]
    readonly grants: readonly string[]
  }

  /** 选择已安装的 Skill。 */
  interface SkillNameInput {
    readonly name: string
  }

  /** 本轮环境中加载的说明和目录。额外资源用 Node 读取，packages 直接 import。 */
  interface SkillLoaded {
    readonly skill: SkillSummary
    readonly directory: string
    readonly instructions: string | null
  }

  /** 待校验的本地包目录，相对当前工作目录解析。 */
  interface SkillDirectoryInput {
    readonly directory: string
  }

  /** 静态校验后的包信息。 */
  interface SkillManifest {
    readonly name: string
    readonly version: string
    readonly description: string
    readonly dependencies: Readonly<Record<string, string>>
    readonly node?: string
    readonly contribution: SkillContribution
  }

  /** 安装本地目录到本机库，默认关闭依赖脚本。 */
  interface SkillInstallRequest {
    /** 来源目录；模型调用时相对当前工作目录解析。 */
    readonly directory: string
    readonly allowDependencyScripts?: boolean
  }

  /** package.json 的 agentSkill 字段，普通 npm 信息继续使用标准字段。 */
  interface SkillContribution {
    readonly instructions?: string
    readonly packages: readonly string[]
    readonly capabilities: readonly SkillCapability[]
    /** 由宿主绑定的能力或扩展身份；声明本身不授予权限。 */
    readonly hostCapabilities?: readonly string[]
  }

  /** Skill 提供的外部能力；contract 是带效果声明的 TypeScript 声明文件。 */
  interface SkillCapability {
    readonly module: string
    readonly entry: string
    readonly contract: string
  }
}
