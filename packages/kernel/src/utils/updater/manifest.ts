import { basename } from 'node:path'

import { z } from 'zod'

import { isNotUndefined, isUndefined } from '@velaros-ai/core'

import type { KernelArchitecture, KernelArtifact, KernelArtifactFormat, KernelArtifactSelection, KernelArtifactTarget, KernelManifestLoadOptions, KernelManifestQuery, KernelManifestVersion, KernelPlatform, KernelUpdateManifest } from '../../types/updater'
import { KernelUpdaterError } from '../errors'

import {
  fetchKernelText,
  nodeKernelFetch,
} from './transport'
import {
  compareKernelVersions,
  KernelVersionPattern,
  satisfiesKernelVersionRange,
} from './version'

export type { KernelArchitecture, KernelArtifact, KernelArtifactFormat, KernelArtifactSelection, KernelArtifactTarget, KernelManifestLoadOptions, KernelManifestQuery, KernelManifestVersion, KernelPlatform, KernelUpdateManifest } from '../../types/updater'
export const KernelPlatformSchema = z.enum(['darwin', 'linux', 'win32']) satisfies z.ZodType<KernelPlatform>

export const KernelArchitectureSchema = z.enum(['arm64', 'x64']) satisfies z.ZodType<KernelArchitecture>

export const KernelArtifactTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
] as const

export const KernelArtifactTargetSchema = z.enum(KernelArtifactTargets) satisfies z.ZodType<KernelArtifactTarget>

export const KernelArtifactFormatSchema = z.enum([
  'raw',
  'tar.gz',
  'tar.zst',
  'zip',
]) satisfies z.ZodType<KernelArtifactFormat>

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
}) satisfies z.ZodType<KernelArtifact>

export const KernelManifestVersionSchema = z.strictObject({
  version: KernelVersionSchema,
  releasedAt: z.string().min(1).optional(),
  notes: z.string().optional(),
  yanked: z.boolean().default(false),
  artifacts: z.partialRecord(KernelArtifactTargetSchema, KernelArtifactSchema),
}) satisfies z.ZodType<KernelManifestVersion>

export const KernelUpdateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  channel: z.string().min(1).default('stable'),
  versions: z.array(KernelManifestVersionSchema).min(1),
}) satisfies z.ZodType<KernelUpdateManifest>

/** 校验一份更新清单；结构不合格或同一个版本声明了两次都抛 INVALID_MANIFEST。 */
export function parseKernelUpdateManifest(input: unknown): KernelUpdateManifest {
  const result = KernelUpdateManifestSchema.safeParse(input)
  if (!result.success) {
    throw new KernelUpdaterError(
      'INVALID_MANIFEST',
      `内核更新清单不合法：${formatIssues(result.error)}`,
      {},
      { cause: result.error },
    )
  }

  const seen = new Set<string>()
  for (const entry of result.data.versions) {
    if (seen.has(entry.version)) {
      throw new KernelUpdaterError(
        'INVALID_MANIFEST',
        `内核更新清单里版本 "${entry.version}" 声明了两次`,
        { version: entry.version },
      )
    }
    seen.add(entry.version)
  }
  return result.data
}

/** 从一个来源取回并校验更新清单；`http(s)` URL、`file:` URL 与绝对路径都认，取不到抛 MANIFEST_UNREACHABLE。 */
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
      `"${source}" 处的内核更新清单不是合法 JSON`,
      { url: source },
      { cause: error },
    )
  }
  return parseKernelUpdateManifest(input)
}

/** 把平台与架构折成制品目标；缺省用本进程的，内核不发这个组合时抛 UNSUPPORTED_TARGET。 */
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
  if (isUndefined(target) || !target.success) {
    throw new KernelUpdaterError(
      'UNSUPPORTED_TARGET',
      `内核制品没有 ${platform}/${architecture} 这个目标`,
      { target: `${platform}-${architecture}` },
    )
  }
  return target.data
}

/** 在清单里找出某个版本的条目；清单里没发布这个版本就抛 VERSION_UNAVAILABLE。 */
export function findKernelManifestVersion(
  manifest: KernelUpdateManifest,
  version: string,
): KernelManifestVersion {
  const entry = manifest.versions.find((candidate) => candidate.version === version)
  if (isUndefined(entry)) {
    throw new KernelUpdaterError(
      'VERSION_UNAVAILABLE',
      `更新清单里没有发布内核版本 "${version}"`,
      { version },
    )
  }
  return entry
}

/** 取某个版本在某个目标上的制品；这个目标没发布制品就抛 ARTIFACT_NOT_FOUND。 */
export function selectKernelArtifact(
  manifest: KernelUpdateManifest,
  version: string,
  target: KernelArtifactTarget,
): KernelArtifactSelection {
  const entry = findKernelManifestVersion(manifest, version)
  const artifact = entry.artifacts[target]
  if (isUndefined(artifact)) {
    throw new KernelUpdaterError(
      'ARTIFACT_NOT_FOUND',
      `内核版本 "${version}" 没有为 ${target} 发布制品`,
      { version, target },
    )
  }
  return { version, target, artifact }
}

/** 按条件筛出清单里可用的版本，版本升序排；最新的那个合格版本在最后一条。 */
export function listKernelManifestVersions(
  manifest: KernelUpdateManifest,
  query: KernelManifestQuery = {},
): readonly KernelManifestVersion[] {
  const matches = manifest.versions.filter((entry) => {
    if (!query.includeYanked && entry.yanked) return false
    if (!satisfiesKernelVersionRange(entry.version, query.range)) return false
    return isUndefined(query.target) || isNotUndefined(entry.artifacts[query.target])
  })
  return matches.sort((left, right) =>
    compareKernelVersions(left.version, right.version))
}

/** 挑出最新的那个合格版本；一个都不合格时是 undefined。 */
export function selectKernelManifestVersion(
  manifest: KernelUpdateManifest,
  query: KernelManifestQuery = {},
): KernelManifestVersion | undefined {
  return listKernelManifestVersions(manifest, query).at(-1)
}

/** 把 zod 的校验问题拼成一行给人看的说明。 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}

/**
 * 制品落盘时用的文件名：从制品地址的末段取，非法字符换成 `-`。
 *
 * 取不出能用的名字（空、`.`、`..`）就退回 `kernel-payload`，绝不让制品地址决定往哪写。
 */
export function kernelArtifactFileName(artifact: KernelArtifact): string {
  const pathname = URL.canParse(artifact.url)
    ? new URL(artifact.url).pathname
    : artifact.url.split(/[?#]/)[0] ?? ''
  const candidate = basename(pathname)
    .replaceAll(/[^A-Za-z0-9._-]/g, '-')
  return candidate.length > 0 && candidate !== '.' && candidate !== '..'
    ? candidate
    : 'kernel-payload'
}
