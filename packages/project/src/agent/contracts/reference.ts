import { z } from 'zod'

/** References are opaque receipts. Examples describe their origin rather than inventing a value. */
export const ProjectFileRefSchema = z.string().min(1)
  .describe('原样复制本次会话读取或修改回执中的 fileRef；示例中的 <fileRef> 必须替换，不能手写引用。')

export const ProjectChangeRefSchema = z.string().min(1)
  .describe('原样复制 edit/file/change 成功回执中的 changeRef；示例占位符不是有效引用。')
