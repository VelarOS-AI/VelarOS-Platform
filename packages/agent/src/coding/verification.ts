import { isEmpty,isTrue } from '@velaros-ai/core'

import type {
  CapabilityValidationInterpreter,
  CapabilityValidationStatus,
} from '../capabilities'
// 失败形状单源住 reminders/types（coding → reminders 是既有依赖方向，反过来会成环）。
import type { CapabilityValidationFailure } from '../reminders'

interface CapabilityValidationCollectionResult {
  latestVerificationStatus: CapabilityValidationStatus
  activeVerificationFailure: Nullable<CapabilityValidationFailure>
  notes: string[]
}

/**
 * Generic facade over product-supplied validation result interpreters.
 * Agent Runtime never knows command tool names, validation-plan schemas, or
 * platform command syntax.
 */
class CodingSessionVerificationHelper {
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

export type { CapabilityValidationCollectionResult }
export type { CapabilityValidationFailure } from '../reminders'
export { CodingSessionVerificationHelper }
