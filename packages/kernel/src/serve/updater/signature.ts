import { isUndefined } from '@velaros-ai/core'

import type {
  KernelArtifact,
  KernelArtifactTarget,
} from './manifest'

export interface KernelArtifactSignatureContext {
  readonly version: string
  readonly target: KernelArtifactTarget
  readonly artifact: KernelArtifact
  readonly payloadPath: string
  readonly sha256: string
}

export interface KernelArtifactSignatureResult {
  readonly verified: boolean
  readonly method: string
  readonly reason?: string
}

/**
 * Injection point invoked after digest verification and before anything is
 * staged. The updater deliberately ships no cryptographic implementation: a
 * deployment supplies a verifier bound to its own trust root and key rotation
 * policy, and enables `requireSignature` once that verifier is in place.
 */
export interface KernelArtifactSignatureVerifier {
  verify(
    context: KernelArtifactSignatureContext,
  ): Promise<KernelArtifactSignatureResult>
}

/** Default verifier: reports every artifact as unverified without failing. */
export class UnverifiedKernelArtifactSignatureVerifier
implements KernelArtifactSignatureVerifier {
  public verify(
    context: KernelArtifactSignatureContext,
  ): Promise<KernelArtifactSignatureResult> {
    return Promise.resolve({
      verified: false,
      method: 'none',
      reason: isUndefined(context.artifact.signature)
        ? 'No signature verifier is installed'
        : 'A signature is present but no verifier is installed',
    })
  }
}
