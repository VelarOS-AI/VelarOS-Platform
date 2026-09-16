import type { ReferencedArtifactPath,ReferencedLogPath } from '../../types/retrieval.js'
import {
  collectReferencedArtifactPaths,
  collectReferencedLogPaths,
  inferArtifactType,
  isInternalArtifactPath,
  isInternalCommandLogPath,
  isTextArtifactPath,
} from '../../utils/retrieval/references'

/**
 * 从工具结果的 `serializedResult` / `displayResult` 中**扫描**内部日志与 `artifact` 路径引用。
 *
 * ## 在链路中的位置
 * ```
 * IndexBuilder.build → collectReferenced* → 写入 index.toolPayloads[].log/artifactReferences
 * PayloadReader.retrieveToolPayload → collectReferenced* → ReferenceReader 读盘展开
 * searchTerminalOutput → 用 index 内已缓存的 logReferences → ReferenceReader 读盘打分
 * ```
 *
 * ## 路径安全
 * 只认「内部」路径，避免 `agent` 通过工具结果 `JSON` 诱导读取任意文件：
 * - 日志：绝对路径 + 文件名前缀 `vela-command-` / `vela-bg-` 等 + `.log`
 * - `Artifact`：绝对路径 + 路径段 `/.velaros/artifacts/`
 *
 * 判据与扫描本身是纯函数（`utils/retrieval/references.ts`），这里只把它们收成一个件并钉住两个上限；
 * 导出单例 {@link contextRetrievalReferences}，全链路共用同一份上限口径。
 */
export interface ContextRetrievalReferencesApi {
  /** 单次 collect / readReferencedLogs 最多跟进的日志条数。 */
  readonly maxReferencedLogs: number
  /** 单次 collect / readReferencedArtifactManifests 最多跟进的 artifact 条数。 */
  readonly maxReferencedArtifacts: number
  /**
   * 从工具结果两路字段合并扫描 logPath，按 path 去重，最多 `maxReferencedLogs` 条。
   * 扫不到时返回空数组，不抛错。
   */
  collectReferencedLogPaths(serializedResult: string, displayResult: any): ReferencedLogPath[]
  /**
   * 从工具结果两路字段合并扫描 artifact 路径，按 path 去重，最多 `maxReferencedArtifacts` 条。
   * 扫不到时返回空数组，不抛错。
   */
  collectReferencedArtifactPaths(serializedResult: string, displayResult: any): ReferencedArtifactPath[]
  /** 判断是否为允许跟进的内部命令日志路径（绝对路径 + 内部文件名前缀 + `.log`）；读盘前必须先问它。 */
  isInternalCommandLogPath(path: string): boolean
  /** 判断是否为内部 artifact 存储路径（绝对路径且含 `/.velaros/artifacts/`）；读盘前必须先问它。 */
  isInternalArtifactPath(path: string): boolean
  /** 是否应对该 artifact 尝试读取文本 preview（扩展名在白名单内）；不在白名单的只报 size/type。 */
  isTextArtifactPath(path: string): boolean
  /** 推断 artifact 类型字符串：内部路径取 `/.velaros/artifacts/` 后第一段目录名，否则退回扩展名或 `unknown`。 */
  inferArtifactType(path: string): string
}

class ContextRetrievalReferences implements ContextRetrievalReferencesApi {
  public readonly maxReferencedLogs = 4
  public readonly maxReferencedArtifacts = 4

  public collectReferencedLogPaths(
    serializedResult: string,
    displayResult: any
  ): ReferencedLogPath[] {
    return collectReferencedLogPaths(serializedResult, displayResult, this.maxReferencedLogs)
  }

  public collectReferencedArtifactPaths(
    serializedResult: string,
    displayResult: any
  ): ReferencedArtifactPath[] {
    return collectReferencedArtifactPaths(serializedResult, displayResult, this.maxReferencedArtifacts)
  }

  public isInternalCommandLogPath(path: string): boolean {
    return isInternalCommandLogPath(path)
  }

  public isInternalArtifactPath(path: string): boolean {
    return isInternalArtifactPath(path)
  }

  public isTextArtifactPath(path: string): boolean {
    return isTextArtifactPath(path)
  }

  public inferArtifactType(path: string): string {
    return inferArtifactType(path)
  }
}

/** 全进程唯一的路径扫描实例。 */
export const contextRetrievalReferences: ContextRetrievalReferencesApi = new ContextRetrievalReferences()

export { ContextRetrievalReferences }
