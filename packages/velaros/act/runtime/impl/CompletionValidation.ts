import { randomUUID } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type { CompletionValidationDependencies } from '../contract/requires.js'
import type {
  CompletionValidationInput,
  CompletionValidationReceipt,
} from '../types/completion-validation.js'
import { completionHash, completionMaterialHash } from '../utils/completion-review.js'
import { completionValidationInput } from '../utils/completion-validation.js'
import { CompletionValidationLimits } from '../utils/tuning.js'

/** 单次复核的执行配额与严格版本绑定；原始读取授权仍由宿主拥有。 */
export interface CompletionValidationApi {
  /** 尚可受理的验证次数；宿主没有提供端口时为零。 */
  readonly remaining: number
  /** 等待真实执行和清理完成，前后核对完整产物与授权代次。 */
  execute(
    input: CompletionValidationInput,
    signal: AbortSignal
  ): Promise<CompletionValidationReceipt>
}

/** 不拥有裸进程能力，只把已授权且带哈希的请求交给明确提供的宿主。 */
export class CompletionValidation implements CompletionValidationApi {
  private attempts = 0

  public constructor(private readonly dependencies: CompletionValidationDependencies) {}

  public get remaining(): number {
    return this.dependencies.host
      ? Math.max(0, CompletionValidationLimits.attempts - this.attempts)
      : 0
  }

  public async execute(
    raw: CompletionValidationInput,
    signal: AbortSignal
  ): Promise<CompletionValidationReceipt> {
    signal.throwIfAborted()
    if (!this.dependencies.host) throw new AppError('UNAVAILABLE', '宿主没有隔离验证执行端口')
    if (this.remaining === 0) throw new AppError('LIMIT', '本次复核执行验证次数已耗尽')
    this.attempts++
    const input = completionValidationInput(raw)
    if (input.requirementIds.some((id) => !this.dependencies.requirementIds.includes(id)))
      throw new AppError('PERMISSION', '验证需求不属于本次固定需求清单')
    for (const artifact of input.artifacts) {
      const material = this.dependencies.snapshot.materials.find(
        (entry) => entry.identity === artifact.identity
      )
      if (!material || completionMaterialHash(material) !== artifact.sha256)
        throw new AppError('PERMISSION', '验证文件身份或完整哈希不属于当前授权快照')
    }
    await this.dependencies.assertCurrent(signal)
    // 不把取消竞争变成提前返回：宿主须先收束实际验证进程，close 才能完成。
    const outcome = await this.dependencies.host.execute(
      {
        ...input,
        fingerprint: this.dependencies.snapshot.fingerprint,
        timeoutMs: CompletionValidationLimits.timeoutMs,
        maxOutputBytes: CompletionValidationLimits.outputBytes,
      },
      signal
    )
    let versionCurrent = !signal.aborted
    if (versionCurrent) {
      try {
        await this.dependencies.assertCurrent(signal)
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'STALE') throw error
        versionCurrent = false
      }
    }
    if (
      Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr) >
        CompletionValidationLimits.outputBytes ||
      !Number.isFinite(outcome.durationMs) ||
      outcome.durationMs < 0
    )
      throw new AppError('PROTOCOL', '宿主验证回执超出输出预算或缺少有效耗时')
    const status = !versionCurrent
      ? 'unavailable'
      : outcome.status === 'passed' &&
          (outcome.exitCode !== 0 ||
            outcome.signal ||
            outcome.timedOut ||
            outcome.cancelled ||
            outcome.outputTruncated ||
            !outcome.cleanupComplete)
        ? 'failed'
        : outcome.status
    const receipt: CompletionValidationReceipt = {
      ...outcome,
      status,
      identity: `validation:${randomUUID()}`,
      requirementIds: input.requirementIds,
      requirementsSha256: this.dependencies.requirementsSha256,
      artifacts: input.artifacts,
      codeSha256: completionHash(input.code),
      versionCurrent,
    }
    if (signal.aborted)
      return { ...receipt, cancelled: true, issue: '父任务取消，验证回执仅作审计' }
    if (!versionCurrent) return { ...receipt, issue: '执行后产物或授权版本已变化' }
    return receipt
  }
}
