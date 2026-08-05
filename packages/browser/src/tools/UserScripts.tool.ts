import { z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserArtifactWriteCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import { defineBrowserTool } from './Types'

const runAtSchema = z.enum(['document-start', 'document-end', 'document-idle'])
const worldSchema = z.enum(['isolated', 'main'])
const patternsSchema = z.array(z.string().min(1).max(500)).min(1).max(64)
const optionalPatternsSchema = z.array(z.string().min(1).max(500)).max(64).optional()

const browserUserScriptsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('read'), id: z.string().min(1) }),
  z.object({
    action: z.literal('create'),
    name: z.string().min(1).max(120),
    code: z.string().min(1).max(1_000_000),
    description: z.string().max(500).optional(),
    version: z.string().min(1).max(64).optional(),
    match: patternsSchema,
    excludeMatch: optionalPatternsSchema,
    runAt: runAtSchema.optional(),
    world: worldSchema.optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    code: z.string().min(1).max(1_000_000).optional(),
    description: z.string().max(500).optional(),
    version: z.string().min(1).max(64).optional(),
    match: patternsSchema.optional(),
    excludeMatch: optionalPatternsSchema,
    runAt: runAtSchema.optional(),
    world: worldSchema.optional(),
  }),
  z.object({ action: z.literal('set_enabled'), id: z.string().min(1), enabled: z.boolean() }),
  z.object({ action: z.literal('set_global_enabled'), enabled: z.boolean() }),
  z.object({
    action: z.literal('move'),
    id: z.string().min(1),
    direction: z.enum(['up', 'down']),
  }),
  z.object({ action: z.literal('delete'), id: z.string().min(1) }),
  z.object({ action: z.literal('run_now'), id: z.string().min(1) }),
])

const browserUserScripts = defineBrowserTool<z.input<typeof browserUserScriptsSchema>>({
  name: 'browser:user_scripts',
  role: 'edit',
  summary: '按 VelarOS 自有契约管理可跨站匹配并自动注入的浏览器脚本。',
  suitable: [
    '用户希望下次进入某个网站时自动执行一段 plain JavaScript。',
    '需要列出、读取、创建、修改、启停、删除或立即运行站点脚本。',
  ],
  forbidden: [
    '不要从 JavaScript 源码注释推断元数据；名称、URL 规则、运行时机和执行环境只认 VelarOS 契约字段。',
    '不要为内部页、file: 或非 http/https URL 创建规则。',
    '未经用户明确确认，不要启用脚本、扩大 match 范围或切换到 main world。',
  ],
  protocol: [
    'create 总是以 disabled 保存；先向用户展示 name/match/world/runAt，再经明确确认调用 set_enabled。',
    'update 修改代码或执行范围后会自动 disabled，必须重新确认后启用。',
    '默认 world=isolated；只有脚本必须访问页面自身 JavaScript 对象时才考虑 main。',
    '禁用或删除不会回滚当前文档已执行的副作用，需要刷新页面。',
  ],
  usage: [
    '优先使用精确 host/path match，避免 <all_urls>；用 list 查看摘要，只有确需源码时再 read。',
  ],
  examples: [
    {
      action: 'create',
      name: 'Hide newsletter popup',
      code: "document.querySelector('[data-newsletter-popup]')?.remove()",
      match: ['https://example.com/*'],
      runAt: 'document-end',
      world: 'isolated',
    },
  ],
  notes: [
    'external CDP 与 document-start v1 会返回 unsupported，不会伪报注入成功。',
    '脚本按 document + revision 幂等，单脚本失败不会阻断页面或其他脚本。',
  ],
  usageSkillId: 'browser-automation-recipes',
  schema: browserUserScriptsSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    const parsed = browserUserScriptsSchema.parse(input)
    switch (parsed.action) {
      case 'list':
      case 'read':
      case 'set_enabled':
      case 'set_global_enabled':
      case 'move':
      case 'delete':
      case 'run_now':
        return ctx.browser.manageUserScripts(parsed)
      case 'create': {
        const { action: _action, ...script } = parsed
        return ctx.browser.manageUserScripts({ action: 'create', script })
      }
      case 'update': {
        const { action: _action, id, ...patch } = parsed
        if (isEmpty(Object.keys(patch)))
          throw new AppError('VALIDATION', 'update 至少需要一个要修改的字段。')
        return ctx.browser.manageUserScripts({ action: 'update', id, patch })
      }
    }
  },
})

export const browserUserScriptTools = {
  'browser:user_scripts': browserUserScripts,
}
