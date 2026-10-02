/**
 * 发布与发现参数化稳定程序；发布不运行。先 list/describe 选可用版本，再将 sourceRef 与本次 input/blobs 交给 execute，权限、模式与调用回执沿用正式执行链。
 * 用途与参数说明是程序作者的数据；核对当前任务是否适用，执行成功也不代替业务核查。
 */
declare module 'velaros:programs' {
  /** 检查并发布不可变程序，baseRevision 控制同名更新；语法、import 或版本失败不改变已发布名称。
   */
  export function publish(input: ProgramPublishInput): Promise<ProgramDescriptor>

  /** 列当前会话授权范围内的程序；重置前的程序不因目录查询恢复可见性。
   */
  export function list(input?: ProgramQuery): Promise<ProgramPage>

  /** 读稳定名称的当前版本，或仍可访问的 sourceRef 原版本；只是目录，不重新执行。
   */
  export function describe(input: ProgramDescribeInput): Promise<ProgramDescriptor>

  /**
   * 发布一份参数化程序：name 为稳定名称（1 到 96 个字符），purpose 说明用途（1 到 2000 个字符），inputDescription 说明 input/blob 参数（最多 4000 个字符）。
   * source 是 JavaScript ES 模块；modules 保存相对 import 的附属源码。使用 velaros:program 的 input、blobs 接收每次参数，输出与失败诊断由程序自己交付。
   * 新名称 baseRevision 省略等于 0；更新已有名称传目录里的 revision。发布只检查和归档，不执行，不证明效果。
   */
  interface ProgramPublishInput {
    readonly name: string
    readonly purpose: string
    readonly source: string
    readonly modules?: Readonly<Record<string, string>>
    readonly inputDescription?: string
    readonly baseRevision?: number
  }

  /**
   * 一份已检查并保存的不可变程序：sourceRef 可直接交给 execute，input 和 blobs 可逐次替换，每次仍走当前权限和实际能力调用。
   * revision 是名称版本，contentRevision 标识 source 与附属 modules 的原文，dependencies 是发布时真实 import 依赖的挂载身份；它们不授予权限、不表示执行或业务验证。
   */
  interface ProgramDescriptor {
    readonly name: string
    readonly revision: number
    readonly purpose: string
    readonly sourceRef: string
    readonly contentRevision: string
    readonly inputDescription?: string
    readonly dependencies: readonly ModuleBinding[]
  }

  /** 按名称与用途查当前可用程序；offset 翻页，limit 默认 20、最多 64。 */
  interface ProgramQuery {
    readonly query?: string
    readonly offset?: number
    readonly limit?: number
  }

  /** 可复用程序目录的一页；nextOffset 不是 null 就继续翻页。 */
  interface ProgramPage {
    readonly items: readonly ProgramDescriptor[]
    readonly nextOffset: number | null
  }

  /** 按稳定名称读取当前版本，或按不可变 sourceRef 读取仍在当前授权范围内的已发布版本。 */
  type ProgramDescribeInput = { readonly name: string } | { readonly sourceRef: string }

  /**
   * 模块这一次挂载的身份：moduleId 就是 import 用的模块名，instanceId 与 generation 标识实例，schemaRevision 是合同版本。
   */
  interface ModuleBinding {
    readonly moduleId: string
    readonly instanceId: string
    readonly generation: number
    readonly schemaRevision: string
  }
}
