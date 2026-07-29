import type {
  OpenKernelSessionInput,
  StartKernelRunInput,
} from '../contracts'
import type {
  KernelRunIdentity,
  KernelSessionIdentity,
} from '../protocol'

export type KernelIdentityRegistryErrorCode =
  | 'DUPLICATE_RUN'
  | 'DUPLICATE_SESSION'
  | 'INVALID_IDENTITY'
  | 'SESSION_NOT_FOUND'

export class KernelIdentityRegistryError extends Error {
  public constructor(
    public readonly code: KernelIdentityRegistryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KernelIdentityRegistryError'
  }
}

export interface KernelIdentityRegistryOptions {
  readonly now?: () => number
}

function assertIdentityPart(value: string, label: string): void {
  if (value.trim().length > 0) return
  throw new KernelIdentityRegistryError(
    'INVALID_IDENTITY',
    `${label} must not be empty`,
  )
}

/**
 * Product-neutral ownership registry for active session and run identities.
 *
 * It deliberately stores no conversation, workspace, model, or tool state.
 * Closing a session also finishes its active child runs so service shutdown can
 * clean the complete identity graph deterministically.
 */
export class KernelIdentityRegistry {
  private readonly sessions = new Map<string, KernelSessionIdentity>()
  private readonly runs = new Map<string, KernelRunIdentity>()
  private readonly runGenerations = new Map<string, number>()
  private readonly now: () => number

  public constructor(options: KernelIdentityRegistryOptions = {}) {
    this.now = options.now ?? Date.now
  }

  public openSession(
    input: OpenKernelSessionInput,
  ): KernelSessionIdentity {
    assertIdentityPart(input.id, 'Session id')
    assertIdentityPart(input.ownerModuleId, 'Session owner module id')
    if (this.sessions.has(input.id)) {
      throw new KernelIdentityRegistryError(
        'DUPLICATE_SESSION',
        `Session "${input.id}" is already active`,
      )
    }

    const identity: KernelSessionIdentity = Object.freeze({
      id: input.id,
      ownerModuleId: input.ownerModuleId,
      scope: input.scope,
      createdAt: this.now(),
    })
    this.sessions.set(identity.id, identity)
    return identity
  }

  public getSession(sessionId: string): KernelSessionIdentity | undefined {
    return this.sessions.get(sessionId)
  }

  public listSessions(): readonly KernelSessionIdentity[] {
    return [...this.sessions.values()].sort(byIdentityId)
  }

  public closeSession(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false
    for (const [runId, run] of this.runs) {
      if (run.sessionId === sessionId) this.runs.delete(runId)
    }
    return true
  }

  public startRun(input: StartKernelRunInput): KernelRunIdentity {
    assertIdentityPart(input.id, 'Run id')
    assertIdentityPart(input.ownerModuleId, 'Run owner module id')
    if (this.runs.has(input.id)) {
      throw new KernelIdentityRegistryError(
        'DUPLICATE_RUN',
        `Run "${input.id}" is already active`,
      )
    }
    if (
      input.sessionId !== null
      && !this.sessions.has(input.sessionId)
    ) {
      throw new KernelIdentityRegistryError(
        'SESSION_NOT_FOUND',
        `Session "${input.sessionId}" is not active`,
      )
    }

    const generation = (this.runGenerations.get(input.id) ?? 0) + 1
    const identity: KernelRunIdentity = Object.freeze({
      id: input.id,
      ownerModuleId: input.ownerModuleId,
      sessionId: input.sessionId,
      generation,
      startedAt: this.now(),
    })
    this.runGenerations.set(identity.id, identity.generation)
    this.runs.set(identity.id, identity)
    return identity
  }

  public getRun(runId: string): KernelRunIdentity | undefined {
    return this.runs.get(runId)
  }

  public listRuns(): readonly KernelRunIdentity[] {
    return [...this.runs.values()].sort(byIdentityId)
  }

  public finishRun(runId: string): boolean {
    return this.runs.delete(runId)
  }

  public clear(): void {
    this.sessions.clear()
    this.runs.clear()
    this.runGenerations.clear()
  }
}

function byIdentityId(
  left: { readonly id: string },
  right: { readonly id: string },
): number {
  return left.id.localeCompare(right.id)
}
