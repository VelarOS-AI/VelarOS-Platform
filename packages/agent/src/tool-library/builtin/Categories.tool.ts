import { type z } from 'zod'

import { defineVelaTool } from '../defineVelaTool'

import {
  parseToolSpaceQueryMethodInput,
  runToolSpace,
  toolSpaceQueryMethodSchema,
  toolSpaceReadMethodSchema,
  toolSpaceReplaceMethodSchema,
  toolSpaceSchema,
} from './Categories'

const toolSpaceMap = defineVelaTool<z.input<typeof toolSpaceQueryMethodSchema>>({
  name: 'tooling:map',
  role: 'control',
  category: 'agent-control',
  // 工具地图就是模型当下要读的内容：禁止 page-out 成 payload 引用，否则模型还得
  // context:recall 召回，白白多花轮次（见 debug：tooling:map→卸载→recall）。
  outputInline: true,
  summary:
    'ContextOS 工具发现入口：有具体任务时用 op=find+query 精确找工具；只有全局审计才按分类展开地图。',
  suitable: [
    '需要按任务短语搜索工具页，或分页读取工具页状态。',
    '需要查看系统所有工具/能力的状态清单和完整工具名索引。',
    '需要知道某一类能力如何激活，而不是逐个猜工具。',
    '工具找不到或被拦截后，需要先建立全局工具地图。',
  ],
  forbidden: [
    '不要用它执行目标工具；它只返回工具地图和激活路径。',
    '任务已经明确要读文件、生成文档、创建表格等具体动作时，不要先拉取全局或整类地图；直接 op="find" 搜任务短语。',
  ],
  protocol: [
    '具体任务优先 op="find"：query 用用户目标短语，一次返回可换入的具体工具页。',
    '默认或 op="map"：按分类分页；page.nextCursor 非空时继续调用 tooling:map(cursor: nextCursor)。',
    'op="find"：按 query 搜索工具页；op="page"：平铺分页；op="read"：读取指定技能正文（skill:<id>）。',
    'map 下每个 category 返回完整 toolNames；详细状态页仍按 maxToolsPerCategory 展开。',
    '每个 category 头部包含 capability 页，可用 tooling:replace 一类激活。',
    '每个 tool 页包含 toolOsState 与 activation：resident 可直接调用，loadable 按 activation.method 换入，needs_setup 先处理 dependencies。',
  ],
  usage: [
    '按意图搜索时传 op="find" 和 query；只有查全局或分类清单时才省略 op。用 categoryIds/toolOsStates 缩小范围；判断下一步优先读 toolOsState。',
    'domainIds 的合法取值来自本工具返回的 categories[].toolOs.domain；没先看过就不要凭猜传域名。',
  ],
  examples: [
    { op: 'find', query: 'read document' },
    { kind: 'all', toolOsStates: ['loadable'] },
    { kind: 'tool', toolOsStates: ['loadable'] },
  ],
  notes: [
    '这是首选查询入口：具体任务先精确 find；全局诊断再看结构化状态清单、依赖关系和一类激活路径。',
    '只列出当前产品作用域允许的工具；具体作用域隔离与恢复动作由注入的 CapabilityScopePolicy 声明。',
  ],
  schema: toolSpaceQueryMethodSchema,
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    const parsed = parseToolSpaceQueryMethodInput(input)
    return runToolSpace(ctx, parsed)
  },
})

const toolSpaceRead = defineVelaTool<z.input<typeof toolSpaceReadMethodSchema>>({
  name: 'tooling:read',
  role: 'control',
  category: 'agent-control',
  // 同 tooling:map：技能正文是模型当下要读的内容，禁止 page-out。
  outputInline: true,
  summary: '读取当前角色可见的技能正文（skill:<id>）；技能索引见任务提示词。',
  suitable: [
    '任务确实需要某个技能的规范/步骤时，按 id 读取其正文再据以执行。',
  ],
  forbidden: [
    '不读工具能力：需要某个工具时用 tooling:map 发现、tooling:replace 换入，让真实工具 schema 在下一轮暴露；不要用 tooling:read 读工具页。',
    '不要猜技能正文或不存在的 id；读取前只把索引当目录。',
  ],
  protocol: ['detail="full" 时技能页额外返回按需读取说明；默认 brief 即技能正文。'],
  usage: ['传 skill:<id>（来自任务提示词里的「可按需读取的技能」索引）。'],
  examples: [{ ids: ['skill:global:coding-style'], detail: 'full' }],
  notes: ['首次读取某技能会弹确认卡征求用户同意；用户拒绝后不要重试，改用其他方式继续。'],
  schema: toolSpaceReadMethodSchema,
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (input, ctx) =>
    runToolSpace(
      ctx,
      toolSpaceSchema.parse({ op: 'read', ...toolSpaceReadMethodSchema.parse(input) })
    ),
})

const toolSpaceReplace = defineVelaTool<z.input<typeof toolSpaceReplaceMethodSchema>>({
  name: 'tooling:replace',
  role: 'control',
  category: 'agent-control',
  summary: '换入/换出工具页，或按 capability 一类激活能力；影响后续 AI SDK tools 暴露。',
  suitable: [
    '需要一类激活 capability:*。',
    '需要把 loadable 工具换入可见工具空间供连续调用。',
    '需要 page-out 不再使用的工具页。',
  ],
  forbidden: ['不要用它执行目标工具；replace 后下一轮再调用真实工具。'],
  protocol: [
    'pageIn 可传 tool:* 或 capability:*；capability:* 表示一类激活。',
    '能力前置条件缺失时会返回 requiresUserActionDetails；按依赖与 nextActions 处理，不要猜测能力自有资源。',
    'requiresUserActionDetails / requiresApprovalDetails 会说明阻塞原因和下一步。',
  ],
  usage: ['传 pageIn/pageOut 和 reason。'],
  examples: [
    { pageIn: ['capability:documents'], reason: '需要使用文档能力' },
    { pageIn: ['tool:document_read'], reason: '需要连续读取文档' },
  ],
  notes: [
    'replace 只调整工具页驻留/能力状态；实际工具调用发生在下一轮真实工具 schema 暴露之后。',
  ],
  schema: toolSpaceReplaceMethodSchema,
  permissions: [],
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    runToolSpace(
      ctx,
      toolSpaceSchema.parse({ op: 'replace', ...toolSpaceReplaceMethodSchema.parse(input) })
    ),
})

const categoriesTools = {
  'tooling:map': toolSpaceMap,
  'tooling:read': toolSpaceRead,
  'tooling:replace': toolSpaceReplace,
}

export { categoriesTools }
