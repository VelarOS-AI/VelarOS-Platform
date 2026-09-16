// 工具传输名：canonical 名与供应方可接受的名字之间的双向改写。
import type { ToolTransportNamePlan, ToolTransportProjection } from '../../types/tools'
import { createToolTransportNamePlan, createToolTransportProjection, rewriteCanonicalToolReferences, rewriteProviderToolReferences } from '../../utils/tools/tool-identity'

/**
 * 工具传输名的改写面。
 *
 * 供应方对工具名的字符集比 canonical 名严格（`AgentToolTransport.providerToolNamePattern`），
 * 发请求前按计划改写、回传时还原；同一批工具的计划必须整体生成，逐个改会撞名。
 * 无状态，进程内共用一份。
 */
export interface ToolTransportNamesApi {
  /** 给一批 canonical 工具名整体生成传输名计划（撞名在这里就解开）。 */
  createPlan(canonicalIds: readonly string[]): ToolTransportNamePlan
  /** 按计划生成双向投影：发请求时改写、回传时还原。 */
  createProjection(registeredCanonicalIds: readonly string[], visibleCanonicalIds: readonly string[]): ToolTransportProjection
  /** 把一段文本里的 canonical 工具名按投影改写成传输名。 */
  rewriteCanonicalReferences(text: string, aliases: Readonly<Record<string, string>>): string
  /** 把一段文本里的传输名还原成 canonical 工具名。 */
  rewriteProviderReferences(text: string, providerToCanonical: Readonly<Record<string, string>>): string
}

/** 方法逐个转调 utils/tools/tool-identity 里的纯函数；这里只负责把它们收成一件对外能力。 */
class ToolTransportNames implements ToolTransportNamesApi {
  public createPlan(canonicalIds: readonly string[]): ToolTransportNamePlan {
    return createToolTransportNamePlan(canonicalIds)
  }

  public createProjection(registeredCanonicalIds: readonly string[], visibleCanonicalIds: readonly string[]): ToolTransportProjection {
    return createToolTransportProjection(registeredCanonicalIds, visibleCanonicalIds)
  }

  public rewriteCanonicalReferences(text: string, aliases: Readonly<Record<string, string>>): string {
    return rewriteCanonicalToolReferences(text, aliases)
  }

  public rewriteProviderReferences(text: string, providerToCanonical: Readonly<Record<string, string>>): string {
    return rewriteProviderToolReferences(text, providerToCanonical)
  }
}

/** 工具传输名改写面（无状态，进程内共用一份）。 */
export const toolTransportNames: ToolTransportNamesApi = new ToolTransportNames()
