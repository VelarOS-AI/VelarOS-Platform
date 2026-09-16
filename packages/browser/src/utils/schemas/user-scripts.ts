import { z } from 'zod'

import { BrowserUserScriptLimits } from '../../contract/constants'

/**
 * `browser:user_scripts` 的入参 schema：九个动作各自一支。
 *
 * 用户脚本会长期跑在这个站点的页面里，所以字段上限（代码字节数、match 规则条数）都是
 * 对外承诺的数，从常量表引，改一处模型看到的跟着变。
 */
const runAtSchema = z.enum(['document-start', 'document-end', 'document-idle'])
const worldSchema = z.enum(['isolated', 'main'])
const patternsSchema = z.array(z.string().min(1).max(500)).min(1).max(BrowserUserScriptLimits.matchRules)
const optionalPatternsSchema = z.array(z.string().min(1).max(500)).max(BrowserUserScriptLimits.matchRules).optional()

export const browserUserScriptsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('read'), id: z.string().min(1) }),
  z.object({
    action: z.literal('create'),
    name: z.string().min(1).max(120),
    code: z.string().min(1).max(BrowserUserScriptLimits.codeBytes),
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
    code: z.string().min(1).max(BrowserUserScriptLimits.codeBytes).optional(),
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
