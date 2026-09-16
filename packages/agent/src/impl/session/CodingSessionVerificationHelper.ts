import { isEmpty,isTrue } from '@velaros-ai/core'

import type { CapabilityValidationInterpreter } from '../../contract/requires.js'
// 失败形状单源住 reminders/types（coding → reminders 是既有依赖方向，反过来会成环）。
import type { CapabilityValidationCollectionResult } from '../../types/session.js'

/**
 * 验证结果解读的统一门面：把「这次工具调用算不算一次验证、通过没通过」的判断全部下放给宿主注入的
 * 解释器（`CapabilityValidationInterpreter`），Agent 运行时自己不认识任何命令名、验证计划格式或平台命令语法。
 *
 * 编辑跟踪器持一份、跟着会话活；解释器清单在构造时定死，运行期不增删。没有任何解释器认领时一律按
 * 「这不是验证」处理（返回 null / false），绝不猜。
 */
export interface CodingSessionVerificationHelperApi {
  /**
   * 把一次工具结果解读成验证结论（状态 + 失败详情 + 备注）；没有解释器认领这个工具名时返回 null。
   *
   * 多个解释器都认领时取**第一个给出非空结论**的那个。跟踪器拿到结论后写进会话状态，驱动「改完要验证」的提醒。
   */
  collectVerificationToolResult(
    toolName: string,
    result: unknown
  ): Nullable<CapabilityValidationCollectionResult>
  /**
   * 为一次验证调用算一个指纹，用来拦「同一批改动后重复跑同一个验证」。
   *
   * 解释器不提供 `fingerprint` 时返回 null，表示这次调用不参与验证去重。
   */
  buildVerificationToolFingerprint(
    toolName: string,
    args: Record<string, unknown>
  ): Nullable<string>
  /** 这次验证是不是「跑通了」：任一认领该工具名的解释器说 `isPassed` 为真即算通过，用于把指纹记进已通过集合。 */
  isPassedVerificationResult(toolName: string, result: unknown): boolean
  /**
   * 模型声称跑过的命令（cited）与实际跑过的命令（observed）算不算同一件事。
   *
   * 优先交给实现了 `evidenceMatches` 的解释器按平台语义比（`bun test x` 与 `bun test x --bail` 可能算同一回事）；
   * 一个都没有时退回去空白后的字符串相等。
   */
  evidenceMatches(cited: string, observed: string): boolean
}

class CodingSessionVerificationHelper implements CodingSessionVerificationHelperApi {
  constructor(
    private readonly interpreters: readonly CapabilityValidationInterpreter[] = []
  ) {}

  public collectVerificationToolResult(
    toolName: string,
    result: unknown
  ): Nullable<CapabilityValidationCollectionResult> {
    const interpretation = this.interpreters
      .filter((interpreter) => interpreter.matches(toolName))
      .map((interpreter) => interpreter.collect(toolName, result))
      .find((entry) => !!entry)
    if (!interpretation) return null
    return {
      latestVerificationStatus: interpretation.status,
      activeVerificationFailure: interpretation.failure
        ? {
            command: interpretation.failure.operation,
            status: interpretation.failure.status,
            issues: [...interpretation.failure.issues],
          }
        : null,
      notes: [...(interpretation.notes ?? [])],
    }
  }

  public buildVerificationToolFingerprint(
    toolName: string,
    args: Record<string, unknown>
  ): Nullable<string> {
    for (const interpreter of this.interpreters) {
      if (!interpreter.matches(toolName)) continue
      const fingerprint = interpreter.fingerprint?.(toolName, args)
      if (fingerprint) return fingerprint
    }
    return null
  }

  public isPassedVerificationResult(toolName: string, result: unknown): boolean {
    return this.interpreters.some(
      (interpreter) =>
        interpreter.matches(toolName) && isTrue(interpreter.isPassed?.(toolName, result))
    )
  }

  public evidenceMatches(cited: string, observed: string): boolean {
    const matchers = this.interpreters.filter((interpreter) => interpreter.evidenceMatches)
    if (isEmpty(matchers)) return cited.trim() === observed.trim()
    return matchers.some((interpreter) => interpreter.evidenceMatches?.(cited, observed))
  }
}

export { CodingSessionVerificationHelper }
