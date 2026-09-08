import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

export type ModelProfileCredentialSource = 'config' | 'environment' | 'not-required' | 'missing'

export interface ModelProfileStorePort<TProfile> {
  list(): Promise<readonly TProfile[]> | readonly TProfile[]
  get(id: string): Promise<Nullable<TProfile>> | Nullable<TProfile>
  save(profile: TProfile): Promise<void> | void
  remove(id: string): Promise<void> | void
  activate(id: string): Promise<void> | void
}

/** Secret storage is a product adapter (Keychain/Credential Manager/encrypted config), not Model-owned I/O. */
export interface ModelCredentialStorePort {
  get(profileId: string): Promise<Nullable<string>> | Nullable<string>
  set(profileId: string, credential: string): Promise<void> | void
  clear(profileId: string): Promise<void> | void
}

export interface ModelProfileEnvironmentPort {
  read(name: string): string | undefined
}

export interface ModelConnectionProbePort<TResolved> {
  probe(resolved: TResolved, signal: AbortSignal): Promise<{ readonly responseText?: string } | void>
}

export function resolveModelProfileCredentialSource(input: {
  readonly configuredCredential: string
  readonly environmentName: Nullable<string>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly credentialOptional: boolean
}): ModelProfileCredentialSource {
  if (input.configuredCredential.trim()) return 'config'
  if (input.environmentName && input.environment[input.environmentName]?.trim()) return 'environment'
  return input.credentialOptional ? 'not-required' : 'missing'
}

export function resolveModelProfileCredential(input: {
  readonly configuredCredential: string
  readonly environmentName: Nullable<string>
  readonly environment: Readonly<Record<string, string | undefined>>
}): string {
  return input.configuredCredential.trim()
    || (input.environmentName ? input.environment[input.environmentName]?.trim() ?? '' : '')
}

export function omitModelProfileCredential<
  TProfile extends Record<string, unknown> & { apiKey: unknown },
>(profile: TProfile): Omit<TProfile, 'apiKey'> {
  const { apiKey: _apiKey, ...visible } = profile
  return visible
}

/** 把产品 probe 统一放进有界 AbortSignal；探针内容和 provider 调用仍由 host 注入。 */
export async function runModelConnectionProbe<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 20_000
): Promise<T> {
  const timers = new TimerScope({ name: 'ModelConnectionProbe' })
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const timeout = timers.after(
    timeoutMs,
    () => controller.abort(new Error('Connection check timed out.'))
  )
  try {
    return await operation(controller.signal)
  } finally {
    timeout.cancel()
    signal?.removeEventListener('abort', forwardAbort)
    timers.dispose()
  }
}
