import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type {
  KernelArtifact,
  KernelArtifactTarget,
} from './manifest'

export interface KernelArtifactExtractionContext {
  readonly version: string
  readonly target: KernelArtifactTarget
  readonly artifact: KernelArtifact
  readonly payloadPath: string
  readonly destinationDirectory: string
}

/**
 * Expands a verified payload into a staging directory that is later renamed
 * into `versions/<version>/`. Implementations must only write inside
 * `destinationDirectory`.
 */
export interface KernelArtifactExtractor {
  extract(context: KernelArtifactExtractionContext): Promise<void>
}

/**
 * Default extractor. It treats the artifact as one opaque file because archive
 * expansion needs a tar/zip implementation the Kernel does not depend on;
 * deployments shipping `tar.gz`, `tar.zst`, or `zip` artifacts inject their own.
 */
export class PassthroughKernelArtifactExtractor
implements KernelArtifactExtractor {
  public async extract(
    context: KernelArtifactExtractionContext,
  ): Promise<void> {
    await copyFile(
      context.payloadPath,
      join(context.destinationDirectory, kernelArtifactFileName(context.artifact)),
    )
  }
}

export function kernelArtifactFileName(artifact: KernelArtifact): string {
  const candidate = basename(artifactPathname(artifact.url))
    .replaceAll(/[^A-Za-z0-9._-]/g, '-')
  return candidate.length > 0 && candidate !== '.' && candidate !== '..'
    ? candidate
    : 'kernel-payload'
}

function artifactPathname(url: string): string {
  if (URL.canParse(url)) return new URL(url).pathname
  return url.split(/[?#]/)[0] ?? ''
}
