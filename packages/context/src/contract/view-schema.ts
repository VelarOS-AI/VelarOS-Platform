/** 模型和脚本共用的观察协议定义。 */
export const ContextTargetSchema = {
  anyOf: [
    { type: 'object', properties: { kind: { const: 'artifact' }, ref: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } }, required: ['sessionId', 'id'], additionalProperties: false } }, required: ['kind', 'ref'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'resource' }, sourceId: { type: 'string', minLength: 1 }, resourceId: { type: 'string', minLength: 1 }, selector: { anyOf: [
      { type: 'object', properties: { kind: { const: 'whole' } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'lines' }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } }, required: ['kind', 'start', 'end'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'symbol' }, name: { type: 'string', minLength: 1 } }, required: ['kind', 'name'], additionalProperties: false },
    ] } }, required: ['kind', 'sourceId', 'resourceId'], additionalProperties: false },
  ],
} as const
/** 时间语义不由资源版本推测。 */
export const ContextTimeSchema = { anyOf: [
  { type: 'object', properties: { kind: { enum: ['after-step', 'historical'] } }, required: ['kind'], additionalProperties: false },
  { type: 'object', properties: { kind: { const: 'snapshot' }, snapshotId: { type: 'string', minLength: 1 } }, required: ['kind', 'snapshotId'], additionalProperties: false },
] } as const
/** 模型输入不能覆盖 ID、作用域、回执或正文。 */
const ViewIntentFields = {
  purpose: { type: 'string', maxLength: 2000 },
  importance: { enum: ['required', 'preferred'] }, time: ContextTimeSchema,
  forms: { type: 'array', items: { enum: ['full', 'excerpt', 'definition', 'metadata', 'diff'] }, minItems: 1, maxItems: 5 },
  maxTokensHint: { type: 'integer', minimum: 1, maximum: 100000 },
} as const
/** 精确与语义需求各自拥有完整的 JSON Schema 与同源脚本声明。 */
export const ViewIntentSchema = { anyOf: [
  { type: 'object', properties: { ...ViewIntentFields, kind: { const: 'direct' }, target: ContextTargetSchema }, required: ['kind', 'target'], additionalProperties: false },
  { type: 'object', properties: { ...ViewIntentFields, kind: { const: 'semantic' }, objective: { type: 'string', minLength: 1, maxLength: 2000 }, anchors: { type: 'array', items: ContextTargetSchema, maxItems: 8 } }, required: ['kind', 'objective'], additionalProperties: false },
] } as const
/** Context 模型只输出候选计划和只读检索请求。 */
export const ContextPlannerSchema = {
  anyOf: [
    { type: 'object', properties: { kind: { const: 'select' }, selections: { type: 'array', maxItems: 32, items: { type: 'object', properties: { candidateId: { type: 'string' }, intentIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 }, form: { enum: ['full', 'excerpt', 'definition', 'metadata', 'diff'] } }, required: ['candidateId', 'intentIds', 'form'], additionalProperties: false } } }, required: ['kind', 'selections'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'search' }, intentId: { type: 'string' }, sourceId: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 32 } }, required: ['kind', 'intentId', 'sourceId', 'query', 'limit'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'inspect' }, candidateIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } }, required: ['kind', 'candidateIds'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'insufficient' }, intentIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 }, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['kind', 'intentIds', 'reason'], additionalProperties: false },
  ],
} as const
/** 模型陈述不接受验证事实或用户目标字段。 */
export const TaskCapsuleSchema = {
  type: 'object', properties: {
    nextObjective: { type: 'string', maxLength: 2000 },
    hypotheses: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 1000 } },
    decisions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 1000 } },
    openQuestions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 1000 } },
  }, additionalProperties: false,
} as const
