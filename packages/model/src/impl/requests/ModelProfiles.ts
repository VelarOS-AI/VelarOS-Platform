import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ModelProfileCredentialSource } from '../../types/model'
import { omitCredential, resolveCredential, resolveCredentialSource } from '../../utils/profiles'
import { ModelTuning } from '../../utils/tuning'

/**
 * 模型 profile 的凭据来源判定与连接探测。
 *
 * 凭据只在两处找：产品配置里配好的，或登记过的环境变量；两处都没有就如实说「缺」，
 * 不去别的地方猜。实例是 `modelProfiles`。
 */
export interface ModelProfilesApi {
  /** 判断这个 profile 的凭据是从配置来、从环境变量来、不需要，还是缺。 */
  credentialSource(input: {
    readonly configuredCredential: string
    readonly environmentName: Nullable<string>
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly credentialOptional: boolean
  }): ModelProfileCredentialSource
  /** 取这个 profile 真正要用的凭据：配置里的优先，其次读登记的环境变量。 */
  credential(input: {
    readonly configuredCredential: string
    readonly environmentName: Nullable<string>
    readonly environment: Readonly<Record<string, string | undefined>>
  }): string
  /** 去掉 profile 上的密钥字段，剩下的才是能进日志与界面的部分。 */
  omitCredential(profile: Record<string, unknown> & { apiKey: unknown }): Record<string, unknown>
  /** 把产品的连接探测放进有界 AbortSignal；探针内容和 provider 调用仍由宿主注入。 */
  runConnectionProbe(
    operation: (signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<unknown>
}

export class ModelProfiles implements ModelProfilesApi {
  public credentialSource(input: {
    readonly configuredCredential: string
    readonly environmentName: Nullable<string>
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly credentialOptional: boolean
  }): ModelProfileCredentialSource {
    return resolveCredentialSource(input)
  }

  public credential(input: {
    readonly configuredCredential: string
    readonly environmentName: Nullable<string>
    readonly environment: Readonly<Record<string, string | undefined>>
  }): string {
    return resolveCredential(input)
  }

  public omitCredential(
    profile: Record<string, unknown> & { apiKey: unknown }
  ): Record<string, unknown> {
    return omitCredential(profile)
  }

  public async runConnectionProbe(
    operation: (signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
    timeoutMs: number = ModelTuning.profiles.connectionProbeTimeoutMs
  ): Promise<unknown> {
    const timers = new TimerScope({ name: 'ModelConnectionProbe' })
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()
    const timeout = timers.after(timeoutMs, () =>
      controller.abort(new AppError('TIMEOUT', '连接检查超时。'))
    )
    try {
      return await operation(controller.signal)
    } finally {
      timeout.cancel()
      signal?.removeEventListener('abort', forwardAbort)
      timers.dispose()
    }
  }
}

/** 整个进程共用的 profile 凭据判定与连接探测：无状态。 */
export const modelProfiles: ModelProfilesApi = new ModelProfiles()
