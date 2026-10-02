import type { ModuleBinding } from '@velaros-ai/kernel'

/**
 * @AgentView
 * 发布一份参数化程序：name 为稳定名称（1 到 96 个字符），purpose 说明用途（1 到 2000 个字符），inputDescription 说明 input/blob 参数（最多 4000 个字符）。
 * source 是 JavaScript ES 模块；modules 保存相对 import 的附属源码。使用 velaros:program 的 input、blobs 接收每次参数，输出与失败诊断由程序自己交付。
 * 新名称 baseRevision 省略等于 0；更新已有名称传目录里的 revision。发布只检查和归档，不执行，不证明效果。
 */
export interface ProgramPublishInput {
  readonly name: string
  readonly purpose: string
  readonly source: string
  readonly modules?: Readonly<Record<string, string>>
  readonly inputDescription?: string
  readonly baseRevision?: number
}

/**
 * @AgentView
 * 一份已检查并保存的不可变程序：sourceRef 可直接交给 execute，input 和 blobs 可逐次替换，每次仍走当前权限和实际能力调用。
 * revision 是名称版本，contentRevision 标识 source 与附属 modules 的原文，dependencies 是发布时真实 import 依赖的挂载身份；它们不授予权限、不表示执行或业务验证。
 */
export interface ProgramDescriptor {
  readonly name: string
  readonly revision: number
  readonly purpose: string
  readonly sourceRef: string
  readonly contentRevision: string
  readonly inputDescription?: string
  readonly dependencies: readonly ModuleBinding[]
}

/** @AgentView 按名称与用途查当前可用程序；offset 翻页，limit 默认 20、最多 64。 */
export interface ProgramQuery {
  readonly query?: string
  readonly offset?: number
  readonly limit?: number
}

/** @AgentView 可复用程序目录的一页；nextOffset 不是 null 就继续翻页。 */
export interface ProgramPage {
  readonly items: readonly ProgramDescriptor[]
  readonly nextOffset: Nullable<number>
}

/** @AgentView 按稳定名称读取当前版本，或按不可变 sourceRef 读取仍在当前授权范围内的已发布版本。 */
export type ProgramDescribeInput = { readonly name: string } | { readonly sourceRef: string }
