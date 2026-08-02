import type { ComponentProps, ReactElement } from 'react'

import { ToolCallBlock } from '@velaros-ai/ui/conversation/tool-render/ToolCallBlock'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

const SESSION_ID = 'component-library-session'
type ToolCallBlockType = ComponentProps<typeof ToolCallBlock>['block']

function RichCard({ block }: { block: ToolCallBlockType }): ReactElement {
  return <ToolCallBlock block={block} compact={false} sessionId={SESSION_ID} />
}

/** ArtifactToolRender(artifact:produce):success(收割自真实归档)/ running / error。 */
export function ArtifactToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'artifact-ok',
          toolName: 'artifact:produce',
          args: { type: 'html', filename: 'landing-page.html', title: '产品落地页示例' },
          result: {
            created: true,
            type: 'html',
            title: '产品落地页示例',
            filename: 'landing-page.html',
            path: '.velaros/artifacts/html/landing-page.html',
            bytes: 3461,
          },
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'artifact-run',
          toolName: 'artifact:produce',
          args: { type: 'markdown', filename: 'report.md', title: '周报' },
          isRunning: true,
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'artifact-err',
          toolName: 'artifact:produce',
          args: { type: 'html', filename: 'x.html' },
          error: '写入失败:目标目录不可写',
        }}
      />
    </Stack>
  )
}

/** MemoryRecallToolRender(memory:search):success(命中)/ empty / running。 */
export function MemoryRecallToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'memory-ok',
          toolName: 'memory:search',
          args: { query: '浏览器工具修复', mode: 'default' },
          result: {
            mode: 'default',
            count: 2,
            memories: [
              {
                id: 'mem-1',
                kind: 'reference',
                title: '浏览器点击偏移根因',
                summary: 'webview sendInputEvent 2.1x 缩放 → 改 CDP 派发。',
                tags: ['browser', 'bugfix'],
                updatedAt: '2026-07-14',
              },
              {
                id: 'mem-2',
                kind: 'procedure',
                title: '流式制品开关权威源',
                summary: '会话级 promptFeatures 派生,不靠 stream-start 一次性参数。',
                tags: ['streaming'],
              },
            ],
          },
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'memory-empty',
          toolName: 'memory:search',
          args: { query: '不存在的主题', mode: 'default' },
          result: { mode: 'default', count: 0, memories: [] },
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'memory-run',
          toolName: 'memory:search',
          args: { query: '浏览器工具修复' },
          isRunning: true,
        }}
      />
    </Stack>
  )
}

/** SearchResultToolRender(web:search):success(带 answer)/ empty。 */
export function SearchResultToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'search-ok',
          toolName: 'web:search',
          args: { query: 'react server components' },
          result: {
            answer: 'React Server Components 让组件在服务端渲染并流式传给客户端,减小 bundle。',
            count: 2,
            results: [
              {
                title: 'React Server Components — 官方文档',
                url: 'https://example.com/rsc',
                content: '介绍 RSC 的渲染模型与数据获取边界。',
                source_id: 'src-1',
              },
              {
                title: 'RSC 实战笔记',
                url: 'https://example.com/rsc-notes',
                content: '在真实项目里落地 RSC 的坑与收益。',
                source_id: 'src-2',
              },
            ],
          },
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'search-empty',
          toolName: 'web:search',
          args: { query: 'zxqwv nonexistent term' },
          result: { count: 0, results: [] },
        }}
      />
    </Stack>
  )
}

/** WebReadToolRender(web:read):success(正文)/ tool-error(result.error)/ running。 */
export function WebReadToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'webread-ok',
          toolName: 'web:read',
          args: { source_id: 'src-1' },
          result: {
            source_id: 'src-1',
            title: 'React Server Components — 官方文档',
            url: 'https://example.com/rsc',
            content: 'Server Components 在服务端执行,返回可序列化的 UI 描述…',
            chunk_index: 1,
            total_chunks: 3,
          },
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'webread-err',
          toolName: 'web:read',
          args: { source_id: 'src-9' },
          result: {
            source_id: 'src-9',
            url: 'https://example.com/blocked',
            error: true,
            message: '目标站点返回 403,无法读取正文。',
          },
        }}
      />
      <RichCard
        block={{
          type: 'tool-call',
          toolCallId: 'webread-run',
          toolName: 'web:read',
          args: { source_id: 'src-1' },
          isRunning: true,
        }}
      />
    </Stack>
  )
}
