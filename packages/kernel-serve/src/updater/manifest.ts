import { z } from 'zod'

import { KernelUpdaterError } from './errors'
import {
  fetchKernelText,
  type KernelFetch,
  nodeKernelFetch,
} from './transport'
import {
  compareKernelVersions,
  KernelVersionPattern,
  satisfiesKernelVersionRange,
} from './version'

export const KernelPlatformSchema = z.enum(['darwin', 'linux', 'win32'])
export type KernelPlatform = z.infer<typeof KernelPlatformSchema>

export const KernelArchitectureSchema = z.enum(['arm64', 'x64'])
export type KernelArchitecture = z.infer<typeof KernelArchitectureSchema>

export const KernelArtifactTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
] as const

export const KernelArtifactTargetSchema = z.enum(KernelArtifactTargets)
export type KernelArtifactTarget = z.infer<typeof KernelArtifactTargetSchema>

export const KernelArtifactFormatSchema = z.enum([
  'raw',
  'tar.gz',
  'tar.zst',
  'zip',
])
export type KernelArtifactFormat = z.infer<typeof KernelArtifactFormatSchema>

export const KernelVersionSchema = z.string().regex(
  KernelVersionPattern,
  'must be a semantic version',
)

export const KernelArtifactSchema = z.strictObject({
  url: z.string().min(1),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest'),
  format: KernelArtifactFormatSchema.default('raw'),
  signature: z.string().min(1).optional(),
})
export type KernelArtifact = z.infer<typeof KernelArtifactSchema>

export const KernelManifestVersionSchema = z.strictObject({
  version: KernelVersionSchema,
  releasedAt: z.string().min(1).optional(),
  notes: z.string().optional(),
  yanked: z.boolean().default(false),
  artifacts: z.partialRecord(KernelArtifactTargetSchema, KernelArtifactSchema),
})
export type KernelManifestVersion = z.infer<typeof KernelManifestVersionSchema>

export const KernelUpdateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  channel: z.string().min(1).default('stable'),
  versions: z.array(KernelManifestVersionSchema).min(1),
})
export type KernelUpdateManifest = z.infer<typeof KernelUpdateManifestSchema>

export interface KernelArtifactSelection {
  readonly version: string
  readonly target: KernelArtifactTarget
  readonly artifact: KernelArtifact
}

export interface KernelManifestQuery {
  readonly range?: string
  readonly target?: KernelArtifactTarget
  readonly includeYanked?: boolean
}

export interface KernelManifestLoadOptions {
  readonly fetch?: KernelFetch
  readonly signal?: AbortSignal
}

export function parseKernelUpdateManifest(input: unknown): KernelUpdateManifest {
  const result = KernelUpdateManifestSchema.safeParse(input)
  if (!result.success) {
    throw new KernelUpdaterError(
      'INVALID_MANIFEST',
      `Kernel update manifest is invalid: ${formatIssues(result.error)}`,
      {},
      { cause: result.error },
    )
  }

  const seen = new Set<string>()
  for (const entry of result.data.versions) {
    if (seen.has(entry.version)) {
      throw new KernelUpdaterError(
        'INVALID_MANIFEST',
        `Kernel update manifest declares version "${entry.version}" twice`,
        { version: entry.version },
      )
    }
    seen.add(entry.version)
  }
  return result.data
}

/** Accepts an `http(s)` URL, a `file:` URL, or an absolute filesystem path. */
export async function loadKernelUpdateManifest(
  source: string,
  options: KernelManifestLoadOptions = {},
): Promise<KernelUpdateManifest> {
  const text = await fetchKernelText(
    options.fetch ?? nodeKernelFetch,
    source,
    options.signal,
  )
  let input: unknown
  try {
    input = JSON.parse(text) as unknown
  } catch (error) {
    throw new KernelUpdaterError(
      'INVALID_MANIFEST',
      `Kernel update manifest at "${source}" is not valid JSON`,
      { url: source },
      { cause: error },
    )
  }
  return parseKernelUpdateManifest(input)
}

export function resolveKernelArtifactTarget(
  platform: string = process.platform,
  architecture: string = process.arch,
): KernelArtifactTarget {
  const parsedPlatform = KernelPlatformSchema.safeParse(platform)
  const parsedArchitecture = KernelArchitectureSchema.safeParse(architecture)
  const target = parsedPlatform.success && parsedArchitecture.success
    ? KernelArtifactTargetSchema.safeParse(
      `${parsedPlatform.data}-${parsedArchitecture.data}`,
    )
    : undefined
  if (target === undefined || !target.success) {
    throw new KernelUpdaterError(
      'UNSUPPORTED_TARGET',
      `No Kernel artifact target exists for ${platform}/${architecture}`,
      { target: `${platform}-${architecture}` },
    )
  }
  return target.data
}

export function findKernelManifestVersion(
  manifest: KernelUpdateManifest,
  version: string,
): KernelManifestVersion {
  const entry = manifest.versions.find((candidate) => candidate.version === version)
  if (entry === undefined) {
    throw new KernelUpdaterError(
      'VERSION_UNAVAILABLE',
      `Kernel version "${version}" is not published in the update manifest`,
      { version },
    )
  }
  return entry
}

export function selectKernelArtifact(
  manifest: KernelUpdateManifest,
  version: string,
  target: KernelArtifactTarget,
): KernelArtifactSelection {
  const entry = findKernelManifestVersion(manifest, version)
  const artifact = entry.artifacts[target]
  if (artifact === undefined) {
    throw new KernelUpdaterError(
      'ARTIFACT_NOT_FOUND',
      `Kernel version "${version}" publishes no artifact for ${target}`,
      { version, target },
    )
  }
  return { version, target, artifact }
}

/** Ascending by version; the newest acceptable release is the last entry. */
export function listKernelManifestVersions(
  manifest: KernelUpdateManifest,
  query: KernelManifestQuery = {},
): readonly KernelManifestVersion[] {
  const matches = manifest.versions.filter((entry) => {
    if (!(query.includeYanked ?? false) && entry.yanked) return false
    if (!satisfiesKernelVersionRange(entry.version, query.range)) return false
    return query.target === undefined || entry.artifacts[query.target] !== undefined
  })
  return matches.sort((left, right) =>
    compareKernelVersions(left.version, right.version))
}

export function selectKernelManifestVersion(
  manifest: KernelUpdateManifest,
  query: KernelManifestQuery = {},
): KernelManifestVersion | undefined {
  return listKernelManifestVersions(manifest, query).at(-1)
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}
