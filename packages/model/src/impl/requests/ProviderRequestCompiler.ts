import { isEmpty } from '@velaros-ai/core'
import type { ModelDriver, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { CompiledModelRequest, ProviderRequestSnapshot } from '../../types/compiler.js'
import { encodeProviderRequestAuditValue } from '../../utils/provider-audit.js'
import { requestFingerprint } from '../../utils/provider-fingerprint.js'

/** 最终发送门只编译物化结果，不持有会话或上下文治理状态。 */
export interface ProviderRequestCompilerApi {
  /** 编码、封存并计量实际发送请求，超预算时保留原文并拒绝发送。 */
  compileModelTurn(
    request: ModelTurnRequest,
    driver: ModelDriver,
    reserveTokens: number
  ): Promise<CompiledModelRequest>
  /** 核对保存的消息、模型、响应格式和输出预算未被改写。 */
  verify(snapshot: ProviderRequestSnapshot): Promise<void>
}
class ProviderRequestCompiler implements ProviderRequestCompilerApi {
  public async compileModelTurn(
    input: ModelTurnRequest,
    driver: ModelDriver,
    reserveTokens: number
  ): Promise<CompiledModelRequest> {
    if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0)
      throw new Error('无效模型预留预算')
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
    }
    const providerRequest: ProviderRequestSnapshot = {
      schemaVersion: 2,
      ...data,
      tools: [],
      requestFingerprint: await requestFingerprint(data),
    }
    await this.verify(providerRequest)
    const estimate = await driver.estimate(request)
    if (!Number.isSafeInteger(estimate.tokens) || estimate.tokens < 0)
      throw new Error('模型驱动返回了无效预算')
    const okToSend =
      estimate.tokens <= driver.limits.inputTokens &&
      estimate.tokens + request.outputTokens + reserveTokens <= driver.limits.contextTokens
    return { request, estimate, okToSend, providerRequest }
  }
  public async verify(snapshot: ProviderRequestSnapshot): Promise<void> {
    if (
      snapshot.schemaVersion !== 2 ||
      !isEmpty(snapshot.tools) ||
      !Number.isSafeInteger(snapshot.outputTokens) ||
      snapshot.outputTokens < 1 ||
      JSON.stringify(snapshot.requestFingerprint) !==
        JSON.stringify(await requestFingerprint(snapshot))
    )
      throw new Error('模型请求快照与实际内容指纹不一致')
  }
}
/** 创建无会话状态的统一请求编译器。 */
export function createProviderRequestCompiler(): ProviderRequestCompilerApi {
  return new ProviderRequestCompiler()
}
