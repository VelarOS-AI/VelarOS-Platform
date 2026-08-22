import { z } from 'zod'

import {
  isEmpty,
  isNonBlankString,
  isPlainObject,
  isString,
  toOptional,
} from '@velaros-ai/core'

/** One signed, versioned declaration per Mod. Every domain routes from this envelope. */
export const VelarosModManifestFileName = 'velaros.mod.json' as const

const TrimmedIdSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1))
const SemverVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u
const SemverComparatorPattern = /^(?:\^|~|>=|<=|>|<|=)?\s*(.+)$/u
const SemverVersionSchema = TrimmedIdSchema.refine(
  (value) => SemverVersionPattern.test(value),
  { message: '不是合法的 x.y.z 版本号' },
)

function isSemverRangeParsable(range: string): boolean {
  return range.split('||').every((clause) => {
    const comparators = clause.trim().split(/\s+/u).filter(Boolean)
    return !isEmpty(comparators) && comparators.every((part) => {
      if (part === '*' || part === 'x') return true
      const match = SemverComparatorPattern.exec(part)
      return !!match && SemverVersionPattern.test(match[1] ?? '')
    })
  })
}

const SemverRangeSchema = TrimmedIdSchema.refine(isSemverRangeParsable, {
  message: '不是可解析的 semver range',
})

function tolerantArray<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return z.preprocess(
    (value) => isString(value) ? [value] : value,
    z.array(schema),
  )
}

function tolerantCapabilityRef<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return z.preprocess(
    (value) => isString(value) ? { id: value } : value,
    schema,
  )
}

/** JSON projection of a Kernel capability token. */
export const VelarosModCapabilityTokenSchema = z.strictObject({
  id: TrimmedIdSchema,
  version: TrimmedIdSchema.default('1.0.0'),
})

/** JSON projection of a Kernel capability requirement. */
export const VelarosModCapabilityRequirementSchema = z.strictObject({
  id: TrimmedIdSchema,
  versionRange: SemverRangeSchema.optional(),
})

/**
 * Kernel-owned section of the Mod envelope.
 *
 * `provides` contains real callable capability ids only. Domain routing is
 * determined by the presence of sibling sections and must never overload a
 * capability id as a pack marker.
 */
export const VelarosModModuleSectionSchema = z.strictObject({
  id: TrimmedIdSchema,
  version: SemverVersionSchema,
  apiVersion: z.number().int().positive(),
  provides: tolerantArray(
    tolerantCapabilityRef(VelarosModCapabilityTokenSchema),
  ).default([]),
  requires: tolerantArray(
    tolerantCapabilityRef(VelarosModCapabilityRequirementSchema),
  ).default([]),
  optionalRequires: tolerantArray(
    tolerantCapabilityRef(VelarosModCapabilityRequirementSchema),
  ).default([]),
  permissions: tolerantArray(TrimmedIdSchema).default([]),
  isolation: z.enum(['in-process', 'worker', 'remote', 'sidecar'])
    .default('in-process'),
  entry: TrimmedIdSchema.optional(),
  exportName: TrimmedIdSchema.optional(),
})

/**
 * The only public Mod manifest envelope. Kernel validates `module`; domain
 * owners validate their own opaque sections after the envelope has been routed.
 */
export const VelarosModEnvelopeSchema = z.strictObject({
  module: VelarosModModuleSectionSchema,
  agent: z.unknown().optional(),
  ui: z.unknown().optional(),
})

export type VelarosModModuleSection = z.infer<typeof VelarosModModuleSectionSchema>
export type VelarosModEnvelope = z.infer<typeof VelarosModEnvelopeSchema>

export interface VelarosModManifestDiagnostic {
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly modId?: string
  readonly origin?: string
}

export type VelarosModEnvelopeParseResult =
  | { readonly ok: true; readonly envelope: VelarosModEnvelope }
  | { readonly ok: false; readonly diagnostics: readonly VelarosModManifestDiagnostic[] }

function readSectionId(input: unknown): string | undefined {
  if (!isPlainObject(input)) return undefined
  const id = Reflect.get(input, 'id')
  return isNonBlankString(id) ? id.trim() : undefined
}

/** Validate once at the shared entry, then route opaque sections to their owners. */
export function parseVelarosModEnvelope(
  input: unknown,
  options: { readonly origin?: string } = {},
): VelarosModEnvelopeParseResult {
  const parsed = VelarosModEnvelopeSchema.safeParse(input)
  if (!parsed.success) return {
    ok: false,
    diagnostics: parsed.error.issues.map((issue) => ({
      code: 'mod.envelope-invalid',
      message: issue.message,
      path: issue.path.join('.') || '<root>',
      origin: toOptional(options.origin),
    })),
  }

  const envelope = parsed.data
  const agentId = readSectionId(envelope.agent)
  if (agentId && agentId !== envelope.module.id) return {
    ok: false,
    diagnostics: [{
      code: 'mod.envelope-id-mismatch',
      message: `module 节的 id「${envelope.module.id}」与 agent 节的 id「${agentId}」不一致；一个 Mod 只能有一个身份。`,
      path: 'agent.id',
      modId: envelope.module.id,
      origin: toOptional(options.origin),
    }],
  }

  return { ok: true, envelope }
}
