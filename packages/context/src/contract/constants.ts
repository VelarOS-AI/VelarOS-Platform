/** 状态与变更流的存储边界。 */
export const StoreLimits = Object.freeze({
  /** 单对象 JSON 字节上限。 */
  valueBytes: 262144,
  /** 对象键字符上限。 */
  keyChars: 256,
  /** 宿主范围字符上限。 */
  scopeChars: 1024,
  /** 订阅选择项上限。 */
  watchItems: 64,
  /** 默认分页条数。 */
  page: 32,
  /** 分页条数上限。 */
  maxPage: 64,
  /** 消息 JSON 字节上限。 */
  messageBytes: 16384,
  /** 每空间保留事件条数。 */
  retainedEvents: 4096,
  /** 每次扫描事件条数。 */
  scanEvents: 256,
  /** 跨连接轮询间隔毫秒。 */
  pollMs: 250,
  /** 每次目录查询上限。 */
  stores: 128,
  /** 空间名称字符上限。 */
  nameChars: 128,
  /** 空间说明字符上限。 */
  descriptionChars: 512
})
/** 有限默认值，适配器仍需限制单次 I/O。 */
export const DefaultContextViewLimits = Object.freeze({
  /** 每步观察需求上限。 */
  intents: 16,
  /** 候选证据数量上限。 */
  candidates: 32,
  /** 每次物化的规划调用上限。 */
  plannerCalls: 2,
  /** 每次物化的来源检索上限。 */
  searchCalls: 6,
  /** 规划器检查正文的字节上限。 */
  inspectBytes: 65536,
  /** 物化证据的字符上限。 */
  evidenceChars: 24000,
  /** 发布冲突后的刷新次数上限。 */
  refreshes: 2,
  /** 任务模型调用总数上限。 */
  modelCalls: 128,
  /** 任务模型 token 总数上限。 */
  modelTokens: 500000,
  /** 单次物化时限毫秒。 */
  materializationMs: 30000,
  /** 任务租约时长毫秒。 */
  leaseMs: 360000
})
/** 上下文公共边界上限。 */
export const ContextLimits = Object.freeze({
  /** 索引目录单页条目上限。 */
  recordPage: 256,
  /** 未发布对象至少保留一小时，供候选提交与故障诊断。 */
  orphanGraceMs: 3600000,
  /** 已整理输入保留可召回的有界原文锚点，避免超大输入使维护永远无效。 */
  inputAnchorChars: 1000,
  /** 单次原文读取上限。 */
  readChars: 60000,
  /** 单页结果上限。 */
  searchItems: 100,
  /** 单条检索预览上限。 */
  previewChars: 500,
  /** 原始正文的单对象上限。 */
  objectChars: 8000000,
  /** 模型一次选入的材料上限。 */
  workingSetItems: 2000,
})
/** 模型和脚本共用的观察协议定义。 */
export const ContextTargetSchema = Object.freeze({
  anyOf: [
      { type: 'object', properties: { kind: { const: 'artifact' }, ref: { type: 'object', properties: { sessionId: { type: 'string',
  /** 字段最少字符数。 */
                          minLength: 1 }, id: { type: 'string',
  /** 字段最少字符数。 */
                          minLength: 1 } }, required: ['sessionId', 'id'], additionalProperties: false } }, required: ['kind', 'ref'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'resource' }, sourceId: { type: 'string',
  /** 字段最少字符数。 */
                  minLength: 1 }, resourceId: { type: 'string',
  /** 字段最少字符数。 */
                  minLength: 1 }, selector: { anyOf: [
                      { type: 'object', properties: { kind: { const: 'whole' } }, required: ['kind'], additionalProperties: false },
                      { type: 'object', properties: { kind: { const: 'lines' }, start: { type: 'integer',
  /** 字段整数下界。 */
                                  minimum: 1 }, end: { type: 'integer',
  /** 字段整数下界。 */
                                  minimum: 1 } }, required: ['kind', 'start', 'end'], additionalProperties: false },
                      { type: 'object', properties: { kind: { const: 'symbol' }, name: { type: 'string',
  /** 字段最少字符数。 */
                                  minLength: 1 } }, required: ['kind', 'name'], additionalProperties: false },
                  ] } }, required: ['kind', 'sourceId', 'resourceId'], additionalProperties: false },
  ],
} as const)
/** 时间语义不由资源版本推测。 */
export const ContextTimeSchema = Object.freeze({ anyOf: [
      { type: 'object', properties: { kind: { enum: ['after-step', 'historical'] } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'snapshot' }, snapshotId: { type: 'string',
  /** 字段最少字符数。 */
                  minLength: 1 } }, required: ['kind', 'snapshotId'], additionalProperties: false },
  ] } as const)
