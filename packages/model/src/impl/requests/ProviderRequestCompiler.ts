import { isArray } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelDriver, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type {
  CompiledModelRequest,
  ModelEstimateCalibration,
  ProviderRequestSnapshot,
} from '../../types/compiler.js'
import { encodeProviderRequestAuditValue } from '../../utils/provider-audit.js'
import { requestFingerprint } from '../../utils/provider-fingerprint.js'

/** 最终发送门只编译物化结果，不持有会话或上下文治理状态。 */
export interface ProviderRequestCompilerApi {
  /** 编码、封存并计量实际发送请求，超预算时保留原文并拒绝发送；给了校准就按校准后的估算准入。 */
  compileModelTurn(
    request: ModelTurnRequest,
    driver: ModelDriver,
    reserveTokens: number,
    calibration?: ModelEstimateCalibration
  ): Promise<CompiledModelRequest>
  /** 核对保存的消息、模型、响应格式和输出预算未被改写。 */
  verify(snapshot: ProviderRequestSnapshot): Promise<void>
}
class ProviderRequestCompiler implements ProviderRequestCompilerApi {
  public async compileModelTurn(
    input: ModelTurnRequest,
    driver: ModelDriver,
    reserveTokens: number,
    calibration?: ModelEstimateCalibration
  ): Promise<CompiledModelRequest> {
    if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0)
      throw new AppError('VALIDATION', '无效模型预留预算')
    if (calibration && !(calibration.textRatio > 0 && calibration.textRatio <= 1))
      throw new AppError('VALIDATION', '估算校准比必须在 0 到 1 之间')
    const overhead = calibration?.overheadTokens ?? 0
    if (!Number.isSafeInteger(overhead) || overhead < 0)
      throw new AppError('VALIDATION', '估算固定开销必须是非负整数')
    const request = structuredClone({ ...input, compiledPrompt: modelRequestEncoder.encode(input) })
    request.response = modelRequestEncoder.response(request)
    const messages = encodeProviderRequestAuditValue(modelRequestEncoder.messages(request))
    const responseFormat =
      request.response.type === 'json'
        ? encodeProviderRequestAuditValue(request.response)
        : undefined
    const data = {
      model: driver.id,
      system: request.instructions,
      messages,
      outputTokens: request.outputTokens,
      responseFormat,
      tools:
        request.response.type === 'tools'
          ? request.response.tools.map((tool) => encodeProviderRequestAuditValue(tool))
          : [],
    }
    const providerRequest: ProviderRequestSnapshot = {
      schemaVersion: 2,
      ...data,
      requestFingerprint: await requestFingerprint(data),
    }
    await this.verify(providerRequest)
    const raw = await driver.estimate(request)
    const images = raw.images?.tokens ?? 0
    const opaque = raw.opaqueTokens ?? 0
    if (
      !Number.isSafeInteger(raw.tokens) ||
      raw.tokens < 0 ||
      !Number.isSafeInteger(images) ||
      images < 0 ||
      !Number.isSafeInteger(opaque) ||
      opaque < 0 ||
      images + opaque > raw.tokens
    )
      throw new AppError('VALIDATION', '模型驱动返回了无效预算')
    const measured: { text: number; images: number; opaque?: number } = {
      text: raw.tokens - images - opaque,
      images,
    }
    if (opaque) measured.opaque = opaque
    // 精确计数不需要校准；图片和不透明状态容量仍按驱动给的数。
    const estimate =
      calibration && calibration.textRatio < 1 && raw.precision === 'estimate'
        ? {
            ...raw,
            tokens:
              Math.min(measured.text, Math.ceil(measured.text * calibration.textRatio + overhead)) +
              images +
              opaque,
            basis: `${raw.basis}；文本部分按实测用量校准 ×${calibration.textRatio.toFixed(3)}${overhead ? ` + ${overhead} 固定开销` : ''}`,
          }
        : raw
    const okToSend =
      estimate.tokens <= driver.limits.inputTokens &&
      estimate.tokens + request.outputTokens + reserveTokens <= driver.limits.contextTokens
    return { request, estimate, measured, okToSend, providerRequest }
  }
  public async verify(snapshot: ProviderRequestSnapshot): Promise<void> {
    if (
      snapshot.schemaVersion !== 2 ||
      !isArray(snapshot.tools) ||
      snapshot.tools.length > 32 ||
      !Number.isSafeInteger(snapshot.outputTokens) ||
      snapshot.outputTokens < 1 ||
      JSON.stringify(snapshot.requestFingerprint) !==
        JSON.stringify(await requestFingerprint(snapshot))
    )
      throw new AppError('INVARIANT', '模型请求快照与实际内容指纹不一致')
  }
}
/** 创建无会话状态的统一请求编译器。 */
export function createProviderRequestCompiler(): ProviderRequestCompilerApi {
  return new ProviderRequestCompiler()
}
