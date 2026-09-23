/**
 * 认证对象与认证策略的 schema，`satisfies z.ZodType<…>` 对齐手写类型。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import { z } from 'zod'

import {
  AgentLabLimits,
  CertificationSubjectKinds,
  ObservationFaces,
} from '../../contract/constants.js'
import type { CertificationPolicy, CertificationSubject } from '../../types/agent-lab.js'

import { identifierSchema } from './primitives.js'

/** 被认证的对象：是谁、什么版本、内容摘要多少。 */
export const certificationSubjectSchema = z.strictObject({
  kind: z.enum(CertificationSubjectKinds),
  id: identifierSchema,
  version: z.string().trim().min(1).max(AgentLabLimits.identifierChars),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}) satisfies z.ZodType<CertificationSubject>

/** 认证策略：要跑哪些旅程、重复几次、可靠性下界多少、每个观测面要求到什么程度。 */
export const certificationPolicySchema = z.strictObject({
  id: identifierSchema,
  version: z.number().int().positive(),
  requiredJourneyIds: z.array(identifierSchema).min(1),
  minimumReplicatesPerJourney: z.number().int().positive(),
  minimumReliability: z.number().min(0).max(1),
  maximumAttritionRate: z.number().min(0).max(1),
  requiredObservationCoverage: z.strictObject(
    Object.fromEntries(
      ObservationFaces.map((face) => [face, z.enum(['partial', 'full']).optional()])
    ) as Record<
      (typeof ObservationFaces)[number],
      z.ZodOptional<z.ZodEnum<{ partial: 'partial'; full: 'full' }>>
    >
  ),
  requireSeparateVerifier: z.boolean(),
  requireNativeExecution: z.boolean(),
  requireBaseline: z.boolean(),
  maximumBaselineRegression: z.number().min(0).max(1),
}) satisfies z.ZodType<CertificationPolicy>
