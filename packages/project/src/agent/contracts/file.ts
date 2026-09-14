import { z } from 'zod'

import { ProjectFileRefSchema } from './reference.js'

export const ProjectRecodeEncodingSchema = z.enum(['utf-8', 'utf-16le', 'utf-16be', 'gb18030'])
export const ProjectRecodeNewlineSchema = z.enum(['lf', 'crlf'])

/** recode 只改磁盘字节表示，不改 Unicode 正文；模型读写文本时永远不接触编码。 */
export const ProjectRecodeActionSchema = z.strictObject({
  op: z.literal('recode'),
  paths: z.array(z.string().min(1)).min(1).max(1000),
  encoding: ProjectRecodeEncodingSchema.optional().describe('目标字符编码，默认 utf-8。'),
  bom: z.boolean().optional().describe('是否写入 BOM，默认不写；gb18030 不支持。'),
  newline: ProjectRecodeNewlineSchema.optional().describe('统一物理换行；省略则保留各文件原换行。'),
})

export const ProjectFileActionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), path: z.string().min(1), text: z.string() }),
  z.strictObject({ op: z.literal('overwrite'), fileRef: ProjectFileRefSchema, text: z.string() }),
  z.strictObject({ op: z.literal('move'), fileRef: ProjectFileRefSchema, to: z.string().min(1) }),
  z.strictObject({ op: z.literal('delete'), fileRef: ProjectFileRefSchema }),
  ProjectRecodeActionSchema,
])

export const ProjectFileSchema = z.strictObject({
  actions: z.array(ProjectFileActionSchema).min(1).max(1000),
})