/** 精确与语义需求各自拥有完整的 JSON Schema 与同源脚本声明。 */
export const ViewIntentSchema = Object.freeze({ anyOf: [
      { type: 'object', properties: { ...({
                  purpose: { type: 'string',
  /** 字段最多字符数。 */
                      maxLength: 2000 },
                  importance: { enum: ['required', 'preferred'] }, time: ContextTimeSchema,
                  forms: { type: 'array', items: { enum: ['full', 'excerpt', 'definition', 'metadata', 'diff'] },
  /** 数组最少条目数。 */
                      minItems: 1,
  /** 数组最多条目数。 */
                      maxItems: 5 },
                  maxTokensHint: { type: 'integer',
  /** 字段整数下界。 */
                      minimum: 1,
  /** 字段整数上界。 */
                      maximum: 100000 },
              } as const), kind: { const: 'direct' }, target: ContextTargetSchema }, required: ['kind', 'target'], additionalProperties: false },
      { type: 'object', properties: { ...({
                  purpose: { type: 'string',
  /** 字段最多字符数。 */
                      maxLength: 2000 },
                  importance: { enum: ['required', 'preferred'] }, time: ContextTimeSchema,
                  forms: { type: 'array', items: { enum: ['full', 'excerpt', 'definition', 'metadata', 'diff'] },
  /** 数组最少条目数。 */
                      minItems: 1,
  /** 数组最多条目数。 */
                      maxItems: 5 },
                  maxTokensHint: { type: 'integer',
  /** 字段整数下界。 */
                      minimum: 1,
  /** 字段整数上界。 */
                      maximum: 100000 },
              } as const), kind: { const: 'semantic' }, objective: { type: 'string',
  /** 字段最少字符数。 */
                  minLength: 1,
  /** 字段最多字符数。 */
                  maxLength: 2000 }, anchors: { type: 'array', items: ContextTargetSchema,
  /** 数组最多条目数。 */
                  maxItems: 8 } }, required: ['kind', 'objective'], additionalProperties: false },
  ] } as const)
/** Context 模型只输出候选计划和只读检索请求。 */
export const ContextPlannerSchema = Object.freeze({
  anyOf: [
      { type: 'object', properties: { kind: { const: 'select' }, selections: { type: 'array',
  /** 数组最多条目数。 */
                  maxItems: 32, items: { type: 'object', properties: { candidateId: { type: 'string' }, intentIds: { type: 'array', items: { type: 'string' },
  /** 数组最少条目数。 */
                              minItems: 1,
  /** 数组最多条目数。 */
                              maxItems: 16 }, form: { enum: ['full', 'excerpt', 'definition', 'metadata', 'diff'] } }, required: ['candidateId', 'intentIds', 'form'], additionalProperties: false } } }, required: ['kind', 'selections'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'search' }, intentId: { type: 'string' }, sourceId: { type: 'string' }, query: { type: 'string',
  /** 字段最少字符数。 */
                  minLength: 1,
  /** 字段最多字符数。 */
                  maxLength: 2000 }, limit: { type: 'integer',
  /** 字段整数下界。 */
                  minimum: 1,
  /** 字段整数上界。 */
                  maximum: 32 } }, required: ['kind', 'intentId', 'sourceId', 'query', 'limit'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'inspect' }, candidateIds: { type: 'array', items: { type: 'string' },
  /** 数组最少条目数。 */
                  minItems: 1,
  /** 数组最多条目数。 */
                  maxItems: 8 } }, required: ['kind', 'candidateIds'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'insufficient' }, intentIds: { type: 'array', items: { type: 'string' },
  /** 数组最少条目数。 */
                  minItems: 1,
  /** 数组最多条目数。 */
                  maxItems: 16 }, reason: { type: 'string',
  /** 字段最少字符数。 */
                  minLength: 1,
  /** 字段最多字符数。 */
                  maxLength: 2000 } }, required: ['kind', 'intentIds', 'reason'], additionalProperties: false },
  ],
} as const)
/** 模型陈述不接受验证事实或用户目标字段。 */
export const TaskCapsuleSchema = Object.freeze({
  type: 'object', properties: {
      nextObjective: { type: 'string',
  /** 字段最多字符数。 */
          maxLength: 2000 },
      hypotheses: { type: 'array',
  /** 数组最多条目数。 */
          maxItems: 16, items: { type: 'string',
  /** 字段最多字符数。 */
              maxLength: 1000 } },
      decisions: { type: 'array',
  /** 数组最多条目数。 */
          maxItems: 16, items: { type: 'string',
  /** 字段最多字符数。 */
              maxLength: 1000 } },
      openQuestions: { type: 'array',
  /** 数组最多条目数。 */
          maxItems: 16, items: { type: 'string',
  /** 字段最多字符数。 */
              maxLength: 1000 } },
  }, additionalProperties: false,
} as const)
