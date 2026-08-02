import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { BrowserControlCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import { type BrowserTargetHintInput,browserTargetHintSchema, normalizeBrowserTargetHint } from './Target'
import { defineBrowserTool } from './Types'

const browserUploadFile = defineBrowserTool<{
  target: BrowserTargetHintInput
  filePath: string
}>({
  name: 'browser:upload_file',
  role: 'control',
  summary: '向 file input 上传本地文件。',
  suitable: [
    '页面有 <input type="file"> 需要选择文件。',
    'target 来自 inspect/query 或元素选择器。',
  ],
  forbidden: [
    'filePath 必须在当前 browser workspace 内。',
    '不要用于非 file input 元素。',
  ],
  usage: ['传 target 定位 file input；filePath 为工作区内相对或绝对路径。'],
  examples: [
    {
      target: { css: 'input[type=file][name=document]' },
      filePath: 'artifacts/uploads/sample.pdf',
    },
  ],
  notes: ['底层使用 CDP DOM.setFileInputFiles。'],
  schema: z.object({
    target: browserTargetHintSchema.describe(
      parameterDescription({
        description: 'file input 元素定位线索。',
      })
    ),
    filePath: z.string().min(1).max(4096).describe(
      parameterDescription({
        description: '要上传的文件路径（browser workspace 内）。',
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ target, filePath }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.uploadFile({
      target: normalizeBrowserTargetHint(target),
      filePath,
    })
  },
})

const browserUploadTools = {
  'browser:upload_file': browserUploadFile,
}
export { browserUploadTools }
