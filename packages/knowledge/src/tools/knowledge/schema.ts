import { z } from 'zod'

const knowledgeSourceKindSchema = z.enum(['markdown', 'text', 'json', 'config', 'code'])

export { knowledgeSourceKindSchema }
