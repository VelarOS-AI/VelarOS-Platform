// ToolExecutor 用到的纯函数（不碰实例状态）。
import { toOptional } from '@velaros-ai/core'

import type { ToolExecutorEvents } from '../../types/tools.js'

/** 发一条工具进度增量；空片段不发。 */
export function emitToolProgressEvent(
  events: ToolExecutorEvents,
  toolCallId: string,
  chunk: string,
): void {
  if (!chunk) return;

  events.emitToolProgress?.({
    toolCallId,
    chunk,
    timestamp: Date.now(),
  });
}

/** 发一条工具标题与元数据；两者都缺就不发。 */
export function emitToolMetadataEvent(
  events: ToolExecutorEvents,
  toolCallId: string,
  payload: { title?: string; metadata?: Record<string, unknown> },
): void {
  const title = payload.title?.trim();
  const metadata = payload.metadata;
  if (!title && !metadata) return;

  events.emitToolMetadata?.({
    toolCallId,
    title: toOptional(title),
    metadata,
    timestamp: Date.now(),
  });
}
