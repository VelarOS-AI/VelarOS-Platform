import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ModelProfileCredentialSource } from '../../types/model'
import {
  omitCredential,
  resolveCredential,
  resolveCredentialSource,
} from '../../utils/profiles'
import { ModelTuning } from '../../utils/tuning'

/** 判断这个 profile 的凭据是从配置来、从环境变量来、不需要，还是缺。 */
export function resolveModelProfileCredentialSource(input: {
  readonly configuredCredential: string
  readonly environmentName: Nullable<string>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly credentialOptional: boolean
}): ModelProfileCredentialSource {
  return resolveCredentialSource(input)
}

/** 取这个 profile 真正要用的凭据：配置里的优先，其次读登记的环境变量。 */
export function resolveModelProfileCredential(input: {
  readonly configuredCredential: string
  readonly environmentName: Nullable<string>
  readonly environment: Readonly<Record<string, string | undefined>>
}): string {
  return resolveCredential(input)
}

/** 去掉 profile 上的密钥字段，剩下的才是能进日志与界面的部分。 */
export function omitModelProfileCredential<
  TProfile extends Record<string, unknown> & { apiKey: unknown },
>(profile: TProfile): Omit<TProfile, 'apiKey'> {
  return omitCredential(profile)
}

/** 把产品的连接探测放进有界 AbortSignal；探针内容和 provider 调用仍由宿主注入。 */
export async function runModelConnectionProbe<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs: number = ModelTuning.profiles.connectionProbeTimeoutMs
): Promise<T> {
  const timers = new TimerScope({ name: 'ModelConnectionProbe' })
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const timeout = timers.after(
    timeoutMs,
    () => controller.abort(new Error('连接检查超时。'))
  )
  try {
    return await operation(controller.signal)
  } finally {
    timeout.cancel()
    signal?.removeEventListener('abort', forwardAbort)
    timers.dispose()
  }
}
