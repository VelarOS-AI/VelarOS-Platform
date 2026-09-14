import { createHash } from 'node:crypto'

import { ProjectError } from '../../errors'
import { ProjectToolNames } from '../../project-tool-names'
import type { ObserveInput } from '../../types/io'
import { ProjectListSchema } from '../contracts/list'
import { ProjectReadCapability } from '../ProjectCapabilities'

import { readProjectReceipt, saveProjectReceipt } from './receipts'
import { defineProjectTool, scopeProjectListPatterns } from './shared'

const MaximumListingEntries = 100_000

interface ListCursor {
  query: ObserveInput
  fingerprint: string
  offset: number
}

export const projectList = defineProjectTool({
  name: ProjectToolNames.list,
  category: 'project-files',
  role: 'inspect',
  summary: '列出项目文件和目录，支持路径、glob、深度及稳定分页。',
  protocol: ['include/exclude 相对 path 匹配，也接受项目根相对路径；续页直接传 cursor。'],
  examples: [{ path: 'src', recursive: true, limit: 100 }],
  schema: ProjectListSchema,
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: { tier: 'common', rank: 20 },
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const saved = input.cursor
      ? await readProjectReceipt(context, 'list-page', input.cursor) as ListCursor
      : undefined
    const query: ObserveInput = saved?.query ?? {
      path: input.path,
      include: scopeProjectListPatterns(input.path, input.include),
      exclude: scopeProjectListPatterns(input.path, input.exclude),
      recursive: input.recursive,
      maxDepth: input.maxDepth,
    }
    const kernel = await context.project.kernel()
    const scanned = await kernel.listFiles({ ...query, maxFiles: MaximumListingEntries + 1 })
    context.abortSignal.throwIfAborted()
    const fingerprint = createHash('sha256').update(JSON.stringify(scanned)).digest('hex')
    if (saved && saved.fingerprint !== fingerprint)
      throw new ProjectError('INVALID_INPUT', '目录条目已变化，分页游标已过期。', {
        restart: query,
      }, '使用返回的 restart 条件重新列举。')
    const offset = saved?.offset ?? 0
    const available = scanned.slice(0, MaximumListingEntries)
    const entries = available.slice(offset, offset + input.limit)
    const nextOffset = offset + entries.length
    const hasMore = nextOffset < available.length
    const scanTruncated = scanned.length > MaximumListingEntries
    const cursor = hasMore
      ? await saveProjectReceipt(context, 'list-page', { query, fingerprint, offset: nextOffset } satisfies ListCursor)
      : undefined
    return {
      rootPath: context.project.getRootPath(),
      entries,
      truncated: hasMore || scanTruncated,
      cursor,
      scanTruncated: scanTruncated || undefined,
      nextAction: hasMore && cursor
        ? '继续列举时只传 cursor 和可选 limit。'
        : (scanTruncated || hasMore) ? '请缩小 path 或 include 后继续列举。' : undefined,
    }
  },
})
