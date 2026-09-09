import { z } from 'zod'

export const DocumentRendererProtocolVersion = 1 as const
export const DocumentRendererVersion = '0.1.6'

const CommonRenderRequestSchema = z.object({
  protocolVersion: z.literal(DocumentRendererProtocolVersion),
  requestId: z.string().min(1).max(200),
  projectRoot: z.string().min(1).max(4096),
  inputPath: z.string().min(1).max(4096),
  outputPath: z.string().min(1).max(4096),
})

export const DescribeRendererRequestSchema = z.object({
  protocolVersion: z.literal(DocumentRendererProtocolVersion),
  requestId: z.string().min(1).max(200),
  operation: z.literal('describe'),
})

export const RenderOfficeRequestSchema = CommonRenderRequestSchema.extend({
  operation: z.literal('render-office'),
  maxItems: z.number().int().min(1).max(200).optional(),
})

export const RenderPdfPageRequestSchema = CommonRenderRequestSchema.extend({
  operation: z.literal('render-pdf-page'),
  page: z.number().int().positive().optional(),
  scale: z.number().min(0.25).max(4).optional(),
})

export const DocumentRendererRequestSchema = z.discriminatedUnion('operation', [
  DescribeRendererRequestSchema,
  RenderOfficeRequestSchema,
  RenderPdfPageRequestSchema,
])

export type DocumentRendererRequest = z.infer<typeof DocumentRendererRequestSchema>
export type DocumentRendererErrorCode =
  | 'INVALID_REQUEST'
  | 'PATH_DENIED'
  | 'UNSUPPORTED_FORMAT'
  | 'RENDER_FAILED'

export interface RendererDescriptor {
  readonly protocolVersion: typeof DocumentRendererProtocolVersion
  readonly product: 'velar-document-renderer'
  readonly version: string
  readonly transport: 'one-json-request-per-process'
  readonly operations: readonly [
    {
      readonly name: 'render-office'
      readonly inputExtensions: readonly ['.docx', '.pptx', '.xlsx']
      readonly outputExtensions: readonly ['.html', '.png']
    },
    {
      readonly name: 'render-pdf-page'
      readonly inputExtensions: readonly ['.pdf']
      readonly outputExtensions: readonly ['.png']
    },
  ]
}

export type DocumentRendererResponse =
  | {
      readonly protocolVersion: typeof DocumentRendererProtocolVersion
      readonly requestId: string
      readonly status: 'success'
      readonly result: unknown
    }
  | {
      readonly protocolVersion: typeof DocumentRendererProtocolVersion
      readonly requestId: string
      readonly status: 'error'
      readonly error: {
        readonly code: DocumentRendererErrorCode
        readonly message: string
      }
    }
