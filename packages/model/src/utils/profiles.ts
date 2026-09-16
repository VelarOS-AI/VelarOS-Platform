import type { ModelProfileCredentialSource } from '../types/model'

/** 判断这个 profile 的凭据是从配置来、从环境变量来、不需要，还是缺。 */
export function resolveCredentialSource(input: {
  readonly configuredCredential: string
  readonly environmentName: Nullable<string>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly credentialOptional: boolean
}): ModelProfileCredentialSource {
  if (input.configuredCredential.trim()) return 'config'
  if (input.environmentName && input.environment[input.environmentName]?.trim()) return 'environment'
  return input.credentialOptional ? 'not-required' : 'missing'
}

/** 取这个 profile 真正要用的凭据：配置里的优先，其次读登记的环境变量。 */
export function resolveCredential(input: {
  readonly configuredCredential: string
  readonly environmentName: Nullable<string>
  readonly environment: Readonly<Record<string, string | undefined>>
}): string {
  return input.configuredCredential.trim()
    || (input.environmentName ? input.environment[input.environmentName]?.trim() ?? '' : '')
}

/** 去掉 profile 上的密钥字段，剩下的才是能进日志与界面的部分。 */
export function omitCredential<
  TProfile extends Record<string, unknown> & { apiKey: unknown },
>(profile: TProfile): Omit<TProfile, 'apiKey'> {
  const { apiKey: _apiKey, ...visible } = profile
  return visible
}
